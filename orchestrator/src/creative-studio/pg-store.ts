/** PostgreSQL creative library: every call goes through app_private.creative_studio_command with a genuine owner session. */
import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { withTransaction } from '../db/transaction.js';
import type { PgSeoBlogPrincipal } from '../seo-blog/pg-store.js';
import { SeoBlogError } from '../seo-blog/types.js';
import type { CommandReceipt, CreativeLibraryStore, CreativeSetRecord, CreativeSetSummary } from './store.js';
import type { BrandKit, ContextInputs, CreativeApproval, CreativeHandoff, CreativeSet, CreativeVersion } from './types.js';

export class PgCreativeLibraryStore implements CreativeLibraryStore {
  private readonly sessionHash: Buffer | null;
  constructor(private readonly pool: Pick<Pool, 'connect'>, private readonly principal: PgSeoBlogPrincipal) {
    this.sessionHash = principal.kind === 'user' ? createHash('sha256').update(principal.sessionToken).digest() : null;
  }
  private async call<T>(brandId: string, action: string, input: Record<string, unknown> = {}): Promise<T> {
    const p = this.principal;
    if (p.kind !== 'user') throw new SeoBlogError(403, 'Creative work requires a signed-in owner.');
    try {
      return await withTransaction(this.pool, { actorKind: 'user', workspaceId: brandId, userId: p.userId, requestId: p.requestId }, async (t) => {
        const guard = await t.query<{ ok: boolean }>('SELECT app_private.lock_active_portal_session($1,$2,$3) AS ok', [this.sessionHash, p.userId, p.selectedWorkspaceId]);
        if (guard.rows[0]?.ok !== true) throw new SeoBlogError(401, 'Sign in again to continue.');
        return (await t.query<{ value: T }>('SELECT app_private.creative_studio_command($1,$2,$3,$4) AS value', [brandId, this.sessionHash, action, JSON.stringify(input)])).rows[0]!.value;
      });
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === '40001' || code === '23505') throw new SeoBlogError(409, 'This artwork changed or the request was already used. Refresh and review the current version.');
      if (code === '42501') throw new SeoBlogError(403, 'The current owner session or brand permission could not be confirmed.');
      if (code === '22023' || code === '23514' || code === '22P02') throw new SeoBlogError(400, 'Check the artwork details and try again.');
      if (code === '55000') throw new SeoBlogError(409, (e as Error).message.slice(0, 300));
      throw e;
    }
  }
  latestKit(brandId: string): Promise<BrandKit | null> { return this.call(brandId, 'kit_latest'); }
  saveKit(brandId: string, commandId: string, inputSha: string, kit: BrandKit): Promise<CommandReceipt> { return this.call(brandId, 'kit_save', { commandId, inputSha, kit }); }
  commandResult(brandId: string, commandId: string, inputSha: string): Promise<CommandReceipt | null> { return this.call(brandId, 'command_get', { commandId, inputSha }); }
  createSet(brandId: string, commandId: string, inputSha: string, set: CreativeSet, versions: readonly CreativeVersion[], _current: ContextInputs): Promise<CommandReceipt> {
    return this.call(brandId, 'set_create', { commandId, inputSha, set, versions });
  }
  appendVersions(brandId: string, commandId: string, inputSha: string, setId: string, versions: readonly CreativeVersion[], _current: ContextInputs): Promise<CommandReceipt> {
    return this.call(brandId, 'versions_append', { commandId, inputSha, setId, versions });
  }
  approve(brandId: string, commandId: string, inputSha: string, approval: CreativeApproval, _current: ContextInputs): Promise<CommandReceipt> { return this.call(brandId, 'approve', { commandId, inputSha, approval }); }
  handoff(brandId: string, commandId: string, inputSha: string, handoff: CreativeHandoff, _current: ContextInputs): Promise<CommandReceipt> { return this.call(brandId, 'handoff', { commandId, inputSha, handoff }); }
  getSet(brandId: string, setId: string): Promise<CreativeSetRecord | null> { return this.call(brandId, 'set_get', { setId }); }
  listSets(brandId: string): Promise<CreativeSetSummary[]> { return this.call(brandId, 'set_list'); }
  getVersion(brandId: string, versionId: string): Promise<{ version: CreativeVersion; head: boolean; approval: CreativeApproval | null } | null> { return this.call(brandId, 'version_get', { versionId }); }
}
