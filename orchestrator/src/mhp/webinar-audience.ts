import { createHash } from 'node:crypto';
import type { Pool } from 'pg';

/** One registration of the configured webinar, as the existing owner-only lead reader (0125) returns it. */
export interface MhpAudienceCandidate {
  prospectId: string; email: string; firstName: string | null; label: string | null; registeredAt: string | null;
  marketingConsent: boolean; unsubscribed: boolean; signupConsentGiven: boolean;
}
export interface MhpAudienceCandidatePage { candidates: readonly MhpAudienceCandidate[]; hasMore: boolean; nextAfter: string | null }
const ANY_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
/** Eligible exactly as app_private.mhp_owner_email_audience (0126), which both the sequence enrol and the owner email schedule use. */
export const mhpCandidateEligible = (c: MhpAudienceCandidate): boolean => c.marketingConsent && !c.unsubscribed && c.signupConsentGiven;
/**
 * The most people a confirmation may name and bind: what the sequence page can also check afterwards
 * (its snapshot holds the 100 most recent people). The explicit-recipient migration removes this limit.
 */
export const MHP_CONFIRM_LIMIT = 100;

/** Reads one page (25) of the webinar registrations through the owner session. Throws the raw database error for the caller to map. */
export async function readMhpWebinarCandidates(web: Pick<Pool, 'query'>, tokenHash: Buffer, campaign: string, after: string | null): Promise<MhpAudienceCandidatePage> {
  const result = await web.query<{ page: { campaign: string; candidates: MhpAudienceCandidate[]; hasMore: boolean; nextAfter: string | null } }>(
    'SELECT app_private.mhp_webinar_lead_candidates($1::bytea,$2::text,$3::uuid,$4::integer) AS page', [tokenHash, campaign, after, 25]);
  const page = result.rows[0]?.page;
  if (!page || page.campaign !== campaign || !Array.isArray(page.candidates) || page.candidates.length > 25 || typeof page.hasMore !== 'boolean'
      || (page.nextAfter !== null && !ANY_UUID.test(page.nextAfter)) || (page.hasMore && page.nextAfter === null)
      || page.candidates.some(row => !ANY_UUID.test(row.prospectId) || (after !== null && row.prospectId <= after) || typeof row.email !== 'string' || !row.email.includes('@')
        || (row.firstName !== null && typeof row.firstName !== 'string') || (row.label !== null && typeof row.label !== 'string')
        || ![row.marketingConsent, row.unsubscribed, row.signupConsentGiven].every(flag => typeof flag === 'boolean'))) throw new Error('Invalid webinar audience page');
  return { candidates: page.candidates.map(row => ({ prospectId: row.prospectId, email: row.email, firstName: row.firstName, label: row.label,
    registeredAt: row.registeredAt ?? null, marketingConsent: row.marketingConsent, unsubscribed: row.unsubscribed, signupConsentGiven: row.signupConsentGiven })),
    hasMore: page.hasMore, nextAfter: page.nextAfter };
}
/** Every registration, page by page; null when there are more than the page limit can read. */
export async function readAllMhpWebinarCandidates(reader: (after: string | null) => Promise<MhpAudienceCandidatePage>, maxPages = 400): Promise<MhpAudienceCandidate[] | null> {
  const all: MhpAudienceCandidate[] = []; let after: string | null = null;
  for (let page = 0; page < maxPages; page++) {
    const next = await reader(after); all.push(...next.candidates);
    if (!next.hasMore) return all;
    after = next.nextAfter;
  }
  return null;
}
/** The most common webinar label among the people named, for "people who registered for …". */
export function mhpWebinarLabel(candidates: readonly MhpAudienceCandidate[]): string | null {
  const labels = new Map<string, number>(); for (const c of candidates) if (c.label) labels.set(c.label, (labels.get(c.label) ?? 0) + 1);
  return [...labels.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null;
}
export const mhpPeopleDigest = (scope: string, parts: readonly string[], ids: readonly string[]): string =>
  createHash('sha256').update([scope, ...parts, ...ids].join('\n')).digest('hex');
