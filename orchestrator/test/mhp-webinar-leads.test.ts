import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { IdempotencyKeyReusedError } from '../src/crm-pg/errors.js';
import type { CreateLeadCommand, CreateLeadResult, CrmTransactionRunner } from '../src/crm-pg/types.js';
import type { DatabaseRequestContext } from '../src/db/rls.js';
import { MhpCommerceError } from '../src/mhp/commerce-service.js';
import { MHP_MARKETING_WORKSPACE_ID as BRAND } from '../src/mhp/marketing-workspace-service.js';
import { MhpWebinarLeadService, PgMhpWebinarLeadReader, type MhpWebinarLeadCandidate } from '../src/mhp/webinar-leads-service.js';

const ID='12500000-0000-4000-8000-000000000001',PERSONAL='12500000-0000-4000-8000-000000000002';
const PROSPECT='12500000-0000-4000-8000-000000000010',SECOND='12500000-0000-4000-8000-000000000020';
const SIGNUP='12500000-0000-4000-8000-000000000011',PIPELINE='12500000-0000-4000-8000-000000000012',STAGE='12500000-0000-4000-8000-000000000013';
const CONTACT='12500000-0000-4000-8000-000000000014',OPPORTUNITY='12500000-0000-4000-8000-000000000015';
const CAMPAIGN='webinar-2026-11-04',NOW=Date.parse('2026-10-30T23:00:00Z');
const SECRET='synthetic-webinar-cursor-key-at-least-32';
const identity={userId:ID,workspaceId:BRAND,sessionToken:Buffer.alloc(32,1).toString('base64url'),userEmail:'owner@example.invalid'};
const candidate=(id=PROSPECT):MhpWebinarLeadCandidate=>({prospectId:id,signupId:SIGNUP,campaign:CAMPAIGN,email:'signup@example.invalid',firstName:'Original',level:'L1',label:'Webinar',registeredAt:'2026-10-30T22:00:00Z',link:'https://martinhowardproperty.co.uk/webinar',marketingConsent:true,unsubscribed:false,signupConsentGiven:true});
const saved:CreateLeadResult={disposition:'applied',contactId:CONTACT,opportunityId:OPPORTUNITY,taskId:null,createdContact:true};

function harness(options:{denyReceiptAfterCommand?:boolean}={}) {
  const receipts=new Map<string,CreateLeadResult>(),commands:CreateLeadCommand[]=[],contexts:DatabaseRequestContext[]=[];
  let rows=[candidate()], failProspect:string|null=null, pageCalls=0, race=false;
  let raceError:Error=new IdempotencyKeyReusedError();
  let releaseFirst:((value:CreateLeadResult)=>void)|undefined;
  const transactions:CrmTransactionRunner={async run(context,operation){
    contexts.push(context);
    assert.equal(context.workspaceId,BRAND);assert.equal(context.userId,ID);assert.equal(context.actorKind,'user');
    assert.equal(context.portalSessionTokenHash?.length,32);
    return operation({async query<T extends Record<string,unknown>>(sql:string,values?:readonly unknown[]){
      if(options.denyReceiptAfterCommand&&commands.length>0&&sql.includes('mhp.webinar-recorded-lead'))throw new Error('Synthetic revoked session');
      const data=sql.includes('mhp.webinar-recorded-lead')
        ? receipts.has(String(values?.[1]))?[{status:'succeeded',result:receipts.get(String(values?.[1]))}]:[]
        : sql.includes('mhp.webinar-new-stage')?[{pipelineId:PIPELINE,stageId:STAGE}]:null;
      assert.ok(data,'Unexpected importer query');return {rows:data as unknown as T[],rowCount:data.length};
    }});
  }};
  const service=new MhpWebinarLeadService({campaign:CAMPAIGN,cursorSecret:SECRET,transactions,
    marketingWorkspace:{snapshot:async actual=>({userId:actual.userId,selectedWorkspaceId:actual.workspaceId,personalWorkspaceId:PERSONAL,marketingWorkspaceId:BRAND,marketingSelected:actual.workspaceId===BRAND})},
    reader:{page:async(actual,campaign,after)=>{pageCalls++;assert.equal(campaign,CAMPAIGN);const all=rows.filter(row=>after===null||row.prospectId>after);
      return {candidates:all.map(row=>({...row,firstName:race?actual.sessionToken===identity.sessionToken?'First device':'Second device':row.firstName})),hasMore:false,nextAfter:null};}},
    commands:{createLead:async(_context,input)=>{commands.push(input);
      if(failProspect&&input.commandKey.endsWith(failProspect))throw new Error('private command detail');
      if(race){
        if(!releaseFirst)return new Promise<CreateLeadResult>(resolve=>{releaseFirst=resolve;});
        receipts.set(input.commandKey,saved);releaseFirst(saved);throw raceError;
      }
      receipts.set(input.commandKey,saved);return saved;
    }},
  });
  return {service,receipts,commands,contexts,setRows:(value:MhpWebinarLeadCandidate[])=>{rows=value;},fail:(value:string|null)=>{failProspect=value;},race:(error?:Error)=>{race=true;if(error)raceError=error;},pageCalls:()=>pageCalls};
}

test('webinar import uses the real owner context and replays before rebuilding changed name/level input',async()=>{
  const f=harness();const first=await f.service.importBatch(identity,'request-1','',NOW);
  assert.deepEqual({added:first.added,replayed:first.replayed,failed:first.failed},{added:1,replayed:0,failed:false});
  f.setRows([{...candidate(),firstName:'Changed after import',level:'L3',marketingConsent:false,unsubscribed:true}]);
  const again=await f.service.importBatch(identity,'request-2','',NOW);
  assert.equal(again.replayed,1);assert.equal(again.added,0);assert.equal(f.commands.length,1);
  assert.equal(f.commands[0]!.contactPoints[0]!.consentStatus,'unknown');
  assert.equal(f.commands[0]!.source?.length,98);assert.match(f.commands[0]!.source!,new RegExp(`${SIGNUP}:${PROSPECT}$`));
  assert.equal(f.commands[0]!.commandKey,`mhp.webinar.${CAMPAIGN}.${PROSPECT}`);
  assert.equal(f.commands[0]!.pipelineId,PIPELINE);assert.equal(f.commands[0]!.stageId,STAGE);assert.equal(f.commands[0]!.task,undefined);
  assert.deepEqual(f.contexts[0]!.portalSessionTokenHash,createHash('sha256').update(identity.sessionToken).digest());
});

test('same owner concurrent devices with different names resolve the losing payload hash to the recorded result',async()=>{
  const f=harness();f.race();
  const other={...identity,sessionToken:Buffer.alloc(32,2).toString('base64url')};
  const results=await Promise.all([f.service.importBatch(identity,'device-1','',NOW),f.service.importBatch(other,'device-2','',NOW)]);
  assert.deepEqual(results.map(result=>result.added).sort(),[0,1]);assert.deepEqual(results.map(result=>result.replayed).sort(),[0,1]);
  assert.equal(results.some(result=>result.failed),false);assert.equal(f.receipts.size,1);
  assert.notEqual(f.commands[0]!.displayName,f.commands[1]!.displayName);
});

test('a generic core conflict recovers only the completed own receipt after the command transaction fails',async()=>{
  const f=harness();f.race(new Error('Command receipt conflict was not visible after claim'));
  const other={...identity,sessionToken:Buffer.alloc(32,2).toString('base64url')};
  const results=await Promise.all([f.service.importBatch(identity,'device-1','',NOW),f.service.importBatch(other,'device-2','',NOW)]);
  assert.deepEqual(results.map(result=>result.added).sort(),[0,1]);
  assert.deepEqual(results.map(result=>result.replayed).sort(),[0,1]);
  assert.equal(results.some(result=>result.failed),false);assert.equal(f.receipts.size,1);
  assert.equal(f.commands.length,2);
});

test('a failed command with no completed receipt or revoked reread stays failed without command detail',async()=>{
  for(const denyReceiptAfterCommand of [false,true]){
    const f=harness({denyReceiptAfterCommand});f.fail(PROSPECT);
    const result=await f.service.importBatch(identity,'unrecorded-failure','',NOW);
    assert.equal(result.failed,true);assert.equal(result.added,0);assert.equal(result.replayed,0);
    assert.equal(result.processed,0);assert.equal(f.receipts.size,0);
    assert.doesNotMatch(JSON.stringify(result),/private command|revoked session/);
  }
});

test('partial import retries from the last saved candidate without exposing command errors',async()=>{
  const f=harness();f.setRows([candidate(),candidate(SECOND)]);f.fail(SECOND);
  const partial=await f.service.importBatch(identity,'partial','',NOW);
  assert.equal(partial.failed,true);assert.equal(partial.added,1);assert.equal(partial.processed,1);assert.ok(partial.cursor);
  assert.doesNotMatch(JSON.stringify(partial),/private command/);
  f.fail(null);const resumed=await f.service.importBatch(identity,'resume',partial.cursor!,NOW+1000);
  assert.equal(resumed.failed,false);assert.equal(resumed.added,1);assert.equal(resumed.processed,1);assert.equal(resumed.hasMore,false);
  assert.equal(f.commands.filter(command=>command.commandKey.endsWith(PROSPECT)).length,1);
});

test('import cursor is bound to the owner session and expiry; personal workspace is denied',async()=>{
  const f=harness();f.fail(PROSPECT);const partial=await f.service.importBatch(identity,'first','',NOW);
  const before=f.pageCalls();
  for(const [who,cursor,at] of [
    [identity,partial.cursor!+'a',NOW],
    [{...identity,sessionToken:Buffer.alloc(32,3).toString('base64url')},partial.cursor!,NOW],
    [identity,partial.cursor!,NOW+31*60_000],
    [{...identity,workspaceId:PERSONAL},'',NOW],
  ] as const)await assert.rejects(f.service.importBatch(who,'invalid',cursor,at),MhpCommerceError);
  assert.equal(f.pageCalls(),before);
});

test('candidate reader sends only a session hash and fixed batch cap, rejecting malformed or unrelated responses',async()=>{
  let page:unknown={campaign:CAMPAIGN,candidates:[candidate()],hasMore:false,nextAfter:null};let values:unknown[]=[];
  const reader=new PgMhpWebinarLeadReader({query:async(_sql:string,input:unknown[])=>{values=input;return {rows:[{page}]};}} as never);
  assert.equal((await reader.page(identity,CAMPAIGN,null)).candidates.length,1);
  assert.deepEqual(values,[createHash('sha256').update(identity.sessionToken).digest(),CAMPAIGN,null,25]);
  for(const invalid of [
    {campaign:CAMPAIGN,candidates:Array(26).fill(candidate()),hasMore:false,nextAfter:null},
    {campaign:CAMPAIGN,candidates:[candidate(SECOND),candidate()],hasMore:false,nextAfter:null},
    {campaign:'other-webinar',candidates:[candidate()],hasMore:false,nextAfter:null},
    {campaign:CAMPAIGN,candidates:[candidate()],hasMore:true,nextAfter:null},
  ]){page=invalid;await assert.rejects(reader.page(identity,CAMPAIGN,null),/temporarily unavailable/);}
});
