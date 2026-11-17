import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import {
  CompanyContentService, createCompanyContentTransactionRunner, parseCompanyContentEmailDraft,
  type CompanyContentCatalogPage, type CompanyContentExactReview, type CompanyContentTransactionRunner,
} from '../company-content-pg/index.js';
import { requestDatabaseContext, type DatabaseRequestContext } from '../db/rls.js';
import type { PortalSessionIdentity } from '../portal/auth-service.js';
import { MHP_OPAQUE_TOKEN, normalizeMhpEmail } from './auth-service.js';
import { MhpCommerceError } from './commerce-service.js';
import { mhpCandidateEligible, mhpPeopleDigest, mhpWebinarLabel, readAllMhpWebinarCandidates, readMhpWebinarCandidates, MHP_CONFIRM_LIMIT,
  type MhpAudienceCandidatePage } from './webinar-audience.js';
import type { MhpMarketingConfig, MhpRenderedMarketingSender } from './marketing-mail.js';
import { MHP_MARKETING_WORKSPACE_ID, type PgMhpMarketingWorkspaceService } from './marketing-workspace-service.js';
import {
  MHP_OWNER_EMAIL_SOURCE, MHP_OWNER_EMAIL_UUID, mhpEmailSha, mhpOwnerEmailDraftCommand, parseMhpOwnerEmailBrand,
  renderMhpOwnerEmail, validateMhpOwnerEmailCopy, type MhpOwnerEmailBrand, type MhpOwnerEmailRendered,
} from './owner-email-content.js';

const hash = (value: string): Buffer => createHash('sha256').update(value).digest();
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const uuid = (value: unknown): value is string => typeof value === 'string' && MHP_OWNER_EMAIL_UUID.test(value);
export interface MhpOwnerEmailQueueCounts {
  contentItemId: string; total: number; sent: number; pending: number; held: number; inFlight: number; failed: number; cancelled: number;
  dueAt: string | null; expiresAt: string | null; holdReason: string | null; lastFailure: string | null;
}
export interface MhpOwnerEmailDatabaseSnapshot {
  brand: unknown; campaign: string; eligible: number;
  automatic: readonly { template: string; total: number; sent: number; pending: number; failed: number; cancelled: number }[];
  ownerItems: readonly MhpOwnerEmailQueueCounts[];
  tests: readonly { contentVersionId: string; createdAt: string; status: 'accepted' | 'unknown' }[];
}
export interface MhpOwnerEmailExactLocal {
  contentItemId: string; contentVersionId: string; sourceItemId: string; sourceVersion: string;
  canonicalContent: string; contentSha256: string; blobSha256: string; brand: unknown;
  manifestCanonical: string; manifestSha256: string; approvalDecisionId: string | null; audienceCampaign: string;
}
export interface MhpOwnerEmailLocalVersion {
  contentItemId: string; contentVersionId: string; versionNumber: number; previousVersionId: string | null; title: string;
  sourceItemId: string; sourceVersion: string; canonicalContent: string; contentSha256: string; blobSha256: string; brandSha256: string;
  metadata: Record<string, unknown>; valid: boolean; exact: MhpOwnerEmailExactLocal | null;
}
export interface MhpOwnerEmailActionResult {
  action: 'schedule' | 'replace' | 'cancel'; contentItemId: string; contentVersionId: string;
  changed: number; remaining: number; inFlight: number; replayed: boolean;
}
export interface MhpOwnerEmailRepository {
  snapshot(identity: PortalSessionIdentity, campaign: string): Promise<MhpOwnerEmailDatabaseSnapshot>;
  local(identity: PortalSessionIdentity, versionId: string | null, revision: string | null): Promise<MhpOwnerEmailLocalVersion | null>;
  queue(identity: PortalSessionIdentity, input: { action: 'schedule' | 'replace' | 'cancel'; commandId: string; versionId: string;
    campaign: string; dueAt: string | null; expiresAt: string | null; requestId: string }): Promise<MhpOwnerEmailActionResult>;
  testBegin(identity: PortalSessionIdentity, commandId: string, versionId: string, destinationHash: Buffer, requestId: string): Promise<{ send: boolean; status: 'accepted' | 'unknown'; exact?: MhpOwnerEmailExactLocal; testId?: string }>;
  testFinish(identity: PortalSessionIdentity, commandId: string, accepted: boolean, reference: string | null): Promise<void>;
  /** Reads who registered for the webinar (25 at a time). Without it nothing can be scheduled, because nobody could be shown. */
  audienceCandidates?(identity: PortalSessionIdentity, campaign: string, after: string | null): Promise<MhpAudienceCandidatePage>;
}
export interface MhpEmailRecipient { prospectId: string; firstName: string | null; email: string }
/** Who "Schedule" would email right now, exactly as app_private.mhp_owner_email_queue_command chooses them, or why not. Reads only. */
export interface MhpEmailSchedulePlan {
  ready: boolean; refusal: string | null; itemId: string; versionId: string; title: string; subject: string; dueAt: string; expiresAt: string;
  webinar: { label: string | null }; recipients: readonly MhpEmailRecipient[]; count: number; digest: string;
  heldBack: { noConsent: number; unsubscribed: number }; mode: string;
}
/** How many unsent emails Replace / Cancel would change; these are people already scheduled, nobody new is added. */
export interface MhpEmailUnsentPlan { ready: boolean; refusal: string | null; itemId: string; versionId: string; title: string; subject: string;
  unsent: number; inFlight: number; digest: string }
export type MhpEmailScheduleResult =
  | { kind: 'scheduled'; scheduled: number; expected: number; unexpected: number; replayed: boolean; dueAt: string }
  | { kind: 'changed'; plan: MhpEmailSchedulePlan; previousCount: number };

function mapDatabaseError(error: unknown): never {
  if (error instanceof MhpCommerceError) throw error;
  const code = (error as { code?: string })?.code;
  if (code === '42501') throw new MhpCommerceError(403, 'Open the MHP marketing workspace with your owner account.');
  if (code === '23514' || code === '40001' || code === '23505') throw new MhpCommerceError(409, 'The email or its approval changed. Refresh it before continuing.');
  if (code === '22023') throw new MhpCommerceError(400, 'Check the email details and send times.');
  throw new MhpCommerceError(503, 'Email controls are temporarily unavailable.');
}

export class PgMhpOwnerEmailRepository implements MhpOwnerEmailRepository {
  constructor(private readonly web: Pick<Pool, 'query'>, private readonly commands: Pick<Pool, 'query'>) {}
  async audienceCandidates(identity: PortalSessionIdentity, campaign: string, after: string | null): Promise<MhpAudienceCandidatePage> {
    try { return await readMhpWebinarCandidates(this.web, this.token(identity), campaign, after); } catch (error) { return mapDatabaseError(error); }
  }
  private token(identity: PortalSessionIdentity): Buffer {
    if (!MHP_OPAQUE_TOKEN.test(identity.sessionToken) || identity.workspaceId !== MHP_MARKETING_WORKSPACE_ID) {
      throw new MhpCommerceError(403, 'Open the MHP marketing workspace first.');
    }
    return hash(identity.sessionToken);
  }
  async snapshot(identity: PortalSessionIdentity, campaign: string): Promise<MhpOwnerEmailDatabaseSnapshot> {
    try {
      const result = await this.web.query<{ value: MhpOwnerEmailDatabaseSnapshot }>('SELECT app_private.mhp_owner_email_snapshot($1,$2) AS value', [this.token(identity), campaign]);
      const value = result.rows[0]?.value;
      if (!value || value.campaign !== campaign || !Number.isSafeInteger(value.eligible) || value.eligible < 0
          || !Array.isArray(value.automatic) || !Array.isArray(value.ownerItems) || !Array.isArray(value.tests)) throw new Error('Invalid editor snapshot');
      parseMhpOwnerEmailBrand(value.brand);return value;
    } catch (error) { return mapDatabaseError(error); }
  }
  async local(identity: PortalSessionIdentity, versionId: string | null, revision: string | null): Promise<MhpOwnerEmailLocalVersion | null> {
    try {
      const result = await this.web.query<{ value: MhpOwnerEmailLocalVersion | null }>('SELECT app_private.mhp_owner_email_local_version($1,$2,$3) AS value', [this.token(identity), versionId, revision]);
      const value = result.rows[0]?.value;
      if (value === null) return null;
      if (!value || !uuid(value.contentItemId) || !uuid(value.contentVersionId) || typeof value.canonicalContent !== 'string'
          || mhpEmailSha(value.canonicalContent) !== value.contentSha256 || typeof value.valid !== 'boolean'
          || value.sourceVersion !== (revision ?? value.sourceVersion) || (versionId !== null && value.contentVersionId !== versionId)) throw new Error('Invalid local version');
      parseCompanyContentEmailDraft(value.canonicalContent);return value;
    } catch (error) { return mapDatabaseError(error); }
  }
  async queue(identity: PortalSessionIdentity, input: Parameters<MhpOwnerEmailRepository['queue']>[1]): Promise<MhpOwnerEmailActionResult> {
    try {
      const result = await this.commands.query<{ value: MhpOwnerEmailActionResult }>('SELECT app_private.mhp_owner_email_queue_command($1,$2,$3,$4,$5,$6,$7,$8) AS value',
        [this.token(identity), input.action, input.commandId, input.versionId, input.campaign, input.dueAt, input.expiresAt, input.requestId]);
      const value = result.rows[0]?.value;
      if (!value || value.action !== input.action || value.contentVersionId !== input.versionId || !uuid(value.contentItemId)
          || ![value.changed, value.remaining, value.inFlight].every(n => Number.isSafeInteger(n) && n >= 0) || typeof value.replayed !== 'boolean') throw new Error('Invalid email command result');
      return value;
    } catch (error) { return mapDatabaseError(error); }
  }
  async testBegin(identity: PortalSessionIdentity, commandId: string, versionId: string, destinationHash: Buffer, requestId: string) {
    try {
      const result = await this.commands.query<{ value: Awaited<ReturnType<MhpOwnerEmailRepository['testBegin']>> }>(
        'SELECT app_private.mhp_owner_email_test_begin($1,$2,$3,$4,$5) AS value', [this.token(identity), commandId, versionId, destinationHash, requestId]);
      const value = result.rows[0]?.value;
      if (!value || typeof value.send !== 'boolean' || !['accepted', 'unknown'].includes(value.status)
          || (value.send && (!value.exact || value.exact.contentVersionId !== versionId || !uuid(value.testId)))) throw new Error('Invalid owner test reservation');
      return value;
    } catch (error) { return mapDatabaseError(error); }
  }
  async testFinish(identity: PortalSessionIdentity, commandId: string, accepted: boolean, reference: string | null): Promise<void> {
    try { await this.commands.query('SELECT app_private.mhp_owner_email_test_finish($1,$2,$3,$4)', [this.token(identity), commandId, accepted, reference]); }
    catch (error) { mapDatabaseError(error); }
  }
}

export interface MhpOwnerEmailStatus { mode: 'off' | 'test' | 'live'; providerReady: boolean; testRecipientCount: number; testEnabled: boolean }
export function mhpOwnerEmailTestConfig(env: NodeJS.ProcessEnv, marketing: MhpMarketingConfig | null): { status: MhpOwnerEmailStatus; recipient: string | null } {
  const values = (env.MHP_MARKETING_TEST_TO ?? '').split(',').map(value => value.trim()).filter(Boolean);
  const normalized = values.map(normalizeMhpEmail);
  const unique = [...new Set(normalized.filter((value): value is string => value !== null))];
  const recipient = normalized.every(Boolean) && unique.length === 1 ? unique[0]! : null;
  return { recipient, status: { mode: marketing?.mode ?? 'off', providerReady: Boolean(marketing), testRecipientCount: unique.length,
    testEnabled: Boolean(marketing && recipient) } };
}

export interface MhpOwnerEmailSaveInput { commandId: string; title: string; subject: string; bodyText: string; contentItemId: string; previousVersionId: string }
export class MhpOwnerEmailService {
  constructor(private readonly dependencies: {
    marketingWorkspace: Pick<PgMhpMarketingWorkspaceService, 'snapshot'>; repository: MhpOwnerEmailRepository;
    reader: Pick<CompanyContentService, 'listCatalog' | 'getExactReview'>;
    adapter: Pick<CompanyContentService, 'createEmailDraftVersion' | 'refreshSourceAttestation'>;
    approvals: Pick<CompanyContentService, 'requestApproval' | 'decideApproval'>;
    adapterTransactions: CompanyContentTransactionRunner;
    campaign: string; status: MhpOwnerEmailStatus; testRecipient: string | null; testSender?: MhpRenderedMarketingSender;
  }) {}
  get status(): MhpOwnerEmailStatus { return { ...this.dependencies.status }; }
  private async context(identity: PortalSessionIdentity, requestId: string): Promise<DatabaseRequestContext> {
    const snapshot = await this.dependencies.marketingWorkspace.snapshot(identity);
    if (!MHP_OPAQUE_TOKEN.test(identity.sessionToken) || identity.workspaceId !== MHP_MARKETING_WORKSPACE_ID
        || snapshot.userId !== identity.userId || snapshot.selectedWorkspaceId !== identity.workspaceId || !snapshot.marketingSelected) {
      throw new MhpCommerceError(403, 'Open the MHP marketing workspace first.');
    }
    return requestDatabaseContext({ userId: identity.userId, workspaceId: identity.workspaceId, requestId, portalSessionTokenHash: hash(identity.sessionToken) });
  }
  private command(id: string): void { if (!uuid(id)) throw new MhpCommerceError(400, 'Refresh the email form before continuing.'); }
  async snapshot(identity: PortalSessionIdentity, requestId: string, cursor: CompanyContentCatalogPage['nextCursor'] = null) {
    const context = await this.context(identity, requestId);
    const [database, catalog] = await Promise.all([
      this.dependencies.repository.snapshot(identity, this.dependencies.campaign),
      this.dependencies.reader.listCatalog(context, { sourceSystem: MHP_OWNER_EMAIL_SOURCE, limit: 25, cursor }),
    ]);
    return { database, catalog, status: this.status, brand: parseMhpOwnerEmailBrand(database.brand) };
  }
  async review(identity: PortalSessionIdentity, requestId: string, itemId: string, versionId: string): Promise<{ review: CompanyContentExactReview; local: MhpOwnerEmailLocalVersion }> {
    if (!uuid(itemId) || !uuid(versionId)) throw new MhpCommerceError(400, 'Choose a saved email.');
    const context = await this.context(identity, requestId);
    const [review, local] = await Promise.all([
      this.dependencies.reader.getExactReview(context, { contentItemId: itemId, contentVersionId: versionId }),
      this.dependencies.repository.local(identity, versionId, null),
    ]);
    if (!review?.email || review.source.system !== MHP_OWNER_EMAIL_SOURCE || !local || local.contentItemId !== itemId
        || local.contentSha256 !== review.contentSha256) throw new MhpCommerceError(404, 'This email was not found in the MHP workspace.');
    return { review, local };
  }
  async preview(identity: PortalSessionIdentity, requestId: string, subject: string, bodyText: string): Promise<MhpOwnerEmailRendered> {
    await this.context(identity, requestId);
    const snapshot = await this.dependencies.repository.snapshot(identity, this.dependencies.campaign);
    const canonicalContent = validateMhpOwnerEmailCopy(subject, bodyText);
    return renderMhpOwnerEmail({ canonicalContent, contentSha256: mhpEmailSha(canonicalContent), brand: parseMhpOwnerEmailBrand(snapshot.brand),
      firstName: 'Sam', label: 'Your webinar', link: 'https://martinhowardproperty.co.uk/webinar/', unsubscribe: 'https://example.invalid/unsubscribe-preview', preview: true });
  }
  async save(identity: PortalSessionIdentity, requestId: string, input: MhpOwnerEmailSaveInput, now = Date.now()) {
    this.command(input.commandId);const context = await this.context(identity, requestId);
    const canonical = validateMhpOwnerEmailCopy(input.subject, input.bodyText);
    if (Boolean(input.contentItemId) !== Boolean(input.previousVersionId)) throw new MhpCommerceError(400, 'Refresh the saved email before editing.');
    const replay = async () => {
      const saved = await this.dependencies.repository.local(identity, null, `edit:${input.commandId}`);
      if (!saved) return null;
      if (saved.canonicalContent !== canonical || saved.title !== input.title || saved.previousVersionId !== (input.previousVersionId || null)
          || (input.contentItemId && saved.contentItemId !== input.contentItemId)) throw new MhpCommerceError(409, 'This save was already used for different text. Refresh the editor.');
      return { contentItemId: saved.contentItemId, contentVersionId: saved.contentVersionId, replayed: true };
    };
    const saved = await replay();if (saved) return saved;
    let previous: { contentItemId: string; contentVersionId: string; sourceItemId: string } | undefined;
    if (input.contentItemId) {
      const current = await this.review(identity, requestId, input.contentItemId, input.previousVersionId);
      if (!current.review.isLatest) throw new MhpCommerceError(409, 'A newer draft exists. Open that draft before editing.');
      previous = { contentItemId: input.contentItemId, contentVersionId: input.previousVersionId, sourceItemId: current.review.source.itemId };
    }
    const snapshot = await this.dependencies.repository.snapshot(identity, this.dependencies.campaign);
    const command = mhpOwnerEmailDraftCommand({ ...input, campaign: this.dependencies.campaign, brand: parseMhpOwnerEmailBrand(snapshot.brand), now, previous });
    try {
      const result = await this.dependencies.adapter.createEmailDraftVersion(context, command);
      return { contentItemId: result.contentItemId, contentVersionId: result.contentVersionId, replayed: result.disposition === 'replayed' };
    } catch (error) { const winner = await replay();if (winner) return winner;return mapDatabaseError(error); }
  }
  private async refresh(context: DatabaseRequestContext, exact: MhpOwnerEmailExactLocal, commandId: string, now: number): Promise<void> {
    const commandKey = `mhp.owner-email.publish.${commandId}.refresh`;
    const recorded = () => this.dependencies.adapterTransactions.run(context, async transaction => {
      const result = await transaction.query<{ status: string; result: unknown }>(`/* mhp.owner-email-source-receipt */ SELECT status,result FROM app.command_receipts
        WHERE workspace_id=app_private.current_workspace_id() AND actor_user_id=app_private.current_user_id()
         AND command_name='companyContent.refreshSourceAttestation' AND idempotency_key=$1`, [commandKey]);
      const receipt = result.rows[0];if (!receipt) return false;
      if (receipt.status !== 'succeeded' || !record(receipt.result) || receipt.result.contentItemId !== exact.contentItemId
          || receipt.result.contentVersionId !== exact.contentVersionId) throw new MhpCommerceError(409, 'This publication check changed. Refresh the email.');
      return true;
    }, { readOnly: true });
    if (await recorded()) return;
    const brand = parseMhpOwnerEmailBrand(exact.brand);
    try {
      await this.dependencies.adapter.refreshSourceAttestation(context, { commandKey, contentItemId: exact.contentItemId, contentVersionId: exact.contentVersionId,
        expected: { source: { system: MHP_OWNER_EMAIL_SOURCE, itemId: exact.sourceItemId, version: exact.sourceVersion },
          contentSha256: exact.contentSha256, blobSha256: exact.blobSha256, brandSha256: brand.sha256 },
        attestation: { catalogSha256: exact.manifestSha256, checkedAt: new Date(now).toISOString(), expiresAt: new Date(now + 900_000).toISOString() } });
    } catch (error) { if (await recorded()) return;throw error; }
  }
  /** One owner Publish action composes existing review/approval primitives. It queues nothing. */
  async publish(identity: PortalSessionIdentity, requestId: string, itemId: string, versionId: string, commandId: string, now = Date.now()): Promise<void> {
    this.command(commandId);const context = await this.context(identity, requestId);
    const { review, local } = await this.review(identity, requestId, itemId, versionId);
    if (!review.isLatest || !local.valid || !local.exact) throw new MhpCommerceError(409, 'Save a fresh draft with the current MHP details before publishing.');
    if (review.approvalStatus === 'approved' && !review.approvalStale) return;
    try {
      await this.refresh(context, local.exact, commandId, now);
      const requested = await this.dependencies.approvals.requestApproval(context, { commandKey: `mhp.owner-email.publish.${commandId}.request`,
        contentItemId: itemId, contentVersionId: versionId, reviewNote: 'Native MHP owner reviewed the exact text and current local brand.' });
      await this.dependencies.approvals.decideApproval(context, { commandKey: `mhp.owner-email.publish.${commandId}.approve`,
        approvalRequestId: requested.approvalRequestId, decision: 'approved', decisionNote: 'Published by the native MHP owner. Scheduling is a separate action.' });
    } catch (error) {
      const after = await this.review(identity, requestId, itemId, versionId);
      if (after.review.isLatest && after.review.approvalStatus === 'approved' && !after.review.approvalStale && after.local.valid) return;
      mapDatabaseError(error);
    }
  }
  /** Public queue: only cancelling is a single press. Scheduling and replacing go through schedule / changeUnsent, bound to what the owner saw. */
  async queue(identity: PortalSessionIdentity, requestId: string, input: { action: 'schedule' | 'replace' | 'cancel'; commandId: string; versionId: string; dueAt: string; expiresAt: string }) {
    if (input.action !== 'cancel') throw new MhpCommerceError(409, 'Scheduling now has a confirmation step that shows exactly who will receive it. Open the email and press the button again. Nothing was scheduled.');
    return this.queueNow(identity, requestId, input);
  }
  private async queueNow(identity: PortalSessionIdentity, requestId: string, input: { action: 'schedule' | 'replace' | 'cancel'; commandId: string; versionId: string; dueAt: string; expiresAt: string }) {
    this.command(input.commandId);if (!uuid(input.versionId)) throw new MhpCommerceError(400, 'Choose a saved email.');
    await this.context(identity, requestId);
    return this.dependencies.repository.queue(identity, { ...input, campaign: this.dependencies.campaign, requestId,
      dueAt: input.action === 'cancel' ? null : input.dueAt, expiresAt: input.action === 'cancel' ? null : input.expiresAt });
  }
  private published(detail: { review: CompanyContentExactReview; local: MhpOwnerEmailLocalVersion }): boolean {
    return detail.review.isLatest && detail.review.approvalStatus === 'approved' && !detail.review.approvalStale && detail.local.valid;
  }
  /**
   * Who Schedule would email: the database schedules every eligible registration (consented, not unsubscribed,
   * agreed at sign-up) who has no row for this email yet. The page has no per-person list of those rows, so once
   * any exist it refuses rather than guess who is left; the explicit-recipient migration removes that limit.
   */
  async schedulePlan(identity: PortalSessionIdentity, requestId: string, itemId: string, versionId: string, dueAt: string, expiresAt: string): Promise<MhpEmailSchedulePlan> {
    const detail = await this.review(identity, requestId, itemId, versionId);
    const database = await this.dependencies.repository.snapshot(identity, this.dependencies.campaign);
    const base = { itemId, versionId, title: detail.review.title, subject: detail.review.email?.subject ?? '', dueAt, expiresAt, webinar: { label: null as string | null },
      recipients: [] as MhpEmailRecipient[], count: 0, digest: '', heldBack: { noConsent: 0, unsubscribed: 0 }, mode: this.status.mode };
    const refuse = (refusal: string, extra: Partial<MhpEmailSchedulePlan> = {}): MhpEmailSchedulePlan => ({ ...base, ...extra, ready: false, refusal });
    if (!this.published(detail)) return refuse('Publish the latest version of this email before scheduling it.');
    if (this.status.mode === 'off' || !this.status.providerReady) return refuse('Email sending is switched off or not connected, so nothing can be scheduled.');
    const counts = database.ownerItems.find(item => item.contentItemId === itemId);
    if (counts && counts.total > 0) return refuse(`${counts.total === 1 ? 'One person already has' : `${counts.total} people already have`} this email scheduled, sent or cancelled. This page cannot yet tell exactly who is left, so nobody more can be scheduled from here. Nothing was scheduled.`);
    const reader = this.dependencies.repository.audienceCandidates?.bind(this.dependencies.repository);
    if (!reader) return refuse('The list of people who would receive this cannot be shown here yet, so nothing can be scheduled.');
    const candidates = await readAllMhpWebinarCandidates(after => reader(identity, this.dependencies.campaign, after));
    if (!candidates) return refuse('There are too many sign-ups to list on one page, so nothing can be scheduled from here.');
    const eligible = candidates.filter(mhpCandidateEligible).sort((a, b) => a.prospectId < b.prospectId ? -1 : a.prospectId > b.prospectId ? 1 : 0);
    const heldBack = { unsubscribed: candidates.filter(c => c.unsubscribed).length, noConsent: candidates.filter(c => !c.unsubscribed && !mhpCandidateEligible(c)).length };
    const webinar = { label: mhpWebinarLabel(eligible) };
    if (eligible.length !== database.eligible) return refuse('The list of people changed while it was being read. Nothing was scheduled. Open this page again to see the current list.', { webinar, heldBack });
    if (eligible.length > MHP_CONFIRM_LIMIT) return refuse(`This list is longer than this page can safely check (${eligible.length} people). Nothing was scheduled.`, { webinar, heldBack });
    if (!eligible.length) return refuse('Nobody who registered has agreed to emails, so nobody would receive this.', { webinar, heldBack });
    const recipients = eligible.map(c => ({ prospectId: c.prospectId, firstName: c.firstName, email: c.email }));
    return { ...base, webinar, heldBack, recipients, count: recipients.length, ready: true, refusal: null,
      digest: mhpPeopleDigest('mhp.owner-email-schedule/v1', [itemId, versionId, dueAt, expiresAt], recipients.map(r => r.prospectId)) };
  }
  /** The only way an owner email is scheduled to the audience: recount immediately before the queue command and refuse on any difference. */
  async schedule(identity: PortalSessionIdentity, requestId: string, input: { commandId: string; itemId: string; versionId: string; dueAt: string; expiresAt: string; count: number; digest: string; confirmed: boolean }): Promise<MhpEmailScheduleResult> {
    this.command(input.commandId);
    if (!Number.isSafeInteger(input.count) || input.count < 1 || input.count > MHP_CONFIRM_LIMIT || !/^[a-f0-9]{64}$/u.test(input.digest)) throw new MhpCommerceError(400, 'Open the email and press Schedule again. Nothing was scheduled.');
    if (!input.confirmed) throw new MhpCommerceError(400, 'Tick the box to confirm who will receive this, then press the button again. Nothing was scheduled.');
    const plan = await this.schedulePlan(identity, requestId, input.itemId, input.versionId, input.dueAt, input.expiresAt);
    if (!plan.ready || plan.count !== input.count || plan.digest !== input.digest) return { kind: 'changed', plan, previousCount: input.count };
    const result = await this.queueNow(identity, requestId, { action: 'schedule', commandId: input.commandId, versionId: input.versionId, dueAt: input.dueAt, expiresAt: input.expiresAt });
    return { kind: 'scheduled', scheduled: result.changed, expected: plan.count, unexpected: Math.max(0, result.changed - plan.count), replayed: result.replayed, dueAt: input.dueAt };
  }
  /** Replace / reschedule or cancel: how many unsent emails would change. Bound to that count and the chosen version and times. */
  async unsentPlan(identity: PortalSessionIdentity, requestId: string, itemId: string, versionId: string, action: 'replace' | 'cancel', dueAt = '', expiresAt = ''): Promise<MhpEmailUnsentPlan> {
    const detail = await this.review(identity, requestId, itemId, versionId);
    const database = await this.dependencies.repository.snapshot(identity, this.dependencies.campaign);
    const counts = database.ownerItems.find(item => item.contentItemId === itemId);
    const unsent = counts ? counts.pending + counts.held : 0;
    const base = { itemId, versionId, title: detail.review.title, subject: detail.review.email?.subject ?? '', unsent, inFlight: counts?.inFlight ?? 0,
      digest: mhpPeopleDigest(`mhp.owner-email-${action}/v1`, [itemId, versionId, dueAt, expiresAt, String(counts?.pending ?? 0), String(counts?.held ?? 0)], []) };
    if (action === 'replace' && !this.published(detail)) return { ...base, ready: false, refusal: 'Publish the latest version of this email before using it for the unsent emails.' };
    if (!unsent) return { ...base, ready: false, refusal: 'There are no unsent emails to change.' };
    return { ...base, ready: true, refusal: null };
  }
  async changeUnsent(identity: PortalSessionIdentity, requestId: string, input: { action: 'replace' | 'cancel'; commandId: string; itemId: string; versionId: string; dueAt: string; expiresAt: string; digest: string; confirmed: boolean }) {
    this.command(input.commandId);
    if (!input.confirmed && input.action === 'replace') throw new MhpCommerceError(400, 'Tick the box to confirm, then press the button again. Nothing was changed.');
    const plan = await this.unsentPlan(identity, requestId, input.itemId, input.versionId, input.action, input.dueAt, input.expiresAt);
    if (!plan.ready || plan.digest !== input.digest) return { kind: 'changed' as const, plan };
    const result = await this.queueNow(identity, requestId, { action: input.action, commandId: input.commandId, versionId: input.versionId, dueAt: input.dueAt, expiresAt: input.expiresAt });
    return { kind: 'done' as const, result };
  }
  async test(identity: PortalSessionIdentity, requestId: string, versionId: string, commandId: string): Promise<'accepted' | 'unknown'> {
    this.command(commandId);if (!uuid(versionId)) throw new MhpCommerceError(400, 'Choose a saved email.');
    await this.context(identity, requestId);
    if (!this.status.testEnabled || !this.dependencies.testRecipient || !this.dependencies.testSender) throw new MhpCommerceError(409, 'Owner test email is not configured or delivery is switched off.');
    const reservation = await this.dependencies.repository.testBegin(identity, commandId, versionId, hash(this.dependencies.testRecipient), requestId);
    if (!reservation.send) return reservation.status;
    try {
      const exact = reservation.exact!;
      const rendered = renderMhpOwnerEmail({ canonicalContent: exact.canonicalContent, contentSha256: exact.contentSha256,
        brand: parseMhpOwnerEmailBrand(exact.brand), firstName: 'Sam', label: 'Your webinar', link: 'https://martinhowardproperty.co.uk/webinar/',
        unsubscribe: 'https://example.invalid/unsubscribe-preview', preview: true });
      const reference = await this.dependencies.testSender.sendRendered({ id: reservation.testId!, email: this.dependencies.testRecipient,
        tag: 'owner_email_test', rendered, ownerTest: true });
      await this.dependencies.repository.testFinish(identity, commandId, true, reference);return 'accepted';
    } catch {
      try { await this.dependencies.repository.testFinish(identity, commandId, false, null); } catch { /* Reservation remains unknown, never automatically resent. */ }
      return 'unknown';
    }
  }
}

/** Preserve existing role/RLS/session transactions and add the native owner fence. */
export function mhpOwnerEmailContentRunner(pool: Pick<Pool, 'connect'>): CompanyContentTransactionRunner {
  const base = createCompanyContentTransactionRunner(pool);
  return { run(context, operation, options) {
    if (context.actorKind !== 'user' || !context.userId || !context.portalSessionTokenHash || context.workspaceId !== MHP_MARKETING_WORKSPACE_ID) {
      throw new MhpCommerceError(403, 'A current MHP owner session is required.');
    }
    return base.run(context, async transaction => {
      const result = await transaction.query<{ actor: string }>('SELECT app_private.mhp_owner_email_authorize($1) AS actor', [context.portalSessionTokenHash]);
      if (result.rows[0]?.actor !== context.userId) throw new MhpCommerceError(403, 'A current MHP owner session is required.');
      return operation(transaction);
    }, options);
  } };
}

export function createMhpOwnerEmailService(input: {
  web: Pool; identity: Pool; adapter: Pool; approvals: Pool; marketingWorkspace: Pick<PgMhpMarketingWorkspaceService, 'snapshot'>;
  campaign: string; env: NodeJS.ProcessEnv; marketing: MhpMarketingConfig | null; sender?: MhpRenderedMarketingSender;
}): MhpOwnerEmailService {
  const adapterTransactions = mhpOwnerEmailContentRunner(input.adapter);
  const configured = mhpOwnerEmailTestConfig(input.env, input.marketing);
  return new MhpOwnerEmailService({ marketingWorkspace: input.marketingWorkspace, repository: new PgMhpOwnerEmailRepository(input.web, input.identity),
    reader: new CompanyContentService({ transactionRunner: mhpOwnerEmailContentRunner(input.web) }),
    adapter: new CompanyContentService({ transactionRunner: adapterTransactions }), adapterTransactions,
    approvals: new CompanyContentService({ transactionRunner: mhpOwnerEmailContentRunner(input.approvals) }),
    campaign: input.campaign, status: configured.status, testRecipient: configured.recipient, testSender: input.sender });
}

export type MhpOwnerEmailSnapshot = Awaited<ReturnType<MhpOwnerEmailService['snapshot']>>;
export type MhpOwnerEmailReview = Awaited<ReturnType<MhpOwnerEmailService['review']>>;
