import type { ImageStudioSnapshot } from './image-studio-presenter.js';

const PROFILE_SHA = 'd77b0306d110075571dedd716d012c8752a302eb39ea9198e71ecd43cc089abc';
const RULES_SHA = '3'.repeat(64);

/** Fictional, dark rehearsal data. No provider, credential or real customer is represented. */
export function createPropertyPredatorImageStudioFixture(): ImageStudioSnapshot {
  return Object.freeze({
    workspaceName: 'Property Predator Growth HQ',
    capturedAt: '2026-08-28T14:20:00.000Z',
    model: 'gpt-image-2',
    credentialBoundary: 'property-predator-openai-image-api/v1',
    effects: Object.freeze({
      generationEnabled: false,
      providerEffectsEnabled: false,
      emergencyPaused: true,
      commandBoundaryAvailable: false,
    }),
    usage: Object.freeze({
      dayUsed: 7,
      dayLimit: 20,
      concurrentUsed: 2,
      concurrentLimit: 3,
      monthSpendMinor: 421,
      monthSpendLimitMinor: 1_500,
      currency: 'USD',
    }),
    brand: Object.freeze({
      profileLabel: 'Property Predator official image brief editor',
      profileSha256: PROFILE_SHA,
      rulesSha256: RULES_SHA,
      realLogoRequired: true,
      forbidden: Object.freeze([
        'generated text', 'generated logos', 'people or faces', 'animals or mascots',
        'fake product UI', 'income claims', 'purple, gold or orange glow',
      ]),
    }),
    brief: Object.freeze({
      subject: 'Aerial UK property evidence grid at blue hour',
      forensicConcept: 'Planning, ownership, comparable and risk evidence converging on one opportunity',
      composition: 'Premium dark editorial background with one cyan evidence path and generous clean space for real artwork overlays',
      intendedUse: 'social-background',
      altText: 'Dark aerial view of UK terraced property with cyan evidence paths highlighting one opportunity.',
      size: '1024x1024',
      quality: 'medium',
      maximumCostMinor: 12,
    }),
    references: Object.freeze([
      Object.freeze({
        assetId: 'brand-app-icon',
        label: 'Official app icon · overlay after generation',
        kind: 'logo',
        versionId: 'a7200000-0000-4000-8000-000000000001',
        sha256: '5eba03fb26c53cd4f77b7f061bba69f5c594cafcba3ce19b5900d099fafef5ca',
        approved: true,
      }),
      Object.freeze({
        assetId: 'brand-og-banner',
        label: 'Approved dark editorial composition reference',
        kind: 'approved-artwork',
        versionId: 'a7200000-0000-4000-8000-000000000002',
        sha256: 'cfee1be67a1d52bbffb91ccc739d6c7d0da8af6ac0290af39891b1741666ee4e',
        approved: true,
      }),
    ]),
    proposals: Object.freeze([
      Object.freeze({
        proposalId: 'proposal-image-evidence-grid-v3',
        label: 'Evidence grid · social square',
        state: 'brand-review',
        operation: 'generate',
        shortHash: '65c7df2db661',
        costMinor: 9,
        createdAt: '2026-08-28T13:52:00.000Z',
      }),
      Object.freeze({
        proposalId: 'proposal-image-auction-brief-v2',
        label: 'Auction evidence · landscape edit',
        state: 'changes-requested',
        operation: 'edit',
        shortHash: '214b82371f4a',
        costMinor: 11,
        createdAt: '2026-08-28T12:06:00.000Z',
      }),
    ]),
  });
}
