/**
 * Shared pieces for bringing MHP sign-ups (webinar registrations, book interest) into the MHP brand CRM's
 * "New enquiry" stage through the CRM's own command layer (crm.createLead). Nothing here writes a CRM row
 * itself: it reads the receipt the command left, finds the default enquiries pipeline's first open stage by
 * lookup, signs the owner's batch cursor, and runs createLead with the "only our own completed receipt proves
 * success" rule the webinar import has always used.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { CrmCommandService } from '../crm-pg/commands.js';
import type { CreateLeadCommand, CreateLeadResult, CrmTransactionRunner } from '../crm-pg/types.js';
import type { DatabaseRequestContext } from '../db/rls.js';
import type { PortalSessionIdentity } from '../portal/auth-service.js';
import { MhpCommerceError } from './commerce-service.js';

export const SIGNUP_LEAD_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
export const SIGNUP_LEAD_BATCH_SIZE = 25;
const CURSOR_LIFETIME_MS = 30 * 60_000;
const sha = (value: string): Buffer => createHash('sha256').update(value).digest();
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** A sign-up audience: its SQL comment tag, cursor domain and the words its owner screen uses. */
export interface SignupLeadAudience {
  /** SQL comment tag, e.g. `webinar` gives `/* mhp.webinar-recorded-lead *\/`. */
  tag: string;
  /** HMAC domain of the owner's batch cursor. */
  cursorDomain: string;
  /** Bound into the cursor MAC: a cursor for one audience or campaign is refused by another. */
  cursorScope: string;
  /** Shown when a cursor is stale, forged or for another audience. */
  refreshMessage: string;
}

function completedResult(value: unknown): CreateLeadResult {
  if (!record(value) || !['applied', 'replayed'].includes(String(value.disposition))
      || typeof value.contactId !== 'string' || !SIGNUP_LEAD_UUID.test(value.contactId)
      || typeof value.opportunityId !== 'string' || !SIGNUP_LEAD_UUID.test(value.opportunityId)
      || !(value.taskId === null || (typeof value.taskId === 'string' && SIGNUP_LEAD_UUID.test(value.taskId)))
      || typeof value.createdContact !== 'boolean') throw new Error('Invalid recorded lead result');
  return { disposition: 'replayed', contactId: value.contactId, opportunityId: value.opportunityId,
    taskId: value.taskId, createdContact: value.createdContact };
}

/** The actor's own completed crm.createLead receipt for this key, as a replay; null when there is none yet. */
export function recordedSignupLead(transactions: CrmTransactionRunner, context: DatabaseRequestContext, audience: Pick<SignupLeadAudience, 'tag'>,
  key: string): Promise<CreateLeadResult | null> {
  return transactions.run(context, async transaction => {
    const result = await transaction.query<{ status: string; result: unknown }>(
      `/* mhp.${audience.tag}-recorded-lead */ SELECT status,result FROM app.command_receipts
       WHERE workspace_id=app_private.current_workspace_id() AND actor_user_id=$1
        AND command_name='crm.createLead' AND idempotency_key=$2`, [context.userId, key]);
    if (result.rows.length === 0) return null;
    if (result.rows.length !== 1 || result.rows[0]!.status !== 'succeeded') throw new Error('Lead import receipt is not complete');
    return completedResult(result.rows[0]!.result);
  });
}

/** The default "enquiries" pipeline's "new" open stage, found by lookup (never by a stored id). */
export function newEnquiryStage(transactions: CrmTransactionRunner, context: DatabaseRequestContext,
  audience: Pick<SignupLeadAudience, 'tag'>): Promise<{ pipelineId: string; stageId: string }> {
  return transactions.run(context, async transaction => {
    const result = await transaction.query<{ pipelineId: string; stageId: string }>(
      `/* mhp.${audience.tag}-new-stage */ SELECT p.id AS "pipelineId",s.id AS "stageId"
       FROM app.pipelines p JOIN app.pipeline_stages s ON s.workspace_id=p.workspace_id AND s.pipeline_id=p.id
       WHERE p.workspace_id=app_private.current_workspace_id() AND p.slug::text='enquiries'
        AND p.status='active' AND p.is_default AND s.slug::text='new' AND s.stage_type='open' AND NOT s.is_terminal`);
    if (result.rows.length !== 1 || !SIGNUP_LEAD_UUID.test(result.rows[0]!.pipelineId) || !SIGNUP_LEAD_UUID.test(result.rows[0]!.stageId)) throw new Error('New enquiry stage unavailable');
    return result.rows[0]!;
  });
}

/**
 * createLead, or the replay of an earlier success. Two devices or processes may build different commands for the same
 * key before either receipt exists, and a conflict can fail before the core command exposes a typed hash error. Only the
 * actor's own completed receipt proves success; otherwise the original command failure is kept.
 */
export async function createOrReplaySignupLead(input: {
  transactions: CrmTransactionRunner; commands: Pick<CrmCommandService, 'createLead'>; context: DatabaseRequestContext;
  audience: Pick<SignupLeadAudience, 'tag'>; command: CreateLeadCommand;
}): Promise<CreateLeadResult> {
  try {
    return await input.commands.createLead(input.context, input.command);
  } catch (error) {
    try {
      const winner = await recordedSignupLead(input.transactions, input.context, input.audience, input.command.commandKey);
      if (winner) return winner;
    } catch { /* An unavailable, revoked or invalid receipt cannot prove success. */ }
    throw error;
  }
}

function cursorMac(secret: string, audience: SignupLeadAudience, identity: PortalSessionIdentity, payload: string): Buffer {
  return createHmac('sha256', secret).update(`${audience.cursorDomain}\0`)
    .update(identity.userId).update('\0').update(identity.workspaceId).update('\0').update(sha(identity.sessionToken))
    .update('\0').update(audience.cursorScope).update('\0').update(payload).digest();
}

/** A 30-minute cursor bound to this owner, session, workspace and audience. */
export function signSignupLeadCursor(secret: string, audience: SignupLeadAudience, identity: PortalSessionIdentity, after: string | null, now: number): string {
  const payload = Buffer.from(JSON.stringify({ after, expiresAt: now + CURSOR_LIFETIME_MS })).toString('base64url');
  return `${payload}.${cursorMac(secret, audience, identity, payload).toString('base64url')}`;
}

/** The position a signed cursor carries; '' is the start. Anything stale or forged is refused with the audience's message. */
export function readSignupLeadCursor(secret: string, audience: SignupLeadAudience, identity: PortalSessionIdentity, cursor: string, now: number): string | null {
  if (cursor === '') return null;
  if (cursor.length > 300 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/u.test(cursor)) throw new MhpCommerceError(400, audience.refreshMessage);
  const [payload, signature] = cursor.split('.');
  const supplied = Buffer.from(signature!, 'base64url');
  if (!timingSafeEqual(supplied, cursorMac(secret, audience, identity, payload!))) throw new MhpCommerceError(400, audience.refreshMessage);
  let value: unknown;
  try { value = JSON.parse(Buffer.from(payload!, 'base64url').toString('utf8')); } catch { value = null; }
  if (!record(value) || !(value.after === null || (typeof value.after === 'string' && SIGNUP_LEAD_UUID.test(value.after)))
      || typeof value.expiresAt !== 'number' || value.expiresAt < now || value.expiresAt > now + CURSOR_LIFETIME_MS
      || Object.keys(value).sort().join(',') !== 'after,expiresAt') throw new MhpCommerceError(400, audience.refreshMessage);
  return value.after;
}
