import type { Pool } from 'pg';
import { mhpUnsubscribeUrl } from './growth-service.js';
import type { MhpRenderedMarketingSender } from './marketing-mail.js';
import { MHP_OWNER_EMAIL_UUID, parseMhpOwnerEmailBrand, renderMhpOwnerEmail } from './owner-email-content.js';

export interface MhpOwnerEmailLease { id: string; leaseId: string; leaseUntil: string }
export interface MhpOwnerEmailPrepared extends MhpOwnerEmailLease {
  proofId: string; prospectId: string; email: string; firstName: string | null; context: Record<string, unknown>;
  exact: { canonicalContent: string; contentSha256: string; contentVersionId: string; approvalDecisionId: string; brand: unknown };
}
export interface MhpOwnerEmailDispatch {
  claim(limit: number, leaseSeconds: number, onlyEmails: readonly string[] | null): Promise<readonly MhpOwnerEmailLease[]>;
  prepare(lease: MhpOwnerEmailLease): Promise<MhpOwnerEmailPrepared | null>;
  settle(lease: MhpOwnerEmailLease, accepted: boolean, reference: string | null): Promise<void>;
}
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const uuid = (value: unknown): value is string => typeof value === 'string' && MHP_OWNER_EMAIL_UUID.test(value);

export function parseMhpOwnerEmailLeases(jobs: unknown, limit: number): readonly MhpOwnerEmailLease[] {
  if (!Array.isArray(jobs) || jobs.length > limit || !jobs.every(job => record(job) && uuid(job.id) && uuid(job.leaseId)
      && typeof job.leaseUntil === 'string' && Number.isFinite(Date.parse(job.leaseUntil)))) throw new Error('Invalid owner email lease batch');
  return jobs as MhpOwnerEmailLease[];
}
export function parseMhpOwnerEmailPrepared(value: unknown, lease: MhpOwnerEmailLease): MhpOwnerEmailPrepared | null {
  if (value === null) return null;
  if (!record(value) || value.id !== lease.id || value.leaseId !== lease.leaseId || !uuid(value.proofId) || !uuid(value.prospectId)
      || typeof value.leaseUntil !== 'string' || Date.parse(value.leaseUntil) !== Date.parse(lease.leaseUntil)
      || typeof value.email !== 'string' || !(value.firstName === null || typeof value.firstName === 'string')
      || !record(value.context) || !record(value.exact) || !uuid(value.exact.contentVersionId) || !uuid(value.exact.approvalDecisionId)
      || typeof value.exact.canonicalContent !== 'string' || typeof value.exact.contentSha256 !== 'string'
      || !/^[0-9a-f]{64}$/u.test(value.exact.contentSha256)) throw new Error('Invalid pinned owner email proof');
  parseMhpOwnerEmailBrand(value.exact.brand);
  return value as unknown as MhpOwnerEmailPrepared;
}

/** Table-blind capabilities on the existing dispatch identity, never an owner context. */
export class PgMhpOwnerEmailDispatch implements MhpOwnerEmailDispatch {
  constructor(private readonly pool: Pick<Pool, 'query'>) {}
  async claim(limit: number, leaseSeconds: number, onlyEmails: readonly string[] | null): Promise<readonly MhpOwnerEmailLease[]> {
    const result = await this.pool.query<{ jobs: unknown }>('SELECT app_private.mhp_claim_owner_marketing_sends($1,$2,$3) AS jobs',
      [limit, leaseSeconds, onlyEmails ? [...onlyEmails] : null]);
    return parseMhpOwnerEmailLeases(result.rows[0]?.jobs, limit);
  }
  async prepare(lease: MhpOwnerEmailLease): Promise<MhpOwnerEmailPrepared | null> {
    const result = await this.pool.query<{ prepared: unknown }>('SELECT app_private.mhp_prepare_owner_marketing_send($1,$2) AS prepared', [lease.id, lease.leaseId]);
    return parseMhpOwnerEmailPrepared(result.rows[0]?.prepared, lease);
  }
  async settle(lease: MhpOwnerEmailLease, accepted: boolean, reference: string | null): Promise<void> {
    await this.pool.query('SELECT app_private.mhp_settle_owner_marketing_send($1,$2,$3,$4)', [lease.id, lease.leaseId, accepted, reference]);
  }
}

/** One bounded sweep, called by the existing marketing dispatcher interval. */
export async function dispatchMhpOwnerEmails(input: { queue: MhpOwnerEmailDispatch; sender: MhpRenderedMarketingSender;
  unsubscribeSecret: string; testRecipients: readonly string[] | null; stopped?: () => boolean; now?: () => number }): Promise<{ sent: number; failed: number }> {
  let sent = 0, failed = 0;
  for (let page = 0; page < 4 && !input.stopped?.(); page++) {
    const batch = await input.queue.claim(25, 120, input.testRecipients);
    for (const lease of batch) {
      try {
        const prepared = await input.queue.prepare(lease);
        if (!prepared || Date.parse(prepared.leaseUntil) <= (input.now?.() ?? Date.now()) + 11_000) throw new Error('Owner email proof is unavailable or expiring');
        const rendered = renderMhpOwnerEmail({ canonicalContent: prepared.exact.canonicalContent, contentSha256: prepared.exact.contentSha256,
          brand: parseMhpOwnerEmailBrand(prepared.exact.brand), firstName: prepared.firstName,
          label: typeof prepared.context.label === 'string' ? prepared.context.label : 'Webinar',
          link: typeof prepared.context.link === 'string' ? prepared.context.link : '',
          unsubscribe: mhpUnsubscribeUrl(input.unsubscribeSecret, prepared.prospectId) });
        // Consent, pinned approval, source and lease were rechecked by prepare.
        const reference = await input.sender.sendRendered({ id: prepared.id, email: prepared.email, tag: 'owner_followup', rendered });
        await input.queue.settle(lease, true, reference); sent++;
      } catch {
        failed++;
        try { await input.queue.settle(lease, false, null); } catch { /* Expired leases retry under a new proof; never fallback to legacy copy. */ }
      }
    }
    if (batch.length < 25) break;
  }
  return { sent, failed };
}
