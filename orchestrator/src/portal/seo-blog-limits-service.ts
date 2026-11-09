import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { withTransaction, InactivePortalSessionError } from '../db/transaction.js';
import { SeoBlogError } from '../seo-blog/types.js';
import type { LimitKey, OperatorLimits } from '../seo-blog/limits.js';
import type { PortalSessionIdentity } from './auth-service.js';

export interface LimitsBrand {
  id: string; name: string; owner: string; rowVersion: number;
  limits: Record<LimitKey, number | null>;
  usage: { modelTokens: number; searchCalls: number; images: number; studioImages: number };
  managed: boolean;
}
export interface LimitsPageData {
  brands: LimitsBrand[];
  policy: { version: number; enabled: boolean; maxConcurrency: number; monthlyMicrousd: number; monthlyUnlimited?: boolean };
}
export interface SeoLimitsService {
  allowed(): Promise<boolean>;
  list(): Promise<LimitsPageData>;
  save(target: string, rowVersion: number, limits: Pick<OperatorLimits, LimitKey>): Promise<void>;
  policy(version: number, input: { enabled: boolean; concurrency: number; monthlyMicrousd: number | null }): Promise<void>;
}
export class PgSeoLimitsService implements SeoLimitsService {
  constructor(private readonly pool: Pick<Pool, 'connect'>, private readonly identity: PortalSessionIdentity, private readonly requestId: string) {}
  private async command(action: string, input: object): Promise<unknown> {
    const i = this.identity;
    return withTransaction(this.pool, { actorKind: 'user', workspaceId: i.workspaceId, userId: i.userId, requestId: this.requestId }, async t => {
      const hash = createHash('sha256').update(i.sessionToken).digest();
      const ok = await t.query<{ ok: boolean }>('SELECT app_private.lock_active_portal_session($1,$2,$3) AS ok', [hash, i.userId, i.workspaceId]);
      if (ok.rows[0]?.ok !== true) throw new InactivePortalSessionError();
      const ready = await t.query<{ ready: boolean }>("SELECT to_regprocedure('app_private.seo_limits_command(uuid,bytea,text,jsonb)') IS NOT NULL AS ready");
      if (!ready.rows[0]?.ready) {
        if (action === 'allowed') return false;
        throw new SeoBlogError(503, 'Usage controls are being installed. Try again shortly.');
      }
      return (await t.query<{ value: unknown }>('SELECT app_private.seo_limits_command($1,$2,$3,$4) AS value', [i.workspaceId, hash, action, JSON.stringify(input)])).rows[0]?.value;
    }).catch(e => {
      if ((e as { code?: string }).code === '42501') throw new SeoBlogError(403, 'Only the founder can manage account limits.');
      if ((e as { code?: string }).code === '40001') throw new SeoBlogError(409, 'These limits changed. Refresh and review the current values.');
      if ((e as { code?: string }).code === '22023') throw new SeoBlogError(400, 'Choose whole-number limits or Unlimited.');
      throw e;
    });
  }
  async allowed(): Promise<boolean> { try { return await this.command('allowed', {}) === true; } catch (e) { if (e instanceof SeoBlogError && e.status === 403) return false; throw e; } }
  async list(): Promise<LimitsPageData> { return await this.command('list', {}) as LimitsPageData; }
  async save(target: string, rowVersion: number, limits: Pick<OperatorLimits, LimitKey>): Promise<void> { await this.command('set', { target, rowVersion, limits }); }
  async policy(version: number, input: { enabled: boolean; concurrency: number; monthlyMicrousd: number | null }): Promise<void> { await this.command('policy', { version, ...input }); }
}
