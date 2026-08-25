import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PROPERTY_PREDATOR_GROWTH_PROFILE,
  RELAUNCH72_PRODUCT_PROFILE,
  resolvePortalProductProfile,
} from '../src/portal/product-profile.js';

test('known portal product profiles resolve as immutable presentation contracts', () => {
  assert.equal(resolvePortalProductProfile(), RELAUNCH72_PRODUCT_PROFILE);
  assert.equal(resolvePortalProductProfile('property_predator_growth'), PROPERTY_PREDATOR_GROWTH_PROFILE);
  assert.equal(PROPERTY_PREDATOR_GROWTH_PROFILE.productName, 'PropertyPredator');
  assert.equal(PROPERTY_PREDATOR_GROWTH_PROFILE.theme.accent, '#00cdb8');
  assert.ok(Object.isFrozen(PROPERTY_PREDATOR_GROWTH_PROFILE));
  assert.ok(Object.isFrozen(PROPERTY_PREDATOR_GROWTH_PROFILE.theme));
  assert.ok(Object.isFrozen(PROPERTY_PREDATOR_GROWTH_PROFILE.journeyBlueprints));
  assert.ok(Object.isFrozen(PROPERTY_PREDATOR_GROWTH_PROFILE.journeyBlueprints[0]?.milestones));
});

test('product profiles fail closed and cannot carry authorization state', () => {
  assert.throws(() => resolvePortalProductProfile('unknown'), /unknown portal product profile/);
  assert.throws(() => resolvePortalProductProfile('toString'), /unknown portal product profile/);
  assert.equal('capabilities' in PROPERTY_PREDATOR_GROWTH_PROFILE, false);
  assert.equal('permissions' in PROPERTY_PREDATOR_GROWTH_PROFILE, false);
  assert.equal('providerConnections' in PROPERTY_PREDATOR_GROWTH_PROFILE, false);
  assert.deepEqual(PROPERTY_PREDATOR_GROWTH_PROFILE.visibleNavigation, ['overview', 'crm']);
});

test('Property Predator blueprint labels keep product-led and literal LAPS journeys distinct', () => {
  const [selfServe, agency] = PROPERTY_PREDATOR_GROWTH_PROFILE.journeyBlueprints;
  assert.deepEqual(selfServe?.milestones, ['Lead', 'Activated', 'Priced', 'Sale']);
  assert.deepEqual(agency?.milestones, ['Lead', 'Appointment', 'Presentation', 'Sale']);
  assert.notEqual(selfServe?.label, agency?.label);
});
