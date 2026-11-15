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
  /**
   * Brand DNA only: the main content as lines, each starting with a structure marker ("# " heading, "• " list item,
   * "| " table row with cells joined by " | ", "❝ " testimonial or quoted material, none for a paragraph). Struck-through
   * text is left out. `text` above is unchanged and is what every other reader uses.
   */
  readonly structured: string;
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
    structured: brandPageLines(mainHtml).slice(0, 200_000),
    publishedAt: validDate(publishedAt),
    modifiedAt: validDate(modifiedAt),
    links,
  };
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

// ─── Brand DNA: the page as structured lines ────────────────────────────────

const LINE_TAGS = new Set(['p', 'div', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'section', 'article', 'dt', 'dd', 'ul', 'ol', 'dl', 'table', 'thead', 'tbody', 'tfoot', 'caption',
  'blockquote', 'figure', 'figcaption', 'header', 'footer', 'nav', 'main', 'aside', 'form', 'address', 'tr', 'pre', 'details', 'summary']);
const VOID_LINE_TAGS = new Set(['br', 'hr']);
const VOID_TAGS = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'source', 'wbr', 'area', 'col', 'embed', 'track', 'param', 'base']);
/** Elements whose words are a customer's, or quoted: their lines are marked "❝ ". */
const QUOTED_TAGS = new Set(['blockquote', 'q', 'cite']);
const QUOTED_CLASS = /testimonial|review|quote|rating|stars|trustpilot|feedback/i;
/** A heading that starts a section of customer words, up to the next heading. */
const QUOTED_SECTION = /^(?:(?:our|customer|client|google|latest|recent|real|happy)\s+)*(?:reviews|testimonials|feedback)$|\bwhat (?:our |my )?(?:customers|clients|landlords|tenants|students|people|members|buyers|sellers|homeowners|users|patients|guests|families) (?:say|think)\b|\bkind words\b|\bfeedback from\b|\bin their (?:own )?words\b|\b(?:client|customer|success) stories\b|\btestimonials\b/i;

/**
 * The page's main content as structured lines for Brand DNA (see `ParsedPage.structured`). One linear pass over the
 * tags; struck-through text (s, del, strike) is removed, not stored; label and button do not end a line.
 */
export function brandPageLines(html: string): string {
  const clean = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template|svg|iframe)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<(s|del|strike)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ');
  const out: string[] = [];
  const stack: { tag: string; quoted: boolean }[] = [];
  let quotedDepth = 0, headingDepth = 0, itemDepth = 0, quotedSection = false;
  let buffer = '';
  let row: string[] | null = null, cell: string | null = null;
  const tidy = (t: string) => decodeEntities(t).replace(/\s+/g, ' ').trim();
  const flush = () => {
    const text = tidy(buffer);
    buffer = '';
    if (!text) return;
    if (headingDepth > 0) quotedSection = QUOTED_SECTION.test(text);
    const quoted = quotedDepth > 0 || (quotedSection && headingDepth === 0);
    out.push(`${quoted ? '❝ ' : headingDepth > 0 ? '# ' : itemDepth > 0 ? '• ' : ''}${text}`);
  };
  for (const m of clean.matchAll(/<(\/?)([a-zA-Z][\w-]*)([^>]*)>|([^<]+)/g)) {
    if (m[4] !== undefined) { if (cell !== null) cell += m[4]; else buffer += m[4]; continue; }
    const closing = m[1] === '/', tag = m[2]!.toLowerCase(), attrs = m[3] ?? '';
    if (!closing) {
      if (VOID_LINE_TAGS.has(tag)) { if (cell !== null) cell += ' '; else flush(); continue; }
      if (tag === 'tr') { flush(); row = []; }
      else if ((tag === 'td' || tag === 'th') && row) { cell = ''; }
      else if (LINE_TAGS.has(tag) && cell === null) flush();
      else if (cell === null && !LINE_TAGS.has(tag)) buffer += ' ';
      if (VOID_TAGS.has(tag) || /\/\s*$/.test(attrs)) continue;
      const quoted = QUOTED_TAGS.has(tag) || QUOTED_CLASS.test(/\b(?:class|id)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/i.exec(attrs)?.[1] ?? '');
      stack.push({ tag, quoted });
      if (quoted) quotedDepth++;
      if (/^h[1-6]$/.test(tag)) headingDepth++;
      if (tag === 'li') itemDepth++;
      continue;
    }
    const at = stack.map((x) => x.tag).lastIndexOf(tag);
    if (at === -1) continue;
    if ((tag === 'td' || tag === 'th') && row && cell !== null) { row.push(tidy(cell)); cell = null; }
    else if (tag === 'tr' && row) {
      if (cell !== null) { row.push(tidy(cell)); cell = null; }
      const cells = row.filter(Boolean);
      if (cells.length) out.push(`${quotedDepth > 0 || quotedSection ? '❝ ' : '| '}${cells.join(' | ')}`);
      row = null;
    } else if (LINE_TAGS.has(tag) && cell === null) flush();
    else if (cell === null) buffer += ' ';
    while (stack.length > at) {
      const x = stack.pop()!;
      if (x.quoted) quotedDepth--;
      if (/^h[1-6]$/.test(x.tag)) headingDepth--;
      if (x.tag === 'li') itemDepth--;
    }
  }
  if (cell !== null && row) row.push(tidy(cell));
  if (row?.some(Boolean)) out.push(`| ${row.filter(Boolean).join(' | ')}`);
  flush();
  return out.join('\n');
}
