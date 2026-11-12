/**
 * MHP-WA-121 (0151) worker adapter: the MHP number's approved Meta templates are read server-side
 * (the only template evidence), and owner one-to-one template jobs are claimed, re-proved, sent with
 * their body variables and settled on the shared 0053 settlement. Every call runs in the exact worker
 * context. A job is only ever 'accepted' on Meta's own answer; a Meta error code is kept in the
 * receipt's safe code (meta_error:NNN) so the database can record restriction holds.
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
import { MHP_EVENT_WHATSAPP_WORKSPACE_ID } from './event-repository.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const META_ID = /^[1-9][0-9]{4,29}$/u;
const TEMPLATE = /^[a-z][a-z0-9_]*$/u;
const LANGUAGE = /^[a-z]{2,3}(?:_[A-Z]{2})?$/u;
const STATUS = /^[A-Z_]{1,40}$/u;
const E164 = /^[1-9][0-9]{6,14}$/u;
const PLACEHOLDER = /\{\{([^{}]{1,64})\}\}/gu;
const sha = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');
function fail(label: string): never { throw new Error(`MHP owner WhatsApp repository ${label}`); }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value as object).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(value);
}

export type OwnerParameterFormat = 'NONE' | 'POSITIONAL' | 'NAMED';
export interface OwnerTemplateObservation {
  readonly metaTemplateId: string; readonly name: string; readonly language: string;
  readonly category: 'MARKETING' | 'UTILITY' | 'AUTHENTICATION'; readonly status: string;
  readonly parameterFormat: OwnerParameterFormat; readonly parameterNames: readonly string[];
  readonly bodyText: string; readonly previewText: string; readonly componentsSha256: string;
  readonly sendable: boolean; readonly unsupportedReason: string | null;
}

/**
 * One Meta template object → what the owner may send. Only body variables are supported; a header,
 * footer or button is allowed when it needs no value. Anything else is listed as not sendable with a
 * reason, never silently dropped. Returns null for a shape that is not a Meta template at all.
 */
export function parseOwnerTemplate(raw: unknown): OwnerTemplateObservation | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const t = raw as Record<string, unknown>;
  if (typeof t.id !== 'string' || !META_ID.test(t.id) || typeof t.name !== 'string' || !TEMPLATE.test(t.name) || t.name.length > 512
      || typeof t.language !== 'string' || !LANGUAGE.test(t.language) || typeof t.status !== 'string' || !STATUS.test(t.status)
      || typeof t.category !== 'string' || !['MARKETING', 'UTILITY', 'AUTHENTICATION'].includes(t.category) || !Array.isArray(t.components)) return null;
  const components = t.components as unknown[];
  if (components.some(c => !c || typeof c !== 'object' || Array.isArray(c))) return null;
  const list = components as Record<string, unknown>[];
  const body = list.filter(c => c.type === 'BODY');
  if (body.length !== 1 || typeof body[0]!.text !== 'string' || !body[0]!.text.trim() || body[0]!.text.length > 1024) return null;
  const bodyText = body[0]!.text as string;
  let reason: string | null = null;
  const parts: string[] = [];
  for (const c of list) {
    if (c.type === 'HEADER') {
      if (c.format !== 'TEXT' || typeof c.text !== 'string') reason ??= 'media_header';
      else if (/\{\{/u.test(c.text)) reason ??= 'header_variables';
      else parts.push(c.text);
    }
  }
  parts.push(bodyText);
  for (const c of list) {
    if (c.type === 'FOOTER') { if (typeof c.text === 'string' && !/\{\{/u.test(c.text)) parts.push(c.text); else reason ??= 'footer_variables'; }
    else if (c.type === 'BUTTONS') {
      const buttons = Array.isArray(c.buttons) ? c.buttons as Record<string, unknown>[] : [];
      for (const b of buttons) {
        const label = typeof b?.text === 'string' ? b.text : '';
        if (b?.type === 'QUICK_REPLY' || b?.type === 'PHONE_NUMBER' || (b?.type === 'URL' && typeof b.url === 'string' && !/\{\{/u.test(b.url))) {
          if (label) parts.push(`[${label}]`);
        } else reason ??= b?.type === 'URL' ? 'button_variables' : 'unsupported_button';
      }
    } else if (!['HEADER', 'BODY', 'FOOTER', 'BUTTONS'].includes(String(c.type))) reason ??= 'unsupported_component';
  }
  const names: string[] = [];
  for (const match of bodyText.matchAll(PLACEHOLDER)) if (!names.includes(match[1]!)) names.push(match[1]!);
  const numeric = names.length > 0 && names.every(n => /^[1-9][0-9]?$/u.test(n));
  let format: OwnerParameterFormat = names.length === 0 ? 'NONE' : numeric ? 'POSITIONAL' : 'NAMED';
  let parameterNames: string[] = names;
  if (format === 'POSITIONAL') {
    const sorted = names.map(Number).sort((a, b) => a - b);
    if (sorted.some((n, i) => n !== i + 1) || t.parameter_format === 'NAMED') { reason ??= 'placeholders_invalid'; }
    parameterNames = sorted.map(String);
  } else if (format === 'NAMED' && (t.parameter_format === 'POSITIONAL' || names.some(n => !/^[a-z_][a-z0-9_]*$/u.test(n)))) {
    reason ??= 'placeholders_invalid';
  }
  if (names.length > 20) { reason ??= 'too_many_variables'; }
  if (reason === 'placeholders_invalid' || reason === 'too_many_variables') { format = 'NONE'; parameterNames = []; }
  if (t.category === 'AUTHENTICATION') reason ??= 'authentication_template';
  const previewText = parts.join('\n\n');
  if (previewText.length > 2048) return null;
  // A 'NONE' format with placeholders would be refused by the database; such a template is listed only as unsupported.
  if (format === 'NONE' && names.length > 0) return null;
  return Object.freeze({ metaTemplateId: t.id, name: t.name, language: t.language, category: t.category as OwnerTemplateObservation['category'],
    status: t.status, parameterFormat: format, parameterNames: Object.freeze(parameterNames), bodyText, previewText,
    componentsSha256: sha(canonical(components)), sendable: reason === null, unsupportedReason: reason });
}

const GRAPH = 'https://graph.facebook.com';
/**
 * Every template of this binding's own WABA (GET /{waba-id}/message_templates), following Meta's paging
 * only on the same host and path. Never throws for a provider answer; null = unproven.
 */
export async function readMetaWhatsAppTemplateCatalogue(input: Readonly<{ binding: MetaWhatsAppBinding; credentials: MetaWhatsAppDispatchCredentials;
  fetch: typeof fetch; name?: string; timeoutMs?: number; maxPages?: number }>): Promise<unknown[] | null> {
  if (input.binding.graphApiVersion !== 'v24.0' || !META_ID.test(input.binding.wabaId) || (input.name !== undefined && !TEMPLATE.test(input.name))) fail('catalogue input is invalid');
  const path = `/${input.binding.graphApiVersion}/${input.binding.wabaId}/message_templates`;
  let next: string | null = `${GRAPH}${path}?fields=id,name,language,status,category,components,parameter_format&limit=100`
    + (input.name ? `&name=${encodeURIComponent(input.name)}` : '');
  const found: unknown[] = [];
  for (let page = 0; next && page < (input.maxPages ?? 5); page += 1) {
    let parsed: unknown;
    try {
      const response = await input.fetch(next, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(input.timeoutMs ?? 10_000),
        headers: { Accept: 'application/json', Authorization: `Bearer ${input.credentials.accessToken}` } });
      const text = (await response.text()).slice(0, 1_048_576);
      if (!response.ok) return null;
      parsed = JSON.parse(text);
    } catch { return null; }
    if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { data?: unknown }).data)) return null;
    found.push(...(parsed as { data: unknown[] }).data);
    const candidate = (parsed as { paging?: { next?: unknown } }).paging?.next;
    next = null;
    if (typeof candidate === 'string') {
      try { const url = new URL(candidate); if (url.origin === GRAPH && url.pathname === path) next = url.toString(); } catch { next = null; }
    }
  }
  return found;
}

interface Target { binding: MetaWhatsAppBinding; envelope: MetaWhatsAppDispatchCredentialEnvelope }
export interface OwnerJobMaterial extends Target {
  jobId: string; leaseVersion: number; recipient: string; templateName: string; languageCode: string; metaTemplateId: string;
  operationId: string; requestSha256: string; sendId: string; parameterFormat: OwnerParameterFormat;
  parameters: readonly { name: string; value: string }[]; eligible: boolean; reason: string | null;
}

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
function bindingOf(row: Record<string, unknown>): MetaWhatsAppBinding {
  if (typeof row.provider_connection_id !== 'string' || !UUID.test(row.provider_connection_id) || row.graph_api_version !== 'v24.0'
      || ![row.app_id, row.waba_id, row.phone_number_id].every(v => typeof v === 'string' && META_ID.test(v))) fail('returned an invalid binding');
  return Object.freeze({ workspaceId: MHP_EVENT_WHATSAPP_WORKSPACE_ID, connectionId: row.provider_connection_id, appId: row.app_id as string,
    wabaId: row.waba_id as string, phoneNumberId: row.phone_number_id as string, graphApiVersion: 'v24.0' });
}
function parametersOf(value: unknown, format: unknown): readonly { name: string; value: string }[] {
  if (!['NONE', 'POSITIONAL', 'NAMED'].includes(String(format)) || !Array.isArray(value) || value.length > 20
      || value.some(p => !p || typeof p.name !== 'string' || typeof p.value !== 'string')) fail('loaded invalid template variables');
  return Object.freeze((value as { name: string; value: string }[]).map(p => Object.freeze({ name: p.name, value: p.value })));
}

export class PgMhpOwnerWhatsAppRepository {
  readonly #pool: Pick<Pool, 'connect'>; readonly #connectionId: string; readonly #bindingId: string;
  constructor(pool: Pick<Pool, 'connect'>, binding: Readonly<{ workspaceId: string; connectionId: string; bindingId: string }>) {
    if (binding.workspaceId !== MHP_EVENT_WHATSAPP_WORKSPACE_ID || !UUID.test(binding.connectionId) || !UUID.test(binding.bindingId)) fail('binding is invalid');
    this.#pool = pool; this.#connectionId = binding.connectionId; this.#bindingId = binding.bindingId;
  }
  #run<T extends QueryResultRow>(label: string, sql: string, values: unknown[], readOnly = false): Promise<T[]> {
    return withTransaction(this.#pool, { actorKind: 'worker', workspaceId: MHP_EVENT_WHATSAPP_WORKSPACE_ID, requestId: `mhp-owner-wa:${label}:${this.#bindingId}` },
      async tx => (await tx.query<T>(sql, values)).rows, { isolation: 'read committed', ...(readOnly ? { readOnly: true } : {}) });
  }
  async catalogueTarget(): Promise<Target | null> {
    const [row] = await this.#run<Record<string, unknown>>('target', 'SELECT * FROM app_private.mhp_wa_owner_catalogue_target($1,$2)',
      [MHP_EVENT_WHATSAPP_WORKSPACE_ID, this.#bindingId], true);
    if (!row) return null;
    if (row.binding_id !== this.#bindingId) fail('returned another binding');
    return { binding: bindingOf(row), envelope: envelopeOf(row) };
  }
  async recordTemplate(o: OwnerTemplateObservation): Promise<void> {
    await this.#run('observe', `SELECT app_private.record_mhp_wa_owner_template($1,$2,$3,$4,$5,$6,$7,$8,$9::text[],$10,$11,decode($12,'hex'),$13,$14)`,
      [MHP_EVENT_WHATSAPP_WORKSPACE_ID, this.#bindingId, o.metaTemplateId, o.name, o.language, o.category, o.status, o.parameterFormat,
        [...o.parameterNames], o.bodyText, o.previewText, o.componentsSha256, o.sendable, o.unsupportedReason]);
  }
  async claim(leaseToken: Buffer): Promise<{ jobId: string; leaseVersion: number } | null> {
    const rows = await this.#run<{ job_id: string; binding_id: string; lease_version: string }>('claim', 'SELECT * FROM app_private.claim_owner_whatsapp_job($1,$2,$3,60)',
      [MHP_EVENT_WHATSAPP_WORKSPACE_ID, this.#connectionId, leaseToken]);
    if (rows.length === 0) return null;
    if (rows.length !== 1 || !UUID.test(rows[0]!.job_id) || rows[0]!.binding_id !== this.#bindingId) fail('claim returned an invalid job');
    return { jobId: rows[0]!.job_id, leaseVersion: Number(rows[0]!.lease_version) };
  }
  async load(claim: { jobId: string; leaseVersion: number }, leaseToken: Buffer): Promise<OwnerJobMaterial | null> {
    const rows = await this.#run<Record<string, unknown>>('load', 'SELECT * FROM app_private.load_owner_whatsapp_job($1,$2,$3,$4)',
      [MHP_EVENT_WHATSAPP_WORKSPACE_ID, claim.jobId, claim.leaseVersion, leaseToken], true);
    if (rows.length !== 1) return null;
    const row = rows[0]!;
    if (typeof row.recipient !== 'string' || !E164.test(row.recipient) || typeof row.template_name !== 'string' || !TEMPLATE.test(row.template_name)
        || typeof row.language_code !== 'string' || !LANGUAGE.test(row.language_code) || typeof row.operation_id !== 'string' || !UUID.test(row.operation_id)
        || !Buffer.isBuffer(row.request_sha256) || typeof row.meta_template_id !== 'string' || !META_ID.test(row.meta_template_id)
        || typeof row.send_id !== 'string' || !UUID.test(row.send_id) || typeof row.eligible !== 'boolean') fail('loaded material crossed its trusted boundary');
    return { binding: bindingOf(row), envelope: envelopeOf(row), ...claim, recipient: row.recipient, templateName: row.template_name,
      languageCode: row.language_code, metaTemplateId: row.meta_template_id, operationId: row.operation_id,
      requestSha256: (row.request_sha256 as Buffer).toString('hex'), sendId: row.send_id, parameterFormat: row.parameter_format as OwnerParameterFormat,
      parameters: parametersOf(row.parameters, row.parameter_format), eligible: row.eligible, reason: typeof row.reason === 'string' ? row.reason : null };
  }
  async begin(claim: { jobId: string; leaseVersion: number }, leaseToken: Buffer): Promise<{ begun: boolean; reason?: string }> {
    const [row] = await this.#run<{ value: { begun?: unknown; reason?: unknown } }>('begin', 'SELECT app_private.begin_owner_whatsapp_call($1,$2,$3,$4,true,false) AS value',
      [MHP_EVENT_WHATSAPP_WORKSPACE_ID, claim.jobId, claim.leaseVersion, leaseToken]);
    return row?.value?.begun === true ? { begun: true } : { begun: false, reason: typeof row?.value?.reason === 'string' ? row.value.reason : 'not_eligible' };
  }
  async settle(claim: { jobId: string; leaseVersion: number }, leaseToken: Buffer, result: MetaWhatsAppDispatchResult): Promise<void> {
    await this.#run('settle', 'SELECT app_private.settle_whatsapp_live_call($1,$2,$3,$4,$5,$6,decode($7,\'hex\'),$8,$9::timestamptz)',
      [MHP_EVENT_WHATSAPP_WORKSPACE_ID, claim.jobId, claim.leaseVersion, leaseToken, result.state, result.providerMessageId, result.receiptSha256,
        ownerSafeCode(result), result.occurredAt]);
  }
}

/** Keep Meta's own error code on a refusal so the database can apply restriction holds (0151 proposal 4). */
export function ownerSafeCode(result: MetaWhatsAppDispatchResult): string {
  return result.state !== 'accepted' && result.providerErrorCode !== undefined ? `meta_error:${result.providerErrorCode}` : result.safeCode;
}

export type MhpOwnerWhatsAppCycle = 'idle' | 'accepted' | 'failed_or_attention';
/**
 * One owner cycle: refresh the catalogue (if due), then at most one owner template send. The exact
 * template is re-read with the job's own credential immediately before begin-call, so a template paused,
 * edited or deleted at Meta after the owner queued it is refused (fail closed: the authority lapses).
 */
export async function runMhpOwnerWhatsAppOnce(input: Readonly<{
  repository: PgMhpOwnerWhatsAppRepository; encryptionKey: Buffer; encryptionKeyVersion: string; leaseToken: Buffer; fetch: typeof fetch;
  createTransport: (input: Readonly<{ binding: MetaWhatsAppBinding; credentials: MetaWhatsAppDispatchCredentials; providerEffectsEnabled: true; emergencyPaused: false }>) => MetaWhatsAppLiveTransport;
  observeNow: boolean;
}>): Promise<MhpOwnerWhatsAppCycle> {
  const decrypt = (target: Target) => decryptMetaWhatsAppDispatchCredentials({ binding: target.binding, envelope: target.envelope,
    encryptionKey: input.encryptionKey, expectedKeyVersion: input.encryptionKeyVersion });
  if (input.observeNow) {
    const target = await input.repository.catalogueTarget();
    if (target) {
      const templates = await readMetaWhatsAppTemplateCatalogue({ binding: target.binding, credentials: decrypt(target), fetch: input.fetch });
      for (const raw of templates ?? []) {
        const parsed = parseOwnerTemplate(raw);
        if (parsed) await input.repository.recordTemplate(parsed);
      }
    }
  }
  const claim = await input.repository.claim(input.leaseToken);
  if (!claim) return 'idle';
  const material = await input.repository.load(claim, input.leaseToken);
  if (!material) return 'failed_or_attention';
  if (!material.eligible) { await input.repository.begin(claim, input.leaseToken); return 'failed_or_attention'; }
  const credentials = decrypt(material);
  const fresh = await readMetaWhatsAppTemplateCatalogue({ binding: material.binding, credentials, fetch: input.fetch, name: material.templateName, maxPages: 1 });
  const exact = (fresh ?? []).map(parseOwnerTemplate).find(t => t?.metaTemplateId === material.metaTemplateId);
  if (!exact) return 'failed_or_attention';
  await input.repository.recordTemplate(exact);
  const begun = await input.repository.begin(claim, input.leaseToken);
  if (!begun.begun) return 'failed_or_attention';
  let result: MetaWhatsAppDispatchResult;
  try {
    const transport = input.createTransport({ binding: material.binding, credentials, providerEffectsEnabled: true, emergencyPaused: false });
    if (!transport.sendOwnerTemplate) throw new Error('Owner template transport unavailable');
    result = await transport.sendOwnerTemplate({ binding: material.binding, recipient: material.recipient, templateName: material.templateName,
      languageCode: material.languageCode, operationId: material.operationId, requestSha256: material.requestSha256,
      parameterFormat: material.parameterFormat, parameters: material.parameters });
  } catch {
    // A begun provider operation is never retried; its outcome is unknown until a signed status says otherwise.
    result = Object.freeze({ state: 'outcome_unknown', providerMessageId: null, receiptSha256: sha('worker_transport_exception'),
      safeCode: 'worker_transport_outcome_unknown', occurredAt: new Date().toISOString() });
  }
  await input.repository.settle(claim, input.leaseToken, result);
  return result.state === 'accepted' ? 'accepted' : 'failed_or_attention';
}
