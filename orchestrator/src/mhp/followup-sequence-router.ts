import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { PostgresPortalDeps } from '../portal/router.js';
import { portalCookie, portalCsrfToken, verifyPortalCsrf } from '../portal/session.js';
import { principalAbuseAdmission, sourceAbuseAdmission } from '../portal/abuse.js';
import { parseCookies } from '../server/admin/session.js';
import { MHP_AUTH_ORIGIN, MHP_SESSION_COOKIE } from './auth-service.js';
import { MhpCommerceError } from './commerce-service.js';
import { MHP_SEQUENCE_UNAVAILABLE, type MhpSequenceAction, type MhpSequenceSaveInput, type MhpSequenceService } from './followup-sequence-service.js';
import { mhpSequenceEntryConfirmPage, mhpSequenceNewDraft, mhpSequencePage, mhpSequencePauseAllPage, mhpSequenceResumeAllPage, mhpSequenceStartConfirmPage,
  sequenceHref, type MhpSequenceNote, type MhpSequencePageInput } from './followup-sequence-view.js';
import { MHP_SEQUENCE_EDITOR_SCRIPT } from './followup-sequence-client.js';
import { readNativeFlowForm, FLOW_NATIVE_CSP } from '../followup-sequences/http.js';
import { followupEntryExpiry } from '../followup-sequences/entry.js';
import { FOLLOWUP_SEQUENCE_UUID } from '../followup-sequences/definition.js';
import { FlowWorkspaceError } from '../followup-sequences/workspace.js';
import { FlowDraftValidationError } from '../followup-sequences/channel-drafts.js';
import { mhpLink, mhpOwnerProblemPage, mhpWorkspaceProblem } from './owner-frame.js';

const BASE = '/hq/marketing/sequences';
const ACTIONS = ['save', 'preview', 'simulate', 'publish', 'enrol', 'start', 'pause', 'resume', 'cancel', 'stop', 'pause-all', 'resume-all', 'entry-activate', 'entry-off', 'open-workspace'] as const;
const PATHS = new Set([BASE, `${BASE}/editor.js`, `${BASE}/message`, ...ACTIONS.map(action => `${BASE}/${action}`)]);
const DRAFT = ['csrf', 'commandId', 'contentItemId', 'previousVersionId', 'definition'];
const SAVED = ['csrf', 'commandId', 'itemId', 'versionId'];
const CONTROL = [...SAVED, 'runId', 'ackProofId'];
const START = [...SAVED, 'count', 'digest', 'people', 'issued', 'sig'];
const RESUME_ALL = [...SAVED, 'count', 'digest', 'issued', 'sig'];
const ENTRY_ACTIVATE = [...SAVED, 'expiresAt'];
const ENTRY_OFF = [...SAVED, 'ruleId'];
const OPEN_WORKSPACE = ['csrf', 'commandId', 'back'];
const PERSON = new Set(['pause', 'resume', 'cancel', 'stop']);
const CSP = FLOW_NATIVE_CSP;
/** A confirmation older than this is shown again with the current list instead of being used. */
const CONFIRMATION_TTL_MS = 30 * 60_000;
/** Above this many people the explanation of a change is by count only (form size), the binding is unchanged. */
const NAMED_DIFF_LIMIT = 200;
function respond(res: ServerResponse, status: number, body: string, type = 'text/plain; charset=utf-8', headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': type, 'content-length': String(Buffer.byteLength(body)), 'cache-control': 'no-store',
    'referrer-policy': 'same-origin', 'content-security-policy': CSP, 'x-content-type-options': 'nosniff', ...headers }); res.end(body);
}
const html = (res: ServerResponse, status: number, body: string) => respond(res, status, body, 'text/html; charset=utf-8');
function redirect(res: ServerResponse, location: string, cookie?: string): void {
  res.writeHead(303, { location, 'cache-control': 'no-store', 'referrer-policy': 'same-origin', ...(cookie ? { 'set-cookie': cookie } : {}) }); res.end();
}
const form = (req: IncomingMessage, keys: readonly string[], optional: readonly string[] = []) => readNativeFlowForm(req, keys, keys === DRAFT, optional);
const uuid = (value: string | null | undefined): value is string => typeof value === 'string' && FOLLOWUP_SEQUENCE_UUID.test(value);
const mac = (secret: string, parts: readonly string[]) => createHmac('sha256', secret).update(parts.join('\n')).digest('hex');
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
/** Signs a note to this session, so a crafted link cannot show the owner a false "Paused". */
function noteQuery(secret: string, session: string, note: MhpSequenceNote): string {
  const value = Buffer.from(JSON.stringify(note)).toString('base64url');
  return `&note=${value}&sig=${mac(secret, ['mhp.sequence.note/v1', session, value]).slice(0, 32)}`;
}
function readNote(secret: string, session: string, value: string | null, sig: string | null): MhpSequenceNote | undefined {
  if (!value || !sig || value.length > 600 || !same(sig, mac(secret, ['mhp.sequence.note/v1', session, value]).slice(0, 32))) return undefined;
  try { const note = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as MhpSequenceNote; return note && typeof note === 'object' && typeof note.c === 'string' ? note : undefined; }
  catch { return undefined; }
}
const startSignature = (secret: string, session: string, f: Record<string, string>) =>
  mac(secret, ['mhp.sequence.start/v1', session, f.commandId!, f.itemId!, f.versionId!, f.count!, f.digest!, f.people!, f.issued!]);
const resumeSignature = (secret: string, session: string, f: Record<string, string>) =>
  mac(secret, ['mhp.sequence.resume-all/v1', session, f.commandId!, f.itemId!, f.versionId!, f.count!, f.digest!, f.issued!]);
type Sequences = Pick<MhpSequenceService, 'snapshot' | 'review' | 'preview' | 'save' | 'publish' | 'command'>
  & Partial<Pick<MhpSequenceService, 'entryCommand' | 'message' | 'simulate' | 'startPlan' | 'start' | 'pauseAll' | 'resumePlan' | 'resumeAll' | 'personAction' | 'openWorkspace'>>;

export async function handleMhpSequence(req: IncomingMessage, res: ServerResponse, url: URL, deps: { portal: PostgresPortalDeps; sequences: Sequences }): Promise<boolean> {
  const path = url.pathname.replace(/\/+$/, ''); if (!PATHS.has(path)) return false;
  const { portal, sequences } = deps, leases: Buffer[] = []; let outcome: 'success' | 'service_error' = 'success';
  // What the owner was looking at, for the way back from an error.
  let place: { itemId: string; versionId: string } | null = uuid(url.searchParams.get('item')) && uuid(url.searchParams.get('version'))
    ? { itemId: url.searchParams.get('item')!, versionId: url.searchParams.get('version')! } : null;
  let csrf = '';
  try {
    const method = req.method ?? 'GET', reading = path === BASE || path === `${BASE}/editor.js` || path === `${BASE}/message`;
    if (method !== (reading ? 'GET' : 'POST')) throw new MhpCommerceError(405, 'Use the buttons on the sequence page.');
    const context = portal.requestContext?.(req);
    if (!context || !portal.abuse || !portal.abuseHashSecret) throw new MhpCommerceError(503, MHP_SEQUENCE_UNAVAILABLE);
    const now = portal.now?.() ?? Date.now(), routeClass = reading ? 'read.page' : 'command';
    const reserve = async (admission: ReturnType<typeof sourceAbuseAdmission>) => {
      if (!admission) throw new MhpCommerceError(503, MHP_SEQUENCE_UNAVAILABLE);
      const decision = await portal.abuse!.admit(admission);
      if (!decision.allowed) throw new MhpCommerceError(429, 'Too many requests in a short time. Wait a moment and try again.');
      if (decision.leaseHash) leases.push(decision.leaseHash);
    };
    await reserve(sourceAbuseAdmission(context, routeClass, now));
    const token = parseCookies(req.headers.cookie)[MHP_SESSION_COOKIE] ?? '', identity = token ? await portal.auth.resolve(token, now) : null;
    if (!identity) { redirect(res, '/portal/login'); return true; }
    await reserve(principalAbuseAdmission(context, routeClass, portal.abuseHashSecret, identity, now));
    csrf = portalCsrfToken(portal.sessionSecret, token);
    const page = async (extra: Partial<MhpSequencePageInput> = {}) => mhpSequencePage({ snapshot: await sequences.snapshot(identity, context.requestId),
      csrf, commandId: randomUUID(), returnCommandId: randomUUID(), now, ...extra });
    const back = (itemId: string, versionId: string, note: MhpSequenceNote, anchor = '') =>
      redirect(res, `${sequenceHref(itemId, versionId, noteQuery(portal.sessionSecret, token, note))}${anchor}`);
    if (path === `${BASE}/editor.js`) {
      if (url.search !== '') throw new MhpCommerceError(400, 'Use the sequence editor script.');
      respond(res, 200, MHP_SEQUENCE_EDITOR_SCRIPT, 'text/javascript; charset=utf-8'); return true;
    }
    if (path === `${BASE}/message`) {
      if (!sequences.message || url.searchParams.size !== 3 || [...url.searchParams.keys()].some(key => !['item', 'version', 'channel'].includes(key) || url.searchParams.getAll(key).length !== 1)
          || !['email', 'sms', 'whatsapp'].includes(url.searchParams.get('channel') ?? '')) throw new MhpCommerceError(400, 'Choose an exact local message.');
      const value = await sequences.message(identity, context.requestId, url.searchParams.get('channel') as 'email' | 'sms' | 'whatsapp', url.searchParams.get('item')!, url.searchParams.get('version')!);
      respond(res, 200, JSON.stringify(value), 'application/json; charset=utf-8'); return true;
    }
    if (reading) {
      const allowed = ['new', 'item', 'version', 'confirm', 'until', 'note', 'sig'];
      if ([...url.searchParams.keys()].some(key => !allowed.includes(key) || url.searchParams.getAll(key).length !== 1)) throw new MhpCommerceError(400, 'That link to a sequence is not complete. Open the sequence from your saved sequences.');
      const item = url.searchParams.get('item'), version = url.searchParams.get('version'), fresh = url.searchParams.get('new'), confirm = url.searchParams.get('confirm'), until = url.searchParams.get('until');
      if (Boolean(item) !== Boolean(version) || (fresh !== null && fresh !== '1') || (fresh && item) || (confirm !== null && (!item || !['start', 'pause-all', 'resume-all', 'entry'].includes(confirm)))
          || ((confirm === 'entry') !== (until !== null))) throw new MhpCommerceError(400, 'That link to a sequence is not complete. Open the sequence from your saved sequences.');
      if (item && version) {
        if (confirm === 'start') {
          if (!sequences.startPlan) throw new MhpCommerceError(503, MHP_SEQUENCE_UNAVAILABLE);
          const commandId = randomUUID(), plan = await sequences.startPlan(identity, context.requestId, item, version);
          html(res, 200, mhpSequenceStartConfirmPage({ csrf, plan, commandId, token: startToken(portal.sessionSecret, token, commandId, plan, now) })); return true;
        }
        if (confirm === 'pause-all') {
          const [snapshot, detail] = await Promise.all([sequences.snapshot(identity, context.requestId), sequences.review(identity, context.requestId, item, version)]);
          html(res, 200, mhpSequencePauseAllPage({ csrf, commandId: randomUUID(), detail, active: snapshot.database.runs.filter(run => run.contentItemId === item && run.state === 'active').length })); return true;
        }
        if (confirm === 'resume-all') {
          if (!sequences.resumePlan) throw new MhpCommerceError(503, MHP_SEQUENCE_UNAVAILABLE);
          const commandId = randomUUID(), plan = await sequences.resumePlan(identity, context.requestId, item, version);
          html(res, 200, mhpSequenceResumeAllPage({ csrf, commandId, plan, token: resumeToken(portal.sessionSecret, token, commandId, plan, now) })); return true;
        }
        if (confirm === 'entry') {
          let expiresAt: string;
          try { expiresAt = followupEntryExpiry(until ?? '', now); } catch { throw new MhpCommerceError(400, 'Choose a date and time in the future for automatic sign-ups to stop.'); }
          const detail = await sequences.review(identity, context.requestId, item, version);
          const plan = sequences.startPlan ? await sequences.startPlan(identity, context.requestId, item, version).catch(() => null) : null;
          html(res, 200, mhpSequenceEntryConfirmPage({ csrf, commandId: randomUUID(), detail, expiresAt, until: until!, webinar: plan?.webinar ?? { label: null, date: null } })); return true;
        }
      }
      const snapshot = await sequences.snapshot(identity, context.requestId);
      html(res, 200, mhpSequencePage({ snapshot, csrf, commandId: randomUUID(), returnCommandId: randomUUID(), now,
        note: readNote(portal.sessionSecret, token, url.searchParams.get('note'), url.searchParams.get('sig')),
        detail: item && version ? await sequences.review(identity, context.requestId, item, version) : undefined,
        draft: fresh ? mhpSequenceNewDraft(snapshot.database.campaign, randomUUID()) : undefined })); return true;
    }
    if (url.search !== '' || req.headers.origin !== MHP_AUTH_ORIGIN || (req.headers['sec-fetch-site'] !== undefined && req.headers['sec-fetch-site'] !== 'same-origin')) throw new MhpCommerceError(403, 'This page was out of date. Open the sequence again and try once more.');
    const action = path.slice(BASE.length + 1) as typeof ACTIONS[number], editing = action === 'save' || action === 'preview' || action === 'simulate';
    const keys = editing ? DRAFT : action === 'publish' || action === 'pause-all' ? SAVED : action === 'start' ? START : action === 'resume-all' ? RESUME_ALL
      : action === 'entry-activate' ? ENTRY_ACTIVATE : action === 'entry-off' ? ENTRY_OFF : action === 'open-workspace' ? OPEN_WORKSPACE : CONTROL;
    const fields = await form(req, keys, editing ? ['audience'] : ['start', 'resume-all', 'entry-activate'].includes(action) ? ['confirm'] : []), field = (key: string) => fields.get(key) ?? '';
    if (!verifyPortalCsrf(portal.sessionSecret, token, field('csrf'))) throw new MhpCommerceError(403, 'This page was out of date. Open the sequence again and try once more.');
    if (uuid(field('itemId')) && uuid(field('versionId'))) place = { itemId: field('itemId'), versionId: field('versionId') };
    const itemId = field('itemId'), versionId = field('versionId'), commandId = field('commandId');
    if (action === 'open-workspace') {
      if (!sequences.openWorkspace) throw new MhpCommerceError(503, 'Open the marketing workspace from the Marketing workspace page.');
      const target = field('back');
      if (target !== BASE && !/^\/hq\/marketing\/sequences\?item=[0-9a-f-]{36}&version=[0-9a-f-]{36}$/u.test(target)) throw new MhpCommerceError(400, 'Open the marketing workspace from the Marketing workspace page.');
      const selected = await sequences.openWorkspace(identity, commandId, now);
      redirect(res, target, portalCookie(selected.sessionToken, true, Math.max(1, Math.floor((Date.parse(selected.expiresAt) - now) / 1000)), MHP_SESSION_COOKIE)); return true;
    }
    if (editing) {
      let definition: unknown; try { definition = JSON.parse(field('definition')); } catch { throw new MhpCommerceError(400, 'Check the sequence steps before saving.'); }
      let inlineMessages: unknown; if (fields.has('inlineMessages')) try { inlineMessages = JSON.parse(field('inlineMessages')); } catch { throw new MhpCommerceError(400, 'Check the inline message drafts.'); }
      if (fields.has('simulationCase') && !['happy', 'pause', 'reply', 'booked', 'purchased', 'unsubscribe', 'failed', 'unknown'].includes(field('simulationCase'))) throw new MhpCommerceError(400, 'Choose a simulation scenario.');
      const input: MhpSequenceSaveInput = { commandId, contentItemId: field('contentItemId'), previousVersionId: field('previousVersionId'), definition,
        ...(inlineMessages === undefined ? {} : { inlineMessages }), ...(fields.has('audience') ? { audience: field('audience') } : {}) };
      if (action === 'save') { const saved = await sequences.save(identity, context.requestId, input, now);
        redirect(res, sequenceHref(saved.contentItemId, saved.contentVersionId)); return true; }
      if (action === 'simulate') {
        if (!sequences.simulate) throw new MhpCommerceError(503, 'Flow simulation is unavailable.');
        const result = await sequences.simulate(identity, context.requestId, definition, inlineMessages, field('simulationCase') || 'happy');
        html(res, 200, await page({ draft: input, preview: result, simulation: result.simulation })); return true;
      }
      const preview = await sequences.preview(identity, context.requestId, definition, inlineMessages);
      html(res, 200, await page({ draft: input, preview })); return true;
    }
    if (action === 'enrol') {
      // Older pages posted straight to /enrol. Starting is never one press: send the owner to the confirmation.
      throw new MhpCommerceError(409, 'Starting a sequence now has a confirmation step that shows exactly who will receive it. Nothing was sent.');
    }
    if (action === 'publish') {
      await sequences.publish(identity, context.requestId, itemId, versionId, commandId, now);
      back(itemId, versionId, { c: 'pub' }, '#summary'); return true;
    }
    if (action === 'start') {
      if (!sequences.start || !sequences.startPlan) throw new MhpCommerceError(503, MHP_SEQUENCE_UNAVAILABLE);
      const f = Object.fromEntries(['commandId', 'itemId', 'versionId', 'count', 'digest', 'people', 'issued'].map(key => [key, field(key)]));
      const issued = Number(f.issued);
      if (!/^\d{1,4}$/u.test(f.count!) || !/^[a-f0-9]{64}$/u.test(f.digest!) || !/^(?:[a-f0-9]{8}){0,200}$/u.test(f.people!) || !/^\d{13}$/u.test(f.issued!)
          || !same(field('sig'), startSignature(portal.sessionSecret, token, f))) throw new MhpCommerceError(400, 'This confirmation could not be checked. Open the sequence and press Start again. Nothing was sent.');
      const again = (plan: Awaited<ReturnType<MhpSequenceService['startPlan']>>, problem?: string, changed?: Parameters<typeof mhpSequenceStartConfirmPage>[0]['changed']) => {
        const fresh = randomUUID();
        html(res, changed ? 409 : 400, mhpSequenceStartConfirmPage({ csrf, plan, commandId: fresh, token: startToken(portal.sessionSecret, token, fresh, plan, now), problem, changed }));
      };
      if (field('confirm') !== 'yes') { again(await sequences.startPlan(identity, context.requestId, itemId, versionId), 'Tick “Yes, send to these people” to confirm, then press Start. Nothing was sent.'); return true; }
      if (now - issued > CONFIRMATION_TTL_MS || issued > now + 60_000) {
        again(await sequences.startPlan(identity, context.requestId, itemId, versionId), undefined, { previousCount: Number(f.count), added: [], removed: [], reason: 'This confirmation was more than 30 minutes old, so here is the current list again. Nothing was sent.' }); return true;
      }
      const result = await sequences.start(identity, context.requestId, { commandId, itemId, versionId, count: Number(f.count), digest: f.digest!, people: f.people!, confirmed: true });
      if (result.kind === 'changed') { again(result.plan, undefined, { previousCount: result.previousCount, added: result.added, removed: result.removed }); return true; }
      if (result.kind === 'already_started') { back(itemId, versionId, { c: 'a', n: result.count }, '#result'); return true; }
      back(itemId, versionId, { c: 's', n: result.started, e: result.expected, x: result.unexpected, y: result.unexpectedPaused, l: result.later, w: result.firstWaitMinutes,
        r: result.replayed ? 1 : 0, f: result.inFlight }, '#result'); return true;
    }
    if (action === 'pause-all') {
      if (!sequences.pauseAll) throw new MhpCommerceError(503, MHP_SEQUENCE_UNAVAILABLE);
      const result = await sequences.pauseAll(identity, context.requestId, { commandId, itemId, versionId });
      back(itemId, versionId, { c: 'b', a: 'pause', n: result.changed, m: result.remaining, k: result.blocked, f: result.inFlight, r: result.replayed ? 1 : 0 }, '#result'); return true;
    }
    if (action === 'resume-all') {
      if (!sequences.resumeAll || !sequences.resumePlan) throw new MhpCommerceError(503, MHP_SEQUENCE_UNAVAILABLE);
      const f = Object.fromEntries(['commandId', 'itemId', 'versionId', 'count', 'digest', 'issued'].map(key => [key, field(key)]));
      if (!/^\d{1,4}$/u.test(f.count!) || !/^[a-f0-9]{64}$/u.test(f.digest!) || !/^\d{13}$/u.test(f.issued!) || !same(field('sig'), resumeSignature(portal.sessionSecret, token, f)))
        throw new MhpCommerceError(400, 'This confirmation could not be checked. Open the sequence and press Resume everyone again. Nobody was resumed.');
      const again = async (changed?: number) => { const fresh = randomUUID(), plan = await sequences.resumePlan!(identity, context.requestId, itemId, versionId);
        html(res, 409, mhpSequenceResumeAllPage({ csrf, commandId: fresh, plan, token: resumeToken(portal.sessionSecret, token, fresh, plan, now), changed })); };
      if (field('confirm') !== 'yes' || now - Number(f.issued) > CONFIRMATION_TTL_MS) { await again(Number(f.count)); return true; }
      const result = await sequences.resumeAll(identity, context.requestId, { commandId, itemId, versionId, count: Number(f.count), digest: f.digest! });
      if (result.kind === 'changed') { await again(result.previousCount); return true; }
      back(itemId, versionId, { c: 'b', a: 'resume', n: result.changed, m: result.remaining, k: result.blocked, f: result.inFlight, r: result.replayed ? 1 : 0 }, '#result'); return true;
    }
    if (action === 'entry-activate' || action === 'entry-off') {
      if (!sequences.entryCommand) throw new MhpCommerceError(503, 'Automatic sign-ups are not available yet.');
      let expiry = '';
      if (action === 'entry-activate') try { expiry = followupEntryExpiry(field('expiresAt'), now); }
      catch { throw new MhpCommerceError(400, 'Choose a date and time in the future for automatic sign-ups to stop.'); }
      const result = await sequences.entryCommand(identity, context.requestId, { action: action === 'entry-activate' ? 'activate' : 'off', commandId,
        itemId, versionId, ruleId: action === 'entry-off' ? field('ruleId') : '', expiresAt: expiry, confirmed: action === 'entry-activate' && field('confirm') === 'yes' }, now);
      back(itemId, versionId, { c: 'e', a: result.state === 'active' ? 'on' : 'off', u: result.expiresAt, r: result.replayed ? 1 : 0 }, '#automatic'); return true;
    }
    if (!PERSON.has(action)) throw new MhpCommerceError(404, 'Page not found.');
    const input = { action: action as MhpSequenceAction['action'], commandId, itemId, versionId, runId: field('runId'), ackProofId: field('ackProofId') };
    if (!sequences.personAction || !input.runId) {
      // Older pages: a control without a person applies to everyone. Pausing everyone is safe in one press; resuming needs the list.
      if (!input.runId && action === 'pause' && sequences.pauseAll) {
        const result = await sequences.pauseAll(identity, context.requestId, { commandId, itemId, versionId });
        back(itemId, versionId, { c: 'b', a: 'pause', n: result.changed, m: result.remaining, k: result.blocked, f: result.inFlight, r: result.replayed ? 1 : 0 }, '#result'); return true;
      }
      if (!input.runId) throw new MhpCommerceError(409, 'This button is from an older page. Open the sequence again and use Pause everyone, Resume everyone or the button on a person\'s card. Nothing was changed.');
      const result = await sequences.command(identity, context.requestId, input);
      back(itemId, versionId, { c: 'p', a: input.action as 'pause', o: result.changed ? 'done' : 'already', r: input.runId, f: result.inFlight }, `#run-${input.runId}`); return true;
    }
    const result = await sequences.personAction(identity, context.requestId, input);
    back(itemId, versionId, { c: 'p', a: input.action as 'pause', o: result.code, r: input.runId, f: result.inFlight ? 1 : 0 }, result.code === 'gone' ? '#people' : `#run-${input.runId}`); return true;
  } catch (error) {
    outcome = 'service_error';
    const known = error instanceof MhpCommerceError || error instanceof FlowWorkspaceError;
    const status = known ? (error as MhpCommerceError).status : error instanceof FlowDraftValidationError ? 400 : 503;
    const message = known || error instanceof FlowDraftValidationError ? (error as Error).message : MHP_SEQUENCE_UNAVAILABLE;
    html(res, status, problemPage(status, message, place, csrf));
  } finally { await Promise.allSettled(leases.map(lease => portal.abuse!.complete(lease, outcome))); }
  return true;
}
function startToken(secret: string, session: string, commandId: string, plan: Awaited<ReturnType<MhpSequenceService['startPlan']>>, now: number): Record<string, string> {
  const f: Record<string, string> = { commandId, itemId: plan.itemId, versionId: plan.versionId, count: String(plan.count), digest: plan.digest || '0'.repeat(64),
    people: plan.count <= NAMED_DIFF_LIMIT ? plan.recipients.map(person => person.prospectId.slice(0, 8)).join('') : '', issued: String(now) };
  return { count: f.count!, digest: f.digest!, people: f.people!, issued: f.issued!, sig: startSignature(secret, session, f) };
}
function resumeToken(secret: string, session: string, commandId: string, plan: Awaited<ReturnType<MhpSequenceService['resumePlan']>>, now: number): Record<string, string> {
  const f: Record<string, string> = { commandId, itemId: plan.itemId, versionId: plan.versionId, count: String(plan.people.length), digest: plan.digest, issued: String(now) };
  return { count: f.count!, digest: f.digest!, issued: f.issued!, sig: resumeSignature(secret, session, f) };
}
/** Every error from this area, in the normal frame, with the plain message and a way back. */
function problemPage(status: number, message: string, place: { itemId: string; versionId: string } | null, csrf: string): string {
  const backTo = place ? sequenceHref(place.itemId, place.versionId) : BASE;
  const backButton = mhpLink(backTo, place ? 'Back to the sequence' : 'Back to follow-up sequences', mhpWorkspaceProblem(status, message));
  if (mhpWorkspaceProblem(status, message)) {
    const open = csrf ? `<form method="post" action="${BASE}/open-workspace"><input type="hidden" name="csrf" value="${csrfEscape(csrf)}"><input type="hidden" name="commandId" value="${randomUUID()}"><input type="hidden" name="back" value="${csrfEscape(backTo)}"><button>Open marketing workspace</button></form>`
      : mhpLink('/hq/marketing', 'Open marketing workspace');
    return mhpOwnerProblemPage({ heading: 'Open your marketing workspace', message: 'Follow-up sequences live in the Martin Howard Property marketing workspace. Open it, and you will come straight back here.', actions: open + backButton, title: 'Open your marketing workspace' });
  }
  const heading = status === 409 ? 'Nothing was changed' : status === 429 ? 'Please wait a moment' : status === 404 ? 'Not found' : status >= 500 ? 'Temporarily unavailable' : 'Please try again';
  return mhpOwnerProblemPage({ heading, message, actions: backButton, title: heading });
}
const csrfEscape = (value: string) => value.replace(/[&<>"']/gu, char => `&#${char.charCodeAt(0)};`);
