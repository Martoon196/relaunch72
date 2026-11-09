import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { requestDatabaseContext } from '../db/rls.js';
import { InactivePortalSessionError } from '../db/transaction.js';
import {
  PropertyPredatorOwnedSeedCampaignValidationError,
  type PropertyPredatorOwnedSeedCampaignService,
} from '../property-predator-owned-seed-campaign-pg/index.js';
import {
  createPgPortalCrmPrincipalResolver,
  type PortalCrmPrincipalResolver,
} from './crm-pg-service.js';
import type {
  PortalOwnedSeedCampaignIdentity,
  PortalOwnedSeedCampaignService,
  PortalStageOwnedSeedCampaignInput,
  PortalStageOwnedSeedCampaignOutcome,
} from './owned-seed-campaign-service.js';

export interface PgPortalOwnedSeedCampaignDependencies {
  readonly principalResolver: Pick<PortalCrmPrincipalResolver, 'resolve'>;
  readonly campaign: Pick<PropertyPredatorOwnedSeedCampaignService, 'stage'>;
}

export class PgPortalOwnedSeedCampaignService implements PortalOwnedSeedCampaignService {
  constructor(private readonly dependencies: PgPortalOwnedSeedCampaignDependencies) {}

  async stage(
    identity: PortalOwnedSeedCampaignIdentity,
    input: PortalStageOwnedSeedCampaignInput,
  ): Promise<PortalStageOwnedSeedCampaignOutcome> {
    try {
      const principal = await this.dependencies.principalResolver.resolve(identity.sessionToken);
      if (!principal) {
        return Object.freeze({
          ok: false,
          kind: 'unauthenticated',
          message: 'This portal session is no longer active.',
        });
      }
      const result = await this.dependencies.campaign.stage(requestDatabaseContext({
        ...principal,
        requestId: identity.requestId,
        portalSessionTokenHash: createHash('sha256').update(identity.sessionToken).digest(),
      }), input);
      return Object.freeze({ ok: true, result });
    } catch (error) {
      if (error instanceof InactivePortalSessionError) {
        return Object.freeze({
          ok: false,
          kind: 'unauthenticated',
          message: 'This portal session is no longer active.',
        });
      }
      if (error instanceof PropertyPredatorOwnedSeedCampaignValidationError) {
        return Object.freeze({
          ok: false,
          kind: 'validation',
          message: 'The exact owned-seed campaign command was invalid. No job was staged.',
        });
      }
      const code = typeof error === 'object' && error !== null && 'code' in error
        ? (error as { readonly code?: unknown }).code : undefined;
      if (code === '42501') {
        return Object.freeze({
          ok: false,
          kind: 'forbidden',
          message: 'Owner or admin access is required for the owned-seed proof.',
        });
      }
      return Object.freeze({
        ok: false,
        kind: 'unavailable',
        message: 'The owned-seed job could not be staged safely. No provider call ran.',
      });
    }
  }
}

export function createPgPortalOwnedSeedCampaignService(input: {
  readonly webPool: Pick<Pool, 'query' | 'connect'>;
  readonly campaign: Pick<PropertyPredatorOwnedSeedCampaignService, 'stage'>;
}): PgPortalOwnedSeedCampaignService {
  return new PgPortalOwnedSeedCampaignService({
    principalResolver: createPgPortalCrmPrincipalResolver(input.webPool),
    campaign: input.campaign,
  });
}
