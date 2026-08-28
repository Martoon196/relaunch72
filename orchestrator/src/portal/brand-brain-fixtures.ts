import type {
  BrandBrainReviewSummary,
  BrandBrainSnapshot,
  BrandBrainSourceSummary,
  BrandBrainSpecialistSummary,
} from '../brand-brain-pg/types.js';
import type {
  PortalBrandBrainExternalProfile,
  PortalBrandBrainSnapshot,
} from './brand-brain-service.js';
import {
  PROPERTY_PREDATOR_MARKETING_PACK,
  PROPERTY_PREDATOR_MARKETING_SOURCE_BYTE_LENGTH,
  PROPERTY_PREDATOR_MARKETING_SOURCE_FILE_COUNT,
  PROPERTY_PREDATOR_MARKETING_SOURCE_INVENTORY_SHA256,
} from '../company-content-adapter/property-predator-marketing-pack-registry.js';

const RUNTIME_BRAND_SHA256 = 'b8e342f5473dd1be7dbaf0bcd80269a38b2bf15c8e4634aa66ea4f5e21c9c60e';

function source(
  sourceId: string,
  assetRole: string,
  digest: string,
  consumerUse = 'runtime-authority-reference',
): BrandBrainSourceSummary {
  return Object.freeze({
    sourceId,
    assetRole,
    authorityStatus: 'source_canonical',
    contentSha256: digest,
    ownershipStatus: 'founder_owned',
    licenceStatus: 'confirmed_internal_use',
    privacyClass: 'company_confidential',
    consumerUse,
  });
}

function specialist(input: Readonly<{
  profileId: string;
  name: string;
  capabilities: readonly string[];
}>): BrandBrainSpecialistSummary {
  return Object.freeze({
    profileId: input.profileId,
    name: input.name,
    capabilities: Object.freeze([...input.capabilities]),
    runtimeBrandSha256: RUNTIME_BRAND_SHA256,
    sourceStatus: 'source_inventory_verified',
    hqActivationStatus: 'awaiting_governance_and_evaluation',
    runtimeReady: false,
    blockedReason: 'Brand review, evaluation and visual-policy resolution are incomplete.',
  });
}

const SOURCES: readonly BrandBrainSourceSummary[] = Object.freeze([
  source('propertypredator.brand.voice/v1', 'brand_voice', '10e76f10da9f6c27f12dfbc4da4bb09d1900d16fc1c747a77840e67658bf65a3'),
  source('propertypredator.brand.policy/v1', 'brand_policy', '21ac8545fed7f24433ea7f0f52952f1c57ff750b4e926a2ecc8d12c14429c2d9'),
  source('propertypredator.customer.avatars/v1', 'customer_avatars', '320e0923f2fc9ca2ea12191d53c23077807de207f55c5a732167332dc867635a'),
  source('propertypredator.offers.catalogue/v1', 'offer_catalogue', '43cf120bc7225ec75d7f2e8a55a9f42e033703512a3fb25f19d1f78d710ce50f'),
  source('propertypredator.content.examples/v1', 'approved_examples', '54d6128c9d32e987f49b02a723ff438e0dafb5631f679fa2b982f43741e4305e'),
  source('propertypredator.visual.panther-rule/v1', 'visual_policy', '65fcbd8c8bf8f0f06b03f7af6332151f11e45933206d59b403fb9b8692599c74', 'quarantine-only'),
  source('propertypredator.visual.no-animal-rule/v1', 'visual_policy', '769ce704433fed05995957215d15ca6d8f08a9cfb8c37f2bb0c5c2ef01efb42e', 'quarantine-only'),
]);

const SPECIALISTS: readonly BrandBrainSpecialistSummary[] = Object.freeze([
  specialist({
    profileId: 'propertypredator.owned.social/v1',
    name: 'Source Social Media Manager',
    capabilities: ['social planning', 'channel copy', 'engagement prompts'],
  }),
  specialist({
    profileId: 'propertypredator.owned.content/v1',
    name: 'Source Content Marketer',
    capabilities: ['long-form content', 'campaign themes', 'content repurposing'],
  }),
  specialist({
    profileId: 'propertypredator.owned.image/v1',
    name: 'Source Image Maker',
    capabilities: ['art direction', 'image briefs', 'format variants'],
  }),
  specialist({
    profileId: 'propertypredator.owned.email/v1',
    name: 'Source Email Marketer',
    capabilities: ['email sequences', 'subject lines', 'follow-up drafts'],
  }),
  specialist({
    profileId: 'propertypredator.owned.video/v1',
    name: 'Source Video Scriptwriter',
    capabilities: ['video scripts', 'hooks', 'shot briefs'],
  }),
  specialist({
    profileId: 'propertypredator.owned.ad/v1',
    name: 'Source Ad Copywriter',
    capabilities: ['ad concepts', 'campaign copy', 'creative variants'],
  }),
]);

const REVIEWS: readonly BrandBrainReviewSummary[] = Object.freeze([
  Object.freeze({
    dimension: 'ownership_licence',
    decision: 'approved',
    decisionId: 'b3000000-0000-4000-8000-000000000001',
  }),
  Object.freeze({
    dimension: 'privacy_security',
    decision: 'approved',
    decisionId: 'b3000000-0000-4000-8000-000000000002',
  }),
]);

const EXTERNAL_PROFILES: readonly PortalBrandBrainExternalProfile[] = Object.freeze([
  Object.freeze({
    profileId: 'founder-gpt.content-marketer',
    name: 'Content Marketer',
    purpose: 'Founder-trained Property Predator content and customer-avatar specialist.',
    status: 'awaiting_founder_export',
    callable: false,
  }),
  Object.freeze({
    profileId: 'founder-gpt.image-maker',
    name: 'Image Maker',
    purpose: 'Founder-trained visual concepts, art direction and image recipes.',
    status: 'awaiting_founder_export',
    callable: false,
  }),
  Object.freeze({
    profileId: 'founder-gpt.social-media-manager',
    name: 'Social Media Manager',
    purpose: 'Founder-trained channel planning, social copy and engagement workflows.',
    status: 'awaiting_founder_export',
    callable: false,
  }),
]);

/**
 * Synthetic, metadata-only Growth HQ preview. It contains no prompts, source
 * paths, knowledge bytes, storage keys, credentials or customer records.
 */
export function createPropertyPredatorBrandBrainFixture(): PortalBrandBrainSnapshot {
  const brain: BrandBrainSnapshot = Object.freeze({
    sourceReleaseId: 'b1000000-0000-4000-8000-000000000001',
    manifestSha256: '87af0778a10534854628281387190bb5221112fe1c306df0ab83cb6ad5ee9759',
    runtimeBrandSha256: RUNTIME_BRAND_SHA256,
    sourceSystem: 'property-predator',
    sources: SOURCES,
    specialists: SPECIALISTS,
    artworkCount: 18,
    quarantineCount: 1,
    visualPolicyConflict: true,
    sourceFresh: true,
    evaluationPassed: false,
    reviews: REVIEWS,
    activated: false,
    providerEffects: false,
    recordedAt: '2026-08-27T09:45:00.000Z',
  });
  return Object.freeze({
    workspace: Object.freeze({
      workspaceId: 'b2000000-0000-4000-8000-000000000001',
      workspaceName: 'Property Predator Growth HQ',
      snapshotAt: '2026-08-27T09:45:00.000Z',
      canManage: true,
    }),
    brain,
    externalProfiles: EXTERNAL_PROFILES,
    adaptedMethodPacks: Object.freeze([
      Object.freeze({
        pack: PROPERTY_PREDATOR_MARKETING_PACK,
        sourceInventorySha256: PROPERTY_PREDATOR_MARKETING_SOURCE_INVENTORY_SHA256,
        sourceFileCount: PROPERTY_PREDATOR_MARKETING_SOURCE_FILE_COUNT,
        sourceByteLength: PROPERTY_PREDATOR_MARKETING_SOURCE_BYTE_LENGTH,
      }),
    ]),
    dataset: 'illustrative_fixture',
  });
}
