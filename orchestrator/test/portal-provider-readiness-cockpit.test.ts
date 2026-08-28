import assert from 'node:assert/strict';
import test from 'node:test';
import { createPropertyPredatorProviderReadinessFixture } from '../src/portal/provider-readiness-cockpit-fixtures.js';
import { presentProviderReadinessCockpit } from '../src/portal/provider-readiness-cockpit-presenter.js';
import { renderProviderReadinessCockpitBody } from '../src/portal/provider-readiness-cockpit-view.js';

test('provider cockpit presents the exact six rails from sealed dark-readiness reports', () => {
  const view = presentProviderReadinessCockpit(createPropertyPredatorProviderReadinessFixture());
  assert.deepEqual(view.rails.map((rail) => rail.rail), [
    'mailgun_email',
    'whatsapp',
    'public_social',
    'social_dm',
    'webinar',
    'social_listening',
  ]);
  assert.equal(view.illustrative, true);
  assert.equal(view.externalEffects, false);
  assert.equal(view.readyRailCount, 0);
  assert.equal(view.blockedRailCount, 6);
  assert.equal(view.simulatedRailCount, 2);
  assert.equal(view.realDarkRailCount, 0);
  assert.equal(view.notComposedRailCount, 4);
  assert.equal(view.totalQueuedCount, 10);
  assert.equal(view.totalRetryWaitCount, 2);
  assert.equal(view.totalReconciliationCount, 1);
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
    assert.equal(rail.telemetry.source, 'fictional_simulation');
    assert.equal(rail.telemetry.pauseLabel, 'ENGAGED');
    assert.equal(rail.telemetry.activeLeaseCount, 0);
    assert.ok(rail.telemetry.blockers.length > 0);
  }
  assert.deepEqual(view.rails.map((rail) => rail.telemetry.executionMode), [
    'simulation_only',
    'not_composed',
    'simulation_only',
    'not_composed',
    'not_composed',
    'not_composed',
  ]);
  assert.equal(
    view.rails.find((rail) => rail.rail === 'mailgun_email')?.telemetry.reconciliationRequiredCount,
    1,
  );
  assert.equal(
    view.rails.find((rail) => rail.rail === 'public_social')?.telemetry.retryWaitCount,
    2,
  );
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
  assert.match(html, /Webinars/);
  assert.match(html, /Social listening/);
  assert.match(html, /Why blocked/);
  assert.match(html, /SIMULATED · NO PROVIDER/);
  assert.match(html, /NOT COMPOSED · NO PROVIDER/);
  assert.match(html, /Fictional local telemetry/);
  assert.match(html, /Every displayed queue, retry and reconciliation item is fictional local evidence/);
  assert.match(html, /Fictional items waiting/);
  assert.match(html, /Emergency pause<\/span><b>ENGAGED/);
  assert.match(html, /Worker telemetry/);
  assert.match(html, /Active leases/);
  assert.match(html, /Retry wait/);
  assert.match(html, /Reconciliation/);
  assert.match(html, /Activation evidence/);
  assert.match(html, /Operational rail/);
  assert.match(html, /EMAIL_RECONCILIATION_REQUIRED/);
  assert.match(html, /WHATSAPP_PROVIDER_NOT_COMPOSED/);
  assert.match(html, /SOCIAL_RETRY_FIXTURE_ONLY/);
  assert.match(html, /DM_INBOX_PERMISSION_MISSING/);
  assert.match(html, /WEBINAR_HOST_NOT_COMPOSED/);
  assert.match(html, /LISTENING_FEED_NOT_COMPOSED/);
  assert.match(html, /Evidence freshness/);
  assert.match(html, /<details class="prc-evidence">/);
  assert.match(html, /<summary>/);
  assert.match(html, /aria-current="step"/);
  assert.doesNotMatch(html, /<form|<button|\saction=|Connect now|Activate now|Send now|Publish now/i);
  assert.doesNotMatch(html, /api[_ -]?key|access[_ -]?token|client[_ -]?secret|password/i);
});

test('provider cockpit labels observed real-dark telemetry without fictional fixture copy', () => {
  const observed = structuredClone(createPropertyPredatorProviderReadinessFixture());
  (observed as { dataset: 'evidence' | 'illustrative_fixture' }).dataset = 'evidence';
  for (const rail of observed.rails) {
    (rail.telemetry as { source: 'fictional_simulation' | 'observed_runtime' }).source =
      'observed_runtime';
  }
  (observed.rails[0]!.telemetry as {
    executionMode: 'simulation_only' | 'real_adapter_dark';
  }).executionMode = 'real_adapter_dark';

  const view = presentProviderReadinessCockpit(observed);
  const html = renderProviderReadinessCockpitBody(view);
  assert.equal(view.illustrative, false);
  assert.equal(view.realDarkRailCount, 1);
  assert.match(html, /READ-ONLY EVIDENCE/);
  assert.match(html, /REAL ADAPTER · EFFECTS OFF/);
  assert.match(html, /Observed runtime telemetry/);
  assert.match(html, /Observed bounded runtime evidence is read-only/);
  assert.match(html, /Observed items waiting/);
  assert.match(html, /<small>observed items<\/small>/);
  assert.match(html, /Next retry ·/);
  assert.match(html, /Oldest item ·/);
  assert.doesNotMatch(html, /Fictional local telemetry|Fictional items waiting|Next fictional retry|Oldest fictional item/);
  assert.doesNotMatch(html, /Every displayed queue, retry and reconciliation item is fictional local evidence/);
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

  const fictionalClaimingRuntime = structuredClone(createPropertyPredatorProviderReadinessFixture());
  (fictionalClaimingRuntime.rails[0]!.telemetry as {
    source: 'fictional_simulation' | 'observed_runtime';
    executionMode: 'simulation_only' | 'real_adapter_dark';
  }).source = 'observed_runtime';
  (fictionalClaimingRuntime.rails[0]!.telemetry as {
    executionMode: 'simulation_only' | 'real_adapter_dark';
  }).executionMode = 'real_adapter_dark';
  assert.throws(
    () => presentProviderReadinessCockpit(fictionalClaimingRuntime),
    /cannot claim a real provider runtime/,
  );

  const activeWhilePaused = structuredClone(createPropertyPredatorProviderReadinessFixture());
  (activeWhilePaused.rails[0]!.telemetry as { activeLeaseCount: number }).activeLeaseCount = 1;
  assert.throws(() => presentProviderReadinessCockpit(activeWhilePaused), /cannot claim an active lease/);

  const contradictoryRetry = structuredClone(createPropertyPredatorProviderReadinessFixture());
  (contradictoryRetry.rails[2]!.telemetry as { nextRetryAt: string | null }).nextRetryAt = null;
  assert.throws(() => presentProviderReadinessCockpit(contradictoryRetry), /retry telemetry is contradictory/);

  const rawProviderError = structuredClone(createPropertyPredatorProviderReadinessFixture());
  (rawProviderError.rails[0]!.telemetry as { lastErrorClass: string | null }).lastErrorClass = '550 recipient@example.test';
  assert.throws(() => presentProviderReadinessCockpit(rawProviderError), /not safely redacted/);

  const hostileOperationalBlocker = structuredClone(createPropertyPredatorProviderReadinessFixture());
  (hostileOperationalBlocker.rails[0]!.telemetry.blockers[0]! as { message: string }).message =
    '<img src=x onerror=alert(2)> stays blocked';
  const escapedBlockerHtml = renderProviderReadinessCockpitBody(
    presentProviderReadinessCockpit(hostileOperationalBlocker),
  );
  assert.match(escapedBlockerHtml, /&lt;img src=x onerror=alert\(2\)&gt; stays blocked/);
  assert.doesNotMatch(escapedBlockerHtml, /<img src=x/);
});
