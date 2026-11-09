import assert from 'node:assert/strict';
import test from 'node:test';

import { createPropertyPredatorImageStudioFixture } from '../src/portal/image-studio-fixtures.js';
import { presentImageStudio } from '../src/portal/image-studio-presenter.js';
import { renderImageStudioBody } from '../src/portal/image-studio-view.js';

test('image studio remains fail-closed while provider effects are dark', () => {
  const view = presentImageStudio(createPropertyPredatorImageStudioFixture());

  assert.equal(view.model, 'gpt-image-2');
  assert.equal(view.generateAvailable, false);
  assert.equal(view.gateLabel, 'Emergency pause is ON');
  assert.equal(view.daily.remaining, 13);
  assert.equal(view.concurrency.remaining, 1);
  assert.equal(view.spend.remaining, 1_079);
});

test('image studio view is honest about preview, effects and approval boundaries', () => {
  const html = renderImageStudioBody(presentImageStudio(createPropertyPredatorImageStudioFixture()));

  assert.match(html, /Image <em>Studio\.<\/em>/);
  assert.match(html, /href="\/portal\/content\/images" aria-current="page">Image Studio/);
  assert.match(html, /gpt-image-2/);
  assert.match(html, /data-provider-effects="none"/);
  assert.match(html, /Effects OFF · emergency pause ON/);
  assert.match(html, /Structured composition preview/);
  assert.match(html, /Generate review proposal · locked/);
  assert.match(html, /disabled aria-disabled="true"/);
  assert.match(html, /Apply the supplied real logo/);
  assert.match(html, /generated output requires human approval/i);
  assert.doesNotMatch(html, /publish now/i);
});

test('image studio clamps unsafe gauge input', () => {
  const fixture = createPropertyPredatorImageStudioFixture();
  const view = presentImageStudio({
    ...fixture,
    usage: {
      ...fixture.usage,
      dayUsed: Number.NaN,
      dayLimit: -2,
      concurrentUsed: 99,
      concurrentLimit: 3,
    },
  });

  assert.equal(view.daily.used, 0);
  assert.equal(view.daily.limit, 1);
  assert.equal(view.concurrency.used, 3);
  assert.equal(view.concurrency.remaining, 0);
});

test('image studio requires at least one exact approved real-logo reference', () => {
  const fixture = createPropertyPredatorImageStudioFixture();
  const view = presentImageStudio({
    ...fixture,
    effects: {
      generationEnabled: true,
      providerEffectsEnabled: true,
      emergencyPaused: false,
      commandBoundaryAvailable: true,
    },
    references: fixture.references.filter((reference) => reference.kind !== 'logo'),
  });

  assert.equal(view.generateAvailable, false);
  assert.equal(view.gateLabel, 'Brand evidence is incomplete');
});

test('projected capability cannot manufacture a portal command boundary', () => {
  const fixture = createPropertyPredatorImageStudioFixture();
  const view = presentImageStudio({
    ...fixture,
    effects: {
      generationEnabled: true,
      providerEffectsEnabled: true,
      emergencyPaused: false,
      commandBoundaryAvailable: true,
    },
  });
  const html = renderImageStudioBody(view);

  assert.equal(view.effects.commandBoundaryAvailable, false);
  assert.equal(view.generateAvailable, false);
  assert.equal(view.gateLabel, 'Command boundary not connected');
  assert.match(html, /data-command-boundary="absent"/);
  assert.match(html, /Generate review proposal · locked/);
  assert.match(html, /disabled aria-disabled="true"/);
});
