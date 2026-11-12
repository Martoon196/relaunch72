/**
 * MHP-WA-121 (0151): "Send WhatsApp from Martin Howard Property" for one CRM contact of any group brand.
 *
 * Every action arrives on the signed Growth HQ command boundary (inbox.ts), which has already proved the
 * HMAC, the brand scope, the actor e-mail and the brand owner's current workspace management. Here the
 * actor must ALSO be a configured MHP actor; the database calls run on r72_crm_command in the MHP
 * workspace as the MHP direct owner, and each definer re-proves the role, the owner and (for the original
 * brand contact) that the same owner manages that brand's workspace. Nothing here calls Meta: template
 * sends become one job on the 0053 rail for the worker, in-window text becomes one 0143 reply.
 */
import { requestDatabaseContext } from '../../db/rls.js';
import type { CrmTransactionRunner } from '../../crm-pg/types.js';
import { MHP_MARKETING_WORKSPACE_ID } from '../../mhp/marketing-workspace-service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const META_ID = /^[1-9][0-9]{4,29}$/u;
const SHA = /^[0-9a-f]{64}$/u;
export const OWNER_WHATSAPP_ACTIONS = ['whatsappOwnerState', 'whatsappOwnerTemplates', 'whatsappOwnerPreview', 'whatsappOwnerLink',
  'whatsappOwnerPermission', 'whatsappOwnerSendTemplate', 'whatsappOwnerSendText', 'whatsappOwnerStatus'] as const;
export type OwnerWhatsAppAction = typeof OWNER_WHATSAPP_ACTIONS[number];
export const isOwnerWhatsAppAction = (value: unknown): value is OwnerWhatsAppAction =>
  typeof value === 'string' && (OWNER_WHATSAPP_ACTIONS as readonly string[]).includes(value);

export class OwnerWhatsAppError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

/** Plain-English reasons for every refusal state the database returns. Never "sent" unless Meta accepted it. */
export const OWNER_REASONS: Readonly<Record<string, string>> = Object.freeze({
  sender_not_connected: 'The Martin Howard Property WhatsApp number is not connected right now.',
  contact_not_found: 'This contact could not be found (it may have been archived).',
  number_not_found: 'That phone number is no longer on this contact.',
  number_not_international: 'Enter the number in international form, for example +44 7700 900123.',
  mhp_contact_ambiguous: 'This number belongs to more than one Martin Howard Property contact. Merge them first.',
  link_not_found: 'This WhatsApp number is not linked to this contact.',
  mhp_contact_unavailable: 'The Martin Howard Property copy of this contact is no longer available.',
  number_unverified: 'This number has not been confirmed as the person’s WhatsApp. Record permission and confirm the number first.',
  no_permission: 'No WhatsApp permission is recorded for this person yet.',
  permission_withdrawn: 'WhatsApp permission was withdrawn. Nothing can be sent.',
  permission_denied: 'WhatsApp permission was refused. Nothing can be sent.',
  permission_stale: 'The number changed after permission was recorded. Record permission again.',
  permission_changed: 'Permission or the number changed after this message was queued, so it was not sent.',
  basis_not_allowed: 'That lawful basis does not fit the evidence chosen. Consent needs the person’s own request or written consent.',
  evidence_note_invalid: 'Add a short note (8–500 characters) saying how you have permission.',
  opted_out: 'This person has opted out of WhatsApp. Nothing can be sent.',
  suppressed: 'This number is suppressed for WhatsApp. Nothing can be sent.',
  whatsapp_stop: 'This person replied STOP on WhatsApp. Nothing can be sent.',
  account_restricted: 'Meta has temporarily restricted the Martin Howard Property number. Sending is paused until the time shown.',
  recipient_paused: 'Meta asked us to stop messaging this person for now. Try again after the time shown.',
  daily_cap_reached: 'Today’s limit for one-to-one WhatsApp templates has been reached. Try again tomorrow.',
  recipient_recently_messaged: 'A template went to this person in the last 24 hours. Wait for a reply, or try again tomorrow.',
  template_not_approved: 'Meta has not confirmed this template as approved in the last 15 minutes. Refresh the list and try again.',
  template_not_registered: 'This template could not be prepared for sending.',
  variables_invalid: 'Fill every variable. WhatsApp does not allow new lines, tabs or more than four spaces in a row.',
  preview_changed: 'The message changed since you previewed it. Check the preview again before sending.',
  window_closed: 'Free text can only be sent within 24 hours of the person’s last WhatsApp message. Send an approved template instead.',
  request_conflict: 'That request was already used for a different message. Reload and try again.',
  authority_expired: 'The send was not picked up in time and expired. Nothing was sent.',
  not_owner: 'Only the Martin Howard Property owner can send these messages.',
  not_eligible: 'The checks failed just before sending, so nothing was sent.',
  owner_send_unavailable: 'One-to-one WhatsApp from Martin Howard Property is not switched on yet.',
});
/** Meta error codes the owner is likely to see, in plain English (Meta's own meanings). */
export const META_ERRORS: Readonly<Record<number, string>> = Object.freeze({
  368: 'Meta temporarily blocked the number for a policy reason. Check WhatsApp Manager.',
  131048: 'Meta’s spam rate limit was hit; too many messages were blocked or reported. Sending is paused.',
  131031: 'The WhatsApp Business account is locked. Check WhatsApp Manager.',
  131056: 'Too many messages to this person in a short time (pair rate limit). Wait before trying again.',
  131049: 'Meta did not deliver this marketing message to protect the person’s experience. Try later or wait for them to reply.',
  131050: 'The person has stopped marketing messages from this business on WhatsApp.',
  131026: 'The message could not be delivered (the number may not use WhatsApp, or has not accepted the terms).',
  131047: 'More than 24 hours have passed since the person last replied; only a template can be sent.',
  132000: 'The template variables did not match Meta’s template.',
  132001: 'The template does not exist in that language, or is not approved.',
  132015: 'The template is paused because of low quality.',
  132016: 'The template has been disabled by Meta.',
  130429: 'Meta’s sending rate limit was reached. Sending is paused briefly.',
  80007: 'The WhatsApp Business account reached its rate limit. Sending is paused for an hour.',
  190: 'The Meta access token for the number is no longer valid. Reconnect the number.',
});
export const STATE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  queued: 'Queued — waiting for the sender', calling: 'Sending to Meta', accepted: 'Accepted by Meta (not yet delivered)',
  sent: 'Sent', delivered: 'Delivered', read: 'Read', failed: 'Failed', outcome_unknown: 'Not confirmed by Meta — check before resending',
  expired: 'Expired — nothing was sent', blocked: 'Not sent — checks failed just before sending',
});

function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function text(value: unknown, max: number, min = 1): string {
  if (typeof value !== 'string' || value.length < min || value.length > max || value.includes('\0')) throw new OwnerWhatsAppError(400, 'invalid_request');
  return value;
}
function uuid(value: unknown): string {
  const v = text(value, 36).toLowerCase();
  if (!UUID.test(v)) throw new OwnerWhatsAppError(400, 'invalid_request');
  return v;
}
function variables(value: unknown): unknown {
  if (value == null) return [];
  if (Array.isArray(value)) {
    if (value.length > 20 || value.some(v => typeof v !== 'string' || v.length > 500)) throw new OwnerWhatsAppError(400, 'invalid_request');
    return value;
  }
  if (record(value)) {
    const entries = Object.entries(value);
    if (entries.length > 20 || entries.some(([k, v]) => !/^[a-z_][a-z0-9_]{0,63}$/u.test(k) || typeof v !== 'string' || v.length > 500)) {
      throw new OwnerWhatsAppError(400, 'invalid_request');
    }
    return value;
  }
  throw new OwnerWhatsAppError(400, 'invalid_request');
}

/** Adds plain-English text to every reason, state and Meta error code in a database answer. */
export function explain(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(explain);
  if (!record(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) out[key] = explain(item);
  if (typeof value.reason === 'string' && OWNER_REASONS[value.reason]) out.message = OWNER_REASONS[value.reason];
  if (typeof value.state === 'string' && STATE_LABELS[value.state]) out.stateLabel = STATE_LABELS[value.state];
  const code = typeof value.errorCode === 'number' ? value.errorCode : null;
  if (code !== null && META_ERRORS[code]) out.errorMessage = META_ERRORS[code];
  return out;
}

export interface OwnerWhatsAppScope { brand: string; workspaceId: string }
export interface OwnerWhatsAppActor { userId: string }

/** Map database refusals to the boundary's HTTP codes; anything else stays a 503. */
function mapError(error: unknown): never {
  const code = record(error) && typeof error.code === 'string' ? error.code : '';
  if (code === '42501') throw new OwnerWhatsAppError(403, 'forbidden_scope');
  if (code === '22023' || code === '22P02') throw new OwnerWhatsAppError(400, 'invalid_request');
  if (code === '23505' || code === '40001') throw new OwnerWhatsAppError(409, 'request_conflict');
  throw error;
}

export class OwnerWhatsAppCommands {
  constructor(private readonly runner: CrmTransactionRunner, private readonly enabled: boolean) {}

  async execute(action: OwnerWhatsAppAction, input: Record<string, unknown>, origin: OwnerWhatsAppScope, mhpActor: OwnerWhatsAppActor | null,
    requestId: string): Promise<unknown> {
    if (!this.enabled) throw new OwnerWhatsAppError(409, 'owner_send_unavailable');
    if (!mhpActor) throw new OwnerWhatsAppError(403, 'forbidden_scope');
    const context = requestDatabaseContext({ workspaceId: MHP_MARKETING_WORKSPACE_ID, userId: mhpActor.userId, requestId });
    const one = (sql: string, values: unknown[]) => this.runner.run(context, async tx => {
      const { rows } = await tx.query<{ r: unknown }>(sql, values);
      return rows[0]?.r ?? null;
    }).catch(mapError);
    const contactId = () => uuid(input.contactId);
    const linkId = () => uuid(input.linkId);
    let result: unknown;
    switch (action) {
      case 'whatsappOwnerState':
        result = await one('/* ghq.wa-owner.state */ SELECT app_private.mhp_wa_owner_contact_state($1::uuid,$2::uuid) AS r', [origin.workspaceId, contactId()]);
        break;
      case 'whatsappOwnerTemplates':
        result = await one('/* ghq.wa-owner.templates */ SELECT app_private.mhp_wa_owner_templates_list() AS r', []);
        break;
      case 'whatsappOwnerPreview': {
        const meta = text(input.metaTemplateId, 30);
        if (!META_ID.test(meta)) throw new OwnerWhatsAppError(400, 'invalid_request');
        result = await one('/* ghq.wa-owner.preview */ SELECT app_private.mhp_wa_owner_preview($1,$2::jsonb) AS r', [meta, JSON.stringify(variables(input.variables))]);
        break;
      }
      case 'whatsappOwnerLink': {
        const point = input.pointId == null ? null : uuid(input.pointId);
        const number = input.number == null ? null : text(input.number, 32, 7);
        if ((point === null) === (number === null)) throw new OwnerWhatsAppError(400, 'invalid_request');
        result = await one('/* ghq.wa-owner.link */ SELECT app_private.mhp_wa_owner_link($1::uuid,$2,$3::uuid,$4::uuid,$5) AS r',
          [origin.workspaceId, origin.brand, contactId(), point, number]);
        break;
      }
      case 'whatsappOwnerPermission': {
        const decision = text(input.decision, 12);
        if (decision !== 'granted' && decision !== 'withdrawn') throw new OwnerWhatsAppError(400, 'invalid_request');
        const basis = decision === 'granted' ? text(input.lawfulBasis, 40) : null;
        const kind = decision === 'granted' ? text(input.evidenceKind, 40) : null;
        const note = decision === 'granted' ? text(input.note, 500, 1) : null;
        if (basis !== null && !['consent', 'legitimate_interests'].includes(basis)) throw new OwnerWhatsAppError(400, 'invalid_request');
        if (kind !== null && !['asked_to_be_contacted', 'written_consent', 'business_introduction', 'existing_client'].includes(kind)) {
          throw new OwnerWhatsAppError(400, 'invalid_request');
        }
        result = await one('/* ghq.wa-owner.permission */ SELECT app_private.mhp_wa_owner_set_permission($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6,$7,$8,$9) AS r',
          [origin.workspaceId, contactId(), linkId(), uuid(input.commandId), decision, basis, kind, note, decision === 'granted' && input.attestNumber === true]);
        break;
      }
      case 'whatsappOwnerSendTemplate': {
        const meta = text(input.metaTemplateId, 30);
        const preview = text(input.previewSha256, 64).toLowerCase();
        if (!META_ID.test(meta) || !SHA.test(preview)) throw new OwnerWhatsAppError(400, 'invalid_request');
        result = await one(`/* ghq.wa-owner.send-template */ SELECT app_private.mhp_wa_owner_queue_template($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6::jsonb,decode($7,'hex')) AS r`,
          [origin.workspaceId, contactId(), uuid(input.idempotencyKey), linkId(), meta, JSON.stringify(variables(input.variables)), preview]);
        break;
      }
      case 'whatsappOwnerSendText': {
        const body = text(input.body, 4096);
        if (!body.trim() || Buffer.byteLength(body) > 4096) throw new OwnerWhatsAppError(400, 'invalid_request');
        result = await one('/* ghq.wa-owner.send-text */ SELECT app_private.mhp_wa_owner_queue_text($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5) AS r',
          [origin.workspaceId, contactId(), uuid(input.idempotencyKey), linkId(), body]);
        break;
      }
      case 'whatsappOwnerStatus': {
        const status = await one('/* ghq.wa-owner.status */ SELECT app_private.mhp_wa_owner_send_status($1::uuid) AS r', [uuid(input.sendId)]);
        // A send is only visible from the brand it was made for.
        result = record(status) && status.originWorkspaceId === origin.workspaceId ? status : { state: 'not_found' };
        break;
      }
    }
    if (record(result) && result.state === 'conflict') throw new OwnerWhatsAppError(409, 'request_conflict');
    return { brand: origin.brand, workspaceId: origin.workspaceId, sender: 'Martin Howard Property', result: explain(result) };
  }
}

