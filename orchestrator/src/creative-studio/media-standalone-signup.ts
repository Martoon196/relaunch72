/** Standalone presentation -> canonical pending account + encrypted setup outbox.
 * No email is sent by this service, and no password/setup token is returned.
 */
import {createHmac} from 'node:crypto';
import type {Pool} from 'pg';
import type {PgSetupDeliveryService} from '../portal/setup-delivery-pg-service.js';
import type {PortalAuthService,PortalAuthRequestContext} from '../portal/auth-service.js';
import {SeoBlogError} from '../seo-blog/types.js';
import {checkedEditId} from './media-edit-plan.js';
export function mediaSignupSourceHash(source:string,key:Buffer):Buffer{
 if(!Buffer.isBuffer(key)||key.length!==32||!source||source.length>256)throw new SeoBlogError(503,'Signup source protection unconfigured');
 return createHmac('sha256',key).update('rl72-media-signup-v1\0').update(source).digest();
}
export class PgAffiliateStudioSignup {
 constructor(private readonly pool:Pick<Pool,'query'>,private readonly setup:Pick<PgSetupDeliveryService,'prepare'>,private readonly env:NodeJS.ProcessEnv=process.env){}
 async begin(input:{commandId:string;email:string;name:string;workspaceName:string;termsVersion:string;acceptedTerms:boolean},sourceHash:Buffer){
  if(this.env.CREATIVE_MEDIA!=='enabled'||this.env.RL72_MEDIA_STANDALONE_SIGNUP_ENABLED!=='true')throw new SeoBlogError(503,'Affiliate Studio signup disabled');
  if(!input||typeof input.email!=='string'||typeof input.name!=='string'||typeof input.workspaceName!=='string'||typeof input.termsVersion!=='string')throw new SeoBlogError(400,'Complete signup identity required');
  input=Object.freeze({...input,email:input.email.trim().toLowerCase(),name:input.name.trim(),workspaceName:input.workspaceName.trim()});checkedEditId(input.commandId);
  if(!Buffer.isBuffer(sourceHash)||sourceHash.length!==32||input.acceptedTerms!==true||!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/u.test(input.email)||input.email.length>320||!input.name||input.name.length>160||!input.workspaceName||input.workspaceName.length>160||/[<>\x00-\x1f]/u.test(input.name+input.workspaceName)||!/^[a-zA-Z0-9._-]{1,60}$/u.test(input.termsVersion))throw new SeoBlogError(400,'Complete signup and current terms consent required');
  const encrypted=this.setup.prepare(input.email);
  try{await this.pool.query('SELECT app_private.creative_media_signup($1,$2,$3,$4,$5,$6,$7::smallint,$8,$9,$10,$11)',[input.commandId,JSON.stringify(input),Buffer.from(sourceHash),encrypted.setupTokenHash,encrypted.recipientEmailHash,encrypted.deliveryId,encrypted.payloadVersion,encrypted.encryptionKeyId,encrypted.encryptionIv,encrypted.encryptedPayload,encrypted.authenticationTag]);}
  catch(e){const code=(e as {code?:string}).code;if(code==='54000')throw new SeoBlogError(429,'Signup limit reached; try later');if(code==='40001')throw new SeoBlogError(409,'Signup request changed');if(code==='55000')throw new SeoBlogError(503,'Signup policy unavailable');throw e;}
  return {accepted:true as const,message:'If this address can register, account setup instructions will be delivered to it.'};
 }
}
/** Existing canonical completion validates the one-use setup token, sets the
 * password and mints its normal selected-workspace session. No alternate auth.
 */
export async function completeAffiliateStudioSetup(auth:Pick<PortalAuthService,'completeSetup'>,token:string,password:string,context:PortalAuthRequestContext){
 if(!auth.completeSetup)throw new SeoBlogError(503,'Canonical account setup unavailable');
 return auth.completeSetup(token,password,context);
}
