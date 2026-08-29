import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CAMPAIGN_MACHINE_ROUTE,
  campaignMachineStepContentSha256,
  presentCampaignMachine,
  type CampaignMachineSnapshot,
} from '../src/portal/campaign-machine-presenter.js';
import { createPropertyPredatorCampaignMachineFixture } from '../src/portal/campaign-machine-fixtures.js';
import { renderCampaignMachineBody } from '../src/portal/campaign-machine-view.js';

function clone(): CampaignMachineSnapshot {
  return structuredClone(createPropertyPredatorCampaignMachineFixture());
}

test('Campaign Machine presents one exact Brand Brain and LAPS-bound nurture system', () => {
  assert.equal(CAMPAIGN_MACHINE_ROUTE, '/portal/campaigns/sequences');
  const view = presentCampaignMachine(createPropertyPredatorCampaignMachineFixture());
  assert.deepEqual(view.metrics, {
    templateCount: 1,
    versionCount: 1,
    stepCount: 6,
    emailStepCount: 4,
    operatorTaskCount: 2,
    preparedCount: 1,
    approvedCount: 0,
  });
  const template = view.templates[0]!;
  assert.equal(template.lapsTrackLabel, 'Self-serve LAPS');
  assert.equal(template.entryStageLabel, 'Lead');
  assert.equal(template.targetStageLabel, 'Activated');
  assert.equal(template.approval.label, 'Review required');
  assert.equal(template.reporting.exactBinding, true);
  assert.equal(template.recipe.exactBinding, true);
  assert.equal(template.preparedForReview, true);
  assert.equal(template.activationReady, false);
  assert.ok(template.steps.every((step) => step.exactContent));
  assert.deepEqual(template.specialistChain, [
    'Offer Architect', 'Direct Response Copywriter', 'Email Specialist', 'Growth HQ operator',
  ]);
});

test('Campaign Machine renders premium prewritten copy with explicit no-effect truth', () => {
  const html = renderCampaignMachineBody(
    presentCampaignMachine(createPropertyPredatorCampaignMachineFixture()),
  );
  assert.match(html, /Build it once\./);
  assert.match(html, /Run it with evidence\./);
  assert.match(html, /The asking price is the anchor\. Not the answer\./);
  assert.match(html, /Kill the weak assumption before it kills the deal\./);
  assert.match(html, /Call the new lead/);
  assert.match(html, /Brand Brain → immutable version → steps → LAPS trigger → approval → reporting identity/);
  assert.match(html, /NO SEND · NO CUSTOMER · NO PROVIDER/);
  assert.match(html, /data-provider-effects="none"/);
  assert.match(html, /data-live-activation="false"/);
  assert.doesNotMatch(html, /<form|method="post"|Send now|Activate sequence/iu);
});

test('Campaign Machine fails closed on altered content, version, recipe or provider truth', () => {
  const altered = clone();
  const template = altered.templates[0]! as any;
  template.steps[0].body = 'Changed after hashing';
  template.steps[1].templateVersionId = 'c5110000-0000-4000-8000-000000000099';
  template.recipe.providerEffects = true;
  template.reporting.templateVersionSha256 = 'f'.repeat(64);
  const view = presentCampaignMachine(altered);
  assert.equal(view.templates[0]!.preparedForReview, false);
  assert.equal(view.templates[0]!.stateLabel, 'LOCKED');
  assert.ok(view.templates[0]!.steps.some((step) => !step.exactContent));
  assert.equal(view.templates[0]!.recipe.exactBinding, false);
  assert.equal(view.templates[0]!.reporting.exactBinding, false);
  assert.match(view.templates[0]!.blockers.join(' '), /exact immutable version|automation recipe|reporting identity/i);
});

test('Campaign Machine canonical step hash binds subject, preview, body and CTA', () => {
  const step = createPropertyPredatorCampaignMachineFixture().templates[0]!.steps[0]!;
  assert.equal(step.contentSha256, campaignMachineStepContentSha256(step));
  assert.notEqual(step.contentSha256, campaignMachineStepContentSha256({
    ...step,
    ctaLabel: `${step.ctaLabel} changed`,
  }));
});

test('Campaign Machine escapes hostile fixture text and remains deterministic', () => {
  const hostile = clone();
  (hostile.templates[0] as any).name = '<script>alert(1)</script>';
  (hostile.templates[0]!.steps[0] as any).body = '<img src=x onerror=alert(1)>';
  (hostile.templates[0]!.steps[0] as any).contentSha256 = campaignMachineStepContentSha256(
    hostile.templates[0]!.steps[0]!,
  );
  const first = renderCampaignMachineBody(presentCampaignMachine(hostile));
  const second = renderCampaignMachineBody(presentCampaignMachine(hostile));
  assert.equal(first, second);
  assert.doesNotMatch(first, /<script>|<img src=x/iu);
  assert.match(first, /&lt;script&gt;/);
  assert.match(first, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

