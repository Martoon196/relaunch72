import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import type { CrmCommandService } from '../crm-pg/commands.js';
import type { CreateLeadResult, CrmTransactionRunner } from '../crm-pg/types.js';
import { requestDatabaseContext, type DatabaseRequestContext } from '../db/rls.js';
import type { PortalSessionIdentity } from '../portal/auth-service.js';
import { MhpCommerceError } from './commerce-service.js';
import { MHP_OPAQUE_TOKEN } from './auth-service.js';
import { MHP_MARKETING_WORKSPACE_ID, type PgMhpMarketingWorkspaceService } from './marketing-workspace-service.js';
import { createOrReplaySignupLead, newEnquiryStage, readSignupLeadCursor, recordedSignupLead, signSignupLeadCursor,
  SIGNUP_LEAD_BATCH_SIZE, type SignupLeadAudience } from './signup-leads.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CAMPAIGN = /^[a-z0-9_-]{1,60}$/u;
const BATCH_SIZE = SIGNUP_LEAD_BATCH_SIZE;
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
    this.audience = { tag: 'webinar', cursorDomain: 'mhp.webinar-import.cursor.v1', cursorScope: dependencies.campaign,
      refreshMessage: 'Refresh the webinar import before continuing.' };
  }

  private readonly audience: SignupLeadAudience;

  private cursor(identity: PortalSessionIdentity, after: string | null, now: number): string {
    return signSignupLeadCursor(this.dependencies.cursorSecret, this.audience, identity, after, now);
  }

  private async importOne(context: DatabaseRequestContext, candidate: MhpWebinarLeadCandidate): Promise<CreateLeadResult> {
    const key = `mhp.webinar.${this.dependencies.campaign}.${candidate.prospectId}`;
    const { transactions, commands } = this.dependencies;
    const recorded = await recordedSignupLead(transactions, context, this.audience, key);
    if (recorded) return recorded;
    const stage = await newEnquiryStage(transactions, context, this.audience);
    const name = (candidate.firstName || candidate.email).slice(0, 200);
    return createOrReplaySignupLead({ transactions, commands, context, audience: this.audience, command: {
      commandKey: key, displayName: name, ownerUserId: context.userId!,
      source: `mhp:webinar:${sha(this.dependencies.campaign).toString('hex').slice(0, 12)}:${candidate.signupId}:${candidate.prospectId}`,
      contactPoints: [{ kind: 'email', value: candidate.email, isPrimary: true, consentStatus: 'unknown' }],
      pipelineId: stage.pipelineId, stageId: stage.stageId,
      opportunityName: `Webinar ${this.dependencies.campaign} · ${name}${candidate.level ? ` (${candidate.level})` : ''}`.slice(0, 200),
      valueMinor: 0, currency: 'GBP',
    } });
  }

  async importBatch(identity: PortalSessionIdentity, requestId: string, cursor: string, now = Date.now()): Promise<MhpWebinarLeadBatch> {
    const snapshot = await this.dependencies.marketingWorkspace.snapshot(identity);
    if (!MHP_OPAQUE_TOKEN.test(identity.sessionToken) || identity.workspaceId !== MHP_MARKETING_WORKSPACE_ID
        || snapshot.userId !== identity.userId || snapshot.selectedWorkspaceId !== identity.workspaceId || !snapshot.marketingSelected) {
      throw new MhpCommerceError(403, 'Open the MHP marketing workspace before importing sign-ups.');
    }
    const after = readSignupLeadCursor(this.dependencies.cursorSecret, this.audience, identity, cursor, now);
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
