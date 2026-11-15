/**
 * RL72 Media Engine data model and durable tenant-isolated store.
 * A file per tenant is suitable for single-process development; replace with
 * Postgres + object storage and transactions before horizontal scaling.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export type Rights = 'owned' | 'licensed' | 'none';
export type CampaignMode = 'affiliate' | 'general';
export type VariantStatus = 'draft' | 'editing' | 'approved' | 'scheduled' | 'published';
export type JobStatus = 'queued' | 'processing' | 'done' | 'failed';
export type JobKind = 'clip' | 'render';

export interface Product {
  id: string;
  name: string;
  merchant: string;
  productUrl: string;
  affiliateUrl: string | null;
  createdAt: string;
}
export interface Variant {
  id: string;
  title: string;
  script: string;
  mediaUrl: string | null;
  timeline: unknown;
  status: VariantStatus;
  approvedAt: string | null;
  scheduledAt: string | null;
  platform: string | null;
  providerPostId: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface Job {
  id: string;
  campaignId: string;
  variantId: string | null;
  kind: JobKind;
  provider: 'vizard' | 'shotstack';
  providerId: string | null;
  status: JobStatus;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface Campaign {
  id: string;
  tenantId: string;
  name: string;
  mode: CampaignMode;
  brief: string;
  sourceUrl: string | null;
  rights: Rights;
  rightsEvidence: string | null;
  products: Product[];
  variants: Variant[];
  jobs: Job[];
  createdAt: string;
  updatedAt: string;
}
export interface MediaState {
  version: 1;
  campaigns: Campaign[];
  audit: Array<{ id: string; at: string; campaignId: string; action: string; detail: string }>;
}
export class MediaError extends Error {
  constructor(message: string, public readonly status = 400) { super(message); }
}
export const newId = (): string => crypto.randomUUID();
export const nowIso = (): string => new Date().toISOString();

export function validUrl(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length > 2048) throw new MediaError(label + ' must be a valid HTTPS URL');
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:' || u.username || u.password || !u.hostname.includes('.')) throw new Error('protocol');
    return u.href;
  } catch { throw new MediaError(label + ' must be a valid HTTPS URL'); }
}
export function requiredText(value: unknown, label: string, max = 4000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new MediaError(label + ' is required (max ' + max + ' characters)');
  return value.trim();
}
export function findCampaign(data: MediaState, id: string): Campaign {
  const found = data.campaigns.find((c) => c.id === id);
  if (!found) throw new MediaError('Campaign not found', 404);
  return found;
}
export function findVariant(c: Campaign, id: string): Variant {
  const found = c.variants.find((v) => v.id === id);
  if (!found) throw new MediaError('Variant not found', 404);
  return found;
}

const blank = (): MediaState => ({ version: 1, campaigns: [], audit: [] });
export class MediaStore {
  private readonly pending = new Map<string, Promise<unknown>>();
  constructor(private readonly root: string) {}
  private file(tenantId: string): string {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(tenantId)) throw new MediaError('Invalid tenant ID', 403);
    return path.join(this.root, tenantId + '.json');
  }
  async read(tenantId: string): Promise<MediaState> {
    try {
      const data = JSON.parse(await fs.readFile(this.file(tenantId), 'utf8')) as MediaState;
      if (data.version !== 1 || !Array.isArray(data.campaigns)) throw new Error('Invalid media store version');
      return data;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return blank();
      throw e;
    }
  }
  /** Serialises writes within one process and atomically renames each snapshot. */
  async update<T>(tenantId: string, fn: (data: MediaState) => T | Promise<T>): Promise<T> {
    const previous = this.pending.get(tenantId) ?? Promise.resolve();
    const task = previous.catch(() => {}).then(async () => {
      const data = await this.read(tenantId);
      const result = await fn(data);
      const target = this.file(tenantId);
      await fs.mkdir(this.root, { recursive: true });
      const temp = target + '.' + newId() + '.tmp';
      try {
        await fs.writeFile(temp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
        await fs.rename(temp, target);
      } catch (e) { await fs.rm(temp, { force: true }).catch(() => {}); throw e; }
      return result;
    });
    this.pending.set(tenantId, task);
    try { return await task; }
    finally { if (this.pending.get(tenantId) === task) this.pending.delete(tenantId); }
  }
}
