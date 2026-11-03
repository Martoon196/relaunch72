import test from 'node:test';
import assert from 'node:assert/strict';
import {authorityReviewFixture,reviewId} from './seo-blog-authority-programme-fixtures.js';
import {buildAuthorityProgrammeReview,authorityReviewSha,AuthorityReviewInputError,AUTHORITY_REVIEW_LIMITS,type AuthorityReviewInput} from '../src/seo-blog/authority-programme-findings.js';
import {buildAuthorityAssetBriefs} from '../src/seo-blog/authority-asset-briefs.js';
import {renderAuthorityReviewCards} from '../src/seo-blog/authority-review-cards.js';
const edit=(fn:(v:any)=>void)=>{const v=authorityReviewFixture();fn(v);return v;};
test('real input types yield bounded private review candidates with exact source identities and separate dates',()=>{
 const input=authorityReviewFixture(),r=buildAuthorityProgrammeReview(input);
 assert.equal(r.identity.brandId,input.brand.id);assert.equal(r.identity.origin,input.brand.website);assert.equal(r.identity.profileSha256,authorityReviewSha(input.profile));assert.equal(r.identity.inventorySha256,authorityReviewSha(input.inventory));assert.equal(r.identity.deliverySha256,authorityReviewSha(input.deliveries));assert.equal(r.persisted,false);assert.equal(r.ownerReviewRequired,true);assert.ok(r.findings.every(x=>x.ownerReviewRequired&&x.evidence.every(e=>e.sha256.length===64&&e.observedAt)));
});
test('cross-brand profile, inventory and supplier records fail closed',()=>{
 for(const fn of [(v:any)=>v.profile.brandId=reviewId(90),(v:any)=>v.inventory.brandId=reviewId(90),(v:any)=>v.indexedMentions.scope.brandId=reviewId(90),(v:any)=>v.indexedMentions.items[0].brandId=reviewId(90)])assert.throws(()=>buildAuthorityProgrammeReview(edit(fn)),AuthorityReviewInputError);
});
test('unconfirmed or stale-knowledge profiles cannot prepare programme candidates',()=>{
 assert.throws(()=>buildAuthorityProgrammeReview(edit(v=>v.profile.confirmedAt=null)),AuthorityReviewInputError);
 assert.throws(()=>buildAuthorityProgrammeReview(edit(v=>v.currentKnowledge=[{...v.currentKnowledge[0],version:2}])),AuthorityReviewInputError);
 assert.throws(()=>buildAuthorityProgrammeReview(edit(v=>v.profile.knowledge.push({...v.profile.knowledge[0]}))),AuthorityReviewInputError);
});
test('foreign scan and delivery URLs reject while a recorded external canonical becomes a review prompt',()=>{
 for(const fn of [(v:any)=>v.inventory.website='https://other.example',(v:any)=>v.inventory.pages[0].url='https://other.example/page',(v:any)=>v.deliveries[0].evidence.index.url='https://other.example/blog'])assert.throws(()=>buildAuthorityProgrammeReview(edit(fn)),AuthorityReviewInputError);
 const r=buildAuthorityProgrammeReview(edit(v=>v.inventory.pages[0].canonical='https://other.example/preferred'));assert.ok(r.findings.some(f=>f.rule==='canonical-review'&&f.targetUrl?.endsWith('/start')));
});
test('finding IDs dedupe independently of retrieval dates; exact observation hashes change',()=>{
 const input=authorityReviewFixture(),r=buildAuthorityProgrammeReview(input);const later=edit(v=>{v.now='2026-11-04T12:00:00.000Z';v.inventory.fetchedAt='2026-11-04T08:00:00.000Z';});const r2=buildAuthorityProgrammeReview(later);
 assert.deepEqual(r.findings.map(f=>f.id),r2.findings.map(f=>f.id));assert.notEqual(r.identity.snapshotSha256,r2.identity.snapshotSha256);assert.notEqual(r.identity.inventorySha256,r2.identity.inventorySha256);
});
test('stale scan cannot generate current canonical, title or heading diagnoses',()=>{
 const r=buildAuthorityProgrammeReview(edit(v=>v.inventory.fetchedAt='2026-09-01T08:00:00.000Z'));
 assert.equal(r.findings.find(f=>f.rule==='stale-inventory')?.classification,'unknown');assert.ok(!r.findings.some(f=>/canonical-review|title-review|heading-review|duplicate-title/u.test(f.rule)));
});
test('incomplete and unknown delivery evidence never establishes article or sitemap absence',()=>{
 const r=buildAuthorityProgrammeReview(authorityReviewFixture());for(const f of r.findings.filter(f=>/delivery-(sitemap|category)/u.test(f.rule))){assert.equal(f.classification,'unknown');assert.match(f.explanation,/cannot prove presence or absence/u);}
 const old=buildAuthorityProgrammeReview(edit(v=>v.deliveries[0].evidence.article.at='2026-09-01T08:00:00.000Z'));assert.equal(old.findings.find(f=>f.rule==='delivery-article')?.classification,'unknown');
});
test('ambiguous multiple current deliveries for one article are rejected instead of choosing by UUID',()=>{
 assert.throws(()=>buildAuthorityProgrammeReview(edit(v=>v.deliveries.push({...v.deliveries[0],publicationId:reviewId(70)}))),AuthorityReviewInputError);
});
test('duplicate recorded titles count distinct URLs, not duplicate scan rows',()=>{
 const r=buildAuthorityProgrammeReview(edit(v=>v.inventory.pages.push({...v.inventory.pages[0]})));const dup=r.findings.filter(f=>f.rule.startsWith('duplicate-title:'));assert.equal(dup.length,1);assert.match(dup[0]!.explanation,/2 distinct/u);
});
test('unmeasured technical and search dimensions are explicit, with no fabricated score',()=>{
 const r=buildAuthorityProgrammeReview(authorityReviewFixture());assert.ok(r.notMeasured.some(x=>x.includes('robots')));assert.ok(r.notMeasured.some(x=>x.includes('noindex')));assert.ok(r.notMeasured.includes('structured data'));assert.ok(r.notMeasured.includes('backlinks and earned links'));assert.equal(r.consumerAiResults,'not_measured');assert.equal(r.referralTraffic,'not_measured');assert.doesNotMatch(JSON.stringify(r),/readinessScore|rankingScore/u);
});
test('supplier context retains model, platform, market, period, truncation and index dates without a consumer claim',()=>{
 const r=buildAuthorityProgrammeReview(authorityReviewFixture());assert.equal(r.indexedSample?.platform,'chat_gpt');assert.equal(r.indexedSample?.locationCode,2826);assert.equal(r.indexedSample?.languageCode,'en');assert.equal(r.indexedSample?.observations[0]?.reportedModel,'supplier-reported-model');assert.equal(r.indexedSample?.observations[0]?.firstRecordedAt,'2026-11-01T08:00:00.000Z');assert.equal(r.findings.find(f=>f.rule==='indexed-mention-sample')?.classification,'unknown');
 const empty=buildAuthorityProgrammeReview(edit(v=>{v.indexedMentions.items=[];v.indexedMentions.outcome='empty';v.indexedMentions.complete=true;}));assert.equal(empty.findings.find(f=>f.rule==='indexed-mention-sample')?.classification,'unknown');assert.match(empty.findings.find(f=>f.rule==='indexed-mention-sample')!.explanation,/do not establish absence/u);
});
test('input, date and output bounds are enforced and truncation stays honest',()=>{
 assert.throws(()=>buildAuthorityProgrammeReview(edit(v=>v.inventory.pages=Array(251).fill(v.inventory.pages[0]))),AuthorityReviewInputError);
 assert.throws(()=>buildAuthorityProgrammeReview(edit(v=>v.inventory.fetchedAt='2027-01-01T00:00:00.000Z')),AuthorityReviewInputError);
 assert.throws(()=>buildAuthorityProgrammeReview(edit(v=>v.maxEvidenceAgeDays=0)),AuthorityReviewInputError);
 const r=buildAuthorityProgrammeReview(edit(v=>v.inventory.pages=Array.from({length:80},(_,i)=>({...v.inventory.pages[0],url:v.brand.website+'/page-'+i,fetchStatus:'error'}))));assert.equal(r.findings.length,AUTHORITY_REVIEW_LIMITS.findings);assert.equal(r.findingsTruncated,true);
});
test('asset briefs cite actual confirmed facts and observations, with explicit unresolved inputs',()=>{
 const input=edit(v=>v.profile.conflicts=[{field:'Current entitlement',detail:'Owner confirmation needed.',documentIds:[reviewId(2)]}]);const r=buildAuthorityProgrammeReview(input),b=buildAuthorityAssetBriefs(input,r);
 assert.ok(b.some(x=>x.kind==='checklist'));assert.ok(b.some(x=>x.kind==='comparison'));assert.ok(b.some(x=>x.kind==='resource'));for(const brief of b){assert.equal(brief.publishable,false);assert.equal(brief.scheduled,false);assert.equal(brief.status,'owner_review');assert.equal(brief.sourceIdentity.snapshotSha256,r.identity.snapshotSha256);assert.ok(brief.availableFacts.every(f=>input.profile.approvedClaims.includes(f.text)&&f.documentRefs[0]?.documentId===reviewId(2)&&f.qualification==='review_against_open_conflicts'));assert.ok(brief.missingInputs.some(x=>x.includes('Current entitlement')));assert.ok(brief.evidence.every(x=>x.sha256.length===64));}
 assert.doesNotMatch(JSON.stringify(b),/original study|guaranteed traffic|ROI/u);
});
test('briefs reject changed sources, omit stale scan ideas and require a real confirmed audience',()=>{
 const input=authorityReviewFixture(),review=buildAuthorityProgrammeReview(input);assert.throws(()=>buildAuthorityAssetBriefs(edit(v=>v.profile.approvedClaims.push('A new claim.')),review),AuthorityReviewInputError);
 const stale=edit(v=>{v.inventory.fetchedAt='2026-09-01T08:00:00.000Z';delete v.indexedMentions;});assert.ok(buildAuthorityAssetBriefs(stale,buildAuthorityProgrammeReview(stale)).every(x=>x.kind!=='resource'));
 const empty=edit(v=>v.profile.audiences=[]);assert.deepEqual(buildAuthorityAssetBriefs(empty,buildAuthorityProgrammeReview(empty)),[]);
});
test('proposal cards escape source text and do not turn malicious evidence into executable links',()=>{
 const input=edit(v=>v.profile.approvedClaims=['<img src=x onerror=alert(1)>']);const r=buildAuthorityProgrammeReview(input),b=buildAuthorityAssetBriefs(input,r),html=renderAuthorityReviewCards(r,b);assert.match(html,/&lt;img/u);assert.doesNotMatch(html,/<img src=x/u);assert.match(html,/Owner review needed/u);assert.match(html,/Not measured/u);
 const evil={...r,findings:r.findings.map(f=>({...f,evidence:f.evidence.map(e=>({...e,url:'javascript:alert(1)'}))}))};assert.doesNotMatch(renderAuthorityReviewCards(evil,b),/href="javascript/u);
});
