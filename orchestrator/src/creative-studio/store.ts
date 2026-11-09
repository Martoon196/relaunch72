/**
 * Creative library persistence boundary. Every write is an idempotent command:
 * the same command ID with the same input digest replays its first result;
 * a different input under that ID is refused. Versions, approvals and
 * hand-offs are append-only. The PostgreSQL adapter enforces these rules in a
 * SECURITY DEFINER boundary; this in-memory store mirrors them for tests.
 */
import { SeoBlogError } from '../seo-blog/types.js';
import type { BrandKit, ContextInputs, CreativeApproval, CreativeHandoff, CreativeSet, CreativeVersion } from './types.js';

export interface CreativeSetRecord {
  readonly set: CreativeSet;
  readonly versions: readonly CreativeVersion[];
  readonly approvals: readonly CreativeApproval[];
  readonly handoffs: readonly CreativeHandoff[];
}
export interface CreativeSetSummary {
  readonly set: CreativeSet;
  readonly versionCount: number;
  readonly approvedCount: number;
}
export interface CommandReceipt { readonly replayed: boolean; readonly id: string }

export interface CreativeLibraryStore {
  latestKit(brandId: string): Promise<BrandKit | null>;
  saveKit(brandId: string, commandId: string, inputSha: string, kit: BrandKit): Promise<CommandReceipt>;
  /** Earlier result for this command, or null. Conflicting input under one ID is refused. */
  commandResult(brandId: string, commandId: string, inputSha: string): Promise<CommandReceipt | null>;
  createSet(brandId: string, commandId: string, inputSha: string, set: CreativeSet, versions: readonly CreativeVersion[], current: ContextInputs): Promise<CommandReceipt>;
  appendVersions(brandId: string, commandId: string, inputSha: string, setId: string, versions: readonly CreativeVersion[], current: ContextInputs): Promise<CommandReceipt>;
  approve(brandId: string, commandId: string, inputSha: string, approval: CreativeApproval, current: ContextInputs): Promise<CommandReceipt>;
  handoff(brandId: string, commandId: string, inputSha: string, handoff: CreativeHandoff, current: ContextInputs): Promise<CommandReceipt>;
  getSet(brandId: string, setId: string): Promise<CreativeSetRecord | null>;
  listSets(brandId: string): Promise<CreativeSetSummary[]>;
  getVersion(brandId: string, versionId: string): Promise<{ version: CreativeVersion; head: boolean; approval: CreativeApproval | null } | null>;
}

export const variantKey = (v: Pick<CreativeVersion, 'conceptKey' | 'placement' | 'card'>) => `${v.conceptKey}:${v.placement}:${v.card}`;
const sameContext = (a: ContextInputs, b: ContextInputs) => a.profileVersion === b.profileVersion && a.factsSha === b.factsSha && a.kitVersion === b.kitVersion;

/** Shared invariant checks (also implemented independently in SQL). */
export function approvalProblem(version: CreativeVersion, head: boolean, approval: Pick<CreativeApproval, 'renderSha256' | 'figuresConfirmed' | 'context'>, current: ContextInputs): string | null {
  if (!head) return 'A newer version of this artwork exists. Review and approve the current version.';
  if (approval.renderSha256 !== version.render.sha256) return 'The artwork changed since you reviewed it. Review the current image.';
  if (!sameContext(version.context, current) || !sameContext(approval.context, current)) return 'Brand facts or the creative kit changed since this version was made. Refresh it from the current brand context before approval.';
  if (version.issues.some((i) => i.blocking)) return 'Resolve the blocking layout or copy issues before approval.';
  if (version.issues.some((i) => i.code === 'unsupported_figure') && !approval.figuresConfirmed) return 'Confirm the figures that are not in approved brand facts, or remove them, before approval.';
  return null;
}

export class MemoryCreativeLibraryStore implements CreativeLibraryStore {
  private readonly kits = new Map<string, BrandKit[]>();
  private readonly sets = new Map<string, CreativeSet>();
  private readonly versions = new Map<string, CreativeVersion>();
  private readonly approvals = new Map<string, CreativeApproval>();
  private readonly handoffs = new Map<string, CreativeHandoff>();
  private readonly commands = new Map<string, { inputSha: string; id: string }>();
  /** Test hook: membership is checked by the service; the SQL boundary checks it independently. */

  private command(brandId: string, commandId: string, inputSha: string): CommandReceipt | null {
    const saved = this.commands.get(`${brandId}:${commandId}`);
    if (!saved) return null;
    if (saved.inputSha !== inputSha) throw new SeoBlogError(409, 'This request was already used for different content. Refresh and try again.');
    return { replayed: true, id: saved.id };
  }
  private record(brandId: string, commandId: string, inputSha: string, id: string): CommandReceipt {
    this.commands.set(`${brandId}:${commandId}`, { inputSha, id });
    return { replayed: false, id };
  }
  private head(brandId: string, setId: string, key: string): CreativeVersion | null {
    let best: CreativeVersion | null = null;
    for (const v of this.versions.values()) if (v.brandId === brandId && v.setId === setId && variantKey(v) === key && (!best || v.number > best.number)) best = v;
    return best;
  }
  private insertVersions(brandId: string, setId: string, versions: readonly CreativeVersion[], current: ContextInputs): void {
    const next = new Map<string, number>();
    for (const v of versions) {
      if (v.brandId !== brandId || v.setId !== setId) throw new SeoBlogError(403, 'Artwork belongs to another brand.');
      if (!sameContext(v.context, current)) throw new SeoBlogError(409, 'Brand facts or the creative kit changed while rendering. Try again.');
      const key = variantKey(v), head = this.head(brandId, setId, key);
      const expected = next.get(key) ?? (head ? head.number + 1 : 1);
      if (v.number !== expected || (v.parentVersionId ?? null) !== (next.has(key) ? null : head?.id ?? null) || this.versions.has(v.id)) throw new SeoBlogError(409, 'This artwork changed while you were editing. Refresh and review the current version.');
      next.set(key, expected + 1);
    }
    for (const v of versions) this.versions.set(v.id, v);
  }

  async latestKit(brandId: string): Promise<BrandKit | null> { return this.kits.get(brandId)?.at(-1) ?? null; }
  async saveKit(brandId: string, commandId: string, inputSha: string, kit: BrandKit): Promise<CommandReceipt> {
    const replay = this.command(brandId, commandId, inputSha); if (replay) return replay;
    const list = this.kits.get(brandId) ?? [];
    if (kit.brandId !== brandId || kit.version !== list.length + 1) throw new SeoBlogError(409, 'The creative kit changed. Refresh and try again.');
    this.kits.set(brandId, [...list, kit]);
    return this.record(brandId, commandId, inputSha, String(kit.version));
  }
  async commandResult(brandId: string, commandId: string, inputSha: string): Promise<CommandReceipt | null> { return this.command(brandId, commandId, inputSha); }
  async createSet(brandId: string, commandId: string, inputSha: string, set: CreativeSet, versions: readonly CreativeVersion[], current: ContextInputs): Promise<CommandReceipt> {
    const replay = this.command(brandId, commandId, inputSha); if (replay) return replay;
    if (set.brandId !== brandId || this.sets.has(set.id)) throw new SeoBlogError(409, 'That creative set already exists.');
    this.sets.set(set.id, set);
    try { this.insertVersions(brandId, set.id, versions, current); } catch (e) { this.sets.delete(set.id); throw e; }
    return this.record(brandId, commandId, inputSha, set.id);
  }
  async appendVersions(brandId: string, commandId: string, inputSha: string, setId: string, versions: readonly CreativeVersion[], current: ContextInputs): Promise<CommandReceipt> {
    const replay = this.command(brandId, commandId, inputSha); if (replay) return replay;
    if (this.sets.get(setId)?.brandId !== brandId) throw new SeoBlogError(404, 'That creative set was not found.');
    this.insertVersions(brandId, setId, versions, current);
    return this.record(brandId, commandId, inputSha, setId);
  }
  async approve(brandId: string, commandId: string, inputSha: string, approval: CreativeApproval, current: ContextInputs): Promise<CommandReceipt> {
    const replay = this.command(brandId, commandId, inputSha); if (replay) return replay;
    const version = this.versions.get(approval.versionId);
    if (!version || version.brandId !== brandId) throw new SeoBlogError(404, 'That artwork version was not found.');
    const problem = approvalProblem(version, this.head(brandId, version.setId, variantKey(version))?.id === version.id, approval, current);
    if (problem) throw new SeoBlogError(409, problem);
    if ([...this.approvals.values()].some((a) => a.versionId === version.id)) throw new SeoBlogError(409, 'This exact version is already approved.');
    this.approvals.set(approval.id, approval);
    return this.record(brandId, commandId, inputSha, approval.id);
  }
  async handoff(brandId: string, commandId: string, inputSha: string, handoff: CreativeHandoff, current: ContextInputs): Promise<CommandReceipt> {
    const replay = this.command(brandId, commandId, inputSha); if (replay) return replay;
    const version = this.versions.get(handoff.versionId), approval = this.approvals.get(handoff.approvalId);
    if (!version || version.brandId !== brandId || !approval || approval.versionId !== version.id) throw new SeoBlogError(409, 'Only an approved artwork version can be added to a campaign.');
    const problem = approvalProblem(version, this.head(brandId, version.setId, variantKey(version))?.id === version.id, approval, current);
    if (problem) throw new SeoBlogError(409, problem);
    this.handoffs.set(handoff.id, handoff);
    return this.record(brandId, commandId, inputSha, handoff.id);
  }
  async getSet(brandId: string, setId: string): Promise<CreativeSetRecord | null> {
    const set = this.sets.get(setId);
    if (!set || set.brandId !== brandId) return null;
    const versions = [...this.versions.values()].filter((v) => v.setId === setId).sort((a, b) => variantKey(a).localeCompare(variantKey(b)) || a.number - b.number);
    const ids = new Set(versions.map((v) => v.id));
    return { set, versions, approvals: [...this.approvals.values()].filter((a) => ids.has(a.versionId)), handoffs: [...this.handoffs.values()].filter((h) => ids.has(h.versionId)) };
  }
  async listSets(brandId: string): Promise<CreativeSetSummary[]> {
    return [...this.sets.values()].filter((s) => s.brandId === brandId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((set) => {
      const versions = [...this.versions.values()].filter((v) => v.setId === set.id);
      return { set, versionCount: versions.length, approvedCount: [...this.approvals.values()].filter((a) => versions.some((v) => v.id === a.versionId)).length };
    });
  }
  async getVersion(brandId: string, versionId: string) {
    const version = this.versions.get(versionId);
    if (!version || version.brandId !== brandId) return null;
    return { version, head: this.head(brandId, version.setId, variantKey(version))?.id === version.id, approval: [...this.approvals.values()].find((a) => a.versionId === versionId) ?? null };
  }
}
