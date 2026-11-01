/**
 * Repository-backed static website publisher (GitHub Pages, or any static host
 * that deploys a GitHub branch).
 *
 * One publication = one atomic commit that writes only engine-owned paths:
 *   <blogPath>/<slug>/index.html   (the article)
 *   <blogPath>/index.html          (the blog index; carries its own manifest)
 *   <sitemapPath>                  (existing entries preserved; one <url> added)
 * The ref update is a non-forced fast-forward from the exact head that was
 * read, so a concurrent site edit is never overwritten: the publisher re-reads
 * and retries a bounded number of times instead.
 *
 * A page at the article path that the engine did not write is never replaced.
 */

import type { Destination } from '../types.js';
import { SeoBlogError } from '../types.js';
import { mergeSitemap, readIndexManifest, renderArticlePage, renderIndexPage, upsertIndexEntry, versionMarker } from '../render.js';
import {
  cleanPath, PublisherOutcomeUnknownError, PublisherRejectedError, requireHttpsBase,
  type ExistingState, type PublishInput, type PublishOutcome, type ValidatedDestination, type WebsitePublisher,
} from './types.js';

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const API = 'https://api.github.com';

class GithubHttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export class GithubStaticPublisher implements WebsitePublisher {
  readonly type = 'github_static' as const;
  readonly label = 'Static website in a GitHub repository';
  readonly description = 'For static sites deployed from a GitHub branch (for example GitHub Pages). Each article is committed as its own page with the blog index and sitemap updated in the same commit.';
  readonly credentialLabel = 'GitHub fine-grained token with Contents read/write on this repository only';
  readonly fields = [
    { key: 'repository', label: 'Repository', help: 'owner/name', required: true, placeholder: 'acme/website' },
    { key: 'branch', label: 'Branch', help: 'The branch your site deploys from.', required: true, placeholder: 'main' },
    { key: 'publicBaseUrl', label: 'Public website address', help: 'https://… — the domain the branch is served on.', required: true, placeholder: 'https://www.example.co.uk' },
    { key: 'blogPath', label: 'Blog folder', help: 'Folder the engine owns. Default: blog', required: false, placeholder: 'blog' },
    { key: 'sitemapPath', label: 'Sitemap file', help: 'Existing sitemap to add articles to. Default: sitemap.xml', required: false, placeholder: 'sitemap.xml' },
    { key: 'templatePath', label: 'Article template (optional)', help: 'An HTML file in the repo containing {{head}} and {{content}} — keeps your site branding.', required: false, placeholder: 'blog/_template.html' },
  ] as const;

  constructor(private readonly fetchImpl: FetchLike = fetch, private readonly timeoutMs = 20_000) {}

  validateConfig(raw: Readonly<Record<string, string>>): ValidatedDestination {
    const repository = String(raw.repository ?? '').trim();
    if (!/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/.test(repository)) throw new SeoBlogError(400, 'Repository must look like owner/name.');
    const branch = String(raw.branch ?? '').trim() || 'main';
    if (!/^[A-Za-z0-9._\/-]{1,200}$/.test(branch) || branch.includes('..')) throw new SeoBlogError(400, 'Branch name is not valid.');
    const publicBaseUrl = requireHttpsBase(raw.publicBaseUrl, 'Public website address');
    const blogPath = cleanPath(raw.blogPath, 'blog', 'Blog folder');
    const sitemapPath = cleanPath(raw.sitemapPath, 'sitemap.xml', 'Sitemap file');
    const templatePath = raw.templatePath?.trim() ? cleanPath(raw.templatePath, '', 'Article template') : '';
    if (sitemapPath.startsWith(`${blogPath}/`)) throw new SeoBlogError(400, 'The sitemap must be outside the blog folder.');
    return { config: { repository, branch, publicBaseUrl, blogPath, sitemapPath, templatePath }, publicBaseUrl };
  }

  publicUrlFor(destination: Destination, slug: string): string {
    return `${destination.publicBaseUrl}/${destination.config.blogPath}/${slug}/`;
  }

  indexUrlFor(destination: Destination): string {
    return `${destination.publicBaseUrl}/${destination.config.blogPath}/`;
  }

  private async api(credential: string, path: string, init: RequestInit = {}): Promise<unknown> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${API}${path}`, {
        ...init,
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${credential}`,
          'x-github-api-version': '2022-11-28',
          'user-agent': 'Relaunch72-SEO-Blog',
          ...(init.body ? { 'content-type': 'application/json' } : {}),
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new PublisherOutcomeUnknownError(`GitHub did not answer (${(error as Error).name}).`);
    }
    if (res.status >= 500) throw new PublisherOutcomeUnknownError(`GitHub answered HTTP ${res.status}.`);
    if (!res.ok) throw new GithubHttpError(res.status, `GitHub answered HTTP ${res.status}.`);
    return res.status === 204 ? null : res.json();
  }

  private async readFile(credential: string, d: Destination, path: string, ref: string): Promise<string | null> {
    try {
      const json = await this.api(credential, `/repos/${d.config.repository}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`) as { content?: string; encoding?: string; type?: string; size?: number; sha?: string };
      if (json.type !== 'file') return null;
      if (json.encoding === 'base64' && typeof json.content === 'string') return Buffer.from(json.content, 'base64').toString('utf8');
      // Files above 1 MB are returned without content; fetch the blob.
      if (json.sha) {
        const blob = await this.api(credential, `/repos/${d.config.repository}/git/blobs/${json.sha}`) as { content?: string };
        return Buffer.from(blob.content ?? '', 'base64').toString('utf8');
      }
      return null;
    } catch (error) {
      if (error instanceof GithubHttpError && error.status === 404) return null;
      throw error;
    }
  }

  async checkConnection(destination: Destination, credential: string): Promise<{ ok: boolean; detail: string }> {
    try {
      const repo = await this.api(credential, `/repos/${destination.config.repository}`) as { permissions?: { push?: boolean } };
      if (repo.permissions && repo.permissions.push === false) return { ok: false, detail: 'The token can read the repository but cannot write to it.' };
      await this.api(credential, `/repos/${destination.config.repository}/git/ref/heads/${encodePath(destination.config.branch!)}`);
      const sitemap = await this.readFile(credential, destination, destination.config.sitemapPath!, destination.config.branch!);
      if (sitemap === null) return { ok: false, detail: `No ${destination.config.sitemapPath} was found on ${destination.config.branch}.` };
      if (!/<urlset\b/i.test(sitemap)) return { ok: false, detail: `${destination.config.sitemapPath} is not a standard sitemap.` };
      if (destination.config.templatePath) {
        const template = await this.readFile(credential, destination, destination.config.templatePath, destination.config.branch!);
        if (!template || !template.includes('{{content}}') || !template.includes('{{head}}')) return { ok: false, detail: 'The article template must exist and contain {{head}} and {{content}}.' };
      }
      return { ok: true, detail: `Connected to ${destination.config.repository} (${destination.config.branch}).` };
    } catch (error) {
      if (error instanceof GithubHttpError) return { ok: false, detail: error.status === 401 || error.status === 403 ? 'GitHub refused the token.' : error.status === 404 ? 'The repository or branch was not found, or the token cannot see it.' : error.message };
      return { ok: false, detail: (error as Error).message };
    }
  }

  private articlePath(d: Destination, slug: string): string {
    return `${d.config.blogPath}/${slug}/index.html`;
  }

  async findExisting(input: PublishInput): Promise<{ state: ExistingState; providerRef: string | null }> {
    const d = input.destination;
    const head = await this.api(input.credential, `/repos/${d.config.repository}/git/ref/heads/${encodePath(d.config.branch!)}`) as { object: { sha: string } };
    const current = await this.readFile(input.credential, d, this.articlePath(d, input.body.slug), head.object.sha);
    if (current === null) return { state: 'absent', providerRef: head.object.sha };
    if (current.includes(versionMarker(input.articleId, input.versionId, input.contentSha))) return { state: 'present', providerRef: head.object.sha };
    return { state: 'other_version', providerRef: head.object.sha };
  }

  async publish(input: PublishInput): Promise<PublishOutcome> {
    const d = input.destination;
    const publicUrl = this.publicUrlFor(d, input.body.slug);
    const indexUrl = this.indexUrlFor(d);
    const marker = versionMarker(input.articleId, input.versionId, input.contentSha);
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const ref = await this.api(input.credential, `/repos/${d.config.repository}/git/ref/heads/${encodePath(d.config.branch!)}`) as { object: { sha: string } };
        const headSha = ref.object.sha;
        const commit = await this.api(input.credential, `/repos/${d.config.repository}/git/commits/${headSha}`) as { tree: { sha: string } };
        const existingArticle = await this.readFile(input.credential, d, this.articlePath(d, input.body.slug), headSha);
        if (existingArticle?.includes(marker)) return { status: 'already_present', providerRef: headSha, publicUrl };
        if (existingArticle !== null && !existingArticle.includes(`r72-blog:${input.articleId}:`)) {
          throw new PublisherRejectedError(`A page the engine does not own already exists at /${d.config.blogPath}/${input.body.slug}/. Choose another slug.`);
        }
        const onSite = Number(/<meta name="r72-blog-version-number" content="(\d{1,9})">/.exec(existingArticle ?? '')?.[1] ?? 0);
        if (onSite >= input.versionNumber) {
          throw new PublisherRejectedError('The website already has the same or a newer version of this article. Nothing was overwritten.');
        }
        const [indexHtml, sitemap, template] = await Promise.all([
          this.readFile(input.credential, d, `${d.config.blogPath}/index.html`, headSha),
          this.readFile(input.credential, d, d.config.sitemapPath!, headSha),
          d.config.templatePath ? this.readFile(input.credential, d, d.config.templatePath, headSha) : Promise.resolve(null),
        ]);
        if (indexHtml !== null && !indexHtml.includes('r72-blog-index:')) {
          throw new PublisherRejectedError(`/${d.config.blogPath}/index.html exists and was not created by the engine. Choose another blog folder.`);
        }
        if (sitemap === null) throw new PublisherRejectedError(`${d.config.sitemapPath} is missing from the repository.`);
        if (d.config.templatePath && !template) throw new PublisherRejectedError('The configured article template is missing.');
        const articleHtml = renderArticlePage(input.body, {
          siteName: input.brandName, canonicalUrl: publicUrl, blogIndexUrl: indexUrl, locale: input.locale,
          publishedAt: input.publishedAt, articleId: input.articleId, versionId: input.versionId, contentSha: input.contentSha, versionNumber: input.versionNumber, template,
        });
        const entries = upsertIndexEntry(readIndexManifest(indexHtml), {
          title: input.body.title, url: publicUrl, excerpt: input.body.excerpt, publishedAt: input.publishedAt, articleId: input.articleId,
        });
        const newIndex = renderIndexPage(entries, { siteName: input.brandName, indexUrl, locale: input.locale, template });
        const newSitemap = mergeSitemap(sitemap, [{ loc: indexUrl, lastmod: input.publishedAt }, { loc: publicUrl, lastmod: input.publishedAt }]);
        const tree = await this.api(input.credential, `/repos/${d.config.repository}/git/trees`, {
          method: 'POST',
          body: JSON.stringify({
            base_tree: commit.tree.sha,
            tree: [
              { path: this.articlePath(d, input.body.slug), mode: '100644', type: 'blob', content: articleHtml },
              { path: `${d.config.blogPath}/index.html`, mode: '100644', type: 'blob', content: newIndex },
              { path: d.config.sitemapPath, mode: '100644', type: 'blob', content: newSitemap },
            ],
          }),
        }) as { sha: string };
        const created = await this.api(input.credential, `/repos/${d.config.repository}/git/commits`, {
          method: 'POST',
          body: JSON.stringify({ message: `Publish blog article: ${input.body.title.slice(0, 80)}\n\nr72-operation: ${input.operationId}\n${marker}`, tree: tree.sha, parents: [headSha] }),
        }) as { sha: string };
        try {
          await this.api(input.credential, `/repos/${d.config.repository}/git/refs/heads/${encodePath(d.config.branch!)}`, {
            method: 'PATCH', body: JSON.stringify({ sha: created.sha, force: false }),
          });
        } catch (error) {
          // 422: the branch moved since it was read (a concurrent edit). Re-read and retry.
          if (error instanceof GithubHttpError && error.status === 422 && attempt < 3) continue;
          throw error;
        }
        return { status: 'accepted', providerRef: created.sha, publicUrl };
      } catch (error) {
        if (error instanceof PublisherOutcomeUnknownError || error instanceof PublisherRejectedError) throw error;
        if (error instanceof GithubHttpError) {
          if (error.status === 422 && attempt < 3) continue;
          throw new PublisherRejectedError(error.status === 401 || error.status === 403 ? 'GitHub refused the saved token. Reconnect the website.' : `GitHub refused the change (HTTP ${error.status}).`, error.status === 409 || error.status === 422);
        }
        throw new PublisherOutcomeUnknownError((error as Error).message);
      }
    }
    throw new PublisherRejectedError('The site kept changing while publishing. Try again shortly.', true);
  }
}

function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}
