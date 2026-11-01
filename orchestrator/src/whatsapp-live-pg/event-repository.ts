/**
 * MHP009C worker adapter: a server-side Meta template read is the only template
 * evidence; due WhatsApp follow-ups are prepared into a fresh event authority +
 * one worker job, then sent through the unchanged 0053 template transport and
 * the shared 0053 settlement. Every call runs under the exact worker context.
 */

import { createHash } from 'node:crypto';
import type { Pool, QueryResultRow } from 'pg';
import { withTransaction } from '../db/transaction.js';
import {
  decryptMetaWhatsAppDispatchCredentials,
  type MetaWhatsAppBinding,
  type MetaWhatsAppDispatchCredentialEnvelope,
  type MetaWhatsAppDispatchCredentials,
  type MetaWhatsAppDispatchResult,
  type MetaWhatsAppLiveTransport,
} from '../whatsapp-live/foundation.js';

export const MHP_EVENT_WHATSAPP_WORKSPACE_ID = '2789228d-55a6-4688-b1e8-2f70abca990b';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const META_ID = /^[1-9][0-9]{4,29}$/u;
const TEMPLATE = /^[a-z][a-z0-9_]*$/u;
const LANGUAGE = /^[a-z]{2,3}(?:_[A-Z]{2})?$/u;
const E164 = /^[1-9][0-9]{6,14}$/u;
const sha = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');
function fail(label: string): never { throw new Error(`MHP event WhatsApp repository ${label}`); }

/** Canonical JSON (sorted keys) so the components digest is stable across Meta field ordering. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value as object).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(value);
}

export interface MetaTemplateObservation {
  readonly name: string; readonly language: string; readonly category: string; readonly status: string;
  readonly parameterCount: number; readonly bodySha256: string; readonly componentsSha256: string; readonly responseSha256: string;
}

/**
 * The exact template Meta holds now, read through this binding's own WABA
 * (GET /{waba-id}/message_templates), so a template ID visible to the token
 * but owned by another WABA can never count. Never throws for a provider
 * answer; null = unproven.
 */
export async function readMetaWhatsAppTemplate(input: Readonly<{ binding: MetaWhatsAppBinding; credentials: MetaWhatsAppDispatchCredentials;
  metaTemplateId: string; templateName: string; fetch: typeof fetch; timeoutMs?: number }>): Promise<MetaTemplateObservation | null> {
  if (!META_ID.test(input.metaTemplateId) || !TEMPLATE.test(input.templateName) || input.binding.graphApiVersion !== 'v24.0') fail('template read input is invalid');
  const url = `https://graph.facebook.com/${input.binding.graphApiVersion}/${input.binding.wabaId}/message_templates?name=${encodeURIComponent(input.templateName)}`
    + '&fields=id,name,language,status,category,components&limit=50';
  let text: string;
  try {
    const response = await input.fetch(url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(input.timeoutMs ?? 10_000),
      headers: { Accept: 'application/json', Authorization: `Bearer ${input.credentials.accessToken}` } });
    text = (await response.text()).slice(0, 65_536);
    if (!response.ok) return null;
  } catch { return null; }
  let parsed: Record<string, unknown>;
  try {
    const candidate: unknown = JSON.parse(text);
    const list = candidate && typeof candidate === 'object' && !Array.isArray(candidate) ? (candidate as { data?: unknown }).data : null;
    const match = Array.isArray(list) ? list.filter(t => t && typeof t === 'object' && (t as { id?: unknown }).id === input.metaTemplateId) : [];
    if (match.length !== 1) return null;
    parsed = match[0] as Record<string, unknown>;
  } catch { return null; }
  const components = Array.isArray(parsed.components) ? parsed.components as Record<string, unknown>[] : null;
  const bodyComponent = components?.find(c => c && c.type === 'BODY');
  const body = typeof bodyComponent?.text === 'string' ? bodyComponent.text : null;
  if (parsed.id !== input.metaTemplateId || typeof parsed.name !== 'string' || !TEMPLATE.test(parsed.name) || typeof parsed.language !== 'string'
      || !LANGUAGE.test(parsed.language) || typeof parsed.status !== 'string' || !/^[A-Z_]{1,40}$/u.test(parsed.status)
      || typeof parsed.category !== 'string' || !['MARKETING', 'UTILITY', 'AUTHENTICATION'].includes(parsed.category) || !components || body === null) return null;
  const parameters = new Set([...body.matchAll(/\{\{([0-9]+)\}\}/gu)].map(m => m[1])).size;
  // Only a BODY-only template can equal the owner-approved local draft; any header, footer or
  // button is content the owner never reviewed, so its digest can never match.
  const bodyOnly = components.length === 1;
  return Object.freeze({ name: parsed.name, language: parsed.language, category: parsed.category, status: parsed.status,
    parameterCount: Math.min(parameters, 10), bodySha256: bodyOnly ? sha(body) : sha(`non-body-components:${canonical(components)}`),
    componentsSha256: sha(canonical(components)), responseSha256: sha(text) });
}

interface Target { bindingId: string; binding: MetaWhatsAppBinding; envelope: MetaWhatsAppDispatchCredentialEnvelope; metaTemplateId: string; templateName: string }
interface Material extends Target { jobId: string; leaseVersion: number; recipient: string; templateName: string; languageCode: string;
  operationId: string; requestSha256: string }

function envelopeOf(row: Record<string, unknown>): MetaWhatsAppDispatchCredentialEnvelope {
  const bytes = (key: string, length: number | null): Buffer => {
    const value = row[key];
    if (!Buffer.isBuffer(value) || (length !== null && value.length !== length)) fail(`returned an invalid ${key}`);
    return value;
  };
  if (typeof row.secret_key_version !== 'string') fail('returned an invalid key version');
  return Object.freeze({ algorithm: 'aes-256-gcm-v1', keyVersion: row.secret_key_version, ivBase64: bytes('secret_iv', 12).toString('base64'),
    ciphertextBase64: bytes('secret_ciphertext', null).toString('base64'), authTagBase64: bytes('secret_auth_tag', 16).toString('base64'),
    aadSha256: bytes('secret_aad_sha256', 32).toString('hex'), secretPayloadSha256: bytes('secret_payload_sha256', 32).toString('hex') });
}
function bindingOf(row: Record<string, unknown>, workspaceId: string): MetaWhatsAppBinding {
  if (typeof row.provider_connection_id !== 'string' || !UUID.test(row.provider_connection_id) || row.graph_api_version !== 'v24.0'
      || ![row.app_id, row.waba_id, row.phone_number_id].every(v => typeof v === 'string' && META_ID.test(v))) fail('returned an invalid binding');
  return Object.freeze({ workspaceId, connectionId: row.provider_connection_id, appId: row.app_id as string, wabaId: row.waba_id as string,
    phoneNumberId: row.phone_number_id as string, graphApiVersion: 'v24.0' });
}

export class PgMhpEventWhatsAppRepository {
  readonly #pool: Pick<Pool, 'connect'>; readonly #connectionId: string; readonly #bindingId: string;
  constructor(pool: Pick<Pool, 'connect'>, binding: Readonly<{ workspaceId: string; connectionId: string; bindingId: string }>) {
    if (binding.workspaceId !== MHP_EVENT_WHATSAPP_WORKSPACE_ID || !UUID.test(binding.connectionId) || !UUID.test(binding.bindingId)) fail('binding is invalid');
    this.#pool = pool; this.#connectionId = binding.connectionId; this.#bindingId = binding.bindingId;
  }
  #run<T extends QueryResultRow>(label: string, sql: string, values: unknown[], readOnly = false): Promise<T[]> {
    return withTransaction(this.#pool, { actorKind: 'worker', workspaceId: MHP_EVENT_WHATSAPP_WORKSPACE_ID, requestId: `mhp-event-wa:${label}:${this.#bindingId}` },
      async tx => (await tx.query<T>(sql, values)).rows, { isolation: 'read committed', ...(readOnly ? { readOnly: true } : {}) });
  }
  async observationTargets(): Promise<Target[]> {
    const rows = await this.#run<Record<string, unknown>>('targets', 'SELECT * FROM app_private.mhp_event_whatsapp_observation_targets($1,$2)',
      [MHP_EVENT_WHATSAPP_WORKSPACE_ID, this.#bindingId], true);
    return rows.map(row => {
      if (typeof row.meta_template_id !== 'string' || !META_ID.test(row.meta_template_id)) fail('returned an invalid template id');
      if (typeof row.template_name !== 'string' || !TEMPLATE.test(row.template_name)) fail('returned an invalid template name');
      return { bindingId: this.#bindingId, binding: bindingOf(row, MHP_EVENT_WHATSAPP_WORKSPACE_ID), envelope: envelopeOf(row), metaTemplateId: row.meta_template_id,
        templateName: row.template_name };
    });
  }
  async recordObservation(metaTemplateId: string, o: MetaTemplateObservation): Promise<void> {
    await this.#run('observe', 'SELECT app_private.record_mhp_whatsapp_template_observation($1,$2,$3,$4,$5,$6,$7,$8,decode($9,\'hex\'),decode($10,\'hex\'),decode($11,\'hex\'))',
      [MHP_EVENT_WHATSAPP_WORKSPACE_ID, this.#bindingId, metaTemplateId, o.name, o.language, o.category, o.status, o.parameterCount, o.bodySha256, o.componentsSha256, o.responseSha256]);
  }
  async prepareDue(): Promise<number> {
    const rows = await this.#run<{ value: { prepared?: unknown[] } }>('prepare', 'SELECT app_private.mhp_prepare_event_whatsapp($1,$2,3) AS value',
      [MHP_EVENT_WHATSAPP_WORKSPACE_ID, this.#connectionId]);
    if (!Array.isArray(rows[0]?.value?.prepared)) fail('prepare returned an invalid result');
    return rows[0]!.value.prepared!.length;
  }
  async claim(leaseToken: Buffer): Promise<{ jobId: string; leaseVersion: number } | null> {
    const rows = await this.#run<{ job_id: string; binding_id: string; lease_version: string }>('claim', 'SELECT * FROM app_private.claim_event_whatsapp_job($1,$2,$3,60)',
      [MHP_EVENT_WHATSAPP_WORKSPACE_ID, this.#connectionId, leaseToken]);
    if (rows.length === 0) return null;
    if (rows.length !== 1 || !UUID.test(rows[0]!.job_id) || rows[0]!.binding_id !== this.#bindingId) fail('claim returned an invalid job');
    return { jobId: rows[0]!.job_id, leaseVersion: Number(rows[0]!.lease_version) };
  }
  async load(claim: { jobId: string; leaseVersion: number }, leaseToken: Buffer): Promise<Material | null> {
    const rows = await this.#run<Record<string, unknown>>('load', 'SELECT * FROM app_private.load_event_whatsapp_job($1,$2,$3,$4)',
      [MHP_EVENT_WHATSAPP_WORKSPACE_ID, claim.jobId, claim.leaseVersion, leaseToken], true);
    if (rows.length !== 1) return null;
    const row = rows[0]!;
    if (typeof row.recipient !== 'string' || !E164.test(row.recipient) || typeof row.template_name !== 'string' || !TEMPLATE.test(row.template_name)
        || typeof row.language_code !== 'string' || !LANGUAGE.test(row.language_code) || typeof row.operation_id !== 'string' || !UUID.test(row.operation_id)
        || !Buffer.isBuffer(row.request_sha256) || typeof row.meta_template_id !== 'string') fail('loaded material crossed its trusted boundary');
    return { bindingId: this.#bindingId, binding: bindingOf(row, MHP_EVENT_WHATSAPP_WORKSPACE_ID), envelope: envelopeOf(row), metaTemplateId: row.meta_template_id,
      ...claim, recipient: row.recipient, templateName: row.template_name, languageCode: row.language_code, operationId: row.operation_id,
      requestSha256: (row.request_sha256 as Buffer).toString('hex') };
  }
  async begin(claim: { jobId: string; leaseVersion: number }, leaseToken: Buffer): Promise<boolean> {
    const rows = await this.#run<{ marked: unknown }>('begin', 'SELECT app_private.begin_event_whatsapp_call($1,$2,$3,$4,true,false) AS marked',
      [MHP_EVENT_WHATSAPP_WORKSPACE_ID, claim.jobId, claim.leaseVersion, leaseToken]);
    return rows[0]?.marked === true;
  }
  async settle(claim: { jobId: string; leaseVersion: number }, leaseToken: Buffer, result: MetaWhatsAppDispatchResult): Promise<void> {
    await this.#run('settle', 'SELECT app_private.settle_whatsapp_live_call($1,$2,$3,$4,$5,$6,decode($7,\'hex\'),$8,$9::timestamptz)',
      [MHP_EVENT_WHATSAPP_WORKSPACE_ID, claim.jobId, claim.leaseVersion, leaseToken, result.state, result.providerMessageId, result.receiptSha256,
        result.safeCode, result.occurredAt]);
  }
}

export type MhpEventWhatsAppCycle = 'idle' | 'accepted' | 'failed_or_attention';
/**
 * One cycle: refresh the Meta template read (if due), prepare due follow-ups, then at most one
 * send. The template is re-read with the job's own decrypted credential immediately before begin,
 * so a template paused or edited at Meta after preparation is refused.
 */
export async function runMhpEventWhatsAppOnce(input: Readonly<{
  repository: PgMhpEventWhatsAppRepository; encryptionKey: Buffer; encryptionKeyVersion: string; leaseToken: Buffer; fetch: typeof fetch;
  createTransport: (input: Readonly<{ binding: MetaWhatsAppBinding; credentials: MetaWhatsAppDispatchCredentials; providerEffectsEnabled: true; emergencyPaused: false }>) => MetaWhatsAppLiveTransport;
  observeNow: boolean;
}>): Promise<MhpEventWhatsAppCycle> {
  const decrypt = (target: Target) => decryptMetaWhatsAppDispatchCredentials({ binding: target.binding, envelope: target.envelope,
    encryptionKey: input.encryptionKey, expectedKeyVersion: input.encryptionKeyVersion });
  const observe = async (target: Target, credentials: MetaWhatsAppDispatchCredentials) => {
    const observation = await readMetaWhatsAppTemplate({ binding: target.binding, credentials, metaTemplateId: target.metaTemplateId,
      templateName: target.templateName, fetch: input.fetch });
    if (observation) await input.repository.recordObservation(target.metaTemplateId, observation);
  };
  if (input.observeNow) for (const target of await input.repository.observationTargets()) await observe(target, decrypt(target));
  await input.repository.prepareDue();
  const claim = await input.repository.claim(input.leaseToken);
  if (!claim) return 'idle';
  const material = await input.repository.load(claim, input.leaseToken);
  if (!material) return 'failed_or_attention';
  const credentials = decrypt(material);
  await observe(material, credentials);
  if (!await input.repository.begin(claim, input.leaseToken)) return 'failed_or_attention';
  let result: MetaWhatsAppDispatchResult;
  try {
    result = await input.createTransport({ binding: material.binding, credentials, providerEffectsEnabled: true, emergencyPaused: false })
      .sendTemplate({ binding: material.binding, recipient: material.recipient, templateName: material.templateName, languageCode: material.languageCode,
        operationId: material.operationId, requestSha256: material.requestSha256 });
  } catch {
    result = Object.freeze({ state: 'outcome_unknown', providerMessageId: null, receiptSha256: sha('worker_transport_exception'),
      safeCode: 'worker_transport_outcome_unknown', occurredAt: new Date().toISOString() });
  }
  await input.repository.settle(claim, input.leaseToken, result);
  return result.state === 'accepted' ? 'accepted' : 'failed_or_attention';
}
