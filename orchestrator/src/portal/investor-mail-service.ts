import { createHash,randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import { createPgPortalCrmPrincipalResolver } from './crm-pg-service.js';
import type { PortalCrmRequestIdentity } from './crm-service.js';
import { InvestorError,investorUuid } from './investor-service.js';
import { InvestorMailVault } from '../investor-mail/vault.js';
import { mailboxAddress,type CustomMailbox,type MailboxCredentials,type ApprovedInvestorMail,type InvestorMailboxTransport } from '../investor-mail/contracts.js';
import { CustomMailboxTransport,validateCustomMailbox } from '../investor-mail/custom-mailbox.js';
import { OAuthMailboxTransport } from '../investor-mail/oauth-mailbox.js';
import { mailAuthorizationUrl,exchangeMailCode,refreshMailTokens,type MailOAuthConfig } from '../investor-mail/oauth.js';
export interface InvestorMailSnapshot {provider:'google'|'microsoft'|'smtp';address:string;status:'pending'|'verified'|'paused';version:number;verifiedAt:string|null;settings:Record<string,string|number>}
export interface InvestorMailView {account:InvestorMailSnapshot|null;customAvailable:boolean;googleAvailable:boolean;microsoftAvailable:boolean;deliveryEnabled:boolean}
export interface InvestorEmailItem {id:string;subject:string;contactName:string;to:string;direction:string;state:string;createdAt:string;preview:string}
export interface InvestorEmailReview {id:string;version:number;bodyHash:string;reviewHash:string;subject:string;text:string;to:string;from:string;contactName:string;contactPointId:string;lifecycle:string;state:string;direction:string;internetMessageId:string;permissionRecorded:boolean}
export interface InvestorEmailCentre {selected:InvestorEmailReview|null;contacts:{id:string;name:string;address:string;verified:boolean}[];messages:InvestorEmailItem[]}
interface SecretAccount {workspaceId:string;version:number;sealed:string;address:string;status:string;cursor:string|null}
const hash=(v:string)=>createHash('sha256').update(v).digest();
const transportFor=(c:MailboxCredentials):InvestorMailboxTransport=>c.provider==='smtp'?new CustomMailboxTransport(c):new OAuthMailboxTransport(c);
export class InvestorMailService {
  constructor(private readonly readPool:Pick<Pool,'query'>,private readonly commandPool:Pick<Pool,'query'>,private readonly vault:InvestorMailVault|undefined,private readonly oauth:MailOAuthConfig|undefined,private readonly deliveryEnabled=false,private readonly transport=transportFor){}
  async snapshot(identity:PortalCrmRequestIdentity):Promise<InvestorMailView> {
    const result=await this.readPool.query<{account:InvestorMailSnapshot|null}>('SELECT app_private.investor_mail_snapshot($1) AS account',[hash(identity.sessionToken)]);
    return {account:result.rows[0]?.account??null,customAvailable:Boolean(this.vault),googleAvailable:Boolean(this.vault&&this.oauth?.google),microsoftAvailable:Boolean(this.vault&&this.oauth?.microsoft),deliveryEnabled:this.deliveryEnabled};
  }
  async centre(identity:PortalCrmRequestIdentity,message?:string):Promise<InvestorEmailCentre> {
    const r=await this.readPool.query<{snapshot:InvestorEmailCentre}>('SELECT app_private.investor_email_snapshot($1,$2) AS snapshot',[hash(identity.sessionToken),message?investorUuid(message):null]);
    if(!r.rows[0]?.snapshot)throw new InvestorError(503,'Conversations could not load.');return r.rows[0].snapshot;
  }
  async draft(identity:PortalCrmRequestIdentity,form:Record<string,string>):Promise<string> {
    const subject=(form.subject??'').trim(),body=(form.body??'').trim();
    if(!subject||subject.length>200||/[\r\n\x00]/.test(subject)||!body||Buffer.byteLength(body)>32_768)throw new InvestorError(400,'Check the subject and message.');
    const r=await this.commandPool.query<{id:string}>('SELECT app_private.draft_investor_email($1,$2,$3,$4,$5,$6) AS id',[hash(identity.sessionToken),investorUuid(form.commandKey??''),investorUuid(form.contactPointId??''),subject,body,form.inReplyTo||null]);
    if(!r.rows[0]?.id)throw new InvestorError(503,'Saving the draft was not confirmed.');return r.rows[0].id;
  }
  async readyToSend(identity:PortalCrmRequestIdentity,form:Record<string,string>):Promise<string> {
    if(form.confirmation!=='review_exact_message')throw new InvestorError(400,'Check the recipient and message before continuing.');
    const id=await this.draft(identity,form);
    const review=(await this.centre(identity,id)).selected;
    if(!review||review.id!==id||review.lifecycle!=='draft')throw new InvestorError(503,'The saved draft could not be reviewed. No email was sent.');
    await this.approve(identity,{messageId:id,version:String(review.version),reviewHash:review.reviewHash,confirmation:'approve_exact_message'});
    return id;
  }
  async approve(identity:PortalCrmRequestIdentity,form:Record<string,string>):Promise<void> {
    if(form.confirmation!=='approve_exact_message'||!/^\d+$/.test(form.version??'')||!/^[a-f0-9]{64}$/.test(form.reviewHash??''))throw new InvestorError(400,'Review the exact recipient and complete message before approving.');
    await this.commandPool.query('SELECT app_private.approve_investor_email($1,$2,$3,$4,$5)',[hash(identity.sessionToken),investorUuid(form.messageId??''),Number(form.version),Buffer.from(form.reviewHash!,'hex'),form.confirmation]);
  }
  async permission(identity:PortalCrmRequestIdentity,form:Record<string,string>):Promise<void> {
    if(!['requested','suppress'].includes(form.decision??'')||form.confirmation!=='record_permission'||(form.evidence?.trim().length??0)<10||(form.evidence?.length??0)>2000)throw new InvestorError(400,'Record the actual investor request or opt-out and confirm the decision.');
    await this.commandPool.query('SELECT app_private.record_investor_email_permission($1,$2,$3,$4,$5)',[hash(identity.sessionToken),investorUuid(form.contactPointId??''),investorUuid(form.commandKey??''),form.decision==='requested',form.evidence!.trim()]);
  }
  private async account(identity:PortalCrmRequestIdentity):Promise<{account:SecretAccount;credentials:MailboxCredentials}> {
    const r=await this.commandPool.query<{account:SecretAccount|null}>('SELECT app_private.investor_mail_secret($1) AS account',[hash(identity.sessionToken)]);
    const account=r.rows[0]?.account;if(!account)throw new InvestorError(400,'Connect your mailbox first.');
    let credentials=this.key().open(account.workspaceId,account.sealed);
    if(credentials.provider!=='smtp'&&credentials.expiresAt<Date.now()+90_000) {
      if(!this.oauth)throw new InvestorError(503,'Email authorisation needs platform setup.');
      credentials=await refreshMailTokens(this.oauth,credentials);
      await this.commandPool.query('SELECT app_private.refresh_investor_mail_credentials($1,$2,$3,$4)',[hash(identity.sessionToken),account.version,hash(account.sealed),this.key().seal(account.workspaceId,credentials)]);
    }
    if(credentials.address!==account.address)throw new InvestorError(503,'Email connection identity needs checking.');
    return {account,credentials};
  }
  async send(identity:PortalCrmRequestIdentity,form:Record<string,string>):Promise<'accepted'|'unknown'> {
    if(!this.deliveryEnabled)throw new InvestorError(503,'Pilot email delivery has not been enabled on this installation.');
    if(form.confirmation!=='send_approved_message'||!/^\d+$/.test(form.version??'')||!/^[a-f0-9]{64}$/.test(form.bodyHash??''))throw new InvestorError(400,'Open and confirm the approved message before sending.');
    const loaded=await this.account(identity);if(loaded.account.status!=='verified')throw new InvestorError(400,'Check the mailbox connection first.');
    const lease=hash(randomBytes(32).toString('base64url'));
    const r=await this.commandPool.query<{claim:ApprovedInvestorMail&{operationId:string;accountVersion:number;address:string}}>('SELECT app_private.claim_investor_email($1,$2,$3,$4,$5,$6) AS claim',
      [hash(identity.sessionToken),investorUuid(form.messageId??''),Number(form.version),Buffer.from(form.bodyHash!,'hex'),lease,form.confirmation]);
    const claim=r.rows[0]?.claim;if(!claim)throw new InvestorError(503,'Dispatch was not confirmed. Do not resend until its status has been checked.');
    const settle=(accepted:boolean,reference:string|null)=>this.commandPool.query('SELECT app_private.settle_investor_email($1,$2,$3,$4,$5)',[hash(identity.sessionToken),claim.operationId,lease,accepted,reference]);
    let accepted;
    try {
      if(Number(claim.accountVersion)!==Number(loaded.account.version)||claim.address!==loaded.account.address)throw new Error('Connection changed');
      const displayName=loaded.credentials.displayName.replace(/\s*·\s*Your Desk\s*$/i,'').trim()||loaded.credentials.displayName;
      accepted=await this.transport({...loaded.credentials,displayName}).send({...claim,inReplyTo:claim.inReplyTo||undefined});
    }catch {await settle(false,null).catch(()=>{});return 'unknown';}
    try {await settle(true,accepted.providerId);return 'accepted';}
    catch{throw new InvestorError(503,'The provider accepted the message, but saving its receipt was not confirmed. Check its status before taking any further action.');}
  }
  async sync(identity:PortalCrmRequestIdentity):Promise<{imported:number;unmatched:number;duplicates:number;skipped:number}> {
    const {account,credentials}=await this.account(identity);
    if(account.status!=='verified')throw new InvestorError(400,'Check your mailbox connection before syncing replies.');
    const page=await this.transport(credentials).read(account.cursor);
    const r=await this.commandPool.query<{result:{imported:number;unmatched:number;duplicates:number}}>(
      'SELECT app_private.import_investor_email_page($1,$2,$3,$4,$5) AS result',
      [hash(identity.sessionToken),account.version,account.cursor,page.cursor,JSON.stringify(page.messages)]);
    if(!r.rows[0]?.result)throw new InvestorError(503,'Reply import was not confirmed. Refresh before syncing again.');
    return {...r.rows[0].result,skipped:page.skipped??0};
  }
  private async workspace(identity:PortalCrmRequestIdentity):Promise<string> {
    const principal=await createPgPortalCrmPrincipalResolver(this.readPool).resolve(identity.sessionToken);
    if(!principal)throw new InvestorError(403,'Sign in again to connect email.');return principal.workspaceId;
  }
  private key():InvestorMailVault {if(!this.vault)throw new InvestorError(503,'Secure email connection storage needs configuring by the platform administrator.');return this.vault;}
  private async save(identity:PortalCrmRequestIdentity,version:number,credentials:MailboxCredentials):Promise<number> {
    const ws=await this.workspace(identity),sealed=this.key().seal(ws,credentials);
    const settings=credentials.provider==='smtp'?{displayName:credentials.displayName,smtpHost:credentials.smtpHost,smtpPort:credentials.smtpPort,imapHost:credentials.imapHost,imapPort:credentials.imapPort}:{displayName:credentials.displayName};
    const result=await this.commandPool.query<{version:number}>('SELECT app_private.save_investor_mail_connection($1,$2,$3,$4,$5,$6) AS version',[hash(identity.sessionToken),version,credentials.provider,credentials.address,settings,sealed]);
    if(!result.rows[0])throw new InvestorError(503,'Saving the connection was not confirmed.');return Number(result.rows[0].version);
  }
  async saveCustom(identity:PortalCrmRequestIdentity,form:Record<string,string>):Promise<void> {
    this.key();const version=Number(form.version);
    if(!/^\d+$/.test(form.version??'')||!Number.isSafeInteger(version))throw new InvestorError(400,'Refresh before changing the email connection.');
    const c:CustomMailbox={provider:'smtp',address:mailboxAddress(form.address??''),displayName:(form.displayName??'').trim(),username:mailboxAddress(form.address??''),
      smtpHost:(form.smtpHost??'').trim().toLowerCase(),smtpPort:Number(form.smtpPort) as 465|587,imapHost:(form.imapHost??'').trim().toLowerCase(),imapPort:993,password:form.password??'',imapPassword:form.imapPassword||undefined};
    validateCustomMailbox(c);await this.save(identity,version,c);
  }
  async verify(identity:PortalCrmRequestIdentity):Promise<void> {
    const {account:a,credentials}=await this.account(identity);
    try {const verified=await this.transport(credentials).verify();await this.commandPool.query('SELECT app_private.verify_investor_mail_connection($1,$2,$3)',[hash(identity.sessionToken),a.version,verified.address]);}
    catch{throw new InvestorError(400,'The mailbox could not be verified. Check the connection settings or reconnect your account. No email was sent.');}
  }
  async disconnect(identity:PortalCrmRequestIdentity,version:string):Promise<void> {
    if(!/^\d+$/.test(version))throw new InvestorError(400,'Refresh before disconnecting.');
    await this.commandPool.query('SELECT app_private.disconnect_investor_mail($1,$2)',[hash(identity.sessionToken),Number(version)]);
  }
  async beginOAuth(identity:PortalCrmRequestIdentity,provider:string):Promise<string> {
    if(!['google','microsoft'].includes(provider)||!this.oauth)throw new InvestorError(503,'This email provider needs platform setup first.');
    const selected=provider as 'google'|'microsoft',state=randomBytes(32).toString('base64url'),verifier=randomBytes(32).toString('base64url'),ws=await this.workspace(identity);
    const url=mailAuthorizationUrl(this.oauth,selected,state,verifier);
    await this.commandPool.query('SELECT app_private.begin_investor_oauth($1,$2,$3,$4)',[hash(identity.sessionToken),hash(state),selected,this.key().sealValue(ws,{verifier},'oauth')]);return url;
  }
  async finishOAuth(identity:PortalCrmRequestIdentity,state:string,code:string,displayName:string):Promise<void> {
    if(!/^[A-Za-z0-9_-]{43}$/.test(state)||!this.oauth)throw new InvestorError(400,'Email authorisation expired. Start again.');
    const result=await this.commandPool.query<{attempt:{provider:'google'|'microsoft';sealed:string;version:number}}>('SELECT app_private.consume_investor_oauth($1,$2) AS attempt',[hash(identity.sessionToken),hash(state)]);
    const attempt=result.rows[0]?.attempt;if(!attempt)throw new InvestorError(400,'Email authorisation expired. Start again.');
    const payload=this.key().openValue(await this.workspace(identity),attempt.sealed,'oauth') as {verifier:string};
    const credentials=await exchangeMailCode(this.oauth,attempt.provider,code,payload.verifier,displayName);
    const version=await this.save(identity,Number(attempt.version),credentials);
    await this.commandPool.query('SELECT app_private.verify_investor_mail_connection($1,$2,$3)',[hash(identity.sessionToken),version,credentials.address]);
  }
}
