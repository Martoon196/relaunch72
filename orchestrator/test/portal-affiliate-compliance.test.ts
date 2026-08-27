import assert from 'node:assert/strict';
import test from 'node:test';
import { createPropertyPredatorAffiliateComplianceFixture } from '../src/portal/affiliate-compliance-fixtures.js';
import {
  AffiliateCompliancePresentationError,
  presentAffiliateCompliance,
} from '../src/portal/affiliate-compliance-presenter.js';
import { renderAffiliateComplianceBody } from '../src/portal/affiliate-compliance-view.js';
import type { PortalAffiliateComplianceSnapshot } from '../src/portal/affiliate-compliance-service.js';

test('Affiliate Compliance keeps every state independent and every fictional subject blocked', () => {
  const fixture = createPropertyPredatorAffiliateComplianceFixture();
  const view = presentAffiliateCompliance(fixture);
  assert.equal(view.fictionalDemo, true);
  assert.equal(view.externalEffectsOff, true);
  assert.equal(view.metrics.documentCount, 7);
  assert.equal(view.metrics.solicitorApprovedCount, 0);
  assert.equal(view.metrics.publishedCount, 0);
  assert.equal(view.metrics.fictionalSubjectCount, 3);
  assert.equal(view.metrics.blockedSubjectCount, 3);
  assert.equal(view.sourceCommitLabel, 'Draft provenance only');
  assert.equal(fixture.programme.sourceCommit, '3405cc8');
  assert.equal(
    fixture.programme.bundleSha256,
    '739ce2b2d9b051a94fca79c622cd476934edb61c25dc207e89e6850e1d859ce6',
  );
  assert.deepEqual(fixture.programme.documents.map((document) => document.contentSha256), [
    '7d486fc05ec0c1087a18c49358e470b0c62be5d8e6623f894f5164a37b35fc5e',
    '6422d8a5f2debf141dbc3a2450636ab034a27bbbbdcea257bd5116c2bd9efc43',
    '147cdffc5c7503e79b0e760dd142f672b4b9ebd5fdb51a2d206717954230a55d',
    '57827798c31905d05313306b72b6ffcd27637d7dba824fe7999c57f42eb6654a',
    'a73e97eb6727be94612af366eb178991ba45f03d8beb027814e29e8a72554500',
    'a6bf38fa524f252de8b1872c2e99d2c3b07df6ef73c8d9c0f5f6a1517ff2af05',
    'd2ac780e9efb02ae55a0212e3db5096283ea854ae57fe7389d34071ee5bbd83d',
  ]);
  assert.ok(view.subjects.every((subject) => subject.permissions.every((permission) => permission.decision === 'deny')));
  assert.deepEqual(view.gates.map((gate) => [gate.gateId, gate.passes]), [
    ['drafting', true], ['legal', false], ['commercial', false], ['publication', false], ['acceptance', false], ['permissions', false],
  ]);
});

test('Affiliate Compliance is branded, touch-friendly and never exposes a link or mutable command', () => {
  const html = renderAffiliateComplianceBody(presentAffiliateCompliance(createPropertyPredatorAffiliateComplianceFixture()));
  assert.match(html, /Grow the network\.<em>Prove every permission\.<\/em>/);
  assert.match(html, /Fictional demo/i);
  assert.match(html, /EXTERNAL EFFECTS OFF/);
  assert.match(html, /Draft provenance only/);
  assert.match(html, /Overview<\/a><a href="#people">People<\/a><a href="#legal-bundle">Legal bundle<\/a><a href="#training">Training<\/a><a href="#channels">Channels<\/a><a href="#breaches">Breaches/);
  assert.match(html, /No affiliate link is shown or copyable/);
  assert.match(html, /No override:/);
  assert.match(html, /min-height:46px/);
  assert.match(html, /@media\(forced-colors:active\)/);
  assert.match(html, /<details class="ac-evidence">/);
  assert.match(html, /<table class="ac-doc-table">/);
  assert.match(html, /<caption>Exact fictional document versions/);
  assert.match(html, /<th scope="col">/);
  assert.match(html, /<th scope="row">/);
  assert.match(html, /no misleading overall compliance score/i);
  assert.doesNotMatch(html, /[0-9]+% compliant/i);
  assert.doesNotMatch(html, /<form\b|method="post"|copy link|href="https?:\/\/[^\"]*ref=/i);
});

test('Affiliate Compliance presenter rejects cloned or forged fixtures and the view escapes display text', () => {
  const fixture = createPropertyPredatorAffiliateComplianceFixture();
  const poisoned = {
    ...fixture,
    workspace: { ...fixture.workspace, workspaceName: '<script>bad</script>' },
    programme: { ...fixture.programme, apiKey: 'DO-NOT-RENDER-SECRET' },
    subjects: [{ ...fixture.subjects[0]!, email: 'real@example.com', rawIp: '127.0.0.1' }],
  } as unknown as PortalAffiliateComplianceSnapshot;
  assert.throws(() => presentAffiliateCompliance(poisoned), AffiliateCompliancePresentationError);

  const view = structuredClone(presentAffiliateCompliance(fixture)) as any;
  view.subjects[0].displayLabel = '<script>bad</script>';
  const html = renderAffiliateComplianceBody(view);
  assert.doesNotMatch(html, /<script>bad<\/script>/);
  assert.match(html, /&lt;script&gt;bad&lt;\/script&gt;/);
});

test('Affiliate Compliance fails closed if the snapshot claims real data, approval, publication or effects', () => {
  const fixture = createPropertyPredatorAffiliateComplianceFixture();
  for (const snapshot of [
    { ...fixture, dataset: 'postgres_authoritative' },
    { ...fixture, programme: { ...fixture.programme, externalEffects: true } },
    { ...fixture, programme: { ...fixture.programme, solicitorApproved: true } },
    { ...fixture, programme: { ...fixture.programme, published: true } },
    { ...fixture, subjects: [{ ...fixture.subjects[0]!, fictional: false }] },
    { ...fixture, workspace: { ...fixture.workspace, canManage: false } },
    { ...fixture, subjects: [{ ...fixture.subjects[0]!, displayLabel: 'Real customer name' }] },
  ]) {
    assert.throws(() => presentAffiliateCompliance(snapshot as never), AffiliateCompliancePresentationError);
  }
});
