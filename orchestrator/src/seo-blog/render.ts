/**
 * Server-side rendering of published articles, the blog index and sitemap
 * entries, plus the portable Markdown/HTML export.
 *
 * Every value is escaped. Bodies are a restricted Markdown subset rendered by
 * this module only — generated text can never inject markup or scripts.
 * Structured data states only what is true (headline, description, dates the
 * engine actually observed, the configured author, the image); nothing is
 * invented.
 */

import { escapeHtml, escapeXml } from './html.js';
import type { ArticleBody, ArticleSourceCitation } from './types.js';

export interface RenderContext {
  readonly siteName: string;
  readonly canonicalUrl: string;
  readonly blogIndexUrl: string;
  readonly locale: string;
  /** Instant of this publication attempt (shown as the published date). */
  readonly publishedAt: string;
  readonly articleId: string;
  readonly versionId: string;
  readonly contentSha: string;
  /** Optional destination template with {{…}} slots; defaults to a neutral, readable layout. */
  readonly template?: string | null;
  readonly noindex?: boolean;
}

/** Marker embedded in every rendered page; reconciliation reads it back from the public URL. */
export function versionMarker(articleId: string, versionId: string, contentSha: string): string {
  return `r72-blog:${articleId}:${versionId}:${contentSha.slice(0, 16)}`;
}

function inline(text: string, citeNumber: (id: string) => number | null, canonical: string): string {
  // Escape first, then re-introduce the small set of allowed constructs.
  let out = escapeHtml(text);
  out = out.replace(/\[src:([A-Za-z0-9-]{1,64})\]/g, (_m, id: string) => {
    const n = citeNumber(id);
    return n ? `<sup><a href="#source-${n}">[${n}]</a></sup>` : '';
  });
  out = out.replace(/\[([^\]\n]{1,200})\]\((https:\/\/[^\s)]{1,500})\)/g, (_m, label: string, href: string) => {
    let external = true;
    try { external = new URL(href.replace(/&amp;/g, '&')).host !== new URL(canonical).host; } catch { /* keep external */ }
    return `<a href="${href}"${external ? ' rel="noopener"' : ''}>${label}</a>`;
  });
  out = out.replace(/\*\*([^*\n]{1,300})\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*])\*([^*\n]{1,300})\*/g, '$1<em>$2</em>');
  return out;
}

export function renderMarkdown(markdown: string, citeNumber: (id: string) => number | null, canonical: string): string {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const html: string[] = [];
  let list: 'ul' | 'ol' | null = null;
  let para: string[] = [];
  const flushPara = () => {
    if (para.length) html.push(`<p>${inline(para.join(' '), citeNumber, canonical)}</p>`);
    para = [];
  };
  const closeList = () => { if (list) html.push(`</${list}>`); list = null; };
  for (const raw of lines) {
    const line = raw.trim();
    const bullet = /^[-*]\s+(.+)$/.exec(line);
    const numbered = /^\d{1,3}[.)]\s+(.+)$/.exec(line);
    if (bullet || numbered) {
      flushPara();
      const kind = bullet ? 'ul' : 'ol';
      if (list !== kind) { closeList(); html.push(`<${kind}>`); list = kind; }
      html.push(`<li>${inline((bullet ?? numbered)![1]!, citeNumber, canonical)}</li>`);
      continue;
    }
    if (!line) { flushPara(); closeList(); continue; }
    // Headings inside bodies are flattened to bold paragraphs: one H1 per page, H2s come from sections.
    const heading = /^#{1,6}\s+(.+)$/.exec(line);
    if (heading) { flushPara(); closeList(); html.push(`<p><strong>${inline(heading[1]!, citeNumber, canonical)}</strong></p>`); continue; }
    closeList();
    para.push(line);
  }
  flushPara();
  closeList();
  return html.join('\n');
}

export function citationNumbers(body: ArticleBody): { list: ArticleSourceCitation[]; number: (id: string) => number | null } {
  const publicSources = body.citations.filter((c) => c.public);
  const order: string[] = [];
  const text = [body.intro, ...body.sections.map((s) => s.body), body.conclusion, ...body.faqs.map((f) => f.a)].join('\n');
  for (const m of text.matchAll(/\[src:([A-Za-z0-9-]{1,64})\]/g)) {
    if (!order.includes(m[1]!) && publicSources.some((c) => c.sourceId === m[1])) order.push(m[1]!);
  }
  for (const c of publicSources) if (!order.includes(c.sourceId)) order.push(c.sourceId);
  const list = order.map((id) => publicSources.find((c) => c.sourceId === id)!).filter(Boolean);
  return { list, number: (id) => { const i = order.indexOf(id); return i >= 0 ? i + 1 : null; } };
}

function jsonLd(body: ArticleBody, ctx: RenderContext): string {
  const data: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    headline: body.title.slice(0, 110),
    description: body.metaDescription,
    mainEntityOfPage: ctx.canonicalUrl,
    datePublished: ctx.publishedAt,
    inLanguage: ctx.locale,
    publisher: { '@type': 'Organization', name: ctx.siteName },
  };
  if (body.author) data.author = { '@type': 'Person', name: body.author.name, ...(body.author.url ? { url: body.author.url } : {}) };
  else data.author = { '@type': 'Organization', name: ctx.siteName };
  if (body.image.url) data.image = body.image.url;
  // `<` is escaped so no string can terminate the script element.
  return JSON.stringify(data).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
}

const DEFAULT_TEMPLATE = `<!DOCTYPE html>
<html lang="{{lang}}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
{{head}}
<style>
body{margin:0;font:18px/1.65 system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;color:#1b1f24;background:#fff}
main{max-width:720px;margin:0 auto;padding:32px 20px 64px}
h1{font-size:2rem;line-height:1.2;margin:.2em 0 .4em}h2{font-size:1.4rem;margin:1.8em 0 .5em}
a{color:#0b5cad}img{max-width:100%;height:auto;border-radius:8px}.meta{color:#5b6570;font-size:.9rem}
.cta{display:inline-block;margin:1em 0;padding:.7em 1.1em;background:#0b5cad;color:#fff;border-radius:6px;text-decoration:none}
.sources{font-size:.9rem;color:#3d4650}nav.crumbs{font-size:.9rem}
@media (prefers-color-scheme:dark){body{background:#111417;color:#e6e9ec}a{color:#7cb7ff}.meta,.sources{color:#a7b0b9}}
</style>
</head>
<body>
<main>
{{content}}
</main>
</body>
</html>`;

export function renderArticlePage(body: ArticleBody, ctx: RenderContext): string {
  const cites = citationNumbers(body);
  const md = (text: string) => renderMarkdown(text, cites.number, ctx.canonicalUrl);
  const dateLabel = new Intl.DateTimeFormat(ctx.locale || 'en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(ctx.publishedAt));
  const head = [
    `<title>${escapeHtml(body.seoTitle)}</title>`,
    `<meta name="description" content="${escapeHtml(body.metaDescription)}">`,
    `<link rel="canonical" href="${escapeHtml(ctx.canonicalUrl)}">`,
    ctx.noindex ? '<meta name="robots" content="noindex, nofollow">' : '<meta name="robots" content="index, follow">',
    `<meta property="og:type" content="article">`,
    `<meta property="og:title" content="${escapeHtml(body.seoTitle)}">`,
    `<meta property="og:description" content="${escapeHtml(body.metaDescription)}">`,
    `<meta property="og:url" content="${escapeHtml(ctx.canonicalUrl)}">`,
    body.image.url ? `<meta property="og:image" content="${escapeHtml(body.image.url)}">` : '',
    `<meta property="article:published_time" content="${escapeHtml(ctx.publishedAt)}">`,
    `<meta name="r72-blog-version" content="${escapeHtml(versionMarker(ctx.articleId, ctx.versionId, ctx.contentSha))}">`,
    `<script type="application/ld+json">${jsonLd(body, ctx)}</script>`,
  ].filter(Boolean).join('\n');
  const content = [
    `<nav class="crumbs"><a href="${escapeHtml(ctx.blogIndexUrl)}">Blog</a></nav>`,
    `<article>`,
    `<h1>${escapeHtml(body.title)}</h1>`,
    `<p class="meta">${body.author ? `By ${escapeHtml(body.author.name)} · ` : ''}<time datetime="${escapeHtml(ctx.publishedAt)}">${escapeHtml(dateLabel)}</time></p>`,
    body.image.url ? `<figure><img src="${escapeHtml(body.image.url)}" alt="${escapeHtml(body.image.alt)}"${body.image.width ? ` width="${body.image.width}"` : ''}${body.image.height ? ` height="${body.image.height}"` : ''} loading="eager"></figure>` : '',
    md(body.intro),
    ...body.sections.map((s) => `<h2>${escapeHtml(s.heading)}</h2>\n${md(s.body)}`),
    body.faqs.length ? `<h2>Frequently asked questions</h2>\n${body.faqs.map((f) => `<h3>${escapeHtml(f.q)}</h3>\n${md(f.a)}`).join('\n')}` : '',
    md(body.conclusion),
    body.cta ? `<p><a class="cta" href="${escapeHtml(body.cta.url)}">${escapeHtml(body.cta.label)}</a></p>` : '',
    cites.list.length
      ? `<section class="sources"><h2>Sources</h2><ol>${cites.list.map((c, i) => `<li id="source-${i + 1}"><a href="${escapeHtml(c.url)}" rel="noopener">${escapeHtml(c.title)}</a> (accessed ${escapeHtml(c.retrievedAt.slice(0, 10))})</li>`).join('')}</ol></section>`
      : '',
    `</article>`,
  ].filter(Boolean).join('\n');
  return fillTemplate(ctx.template ?? DEFAULT_TEMPLATE, { lang: escapeHtml(ctx.locale || 'en-GB'), head, content, title: escapeHtml(body.seoTitle) });
}

export function fillTemplate(template: string, slots: Record<string, string>): string {
  if (!template.includes('{{content}}') || !template.includes('{{head}}')) throw new Error('The blog template must contain {{head}} and {{content}} slots.');
  return template.replace(/\{\{(lang|head|content|title)\}\}/g, (_m, key: string) => slots[key] ?? '');
}

export interface IndexEntry {
  readonly title: string;
  readonly url: string;
  readonly excerpt: string;
  readonly publishedAt: string;
  readonly articleId: string;
}

export const INDEX_MANIFEST_START = '<!-- r72-blog-index:';
export const INDEX_MANIFEST_END = ' -->';

/** The blog index carries its own entry manifest so updates are exact and idempotent. */
export function readIndexManifest(html: string | null): IndexEntry[] {
  if (!html) return [];
  const start = html.indexOf(INDEX_MANIFEST_START);
  if (start < 0) return [];
  const end = html.indexOf(INDEX_MANIFEST_END, start);
  try {
    const parsed = JSON.parse(Buffer.from(html.slice(start + INDEX_MANIFEST_START.length, end).trim(), 'base64').toString('utf8')) as IndexEntry[];
    return Array.isArray(parsed) ? parsed.filter((e) => e && typeof e.url === 'string' && typeof e.articleId === 'string') : [];
  } catch {
    return [];
  }
}

export function upsertIndexEntry(entries: readonly IndexEntry[], entry: IndexEntry): IndexEntry[] {
  return [entry, ...entries.filter((e) => e.articleId !== entry.articleId && e.url !== entry.url)]
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
}

export function renderIndexPage(entries: readonly IndexEntry[], ctx: { siteName: string; indexUrl: string; locale: string; template?: string | null }): string {
  const head = [
    `<title>${escapeHtml(`Blog | ${ctx.siteName}`)}</title>`,
    `<meta name="description" content="${escapeHtml(`Articles and guides from ${ctx.siteName}.`)}">`,
    `<link rel="canonical" href="${escapeHtml(ctx.indexUrl)}">`,
    '<meta name="robots" content="index, follow">',
  ].join('\n');
  const fmt = new Intl.DateTimeFormat(ctx.locale || 'en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
  const content = [
    `<h1>Blog</h1>`,
    entries.length === 0 ? '<p>No articles have been published yet.</p>' : '',
    ...entries.map((e) => `<article><h2><a href="${escapeHtml(e.url)}">${escapeHtml(e.title)}</a></h2><p class="meta"><time datetime="${escapeHtml(e.publishedAt)}">${escapeHtml(fmt.format(new Date(e.publishedAt)))}</time></p><p>${escapeHtml(e.excerpt)}</p></article>`),
    `${INDEX_MANIFEST_START}${Buffer.from(JSON.stringify(entries)).toString('base64')}${INDEX_MANIFEST_END}`,
  ].filter(Boolean).join('\n');
  return fillTemplate(ctx.template ?? DEFAULT_TEMPLATE, { lang: escapeHtml(ctx.locale || 'en-GB'), head, content, title: 'Blog' });
}

/**
 * Add `urls` to an existing sitemap, preserving every existing entry and the
 * file's own conventions (lastmod only if the file already uses it).
 */
export function mergeSitemap(existing: string, urls: readonly { loc: string; lastmod: string }[]): string {
  if (!/<urlset\b/i.test(existing)) throw new Error('The sitemap is not a standard <urlset> file.');
  const usesLastmod = /<lastmod>/i.test(existing);
  let out = existing;
  for (const { loc, lastmod } of urls) {
    const escaped = escapeXml(loc);
    if (out.includes(`<loc>${escaped}</loc>`)) continue;
    const entry = usesLastmod ? `<url><loc>${escaped}</loc><lastmod>${escapeXml(lastmod.slice(0, 10))}</lastmod></url>` : `<url><loc>${escaped}</loc></url>`;
    const indent = /\n(\s*)<url>/.exec(out)?.[1] ?? '';
    out = out.replace(/<\/urlset>\s*$/i, `${indent}${entry}\n</urlset>\n`);
  }
  return out;
}

export function exportMarkdown(body: ArticleBody, meta: { canonicalUrl: string | null; versionId: string; articleId: string }): string {
  const cites = citationNumbers(body);
  const strip = (t: string) => t.replace(/\[src:([A-Za-z0-9-]{1,64})\]/g, (_m, id: string) => { const n = cites.number(id); return n ? `[^${n}]` : ''; });
  const front = [
    '---',
    `title: ${JSON.stringify(body.title)}`,
    `seo_title: ${JSON.stringify(body.seoTitle)}`,
    `description: ${JSON.stringify(body.metaDescription)}`,
    `slug: ${body.slug}`,
    meta.canonicalUrl ? `canonical: ${meta.canonicalUrl}` : null,
    body.author ? `author: ${JSON.stringify(body.author.name)}` : null,
    body.image.url ? `image: ${body.image.url}` : null,
    `image_alt: ${JSON.stringify(body.image.alt)}`,
    `article_id: ${meta.articleId}`,
    `version_id: ${meta.versionId}`,
    '---',
  ].filter((l): l is string => l !== null).join('\n');
  return [
    front, '', `# ${body.title}`, '', strip(body.intro), '',
    ...body.sections.flatMap((s) => [`## ${s.heading}`, '', strip(s.body), '']),
    ...(body.faqs.length ? ['## Frequently asked questions', '', ...body.faqs.flatMap((f) => [`### ${f.q}`, '', strip(f.a), ''])] : []),
    strip(body.conclusion), '',
    ...(body.cta ? [`[${body.cta.label}](${body.cta.url})`, ''] : []),
    ...cites.list.map((c, i) => `[^${i + 1}]: ${c.title} — ${c.url} (accessed ${c.retrievedAt.slice(0, 10)})`),
    '',
  ].join('\n');
}
