import { createHash } from 'node:crypto';
import type { DatabaseRequestContext } from '../db/rls.js';
import { requestDatabaseContext } from '../db/rls.js';
import {
  PropertyPredatorGeneratedDraftLifecycle,
  PropertyPredatorGeneratedDraftLifecycleError,
  type StagePropertyPredatorGeneratedDraftInput,
  type StagedPropertyPredatorGeneratedDraft,
} from '../company-content-adapter/property-predator-generation-approval.js';
import { PropertyPredatorGenerationBridgeError } from '../company-content-adapter/property-predator-generation.js';
import type { PortalCrmPrincipalResolver } from './crm-pg-service.js';
import type { PortalCompanyContentRequestIdentity } from './company-content-service.js';
import type { PortalCompanyContentWorkspaceAccessReader } from './company-content-pg-service.js';

export type PortalCampaignDraftOutcome =
  | Readonly<{ ok: true; draft: StagedPropertyPredatorGeneratedDraft }>
  | Readonly<{ ok: false; kind: 'unauthenticated' | 'forbidden' | 'validation' | 'conflict' | 'unavailable'; message: string }>;

export interface PortalCampaignDraftService {
  generateAndStage(
    identity: PortalCompanyContentRequestIdentity,
    input: StagePropertyPredatorGeneratedDraftInput,
  ): Promise<PortalCampaignDraftOutcome>;
}

function context(identity: PortalCompanyContentRequestIdentity, principal: {
  readonly userId: string; readonly workspaceId: string;
}): DatabaseRequestContext {
  return requestDatabaseContext({
    ...principal,
    requestId: identity.requestId,
    portalSessionTokenHash: createHash('sha256').update(identity.sessionToken).digest(),
  });
}

export class PgPortalCampaignDraftService implements PortalCampaignDraftService {
  constructor(private readonly dependencies: Readonly<{
    principalResolver: Pick<PortalCrmPrincipalResolver, 'resolve'>;
    accessReader: PortalCompanyContentWorkspaceAccessReader;
    lifecycle: Pick<PropertyPredatorGeneratedDraftLifecycle, 'generateAndStage'>;
  }>) {}

  async generateAndStage(
    identity: PortalCompanyContentRequestIdentity,
    input: StagePropertyPredatorGeneratedDraftInput,
  ): Promise<PortalCampaignDraftOutcome> {
    try {
      const principal = await this.dependencies.principalResolver.resolve(identity.sessionToken);
      if (!principal) return Object.freeze({ ok: false, kind: 'unauthenticated', message: 'This portal session is no longer active.' });
      const databaseContext = context(identity, principal);
      const access = await this.dependencies.accessReader.load(databaseContext);
      if (!access || access.workspaceId !== principal.workspaceId.toLowerCase()) {
        return Object.freeze({ ok: false, kind: 'forbidden', message: 'This workspace is not available to the current portal session.' });
      }
      if (!access.canManage) {
        return Object.freeze({ ok: false, kind: 'forbidden', message: 'Only a workspace owner or admin can create saved campaign drafts.' });
      }
      return Object.freeze({
        ok: true,
        draft: await this.dependencies.lifecycle.generateAndStage(databaseContext, input),
      });
    } catch (error) {
      if (error instanceof PropertyPredatorGenerationBridgeError
          && (error.code === 'invalid_request' || error.code === 'upstream_rejected')) {
        return Object.freeze({ ok: false, kind: 'validation', message: 'We could not use that source. Remove any private contact details or active HTML, then try again.' });
      }
      if (error instanceof PropertyPredatorGeneratedDraftLifecycleError) {
        return Object.freeze({ ok: false, kind: 'conflict', message: 'The campaign evidence changed while the draft was being saved. Refresh and try again.' });
      }
      return Object.freeze({ ok: false, kind: 'unavailable', message: 'The draft could not be saved safely. Nothing was approved, scheduled or posted.' });
    }
  }
}
