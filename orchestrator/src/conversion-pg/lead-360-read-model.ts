import type { Pool } from 'pg';
import { createPgCrmReadTransactionRunner } from '../crm-pg/read-model.js';
import type { CrmTransactionRunner, SqlExecutor } from '../crm-pg/types.js';
import { validateDatabaseContext, type DatabaseRequestContext } from '../db/rls.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INTEGER_PATTERN = /^(?:0|[1-9]\d*)$/;
const EVIDENCE_LIMIT = 200;
const JOURNEY_LIMIT = 10;
const OFFER_LIMIT = 50;
const OPPORTUNITY_LIMIT = 50;
const TASK_LIMIT = 100;

const ENROLLMENT_STATUSES = ['active', 'completed', 'withdrawn', 'disqualified'] as const;
const PROPERTY_PREDATOR_JOURNEY_SLUGS = [
  'property-predator-self-serve', 'property-predator-agency-laps',
] as const;
const MILESTONE_SEMANTICS = [
  'lead', 'appointment', 'presentation', 'activation', 'offer', 'sale', 'retention', 'custom',
] as const;
const EVIDENCE_KINDS = [
  'watched', 'listened', 'read', 'downloaded', 'product', 'offer', 'reply',
  'appointment', 'commerce', 'email',
] as const;
const OFFER_RESPONSES = [
  'accepted', 'declined', 'deferred', 'requested_contact',
] as const;
const CONTACT_POINT_KINDS = ['email', 'phone', 'whatsapp', 'social', 'other'] as const;
const DEDUPE_STATES = ['normal', 'shared', 'quarantined'] as const;
const COMMUNICATION_CHANNELS = [
  'email', 'sms', 'whatsapp', 'phone', 'social', 'webinar', 'web',
] as const;
const CONSENT_STATES = ['granted', 'denied', 'withdrawn'] as const;
const CONSENT_ACTOR_KINDS = ['user', 'worker', 'webhook', 'system'] as const;
const SUPPRESSION_STATES = ['suppressed', 'released'] as const;
const LAWFUL_BASES = [
  'consent', 'legitimate_interests', 'contract', 'legal_obligation',
  'vital_interests', 'public_task',
] as const;
const OPPORTUNITY_STATUSES = ['open', 'won', 'lost'] as const;
const TASK_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
const TASK_STATUSES = ['open', 'completed', 'cancelled'] as const;

export type Lead360EnrollmentStatus = (typeof ENROLLMENT_STATUSES)[number];
export type Lead360JourneySlug = (typeof PROPERTY_PREDATOR_JOURNEY_SLUGS)[number];
export type Lead360MilestoneSemantic = (typeof MILESTONE_SEMANTICS)[number];
export type Lead360EvidenceKind = (typeof EVIDENCE_KINDS)[number];
export type Lead360OfferResponse = (typeof OFFER_RESPONSES)[number];
export type Lead360ContactPointKind = (typeof CONTACT_POINT_KINDS)[number];
export type Lead360CommunicationChannel = (typeof COMMUNICATION_CHANNELS)[number];
export type Lead360EffectiveConsentState =
  | 'permitted'
  | 'denied'
  | 'withdrawn'
  | 'suppressed'
  | 'unknown';

export interface Lead360IdentityRead {
  readonly contactId: string;
  readonly displayName: string;
  readonly companyName: string | null;
  readonly primaryEmail: string | null;
  readonly primaryPhone: string | null;
  readonly lifecycle: 'lead' | 'customer' | 'archived';
  readonly ownerUserId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface Lead360JourneyStageRead {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly position: number;
  readonly semantic: Lead360MilestoneSemantic;
  readonly isCompletion: boolean;
  readonly isCurrent: boolean;
  readonly reachedAt: string | null;
}

export interface Lead360JourneyRead {
  readonly enrollmentId: string;
  readonly journeyId: string;
  readonly journeyVersionId: string;
  /** Present on current PostgreSQL reads; optional for older custom adapters. */
  readonly slug?: Lead360JourneySlug;
  readonly name: string;
  readonly status: Lead360EnrollmentStatus;
  readonly currentMilestoneId: string | null;
  readonly enrolledAt: string;
  readonly lastEventAt: string | null;
  readonly endedAt: string | null;
  readonly stages: readonly Lead360JourneyStageRead[];
  /** Latest explainable score for this exact enrollment. */
  readonly score?: Lead360ScoreRead | null;
}

export interface Lead360ScoreRead {
  readonly id: string;
  readonly enrollmentId: string;
  readonly total: number;
  readonly band: string;
  readonly componentScores: Readonly<Record<string, number>>;
  readonly reasons: readonly string[];
  readonly sourceOccurredAt: string;
  readonly evaluatedAt: string;
}

export interface Lead360EvidenceRead {
  readonly id: string;
  readonly kind: Lead360EvidenceKind;
  readonly title: string;
  readonly detail: string | null;
  readonly progressBasisPoints: number | null;
  readonly occurredAt: string;
  readonly sourceLabel: string;
}

export interface Lead360OfferResponseRead {
  readonly id: string;
  readonly response: Lead360OfferResponse;
  readonly respondedAt: string;
}

export interface Lead360OfferRead {
  readonly id: string;
  readonly offerKey: string;
  readonly label: string;
  readonly offerVersion: string;
  readonly productKey: string;
  readonly priceMinor: number;
  readonly currency: string;
  readonly placement: string;
  readonly presentedAt: string;
  readonly latestResponse: Lead360OfferResponseRead | null;
}

export interface Lead360ConsentRead {
  readonly contactPointId: string;
  readonly contactPointKind: Lead360ContactPointKind;
  readonly contactPointLabel: string | null;
  readonly contactPointValue: string;
  readonly isPrimary: boolean;
  readonly isVerified: boolean;
  readonly dedupeState: 'normal' | 'shared' | 'quarantined';
  readonly channel: Lead360CommunicationChannel;
  readonly purpose: string | null;
  readonly state: Lead360EffectiveConsentState;
  readonly lawfulBasis: (typeof LAWFUL_BASES)[number] | null;
  readonly updatedAt: string | null;
  readonly consentEventId: string | null;
  /** Evidence source recorded with the decision, never an inferred signal. */
  readonly consentSource: string | null;
  readonly policyVersion: string | null;
  /** Hex digest of the exact policy text the contact was shown, when recorded. */
  readonly policyTextSha256: string | null;
  /** When the decision took effect, versus when the ledger recorded it. */
  readonly recordedAt: string | null;
  readonly recordedByActorKind: 'user' | 'worker' | 'webhook' | 'system' | null;
  readonly recordedByUserId: string | null;
  readonly suppressionEventId: string | null;
  readonly suppressionState: 'suppressed' | 'released' | null;
  readonly suppressionReason: string | null;
}

export interface Lead360OpportunityRead {
  readonly id: string;
  readonly pipelineId: string;
  readonly stageId: string;
  readonly stageName: string;
  readonly title: string;
  readonly status: 'open' | 'won' | 'lost';
  readonly valueMinor: number;
  readonly currency: string;
  readonly probability: number;
  readonly expectedCloseDate: string | null;
  readonly closedAt: string | null;
  readonly updatedAt: string;
}

export interface Lead360TaskRead {
  readonly id: string;
  readonly opportunityId: string | null;
  readonly title: string;
  readonly priority: 'low' | 'normal' | 'high' | 'urgent';
  readonly status: 'open' | 'completed' | 'cancelled';
  readonly dueAt: string | null;
  readonly completedAt: string | null;
  readonly updatedAt: string;
}

export interface Lead360CrmRead {
  readonly opportunities: readonly Lead360OpportunityRead[];
  readonly tasks: readonly Lead360TaskRead[];
}

/** A deliberately narrow, display-safe case file. It contains no provider payloads or digests. */
export interface Lead360CaseFileRead {
  readonly workspaceId: string;
  readonly contactId: string;
  readonly asOf: string;
  readonly identity: Lead360IdentityRead;
  /**
   * All bounded Property Predator enrollments in primary-route order. Active
   * routes rank by score, latest activity and the stable product route order;
   * when none is active, the most recent terminal route ranks first.
   */
  readonly journeys?: readonly Lead360JourneyRead[];
  /** Backward-compatible alias for the deterministically chosen primary journey. */
  readonly journey: Lead360JourneyRead | null;
  /** Backward-compatible alias for the primary journey's latest score. */
  readonly score: Lead360ScoreRead | null;
  readonly evidence: readonly Lead360EvidenceRead[];
  readonly offers: readonly Lead360OfferRead[];
  readonly consent: readonly Lead360ConsentRead[];
  readonly crm: Lead360CrmRead;
}

export interface Lead360ReadDependencies {
  readonly transactionRunner: CrmTransactionRunner;
}

export class Lead360ReadDataError extends Error {
  readonly code = 'invalid_lead_360_read_data';

  constructor(message: string) {
    super(message);
    this.name = 'Lead360ReadDataError';
  }
}

function fail(message: string): never {
  throw new Lead360ReadDataError(message);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return fail(`${label} must be a database row`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) return fail(`${label} must be non-empty text`);
  return value;
}

function nullableText(value: unknown, label: string): string | null {
  return value === null ? null : text(value, label);
}

function uuid(value: unknown, label: string): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) return fail(`${label} must be a UUID`);
  return value.toLowerCase();
}

function nullableUuid(value: unknown, label: string): string | null {
  return value === null ? null : uuid(value, label);
}

function bool(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') return fail(`${label} must be a boolean`);
  return value;
}

function oneOf<const T extends readonly string[]>(value: unknown, values: T, label: string): T[number] {
  if (typeof value !== 'string' || !values.includes(value)) return fail(`${label} is invalid`);
  return value as T[number];
}

function integer(
  value: unknown,
  label: string,
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  let parsed: bigint;
  if (typeof value === 'bigint') {
    parsed = value;
  } else if (typeof value === 'number' && Number.isSafeInteger(value)) {
    parsed = BigInt(value);
  } else if (typeof value === 'string' && INTEGER_PATTERN.test(value)) {
    parsed = BigInt(value);
  } else {
    return fail(`${label} must be an integer`);
  }
  if (parsed < BigInt(minimum) || parsed > BigInt(maximum)) {
    return fail(`${label} is outside its safe range`);
  }
  return Number(parsed);
}

function nullableInteger(
  value: unknown,
  label: string,
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER,
): number | null {
  return value === null ? null : integer(value, label, minimum, maximum);
}

function timestamp(value: unknown, label: string): string {
  const parsed = value instanceof Date ? value : typeof value === 'string' ? new Date(value) : null;
  if (!parsed || !Number.isFinite(parsed.getTime())) return fail(`${label} must be a timestamp`);
  return parsed.toISOString();
}

function nullableTimestamp(value: unknown, label: string): string | null {
  return value === null ? null : timestamp(value, label);
}

function nullableDate(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return fail(`${label} must be a calendar date`);
  }
  const [yearText, monthText, dayText] = value.split('-');
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
    return fail(`${label} must be a real calendar date`);
  }
  return value;
}

function currency(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[A-Z]{3}$/.test(value)) {
    return fail(`${label} must be an uppercase currency code`);
  }
  return value;
}

function componentScores(value: unknown, label: string): Readonly<Record<string, number>> {
  const input = record(value, label);
  const entries = Object.entries(input).map(([key, score]) => {
    if (key.length === 0 || key.length > 200) return fail(`${label} contains an invalid component key`);
    if (typeof score !== 'number' || !Number.isFinite(score) || Math.abs(score) > Number.MAX_SAFE_INTEGER) {
      return fail(`${label}.${key} must be a finite safe number`);
    }
    return [key, score] as const;
  });
  return Object.freeze(Object.fromEntries(entries));
}

function reasons(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value)) return fail(`${label} must be an array`);
  return Object.freeze(value.map((reason, index) => {
    if (typeof reason !== 'string' || reason.length === 0 || reason.length > 2_000) {
      return fail(`${label}[${index}] must be non-empty text`);
    }
    return reason;
  }));
}

function assertScope(
  row: Record<string, unknown>,
  label: string,
  workspaceId: string,
  contactId: string,
): void {
  if (uuid(row.workspace_id, `${label}.workspaceId`) !== workspaceId
      || uuid(row.contact_id, `${label}.contactId`) !== contactId) {
    fail(`${label} escaped the requested workspace or contact scope`);
  }
}

const CONTACT_SQL = `/* conversion.lead-360.read-contact */
  SELECT contact.workspace_id,
         contact.id AS contact_id,
         contact.display_name,
         contact.company_name,
         contact.lifecycle_status,
         contact.owner_user_id,
         contact.created_at,
         contact.updated_at,
         primary_email.value AS primary_email,
         primary_phone.value AS primary_phone,
         transaction_timestamp() AS snapshot_at
  FROM app.contacts AS contact
  LEFT JOIN LATERAL (
    SELECT point.value
    FROM app.contact_points AS point
    WHERE point.workspace_id = app_private.current_workspace_id()
      AND point.contact_id = contact.id
      AND point.kind = 'email'
      AND point.deleted_at IS NULL
    ORDER BY point.is_primary DESC, point.updated_at DESC, point.id
    LIMIT 1
  ) AS primary_email ON true
  LEFT JOIN LATERAL (
    SELECT point.value
    FROM app.contact_points AS point
    WHERE point.workspace_id = app_private.current_workspace_id()
      AND point.contact_id = contact.id
      AND point.kind = 'phone'
      AND point.deleted_at IS NULL
    ORDER BY point.is_primary DESC, point.updated_at DESC, point.id
    LIMIT 1
  ) AS primary_phone ON true
  WHERE contact.workspace_id = app_private.current_workspace_id()
    AND contact.id = $1::uuid
    AND contact.deleted_at IS NULL`;

const JOURNEY_SQL = `/* conversion.lead-360.read-journey */
  WITH selected_enrollments AS (
    SELECT enrollment.workspace_id,
           enrollment.contact_id,
           enrollment.id,
           enrollment.journey_id,
           enrollment.journey_version_id,
           enrollment.status,
           enrollment.current_milestone_id,
           enrollment.enrolled_at,
           enrollment.last_event_at,
           enrollment.ended_at,
           journey.slug::text AS journey_slug,
           journey.name AS journey_name
    FROM app.conversion_enrollments AS enrollment
    JOIN app.conversion_journeys AS journey
      ON journey.workspace_id = app_private.current_workspace_id()
     AND journey.id = enrollment.journey_id
    WHERE enrollment.workspace_id = app_private.current_workspace_id()
      AND enrollment.contact_id = $1::uuid
      AND journey.slug::text IN (
        'property-predator-self-serve', 'property-predator-agency-laps'
      )
    ORDER BY (enrollment.status = 'active') DESC,
             coalesce(enrollment.last_event_at, enrollment.ended_at, enrollment.enrolled_at) DESC,
             enrollment.id DESC
    LIMIT ${JOURNEY_LIMIT}
  )
  SELECT enrollment.workspace_id,
         enrollment.contact_id,
         enrollment.id AS enrollment_id,
         enrollment.journey_id,
         enrollment.journey_version_id,
         enrollment.journey_slug,
         enrollment.journey_name,
         enrollment.status AS enrollment_status,
         enrollment.current_milestone_id,
         enrollment.enrolled_at,
         enrollment.last_event_at,
         enrollment.ended_at,
         milestone.id AS milestone_id,
         milestone.milestone_key::text AS milestone_key,
         milestone.name AS milestone_name,
         milestone.position,
         milestone.semantic,
         milestone.is_completion,
         reached.occurred_at AS reached_at
  FROM selected_enrollments AS enrollment
  LEFT JOIN app.conversion_journey_milestones AS milestone
    ON milestone.workspace_id = app_private.current_workspace_id()
   AND milestone.journey_version_id = enrollment.journey_version_id
  LEFT JOIN app.conversion_milestone_facts AS reached
    ON reached.workspace_id = app_private.current_workspace_id()
   AND reached.enrollment_id = enrollment.id
   AND reached.contact_id = $1::uuid
   AND reached.milestone_id = milestone.id
  ORDER BY (enrollment.status = 'active') DESC,
           coalesce(enrollment.last_event_at, enrollment.ended_at, enrollment.enrolled_at) DESC,
           enrollment.id DESC,
           milestone.position NULLS LAST,
           milestone.id`;

const SCORE_SQL = `/* conversion.lead-360.read-score */
  WITH selected_enrollments AS (
    SELECT enrollment.workspace_id,
           enrollment.contact_id,
           enrollment.id,
           enrollment.status,
           enrollment.enrolled_at,
           enrollment.last_event_at,
           enrollment.ended_at
    FROM app.conversion_enrollments AS enrollment
    JOIN app.conversion_journeys AS journey
      ON journey.workspace_id = app_private.current_workspace_id()
     AND journey.id = enrollment.journey_id
    WHERE enrollment.workspace_id = app_private.current_workspace_id()
      AND enrollment.contact_id = $1::uuid
      AND journey.slug::text IN (
        'property-predator-self-serve', 'property-predator-agency-laps'
      )
    ORDER BY (enrollment.status = 'active') DESC,
             coalesce(enrollment.last_event_at, enrollment.ended_at, enrollment.enrolled_at) DESC,
             enrollment.id DESC
    LIMIT ${JOURNEY_LIMIT}
  )
  SELECT enrollment.workspace_id,
         enrollment.contact_id,
         score.id AS score_id,
         enrollment.id AS enrollment_id,
         score.total_score::text AS total_score,
         score.band_key,
         score.component_scores,
         score.reasons,
         score.source_occurred_at,
         score.evaluated_at
  FROM selected_enrollments AS enrollment
  JOIN LATERAL (
    SELECT snapshot.id,
           snapshot.total_score,
           snapshot.band_key,
           snapshot.component_scores,
           snapshot.reasons,
           snapshot.source_occurred_at,
           snapshot.evaluated_at
    FROM app.lead_score_snapshots AS snapshot
    WHERE snapshot.workspace_id = app_private.current_workspace_id()
      AND snapshot.contact_id = $1::uuid
      AND snapshot.enrollment_id = enrollment.id
    ORDER BY snapshot.evaluated_at DESC, snapshot.id DESC
    LIMIT 1
  ) AS score ON true
  ORDER BY (enrollment.status = 'active') DESC,
           coalesce(enrollment.last_event_at, enrollment.ended_at, enrollment.enrolled_at) DESC,
           enrollment.id DESC`;

const EVIDENCE_SQL = `/* conversion.lead-360.read-evidence */
  WITH evidence AS (
    SELECT content.workspace_id,
           content.contact_id,
           content.id,
           CASE
             WHEN content.action = 'downloaded' THEN 'downloaded'
             WHEN content.medium = 'video' THEN 'watched'
             WHEN content.medium = 'audio' THEN 'listened'
             ELSE 'read'
           END::text AS evidence_kind,
           content.content_label AS title,
           content.action || ' · ' || content.content_key || ' · ' || content.content_version AS detail,
           content.progress_basis_points::text AS progress_basis_points,
           content.occurred_at,
           'Content · ' || content.medium AS source_label
    FROM app.content_consumption_facts AS content
    WHERE content.workspace_id = app_private.current_workspace_id()
      AND content.contact_id = $1::uuid
    UNION ALL
    SELECT fact.workspace_id,
           fact.contact_id,
           fact.id,
           CASE
             WHEN milestone.semantic = 'appointment' THEN 'appointment'
             WHEN milestone.semantic IN ('presentation', 'offer') THEN 'offer'
             WHEN milestone.semantic = 'sale' THEN 'commerce'
             ELSE 'product'
           END::text,
           milestone.name,
           milestone.semantic,
           NULL::text,
           fact.occurred_at,
           journey.name
    FROM app.conversion_milestone_facts AS fact
    JOIN app.conversion_enrollments AS enrollment
      ON enrollment.workspace_id = app_private.current_workspace_id()
     AND enrollment.id = fact.enrollment_id
     AND enrollment.contact_id = $1::uuid
    JOIN app.conversion_journeys AS journey
      ON journey.workspace_id = app_private.current_workspace_id()
     AND journey.id = enrollment.journey_id
    JOIN app.conversion_journey_milestones AS milestone
      ON milestone.workspace_id = app_private.current_workspace_id()
     AND milestone.journey_version_id = fact.journey_version_id
     AND milestone.id = fact.milestone_id
    WHERE fact.workspace_id = app_private.current_workspace_id()
      AND fact.contact_id = $1::uuid
    UNION ALL
    SELECT presentation.workspace_id,
           presentation.contact_id,
           presentation.id,
           'offer'::text,
           presentation.offer_key,
           presentation.product_key || ' · ' || presentation.placement,
           NULL::text,
           presentation.presented_at,
           'Offer presentation'::text
    FROM app.offer_presentation_facts AS presentation
    WHERE presentation.workspace_id = app_private.current_workspace_id()
      AND presentation.contact_id = $1::uuid
    UNION ALL
    SELECT response.workspace_id,
           response.contact_id,
           response.id,
           'reply'::text,
           presentation.offer_key,
           response.response,
           NULL::text,
           response.responded_at,
           'Offer response'::text
    FROM app.offer_response_facts AS response
    JOIN app.offer_presentation_facts AS presentation
      ON presentation.workspace_id = app_private.current_workspace_id()
     AND presentation.id = response.offer_presentation_id
     AND presentation.contact_id = $1::uuid
    WHERE response.workspace_id = app_private.current_workspace_id()
      AND response.contact_id = $1::uuid
    UNION ALL
    SELECT commerce.workspace_id,
           commerce.contact_id,
           commerce.id,
           'commerce'::text,
           commerce.product_key,
           commerce.fact_type || ' · ' || commerce.currency || ' ' || commerce.amount_minor::text,
           NULL::text,
           commerce.occurred_at,
           'Commerce'::text
    FROM app.conversion_commerce_facts AS commerce
    WHERE commerce.workspace_id = app_private.current_workspace_id()
      AND commerce.contact_id = $1::uuid
    UNION ALL
    SELECT delivery.workspace_id,
           delivery.contact_id,
           receipt.id,
           'email'::text,
           CASE receipt.delivery_status
             WHEN 'accepted' THEN 'Property Predator email accepted'
             WHEN 'delivered' THEN 'Property Predator email delivered'
             WHEN 'read' THEN 'Property Predator email opened'
             ELSE 'Property Predator email failed'
           END,
           coalesce(conversation.subject, 'Approved Property Predator email'),
           NULL::text,
           receipt.occurred_at,
           'Mailgun · signed receipt'::text
    FROM app.provider_operation_receipts AS receipt
    JOIN app.message_deliveries AS delivery
      ON delivery.workspace_id = app_private.current_workspace_id()
     AND delivery.provider_operation_id = receipt.provider_operation_id
     AND delivery.id = receipt.message_delivery_id
     AND delivery.contact_id = $1::uuid
     AND delivery.conversation_channel = 'email'
     AND delivery.environment = 'live'
    JOIN app.conversations AS conversation
      ON conversation.workspace_id = app_private.current_workspace_id()
     AND conversation.id = delivery.conversation_id
     AND conversation.contact_id = $1::uuid
     AND conversation.channel = 'email'
     AND conversation.environment = 'live'
    JOIN app.provider_connections AS connection
      ON connection.workspace_id = app_private.current_workspace_id()
     AND connection.id = delivery.provider_connection_id
     AND connection.provider_id = 'mailgun_eu'
     AND connection.environment = 'live'
    WHERE receipt.workspace_id = app_private.current_workspace_id()
      AND receipt.source_kind = 'verified_webhook'
    UNION ALL
    SELECT inbound.workspace_id,
           inbound.contact_id,
           inbound.id,
           'reply'::text,
           'Property Predator email reply received'::text,
           coalesce(conversation.subject, 'Owned-office reply'),
           NULL::text,
           inbound.occurred_at,
           'Mailgun · signed inbound reply'::text
    FROM app.property_predator_mailgun_inbound_receipts AS inbound
    JOIN app.conversations AS conversation
      ON conversation.workspace_id = app_private.current_workspace_id()
     AND conversation.id = inbound.conversation_id
     AND conversation.contact_id = $1::uuid
     AND conversation.channel = 'email'
     AND conversation.environment = 'live'
    WHERE inbound.workspace_id = app_private.current_workspace_id()
      AND inbound.contact_id = $1::uuid
  )
  SELECT workspace_id,
         contact_id,
         id,
         evidence_kind,
         title,
         detail,
         progress_basis_points,
         occurred_at,
         source_label
  FROM evidence
  ORDER BY occurred_at DESC, id DESC
  LIMIT ${EVIDENCE_LIMIT}`;

const OFFERS_SQL = `/* conversion.lead-360.read-offers */
  SELECT presentation.workspace_id,
         presentation.contact_id,
         presentation.id,
         presentation.offer_key,
         presentation.offer_label,
         presentation.offer_version,
         presentation.product_key,
         presentation.price_minor::text AS price_minor,
         presentation.currency,
         presentation.placement,
         presentation.presented_at,
         latest_response.id AS response_id,
         latest_response.response,
         latest_response.responded_at
  FROM app.offer_presentation_facts AS presentation
  LEFT JOIN LATERAL (
    SELECT response.id, response.response, response.responded_at
    FROM app.offer_response_facts AS response
    WHERE response.workspace_id = app_private.current_workspace_id()
      AND response.contact_id = $1::uuid
      AND response.offer_presentation_id = presentation.id
    ORDER BY response.responded_at DESC, response.id DESC
    LIMIT 1
  ) AS latest_response ON true
  WHERE presentation.workspace_id = app_private.current_workspace_id()
    AND presentation.contact_id = $1::uuid
  ORDER BY presentation.presented_at DESC, presentation.id DESC
  LIMIT ${OFFER_LIMIT}`;

const CONSENT_SQL = `/* conversion.lead-360.read-consent */
  WITH current_points AS (
    SELECT point.workspace_id,
           point.contact_id,
           point.id,
           point.kind,
           point.label,
           point.value,
           point.is_primary,
           point.is_verified,
           point.dedupe_state,
           public.digest(
             point.kind || pg_catalog.chr(31)
               || point.value || pg_catalog.chr(31)
               || point.normalized_value,
             'sha256'
           ) AS current_identity
    FROM app.contact_points AS point
    WHERE point.workspace_id = app_private.current_workspace_id()
      AND point.contact_id = $1::uuid
      AND point.deleted_at IS NULL
  ), raw_scopes AS (
    SELECT event.contact_point_id, event.channel, event.purpose
    FROM app.communication_consent_events AS event
    JOIN current_points AS point
      ON point.id = event.contact_point_id
     AND point.current_identity = event.endpoint_identity_sha256
    WHERE event.workspace_id = app_private.current_workspace_id()
      AND event.contact_id = $1::uuid
      AND event.occurred_at <= transaction_timestamp() + interval '5 minutes'
    UNION
    SELECT event.contact_point_id, event.channel, event.purpose
    FROM app.communication_suppression_events AS event
    JOIN current_points AS point
      ON point.id = event.contact_point_id
     AND point.current_identity = event.endpoint_identity_sha256
    WHERE event.workspace_id = app_private.current_workspace_id()
      AND event.contact_id = $1::uuid
      AND event.occurred_at <= transaction_timestamp() + interval '5 minutes'
  ), scopes AS (
    SELECT scope.contact_point_id, scope.channel, scope.purpose
    FROM raw_scopes AS scope
    WHERE scope.purpose IS NOT NULL
    UNION
    SELECT scope.contact_point_id, scope.channel, NULL::text
    FROM raw_scopes AS scope
    WHERE scope.purpose IS NULL
      AND NOT EXISTS (
        SELECT 1
        FROM raw_scopes AS specific
        WHERE specific.contact_point_id = scope.contact_point_id
          AND specific.channel = scope.channel
          AND specific.purpose IS NOT NULL
      )
  )
  SELECT point.workspace_id,
         point.contact_id,
         point.id AS contact_point_id,
         point.kind AS contact_point_kind,
         point.label AS contact_point_label,
         point.value AS contact_point_value,
         point.is_primary,
         point.is_verified,
         point.dedupe_state,
         scope.channel,
         scope.purpose,
         consent.id AS consent_event_id,
         consent.state AS consent_state,
         consent.lawful_basis,
         consent.occurred_at AS consent_occurred_at,
         consent.recorded_at AS consent_recorded_at,
         consent.source AS consent_source,
         consent.policy_version AS consent_policy_version,
         pg_catalog.encode(consent.policy_text_sha256, 'hex') AS consent_policy_sha256,
         consent.actor_kind AS consent_actor_kind,
         consent.actor_user_id AS consent_actor_user_id,
         suppression.id AS suppression_event_id,
         suppression.state AS suppression_state,
         suppression.reason AS suppression_reason,
         suppression.occurred_at AS suppression_occurred_at
  FROM scopes AS scope
  JOIN current_points AS point ON point.id = scope.contact_point_id
  LEFT JOIN LATERAL (
    SELECT event.id, event.state, event.lawful_basis, event.occurred_at,
           event.recorded_at, event.source, event.policy_version,
           event.policy_text_sha256, event.actor_kind, event.actor_user_id
    FROM app.communication_consent_events AS event
    WHERE event.workspace_id = app_private.current_workspace_id()
      AND event.contact_id = $1::uuid
      AND event.contact_point_id = point.id
      AND event.channel = scope.channel
      AND event.purpose = scope.purpose
      AND event.endpoint_identity_sha256 = point.current_identity
      AND event.occurred_at <= transaction_timestamp() + interval '5 minutes'
    ORDER BY event.occurred_at DESC, event.recorded_at DESC, event.id DESC
    LIMIT 1
  ) AS consent ON true
  LEFT JOIN LATERAL (
    SELECT latest.id, latest.state, latest.reason, latest.occurred_at
    FROM (
      SELECT DISTINCT ON (coalesce(event.purpose, ''))
             event.id, event.state, event.reason, event.occurred_at, event.recorded_at
      FROM app.communication_suppression_events AS event
      WHERE event.workspace_id = app_private.current_workspace_id()
        AND event.contact_id = $1::uuid
        AND event.contact_point_id = point.id
        AND event.channel = scope.channel
        AND (event.purpose IS NULL OR event.purpose = scope.purpose)
        AND event.endpoint_identity_sha256 = point.current_identity
        AND event.occurred_at <= transaction_timestamp() + interval '5 minutes'
      ORDER BY coalesce(event.purpose, ''),
               event.occurred_at DESC, event.recorded_at DESC, event.id DESC
    ) AS latest
    WHERE latest.state = 'suppressed'
    ORDER BY latest.occurred_at DESC, latest.recorded_at DESC, latest.id DESC
    LIMIT 1
  ) AS suppression ON true
  ORDER BY point.is_primary DESC, point.kind, point.id, scope.channel, scope.purpose NULLS FIRST`;

const OPPORTUNITIES_SQL = `/* conversion.lead-360.read-opportunities */
  SELECT opportunity.workspace_id,
         opportunity.contact_id,
         opportunity.id,
         opportunity.pipeline_id,
         opportunity.stage_id,
         stage.name AS stage_name,
         opportunity.name AS title,
         opportunity.status,
         opportunity.value_minor::text AS value_minor,
         opportunity.currency,
         opportunity.probability,
         opportunity.expected_close_date::text AS expected_close_date,
         opportunity.closed_at,
         opportunity.updated_at
  FROM app.opportunities AS opportunity
  JOIN app.pipeline_stages AS stage
    ON stage.workspace_id = app_private.current_workspace_id()
   AND stage.pipeline_id = opportunity.pipeline_id
   AND stage.id = opportunity.stage_id
  WHERE opportunity.workspace_id = app_private.current_workspace_id()
    AND opportunity.contact_id = $1::uuid
  ORDER BY opportunity.updated_at DESC, opportunity.id DESC
  LIMIT ${OPPORTUNITY_LIMIT}`;

const TASKS_SQL = `/* conversion.lead-360.read-tasks */
  SELECT task.workspace_id,
         task.contact_id,
         task.id,
         task.opportunity_id,
         task.title,
         task.priority,
         task.status,
         task.due_at,
         task.completed_at,
         task.updated_at
  FROM app.tasks AS task
  WHERE task.workspace_id = app_private.current_workspace_id()
    AND task.contact_id = $1::uuid
  ORDER BY CASE task.status WHEN 'open' THEN 0 WHEN 'completed' THEN 1 ELSE 2 END,
           CASE task.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
           task.due_at ASC NULLS LAST,
           task.updated_at DESC,
           task.id DESC
  LIMIT ${TASK_LIMIT}`;

function mapContact(
  value: unknown,
  workspaceId: string,
  contactId: string,
): { readonly identity: Lead360IdentityRead; readonly asOf: string } {
  const row = record(value, 'contact');
  assertScope(row, 'contact', workspaceId, contactId);
  return Object.freeze({
    identity: Object.freeze({
      contactId,
      displayName: text(row.display_name, 'contact.displayName'),
      companyName: nullableText(row.company_name, 'contact.companyName'),
      primaryEmail: nullableText(row.primary_email, 'contact.primaryEmail'),
      primaryPhone: nullableText(row.primary_phone, 'contact.primaryPhone'),
      lifecycle: oneOf(row.lifecycle_status, ['lead', 'customer', 'archived'] as const, 'contact.lifecycle'),
      ownerUserId: nullableUuid(row.owner_user_id, 'contact.ownerUserId'),
      createdAt: timestamp(row.created_at, 'contact.createdAt'),
      updatedAt: timestamp(row.updated_at, 'contact.updatedAt'),
    }),
    asOf: timestamp(row.snapshot_at, 'contact.snapshotAt'),
  });
}

function mapScoreRow(
  value: unknown,
  index: number,
  workspaceId: string,
  contactId: string,
): Lead360ScoreRead {
  const row = record(value, `scores[${index}]`);
  assertScope(row, `scores[${index}]`, workspaceId, contactId);
  return Object.freeze({
    id: uuid(row.score_id, `scores[${index}].id`),
    enrollmentId: uuid(row.enrollment_id, `scores[${index}].enrollmentId`),
    total: integer(row.total_score, `scores[${index}].total`, 0, 100),
    band: text(row.band_key, `scores[${index}].band`),
    componentScores: componentScores(row.component_scores, `scores[${index}].componentScores`),
    reasons: reasons(row.reasons, `scores[${index}].reasons`),
    sourceOccurredAt: timestamp(row.source_occurred_at, `scores[${index}].sourceOccurredAt`),
    evaluatedAt: timestamp(row.evaluated_at, `scores[${index}].evaluatedAt`),
  });
}

function mapJourneyGroup(
  rows: readonly Record<string, unknown>[],
  groupIndex: number,
  score: Lead360ScoreRead | null,
): Lead360JourneyRead {
  const label = `journeys[${groupIndex}]`;
  const first = rows[0]!;
  const enrollmentId = uuid(first.enrollment_id, `${label}.enrollmentId`);
  const journeyId = uuid(first.journey_id, `${label}.journeyId`);
  const journeyVersionId = uuid(first.journey_version_id, `${label}.journeyVersionId`);
  const slug = oneOf(first.journey_slug, PROPERTY_PREDATOR_JOURNEY_SLUGS, `${label}.slug`);
  const name = text(first.journey_name, `${label}.name`);
  const status = oneOf(first.enrollment_status, ENROLLMENT_STATUSES, `${label}.status`);
  const currentMilestoneId = nullableUuid(first.current_milestone_id, `${label}.currentMilestoneId`);
  const enrolledAt = timestamp(first.enrolled_at, `${label}.enrolledAt`);
  const lastEventAt = nullableTimestamp(first.last_event_at, `${label}.lastEventAt`);
  const endedAt = nullableTimestamp(first.ended_at, `${label}.endedAt`);
  if ((status === 'active') !== (endedAt === null)) return fail(`${label} has inconsistent terminal metadata`);
  if (score !== null && score.enrollmentId !== enrollmentId) {
    return fail(`${label} score belongs to another enrollment`);
  }

  const stages = Object.freeze(rows.map((row, stageIndex): Lead360JourneyStageRead => {
    const stageLabel = `${label}.stages[${stageIndex}]`;
    if (uuid(row.enrollment_id, `${stageLabel}.enrollmentId`) !== enrollmentId
        || uuid(row.journey_id, `${stageLabel}.journeyId`) !== journeyId
        || uuid(row.journey_version_id, `${stageLabel}.journeyVersionId`) !== journeyVersionId
        || oneOf(row.journey_slug, PROPERTY_PREDATOR_JOURNEY_SLUGS, `${stageLabel}.slug`) !== slug
        || text(row.journey_name, `${stageLabel}.journeyName`) !== name
        || oneOf(row.enrollment_status, ENROLLMENT_STATUSES, `${stageLabel}.status`) !== status
        || nullableUuid(row.current_milestone_id, `${stageLabel}.currentMilestoneId`) !== currentMilestoneId
        || timestamp(row.enrolled_at, `${stageLabel}.enrolledAt`) !== enrolledAt
        || nullableTimestamp(row.last_event_at, `${stageLabel}.lastEventAt`) !== lastEventAt
        || nullableTimestamp(row.ended_at, `${stageLabel}.endedAt`) !== endedAt) {
      return fail(`${stageLabel} does not describe one stable enrollment`);
    }
    const id = uuid(row.milestone_id, `${stageLabel}.id`);
    return Object.freeze({
      id,
      key: text(row.milestone_key, `${stageLabel}.key`),
      name: text(row.milestone_name, `${stageLabel}.name`),
      position: integer(row.position, `${stageLabel}.position`, 1, 2_147_483_647),
      semantic: oneOf(row.semantic, MILESTONE_SEMANTICS, `${stageLabel}.semantic`),
      isCompletion: bool(row.is_completion, `${stageLabel}.isCompletion`),
      isCurrent: id === currentMilestoneId,
      reachedAt: nullableTimestamp(row.reached_at, `${stageLabel}.reachedAt`),
    });
  }));
  for (let index = 1; index < stages.length; index += 1) {
    if (stages[index - 1]!.position >= stages[index]!.position) {
      return fail(`${label} stages must be strictly ordered`);
    }
  }
  if (currentMilestoneId !== null && stages.filter((stage) => stage.isCurrent).length !== 1) {
    return fail(`${label} current milestone is outside its stage list`);
  }
  if (status === 'completed' && currentMilestoneId === null) {
    return fail(`${label} completed journey must identify its current milestone`);
  }
  return Object.freeze({
    enrollmentId,
    journeyId,
    journeyVersionId,
    slug,
    name,
    status,
    currentMilestoneId,
    enrolledAt,
    lastEventAt,
    endedAt,
    stages,
    score,
  });
}

function journeyRouteRank(journey: Lead360JourneyRead): number {
  const rank = journey.slug ? PROPERTY_PREDATOR_JOURNEY_SLUGS.indexOf(journey.slug) : -1;
  return rank === -1 ? PROPERTY_PREDATOR_JOURNEY_SLUGS.length : rank;
}

function journeyActivityTime(journey: Lead360JourneyRead): number {
  return Date.parse(journey.status === 'active'
    ? (journey.lastEventAt ?? journey.enrolledAt)
    : (journey.endedAt ?? journey.lastEventAt ?? journey.enrolledAt));
}

/** Total ordering for the one journey that owns the headline score and next move. */
function compareJourneyPriority(left: Lead360JourneyRead, right: Lead360JourneyRead): number {
  const leftActive = left.status === 'active';
  const rightActive = right.status === 'active';
  if (leftActive !== rightActive) return leftActive ? -1 : 1;

  if (leftActive) {
    const scoreDifference = (right.score?.total ?? -1) - (left.score?.total ?? -1);
    if (scoreDifference !== 0) return scoreDifference;
  }

  const activityDifference = journeyActivityTime(right) - journeyActivityTime(left);
  if (activityDifference !== 0) return activityDifference;
  const routeDifference = journeyRouteRank(left) - journeyRouteRank(right);
  if (routeDifference !== 0) return routeDifference;
  return left.enrollmentId < right.enrollmentId ? -1 : left.enrollmentId > right.enrollmentId ? 1 : 0;
}

function mapJourneys(
  journeyValues: readonly unknown[],
  scoreValues: readonly unknown[],
  workspaceId: string,
  contactId: string,
): readonly Lead360JourneyRead[] {
  const scores = Object.freeze(scoreValues.map((value, index) => (
    mapScoreRow(value, index, workspaceId, contactId)
  )));
  const scoreByEnrollment = new Map<string, Lead360ScoreRead>();
  for (const score of scores) {
    if (scoreByEnrollment.has(score.enrollmentId)) {
      return fail(`scores contain more than one latest row for enrollment ${score.enrollmentId}`);
    }
    scoreByEnrollment.set(score.enrollmentId, score);
  }

  const groups: Array<{ enrollmentId: string; rows: Record<string, unknown>[] }> = [];
  const groupByEnrollment = new Map<string, { enrollmentId: string; rows: Record<string, unknown>[] }>();
  journeyValues.forEach((value, rowIndex) => {
    const row = record(value, `journeyRows[${rowIndex}]`);
    assertScope(row, `journeyRows[${rowIndex}]`, workspaceId, contactId);
    const enrollmentId = uuid(row.enrollment_id, `journeyRows[${rowIndex}].enrollmentId`);
    let group = groupByEnrollment.get(enrollmentId);
    if (!group) {
      group = { enrollmentId, rows: [] };
      groupByEnrollment.set(enrollmentId, group);
      groups.push(group);
    }
    group.rows.push(row);
  });

  const journeys = Object.freeze(groups.map((group, index) => (
    mapJourneyGroup(group.rows, index, scoreByEnrollment.get(group.enrollmentId) ?? null)
  )).sort(compareJourneyPriority));
  const enrollmentIds = new Set(journeys.map((journey) => journey.enrollmentId));
  if (scores.some((score) => !enrollmentIds.has(score.enrollmentId))) {
    return fail('latest score rows include an enrollment outside the bounded journey set');
  }
  return journeys;
}

function mapEvidence(
  value: unknown,
  index: number,
  workspaceId: string,
  contactId: string,
): Lead360EvidenceRead {
  const row = record(value, `evidence[${index}]`);
  assertScope(row, `evidence[${index}]`, workspaceId, contactId);
  return Object.freeze({
    id: uuid(row.id, `evidence[${index}].id`),
    kind: oneOf(row.evidence_kind, EVIDENCE_KINDS, `evidence[${index}].kind`),
    title: text(row.title, `evidence[${index}].title`),
    detail: nullableText(row.detail, `evidence[${index}].detail`),
    progressBasisPoints: nullableInteger(
      row.progress_basis_points,
      `evidence[${index}].progressBasisPoints`,
      0,
      10_000,
    ),
    occurredAt: timestamp(row.occurred_at, `evidence[${index}].occurredAt`),
    sourceLabel: text(row.source_label, `evidence[${index}].sourceLabel`),
  });
}

function mapOffer(
  value: unknown,
  index: number,
  workspaceId: string,
  contactId: string,
): Lead360OfferRead {
  const row = record(value, `offers[${index}]`);
  assertScope(row, `offers[${index}]`, workspaceId, contactId);
  const responseId = nullableUuid(row.response_id, `offers[${index}].responseId`);
  const responseValue = row.response;
  const respondedAtValue = row.responded_at;
  let latestResponse: Lead360OfferResponseRead | null = null;
  if (responseId === null) {
    if (responseValue !== null || respondedAtValue !== null) {
      return fail(`offers[${index}] has incomplete response metadata`);
    }
  } else {
    latestResponse = Object.freeze({
      id: responseId,
      response: oneOf(responseValue, OFFER_RESPONSES, `offers[${index}].response`),
      respondedAt: timestamp(respondedAtValue, `offers[${index}].respondedAt`),
    });
  }
  return Object.freeze({
    id: uuid(row.id, `offers[${index}].id`),
    offerKey: text(row.offer_key, `offers[${index}].offerKey`),
    label: text(row.offer_label, `offers[${index}].label`),
    offerVersion: text(row.offer_version, `offers[${index}].offerVersion`),
    productKey: text(row.product_key, `offers[${index}].productKey`),
    priceMinor: integer(row.price_minor, `offers[${index}].priceMinor`),
    currency: currency(row.currency, `offers[${index}].currency`),
    placement: text(row.placement, `offers[${index}].placement`),
    presentedAt: timestamp(row.presented_at, `offers[${index}].presentedAt`),
    latestResponse,
  });
}

function mapConsent(
  value: unknown,
  index: number,
  workspaceId: string,
  contactId: string,
): Lead360ConsentRead {
  const row = record(value, `consent[${index}]`);
  assertScope(row, `consent[${index}]`, workspaceId, contactId);
  const consentEventId = nullableUuid(row.consent_event_id, `consent[${index}].consentEventId`);
  const suppressionEventId = nullableUuid(
    row.suppression_event_id,
    `consent[${index}].suppressionEventId`,
  );
  let consentState: (typeof CONSENT_STATES)[number] | null = null;
  let lawfulBasis: (typeof LAWFUL_BASES)[number] | null = null;
  let consentOccurredAt: string | null = null;
  let consentSource: string | null = null;
  let policyVersion: string | null = null;
  let policyTextSha256: string | null = null;
  let recordedAt: string | null = null;
  let recordedByActorKind: (typeof CONSENT_ACTOR_KINDS)[number] | null = null;
  let recordedByUserId: string | null = null;
  if (consentEventId === null) {
    if (row.consent_state !== null || row.lawful_basis !== null || row.consent_occurred_at !== null
      || row.consent_source !== null || row.consent_recorded_at !== null
      || row.consent_actor_kind !== null) {
      return fail(`consent[${index}] has incomplete consent metadata`);
    }
  } else {
    consentState = oneOf(row.consent_state, CONSENT_STATES, `consent[${index}].consentState`);
    lawfulBasis = row.lawful_basis === null
      ? null
      : oneOf(row.lawful_basis, LAWFUL_BASES, `consent[${index}].lawfulBasis`);
    consentOccurredAt = timestamp(row.consent_occurred_at, `consent[${index}].consentOccurredAt`);
    consentSource = text(row.consent_source, `consent[${index}].consentSource`);
    policyVersion = nullableText(row.consent_policy_version, `consent[${index}].policyVersion`);
    policyTextSha256 = nullableText(
      row.consent_policy_sha256, `consent[${index}].policyTextSha256`,
    );
    if (policyTextSha256 !== null && !/^[0-9a-f]{64}$/u.test(policyTextSha256)) {
      return fail(`consent[${index}] policy digest is not a sha256 hex digest`);
    }
    recordedAt = timestamp(row.consent_recorded_at, `consent[${index}].recordedAt`);
    recordedByActorKind = oneOf(
      row.consent_actor_kind, CONSENT_ACTOR_KINDS, `consent[${index}].recordedByActorKind`,
    );
    recordedByUserId = nullableUuid(
      row.consent_actor_user_id, `consent[${index}].recordedByUserId`,
    );
    // The ledger's own rule, re-proved at the read boundary: an operator
    // decision names its operator, and a machine decision never does.
    if ((recordedByActorKind === 'user') !== (recordedByUserId !== null)) {
      return fail(`consent[${index}] operator attribution is inconsistent`);
    }
    if (consentState === 'granted' && lawfulBasis === null) {
      return fail(`consent[${index}] granted consent is missing its lawful basis`);
    }
  }
  let suppressionReason: string | null = null;
  let suppressionOccurredAt: string | null = null;
  let suppressionState: (typeof SUPPRESSION_STATES)[number] | null = null;
  if (suppressionEventId === null) {
    if (row.suppression_reason !== null || row.suppression_occurred_at !== null
      || row.suppression_state !== null) {
      return fail(`consent[${index}] has incomplete suppression metadata`);
    }
  } else {
    suppressionState = oneOf(
      row.suppression_state, SUPPRESSION_STATES, `consent[${index}].suppressionState`,
    );
    suppressionReason = text(row.suppression_reason, `consent[${index}].suppressionReason`);
    suppressionOccurredAt = timestamp(
      row.suppression_occurred_at,
      `consent[${index}].suppressionOccurredAt`,
    );
  }
  const state: Lead360EffectiveConsentState = suppressionEventId !== null
    ? 'suppressed'
    : consentState === 'granted'
      ? 'permitted'
      : consentState ?? 'unknown';
  return Object.freeze({
    contactPointId: uuid(row.contact_point_id, `consent[${index}].contactPointId`),
    contactPointKind: oneOf(
      row.contact_point_kind,
      CONTACT_POINT_KINDS,
      `consent[${index}].contactPointKind`,
    ),
    contactPointLabel: nullableText(row.contact_point_label, `consent[${index}].contactPointLabel`),
    contactPointValue: text(row.contact_point_value, `consent[${index}].contactPointValue`),
    isPrimary: bool(row.is_primary, `consent[${index}].isPrimary`),
    isVerified: bool(row.is_verified, `consent[${index}].isVerified`),
    dedupeState: oneOf(row.dedupe_state, DEDUPE_STATES, `consent[${index}].dedupeState`),
    channel: oneOf(row.channel, COMMUNICATION_CHANNELS, `consent[${index}].channel`),
    purpose: nullableText(row.purpose, `consent[${index}].purpose`),
    state,
    lawfulBasis,
    updatedAt: suppressionOccurredAt ?? consentOccurredAt,
    consentEventId,
    consentSource,
    policyVersion,
    policyTextSha256,
    recordedAt,
    recordedByActorKind,
    recordedByUserId,
    suppressionEventId,
    suppressionState,
    suppressionReason,
  });
}

function mapOpportunity(
  value: unknown,
  index: number,
  workspaceId: string,
  contactId: string,
): Lead360OpportunityRead {
  const row = record(value, `opportunities[${index}]`);
  assertScope(row, `opportunities[${index}]`, workspaceId, contactId);
  const status = oneOf(row.status, OPPORTUNITY_STATUSES, `opportunities[${index}].status`);
  const closedAt = nullableTimestamp(row.closed_at, `opportunities[${index}].closedAt`);
  if ((status === 'open') !== (closedAt === null)) {
    return fail(`opportunities[${index}] has inconsistent closed metadata`);
  }
  return Object.freeze({
    id: uuid(row.id, `opportunities[${index}].id`),
    pipelineId: uuid(row.pipeline_id, `opportunities[${index}].pipelineId`),
    stageId: uuid(row.stage_id, `opportunities[${index}].stageId`),
    stageName: text(row.stage_name, `opportunities[${index}].stageName`),
    title: text(row.title, `opportunities[${index}].title`),
    status,
    valueMinor: integer(row.value_minor, `opportunities[${index}].valueMinor`),
    currency: currency(row.currency, `opportunities[${index}].currency`),
    probability: integer(row.probability, `opportunities[${index}].probability`, 0, 100),
    expectedCloseDate: nullableDate(
      row.expected_close_date,
      `opportunities[${index}].expectedCloseDate`,
    ),
    closedAt,
    updatedAt: timestamp(row.updated_at, `opportunities[${index}].updatedAt`),
  });
}

function mapTask(
  value: unknown,
  index: number,
  workspaceId: string,
  contactId: string,
): Lead360TaskRead {
  const row = record(value, `tasks[${index}]`);
  assertScope(row, `tasks[${index}]`, workspaceId, contactId);
  const status = oneOf(row.status, TASK_STATUSES, `tasks[${index}].status`);
  const completedAt = nullableTimestamp(row.completed_at, `tasks[${index}].completedAt`);
  if ((status === 'completed') !== (completedAt !== null)) {
    return fail(`tasks[${index}] has inconsistent completion metadata`);
  }
  return Object.freeze({
    id: uuid(row.id, `tasks[${index}].id`),
    opportunityId: nullableUuid(row.opportunity_id, `tasks[${index}].opportunityId`),
    title: text(row.title, `tasks[${index}].title`),
    priority: oneOf(row.priority, TASK_PRIORITIES, `tasks[${index}].priority`),
    status,
    dueAt: nullableTimestamp(row.due_at, `tasks[${index}].dueAt`),
    completedAt,
    updatedAt: timestamp(row.updated_at, `tasks[${index}].updatedAt`),
  });
}

async function queryRows(
  transaction: SqlExecutor,
  sql: string,
  contactId: string,
): Promise<readonly Record<string, unknown>[]> {
  const result = await transaction.query(sql, [contactId]);
  return result.rows;
}

export class Lead360ReadService {
  constructor(private readonly dependencies: Lead360ReadDependencies) {}

  async load(
    context: DatabaseRequestContext,
    contactIdInput: string,
  ): Promise<Lead360CaseFileRead | null> {
    validateDatabaseContext(context);
    if (context.actorKind !== 'user' || !context.userId) {
      throw new Lead360ReadDataError('Lead 360 requires an authenticated user context');
    }
    const contactId = uuid(contactIdInput, 'contactId');
    const workspaceId = uuid(context.workspaceId, 'context.workspaceId');
    return this.dependencies.transactionRunner.run(context, async (transaction) => {
      const contactRows = await queryRows(transaction, CONTACT_SQL, contactId);
      if (contactRows.length === 0) return null;
      if (contactRows.length !== 1) {
        throw new Lead360ReadDataError('Lead 360 contact lookup must return at most one row');
      }
      const contact = mapContact(contactRows[0], workspaceId, contactId);
      const journeyRows = await queryRows(transaction, JOURNEY_SQL, contactId);
      const scoreRows = await queryRows(transaction, SCORE_SQL, contactId);
      const evidenceRows = await queryRows(transaction, EVIDENCE_SQL, contactId);
      const offerRows = await queryRows(transaction, OFFERS_SQL, contactId);
      const consentRows = await queryRows(transaction, CONSENT_SQL, contactId);
      const opportunityRows = await queryRows(transaction, OPPORTUNITIES_SQL, contactId);
      const taskRows = await queryRows(transaction, TASKS_SQL, contactId);

      const journeys = mapJourneys(journeyRows, scoreRows, workspaceId, contactId);
      const journey = journeys[0] ?? null;
      const score = journey?.score ?? null;
      const evidence = Object.freeze(evidenceRows.map((row, index) => (
        mapEvidence(row, index, workspaceId, contactId)
      )));
      const offers = Object.freeze(offerRows.map((row, index) => (
        mapOffer(row, index, workspaceId, contactId)
      )));
      const consent = Object.freeze(consentRows.map((row, index) => (
        mapConsent(row, index, workspaceId, contactId)
      )));
      const opportunities = Object.freeze(opportunityRows.map((row, index) => (
        mapOpportunity(row, index, workspaceId, contactId)
      )));
      const tasks = Object.freeze(taskRows.map((row, index) => (
        mapTask(row, index, workspaceId, contactId)
      )));

      return Object.freeze({
        workspaceId,
        contactId,
        asOf: contact.asOf,
        identity: contact.identity,
        journeys,
        journey,
        score,
        evidence,
        offers,
        consent,
        crm: Object.freeze({ opportunities, tasks }),
      });
    });
  }
}

/** Production adapter: every case-file query shares one read-only repeatable-read RLS snapshot. */
export function createPgLead360ReadService(pool: Pick<Pool, 'connect'>): Lead360ReadService {
  return new Lead360ReadService({ transactionRunner: createPgCrmReadTransactionRunner(pool) });
}
