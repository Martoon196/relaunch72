import type { Pool } from 'pg';
import { PgMhpOwnerEmailDispatch, parseMhpOwnerEmailLeases, parseMhpOwnerEmailPrepared, type MhpOwnerEmailDispatch, type MhpOwnerEmailLease } from './owner-email-dispatch.js';
import { parseMhpOwnerEmailBrand, renderMhpOwnerEmail } from './owner-email-content.js';
import { mhpUnsubscribeUrl } from './growth-service.js';
import type { MhpRenderedMarketingSender } from './marketing-mail.js';

export interface MhpSequenceDispatch extends MhpOwnerEmailDispatch { unknown(lease: MhpOwnerEmailLease): Promise<void> }
export class PgMhpSequenceDispatch implements MhpSequenceDispatch {
  private readonly owner: PgMhpOwnerEmailDispatch;
  constructor(private readonly pool: Pick<Pool, 'query'>) { this.owner = new PgMhpOwnerEmailDispatch(pool); }
  async claim(limit: number, leaseSeconds: number, onlyEmails: readonly string[] | null) {
    const result = await this.pool.query<{ jobs: unknown }>('SELECT app_private.mhp_sequence_claim($1,$2,$3) AS jobs', [limit, leaseSeconds, onlyEmails ? [...onlyEmails] : null]);
    return parseMhpOwnerEmailLeases(result.rows[0]?.jobs, limit);
  }
  async prepare(lease: MhpOwnerEmailLease) {
    const result = await this.pool.query<{ prepared: unknown }>('SELECT app_private.mhp_sequence_prepare($1,$2) AS prepared', [lease.id, lease.leaseId]);
    return parseMhpOwnerEmailPrepared(result.rows[0]?.prepared, lease);
  }
  settle(lease: MhpOwnerEmailLease, accepted: boolean, reference: string | null): Promise<void> { return this.owner.settle(lease, accepted, reference); }
  async unknown(lease: MhpOwnerEmailLease): Promise<void> { await this.pool.query('SELECT app_private.mhp_sequence_unknown($1,$2)', [lease.id, lease.leaseId]); }
}

/** Phase-aware: every unclassified post-proof failure is unknown, never a definite rejection/retry. */
export async function dispatchMhpSequenceEmails(input: { queue: MhpSequenceDispatch; sender: MhpRenderedMarketingSender; unsubscribeSecret: string;
  testRecipients: readonly string[] | null; stopped?: () => boolean; now?: () => number }): Promise<{ sent: number; failed: number; unknown: number }> {
  let sent = 0, failed = 0, unknown = 0;
  for (let page = 0; page < 4 && !input.stopped?.(); page++) {
    const batch = await input.queue.claim(25, 120, input.testRecipients);
    for (const lease of batch) {
      let proofIssued = false;
      try {
        const prepared = await input.queue.prepare(lease);
        if (!prepared) continue;
        proofIssued = true;
        if (Date.parse(prepared.leaseUntil) <= (input.now?.() ?? Date.now()) + 11_000) throw new Error('Sequence proof is expiring');
        const rendered = renderMhpOwnerEmail({ canonicalContent: prepared.exact.canonicalContent, contentSha256: prepared.exact.contentSha256,
          brand: parseMhpOwnerEmailBrand(prepared.exact.brand), firstName: prepared.firstName,
          label: typeof prepared.context.label === 'string' ? prepared.context.label : 'Webinar',
          link: typeof prepared.context.link === 'string' ? prepared.context.link : '', unsubscribe: mhpUnsubscribeUrl(input.unsubscribeSecret, prepared.prospectId) });
        const reference = await input.sender.sendRendered({ id: prepared.id, email: prepared.email, tag: 'owner_sequence', rendered });
        await input.queue.settle(lease, true, reference); sent++;
      } catch {
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
