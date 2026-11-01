import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { canonicalCompanyContentJson, type CompanyContentService, type CompanyContentTransactionRunner,
  type CreateCompanyContentVersionCommand } from '../company-content-pg/index.js';
import { withTransaction } from '../db/transaction.js';
import type { DatabaseRequestContext } from '../db/rls.js';
import type { PortalSessionIdentity } from '../portal/auth-service.js';
import { TWILIO_SMS_GSM_BASIC_TEXT } from '../sms-live/foundation.js';
import { MHP_AUTH_ORIGIN, normalizeMhpEmail } from './auth-service.js';
import { MhpCommerceError } from './commerce-service.js';
import { MHP_MARKETING_WORKSPACE_ID, type PgMhpMarketingWorkspaceService } from './marketing-workspace-service.js';
import { parseMhpOwnerEmailBrand } from './owner-email-content.js';
import type { MhpTransactionalMailer } from './transactional-mail.js';
import type { LocalFlowMessages } from '../followup-sequences/messages.js';
import type { MhpCapturedSignup } from './growth-service.js';

// MHP webinar texts: email-link or same-browser signup access -> signed JOIN -> owner batch.
export const MHP_EVENT_PHONE_ROUTE = '/webinar/phone-reminders';
export const MHP_EVENT_PHONE_OWNER_ROUTE = '/hq/marketing/webinar-texts';
export const MHP_EVENT_PHONE_CAPABILITY_COOKIE = '__Host-mhp_event_phone';
export const mhpEventPhoneCapabilityCookie = (value: string, maxAge: number): string =>
  `${MHP_EVENT_PHONE_CAPABILITY_COOKIE}=${value}; Path=/; Max-Age=${maxAge}; Secure; HttpOnly; SameSite=Strict`;
export const MHP_EVENT_PHONE_CONSENT_REVISION = 'mhp.event-phone-sms/v1';
/** Must equal app_private.mhp_event_phone_consent_text('mhp.event-phone-sms/v1') byte-for-byte. */
export const MHP_EVENT_PHONE_CONSENT_TEXT = 'Text me a reminder about this Martin Howard Property webinar at this mobile number. These texts are only about this webinar, not other marketing. Reply STOP to opt out.';
export const MHP_EVENT_PHONE_SOURCE = 'mhp.event-phone';
export const MHP_EVENT_PHONE_MIME = 'application/vnd.growthhq.event-phone+json';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA = /^[0-9a-f]{64}$/u;
const TOKEN = /^[A-Za-z0-9_-]{43}$/u;
const MINUTE_ISO = /^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:00Z$/u;
/** Native datetime-local values are London wall time, never the browser/server timezone. */
export function mhpEventUkLocalValue(iso: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(iso));
  const value = (name: string) => parts.find(part => part.type === name)!.value;
  return `${value('year')}-${value('month')}-${value('day')}T${value('hour')}:${value('minute')}`;
}
export function mhpEventUkLocalToUtc(local: string): string {
  if (!/^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}$/u.test(local)) throw new MhpCommerceError(400, 'Enter a complete UK date and time.');
  const wall = Date.parse(`${local}:00Z`);
  const matches = [wall, wall - 3_600_000].filter(ms => Number.isFinite(ms) && mhpEventUkLocalValue(new Date(ms).toISOString()) === local);
  if (matches.length !== 1) throw new MhpCommerceError(400, 'That UK time is missing or occurs twice when the clocks change. Choose an unambiguous time.');
  return new Date(matches[0]!).toISOString().replace('.000Z', 'Z');
}
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
const sha256 = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest();
export const mhpEventAccessSha = (token: string): Buffer => sha256(`mhp.event-phone.access/v1:${token}`);
export const mhpEventCapabilitySha = (capability: string): Buffer => sha256(`mhp.event-phone.capability/v1:${capability}`);
export const mhpEventJoinSha = (nonce: string): Buffer => sha256(`mhp.event-phone.join/v1:${nonce.toLowerCase()}`);
/** 26 base32 characters = 130 random bits; typed back by the registrant as "JOIN <nonce>". */
export function mhpEventJoinNonce(bytes: Buffer = randomBytes(26)): string { return Array.from(bytes.subarray(0, 26), b => BASE32[b & 31]).join(''); }
const opaque = (): string => randomBytes(32).toString('base64url');

/** UK mobile only, normalised to E.164. Anything else is refused before SQL. */
export function normalizeMhpEventMobile(raw: string): string | null {
  const digits = raw.replace(/[\s().-]/gu, '');
  const e164 = /^07[0-9]{9}$/u.test(digits) ? `+44${digits.slice(1)}` : /^\+447[0-9]{9}$/u.test(digits) ? digits
    : /^447[0-9]{9}$/u.test(digits) ? `+${digits}` : null;
  return e164;
}

export interface MhpEventPhoneStatus {
  ok: true; campaign: string; firstName: string | null; open: boolean; startsAt: string | null; consentText: string | null;
  capabilityExpiresAt: string;
  sms: { state: string; revision: number; phoneMasked: string; joinExpiresAt: string; grantReceiptId: string | null } | null;
}
export interface MhpEventPhoneChoice { nonce: string; joinExpiresAt: string; alreadyVerified: boolean }

function publicFailure(error: unknown): never {
  if (error instanceof MhpCommerceError) throw error;
  const code = (error as { code?: string })?.code;
  if (code === '54000') throw new MhpCommerceError(429, 'Please wait a minute before asking again.');
  if (code === '40001') throw new MhpCommerceError(409, 'This page changed. Start again from your email link.');
  if (code === '22023') throw new MhpCommerceError(400, 'Check the details and try again.');
  throw new MhpCommerceError(503, 'Webinar text reminders are temporarily unavailable.');
}

/** Anonymous registrant boundary: closed identity-role functions, never direct CRM table access. */
export class PgMhpEventPhonePublic {
  constructor(private readonly pool: Pick<Pool, 'query'>, private readonly mailer: Pick<MhpTransactionalMailer, 'configured'> & Required<Pick<MhpTransactionalMailer, 'sendEventPhoneLink'>>,
    private readonly sender: string) {
    if (!/^\+44[0-9]{9,10}$/u.test(sender)) throw new Error('MHP event reminder sender is invalid');
  }
  get senderNumber(): string { return this.sender; }

  /** Trusted capture result only: same-browser signup participation, never inbox ownership. */
  async fromSignup(signup: MhpCapturedSignup, sourceHash: Buffer | null, now = Date.now()): Promise<{ capability: string; maxAge: number } | null> {
    if (!UUID.test(signup.signupId) || !UUID.test(signup.prospectId) || !/^webinar-[0-9]{4}-[0-9]{2}-[0-9]{2}$/u.test(signup.campaign ?? '')
      || sourceHash?.length !== 32) return null;
    const capability = opaque();
    try {
      const value = (await this.pool.query<{ value: { ok: boolean; expiresAt?: string } }>(
        'SELECT app_private.mhp_event_phone_from_signup($1,$2,$3,$4,$5) AS value',
        [signup.signupId, signup.prospectId, signup.campaign, mhpEventCapabilitySha(capability), sourceHash])).rows[0]?.value;
      if (value?.ok !== true || !value.expiresAt) return null;
      const maxAge = Math.min(900, Math.floor((Date.parse(value.expiresAt) - now) / 1_000));
      return Number.isFinite(maxAge) && maxAge > 0 ? { capability, maxAge } : null;
    } catch { return null; } // Capture already committed: preserve static thanks/email fallback.
  }

  /** Uniform for known and unknown emails; a replay never re-sends; the raw token exists only in the outgoing email. */
  async requestLink(rawEmail: string, sourceHash: Buffer | null): Promise<void> {
    const email = normalizeMhpEmail(rawEmail);
    if (!email) throw new MhpCommerceError(400, 'Enter the email address you registered with.');
    if (!this.mailer.configured) throw new MhpCommerceError(503, 'Webinar text reminders are temporarily unavailable.');
    const token = opaque(), command = randomUUID();
    let value: { send?: boolean; email?: string; startsAt?: string } | undefined;
    try {
      value = (await this.pool.query<{ value: typeof value }>('SELECT app_private.mhp_event_phone_request_link($1,$2,$3,$4,$5) AS value',
        [email, command, mhpEventAccessSha(token), sha256(`mhp.event-phone.request-payload:${email}`), sourceHash?.length === 32 ? sourceHash : sha256('mhp.event-phone.no-source')])).rows[0]?.value;
    } catch (error) { publicFailure(error); }
    if (value?.send !== true || value.email !== email || !value.startsAt) return;
    // Delivery failure leaves the link unused and the response uniform (a 503 here
    // would reveal that the address is registered); a later request supersedes it.
    await this.mailer.sendEventPhoneLink(email, `${MHP_AUTH_ORIGIN}${MHP_EVENT_PHONE_ROUTE}/open?t=${token}`, value.startsAt)
      .catch(() => { console.warn(JSON.stringify({ event: 'mhp.event-phone.link-mail', outcome: 'delivery_unavailable' })); });
  }

  /** Explicit POST only (mail scanners follow GET links). Returns the capability for a host-only cookie. */
  async open(token: string, sourceHash: Buffer | null): Promise<{ capability: string } | { reason: 'invalid' | 'used' | 'expired' }> {
    if (!TOKEN.test(token)) return { reason: 'invalid' };
    const capability = opaque();
    try {
      const value = (await this.pool.query<{ value: { ok: boolean; reason?: 'invalid' | 'used' | 'expired' } }>(
        'SELECT app_private.mhp_event_phone_open($1,$2,$3,$4,$5) AS value',
        [mhpEventAccessSha(token), mhpEventCapabilitySha(capability), randomUUID(), sha256(`mhp.event-phone.open:${token}`),
          sourceHash?.length === 32 ? sourceHash : sha256('mhp.event-phone.no-source')])).rows[0]?.value;
      if (value?.ok === true) return { capability };
      return { reason: value?.reason ?? 'invalid' };
    } catch (error) { return publicFailure(error); }
  }

  async status(capability: string): Promise<MhpEventPhoneStatus | null> {
    if (!TOKEN.test(capability)) return null;
    try {
      const value = (await this.pool.query<{ value: MhpEventPhoneStatus | { ok: false } }>('SELECT app_private.mhp_event_phone_status($1) AS value',
        [mhpEventCapabilitySha(capability)])).rows[0]?.value;
      return value && value.ok === true ? value : null;
    } catch (error) { return publicFailure(error); }
  }

  async choose(capability: string, rawPhone: string, consented: boolean, sourceHash: Buffer | null): Promise<MhpEventPhoneChoice | { reason: string }> {
    if (!TOKEN.test(capability)) return { reason: 'session' };
    if (!consented) throw new MhpCommerceError(400, 'Tick the box to agree to webinar text reminders, or simply leave this page.');
    const phone = normalizeMhpEventMobile(rawPhone);
    if (!phone) throw new MhpCommerceError(400, 'Enter a UK mobile number, for example 07700 900123.');
    const nonce = mhpEventJoinNonce(), command = randomUUID();
    try {
      const value = (await this.pool.query<{ value: { ok: boolean; reason?: string; joinExpiresAt?: string; alreadyVerified?: boolean } }>(
        'SELECT app_private.mhp_event_phone_choose($1,$2,$3,$4,$5,$6,$7,$8) AS value',
        [mhpEventCapabilitySha(capability), command, phone, MHP_EVENT_PHONE_CONSENT_REVISION, sha256(MHP_EVENT_PHONE_CONSENT_TEXT),
          mhpEventJoinSha(nonce), sha256(`mhp.event-phone.choose:${phone}:${MHP_EVENT_PHONE_CONSENT_REVISION}`),
          sourceHash?.length === 32 ? sourceHash : sha256('mhp.event-phone.no-source')])).rows[0]?.value;
      if (!value?.ok) return { reason: value?.reason ?? 'session' };
      if (value.alreadyVerified) return { nonce: '', joinExpiresAt: '', alreadyVerified: true };
      if (!value.joinExpiresAt) throw new Error('Invalid choice result');
      return { nonce, joinExpiresAt: value.joinExpiresAt, alreadyVerified: false };
    } catch (error) { return publicFailure(error); }
  }

  async withdraw(capability: string, receiptId: string): Promise<boolean> {
    if (!TOKEN.test(capability) || !UUID.test(receiptId)) return false;
    const command = randomUUID();
    try {
      const value = (await this.pool.query<{ value: { ok: boolean } }>('SELECT app_private.mhp_event_phone_withdraw($1,$2,$3,$4) AS value',
        [mhpEventCapabilitySha(capability), command, receiptId, sha256(`mhp.event-phone.withdraw:${receiptId}`)])).rows[0]?.value;
      return value?.ok === true;
    } catch (error) { return publicFailure(error); }
  }
}

// ── Owner programme, review and batch ─────────────────────────────────────

export interface MhpEventProgrammeInput {
  commandId: string; startsAt: string; dueAt: string; providerDeadline: string; admissionUntil: string;
  sourceVersionId: string; previousItemId: string; previousVersionId: string;
}
export interface MhpEventSmsChoice { itemId: string; versionId: string; sha256: string; title: string; preview: string }
export interface MhpEventReview {
  programme: Record<string, unknown> & { programmeVersionId: string; programmeSha256: string; event: string; dueAt: string; startsAt: string; providerDeadline: string };
  bodyText: string; senderNumber: string; budget: Record<string, number | string>; maxBatch: number;
  recipients: { receiptId: string; revision: number; phoneMasked: string; firstName: string | null; selected: boolean }[];
  selectedReceiptIds: string[]; selectedRevisions: Record<string, number>; reviewSha256: string;
  excluded: Record<string, number>; awaitingOwnerReview: number;
  schedule: { calendarId: string; dueAt: string; cancelled: boolean; held: string | null; prepared: boolean; jobState: string | null; deliveryStatus: string | null; phoneMasked: string }[];
}
export interface MhpEventProgrammeSummary { contentItemId: string; contentVersionId: string; title: string; approvalStatus: string; approvalStale: boolean }
type Content = Pick<CompanyContentService, 'createVersion' | 'refreshSourceAttestation'>;
type Approvals = Pick<CompanyContentService, 'requestApproval' | 'decideApproval'>;
type Reader = Pick<CompanyContentService, 'listCatalog'>;
export interface MhpEventPhoneOwnerDependencies {
  readonly marketingWorkspace: Pick<PgMhpMarketingWorkspaceService, 'snapshot'>;
  authorize(identity: PortalSessionIdentity, requestId: string): Promise<DatabaseRequestContext>;
  /** Owner pool: r72_sms_command (review/activate/control only). */
  readonly smsPool: Pick<Pool, 'connect'>;
  readonly reader: Reader; readonly adapter: Content; readonly approvals: Approvals;
  readonly texts: Pick<LocalFlowMessages, 'review'>;
  readonly adapterTransactions: CompanyContentTransactionRunner;
  brand(identity: PortalSessionIdentity): Promise<unknown>;
  /** Refresh the exact local SMS source observation before activation (existing 009A path). */
  observeSource(identity: PortalSessionIdentity, requestId: string, context: DatabaseRequestContext, sourceItemId: string, sourceVersionId: string, commandId: string, now: number): Promise<void>;
  readonly campaign: string; readonly bindingId: string;
}

function ownerFailure(error: unknown): never {
  if (error instanceof MhpCommerceError) throw error;
  const code = (error as { code?: string })?.code;
  if (code === '42501') throw new MhpCommerceError(403, 'Open the MHP marketing workspace with your owner account.');
  if (code === '54000') throw new MhpCommerceError(409, 'This batch would exceed the SMS caps (10 segments a day, 50 a month). Nothing was scheduled.');
  if (['23514', '23505', '40001'].includes(code ?? '')) throw new MhpCommerceError(409, 'The programme, a recipient or the text changed. Refresh the review; nothing was scheduled.');
  if (code === '22023') throw new MhpCommerceError(400, 'Check the programme details.');
  throw new MhpCommerceError(503, 'Webinar texts are temporarily unavailable. Check the recorded status before retrying.');
}

export class MhpEventPhoneOwner {
  constructor(private readonly dependencies: MhpEventPhoneOwnerDependencies) {
    if (!UUID.test(dependencies.bindingId) || !/^webinar-[0-9]{4}-[0-9]{2}-[0-9]{2}$/u.test(dependencies.campaign)) throw new Error('MHP event reminder owner configuration is invalid');
  }
  async #context(identity: PortalSessionIdentity, requestId: string): Promise<DatabaseRequestContext> {
    const snapshot = await this.dependencies.marketingWorkspace.snapshot(identity);
    if (!snapshot.marketingSelected || snapshot.marketingWorkspaceId !== MHP_MARKETING_WORKSPACE_ID
        || snapshot.userId !== identity.userId || snapshot.selectedWorkspaceId !== identity.workspaceId) throw new MhpCommerceError(403, 'Open the MHP marketing workspace using your owner login.');
    const context = await this.dependencies.authorize(identity, requestId);
    if (context.workspaceId !== MHP_MARKETING_WORKSPACE_ID || context.userId !== identity.userId || context.actorKind !== 'user') throw new MhpCommerceError(403, 'Refresh your MHP owner login.');
    return context;
  }
  async programmes(identity: PortalSessionIdentity, requestId: string): Promise<MhpEventProgrammeSummary[]> {
    const context = await this.#context(identity, requestId);
    const page = await this.dependencies.reader.listCatalog(context, { limit: 20, sourceSystem: MHP_EVENT_PHONE_SOURCE });
    return page.items.map(item => ({ contentItemId: item.contentItemId, contentVersionId: item.contentVersionId, title: item.title,
      approvalStatus: item.approvalStatus, approvalStale: item.approvalStale }));
  }
  async smsTexts(identity: PortalSessionIdentity, requestId: string): Promise<MhpEventSmsChoice[]> {
    const context = await this.#context(identity, requestId);
    const catalog = await this.dependencies.reader.listCatalog(context, { limit: 50, sourceSystem: 'mhp.owner-sms' });
    const choices: MhpEventSmsChoice[] = [];
    for (const item of catalog.items) {
      const detail = await this.dependencies.texts.review(identity, requestId, 'sms', item.contentItemId, item.contentVersionId);
      if (detail.channel !== 'sms' || !detail.valid || !detail.review.isLatest || detail.review.source.system !== 'mhp.owner-sms'
          || detail.review.approvalStatus !== 'approved' || detail.review.approvalStale || !TWILIO_SMS_GSM_BASIC_TEXT.test(detail.payload.bodyText)
          || detail.payload.bodyText.length > 1530 || /\{\{|\}\}/u.test(detail.payload.bodyText)) continue;
      choices.push({ itemId: detail.review.contentItemId, versionId: detail.review.contentVersionId, sha256: detail.review.contentSha256,
        title: detail.review.title, preview: detail.payload.bodyText });
    }
    return choices;
  }
  /** Saves an exact programme version (no recipients, no send). Approval is a separate publish. */
  async saveProgramme(identity: PortalSessionIdentity, requestId: string, input: MhpEventProgrammeInput, now = Date.now()): Promise<{ contentItemId: string; contentVersionId: string }> {
    const context = await this.#context(identity, requestId);
    if (!UUID.test(input.commandId) || !UUID.test(input.sourceVersionId)
        || ![input.startsAt, input.dueAt, input.providerDeadline, input.admissionUntil].every(value => MINUTE_ISO.test(value))
        || (input.previousVersionId !== '' && (!UUID.test(input.previousVersionId) || !UUID.test(input.previousItemId)))) throw new MhpCommerceError(400, 'Check the programme times (UTC, whole minutes) and the saved text.');
    const event = this.dependencies.campaign;
    const selectedText = (await this.smsTexts(identity, requestId)).find(text => text.versionId === input.sourceVersionId);
    if (!selectedText) throw new MhpCommerceError(409, 'Choose a current approved text from your MHP SMS library.');
    if (!input.startsAt.startsWith(event.slice(8))) throw new MhpCommerceError(400, `The start time must be on ${event.slice(8)} (UTC).`);
    const body = { schema: 'mhp.event-phone/v1', event, channel: 'sms', stepKey: 'event_sms_1h', startsAt: input.startsAt, dueAt: input.dueAt,
      admissionUntil: input.admissionUntil, providerDeadline: input.providerDeadline, consentRevision: MHP_EVENT_PHONE_CONSENT_REVISION,
      consentTextSha256: sha256(MHP_EVENT_PHONE_CONSENT_TEXT).toString('hex'), sourceContentItemId: selectedText.itemId,
      sourceContentVersionId: selectedText.versionId, sourceContentSha256: selectedText.sha256, senderBindingId: this.dependencies.bindingId };
    const canonical = canonicalCompanyContentJson(body), sha = createHash('sha256').update(canonical).digest('hex');
    const brand = parseMhpOwnerEmailBrand(await this.dependencies.brand(identity));
    const item = `event-phone:${event}`, revision = `edit:${input.commandId}`, storageKey = `inline:${MHP_EVENT_PHONE_SOURCE}:${sha}`;
    const manifest = canonicalCompanyContentJson({ schema: 'mhp.event-phone-source/v1', workspaceId: MHP_MARKETING_WORKSPACE_ID, sourceSystem: MHP_EVENT_PHONE_SOURCE,
      sourceItemId: item, sourceVersion: revision, contentSha256: sha, blobStorageKey: storageKey, blobSha256: sha, brandSnapshotRef: brand.ref, brandSha256: brand.sha256 });
    const manifestSha = createHash('sha256').update(manifest).digest('hex');
    const command: CreateCompanyContentVersionCommand = { commandKey: `mhp.event-phone.save.${input.commandId}`,
      contentItemId: input.previousItemId || null, previousVersionId: input.previousVersionId || null, origin: input.previousVersionId ? 'edited' : 'imported',
      kind: 'other', title: `Webinar text reminder ${event}`, contentMimeType: MHP_EVENT_PHONE_MIME, content: canonical,
      source: { system: MHP_EVENT_PHONE_SOURCE, itemId: item, version: revision }, blob: { storageKey, sha256: sha }, brand: { snapshotRef: brand.ref, sha256: brand.sha256 },
      attestation: { catalogSha256: manifestSha, checkedAt: new Date(now).toISOString(), expiresAt: new Date(now + 900_000).toISOString() },
      metadata: { mhpEventPhone: { schema: 'mhp.event-phone-local/v1', brandCanonical: brand.canonical, manifestCanonical: manifest, manifestSha256: manifestSha, authoredBy: 'native-owner' } } };
    try {
      const result = await this.dependencies.adapter.createVersion(context, command);
      return { contentItemId: result.contentItemId, contentVersionId: result.contentVersionId };
    } catch (error) { return ownerFailure(error); }
  }
  /** Genuine owner approval of the exact programme version (no recipients, no send). */
  async publishProgramme(identity: PortalSessionIdentity, requestId: string, itemId: string, versionId: string, commandId: string): Promise<void> {
    const context = await this.#context(identity, requestId);
    if (!UUID.test(itemId) || !UUID.test(versionId) || !UUID.test(commandId)) throw new MhpCommerceError(400, 'Refresh the programme page.');
    try {
      const requested = await this.dependencies.approvals.requestApproval(context, { commandKey: `mhp.event-phone.publish.${commandId}.request`, contentItemId: itemId,
        contentVersionId: versionId, reviewNote: 'Native owner reviewed this exact webinar text programme. Recipients still need their own batch review.' });
      await this.dependencies.approvals.decideApproval(context, { commandKey: `mhp.event-phone.publish.${commandId}.approve`, approvalRequestId: requested.approvalRequestId,
        decision: 'approved', decisionNote: 'Approved by the native MHP owner; no recipient is scheduled by this approval.' });
    } catch (error) { return ownerFailure(error); }
  }
  async review(identity: PortalSessionIdentity, requestId: string, programmeVersionId: string): Promise<MhpEventReview> {
    const context = await this.#context(identity, requestId);
    if (!UUID.test(programmeVersionId)) throw new MhpCommerceError(400, 'Choose a saved programme.');
    try {
      return await withTransaction(this.dependencies.smsPool, context, async tx => {
        const value = (await tx.query<{ value: MhpEventReview }>('SELECT app_private.mhp_event_phone_review($1,$2) AS value',
          [sha256(identity.sessionToken), programmeVersionId])).rows[0]?.value;
        if (!value || !SHA.test(value.reviewSha256) || value.programme.programmeVersionId !== programmeVersionId
            || !TWILIO_SMS_GSM_BASIC_TEXT.test(value.bodyText)) throw new Error('Invalid event review');
        return value;
      });
    } catch (error) { return ownerFailure(error); }
  }
  /** The one owner action: exactly the reviewed recipients (as shown) are pre-materialised for the absolute due time. */
  async activate(identity: PortalSessionIdentity, requestId: string, input: { commandId: string; programmeVersionId: string; programmeSha256: string;
    receiptIds: string[]; revisions: Record<string, number>; reviewSha256: string; agreed: boolean }, now = Date.now()): Promise<Record<string, unknown>> {
    const context = await this.#context(identity, requestId);
    const receipts = [...input.receiptIds].sort();
    if (!UUID.test(input.commandId) || !UUID.test(input.programmeVersionId) || !SHA.test(input.programmeSha256) || !SHA.test(input.reviewSha256) || !input.agreed
        || receipts.length < 1 || receipts.length > 10 || new Set(receipts).size !== receipts.length || receipts.some(id => !UUID.test(id))
        || receipts.some(id => !Number.isSafeInteger(input.revisions[id]) || input.revisions[id]! < 1) || Object.keys(input.revisions).length !== receipts.length) {
      throw new MhpCommerceError(400, 'Review the exact recipients, text and time, then tick the box.');
    }
    const execute = (lookupOnly: boolean) => withTransaction(this.dependencies.smsPool, context, async tx => (await tx.query<{ value: Record<string, unknown> }>(
      'SELECT app_private.mhp_event_phone_activate($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) AS value',
      [sha256(identity.sessionToken), input.commandId, input.programmeVersionId, Buffer.from(input.programmeSha256, 'hex'), receipts,
        JSON.stringify(Object.fromEntries(receipts.map(id => [id, input.revisions[id]]))), Buffer.from(input.reviewSha256, 'hex'), context.requestId, true, lookupOnly])).rows[0]!.value,
    { isolation: 'read committed' });
    try {
      const previous = await execute(true);
      if (previous.not_started !== true) return previous;
      const review = await this.review(identity, requestId, input.programmeVersionId);
      if (review.reviewSha256 !== input.reviewSha256) throw new MhpCommerceError(409, 'The recipient list changed since you reviewed it. Review the new list; nothing was scheduled.');
      const source = review.programme as { sourceContentItemId?: string; sourceContentVersionId?: string };
      await this.dependencies.observeSource(identity, requestId, context, String(source.sourceContentItemId), String(source.sourceContentVersionId), input.commandId, now);
      return await execute(false);
    } catch (error) { return ownerFailure(error); }
  }
  async control(identity: PortalSessionIdentity, requestId: string, input: { commandId: string; action: 'hold' | 'cancel'; calendarId: string }): Promise<Record<string, unknown>> {
    const context = await this.#context(identity, requestId);
    if (!UUID.test(input.commandId) || !UUID.test(input.calendarId) || (input.action !== 'hold' && input.action !== 'cancel')) throw new MhpCommerceError(400, 'Refresh the schedule.');
    try {
      return await withTransaction(this.dependencies.smsPool, context, async tx => (await tx.query<{ value: Record<string, unknown> }>(
        'SELECT app_private.mhp_event_phone_control($1,$2,$3,$4,$5,$6) AS value',
        [sha256(identity.sessionToken), input.commandId, input.action, input.calendarId, sha256(`${input.action}:${input.calendarId}`), context.requestId])).rows[0]!.value);
    } catch (error) { return ownerFailure(error); }
  }
}
