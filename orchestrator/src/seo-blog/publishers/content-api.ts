/**
 * Signed content-API publisher, for websites that render pages server-side
 * (for example a FastAPI or Express app) and can store a small blog collection.
 * Avoids a full application deployment per article.
 *
 * Contract the website implements (see docs/seo-blog-engine.md):
 *   POST {endpoint}            publish one exact article version (idempotent on articleId+versionId)
 *   GET  {endpoint}/status?article=…&version=…   reconciliation read
 * Every request is signed: X-R72-Timestamp + X-R72-Signature =
 * hex(HMAC-SHA256(secret, `${timestamp}.${method}.${path}.${sha256(body)}`)).
 * The site rejects signatures older than five minutes.
 */

import { createHash, createHmac } from 'node:crypto';
import type { Destination } from '../types.js';
import { SeoBlogError } from '../types.js';
import { citationNumbers, renderMarkdown, versionMarker } from '../render.js';
import { escapeHtml } from '../html.js';
import {
  cleanPath, PublisherOutcomeUnknownError, PublisherRejectedError, requireHttpsBase,
  type ExistingState, type PublishInput, type PublishOutcome, type ValidatedDestination, type WebsitePublisher,
} from './types.js';

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export function contentApiSignature(secret: string, timestamp: string, method: string, path: string, body: string): string {
  const bodySha = createHash('sha256').update(body).digest('hex');
  return createHmac('sha256', secret).update(`${timestamp}.${method}.${path}.${bodySha}`).digest('hex');
}

/** Article body as escaped HTML (no <html>/<head>): the site wraps it in its own layout. */
export function renderArticleFragment(input: PublishInput, canonicalUrl: string): string {
  const body = input.body;
  const cites = citationNumbers(body);
  const md = (t: string) => renderMarkdown(t, cites.number, canonicalUrl);
  return [
    md(body.intro),
    ...body.sections.map((s) => `<h2>${escapeHtml(s.heading)}</h2>\n${md(s.body)}`),
    body.faqs.length ? `<h2>Frequently asked questions</h2>\n${body.faqs.map((f) => `<h3>${escapeHtml(f.q)}</h3>\n${md(f.a)}`).join('\n')}` : '',
    md(body.conclusion),
    body.cta ? `<p><a class="cta" href="${escapeHtml(body.cta.url)}">${escapeHtml(body.cta.label)}</a></p>` : '',
    cites.list.length ? `<section class="sources"><h2>Sources</h2><ol>${cites.list.map((c, i) => `<li id="source-${i + 1}"><a href="${escapeHtml(c.url)}" rel="noopener">${escapeHtml(c.title)}</a> (accessed ${escapeHtml(c.retrievedAt.slice(0, 10))})</li>`).join('')}</ol></section>` : '',
  ].filter(Boolean).join('\n');
}

export class ContentApiPublisher implements WebsitePublisher {
  readonly type = 'content_api' as const;
  readonly label = 'Website content API (signed)';
  readonly description = 'For server-rendered websites that implement the small signed blog endpoint. The site stores each article and renders the page, blog index and sitemap itself — no deployment per article.';
  readonly credentialLabel = 'Shared signing secret configured on the website (at least 32 characters)';
  readonly fields = [
    { key: 'endpoint', label: 'Publishing endpoint', help: 'https://…/api/blog/publish on your website.', required: true, placeholder: 'https://www.example.com/api/blog/publish' },
    { key: 'publicBaseUrl', label: 'Public website address', help: 'https://… — the domain readers use.', required: true, placeholder: 'https://www.example.com' },
    { key: 'blogPath', label: 'Blog path', help: 'Where the site serves articles. Default: blog', required: false, placeholder: 'blog' },
  ] as const;

  constructor(private readonly fetchImpl: FetchLike = fetch, private readonly timeoutMs = 20_000, private readonly clock: () => number = Date.now) {}

  validateConfig(raw: Readonly<Record<string, string>>): ValidatedDestination {
    const endpoint = requireHttpsBase(raw.endpoint, 'Publishing endpoint');
    const publicBaseUrl = requireHttpsBase(raw.publicBaseUrl, 'Public website address');
    if (new URL(endpoint).host !== new URL(publicBaseUrl).host) throw new SeoBlogError(400, 'The publishing endpoint must be on the same website as the public address.');
    const blogPath = cleanPath(raw.blogPath, 'blog', 'Blog path');
    return { config: { endpoint, publicBaseUrl, blogPath }, publicBaseUrl };
  }

  publicUrlFor(destination: Destination, slug: string): string {
    return `${destination.publicBaseUrl}/${destination.config.blogPath}/${slug}`;
  }

  indexUrlFor(destination: Destination): string {
    return `${destination.publicBaseUrl}/${destination.config.blogPath}`;
  }

  private async signed(destination: Destination, credential: string, method: 'GET' | 'POST', suffix: string, body = ''): Promise<{ status: number; json: Record<string, unknown> }> {
    const url = new URL(`${destination.config.endpoint}${suffix}`);
    const timestamp = String(Math.floor(this.clock() / 1000));
    const signature = contentApiSignature(credential, timestamp, method, url.pathname, body);
    let res: Response;
    try {
      res = await this.fetchImpl(url.toString(), {
        method,
        headers: { 'content-type': 'application/json', 'x-r72-timestamp': timestamp, 'x-r72-signature': signature, 'user-agent': 'Relaunch72-SEO-Blog' },
        ...(method === 'POST' ? { body } : {}),
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new PublisherOutcomeUnknownError(`The website did not answer (${(error as Error).name}).`);
    }
    if (res.status >= 500 || res.status === 408 || res.status === 429) throw new PublisherOutcomeUnknownError(`The website answered HTTP ${res.status}.`);
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: res.status, json };
  }

  async checkConnection(destination: Destination, credential: string): Promise<{ ok: boolean; detail: string }> {
    if (credential.length < 32) return { ok: false, detail: 'The signing secret must be at least 32 characters.' };
    try {
      const res = await this.signed(destination, credential, 'GET', '/status?check=1');
      if (res.status === 200 && res.json.ok === true) return { ok: true, detail: 'The website accepted a signed connection check.' };
      if (res.status === 401 || res.status === 403) return { ok: false, detail: 'The website rejected the signing secret.' };
      return { ok: false, detail: `The website answered HTTP ${res.status}.` };
    } catch (error) {
      return { ok: false, detail: (error as Error).message };
    }
  }

  async findExisting(input: PublishInput): Promise<{ state: ExistingState; providerRef: string | null }> {
    const res = await this.signed(input.destination, input.credential, 'GET', `/status?article=${encodeURIComponent(input.articleId)}&version=${encodeURIComponent(input.versionId)}`);
    if (res.status !== 200) throw new PublisherOutcomeUnknownError(`The website status check answered HTTP ${res.status}.`);
    const state = res.json.state;
    if (state === 'present' || state === 'absent' || state === 'other_version') return { state, providerRef: typeof res.json.ref === 'string' ? res.json.ref : null };
    throw new PublisherOutcomeUnknownError('The website status check returned an unexpected answer.');
  }

  async publish(input: PublishInput): Promise<PublishOutcome> {
    const publicUrl = this.publicUrlFor(input.destination, input.body.slug);
    const payload = JSON.stringify({
      operationId: input.operationId,
      articleId: input.articleId,
      versionId: input.versionId,
      contentSha: input.contentSha,
      marker: versionMarker(input.articleId, input.versionId, input.contentSha),
      slug: input.body.slug,
      title: input.body.title,
      seoTitle: input.body.seoTitle,
      metaDescription: input.body.metaDescription,
      excerpt: input.body.excerpt,
      canonicalUrl: publicUrl,
      publishedAt: input.publishedAt,
      author: input.body.author,
      image: input.body.image.url ? { url: input.body.image.url, alt: input.body.image.alt, width: input.body.image.width, height: input.body.image.height } : null,
      locale: input.locale,
      articleHtml: renderArticleFragment(input, publicUrl),
    });
    if (payload.length > 1_500_000) throw new PublisherRejectedError('The article is too large for the website endpoint.');
    const res = await this.signed(input.destination, input.credential, 'POST', '', payload);
    if (res.status === 200 || res.status === 201) {
      const status = res.json.status === 'already_present' ? 'already_present' : 'accepted';
      return { status, providerRef: typeof res.json.ref === 'string' ? res.json.ref : input.operationId, publicUrl };
    }
    if (res.status === 409) throw new PublisherRejectedError(typeof res.json.error === 'string' ? res.json.error.slice(0, 200) : 'The website refused this slug.');
    if (res.status === 401 || res.status === 403) throw new PublisherRejectedError('The website rejected the signing secret. Reconnect the website.');
    throw new PublisherRejectedError(`The website refused the article (HTTP ${res.status}).`);
  }
}
