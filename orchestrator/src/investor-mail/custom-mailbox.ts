import { lookup } from 'node:dns/promises';
import nodemailer from 'nodemailer';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { InvestorMailError,mailboxAddress,validateInvestorMail,type CustomMailbox,type ApprovedInvestorMail,type InvestorMailboxTransport,type MailReceived } from './contracts.js';

/** Only public IPv4 targets. Pin the resolved address; keep hostname for certificate verification. */
export function publicMailIp(ip:string):boolean {
  const parts=ip.split('.').map(Number);
  if(parts.length!==4||parts.some(n=>!Number.isInteger(n)||n<0||n>255))return false;
  const [a,b,c]=parts;
  return !(a===0||a===10||a===127||a!>=224||a===169&&b===254||a===172&&b!>=16&&b!<=31||a===192&&(b===168||b===0||b===2)||a===100&&b!>=64&&b!<=127||a===198&&(b===18||b===19||b===51&&c===100)||a===203&&b===0&&c===113);
}
export async function resolveMailHost(host:string):Promise<string> {
  if(!/^(?=.{4,253}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(host)||/^\d+\.\d+\.\d+\.\d+$/.test(host))throw new InvestorMailError('invalid_settings');
  const addresses=await lookup(host,{all:true,family:4});
  if(!addresses.length||addresses.some(a=>!publicMailIp(a.address)))throw new InvestorMailError('invalid_settings');
  return addresses[0]!.address;
}
export function validateCustomMailbox(c:CustomMailbox):void {
  if(c.provider!=='smtp'||mailboxAddress(c.address)!==c.address||mailboxAddress(c.username)!==c.address||![465,587].includes(c.smtpPort)||c.imapPort!==993||!c.password||c.password.length>2000||!c.displayName.trim()||c.displayName.length>100||/[\r\n\x00]/.test(c.displayName))throw new InvestorMailError('invalid_settings');
}
export class CustomMailboxTransport implements InvestorMailboxTransport {
  constructor(private readonly config:CustomMailbox,private readonly resolve=resolveMailHost) {validateCustomMailbox(config);}
  private async smtp() {
    const c=this.config,ip=await this.resolve(c.smtpHost);
    return nodemailer.createTransport({host:ip,port:c.smtpPort,secure:c.smtpPort===465,requireTLS:true,
      tls:{servername:c.smtpHost,rejectUnauthorized:true,minVersion:'TLSv1.2'},auth:{user:c.username,pass:c.password},
      connectionTimeout:10_000,greetingTimeout:10_000,socketTimeout:20_000,logger:false,debug:false,
      disableFileAccess:true,disableUrlAccess:true});
  }
  private async imap() {
    const c=this.config,ip=await this.resolve(c.imapHost);
    return new ImapFlow({host:ip,port:993,secure:true,tls:{servername:c.imapHost,rejectUnauthorized:true,minVersion:'TLSv1.2'},
      auth:{user:c.username,pass:c.imapPassword||c.password},logger:false,connectionTimeout:10_000,greetingTimeout:10_000,socketTimeout:20_000,disableAutoIdle:true});
  }
  async verify() {
    let smtp:Awaited<ReturnType<CustomMailboxTransport['smtp']>>|undefined,imap:ImapFlow|undefined;
    try {smtp=await this.smtp();await smtp.verify();imap=await this.imap();await imap.connect();await imap.mailboxOpen('INBOX',{readOnly:true});return {address:this.config.address};}
    catch {throw new InvestorMailError('connection_failed');}
    finally {smtp?.close();if(imap)await imap.logout().catch(()=>imap!.close());}
  }
  async send(message:ApprovedInvestorMail) {
    validateInvestorMail(message);
    let smtp:Awaited<ReturnType<CustomMailboxTransport['smtp']>>|undefined;
    try {
      smtp=await this.smtp();
      const result=await smtp.sendMail({from:{name:this.config.displayName,address:this.config.address},to:mailboxAddress(message.to),
        subject:message.subject,text:message.text,messageId:message.messageId,inReplyTo:message.inReplyTo,references:message.references,
        disableFileAccess:true,disableUrlAccess:true});
      if(!result.accepted?.some(a=>typeof a==='string'&&a.toLowerCase()===message.to.toLowerCase()))throw new Error();
      return {state:'accepted' as const,providerId:typeof result.messageId==='string'?result.messageId:null};
    } catch {throw new InvestorMailError('outcome_unknown');}
    finally {smtp?.close();}
  }
  async read(cursor:string|null) {
    let client:ImapFlow|undefined;
    try {
      client=await this.imap();await client.connect();const box=await client.mailboxOpen('INBOX',{readOnly:true});
      const validity=String(box.uidValidity),parts=cursor?.split(':')??[];
      // UIDVALIDITY changes require a distinct import key, not a reused UID.
      const after=parts[0]===validity&&/^\d+$/.test(parts[1]??'')?Number(parts[1]):0;
      const found=await client.search(after?{uid:`${after+1}:*`}:{since:new Date(Date.now()-30*86400_000)},{uid:true});
      const uids=(found||[]).filter(n=>n>after).sort((a,b)=>a-b).slice(0,50);
      const messages:MailReceived[]=[];let last=after,skipped=0;
      for(const uid of uids) {
        const meta=await client.fetchOne(uid,{size:true},{uid:true});
        if(!meta||!meta.size||meta.size>128_000){last=uid;skipped++;continue;}
        const item=await client.fetchOne(uid,{source:true},{uid:true});
        if(!item||!item.source){last=uid;skipped++;continue;}
        const parsed=await simpleParser(item.source,{skipHtmlToText:true,skipTextToHtml:true,skipImageLinks:true});
        const from=parsed.from?.value[0]?.address;
        const to=(Array.isArray(parsed.to)?parsed.to:[parsed.to]).flatMap(a=>a?.value.map(v=>v.address).filter((v):v is string=>Boolean(v))??[]);
        if(from&&parsed.messageId)messages.push({providerId:`${validity}:${uid}`,messageId:parsed.messageId,inReplyTo:parsed.inReplyTo??null,
          references:typeof parsed.references==='string'?[parsed.references]:parsed.references??[],from:mailboxAddress(from),to:to.map(mailboxAddress),
          subject:(parsed.subject??'').slice(0,500),text:(parsed.text||'[This message has no plain-text body.]').slice(0,32_768),receivedAt:(parsed.date??new Date()).toISOString()});
        else skipped++;
        last=uid;
      }
      return {messages,cursor:`${validity}:${last}`,skipped};
    } catch {throw new InvestorMailError('read_failed');}
    finally {if(client)await client.logout().catch(()=>client!.close());}
  }
  toJSON(){return {provider:'smtp',credentials:'[REDACTED]'};}
}
