import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { campaignPage } from '../src/portal/seo-blog-campaign-view.js';
import { campaignFixture } from './seo-blog-campaign-fixtures.js';
import type { SeoMediaCanonicalManifest } from '../src/seo-blog/media-types.js';
import type { Job } from '../src/seo-blog/types.js';
import { friendlyDeliveryState, friendlyTaskState } from '../src/portal/seo-blog-view.js';
function primaryText(html:string):string {
  let depth=0,out='';
  for(const part of html.replace(/<style\b[^>]*>[\s\S]*?<\/style>|<script\b[^>]*>[\s\S]*?<\/script>/giu,'').split(/(<\/?details\b[^>]*>)/giu)){
    if(/^<details\b/iu.test(part))depth++;else if(/^<\/details/iu.test(part))depth--;else if(depth===0)out+=part;
  }
  return out.replace(/<[^>]*>/gu,' ').replace(/\s+/gu,' ');
}

test('native campaign renders real crop paths and usable exact text inputs, with scoped responsive cards and textual review states', async () => {
  const f = await campaignFixture(), assetId = randomUUID(), sha = 'd'.repeat(64), commandId = randomUUID();
  const manifest: SeoMediaCanonicalManifest = { schema: 'relaunch72.seo-media/v1', assetId, byteSha256: sha, byteLength: 1000, mimeType: 'image/jpeg', width: 1600, height: 900,
    recipe: { version: 'r72-jpeg-focal-v1', sourceSha256: 'e'.repeat(64), profile: 'blog', focal: { x: .5, y: .5 }, crop: { x: 0, y: 0, width: 1600, height: 900 }, width: 1600, height: 900, quality: 85, metadataStripped: true },
    presentation: { profile: 'blog', alt: 'An illustrative considered decision' }, provenance: { kind: 'uploaded', brandSha256: 'f'.repeat(64), sourceName: 'Synthetic owner JPEG' } };
  const article = { ...f.article, localImageProposals: [{ commandId: randomUUID(), articleVersionId: f.version.id, candidateAssetId: randomUUID(), candidateSha256: 'e'.repeat(64),
    focal: { x: .5, y: .5 }, variants: [{ assetId, sha256: sha, profile: 'blog' as const, width: 1600, height: 900 }], preparedAt: f.h.clock.now() }],
    mediaQualityReviews: [{ commandId, requestedBy: randomUUID(), observedAt: f.h.clock.now(), expiresAt: '2026-11-02T10:15:00.000Z', manifest,
      contentItemId: randomUUID(), contentVersionId: randomUUID(), canonical: { contentItemId: randomUUID(), contentVersionId: randomUUID(), contentSha256: 'c'.repeat(64), approvalRequestId: randomUUID(), approvalDecisionId: randomUUID() } }] };
  const html = campaignPage({ brands: [f.brand], brand: f.brand, tab: 'articles', csrf: 'exact-csrf', applicationName: 'Relaunch72 Content' }, { article, version: f.version, jobs: [], now: f.h.clock.now() });
  assert.match(html, /type="text" name="alt"/); assert.match(html, /type="text" name="title"/);
  assert.match(html, new RegExp(`/media/${assetId}/${sha}\\.jpg`)); assert.match(html, /name="_csrf" value="exact-csrf"/);
  assert.match(html, /class="pill ok">Image approved/); assert.doesNotMatch(html, /pill good|and60minutes|\+60minutes/);
  assert.match(html, /campaign-crops\{display:grid;grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/);
  assert.match(html, /@media\(max-width:1100px\)\{\.campaign-crops\{grid-template-columns:1fr\}/);
  assert.match(html, /object-fit:contain/); assert.match(html, /min-width:0/);
  assert.match(html, /No social post is scheduled while the blog is a draft/); assert.match(html, /Instagram needs an approved image/);
  const plain=primaryText(html);assert.match(plain,/Main blog image/);assert.match(plain,/Approve image and description/);assert.match(plain,/Use as main blog image/);assert.match(plain,/Save changes before approving this post/);
  assert.doesNotMatch(plain,/\bhero\b|\bcanonical\b|\brevision\b|\bnonce\b|\breceipt\b/iu);
  for(const field of ['_csrf','versionId','variantId','revisionId','qualityCommandId','dateRule'])assert.ok(html.includes(`name="${field}"`),field);
  assert.doesNotMatch(html,/This brand’s programme is paused/);
  const pausedBrand={...f.brand,settings:{...f.brand.settings,pauseAll:true}};
  const paused=campaignPage({brands:[pausedBrand],brand:pausedBrand,tab:'articles',csrf:'exact-csrf'},{article,version:f.version,jobs:[],now:f.h.clock.now()});
  assert.match(primaryText(paused),/This brand’s programme is paused\. Posting plans will wait\./);
  assert.ok(paused.includes(`/b/${f.brand.id}/publishing">Review pause setting</a>`));
  assert.equal(f.h.llm.calls.length, 0); assert.equal(f.h.site.posts, 0);
});

test('uncertain image work has plain status and cost warning while raw support details stay in Advanced',async()=>{
  const f=await campaignFixture();const job:Job={id:randomUUID(),brandId:f.brand.id,kind:'write',idempotencyKey:'synthetic-image',payload:{stage:'image',image:{articleId:f.article.id,intentId:randomUUID(),paidAttemptStarted:true}},state:'blocked',attempts:1,maxAttempts:3,leaseOwner:null,leaseExpiresAt:null,createdAt:f.h.clock.now(),updatedAt:f.h.clock.now(),runAfter:f.h.clock.now(),progress:'nonce receipt support detail',error:'unknown_receipt_nonce',rowVersion:1};
  const html=campaignPage({brands:[f.brand],brand:f.brand,csrf:'exact-csrf',tab:'articles'},{article:f.article,version:f.version,jobs:[job],now:f.h.clock.now()});
  const plain=primaryText(html);assert.match(plain,/Needs attention/);assert.match(plain,/may have cost money/);assert.match(plain,/will not repeat automatically/i);assert.doesNotMatch(plain,/unknown_receipt_nonce/);
  assert.match(html,/<summary>Advanced task details<\/summary>/);assert.match(html,/unknown_receipt_nonce/);
  assert.equal(friendlyDeliveryState('succeeded'),'Sent');assert.equal(friendlyDeliveryState('queued'),'Scheduled');assert.equal(friendlyDeliveryState('outcome_unknown'),'Needs checking');assert.equal(friendlyTaskState('future_schema'),'Needs checking');
});
