import type {
  InboxApprovalDecision,
  InboxConversationPage,
  InboxConversationSummary,
  InboxMessageLifecycle,
} from '../inbox-pg/types.js';
import { INBOX_COMPLETE_REVIEW_MAX_BODY_BYTES } from '../inbox-pg/limits.js';
import {
  isConversionInboxTestQueuePurpose,
  type ConversionInboxNoticeView,
} from './conversion-inbox-actions.js';
import type { ConversationChannel } from '../providers/contracts.js';

export const CONVERSION_INBOX_ROUTE = '/portal/inbox' as const;
export const CONVERSION_INBOX_MAX_CONVERSATIONS = 50;
export const CONVERSION_INBOX_MAX_MESSAGES = 80;
export const CONVERSION_INBOX_MAX_CONSENTS = 8;
export const CONVERSION_INBOX_MAX_QUERY_LENGTH = 80;
export const CONVERSION_INBOX_MAX_MESSAGE_BYTES = INBOX_COMPLETE_REVIEW_MAX_BODY_BYTES;

export type ConversionInboxChannelFilter = 'all' | ConversationChannel;
export type ConversionInboxQueueFilter = 'all' | 'unread' | 'approval' | 'open';
export type ConversionInboxConsentState =
  | 'permitted'
  | 'denied'
  | 'unknown'
  | 'withdrawn'
  | 'suppressed';
export type ConversionInboxApprovalState =
  | 'not_requested'
  | 'pending'
  | InboxApprovalDecision;
export type ConversionInboxDeliveryState =
  | 'not_queued'
  | 'queued'
  | 'accepted'
  | 'delivered'
  | 'read'
  | 'failed';
export type ConversionInboxRailActivityState =
  | 'queued'
  | 'accepted'
  | 'reconciled'
  | 'attention';

export interface ConversionInboxSignedInboundEvidenceSnapshot {
  readonly kind:
    | 'signed_simulator_event'
    | 'signed_mailgun_inbound'
    | 'signed_meta_whatsapp_inbound';
  readonly source:
    | 'whatsapp_simulator'
    | 'social_dm_simulator'
    | 'mailgun_eu'
    | 'meta_whatsapp_cloud';
  readonly network: 'email' | 'whatsapp' | 'facebook' | 'instagram';
  /** Opaque internal receipt UUID. No provider event/address data is exposed. */
  readonly receiptId: string;
  /** Server-side verification time, never a caller-asserted provider timestamp. */
  readonly verifiedAt: string;
}

export interface ConversionInboxFilterInput {
  readonly query?: unknown;
  readonly channel?: unknown;
  readonly queue?: unknown;
  readonly conversationId?: unknown;
}

export interface ConversionInboxFiltersView {
  readonly query: string;
  readonly channel: ConversionInboxChannelFilter;
  readonly queue: ConversionInboxQueueFilter;
}

export interface ConversionInboxTranscriptMessageSnapshot {
  readonly messageId: string;
  readonly direction: 'inbound' | 'outbound' | 'internal_note';
  readonly lifecycle: InboxMessageLifecycle;
  readonly authorLabel: string;
  readonly body: string;
  readonly occurredAt: string;
  readonly deliveryState?: ConversionInboxDeliveryState | null;
  /** Absent/null unless an immutable, message-linked TEST webhook receipt exists. */
  readonly inboundEvidence?: ConversionInboxSignedInboundEvidenceSnapshot | null;
}

export interface ConversionInboxConsentSnapshot {
  readonly channel: 'email' | 'sms' | 'whatsapp' | 'social';
  readonly state: ConversionInboxConsentState;
  readonly basis: string | null;
  readonly updatedAt: string | null;
}

export interface ConversionInboxLeadSnapshot {
  readonly contactId: string;
  readonly displayName: string;
  readonly companyName: string | null;
  readonly stageLabel: string;
  readonly score: number | null;
  readonly sourceLabel: string;
  readonly affiliateLabel: string | null;
  readonly nextMove: string | null;
}

export interface ConversionInboxDraftSnapshot {
  readonly messageId: string | null;
  readonly body: string;
  readonly lifecycle: Extract<InboxMessageLifecycle, 'draft' | 'approval_pending' | 'approved'>;
  readonly versionNumber: number | null;
  readonly approvalState: ConversionInboxApprovalState;
  readonly approvalNote: string | null;
  readonly deliveryState: ConversionInboxDeliveryState;
  readonly updatedAt: string | null;
  readonly rowVersion: number | null;
  readonly approvalRequestId: string | null;
  readonly purpose: string;
}

export interface ConversionInboxRailActivitySnapshot {
  /** Coarse operator state projected from durable TEST delivery/operation evidence. */
  readonly state: ConversionInboxRailActivityState;
  /** Opaque UUID used to correlate this TEST operation without exposing provider data. */
  readonly correlationId: string;
  readonly occurredAt: string;
}

export interface ConversionInboxAdminCallSnapshot {
  readonly taskId: string;
  readonly taskStatus: 'open' | 'completed';
  readonly taskPriority: 'normal' | 'high' | 'urgent';
  readonly taskTitle: string;
  readonly dueAt: string;
  readonly taskRowVersion: number;
  readonly outcome: string | null;
  readonly outcomeSummary: string | null;
  readonly outcomeAt: string | null;
  readonly nextTaskId: string | null;
  readonly nextTaskTitle: string | null;
  readonly nextTaskDueAt: string | null;
}

export interface ConversionInboxThreadSnapshot {
  readonly conversationId: string;
  readonly environment?: 'test' | 'live';
  readonly contactPointId: string | null;
  readonly messages: readonly ConversionInboxTranscriptMessageSnapshot[];
  readonly lead: ConversionInboxLeadSnapshot;
  readonly consents: readonly ConversionInboxConsentSnapshot[];
  readonly draft: ConversionInboxDraftSnapshot;
  readonly railActivity: ConversionInboxRailActivitySnapshot | null;
  readonly adminCall: ConversionInboxAdminCallSnapshot | null;
}

export interface ConversionInboxSnapshot {
  /** The canonical bounded queue returned by InboxReadService.listConversations(). */
  readonly page: InboxConversationPage;
  /** Deliberately separate until the inbox backend exposes its thread-detail read contract. */
  readonly threads: readonly ConversionInboxThreadSnapshot[];
}

export interface ConversionInboxQueueItemView extends InboxConversationSummary {
  readonly selected: boolean;
  readonly channelLabel: string;
  readonly stateLabel: string;
  readonly preview: string;
  readonly requiresApproval: boolean;
  readonly testProviderLabel: string;
}

export interface ConversionInboxTranscriptMessageView {
  readonly messageId: string;
  readonly direction: ConversionInboxTranscriptMessageSnapshot['direction'];
  readonly lifecycle: InboxMessageLifecycle;
  readonly authorLabel: string;
  readonly body: string;
  readonly bodyTruncated: boolean;
  readonly occurredAt: string;
  readonly deliveryState: ConversionInboxDeliveryState | null;
  readonly deliveryLabel: string | null;
  readonly inboundEvidence: ConversionInboxSignedInboundEvidenceView | null;
}

export interface ConversionInboxSignedInboundEvidenceView
  extends ConversionInboxSignedInboundEvidenceSnapshot {
  readonly label:
    | 'Signed TEST inbound'
    | 'Signed Mailgun inbound'
    | 'Signed Meta inbound';
  readonly networkLabel: 'Email' | 'WhatsApp' | 'Facebook' | 'Instagram';
  readonly networkCode: 'EM' | 'WA' | 'FB' | 'IG';
  readonly receiptLabel: string;
  readonly accessibleLabel: string;
}

export interface ConversionInboxConsentView extends ConversionInboxConsentSnapshot {
  readonly channelLabel: string;
  readonly stateLabel: string;
  readonly allowsQueueing: boolean;
}

export interface ConversionInboxDraftView extends ConversionInboxDraftSnapshot {
  readonly bodyTruncated: boolean;
  readonly approvalLabel: string;
  readonly deliveryLabel: string;
  readonly exactApproval: boolean;
  readonly consentAllowsQueueing: boolean;
  readonly mayQueueTestOperation: boolean;
  readonly gateDetail: string;
}

export interface ConversionInboxRailActivityView extends ConversionInboxRailActivitySnapshot {
  readonly label: string;
  readonly detail: string;
  readonly correlationLabel: string;
}

export interface ConversionInboxSelectedThreadView {
  readonly summary: ConversionInboxQueueItemView;
  readonly contactPointId: string | null;
  readonly lead: ConversionInboxLeadSnapshot;
  readonly messages: readonly ConversionInboxTranscriptMessageView[];
  readonly transcriptTruncated: boolean;
  readonly consents: readonly ConversionInboxConsentView[];
  readonly draft: ConversionInboxDraftView;
  readonly railActivity: ConversionInboxRailActivityView | null;
  readonly adminCall: ConversionInboxAdminCallSnapshot | null;
}

export interface ConversionInboxChannelMetricView {
  readonly channel: ConversionInboxChannelFilter;
  readonly label: string;
  readonly count: number;
  readonly selected: boolean;
}

export interface ConversionInboxView {
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly timezone: string;
  readonly asOf: string;
  readonly canWrite: boolean;
  readonly canManage: boolean;
  readonly filters: ConversionInboxFiltersView;
  readonly channels: readonly ConversionInboxChannelMetricView[];
  readonly conversations: readonly ConversionInboxQueueItemView[];
  readonly loadedConversationCount: number;
  readonly matchingConversationCount: number;
  readonly totalUnreadCount: number;
  readonly selectedThread: ConversionInboxSelectedThreadView | null;
  readonly inputTruncated: boolean;
  readonly hasMore: boolean;
  readonly notice?: ConversionInboxNoticeView;
}

export interface PresentConversionInboxOptions {
  readonly workspaceName: string;
  readonly filters?: ConversionInboxFilterInput;
  readonly notice?: ConversionInboxNoticeView;
}

const CHANNELS = new Set<ConversionInboxChannelFilter>([
  'all', 'email', 'whatsapp', 'sms', 'instagram', 'facebook',
]);
const QUEUES = new Set<ConversionInboxQueueFilter>(['all', 'unread', 'approval', 'open']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CANONICAL_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const CHANNEL_LABELS: Readonly<Record<ConversationChannel, string>> = Object.freeze({
  email: 'Email',
  whatsapp: 'WhatsApp',
  sms: 'SMS',
  instagram: 'Instagram',
  facebook: 'Facebook',
});
const CONSENT_LABELS: Readonly<Record<ConversionInboxConsentSnapshot['channel'], string>> = Object.freeze({
  email: 'Email',
  sms: 'SMS',
  whatsapp: 'WhatsApp',
  social: 'Social messaging',
});
const CONSENT_STATE_LABELS: Readonly<Record<ConversionInboxConsentState, string>> = Object.freeze({
  permitted: 'Permitted for this purpose',
  denied: 'Denied',
  unknown: 'Not established',
  withdrawn: 'Withdrawn',
  suppressed: 'Suppressed',
});
const APPROVAL_LABELS: Readonly<Record<ConversionInboxApprovalState, string>> = Object.freeze({
  not_requested: 'Draft not submitted',
  pending: 'Approval pending',
  approved: 'Exact version approved',
  rejected: 'Rejected',
  changes_requested: 'Changes requested',
});

function boundedString(value: unknown, maximum: number): string {
  return typeof value === 'string' ? [...value.trim()].slice(0, maximum).join('') : '';
}

function utf8Prefix(value: string, maximumBytes: number): Readonly<{ value: string; truncated: boolean }> {
  if (Buffer.byteLength(value, 'utf8') <= maximumBytes) return Object.freeze({ value, truncated: false });
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle), 'utf8') <= maximumBytes) low = middle;
    else high = middle - 1;
  }
  let end = low;
  const code = value.charCodeAt(end - 1);
  if (end > 0 && code >= 0xd800 && code <= 0xdbff) end -= 1;
  return Object.freeze({ value: value.slice(0, end), truncated: true });
}

export function normaliseConversionInboxFilters(
  input: ConversionInboxFilterInput = {},
): ConversionInboxFiltersView {
  const channel = typeof input.channel === 'string'
    && CHANNELS.has(input.channel as ConversionInboxChannelFilter)
    ? input.channel as ConversionInboxChannelFilter : 'all';
  const queue = typeof input.queue === 'string'
    && QUEUES.has(input.queue as ConversionInboxQueueFilter)
    ? input.queue as ConversionInboxQueueFilter : 'all';
  return Object.freeze({
    query: boundedString(input.query, CONVERSION_INBOX_MAX_QUERY_LENGTH),
    channel,
    queue,
  });
}

function stateLabel(state: InboxConversationSummary['state']): string {
  if (state === 'open') return 'Open';
  if (state === 'snoozed') return 'Snoozed';
  if (state === 'closed') return 'Closed';
  return 'Quarantined';
}

function needsApproval(thread: ConversionInboxThreadSnapshot | undefined): boolean {
  return thread?.draft.approvalState === 'pending'
    || thread?.draft.approvalState === 'changes_requested';
}

function queueItem(
  summary: InboxConversationSummary,
  selectedId: string | null,
  thread: ConversionInboxThreadSnapshot | undefined,
): ConversionInboxQueueItemView {
  const latest = summary.latestMessage?.body ?? summary.subject ?? 'No preview available';
  const preview = utf8Prefix(latest.replace(/\s+/g, ' ').trim(), 240);
  return Object.freeze({
    ...summary,
    selected: summary.conversationId === selectedId,
    channelLabel: CHANNEL_LABELS[summary.channel],
    stateLabel: stateLabel(summary.state),
    preview: `${preview.value}${preview.truncated ? '…' : ''}`,
    requiresApproval: thread === undefined ? summary.requiresApproval : needsApproval(thread),
    testProviderLabel: summary.environment === 'live'
      ? `${CHANNEL_LABELS[summary.channel]} · LIVE OWNED-OFFICE PROOF`
      : `${CHANNEL_LABELS[summary.channel]} · TEST / SIMULATED`,
  });
}

function matches(
  item: ConversionInboxQueueItemView,
  filters: ConversionInboxFiltersView,
): boolean {
  if (filters.channel !== 'all' && item.channel !== filters.channel) return false;
  if (filters.queue === 'unread' && item.unreadCount === 0) return false;
  if (filters.queue === 'approval' && !item.requiresApproval) return false;
  if (filters.queue === 'open' && item.state !== 'open') return false;
  if (!filters.query) return true;
  const needle = filters.query.toLocaleLowerCase('en-GB');
  return [item.contactName, item.subject, item.preview, item.channelLabel]
    .filter((value): value is string => typeof value === 'string')
    .some((value) => value.toLocaleLowerCase('en-GB').includes(needle));
}

function deliveryLabel(
  state: ConversionInboxDeliveryState,
  environment: 'test' | 'live' = 'test',
): string {
  if (environment === 'live') {
    if (state === 'not_queued') return 'Not queued';
    if (state === 'queued') return 'Durably queued';
    if (state === 'accepted') return 'Provider accepted';
    if (state === 'delivered') return 'Signed delivery receipt';
    if (state === 'read') return 'Signed read receipt';
    return 'Delivery needs attention';
  }
  if (state === 'not_queued') return 'Not queued';
  if (state === 'queued') return 'TEST queue only';
  if (state === 'accepted') return 'SIMULATED accepted';
  if (state === 'delivered') return 'SIMULATED delivered';
  if (state === 'read') return 'SIMULATED read';
  return 'SIMULATED failed';
}

function signedInboundEvidence(
  message: ConversionInboxTranscriptMessageSnapshot,
): ConversionInboxSignedInboundEvidenceView | null {
  const evidence = message.inboundEvidence;
  if (!evidence || message.direction !== 'inbound' || message.lifecycle !== 'received'
      || !UUID.test(evidence.receiptId)
      || !CANONICAL_UTC.test(evidence.verifiedAt)
      || !Number.isFinite(Date.parse(evidence.verifiedAt))
      || new Date(evidence.verifiedAt).toISOString() !== evidence.verifiedAt) return null;
  const expectedSource = evidence.network === 'email'
    ? 'mailgun_eu'
    : evidence.network === 'whatsapp'
    ? evidence.kind === 'signed_meta_whatsapp_inbound'
      ? 'meta_whatsapp_cloud'
      : 'whatsapp_simulator'
    : evidence.network === 'facebook' || evidence.network === 'instagram'
      ? 'social_dm_simulator' : null;
  if (expectedSource === null || evidence.source !== expectedSource) return null;
  const expectedKind = evidence.network === 'email'
    ? 'signed_mailgun_inbound'
    : evidence.source === 'meta_whatsapp_cloud'
      ? 'signed_meta_whatsapp_inbound'
      : 'signed_simulator_event';
  if (evidence.kind !== expectedKind) return null;
  const networkLabel = evidence.network === 'email' ? 'Email'
    : evidence.network === 'whatsapp' ? 'WhatsApp'
    : evidence.network === 'facebook' ? 'Facebook' : 'Instagram';
  const networkCode = evidence.network === 'email' ? 'EM'
    : evidence.network === 'whatsapp' ? 'WA'
    : evidence.network === 'facebook' ? 'FB' : 'IG';
  const receiptId = evidence.receiptId.toLowerCase();
  return Object.freeze({
    kind: evidence.kind,
    source: evidence.source,
    network: evidence.network,
    receiptId,
    verifiedAt: evidence.verifiedAt,
    label: evidence.kind === 'signed_mailgun_inbound'
      ? 'Signed Mailgun inbound'
      : evidence.kind === 'signed_meta_whatsapp_inbound'
        ? 'Signed Meta inbound'
        : 'Signed TEST inbound',
    networkLabel,
    networkCode,
    receiptLabel: `${evidence.kind === 'signed_mailgun_inbound'
      ? 'MAIL IN'
      : evidence.kind === 'signed_meta_whatsapp_inbound'
        ? 'META IN'
        : 'TEST IN'} ${receiptId.slice(0, 8)}…${receiptId.slice(-4)}`,
    accessibleLabel: evidence.kind === 'signed_mailgun_inbound'
      ? 'Signed Mailgun email reply from the controlled owned-office proof. An admin call task was created.'
      : evidence.kind === 'signed_meta_whatsapp_inbound'
        ? 'Signed Meta WhatsApp inbound message projected into the canonical Conversion Inbox and Lead 360. An admin call task was created.'
      : `Signed simulated ${networkLabel} inbound event. Non-routable test only; no live account connected.`,
  });
}

function transcriptMessage(
  message: ConversionInboxTranscriptMessageSnapshot,
  environment: 'test' | 'live',
): ConversionInboxTranscriptMessageView {
  const body = utf8Prefix(message.body, CONVERSION_INBOX_MAX_MESSAGE_BYTES);
  const state = message.deliveryState ?? null;
  return Object.freeze({
    ...message,
    authorLabel: utf8Prefix(message.authorLabel, 512).value,
    body: body.value,
    bodyTruncated: body.truncated,
    deliveryState: state,
    deliveryLabel: state === null ? null : deliveryLabel(state, environment),
    inboundEvidence: signedInboundEvidence(message),
  });
}

function consentView(consent: ConversionInboxConsentSnapshot): ConversionInboxConsentView {
  return Object.freeze({
    ...consent,
    basis: consent.basis === null ? null : utf8Prefix(consent.basis, 2_048).value,
    channelLabel: CONSENT_LABELS[consent.channel],
    stateLabel: CONSENT_STATE_LABELS[consent.state],
    allowsQueueing: consent.state === 'permitted',
  });
}

function draftView(
  draft: ConversionInboxDraftSnapshot,
  consents: readonly ConversionInboxConsentView[],
  summary: InboxConversationSummary,
): ConversionInboxDraftView {
  const consentChannel = summary.channel === 'instagram' || summary.channel === 'facebook'
    ? 'social' : summary.channel;
  const relevantConsent = consents.find((consent) => consent.channel === consentChannel);
  const messageId = draft.messageId && UUID.test(draft.messageId) ? draft.messageId.toLowerCase() : null;
  const approvalRequestId = draft.approvalRequestId && UUID.test(draft.approvalRequestId)
    ? draft.approvalRequestId.toLowerCase() : null;
  const rowVersion = typeof draft.rowVersion === 'number' && Number.isSafeInteger(draft.rowVersion)
    && draft.rowVersion > 0 ? draft.rowVersion : null;
  const exactApproval = draft.lifecycle === 'approved' && draft.approvalState === 'approved'
    && draft.versionNumber !== null && Number.isSafeInteger(draft.versionNumber)
    && draft.versionNumber > 0 && messageId !== null;
  const consentAllowsQueueing = relevantConsent?.allowsQueueing === true;
  const purposeAllowsQueueing = isConversionInboxTestQueuePurpose(draft.purpose);
  const body = utf8Prefix(draft.body, CONVERSION_INBOX_MAX_MESSAGE_BYTES);
  const environment = summary.environment ?? 'test';
  const mayQueueTestOperation = environment === 'test' && exactApproval && consentAllowsQueueing
    && purposeAllowsQueueing && !body.truncated && draft.deliveryState === 'not_queued';
  let gateDetail = body.truncated
    ? 'The complete draft is outside the safe review display boundary. Approval and queueing are locked.'
    : 'An exact immutable draft approval is required.';
  if (!body.truncated && exactApproval && !consentAllowsQueueing) {
    gateDetail = 'Current channel consent does not permit queueing.';
  } else if (!body.truncated && exactApproval && !purposeAllowsQueueing) {
    gateDetail = 'This message purpose is not approved for the TEST queue.';
  } else if (mayQueueTestOperation) {
    gateDetail = 'Eligible for the TEST queue only. No live provider is connected.';
  } else if (!body.truncated && exactApproval && consentAllowsQueueing) {
    gateDetail = 'A TEST/SIMULATED operation already records this draft state.';
  }
  if (environment === 'live') {
    gateDetail = draft.deliveryState === 'not_queued'
      ? exactApproval && consentAllowsQueueing
        ? 'The exact live reply is approved and consent-evidenced. Provider authorization remains a separate server-side command.'
        : 'Live reply authorization remains blocked until the exact approval and current channel evidence agree.'
      : 'This live reply state comes from its durable operation and receipt evidence.';
  }
  return Object.freeze({
    ...draft,
    messageId,
    approvalRequestId,
    rowVersion,
    purpose: utf8Prefix(draft.purpose.trim(), 100).value,
    body: body.value,
    bodyTruncated: body.truncated,
    approvalNote: draft.approvalNote === null
      ? null : utf8Prefix(draft.approvalNote, 2_048).value,
    approvalLabel: APPROVAL_LABELS[draft.approvalState],
    deliveryLabel: deliveryLabel(draft.deliveryState, environment),
    exactApproval,
    consentAllowsQueueing,
    mayQueueTestOperation,
    gateDetail,
  });
}

function railActivityView(
  activity: ConversionInboxRailActivitySnapshot | null,
  environment: 'test' | 'live',
): ConversionInboxRailActivityView | null {
  if (activity === null || !UUID.test(activity.correlationId)) return null;
  const occurredAt = new Date(activity.occurredAt);
  if (!Number.isFinite(occurredAt.getTime())) return null;
  const correlationId = activity.correlationId.toLowerCase();
  const labels: Readonly<Record<ConversionInboxRailActivityState, string>> = Object.freeze({
    queued: environment === 'live' ? 'Durably queued' : 'Queued for simulator',
    accepted: environment === 'live' ? 'Provider accepted' : 'Simulator accepted',
    reconciled: 'Reconciled',
    attention: 'Needs attention',
  });
  const details: Readonly<Record<ConversionInboxRailActivityState, string>> = Object.freeze({
    queued: environment === 'live'
      ? 'The permission-bound job is waiting behind its durable calling fence.'
      : 'Waiting for the non-routable TEST worker.',
    accepted: environment === 'live'
      ? 'The provider acceptance is durably recorded; final receipt remains separate.'
      : 'A simulator response is durably recorded.',
    reconciled: environment === 'live'
      ? 'A signed provider outcome was reconciled and durably recorded.'
      : 'The TEST outcome was reconciled and durably recorded.',
    attention: environment === 'live'
      ? 'The live job is quarantined for an operator decision; it will not retry blindly.'
      : 'The TEST operation needs an operator decision.',
  });
  if (!Object.hasOwn(labels, activity.state)) return null;
  return Object.freeze({
    state: activity.state,
    correlationId,
    occurredAt: occurredAt.toISOString(),
    label: labels[activity.state],
    detail: details[activity.state],
    correlationLabel: `${environment === 'live' ? 'LIVE' : 'TEST'} ${correlationId.slice(0, 8)}…${correlationId.slice(-4)}`,
  });
}

function selectedThread(
  summary: ConversionInboxQueueItemView,
  snapshot: ConversionInboxThreadSnapshot,
): ConversionInboxSelectedThreadView {
  const sourceMessages = snapshot.messages.slice(-CONVERSION_INBOX_MAX_MESSAGES);
  const environment = summary.environment ?? 'test';
  const consents = Object.freeze(snapshot.consents.slice(0, CONVERSION_INBOX_MAX_CONSENTS).map(consentView));
  const boundedLead: ConversionInboxLeadSnapshot = Object.freeze({
    ...snapshot.lead,
    displayName: utf8Prefix(snapshot.lead.displayName, 512).value,
    companyName: snapshot.lead.companyName === null
      ? null : utf8Prefix(snapshot.lead.companyName, 512).value,
    stageLabel: utf8Prefix(snapshot.lead.stageLabel, 256).value,
    score: snapshot.lead.score !== null && Number.isFinite(snapshot.lead.score)
      ? snapshot.lead.score : null,
    sourceLabel: utf8Prefix(snapshot.lead.sourceLabel, 512).value,
    affiliateLabel: snapshot.lead.affiliateLabel === null
      ? null : utf8Prefix(snapshot.lead.affiliateLabel, 512).value,
    nextMove: snapshot.lead.nextMove === null
      ? null : utf8Prefix(snapshot.lead.nextMove, 2_048).value,
  });
  return Object.freeze({
    summary,
    contactPointId: snapshot.contactPointId && UUID.test(snapshot.contactPointId)
      ? snapshot.contactPointId.toLowerCase() : null,
    lead: boundedLead,
    messages: Object.freeze(sourceMessages.map((message) => transcriptMessage(message, environment))),
    transcriptTruncated: snapshot.messages.length > sourceMessages.length,
    consents,
    draft: draftView(snapshot.draft, consents, summary),
    railActivity: railActivityView(snapshot.railActivity, environment),
    adminCall: snapshot.adminCall,
  });
}

export function presentConversionInbox(
  snapshot: ConversionInboxSnapshot,
  options: PresentConversionInboxOptions,
): ConversionInboxView {
  const filters = normaliseConversionInboxFilters(options.filters);
  const inputTruncated = snapshot.page.conversations.length > CONVERSION_INBOX_MAX_CONVERSATIONS;
  const bounded = snapshot.page.conversations.slice(0, CONVERSION_INBOX_MAX_CONVERSATIONS);
  const threads = new Map(snapshot.threads.map((thread) => [thread.conversationId, thread]));
  const unselectedItems = bounded.map((summary) => queueItem(
    summary, null, threads.get(summary.conversationId),
  ));
  const matchingItems = unselectedItems.filter((item) => matches(item, filters));
  const requestedId = matchingItems.some((item) => item.conversationId === options.filters?.conversationId)
    ? String(options.filters?.conversationId) : null;
  const firstMatchingId = matchingItems[0]?.conversationId ?? null;
  const selectedId = requestedId ?? firstMatchingId;
  const loadedItems = bounded.map((summary) => queueItem(
    summary, selectedId, threads.get(summary.conversationId),
  ));
  const conversations = loadedItems.filter((item) => matches(item, filters));
  const selectedSummary = loadedItems.find((item) => item.conversationId === selectedId) ?? null;
  const selectedSnapshot = selectedId ? threads.get(selectedId) : undefined;
  const selected = selectedSummary && selectedSnapshot
    && selectedSummary.contactId !== null
    && selectedSnapshot.lead.contactId === selectedSummary.contactId
    ? selectedThread(selectedSummary, selectedSnapshot) : null;
  const channelOrder: readonly ConversionInboxChannelFilter[] = [
    'all', 'email', 'whatsapp', 'sms', 'instagram', 'facebook',
  ];
  const channels = channelOrder.map((channel) => Object.freeze({
    channel,
    label: channel === 'all' ? 'All channels' : CHANNEL_LABELS[channel],
    count: channel === 'all' ? loadedItems.length
      : loadedItems.filter((item) => item.channel === channel).length,
    selected: filters.channel === channel,
  }));
  return Object.freeze({
    workspaceId: snapshot.page.workspaceId,
    workspaceName: options.workspaceName,
    timezone: snapshot.page.timezone,
    asOf: snapshot.page.asOf,
    canWrite: snapshot.page.canWrite,
    canManage: snapshot.page.canManage,
    filters,
    channels: Object.freeze(channels),
    conversations: Object.freeze(conversations),
    loadedConversationCount: loadedItems.length,
    matchingConversationCount: conversations.length,
    totalUnreadCount: loadedItems.reduce((total, item) => total + item.unreadCount, 0),
    selectedThread: selected,
    inputTruncated,
    hasMore: snapshot.page.nextCursor !== null || inputTruncated,
    ...(options.notice ? { notice: options.notice } : {}),
  });
}
