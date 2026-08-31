import type { VerifiedZernioAccountWebhook, ZernioPilotNetwork } from '../public-social-outbound/index.js';
import type { PortalCrmRequestIdentity } from './crm-service.js';

export const ZERNIO_SOCIAL_CONNECT_ROUTE_PREFIX = '/portal/social/accounts/connect' as const;
export const ZERNIO_SOCIAL_CALLBACK_ROUTE = '/portal/social/accounts/callback' as const;
export const ZERNIO_SOCIAL_WEBHOOK_ROUTE = '/webhooks/zernio/accounts' as const;

export type PortalZernioFailureKind =
  | 'unauthenticated' | 'forbidden' | 'validation' | 'conflict'
  | 'billing_required' | 'rate_limited' | 'provider_rejected'
  | 'provider_unavailable' | 'unavailable';

export type PortalZernioFailure = Readonly<{ ok: false; kind: PortalZernioFailureKind }>;

export interface PortalZernioAccountSnapshot {
  readonly accountId: string;
  readonly network: ZernioPilotNetwork;
  readonly username: string | null;
  readonly displayName: string | null;
  readonly status: 'active' | 'disconnected';
  readonly linkedAt: string;
  readonly lastEventAt: string;
  readonly webhookReceiptCount: number;
}

export type PortalZernioSnapshotResult =
  | Readonly<{ ok: true; accounts: readonly PortalZernioAccountSnapshot[] }>
  | PortalZernioFailure;

export type PortalZernioBeginResult =
  | Readonly<{
    ok: true;
    intentId: string;
    authUrl: string;
    providerEffects: 'oauth_not_started';
  }>
  | PortalZernioFailure;

export type PortalZernioCallbackResult =
  | Readonly<{
    ok: true;
    accountId: string;
    disposition: 'recorded' | 'replayed';
    providerEffects: 'account_already_connected_by_user';
  }>
  | PortalZernioFailure;

export type PortalZernioWebhookResult =
  | Readonly<{ ok: true; disposition: 'recorded' | 'replayed'; providerEffects: 'none' }>
  | PortalZernioFailure;

export interface PortalZernioSocialConnectionService {
  readonly providerConnectionId: string;
  readonly providerProfileId: string;
  snapshot(identity: PortalCrmRequestIdentity): Promise<PortalZernioSnapshotResult>;
  begin(identity: PortalCrmRequestIdentity, input: Readonly<{
    intentId: string;
    network: ZernioPilotNetwork;
  }>): Promise<PortalZernioBeginResult>;
  callback(identity: PortalCrmRequestIdentity, input: Readonly<{
    intentId: string;
    network: ZernioPilotNetwork;
    providerProfileId: string;
    providerAccountId: string;
    username: string;
    linkedAt: string;
    canonicalCallback: string;
  }>): Promise<PortalZernioCallbackResult>;
  recordWebhook(input: VerifiedZernioAccountWebhook): Promise<PortalZernioWebhookResult>;
}
