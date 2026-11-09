/** Recommendations only. No contact discovery, message sending or platform posting. */
import { createHash } from 'node:crypto';
import { authorityPageUrl, AuthorityInputError } from './authority-providers.js';
import type { AuthorityEvidence, AuthorityProspect, AuthorityQualification } from './authority-types.js';

export interface AuthorityQualificationPolicy {
  /** Explicit caller policy; no commercial tier or default traffic threshold is invented here. */
  readonly minimumMonthlyVisits: number;
  readonly maximumSpamScore: number;
  readonly maximumEvidenceAgeDays: number;
}
export function qualifyAuthorityProspect(prospect: AuthorityProspect, policy: AuthorityQualificationPolicy, now: Date): AuthorityQualification {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(prospect.brandId)
      || !['editorial_outreach', 'reddit', 'quora'].includes(prospect.channel) || !Number.isSafeInteger(policy.minimumMonthlyVisits) || policy.minimumMonthlyVisits < 0
      || !Number.isFinite(policy.maximumSpamScore) || policy.maximumSpamScore < 0 || policy.maximumSpamScore > 100
      || !Number.isSafeInteger(policy.maximumEvidenceAgeDays) || policy.maximumEvidenceAgeDays < 1 || policy.maximumEvidenceAgeDays > 365 || !Number.isFinite(now.getTime())) throw new AuthorityInputError();
  const page = new URL(authorityPageUrl(prospect.pageUrl)); page.hash = '';
  const id = createHash('sha256').update(`${prospect.brandId.toLowerCase()}|${prospect.channel}|${page.href}`).digest('hex');
  const communityHost = ['reddit.com', 'quora.com'].some((host) => page.hostname === host || page.hostname.endsWith('.' + host));
  const reasons: string[] = [], unknown: string[] = [];
  const read = <T extends number | boolean>(name: string, fact: AuthorityEvidence<T>, expectedType: 'number' | 'boolean', max = Number.MAX_SAFE_INTEGER): T | null => {
    if (!fact || fact.state === 'unknown') { unknown.push(name); return null; }
    if (fact.state !== 'observed' || typeof fact.value !== expectedType || (typeof fact.value === 'number' && (!Number.isSafeInteger(fact.value) || fact.value < 0 || fact.value > max))) throw new AuthorityInputError();
    authorityPageUrl(fact.sourceUrl);
    const at = Date.parse(fact.observedAt);
    if (!Number.isFinite(at)) throw new AuthorityInputError();
    if (at > now.getTime() + 300_000 || now.getTime() - at > policy.maximumEvidenceAgeDays * 86_400_000) { unknown.push(name); reasons.push(`${name}: evidence needs refreshing`); return null; }
    return fact.value;
  };
  const relevant = read('topical relevance', prospect.topicalRelevance, 'boolean');
  const context = read('page context', prospect.pageContextVerified, 'boolean');
  const visits = read('monthly visits', prospect.monthlyVisits, 'number');
  const spam = read('spam score', prospect.spamScore, 'number', 100);
  const contact = read('verified contact', prospect.contactVerified, 'boolean');
  const paid = read('paid or exchanged link', prospect.paidOrExchangedLink, 'boolean');
  let status: AuthorityQualification['status'];
  if (paid === true || relevant === false || (spam !== null && spam > policy.maximumSpamScore) || (visits !== null && visits < policy.minimumMonthlyVisits)) {
    status = 'excluded';
    if (paid === true) reasons.push('Paid or exchanged link excluded');
    if (relevant === false) reasons.push('Observed page is outside the brand topic');
    if (spam !== null && spam > policy.maximumSpamScore) reasons.push('Supplier spam indicator exceeds the selected review policy; this is not proof of a link farm');
    if (visits !== null && visits < policy.minimumMonthlyVisits) reasons.push('Observed visits are below the selected review policy');
  } else if (prospect.channel !== 'editorial_outreach' || communityHost) {
    status = 'community_hold'; reasons.push('Research and draft only: review platform rules, account identity and the exact conversation context before any contribution');
  } else if (unknown.length || context !== true || contact !== true) {
    status = 'needs_evidence';
    if (context === false) reasons.push('Exact page context has not been verified');
    if (contact === false) reasons.push('The responsible contact has not been verified');
    if (unknown.length) reasons.push('Missing facts remain unknown; provider rank does not establish traffic or contact identity');
  } else {
    status = 'review_ready'; reasons.push('Evidence meets the selected policy; exact outreach still requires owner review');
  }
  return Object.freeze({ rulesVersion: 'r72-authority-qualification-v1', id, status, reasons: Object.freeze(reasons), unknownFacts: Object.freeze(unknown), sendingAllowed: false });
}
