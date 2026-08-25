import type { Pool } from 'pg';
import { createPgCrmReadTransactionRunner } from '../crm-pg/read-model.js';
import type { CrmTransactionRunner, SqlExecutor } from '../crm-pg/types.js';
import { validateDatabaseContext, type DatabaseRequestContext } from '../db/rls.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INTEGER_PATTERN = /^(?:0|[1-9]\d*)$/;
const PER_LANE_CARD_LIMIT = 75;
const STAGE_LIMIT = 100;
const RECENT_ENROLLMENT_DAYS = 180;
const PROPERTY_PREDATOR_JOURNEY_SLUGS = [
  'property-predator-self-serve', 'property-predator-agency-laps',
] as const;
const ENROLLMENT_STATUSES = ['active', 'completed', 'withdrawn', 'disqualified'] as const;
const MILESTONE_SEMANTICS = [
  'lead', 'appointment', 'presentation', 'activation', 'offer', 'sale', 'retention', 'custom',
] as const;
const EVIDENCE_KINDS = [
  'watched', 'listened', 'read', 'downloaded', 'product', 'offer', 'reply',
  'appointment', 'commerce',
] as const;
const MILESTONE_SOURCE_KINDS = ['event', 'commerce', 'manual'] as const;
const EVIDENCE_SOURCE_KINDS = ['verified_webhook', ...MILESTONE_SOURCE_KINDS] as const;
const ACTOR_KINDS = ['user', 'worker', 'webhook', 'system'] as const;
const COMMERCE_FACT_TYPES = ['payment_collected', 'refund_issued', 'subscription_cancelled'] as const;
const OPPORTUNITY_STATUSES = ['open', 'won', 'lost'] as const;
const CONTACT_LIFECYCLES = ['lead', 'customer', 'archived'] as const;
const TASK_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
const ATTRIBUTION_ORIGINS = ['canonical', 'legacy'] as const;

export type JourneyBoardJourneySlug = (typeof PROPERTY_PREDATOR_JOURNEY_SLUGS)[number];
export type JourneyBoardEvidenceKind = (typeof EVIDENCE_KINDS)[number];

export interface JourneyBoardWorkspaceRead {
  readonly id: string;
  readonly name: string;
  readonly timezone: string;
  readonly currency: string;
  readonly defaultPipelineId: string | null;
  readonly canWrite: boolean;
}

export interface JourneyBoardStageRead {
  readonly id: string;
  readonly pipelineId: string;
  readonly name: string;
  readonly position: number;
  readonly stageType: 'open' | 'won' | 'lost';
  readonly isTerminal: boolean;
  readonly rowVersion: number;
}

export interface JourneyBoardScoreRead {
  readonly id: string;
  readonly total: number;
  readonly band: string;
  readonly reasons: readonly string[];
  readonly sourceOccurredAt: string;
  readonly evaluatedAt: string;
}

export interface JourneyBoardMilestoneRead {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly position: number;
  readonly semantic: (typeof MILESTONE_SEMANTICS)[number];
  readonly reachedAt: string | null;
  readonly sourceKind: (typeof MILESTONE_SOURCE_KINDS)[number] | null;
  readonly sourceActorKind: (typeof ACTOR_KINDS)[number] | null;
  readonly commerceFactType: (typeof COMMERCE_FACT_TYPES)[number] | null;
  readonly automatic: boolean;
  readonly paymentVerified: boolean;
}

export interface JourneyBoardPrimaryJourneyRead {
  readonly enrollmentId: string;
  readonly slug: JourneyBoardJourneySlug;
  readonly name: string;
  readonly status: (typeof ENROLLMENT_STATUSES)[number];
  readonly currentMilestone: JourneyBoardMilestoneRead | null;
  readonly score: JourneyBoardScoreRead | null;
  readonly enrolledAt: string;
  readonly lastEventAt: string | null;
  readonly endedAt: string | null;
  /** Other active or recently-ended Property Predator enrollments for this contact. */
  readonly otherEnrollmentCount: number;
}

export interface JourneyBoardEvidenceRead {
  readonly id: string;
  readonly kind: JourneyBoardEvidenceKind;
  readonly title: string;
  readonly detail: string | null;
  readonly progressBasisPoints: number | null;
  readonly occurredAt: string;
  readonly sourceLabel: string;
  readonly sourceKind: (typeof EVIDENCE_SOURCE_KINDS)[number];
  readonly sourceActorKind: (typeof ACTOR_KINDS)[number];
  readonly commerceFactType: (typeof COMMERCE_FACT_TYPES)[number] | null;
  readonly automatic: boolean;
  readonly paymentVerified: boolean;
}

export interface JourneyBoardNextTaskRead {
  readonly id: string;
  readonly title: string;
  readonly priority: (typeof TASK_PRIORITIES)[number];
  readonly dueAt: string | null;
}

export interface JourneyBoardAttributionRead {
  readonly origin: (typeof ATTRIBUTION_ORIGINS)[number];
  readonly sourceSystem: string;
  readonly sourceReference: string;
  readonly attributionType: string | null;
  readonly channel: string | null;
  readonly affiliateId: string | null;
  readonly affiliateSourceId: string | null;
  readonly affiliateName: string | null;
  readonly affiliateCode: string | null;
  readonly referralCode: string | null;
  readonly utmSource: string | null;
  readonly utmMedium: string | null;
  readonly utmCampaign: string | null;
  readonly attributedAt: string;
}

export interface JourneyBoardCardRead {
  readonly opportunityId: string;
  readonly contactId: string;
  readonly contactName: string;
  readonly companyName: string | null;
  readonly lifecycle: (typeof CONTACT_LIFECYCLES)[number];
  readonly primaryEmail: string | null;
  readonly primaryPhone: string | null;
  readonly contactSource: string | null;
  readonly pipelineId: string;
  readonly stageId: string;
  readonly title: string;
  readonly status: (typeof OPPORTUNITY_STATUSES)[number];
  readonly valueMinor: number;
  readonly currency: string;
  readonly probability: number;
  readonly ownerUserId: string | null;
  readonly expectedCloseDate: string | null;
  readonly updatedAt: string;
  /** Required by the existing optimistic CRM move command. */
  readonly rowVersion: number;
  readonly primaryJourney: JourneyBoardPrimaryJourneyRead | null;
  readonly latestEvidence: JourneyBoardEvidenceRead | null;
  readonly contentSummary: string | null;
  readonly offerSummary: string | null;
  readonly nextTask: JourneyBoardNextTaskRead | null;
  readonly attribution: JourneyBoardAttributionRead | null;
}

export interface JourneyBoardLaneCoverageRead {
  readonly stageId: string;
  readonly loadedCardCount: number;
  readonly totalCardCount: number;
  readonly truncated: boolean;
}

export interface JourneyBoardReadSnapshot {
  readonly workspace: JourneyBoardWorkspaceRead;
  readonly asOf: string;
  readonly stages: readonly JourneyBoardStageRead[];
  readonly cards: readonly JourneyBoardCardRead[];
  readonly laneCoverage: readonly JourneyBoardLaneCoverageRead[];
  readonly perLaneCardLimit: number;
  readonly loadedCardCount: number;
  readonly totalCardCount: number;
  readonly truncated: boolean;
}

export interface JourneyBoardReadDependencies {
  readonly transactionRunner: CrmTransactionRunner;
}

export class JourneyBoardReadDataError extends Error {
  readonly code = 'invalid_journey_board_read_data';

  constructor(message: string) {
    super(message);
    this.name = 'JourneyBoardReadDataError';
  }
}

const WORKSPACE_SQL = `/* conversion.journey-board.read-workspace */
  SELECT workspace.id AS workspace_id,
         workspace.name AS workspace_name,
         workspace.timezone,
         workspace.currency,
         default_pipeline.id AS default_pipeline_id,
         app_private.can_write_workspace(
           app_private.current_user_id(), app_private.current_workspace_id()
         ) AS can_write,
         transaction_timestamp() AS snapshot_at
  FROM app.workspaces AS workspace
  LEFT JOIN app.pipelines AS default_pipeline
    ON default_pipeline.workspace_id = workspace.id
   AND default_pipeline.is_default
  WHERE workspace.id = app_private.current_workspace_id()`;

const STAGES_SQL = `/* conversion.journey-board.read-stages */
  SELECT stage.workspace_id,
         stage.pipeline_id,
         stage.id AS stage_id,
         stage.name AS stage_name,
         stage.position,
         stage.stage_type,
         stage.is_terminal,
         stage.row_version::text AS row_version
  FROM app.pipeline_stages AS stage
  JOIN app.pipelines AS pipeline
    ON pipeline.workspace_id = stage.workspace_id
   AND pipeline.id = stage.pipeline_id
   AND pipeline.is_default
  WHERE stage.workspace_id = app_private.current_workspace_id()
  ORDER BY stage.position, stage.id
  LIMIT $1::integer`;

const CARDS_SQL = `/* conversion.journey-board.read-cards */
  WITH route_enrollments AS (
    SELECT enrollment.workspace_id,
           enrollment.contact_id,
           enrollment.id AS enrollment_id,
           enrollment.status AS enrollment_status,
           enrollment.enrolled_at,
           enrollment.last_event_at,
           enrollment.ended_at,
           journey.slug::text AS journey_slug,
           journey.name AS journey_name,
           current_milestone.id AS current_milestone_id,
           current_milestone.milestone_key::text AS current_milestone_key,
           current_milestone.name AS current_milestone_name,
           current_milestone.position AS current_milestone_position,
           current_milestone.semantic AS current_milestone_semantic,
           current_fact.occurred_at AS current_milestone_reached_at,
           current_fact.source_kind AS current_milestone_source_kind,
           current_fact.actor_kind AS current_milestone_actor_kind,
           current_fact.commerce_fact_type AS current_milestone_commerce_fact_type,
           current_payment.id AS current_milestone_payment_fact_id,
           latest_score.id AS score_id,
           latest_score.enrollment_id AS score_enrollment_id,
           latest_score.total_score,
           latest_score.band_key,
           latest_score.reasons,
           latest_score.source_occurred_at,
           latest_score.evaluated_at,
           count(*) OVER (PARTITION BY enrollment.contact_id) AS route_enrollment_count,
           row_number() OVER (
             PARTITION BY enrollment.contact_id
             ORDER BY (enrollment.status = 'active') DESC,
                      CASE WHEN enrollment.status = 'active'
                        THEN latest_score.total_score END DESC NULLS LAST,
                      coalesce(
                        enrollment.last_event_at, enrollment.ended_at, enrollment.enrolled_at
                      ) DESC,
                      CASE journey.slug::text
                        WHEN 'property-predator-self-serve' THEN 0 ELSE 1 END,
                      enrollment.id DESC
           ) AS route_priority
    FROM app.conversion_enrollments AS enrollment
    JOIN app.conversion_journeys AS journey
      ON journey.workspace_id = enrollment.workspace_id
     AND journey.id = enrollment.journey_id
     AND journey.slug::text = ANY($1::text[])
    LEFT JOIN app.conversion_journey_milestones AS current_milestone
      ON current_milestone.workspace_id = enrollment.workspace_id
     AND current_milestone.journey_version_id = enrollment.journey_version_id
     AND current_milestone.id = enrollment.current_milestone_id
    LEFT JOIN app.conversion_milestone_facts AS current_fact
      ON current_fact.workspace_id = enrollment.workspace_id
     AND current_fact.enrollment_id = enrollment.id
     AND current_fact.contact_id = enrollment.contact_id
     AND current_fact.journey_version_id = enrollment.journey_version_id
     AND current_fact.milestone_id = enrollment.current_milestone_id
    LEFT JOIN app.conversion_commerce_facts AS current_payment
      ON current_payment.workspace_id = current_fact.workspace_id
     AND current_payment.id = current_fact.commerce_fact_id
     AND current_payment.enrollment_id = current_fact.enrollment_id
     AND current_payment.contact_id = current_fact.contact_id
     AND current_payment.fact_type = 'payment_collected'
    LEFT JOIN LATERAL (
      SELECT score.id,
             score.enrollment_id,
             score.total_score,
             score.band_key,
             score.reasons,
             score.source_occurred_at,
             score.evaluated_at
      FROM app.lead_score_snapshots AS score
      WHERE score.workspace_id = enrollment.workspace_id
        AND score.enrollment_id = enrollment.id
        AND score.contact_id = enrollment.contact_id
      ORDER BY score.evaluated_at DESC, score.id DESC
      LIMIT 1
    ) AS latest_score ON true
    WHERE enrollment.workspace_id = app_private.current_workspace_id()
      AND (
        enrollment.status = 'active'
        OR coalesce(enrollment.ended_at, enrollment.last_event_at, enrollment.enrolled_at)
             >= transaction_timestamp() - interval '${RECENT_ENROLLMENT_DAYS} days'
      )
  ), primary_route AS (
    SELECT *
    FROM route_enrollments
    WHERE route_priority = 1
  ), board_cards AS (
  SELECT opportunity.workspace_id,
         opportunity.id AS opportunity_id,
         opportunity.contact_id,
         contact.display_name AS contact_name,
         contact.company_name,
         contact.lifecycle_status,
         contact.source AS contact_source,
         primary_email.value AS primary_email,
         primary_phone.value AS primary_phone,
         opportunity.pipeline_id,
         opportunity.stage_id,
         stage.position AS board_stage_position,
         count(*) OVER (PARTITION BY opportunity.stage_id) AS lane_total_count,
         row_number() OVER (
           PARTITION BY opportunity.stage_id
           ORDER BY primary_route.total_score DESC NULLS LAST,
                    opportunity.updated_at DESC,
                    opportunity.id
         ) AS lane_rank,
         opportunity.name AS opportunity_title,
         opportunity.status AS opportunity_status,
         opportunity.value_minor::text AS value_minor,
         opportunity.currency,
         opportunity.probability,
         opportunity.owner_user_id,
         opportunity.expected_close_date::text AS expected_close_date,
         opportunity.updated_at,
         opportunity.row_version::text AS row_version,
         primary_route.enrollment_id AS journey_enrollment_id,
         primary_route.enrollment_status AS journey_enrollment_status,
         primary_route.enrolled_at AS journey_enrolled_at,
         primary_route.last_event_at AS journey_last_event_at,
         primary_route.ended_at AS journey_ended_at,
         primary_route.journey_slug,
         primary_route.journey_name,
         primary_route.current_milestone_id,
         primary_route.current_milestone_key,
         primary_route.current_milestone_name,
         primary_route.current_milestone_position,
         primary_route.current_milestone_semantic,
         primary_route.current_milestone_reached_at,
         primary_route.current_milestone_source_kind,
         primary_route.current_milestone_actor_kind,
         primary_route.current_milestone_commerce_fact_type,
         primary_route.current_milestone_payment_fact_id,
         primary_route.route_enrollment_count::text,
         primary_route.score_id,
         primary_route.score_enrollment_id,
         primary_route.total_score::text,
         primary_route.band_key,
         primary_route.reasons,
         primary_route.source_occurred_at AS score_source_occurred_at,
         primary_route.evaluated_at AS score_evaluated_at,
         latest_evidence.evidence_id,
         latest_evidence.evidence_kind,
         latest_evidence.evidence_title,
         latest_evidence.evidence_detail,
         latest_evidence.progress_basis_points::text,
         latest_evidence.evidence_occurred_at,
         latest_evidence.evidence_source_label,
         latest_evidence.evidence_source_kind,
         latest_evidence.evidence_actor_kind,
         latest_evidence.evidence_commerce_fact_type,
         latest_evidence.evidence_payment_fact_id,
         latest_content.content_summary,
         latest_offer.offer_summary,
         next_task.task_id,
         next_task.task_title,
         next_task.task_priority,
         next_task.task_due_at,
         attribution.attribution_origin,
         attribution.attribution_source_system,
         attribution.attribution_source_reference,
         attribution.attribution_type,
         attribution.attribution_channel,
         attribution.affiliate_id,
         attribution.affiliate_source_id,
         attribution.affiliate_name,
         attribution.affiliate_code,
         attribution.referral_code,
         attribution.utm_source,
         attribution.utm_medium,
         attribution.utm_campaign,
         attribution.attributed_at
  FROM app.opportunities AS opportunity
  JOIN app.pipelines AS pipeline
    ON pipeline.workspace_id = opportunity.workspace_id
   AND pipeline.id = opportunity.pipeline_id
   AND pipeline.is_default
  JOIN app.pipeline_stages AS stage
    ON stage.workspace_id = opportunity.workspace_id
   AND stage.pipeline_id = opportunity.pipeline_id
   AND stage.id = opportunity.stage_id
  JOIN app.contacts AS contact
    ON contact.workspace_id = opportunity.workspace_id
   AND contact.id = opportunity.contact_id
   AND contact.deleted_at IS NULL
  LEFT JOIN primary_route
    ON primary_route.workspace_id = opportunity.workspace_id
   AND primary_route.contact_id = opportunity.contact_id
  LEFT JOIN LATERAL (
    SELECT point.value
    FROM app.contact_points AS point
    WHERE point.workspace_id = opportunity.workspace_id
      AND point.contact_id = opportunity.contact_id
      AND point.kind = 'email'
      AND point.deleted_at IS NULL
    ORDER BY point.is_primary DESC, point.updated_at DESC, point.id
    LIMIT 1
  ) AS primary_email ON true
  LEFT JOIN LATERAL (
    SELECT point.value
    FROM app.contact_points AS point
    WHERE point.workspace_id = opportunity.workspace_id
      AND point.contact_id = opportunity.contact_id
      AND point.kind = 'phone'
      AND point.deleted_at IS NULL
    ORDER BY point.is_primary DESC, point.updated_at DESC, point.id
    LIMIT 1
  ) AS primary_phone ON true
  LEFT JOIN LATERAL (
    SELECT evidence.evidence_id,
           evidence.evidence_kind,
           evidence.evidence_title,
           evidence.evidence_detail,
           evidence.progress_basis_points,
           evidence.evidence_occurred_at,
           evidence.evidence_source_label,
           evidence.evidence_source_kind,
           evidence.evidence_actor_kind,
           evidence.evidence_commerce_fact_type,
           evidence.evidence_payment_fact_id
    FROM (
      SELECT content.id AS evidence_id,
             CASE
               WHEN content.action = 'downloaded' THEN 'downloaded'
               WHEN content.medium = 'video' THEN 'watched'
               WHEN content.medium = 'audio' THEN 'listened'
               ELSE 'read'
             END::text AS evidence_kind,
             content.content_label AS evidence_title,
             content.action || ' · ' || content.content_key || ' · '
               || content.content_version AS evidence_detail,
             content.progress_basis_points,
             content.occurred_at AS evidence_occurred_at,
             'Content · ' || content.medium AS evidence_source_label,
             'verified_webhook'::text AS evidence_source_kind,
             'webhook'::text AS evidence_actor_kind,
             NULL::text AS evidence_commerce_fact_type,
             NULL::uuid AS evidence_payment_fact_id
      FROM app.content_consumption_facts AS content
      WHERE content.workspace_id = opportunity.workspace_id
        AND content.contact_id = opportunity.contact_id
      UNION ALL
      SELECT fact.id,
             CASE
               WHEN milestone.semantic = 'appointment' THEN 'appointment'
               WHEN milestone.semantic IN ('presentation', 'offer') THEN 'offer'
               WHEN milestone.semantic = 'sale' THEN 'commerce'
               ELSE 'product'
             END::text,
             milestone.name,
             milestone.semantic,
             NULL::smallint,
             fact.occurred_at,
             journey.name,
             fact.source_kind,
             fact.actor_kind,
             fact.commerce_fact_type,
             fact.commerce_fact_id
      FROM app.conversion_milestone_facts AS fact
      JOIN app.conversion_enrollments AS enrollment
        ON enrollment.workspace_id = fact.workspace_id
       AND enrollment.id = fact.enrollment_id
       AND enrollment.contact_id = fact.contact_id
      JOIN app.conversion_journeys AS journey
        ON journey.workspace_id = enrollment.workspace_id
       AND journey.id = enrollment.journey_id
       AND journey.slug::text = ANY($1::text[])
      JOIN app.conversion_journey_milestones AS milestone
        ON milestone.workspace_id = fact.workspace_id
       AND milestone.journey_version_id = fact.journey_version_id
       AND milestone.id = fact.milestone_id
      WHERE fact.workspace_id = opportunity.workspace_id
        AND fact.contact_id = opportunity.contact_id
      UNION ALL
      SELECT presentation.id,
             'offer'::text,
             presentation.offer_label,
             presentation.product_key || ' · ' || presentation.placement,
             NULL::smallint,
             presentation.presented_at,
             'Offer presentation'::text,
             'verified_webhook'::text,
             'webhook'::text,
             NULL::text,
             NULL::uuid
      FROM app.offer_presentation_facts AS presentation
      WHERE presentation.workspace_id = opportunity.workspace_id
        AND presentation.contact_id = opportunity.contact_id
      UNION ALL
      SELECT response.id,
             'reply'::text,
             presentation.offer_label,
             response.response,
             NULL::smallint,
             response.responded_at,
             'Offer response'::text,
             'verified_webhook'::text,
             'webhook'::text,
             NULL::text,
             NULL::uuid
      FROM app.offer_response_facts AS response
      JOIN app.offer_presentation_facts AS presentation
        ON presentation.workspace_id = response.workspace_id
       AND presentation.id = response.offer_presentation_id
       AND presentation.contact_id = response.contact_id
      WHERE response.workspace_id = opportunity.workspace_id
        AND response.contact_id = opportunity.contact_id
      UNION ALL
      SELECT commerce.id,
             'commerce'::text,
             commerce.product_key,
             commerce.fact_type || ' · ' || commerce.currency || ' '
               || commerce.amount_minor::text,
             NULL::smallint,
             commerce.occurred_at,
             'Commerce'::text,
             'commerce'::text,
             commerce.actor_kind,
             commerce.fact_type,
             commerce.id
      FROM app.conversion_commerce_facts AS commerce
      WHERE commerce.workspace_id = opportunity.workspace_id
        AND commerce.contact_id = opportunity.contact_id
    ) AS evidence
    ORDER BY evidence.evidence_occurred_at DESC,
             evidence.evidence_kind,
             evidence.evidence_id DESC
    LIMIT 1
  ) AS latest_evidence ON true
  LEFT JOIN LATERAL (
    SELECT consumption.content_label || ' · '
           || CASE consumption.action
                WHEN 'completed' THEN '100% complete'
                WHEN 'downloaded' THEN 'Downloaded'
                ELSE coalesce(
                  trim(to_char(consumption.progress_basis_points / 100.0, 'FM990D0'))
                    || '% complete',
                  consumption.action
                )
              END AS content_summary
    FROM app.content_consumption_facts AS consumption
    WHERE consumption.workspace_id = opportunity.workspace_id
      AND consumption.contact_id = opportunity.contact_id
    ORDER BY consumption.occurred_at DESC, consumption.id DESC
    LIMIT 1
  ) AS latest_content ON true
  LEFT JOIN LATERAL (
    SELECT presentation.offer_label || ' · '
           || coalesce(response.response, 'shown') AS offer_summary
    FROM app.offer_presentation_facts AS presentation
    LEFT JOIN LATERAL (
      SELECT offer_response.response
      FROM app.offer_response_facts AS offer_response
      WHERE offer_response.workspace_id = presentation.workspace_id
        AND offer_response.offer_presentation_id = presentation.id
        AND offer_response.contact_id = opportunity.contact_id
      ORDER BY offer_response.responded_at DESC, offer_response.id DESC
      LIMIT 1
    ) AS response ON true
    WHERE presentation.workspace_id = opportunity.workspace_id
      AND presentation.contact_id = opportunity.contact_id
    ORDER BY presentation.presented_at DESC, presentation.id DESC
    LIMIT 1
  ) AS latest_offer ON true
  LEFT JOIN LATERAL (
    SELECT task.id AS task_id,
           task.title AS task_title,
           task.priority AS task_priority,
           task.due_at AS task_due_at
    FROM app.tasks AS task
    WHERE task.workspace_id = opportunity.workspace_id
      AND task.contact_id = opportunity.contact_id
      AND task.status = 'open'
      AND (task.opportunity_id = opportunity.id OR task.opportunity_id IS NULL)
    ORDER BY (task.opportunity_id = opportunity.id) DESC,
             task.due_at ASC NULLS LAST,
             task.created_at,
             task.id
    LIMIT 1
  ) AS next_task ON true
  LEFT JOIN LATERAL (
    SELECT candidate.attribution_origin,
           candidate.attribution_source_system,
           candidate.attribution_source_reference,
           candidate.attribution_type,
           candidate.attribution_channel,
           candidate.affiliate_id,
           candidate.affiliate_source_id,
           candidate.affiliate_name,
           candidate.affiliate_code,
           candidate.referral_code,
           candidate.utm_source,
           candidate.utm_medium,
           candidate.utm_campaign,
           candidate.attributed_at
    FROM (
      SELECT 'canonical'::text AS attribution_origin,
             fact.source_system AS attribution_source_system,
             fact.source_event_id::text AS attribution_source_reference,
             fact.attribution_type,
             fact.channel AS attribution_channel,
             fact.affiliate_id::text AS affiliate_id,
             NULL::text AS affiliate_source_id,
             NULL::text AS affiliate_name,
             NULL::text AS affiliate_code,
             fact.referral_code,
             fact.utm_source,
             fact.utm_medium,
             fact.utm_campaign,
             fact.attributed_at,
             0 AS origin_rank,
             fact.id AS fact_id
      FROM app.contact_attribution_facts AS fact
      WHERE fact.workspace_id = opportunity.workspace_id
        AND fact.contact_id = opportunity.contact_id
      UNION ALL
      SELECT 'legacy'::text,
             imported.source_system,
             imported.source_record_id,
             NULL::text,
             NULL::text,
             NULL::text,
             imported.affiliate_source_id,
             imported.affiliate_name,
             imported.affiliate_code,
             imported.referral_code,
             imported.utm_source,
             imported.utm_medium,
             imported.utm_campaign,
             imported.attributed_at,
             1,
             imported.id
      FROM app.contact_import_attribution_facts AS imported
      WHERE imported.workspace_id = opportunity.workspace_id
        AND imported.contact_id = opportunity.contact_id
    ) AS candidate
    ORDER BY candidate.attributed_at DESC,
             candidate.origin_rank,
             candidate.fact_id DESC
    LIMIT 1
  ) AS attribution ON true
  WHERE opportunity.workspace_id = app_private.current_workspace_id()
  )
  SELECT *
  FROM board_cards
  WHERE lane_rank <= $2::bigint
  ORDER BY board_stage_position, lane_rank, opportunity_id`;

function fail(message: string): never {
  throw new JourneyBoardReadDataError(message);
}

function row(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return fail(`${label} must be a database row`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string, maximum = 20_000): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum) {
    return fail(`${label} must be non-empty bounded text`);
  }
  return value;
}

function nullableText(value: unknown, label: string, maximum = 20_000): string | null {
  return value === null ? null : text(value, label, maximum);
}

function uuid(value: unknown, label: string): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) return fail(`${label} must be a UUID`);
  return value.toLowerCase();
}

function nullableUuid(value: unknown, label: string): string | null {
  return value === null ? null : uuid(value, label);
}

function bool(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') return fail(`${label} must be boolean`);
  return value;
}

function integer(value: unknown, label: string, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  let parsed: bigint;
  if (typeof value === 'bigint') parsed = value;
  else if (typeof value === 'number' && Number.isSafeInteger(value)) parsed = BigInt(value);
  else if (typeof value === 'string' && INTEGER_PATTERN.test(value)) parsed = BigInt(value);
  else return fail(`${label} must be an integer`);
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
  const date = new Date(Date.UTC(Number(yearText), Number(monthText) - 1, Number(dayText)));
  if (date.getUTCFullYear() !== Number(yearText)
      || date.getUTCMonth() !== Number(monthText) - 1
      || date.getUTCDate() !== Number(dayText)) {
    return fail(`${label} must be a real calendar date`);
  }
  return value;
}

function oneOf<const T extends readonly string[]>(value: unknown, values: T, label: string): T[number] {
  if (typeof value !== 'string' || !values.includes(value)) return fail(`${label} is invalid`);
  return value as T[number];
}

function currency(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[A-Z]{3}$/.test(value)) {
    return fail(`${label} must be an uppercase currency code`);
  }
  return value;
}

function timezone(value: unknown, label: string): string {
  const candidate = text(value, label, 100);
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: candidate }).format(new Date(0));
  } catch {
    return fail(`${label} must be an IANA timezone`);
  }
  return candidate;
}

function stringArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length > 64) return fail(`${label} must be a bounded array`);
  return Object.freeze(value.map((item, index) => text(item, `${label}[${index}]`, 2_000)));
}

function nullableCommerceFactType(value: unknown, label: string): (typeof COMMERCE_FACT_TYPES)[number] | null {
  return value === null ? null : oneOf(value, COMMERCE_FACT_TYPES, label);
}

function milestoneProvenance(
  input: Record<string, unknown>,
  label: string,
  semantic: (typeof MILESTONE_SEMANTICS)[number],
): Pick<JourneyBoardMilestoneRead,
  'reachedAt' | 'sourceKind' | 'sourceActorKind' | 'commerceFactType' | 'automatic' | 'paymentVerified'> {
  const keys = [
    'current_milestone_reached_at', 'current_milestone_source_kind',
    'current_milestone_actor_kind', 'current_milestone_commerce_fact_type',
    'current_milestone_payment_fact_id',
  ] as const;
  if (allNull(input, keys)) {
    if (semantic === 'sale') return fail(`${label} sale is missing verified payment evidence`);
    return Object.freeze({
      reachedAt: null, sourceKind: null, sourceActorKind: null,
      commerceFactType: null, automatic: false, paymentVerified: false,
    });
  }
  const required = [
    'current_milestone_reached_at', 'current_milestone_source_kind',
    'current_milestone_actor_kind',
  ] as const;
  if (required.some((key) => input[key] === null)) return fail(`${label} has incomplete provenance`);
  const sourceKind = oneOf(input.current_milestone_source_kind, MILESTONE_SOURCE_KINDS, `${label}.sourceKind`);
  const sourceActorKind = oneOf(input.current_milestone_actor_kind, ACTOR_KINDS, `${label}.sourceActorKind`);
  const commerceFactType = nullableCommerceFactType(
    input.current_milestone_commerce_fact_type,
    `${label}.commerceFactType`,
  );
  const paymentFactId = nullableUuid(
    input.current_milestone_payment_fact_id,
    `${label}.paymentFactId`,
  );
  if (sourceKind === 'commerce') {
    if (commerceFactType !== 'payment_collected' || paymentFactId === null) {
      return fail(`${label} commerce provenance is not a canonical collected payment`);
    }
  } else if (commerceFactType !== null || paymentFactId !== null) {
    return fail(`${label} non-commerce provenance contains commerce evidence`);
  }
  if (sourceKind === 'manual' && sourceActorKind !== 'user') {
    return fail(`${label} manual provenance requires a user actor`);
  }
  const paymentVerified = sourceKind === 'commerce'
    && commerceFactType === 'payment_collected'
    && paymentFactId !== null;
  if ((semantic === 'sale') !== paymentVerified) {
    return fail(`${label} sale semantic conflicts with canonical payment provenance`);
  }
  return Object.freeze({
    reachedAt: timestamp(input.current_milestone_reached_at, `${label}.reachedAt`),
    sourceKind,
    sourceActorKind,
    commerceFactType,
    automatic: sourceKind === 'commerce'
      || (sourceKind === 'event' && sourceActorKind !== 'user'),
    paymentVerified,
  });
}

function evidenceProvenance(
  input: Record<string, unknown>,
  label: string,
): Pick<JourneyBoardEvidenceRead,
  'sourceKind' | 'sourceActorKind' | 'commerceFactType' | 'automatic' | 'paymentVerified'> {
  const sourceKind = oneOf(input.evidence_source_kind, EVIDENCE_SOURCE_KINDS, `${label}.sourceKind`);
  const sourceActorKind = oneOf(input.evidence_actor_kind, ACTOR_KINDS, `${label}.sourceActorKind`);
  const commerceFactType = nullableCommerceFactType(
    input.evidence_commerce_fact_type,
    `${label}.commerceFactType`,
  );
  const commerceFactId = nullableUuid(input.evidence_payment_fact_id, `${label}.commerceFactId`);
  if (sourceKind === 'commerce') {
    if (commerceFactType === null || commerceFactId === null) {
      return fail(`${label} has incomplete canonical commerce provenance`);
    }
  } else if (commerceFactType !== null || commerceFactId !== null) {
    return fail(`${label} non-commerce source contains commerce provenance`);
  }
  if (sourceKind === 'verified_webhook' && sourceActorKind !== 'webhook') {
    return fail(`${label} verified webhook source requires a webhook actor`);
  }
  if (sourceKind === 'manual' && sourceActorKind !== 'user') {
    return fail(`${label} manual source requires a user actor`);
  }
  return Object.freeze({
    sourceKind,
    sourceActorKind,
    commerceFactType,
    automatic: sourceKind === 'verified_webhook'
      || sourceKind === 'commerce'
      || (sourceKind === 'event' && sourceActorKind !== 'user'),
    paymentVerified: sourceKind === 'commerce'
      && commerceFactType === 'payment_collected'
      && commerceFactId !== null,
  });
}

function mapWorkspace(value: unknown, expectedWorkspaceId: string): {
  workspace: JourneyBoardWorkspaceRead;
  asOf: string;
} {
  const input = row(value, 'workspace');
  const id = uuid(input.workspace_id, 'workspace.id');
  if (id !== expectedWorkspaceId) return fail('workspace escaped the requested RLS scope');
  return Object.freeze({
    workspace: Object.freeze({
      id,
      name: text(input.workspace_name, 'workspace.name', 200),
      timezone: timezone(input.timezone, 'workspace.timezone'),
      currency: currency(input.currency, 'workspace.currency'),
      defaultPipelineId: nullableUuid(input.default_pipeline_id, 'workspace.defaultPipelineId'),
      canWrite: bool(input.can_write, 'workspace.canWrite'),
    }),
    asOf: timestamp(input.snapshot_at, 'workspace.asOf'),
  });
}

function mapStage(
  value: unknown,
  index: number,
  workspaceId: string,
  defaultPipelineId: string,
): JourneyBoardStageRead {
  const input = row(value, `stages[${index}]`);
  if (uuid(input.workspace_id, `stages[${index}].workspaceId`) !== workspaceId) {
    return fail(`stages[${index}] escaped the requested RLS scope`);
  }
  const pipelineId = uuid(input.pipeline_id, `stages[${index}].pipelineId`);
  if (pipelineId !== defaultPipelineId) return fail(`stages[${index}] belongs to another pipeline`);
  const stageType = oneOf(input.stage_type, OPPORTUNITY_STATUSES, `stages[${index}].stageType`);
  const isTerminal = bool(input.is_terminal, `stages[${index}].isTerminal`);
  if (isTerminal !== (stageType === 'won' || stageType === 'lost')) {
    return fail(`stages[${index}] has inconsistent terminal state`);
  }
  return Object.freeze({
    id: uuid(input.stage_id, `stages[${index}].id`),
    pipelineId,
    name: text(input.stage_name, `stages[${index}].name`, 100),
    position: integer(input.position, `stages[${index}].position`, 1, 2_147_483_647),
    stageType,
    isTerminal,
    rowVersion: integer(input.row_version, `stages[${index}].rowVersion`, 1),
  });
}

function allNull(input: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.every((key) => input[key] === null);
}

function mapScore(input: Record<string, unknown>, label: string, enrollmentId: string): JourneyBoardScoreRead | null {
  const keys = [
    'score_id', 'score_enrollment_id', 'total_score', 'band_key', 'reasons',
    'score_source_occurred_at', 'score_evaluated_at',
  ] as const;
  if (allNull(input, keys)) return null;
  if (keys.some((key) => input[key] === null)) return fail(`${label} has incomplete score evidence`);
  if (uuid(input.score_enrollment_id, `${label}.enrollmentId`) !== enrollmentId) {
    return fail(`${label} belongs to another enrollment`);
  }
  return Object.freeze({
    id: uuid(input.score_id, `${label}.id`),
    total: integer(input.total_score, `${label}.total`, 0, 100),
    band: text(input.band_key, `${label}.band`, 63),
    reasons: stringArray(input.reasons, `${label}.reasons`),
    sourceOccurredAt: timestamp(input.score_source_occurred_at, `${label}.sourceOccurredAt`),
    evaluatedAt: timestamp(input.score_evaluated_at, `${label}.evaluatedAt`),
  });
}

function mapJourney(input: Record<string, unknown>, label: string): JourneyBoardPrimaryJourneyRead | null {
  const identityKeys = [
    'journey_enrollment_id', 'journey_enrollment_status', 'journey_enrolled_at',
    'journey_slug', 'journey_name', 'route_enrollment_count',
  ] as const;
  const nullableKeys = [
    ...identityKeys, 'journey_last_event_at', 'journey_ended_at',
    'current_milestone_id', 'current_milestone_key', 'current_milestone_name',
    'current_milestone_position', 'current_milestone_semantic',
    'current_milestone_reached_at', 'current_milestone_source_kind',
    'current_milestone_actor_kind', 'current_milestone_commerce_fact_type',
    'current_milestone_payment_fact_id', 'score_id', 'score_enrollment_id', 'total_score',
    'band_key', 'reasons', 'score_source_occurred_at', 'score_evaluated_at',
  ] as const;
  if (allNull(input, nullableKeys)) return null;
  if (identityKeys.some((key) => input[key] === null)) return fail(`${label} has incomplete journey identity`);

  const enrollmentId = uuid(input.journey_enrollment_id, `${label}.enrollmentId`);
  const status = oneOf(input.journey_enrollment_status, ENROLLMENT_STATUSES, `${label}.status`);
  const endedAt = nullableTimestamp(input.journey_ended_at, `${label}.endedAt`);
  if ((status === 'active') !== (endedAt === null)) return fail(`${label} has inconsistent terminal metadata`);

  const milestoneIdentity = [
    'current_milestone_id', 'current_milestone_key', 'current_milestone_name',
    'current_milestone_position', 'current_milestone_semantic',
  ] as const;
  let currentMilestone: JourneyBoardMilestoneRead | null = null;
  const milestoneFactKeys = [
    'current_milestone_reached_at', 'current_milestone_source_kind',
    'current_milestone_actor_kind', 'current_milestone_commerce_fact_type',
    'current_milestone_payment_fact_id',
  ] as const;
  if (!allNull(input, [...milestoneIdentity, ...milestoneFactKeys])) {
    if (milestoneIdentity.some((key) => input[key] === null)) {
      return fail(`${label} has incomplete current milestone data`);
    }
    const semantic = oneOf(
      input.current_milestone_semantic,
      MILESTONE_SEMANTICS,
      `${label}.currentMilestone.semantic`,
    );
    const provenance = milestoneProvenance(input, `${label}.currentMilestone`, semantic);
    currentMilestone = Object.freeze({
      id: uuid(input.current_milestone_id, `${label}.currentMilestone.id`),
      key: text(input.current_milestone_key, `${label}.currentMilestone.key`, 63),
      name: text(input.current_milestone_name, `${label}.currentMilestone.name`, 120),
      position: integer(
        input.current_milestone_position,
        `${label}.currentMilestone.position`,
        1,
        2_147_483_647,
      ),
      semantic,
      ...provenance,
    });
  }

  const routeEnrollmentCount = integer(
    input.route_enrollment_count,
    `${label}.routeEnrollmentCount`,
    1,
    100_000,
  );
  return Object.freeze({
    enrollmentId,
    slug: oneOf(input.journey_slug, PROPERTY_PREDATOR_JOURNEY_SLUGS, `${label}.slug`),
    name: text(input.journey_name, `${label}.name`, 120),
    status,
    currentMilestone,
    score: mapScore(input, `${label}.score`, enrollmentId),
    enrolledAt: timestamp(input.journey_enrolled_at, `${label}.enrolledAt`),
    lastEventAt: nullableTimestamp(input.journey_last_event_at, `${label}.lastEventAt`),
    endedAt,
    otherEnrollmentCount: routeEnrollmentCount - 1,
  });
}

function mapEvidence(input: Record<string, unknown>, label: string): JourneyBoardEvidenceRead | null {
  const requiredKeys = [
    'evidence_id', 'evidence_kind', 'evidence_title', 'evidence_occurred_at',
    'evidence_source_label', 'evidence_source_kind', 'evidence_actor_kind',
  ] as const;
  const allKeys = [
    ...requiredKeys, 'evidence_detail', 'progress_basis_points',
    'evidence_commerce_fact_type', 'evidence_payment_fact_id',
  ] as const;
  if (allNull(input, allKeys)) return null;
  if (requiredKeys.some((key) => input[key] === null)) return fail(`${label} is incomplete`);
  return Object.freeze({
    id: uuid(input.evidence_id, `${label}.id`),
    kind: oneOf(input.evidence_kind, EVIDENCE_KINDS, `${label}.kind`),
    title: text(input.evidence_title, `${label}.title`, 500),
    detail: nullableText(input.evidence_detail, `${label}.detail`, 2_000),
    progressBasisPoints: nullableInteger(
      input.progress_basis_points,
      `${label}.progressBasisPoints`,
      0,
      10_000,
    ),
    occurredAt: timestamp(input.evidence_occurred_at, `${label}.occurredAt`),
    sourceLabel: text(input.evidence_source_label, `${label}.sourceLabel`, 500),
    ...evidenceProvenance(input, label),
  });
}

function mapTask(input: Record<string, unknown>, label: string): JourneyBoardNextTaskRead | null {
  const requiredKeys = ['task_id', 'task_title', 'task_priority'] as const;
  const allKeys = [...requiredKeys, 'task_due_at'] as const;
  if (allNull(input, allKeys)) return null;
  if (requiredKeys.some((key) => input[key] === null)) return fail(`${label} is incomplete`);
  return Object.freeze({
    id: uuid(input.task_id, `${label}.id`),
    title: text(input.task_title, `${label}.title`, 300),
    priority: oneOf(input.task_priority, TASK_PRIORITIES, `${label}.priority`),
    dueAt: nullableTimestamp(input.task_due_at, `${label}.dueAt`),
  });
}

function mapAttribution(input: Record<string, unknown>, label: string): JourneyBoardAttributionRead | null {
  const requiredKeys = [
    'attribution_origin', 'attribution_source_system',
    'attribution_source_reference', 'attributed_at',
  ] as const;
  const allKeys = [
    ...requiredKeys, 'attribution_type', 'attribution_channel', 'affiliate_id',
    'affiliate_source_id', 'affiliate_name', 'affiliate_code', 'referral_code',
    'utm_source', 'utm_medium', 'utm_campaign',
  ] as const;
  if (allNull(input, allKeys)) return null;
  if (requiredKeys.some((key) => input[key] === null)) return fail(`${label} is incomplete`);
  const origin = oneOf(input.attribution_origin, ATTRIBUTION_ORIGINS, `${label}.origin`);
  const affiliateId = nullableUuid(input.affiliate_id, `${label}.affiliateId`);
  const affiliateSourceId = nullableText(
    input.affiliate_source_id,
    `${label}.affiliateSourceId`,
    300,
  );
  if (origin === 'canonical' && affiliateSourceId !== null) {
    return fail(`${label} canonical attribution contains a legacy affiliate source`);
  }
  if (origin === 'legacy' && affiliateId !== null) {
    return fail(`${label} legacy attribution contains a canonical affiliate id`);
  }
  return Object.freeze({
    origin,
    sourceSystem: text(input.attribution_source_system, `${label}.sourceSystem`, 100),
    sourceReference: text(input.attribution_source_reference, `${label}.sourceReference`, 300),
    attributionType: nullableText(input.attribution_type, `${label}.type`, 100),
    channel: nullableText(input.attribution_channel, `${label}.channel`, 100),
    affiliateId,
    affiliateSourceId,
    affiliateName: nullableText(input.affiliate_name, `${label}.affiliateName`, 300),
    affiliateCode: nullableText(input.affiliate_code, `${label}.affiliateCode`, 300),
    referralCode: nullableText(input.referral_code, `${label}.referralCode`, 300),
    utmSource: nullableText(input.utm_source, `${label}.utmSource`, 300),
    utmMedium: nullableText(input.utm_medium, `${label}.utmMedium`, 300),
    utmCampaign: nullableText(input.utm_campaign, `${label}.utmCampaign`, 500),
    attributedAt: timestamp(input.attributed_at, `${label}.attributedAt`),
  });
}

interface MappedJourneyBoardCard {
  readonly card: JourneyBoardCardRead;
  readonly laneRank: number;
  readonly laneTotalCount: number;
}

function mapCard(
  value: unknown,
  index: number,
  workspaceId: string,
  defaultPipelineId: string,
  stagesById: ReadonlyMap<string, JourneyBoardStageRead>,
): MappedJourneyBoardCard {
  const input = row(value, `cards[${index}]`);
  if (uuid(input.workspace_id, `cards[${index}].workspaceId`) !== workspaceId) {
    return fail(`cards[${index}] escaped the requested RLS scope`);
  }
  const pipelineId = uuid(input.pipeline_id, `cards[${index}].pipelineId`);
  if (pipelineId !== defaultPipelineId) return fail(`cards[${index}] belongs to another pipeline`);
  const stageId = uuid(input.stage_id, `cards[${index}].stageId`);
  const stage = stagesById.get(stageId);
  if (!stage) return fail(`cards[${index}] references a stage outside the default board`);
  if (integer(input.board_stage_position, `cards[${index}].stagePosition`, 1) !== stage.position) {
    return fail(`cards[${index}] stage ordering conflicts with the board`);
  }
  const laneRank = integer(input.lane_rank, `cards[${index}].laneRank`, 1, PER_LANE_CARD_LIMIT);
  const laneTotalCount = integer(input.lane_total_count, `cards[${index}].laneTotalCount`, laneRank);
  const status = oneOf(input.opportunity_status, OPPORTUNITY_STATUSES, `cards[${index}].status`);
  if (status !== stage.stageType) return fail(`cards[${index}] status conflicts with its stage`);
  const card = Object.freeze({
    opportunityId: uuid(input.opportunity_id, `cards[${index}].opportunityId`),
    contactId: uuid(input.contact_id, `cards[${index}].contactId`),
    contactName: text(input.contact_name, `cards[${index}].contactName`, 200),
    companyName: nullableText(input.company_name, `cards[${index}].companyName`, 200),
    lifecycle: oneOf(input.lifecycle_status, CONTACT_LIFECYCLES, `cards[${index}].lifecycle`),
    primaryEmail: nullableText(input.primary_email, `cards[${index}].primaryEmail`, 500),
    primaryPhone: nullableText(input.primary_phone, `cards[${index}].primaryPhone`, 500),
    contactSource: nullableText(input.contact_source, `cards[${index}].contactSource`, 100),
    pipelineId,
    stageId,
    title: text(input.opportunity_title, `cards[${index}].title`, 200),
    status,
    valueMinor: integer(input.value_minor, `cards[${index}].valueMinor`),
    currency: currency(input.currency, `cards[${index}].currency`),
    probability: integer(input.probability, `cards[${index}].probability`, 0, 100),
    ownerUserId: nullableUuid(input.owner_user_id, `cards[${index}].ownerUserId`),
    expectedCloseDate: nullableDate(input.expected_close_date, `cards[${index}].expectedCloseDate`),
    updatedAt: timestamp(input.updated_at, `cards[${index}].updatedAt`),
    rowVersion: integer(input.row_version, `cards[${index}].rowVersion`, 1),
    primaryJourney: mapJourney(input, `cards[${index}].primaryJourney`),
    latestEvidence: mapEvidence(input, `cards[${index}].latestEvidence`),
    contentSummary: nullableText(input.content_summary, `cards[${index}].contentSummary`, 500),
    offerSummary: nullableText(input.offer_summary, `cards[${index}].offerSummary`, 500),
    nextTask: mapTask(input, `cards[${index}].nextTask`),
    attribution: mapAttribution(input, `cards[${index}].attribution`),
  });
  return Object.freeze({ card, laneRank, laneTotalCount });
}

async function queryRows(
  transaction: SqlExecutor,
  sql: string,
  values?: readonly unknown[],
): Promise<readonly Record<string, unknown>[]> {
  return (await transaction.query(sql, values)).rows;
}

export class JourneyBoardReadService {
  constructor(private readonly dependencies: JourneyBoardReadDependencies) {}

  async load(context: DatabaseRequestContext): Promise<JourneyBoardReadSnapshot> {
    validateDatabaseContext(context);
    if (context.actorKind !== 'user' || !context.userId) {
      throw new JourneyBoardReadDataError('Journey Board requires an authenticated user context');
    }
    const workspaceId = context.workspaceId.toLowerCase();
    return this.dependencies.transactionRunner.run(context, async (transaction) => {
      const workspaceRows = await queryRows(transaction, WORKSPACE_SQL);
      if (workspaceRows.length !== 1) {
        throw new JourneyBoardReadDataError('Journey Board must resolve exactly one visible workspace');
      }
      const mappedWorkspace = mapWorkspace(workspaceRows[0], workspaceId);
      const stageRows = await queryRows(transaction, STAGES_SQL, [STAGE_LIMIT + 1]);
      if (stageRows.length > STAGE_LIMIT) {
        throw new JourneyBoardReadDataError('Journey Board exceeds the supported stage limit');
      }
      const defaultPipelineId = mappedWorkspace.workspace.defaultPipelineId;
      if (defaultPipelineId === null && stageRows.length > 0) {
        throw new JourneyBoardReadDataError('Journey Board stages exist without a visible default pipeline');
      }
      const stages = Object.freeze(defaultPipelineId === null
        ? []
        : stageRows.map((stage, index) => (
          mapStage(stage, index, workspaceId, defaultPipelineId)
        )));
      const stageIds = new Set<string>();
      let lastPosition = 0;
      for (const stage of stages) {
        if (stageIds.has(stage.id)) throw new JourneyBoardReadDataError('Journey Board contains a duplicate stage');
        if (stage.position <= lastPosition) {
          throw new JourneyBoardReadDataError('Journey Board stages are not strictly ordered');
        }
        stageIds.add(stage.id);
        lastPosition = stage.position;
      }

      const cardRows = await queryRows(transaction, CARDS_SQL, [
        PROPERTY_PREDATOR_JOURNEY_SLUGS,
        PER_LANE_CARD_LIMIT,
      ]);
      if (defaultPipelineId === null && cardRows.length > 0) {
        throw new JourneyBoardReadDataError('Journey Board cards exist without a visible default pipeline');
      }
      if (cardRows.length > stages.length * PER_LANE_CARD_LIMIT) {
        throw new JourneyBoardReadDataError('Journey Board exceeded its bounded per-lane result');
      }
      const stagesById = new Map(stages.map((stage) => [stage.id, stage]));
      const mappedCards = Object.freeze((defaultPipelineId === null ? [] : cardRows)
        .map((card, index) => mapCard(
          card,
          index,
          workspaceId,
          defaultPipelineId!,
          stagesById,
        )));
      const cards = Object.freeze(mappedCards.map((item) => item.card));
      if (new Set(cards.map((card) => card.opportunityId)).size !== cards.length) {
        throw new JourneyBoardReadDataError('Journey Board contains duplicate opportunity cards');
      }
      const laneCoverage = Object.freeze(stages.map((stage): JourneyBoardLaneCoverageRead => {
        const laneCards = mappedCards.filter((item) => item.card.stageId === stage.id);
        const totals = new Set(laneCards.map((item) => item.laneTotalCount));
        if (totals.size > 1) {
          return fail(`Journey Board lane ${stage.id} has inconsistent total counts`);
        }
        const totalCardCount = laneCards[0]?.laneTotalCount ?? 0;
        const expectedLoaded = Math.min(totalCardCount, PER_LANE_CARD_LIMIT);
        if (laneCards.length !== expectedLoaded) {
          return fail(`Journey Board lane ${stage.id} returned an incomplete bounded page`);
        }
        const ranks = new Set(laneCards.map((item) => item.laneRank));
        if (ranks.size !== laneCards.length
            || laneCards.some((_, index) => !ranks.has(index + 1))) {
          return fail(`Journey Board lane ${stage.id} has invalid bounded ranks`);
        }
        return Object.freeze({
          stageId: stage.id,
          loadedCardCount: laneCards.length,
          totalCardCount,
          truncated: totalCardCount > laneCards.length,
        });
      }));
      const totalCardCount = laneCoverage.reduce((sum, lane) => sum + lane.totalCardCount, 0);
      if (!Number.isSafeInteger(totalCardCount)) {
        throw new JourneyBoardReadDataError('Journey Board total card count is outside its safe range');
      }
      const truncated = laneCoverage.some((lane) => lane.truncated);
      return Object.freeze({
        workspace: mappedWorkspace.workspace,
        asOf: mappedWorkspace.asOf,
        stages,
        cards,
        laneCoverage,
        perLaneCardLimit: PER_LANE_CARD_LIMIT,
        loadedCardCount: cards.length,
        totalCardCount,
        truncated,
      });
    });
  }
}

/** Production adapter: all board queries share one stable, read-only RLS snapshot. */
export function createPgJourneyBoardReadService(
  pool: Pick<Pool, 'connect'>,
): JourneyBoardReadService {
  return new JourneyBoardReadService({
    transactionRunner: createPgCrmReadTransactionRunner(pool),
  });
}
