import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import type { CompanyContentService, CompanyContentTransactionRunner } from '../company-content-pg/index.js';
import { withTransaction } from '../db/transaction.js';
import type { DatabaseRequestContext } from '../db/rls.js';
import type { PortalSessionIdentity } from '../portal/auth-service.js';
import type { PortalSmsBindingService } from '../portal/sms-binding-service.js';
import type { LocalFlowMessages, FlowMessageReview } from '../followup-sequences/messages.js';
import { FOLLOWUP_SEQUENCE_UUID as UUID } from '../followup-sequences/definition.js';
import { TWILIO_SMS_GSM_BASIC_TEXT } from '../sms-live/foundation.js';
import { MhpCommerceError } from './commerce-service.js';
import { MHP_MARKETING_WORKSPACE_ID, type PgMhpMarketingWorkspaceService } from './marketing-workspace-service.js';

export const MHP_OWNED_SMS_REVIEW_VERSION = 'mhp.owned-sms-self-test/v1';
export const MHP_OWNED_SMS_PERMISSION = 'I agree to receive one Martin Howard Property test SMS on this verified number. This does not subscribe me to future SMS or WhatsApp.';
export const MHP_OWNED_SMS_DEFAULT_BODY = 'Martin Howard Property test: webinar Wednesday 4 November, 7:30pm UK. Watch https://martinhowardproperty.co.uk/webinar/live/ Reply STOP to opt out.';
const PHONE = /^\+44[0-9]{9,10}$/u;
const SHA = /^[a-f0-9]{64}$/u;
const hash = (value: string): string => createHash('sha256').update(value).digest('hex');

export async function assertMhpOwnedSmsBoundaryReady(pool: Pick<Pool, 'query'>): Promise<void> {
  const result = await pool.query<{ ready: boolean }>(`/* mhp.owned-sms.boundary */ SELECT current_user='r72_sms_command'
    AND coalesce(has_function_privilege(current_user,to_regprocedure('app_private.mhp_owned_sms_snapshot(bytea,uuid,text)'),'EXECUTE'),false)
    AND coalesce(has_function_privilege(current_user,to_regprocedure('app_private.mhp_owned_sms_send(bytea,uuid,uuid,uuid,uuid,uuid,bytea,text,boolean,boolean)'),'EXECUTE'),false)
    AND NOT coalesce(has_function_privilege(current_user,to_regprocedure('app_private.mhp_owned_sms_content(uuid,bytea)'),'EXECUTE'),false)
    AS ready`);
  if (result.rows.length !== 1 || result.rows[0]?.ready !== true) throw new MhpCommerceError(503, 'The MHP owned-SMS command capability is not ready.');
}

export interface MhpOwnedSmsConfig {
  readonly ownerUserId: string; readonly contactId: string; readonly phone: string;
  readonly connectionId: string; readonly bindingId: string; readonly endpointId: string;
  readonly accountSid: string; readonly messagingServiceSid: string; readonly senderNumber: string;
}
export function mhpOwnedSmsConfig(env: NodeJS.ProcessEnv): { enabled: boolean; config: MhpOwnedSmsConfig | null; blockers: readonly string[] } {
  if (env.MHP_SMS_PILOT_ENABLED !== 'true') return { enabled: false, config: null, blockers: ['The MHP owned-phone pilot is not enabled.'] };
  const fields = { ownerUserId: env.MHP_SMS_PILOT_OWNER_USER_ID, contactId: env.MHP_SMS_PILOT_CONTACT_ID,
    phone: env.MHP_SMS_PILOT_PHONE, connectionId: env.MHP_SMS_LIVE_CONNECTION_ID, bindingId: env.MHP_SMS_BINDING_ID,
    endpointId: env.MHP_SMS_ENDPOINT_ID, accountSid: env.MHP_SMS_ACCOUNT_SID,
    messagingServiceSid: env.MHP_SMS_MESSAGING_SERVICE_SID, senderNumber: env.MHP_SMS_SENDER_NUMBER };
  const valid = Object.values(fields).every(value => typeof value === 'string' && value.trim() === value)
    && ['ownerUserId', 'contactId', 'connectionId', 'bindingId', 'endpointId'].every(key => UUID.test(fields[key as keyof typeof fields]!))
    && PHONE.test(fields.phone!) && PHONE.test(fields.senderNumber!)
    && /^AC[0-9a-f]{32}$/u.test(fields.accountSid!) && /^MG[0-9a-f]{32}$/u.test(fields.messagingServiceSid!);
  return { enabled: true, config: valid ? fields as MhpOwnedSmsConfig : null,
    blockers: valid ? [] : ['MHP sender, owner and owned-recipient settings need completing.'] };
}
export interface MhpOwnedSmsDatabaseSnapshot {
  readonly bindingId: string | null; readonly senderNumber: string | null;
  readonly contactId: string; readonly contactPointId: string | null; readonly verified: boolean;
  readonly suppressed: boolean; readonly lastResult: MhpOwnedSmsSendResult | null;
}
export interface MhpOwnedSmsSendResult {
  readonly jobId: string; readonly messageVersionId: string; readonly contentVersionId: string;
  readonly commandId: string; readonly authorityExpiresAt: string;
  readonly state: string; readonly replayed: boolean;
}
export interface MhpOwnedSmsRepository {
  snapshot(context: DatabaseRequestContext, identity: PortalSessionIdentity, config: MhpOwnedSmsConfig): Promise<MhpOwnedSmsDatabaseSnapshot>;
  lookup(context: DatabaseRequestContext, identity: PortalSessionIdentity, input: MhpOwnedSmsRepositoryInput): Promise<MhpOwnedSmsSendResult | null>;
  send(context: DatabaseRequestContext, identity: PortalSessionIdentity, input: MhpOwnedSmsRepositoryInput): Promise<MhpOwnedSmsSendResult>;
}
export interface MhpOwnedSmsRepositoryInput {
    commandId: string; bindingId: string; contactId: string; pointId: string;
    versionId: string; sha256: string;
}
function safeFailure(error: unknown): never {
  if (error instanceof MhpCommerceError) throw error;
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  if (code === '42501') throw new MhpCommerceError(403, 'This MHP owner, permission or sender is not authorised.');
  if (code === '40001' || code === '23505' || code === '23514') throw new MhpCommerceError(409, 'The reviewed test changed or is blocked. Refresh before continuing.');
  throw new MhpCommerceError(503, 'The MHP phone test could not complete. Check its recorded status before retrying.');
}
export class PgMhpOwnedSmsRepository implements MhpOwnedSmsRepository {
  constructor(private readonly commandPool: Pick<Pool, 'connect'>) {}
  async snapshot(context: DatabaseRequestContext, identity: PortalSessionIdentity, config: MhpOwnedSmsConfig): Promise<MhpOwnedSmsDatabaseSnapshot> {
    try {
      return await withTransaction(this.commandPool, context, async tx => {
        const result = await tx.query<{ value: MhpOwnedSmsDatabaseSnapshot }>(
          'SELECT app_private.mhp_owned_sms_snapshot($1::bytea,$2::uuid,$3::text) AS value',
          [Buffer.from(hash(identity.sessionToken), 'hex'), config.contactId, config.phone]);
        const value = result.rows[0]?.value;
        if (result.rows.length !== 1 || !value || value.contactId !== config.contactId
            || typeof value.verified !== 'boolean' || typeof value.suppressed !== 'boolean'
            || value.contactPointId !== null && !UUID.test(value.contactPointId)
            || value.bindingId !== null && value.bindingId !== config.bindingId
            || value.senderNumber !== null && value.senderNumber !== config.senderNumber) throw new Error('Invalid owned SMS snapshot');
        return value;
      });
    } catch (error) { return safeFailure(error); }
  }
  async lookup(context: DatabaseRequestContext, identity: PortalSessionIdentity, input: MhpOwnedSmsRepositoryInput): Promise<MhpOwnedSmsSendResult | null> {
    return this.#execute(context, identity, input, true);
  }
  async send(context: DatabaseRequestContext, identity: PortalSessionIdentity, input: MhpOwnedSmsRepositoryInput): Promise<MhpOwnedSmsSendResult> {
    const result = await this.#execute(context, identity, input, false);
    if (!result) throw new MhpCommerceError(503, 'The test was not started. Refresh its recorded status.');
    return result;
  }
  async #execute(context: DatabaseRequestContext, identity: PortalSessionIdentity, input: MhpOwnedSmsRepositoryInput, lookupOnly: boolean): Promise<MhpOwnedSmsSendResult | null> {
    try {
      return await withTransaction(this.commandPool, context, async tx => {
        const result = await tx.query<{ value: MhpOwnedSmsSendResult | { not_started: true } }>(
          `SELECT app_private.mhp_owned_sms_send($1::bytea,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::uuid,$7::bytea,$8::text,$9::boolean,$10::boolean) AS value`,
          [Buffer.from(hash(identity.sessionToken), 'hex'), input.commandId, input.bindingId, input.contactId, input.pointId,
            input.versionId, Buffer.from(input.sha256, 'hex'), MHP_OWNED_SMS_REVIEW_VERSION, true, lookupOnly]);
        const value = result.rows[0]?.value;
        if (result.rows.length === 1 && value && 'not_started' in value && value.not_started === true && lookupOnly) return null;
        if (result.rows.length !== 1 || !value || 'not_started' in value || !UUID.test(value.jobId) || !UUID.test(value.messageVersionId)
            || value.contentVersionId !== input.versionId || value.commandId !== input.commandId || typeof value.replayed !== 'boolean'
            || typeof value.state !== 'string' || !Number.isFinite(Date.parse(value.authorityExpiresAt))) throw new Error('Invalid owned SMS result');
        return value;
      }, { isolation: lookupOnly ? 'serializable' : 'read committed' });
    } catch (error) { return safeFailure(error); }
  }
}
type Messages = Pick<LocalFlowMessages, 'choices' | 'review' | 'save' | 'publish'>;
type Binding = Pick<PortalSmsBindingService, 'bindSender' | 'requestPhoneVerification' | 'confirmPhoneVerification'>;
export async function refreshMhpOwnedSmsObservation(input: { context: DatabaseRequestContext; detail: FlowMessageReview; commandId: string; now: number;
  transactions: CompanyContentTransactionRunner; adapter: Pick<CompanyContentService, 'refreshSourceAttestation'> }): Promise<void> {
  const { context, detail } = input, review = detail.review;
  if (!detail.valid || !detail.manifestSha256 || !review.isLatest || review.source.system !== 'mhp.owner-sms') throw new MhpCommerceError(409, 'Review a current MHP text before checking its source.');
  const key = `mhp.sms.owned-test.${input.commandId}.observation`;
  const recorded = () => input.transactions.run(context, async tx => {
    const result = await tx.query<{ status: string; result: { contentItemId?: string; contentVersionId?: string; sourceAttestationExpiresAt?: string } }>(
      `SELECT status,result FROM app.command_receipts WHERE workspace_id=app_private.current_workspace_id() AND actor_user_id=app_private.current_user_id()
       AND command_name='companyContent.refreshSourceAttestation' AND idempotency_key=$1`, [key]);
    const row = result.rows[0]; if (!row) return false;
    if (row.status !== 'succeeded' || row.result.contentItemId !== review.contentItemId || row.result.contentVersionId !== review.contentVersionId) throw new MhpCommerceError(409, 'This source check belongs to a different text.');
    if (!row.result.sourceAttestationExpiresAt || Date.parse(row.result.sourceAttestationExpiresAt) <= input.now) throw new MhpCommerceError(409, 'This test source check expired. Reopen the page and review a new test.');
    return true;
  }, { readOnly: true });
  if (await recorded()) return;
  try {
    await input.adapter.refreshSourceAttestation(context, { commandKey: key, contentItemId: review.contentItemId, contentVersionId: review.contentVersionId,
      expected: { source: review.source, contentSha256: review.contentSha256, blobSha256: review.blobSha256, brandSha256: review.brandSha256 },
      attestation: { catalogSha256: detail.manifestSha256, checkedAt: new Date(input.now).toISOString(), expiresAt: new Date(input.now + 900_000).toISOString() } });
  } catch (error) { if (!await recorded()) throw error; }
}
export interface MhpOwnedSmsDependencies {
  readonly marketingWorkspace: Pick<PgMhpMarketingWorkspaceService, 'snapshot'>;
  authorize(identity: PortalSessionIdentity, requestId: string): Promise<DatabaseRequestContext>;
  readonly config: MhpOwnedSmsConfig | null; readonly blockers: readonly string[];
  readonly repository?: MhpOwnedSmsRepository; readonly binding?: Binding;
  readonly messages: Messages;
  observe(context: DatabaseRequestContext, detail: FlowMessageReview, commandId: string, now: number): Promise<void>;
}
export class MhpOwnedSmsService {
  constructor(private readonly dependencies: MhpOwnedSmsDependencies) {}
  async #context(identity: PortalSessionIdentity, requestId: string): Promise<DatabaseRequestContext> {
    const snapshot = await this.dependencies.marketingWorkspace.snapshot(identity);
    if (!snapshot.marketingSelected || snapshot.marketingWorkspaceId !== MHP_MARKETING_WORKSPACE_ID
        || snapshot.userId !== identity.userId || snapshot.selectedWorkspaceId !== identity.workspaceId) throw new MhpCommerceError(403, 'Open the MHP marketing workspace using your owner login.');
    if (this.dependencies.config && identity.userId !== this.dependencies.config.ownerUserId) throw new MhpCommerceError(403, 'This owned test is available to the configured MHP owner only.');
    const context = await this.dependencies.authorize(identity, requestId);
    if (context.workspaceId !== MHP_MARKETING_WORKSPACE_ID || context.userId !== identity.userId || context.actorKind !== 'user') throw new MhpCommerceError(403, 'Refresh your MHP owner login.');
    return context;
  }
  #ready(): { config: MhpOwnedSmsConfig; repository: MhpOwnedSmsRepository; binding: Binding } {
    const { config, repository, binding } = this.dependencies;
    if (!config || !repository || !binding) throw new MhpCommerceError(503, 'MHP phone-test configuration is incomplete.');
    return { config, repository, binding };
  }
  async snapshot(identity: PortalSessionIdentity, requestId: string) {
    const context = await this.#context(identity, requestId);
    const database = this.dependencies.config && this.dependencies.repository
      ? await this.dependencies.repository.snapshot(context, identity, this.dependencies.config) : null;
    return { database, config: this.dependencies.config ? { phone: this.dependencies.config.phone, senderNumber: this.dependencies.config.senderNumber } : null,
      blockers: [...this.dependencies.blockers], choices: (await this.dependencies.messages.choices(identity, requestId)).filter(message => message.channel === 'sms') };
  }
  async bind(identity: PortalSessionIdentity, requestId: string, input: { regulatoryEvidence: string; ownershipEvidence: string; confirmed: boolean }, now = Date.now()): Promise<void> {
    await this.#context(identity, requestId); const { config, binding } = this.#ready();
    if (!input.confirmed) throw new MhpCommerceError(400, 'Confirm the MHP sender ownership before connecting it.');
    const result = await binding.bindSender({ sessionToken: identity.sessionToken, requestId }, { bindingId: config.bindingId,
      providerConnectionId: config.connectionId, channelEndpointId: config.endpointId, displayName: 'Martin Howard Property webinar',
      accountSid: config.accountSid, messagingServiceSid: config.messagingServiceSid, senderNumber: config.senderNumber,
      regulatoryEvidence: input.regulatoryEvidence, ownershipEvidence: input.ownershipEvidence, ownershipAttested: true,
      evidenceObservedAt: new Date(now).toISOString() });
    if (!result.ok) throw new MhpCommerceError(result.kind === 'conflict' ? 409 : 503, 'The MHP sender was not connected. Refresh its recorded status before retrying.');
  }
  async requestCode(identity: PortalSessionIdentity, requestId: string, commandId: string): Promise<string> {
    await this.#context(identity, requestId); const { config, binding } = this.#ready();
    if (!UUID.test(commandId)) throw new MhpCommerceError(400, 'Refresh the verification form.');
    const result = await binding.requestPhoneVerification?.({ sessionToken: identity.sessionToken, requestId }, { contactId: config.contactId, phone: config.phone, commandKey: commandId });
    if (!result?.ok) throw new MhpCommerceError(409, 'The verification request was not accepted. Check the MHP connection and try again.');
    return result.challengeId;
  }
  async confirmCode(identity: PortalSessionIdentity, requestId: string, challengeId: string, code: string): Promise<boolean> {
    await this.#context(identity, requestId); const { binding } = this.#ready();
    if (!UUID.test(challengeId) || !/^\d{6}$/u.test(code)) throw new MhpCommerceError(400, 'Enter the six-digit code from your MHP verification text.');
    const result = await binding.confirmPhoneVerification?.({ sessionToken: identity.sessionToken, requestId }, { challengeId, code });
    if (!result?.ok) throw new MhpCommerceError(409, 'The code could not be verified. Check the code and its expiry.');
    return Boolean(result.contactPointId);
  }
  async review(identity: PortalSessionIdentity, requestId: string, itemId: string, versionId: string): Promise<FlowMessageReview> {
    await this.#context(identity, requestId);
    const detail = await this.dependencies.messages.review(identity, requestId, 'sms', itemId, versionId);
    if (!detail.valid || !detail.review.isLatest || detail.channel !== 'sms' || !TWILIO_SMS_GSM_BASIC_TEXT.test(detail.payload.bodyText)
        || detail.payload.bodyText.includes('{{') || detail.payload.bodyText.includes('}}') || detail.payload.bodyText.length > 1530) throw new MhpCommerceError(409, 'Use a current MHP text with plain characters and no placeholders for this owned test.');
    return detail;
  }
  async save(identity: PortalSessionIdentity, requestId: string, input: { commandId: string; bodyText: string; itemId: string; previousVersionId: string }) {
    await this.#context(identity, requestId);
    if (!TWILIO_SMS_GSM_BASIC_TEXT.test(input.bodyText) || input.bodyText.includes('{{') || input.bodyText.includes('}}') || input.bodyText.length > 1530) throw new MhpCommerceError(400, 'Use plain SMS characters and no placeholders for this owned test.');
    return this.dependencies.messages.save(identity, requestId, input.commandId, { channel: 'sms', title: 'MHP owned-phone test',
      contentItemId: input.itemId, previousVersionId: input.previousVersionId, payload: { schema: 'growthhq.sms-draft/v1', bodyText: input.bodyText } });
  }
  async send(identity: PortalSessionIdentity, requestId: string, input: { commandId: string; itemId: string; versionId: string; pointId: string; sha256: string; agreed: boolean }, now = Date.now()): Promise<MhpOwnedSmsSendResult> {
    const context = await this.#context(identity, requestId), { config, repository } = this.#ready();
    if (!UUID.test(input.commandId) || !UUID.test(input.itemId) || !UUID.test(input.versionId) || !UUID.test(input.pointId) || !SHA.test(input.sha256) || !input.agreed) throw new MhpCommerceError(400, 'Review the exact text and agree to the one-message MHP test.');
    const command = { commandId: input.commandId, bindingId: config.bindingId, contactId: config.contactId,
      pointId: input.pointId, versionId: input.versionId, sha256: input.sha256 };
    const previous = await repository.lookup(context, identity, command);
    if (previous) return previous;
    const detail = await this.review(identity, requestId, input.itemId, input.versionId);
    if (detail.review.contentSha256 !== input.sha256) throw new MhpCommerceError(409, 'The reviewed text changed. Refresh before sending.');
    await this.dependencies.observe(context, detail, input.commandId, now);
    await this.dependencies.messages.publish(identity, requestId, 'sms', input.itemId, input.versionId, input.commandId, now);
    return repository.send(context, identity, command);
  }
}
export type MhpOwnedSmsSnapshot = Awaited<ReturnType<MhpOwnedSmsService['snapshot']>>;
