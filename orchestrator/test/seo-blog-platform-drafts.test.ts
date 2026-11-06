import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {POSTING_PLATFORMS,currentPostDraft,derivePostDraft,draftTarget,editPostDraft,exportPostDraft,postDraftIsStale,restorePostDraft,type PostDraftSource} from '../src/seo-blog/platform-drafts.js';
const at='2026-11-06T21:00:00Z';
function source():PostDraftSource {
  return {articleId:randomUUID(),brandId:randomUUID(),versionId:randomUUID(),contentSha:'a'.repeat(64),profileVersion:12,factsSha:'b'.repeat(64),publicUrl:'https://example.org/blog/comparables',body:{slug:'refurbishment-budget',title:'How should I check refurbishment assumptions?',seoTitle:'Check refurbishment assumptions',metaDescription:'A practical guide to testing the evidence behind a refurbishment budget and offer.',excerpt:'Check the evidence and keep the assumptions visible.',intro:'Compare similar properties, separate the works estimate from the valuation, and record the assumptions before deciding what to offer. [src:public-source]',sections:[{id:randomUUID(),heading:'Check the evidence',body:'Use the actual address, comparable evidence and written scope of works.'}],conclusion:'Review each assumption when better evidence becomes available.',cta:{label:'See our tool',url:'https://example.org/?affiliate=secret'},faqs:[{q:'Should I use asking prices as sold evidence?',a:'An asking price is a seller expectation. Check completed sales and note how the properties differ. [Read our tool](https://example.org/?affiliate=secret) [src:public-source]'}],citations:[{sourceId:'public-source',url:'https://www.gov.uk/example',title:'Public guidance',retrievedAt:at,passage:'Public supporting passage.',public:true},{sourceId:'private-source',url:'https://private.example/brief',title:'Private note',retrievedAt:at,passage:'PRIVATE_SOURCE_NOTE',public:false}],image:{kind:'none',url:null,alt:'',provenance:'',width:null,height:null},author:null}};
}
test('newsletter is derived from the article and public citations without leaking private source notes',()=>{
  const s=source(),before=JSON.stringify(s),d=derivePostDraft(s,'substack','Property Predator',{id:randomUUID(),actor:'owner',at});
  const r=currentPostDraft(d);assert.match(r.body,/## Check the evidence/);assert.match(r.body,/https:\/\/www.gov.uk\/example/);assert.doesNotMatch(r.body,/PRIVATE_SOURCE_NOTE|private.example|\[src:/);assert.equal(r.mode,'article');assert.equal(r.generation,null);assert.equal(JSON.stringify(s),before);assert.match(exportPostDraft(d),/^# How should/);
});
test('community drafts answer the actual source FAQ, disclose the brand and omit affiliate or promotional links',()=>{
  const s=source();for(const platform of ['reddit','quora'] as const){const r=currentPostDraft(derivePostDraft(s,platform,'Property Predator',{id:randomUUID(),actor:'owner',at}));assert.equal(r.question,s.body.faqs[0]!.q);assert.match(r.body,/An asking price is a seller expectation/);assert.match(r.body,/Disclosure: shared by Property Predator/);assert.doesNotMatch(r.body,/https?:|affiliate|\[src:|Read our tool/);assert.equal(r.sourceVersionId,s.versionId);assert.equal(r.factsSha,s.factsSha);}
});
test('every posting format has a usable source-derived draft without another generation',()=>{
  const s=source();for(const p of POSTING_PLATFORMS){const d=derivePostDraft(s,p.id,'Brand',{id:randomUUID(),actor:'owner',at});assert.ok(currentPostDraft(d).body);assert.equal(d.revisions.length,1);assert.equal(currentPostDraft(d).generation,null);}
});
test('posting targets reject private, credential-bearing and misleading platform addresses; custom Substack domains work',()=>{
  for(const url of ['javascript:alert(1)','https://localhost/post','https://user:secret@reddit.com/','https://reddit.com.evil.example/thread','https://127.0.0.1/'])assert.throws(()=>draftTarget('reddit',url));
  assert.equal(draftTarget('reddit','https://www.reddit.com/r/example/comments/example/'),'https://www.reddit.com/r/example/comments/example/');assert.equal(draftTarget('substack','https://newsletter.example.org/'),'https://newsletter.example.org/');assert.equal(draftTarget('custom',''),null);
});
test('edits and restores append versions, retain source binding and expose stale source versions',()=>{
  const s=source(),d=derivePostDraft(s,'quora','Brand',{id:randomUUID(),actor:'owner',at}),first=currentPostDraft(d);
  const input={id:randomUUID(),actor:'owner',at,title:first.title,body:'A clearer standalone answer using the same supported facts.',question:first.question,targetUrl:'https://www.quora.com/example-question'};
  const edited=editPostDraft(d,first.id,input);assert.equal(edited.revisions.length,2);assert.equal(currentPostDraft(edited).number,2);assert.equal(d.revisions.length,1);assert.equal(editPostDraft(edited,first.id,input),edited);assert.throws(()=>editPostDraft(edited,first.id,{...input,body:'Different bytes'}));
  assert.throws(()=>editPostDraft(edited,first.id,{...input,id:randomUUID()}));
  const restored=restorePostDraft(edited,currentPostDraft(edited).id,first.id,{id:randomUUID(),actor:'owner',at});assert.equal(restored.revisions.length,3);assert.equal(currentPostDraft(restored).body,first.body);assert.equal(currentPostDraft(restored).number,3);assert.equal(postDraftIsStale(restored,s),false);assert.equal(postDraftIsStale(restored,{...s,versionId:randomUUID()}),true);
});
