import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {openTestDatabase,testDatabaseSkipReason} from './database-helper.js';
import {loginMediaProofRole,seedMediaStorageFixture} from './seo-blog-media-fixtures.js';
import {PgApolloStore} from '../../src/integrations/apollo/pg-store.js';
import type {CorporateCompany,Prospect} from '../../src/integrations/apollo/index.js';

test('Apollo: actual roles, owned-brand/session gate, atomic global budgets, dedupe and immutable suppression; no vendor calls',{skip:testDatabaseSkipReason(),timeout:120000},async()=>{
  const admin=await openTestDatabase(),content=await loginMediaProofRole(admin,'r72_content_command'),web=await loginMediaProofRole(admin,'r72_web');
  try{
    const a=await seedMediaStorageFixture(admin,content),b=await seedMediaStorageFixture(admin,content);
    const store=(s:typeof a)=>new PgApolloStore(content,{userId:s.user,sessionToken:s.token,workspaceId:s.home,userEmail:''},s.brand,randomUUID());
    const sa=store(a),sb=store(b);
    await assert.rejects(sa.usage(),{code:'42501'});
    for(const [s,key] of [[a,'prop-invest-uk'],[b,'key-properties-uk']] as const){
      await admin.query('INSERT INTO app.seo_blog_method_private_organizations(organization_id,evidence) VALUES($1,\'synthetic owned fixture\')',[s.org]);
      await admin.query('INSERT INTO app_private.apollo_brand_policy(workspace_id,brand_key,owner_user_id,evidence) VALUES($1,$2,$3,\'synthetic only\')',[s.brand,key,s.user]);
    }
    assert.equal((await sa.usage()).enabled,false);
    await assert.rejects(content.query('SELECT * FROM app_private.apollo_call_ledger'),{code:'42501'});
    await assert.rejects(web.query('SELECT app_private.apollo_command($1,NULL,\'usage\',\'{}\')',[a.brand]),{code:'42501'});
    await admin.query('UPDATE app_private.apollo_account_policy SET enabled=true,monthly_limit=2,free_available=50,confirmed_at=now(),resets_at=now()+interval \'30 days\'');
    await admin.query('UPDATE app_private.apollo_brand_policy SET enabled=true');
    const company:CorporateCompany={name:'Fixture Property Limited',domain:'fixture.example',company_number:'01234567',company_status:'active',company_type:'ltd',sic_codes:['68320'],subscriber_class:'corporate',domain_source:'owner-approved-company-seed'};
    await assert.rejects(sa.seed({...company,company_type:'sole-trader'}),{code:'42501'});
    await sa.seed(company);await sb.seed(company);
    const request=(id:string)=>({id,operation:'org-search' as const,company_number:company.company_number,domain:company.domain});
    const race=await Promise.allSettled([sa.reserve(request(randomUUID())),sb.reserve(request(randomUUID())),sa.reserve(request(randomUUID()))]);
    assert.equal(race.filter(x=>x.status==='fulfilled').length,2);assert.equal((await sa.usage()).remaining,0);
    assert.equal((await sb.usage()).globalUsedOrReserved,2);
    await admin.query('UPDATE app_private.apollo_account_policy SET monthly_limit=50');
    const preview=randomUUID();await sa.reserve({...request(preview),operation:'people-search'});await sa.settle(preview,0);
    const prospect:Prospect={...company,source_vendor:'apollo',vendor_record_id:'synthetic-person',retrieved_at:new Date().toISOString(),vendor_confidence:null,licence_ref:'apollo-free-internal',email:null,title:'Director',credits_spent:0,credits_reserved:0};
    await sa.save(preview,prospect);
    assert.equal((await admin.query('SELECT data->>\'source_vendor\' AS vendor FROM app_private.apollo_prospects WHERE workspace_id=$1',[a.brand])).rows[0].vendor,'apollo');
    await assert.rejects(sa.save(preview,{...prospect,licence_ref:'customer-export' as never}));
    const foreign=new PgApolloStore(content,{userId:b.user,sessionToken:b.token,workspaceId:b.home,userEmail:''},a.brand,randomUUID());
    await assert.rejects(foreign.usage(),{code:'42501'});
    const contact=randomUUID();await admin.query('INSERT INTO app.contacts(id,workspace_id,display_name,custom_fields) VALUES($1,$2,\'Suppressed fixture\',$3)',[contact,a.brand,JSON.stringify({company_number:company.company_number})]);
    await admin.query('INSERT INTO app.contact_points(workspace_id,contact_id,kind,value,normalized_value,consent_status) VALUES($1,$2,\'email\',\'held@fixture.example\',\'held@fixture.example\',\'opted_out\')',[a.brand,contact]);
    const enrich={...request(randomUUID()),operation:'enrich' as const,vendor_record_id:prospect.vendor_record_id};
    await assert.rejects(sa.reserve(enrich),{code:'23505'});
    await admin.query('UPDATE app_private.apollo_prospects SET suppressed=true WHERE workspace_id=$1',[a.brand]);
    await sa.save(preview,{...prospect,email:'new@fixture.example'});
    assert.equal((await admin.query('SELECT suppressed,normalized_email FROM app_private.apollo_prospects WHERE workspace_id=$1',[a.brand])).rows[0].normalized_email,null);
    await assert.rejects(sa.reserve(enrich),{code:'23505'});
    const unknown=randomUUID();await sb.reserve(request(unknown));await sb.settle(unknown,null);
    assert.equal((await sb.usage()).enabled,false,'unknown paid charge trips the global stop switch');
    await admin.query('UPDATE app.user_sessions SET revoked_at=now() WHERE user_id=$1',[a.user]);
    await assert.rejects(sa.usage());
  }finally{await web.end();await content.end();await admin.end();}
});
