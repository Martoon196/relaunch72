/**
 * WordPress publisher: the signed content-API v2 model delivered to the
 * "Relaunch72 Publisher & SEO" WordPress plugin (wordpress-plugin/relaunch72-publisher).
 *
 * Differences from ContentApiPublisher, all explicit and versioned:
 * - Capabilities must carry `urlContract: "wordpress-permalinks-1"` (declared same-origin
 *   permalink patterns: trailing slashes, posts page index, category base). Other
 *   destination types keep the strict v2 URL rules.
 * - Signing scheme `path-query-1` (header X-R72-Signing): the HMAC covers path AND query,
 *   so check/status parameters cannot be altered in transit.
 * - The connection check names the RL72 brand + destination; the plugin binds itself to
 *   that pair on first success and refuses any other brand afterwards.
 * - Publish payload = content-API v2 payload + a `wordpress` block (protocol
 *   "r72-wordpress-1", brand/destination binding, robots, social preview, citations).
 * - A v2 reviewed target is mandatory: no legacy /blog fallback.
 * - The check never publishes; a plugin-side hold (unsupported permalinks, conflicting SEO
 *   plugins, no sitemap, no author) is reported as a failed check with its reason, never as
 *   fabricated capabilities.
 */

import { createHash, createHmac } from 'node:crypto';
import type { Destination } from '../types.js';
import { SeoBlogError } from '../types.js';
import { citationNumbers, versionMarker } from '../render.js';
import { parseWebsiteCapabilities, websiteOrigin, websiteSha, WORDPRESS_URL_CONTRACT, type WebsiteCapabilityReceipt } from '../website-target.js';
import { renderArticleFragment } from './content-api.js';
import {
  assertPublishTarget, PublisherOutcomeUnknownError, PublisherRejectedError, requireHttpsBase,
  type ExistingState, type PublishInput, type PublishOutcome, type ValidatedDestination, type WebsitePublisher,
} from './types.js';

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
export const WORDPRESS_PROTOCOL = 'r72-wordpress-1';
export const WORDPRESS_SIGNING = 'path-query-1';

export function wordpressSignature(secret: string, timestamp: string, method: string, target: string, body: string): string {
  const bodySha = createHash('sha256').update(body).digest('hex');
  return createHmac('sha256', secret).update(`${timestamp}.${method}.${target}.${bodySha}`).digest('hex');
}

const text = (value: unknown, max = 240): string => (typeof value === 'string' ? value.replace(/[\u0000-\u001f]+/g, ' ').slice(0, max) : '');

export class WordPressPublisher implements WebsitePublisher {
  readonly type = 'wordpress' as const;
  readonly label = 'WordPress (Relaunch72 Publisher & SEO plugin)';
  readonly description = 'For WordPress sites with the Relaunch72 Publisher & SEO plugin installed. Articles become normal WordPress posts; SEO values go to Yoast SEO, Rank Math or the plugin’s standalone mode. Checking the connection publishes nothing.';
  readonly credentialLabel = 'Connection key from WordPress → Relaunch72 → Connection (starts r72wp_)';
  readonly fields = [
    { key: 'siteUrl', label: 'WordPress site address', help: 'Exactly as shown on the plugin’s Connection tab, e.g. https://www.example.com', required: true, placeholder: 'https://www.example.com' },
    { key: 'endpoint', label: 'Publishing endpoint', help: 'Shown on the plugin’s Connection tab. Leave blank for {site}/wp-json/relaunch72/v1/publish.', required: false, placeholder: 'https://www.example.com/wp-json/relaunch72/v1/publish' },
  ] as const;

  constructor(private readonly fetchImpl: FetchLike = fetch, private readonly timeoutMs = 25_000, private readonly clock: () => number = Date.now) {}

  validateConfig(raw: Readonly<Record<string, string>>): ValidatedDestination {
    const publicBaseUrl = websiteOrigin(requireHttpsBase(raw.siteUrl, 'WordPress site address'));
    const endpoint = requireHttpsBase(String(raw.endpoint ?? '').trim() || `${publicBaseUrl}/wp-json/relaunch72/v1/publish`, 'Publishing endpoint');
    const url = new URL(endpoint);
    if (url.host !== new URL(publicBaseUrl).host) throw new SeoBlogError(400, 'The publishing endpoint must be on the same WordPress site.');
    if (!/\/relaunch72\/v1\/publish$/.test(url.pathname)) throw new SeoBlogError(400, 'Use the publishing endpoint shown by the Relaunch72 Publisher plugin (it ends in /relaunch72/v1/publish). Plain ?rest_route= addresses are not supported.');
    return { config: { siteUrl: publicBaseUrl, endpoint, publicBaseUrl }, publicBaseUrl };
  }

  private root(destination: Destination) {
    const receipt = destination.websiteCapability;
    return receipt?.protocol === 'v2' ? receipt.capabilities.roots[0] ?? null : null;
  }

  publicUrlFor(destination: Destination, slug: string): string {
    const root = this.root(destination);
    return root ? root.articleUrlPattern.replace('{slug}', slug) : `${destination.publicBaseUrl}/${slug}/`;
  }

  indexUrlFor(destination: Destination): string {
    return this.root(destination)?.indexUrl ?? `${destination.publicBaseUrl}/`;
  }

  private statusEndpoint(destination: Destination): string {
    return String(destination.config.endpoint).replace(/\/publish$/, '/status');
  }

  private async signed(url: URL, credential: string, method: 'GET' | 'POST', body = ''): Promise<{ status: number; json: Record<string, unknown> }> {
    const timestamp = String(Math.floor(this.clock() / 1000));
    const signature = wordpressSignature(credential, timestamp, method, `${url.pathname}${url.search}`, body);
    let res: Response;
    try {
      res = await this.fetchImpl(url.toString(), {
        method,
        headers: { 'content-type': 'application/json', 'x-r72-timestamp': timestamp, 'x-r72-signature': signature, 'x-r72-signing': WORDPRESS_SIGNING, 'user-agent': 'Relaunch72-SEO-Blog' },
        ...(method === 'POST' ? { body } : {}),
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new PublisherOutcomeUnknownError(`WordPress did not answer (${(error as Error).name}).`);
    }
    if (res.status >= 500 || res.status === 408 || res.status === 429) throw new PublisherOutcomeUnknownError(`WordPress answered HTTP ${res.status}.`);
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: res.status, json: json && typeof json === 'object' && !Array.isArray(json) ? json : {} };
  }

  async checkConnection(destination: Destination, credential: string): Promise<{ ok: boolean; detail: string; websiteCapability?: WebsiteCapabilityReceipt }> {
    if (!/^r72wp_[a-f0-9]{64}$/.test(credential)) return { ok: false, detail: 'Paste the connection key created in WordPress → Relaunch72 → Connection (it starts with r72wp_).' };
    const url = new URL(this.statusEndpoint(destination));
    url.searchParams.set('check', '1');
    url.searchParams.set('brand', destination.brandId);
    url.searchParams.set('destination', destination.id);
    try {
      const res = await this.signed(url, credential, 'GET');
      if (res.status === 403 && res.json.code === 'r72_other_brand') return { ok: false, detail: 'This WordPress site is already paired with a different Relaunch72 brand or connection. Nothing was changed. Rotate the key in WordPress only if this brand should own the site.' };
      if (res.status === 401 || res.status === 403) return { ok: false, detail: 'WordPress rejected the connection key (or the server clocks differ by more than five minutes).' };
      if (res.status === 404 || (res.status === 200 && res.json.ok !== true && res.json.protocol === undefined)) return { ok: false, detail: 'The Relaunch72 Publisher plugin endpoint was not found. Check the plugin is installed and active and the endpoint address. If WordPress uses Plain permalinks (?p=123), its REST address is not available here and Plain permalinks are not supported; Relaunch72 will not change permalink settings.' };
      if (res.status !== 200 || res.json.ok !== true) return { ok: false, detail: `WordPress answered HTTP ${res.status}.` };
      if (res.json.protocol !== WORDPRESS_PROTOCOL) return { ok: false, detail: 'The installed plugin speaks a different protocol version. Update the Relaunch72 Publisher plugin.' };
      const wp = (res.json.wordpress ?? {}) as Record<string, unknown>;
      const holds = Array.isArray(res.json.holds) ? res.json.holds : [];
      if (holds.length || res.json.capabilities === undefined) {
        const reasons = holds.map((h) => text((h as Record<string, unknown>)?.message, 400)).filter(Boolean).join(' ');
        return { ok: false, detail: `Key verified, but WordPress publishing is on hold: ${reasons || 'the plugin advertised no publishing capability.'}`.slice(0, 600) };
      }
      const websiteCapability = parseWebsiteCapabilities(res.json.capabilities, destination.publicBaseUrl, new Date(this.clock()).toISOString(), { urlContract: WORDPRESS_URL_CONTRACT });
      if (websiteCapability.protocol !== 'v2' || websiteCapability.capabilities.urlContract !== WORDPRESS_URL_CONTRACT || websiteCapability.capabilities.roots.length !== 1) return { ok: false, detail: 'The plugin did not advertise a WordPress v2 publishing root.' };
      const seo = (wp.seo ?? {}) as Record<string, unknown>; const sitemap = (wp.sitemap ?? {}) as Record<string, unknown>;
      const root = websiteCapability.capabilities.roots[0]!;
      const parts = [
        `WordPress ${text(wp.version, 20)} verified (plugin ${text((res.json.plugin as Record<string, unknown> | undefined)?.version, 20)}).`,
        `Posts: ${root.articleUrlPattern}; index ${root.indexUrl}.`,
        `SEO owner: ${text(seo.provider, 80)} (${text(seo.mode, 20)}); sitemap: ${text(sitemap.owner, 20)}.`,
        wp.writesPaused === true ? 'Incoming writes are PAUSED in WordPress; publishing will be refused until resumed.' : '',
        wp.supported === false ? 'WordPress/PHP version is below the supported minimum.' : '',
        ...(Array.isArray(res.json.warnings) ? res.json.warnings.slice(0, 3).map((w) => `Warning: ${text((w as Record<string, unknown>)?.message, 300)}`) : []),
      ];
      return { ok: true, detail: parts.filter(Boolean).join(' ').slice(0, 600), websiteCapability };
    } catch (error) {
      return { ok: false, detail: (error as Error).message };
    }
  }

  async findExisting(input: PublishInput): Promise<{ state: ExistingState; providerRef: string | null }> {
    const url = new URL(this.statusEndpoint(input.destination));
    url.searchParams.set('article', input.articleId);
    url.searchParams.set('version', input.versionId);
    const res = await this.signed(url, input.credential, 'GET');
    if (res.status !== 200) throw new PublisherOutcomeUnknownError(`The WordPress status check answered HTTP ${res.status}.`);
    const state = res.json.state; const ref = typeof res.json.ref === 'string' ? res.json.ref : null;
    if (state === 'absent') return { state, providerRef: null };
    if (state === 'present') {
      if (!input.websiteTarget || res.json.canonicalUrl !== input.websiteTarget.target.canonicalUrl || res.json.contractVersion !== 2 || typeof res.json.payloadSha !== 'string' || !/^[a-f0-9]{64}$/.test(res.json.payloadSha) || websiteSha(res.json.target) !== websiteSha(input.websiteTarget.target)) return { state: 'other_version', providerRef: ref };
      return { state, providerRef: ref };
    }
    if (state === 'other_version') return { state, providerRef: ref };
    throw new PublisherOutcomeUnknownError('The WordPress status check returned an unexpected answer.');
  }

  payload(input: PublishInput): string {
    if (!input.websiteTarget) throw new PublisherRejectedError('Review and save this article’s WordPress target (root and categories) before publishing.');
    assertPublishTarget(input);
    const publicUrl = input.websiteTarget.target.canonicalUrl;
    const body = input.body;
    return JSON.stringify({
      contractVersion: 2,
      target: input.websiteTarget.target,
      operationId: input.operationId,
      articleId: input.articleId,
      versionId: input.versionId,
      contentSha: input.contentSha,
      versionNumber: input.versionNumber,
      marker: versionMarker(input.articleId, input.versionId, input.contentSha),
      slug: body.slug,
      title: body.title,
      seoTitle: body.seoTitle,
      metaDescription: body.metaDescription,
      excerpt: body.excerpt,
      canonicalUrl: publicUrl,
      publishedAt: input.publishedAt,
      author: body.author,
      image: body.image.url ? { url: body.image.url, alt: body.image.alt, width: body.image.width, height: body.image.height } : null,
      locale: input.locale,
      articleHtml: renderArticleFragment(input, publicUrl),
      wordpress: {
        protocol: WORDPRESS_PROTOCOL,
        brandId: input.destination.brandId,
        destinationId: input.destination.id,
        robots: { index: true, follow: true },
        social: { title: body.seoTitle || body.title, description: body.metaDescription || body.excerpt },
        // Same public-only set the rendered Sources list uses; private research never leaves RL72.
        citations: citationNumbers(body).list.map((c) => ({ url: c.url, title: c.title })),
      },
    });
  }

  async publish(input: PublishInput): Promise<PublishOutcome> {
    const payload = this.payload(input);
    const publicUrl = input.websiteTarget!.target.canonicalUrl;
    if (payload.length > 1_500_000) throw new PublisherRejectedError('The article is too large for the WordPress endpoint.');
    const res = await this.signed(new URL(String(input.destination.config.endpoint)), input.credential, 'POST', payload);
    if (res.status === 200 || res.status === 201) {
      return { status: res.json.status === 'already_present' ? 'already_present' : 'accepted', providerRef: typeof res.json.ref === 'string' ? res.json.ref : input.operationId, publicUrl };
    }
    if (res.status === 409 && res.json.status === 'superseded') throw new PublisherRejectedError('WordPress already has a newer version of this article. Nothing was overwritten.');
    if (res.status === 409 && res.json.status === 'paused') throw new PublisherRejectedError('Incoming writes are paused in WordPress. Nothing was changed; resume writes in Relaunch72 → Connection, then publish again.');
    if (res.status === 403 && res.json.code === 'r72_other_brand') throw new PublisherRejectedError('This WordPress site is paired with a different Relaunch72 brand. Nothing was changed.');
    if (res.status === 401 || res.status === 403) throw new PublisherRejectedError('WordPress rejected the connection key. Reconnect the website.');
    if (res.status === 409 || res.status === 400 || res.status === 413) throw new PublisherRejectedError(text(res.json.error, 300) || `WordPress refused the article (HTTP ${res.status}).`);
    throw new PublisherRejectedError(`WordPress refused the article (HTTP ${res.status}).`);
  }
}
