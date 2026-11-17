/** Minimal, dependency-free HTML reading and escaping helpers. */

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', pound: '£', euro: '€', copy: '©', reg: '®', trade: '™',
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === '#') {
      const code = entity[1] === 'x' || entity[1] === 'X' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : '';
    }
    return ENTITIES[entity.toLowerCase()] ?? match;
  });
}

export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function escapeXml(value: unknown): string {
  return escapeHtml(value).replace(/&#39;/g, '&apos;');
}

export function stripTags(html: string): string {
  return decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(script|style|noscript|template|svg|iframe)\b[\s\S]*?<\/\1\s*>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|h[1-6]|section|article|tr)>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t\f\v\r]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

function attr(tag: string, name: string): string | null {
  const re = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
  const m = re.exec(tag);
  if (!m) return null;
  return decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
}

export interface ParsedPage {
  readonly title: string | null;
  readonly description: string | null;
  readonly canonical: string | null;
  readonly robotsNoindex: boolean;
  readonly headings: readonly { level: number; text: string }[];
  readonly text: string;
  readonly publishedAt: string | null;
  readonly modifiedAt: string | null;
  readonly links: readonly string[];
  /** The page's declared share image (og:image), absolute, when it states one. */
  readonly ogImage: string | null;
  /** Declared icons, absolute, touch icons first then by declared size (largest first). */
  readonly icons: readonly string[];
  /** Declared theme colour normalised to #rrggbb, when the page states a plain hex colour. */
  readonly themeColour: string | null;
}

/** #rgb or #rrggbb only; named colours, gradients and functions are not guessed at. */
export function normaliseHexColour(value: string | null | undefined): string | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec((value ?? '').trim());
  if (!m) return null;
  const hex = m[1]!.toLowerCase();
  return `#${hex.length === 3 ? [...hex].map((c) => c + c).join('') : hex}`;
}

function absoluteHttpUrl(href: string | null, baseUrl: string): string | null {
  if (!href) return null;
  try {
    const u = new URL(href, baseUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    u.hash = '';
    return u.toString();
  } catch { return null; }
}

export function parseHtmlPage(html: string, baseUrl: string): ParsedPage {
  const head = /<head\b[\s\S]*?<\/head>/i.exec(html)?.[0] ?? html.slice(0, 20000);
  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(head);
  const metas = head.match(/<meta\b[^>]*>/gi) ?? [];
  const linksInHead = head.match(/<link\b[^>]*>/gi) ?? [];
  const metaContent = (key: string): string | null => {
    for (const tag of metas) {
      const name = (attr(tag, 'name') ?? attr(tag, 'property') ?? attr(tag, 'itemprop') ?? '').toLowerCase();
      if (name === key) return attr(tag, 'content');
    }
    return null;
  };
  let canonical: string | null = null;
  for (const tag of linksInHead) {
    if ((attr(tag, 'rel') ?? '').toLowerCase().split(/\s+/).includes('canonical')) {
      const href = attr(tag, 'href');
      if (href) {
        try { canonical = new URL(href, baseUrl).toString(); } catch { canonical = null; }
      }
    }
  }
  const headings: { level: number; text: string }[] = [];
  const headingRe = /<h([1-3])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi;
  let hm: RegExpExecArray | null;
  while ((hm = headingRe.exec(html)) !== null && headings.length < 40) {
    const text = stripTags(hm[2] ?? '').replace(/\s+/g, ' ').trim();
    if (text) headings.push({ level: Number(hm[1]), text: text.slice(0, 200) });
  }
  const bodyHtml = /<body\b[\s\S]*<\/body>/i.exec(html)?.[0] ?? html;
  const mainHtml = /<(main|article)\b[\s\S]*?<\/\1>/i.exec(bodyHtml)?.[0]
    ?? bodyHtml.replace(/<(nav|header|footer)\b[\s\S]*?<\/\1>/gi, ' ');
  let publishedAt = metaContent('article:published_time') ?? metaContent('datepublished');
  let modifiedAt = metaContent('article:modified_time') ?? metaContent('datemodified');
  const ld = html.match(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) ?? [];
  for (const block of ld) {
    const json = block.replace(/^<script\b[^>]*>/i, '').replace(/<\/script>$/i, '');
    publishedAt ??= /"datePublished"\s*:\s*"([^"]{8,40})"/.exec(json)?.[1] ?? null;
    modifiedAt ??= /"dateModified"\s*:\s*"([^"]{8,40})"/.exec(json)?.[1] ?? null;
  }
  if (!publishedAt) {
    const time = /<time\b[^>]*datetime\s*=\s*["']([^"']{8,40})["']/i.exec(mainHtml);
    publishedAt = time?.[1] ?? null;
  }
  const links: string[] = [];
  const anchorRe = /<a\b[^>]*>/gi;
  let am: RegExpExecArray | null;
  while ((am = anchorRe.exec(bodyHtml)) !== null && links.length < 400) {
    const href = attr(am[0], 'href');
    if (!href) continue;
    try {
      const u = new URL(href, baseUrl);
      if (u.protocol === 'http:' || u.protocol === 'https:') { u.hash = ''; links.push(u.toString()); }
    } catch { /* ignore malformed links */ }
  }
  const robots = (metaContent('robots') ?? '').toLowerCase();
  const icons: { url: string; touch: boolean; size: number }[] = [];
  for (const tag of linksInHead) {
    const rel = (attr(tag, 'rel') ?? '').toLowerCase().split(/\s+/);
    const touch = rel.includes('apple-touch-icon') || rel.includes('apple-touch-icon-precomposed');
    if (!touch && !rel.includes('icon')) continue;
    const url = absoluteHttpUrl(attr(tag, 'href'), baseUrl);
    if (!url || icons.some((i) => i.url === url) || icons.length >= 12) continue;
    icons.push({ url, touch, size: Number(/^(\d{1,4})x\d{1,4}$/i.exec(attr(tag, 'sizes') ?? '')?.[1] ?? 0) });
  }
  icons.sort((a, b) => Number(b.touch) - Number(a.touch) || b.size - a.size);
  return {
    ogImage: absoluteHttpUrl(metaContent('og:image:secure_url') ?? metaContent('og:image'), baseUrl),
    icons: icons.map((i) => i.url),
    themeColour: normaliseHexColour(metaContent('theme-color')),
    title: titleMatch ? stripTags(titleMatch[1] ?? '').replace(/\s+/g, ' ').trim().slice(0, 300) || null : null,
    description: metaContent('description'),
    canonical,
    robotsNoindex: robots.includes('noindex'),
    headings,
    text: stripTags(mainHtml).slice(0, 200_000),
    publishedAt: validDate(publishedAt),
    modifiedAt: validDate(modifiedAt),
    links,
  };
}

/**
 * A research page's outline: the text of its H2 and H3 headings inside the page's own content, and its word count.
 *
 * The content is the first `<main>`; with no `<main>`, the `<article>` with the most text (never the first one, which
 * is often a teaser card); with neither, or when that region has under 150 words, there is no outline (null) rather
 * than a guess that would pick up sidebar, banner and cookie headings. Bounded: a page over `maxHtml` characters keeps
 * no outline; at most `maxHeadings` headings, each kept whole only when it is at most `maxChars` characters (never cut);
 * a heading must close within 2,000 characters. The scan is linear (indexOf only, no backtracking regular expression),
 * so a hostile page of unclosed tags costs milliseconds. Invisible characters are removed, not turned into spaces.
 * Used only for pages research already fetched; it reads the same bytes and fetches nothing. `parseHtmlPage` is
 * unchanged.
 */
export function pageOutline(html: string, maxHeadings = 12, maxChars = 100, maxHtml = 1_000_000): { headings: string[]; words: number } | null {
  if (typeof html !== 'string' || html.length > maxHtml) return null;
  const lower = asciiLower(html);
  const region = (tag: string, from: number): [number, number] | null => {
    let open = lower.indexOf(`<${tag}`, from);
    // "<main" must be the whole tag name ("<mainly" is not it). A loop, not recursion, so many look-alikes cannot overflow the stack.
    for (;;) {
      if (open < 0) return null;
      const after = lower.charCodeAt(open + tag.length + 1);
      if (after === 62 || after === 32 || after === 9 || after === 10 || after === 13 || after === 47 || after === 12) break;
      open = lower.indexOf(`<${tag}`, open + 1);
    }
    const gt = lower.indexOf('>', open);
    if (gt < 0) return null;
    const close = lower.indexOf(`</${tag}`, gt);
    return close < 0 ? null : [gt + 1, close];
  };
  let span = region('main', 0);
  if (!span) {
    let best: [number, number] | null = null, bestLen = -1;
    for (let at = 0, n = 0; n < 200; n++) {
      const r = region('article', at);
      if (!r) break;
      const len = plainText(html.slice(r[0], r[1])).length;
      if (len > bestLen) { best = r; bestLen = len; }
      at = r[1] + 1;
    }
    span = best;
  }
  if (!span) return null;
  const main = html.slice(span[0], span[1]);
  const text = plainText(main);
  const words = Math.min(200_000, (text.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []).length);
  if (words < 150) return null;
  const lowerMain = asciiLower(main);
  const headings: string[] = [];
  // Next-occurrence positions are cached and every look-ahead is windowed, so no step rescans the rest of the page.
  let next2 = lowerMain.indexOf('<h2'), next3 = lowerMain.indexOf('<h3');
  for (let at = 0; headings.length < maxHeadings;) {
    if (next2 >= 0 && next2 < at) next2 = lowerMain.indexOf('<h2', at);
    if (next3 >= 0 && next3 < at) next3 = lowerMain.indexOf('<h3', at);
    const open = next2 < 0 ? next3 : next3 < 0 ? next2 : Math.min(next2, next3);
    if (open < 0) break;
    const level = lowerMain[open + 2];
    const gtAt = lowerMain.slice(open, open + 500).indexOf('>');
    if (gtAt < 0) { at = open + 3; continue; }
    const gt = open + gtAt;
    const closeAt = lowerMain.slice(gt, gt + 2_000).indexOf(`</h${level}`);
    if (closeAt < 0) { at = gt + 1; continue; }
    const close = gt + closeAt;
    const t = plainText(main.slice(gt + 1, close)).replace(/[\p{Default_Ignorable_Code_Point}\p{Cf}\p{Cs}]/gu, '').replace(/[\p{Cc}]/gu, ' ').replace(/\s+/g, ' ').trim();
    if (t && t.length <= maxChars && !headings.includes(t)) headings.push(t);
    at = close + 4;
  }
  return { headings, words };
}

/** Text of an HTML fragment by a single linear scan: tags dropped, script/style/template/svg/noscript content skipped, entities decoded. */
/** ASCII letters lowered only, so every index into the result is an index into the original ("İ".toLowerCase() is two code units). */
function asciiLower(s: string): string {
  return s.replace(/[A-Z]+/g, (m) => m.toLowerCase());
}

function plainText(fragment: string): string {
  const lower = asciiLower(fragment);
  let out = '';
  let i = 0;
  while (i < fragment.length) {
    const lt = fragment.indexOf('<', i);
    if (lt < 0) { out += fragment.slice(i); break; }
    out += fragment.slice(i, lt);
    const skip = /^<(script|style|template|svg|noscript|iframe)\b/.exec(lower.slice(lt, lt + 12));
    if (skip) {
      const end = lower.indexOf(`</${skip[1]}`, lt);
      if (end < 0) break;
      const gt = lower.indexOf('>', end);
      i = gt < 0 ? fragment.length : gt + 1;
      out += ' ';
      continue;
    }
    if (lower.startsWith('<!--', lt)) { const end = lower.indexOf('-->', lt + 4); i = end < 0 ? fragment.length : end + 3; out += ' '; continue; }
    const gt = fragment.indexOf('>', lt);
    if (gt < 0) break;
    i = gt + 1;
    out += ' ';
  }
  return decodeEntities(out.replace(/&(?:shy|zwj|zwnj|lrm|rlm);/gi, '')).replace(/\s+/g, ' ').trim();
}

function validDate(value: string | null): string | null {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** <loc> values from a sitemap or sitemap index, plus whether it is an index. */
export function parseSitemap(xml: string): { index: boolean; locs: string[] } {
  const index = /<sitemapindex\b/i.test(xml);
  const locs: string[] = [];
  const re = /<loc\b[^>]*>([\s\S]*?)<\/loc>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null && locs.length < 50_000) {
    const loc = decodeEntities((m[1] ?? '').replace(/<!\[CDATA\[|\]\]>/g, '').trim());
    if (loc) locs.push(loc);
  }
  return { index, locs };
}

// ─── Brand DNA: a page as structured lines ──────────────────────────────────
//
// Used only by the Brand DNA website read, and only for pages whose words are kept (`parseHtmlPage` above is
// unchanged and never calls this). Each output line starts with a marker that the Brand DNA comparison ignores:
// "# " h1, "## " h2 … "###### " h6, "• " list item (also a typed "- " or "• " bullet), "| " table row with its cells
// joined by " | ", "❝ " customer words; no marker for a paragraph. One linear pass over the tags; input over 2 MB is
// cut first; nesting deeper than 200 is ignored.

/** Pages over this size are cut before they are read. */
export const BRAND_HTML_LIMIT = 2_000_000;
const NEST_LIMIT = 200;
/** Tags whose content is never page text. Skipped whole by jumping to their closing tag. */
const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'template', 'svg', 'iframe', 'select', 'textarea', 'head', 'object', 'canvas', 'math']);
/** Struck-through text is not the business's current words. */
const STRUCK_TAGS = new Set(['s', 'del', 'strike']);
/** Inline tags: text on either side joins with no space. Every other tag separates words. */
const INLINE_TAGS = new Set(['a', 'span', 'b', 'strong', 'i', 'em', 'u', 'small', 'mark', 'abbr', 'code', 'label', 'button']);
/** Line elements that are one paragraph of their parent (an attribution is beside its quote when both share the parent). */
const PARA_TAGS = new Set(['p', 'li', 'dt', 'dd', 'caption', 'figcaption', 'blockquote', 'address', 'pre']);
/** Tags that end a line. */
const LINE_TAGS = new Set(['p', 'div', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'section', 'article', 'dt', 'dd', 'ul', 'ol', 'dl', 'table', 'thead', 'tbody', 'tfoot', 'caption',
  'blockquote', 'figure', 'figcaption', 'header', 'footer', 'nav', 'main', 'aside', 'form', 'address', 'tr', 'pre', 'details', 'summary', 'fieldset', 'legend', 'center', 'br', 'hr']);
const VOID_TAGS = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'source', 'wbr', 'area', 'col', 'embed', 'track', 'param', 'base']);
/** Elements that hold customer words. */
const QUOTED_TAGS = new Set(['blockquote', 'q', 'cite']);
/** Parts of a class or id name (split on "-" and "_") that mark customer words: whole parts only, never on html, body or main. */
const QUOTED_PARTS = new Set(['testimonial', 'testimonials', 'review', 'reviews', 'trustpilot', 'feefo']);
/** Class names that mark a star rating (never "rating" alone). */
const STAR_TOKENS = new Set(['stars', 'star-rating']);
/** True when a class or id marks customer words: a part from QUOTED_PARTS; "quote" only as `wp-block-quote` or `blockquote`, or a class that is exactly "quote" on a figure, blockquote or q. */
function quotedByAttrs(tag: string, attrs: string, tokens: readonly string[]): boolean {
  if (tokens.some((k) => k === 'wp-block-quote' || k === 'blockquote' || k.split(/[-_]+/).some((part) => QUOTED_PARTS.has(part)))) return true;
  if (tag !== 'figure' && tag !== 'blockquote' && tag !== 'q') return false;
  const cls = /\bclass\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
  return Boolean(cls && (cls[1] ?? cls[2] ?? cls[3] ?? '').trim().toLowerCase() === 'quote');
}
/** A heading that starts a section of customer words, up to the next heading or the end of its container. */
const QUOTED_SECTION = /^(?:(?:our|customer|client|google|latest|recent|real|happy)\s+)*(?:reviews|testimonials|feedback)$|\bwhat (?:our |my )?(?:customers|clients|landlords|tenants|students|people|members|buyers|sellers|homeowners|users|patients|guests|families|owners|parents|learners) (?:say|think)\b|\bwhat people say\b|\bkind words\b|\bfeedback from\b|\bin their (?:own )?words\b|\b(?:client|customer|success) stories\b|\btestimonials\b|\bdon['’]t (?:just )?take our word for it\b|\bhappy (?:customers|clients)\b/i;
/** A short line naming who said the line above it, as a page writes it under a quote: "Sarah T, landlord", "Mark, Whitstable",
 * "Mrs K". It marks the line above it whatever that line looks like. (Not a place list, which has two commas or an "and".) */
const NAMED_BY = /^(?:[\p{Lu}][\p{L}'’.-]*(?:\s+[\p{Lu}][\p{L}'’.-]*){0,3}\s*,\s*[\p{L}][\p{L}'’-]*(?:\s+[\p{L}][\p{L}'’-]*){0,3}|(?:Mr|Mrs|Ms|Miss|Mx|Dr)\.?\s+[\p{Lu}]\.?)$/u;
const namedBy = (text: string) => (text.includes(',') || /^M[rsx]|^Miss|^Dr/.test(text)) && text.length <= 60 && text.split(/\s+/).length <= 6 && !/\p{N}/u.test(text) && !/\band\b|&/u.test(text) && (text.match(/,/g)?.length ?? 0) <= 1 && NAMED_BY.test(text);
/** A short line naming who said the line above it: marks it only beside italics, quote marks or a star rating. */
const ATTRIBUTION = /^(?:[-–—]\s*)?(?:the\s+[\p{Lu}][\p{L}'’-]*\s+family|[\p{Lu}][\p{L}'’.-]*(?:\s+[\p{Lu}][\p{L}'’.-]*){0,3}(?:\s*,\s*[\p{L}\p{N}][\p{L}\p{N}\s'’-]*){0,2})\.?$/iu;

/** Class or id name parts that make a link a button. */
const BUTTON_PARTS = new Set(['btn', 'button', 'cta']);

interface Segment { kind: 'heading' | 'item' | 'para' | 'row'; level: number; text: string; quoted: boolean; italic: boolean; stars: boolean; container: number }
interface Cell { segments: Segment[]; text: string }
interface TableCtx { rows: Cell[][]; row: Cell[] | null; cell: Cell | null; quoted: boolean }

function classTokens(attrs: string): string[] {
  const out: string[] = [];
  if (!attrs || !/class|id/i.test(attrs)) return out;
  // (Pushed one by one: spreading a very long class list into push() overflows the call stack.)
  for (const m of attrs.matchAll(/\b(class|id)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi)) for (const k of String(m[3] ?? m[4] ?? m[5] ?? '').toLowerCase().split(/\s+/)) if (k) out.push(k);
  return out;
}

/** A page over the limit is cut at the last tag end before it: no part of a tag, and no cut-off word or number, is kept. */
function capHtml(html: string): string {
  if (html.length <= BRAND_HTML_LIMIT) return html;
  const cut = html.slice(0, BRAND_HTML_LIMIT);
  return cut.slice(0, cut.lastIndexOf('>') + 1);
}

/** The main content of an HTML page as Brand DNA lines (the same main-content choice as `parseHtmlPage`). */
export function brandPageHtmlLines(html: string): string {
  return brandPageHtmlRead(html).text;
}

/**
 * The same read, with which of its lines (0-based, in `text`) were wholly action text on the page: a button, a
 * button-styled link or a form control's label. The words are exactly `brandPageHtmlLines`; nothing marks those lines in
 * them (the line numbers are kept beside the text, so a page's own "▸ " or any other glyph is only ever its own words).
 */
export function brandPageHtmlRead(html: string): { readonly text: string; readonly actionLines: readonly number[] } {
  const capped = capHtml(html);
  const lower = capped.toLowerCase();
  const bodyAt = lower.indexOf('<body'), bodyEnd = lower.lastIndexOf('</body>');
  const body = bodyAt !== -1 && bodyEnd > bodyAt ? capped.slice(bodyAt, bodyEnd + 7) : capped;
  const bl = body.toLowerCase();
  for (const tag of ['main', 'article']) {
    const at = bl.search(new RegExp(`<${tag}\\b`));
    const end = at === -1 ? -1 : bl.indexOf(`</${tag}>`, at);
    if (at !== -1 && end !== -1) return readBrandPageLines(body.slice(at, end + tag.length + 3), false);
  }
  return readBrandPageLines(body, true);
}

/**
 * HTML (already the main content) as Brand DNA lines. `dropChrome` skips nav, header and footer, as `parseHtmlPage`
 * does when a page has no main element.
 */
export function brandPageLines(input: string, dropChrome = false): string {
  return readBrandPageLines(input, dropChrome).text;
}

function readBrandPageLines(input: string, dropChrome: boolean): { text: string; actionLines: number[] } {
  const html = capHtml(input);
  const lower = html.toLowerCase();
  const sink: string[][] = [[]];
  const stack: { tag: string; quoted: boolean; stars: boolean; action: boolean }[] = [];
  const open = new Map<string, number>(), overflow = new Map<string, number>();
  let quotedDepth = 0, struckDepth = 0, italicDepth = 0, starsDepth = 0;
  const headingLevels: number[] = [];
  let itemDepth = 0;
  /** A heading that opens a section of customer words, and the stack depth of the container it sits in. */
  let quotedSection = false, quotedSectionDepth = -1;
  /** Words seen in the section since its heading; and, for a heading alone in its container, the next sibling container it covers. */
  let sectionText = false, sectionSibling = false, siblingOpened = false;
  /** An inline tag was passed since the last text: a letter or digit on both sides gets a space between them. */
  let inlineEdge = false;
  /** Action text: a button, a button-styled link, or a form control's label. A line made only of action text is recorded by
   * its line number (`actionAt`, never in the words); a button inside a sentence stays inline and nothing else changes. */
  const actionAt = new Set<number>();
  let actionDepth = 0, formDepth = 0, lineAction = false, linePlain = false;
  let buffer = '', bufferItalicOnly = true, bufferHasText = false, bufferTail = '';
  const tables: TableCtx[] = [];
  let lastSegment: Segment | null = null, containerSeq = 0;
  const containers: { id: number; para: boolean }[] = [];
  /** Containers that hold a star rating (a star/rating class, or a line of stars): a short name line in one is an attribution. */
  const starContainers = new Set<number>();
  const currentContainer = () => {
    const top = containers[containers.length - 1];
    return !top ? 0 : top.para ? containers[containers.length - 2]?.id ?? 0 : top.id;
  };
  const tidy = (t: string) => (t.includes('&') ? decodeEntities(t) : t).replace(/\s+/g, ' ').trim();
  const emit = (seg: Segment) => {
    const t = tables[tables.length - 1];
    if (t?.cell) { t.cell.segments.push(seg); return; }
    const marker = seg.quoted ? '❝ ' : seg.kind === 'heading' ? `${'#'.repeat(Math.min(6, Math.max(1, seg.level)))} ` : seg.kind === 'item' ? '• ' : seg.kind === 'row' ? '| ' : '';
    sink[sink.length - 1]!.push(marker + seg.text);
  };
  const flush = () => {
    const actionLine = lineAction && !linePlain;
    lineAction = false; linePlain = false;
    if (!bufferHasText) { buffer = ''; bufferTail = ''; return; }
    let text = tidy(buffer);
    const italicOnly = bufferHasText && bufferItalicOnly;
    buffer = ''; bufferTail = ''; bufferItalicOnly = true; bufferHasText = false;
    if (!text) return;
    const level = headingLevels.length ? headingLevels[headingLevels.length - 1]! : 0;
    let kind: Segment['kind'] = level ? 'heading' : itemDepth > 0 ? 'item' : 'para';
    // A typed bullet ("- Fixed prices", "• Insured") is a list item, never an attribution.
    const bullet = /^(?:[-–•*]|•)\s+(?=\S)/u.exec(text);
    if (kind === 'para' && bullet) { kind = 'item'; text = text.slice(bullet[0].length); }
    // Words the site itself starts with "#", "|" or "❝" are not our markers: an invisible character keeps them apart.
    if (/^(?:#{1,6} |\| |❝ |• )/u.test(text)) text = `\u200B${text}`;
    // The section of customer words ends when the heading's own container closes (it is the element below the heading).
    // (The heading is still open here, so its container is the element below it; at the top level nothing closes it.)
    if (kind === 'heading') { quotedSection = QUOTED_SECTION.test(text); quotedSectionDepth = stack.length - 2; sectionText = false; sectionSibling = false; siblingOpened = false; }
    else if (quotedSection) sectionText = true;
    // The element that holds this line beside its siblings: a paragraph's (or list item's) parent, else the block itself.
    const container = currentContainer();
    if (/^[★☆⭐✩✪✭✮✯]{3,}/u.test(text)) starContainers.add(container);
    let quoted = quotedDepth > 0 || (quotedSection && kind !== 'heading');
    // A short name line straight after a quoted or italic line, or beside a star rating, is an attribution: both lines are customer words.
    const prev = lastSegment;
    const named = !quoted && kind === 'para' && prev !== null && prev.kind === 'para' && !prev.quoted && namedBy(text);
    if (named || (!quoted && kind === 'para' && prev && prev.kind === 'para' && prev.container === container
      && (prev.italic || /^["“«„]|["”»]$/u.test(prev.text) || prev.stars || starsDepth > 0 || starContainers.has(container))
      && text.length <= 80 && text.split(/\s+/).length <= 6 && !/[!?:;]/.test(text) && ATTRIBUTION.test(text))) {
      quoted = true;
      if (!prev.quoted) {
        prev.quoted = true;
        const lines = sink[sink.length - 1]!, t = tables[tables.length - 1];
        if (!t?.cell && lines.length && lines[lines.length - 1] === prev.text) { lines[lines.length - 1] = `❝ ${prev.text}`; actionAt.delete(lines.length - 1); }
      }
    }
    const seg: Segment = { kind, level, text, quoted, italic: italicOnly, stars: starsDepth > 0, container };
    lastSegment = seg;
    emit(seg);
    // Wholly action text, outside a table: its line number is recorded for the price-structure check (the words are unchanged).
    if (actionLine && kind === 'para' && !seg.quoted && !tables[tables.length - 1]?.cell) actionAt.add(sink[sink.length - 1]!.length - 1);
  };
  const addText = (t: string) => {
    if (struckDepth > 0) return;
    if (inlineEdge && t) {
      inlineEdge = false;
      // (The buffer's last two code units are kept aside: reading the end of a long concatenated buffer would flatten it.)
      if (/[\p{L}\p{N}]$/u.test(bufferTail) && /^[\p{L}\p{N}]/u.test(t)) { buffer += ' '; bufferTail = `${bufferTail.slice(-1)} `; }
    }
    bufferTail = t.length >= 2 ? t.slice(-2) : (bufferTail + t).slice(-2);
    if (t !== ' ' && /\S/.test(t)) { bufferHasText = true; if (italicDepth === 0) bufferItalicOnly = false; if (actionDepth > 0) lineAction = true; else linePlain = true; }
    buffer += t;
  };
  const closeCell = (t: TableCtx) => {
    if (!t.cell) return;
    flush();
    const cell = t.cell;
    cell.text = cell.segments.length === 1 ? cell.segments[0]!.text : cell.segments.map((s) => s.text).join(' ').replace(/\s+/g, ' ').trim();
    t.row?.push(cell); t.cell = null;
  };
  const closeRow = (t: TableCtx) => { closeCell(t); flush(); if (t.row?.length) t.rows.push(t.row); t.row = null; };
  const closeTable = () => {
    // The last cell's words are flushed into it while the table is still the current one (end tags may be omitted).
    closeRow(tables[tables.length - 1]!);
    const t = tables.pop()!;
    // A one-column table, or one with long cells, is page layout: its content is read as ordinary lines.
    const layout = t.rows.every((r) => r.filter((c) => c.text).length <= 1) || t.rows.some((r) => r.some((c) => c.text.length > 300));
    for (const r of t.rows) {
      if (layout) { for (const c of r) for (const s of c.segments) emit(s); continue; }
      const cells = r.map((c) => c.text).filter(Boolean);
      if (cells.length) emit({ kind: 'row', level: 0, text: cells.join(' | '), quoted: t.quoted || r.some((c) => c.segments.some((s) => s.quoted)), italic: false, stars: false, container: 0 });
    }
  };
  let nextGt = -1;
  // `i` is where the pending text starts; `from` where the next "<" is looked for (a "<" that opens no tag is text).
  for (let i = 0, from = 0; i < html.length; from = i) {
    let lt = html.indexOf('<', from);
    while (lt !== -1 && !/[a-zA-Z/!?]/.test(html[lt + 1] ?? '')) lt = html.indexOf('<', lt + 1);
    if (lt === -1) { addText(html.slice(i)); break; }
    if (lt > i) addText(html.slice(i, lt));
    if (html.startsWith('<!--', lt)) { const end = html.indexOf('-->', lt + 4); i = end === -1 ? html.length : end + 3; continue; }
    if (nextGt < lt + 1) { nextGt = html.indexOf('>', lt + 1); if (nextGt === -1) nextGt = html.length; }
    if (nextGt >= html.length) { addText(html.slice(lt)); break; }
    const raw = html.slice(lt + 1, nextGt);
    i = nextGt + 1;
    const m = /^(\/?)([a-zA-Z][\w:-]*)([\s\S]*)$/.exec(raw);
    if (!m) continue; // <!doctype>, <?xml?>
    const closing = m[1] === '/', tag = m[2]!.toLowerCase(), attrs = m[3] ?? '';
    if (!closing && SKIP_TAGS.has(tag) && !/\/\s*$/.test(attrs)) {
      const end = lower.indexOf(`</${tag}`, i);
      if (end === -1) { i = html.length; break; }
      const gt = html.indexOf('>', end);
      i = gt === -1 ? html.length : gt + 1;
      continue;
    }
    if (dropChrome && !closing && (tag === 'nav' || tag === 'header' || tag === 'footer')) {
      const end = lower.indexOf(`</${tag}>`, i);
      i = end === -1 ? html.length : end + tag.length + 3;
      continue;
    }
    const t = tables[tables.length - 1];
    if (!closing) {
      if (tag === 'table') { flush(); tables.push({ rows: [], row: null, cell: null, quoted: quotedDepth > 0 }); }
      else if (t && tag === 'tr') { closeRow(t); t.row = []; }
      else if (t && (tag === 'td' || tag === 'th')) { closeCell(t); if (!t.row) t.row = []; flush(); t.cell = { segments: [], text: '' }; }
      else if (LINE_TAGS.has(tag)) flush();
      else if (!INLINE_TAGS.has(tag)) addText(' ');
      else inlineEdge = true;
      if (tag === 'sup' || tag === 'sub') addText(' ');
      if (VOID_TAGS.has(tag) || /\/\s*$/.test(attrs)) continue;
      if (stack.length >= NEST_LIMIT) { overflow.set(tag, (overflow.get(tag) ?? 0) + 1); continue; }
      const tokens = tag === 'html' || tag === 'body' || tag === 'main' ? [] : classTokens(attrs);
      const quoted = QUOTED_TAGS.has(tag) || quotedByAttrs(tag, attrs, tokens);
      const stars = tokens.some((k) => STAR_TOKENS.has(k));
      if (stars) starContainers.add(currentContainer());
      const action = tag === 'button' || (tag === 'label' && formDepth > 0)
        || (tag === 'a' && (/\brole\s*=\s*["']?button/i.test(attrs) || tokens.some((k) => k.split(/[-_]+/).some((part) => BUTTON_PARTS.has(part)))));
      stack.push({ tag, quoted, stars, action });
      if (action) actionDepth++;
      if (tag === 'form') formDepth++;
      if (quotedSection && sectionSibling && !siblingOpened && stack.length === quotedSectionDepth + 1) siblingOpened = true;
      open.set(tag, (open.get(tag) ?? 0) + 1);
      if (quoted) quotedDepth++;
      if (stars) starsDepth++;
      if (STRUCK_TAGS.has(tag)) struckDepth++;
      if (tag === 'i' || tag === 'em') italicDepth++;
      if (/^h[1-6]$/.test(tag)) headingLevels.push(Number(tag[1]));
      if (tag === 'li') itemDepth++;
      if (LINE_TAGS.has(tag) && !/^h[1-6]$/.test(tag)) containers.push({ id: ++containerSeq, para: PARA_TAGS.has(tag) });
      continue;
    }
    // Any end tag but a pure inline one separates the words on either side, whether or not it closes anything.
    if (!INLINE_TAGS.has(tag)) addText(' '); else inlineEdge = true;
    if ((overflow.get(tag) ?? 0) > 0) { overflow.set(tag, overflow.get(tag)! - 1); continue; }
    if (!(open.get(tag) ?? 0)) continue;
    if (t && (tag === 'td' || tag === 'th')) closeCell(t);
    else if (t && tag === 'tr') closeRow(t);
    else if (tag === 'table' && t) { /* handled after popping */ }
    else if (LINE_TAGS.has(tag)) flush();
    while (stack.length) {
      const x = stack.pop()!;
      open.set(x.tag, open.get(x.tag)! - 1);
      if (x.action) actionDepth--;
      if (x.tag === 'form') formDepth--;
      if (x.quoted) quotedDepth--;
      if (x.stars) starsDepth--;
      if (STRUCK_TAGS.has(x.tag)) struckDepth--;
      if (x.tag === 'i' || x.tag === 'em') italicDepth--;
      if (/^h[1-6]$/.test(x.tag)) headingLevels.pop();
      if (x.tag === 'li') itemDepth--;
      if (LINE_TAGS.has(x.tag) && !/^h[1-6]$/.test(x.tag)) containers.pop();
      if (x.tag === 'table' && tables.length) closeTable();
      // A section of customer words ends when the container that held its heading closes. A heading alone in its container
      // (a page builder's heading widget) covers the next sibling container too.
      if (quotedSection && !sectionSibling && stack.length <= quotedSectionDepth) {
        flush();
        if (sectionText) quotedSection = false; else { sectionSibling = true; siblingOpened = false; quotedSectionDepth = stack.length; }
      } else if (quotedSection && sectionSibling) {
        if (!siblingOpened && stack.length < quotedSectionDepth) quotedSectionDepth = stack.length;
        else if (siblingOpened && stack.length <= quotedSectionDepth) { flush(); quotedSection = false; }
      }
      if (x.tag === tag) break;
    }
  }
  while (tables.length) closeTable();
  flush();
  return { text: sink[0]!.join('\n'), actionLines: [...actionAt].sort((a, b) => a - b) };
}
