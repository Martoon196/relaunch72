import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import { simpleParser } from 'mailparser';
import { InvestorMailError,mailboxAddress,validateInvestorMail,type OAuthMailbox,type ApprovedInvestorMail,type InvestorMailboxTransport,type MailReceived } from './contracts.js';

const GMAIL='https://gmail.googleapis.com/gmail/v1/users/me';
const GRAPH='https://graph.microsoft.com/v1.0';
type Json=Record<string,any>;
async function boundedJson(response:Response):Promise<Json> {
  if(!response.ok)throw new InvestorMailError(response.status===401?'reauthorisation_required':'read_failed');
  const reader=response.body?.getReader();if(!reader)throw new InvestorMailError('read_failed');
  const chunks:Uint8Array[]=[];let size=0;
  try {while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>2_000_000)throw new Error();chunks.push(value);}return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Json;}
  catch {await reader.cancel().catch(()=>{});throw new InvestorMailError('read_failed');}
}
interface Cursor { since:number; started:number; page?:string }
function readCursor(raw:string|null):Cursor {
  try {const c=raw?JSON.parse(raw):null;if(c&&Number.isSafeInteger(c.since)&&Number.isSafeInteger(c.started)&&c.since>0&&(!c.page||typeof c.page==='string'&&c.page.length<8000))return c;}
  catch {throw new InvestorMailError('invalid_settings');}
  const now=Math.floor(Date.now()/1000);return {since:now-30*86400,started:now};
}
function nextCursor(c:Cursor,page?:string):string {return JSON.stringify(page?{...c,page}:{since:c.started-60,started:Math.floor(Date.now()/1000)});}

export class OAuthMailboxTransport implements InvestorMailboxTransport {
  constructor(private readonly c:OAuthMailbox,private readonly request:typeof fetch=fetch) {
    if(mailboxAddress(c.address)!==c.address||!c.accessToken||/[\r\n]/.test(c.displayName)||c.displayName.length>100)throw new InvestorMailError('invalid_settings');
  }
  private async get(url:string,headers:Record<string,string>={}) {
    if(this.c.expiresAt<=Date.now()+10_000)throw new InvestorMailError('reauthorisation_required');
    return boundedJson(await this.request(url,{headers:{Authorization:`Bearer ${this.c.accessToken}`,...headers},redirect:'error',signal:AbortSignal.timeout(20_000)}));
  }
  async verify() {
    const p=await this.get(this.c.provider==='google'?`${GMAIL}/profile`:`${GRAPH}/me?$select=mail,userPrincipalName`);
    const address=mailboxAddress(this.c.provider==='google'?p.emailAddress:p.mail||p.userPrincipalName);
    if(address!==this.c.address)throw new InvestorMailError('invalid_settings');
    return {address};
  }
  async send(m:ApprovedInvestorMail) {
    validateInvestorMail(m);
    if(this.c.expiresAt<=Date.now()+30_000)throw new InvestorMailError('reauthorisation_required');
    const bytes=await new MailComposer({from:{name:this.c.displayName,address:this.c.address},to:mailboxAddress(m.to),subject:m.subject,text:m.text,
      messageId:m.messageId,inReplyTo:m.inReplyTo,references:m.references,disableFileAccess:true,disableUrlAccess:true}).compile().build();
    const google=this.c.provider==='google';
    try {
      const response=await this.request(google?`${GMAIL}/messages/send`:`${GRAPH}/me/sendMail`,{method:'POST',redirect:'error',signal:AbortSignal.timeout(20_000),
        headers:{Authorization:`Bearer ${this.c.accessToken}`,'content-type':google?'application/json':'text/plain'},body:google?JSON.stringify({raw:bytes.toString('base64url')}):bytes.toString('base64')});
      if(!response.ok)throw new Error();
      if(google){const result=await boundedJson(response);if(typeof result.id!=='string')throw new Error();return {state:'accepted' as const,providerId:result.id};}
      if(response.status!==202)throw new Error();return {state:'accepted' as const,providerId:null};
    } catch {throw new InvestorMailError('outcome_unknown');}
  }
  async read(raw:string|null) {
    try {return this.c.provider==='google'?await this.readGoogle(readCursor(raw)):await this.readMicrosoft(readCursor(raw));}
    catch(error){if(error instanceof InvestorMailError)throw error;throw new InvestorMailError('read_failed');}
  }
  private async readGoogle(c:Cursor) {
    const query=new URLSearchParams({maxResults:'25',q:`in:inbox after:${c.since}`,...(c.page?{pageToken:c.page}:{})});
    const result=await this.get(`${GMAIL}/messages?${query}`),messages:MailReceived[]=[];let skipped=0;
    for(const item of (Array.isArray(result.messages)?result.messages:[]).slice(0,25)) {
      if(typeof item.id!=='string'||!/^[-\w]{1,200}$/.test(item.id))throw new InvestorMailError('read_failed');
      const m=await this.get(`${GMAIL}/messages/${encodeURIComponent(item.id)}?format=raw`);
      if(typeof m.raw!=='string'||m.raw.length>180_000){skipped++;continue;}
      const parsed=await simpleParser(Buffer.from(m.raw,'base64url'),{skipHtmlToText:true,skipTextToHtml:true,skipImageLinks:true});
      const from=parsed.from?.value[0]?.address;
      if(!from||!parsed.messageId){skipped++;continue;}
      messages.push({providerId:item.id,messageId:parsed.messageId,inReplyTo:parsed.inReplyTo??null,
        references:typeof parsed.references==='string'?[parsed.references]:parsed.references??[],from:mailboxAddress(from),
        to:(Array.isArray(parsed.to)?parsed.to:[parsed.to]).flatMap(a=>a?.value.map(v=>v.address).filter((v):v is string=>Boolean(v))??[]).map(mailboxAddress),
        subject:(parsed.subject??'').slice(0,500),text:(parsed.text||'[This message has no plain-text body.]').slice(0,32_768),receivedAt:new Date(Number(m.internalDate)).toISOString()});
    }
    return {messages,cursor:nextCursor(c,typeof result.nextPageToken==='string'?result.nextPageToken:undefined),skipped};
  }
  private async readMicrosoft(c:Cursor) {
    const query=new URLSearchParams({'$top':'25','$select':'id,internetMessageId,internetMessageHeaders,from,toRecipients,subject,body,receivedDateTime','$orderby':'receivedDateTime asc','$filter':`receivedDateTime ge ${new Date(c.since*1000).toISOString()}`});
    const url=c.page??`${GRAPH}/me/mailFolders/inbox/messages?${query}`;
    const parsed=new URL(url);
    if(parsed.origin!=='https://graph.microsoft.com'||parsed.pathname!=='/v1.0/me/mailFolders/inbox/messages'||parsed.username||parsed.password)throw new InvestorMailError('invalid_settings');
    const data=await this.get(url,{Prefer:'outlook.body-content-type="text", IdType="ImmutableId"'}),messages:MailReceived[]=[];let skipped=0;
    for(const m of (Array.isArray(data.value)?data.value:[]).slice(0,25)) {
      if(typeof m.id!=='string'||typeof m.internetMessageId!=='string'||!m.from?.emailAddress?.address){skipped++;continue;}
      const header=(name:string)=>String((m.internetMessageHeaders??[]).find((h:Json)=>String(h.name).toLowerCase()===name)?.value??'');
      messages.push({providerId:m.id,messageId:m.internetMessageId,inReplyTo:header('in-reply-to')||null,references:header('references').match(/<[^<>\s]+>/g)??[],
        from:mailboxAddress(m.from.emailAddress.address),to:(m.toRecipients??[]).map((r:Json)=>mailboxAddress(r.emailAddress.address)),subject:String(m.subject??'').slice(0,500),
        text:m.body?.contentType?.toLowerCase()==='text'?String(m.body.content).slice(0,32_768):'[This message has no plain-text body.]',receivedAt:new Date(m.receivedDateTime).toISOString()});
    }
    return {messages,cursor:nextCursor(c,typeof data['@odata.nextLink']==='string'?data['@odata.nextLink']:undefined),skipped};
  }
  toJSON(){return {provider:this.c.provider,credentials:'[REDACTED]'};}
}
