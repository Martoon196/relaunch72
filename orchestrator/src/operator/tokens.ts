/**
 * Signed blobs for the operator OAuth server: `base64url(json).base64url(mac)` with a
 * per-kind HMAC domain. Only registered client ids use this now; codes and tokens
 * are opaque values stored as hashes in the database (migration 0148).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export type BlobKind = 'oauth-client';

function mac(secret: string, kind: BlobKind, body: string): Buffer {
  return createHmac('sha256', secret).update(`r72-operator-${kind}\u0000`).update(body).digest();
}

export function signBlob(secret: string, kind: BlobKind, claims: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${body}.${mac(secret, kind, body).toString('base64url')}`;
}

/** Returns the claims when the signature, kind and (if present) `exp` hold; otherwise null. */
export function verifyBlob(secret: string, kind: BlobKind, token: string | null | undefined, nowSec: number): Record<string, unknown> | null {
  if (!token || token.length > 4096) return null;
  const parts = token.split('.');
  if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0]!) || !/^[A-Za-z0-9_-]{43}$/.test(parts[1]!)) return null;
  const supplied = Buffer.from(parts[1]!, 'base64url');
  const wanted = mac(secret, kind, parts[0]!);
  if (supplied.length !== wanted.length || !timingSafeEqual(supplied, wanted)) return null;
  let raw: unknown;
  try { raw = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString('utf8')); } catch { return null; }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const claims = raw as Record<string, unknown>;
  if ('exp' in claims && (typeof claims.exp !== 'number' || !Number.isInteger(claims.exp) || claims.exp <= nowSec)) return null;
  return claims;
}
