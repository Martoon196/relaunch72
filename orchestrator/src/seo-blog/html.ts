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
  return {
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
