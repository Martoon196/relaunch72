/**
 * The operator's tools: a bounded, named surface over the existing CRM and webinar
 * services. Every call carries a brand (pp | mhp) and acts as the configured user's
 * delegated session on that brand's workspace, so RLS and ownership checks are the
 * same ones the portal applies. Write tools exist only when writes are enabled.
 */
import { randomUUID } from 'node:crypto';
import type { PortalCrmService } from '../portal/crm-service.js';
import type { PgWebinarService, WebinarEditInput } from '../webinars/service.js';
import { DEFAULT_SETTINGS, readSettings, type WebinarKind } from '../webinars/types.js';
import { WebinarError } from '../webinars/service.js';
import type { OperatorBrand } from './config.js';
import type { McpToolDefinition, McpToolHost } from './mcp.js';
import type { OperatorSessions } from './sessions.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BRAND = { type: 'string', enum: ['pp', 'mhp'], description: 'pp = Property Predator (Growth HQ), mhp = Martin Howard Property marketing workspace' };
const ID = { type: 'string', description: 'UUID' };

export interface OperatorToolDependencies {
  readonly sessions: OperatorSessions;
  readonly crm: Pick<PortalCrmService, 'snapshot' | 'lead360' | 'createLead' | 'moveOpportunity' | 'completeTask'>;
  readonly webinars?: Pick<PgWebinarService, 'list' | 'get' | 'create' | 'update' | 'setStatus' | 'registrants' | 'results' | 'messageStatus' | 'sendToCrm'>;
  readonly writes: boolean;
  readonly log?: (line: string) => void;
}

type Args = Record<string, unknown>;

interface Tool extends McpToolDefinition { readonly write: boolean; run(args: Args): Promise<unknown> }

function str(args: Args, key: string, max = 2000, required = false): string {
  const v = args[key];
  if (v === undefined || v === null) { if (required) throw new Error(`${key} is required.`); return ''; }
  if (typeof v !== 'string') throw new Error(`${key} must be text.`);
  const out = v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
  if (required && !out) throw new Error(`${key} is required.`);
  return out.slice(0, max);
}

function id(args: Args, key: string): string {
  const v = str(args, key, 64, true);
  if (!UUID.test(v)) throw new Error(`${key} must be a UUID.`);
  return v.toLowerCase();
}

function int(args: Args, key: string, min: number, max: number, fallback: number): number {
  const v = args[key];
  if (v === undefined || v === null) return fallback;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw new Error(`${key} must be a whole number between ${min} and ${max}.`);
  return v;
}

function brand(args: Args): OperatorBrand {
  const v = args.brand;
  if (v !== 'pp' && v !== 'mhp') throw new Error('brand must be "pp" or "mhp".');
  return v;
}

function outcome(result: { ok: true; disposition: string } | { ok: false; kind: string; message: string; fieldErrors?: unknown }): unknown {
  if (result.ok) return { ok: true, disposition: result.disposition };
  throw new Error(`${result.kind}: ${result.message}${'fieldErrors' in result && result.fieldErrors ? ` ${JSON.stringify(result.fieldErrors)}` : ''}`);
}

export function createOperatorTools(deps: OperatorToolDependencies): McpToolHost {
  const { sessions, crm, webinars } = deps;
  const requestId = () => randomUUID();
  const crmIdentity = async (b: OperatorBrand) => ({ sessionToken: (await sessions.identity(b)).sessionToken, requestId: requestId() });
  const needWebinars = () => { if (!webinars) throw new Error('Webinars are not composed on this deployment.'); return webinars; };
  const editInput = (args: Args, base?: WebinarEditInput): WebinarEditInput => {
    const kind = args.kind ?? base?.kind ?? 'live';
    if (kind !== 'live' && kind !== 'on_demand' && kind !== 'scheduled_recording') throw new Error('kind must be live, on_demand or scheduled_recording.');
    const settings = args.settings === undefined ? (base?.settings ?? DEFAULT_SETTINGS) : readSettings({ ...(base?.settings ?? DEFAULT_SETTINGS), ...(args.settings as object) });
    return {
      kind: kind as WebinarKind,
      title: str(args, 'title', 200) || base?.title || '',
      summary: str(args, 'summary', 4000) || base?.summary || '',
      presenterName: str(args, 'presenterName', 120) || base?.presenterName || '',
      presenterTitle: str(args, 'presenterTitle', 120) || base?.presenterTitle || '',
      timezone: str(args, 'timezone', 64) || base?.timezone || 'Europe/London',
      startsLocal: args.startsLocal === undefined ? (base?.startsLocal ?? '') : str(args, 'startsLocal', 32),
      durationMinutes: int(args, 'durationMinutes', 5, 1440, base?.durationMinutes ?? 60),
      capacity: args.capacity === null ? null : args.capacity === undefined ? (base?.capacity ?? null) : int(args, 'capacity', 1, 100000, 100),
      settings,
    };
  };

  const tools: Tool[] = [
    { name: 'workspace_overview', write: false, description: 'The brand workspace: name, timezone, CRM stages and the latest contacts, opportunities, tasks and timeline.',
      inputSchema: { type: 'object', properties: { brand: BRAND }, required: ['brand'] },
      run: async (a) => crm.snapshot(await crmIdentity(brand(a)), { section: 'overview' }) },
    { name: 'crm_contacts', write: false, description: 'CRM contacts for the brand, newest first, with a cursor for the next page.',
      inputSchema: { type: 'object', properties: { brand: BRAND, cursor: { type: 'string' } }, required: ['brand'] },
      run: async (a) => { const s = await crm.snapshot(await crmIdentity(brand(a)), { section: 'contacts', ...(str(a, 'cursor', 512) ? { cursor: str(a, 'cursor', 512) } : {}) }); return s && { workspace: s.workspace, contacts: s.contacts, pagination: s.pagination }; } },
    { name: 'crm_pipeline', write: false, description: 'Pipeline stages and open opportunities (with rowVersion for moves).',
      inputSchema: { type: 'object', properties: { brand: BRAND, cursor: { type: 'string' } }, required: ['brand'] },
      run: async (a) => { const s = await crm.snapshot(await crmIdentity(brand(a)), { section: 'pipeline', ...(str(a, 'cursor', 512) ? { cursor: str(a, 'cursor', 512) } : {}) }); return s && { workspace: s.workspace, stages: s.stages, opportunities: s.opportunities, pagination: s.pagination }; } },
    { name: 'crm_tasks', write: false, description: 'CRM tasks (filter open | all | completed), with rowVersion for completion.',
      inputSchema: { type: 'object', properties: { brand: BRAND, filter: { type: 'string', enum: ['open', 'all', 'completed'] }, cursor: { type: 'string' } }, required: ['brand'] },
      run: async (a) => { const f = a.filter === 'all' || a.filter === 'completed' ? a.filter : 'open'; const s = await crm.snapshot(await crmIdentity(brand(a)), { section: 'tasks', filter: f, ...(str(a, 'cursor', 512) ? { cursor: str(a, 'cursor', 512) } : {}) }); return s && { workspace: s.workspace, tasks: s.tasks, pagination: s.pagination }; } },
    { name: 'crm_lead_360', write: false, description: 'The full case file for one contact: identity, score, journey, evidence, offers, consent, opportunities and tasks.',
      inputSchema: { type: 'object', properties: { brand: BRAND, contactId: ID }, required: ['brand', 'contactId'] },
      run: async (a) => { if (!crm.lead360) throw new Error('Lead 360 is not available.'); return (await crm.lead360(await crmIdentity(brand(a)), id(a, 'contactId'))) ?? { error: 'not found' }; } },
    { name: 'crm_create_lead', write: true, description: 'Create a CRM lead: contact, opportunity in a stage and an optional first task. Idempotent per commandKey.',
      inputSchema: { type: 'object', properties: { brand: BRAND, commandKey: { type: 'string', description: 'Your idempotency key (letters, digits, . _ : -); repeat to replay safely' }, displayName: { type: 'string' }, companyName: { type: 'string' }, email: { type: 'string' }, phone: { type: 'string' }, opportunityTitle: { type: 'string' }, stageId: ID, taskTitle: { type: 'string' }, taskDueAt: { type: 'string', description: 'YYYY-MM-DDTHH:MM in workspace time' } }, required: ['brand', 'displayName', 'opportunityTitle', 'stageId'] },
      run: async (a) => outcome(await crm.createLead(await crmIdentity(brand(a)), {
        commandKey: str(a, 'commandKey', 128) || `operator.${randomUUID()}`, displayName: str(a, 'displayName', 200, true), companyName: str(a, 'companyName', 200),
        email: str(a, 'email', 320), phone: str(a, 'phone', 40), opportunityTitle: str(a, 'opportunityTitle', 200, true), stageId: id(a, 'stageId'),
        taskTitle: str(a, 'taskTitle', 200), taskDueAt: str(a, 'taskDueAt', 32) })) },
    { name: 'crm_move_opportunity', write: true, description: 'Move an opportunity to another stage; expectedRowVersion comes from crm_pipeline.',
      inputSchema: { type: 'object', properties: { brand: BRAND, opportunityId: ID, targetStageId: ID, expectedRowVersion: { type: 'integer' }, commandKey: { type: 'string' } }, required: ['brand', 'opportunityId', 'targetStageId', 'expectedRowVersion'] },
      run: async (a) => outcome(await crm.moveOpportunity(await crmIdentity(brand(a)), { commandKey: str(a, 'commandKey', 128) || `operator.${randomUUID()}`, opportunityId: id(a, 'opportunityId'), targetStageId: id(a, 'targetStageId'), expectedRowVersion: String(int(a, 'expectedRowVersion', 0, 1_000_000_000, -1)) })) },
    { name: 'crm_complete_task', write: true, description: 'Mark a CRM task complete; expectedRowVersion comes from crm_tasks.',
      inputSchema: { type: 'object', properties: { brand: BRAND, taskId: ID, expectedRowVersion: { type: 'integer' }, commandKey: { type: 'string' } }, required: ['brand', 'taskId', 'expectedRowVersion'] },
      run: async (a) => outcome(await crm.completeTask(await crmIdentity(brand(a)), { commandKey: str(a, 'commandKey', 128) || `operator.${randomUUID()}`, taskId: id(a, 'taskId'), expectedRowVersion: String(int(a, 'expectedRowVersion', 0, 1_000_000_000, -1)) })) },
    { name: 'webinars_list', write: false, description: 'All webinars on the brand workspace with registration counts.',
      inputSchema: { type: 'object', properties: { brand: BRAND }, required: ['brand'] },
      run: async (a) => needWebinars().list(await sessions.identity(brand(a)), requestId()) },
    { name: 'webinar_get', write: false, description: 'One webinar in full (event, rowVersion, counts).',
      inputSchema: { type: 'object', properties: { brand: BRAND, id: ID }, required: ['brand', 'id'] },
      run: async (a) => needWebinars().get(await sessions.identity(brand(a)), requestId(), id(a, 'id')) },
    { name: 'webinar_registrants', write: false, description: 'Registrants of a webinar (email, name, status, consent, answers, CRM link).',
      inputSchema: { type: 'object', properties: { brand: BRAND, id: ID, limit: { type: 'integer', minimum: 1, maximum: 2000 } }, required: ['brand', 'id'] },
      run: async (a) => needWebinars().registrants(await sessions.identity(brand(a)), requestId(), id(a, 'id'), int(a, 'limit', 1, 2000, 500)) },
    { name: 'webinar_results', write: false, description: 'Attendance, watch time, CTA and CRM figures for a webinar.',
      inputSchema: { type: 'object', properties: { brand: BRAND, id: ID }, required: ['brand', 'id'] },
      run: async (a) => needWebinars().results(await sessions.identity(brand(a)), requestId(), id(a, 'id')) },
    { name: 'webinar_messages', write: false, description: 'Confirmation, reminder and replay email status for a webinar.',
      inputSchema: { type: 'object', properties: { brand: BRAND, id: ID }, required: ['brand', 'id'] },
      run: async (a) => needWebinars().messageStatus(await sessions.identity(brand(a)), requestId(), id(a, 'id')) },
    { name: 'webinar_create', write: true, description: 'Create a webinar (draft). startsLocal is YYYY-MM-DDTHH:MM in the timezone; empty for on-demand. settings follows the webinar settings shape (questions, cta, reminderOffsetsMinutes, replay, crmAutoHandoff...).',
      inputSchema: { type: 'object', properties: { brand: BRAND, kind: { type: 'string', enum: ['live', 'on_demand', 'scheduled_recording'] }, title: { type: 'string' }, summary: { type: 'string' }, presenterName: { type: 'string' }, presenterTitle: { type: 'string' }, timezone: { type: 'string' }, startsLocal: { type: 'string' }, durationMinutes: { type: 'integer' }, capacity: { type: ['integer', 'null'] }, settings: { type: 'object' } }, required: ['brand', 'title'] },
      run: async (a) => { const w = needWebinars(); const identity = await sessions.identity(brand(a)); const created = await w.create(identity, requestId(), editInput(a)); return w.get(identity, requestId(), created); } },
    { name: 'webinar_update', write: true, description: 'Change a webinar. Fields you omit keep their current value; rowVersion comes from webinar_get.',
      inputSchema: { type: 'object', properties: { brand: BRAND, id: ID, rowVersion: { type: 'integer' }, kind: { type: 'string' }, title: { type: 'string' }, summary: { type: 'string' }, presenterName: { type: 'string' }, presenterTitle: { type: 'string' }, timezone: { type: 'string' }, startsLocal: { type: 'string' }, durationMinutes: { type: 'integer' }, capacity: { type: ['integer', 'null'] }, settings: { type: 'object' } }, required: ['brand', 'id', 'rowVersion'] },
      run: async (a) => { const w = needWebinars(); const identity = await sessions.identity(brand(a)); const current = await w.get(identity, requestId(), id(a, 'id'));
        const e = current.event; const startsLocal = e.startsAt ? localStamp(e.startsAt, e.timezone) : '';
        const base: WebinarEditInput = { kind: e.kind, title: e.title, summary: e.summary, presenterName: e.presenterName, presenterTitle: e.presenterTitle, timezone: e.timezone, startsLocal, durationMinutes: e.durationMinutes, capacity: e.capacity, settings: e.settings };
        const r = await w.update(identity, requestId(), e.id, int(a, 'rowVersion', 0, 1_000_000_000, -1), editInput(a, base)); return { ...r, webinar: await w.get(identity, requestId(), e.id) }; } },
    { name: 'webinar_set_status', write: true, description: 'publish | unpublish | cancel | archive a webinar.',
      inputSchema: { type: 'object', properties: { brand: BRAND, id: ID, action: { type: 'string', enum: ['publish', 'unpublish', 'cancel', 'archive'] } }, required: ['brand', 'id', 'action'] },
      run: async (a) => { const action = a.action; if (action !== 'publish' && action !== 'unpublish' && action !== 'cancel' && action !== 'archive') throw new Error('action must be publish, unpublish, cancel or archive.'); const w = needWebinars(); const identity = await sessions.identity(brand(a)); await w.setStatus(identity, requestId(), id(a, 'id'), action); return w.get(identity, requestId(), id(a, 'id')); } },
    { name: 'webinar_send_to_crm', write: true, description: 'Send up to 25 unlinked registrants of a webinar to the CRM now (the worker also does this automatically when the webinar has automatic handoff on).',
      inputSchema: { type: 'object', properties: { brand: BRAND, id: ID }, required: ['brand', 'id'] },
      run: async (a) => needWebinars().sendToCrm(await sessions.identity(brand(a)), requestId(), id(a, 'id')) },
  ];

  const visible = tools.filter((t) => deps.writes || !t.write);
  const definitions: McpToolDefinition[] = visible.map(({ name, description, inputSchema }) => Object.freeze({ name, description, inputSchema }));
  return {
    listTools: () => definitions,
    async callTool(name, args) {
      const tool = visible.find((t) => t.name === name);
      if (!tool) throw new Error(tools.some((t) => t.name === name) ? 'Writes are disabled on this deployment (R72_OPERATOR_WRITES).' : 'Unknown tool.');
      try {
        const result = await tool.run(args);
        deps.log?.(`operator tool ${name} brand=${typeof args.brand === 'string' ? args.brand : '?'} ok`);
        return result;
      } catch (error) {
        deps.log?.(`operator tool ${name} brand=${typeof args.brand === 'string' ? args.brand : '?'} failed`);
        if (error instanceof WebinarError) throw new Error(error.message);
        throw error instanceof Error ? error : new Error('The tool failed.');
      }
    },
  };
}

/** ISO instant → `YYYY-MM-DDTHH:MM` wall-clock text in the zone, the webinar service's own input shape. */
function localStamp(iso: string, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(iso));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
}
