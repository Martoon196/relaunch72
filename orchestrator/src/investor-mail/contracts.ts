/** Mail transports never choose a workspace, contact or approved body. */
export type InvestorMailProvider = 'google' | 'microsoft' | 'smtp';
export interface CustomMailbox {
  provider:'smtp'; address:string; displayName:string;
  smtpHost:string; smtpPort:465|587; imapHost:string; imapPort:993;
  username:string; password:string; imapPassword?:string;
}
export interface OAuthMailbox {
  provider:'google'|'microsoft'; address:string; displayName:string;
  accessToken:string; refreshToken:string; expiresAt:number;
}
export type MailboxCredentials=CustomMailbox|OAuthMailbox;
export interface ApprovedInvestorMail {
  /** Stable across all attempts. A timed-out send must be reconciled, never retried automatically. */
  messageId:string; to:string; subject:string; text:string;
  inReplyTo?:string; references?:string[];
}
export interface MailAcceptance { state:'accepted'; providerId:string|null }
export interface MailReceived {
  providerId:string; messageId:string; inReplyTo:string|null; references:string[];
  from:string; to:string[]; subject:string; text:string; receivedAt:string;
}
export interface MailReadPage { messages:MailReceived[]; cursor:string|null; skipped?:number }
export class InvestorMailError extends Error {
  constructor(readonly code:'invalid_settings'|'connection_failed'|'reauthorisation_required'|'outcome_unknown'|'read_failed') {
    super(`Email ${code.replaceAll('_',' ')}.`);
  }
}
export interface InvestorMailboxTransport {
  verify():Promise<{address:string}>;
  send(message:ApprovedInvestorMail):Promise<MailAcceptance>;
  read(cursor:string|null):Promise<MailReadPage>;
}
export function mailboxAddress(value:string):string {
  const clean=value.trim().toLowerCase();
  if(clean.length>254||!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$/.test(clean)) throw new InvestorMailError('invalid_settings');
  return clean;
}
export function validateInvestorMail(m:ApprovedInvestorMail):void {
  mailboxAddress(m.to);
  if(!/^<iv-[0-9a-f-]{36}@[a-z0-9.-]+>$/.test(m.messageId)||m.subject.length<1||m.subject.length>200||/[\r\n\x00]/.test(m.subject)||Buffer.byteLength(m.text)>32_768||!m.text.trim()) throw new InvestorMailError('invalid_settings');
  for(const header of [m.inReplyTo,...m.references??[]]) if(header && (!/^<[^<>\s\r\n]{1,500}>$/.test(header))) throw new InvestorMailError('invalid_settings');
  if((m.references?.length??0)>20)throw new InvestorMailError('invalid_settings');
}
