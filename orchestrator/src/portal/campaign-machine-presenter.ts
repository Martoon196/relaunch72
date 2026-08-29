import { createHash } from 'node:crypto';

export const CAMPAIGN_MACHINE_ROUTE = '/portal/campaigns/sequences' as const;
export const CAMPAIGN_MACHINE_MAX_TEMPLATES = 8;
export const CAMPAIGN_MACHINE_MAX_STEPS = 12;

export type CampaignMachineLapsTrack = 'self_serve' | 'agency';
export type CampaignMachineLapsStage = 'lead' | 'activated' | 'priced' | 'sale'
  | 'appointment' | 'presentation';
export type CampaignMachineStepKind = 'email' | 'operator_task';
export type CampaignMachineApprovalState = 'review_required' | 'approved' | 'rejected';

export interface CampaignMachineStepSnapshot {
  readonly stepId: string;
  readonly templateVersionId: string;
  readonly position: number;
  readonly stepKey: string;
  readonly kind: CampaignMachineStepKind;
  readonly delayMinutes: number;
  readonly triggerEventKey: string;
  readonly targetLapsStage: CampaignMachineLapsStage;
  readonly ownedSpecialistId: string;
  readonly subject: string | null;
  readonly previewText: string | null;
  readonly body: string;
  readonly ctaLabel: string | null;
  readonly contentSha256: string;
  readonly requiresHumanApproval: boolean;
  readonly requiresCurrentPermission: boolean;
  readonly providerEffects: false;
}

export interface CampaignMachineRecipeSnapshot {
  readonly recipeId: string;
  readonly recipeVersionId: string;
  readonly templateVersionId: string;
  readonly recipeSha256: string;
  readonly entryEventKey: string;
  readonly stopEventKeys: readonly string[];
  readonly idempotencyScope: string;
  readonly providerEffects: false;
}

export interface CampaignMachineApprovalSnapshot {
  readonly requestId: string | null;
  readonly decisionId: string | null;
  readonly templateVersionId: string;
  readonly templateVersionSha256: string;
  readonly state: CampaignMachineApprovalState;
  readonly reviewerLabel: string | null;
  readonly decidedAt: string | null;
}

export interface CampaignMachineReportingSnapshot {
  readonly reportingIdentityId: string;
  readonly templateVersionId: string;
  readonly templateVersionSha256: string;
  readonly reportingKey: string;
  readonly attributionNamespace: string;
  readonly metricSchemaSha256: string;
}

export interface CampaignMachineTemplateSnapshot {
  readonly templateId: string;
  readonly templateKey: string;
  readonly name: string;
  readonly description: string;
  readonly audienceLabel: string;
  readonly environment: 'prepared';
  readonly version: Readonly<{
    versionId: string;
    versionNumber: number;
    definitionSha256: string;
    immutable: true;
    createdAt: string;
    brandBrainReleaseId: string;
    brandBrainManifestSha256: string;
    canonicalBrandVersion: string;
    specialistChain: readonly string[];
    lapsTrack: CampaignMachineLapsTrack;
    journeySlug: string;
    entryStage: CampaignMachineLapsStage;
    targetStage: CampaignMachineLapsStage;
    activationWindowId: string | null;
    audienceVersionId: string | null;
    offerVersionId: string | null;
    providerEffects: false;
  }>;
  readonly recipe: CampaignMachineRecipeSnapshot;
  readonly steps: readonly CampaignMachineStepSnapshot[];
  readonly approval: CampaignMachineApprovalSnapshot;
  readonly reporting: CampaignMachineReportingSnapshot;
  readonly blockers: readonly string[];
}

export interface CampaignMachineSnapshot {
  readonly workspaceName: string;
  readonly asOf: string;
  readonly templates: readonly CampaignMachineTemplateSnapshot[];
}

export interface CampaignMachineStepView extends CampaignMachineStepSnapshot {
  readonly indexLabel: string;
  readonly kindLabel: string;
  readonly delayLabel: string;
  readonly targetLabel: string;
  readonly specialistLabel: string;
  readonly exactContent: boolean;
}

export interface CampaignMachineTemplateView {
  readonly templateId: string;
  readonly templateKey: string;
  readonly name: string;
  readonly description: string;
  readonly audienceLabel: string;
  readonly versionId: string;
  readonly versionNumber: number;
  readonly shortHash: string;
  readonly brandBrainShortHash: string;
  readonly canonicalBrandVersion: string;
  readonly specialistChain: readonly string[];
  readonly lapsTrackLabel: string;
  readonly journeySlug: string;
  readonly entryStageLabel: string;
  readonly targetStageLabel: string;
  readonly steps: readonly CampaignMachineStepView[];
  readonly recipe: CampaignMachineRecipeSnapshot & Readonly<{
    shortHash: string;
    exactBinding: boolean;
  }>;
  readonly approval: CampaignMachineApprovalSnapshot & Readonly<{
    label: string;
    exactBinding: boolean;
  }>;
  readonly reporting: CampaignMachineReportingSnapshot & Readonly<{
    shortHash: string;
    exactBinding: boolean;
  }>;
  readonly blockers: readonly string[];
  readonly preparedForReview: boolean;
  readonly activationReady: false;
  readonly stateLabel: 'PREPARED FOR REVIEW' | 'LOCKED';
}

export interface CampaignMachineView {
  readonly workspaceName: string;
  readonly asOf: string;
  readonly templates: readonly CampaignMachineTemplateView[];
  readonly metrics: Readonly<{
    templateCount: number;
    versionCount: number;
    stepCount: number;
    emailStepCount: number;
    operatorTaskCount: number;
    preparedCount: number;
    approvedCount: number;
  }>;
  readonly inputTruncated: boolean;
  readonly providerEffects: 'none';
}

const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_KEY = /^[a-z][a-z0-9._-]{0,149}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

const STAGE_LABELS: Readonly<Record<CampaignMachineLapsStage, string>> = Object.freeze({
  lead: 'Lead', activated: 'Activated', priced: 'Priced', sale: 'Sale',
  appointment: 'Appointment', presentation: 'Presentation',
});

const SPECIALIST_LABELS: Readonly<Record<string, string>> = Object.freeze({
  'founder-gpt.offer-architect': 'Offer Architect',
  'founder-gpt.direct-response-copywriter': 'Direct Response Copywriter',
  'propertypredator.owned.email/v1': 'Email Specialist',
  'propertypredator.growth-hq.operator/v1': 'Growth HQ operator',
});

function bounded(value: string, max: number): string {
  return [...String(value)].slice(0, max).join('');
}

function validInstant(value: string | null): boolean {
  if (value === null) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed);
}

function delayLabel(minutes: number): string {
  if (!Number.isInteger(minutes) || minutes < 0) return 'Invalid delay';
  if (minutes === 0) return 'Immediately';
  if (minutes < 60) return `${minutes} minutes later`;
  if (minutes % 1_440 === 0) {
    const days = minutes / 1_440;
    return `${days} day${days === 1 ? '' : 's'} later`;
  }
  const hours = Math.round((minutes / 60) * 10) / 10;
  return `${hours.toLocaleString('en-GB')} hours later`;
}

export function campaignMachineStepContentSha256(
  step: Pick<CampaignMachineStepSnapshot, 'subject' | 'previewText' | 'body' | 'ctaLabel'>,
): string {
  return createHash('sha256').update([
    step.subject ?? '', step.previewText ?? '', step.body, step.ctaLabel ?? '',
  ].join('\u001f'), 'utf8').digest('hex');
}

function templateView(template: CampaignMachineTemplateSnapshot): CampaignMachineTemplateView {
  const version = template.version;
  const versionExact = UUID.test(template.templateId)
    && UUID.test(version.versionId)
    && Number.isInteger(version.versionNumber)
    && version.versionNumber > 0
    && SHA256.test(version.definitionSha256)
    && SHA256.test(version.brandBrainManifestSha256)
    && version.immutable
    && version.providerEffects === false
    && template.environment === 'prepared';
  const boundedSteps = template.steps.slice(0, CAMPAIGN_MACHINE_MAX_STEPS);
  const positions = new Set<number>();
  const keys = new Set<string>();
  const steps = Object.freeze(boundedSteps.map((step, index): CampaignMachineStepView => {
    const exactContent = step.templateVersionId === version.versionId
      && UUID.test(step.stepId)
      && Number.isInteger(step.position)
      && step.position === index + 1
      && !positions.has(step.position)
      && SAFE_KEY.test(step.stepKey)
      && !keys.has(step.stepKey)
      && Number.isInteger(step.delayMinutes)
      && step.delayMinutes >= 0
      && SAFE_KEY.test(step.triggerEventKey)
      && step.providerEffects === false
      && SHA256.test(step.contentSha256)
      && step.contentSha256 === campaignMachineStepContentSha256(step)
      && (step.kind === 'email' ? Boolean(step.subject?.trim()) : step.subject === null);
    positions.add(step.position);
    keys.add(step.stepKey);
    return Object.freeze({
      ...step,
      subject: step.subject === null ? null : bounded(step.subject, 180),
      previewText: step.previewText === null ? null : bounded(step.previewText, 240),
      body: bounded(step.body, 4_000),
      ctaLabel: step.ctaLabel === null ? null : bounded(step.ctaLabel, 120),
      indexLabel: String(index + 1).padStart(2, '0'),
      kindLabel: step.kind === 'email' ? 'Email' : 'Admin task',
      delayLabel: delayLabel(step.delayMinutes),
      targetLabel: STAGE_LABELS[step.targetLapsStage],
      specialistLabel: SPECIALIST_LABELS[step.ownedSpecialistId] ?? 'Unrecognised specialist',
      exactContent,
    });
  }));
  const recipeExact = UUID.test(template.recipe.recipeId)
    && UUID.test(template.recipe.recipeVersionId)
    && template.recipe.templateVersionId === version.versionId
    && SHA256.test(template.recipe.recipeSha256)
    && SAFE_KEY.test(template.recipe.entryEventKey)
    && template.recipe.stopEventKeys.length > 0
    && template.recipe.stopEventKeys.every((key) => SAFE_KEY.test(key))
    && template.recipe.providerEffects === false;
  const approvalExact = template.approval.templateVersionId === version.versionId
    && template.approval.templateVersionSha256 === version.definitionSha256
    && (template.approval.requestId === null || UUID.test(template.approval.requestId))
    && (template.approval.decisionId === null || UUID.test(template.approval.decisionId))
    && (template.approval.state === 'review_required'
      ? template.approval.requestId !== null && template.approval.decisionId === null
      : template.approval.requestId !== null && template.approval.decisionId !== null
        && Boolean(template.approval.reviewerLabel?.trim())
        && validInstant(template.approval.decidedAt));
  const reportingExact = UUID.test(template.reporting.reportingIdentityId)
    && template.reporting.templateVersionId === version.versionId
    && template.reporting.templateVersionSha256 === version.definitionSha256
    && SAFE_KEY.test(template.reporting.reportingKey)
    && SAFE_KEY.test(template.reporting.attributionNamespace)
    && SHA256.test(template.reporting.metricSchemaSha256);
  const computedBlockers: string[] = [];
  if (!versionExact) computedBlockers.push('The immutable template version or Brand Brain binding is invalid.');
  if (template.steps.length === 0 || template.steps.length > CAMPAIGN_MACHINE_MAX_STEPS
      || steps.some((step) => !step.exactContent)) {
    computedBlockers.push('One or more sequence steps does not match the exact immutable version.');
  }
  if (!recipeExact) computedBlockers.push('The automation recipe is missing an exact entry, stop or idempotency binding.');
  if (!approvalExact) computedBlockers.push('The review state does not bind to this exact template version.');
  if (!reportingExact) computedBlockers.push('The reporting identity does not bind to this exact template version.');
  if (version.activationWindowId === null && version.targetStage === 'activated') {
    computedBlockers.push('Select the current activation-window configuration before activation reporting.');
  }
  if (version.audienceVersionId === null) computedBlockers.push('Bind an approved audience version before any real recipient selection.');
  if (version.offerVersionId === null) computedBlockers.push('Bind an approved offer/message version before live use.');
  const blockers = Object.freeze([...new Set([
    ...template.blockers.map((item) => bounded(item, 300)), ...computedBlockers,
  ])]);
  const preparedForReview = versionExact && steps.length > 0
    && steps.every((step) => step.exactContent) && recipeExact && approvalExact
    && reportingExact && template.approval.state !== 'rejected';
  return Object.freeze({
    templateId: template.templateId,
    templateKey: bounded(template.templateKey, 150),
    name: bounded(template.name, 180),
    description: bounded(template.description, 600),
    audienceLabel: bounded(template.audienceLabel, 220),
    versionId: version.versionId,
    versionNumber: version.versionNumber,
    shortHash: version.definitionSha256.slice(0, 12),
    brandBrainShortHash: version.brandBrainManifestSha256.slice(0, 12),
    canonicalBrandVersion: bounded(version.canonicalBrandVersion, 120),
    specialistChain: Object.freeze(version.specialistChain.map((item) => (
      SPECIALIST_LABELS[item] ?? 'Unrecognised specialist'
    ))),
    lapsTrackLabel: version.lapsTrack === 'self_serve' ? 'Self-serve LAPS' : 'Agency LAPS',
    journeySlug: bounded(version.journeySlug, 100),
    entryStageLabel: STAGE_LABELS[version.entryStage],
    targetStageLabel: STAGE_LABELS[version.targetStage],
    steps,
    recipe: Object.freeze({ ...template.recipe, shortHash: template.recipe.recipeSha256.slice(0, 12), exactBinding: recipeExact }),
    approval: Object.freeze({
      ...template.approval,
      label: template.approval.state === 'approved' ? 'Exact version approved'
        : template.approval.state === 'rejected' ? 'Rejected' : 'Review required',
      exactBinding: approvalExact,
    }),
    reporting: Object.freeze({ ...template.reporting, shortHash: template.reporting.metricSchemaSha256.slice(0, 12), exactBinding: reportingExact }),
    blockers,
    preparedForReview,
    activationReady: false,
    stateLabel: preparedForReview ? 'PREPARED FOR REVIEW' : 'LOCKED',
  });
}

export function presentCampaignMachine(snapshot: CampaignMachineSnapshot): CampaignMachineView {
  const inputTruncated = snapshot.templates.length > CAMPAIGN_MACHINE_MAX_TEMPLATES;
  const templates = Object.freeze(snapshot.templates.slice(0, CAMPAIGN_MACHINE_MAX_TEMPLATES).map(templateView));
  const steps = templates.flatMap((template) => template.steps);
  return Object.freeze({
    workspaceName: bounded(snapshot.workspaceName, 180),
    asOf: validInstant(snapshot.asOf) ? snapshot.asOf : 'invalid',
    templates,
    metrics: Object.freeze({
      templateCount: templates.length,
      versionCount: templates.length,
      stepCount: steps.length,
      emailStepCount: steps.filter((step) => step.kind === 'email').length,
      operatorTaskCount: steps.filter((step) => step.kind === 'operator_task').length,
      preparedCount: templates.filter((template) => template.preparedForReview).length,
      approvedCount: templates.filter((template) => template.approval.state === 'approved').length,
    }),
    inputTruncated,
    providerEffects: 'none',
  });
}
