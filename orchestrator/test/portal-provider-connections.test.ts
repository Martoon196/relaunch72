import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PROVIDER_CONNECTIONS_MAX_ADAPTERS,
  PROVIDER_CONNECTIONS_MAX_CHECKS,
  PROVIDER_CONNECTIONS_MAX_TEXT,
  PROVIDER_CONNECTIONS_ROUTE,
  presentProviderConnections,
  type ProviderAdapterStatus,
  type ProviderConnectionsSnapshot,
  type ProviderReadinessProof,
} from '../src/portal/provider-connections-presenter.js';
import { createPropertyPredatorProviderConnectionsFixture } from '../src/portal/provider-connections-fixtures.js';
import { renderProviderConnectionsBody } from '../src/portal/provider-connections-view.js';

function verifiedProof(overrides: Partial<ProviderReadinessProof> = {}): ProviderReadinessProof {
  return {
    proofId: 'email.domain.1',
    kind: 'domain',
    label: 'Sending domain',
    detail: 'Exact domain ownership and signing proof.',
    required: true,
    state: 'verified',
    verifiedAt: '2026-08-26T09:00:00.000Z',
    expiresAt: '2026-09-26T09:00:00.000Z',
    evidenceRef: 'proof:email:domain',
    ...overrides,
  };
}

function readyAdapter(overrides: Partial<ProviderAdapterStatus> = {}): ProviderAdapterStatus {
  return {
    adapterId: 'email-delivery',
    category: 'email',
    providerLabel: 'Email delivery rail',
    environment: 'live',
    requiredForLaunch: true,
    connectionState: 'ready',
    statusDetail: 'Ready for deterministic testing.',
    nextStep: 'Retain current proof coverage.',
    capabilities: ['Delivery', 'Events'],
    health: {
      state: 'healthy',
      checkedAt: '2026-08-26T09:25:00.000Z',
      summary: 'Health probe passed.',
      latencyMs: 29,
    },
    proofs: [verifiedProof()],
    ...overrides,
  };
}

function snapshot(
  adapters: readonly ProviderAdapterStatus[],
  overrides: Partial<ProviderConnectionsSnapshot> = {},
): ProviderConnectionsSnapshot {
  return {
    workspaceId: 'workspace-test',
    workspaceName: 'Property Predator Growth HQ',
    targetEnvironment: 'live',
    asOf: '2026-08-26T09:30:00.000Z',
    dataset: 'evidence',
    requiredCategories: ['email'],
    adapters,
    ...overrides,
  };
}

test('provider fixture presents all launch rails and keeps the live gate closed', () => {
  const view = presentProviderConnections(createPropertyPredatorProviderConnectionsFixture());
  assert.equal(PROVIDER_CONNECTIONS_ROUTE, '/portal/connections');
  assert.equal(view.adapterCount, 8);
  assert.equal(view.categoryCount, 8);
  assert.deepEqual(view.adapters.map((adapter) => adapter.category), [
    'email',
    'sms',
    'whatsapp',
    'social_publishing',
    'social_listening',
    'webinar',
    'payments',
    'ai',
  ]);
  assert.equal(view.launchGate.open, false);
  assert.equal(view.launchGate.label, 'CLOSED');
  assert.equal(view.illustrative, true);
  assert.equal(view.launchGate.verifiedProofCount, 0);
  assert.ok(view.launchGate.blockers.some((blocker) => /Illustrative statuses/.test(blocker.reason)));
  assert.ok(view.launchGate.blockerCount > 0);
  assert.ok(view.adapters.some((adapter) => adapter.environment === 'test'));
  assert.ok(view.adapters.some((adapter) => adapter.environment === 'live'));
  assert.ok(view.adapters.some((adapter) => adapter.proofs.some((proof) => proof.kind === 'oauth')));
  assert.ok(view.adapters.some((adapter) => adapter.proofs.some((proof) => proof.kind === 'webhook')));
  assert.ok(view.adapters.some((adapter) => adapter.proofs.some((proof) => proof.kind === 'domain')));
  assert.ok(view.adapters.some((adapter) => adapter.proofs.some((proof) => proof.kind === 'consent')));
  assert.ok(view.adapters.some((adapter) => adapter.proofs.some((proof) => proof.kind === 'compliance')));
});

test('launch gate opens only for a complete required category set with healthy live adapters and current proofs', () => {
  const email = readyAdapter();
  const optionalAi = readyAdapter({
    adapterId: 'ai-drafts',
    category: 'ai',
    providerLabel: 'Optional AI drafting rail',
    requiredForLaunch: false,
    connectionState: 'setup_required',
    health: { state: 'unknown', checkedAt: null, summary: 'Not configured.' },
    proofs: [],
  });
  const open = presentProviderConnections(snapshot([email, optionalAi]));
  assert.equal(open.launchGate.open, true);
  assert.equal(open.launchGate.blockerCount, 0);
  assert.equal(open.launchGate.readyAdapterCount, 1);

  const wrongEnvironment = presentProviderConnections(snapshot([
    readyAdapter({ environment: 'test' }),
  ]));
  assert.equal(wrongEnvironment.launchGate.open, false);
  assert.match(wrongEnvironment.launchGate.blockers[0]?.reason ?? '', /TEST, not LIVE/);

  const missingCategory = presentProviderConnections(snapshot([email], {
    requiredCategories: ['email', 'whatsapp'],
  }));
  assert.equal(missingCategory.launchGate.open, false);
  assert.ok(missingCategory.launchGate.blockers.some((blocker) => blocker.categoryLabel === 'WhatsApp'));
});

test('launch gate fails closed for absent, expired, missing or contradictory proof and health states', () => {
  const empty = presentProviderConnections(snapshot([], { requiredCategories: ['email'] }));
  assert.equal(empty.launchGate.open, false);
  assert.equal(empty.launchGate.requiredAdapterCount, 0);
  assert.match(empty.launchGate.blockers[0]?.reason ?? '', /absent/);

  const noProof = presentProviderConnections(snapshot([readyAdapter({ proofs: [] })]));
  assert.equal(noProof.launchGate.open, false);
  assert.ok(noProof.launchGate.blockers.some((blocker) => /No required launch proofs/.test(blocker.reason)));

  const noEvidence = presentProviderConnections(snapshot([readyAdapter({
    proofs: [verifiedProof({ evidenceRef: null })],
  })]));
  assert.equal(noEvidence.adapters[0]?.proofs[0]?.state, 'pending');
  assert.equal(noEvidence.launchGate.open, false);

  const requiredButNotApplicable = presentProviderConnections(snapshot([readyAdapter({
    proofs: [verifiedProof({ state: 'not_applicable' })],
  })]));
  assert.equal(requiredButNotApplicable.launchGate.open, false);

  const expired = presentProviderConnections(snapshot([readyAdapter({
    proofs: [verifiedProof({ expiresAt: '2026-08-26T09:29:59.000Z' })],
  })]));
  assert.equal(expired.adapters[0]?.proofs[0]?.state, 'expired');
  assert.equal(expired.launchGate.open, false);
  assert.ok(expired.launchGate.blockers.some((blocker) => /expired/.test(blocker.reason)));

  const unreachable = presentProviderConnections(snapshot([readyAdapter({
    health: { state: 'unreachable', checkedAt: null, summary: 'Probe failed.' },
  })]));
  assert.equal(unreachable.launchGate.open, false);
  assert.ok(unreachable.launchGate.blockers.some((blocker) => /unreachable/.test(blocker.reason)));
});

test('provider readiness output is bounded and oversized input keeps launch closed', () => {
  const long = '<long>' + 'x'.repeat(400);
  const checks = Array.from({ length: PROVIDER_CONNECTIONS_MAX_CHECKS + 7 }, (_, index) =>
    verifiedProof({ proofId: `proof-${index}`, label: `${long}-${index}` }));
  const adapters = Array.from({ length: PROVIDER_CONNECTIONS_MAX_ADAPTERS + 3 }, (_, index) =>
    readyAdapter({
      adapterId: `adapter-${index}`,
      providerLabel: `${long}-${index}`,
      proofs: checks,
    }));
  const view = presentProviderConnections(snapshot(adapters));
  assert.equal(view.adapters.length, PROVIDER_CONNECTIONS_MAX_ADAPTERS);
  assert.equal(view.adapters[0]?.proofs.length, PROVIDER_CONNECTIONS_MAX_CHECKS);
  assert.equal(view.adapters[0]?.providerLabel.length, PROVIDER_CONNECTIONS_MAX_TEXT);
  assert.equal(view.inputTruncated, true);
  assert.equal(view.launchGate.open, false);
  assert.ok(view.launchGate.blockers.some((blocker) => /safe evaluation bound/.test(blocker.reason)));
});

test('provider status rendering escapes display fields and never leaks undeclared secret material', () => {
  const hostile = {
    ...readyAdapter({
      adapterId: 'email"><script>alert(1)</script>',
      providerLabel: '<img src=x onerror=alert(2)>',
      statusDetail: 'status"><script>alert(3)</script>',
      nextStep: '<svg onload=alert(4)>',
      capabilities: ['<script>alert(5)</script>'],
      health: {
        state: 'healthy' as const,
        checkedAt: 'not-an-instant"><img src=x>',
        summary: '<img src=x onerror=alert(6)>',
      },
      proofs: [verifiedProof({
        label: '<script>alert(7)</script>',
        detail: '<img src=x onerror=alert(8)>',
        evidenceRef: '"><svg onload=alert(9)>',
      })],
    }),
    apiKey: 'SUPER-SECRET-MUST-NOT-RENDER',
    accessToken: 'TOKEN-MUST-NOT-RENDER',
  } as ProviderAdapterStatus & { apiKey: string; accessToken: string };
  const view = presentProviderConnections(snapshot([hostile], {
    workspaceName: '<script>alert(10)</script>',
  }));
  const html = renderProviderConnectionsBody(view);
  assert.doesNotMatch(html, /<(?:script|img|svg)\b/i);
  assert.match(html, /&lt;img src=x onerror=alert\(2\)&gt;/);
  assert.match(html, /&lt;script&gt;alert\(10\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /SUPER-SECRET|TOKEN-MUST/);
  assert.doesNotMatch(html, /apiKey|accessToken/i);
});

test('provider connections view is premium, responsive, accessible and explicitly side-effect free', () => {
  const html = renderProviderConnectionsBody(
    presentProviderConnections(createPropertyPredatorProviderConnectionsFixture()),
  );
  assert.match(html, /<article class="pcr" aria-labelledby="pcr-title">/);
  assert.match(html, /Provider control plane/);
  assert.match(html, /TEST FIXTURE \/ ILLUSTRATIVE/);
  assert.match(html, /Every provider status and proof on this screen is fictional demonstration data/);
  assert.match(html, /Simulated proof passed/);
  assert.doesNotMatch(html, /Review verified setup/);
  assert.match(html, /Deterministic launch gate <b>CLOSED<\/b>/);
  assert.match(html, /Provider readiness map/);
  assert.match(html, /Email delivery rail/);
  assert.match(html, /WhatsApp Business rail/);
  assert.match(html, /Social publishing rail/);
  assert.match(html, /Social listening rail/);
  assert.match(html, /Webinar rail/);
  assert.match(html, /Payments rail/);
  assert.match(html, /AI orchestration rail/);
  assert.match(html, /Environment TEST/);
  assert.match(html, /Environment LIVE/);
  assert.match(html, /Setup required · view brief/);
  assert.match(html, /does not start OAuth, submit credentials or contact a provider/);
  assert.match(html, /never accepts or displays API keys, access tokens, webhook secrets or OAuth codes/);
  assert.match(html, /min-height:46px/);
  assert.match(html, /@media\(max-width:820px\)/);
  assert.match(html, /@media\(max-width:520px\)/);
  assert.match(html, /@media\(forced-colors:active\)/);
  assert.doesNotMatch(html, /<(?:form|button|input)\b/i);
  assert.doesNotMatch(html, />\s*(?:Connect|Authorise|Authorize|Go live|Send|Publish|Charge)\s*</i);
});
