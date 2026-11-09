/**
 * ROOT ONLY: execute on a disposable exact125 clone. No automatic entry point,
 * connection string, provider or password handling. Caller supplies distinct
 * pg pools with current_user r72_owner/r72_web/r72_crm_command and connection
 * option mhp.proof.enabled=isolated. Command pool must allow >=2 connections.
 * Fixture writes commit only on that disposable clone; Root deletes it later.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { CrmCommandService, CrmPgRepository, createPgCrmTransactionRunner } from '../../src/crm-pg/index.js';
import { requestDatabaseContext } from '../../src/db/rls.js';
import type { CrmTransactionRunner } from '../../src/crm-pg/types.js';
import { PgMhpAuthService } from '../../src/mhp/auth-service.js';
import { PgMhpMarketingWorkspaceService, MHP_MARKETING_WORKSPACE_ID as BRAND } from '../../src/mhp/marketing-workspace-service.js';
import { MhpWebinarLeadService, PgMhpWebinarLeadReader } from '../../src/mhp/webinar-leads-service.js';

const CAMPAIGN='webinar-ghq004-replay-proof';
const FIRST='ed125800-0000-4000-8000-000000000001',SECOND='ed125800-0000-4000-8000-000000000002';
const sha=(value:string)=>createHash('sha256').update(value).digest();
function safeFailure(error:unknown){
  const value=error as {name?:unknown;code?:unknown;message?:unknown};
  return {name:typeof value?.name==='string'?value.name:'Error',code:typeof value?.code==='string'?value.code:null,
    reason:value?.message==='Command receipt conflict was not visible after claim'?'completed_receipt_hidden_from_locked_read':'query_or_command_failure'};
}

/** Resume-only diagnostic for the existing failed isolated FIRST fixture. No fixture mutation. */
export async function diagnoseMhpWebinarLeadReplayProof(input:{ownerPool:Pool;webPool:Pool;commandPool:Pool}) {
  for(const [pool,role] of [[input.ownerPool,'r72_owner'],[input.webPool,'r72_web'],[input.commandPool,'r72_crm_command']] as const){
    const checked=await pool.query<{role:string;guard:string}>("SELECT current_user AS role,current_setting('mhp.proof.enabled',true) AS guard");
    assert.equal(checked.rows[0]?.role,role);assert.equal(checked.rows[0]?.guard,'isolated');
  }
  const token=Buffer.alloc(32,125).toString('base64url');
  const identity=await new PgMhpAuthService({readPool:input.webPool,commandPool:input.webPool}).resolve(token,Date.now());
  assert.ok(identity);assert.equal(identity.workspaceId,BRAND);
  const context=requestDatabaseContext({userId:identity.userId,workspaceId:identity.workspaceId,
    requestId:'isolated-ghq004-diagnostic',portalSessionTokenHash:sha(token)});
  const transactions=createPgCrmTransactionRunner(input.commandPool),key=`mhp.webinar.${CAMPAIGN}.${FIRST}`;
  const visibility=await transactions.run(context,async transaction=>{
    const sql=`SELECT status,result,payload_hash AS "payloadHash" FROM app.command_receipts
      WHERE workspace_id=app_private.current_workspace_id() AND actor_user_id=$1 AND command_name='crm.createLead' AND idempotency_key=$2`;
    const plain=await transaction.query<{status:string;result:unknown;payloadHash:Buffer}>(sql,[identity.userId,key]);
    const locked=await transaction.query(sql+' FOR UPDATE',[identity.userId,key]);
    assert.equal(plain.rows.length,1,'Existing FIRST receipt must be readable');
    assert.equal(plain.rows[0]!.status,'succeeded');
    return {plainCount:plain.rows.length,lockedCount:locked.rows.length,payloadHash:plain.rows[0]!.payloadHash};
  });
  let conflict:ReturnType<typeof safeFailure>|null=null;
  try{await transactions.run(context,transaction=>new CrmPgRepository(transaction).claimCommand({id:randomUUID(),
    commandName:'crm.createLead',commandKey:key,requestId:context.requestId,actorUserId:identity.userId,
    payloadHash:visibility.payloadHash,createdAt:new Date().toISOString()}));}catch(error){conflict=safeFailure(error);}
  return {plainCount:visibility.plainCount,lockedCount:visibility.lockedCount,conflict,
    limits:'Existing synthetic owner session and completed receipt on disposable clone; no provider or new fixture'};
}
async function boundedBarrier(promise:Promise<void>,label:string){
  let timer:NodeJS.Timeout|undefined;
  try{await Promise.race([promise,new Promise<never>((_resolve,reject)=>{
    timer=setTimeout(()=>reject(new Error(`Isolated proof barrier timed out: ${label}`)),20_000);
  })]);}finally{if(timer)clearTimeout(timer);}
}

export async function runMhpWebinarLeadReplayProof(input:{ownerPool:Pool;webPool:Pool;commandPool:Pool}) {
  for(const [pool,role] of [[input.ownerPool,'r72_owner'],[input.webPool,'r72_web'],[input.commandPool,'r72_crm_command']] as const){
    const checked=await pool.query<{role:string;guard:string}>("SELECT current_user AS role,current_setting('mhp.proof.enabled',true) AS guard");
    assert.equal(checked.rows[0]?.role,role);assert.equal(checked.rows[0]?.guard,'isolated');
  }
  const ledger=await input.webPool.query<{filename:string}>('SELECT filename FROM app_private.runtime_schema_migrations() ORDER BY filename');
  assert.equal(ledger.rows.at(-1)?.filename,'0125_mhp_webinar_lead_candidates.sql');
  const owner=await input.ownerPool.query<{actor:string;personal:string}>(
    `SELECT u.id AS actor,m.workspace_id AS personal FROM app.users u
     JOIN app_private.mhp_members m ON m.user_id=u.id
     JOIN app_private.investor_programme_admins a ON a.user_id=u.id
     JOIN app.organization_memberships om ON om.user_id=u.id AND om.organization_id='ba41b1a4-9752-4dbf-8312-d04a0f03d0b8'
      AND om.role='owner' AND om.status='active' AND om.revoked_at IS NULL
     JOIN app.workspace_memberships wm ON wm.user_id=u.id AND wm.workspace_id=$1 AND wm.role='owner' AND wm.status='active' AND wm.revoked_at IS NULL
     WHERE lower(u.email::text)='martin.howard1984@gmail.com' AND u.status='active' AND u.email_verified_at IS NOT NULL`,[BRAND]);
  assert.equal(owner.rows.length,1);const actor=owner.rows[0]!.actor;
  const absent=await input.ownerPool.query<{n:string}>('SELECT count(*)::text AS n FROM app_private.mhp_prospects WHERE id IN($1,$2)',[FIRST,SECOND]);
  assert.equal(absent.rows[0]?.n,'0','Requires fresh disposable replay fixtures');

  async function seedProspect(id:string,suffix:string){
    const connection=await input.ownerPool.connect();
    try{
      await connection.query('BEGIN');
      await connection.query(`INSERT INTO app_private.mhp_prospects(id,email,first_name,level,marketing_consent,consent_version,consent_at)
        VALUES($1,$2,'First device saved name','L1',true,'isolated-replay-v1',clock_timestamp())`,[id,`ghq004-replay-${suffix}@example.invalid`]);
      await connection.query(`INSERT INTO app_private.mhp_prospect_signups(prospect_id,kind,label,link,consent_given,consent_version)
        VALUES($1,'webinar','Synthetic replay webinar','https://martinhowardproperty.co.uk/webinar',true,'isolated-replay-v1')`,[id]);
      await connection.query(`INSERT INTO app_private.mhp_marketing_sends(prospect_id,template_key,campaign_key,context,due_at,expires_at)
        VALUES($1,'webinar_confirm',$2,'{}',clock_timestamp(),clock_timestamp()+interval '1 day')`,[id,CAMPAIGN]);
      await connection.query('COMMIT');
    }catch(error){await connection.query('ROLLBACK');throw error;}finally{connection.release();}
  }
  await seedProspect(FIRST,'first');
  const tokenA=Buffer.alloc(32,125).toString('base64url'),tokenB=Buffer.alloc(32,126).toString('base64url');
  for(const token of [tokenA,tokenB])await input.ownerPool.query(
    `INSERT INTO app.user_sessions(token_hash,csrf_secret_hash,user_id,selected_workspace_id,expires_at,product_audience)
     VALUES($1,$2,$3,$4,clock_timestamp()+interval '1 hour','martin_howard_property')`,[sha(token),sha(token+'csrf'),actor,BRAND]);
  const auth=new PgMhpAuthService({readPool:input.webPool,commandPool:input.webPool});
  const identityA=await auth.resolve(tokenA,Date.now()),identityB=await auth.resolve(tokenB,Date.now());
  assert.ok(identityA&&identityB);assert.equal(identityA.userId,actor);assert.equal(identityB.userId,actor);

  const base=createPgCrmTransactionRunner(input.commandPool);
  let receiptReads=0,claimAttempts=0,releaseReads!:()=>void,releaseSecondClaim!:()=>void;
  const bothReceiptReads=new Promise<void>(resolve=>{releaseReads=resolve;});
  const secondClaim=new Promise<void>(resolve=>{releaseSecondClaim=resolve;});
  let concurrent=true;
  const claims:{attempt:number;startedAt:number;completedAt:number|null}[]=[];
  const failures:{comment:string;error:ReturnType<typeof safeFailure>}[]=[];
  const transactions:CrmTransactionRunner={run(context,operation){return base.run(context,transaction=>operation({
    async query<T extends Record<string,unknown>>(sql:string,values?:readonly unknown[]){
      const claim=sql.includes('crm.claim-command');
      const attempt=claim?++claimAttempts:0;
      const timing=claim?{attempt,startedAt:Date.now(),completedAt:null as number|null}:null;
      if(timing)claims.push(timing);
      const pending=transaction.query<T>(sql,values);
      // Submit the second real pg query while the first command is uncommitted.
      if(concurrent&&claim&&attempt===2)releaseSecondClaim();
      let result;
      try{result=await pending;}catch(error){failures.push({comment:sql.match(/\/\* ([a-z.-]+) \*\//u)?.[1]??'unlabelled',error:safeFailure(error)});throw error;}
      if(concurrent&&sql.includes('mhp.webinar-recorded-lead')&&result.rows.length===0&&receiptReads<2){
        if(++receiptReads===2)releaseReads();
        await boundedBarrier(bothReceiptReads,'both receipt reads');
      }
      if(concurrent&&claim&&attempt===1&&result.rows.length===1)await boundedBarrier(secondClaim,'second claim submitted');
      if(timing)timing.completedAt=Date.now();
      return result;
    },
  }));}};
  const coreCommands=new CrmCommandService({transactionRunner:transactions});
  const commands:Pick<CrmCommandService,'createLead'>={async createLead(context,command){
    try{return await coreCommands.createLead(context,command);}catch(error){failures.push({comment:'crm.createLead',error:safeFailure(error)});throw error;}
  }};
  const reader=new PgMhpWebinarLeadReader(input.webPool);
  const marketingWorkspace=new PgMhpMarketingWorkspaceService(input.webPool,input.webPool);
  let firstPageRead!:()=>void;
  const firstPage=new Promise<void>(resolve=>{firstPageRead=resolve;});
  const service=new MhpWebinarLeadService({campaign:CAMPAIGN,cursorSecret:'isolated-only-ghq004-cursor-secret-over32',marketingWorkspace,transactions,commands,
    reader:{async page(identity,campaign,after){
      if(!concurrent)return reader.page(identity,campaign,after);
      if(identity.sessionToken===tokenA){const result=await reader.page(identity,campaign,after);firstPageRead();return result;}
      await boundedBarrier(firstPage,'first candidate page');
      await input.ownerPool.query("UPDATE app_private.mhp_prospects SET first_name='Second device changed name',level='L3',updated_at=clock_timestamp() WHERE id=$1",[FIRST]);
      return reader.page(identity,campaign,after);
    }},
  });
  const queueHash=async()=>String((await input.ownerPool.query<{hash:string}>(
    "SELECT md5(COALESCE(string_agg(row_to_json(s)::text,'' ORDER BY s.id),'')) AS hash FROM app_private.mhp_marketing_sends s")).rows[0]!.hash);
  const beforeRaceQueue=await queueHash();
  const raced=await Promise.all([
    service.importBatch(identityA,'isolated-ghq004-device-a',''),
    service.importBatch(identityB,'isolated-ghq004-device-b',''),
  ]);
  const raceEvidence=JSON.stringify({raced:raced.map(({added,replayed,failed,processed})=>({added,replayed,failed,processed})),claimAttempts,receiptReads,claims,failures});
  assert.deepEqual(raced.map(result=>result.added).sort(),[0,1],`Race added counts: ${raceEvidence}`);
  assert.deepEqual(raced.map(result=>result.replayed).sort(),[0,1],`Race replay counts: ${raceEvidence}`);
  assert.equal(raced.some(result=>result.failed),false,`Race failure state: ${raceEvidence}`);assert.equal(claimAttempts,2,`Race claims: ${raceEvidence}`);
  assert.ok(claims[1]!.startedAt<=claims[0]!.completedAt!,'Two real receipt claim queries must overlap');
  concurrent=false;
  await input.ownerPool.query("UPDATE app_private.mhp_prospects SET first_name='Changed after successful import',level='L2',updated_at=clock_timestamp() WHERE id=$1",[FIRST]);
  const replay=await service.importBatch(identityA,'isolated-ghq004-replay','');
  assert.equal(replay.added,0);assert.equal(replay.replayed,1);assert.equal(claimAttempts,2,'Completed receipt must bypass command reconstruction');
  assert.equal(await queueHash(),beforeRaceQueue);

  await seedProspect(SECOND,'second');
  const beforePartialQueue=await queueHash();
  let injectFailure=true;
  const partialService=new MhpWebinarLeadService({campaign:CAMPAIGN,cursorSecret:'isolated-only-ghq004-cursor-secret-over32',marketingWorkspace,transactions,reader,
    commands:{async createLead(context,command){
      if(injectFailure&&command.commandKey.endsWith(SECOND))throw new Error('Synthetic interruption before the second command');
      return commands.createLead(context,command);
    }},
  });
  const partial=await partialService.importBatch(identityA,'isolated-ghq004-partial','');
  assert.equal(partial.failed,true);assert.equal(partial.replayed,1);assert.ok(partial.cursor);
  injectFailure=false;
  const resumed=await partialService.importBatch(identityA,'isolated-ghq004-resume',partial.cursor!);
  assert.equal(resumed.failed,false);assert.equal(resumed.added,1);assert.equal(resumed.processed,1);
  assert.equal(await queueHash(),beforePartialQueue);
  const facts=await input.ownerPool.query<{receipts:string;opportunities:string;contacts:string;unknownConsent:string}>(
    `SELECT
      (SELECT count(*)::text FROM app.command_receipts WHERE workspace_id=$1 AND actor_user_id=$2 AND command_name='crm.createLead' AND idempotency_key LIKE $3 AND status='succeeded') AS receipts,
      (SELECT count(*)::text FROM app.opportunities o JOIN app.command_receipts r ON o.id=(r.result->>'opportunityId')::uuid WHERE r.workspace_id=$1 AND r.actor_user_id=$2 AND r.command_name='crm.createLead' AND r.idempotency_key LIKE $3) AS opportunities,
      (SELECT count(*)::text FROM app.contacts c WHERE c.workspace_id=$1 AND c.id IN(SELECT (r.result->>'contactId')::uuid FROM app.command_receipts r WHERE r.workspace_id=$1 AND r.actor_user_id=$2 AND r.command_name='crm.createLead' AND r.idempotency_key LIKE $3)) AS contacts,
      (SELECT count(*)::text FROM app.contact_points p WHERE p.workspace_id=$1 AND p.normalized_value IN('ghq004-replay-first@example.invalid','ghq004-replay-second@example.invalid') AND p.consent_status='unknown') AS "unknownConsent"`,
    [BRAND,actor,`mhp.webinar.${CAMPAIGN}.%`]);
  assert.deepEqual(facts.rows[0],{receipts:'2',opportunities:'2',contacts:'2',unknownConsent:'2'});
  return {sameActorDevices:true,overlappingClaims:claims.slice(0,2),race:{added:1,replayed:1},receiptReads,failures,mutableReplay:true,
    partialRetry:true,queueUnchanged:true,facts:facts.rows[0],limits:'Synthetic same current owner on disposable clone; no other-owner deduplication/provider/live claim'};
}
