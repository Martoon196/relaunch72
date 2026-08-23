import test from 'node:test';
import assert from 'node:assert/strict';
import { makeBilling, planOptions, planNameFor } from '../src/portal/billing.js';
import { billingPage } from '../src/portal/views.js';
import { memorySubscriptionStore } from '../src/server/subscriptions.js';
import { PLANS } from '../src/server/catalog.js';

test('planOptions exposes every plan with a price label', () => {
  const opts = planOptions();
  assert.equal(opts.length, PLANS.length);
  for (const o of opts) assert.match(o.priceLabel, /^\$\d+\/(mo|yr)$/);
  assert.equal(planNameFor('platform_growth'), PLANS.find((p) => p.key === 'platform_growth')!.name);
  assert.equal(planNameFor(null), null);
  assert.equal(planNameFor('price_unmapped'), 'price_unmapped'); // falls back to the raw value
});

test('makeBilling resolves an active subscription for a tenant via email', async () => {
  const subs = memorySubscriptionStore();
  subs.record({ subscription_id: 'sub_1', customer_id: 'cus_1', email: 'boss@acme.co', plan: 'platform_growth', status: 'active', current_period_end: '2026-09-01T00:00:00.000Z', updated_at: 'T' });
  const billing = makeBilling(subs, async (tid) => (tid === 't1' ? 'boss@acme.co' : null));

  const v = await billing('t1');
  assert.equal(v.active, true);
  assert.equal(v.status, 'active');
  assert.equal(v.planKey, 'platform_growth');
  assert.equal(v.planName, PLANS.find((p) => p.key === 'platform_growth')!.name);
  assert.equal(v.customerId, 'cus_1');
  assert.equal(v.currentPeriodEnd, '2026-09-01T00:00:00.000Z');
  assert.ok(v.options.length > 0);
});

test('makeBilling returns status none for a tenant with no subscription', async () => {
  const billing = makeBilling(memorySubscriptionStore(), async () => 'nobody@nowhere.co');
  const v = await billing('t1');
  assert.equal(v.status, 'none');
  assert.equal(v.active, false);
  assert.equal(v.planKey, null);
  assert.ok(v.options.length > 0); // can still see plans to subscribe to
});

test('makeBilling handles a tenant with no email (no account) gracefully', async () => {
  const billing = makeBilling(memorySubscriptionStore(), async () => null);
  const v = await billing('t-orphan');
  assert.equal(v.status, 'none');
  assert.equal(v.email, null);
});

test('billingPage marks the current plan and shows a manage button only when allowed', () => {
  const active = { status: 'active' as const, active: true, planKey: 'platform_growth', planName: 'Growth', currentPeriodEnd: '2026-09-01T00:00:00.000Z', customerId: 'cus_1', email: 'boss@acme.co', options: planOptions() };
  const withManage = billingPage('Acme', active, { canManage: true });
  assert.match(withManage, /Your current plan/);
  assert.match(withManage, /action="\/portal\/manage"/);
  assert.match(withManage, /renews 2026-09-01/);
  assert.doesNotMatch(withManage, /action="\/portal\/subscribe"/);
  assert.match(withManage, /Use Manage billing/);

  const noManage = billingPage('Acme', active, { canManage: false });
  assert.doesNotMatch(noManage, /action="\/portal\/manage"/);
});

test('billingPage only shows subscribe CTAs when checkout is explicitly enabled', () => {
  const none = { status: 'none' as const, active: false, planKey: null, planName: null, currentPeriodEnd: null, customerId: null, email: 'x@y.co', options: planOptions() };
  const html = billingPage('Acme', none, { canSubscribe: true, notice: 'A subscription is needed to run your marketing.' });
  assert.match(html, /Choose a plan/);
  assert.match(html, /Subscribe →/);
  assert.match(html, /A subscription is needed/);
  assert.doesNotMatch(html, /Your current plan/);

  const preview = billingPage('Acme', none);
  assert.match(preview, /Plan preview only/);
  assert.match(preview, /Checkout paused/);
  assert.doesNotMatch(preview, /action="\/portal\/subscribe"/);
});
