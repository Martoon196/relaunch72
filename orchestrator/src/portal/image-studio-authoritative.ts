import {
  PROPERTY_PREDATOR_IMAGE_RULES_SHA256,
  PROPERTY_PREDATOR_OPENAI_IMAGE_CREDENTIAL_BOUNDARY,
} from '../company-content-adapter/property-predator-openai-image.js';
import { PROPERTY_PREDATOR_OPENAI_IMAGE_MODEL } from '../company-content-adapter/property-predator-openai-image-runtime.js';
import type { PortalBrandBrainSnapshot } from './brand-brain-service.js';
import type { PortalCompanyAssetsSnapshot } from './company-assets-service.js';
import type { ImageStudioSnapshot } from './image-studio-presenter.js';

const DEFAULT_BRIEF = Object.freeze({
  subject: 'Aerial UK property evidence grid at blue hour',
  forensicConcept: 'Planning, ownership, comparable and risk evidence converging on one opportunity',
  composition: 'Premium dark editorial background with one cyan evidence path and generous clean space for real artwork overlays',
  intendedUse: 'social-background' as const,
  altText: 'Dark aerial view of UK terraced property with cyan evidence paths highlighting one opportunity.',
  size: '1024x1024' as const,
  quality: 'medium' as const,
  maximumCostMinor: 50,
});

const SENSITIVE = /(?:\b(?:api[_ -]?key|password|secret|bearer|token)\b\s*[:=]|\bsk-[A-Za-z0-9_-]{12,}|https?:\/\/|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|\+?\d[\d ()-]{8,}\d)/iu;

function clean(value: string | null, fallback: string, maximum: number): string {
  if (!value) return fallback;
  const candidate = value.trim().replace(/[\u0000-\u001f\u007f]/gu, ' ')
    .replace(/\s+/gu, ' ');
  if (!candidate || SENSITIVE.test(candidate)) return fallback;
  return [...candidate].slice(0, maximum).join('');
}

function label(value: string): string {
  const result = value.replace(/^[^:]+:/u, '').replace(/[._:-]+/gu, ' ')
    .replace(/\s+/gu, ' ').trim();
  return result ? result.replace(/^./u, (character) => character.toLocaleUpperCase('en-GB')) : 'Company artwork';
}

function clearForUse(decisions: PortalCompanyAssetsSnapshot['itemPage']['items'][number]['decisions']): boolean {
  return decisions.length > 0 && decisions.every((decision) => decision.outcome === 'clear');
}

function sameWorkspace(
  brandBrain: PortalBrandBrainSnapshot,
  companyAssets: PortalCompanyAssetsSnapshot,
): boolean {
  return brandBrain.workspace.workspaceId === companyAssets.workspace.workspaceId
    && brandBrain.workspace.workspaceName === companyAssets.workspace.workspaceName;
}

/**
 * Build the production Image Studio read model from authoritative, already
 * workspace-scoped metadata. This is deliberately not a provider command: the
 * isolated image worker remains the only future holder of an OpenAI key.
 */
export function createAuthoritativeImageStudioSnapshot(input: Readonly<{
  brandBrain: PortalBrandBrainSnapshot;
  companyAssets: PortalCompanyAssetsSnapshot;
  query?: URLSearchParams;
}>): ImageStudioSnapshot {
  const { brandBrain, companyAssets } = input;
  if (!sameWorkspace(brandBrain, companyAssets)
      || brandBrain.dataset !== 'postgres_authoritative'
      || companyAssets.dataset !== 'postgres_authoritative'
      || brandBrain.brain.providerEffects !== false
      || companyAssets.providerEffects !== false) {
    throw new Error('Image Studio authoritative sources did not match');
  }

  const query = input.query ?? new URLSearchParams();
  const intendedUse = ['article-hero', 'social-background', 'campaign-concept', 'diagram-background']
    .includes(query.get('intended_use') ?? '')
    ? query.get('intended_use') as ImageStudioSnapshot['brief']['intendedUse']
    : DEFAULT_BRIEF.intendedUse;
  const size = ['1024x1024', '1536x1024', '1024x1536'].includes(query.get('size') ?? '')
    ? query.get('size') as ImageStudioSnapshot['brief']['size']
    : DEFAULT_BRIEF.size;
  const quality = ['low', 'medium', 'high'].includes(query.get('quality') ?? '')
    ? query.get('quality') as ImageStudioSnapshot['brief']['quality']
    : DEFAULT_BRIEF.quality;

  const references = companyAssets.itemPage.items
    .filter((item) => item.itemType === 'asset' && item.blobSha256 !== null)
    .slice(0, 12)
    .map((item) => Object.freeze({
      assetId: item.itemId,
      label: label(item.itemId),
      kind: /(?:logo|icon|mark)/iu.test(item.itemId) ? 'logo' as const : 'approved-artwork' as const,
      versionId: item.versionId,
      sha256: item.blobSha256!,
      approved: clearForUse(item.decisions),
    }));

  return Object.freeze({
    workspaceName: companyAssets.workspace.workspaceName,
    capturedAt: companyAssets.workspace.snapshotAt,
    dataset: 'postgres_authoritative',
    usageEvidence: 'worker_not_connected',
    currentImageMakerHref: 'https://propertypredator.com/admin.html#ai-image-maker',
    model: PROPERTY_PREDATOR_OPENAI_IMAGE_MODEL,
    credentialBoundary: PROPERTY_PREDATOR_OPENAI_IMAGE_CREDENTIAL_BOUNDARY,
    effects: Object.freeze({
      generationEnabled: false,
      providerEffectsEnabled: false,
      emergencyPaused: true,
      commandBoundaryAvailable: false,
    }),
    usage: Object.freeze({
      dayUsed: 0,
      dayLimit: 20,
      concurrentUsed: 0,
      concurrentLimit: 3,
      monthSpendMinor: 0,
      monthSpendLimitMinor: 1_500,
      currency: 'USD',
    }),
    brand: Object.freeze({
      profileLabel: 'Property Predator authoritative Brand Brain',
      profileSha256: brandBrain.brain.runtimeBrandSha256,
      rulesSha256: PROPERTY_PREDATOR_IMAGE_RULES_SHA256,
      realLogoRequired: true,
      forbidden: Object.freeze([
        'generated text', 'generated logos', 'people or faces', 'animals or mascots',
        'fake product UI', 'income claims', 'purple, gold or orange glow',
      ]),
    }),
    brief: Object.freeze({
      subject: clean(query.get('subject'), DEFAULT_BRIEF.subject, 180),
      forensicConcept: clean(query.get('forensic_concept'), DEFAULT_BRIEF.forensicConcept, 500),
      composition: clean(query.get('composition'), DEFAULT_BRIEF.composition, 700),
      intendedUse,
      altText: clean(query.get('alt_text'), DEFAULT_BRIEF.altText, 400),
      size,
      quality,
      maximumCostMinor: DEFAULT_BRIEF.maximumCostMinor,
    }),
    references: Object.freeze(references),
    proposals: Object.freeze([]),
  });
}
