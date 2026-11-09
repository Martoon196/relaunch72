/** Disposable localhost PostgreSQL only. No production URL or provider is accepted. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash,randomUUID } from 'node:crypto';
import pg from 'pg';
import { PgMethodStore } from '../../src/seo-blog/method-store.js';
import { MethodController,libraryPins } from '../../src/seo-blog/method-packs.js';
import { writeArticle } from '../../src/seo-blog/generation.js';
import { PgSeoBlogStore } from '../../src/seo-blog/pg-store.js';
import { sha256 } from '../../src/seo-blog/engine.js';
import type { ArticleBody,ArticleVersion } from '../../src/seo-blog/types.js';
import { fixtureBrand,MethodFixtureModel } from '../rl72-method-fixtures.js';

const url=process.env.RL72_METHODS_PG_TEST_URL;
const skip=!url||process.env.RELAUNCH72_DATABASE_INTEGRATION!=='explicit-disposable-run'?'Explicit disposable RL72 methods PostgreSQL run only.':false;
test('RL72 methods: actual PostgreSQL forced RLS, function-only owner commands and immutable receipts', {skip},async t=>{
 const parsed=new URL(url!);assert(['127.0.0.1','localhost'].includes(parsed.hostname));assert.equal(parsed.pathname,'/relaunch72_test');
 const admin=new pg.Pool({connectionString:url,max:2});
 const c=new URL(url!);c.username='r72_content_command';c.password='local-methods-test-only';
 const content=new pg.Pool({connectionString:c.toString(),max:2});
 const fixture=async(kind:'home'|'b2b')=>{
   const f=fixtureBrand(kind),user=f.profile.confirmedBy!,token=randomUUID()+randomUUID();
   await admin.query("INSERT INTO app.organizations(id,name,slug,kind) VALUES($1,$2,$3,'direct_customer')",[f.brand.organizationId,f.brand.name,'org-'+f.brand.organizationId]);
   await admin.query("INSERT INTO app.users(id,email,status) VALUES($1,$2,'active')",[user,user+'@example.test']);
   await admin.query("INSERT INTO app.organization_memberships(organization_id,user_id,role,status) VALUES($1,$2,'owner','active')",[f.brand.organizationId,user]);
   await admin.query("INSERT INTO app.workspaces(id,organization_id,name,slug) VALUES($1,$2,$3,$4)",[f.brand.id,f.brand.organizationId,f.brand.name,'methods-'+f.brand.id]);
   await admin.query("INSERT INTO app.workspace_memberships(workspace_id,organization_id,user_id,role,status,source_organization_id) VALUES($1,$2,$3,'owner','active',$2)",[f.brand.id,f.brand.organizationId,user]);
   await admin.query("INSERT INTO app.user_sessions(token_hash,csrf_secret_hash,user_id,selected_workspace_id,expires_at) VALUES($1,$2,$3,$4,now()+interval '1 hour')",[createHash('sha256').update(token).digest(),createHash('sha256').update('csrf'+token).digest(),user,f.brand.id]);
   await admin.query('INSERT INTO app.seo_blog_brands(workspace_id,organization_id,created_by_user_id,settings) VALUES($1,$2,$3,$4)',[f.brand.id,f.brand.organizationId,user,JSON.stringify(f.brand.settings)]);
   const store=new PgMethodStore(content,{kind:'user',userId:user,requestId:'methods-test',sessionToken:token,selectedWorkspaceId:f.brand.id});
   return {...f,user,token,store};
 };
 try{
  const a=await fixture('home'),b=await fixture('b2b');
  const pins=libraryPins().filter(p=>['production-core','blog-writing'].includes(p.packId));
  await t.test('login roles have no new table grants or definer membership',async()=>{
   assert.equal((await content.query('SELECT current_user AS u')).rows[0].u,'r72_content_command');
   for(const table of ['releases','catalogue','assignments','receipts','bindings','private_organizations']){
    await assert.rejects(content.query('SELECT * FROM app.seo_blog_method_'+table),{code:'42501'});
   }
   assert.equal((await content.query("SELECT pg_has_role(current_user,'r72_seo_method_definer','MEMBER') AS allowed")).rows[0].allowed,false);
  });
  await t.test('private organizations require operator enrolment; no customer self-enrolment',async()=>{
   await assert.rejects(a.store.assign(a.brand.id,0,pins),/operator enrolment/);
   await admin.query("INSERT INTO app.seo_blog_method_private_organizations(organization_id,evidence) VALUES($1,'Test-only explicit owner organization enrolment'),($2,'Separate test-only organization')",[a.brand.organizationId,b.brand.organizationId]);
   assert.equal(await a.store.assign(a.brand.id,0,pins),1);assert.equal(await b.store.assign(b.brand.id,0,pins),1);
  });
  await t.test('real sessions cannot read or assign a foreign brand',async()=>{
   await assert.rejects(b.store.snapshot(a.brand.id));
   await assert.rejects(b.store.assign(a.brand.id,1,[]));
   await assert.rejects(a.store.assign(a.brand.id,0,pins),{code:'40001'});
  });
  const generate=async(f:typeof a)=>{
    const model=new MethodFixtureModel();
    const llm=await new MethodController(f.store,true).prepare(model,{...f,stages:['blog'],stage:'blog',assetRef:'article:'+f.brief.id,sources:['fixture-source','S1'],baselineTokens:32000});
    return writeArticle(llm,{...f,linkable:[],length:'concise'});
  };
  const aa=await generate(a),bb=await generate(b);
  await t.test('same methods produce distinct fictional brand tasks and persist sidecars privately',async()=>{
    assert.match(aa.value.intro,/maintenance/);assert.match(bb.value.intro,/appointment/);
    const ar=await a.store.receipt(a.brand.id,aa.record.methodReceiptId!),br=await b.store.receipt(b.brand.id,bb.record.methodReceiptId!);
    assert.deepEqual(ar!.pins,br!.pins);assert.notEqual(ar!.sidecar!.audience,br!.sidecar!.audience);
    await assert.rejects(b.store.receipt(a.brand.id,aa.record.methodReceiptId!));
    assert.equal(await b.store.receipt(b.brand.id,aa.record.methodReceiptId!),null);
  });
  await t.test('resulting article versions bind atomically to their private production receipts',async()=>{
    for(const [f,result] of [[a,aa],[b,bb]] as const){
      const store=new PgSeoBlogStore(content,{kind:'user',userId:f.user,requestId:'binding-test',sessionToken:f.token,selectedWorkspaceId:f.brand.id});
      const articleId=f.brief.id,body:ArticleBody={title:result.value.title,seoTitle:result.value.seo_title,metaDescription:result.value.meta_description,
        excerpt:result.value.excerpt,slug:f.brief.slug,intro:result.value.intro,sections:result.value.sections.map(s=>({...s,id:randomUUID()})),
        conclusion:result.value.conclusion,cta:f.brief.cta,faqs:[],citations:[],image:{kind:'none',url:null,alt:result.value.image_alt,provenance:'Fictional test illustration.',width:null,height:null},author:null};
      await store.createArticle({id:articleId,brandId:f.brand.id,briefId:f.brief.id,planId:f.brief.planId,slug:f.brief.slug,editorialState:'draft',currentVersionId:null,
        requiresApproval:true,approval:null,checks:null,schedule:null,hold:null,delivery:'none',publishedVersionId:null,publishedUrl:null,lastAttemptAt:null,publishedAt:null,failure:null,createdAt:f.profile.createdAt,rowVersion:1});
      const version:ArticleVersion={id:randomUUID(),articleId,brandId:f.brand.id,number:1,parentVersionId:null,change:'generated',changedSectionId:null,createdAt:f.profile.createdAt,
        createdBy:f.user,body,profileVersion:1,factsSha:f.profile.factsSha,knowledge:[],briefId:f.brief.id,planId:f.brief.planId,generation:result.record,contentSha:sha256(body)};
      await store.addVersion(version);
      assert.deepEqual((await store.getVersion(f.brand.id,version.id))!.body,body);
      const binding=await admin.query('SELECT asset_kind,asset_version_id,approval_state FROM app.seo_blog_method_bindings WHERE workspace_id=$1 AND receipt_id=$2',[f.brand.id,result.record.methodReceiptId]);
      assert.equal(binding.rowCount,1);assert.equal(binding.rows[0].asset_version_id,version.id);assert.equal(binding.rows[0].approval_state,'draft');
    }
  });
  await t.test('forced RLS hides foreign receipts even from the NOLOGIN definer under scoped context',async()=>{
    const client=await admin.connect();
    try{
      await client.query('BEGIN');await client.query('SET LOCAL ROLE r72_seo_method_definer');
      await client.query("SELECT set_config('app.workspace_id',$1,true)",[a.brand.id]);
      const rows=await client.query('SELECT workspace_id FROM app.seo_blog_method_receipts');
      assert(rows.rows.every(r=>r.workspace_id===a.brand.id));assert.equal(rows.rowCount,1);
      const forced=await client.query("SELECT relforcerowsecurity FROM pg_class WHERE oid='app.seo_blog_method_receipts'::regclass");
      assert.equal(forced.rows[0].relforcerowsecurity,true);
      await client.query('ROLLBACK');
    }finally{client.release();}
  });
  await t.test('receipts and assignments remain immutable; revocation preserves saved evidence',async()=>{
    await assert.rejects(admin.query("UPDATE app.seo_blog_method_receipts SET data=data||'{\"approvalState\":\"approved\"}' WHERE workspace_id=$1",[a.brand.id]),/append-only/);
    assert.equal(await a.store.assign(a.brand.id,1,[]),2);
    await assert.rejects(new MethodController(a.store,true).prepare(new MethodFixtureModel(),{...a,stages:['revision'],stage:'revision',assetRef:'x',sources:[],baselineTokens:8000,preserveReceiptId:aa.record.methodReceiptId!}),/no longer assigned/);
    assert(await a.store.receipt(a.brand.id,aa.record.methodReceiptId!));
  });
  await t.test('unsupported registry entries remain unavailable capabilities',async()=>{
    await b.store.assign(b.brand.id,1,libraryPins().filter(p=>['production-core','email-writing'].includes(p.packId)));
    await assert.rejects(new MethodController(b.store,true).prepare(new MethodFixtureModel(),{...b,stages:['blog'],stage:'blog',assetRef:'x',sources:[],baselineTokens:32000}),/Unavailable capability/);
  });
 }finally{await content.end();await admin.end();}
});
