import { createHash } from 'node:crypto';
import type { Pool, QueryResultRow } from 'pg';
import type { SqlExecutor } from '../crm-pg/types.js';
import { requestDatabaseContext, type DatabaseRequestContext } from '../db/rls.js';
import { InactivePortalSessionError, withTransaction } from '../db/transaction.js';
import {
  createPgPortalCrmPrincipalResolver,
  type PortalCrmPrincipal,
  type PortalCrmPrincipalResolver,
} from './crm-pg-service.js';
import type {
  CampaignMachineApprovalState,
  CampaignMachineLapsStage,
  CampaignMachineLapsTrack,
  CampaignMachineSnapshot,
  CampaignMachineStepKind,
  CampaignMachineStepSnapshot,
  CampaignMachineTemplateSnapshot,
} from './campaign-machine-presenter.js';
import type {
  PortalCampaignMachineFailure,
  PortalCampaignMachineService,
  PortalCampaignMachineSnapshotOutcome,
} from './campaign-machine-service.js';
import type { PortalCrmRequestIdentity } from './crm-service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256 = /^[a-f0-9]{64}$/u;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const STAGES = new Set<string>(['lead', 'activated', 'priced', 'sale', 'appointment', 'presentation']);
const TRACKS = new Set<string>(['self_serve', 'agency']);
const STEP_KINDS = new Set<string>(['email', 'operator_task']);
const APPROVAL_STATES = new Set<string>(['review_required', 'approved', 'rejected']);

interface CampaignMachineRow extends QueryResultRow {
  readonly workspaceName: unknown;
  readonly snapshotAt: unknown;
  readonly templateId: unknown;
  readonly templateKey: unknown;
  readonly templateName: unknown;
  readonly templateDescription: unknown;
  readonly versionId: unknown;
  readonly versionNumber: unknown;
  readonly definitionSha256: unknown;
  readonly brandBrainReleaseId: unknown;
  readonly brandBrainManifestSha256: unknown;
  readonly canonicalBrandVersion: unknown;
  readonly specialistChain: unknown;
  readonly lapsTrack: unknown;
  readonly journeySlug: unknown;
  readonly entryStage: unknown;
  readonly targetStage: unknown;
  readonly activationWindowId: unknown;
  readonly audienceVersionId: unknown;
  readonly offerVersionId: unknown;
  readonly versionCreatedAt: unknown;
  readonly recipeId: unknown;
  readonly recipeVersionId: unknown;
  readonly recipeSha256: unknown;
  readonly entryEventKey: unknown;
  readonly stopEventKeys: unknown;
  readonly idempotencyScope: unknown;
  readonly reportingIdentityId: unknown;
  readonly reportingVersionSha256: unknown;
  readonly reportingKey: unknown;
  readonly attributionNamespace: unknown;
  readonly metricSchemaSha256: unknown;
  readonly approvalRequestId: unknown;
  readonly approvalDecisionId: unknown;
  readonly approvalVersionSha256: unknown;
  readonly approvalState: unknown;
  readonly approvalDecidedAt: unknown;
  readonly stepId: unknown;
  readonly stepPosition: unknown;
  readonly stepKey: unknown;
  readonly stepKind: unknown;
  readonly delayMinutes: unknown;
  readonly triggerEventKey: unknown;
  readonly stepTargetStage: unknown;
  readonly ownedSpecialistId: unknown;
  readonly subject: unknown;
  readonly previewText: unknown;
  readonly body: unknown;
  readonly ctaLabel: unknown;
  readonly contentSha256: unknown;
  readonly requiresHumanApproval: unknown;
  readonly requiresCurrentPermission: unknown;
}

const ROW_FIELDS = Object.freeze([
  'workspaceName', 'snapshotAt', 'templateId', 'templateKey', 'templateName',
  'templateDescription', 'versionId', 'versionNumber', 'definitionSha256',
  'brandBrainReleaseId', 'brandBrainManifestSha256', 'canonicalBrandVersion',
  'specialistChain', 'lapsTrack', 'journeySlug', 'entryStage', 'targetStage',
  'activationWindowId', 'audienceVersionId', 'offerVersionId', 'versionCreatedAt',
  'recipeId', 'recipeVersionId', 'recipeSha256', 'entryEventKey', 'stopEventKeys',
  'idempotencyScope', 'reportingIdentityId', 'reportingVersionSha256', 'reportingKey',
  'attributionNamespace', 'metricSchemaSha256', 'approvalRequestId',
  'approvalDecisionId', 'approvalVersionSha256', 'approvalState', 'approvalDecidedAt',
  'stepId', 'stepPosition', 'stepKey', 'stepKind', 'delayMinutes', 'triggerEventKey',
  'stepTargetStage', 'ownedSpecialistId', 'subject', 'previewText', 'body', 'ctaLabel',
  'contentSha256', 'requiresHumanApproval', 'requiresCurrentPermission',
] as const);

const STEP_ROW_FIELDS = new Set<string>([
  'stepId', 'stepPosition', 'stepKey', 'stepKind', 'delayMinutes', 'triggerEventKey',
  'stepTargetStage', 'ownedSpecialistId', 'subject', 'previewText', 'body', 'ctaLabel',
  'contentSha256', 'requiresHumanApproval', 'requiresCurrentPermission',
]);

export const CAMPAIGN_MACHINE_SNAPSHOT_SQL = `/* portal.campaign-machine.snapshot */
  WITH selected_workspace AS (
    SELECT workspace.id, workspace.name, statement_timestamp() AS snapshot_at
    FROM app.workspaces AS workspace
    WHERE workspace.id = $1::uuid
  )
  SELECT selected.name AS "workspaceName",
         selected.snapshot_at AS "snapshotAt",
         campaign.template_id::text AS "templateId",
         campaign.template_key AS "templateKey",
         campaign.template_name AS "templateName",
         campaign.template_description AS "templateDescription",
         campaign.version_id::text AS "versionId",
         campaign.version_number::text AS "versionNumber",
         campaign.definition_sha256 AS "definitionSha256",
         campaign.brand_brain_release_id::text AS "brandBrainReleaseId",
         campaign.brand_brain_manifest_sha256 AS "brandBrainManifestSha256",
         campaign.canonical_brand_version AS "canonicalBrandVersion",
         campaign.specialist_chain AS "specialistChain",
         campaign.laps_track AS "lapsTrack",
         campaign.journey_slug AS "journeySlug",
         campaign.entry_stage AS "entryStage",
         campaign.target_stage AS "targetStage",
         campaign.activation_window_id::text AS "activationWindowId",
         campaign.audience_version_ref AS "audienceVersionId",
         campaign.offer_version_ref AS "offerVersionId",
         campaign.version_created_at AS "versionCreatedAt",
         recipe.recipe_id::text AS "recipeId",
         recipe.id::text AS "recipeVersionId",
         encode(recipe.recipe_sha256, 'hex') AS "recipeSha256",
         recipe.entry_event_key AS "entryEventKey",
         recipe.stop_event_keys AS "stopEventKeys",
         recipe.idempotency_scope AS "idempotencyScope",
         reporting.id::text AS "reportingIdentityId",
         encode(reporting.template_version_sha256, 'hex') AS "reportingVersionSha256",
         reporting.reporting_key::text AS "reportingKey",
         reporting.attribution_namespace AS "attributionNamespace",
         encode(reporting.metric_schema_sha256, 'hex') AS "metricSchemaSha256",
         approval.request_id::text AS "approvalRequestId",
         approval.decision_id::text AS "approvalDecisionId",
         approval.template_version_sha256 AS "approvalVersionSha256",
         approval.approval_state AS "approvalState",
         approval.decided_at AS "approvalDecidedAt",
         step.id::text AS "stepId",
         step.position::text AS "stepPosition",
         step.step_key::text AS "stepKey",
         step.step_kind AS "stepKind",
         step.delay_minutes::text AS "delayMinutes",
         step.trigger_event_key AS "triggerEventKey",
         CASE step.target_semantic
           WHEN 'activation' THEN 'activated' WHEN 'offer' THEN 'priced'
           ELSE step.target_semantic
         END AS "stepTargetStage",
         step.owned_specialist_id AS "ownedSpecialistId",
         step.subject_template AS "subject",
         step.preview_template AS "previewText",
         step.body_template AS "body",
         step.cta_label AS "ctaLabel",
         encode(step.content_sha256, 'hex') AS "contentSha256",
         step.requires_human_approval AS "requiresHumanApproval",
         step.requires_current_permission AS "requiresCurrentPermission"
  FROM selected_workspace AS selected
  LEFT JOIN LATERAL (
    SELECT template.id AS template_id, template.template_key::text AS template_key,
           template.name AS template_name, template.description AS template_description,
           version.id AS version_id, version.version_no AS version_number,
           encode(version.definition_sha256, 'hex') AS definition_sha256,
           version.brand_brain_source_release_id AS brand_brain_release_id,
           encode(version.brand_brain_manifest_sha256, 'hex') AS brand_brain_manifest_sha256,
           version.canonical_brand_version, version.specialist_chain, version.laps_track,
           journey.slug::text AS journey_slug,
           CASE entry.semantic WHEN 'activation' THEN 'activated' WHEN 'offer' THEN 'priced'
             ELSE entry.semantic END AS entry_stage,
           CASE target.semantic WHEN 'activation' THEN 'activated' WHEN 'offer' THEN 'priced'
             ELSE target.semantic END AS target_stage,
           version.activation_window_id, version.audience_version_ref, version.offer_version_ref,
           version.created_at AS version_created_at
    FROM app.campaign_templates AS template
    JOIN LATERAL (
      SELECT candidate.* FROM app.campaign_template_versions AS candidate
      WHERE candidate.workspace_id = template.workspace_id
        AND candidate.template_id = template.id
      ORDER BY candidate.version_no DESC, candidate.id DESC LIMIT 1
    ) AS version ON true
    JOIN app.conversion_journey_versions AS journey_version
      ON journey_version.workspace_id = version.workspace_id
     AND journey_version.id = version.journey_version_id
    JOIN app.conversion_journeys AS journey
      ON journey.workspace_id = journey_version.workspace_id
     AND journey.id = journey_version.journey_id
    JOIN app.conversion_journey_milestones AS entry
      ON entry.workspace_id = version.workspace_id
     AND entry.journey_version_id = version.journey_version_id
     AND entry.id = version.entry_milestone_id
    JOIN app.conversion_journey_milestones AS target
      ON target.workspace_id = version.workspace_id
     AND target.journey_version_id = version.journey_version_id
     AND target.id = version.target_milestone_id
    WHERE template.workspace_id = selected.id
    ORDER BY template.template_key, template.id LIMIT 9
  ) AS campaign ON true
  LEFT JOIN LATERAL (
    SELECT candidate.*
    FROM app.campaign_automation_recipe_versions AS candidate
    WHERE candidate.workspace_id = selected.id
      AND candidate.template_version_id = campaign.version_id
    ORDER BY candidate.version_no DESC, candidate.id DESC LIMIT 1
  ) AS recipe ON true
  LEFT JOIN app.campaign_reporting_identities AS reporting
    ON reporting.workspace_id = selected.id
   AND reporting.template_version_id = campaign.version_id
  LEFT JOIN LATERAL (
    SELECT request.id AS request_id, decision.id AS decision_id,
           encode(request.template_version_sha256, 'hex') AS template_version_sha256,
           coalesce(decision.decision, 'review_required') AS approval_state,
           decision.decided_at
    FROM app.campaign_template_approval_requests AS request
    LEFT JOIN app.campaign_template_approval_decisions AS decision
      ON decision.workspace_id = request.workspace_id
     AND decision.approval_request_id = request.id
    WHERE request.workspace_id = selected.id
      AND request.template_version_id = campaign.version_id
    ORDER BY request.request_no DESC, request.id DESC LIMIT 1
  ) AS approval ON true
  LEFT JOIN LATERAL (
    SELECT candidate.*, milestone.semantic AS target_semantic
    FROM app.campaign_template_steps AS candidate
    JOIN app.conversion_journey_milestones AS milestone
      ON milestone.workspace_id = candidate.workspace_id
     AND milestone.journey_version_id = candidate.journey_version_id
     AND milestone.id = candidate.target_milestone_id
    WHERE candidate.workspace_id = selected.id
      AND candidate.template_version_id = campaign.version_id
    ORDER BY candidate.position, candidate.id LIMIT 13
  ) AS step ON true
  ORDER BY campaign.template_key, campaign.template_id, step.position, step.id`;

export interface PortalCampaignMachineTransactionRunner {
  run<T>(
    context: DatabaseRequestContext,
    operation: (transaction: SqlExecutor) => Promise<T>,
    options: Readonly<{ readOnly: true; serializable: true }>,
  ): Promise<T>;
}

export interface PgPortalCampaignMachineDependencies {
  readonly principalResolver: Pick<PortalCrmPrincipalResolver, 'resolve'>;
  readonly readRunner: PortalCampaignMachineTransactionRunner;
}

class InvalidCampaignMachineSnapshotError extends Error {}

function context(identity: PortalCrmRequestIdentity, principal: PortalCrmPrincipal): DatabaseRequestContext {
  return requestDatabaseContext({
    ...principal,
    requestId: identity.requestId,
    portalSessionTokenHash: createHash('sha256').update(identity.sessionToken).digest(),
  });
}

function exactShape(row: CampaignMachineRow): boolean {
  const actual = Object.keys(row).sort();
  const expected = [...ROW_FIELDS].sort();
  return actual.length === expected.length && actual.every((field, index) => field === expected[index]);
}

function text(value: unknown, max: number, nullable = false): string | null {
  if (nullable && value === null) return null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= max ? trimmed : null;
}

function uuid(value: unknown, nullable = false): string | null {
  if (nullable && value === null) return null;
  return typeof value === 'string' && UUID.test(value) ? value.toLowerCase() : null;
}

function hash(value: unknown): string | null {
  return typeof value === 'string' && SHA256.test(value) ? value : null;
}

function instant(value: unknown, nullable = false): string | null {
  if (nullable && value === null) return null;
  const canonical = value instanceof Date ? value.toISOString() : value;
  return typeof canonical === 'string' && ISO_INSTANT.test(canonical)
    && new Date(canonical).toISOString() === canonical ? canonical : null;
}

function integer(value: unknown, min: number, max: number): number | null {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : null;
}

function stringArray(value: unknown, maxItems: number): readonly string[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > maxItems) return null;
  const items: string[] = [];
  for (const item of value) {
    const parsed = text(item, 200);
    if (!parsed) return null;
    items.push(parsed);
  }
  return Object.freeze(items);
}

function enumValue<T extends string>(value: unknown, values: ReadonlySet<string>): T | null {
  return typeof value === 'string' && values.has(value) ? value as T : null;
}

function parseStep(row: CampaignMachineRow, versionId: string): CampaignMachineStepSnapshot {
  const stepId = uuid(row.stepId);
  const position = integer(row.stepPosition, 1, 64);
  const stepKey = text(row.stepKey, 63);
  const kind = enumValue<CampaignMachineStepKind>(row.stepKind, STEP_KINDS);
  const delayMinutes = integer(row.delayMinutes, 0, 525_600);
  const triggerEventKey = text(row.triggerEventKey, 150);
  const targetLapsStage = enumValue<CampaignMachineLapsStage>(row.stepTargetStage, STAGES);
  const ownedSpecialistId = text(row.ownedSpecialistId, 200);
  const subject = text(row.subject, 240, true);
  const previewText = text(row.previewText, 320, true);
  const body = text(row.body, 12_000);
  const ctaLabel = text(row.ctaLabel, 160, true);
  const contentSha256 = hash(row.contentSha256);
  if (!stepId || position === null || !stepKey || !kind || delayMinutes === null
      || !triggerEventKey || !targetLapsStage || !ownedSpecialistId || !body || !contentSha256
      || (row.subject !== null && subject === null) || (row.previewText !== null && previewText === null)
      || (row.ctaLabel !== null && ctaLabel === null)
      || typeof row.requiresHumanApproval !== 'boolean'
      || typeof row.requiresCurrentPermission !== 'boolean') {
    throw new InvalidCampaignMachineSnapshotError();
  }
  return Object.freeze({
    stepId, templateVersionId: versionId, position, stepKey, kind, delayMinutes,
    triggerEventKey, targetLapsStage, ownedSpecialistId, subject, previewText, body, ctaLabel,
    contentSha256, requiresHumanApproval: row.requiresHumanApproval,
    requiresCurrentPermission: row.requiresCurrentPermission, providerEffects: false,
  });
}

function parseSnapshot(rows: readonly CampaignMachineRow[]): CampaignMachineSnapshot {
  if (rows.length === 0 || rows.some((row) => !exactShape(row))) {
    throw new InvalidCampaignMachineSnapshotError();
  }
  const workspaceName = text(rows[0]!.workspaceName, 180);
  const asOf = instant(rows[0]!.snapshotAt);
  if (!workspaceName || !asOf || rows.some((row) => row.workspaceName !== rows[0]!.workspaceName
      || instant(row.snapshotAt) !== asOf)) throw new InvalidCampaignMachineSnapshotError();
  if (rows[0]!.templateId === null) {
    if (rows.length !== 1 || rows.some((row) => row.stepId !== null)) {
      throw new InvalidCampaignMachineSnapshotError();
    }
    return Object.freeze({ workspaceName, asOf, templates: Object.freeze([]) });
  }

  const groups = new Map<string, CampaignMachineRow[]>();
  for (const row of rows) {
    const templateId = uuid(row.templateId);
    if (!templateId) throw new InvalidCampaignMachineSnapshotError();
    groups.set(templateId, [...(groups.get(templateId) ?? []), row]);
  }
  const templates: CampaignMachineTemplateSnapshot[] = [];
  for (const [templateId, grouped] of groups) {
    const row = grouped[0]!;
    for (const candidate of grouped.slice(1)) {
      for (const field of ROW_FIELDS) {
        if (STEP_ROW_FIELDS.has(field)) continue;
        const firstValue = row[field];
        const candidateValue = candidate[field];
        const firstCanonical = firstValue instanceof Date ? firstValue.toISOString() : JSON.stringify(firstValue);
        const candidateCanonical = candidateValue instanceof Date
          ? candidateValue.toISOString() : JSON.stringify(candidateValue);
        if (firstCanonical !== candidateCanonical) throw new InvalidCampaignMachineSnapshotError();
      }
    }
    const templateKey = text(row.templateKey, 63);
    const name = text(row.templateName, 180);
    const description = text(row.templateDescription, 1200);
    const versionId = uuid(row.versionId);
    const versionNumber = integer(row.versionNumber, 1, 1_000_000);
    const definitionSha256 = hash(row.definitionSha256);
    const brandBrainReleaseId = uuid(row.brandBrainReleaseId);
    const brandBrainManifestSha256 = hash(row.brandBrainManifestSha256);
    const canonicalBrandVersion = text(row.canonicalBrandVersion, 160);
    const specialistChain = stringArray(row.specialistChain, 8);
    const lapsTrack = enumValue<CampaignMachineLapsTrack>(row.lapsTrack, TRACKS);
    const journeySlug = text(row.journeySlug, 63);
    const entryStage = enumValue<CampaignMachineLapsStage>(row.entryStage, STAGES);
    const targetStage = enumValue<CampaignMachineLapsStage>(row.targetStage, STAGES);
    const activationWindowId = uuid(row.activationWindowId, true);
    const audienceVersionId = text(row.audienceVersionId, 300, true);
    const offerVersionId = text(row.offerVersionId, 300, true);
    const createdAt = instant(row.versionCreatedAt);
    const recipeId = uuid(row.recipeId);
    const recipeVersionId = uuid(row.recipeVersionId);
    const recipeSha256 = hash(row.recipeSha256);
    const entryEventKey = text(row.entryEventKey, 150);
    const stopEventKeys = stringArray(row.stopEventKeys, 24);
    const idempotencyScope = text(row.idempotencyScope, 200);
    const reportingIdentityId = uuid(row.reportingIdentityId);
    const reportingVersionSha256 = hash(row.reportingVersionSha256);
    const reportingKey = text(row.reportingKey, 150);
    const attributionNamespace = text(row.attributionNamespace, 150);
    const metricSchemaSha256 = hash(row.metricSchemaSha256);
    const approvalRequestId = uuid(row.approvalRequestId, true);
    const approvalDecisionId = uuid(row.approvalDecisionId, true);
    const approvalVersionSha256 = hash(row.approvalVersionSha256);
    const approvalState = enumValue<CampaignMachineApprovalState>(row.approvalState, APPROVAL_STATES);
    const approvalDecidedAt = instant(row.approvalDecidedAt, true);
    if (!templateKey || !name || !description || !versionId || versionNumber === null
        || !definitionSha256 || !brandBrainReleaseId || !brandBrainManifestSha256
        || !canonicalBrandVersion || !specialistChain || !lapsTrack || !journeySlug
        || !entryStage || !targetStage || (row.activationWindowId !== null && !activationWindowId)
        || (row.audienceVersionId !== null && !audienceVersionId)
        || (row.offerVersionId !== null && !offerVersionId) || !createdAt
        || !recipeId || !recipeVersionId || !recipeSha256 || !entryEventKey || !stopEventKeys
        || !idempotencyScope || !reportingIdentityId || !reportingVersionSha256
        || !reportingKey || !attributionNamespace || !metricSchemaSha256
        || !approvalState || (row.approvalRequestId !== null && !approvalRequestId)
        || (row.approvalDecisionId !== null && !approvalDecisionId)
        || (row.approvalVersionSha256 !== null && !approvalVersionSha256)
        || (row.approvalDecidedAt !== null && !approvalDecidedAt)
        || reportingVersionSha256 !== definitionSha256
        || (approvalRequestId !== null && approvalVersionSha256 !== definitionSha256)
        || (approvalDecisionId !== null && approvalRequestId === null)
        || (approvalState === 'review_required' && approvalDecisionId !== null)
        || (approvalState !== 'review_required' && (!approvalDecisionId || !approvalDecidedAt))) {
      throw new InvalidCampaignMachineSnapshotError();
    }
    const steps = Object.freeze(grouped.filter((candidate) => candidate.stepId !== null)
      .map((candidate) => parseStep(candidate, versionId)));
    templates.push(Object.freeze({
      templateId, templateKey, name, description,
      audienceLabel: audienceVersionId ? `Audience ${audienceVersionId}` : 'Audience not bound',
      environment: 'prepared',
      version: Object.freeze({
        versionId, versionNumber, definitionSha256, immutable: true, createdAt,
        brandBrainReleaseId, brandBrainManifestSha256, canonicalBrandVersion,
        specialistChain, lapsTrack, journeySlug, entryStage, targetStage,
        activationWindowId, audienceVersionId, offerVersionId, providerEffects: false,
      }),
      recipe: Object.freeze({
        recipeId, recipeVersionId, templateVersionId: versionId, recipeSha256,
        entryEventKey, stopEventKeys, idempotencyScope, providerEffects: false,
      }),
      steps,
      approval: Object.freeze({
        requestId: approvalRequestId, decisionId: approvalDecisionId,
        templateVersionId: versionId,
        templateVersionSha256: approvalVersionSha256 ?? definitionSha256,
        state: approvalState,
        reviewerLabel: approvalDecisionId ? 'Workspace reviewer' : null,
        decidedAt: approvalDecidedAt,
      }),
      reporting: Object.freeze({
        reportingIdentityId, templateVersionId: versionId,
        templateVersionSha256: reportingVersionSha256, reportingKey,
        attributionNamespace, metricSchemaSha256,
      }),
      blockers: Object.freeze([]),
    }));
  }
  return Object.freeze({ workspaceName, asOf, templates: Object.freeze(templates) });
}

function failure(kind: PortalCampaignMachineFailure['kind'], message: string): PortalCampaignMachineFailure {
  return Object.freeze({ ok: false, kind, message });
}

function readFailure(error: unknown): PortalCampaignMachineFailure {
  if (error instanceof InactivePortalSessionError) {
    return failure('unauthenticated', 'This portal session is no longer active.');
  }
  if (error instanceof InvalidCampaignMachineSnapshotError) {
    return failure('invalid_snapshot', 'Campaign evidence did not pass its safe typed boundary.');
  }
  const code = error && typeof error === 'object' && 'code' in error
    ? (error as { code?: unknown }).code : null;
  return code === '42501'
    ? failure('forbidden', 'This workspace role cannot read Campaign Machine evidence.')
    : failure('unavailable', 'Campaign Machine evidence is temporarily unavailable.');
}

export class PgPortalCampaignMachineService implements PortalCampaignMachineService {
  constructor(private readonly dependencies: PgPortalCampaignMachineDependencies) {}

  async snapshot(identity: PortalCrmRequestIdentity): Promise<PortalCampaignMachineSnapshotOutcome> {
    try {
      const principal = await this.dependencies.principalResolver.resolve(identity.sessionToken);
      if (!principal) return failure('unauthenticated', 'This portal session is no longer active.');
      const databaseContext = context(identity, principal);
      const snapshot = await this.dependencies.readRunner.run(databaseContext, async (transaction) => {
        const result = await transaction.query<CampaignMachineRow>(
          CAMPAIGN_MACHINE_SNAPSHOT_SQL, [databaseContext.workspaceId],
        );
        return parseSnapshot(result.rows);
      }, { readOnly: true, serializable: true });
      return Object.freeze({ ok: true as const, snapshot });
    } catch (error) {
      return readFailure(error);
    }
  }
}

export function createPgPortalCampaignMachineService(input: Readonly<{ webPool: Pool }>): PgPortalCampaignMachineService {
  return new PgPortalCampaignMachineService({
    principalResolver: createPgPortalCrmPrincipalResolver(input.webPool),
    readRunner: {
      run: (databaseContext, operation) => withTransaction(
        input.webPool, databaseContext,
        async (client) => operation({
          async query<TRow extends Record<string, unknown> = Record<string, unknown>>(
            sql: string, values: readonly unknown[] = [],
          ) {
            const result = await client.query<TRow>(sql, [...values]);
            return { rows: result.rows, rowCount: result.rowCount };
          },
        }),
        { readOnly: true, isolation: 'serializable' },
      ),
    },
  });
}
