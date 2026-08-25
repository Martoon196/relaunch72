import type { Pool } from 'pg';
import { validateDatabaseContext, type DatabaseRequestContext } from '../db/rls.js';
import { createPgCrmReadTransactionRunner } from '../crm-pg/read-model.js';
import type { CrmTransactionRunner, SqlExecutor } from '../crm-pg/types.js';

const JOURNEY_SLUGS = ['property-predator-self-serve', 'property-predator-agency-laps'] as const;
const EVIDENCE_KINDS = [
  'watched', 'listened', 'read', 'downloaded', 'offer_shown', 'reply',
] as const;

export type GrowthJourneySlug = (typeof JOURNEY_SLUGS)[number];
export type GrowthReadEvidenceKind = (typeof EVIDENCE_KINDS)[number];

export interface GrowthFunnelStageRead {
  readonly journeySlug: GrowthJourneySlug;
  readonly journeyName: string;
  readonly journeyDescription: string;
  readonly milestoneKey: string;
  readonly milestoneName: string;
  readonly position: number;
  readonly count: number;
  readonly movedInWindow: number;
}

export interface GrowthHotLeadRead {
  readonly contactId: string;
  readonly displayName: string;
  readonly companyName: string | null;
  readonly journeySlug: GrowthJourneySlug;
  readonly currentStage: string | null;
  readonly score: number | null;
  readonly band: string | null;
  readonly evidenceKind: GrowthReadEvidenceKind | null;
  readonly evidenceLabel: string | null;
  readonly evidenceDetail: string | null;
  readonly evidenceAt: string | null;
  readonly contentSummary: string | null;
  readonly offerSummary: string | null;
}

export interface GrowthEvidenceTotalsRead {
  readonly contentStarted: number;
  readonly contentCompleted: number;
  readonly offersShown: number;
  readonly replies: number;
  readonly appointments: number;
}

export interface GrowthIntelligenceReadSnapshot {
  readonly asOf: string;
  readonly windowLabel: 'Last 30 days';
  readonly funnels: readonly GrowthFunnelStageRead[];
  readonly hotLeads: readonly GrowthHotLeadRead[];
  readonly evidenceTotals: GrowthEvidenceTotalsRead;
}

export interface GrowthIntelligenceReadDependencies {
  readonly transactionRunner: CrmTransactionRunner;
}

export class GrowthIntelligenceReadDataError extends Error {
  readonly code = 'invalid_growth_intelligence_read_data';

  constructor(message: string) {
    super(message);
    this.name = 'GrowthIntelligenceReadDataError';
  }
}

const FUNNEL_SQL = `/* conversion.growth.read-funnels */
  SELECT journey.slug::text AS journey_slug,
         journey.name AS journey_name,
         journey.description AS journey_description,
         milestone.milestone_key::text AS milestone_key,
         milestone.name AS milestone_name,
         milestone.position,
         count(DISTINCT fact.contact_id)::text AS achieved_count,
         count(DISTINCT fact.contact_id) FILTER (
           WHERE fact.occurred_at >= transaction_timestamp() - interval '30 days'
             AND fact.occurred_at <= transaction_timestamp()
         )::text AS moved_in_window
  FROM app.conversion_journeys AS journey
  JOIN app.conversion_journey_versions AS version
    ON version.workspace_id = journey.workspace_id
   AND version.journey_id = journey.id
   AND version.id = journey.active_version_id
  JOIN app.conversion_journey_milestones AS milestone
    ON milestone.workspace_id = version.workspace_id
   AND milestone.journey_version_id = version.id
  LEFT JOIN app.conversion_milestone_facts AS fact
    ON fact.workspace_id = milestone.workspace_id
   AND fact.journey_version_id = milestone.journey_version_id
   AND fact.milestone_id = milestone.id
  WHERE journey.workspace_id = app_private.current_workspace_id()
    AND journey.slug::text = ANY($1::text[])
  GROUP BY journey.slug, journey.name, journey.description,
           milestone.milestone_key, milestone.name, milestone.position
  ORDER BY journey.slug, milestone.position`;

const HOT_LEADS_SQL = `/* conversion.growth.read-hot-leads */
  SELECT ranked.contact_id,
         ranked.display_name,
         ranked.company_name,
         ranked.journey_slug,
         ranked.current_stage,
         ranked.total_score,
         ranked.band_key,
         ranked.evidence_kind,
         ranked.evidence_label,
         ranked.evidence_detail,
         ranked.evidence_at,
         ranked.content_summary,
         ranked.offer_summary
  FROM (
  SELECT DISTINCT ON (enrollment.contact_id)
         enrollment.contact_id,
         contact.display_name,
         contact.company_name,
         journey.slug::text AS journey_slug,
         current_milestone.name AS current_stage,
         latest_score.total_score::text AS total_score,
         latest_score.band_key AS band_key,
         latest_evidence.kind AS evidence_kind,
         latest_evidence.label AS evidence_label,
         latest_evidence.detail AS evidence_detail,
         latest_evidence.occurred_at AS evidence_at,
         latest_content.summary AS content_summary,
         latest_offer.summary AS offer_summary,
         latest_score.total_score AS score_sort,
         latest_score.evaluated_at AS score_evaluated_at,
         enrollment.last_event_at AS enrollment_last_event_at,
         current_milestone.position AS current_stage_position,
         enrollment.id AS enrollment_id
  FROM app.conversion_enrollments AS enrollment
  JOIN app.contacts AS contact
    ON contact.workspace_id = enrollment.workspace_id
   AND contact.id = enrollment.contact_id
   AND contact.deleted_at IS NULL
  JOIN app.conversion_journeys AS journey
    ON journey.workspace_id = enrollment.workspace_id
   AND journey.id = enrollment.journey_id
  LEFT JOIN app.conversion_journey_milestones AS current_milestone
    ON current_milestone.workspace_id = enrollment.workspace_id
   AND current_milestone.journey_version_id = enrollment.journey_version_id
   AND current_milestone.id = enrollment.current_milestone_id
  LEFT JOIN LATERAL (
    SELECT score.total_score, score.band_key, score.evaluated_at
    FROM app.lead_score_snapshots AS score
    WHERE score.workspace_id = enrollment.workspace_id
      AND score.enrollment_id = enrollment.id
    ORDER BY score.evaluated_at DESC, score.id DESC
    LIMIT 1
  ) AS latest_score ON true
  LEFT JOIN LATERAL (
    SELECT evidence.kind, evidence.label, evidence.detail, evidence.occurred_at
    FROM (
      SELECT CASE
               WHEN consumption.action = 'downloaded' THEN 'downloaded'
               WHEN consumption.medium = 'video' THEN 'watched'
               WHEN consumption.medium = 'audio' THEN 'listened'
               ELSE 'read'
             END AS kind,
             consumption.content_label AS label,
             CASE consumption.action
               WHEN 'completed' THEN '100% complete'
               WHEN 'downloaded' THEN 'Downloaded'
               WHEN 'started' THEN 'Started'
               ELSE trim(to_char(consumption.progress_basis_points / 100.0, 'FM990D0')) || '% complete'
             END AS detail,
             consumption.occurred_at,
             consumption.id AS source_id
      FROM app.content_consumption_facts AS consumption
      WHERE consumption.workspace_id = enrollment.workspace_id
        AND consumption.contact_id = enrollment.contact_id
      UNION ALL
      SELECT 'offer_shown', presentation.offer_label,
             CASE WHEN presentation.price_minor IS NULL THEN presentation.product_key
                  ELSE presentation.currency || ' ' || trim(to_char(presentation.price_minor / 100.0, 'FM9999999990D00'))
             END,
             presentation.presented_at,
             presentation.id AS source_id
      FROM app.offer_presentation_facts AS presentation
      WHERE presentation.workspace_id = enrollment.workspace_id
        AND presentation.contact_id = enrollment.contact_id
      UNION ALL
      SELECT 'reply', response.response, 'Offer response', response.responded_at,
             response.id AS source_id
      FROM app.offer_response_facts AS response
      WHERE response.workspace_id = enrollment.workspace_id
        AND response.contact_id = enrollment.contact_id
    ) AS evidence
    ORDER BY evidence.occurred_at DESC, evidence.kind, evidence.label,
             evidence.source_id DESC
    LIMIT 1
  ) AS latest_evidence ON true
  LEFT JOIN LATERAL (
    SELECT consumption.content_label || ' · '
           || trim(to_char(consumption.progress_basis_points / 100.0, 'FM990D0')) || '%' AS summary
    FROM app.content_consumption_facts AS consumption
    WHERE consumption.workspace_id = enrollment.workspace_id
      AND consumption.contact_id = enrollment.contact_id
    ORDER BY consumption.occurred_at DESC, consumption.id DESC
    LIMIT 1
  ) AS latest_content ON true
  LEFT JOIN LATERAL (
    SELECT presentation.offer_label || ' · '
           || COALESCE(response.response, 'shown') AS summary
    FROM app.offer_presentation_facts AS presentation
    LEFT JOIN LATERAL (
      SELECT offer_response.response
      FROM app.offer_response_facts AS offer_response
      WHERE offer_response.workspace_id = presentation.workspace_id
        AND offer_response.offer_presentation_id = presentation.id
      ORDER BY offer_response.responded_at DESC, offer_response.id DESC
      LIMIT 1
    ) AS response ON true
    WHERE presentation.workspace_id = enrollment.workspace_id
      AND presentation.contact_id = enrollment.contact_id
    ORDER BY presentation.presented_at DESC, presentation.id DESC
    LIMIT 1
  ) AS latest_offer ON true
  WHERE enrollment.workspace_id = app_private.current_workspace_id()
    AND journey.slug::text = ANY($1::text[])
    AND enrollment.status = 'active'
    AND latest_score.total_score >= 22
  ORDER BY enrollment.contact_id,
           latest_score.total_score DESC NULLS LAST,
           latest_score.evaluated_at DESC,
           enrollment.last_event_at DESC NULLS LAST,
           current_milestone.position DESC NULLS LAST,
           journey.slug::text,
           enrollment.id DESC
  ) AS ranked
  ORDER BY ranked.score_sort DESC NULLS LAST,
           ranked.score_evaluated_at DESC,
           ranked.enrollment_last_event_at DESC NULLS LAST,
           ranked.current_stage_position DESC NULLS LAST,
           ranked.contact_id,
           ranked.enrollment_id DESC
  LIMIT 20`;

const TOTALS_SQL = `/* conversion.growth.read-evidence-totals */
  SELECT transaction_timestamp() AS snapshot_at,
         (SELECT count(DISTINCT (fact.contact_id, fact.content_key, fact.content_version)) FROM app.content_consumption_facts AS fact
           WHERE fact.workspace_id = app_private.current_workspace_id()
             AND fact.action IN ('started', 'progressed')
             AND fact.occurred_at >= transaction_timestamp() - interval '30 days'
             AND fact.occurred_at <= transaction_timestamp())::text AS content_started,
         (SELECT count(DISTINCT (fact.contact_id, fact.content_key, fact.content_version)) FROM app.content_consumption_facts AS fact
           WHERE fact.workspace_id = app_private.current_workspace_id()
             AND fact.action = 'completed'
             AND fact.occurred_at >= transaction_timestamp() - interval '30 days'
             AND fact.occurred_at <= transaction_timestamp())::text AS content_completed,
         (SELECT count(*) FROM app.offer_presentation_facts AS fact
           WHERE fact.workspace_id = app_private.current_workspace_id()
             AND fact.presented_at >= transaction_timestamp() - interval '30 days'
             AND fact.presented_at <= transaction_timestamp())::text AS offers_shown,
         (SELECT count(*) FROM app.offer_response_facts AS fact
           WHERE fact.workspace_id = app_private.current_workspace_id()
             AND fact.responded_at >= transaction_timestamp() - interval '30 days'
             AND fact.responded_at <= transaction_timestamp())::text AS replies,
         (SELECT count(*) FROM app.conversion_milestone_facts AS fact
           WHERE fact.workspace_id = app_private.current_workspace_id()
             AND fact.milestone_semantic = 'appointment'
             AND fact.occurred_at >= transaction_timestamp() - interval '30 days'
             AND fact.occurred_at <= transaction_timestamp())::text AS appointments`;

function fail(message: string): never {
  throw new GrowthIntelligenceReadDataError(message);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail(`${label} must be a row`);
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string, nullable = false): string | null {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || value.length === 0) return fail(`${label} must be non-empty text`);
  return value;
}

function uuid(value: unknown, label: string): string {
  const candidate = text(value, label)!;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(candidate)) {
    return fail(`${label} must be a UUID`);
  }
  return candidate.toLowerCase();
}

function integer(value: unknown, label: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)$/.test(value)) return fail(`${label} must be a non-negative integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > maximum) return fail(`${label} is outside the safe range`);
  return parsed;
}

function position(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 32) {
    return fail(`${label} must be a valid milestone position`);
  }
  return value;
}

function timestamp(value: unknown, label: string, nullable = false): string | null {
  if (nullable && value === null) return null;
  const date = value instanceof Date ? value : typeof value === 'string' ? new Date(value) : null;
  if (!date || !Number.isFinite(date.getTime())) return fail(`${label} must be a timestamp`);
  return date.toISOString();
}

function journeySlug(value: unknown, label: string): GrowthJourneySlug {
  const candidate = text(value, label)!;
  if (!(JOURNEY_SLUGS as readonly string[]).includes(candidate)) return fail(`${label} is not a Property Predator journey`);
  return candidate as GrowthJourneySlug;
}

function evidenceKind(value: unknown, label: string): GrowthReadEvidenceKind | null {
  if (value === null) return null;
  const candidate = text(value, label)!;
  if (!(EVIDENCE_KINDS as readonly string[]).includes(candidate)) return fail(`${label} is unsupported`);
  return candidate as GrowthReadEvidenceKind;
}

function mapFunnel(value: unknown, index: number): GrowthFunnelStageRead {
  const row = record(value, `funnels[${index}]`);
  return Object.freeze({
    journeySlug: journeySlug(row.journey_slug, `funnels[${index}].journeySlug`),
    journeyName: text(row.journey_name, `funnels[${index}].journeyName`)!,
    journeyDescription: text(row.journey_description, `funnels[${index}].journeyDescription`)!,
    milestoneKey: text(row.milestone_key, `funnels[${index}].milestoneKey`)!,
    milestoneName: text(row.milestone_name, `funnels[${index}].milestoneName`)!,
    position: position(row.position, `funnels[${index}].position`),
    count: integer(row.achieved_count, `funnels[${index}].count`),
    movedInWindow: integer(row.moved_in_window, `funnels[${index}].movedInWindow`),
  });
}

function mapLead(value: unknown, index: number): GrowthHotLeadRead {
  const row = record(value, `hotLeads[${index}]`);
  const score = row.total_score === null ? null : integer(row.total_score, `hotLeads[${index}].score`, 100);
  const band = text(row.band_key, `hotLeads[${index}].band`, true);
  if ((score === null) !== (band === null)) return fail(`hotLeads[${index}] has incomplete score evidence`);
  return Object.freeze({
    contactId: uuid(row.contact_id, `hotLeads[${index}].contactId`),
    displayName: text(row.display_name, `hotLeads[${index}].displayName`)!,
    companyName: text(row.company_name, `hotLeads[${index}].companyName`, true),
    journeySlug: journeySlug(row.journey_slug, `hotLeads[${index}].journeySlug`),
    currentStage: text(row.current_stage, `hotLeads[${index}].currentStage`, true),
    score,
    band,
    evidenceKind: evidenceKind(row.evidence_kind, `hotLeads[${index}].evidenceKind`),
    evidenceLabel: text(row.evidence_label, `hotLeads[${index}].evidenceLabel`, true),
    evidenceDetail: text(row.evidence_detail, `hotLeads[${index}].evidenceDetail`, true),
    evidenceAt: timestamp(row.evidence_at, `hotLeads[${index}].evidenceAt`, true),
    contentSummary: text(row.content_summary, `hotLeads[${index}].contentSummary`, true),
    offerSummary: text(row.offer_summary, `hotLeads[${index}].offerSummary`, true),
  });
}

function mapTotals(value: unknown): { asOf: string; totals: GrowthEvidenceTotalsRead } {
  const row = record(value, 'evidenceTotals');
  return Object.freeze({
    asOf: timestamp(row.snapshot_at, 'evidenceTotals.asOf')!,
    totals: Object.freeze({
      contentStarted: integer(row.content_started, 'evidenceTotals.contentStarted'),
      contentCompleted: integer(row.content_completed, 'evidenceTotals.contentCompleted'),
      offersShown: integer(row.offers_shown, 'evidenceTotals.offersShown'),
      replies: integer(row.replies, 'evidenceTotals.replies'),
      appointments: integer(row.appointments, 'evidenceTotals.appointments'),
    }),
  });
}

async function queryRows(transaction: SqlExecutor, sql: string, values?: readonly unknown[]): Promise<readonly Record<string, unknown>[]> {
  const result = await transaction.query(sql, values);
  return result.rows;
}

export class GrowthIntelligenceReadService {
  constructor(private readonly dependencies: GrowthIntelligenceReadDependencies) {}

  async load(context: DatabaseRequestContext): Promise<GrowthIntelligenceReadSnapshot> {
    validateDatabaseContext(context);
    if (context.actorKind !== 'user' || !context.userId) {
      throw new GrowthIntelligenceReadDataError('Growth intelligence requires an authenticated user context');
    }
    return this.dependencies.transactionRunner.run(context, async (transaction) => {
      const funnelRows = await queryRows(transaction, FUNNEL_SQL, [JOURNEY_SLUGS]);
      const hotLeadRows = await queryRows(transaction, HOT_LEADS_SQL, [JOURNEY_SLUGS]);
      const totalsRows = await queryRows(transaction, TOTALS_SQL);
      if (totalsRows.length !== 1) throw new GrowthIntelligenceReadDataError('Growth totals must return exactly one row');
      const mappedTotals = mapTotals(totalsRows[0]);
      const funnels = Object.freeze(funnelRows.map(mapFunnel));
      const hotLeads = Object.freeze(hotLeadRows.map(mapLead));
      if (new Set(hotLeads.map((lead) => lead.contactId)).size !== hotLeads.length) {
        throw new GrowthIntelligenceReadDataError('Growth hot leads must contain each contact at most once');
      }
      return Object.freeze({
        asOf: mappedTotals.asOf,
        windowLabel: 'Last 30 days',
        funnels,
        hotLeads,
        evidenceTotals: mappedTotals.totals,
      });
    });
  }
}

export function createPgGrowthIntelligenceReadService(pool: Pick<Pool, 'connect'>): GrowthIntelligenceReadService {
  return new GrowthIntelligenceReadService({ transactionRunner: createPgCrmReadTransactionRunner(pool) });
}
