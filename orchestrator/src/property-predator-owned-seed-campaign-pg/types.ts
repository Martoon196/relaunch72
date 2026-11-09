import type { Pool } from 'pg';
import type { DatabaseRequestContext } from '../db/rls.js';

export const PROPERTY_PREDATOR_OWNED_SEED_EMAIL = 'office@propertypredator.com' as const;

export interface StagePropertyPredatorOwnedSeedCampaignCommand {
  /** Stable caller-owned key. Reusing it with different evidence is rejected. */
  readonly commandKey: string;
  /** Existing current, live, approved email message version. */
  readonly messageVersionId: string;
  /** One worker-run fence used by the existing controlled Mailgun boundary. */
  readonly runId: string;
}

export type PropertyPredatorOwnedSeedDeliveryState =
  | 'queued' | 'leased' | 'calling' | 'blocked' | 'settled'
  | 'reconciliation_required' | 'cancelled';

export type StagePropertyPredatorOwnedSeedCampaignResult =
  | Readonly<{
    disposition: 'blocked';
    reason: string;
    jobId: string | null;
    messageVersionId: string;
    providerConnectionId: string | null;
    requestSha256: string | null;
    estimatedSpendUsdMicros: number | null;
    recipient: typeof PROPERTY_PREDATOR_OWNED_SEED_EMAIL;
    /** This staging command itself never invokes Mailgun. */
    providerCallMadeByThisCommand: false;
    /** True only for an idempotency conflict that points at an existing job. */
    deliveryIntentCreated: boolean;
    deliveryState: PropertyPredatorOwnedSeedDeliveryState;
  }>
  | Readonly<{
    disposition: 'staged' | 'replayed';
    reason: null;
    jobId: string;
    messageVersionId: string;
    providerConnectionId: string;
    requestSha256: string;
    estimatedSpendUsdMicros: number;
    recipient: typeof PROPERTY_PREDATOR_OWNED_SEED_EMAIL;
    /** This staging command itself never invokes Mailgun. */
    providerCallMadeByThisCommand: false;
    deliveryIntentCreated: true;
    /** Current stored job truth; a replay does not assume it is still queued. */
    deliveryState: PropertyPredatorOwnedSeedDeliveryState;
  }>;

export interface PropertyPredatorOwnedSeedCampaignRepository {
  stage(
    context: DatabaseRequestContext,
    command: StagePropertyPredatorOwnedSeedCampaignCommand,
  ): Promise<StagePropertyPredatorOwnedSeedCampaignResult>;
  assertReady(): Promise<void>;
}

export interface PropertyPredatorOwnedSeedCampaignServiceDependencies {
  readonly commandPool: Pick<Pool, 'connect'>;
  /** Trusted workspace paired with this dedicated table-blind database URL. */
  readonly workspaceId: string;
}

export class PropertyPredatorOwnedSeedCampaignValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PropertyPredatorOwnedSeedCampaignValidationError';
  }
}

export class PropertyPredatorOwnedSeedCampaignConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PropertyPredatorOwnedSeedCampaignConflictError';
  }
}
