import { createHash } from 'node:crypto';
import type {
  ZernioCommentedPostSnapshot,
  ZernioCommentPlatform,
  ZernioCommentSnapshot,
  ZernioConversationSnapshot,
  ZernioMessageSnapshot,
  ZernioMessagingClient,
} from '../public-social-outbound/zernio-messaging-client.js';
import { ZernioMessagingError } from '../public-social-outbound/zernio-messaging-client.js';
import type { PortalCrmRequestIdentity } from './crm-service.js';
import type { PortalZernioSocialConnectionService } from './zernio-social-connection-service.js';
import type {
  PgZernioMessagingReplyStore,
  ZernioReplyState,
  ZernioReplyStoreFailure,
} from './zernio-messaging-pg-store.js';

export const ZERNIO_MESSAGING_ROUTE = '/portal/inbox/social' as const;
export const ZERNIO_MESSAGING_DRAFT_ROUTE = '/portal/inbox/social/replies/draft' as const;
export const ZERNIO_MESSAGING_APPROVAL_REQUEST_ROUTE = '/portal/inbox/social/replies/request-approval' as const;
export const ZERNIO_MESSAGING_APPROVAL_DECISION_ROUTE = '/portal/inbox/social/replies/decide' as const;
export const ZERNIO_MESSAGING_SEND_ROUTE = '/portal/inbox/social/replies/send' as const;

export type PortalZernioMessagingFailureKind =
  | 'unauthenticated' | 'forbidden' | 'provider_unavailable' | 'unavailable';

export type PortalZernioMessagingReplyTarget = Readonly<{
  kind: 'dm';
  accountId: string;
  providerConversationId: string;
}> | Readonly<{
  kind: 'comment';
  accountId: string;
  platform: ZernioCommentPlatform;
  providerPostId: string;
  providerCommentId: string;
}>;

export type PortalZernioMessagingCommentSelection = Readonly<{
  accountId: string;
  platform: ZernioCommentPlatform;
  providerPostId: string;
  providerCommentId?: string;
}>;

export type PortalZernioMessagingSelection = Readonly<{
  providerConversationId?: string;
  comment?: PortalZernioMessagingCommentSelection;
}>;

export type PortalZernioMessagingSnapshot = Readonly<{
  ok: true;
  provider: 'zernio';
  providerEffects: false;
  outboundEffectsEnabled: boolean;
  emergencyPaused: boolean;
  checkedAt: string;
  conversations: readonly ZernioConversationSnapshot[];
  commentPosts: readonly ZernioCommentedPostSnapshot[];
  selectedConversation: ZernioConversationSnapshot | null;
  selectedCommentPost: ZernioCommentedPostSnapshot | null;
  selectedComment: ZernioCommentSnapshot | null;
  selectedTarget: PortalZernioMessagingReplyTarget | null;
  messages: readonly ZernioMessageSnapshot[];
  comments: readonly ZernioCommentSnapshot[];
  reply: ZernioReplyState | null;
  conversationHistoryTruncated: boolean;
  queueTruncated: boolean;
}> | Readonly<{
  ok: false;
  kind: PortalZernioMessagingFailureKind;
  providerEffects: false;
}>;

export interface PortalZernioMessagingService {
  snapshot(
    identity: PortalCrmRequestIdentity,
    input: PortalZernioMessagingSelection,
  ): Promise<PortalZernioMessagingSnapshot>;
  createDraft(identity: PortalCrmRequestIdentity, input: Readonly<{
    draftId: string; target: PortalZernioMessagingReplyTarget; body: string;
  }>): Promise<PortalZernioMessagingCommandResult>;
  requestApproval(identity: PortalCrmRequestIdentity, input: Readonly<{
    draftId: string; approvalRequestId: string;
  }>): Promise<PortalZernioMessagingCommandResult>;
  decideApproval(identity: PortalCrmRequestIdentity, input: Readonly<{
    approvalRequestId: string; decisionId: string; decision: 'approved' | 'rejected';
  }>): Promise<PortalZernioMessagingCommandResult>;
  sendApproved(identity: PortalCrmRequestIdentity, input: Readonly<{
    draftId: string; deliveryId: string; leaseToken: string;
    target: PortalZernioMessagingReplyTarget;
  }>): Promise<PortalZernioMessagingCommandResult>;
}

export type PortalZernioMessagingCommandResult = Readonly<{
  ok: true;
  disposition: 'created' | 'replayed' | 'requested' | 'approved' | 'rejected' | 'sent';
  providerEffects: 'none' | 'one_message_accepted';
}> | Readonly<{
  ok: false;
  kind: PortalZernioMessagingFailureKind | 'validation' | 'conflict'
    | 'outcome_unknown' | 'provider_rejected' | 'effects_disabled' | 'emergency_paused';
  providerEffects: 'none' | 'unknown';
}>;

type ReplyStore = Pick<PgZernioMessagingReplyStore,
  'read' | 'create' | 'requestApproval' | 'decide' | 'claim' | 'settle'>;

function commandFailure(
  kind: PortalZernioMessagingFailureKind | 'validation' | 'conflict'
    | 'outcome_unknown' | 'provider_rejected' | 'effects_disabled' | 'emergency_paused',
  providerEffects: 'none' | 'unknown' = 'none',
): PortalZernioMessagingCommandResult {
  return Object.freeze({ ok: false as const, kind, providerEffects });
}

function storeFailure(kind: ZernioReplyStoreFailure): PortalZernioMessagingCommandResult {
  return commandFailure(kind === 'unavailable' ? 'provider_unavailable' : kind);
}

export function zernioMessagingTargetReference(target: PortalZernioMessagingReplyTarget): string {
  if (target.kind === 'dm') return target.providerConversationId;
  const values = [target.platform, target.accountId, target.providerPostId, target.providerCommentId];
  const canonical = values.map((value) => `${Buffer.byteLength(value, 'utf8')}:${value}`).join('|');
  return `zernio-comment-v1:${createHash('sha256').update(canonical).digest('hex')}`;
}

function zernioMessagingTargetNetwork(
  target: PortalZernioMessagingReplyTarget,
): ZernioCommentPlatform {
  return target.kind === 'dm' ? 'instagram' : target.platform;
}

function findComment(
  comments: readonly ZernioCommentSnapshot[],
  providerCommentId: string,
): ZernioCommentSnapshot | null {
  for (const item of comments) {
    if (item.providerCommentId === providerCommentId) return item;
    const nested = findComment(item.replies, providerCommentId);
    if (nested) return nested;
  }
  return null;
}

function firstComment(comments: readonly ZernioCommentSnapshot[]): ZernioCommentSnapshot | null {
  for (const item of comments) {
    if (item.canReply) return item;
    const nested = firstComment(item.replies);
    if (nested) return nested;
  }
  return comments[0] ?? null;
}

export class LivePortalZernioMessagingService implements PortalZernioMessagingService {
  constructor(private readonly dependencies: Readonly<{
    accounts: Pick<PortalZernioSocialConnectionService, 'snapshot'>;
    client: Pick<ZernioMessagingClient,
      'listConversations' | 'listMessages' | 'listCommentedPosts' | 'listPostComments'>;
    sender: Pick<ZernioMessagingClient, 'sendMessage' | 'replyToComment'>;
    replies: ReplyStore;
    allowedAccountIds: readonly string[];
    commentAccountBindings: readonly Readonly<{
      accountId: string;
      platform: ZernioCommentPlatform;
    }>[];
    providerEffectsEnabled: boolean;
    emergencyPaused: boolean;
  }>) {}

  async #validatedTarget(
    identity: PortalCrmRequestIdentity,
    target: PortalZernioMessagingReplyTarget,
  ): Promise<PortalZernioMessagingReplyTarget | null> {
    const accountTruth = await this.dependencies.accounts.snapshot(identity);
    if (!accountTruth.ok) return null;
    if (target.kind === 'dm') {
      if (!accountTruth.accounts.some((account) => account.network === 'instagram'
          && account.status === 'active')) return null;
      const queue = await this.dependencies.client.listConversations({
        accountIds: this.dependencies.allowedAccountIds,
      });
      return queue.conversations.some((item) => item.accountId === target.accountId
        && item.providerConversationId === target.providerConversationId
        && item.platform === 'instagram') ? target : null;
    }
    if (!accountTruth.accounts.some((account) => account.network === target.platform
          && account.status === 'active')
        || !this.dependencies.commentAccountBindings.some((binding) =>
          binding.accountId === target.accountId && binding.platform === target.platform)) return null;
    const feed = await this.dependencies.client.listCommentedPosts({
      accountId: target.accountId, platform: target.platform,
    });
    if (!feed.posts.some((post) => post.providerPostId === target.providerPostId)) return null;
    const thread = await this.dependencies.client.listPostComments({
      accountId: target.accountId, platform: target.platform,
      providerPostId: target.providerPostId,
    });
    const comment = findComment(thread.comments, target.providerCommentId);
    return comment?.canReply ? target : null;
  }

  async snapshot(
    identity: PortalCrmRequestIdentity,
    input: PortalZernioMessagingSelection,
  ): Promise<PortalZernioMessagingSnapshot> {
    const accountTruth = await this.dependencies.accounts.snapshot(identity);
    if (!accountTruth.ok) {
      return Object.freeze({
        ok: false as const,
        kind: accountTruth.kind === 'unauthenticated' ? 'unauthenticated' as const
          : accountTruth.kind === 'forbidden' ? 'forbidden' as const : 'unavailable' as const,
        providerEffects: false as const,
      });
    }
    const activeNetworks = new Set(accountTruth.accounts
      .filter((account) => account.status === 'active').map((account) => account.network));
    const activeCommentBindings = this.dependencies.commentAccountBindings.filter((binding) =>
      activeNetworks.has(binding.platform));
    const canReadDms = activeNetworks.has('instagram')
      && this.dependencies.allowedAccountIds.length > 0;
    if (!canReadDms && activeCommentBindings.length === 0) {
      return Object.freeze({ ok: false as const, kind: 'unavailable' as const, providerEffects: false as const });
    }
    try {
      if (input.providerConversationId && input.comment) {
        return Object.freeze({ ok: false as const, kind: 'forbidden' as const, providerEffects: false as const });
      }
      const [queue, ...commentFeeds] = await Promise.all([
        canReadDms
          ? this.dependencies.client.listConversations({
            accountIds: this.dependencies.allowedAccountIds,
          })
          : Promise.resolve(Object.freeze({
            conversations: Object.freeze([]) as readonly ZernioConversationSnapshot[],
            checkedAt: '1970-01-01T00:00:00.000Z', hasMore: false,
          })),
        ...activeCommentBindings.map((binding) =>
          this.dependencies.client.listCommentedPosts(binding)),
      ]);
      const dmConversations = queue.conversations.filter((item) => item.platform === 'instagram');
      const seenPosts = new Set<string>();
      const commentPosts: ZernioCommentedPostSnapshot[] = [];
      for (const feed of commentFeeds) {
        for (const post of feed.posts) {
          const key = `${post.platform}\0${post.accountId}\0${post.providerPostId}`;
          if (seenPosts.has(key)) continue;
          seenPosts.add(key);
          commentPosts.push(post);
        }
      }
      const requestedConversation = input.providerConversationId;
      const selectedConversation = requestedConversation
        ? dmConversations.find((item) => item.providerConversationId === requestedConversation) ?? null
        : input.comment ? null : dmConversations[0] ?? null;
      if (requestedConversation && !selectedConversation) {
        return Object.freeze({ ok: false as const, kind: 'forbidden' as const, providerEffects: false as const });
      }
      const selectedCommentPost = input.comment
        ? commentPosts.find((post) => post.accountId === input.comment?.accountId
          && post.platform === input.comment?.platform
          && post.providerPostId === input.comment?.providerPostId) ?? null
        : selectedConversation ? null : commentPosts[0] ?? null;
      if (input.comment && !selectedCommentPost) {
        return Object.freeze({ ok: false as const, kind: 'forbidden' as const, providerEffects: false as const });
      }
      const dmThread = selectedConversation
        ? await this.dependencies.client.listMessages({
          accountId: selectedConversation.accountId,
          providerConversationId: selectedConversation.providerConversationId,
        }) : null;
      const commentThread = selectedCommentPost
        ? await this.dependencies.client.listPostComments({
          accountId: selectedCommentPost.accountId,
          platform: selectedCommentPost.platform,
          providerPostId: selectedCommentPost.providerPostId,
        }) : null;
      const requestedCommentId = input.comment?.providerCommentId;
      const selectedComment = commentThread
        ? requestedCommentId
          ? findComment(commentThread.comments, requestedCommentId)
          : firstComment(commentThread.comments)
        : null;
      if (requestedCommentId && !selectedComment) {
        return Object.freeze({ ok: false as const, kind: 'forbidden' as const, providerEffects: false as const });
      }
      const selectedTarget: PortalZernioMessagingReplyTarget | null = selectedConversation
        ? Object.freeze({
          kind: 'dm' as const, accountId: selectedConversation.accountId,
          providerConversationId: selectedConversation.providerConversationId,
        })
        : selectedCommentPost && selectedComment
          ? Object.freeze({
            kind: 'comment' as const, accountId: selectedCommentPost.accountId,
            platform: selectedCommentPost.platform,
            providerPostId: selectedCommentPost.providerPostId,
            providerCommentId: selectedComment.providerCommentId,
          }) : null;
      const ledgerTarget = selectedTarget
        && (selectedTarget.kind === 'dm' || selectedComment?.canReply)
        ? selectedTarget : null;
      const replyResult = ledgerTarget
        ? await this.dependencies.replies.read(identity, {
          accountId: ledgerTarget.accountId,
          providerConversationId: zernioMessagingTargetReference(ledgerTarget),
        }) : null;
      if (replyResult && !replyResult.ok) {
        return Object.freeze({ ok: false as const, kind: 'unavailable' as const, providerEffects: false as const });
      }
      return Object.freeze({
        ok: true as const, provider: 'zernio' as const, providerEffects: false as const,
        outboundEffectsEnabled: this.dependencies.providerEffectsEnabled,
        emergencyPaused: this.dependencies.emergencyPaused,
        checkedAt: dmThread?.checkedAt ?? commentThread?.checkedAt
          ?? queue.checkedAt ?? commentFeeds[0]?.checkedAt ?? '1970-01-01T00:00:00.000Z',
        conversations: Object.freeze(dmConversations),
        commentPosts: Object.freeze(commentPosts),
        selectedConversation,
        selectedCommentPost,
        selectedComment,
        selectedTarget,
        messages: dmThread?.messages ?? Object.freeze([]),
        comments: commentThread?.comments ?? Object.freeze([]),
        reply: replyResult?.ok ? replyResult.value : null,
        conversationHistoryTruncated: dmThread?.hasMore ?? commentThread?.hasMore ?? false,
        queueTruncated: queue.hasMore || commentFeeds.some((feed) => feed.hasMore),
      });
    } catch {
      return Object.freeze({ ok: false as const, kind: 'provider_unavailable' as const, providerEffects: false as const });
    }
  }

  async createDraft(identity: PortalCrmRequestIdentity, input: Readonly<{
    draftId: string; target: PortalZernioMessagingReplyTarget; body: string;
  }>): Promise<PortalZernioMessagingCommandResult> {
    try {
      const target = await this.#validatedTarget(identity, input.target);
      if (!target) {
        return commandFailure('forbidden');
      }
      const result = await this.dependencies.replies.create(identity, {
        draftId: input.draftId, network: zernioMessagingTargetNetwork(target),
        accountId: target.accountId,
        providerConversationId: zernioMessagingTargetReference(target), body: input.body,
      });
      return result.ok
        ? Object.freeze({ ok: true, disposition: result.value, providerEffects: 'none' as const })
        : storeFailure(result.kind);
    } catch { return commandFailure('provider_unavailable'); }
  }

  async requestApproval(identity: PortalCrmRequestIdentity, input: Readonly<{
    draftId: string; approvalRequestId: string;
  }>): Promise<PortalZernioMessagingCommandResult> {
    const result = await this.dependencies.replies.requestApproval(identity, input);
    return result.ok
      ? Object.freeze({ ok: true, disposition: result.value, providerEffects: 'none' as const })
      : storeFailure(result.kind);
  }

  async decideApproval(identity: PortalCrmRequestIdentity, input: Readonly<{
    approvalRequestId: string; decisionId: string; decision: 'approved' | 'rejected';
  }>): Promise<PortalZernioMessagingCommandResult> {
    const result = await this.dependencies.replies.decide(identity, input);
    return result.ok
      ? Object.freeze({ ok: true, disposition: result.value, providerEffects: 'none' as const })
      : storeFailure(result.kind);
  }

  async sendApproved(identity: PortalCrmRequestIdentity, input: Readonly<{
    draftId: string; deliveryId: string; leaseToken: string;
    target: PortalZernioMessagingReplyTarget;
  }>): Promise<PortalZernioMessagingCommandResult> {
    if (!this.dependencies.providerEffectsEnabled) return commandFailure('effects_disabled');
    if (this.dependencies.emergencyPaused) return commandFailure('emergency_paused');
    const idempotencyKey = `reply:${input.deliveryId}`;
    try {
      const target = await this.#validatedTarget(identity, input.target);
      if (!target) {
        return commandFailure('forbidden');
      }
      const providerConversationId = zernioMessagingTargetReference(target);
      const claim = await this.dependencies.replies.claim(identity, {
        draftId: input.draftId, deliveryId: input.deliveryId,
        leaseToken: input.leaseToken,
        network: zernioMessagingTargetNetwork(target), accountId: target.accountId,
        providerConversationId, idempotencyKey,
      });
      if (!claim.ok) return storeFailure(claim.kind);
      if (claim.value.disposition !== 'claimed' || !claim.value.body) {
        return commandFailure('conflict');
      }
      try {
        const sent = target.kind === 'dm'
          ? await this.dependencies.sender.sendMessage({
            accountId: target.accountId,
            providerConversationId: target.providerConversationId,
            body: claim.value.body, idempotencyKey,
          })
          : await this.dependencies.sender.replyToComment({
            accountId: target.accountId, platform: target.platform,
            providerPostId: target.providerPostId,
            providerCommentId: target.providerCommentId,
            body: claim.value.body, idempotencyKey,
          });
        const providerMessageId = 'providerMessageId' in sent
          ? sent.providerMessageId : sent.providerReplyCommentId;
        const settled = await this.dependencies.replies.settle(identity, {
          deliveryId: input.deliveryId, leaseToken: input.leaseToken, state: 'accepted',
          providerMessageIdSha256: createHash('sha256').update(providerMessageId).digest('hex'),
          providerResponseSha256: sent.responseSha256, failureCode: null,
        });
        if (!settled.ok) return commandFailure('outcome_unknown', 'unknown');
        return Object.freeze({ ok: true, disposition: 'sent' as const, providerEffects: 'one_message_accepted' as const });
      } catch (error) {
        const code = error instanceof ZernioMessagingError ? error.code : 'outcome_unknown';
        const unknown = code === 'outcome_unknown'
          || code === 'provider_unavailable'
          || code === 'invalid_provider_response';
        let settled: Awaited<ReturnType<ReplyStore['settle']>>;
        try {
          settled = await this.dependencies.replies.settle(identity, {
            deliveryId: input.deliveryId, leaseToken: input.leaseToken,
            state: unknown ? 'outcome_unknown' : 'failed',
            providerMessageIdSha256: null, providerResponseSha256: null,
            failureCode: unknown ? 'outcome_unknown' : code,
          });
        } catch {
          return commandFailure('outcome_unknown', 'unknown');
        }
        if (!settled.ok || unknown) return commandFailure('outcome_unknown', unknown ? 'unknown' : 'none');
        return commandFailure(code === 'unbound_target' || code === 'unauthorised'
          ? 'forbidden' : 'provider_rejected');
      }
    } catch { return commandFailure('provider_unavailable'); }
  }
}
