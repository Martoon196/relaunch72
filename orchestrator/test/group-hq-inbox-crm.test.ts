import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';
import type { IncomingMessage,ServerResponse } from 'node:http';
import type { Pool } from 'pg';
import { GROUP_HQ_INBOX_CRM_PATH,GroupHqInboxCrmService,InboxCrmError,createGroupHqInboxCrmMount,
  inboxSignature,inboxSocialPoint,loadInboxCrmConfig,verifyInboxSignature,type InboxCrmConfig } from '../src/integrations/group-hq-crm/inbox.js';
import type { CrmTransactionRunner } from '../src/crm-pg/types.js';
import { MHP_MARKETING_WORKSPACE_ID } from '../src/mhp/marketing-workspace-service.js';

const ID=(n:string)=>`${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`;
const scope={label:'Key Properties',workspaceId:ID('1'),organizationId:ID('2'),ownerUserId:ID('3'),
  pipelineId:ID('4'),stageId:ID('5'),actorEmails:['owner@example.test']};
const config: InboxCrmConfig={secret:'test-command-key-'+'x'.repeat(32),scopes:{kp:scope}};
const source={channel:'facebook',accountId:'native-owner',participantId:'NativePersonABC',threadId:'native-thread'};
const input={actorEmail:'owner@example.test',brand:'kp',requestId:ID('6'),source};
function pool(allowed=true) {
  return {connect:async()=>({query:async(sql:string)=>({rows:sql.includes('group-hq.inbox.scope')?[{allowed}]:[],rowCount:1}),release(){}})} as unknown as Pick<Pool,'connect'>;
}

test('inbox command credential and brand mappings are explicit and separate from read bridge',()=>{
  assert.equal(loadInboxCrmConfig({R72_GROUP_HQ_CRM_TOKEN:'read-only'}),undefined);
  assert.deepEqual(loadInboxCrmConfig({R72_GROUP_HQ_INBOX_SECRET:config.secret,R72_GROUP_HQ_INBOX_SCOPES:JSON.stringify(config.scopes)}),config);
  for(const values of [ {R72_GROUP_HQ_INBOX_SECRET:'short',R72_GROUP_HQ_INBOX_SCOPES:JSON.stringify(config.scopes)},
    {R72_GROUP_HQ_INBOX_SECRET:config.secret,R72_GROUP_HQ_INBOX_SCOPES:JSON.stringify({kp:scope,pp:scope})} ]) assert.throws(()=>loadInboxCrmConfig(values));
});
test('Prop Invest UK requires its own configured workspace, organization and actors',()=>{
  const piuk={...scope,workspaceId:ID('7'),organizationId:ID('8'),label:'Prop Invest UK'};
  const read=(scopes:unknown)=>loadInboxCrmConfig({R72_GROUP_HQ_INBOX_SECRET:config.secret,R72_GROUP_HQ_INBOX_SCOPES:JSON.stringify(scopes)});
  assert.deepEqual(read({kp:scope,piuk})?.scopes.piuk,piuk);
  assert.equal(read({kp:scope})?.scopes.piuk,undefined);
  for(const invalid of [{workspaceId:scope.workspaceId},{organizationId:null},{actorEmails:[]}]) {
    assert.throws(()=>read({kp:scope,piuk:{...piuk,...invalid}}));
  }
});
test('signature binds exact bytes, timestamp, method and path',()=>{
  const bytes=Buffer.from(JSON.stringify(input)), now=Date.now(), stamp=String(Math.floor(now/1000));
  const signature=inboxSignature(config.secret,stamp,'POST',GROUP_HQ_INBOX_CRM_PATH,bytes);
  assert.equal(verifyInboxSignature(config.secret,stamp,signature,bytes,now),true);
  for(const [s,b,t] of [[signature,Buffer.from('{}'),stamp],[signature,bytes,String(Number(stamp)-301)],
    ['0'.repeat(64),bytes,stamp],[signature,bytes,stamp+'.5']] as const) assert.equal(verifyInboxSignature(config.secret,t,s,b,now),false);
  assert.equal(verifyInboxSignature(config.secret,stamp,inboxSignature(config.secret,stamp,'GET',GROUP_HQ_INBOX_CRM_PATH,bytes),bytes,now),false);
});
test('signed WhatsApp path binds MHP, owner identity and exact inbox, with only read-only transactions', async()=>{
  const inboxId=ID('7'), actorId=ID('8'), email='owner@example.test';
  const waScope={...scope,workspaceId:MHP_MARKETING_WORKSPACE_ID,whatsappOwnerIds:{[email]:actorId}};
  const waConfig={...config, scopes:{kp:scope,mhp:waScope},mhpWhatsappInboxId:inboxId};
  const statements:string[]=[];
  const readPool={connect:async()=>({query:async(sql:string,values:unknown[])=>{
    statements.push(sql);
    if (sql.includes('group-hq.inbox.scope')) return {rows:[{allowed:true}]};
    if (sql.includes('group-hq.whatsapp.owner')) {
      assert.deepEqual(values,[actorId,MHP_MARKETING_WORKSPACE_ID,email,inboxId]);
      return {rows:[{allowed:true}]};
    }
    return {rows:[]};
  },release(){}})} as unknown as Pick<Pool,'connect'>;
  const runner:CrmTransactionRunner={async run(){throw Error('unexpected CRM command');}};
  const service=new GroupHqInboxCrmService(readPool,runner,waConfig);
  const request={...input,brand:'mhp',accountId:inboxId,action:'whatsappThreads'};
  const loaded=loadInboxCrmConfig({R72_GROUP_HQ_INBOX_SECRET:config.secret,R72_GROUP_HQ_INBOX_SCOPES:JSON.stringify({mhp:{...scope,workspaceId:MHP_MARKETING_WORKSPACE_ID}}),
    GHQ_MHP_WHATSAPP_OWNER_IDS:JSON.stringify({[email]:actorId}), GHQ_MHP_WHATSAPP_INBOX_ID:inboxId});
  assert.deepEqual(loaded?.scopes.mhp?.whatsappOwnerIds,{[email]:actorId});
  assert.deepEqual(await service.execute(request),{brand:'mhp',accountId:inboxId,threads:[],hasMore:false,nextCursor:null});
  await assert.rejects(service.execute({...request,cursor:'malformed'}),e=>e instanceof InboxCrmError && e.status===404);
  assert.ok(statements.some(s=>s.includes('operational_inbox_live_message_provenance')));
  assert.ok(statements.filter(s=>s.startsWith('BEGIN')).every(s=>s.endsWith('READ ONLY')));
  for (const mismatch of [{brand:'kp'},{accountId:ID('2')},{actorEmail:'stranger@example.test'}]) {
    await assert.rejects(service.execute({...request,...mismatch}),e=>e instanceof InboxCrmError && e.status===403);
  }
  const foreign=new GroupHqInboxCrmService(readPool,runner,{...waConfig,scopes:{mhp:{...waScope,workspaceId:ID('4')}}});
  await assert.rejects(foreign.execute(request),e=>e instanceof InboxCrmError && e.status===403);
});
test('social identity uses exact native account and participant IDs without fabricated email',()=>{
  const point=inboxSocialPoint(source);
  assert.match(point,/^facebook:ghq:[a-f0-9]{64}$/u);
  assert.notEqual(point,inboxSocialPoint({...source,participantId:source.participantId.toLowerCase()}));
  assert.notEqual(point,inboxSocialPoint({...source,accountId:'another-account'}));
  assert.equal(point,inboxSocialPoint({...source,threadId:'another-thread-with-same-person'}));
});
test('foreign actor or brand and revoked owner cannot reach command transaction',async()=>{
  let calls=0;
  const runner:CrmTransactionRunner={async run(){calls++;throw Error('not permitted');}};
  const service=new GroupHqInboxCrmService(pool(),runner,config);
  for(const changed of [{...input,actorEmail:'another@example.test'},{...input,brand:'mhp'}])
    await assert.rejects(service.execute({...changed,action:'search',query:'Seller'}),e=>e instanceof InboxCrmError&&e.status===403);
  const revoked=new GroupHqInboxCrmService(pool(false),runner,config);
  await assert.rejects(revoked.execute({...input,action:'search',query:'Seller'}),e=>e instanceof InboxCrmError&&e.status===403);
  assert.equal(calls,0);
});
test('search stays in the selected native workspace and treats wildcard input literally',async()=>{
  const seen:unknown[]=[];
  const runner:CrmTransactionRunner={async run(context,operation){
    assert.equal(context.workspaceId,scope.workspaceId);assert.equal(context.userId,scope.ownerUserId);
    return operation({async query(sql,values){seen.push({sql,values});return {rows:[{id:ID('7'),name:'Durham seller'}] as never,rowCount:1};}});
  }};
  const result=await new GroupHqInboxCrmService(pool(),runner,config).execute({...input,action:'search',query:'%_'}) as {contacts:unknown[]};
  assert.equal(result.contacts.length,1);assert.match(JSON.stringify(seen),/current_workspace_id/);assert.match(JSON.stringify(seen),/%_/);
});
test('leads lists one workspace by keyset, prefers the open opportunity and leaks no contact points',async()=>{
  const seen:{sql:string;values?:readonly unknown[]}[]=[];
  const at=new Date('2026-11-01T10:00:00.123Z');
  const row=(n:string,extra:Record<string,unknown>={})=>({id:ID(n),name:'Lead '+n,source:'webinar',lifecycle:'lead',created_at:at,updated_at:at,
    cursor_updated_at:'2026-11-01T10:00:00.123456Z',opportunity_status:'open',stage_name:'Qualified',stage_position:2,value_minor:'250000',
    currency:'GBP',closed_at:null,stage_changed_at:at,...extra});
  const rows=[row('7'),row('8',{opportunity_status:null,stage_name:null,stage_position:null,value_minor:null,currency:null,stage_changed_at:null}),row('9')];
  const runner:CrmTransactionRunner={async run(context,operation){
    assert.equal(context.workspaceId,scope.workspaceId);assert.equal(context.userId,scope.ownerUserId);
    return operation({async query(sql,values){seen.push({sql,values});return {rows:rows.slice(0,Number(values![2])) as never,rowCount:rows.length};}});
  }};
  const service=new GroupHqInboxCrmService(pool(),runner,config);
  const page=await service.execute({...input,action:'leads',limit:2}) as {brand:string;workspaceId:string;leads:Record<string,unknown>[];nextCursor:string|null};
  assert.equal(page.brand,'kp');assert.equal(page.workspaceId,scope.workspaceId);assert.equal(page.leads.length,2);
  assert.deepEqual(page.leads[0],{id:ID('7'),name:'Lead 7',source:'webinar',lifecycle:'lead',createdAt:at.toISOString(),updatedAt:at.toISOString(),
    opportunity:{status:'open',stage:'Qualified',stagePosition:2,valueMinor:250000,currency:'GBP',stageChangedAt:at.toISOString(),closedAt:null}});
  assert.equal(page.leads[1]!.opportunity,null);
  assert.deepEqual(seen[0]!.values,[null,null,3]);
  assert.match(seen[0]!.sql,/current_workspace_id\(\)/u);assert.match(seen[0]!.sql,/deleted_at IS NULL/u);
  assert.doesNotMatch(seen[0]!.sql,/contact_points|activities|INSERT|UPDATE|DELETE/u);
  assert.deepEqual(JSON.parse(Buffer.from(page.nextCursor!,'base64url').toString('utf8')),{updatedAt:'2026-11-01T10:00:00.123456Z',id:ID('8')});
  const next=await service.execute({...input,action:'leads',cursor:page.nextCursor}) as typeof page;
  assert.deepEqual(seen[1]!.values,['2026-11-01T10:00:00.123456Z',ID('8'),201]);assert.equal(next.nextCursor,null);
  for(const bad of [{cursor:'not a cursor'},{cursor:Buffer.from('{"updatedAt":"yesterday","id":"x"}').toString('base64url')},{limit:0},{limit:201},{limit:'5'}])
    await assert.rejects(service.execute({...input,action:'leads',...bad}),e=>e instanceof InboxCrmError&&e.status===400);
  await assert.rejects(service.execute({...input,action:'leads',actorEmail:'another@example.test'}),e=>e instanceof InboxCrmError&&e.status===403);
});
test('HTTP mount rejects unsigned, stale and wrong-route requests before DB access',async()=>{
  const mount=createGroupHqInboxCrmMount(pool(),pool(),config);
  for(const path of [GROUP_HQ_INBOX_CRM_PATH,GROUP_HQ_INBOX_CRM_PATH+'?brand=kp']) {
    const req=Readable.from([Buffer.from('{}')]) as IncomingMessage;
    req.method='POST';req.headers={};let status=0,body='';
    const res={writeHead(n:number){status=n;},end(value:string){body=value;}} as unknown as ServerResponse;
    await mount.handle(req,res,new URL(path,'https://hq.example.test'));
    assert.equal(status,path.includes('?')?404:401);assert.ok(body.includes('error'));
  }
});
