import type {
  StagePropertyPredatorOwnedSeedCampaignResult,
} from '../property-predator-owned-seed-campaign-pg/types.js';

export interface PortalOwnedSeedCampaignIdentity {
  readonly sessionToken: string;
  readonly requestId: string;
}

export interface PortalStageOwnedSeedCampaignInput {
  readonly commandKey: string;
  readonly messageVersionId: string;
  readonly runId: string;
}

export type PortalStageOwnedSeedCampaignOutcome =
  | Readonly<{ readonly ok: true; readonly result: StagePropertyPredatorOwnedSeedCampaignResult }>
  | Readonly<{
      readonly ok: false;
      readonly kind: 'unauthenticated' | 'forbidden' | 'validation' | 'unavailable';
      readonly message: string;
    }>;

/** Portal command boundary. It can stage one pre-approved owned seed; it cannot send. */
export interface PortalOwnedSeedCampaignService {
  stage(
    identity: PortalOwnedSeedCampaignIdentity,
    input: PortalStageOwnedSeedCampaignInput,
  ): Promise<PortalStageOwnedSeedCampaignOutcome>;
}
