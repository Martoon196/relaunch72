import type {
  ZernioConversationSnapshot,
  ZernioMessageSnapshot,
  ZernioMessagingClient,
} from '../public-social-outbound/zernio-messaging-client.js';
import type { PortalCrmRequestIdentity } from './crm-service.js';
import type { PortalZernioSocialConnectionService } from './zernio-social-connection-service.js';

export const ZERNIO_MESSAGING_ROUTE = '/portal/inbox/social' as const;

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
}

export class LivePortalZernioMessagingService implements PortalZernioMessagingService {
  constructor(private readonly dependencies: Readonly<{
    accounts: Pick<PortalZernioSocialConnectionService, 'snapshot'>;
    client: Pick<ZernioMessagingClient, 'listConversations' | 'listMessages'>;
    allowedAccountIds: readonly string[];
  }>) {}

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
      const thread = selected
        ? await this.dependencies.client.listMessages({
          accountId: selected.accountId,
          providerConversationId: selected.providerConversationId,
        })
        : null;
      return Object.freeze({
        ok: true as const, provider: 'zernio' as const, providerEffects: false as const,
        checkedAt: thread?.checkedAt ?? queue.checkedAt,
        conversations: queue.conversations, selectedConversation: selected,
        messages: thread?.messages ?? Object.freeze([]),
        conversationHistoryTruncated: thread?.hasMore ?? false,
        queueTruncated: queue.hasMore,
      });
    } catch {
      return Object.freeze({ ok: false as const, kind: 'provider_unavailable' as const, providerEffects: false as const });
    }
  }
}

