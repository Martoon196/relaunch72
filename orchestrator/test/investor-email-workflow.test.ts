import test from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { InvestorMailService } from '../src/portal/investor-mail-service.js';
import { InvestorMailVault } from '../src/investor-mail/vault.js';
import type { CustomMailbox,InvestorMailboxTransport,ApprovedInvestorMail } from '../src/investor-mail/contracts.js';
const ws='71000000-0000-4000-8000-000000000001',mid='71000000-0000-4000-8000-000000000002';
const identity={sessionToken:'synthetic-session',requestId:'test-email'};
const credentials:CustomMailbox={provider:'smtp',address:'hello@example.invalid',displayName:'Northstar',username:'hello@example.invalid',smtpHost:'smtp.example.invalid',smtpPort:465,imapHost:'imap.example.invalid',imapPort:993,password:'fake-test-only'};
const approved:ApprovedInvestorMail={messageId:`<iv-${mid}@example.invalid>`,to:'investor@example.invalid',subject:'Exact reviewed subject',text:'Exact reviewed body'};
const form={messageId:mid,version:'3',bodyHash:'a'.repeat(64),confirmation:'send_approved_message'};
function harness(options:{enabled?:boolean;claimFails?:boolean;sendFails?:boolean;settleFails?:boolean;senderName?:string}={}) {
 const vault=new InvestorMailVault(Buffer.alloc(32,8)),calls:{sql:string;args:unknown[]}[]=[],sent:ApprovedInvestorMail[]=[],senderNames:string[]=[];
 const mailbox={...credentials,displayName:options.senderName??credentials.displayName};
 const pool={query:async(sql:string,args:unknown[])=>{
  calls.push({sql,args});
  if(sql.includes('investor_mail_secret'))return {rows:[{account:{workspaceId:ws,version:4,sealed:vault.seal(ws,mailbox),address:credentials.address,status:'verified',cursor:'old-cursor'}}]};
  if(sql.includes('claim_investor_email')){if(options.claimFails)throw new Error('approval missing');return {rows:[{claim:{...approved,operationId:mid,accountVersion:4,address:credentials.address}}]};}
  if(sql.includes('settle_investor_email')&&options.settleFails)throw new Error('database unavailable');
  if(sql.includes('import_investor_email_page'))return {rows:[{result:{imported:1,unmatched:2,duplicates:3}}]};
  return {rows:[]};
 }} as unknown as Pool;
 const transport:InvestorMailboxTransport={verify:async()=>({address:credentials.address}),send:async(m)=>{sent.push(m);if(options.sendFails)throw new Error('secret provider detail');return {state:'accepted',providerId:'fixture-accepted'};},read:async(cursor)=>{assert.equal(cursor,'old-cursor');return {messages:[],cursor:'new-cursor',skipped:2};}};
 return {service:new InvestorMailService(pool,pool,vault,undefined,options.enabled??true,(c)=>{senderNames.push(c.displayName);return transport;}),calls,sent,senderNames};
}
test('one review action saves and approves MHP draft without dispatch',async()=>{
 const calls:string[]=[];
 const pool={query:async(sql:string)=>{
  calls.push(sql);
  if(sql.includes('draft_investor_email'))return {rows:[{id:mid}]};
  if(sql.includes('investor_email_snapshot'))return {rows:[{snapshot:{selected:{id:mid,version:2,reviewHash:'b'.repeat(64),lifecycle:'draft'},contacts:[],messages:[]}}]};
  return {rows:[{}]};
 }} as unknown as Pool;
 const service=new InvestorMailService(pool,pool,undefined,undefined,false);
 await assert.rejects(()=>service.readyToSend(identity,{confirmation:'',commandKey:mid,contactPointId:mid,subject:'Test',body:'Body'}),/Check the recipient/);
 assert.equal(calls.length,0);
 assert.equal(await service.readyToSend(identity,{confirmation:'review_exact_message',commandKey:mid,contactPointId:mid,subject:'Test',body:'Body'}),mid);
 assert.deepEqual(calls.map(sql=>sql.match(/app_private\.([a-z_]+)/)?.[1]),['draft_investor_email','investor_email_snapshot','approve_investor_email']);
});
test('installation delivery switch blocks before database claim or provider access',async()=>{
 const h=harness({enabled:false});await assert.rejects(()=>h.service.send(identity,form),/not been enabled/);assert.equal(h.calls.length,0);assert.equal(h.sent.length,0);
});
test('review records approval only and never claims or sends a message',async()=>{
 const h=harness();await h.service.approve(identity,{messageId:mid,version:'1',reviewHash:'b'.repeat(64),confirmation:'approve_exact_message'});
 assert.equal(h.calls.length,1);assert.match(h.calls[0]!.sql,/approve_investor_email/);assert.equal(h.sent.length,0);
});
test('send needs a separate confirmation, and failed approval claim cannot reach transport',async()=>{
 const h=harness({claimFails:true});await assert.rejects(()=>h.service.send(identity,{...form,confirmation:'approve_exact_message'}));assert.equal(h.calls.length,0);
 await assert.rejects(()=>h.service.send(identity,form));assert.equal(h.sent.length,0);
});
test('provider gets canonical approved content, never browser replacements',async()=>{
 const h=harness();assert.equal(await h.service.send(identity,{...form,subject:'Injected subject',body:'Injected body',to:'attacker@example.invalid'}),'accepted');
 assert.equal(h.sent.length,1);assert.equal(h.sent[0]!.text,approved.text);assert.equal(h.sent[0]!.to,approved.to);assert.equal(h.sent[0]!.subject,approved.subject);
 const settle=h.calls.find(c=>c.sql.includes('settle_investor_email'))!;assert.equal(settle.args[3],true);assert.equal(settle.args[4],'fixture-accepted');
});
test('sender strips the workspace label from the email display name',async()=>{
 const h=harness({senderName:'Martin Howard · Your Desk'});
 assert.equal(await h.service.send(identity,form),'accepted');assert.deepEqual(h.senderNames,['Martin Howard']);
});
test('uncertain send settles unknown once, without retrying or exposing provider details',async()=>{
 const h=harness({sendFails:true});assert.equal(await h.service.send(identity,form),'unknown');assert.equal(h.sent.length,1);
 assert.equal(h.calls.filter(c=>c.sql.includes('claim_investor_email')).length,1);assert.equal(h.calls.at(-1)!.args[3],false);
});
test('accepted provider call with failed receipt never claims confirmed delivery',async()=>{
 const h=harness({settleFails:true});await assert.rejects(()=>h.service.send(identity,form),/provider accepted.*receipt was not confirmed/);assert.equal(h.sent.length,1);
});
test('sync commits the mailbox version, previous cursor and bounded page together',async()=>{
 const h=harness();assert.deepEqual(await h.service.sync(identity),{imported:1,unmatched:2,duplicates:3,skipped:2});
 const args=h.calls.at(-1)!.args;assert.deepEqual(args.slice(1),[4,'old-cursor','new-cursor','[]']);assert.equal(h.sent.length,0);
});
test('connection verification does not send email',async()=>{
 const h=harness();await h.service.verify(identity);assert.equal(h.sent.length,0);assert.match(h.calls.at(-1)!.sql,/verify_investor_mail_connection/);
});
