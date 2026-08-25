import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PROPERTY_PREDATOR_GROWTH_PROFILE,
  RELAUNCH72_PRODUCT_PROFILE,
  resolvePortalProductProfile,
} from '../src/portal/product-profile.js';
import {
  PROPERTY_PREDATOR_AGENCY_LAPS_JOURNEY,
  PROPERTY_PREDATOR_SELF_SERVE_JOURNEY,
} from '../src/conversion-pg/index.js';
import { loginPage } from '../src/portal/views.js';

test('known portal product profiles resolve as immutable presentation contracts', () => {
  assert.equal(resolvePortalProductProfile(), RELAUNCH72_PRODUCT_PROFILE);
  assert.equal(resolvePortalProductProfile('property_predator_growth'), PROPERTY_PREDATOR_GROWTH_PROFILE);
  assert.equal(PROPERTY_PREDATOR_GROWTH_PROFILE.productName, 'PropertyPredator');
  assert.equal(PROPERTY_PREDATOR_GROWTH_PROFILE.theme.accent, '#00e5cc');
  assert.equal(PROPERTY_PREDATOR_GROWTH_PROFILE.theme.canvas, '#050608');
  assert.equal(PROPERTY_PREDATOR_GROWTH_PROFILE.theme.ink, '#eef1f7');
  assert.ok(Object.isFrozen(PROPERTY_PREDATOR_GROWTH_PROFILE));
  assert.ok(Object.isFrozen(PROPERTY_PREDATOR_GROWTH_PROFILE.theme));
  assert.ok(Object.isFrozen(PROPERTY_PREDATOR_GROWTH_PROFILE.journeyBlueprints));
  assert.ok(Object.isFrozen(PROPERTY_PREDATOR_GROWTH_PROFILE.journeyBlueprints[0]?.milestones));
  assert.deepEqual(
    PROPERTY_PREDATOR_GROWTH_PROFILE.readinessRails.find((rail) => rail.id === 'journeys'),
    {
      id: 'journeys',
      label: 'Journey runtime',
      summary: 'Automatic enrolment, evidence-led advancement and explainable scores.',
      state: 'foundation',
    },
  );
  assert.deepEqual(
    PROPERTY_PREDATOR_GROWTH_PROFILE.readinessRails.find((rail) => rail.id === 'content'),
    {
      id: 'content',
      label: 'Affiliate Stash content machine',
      summary: 'Reuse its brand-trained generation, swipe library and artwork catalogue; Growth HQ will orchestrate reviewed items instead of rebuilding it.',
      state: 'foundation',
    },
  );
});

test('product profiles fail closed and cannot carry authorization state', () => {
  assert.throws(() => resolvePortalProductProfile('unknown'), /unknown portal product profile/);
  assert.throws(() => resolvePortalProductProfile('toString'), /unknown portal product profile/);
  assert.equal('capabilities' in PROPERTY_PREDATOR_GROWTH_PROFILE, false);
  assert.equal('permissions' in PROPERTY_PREDATOR_GROWTH_PROFILE, false);
  assert.equal('providerConnections' in PROPERTY_PREDATOR_GROWTH_PROFILE, false);
  assert.deepEqual(
    PROPERTY_PREDATOR_GROWTH_PROFILE.visibleNavigation,
    ['overview', 'crm', 'journeys', 'content', 'inbox'],
  );
});

test('Property Predator blueprint labels keep product-led and literal LAPS journeys distinct', () => {
  const [selfServe, agency] = PROPERTY_PREDATOR_GROWTH_PROFILE.journeyBlueprints;
  assert.equal(selfServe?.id, PROPERTY_PREDATOR_SELF_SERVE_JOURNEY.slug);
  assert.equal(agency?.id, PROPERTY_PREDATOR_AGENCY_LAPS_JOURNEY.slug);
  assert.deepEqual(
    selfServe?.milestones,
    PROPERTY_PREDATOR_SELF_SERVE_JOURNEY.milestones.map((milestone) => milestone.name),
  );
  assert.deepEqual(
    agency?.milestones,
    PROPERTY_PREDATOR_AGENCY_LAPS_JOURNEY.milestones.map((milestone) => milestone.name),
  );
  assert.notEqual(selfServe?.label, agency?.label);
});

test('Property Predator sign-in advertises only its visible workspace modules', () => {
  const html = loginPage(undefined, '', 'csrf', PROPERTY_PREDATOR_GROWTH_PROFILE);
  const genericHtml = loginPage(undefined, '', 'csrf', RELAUNCH72_PRODUCT_PROFILE);
  assert.match(html, /<span>Today<\/span>/);
  assert.match(html, /<span>Leads<\/span>/);
  assert.match(html, /<span>Journeys<\/span>/);
  assert.match(html, /<span>Content<\/span>/);
  assert.match(html, /<span class="planned">Inbox · preview<\/span>/);
  assert.match(html, /fonts\.googleapis\.com\/css2\?family=Cormorant\+Garamond/);
  assert.match(html, /family=Syne/);
  assert.match(html, /family=IBM\+Plex\+Mono/);
  assert.doesNotMatch(genericHtml, /fonts\.googleapis\.com/);
  assert.doesNotMatch(html, /Content drafts|Social · planned|WhatsApp · planned|Listening · planned/);
  assert.doesNotMatch(html, /makes sure the right conversation actually becomes a sale/);
});
