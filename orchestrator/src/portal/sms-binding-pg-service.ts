/**
 * Postgres implementation of the founder-only Twilio SMS seam.
 *
 * Binding and revocation go through the 0061 founder functions; staging goes
 * through the existing 0056 command boundary. The Twilio account and
 * messaging-service identifiers are reduced to digests before they cross the
 * boundary and are never stored in clear, echoed, logged or returned.
 *
 * Staging refuses unless the 0061 readiness probe proves every dimension, and
 * derives both digests itself rather than accepting them from the caller.
 */

import { createHash } from 'node:crypto';
import type { Pool, QueryResultRow } from 'pg';
import { requestDatabaseContext, type DatabaseRequestContext } from '../db/rls.js';
import { InactivePortalSessionError, withTransaction } from '../db/transaction.js';
import type { PgTwilioSmsLiveCommandService } from '../sms-live-pg/command-service.js';
import { PgSmsActivationReadinessProbe } from '../sms-activation-pg/probe.js';
import {
  SMS_DAILY_SEGMENT_HARD_CAP,
  SMS_MONTHLY_SEGMENT_HARD_CAP,
  TWILIO_ACCOUNT_SID_SHAPE,
  TWILIO_MESSAGING_SERVICE_SID_SHAPE,
  deriveSmsStagingIdempotencyKey,
  ownedSmsRecipientDigest,
} from '../sms-activation/foundation.js';
import {
  createPgPortalCrmPrincipalResolver,
  type PortalCrmPrincipalResolver,
} from './crm-pg-service.js';
import type { PortalCrmRequestIdentity } from './crm-service.js';
import type {
  PortalSmsBindSenderInput,
  PortalSmsBindSenderResult,
  PortalSmsBindingService,
  PortalSmsFailure,
  PortalSmsReadinessResult,
  PortalSmsRevokeSenderInput,
  PortalSmsRevokeSenderResult,
  PortalSmsStageInput,
  PortalSmsStageResult,
} from './sms-binding-service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const UK_E164 = /^\+44[0-9]{9,10}$/u;
const REASON_CODE = /^[a-z][a-z0-9_.:-]{0,99}$/u;
const REFERENCE = /^[\x21-\x7e]{1,200}$/u;
const PURPOSE = /^[a-z][a-z0-9_.-]{0,99}$/u;

interface IdRow extends QueryResultRow { readonly id: unknown }

function failed(kind: PortalSmsFailure['kind']): PortalSmsFailure {
  return Object.freeze({ ok: false, kind });
}

function postgresCode(error: unknown): string | null {
  return error && typeof error === 'object' && 'code' in error
    && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code : null;
}

/** One shared mapping so no call site can invent a softer failure. */
function mapFailure(error: unknown): PortalSmsFailure {
  if (error instanceof InactivePortalSessionError) return failed('unauthenticated');
  const code = postgresCode(error);
  if (code === '42501') return failed('forbidden');
  if (code === '40001' || code === '23505') return failed('conflict');
  if (code === '22023' || code === '23514' || code === '23503' || code === '54000') {
    return failed('validation');
  }
  return failed('unavailable');
}

function canonicalInstant(value: unknown): value is string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return false;
  return new Date(value).toISOString() === value;
}

function digestOf(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

export interface PgPortalSmsBindingDependencies {
  readonly principalResolver: Pick<PortalCrmPrincipalResolver, 'resolve'>;
  readonly commandPool: Pick<Pool, 'connect'>;
  readonly commandService: Pick<PgTwilioSmsLiveCommandService, 'authorizeAndEnqueue'>;
  readonly readinessProbe: Pick<PgSmsActivationReadinessProbe, 'readiness' | 'requestDigest'>;
  readonly workspaceId: string;
}

export class PgPortalSmsBindingService implements PortalSmsBindingService {
  readonly workspaceId: string;
  readonly #dependencies: PgPortalSmsBindingDependencies;

  constructor(dependencies: PgPortalSmsBindingDependencies) {
    if (!UUID.test(dependencies.workspaceId)) {
      throw new Error('Twilio SMS binding seam requires the exact workspace id');
    }
    this.#dependencies = dependencies;
    this.workspaceId = dependencies.workspaceId;
  }

  async #context(identity: PortalCrmRequestIdentity): Promise<DatabaseRequestContext | null> {
    const principal = await this.#dependencies.principalResolver.resolve(identity.sessionToken);
    if (!principal) return null;
    if (principal.workspaceId !== this.workspaceId) return null;
    return requestDatabaseContext({
      ...principal,
      requestId: identity.requestId,
      portalSessionTokenHash: createHash('sha256').update(identity.sessionToken).digest(),
    });
  }

  async bindSender(
    identity: PortalCrmRequestIdentity,
    input: PortalSmsBindSenderInput,
  ): Promise<PortalSmsBindSenderResult> {
    const displayName = typeof input.displayName === 'string' ? input.displayName.trim() : '';
    if (!UUID.test(input.bindingId) || !UUID.test(input.providerConnectionId)
        || !UUID.test(input.channelEndpointId)
        || displayName.length < 1 || displayName.length > 120
        || input.ownershipAttested !== true
        || !TWILIO_ACCOUNT_SID_SHAPE.test(input.accountSid.trim())
        || !TWILIO_MESSAGING_SERVICE_SID_SHAPE.test(input.messagingServiceSid.trim())
        || !UK_E164.test(input.senderNumber.trim())
        || !REFERENCE.test(input.regulatoryEvidence)
        || !REFERENCE.test(input.ownershipEvidence)
        || !canonicalInstant(input.evidenceObservedAt)) {
      return failed('validation');
    }
    try {
      const context = await this.#context(identity);
      if (!context) return failed('unauthenticated');
      const id = await withTransaction(this.#dependencies.commandPool, context,
        async (client) => {
          const result = await client.query<IdRow>(
            `/* portal.twilio-sms.record-binding */
             SELECT app_private.record_sms_live_binding(
               $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::text,
               $6::bytea, $7::bytea, $8::text, $9::bytea, $10::bytea,
               $11::timestamptz
             ) AS id`,
            [context.workspaceId, input.bindingId.toLowerCase(),
              input.providerConnectionId.toLowerCase(),
              input.channelEndpointId.toLowerCase(), displayName,
              digestOf(input.accountSid.trim()),
              digestOf(input.messagingServiceSid.trim()),
              input.senderNumber.trim(),
              digestOf(input.regulatoryEvidence.trim()),
              digestOf(input.ownershipEvidence.trim()),
              input.evidenceObservedAt],
          );
          const value = result.rows[0]?.id;
          if (result.rows.length !== 1 || typeof value !== 'string' || !UUID.test(value)) {
            throw new Error('Twilio SMS binding returned invalid evidence');
          }
          return value;
        }, { isolation: 'serializable' });
      return Object.freeze({ ok: true, bindingId: id, providerEffects: 'none' });
    } catch (error) {
      return mapFailure(error);
    }
  }

  async revokeSender(
    identity: PortalCrmRequestIdentity,
    input: PortalSmsRevokeSenderInput,
  ): Promise<PortalSmsRevokeSenderResult> {
    if (!UUID.test(input.bindingId) || !REASON_CODE.test(input.reasonCode)
        || !REFERENCE.test(input.revocationEvidence)) {
      return failed('validation');
    }
    try {
      const context = await this.#context(identity);
      if (!context) return failed('unauthenticated');
      const id = await withTransaction(this.#dependencies.commandPool, context,
        async (client) => {
          const result = await client.query<IdRow>(
            `/* portal.twilio-sms.revoke-binding */
             SELECT app_private.revoke_sms_live_binding(
               $1::uuid, $2::uuid, $3::text, $4::bytea
             ) AS id`,
            [context.workspaceId, input.bindingId.toLowerCase(), input.reasonCode,
              digestOf(input.revocationEvidence.trim())],
          );
          const value = result.rows[0]?.id;
          if (result.rows.length !== 1 || typeof value !== 'string' || !UUID.test(value)) {
            throw new Error('Twilio SMS revocation returned invalid evidence');
          }
          return value;
        }, { isolation: 'serializable' });
      return Object.freeze({ ok: true, revocationId: id, providerEffects: 'none' });
    } catch (error) {
      return mapFailure(error);
    }
  }

  async readiness(
    identity: PortalCrmRequestIdentity,
    input: Readonly<{
      bindingId: string; messageVersionId: string; messageApprovalDecisionId: string;
      contactId: string; contactPointId: string; consentEventId: string;
      purpose: string; ownedRecipient: string;
    }>,
  ): Promise<PortalSmsReadinessResult> {
    if (!UUID.test(input.bindingId) || !UUID.test(input.messageVersionId)
        || !UUID.test(input.messageApprovalDecisionId) || !UUID.test(input.contactId)
        || !UUID.test(input.contactPointId) || !UUID.test(input.consentEventId)
        || !PURPOSE.test(input.purpose) || !UK_E164.test(input.ownedRecipient.trim())) {
      return failed('validation');
    }
    try {
      const context = await this.#context(identity);
      if (!context) return failed('unauthenticated');
      const report = await this.#dependencies.readinessProbe.readiness(context, {
        workspaceId: context.workspaceId,
        bindingId: input.bindingId.toLowerCase(),
        messageVersionId: input.messageVersionId.toLowerCase(),
        messageApprovalDecisionId: input.messageApprovalDecisionId.toLowerCase(),
        contactId: input.contactId.toLowerCase(),
        contactPointId: input.contactPointId.toLowerCase(),
        consentEventId: input.consentEventId.toLowerCase(),
        purpose: input.purpose,
        expectedRecipientSha256: ownedSmsRecipientDigest(input.ownedRecipient),
      });
      return Object.freeze({ ok: true, report });
    } catch (error) {
      return mapFailure(error);
    }
  }

  async stageOwnedTest(
    identity: PortalCrmRequestIdentity,
    input: PortalSmsStageInput,
  ): Promise<PortalSmsStageResult> {
    const identifiers = [
      input.bindingId, input.providerConnectionId, input.channelEndpointId,
      input.messageVersionId, input.messageApprovalRequestId,
      input.messageApprovalDecisionId, input.contactId, input.contactPointId,
      input.consentEventId, input.complianceSubjectId, input.policyPublicationEventId,
      input.pecrSenderDecisionEventId, input.pecrInstigatorDecisionEventId,
      input.permissionUseReceiptId, input.providerOperationId,
      input.messageDeliveryId, input.correlationId,
    ];
    if (identifiers.some((value) => !UUID.test(value))
        || !canonicalInstant(input.authorityValidUntil)
        || !Number.isSafeInteger(input.expectedSegmentCount)
        || input.expectedSegmentCount < 1
        || input.expectedSegmentCount > SMS_DAILY_SEGMENT_HARD_CAP
        || !PURPOSE.test(input.purpose)
        || !UK_E164.test(input.ownedRecipient.trim())) {
      return failed('validation');
    }
    try {
      const context = await this.#context(identity);
      if (!context) return failed('unauthenticated');
      // The database is the only authority on whether this may send.
      const report = await this.#dependencies.readinessProbe.readiness(context, {
        workspaceId: context.workspaceId,
        bindingId: input.bindingId.toLowerCase(),
        messageVersionId: input.messageVersionId.toLowerCase(),
        messageApprovalDecisionId: input.messageApprovalDecisionId.toLowerCase(),
        contactId: input.contactId.toLowerCase(),
        contactPointId: input.contactPointId.toLowerCase(),
        consentEventId: input.consentEventId.toLowerCase(),
        purpose: input.purpose,
        expectedRecipientSha256: ownedSmsRecipientDigest(input.ownedRecipient),
      });
      if (report.result !== 'ready-for-separately-authorised-owned-test') {
        return failed('blocked');
      }
      // Derived here, never accepted from the caller. The request digest must
      // come from the database because 0056 re-computes it from values the
      // table-blind command identity cannot read.
      const idempotencyKeySha256 = deriveSmsStagingIdempotencyKey({
        workspaceId: context.workspaceId,
        bindingId: input.bindingId.toLowerCase(),
        messageVersionId: input.messageVersionId.toLowerCase(),
        messageApprovalDecisionId: input.messageApprovalDecisionId.toLowerCase(),
        contactId: input.contactId.toLowerCase(),
        contactPointId: input.contactPointId.toLowerCase(),
        consentEventId: input.consentEventId.toLowerCase(),
        purpose: input.purpose,
        expectedRecipientSha256: ownedSmsRecipientDigest(input.ownedRecipient),
      }, input.providerConnectionId.toLowerCase(), input.authorityValidUntil);
      const requestSha256 = await this.#dependencies.readinessProbe.requestDigest(context, {
        providerConnectionId: input.providerConnectionId.toLowerCase(),
        messageVersionId: input.messageVersionId.toLowerCase(),
        messageApprovalRequestId: input.messageApprovalRequestId.toLowerCase(),
        messageApprovalDecisionId: input.messageApprovalDecisionId.toLowerCase(),
        channelEndpointId: input.channelEndpointId.toLowerCase(),
        consentEventId: input.consentEventId.toLowerCase(),
        complianceSubjectId: input.complianceSubjectId.toLowerCase(),
        policyPublicationEventId: input.policyPublicationEventId.toLowerCase(),
        pecrSenderDecisionEventId: input.pecrSenderDecisionEventId.toLowerCase(),
        pecrInstigatorDecisionEventId: input.pecrInstigatorDecisionEventId.toLowerCase(),
        permissionUseReceiptId: input.permissionUseReceiptId.toLowerCase(),
        authorityValidUntil: input.authorityValidUntil,
        providerOperationId: input.providerOperationId.toLowerCase(),
        messageDeliveryId: input.messageDeliveryId.toLowerCase(),
        correlationId: input.correlationId.toLowerCase(),
        idempotencyKeySha256,
      });
      const outcome = await this.#dependencies.commandService.authorizeAndEnqueue(
        context as never,
        {
          messageVersionId: input.messageVersionId.toLowerCase(),
          messageApprovalRequestId: input.messageApprovalRequestId.toLowerCase(),
          messageApprovalDecisionId: input.messageApprovalDecisionId.toLowerCase(),
          channelEndpointId: input.channelEndpointId.toLowerCase(),
          consentEventId: input.consentEventId.toLowerCase(),
          complianceSubjectId: input.complianceSubjectId.toLowerCase(),
          policyPublicationEventId: input.policyPublicationEventId.toLowerCase(),
          pecrSenderDecisionEventId: input.pecrSenderDecisionEventId.toLowerCase(),
          pecrInstigatorDecisionEventId: input.pecrInstigatorDecisionEventId.toLowerCase(),
          permissionUseReceiptId: input.permissionUseReceiptId.toLowerCase(),
          authorityValidUntil: input.authorityValidUntil,
          providerOperationId: input.providerOperationId.toLowerCase(),
          messageDeliveryId: input.messageDeliveryId.toLowerCase(),
          correlationId: input.correlationId.toLowerCase(),
          idempotencyKeySha256,
          requestSha256,
          expectedSegmentCount: input.expectedSegmentCount,
        },
      );
      return Object.freeze({
        ok: true,
        jobId: outcome.jobId,
        disposition: outcome.disposition,
        providerEffects: 'none',
        workerLeaseClaimed: false,
        caps: Object.freeze({
          dailySegments: SMS_DAILY_SEGMENT_HARD_CAP,
          monthlySegments: SMS_MONTHLY_SEGMENT_HARD_CAP,
        }),
      });
    } catch (error) {
      return mapFailure(error);
    }
  }
}

export function createPgPortalSmsBindingService(input: Readonly<{
  webPool: Pool;
  smsCommandPool: Pool;
  commandService: Pick<PgTwilioSmsLiveCommandService, 'authorizeAndEnqueue'>;
  workspaceId: string;
}>): PgPortalSmsBindingService {
  return new PgPortalSmsBindingService({
    principalResolver: createPgPortalCrmPrincipalResolver(input.webPool),
    commandPool: input.smsCommandPool,
    commandService: input.commandService,
    readinessProbe: new PgSmsActivationReadinessProbe({ commandPool: input.smsCommandPool }),
    workspaceId: input.workspaceId,
  });
}
