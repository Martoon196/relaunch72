import test from 'node:test';
import assert from 'node:assert/strict';
import {observeArticle,observeMembership,observeSitemap,mergeOwnedSitemap,readServedSitemap} from '../src/seo-blog/website-delivery.js';
import {FakeWeb} from './seo-blog-fixtures.js';
const url='https://bay.example/blog/article';const marker='r72-blog:article:version:1234';const at='2026-11-02T09:00:00Z';
const page=(canonical=url,version=marker)=>`<html><head><link rel="canonical" href="${canonical}"><meta name="r72-blog-version" content="${version}"></head><body><main>Reviewed article</main></body></html>`;
test('public proof requires exact head marker, actual canonical and final URL; comments and unrelated pages do not qualify',async()=>{
  const web=new FakeWeb();web.set(url,page());assert.equal((await observeArticle(web,url,marker,at)).state,'verified');
  for(const html of [page('https://bay.example/blog/other'),page(url,'old-version'),`<html><head><link rel="canonical" href="${url}"></head><body><!--${marker}--></body></html>`,`<html><head><!--<link rel="canonical" href="${url}"><meta name="r72-blog-version" content="${marker}">--></head><body>Unrelated</body></html>`,`<html><head><script>const data='<link rel="canonical" href="${url}"><meta name="r72-blog-version" content="${marker}">';</script></head><body>Unrelated</body></html>`]){web.set(url,html);assert.equal((await observeArticle(web,url,marker,at)).state,'different');}
  web.set(url,page());const redirected={fetch:async()=>({...await web.fetch(url),finalUrl:'https://bay.example/other'})};assert.equal((await observeArticle(redirected,url,marker,at)).state,'different');
  assert.equal((await observeArticle({fetch:async()=>{throw new Error('fetch failed');}},url,marker,at)).state,'unknown');
});
test('archive proof follows bounded rel=next pages instead of inferring absence on the first page',async()=>{
  const web=new FakeWeb();const index='https://bay.example/blog';web.set(index,'<html><head><link rel="next" href="?page=2"></head><body>No article here</body></html>');web.set(index+'?page=2',`<html><head></head><body><a href="${url}">Article</a></body></html>`);
  assert.equal((await observeMembership(web,index,url,at)).state,'verified');assert.equal((await observeMembership(web,index,url,at,1)).state,'incomplete');
  web.set(index+'?page=2','<html><head></head><body>Not present</body></html>');assert.equal((await observeMembership(web,index,url,at)).state,'pending');
  web.set(index,`<html><head></head><body>${'<a href="/unrelated">Other</a>'.repeat(450)}<a href="${url}">Actual article</a></body></html>`);assert.equal((await observeMembership(web,index,url,at)).state,'verified');
  web.set(index,`<html><head></head><body>${'<a href="/unrelated">Other</a>'.repeat(10001)}</body></html>`);assert.equal((await observeMembership(web,index,url,at)).state,'incomplete');
});
test('namespaced sitemap index traverses all children and preserves CDATA loc and lastmod evidence; bounds/read failures are incomplete or unknown',async()=>{
  const web=new FakeWeb();const sitemap='https://bay.example/sitemap.xml';web.set(sitemap,'<s:sitemapindex xmlns:s="http://www.sitemaps.org/schemas/sitemap/0.9"><s:sitemap><s:loc>https://bay.example/first.xml</s:loc></s:sitemap><s:sitemap><s:loc>https://bay.example/second.xml</s:loc></s:sitemap></s:sitemapindex>');
  web.set('https://bay.example/first.xml','<urlset><url><loc>https://bay.example/other</loc></url></urlset>');web.set('https://bay.example/second.xml',`<s:urlset xmlns:s="http://www.sitemaps.org/schemas/sitemap/0.9"><s:url><s:loc><![CDATA[${url}]]></s:loc><s:lastmod>2026-11-01</s:lastmod></s:url></s:urlset>`);
  const found=await observeSitemap(web,[sitemap],url,at);assert.equal(found.state,'verified');assert.equal(found.lastmod,'2026-11-01');assert.equal(found.complete,true);assert.equal(found.pagesRead,3);
  assert.equal((await observeSitemap(web,[sitemap],url,at,1)).state,'incomplete');web.set('https://bay.example/second.xml','<urlset><url><loc>unfinished</loc></urlset>');assert.equal((await observeSitemap(web,[sitemap],url,at)).state,'unknown');
});
test('owned XML repair updates and deduplicates only the chosen URL, retains unrelated bytes/lastmod, and is idempotent',()=>{
  const unrelated='<s:url><s:loc>https://bay.example/human</s:loc><s:lastmod>2000-01-01</s:lastmod><s:priority>0.7</s:priority></s:url>';
  const xml=`<?xml version="1.0"?><s:urlset xmlns:s="http://www.sitemaps.org/schemas/sitemap/0.9">${unrelated}<s:url><s:loc><![CDATA[${url}]]></s:loc><s:lastmod>old</s:lastmod></s:url><s:url><s:loc>${url}</s:loc></s:url></s:urlset>`;
  const repaired=mergeOwnedSitemap(xml,[{loc:url,lastmod:at}]);assert.ok(repaired.includes(unrelated));const rows=readServedSitemap(repaired).entries.filter((x)=>x.loc===url);assert.equal(rows.length,1);assert.equal(rows[0]!.lastmod,at);assert.equal(mergeOwnedSitemap(repaired,[{loc:url,lastmod:at}]),repaired);
  assert.throws(()=>mergeOwnedSitemap('<sitemapindex></sitemapindex>',[{loc:url,lastmod:at}]),/unsupported/);
});

test('structurally malformed sitemap and namespace-confused entries are never verified complete',async()=>{
  const prefix='<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>'+url+'</loc></url>';
  for(const xml of [prefix+'<broken></urlset>',prefix+'<broken/></urlset>',prefix+'<url><loc>other</urlset>',prefix+'<url bad=noquotes><loc>https://bay.example/other</loc></url></urlset>','<!DOCTYPE urlset [<!ENTITY target "'+url+'">]><urlset><url><loc>&target;</loc></url></urlset>','<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url xmlns="urn:evil"><loc>'+url+'</loc></url></urlset>']){
    assert.throws(()=>readServedSitemap(xml));const web=new FakeWeb();web.set('https://bay.example/sitemap.xml',xml);const observation=await observeSitemap(web,['https://bay.example/sitemap.xml'],url,at);assert.equal(observation.state,'unknown');assert.equal(observation.complete,false);
  }
  const comments='<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><!-- <url><loc>'+url+'</loc></url> --></urlset>';assert.equal(readServedSitemap(comments).entries.length,0);
});
test('mixed CDATA/entity locs and namespace aliases decode in order; owned repairs preserve unrelated bytes and prefixes',()=>{
  const mixed=url+'?a=1&b=2';const human='<b:url><b:loc>https://bay.example/human</b:loc><b:lastmod>2000-01-01</b:lastmod></b:url>';
  const xml='<?xml version="1.0" encoding="UTF-8"?><a:urlset xmlns:a="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:b="http://www.sitemaps.org/schemas/sitemap/0.9">'+human+'<b:url><b:loc>https://bay.example/<![CDATA[blog/art]]>icle?a=1&amp;b=2</b:loc><b:lastmod>2026-01-01</b:lastmod></b:url></a:urlset>';
  assert.equal(readServedSitemap(xml).entries[1]!.loc,mixed);const repaired=mergeOwnedSitemap(xml,[{loc:mixed,lastmod:at}]);assert.ok(repaired.includes(human));assert.ok(repaired.includes('<b:lastmod>'+at+'</b:lastmod>'));assert.equal(readServedSitemap(repaired).entries[1]!.loc,mixed);assert.equal(mergeOwnedSitemap(repaired,[{loc:mixed,lastmod:at}]),repaired);
  const empty='<a:urlset xmlns:a="http://www.sitemaps.org/schemas/sitemap/0.9"/>';assert.equal(readServedSitemap(mergeOwnedSitemap(empty,[{loc:url,lastmod:at}])).entries[0]!.loc,url);
});
