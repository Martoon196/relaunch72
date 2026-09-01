/**
 * Postgres implementation of the founder-only owned public-social seam.
 *
 * The clear Ayrshare Profile Key exists only as a parameter inside
 * `recordProfile`: it is handed straight to the existing owned-social
 * encryption contract and never assigned to a field, returned, thrown,
 * logged or rendered. The clear owned account and profile references are
 * reduced to digests in the same statement.
 *
 * Every write goes through the existing 0052 command boundary. Nothing here
 * can claim a worker lease or reach Ayrshare.
 */

import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { requestDatabaseContext, type DatabaseRequestContext } from '../db/rls.js';
import { InactivePortalSessionError } from '../db/transaction.js';
import { encryptOwnedProfileKey } from '../public-social-outbound/owned-live-foundation.js';
import type { OwnedPublicSocialLiveCommandService } from '../owned-public-social-pg/command-types.js';
import { PgOwnedSocialActivationReadinessProbe } from '../owned-social-activation-pg/probe.js';
import {
  deriveOwnedSocialStagingDigests,
  ownedSocialAccountDigest,
} from '../owned-social-activation/foundation.js';
import {
  createPgPortalCrmPrincipalResolver,
  type PortalCrmPrincipalResolver,
} from './crm-pg-service.js';
import type { PortalCrmRequestIdentity } from './crm-service.js';
import type {
  PortalOwnedSocialBindingService,
  PortalOwnedSocialFailure,
  PortalOwnedSocialReadinessResult,
  PortalOwnedSocialRecordProfileInput,
  PortalOwnedSocialRecordProfileResult,
  PortalOwnedSocialRevokeProfileInput,
  PortalOwnedSocialRevokeProfileResult,
  PortalOwnedSocialStageInput,
  PortalOwnedSocialStageResult,
} from './owned-social-binding-service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SAFE_SECRET = /^[\x21-\x7e]{8,500}$/u;
const REASON_CODE = /^[a-z][a-z0-9_.:-]{0,99}$/u;
const OPERATION_TAG = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/u;
const REFERENCE = /^[\x21-\x7e]{1,200}$/u;

function liveNetwork(value: unknown): value is 'instagram' | 'linkedin' | 'x' {
  return value === 'instagram' || value === 'linkedin' || value === 'x';
}

function failed(kind: PortalOwnedSocialFailure['kind']): PortalOwnedSocialFailure {
  return Object.freeze({ ok: false, kind });
}

function postgresCode(error: unknown): string | null {
  return error && typeof error === 'object' && 'code' in error
    && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code : null;
}

/** One shared mapping so no call site can invent a softer failure. */
function mapFailure(error: unknown): PortalOwnedSocialFailure {
  if (error instanceof InactivePortalSessionError) return failed('unauthenticated');
  const code = postgresCode(error);
  if (code === '42501') return failed('forbidden');
  if (code === '40001' || code === '23505') return failed('conflict');
  if (code === '22023' || code === '23514' || code === '23503') return failed('validation');
  return failed('unavailable');
}

function canonicalInstant(value: unknown): value is string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return false;
  return new Date(value).toISOString() === value;
}

function digestOf(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export interface PgPortalOwnedSocialBindingDependencies {
  readonly principalResolver: Pick<PortalCrmPrincipalResolver, 'resolve'>;
  readonly commandService: OwnedPublicSocialLiveCommandService;
  readonly readinessProbe: Pick<PgOwnedSocialActivationReadinessProbe, 'readiness'>;
  readonly providerConnectionId: string;
  /**
   * The owned-social profile-key encryption contract. Absent by default: the
   * portal then renders an honest disabled control instead of accepting a
   * Profile Key it could not seal.
   */
  readonly profileEncryption?: Readonly<{ key: Buffer; keyVersion: string }>;
}

export class PgPortalOwnedSocialBindingService implements PortalOwnedSocialBindingService {
  readonly providerConnectionId: string;
  readonly profileBindingComposed: boolean;
  readonly #dependencies: PgPortalOwnedSocialBindingDependencies;

  constructor(dependencies: PgPortalOwnedSocialBindingDependencies) {
    if (!UUID.test(dependencies.providerConnectionId)) {
      throw new Error('Owned social binding seam requires the exact provider connection id');
    }
    this.#dependencies = dependencies;
    this.providerConnectionId = dependencies.providerConnectionId;
    this.profileBindingComposed = Boolean(dependencies.profileEncryption);
  }

  async #context(identity: PortalCrmRequestIdentity): Promise<DatabaseRequestContext | null> {
    const principal = await this.#dependencies.principalResolver.resolve(identity.sessionToken);
    if (!principal) return null;
    return requestDatabaseContext({
      ...principal,
      requestId: identity.requestId,
      portalSessionTokenHash: createHash('sha256').update(identity.sessionToken).digest(),
    });
  }

  async recordProfile(
    identity: PortalCrmRequestIdentity,
    input: PortalOwnedSocialRecordProfileInput,
  ): Promise<PortalOwnedSocialRecordProfileResult> {
    const encryption = this.#dependencies.profileEncryption;
    if (!encryption) return failed('unavailable');
    const displayName = typeof input.displayName === 'string' ? input.displayName.trim() : '';
    const selectedNetwork = input.network ?? 'x';
    if (!UUID.test(input.profileId) || !liveNetwork(selectedNetwork)
        || displayName.length < 1 || displayName.length > 120
        || input.ownershipAttested !== true
        || input.oauthPermissions !== (selectedNetwork === 'x' ? 'read_write' : 'publish')
        || !REFERENCE.test(input.providerProfileReference)
        || !REFERENCE.test(input.ownedAccountReference)
        || !REFERENCE.test(input.oauthLinkEvidence)
        || !SAFE_SECRET.test(input.profileKey)
        || !canonicalInstant(input.linkedAt)
        || !canonicalInstant(input.evidenceObservedAt)
        || Date.parse(input.linkedAt) > Date.parse(input.evidenceObservedAt) + 5 * 60_000) {
      return failed('validation');
    }
    try {
      const context = await this.#context(identity);
      if (!context) return failed('unauthenticated');
      // The clear key crosses exactly this call and is never held anywhere else.
      const envelope = encryptOwnedProfileKey({
        workspaceId: context.workspaceId,
        connectionId: this.providerConnectionId,
        profileId: input.profileId.toLowerCase(),
        profileKey: input.profileKey,
        keyVersion: encryption.keyVersion,
        encryptionKey: encryption.key,
        network: selectedNetwork,
      });
      const outcome = await this.#dependencies.commandService.recordProfile(context as never, {
        ...(input.network === undefined ? {} : { network: selectedNetwork }),
        profileId: input.profileId.toLowerCase(),
        displayName,
        providerProfileRefSha256: digestOf(input.providerProfileReference.trim()),
        ownedAccountRefSha256: ownedSocialAccountDigest(input.ownedAccountReference),
        envelope,
        ...(input.network === undefined
          ? { xOAuthLinkEvidenceSha256: digestOf(input.oauthLinkEvidence.trim()) }
          : { providerLinkEvidenceSha256: digestOf(input.oauthLinkEvidence.trim()) }),
        linkedAt: input.linkedAt,
        evidenceObservedAt: input.evidenceObservedAt,
      });
      return Object.freeze({
        ok: true,
        profileId: outcome.profileId,
        providerEffects: 'none',
      });
    } catch (error) {
      return mapFailure(error);
    }
  }

  async revokeProfile(
    identity: PortalCrmRequestIdentity,
    input: PortalOwnedSocialRevokeProfileInput,
  ): Promise<PortalOwnedSocialRevokeProfileResult> {
    if (!UUID.test(input.profileId)
        || !REASON_CODE.test(input.reasonCode)
        || !REFERENCE.test(input.revocationEvidence)) {
      return failed('validation');
    }
    try {
      const context = await this.#context(identity);
      if (!context) return failed('unauthenticated');
      const outcome = await this.#dependencies.commandService.revokeProfile(context as never, {
        profileId: input.profileId.toLowerCase(),
        revocationEvidenceSha256: digestOf(input.revocationEvidence.trim()),
        reasonCode: input.reasonCode,
      });
      return Object.freeze({
        ok: true,
        revocationId: outcome.revocationId,
        providerEffects: 'none',
      });
    } catch (error) {
      return mapFailure(error);
    }
  }

  async readiness(
    identity: PortalCrmRequestIdentity,
    input: Omit<PortalOwnedSocialStageInput, 'operationTag'>,
  ): Promise<PortalOwnedSocialReadinessResult> {
    const selectedNetwork = input.network ?? 'x';
    if (!UUID.test(input.profileId) || !liveNetwork(selectedNetwork)
        || (input.planningIntentId !== undefined && !UUID.test(input.planningIntentId))
        || !UUID.test(input.contentItemId)
        || !UUID.test(input.contentVersionId) || !UUID.test(input.approvalRequestId)
        || !UUID.test(input.approvalDecisionId) || !UUID.test(input.sourceAttestationId)
        || !REFERENCE.test(input.ownedAccountReference)
        || (input.scheduledFor !== null && !canonicalInstant(input.scheduledFor))) {
      return failed('validation');
    }
    try {
      const context = await this.#context(identity);
      if (!context) return failed('unauthenticated');
      const report = await this.#dependencies.readinessProbe.readiness(context, {
        workspaceId: context.workspaceId,
        network: selectedNetwork,
        planningIntentId: input.planningIntentId?.toLowerCase(),
        providerConnectionId: this.providerConnectionId,
        profileId: input.profileId.toLowerCase(),
        contentItemId: input.contentItemId.toLowerCase(),
        contentVersionId: input.contentVersionId.toLowerCase(),
        approvalRequestId: input.approvalRequestId.toLowerCase(),
        approvalDecisionId: input.approvalDecisionId.toLowerCase(),
        sourceAttestationId: input.sourceAttestationId.toLowerCase(),
        expectedOwnedAccountSha256: ownedSocialAccountDigest(input.ownedAccountReference),
        scheduledFor: input.scheduledFor,
      });
      return Object.freeze({ ok: true, report });
    } catch (error) {
      return mapFailure(error);
    }
  }

  async stagePublication(
    identity: PortalCrmRequestIdentity,
    input: PortalOwnedSocialStageInput,
  ): Promise<PortalOwnedSocialStageResult> {
    const selectedNetwork = input.network ?? 'x';
    if (!UUID.test(input.profileId) || !liveNetwork(selectedNetwork)
        || (input.planningIntentId !== undefined && !UUID.test(input.planningIntentId))
        || ((selectedNetwork === 'instagram' || selectedNetwork === 'linkedin')
          && (input.planningIntentId === undefined || input.scheduledFor === null))
        || !UUID.test(input.contentItemId)
        || !UUID.test(input.contentVersionId) || !UUID.test(input.approvalRequestId)
        || !UUID.test(input.approvalDecisionId) || !UUID.test(input.sourceAttestationId)
        || !OPERATION_TAG.test(input.operationTag)
        || !REFERENCE.test(input.ownedAccountReference)
        || (input.scheduledFor !== null && !canonicalInstant(input.scheduledFor))) {
      return failed('validation');
    }
    try {
      const context = await this.#context(identity);
      if (!context) return failed('unauthenticated');
      // The database is the only authority on whether this may publish. A
      // blocked readiness verdict stops the enqueue before it is attempted.
      const target = {
        workspaceId: context.workspaceId,
        network: selectedNetwork,
        planningIntentId: input.planningIntentId?.toLowerCase(),
        providerConnectionId: this.providerConnectionId,
        profileId: input.profileId.toLowerCase(),
        contentItemId: input.contentItemId.toLowerCase(),
        contentVersionId: input.contentVersionId.toLowerCase(),
        approvalRequestId: input.approvalRequestId.toLowerCase(),
        approvalDecisionId: input.approvalDecisionId.toLowerCase(),
        sourceAttestationId: input.sourceAttestationId.toLowerCase(),
        expectedOwnedAccountSha256: ownedSocialAccountDigest(input.ownedAccountReference),
        scheduledFor: input.scheduledFor,
      } as const;
      // The legacy readiness report is X-specific. Instagram/LinkedIn are
      // proven atomically by enqueue_owned_social_job_v2 instead, against the
      // exact calendar intent and its approved media rows.
      if (selectedNetwork === 'x') {
        const readiness = await this.#dependencies.readinessProbe.readiness(context, target);
        if (readiness.result !== 'ready-for-separately-authorised-owned-test') {
          return failed('blocked');
        }
      }
      // Derived here, never accepted from the caller, so the key is provably
      // bound to this exact owned profile and approved version.
      const digests = deriveOwnedSocialStagingDigests(target, input.operationTag);
      const outcome = await this.#dependencies.commandService.enqueue(context as never, {
        ...(input.network === undefined ? {} : { network: selectedNetwork }),
        ...(input.planningIntentId === undefined
          ? {} : { planningIntentId: input.planningIntentId.toLowerCase() }),
        profileId: input.profileId.toLowerCase(),
        contentItemId: input.contentItemId.toLowerCase(),
        contentVersionId: input.contentVersionId.toLowerCase(),
        approvalRequestId: input.approvalRequestId.toLowerCase(),
        approvalDecisionId: input.approvalDecisionId.toLowerCase(),
        sourceAttestationId: input.sourceAttestationId.toLowerCase(),
        operationTag: input.operationTag,
        idempotencyKeySha256: digests.idempotencyKeySha256,
        requestSha256: digests.requestSha256,
        scheduledFor: input.scheduledFor,
      });
      return Object.freeze({
        ok: true,
        jobId: outcome.jobId,
        providerEffects: 'none',
        workerLeaseClaimed: false,
        idempotencyKeySha256: digests.idempotencyKeySha256,
        caps: Object.freeze({ daily: 1, monthly: 3 }),
      });
    } catch (error) {
      return mapFailure(error);
    }
  }
}

export function createPgPortalOwnedSocialBindingService(input: Readonly<{
  webPool: Pool;
  ownedSocialCommandPool: Pool;
  commandService: OwnedPublicSocialLiveCommandService;
  providerConnectionId: string;
  profileEncryption?: Readonly<{ key: Buffer; keyVersion: string }>;
}>): PgPortalOwnedSocialBindingService {
  return new PgPortalOwnedSocialBindingService({
    principalResolver: createPgPortalCrmPrincipalResolver(input.webPool),
    commandService: input.commandService,
    readinessProbe: new PgOwnedSocialActivationReadinessProbe({
      commandPool: input.ownedSocialCommandPool,
    }),
    providerConnectionId: input.providerConnectionId,
    ...(input.profileEncryption ? { profileEncryption: input.profileEncryption } : {}),
  });
}
