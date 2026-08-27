import assert from 'node:assert/strict';
import test from 'node:test';
import { createPropertyPredatorProviderReadinessFixture } from '../src/portal/provider-readiness-cockpit-fixtures.js';
import { presentProviderReadinessCockpit } from '../src/portal/provider-readiness-cockpit-presenter.js';
import { renderProviderReadinessCockpitBody } from '../src/portal/provider-readiness-cockpit-view.js';

test('provider cockpit presents the exact four rails from sealed dark-readiness reports', () => {
  const view = presentProviderReadinessCockpit(createPropertyPredatorProviderReadinessFixture());
  assert.deepEqual(view.rails.map((rail) => rail.rail), [
    'mailgun_email',
    'whatsapp',
    'public_social',
    'social_dm',
  ]);
  assert.equal(view.illustrative, true);
  assert.equal(view.externalEffects, false);
  assert.equal(view.readyRailCount, 0);
  assert.equal(view.blockedRailCount, 4);
  assert.deepEqual(view.safety, {
    liveAuthorised: false,
    providerEffectsAllowed: false,
    providerOperationsCreated: 0,
    emergencyPaused: true,
  });
  for (const rail of view.rails) {
    assert.equal(rail.readiness, 'not_ready');
    assert.equal(rail.candidateOnly, true);
    assert.deepEqual(rail.stages.map((stage) => stage.stage), [
      'adapter_contract_verified',
      'provider_test_verified',
      'internal_seed_ready',
    ]);
    assert.ok(rail.blockers.some((blocker) => blocker.code === 'PROVIDER_METADATA_MISMATCH'));
    assert.deepEqual(rail.switches.map((item) => item.value), ['PAUSED', 'OFF', 'OFF', 'OFF', 'OFF']);
  }
  assert.equal(
    view.rails.find((rail) => rail.rail === 'public_social')?.evidence
      .find((item) => item.gate === 'commercialSaasRights')?.freshness,
    'stale',
  );
  assert.equal(
    view.rails.find((rail) => rail.rail === 'whatsapp')?.evidence
      .find((item) => item.gate === 'signedWebhook')?.freshness,
    'missing',
  );
});

test('provider cockpit renders branded, accessible, truthful dark controls', () => {
  const html = renderProviderReadinessCockpitBody(
    presentProviderReadinessCockpit(createPropertyPredatorProviderReadinessFixture()),
  );
  assert.match(html, /Ready the rails/);
  assert.match(html, /Keep them dark/);
  assert.match(html, /ILLUSTRATIVE TEST DATA/);
  assert.match(html, /EXTERNAL EFFECTS OFF/);
  assert.match(html, /Emergency pause engaged/);
  assert.match(html, /Mailgun email/);
  assert.match(html, /WhatsApp/);
  assert.match(html, /Public social/);
  assert.match(html, /Social DMs/);
  assert.match(html, /Why blocked/);
  assert.match(html, /Evidence freshness/);
  assert.match(html, /<details class="prc-evidence">/);
  assert.match(html, /<summary>/);
  assert.match(html, /aria-current="step"/);
  assert.doesNotMatch(html, /<form|<button|action=|Connect now|Activate now|Send now|Publish now/i);
  assert.doesNotMatch(html, /api[_ -]?key|access[_ -]?token|client[_ -]?secret|password/i);
});

test('provider cockpit escapes candidate labels and rejects any boundary escalation', () => {
  const hostile = structuredClone(createPropertyPredatorProviderReadinessFixture());
  (hostile.rails[0]! as { providerLabel: string }).providerLabel = '<img src=x onerror=alert(1)>';
  const html = renderProviderReadinessCockpitBody(presentProviderReadinessCockpit(hostile));
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /<img src=x/);

  const effectsOn = structuredClone(createPropertyPredatorProviderReadinessFixture());
  (effectsOn.rails[0]!.switches as { runtimeEffects: 'off' | 'on' }).runtimeEffects = 'on';
  assert.throws(() => presentProviderReadinessCockpit(effectsOn), /every effect switch off/);

  const falseFixtureReadiness = structuredClone(createPropertyPredatorProviderReadinessFixture());
  (falseFixtureReadiness.rails[0]!.report as { readiness: 'provider_test_verified' }).readiness = 'provider_test_verified';
  assert.throws(() => presentProviderReadinessCockpit(falseFixtureReadiness), /illustrative readiness/);

  const duplicated = structuredClone(createPropertyPredatorProviderReadinessFixture());
  (duplicated.rails[1]! as { rail: 'mailgun_email' }).rail = 'mailgun_email';
  assert.throws(() => presentProviderReadinessCockpit(duplicated), /rail set/);
});
