/**
 * Writes LeadRelay enquiries and call results into one brand's CRM.
 *
 * Identity and RLS: every write runs on the CRM command database identity (r72_crm_command) as the brand's
 * configured owner user, through the same runner the Group HQ inbox bridge uses, which re-checks in every
 * transaction that this user may still manage the workspace. No policy is widened and no new identity exists.
 *
 * Idempotency: each LeadRelay lead and each LeadRelay event is claimed once in app.command_receipts (the
 * owner's own receipts, keyed by a digest of the LeadRelay workspace and record id), in the same transaction
 * as its writes. Reprocessing a row returns the stored result and writes nothing.
 *
 * What it never does: send anything, enrol anyone, set a contact point's consent_status (copied points stay
 * 'unknown'), or record a stop on any channel other than phone. A "do not call" becomes one calls-only
 * suppression on the exact phone point LeadRelay called.
 */

import { createHash, randomUUID } from 'node:crypto';
import { requestDatabaseContext, type DatabaseRequestContext } from '../../db/rls.js';
import { CrmCommandService } from '../../crm-pg/commands.js';
import { CommandInProgressError, IdempotencyKeyReusedError, InvalidCrmStateError } from '../../crm-pg/errors.js';
import { CrmPgRepository } from '../../crm-pg/repository.js';
import type { CrmTransactionRunner, SqlExecutor } from '../../crm-pg/types.js';

export const LEAD_COMMAND = 'leadrelay.lead';
export const EVENT_COMMAND = 'leadrelay.event';
export const SUPPRESSION_SOURCE = 'leadrelay';
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

export interface LeadRelayCrmScope { workspaceId: string; ownerUserId: string; pipelineId: string; stageId: string }

export interface CopyableLead {
  displayName: string; companyName: string | null; email: string | null; phone: string | null;
  /** Already formatted as leadrelay:<source>. */
  source: string;
}
export type EnquiryOutcome =
  | { outcome: 'created' | 'timeline'; contactId: string; replayed: boolean }
  | { outcome: 'needs_owner'; reason: 'two_contacts' | 'archived_contact'; replayed: boolean };

export interface TimelineEvent {
  eventKey: string; leadKey: string; leadRelayEventId: string;
  activityType: 'leadrelay.call_result' | 'leadrelay.do_not_call' | 'leadrelay.note';
  subject: string; body: string | null; occurredAt: string;
  metadata: Readonly<Record<string, string | number | boolean | null>>;
  /** Record a calls-only suppression on the phone point LeadRelay called. */
  doNotCall: boolean;
}
export type TimelineOutcome =
  | { outcome: 'written'; contactId: string; doNotCall: 'recorded' | 'no_number' | null; replayed: boolean }
  | { outcome: 'not_copied'; replayed: boolean };

export interface LeadRelayCrmWriter {
  copyEnquiry(input: { leadKey: string; lead: CopyableLead; occurredAt: string }): Promise<EnquiryOutcome>;
  recordTimeline(input: TimelineEvent): Promise<TimelineOutcome>;
}

/** Same normalisation as the CRM's own createLead, so exact matching means the same thing in both places. */
export function normalisedEmail(value: string | null): string | null {
  const email = value?.trim().toLowerCase() ?? '';
  return email && email.length <= 320 && EMAIL.test(email) ? email : null;
}
export function normalisedPhone(value: string | null): string | null {
  let number = (value ?? '').trim().replace(/[\s().-]/gu, '');
  if (number.startsWith('00')) number = `+${number.slice(2)}`;
  return /^\+?\d{7,15}$/u.test(number) ? number : null;
}

interface MappingResult { outcome: 'created' | 'timeline' | 'needs_owner'; contactId?: string; reason?: string; phonePointId?: string | null }
interface EventResult { outcome: 'written' | 'not_copied'; contactId?: string; doNotCall?: 'recorded' | 'no_number' | null }

const keyHash = (key: string): Buffer => createHash('sha256').update(key).digest();
class CreateInstead extends Error {}

export class PgLeadRelayCrmWriter implements LeadRelayCrmWriter {
  private readonly commands: CrmCommandService;
  private readonly now: () => Date;
  constructor(private readonly runner: CrmTransactionRunner, private readonly scope: LeadRelayCrmScope, options: { now?: () => Date } = {}) {
    this.now = options.now ?? (() => new Date());
    this.commands = new CrmCommandService({ transactionRunner: runner, now: this.now });
  }

  private context(): DatabaseRequestContext {
    return requestDatabaseContext({ workspaceId: this.scope.workspaceId, userId: this.scope.ownerUserId, requestId: `leadrelay-feed:${randomUUID()}` });
  }

  private async receipt(tx: SqlExecutor, commandName: string, key: string): Promise<{ status: string; result: unknown } | null> {
    const found = await tx.query<{ status: string; result: unknown }>(`/* leadrelay.feed.receipt */
      SELECT status, result FROM app.command_receipts
       WHERE workspace_id = app_private.current_workspace_id() AND actor_user_id = $1 AND command_name = $2 AND idempotency_key = $3`,
      [this.scope.ownerUserId, commandName, key]);
    return found.rows[0] ?? null;
  }

  /** Claim, run and complete one receipt in the caller's transaction. A finished receipt is returned as a replay. */
  private async once<T>(tx: SqlExecutor, context: DatabaseRequestContext, commandName: string, key: string,
                        write: () => Promise<T>): Promise<{ result: T; replayed: boolean }> {
    const repository = new CrmPgRepository(tx);
    const payloadHash = keyHash(`${commandName}\n${key}`);
    const claim = await repository.claimCommand({ id: randomUUID(), commandName, commandKey: key, requestId: context.requestId,
      actorUserId: this.scope.ownerUserId, payloadHash, createdAt: this.now().toISOString() });
    if (!Buffer.from(claim.payloadHash).equals(payloadHash)) throw new IdempotencyKeyReusedError();
    if (!claim.inserted) {
      if (claim.status !== 'succeeded') throw new CommandInProgressError();
      return { result: claim.result as T, replayed: true };
    }
    const result = await write();
    await repository.completeCommand({ receiptId: claim.id, payloadHash, result, completedAt: this.now().toISOString() });
    return { result, replayed: false };
  }

  private async activity(tx: SqlExecutor, context: DatabaseRequestContext, input: { contactId: string; opportunityId?: string | null;
    activityType: string; subject: string; body: string | null; metadata: Record<string, unknown>; occurredAt: string }): Promise<void> {
    const id = randomUUID();
    // The CRM requires an activity never to claim a time after it was recorded.
    const recordedAt = this.now();
    const occurred = new Date(input.occurredAt);
    const occurredAt = Number.isFinite(occurred.getTime()) && occurred <= recordedAt ? occurred : recordedAt;
    await tx.query(`/* leadrelay.feed.activity */ INSERT INTO app.activities
      (id,workspace_id,contact_id,opportunity_id,activity_type,channel,actor_kind,actor_user_id,subject,body,metadata,request_id,correlation_id,occurred_at,created_at)
      VALUES($1::uuid,app_private.current_workspace_id(),$2::uuid,$3::uuid,$4,'crm','user',$5::uuid,$6,$7,$8::jsonb,$9,$10,$11::timestamptz,$12::timestamptz)`,
      [id, input.contactId, input.opportunityId ?? null, input.activityType, this.scope.ownerUserId, input.subject.slice(0, 500), input.body,
       JSON.stringify({ source: 'leadrelay', ...input.metadata }), context.requestId, id, occurredAt.toISOString(), recordedAt.toISOString()]);
  }

  private async phonePoint(tx: SqlExecutor, contactId: string, phone: string | null): Promise<string | null> {
    if (!phone) return null;
    const found = await tx.query<{ id: string }>(`/* leadrelay.feed.phone-point */
      SELECT id FROM app.contact_points WHERE workspace_id = app_private.current_workspace_id() AND contact_id = $1::uuid
         AND kind = 'phone' AND normalized_value = $2 AND deleted_at IS NULL AND dedupe_state = 'normal' LIMIT 1`, [contactId, phone]);
    return found.rows[0]?.id ?? null;
  }

  private enquiryOutcome(result: MappingResult, replayed: boolean): EnquiryOutcome {
    if (result.outcome === 'needs_owner') return { outcome: 'needs_owner', reason: result.reason === 'archived_contact' ? 'archived_contact' : 'two_contacts', replayed };
    return { outcome: result.outcome, contactId: String(result.contactId), replayed };
  }

  async copyEnquiry(input: { leadKey: string; lead: CopyableLead; occurredAt: string }): Promise<EnquiryOutcome> {
    const email = normalisedEmail(input.lead.email), phone = normalisedPhone(input.lead.phone);
    if (!email && !phone) throw new Error('A LeadRelay enquiry needs an email address or a phone number');
    const context = this.context();
    try {
      // Decide and, unless a new lead is needed, write in one transaction. Matching is by exact email and phone only.
      return await this.runner.run(context, async tx => {
        const prior = await this.receipt(tx, LEAD_COMMAND, input.leadKey);
        if (prior?.status === 'succeeded') return this.enquiryOutcome(prior.result as MappingResult, true);
        const repository = new CrmPgRepository(tx);
        const matches = (await Promise.all([email ? repository.findContactPoint('email', email) : null, phone ? repository.findContactPoint('phone', phone) : null]))
          .filter(match => match !== null);
        const contactIds = new Set(matches.map(match => match.contactId));
        let mapping: MappingResult | null = null;
        if (contactIds.size > 1) mapping = { outcome: 'needs_owner', reason: 'two_contacts' };
        else if (matches.some(match => match.contactState !== 'active')) mapping = { outcome: 'needs_owner', reason: 'archived_contact' };
        if (!mapping && contactIds.size === 1) {
          const contactId = matches[0]!.contactId;
          const open = await tx.query<{ id: string }>(`/* leadrelay.feed.open-opportunity */
            SELECT id FROM app.opportunities WHERE workspace_id = app_private.current_workspace_id() AND contact_id = $1::uuid AND status = 'open'
             ORDER BY updated_at DESC, id DESC LIMIT 1`, [contactId]);
          if (open.rows[0]) {
            const opportunityId = open.rows[0].id;
            const { result, replayed } = await this.once<MappingResult>(tx, context, LEAD_COMMAND, input.leadKey, async () => {
              await this.activity(tx, context, { contactId, opportunityId, activityType: 'leadrelay.enquiry', subject: 'New enquiry through LeadRelay',
                body: 'This person already has an open deal, so no second one was created.', metadata: { leadRelaySource: input.lead.source },
                occurredAt: input.occurredAt });
              return { outcome: 'timeline', contactId, phonePointId: await this.phonePoint(tx, contactId, phone) };
            });
            return this.enquiryOutcome(result, replayed);
          }
        }
        if (!mapping) throw new CreateInstead();
        // Two different contacts (or an archived one) own these details: nothing is written to any contact.
        const { result, replayed } = await this.once<MappingResult>(tx, context, LEAD_COMMAND, input.leadKey, async () => mapping!);
        return this.enquiryOutcome(result, replayed);
      });
    } catch (error) {
      if (!(error instanceof CreateInstead)) throw error;
    }
    let contactId: string;
    try {
      const created = await this.commands.createLead(context, {
        commandKey: input.leadKey, displayName: input.lead.displayName, companyName: input.lead.companyName, source: input.lead.source,
        ownerUserId: this.scope.ownerUserId, pipelineId: this.scope.pipelineId, stageId: this.scope.stageId,
        // Copying an enquiry never grants marketing consent.
        contactPoints: [...(email ? [{ kind: 'email' as const, value: email, consentStatus: 'unknown' as const }] : []),
          ...(phone ? [{ kind: 'phone' as const, value: phone, consentStatus: 'unknown' as const }] : [])],
        opportunityName: `LeadRelay enquiry · ${input.lead.displayName}`.slice(0, 200), valueMinor: 0, currency: 'GBP',
      });
      contactId = created.contactId;
    } catch (error) {
      const reason = !(error instanceof InvalidCrmStateError) ? null : /different existing contacts/u.test(error.message) ? 'two_contacts'
        : /archived|deleted contact/u.test(error.message) ? 'archived_contact' : null;
      if (reason) {
        // The details came to belong to two contacts (or an archived one) after the check above.
        return this.runner.run(context, async tx => {
          const { result, replayed } = await this.once<MappingResult>(tx, context, LEAD_COMMAND, input.leadKey, async () => ({ outcome: 'needs_owner', reason }));
          return this.enquiryOutcome(result, replayed);
        });
      }
      if (!(error instanceof IdempotencyKeyReusedError)) throw error;
      // The lead was created on an earlier attempt and LeadRelay's copy has changed since: keep the first.
      const stored = await this.runner.run(context, tx => this.receipt(tx, 'crm.createLead', input.leadKey));
      const id = (stored?.status === 'succeeded' && stored.result && typeof stored.result === 'object') ? (stored.result as { contactId?: unknown }).contactId : null;
      if (typeof id !== 'string') throw error;
      contactId = id;
    }
    return this.runner.run(context, async tx => {
      const { result, replayed } = await this.once<MappingResult>(tx, context, LEAD_COMMAND, input.leadKey,
        async () => ({ outcome: 'created', contactId, phonePointId: await this.phonePoint(tx, contactId, phone) }));
      return this.enquiryOutcome(result, replayed);
    });
  }

  async recordTimeline(input: TimelineEvent): Promise<TimelineOutcome> {
    const context = this.context();
    return this.runner.run(context, async tx => {
      const lead = await this.receipt(tx, LEAD_COMMAND, input.leadKey);
      const mapping = lead?.status === 'succeeded' ? lead.result as MappingResult : null;
      if (!mapping || mapping.outcome === 'needs_owner' || typeof mapping.contactId !== 'string') return { outcome: 'not_copied', replayed: false };
      const contactId = mapping.contactId;
      const { result, replayed } = await this.once<EventResult>(tx, context, EVENT_COMMAND, input.eventKey, async () => {
        const contact = await tx.query(`/* leadrelay.feed.contact */ SELECT id FROM app.contacts
          WHERE workspace_id = app_private.current_workspace_id() AND id = $1::uuid AND deleted_at IS NULL FOR UPDATE`, [contactId]);
        if (contact.rows.length !== 1) return { outcome: 'not_copied' };
        let doNotCall: 'recorded' | 'no_number' | null = null;
        if (input.doNotCall) {
          doNotCall = 'no_number';
          const point = typeof mapping.phonePointId === 'string' ? await tx.query(`/* leadrelay.feed.dnc-point */
            SELECT id FROM app.contact_points WHERE workspace_id = app_private.current_workspace_id() AND id = $1::uuid
               AND contact_id = $2::uuid AND kind = 'phone' AND deleted_at IS NULL`, [mapping.phonePointId, contactId]) : null;
          if (point?.rows.length === 1) {
            // Calls only: channel 'phone', every purpose. SMS, WhatsApp and email keep their own evidence, and
            // the contact point's consent_status is never touched. LeadRelay's event id makes a replay a no-op.
            await tx.query(`/* leadrelay.feed.do-not-call */ INSERT INTO app.communication_suppression_events
              (workspace_id,contact_id,contact_point_id,channel,purpose,state,reason,source,source_event_id,actor_kind,actor_user_id,evidence,occurred_at)
              VALUES(app_private.current_workspace_id(),$1::uuid,$2::uuid,'phone',NULL,'suppressed','do_not_call',$3,$4,'user',$5::uuid,$6::jsonb,$7::timestamptz)
              ON CONFLICT DO NOTHING`,
              [contactId, mapping.phonePointId, SUPPRESSION_SOURCE, input.leadRelayEventId, this.scope.ownerUserId,
               JSON.stringify({ origin: 'leadrelay.call', scope: 'calls_only' }),
               new Date(Math.min(Date.parse(input.occurredAt) || this.now().getTime(), this.now().getTime())).toISOString()]);
            doNotCall = 'recorded';
          }
        }
        const body = doNotCall === 'recorded' ? 'Calls to this number are now blocked in this CRM. Texts, WhatsApp and email are not affected.'
          : doNotCall === 'no_number' ? 'The number LeadRelay called is not on this contact, so no call block was added. Please check this contact.'
          : input.body;
        await this.activity(tx, context, { contactId, activityType: input.activityType, subject: input.subject, body,
          metadata: { ...input.metadata, leadRelayEventId: input.leadRelayEventId }, occurredAt: input.occurredAt });
        return { outcome: 'written', contactId, doNotCall };
      });
      return result.outcome === 'written'
        ? { outcome: 'written', contactId: String(result.contactId), doNotCall: result.doNotCall ?? null, replayed }
        : { outcome: 'not_copied', replayed };
    });
  }
}
