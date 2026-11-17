/**
 * The after-publishing check for a product article (Affiliate Studio, review M7). Once the website serves the page,
 * the page itself is read again, exactly as `verifyPublicUrl` reads it (the same transport and the same 3 MB limit),
 * and must show:
 *   - the "Ad" label before the first product link,
 *   - the Amazon Associates statement, word for word,
 *   - every product link the article carries, each marked `rel` with both `sponsored` and `nofollow`, and no other
 *     shop link without that marking.
 * A page that cannot be read is "not verified", never passed. The result is kept on the publication; a website whose
 * latest product page did not pass takes no further product article until a later check passes. No website is
 * changed by this check: none of the publishers can take an article down again, so nothing is withdrawn.
 */

import type { FetchTransport } from '../seo-blog/safe-fetch.js';
import { programmeFor } from './programmes.js';
import { isAmazonFamilyHost, type ArticleAffiliate } from './article.js';

export type AffiliatePageState = 'passed' | 'failed' | 'unverified';
export interface AffiliatePageCheck {
  readonly state: AffiliatePageState;
  readonly at: string;
  /** Plain-English findings, at most a few; empty when passed. */
  readonly problems: readonly string[];
}

/** Owner-facing words: plain, no mechanism. */
export const AFFILIATE_PAGE_ALERT = 'The published page is missing the ad label or the paid-link marking. Readers must see the label before any product link, and every product link must be marked as a paid link. No more product articles will go to this website until its page passes this check. Ask whoever looks after your website to keep the label and the link marking, then choose Check again on this article.';
export const AFFILIATE_PAGE_UNVERIFIED = 'We could not open the published page to check its ad label and paid-link marking, so it counts as not checked. No more product articles will go to this website until the check passes. Choose Check again on this article once the page opens.';
export const AFFILIATE_PAGE_BLOCK = 'Product articles are paused for this website: the last published product page was missing the ad label or the paid-link marking, or could not be checked.';
export const AFFILIATE_PAGE_PASSED = 'The published page shows the ad label and marks every product link as paid.';

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decode(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/giu, (m, code: string) => {
    if (code[0] === '#') { const n = code[1]?.toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10); return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m; }
    return ENTITIES[code.toLowerCase()] ?? m;
  });
}
const visibleText = (html: string) => decode(html.replace(/<(script|style|template)\b[\s\S]*?<\/\1\s*>/giu, ' ').replace(/<!--[\s\S]*?-->/gu, ' ').replace(/<[^>]*>/gu, ' ')).replace(/\s+/gu, ' ');

function attribute(tag: string, name: string): string | null {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'iu').exec(tag);
  return m ? decode(m[1] ?? m[2] ?? m[3] ?? '') : null;
}

/** What the served page is missing (empty when it passes). Pure. */
export function affiliatePageProblems(html: string, affiliate: ArticleAffiliate): string[] {
  const programme = programmeFor(affiliate.programme);
  if (!programme) return ['The programme of these links is not known.'];
  const bodyAt = html.search(/<body\b/iu);
  const body = bodyAt >= 0 ? html.slice(bodyAt) : html;
  const anchors = [...body.matchAll(/<a\b[^>]*>/giu)].map((m) => {
    const href = attribute(m[0], 'href') ?? '';
    let host = '';
    try { host = new URL(href.trim()).hostname; } catch { /* not an address */ }
    const rel = (attribute(m[0], 'rel') ?? '').toLowerCase().split(/\s+/u).filter(Boolean);
    return { at: m.index ?? 0, href: href.trim(), shop: Boolean(host) && isAmazonFamilyHost(host), rel };
  });
  const expected = new Set(affiliate.links.map((l) => l.url));
  const paid = anchors.filter((a) => a.shop || expected.has(a.href));
  const problems: string[] = [];
  for (const url of expected) if (!paid.some((a) => a.href === url)) problems.push('A product link is missing from the page.');
  if (paid.some((a) => !a.rel.includes('sponsored') || !a.rel.includes('nofollow'))) problems.push('A product link is not marked as a paid link.');
  const first = paid[0];
  const before = visibleText(first ? body.slice(0, first.at) : body);
  const label = programme.disclosure.label.replace(/[.:]$/u, '');
  if (!new RegExp(`(?:^|[^\\p{L}])${label}[.:](?:\\s|$)`, 'u').test(before)) problems.push('The ad label is not shown before the first product link.');
  const statement = /As an Amazon Associate I earn from qualifying purchases\./u;
  if (!statement.test(visibleText(body))) problems.push('The Amazon Associates statement is missing.');
  return [...new Set(problems)];
}

/** Read the public page (as verifyPublicUrl does) and check it. A page that cannot be read is not verified. */
export async function checkAffiliatePage(transport: FetchTransport, url: string, affiliate: ArticleAffiliate, at: string): Promise<AffiliatePageCheck> {
  try {
    const page = await transport.fetch(url, { maxBytes: 3 * 1024 * 1024 });
    if (page.status !== 200) return { state: 'unverified', at, problems: ['The published page could not be opened.'] };
    const problems = affiliatePageProblems(page.body.toString('utf8'), affiliate);
    return { state: problems.length ? 'failed' : 'passed', at, problems };
  } catch {
    return { state: 'unverified', at, problems: ['The published page could not be opened.'] };
  }
}
