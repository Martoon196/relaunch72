import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { CompanyContentService, canonicalCompanyContentJson, type CompanyContentTransactionRunner, type CreateCompanyContentVersionCommand } from '../company-content-pg/index.js';
import { requestDatabaseContext, type DatabaseRequestContext } from '../db/rls.js';
import type { PortalSessionIdentity } from '../portal/auth-service.js';
import { MHP_OPAQUE_TOKEN } from './auth-service.js';
import { MhpCommerceError } from './commerce-service.js';
import { MHP_MARKETING_WORKSPACE_ID, type PgMhpMarketingWorkspaceService } from './marketing-workspace-service.js';
import { mhpOwnerEmailContentRunner, type MhpOwnerEmailService, type MhpOwnerEmailLocalVersion } from './owner-email-service.js';
import { parseMhpOwnerEmailBrand } from './owner-email-content.js';
import { canonicalFollowupSequence, FOLLOWUP_SEQUENCE_MIME, FOLLOWUP_SEQUENCE_SOURCE, FOLLOWUP_SEQUENCE_UUID, followupActivationBlockers,
  followupSequenceSha, followupTimeline, followupEntryIntent, parseFollowupSequence, readCanonicalFollowupSequence, type FollowupMessage, type FollowupSequenceDefinition, type FollowupSequenceReadiness } from '../followup-sequences/definition.js';
import type { FollowupRunState } from '../followup-sequences/state.js';
import { flowCommandUuid, parseFlowComposition, resolveFlowComposition, type FlowSavedMessageRef } from '../followup-sequences/composition.js';
import { previewFlowMessage } from '../followup-sequences/channel-drafts.js';
import { LocalFlowMessages, type FlowMessageReview } from '../followup-sequences/messages.js';
import { FlowLocalStore } from '../followup-sequences/local-store.js';
import { FlowWorkspaceError } from '../followup-sequences/workspace.js';
import { simulateFollowupFlow, flowSimulationPreset } from '../followup-sequences/simulation.js';
import type { FollowupEntryRule } from '../followup-sequences/entry.js';
import { readMhpWebinarCandidates, mhpWebinarLabel, MHP_CONFIRM_LIMIT, type MhpAudienceCandidate, type MhpAudienceCandidatePage } from './webinar-audience.js';
import { legacyFollowupAudience, followupAudienceCanStart, followupAudienceIsWebinar, followupAudienceIsBook, BOOK_READERS_DATABASE_STEP, FOLLOWUP_NO_AUDIENCE_RESUME, parseFollowupAudienceChoice, readStoredFollowupAudience, storedFollowupAudience,
  FOLLOWUP_NO_AUDIENCE_LINE, type FollowupAudience, type FollowupAudienceKind } from '../followup-sequences/audience.js';
import { FollowupSequenceValidationError } from '../followup-sequences/definition.js';

const hash = (value: string): Buffer => createHash('sha256').update(value).digest();
const uuid = (value: string): boolean => FOLLOWUP_SEQUENCE_UUID.test(value);
/** Prospect ids come from the database; any canonical lower-case UUID. */
const ANY_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const OPEN_STATES: readonly FollowupRunState[] = ['active', 'paused', 'held'];
/** The database enrols, pauses or resumes at most this many people per command. */
export const MHP_SEQUENCE_BATCH = 500;
/**
 * The snapshot this page reads holds the 100 most recent people across all sequences of the webinar
 * (0127 mhp_sequence_snapshot, LIMIT 100). A start is never larger than what the page can check before
 * and after it; the explicit-recipient migration removes this limit.
 */
export const MHP_SEQUENCE_VISIBLE = MHP_CONFIRM_LIMIT;
/** Held for these reasons, the database refuses a resume (0128 owner_hold_reason newer_draft / approval_or_brand_changed); never offer one. */
export const MHP_UNRESUMABLE_REASONS: readonly string[] = ['newer_sequence', 'content_changed'];
export const mhpRunResumable = (run: Pick<MhpSequenceRun, 'state' | 'reason' | 'unknownProofId'>): boolean =>
  (run.state === 'paused' || run.state === 'held') && !run.unknownProofId && !MHP_UNRESUMABLE_REASONS.includes(run.reason ?? '');
export interface MhpSequenceRun {
  id: string; contentItemId: string; contentVersionId: string; email: string; firstName: string | null;
  state: FollowupRunState; position: number; dueAt: string; reason: string | null; createdAt: string;
  lastAcceptedAt: string | null; inFlight: boolean; unknownProofId: string | null;
  definitionSchema?: string;
  steps: readonly { position: number; acceptedAt: string | null; dueAt: string; expiresAt: string; cancelled: boolean; failed: boolean; held: boolean; inFlight: boolean | null }[];
}
export interface MhpSequenceDatabaseSnapshot { brand: unknown; campaign: string; eligible: number; blocked: number; runs: readonly MhpSequenceRun[]; runCount: number; entryRules?: readonly FollowupEntryRule[] }
export interface MhpSequenceExact {
  contentItemId: string; contentVersionId: string; sourceItemId: string; sourceVersion: string; canonicalContent: string;
  contentSha256: string; blobSha256: string; brand: unknown; manifestSha256: string; approvalDecisionId: string | null;
  definition: FollowupSequenceDefinition; campaign: string;
}
export interface MhpSequenceLocal extends Omit<MhpOwnerEmailLocalVersion, 'exact'> { exact: MhpSequenceExact | null }
export interface MhpSequenceAction {
  action: 'enrol' | 'pause' | 'resume' | 'cancel' | 'stop'; commandId: string; itemId: string; versionId: string;
  runId: string; ackProofId: string;
}
export interface MhpSequenceActionResult { action: MhpSequenceAction['action']; contentItemId: string; contentVersionId: string;
  changed: number; remaining: number; blocked: number; inFlight: number; replayed: boolean }
export interface MhpEntryAction { action: 'activate' | 'off'; commandId: string; itemId: string; versionId: string; ruleId: string; expiresAt: string;
  /** The owner ticked the confirmation that names who will be added automatically, and until when. Required to switch entry on. */
  confirmed?: boolean }
export interface MhpEntryActionResult { action: MhpEntryAction['action']; contentItemId: string; contentVersionId: string; ruleId: string;
  state: 'active' | 'off'; expiresAt: string; watermark: string; replayed: boolean }
export type { MhpAudienceCandidate, MhpAudienceCandidatePage } from './webinar-audience.js';
export interface MhpSequenceRepository {
  snapshot(identity: PortalSessionIdentity, campaign: string): Promise<MhpSequenceDatabaseSnapshot>;
  /** Reads who registered for the webinar (25 at a time). Without it nothing can be started, because nobody could be shown. */
  audienceCandidates?(identity: PortalSessionIdentity, campaign: string, after: string | null): Promise<MhpAudienceCandidatePage>;
  local(identity: PortalSessionIdentity, versionId: string | null, revision: string | null): Promise<MhpSequenceLocal | null>;
  command(identity: PortalSessionIdentity, input: MhpSequenceAction & { campaign: string; requestId: string }): Promise<MhpSequenceActionResult>;
  entryCommand?(identity: PortalSessionIdentity, input: MhpEntryAction & { campaign: string; requestId: string }): Promise<MhpEntryActionResult>;
  /** 0160: exactly who the version's saved audience can start now; null while the database is still at 0159. */
  eligible?(identity: PortalSessionIdentity, versionId: string, campaign: string): Promise<MhpEligibleRead | null>;
  /** 0160: enrol exactly these people (the database refuses unless every one is eligible); null at 0159. */
  startV2?(identity: PortalSessionIdentity, input: { commandId: string; versionId: string; campaign: string; recipients: readonly string[]; requestId: string }): Promise<MhpSequenceActionResult | null>;
  /** 0160: resume exactly these people; null at 0159. */
  resumeV2?(identity: PortalSessionIdentity, input: { commandId: string; versionId: string; campaign: string; runIds: readonly string[]; requestId: string }): Promise<MhpSequenceActionResult | null>;
  /** 0160: the book readers automatic switch; null at 0159. */
  bookEntry?(identity: PortalSessionIdentity, input: { action: 'on' | 'off'; versionId: string; campaign: string; switchId: string }): Promise<MhpBookSwitchResult | null>;
  bookSwitches?(identity: PortalSessionIdentity): Promise<readonly MhpBookSwitch[] | null>;
}
/** One person the database says the version's saved audience can start now. */
export interface MhpEligiblePerson { prospectId: string; email: string; firstName: string | null; label: string | null; signedUpAt: string | null }
export interface MhpEligibleRead {
  audience: 'webinar_signups' | 'book_readers' | 'none_yet'; eligible: readonly MhpEligiblePerson[]; eligibleTotal: number;
  heldBack: { noConsent: number; unsubscribed: number; blocked: number; purchased: number; alreadyIn: number; earlierVersion: number };
  /** Book readers already in this sequence in any state (never entered again), up to 200. */
  alreadyIn: readonly { prospectId: string; email: string; firstName: string | null; state: FollowupRunState }[];
}
export interface MhpBookSwitch { id: string; contentItemId: string; contentVersionId: string; state: 'on' | 'off' | 'held'; activatedAt: string; disabledAt: string | null;
  heldReason: string | null; lastSweptAt: string | null; enrolled: number; skipped: number }
export interface MhpBookSwitchResult { action: 'on' | 'off'; contentItemId: string; contentVersionId: string; switchId: string; state: 'on' | 'off'; activatedAt: string; replayed: boolean }
export const MHP_SEQUENCE_CHANGED = 'This sequence, one of its emails or its approval changed while you were looking at it, so nothing was done. Open the sequence again to see where things stand now.';
export const MHP_SEQUENCE_UNAVAILABLE = 'Sequence controls are temporarily unavailable. Nothing was changed. Try again in a minute.';
export const MHP_SEQUENCE_NOT_READY = 'This sequence is not ready to send yet. Publish each of its emails and sort out any setup notes shown on the sequence page.';
export const MHP_START_NEEDS_CONFIRMATION = 'Starting a sequence now has a confirmation step that shows exactly who will receive it. Open the sequence and press Start again.';
/** The database is still at 0159: the 0160 function does not exist yet. */
const missingFunction = (error: unknown): boolean => (error as { code?: string })?.code === '42883';
function failure(error: unknown): never {
  if (error instanceof MhpCommerceError) throw error;
  const code = (error as { code?: string })?.code;
  if (code === '42501') throw new MhpCommerceError(403, 'Open the MHP marketing workspace with your owner account.');
  if (['23514', '23505', '40001'].includes(code ?? '')) throw new MhpCommerceError(409, MHP_SEQUENCE_CHANGED);
  if (code === '22023') throw new MhpCommerceError(400, 'That request could not be read. Open the sequence again and try once more.');
  throw new MhpCommerceError(503, MHP_SEQUENCE_UNAVAILABLE);
}
export class PgMhpSequenceRepository implements MhpSequenceRepository {
  constructor(private readonly web: Pick<Pool, 'query'>, private readonly commands: Pick<Pool, 'query'>) {}
  private token(identity: PortalSessionIdentity): Buffer {
    if (!MHP_OPAQUE_TOKEN.test(identity.sessionToken) || identity.workspaceId !== MHP_MARKETING_WORKSPACE_ID) throw new MhpCommerceError(403, 'Open the MHP marketing workspace first.');
    return hash(identity.sessionToken);
  }
  async snapshot(identity: PortalSessionIdentity, campaign: string): Promise<MhpSequenceDatabaseSnapshot> {
    try {
      const result = await this.web.query<{ value: MhpSequenceDatabaseSnapshot }>('SELECT app_private.mhp_sequence_snapshot($1,$2) AS value', [this.token(identity), campaign]);
      const value = result.rows[0]?.value;
      if (!value || value.campaign !== campaign || ![value.eligible, value.blocked, value.runCount].every(n => Number.isSafeInteger(n) && n >= 0)
          || !Array.isArray(value.runs) || value.runs.length > 100) throw new Error('Invalid sequence snapshot');
      if (value.entryRules !== undefined && (!Array.isArray(value.entryRules) || value.entryRules.length > 50 || value.entryRules.some(rule =>
        !uuid(rule.id) || !uuid(rule.contentItemId) || !uuid(rule.contentVersionId) || !['active', 'held', 'off', 'expired'].includes(rule.state)
        || ![rule.processed, rule.enrolled, rule.skipped, rule.blocked].every(n => Number.isSafeInteger(n) && n >= 0)
        || !/^\d{1,19}$/u.test(rule.cursorSequence) || !Number.isFinite(Date.parse(rule.activatedAt)) || !Number.isFinite(Date.parse(rule.expiresAt))
        || ![null, 'newer_sequence', 'content_changed', 'recovery'].includes(rule.heldReason)
        || (rule.cursorSignupId !== null && !uuid(rule.cursorSignupId))
        || [rule.cursorAt, rule.lastSweptAt].some(at => at !== null && !Number.isFinite(Date.parse(at)))))) throw new Error('Invalid entry rule snapshot');
      parseMhpOwnerEmailBrand(value.brand); return value;
    } catch (error) { return failure(error); }
  }
  async local(identity: PortalSessionIdentity, versionId: string | null, revision: string | null): Promise<MhpSequenceLocal | null> {
    try {
      const result = await this.web.query<{ value: MhpSequenceLocal | null }>('SELECT app_private.mhp_sequence_local_version($1,$2,$3) AS value', [this.token(identity), versionId, revision]);
      const value = result.rows[0]?.value;
      if (value === null) return null;
      if (!value || !uuid(value.contentItemId) || !uuid(value.contentVersionId) || followupSequenceSha(value.canonicalContent) !== value.contentSha256
          || typeof value.valid !== 'boolean' || (versionId && value.contentVersionId !== versionId) || (revision && value.sourceVersion !== revision)) throw new Error('Invalid sequence version');
      readCanonicalFollowupSequence(value.canonicalContent); return value;
    } catch (error) { return failure(error); }
  }
  async command(identity: PortalSessionIdentity, input: MhpSequenceAction & { campaign: string; requestId: string }): Promise<MhpSequenceActionResult> {
    try {
      const result = await this.commands.query<{ value: MhpSequenceActionResult }>('SELECT app_private.mhp_sequence_command($1,$2,$3,$4,$5,$6,$7,$8) AS value',
        [this.token(identity), input.action, input.commandId, input.versionId, input.campaign, input.runId || null, input.ackProofId || null, input.requestId]);
      const value = result.rows[0]?.value;
      if (!value || value.action !== input.action || value.contentItemId !== input.itemId || value.contentVersionId !== input.versionId
          || ![value.changed, value.remaining, value.blocked, value.inFlight].every(n => Number.isSafeInteger(n) && n >= 0) || typeof value.replayed !== 'boolean') throw new Error('Invalid sequence result');
      return value;
    } catch (error) { return failure(error); }
  }
  async audienceCandidates(identity: PortalSessionIdentity, campaign: string, after: string | null): Promise<MhpAudienceCandidatePage> {
    try {
      // The existing owner-session reader of 0125: the same anchor and consent columns the enrol audience (0126) uses.
      return await readMhpWebinarCandidates(this.web, this.token(identity), campaign, after);
    } catch (error) { return failure(error); }
  }
  async eligible(identity: PortalSessionIdentity, versionId: string, campaign: string): Promise<MhpEligibleRead | null> {
    try {
      const result = await this.web.query<{ value: MhpEligibleRead & { campaign: string; contentVersionId: string } }>('SELECT app_private.mhp_sequence_eligible($1,$2,$3) AS value', [this.token(identity), versionId, campaign]);
      const value = result.rows[0]?.value;
      const counts = value?.heldBack ? Object.values(value.heldBack) : [];
      if (!value || value.campaign !== campaign || value.contentVersionId !== versionId || !['webinar_signups', 'book_readers', 'none_yet'].includes(value.audience)
          || !Array.isArray(value.eligible) || value.eligible.length > 2000 || !Number.isSafeInteger(value.eligibleTotal) || value.eligibleTotal < value.eligible.length
          || counts.length !== 6 || !counts.every(n => Number.isSafeInteger(n) && n >= 0) || !Array.isArray(value.alreadyIn)
          || value.eligible.some(row => !ANY_UUID.test(row.prospectId) || typeof row.email !== 'string' || !row.email.includes('@') || (row.firstName !== null && typeof row.firstName !== 'string'))
          || value.alreadyIn.some(row => !ANY_UUID.test(row.prospectId) || typeof row.email !== 'string' || !OPEN_STATES.concat(['completed', 'stopped', 'cancelled', 'failed']).includes(row.state))) throw new Error('Invalid eligibility read');
      return { audience: value.audience, eligible: value.eligible.map(row => ({ prospectId: row.prospectId, email: row.email, firstName: row.firstName, label: row.label ?? null, signedUpAt: row.signedUpAt ?? null })),
        eligibleTotal: value.eligibleTotal, heldBack: value.heldBack, alreadyIn: value.alreadyIn };
    } catch (error) { if (missingFunction(error)) return null; return failure(error); }
  }
  async startV2(identity: PortalSessionIdentity, input: { commandId: string; versionId: string; campaign: string; recipients: readonly string[]; requestId: string }): Promise<MhpSequenceActionResult | null> {
    try {
      const result = await this.commands.query<{ value: MhpSequenceActionResult }>('SELECT app_private.mhp_sequence_start_v2($1,$2,$3,$4,$5::uuid[],$6) AS value',
        [this.token(identity), input.commandId, input.versionId, input.campaign, [...input.recipients], input.requestId]);
      const value = result.rows[0]?.value;
      if (!value || value.action !== 'enrol' || value.contentVersionId !== input.versionId || !Number.isSafeInteger(value.changed) || typeof value.replayed !== 'boolean') throw new Error('Invalid start result');
      return { ...value, remaining: 0, blocked: 0, inFlight: 0 };
    } catch (error) { if (missingFunction(error)) return null; return failure(error); }
  }
  async resumeV2(identity: PortalSessionIdentity, input: { commandId: string; versionId: string; campaign: string; runIds: readonly string[]; requestId: string }): Promise<MhpSequenceActionResult | null> {
    try {
      const result = await this.commands.query<{ value: MhpSequenceActionResult }>('SELECT app_private.mhp_sequence_resume_v2($1,$2,$3,$4,$5::uuid[],$6) AS value',
        [this.token(identity), input.commandId, input.versionId, input.campaign, [...input.runIds], input.requestId]);
      const value = result.rows[0]?.value;
      if (!value || value.action !== 'resume' || value.contentVersionId !== input.versionId || ![value.changed, value.blocked, value.inFlight].every(n => Number.isSafeInteger(n) && n >= 0)) throw new Error('Invalid resume result');
      return value;
    } catch (error) { if (missingFunction(error)) return null; return failure(error); }
  }
  async bookEntry(identity: PortalSessionIdentity, input: { action: 'on' | 'off'; versionId: string; campaign: string; switchId: string }): Promise<MhpBookSwitchResult | null> {
    try {
      const result = await this.commands.query<{ value: MhpBookSwitchResult }>('SELECT app_private.mhp_book_entry_command($1,$2,$3,$4,$5) AS value',
        [this.token(identity), input.action, input.versionId, input.campaign, input.switchId || null]);
      const value = result.rows[0]?.value;
      if (!value || value.action !== input.action || value.contentVersionId !== input.versionId || !uuid(value.switchId) || !['on', 'off'].includes(value.state) || typeof value.replayed !== 'boolean') throw new Error('Invalid switch result');
      return value;
    } catch (error) { if (missingFunction(error)) return null; return failure(error); }
  }
  async bookSwitches(identity: PortalSessionIdentity): Promise<readonly MhpBookSwitch[] | null> {
    try {
      const result = await this.web.query<{ value: MhpBookSwitch[] }>('SELECT app_private.mhp_book_entry_read($1) AS value', [this.token(identity)]);
      const value = result.rows[0]?.value;
      if (!Array.isArray(value) || value.length > 50 || value.some(row => !uuid(row.id) || !uuid(row.contentItemId) || !uuid(row.contentVersionId) || !['on', 'off', 'held'].includes(row.state)
          || ![row.enrolled, row.skipped].every(n => Number.isSafeInteger(n) && n >= 0))) throw new Error('Invalid switch read');
      return value;
    } catch (error) { if (missingFunction(error)) return null; return failure(error); }
  }
  async entryCommand(identity: PortalSessionIdentity, input: MhpEntryAction & { campaign: string; requestId: string }): Promise<MhpEntryActionResult> {
    try {
      const result = await this.commands.query<{ value: MhpEntryActionResult }>('SELECT app_private.mhp_sequence_entry_command($1,$2,$3,$4,$5,$6,$7,$8) AS value',
        [this.token(identity), input.action, input.commandId, input.versionId, input.campaign, input.ruleId || null, input.action === 'activate' ? input.expiresAt : null, input.requestId]);
      const value = result.rows[0]?.value;
      if (!value || value.action !== input.action || value.contentItemId !== input.itemId || value.contentVersionId !== input.versionId
          || !uuid(value.ruleId) || value.state !== (input.action === 'activate' ? 'active' : 'off') || !/^\d{1,19}$/u.test(value.watermark)
          || !Number.isFinite(Date.parse(value.expiresAt)) || typeof value.replayed !== 'boolean') throw new Error('Invalid entry command result');
      return value;
    } catch (error) { return failure(error); }
  }
}
/** `audience` omitted (an older form, or the owner draft tool) saves the sequence for no one yet; it is never silently the webinar. */
export interface MhpStartRecipient { prospectId: string; firstName: string | null; email: string }
export interface MhpStartRefusal { code: 'older_version' | 'no_audience' | 'not_published' | 'not_ready' | 'list_unavailable' | 'too_many' | 'list_changed' | 'nobody' | 'database_step'; message: string }
export interface MhpStartPlan {
  ready: boolean; refusal: MhpStartRefusal | null; itemId: string; versionId: string; title: string; audience: FollowupAudience; campaign: string;
  webinar: { label: string | null; date: string | null };
  /** Exactly who the next Start would email, in the database's own order, never more than MHP_SEQUENCE_VISIBLE. */
  recipients: readonly MhpStartRecipient[]; count: number; digest: string;
  heldBack: { noConsent: number; unsubscribed: number; alreadyIn: number; earlierVersion: number; blocked?: number; purchased?: number };
  messages: readonly { number: number; channel: string; subject: string | null; waitMinutes: number; offsetMinutes: number }[];
  mode: string;
  /** 0160: the list came from the database's own eligibility read and the start passes it as the explicit recipient list. */
  explicit?: boolean;
  /** 0160: eligible people beyond this confirmation (at most 500 are started per press); true, because the next read excludes those started. */
  remainingAfter?: number;
  /** Book readers already in this sequence in any state; they are never entered again. */
  alreadyInPeople?: readonly { prospectId: string; email: string; firstName: string | null; state: FollowupRunState }[];
}
export interface MhpStartInput { commandId: string; itemId: string; versionId: string; count: number; digest: string;
  /** Last 8 hex characters of each confirmed person's id, used only to explain a difference. */
  people: string; confirmed: boolean }
export type MhpStartResult =
  | { kind: 'started'; started: number; expected: number; replayed: boolean; unexpected: number; unexpectedPaused: number; inFlight: number; firstWaitMinutes: number;
      /** Confirmed people another tab had already started, and confirmed people who could no longer receive it. */
      startedElsewhere: number; notEligible: number;
      /** The added people could not all be seen, so everyone active in the sequence was paused instead. */
      pausedEveryone: boolean }
  | { kind: 'already_started'; count: number }
  | { kind: 'changed'; plan: MhpStartPlan; previousCount: number; added: readonly MhpStartRecipient[]; removed: readonly MhpStartRecipient[] };
export interface MhpBulkResult { kind: 'bulk'; action: 'pause' | 'resume' | 'stop'; changed: number; remaining: number; blocked: number; inFlight: number; replayed: boolean; batches: number }
export interface MhpResumePlan { ready: boolean; refusal: string | null; itemId: string; versionId: string; title: string; people: readonly MhpSequenceRun[]; needsCheck: number; digest: string }
export interface MhpPersonOutcome { runId: string; action: MhpSequenceAction['action']; code: 'done' | 'already' | 'used' | 'blocked' | 'not_ready' | 'unchanged' | 'gone' | 'no_audience' | 'newer_version';
  before: FollowupRunState | null; after: FollowupRunState | null; inFlight: boolean }
export function startDigest(itemId: string, versionId: string, prospectIds: readonly string[]): string {
  return createHash('sha256').update(['mhp.sequence-start/v1', itemId, versionId, ...prospectIds].join('\n')).digest('hex');
}
export function resumeDigest(itemId: string, runIds: readonly string[]): string {
  return createHash('sha256').update(['mhp.sequence-resume/v1', itemId, ...runIds].join('\n')).digest('hex');
}
/** The configured campaign key carries the webinar date (webinar-YYYY-MM-DD); nothing is guessed when it does not. */
export function webinarDate(campaign: string): string | null {
  const match = /(?:^|-)(\d{4}-\d{2}-\d{2})(?:$|-)/u.exec(campaign); if (!match) return null;
  const at = Date.parse(`${match[1]}T12:00:00Z`);
  return Number.isFinite(at) && new Date(at).toISOString().slice(0, 10) === match[1] ? new Date(at).toLocaleDateString('en-GB', { timeZone: 'Europe/London', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) : null;
}
export interface MhpSequenceSaveInput { commandId: string; contentItemId: string; previousVersionId: string; definition: unknown; inlineMessages?: unknown; audience?: unknown }
export class MhpSequenceService {
  constructor(private readonly dependencies: {
    marketingWorkspace: Pick<PgMhpMarketingWorkspaceService, 'snapshot'> & Partial<Pick<PgMhpMarketingWorkspaceService, 'select'>>; repository: MhpSequenceRepository;
    reader: Pick<CompanyContentService, 'listCatalog' | 'getExactReview'>;
    adapter: Pick<CompanyContentService, 'createVersion' | 'refreshSourceAttestation'>;
    approvals: Pick<CompanyContentService, 'requestApproval' | 'decideApproval'>; adapterTransactions: CompanyContentTransactionRunner;
    emails: Pick<MhpOwnerEmailService, 'snapshot' | 'status' | 'review'>; campaign: string; messages?: Pick<LocalFlowMessages, 'choices' | 'review' | 'save' | 'publish'>;
  }) {}
  async contentContext(identity: PortalSessionIdentity, requestId: string): Promise<DatabaseRequestContext> {
    const workspace = await this.dependencies.marketingWorkspace.snapshot(identity);
    if (!MHP_OPAQUE_TOKEN.test(identity.sessionToken) || identity.workspaceId !== MHP_MARKETING_WORKSPACE_ID || workspace.userId !== identity.userId
        || workspace.selectedWorkspaceId !== identity.workspaceId || !workspace.marketingSelected) throw new MhpCommerceError(403, 'Open the MHP marketing workspace first.');
    return requestDatabaseContext({ userId: identity.userId, workspaceId: identity.workspaceId, requestId, portalSessionTokenHash: hash(identity.sessionToken) });
  }
  private context(identity: PortalSessionIdentity, requestId: string) { return this.contentContext(identity, requestId); }
  private checked(value: unknown): FollowupSequenceDefinition {
    let definition: FollowupSequenceDefinition;
    try { definition = parseFollowupSequence(value); } catch (error) { throw new MhpCommerceError(400, (error as Error).message); }
    if (definition.brand !== 'mhp' || definition.campaign !== this.dependencies.campaign) throw new MhpCommerceError(400, 'Use the current MHP webinar audience.');
    return definition;
  }
  get readiness(): FollowupSequenceReadiness {
    const status = this.dependencies.emails.status;
    return { email: status.providerReady && status.mode !== 'off', sms: false, whatsapp: false, reply: false, booked: false, purchased: false };
  }
  async snapshot(identity: PortalSessionIdentity, requestId: string) {
    const context = await this.context(identity, requestId);
    const [database, catalog, emails] = await Promise.all([this.dependencies.repository.snapshot(identity, this.dependencies.campaign),
      this.dependencies.reader.listCatalog(context, { limit: 50, sourceSystem: FOLLOWUP_SEQUENCE_SOURCE }), this.dependencies.emails.snapshot(identity, requestId)]);
    // 0160 present: the book readers switches can be read; null means the database is still one step behind.
    const bookSwitches = this.dependencies.repository.bookSwitches ? await this.dependencies.repository.bookSwitches(identity) : null;
    return { database, catalog, emailCatalog: emails.catalog, readiness: this.readiness, mode: this.dependencies.emails.status.mode, bookSwitches,
      entryAvailable: Boolean(this.dependencies.repository.entryCommand),
      ...(this.dependencies.messages ? { messageChoices: await this.dependencies.messages.choices(identity, requestId) } : {}) };
  }
  async review(identity: PortalSessionIdentity, requestId: string, itemId: string, versionId: string) {
    if (!uuid(itemId) || !uuid(versionId)) throw new MhpCommerceError(400, 'Choose a saved sequence.');
    const context = await this.context(identity, requestId);
    const [review, local] = await Promise.all([this.dependencies.reader.getExactReview(context, { contentItemId: itemId, contentVersionId: versionId }), this.dependencies.repository.local(identity, versionId, null)]);
    if (!review || review.kind !== 'other' || review.source.system !== FOLLOWUP_SEQUENCE_SOURCE || !local || local.contentItemId !== itemId || local.contentSha256 !== review.contentSha256)
      throw new MhpCommerceError(404, 'This sequence was not found in the MHP workspace.');
    const definition = this.checked(readCanonicalFollowupSequence(review.canonicalContent));
    const blockers = new Set(followupActivationBlockers(definition, this.readiness));
    const selected = new Map(definition.steps.filter((step): step is FollowupMessage => step.kind !== 'wait' && (Boolean(this.dependencies.messages) || step.kind === 'email')).map(step => [step.contentVersionId, step]));
    const messages: FlowMessageReview[] = [], subjects: Record<string, string> = {};
    for (const step of selected.values()) {
      try {
        if (this.dependencies.messages) {
          const message = await this.dependencies.messages.review(identity, requestId, step.kind, step.contentItemId, step.contentVersionId); messages.push(message);
          if ('subject' in message.payload && typeof message.payload.subject === 'string') subjects[step.contentVersionId] = message.payload.subject;
          if (!message.review.isLatest || message.review.approvalStatus !== 'approved' || message.review.approvalStale || !message.valid || message.review.contentSha256 !== step.contentSha256) blockers.add('email_version_not_ready');
        } else {
          const email = await this.dependencies.emails.review(identity, requestId, step.contentItemId, step.contentVersionId);
          if (typeof email.review.email?.subject === 'string') subjects[step.contentVersionId] = email.review.email.subject;
          if (!email.review.isLatest || email.review.approvalStatus !== 'approved' || email.review.approvalStale || !email.local.valid || email.review.contentSha256 !== step.contentSha256) blockers.add('email_version_not_ready');
        }
      } catch (error) { if ((error instanceof MhpCommerceError || error instanceof FlowWorkspaceError) && [404, 409].includes(error.status)) blockers.add('email_version_not_ready'); else throw error; }
    }
    // Only an explicit, valid choice saved with this version counts. Anything else is "none yet", whatever people it has.
    const audience = readStoredFollowupAudience(local.metadata) ?? legacyFollowupAudience();
    return { review, local, definition, blockers: [...blockers], timeline: followupTimeline(definition), audience, subjects, ...(this.dependencies.messages ? { messages } : {}) };
  }
  async preview(identity: PortalSessionIdentity, requestId: string, value: unknown, inlineMessages?: unknown) {
    await this.context(identity, requestId); const composition = inlineMessages === undefined ? null : parseFlowComposition(value, inlineMessages), definition = this.checked(composition?.definition ?? value);
    const previews: ReturnType<typeof previewFlowMessage>[] = [];
    for (const step of definition.steps) if (step.kind !== 'wait') {
      const inline = composition?.inlineMessages[step.key];
      if (inline) previews.push(previewFlowMessage(step.kind, inline.payload));
      else if (this.dependencies.messages) {
        const message = await this.dependencies.messages.review(identity, requestId, step.kind, step.contentItemId, step.contentVersionId);
        if (message.review.contentSha256 !== step.contentSha256) throw new MhpCommerceError(409, 'Choose the exact saved message version before previewing.');
        previews.push(previewFlowMessage(step.kind, message.payload));
      }
    }
    return { definition, timeline: followupTimeline(definition), blockers: followupActivationBlockers(definition, this.readiness),
      ...(composition || this.dependencies.messages ? { messagePreviews: previews } : {}) };
  }
  async simulate(identity: PortalSessionIdentity, requestId: string, value: unknown, inlineMessages?: unknown, simulationCase = 'happy') {
    const preview = await this.preview(identity, requestId, value, inlineMessages);
    return { ...preview, simulation: simulateFollowupFlow(preview.definition, this.readiness, flowSimulationPreset(simulationCase, preview.definition)) };
  }
  async message(identity: PortalSessionIdentity, requestId: string, channel: 'email' | 'sms' | 'whatsapp', itemId: string, versionId: string) {
    await this.context(identity, requestId);
    if (!this.dependencies.messages) throw new MhpCommerceError(503, 'The inline message library is unavailable.');
    const detail = await this.dependencies.messages.review(identity, requestId, channel, itemId, versionId);
    return { channel, title: detail.review.title, contentItemId: detail.review.contentItemId, contentVersionId: detail.review.contentVersionId, contentSha256: detail.review.contentSha256, payload: detail.payload };
  }
  async save(identity: PortalSessionIdentity, requestId: string, input: MhpSequenceSaveInput, now = Date.now()) {
    if (!uuid(input.commandId) || Boolean(input.contentItemId) !== Boolean(input.previousVersionId)) throw new MhpCommerceError(400, 'Refresh the sequence form before saving.');
    let audienceKind: FollowupAudienceKind;
    try { audienceKind = parseFollowupAudienceChoice(input.audience); } catch (error) { throw new MhpCommerceError(400, (error as FollowupSequenceValidationError).message); }
    const context = await this.context(identity, requestId), composition = input.inlineMessages === undefined ? null : parseFlowComposition(input.definition, input.inlineMessages);
    let definition = this.checked(composition?.definition ?? input.definition);
    if (composition && Object.keys(composition.inlineMessages).length) {
      if (!this.dependencies.messages) throw new MhpCommerceError(503, 'The inline message editor is unavailable.');
      const saved: Record<string, FlowSavedMessageRef> = {};
      for (const [key, message] of Object.entries(composition.inlineMessages)) saved[key] = await this.dependencies.messages.save(identity, requestId, flowCommandUuid(input.commandId, key), message, now);
      definition = this.checked(resolveFlowComposition(composition, saved));
    }
    const canonical = canonicalFollowupSequence(definition);
    const replay = async () => {
      const saved = await this.dependencies.repository.local(identity, null, `edit:${input.commandId}`);
      if (!saved) return null;
      if (saved.canonicalContent !== canonical || saved.previousVersionId !== (input.previousVersionId || null) || (input.contentItemId && saved.contentItemId !== input.contentItemId)
          || readStoredFollowupAudience(saved.metadata)?.kind !== audienceKind)
        throw new MhpCommerceError(409, 'This save command already has different sequence details. Refresh the editor.');
      return { contentItemId: saved.contentItemId, contentVersionId: saved.contentVersionId, replayed: true };
    };
    const prior = await replay(); if (prior) return prior;
    const old = input.contentItemId ? await this.review(identity, requestId, input.contentItemId, input.previousVersionId) : null;
    if (old && !old.review.isLatest) throw new MhpCommerceError(409, 'Open the latest sequence draft before editing.');
    const snapshot = await this.dependencies.repository.snapshot(identity, this.dependencies.campaign), brand = parseMhpOwnerEmailBrand(snapshot.brand);
    const sha = followupSequenceSha(canonical), item = old?.review.source.itemId ?? `sequence:${input.commandId}`, revision = `edit:${input.commandId}`, storageKey = `inline:mhp.followup-sequence:${sha}`;
    const manifest = canonicalCompanyContentJson({ schema: 'mhp.followup-sequence-source/v1', workspaceId: MHP_MARKETING_WORKSPACE_ID,
      sourceSystem: FOLLOWUP_SEQUENCE_SOURCE, sourceItemId: item, sourceVersion: revision, contentSha256: sha, blobStorageKey: storageKey, blobSha256: sha,
      brandSnapshotRef: brand.ref, brandSha256: brand.sha256, audienceCampaign: this.dependencies.campaign });
    const command: CreateCompanyContentVersionCommand = { commandKey: `mhp.sequence.save.${input.commandId}`, contentItemId: old?.review.contentItemId ?? null,
      previousVersionId: old?.review.contentVersionId ?? null, origin: old ? 'edited' : 'imported', kind: 'other', title: definition.title, contentMimeType: FOLLOWUP_SEQUENCE_MIME,
      content: canonical, source: { system: FOLLOWUP_SEQUENCE_SOURCE, itemId: item, version: revision }, blob: { storageKey, sha256: sha }, brand: { snapshotRef: brand.ref, sha256: brand.sha256 },
      attestation: { catalogSha256: followupSequenceSha(manifest), checkedAt: new Date(now).toISOString(), expiresAt: new Date(now + 900_000).toISOString() },
      metadata: { mhpSequence: { schema: 'mhp.followup-sequence-local/v1', brandCanonical: brand.canonical, manifestCanonical: manifest, manifestSha256: followupSequenceSha(manifest), authoredBy: 'native-owner',
        audience: storedFollowupAudience(audienceKind, this.dependencies.campaign) } } };
    try { const result = await this.dependencies.adapter.createVersion(context, command); return { contentItemId: result.contentItemId, contentVersionId: result.contentVersionId, replayed: result.disposition === 'replayed' }; }
    catch (error) { const winner = await replay(); if (winner) return winner; return failure(error); }
  }
  async publish(identity: PortalSessionIdentity, requestId: string, itemId: string, versionId: string, commandId: string, now = Date.now()): Promise<void> {
    if (!uuid(commandId)) throw new MhpCommerceError(400, 'Refresh the sequence form.');
    const context = await this.context(identity, requestId), detail = await this.review(identity, requestId, itemId, versionId), exact = detail.local.exact;
    if (!detail.review.isLatest || !detail.local.valid || !exact) throw new MhpCommerceError(409, 'Save a fresh sequence with the current brand before publishing.');
    if (this.dependencies.messages) {
      const selected = detail.definition.steps.filter((step): step is FollowupMessage => step.kind !== 'wait');
      if ((detail.messages?.length ?? 0) !== new Set(selected.map(step => step.contentVersionId)).size
          || detail.messages?.some(message => !message.valid || !message.review.isLatest)) throw new MhpCommerceError(409, 'Choose current exact local message versions before publishing this blueprint.');
      const done = new Set<string>();
      for (const step of selected) if (!done.has(step.contentVersionId)) { await this.dependencies.messages.publish(identity, requestId, step.kind, step.contentItemId, step.contentVersionId, flowCommandUuid(commandId, step.key), now); done.add(step.contentVersionId); }
    }
    if (detail.review.approvalStatus === 'approved' && !detail.review.approvalStale) return;
    const key = `mhp.sequence.publish.${commandId}.refresh`, brand = parseMhpOwnerEmailBrand(exact.brand);
    const recorded = () => this.dependencies.adapterTransactions.run(context, async transaction => {
      const result = await transaction.query<{ status: string; result: { contentItemId?: string; contentVersionId?: string } }>(`SELECT status,result FROM app.command_receipts
       WHERE workspace_id=app_private.current_workspace_id() AND actor_user_id=app_private.current_user_id() AND command_name='companyContent.refreshSourceAttestation' AND idempotency_key=$1`, [key]);
      if (!result.rows[0]) return false; const row = result.rows[0];
      if (row.status !== 'succeeded' || row.result.contentItemId !== itemId || row.result.contentVersionId !== versionId) throw new MhpCommerceError(409, 'This publication check changed. Refresh the sequence.');
      return true;
    }, { readOnly: true });
    try {
      if (!await recorded()) try { await this.dependencies.adapter.refreshSourceAttestation(context, { commandKey: key, contentItemId: itemId, contentVersionId: versionId,
        expected: { source: { system: FOLLOWUP_SEQUENCE_SOURCE, itemId: exact.sourceItemId, version: exact.sourceVersion }, contentSha256: exact.contentSha256,
          blobSha256: exact.blobSha256, brandSha256: brand.sha256 }, attestation: { catalogSha256: exact.manifestSha256, checkedAt: new Date(now).toISOString(), expiresAt: new Date(now + 900_000).toISOString() } }); }
      catch (error) { if (!await recorded()) throw error; }
      const requested = await this.dependencies.approvals.requestApproval(context, { commandKey: `mhp.sequence.publish.${commandId}.request`, contentItemId: itemId, contentVersionId: versionId, reviewNote: 'Native owner reviewed this exact follow-up sequence. No enrolment or send effect.' });
      await this.dependencies.approvals.decideApproval(context, { commandKey: `mhp.sequence.publish.${commandId}.approve`, approvalRequestId: requested.approvalRequestId, decision: 'approved', decisionNote: 'Published by native MHP owner; starting a sequence remains an explicit separate action.' });
    } catch (error) { const after = await this.review(identity, requestId, itemId, versionId); if (after.review.isLatest && after.review.approvalStatus === 'approved' && !after.review.approvalStale && after.local.valid) return; return failure(error); }
  }
  async command(identity: PortalSessionIdentity, requestId: string, input: MhpSequenceAction): Promise<MhpSequenceActionResult> {
    if (!uuid(input.commandId) || !uuid(input.versionId) || !uuid(input.itemId) || (input.runId && !uuid(input.runId)) || (input.ackProofId && !uuid(input.ackProofId))) throw new MhpCommerceError(400, 'Refresh the sequence controls before continuing.');
    // Starting is only ever the confirmed path below (start), bound to the exact people the owner saw.
    if (input.action === 'enrol') throw new MhpCommerceError(409, MHP_START_NEEDS_CONFIRMATION);
    const detail = await this.review(identity, requestId, input.itemId, input.versionId);
    // Resuming restarts sending, so it needs the same audience as starting. Pause, stop and remove are always allowed.
    if (input.action === 'resume' && !followupAudienceCanStart(detail.audience, this.dependencies.campaign)) throw new MhpCommerceError(409, FOLLOWUP_NO_AUDIENCE_RESUME);
    if (input.action === 'resume' && detail.blockers.length) throw new MhpCommerceError(409, MHP_SEQUENCE_NOT_READY);
    return this.dependencies.repository.command(identity, { ...input, campaign: this.dependencies.campaign, requestId });
  }
  async entryCommand(identity: PortalSessionIdentity, requestId: string, input: MhpEntryAction, now = Date.now()): Promise<MhpEntryActionResult> {
    if (!uuid(input.commandId) || !uuid(input.itemId) || !uuid(input.versionId) || (input.ruleId && !uuid(input.ruleId))
        || (input.action === 'activate' ? Boolean(input.ruleId) : !input.ruleId || Boolean(input.expiresAt))) throw new MhpCommerceError(400, 'Refresh the future-signup controls before continuing.');
    const detail = await this.review(identity, requestId, input.itemId, input.versionId);
    if (input.action === 'activate') {
      const expires = Date.parse(input.expiresAt);
      if (!Number.isFinite(expires) || expires <= now || new Date(expires).toISOString() !== input.expiresAt) throw new MhpCommerceError(400, 'Choose a valid future stop time in UTC.');
      if (!followupAudienceIsWebinar(detail.audience, this.dependencies.campaign)) throw new MhpCommerceError(409, followupAudienceIsBook(detail.audience)
        ? 'Automatic webinar sign-ups are only for a sequence saved for webinar sign-ups. Use “Send this to each new book sign-up automatically” instead.' : FOLLOWUP_NO_AUDIENCE_LINE);
      if (!detail.review.isLatest || detail.review.approvalStatus !== 'approved' || detail.review.approvalStale || !detail.local.valid
          || detail.blockers.length || followupEntryIntent(detail.definition).mode !== 'webinar_signup') {
        throw new MhpCommerceError(409, 'Publish the latest version of this sequence, with "Future webinar sign-ups" chosen under How people join, before switching on automatic sign-ups.');
      }
      if (input.confirmed !== true) throw new MhpCommerceError(400, 'Tick the box to confirm who will be added automatically, then press the button again.');
    }
    if (!this.dependencies.repository.entryCommand) throw new MhpCommerceError(503, 'Future webinar entry is not connected yet.');
    return this.dependencies.repository.entryCommand(identity, { ...input, campaign: this.dependencies.campaign, requestId });
  }
  /** Opens the MHP marketing workspace for this session, the same selection the marketing workspace page makes, so an owner can come straight back. */
  async openWorkspace(identity: PortalSessionIdentity, commandId: string, now = Date.now()): Promise<{ sessionToken: string; expiresAt: string; workspaceId: string }> {
    if (!this.dependencies.marketingWorkspace.select) throw new MhpCommerceError(503, 'Open the marketing workspace from the Marketing workspace page.');
    const selected = await this.dependencies.marketingWorkspace.select(identity, 'open', commandId, now);
    if (selected.workspaceId !== MHP_MARKETING_WORKSPACE_ID) throw new MhpCommerceError(503, 'The marketing workspace did not open. Sign in again.');
    return selected;
  }
  /** "Send this to each new book sign-up automatically": switch on (needs the owner's tick) or off. */
  async bookEntry(identity: PortalSessionIdentity, requestId: string, input: { action: 'on' | 'off'; itemId: string; versionId: string; switchId: string; confirmed: boolean }): Promise<MhpBookSwitchResult> {
    if (!uuid(input.itemId) || !uuid(input.versionId) || (input.action === 'off' ? !uuid(input.switchId) : input.switchId !== '')) throw new MhpCommerceError(400, 'Open the sequence and try again.');
    const detail = await this.review(identity, requestId, input.itemId, input.versionId);
    if (input.action === 'on') {
      if (!followupAudienceIsBook(detail.audience)) throw new MhpCommerceError(409, 'Automatic sending to new book sign-ups is only for a sequence saved for book readers.');
      if (!detail.review.isLatest || detail.review.approvalStatus !== 'approved' || detail.review.approvalStale || !detail.local.valid) throw new MhpCommerceError(409, 'Publish the latest version of this sequence before switching this on.');
      if (detail.blockers.length) throw new MhpCommerceError(409, MHP_SEQUENCE_NOT_READY);
      if (!input.confirmed) throw new MhpCommerceError(400, 'Tick the box to confirm, then press the button again. Nothing was switched on.');
    }
    const result = this.dependencies.repository.bookEntry
      ? await this.dependencies.repository.bookEntry(identity, { action: input.action, versionId: input.versionId, campaign: this.dependencies.campaign, switchId: input.switchId }) : null;
    if (!result) throw new MhpCommerceError(409, BOOK_READERS_DATABASE_STEP);
    return result;
  }
  /** Who pressing Start would email right now, exactly as the database will choose them, or why it cannot be started. Reads only. */
  async startPlan(identity: PortalSessionIdentity, requestId: string, itemId: string, versionId: string): Promise<MhpStartPlan> {
    const detail = await this.review(identity, requestId, itemId, versionId);
    return this.plan(identity, detail, await this.dependencies.repository.snapshot(identity, this.dependencies.campaign));
  }
  private async plan(identity: PortalSessionIdentity, detail: MhpSequenceReview, database: MhpSequenceDatabaseSnapshot): Promise<MhpStartPlan> {
    const campaign = this.dependencies.campaign, itemId = detail.review.contentItemId, versionId = detail.review.contentVersionId;
    const messages = detail.timeline.map((step, index) => ({ number: index + 1, channel: step.step.kind, subject: detail.subjects?.[step.step.contentVersionId] ?? null,
      waitMinutes: step.waitMinutes, offsetMinutes: step.earliestOffsetMinutes }));
    const base = { itemId, versionId, title: detail.definition.title, audience: detail.audience, campaign, webinar: { label: null as string | null, date: webinarDate(campaign) },
      recipients: [] as MhpStartRecipient[], count: 0, digest: '', heldBack: { noConsent: 0, unsubscribed: 0, alreadyIn: 0, earlierVersion: 0 },
      messages, mode: this.dependencies.emails.status.mode };
    const refuse = (code: MhpStartRefusal['code'], message: string, extra: Partial<MhpStartPlan> = {}): MhpStartPlan => ({ ...base, ...extra, ready: false, refusal: { code, message } });
    if (!detail.review.isLatest) return refuse('older_version', 'This is an older version of the sequence. Open the latest version to start it.');
    if (!followupAudienceCanStart(detail.audience, campaign)) return refuse('no_audience', detail.audience.kind === 'webinar_signups'
      ? 'This sequence is for the sign-ups of a different webinar, so it cannot be started from here.' : FOLLOWUP_NO_AUDIENCE_LINE);
    if (detail.review.approvalStatus !== 'approved' || detail.review.approvalStale || !detail.local.valid) return refuse('not_published', 'Publish this version before starting it.');
    if (detail.blockers.length) return refuse('not_ready', MHP_SEQUENCE_NOT_READY);
    // 0160: the database says exactly who is eligible, and the start passes them as an explicit list.
    const read = this.dependencies.repository.eligible ? await this.dependencies.repository.eligible(identity, versionId, campaign) : null;
    if (read) {
      if (read.audience !== detail.audience.kind) return refuse('no_audience', FOLLOWUP_NO_AUDIENCE_LINE);
      const sorted = [...read.eligible].sort((a, b) => a.prospectId < b.prospectId ? -1 : a.prospectId > b.prospectId ? 1 : 0);
      const batch = sorted.slice(0, MHP_SEQUENCE_BATCH).map(c => ({ prospectId: c.prospectId, firstName: c.firstName, email: c.email }));
      const extra = { heldBack: { ...read.heldBack }, alreadyInPeople: read.alreadyIn, explicit: true,
        webinar: { label: followupAudienceIsBook(detail.audience) ? null : mhpWebinarLabel(read.eligible.map(c => ({ ...c, registeredAt: null, marketingConsent: true, unsubscribed: false, signupConsentGiven: true }))), date: base.webinar.date } };
      if (!batch.length) return refuse('nobody', read.heldBack.alreadyIn ? 'Everyone who can receive this sequence is already in it. Nobody new would be emailed.'
        : 'Nobody can receive this sequence right now.', extra);
      return { ...base, ...extra, recipients: batch, count: batch.length, digest: startDigest(itemId, versionId, batch.map(r => r.prospectId)),
        remainingAfter: Math.max(0, read.eligibleTotal - batch.length), ready: true, refusal: null };
    }
    if (followupAudienceIsBook(detail.audience)) return refuse('database_step', BOOK_READERS_DATABASE_STEP);
    if (database.campaign !== campaign) return refuse('list_unavailable', 'The list of people could not be read. Nothing was started.');
    const reader = this.dependencies.repository.audienceCandidates?.bind(this.dependencies.repository);
    if (!reader) return refuse('list_unavailable', 'The list of people who would receive this cannot be shown here yet, so the sequence cannot be started.');
    // Every person the page knows about must be the whole story, or exclusions could be wrong.
    if (database.runs.length < database.runCount) return refuse('too_many', `This webinar already has more people in sequences (${database.runCount}) than this page can safely check, so it cannot be started from here. Nothing was started.`);
    const candidates: MhpAudienceCandidate[] = []; let after: string | null = null;
    for (let page = 0; ; page++) {
      if (page >= 400) return refuse('too_many', 'There are too many sign-ups to list on one page, so this cannot be started from here. Nothing was started.');
      const next: MhpAudienceCandidatePage = await reader(identity, campaign, after);
      candidates.push(...next.candidates);
      if (!next.hasMore) break; after = next.nextAfter;
    }
    const key = (email: string) => email.trim().toLowerCase();
    const runs = database.runs.filter(run => run.contentItemId === itemId);
    const inThisVersion = new Set(runs.filter(run => run.contentVersionId === versionId).map(run => key(run.email)));
    const inEarlier = new Set(runs.filter(run => run.contentVersionId !== versionId && OPEN_STATES.includes(run.state)).map(run => key(run.email)));
    const eligible = candidates.filter(c => c.marketingConsent && !c.unsubscribed && c.signupConsentGiven);
    const heldBack = { unsubscribed: candidates.filter(c => c.unsubscribed).length, noConsent: candidates.filter(c => !c.unsubscribed && !(c.marketingConsent && c.signupConsentGiven)).length,
      alreadyIn: eligible.filter(c => inThisVersion.has(key(c.email))).length, earlierVersion: eligible.filter(c => !inThisVersion.has(key(c.email)) && inEarlier.has(key(c.email))).length };
    const labels = new Map<string, number>(); for (const c of eligible) if (c.label) labels.set(c.label, (labels.get(c.label) ?? 0) + 1);
    const webinar = { label: [...labels.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null, date: base.webinar.date };
    if (eligible.length !== database.eligible) return refuse('list_changed', 'The list of people changed while it was being read. Nothing was started. Open this page again to see the current list.', { webinar, heldBack });
    const pending = eligible.filter(c => !inThisVersion.has(key(c.email)) && !inEarlier.has(key(c.email))).sort((a, b) => a.prospectId < b.prospectId ? -1 : a.prospectId > b.prospectId ? 1 : 0);
    if (pending.length > MHP_SEQUENCE_VISIBLE) return refuse('too_many', `This list is longer than this page can safely check (${pending.length} people). Nothing was started.`, { webinar, heldBack });
    const batch = pending.map(c => ({ prospectId: c.prospectId, firstName: c.firstName, email: c.email }));
    const result = { webinar, heldBack, recipients: batch, count: batch.length, digest: startDigest(itemId, versionId, batch.map(r => r.prospectId)) };
    if (!batch.length) return refuse('nobody', heldBack.alreadyIn ? 'Everyone who can receive this sequence is already in it. Nobody new would be emailed.' : 'Nobody can receive this sequence right now: nobody who registered has agreed to emails or is not already in it.', result);
    return { ...base, ...result, ready: true, refusal: null };
  }
  /**
   * The only way a sequence starts. It recomputes who would receive it immediately before the database
   * call and refuses, starting nothing, unless that is exactly the list the owner confirmed.
   */
  async start(identity: PortalSessionIdentity, requestId: string, input: MhpStartInput): Promise<MhpStartResult> {
    if (!uuid(input.commandId) || !uuid(input.itemId) || !uuid(input.versionId) || !Number.isSafeInteger(input.count) || input.count < 1 || input.count > MHP_SEQUENCE_BATCH
        || !/^[a-f0-9]{64}$/u.test(input.digest) || !/^(?:[a-f0-9]{8})*$/u.test(input.people)) throw new MhpCommerceError(400, 'Open the sequence and press Start again.');
    if (!input.confirmed) throw new MhpCommerceError(400, 'Tick the box to confirm who will receive this, then press the button again.');
    const detail = await this.review(identity, requestId, input.itemId, input.versionId);
    const before = await this.dependencies.repository.snapshot(identity, this.dependencies.campaign), plan = await this.plan(identity, detail, before);
    const confirmed = new Set(input.people.match(/.{8}/gu) ?? []);
    if (!plan.ready || plan.count !== input.count || plan.digest !== input.digest) {
      // Pressing the same confirmation twice: everyone confirmed is already in this version, so this is the earlier start, not a change.
      const started = new Set(before.runs.filter(run => run.contentVersionId === input.versionId).map(run => run.email.trim().toLowerCase()));
      const known = await this.knownPeople(identity, plan, confirmed);
      if (confirmed.size === input.count && known.length === confirmed.size && known.every(person => started.has(person.email.trim().toLowerCase())))
        return { kind: 'already_started', count: input.count };
      if (!plan.ready && !['nobody', 'list_changed'].includes(plan.refusal!.code)) throw new MhpCommerceError(409, plan.refusal!.message);
      const now = new Set(plan.recipients.map(person => person.prospectId.slice(-8)));
      return { kind: 'changed', plan, previousCount: input.count, added: plan.recipients.filter(person => confirmed.size && !confirmed.has(person.prospectId.slice(-8))),
        removed: known.filter(person => !now.has(person.prospectId.slice(-8))) };
    }
    if (plan.explicit) return this.startExplicit(identity, requestId, input, plan);
    const result = await this.dependencies.repository.command(identity, { action: 'enrol', commandId: input.commandId, itemId: input.itemId, versionId: input.versionId,
      runId: '', ackProofId: '', campaign: this.dependencies.campaign, requestId });
    // Narrow race: someone who became eligible between the check above and the database call is started too.
    // Pause anyone new who was not on the confirmed list; their first email may already be on its way.
    const after = await this.dependencies.repository.snapshot(identity, this.dependencies.campaign);
    const key = (email: string) => email.trim().toLowerCase();
    const known = new Set(before.runs.map(run => run.id)), listed = new Set(plan.recipients.map(person => key(person.email)));
    const fresh = after.runs.filter(run => run.contentVersionId === input.versionId && !known.has(run.id));
    const inVersion = new Set(after.runs.filter(run => run.contentVersionId === input.versionId).map(run => key(run.email)));
    const extra = fresh.filter(run => !listed.has(key(run.email)));
    // The page sees the 100 most recent people. If the start created more new people than the page can now see,
    // the unexpected ones cannot be told apart: pause everyone active in this sequence instead, and say so.
    const allVisible = after.runs.length >= after.runCount || fresh.length >= result.changed;
    const unexpected = Math.max(extra.length, result.changed - plan.count);
    let paused = 0, pausedEveryone = false;
    if (unexpected > 0 && !allVisible) {
      const all = await this.bulk(identity, requestId, 'pause', { commandId: flowCommandUuid(input.commandId, 'extra-all'), itemId: input.itemId, versionId: input.versionId });
      paused = all.changed; pausedEveryone = true;
    } else for (const [index, run] of extra.filter(run => run.state === 'active').entries()) {
      const outcome = await this.dependencies.repository.command(identity, { action: 'pause', commandId: flowCommandUuid(input.commandId, `extra-${index}`), itemId: input.itemId,
        versionId: input.versionId, runId: run.id, ackProofId: '', campaign: this.dependencies.campaign, requestId });
      paused += outcome.changed;
    }
    // Confirmed people not started by this press: another tab got there first, or they can no longer receive it.
    // Counted, not guessed per person: the snapshot does not say which press created a run.
    const listedInVersion = plan.recipients.filter(person => inVersion.has(key(person.email))).length;
    const startedByThisPress = Math.max(0, result.changed - unexpected);
    const startedElsewhere = result.replayed ? 0 : Math.max(0, listedInVersion - startedByThisPress);
    const notEligible = result.replayed ? 0 : Math.max(0, plan.count - listedInVersion);
    return { kind: 'started', started: result.changed, expected: plan.count, replayed: result.replayed, unexpected, unexpectedPaused: paused, pausedEveryone,
      inFlight: result.inFlight, firstWaitMinutes: plan.messages[0]?.waitMinutes ?? 0, startedElsewhere, notEligible };
  }
  /** 0160: the database enrols exactly the confirmed people and refuses if any of them can no longer receive it. No safety net is needed. */
  private async startExplicit(identity: PortalSessionIdentity, requestId: string, input: MhpStartInput, plan: MhpStartPlan): Promise<MhpStartResult> {
    let result: MhpSequenceActionResult | null;
    try {
      result = await this.dependencies.repository.startV2!(identity, { commandId: input.commandId, versionId: input.versionId, campaign: this.dependencies.campaign,
        recipients: plan.recipients.map(person => person.prospectId), requestId });
    } catch (error) {
      if (!(error instanceof MhpCommerceError) || error.status !== 409) throw error;
      const fresh = await this.startPlan(identity, requestId, input.itemId, input.versionId);
      return { kind: 'changed', plan: fresh, previousCount: input.count, added: [], removed: [] };
    }
    if (!result) throw new MhpCommerceError(409, BOOK_READERS_DATABASE_STEP);
    return { kind: 'started', started: result.changed, expected: plan.count, replayed: result.replayed, unexpected: 0, unexpectedPaused: 0, pausedEveryone: false,
      inFlight: 0, firstWaitMinutes: plan.messages[0]?.waitMinutes ?? 0, startedElsewhere: 0, notEligible: result.replayed ? 0 : Math.max(0, plan.count - result.changed) };
  }
  private async knownPeople(identity: PortalSessionIdentity, plan: MhpStartPlan, shortIds: ReadonlySet<string>): Promise<MhpStartRecipient[]> {
    if (!shortIds.size) return [];
    const found = new Map<string, MhpStartRecipient>();
    for (const person of plan.recipients) if (shortIds.has(person.prospectId.slice(-8))) found.set(person.prospectId, person);
    const reader = this.dependencies.repository.audienceCandidates?.bind(this.dependencies.repository);
    if (reader && found.size < shortIds.size) {
      let after: string | null = null;
      for (let page = 0; page < 400; page++) {
        const next: MhpAudienceCandidatePage = await reader(identity, this.dependencies.campaign, after);
        for (const c of next.candidates) if (shortIds.has(c.prospectId.slice(-8))) found.set(c.prospectId, { prospectId: c.prospectId, firstName: c.firstName, email: c.email });
        if (!next.hasMore) break; after = next.nextAfter;
      }
    }
    return [...found.values()];
  }
  /** Pauses every active person in this sequence (every version), in database batches of up to 500 until none is left. */
  async pauseAll(identity: PortalSessionIdentity, requestId: string, input: { commandId: string; itemId: string; versionId: string }): Promise<MhpBulkResult> {
    return this.bulk(identity, requestId, 'pause', input);
  }
  /** Stops every active, paused or held person in this sequence. Final: they are never sent anything more from it. Always allowed. */
  async stopAll(identity: PortalSessionIdentity, requestId: string, input: { commandId: string; itemId: string; versionId: string }): Promise<MhpBulkResult> {
    return this.bulk(identity, requestId, 'stop', input);
  }
  /** Who "Resume everyone" would resume, bound to their exact ids. Reads only. */
  async resumePlan(identity: PortalSessionIdentity, requestId: string, itemId: string, versionId: string): Promise<MhpResumePlan> {
    const detail = await this.review(identity, requestId, itemId, versionId);
    const database = await this.dependencies.repository.snapshot(identity, this.dependencies.campaign);
    const waiting = database.runs.filter(run => run.contentItemId === itemId && (run.state === 'paused' || run.state === 'held'));
    const people = waiting.filter(mhpRunResumable).sort((a, b) => a.id < b.id ? -1 : 1);
    const base = { itemId, versionId, title: detail.definition.title, people, needsCheck: waiting.length - people.length, digest: resumeDigest(itemId, people.map(run => run.id)) };
    if (!followupAudienceCanStart(detail.audience, this.dependencies.campaign)) return { ...base, people: [], ready: false, refusal: FOLLOWUP_NO_AUDIENCE_RESUME };
    if (database.runs.length < database.runCount) return { ...base, ready: false, refusal: 'This webinar has more people in sequences than this page can safely check, so resume people one at a time from their cards.' };
    if (detail.blockers.length) return { ...base, ready: false, refusal: MHP_SEQUENCE_NOT_READY };
    if (!people.length) return { ...base, ready: false, refusal: 'Nobody in this sequence is paused.' };
    return { ...base, ready: true, refusal: null };
  }
  async resumeAll(identity: PortalSessionIdentity, requestId: string, input: { commandId: string; itemId: string; versionId: string; count: number; digest: string }): Promise<MhpBulkResult | { kind: 'changed'; plan: MhpResumePlan; previousCount: number }> {
    if (!Number.isSafeInteger(input.count) || input.count < 1 || !/^[a-f0-9]{64}$/u.test(input.digest)) throw new MhpCommerceError(400, 'Open the sequence and press Resume everyone again.');
    const plan = await this.resumePlan(identity, requestId, input.itemId, input.versionId);
    if (!plan.ready && (plan.people.length || plan.refusal === FOLLOWUP_NO_AUDIENCE_RESUME)) throw new MhpCommerceError(409, plan.refusal!);
    if (plan.people.length !== input.count || plan.digest !== input.digest) return { kind: 'changed', plan, previousCount: input.count };
    // 0160: resume exactly the people shown; the database refuses anyone it would not send to.
    if (this.dependencies.repository.resumeV2) {
      if (!uuid(input.commandId)) throw new MhpCommerceError(400, 'Open the sequence and try again.');
      const result = await this.dependencies.repository.resumeV2(identity, { commandId: input.commandId, versionId: input.versionId, campaign: this.dependencies.campaign,
        runIds: plan.people.map(run => run.id), requestId });
      if (result) return { kind: 'bulk', action: 'resume', changed: result.changed, remaining: 0, blocked: result.blocked, inFlight: result.inFlight, replayed: result.replayed, batches: 1 };
    }
    return this.bulk(identity, requestId, 'resume', input);
  }
  private async bulk(identity: PortalSessionIdentity, requestId: string, action: 'pause' | 'resume' | 'stop', input: { commandId: string; itemId: string; versionId: string }): Promise<MhpBulkResult> {
    if (!uuid(input.commandId) || !uuid(input.itemId) || !uuid(input.versionId)) throw new MhpCommerceError(400, 'Open the sequence and try again.');
    const total = { kind: 'bulk' as const, action, changed: 0, remaining: 0, blocked: 0, inFlight: 0, replayed: false, batches: 0 };
    for (let batch = 0; batch < 20; batch++) {
      const result = await this.command(identity, requestId, { action, commandId: batch === 0 ? input.commandId : flowCommandUuid(input.commandId, `batch-${batch}`),
        itemId: input.itemId, versionId: input.versionId, runId: '', ackProofId: '' });
      total.batches++; total.changed += result.changed; total.blocked += result.blocked; total.inFlight += result.inFlight; total.remaining = result.remaining;
      total.replayed ||= result.replayed;
      // Stop once nothing is left, or when a batch changed nobody (the rest are blocked and need individual attention).
      if (result.remaining === 0 || result.changed === 0 || result.replayed) break;
    }
    return total;
  }
  /** One person's pause, resume, stop or cancel. A person who already changed is not an error: the result says where they are now. */
  async personAction(identity: PortalSessionIdentity, requestId: string, input: MhpSequenceAction): Promise<MhpPersonOutcome> {
    if (input.action === 'enrol' || !uuid(input.runId)) throw new MhpCommerceError(400, 'Open the sequence and use the button on the person\'s card.');
    const before = (await this.dependencies.repository.snapshot(identity, this.dependencies.campaign)).runs.find(run => run.id === input.runId && run.contentItemId === input.itemId);
    if (!before) return { runId: input.runId, action: input.action, code: 'gone', before: null, after: null, inFlight: false };
    // A person on hold because a newer version exists cannot be resumed by the database; say so instead of trying.
    if (input.action === 'resume' && MHP_UNRESUMABLE_REASONS.includes(before.reason ?? '') && !input.ackProofId)
      return { runId: input.runId, action: input.action, code: 'newer_version', before: before.state, after: before.state, inFlight: before.inFlight };
    let result: MhpSequenceActionResult | null = null, code: MhpPersonOutcome['code'] | null = null;
    try { result = await this.command(identity, requestId, input); }
    catch (error) {
      if (!(error instanceof MhpCommerceError) || error.status !== 409) throw error;
      code = error.message === MHP_SEQUENCE_NOT_READY ? 'not_ready' : error.message === FOLLOWUP_NO_AUDIENCE_RESUME ? 'no_audience' : 'unchanged';
    }
    const after = (await this.dependencies.repository.snapshot(identity, this.dependencies.campaign)).runs.find(run => run.id === input.runId) ?? null;
    const target: FollowupRunState = input.action === 'pause' ? 'paused' : input.action === 'resume' ? 'active' : input.action === 'stop' ? 'stopped' : 'cancelled';
    if (!code && result) code = after?.state === target ? (result.replayed ? 'already' : result.changed > 0 ? 'done' : 'already')
      : result.replayed ? 'used' : result.blocked > 0 ? 'blocked' : 'unchanged';
    return { runId: input.runId, action: input.action, code: code ?? 'unchanged', before: before.state, after: after?.state ?? null, inFlight: Boolean(result?.inFlight) || Boolean(after?.inFlight) };
  }
}
export function createMhpSequenceService(input: { web: Pool; identity: Pool; adapter: Pool; approvals: Pool; marketingWorkspace: Pick<PgMhpMarketingWorkspaceService, 'snapshot'> & Partial<Pick<PgMhpMarketingWorkspaceService, 'select'>>; emails: MhpOwnerEmailService; campaign: string }): MhpSequenceService {
  const transactions = mhpOwnerEmailContentRunner(input.adapter), webTransactions = mhpOwnerEmailContentRunner(input.web);
  const repository = new PgMhpSequenceRepository(input.web, input.identity), reader = new CompanyContentService({ transactionRunner: webTransactions });
  const adapter = new CompanyContentService({ transactionRunner: transactions }), approvals = new CompanyContentService({ transactionRunner: mhpOwnerEmailContentRunner(input.approvals) });
  let service!: MhpSequenceService;
  const messages = new LocalFlowMessages({ brand: 'mhp', authorize: (identity, requestId) => service.contentContext(identity, requestId),
    brandSnapshot: async (_context, identity) => parseMhpOwnerEmailBrand((await repository.snapshot(identity, input.campaign)).brand),
    reader, adapter, approvals, transactions, local: new FlowLocalStore(webTransactions), mhpEmail: input.emails });
  service = new MhpSequenceService({ marketingWorkspace: input.marketingWorkspace, repository, reader, adapter, approvals,
    adapterTransactions: transactions, emails: input.emails, campaign: input.campaign, messages });
  return service;
}
export type MhpSequenceSnapshot = Awaited<ReturnType<MhpSequenceService['snapshot']>>;
export type MhpSequenceReview = Awaited<ReturnType<MhpSequenceService['review']>>;
