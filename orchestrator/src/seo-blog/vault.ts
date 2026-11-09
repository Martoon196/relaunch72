import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { SeoBlogError } from './types.js';

/**
 * Website credentials are sealed with AES-256-GCM, bound by AAD to the exact
 * brand workspace and destination, using the same authenticated-encryption
 * pattern as the platform's investor-mail and setup-delivery vaults.
 */
export class SeoBlogCredentialVault {
  readonly #key: Buffer;
  constructor(key: Buffer) {
    if (key.length !== 32) throw new Error('SEO blog credential key must be 32 bytes');
    this.#key = Buffer.from(key);
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): SeoBlogCredentialVault | null {
    const raw = env.SEO_BLOG_CREDENTIAL_KEY?.trim();
    if (!raw) return null;
    const key = Buffer.from(raw, 'base64');
    return key.length === 32 ? new SeoBlogCredentialVault(key) : null;
  }

  seal(brandId: string, destinationId: string, secret: string): string {
    if (!secret || secret.length > 8000) throw new SeoBlogError(400, 'Enter the website credential.');
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.#key, nonce);
    cipher.setAAD(Buffer.from(`seo-blog:v1:destination:${brandId}:${destinationId}`));
    const body = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
    return Buffer.concat([Buffer.from([1]), nonce, cipher.getAuthTag(), body]).toString('base64');
  }

  open(brandId: string, destinationId: string, sealed: string): string {
    try {
      const bytes = Buffer.from(sealed, 'base64');
      if (bytes[0] !== 1 || bytes.length < 30 || bytes.length > 12_000) throw new Error('shape');
      const decipher = createDecipheriv('aes-256-gcm', this.#key, bytes.subarray(1, 13));
      decipher.setAAD(Buffer.from(`seo-blog:v1:destination:${brandId}:${destinationId}`));
      decipher.setAuthTag(bytes.subarray(13, 29));
      return Buffer.concat([decipher.update(bytes.subarray(29)), decipher.final()]).toString('utf8');
    } catch {
      throw new SeoBlogError(409, 'The saved website credential could not be opened. Reconnect the website.', 'credential_unavailable');
    }
  }

  toJSON() {
    return { credentials: '[REDACTED]' };
  }
}
