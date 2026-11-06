/**
 * API keys.
 *   pk_live_… / pk_test_…  publishable: in embed tags; origin-locked; low-risk routes only.
 *   sk_live_… / sk_test_…  secret: Growth HQ backend; scoped; stored as SHA-256 only, shown once.
 * A secret key with brand_id NULL is an account-level key (manages every brand).
 */
import type { Mode } from '../env.js';
import { resolveConfig, type BrandRow } from './config.js';
import { sha256Hex, signToken, verifyToken, type SignedClaims } from './crypto.js';
import { originOf, parseJson, randomString } from './util.js';

export type KeyType = 'pk' | 'sk';

export interface ApiKeyRow {
  id: string;
  brand_id: string | null;
  type: KeyType;
  mode: Mode;
  prefix: string;
  hash: string;
  display: string | null;
  name: string | null;
  scopes: string;
  allowed_origins: string;
  last_used_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

export const SCOPES = [
  'brands:read', 'brands:write',
  'webinars:read', 'webinars:write',
  'registrants:read', 'registrants:write',
  'analytics:read',
  'moderation',
  'keys:write',
  'webhooks:write',
  'gdpr',
] as const;

export function generateApiKey(type: KeyType, mode: Mode): { raw: string; prefix: string } {
  const raw = `${type}_${mode}_${randomString(32)}`;
  return { raw, prefix: raw.slice(0, 12) };
}

export function parseKeyShape(raw: string): { type: KeyType; mode: Mode } | null {
  const m = /^(pk|sk)_(live|test)_[0-9a-z]{32}$/.exec(raw);
  return m ? { type: m[1] as KeyType, mode: m[2] as Mode } : null;
}

export async function findApiKey(db: D1Database, raw: string, nowMs = Date.now()): Promise<ApiKeyRow | null> {
  if (!parseKeyShape(raw)) return null;
  const row = await db.prepare('SELECT * FROM api_keys WHERE hash = ?').bind(await sha256Hex(raw)).first<ApiKeyRow>();
  // revoked_at may be in the future (rotation grace period).
  if (!row || (row.revoked_at && Date.parse(row.revoked_at) <= nowMs)) return null;
  return row;
}

/** `*`, an exact scope, `resource:*`, or (for reads) `resource:write`. */
export function hasScope(scopesJson: string, needed: string): boolean {
  const scopes = parseJson<string[]>(scopesJson, []);
  if (scopes.includes('*') || scopes.includes(needed)) return true;
  const [res, act] = needed.split(':');
  if (scopes.includes(`${res}:*`)) return true;
  return act === 'read' && scopes.includes(`${res}:write`);
}

function normaliseOrigin(o: string): string {
  return o.trim().replace(/\/+$/, '').toLowerCase();
}

/** Exact match, or wildcard subdomain like https://*.example.com. */
export function originMatches(origin: string, pattern: string): boolean {
  const o = normaliseOrigin(origin);
  const p = normaliseOrigin(pattern);
  if (p === o) return true;
  const m = /^(https?):\/\/\*\.(.+)$/.exec(p);
  if (!m) return false;
  const url = originOf(o);
  if (!url) return false;
  const u = new URL(url);
  return u.protocol === `${m[1]}:` && u.hostname.endsWith(`.${m[2]}`);
}

/** Origins a publishable key may be used from: key list + brand list + our hosted origins. */
export function allowedOriginsFor(key: ApiKeyRow, brand: BrandRow, publicOrigin: string): string[] {
  const cfg = resolveConfig(brand);
  const list = [...parseJson<string[]>(key.allowed_origins, []), ...cfg.settings.domains.allowed_origins, publicOrigin];
  if (cfg.settings.domains.hosted_hostname) list.push(`https://${cfg.settings.domains.hosted_hostname}`);
  return list;
}

export function isOriginAllowed(origin: string | null, allowed: string[]): boolean {
  if (!origin || origin === 'null') return false;
  return allowed.some((p) => originMatches(origin, p));
}

// ---------- attendee + host tokens ----------

export const SESSION_TOKEN_TTL_S = 4 * 3600;

export interface SessionClaims extends SignedClaims {
  typ: 'sess';
  rid: string;   // registrant
  sid: string;   // session
  wid: string;   // webinar
  bid: string;   // brand
  mode: Mode;
  dev: string;   // device id (concurrency limit)
}

export interface HostClaims extends SignedClaims {
  typ: 'host';
  sid: string;
  wid: string;
  bid: string;
  mode: Mode;
  role: 'host' | 'moderator';
  name: string;
  hid: string;
}

export function mintSessionToken(secret: string, c: Omit<SessionClaims, 'typ' | 'exp'>, nowMs = Date.now()) {
  return signToken(secret, { ...c, typ: 'sess', exp: Math.floor(nowMs / 1000) + SESSION_TOKEN_TTL_S });
}

export function readSessionToken(secret: string, token: string, nowMs = Date.now()) {
  return verifyToken<SessionClaims>(secret, token, 'sess', Math.floor(nowMs / 1000));
}

export function mintHostToken(secret: string, c: Omit<HostClaims, 'typ' | 'exp'>, ttlS = 12 * 3600, nowMs = Date.now()) {
  return signToken(secret, { ...c, typ: 'host', exp: Math.floor(nowMs / 1000) + ttlS });
}

export function readHostToken(secret: string, token: string, nowMs = Date.now()) {
  return verifyToken<HostClaims>(secret, token, 'host', Math.floor(nowMs / 1000));
}

/** Magic-link token: opaque random; only its hash is stored (registrants.token_hash). */
export function newMagicToken(): string {
  return `ml_${randomString(40)}`;
}
