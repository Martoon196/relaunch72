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
import { websiteIdentity, websiteSha, type WebsiteCapabilityReceipt, type WebsiteCapabilities } from '../website-target.js';
import { mergeOwnedSitemap, readServedSitemap } from '../website-delivery.js';
import {acceptStaticCatalogue,readStaticCatalogue,staticCataloguePath,STATIC_CATALOGUE_MAX_BYTES,type StaticCatalogue} from './static-catalogue.js';
import {createHash} from 'node:crypto';
import {
  assertPublishTarget,cleanPath, PublisherOutcomeUnknownError, PublisherRejectedError, requireHttpsBase,
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

  private async readFile(credential: string, d: Destination, path: string, ref: string,maxBytes?:number): Promise<string | null> {
    try {
      const json = await this.api(credential, `/repos/${d.config.repository}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`) as { content?: string; encoding?: string; type?: string; size?: number; sha?: string };
      if (json.type !== 'file') return null;
      if(maxBytes&&json.size&&json.size>maxBytes)throw new PublisherRejectedError('The website metadata exceeds its safe size limit; no history was discarded.');
      if (json.encoding === 'base64' && typeof json.content === 'string') {const bytes=Buffer.from(json.content,'base64');if(maxBytes&&bytes.length>maxBytes)throw new PublisherRejectedError('The website metadata exceeds its safe size limit.');return bytes.toString('utf8');}
      // Files above 1 MB are returned without content; fetch the blob.
      if (json.sha) {
        const blob = await this.api(credential, `/repos/${d.config.repository}/git/blobs/${json.sha}`) as { content?: string };
        const bytes=Buffer.from(blob.content??'','base64');if(maxBytes&&bytes.length>maxBytes)throw new PublisherRejectedError('The website metadata exceeds its safe size limit.');return bytes.toString('utf8');
      }
      return null;
    } catch (error) {
      if (error instanceof GithubHttpError && error.status === 404) return null;
      throw error;
    }
  }

  async checkConnection(destination: Destination, credential: string): Promise<{ ok: boolean; detail: string; websiteCapability?:WebsiteCapabilityReceipt }> {
    try {
      const repo = await this.api(credential, `/repos/${destination.config.repository}`) as { permissions?: { push?: boolean } };
      if (repo.permissions && repo.permissions.push === false) return { ok: false, detail: 'The token can read the repository but cannot write to it.' };
      await this.api(credential, `/repos/${destination.config.repository}/git/ref/heads/${encodePath(destination.config.branch!)}`);
      const sitemap = await this.readFile(credential, destination, destination.config.sitemapPath!, destination.config.branch!);
      if (sitemap === null) return { ok: false, detail: `No ${destination.config.sitemapPath} was found on ${destination.config.branch}.` };
      if(readServedSitemap(sitemap).index)return {ok:false,detail:'This adapter needs a writable urlset sitemap, rather than a sitemap index.'};
      if (destination.config.templatePath) {
        const template = await this.readFile(credential, destination, destination.config.templatePath, destination.config.branch!);
        if (!template || !template.includes('{{content}}') || !template.includes('{{head}}')) return { ok: false, detail: 'The article template must exist and contain {{head}} and {{content}}.' };
      }
      const root=destination.config.blogPath!;let websiteCapability:WebsiteCapabilityReceipt|undefined;
      if(destination.publicBaseUrl===new URL(destination.publicBaseUrl).origin&&/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(root)){
        const index=await this.readFile(credential,destination,`${root}/index.html`,destination.config.branch!);
        if(index!==null&&!index.includes('r72-blog-index:'))return {ok:false,detail:'The configured root already has an index the engine does not own.'};
        const capability={contractVersion:2 as const,siteId:websiteIdentity('static-site',destination.publicBaseUrl,destination.config.repository!),publicOrigin:destination.publicBaseUrl,roots:[{id:root,path:root,indexUrl:this.indexUrlFor(destination),articleUrlPattern:`${this.indexUrlFor(destination)}{slug}/`,categoryUrlPattern:`${this.indexUrlFor(destination)}category/{slug}/`}],taxonomy:{mode:'categories' as const,maxCategoriesPerArticle:5},sitemaps:[`${destination.publicBaseUrl}/${destination.config.sitemapPath}`],updates:{preservePublishedUrl:true as const},repair:{sitemap:true}};
        const capabilities:WebsiteCapabilities={...capability,capabilitiesSha:websiteSha({...capability,repository:destination.config.repository,branch:destination.config.branch,template:destination.config.templatePath??null})};
        websiteCapability={protocol:'v2',checkedAt:new Date().toISOString(),capabilities};
      }
      return { ok: true, detail: `Connected to ${destination.config.repository} (${destination.config.branch}).`,...(websiteCapability?{websiteCapability}:{}) };
    } catch (error) {
      if (error instanceof GithubHttpError) return { ok: false, detail: error.status === 401 || error.status === 403 ? 'GitHub refused the token.' : error.status === 404 ? 'The repository or branch was not found, or the token cannot see it.' : error.message };
      return { ok: false, detail: (error as Error).message };
    }
  }

  private articlePath(d: Destination, slug: string): string {
    return `${d.config.blogPath}/${slug}/index.html`;
  }

  private async prepareCatalogue(input:PublishInput,head:string,treeSha:string,indexHtml:string|null):Promise<{path:string;content:string;previousFileSha:string;catalogue:StaticCatalogue}> {
    const target=input.websiteTarget!.target;const d=input.destination;
    if(d.websiteCapability?.protocol!=='v2'||d.websiteCapability.capabilities.siteId!==target.siteId)throw new PublisherRejectedError('The reviewed static target belongs to another website.');
    const path=staticCataloguePath(target.siteId);const raw=await this.readFile(input.credential,d,path,head,STATIC_CATALOGUE_MAX_BYTES);
    if(raw===null){
      if(readIndexManifest(indexHtml).some((entry)=>entry.categories!==undefined))throw new PublisherRejectedError('This v2 website lost its public catalogue. Restore the metadata history before publishing.');
      const tree=await this.api(input.credential,`/repos/${d.config.repository}/git/trees/${treeSha}?recursive=1`) as {truncated?:boolean;tree?:{path:string;type:string}[]};
      if(tree.truncated||!Array.isArray(tree.tree)||tree.tree.length>100000)throw new PublisherRejectedError('The repository namespace could not be completely checked before catalogue initialisation.');
      const paths=tree.tree.filter((e)=>e.type==='blob').map((e)=>e.path);
      const archives=paths.filter((p)=>/^[^/]+\/category\/[^/]+\/index\.html$/.test(p));
      if(archives.length>64)throw new PublisherRejectedError('Too many category paths to prove a new catalogue namespace safely. Review the website integration.');
      for(const archive of archives){const html=await this.readFile(input.credential,d,archive,head,3*1024*1024);if(html?.includes('<!-- r72-blog-category:'))throw new PublisherRejectedError('Existing managed category archives lost their public catalogue. Restore the original metadata; it was not recreated.');}
      const indexes=paths.filter((p)=>/^[^/]+\/index\.html$/.test(p)&&p!==`${d.config.blogPath}/index.html`);
      if(indexes.length>64)throw new PublisherRejectedError('Too many root indexes to prove a new catalogue namespace safely. Review the website integration.');
      for(const other of indexes){const html=await this.readFile(input.credential,d,other,head,3*1024*1024);if(readIndexManifest(html).some((entry)=>entry.categories!==undefined))throw new PublisherRejectedError('An existing v2 root has lost its public catalogue. Restore it before publishing.');}
    }
    const catalogue=acceptStaticCatalogue(readStaticCatalogue(raw,target.siteId),target);
    const previousFileSha=raw===null?'absent':createHash('sha1').update(`blob ${Buffer.byteLength(raw)}\0`).update(raw).digest('hex');
    const content=JSON.stringify(catalogue,null,2)+'\n';if(Buffer.byteLength(content)>STATIC_CATALOGUE_MAX_BYTES)throw new PublisherRejectedError('The public catalogue reached its metadata limit. Publication is held without forgetting history.');
    return {path,catalogue,previousFileSha,content};
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
    assertPublishTarget(input);
    const d = input.destination;
    const publicUrl = input.websiteTarget?.target.canonicalUrl??this.publicUrlFor(d, input.body.slug);
    const indexUrl = input.websiteTarget?.target.indexUrl??this.indexUrlFor(d);
    const marker = versionMarker(input.articleId, input.versionId, input.contentSha);
    const deliverySha=websiteSha({body:input.body,brandName:input.brandName,locale:input.locale,publishedAt:input.publishedAt,target:input.websiteTarget??null});
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const ref = await this.api(input.credential, `/repos/${d.config.repository}/git/ref/heads/${encodePath(d.config.branch!)}`) as { object: { sha: string } };
        const headSha = ref.object.sha;
        const commit = await this.api(input.credential, `/repos/${d.config.repository}/git/commits/${headSha}`) as { tree: { sha: string } };
        const existingArticle = await this.readFile(input.credential, d, this.articlePath(d, input.body.slug), headSha);
        if (existingArticle?.includes(marker)) {
          const prior=/<meta name="r72-blog-delivery-sha" content="([a-f0-9]{64})">/.exec(existingArticle)?.[1];
          if(prior&&prior!==deliverySha)throw new PublisherRejectedError('This exact article version already has different immutable publication metadata.');
          return { status: 'already_present', providerRef: headSha, publicUrl };
        }
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
        const metadata=input.websiteTarget?await this.prepareCatalogue(input,headSha,commit.tree.sha,indexHtml):null;
        const articleHtml = renderArticlePage(input.body, {
          siteName: input.brandName, canonicalUrl: publicUrl, blogIndexUrl: indexUrl, locale: input.locale,
          publishedAt: input.publishedAt, articleId: input.articleId, versionId: input.versionId, contentSha: input.contentSha, versionNumber: input.versionNumber, template,deliverySha,
          ...(input.websiteTarget?{websiteTargetSha:input.websiteTarget.deliverySha,categoryLinks:input.websiteTarget.target.categoryIds.map((id)=>{const c=input.websiteTarget!.target.categories.find((c)=>c.id===id)!;return {label:c.label,url:`${indexUrl}category/${c.slug}/`};})}:{}),
        });
        const entries = upsertIndexEntry(readIndexManifest(indexHtml), {
          title: input.body.title, url: publicUrl, excerpt: input.body.excerpt, publishedAt: input.publishedAt, articleId: input.articleId,
          ...(input.websiteTarget?{categories:input.websiteTarget.target.categories.filter((c)=>input.websiteTarget!.target.categoryIds.includes(c.id))}:{}),
        });
        const newIndex = renderIndexPage(entries, { siteName: input.brandName, indexUrl, locale: input.locale, template });
        const categoryFiles:{path:string;mode:string;type:string;content:string}[]=[];const categoryUrls:{loc:string;lastmod:string}[]=[];const emptyCategoryUrls:string[]=[];
        if(input.websiteTarget){
          const catalogue=new Map(Object.values(metadata!.catalogue.categories).filter((c)=>c.rootPath===input.websiteTarget!.target.rootPath&&c.structureId===input.websiteTarget!.target.structureId).map((c)=>[c.id,c]));
          for(const category of catalogue.values()){
            const path=`${d.config.blogPath}/category/${category.slug}/index.html`;const existing=await this.readFile(input.credential,d,path,headSha);const owned=`<!-- r72-blog-category:${category.id}:${category.structureId} -->`;
            if(existing!==null&&!existing.includes(owned))throw new PublisherRejectedError(`The category archive /${d.config.blogPath}/category/${category.slug}/ is owned by another page or category.`);
            const members=entries.filter((entry)=>entry.categories?.some((c)=>c.id===category.id));const archiveUrl=`${indexUrl}category/${category.slug}/`;
            const html=owned+renderIndexPage(members,{siteName:input.brandName,indexUrl:archiveUrl,locale:input.locale,template,heading:category.label,noindex:members.length===0});
            if(html!==existing)categoryFiles.push({path,mode:'100644',type:'blob',content:html});
            if(members.length){if(html!==existing||!readServedSitemap(sitemap).entries.some((e)=>e.loc===archiveUrl))categoryUrls.push({loc:archiveUrl,lastmod:input.publishedAt});}else emptyCategoryUrls.push(archiveUrl);
          }
        }
        const newSitemap = input.websiteTarget?mergeOwnedSitemap(sitemap,[{loc:indexUrl,lastmod:input.publishedAt},{loc:publicUrl,lastmod:input.publishedAt},...categoryUrls],emptyCategoryUrls):mergeSitemap(sitemap, [{ loc: indexUrl, lastmod: input.publishedAt }, { loc: publicUrl, lastmod: input.publishedAt }]);
        const tree = await this.api(input.credential, `/repos/${d.config.repository}/git/trees`, {
          method: 'POST',
          body: JSON.stringify({
            base_tree: commit.tree.sha,
            tree: [
              { path: this.articlePath(d, input.body.slug), mode: '100644', type: 'blob', content: articleHtml },
              { path: `${d.config.blogPath}/index.html`, mode: '100644', type: 'blob', content: newIndex },
              { path: d.config.sitemapPath, mode: '100644', type: 'blob', content: newSitemap },
              ...categoryFiles,
              ...(metadata?[{path:metadata.path,mode:'100644',type:'blob',content:metadata.content}]:[]),
            ],
          }),
        }) as { sha: string };
        const created = await this.api(input.credential, `/repos/${d.config.repository}/git/commits`, {
          method: 'POST',
          body: JSON.stringify({ message: `Publish blog article: ${input.body.title.slice(0, 80)}\n\nr72-operation: ${input.operationId}\n${marker}${metadata?`\ncatalogue-base:${metadata.previousFileSha}`:''}`, tree: tree.sha, parents: [headSha] }),
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

  async inspectSitemapRepair(input:PublishInput):Promise<{complete:boolean;providerRef:string;sourceSha:string}> {
    const d=input.destination;const head=await this.api(input.credential,`/repos/${d.config.repository}/git/ref/heads/${encodePath(d.config.branch!)}`) as {object:{sha:string}};
    const article=await this.readFile(input.credential,d,this.articlePath(d,input.body.slug),head.object.sha);
    if(!article?.includes(versionMarker(input.articleId,input.versionId,input.contentSha)))throw new PublisherRejectedError('The repository article no longer matches this exact version. No sitemap repair was written.');
    const xml=await this.readFile(input.credential,d,d.config.sitemapPath!,head.object.sha);if(xml===null)throw new PublisherRejectedError('The existing sitemap is missing.');
    const loc=input.websiteTarget?.target.canonicalUrl??this.publicUrlFor(d,input.body.slug);const entries=readServedSitemap(xml).entries.filter((e)=>e.loc===loc);
    return {complete:entries.length===1&&entries[0]!.lastmod===input.publishedAt,providerRef:head.object.sha,sourceSha:websiteSha(xml)};
  }

  async repairSitemap(input:PublishInput):Promise<{providerRef:string}> {
    const d=input.destination;
    const head=await this.api(input.credential,`/repos/${d.config.repository}/git/ref/heads/${encodePath(d.config.branch!)}`) as {object:{sha:string}};
    const commit=await this.api(input.credential,`/repos/${d.config.repository}/git/commits/${head.object.sha}`) as {tree:{sha:string}};
    const article=await this.readFile(input.credential,d,this.articlePath(d,input.body.slug),head.object.sha);
    if(!article?.includes(versionMarker(input.articleId,input.versionId,input.contentSha)))throw new PublisherRejectedError('A newer or different article is in the repository. No sitemap repair was written.');
    const xml=await this.readFile(input.credential,d,d.config.sitemapPath!,head.object.sha);if(xml===null)throw new PublisherRejectedError('The existing sitemap is missing.');
    if(!input.sitemapSourceSha||websiteSha(xml)!==input.sitemapSourceSha)throw new PublisherRejectedError('The sitemap changed after this owner repair intent. Re-observe and request a new repair; no newer XML was overwritten.');
    const updated=mergeOwnedSitemap(xml,[{loc:input.websiteTarget?.target.canonicalUrl??this.publicUrlFor(d,input.body.slug),lastmod:input.publishedAt}]);
    if(updated===xml)return {providerRef:head.object.sha};
    const tree=await this.api(input.credential,`/repos/${d.config.repository}/git/trees`,{method:'POST',body:JSON.stringify({base_tree:commit.tree.sha,tree:[{path:d.config.sitemapPath,mode:'100644',type:'blob',content:updated}]})}) as {sha:string};
    const created=await this.api(input.credential,`/repos/${d.config.repository}/git/commits`,{method:'POST',body:JSON.stringify({message:`Repair owned article sitemap entry\n\nr72-sitemap-repair:${input.operationId}`,tree:tree.sha,parents:[head.object.sha]})}) as {sha:string};
    try{await this.api(input.credential,`/repos/${d.config.repository}/git/refs/heads/${encodePath(d.config.branch!)}`,{method:'PATCH',body:JSON.stringify({sha:created.sha,force:false})});}
    catch{throw new PublisherOutcomeUnknownError('The sitemap-only commit was not acknowledged or the branch moved. Re-observe before another owner intent.');}
    return {providerRef:created.sha};
  }
}

function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}
