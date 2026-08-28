import type { PropertyPredatorContentSyncStatus } from '../company-content-sync/index.js';

/** Opaque browser identity; workspace and actor ids are resolved from the active session. */
export interface PortalCompanyContentSyncRequestIdentity {
  readonly sessionToken: string;
  readonly requestId: string;
}

export interface PortalCompanyContentSyncWorkspaceAccess {
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly snapshotAt: string;
  readonly canManage: boolean;
}

export interface PortalCompanyContentSyncSnapshot {
  readonly workspace: PortalCompanyContentSyncWorkspaceAccess;
  readonly sync: PropertyPredatorContentSyncStatus;
  readonly dataset: 'postgres_authoritative';
  readonly providerEffects: false;
}

export type PortalCompanyContentSyncFailureKind =
  | 'unauthenticated'
  | 'forbidden'
  | 'conflict'
  | 'unavailable';

export interface PortalCompanyContentSyncFailure {
  readonly ok: false;
  readonly kind: PortalCompanyContentSyncFailureKind;
  /** Safe operator copy only. Source credentials and provider/database detail never cross. */
  readonly message: string;
}

export type PortalCompanyContentSyncOutcome =
  | { readonly ok: true; readonly snapshot: PortalCompanyContentSyncSnapshot }
  | PortalCompanyContentSyncFailure;

/**
 * Founder/admin effects-off source boundary. There is deliberately no approve,
 * generate, publish, schedule, send, provider, customer or affiliate method.
 */
export interface PortalCompanyContentSyncService {
  snapshot(
    identity: PortalCompanyContentSyncRequestIdentity,
  ): Promise<PortalCompanyContentSyncOutcome>;
  sync(
    identity: PortalCompanyContentSyncRequestIdentity,
  ): Promise<PortalCompanyContentSyncOutcome>;
}
