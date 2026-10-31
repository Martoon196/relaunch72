import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { withTransaction } from '../db/transaction.js';
import type { DatabaseRequestContext } from '../db/rls.js';
import type { PortalSessionIdentity } from '../portal/auth-service.js';
import type { FlowMessageReview, LocalFlowMessages } from '../followup-sequences/messages.js';
import { FOLLOWUP_SEQUENCE_UUID as UUID } from '../followup-sequences/definition.js';
import { TWILIO_SMS_GSM_BASIC_TEXT } from '../sms-live/foundation.js';
import { MhpCommerceError } from './commerce-service.js';
import { MHP_MARKETING_WORKSPACE_ID, type PgMhpMarketingWorkspaceService } from './marketing-workspace-service.js';

/** Versioned wording the registrant ticks. The SQL refuses any other digest. */
export const MHP_EVENT_SMS_CONSENT_VERSION = 'mhp.event-sms/v1';
export const MHP_EVENT_SMS_CONSENT_TEXT = 'Yes, text me reminders about this Martin Howard Property webinar on this mobile. Only about this webinar. Reply STOP to any text to opt out.';
export const MHP_EVENT_SMS_OWNER_AGREEMENT = 'I have reviewed this exact text and every recipient listed as ready. Each of them verified their own mobile and ticked the webinar text consent. Send it to them now.';
const SHA = /^[a-f0-9]{64}$/u;
const sha256 = (value: string | Buffer): Buffer => createHash('sha256').update(value).digest();

export function mhpEventSmsEnabled(env: NodeJS.ProcessEnv): boolean { return env.MHP_EVENT_SMS_ENABLED === 'true'; }

/** Accept the ways people type a UK mobile; return +447XXXXXXXXX or null. */
export function normaliseUkMobile(raw: string): string | null {
  if (raw.length > 32 || !/^[0-9+()\s-]+$/u.test(raw)) return null;
  const digits = raw.replace(/[\s()-]/gu, '');
  const national = digits.startsWith('+44') ? digits.slice(3) : digits.startsWith('0044') ? digits.slice(4)
    : digits.startsWith('44') && digits.length === 12 ? digits.slice(2) : digits.startsWith('0') ? digits.slice(1) : null;
  const local = national?.startsWith('0') ? national.slice(1) : national;
  return local && /^7[0-9]{9}$/u.test(local) ? `+44${local}` : null;
}
export function normaliseEmail(raw: string): string | null {
  const email = raw.trim().toLowerCase();
  return email.length >= 3 && email.length <= 254 && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/u.test(email) ? email : null;
}

export type MhpEventSmsConfirmation = 'verified' | 'already' | 'retry' | 'unavailable';
export interface MhpEventSmsPublic {
  request(input: { email: string; phone: string; consented: boolean; requestKey: string }, sourceHash: Buffer | null): Promise<string>;
  confirm(optinId: string, code: string): Promise<MhpEventSmsConfirmation>;
}
function publicFailure(error: unknown): never {
  if (error instanceof MhpCommerceError) throw error;
  const code = error && typeof error === 'object' && 'code' in error ? (error as { code?: unknown }).code : undefined;
  if (code === '54000') throw new MhpCommerceError(429, 'Too many attempts from here. Please try again tomorrow.');
  if (code === '22023') throw new MhpCommerceError(400, 'Check the email address and mobile number, then try again.');
  throw new MhpCommerceError(503, 'Webinar texts are temporarily unavailable. Please try again shortly.');
}
/** Runs only as the existing public capture identity. Nothing here touches the CRM. */
export class PgMhpEventSmsPublicService implements MhpEventSmsPublic {
  constructor(private readonly commandPool: Pick<Pool, 'query'>, private readonly campaign: string) {}
  async request(input: { email: string; phone: string; consented: boolean; requestKey: string }, sourceHash: Buffer | null): Promise<string> {
    const email = normaliseEmail(input.email), phone = normaliseUkMobile(input.phone);
    if (!email || !phone) throw new MhpCommerceError(400, 'Enter the email you registered with and a UK mobile number.');
    if (!input.consented) throw new MhpCommerceError(400, 'Tick the box to agree to webinar texts, or simply leave this page.');
    if (!UUID.test(input.requestKey) || !sourceHash || sourceHash.length !== 32) throw new MhpCommerceError(400, 'Refresh the page and try again.');
    try {
      const result = await this.commandPool.query<{ value: { optinId?: unknown } }>(
        'SELECT app_private.mhp_event_sms_optin_request($1,$2,$3,$4,$5,$6,$7) AS value',
        [email, phone, this.campaign, MHP_EVENT_SMS_CONSENT_VERSION, sha256(MHP_EVENT_SMS_CONSENT_TEXT), sourceHash, input.requestKey]);
      const id = result.rows[0]?.value?.optinId;
      if (result.rows.length !== 1 || typeof id !== 'string' || !UUID.test(id)) throw new Error('Invalid opt-in result');
      return id;
    } catch (error) { return publicFailure(error); }
  }
  async confirm(optinId: string, code: string): Promise<MhpEventSmsConfirmation> {
    if (!UUID.test(optinId)) throw new MhpCommerceError(400, 'Refresh the page and try again.');
    if (!/^[0-9]{6}$/u.test(code)) throw new MhpCommerceError(400, 'Enter the six-digit code from the text.');
    try {
      const result = await this.commandPool.query<{ value: unknown }>('SELECT app_private.mhp_event_sms_optin_confirm($1,$2) AS value', [optinId, code]);
      const value = result.rows[0]?.value;
      if (result.rows.length !== 1 || !['verified', 'already', 'retry', 'unavailable'].includes(String(value))) throw new Error('Invalid confirmation');
      return value as MhpEventSmsConfirmation;
    } catch (error) { return publicFailure(error); }
  }
}

export type MhpEventSmsRecipientStatus = 'ready' | 'email_unsubscribed' | 'phone_shared' | 'needs_import' | 'contact_ambiguous'
  | 'opted_out' | 'consent_changed' | 'already_sent';
export interface MhpEventSmsSnapshot {
  campaign: string; bindingReady: boolean; readyCount: number; batchSha256: string | null;
  daySegmentsUsed: number; monthSegmentsUsed: number;
  recipients: readonly { optinId: string; email: string; firstName: string | null; phoneLast4: string; verifiedAt: string; status: MhpEventSmsRecipientStatus }[];
  batches: readonly { batchId: string; contentVersionId: string; recipientCount: number; createdAt: string; jobStates: Record<string, number> }[];
}
export interface MhpEventSmsSendResult {
  batchId: string; commandId: string; recipientCount: number; segmentsTotal: number; jobIds: readonly string[];
  authorityExpiresAt: string; replayed: boolean;
}
export interface MhpEventSmsSendInput { commandId: string; versionId: string; sha256: string; batchSha256: string }
export interface MhpEventSmsRepository {
  snapshot(context: DatabaseRequestContext, identity: PortalSessionIdentity, campaign: string, content: { versionId: string; sha256: string } | null): Promise<MhpEventSmsSnapshot>;
  send(context: DatabaseRequestContext, identity: PortalSessionIdentity, campaign: string, input: MhpEventSmsSendInput, lookupOnly: boolean): Promise<MhpEventSmsSendResult | null>;
}
const STATUSES = new Set(['ready', 'email_unsubscribed', 'phone_shared', 'needs_import', 'contact_ambiguous', 'opted_out', 'consent_changed', 'already_sent']);
function ownerFailure(error: unknown): never {
  if (error instanceof MhpCommerceError) throw error;
  const code = error && typeof error === 'object' && 'code' in error ? (error as { code?: unknown }).code : undefined;
  if (code === '42501') throw new MhpCommerceError(403, 'This MHP owner session or sender is not authorised.');
  if (code === '40001') throw new MhpCommerceError(409, 'The recipients or the text changed since you reviewed them. Refresh and review again.');
  if (code === '54000') throw new MhpCommerceError(409, 'This batch would exceed the 10-segment daily or 50-segment monthly text allowance.');
  if (code === '23514' || code === '23505') throw new MhpCommerceError(409, 'This batch is blocked. Refresh and review its recipients and text.');
  throw new MhpCommerceError(503, 'The batch could not complete. Refresh its recorded status before trying again.');
}
function validSnapshot(value: unknown, campaign: string): value is MhpEventSmsSnapshot {
  const v = value as MhpEventSmsSnapshot | null;
  return Boolean(v) && v!.campaign === campaign && typeof v!.bindingReady === 'boolean' && Number.isInteger(v!.readyCount)
    && (v!.batchSha256 === null || SHA.test(v!.batchSha256)) && Number.isInteger(v!.daySegmentsUsed) && Number.isInteger(v!.monthSegmentsUsed)
    && Array.isArray(v!.recipients) && v!.recipients.every(r => UUID.test(r.optinId) && typeof r.email === 'string'
      && /^[0-9]{4}$/u.test(r.phoneLast4) && STATUSES.has(r.status))
    && Array.isArray(v!.batches) && v!.recipients.filter(r => r.status === 'ready').length === v!.readyCount;
}
export class PgMhpEventSmsRepository implements MhpEventSmsRepository {
  constructor(private readonly commandPool: Pick<Pool, 'connect'>) {}
  async snapshot(context: DatabaseRequestContext, identity: PortalSessionIdentity, campaign: string, content: { versionId: string; sha256: string } | null): Promise<MhpEventSmsSnapshot> {
    try {
      return await withTransaction(this.commandPool, context, async tx => {
        const result = await tx.query<{ value: unknown }>('SELECT app_private.mhp_event_sms_batch_snapshot($1,$2,$3,$4) AS value',
          [sha256(identity.sessionToken), campaign, content?.versionId ?? null, content ? Buffer.from(content.sha256, 'hex') : null]);
        const value = result.rows[0]?.value;
        if (result.rows.length !== 1 || !validSnapshot(value, campaign)) throw new Error('Invalid event SMS snapshot');
        return value;
      }, { readOnly: true });
    } catch (error) { return ownerFailure(error); }
  }
  async send(context: DatabaseRequestContext, identity: PortalSessionIdentity, campaign: string, input: MhpEventSmsSendInput, lookupOnly: boolean): Promise<MhpEventSmsSendResult | null> {
    try {
      return await withTransaction(this.commandPool, context, async tx => {
        const result = await tx.query<{ value: (MhpEventSmsSendResult & { not_started?: undefined }) | { not_started: true } }>(
          'SELECT app_private.mhp_event_sms_batch_send($1,$2,$3,$4,$5,$6,true,$7) AS value',
          [sha256(identity.sessionToken), input.commandId, campaign, input.versionId, Buffer.from(input.sha256, 'hex'),
            Buffer.from(input.batchSha256, 'hex'), lookupOnly]);
        const value = result.rows[0]?.value;
        if (result.rows.length === 1 && value && 'not_started' in value && value.not_started === true) {
          if (lookupOnly) return null;
          throw new Error('Event SMS batch did not start');
        }
        const sent = value as MhpEventSmsSendResult | undefined;
        if (result.rows.length !== 1 || !sent || !UUID.test(sent.batchId) || sent.commandId !== input.commandId || typeof sent.replayed !== 'boolean'
            || !Array.isArray(sent.jobIds) || sent.jobIds.length !== sent.recipientCount || !sent.jobIds.every(id => UUID.test(id))
            || !Number.isFinite(Date.parse(sent.authorityExpiresAt))) throw new Error('Invalid event SMS result');
        return sent;
      }, { isolation: lookupOnly ? 'serializable' : 'read committed' });
    } catch (error) { return ownerFailure(error); }
  }
}

/** Optional readiness probe: the owner command role reaches only the two owner functions. */
export async function assertMhpEventSmsBoundaryReady(pool: Pick<Pool, 'query'>): Promise<void> {
  const result = await pool.query<{ ready: boolean }>(`/* mhp.event-sms.boundary */ SELECT current_user='r72_sms_command'
    AND coalesce(has_function_privilege(current_user,to_regprocedure('app_private.mhp_event_sms_batch_snapshot(bytea,text,uuid,bytea)'),'EXECUTE'),false)
    AND coalesce(has_function_privilege(current_user,to_regprocedure('app_private.mhp_event_sms_batch_send(bytea,uuid,text,uuid,bytea,bytea,boolean,boolean)'),'EXECUTE'),false)
    AND NOT coalesce(has_function_privilege(current_user,to_regprocedure('app_private.mhp_event_sms_batch_candidates(text,uuid)'),'EXECUTE'),false)
    AND NOT coalesce(has_function_privilege(current_user,to_regprocedure('app_private.mhp_event_sms_verified_optins(text)'),'EXECUTE'),false)
    AND NOT coalesce(has_function_privilege(current_user,to_regprocedure('app_private.mhp_event_sms_optin_request(text,text,text,text,bytea,bytea,text)'),'EXECUTE'),false)
    AS ready`);
  if (result.rows.length !== 1 || result.rows[0]?.ready !== true) throw new MhpCommerceError(503, 'The MHP webinar text capability is not ready.');
}

type Messages = Pick<LocalFlowMessages, 'choices' | 'review' | 'publish'>;
export interface MhpEventSmsOwnerDependencies {
  readonly marketingWorkspace: Pick<PgMhpMarketingWorkspaceService, 'snapshot'>;
  authorize(identity: PortalSessionIdentity, requestId: string): Promise<DatabaseRequestContext>;
  readonly campaign: string;
  readonly repository: MhpEventSmsRepository;
  readonly messages: Messages;
  observe(context: DatabaseRequestContext, detail: FlowMessageReview, commandId: string, now: number): Promise<void>;
}
export class MhpEventSmsOwnerService {
  constructor(private readonly dependencies: MhpEventSmsOwnerDependencies) {}
  get campaign(): string { return this.dependencies.campaign; }
  async #context(identity: PortalSessionIdentity, requestId: string): Promise<DatabaseRequestContext> {
    const snapshot = await this.dependencies.marketingWorkspace.snapshot(identity);
    if (!snapshot.marketingSelected || snapshot.marketingWorkspaceId !== MHP_MARKETING_WORKSPACE_ID
        || snapshot.userId !== identity.userId || snapshot.selectedWorkspaceId !== identity.workspaceId) throw new MhpCommerceError(403, 'Open the MHP marketing workspace using your owner login.');
    const context = await this.dependencies.authorize(identity, requestId);
    if (context.workspaceId !== MHP_MARKETING_WORKSPACE_ID || context.userId !== identity.userId || context.actorKind !== 'user') throw new MhpCommerceError(403, 'Refresh your MHP owner login.');
    return context;
  }
  async #review(identity: PortalSessionIdentity, requestId: string, itemId: string, versionId: string): Promise<FlowMessageReview> {
    if (!UUID.test(itemId) || !UUID.test(versionId)) throw new MhpCommerceError(400, 'Choose an exact saved MHP text.');
    const detail = await this.dependencies.messages.review(identity, requestId, 'sms', itemId, versionId);
    const body = detail.payload.bodyText;
    if (!detail.valid || !detail.review.isLatest || detail.channel !== 'sms' || !TWILIO_SMS_GSM_BASIC_TEXT.test(body)
        || body.includes('{{') || body.includes('}}') || body.length > 1530 || !body.includes('STOP')) {
      throw new MhpCommerceError(409, 'Use a current saved MHP text with plain characters, no placeholders and the words Reply STOP.');
    }
    return detail;
  }
  async snapshot(identity: PortalSessionIdentity, requestId: string, chosen?: { itemId: string; versionId: string }) {
    const context = await this.#context(identity, requestId);
    const detail = chosen ? await this.#review(identity, requestId, chosen.itemId, chosen.versionId) : undefined;
    const database = await this.dependencies.repository.snapshot(context, identity, this.dependencies.campaign,
      detail ? { versionId: detail.review.contentVersionId, sha256: detail.review.contentSha256 } : null);
    const choices = (await this.dependencies.messages.choices(identity, requestId)).filter(message => message.channel === 'sms');
    return { database, detail, choices };
  }
  /** One owner action. History is looked up before any mutable work. */
  async send(identity: PortalSessionIdentity, requestId: string, input: { commandId: string; itemId: string; versionId: string; sha256: string; batchSha256: string; agreed: boolean },
    now = Date.now()): Promise<MhpEventSmsSendResult> {
    const context = await this.#context(identity, requestId);
    if (!UUID.test(input.commandId) || !UUID.test(input.itemId) || !UUID.test(input.versionId) || !SHA.test(input.sha256)
        || !SHA.test(input.batchSha256) || !input.agreed) throw new MhpCommerceError(400, 'Review the exact text and recipients, then tick the agreement.');
    const command = { commandId: input.commandId, versionId: input.versionId, sha256: input.sha256, batchSha256: input.batchSha256 };
    const previous = await this.dependencies.repository.send(context, identity, this.dependencies.campaign, command, true);
    if (previous) return previous;
    const detail = await this.#review(identity, requestId, input.itemId, input.versionId);
    if (detail.review.contentSha256 !== input.sha256) throw new MhpCommerceError(409, 'The reviewed text changed. Refresh before sending.');
    if (detail.review.approvalStatus === 'approved' && !detail.review.approvalStale) {
      await this.dependencies.observe(context, detail, input.commandId, now);
    } else {
      await this.dependencies.messages.publish(identity, requestId, 'sms', input.itemId, input.versionId, input.commandId, now);
    }
    const sent = await this.dependencies.repository.send(context, identity, this.dependencies.campaign, command, false);
    if (!sent) throw new MhpCommerceError(503, 'The batch was not started. Refresh its recorded status.');
    return sent;
  }
}
export type MhpEventSmsOwnerSnapshot = Awaited<ReturnType<MhpEventSmsOwnerService['snapshot']>>;
