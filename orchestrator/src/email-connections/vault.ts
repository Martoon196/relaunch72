import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Seals the two secrets of an email connection (the Postmark server token and the bounce webhook secret) before they
 * are saved. AES-256-GCM with a 12-byte nonce, bound by AAD to the exact workspace and field
 * ("email-connection:v1:<workspaceId>:<field>"), so a sealed value moved to another row or column does not open.
 * The same authenticated-encryption format as the SEO blog's website credential vault, under a different key
 * (EMAIL_CONNECTION_KEY: 32 random bytes, base64), so neither key can open the other's values.
 */
export const EMAIL_CONNECTION_KEY_ENV = 'EMAIL_CONNECTION_KEY';
export type EmailConnectionSecretField = 'server_token' | 'webhook_secret';

export class EmailConnectionVaultError extends Error {
  override readonly name = 'EmailConnectionVaultError';
  constructor() { super('The saved email connection secret could not be opened.'); }
}

const aad = (workspaceId: string, field: EmailConnectionSecretField): Buffer => Buffer.from(`email-connection:v1:${workspaceId.toLowerCase()}:${field}`);

/** The key's value when it is well formed (base64 of exactly 32 bytes), else null. Never echoes the value. */
export function emailConnectionKey(raw: string | undefined): Buffer | null {
  const value = raw?.trim();
  if (!value || !/^[A-Za-z0-9+/]{43}=?$/u.test(value)) return null;
  const key = Buffer.from(value, 'base64');
  return key.length === 32 ? key : null;
}

export class EmailConnectionVault {
  readonly #key: Buffer;
  constructor(key: Buffer) {
    if (key.length !== 32) throw new Error('Email connection key must be 32 bytes');
    this.#key = Buffer.from(key);
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): EmailConnectionVault | null {
    const key = emailConnectionKey(env[EMAIL_CONNECTION_KEY_ENV]);
    return key ? new EmailConnectionVault(key) : null;
  }

  seal(workspaceId: string, field: EmailConnectionSecretField, secret: string): string {
    if (!secret || secret.length > 1000) throw new EmailConnectionVaultError();
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.#key, nonce);
    cipher.setAAD(aad(workspaceId, field));
    const body = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
    return Buffer.concat([Buffer.from([1]), nonce, cipher.getAuthTag(), body]).toString('base64');
  }

  open(workspaceId: string, field: EmailConnectionSecretField, sealed: string): string {
    try {
      const bytes = Buffer.from(sealed, 'base64');
      if (bytes[0] !== 1 || bytes.length < 30 || bytes.length > 2000) throw new Error('shape');
      const decipher = createDecipheriv('aes-256-gcm', this.#key, bytes.subarray(1, 13));
      decipher.setAAD(aad(workspaceId, field));
      decipher.setAuthTag(bytes.subarray(13, 29));
      return Buffer.concat([decipher.update(bytes.subarray(29)), decipher.final()]).toString('utf8');
    } catch {
      throw new EmailConnectionVaultError();
    }
  }

  toJSON() { return { credentials: '[REDACTED]' }; }
}
