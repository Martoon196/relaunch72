import test from 'node:test';
import assert from 'node:assert/strict';
import { createMhpMarketingSender, mhpMarketingConfig, renderMhpMarketingEmail, startMhpMarketingDispatcher } from '../src/mhp/marketing-mail.js';
import { dispatchMhpOwnerEmails, PgMhpOwnerEmailDispatch, type MhpOwnerEmailDispatch, type MhpOwnerEmailPrepared } from '../src/mhp/owner-email-dispatch.js';
import { ids,now,exact } from './helpers/mhp-owner-email-fixture.js';

const secret='synthetic-unsubscribe-secret-at-least-32-characters';
const lease={id:ids.send,leaseId:ids.lease,leaseUntil:new Date(now+120_000).toISOString()};
const prepared:MhpOwnerEmailPrepared={...lease,proofId:ids.proof,prospectId:ids.prospect,email:'consented@example.invalid',firstName:'Sam',
  context:{label:'Webinar',link:'https://martinhowardproperty.co.uk/webinar/'},exact:{...exact,approvalDecisionId:ids.approval}};
function fixture(change:Partial<MhpOwnerEmailPrepared>|null={}){
  const calls:string[]=[],settled:unknown[]=[];let sent:any;
  const queue:MhpOwnerEmailDispatch={claim:async(limit,seconds,emails)=>{calls.push('claim');assert.equal(limit,25);assert.equal(seconds,120);assert.deepEqual(emails,['consented@example.invalid']);return[lease];},
    prepare:async value=>{calls.push('prepare');assert.deepEqual(value,lease);return change===null?null:{...prepared,...change};},
    settle:async(...args)=>{calls.push('settle');settled.push(args);}};
  const sender={sendRendered:async(value:unknown)=>{calls.push('provider');sent=value;return'synthetic-reference';}};
  return{queue,sender,calls,settled,get sent(){return sent;}};
}
test('owner dispatch rechecks exact lease immediately before existing transport, keeps pinned copy and real opt-out',async()=>{
  const f=fixture();assert.deepEqual(await dispatchMhpOwnerEmails({queue:f.queue,sender:f.sender,unsubscribeSecret:secret,testRecipients:['consented@example.invalid'],now:()=>now}),{sent:1,failed:0});
  assert.deepEqual(f.calls,['claim','prepare','provider','settle']);assert.equal(f.sent.tag,'owner_followup');assert.match(f.sent.rendered.text,/£500 café/);
  assert.match(f.sent.rendered.unsubscribe,/email\/unsubscribe\?p=/);assert.deepEqual(f.settled,[[lease,true,'synthetic-reference']]);
});
test('missing proof, expiring lease, altered content or branding never reaches provider or legacy renderer',async()=>{
  for(const change of [null,{leaseUntil:new Date(now+10_000).toISOString()},{exact:{...prepared.exact,contentSha256:'0'.repeat(64)}},{exact:{...prepared.exact,brand:{}}}]){
    const f=fixture(change);assert.deepEqual(await dispatchMhpOwnerEmails({queue:f.queue,sender:f.sender,unsubscribeSecret:secret,testRecipients:['consented@example.invalid'],now:()=>now}),{sent:0,failed:1});
    assert.equal(f.calls.includes('provider'),false);assert.deepEqual(f.settled,[[lease,false,null]]);
  }
});
test('PG dispatch capability rejects mismatched returned lease/proof and makes no direct table calls',async()=>{
  let value:unknown=[lease];const calls:{sql:string;args:unknown[]}[]=[];
  const queue=new PgMhpOwnerEmailDispatch({query:async(sql:string,args:unknown[])=>{calls.push({sql,args});return{rows:[{jobs:value,prepared:value}]};}} as any);
  assert.deepEqual(await queue.claim(25,120,null),[lease]);value={...prepared,leaseId:ids.request};await assert.rejects(queue.prepare(lease),/pinned owner email proof/);
  value=prepared;assert.equal((await queue.prepare(lease))?.proofId,ids.proof);assert.ok(calls.every(call=>call.sql.startsWith('SELECT app_private.mhp_')));
});
test('shared transport retains legacy payload and test list; owner test omits an audience unsubscribe token',async()=>{
  const config=mhpMarketingConfig({MHP_MARKETING_MODE:'test',MHP_POSTMARK_SERVER_TOKEN:'synthetic-secret',MHP_MARKETING_FROM:'owner@example.invalid',MHP_MARKETING_TEST_TO:'owner@example.invalid'})!;
  const sent:any[]=[];const sender=createMhpMarketingSender(config,secret,async(url,init)=>{assert.equal(url,'https://api.postmarkapp.com/email');assert.equal(init?.redirect,'error');sent.push(JSON.parse(String(init?.body)));return new Response(JSON.stringify({MessageID:'synthetic-reference',ErrorCode:0}),{status:200});});
  const legacy={id:ids.send,prospectId:ids.prospect,email:'owner@example.invalid',firstName:'Sam',level:null,attempts:1,expiresAt:new Date(now+86400_000).toISOString(),template:'webinar_confirm',campaign:'webinar-proof',context:{label:'Webinar',link:'https://martinhowardproperty.co.uk/webinar/'}};
  await sender.send(legacy);const rendered=renderMhpMarketingEmail(legacy,secret);assert.equal(sent[0].Subject,rendered.subject);assert.equal(sent[0].TextBody,rendered.text);assert.equal(sent[0].HtmlBody,rendered.html);assert.equal(sent[0].Headers.length,2);
  await sender.sendRendered({id:ids.request,email:'owner@example.invalid',tag:'owner_email_test',rendered,ownerTest:true});assert.deepEqual(sent[1].Headers,[]);
  await assert.rejects(sender.sendRendered({id:ids.send,email:'other@example.invalid',tag:'owner_followup',rendered}),/outside the test list/);assert.equal(sent.length,2);
});
test('existing dispatcher interval completes legacy sweep then owner sweep without a second timer or owner fallback',async()=>{
  const calls:string[]=[];let finish!:()=>void;const done=new Promise<void>(resolve=>{finish=resolve;});
  const stop=startMhpMarketingDispatcher({claim:async()=>{calls.push('legacy-claim');return[];},settle:async()=>{throw Error('no legacy sends');}},
    {send:async()=>{throw Error('no legacy sends');}},{testRecipients:null},{intervalMs:60_000,
      owner:{unsubscribeSecret:secret,queue:{claim:async()=>{calls.push('owner-claim');finish();return[];},prepare:async()=>null,settle:async()=>{}},sender:{sendRendered:async()=>{throw Error('no owner sends');}}}});
  await done;stop();assert.deepEqual(calls,['legacy-claim','owner-claim']);
});
