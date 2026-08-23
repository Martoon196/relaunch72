import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  subscriptionFromEvent, planResolver, isActive,
  memorySubscriptionStore, fileSubscriptionStore,
  type Subscription,
} from '../src/server/subscriptions.js';
import { createSubscriptionCheckout, CheckoutError, type StripeLike, type StripeEvent } from '../src/server/stripe.js';
import { provisionPlans, PLANS, type StripeCatalogLike } from '../src/server/catalog.js';
import { loadStripeConfig, type StripeConfig } from '../src/server/config.js';

function cfg(over: Partial<StripeConfig> = {}): StripeConfig {
  return { ...loadStripeConfig({} as NodeJS.ProcessEnv), secretKey: 'sk_test_x', keyMode: 'test', planIds: { platform_starter: 'price_ps', platform_growth: 'price_pg', platform_pro: 'price_pp' }, publicBaseUrl: 'https://relaunch72.test', ...over };
}
function fakeStripe(created: Array<Record<string, unknown>>): StripeLike {
  return {
    checkout: { sessions: { create: async (p) => { created.push(p); return { id: 'cs_sub_1', url: 'https://pay.stripe.test/cs_sub_1' }; } } },
    webhooks: { constructEvent: (raw) => JSON.parse(raw.toString()) as StripeEvent },
  };
}

const RESOLVE = planResolver({ platform_growth: 'price_pg' });

// ─── event → subscription mapping ────────────────────────────────────────────
test('subscriptionFromEvent maps a created subscription with plan, period end and email', () => {
  const ev: StripeEvent = { type: 'customer.subscription.created', data: { object: {
    id: 'sub_1', customer: 'cus_9', status: 'active', current_period_end: 1_800_000_000,
    items: { data: [{ price: { id: 'price_pg' } }] }, metadata: { email: 'Owner@Biz.CO' },
  } } };
  const s = subscriptionFromEvent(ev, 'T', RESOLVE)!;
  assert.equal(s.subscription_id, 'sub_1');
  assert.equal(s.customer_id, 'cus_9');
  assert.equal(s.status, 'active');
  assert.equal(s.plan, 'platform_growth');      // resolved from price id
  assert.equal(s.email, 'owner@biz.co');         // lower-cased
  assert.equal(s.current_period_end, new Date(1_800_000_000_000).toISOString());
});

test('subscriptionFromEvent keeps the raw price id when no plan resolver matches', () => {
  const ev: StripeEvent = { type: 'customer.subscription.updated', data: { object: {
    id: 'sub_2', status: 'active', items: { data: [{ price: { id: 'price_unknown' } }] },
  } } };
  assert.equal(subscriptionFromEvent(ev, 'T', RESOLVE)!.plan, 'price_unknown');
});

test('subscriptionFromEvent reads current_period_end off the item (newer API shape)', () => {
  const ev: StripeEvent = { type: 'customer.subscription.updated', data: { object: {
    id: 'sub_np', status: 'active', items: { data: [{ price: { id: 'price_pg' }, current_period_end: 1_700_000_000 }] },
  } } };
  assert.equal(subscriptionFromEvent(ev, 'T', RESOLVE)!.current_period_end, new Date(1_700_000_000_000).toISOString());
});

test('subscriptionFromEvent maps a deleted subscription as canceled', () => {
  const ev: StripeEvent = { type: 'customer.subscription.deleted', data: { object: { id: 'sub_3', status: 'canceled', items: { data: [] } } } };
  assert.equal(subscriptionFromEvent(ev, 'T')!.status, 'canceled');
});

test('subscriptionFromEvent: invoice.paid → active, invoice.payment_failed → past_due, linked by subscription id', () => {
  const paid: StripeEvent = { type: 'invoice.paid', data: { object: { subscription: 'sub_4', customer: 'cus_1', customer_email: 'a@b.co' } } };
  const p = subscriptionFromEvent(paid, 'T')!;
  assert.equal(p.subscription_id, 'sub_4');
  assert.equal(p.status, 'active');
  assert.equal(p.email, 'a@b.co');

  const failed: StripeEvent = { type: 'invoice.payment_failed', data: { object: { subscription: 'sub_4', customer_email: 'a@b.co' } } };
  assert.equal(subscriptionFromEvent(failed, 'T')!.status, 'past_due');
});

test('subscriptionFromEvent reads the newer invoice.parent subscription link', () => {
  const ev: StripeEvent = { type: 'invoice.paid', data: { object: { parent: { subscription_details: { subscription: 'sub_5' } } } } };
  assert.equal(subscriptionFromEvent(ev, 'T')!.subscription_id, 'sub_5');
});

test('subscriptionFromEvent returns null for a one-off invoice and for unrelated events', () => {
  assert.equal(subscriptionFromEvent({ type: 'invoice.paid', data: { object: { subscription: null } } }, 'T'), null);
  assert.equal(subscriptionFromEvent({ type: 'checkout.session.completed', data: { object: { id: 'cs' } } }, 'T'), null);
  assert.equal(subscriptionFromEvent({ type: 'customer.subscription.created', data: { object: {} } }, 'T'), null); // no id
});

test('unknown Stripe statuses normalise to incomplete (never crash)', () => {
  const ev: StripeEvent = { type: 'customer.subscription.updated', data: { object: { id: 'sub_x', status: 'weird_new_status', items: { data: [] } } } };
  assert.equal(subscriptionFromEvent(ev, 'T')!.status, 'incomplete');
});

// ─── isActive ────────────────────────────────────────────────────────────────
test('isActive is true only for active/trialing', () => {
  const base: Subscription = { subscription_id: 's', customer_id: null, email: null, plan: null, status: 'active', current_period_end: null, updated_at: 'T' };
  assert.equal(isActive({ ...base, status: 'active' }), true);
  assert.equal(isActive({ ...base, status: 'trialing' }), true);
  assert.equal(isActive({ ...base, status: 'past_due' }), false);
  assert.equal(isActive({ ...base, status: 'canceled' }), false);
  assert.equal(isActive(null), false);
});

// ─── stores (merge + email index) ────────────────────────────────────────────
function subOf(id: string, over: Partial<Subscription> = {}): Subscription {
  return { subscription_id: id, customer_id: null, email: null, plan: null, status: 'active', current_period_end: null, updated_at: 'T', ...over };
}

for (const [label, make] of [
  ['memory', () => memorySubscriptionStore()],
  ['file', () => fileSubscriptionStore(path.join(os.tmpdir(), `r72-subtest-${process.pid}-${Math.round(performance.now())}-${Math.random().toString(36).slice(2)}.jsonl`))],
] as const) {
  test(`${label} store: upsert-merge keeps the plan/period a thinner invoice event lacks`, () => {
    const store = make();
    store.record(subOf('sub_1', { plan: 'platform_growth', email: 'x@y.co', current_period_end: '2026-09-01T00:00:00.000Z', status: 'active', updated_at: 'T1' }));
    // A later invoice.payment_failed carries no plan/period — must not wipe them.
    const merged = store.record(subOf('sub_1', { status: 'past_due', email: 'x@y.co', updated_at: 'T2' }));
    assert.equal(merged.status, 'past_due');
    assert.equal(merged.plan, 'platform_growth');
    assert.equal(merged.current_period_end, '2026-09-01T00:00:00.000Z');
    assert.equal(store.find('sub_1')?.status, 'past_due');
  });

  test(`${label} store: findByEmail is case-insensitive and returns the newest`, () => {
    const store = make();
    store.record(subOf('sub_a', { email: 'boss@acme.co', status: 'active', updated_at: '2026-01-01T00:00:00Z' }));
    store.record(subOf('sub_b', { email: 'BOSS@acme.co', status: 'canceled', updated_at: '2026-02-01T00:00:00Z' }));
    const found = store.findByEmail('Boss@Acme.CO');
    assert.equal(found?.subscription_id, 'sub_b'); // newest updated_at wins
    assert.equal(store.findByEmail('nobody@nowhere.co'), null);
  });
}

test('file store survives a reopen (persists across processes)', () => {
  const f = path.join(os.tmpdir(), `r72-subpersist-${process.pid}-${Math.round(performance.now())}.jsonl`);
  fileSubscriptionStore(f).record(subOf('sub_p', { email: 'keep@me.co', status: 'active' }));
  assert.equal(fileSubscriptionStore(f).findByEmail('keep@me.co')?.subscription_id, 'sub_p');
  fs.rmSync(f, { force: true });
});

// ─── subscription checkout ───────────────────────────────────────────────────
test('createSubscriptionCheckout builds a subscription-mode session with plan/email metadata', async () => {
  const created: Array<Record<string, unknown>> = [];
  const { url } = await createSubscriptionCheckout(fakeStripe(created), cfg(), { plan: 'platform_growth', email: 'buyer@co.uk' });
  assert.equal(url, 'https://pay.stripe.test/cs_sub_1');
  const p = created[0]!;
  assert.equal(p.mode, 'subscription');
  assert.deepEqual(p.line_items, [{ price: 'price_pg', quantity: 1 }]);
  assert.equal(p.customer_email, 'buyer@co.uk');
  assert.deepEqual(p.subscription_data, { metadata: { plan: 'platform_growth', email: 'buyer@co.uk' } });
  assert.match(String(p.success_url), /\/portal\?plan=platform_growth/);
});

test('createSubscriptionCheckout omits customer_email when none is given', async () => {
  const created: Array<Record<string, unknown>> = [];
  await createSubscriptionCheckout(fakeStripe(created), cfg(), { plan: 'platform_starter' });
  assert.equal(created[0]!.customer_email, undefined);
  assert.deepEqual(created[0]!.subscription_data, { metadata: { plan: 'platform_starter' } });
});

test('createSubscriptionCheckout refuses an unknown or unconfigured plan', async () => {
  await assert.rejects(() => createSubscriptionCheckout(fakeStripe([]), cfg(), { plan: 'nope' }), CheckoutError);
  await assert.rejects(() => createSubscriptionCheckout(fakeStripe([]), cfg({ planIds: { platform_starter: '' } }), { plan: 'platform_starter' }), CheckoutError);
});

// ─── plan provisioning ───────────────────────────────────────────────────────
test('provisionPlans creates recurring monthly prices, one per plan', async () => {
  const prices: Array<Record<string, unknown>> = [];
  const stripe: StripeCatalogLike = {
    products: { create: async () => ({ id: 'prod_x' }) },
    prices: {
      create: async (p) => { prices.push(p); return { id: `price_${prices.length}` }; },
      list: async () => ({ data: [] }), // nothing exists yet
    },
  };
  const r = await provisionPlans(stripe);
  assert.equal(r.created.length, PLANS.length);
  assert.equal(prices.length, PLANS.length);
  for (const p of prices) assert.deepEqual(p.recurring, { interval: 'month' });
  assert.ok(r.priceIds.platform_growth);
});

test('provisionPlans reuses an existing price by lookup_key (idempotent)', async () => {
  let creates = 0;
  const stripe: StripeCatalogLike = {
    products: { create: async () => { creates++; return { id: 'prod_x' }; } },
    prices: {
      create: async () => { creates++; return { id: 'price_new' }; },
      list: async (q) => ({ data: [{ id: 'price_existing', lookup_key: String((q.lookup_keys as string[])[0]) }] }),
    },
  };
  const r = await provisionPlans(stripe);
  assert.equal(creates, 0, 'nothing created when every lookup_key already exists');
  assert.equal(r.reused.length, PLANS.length);
});
