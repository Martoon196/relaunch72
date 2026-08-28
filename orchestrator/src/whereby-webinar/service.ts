import { createHash } from 'node:crypto';
import {
  parsePropertyPredatorExternalEvent,
  type PropertyPredatorExternalEvent,
} from '../integrations/external-events/contracts.js';
import {
  isVerifiedWherebyRoomEvent,
  type VerifiedWherebyRoomEvent,
} from './contracts.js';

const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CANONICAL_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const SAFE_EVENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const SAFE_LEASE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9_-]{15,199}$/u;
const SAFE_CONTENT_KEY = /^[a-z0-9][a-z0-9._:-]{0,149}$/u;
const SAFE_TEXT = /^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]*$/u;

export interface WherebyWebhookReceiptClaim {
  readonly workspaceId: string;
  readonly connectionId: string;
  readonly eventId: string;
  readonly payloadSha256: string;
}

export type WherebyWebhookReceiptClaimDecision =
  | Readonly<{ disposition: 'claimed'; leaseToken: string }>
  | Readonly<{ disposition: 'replayed' | 'conflict' | 'in_progress' }>;

export interface WherebyWebhookReceiptLease extends WherebyWebhookReceiptClaim {
  readonly leaseToken: string;
}

export interface WherebyWebhookReceiptStore {
  /** Claims a bounded lease. Implementations must expire abandoned leases for provider retries. */
  claim(input: WherebyWebhookReceiptClaim): Promise<WherebyWebhookReceiptClaimDecision>;
  complete(input: Readonly<WherebyWebhookReceiptLease & {
    outcomeSha256: string;
  }>): Promise<'completed' | 'lost'>;
  release(input: WherebyWebhookReceiptLease): Promise<'released' | 'lost'>;
}

export interface WherebyParticipantBinding {
  readonly workspaceId: string;
  readonly accountId: string;
  readonly connectionId: string;
  readonly contentKey: string;
  readonly contentVersion: string;
  readonly title: string;
  readonly scheduledDurationSeconds: number;
  readonly completionThresholdBasisPoints: number;
}

export interface WherebyParticipantBindingResolver {
  resolve(input: Readonly<{
    workspaceId: string;
    connectionId: string;
    meetingId: string;
    externalId: string;
  }>): Promise<WherebyParticipantBinding | null>;
}

export interface WherebyAttendancePair {
  readonly workspaceId: string;
  readonly connectionId: string;
  readonly meetingId: string;
  readonly roomSessionId: string | null;
  readonly participantId: string;
  readonly externalId: string;
  readonly joinedEventId: string;
  readonly leftEventId: string;
  readonly joinedAt: string;
  readonly leftAt: string;
}

export type WherebyAttendanceMutation =
  | Readonly<{ disposition: 'opened' }>
  | Readonly<{ disposition: 'pending' }>
  | Readonly<{ disposition: 'paired'; pair: WherebyAttendancePair }>;

export interface WherebyAttendanceStateStore {
  /**
   * Both methods must retain unmatched events and return the same immutable
   * `paired` result on retry until the deterministic Lead 360 sink succeeds.
   */
  recordJoin(input: Readonly<{
    workspaceId: string;
    connectionId: string;
    meetingId: string;
    roomSessionId: string | null;
    participantId: string;
    externalId: string;
    eventId: string;
    joinedAt: string;
  }>): Promise<WherebyAttendanceMutation>;
  recordLeave(input: Readonly<{
    workspaceId: string;
    connectionId: string;
    meetingId: string;
    roomSessionId: string | null;
    participantId: string;
    externalId: string;
    eventId: string;
    leftAt: string;
  }>): Promise<WherebyAttendanceMutation>;
}

export interface WherebyJourneyEventSink {
  record(input: Readonly<{
    workspaceId: string;
    connectionId: string;
    event: PropertyPredatorExternalEvent;
  }>): Promise<'recorded' | 'replayed'>;
}

export interface WherebyWebinarIngestResult {
  readonly disposition:
    | 'recorded'
    | 'replayed'
    | 'ignored_unbound'
    | 'attendance_opened'
    | 'attendance_pending'
    | 'projected';
  readonly projectedEvent?: PropertyPredatorExternalEvent;
}

export interface WherebyWebinarIngestDependencies {
  readonly workspaceId: string;
  readonly connectionId: string;
  /** This bridge only ingests verified events; it can never create rooms or publish. */
  readonly providerEffectsEnabled: false;
  readonly emergencyPaused: true;
  readonly receipts: WherebyWebhookReceiptStore;
  readonly bindings: WherebyParticipantBindingResolver;
  readonly attendance: WherebyAttendanceStateStore;
  readonly journeyEvents: WherebyJourneyEventSink;
}

export class WherebyWebinarBridgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WherebyWebinarBridgeError';
  }
}

/** The HTTP boundary must map this error to 5xx so Whereby retries delivery. */
export class WherebyWebinarRetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WherebyWebinarRetryableError';
  }
}

function fail(message: string): never {
  throw new WherebyWebinarBridgeError(message);
}

function deterministicUuid(seed: string): string {
  const bytes = createHash('sha256').update(seed, 'utf8').digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function validateBinding(binding: WherebyParticipantBinding): WherebyParticipantBinding {
  if (!CANONICAL_UUID.test(binding.workspaceId)
      || !CANONICAL_UUID.test(binding.accountId)
      || !CANONICAL_UUID.test(binding.connectionId)
      || !SAFE_CONTENT_KEY.test(binding.contentKey)
      || typeof binding.contentVersion !== 'string'
      || binding.contentVersion.length < 1
      || binding.contentVersion.length > 100
      || binding.contentVersion.trim() !== binding.contentVersion
      || !SAFE_TEXT.test(binding.contentVersion)
      || typeof binding.title !== 'string'
      || binding.title.length < 1
      || binding.title.length > 200
      || binding.title.trim() !== binding.title
      || !SAFE_TEXT.test(binding.title)
      || !Number.isSafeInteger(binding.scheduledDurationSeconds)
      || binding.scheduledDurationSeconds < 60
      || binding.scheduledDurationSeconds > 86_400
      || !Number.isSafeInteger(binding.completionThresholdBasisPoints)
      || binding.completionThresholdBasisPoints < 1_000
      || binding.completionThresholdBasisPoints > 10_000) {
    return fail('Whereby participant binding is invalid');
  }
  return Object.freeze({ ...binding });
}

function canonicalPairTimestamp(value: unknown): string {
  if (typeof value !== 'string' || !CANONICAL_TIMESTAMP.test(value)) {
    return fail('Whereby attendance pair is invalid');
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    return fail('Whereby attendance pair is invalid');
  }
  return value;
}

function validateAttendanceMutation(
  value: WherebyAttendanceMutation,
  currentEvent: VerifiedWherebyRoomEvent,
  workspaceId: string,
  connectionId: string,
  externalId: string,
): WherebyAttendanceMutation {
  if (!value || typeof value !== 'object') return fail('Whereby attendance mutation is invalid');
  if (value.disposition === 'opened' || value.disposition === 'pending') {
    return Object.freeze({ disposition: value.disposition });
  }
  if (value.disposition !== 'paired' || !value.pair || typeof value.pair !== 'object') {
    return fail('Whereby attendance mutation is invalid');
  }
  const pair = value.pair;
  if (pair.workspaceId !== workspaceId
      || pair.connectionId !== connectionId
      || pair.meetingId !== currentEvent.data.meetingId
      || pair.participantId !== currentEvent.data.participantId
      || pair.externalId !== externalId
      || (currentEvent.data.roomSessionId !== null
        && pair.roomSessionId !== currentEvent.data.roomSessionId)
      || (pair.roomSessionId !== null
        && (typeof pair.roomSessionId !== 'string'
          || pair.roomSessionId.length < 1
          || pair.roomSessionId.length > 256
          || pair.roomSessionId.trim() !== pair.roomSessionId
          || !SAFE_TEXT.test(pair.roomSessionId)))
      || !SAFE_EVENT_ID.test(pair.joinedEventId)
      || !SAFE_EVENT_ID.test(pair.leftEventId)
      || (currentEvent.type === 'room.client.joined' && pair.joinedEventId !== currentEvent.id)
      || (currentEvent.type === 'room.client.left' && pair.leftEventId !== currentEvent.id)) {
    return fail('Whereby attendance pair is invalid');
  }
  const joinedAt = canonicalPairTimestamp(pair.joinedAt);
  const leftAt = canonicalPairTimestamp(pair.leftAt);
  const elapsedMilliseconds = new Date(leftAt).getTime() - new Date(joinedAt).getTime();
  if (elapsedMilliseconds < 0
      || Math.floor(elapsedMilliseconds / 1_000) > 2_147_483_647) {
    return fail('Whereby attendance pair is invalid');
  }
  return Object.freeze({
    disposition: 'paired',
    pair: Object.freeze({
      workspaceId: pair.workspaceId,
      connectionId: pair.connectionId,
      meetingId: pair.meetingId,
      roomSessionId: pair.roomSessionId,
      participantId: pair.participantId,
      externalId: pair.externalId,
      joinedEventId: pair.joinedEventId,
      leftEventId: pair.leftEventId,
      joinedAt,
      leftAt,
    }),
  });
}

function buildJourneyEvent(
  event: VerifiedWherebyRoomEvent,
  binding: WherebyParticipantBinding,
  pair: WherebyAttendancePair,
): PropertyPredatorExternalEvent {
  const consumedSeconds = Math.floor(
    (new Date(pair.leftAt).getTime() - new Date(pair.joinedAt).getTime()) / 1_000,
  );
  const measuredBasisPoints = Math.min(
    10_000,
    Math.floor((consumedSeconds * 10_000) / binding.scheduledDurationSeconds),
  );
  const completed = measuredBasisPoints >= binding.completionThresholdBasisPoints;
  const common = {
    id: deterministicUuid(
      `whereby:event:${binding.connectionId}:${pair.joinedEventId}:${pair.leftEventId}`,
    ),
    version: 1 as const,
    occurredAt: pair.leftAt,
    correlationId: deterministicUuid(
      `whereby:attendance:${binding.connectionId}:${pair.meetingId}:${pair.roomSessionId ?? 'none'}:${binding.accountId}`,
    ),
    subject: Object.freeze({ kind: 'account' as const, id: binding.accountId }),
  };
  const data = Object.freeze({
    contentKey: binding.contentKey,
    contentVersion: binding.contentVersion,
    title: binding.title,
    medium: 'video' as const,
    progressBasisPoints: completed ? 10_000 as const : measuredBasisPoints,
    consumedSeconds,
  });
  const candidate = Object.freeze(completed
    ? { ...common, type: 'content.consumption.completed' as const, data: { ...data, progressBasisPoints: 10_000 as const } }
    : { ...common, type: 'content.consumption.progressed' as const, data });
  try {
    return parsePropertyPredatorExternalEvent(candidate);
  } catch {
    return fail('Whereby attendance projection failed the Lead 360 event contract');
  }
}

function outcomeSha256(result: WherebyWebinarIngestResult): string {
  return createHash('sha256').update(JSON.stringify({
    disposition: result.disposition,
    projectedEventId: result.projectedEvent?.id ?? null,
    projectedEventType: result.projectedEvent?.type ?? null,
  }), 'utf8').digest('hex');
}

/**
 * Converts a verified Whereby join/leave pair into the existing first-party
 * content-consumption event understood by Lead 360 and journey scoring.
 * There is deliberately no room-creation API, bearer token or outbound effect.
 */
export class WherebyWebinarIngestService {
  readonly #deps: WherebyWebinarIngestDependencies;

  constructor(dependencies: WherebyWebinarIngestDependencies) {
    if (!dependencies
        || dependencies.providerEffectsEnabled !== false
        || dependencies.emergencyPaused !== true
        || !CANONICAL_UUID.test(dependencies.workspaceId)
        || !CANONICAL_UUID.test(dependencies.connectionId)) {
      throw new WherebyWebinarBridgeError('Whereby webinar bridge must be dark and emergency-paused');
    }
    this.#deps = dependencies;
  }

  async ingest(event: VerifiedWherebyRoomEvent): Promise<WherebyWebinarIngestResult> {
    if (!isVerifiedWherebyRoomEvent(event)) {
      fail('Whereby event must be authenticated before ingestion');
    }
    const receiptClaim = Object.freeze({
      workspaceId: this.#deps.workspaceId,
      connectionId: this.#deps.connectionId,
      eventId: event.id,
      payloadSha256: event.rawBodySha256,
    });
    const claim = await this.#deps.receipts.claim(receiptClaim);
    if (!claim || typeof claim !== 'object' || typeof claim.disposition !== 'string') {
      fail('Whereby receipt store returned an invalid claim decision');
    }
    if (claim.disposition === 'conflict') {
      fail('Whereby event ID was reused with different payload bytes');
    }
    if (claim.disposition === 'replayed') return Object.freeze({ disposition: 'replayed' });
    if (claim.disposition === 'in_progress') {
      throw new WherebyWebinarRetryableError('Whereby event processing is already in progress');
    }
    if (claim.disposition !== 'claimed' || !SAFE_LEASE_TOKEN.test(claim.leaseToken)) {
      fail('Whereby receipt store returned an invalid claim decision');
    }
    const lease = Object.freeze({ ...receiptClaim, leaseToken: claim.leaseToken });
    let completionStarted = false;
    try {
      const result = await this.#processVerifiedEvent(event);
      completionStarted = true;
      const completion = await this.#deps.receipts.complete({
        ...lease,
        outcomeSha256: outcomeSha256(result),
      });
      if (completion !== 'completed') {
        throw new WherebyWebinarRetryableError('Whereby event receipt lease was lost before completion');
      }
      return result;
    } catch (error) {
      if (!completionStarted) {
        let release: 'released' | 'lost';
        try {
          release = await this.#deps.receipts.release(lease);
        } catch {
          throw new WherebyWebinarRetryableError('Whereby event receipt lease could not be released');
        }
        if (release !== 'released') {
          throw new WherebyWebinarRetryableError('Whereby event receipt lease was lost during rollback');
        }
      }
      throw error;
    }
  }

  async #processVerifiedEvent(
    event: VerifiedWherebyRoomEvent,
  ): Promise<WherebyWebinarIngestResult> {
    if (event.type === 'room.session.started' || event.type === 'room.session.ended') {
      return Object.freeze({ disposition: 'recorded' });
    }
    const participantId = event.data.participantId;
    const externalId = event.data.externalId;
    if (!participantId || !externalId) {
      return Object.freeze({ disposition: 'ignored_unbound' });
    }
    const rawBinding = await this.#deps.bindings.resolve({
      workspaceId: this.#deps.workspaceId,
      connectionId: this.#deps.connectionId,
      meetingId: event.data.meetingId,
      externalId,
    });
    if (!rawBinding) return Object.freeze({ disposition: 'ignored_unbound' });
    const binding = validateBinding(rawBinding);
    if (binding.workspaceId !== this.#deps.workspaceId
        || binding.connectionId !== this.#deps.connectionId) {
      fail('Whereby participant binding crossed the configured tenant boundary');
    }
    if (event.type === 'room.client.joined') {
      const mutation = validateAttendanceMutation(await this.#deps.attendance.recordJoin({
        workspaceId: binding.workspaceId,
        connectionId: binding.connectionId,
        meetingId: event.data.meetingId,
        roomSessionId: event.data.roomSessionId,
        participantId,
        externalId,
        eventId: event.id,
        joinedAt: event.createdAt,
      }), event, binding.workspaceId, binding.connectionId, externalId);
      if (mutation.disposition === 'pending') {
        fail('Whereby attendance store returned a leave-only state for a join event');
      }
      if (mutation.disposition === 'opened') {
        return Object.freeze({ disposition: 'attendance_opened' });
      }
      return this.#projectAttendance(event, binding, mutation.pair);
    }
    const mutation = validateAttendanceMutation(await this.#deps.attendance.recordLeave({
        workspaceId: binding.workspaceId,
        connectionId: binding.connectionId,
        meetingId: event.data.meetingId,
        roomSessionId: event.data.roomSessionId,
        participantId,
        externalId,
        eventId: event.id,
        leftAt: event.createdAt,
      }), event, binding.workspaceId, binding.connectionId, externalId);
    if (mutation.disposition === 'opened') {
      fail('Whereby attendance store returned a join-only state for a leave event');
    }
    if (mutation.disposition === 'pending') {
      return Object.freeze({ disposition: 'attendance_pending' });
    }
    return this.#projectAttendance(event, binding, mutation.pair);
  }

  async #projectAttendance(
    event: VerifiedWherebyRoomEvent,
    binding: WherebyParticipantBinding,
    pair: WherebyAttendancePair,
  ): Promise<WherebyWebinarIngestResult> {
    const projectedEvent = buildJourneyEvent(event, binding, pair);
    const outcome = await this.#deps.journeyEvents.record({
      workspaceId: binding.workspaceId,
      connectionId: binding.connectionId,
      event: projectedEvent,
    });
    if (outcome !== 'recorded' && outcome !== 'replayed') {
      fail('Whereby journey event sink returned an invalid result');
    }
    return Object.freeze({ disposition: 'projected', projectedEvent });
  }
}
