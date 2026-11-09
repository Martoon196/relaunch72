import assert from 'node:assert/strict';
import test from 'node:test';
import { PROPERTY_PREDATOR_CONVERSION_BLUEPRINTS } from '../src/conversion-pg/property-predator-blueprints.js';
import type {
  JourneyManagerPublicationState,
  JourneyManagerReadSnapshot,
} from '../src/conversion-pg/journey-manager.js';
import {
  JOURNEY_MANAGER_CONFIRMATION,
  JOURNEY_MANAGER_INSTALL_ROUTE,
  journeyManagerNoticeFromQuery,
  journeyManagerNoticeToken,
  presentJourneyManager,
} from '../src/portal/journey-manager-presenter.js';

function snapshot(publication: JourneyManagerPublicationState = 'published'): JourneyManagerReadSnapshot {
  const [selfServe, agency] = PROPERTY_PREDATOR_CONVERSION_BLUEPRINTS;
  const runtimeReady = publication === 'published';
  return Object.freeze({
    snapshotAt: '2026-08-25T20:45:00.000Z',
    canManage: true,
    foundationState: runtimeReady ? 'ready' : publication === 'missing' ? 'not_installed' : 'action_required',
    runtimeReady,
    routes: Object.freeze([selfServe!, agency!].map((route) => Object.freeze({
      slug: route.slug as 'property-predator-self-serve' | 'property-predator-agency-laps',
      name: route.name,
      description: route.description,
      version: route.version,
      definitionHash: route.definitionHash,
      publication,
      activeVersion: runtimeReady ? route.version : null,
      publishedAt: runtimeReady ? '2026-08-25T20:40:00.000Z' : null,
      runtimeReady,
      milestones: route.milestones,
      triggers: route.triggers,
    }))),
    scoreModel: Object.freeze({
      slug: selfServe!.scoreModel.slug,
      name: selfServe!.scoreModel.name,
      version: selfServe!.scoreModel.version,
      definitionHash: selfServe!.scoreModel.definitionHash,
      publication,
      activeVersion: runtimeReady ? selfServe!.scoreModel.version : null,
      publishedAt: runtimeReady ? '2026-08-25T20:40:00.000Z' : null,
      maxScore: 100,
      components: selfServe!.scoreModel.components,
      bands: selfServe!.scoreModel.bands,
      rules: selfServe!.scoreModel.rules,
    }),
    safety: Object.freeze({
      definitionsOnly: true,
      sendsMessages: false,
      publishesSocialPosts: false,
      triggersProviders: false,
    }),
  });
}

test('Journey Manager presenter maps the exact routes, scoring allocation and ready state', () => {
  const view = presentJourneyManager(snapshot(), 'Property Predator HQ', {
    csrfToken: 'csrf', commandKey: '11111111-1111-4111-8111-111111111111',
  });

  assert.equal(view.state, 'ready');
  assert.deepEqual(view.routes.map((route) => [route.slug, route.state]), [
    ['property-predator-self-serve', 'active'],
    ['property-predator-agency-laps', 'active'],
  ]);
  assert.deepEqual(view.scoring.components.map((component) => [component.key, component.allocatedPoints]), [
    ['fit', 0], ['engagement', 35], ['intent', 35],
  ]);
  assert.equal(view.routes[0]?.triggers[3]?.evidenceLabel, 'Collected payment');
  assert.equal(view.routes[1]?.enrollmentLabel, 'Appointment-led enrolment');
  assert.equal(view.setup.state, 'ready');
  assert.equal(view.setup.csrfToken, undefined);
});

test('missing definitions expose only the explicit manager setup boundary', () => {
  const view = presentJourneyManager(snapshot('missing'), 'Property Predator HQ', {
    csrfToken: 'csrf', commandKey: '11111111-1111-4111-8111-111111111111',
  });

  assert.equal(view.state, 'action_required');
  assert.equal(view.setup.state, 'available');
  assert.equal(view.setup.postAction, JOURNEY_MANAGER_INSTALL_ROUTE);
  assert.equal(view.setup.confirmationToken, JOURNEY_MANAGER_CONFIRMATION);
  assert.equal(view.setup.csrfToken, 'csrf');
  assert.ok(view.routes.every((route) => route.state === 'missing'));
});

test('definition conflicts fail visually closed instead of offering repair-by-overwrite', () => {
  const view = presentJourneyManager(snapshot('conflict'), 'Property Predator HQ', {
    csrfToken: 'csrf', commandKey: '11111111-1111-4111-8111-111111111111',
  });

  assert.equal(view.state, 'degraded');
  assert.equal(view.setup.state, 'blocked');
  assert.equal(view.setup.csrfToken, undefined);
  assert.match(view.setup.blocker ?? '', /will not guess/);
  assert.ok(view.routes.every((route) => route.state === 'drifted'));
});

test('Journey Manager notices are signed to the current browser session', () => {
  const token = journeyManagerNoticeToken('secret', 'session-a', 'installed');
  const query = new URLSearchParams({ notice: token });
  assert.equal(journeyManagerNoticeFromQuery(query, 'secret', 'session-a')?.title, 'Journey foundation installed');
  assert.equal(journeyManagerNoticeFromQuery(query, 'secret', 'session-b'), undefined);
  assert.equal(journeyManagerNoticeFromQuery(new URLSearchParams({ notice: 'installed.forged' }), 'secret', 'session-a'), undefined);
});
