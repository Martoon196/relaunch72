/** WebCrypto helpers: hashing, HMAC, signed tokens, AES-GCM, RS256 JWTs. */

const enc = new TextEncoder();
const dec = new TextDecoder();

export function bytesToHex(buf: ArrayBuffer | Uint8Array): string {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (const x of b) s += x.toString(16).padStart(2, '0');
  return s;
}

export function b64urlEncode(data: Uint8Array | string): string {
  const bytes = typeof data === 'string' ? enc.encode(data) : data;
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function b64Decode(s: string): Uint8Array {
  return b64urlDecode(s.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''));
}

export async function sha256Hex(input: string): Promise<string> {
  return bytesToHex(await crypto.subtle.digest('SHA-256', enc.encode(input)));
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  return bytesToHex(await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(message)));
}

/** Constant-time string compare. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// ---------- compact signed tokens (session + host tokens) ----------

export interface SignedClaims {
  typ: string;
  exp: number; // unix seconds
  [k: string]: unknown;
}

export async function signToken(secret: string, claims: SignedClaims): Promise<string> {
  const body = b64urlEncode(JSON.stringify(claims));
  const sig = b64urlEncode(new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(body))));
  return `${body}.${sig}`;
}

export async function verifyToken<T extends SignedClaims>(secret: string, token: string, typ: string, nowS = Math.floor(Date.now() / 1000)): Promise<T | null> {
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  let ok = false;
  try {
    ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), b64urlDecode(sig), enc.encode(body));
  } catch {
    return null;
  }
  if (!ok) return null;
  try {
    const claims = JSON.parse(dec.decode(b64urlDecode(body))) as T;
    if (claims.typ !== typ || typeof claims.exp !== 'number' || claims.exp < nowS) return null;
    return claims;
  } catch {
    return null;
  }
}

// ---------- AES-GCM for secrets at rest ----------

async function aesKey(b64Key: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', b64Decode(b64Key), 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function encryptSecret(b64Key: string, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(b64Key), enc.encode(plaintext)));
  return `${b64urlEncode(iv)}.${b64urlEncode(ct)}`;
}

export async function decryptSecret(b64Key: string, payload: string): Promise<string> {
  const [iv, ct] = payload.split('.');
  if (!iv || !ct) throw new Error('bad ciphertext');
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64urlDecode(iv) }, await aesKey(b64Key), b64urlDecode(ct));
  return dec.decode(pt);
}

// ---------- RS256 JWT (Cloudflare Stream signed playback tokens) ----------

export async function signJwtRs256(jwk: JsonWebKey, kid: string, claims: Record<string, unknown>): Promise<string> {
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const header = b64urlEncode(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' }));
  const payload = b64urlEncode(JSON.stringify(claims));
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc.encode(`${header}.${payload}`));
  return `${header}.${payload}.${b64urlEncode(new Uint8Array(sig))}`;
}
