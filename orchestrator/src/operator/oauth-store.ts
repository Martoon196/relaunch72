/**
 * Durable OAuth state for the operator API (migration 0148). Every call goes
 * through a security-definer function on the identity command pool; only
 * SHA-256 hashes of codes, tokens, client ids and redirect URIs reach the database.
 */
import type { Pool } from 'pg';

export type RedeemOutcome = 'issued' | 'replayed' | 'invalid';
export type RefreshOutcome = 'issued' | 'reused' | 'client_mismatch' | 'invalid';

export interface OperatorGrantRow {
  readonly grantId: string;
  readonly clientName: string;
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
  readonly revokedAt: string | null;
  readonly revokedReason: string | null;
}

export interface OperatorOAuthStore {
  issueCode(input: { codeHash: Buffer; clientIdHash: Buffer; clientName: string; redirectUriHash: Buffer; codeChallenge: string; subject: string; now: Date; expiresAt: Date }): Promise<boolean>;
  redeemCode(input: { codeHash: Buffer; clientIdHash: Buffer; redirectUriHash: Buffer; verifierChallenge: string; accessHash: Buffer; accessExpiresAt: Date; refreshHash: Buffer; refreshExpiresAt: Date; now: Date }): Promise<{ outcome: RedeemOutcome; subject: string | null }>;
  refresh(input: { refreshHash: Buffer; clientIdHash: Buffer; accessHash: Buffer; accessExpiresAt: Date; newRefreshHash: Buffer; refreshExpiresAt: Date; now: Date }): Promise<{ outcome: RefreshOutcome; subject: string | null }>;
  resolve(accessHash: Buffer, now: Date): Promise<string | null>;
  revokeToken(tokenHash: Buffer, clientIdHash: Buffer, now: Date): Promise<boolean>;
  listGrants(subject: string): Promise<readonly OperatorGrantRow[]>;
  revokeGrant(subject: string, grantId: string, now: Date): Promise<boolean>;
}

const iso = (value: unknown): string | null => value instanceof Date ? value.toISOString() : typeof value === 'string' ? new Date(value).toISOString() : null;
const REDEEM = new Set<RedeemOutcome>(['issued', 'replayed', 'invalid']);
const REFRESH = new Set<RefreshOutcome>(['issued', 'reused', 'client_mismatch', 'invalid']);

export class PgOperatorOAuthStore implements OperatorOAuthStore {
  constructor(private readonly pool: Pick<Pool, 'query'>) {}

  async issueCode(i: Parameters<OperatorOAuthStore['issueCode']>[0]): Promise<boolean> {
    const r = await this.pool.query<{ ok: boolean }>(`/* operator.oauth.issue-code */
      SELECT app_private.operator_oauth_issue_code($1,$2,$3,$4,$5,$6,$7,$8) AS ok`,
      [i.codeHash, i.clientIdHash, i.clientName, i.redirectUriHash, i.codeChallenge, i.subject, i.now, i.expiresAt]);
    return r.rows[0]?.ok === true;
  }

  async redeemCode(i: Parameters<OperatorOAuthStore['redeemCode']>[0]) {
    const r = await this.pool.query<{ outcome: string; subject_user_id: string | null }>(`/* operator.oauth.redeem-code */
      SELECT outcome, subject_user_id FROM app_private.operator_oauth_redeem_code($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [i.codeHash, i.clientIdHash, i.redirectUriHash, i.verifierChallenge, i.accessHash, i.accessExpiresAt, i.refreshHash, i.refreshExpiresAt, i.now]);
    const row = r.rows[0];
    if (r.rows.length !== 1 || !row || !REDEEM.has(row.outcome as RedeemOutcome)) throw new Error('Invalid operator code redemption result');
    return { outcome: row.outcome as RedeemOutcome, subject: row.outcome === 'issued' ? row.subject_user_id : null };
  }

  async refresh(i: Parameters<OperatorOAuthStore['refresh']>[0]) {
    const r = await this.pool.query<{ outcome: string; subject_user_id: string | null }>(`/* operator.oauth.refresh */
      SELECT outcome, subject_user_id FROM app_private.operator_oauth_refresh($1,$2,$3,$4,$5,$6,$7)`,
      [i.refreshHash, i.clientIdHash, i.accessHash, i.accessExpiresAt, i.newRefreshHash, i.refreshExpiresAt, i.now]);
    const row = r.rows[0];
    if (r.rows.length !== 1 || !row || !REFRESH.has(row.outcome as RefreshOutcome)) throw new Error('Invalid operator refresh result');
    return { outcome: row.outcome as RefreshOutcome, subject: row.outcome === 'issued' ? row.subject_user_id : null };
  }

  async resolve(accessHash: Buffer, now: Date): Promise<string | null> {
    const r = await this.pool.query<{ subject_user_id: string }>(`/* operator.oauth.resolve */
      SELECT subject_user_id FROM app_private.operator_oauth_resolve($1,$2)`, [accessHash, now]);
    return r.rows.length === 1 ? r.rows[0]!.subject_user_id : null;
  }

  async revokeToken(tokenHash: Buffer, clientIdHash: Buffer, now: Date): Promise<boolean> {
    const r = await this.pool.query<{ ok: boolean }>(`/* operator.oauth.revoke-token */
      SELECT app_private.operator_oauth_revoke_token($1,$2,$3) AS ok`, [tokenHash, clientIdHash, now]);
    return r.rows[0]?.ok === true;
  }

  async listGrants(subject: string): Promise<readonly OperatorGrantRow[]> {
    const r = await this.pool.query(`/* operator.oauth.list-grants */
      SELECT grant_id, client_name, created_at, last_used_at, revoked_at, revoked_reason FROM app_private.operator_oauth_list_grants($1)`, [subject]);
    return r.rows.map((row) => Object.freeze({
      grantId: String(row.grant_id), clientName: String(row.client_name), createdAt: iso(row.created_at) ?? '',
      lastUsedAt: iso(row.last_used_at), revokedAt: iso(row.revoked_at), revokedReason: row.revoked_reason === null ? null : String(row.revoked_reason),
    }));
  }

  async revokeGrant(subject: string, grantId: string, now: Date): Promise<boolean> {
    const r = await this.pool.query<{ ok: boolean }>(`/* operator.oauth.revoke-grant */
      SELECT app_private.operator_oauth_revoke_grant($1,$2,$3) AS ok`, [subject, grantId, now]);
    return r.rows[0]?.ok === true;
  }
}
