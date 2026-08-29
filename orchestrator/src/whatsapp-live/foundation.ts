import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const META_ID = /^[1-9][0-9]{4,29}$/u;
const E164 = /^[1-9][0-9]{6,14}$/u;
const MESSAGE_ID = /^wamid\.[A-Za-z0-9_=-]{1,190}$/u;
const TEMPLATE = /^[a-z][a-z0-9_]{0,511}$/u;
const LANGUAGE = /^[a-z]{2,3}(?:_[A-Z]{2})?$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_SECRET = /^[\x21-\x7e]{20,2000}$/u;
const MAX_RESPONSE_BYTES = 65_536;
const MAX_WEBHOOK_BYTES = 256 * 1024;
const GRAPH_ORIGIN = 'https://graph.facebook.com';

export const META_WHATSAPP_LIVE_CONTRACT =
  'propertypredator.meta-whatsapp-live/v1' as const;

export class MetaWhatsAppLiveError extends Error {
  constructor(readonly code:
    | 'disabled'
    | 'invalid_configuration'
    | 'invalid_binding'
    | 'invalid_request'
    | 'signature_invalid'
    | 'webhook_invalid'
    | 'provider_response_invalid'
    | 'provider_outcome_unknown') {
    super(`Meta WhatsApp live rail failed: ${code}`);
    this.name = 'MetaWhatsAppLiveError';
  }
}

function fail(code: MetaWhatsAppLiveError['code']): never {
  throw new MetaWhatsAppLiveError(code);
}

function exactUuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) fail('invalid_binding');
  return value;
}

function platformId(value: unknown): string {
  if (typeof value !== 'string' || !META_ID.test(value)) fail('invalid_binding');
  return value;
}

function hash(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export interface MetaWhatsAppBinding {
  readonly workspaceId: string;
  readonly connectionId: string;
  readonly appId: string;
  readonly wabaId: string;
  readonly phoneNumberId: string;
  readonly graphApiVersion: 'v24.0';
}

export interface MetaWhatsAppSecrets {
  readonly accessToken: string;
  readonly appSecret: string;
  readonly verifyToken: string;
}

export interface MetaWhatsAppCredentialEnvelope {
  readonly algorithm: 'aes-256-gcm-v1';
  readonly keyVersion: string;
  readonly ivBase64: string;
  readonly ciphertextBase64: string;
  readonly authTagBase64: string;
  readonly aadSha256: string;
  readonly secretPayloadSha256: string;
}

function snapshotBinding(input: MetaWhatsAppBinding): MetaWhatsAppBinding {
  if (input.graphApiVersion !== 'v24.0') fail('invalid_binding');
  return Object.freeze({
    workspaceId: exactUuid(input.workspaceId),
    connectionId: exactUuid(input.connectionId),
    appId: platformId(input.appId),
    wabaId: platformId(input.wabaId),
    phoneNumberId: platformId(input.phoneNumberId),
    graphApiVersion: 'v24.0',
  });
}

function bindingAad(input: MetaWhatsAppBinding): Buffer {
  const binding = snapshotBinding(input);
  return Buffer.from(JSON.stringify({
    contract: META_WHATSAPP_LIVE_CONTRACT,
    ...binding,
    providerId: 'meta_whatsapp_cloud',
    channel: 'whatsapp',
  }), 'utf8');
}

function snapshotSecrets(input: MetaWhatsAppSecrets): MetaWhatsAppSecrets {
  if (!SAFE_SECRET.test(input.accessToken) || !SAFE_SECRET.test(input.appSecret)
      || !SAFE_SECRET.test(input.verifyToken)) fail('invalid_configuration');
  return Object.freeze({ ...input });
}

function exactBase64(value: unknown, length?: number): Buffer {
  if (typeof value !== 'string' || value.length < 4 || value.length > 16_384
      || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) fail('invalid_binding');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value || (length !== undefined && bytes.length !== length)) {
    fail('invalid_binding');
  }
  return bytes;
}

export function encryptMetaWhatsAppCredentials(input: Readonly<{
  binding: MetaWhatsAppBinding;
  secrets: MetaWhatsAppSecrets;
  encryptionKey: Buffer;
  keyVersion: string;
  iv?: Buffer;
}>): MetaWhatsAppCredentialEnvelope {
  const binding = snapshotBinding(input.binding);
  const secrets = snapshotSecrets(input.secrets);
  if (input.encryptionKey.length !== 32
      || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(input.keyVersion)) {
    fail('invalid_configuration');
  }
  const iv = input.iv ? Buffer.from(input.iv) : randomBytes(12);
  if (iv.length !== 12) fail('invalid_configuration');
  const aad = bindingAad(binding);
  const plaintext = Buffer.from(JSON.stringify(secrets), 'utf8');
  const cipher = createCipheriv('aes-256-gcm', input.encryptionKey, iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Object.freeze({
    algorithm: 'aes-256-gcm-v1', keyVersion: input.keyVersion,
    ivBase64: iv.toString('base64'), ciphertextBase64: ciphertext.toString('base64'),
    authTagBase64: cipher.getAuthTag().toString('base64'),
    aadSha256: hash(aad), secretPayloadSha256: hash(plaintext),
  });
}

export function decryptMetaWhatsAppCredentials(input: Readonly<{
  binding: MetaWhatsAppBinding;
  envelope: MetaWhatsAppCredentialEnvelope;
  encryptionKey: Buffer;
  expectedKeyVersion: string;
}>): MetaWhatsAppSecrets {
  const envelope = input.envelope;
  if (envelope.algorithm !== 'aes-256-gcm-v1'
      || envelope.keyVersion !== input.expectedKeyVersion || input.encryptionKey.length !== 32
      || !SHA256.test(envelope.aadSha256) || !SHA256.test(envelope.secretPayloadSha256)) {
    fail('invalid_binding');
  }
  const aad = bindingAad(input.binding);
  if (!timingSafeEqual(Buffer.from(hash(aad), 'hex'), Buffer.from(envelope.aadSha256, 'hex'))) {
    fail('invalid_binding');
  }
  try {
    const decipher = createDecipheriv(
      'aes-256-gcm', input.encryptionKey, exactBase64(envelope.ivBase64, 12),
    );
    decipher.setAAD(aad);
    decipher.setAuthTag(exactBase64(envelope.authTagBase64, 16));
    const plaintext = Buffer.concat([
      decipher.update(exactBase64(envelope.ciphertextBase64)), decipher.final(),
    ]);
    if (!timingSafeEqual(
      Buffer.from(hash(plaintext), 'hex'), Buffer.from(envelope.secretPayloadSha256, 'hex'),
    )) fail('invalid_binding');
    const parsed: unknown = JSON.parse(plaintext.toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) fail('invalid_binding');
    const record = parsed as Record<string, unknown>;
    if (Object.keys(record).sort().join(',') !== 'accessToken,appSecret,verifyToken') fail('invalid_binding');
    return snapshotSecrets(record as unknown as MetaWhatsAppSecrets);
  } catch (error) {
    if (error instanceof MetaWhatsAppLiveError) throw error;
    fail('invalid_binding');
  }
}

export interface MetaWhatsAppLiveRuntimeConfig {
  readonly mode: 'disabled' | 'owned_template_live';
  readonly providerEffectsEnabled: boolean;
  readonly emergencyPaused: boolean;
  readonly maximumOperationsPerCycle: 1;
  readonly maximumRecipientsPerJob: 1;
  readonly maximumTemplatesPerJob: 1;
  readonly dailySendCap: 1;
  readonly monthlySendCap: 3;
}

export function loadMetaWhatsAppLiveRuntimeConfig(env: NodeJS.ProcessEnv): MetaWhatsAppLiveRuntimeConfig {
  const mode = env.PROPERTY_PREDATOR_WHATSAPP_LIVE_MODE ?? 'disabled';
  const effects = env.PROPERTY_PREDATOR_PROVIDER_EFFECTS_ENABLED === 'true';
  const paused = env.PROPERTY_PREDATOR_WHATSAPP_EMERGENCY_PAUSED !== 'false';
  if (mode === 'disabled') {
    if (effects || !paused) fail('invalid_configuration');
    return Object.freeze({ mode, providerEffectsEnabled: false, emergencyPaused: true,
      maximumOperationsPerCycle: 1, maximumRecipientsPerJob: 1,
      maximumTemplatesPerJob: 1, dailySendCap: 1, monthlySendCap: 3 });
  }
  if (mode !== 'owned_template_live' || !effects || paused
      || env.PROPERTY_PREDATOR_WHATSAPP_LIVE_PROVIDER_ID !== 'meta_whatsapp_cloud') {
    fail('invalid_configuration');
  }
  return Object.freeze({ mode, providerEffectsEnabled: true, emergencyPaused: false,
    maximumOperationsPerCycle: 1, maximumRecipientsPerJob: 1,
    maximumTemplatesPerJob: 1, dailySendCap: 1, monthlySendCap: 3 });
}

export interface MetaWhatsAppTemplateDispatch {
  readonly binding: MetaWhatsAppBinding;
  readonly recipient: string;
  readonly templateName: string;
  readonly languageCode: string;
  readonly operationId: string;
  readonly requestSha256: string;
}

export type MetaWhatsAppDispatchResult = Readonly<{
  state: 'accepted' | 'failed' | 'outcome_unknown';
  providerMessageId: string | null;
  receiptSha256: string;
  safeCode: string;
  occurredAt: string;
}>;

export interface MetaWhatsAppLiveTransport {
  readonly contract: typeof META_WHATSAPP_LIVE_CONTRACT;
  readonly executionMode: 'owned_template_live';
  sendTemplate(input: MetaWhatsAppTemplateDispatch): Promise<MetaWhatsAppDispatchResult>;
}

async function boundedResponse(response: Response): Promise<string> {
  const declared = response.headers.get('content-length');
  if (declared && (!/^\d+$/u.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) {
    fail('provider_response_invalid');
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      fail('provider_response_invalid');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function createMetaWhatsAppLiveTransport(options: Readonly<{
  binding: MetaWhatsAppBinding;
  secrets: MetaWhatsAppSecrets;
  fetch: typeof fetch;
  providerEffectsEnabled: true;
  emergencyPaused: false;
  timeoutMs?: number;
  now?: () => Date;
}>): MetaWhatsAppLiveTransport {
  const bound = snapshotBinding(options.binding);
  const secrets = snapshotSecrets(options.secrets);
  if (typeof options.fetch !== 'function' || options.providerEffectsEnabled !== true
      || options.emergencyPaused !== false) fail('invalid_configuration');
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 30_000) {
    fail('invalid_configuration');
  }
  const now = options.now ?? (() => new Date());
  return Object.freeze({
    contract: META_WHATSAPP_LIVE_CONTRACT,
    executionMode: 'owned_template_live' as const,
    async sendTemplate(input: MetaWhatsAppTemplateDispatch): Promise<MetaWhatsAppDispatchResult> {
      if (JSON.stringify(snapshotBinding(input.binding)) !== JSON.stringify(bound)
          || !E164.test(input.recipient) || !TEMPLATE.test(input.templateName)
          || !LANGUAGE.test(input.languageCode) || !UUID.test(input.operationId)
          || !SHA256.test(input.requestSha256)) fail('invalid_request');
      const url = `${GRAPH_ORIGIN}/${bound.graphApiVersion}/${bound.phoneNumberId}/messages`;
      const body = JSON.stringify({
        messaging_product: 'whatsapp', to: input.recipient, type: 'template',
        template: { name: input.templateName, language: { code: input.languageCode } },
      });
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let status: number;
      let responseBody: string;
      try {
        const response = await options.fetch(url, {
          method: 'POST', redirect: 'error', signal: controller.signal,
          headers: { Accept: 'application/json', Authorization: `Bearer ${secrets.accessToken}`,
            'Content-Type': 'application/json' }, body,
        });
        status = response.status;
        responseBody = await boundedResponse(response);
      } catch (error) {
        if (error instanceof MetaWhatsAppLiveError) throw error;
        return Object.freeze({ state: 'outcome_unknown', providerMessageId: null,
          receiptSha256: hash('transport_outcome_unknown'),
          safeCode: 'meta_transport_outcome_unknown', occurredAt: now().toISOString() });
      } finally { clearTimeout(timer); }
      const receiptSha256 = hash(responseBody);
      let parsed: Record<string, unknown> | null = null;
      try {
        const candidate: unknown = JSON.parse(responseBody);
        if (typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate)) {
          parsed = candidate as Record<string, unknown>;
        }
      } catch { /* bounded invalid JSON is unproven, never retried automatically */ }
      const messages = parsed?.messages;
      const contacts = parsed?.contacts;
      const contact = Array.isArray(contacts) && contacts.length === 1
        && typeof contacts[0] === 'object' && contacts[0] !== null
        ? contacts[0] as Record<string, unknown> : null;
      const responseInput = typeof contact?.input === 'string' && E164.test(contact.input)
        ? contact.input : null;
      const responseWaId = typeof contact?.wa_id === 'string' && E164.test(contact.wa_id)
        ? contact.wa_id : null;
      const candidate = Array.isArray(messages) && messages.length === 1
        && typeof messages[0] === 'object' && messages[0] !== null
        ? (messages[0] as Record<string, unknown>).id : null;
      const providerMessageId = typeof candidate === 'string' && MESSAGE_ID.test(candidate)
        ? candidate : null;
      if (status >= 200 && status < 300 && parsed?.messaging_product === 'whatsapp'
          && providerMessageId !== null && responseInput === input.recipient
          && responseWaId === input.recipient) return Object.freeze({
        state: 'accepted', providerMessageId, receiptSha256,
        safeCode: 'meta_whatsapp_accepted', occurredAt: now().toISOString(),
      });
      const ambiguous = status === 408 || status === 409 || status === 425
        || status === 429 || status >= 500;
      return Object.freeze({
        state: ambiguous || (status >= 200 && status < 300) ? 'outcome_unknown' : 'failed',
        providerMessageId, receiptSha256,
        safeCode: status >= 200 && status < 300
          ? 'meta_response_unproven'
          : ambiguous ? `meta_http_${status}_unknown` : `meta_http_${status}`,
        occurredAt: now().toISOString(),
      });
    },
  });
}

export function verifyMetaWhatsAppLiveChallenge(
  secrets: MetaWhatsAppSecrets,
  input: Readonly<{ mode: unknown; verifyToken: unknown; challenge: unknown }>,
): Readonly<{ status: 200 | 400 | 403; body: string }> {
  const exact = snapshotSecrets(secrets);
  if (input.mode !== 'subscribe' || typeof input.verifyToken !== 'string'
      || typeof input.challenge !== 'string' || !/^[\x21-\x7e]{1,200}$/u.test(input.challenge)) {
    return Object.freeze({ status: 400, body: '' });
  }
  const supplied = Buffer.from(input.verifyToken, 'utf8');
  const expected = Buffer.from(exact.verifyToken, 'utf8');
  return supplied.length === expected.length && timingSafeEqual(supplied, expected)
    ? Object.freeze({ status: 200, body: input.challenge })
    : Object.freeze({ status: 403, body: '' });
}

export type VerifiedMetaWhatsAppLiveEvent = Readonly<{
  kind: 'inbound';
  workspaceId: string;
  connectionId: string;
  externalEventId: string;
  providerMessageId: string;
  senderId: string;
  senderSha256: string;
  body: string;
  bodySha256: string;
  occurredAt: string;
}> | Readonly<{
  kind: 'status';
  workspaceId: string;
  connectionId: string;
  externalEventId: string;
  providerMessageId: string;
  recipientSha256: string;
  status: 'sent' | 'delivered' | 'read' | 'failed' | 'deleted';
  occurredAt: string;
}>;

const VERIFIED_EVENTS = new WeakSet<object>();

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail('webhook_invalid');
  return value as Record<string, unknown>;
}

function array(value: unknown, max: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length > max) fail('webhook_invalid');
  return value;
}

function unixTimestamp(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9]{10,13}$/u.test(value)) fail('webhook_invalid');
  const raw = Number(value);
  const milliseconds = value.length <= 10 ? raw * 1_000 : raw;
  if (!Number.isSafeInteger(milliseconds)) fail('webhook_invalid');
  return new Date(milliseconds).toISOString();
}

export function verifyMetaWhatsAppLiveWebhook(input: Readonly<{
  binding: MetaWhatsAppBinding;
  appSecret: string;
  rawBody: Uint8Array;
  xHubSignature256: unknown;
  contentType: unknown;
}>): Readonly<{ payloadSha256: string; events: readonly VerifiedMetaWhatsAppLiveEvent[] }> {
  const binding = snapshotBinding(input.binding);
  if (!SAFE_SECRET.test(input.appSecret) || !(input.rawBody instanceof Uint8Array)) {
    fail('invalid_configuration');
  }
  const raw = Uint8Array.from(input.rawBody);
  if (raw.length < 2 || raw.length > MAX_WEBHOOK_BYTES
      || typeof input.contentType !== 'string'
      || input.contentType.toLowerCase().split(';', 1)[0]?.trim() !== 'application/json') {
    fail('webhook_invalid');
  }
  const signatureMatch = typeof input.xHubSignature256 === 'string'
    ? /^sha256=([a-f0-9]{64})$/u.exec(input.xHubSignature256) : null;
  if (!signatureMatch) fail('signature_invalid');
  const expected = createHmac('sha256', input.appSecret).update(raw).digest();
  const supplied = Buffer.from(signatureMatch[1]!, 'hex');
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    fail('signature_invalid');
  }
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)); }
  catch { fail('webhook_invalid'); }
  const root = record(parsed);
  if (root.object !== 'whatsapp_business_account') fail('webhook_invalid');
  const events: VerifiedMetaWhatsAppLiveEvent[] = [];
  const fingerprints = new Map<string, string>();
  for (const entryValue of array(root.entry, 20)) {
    const entry = record(entryValue);
    if (platformId(entry.id) !== binding.wabaId) fail('invalid_binding');
    for (const changeValue of array(entry.changes, 20)) {
      const change = record(changeValue);
      if (change.field !== 'messages') continue;
      const value = record(change.value);
      if (value.messaging_product !== 'whatsapp') fail('webhook_invalid');
      const metadata = record(value.metadata);
      if (platformId(metadata.phone_number_id) !== binding.phoneNumberId) fail('invalid_binding');
      for (const messageValue of value.messages === undefined ? [] : array(value.messages, 100)) {
        const message = record(messageValue);
        if (message.type !== 'text' || typeof message.id !== 'string'
            || !MESSAGE_ID.test(message.id) || typeof message.from !== 'string'
            || !E164.test(message.from)) continue;
        const text = record(message.text).body;
        if (typeof text !== 'string' || text.length < 1 || Buffer.byteLength(text, 'utf8') > 16_384) {
          fail('webhook_invalid');
        }
        const occurredAt = unixTimestamp(message.timestamp);
        const event = Object.freeze({
          kind: 'inbound' as const, workspaceId: binding.workspaceId,
          connectionId: binding.connectionId, externalEventId: `inbound:${message.id}`,
          providerMessageId: message.id, senderId: message.from,
          senderSha256: hash(message.from), body: text, bodySha256: hash(text), occurredAt,
        });
        const fingerprint = hash(JSON.stringify(event));
        const prior = fingerprints.get(event.externalEventId);
        if (prior && prior !== fingerprint) fail('webhook_invalid');
        if (!prior) { fingerprints.set(event.externalEventId, fingerprint); VERIFIED_EVENTS.add(event); events.push(event); }
      }
      for (const statusValue of value.statuses === undefined ? [] : array(value.statuses, 100)) {
        const status = record(statusValue);
        if (typeof status.id !== 'string' || !MESSAGE_ID.test(status.id)
            || typeof status.recipient_id !== 'string' || !E164.test(status.recipient_id)
            || !['sent', 'delivered', 'read', 'failed', 'deleted'].includes(String(status.status))) {
          fail('webhook_invalid');
        }
        const occurredAt = unixTimestamp(status.timestamp);
        const event = Object.freeze({
          kind: 'status' as const, workspaceId: binding.workspaceId,
          connectionId: binding.connectionId,
          externalEventId: `status:${status.id}:${String(status.status)}:${occurredAt}`,
          providerMessageId: status.id, recipientSha256: hash(status.recipient_id),
          status: status.status as 'sent' | 'delivered' | 'read' | 'failed' | 'deleted', occurredAt,
        });
        const fingerprint = hash(JSON.stringify(event));
        const prior = fingerprints.get(event.externalEventId);
        if (prior && prior !== fingerprint) fail('webhook_invalid');
        if (!prior) { fingerprints.set(event.externalEventId, fingerprint); VERIFIED_EVENTS.add(event); events.push(event); }
      }
    }
  }
  return Object.freeze({ payloadSha256: hash(raw), events: Object.freeze(events) });
}

export interface MetaWhatsAppLiveWebhookCommandService {
  readonly workspaceId: string;
  readonly connectionId: string;
  recordStatus(input: Readonly<{
    event: Extract<VerifiedMetaWhatsAppLiveEvent, { kind: 'status' }>;
    payloadSha256: string;
  }>): Promise<'applied' | 'replayed' | 'conflict'>;
  recordInbound(input: Readonly<{
    event: Extract<VerifiedMetaWhatsAppLiveEvent, { kind: 'inbound' }>;
    payloadSha256: string;
    projection: 'conversion_inbox_and_lead360';
  }>): Promise<'applied' | 'replayed' | 'conflict'>;
}

export async function dispatchVerifiedMetaWhatsAppLiveEvents(input: Readonly<{
  verified: Readonly<{ payloadSha256: string; events: readonly VerifiedMetaWhatsAppLiveEvent[] }>;
  commandService: MetaWhatsAppLiveWebhookCommandService;
}>): Promise<Readonly<{ applied: number; replayed: number }>> {
  if (!SHA256.test(input.verified.payloadSha256)) fail('webhook_invalid');
  let applied = 0; let replayed = 0;
  for (const event of input.verified.events) {
    if (!VERIFIED_EVENTS.has(event as object)
        || event.workspaceId !== input.commandService.workspaceId
        || event.connectionId !== input.commandService.connectionId) fail('invalid_binding');
    const result = event.kind === 'status'
      ? await input.commandService.recordStatus({ event, payloadSha256: input.verified.payloadSha256 })
      : await input.commandService.recordInbound({ event, payloadSha256: input.verified.payloadSha256,
        projection: 'conversion_inbox_and_lead360' });
    if (result === 'conflict') fail('webhook_invalid');
    if (result === 'applied') applied += 1; else replayed += 1;
  }
  return Object.freeze({ applied, replayed });
}

export interface MetaWhatsAppLiveClaim {
  readonly workspaceId: string;
  readonly connectionId: string;
  readonly bindingId: string;
  readonly jobId: string;
  readonly leaseVersion: number;
}

export interface MetaWhatsAppLiveMaterial extends MetaWhatsAppLiveClaim {
  readonly binding: MetaWhatsAppBinding;
  readonly envelope: MetaWhatsAppCredentialEnvelope;
  readonly recipient: string;
  readonly templateName: string;
  readonly languageCode: string;
  readonly operationId: string;
  readonly requestSha256: string;
}

export interface MetaWhatsAppLiveRepository {
  claimOne(input: Readonly<{ leaseToken: Buffer; leaseSeconds: number }>): Promise<MetaWhatsAppLiveClaim | null>;
  loadClaimed(input: MetaWhatsAppLiveClaim & Readonly<{ leaseToken: Buffer }>): Promise<MetaWhatsAppLiveMaterial>;
  markCalling(input: MetaWhatsAppLiveClaim & Readonly<{
    leaseToken: Buffer; providerEffectsEnabled: true; emergencyPaused: false;
  }>): Promise<boolean>;
  settle(input: MetaWhatsAppLiveClaim & Readonly<{
    leaseToken: Buffer; result: MetaWhatsAppDispatchResult;
  }>): Promise<void>;
}

export async function runMetaWhatsAppLiveOnce(input: Readonly<{
  config: MetaWhatsAppLiveRuntimeConfig;
  repository: MetaWhatsAppLiveRepository;
  encryptionKey: Buffer;
  encryptionKeyVersion: string;
  leaseToken: Buffer;
  createTransport: (input: Readonly<{
    binding: MetaWhatsAppBinding; secrets: MetaWhatsAppSecrets;
    providerEffectsEnabled: true; emergencyPaused: false;
  }>) => MetaWhatsAppLiveTransport;
}>): Promise<'idle' | 'accepted' | 'failed_or_attention'> {
  if (input.config.mode !== 'owned_template_live' || !input.config.providerEffectsEnabled
      || input.config.emergencyPaused || input.leaseToken.length !== 32
      || input.encryptionKey.length !== 32) fail('disabled');
  const claim = await input.repository.claimOne({ leaseToken: input.leaseToken, leaseSeconds: 60 });
  if (!claim) return 'idle';
  const material = await input.repository.loadClaimed({ ...claim, leaseToken: input.leaseToken });
  if (material.workspaceId !== claim.workspaceId || material.connectionId !== claim.connectionId
      || material.bindingId !== claim.bindingId || material.jobId !== claim.jobId
      || material.leaseVersion !== claim.leaseVersion) fail('invalid_binding');
  const secrets = decryptMetaWhatsAppCredentials({ binding: material.binding,
    envelope: material.envelope, encryptionKey: input.encryptionKey,
    expectedKeyVersion: input.encryptionKeyVersion });
  if (!await input.repository.markCalling({ ...claim, leaseToken: input.leaseToken,
    providerEffectsEnabled: true, emergencyPaused: false })) return 'failed_or_attention';
  let result: MetaWhatsAppDispatchResult;
  try {
    const transport = input.createTransport({ binding: material.binding, secrets,
      providerEffectsEnabled: true, emergencyPaused: false });
    result = await transport.sendTemplate(material);
  }
  catch { result = Object.freeze({ state: 'outcome_unknown', providerMessageId: null,
    receiptSha256: hash('worker_transport_exception'), safeCode: 'worker_transport_outcome_unknown',
    occurredAt: new Date().toISOString() }); }
  await input.repository.settle({ ...claim, leaseToken: input.leaseToken, result });
  return result.state === 'accepted' ? 'accepted' : 'failed_or_attention';
}
