import { createHash } from 'node:crypto';
import { META_WHATSAPP_LIVE_CONTRACT, type MetaWhatsAppBinding, type MetaWhatsAppDispatchCredentialEnvelope } from '../whatsapp-live/foundation.js';
import type { WhatsAppOwnershipObservation } from '../whatsapp-live/ownership-client.js';

export const MHP_WHATSAPP_TARGET = Object.freeze({ workspaceId: '2789228d-55a6-4688-b1e8-2f70abca990b',
  appId: '1451249570430398', wabaId: '1874194210608511', phoneNumberId: '1412753418582729', senderNumber: '+447861935832' });
export interface MhpWhatsAppConnectionPacket {
  schema: 'mhp.whatsapp.sealed-connection/v1'; commandId: string; bindingId: string;
  binding: MetaWhatsAppBinding; senderNumber: string; envelope: MetaWhatsAppDispatchCredentialEnvelope;
  ownership: WhatsAppOwnershipObservation;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const sha = /^[0-9a-f]{64}$/u;
const invalid = (): never => { throw new Error('Invalid or expired MHP connection file'); };
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}
function keys(record: Record<string, unknown>, names: string[]): void {
  if (Object.keys(record).sort().join() !== names.sort().join()) invalid();
}
function base64(value: unknown, size?: number): void {
  if (typeof value !== 'string' || value.length > 8_192 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) invalid();
  const bytes = Buffer.from(value as string, 'base64');
  if (!bytes.length || bytes.toString('base64') !== value || (size !== undefined && bytes.length !== size)) invalid();
}
/** The web process accepts ciphertext only; it never receives the sealing key or token. */
export function parseMhpWhatsAppConnectionPacket(raw: string, expectedBindingId: string, now = Date.now()): MhpWhatsAppConnectionPacket {
  if (Buffer.byteLength(raw, 'utf8') > 12_288) invalid();
  let data: Record<string, unknown>;
  try { data = object(JSON.parse(raw)); } catch { return invalid(); }
  keys(data, ['schema', 'commandId', 'bindingId', 'binding', 'senderNumber', 'envelope', 'ownership']);
  if (data.schema !== 'mhp.whatsapp.sealed-connection/v1' || typeof data.commandId !== 'string' || !uuid.test(data.commandId)
      || !uuid.test(expectedBindingId) || data.bindingId !== expectedBindingId || data.senderNumber !== MHP_WHATSAPP_TARGET.senderNumber) invalid();
  const binding = object(data.binding);
  keys(binding, ['workspaceId', 'connectionId', 'appId', 'wabaId', 'phoneNumberId', 'graphApiVersion']);
  for (const key of ['workspaceId', 'appId', 'wabaId', 'phoneNumberId'] as const) if (binding[key] !== MHP_WHATSAPP_TARGET[key]) invalid();
  if (typeof binding.connectionId !== 'string' || !uuid.test(binding.connectionId) || binding.graphApiVersion !== 'v24.0') invalid();
  const e = object(data.envelope);
  keys(e, ['algorithm', 'keyVersion', 'ivBase64', 'ciphertextBase64', 'authTagBase64', 'aadSha256', 'secretPayloadSha256']);
  if (e.algorithm !== 'aes-256-gcm-v1' || typeof e.keyVersion !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(e.keyVersion)
      || typeof e.aadSha256 !== 'string' || !sha.test(e.aadSha256) || typeof e.secretPayloadSha256 !== 'string' || !sha.test(e.secretPayloadSha256)) invalid();
  base64(e.ivBase64, 12); base64(e.authTagBase64, 16); base64(e.ciphertextBase64);
  const aad = JSON.stringify({ contract: META_WHATSAPP_LIVE_CONTRACT, workspaceId: binding.workspaceId, connectionId: binding.connectionId,
    appId: binding.appId, wabaId: binding.wabaId, phoneNumberId: binding.phoneNumberId, graphApiVersion: binding.graphApiVersion,
    providerId: 'meta_whatsapp_cloud', channel: 'whatsapp' });
  if (createHash('sha256').update(aad).digest('hex') !== e.aadSha256) invalid();
  const ownership = object(data.ownership);
  keys(ownership, ['wabaId', 'phoneNumberId', 'normalizedNumber', 'observedAt']);
  const observed = typeof ownership.observedAt === 'string' ? Date.parse(ownership.observedAt) : NaN;
  if (ownership.wabaId !== binding.wabaId || ownership.phoneNumberId !== binding.phoneNumberId
      || ownership.normalizedNumber !== MHP_WHATSAPP_TARGET.senderNumber.slice(1)
      || !Number.isFinite(observed) || observed > now + 60_000 || observed < now - 900_000) invalid();
  return data as unknown as MhpWhatsAppConnectionPacket;
}
