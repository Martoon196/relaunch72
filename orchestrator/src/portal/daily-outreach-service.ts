import type { PortalCrmRequestIdentity } from './crm-service.js';

export const DAILY_OUTREACH_PROGRAMME_KEY = 'founder_daily_linkedin' as const;
export const DAILY_OUTREACH_QUEUE_LIMIT = 16;
export const DAILY_OUTREACH_OUTCOME_LIMIT = 12;

export type DailyOutreachAuthoritativeOutcome =
  | 'attempted'
  | 'replied'
  | 'positive'
  | 'referred'
  | 'booked'
  | 'declined'
  | 'no_response'
  | 'invalid_target'
  | 'suppressed';

export type DailyOutreachActionState =
  | 'completed'
  | 'contact_unavailable'
  | 'source_stale'
  | 'suppressed'
  | 'stopped'
  | 'cooling'
  | 'eligibility_missing'
  | 'blocked'
  | 'eligibility_stale'
  | 'content_unassigned'
  | 'content_stale'
  | 'leased_by_me'
  | 'leased'
  | 'manual_ready'
  | 'review_required';

export interface DailyOutreachContactRef {
  readonly id: string;
  readonly displayName: string;
  readonly companyName: string | null;
}

export interface DailyOutreachEligibilityRef {
  readonly id: string;
  readonly decision: 'manual_first_touch' | 'zernio_supported' | 'blocked';
  readonly reasonCode: string;
  readonly evaluatedAt: string;
  readonly expiresAt: string;
  readonly providerEffectsEnabled: false;
}

export interface DailyOutreachContentAssignmentRef {
  readonly id: string;
  readonly assignedAt: string;
  readonly contentItemId: string;
  readonly contentVersionId: string;
  readonly contentSha256: string;
  readonly approvalRequestId: string;
  readonly approvalDecisionId: string;
  readonly current: boolean;
}

export interface DailyOutreachOutcomeRef {
  readonly id: string;
  readonly attemptReceiptId: string;
  readonly outcome: DailyOutreachAuthoritativeOutcome;
  readonly occurredAt: string;
  readonly recordedAt: string;
}

export interface DailyOutreachControlRef {
  readonly id: string;
  readonly kind: 'cooldown' | 'stopped';
  readonly reasonCode: string;
  readonly notBefore: string | null;
  readonly recordedAt?: string;
}

export interface DailyOutreachProjectionRef {
  readonly id: string;
  readonly taskDisposition: 'created' | 'not_required';
  readonly taskKind: 'follow_up' | 'reply_review' | 'admin_call' | 'none';
  readonly taskId: string | null;
  readonly lapsDisposition: 'response_evidence_pending' | 'cold_attempt_not_eligible';
  readonly projectedAt: string;
}

export interface DailyOutreachTaskRef {
  readonly id: string;
  readonly assigneeUserId: string;
  readonly status: string;
  readonly dueAt: string | null;
  readonly completedAt: string | null;
}

export interface DailyOutreachQueueRow {
  readonly allocationId: string;
  readonly programmeVersionId: string;
  readonly prospectMembershipId: string;
  readonly contact: DailyOutreachContactRef;
  readonly operatorUserId: string;
  readonly channel: 'linkedin' | 'instagram';
  readonly segmentKey: string;
  readonly quotaDayUtc: string;
  readonly priorityRank: number;
  readonly source: Readonly<{
    adapter: string;
    observedAt: string;
    expiresAt: string;
  }>;
  readonly eligibility: DailyOutreachEligibilityRef | null;
  readonly lease: Readonly<{
    id: string;
    version: number;
    leasedByUserId: string;
    ownedByViewer: boolean;
    leasedAt: string;
    expiresAt: string;
    active: boolean;
  }> | null;
  readonly contentAssignment: DailyOutreachContentAssignmentRef | null;
  readonly latestOutcome: DailyOutreachOutcomeRef | null;
  readonly control: DailyOutreachControlRef | null;
  readonly projection: DailyOutreachProjectionRef | null;
  readonly task: DailyOutreachTaskRef | null;
  readonly actionState: DailyOutreachActionState;
  readonly commandRechecksRequired: true;
}

export interface DailyOutreachRecentOutcomeRow {
  readonly id: string;
  readonly attemptReceiptId: string;
  readonly allocationId: string;
  readonly programmeVersionId: string;
  readonly quotaDayUtc: string;
  readonly attemptedAt: string;
  readonly cooldownSeconds: number;
  readonly contact: DailyOutreachContactRef;
  readonly channel: 'linkedin' | 'instagram';
  readonly outcome: DailyOutreachAuthoritativeOutcome;
  readonly occurredAt: string;
  readonly recordedAt: string;
  readonly isLatest: true;
  readonly canRecordOutcome: boolean;
  readonly contentAssignmentId: string;
  readonly contentItemId: string;
  readonly contentVersionId: string;
  readonly contentSha256: string;
  readonly approvalRequestId: string;
  readonly approvalDecisionId: string;
  readonly control: Omit<DailyOutreachControlRef, 'recordedAt'> | null;
  readonly projection: DailyOutreachProjectionRef | null;
  readonly task: DailyOutreachTaskRef | null;
}

export interface DailyOutreachAuthoritativeSnapshot {
  readonly schemaVersion: 1;
  readonly dataset: 'postgres_authoritative';
  readonly quotaTimezone: 'UTC';
  readonly quotaDayUtc: string;
  readonly snapshotAt: string;
  readonly workspace: Readonly<{ id: string }>;
  readonly operator: Readonly<{
    id: string;
    viewerUserId: string;
    viewerIsOperator: boolean;
  }>;
  readonly programme: Readonly<{
    id: string;
    key: string;
    versionNumber: number;
    channel: 'linkedin' | 'instagram';
    segmentKey: string;
    dailyTarget: number;
    operatingDailyCap: number;
    providerDailyCap: number;
    cooldownSeconds: number;
    effectiveFrom: string;
    effectiveUntil: string | null;
    providerEffectsEnabled: false;
  }>;
  readonly manager: Readonly<{
    prospectsReviewed: number;
    validAttempts: number;
    responses: number;
    positiveResponses: number;
    booked: number;
    noResponse: number;
    invalidTargets: number;
    suppressed: number;
    blocked: number;
    activeLeases: number;
    cooling: number;
    stopped: number;
    tasksCreated: number;
    responseEvidencePending: number;
    target: number;
    operatingDailyCap: number;
    providerDailyCap: number;
    remainingToTarget: number;
    metricAvailability: Readonly<Record<string, string>>;
  }>;
  readonly queue: readonly DailyOutreachQueueRow[];
  readonly recentOutcomes: readonly DailyOutreachRecentOutcomeRow[];
  readonly commandBoundaryAvailable: boolean;
  readonly externalEffects: false;
}

export type DailyOutreachFailureKind =
  | 'unauthenticated'
  | 'forbidden'
  | 'not_found'
  | 'validation'
  | 'conflict'
  | 'unavailable';

export type DailyOutreachSnapshotOutcome =
  | Readonly<{ ok: true; snapshot: DailyOutreachAuthoritativeSnapshot }>
  | Readonly<{ ok: false; kind: DailyOutreachFailureKind; message: string }>;

export interface DailyOutreachManualAttemptInput {
  readonly allocationId: string;
  readonly attemptedAt: string;
  readonly commandKey: string;
}

export interface DailyOutreachRecordOutcomeInput {
  readonly attemptReceiptId: string;
  readonly previousOutcomeEventId: string;
  readonly outcome: Exclude<DailyOutreachAuthoritativeOutcome, 'attempted'>;
  readonly occurredAt: string;
  readonly commandKey: string;
}

export type DailyOutreachCommandOutcome =
  | Readonly<{
    ok: true;
    disposition: 'recorded' | 'replayed';
    outcomeEventId: string;
    taskId: string | null;
    lapsDisposition: 'response_evidence_pending' | 'cold_attempt_not_eligible';
  }>
  | Readonly<{ ok: false; kind: DailyOutreachFailureKind; message: string }>;

export interface PortalDailyOutreachService {
  snapshot(identity: PortalCrmRequestIdentity): Promise<DailyOutreachSnapshotOutcome>;
  recordManualAttempt(
    identity: PortalCrmRequestIdentity,
    input: DailyOutreachManualAttemptInput,
  ): Promise<DailyOutreachCommandOutcome>;
  recordOutcome(
    identity: PortalCrmRequestIdentity,
    input: DailyOutreachRecordOutcomeInput,
  ): Promise<DailyOutreachCommandOutcome>;
}
