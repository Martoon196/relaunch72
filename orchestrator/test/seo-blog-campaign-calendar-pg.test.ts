import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {createPgSeoBlogSocialRegistry} from '../src/portal/seo-blog-social-pg.js';

test('connected diary uses the existing command capability, exact selected-home session and target brand with bounded window/row validation',async()=>{
  const brand=randomUUID(),home=randomUUID(),user=randomUUID(),job=randomUUID(),calls:{sql:string;values:unknown[]}[]=[];
  let active=true,state='reconciliation_pending';
  const pool=(kind:'content'|'zernio')=>({connect:async()=>({async query(sql:string,values:unknown[]=[]){
    calls.push({sql:`${kind}:${sql}`,values});
    if(sql.includes('lock_active_portal_session'))return {rows:[{ok:active}]};
    if(sql.includes('can_manage_workspace'))return {rows:[{ok:true}]};
    if(sql.includes('list_zernio_calendar_jobs'))return {rows:[{job_id:job,network:'linkedin',content_body:'Synthetic exact copy\n\nhttps://brand.example/blog/article',scheduled_for:'2026-11-05T10:00:00+00:00',state,safe_code:'source.held'}]};
    return {rows:[]};
  },release(){}} as unknown as PoolClient)});
  const registry=createPgSeoBlogSocialRegistry({zernioPool:pool('zernio'),contentCommandPool:pool('content'),contentAdapterPool:pool('content'),identity:{userId:user,workspaceId:home,sessionToken:'synthetic-opaque-session',userEmail:'synthetic@example.test'},requestId:randomUUID(),zernioApiKey:null,reservedProfileIds:[],fetch:async()=>{throw Error('No provider call allowed');}});
  const from='2026-11-01T00:00:00.000Z',to='2026-12-01T00:00:00.000Z';
  const result=await registry.listCalendar!(brand,from,to);assert.equal(result.length,1);assert.equal(result[0]!.state,'reconciliation_pending');
  const listing=calls.find(c=>c.sql.startsWith('zernio:')&&c.sql.includes('list_zernio_calendar_jobs'))!;assert.deepEqual(listing.values,[brand,from,to]);assert.match(listing.sql,/,100\)/);
  const lock=calls.find(c=>c.sql.startsWith('zernio:')&&c.sql.includes('lock_active_portal_session'))!;assert.equal(lock.values[1],user);assert.equal(lock.values[2],home);assert.ok(calls.indexOf(lock)<calls.indexOf(listing));
  const before=calls.length;await assert.rejects(registry.listCalendar!(brand,from,'2028-01-01T00:00:00.000Z'),{status:400});assert.equal(calls.length,before);
  state='invented_published_state';await assert.rejects(registry.listCalendar!(brand,from,to),{status:503});
  active=false;await assert.rejects(registry.listCalendar!(brand,from,to),/session|signed|inactive/i);
  assert.equal(calls.filter(c=>c.sql.includes('list_zernio_calendar_jobs')).length,2);
});
