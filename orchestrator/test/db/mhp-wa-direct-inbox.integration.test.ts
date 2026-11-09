import assert from 'node:assert/strict';
import {createHash, randomBytes, randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {Pool} from 'pg';
import {readOwnerWhatsapp} from '../../src/integrations/group-hq-crm/whatsapp-reader.js';
import {requestDatabaseContext} from '../../src/db/rls.js';
import {assertMetaWhatsAppLiveWorkerBoundaryReady,assertMetaWhatsAppLiveWebhookBoundaryReady} from '../../src/whatsapp-live-pg/readiness.js';
import {openTestDatabase, ownerQuery, resetIdentityTables, testDatabaseSkipReason, expectPostgresError} from './database-helper.js';

const workspace='2789228d-55a6-4688-b1e8-2f70abca990b';
const ownerId='0b131000-0000-4000-8000-000000000001';
const binding='0b132000-0000-4000-8000-000000000003';
const connection='0b132000-0000-4000-8000-000000000001';
const sender='447700900077';
const digest=(s:string)=>createHash('sha256').update(s).digest();
const roles=['r72_whatsapp_live_webhook_command','r72_web','r72_crm_command','r72_whatsapp_live_worker_command'] as const;

test('MHP direct inbox: signed first contact, real owner reply, once-only worker and late STOP', {skip:testDatabaseSkipReason(), timeout:180000}, async()=>{
 const owner=await openTestDatabase();
 const pools:Pool[]=[];
 try {
  await resetIdentityTables(owner);
  await ownerQuery(owner,'TRUNCATE app_private.mhp_prospects CASCADE');
  await ownerQuery(owner,'TRUNCATE app_private.mhp_unlinked_opt_events');
  await ownerQuery(owner,await readFile(new URL('./mhp-event-whatsapp.fixture.sql',import.meta.url),'utf8'));
  const inboxes=await ownerQuery<{id:string}>(owner,"SELECT id FROM app.inboxes WHERE workspace_id=$1 AND channel='whatsapp'",[workspace]);
  assert.equal(inboxes.length,1);
  const inbox=inboxes[0]!.id;
  for (const role of roles) {
   const password=randomUUID();
   const change=await owner.query("SELECT format('ALTER ROLE %I PASSWORD %L',$1::text,$2::text) AS sql",[role,password]);
   await owner.query(change.rows[0].sql);
   const url=new URL(process.env.TEST_DATABASE_URL!);url.username=role;url.password=password;
   pools.push(new Pool({connectionString:url.toString(),max:3}));
  }
  await assertMetaWhatsAppLiveWorkerBoundaryReady(pools[3]!);
  await assertMetaWhatsAppLiveWebhookBoundaryReady(pools[0]!);
  async function call(index:number,sql:string,args:unknown[],actor=ownerId,ws=workspace) {
   const client=await pools[index]!.connect();
   try {
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    await client.query("SELECT set_config('app.workspace_id',$1,true),set_config('app.actor_kind',$2,true),set_config('app.user_id',$3,true),set_config('app.request_id',$4,true)",
      [ws,['webhook','user','user','worker'][index],index===1||index===2?actor:'',randomUUID()]);
    const result=await client.query(sql,args);
    await client.query('COMMIT');return result.rows;
   } catch(e) {await client.query('ROLLBACK');throw e;} finally {client.release();}
  }
  const receivedAt=new Date(Date.now()-2000),payload=randomBytes(32),signature=randomBytes(32);
  function incoming(id:string,body:string,phone=sender,isStop=false) {
   const ext='whatsapp-message:'+id,shaSender=digest(phone),shaBody=digest(body);
   const identity=digest([ext,id,shaSender.toString('hex'),shaBody.toString('hex'),payload.toString('hex'),signature.toString('hex')].join('\x1f'));
   const fn=isStop?'mhp_record_event_whatsapp_inbound':'record_whatsapp_live_inbound_projection';
   return call(0,'SELECT * FROM app_private.'+fn+'($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
    [workspace,binding,ext,id,phone,body,shaSender,shaBody,payload,signature,identity,receivedAt]);
  }
  const firstId='wamid.'+randomUUID();
  const [first]=await incoming(firstId,'MHP test from unlinked number');
  assert.equal(first.disposition,'applied');
  assert.equal((await incoming(firstId,'MHP test from unlinked number'))[0].disposition,'replayed');
  assert.equal((await incoming(firstId,'Changed payload'))[0].disposition,'conflict');
  const linked=await ownerQuery(owner,"SELECT id FROM app.contact_points WHERE workspace_id=$1 AND kind='whatsapp' AND normalized_value=$2",[workspace,sender]);
  assert.deepEqual(linked,[]);
  await expectPostgresError(call(0,'SELECT * FROM app_private.mhp_wa_direct_threads',[]),'42501');
  const thread=first.conversation_id;
  const history=(actor=ownerId,ws=workspace)=>call(1,'SELECT id,body,direction,reply_state FROM app_private.mhp_wa_direct_history($1,$2) ORDER BY occurred_at,id',[inbox,thread],actor,ws);
  assert.equal((await history()).length,1);
  const ctx=requestDatabaseContext({userId:ownerId,workspaceId:workspace,requestId:'direct-inbox-test'});
  const ownerRead=()=>readOwnerWhatsapp(pools[1]!,ctx,'martin.howard1984@gmail.com',inbox,thread);
  const read=await ownerRead();
  assert.equal(read?.messages?.[0]?.contactId,null);
  assert.equal(read?.messages?.[0]?.participantId,thread);
  assert.equal(read?.canReply,true);
  assert.deepEqual(await history(randomUUID()),[]);assert.deepEqual(await history(ownerId,randomUUID()),[]);
  const key=randomUUID();
  const queue=(id=key,body='A manual service reply',actor=ownerId)=>call(2,'SELECT app_private.mhp_wa_direct_queue($1,$2,$3,$4) AS result',[id,inbox,thread,body],actor);
  const begin=()=>call(3,'SELECT reply_id,recipient,body FROM app_private.mhp_wa_direct_begin($1,$2,$3)',[workspace,binding,connection]);
  assert.equal((await queue(key,'A manual service reply',randomUUID()))[0].result,'refused');
  assert.equal((await queue())[0].result,'queued');
  assert.equal((await queue())[0].result,'queued');
  assert.equal((await queue(key,'Changed owner reply'))[0].result,'conflict');
  const [a,b]=await Promise.all([begin(),begin()]);
  assert.deepEqual([...a,...b],[{reply_id:key,recipient:sender,body:'A manual service reply'}]);
  assert.equal((await call(3,"SELECT app_private.mhp_wa_direct_finish($1,$2,$3,'accepted',$4) AS done",[workspace,binding,key,'wamid.test']))[0].done,true);
  assert.equal((await history()).at(-1)?.reply_state,'accepted');
  const statusTime=new Date(),ext='whatsapp-status:wamid.test:delivered';
  const delivery=(sha=payload)=>call(0,'SELECT app_private.record_whatsapp_live_status($1,$2,$3,$4,$5,$6,$7,$8) AS result',
    [workspace,binding,ext,'wamid.test',digest(sender),'delivered',sha,statusTime]);
  assert.equal((await delivery())[0].result,'applied');
  assert.equal((await delivery())[0].result,'replayed');
  assert.equal((await delivery(randomBytes(32)))[0].result,'conflict');
  assert.equal((await ownerRead())?.messages?.[0]?.replyState,'delivered');
  const pending=randomUUID();
  assert.equal((await queue(pending))[0].result,'queued');
  assert.equal((await incoming('wamid.'+randomUUID(),'STOP',sender,true))[0].disposition,'unlinked_stop');
  assert.equal((await queue(randomUUID()))[0].result,'refused');
  assert.equal((await ownerRead())?.canReply,false);
  assert.deepEqual(await begin(),[]);
  assert.equal((await history()).at(-1)?.reply_state,'expired');
 } finally {
  await Promise.all(pools.map(p=>p.end()));
  try {for(const role of roles) await owner.query('ALTER ROLE '+role+' PASSWORD NULL');} finally {await owner.end();}
 }
});
