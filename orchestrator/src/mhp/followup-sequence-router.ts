import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { PostgresPortalDeps } from '../portal/router.js';
import { portalCsrfToken, verifyPortalCsrf } from '../portal/session.js';
import { principalAbuseAdmission, sourceAbuseAdmission } from '../portal/abuse.js';
import { parseCookies } from '../server/admin/session.js';
import { MHP_AUTH_ORIGIN, MHP_SESSION_COOKIE } from './auth-service.js';
import { MhpCommerceError } from './commerce-service.js';
import type { MhpSequenceAction, MhpSequenceSaveInput, MhpSequenceService } from './followup-sequence-service.js';
import { mhpSequenceNewDraft, mhpSequencePage, type MhpSequencePageInput } from './followup-sequence-view.js';
import { MHP_SEQUENCE_EDITOR_SCRIPT } from './followup-sequence-client.js';
import { followupEntryExpiry } from '../followup-sequences/entry.js';

const BASE = '/hq/marketing/sequences';
const ACTIONS = ['save', 'preview', 'publish', 'enrol', 'pause', 'resume', 'cancel', 'stop', 'entry-activate', 'entry-off'] as const;
const PATHS = new Set([BASE, `${BASE}/editor.js`, ...ACTIONS.map(action => `${BASE}/${action}`)]);
const DRAFT = ['csrf', 'commandId', 'contentItemId', 'previousVersionId', 'definition'];
const SAVED = ['csrf', 'commandId', 'itemId', 'versionId'];
const CONTROL = [...SAVED, 'runId', 'ackProofId'];
const ENTRY_ACTIVATE = [...SAVED, 'expiresAt'];
const ENTRY_OFF = [...SAVED, 'ruleId'];
const CSP = "default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
function respond(res: ServerResponse, status: number, body: string, type = 'text/plain; charset=utf-8'): void {
  res.writeHead(status, { 'content-type': type, 'content-length': String(Buffer.byteLength(body)), 'cache-control': 'no-store',
    'referrer-policy': 'same-origin', 'content-security-policy': CSP, 'x-content-type-options': 'nosniff' }); res.end(body);
}
function redirect(res: ServerResponse, location: string): void { res.writeHead(303, { location, 'cache-control': 'no-store', 'referrer-policy': 'same-origin' }); res.end(); }
async function form(req: IncomingMessage, keys: readonly string[]): Promise<URLSearchParams> {
  if (!/^application\/x-www-form-urlencoded(?:;\s*charset=utf-8)?$/iu.test(String(req.headers['content-type'] ?? ''))) throw new MhpCommerceError(415, 'Use the sequence form.');
  const maximum = keys === DRAFT ? 140_000 : 4096;
  if (Number(req.headers['content-length'] ?? 0) > maximum) throw new MhpCommerceError(413, 'This sequence form is too large.');
  const chunks: Buffer[] = []; let size = 0;
  for await (const raw of req) { const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw); size += chunk.length;
    if (size > maximum) throw new MhpCommerceError(413, 'This sequence form is too large.'); chunks.push(chunk); }
  const fields = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
  if (fields.size !== keys.length || [...fields.keys()].some(key => !keys.includes(key) || fields.getAll(key).length !== 1)) throw new MhpCommerceError(400, 'Refresh the sequence form before continuing.');
  return fields;
}
export async function handleMhpSequence(req: IncomingMessage, res: ServerResponse, url: URL,
  deps: { portal: PostgresPortalDeps; sequences: Pick<MhpSequenceService, 'snapshot' | 'review' | 'preview' | 'save' | 'publish' | 'command'> & Partial<Pick<MhpSequenceService, 'entryCommand'>> }): Promise<boolean> {
  const path = url.pathname.replace(/\/+$/, ''); if (!PATHS.has(path)) return false;
  const { portal, sequences } = deps, leases: Buffer[] = []; let outcome: 'success' | 'service_error' = 'success';
  try {
    const method = req.method ?? 'GET', reading = path === BASE || path === `${BASE}/editor.js`;
    if (method !== (reading ? 'GET' : 'POST')) throw new MhpCommerceError(405, 'Use the sequence controls.');
    const context = portal.requestContext?.(req);
    if (!context || !portal.abuse || !portal.abuseHashSecret) throw new MhpCommerceError(503, 'Sequence access is temporarily unavailable.');
    const now = portal.now?.() ?? Date.now(), routeClass = reading ? 'read.page' : 'command';
    const reserve = async (admission: ReturnType<typeof sourceAbuseAdmission>) => {
      if (!admission) throw new MhpCommerceError(503, 'Sequence access is temporarily unavailable.');
      const decision = await portal.abuse!.admit(admission);
      if (!decision.allowed) throw new MhpCommerceError(429, 'Too many requests. Try again shortly.');
      if (decision.leaseHash) leases.push(decision.leaseHash);
    };
    await reserve(sourceAbuseAdmission(context, routeClass, now));
    const token = parseCookies(req.headers.cookie)[MHP_SESSION_COOKIE] ?? '', identity = token ? await portal.auth.resolve(token, now) : null;
    if (!identity) { redirect(res, '/portal/login'); return true; }
    await reserve(principalAbuseAdmission(context, routeClass, portal.abuseHashSecret, identity, now));
    const page = async (extra: Partial<MhpSequencePageInput> = {}) => mhpSequencePage({ snapshot: await sequences.snapshot(identity, context.requestId),
      csrf: portalCsrfToken(portal.sessionSecret, token), commandId: randomUUID(), returnCommandId: randomUUID(), ...extra });
    if (path === `${BASE}/editor.js`) {
      if (url.search !== '') throw new MhpCommerceError(400, 'Use the sequence editor script.');
      respond(res, 200, MHP_SEQUENCE_EDITOR_SCRIPT, 'text/javascript; charset=utf-8'); return true;
    }
    if (reading) {
      if ([...url.searchParams.keys()].some(key => !['new', 'item', 'version'].includes(key) || url.searchParams.getAll(key).length !== 1)) throw new MhpCommerceError(400, 'Use one sequence link at a time.');
      const item = url.searchParams.get('item'), version = url.searchParams.get('version'), fresh = url.searchParams.get('new');
      if (Boolean(item) !== Boolean(version) || (fresh !== null && fresh !== '1') || (fresh && item)) throw new MhpCommerceError(400, 'Use one sequence link at a time.');
      const snapshot = await sequences.snapshot(identity, context.requestId);
      respond(res, 200, mhpSequencePage({ snapshot, csrf: portalCsrfToken(portal.sessionSecret, token), commandId: randomUUID(), returnCommandId: randomUUID(),
        detail: item && version ? await sequences.review(identity, context.requestId, item, version) : undefined,
        draft: fresh ? mhpSequenceNewDraft(snapshot.database.campaign, randomUUID()) : undefined }), 'text/html; charset=utf-8'); return true;
    }
    if (url.search !== '' || req.headers.origin !== MHP_AUTH_ORIGIN || (req.headers['sec-fetch-site'] !== undefined && req.headers['sec-fetch-site'] !== 'same-origin')) throw new MhpCommerceError(403, 'Refresh the sequence form before continuing.');
    const action = path.slice(BASE.length + 1), editing = action === 'save' || action === 'preview';
    const fields = await form(req, editing ? DRAFT : action === 'publish' ? SAVED : action === 'entry-activate' ? ENTRY_ACTIVATE : action === 'entry-off' ? ENTRY_OFF : CONTROL), field = (key: string) => fields.get(key) ?? '';
    if (!verifyPortalCsrf(portal.sessionSecret, token, field('csrf'))) throw new MhpCommerceError(403, 'Refresh the sequence form before continuing.');
    if (editing) {
      let definition: unknown; try { definition = JSON.parse(field('definition')); } catch { throw new MhpCommerceError(400, 'Check the sequence steps before saving.'); }
      const input: MhpSequenceSaveInput = { commandId: field('commandId'), contentItemId: field('contentItemId'), previousVersionId: field('previousVersionId'), definition };
      if (action === 'save') { const saved = await sequences.save(identity, context.requestId, input, now);
        redirect(res, `${BASE}?item=${encodeURIComponent(saved.contentItemId)}&version=${encodeURIComponent(saved.contentVersionId)}`); return true; }
      const preview = await sequences.preview(identity, context.requestId, definition);
      respond(res, 200, await page({ draft: input, preview }), 'text/html; charset=utf-8'); return true;
    }
    let message: string;
    if (action === 'publish') { await sequences.publish(identity, context.requestId, field('itemId'), field('versionId'), field('commandId'), now);
      message = 'This exact sequence version is published. No one was enrolled and no message was sent. Choose Start when you are ready.'; }
    else if (action === 'entry-activate' || action === 'entry-off') {
      if (!sequences.entryCommand) throw new MhpCommerceError(503, 'Future webinar entry is not connected yet.');
      let expiry = '';
      if (action === 'entry-activate') try { expiry = followupEntryExpiry(field('expiresAt'), now); }
      catch { throw new MhpCommerceError(400, 'Choose a valid future stop time in UTC.'); }
      const result = await sequences.entryCommand(identity, context.requestId, { action: action === 'entry-activate' ? 'activate' : 'off', commandId: field('commandId'),
        itemId: field('itemId'), versionId: field('versionId'), ruleId: action === 'entry-off' ? field('ruleId') : '', expiresAt: expiry }, now);
      message = result.state === 'active' ? 'Future opted-in webinar sign-ups can now enter this exact sequence. Existing registrations were not backfilled and no message was sent by enabling the rule.'
        : 'Future entry is off. Existing runs were left unchanged; use their separate controls if you also want to stop them.';
      if (result.replayed) message = `This is the saved result of your earlier ${result.state === 'active' ? 'enable' : 'off'} request. The current rule status is shown below; the earlier action was not repeated.`;
    }
    else {
      const result = await sequences.command(identity, context.requestId, { action: action as MhpSequenceAction['action'], commandId: field('commandId'), itemId: field('itemId'), versionId: field('versionId'), runId: field('runId'), ackProofId: field('ackProofId') });
      message = `${result.changed} run${result.changed === 1 ? '' : 's'} ${action === 'enrol' ? 'started' : action === 'pause' ? 'paused' : action === 'resume' ? 'resumed' : action === 'stop' ? 'stopped' : 'cancelled'}. ${result.remaining} remain for another explicit batch; ${result.blocked} need review. ${result.inFlight} already being processed may still finish.${result.replayed ? ' This is the saved result of your earlier request.' : ''}`;
    }
    const detail = await sequences.review(identity, context.requestId, field('itemId'), field('versionId'));
    respond(res, 200, await page({ detail, message }), 'text/html; charset=utf-8'); return true;
  } catch (error) { outcome = 'service_error'; respond(res, error instanceof MhpCommerceError ? error.status : 503, error instanceof MhpCommerceError ? error.message : 'Sequence controls are temporarily unavailable.'); }
  finally { await Promise.allSettled(leases.map(lease => portal.abuse!.complete(lease, outcome))); }
  return true;
}
