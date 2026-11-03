/** Read-only provider inventory. Output is filtered to the exact brand before it leaves this module. */
import { createHash } from 'node:crypto';
import type { PromotionNetwork } from './types.js';

export interface DiscoveredSocialProfile {
  readonly id: string;
  readonly name: string;
  readonly alreadyRegistered: boolean;
  readonly selectable: boolean;
  readonly hold: string | null;
}
export interface DiscoveredSocialAccount {
  readonly id: string;
  readonly profileId: string;
  readonly network: string;
  readonly username: string | null;
  readonly displayName: string | null;
  readonly active: boolean;
  readonly supported: boolean;
  readonly sha256: string;
}
export interface SocialDiscovery {
  readonly state: 'available' | 'unconfigured' | 'unavailable';
  readonly profiles: readonly DiscoveredSocialProfile[];
  readonly accounts: readonly DiscoveredSocialAccount[];
  readonly checkedAt: string | null;
  readonly detail: string;
}
export interface SocialProviderInventory {
  discover(input: { readonly brandId: string; readonly registeredProfileId: string | null; readonly reservedProfileIds: readonly string[];
    /** Server lookup only; cannot be supplied by the browser or inferred from a name. */
    registeredBrandFor(profileId: string): Promise<string | null> }): Promise<SocialDiscovery>;
}
const OBJECT_ID = /^[0-9a-f]{24}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const MAX_BYTES = 1_000_000, MAX_ITEMS = 500;
const supported = (network: string): network is PromotionNetwork => network === 'instagram' || network === 'linkedin';
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function name(value: unknown, required = false): string | null {
  if (value === null || value === undefined || value === '') { if (required) throw new Error('Invalid provider name'); return null; }
  if (typeof value !== 'string' || value !== value.trim() || value.length > 160 || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error('Invalid provider name');
  return value;
}
function objectId(value: unknown): string {
  if (typeof value !== 'string' || !OBJECT_ID.test(value)) throw new Error('Invalid provider identity'); return value;
}
async function boundedJson(response: Response): Promise<Record<string, unknown>> {
  if (!response.ok || response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') { await response.body?.cancel().catch(() => undefined); throw new Error('Provider inventory unavailable'); }
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d{1,8}$/u.test(declared) || Number(declared) > MAX_BYTES)) { await response.body?.cancel().catch(() => undefined); throw new Error('Provider inventory too large'); }
  const reader = response.body?.getReader(); if (!reader) throw new Error('Provider inventory missing');
  const chunks: Uint8Array[] = []; let length = 0;
  try {
    while (true) { const part = await reader.read(); if (part.done) break; length += part.value.byteLength; if (length > MAX_BYTES) throw new Error('Provider inventory too large'); chunks.push(part.value); }
  } catch (error) { await reader.cancel().catch(() => undefined); throw error; }
  const bytes = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (!record(parsed)) throw new Error('Invalid provider inventory'); return parsed;
}

export function createSocialProviderInventory(input: { readonly apiKey: string | null; readonly fetch: typeof globalThis.fetch; readonly now?: () => string }): SocialProviderInventory {
  const key = input.apiKey?.trim() || null;
  const now = input.now ?? (() => new Date().toISOString());
  const unavailable = (state: 'unconfigured' | 'unavailable'): SocialDiscovery => ({ state, profiles: [], accounts: [], checkedAt: null,
    detail: state === 'unconfigured' ? 'Account discovery is not configured on this server.' : 'Provider accounts could not be verified. Existing bindings have not been changed.' });
  async function get(path: string): Promise<Record<string, unknown>> {
    // Fixed service origin and literal GET paths only; no caller URL or credential redirects.
    return boundedJson(await input.fetch(`https://zernio.com/api/v1/${path}`, { method: 'GET', redirect: 'error', headers: { authorization: `Bearer ${key}`, accept: 'application/json' }, signal: AbortSignal.timeout(10_000) }));
  }
  return { async discover({ brandId, registeredProfileId, reservedProfileIds, registeredBrandFor }) {
    if (!UUID.test(brandId)) throw new Error('Invalid brand');
    if (!key) return unavailable('unconfigured');
    const reserved = new Set(reservedProfileIds);
    try {
      const body = await get('profiles?includeOverLimit=true');
      if (!Array.isArray(body.profiles) || body.profiles.length > MAX_ITEMS) throw new Error('Invalid profiles');
      const profiles: DiscoveredSocialProfile[] = [], accounts: DiscoveredSocialAccount[] = [];
      const seen = new Set<string>();
      for (const raw of body.profiles) {
        if (!record(raw)) throw new Error('Invalid profile');
        const id = objectId(raw.id ?? raw._id);
        if (seen.has(id)) throw new Error('Duplicate profile'); seen.add(id);
        // Never expose another unclaimed global profile's name or raw account IDs.
        if (id !== registeredProfileId && raw.externalId !== brandId) continue;
        const registeredBrand = await registeredBrandFor(id);
        if (registeredBrand && registeredBrand !== brandId) continue;
        const existing = id === registeredProfileId;
        if (reserved.has(id) && !existing) continue;
        const hold = reserved.has(id) ? 'Reserved by an existing application; reassignment is not available.'
          : raw.isOverLimit === true ? 'This provider profile is over its plan allowance.' : null;
        profiles.push({ id, name: name(raw.name, true)!, alreadyRegistered: existing, selectable: !existing && !hold, hold });
        if (!existing || hold) continue; // Only the currently registered brand profile can expose account choices.
        const listed = await get(`accounts?profileId=${encodeURIComponent(id)}&includeOverLimit=true`);
        if (!Array.isArray(listed.accounts) || listed.accounts.length > MAX_ITEMS) throw new Error('Invalid accounts');
        const accountIds = new Set<string>();
        for (const value of listed.accounts) {
          if (!record(value)) throw new Error('Invalid account');
          const accountId = objectId(value._id ?? value.id ?? value.accountId);
          if (accountIds.has(accountId)) throw new Error('Duplicate account'); accountIds.add(accountId);
          const profileId = objectId(record(value.profileId) ? value.profileId._id ?? value.profileId.id : value.profileId);
          if (profileId !== id || typeof value.platform !== 'string' || !/^[a-z][a-z0-9_]{0,39}$/u.test(value.platform)
            || (value.isActive !== undefined && typeof value.isActive !== 'boolean')) throw new Error('Account outside selected profile');
          accounts.push({ id: accountId, profileId, network: value.platform, username: name(value.username), displayName: name(value.displayName),
            active: value.isActive === true, supported: supported(value.platform), sha256: createHash('sha256').update(accountId).digest('hex') });
        }
      }
      if (registeredProfileId && !profiles.some(p => p.id === registeredProfileId)) return unavailable('unavailable');
      return { state: 'available', profiles, accounts, checkedAt: now(), detail: profiles.length ? 'Choose the exact brand profile and a verified connected account. A provider listing alone does not authorize publishing.' : 'No provider profile is explicitly linked to this brand. In Zernio, set its externalId to this brand workspace ID, then refresh. Other profiles remain private.' };
    } catch { return unavailable('unavailable'); }
  } };
}
