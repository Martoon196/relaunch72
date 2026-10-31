/** MHP009B: one public webinar opt-in code per cycle. No marketing text is sent here. */
import { createHash, randomInt } from 'node:crypto';
import type { Pool, QueryResultRow } from 'pg';
import { withTransaction } from '../db/transaction.js';
import type { TwilioMessagingSmsTransport } from '../sms-live/foundation.js';
import { TWILIO_SMS_PROVIDER_ID } from '../sms-live/foundation.js';

export const MHP_EVENT_SMS_WORKSPACE_ID = '2789228d-55a6-4688-b1e8-2f70abca990b';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const UK_MOBILE = /^\+447[0-9]{9}$/u;
const MESSAGE_SID = /^SM[0-9a-f]{32}$/u;
interface ClaimRow extends QueryResultRow { optinId: unknown; phoneE164: unknown }
interface BooleanRow extends QueryResultRow { applied: unknown }

export function mhpEventSmsCodesEnabled(env: NodeJS.ProcessEnv, workspaceId: string): boolean {
  return env.MHP_EVENT_SMS_CODES_ENABLED === 'true' && workspaceId === MHP_EVENT_SMS_WORKSPACE_ID;
}
/**
 * A STOP sent in reply to a code cannot be recorded by the unchanged inbound
 * rail, so codes need the operator's attestation that Twilio Advanced Opt-Out
 * is on for the MHP Messaging Service, and a poll fast enough to send a full
 * 10-person owner batch inside its 4-minute authority.
 */
export function assertMhpEventSmsCodePreconditions(env: NodeJS.ProcessEnv, pollIntervalMs: number): void {
  if (env.MHP_EVENT_SMS_TWILIO_ADVANCED_OPT_OUT_CONFIRMED !== 'true') {
    throw new Error('MHP webinar codes need MHP_EVENT_SMS_TWILIO_ADVANCED_OPT_OUT_CONFIRMED=true');
  }
  if (pollIntervalMs > 15_000) throw new Error('MHP webinar codes need PROPERTY_PREDATOR_SMS_LIVE_POLL_MS of 15000 or less');
}
export function mhpEventSmsCodeBody(code: string): string {
  if (!/^[0-9]{6}$/u.test(code)) throw new Error('Invalid code');
  return `Martin Howard Property code: ${code}. Enter it on the webinar texts page within 15 minutes of asking. Not you? Ignore this.`;
}
export type MhpEventSmsCodeCycle = 'idle' | 'sent' | 'failed_or_attention';

/** Claim, arm, send once, settle. An uncertain provider outcome is never retried. */
export async function runMhpEventSmsCodeOnce(pool: Pick<Pool, 'connect'>, transport: Pick<TwilioMessagingSmsTransport, 'send'>,
  binding: { workspaceId: string; connectionId: string }): Promise<MhpEventSmsCodeCycle> {
  if (binding.workspaceId !== MHP_EVENT_SMS_WORKSPACE_ID || !UUID.test(binding.connectionId)) throw new Error('MHP event SMS code binding is invalid');
  const context = (suffix: string) => ({ actorKind: 'worker' as const, workspaceId: binding.workspaceId, requestId: `sms:mhp-event-code:${suffix}` });
  const rows = await withTransaction(pool, context('claim'), async tx => (await tx.query<ClaimRow>(
    'SELECT optin_id AS "optinId", phone_e164 AS "phoneE164" FROM app_private.mhp_event_sms_code_claim($1::uuid,$2::uuid)',
    [binding.workspaceId, binding.connectionId])).rows, { isolation: 'read committed' });
  if (rows.length === 0) return 'idle';
  const optinId = rows[0]?.optinId, phone = rows[0]?.phoneE164;
  if (rows.length !== 1 || typeof optinId !== 'string' || !UUID.test(optinId) || typeof phone !== 'string' || !UK_MOBILE.test(phone)) {
    throw new Error('MHP event SMS code claim was not exact');
  }
  const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
  const armed = await withTransaction(pool, context(`arm:${optinId}`), async tx => (await tx.query<BooleanRow>(
    'SELECT app_private.mhp_event_sms_code_arm($1::uuid,$2::uuid,$3::text) AS applied', [binding.workspaceId, optinId, code])).rows[0]?.applied,
  { isolation: 'serializable' });
  if (armed !== true) throw new Error('MHP event SMS code arm did not apply');
  const idempotencyKey = createHash('sha256').update(`mhp.event-sms-code/v1:${optinId}`).digest('hex');
  let state: 'sent' | 'failed' | 'needs_attention' = 'needs_attention';
  let providerSid: string | null = null;
  try {
    const result = await transport.send({ workspaceId: binding.workspaceId, connectionId: binding.connectionId, providerId: TWILIO_SMS_PROVIDER_ID,
      operationId: optinId, idempotencyKey, correlationId: optinId },
    { recipient: phone, body: mhpEventSmsCodeBody(code), expectedSegmentCount: 1, idempotencySha256: idempotencyKey });
    if (result.status === 'accepted' && typeof result.externalId === 'string' && MESSAGE_SID.test(result.externalId)) {
      state = 'sent'; providerSid = result.externalId;
    } else if (result.status === 'failed') state = 'failed';
  } catch {
    // Twilio may have accepted before the exception. Never resend this code.
    state = 'needs_attention';
  }
  const settled = await withTransaction(pool, context(`settle:${optinId}`), async tx => (await tx.query<BooleanRow>(
    'SELECT app_private.mhp_event_sms_code_settle($1::uuid,$2::uuid,$3::text,$4::text) AS applied',
    [binding.workspaceId, optinId, state, providerSid])).rows[0]?.applied, { isolation: 'serializable' });
  if (settled !== true) throw new Error('MHP event SMS code settlement did not apply');
  return state === 'sent' ? 'sent' : 'failed_or_attention';
}
