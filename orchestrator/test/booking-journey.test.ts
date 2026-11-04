import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {BookingService,defaultMeetingType,founderSchedule,type BookingReceipt} from '../src/booking/service.js';
import {normalisePerson,validatePerson,instant} from '../src/booking/contracts.js';
import {localInstant,scheduleForm,handlePublicBooking,handleOwnerBooking} from '../src/booking/router.js';
import {bookingIcs} from '../src/booking/ics.js';
import {ownerCalendar,publicSlots} from '../src/booking/view.js';
import {InvestorMailVault} from '../src/investor-mail/vault.js';
import {CALENDAR_OAUTH_SCOPES} from '../src/investor-mail/oauth.js';
import {InvestorMailService} from '../src/portal/investor-mail-service.js';
const type=defaultMeetingType(),person={name:'Visitor',email:'visitor@example.invalid',answers:{goal:'Find my next step'}};
const slot={start:'2026-11-05T10:00:00.000Z',end:'2026-11-05T10:20:00.000Z'},identity={sessionToken:'a'.repeat(43),requestId:'booking-test'};
const token='b'.repeat(43),id='71000000-0000-4000-8000-000000000001';
test('founder hours include Tuesday and Thursday evenings only',()=>{
 assert.deepEqual(founderSchedule().windows,[{day:1,start:600,end:960},{day:2,start:600,end:1260},{day:3,start:600,end:960},{day:4,start:600,end:1260},{day:5,start:600,end:960}]);
 const s=scheduleForm({timeZone:'Europe/London',start_2_0:'10:00',end_2_0:'21:00',overrides:'2026-12-25 closed\n2026-12-24 10:00-13:00,18:00-21:00'});assert.deepEqual(s.overrides[1]?.windows,[{start:600,end:780},{start:1080,end:1260}]);
 assert.throws(()=>scheduleForm({start_2_0:'10:00',end_2_0:'',timeZone:'Europe/London'}));
});
test('local meeting entry resolves actual London offsets and rejects ambiguous/gap times',()=>{
 assert.equal(localInstant('2026-11-05T20:40','Europe/London'),'2026-11-05T20:40:00.000Z');
 assert.equal(localInstant('2027-07-01T20:40','Europe/London'),'2027-07-01T19:40:00.000Z');
 assert.throws(()=>localInstant('2027-03-28T01:30','Europe/London'));assert.throws(()=>localInstant('2027-10-31T01:30','Europe/London'));assert.throws(()=>instant('2026-02-30T10:00:00Z'));
});
test('canonical replay preserves omitted optional answers',()=>{
 const input={name:' Visitor ',email:'VISITOR@example.invalid',answers:{}};assert.deepEqual(validatePerson(input,type),normalisePerson(input));
});
test('calendar OAuth stores a purpose-bound credential without replacing or verifying the working mailbox',async(t)=>{
 const vault=new InvestorMailVault(Buffer.alloc(32,3)),commands:{sql:string;values:unknown[]}[]=[],verifier='v'.repeat(43);
 const read={query:async()=>({rows:[{user_id:id,selected_workspace_id:id}]})},command={query:async(sql:string,values:unknown[])=>{
  commands.push({sql,values});return {rows:[{attempt:{provider:'google',sealed:vault.sealValue(id,{verifier,purpose:'calendar',calendarVersion:1},'oauth'),version:99}}]};}};
 t.mock.method(globalThis,'fetch',async(url:unknown)=>{
  if(String(url)==='https://oauth2.googleapis.com/token')return new Response(JSON.stringify({access_token:'fake',refresh_token:'fake',expires_in:3600,scope:CALENDAR_OAUTH_SCOPES.google}));
  assert.equal(String(url),'https://openidconnect.googleapis.com/v1/userinfo');return new Response(JSON.stringify({email:'calendar-only@example.invalid'}));
 });
 const mail=new InvestorMailService(read as never,command as never,vault,{redirectUri:'https://example.invalid/callback',google:{clientId:'fake',clientSecret:'fake'}});
 const result=await mail.finishOAuth(identity,'s'.repeat(43),'fake-code','Host');assert.equal(result.purpose,'calendar');
 assert.equal(commands.length,1);assert.ok(commands[0]!.sql.includes('consume_investor_oauth'));assert.ok(commands.every(c=>!c.sql.includes('save_investor_mail_connection')&&!c.sql.includes('verify_investor_mail_connection')));
 if(result.purpose==='calendar'){
  let sealed='';const calendar=new BookingService({query:async()=>({rows:[{value:{workspaceId:id}}]})} as never,{query:async(_sql:string,values:unknown[])=>{sealed=String(values[4]);assert.equal(values[3],'calendar-only@example.invalid');return {rows:[]};}} as never,vault,undefined,mail,true);
  await calendar.finishConnection(identity,result.credentials,result.version);assert.throws(()=>vault.open(id,sealed));assert.deepEqual(vault.openValue(id,sealed,'calendar'),result.credentials);
 }
});
test('identical reservation retry returns receipt without provider or availability calls',async()=>{
 const command={query:async()=>({rows:[{value:{id,state:'confirmed'}}]})},read={query:async()=>{throw Error('Retry must not recheck its own busy slot');}};
 const service=new BookingService(read as never,command as never,undefined,undefined,{} as never,true);
 assert.deepEqual(await service.reserve(type.slug,slot.start,person,id,token),{id,state:'confirmed'});
});
test('an uncertain provider create settles unknown and keeps a stable booking identity',async()=>{
 const vault=new InvestorMailVault(Buffer.alloc(32,1)),workspace=id,creds={provider:'google' as const,address:'host@example.invalid',displayName:'Host',accessToken:'fake',refreshToken:'fake',expiresAt:Date.now()+3600000,grantedScopes:CALENDAR_OAUTH_SCOPES.google.split(' ')};
 const statements:{sql:string;values:unknown[]}[]=[],adapter={busy:async()=>[],create:async()=>{throw Error('Timeout after request');},cancel:async()=>{},move:async()=>{}};
 const read={query:async()=>({rows:[{value:{calendarVersion:1,type:{...type,published:true,noticeMinutes:0},schedule:founderSchedule(),busy:[]}}]})};
 const command={query:async(sql:string,values:unknown[])=>{statements.push({sql,values});if(sql.includes('booking_calendar_secret'))return {rows:[{value:{workspaceId:workspace,version:1,sealed:vault.sealValue(workspace,creds,'calendar'),address:creds.address}}]};if(sql.includes('booking_replay'))return {rows:[{value:null}]};if(sql.includes('booking_hold'))return {rows:[{value:{id,state:'reserved',created:true}}]};return {rows:[]};}};
 const service=new BookingService(read as never,command as never,vault,{redirectUri:'https://example.invalid/callback'},{} as never,false,()=>adapter);
 // A future eligible date is chosen independently of the current day.
 let next=new Date(Date.now()+86400000);while(next.getUTCDay()!==2)next=new Date(next.getTime()+86400000);const start=next.toISOString().slice(0,10)+'T10:00:00.000Z';
 const result=await service.reserve(type.slug,start,person,id,token);assert.equal(result.state,'unknown');
 assert.ok(statements.some(s=>s.sql.includes('booking_settle')&&s.values[3]===false));assert.equal(statements.filter(s=>s.sql.includes('booking_hold')).length,1);
});
test('known external conflict does not put an appointment into a pending change',async()=>{
 const vault=new InvestorMailVault(Buffer.alloc(32,2)),creds={provider:'google' as const,address:'host@example.invalid',displayName:'Host',accessToken:'fake',refreshToken:'fake',expiresAt:Date.now()+3600000,grantedScopes:CALENDAR_OAUTH_SCOPES.google.split(' ')};let begin=false;
 const command={query:async(sql:string)=>{if(sql.includes('booking_appointment_context'))return {rows:[{value:{state:'confirmed',start:'2026-11-05T09:00:00+00:00',type}}]};if(sql.includes('booking_calendar_secret'))return {rows:[{value:{workspaceId:id,version:1,address:creds.address,sealed:vault.sealValue(id,creds,'calendar')}}]};begin=true;return {rows:[]};}};
 const service=new BookingService({} as never,command as never,vault,{redirectUri:'https://example.invalid'},{} as never,true,()=>({busy:async()=>[slot],create:async()=>({providerId:'x'}),cancel:async()=>{},move:async()=>{}}));
 await assert.rejects(()=>service.change({slug:type.slug,id,identity,action:'move',start:slot.start,version:'1'}));assert.equal(begin,false);
});
test('owner calendar forms share existing fields and display publishable links without scripts',()=>{
 const snapshot={workspaceId:id,calendar:{version:1,schedule:founderSchedule(),hostId:id,connected:true},types:[{...type,published:true,archived:false}],meetings:[]};
 const html=ownerCalendar(snapshot,'csrf','https://example.invalid',new URLSearchParams('view=types'));
 assert.ok(html.includes('https://example.invalid/book/'+type.slug));assert.ok(html.includes('&lt;iframe'));assert.ok(html.includes('class="iv-field"'));assert.ok(!html.includes('<script'));
 const page=publicSlots({type,schedule:founderSchedule(),calendarVersion:1,busy:[],brandName:'A < B',accentColor:'#E8A33D',connected:true},'2026-11-05',[slot],'signed',slot.start);
 assert.ok(page.includes('A &lt; B'));assert.ok(page.includes('answer_goal'));assert.ok(page.includes('This does not subscribe you to marketing.'));
});
test('ICS folds UTF-8 safely and escapes attempted property injection',()=>{
 const r:BookingReceipt={id,...slot,state:'confirmed',person,type:{...type,title:'Call\r\nATTENDEE:someone',description:'😀'.repeat(100)},version:1,brandName:'Brand'};
 const data=bookingIcs(r);assert.ok(data.includes('SUMMARY:Call\\nATTENDEE:someone'));assert.equal(data.split('\r\n').filter(l=>l.startsWith('ATTENDEE:')).length,0);assert.ok(data.split('\r\n').every(l=>Buffer.byteLength(l)<=75));
});
test('owner mutation requires existing session CSRF before commands',async()=>{
 let called=false;await assert.rejects(()=>handleOwnerBooking({service:{setup:async()=>{called=true;}} as never,identity,url:new URL('https://example.invalid/portal/calendar/setup'),method:'POST',csrf:'valid',origin:'https://example.invalid',readForm:async()=>({_csrf:'wrong'}),verify:()=>false,render:()=>{},redirect:()=>{}}));assert.equal(called,false);
});
test('public GET loads safely; duplicate POST fields are rejected before reserving',async()=>{
 let calls=0;const service={publicPage:async()=>({page:{type,schedule:founderSchedule(),brandName:'Brand'},slots:[slot]}),reserve:async()=>{calls++;}};
 const server=createServer((req,res)=>{void handlePublicBooking(req,res,service as never,'test-signing-secret');});await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{const addr=server.address() as {port:number},url=`http://127.0.0.1:${addr.port}/book/${type.slug}`;const get=await fetch(url+'?date=2026-11-05');assert.equal(get.status,200);assert.equal(get.headers.get('referrer-policy'),'no-referrer');assert.equal(get.headers.get('cache-control'),'no-store');await get.text();
 const post=await fetch(url,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:'name=One&name=Two'});assert.equal(post.status,400);assert.equal(calls,0);await post.text();
 }finally{await new Promise<void>((resolve,reject)=>server.close(err=>err?reject(err):resolve()));}
});
