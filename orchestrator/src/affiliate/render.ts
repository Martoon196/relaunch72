/**
 * The one helper every article renderer uses for product links and the disclosure: the published page, the content
 * fragment sent to websites (WordPress included) and the reading column on the article page. Plain <p>, <strong> and
 * <a rel> only, so a site's sanitiser keeps it. The disclosure is derived from the programme, never stored as text,
 * and comes first whenever the article carries at least one link.
 */

import { programmeFor } from './programmes.js';
import { cleanDisplay, type ArticleAffiliate } from './article.js';

const esc = (s: string) => s.replace(/[&<>"']/gu, (c) => `&#${c.charCodeAt(0)};`);

/** What every outward title of a product article starts with, so readers know it is an ad before they click (review M6). */
export const AD_PREFIX = 'Ad: ';
const hasAdPrefix = (text: string) => /^\s*ad\s*[:.]/iu.test(text);

/** The public title (page title, heading, search title, feeds, index teasers, website payloads): "Ad: " first whenever the article carries a product link. */
export function publicTitle(title: string, affiliate: ArticleAffiliate | undefined): string {
  return affiliate?.links.length && !hasAdPrefix(title) ? `${AD_PREFIX}${title}` : title;
}

/**
 * The body as it goes out: title, search title, description and summary begin with the "Ad" label whenever the article
 * carries a product link. Applied only where a reader or another website sees the article; the stored version (and so
 * its content hash, its checks and its SEO score) keeps the owner's own title, so the label never counts against the
 * title's length or where the search phrase sits. Unchanged (the same object) for any other article.
 */
export function publicBody<T extends { readonly title: string; readonly seoTitle: string; readonly metaDescription: string; readonly excerpt: string; readonly affiliate?: ArticleAffiliate }>(body: T): T {
  if (!body.affiliate?.links.length) return body;
  return { ...body, title: publicTitle(body.title, body.affiliate), seoTitle: publicTitle(body.seoTitle, body.affiliate),
    metaDescription: publicTitle(body.metaDescription, body.affiliate), excerpt: publicTitle(body.excerpt, body.affiliate) };
}

/** The label readers see first. Empty when there are no links. */
export function disclosureHtml(affiliate: ArticleAffiliate | undefined): string {
  if (!affiliate?.links.length) return '';
  const programme = programmeFor(affiliate.programme);
  if (!programme) return '';
  return `<p class="r72-disclosure"><strong>${esc(programme.disclosure.label)}</strong> ${esc(programme.disclosure.text)}</p>`;
}

/** The disclosure as plain words (for an editor or a text export). */
export function disclosureText(affiliate: ArticleAffiliate | undefined): string {
  if (!affiliate?.links.length) return '';
  const programme = programmeFor(affiliate.programme);
  return programme ? `${programme.disclosure.label} ${programme.disclosure.text}` : '';
}

/** Shown instead of a live link wherever the article is not on the business's own website (review N2). */
export const NOT_LIVE_NOTE = '(paid link, live only on your website)';

/**
 * The button after the part about one product, or empty. The stored address exactly, never rebuilt. `mode: 'text'`
 * (the portal's own reading view, preview and HTML copy) shows the words without a working link: Amazon's links may
 * only be followed from the registered website itself.
 */
export function productLinkHtml(affiliate: ArticleAffiliate | undefined, sectionId: string, mode: 'live' | 'text' = 'live'): string {
  const programme = affiliate ? programmeFor(affiliate.programme) : null;
  if (!affiliate || !programme) return '';
  return affiliate.links.filter((l) => l.sectionId === sectionId && programme.validateLink(l.url).ok)
    .map((l) => mode === 'text'
      ? `<p class="r72-product-link"><strong>${esc(programme.linkLabel(cleanDisplay(l.name)))}</strong> ${esc(NOT_LIVE_NOTE)}</p>`
      : `<p class="r72-product-link"><a href="${esc(l.url)}" rel="${esc(programme.rel)}" target="_blank">${esc(programme.linkLabel(cleanDisplay(l.name)))}</a> ${esc(programme.paidLinkNote)}</p>`).join('\n');
}
