import { createHash, randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Pool } from 'pg';
import { canonicalCompanyContentJson, type CompanyContentService, type CreateCompanyContentVersionCommand } from '../company-content-pg/index.js';
import { withTransaction } from '../db/transaction.js';
import type { DatabaseRequestContext } from '../db/rls.js';
import type { PortalSessionIdentity } from '../portal/auth-service.js';
import type { PostgresPortalDeps } from '../portal/router.js';
import { portalCsrfToken, verifyPortalCsrf } from '../portal/session.js';
import { principalAbuseAdmission, sourceAbuseAdmission } from '../portal/abuse.js';
import { escapeHtml as esc } from '../portal/ui.js';
import { parseCookies } from '../server/admin/session.js';
import { MHP_AUTH_ORIGIN, MHP_SESSION_COOKIE } from './auth-service.js';
import { MhpCommerceError } from './commerce-service.js';
import { MHP_EVENT_WHATSAPP_CONSENT_REVISION, MHP_EVENT_WHATSAPP_CONSENT_TEXT, type MhpEventProgrammeSummary } from './event-phone-service.js';
import { MHP_MARKETING_WORKSPACE_ID, type PgMhpMarketingWorkspaceService } from './marketing-workspace-service.js';
import { parseMhpOwnerEmailBrand } from './owner-email-content.js';

// MHP009C owner page: WhatsApp follow-up programme, exact-recipient review (only after a
// current Meta APPROVED read), one schedule action and hold/cancel. No typed approval exists.
export const MHP_EVENT_WHATSAPP_OWNER_ROUTE = '/hq/marketing/webinar-whatsapp';
export const MHP_EVENT_WHATSAPP_SOURCE = 'mhp.event-whatsapp';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA = /^[0-9a-f]{64}$/u;
const MINUTE_ISO = /^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:00Z$/u;
const sha256 = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest();

export interface MhpEventWhatsAppReview {
  programme: Record<string, unknown> & { programmeVersionId: string; programmeSha256: string; event: string; dueAt: string; templateName: string };
  bodyText: string; templateObservation: { status: string | null; current: boolean; observedAt: string | null }; maxBatch: number;
  recipients: { receiptId: string; phoneMasked: string; firstName: string | null; selected: boolean }[];
  selectedReceiptIds: string[]; selectedRevisions: Record<string, number>; reviewSha256: string; awaitingOwnerReview: number;
  schedule: { sendId: string; dueAt: string; cancelled: boolean; held: string | null; prepared: boolean; jobState: string | null }[];
}
function failure(error: unknown): never {
  if (error instanceof MhpCommerceError) throw error;
  const code = (error as { code?: string })?.code;
  if (code === '42501') throw new MhpCommerceError(403, 'Open the MHP marketing workspace with your owner account.');
  if (code === '54000') throw new MhpCommerceError(409, 'This batch would exceed the WhatsApp caps (1 a day, 3 a month). Nothing was scheduled.');
  if (['23514', '23505', '40001'].includes(code ?? '')) throw new MhpCommerceError(409, 'The programme, template read or a recipient changed. Refresh the review; nothing was scheduled.');
  throw new MhpCommerceError(503, 'WhatsApp follow-ups are temporarily unavailable. Check the recorded status before retrying.');
}

export class MhpEventWhatsAppOwner {
  constructor(private readonly d: { marketingWorkspace: Pick<PgMhpMarketingWorkspaceService, 'snapshot'>;
    authorize(identity: PortalSessionIdentity, requestId: string): Promise<DatabaseRequestContext>; whatsappPool: Pick<Pool, 'connect'>;
    reader: Pick<CompanyContentService, 'listCatalog'>; adapter: Pick<CompanyContentService, 'createVersion'>; approvals: Pick<CompanyContentService, 'requestApproval' | 'decideApproval'>;
    brand(identity: PortalSessionIdentity): Promise<unknown>; campaign: string; bindingId: string; metaTemplateId: string }) {
    if (!UUID.test(d.bindingId) || !/^[1-9][0-9]{4,29}$/u.test(d.metaTemplateId)) throw new Error('MHP event WhatsApp owner configuration is invalid');
  }
  async #context(identity: PortalSessionIdentity, requestId: string): Promise<DatabaseRequestContext> {
    const snapshot = await this.d.marketingWorkspace.snapshot(identity);
    if (!snapshot.marketingSelected || snapshot.marketingWorkspaceId !== MHP_MARKETING_WORKSPACE_ID || snapshot.userId !== identity.userId)
      throw new MhpCommerceError(403, 'Open the MHP marketing workspace using your owner login.');
    const context = await this.d.authorize(identity, requestId);
    if (context.workspaceId !== MHP_MARKETING_WORKSPACE_ID || context.userId !== identity.userId) throw new MhpCommerceError(403, 'Refresh your MHP owner login.');
    return context;
  }
  async programmes(identity: PortalSessionIdentity, requestId: string): Promise<MhpEventProgrammeSummary[]> {
    const page = await this.d.reader.listCatalog(await this.#context(identity, requestId), { limit: 20, sourceSystem: MHP_EVENT_WHATSAPP_SOURCE });
    return page.items.map(i => ({ contentItemId: i.contentItemId, contentVersionId: i.contentVersionId, title: i.title, approvalStatus: i.approvalStatus, approvalStale: i.approvalStale }));
  }
  async saveProgramme(identity: PortalSessionIdentity, requestId: string, input: { commandId: string; startsAt: string; dueAt: string; providerDeadline: string;
    admissionUntil: string; sourceItemId: string; sourceVersionId: string; sourceSha256: string; previousItemId: string; previousVersionId: string }, now = Date.now()) {
    const context = await this.#context(identity, requestId);
    if (!UUID.test(input.commandId) || !UUID.test(input.sourceItemId) || !UUID.test(input.sourceVersionId) || !SHA.test(input.sourceSha256)
        || ![input.startsAt, input.dueAt, input.providerDeadline, input.admissionUntil].every(v => MINUTE_ISO.test(v))
        || (input.previousVersionId !== '' && (!UUID.test(input.previousVersionId) || !UUID.test(input.previousItemId)))) throw new MhpCommerceError(400, 'Check the programme times (UTC, whole minutes) and the saved WhatsApp template draft.');
    const event = this.d.campaign;
    const body = { schema: 'mhp.event-whatsapp/v1', event, channel: 'whatsapp', stepKey: 'event_wa_followup', startsAt: input.startsAt, dueAt: input.dueAt,
      admissionUntil: input.admissionUntil, providerDeadline: input.providerDeadline, consentRevision: MHP_EVENT_WHATSAPP_CONSENT_REVISION,
      consentTextSha256: sha256(MHP_EVENT_WHATSAPP_CONSENT_TEXT).toString('hex'), metaTemplateId: this.d.metaTemplateId, sourceContentItemId: input.sourceItemId,
      sourceContentVersionId: input.sourceVersionId, sourceContentSha256: input.sourceSha256, whatsappBindingId: this.d.bindingId };
    const content = canonicalCompanyContentJson(body), sha = createHash('sha256').update(content).digest('hex');
    const brand = parseMhpOwnerEmailBrand(await this.d.brand(identity));
    const item = `event-whatsapp:${event}`, revision = `edit:${input.commandId}`, storageKey = `inline:${MHP_EVENT_WHATSAPP_SOURCE}:${sha}`;
    const manifest = canonicalCompanyContentJson({ schema: 'mhp.event-whatsapp-source/v1', workspaceId: MHP_MARKETING_WORKSPACE_ID, sourceSystem: MHP_EVENT_WHATSAPP_SOURCE,
      sourceItemId: item, sourceVersion: revision, contentSha256: sha, blobStorageKey: storageKey, blobSha256: sha, brandSnapshotRef: brand.ref, brandSha256: brand.sha256 });
    const manifestSha = createHash('sha256').update(manifest).digest('hex');
    const command: CreateCompanyContentVersionCommand = { commandKey: `mhp.event-whatsapp.save.${input.commandId}`, contentItemId: input.previousItemId || null,
      previousVersionId: input.previousVersionId || null, origin: input.previousVersionId ? 'edited' : 'imported', kind: 'other', title: `Webinar WhatsApp follow-up ${event}`,
      contentMimeType: 'application/vnd.growthhq.event-whatsapp+json', content, source: { system: MHP_EVENT_WHATSAPP_SOURCE, itemId: item, version: revision },
      blob: { storageKey, sha256: sha }, brand: { snapshotRef: brand.ref, sha256: brand.sha256 },
      attestation: { catalogSha256: manifestSha, checkedAt: new Date(now).toISOString(), expiresAt: new Date(now + 900_000).toISOString() },
      metadata: { mhpEventWhatsApp: { schema: 'mhp.event-whatsapp-local/v1', brandCanonical: brand.canonical, manifestCanonical: manifest, manifestSha256: manifestSha, authoredBy: 'native-owner' } } };
    try { const r = await this.d.adapter.createVersion(context, command); return { contentItemId: r.contentItemId, contentVersionId: r.contentVersionId }; }
    catch (error) { return failure(error); }
  }
  async publishProgramme(identity: PortalSessionIdentity, requestId: string, itemId: string, versionId: string, commandId: string): Promise<void> {
    const context = await this.#context(identity, requestId);
    if (![itemId, versionId, commandId].every(v => UUID.test(v))) throw new MhpCommerceError(400, 'Refresh the programme page.');
    try {
      const requested = await this.d.approvals.requestApproval(context, { commandKey: `mhp.event-whatsapp.publish.${commandId}.request`, contentItemId: itemId,
        contentVersionId: versionId, reviewNote: 'Native owner reviewed this exact WhatsApp follow-up programme; recipients need their own review.' });
      await this.d.approvals.decideApproval(context, { commandKey: `mhp.event-whatsapp.publish.${commandId}.approve`, approvalRequestId: requested.approvalRequestId,
        decision: 'approved', decisionNote: 'Approved by the native MHP owner; no recipient is scheduled by this approval.' });
    } catch (error) { return failure(error); }
  }
  async review(identity: PortalSessionIdentity, requestId: string, programmeVersionId: string): Promise<MhpEventWhatsAppReview> {
    const context = await this.#context(identity, requestId);
    if (!UUID.test(programmeVersionId)) throw new MhpCommerceError(400, 'Choose a saved programme.');
    try {
      return await withTransaction(this.d.whatsappPool, context, async tx => {
        const value = (await tx.query<{ value: MhpEventWhatsAppReview }>('SELECT app_private.mhp_event_whatsapp_review($1,$2) AS value',
          [sha256(identity.sessionToken), programmeVersionId])).rows[0]?.value;
        if (!value || !SHA.test(value.reviewSha256)) throw new Error('Invalid WhatsApp review');
        return value;
      });
    } catch (error) { return failure(error); }
  }
  async activate(identity: PortalSessionIdentity, requestId: string, input: { commandId: string; programmeVersionId: string; programmeSha256: string;
    revisions: Record<string, number>; reviewSha256: string; agreed: boolean }): Promise<Record<string, unknown>> {
    const context = await this.#context(identity, requestId);
    const receipts = Object.keys(input.revisions).sort();
    if (!UUID.test(input.commandId) || !UUID.test(input.programmeVersionId) || !SHA.test(input.programmeSha256) || !SHA.test(input.reviewSha256) || !input.agreed
        || receipts.length < 1 || receipts.length > 3 || receipts.some(id => !UUID.test(id) || !Number.isSafeInteger(input.revisions[id]))) throw new MhpCommerceError(400, 'Review the exact recipient, template and time, then tick the box.');
    const run = (lookupOnly: boolean) => withTransaction(this.d.whatsappPool, context, async tx => (await tx.query<{ value: Record<string, unknown> }>(
      'SELECT app_private.mhp_event_whatsapp_activate($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) AS value',
      [sha256(identity.sessionToken), input.commandId, input.programmeVersionId, Buffer.from(input.programmeSha256, 'hex'), receipts,
        JSON.stringify(Object.fromEntries(receipts.map(id => [id, input.revisions[id]]))), Buffer.from(input.reviewSha256, 'hex'), context.requestId, true, lookupOnly])).rows[0]!.value,
    { isolation: 'read committed' });
    try { const prior = await run(true); return prior.not_started === true ? await run(false) : prior; } catch (error) { return failure(error); }
  }
  async control(identity: PortalSessionIdentity, requestId: string, input: { commandId: string; action: 'hold' | 'cancel'; sendId: string }): Promise<Record<string, unknown>> {
    const context = await this.#context(identity, requestId);
    if (!UUID.test(input.commandId) || !UUID.test(input.sendId)) throw new MhpCommerceError(400, 'Refresh the schedule.');
    try {
      return await withTransaction(this.d.whatsappPool, context, async tx => (await tx.query<{ value: Record<string, unknown> }>(
        'SELECT app_private.mhp_event_whatsapp_control($1,$2,$3,$4,$5,$6) AS value',
        [sha256(identity.sessionToken), input.commandId, input.action, input.sendId, sha256(`${input.action}:${input.sendId}`), context.requestId])).rows[0]!.value);
    } catch (error) { return failure(error); }
  }
}

const CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
const hidden = (n: string, v: string): string => `<input type="hidden" name="${n}" value="${esc(v)}">`;
function page(input: { programmes: MhpEventProgrammeSummary[]; selected: MhpEventProgrammeSummary | null; review: MhpEventWhatsAppReview | null; reviewError?: string;
  csrf: string; commandId: string; campaign: string; notice?: string }): string {
  const { review, selected } = input, base = MHP_EVENT_WHATSAPP_OWNER_ROUTE, guard = hidden('csrf', input.csrf) + hidden('commandId', input.commandId);
  let body = `<h1>Webinar WhatsApp follow-up</h1>${input.notice ? `<p class="status">${esc(input.notice)}</p>` : ''}`
    + `<p>Registrants confirm their email, then message JOIN on WhatsApp themselves. Nothing is scheduled until Meta has returned the template as APPROVED and you review the recipients.</p><section><h2>Programme</h2>`
    + (input.programmes.map(p => `<p>${esc(p.title)} — ${esc(p.approvalStale ? 'changed since approval' : p.approvalStatus)} <a href="${base}?programme=${esc(p.contentVersionId)}">Open</a></p>`).join('') || '<p>No programme saved yet.</p>');
  if (selected && (selected.approvalStatus !== 'approved' || selected.approvalStale)) body += `<form method="post" action="${base}/publish">${guard}${hidden('itemId', selected.contentItemId)}${hidden('versionId', selected.contentVersionId)}<button>Approve this programme</button></form>`;
  body += `<details><summary>Save a programme</summary><form method="post" action="${base}/save">${guard}${hidden('previousItemId', selected?.contentItemId ?? '')}${hidden('previousVersionId', selected?.contentVersionId ?? '')}`
    + ['startsAt', 'dueAt', 'providerDeadline', 'admissionUntil', 'sourceItemId', 'sourceVersionId', 'sourceSha256'].map(n => `<label for="${n}">${esc(n)}<input id="${n}" name="${n}" required></label>`).join('')
    + `<button>Save programme</button></form></details></section><section><h2>Review and schedule</h2>`;
  if (input.reviewError) body += `<p class="status">${esc(input.reviewError)}</p>`;
  if (review) {
    const t = review.templateObservation;
    body += `<p>Template <strong>${esc(review.programme.templateName)}</strong>: Meta says ${esc(t.status ?? 'not read yet')}${t.current ? ' (current)' : ' — scheduling waits for a current APPROVED read'}.</p>`
      + `<blockquote>${esc(review.bodyText)}</blockquote>`
      + review.recipients.map(r => `<p>${esc(r.firstName ?? 'Registrant')} ${esc(r.phoneMasked)} — ${r.selected ? 'in this batch' : 'awaiting owner review'}</p>`).join('')
      + (review.selectedReceiptIds.length ? `<form method="post" action="${base}/activate">${guard}${hidden('programmeVersionId', review.programme.programmeVersionId)}${hidden('programmeSha256', review.programme.programmeSha256)}`
        + `${hidden('reviewSha256', review.reviewSha256)}${hidden('receipts', JSON.stringify(review.selectedRevisions))}<label><input type="checkbox" name="agreed" value="yes" required> I have reviewed this exact template, recipient(s) and time. Schedule it. (Owner operational review, not legal advice.)</label><button>Schedule</button></form>` : '<p>Nothing to schedule now.</p>')
      + review.schedule.map(s => `<p>${esc(s.cancelled ? 'cancelled' : s.held ? `held (${s.held})` : s.jobState ?? 'scheduled')} ${s.cancelled || (s.jobState && s.jobState !== 'queued') ? ''
        : `<form method="post" action="${base}/control">${guard}${hidden('sendId', s.sendId)}${hidden('programmeVersionId', review.programme.programmeVersionId)}<button name="action" value="${s.held ? 'cancel' : 'hold'}">${s.held ? 'Cancel' : 'Hold'}</button></form>`}</p>`).join('');
  }
  return `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Webinar WhatsApp · Martin Howard Property</title>`
    + `<style>body{margin:0;background:#f5f3ed;color:#142019;font:17px/1.6 system-ui,sans-serif}header,main{max-width:1000px;margin:auto;padding:24px}section{background:#fff;border:1px solid #d9dfd5;border-radius:18px;padding:24px;margin:20px 0}label{display:block;margin:12px 0}input:not([type=checkbox]):not([type=hidden]){display:block;width:100%;padding:10px}button{background:#e8a33d;border:0;border-radius:9px;padding:12px 18px;font-weight:700}.status{padding:12px;background:#eaf0e5;border-radius:10px}blockquote{white-space:pre-wrap;border-left:4px solid #e8a33d;padding:12px 16px;background:#f6f4ed}</style></head>`
    + `<body><header><strong>Martin Howard Property · Growth HQ</strong> <a href="/hq/marketing">Marketing workspace</a></header><main>${body}</section></main></body></html>`;
}
const FIELDS: Record<string, readonly string[]> = { save: ['startsAt', 'dueAt', 'providerDeadline', 'admissionUntil', 'sourceItemId', 'sourceVersionId', 'sourceSha256', 'previousItemId', 'previousVersionId'],
  publish: ['itemId', 'versionId'], activate: ['programmeVersionId', 'programmeSha256', 'reviewSha256', 'receipts', 'agreed'], control: ['sendId', 'programmeVersionId', 'action'] };

export async function handleMhpEventWhatsAppOwner(req: IncomingMessage, res: ServerResponse, url: URL,
  deps: { portal: PostgresPortalDeps; owner: Pick<MhpEventWhatsAppOwner, 'programmes' | 'saveProgramme' | 'publishProgramme' | 'review' | 'activate' | 'control'>; campaign: string }): Promise<boolean> {
  const path = url.pathname.replace(/\/+$/u, ''), base = MHP_EVENT_WHATSAPP_OWNER_ROUTE;
  if (path !== base && !path.startsWith(`${base}/`)) return false;
  const action = path.slice(base.length + 1), { portal, owner } = deps, leases: Buffer[] = [];
  let outcome: 'success' | 'service_error' = 'success';
  const reply = (status: number, body: string, html = true) => { res.writeHead(status, { 'content-type': html ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8',
    'cache-control': 'no-store', 'referrer-policy': 'same-origin', 'x-content-type-options': 'nosniff', 'content-security-policy': CSP }); res.end(body); };
  try {
    if (path === base ? req.method !== 'GET' : req.method !== 'POST' || !Object.hasOwn(FIELDS, action)) throw new MhpCommerceError(405, 'Use the page controls.');
    const context = portal.requestContext?.(req), now = portal.now?.() ?? Date.now();
    if (!context || !portal.abuse || !portal.abuseHashSecret) throw new MhpCommerceError(503, 'WhatsApp follow-ups are unavailable.');
    const admit = async (a: ReturnType<typeof sourceAbuseAdmission>) => { if (!a) throw new MhpCommerceError(503, 'Unavailable.');
      const d = await portal.abuse!.admit(a); if (!d.allowed) throw new MhpCommerceError(429, 'Too many requests.'); if (d.leaseHash) leases.push(d.leaseHash); };
    const kind = req.method === 'GET' ? 'read.page' : 'command';
    await admit(sourceAbuseAdmission(context, kind, now));
    const token = parseCookies(req.headers.cookie)[MHP_SESSION_COOKIE] ?? '', identity = token ? await portal.auth.resolve(token, now) : null;
    if (!identity) { res.writeHead(303, { location: '/portal/login', 'cache-control': 'no-store' }); res.end(); return true; }
    await admit(principalAbuseAdmission(context, kind, portal.abuseHashSecret, identity, now));
    const csrf = portalCsrfToken(portal.sessionSecret, token);
    const render = async (versionId: string | null, notice?: string) => {
      const programmes = await owner.programmes(identity, context.requestId);
      const selected = programmes.find(p => p.contentVersionId === versionId) ?? programmes[0] ?? null;
      let review = null, reviewError: string | undefined;
      if (selected && selected.approvalStatus === 'approved' && !selected.approvalStale) {
        try { review = await owner.review(identity, context.requestId, selected.contentVersionId); } catch (error) { reviewError = error instanceof MhpCommerceError ? error.message : 'The review is unavailable.'; }
      }
      return page({ programmes, selected, review, reviewError, csrf, commandId: randomUUID(), campaign: deps.campaign, notice });
    };
    if (req.method === 'GET') {
      if ([...url.searchParams.keys()].some(k => k !== 'programme')) throw new MhpCommerceError(400, 'Choose a saved programme.');
      reply(200, await render(url.searchParams.get('programme'))); return true;
    }
    if (req.headers.origin !== MHP_AUTH_ORIGIN || (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin')) throw new MhpCommerceError(403, 'Use the page.');
    const parts: Buffer[] = []; let size = 0;
    for await (const raw of req) { const part = Buffer.isBuffer(raw) ? raw : Buffer.from(raw); size += part.length; if (size > 8_192) throw new MhpCommerceError(413, 'Too large.'); parts.push(part); }
    const fields = new URLSearchParams(Buffer.concat(parts).toString('utf8')), allowed = ['csrf', 'commandId', ...FIELDS[action]!];
    if ([...fields.keys()].some(k => !allowed.includes(k) || fields.getAll(k).length !== 1)) throw new MhpCommerceError(400, 'Refresh the page.');
    if (!verifyPortalCsrf(portal.sessionSecret, token, fields.get('csrf') ?? '')) throw new MhpCommerceError(403, 'Refresh the page before continuing.');
    const f = (k: string) => fields.get(k) ?? '', commandId = f('commandId');
    if (action === 'save') {
      const saved = await owner.saveProgramme(identity, context.requestId, { commandId, startsAt: f('startsAt'), dueAt: f('dueAt'), providerDeadline: f('providerDeadline'),
        admissionUntil: f('admissionUntil'), sourceItemId: f('sourceItemId'), sourceVersionId: f('sourceVersionId'), sourceSha256: f('sourceSha256'), previousItemId: f('previousItemId'), previousVersionId: f('previousVersionId') }, now);
      reply(200, await render(saved.contentVersionId, 'Programme saved. Approve it to open WhatsApp opt-ins; nobody is scheduled yet.')); return true;
    }
    if (action === 'publish') { await owner.publishProgramme(identity, context.requestId, f('itemId'), f('versionId'), commandId); reply(200, await render(f('versionId'), 'Programme approved. Nobody is scheduled yet.')); return true; }
    if (action === 'activate') {
      let revisions: Record<string, number>;
      try { revisions = JSON.parse(f('receipts')) as Record<string, number>; } catch { throw new MhpCommerceError(400, 'Refresh the review.'); }
      const result = await owner.activate(identity, context.requestId, { commandId, programmeVersionId: f('programmeVersionId'), programmeSha256: f('programmeSha256'),
        revisions, reviewSha256: f('reviewSha256'), agreed: f('agreed') === 'yes' });
      reply(200, await render(f('programmeVersionId'), result.replayed ? 'Already scheduled. Nothing new was created.' : 'Scheduled for the reviewed time. Nothing has been sent yet.')); return true;
    }
    const control = f('action');
    if (control !== 'hold' && control !== 'cancel') throw new MhpCommerceError(400, 'Refresh the schedule.');
    const done = await owner.control(identity, context.requestId, { commandId, action: control, sendId: f('sendId') });
    reply(200, await render(f('programmeVersionId'), done.inFlight === true ? 'Already handed to WhatsApp, so it could not be stopped. Check its status.' : done.cancelled === true ? 'Cancelled. It will not be sent.' : 'Held. It will not be sent.')); return true;
  } catch (error) {
    outcome = 'service_error';
    reply(error instanceof MhpCommerceError ? error.status : 503, error instanceof MhpCommerceError ? error.message : 'Unavailable. Check recorded status before retrying.', false);
    return true;
  } finally { await Promise.allSettled(leases.map(l => portal.abuse!.complete(l, outcome))); }
}
