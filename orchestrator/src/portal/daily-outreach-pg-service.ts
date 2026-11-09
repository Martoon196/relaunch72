import { createHash, randomBytes } from 'node:crypto';
import type { Pool, QueryResultRow } from 'pg';
import { requestDatabaseContext, type DatabaseRequestContext } from '../db/rls.js';
import { InactivePortalSessionError, withTransaction } from '../db/transaction.js';
import type { PortalCrmRequestIdentity } from './crm-service.js';
import {
  createPgPortalCrmPrincipalResolver,
  type PortalCrmPrincipal,
  type PortalCrmPrincipalResolver,
} from './crm-pg-service.js';
import {
  DAILY_OUTREACH_OUTCOME_LIMIT,
  DAILY_OUTREACH_PROGRAMME_KEY,
  DAILY_OUTREACH_QUEUE_LIMIT,
  type DailyOutreachActionState,
  type DailyOutreachAuthoritativeOutcome,
  type DailyOutreachAuthoritativeSnapshot,
  type DailyOutreachCommandOutcome,
  type DailyOutreachControlRef,
  type DailyOutreachFailureKind,
  type DailyOutreachManualAttemptInput,
  type DailyOutreachProjectionRef,
  type DailyOutreachQueueRow,
  type DailyOutreachRecentOutcomeRow,
  type DailyOutreachRecordOutcomeInput,
  type DailyOutreachSnapshotOutcome,
  type DailyOutreachTaskRef,
  type PortalDailyOutreachService,
} from './daily-outreach-service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256 = /^[0-9a-f]{64}$/u;
const DATE = /^\d{4}-\d{2}-\d{2}$/u;
const PROGRAMME_KEY = /^[a-z][a-z0-9_.-]{0,99}$/u;
const COMMAND_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const ALLOWED_OUTCOMES = new Set<DailyOutreachAuthoritativeOutcome>([
  'attempted', 'replied', 'positive', 'referred', 'booked', 'declined',
  'no_response', 'invalid_target', 'suppressed',
]);
const ALLOWED_FOLLOWUP_OUTCOMES = new Set<Exclude<DailyOutreachAuthoritativeOutcome, 'attempted'>>([
  'replied', 'positive', 'referred', 'booked', 'declined',
  'no_response', 'invalid_target', 'suppressed',
]);
const OUTCOMES_WITH_FOLLOWUP_TRANSITIONS = new Set<DailyOutreachAuthoritativeOutcome>([
  'attempted', 'no_response', 'replied', 'positive', 'referred',
]);
const ALLOWED_ACTION_STATES = new Set<DailyOutreachActionState>([
  'completed', 'contact_unavailable', 'source_stale', 'suppressed', 'stopped',
  'cooling', 'eligibility_missing', 'blocked', 'eligibility_stale',
  'content_unassigned', 'content_stale', 'leased_by_me', 'leased',
  'manual_ready', 'review_required',
]);

type JsonRecord = Readonly<Record<string, unknown>>;

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Daily Outreach ${label} is invalid`);
  }
  return value as JsonRecord;
}

function text(value: unknown, label: string, maximum = 512): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum
      || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
    throw new Error(`Daily Outreach ${label} is invalid`);
  }
  return value;
}

function nullableText(value: unknown, label: string, maximum = 512): string | null {
  return value === null ? null : text(value, label, maximum);
}

function uuid(value: unknown, label: string): string {
  const selected = text(value, label, 36).toLowerCase();
  if (!UUID.test(selected)) throw new Error(`Daily Outreach ${label} is invalid`);
  return selected;
}

function hash(value: unknown, label: string): string {
  const selected = text(value, label, 64).toLowerCase();
  if (!SHA256.test(selected)) throw new Error(`Daily Outreach ${label} is invalid`);
  return selected;
}

function integer(value: unknown, label: string, maximum = 2_147_483_647): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new Error(`Daily Outreach ${label} is invalid`);
  }
  return value;
}

function bool(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`Daily Outreach ${label} is invalid`);
  return value;
}

function instant(value: unknown, label: string): string {
  const selected = text(value, label, 64);
  const parsed = new Date(selected);
  if (!Number.isFinite(parsed.getTime())) throw new Error(`Daily Outreach ${label} is invalid`);
  return parsed.toISOString();
}

function nullableInstant(value: unknown, label: string): string | null {
  return value === null ? null : instant(value, label);
}

function date(value: unknown, label: string): string {
  const selected = text(value, label, 10);
  const parsed = Date.parse(`${selected}T00:00:00.000Z`);
  if (!DATE.test(selected) || Number.isNaN(parsed)
      || new Date(parsed).toISOString().slice(0, 10) !== selected) {
    throw new Error(`Daily Outreach ${label} is invalid`);
  }
  return selected;
}

function enumValue<T extends string>(
  value: unknown,
  allowed: ReadonlySet<T>,
  label: string,
): T {
  const selected = text(value, label, 64) as T;
  if (!allowed.has(selected)) throw new Error(`Daily Outreach ${label} is invalid`);
  return selected;
}

function optionalControl(value: unknown): DailyOutreachControlRef | null {
  if (value === null) return null;
  const input = record(value, 'control');
  const kind = enumValue(input.kind, new Set(['cooldown', 'stopped'] as const), 'control kind');
  const output: DailyOutreachControlRef = {
    id: uuid(input.id, 'control id'),
    kind,
    reasonCode: text(input.reasonCode, 'control reason', 100),
    notBefore: nullableInstant(input.notBefore, 'control not-before'),
    ...(input.recordedAt === undefined
      ? {}
      : { recordedAt: instant(input.recordedAt, 'control recorded-at') }),
  };
  return Object.freeze(output);
}

function optionalProjection(value: unknown): DailyOutreachProjectionRef | null {
  if (value === null) return null;
  const input = record(value, 'projection');
  const taskDisposition = enumValue(
    input.taskDisposition,
    new Set(['created', 'not_required'] as const),
    'projection task disposition',
  );
  const taskKind = enumValue(
    input.taskKind,
    new Set(['follow_up', 'reply_review', 'admin_call', 'none'] as const),
    'projection task kind',
  );
  const lapsDisposition = enumValue(
    input.lapsDisposition,
    new Set(['response_evidence_pending', 'cold_attempt_not_eligible'] as const),
    'projection LAPS disposition',
  );
  return Object.freeze({
    id: uuid(input.id, 'projection id'),
    taskDisposition,
    taskKind,
    taskId: input.taskId === null ? null : uuid(input.taskId, 'projection task id'),
    lapsDisposition,
    projectedAt: instant(input.projectedAt, 'projection projected-at'),
  });
}

function optionalTask(value: unknown): DailyOutreachTaskRef | null {
  if (value === null) return null;
  const input = record(value, 'task');
  return Object.freeze({
    id: uuid(input.id, 'task id'),
    assigneeUserId: uuid(input.assigneeUserId, 'task assignee'),
    status: text(input.status, 'task status', 32),
    dueAt: nullableInstant(input.dueAt, 'task due-at'),
    completedAt: nullableInstant(input.completedAt, 'task completed-at'),
  });
}

function contact(value: unknown) {
  const input = record(value, 'contact');
  return Object.freeze({
    id: uuid(input.id, 'contact id'),
    displayName: text(input.displayName, 'contact display name', 300),
    companyName: nullableText(input.companyName, 'contact company name', 300),
  });
}

function queueRow(value: unknown): DailyOutreachQueueRow {
  const input = record(value, 'queue row');
  const channel = enumValue(input.channel, new Set(['linkedin', 'instagram'] as const), 'channel');
  const source = record(input.source, 'source');
  const eligibilityInput = input.eligibility === null ? null : record(input.eligibility, 'eligibility');
  const eligibility = eligibilityInput ? Object.freeze({
    id: uuid(eligibilityInput.id, 'eligibility id'),
    decision: enumValue(
      eligibilityInput.decision,
      new Set(['manual_first_touch', 'zernio_supported', 'blocked'] as const),
      'eligibility decision',
    ),
    reasonCode: text(eligibilityInput.reasonCode, 'eligibility reason', 100),
    evaluatedAt: instant(eligibilityInput.evaluatedAt, 'eligibility evaluated-at'),
    expiresAt: instant(eligibilityInput.expiresAt, 'eligibility expires-at'),
    providerEffectsEnabled: bool(
      eligibilityInput.providerEffectsEnabled,
      'eligibility provider-effects flag',
    ) as false,
  }) : null;
  if (eligibility?.providerEffectsEnabled !== false) {
    throw new Error('Daily Outreach eligibility unexpectedly enables provider effects');
  }
  const leaseInput = input.lease === null ? null : record(input.lease, 'lease');
  const lease = leaseInput ? Object.freeze({
    id: uuid(leaseInput.id, 'lease id'),
    version: integer(leaseInput.version, 'lease version'),
    leasedByUserId: uuid(leaseInput.leasedByUserId, 'lease user'),
    ownedByViewer: bool(leaseInput.ownedByViewer, 'lease ownership'),
    leasedAt: instant(leaseInput.leasedAt, 'lease leased-at'),
    expiresAt: instant(leaseInput.expiresAt, 'lease expires-at'),
    active: bool(leaseInput.active, 'lease active flag'),
  }) : null;
  const assignmentInput = input.contentAssignment === null
    ? null : record(input.contentAssignment, 'content assignment');
  const contentAssignment = assignmentInput ? Object.freeze({
    id: uuid(assignmentInput.id, 'content assignment id'),
    assignedAt: instant(assignmentInput.assignedAt, 'content assigned-at'),
    contentItemId: uuid(assignmentInput.contentItemId, 'content item id'),
    contentVersionId: uuid(assignmentInput.contentVersionId, 'content version id'),
    contentSha256: hash(assignmentInput.contentSha256, 'content hash'),
    approvalRequestId: uuid(assignmentInput.approvalRequestId, 'approval request id'),
    approvalDecisionId: uuid(assignmentInput.approvalDecisionId, 'approval decision id'),
    current: bool(assignmentInput.current, 'content current flag'),
  }) : null;
  const outcomeInput = input.latestOutcome === null ? null : record(input.latestOutcome, 'latest outcome');
  const latestOutcome = outcomeInput ? Object.freeze({
    id: uuid(outcomeInput.id, 'outcome id'),
    attemptReceiptId: uuid(outcomeInput.attemptReceiptId, 'attempt receipt id'),
    outcome: enumValue(outcomeInput.outcome, ALLOWED_OUTCOMES, 'outcome'),
    occurredAt: instant(outcomeInput.occurredAt, 'outcome occurred-at'),
    recordedAt: instant(outcomeInput.recordedAt, 'outcome recorded-at'),
  }) : null;
  const commandRechecksRequired = bool(
    input.commandRechecksRequired,
    'command recheck flag',
  );
  if (commandRechecksRequired !== true) {
    throw new Error('Daily Outreach command rechecks are not enabled');
  }
  return Object.freeze({
    allocationId: uuid(input.allocationId, 'allocation id'),
    programmeVersionId: uuid(input.programmeVersionId, 'programme version id'),
    prospectMembershipId: uuid(input.prospectMembershipId, 'prospect membership id'),
    contact: contact(input.contact),
    operatorUserId: uuid(input.operatorUserId, 'operator id'),
    channel,
    segmentKey: text(input.segmentKey, 'segment key', 100),
    quotaDayUtc: date(input.quotaDayUtc, 'quota day'),
    priorityRank: integer(input.priorityRank, 'priority rank', 32_767),
    source: Object.freeze({
      adapter: text(source.adapter, 'source adapter', 100),
      observedAt: instant(source.observedAt, 'source observed-at'),
      expiresAt: instant(source.expiresAt, 'source expires-at'),
    }),
    eligibility,
    lease,
    contentAssignment,
    latestOutcome,
    control: optionalControl(input.control),
    projection: optionalProjection(input.projection),
    task: optionalTask(input.task),
    actionState: enumValue(input.actionState, ALLOWED_ACTION_STATES, 'action state'),
    commandRechecksRequired: true,
  });
}

function recentOutcome(
  value: unknown,
  expectedQuotaDayUtc: string,
): DailyOutreachRecentOutcomeRow {
  const input = record(value, 'recent outcome');
  const control = optionalControl(input.control);
  const outcome = enumValue(input.outcome, ALLOWED_OUTCOMES, 'recent outcome');
  const isLatest = bool(input.isLatest, 'recent latest flag');
  const canRecordOutcome = bool(input.canRecordOutcome, 'recent recordable flag');
  const quotaDayUtc = date(input.quotaDayUtc, 'recent quota day');
  const attemptedAt = instant(input.attemptedAt, 'recent attempted-at');
  const occurredAt = instant(input.occurredAt, 'recent occurred-at');
  const expectedDayMs = Date.parse(`${expectedQuotaDayUtc}T00:00:00.000Z`);
  const selectedDayMs = Date.parse(`${quotaDayUtc}T00:00:00.000Z`);
  if (isLatest !== true
      || canRecordOutcome !== OUTCOMES_WITH_FOLLOWUP_TRANSITIONS.has(outcome)
      || attemptedAt.slice(0, 10) !== quotaDayUtc
      || Date.parse(attemptedAt) > Date.parse(occurredAt)
      || selectedDayMs > expectedDayMs
      || selectedDayMs < expectedDayMs - 29 * 86_400_000) {
    throw new Error('Daily Outreach recent outcome authority is inconsistent');
  }
  return Object.freeze({
    id: uuid(input.id, 'recent outcome id'),
    attemptReceiptId: uuid(input.attemptReceiptId, 'recent attempt id'),
    allocationId: uuid(input.allocationId, 'recent allocation id'),
    programmeVersionId: uuid(input.programmeVersionId, 'recent programme version id'),
    quotaDayUtc,
    attemptedAt,
    cooldownSeconds: integer(input.cooldownSeconds, 'recent cooldown seconds'),
    contact: contact(input.contact),
    channel: enumValue(input.channel, new Set(['linkedin', 'instagram'] as const), 'recent channel'),
    outcome,
    occurredAt,
    recordedAt: instant(input.recordedAt, 'recent recorded-at'),
    isLatest: true,
    canRecordOutcome,
    contentAssignmentId: uuid(input.contentAssignmentId, 'recent assignment id'),
    contentItemId: uuid(input.contentItemId, 'recent content item id'),
    contentVersionId: uuid(input.contentVersionId, 'recent content version id'),
    contentSha256: hash(input.contentSha256, 'recent content hash'),
    approvalRequestId: uuid(input.approvalRequestId, 'recent approval request id'),
    approvalDecisionId: uuid(input.approvalDecisionId, 'recent approval decision id'),
    control: control ? Object.freeze({
      id: control.id, kind: control.kind, reasonCode: control.reasonCode,
      notBefore: control.notBefore,
    }) : null,
    projection: optionalProjection(input.projection),
    task: optionalTask(input.task),
  });
}

function parseSnapshot(
  value: unknown,
  principal: PortalCrmPrincipal,
  commandBoundaryAvailable: boolean,
  expectedProgrammeKey: string,
  expectedQuotaDayUtc: string,
): DailyOutreachAuthoritativeSnapshot {
  const input = record(value, 'snapshot');
  if (input.schemaVersion !== 1 || input.quotaTimezone !== 'UTC') {
    throw new Error('Daily Outreach snapshot schema is unsupported');
  }
  const workspace = record(input.workspace, 'workspace');
  const operator = record(input.operator, 'operator');
  const programme = record(input.programme, 'programme');
  const manager = record(input.manager, 'manager');
  const metricAvailabilityInput = record(manager.metricAvailability, 'metric availability');
  const metricAvailability: Record<string, string> = {};
  for (const [key, item] of Object.entries(metricAvailabilityInput)) {
    if (!/^[a-z][A-Za-z0-9]{0,63}$/u.test(key)) {
      throw new Error('Daily Outreach metric availability key is invalid');
    }
    metricAvailability[key] = text(item, `metric ${key}`, 100);
  }
  const workspaceId = uuid(workspace.id, 'workspace id');
  const operatorId = uuid(operator.id, 'operator id');
  const viewerUserId = uuid(operator.viewerUserId, 'viewer user id');
  const queueInput = Array.isArray(input.queue) ? input.queue : null;
  const outcomeInput = Array.isArray(input.recentOutcomes) ? input.recentOutcomes : null;
  if (!queueInput || queueInput.length > DAILY_OUTREACH_QUEUE_LIMIT
      || !outcomeInput || outcomeInput.length > DAILY_OUTREACH_OUTCOME_LIMIT) {
    throw new Error('Daily Outreach bounded collections are invalid');
  }
  const quotaDayUtc = date(input.quotaDayUtc, 'quota day');
  const programmeId = uuid(programme.id, 'programme id');
  const programmeKey = text(programme.key, 'programme key', 100);
  const channel = enumValue(programme.channel, new Set(['linkedin', 'instagram'] as const), 'programme channel');
  const segmentKey = text(programme.segmentKey, 'programme segment', 100);
  const dailyTarget = integer(programme.dailyTarget, 'daily target', 32_767);
  const operatingDailyCap = integer(programme.operatingDailyCap, 'operating cap', 32_767);
  const providerDailyCap = integer(programme.providerDailyCap, 'provider cap', 32_767);
  const providerEffectsEnabled = bool(
    programme.providerEffectsEnabled,
    'programme provider-effects flag',
  );
  if (workspaceId !== principal.workspaceId.toLowerCase()
      || operatorId !== principal.userId.toLowerCase()
      || viewerUserId !== principal.userId.toLowerCase()
      || operator.viewerIsOperator !== true
      || programmeKey !== expectedProgrammeKey
      || quotaDayUtc !== expectedQuotaDayUtc
      || providerEffectsEnabled !== false) {
    throw new Error('Daily Outreach snapshot authority is inconsistent');
  }
  const queue = queueInput.map(queueRow);
  for (const [index, row] of queue.entries()) {
    if (row.operatorUserId !== operatorId
        || row.programmeVersionId !== programmeId
        || row.quotaDayUtc !== quotaDayUtc
        || row.channel !== channel
        || row.segmentKey !== segmentKey) {
      throw new Error('Daily Outreach queue authority is inconsistent');
    }
    const previous = index > 0 ? queue[index - 1] : undefined;
    if (previous && (row.priorityRank < previous.priorityRank
        || (row.priorityRank === previous.priorityRank
          && row.allocationId.localeCompare(previous.allocationId) < 0))) {
      throw new Error('Daily Outreach queue ordering is inconsistent');
    }
  }
  const managerTarget = integer(manager.target, 'manager target', 32_767);
  const managerOperatingCap = integer(manager.operatingDailyCap, 'manager operating cap', 32_767);
  const managerProviderCap = integer(manager.providerDailyCap, 'manager provider cap', 32_767);
  if (managerTarget !== dailyTarget
      || managerOperatingCap !== operatingDailyCap
      || managerProviderCap !== providerDailyCap) {
    throw new Error('Daily Outreach manager caps are inconsistent');
  }
  return Object.freeze({
    schemaVersion: 1,
    dataset: 'postgres_authoritative',
    quotaTimezone: 'UTC',
    quotaDayUtc,
    snapshotAt: instant(input.snapshotAt, 'snapshot timestamp'),
    workspace: Object.freeze({ id: workspaceId }),
    operator: Object.freeze({
      id: operatorId,
      viewerUserId,
      viewerIsOperator: true,
    }),
    programme: Object.freeze({
      id: programmeId,
      key: programmeKey,
      versionNumber: integer(programme.versionNumber, 'programme version'),
      channel,
      segmentKey,
      dailyTarget,
      operatingDailyCap,
      providerDailyCap,
      cooldownSeconds: integer(programme.cooldownSeconds, 'cooldown seconds'),
      effectiveFrom: date(programme.effectiveFrom, 'programme effective-from'),
      effectiveUntil: programme.effectiveUntil === null
        ? null : date(programme.effectiveUntil, 'programme effective-until'),
      providerEffectsEnabled: false,
    }),
    manager: Object.freeze({
      prospectsReviewed: integer(manager.prospectsReviewed, 'prospects reviewed'),
      validAttempts: integer(manager.validAttempts, 'valid attempts'),
      responses: integer(manager.responses, 'responses'),
      positiveResponses: integer(manager.positiveResponses, 'positive responses'),
      booked: integer(manager.booked, 'booked'),
      noResponse: integer(manager.noResponse, 'no response'),
      invalidTargets: integer(manager.invalidTargets, 'invalid targets'),
      suppressed: integer(manager.suppressed, 'suppressions'),
      blocked: integer(manager.blocked, 'blocked'),
      activeLeases: integer(manager.activeLeases, 'active leases'),
      cooling: integer(manager.cooling, 'cooling'),
      stopped: integer(manager.stopped, 'stopped'),
      tasksCreated: integer(manager.tasksCreated, 'tasks created'),
      responseEvidencePending: integer(manager.responseEvidencePending, 'response evidence pending'),
      target: managerTarget,
      operatingDailyCap: managerOperatingCap,
      providerDailyCap: managerProviderCap,
      remainingToTarget: integer(manager.remainingToTarget, 'remaining to target', 32_767),
      metricAvailability: Object.freeze(metricAvailability),
    }),
    queue: Object.freeze(queue),
    recentOutcomes: Object.freeze(outcomeInput.map((row) => recentOutcome(row, quotaDayUtc))),
    commandBoundaryAvailable,
    externalEffects: false,
  });
}

interface SnapshotRow extends QueryResultRow { readonly snapshot: unknown }
interface ClaimRow extends QueryResultRow {
  allocationId: string;
  queueLeaseId: string;
  leaseVersion: number | string;
  prospectMembershipId: string;
  contactId: string;
  eligibilityDecisionId: string;
  eligibilityExpiresAt: string | Date;
  contentAssignmentId: string;
  contentItemId: string;
  contentVersionId: string;
  contentSha256: Buffer;
  approvalRequestId: string;
  approvalDecisionId: string;
}
interface AttemptRow extends QueryResultRow {
  disposition: 'recorded' | 'replayed';
  attemptReceiptId: string;
  outcomeEventId: string;
  controlEventId: string;
}
interface OutcomeRow extends QueryResultRow {
  disposition: 'recorded' | 'replayed';
  outcomeEventId: string;
  controlEventId: string;
}
interface ProjectionRow extends QueryResultRow {
  disposition: 'recorded' | 'replayed';
  projectionReceiptId: string;
  taskId: string | null;
  lapsDisposition: 'response_evidence_pending' | 'cold_attempt_not_eligible';
}
interface ReplayRow extends QueryResultRow {
  commandKind: 'manual_attempt' | 'outcome';
  allocationId: string;
  previousOutcomeEventId: string | null;
  outcome: DailyOutreachAuthoritativeOutcome;
  disposition: 'replayed';
  attemptReceiptId: string;
  outcomeEventId: string;
  controlEventId: string;
  projectionReceiptId: string;
  taskId: string | null;
  lapsDisposition: 'response_evidence_pending' | 'cold_attempt_not_eligible';
}
interface DatabaseClockRow extends QueryResultRow { attemptedAt: string | Date }
interface DatabaseNowRow extends QueryResultRow { now: string | Date }

type ReplayExpectation = Readonly<
  | { kind: 'manual_attempt'; allocationId: string }
  | {
    kind: 'outcome';
    attemptReceiptId: string;
    previousOutcomeEventId: string;
    outcome: Exclude<DailyOutreachAuthoritativeOutcome, 'attempted'>;
  }
>;

const READ_SQL = `/* portal.daily-outreach.snapshot */
  SELECT app_private.read_daily_outreach_cockpit_snapshot(
    $1, $2, $3, $4, $5::smallint, $6::smallint
  ) AS snapshot`;

function context(
  identity: PortalCrmRequestIdentity,
  principal: PortalCrmPrincipal,
): DatabaseRequestContext {
  return requestDatabaseContext({
    ...principal,
    requestId: identity.requestId,
    portalSessionTokenHash: createHash('sha256').update(identity.sessionToken).digest(),
  });
}

function utcDay(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}

function digest(...parts: readonly string[]): Buffer {
  const hashValue = createHash('sha256');
  for (const part of parts) hashValue.update(part).update('\0');
  return hashValue.digest();
}

function postgresCode(error: unknown): string | null {
  return typeof error === 'object' && error !== null && 'code' in error
    && typeof (error as { readonly code?: unknown }).code === 'string'
    ? (error as { readonly code: string }).code : null;
}

function failure(kind: DailyOutreachFailureKind, message: string) {
  return Object.freeze({ ok: false as const, kind, message });
}

function commandFailure(error: unknown): DailyOutreachCommandOutcome {
  if (error instanceof InactivePortalSessionError) {
    return failure('unauthenticated', 'This portal session is no longer active.');
  }
  const code = postgresCode(error);
  if (code === '42501') return failure('forbidden', 'Your workspace role cannot record that Daily Outreach action.');
  if (code === '23503') return failure('not_found', 'The selected outreach evidence is no longer available. Refresh the cockpit.');
  if (code === '23505' || code === '40001' || code === '55000' || code === '55P03') {
    return failure('conflict', 'The outreach state changed or is cooling down. Refresh before trying again.');
  }
  if (code?.startsWith('22') || code === '54000') {
    return failure('validation', 'That action is no longer eligible or today’s bounded quota has been reached.');
  }
  return failure('unavailable', 'The Daily Outreach change could not be saved safely. No message or provider action was triggered.');
}

function recentOperatorInstant(value: string, nowMs: number): string | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed >= nowMs - 5 * 60_000 && parsed <= nowMs + 30_000
    ? new Date(parsed).toISOString() : null;
}

export interface PgPortalDailyOutreachDependencies {
  readonly principalResolver: Pick<PortalCrmPrincipalResolver, 'resolve'>;
  readonly readPool: Pick<Pool, 'connect'>;
  readonly commandPool?: Pick<Pool, 'connect'>;
  readonly programmeKey?: string;
  readonly now?: () => number;
}

export class PgPortalDailyOutreachService implements PortalDailyOutreachService {
  private readonly programmeKey: string;
  private readonly now: () => number;

  constructor(private readonly dependencies: PgPortalDailyOutreachDependencies) {
    this.programmeKey = dependencies.programmeKey ?? DAILY_OUTREACH_PROGRAMME_KEY;
    if (!PROGRAMME_KEY.test(this.programmeKey)) throw new Error('Daily Outreach programme key is invalid');
    this.now = dependencies.now ?? Date.now;
  }

  private async principal(identity: PortalCrmRequestIdentity): Promise<PortalCrmPrincipal | null> {
    return this.dependencies.principalResolver.resolve(identity.sessionToken);
  }

  private async load(
    databaseContext: DatabaseRequestContext,
    principal: PortalCrmPrincipal,
  ): Promise<DailyOutreachAuthoritativeSnapshot> {
    const quotaDay = utcDay(this.now());
    return withTransaction(this.dependencies.readPool, databaseContext, async (transaction) => {
      const result = await transaction.query<SnapshotRow>(READ_SQL, [
        principal.workspaceId, this.programmeKey, principal.userId, quotaDay,
        DAILY_OUTREACH_QUEUE_LIMIT, DAILY_OUTREACH_OUTCOME_LIMIT,
      ]);
      if (result.rows.length !== 1) throw new Error('Daily Outreach snapshot was returned incorrectly');
      return parseSnapshot(
        result.rows[0]?.snapshot,
        principal,
        Boolean(this.dependencies.commandPool),
        this.programmeKey,
        quotaDay,
      );
    }, { readOnly: true, isolation: 'repeatable read' });
  }

  private async replay(
    databaseContext: DatabaseRequestContext,
    principal: PortalCrmPrincipal,
    expected: ReplayExpectation,
    commandKeySha: Buffer,
  ): Promise<DailyOutreachCommandOutcome | null> {
    if (!this.dependencies.commandPool) return null;
    return withTransaction(this.dependencies.commandPool, databaseContext, async (transaction) => {
      const result = await transaction.query<ReplayRow>(
        `/* portal.daily-outreach.resolve-command-replay */
         SELECT command_kind AS "commandKind",
                allocation_id AS "allocationId",
                previous_outcome_event_id AS "previousOutcomeEventId",
                outcome,
                disposition,
                attempt_receipt_id AS "attemptReceiptId",
                outcome_event_id AS "outcomeEventId",
                control_event_id AS "controlEventId",
                projection_receipt_id AS "projectionReceiptId",
                task_id AS "taskId",
                laps_disposition AS "lapsDisposition"
         FROM app_private.resolve_daily_outreach_command_replay($1,$2,$3)`,
        [principal.workspaceId, expected.kind, commandKeySha],
      );
      if (result.rows.length === 0) return null;
      if (result.rows.length !== 1) throw new Error('Daily Outreach replay resolved incorrectly');
      const row = result.rows[0]!;
      const commandKind = enumValue(
        row.commandKind,
        new Set(['manual_attempt', 'outcome'] as const),
        'replay command kind',
      );
      const allocationId = uuid(row.allocationId, 'replay allocation id');
      const attemptReceiptId = uuid(row.attemptReceiptId, 'replay attempt receipt id');
      const previousOutcomeEventId = row.previousOutcomeEventId === null
        ? null : uuid(row.previousOutcomeEventId, 'replay previous outcome id');
      const replayOutcome = enumValue(row.outcome, ALLOWED_OUTCOMES, 'replay outcome');
      const stableIdentityMatches = commandKind === expected.kind
        && (expected.kind === 'manual_attempt'
          ? allocationId === expected.allocationId
          : attemptReceiptId === expected.attemptReceiptId
            && previousOutcomeEventId === expected.previousOutcomeEventId
            && replayOutcome === expected.outcome);
      if (!stableIdentityMatches) {
        return failure(
          'conflict',
          'That command key has already been used for another outreach action.',
        );
      }
      const disposition = enumValue(
        row.disposition,
        new Set(['replayed'] as const),
        'replay disposition',
      );
      const outcomeEventId = uuid(row.outcomeEventId, 'replay outcome id');
      uuid(row.controlEventId, 'replay control id');
      uuid(row.projectionReceiptId, 'replay projection receipt id');
      const lapsDisposition = enumValue(
        row.lapsDisposition,
        new Set(['response_evidence_pending', 'cold_attempt_not_eligible'] as const),
        'replay LAPS disposition',
      );
      return Object.freeze({
        ok: true as const,
        disposition,
        outcomeEventId,
        taskId: row.taskId ? uuid(row.taskId, 'replay task id') : null,
        lapsDisposition,
      });
    // The command identity deliberately requires READ COMMITTED even for this
    // table-blind lookup. Keeping the resolver in that same isolation class
    // makes an exact HTTP retry usable against the real least-privilege role.
    }, { readOnly: true, isolation: 'read committed' });
  }

  async snapshot(identity: PortalCrmRequestIdentity): Promise<DailyOutreachSnapshotOutcome> {
    try {
      const principal = await this.principal(identity);
      if (!principal) return failure('unauthenticated', 'This portal session is no longer active.');
      return Object.freeze({
        ok: true as const,
        snapshot: await this.load(context(identity, principal), principal),
      });
    } catch (error) {
      if (error instanceof InactivePortalSessionError) {
        return failure('unauthenticated', 'This portal session is no longer active.');
      }
      const code = postgresCode(error);
      if (code === '42501') return failure('forbidden', 'Daily Outreach is not available to this workspace role.');
      if (code === '23503') return failure('not_found', 'No active Daily Outreach programme exists for today.');
      return failure('unavailable', 'The authoritative Daily Outreach cockpit is temporarily unavailable.');
    }
  }

  async recordManualAttempt(
    identity: PortalCrmRequestIdentity,
    input: DailyOutreachManualAttemptInput,
  ): Promise<DailyOutreachCommandOutcome> {
    try {
      if (!this.dependencies.commandPool) return failure('unavailable', 'The Daily Outreach command boundary is not installed.');
      if (!UUID.test(input.allocationId) || !COMMAND_KEY.test(input.commandKey)) {
        return failure('validation', 'The selected outreach action is invalid.');
      }
      const principal = await this.principal(identity);
      if (!principal) return failure('unauthenticated', 'This portal session is no longer active.');
      const databaseContext = context(identity, principal);
      const commandKeySha = digest('propertypredator.daily-outreach.command/v1', input.commandKey);
      const replay = await this.replay(
        databaseContext,
        principal,
        { kind: 'manual_attempt', allocationId: input.allocationId.toLowerCase() },
        commandKeySha,
      );
      if (replay) return replay;
      const nowMs = this.now();
      if (!recentOperatorInstant(input.attemptedAt, nowMs)) {
        return failure('validation', 'This action page is stale. Refresh before recording the attempt.');
      }
      const snapshot = await this.load(databaseContext, principal);
      const selected = snapshot.queue.find((row) => row.allocationId === input.allocationId.toLowerCase());
      if (!selected || selected.channel !== 'linkedin' || selected.actionState !== 'manual_ready'
          || selected.eligibility?.decision !== 'manual_first_touch'
          || selected.contentAssignment?.current !== true) {
        return failure('conflict', 'That LinkedIn first touch is no longer ready. Refresh the cockpit.');
      }
      const assignment = selected.contentAssignment;
      const eligibility = selected.eligibility;
      const leaseToken = randomBytes(32);
      const projectionKey = digest('propertypredator.daily-outreach.projection/v1', input.commandKey);
      return await withTransaction(this.dependencies.commandPool, databaseContext, async (transaction) => {
        const claimed = await transaction.query<ClaimRow>(
          `/* portal.daily-outreach.claim-manual */
           SELECT allocation_id AS "allocationId", queue_lease_id AS "queueLeaseId",
                  lease_version AS "leaseVersion",
                  prospect_membership_id AS "prospectMembershipId",
                  contact_id AS "contactId",
                  eligibility_decision_id AS "eligibilityDecisionId",
                  eligibility_expires_at AS "eligibilityExpiresAt",
                  content_assignment_id AS "contentAssignmentId",
                  content_item_id AS "contentItemId",
                  content_version_id AS "contentVersionId",
                  content_sha256 AS "contentSha256",
                  approval_request_id AS "approvalRequestId",
                  approval_decision_id AS "approvalDecisionId"
           FROM app_private.claim_next_manual_daily_outreach(
             $1, $2, $3, $4, $5, $6, $7
           )`,
          [principal.workspaceId, principal.userId, snapshot.programme.key,
            snapshot.quotaDayUtc, 'linkedin', leaseToken, 120],
        );
        if (claimed.rows.length !== 1) {
          throw Object.assign(new Error('Daily Outreach claim changed'), { code: '40001' });
        }
        const claim = claimed.rows[0]!;
        const queueLeaseId = uuid(claim.queueLeaseId, 'claimed queue lease id');
        if (uuid(claim.allocationId, 'claimed allocation id') !== selected.allocationId
            || uuid(claim.prospectMembershipId, 'claimed prospect membership id') !== selected.prospectMembershipId
            || uuid(claim.contactId, 'claimed contact id') !== selected.contact.id
            || uuid(claim.eligibilityDecisionId, 'claimed eligibility id') !== eligibility.id
            || uuid(claim.contentAssignmentId, 'claimed content assignment id') !== assignment.id
            || uuid(claim.contentItemId, 'claimed content item id') !== assignment.contentItemId
            || uuid(claim.contentVersionId, 'claimed content version id') !== assignment.contentVersionId
            || uuid(claim.approvalRequestId, 'claimed approval request id') !== assignment.approvalRequestId
            || uuid(claim.approvalDecisionId, 'claimed approval decision id') !== assignment.approvalDecisionId
            || !Buffer.isBuffer(claim.contentSha256)
            || claim.contentSha256.toString('hex') !== assignment.contentSha256) {
          throw Object.assign(new Error('Daily Outreach claim changed'), { code: '40001' });
        }
        const clock = await transaction.query<DatabaseClockRow>(
          `/* portal.daily-outreach.authoritative-attempt-clock */
           SELECT statement_timestamp() AS "attemptedAt"`,
        );
        if (clock.rows.length !== 1) {
          throw new Error('Daily Outreach authoritative attempt clock was returned incorrectly');
        }
        const attemptedAtValue = clock.rows[0]?.attemptedAt;
        const attemptedAt = instant(
          attemptedAtValue instanceof Date ? attemptedAtValue.toISOString() : attemptedAtValue,
          'authoritative attempted-at',
        );
        const manualEvidenceSha = digest(
          'propertypredator.daily-outreach.manual-evidence/v1',
          principal.workspaceId, selected.allocationId, assignment.id,
          assignment.contentSha256, attemptedAt, input.commandKey,
        );
        const dueAt = new Date(
          Date.parse(attemptedAt)
            + snapshot.programme.cooldownSeconds * 1_000
            + 10 * 60_000,
        ).toISOString();
        const attempt = await transaction.query<AttemptRow>(
          `/* portal.daily-outreach.record-manual */
           SELECT disposition, attempt_receipt_id AS "attemptReceiptId",
                  outcome_event_id AS "outcomeEventId",
                  control_event_id AS "controlEventId"
           FROM app_private.record_daily_outreach_manual_attempt(
             $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14
           )`,
          [principal.workspaceId, selected.allocationId, eligibility.id,
            queueLeaseId, leaseToken, assignment.contentItemId,
            assignment.contentVersionId, Buffer.from(assignment.contentSha256, 'hex'),
            assignment.approvalRequestId, assignment.approvalDecisionId,
            manualEvidenceSha, 'attempted', attemptedAt, commandKeySha],
        );
        if (attempt.rows.length !== 1) throw new Error('Daily Outreach attempt returned incorrectly');
        const attemptRow = attempt.rows[0]!;
        const attemptDisposition = enumValue(
          attemptRow.disposition,
          new Set(['recorded', 'replayed'] as const),
          'attempt disposition',
        );
        uuid(attemptRow.attemptReceiptId, 'attempt receipt id');
        const attemptOutcomeEventId = uuid(attemptRow.outcomeEventId, 'attempt outcome id');
        uuid(attemptRow.controlEventId, 'attempt control id');
        const projection = await transaction.query<ProjectionRow>(
          `/* portal.daily-outreach.project-attempt */
           SELECT disposition, projection_receipt_id AS "projectionReceiptId",
                  task_id AS "taskId", laps_disposition AS "lapsDisposition"
           FROM app_private.project_daily_outreach_outcome($1,$2,$3,$4,$5,$6)`,
          [principal.workspaceId, attemptOutcomeEventId, projectionKey,
            dueAt, null, manualEvidenceSha],
        );
        if (projection.rows.length !== 1) throw new Error('Daily Outreach projection returned incorrectly');
        const projected = projection.rows[0]!;
        enumValue(
          projected.disposition,
          new Set(['recorded', 'replayed'] as const),
          'attempt projection disposition',
        );
        uuid(projected.projectionReceiptId, 'attempt projection receipt id');
        return Object.freeze({
          ok: true as const,
          disposition: attemptDisposition,
          outcomeEventId: attemptOutcomeEventId,
          taskId: projected.taskId ? uuid(projected.taskId, 'projected task id') : null,
          lapsDisposition: enumValue(
            projected.lapsDisposition,
            new Set(['response_evidence_pending', 'cold_attempt_not_eligible'] as const),
            'attempt projection LAPS disposition',
          ),
        });
      });
    } catch (error) {
      return commandFailure(error);
    }
  }

  async recordOutcome(
    identity: PortalCrmRequestIdentity,
    input: DailyOutreachRecordOutcomeInput,
  ): Promise<DailyOutreachCommandOutcome> {
    try {
      if (!this.dependencies.commandPool) return failure('unavailable', 'The Daily Outreach command boundary is not installed.');
      if (!UUID.test(input.attemptReceiptId) || !UUID.test(input.previousOutcomeEventId)
          || !ALLOWED_FOLLOWUP_OUTCOMES.has(input.outcome)
          || !COMMAND_KEY.test(input.commandKey)) {
        return failure('validation', 'The selected outcome action is invalid.');
      }
      const principal = await this.principal(identity);
      if (!principal) return failure('unauthenticated', 'This portal session is no longer active.');
      const databaseContext = context(identity, principal);
      const commandKeySha = digest('propertypredator.daily-outreach.outcome-command/v1', input.commandKey);
      const replay = await this.replay(
        databaseContext,
        principal,
        {
          kind: 'outcome',
          attemptReceiptId: input.attemptReceiptId.toLowerCase(),
          previousOutcomeEventId: input.previousOutcomeEventId.toLowerCase(),
          outcome: input.outcome,
        },
        commandKeySha,
      );
      if (replay) return replay;
      const nowMs = this.now();
      const occurredAt = recentOperatorInstant(input.occurredAt, nowMs);
      if (!occurredAt) return failure('validation', 'This outcome form is stale. Refresh before recording it.');
      const snapshot = await this.load(databaseContext, principal);
      const selected = snapshot.queue.find((row) => (
        row.latestOutcome?.attemptReceiptId === input.attemptReceiptId.toLowerCase()
        && row.latestOutcome.id === input.previousOutcomeEventId.toLowerCase()
      ));
      const delayed = snapshot.recentOutcomes.find((row) => (
        row.attemptReceiptId === input.attemptReceiptId.toLowerCase()
        && row.id === input.previousOutcomeEventId.toLowerCase()
        && row.canRecordOutcome
      ));
      if (!selected?.latestOutcome && !delayed) {
        return failure('conflict', 'That outcome chain has changed. Refresh the cockpit.');
      }
      const evidence = digest(
        'propertypredator.daily-outreach.outcome-evidence/v1',
        principal.workspaceId, input.attemptReceiptId, input.previousOutcomeEventId,
        input.outcome, occurredAt, input.commandKey,
      );
      const projectionKey = digest('propertypredator.daily-outreach.outcome-projection/v1', input.commandKey);
      return await withTransaction(this.dependencies.commandPool, databaseContext, async (transaction) => {
        const saved = await transaction.query<OutcomeRow>(
          `/* portal.daily-outreach.record-outcome */
           SELECT disposition, outcome_event_id AS "outcomeEventId",
                  control_event_id AS "controlEventId"
           FROM app_private.record_daily_outreach_outcome_event($1,$2,$3,$4,$5,$6,$7)`,
          [principal.workspaceId, input.attemptReceiptId, input.previousOutcomeEventId,
            input.outcome, occurredAt, evidence, commandKeySha],
        );
        if (saved.rows.length !== 1) throw new Error('Daily Outreach outcome returned incorrectly');
        const savedRow = saved.rows[0]!;
        const savedDisposition = enumValue(
          savedRow.disposition,
          new Set(['recorded', 'replayed'] as const),
          'outcome disposition',
        );
        const savedOutcomeEventId = uuid(savedRow.outcomeEventId, 'recorded outcome id');
        uuid(savedRow.controlEventId, 'outcome control id');
        const clock = await transaction.query<DatabaseNowRow>(
          `/* portal.daily-outreach.authoritative-projection-clock */
           SELECT statement_timestamp() AS now`,
        );
        if (clock.rows.length !== 1) {
          throw new Error('Daily Outreach authoritative projection clock was returned incorrectly');
        }
        const nowValue = clock.rows[0]?.now;
        const projectedFrom = instant(
          nowValue instanceof Date ? nowValue.toISOString() : nowValue,
          'authoritative projection timestamp',
        );
        const dueAt = input.outcome === 'no_response'
          ? new Date(Date.parse(projectedFrom)
            + (delayed?.cooldownSeconds ?? snapshot.programme.cooldownSeconds) * 1_000
            + 10 * 60_000).toISOString()
          : ['replied', 'positive', 'referred', 'booked'].includes(input.outcome)
            ? new Date(Date.parse(projectedFrom) + 60 * 60_000).toISOString()
            : null;
        const projected = await transaction.query<ProjectionRow>(
          `/* portal.daily-outreach.project-outcome */
           SELECT disposition, projection_receipt_id AS "projectionReceiptId",
                  task_id AS "taskId", laps_disposition AS "lapsDisposition"
           FROM app_private.project_daily_outreach_outcome($1,$2,$3,$4,$5,$6)`,
          [principal.workspaceId, savedOutcomeEventId, projectionKey, dueAt, null, evidence],
        );
        if (projected.rows.length !== 1) throw new Error('Daily Outreach outcome projection returned incorrectly');
        const projection = projected.rows[0]!;
        enumValue(
          projection.disposition,
          new Set(['recorded', 'replayed'] as const),
          'outcome projection disposition',
        );
        uuid(projection.projectionReceiptId, 'outcome projection receipt id');
        return Object.freeze({
          ok: true as const,
          disposition: savedDisposition,
          outcomeEventId: savedOutcomeEventId,
          taskId: projection.taskId ? uuid(projection.taskId, 'projected task id') : null,
          lapsDisposition: enumValue(
            projection.lapsDisposition,
            new Set(['response_evidence_pending', 'cold_attempt_not_eligible'] as const),
            'outcome projection LAPS disposition',
          ),
        });
      });
    } catch (error) {
      return commandFailure(error);
    }
  }
}

export async function assertDailyOutreachReadBoundaryReady(pool: Pick<Pool, 'query'>): Promise<void> {
  const result = await pool.query<{ ready: boolean }>(
    `/* portal.daily-outreach.read-role-readiness */
     SELECT current_user = 'r72_daily_outreach_read'
        AND pg_catalog.has_function_privilege(
          current_user,
          'app_private.read_daily_outreach_cockpit_snapshot(uuid,text,uuid,date,smallint,smallint)',
          'EXECUTE'
        ) AS ready`,
  );
  if (result.rows.length !== 1 || result.rows[0]?.ready !== true) {
    throw new Error('Daily Outreach read boundary is incomplete');
  }
}

export async function assertDailyOutreachCommandBoundaryReady(pool: Pick<Pool, 'query'>): Promise<void> {
  const result = await pool.query<{ ready: boolean }>(
    `/* portal.daily-outreach.command-role-readiness */
     SELECT current_user = 'r72_daily_outreach_command'
        AND pg_catalog.has_function_privilege(
          current_user,
          'app_private.claim_next_manual_daily_outreach(uuid,uuid,text,date,text,bytea,integer)',
          'EXECUTE'
        )
        AND pg_catalog.has_function_privilege(
          current_user,
          'app_private.record_daily_outreach_manual_attempt(uuid,uuid,uuid,uuid,bytea,uuid,uuid,bytea,uuid,uuid,bytea,text,timestamptz,bytea)',
          'EXECUTE'
        )
        AND pg_catalog.has_function_privilege(
          current_user,
          'app_private.record_daily_outreach_outcome_event(uuid,uuid,uuid,text,timestamptz,bytea,bytea)',
          'EXECUTE'
        )
        AND pg_catalog.has_function_privilege(
          current_user,
          'app_private.project_daily_outreach_outcome(uuid,uuid,bytea,timestamptz,uuid,bytea)',
          'EXECUTE'
        )
        AND pg_catalog.has_function_privilege(
          current_user,
          'app_private.resolve_daily_outreach_command_replay(uuid,text,bytea)',
          'EXECUTE'
        ) AS ready`,
  );
  if (result.rows.length !== 1 || result.rows[0]?.ready !== true) {
    throw new Error('Daily Outreach command boundary is incomplete');
  }
}

export function createPgPortalDailyOutreachService(input: Readonly<{
  webPool: Pick<Pool, 'query'>;
  readPool: Pick<Pool, 'connect'>;
  commandPool?: Pick<Pool, 'connect'>;
  programmeKey?: string;
  now?: () => number;
}>): PgPortalDailyOutreachService {
  return new PgPortalDailyOutreachService({
    principalResolver: createPgPortalCrmPrincipalResolver(input.webPool),
    readPool: input.readPool,
    ...(input.commandPool ? { commandPool: input.commandPool } : {}),
    ...(input.programmeKey ? { programmeKey: input.programmeKey } : {}),
    ...(input.now ? { now: input.now } : {}),
  });
}
