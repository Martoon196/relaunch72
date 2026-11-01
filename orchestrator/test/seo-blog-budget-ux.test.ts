import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { BudgetExceededError, USAGE_ESTIMATES } from '../src/seo-blog/engine.js';
import { publishingPage, setupPage, type Shell } from '../src/portal/seo-blog-view.js';
import { harness, OWNER } from './seo-blog-fixtures.js';

async function brandFixture(ceiling: number, used = 0) {
  const h = harness();
  const { brand } = await h.engine.createBrand(OWNER, { commandId: randomUUID(), name: 'Owner brand', website: 'https://owner.example' });
  await h.engine.updateSettings(OWNER, brand.id, brand.rowVersion, { budgets: { modelTokensPerMonth: ceiling, searchCallsPerMonth: 0, imagesPerMonth: 0 } });
  await h.engine.uploadKnowledge(OWNER, brand.id, { category: 'brand_guidelines', title: 'Guidance', pastedText: 'We explain practical letting steps in plain English.' });
  if (used) await h.store.recordUsage({ brandId: brand.id, kind: 'model_tokens', amount: used, at: h.clock.now(), reference: 'fixture-existing-usage' });
  return { h, brand: await h.engine.getBrand(OWNER, brand.id) };
}
function shell(brand: Awaited<ReturnType<typeof brandFixture>>['brand']): Shell {
  return { brand, brands: [brand], tab: 'setup', csrf: 'fixture', notice: null, error: null };
}
async function setup(f: Awaited<ReturnType<typeof brandFixture>>) {
  return setupPage(shell(f.brand), { documents: await f.h.engine.listKnowledge(OWNER, f.brand.id), profile: null, inventory: null, destinations: [], publishers: [], vaultReady: true, usage: await f.h.engine.usage(OWNER, f.brand.id) });
}
test('zero ceiling, exhausted ceiling and insufficient headroom have distinct accurate budget reasons before any provider call', async () => {
  for (const [ceiling, used, reason] of [[0, 0, 'not configured'], [10_000, 10_000, 'monthly ceiling reached'], [10_000, 0, 'insufficient headroom']] as const) {
    const f = await brandFixture(ceiling, used);
    await assert.rejects(f.h.engine.extractBrandProfile(OWNER, f.brand.id), error => {
      assert.ok(error instanceof BudgetExceededError); assert.equal(error.code, 'budget_exceeded');
      assert.ok(error.message.includes(reason)); assert.ok(error.message.includes(`Used ${used.toLocaleString('en-GB')}`));
      assert.match(error.message, /Action estimate 14,000/); assert.ok(error.message.includes(`Minimum estimated monthly ceiling ${(used + 14_000).toLocaleString('en-GB')}`));
      return true;
    });
    assert.equal(f.h.llm.calls.length, 0); assert.equal(f.h.search.calls, 0);
    assert.equal((await f.h.engine.getBrand(OWNER, f.brand.id)).settings.budgets.modelTokensPerMonth, ceiling);
  }
});
test('profile panel explains the actual zero-used10k ceiling14k estimate4k shortfall and links to its own writing setting', async () => {
  const f = await brandFixture(10_000); const html = await setup(f);
  for (const text of ['Used 0', 'Monthly ceiling 10,000', 'Remaining 10,000', 'estimate: 14,000', 'Shortfall: 4,000', 'monthly ceiling for this action: 14,000']) assert.ok(html.includes(text), text);
  assert.ok(html.includes(`/b/${f.brand.id}/publishing#writing-budget`));
  assert.match(html, /disabled aria-describedby="profile-budget-help"/);
  assert.doesNotMatch(html, /budget for this brand is used up/);
  const other = await brandFixture(1_000_000, 2_500); const otherHtml = await setup(other);
  assert.match(otherHtml, /Used 2,500/); assert.match(otherHtml, /Remaining 997,500/);
  assert.doesNotMatch(otherHtml, /disabled aria-describedby="profile-budget-help"/);
});
test('headroom uses current UTC calendar-month recorded usage; the unchanged14k preflight permits only an owner-saved sufficient ceiling', async () => {
  const f = await brandFixture(17_000, 3_000);
  await f.h.store.recordUsage({ brandId: f.brand.id, kind: 'model_tokens', amount: 50_000, at: '2026-10-31T23:59:59.000Z', reference: 'fixture-previous-month' });
  assert.equal((await f.h.engine.usage(OWNER, f.brand.id)).model_tokens, 3_000);
  assert.equal(USAGE_ESTIMATES.profile, 14_000);
  await f.h.engine.extractBrandProfile(OWNER, f.brand.id);
  assert.deepEqual(f.h.llm.calls, ['SEO_BLOG_PROFILE']);
});
test('saved toggle states have text, colour classes and switch semantics; examples do not become prices or automatic credit purchases', async () => {
  const f = await brandFixture(1_000_000);
  const brand = { ...f.brand, settings: { ...f.brand.settings, autoPublish: false, pauseAll: false, ongoingProduction: true, autoAcceptPlans: true } };
  const html = publishingPage({ ...shell(brand), tab: 'publishing' }, { usage: { model_tokens: 0, search_calls: 0, images: 0 } });
  assert.match(html, /toggle-state on">On/); assert.match(html, /toggle-state off">Off/);
  assert.match(html, /aria-checked="true" aria-label="Ongoing production: On\. Turn off"/);
  assert.match(html, /aria-checked="false" aria-label="Automatic publishing: Off\. Turn on"/);
  assert.match(html, /name="name" value="ongoingProduction"><input type="hidden" name="value" value="0"/);
  assert.match(html, /name="name" value="autoPublish"><input type="hidden" name="value" value="1"/);
  assert.match(html, /input and output usage together/); assert.match(html, /00:00 UTC/); assert.match(html, /not a wallet or purchased Relaunch72 credits/);
  assert.match(html, /Provider-cost example only/); assert.match(html, /US\$0\.09/); assert.match(html, /platform\.claude\.com\/docs\/en\/about-claude\/pricing/);
  assert.match(html, /Total tokens alone do not determine the cost/);
});
