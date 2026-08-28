import assert from 'node:assert/strict';
import test from 'node:test';
import { BRAND_BRAIN_ROUTE, brandBrainReadOnlyActionHref } from '../src/portal/brand-brain-actions.js';
import { createPropertyPredatorBrandBrainFixture } from '../src/portal/brand-brain-fixtures.js';
import {
  BrandBrainPresentationError,
  presentBrandBrain,
} from '../src/portal/brand-brain-presenter.js';
import { renderBrandBrainBody } from '../src/portal/brand-brain-view.js';
import { renderContentWorkspaceNavigation } from '../src/portal/content-workspace-navigation.js';
import type { PortalBrandBrainSnapshot } from '../src/portal/brand-brain-service.js';

test('Brand Brain presents the six source specialists and three founder exports without runtime authority', () => {
  const view = presentBrandBrain(createPropertyPredatorBrandBrainFixture());

  assert.equal(view.metrics.specialistCount, 6);
  assert.equal(view.metrics.externalAwaitingCount, 3);
  assert.equal(view.metrics.runtimeReadyCount, 0);
  assert.equal(view.metrics.approvedReviewCount, 2);
  assert.equal(view.metrics.requiredReviewCount, 3);
  assert.equal(view.metrics.artworkCount, 18);
  assert.equal(view.providerEffectsOff, true);
  assert.equal(view.readyToActivate, false);
  assert.equal(view.activated, false);
  assert.deepEqual(
    view.specialists.map((profile) => profile.name),
    [
      'Source Social Media Manager',
      'Source Content Marketer',
      'Source Image Maker',
      'Source Email Marketer',
      'Source Video Scriptwriter',
      'Source Ad Copywriter',
    ],
  );
  assert.deepEqual(
    view.externalProfiles.map((profile) => ({
      name: profile.name,
      status: profile.statusLabel,
      callable: profile.callableLabel,
    })),
    [
      { name: 'Content Marketer', status: 'Awaiting founder export', callable: 'Not callable' },
      { name: 'Image Maker', status: 'Awaiting founder export', callable: 'Not callable' },
      { name: 'Social Media Manager', status: 'Awaiting founder export', callable: 'Not callable' },
    ],
  );
  assert.deepEqual(
    view.gates.map((gate) => [gate.gateId, gate.stateLabel, gate.passes]),
    [
      ['source', 'Source proof fresh', true],
      ['ownership', 'Approved', true],
      ['privacy', 'Approved', true],
      ['brand', 'Awaiting review', false],
      ['evaluation', 'Not passed', false],
      ['visual_policy', 'Conflict quarantined', false],
    ],
  );
  assert.equal(view.conflict?.title, 'Panther imagery vs no-animal visual rule');
});

test('Brand Brain view is distinctly Property Predator, read-only and transparent about the fixture', () => {
  const html = renderBrandBrainBody(presentBrandBrain(createPropertyPredatorBrandBrainFixture()));

  assert.match(html, /Reuse the brain/);
  assert.match(html, /PROVIDER EFFECTS OFF/);
  assert.match(html, /Metadata only/);
  assert.match(html, /Illustrative metadata fixture/);
  assert.match(html, /Six owned roles share one reviewed Brand Brain/);
  assert.match(html, /Content Marketer/);
  assert.match(html, /Image Maker/);
  assert.match(html, /Social Media Manager/);
  assert.match(html, /Panther imagery vs no-animal visual rule/);
  assert.match(html, /No review or activation command/);
  assert.match(html, new RegExp(`href="${BRAND_BRAIN_ROUTE}" aria-current="page"`));
  assert.doesNotMatch(html, /<form\b|method="post"|Publish now|Generate now|Activate now|Connect provider/i);
  assert.doesNotMatch(html, /api[_ -]?key|bearer\s|database_url|storage key:/i);
});

test('Brand Brain presenter allowlists metadata and drops unrecognised prompt, path and secret fields', () => {
  const fixture = createPropertyPredatorBrandBrainFixture();
  const poisoned = {
    ...fixture,
    workspace: { ...fixture.workspace, workspaceName: '<script>owned</script>' },
    brain: {
      ...fixture.brain,
      sources: [{
        ...fixture.brain.sources[0]!,
        path: 'private/prompts/system.md',
        rawPrompt: 'DO-NOT-RENDER-RAW-PROMPT',
        storageKey: 'DO-NOT-RENDER-STORAGE-KEY',
      }],
      specialists: [{
        ...fixture.brain.specialists[0]!,
        instructions: 'DO-NOT-RENDER-INSTRUCTIONS',
        knowledgeBytes: 'DO-NOT-RENDER-KNOWLEDGE',
      }],
    },
  } as unknown as PortalBrandBrainSnapshot;
  const view = presentBrandBrain(poisoned);
  const encoded = JSON.stringify(view);
  const html = renderBrandBrainBody(view);

  assert.doesNotMatch(encoded, /DO-NOT-RENDER|private\/prompts/);
  assert.doesNotMatch(html, /DO-NOT-RENDER|private\/prompts|<script>owned<\/script>/);
  assert.match(html, /&lt;script&gt;owned&lt;\/script&gt;/);
});

test('Brand Brain fails closed if provider effects or external GPT callability are asserted', () => {
  const fixture = createPropertyPredatorBrandBrainFixture();
  assert.throws(
    () => presentBrandBrain({
      ...fixture,
      brain: { ...fixture.brain, providerEffects: true },
    } as unknown as PortalBrandBrainSnapshot),
    BrandBrainPresentationError,
  );
  assert.throws(
    () => presentBrandBrain({
      ...fixture,
      externalProfiles: [{ ...fixture.externalProfiles[0]!, callable: true }],
    } as unknown as PortalBrandBrainSnapshot),
    /founder-export boundary/,
  );
});

test('Brand Brain actions are allowlisted GET navigation and content subnav marks one exact tab current', () => {
  assert.equal(brandBrainReadOnlyActionHref('content_library'), '/portal/content');
  assert.equal(brandBrainReadOnlyActionHref('founder_exports'), '/portal/content/brain#founder-exports');
  assert.equal(brandBrainReadOnlyActionHref('quarantine'), '/portal/content/brain#quarantine');

  const library = renderContentWorkspaceNavigation('library', { brandBrainAvailable: true });
  const brain = renderContentWorkspaceNavigation('brain', { brandBrainAvailable: true });
  const create = renderContentWorkspaceNavigation('create', { brandBrainAvailable: true });
  assert.match(library, /href="\/portal\/content" aria-current="page"/);
  assert.doesNotMatch(library, /href="\/portal\/content\/brain" aria-current="page"/);
  assert.match(brain, /href="\/portal\/content\/brain" aria-current="page"/);
  assert.doesNotMatch(brain, /href="\/portal\/content" aria-current="page"/);
  assert.match(create, /href="\/portal\/campaigns\/new" data-content-action="create" aria-current="page"/);
  assert.match(create, /href="\/portal\/social\/accounts"/);
  assert.doesNotMatch(create, /href="\/portal\/providers\/readiness"/);
  const readinessComposed = renderContentWorkspaceNavigation('create', {
    brandBrainAvailable: true,
    providerReadinessAvailable: true,
  });
  assert.match(readinessComposed, /href="\/portal\/providers\/readiness"/);
  assert.doesNotMatch(`${library}${brain}${create}`, /<form\b|method="post"/i);
});
