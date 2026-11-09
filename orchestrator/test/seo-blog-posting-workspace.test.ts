import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {websiteFixture} from './seo-blog-website-fixtures.js';
import {OWNER,STRANGER} from './seo-blog-fixtures.js';
import {currentPostDraft} from '../src/seo-blog/platform-drafts.js';
import {postingDraftsPage} from '../src/portal/seo-blog-posting-view.js';
import {topicsPage} from '../src/portal/seo-blog-view.js';
import {programmeRun} from '../src/seo-blog/programme.js';

test('a queued saved-research continuation shows progress instead of a second resume form',async()=>{
  const f=await websiteFixture(),jobs=await f.h.engine.listJobs(OWNER,f.brand.id),prior=jobs.find(j=>j.kind==='plan')!;
  const run=programmeRun(prior)!,job={...prior,state:'queued' as const,payload:{...prior.payload,programme:{...run,modelStart:undefined,modelReceipt:undefined}}};
  const brand={...f.brand,settings:{...f.brand.settings,programme:{...f.brand.settings.programme,researchHold:{logicalRunId:run.logicalRunId,jobId:job.id,at:job.updatedAt,reason:'planning_held',diagnostic:null}}}};
  const html=topicsPage({brand,brands:[brand],tab:'topics',csrf:'test'},{plans:[],readiness:await f.h.engine.readiness(OWNER,brand.id),jobs:[job],commandId:randomUUID(),estimatePerArticle:32000});
  assert.match(html,/Research is in progress/);assert.doesNotMatch(html,/Continue with saved research|Resume research as a new intent|Research needs your attention|name="confirmResearchResume"/);
});

test('posting workspace gives ready formats, retains blog approvals, protects ownership and appends post versions without provider calls',async()=>{
  const f=await websiteFixture(),engine=f.h.engine;
  const before=await engine.getArticle(OWNER,f.brand.id,f.articleId),usage=await engine.usage(OWNER,f.brand.id),calls=f.h.llm.calls.length;
  let data=await engine.getPostingDrafts(OWNER,f.brand.id,f.articleId);
  assert.equal(data.drafts.length,9);assert.equal(data.drafts.some(d=>d.saved),false);
  assert.deepEqual((await engine.getArticle(OWNER,f.brand.id,f.articleId)).article,before.article,'GET does not write');
  await assert.rejects(()=>engine.getPostingDrafts(STRANGER,f.brand.id,f.articleId));
  const entry=data.drafts.find(d=>d.draft.platform==='quora')!,r=currentPostDraft(entry.draft);
  const input={versionId:data.version.id,rowVersion:data.article.rowVersion,draftId:entry.draft.id,revisionId:r.id,commandId:randomUUID(),title:r.title,body:r.body+'\n\nA clearer explanation.',question:r.question,targetUrl:'https://www.quora.com/example-question'};
  await assert.rejects(()=>engine.savePostingDraft(STRANGER,f.brand.id,f.articleId,input));
  await assert.rejects(()=>engine.savePostingDraft(OWNER,f.brand.id,f.articleId,{...input,draftId:randomUUID()}));
  const saved=await engine.savePostingDraft(OWNER,f.brand.id,f.articleId,input);assert.equal(saved.revisions.length,2);
  await assert.rejects(()=>engine.savePostingDraft(OWNER,f.brand.id,f.articleId,{...input,commandId:randomUUID()}));
  data=await engine.getPostingDrafts(OWNER,f.brand.id,f.articleId);
  await engine.restorePostingDraft(OWNER,f.brand.id,f.articleId,{versionId:data.version.id,rowVersion:data.article.rowVersion,draftId:saved.id,revisionId:saved.currentRevisionId,restoreId:r.id,commandId:randomUUID()});
  data=await engine.getPostingDrafts(OWNER,f.brand.id,f.articleId);
  const restored=data.drafts.find(d=>d.draft.id===saved.id)!.draft;assert.equal(restored.revisions.length,3);assert.equal(currentPostDraft(restored).body,r.body);
  const after=await engine.getArticle(OWNER,f.brand.id,f.articleId);assert.equal(after.version!.id,before.version!.id);assert.deepEqual(after.version,before.version);assert.deepEqual(after.article.approval,before.article.approval);assert.deepEqual(after.article.checks,before.article.checks);assert.equal(after.article.schedule,before.article.schedule);
  assert.equal(f.h.llm.calls.length,calls);assert.deepEqual(await engine.usage(OWNER,f.brand.id),usage);assert.equal(f.h.site.posts,0);
  const html=postingDraftsPage({brands:[f.brand],brand:f.brand,tab:'articles',csrf:'safe-token'},data);
  for(const text of ['Substack','Reddit','Quora','Medium','Threads','Bluesky','Post version history','Copy text','name="_csrf"','Answer a question'])assert.ok(html.includes(text),text);
  assert.doesNotMatch(html,/name="csrf"|auto.publish.*checked/);
});

test('an answer uses the chosen FAQ and old post versions are flagged after blog edits',async()=>{
  const f=await websiteFixture(),engine=f.h.engine;let data=await engine.getPostingDrafts(OWNER,f.brand.id,f.articleId);
  const index=data.version.body.faqs.length-1;assert.ok(index>=0);
  await assert.rejects(()=>engine.createPostingAnswer(OWNER,f.brand.id,f.articleId,{versionId:data.version.id,rowVersion:data.article.rowVersion,platform:'reddit',questionIndex:999}));
  const answer=await engine.createPostingAnswer(OWNER,f.brand.id,f.articleId,{versionId:data.version.id,rowVersion:data.article.rowVersion,platform:'reddit',questionIndex:index});
  assert.equal(currentPostDraft(answer).question,data.version.body.faqs[index]!.q);
  data=await engine.getPostingDrafts(OWNER,f.brand.id,f.articleId);
  await engine.editArticle(OWNER,f.brand.id,f.articleId,data.version.id,{title:data.version.body.title+' revised'});
  data=await engine.getPostingDrafts(OWNER,f.brand.id,f.articleId);
  assert.ok(data.drafts.find(d=>d.draft.id===answer.id)!.stale);
  assert.ok(data.drafts.some(d=>d.draft.platform==='reddit'&&!d.saved&&!d.stale));
});
