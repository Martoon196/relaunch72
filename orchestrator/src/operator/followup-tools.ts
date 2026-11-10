/**
 * Follow-up tools: post-webinar sequences (MHP) and owner follow-up flows (PP), plus
 * MHP one-off owner emails. Claude can read, check (preview and simulate) and save
 * drafts. Publishing a sequence or email, enrolling people, switching on automatic
 * entry, scheduling a send and test sends stay in the portal: those are the owner's
 * explicit approval and every result says where to do them.
 */
import { randomUUID } from 'node:crypto';
import type { MhpOwnerEmailService } from '../mhp/owner-email-service.js';
import type { MhpSequenceService } from '../mhp/followup-sequence-service.js';
import { PP_FOLLOWUP_CAMPAIGN, type PortalFollowupFlowService } from '../portal/followup-flow-service.js';
import { FLOW_SIMULATION_CASES } from '../followup-sequences/simulation.js';
import type { OperatorBrand } from './config.js';
import { EMAIL_PLACEHOLDERS, SEQUENCE_INPUT_SCHEMA, buildSequence, describeSequence } from './sequence-builder.js';
import type { OperatorSessions } from './sessions.js';
import { BRAND_SCHEMA, ID_SCHEMA, brand, id, optionalId, str, type OperatorTool, type ToolArgs } from './tool-kit.js';

export interface FollowupToolDependencies {
  readonly sessions: Pick<OperatorSessions, 'identity'>;
  readonly sequences?: Pick<MhpSequenceService, 'snapshot' | 'review' | 'simulate' | 'save'>;
  readonly ownerEmails?: Pick<MhpOwnerEmailService, 'snapshot' | 'review' | 'preview' | 'save'>;
  readonly ppFlows?: Pick<PortalFollowupFlowService, 'snapshot' | 'review' | 'simulate' | 'save'>;
  /** Where the owner publishes and starts things. */
  readonly links: { readonly ppOrigin: string | null; readonly mhpOrigin: string };
}

const SCENARIOS = FLOW_SIMULATION_CASES;

export function createFollowupTools(deps: FollowupToolDependencies): OperatorTool[] {
  const requestId = () => randomUUID();
  const portal = (b: OperatorBrand) => b === 'mhp' ? `${deps.links.mhpOrigin}/hq/marketing/sequences` : `${deps.links.ppOrigin ?? ''}/portal/follow-ups`;
  const service = (b: OperatorBrand) => {
    if (b === 'mhp') { if (!deps.sequences) throw new Error('MHP sequences are not composed on this deployment.'); return deps.sequences; }
    if (!deps.ppFlows) throw new Error('Property Predator follow-up flows are not composed on this deployment.'); return deps.ppFlows;
  };
  const campaign = async (b: OperatorBrand) => b === 'pp' ? PP_FOLLOWUP_CAMPAIGN
    : (await deps.sequences!.snapshot(await deps.sessions.identity('mhp'), requestId())).database.campaign;
  const emails = () => { if (!deps.ownerEmails) throw new Error('MHP owner emails are not composed on this deployment.'); return deps.ownerEmails; };
  const commandId = (a: ToolArgs) => a.commandId === undefined ? randomUUID() : id(a, 'commandId');
  const nextSteps = (b: OperatorBrand) => `Draft only: nothing was approved, scheduled or sent. Review, publish and start it in the portal: ${portal(b)}`;

  return [
    { name: 'followups_overview', write: false,
      description: 'Follow-up sequences for the brand: saved sequences and their approval state, message choices, channel readiness, email mode and (MHP) live runs and entry rules. Start here before drafting.',
      inputSchema: { type: 'object', properties: { brand: BRAND_SCHEMA }, required: ['brand'] },
      run: async (a) => { const b = brand(a); const s = service(b); return { ...(await s.snapshot(await deps.sessions.identity(b), requestId())), portal: portal(b) }; } },
    { name: 'followup_sequence_get', write: false,
      description: 'One saved sequence version: plain steps (with each message\'s current text), approval state, timeline and what still blocks starting it. The steps can be edited and passed to followup_sequence_check / followup_sequence_save_draft.',
      inputSchema: { type: 'object', properties: { brand: BRAND_SCHEMA, contentItemId: ID_SCHEMA, contentVersionId: ID_SCHEMA }, required: ['brand', 'contentItemId', 'contentVersionId'] },
      run: async (a) => {
        const b = brand(a);
        const detail = await service(b).review(await deps.sessions.identity(b), requestId(), id(a, 'contentItemId'), id(a, 'contentVersionId'));
        return { contentItemId: detail.review.contentItemId, contentVersionId: detail.review.contentVersionId, isLatest: detail.review.isLatest,
          approvalStatus: detail.review.approvalStatus, approvalStale: detail.review.approvalStale, blockers: detail.blockers, timeline: detail.timeline,
          sequence: describeSequence(detail.definition, detail.messages ?? []), portal: portal(b) };
      } },
    { name: 'followup_sequence_check', write: false,
      description: `Validate a sequence without saving: renders every message, lays out the timeline, lists blockers and simulates a recipient (scenario: happy, pause, reply, booked, purchased, unsubscribe, failed or unknown). Email placeholders: ${EMAIL_PLACEHOLDERS}.`,
      inputSchema: { type: 'object', properties: { brand: BRAND_SCHEMA, sequence: SEQUENCE_INPUT_SCHEMA, scenario: { type: 'string', enum: [...SCENARIOS] } }, required: ['brand', 'sequence'] },
      run: async (a) => {
        const b = brand(a);
        const scenario = a.scenario === undefined ? 'happy' : String(a.scenario);
        if (!(SCENARIOS as readonly string[]).includes(scenario)) throw new Error(`scenario must be one of ${SCENARIOS.join(', ')}.`);
        const built = buildSequence(b, await campaign(b), a.sequence);
        return service(b).simulate(await deps.sessions.identity(b), requestId(), built.definition, built.inlineMessages, scenario);
      } },
    { name: 'followup_sequence_save_draft', write: true,
      description: 'Save a sequence and its new messages as unapproved drafts. To edit a saved sequence pass contentItemId and previousVersionId (the latest version from followup_sequence_get). Repeat with the same commandId (UUID) to retry safely. Publishing and starting it stay with the owner in the portal.',
      inputSchema: { type: 'object', properties: { brand: BRAND_SCHEMA, sequence: SEQUENCE_INPUT_SCHEMA, contentItemId: ID_SCHEMA, previousVersionId: ID_SCHEMA, commandId: ID_SCHEMA }, required: ['brand', 'sequence'] },
      run: async (a) => {
        const b = brand(a);
        const itemId = optionalId(a, 'contentItemId'), previous = optionalId(a, 'previousVersionId');
        if (Boolean(itemId) !== Boolean(previous)) throw new Error('Pass both contentItemId and previousVersionId to edit, or neither to create.');
        const built = buildSequence(b, await campaign(b), a.sequence);
        const saved = await service(b).save(await deps.sessions.identity(b), requestId(),
          { commandId: commandId(a), contentItemId: itemId, previousVersionId: previous, definition: built.definition, inlineMessages: built.inlineMessages });
        return { ...saved, note: nextSteps(b) };
      } },
    { name: 'owner_emails_overview', write: false,
      description: 'MHP one-off owner emails to the webinar audience: saved emails, approval state, queued sends and the email mode.',
      inputSchema: { type: 'object', properties: {} },
      run: async () => ({ ...(await emails().snapshot(await deps.sessions.identity('mhp'), requestId())), portal: `${deps.links.mhpOrigin}/hq/marketing/emails` }) },
    { name: 'owner_email_get', write: false,
      description: 'One saved MHP owner email version with its approval state.',
      inputSchema: { type: 'object', properties: { contentItemId: ID_SCHEMA, contentVersionId: ID_SCHEMA }, required: ['contentItemId', 'contentVersionId'] },
      run: async (a) => emails().review(await deps.sessions.identity('mhp'), requestId(), id(a, 'contentItemId'), id(a, 'contentVersionId')) },
    { name: 'owner_email_preview', write: false,
      description: `Render an MHP owner email as recipients would see it, without saving. Placeholders: ${EMAIL_PLACEHOLDERS}.`,
      inputSchema: { type: 'object', properties: { subject: { type: 'string' }, body: { type: 'string' } }, required: ['subject', 'body'] },
      run: async (a) => emails().preview(await deps.sessions.identity('mhp'), requestId(), str(a, 'subject', 300, true), str(a, 'body', 50_000, true)) },
    { name: 'owner_email_save_draft', write: true,
      description: 'Save an MHP owner email as an unapproved draft (pass contentItemId and previousVersionId to edit). Approval, test sends and scheduling stay with the owner in the portal.',
      inputSchema: { type: 'object', properties: { title: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' }, contentItemId: ID_SCHEMA, previousVersionId: ID_SCHEMA, commandId: ID_SCHEMA }, required: ['title', 'subject', 'body'] },
      run: async (a) => {
        const itemId = optionalId(a, 'contentItemId'), previous = optionalId(a, 'previousVersionId');
        if (Boolean(itemId) !== Boolean(previous)) throw new Error('Pass both contentItemId and previousVersionId to edit, or neither to create.');
        const saved = await emails().save(await deps.sessions.identity('mhp'), requestId(),
          { commandId: commandId(a), title: str(a, 'title', 180, true), subject: str(a, 'subject', 300, true), bodyText: str(a, 'body', 50_000, true), contentItemId: itemId, previousVersionId: previous });
        return { ...saved, note: `Draft only: nothing was approved, scheduled or sent. Review, test and schedule it in the portal: ${deps.links.mhpOrigin}/hq/marketing/emails` };
      } },
  ];
}


