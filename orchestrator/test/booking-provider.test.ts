import test from 'node:test';
import assert from 'node:assert/strict';
import {OAuthCalendarTransport} from '../src/booking/provider.js';
import {CALENDAR_OAUTH_SCOPES,MAIL_OAUTH_SCOPES,hasCalendarAccess,mailAuthorizationUrl} from '../src/investor-mail/oauth.js';
import type {OAuthMailbox} from '../src/investor-mail/contracts.js';
const credentials:OAuthMailbox={provider:'google',address:'host@example.invalid',displayName:'Host',accessToken:'FAKE-token',refreshToken:'FAKE-refresh',expiresAt:Date.now()+3_600_000,grantedScopes:CALENDAR_OAUTH_SCOPES.google.split(' ')};
const event={bookingId:'71000000-0000-4000-8000-000000000001',title:'Income Path Call',description:'Requested meeting',location:'https://example.invalid/meeting',start:'2026-11-05T10:00:00.000Z',end:'2026-11-05T10:20:00.000Z',attendee:{name:'Visitor',email:'visitor@example.invalid'}};
const reply=(value:unknown)=>new Response(JSON.stringify(value),{status:200});
test('existing mail-only grant never claims calendar access',()=>{
 assert.equal(hasCalendarAccess({...credentials,grantedScopes:MAIL_OAUTH_SCOPES.google.split(' ')}),false);
 assert.throws(()=>new OAuthCalendarTransport({...credentials,grantedScopes:undefined}));
 const cfg={redirectUri:'https://example.invalid/portal/investors/mail/callback',google:{clientId:'fake-client',clientSecret:'fake-secret'}};
 const mail=new URL(mailAuthorizationUrl(cfg,'google','state','a'.repeat(43))),calendar=new URL(mailAuthorizationUrl(cfg,'google','state','a'.repeat(43),'calendar'));
 assert.equal(mail.searchParams.get('scope'),MAIL_OAUTH_SCOPES.google);assert.ok(calendar.searchParams.get('scope')?.includes(CALENDAR_OAUTH_SCOPES.google));assert.ok(calendar.searchParams.get('code_challenge'));
 assert.ok(!calendar.searchParams.get('scope')?.includes('gmail.'));assert.ok(calendar.searchParams.get('scope')?.includes('openid email'));
});
test('Google busy query returns ranges only and errors fail closed',async()=>{
 const adapter=new OAuthCalendarTransport(credentials,(async(url,init)=>{
  assert.equal(String(url),'https://www.googleapis.com/calendar/v3/freeBusy');assert.deepEqual(JSON.parse(String(init?.body)).items,[{id:'primary'}]);
  return reply({calendars:{primary:{busy:[{start:event.start,end:event.end}],privateSubject:'not exposed'}}});
 }) as typeof fetch);
 assert.deepEqual(await adapter.busy(event.start,event.end),[{start:event.start,end:event.end}]);
 const broken=new OAuthCalendarTransport(credentials,(async()=>reply({calendars:{primary:{errors:[{reason:'forbidden'}],busy:[]}}})) as typeof fetch);
 await assert.rejects(()=>broken.busy(event.start,event.end));
});
test('Microsoft expands recurring events, skips free/cancelled and follows only trusted pages',async()=>{
 let count=0;
 const adapter=new OAuthCalendarTransport({...credentials,provider:'microsoft',grantedScopes:['Calendars.ReadWrite']},(async()=>{
  count++;return reply({value:[{showAs:'free'},{isCancelled:true},{showAs:'busy',start:{dateTime:'2026-11-05T10:00:00.0000000',timeZone:'UTC'},end:{dateTime:'2026-11-05T10:20:00.0000000',timeZone:'UTC'}}]});
 }) as typeof fetch);
 assert.deepEqual(await adapter.busy(event.start,event.end),[{start:event.start,end:event.end}]);assert.equal(count,1);
 count=0;const unsafe=new OAuthCalendarTransport({...credentials,provider:'microsoft',grantedScopes:['Calendars.ReadWrite']},(async()=>{count++;return reply({value:[],'@odata.nextLink':'https://attacker.invalid/steal'});}) as typeof fetch);
 await assert.rejects(()=>unsafe.busy(event.start,event.end));assert.equal(count,1);
});
test('Google event ID and Microsoft transactionId remain tied to the booking',async()=>{
 const googleId='ghq'+event.bookingId.replaceAll('-','');
 const google=new OAuthCalendarTransport(credentials,(async(url,init)=>{const body=JSON.parse(String(init?.body));assert.equal(body.id,googleId);assert.equal(body.attendees[0].email,event.attendee.email);assert.match(String(url),/sendUpdates=all/);return reply({id:googleId});}) as typeof fetch);
 assert.deepEqual(await google.create(event),{providerId:googleId});
 const ms=new OAuthCalendarTransport({...credentials,provider:'microsoft',grantedScopes:['Calendars.ReadWrite']},(async(url,init)=>{assert.equal(String(url),'https://graph.microsoft.com/v1.0/me/events');assert.equal(JSON.parse(String(init?.body)).transactionId,event.bookingId);return reply({id:'graph-id'});}) as typeof fetch);
 assert.deepEqual(await ms.create(event),{providerId:'graph-id'});
});
test('uncertain event creation is not automatically retried and cannot leak the provider error',async()=>{
 let calls=0;const adapter=new OAuthCalendarTransport(credentials,(async()=>{calls++;throw new Error('private provider detail FAKE-token');}) as typeof fetch);
 await assert.rejects(()=>adapter.create(event),e=>e instanceof Error&&!e.message.includes('FAKE-token')&&e.message.includes('pending'));assert.equal(calls,1);
 assert.ok(!JSON.stringify(adapter).includes('FAKE-token'));
});
