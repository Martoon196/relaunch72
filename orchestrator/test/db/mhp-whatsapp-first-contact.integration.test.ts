import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Pool } from 'pg';
import { openTestDatabase, ownerQuery, resetIdentityTables, expectPostgresError, testDatabaseSkipReason } from './database-helper.js';
import { assertMetaWhatsAppLiveWebhookBoundaryReady } from '../../src/whatsapp-live-pg/readiness.js';

const WS='2789228d-55a6-4688-b1e8-2f70abca990b';
const BINDING='0b132000-0000-4000-8000-000000000003';
const ROLE='r72_whatsapp_live_webhook_command';
const sha=(value:string|Buffer)=>createHash('sha256').update(value).digest();
const makeInbound=(sender='447700900077',body='MHP TEST')=>({id:`wamid.${randomBytes(12).toString('hex')}`,sender,body,payload:randomBytes(32),signature:randomBytes(32),occurred:new Date(Date.now()-1000)});
type Inbound=ReturnType<typeof makeInbound>;

test('MHP142 official first contact: real-role isolated identity, replay/conflict, STOP and unmatched status', {skip:testDatabaseSkipReason(),timeout:180000},async()=>{
 const owner=await openTestDatabase();let webhook:Pool|undefined;
 try{
  await resetIdentityTables(owner);
  await ownerQuery(owner,'TRUNCATE app_private.mhp_prospects CASCADE');
  await ownerQuery(owner,'TRUNCATE app_private.mhp_unlinked_opt_events');
  await ownerQuery(owner,await readFile(new URL('./mhp-event-whatsapp.fixture.sql',import.meta.url),'utf8'));
  const password=`disposable-wa142-${randomUUID()}`;
  const change=await owner.query<{sql:string}>('SELECT format(\'ALTER ROLE %I PASSWORD %L\',$1::text,$2::text) AS sql',[ROLE,password]);
  await owner.query(change.rows[0]!.sql);
  const url=new URL(process.env.TEST_DATABASE_URL!);url.username=ROLE;url.password=password;
  webhook=new Pool({connectionString:url.toString(),max:3});
  await assertMetaWhatsAppLiveWebhookBoundaryReady(webhook);
  const call=async(sql:string,values:unknown[],workspace=WS)=>{
   const c=await webhook!.connect();
   try{await c.query('BEGIN ISOLATION LEVEL READ COMMITTED');await c.query("SELECT set_config('app.workspace_id',$1,true),set_config('app.actor_kind','webhook',true),set_config('app.user_id','',true),set_config('app.request_id',$2,true)",[workspace,randomUUID()]);
    const result=await c.query(sql,values);await c.query('COMMIT');return result.rows;
   }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
  };
  const inbound=async(m:Inbound,workspace=WS)=>{
   const external=`whatsapp-message:${m.id}`,sender=sha(m.sender),body=sha(m.body);
   const identity=sha([external,m.id,sender.toString('hex'),body.toString('hex'),m.payload.toString('hex'),m.signature.toString('hex')].join('\u001f'));
   return (await call('SELECT disposition FROM app_private.record_whatsapp_live_inbound_projection($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
    [workspace,BINDING,external,m.id,m.sender,m.body,sender,body,m.payload,m.signature,identity,m.occurred],workspace))[0]!.disposition;
  };
  const first=makeInbound();
  assert.equal(await inbound(first),'applied');
  assert.equal(await inbound(first),'replayed');
  assert.equal(await inbound({...first,body:'changed evidence'}),'conflict');
  const rows=await ownerQuery(owner,`SELECT p.contact_id,p.is_verified,p.consent_status,c.source,
    (SELECT count(*)::int FROM app.contact_points e WHERE e.workspace_id=p.workspace_id AND e.contact_id=p.contact_id AND e.kind='email') AS emails,
    (SELECT count(*)::int FROM app.communication_consent_events e WHERE e.workspace_id=p.workspace_id AND e.contact_id=p.contact_id) AS consents,
    (SELECT count(*)::int FROM app.conversations e WHERE e.workspace_id=p.workspace_id AND e.contact_id=p.contact_id AND e.channel='whatsapp') AS conversations
    FROM app.contact_points p JOIN app.contacts c ON c.workspace_id=p.workspace_id AND c.id=p.contact_id WHERE p.workspace_id=$1 AND p.kind='whatsapp' AND p.normalized_value=$2`,[WS,first.sender]);
  assert.equal(rows.length,1);assert.equal(rows[0]!.is_verified,true);assert.equal(rows[0]!.consent_status,'unknown');
  assert.equal(rows[0]!.source,'mhp:whatsapp:inbound');assert.equal(rows[0]!.emails,0);assert.equal(rows[0]!.consents,0);assert.equal(rows[0]!.conversations,1);
  assert.deepEqual(await Promise.all([inbound(makeInbound('447700900078','first parallel')),inbound(makeInbound('447700900078','second parallel'))]),['applied','applied']);
  assert.equal((await ownerQuery<{count:number}>(owner,"SELECT count(*)::int AS count FROM app.contact_points WHERE workspace_id=$1 AND kind='whatsapp' AND normalized_value='447700900078'",[WS]))[0]!.count,1);
  await expectPostgresError(inbound(makeInbound('447700900079','STOP')),'23503');
  await expectPostgresError(inbound(makeInbound('447700900079','JOIN invalid')),'23503');
  const imported=randomUUID();
  await ownerQuery(owner,"INSERT INTO app.contacts(id,workspace_id,display_name) VALUES($1,$2,'Unverified import')",[imported,WS]);
  await ownerQuery(owner,"INSERT INTO app.contact_points(workspace_id,contact_id,kind,value,normalized_value,is_verified) VALUES($1,$2,'whatsapp','+447700900080','447700900080',false)",[WS,imported]);
  await expectPostgresError(inbound(makeInbound('447700900080')),'23503');
  assert.equal((await ownerQuery<{is_verified:boolean}>(owner,'SELECT is_verified FROM app.contact_points WHERE contact_id=$1',[imported]))[0]!.is_verified,false);
  await expectPostgresError(inbound(makeInbound(),randomUUID()),'42501');
  await expectPostgresError(call('SELECT count(*) FROM app.contacts',[]),'42501');
  await expectPostgresError(call('SELECT * FROM app_private.record_whatsapp_live_inbound_projection_0141($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',[WS,BINDING,'test',first.id,first.sender,first.body,sha(first.sender),sha(first.body),first.payload,first.signature,randomBytes(32),first.occurred]),'42501');
  const statusId=`whatsapp-status:${first.id}:delivered`,occurred=new Date(),payload=randomBytes(32),recipient=sha(first.sender);
  const status=(state='delivered',digest=payload)=>call('SELECT app_private.record_whatsapp_live_status($1,$2,$3,$4,$5,$6,$7,$8) AS outcome',[WS,BINDING,statusId,first.id,recipient,state,digest,occurred]);
  const jobsBefore=(await ownerQuery<{count:number}>(owner,'SELECT count(*)::int AS count FROM app.property_predator_whatsapp_live_jobs'))[0]!.count;
  assert.equal((await status())[0]!.outcome,'applied');assert.equal((await status())[0]!.outcome,'replayed');
  assert.equal((await status('read'))[0]!.outcome,'conflict');assert.equal((await status('delivered',randomBytes(32)))[0]!.outcome,'conflict');
  const receipts=await ownerQuery(owner,'SELECT job_id,safe_code FROM app.property_predator_whatsapp_live_receipts WHERE external_event_id=$1',[statusId]);
  assert.deepEqual(receipts,[{job_id:null,safe_code:'mhp_whatsapp_unmatched_status'}]);
  assert.equal((await ownerQuery<{count:number}>(owner,'SELECT count(*)::int AS count FROM app.property_predator_whatsapp_live_jobs'))[0]!.count,jobsBefore);
  await expectPostgresError(call('SELECT app_private.record_whatsapp_live_status($1,$2,$3,$4,$5,$6,$7,$8)',[WS,randomUUID(),randomUUID(),first.id,recipient,'delivered',payload,occurred]),'42501');
  await assertMetaWhatsAppLiveWebhookBoundaryReady(webhook);
 }finally{await webhook?.end();try{await owner.query(`ALTER ROLE ${ROLE} PASSWORD NULL`);}finally{await owner.end();}}
});
