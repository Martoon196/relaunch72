/**
 * Article quality and factuality checks. Run after generation and after every
 * substantive edit, and again at dispatch if facts changed. Scores are not
 * produced: each issue names the problem, where it is and a practical fix.
 *
 * Critical issues hold publication in every mode; owner approval cannot
 * override them. Warnings are editorial signals.
 */

import { GLOBAL_BANNED_PHRASES } from '../qa/banned.js';
import { normalizeLoose, normalizeText } from '../util/text.js';
import { topicSimilarity } from './dedupe.js';
import { sameSite } from './inventory.js';
import type { ArticleVersion, BrandProfile, CheckIssue, CheckReport, ResearchSource } from './types.js';

export interface CheckContext {
  readonly profile: BrandProfile;
  readonly sources: ReadonlyMap<string, ResearchSource>;
  /** Real, published brand URLs that may be linked publicly. */
  readonly linkable: ReadonlySet<string>;
  readonly website: string | null;
  /** Other articles (title + slug) and existing page titles for duplication. */
  readonly others: readonly { readonly title: string; readonly slug: string; readonly kind: 'article' | 'page' }[];
  readonly now: string;
}

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PROMISE = /(?<!\b(?:no|not|never|without|cannot|can't|isn't)\s(?:a\s)?)\b(guarantee[sd]?|risk[- ]free|no[- ]risk|can't lose|cannot lose|you will (?:make|earn|double|profit)|will double|100% (?:safe|certain|success)|instant (?:profit|returns)|passive income for life|rank (?:#?1|first) on google)\b/i;
const REGULATORY = /\b(tax|stamp duty|sdlt|lbtt|land transaction tax|capital gains|income tax|vat|hmrc|fca|regulat\w*|legislation|statut\w*|licen[cs]\w*|planning permission|permitted development|article 4|renters'? rights|section 21|section 8|deposit protection|epc|minimum energy|mortgage rates?|interest rates?|base rate|act \d{4})\b/i;
const ASSERTIVE = /\b(must|required|requirement|illegal|unlawful|legal(?:ly)?|allowed|exempt|liable|penalt\w*|fine[sd]?|banned|mandatory|from \d{1,2} \w+ \d{4}|as of \d{4})\b/i;
const PROOF = /\b(case stud(?:y|ies)|testimonials?|our clients (?:have|achieved|made)|award[- ]winning|trusted by|rated \d|\d+ (?:happy|satisfied) (?:clients|customers|investors)|five[- ]star|5[- ]star)\b/i;
const MARKER = /\[src:([A-Za-z0-9-]{1,64})\]/g;

interface Located { readonly text: string; readonly where: string }

function blocks(version: ArticleVersion): Located[] {
  const b = version.body;
  return [
    { text: b.intro, where: 'Introduction' },
    ...b.sections.map((s) => ({ text: s.body, where: `Section “${s.heading}”` })),
    { text: b.conclusion, where: 'Conclusion' },
    ...b.faqs.map((f, i) => ({ text: `${f.q}\n${f.a}`, where: `FAQ ${i + 1}` })),
  ];
}

function sentences(text: string): string[] {
  return text
    .replace(/\[([^\]]+)\]\((?:https?:\/\/[^)\s]+)\)/g, '$1')
    .split(/(?<=[.!?])\s+(?=[A-Z0-9£“"(*-])|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Figures that need evidence: money, percentages, years, and integers of 10 or more. */
export function materialFigures(sentence: string): string[] {
  const clean = sentence.replace(MARKER, ' ').replace(/^\s*(?:\d+[.)]|[-*])\s+/, '');
  const out: string[] = [];
  const re = /(?:[£$€]\s?\d[\d,]*(?:\.\d+)?\s?(?:k|m|bn|million|billion)?)|(?:\d[\d,]*(?:\.\d+)?\s?%)|(?:\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b)|(?:\b\d+\.\d+\b)|(?:\b\d{2,}\b)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean)) !== null) out.push(m[0].trim());
  return out;
}

function digitsOf(figure: string): string {
  return figure.replace(/[^\d.]/g, '').replace(/\.0+$/, '').replace(/^0+(?=\d)/, '');
}

function figureInText(figure: string, text: string): boolean {
  const wanted = digitsOf(figure);
  if (!wanted) return true;
  const haystack = text.replace(/,(?=\d{3})/g, '');
  const re = /\d+(?:\.\d+)?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(haystack)) !== null) if (m[0].replace(/\.0+$/, '').replace(/^0+(?=\d)/, '') === wanted) return true;
  return false;
}

function profileFactText(profile: BrandProfile): string {
  return [
    ...profile.offers.flatMap((o) => [o.name, o.description, o.price ?? '']),
    ...profile.approvedClaims,
  ].join('\n');
}

function shingles(text: string, size = 12): Set<string> {
  const words = normalizeLoose(text).replace(MARKER, ' ').split(/[^a-z0-9£%]+/).filter(Boolean);
  const out = new Set<string>();
  for (let i = 0; i + size <= words.length; i++) out.add(words.slice(i, i + size).join(' '));
  return out;
}

export function runChecks(version: ArticleVersion, ctx: CheckContext): CheckReport {
  const issues: CheckIssue[] = [];
  const add = (severity: CheckIssue['severity'], code: string, message: string, fix: string, location: string | null = null) =>
    issues.push({ code, severity, message, fix, location });
  const b = version.body;

  // ── Completeness & metadata ──
  if (!b.title.trim()) add('critical', 'structure.title_missing', 'The article has no page heading.', 'Add a clear title.');
  if (!b.intro.trim()) add('critical', 'structure.intro_missing', 'The introduction is empty.', 'Write a short introduction that states what the reader will learn.');
  if (b.sections.length < 2) add('critical', 'structure.too_few_sections', 'The article has fewer than two sections.', 'Expand the outline or regenerate the article.');
  b.sections.forEach((s) => {
    if (s.body.trim().split(/\s+/).length < 25) add('critical', 'structure.section_incomplete', 'This section is too thin to publish.', 'Regenerate or expand this section.', `Section “${s.heading || 'untitled'}”`);
    if (!s.heading.trim()) add('critical', 'structure.heading_missing', 'A section has no heading.', 'Give every section a descriptive subheading.');
  });
  const headings = b.sections.map((s) => normalizeLoose(s.heading));
  if (new Set(headings).size !== headings.length) add('warning', 'structure.heading_repeated', 'Two sections share the same heading.', 'Make each subheading distinct.');
  if (!b.conclusion.trim()) add('critical', 'structure.conclusion_missing', 'The conclusion is empty.', 'Add a short conclusion that points to the next step.');
  if (!SLUG.test(b.slug) || b.slug.length > 80) add('critical', 'meta.slug_invalid', 'The URL slug is not valid.', 'Use lower-case words separated by hyphens.');
  if (!b.seoTitle.trim()) add('critical', 'meta.seo_title_missing', 'The SEO title is empty.', 'Write an SEO title of up to 65 characters.');
  else if (b.seoTitle.length > 65) add('warning', 'meta.seo_title_long', `The SEO title is ${b.seoTitle.length} characters and may be truncated.`, 'Shorten it to 65 characters or fewer.');
  if (!b.metaDescription.trim()) add('critical', 'meta.description_missing', 'The meta description is empty.', 'Write a 70–160 character description.');
  else if (b.metaDescription.length < 70 || b.metaDescription.length > 160) add('warning', 'meta.description_length', `The meta description is ${b.metaDescription.length} characters.`, 'Aim for 70–160 characters.');
  if (b.image.kind !== 'none' && b.image.alt.trim().length < 5) add('critical', 'image.alt_missing', 'The featured image has no meaningful alt text.', 'Describe what the image shows.');
  if (b.image.kind === 'none') add('warning', 'image.none', 'No featured image is selected.', 'Choose a brand asset, upload an image or generate an illustrative one.');
  if (!b.author) add('warning', 'meta.author_missing', 'No author attribution is configured; the brand name will be used.', 'Set a real author in Brand setup if one applies.');

  // ── Profile facts ──
  if (!ctx.profile.confirmedAt) add('critical', 'profile.unconfirmed', 'The brand profile has not been confirmed by the owner.', 'Review and confirm the brand profile in Brand setup.');
  const allText = blocks(version).map((x) => x.text).join('\n') + `\n${b.title}`;
  for (const conflict of ctx.profile.conflicts) {
    const offer = ctx.profile.offers.find((o) => normalizeLoose(conflict.field).includes(normalizeLoose(o.name)) || normalizeLoose(conflict.detail).includes(normalizeLoose(o.name)));
    const subject = offer?.name ?? conflict.field;
    if (subject && subject.length >= 3 && normalizeLoose(allText).includes(normalizeLoose(subject))) {
      add('critical', 'profile.unresolved_fact', `The article mentions “${subject}”, which has an unresolved conflict in the brand knowledge: ${conflict.detail}`, 'Resolve the conflict in Brand setup (update or retire a document), then rerun checks.');
    }
  }

  // ── Markup safety & links ──
  for (const block of blocks(version)) {
    if (/<\s*\/?\s*[a-z!][^>]*>/i.test(block.text) || /javascript:|data:text\/html|vbscript:/i.test(block.text)) {
      add('critical', 'markup.unsafe', 'Raw HTML or a script link was found.', 'Remove the HTML; use plain Markdown text, lists and links.', block.where);
    }
    for (const m of block.text.matchAll(/\[([^\]]*)\]\(([^)\s]*)\)/g)) {
      const href = m[2] ?? '';
      if (!/^https:\/\//i.test(href)) {
        add('critical', 'links.invalid', `The link “${m[1]}” does not use a full https address.`, 'Use a full https:// link or remove it.', block.where);
        continue;
      }
      const isSource = [...ctx.sources.values()].some((s) => s.url === href);
      if (ctx.website && sameSite(href, ctx.website)) {
        if (!ctx.linkable.has(href) && !ctx.linkable.has(href.replace(/\/$/, '')) && !ctx.linkable.has(`${href}/`)) {
          add('critical', 'links.broken_internal', `The internal link ${href} is not a published page.`, 'Link only to pages that are live on the website, or remove the link until the target is published.', block.where);
        }
      } else if (!isSource) {
        add('warning', 'links.unverified_external', `The external link ${href} was not part of the research.`, 'Confirm it is a credible, working reference.', block.where);
      }
    }
  }

  // ── Factuality ──
  const factText = profileFactText(ctx.profile);
  for (const block of blocks(version)) {
    for (const sentence of sentences(block.text)) {
      const cited = [...sentence.matchAll(MARKER)].map((m) => m[1]!);
      for (const id of cited) {
        if (!ctx.sources.has(id)) add('critical', 'facts.unknown_source', 'A citation refers to a source that is not on record.', 'Remove the citation or regenerate this section with current research.', block.where);
      }
      const citedText = cited.map((id) => ctx.sources.get(id)?.passage ?? '').join('\n');
      for (const figure of materialFigures(sentence)) {
        if (figureInText(figure, citedText) || figureInText(figure, factText)) continue;
        add('critical', cited.length ? 'facts.figure_not_in_source' : 'facts.unsupported_figure',
          cited.length ? `The figure “${figure}” is not in the cited source.` : `The figure “${figure}” has no supporting source.`,
          'Cite a source passage that states it, use a figure from the brand facts, or remove it.', block.where);
      }
      if (REGULATORY.test(sentence) && (ASSERTIVE.test(sentence) || materialFigures(sentence).length > 0)) {
        const primary = cited.some((id) => ctx.sources.get(id)?.primary);
        if (!primary) {
          add('critical', 'facts.regulatory_needs_evidence', 'A legal, tax or regulatory statement is not backed by a current primary source.', 'Cite an official source (for example gov.uk or legislation.gov.uk), soften it to general guidance, or remove it.', block.where);
        }
      }
      if (PROMISE.test(sentence)) {
        add('critical', 'claims.misleading_promise', `The text promises an outcome (“${PROMISE.exec(sentence)?.[0]}”).`, 'Rephrase as a possibility with its conditions and risks.', block.where);
      }
      if (PROOF.test(sentence) && !ctx.profile.approvedClaims.some((c) => normalizeLoose(sentence).includes(normalizeLoose(c).slice(0, 40)))) {
        add('warning', 'claims.unverified_proof', 'The text refers to proof (reviews, case studies, clients) that is not an approved claim.', 'Remove it or add the supporting approved claim to the brand knowledge.', block.where);
      }
    }
    // Fabricated quotations: any double-quoted span of 4+ words must exist in a source or the brand knowledge.
    for (const m of block.text.matchAll(/["“]([^"”]{12,400})["”]/g)) {
      const quote = normalizeLoose(m[1]!);
      if (quote.split(/\s+/).length < 4) continue;
      const known = [...ctx.sources.values()].some((s) => normalizeLoose(s.passage).includes(quote))
        || normalizeLoose(factText).includes(quote)
        || ctx.profile.voice.examples.some((e) => normalizeLoose(e).includes(quote));
      if (!known) add('critical', 'facts.quote_fabricated', 'A quotation does not appear in any source or brand document.', 'Remove the quotation marks and paraphrase, or quote the exact source wording with a citation.', block.where);
    }
  }

  // ── Originality & duplication ──
  const own = shingles(allText);
  for (const source of ctx.sources.values()) {
    const theirs = shingles(source.passage);
    let shared = 0;
    for (const s of theirs) if (own.has(s)) shared++;
    if (shared > 0) add('critical', 'originality.copied_source', `A passage closely copies research text from ${source.url}.`, 'Rewrite it in original words and cite the source.');
  }
  for (const other of ctx.others) {
    if (other.slug === b.slug && other.kind === 'article') add('critical', 'duplication.slug', 'Another article already uses this URL slug.', 'Choose a different slug.');
    const score = topicSimilarity(b.title, other.title);
    if (score >= 0.9) add('critical', 'duplication.substantial', `This article substantially duplicates “${other.title}”.`, 'Take a distinct angle, update the existing piece instead, or skip this article.');
    else if (score >= 0.6) add('warning', 'duplication.overlap', `This article overlaps with “${other.title}”.`, 'Make sure it answers a different question and links to the other piece.');
  }

  // ── Voice ──
  const lower = normalizeLoose(allText);
  for (const phrase of GLOBAL_BANNED_PHRASES) {
    if (lower.includes(phrase)) add('warning', 'voice.cliche', `“${phrase}” is generic marketing language.`, 'Replace it with a specific, plain statement.');
  }
  for (const dont of ctx.profile.voice.dont) {
    const phrase = normalizeText(dont).replace(/^(?:avoid|don't use|do not use|never use|never say)\s+/i, '').replace(/["“”]/g, '').toLowerCase();
    if (phrase.length >= 4 && phrase.split(/\s+/).length <= 4 && lower.includes(phrase)) {
      add('warning', 'voice.brand_rule', `The brand guidance says to avoid “${phrase}”.`, 'Rephrase in line with the brand voice.');
    }
  }

  const deduped = dedupeIssues(issues);
  const status = deduped.some((i) => i.severity === 'critical') ? 'critical' : deduped.length ? 'warnings' : 'pass';
  return { versionId: version.id, contentSha: version.contentSha, factsSha: version.factsSha === ctx.profile.factsSha ? version.factsSha : ctx.profile.factsSha, ranAt: ctx.now, status, issues: deduped };
}

function dedupeIssues(issues: CheckIssue[]): CheckIssue[] {
  const seen = new Set<string>();
  return issues.filter((i) => {
    const key = `${i.code}|${i.location ?? ''}|${i.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
