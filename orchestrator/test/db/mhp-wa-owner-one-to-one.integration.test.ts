import assert from 'node:assert/strict';
import {createHash, randomBytes, randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {Pool} from 'pg';
import {assertMetaWhatsAppLiveWorkerBoundaryReady,assertMetaWhatsAppLiveWebhookBoundaryReady} from '../../src/whatsapp-live-pg/readiness.js';
import {openTestDatabase, ownerQuery, resetIdentityTables, testDatabaseSkipReason, expectPostgresError} from './database-helper.js';

// Synthetic data only: numbers are in Ofcom's reserved drama range (07700 900xxx), names are invented.
const mhp='2789228d-55a6-4688-b1e8-2f70abca990b';
const ownerId='0b131000-0000-4000-8000-000000000001';
const binding='0b132000-0000-4000-8000-000000000003';
const connection='0b132000-0000-4000-8000-000000000001';
const ppOrg='0b151000-0000-4000-8000-000000000001', pp='0b151000-0000-4000-8000-000000000002';
const outsider='0b151000-0000-4000-8000-000000000003';
const digest=(s:string)=>createHash('sha256').update(s).digest();
const roles=['r72_crm_command','r72_whatsapp_live_worker_command','r72_whatsapp_live_webhook_command'] as const;
type Row=Record<string,any>;

test('MHP owner one-to-one WhatsApp: cross-brand link, owner attestation, template variables, idempotent send, receipts, holds and withdrawal',
 {skip:testDatabaseSkipReason(), timeout:180000}, async()=>{
 const owner=await openTestDatabase();
 const pools:Pool[]=[];
 try {
  await resetIdentityTables(owner);
  await ownerQuery(owner,'TRUNCATE app_private.mhp_prospects CASCADE');
  await ownerQuery(owner,'TRUNCATE app_private.mhp_unlinked_opt_events');
  await ownerQuery(owner,await readFile(new URL('./mhp-event-whatsapp.fixture.sql',import.meta.url),'utf8'));
  // A second brand (Property Predator) in another organisation that the same owner manages, with one CRM contact.
  await ownerQuery(owner,`DO $s$ BEGIN
   PERFORM set_config('app.user_id','${ownerId}',true); PERFORM set_config('app.request_id','owner-121-fixture',true);
   INSERT INTO app.organizations(id,name,slug,kind) VALUES('${ppOrg}','Synthetic PP','synthetic-pp-121','direct_customer');
   INSERT INTO app.workspaces(id,organization_id,name,slug) VALUES('${pp}','${ppOrg}','PP brand','pp-brand-121');
   INSERT INTO app.organization_memberships(organization_id,user_id,role,status) VALUES('${ppOrg}','${ownerId}','owner','active');
   INSERT INTO app.workspace_memberships(workspace_id,organization_id,user_id,role,status) VALUES('${pp}','${ppOrg}','${ownerId}','owner','active');
   INSERT INTO app.users(id,email,display_name,status,email_verified_at) VALUES('${outsider}','outsider-121@example.test','Outsider','active',clock_timestamp());
  END $s$`);
  const ppContact=randomUUID(), ppPoint=randomUUID(), second=randomUUID(), secondPoint=randomUUID();
  await ownerQuery(owner,`INSERT INTO app.contacts(id,workspace_id,display_name) VALUES($1,$3,'Avery Example'),($2,$3,'Blake Example')`,[ppContact,second,pp]);
  await ownerQuery(owner,`INSERT INTO app.contact_points(id,workspace_id,contact_id,kind,value,normalized_value) VALUES
   ($1,$5,$2,'phone','07700 900123','07700900123'),($3,$5,$4,'phone','+447700900124','+447700900124')`,[ppPoint,ppContact,secondPoint,second,pp]);
  for (const role of roles) {
   const password=randomUUID();
   const change=await owner.query("SELECT format('ALTER ROLE %I PASSWORD %L',$1::text,$2::text) AS sql",[role,password]);
   await owner.query(change.rows[0].sql);
   const url=new URL(process.env.TEST_DATABASE_URL!);url.username=role;url.password=password;
   pools.push(new Pool({connectionString:url.toString(),max:3}));
  }
  await assertMetaWhatsAppLiveWorkerBoundaryReady(pools[1]!);
  await assertMetaWhatsAppLiveWebhookBoundaryReady(pools[2]!);
  async function call(index:number,sql:string,args:unknown[]=[],actor=ownerId):Promise<Row[]> {
   const client=await pools[index]!.connect();
   try {
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    await client.query("SELECT set_config('app.workspace_id',$1,true),set_config('app.actor_kind',$2,true),set_config('app.user_id',$3,true),set_config('app.request_id',$4,true)",
      [mhp,['user','worker','webhook'][index],index===0?actor:'',randomUUID()]);
    const result=await client.query(sql,args);
    await client.query('COMMIT');return result.rows;
   } catch(e) {await client.query('ROLLBACK');throw e;} finally {client.release();}
  }
  const one=async(index:number,sql:string,args:unknown[]=[],actor=ownerId)=>(await call(index,sql,args,actor))[0]!.r;
  const link=(contact:string,point:string|null,number:string|null,actor=ownerId)=>
   one(0,'SELECT app_private.mhp_wa_owner_link($1,$2,$3,$4,$5) AS r',[pp,'pp',contact,point,number],actor);
  const state=(contact=ppContact)=>one(0,'SELECT app_private.mhp_wa_owner_contact_state($1,$2) AS r',[pp,contact]);
  const permission=(l:string,command:string,decision:string,basis:string|null,kind:string|null,note:string|null,attest:boolean,contact=ppContact)=>
   one(0,'SELECT app_private.mhp_wa_owner_set_permission($1,$2,$3,$4,$5,$6,$7,$8,$9) AS r',[pp,contact,l,command,decision,basis,kind,note,attest]);
  const queue=(l:string,send:string,meta:string,vars:unknown,sha:string,contact=ppContact)=>
   one(0,'SELECT app_private.mhp_wa_owner_queue_template($1,$2,$3,$4,$5,$6::jsonb,decode($7,\'hex\')) AS r',[pp,contact,send,l,meta,JSON.stringify(vars),sha]);
  const preview=(meta:string,vars:unknown)=>one(0,'SELECT app_private.mhp_wa_owner_preview($1,$2::jsonb) AS r',[meta,JSON.stringify(vars)]);
  const observe=(meta:string,name:string,format:string,names:string[],body:string,status='APPROVED')=>
   call(1,'SELECT app_private.record_mhp_wa_owner_template($1,$2,$3,$4,$5,$6,$7,$8,$9::text[],$10,$11,$12,$13,$14) AS id',
    [mhp,binding,meta,name,'en_GB','MARKETING',status,format,names,body,body+'\n\nMartin Howard Property',digest(meta+body),true,null]);
  const claim=async()=>{
   const token=randomBytes(32);
   const rows=await call(1,'SELECT * FROM app_private.claim_owner_whatsapp_job($1,$2,$3,60)',[mhp,connection,token]);
   return rows.length?{job:rows[0]!.job_id as string,version:Number(rows[0]!.lease_version),token}:null;
  };
  const load=(c:{job:string;version:number;token:Buffer})=>call(1,'SELECT * FROM app_private.load_owner_whatsapp_job($1,$2,$3,$4)',[mhp,c.job,c.version,c.token]);
  const begin=async(c:{job:string;version:number;token:Buffer})=>(await call(1,'SELECT app_private.begin_owner_whatsapp_call($1,$2,$3,$4,true,false) AS r',
   [mhp,c.job,c.version,c.token]))[0]!.r;
  const settle=(c:{job:string;version:number;token:Buffer},state:string,wamid:string|null,code:string)=>
   call(1,'SELECT app_private.settle_whatsapp_live_call($1,$2,$3,$4,$5,$6,$7,$8,statement_timestamp())',[mhp,c.job,c.version,c.token,state,wamid,randomBytes(32),code]);
  const sendRow=async(id:string)=>(await ownerQuery<Row>(owner,'SELECT * FROM app_private.mhp_wa_owner_sends WHERE id=$1',[id]))[0]!;
  const activities=(contact:string,ws=pp)=>ownerQuery<Row>(owner,`SELECT activity_type,subject,body,actor_kind,metadata FROM app.activities
   WHERE workspace_id=$1 AND contact_id=$2 AND activity_type LIKE 'whatsapp.mhp_sender.%' ORDER BY created_at,id`,[ws,contact]);

  // --- Link: a PP contact's CRM number is mirrored into MHP; the PP record is untouched and the number is NOT verified.
  await expectPostgresError(link(ppContact,ppPoint,null,outsider),'42501');
  const linked=await link(ppContact,ppPoint,null);
  assert.equal(linked.state,'linked'); assert.equal(linked.mirrorCreated,true); assert.equal(linked.number,'+44 ••• 0123');
  assert.equal((await link(ppContact,ppPoint,null)).linkId,linked.linkId,'linking is idempotent');
  const mirror=await ownerQuery<Row>(owner,`SELECT c.source,p.kind,p.normalized_value,p.is_verified,p.consent_status FROM app.contacts c
   JOIN app.contact_points p ON p.contact_id=c.id WHERE c.workspace_id=$1 AND c.id=$2`,[mhp,linked.mhpContactId]);
  assert.deepEqual(mirror,[{source:'mhp:owner-one-to-one:pp',kind:'whatsapp',normalized_value:'447700900123',is_verified:false,consent_status:'unknown'}]);
  assert.equal((await link(ppContact,null,'not a number')).reason,'number_not_international');
  let view=await state();
  assert.equal(view.numbers[0].verification,'unverified'); assert.equal(view.numbers[0].permission,'none');
  assert.equal(view.numbers[0].gate.reason,'number_unverified'); assert.equal(view.dailyCap.limit,20); assert.equal(view.candidates[0].linked,true);

  // --- Templates: only the worker's Meta read counts; variables are checked against the real placeholders.
  const meta='1234567890123';
  assert.equal((await preview(meta,{})).reason,'template_not_approved');
  await expectPostgresError(observe(meta,'intro_v1','NAMED',['first_name'],'Hi {{first_name}}, {{area}} works'),'22023');
  await observe(meta,'intro_v1','NAMED',['first_name','area'],'Hi {{first_name}}, Martin here about {{area}}.');
  const templates=await one(0,'SELECT app_private.mhp_wa_owner_templates_list() AS r');
  assert.equal(templates.templates.length,1); assert.deepEqual(templates.templates[0].parameterNames,['first_name','area']);
  assert.equal((await preview(meta,{first_name:'Avery'})).reason,'variables_invalid');
  assert.equal((await preview(meta,{first_name:'Avery',area:'Leeds\nnew line'})).reason,'variables_invalid');
  assert.equal((await preview(meta,{first_name:'{{1}}',area:'Leeds'})).reason,'variables_invalid');
  const shown=await preview(meta,{first_name:'Avery',area:'Leeds'});
  assert.equal(shown.text,'Hi Avery, Martin here about Leeds.\n\nMartin Howard Property');
  const send1=randomUUID();
  assert.equal((await queue(linked.linkId,send1,meta,{first_name:'Avery',area:'Leeds'},shown.sha256)).reason,'number_unverified');

  // --- Permission (0063 rail) with the owner-attested number state; never flips is_verified.
  assert.equal((await permission(linked.linkId,randomUUID(),'granted','legitimate_interests','written_consent','Met at the Leeds event',true)).reason,'basis_not_allowed');
  assert.equal((await permission(linked.linkId,randomUUID(),'granted','legitimate_interests','business_introduction','Introduced by a mutual client',false)).reason,'number_unverified');
  const grantKey=randomUUID();
  const granted=await permission(linked.linkId,grantKey,'granted','legitimate_interests','business_introduction','Introduced by a mutual client',true);
  assert.equal(granted.state,'granted'); assert.equal(granted.verification,'owner_attested');
  assert.equal((await permission(linked.linkId,grantKey,'granted','legitimate_interests','business_introduction','Introduced by a mutual client',true)).disposition,'replayed');
  await expectPostgresError(permission(linked.linkId,grantKey,'granted','legitimate_interests','business_introduction','A different note entirely',true),'23505');
  assert.equal((await ownerQuery<Row>(owner,'SELECT is_verified FROM app.contact_points WHERE workspace_id=$1 AND contact_id=$2',[mhp,linked.mhpContactId]))[0]!.is_verified,false);
  assert.equal((await permission(linked.linkId,randomUUID(),'granted','consent','written_consent','Signed form',true,second)).reason,'link_not_found');

  // --- Send: preview must match exactly; the key sends once; a different payload under the same key is a conflict.
  assert.equal((await queue(linked.linkId,send1,meta,{first_name:'Avery',area:'Leeds'},'0'.repeat(64))).reason,'preview_changed');
  const queued=await queue(linked.linkId,send1,meta,{first_name:'Avery',area:'Leeds'},shown.sha256);
  assert.equal(queued.state,'queued'); assert.equal(queued.dailyRemaining,19);
  const replay=await queue(linked.linkId,send1,meta,{first_name:'Avery',area:'Leeds'},shown.sha256);
  assert.equal(replay.replayed,true); assert.equal(replay.state,'queued');
  const other=await preview(meta,{first_name:'Avery',area:'York'});
  assert.equal((await queue(linked.linkId,send1,meta,{first_name:'Avery',area:'York'},other.sha256)).state,'conflict');
  assert.equal((await queue(linked.linkId,randomUUID(),meta,{first_name:'Avery',area:'York'},other.sha256)).reason,'recipient_recently_messaged');
  const authority=await ownerQuery<Row>(owner,`SELECT a.authority_kind,a.purpose,a.consent_event_id IS NOT NULL AS consent,j.state,j.authority_kind AS job_kind
   FROM app.property_predator_whatsapp_live_authorities a JOIN app.property_predator_whatsapp_live_jobs j ON j.authority_id=a.id WHERE a.owner_send_id=$1`,[send1]);
  assert.deepEqual(authority,[{authority_kind:'mhp_owner_direct',purpose:'mhp.owner-one-to-one',consent:true,state:'queued',job_kind:'mhp_owner_direct'}]);
  const routes=await ownerQuery<Row>(owner,`SELECT d.decision_kind,d.route_classification FROM app_private.affiliate_compliance_specialist_decision_events d
   JOIN app.property_predator_whatsapp_live_authorities a ON a.compliance_subject_id=d.subject_id WHERE a.owner_send_id=$1 ORDER BY 1`,[send1]);
  assert.deepEqual(routes,[{decision_kind:'pecr_instigator_route',route_classification:'corporate_subscriber_reg23'},
   {decision_kind:'pecr_sender_route',route_classification:'corporate_subscriber_reg23'}]);

  // --- Worker: claim, load (variables travel with the job), begin, settle accepted with Meta's wamid.
  const legacy=await call(1,'SELECT * FROM app_private.claim_event_whatsapp_job($1,$2,$3,60)',[mhp,connection,randomBytes(32)]);
  assert.deepEqual(legacy,[],'the event rail never claims an owner job');
  const [c1,c2]=await Promise.all([claim(),claim()]);
  assert.ok((c1===null)!==(c2===null),'exactly one worker claims');
  const c=(c1??c2)!;
  const material=(await load(c))[0]!;
  assert.equal(material.recipient,'447700900123'); assert.equal(material.template_name,'intro_v1'); assert.equal(material.eligible,true);
  assert.deepEqual(material.parameters,[{name:'first_name',value:'Avery'},{name:'area',value:'Leeds'}]);
  assert.equal((await begin(c)).begun,true);
  assert.equal((await sendRow(send1)).state,'calling');
  await settle(c,'accepted','wamid.owner121accepted','meta_whatsapp_accepted');
  let row=await sendRow(send1);
  assert.equal(row.state,'accepted'); assert.equal(row.provider_message_id,'wamid.owner121accepted');
  const status=(wamid:string,kind:string,recipient='447700900123')=>call(2,'SELECT app_private.record_whatsapp_live_status($1,$2,$3,$4,$5,$6,$7,statement_timestamp()) AS r',
   [mhp,binding,`status:${wamid}:${kind}`,wamid,digest(recipient),kind,randomBytes(32)]);
  await status('wamid.owner121accepted','sent'); await status('wamid.owner121accepted','delivered');
  row=await sendRow(send1); assert.equal(row.state,'delivered');
  const ppHistory=await activities(ppContact);
  assert.deepEqual(ppHistory.map(a=>a.activity_type),['whatsapp.mhp_sender.linked','whatsapp.mhp_sender.permission_granted','whatsapp.mhp_sender.queued',
   'whatsapp.mhp_sender.accepted','whatsapp.mhp_sender.sent','whatsapp.mhp_sender.delivered']);
  assert.equal(ppHistory[2]!.body,'Hi Avery, Martin here about Leeds.\n\nMartin Howard Property');
  assert.equal(ppHistory[3]!.metadata.providerMessageId,'wamid.owner121accepted'); assert.equal(ppHistory[3]!.actor_kind,'worker');
  assert.equal(ppHistory[5]!.actor_kind,'webhook');
  assert.equal((await activities(linked.mhpContactId,mhp)).length,6,'the MHP mirror carries the same history');
  view=await state();
  assert.equal(view.sends[0].state,'delivered'); assert.deepEqual(view.sends[0].receipts.map((r:Row)=>r.event),['accepted','sent','delivered']);
  assert.equal(view.dailyCap.used,1);

  // --- A provider restriction (131048 spam rate limit) is recorded as failed and pauses the whole sender.
  const link2=(await link(second,secondPoint,null)).linkId;
  await permission(link2,randomUUID(),'granted','consent','written_consent','Signed the enquiry form',true,second);
  const shown2=await preview(meta,{first_name:'Blake',area:'Hull'});
  const send2=randomUUID();
  assert.equal((await queue(link2,send2,meta,{first_name:'Blake',area:'Hull'},shown2.sha256,second)).state,'queued');
  const c3=(await claim())!; assert.equal((await begin(c3)).begun,true);
  await settle(c3,'failed',null,'meta_error:131048');
  row=await sendRow(send2); assert.equal(row.state,'failed'); assert.equal(row.error_code,131048); assert.equal(row.provider_message_id,null);
  const blocked=await queue(link2,randomUUID(),meta,{first_name:'Blake',area:'Hull'},shown2.sha256,second);
  assert.equal(blocked.reason,'account_restricted'); assert.equal(blocked.hold.reason,'spam_rate_limit');
  assert.equal((await state(second)).accountHold.errorCode,131048);
  // Let the hold lapse (test-only ageing of append-only rows by the table owner).
  await ownerQuery(owner,'ALTER TABLE app_private.mhp_wa_owner_holds DISABLE TRIGGER mhp_wa_owner_holds_immutable');
  await ownerQuery(owner,"UPDATE app_private.mhp_wa_owner_holds SET recorded_at=recorded_at-interval '3 days',held_until=recorded_at-interval '2 days'");
  await ownerQuery(owner,'ALTER TABLE app_private.mhp_wa_owner_holds ENABLE TRIGGER mhp_wa_owner_holds_immutable');

  // --- A withdrawal after queueing stops the send at begin-call; nothing reaches Meta and the history says why.
  const send3=randomUUID();
  await ownerQuery(owner,'ALTER TABLE app_private.mhp_wa_owner_sends DISABLE TRIGGER mhp_wa_owner_send_guard');
  await ownerQuery(owner,"UPDATE app_private.mhp_wa_owner_sends SET created_at=created_at-interval '2 days' WHERE id=$1",[send1]);
  await ownerQuery(owner,'ALTER TABLE app_private.mhp_wa_owner_sends ENABLE TRIGGER mhp_wa_owner_send_guard');
  assert.equal((await queue(linked.linkId,send3,meta,{first_name:'Avery',area:'York'},other.sha256)).state,'queued');
  const withdrawn=await permission(linked.linkId,randomUUID(),'withdrawn',null,null,null,false);
  assert.equal(withdrawn.state,'withdrawn'); assert.equal(withdrawn.verification,'unverified');
  const c4=(await claim())!;
  assert.equal((await load(c4))[0]!.eligible,false);
  const refused=await begin(c4);
  assert.equal(refused.begun,false); assert.equal(refused.reason,'number_unverified');
  row=await sendRow(send3); assert.equal(row.state,'blocked'); assert.equal(row.provider_message_id,null);
  assert.equal((await activities(ppContact)).at(-1)!.activity_type,'whatsapp.mhp_sender.blocked');
  assert.equal((await queue(linked.linkId,randomUUID(),meta,{first_name:'Avery',area:'York'},other.sha256)).reason,'number_unverified');

  // --- Free text only inside the 24-hour window, through the 0143 reply queue, with the outcome on the PP contact.
  const text=(send:string,body:string,contact=second,l=link2)=>one(0,'SELECT app_private.mhp_wa_owner_queue_text($1,$2,$3,$4,$5) AS r',[pp,contact,send,l,body]);
  assert.equal((await text(randomUUID(),'Thanks for your message')).reason,'window_closed');
  const payload=randomBytes(32),signature=randomBytes(32),id='wamid.'+randomUUID(),ext='whatsapp-message:'+id,from='447700900124',body='Hello Martin';
  const identity=digest([ext,id,digest(from).toString('hex'),digest(body).toString('hex'),payload.toString('hex'),signature.toString('hex')].join('\x1f'));
  await call(2,'SELECT * FROM app_private.record_whatsapp_live_inbound_projection($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
   [mhp,binding,ext,id,from,body,digest(from),digest(body),payload,signature,identity,new Date(Date.now()-2000)]);
  view=await state(second);
  assert.equal(view.numbers[0].window.open,true);
  const reply=randomUUID();
  assert.equal((await text(reply,'Thanks, I will call you at 3pm')).state,'queued');
  assert.equal((await text(reply,'Thanks, I will call you at 3pm')).replayed,true);
  assert.equal((await text(reply,'A different reply')).state,'conflict');
  const begun=await call(1,'SELECT reply_id,recipient,body FROM app_private.mhp_wa_direct_begin($1,$2,$3)',[mhp,binding,connection]);
  assert.deepEqual(begun,[{reply_id:reply,recipient:from,body:'Thanks, I will call you at 3pm'}]);
  await call(1,"SELECT app_private.mhp_wa_direct_finish($1,$2,$3,'accepted','wamid.owner121reply')",[mhp,binding,reply]);
  await status('wamid.owner121reply','read',from);
  row=await sendRow(reply); assert.equal(row.state,'read'); assert.equal(row.provider_message_id,'wamid.owner121reply');
  const secondHistory=(await activities(second)).map(a=>a.activity_type);
  assert.deepEqual(secondHistory.slice(-3),['whatsapp.mhp_sender.queued','whatsapp.mhp_sender.accepted','whatsapp.mhp_sender.read']);

  // --- A signed failed status with Meta's error code pauses that recipient (131049 marketing limit).
  const fail=await call(2,'SELECT app_private.mhp_wa_owner_status_error($1,$2,$3,$4,131049) AS r',[mhp,binding,'wamid.owner121reply',digest(from)]);
  assert.equal(fail[0]!.r,'applied');
  assert.equal((await ownerQuery<Row>(owner,"SELECT reason FROM app_private.mhp_wa_owner_holds WHERE error_code=131049"))[0]!.reason,'marketing_limit');
  assert.equal((await text(randomUUID(),'Another reply')).reason,'recipient_paused');

  // --- Roles stay closed: the worker cannot queue, the web command cannot claim, nobody reads the tables directly.
  await expectPostgresError(call(1,'SELECT app_private.mhp_wa_owner_templates_list()'),'42501');
  await expectPostgresError(call(0,'SELECT * FROM app_private.claim_owner_whatsapp_job($1,$2,$3,60)',[mhp,connection,randomBytes(32)]),'42501');
  await expectPostgresError(call(0,'SELECT * FROM app_private.mhp_wa_owner_sends'),'42501');
  await expectPostgresError(call(0,'SELECT app_private.mhp_wa_owner_templates_list() AS r',[],outsider),'42501');
 } finally {
  await Promise.all(pools.map(p=>p.end()));
  try {for(const role of roles) await owner.query('ALTER ROLE '+role+' PASSWORD NULL');} finally {await owner.end();}
 }
});

test('Growth HQ signed boundary: a KP contact gets a Martin Howard Property WhatsApp end to end under real login roles',
 {skip:testDatabaseSkipReason(), timeout:180000}, async()=>{
 const {GroupHqInboxCrmService,InboxCrmError,createInboxCrmRunner}=await import('../../src/integrations/group-hq-crm/inbox.js');
 const owner=await openTestDatabase();
 const pools:Pool[]=[];
 const kpOrg='0b152000-0000-4000-8000-000000000001', kp='0b152000-0000-4000-8000-000000000002', mhpOrg='ba41b1a4-9752-4dbf-8312-d04a0f03d0b8';
 const any='0b152000-0000-4000-8000-0000000000ff';
 try {
  await resetIdentityTables(owner);
  await ownerQuery(owner,'TRUNCATE app_private.mhp_prospects CASCADE');
  await ownerQuery(owner,'TRUNCATE app_private.mhp_unlinked_opt_events');
  await ownerQuery(owner,await readFile(new URL('./mhp-event-whatsapp.fixture.sql',import.meta.url),'utf8'));
  await ownerQuery(owner,`DO $s$ BEGIN
   INSERT INTO app.organizations(id,name,slug,kind) VALUES('${kpOrg}','Synthetic KP','synthetic-kp-121','direct_customer');
   INSERT INTO app.workspaces(id,organization_id,name,slug) VALUES('${kp}','${kpOrg}','KP brand','kp-brand-121');
   INSERT INTO app.organization_memberships(organization_id,user_id,role,status) VALUES('${kpOrg}','${ownerId}','owner','active');
   INSERT INTO app.workspace_memberships(workspace_id,organization_id,user_id,role,status) VALUES('${kp}','${kpOrg}','${ownerId}','owner','active');
  END $s$`);
  const contact=randomUUID(), point=randomUUID();
  await ownerQuery(owner,`INSERT INTO app.contacts(id,workspace_id,display_name) VALUES($1,$2,'Casey Example')`,[contact,kp]);
  await ownerQuery(owner,`INSERT INTO app.contact_points(id,workspace_id,contact_id,kind,value,normalized_value) VALUES($1,$2,$3,'whatsapp','+447700900125','+447700900125')`,[point,kp,contact]);
  const login=async(role:string)=>{
   const password=randomUUID();
   const change=await owner.query("SELECT format('ALTER ROLE %I PASSWORD %L',$1::text,$2::text) AS sql",[role,password]);
   await owner.query(change.rows[0].sql);
   const url=new URL(process.env.TEST_DATABASE_URL!);url.username=role;url.password=password;
   const pool=new Pool({connectionString:url.toString(),max:3});pools.push(pool);return pool;
  };
  const web=await login('r72_web'), crm=await login('r72_crm_command'), worker=await login('r72_whatsapp_live_worker_command');
  const email='owner@example.test';
  const scope=(workspaceId:string,organizationId:string,label:string)=>({label,workspaceId,organizationId,ownerUserId:ownerId,pipelineId:any,stageId:any,actorEmails:[email]});
  const service=(enabled:boolean,scopes:Record<string,ReturnType<typeof scope>>={kp:scope(kp,kpOrg,'Key Properties'),mhp:scope(mhp,mhpOrg,'MHP')})=>
   new GroupHqInboxCrmService(web,createInboxCrmRunner(crm),{secret:'x'.repeat(40),scopes,...(enabled?{mhpWhatsappOwnerSends:true}:{})});
  const ghq=service(true);
  const run=(action:string,extra:Record<string,unknown>={},svc=ghq)=>svc.execute({actorEmail:email,brand:'kp',requestId:randomUUID(),action,contactId:contact,...extra}) as Promise<Row>;
  await assert.rejects(run('whatsappOwnerState',{},service(false)),e=>e instanceof InboxCrmError&&e.code==='owner_send_unavailable');
  await assert.rejects(run('whatsappOwnerState',{},service(true,{kp:scope(kp,kpOrg,'Key Properties')})),e=>e instanceof InboxCrmError&&e.status===403);
  let view=(await run('whatsappOwnerState')).result;
  assert.equal(view.sender.connected,true); assert.equal(view.candidates[0].number,'+44 ••• 0125'); assert.deepEqual(view.numbers,[]);
  const linked=(await run('whatsappOwnerLink',{pointId:point})).result;
  assert.equal(linked.state,'linked');
  // The worker's Meta read is the only template evidence (a positional template here).
  const client=await worker.connect();
  try {
   await client.query('BEGIN');
   await client.query("SELECT set_config('app.workspace_id',$1,true),set_config('app.actor_kind','worker',true),set_config('app.request_id','ghq-121-observe',true)",[mhp]);
   await client.query('SELECT app_private.record_mhp_wa_owner_template($1,$2,$3,$4,$5,$6,$7,$8,$9::text[],$10,$11,$12,$13,$14)',
    [mhp,binding,'2234567890123','viewing_follow_up','en_GB','UTILITY','APPROVED','POSITIONAL',['1','2'],'Hi {{1}}, thanks for viewing {{2}}.','Hi {{1}}, thanks for viewing {{2}}.',digest('c'),true,null]);
   await client.query('COMMIT');
  } finally { client.release(); }
  const templates=(await run('whatsappOwnerTemplates')).result.templates;
  assert.equal(templates.length,1); assert.equal(templates[0].parameterFormat,'POSITIONAL');
  const preview=(await run('whatsappOwnerPreview',{metaTemplateId:'2234567890123',variables:['Casey','12 Example Street']})).result;
  assert.equal(preview.text,'Hi Casey, thanks for viewing 12 Example Street.');
  const send={linkId:linked.linkId,metaTemplateId:'2234567890123',variables:['Casey','12 Example Street'],previewSha256:preview.sha256};
  const refused=(await run('whatsappOwnerSendTemplate',{...send,idempotencyKey:randomUUID()})).result;
  assert.equal(refused.state,'refused'); assert.equal(refused.reason,'number_unverified'); assert.match(refused.message,/not been confirmed/u);
  const granted=(await run('whatsappOwnerPermission',{linkId:linked.linkId,commandId:randomUUID(),decision:'granted',lawfulBasis:'consent',
   evidenceKind:'asked_to_be_contacted',note:'Asked me to WhatsApp the viewing details',attestNumber:true})).result;
  assert.equal(granted.verification,'owner_attested');
  const key=randomUUID();
  const queued=(await run('whatsappOwnerSendTemplate',{...send,idempotencyKey:key})).result;
  assert.equal(queued.state,'queued'); assert.equal(queued.stateLabel,'Queued — waiting for the sender');
  // A double submit is the same send; nothing new is queued.
  const [a,b]=await Promise.all([run('whatsappOwnerSendTemplate',{...send,idempotencyKey:key}),run('whatsappOwnerSendTemplate',{...send,idempotencyKey:key})]);
  assert.equal(a.result.replayed,true); assert.equal(b.result.replayed,true);
  assert.equal((await ownerQuery<Row>(owner,'SELECT count(*)::int AS n FROM app.property_predator_whatsapp_live_jobs WHERE owner_send_id=$1',[key]))[0]!.n,1);
  await assert.rejects(run('whatsappOwnerSendTemplate',{...send,variables:['Casey','Another Street'],idempotencyKey:key}),
   e=>e instanceof InboxCrmError&&e.code==='request_conflict');
  const status=(await run('whatsappOwnerStatus',{sendId:key})).result;
  assert.equal(status.state,'queued'); assert.equal(status.originContactId,contact);
  view=(await run('whatsappOwnerState')).result;
  assert.equal(view.numbers[0].verification,'owner_attested'); assert.equal(view.sends[0].sendId,key); assert.equal(view.dailyCap.remaining,19);
  assert.equal((await run('whatsappOwnerSendText',{linkId:linked.linkId,idempotencyKey:randomUUID(),body:'Free text'})).result.reason,'window_closed');
  await assert.rejects(run('whatsappOwnerSendTemplate',{...send,idempotencyKey:'not-a-key'}),e=>e instanceof InboxCrmError&&e.status===400);
  const history=await ownerQuery<Row>(owner,"SELECT activity_type FROM app.activities WHERE workspace_id=$1 AND contact_id=$2 ORDER BY created_at,id",[kp,contact]);
  assert.deepEqual(history.map(h=>h.activity_type),['whatsapp.mhp_sender.linked','whatsapp.mhp_sender.permission_granted','whatsapp.mhp_sender.queued']);
 } finally {
  await Promise.all(pools.map(p=>p.end()));
  try {for(const role of ['r72_web','r72_crm_command','r72_whatsapp_live_worker_command']) await owner.query('ALTER ROLE '+role+' PASSWORD NULL');} finally {await owner.end();}
 }
});
