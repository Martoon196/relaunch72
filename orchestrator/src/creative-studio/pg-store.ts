/** PostgreSQL creative library: every call goes through app_private.creative_studio_command with a genuine owner session. */
import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { withTransaction } from '../db/transaction.js';
import type { PgSeoBlogPrincipal } from '../seo-blog/pg-store.js';
import { SeoBlogError } from '../seo-blog/types.js';
import type { CommandReceipt, CreativeLibraryStore, CreativeSetRecord, CreativeSetSummary } from './store.js';
import type { DeliveryRecord, OutcomeRead } from './distribution.js';
import type { DistributionReadPort } from './service.js';
import type { LearningStore, PatternDecision, PatternRow, RecordedFinding } from './learning.js';
import type { BrandKit, ContextInputs, CreativeApproval, CreativeHandoff, CreativeSet, CreativeVersion } from './types.js';

/** The claim of one durable render job; SQL lets a worker act only for that job's sponsor and command while it holds the lease. */
export interface RenderJobClaim { readonly id: string; readonly leaseOwner: string; readonly attempt: number }

export class PgCreativeLibraryStore implements CreativeLibraryStore {
  private readonly sessionHash: Buffer | null;
  constructor(private readonly pool: Pick<Pool, 'connect'>, private readonly principal: PgSeoBlogPrincipal, private readonly renderJob?: RenderJobClaim) {
    this.sessionHash = principal.kind === 'user' ? createHash('sha256').update(principal.sessionToken).digest() : null;
  }
  private async call<T>(brandId: string, action: string, input: Record<string, unknown> = {}): Promise<T> {
    const p = this.principal;
    if (p.kind !== 'user' && !this.renderJob) throw new SeoBlogError(403, 'Creative work requires a signed-in owner.');
    try {
      if (p.kind !== 'user') {
        const bound = { ...input, job: { id: this.renderJob!.id, leaseOwner: this.renderJob!.leaseOwner, attempt: String(this.renderJob!.attempt) } };
        return await withTransaction(this.pool, { actorKind: 'worker', workspaceId: brandId, requestId: p.requestId }, async (t) =>
          (await t.query<{ value: T }>('SELECT app_private.creative_studio_command($1,NULL,$2,$3) AS value', [brandId, action, JSON.stringify(bound)])).rows[0]!.value);
      }
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
  /** Worker only: the sponsor this render job may act for, confirmed by SQL against the live claim and membership. */
  renderActor(brandId: string): Promise<string> { return this.call(brandId, 'render_actor'); }
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

/** Read-only distribution views through app_private.creative_studio_distribution (0143): existing receipts and CRM outcomes only. */
export class PgCreativeDistributionReader implements DistributionReadPort {
  private readonly sessionHash: Buffer | null;
  constructor(private readonly pool: Pick<Pool, 'connect'>, private readonly principal: PgSeoBlogPrincipal) {
    this.sessionHash = principal.kind === 'user' ? createHash('sha256').update(principal.sessionToken).digest() : null;
  }
  private async read<T>(brandId: string, action: 'delivery' | 'outcomes', input: Record<string, unknown>): Promise<T> {
    const p = this.principal;
    if (p.kind !== 'user') throw new SeoBlogError(403, 'Distribution views require a signed-in owner.');
    try { return await this.transaction<T>(brandId, action, input); } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === '42501') throw new SeoBlogError(403, 'The current owner session or brand permission could not be confirmed.');
      if (code === '22023' || code === '22P02') throw new SeoBlogError(400, 'Check the distribution request and try again.');
      throw e;
    }
  }
  private transaction<T>(brandId: string, action: string, input: Record<string, unknown>): Promise<T> {
    const p = this.principal as Extract<PgSeoBlogPrincipal, { kind: 'user' }>;
    return withTransaction(this.pool, { actorKind: 'user', workspaceId: brandId, userId: p.userId, requestId: p.requestId }, async (t) => {
      const guard = await t.query<{ ok: boolean }>('SELECT app_private.lock_active_portal_session($1,$2,$3) AS ok', [this.sessionHash, p.userId, p.selectedWorkspaceId]);
      if (guard.rows[0]?.ok !== true) throw new SeoBlogError(401, 'Sign in again to continue.');
      return (await t.query<{ value: T }>('SELECT app_private.creative_studio_distribution($1,$2,$3,$4) AS value', [brandId, this.sessionHash, action, JSON.stringify(input)])).rows[0]!.value;
    });
  }
  async delivery(brandId: string, queueIntentIds: readonly string[]): Promise<DeliveryRecord[]> {
    const rows = await this.read<DeliveryRecord[]>(brandId, 'delivery', { queues: queueIntentIds.slice(0, 64) });
    return rows.map((r) => ({ ...r, events: r.events.map((e) => ({ ...e, at: new Date(e.at).toISOString() })) }));
  }
  async outcomes(brandId: string, utmCampaign: string): Promise<OutcomeRead> {
    const read = await this.read<OutcomeRead>(brandId, 'outcomes', { utmCampaign });
    const iso = (v: string | null) => (v ? new Date(v).toISOString() : null);
    return { ...read, readAt: iso(read.readAt)!, buckets: read.buckets.map((b) => ({ ...b, firstAt: iso(b.firstAt), lastAt: iso(b.lastAt) })) };
  }
}

/** Owner enquiry-capture settings through app_private.creative_studio_capture_setup (0144 section 6). */
export interface EnquirySettings {
  readonly configured: boolean; readonly enabled: boolean; readonly publicKey: string | null; readonly privacyUrl: string | null; readonly ownerUserId: string | null;
  readonly pipelineId: string | null; readonly pipelineName: string | null; readonly newStageId: string | null; readonly qualifiedStageId: string | null; readonly rowVersion: number;
  readonly stages: readonly { id: string; name: string; type: 'open' | 'won' | 'lost'; position: number }[]; readonly touches: number;
}
export class PgCreativeEnquirySettings {
  private readonly sessionHash: Buffer | null;
  constructor(private readonly pool: Pick<Pool, 'connect'>, private readonly principal: PgSeoBlogPrincipal) {
    this.sessionHash = principal.kind === 'user' ? createHash('sha256').update(principal.sessionToken).digest() : null;
  }
  async call(brandId: string, input: Record<string, unknown>): Promise<EnquirySettings> {
    const p = this.principal;
    if (p.kind !== 'user') throw new SeoBlogError(403, 'Enquiry settings require a signed-in owner.');
    try {
      return await withTransaction(this.pool, { actorKind: 'user', workspaceId: brandId, userId: p.userId, requestId: p.requestId }, async (t) => {
        const guard = await t.query<{ ok: boolean }>('SELECT app_private.lock_active_portal_session($1,$2,$3) AS ok', [this.sessionHash, p.userId, p.selectedWorkspaceId]);
        if (guard.rows[0]?.ok !== true) throw new SeoBlogError(401, 'Sign in again to continue.');
        return (await t.query<{ value: EnquirySettings }>('SELECT app_private.creative_studio_capture_setup($1,$2,$3) AS value', [brandId, this.sessionHash, JSON.stringify(input)])).rows[0]!.value;
      });
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === '42501') throw new SeoBlogError(403, 'The current owner session or brand permission could not be confirmed.');
      if (code === '40001') throw new SeoBlogError(409, 'Enquiry settings changed. Refresh and try again.');
      if (code === '22023' || code === '22P02' || code === '23514') throw new SeoBlogError(400, (e as Error).message.slice(0, 200));
      throw e;
    }
  }
}

/** Learning journal and authorised patterns through app_private.creative_studio_learning (0143). */
export class PgCreativeLearningStore implements LearningStore {
  private readonly sessionHash: Buffer | null;
  constructor(private readonly pool: Pick<Pool, 'connect'>, private readonly principal: PgSeoBlogPrincipal) {
    this.sessionHash = principal.kind === 'user' ? createHash('sha256').update(principal.sessionToken).digest() : null;
  }
  private async call<T>(brandId: string, action: string, input: Record<string, unknown>): Promise<T> {
    const p = this.principal;
    if (p.kind !== 'user') throw new SeoBlogError(403, 'Learning records require a signed-in owner.');
    try {
      return await withTransaction(this.pool, { actorKind: 'user', workspaceId: brandId, userId: p.userId, requestId: p.requestId }, async (t) => {
        const guard = await t.query<{ ok: boolean }>('SELECT app_private.lock_active_portal_session($1,$2,$3) AS ok', [this.sessionHash, p.userId, p.selectedWorkspaceId]);
        if (guard.rows[0]?.ok !== true) throw new SeoBlogError(401, 'Sign in again to continue.');
        return (await t.query<{ value: T }>('SELECT app_private.creative_studio_learning($1,$2,$3,$4) AS value', [brandId, this.sessionHash, action, JSON.stringify(input)])).rows[0]!.value;
      });
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === '40001' || code === '23505') throw new SeoBlogError(409, 'This request was already used for something else. Refresh and try again.');
      if (code === '42501') throw new SeoBlogError(403, 'The current owner session or brand permission could not be confirmed.');
      if (code === '22023' || code === '23514' || code === '22P02') throw new SeoBlogError(400, (e as Error).message.slice(0, 300));
      if (code === '55000') throw new SeoBlogError(409, (e as Error).message.slice(0, 300));
      throw e;
    }
  }
  recordFinding(brandId: string, commandId: string, inputSha: string, finding: RecordedFinding) { return this.call<{ replayed: boolean; id: string }>(brandId, 'finding_record', { commandId, inputSha, finding }); }
  async listFindings(brandId: string, campaignId?: string): Promise<RecordedFinding[]> {
    const rows = await this.call<{ data: RecordedFinding; recordedAt: string }[]>(brandId, 'finding_list', campaignId ? { campaignId } : {});
    return rows.map((r) => ({ ...r.data, recordedAt: new Date(r.recordedAt).toISOString() }));
  }
  decidePattern(brandId: string, commandId: string, inputSha: string, decision: PatternDecision) {
    return this.call<{ replayed: boolean; id: string }>(brandId, decision.state === 'shared' ? 'pattern_share' : 'pattern_withdraw', { commandId, inputSha, pattern: decision });
  }
  async patterns(brandId: string, scope: 'mine' | 'other'): Promise<PatternRow[]> {
    const rows = await this.call<PatternRow[]>(brandId, scope === 'mine' ? 'patterns_mine' : 'patterns_other', {});
    return rows.map((r) => ({ ...r, decidedAt: new Date(r.decidedAt).toISOString() }));
  }
}
