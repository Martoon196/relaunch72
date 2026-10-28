import { createHash } from 'node:crypto';
import { InvestorMailError,mailboxAddress,type OAuthMailbox } from './contracts.js';
export interface MailOAuthApp {clientId:string;clientSecret:string}
export interface MailOAuthConfig {redirectUri:string;google?:MailOAuthApp;microsoft?:MailOAuthApp}
export const MAIL_OAUTH_SCOPES={google:'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send',microsoft:'offline_access User.Read Mail.Read Mail.Send'};
const endpoints={google:{authorize:'https://accounts.google.com/o/oauth2/v2/auth',token:'https://oauth2.googleapis.com/token',profile:'https://gmail.googleapis.com/gmail/v1/users/me/profile'},microsoft:{authorize:'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',token:'https://login.microsoftonline.com/common/oauth2/v2.0/token',profile:'https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName'}};
function app(config:MailOAuthConfig,provider:'google'|'microsoft'):MailOAuthApp {
 const selected=config[provider],uri=new URL(config.redirectUri);
 if(!selected||!selected.clientId||!selected.clientSecret||uri.protocol!=='https:'||uri.username||uri.password)throw new InvestorMailError('invalid_settings');return selected;
}
export function mailAuthorizationUrl(config:MailOAuthConfig,provider:'google'|'microsoft',state:string,verifier:string):string {
 const client=app(config,provider),params=new URLSearchParams({client_id:client.clientId,redirect_uri:config.redirectUri,response_type:'code',scope:MAIL_OAUTH_SCOPES[provider],state,code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256',prompt:'consent'});
 if(provider==='google')params.set('access_type','offline');
 return endpoints[provider].authorize+'?'+params;
}
export async function exchangeMailCode(config:MailOAuthConfig,provider:'google'|'microsoft',code:string,verifier:string,displayName:string,request:typeof fetch=fetch):Promise<OAuthMailbox> {
 const client=app(config,provider);
 if(code.length>4096||!code||!/^[A-Za-z0-9_-]{43,128}$/.test(verifier))throw new InvestorMailError('invalid_settings');
 try {
  const response=await request(endpoints[provider].token,{method:'POST',redirect:'error',signal:AbortSignal.timeout(15_000),headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:client.clientId,client_secret:client.clientSecret,code,code_verifier:verifier,redirect_uri:config.redirectUri,grant_type:'authorization_code'})});
  if(!response.ok)throw new Error();const text=await response.text();if(text.length>32_000)throw new Error();const tokens=JSON.parse(text);
  if(typeof tokens.access_token!=='string'||typeof tokens.refresh_token!=='string'||!Number.isFinite(Number(tokens.expires_in))||Number(tokens.expires_in)<60)throw new Error();
  const profile=await request(endpoints[provider].profile,{redirect:'error',signal:AbortSignal.timeout(15_000),headers:{Authorization:`Bearer ${tokens.access_token}`}});
  if(!profile.ok)throw new Error();const person=await profile.json() as Record<string,unknown>;
  const address=mailboxAddress(String(provider==='google'?person.emailAddress:person.mail||person.userPrincipalName));
  return {provider,address,displayName,accessToken:tokens.access_token,refreshToken:tokens.refresh_token,expiresAt:Date.now()+Number(tokens.expires_in)*1000};
 }catch{throw new InvestorMailError('reauthorisation_required');}
}
export async function refreshMailTokens(config:MailOAuthConfig,mailbox:OAuthMailbox,request:typeof fetch=fetch):Promise<OAuthMailbox> {
 const client=app(config,mailbox.provider);
 try {
  const response=await request(endpoints[mailbox.provider].token,{method:'POST',redirect:'error',signal:AbortSignal.timeout(15_000),headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:client.clientId,client_secret:client.clientSecret,refresh_token:mailbox.refreshToken,grant_type:'refresh_token'})});
  if(!response.ok)throw new Error();const body=await response.text();if(body.length>32_000)throw new Error();const token=JSON.parse(body);
  if(typeof token.access_token!=='string'||Number(token.expires_in)<90||!Number.isFinite(Number(token.expires_in)))throw new Error();
  return {...mailbox,accessToken:token.access_token,refreshToken:typeof token.refresh_token==='string'?token.refresh_token:mailbox.refreshToken,expiresAt:Date.now()+Number(token.expires_in)*1000};
 }catch{throw new InvestorMailError('reauthorisation_required');}
}
