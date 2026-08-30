/**
 * Postgres implementation of the founder customer-email pilot seam.
 *
 * Every rule that matters is enforced by the 0064 functions: active owner/admin
 * membership, the exact contact binding, command-key idempotency and conflict,
 * the derived endpoint digest, and the structural isolation that stops an
 * endpoint attach creating a contact, an opportunity, a consent or a
 * suppression release. This class validates shape, hands over the exact tuple,
 * and maps failures without softening any of them.
 *
 * The workspace comes from the resolved session, never from the request.
 */

import { createHash } from 'node:crypto';
import type { Pool, QueryResultRow } from 'pg';
import { requestDatabaseContext, type DatabaseRequestContext } from '../db/rls.js';
import { InactivePortalSessionError, withTransaction } from '../db/transaction.js';
import { CustomerEmailLivePgContractError }
  from '../customer-email-live-pg/types.js';
import type { CustomerEmailLiveCommandService }
  from '../customer-email-live-pg/types.js';
import {
  FounderEmailPilotError,
  buildFounderEmailPilotReadinessReport,
  deriveFounderEmailPilotIdentifiers,
  deriveFounderPilotCommandKey,
  founderEmailPilotEvidenceDigest,
  isCanonicalInstant,
  isFounderPilotPurpose,
  parseAttachContactEmailEndpoint,
  type FounderEmailPilotDimensionResult,
  type FounderEmailPilotEvidence,
  type FounderEmailPilotIdentifiers,
} from '../founder-email-pilot/foundation.js';
import { EMAIL_PILOT_PREVIEW_TTL_MS } from './founder-email-pilot-actions.js';
import {
  createPgPortalCrmPrincipalResolver,
  type PortalCrmPrincipalResolver,
} from './crm-pg-service.js';
import type { PortalCrmRequestIdentity } from './crm-service.js';
import type {
  AttachEndpointInput,
  AttachEndpointResult,
  AuthoriseInput,
  AuthoriseResult,
  FounderEmailPilotFailure,
  FounderEmailPilotPreview,
  PilotReadinessInput,
  PilotReadinessResult,
  PortalFounderEmailPilotService,
  ResolveAuthorisationInput,
  ResolveAuthorisationResult,
} from './founder-email-pilot-service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

/** Caps the 0054 rail enforces. Restated so the preview cannot drift silently. */
export const FOUNDER_EMAIL_DAILY_CAP = 10;
export const FOUNDER_EMAIL_MONTHLY_CAP = 50;

interface AttachRow extends QueryResultRow {
  readonly disposition: unknown;
  readonly contact_point_id: unknown;
  readonly receipt_id: unknown;
}

interface ReadinessRow extends QueryResultRow {
  readonly dimension: unknown;
  readonly ready: unknown;
  readonly blocker_code: unknown;
}

interface PreviewRow extends QueryResultRow {
  readonly recipient_email: unknown;
  readonly recipient_verified: unknown;
  readonly daily_used: unknown;
  readonly monthly_used: unknown;
}

interface EvidenceRow extends QueryResultRow { readonly [column: string]: unknown }

interface DigestRow extends QueryResultRow { readonly request_sha256: unknown }

const SHA256 = /^[0-9a-f]{64}$/u;

/** Identifier columns, in the order the 0064 resolver returns them. */
const EVIDENCE_UUID_COLUMNS = Object.freeze([
  ['campaign_template_version_id', 'campaignTemplateVersionId'],
  ['campaign_template_step_id', 'campaignTemplateStepId'],
  ['campaign_approval_request_id', 'campaignApprovalRequestId'],
  ['campaign_approval_decision_id', 'campaignApprovalDecisionId'],
  ['message_version_id', 'messageVersionId'],
  ['message_approval_request_id', 'messageApprovalRequestId'],
  ['message_approval_decision_id', 'messageApprovalDecisionId'],
  ['channel_endpoint_id', 'channelEndpointId'],
  ['consent_event_id', 'consentEventId'],
  ['compliance_subject_id', 'complianceSubjectId'],
  ['policy_publication_event_id', 'policyPublicationEventId'],
  ['pecr_sender_decision_event_id', 'pecrSenderDecisionEventId'],
  ['pecr_instigator_decision_event_id', 'pecrInstigatorDecisionEventId'],
  ['permission_use_receipt_id', 'permissionUseReceiptId'],
] as const);

/**
 * Read the resolver's row as untrusted.
 *
 * A partially resolved tuple must throw rather than reach the enqueue with a
 * missing identifier: the enqueue would refuse it anyway, but the founder would
 * be told the wrong reason.
 */
function parseEvidenceRow(row: EvidenceRow): FounderEmailPilotEvidence {
  const identifiers: Record<string, string> = {};
  for (const [column, field] of EVIDENCE_UUID_COLUMNS) {
    const value = row[column];
    if (typeof value !== 'string' || !UUID.test(value)) {
      throw new FounderEmailPilotError(`resolved ${column} is invalid`);
    }
    identifiers[field] = value.toLowerCase();
  }
  const stepDigest = row.campaign_step_content_sha256;
  const recipient = row.recipient_email;
  const subject = row.subject;
  const body = row.body_text;
  const campaignVersion = Number(row.campaign_version_no);
  const messageVersion = Number(row.message_version_number);
  if (typeof stepDigest !== 'string' || !SHA256.test(stepDigest)
      || typeof recipient !== 'string' || recipient.length === 0
      || typeof subject !== 'string' || subject.length === 0
      || typeof body !== 'string' || body.length === 0
      || !Number.isInteger(campaignVersion) || !Number.isInteger(messageVersion)) {
    throw new FounderEmailPilotError('resolved evidence is invalid');
  }
  return Object.freeze({
    ...(identifiers as unknown as Omit<
      FounderEmailPilotEvidence,
      'campaignStepContentSha256' | 'campaignVersionNo' | 'messageVersionNumber'
      | 'recipientEmail' | 'subject' | 'bodyText'
    >),
    campaignStepContentSha256: stepDigest,
    campaignVersionNo: campaignVersion,
    messageVersionNumber: messageVersion,
    recipientEmail: recipient,
    subject,
    bodyText: body,
  });
}

function failed(kind: FounderEmailPilotFailure['kind']): FounderEmailPilotFailure {
  return Object.freeze({ ok: false, kind });
}

function postgresCode(error: unknown): string | null {
  return error && typeof error === 'object' && 'code' in error
    && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code : null;
}

/** One shared mapping so no call site can invent a softer failure. */
function mapFailure(error: unknown): FounderEmailPilotFailure {
  if (error instanceof InactivePortalSessionError) return failed('unauthenticated');
  if (error instanceof FounderEmailPilotError) return failed('validation');
  if (error instanceof CustomerEmailLivePgContractError) return failed('validation');
  const code = postgresCode(error);
  if (code === '42501') return failed('forbidden');
  // The rail raises 54000 when a cap is already spent. That is a blocker the
  // founder can act on, not an outage and not a conflict.
  if (code === '54000') return failed('blocked');
  if (code === '23505' || code === '40001') return failed('conflict');
  if (code === '22023' || code === '23514' || code === '23503') return failed('validation');
  return failed('unavailable');
}

export interface PgPortalFounderEmailPilotDependencies {
  readonly principalResolver: Pick<PortalCrmPrincipalResolver, 'resolve'>;
  readonly commandPool: Pick<Pool, 'connect'>;
  /** The exact live Mailgun EU connection this pilot may use. */
  readonly providerConnectionId: string;
  /**
   * The existing 0054 capped enqueue, on its own least-privilege identity.
   * This seam composes it; it does not reimplement or bypass it.
   */
  readonly commandService: CustomerEmailLiveCommandService;
  readonly now: () => number;
}

export class PgPortalFounderEmailPilotService implements PortalFounderEmailPilotService {
  readonly #dependencies: PgPortalFounderEmailPilotDependencies;

  constructor(dependencies: PgPortalFounderEmailPilotDependencies) {
    if (!UUID.test(dependencies.providerConnectionId)) {
      throw new Error('founder email pilot requires the exact provider connection id');
    }
    this.#dependencies = dependencies;
  }

  /**
   * Resolve the session into a database context.
   *
   * `requestId` is overridden for the pilot authorisation: the enqueue folds the
   * request id into the digest it compares, so preview and authorisation must
   * run under the same derived id or a genuine replay would read as a conflict.
   */
  async #context(
    identity: PortalCrmRequestIdentity,
    requestId?: string,
  ): Promise<{ context: DatabaseRequestContext; workspaceId: string } | null> {
    const principal = await this.#dependencies.principalResolver.resolve(identity.sessionToken);
    if (!principal || !UUID.test(principal.workspaceId)) return null;
    return {
      workspaceId: principal.workspaceId,
      context: requestDatabaseContext({
        ...principal,
        requestId: requestId ?? identity.requestId,
        portalSessionTokenHash: createHash('sha256').update(identity.sessionToken).digest(),
      }),
    };
  }

  /** One read-only resolution, shared by the preview and the authorisation. */
  async #resolveEvidence(
    context: DatabaseRequestContext,
    workspaceId: string,
    input: Readonly<{ contactId: string; contactPointId: string; purpose: string }>,
    authorityValidUntil: string,
  ): Promise<FounderEmailPilotEvidence | null> {
    const row = await withTransaction(
      this.#dependencies.commandPool, context,
      async (client) => {
        const result = await client.query<EvidenceRow>(
          `/* portal.founder-email-pilot.resolve-evidence */
           SELECT campaign_template_version_id::text, campaign_template_step_id::text,
                  campaign_step_content_sha256, campaign_approval_request_id::text,
                  campaign_approval_decision_id::text, campaign_version_no,
                  message_version_id::text, message_approval_request_id::text,
                  message_approval_decision_id::text, message_version_number,
                  channel_endpoint_id::text, consent_event_id::text,
                  compliance_subject_id::text, policy_publication_event_id::text,
                  pecr_sender_decision_event_id::text,
                  pecr_instigator_decision_event_id::text,
                  permission_use_receipt_id::text, recipient_email, subject, body_text
           FROM app_private.resolve_customer_email_pilot_evidence(
             $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::text, $6::timestamptz
           )`,
          [
            workspaceId, this.#dependencies.providerConnectionId,
            input.contactId.toLowerCase(), input.contactPointId.toLowerCase(),
            input.purpose, authorityValidUntil,
          ],
        );
        // No row means the tuple did not resolve. More than one would mean the
        // resolver stopped being the single answer it is declared to be.
        if (result.rows.length > 1) throw new FounderEmailPilotError('evidence is ambiguous');
        return result.rows[0] ?? null;
      },
      { readOnly: true },
    );
    return row === null ? null : parseEvidenceRow(row);
  }

  async attachEndpoint(
    identity: PortalCrmRequestIdentity,
    input: AttachEndpointInput,
  ): Promise<AttachEndpointResult> {
    try {
      // Shape first, so an unconfirmed or malformed submission never opens a
      // transaction and never reaches the contact record.
      const command = parseAttachContactEmailEndpoint(input);
      if (!UUID.test(input.commandKey)) return failed('validation');
      const resolved = await this.#context(identity);
      if (!resolved) return failed('unauthenticated');
      const commandKeyDigest = Buffer.from(
        deriveFounderPilotCommandKey(
          'contact-endpoint-attach', resolved.workspaceId, input.commandKey,
        ),
        'hex',
      );
      const row = await withTransaction(
        this.#dependencies.commandPool, resolved.context,
        async (client) => {
          const result = await client.query<AttachRow>(
            `/* portal.founder-email-pilot.attach-endpoint */
             SELECT disposition, contact_point_id::text, receipt_id::text
             FROM app_private.attach_verified_contact_email_endpoint(
               $1::uuid, $2::uuid, $3::text, $4::text, $5::text, $6::text,
               $7::timestamptz, $8::bytea
             )`,
            [
              resolved.workspaceId,
              command.contactId,
              command.email,
              command.label,
              command.evidenceSource,
              command.evidenceReference,
              command.verifiedAt,
              commandKeyDigest,
            ],
          );
          return result.rows[0] ?? null;
        });
      if (!row
        || typeof row.contact_point_id !== 'string'
        || typeof row.receipt_id !== 'string') {
        return failed('unavailable');
      }
      return Object.freeze({
        ok: true as const,
        disposition: row.disposition === 'replayed' ? 'replayed' as const : 'applied' as const,
        contactPointId: row.contact_point_id,
        receiptId: row.receipt_id,
        consentRecorded: 'none' as const,
      });
    } catch (error) {
      return mapFailure(error);
    }
  }

  async readiness(
    identity: PortalCrmRequestIdentity,
    input: PilotReadinessInput,
  ): Promise<PilotReadinessResult> {
    try {
      if (!UUID.test(input.contactId) || !UUID.test(input.contactPointId)
        || !isFounderPilotPurpose(input.purpose)) {
        return failed('validation');
      }
      const resolved = await this.#context(identity);
      if (!resolved) return failed('unauthenticated');
      const { rows, preview } = await withTransaction(
        this.#dependencies.commandPool, resolved.context,
        async (client) => {
          const probe = await client.query<ReadinessRow>(
            `/* portal.founder-email-pilot.readiness */
             SELECT dimension, ready, blocker_code
             FROM app_private.customer_email_pilot_readiness(
               $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::text
             )`,
            [
              resolved.workspaceId,
              this.#dependencies.providerConnectionId,
              input.contactId.toLowerCase(),
              input.contactPointId.toLowerCase(),
              input.purpose,
            ],
          );
          // The exact recipient the founder must confirm before authorising.
          const shown = await client.query<PreviewRow>(
            `/* portal.founder-email-pilot.preview */
             SELECT point.value AS recipient_email,
                    point.is_verified AS recipient_verified,
                    (SELECT count(*) FROM app.property_predator_customer_email_jobs AS day_job
                      WHERE day_job.workspace_id = $1::uuid
                        AND day_job.provider_connection_id = $2::uuid
                        AND day_job.utc_day = (statement_timestamp() AT TIME ZONE 'UTC')::date
                        AND day_job.state <> 'cancelled')::int AS daily_used,
                    (SELECT count(*) FROM app.property_predator_customer_email_jobs AS month_job
                      WHERE month_job.workspace_id = $1::uuid
                        AND month_job.provider_connection_id = $2::uuid
                        AND month_job.utc_month =
                          date_trunc('month', statement_timestamp() AT TIME ZONE 'UTC')::date
                        AND month_job.state <> 'cancelled')::int AS monthly_used
             FROM app.contact_points AS point
             WHERE point.workspace_id = $1::uuid
               AND point.id = $4::uuid
               AND point.contact_id = $3::uuid
               AND point.kind = 'email'
               AND point.deleted_at IS NULL`,
            [
              resolved.workspaceId,
              this.#dependencies.providerConnectionId,
              input.contactId.toLowerCase(),
              input.contactPointId.toLowerCase(),
            ],
          );
          return { rows: probe.rows, preview: shown.rows[0] ?? null };
        },
        { readOnly: true },
      );
      const report = buildFounderEmailPilotReadinessReport(
        rows.map((row): FounderEmailPilotDimensionResult => ({
          dimension: row.dimension as never,
          ready: row.ready === true,
          blockerCode: row.blocker_code === null ? null : row.blocker_code as never,
        })),
      );
      return Object.freeze({
        ok: true as const,
        report,
        preview: preview === null ? null : Object.freeze({
          recipientEmail: String(preview.recipient_email),
          recipientVerified: preview.recipient_verified === true,
          purpose: input.purpose,
          dailyUsed: Number(preview.daily_used),
          dailyCap: FOUNDER_EMAIL_DAILY_CAP,
          monthlyUsed: Number(preview.monthly_used),
          monthlyCap: FOUNDER_EMAIL_MONTHLY_CAP,
        }) satisfies FounderEmailPilotPreview,
      });
    } catch (error) {
      return mapFailure(error);
    }
  }

  async resolveAuthorisation(
    identity: PortalCrmRequestIdentity,
    input: ResolveAuthorisationInput,
  ): Promise<ResolveAuthorisationResult> {
    try {
      if (!UUID.test(input.contactId) || !UUID.test(input.contactPointId)
        || !UUID.test(input.commandKey) || !isFounderPilotPurpose(input.purpose)) {
        return failed('validation');
      }
      const resolved = await this.#context(identity);
      if (!resolved) return failed('unauthenticated');
      const identifiers = deriveFounderEmailPilotIdentifiers(
        resolved.workspaceId, input.commandKey,
      );
      // Preview and authorisation must share the derived request id, because
      // the enqueue digest and the permission-use receipt are both bound to it.
      const bound = await this.#context(identity, identifiers.requestId);
      if (!bound) return failed('unauthenticated');
      const authorityValidUntil = new Date(
        this.#dependencies.now() + EMAIL_PILOT_PREVIEW_TTL_MS,
      ).toISOString();
      const evidence = await this.#resolveEvidence(
        bound.context, bound.workspaceId, input, authorityValidUntil,
      );
      if (evidence === null) {
        return Object.freeze({ ok: true as const, preview: null });
      }
      return Object.freeze({
        ok: true as const,
        preview: Object.freeze({
          evidence,
          evidenceDigest: founderEmailPilotEvidenceDigest(evidence),
          authorityValidUntil,
          identifiers,
        }),
      });
    } catch (error) {
      return mapFailure(error);
    }
  }

  async authorise(
    identity: PortalCrmRequestIdentity,
    input: AuthoriseInput,
  ): Promise<AuthoriseResult> {
    try {
      if (input.operatorConfirmed !== true
        || !UUID.test(input.contactId) || !UUID.test(input.contactPointId)
        || !UUID.test(input.commandKey) || !isFounderPilotPurpose(input.purpose)
        || !SHA256.test(input.evidenceDigest)
        || !isCanonicalInstant(input.authorityValidUntil)) {
        return failed('validation');
      }
      const session = await this.#context(identity);
      if (!session) return failed('unauthenticated');
      // The enqueue is bound to one workspace at construction. A session from
      // any other workspace is refused here rather than at the database, so the
      // refusal cannot be mistaken for a missing piece of evidence.
      if (session.workspaceId.toLowerCase()
        !== this.#dependencies.commandService.workspaceId.toLowerCase()) {
        return failed('forbidden');
      }
      const identifiers = deriveFounderEmailPilotIdentifiers(
        session.workspaceId, input.commandKey,
      );
      const bound = await this.#context(identity, identifiers.requestId);
      if (!bound) return failed('unauthenticated');

      // Re-resolve rather than trust the preview: approvals, consent and
      // suppression can all change between reading a message and authorising it.
      const evidence = await this.#resolveEvidence(
        bound.context, bound.workspaceId, input, input.authorityValidUntil,
      );
      if (evidence === null) return failed('blocked');
      if (founderEmailPilotEvidenceDigest(evidence) !== input.evidenceDigest) {
        return Object.freeze({ ok: false as const, kind: 'stale_preview' as const });
      }

      const requestSha256 = await this.#requestDigest(
        bound.context, bound.workspaceId, evidence, identifiers, input.authorityValidUntil,
      );
      const outcome = await this.#dependencies.commandService.authorizeAndEnqueue(
        {
          ...bound.context,
          actorKind: 'user',
          userId: bound.context.userId as string,
          portalSessionTokenHash: bound.context.portalSessionTokenHash as Buffer,
        },
        {
          campaignTemplateVersionId: evidence.campaignTemplateVersionId,
          campaignTemplateStepId: evidence.campaignTemplateStepId,
          campaignStepContentSha256: evidence.campaignStepContentSha256,
          campaignApprovalRequestId: evidence.campaignApprovalRequestId,
          campaignApprovalDecisionId: evidence.campaignApprovalDecisionId,
          messageVersionId: evidence.messageVersionId,
          messageApprovalRequestId: evidence.messageApprovalRequestId,
          messageApprovalDecisionId: evidence.messageApprovalDecisionId,
          channelEndpointId: evidence.channelEndpointId,
          messageDeliveryId: identifiers.messageDeliveryId,
          consentEventId: evidence.consentEventId,
          complianceSubjectId: evidence.complianceSubjectId,
          policyPublicationEventId: evidence.policyPublicationEventId,
          pecrSenderDecisionEventId: evidence.pecrSenderDecisionEventId,
          pecrInstigatorDecisionEventId: evidence.pecrInstigatorDecisionEventId,
          permissionUseReceiptId: evidence.permissionUseReceiptId,
          authorityValidUntil: input.authorityValidUntil,
          providerOperationId: identifiers.providerOperationId,
          correlationId: identifiers.correlationId,
          idempotencyKeySha256: identifiers.idempotencyKeySha256,
          requestSha256,
        },
      );
      return Object.freeze({
        ok: true as const,
        disposition: outcome.disposition,
        jobId: outcome.jobId,
        providerEffects: 'none' as const,
        recipientEmail: evidence.recipientEmail,
        subject: evidence.subject,
      });
    } catch (error) {
      return mapFailure(error);
    }
  }

  /**
   * The digest 0054 rebuilds and compares, derived in the database because the
   * enqueue identity cannot read the rows it is made of.
   */
  async #requestDigest(
    context: DatabaseRequestContext,
    workspaceId: string,
    evidence: FounderEmailPilotEvidence,
    identifiers: FounderEmailPilotIdentifiers,
    authorityValidUntil: string,
  ): Promise<string> {
    const rows = await withTransaction(
      this.#dependencies.commandPool, context,
      async (client) => (await client.query<DigestRow>(
        `/* portal.founder-email-pilot.request-digest */
         SELECT encode(app_private.derive_customer_email_pilot_request_digest(
           $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7::uuid,
           $8::uuid, $9::uuid, $10::uuid, $11::uuid, $12::uuid, $13::uuid,
           $14::uuid, $15::timestamptz, $16::uuid, $17::uuid, $18::uuid,
           decode($19, 'hex')
         ), 'hex') AS request_sha256`,
        [
          workspaceId, this.#dependencies.providerConnectionId,
          evidence.campaignTemplateVersionId, evidence.campaignTemplateStepId,
          evidence.campaignApprovalRequestId, evidence.campaignApprovalDecisionId,
          evidence.messageVersionId, evidence.channelEndpointId,
          evidence.consentEventId, evidence.complianceSubjectId,
          evidence.policyPublicationEventId, evidence.pecrSenderDecisionEventId,
          evidence.pecrInstigatorDecisionEventId, evidence.permissionUseReceiptId,
          authorityValidUntil, identifiers.providerOperationId,
          identifiers.messageDeliveryId, identifiers.correlationId,
          identifiers.idempotencyKeySha256,
        ],
      )).rows,
      { readOnly: true },
    );
    const digest = rows[0]?.request_sha256;
    if (rows.length !== 1 || typeof digest !== 'string' || !SHA256.test(digest)) {
      throw new FounderEmailPilotError('request digest is invalid');
    }
    return digest;
  }
}

export function createPgPortalFounderEmailPilotService(input: {
  readonly webPool: Pool;
  readonly crmCommandPool: Pool;
  readonly providerConnectionId: string;
  readonly commandService: CustomerEmailLiveCommandService;
  readonly now?: () => number;
}): PgPortalFounderEmailPilotService {
  return new PgPortalFounderEmailPilotService({
    principalResolver: createPgPortalCrmPrincipalResolver(input.webPool),
    commandPool: input.crmCommandPool,
    providerConnectionId: input.providerConnectionId,
    commandService: input.commandService,
    now: input.now ?? (() => Date.now()),
  });
}
