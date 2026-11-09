import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { MhpCommerceError } from './commerce-service.js';

export interface MhpHqSnapshot {
  people: { id: string; name: string; email: string }[];
  products: { id: string; sku: string; name: string }[];
  grants: { id: string; accountId: string; name: string; email: string; productName: string;
    startsAt: string; endsAt: string | null; note: string; grantedBy: string; grantedAt: string }[];
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const hash = (token: string): Buffer => {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new MhpCommerceError(403, 'Sign in to Martin Howard Property again.');
  return createHash('sha256').update(token).digest();
};
function failure(error: unknown): never {
  if (error instanceof MhpCommerceError) throw error;
  const code = (error as { code?: string })?.code;
  if (code === '42501') throw new MhpCommerceError(403, 'Owner access is required for HQ.');
  if (code === '22023') throw new MhpCommerceError(400, 'Check the person, product, expiry and reason.');
  if (code === '40001' || code === '23505') throw new MhpCommerceError(409, 'This grant changed. Reload HQ before trying again.');
  throw new MhpCommerceError(503, 'Access management is temporarily unavailable.');
}

export class PgMhpHqService {
  constructor(private readonly readPool: Pick<Pool, 'query'>, private readonly commandPool: Pick<Pool, 'query'>) {}
  async isOwner(token: string): Promise<boolean> {
    try {
      const result = await this.readPool.query<{ allowed: boolean }>('SELECT app_private.mhp_is_owner($1) AS allowed', [hash(token)]);
      return result.rows[0]?.allowed === true;
    } catch (error) { failure(error); }
  }
  async snapshot(token: string, search = ''): Promise<MhpHqSnapshot> {
    if (search.length > 200 || /[\u0000-\u001f\u007f]/.test(search)) throw new MhpCommerceError(400, 'Use a shorter name or email to search.');
    try {
      const result = await this.readPool.query<{ snapshot: MhpHqSnapshot }>(
        'SELECT app_private.mhp_hq_snapshot($1,$2) AS snapshot', [hash(token), search.trim() || null]);
      const snapshot = result.rows[0]?.snapshot;
      if (!snapshot || !Array.isArray(snapshot.people) || !Array.isArray(snapshot.products) || !Array.isArray(snapshot.grants)) {
        throw new MhpCommerceError(503, 'HQ could not load.');
      }
      return snapshot;
    } catch (error) { failure(error); }
  }
  async grant(token: string, form: Record<string, string>, now = Date.now()): Promise<string> {
    const email = (form.targetEmail ?? '').trim().toLowerCase();
    const name = (form.targetName ?? '').trim();
    const note = (form.note ?? '').trim();
    if (!uuid.test(form.commandId ?? '') || !uuid.test(form.productId ?? '')
        || !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(email) || email.length > 320
        || name.length > 200 || note.length < 1 || note.length > 1000
        || /[\u0000-\u001f\u007f]/.test(name) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(note)) {
      throw new MhpCommerceError(400, 'Choose a person and product, and add an audit reason.');
    }
    let endsAt: string | null = null;
    if (form.endsAt) {
      const value = form.endsAt;
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) throw new MhpCommerceError(400, 'Choose a valid future expiry in UTC.');
      const parsed = Date.parse(`${value}:00Z`);
      if (!Number.isFinite(parsed) || parsed <= now || new Date(parsed).toISOString().slice(0, 16) !== value) {
        throw new MhpCommerceError(400, 'Choose a valid future expiry in UTC.');
      }
      endsAt = new Date(parsed).toISOString();
    }
    try {
      const result = await this.commandPool.query<{ id: string }>(
        'SELECT app_private.mhp_grant_manual_access($1,$2,$3,$4,$5,$6,$7) AS id',
        [hash(token), form.commandId, email, name || null, form.productId, endsAt, note]);
      const id = result.rows[0]?.id;
      if (!id || !uuid.test(id)) throw new MhpCommerceError(503, 'The access grant was not confirmed.');
      return id;
    } catch (error) { failure(error); }
  }
}
