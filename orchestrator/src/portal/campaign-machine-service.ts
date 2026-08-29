import type { CampaignMachineSnapshot } from './campaign-machine-presenter.js';
import type { PortalCrmRequestIdentity } from './crm-service.js';

export type PortalCampaignMachineFailureKind =
  | 'unauthenticated'
  | 'forbidden'
  | 'invalid_snapshot'
  | 'unavailable';

export interface PortalCampaignMachineFailure {
  readonly ok: false;
  readonly kind: PortalCampaignMachineFailureKind;
  readonly message: string;
}

export type PortalCampaignMachineSnapshotOutcome =
  | Readonly<{ ok: true; snapshot: CampaignMachineSnapshot }>
  | PortalCampaignMachineFailure;

/** Authenticated, RLS-scoped campaign evidence. It exposes no mutation or provider operation. */
export interface PortalCampaignMachineService {
  snapshot(identity: PortalCrmRequestIdentity): Promise<PortalCampaignMachineSnapshotOutcome>;
}
