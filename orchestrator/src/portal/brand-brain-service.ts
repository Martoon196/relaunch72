import type { BrandBrainSnapshot } from '../brand-brain-pg/types.js';
import type { FounderSpecialistPack } from '../company-content-adapter/founder-specialist-pack.js';

/**
 * Opaque browser identity. The implementation resolves the portal session and
 * workspace server-side; the browser never supplies either database identity.
 */
export interface PortalBrandBrainRequestIdentity {
  readonly sessionToken: string;
  readonly requestId: string;
}

export interface PortalBrandBrainWorkspaceAccess {
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly snapshotAt: string;
  readonly canManage: boolean;
}

/**
 * A founder-owned ChatGPT specialist cannot be called by Growth HQ from its
 * consumer-product URL. Only founder-exported, reviewed metadata may advance
 * beyond this placeholder state in a later, separately authorised workflow.
 */
export interface PortalBrandBrainExternalProfile {
  readonly profileId: string;
  readonly name: string;
  readonly purpose: string;
  readonly status: 'awaiting_founder_export';
  readonly callable: false;
}

export interface PortalBrandBrainAdaptedMethodPack {
  readonly pack: FounderSpecialistPack;
  readonly sourceInventorySha256: string;
  readonly sourceFileCount: number;
  readonly sourceByteLength: number;
}

export interface PortalBrandBrainSnapshot {
  readonly workspace: PortalBrandBrainWorkspaceAccess;
  readonly brain: BrandBrainSnapshot;
  readonly externalProfiles: readonly PortalBrandBrainExternalProfile[];
  /**
   * Private adapted methods are projected through the inert specialist-pack
   * contract. They are not ChatGPT profiles, runtime agents or provider tools.
   */
  readonly adaptedMethodPacks: readonly PortalBrandBrainAdaptedMethodPack[];
  readonly dataset: 'illustrative_fixture' | 'postgres_authoritative';
}

export type PortalBrandBrainFailureKind =
  | 'unauthenticated'
  | 'forbidden'
  | 'not_found'
  | 'invalid_snapshot'
  | 'unavailable';

export interface PortalBrandBrainFailure {
  readonly ok: false;
  readonly kind: PortalBrandBrainFailureKind;
  /** Safe user-facing copy only; no database, prompt or provider detail. */
  readonly message: string;
}

export type PortalBrandBrainSnapshotOutcome =
  | {
      readonly ok: true;
      readonly snapshot: PortalBrandBrainSnapshot;
    }
  | PortalBrandBrainFailure;

/**
 * Read-only portal boundary. There is intentionally no stage, review,
 * evaluation, activation, generation, model, provider or publishing command.
 */
export interface PortalBrandBrainService {
  snapshot(
    identity: PortalBrandBrainRequestIdentity,
  ): Promise<PortalBrandBrainSnapshotOutcome>;
}
