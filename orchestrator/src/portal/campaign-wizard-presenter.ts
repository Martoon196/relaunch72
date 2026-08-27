import type { SocialNetwork } from '../providers/contracts.js';

export const CAMPAIGN_WIZARD_MAX_CONTENT_OPTIONS = 40;
export const CAMPAIGN_WIZARD_MAX_TARGET_OPTIONS = 40;

export interface CampaignWizardContentSnapshot {
  readonly contentItemId: string;
  readonly contentVersionId: string;
  readonly contentSha256: string;
  readonly title: string;
  readonly versionNumber: number;
  readonly kindLabel: string;
  readonly approvalStatus: 'approved' | 'pending' | 'rejected' | 'changes_requested' | 'unavailable';
  readonly sourceFresh: boolean;
  readonly publishable: boolean;
}

export interface CampaignWizardTargetSnapshot {
  readonly targetId: string;
  readonly network: SocialNetwork;
  readonly targetLabel: string;
  readonly planningEnabled: boolean;
  readonly environment: 'test';
  readonly providerEffects: 'none';
}

export interface CampaignWizardSnapshot {
  /** Approved social-post copy candidates. */
  readonly content: readonly CampaignWizardContentSnapshot[];
  /** Optional approved artwork/media versions, selected independently from copy. */
  readonly media?: readonly CampaignWizardContentSnapshot[];
  readonly targets: readonly CampaignWizardTargetSnapshot[];
  readonly sourceTruncated: boolean;
}

export interface CampaignWizardContentOptionView extends CampaignWizardContentSnapshot {
  readonly shortHash: string;
  readonly eligible: boolean;
  readonly gateLabel: string;
}

export interface CampaignWizardTargetOptionView extends CampaignWizardTargetSnapshot {
  readonly networkLabel: string;
  readonly eligible: boolean;
  readonly gateLabel: string;
}

export interface CampaignWizardChannelGroupView {
  readonly network: SocialNetwork;
  readonly label: string;
  readonly targets: readonly CampaignWizardTargetOptionView[];
}

export interface CampaignWizardView {
  readonly workspaceName: string;
  readonly timezone: string;
  readonly asOf: string;
  readonly content: readonly CampaignWizardContentOptionView[];
  readonly media: readonly CampaignWizardContentOptionView[];
  readonly channelGroups: readonly CampaignWizardChannelGroupView[];
  readonly eligibleContentCount: number;
  readonly eligibleMediaCount: number;
  readonly eligibleTargetCount: number;
  readonly inputTruncated: boolean;
  readonly environment: 'test';
  readonly providerEffects: 'none';
}

export interface PresentCampaignWizardOptions {
  readonly workspaceName: string;
  readonly timezone: string;
  readonly asOf: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const CONTROL_OR_BIDI = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;
const NETWORK_ORDER: readonly SocialNetwork[] = Object.freeze([
  'linkedin', 'instagram', 'facebook', 'tiktok', 'x', 'youtube',
  'google_business_profile', 'threads', 'pinterest',
]);
const NETWORK_LABELS: Readonly<Record<SocialNetwork, string>> = Object.freeze({
  linkedin: 'LinkedIn',
  instagram: 'Instagram',
  facebook: 'Facebook',
  tiktok: 'TikTok',
  x: 'X',
  youtube: 'YouTube',
  google_business_profile: 'Google Business Profile',
  threads: 'Threads',
  pinterest: 'Pinterest',
});

function label(value: string, fallback: string, maxLength = 160): string {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return !trimmed || trimmed.length > maxLength || CONTROL_OR_BIDI.test(trimmed)
    ? fallback
    : trimmed;
}

function safeTimezone(value: string): string {
  if (typeof value !== 'string' || value.length > 80 || CONTROL_OR_BIDI.test(value)) return 'UTC';
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: value }).format(new Date(0));
    return value;
  } catch {
    return 'UTC';
  }
}

function contentOption(item: CampaignWizardContentSnapshot): CampaignWizardContentOptionView | null {
  if (!UUID.test(item.contentItemId) || !UUID.test(item.contentVersionId) || !SHA256.test(item.contentSha256)) {
    return null;
  }
  const exactApproval = item.approvalStatus === 'approved';
  const eligible = exactApproval && item.sourceFresh === true && item.publishable === true;
  const gateLabel = !exactApproval
    ? 'Exact approval required'
    : !item.sourceFresh
      ? 'Source proof needs revalidation'
      : !item.publishable
        ? 'Publishability gate locked'
        : 'Eligible for a TEST planning intent';
  return Object.freeze({
    ...item,
    title: label(item.title, 'Untitled company content'),
    kindLabel: label(item.kindLabel, 'Content', 60),
    versionNumber: Number.isSafeInteger(item.versionNumber) && item.versionNumber > 0
      ? item.versionNumber
      : 1,
    shortHash: item.contentSha256.slice(0, 12),
    eligible,
    gateLabel,
  });
}

function targetOption(target: CampaignWizardTargetSnapshot): CampaignWizardTargetOptionView | null {
  if (!UUID.test(target.targetId) || !NETWORK_ORDER.includes(target.network)) return null;
  const exactBoundary = target.environment === 'test' && target.providerEffects === 'none';
  const eligible = exactBoundary && target.planningEnabled === true;
  return Object.freeze({
    ...target,
    targetLabel: label(target.targetLabel, `${NETWORK_LABELS[target.network]} TEST target`, 120),
    networkLabel: NETWORK_LABELS[target.network],
    eligible,
    gateLabel: !exactBoundary
      ? 'Target boundary locked'
      : eligible
        ? 'Available for TEST planning'
        : 'Planning disabled',
  });
}

export function presentCampaignWizard(
  snapshot: CampaignWizardSnapshot,
  options: PresentCampaignWizardOptions,
): CampaignWizardView {
  const boundedContent = snapshot.content
    .slice(0, CAMPAIGN_WIZARD_MAX_CONTENT_OPTIONS)
    .map(contentOption)
    .filter((item): item is CampaignWizardContentOptionView => item !== null);
  const mediaInput = snapshot.media ?? [];
  const boundedMedia = mediaInput
    .slice(0, CAMPAIGN_WIZARD_MAX_CONTENT_OPTIONS)
    .map(contentOption)
    .filter((item): item is CampaignWizardContentOptionView => item !== null);
  const boundedTargets = snapshot.targets
    .slice(0, CAMPAIGN_WIZARD_MAX_TARGET_OPTIONS)
    .map(targetOption)
    .filter((item): item is CampaignWizardTargetOptionView => item !== null);
  const channelGroups = NETWORK_ORDER
    .map((network) => Object.freeze({
      network,
      label: NETWORK_LABELS[network],
      targets: Object.freeze(boundedTargets.filter((target) => target.network === network)),
    }))
    .filter((group) => group.targets.length > 0);

  return Object.freeze({
    workspaceName: label(options.workspaceName, 'Growth HQ workspace', 120),
    timezone: safeTimezone(options.timezone),
    asOf: options.asOf,
    content: Object.freeze(boundedContent),
    media: Object.freeze(boundedMedia),
    channelGroups: Object.freeze(channelGroups),
    eligibleContentCount: boundedContent.filter((item) => item.eligible).length,
    eligibleMediaCount: boundedMedia.filter((item) => item.eligible).length,
    eligibleTargetCount: boundedTargets.filter((target) => target.eligible).length,
    inputTruncated: snapshot.sourceTruncated
      || snapshot.content.length > CAMPAIGN_WIZARD_MAX_CONTENT_OPTIONS
      || mediaInput.length > CAMPAIGN_WIZARD_MAX_CONTENT_OPTIONS
      || snapshot.targets.length > CAMPAIGN_WIZARD_MAX_TARGET_OPTIONS,
    environment: 'test',
    providerEffects: 'none',
  });
}
