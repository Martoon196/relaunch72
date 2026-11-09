import type { SocialNetwork } from '../providers/contracts.js';
import type {
  SocialCampaignCommandProjection,
  SocialCampaignTargetState,
} from '../social-campaign-pg/types.js';
import {
  CONTENT_CALENDAR_ROUTE,
  normaliseContentCalendarFilters,
  type ContentCalendarFilterInput,
} from './content-calendar-presenter.js';

export const PUBLIC_SOCIAL_CAMPAIGNS_ROUTE = '/portal/campaigns' as const;
export const PUBLIC_SOCIAL_CAMPAIGNS_MAX_PROJECTIONS = 120;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_TEXT = /^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]+$/u;

const NETWORK_LABELS: Readonly<Record<SocialNetwork, string>> = Object.freeze({
  facebook: 'Facebook',
  instagram: 'Instagram',
  linkedin: 'LinkedIn',
  tiktok: 'TikTok',
  x: 'X',
  youtube: 'YouTube',
  google_business_profile: 'Google Business Profile',
  threads: 'Threads',
  pinterest: 'Pinterest',
});

export type PublicSocialCampaignStateTone =
  | 'planned'
  | 'working'
  | 'complete'
  | 'cancelled'
  | 'attention';

const STATE_META: Readonly<Record<SocialCampaignTargetState, Readonly<{
  label: string;
  detail: string;
  tone: PublicSocialCampaignStateTone;
  attention: boolean;
}>>> = Object.freeze({
  waiting_for_test_time: Object.freeze({
    label: 'TEST plan queued',
    detail: 'Waiting for its durable TEST time. It cannot publish externally.',
    tone: 'planned',
    attention: false,
  }),
  leased: Object.freeze({
    label: 'Simulator leased',
    detail: 'A TEST worker holds the lease; provider effects remain none.',
    tone: 'working',
    attention: false,
  }),
  calling_simulator: Object.freeze({
    label: 'Simulator running',
    detail: 'The non-routable TEST simulator is evaluating this operation.',
    tone: 'working',
    attention: false,
  }),
  retry_wait: Object.freeze({
    label: 'TEST retry waiting',
    detail: 'A bounded simulator retry is waiting. No provider call is possible.',
    tone: 'working',
    attention: false,
  }),
  simulated_succeeded: Object.freeze({
    label: 'Simulation complete',
    detail: 'The TEST simulator completed. This is not a social publication.',
    tone: 'complete',
    attention: false,
  }),
  simulated_failed: Object.freeze({
    label: 'Simulation failed',
    detail: 'The TEST operation failed and needs operator attention.',
    tone: 'attention',
    attention: true,
  }),
  simulated_cancelled: Object.freeze({
    label: 'TEST plan cancelled',
    detail: 'This durable TEST operation was cancelled and cannot advance.',
    tone: 'cancelled',
    attention: false,
  }),
  reconciliation_required: Object.freeze({
    label: 'Reconciliation required',
    detail: 'The simulator result is ambiguous and requires safe reconciliation.',
    tone: 'attention',
    attention: true,
  }),
  simulated_reconciled: Object.freeze({
    label: 'Simulation reconciled',
    detail: 'The durable TEST simulator result was safely reconciled.',
    tone: 'complete',
    attention: false,
  }),
  dead_letter: Object.freeze({
    label: 'TEST dead letter',
    detail: 'Bounded attempts are exhausted and operator attention is required.',
    tone: 'attention',
    attention: true,
  }),
});

const NETWORKS = new Set<SocialNetwork>(Object.keys(NETWORK_LABELS) as SocialNetwork[]);
const STATES = new Set<SocialCampaignTargetState>(
  Object.keys(STATE_META) as SocialCampaignTargetState[],
);
const ALLOWED_FIELDS = new Set<keyof SocialCampaignCommandProjection>([
  'campaignId', 'revisionId', 'revisionNumber', 'revisionSha256', 'title',
  'objective', 'timezone', 'postId', 'contentItemId', 'contentVersionId',
  'contentSha256', 'planSha256', 'scheduledFor', 'operationId', 'targetId',
  'network', 'targetLabel', 'state', 'simulationAttemptCount',
  'maxSimulationAttempts', 'reconciliationAttemptCount',
  'maxReconciliationAttempts',
  'testReferenceSha256', 'environment', 'providerEffects',
]);

export class PublicSocialCampaignsPresentationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PublicSocialCampaignsPresentationError';
  }
}

function fail(message: string): never {
  throw new PublicSocialCampaignsPresentationError(message);
}

function uuid(value: unknown, label: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) fail(`${label} must be a canonical UUID`);
  return value;
}

function optionalUuid(value: unknown, label: string): string | null {
  return value === null ? null : uuid(value, label);
}

function sha256(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SHA256.test(value)) fail(`${label} must be a lowercase SHA-256`);
  return value;
}

function optionalSha256(value: unknown, label: string): string | null {
  return value === null ? null : sha256(value, label);
}

function integer(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    fail(`${label} is outside its safe bound`);
  }
  return value as number;
}

function optionalInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number | null {
  return value === null ? null : integer(value, label, minimum, maximum);
}

function text(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string' || value !== value.trim() || value.length === 0
      || value.length > maximum || !SAFE_TEXT.test(value)) {
    fail(`${label} is invalid`);
  }
  return value;
}

function timestamp(value: unknown, label: string): string {
  if (typeof value !== 'string') fail(`${label} must be a canonical UTC timestamp`);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    fail(`${label} must be a canonical UTC timestamp`);
  }
  return value;
}

function optionalTimestamp(value: unknown, label: string): string | null {
  return value === null ? null : timestamp(value, label);
}

function network(value: unknown): SocialNetwork | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !NETWORKS.has(value as SocialNetwork)) {
    fail('network is outside the supported public-social taxonomy');
  }
  return value as SocialNetwork;
}

function state(value: unknown): SocialCampaignTargetState | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !STATES.has(value as SocialCampaignTargetState)) {
    fail('state is outside the durable TEST taxonomy');
  }
  return value as SocialCampaignTargetState;
}

function exactProjection(
  value: SocialCampaignCommandProjection,
  index: number,
): SocialCampaignCommandProjection {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(`projection ${index + 1} is not an object`);
  }
  for (const key of Object.keys(value)) {
    if (!ALLOWED_FIELDS.has(key as keyof SocialCampaignCommandProjection)) {
      fail(`projection ${index + 1} contains unsupported field ${key}`);
    }
  }
  if (value.environment !== 'test' || value.providerEffects !== 'none') {
    fail(`projection ${index + 1} is not a zero-effect TEST projection`);
  }

  const checked = Object.freeze({
    campaignId: uuid(value.campaignId, 'campaignId'),
    revisionId: uuid(value.revisionId, 'revisionId'),
    revisionNumber: integer(value.revisionNumber, 'revisionNumber', 1, 1_000_000),
    revisionSha256: sha256(value.revisionSha256, 'revisionSha256'),
    title: text(value.title, 'title', 200),
    objective: text(value.objective, 'objective', 2_000),
    timezone: text(value.timezone, 'timezone', 100),
    postId: optionalUuid(value.postId, 'postId'),
    contentItemId: optionalUuid(value.contentItemId, 'contentItemId'),
    contentVersionId: optionalUuid(value.contentVersionId, 'contentVersionId'),
    contentSha256: optionalSha256(value.contentSha256, 'contentSha256'),
    planSha256: optionalSha256(value.planSha256, 'planSha256'),
    scheduledFor: optionalTimestamp(value.scheduledFor, 'scheduledFor'),
    operationId: optionalUuid(value.operationId, 'operationId'),
    targetId: optionalUuid(value.targetId, 'targetId'),
    network: network(value.network),
    targetLabel: value.targetLabel === null ? null : text(value.targetLabel, 'targetLabel', 120),
    state: state(value.state),
    simulationAttemptCount: optionalInteger(
      value.simulationAttemptCount, 'simulationAttemptCount', 0, 4,
    ),
    maxSimulationAttempts: optionalInteger(
      value.maxSimulationAttempts, 'maxSimulationAttempts', 1, 4,
    ),
    reconciliationAttemptCount: optionalInteger(
      value.reconciliationAttemptCount, 'reconciliationAttemptCount', 0, 4,
    ),
    maxReconciliationAttempts: optionalInteger(
      value.maxReconciliationAttempts, 'maxReconciliationAttempts', 1, 4,
    ),
    testReferenceSha256: optionalSha256(value.testReferenceSha256, 'testReferenceSha256'),
    environment: 'test' as const,
    providerEffects: 'none' as const,
  });

  const postEvidence = [
    checked.contentItemId, checked.contentVersionId, checked.contentSha256,
    checked.planSha256, checked.scheduledFor,
  ];
  if (checked.postId === null && postEvidence.some((part) => part !== null)) {
    fail(`projection ${index + 1} has post evidence without a post`);
  }
  if (checked.postId !== null && postEvidence.some((part) => part === null)) {
    fail(`projection ${index + 1} has incomplete post provenance`);
  }

  const operationEvidence = [
    checked.targetId, checked.network, checked.targetLabel, checked.state,
    checked.simulationAttemptCount, checked.maxSimulationAttempts,
    checked.reconciliationAttemptCount, checked.maxReconciliationAttempts,
  ];
  if (checked.operationId === null && operationEvidence.some((part) => part !== null)) {
    fail(`projection ${index + 1} has target evidence without an operation`);
  }
  if (checked.operationId !== null && operationEvidence.some((part) => part === null)) {
    fail(`projection ${index + 1} has incomplete target provenance`);
  }
  if (checked.operationId !== null && checked.postId === null) {
    fail(`projection ${index + 1} has an operation without a post`);
  }
  if (checked.operationId === null && checked.testReferenceSha256 !== null) {
    fail(`projection ${index + 1} has a TEST receipt without an operation`);
  }
  if (checked.simulationAttemptCount !== null && checked.maxSimulationAttempts !== null
      && checked.simulationAttemptCount > checked.maxSimulationAttempts) {
    fail(`projection ${index + 1} has impossible simulation-attempt evidence`);
  }
  if (checked.reconciliationAttemptCount !== null
      && checked.maxReconciliationAttempts !== null
      && checked.reconciliationAttemptCount > checked.maxReconciliationAttempts) {
    fail(`projection ${index + 1} has impossible reconciliation-attempt evidence`);
  }
  if ((checked.state === 'simulated_succeeded' || checked.state === 'simulated_reconciled')
      && checked.testReferenceSha256 === null) {
    fail(`projection ${index + 1} is complete without an exact TEST receipt hash`);
  }
  return checked;
}

export interface PublicSocialCampaignTargetView {
  readonly operationId: string;
  readonly targetId: string;
  readonly network: SocialNetwork;
  readonly networkLabel: string;
  readonly targetLabel: string;
  readonly state: SocialCampaignTargetState;
  readonly stateLabel: string;
  readonly stateDetail: string;
  readonly stateTone: PublicSocialCampaignStateTone;
  readonly attention: boolean;
  readonly simulationAttemptCount: number;
  readonly maxSimulationAttempts: number;
  readonly reconciliationAttemptCount: number;
  readonly maxReconciliationAttempts: number;
  readonly testReferenceSha256: string | null;
}

export type PublicSocialCampaignLaunchTone =
  | 'planned'
  | 'working'
  | 'complete'
  | 'cancelled'
  | 'attention';

export interface PublicSocialCampaignLaunchStepView {
  readonly key: 'content' | 'builder' | 'calendar' | 'approval' | 'queue' | 'receipt';
  readonly indexLabel: string;
  readonly label: string;
  readonly stateLabel: string;
  readonly detail: string;
  readonly tone: PublicSocialCampaignLaunchTone;
}

export interface PublicSocialCampaignPostView {
  readonly postId: string;
  readonly contentItemId: string;
  readonly contentVersionId: string;
  readonly contentSha256: string;
  readonly planSha256: string;
  readonly scheduledFor: string;
  readonly targets: readonly PublicSocialCampaignTargetView[];
  readonly receiptCount: number;
  readonly launchSteps: readonly PublicSocialCampaignLaunchStepView[];
}

export interface PublicSocialCampaignRevisionView {
  readonly revisionId: string;
  readonly revisionNumber: number;
  readonly revisionSha256: string;
  readonly title: string;
  readonly objective: string;
  readonly timezone: string;
  readonly posts: readonly PublicSocialCampaignPostView[];
  readonly targetCount: number;
  readonly attentionCount: number;
}

export interface PublicSocialCampaignsView {
  readonly route: typeof PUBLIC_SOCIAL_CAMPAIGNS_ROUTE;
  readonly calendarHref: string;
  readonly workspaceName: string;
  readonly workspaceTimezone: string;
  readonly snapshotAt: string;
  readonly campaignId: string | null;
  readonly campaignTitle: string | null;
  readonly campaignObjective: string | null;
  readonly revisions: readonly PublicSocialCampaignRevisionView[];
  readonly summary: Readonly<{
    revisionCount: number;
    postCount: number;
    targetCount: number;
    attentionCount: number;
  }>;
  readonly environment: 'test';
  readonly providerEffects: 'none';
  readonly readOnly: true;
  /** True when the database proved that additional complete aggregates exist. */
  readonly inputTruncated: boolean;
}

export interface PresentPublicSocialCampaignsOptions {
  readonly workspaceName: string;
  readonly workspaceTimezone: string;
  readonly snapshotAt: string;
  readonly requestedCampaignId?: string | null;
  readonly calendarFilters?: ContentCalendarFilterInput;
  readonly inputTruncated: boolean;
}

interface MutableRevision {
  revisionId: string;
  revisionNumber: number;
  revisionSha256: string;
  title: string;
  objective: string;
  timezone: string;
  posts: Map<string, MutablePost>;
}

interface MutablePost {
  postId: string;
  contentItemId: string;
  contentVersionId: string;
  contentSha256: string;
  planSha256: string;
  scheduledFor: string;
  targets: PublicSocialCampaignTargetView[];
  operationIds: Set<string>;
}

function sameRevision(revision: MutableRevision, row: SocialCampaignCommandProjection): boolean {
  return revision.revisionNumber === row.revisionNumber
    && revision.revisionSha256 === row.revisionSha256
    && revision.title === row.title
    && revision.objective === row.objective
    && revision.timezone === row.timezone;
}

function samePost(post: MutablePost, row: SocialCampaignCommandProjection): boolean {
  return post.contentItemId === row.contentItemId
    && post.contentVersionId === row.contentVersionId
    && post.contentSha256 === row.contentSha256
    && post.planSha256 === row.planSha256
    && post.scheduledFor === row.scheduledFor;
}

function launchSteps(
  post: Readonly<{
    contentVersionId: string;
    contentSha256: string;
    planSha256: string;
    scheduledFor: string;
  }>,
  targets: readonly PublicSocialCampaignTargetView[],
): readonly PublicSocialCampaignLaunchStepView[] {
  const receiptCount = targets.filter((target) => target.testReferenceSha256 !== null).length;
  const attentionCount = targets.filter((target) => target.attention).length;
  const completeCount = targets.filter((target) => target.stateTone === 'complete').length;
  const workingCount = targets.filter((target) => target.stateTone === 'working').length;
  const cancelledCount = targets.filter((target) => target.stateTone === 'cancelled').length;
  const queueTone: PublicSocialCampaignLaunchTone = attentionCount > 0
    ? 'attention'
    : targets.length > 0 && completeCount === targets.length
      ? 'complete'
      : targets.length > 0 && completeCount + cancelledCount === targets.length
        ? 'cancelled'
      : workingCount > 0
        ? 'working'
        : 'planned';
  const queueLabel = attentionCount > 0
    ? `${attentionCount} need attention`
    : targets.length === 0
      ? 'No target operation yet'
      : completeCount === targets.length
        ? 'Simulator queue settled'
        : completeCount + cancelledCount === targets.length
          ? cancelledCount === targets.length
            ? 'TEST operations cancelled'
            : `Queue settled · ${cancelledCount} cancelled`
        : workingCount > 0
          ? 'Simulator working'
          : 'TEST operations queued';
  const receiptTone: PublicSocialCampaignLaunchTone = targets.length > 0
    && cancelledCount === targets.length
    ? 'cancelled'
    : targets.length > 0 && receiptCount > 0
      && receiptCount + cancelledCount === targets.length
      ? 'complete'
    : receiptCount > 0
      ? 'working'
      : attentionCount > 0
        ? 'attention'
        : 'planned';
  const receiptLabel = targets.length > 0 && cancelledCount === targets.length
    ? 'No receipt expected · cancelled'
    : receiptCount > 0 && receiptCount + cancelledCount === targets.length
      ? `${receiptCount} receipt${receiptCount === 1 ? '' : 's'} sealed${cancelledCount > 0 ? ` · ${cancelledCount} cancelled` : ''}`
    : receiptCount === 0
    ? 'Awaiting TEST evidence'
      : `${receiptCount} of ${targets.length} receipts sealed`;

  return Object.freeze([
    Object.freeze({
      key: 'content' as const,
      indexLabel: '01',
      label: 'Approved company content',
      stateLabel: 'Exact version pinned',
      detail: `Version ${post.contentVersionId} · SHA ${post.contentSha256.slice(0, 12)}…`,
      tone: 'complete' as const,
    }),
    Object.freeze({
      key: 'builder' as const,
      indexLabel: '02',
      label: 'Campaign Builder',
      stateLabel: 'Immutable plan sealed',
      detail: `Body-free plan proof ${post.planSha256.slice(0, 12)}…`,
      tone: 'complete' as const,
    }),
    Object.freeze({
      key: 'calendar' as const,
      indexLabel: '03',
      label: 'Campaign Calendar',
      stateLabel: 'TEST slot fixed',
      detail: `Durable TEST time ${post.scheduledFor}`,
      tone: 'complete' as const,
    }),
    Object.freeze({
      key: 'approval' as const,
      indexLabel: '04',
      label: 'Approval + source gate',
      stateLabel: targets.length > 0 ? 'Materialisation proof present' : 'Awaiting operation proof',
      detail: targets.length > 0
        ? 'The post and target operations exist only after the exact approval/source boundary passed. Current planning/revalidation state, when present, remains visible in Calendar.'
        : 'No target operation proves materialisation yet. Approval decision identities remain private.',
      tone: targets.length > 0 ? 'complete' as const : 'planned' as const,
    }),
    Object.freeze({
      key: 'queue' as const,
      indexLabel: '05',
      label: 'Dark simulator queue',
      stateLabel: queueLabel,
      detail: `${targets.length} bounded TEST target${targets.length === 1 ? '' : 's'} · provider effects none`,
      tone: queueTone,
    }),
    Object.freeze({
      key: 'receipt' as const,
      indexLabel: '06',
      label: 'Simulated evidence',
      stateLabel: receiptLabel,
      detail: receiptCount > 0
        ? 'Exact receipt hashes are shown in the operation evidence below. They prove simulation, never publication.'
        : 'No simulator receipt hash has been recorded for this TEST plan.',
      tone: receiptTone,
    }),
  ]);
}

/**
 * Converts only the allowlisted, body-free public-social command projection into
 * a bounded read model. Unknown fields fail closed so account refs, storage keys
 * and provider material cannot be accidentally introduced into this surface.
 */
export function presentPublicSocialCampaigns(
  projections: readonly SocialCampaignCommandProjection[],
  options: PresentPublicSocialCampaignsOptions,
): PublicSocialCampaignsView {
  if (!Array.isArray(projections)) fail('campaign projections must be an array');
  if (projections.length > PUBLIC_SOCIAL_CAMPAIGNS_MAX_PROJECTIONS) {
    fail(`campaign projections exceed the ${PUBLIC_SOCIAL_CAMPAIGNS_MAX_PROJECTIONS}-row bound`);
  }
  const workspaceName = text(options.workspaceName, 'workspaceName', 160);
  const workspaceTimezone = text(options.workspaceTimezone, 'workspaceTimezone', 100);
  const snapshotAt = timestamp(options.snapshotAt, 'snapshotAt');
  if (typeof options.inputTruncated !== 'boolean') fail('inputTruncated must be boolean');
  const calendarFilters = normaliseContentCalendarFilters(options.calendarFilters ?? {}, snapshotAt);
  const calendarHref = `${CONTENT_CALENDAR_ROUTE}?mode=${encodeURIComponent(calendarFilters.mode)}`
    + `&date=${encodeURIComponent(calendarFilters.date)}`
    + `&channel=${encodeURIComponent(calendarFilters.channel)}`;
  const requestedCampaignId = options.requestedCampaignId === undefined
    || options.requestedCampaignId === null
    ? null
    : uuid(options.requestedCampaignId, 'requestedCampaignId');
  const rows = projections.map(exactProjection);
  const campaignIds = new Set(rows.map((row) => row.campaignId));
  if (campaignIds.size > 1) fail('campaign projection contains more than one campaign');
  const campaignId = rows[0]?.campaignId ?? requestedCampaignId;
  if (requestedCampaignId !== null && campaignId !== requestedCampaignId) {
    fail('campaign projection does not match the requested campaign');
  }

  const revisions = new Map<string, MutableRevision>();
  const revisionNumbers = new Map<number, string>();
  const postRevisions = new Map<string, string>();
  const operationPosts = new Map<string, string>();
  for (const row of rows) {
    let revision = revisions.get(row.revisionId);
    if (!revision) {
      const previousId = revisionNumbers.get(row.revisionNumber);
      if (previousId && previousId !== row.revisionId) {
        fail(`revision number ${row.revisionNumber} resolves to conflicting identities`);
      }
      revisionNumbers.set(row.revisionNumber, row.revisionId);
      revision = {
        revisionId: row.revisionId,
        revisionNumber: row.revisionNumber,
        revisionSha256: row.revisionSha256,
        title: row.title,
        objective: row.objective,
        timezone: row.timezone,
        posts: new Map(),
      };
      revisions.set(row.revisionId, revision);
    } else if (!sameRevision(revision, row)) {
      fail(`revision ${row.revisionId} has conflicting immutable provenance`);
    }

    if (row.postId === null) continue;
    const previousRevisionId = postRevisions.get(row.postId);
    if (previousRevisionId && previousRevisionId !== row.revisionId) {
      fail(`post ${row.postId} resolves to conflicting revisions`);
    }
    postRevisions.set(row.postId, row.revisionId);
    let post = revision.posts.get(row.postId);
    if (!post) {
      post = {
        postId: row.postId,
        contentItemId: row.contentItemId!,
        contentVersionId: row.contentVersionId!,
        contentSha256: row.contentSha256!,
        planSha256: row.planSha256!,
        scheduledFor: row.scheduledFor!,
        targets: [],
        operationIds: new Set(),
      };
      revision.posts.set(row.postId, post);
    } else if (!samePost(post, row)) {
      fail(`post ${row.postId} has conflicting immutable provenance`);
    }

    if (row.operationId === null) continue;
    const previousPostId = operationPosts.get(row.operationId);
    if (previousPostId && previousPostId !== row.postId) {
      fail(`operation ${row.operationId} resolves to conflicting posts`);
    }
    operationPosts.set(row.operationId, row.postId);
    if (post.operationIds.has(row.operationId)) {
      fail(`operation ${row.operationId} appears more than once`);
    }
    post.operationIds.add(row.operationId);
    const stateMeta = STATE_META[row.state!];
    post.targets.push(Object.freeze({
      operationId: row.operationId,
      targetId: row.targetId!,
      network: row.network!,
      networkLabel: NETWORK_LABELS[row.network!],
      targetLabel: row.targetLabel!,
      state: row.state!,
      stateLabel: stateMeta.label,
      stateDetail: stateMeta.detail,
      stateTone: stateMeta.tone,
      attention: stateMeta.attention,
      simulationAttemptCount: row.simulationAttemptCount!,
      maxSimulationAttempts: row.maxSimulationAttempts!,
      reconciliationAttemptCount: row.reconciliationAttemptCount!,
      maxReconciliationAttempts: row.maxReconciliationAttempts!,
      testReferenceSha256: row.testReferenceSha256,
    }));
  }

  const revisionViews = [...revisions.values()]
    .sort((left, right) => right.revisionNumber - left.revisionNumber
      || left.revisionId.localeCompare(right.revisionId))
    .map((revision): PublicSocialCampaignRevisionView => {
      const posts = [...revision.posts.values()]
        .sort((left, right) => left.scheduledFor.localeCompare(right.scheduledFor)
          || left.postId.localeCompare(right.postId))
        .map((post): PublicSocialCampaignPostView => {
          const targets = Object.freeze(post.targets.sort((left, right) => (
            left.network.localeCompare(right.network)
              || left.operationId.localeCompare(right.operationId)
          )));
          return Object.freeze({
            postId: post.postId,
            contentItemId: post.contentItemId,
            contentVersionId: post.contentVersionId,
            contentSha256: post.contentSha256,
            planSha256: post.planSha256,
            scheduledFor: post.scheduledFor,
            targets,
            receiptCount: targets.filter((target) => target.testReferenceSha256 !== null).length,
            launchSteps: launchSteps(post, targets),
          });
        });
      const targets = posts.flatMap((post) => post.targets);
      return Object.freeze({
        revisionId: revision.revisionId,
        revisionNumber: revision.revisionNumber,
        revisionSha256: revision.revisionSha256,
        title: revision.title,
        objective: revision.objective,
        timezone: revision.timezone,
        posts: Object.freeze(posts),
        targetCount: targets.length,
        attentionCount: targets.filter((target) => target.attention).length,
      });
    });
  const postCount = revisionViews.reduce((total, revision) => total + revision.posts.length, 0);
  const targetCount = revisionViews.reduce((total, revision) => total + revision.targetCount, 0);
  const attentionCount = revisionViews.reduce(
    (total, revision) => total + revision.attentionCount,
    0,
  );
  const currentRevision = revisionViews[0] ?? null;

  return Object.freeze({
    route: PUBLIC_SOCIAL_CAMPAIGNS_ROUTE,
    calendarHref,
    workspaceName,
    workspaceTimezone,
    snapshotAt,
    campaignId,
    campaignTitle: currentRevision?.title ?? null,
    campaignObjective: currentRevision?.objective ?? null,
    revisions: Object.freeze(revisionViews),
    summary: Object.freeze({
      revisionCount: revisionViews.length,
      postCount,
      targetCount,
      attentionCount,
    }),
    environment: 'test',
    providerEffects: 'none',
    readOnly: true,
    inputTruncated: options.inputTruncated,
  });
}
