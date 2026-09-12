import { createHash } from 'node:crypto';
import type { DatabaseRequestContext } from '../db/rls.js';
import { requestDatabaseContext } from '../db/rls.js';
import {
  PropertyPredatorGeneratedDraftLifecycle,
  PropertyPredatorGeneratedDraftLifecycleError,
  type RefreshApprovedPropertyPredatorGeneratedSourceInput,
  type RefreshedApprovedPropertyPredatorGeneratedSource,
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

export type PortalGeneratedSourceRefreshOutcome =
  | Readonly<{ ok: true; result: RefreshedApprovedPropertyPredatorGeneratedSource }>
  | Readonly<{ ok: false; kind: 'unauthenticated' | 'forbidden' | 'validation' | 'conflict' | 'unavailable'; message: string }>;

export interface PortalCampaignDraftService {
  generateAndStage(
    identity: PortalCompanyContentRequestIdentity,
    input: StagePropertyPredatorGeneratedDraftInput,
  ): Promise<PortalCampaignDraftOutcome>;
  refreshApprovedSource?(
    identity: PortalCompanyContentRequestIdentity,
    input: RefreshApprovedPropertyPredatorGeneratedSourceInput,
  ): Promise<PortalGeneratedSourceRefreshOutcome>;
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

function safeCampaignDraftDiagnostic(error: unknown): string {
  if (!(error instanceof Error)) return 'unknown_error';
  const candidate = error as Error & { code?: unknown; validationStage?: unknown };
  const code = typeof candidate.code === 'string' ? ` code=${candidate.code.slice(0, 20)}` : '';
  const validationStage = typeof candidate.validationStage === 'string'
    ? ` validation_stage=${candidate.validationStage.slice(0, 40)}` : '';
  const message = error.message
    .replace(/(?:postgres(?:ql)?|https?):\/\/[^\s]+/giu, '[redacted-url]')
    .replace(/(?:password|token|secret|apikey|api_key)\s*[=:]\s*[^\s,;]+/giu, '$1=[redacted]')
    .replace(/[\r\n\t]+/gu, ' ')
    .slice(0, 300);
  return `${error.name}${code}${validationStage}${message ? ` message=${message}` : ''}`;
}

export class PgPortalCampaignDraftService implements PortalCampaignDraftService {
  constructor(private readonly dependencies: Readonly<{
    principalResolver: Pick<PortalCrmPrincipalResolver, 'resolve'>;
    accessReader: PortalCompanyContentWorkspaceAccessReader;
    lifecycle: Pick<PropertyPredatorGeneratedDraftLifecycle, 'generateAndStage'>
      & Partial<Pick<PropertyPredatorGeneratedDraftLifecycle, 'refreshApprovedSource'>>;
  }>) {}

  async generateAndStage(
    identity: PortalCompanyContentRequestIdentity,
    input: StagePropertyPredatorGeneratedDraftInput,
  ): Promise<PortalCampaignDraftOutcome> {
    let stage = 'resolve_principal';
    try {
      const principal = await this.dependencies.principalResolver.resolve(identity.sessionToken);
      if (!principal) return Object.freeze({ ok: false, kind: 'unauthenticated', message: 'This portal session is no longer active.' });
      const databaseContext = context(identity, principal);
      stage = 'load_access';
      const access = await this.dependencies.accessReader.load(databaseContext);
      if (!access || access.workspaceId !== principal.workspaceId.toLowerCase()) {
        return Object.freeze({ ok: false, kind: 'forbidden', message: 'This workspace is not available to the current portal session.' });
      }
      if (!access.canManage) {
        return Object.freeze({ ok: false, kind: 'forbidden', message: 'Only a workspace owner or admin can create saved campaign drafts.' });
      }
      stage = 'generate_and_persist';
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
      console.error(`[campaign-draft] stage=${stage} ${safeCampaignDraftDiagnostic(error)}`);
      return Object.freeze({ ok: false, kind: 'unavailable', message: 'The draft could not be saved safely. Nothing was approved, scheduled or posted.' });
    }
  }

  async refreshApprovedSource(
    identity: PortalCompanyContentRequestIdentity,
    input: RefreshApprovedPropertyPredatorGeneratedSourceInput,
  ): Promise<PortalGeneratedSourceRefreshOutcome> {
    try {
      if (!this.dependencies.lifecycle.refreshApprovedSource) {
        return Object.freeze({ ok: false, kind: 'unavailable', message: 'Generated source revalidation is not configured.' });
      }
      const principal = await this.dependencies.principalResolver.resolve(identity.sessionToken);
      if (!principal) return Object.freeze({ ok: false, kind: 'unauthenticated', message: 'This portal session is no longer active.' });
      const databaseContext = context(identity, principal);
      const access = await this.dependencies.accessReader.load(databaseContext);
      if (!access || access.workspaceId !== principal.workspaceId.toLowerCase()) {
        return Object.freeze({ ok: false, kind: 'forbidden', message: 'This workspace is not available to the current portal session.' });
      }
      if (!access.canManage) {
        return Object.freeze({ ok: false, kind: 'forbidden', message: 'Only a workspace owner or admin can refresh generated source proof.' });
      }
      return Object.freeze({
        ok: true,
        result: await this.dependencies.lifecycle.refreshApprovedSource(databaseContext, input),
      });
    } catch (error) {
      if (error instanceof PropertyPredatorGeneratedDraftLifecycleError) {
        return Object.freeze({ ok: false, kind: 'conflict', message: 'The approved version or its exact source changed. Refresh before trying again.' });
      }
      // Values only, never upstream messages, response bodies, credentials or post content.
      const diagnostic = error as { name?: unknown; code?: unknown; stage?: unknown; status?: unknown } | null;
      const token = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9_]{1,80}$/u.test(value) ? value : 'unknown';
      console.error(`[generated-source-refresh] name=${token(diagnostic?.name)} code=${token(diagnostic?.code)} stage=${token(diagnostic?.stage)} status=${Number.isInteger(diagnostic?.status) ? diagnostic?.status : 'unknown'}`);
      return Object.freeze({ ok: false, kind: 'unavailable', message: 'The exact generated source could not be revalidated. Nothing was scheduled or posted.' });
    }
  }
}
