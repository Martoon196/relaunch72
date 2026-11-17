import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { parseCookies } from '../server/admin/session.js';

/**
 * The short "what just happened" note carried across the redirect after an owner action on the MHP
 * marketing pages. It is signed to the session, the page area, the exact item and version, and the moment
 * of the action. It is shown only on that item and version, for a few minutes, and only while it is the
 * owner's latest action in this browser (a cookie holds the id of the latest one), so going back or
 * reloading after a later action never shows an older result. It never carries a name or an address.
 */
export const MHP_NOTE_COOKIE = 'mhp_owner_note';
export const MHP_NOTE_TTL_MS = 5 * 60_000;
export type MhpNoteScope = 'sequences' | 'emails';
const mac = (secret: string, parts: readonly string[]) => createHmac('sha256', secret).update(parts.join('\n')).digest('hex').slice(0, 32);
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function signMhpNote(secret: string, session: string, scope: MhpNoteScope, place: { itemId: string; versionId: string }, now: number, note: object): { query: string; cookie: string } {
  // k identifies this action; the cookie remembers the latest k, so an older note is never shown again.
  const k = randomBytes(9).toString('base64url');
  const value = Buffer.from(JSON.stringify({ ...note, i: place.itemId, v: place.versionId, t: now, k })).toString('base64url');
  return { query: `&note=${value}&sig=${mac(secret, ['mhp.owner-note/v2', scope, session, value])}`,
    cookie: `${MHP_NOTE_COOKIE}=${k}; Path=/hq/marketing; HttpOnly; Secure; SameSite=Strict; Max-Age=600` };
}
export function readMhpNote<T extends object>(secret: string, session: string, scope: MhpNoteScope, input: { value: string | null; sig: string | null;
  cookie: string | undefined; itemId: string | null; versionId: string | null; now: number }): T | undefined {
  const { value, sig } = input;
  if (!value || !sig || value.length > 800 || !input.itemId || !input.versionId || !same(sig, mac(secret, ['mhp.owner-note/v2', scope, session, value]))) return undefined;
  let note: T & { i?: unknown; v?: unknown; t?: unknown; k?: unknown };
  try { note = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')); } catch { return undefined; }
  if (!note || typeof note !== 'object' || note.i !== input.itemId || note.v !== input.versionId || typeof note.t !== 'number') return undefined;
  if (input.now - note.t > MHP_NOTE_TTL_MS || note.t > input.now + 60_000) return undefined;
  const latest = parseCookies(input.cookie)[MHP_NOTE_COOKIE];
  if (latest !== undefined && latest !== note.k) return undefined;
  return note;
}
