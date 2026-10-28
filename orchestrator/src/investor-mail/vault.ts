import { createCipheriv,createDecipheriv,randomBytes } from 'node:crypto';
import type { MailboxCredentials } from './contracts.js';
/** Same authenticated-encryption pattern as native setup delivery; a distinct key and AAD. */
export class InvestorMailVault {
  readonly #key:Buffer;
  constructor(key:Buffer) {if(key.length!==32)throw new Error('Investor mail encryption key must be 32 bytes');this.#key=Buffer.from(key);}
  seal(workspaceId:string,credentials:MailboxCredentials):string {
    return this.sealValue(workspaceId,credentials,'mailbox');
  }
  sealValue(workspaceId:string,value:unknown,purpose:'mailbox'|'oauth'):string {
    const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',this.#key,nonce);
    cipher.setAAD(Buffer.from(`investor-mail:v1:${purpose}:${workspaceId}`));
    const body=Buffer.concat([cipher.update(JSON.stringify(value),'utf8'),cipher.final()]);
    return Buffer.concat([Buffer.from([1]),nonce,cipher.getAuthTag(),body]).toString('base64');
  }
  open(workspaceId:string,sealed:string):MailboxCredentials {
    return this.openValue(workspaceId,sealed,'mailbox') as MailboxCredentials;
  }
  openValue(workspaceId:string,sealed:string,purpose:'mailbox'|'oauth'):unknown {
    try {
      const bytes=Buffer.from(sealed,'base64');
      if(bytes[0]!==1||bytes.length<30||bytes.length>24_000)throw new Error();
      const decipher=createDecipheriv('aes-256-gcm',this.#key,bytes.subarray(1,13));
      decipher.setAAD(Buffer.from(`investor-mail:v1:${purpose}:${workspaceId}`));decipher.setAuthTag(bytes.subarray(13,29));
      return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(29)),decipher.final()]).toString('utf8')) as unknown;
    } catch {throw new Error('Email credential authentication failed');}
  }
  toJSON(){return {credentials:'[REDACTED]'};}
}
