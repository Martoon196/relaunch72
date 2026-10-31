import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { withTransaction } from '../db/transaction.js';
import type { DatabaseRequestContext } from '../db/rls.js';
import type { PortalSessionIdentity } from '../portal/auth-service.js';
import type { FlowMessageReview, LocalFlowMessages } from '../followup-sequences/messages.js';
import { FOLLOWUP_SEQUENCE_UUID as UUID } from '../followup-sequences/definition.js';
import { MhpCommerceError } from './commerce-service.js';
import { MHP_MARKETING_WORKSPACE_ID, type PgMhpMarketingWorkspaceService } from './marketing-workspace-service.js';

export const MHP_OWNED_WHATSAPP_PERMISSION = 'I agree to receive one Martin Howard Property test WhatsApp message on my own number. This does not subscribe me to future WhatsApp or SMS.';
const META_ID = /^[1-9][0-9]{4,29}$/u;
const UK = /^\+44[0-9]{9,10}$/u;
const HEX64 = /^[0-9a-f]{64}$/u;
const sha256 = (value: string | Buffer): Buffer => createHash('sha256').update(value).digest();

export interface MhpOwnedWhatsAppConfig { readonly ownerUserId: string; readonly contactId: string; readonly phone: string; readonly workerLive?: boolean }
/** Reuses the owner's already-verified SMS pilot number; WhatsApp has its own switch. */
export function mhpOwnedWhatsAppConfig(env: NodeJS.ProcessEnv): { enabled: boolean; config: MhpOwnedWhatsAppConfig | null; blockers: readonly string[] } {
  if (env.MHP_WHATSAPP_PILOT_ENABLED !== 'true') return { enabled: false, config: null, blockers: ['The MHP WhatsApp pilot is not enabled.'] };
  const ownerUserId = env.MHP_SMS_PILOT_OWNER_USER_ID?.trim() ?? '', contactId = env.MHP_SMS_PILOT_CONTACT_ID?.trim() ?? '', phone = env.MHP_SMS_PILOT_PHONE?.trim() ?? '';
  const valid = UUID.test(ownerUserId) && UUID.test(contactId) && UK.test(phone);
  // A queued test has a 4-minute authority; sending while the worker is dark would
  // burn one of the 3 monthly slots for nothing. The operator attests it is live.
  const workerLive = env.MHP_WHATSAPP_WORKER_LIVE_CONFIRMED === 'true';
  return { enabled: true, config: valid ? { ownerUserId, contactId, phone, workerLive } : null,
    blockers: [...(valid ? [] : ['The owner number from the MHP SMS pilot settings is needed.']),
      ...(workerLive ? [] : ['Sending waits until the MHP WhatsApp worker is live (MHP_WHATSAPP_WORKER_LIVE_CONFIRMED=true).'])] };
}

/** Non-secret output of the off-web seal CLI. The token itself never reaches the web process. */
export interface MhpWhatsAppSealedEnvelope {
  schema: 'mhp.whatsapp-sealed-binding/v1'; connectionId: string; bindingId: string; appId: string; wabaId: string; phoneNumberId: string;
  keyVersion: string; ivBase64: string; ciphertextBase64: string; authTagBase64: string; aadSha256: string; secretPayloadSha256: string;
}
export function parseMhpWhatsAppEnvelope(text: string): MhpWhatsAppSealedEnvelope {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new MhpCommerceError(400, 'Paste the exact sealed connection text from the seal tool.'); }
  const v = value as Record<string, unknown>;
  const keys = ['aadSha256', 'appId', 'authTagBase64', 'bindingId', 'ciphertextBase64', 'connectionId', 'ivBase64', 'keyVersion', 'phoneNumberId', 'schema', 'secretPayloadSha256', 'wabaId'];
  const b64 = (s: unknown, min: number, max: number) => typeof s === 'string' && /^[A-Za-z0-9+/]+={0,2}$/u.test(s) && Buffer.from(s, 'base64').length >= min && Buffer.from(s, 'base64').length <= max;
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).sort().join() !== keys.join() || v.schema !== 'mhp.whatsapp-sealed-binding/v1'
      || !UUID.test(String(v.connectionId)) || !UUID.test(String(v.bindingId)) || ![v.appId, v.wabaId, v.phoneNumberId].every(id => META_ID.test(String(id)))
      || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(String(v.keyVersion)) || !b64(v.ivBase64, 12, 12) || !b64(v.ciphertextBase64, 38, 8192)
      || !b64(v.authTagBase64, 16, 16) || !HEX64.test(String(v.aadSha256)) || !HEX64.test(String(v.secretPayloadSha256))) {
    throw new MhpCommerceError(400, 'Paste the exact sealed connection text from the seal tool.');
  }
  return v as unknown as MhpWhatsAppSealedEnvelope;
}

export interface MhpOwnedWhatsAppDatabaseSnapshot {
  bindingId: string | null; connectionId: string | null; senderNumber: string | null; wabaId: string | null; phoneNumberId: string | null;
  templates: readonly { templateId: string; name: string; language: string; category: string; contentVersionId: string }[];
  possessionProven: boolean; whatsappPointId: string | null; whatsappPointVerified: boolean; suppressed: boolean;
  lastResult: { jobId: string; state: string; replayed: boolean } | null;
}
export interface MhpOwnedWhatsAppSendResult { jobId: string; commandId: string; templateId: string; state: string; replayed: boolean; authorityExpiresAt: string }

function failure(error: unknown): never {
  if (error instanceof MhpCommerceError) throw error;
  const code = error && typeof error === 'object' && 'code' in error ? (error as { code?: unknown }).code : undefined;
  const message = error && typeof error === 'object' && 'message' in error ? String((error as { message: unknown }).message) : '';
  if (code === '42501' && message.includes('hard send cap')) throw new MhpCommerceError(409, 'WhatsApp allows one test a day and three a month on this number. Try again tomorrow.');
  if (code === '42501' && message.includes('Verify your own number')) throw new MhpCommerceError(409, 'Verify your own number on the phone test page first.');
  if (code === '42501' && message.includes('opt-out')) throw new MhpCommerceError(409, 'WhatsApp is blocked by an opt-out on this number.');
  if (code === '42501' && message.includes('format the rail cannot honour')) throw new MhpCommerceError(409, 'A CRM WhatsApp entry for this number must be removed before the test.');
  if (code === '42501') throw new MhpCommerceError(403, 'This MHP owner session, sender or permission is not authorised.');
  if (code === '23505' && message.includes('already connected')) throw new MhpCommerceError(409, 'The MHP WhatsApp sender is already connected.');
  if (code === '23505') throw new MhpCommerceError(409, 'That template or step is already recorded. Refresh the page.');
  if (code === '40001' || code === '23514') throw new MhpCommerceError(409, 'Something changed since you looked. Refresh and review again.');
  throw new MhpCommerceError(503, 'The WhatsApp step could not complete. Refresh its recorded status before trying again.');
}

export interface MhpOwnedWhatsAppRepository {
  snapshot(context: DatabaseRequestContext, identity: PortalSessionIdentity, config: MhpOwnedWhatsAppConfig): Promise<MhpOwnedWhatsAppDatabaseSnapshot>;
  connect(context: DatabaseRequestContext, identity: PortalSessionIdentity, input: { commandId: string; envelope: MhpWhatsAppSealedEnvelope; senderNumber: string; ownershipEvidence: string }): Promise<{ bindingId: string; replayed: boolean }>;
  recordTemplate(context: DatabaseRequestContext, identity: PortalSessionIdentity, input: { commandId: string; bindingId: string; templateId: string;
    versionId: string; sha256: string; category: 'utility' | 'marketing'; metaTemplateId: string; approvalReference: string }): Promise<{ templateId: string; replayed: boolean }>;
  send(context: DatabaseRequestContext, identity: PortalSessionIdentity, input: { commandId: string; bindingId: string; templateId: string; agreed: boolean },
    config: MhpOwnedWhatsAppConfig, lookupOnly: boolean): Promise<MhpOwnedWhatsAppSendResult | null>;
}
export class PgMhpOwnedWhatsAppRepository implements MhpOwnedWhatsAppRepository {
  constructor(private readonly commandPool: Pick<Pool, 'connect'>) {}
  async #one<T>(context: DatabaseRequestContext, sql: string, values: unknown[], options: { readOnly?: boolean; isolation?: 'read committed' | 'serializable' } = {}): Promise<T> {
    try {
      return await withTransaction(this.commandPool, context, async tx => {
        const result = await tx.query<{ v: T }>(sql, values);
        if (result.rows.length !== 1 || result.rows[0]?.v === null || result.rows[0]?.v === undefined) throw new Error('Invalid WhatsApp result');
        return result.rows[0].v;
      }, options);
    } catch (error) { return failure(error); }
  }
  snapshot(context: DatabaseRequestContext, identity: PortalSessionIdentity, config: MhpOwnedWhatsAppConfig) {
    return this.#one<MhpOwnedWhatsAppDatabaseSnapshot>(context, 'SELECT app_private.mhp_whatsapp_snapshot($1,$2,$3) AS v',
      [sha256(identity.sessionToken), config.contactId, config.phone], { readOnly: true });
  }
  async connect(context: DatabaseRequestContext, identity: PortalSessionIdentity, input: { commandId: string; envelope: MhpWhatsAppSealedEnvelope; senderNumber: string; ownershipEvidence: string }) {
    const e = input.envelope;
    const v = await this.#one<{ bindingId: string; replayed: boolean }>(context,
      'SELECT app_private.mhp_whatsapp_connect($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,true) AS v',
      [sha256(identity.sessionToken), input.commandId, e.connectionId, e.bindingId, e.appId, e.wabaId, e.phoneNumberId, input.senderNumber, e.keyVersion,
        Buffer.from(e.ivBase64, 'base64'), Buffer.from(e.ciphertextBase64, 'base64'), Buffer.from(e.authTagBase64, 'base64'),
        Buffer.from(e.aadSha256, 'hex'), Buffer.from(e.secretPayloadSha256, 'hex'), input.ownershipEvidence]);
    if (v.bindingId !== e.bindingId) return failure(new Error('Unexpected binding'));
    return v;
  }
  async recordTemplate(context: DatabaseRequestContext, identity: PortalSessionIdentity, input: { commandId: string; bindingId: string; templateId: string;
    versionId: string; sha256: string; category: 'utility' | 'marketing'; metaTemplateId: string; approvalReference: string }) {
    return this.#one<{ templateId: string; replayed: boolean }>(context, 'SELECT app_private.mhp_whatsapp_record_template($1,$2,$3,$4,$5,$6,$7,$8,$9,true) AS v',
      [sha256(identity.sessionToken), input.commandId, input.bindingId, input.templateId, input.versionId, Buffer.from(input.sha256, 'hex'),
        input.category, input.metaTemplateId, input.approvalReference]);
  }
  async send(context: DatabaseRequestContext, identity: PortalSessionIdentity, input: { commandId: string; bindingId: string; templateId: string; agreed: boolean },
    config: MhpOwnedWhatsAppConfig, lookupOnly: boolean) {
    const v = await this.#one<MhpOwnedWhatsAppSendResult | { not_started: true }>(context, 'SELECT app_private.mhp_owned_whatsapp_send($1,$2,$3,$4,$5,$6,$7,$8) AS v',
      [sha256(identity.sessionToken), input.commandId, input.bindingId, input.templateId, config.contactId, config.phone, input.agreed, lookupOnly],
      { isolation: lookupOnly ? 'serializable' : 'read committed' });
    if ('not_started' in v) return lookupOnly ? null : failure(new Error('Owned WhatsApp test did not start'));
    if (!UUID.test(v.jobId) || v.commandId !== input.commandId) return failure(new Error('Invalid owned WhatsApp result'));
    return v;
  }
}

type Messages = Pick<LocalFlowMessages, 'choices' | 'review' | 'publish'>;
export interface MhpOwnedWhatsAppDependencies {
  readonly marketingWorkspace: Pick<PgMhpMarketingWorkspaceService, 'snapshot'>;
  authorize(identity: PortalSessionIdentity, requestId: string): Promise<DatabaseRequestContext>;
  readonly config: MhpOwnedWhatsAppConfig | null; readonly blockers: readonly string[];
  readonly repository?: MhpOwnedWhatsAppRepository;
  readonly messages: Messages;
}
export class MhpOwnedWhatsAppService {
  constructor(private readonly dependencies: MhpOwnedWhatsAppDependencies) {}
  async #context(identity: PortalSessionIdentity, requestId: string): Promise<DatabaseRequestContext> {
    const snapshot = await this.dependencies.marketingWorkspace.snapshot(identity);
    if (!snapshot.marketingSelected || snapshot.marketingWorkspaceId !== MHP_MARKETING_WORKSPACE_ID
        || snapshot.userId !== identity.userId || snapshot.selectedWorkspaceId !== identity.workspaceId) throw new MhpCommerceError(403, 'Open the MHP marketing workspace using your owner login.');
    if (this.dependencies.config && identity.userId !== this.dependencies.config.ownerUserId) throw new MhpCommerceError(403, 'The WhatsApp pilot is available to the configured MHP owner only.');
    const context = await this.dependencies.authorize(identity, requestId);
    if (context.workspaceId !== MHP_MARKETING_WORKSPACE_ID || context.userId !== identity.userId || context.actorKind !== 'user') throw new MhpCommerceError(403, 'Refresh your MHP owner login.');
    return context;
  }
  #ready(): { config: MhpOwnedWhatsAppConfig; repository: MhpOwnedWhatsAppRepository } {
    const { config, repository } = this.dependencies;
    if (!config || !repository) throw new MhpCommerceError(503, 'MHP WhatsApp configuration is incomplete.');
    return { config, repository };
  }
  async #review(identity: PortalSessionIdentity, requestId: string, itemId: string, versionId: string): Promise<FlowMessageReview> {
    if (!UUID.test(itemId) || !UUID.test(versionId)) throw new MhpCommerceError(400, 'Choose an exact saved WhatsApp template draft.');
    const detail = await this.dependencies.messages.review(identity, requestId, 'whatsapp', itemId, versionId);
    const payload = detail.payload as { templateName?: string; language?: string; bodyText?: string };
    if (!detail.valid || !detail.review.isLatest || detail.channel !== 'whatsapp' || /\{\{[0-9]+\}\}/u.test(payload.bodyText ?? '')) {
      throw new MhpCommerceError(409, 'Use a current saved WhatsApp template draft with no {{1}}-style parameters.');
    }
    return detail;
  }
  async snapshot(identity: PortalSessionIdentity, requestId: string, chosen?: { itemId: string; versionId: string }) {
    const context = await this.#context(identity, requestId);
    const database = this.dependencies.config && this.dependencies.repository
      ? await this.dependencies.repository.snapshot(context, identity, this.dependencies.config) : null;
    const detail = chosen ? await this.#review(identity, requestId, chosen.itemId, chosen.versionId) : undefined;
    const choices = (await this.dependencies.messages.choices(identity, requestId)).filter(message => message.channel === 'whatsapp');
    return { database, detail, choices, blockers: [...this.dependencies.blockers], phone: this.dependencies.config?.phone ?? null };
  }
  async connect(identity: PortalSessionIdentity, requestId: string, input: { commandId: string; envelopeText: string; senderNumber: string; ownershipEvidence: string; confirmed: boolean }) {
    const context = await this.#context(identity, requestId), { repository } = this.#ready();
    if (!UUID.test(input.commandId) || !input.confirmed) throw new MhpCommerceError(400, 'Confirm the MHP WhatsApp sender ownership.');
    if (!UK.test(input.senderNumber.trim())) throw new MhpCommerceError(400, 'Enter the MHP WhatsApp sender as +44 followed by the number.');
    const evidence = input.ownershipEvidence.trim();
    if (evidence.length < 8 || evidence.length > 500) throw new MhpCommerceError(400, 'Describe where the sender ownership is recorded (8 to 500 characters).');
    return repository.connect(context, identity, { commandId: input.commandId, envelope: parseMhpWhatsAppEnvelope(input.envelopeText), senderNumber: input.senderNumber.trim(), ownershipEvidence: evidence });
  }
  /** Approve the exact draft if needed, then pin it as the Meta-approved template. */
  async recordTemplate(identity: PortalSessionIdentity, requestId: string, input: { commandId: string; templateId: string; itemId: string; versionId: string;
    sha256: string; category: string; metaTemplateId: string; approvalReference: string; confirmed: boolean; contentApproved: boolean }, now = Date.now()) {
    const context = await this.#context(identity, requestId), { repository, config } = this.#ready();
    if (!UUID.test(input.commandId) || !UUID.test(input.templateId) || !HEX64.test(input.sha256) || !input.confirmed || !input.contentApproved
        || (input.category !== 'utility' && input.category !== 'marketing') || !META_ID.test(input.metaTemplateId)
        || input.approvalReference.trim().length < 8 || input.approvalReference.trim().length > 500) {
      throw new MhpCommerceError(400, 'Enter the Meta template ID and approval reference, and confirm Meta shows it Approved.');
    }
    const snapshot = await repository.snapshot(context, identity, config);
    if (!snapshot.bindingId) throw new MhpCommerceError(409, 'Connect the MHP WhatsApp sender first.');
    const detail = await this.#review(identity, requestId, input.itemId, input.versionId);
    if (detail.review.contentSha256 !== input.sha256) throw new MhpCommerceError(409, 'The draft changed. Refresh before pinning it.');
    if (detail.review.approvalStatus !== 'approved' || detail.review.approvalStale) {
      await this.dependencies.messages.publish(identity, requestId, 'whatsapp', input.itemId, input.versionId, input.commandId, now);
    }
    return repository.recordTemplate(context, identity, { commandId: input.commandId, bindingId: snapshot.bindingId, templateId: input.templateId,
      versionId: input.versionId, sha256: input.sha256, category: input.category, metaTemplateId: input.metaTemplateId, approvalReference: input.approvalReference.trim() });
  }
  async send(identity: PortalSessionIdentity, requestId: string, input: { commandId: string; templateId: string; agreed: boolean }) {
    const context = await this.#context(identity, requestId), { repository, config } = this.#ready();
    if (!UUID.test(input.commandId) || !UUID.test(input.templateId) || !input.agreed) throw new MhpCommerceError(400, 'Tick the one-test agreement first.');
    if (!config.workerLive) throw new MhpCommerceError(409, 'Switch the MHP WhatsApp worker live before sending, so the test is not wasted.');
    const snapshot = await repository.snapshot(context, identity, config);
    if (!snapshot.bindingId) throw new MhpCommerceError(409, 'Connect the MHP WhatsApp sender first.');
    const command = { commandId: input.commandId, bindingId: snapshot.bindingId, templateId: input.templateId, agreed: input.agreed };
    const previous = await repository.send(context, identity, command, config, true);
    if (previous) return previous;
    const sent = await repository.send(context, identity, command, config, false);
    if (!sent) throw new MhpCommerceError(503, 'The test was not started. Refresh its recorded status.');
    return sent;
  }
}
export type MhpOwnedWhatsAppSnapshot = Awaited<ReturnType<MhpOwnedWhatsAppService['snapshot']>>;
