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
import {
  FOUNDER_PILOT_AUTHORITY_DAYS,
  FOUNDER_PILOT_POLICY_ASSET_KEY,
  FOUNDER_PILOT_POLICY_ASSET_VERSION,
  FOUNDER_PILOT_POLICY_DOCUMENT_REFS,
  FOUNDER_PILOT_REVIEW_AUTHORITY,
  founderPilotPolicyBundleSha256,
  founderPilotPolicySourceCommit,
} from '../founder-email-pilot/policy-asset.js';
import {
  PROPERTY_PREDATOR_OWNED_SEED_PROOF_BODY,
  PROPERTY_PREDATOR_OWNED_SEED_PROOF_SOURCE_ITEM,
  PROPERTY_PREDATOR_OWNED_SEED_PROOF_SOURCE_VERSION,
  PROPERTY_PREDATOR_OWNED_SEED_PROOF_SUBJECT,
} from './owned-seed-proof-email.js';
import {
  PROPERTY_PREDATOR_OWNED_SEED_PROOF_CONTENT_SHA256,
} from '../company-content-pg/property-predator-owned-seed-attestation-policy.js';
import { EMAIL_PILOT_PREVIEW_TTL_MS } from './founder-email-pilot-actions.js';
import type { PortalPermissionUseReceiptService }
  from './permission-use-receipt-service.js';
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
  PrepareContentInput,
  PrepareContentResult,
  RecordPolicyEvidenceInput,
  RecordPolicyEvidenceResult,
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

interface PrepareRow extends QueryResultRow {
  readonly disposition: unknown;
  readonly campaign_template_version_id: unknown;
  readonly message_version_id: unknown;
  readonly approved_content_id: unknown;
}

interface EvidenceRecordRow extends QueryResultRow {
  readonly disposition: unknown;
  readonly policy_publication_event_id: unknown;
  readonly pecr_sender_decision_event_id: unknown;
  readonly pecr_instigator_decision_event_id: unknown;
  readonly action_scope_sha256: unknown;
  readonly review_authority: unknown;
  readonly ownership_control_checked: unknown;
}

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
  readonly commandService?: CustomerEmailLiveCommandService;
  /**
   * The 0032 receipt rail, on its own append-only identity. The enqueue cannot
   * be satisfied without it, and it can do nothing else.
   */
  readonly permissionUse?: PortalPermissionUseReceiptService;
  /**
   * The 0065 evidence identity's pool, absent when its credential is not bound.
   * Recording the review is refused rather than silently skipped.
   */
  readonly evidencePool?: Pick<Pool, 'connect'>;
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

  /**
   * Build the approved campaign and message evidence for this exact endpoint.
   *
   * The subject and body are the deployed proof asset, not anything a browser
   * supplied, and the recipient is a contact point identifier. 0065 refuses an
   * endpoint that is not already verified, and holds no privilege that would
   * let this create a delivery intent.
   */
  async prepareContent(
    identity: PortalCrmRequestIdentity,
    input: PrepareContentInput,
  ): Promise<PrepareContentResult> {
    try {
      if (input.operatorConfirmed !== true
        || !UUID.test(input.contactId) || !UUID.test(input.contactPointId)
        || !UUID.test(input.commandKey) || !isFounderPilotPurpose(input.purpose)) {
        return failed('validation');
      }
      const resolved = await this.#context(identity);
      if (!resolved) return failed('unauthenticated');
      const commandKeyDigest = Buffer.from(
        deriveFounderPilotCommandKey(
          'founder-pilot-prepare', resolved.workspaceId, input.commandKey,
        ),
        'hex',
      );
      const row = await withTransaction(
        this.#dependencies.commandPool, resolved.context,
        async (client) => {
          const result = await client.query<PrepareRow>(
            `/* portal.founder-email-pilot.prepare-content */
             SELECT disposition, campaign_template_version_id::text,
                    message_version_id::text, approved_content_id::text
             FROM app_private.prepare_founder_email_pilot_content(
               $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::text, $6::text,
               $7::text, $8::text, $9::bytea, $10::bytea
             )`,
            [
              resolved.workspaceId, this.#dependencies.providerConnectionId,
              input.contactId.toLowerCase(), input.contactPointId.toLowerCase(),
              input.purpose,
              PROPERTY_PREDATOR_OWNED_SEED_PROOF_SUBJECT,
              PROPERTY_PREDATOR_OWNED_SEED_PROOF_BODY,
              `${PROPERTY_PREDATOR_OWNED_SEED_PROOF_SOURCE_ITEM}`
                + `:${PROPERTY_PREDATOR_OWNED_SEED_PROOF_SOURCE_VERSION}`,
              Buffer.from(PROPERTY_PREDATOR_OWNED_SEED_PROOF_CONTENT_SHA256, 'hex'),
              commandKeyDigest,
            ],
          );
          if (result.rows.length !== 1) {
            throw new FounderEmailPilotError('preparation returned invalid cardinality');
          }
          return result.rows[0] ?? null;
        });
      if (!row || typeof row.campaign_template_version_id !== 'string'
        || typeof row.message_version_id !== 'string'
        || typeof row.approved_content_id !== 'string') {
        return failed('unavailable');
      }
      return Object.freeze({
        ok: true as const,
        disposition: row.disposition === 'replayed' ? 'replayed' as const : 'prepared' as const,
        campaignTemplateVersionId: row.campaign_template_version_id,
        messageVersionId: row.message_version_id,
        approvedContentId: row.approved_content_id,
        providerEffects: 'none' as const,
      });
    } catch (error) {
      return mapFailure(error);
    }
  }

  /**
   * Record the founder and operator compliance review.
   *
   * Only the immutable policy asset's identity crosses this boundary. Every
   * reference and digest in the ledger is derived inside 0065 from that asset,
   * the approved copy, the current consent event, the operator, the request and
   * the verified endpoint. No hash, id or evidence reference is accepted from a
   * browser, and no solicitor approval is claimed.
   */
  async recordPolicyEvidence(
    identity: PortalCrmRequestIdentity,
    input: RecordPolicyEvidenceInput,
  ): Promise<RecordPolicyEvidenceResult> {
    try {
      if (input.operatorConfirmed !== true
        || !UUID.test(input.contactId) || !UUID.test(input.contactPointId)
        || !UUID.test(input.commandKey) || !isFounderPilotPurpose(input.purpose)) {
        return failed('validation');
      }
      if (!this.#dependencies.evidencePool) return failed('unavailable');
      const resolved = await this.#context(identity);
      if (!resolved) return failed('unauthenticated');
      const commandKeyDigest = Buffer.from(
        deriveFounderPilotCommandKey(
          'founder-pilot-evidence', resolved.workspaceId, input.commandKey,
        ),
        'hex',
      );
      const row = await withTransaction(
        this.#dependencies.evidencePool, resolved.context,
        async (client) => {
          const result = await client.query<EvidenceRecordRow>(
            `/* portal.founder-email-pilot.record-policy-evidence */
             SELECT disposition, policy_publication_event_id::text,
                    pecr_sender_decision_event_id::text,
                    pecr_instigator_decision_event_id::text,
                    action_scope_sha256, review_authority, ownership_control_checked
             FROM app_private.record_founder_pilot_compliance_evidence(
               $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::text, $6::text,
               $7::text, $8::bytea, $9::jsonb, $10::text, $11::integer, $12::bytea
             )`,
            [
              resolved.workspaceId, this.#dependencies.providerConnectionId,
              input.contactId.toLowerCase(), input.contactPointId.toLowerCase(),
              input.purpose,
              FOUNDER_PILOT_POLICY_ASSET_KEY, FOUNDER_PILOT_POLICY_ASSET_VERSION,
              Buffer.from(founderPilotPolicyBundleSha256(), 'hex'),
              JSON.stringify(FOUNDER_PILOT_POLICY_DOCUMENT_REFS),
              founderPilotPolicySourceCommit(),
              FOUNDER_PILOT_AUTHORITY_DAYS,
              commandKeyDigest,
            ],
          );
          if (result.rows.length !== 1) {
            throw new FounderEmailPilotError('evidence returned invalid cardinality');
          }
          return result.rows[0] ?? null;
        });
      if (!row || typeof row.policy_publication_event_id !== 'string'
        || typeof row.pecr_sender_decision_event_id !== 'string'
        || typeof row.pecr_instigator_decision_event_id !== 'string'
        || typeof row.action_scope_sha256 !== 'string'
        || !SHA256.test(row.action_scope_sha256)) {
        return failed('unavailable');
      }
      // A ledger claiming ownership evidence nobody supplied is not something
      // to surface as success, whatever the database returned.
      if (row.ownership_control_checked !== false) {
        throw new FounderEmailPilotError('recorded evidence claims unchecked ownership');
      }
      if (row.review_authority !== FOUNDER_PILOT_REVIEW_AUTHORITY) {
        throw new FounderEmailPilotError('recorded review authority is not the founder review');
      }
      return Object.freeze({
        ok: true as const,
        disposition: row.disposition === 'replayed' ? 'replayed' as const : 'recorded' as const,
        policyPublicationEventId: row.policy_publication_event_id,
        pecrSenderDecisionEventId: row.pecr_sender_decision_event_id,
        pecrInstigatorDecisionEventId: row.pecr_instigator_decision_event_id,
        actionScopeSha256: row.action_scope_sha256,
        reviewAuthority: FOUNDER_PILOT_REVIEW_AUTHORITY,
        ownershipControlChecked: false as const,
        providerEffects: 'none' as const,
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
      // Endpoint attachment, readiness and content preparation are useful
      // before the effectful enqueue identities are installed. Keep those
      // founder actions composed, but refuse the final authorisation unless
      // both least-privilege send boundaries are present.
      if (!this.#dependencies.commandService || !this.#dependencies.permissionUse) {
        return failed('unavailable');
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

      // The operator consumes their own permission here, on its own
      // append-only identity, because 0054 binds the receipt to this exact
      // request. It records a consumption and nothing else: provider effects
      // stay false whatever the enqueue below decides.
      const receipt = await this.#dependencies.permissionUse.consume(identity, {
        contactId: input.contactId,
        contactPointId: input.contactPointId,
        purpose: input.purpose,
        commandKey: input.commandKey,
        authorityValidUntil: input.authorityValidUntil,
      });
      if (!receipt.ok) return failed(receipt.kind);

      // Re-resolve rather than trust the preview: approvals, consent and
      // suppression can all change between reading a message and authorising it.
      // The receipt now exists for this request, so the tuple can complete.
      const evidence = await this.#resolveEvidence(
        bound.context, bound.workspaceId, input, input.authorityValidUntil,
      );
      if (evidence === null) return failed('blocked');
      // The enqueue would refuse a receipt it did not resolve to anyway; saying
      // so here keeps the founder-facing reason accurate.
      if (evidence.permissionUseReceiptId !== receipt.permissionUseReceiptId.toLowerCase()) {
        return Object.freeze({ ok: false as const, kind: 'stale_preview' as const });
      }
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
  readonly commandService?: CustomerEmailLiveCommandService;
  readonly permissionUse?: PortalPermissionUseReceiptService;
  readonly evidencePool?: Pool;
  readonly now?: () => number;
}): PgPortalFounderEmailPilotService {
  return new PgPortalFounderEmailPilotService({
    principalResolver: createPgPortalCrmPrincipalResolver(input.webPool),
    commandPool: input.crmCommandPool,
    providerConnectionId: input.providerConnectionId,
    ...(input.commandService ? { commandService: input.commandService } : {}),
    ...(input.permissionUse ? { permissionUse: input.permissionUse } : {}),
    ...(input.evidencePool ? { evidencePool: input.evidencePool } : {}),
    now: input.now ?? (() => Date.now()),
  });
}
