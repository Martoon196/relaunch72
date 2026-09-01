import { createHash } from 'node:crypto';
import type {
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

export type PortalZernioMessagingSnapshot = Readonly<{
  ok: true;
  provider: 'zernio';
  providerEffects: false;
  checkedAt: string;
  conversations: readonly ZernioConversationSnapshot[];
  selectedConversation: ZernioConversationSnapshot | null;
  messages: readonly ZernioMessageSnapshot[];
  reply: ZernioReplyState | null;
  conversationHistoryTruncated: boolean;
  queueTruncated: boolean;
}> | Readonly<{
  ok: false;
  kind: PortalZernioMessagingFailureKind;
  providerEffects: false;
}>;

export interface PortalZernioMessagingService {
  snapshot(identity: PortalCrmRequestIdentity, input: Readonly<{
    providerConversationId?: string;
  }>): Promise<PortalZernioMessagingSnapshot>;
  createDraft(identity: PortalCrmRequestIdentity, input: Readonly<{
    draftId: string; accountId: string; providerConversationId: string; body: string;
  }>): Promise<PortalZernioMessagingCommandResult>;
  requestApproval(identity: PortalCrmRequestIdentity, input: Readonly<{
    draftId: string; approvalRequestId: string;
  }>): Promise<PortalZernioMessagingCommandResult>;
  decideApproval(identity: PortalCrmRequestIdentity, input: Readonly<{
    approvalRequestId: string; decisionId: string; decision: 'approved' | 'rejected';
  }>): Promise<PortalZernioMessagingCommandResult>;
  sendApproved(identity: PortalCrmRequestIdentity, input: Readonly<{
    draftId: string; deliveryId: string; leaseToken: string;
    accountId: string; providerConversationId: string;
  }>): Promise<PortalZernioMessagingCommandResult>;
}

export type PortalZernioMessagingCommandResult = Readonly<{
  ok: true;
  disposition: 'created' | 'replayed' | 'requested' | 'approved' | 'rejected' | 'sent';
  providerEffects: 'none' | 'one_message_accepted';
}> | Readonly<{
  ok: false;
  kind: PortalZernioMessagingFailureKind | 'validation' | 'conflict'
    | 'outcome_unknown' | 'provider_rejected';
  providerEffects: 'none' | 'unknown';
}>;

type ReplyStore = Pick<PgZernioMessagingReplyStore,
  'read' | 'create' | 'requestApproval' | 'decide' | 'claim' | 'settle'>;

function commandFailure(
  kind: PortalZernioMessagingFailureKind | 'validation' | 'conflict'
    | 'outcome_unknown' | 'provider_rejected',
  providerEffects: 'none' | 'unknown' = 'none',
): PortalZernioMessagingCommandResult {
  return Object.freeze({ ok: false as const, kind, providerEffects });
}

function storeFailure(kind: ZernioReplyStoreFailure): PortalZernioMessagingCommandResult {
  return commandFailure(kind === 'unavailable' ? 'provider_unavailable' : kind);
}

export class LivePortalZernioMessagingService implements PortalZernioMessagingService {
  constructor(private readonly dependencies: Readonly<{
    accounts: Pick<PortalZernioSocialConnectionService, 'snapshot'>;
    client: Pick<ZernioMessagingClient, 'listConversations' | 'listMessages'>;
    sender: Pick<ZernioMessagingClient, 'sendMessage'>;
    replies: ReplyStore;
    allowedAccountIds: readonly string[];
  }>) {}

  async #conversation(identity: PortalCrmRequestIdentity, accountId: string, providerConversationId: string) {
    const accountTruth = await this.dependencies.accounts.snapshot(identity);
    if (!accountTruth.ok) return null;
    if (!accountTruth.accounts.some((account) => account.network === 'instagram'
        && account.status === 'active')) return null;
    const queue = await this.dependencies.client.listConversations({
      accountIds: this.dependencies.allowedAccountIds,
    });
    return queue.conversations.find((item) => item.accountId === accountId
      && item.providerConversationId === providerConversationId) ?? null;
  }

  async snapshot(identity: PortalCrmRequestIdentity, input: Readonly<{
    providerConversationId?: string;
  }>): Promise<PortalZernioMessagingSnapshot> {
    const accountTruth = await this.dependencies.accounts.snapshot(identity);
    if (!accountTruth.ok) {
      return Object.freeze({
        ok: false as const,
        kind: accountTruth.kind === 'unauthenticated' ? 'unauthenticated' as const
          : accountTruth.kind === 'forbidden' ? 'forbidden' as const : 'unavailable' as const,
        providerEffects: false as const,
      });
    }
    if (!accountTruth.accounts.some((account) => account.network === 'instagram'
        && account.status === 'active')) {
      return Object.freeze({ ok: false as const, kind: 'unavailable' as const, providerEffects: false as const });
    }
    try {
      const queue = await this.dependencies.client.listConversations({
        accountIds: this.dependencies.allowedAccountIds,
      });
      const requested = input.providerConversationId;
      const selected = requested
        ? queue.conversations.find((item) => item.providerConversationId === requested) ?? null
        : queue.conversations[0] ?? null;
      if (requested && !selected) {
        return Object.freeze({ ok: false as const, kind: 'forbidden' as const, providerEffects: false as const });
      }
      const [thread, replyResult] = selected
        ? await Promise.all([
          this.dependencies.client.listMessages({
            accountId: selected.accountId,
            providerConversationId: selected.providerConversationId,
          }),
          this.dependencies.replies.read(identity, {
            accountId: selected.accountId,
            providerConversationId: selected.providerConversationId,
          }),
        ])
        : [null, null] as const;
      if (replyResult && !replyResult.ok) {
        return Object.freeze({ ok: false as const, kind: 'unavailable' as const, providerEffects: false as const });
      }
      return Object.freeze({
        ok: true as const, provider: 'zernio' as const, providerEffects: false as const,
        checkedAt: thread?.checkedAt ?? queue.checkedAt,
        conversations: queue.conversations, selectedConversation: selected,
        messages: thread?.messages ?? Object.freeze([]),
        reply: replyResult?.ok ? replyResult.value : null,
        conversationHistoryTruncated: thread?.hasMore ?? false,
        queueTruncated: queue.hasMore,
      });
    } catch {
      return Object.freeze({ ok: false as const, kind: 'provider_unavailable' as const, providerEffects: false as const });
    }
  }

  async createDraft(identity: PortalCrmRequestIdentity, input: Readonly<{
    draftId: string; accountId: string; providerConversationId: string; body: string;
  }>): Promise<PortalZernioMessagingCommandResult> {
    try {
      if (!await this.#conversation(identity, input.accountId, input.providerConversationId)) {
        return commandFailure('forbidden');
      }
      const result = await this.dependencies.replies.create(identity, input);
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
    accountId: string; providerConversationId: string;
  }>): Promise<PortalZernioMessagingCommandResult> {
    const idempotencyKey = `reply:${input.deliveryId}`;
    try {
      if (!await this.#conversation(identity, input.accountId, input.providerConversationId)) {
        return commandFailure('forbidden');
      }
      const claim = await this.dependencies.replies.claim(identity, { ...input, idempotencyKey });
      if (!claim.ok) return storeFailure(claim.kind);
      if (claim.value.disposition !== 'claimed' || !claim.value.body) {
        return commandFailure('conflict');
      }
      try {
        const sent = await this.dependencies.sender.sendMessage({
          accountId: input.accountId,
          providerConversationId: input.providerConversationId,
          body: claim.value.body,
          idempotencyKey,
        });
        const settled = await this.dependencies.replies.settle(identity, {
          deliveryId: input.deliveryId, leaseToken: input.leaseToken, state: 'accepted',
          providerMessageIdSha256: createHash('sha256').update(sent.providerMessageId).digest('hex'),
          providerResponseSha256: sent.responseSha256, failureCode: null,
        });
        if (!settled.ok) return commandFailure('outcome_unknown', 'unknown');
        return Object.freeze({ ok: true, disposition: 'sent' as const, providerEffects: 'one_message_accepted' as const });
      } catch (error) {
        const code = error instanceof ZernioMessagingError ? error.code : 'outcome_unknown';
        const unknown = code === 'outcome_unknown' || code === 'provider_unavailable';
        const settled = await this.dependencies.replies.settle(identity, {
          deliveryId: input.deliveryId, leaseToken: input.leaseToken,
          state: unknown ? 'outcome_unknown' : 'failed',
          providerMessageIdSha256: null, providerResponseSha256: null,
          failureCode: unknown ? 'outcome_unknown' : code,
        });
        if (!settled.ok || unknown) return commandFailure('outcome_unknown', unknown ? 'unknown' : 'none');
        return commandFailure(code === 'unbound_target' || code === 'unauthorised'
          ? 'forbidden' : 'provider_rejected');
      }
    } catch { return commandFailure('provider_unavailable'); }
  }
}
