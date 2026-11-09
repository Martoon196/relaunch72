import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createPropertyPredatorWebinarStudioFixture,
} from '../src/portal/webinar-studio-fixtures.js';
import {
  WEBINAR_STUDIO_MAX_PROOFS,
  WEBINAR_STUDIO_ROUTE,
  presentWebinarStudio,
  type WebinarStudioSnapshot,
} from '../src/portal/webinar-studio-presenter.js';
import { renderWebinarStudioBody } from '../src/portal/webinar-studio-view.js';

test('Webinar Studio assembles the full conversion room and opens only a TEST rehearsal gate', () => {
  const view = presentWebinarStudio(createPropertyPredatorWebinarStudioFixture());
  assert.equal(WEBINAR_STUDIO_ROUTE, '/portal/webinars');
  assert.equal(view.event.environment, 'test');
  assert.equal(view.event.providerEventId, null);
  assert.equal(view.event.immutableProofValid, true);
  assert.equal(view.registration.length, 5);
  assert.equal(view.speakers.length, 2);
  assert.equal(view.runOfShow.length, 8);
  assert.equal(view.engagementSignals.length, 6);
  assert.equal(view.replay.length, 4);
  assert.ok(view.proofs.filter((proof) => proof.required).every((proof) => proof.passes));
  assert.ok(view.replay.every((step) => step.gatePasses));
  assert.equal(view.adapter.safeForTest, true);
  assert.equal(view.rehearsalGate.open, true);
  assert.equal(view.rehearsalGate.label, 'TEST REHEARSAL READY');
  assert.equal(view.rehearsalGate.passed, 9);
  assert.equal(view.rehearsalGate.total, 9);
  assert.deepEqual(view.rehearsalGate.blockers, []);
  assert.equal(view.commandBoundaryAvailable, false);
  assert.equal(view.liveBroadcastAvailable, false);
  assert.equal(view.providerEffects, 'none');
});

test('registration, attendance and engagement remain explicitly simulated rather than measured', () => {
  const view = presentWebinarStudio(createPropertyPredatorWebinarStudioFixture());
  assert.deepEqual(view.registration.map((stage) => stage.count), [420, 180, 154, 108, 62]);
  assert.ok(view.registration.every((stage) => stage.truthLabel === 'SIMULATED' && stage.truthful));
  assert.ok(view.runOfShow.every((segment) => segment.attendanceTruth === 'simulated' && segment.truthful));
  assert.ok(view.engagementSignals.every((signal) => signal.truthLabel === 'SIMULATED' && signal.truthful));
  assert.deepEqual(view.truthSummary, { simulated: 19, measured: 0, unavailable: 0 });
  assert.deepEqual(view.registrationSummary, {
    largestCount: 420,
    registeredCount: 180,
    showUpRate: 60,
    truthLabel: 'SIMULATED plan',
  });
});

test('rehearsal fails closed for expired or evidence-free readiness proof', () => {
  const fixture = createPropertyPredatorWebinarStudioFixture();
  const first = fixture.proofs[0];
  assert.ok(first);
  const expired = presentWebinarStudio({
    ...fixture,
    proofs: [{ ...first, expiresAt: fixture.asOf }, ...fixture.proofs.slice(1)],
  });
  assert.equal(expired.proofs[0]?.state, 'expired');
  assert.equal(expired.proofs[0]?.passes, false);
  assert.equal(expired.rehearsalGate.open, false);
  assert.equal(expired.rehearsalGate.checks.find((check) => check.key === 'readiness')?.passed, false);

  const noEvidence = presentWebinarStudio({
    ...fixture,
    proofs: [{ ...first, evidenceRef: null }, ...fixture.proofs.slice(1)],
  });
  assert.equal(noEvidence.proofs[0]?.stateLabel, 'Evidence mismatch');
  assert.equal(noEvidence.rehearsalGate.open, false);
});

test('run of show rejects gaps, missing speakers and segments outside the event runtime', () => {
  const fixture = createPropertyPredatorWebinarStudioFixture();
  const second = fixture.runOfShow[1];
  assert.ok(second);
  const gap = presentWebinarStudio({
    ...fixture,
    runOfShow: [fixture.runOfShow[0]!, { ...second, startMinute: 7 }, ...fixture.runOfShow.slice(2)],
  });
  assert.equal(gap.rehearsalGate.checks.find((check) => check.key === 'timeline')?.passed, false);
  assert.equal(gap.rehearsalGate.open, false);

  const unknownSpeaker = presentWebinarStudio({
    ...fixture,
    runOfShow: [{ ...fixture.runOfShow[0]!, speakerId: 'unknown-speaker' }, ...fixture.runOfShow.slice(1)],
  });
  assert.equal(unknownSpeaker.runOfShow[0]?.speakerName, 'Speaker unavailable');
  assert.equal(unknownSpeaker.rehearsalGate.checks.find((check) => check.key === 'speakers')?.passed, false);

  const overrun = presentWebinarStudio({
    ...fixture,
    runOfShow: [...fixture.runOfShow.slice(0, -1), { ...fixture.runOfShow.at(-1)!, endMinute: 80 }],
  });
  assert.equal(overrun.rehearsalGate.checks.find((check) => check.key === 'timeline')?.passed, false);
});

test('funnel and engagement truth rejects impossible or ambiguously labelled evidence', () => {
  const fixture = createPropertyPredatorWebinarStudioFixture();
  const impossible = presentWebinarStudio({
    ...fixture,
    registration: [fixture.registration[0]!, { ...fixture.registration[1]!, count: 999 }, ...fixture.registration.slice(2)],
  });
  assert.equal(impossible.rehearsalGate.checks.find((check) => check.key === 'registration')?.passed, false);

  const unavailableWithValue = presentWebinarStudio({
    ...fixture,
    registration: [{ ...fixture.registration[0]!, truth: 'unavailable' }, ...fixture.registration.slice(1)],
  });
  assert.equal(unavailableWithValue.registration[0]?.truthful, false);
  assert.equal(unavailableWithValue.rehearsalGate.open, false);

  const signalOutsideSession = presentWebinarStudio({
    ...fixture,
    engagementSignals: [{ ...fixture.engagementSignals[0]!, minute: 100 }, ...fixture.engagementSignals.slice(1)],
  });
  assert.equal(signalOutsideSession.rehearsalGate.checks.find((check) => check.key === 'engagement')?.passed, false);
});

test('replay rail requires exact immutable approval, consent and simulated execution', () => {
  const fixture = createPropertyPredatorWebinarStudioFixture();
  const first = fixture.replay[0];
  assert.ok(first);
  const mismatch = presentWebinarStudio({
    ...fixture,
    replay: [{ ...first, approvedSha256: 'f'.repeat(64) }, ...fixture.replay.slice(1)],
  });
  assert.equal(mismatch.replay[0]?.exactApproval, false);
  assert.equal(mismatch.replay[0]?.gatePasses, false);
  assert.equal(mismatch.rehearsalGate.checks.find((check) => check.key === 'replay')?.passed, false);
  assert.equal(mismatch.rehearsalGate.open, false);
});

test('adapter readiness is TEST-only, recent and incapable of provider effects', () => {
  const fixture = createPropertyPredatorWebinarStudioFixture();
  const setupRequired = presentWebinarStudio({
    ...fixture,
    adapter: { ...fixture.adapter, state: 'setup_required' },
  });
  assert.equal(setupRequired.adapter.safeForTest, false);
  assert.equal(setupRequired.adapter.stateLabel, 'Setup required');
  assert.equal(setupRequired.rehearsalGate.checks.find((check) => check.key === 'adapter')?.passed, false);

  const invalidHealthProof = presentWebinarStudio({
    ...fixture,
    adapter: { ...fixture.adapter, healthCheckedAt: 'not-an-instant' },
  });
  assert.equal(invalidHealthProof.adapter.safeForTest, false);
  assert.equal(invalidHealthProof.adapter.checkedLabel, 'No health proof');
});

test('oversized input is bounded and keeps rehearsal locked', () => {
  const fixture = createPropertyPredatorWebinarStudioFixture();
  const source = fixture.proofs[0];
  assert.ok(source);
  const proofs = Array.from({ length: WEBINAR_STUDIO_MAX_PROOFS + 3 }, (_, index) => ({
    ...source,
    proofId: `proof-${index}`,
    label: `${'<proof>'}${'x'.repeat(500)}-${index}`,
  }));
  const view = presentWebinarStudio({ ...fixture, proofs });
  assert.equal(view.proofs.length, WEBINAR_STUDIO_MAX_PROOFS);
  assert.ok((view.proofs[0]?.label.length ?? 0) <= 120);
  assert.equal(view.inputTruncated, true);
  assert.equal(view.rehearsalGate.open, false);
  assert.equal(view.rehearsalGate.checks.find((check) => check.key === 'bounds')?.passed, false);
  assert.match(renderWebinarStudioBody(view), /exceeded a safe evaluation bound/);
});

test('Webinar Studio renders premium responsive UX with explicit TEST and live locks', () => {
  const html = renderWebinarStudioBody(presentWebinarStudio(createPropertyPredatorWebinarStudioFixture()));
  assert.match(html, /data-property-predator-webinar-studio/);
  assert.match(html, /<article class="wbs" aria-labelledby="wbs-title" data-environment="test" data-provider-effects="none" data-command-boundary="absent" data-live-broadcast="unavailable">/);
  assert.match(html, /Build the room\.<br><em>Engineer the decision\.<\/em>/);
  assert.match(html, /Event blueprint &amp; readiness/);
  assert.match(html, /Registration funnel/);
  assert.match(html, /Attendance timeline &amp; run of show/);
  assert.match(html, /Speaker desk/);
  assert.match(html, /Engagement &amp; Lead 360 signals/);
  assert.match(html, /Replay follow-up journey/);
  assert.match(html, /Provider adapter readiness/);
  assert.match(html, /Rehearsal ledger/);
  assert.match(html, /TEST-only studio/);
  assert.match(html, /No register · no send · no broadcast/);
  assert.match(html, /Create TEST provider event · unavailable/);
  assert.match(html, /Go live · locked/);
  assert.equal((html.match(/disabled aria-disabled="true"/g) ?? []).length, 2);
  assert.match(html, /min-height:46px/);
  assert.match(html, /@media\(max-width:850px\)/);
  assert.match(html, /@media\(max-width:540px\)/);
  assert.match(html, /@media\(forced-colors:active\)/);
  assert.match(html, /@media\(prefers-reduced-motion:reduce\)/);
  assert.doesNotMatch(html, /<form|method="post"|Start broadcast|Publish event|providerToken|accessToken|apiKey|secretKey/i);
});

test('Webinar Studio escapes hostile snapshot text and never renders undeclared credentials', () => {
  const fixture = createPropertyPredatorWebinarStudioFixture();
  const hostile = {
    ...fixture,
    workspaceName: '<script>alert(1)</script>',
    event: { ...fixture.event, title: '<img src=x onerror=alert(2)>', promise: '</p><script>alert(3)</script>' },
    speakers: [{ ...fixture.speakers[0]!, name: '<svg onload=alert(4)>', promise: 'A&B' }, ...fixture.speakers.slice(1)],
    adapter: {
      ...fixture.adapter,
      providerLabel: '"><script>alert(5)</script>',
      capabilities: ['<img src=x onerror=alert(6)>'],
    },
    apiKey: 'SUPER-SECRET-MUST-NOT-RENDER',
    accessToken: 'TOKEN-MUST-NOT-RENDER',
  } as WebinarStudioSnapshot & { apiKey: string; accessToken: string };
  const html = renderWebinarStudioBody(presentWebinarStudio(hostile));
  assert.doesNotMatch(html, /<(?:script|img|svg)\b/i);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /&lt;img src=x onerror=alert\(2\)&gt;/);
  assert.match(html, /&lt;svg onload=alert\(4\)&gt;/);
  assert.match(html, /A&amp;B/);
  assert.doesNotMatch(html, /SUPER-SECRET|TOKEN-MUST/);
  assert.doesNotMatch(html, /apiKey|accessToken/i);
});

test('Webinar Studio presentation is deterministic for the same immutable snapshot', () => {
  const fixture = createPropertyPredatorWebinarStudioFixture();
  const first = presentWebinarStudio(fixture);
  const second = presentWebinarStudio(fixture);
  assert.deepEqual(second, first);
  assert.equal(renderWebinarStudioBody(second), renderWebinarStudioBody(first));
});
