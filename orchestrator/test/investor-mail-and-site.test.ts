import test from 'node:test';
import assert from 'node:assert/strict';
import { InvestorMailVault } from '../src/investor-mail/vault.js';
import { publicMailIp,validateCustomMailbox } from '../src/investor-mail/custom-mailbox.js';
import { OAuthMailboxTransport } from '../src/investor-mail/oauth-mailbox.js';
import type { CustomMailbox,ApprovedInvestorMail,OAuthMailbox } from '../src/investor-mail/contracts.js';
import { siteFormToken,validSiteFormToken,investorSitePage } from '../src/portal/investor-site.js';
const smtp:CustomMailbox={provider:'smtp',address:'hello@example.invalid',username:'hello@example.invalid',displayName:'Test Business',smtpHost:'smtp.example.invalid',smtpPort:465,imapHost:'imap.example.invalid',imapPort:993,password:'fake-test-password'};
const mail:ApprovedInvestorMail={messageId:'<iv-71000000-0000-4000-8000-000000000001@example.invalid>',to:'investor@example.invalid',subject:'Your next step',text:'Only the reviewed message.'};
const oauth:OAuthMailbox={provider:'google',address:'hello@example.invalid',displayName:'Test Business',accessToken:'fake-test-token',refreshToken:'fake-refresh',expiresAt:Date.now()+3600_000};
test('mail credentials are encrypted, authenticated and bound to one workspace',()=>{
 const vault=new InvestorMailVault(Buffer.alloc(32,7)),sealed=vault.seal('workspace-one',smtp);
 assert.ok(!sealed.includes(smtp.password));assert.deepEqual(vault.open('workspace-one',sealed),smtp);
 assert.throws(()=>vault.open('workspace-two',sealed));
 const bytes=Buffer.from(sealed,'base64');bytes[bytes.length-1]=bytes[bytes.length-1]!^1;
 assert.throws(()=>vault.open('workspace-one',bytes.toString('base64')));
 assert.ok(!JSON.stringify(vault).includes(smtp.password));
});
test('custom mailbox rejects private/reserved destinations and spoofed sender logins',()=>{
 for(const ip of ['127.0.0.1','10.0.0.1','172.16.0.1','192.168.1.1','169.254.169.254','100.64.0.1','198.18.0.1','203.0.113.1','224.0.0.1','::1'])assert.equal(publicMailIp(ip),false,ip);
 assert.equal(publicMailIp('8.8.8.8'),true);
 assert.throws(()=>validateCustomMailbox({...smtp,username:'someoneelse@example.invalid'}));
 assert.throws(()=>validateCustomMailbox({...smtp,displayName:'Business\r\nBcc:bad@example.invalid'}));
});
test('Google send preserves exact recipient/body and reports acceptance only',async()=>{
 const calls:{url:string;init:RequestInit|undefined}[]=[];
 const transport=new OAuthMailboxTransport(oauth,(async(url,init)=>{calls.push({url:String(url),init});return new Response('{"id":"accepted-id"}',{status:200});}) as typeof fetch);
 const result=await transport.send(mail);assert.deepEqual(result,{state:'accepted',providerId:'accepted-id'});assert.equal(calls.length,1);
 const payload=JSON.parse(String(calls[0]!.init?.body));const mime=Buffer.from(payload.raw,'base64url').toString();
 assert.match(mime,/To: investor@example.invalid/);assert.match(mime,/Only the reviewed message/);assert.ok(!mime.includes('Property Predator'));
});
test('Microsoft uses MIME and never labels 202 as delivery',async()=>{
 const transport=new OAuthMailboxTransport({...oauth,provider:'microsoft'},(async(url,init)=>{
  assert.equal(String(url),'https://graph.microsoft.com/v1.0/me/sendMail');assert.match(Buffer.from(String(init?.body),'base64').toString(),/Your next step/);
  return new Response(null,{status:202});
 }) as typeof fetch);
 assert.deepEqual(await transport.send(mail),{state:'accepted',providerId:null});
});
test('unknown send result is not retried and raw provider errors are suppressed',async()=>{
 let count=0;const transport=new OAuthMailboxTransport(oauth,(async()=>{count++;throw new Error('secret provider token');}) as typeof fetch);
 await assert.rejects(()=>transport.send(mail),(e:unknown)=>e instanceof Error&&e.message==='Email outcome unknown.');assert.equal(count,1);
});
test('header injection and expired authorisation never call an email provider',async()=>{
 let count=0;const request=(async()=>{count++;return new Response();}) as typeof fetch;
 await assert.rejects(()=>new OAuthMailboxTransport(oauth,request).send({...mail,subject:'Hello\nBcc:x@y.invalid'}));
 await assert.rejects(()=>new OAuthMailboxTransport({...oauth,expiresAt:0},request).send(mail));assert.equal(count,0);
});
test('Microsoft pagination cannot send OAuth credentials to another host',async()=>{
 let count=0;const transport=new OAuthMailboxTransport({...oauth,provider:'microsoft'},(async()=>{count++;return new Response();}) as typeof fetch);
 await assert.rejects(()=>transport.read(JSON.stringify({since:1,started:2,page:'https://attacker.invalid/steal'})));assert.equal(count,0);
});
test('website form tokens expire and cannot move to another business',()=>{
 const now=Date.now(),token=siteFormToken('secret','northstar',now);
 assert.equal(validSiteFormToken('secret','northstar',token,now+1000),true);
 assert.equal(validSiteFormToken('secret','harbour',token,now+1000),false);
 assert.equal(validSiteFormToken('secret','northstar',token,now+3600_000),false);
});
test('website preview is branded, escaped and cannot submit an enquiry',()=>{
 const html=investorSitePage({slug:'northstar',brandName:'Northstar <script>bad()</script>',headline:'Your property plans',introduction:'Actual supplied words',locations:'Manchester',contactEmail:'hello@example.invalid',privacyUrl:'https://example.invalid/privacy',accentColor:'#4361d8'},'',true);
 assert.ok(!html.includes('<script>bad()</script>'));assert.match(html,/Northstar &lt;script&gt;/);assert.match(html,/<button class="button" disabled>/);
 assert.ok(!html.includes('Property Predator'));assert.match(html,/noindex,nofollow/);
});
