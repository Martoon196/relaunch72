import { createHash, randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import type { PortalSessionIdentity } from '../portal/auth-service.js';
import { MHP_OPAQUE_TOKEN } from './auth-service.js';
import { MhpCommerceError } from './commerce-service.js';

export const MHP_MARKETING_WORKSPACE_ID = '2789228d-55a6-4688-b1e8-2f70abca990b';
export const MHP_MARKETING_ORGANIZATION_ID = 'ba41b1a4-9752-4dbf-8312-d04a0f03d0b8';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const digest = (value: string | Buffer): Buffer => createHash('sha256').update(value).digest();
function tokenHash(token: string): Buffer {
  if (!MHP_OPAQUE_TOKEN.test(token)) throw new MhpCommerceError(403, 'Sign in to Martin Howard Property again.');
  return digest(token);
}
function failed(error: unknown): never {
  if (error instanceof MhpCommerceError) throw error;
  const code = (error as { code?: string })?.code;
  if (code === '42501') throw new MhpCommerceError(403, 'Owner access to the MHP marketing workspace is required.');
  if (code === '40001' || code === '23505') throw new MhpCommerceError(409, 'The workspace selection changed. Sign in again before continuing.');
  throw new MhpCommerceError(503, 'The marketing workspace is temporarily unavailable.');
}
export interface MhpMarketingWorkspaceSnapshot {
  userId: string;
  selectedWorkspaceId: string;
  personalWorkspaceId: string;
  marketingWorkspaceId: typeof MHP_MARKETING_WORKSPACE_ID | null;
  marketingSelected: boolean;
}

/** No browser-selected workspace or actor reaches the SQL capability. */
export class PgMhpMarketingWorkspaceService {
  constructor(private readonly readPool: Pick<Pool, 'query'>,
    private readonly commandPool: Pick<Pool, 'query'>) {}

  async snapshot(identity: PortalSessionIdentity): Promise<MhpMarketingWorkspaceSnapshot> {
    try {
      const result = await this.readPool.query<{ snapshot: MhpMarketingWorkspaceSnapshot }>(
        'SELECT app_private.mhp_marketing_workspace_snapshot($1::bytea) AS snapshot',
        [tokenHash(identity.sessionToken)],
      );
      const value = result.rows[0]?.snapshot;
      if (result.rows.length !== 1 || !value || value.userId !== identity.userId
          || value.selectedWorkspaceId !== identity.workspaceId
          || !UUID.test(value.personalWorkspaceId) || value.personalWorkspaceId === MHP_MARKETING_WORKSPACE_ID
          || (value.marketingWorkspaceId !== null && value.marketingWorkspaceId !== MHP_MARKETING_WORKSPACE_ID)
          || typeof value.marketingSelected !== 'boolean'
          || value.marketingSelected !== (value.selectedWorkspaceId === MHP_MARKETING_WORKSPACE_ID)
          || (value.marketingSelected && value.marketingWorkspaceId === null)) {
        throw new MhpCommerceError(403, 'Sign in to your MHP workspace again.');
      }
      return Object.freeze({ ...value });
    } catch (error) { return failed(error); }
  }

  async select(identity: PortalSessionIdentity, action: 'open' | 'return', commandId: string,
    now = Date.now()): Promise<{ sessionToken: string; expiresAt: string; workspaceId: string }> {
    if (!UUID.test(commandId) || !['open', 'return'].includes(action)) {
      throw new MhpCommerceError(400, 'Refresh the workspace selection form.');
    }
    const sessionToken = randomBytes(32).toString('base64url');
    try {
      const result = await this.commandPool.query<{
        user_id: string; selected_workspace_id: string; expires_at: string | Date;
      }>('SELECT user_id,selected_workspace_id,expires_at FROM app_private.select_mhp_marketing_workspace($1::bytea,$2::text,$3::bytea,$4::bytea,$5::uuid)',
      [tokenHash(identity.sessionToken), action, digest(sessionToken), digest(randomBytes(32)), commandId]);
      const row = result.rows[0];
      const expiry = row?.expires_at instanceof Date ? row.expires_at.getTime() : Date.parse(row?.expires_at ?? '');
      if (result.rows.length !== 1 || !row || row.user_id !== identity.userId
          || !UUID.test(row.selected_workspace_id)
          || (action === 'open') !== (row.selected_workspace_id === MHP_MARKETING_WORKSPACE_ID)
          || !Number.isFinite(expiry) || expiry <= now || expiry > now + 24 * 60 * 60_000 + 60_000) {
        throw new MhpCommerceError(503, 'Workspace selection was not confirmed. Sign in again.');
      }
      return Object.freeze({ sessionToken, expiresAt: new Date(expiry).toISOString(), workspaceId: row.selected_workspace_id });
    } catch (error) { return failed(error); }
  }
}
