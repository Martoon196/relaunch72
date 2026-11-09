import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { PortalCrmRequestIdentity } from './crm-service.js';
import type { DatabaseRequestContext } from '../db/rls.js';
import { FinanceError, packet, parsePlanning, validDate, type Catalog, type Illustration, type Planning, type PlanningClient, type ReviewPacket } from '../integrations/mh196/planning-client.js';

export interface FinanceSource { workspaceId: string; workspaceName: string; opportunityId: string; opportunityName: string; contactId: string; contactName: string; opportunityVersion: number; latestVersion: number; canWrite: boolean }
export interface SavedFinance { id: string; version: number; opportunityVersion: number; packet: ReviewPacket; illustration: Illustration; calculatedAt: string; savedAt: string }
export interface FinanceSnapshot { source: FinanceSource; versions: SavedFinance[] }
export interface FinanceReview { source: FinanceSource; packet: ReviewPacket; illustration: Illustration; calculatedAt: string; reviewToken: string }
export interface FinanceRepository {
  snapshot(context: DatabaseRequestContext, opportunityId: string, version?: number): Promise<FinanceSnapshot | null>;
  save(context: DatabaseRequestContext, review: SignedReview): Promise<SavedFinance>;
}
export interface SignedReview { opportunityId: string; workspaceId: string; contactId: string; opportunityVersion: number; expectedLatestVersion: number; nonce: string; packet: ReviewPacket; illustration: Illustration; calculatedAt: string; expiresAt: number }
export interface PortalFinanceDraftsService {
  snapshot(identity: PortalCrmRequestIdentity, opportunityId: string, version?: number): Promise<FinanceSnapshot>;
  catalog(identity: PortalCrmRequestIdentity, opportunityId: string): Promise<Catalog>;
  calculate(identity: PortalCrmRequestIdentity, opportunityId: string, planning: unknown, date: string, sourceVersion: number, latestVersion: number): Promise<FinanceReview>;
  save(identity: PortalCrmRequestIdentity, opportunityId: string, token: string): Promise<SavedFinance>;
}
export const FINANCE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export class FinanceDraftsService implements PortalFinanceDraftsService {
  constructor(private readonly deps: { context(identity: PortalCrmRequestIdentity): Promise<DatabaseRequestContext | null>; repository: FinanceRepository; client: PlanningClient; secret: string; now?: () => number }) {
    if (deps.secret.length < 32) throw new Error('Finance reviews require the existing server-only session signing key.');
  }
  private now() { return (this.deps.now ?? Date.now)(); }
  private async context(identity: PortalCrmRequestIdentity, opportunityId: string): Promise<DatabaseRequestContext> {
    if (!FINANCE_UUID.test(opportunityId)) throw new FinanceError(404, 'That opportunity is not available.');
    const context = await this.deps.context(identity);
    if (!context) throw new FinanceError(403, 'Your session changed. Sign in again before preparing finance.');
    return context;
  }
  private async owned(context: DatabaseRequestContext, opportunityId: string, version?: number): Promise<FinanceSnapshot> {
    const snapshot = await this.deps.repository.snapshot(context, opportunityId, version);
    if (!snapshot) throw new FinanceError(404, 'That opportunity is not available in this workspace.');
    if (!snapshot.source.canWrite) throw new FinanceError(403, 'Your workspace role cannot prepare client finance.');
    return snapshot;
  }
  async snapshot(identity: PortalCrmRequestIdentity, opportunityId: string, version?: number) { if (version !== undefined && (!Number.isSafeInteger(version) || version < 1)) throw new FinanceError(400, 'Choose a valid saved version.'); return this.owned(await this.context(identity, opportunityId), opportunityId, version); }
  async catalog(identity: PortalCrmRequestIdentity, opportunityId: string) { await this.snapshot(identity, opportunityId); return this.deps.client.catalog(); }
  private mac(session: string, body: string): string { return createHmac('sha256', this.deps.secret).update('hq-finance-review-v1\0').update(createHash('sha256').update(session).digest()).update(body).digest('base64url'); }
  async calculate(identity: PortalCrmRequestIdentity, opportunityId: string, raw: unknown, date: string, sourceVersion: number, latestVersion: number): Promise<FinanceReview> {
    const context = await this.context(identity, opportunityId), initial = await this.owned(context, opportunityId);
    if (initial.source.opportunityVersion !== sourceVersion || initial.source.latestVersion !== latestVersion) throw new FinanceError(409, 'This opportunity changed. Reopen its finance page before calculating.');
    const planning = parsePlanning(raw); validDate(date);
    if (Number(planning.inputs.loan_requested) <= 0) throw new FinanceError(400, 'Enter the requested borrowing.');
    if (planning.inputs.borrower_broker_fee !== '0') throw new FinanceError(400, 'MH196 calculates its own broker fee. Refresh the form.');
    // No database transaction is held across the public numeric request.
    const illustration = await this.deps.client.calculate(planning, date);
    const refreshed = await this.owned(await this.context(identity, opportunityId), opportunityId);
    if (refreshed.source.workspaceId !== initial.source.workspaceId || refreshed.source.contactId !== initial.source.contactId || refreshed.source.opportunityVersion !== sourceVersion || refreshed.source.latestVersion !== latestVersion) throw new FinanceError(409, 'The opportunity or workspace changed during calculation. Nothing was saved.');
    const calculatedAt = new Date(this.now()).toISOString(), reviewPacket = packet(planning, date);
    const review: SignedReview = { opportunityId, workspaceId: context.workspaceId, contactId: initial.source.contactId, opportunityVersion: sourceVersion, expectedLatestVersion: latestVersion, nonce: randomUUID(), packet: reviewPacket, illustration, calculatedAt, expiresAt: this.now() + 30 * 60 * 1000 };
    const body = Buffer.from(JSON.stringify(review)).toString('base64url');
    return { source: refreshed.source, packet: reviewPacket, illustration, calculatedAt, reviewToken: `${body}.${this.mac(identity.sessionToken, body)}` };
  }
  async save(identity: PortalCrmRequestIdentity, opportunityId: string, token: string): Promise<SavedFinance> {
    const context = await this.context(identity, opportunityId);
    if (token.length > 240000 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(token)) throw new FinanceError(400, 'Recalculate before saving this illustration.');
    const [body = '', signature = ''] = token.split('.');
    const expected = this.mac(identity.sessionToken, body);
    if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) throw new FinanceError(400, 'The reviewed figures changed. Recalculate before saving.');
    const review = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as SignedReview;
    if (review.workspaceId !== context.workspaceId || review.opportunityId !== opportunityId) throw new FinanceError(403, 'This review belongs to a different opportunity or workspace.');
    if (review.expiresAt < this.now()) throw new FinanceError(409, 'This review expired. Recalculate the figures before saving.');
    return this.deps.repository.save(context, review);
  }
}

/** Convert HTML controls only; the shared parser rejects omissions and extra keys. */
export function planningFromForm(form: Record<string, string>, fields: Record<string, { kind: string; nullable?: boolean }>): Planning {
  const inputs: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(fields)) {
    const raw = form[`input_${key}`];
    if (key === 'borrower_broker_fee') inputs[key] = '0';
    else if (field.kind === 'boolean') { if (raw !== 'true' && raw !== 'false') throw new FinanceError(400, `Confirm ${key.replaceAll('_', ' ')}.`); inputs[key] = raw === 'true'; }
    else if (field.kind === 'integer') inputs[key] = raw === undefined || raw === '' ? null : Number(raw);
    else if (field.kind === 'schedule') { try { inputs[key] = JSON.parse(raw || '[]'); } catch { throw new FinanceError(400, 'Check the works schedule JSON.'); } }
    else inputs[key] = field.nullable && raw === '' ? null : raw;
  }
  return parsePlanning({ schema_version: '1.0', preset_id: form.model, inputs });
}
