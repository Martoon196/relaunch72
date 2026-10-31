/**
 * MHP009C off-web seal: turns the Meta access token into the non-secret envelope
 * the owner pastes into /hq/marketing/whatsapp. Runs only where the WhatsApp
 * worker's credential key lives. The token is read from stdin, never argv, and
 * is never printed. The output contains no secret.
 */
import { randomUUID } from 'node:crypto';
import { encryptMetaWhatsAppDispatchCredentials } from '../whatsapp-live/foundation.js';
import type { MhpWhatsAppSealedEnvelope } from '../mhp/owned-whatsapp-service.js';

export const MHP_WORKSPACE_ID = '2789228d-55a6-4688-b1e8-2f70abca990b';
const META_ID = /^[1-9][0-9]{4,29}$/u;

export function sealMhpWhatsAppBinding(input: { appId: string; wabaId: string; phoneNumberId: string; accessToken: string;
  encryptionKey: Buffer; keyVersion: string; connectionId?: string; bindingId?: string }): MhpWhatsAppSealedEnvelope {
  if (![input.appId, input.wabaId, input.phoneNumberId].every(id => META_ID.test(id))) throw new Error('Meta app, WABA and phone number ids must be numeric');
  if (!/^[A-Za-z0-9_-]{20,4096}$/u.test(input.accessToken)) throw new Error('The access token does not look like a Meta token');
  const connectionId = input.connectionId ?? randomUUID(), bindingId = input.bindingId ?? randomUUID();
  const envelope = encryptMetaWhatsAppDispatchCredentials({
    binding: { workspaceId: MHP_WORKSPACE_ID, connectionId, appId: input.appId, wabaId: input.wabaId, phoneNumberId: input.phoneNumberId, graphApiVersion: 'v24.0' },
    credentials: { accessToken: input.accessToken }, encryptionKey: input.encryptionKey, keyVersion: input.keyVersion,
  });
  return { schema: 'mhp.whatsapp-sealed-binding/v1', connectionId, bindingId, appId: input.appId, wabaId: input.wabaId, phoneNumberId: input.phoneNumberId,
    keyVersion: envelope.keyVersion, ivBase64: envelope.ivBase64, ciphertextBase64: envelope.ciphertextBase64, authTagBase64: envelope.authTagBase64,
    aadSha256: envelope.aadSha256, secretPayloadSha256: envelope.secretPayloadSha256 };
}

export function sealKeyFromEnvironment(env: NodeJS.ProcessEnv): { key: Buffer; version: string } {
  const raw = env.PROPERTY_PREDATOR_WHATSAPP_CREDENTIAL_ENCRYPTION_KEY_BASE64?.trim() ?? '', version = env.PROPERTY_PREDATOR_WHATSAPP_CREDENTIAL_KEY_VERSION?.trim() ?? '';
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32 || key.toString('base64') !== raw) throw new Error('PROPERTY_PREDATOR_WHATSAPP_CREDENTIAL_ENCRYPTION_KEY_BASE64 must be the worker\'s 32-byte key');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(version)) throw new Error('PROPERTY_PREDATOR_WHATSAPP_CREDENTIAL_KEY_VERSION is required');
  return { key, version };
}
