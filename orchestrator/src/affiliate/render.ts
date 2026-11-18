/**
 * The one helper every article renderer uses for product links and the disclosure: the published page, the content
 * fragment sent to websites (WordPress included) and the reading column on the article page. Plain <p>, <strong> and
 * <a rel> only, so a site's sanitiser keeps it. The disclosure is derived from the programme, never stored as text,
 * and comes first whenever the article carries at least one link.
 */

import { programmeFor } from './programmes.js';
import { cleanDisplay, type ArticleAffiliate } from './article.js';

const esc = (s: string) => s.replace(/[&<>"']/gu, (c) => `&#${c.charCodeAt(0)};`);

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

/** The button after the part about one product, or empty. The stored address exactly, never rebuilt. */
export function productLinkHtml(affiliate: ArticleAffiliate | undefined, sectionId: string): string {
  const programme = affiliate ? programmeFor(affiliate.programme) : null;
  if (!affiliate || !programme) return '';
  return affiliate.links.filter((l) => l.sectionId === sectionId && programme.validateLink(l.url).ok)
    .map((l) => `<p class="r72-product-link"><a href="${esc(l.url)}" rel="${esc(programme.rel)}" target="_blank">${esc(programme.linkLabel(cleanDisplay(l.name)))}</a> ${esc(programme.paidLinkNote)}</p>`).join('\n');
}
