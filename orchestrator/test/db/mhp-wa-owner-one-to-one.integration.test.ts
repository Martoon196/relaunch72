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

// Shared rig: the MHP fixture, a second brand (Property Predator) the same owner manages with two CRM contacts,
// the three real login roles and one helper per database entry point.
async function rig(owner:Pool,pools:Pool[]) {
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
 const state=(contact:string=ppContact)=>one(0,'SELECT app_private.mhp_wa_owner_contact_state($1,$2) AS r',[pp,contact]);
 const permission=(l:string,command:string,decision:string,basis:string|null,kind:string|null,note:string|null,attest:boolean,contact:string=ppContact)=>
  one(0,'SELECT app_private.mhp_wa_owner_set_permission($1,$2,$3,$4,$5,$6,$7,$8,$9) AS r',[pp,contact,l,command,decision,basis,kind,note,attest]);
 const queue=(l:string,send:string,meta:string,vars:unknown,sha:string,contact:string=ppContact)=>
  one(0,'SELECT app_private.mhp_wa_owner_queue_template($1,$2,$3,$4,$5,$6::jsonb,decode($7,\'hex\')) AS r',[pp,contact,send,l,meta,JSON.stringify(vars),sha]);
 const preview=(meta:string,vars:unknown)=>one(0,'SELECT app_private.mhp_wa_owner_preview($1,$2::jsonb) AS r',[meta,JSON.stringify(vars)]);
 // `footer` stands for everything Meta returns beside the body (header, footer, buttons): it changes the preview and the components hash.
 const observe=(meta:string,name:string,format:string,names:string[],body:string,status='APPROVED',footer='Martin Howard Property')=>
  call(1,'SELECT app_private.record_mhp_wa_owner_template($1,$2,$3,$4,$5,$6,$7,$8,$9::text[],$10,$11,$12,$13,$14) AS id',
   [mhp,binding,meta,name,'en_GB','MARKETING',status,format,names,body,body+'\n\n'+footer,digest(meta+body+(footer==='Martin Howard Property'?'':footer)),true,null]);
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
 return {ppContact,ppPoint,second,secondPoint,call,one,link,state,permission,queue,preview,observe,claim,load,begin,settle,sendRow,activities};
}

test('MHP owner one-to-one WhatsApp: cross-brand link, owner attestation, template variables, idempotent send, receipts, holds and withdrawal',
 {skip:testDatabaseSkipReason(), timeout:180000}, async()=>{
 const owner=await openTestDatabase();
 const pools:Pool[]=[];
 try {
  const {ppContact,ppPoint,second,secondPoint,call,one,link,state,permission,queue,preview,observe,claim,load,begin,settle,sendRow,activities}=await rig(owner,pools);

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
  // The 0053 template row is this rail's own reserved row: the real name/language stays free for a webinar programme.
  assert.deepEqual(await ownerQuery<Row>(owner,'SELECT provider_template_name,language_code,parameter_count FROM app.property_predator_whatsapp_live_templates WHERE workspace_id=$1',[mhp]),
   [{provider_template_name:'mhp_owner_121__'+meta,language_code:'en_GB',parameter_count:0}]);

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
  const service=(enabled:boolean,scopes:Record<string,ReturnType<typeof scope>>={kp:scope(kp,kpOrg,'Key Properties'),mhp:scope(mhp,mhpOrg,'MHP')},manualReplies=false)=>
   new GroupHqInboxCrmService(web,createInboxCrmRunner(crm),{secret:'x'.repeat(40),scopes,...(enabled?{mhpWhatsappOwnerSends:true}:{}),...(manualReplies?{mhpWhatsappManualReplies:true}:{})});
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
  // Free text obeys the existing manual-replies switch exactly as the inbox reply does; with it on, the 24-hour window still applies.
  await assert.rejects(run('whatsappOwnerSendText',{linkId:linked.linkId,idempotencyKey:randomUUID(),body:'Free text'}),e=>e instanceof InboxCrmError&&e.status===409&&e.code==='reply_unavailable');
  assert.equal((await ownerQuery<Row>(owner,'SELECT count(*)::int AS n FROM app_private.mhp_wa_direct_replies'))[0]!.n,0);
  assert.equal((await run('whatsappOwnerSendText',{linkId:linked.linkId,idempotencyKey:randomUUID(),body:'Free text'},service(true,undefined,true))).result.reason,'window_closed');
  await assert.rejects(run('whatsappOwnerSendTemplate',{...send,idempotencyKey:'not-a-key'}),e=>e instanceof InboxCrmError&&e.status===400);
  const history=await ownerQuery<Row>(owner,"SELECT activity_type FROM app.activities WHERE workspace_id=$1 AND contact_id=$2 ORDER BY created_at,id",[kp,contact]);
  assert.deepEqual(history.map(h=>h.activity_type),['whatsapp.mhp_sender.linked','whatsapp.mhp_sender.permission_granted','whatsapp.mhp_sender.queued']);
 } finally {
  await Promise.all(pools.map(p=>p.end()));
  try {for(const role of ['r72_web','r72_crm_command','r72_whatsapp_live_worker_command']) await owner.query('ALTER ROLE '+role+' PASSWORD NULL');} finally {await owner.end();}
 }
});

test('MHP owner one-to-one WhatsApp safeguards: original-brand opt-out at link, queue and begin; number forms and STOP; unchanged-template refresh; exact previewed message; expiry without a worker',
 {skip:testDatabaseSkipReason(), timeout:180000}, async()=>{
 const owner=await openTestDatabase();
 const pools:Pool[]=[];
 try {
  const {ppContact,ppPoint,second,secondPoint,call,one,link,state,permission,queue,preview,observe,claim,load,begin,settle,sendRow,activities}=await rig(owner,pools);
  const meta='1234567890123';
  await observe(meta,'intro_v1','NAMED',['first_name','area'],'Hi {{first_name}}, Martin here about {{area}}.');
  const vars=(n:string)=>({first_name:n,area:'Leeds'});
  const grant=(l:string,contact:string)=>permission(l,randomUUID(),'granted','consent','written_consent','Signed the enquiry form',true,contact);
  const person=async(name:string,points:[string,string,string,string?][])=>{
   const id=randomUUID();
   await ownerQuery(owner,`INSERT INTO app.contacts(id,workspace_id,display_name) VALUES($1,$2,$3)`,[id,pp,name]);
   const ids:string[]=[];
   for(const [kind,value,normalized,consent] of points){const point=randomUUID();ids.push(point);
    await ownerQuery(owner,`INSERT INTO app.contact_points(id,workspace_id,contact_id,kind,value,normalized_value,consent_status) VALUES($1,$2,$3,$4,$5,$6,$7)`,[point,pp,id,kind,value,normalized,consent??'unknown']);}
   return {id,points:ids};
  };
  const suppress=(contact:string,point:string,channel:string,state='suppressed')=>ownerQuery(owner,`INSERT INTO app.communication_suppression_events
   (workspace_id,contact_id,contact_point_id,channel,purpose,state,reason,source,source_event_id,actor_kind,endpoint_identity_sha256,occurred_at)
   VALUES($1,$2,$3,$4,NULL,$5,'stop','synthetic.review',$6,'system',$7,clock_timestamp())`,[pp,contact,point,channel,state,'suppression:'+randomUUID(),digest('synthetic')]);
  const inboundStop=async(from:string,body:string)=>{const payload=randomBytes(32),signature=randomBytes(32),id='wamid.'+randomUUID().replace(/-/g,''),ext='whatsapp-message:'+id;
   const identity=digest([ext,id,digest(from).toString('hex'),digest(body).toString('hex'),payload.toString('hex'),signature.toString('hex')].join('\x1f'));
   return (await call(2,'SELECT * FROM app_private.mhp_record_event_whatsapp_inbound($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
    [mhp,binding,ext,id,from,body,digest(from),digest(body),payload,signature,identity,new Date(Date.now()-2000)]))[0]!.disposition;};

  // --- Number forms: the optional trunk zero is dropped; a UK number that still carries it is refused, never stored.
  const forms=await ownerQuery<Row>(owner,`SELECT v,app_private.mhp_wa_owner_number(v) AS n FROM unnest($1::text[]) WITH ORDINALITY x(v,o) ORDER BY o`,
   [['+44 (0)7700 900126','0044 (0) 7700 900126','+44 7700 900126','07700 900126','+4407700900126','+44 07700 900126','004407700900126','+1 (415) 555-0100','7700900126']]);
  assert.deepEqual(forms.map(f=>f.n),['447700900126','447700900126','447700900126','447700900126',null,null,null,'14155550100',null]);
  const dana=await person('Dana Example',[]);
  assert.equal((await link(dana.id,null,'+4407700900126')).reason,'number_not_international');
  const danaLink=await link(dana.id,null,'+44 (0)7700 900126');
  assert.equal(danaLink.state,'linked'); assert.equal(danaLink.number,'+44 ••• 0126');
  assert.deepEqual(await ownerQuery<Row>(owner,`SELECT normalized_value FROM app.contact_points WHERE workspace_id=$1 AND contact_id=$2`,[mhp,danaLink.mhpContactId]),[{normalized_value:'447700900126'}]);
  assert.equal((await ownerQuery<Row>(owner,`SELECT count(*)::int AS n FROM app.contact_points WHERE normalized_value LIKE '4407%'`))[0]!.n,0);
  assert.equal((await grant(danaLink.linkId,dana.id)).state,'granted');
  const danaPreview=await preview(meta,vars('Dana'));
  // A signed STOP from the real number matches the number entered that way: refused at begin-call, and at the next queue.
  const danaSend=randomUUID();
  assert.equal((await queue(danaLink.linkId,danaSend,meta,vars('Dana'),danaPreview.sha256,dana.id)).state,'queued');
  assert.equal(await inboundStop('447700900126','STOP'),'unlinked_stop');
  let c=(await claim())!;
  assert.deepEqual((await load(c)).map(r=>[r.eligible,r.reason]),[[false,'whatsapp_stop']]);
  assert.deepEqual(await begin(c),{begun:false,reason:'whatsapp_stop'});
  assert.equal((await queue(danaLink.linkId,randomUUID(),meta,vars('Dana'),danaPreview.sha256,dana.id)).reason,'whatsapp_stop');

  // --- The original brand's opt-out counts on EVERY point with the number, picked or typed.
  const erin=await person('Erin Example',[['whatsapp','+447700900130','+447700900130','opted_out'],['phone','07700 900131','07700900131','opted_out'],['phone','+447700900132','+447700900132']]);
  assert.equal((await link(erin.id,erin.points[0]!,null)).reason,'opted_out');
  assert.equal((await link(erin.id,null,'+44 7700 900130')).reason,'opted_out','typing an opted-out number is refused like picking it');
  assert.equal((await link(erin.id,null,'+44 (0)7700 900131')).reason,'opted_out','an opted-out phone point in national form still matches');
  // 0153, owner rule: a STOP applies only to its own channel. A current SMS STOP on that number in the original brand
  // no longer blocks a WhatsApp send (it used to, under 0151); see the stop-per-channel test below for queue and begin-call.
  await suppress(erin.id,erin.points[2]!,'sms');
  const erinLink=await link(erin.id,null,'+447700900132');
  assert.equal(erinLink.state,'linked','an SMS STOP does not block WhatsApp');
  await suppress(erin.id,erin.points[2]!,'sms','released');
  assert.equal((await ownerQuery<Row>(owner,`SELECT count(*)::int AS n FROM app_private.mhp_wa_owner_links WHERE origin_contact_id=$1`,[erin.id]))[0]!.n,1);

  // --- An opt-out recorded in the original brand AFTER queueing stops the send at begin-call (typed number, another point).
  await grant(erinLink.linkId,erin.id);
  const erinPreview=await preview(meta,vars('Erin'));
  const erinSend=randomUUID();
  assert.equal((await queue(erinLink.linkId,erinSend,meta,vars('Erin'),erinPreview.sha256,erin.id)).state,'queued');
  await ownerQuery(owner,`UPDATE app.contact_points SET consent_status='opted_out' WHERE id=$1`,[erin.points[2]]);
  c=(await claim())!;
  assert.deepEqual((await load(c)).map(r=>[r.eligible,r.reason]),[[false,'opted_out']]);
  assert.deepEqual(await begin(c),{begun:false,reason:'opted_out'});
  let row=await sendRow(erinSend); assert.equal(row.state,'blocked'); assert.equal(row.state_reason,'opted_out'); assert.equal(row.provider_message_id,null);
  assert.equal((await activities(erin.id)).at(-1)!.activity_type,'whatsapp.mhp_sender.blocked');
  assert.equal((await queue(erinLink.linkId,randomUUID(),meta,vars('Erin'),erinPreview.sha256,erin.id)).reason,'opted_out');
  assert.equal((await state(erin.id)).numbers[0].gate.reason,'opted_out');
  // The same for a WhatsApp suppression recorded on the picked point after queueing, and for a picked point removed later.
  const firstLink=await link(ppContact,ppPoint,null);
  await grant(firstLink.linkId,ppContact);
  const firstPreview=await preview(meta,vars('Avery'));
  const firstSend=randomUUID();
  assert.equal((await queue(firstLink.linkId,firstSend,meta,vars('Avery'),firstPreview.sha256)).state,'queued');
  await suppress(ppContact,ppPoint,'whatsapp');
  c=(await claim())!;
  assert.deepEqual(await begin(c),{begun:false,reason:'opted_out'});
  assert.equal((await sendRow(firstSend)).state,'blocked');
  await suppress(ppContact,ppPoint,'whatsapp','released');
  await ownerQuery(owner,`UPDATE app.contact_points SET deleted_at=clock_timestamp() WHERE id=$1`,[ppPoint]);
  assert.equal((await queue(firstLink.linkId,randomUUID(),meta,vars('Avery'),firstPreview.sha256)).reason,'number_not_found');
  // The worker itself stays table-blind; only the definer's begin-call gate reads the linked original contact's points.
  await expectPostgresError(call(1,'SELECT count(*) FROM app.contact_points WHERE id=$1',[erin.points[2]]),'42501');

  // --- Catalogue: Meta returning exactly the same template refreshes one row; only a change adds one. Content stays immutable.
  const rows=()=>ownerQuery<Row>(owner,`SELECT id,provider_status,first_observed_at,observed_at,expires_at FROM app_private.mhp_wa_owner_templates WHERE meta_template_id=$1 ORDER BY observed_at,id`,[meta]);
  const before=await rows(); assert.equal(before.length,1);
  for(let i=0;i<3;i++) await observe(meta,'intro_v1','NAMED',['first_name','area'],'Hi {{first_name}}, Martin here about {{area}}.');
  const after=await rows();
  assert.equal(after.length,1,'three more identical reads add no row'); assert.equal(after[0]!.id,before[0]!.id);
  assert.ok(after[0]!.observed_at>before[0]!.observed_at); assert.ok(after[0]!.expires_at>before[0]!.expires_at);
  assert.equal(after[0]!.first_observed_at.getTime(),before[0]!.first_observed_at.getTime());
  await expectPostgresError(ownerQuery(owner,`UPDATE app_private.mhp_wa_owner_templates SET body_text='Changed' WHERE id=$1`,[before[0]!.id]),'40001');
  await expectPostgresError(ownerQuery(owner,`UPDATE app_private.mhp_wa_owner_templates SET provider_status='PAUSED' WHERE id=$1`,[before[0]!.id]),'40001');
  await expectPostgresError(ownerQuery(owner,`DELETE FROM app_private.mhp_wa_owner_templates WHERE id=$1`,[before[0]!.id]),'40001');
  await observe(meta,'intro_v1','NAMED',['first_name','area'],'Hi {{first_name}}, Martin here about {{area}}.','PAUSED');
  assert.deepEqual((await rows()).map(r=>r.provider_status),['APPROVED','PAUSED']);
  assert.equal((await preview(meta,vars('Blake'))).reason,'template_not_approved');
  await observe(meta,'intro_v1','NAMED',['first_name','area'],'Hi {{first_name}}, Martin here about {{area}}.');
  assert.deepEqual((await rows()).map(r=>r.provider_status),['APPROVED','PAUSED','APPROVED'],'approved again after a pause is a new read, not a silent refresh of the old row');

  // --- Begin-call binds the WHOLE previewed message: an edited footer with the same body is refused.
  const blakeLink=await link(second,secondPoint,null);
  await grant(blakeLink.linkId,second);
  const blakePreview=await preview(meta,vars('Blake'));
  assert.equal(blakePreview.text,'Hi Blake, Martin here about Leeds.\n\nMartin Howard Property');
  const blakeSend=randomUUID();
  assert.equal((await queue(blakeLink.linkId,blakeSend,meta,vars('Blake'),blakePreview.sha256,second)).state,'queued');
  await observe(meta,'intro_v1','NAMED',['first_name','area'],'Hi {{first_name}}, Martin here about {{area}}.','APPROVED','Reply STOP to opt out. Call 0800 000 0000');
  c=(await claim())!;
  assert.deepEqual((await load(c)).map(r=>[r.eligible,r.reason]),[[false,'preview_changed']]);
  assert.deepEqual(await begin(c),{begun:false,reason:'preview_changed'});
  row=await sendRow(blakeSend); assert.equal(row.state,'blocked'); assert.equal(row.state_reason,'preview_changed');
  // Previewed again against the edited template, the same variables give the new exact text; the old preview is refused.
  const blakeAgain=await preview(meta,vars('Blake'));
  assert.notEqual(blakeAgain.sha256,blakePreview.sha256);
  assert.equal((await queue(blakeLink.linkId,randomUUID(),meta,vars('Blake'),blakePreview.sha256,second)).reason,'preview_changed');

  // --- No worker at all (its owner switch is off): a queued send that can no longer go out reads as expired at once,
  // stops counting, and is recorded as expired (with its activity) by the owner's next queue attempt.
  const stale=randomUUID();
  assert.equal((await queue(blakeLink.linkId,stale,meta,vars('Blake'),blakeAgain.sha256,second)).state,'queued');
  let view=await state(second);
  const usedBefore=view.dailyCap.used;
  assert.equal(view.sends[0].state,'queued');
  assert.equal((await queue(blakeLink.linkId,randomUUID(),meta,vars('Blake'),blakeAgain.sha256,second)).reason,'recipient_recently_messaged');
  const age=async(sql:string,args:unknown[])=>{
   await ownerQuery(owner,'ALTER TABLE app.property_predator_whatsapp_live_authorities DISABLE TRIGGER whatsapp_live_authorities_immutable');
   try {await ownerQuery(owner,sql,args);} finally {await ownerQuery(owner,'ALTER TABLE app.property_predator_whatsapp_live_authorities ENABLE TRIGGER whatsapp_live_authorities_immutable');}
  };
  await age(`UPDATE app.property_predator_whatsapp_live_authorities SET evaluated_at=evaluated_at-interval '1 hour',valid_until=valid_until-interval '1 hour' WHERE owner_send_id=$1`,[stale]);
  view=await state(second);
  assert.equal(view.sends[0].sendId,stale); assert.equal(view.sends[0].state,'expired'); assert.equal(view.sends[0].stateReason,'authority_expired');
  assert.equal(view.dailyCap.used,usedBefore-1,'an expired send no longer counts against the daily limit');
  assert.equal((await one(0,'SELECT app_private.mhp_wa_owner_send_status($1) AS r',[stale])).state,'expired');
  assert.equal((await sendRow(stale)).state,'queued','nothing has written yet: no worker ran');
  const next=randomUUID();
  assert.equal((await queue(blakeLink.linkId,next,meta,vars('Blake'),blakeAgain.sha256,second)).state,'queued','pacing no longer counts the expired send');
  row=await sendRow(stale); assert.equal(row.state,'expired'); assert.equal(row.state_reason,'authority_expired');
  assert.equal((await ownerQuery<Row>(owner,'SELECT state FROM app.property_predator_whatsapp_live_jobs WHERE owner_send_id=$1',[stale]))[0]!.state,'cancelled');
  const blakeHistory=await ownerQuery<Row>(owner,`SELECT activity_type,actor_kind,subject FROM app.activities WHERE workspace_id=$1 AND contact_id=$2 ORDER BY created_at,id`,[pp,second]);
  assert.deepEqual(blakeHistory.slice(-2).map(a=>[a.activity_type,a.actor_kind]),[['whatsapp.mhp_sender.expired','user'],['whatsapp.mhp_sender.queued','user']]);
  assert.match(blakeHistory.at(-2)!.subject,/expired before the sender picked it up/u);
  assert.equal((await queue(blakeLink.linkId,stale,meta,vars('Blake'),blakeAgain.sha256,second)).state,'expired','the same key replays the truthful state and never sends');
  // A call that had begun is never called expired: with no worker it becomes 'outcome unknown' and keeps counting.
  c=(await claim())!; assert.equal((await begin(c)).begun,true);
  assert.equal((await sendRow(next)).state,'calling');
  await ownerQuery(owner,`UPDATE app.property_predator_whatsapp_live_jobs SET lease_expires_at=statement_timestamp()-interval '1 minute' WHERE owner_send_id=$1`,[next]);
  const used=(await state(second)).dailyCap.used;
  assert.equal((await queue(blakeLink.linkId,randomUUID(),meta,vars('Blake'),blakeAgain.sha256,second)).reason,'recipient_recently_messaged');
  row=await sendRow(next); assert.equal(row.state,'outcome_unknown');
  assert.equal((await ownerQuery<Row>(owner,'SELECT state FROM app.property_predator_whatsapp_live_jobs WHERE owner_send_id=$1',[next]))[0]!.state,'needs_attention');
  assert.equal((await state(second)).dailyCap.used,used,'an unconfirmed call still counts');
  await expectPostgresError(settle(c,'accepted','wamid.toolate','meta_whatsapp_accepted'),'40001');
 } finally {
  await Promise.all(pools.map(p=>p.end()));
  try {for(const role of roles) await owner.query('ALTER ROLE '+role+' PASSWORD NULL');} finally {await owner.end();}
 }
});

test('0153 stop per channel: an SMS STOP in the original brand no longer blocks a WhatsApp send; a WhatsApp STOP, an opted-out point and a signed STOP still do',
 {skip:testDatabaseSkipReason(), timeout:180000}, async()=>{
 const owner=await openTestDatabase();
 const pools:Pool[]=[];
 try {
  const {call,link,state,permission,queue,preview,observe,claim,load,begin,settle,sendRow}=await rig(owner,pools);
  const meta='1234567890123';
  await observe(meta,'intro_v1','NAMED',['first_name','area'],'Hi {{first_name}}, Martin here about {{area}}.');
  const vars=(n:string)=>({first_name:n,area:'Leeds'});
  const grant=(l:string,contact:string)=>permission(l,randomUUID(),'granted','consent','written_consent','Signed the enquiry form',true,contact);
  const person=async(name:string,kind:string,value:string,consent='unknown')=>{
   const id=randomUUID(),point=randomUUID();
   await ownerQuery(owner,`INSERT INTO app.contacts(id,workspace_id,display_name) VALUES($1,$2,$3)`,[id,pp,name]);
   await ownerQuery(owner,`INSERT INTO app.contact_points(id,workspace_id,contact_id,kind,value,normalized_value,consent_status) VALUES($1,$2,$3,$4,$5,$5,$6)`,[point,pp,id,kind,value,consent]);
   return {id,point};
  };
  const suppress=(contact:string,point:string,channel:string,state='suppressed')=>ownerQuery(owner,`INSERT INTO app.communication_suppression_events
   (workspace_id,contact_id,contact_point_id,channel,purpose,state,reason,source,source_event_id,actor_kind,endpoint_identity_sha256,occurred_at)
   VALUES($1,$2,$3,$4,NULL,$5,'stop','synthetic.review',$6,'system',$7,clock_timestamp())`,[pp,contact,point,channel,state,'suppression:'+randomUUID(),digest('synthetic')]);

  // The function and the worker's read policy are WhatsApp-only now; the whole-number opt-out stays.
  const fn=(await ownerQuery<Row>(owner,`SELECT pg_get_functiondef('app_private.mhp_wa_owner_origin_blocked(uuid,uuid,uuid,text)'::regprocedure) AS d`))[0]!.d as string;
  assert.match(fn,/s\.channel='whatsapp'/u); assert.doesNotMatch(fn,/'sms'/u); assert.match(fn,/consent_status='opted_out'/u);
  const policy=(await ownerQuery<Row>(owner,`SELECT qual FROM pg_policies WHERE schemaname='app' AND tablename='communication_suppression_events' AND policyname='mhp_wa_owner_origin_suppressions_worker'`))[0]!.qual as string;
  assert.match(policy,/channel = 'whatsapp'::text/u); assert.doesNotMatch(policy,/sms/u);

  // 1. SMS STOP on the phone point (texted STOP to the original brand): the WhatsApp link, queue and begin-call all go ahead.
  const fern=await person('Fern Example','phone','+447700900140');
  await suppress(fern.id,fern.point,'sms');
  const fernLink=await link(fern.id,fern.point,null);
  assert.equal(fernLink.state,'linked','an SMS STOP does not block the WhatsApp link');
  assert.equal((await grant(fernLink.linkId,fern.id)).state,'granted');
  assert.equal((await state(fern.id)).numbers[0].gate.reason??null,null,'the owner view shows no block');
  const fernPreview=await preview(meta,vars('Fern'));
  const fernSend=randomUUID();
  assert.equal((await queue(fernLink.linkId,fernSend,meta,vars('Fern'),fernPreview.sha256,fern.id)).state,'queued','an SMS STOP does not block the queue');
  let c=(await claim())!;
  assert.deepEqual((await load(c)).map(r=>[r.eligible,r.reason??null]),[[true,null]]);
  assert.equal((await begin(c)).begun,true,'an SMS STOP does not block begin-call');
  await settle(c,'accepted','wamid.stoppersms','meta_whatsapp_accepted');
  assert.equal((await sendRow(fernSend)).state,'accepted');
  // The SMS STOP itself is untouched: still the latest SMS fact on that point.
  assert.deepEqual(await ownerQuery<Row>(owner,`SELECT channel,state FROM app.communication_suppression_events WHERE workspace_id=$1 AND contact_point_id=$2 ORDER BY occurred_at`,[pp,fern.point]),
   [{channel:'sms',state:'suppressed'}]);

  // 2. WhatsApp STOP on the original brand's point after queueing: refused at begin-call, at the next queue and at link.
  const gale=await person('Gale Example','whatsapp','+447700900141');
  const galeLink=await link(gale.id,gale.point,null);
  await grant(galeLink.linkId,gale.id);
  const galePreview=await preview(meta,vars('Gale'));
  const galeSend=randomUUID();
  assert.equal((await queue(galeLink.linkId,galeSend,meta,vars('Gale'),galePreview.sha256,gale.id)).state,'queued');
  await suppress(gale.id,gale.point,'whatsapp');
  c=(await claim())!;
  assert.deepEqual((await load(c)).map(r=>[r.eligible,r.reason]),[[false,'opted_out']]);
  assert.deepEqual(await begin(c),{begun:false,reason:'opted_out'},'a WhatsApp STOP still blocks');
  assert.equal((await sendRow(galeSend)).state,'blocked');
  assert.equal((await queue(galeLink.linkId,randomUUID(),meta,vars('Gale'),galePreview.sha256,gale.id)).reason,'opted_out');
  assert.equal((await link(gale.id,gale.point,null)).reason,'opted_out');
  // An SMS STOP AND a WhatsApp STOP: still blocked (the WhatsApp one counts).
  await suppress(gale.id,gale.point,'sms');
  assert.equal((await link(gale.id,null,'+447700900141')).reason,'opted_out');

  // 3. An opted-out point (the whole number said no, whatever the channel) still blocks, picked or typed.
  const hale=await person('Hale Example','phone','+447700900142','opted_out');
  assert.equal((await link(hale.id,hale.point,null)).reason,'opted_out');
  assert.equal((await link(hale.id,null,'+44 7700 900142')).reason,'opted_out');

  // 4. A signed WhatsApp STOP from the number to MHP still blocks, with or without an SMS STOP in the original brand.
  const ivy=await person('Ivy Example','phone','+447700900143');
  const ivyLink=await link(ivy.id,ivy.point,null);
  await grant(ivyLink.linkId,ivy.id);
  const ivyPreview=await preview(meta,vars('Ivy'));
  const payload=randomBytes(32),signature=randomBytes(32),wamid='wamid.'+randomUUID().replace(/-/g,''),ext='whatsapp-message:'+wamid;
  const identity=digest([ext,wamid,digest('447700900143').toString('hex'),digest('STOP').toString('hex'),payload.toString('hex'),signature.toString('hex')].join('\x1f'));
  await call(2,'SELECT * FROM app_private.mhp_record_event_whatsapp_inbound($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
   [mhp,binding,ext,wamid,'447700900143','STOP',digest('447700900143'),digest('STOP'),payload,signature,identity,new Date(Date.now()-2000)]);
  assert.equal((await queue(ivyLink.linkId,randomUUID(),meta,vars('Ivy'),ivyPreview.sha256,ivy.id)).reason,'whatsapp_stop');
 } finally {
  await Promise.all(pools.map(p=>p.end()));
  try {for(const role of roles) await owner.query('ALTER ROLE '+role+' PASSWORD NULL');} finally {await owner.end();}
 }
});
