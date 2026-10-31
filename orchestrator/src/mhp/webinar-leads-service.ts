import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { Pool } from 'pg';
import type { CrmCommandService } from '../crm-pg/commands.js';
import type { CreateLeadResult, CrmTransactionRunner } from '../crm-pg/types.js';
import { requestDatabaseContext, type DatabaseRequestContext } from '../db/rls.js';
import type { PortalSessionIdentity } from '../portal/auth-service.js';
import { MhpCommerceError } from './commerce-service.js';
import { MHP_OPAQUE_TOKEN } from './auth-service.js';
import { MHP_MARKETING_WORKSPACE_ID, type PgMhpMarketingWorkspaceService } from './marketing-workspace-service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CAMPAIGN = /^[a-z0-9_-]{1,60}$/u;
const BATCH_SIZE = 25;
const sha = (value: string): Buffer => createHash('sha256').update(value).digest();
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown, maximum: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= maximum;

export interface MhpWebinarLeadCandidate {
  prospectId: string; signupId: string; campaign: string; email: string; firstName: string | null;
  level: 'L1' | 'L2' | 'L3' | null; label: string; registeredAt: string; link: string | null;
  marketingConsent: boolean; unsubscribed: boolean; signupConsentGiven: boolean;
}
export interface MhpWebinarLeadPage {
  candidates: readonly MhpWebinarLeadCandidate[]; hasMore: boolean; nextAfter: string | null;
}
export interface MhpWebinarLeadBatch {
  campaign: string; added: number; replayed: number; failed: boolean; processed: number;
  hasMore: boolean; cursor: string | null;
}
export interface MhpWebinarLeadReader {
  page(identity: PortalSessionIdentity, campaign: string, after: string | null): Promise<MhpWebinarLeadPage>;
}

function validCandidate(value: unknown, campaign: string): value is MhpWebinarLeadCandidate {
  return record(value) && typeof value.prospectId === 'string' && UUID.test(value.prospectId)
    && typeof value.signupId === 'string' && UUID.test(value.signupId) && value.campaign === campaign
    && text(value.email, 320) && /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value.email)
    && (value.firstName === null || text(value.firstName, 100))
    && (value.level === null || ['L1', 'L2', 'L3'].includes(String(value.level)))
    && text(value.label, 200) && text(value.registeredAt, 40) && Number.isFinite(Date.parse(value.registeredAt))
    && (value.link === null || (text(value.link, 500) && value.link.startsWith('https://martinhowardproperty.co.uk/')))
    && typeof value.marketingConsent === 'boolean' && typeof value.unsubscribed === 'boolean'
    && typeof value.signupConsentGiven === 'boolean';
}

/** Executes only the bounded native-owner reader; it cannot claim/send queue work. */
export class PgMhpWebinarLeadReader implements MhpWebinarLeadReader {
  constructor(private readonly readPool: Pick<Pool, 'query'>) {}
  async page(identity: PortalSessionIdentity, campaign: string, after: string | null): Promise<MhpWebinarLeadPage> {
    if (!MHP_OPAQUE_TOKEN.test(identity.sessionToken) || identity.workspaceId !== MHP_MARKETING_WORKSPACE_ID
        || !CAMPAIGN.test(campaign) || (after !== null && !UUID.test(after))) {
      throw new MhpCommerceError(403, 'Open the MHP marketing workspace before importing sign-ups.');
    }
    try {
      const result = await this.readPool.query<{ page: unknown }>(
        'SELECT app_private.mhp_webinar_lead_candidates($1::bytea,$2::text,$3::uuid,$4::integer) AS page',
        [sha(identity.sessionToken), campaign, after, BATCH_SIZE]);
      const page = result.rows[0]?.page;
      if (result.rows.length !== 1 || !record(page) || page.campaign !== campaign || !Array.isArray(page.candidates)
          || page.candidates.length > BATCH_SIZE || typeof page.hasMore !== 'boolean'
          || !page.candidates.every(candidate => validCandidate(candidate, campaign))) throw new Error('Invalid webinar candidate page');
      const candidates = page.candidates as MhpWebinarLeadCandidate[];
      let previous = after;
      for (const candidate of candidates) {
        if (previous !== null && candidate.prospectId <= previous) throw new Error('Invalid webinar candidate order');
        previous = candidate.prospectId;
      }
      if (page.nextAfter !== (page.hasMore ? candidates.at(-1)?.prospectId : null)) throw new Error('Invalid webinar candidate continuation');
      return { candidates, hasMore: page.hasMore, nextAfter: page.nextAfter as string | null };
    } catch (error) {
      if (error instanceof MhpCommerceError) throw error;
      if ((error as { code?: string })?.code === '42501') throw new MhpCommerceError(403, 'Owner access to the MHP marketing workspace is required.');
      throw new MhpCommerceError(503, 'Webinar sign-ups are temporarily unavailable.');
    }
  }
}

function completedResult(value: unknown): CreateLeadResult {
  if (!record(value) || !['applied', 'replayed'].includes(String(value.disposition))
      || typeof value.contactId !== 'string' || !UUID.test(value.contactId)
      || typeof value.opportunityId !== 'string' || !UUID.test(value.opportunityId)
      || !(value.taskId === null || (typeof value.taskId === 'string' && UUID.test(value.taskId)))
      || typeof value.createdContact !== 'boolean') throw new Error('Invalid recorded lead result');
  return { disposition: 'replayed', contactId: value.contactId, opportunityId: value.opportunityId,
    taskId: value.taskId, createdContact: value.createdContact };
}

export class MhpWebinarLeadService {
  constructor(private readonly dependencies: {
    marketingWorkspace: Pick<PgMhpMarketingWorkspaceService, 'snapshot'>;
    reader: MhpWebinarLeadReader;
    transactions: CrmTransactionRunner;
    commands: Pick<CrmCommandService, 'createLead'>;
    campaign: string;
    cursorSecret: string;
  }) {
    if (!CAMPAIGN.test(dependencies.campaign) || dependencies.cursorSecret.length < 32) throw new Error('Invalid webinar import configuration');
  }

  private cursorMac(identity: PortalSessionIdentity, payload: string): Buffer {
    return createHmac('sha256', this.dependencies.cursorSecret).update('mhp.webinar-import.cursor.v1\0')
      .update(identity.userId).update('\0').update(identity.workspaceId).update('\0').update(sha(identity.sessionToken))
      .update('\0').update(this.dependencies.campaign).update('\0').update(payload).digest();
  }
  private cursor(identity: PortalSessionIdentity, after: string | null, now: number): string {
    const payload = Buffer.from(JSON.stringify({ after, expiresAt: now + 30 * 60_000 })).toString('base64url');
    return `${payload}.${this.cursorMac(identity, payload).toString('base64url')}`;
  }
  private after(identity: PortalSessionIdentity, cursor: string, now: number): string | null {
    if (cursor === '') return null;
    if (cursor.length > 300 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/u.test(cursor)) throw new MhpCommerceError(400, 'Refresh the webinar import before continuing.');
    const [payload, signature] = cursor.split('.');
    const supplied = Buffer.from(signature!, 'base64url');
    if (!timingSafeEqual(supplied, this.cursorMac(identity, payload!))) throw new MhpCommerceError(400, 'Refresh the webinar import before continuing.');
    let value: unknown;
    try { value = JSON.parse(Buffer.from(payload!, 'base64url').toString('utf8')); } catch { value = null; }
    if (!record(value) || !(value.after === null || (typeof value.after === 'string' && UUID.test(value.after)))
        || typeof value.expiresAt !== 'number' || value.expiresAt < now || value.expiresAt > now + 30 * 60_000
        || Object.keys(value).sort().join(',') !== 'after,expiresAt') throw new MhpCommerceError(400, 'Refresh the webinar import before continuing.');
    return value.after;
  }

  private receipt(context: DatabaseRequestContext, key: string): Promise<CreateLeadResult | null> {
    return this.dependencies.transactions.run(context, async transaction => {
      const result = await transaction.query<{ status: string; result: unknown }>(
        `/* mhp.webinar-recorded-lead */ SELECT status,result FROM app.command_receipts
         WHERE workspace_id=app_private.current_workspace_id() AND actor_user_id=$1
          AND command_name='crm.createLead' AND idempotency_key=$2`, [context.userId, key]);
      if (result.rows.length === 0) return null;
      if (result.rows.length !== 1 || result.rows[0]!.status !== 'succeeded') throw new Error('Lead import receipt is not complete');
      return completedResult(result.rows[0]!.result);
    });
  }

  private async importOne(context: DatabaseRequestContext, candidate: MhpWebinarLeadCandidate): Promise<CreateLeadResult> {
    const key = `mhp.webinar.${this.dependencies.campaign}.${candidate.prospectId}`;
    const recorded = await this.receipt(context, key);
    if (recorded) return recorded;
    const stage = await this.dependencies.transactions.run(context, async transaction => {
      const result = await transaction.query<{ pipelineId: string; stageId: string }>(
        `/* mhp.webinar-new-stage */ SELECT p.id AS "pipelineId",s.id AS "stageId"
         FROM app.pipelines p JOIN app.pipeline_stages s ON s.workspace_id=p.workspace_id AND s.pipeline_id=p.id
         WHERE p.workspace_id=app_private.current_workspace_id() AND p.slug::text='enquiries'
          AND p.status='active' AND p.is_default AND s.slug::text='new' AND s.stage_type='open' AND NOT s.is_terminal`);
      if (result.rows.length !== 1 || !UUID.test(result.rows[0]!.pipelineId) || !UUID.test(result.rows[0]!.stageId)) throw new Error('New enquiry stage unavailable');
      return result.rows[0]!;
    });
    const name = (candidate.firstName || candidate.email).slice(0, 200);
    try {
      return await this.dependencies.commands.createLead(context, {
        commandKey: key, displayName: name, ownerUserId: context.userId!,
        source: `mhp:webinar:${sha(this.dependencies.campaign).toString('hex').slice(0, 12)}:${candidate.signupId}:${candidate.prospectId}`,
        contactPoints: [{ kind: 'email', value: candidate.email, isPrimary: true, consentStatus: 'unknown' }],
        pipelineId: stage.pipelineId, stageId: stage.stageId,
        opportunityName: `Webinar ${this.dependencies.campaign} · ${name}${candidate.level ? ` (${candidate.level})` : ''}`.slice(0, 200),
        valueMinor: 0, currency: 'GBP',
      });
    } catch (error) {
      // Two devices may read different mutable prospect values before either
      // receipt exists. A conflict can also fail before the core command exposes
      // a typed hash error. Only our own completed, session-fenced receipt proves
      // success; otherwise retain the original command failure.
      try {
        const winner = await this.receipt(context, key);
        if (winner) return winner;
      } catch { /* An unavailable, revoked or invalid receipt cannot prove success. */ }
      throw error;
    }
  }

  async importBatch(identity: PortalSessionIdentity, requestId: string, cursor: string, now = Date.now()): Promise<MhpWebinarLeadBatch> {
    const snapshot = await this.dependencies.marketingWorkspace.snapshot(identity);
    if (!MHP_OPAQUE_TOKEN.test(identity.sessionToken) || identity.workspaceId !== MHP_MARKETING_WORKSPACE_ID
        || snapshot.userId !== identity.userId || snapshot.selectedWorkspaceId !== identity.workspaceId || !snapshot.marketingSelected) {
      throw new MhpCommerceError(403, 'Open the MHP marketing workspace before importing sign-ups.');
    }
    const after = this.after(identity, cursor, now);
    const page = await this.dependencies.reader.page(identity, this.dependencies.campaign, after);
    const context = requestDatabaseContext({ userId: identity.userId, workspaceId: identity.workspaceId,
      requestId, portalSessionTokenHash: sha(identity.sessionToken) });
    let added = 0, replayed = 0, last = after;
    for (const candidate of page.candidates) {
      try {
        const result = await this.importOne(context, candidate);
        if (result.disposition === 'applied') added += 1; else replayed += 1;
        last = candidate.prospectId;
      } catch {
        return { campaign: this.dependencies.campaign, added, replayed, failed: true, processed: added + replayed,
          hasMore: true, cursor: this.cursor(identity, last, now) };
      }
    }
    return { campaign: this.dependencies.campaign, added, replayed, failed: false, processed: added + replayed,
      hasMore: page.hasMore, cursor: page.hasMore ? this.cursor(identity, page.nextAfter, now) : null };
  }
}
