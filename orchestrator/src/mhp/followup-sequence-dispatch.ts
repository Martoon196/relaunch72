import type { Pool } from 'pg';
import { PgMhpOwnerEmailDispatch, parseMhpOwnerEmailLeases, parseMhpOwnerEmailPrepared, type MhpOwnerEmailDispatch, type MhpOwnerEmailLease } from './owner-email-dispatch.js';
import { parseMhpOwnerEmailBrand, renderMhpOwnerEmail } from './owner-email-content.js';
import { mhpUnsubscribeUrl } from './growth-service.js';
import type { MhpRenderedMarketingSender } from './marketing-mail.js';
import type { FollowupEntrySweepResult } from '../followup-sequences/entry.js';
import { EmailGuardUnavailableError, EmailRecipientBlockedError, refusalStopsPerson } from '../email-bounces/policy.js';
import { mhpRecipientsAvailable } from './marketing-mail.js';

export interface MhpSequenceDispatch extends MhpOwnerEmailDispatch {
  unknown(lease: MhpOwnerEmailLease): Promise<void>;
  enrolCaptures?(limit: number): Promise<FollowupEntrySweepResult>;
}
export class PgMhpSequenceDispatch implements MhpSequenceDispatch {
  private readonly owner: PgMhpOwnerEmailDispatch;
  constructor(private readonly pool: Pick<Pool, 'query'>) { this.owner = new PgMhpOwnerEmailDispatch(pool); }
  async claim(limit: number, leaseSeconds: number, onlyEmails: readonly string[] | null) {
    const result = await this.pool.query<{ jobs: unknown }>('SELECT app_private.mhp_sequence_claim_v2($1,$2,$3) AS jobs', [limit, leaseSeconds, onlyEmails ? [...onlyEmails] : null]);
    return parseMhpOwnerEmailLeases(result.rows[0]?.jobs, limit);
  }
  async prepare(lease: MhpOwnerEmailLease) {
    const result = await this.pool.query<{ prepared: unknown }>('SELECT app_private.mhp_sequence_prepare_v2($1,$2) AS prepared', [lease.id, lease.leaseId]);
    return parseMhpOwnerEmailPrepared(result.rows[0]?.prepared, lease);
  }
  settle(lease: MhpOwnerEmailLease, accepted: boolean, reference: string | null): Promise<void> { return this.owner.settle(lease, accepted, reference); }
  async unknown(lease: MhpOwnerEmailLease): Promise<void> { await this.pool.query('SELECT app_private.mhp_sequence_unknown($1,$2)', [lease.id, lease.leaseId]); }
  async enrolCaptures(limit: number): Promise<FollowupEntrySweepResult> {
    const result = await this.pool.query<{ value: FollowupEntrySweepResult }>('SELECT app_private.mhp_sequence_enrol_captures($1) AS value', [limit]);
    const value = result.rows[0]?.value;
    if (!value || ![value.processed, value.enrolled, value.alreadyEnrolled, value.blocked, value.skipped, value.heldRules].every(n => Number.isSafeInteger(n) && n >= 0)
        || value.processed > limit) throw new Error('Invalid capture entry sweep result');
    return value;
  }
}

/** Phase-aware: every unclassified post-proof failure is unknown, never a definite rejection/retry. */
export async function dispatchMhpSequenceEmails(input: { queue: MhpSequenceDispatch; sender: MhpRenderedMarketingSender; unsubscribeSecret: string;
  testRecipients: readonly string[] | null; stopped?: () => boolean; now?: () => number;
  onEntryResult?: (result: FollowupEntrySweepResult) => void; onEntryError?: () => void;
  onBlocked?: (prospectId: string) => Promise<void> }): Promise<{ sent: number; failed: number; unknown: number }> {
  let sent = 0, failed = 0, unknown = 0;
  if (input.queue.enrolCaptures && !input.stopped?.()) {
    try { const result = await input.queue.enrolCaptures(100); try { input.onEntryResult?.(result); } catch { /* telemetry only */ } }
    catch { try { input.onEntryError?.(); } catch { /* Entry failure must not starve existing due runs. */ } }
  }
  // Claims spend attempts; while the durable block list cannot be read, claim nothing (tried again next sweep).
  if (!await mhpRecipientsAvailable(input.sender)) return { sent, failed, unknown };
  let unavailable = false;
  for (let page = 0; page < 4 && !input.stopped?.() && !unavailable; page++) {
    const batch = await input.queue.claim(25, 120, input.testRecipients);
    for (const lease of batch) {
      // The block list went away after this sweep's probe: leave the rest of the claimed batch unsettled. Their attempts
      // were counted at claim; their leases expire (2 minutes) and they are claimed again by a later sweep.
      if (unavailable) break;
      let proofIssued = false, prospectId: string | null = null;
      try {
        const prepared = await input.queue.prepare(lease);
        if (!prepared) continue;
        proofIssued = true; prospectId = prepared.prospectId;
        if (Date.parse(prepared.leaseUntil) <= (input.now?.() ?? Date.now()) + 11_000) throw new Error('Sequence proof is expiring');
        const rendered = renderMhpOwnerEmail({ canonicalContent: prepared.exact.canonicalContent, contentSha256: prepared.exact.contentSha256,
          brand: parseMhpOwnerEmailBrand(prepared.exact.brand), firstName: prepared.firstName,
          label: typeof prepared.context.label === 'string' ? prepared.context.label : 'Webinar',
          link: typeof prepared.context.link === 'string' ? prepared.context.link : '', unsubscribe: mhpUnsubscribeUrl(input.unsubscribeSecret, prepared.prospectId) });
        const reference = await input.sender.sendRendered({ id: prepared.id, email: prepared.email, tag: 'owner_sequence', rendered, prospectId: prepared.prospectId });
        await input.queue.settle(lease, true, reference); sent++;
      } catch (error) {
        if (error instanceof EmailGuardUnavailableError) unavailable = true;
        if (error instanceof EmailRecipientBlockedError && prospectId) {
          // Classified and definite: the sender refused before any provider call, so nothing can have been delivered.
          // The proof is closed as not accepted. A dead address also stops the person, so the next claim ends the run
          // as 'unsubscribed'; any other block is refused again at each retry and the run fails by rule after five.
          failed++;
          if (refusalStopsPerson(error.reason)) {
            try { await input.onBlocked?.(prospectId); } catch { /* Still refused here; the stop is retried at the next attempt. */ }
          }
          try { await input.queue.settle(lease, false, null); }
          catch { try { await input.queue.unknown(lease); } catch { /* The open proof fences the run until an owner looks. */ } }
          continue;
        }
        if (proofIssued) { unknown++; try { await input.queue.unknown(lease); } catch { /* Unresolved durable proof fences retry after lease expiry. */ } }
        else failed++;
        // A proof may also have committed before a failed DB response. Claim detects
        // that durable unknown proof; this path never records a false rejection.
      }
    }
    if (batch.length < 25) break;
  }
  return { sent, failed, unknown };
}
