import { createHash } from 'node:crypto';
import type { Lead360EvidenceRead } from '../conversion-pg/lead-360-read-model.js';
import { INBOX_DATABASE_MAX_BODY_BYTES } from '../inbox-pg/limits.js';
import type { InboxConversationSummary } from '../inbox-pg/types.js';
import type {
  ZernioCommentSnapshot,
  ZernioMessageSnapshot,
} from '../public-social-outbound/zernio-messaging-client.js';
import type {
  ConversionInboxLeadSnapshot,
  ConversionInboxThreadSnapshot,
} from './conversion-inbox-presenter.js';
import type { PortalZernioMessagingSnapshot } from './zernio-messaging-service.js';

export const ZERNIO_INBOUND_RECONCILIATION_CONTRACT =
  'propertypredator.zernio-inbound-reconciliation/v1' as const;
export const ZERNIO_INBOUND_FIXTURE_ATTESTATION =
  'fixture-only:no-provider-call:no-production-write' as const;

const MAX_SNAPSHOTS = 60;
const MAX_EVENTS = 240;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CANONICAL_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

type SuccessfulZernioSnapshot = Extract<PortalZernioMessagingSnapshot, { ok: true }>;
export type ZernioInboundNetwork = 'instagram' | 'linkedin';
export type ZernioInboundKind = 'instagram_dm' | 'owned_post_comment';
export type ZernioInboundReconciliationBlocker =
  | 'history_truncated'
  | 'queue_truncated'
  | 'unmatched_person'
  | 'provider_event_conflict'
  | 'invalid_provider_binding'
  | 'empty_inbound_body';

export interface ZernioInboundPersonEvidence {
  readonly provider: 'zernio';
  readonly network: ZernioInboundNetwork;
  readonly accountId: string;
  readonly providerPersonId: string;
  readonly displayName: string;
  readonly username: string | null;
  readonly identityKeySha256: string;
}

/**
 * The provider adapter proves an external identity; the CRM boundary decides
 * which canonical person owns it. The reconciler never invents or auto-merges
 * a person and cannot create a lead by itself.
 */
export interface ZernioInboundCanonicalPersonLink {
  readonly contactId: string;
  readonly contactPointId: string;
  readonly displayName: string;
  readonly companyName: string | null;
  readonly stageLabel: string;
  readonly score: number | null;
  readonly sourceLabel: string;
  readonly affiliateLabel: string | null;
  readonly nextMove: string | null;
  /** Present only when this person is already linked to an outreach attempt. */
  readonly outreachAttemptReceiptId: string | null;
}

export interface ZernioInboundPersonResolver {
  resolve(
    evidence: ZernioInboundPersonEvidence,
  ): Promise<ZernioInboundCanonicalPersonLink | null>;
}

export interface ZernioInboundQuarantineRecord {
  readonly blocker: Exclude<
    ZernioInboundReconciliationBlocker,
    | 'history_truncated'
    | 'queue_truncated'
  >;
  readonly network: ZernioInboundNetwork;
  readonly inboundKind: ZernioInboundKind;
  readonly providerEventIdSha256: string;
  readonly identityKeySha256: string | null;
}

export interface ZernioInboundOutreachResponseProjection {
  readonly contactId: string;
  readonly attemptReceiptId: string | null;
  readonly responseEventSha256: string;
  readonly outcome: 'replied';
  readonly disposition: 'ready_for_command' | 'unlinked';
  readonly providerEffects: false;
}

/**
 * Conversion Inbox preserves the real Instagram or LinkedIn network. LinkedIn
 * is surfaced only as a read-only canonical conversation and never relabelled
 * as another network or made outbound-capable by this fixture adapter.
 */
export interface ZernioInboundConversationSummary
  extends Omit<InboxConversationSummary, 'channel'> {
  readonly channel: ZernioInboundNetwork;
  readonly provider: 'zernio';
  readonly inboundKind: ZernioInboundKind;
  readonly channelCompatibility:
    | 'conversion_inbox_native'
    | 'conversion_inbox_read_only';
}

export interface ZernioInboundThreadProjection {
  readonly sourceEventSha256s: readonly string[];
  readonly conversation: ZernioInboundConversationSummary;
  readonly thread: ConversionInboxThreadSnapshot;
  readonly lead360Evidence: readonly Lead360EvidenceRead[];
  readonly outreachResponses: readonly ZernioInboundOutreachResponseProjection[];
}

export interface ZernioInboundReconciliationBatch {
  readonly contract: typeof ZERNIO_INBOUND_RECONCILIATION_CONTRACT;
  readonly fixtureAttestation: typeof ZERNIO_INBOUND_FIXTURE_ATTESTATION;
  readonly provider: 'zernio';
  readonly environment: 'test';
  readonly providerEffects: false;
  readonly checkedAt: string;
  readonly coverage: 'complete' | 'partial';
  readonly blockers: readonly ZernioInboundReconciliationBlocker[];
  readonly threads: readonly ZernioInboundThreadProjection[];
  readonly quarantine: readonly ZernioInboundQuarantineRecord[];
  readonly acceptedEventCount: number;
  readonly duplicateReplayCount: number;
}

export class ZernioInboundReconciliationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZernioInboundReconciliationError';
  }
}

interface CandidateEvent {
  readonly inboundKind: ZernioInboundKind;
  readonly network: ZernioInboundNetwork;
  readonly accountId: string;
  readonly providerThreadId: string;
  readonly providerEventId: string;
  readonly providerPersonId: string;
  readonly providerDisplayName: string;
  readonly providerUsername: string | null;
  readonly body: string;
  readonly occurredAt: string;
  readonly checkedAt: string;
}

interface AcceptedEvent extends CandidateEvent {
  readonly person: ZernioInboundCanonicalPersonLink;
  readonly identityKeySha256: string;
  readonly sourceEventSha256: string;
}

function fail(message: string): never {
  throw new ZernioInboundReconciliationError(message);
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function canonical(values: readonly string[]): string {
  return values.map((value) => `${Buffer.byteLength(value, 'utf8')}:${value}`).join('|');
}

function deterministicUuid(namespace: string, value: string): string {
  const bytes = Buffer.from(sha256(canonical([namespace, value])).slice(0, 32), 'hex');
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function timestamp(value: string, label: string): string {
  if (!CANONICAL_UTC.test(value) || !Number.isFinite(new Date(value).getTime())) {
    return fail(`${label} must be a canonical UTC timestamp`);
  }
  return value;
}

function uuid(value: string, label: string): string {
  if (!UUID.test(value)) return fail(`${label} must be a canonical UUID`);
  return value.toLowerCase();
}

function validBody(value: string): boolean {
  return value.length > 0
    && !value.includes('\u0000')
    && Buffer.byteLength(value, 'utf8') <= INBOX_DATABASE_MAX_BODY_BYTES;
}

function identityEvidence(candidate: CandidateEvent): ZernioInboundPersonEvidence {
  const identityKeySha256 = sha256(canonical([
    'zernio-person-v1', candidate.network, candidate.accountId, candidate.providerPersonId,
  ]));
  return Object.freeze({
    provider: 'zernio' as const,
    network: candidate.network,
    accountId: candidate.accountId,
    providerPersonId: candidate.providerPersonId,
    displayName: candidate.providerDisplayName,
    username: candidate.providerUsername,
    identityKeySha256,
  });
}

function eventDigest(candidate: CandidateEvent): string {
  return sha256(canonical([
    'zernio-inbound-event-v1', candidate.inboundKind, candidate.network,
    candidate.accountId, candidate.providerThreadId, candidate.providerEventId,
    candidate.providerPersonId, candidate.body, candidate.occurredAt,
  ]));
}

function eventIdentity(candidate: CandidateEvent): string {
  return canonical([
    candidate.inboundKind, candidate.network, candidate.accountId, candidate.providerEventId,
  ]);
}

function dmCandidates(snapshot: SuccessfulZernioSnapshot): readonly CandidateEvent[] {
  const conversation = snapshot.selectedConversation;
  if (!conversation) return Object.freeze([]);
  if (conversation.platform !== 'instagram') {
    return fail('Zernio DM reconciliation received an unsupported network');
  }
  return Object.freeze(snapshot.messages
    .filter((message) => message.direction === 'incoming')
    .map((message: ZernioMessageSnapshot): CandidateEvent => {
      if (message.platform !== 'instagram'
          || message.accountId !== conversation.accountId
          || message.providerConversationId !== conversation.providerConversationId
          || message.senderId !== conversation.participantId) {
        return fail('Zernio DM reconciliation received a mismatched provider binding');
      }
      return Object.freeze({
        inboundKind: 'instagram_dm' as const,
        network: 'instagram' as const,
        accountId: message.accountId,
        providerThreadId: message.providerConversationId,
        providerEventId: message.providerMessageId,
        providerPersonId: message.senderId,
        providerDisplayName: message.senderName,
        providerUsername: null,
        body: message.body,
        occurredAt: timestamp(message.occurredAt, 'Zernio DM occurredAt'),
        checkedAt: timestamp(snapshot.checkedAt, 'Zernio DM checkedAt'),
      });
    }));
}

function flattenComments(comments: readonly ZernioCommentSnapshot[]): readonly ZernioCommentSnapshot[] {
  const flattened: ZernioCommentSnapshot[] = [];
  const visit = (items: readonly ZernioCommentSnapshot[]): void => {
    for (const item of items) {
      flattened.push(item);
      visit(item.replies);
    }
  };
  visit(comments);
  return Object.freeze(flattened);
}

function commentCandidates(snapshot: SuccessfulZernioSnapshot): readonly CandidateEvent[] {
  const post = snapshot.selectedCommentPost;
  if (!post) return Object.freeze([]);
  return Object.freeze(flattenComments(snapshot.comments)
    .filter((comment) => !comment.author.isOwner)
    .map((comment): CandidateEvent => {
      if (comment.platform !== post.platform
          || comment.accountId !== post.accountId
          || comment.providerPostId !== post.providerPostId) {
        return fail('Zernio comment reconciliation received a mismatched provider binding');
      }
      return Object.freeze({
        inboundKind: 'owned_post_comment' as const,
        network: comment.platform,
        accountId: comment.accountId,
        providerThreadId: comment.providerPostId,
        providerEventId: comment.providerCommentId,
        providerPersonId: comment.author.providerAuthorId,
        providerDisplayName: comment.author.name,
        providerUsername: comment.author.username || null,
        body: comment.body,
        occurredAt: timestamp(comment.createdAt, 'Zernio comment createdAt'),
        checkedAt: timestamp(snapshot.checkedAt, 'Zernio comment checkedAt'),
      });
    }));
}

function leadSnapshot(person: ZernioInboundCanonicalPersonLink): ConversionInboxLeadSnapshot {
  return Object.freeze({
    contactId: person.contactId,
    displayName: person.displayName,
    companyName: person.companyName,
    stageLabel: person.stageLabel,
    score: person.score,
    sourceLabel: person.sourceLabel,
    affiliateLabel: person.affiliateLabel,
    nextMove: person.nextMove,
  });
}

function providerThreadKey(event: AcceptedEvent): string {
  return canonical([
    event.inboundKind, event.network, event.accountId,
    event.providerThreadId, event.person.contactId,
  ]);
}

function buildThread(events: readonly AcceptedEvent[]): ZernioInboundThreadProjection {
  const first = events[0] ?? fail('Cannot build an empty Zernio reconciliation thread');
  const ordered = [...events].sort((left, right) =>
    left.occurredAt.localeCompare(right.occurredAt)
      || left.sourceEventSha256.localeCompare(right.sourceEventSha256));
  const latest = ordered[ordered.length - 1]!;
  const conversationId = deterministicUuid('zernio-conversation-v1', providerThreadKey(first));
  const inboxId = deterministicUuid('zernio-inbox-v1', canonical([first.network, first.accountId]));
  const sourceEventSha256s = Object.freeze(ordered.map((event) => event.sourceEventSha256));
  const messages = Object.freeze(ordered.map((event) => Object.freeze({
    messageId: deterministicUuid('zernio-message-v1', event.sourceEventSha256),
    direction: 'inbound' as const,
    lifecycle: 'received' as const,
    authorLabel: event.providerDisplayName,
    body: event.body,
    occurredAt: event.occurredAt,
    deliveryState: null,
    // A polled fixture is not a signed Meta/WhatsApp receipt. Never badge it as one.
    inboundEvidence: null,
  })));
  const evidence = Object.freeze(ordered.map((event): Lead360EvidenceRead => Object.freeze({
    id: deterministicUuid('zernio-lead360-evidence-v1', event.sourceEventSha256),
    kind: 'reply' as const,
    title: event.inboundKind === 'instagram_dm'
      ? 'Instagram DM received'
      : `${event.network === 'linkedin' ? 'LinkedIn' : 'Instagram'} comment received`,
    detail: 'Provider-shaped fixture reconciled through the Zernio inbound boundary.',
    progressBasisPoints: null,
    occurredAt: event.occurredAt,
    sourceLabel: event.inboundKind === 'instagram_dm'
      ? 'Zernio · Instagram DM'
      : `Zernio · ${event.network === 'linkedin' ? 'LinkedIn' : 'Instagram'} comment`,
  })));
  const outreachResponses = Object.freeze(ordered.map((event) => Object.freeze({
    contactId: event.person.contactId,
    attemptReceiptId: event.person.outreachAttemptReceiptId,
    responseEventSha256: event.sourceEventSha256,
    outcome: 'replied' as const,
    disposition: event.person.outreachAttemptReceiptId
      ? 'ready_for_command' as const : 'unlinked' as const,
    providerEffects: false as const,
  })));
  const thread: ConversionInboxThreadSnapshot = Object.freeze({
    conversationId,
    environment: 'test' as const,
    contactPointId: first.person.contactPointId,
    messages,
    lead: leadSnapshot(first.person),
    consents: Object.freeze([Object.freeze({
      channel: 'social' as const,
      state: 'unknown' as const,
      basis: null,
      updatedAt: null,
    })]),
    draft: Object.freeze({
      messageId: null,
      body: '',
      lifecycle: 'draft' as const,
      versionNumber: null,
      approvalState: 'not_requested' as const,
      approvalNote: null,
      deliveryState: 'not_queued' as const,
      updatedAt: null,
      rowVersion: null,
      approvalRequestId: null,
      purpose: 'social_conversation_reply',
    }),
    railActivity: null,
    adminCall: null,
  });
  const conversation: ZernioInboundConversationSummary = Object.freeze({
    conversationId,
    inboxId,
    channel: first.network,
    environment: 'test' as const,
    state: 'open' as const,
    contactId: first.person.contactId,
    contactName: first.person.displayName,
    assignedUserId: null,
    assignedUserName: null,
    subject: first.inboundKind === 'instagram_dm'
      ? 'Instagram direct message'
      : `${first.network === 'linkedin' ? 'LinkedIn' : 'Instagram'} post comment`,
    unreadCount: ordered.length,
    requiresApproval: false,
    lastMessageAt: latest.occurredAt,
    latestMessage: Object.freeze({
      messageId: messages[messages.length - 1]!.messageId,
      direction: 'inbound' as const,
      lifecycle: 'received' as const,
      body: latest.body,
      occurredAt: latest.occurredAt,
    }),
    rowVersion: 1,
    provider: 'zernio' as const,
    inboundKind: first.inboundKind,
    channelCompatibility: first.network === 'linkedin'
      ? 'conversion_inbox_read_only' as const
      : 'conversion_inbox_native' as const,
  });
  return Object.freeze({
    sourceEventSha256s,
    conversation,
    thread,
    lead360Evidence: evidence,
    outreachResponses,
  });
}

function validatePerson(
  person: ZernioInboundCanonicalPersonLink,
): ZernioInboundCanonicalPersonLink {
  uuid(person.contactId, 'resolved contactId');
  uuid(person.contactPointId, 'resolved contactPointId');
  if (person.outreachAttemptReceiptId !== null) {
    uuid(person.outreachAttemptReceiptId, 'resolved outreachAttemptReceiptId');
  }
  if (!person.displayName || !person.stageLabel || !person.sourceLabel
      || (person.score !== null && (!Number.isSafeInteger(person.score) || person.score < 0))) {
    return fail('Resolved Zernio person link is invalid');
  }
  return person;
}

/**
 * Projects already-read, provider-shaped fixtures into the contracts consumed
 * by Conversion Inbox, Lead 360 and Daily Outreach. It has no provider client,
 * database pool, command service, send method or production environment input.
 */
export async function reconcileZernioInboundFixtures(
  input: Readonly<{
    fixtureAttestation: typeof ZERNIO_INBOUND_FIXTURE_ATTESTATION;
    snapshots: readonly SuccessfulZernioSnapshot[];
  }>,
  resolver: ZernioInboundPersonResolver,
): Promise<ZernioInboundReconciliationBatch> {
  if (input.fixtureAttestation !== ZERNIO_INBOUND_FIXTURE_ATTESTATION
      || !Array.isArray(input.snapshots)
      || input.snapshots.length < 1
      || input.snapshots.length > MAX_SNAPSHOTS
      || !resolver || typeof resolver.resolve !== 'function') {
    return fail('Zernio inbound fixture reconciliation input is invalid');
  }

  const blockers = new Set<ZernioInboundReconciliationBlocker>();
  const candidates: CandidateEvent[] = [];
  let checkedAt = '1970-01-01T00:00:00.000Z';
  for (const snapshot of input.snapshots) {
    if (snapshot.provider !== 'zernio' || snapshot.providerEffects !== false) {
      return fail('Zernio inbound reconciliation accepts effects-off snapshots only');
    }
    checkedAt = [checkedAt, timestamp(snapshot.checkedAt, 'Zernio snapshot checkedAt')]
      .sort().at(-1)!;
    if (snapshot.conversationHistoryTruncated) blockers.add('history_truncated');
    if (snapshot.queueTruncated) blockers.add('queue_truncated');
    candidates.push(...dmCandidates(snapshot), ...commentCandidates(snapshot));
    if (candidates.length > MAX_EVENTS) {
      return fail(`Zernio inbound reconciliation exceeds ${MAX_EVENTS} events`);
    }
  }

  const identityCache = new Map<string, Promise<ZernioInboundCanonicalPersonLink | null>>();
  const acceptedByIdentity = new Map<string, AcceptedEvent>();
  const eventContentByIdentity = new Map<string, string>();
  const quarantine: ZernioInboundQuarantineRecord[] = [];
  let duplicateReplayCount = 0;

  for (const candidate of candidates) {
    const evidence = identityEvidence(candidate);
    const providerEventIdSha256 = sha256(candidate.providerEventId);
    if (!validBody(candidate.body)) {
      blockers.add('empty_inbound_body');
      quarantine.push(Object.freeze({
        blocker: 'empty_inbound_body' as const,
        network: candidate.network,
        inboundKind: candidate.inboundKind,
        providerEventIdSha256,
        identityKeySha256: evidence.identityKeySha256,
      }));
      continue;
    }
    const eventKey = eventIdentity(candidate);
    const digest = eventDigest(candidate);
    const priorDigest = eventContentByIdentity.get(eventKey);
    if (priorDigest) {
      if (priorDigest === digest) {
        duplicateReplayCount += 1;
      } else {
        blockers.add('provider_event_conflict');
        quarantine.push(Object.freeze({
          blocker: 'provider_event_conflict' as const,
          network: candidate.network,
          inboundKind: candidate.inboundKind,
          providerEventIdSha256,
          identityKeySha256: evidence.identityKeySha256,
        }));
      }
      continue;
    }
    eventContentByIdentity.set(eventKey, digest);
    let pendingPerson = identityCache.get(evidence.identityKeySha256);
    if (!pendingPerson) {
      pendingPerson = resolver.resolve(evidence);
      identityCache.set(evidence.identityKeySha256, pendingPerson);
    }
    const person = await pendingPerson;
    if (!person) {
      blockers.add('unmatched_person');
      quarantine.push(Object.freeze({
        blocker: 'unmatched_person' as const,
        network: candidate.network,
        inboundKind: candidate.inboundKind,
        providerEventIdSha256,
        identityKeySha256: evidence.identityKeySha256,
      }));
      continue;
    }
    const accepted = Object.freeze({
      ...candidate,
      person: validatePerson(person),
      identityKeySha256: evidence.identityKeySha256,
      sourceEventSha256: digest,
    });
    acceptedByIdentity.set(eventKey, accepted);
  }

  const grouped = new Map<string, AcceptedEvent[]>();
  for (const event of acceptedByIdentity.values()) {
    const key = providerThreadKey(event);
    const threadEvents = grouped.get(key) ?? [];
    threadEvents.push(event);
    grouped.set(key, threadEvents);
  }
  const threads = Object.freeze([...grouped.values()].map((events) => buildThread(events))
    .sort((left, right) => {
      const leftAt = left.conversation.lastMessageAt ?? '';
      const rightAt = right.conversation.lastMessageAt ?? '';
      return rightAt.localeCompare(leftAt)
        || left.conversation.conversationId.localeCompare(right.conversation.conversationId);
    }));

  return Object.freeze({
    contract: ZERNIO_INBOUND_RECONCILIATION_CONTRACT,
    fixtureAttestation: ZERNIO_INBOUND_FIXTURE_ATTESTATION,
    provider: 'zernio' as const,
    environment: 'test' as const,
    providerEffects: false as const,
    checkedAt,
    coverage: blockers.has('history_truncated') || blockers.has('queue_truncated')
      ? 'partial' as const : 'complete' as const,
    blockers: Object.freeze([...blockers].sort()),
    threads,
    quarantine: Object.freeze(quarantine),
    acceptedEventCount: acceptedByIdentity.size,
    duplicateReplayCount,
  });
}
