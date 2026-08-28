import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PROPERTY_PREDATOR_MARKETING_LAPS_OPTIONS,
  planPropertyPredatorMarketingDraft,
} from '../src/company-content-adapter/property-predator-marketing-draft-plan.js';
import { PROPERTY_PREDATOR_MARKETING_PACK } from '../src/company-content-adapter/property-predator-marketing-pack-registry.js';
import {
  PROPERTY_PREDATOR_AGENCY_LAPS_JOURNEY,
  PROPERTY_PREDATOR_SELF_SERVE_JOURNEY,
} from '../src/conversion-pg/property-predator-blueprints.js';
import { createPropertyPredatorBrandBrainFixture } from '../src/portal/brand-brain-fixtures.js';
import type { PortalBrandBrainSnapshot } from '../src/portal/brand-brain-service.js';

function mutable<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function readyBrandBrain(): PortalBrandBrainSnapshot {
  const fixture = mutable(createPropertyPredatorBrandBrainFixture());
  return {
    ...fixture,
    brain: {
      ...fixture.brain,
      evaluationPassed: true,
      activated: true,
      visualPolicyConflict: false,
      reviews: [
        ...fixture.brain.reviews,
        {
          dimension: 'brand_readiness',
          decision: 'approved',
          decisionId: 'b3000000-0000-4000-8000-000000000003',
        },
      ],
      specialists: fixture.brain.specialists.map((profile) => profile.profileId === 'propertypredator.owned.social/v1'
        ? {
            ...profile,
            capabilities: ['post', 'thread'],
            runtimeReady: true,
            blockedReason: null,
          }
        : profile),
    },
  };
}

test('marketing draft recipe derives every selection from canonical Property Predator journey definitions', () => {
  assert.equal(PROPERTY_PREDATOR_MARKETING_LAPS_OPTIONS.length, 8);
  const selfServe = PROPERTY_PREDATOR_MARKETING_LAPS_OPTIONS
    .filter((option) => option.journeySlug === PROPERTY_PREDATOR_SELF_SERVE_JOURNEY.slug);
  const agency = PROPERTY_PREDATOR_MARKETING_LAPS_OPTIONS
    .filter((option) => option.journeySlug === PROPERTY_PREDATOR_AGENCY_LAPS_JOURNEY.slug);
  assert.deepEqual(selfServe.map((option) => option.targetMilestoneKey),
    PROPERTY_PREDATOR_SELF_SERVE_JOURNEY.milestones.map((milestone) => milestone.key));
  assert.deepEqual(agency.map((option) => option.targetMilestoneKey),
    PROPERTY_PREDATOR_AGENCY_LAPS_JOURNEY.milestones.map((milestone) => milestone.key));
  assert.ok(selfServe.every((option) =>
    option.journeyDefinitionSha256 === PROPERTY_PREDATOR_SELF_SERVE_JOURNEY.definitionHash));
  assert.ok(agency.every((option) =>
    option.journeyDefinitionSha256 === PROPERTY_PREDATOR_AGENCY_LAPS_JOURNEY.definitionHash));
});

test('marketing draft recipe is deterministic, hash-bound and permanently effects-off', () => {
  const input = {
    selection: 'property-predator-agency-laps:presentation',
    brandBrainSnapshot: readyBrandBrain(),
  };
  const left = planPropertyPredatorMarketingDraft(input);
  const right = planPropertyPredatorMarketingDraft(input);
  assert.deepEqual(left, right);
  assert.match(left.planSha256, /^[0-9a-f]{64}$/);
  assert.equal(left.readiness, 'draft_recipe_ready');
  assert.equal(left.selection.previousMilestoneName, 'Appointment');
  assert.equal(left.selection.targetMilestoneName, 'Presentation');
  assert.equal(left.pack?.packageSha256, PROPERTY_PREDATOR_MARKETING_PACK.packageSha256);
  assert.equal(left.brandBrain?.specialistProfileId, 'propertypredator.owned.social/v1');
  assert.deepEqual(left.handoffs.map((handoff) => handoff.specialistLabel), [
    'Offer Architect',
    'Direct Response Copywriter',
    'Social Media Manager',
    'Image and Diagram Maker',
  ]);
  assert.equal(left.callable, false);
  assert.equal(left.persisted, false);
  assert.equal(left.providerEffects, false);
  assert.equal(Object.isFrozen(left), true);
  assert.equal(Object.isFrozen(left.methods), true);
  assert.equal(Object.isFrozen(left.handoffs), true);
});

test('marketing draft recipe fails closed on unknown scope, pack tampering and registration mismatch', () => {
  const tamperedPack = mutable(PROPERTY_PREDATOR_MARKETING_PACK) as unknown as Record<string, unknown>;
  tamperedPack.packageSha256 = '0'.repeat(64);
  const unknown = planPropertyPredatorMarketingDraft({
    selection: 'prop-invest:lead',
    marketingPack: tamperedPack,
    brandBrainSnapshot: readyBrandBrain(),
  });
  assert.equal(unknown.readiness, 'blocked');
  assert.ok(unknown.blockers.some((blocker) => blocker.code === 'selection_invalid'));
  assert.ok(unknown.blockers.some((blocker) => blocker.code === 'marketing_pack_invalid'));
  assert.equal(unknown.selection.key, 'property-predator-self-serve:activated');
  const missingPack = planPropertyPredatorMarketingDraft({
    marketingPack: null,
    brandBrainSnapshot: readyBrandBrain(),
  });
  assert.ok(missingPack.blockers.some((blocker) => blocker.code === 'marketing_pack_invalid'));

  const mismatchedRegistration = mutable(readyBrandBrain()) as unknown as Record<string, any>;
  mismatchedRegistration.adaptedMethodPacks[0].sourceInventorySha256 = 'f'.repeat(64);
  const registrationPlan = planPropertyPredatorMarketingDraft({
    brandBrainSnapshot: mismatchedRegistration,
  });
  assert.ok(registrationPlan.blockers.some((blocker) =>
    blocker.code === 'marketing_pack_registration_mismatch'));
});

test('marketing draft recipe treats invalid or unapproved Brand Brain metadata as visible blockers', () => {
  const fixturePlan = planPropertyPredatorMarketingDraft({
    brandBrainSnapshot: createPropertyPredatorBrandBrainFixture(),
  });
  assert.equal(fixturePlan.readiness, 'blocked');
  assert.ok(fixturePlan.blockers.some((blocker) => blocker.code === 'brand_brain_not_ready'));
  assert.ok(fixturePlan.blockers.some((blocker) => blocker.code === 'brand_brain_reviews_incomplete'));
  assert.ok(fixturePlan.blockers.some((blocker) => blocker.code === 'brand_brain_social_specialist_not_ready'));

  const badDigest = mutable(readyBrandBrain()) as unknown as Record<string, any>;
  badDigest.brain.runtimeBrandSha256 = 'not-a-digest';
  const invalid = planPropertyPredatorMarketingDraft({ brandBrainSnapshot: badDigest });
  assert.equal(invalid.brandBrain, null);
  assert.ok(invalid.blockers.some((blocker) => blocker.code === 'brand_brain_metadata_invalid'));
});

test('marketing draft recipe exposes provenance only, never private pack bodies or paths', () => {
  const encoded = JSON.stringify(planPropertyPredatorMarketingDraft({
    brandBrainSnapshot: readyBrandBrain(),
  }));
  assert.doesNotMatch(encoded, /SKILL\.md|references\/|\.zip|archiveHandling|promptBodyAccess|ownershipEvidence|sourceInventorySha256/);
  assert.doesNotMatch(encoded, /api[-_]?key|access[-_]?token|password|postgres(?:ql)?:\/\//i);
  assert.match(encoded, /propertypredator\.laps\/v1/);
  assert.match(encoded, /"callable":false/);
  assert.match(encoded, /"providerEffects":false/);
});
