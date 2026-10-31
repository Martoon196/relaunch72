/** One owned-number possession check, isolated from marketing SMS dispatch. */
import { createHash, randomInt } from 'node:crypto';
import type { Pool, QueryResultRow } from 'pg';
import { withTransaction } from '../db/transaction.js';
import type { TwilioMessagingSmsTransport } from '../sms-live/foundation.js';
import { TWILIO_SMS_PROVIDER_ID } from '../sms-live/foundation.js';

interface ChallengeRow extends QueryResultRow {
  challengeId: unknown;
  phoneE164: unknown;
}
interface BooleanRow extends QueryResultRow { applied: unknown }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const UK_PHONE = /^\+44[0-9]{9,10}$/u;
const MESSAGE_SID = /^SM[0-9a-f]{32}$/u;

export interface SmsPhoneVerificationBinding {
  readonly workspaceId: string;
  readonly connectionId: string;
  readonly phone: string;
  readonly displayBrand?: string;
}

export function smsVerificationDisplayBrand(value?: string): string {
  const brand = value ?? 'Property Predator';
  if (!/^[A-Za-z][A-Za-z0-9 ]{1,59}$/u.test(brand) || brand !== brand.trim()) {
    throw new Error('SMS verification display brand is invalid');
  }
  return brand;
}

export type SmsPhoneVerificationCycle = 'idle' | 'sent' | 'failed_or_attention';

export async function runSmsPhoneVerificationOnce(
  pool: Pick<Pool, 'connect'>,
  transport: Pick<TwilioMessagingSmsTransport, 'send'>,
  binding: SmsPhoneVerificationBinding,
): Promise<SmsPhoneVerificationCycle> {
  if (!UUID.test(binding.workspaceId) || !UUID.test(binding.connectionId)
      || !UK_PHONE.test(binding.phone)) throw new Error('SMS verification binding is invalid');
  const displayBrand = smsVerificationDisplayBrand(binding.displayBrand);
  const context = (suffix: string) => ({
    actorKind: 'worker' as const,
    workspaceId: binding.workspaceId,
    requestId: `sms:phone-verification:${suffix}`,
  });
  const rows = await withTransaction(pool, context('claim'), async (tx) => (
    await tx.query<ChallengeRow>(
      `SELECT challenge_id AS "challengeId", phone_e164 AS "phoneE164"
       FROM app_private.claim_sms_phone_challenge($1::uuid,$2::uuid,$3::text)`,
      [binding.workspaceId, binding.connectionId, binding.phone],
    )).rows, { isolation: 'serializable' });
  if (rows.length === 0) return 'idle';
  if (rows.length !== 1 || typeof rows[0]?.challengeId !== 'string'
      || !UUID.test(rows[0].challengeId) || rows[0].phoneE164 !== binding.phone) {
    throw new Error('SMS verification claim was not exact');
  }
  const challengeId = rows[0].challengeId;
  const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
  const armed = await withTransaction(pool, context(`arm:${challengeId}`), async (tx) => (
    await tx.query<BooleanRow>(
      `SELECT app_private.arm_sms_phone_challenge($1::uuid,$2::uuid,$3::text) AS applied`,
      [binding.workspaceId, challengeId, code],
    )).rows[0]?.applied, { isolation: 'serializable' });
  if (armed !== true) throw new Error('SMS verification arm did not apply');

  const idempotencyKey = createHash('sha256')
    .update(`propertypredator.sms-phone-verification/v1:${challengeId}`).digest('hex');
  let state: 'sent' | 'failed' | 'needs_attention' = 'needs_attention';
  let providerSid: string | null = null;
  try {
    const result = await transport.send({
      workspaceId: binding.workspaceId,
      connectionId: binding.connectionId,
      providerId: TWILIO_SMS_PROVIDER_ID,
      operationId: challengeId,
      idempotencyKey,
      correlationId: challengeId,
    }, {
      recipient: binding.phone,
      body: `${displayBrand} verification code: ${code}. Expires in 10 minutes.`,
      expectedSegmentCount: 1,
      idempotencySha256: idempotencyKey,
    });
    if (result.status === 'accepted' && typeof result.externalId === 'string'
        && MESSAGE_SID.test(result.externalId)) {
      state = 'sent';
      providerSid = result.externalId;
    } else if (result.status === 'failed') {
      state = 'failed';
    }
  } catch {
    // A timeout or transport exception may occur after Twilio accepted the
    // request. Never retry this challenge or claim that the code was sent.
    state = 'needs_attention';
  }
  const settled = await withTransaction(pool, context(`settle:${challengeId}`), async (tx) => (
    await tx.query<BooleanRow>(
      `SELECT app_private.settle_sms_phone_challenge(
         $1::uuid,$2::uuid,$3::text,$4::text
       ) AS applied`,
      [binding.workspaceId, challengeId, state, providerSid],
    )).rows[0]?.applied, { isolation: 'serializable' });
  if (settled !== true) throw new Error('SMS verification settlement did not apply');
  return state === 'sent' ? 'sent' : 'failed_or_attention';
}
