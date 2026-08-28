import type { Pool, QueryResultRow } from 'pg';
import { withTransaction } from '../db/transaction.js';
import type { DatabaseRequestContext } from '../db/rls.js';
import {
  PROPERTY_PREDATOR_OWNED_SEED_EMAIL,
  PropertyPredatorOwnedSeedCampaignConflictError,
  type PropertyPredatorOwnedSeedCampaignRepository,
  type PropertyPredatorOwnedSeedDeliveryState,
  type StagePropertyPredatorOwnedSeedCampaignCommand,
  type StagePropertyPredatorOwnedSeedCampaignResult,
} from './types.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_REASON = /^[a-z][a-z0-9_.:-]{0,99}$/;
const DISPOSITIONS = new Set(['blocked', 'staged', 'replayed']);
const DELIVERY_STATES = new Set<PropertyPredatorOwnedSeedDeliveryState>([
  'queued', 'leased', 'calling', 'blocked', 'settled',
  'reconciliation_required', 'cancelled',
]);

interface StageRow extends QueryResultRow {
  disposition: string;
  reason: string | null;
  jobId: string | null;
  providerConnectionId: string | null;
  messageVersionId: string;
  requestSha256: Buffer | string | null;
  estimatedSpendUsdMicros: string | number | null;
  deliveryState: string;
}

interface PgErrorLike { readonly code?: unknown }

function uuid(value: unknown, label: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new Error(`${label} returned an invalid UUID`);
  }
  return value;
}

function digest(value: Buffer | string | null): string | null {
  if (value === null) return null;
  const candidate = Buffer.isBuffer(value)
    ? value.toString('hex')
    : value.startsWith('\\x') ? value.slice(2) : value;
  if (!SHA256.test(candidate)) throw new Error('Owned-seed campaign returned an invalid digest');
  return candidate;
}

function micros(value: string | number | null): number | null {
  if (value === null) return null;
  const parsed = typeof value === 'string'
    ? (/^[1-9][0-9]*$/.test(value) ? Number(value) : Number.NaN)
    : value;
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 100_000_000) {
    throw new Error('Owned-seed campaign returned an invalid spend estimate');
  }
  return parsed;
}

function translateConflict(error: unknown): never {
  if (error && typeof error === 'object'
      && ['23505', '40001'].includes(String((error as PgErrorLike).code))) {
    throw new PropertyPredatorOwnedSeedCampaignConflictError(
      'Owned-seed campaign evidence changed or was staged concurrently',
    );
  }
  throw error;
}

export interface PgPropertyPredatorOwnedSeedCampaignRepositoryDependencies {
  readonly commandPool: Pick<Pool, 'connect'>;
  readonly workspaceId: string;
}

export class PgPropertyPredatorOwnedSeedCampaignRepository
implements PropertyPredatorOwnedSeedCampaignRepository {
  readonly #commandPool: Pick<Pool, 'connect'>;
  readonly #workspaceId: string;

  constructor(dependencies: PgPropertyPredatorOwnedSeedCampaignRepositoryDependencies) {
    this.#commandPool = dependencies.commandPool;
    this.#workspaceId = uuid(dependencies.workspaceId, 'workspaceId');
  }

  async stage(
    context: DatabaseRequestContext,
    command: StagePropertyPredatorOwnedSeedCampaignCommand,
  ): Promise<StagePropertyPredatorOwnedSeedCampaignResult> {
    if (context.workspaceId !== this.#workspaceId) {
      throw new PropertyPredatorOwnedSeedCampaignConflictError(
        'Owned-seed campaign workspace does not match its database identity',
      );
    }
    try {
      return await withTransaction(
        this.#commandPool,
        context,
        async (transaction) => {
          const result = await transaction.query<StageRow>(
            `/* property-predator-owned-seed-campaign.stage */
             SELECT disposition, reason, job_id AS "jobId",
                    provider_connection_id AS "providerConnectionId",
                    message_version_id AS "messageVersionId",
                    request_sha256 AS "requestSha256",
                    estimated_spend_usd_micros AS "estimatedSpendUsdMicros",
                    delivery_state AS "deliveryState"
             FROM app_private.stage_property_predator_owned_seed_campaign(
               $1, $2, $3, $4
             )`,
            [this.#workspaceId, command.messageVersionId,
              command.runId, command.commandKey],
          );
          const row = result.rows[0];
          if (result.rows.length !== 1 || !row || !DISPOSITIONS.has(row.disposition)) {
            throw new Error('Owned-seed campaign returned invalid canonical data');
          }
          const requestSha256 = digest(row.requestSha256);
          const estimatedSpendUsdMicros = micros(row.estimatedSpendUsdMicros);
          const messageVersionId = uuid(row.messageVersionId, 'messageVersionId');
          if (!DELIVERY_STATES.has(row.deliveryState as PropertyPredatorOwnedSeedDeliveryState)) {
            throw new Error('Owned-seed campaign returned an invalid delivery state');
          }
          const deliveryState = row.deliveryState as PropertyPredatorOwnedSeedDeliveryState;
          if (row.disposition === 'blocked') {
            if (typeof row.reason !== 'string' || !SAFE_REASON.test(row.reason)) {
              throw new Error('Owned-seed campaign returned an invalid block reason');
            }
            const jobId = row.jobId === null ? null : uuid(row.jobId, 'jobId');
            if (jobId === null && deliveryState !== 'blocked') {
              throw new Error('Owned-seed campaign invented state without a delivery intent');
            }
            return Object.freeze({
              disposition: 'blocked' as const,
              reason: row.reason,
              jobId,
              messageVersionId,
              providerConnectionId: row.providerConnectionId === null
                ? null : uuid(row.providerConnectionId, 'providerConnectionId'),
              requestSha256,
              estimatedSpendUsdMicros,
              recipient: PROPERTY_PREDATOR_OWNED_SEED_EMAIL,
              providerCallMadeByThisCommand: false as const,
              deliveryIntentCreated: jobId !== null,
              deliveryState,
            });
          }
          if (row.reason !== null || requestSha256 === null
              || estimatedSpendUsdMicros === null) {
            throw new Error('Owned-seed campaign staged result is incomplete');
          }
          return Object.freeze({
            disposition: row.disposition as 'staged' | 'replayed',
            reason: null,
            jobId: uuid(row.jobId, 'jobId'),
            messageVersionId,
            providerConnectionId: uuid(
              row.providerConnectionId,
              'providerConnectionId',
            ),
            requestSha256,
            estimatedSpendUsdMicros,
            recipient: PROPERTY_PREDATOR_OWNED_SEED_EMAIL,
            providerCallMadeByThisCommand: false as const,
            deliveryIntentCreated: true as const,
            deliveryState,
          });
        },
        { isolation: 'serializable' },
      );
    } catch (error) {
      translateConflict(error);
    }
  }

  async assertReady(): Promise<void> {
    await withTransaction(
      this.#commandPool,
      {
        actorKind: 'system',
        workspaceId: this.#workspaceId,
        requestId: 'owned-seed-campaign:readiness',
      },
      async (transaction) => {
        const result = await transaction.query<{ ready: boolean } & QueryResultRow>(
          `/* property-predator-owned-seed-campaign.boundary-ready */
           SELECT app_private.property_predator_owned_seed_campaign_boundary_ready()
             AS ready`,
        );
        if (result.rows.length !== 1 || result.rows[0]?.ready !== true) {
          throw new Error('Owned-seed campaign PostgreSQL boundary is not ready');
        }
      },
      { readOnly: true },
    );
  }
}
