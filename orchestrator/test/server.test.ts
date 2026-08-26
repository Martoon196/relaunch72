import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createCheckoutSession, priceKeyFor, orderFromEvent, CheckoutError, type StripeLike, type StripeEvent } from '../src/server/stripe.js';
import { loadStripeConfig, type StripeConfig } from '../src/server/config.js';
import {
  fileOrderStore, fileWebhookReceiptStore, memoryWebhookReceiptStore,
  type Order, type OrderStore,
} from '../src/server/orders.js';
import { memorySubscriptionStore } from '../src/server/subscriptions.js';
import { createApp } from '../src/server/app.js';
import { PROPERTY_PREDATOR_MAILGUN_WEBHOOK_PATH } from '../src/integrations/mailgun-webhook/router.js';
import { validIntake } from './helpers.js';

function cfg(over: Partial<StripeConfig> = {}): StripeConfig {
  return {
    secretKey: 'sk_test_x', keyMode: 'test', webhookSecret: 'whsec_x',
    priceIds: { autopsy: 'price_a', core: 'price_c', core_bump: 'price_cb', pro: 'price_p' },
    planIds: { platform_starter: 'price_ps', platform_growth: 'price_pg', platform_pro: 'price_pp' },
    platformSubscriptionsEnabled: false,
    sandboxAccessToken: '',
    publicLeadCaptureEnabled: true,
    publicBaseUrl: 'https://relaunch72.test', host: '127.0.0.1', port: 4242, liveMode: false,
    dataDir: os.tmpdir(),
    ordersFile: path.join(os.tmpdir(), `r72-orders-${process.pid}-${Math.round(performance.now())}.jsonl`),
    subscriptionsFile: path.join(os.tmpdir(), `r72-subs-${process.pid}-${Math.round(performance.now())}.jsonl`),
    allowedOrigins: ['https://relaunch72.com', 'http://localhost:8080'],
    adminPassword: '', sessionSecret: 'test-secret',
    ...over,
  };
}

function fakeStripe(created: Array<Record<string, unknown>>, opts: { url?: string | null } = {}): StripeLike {
  return {
    checkout: { sessions: { create: async (p) => { created.push(p); return { id: 'cs_test_1', url: opts.url === undefined ? 'https://pay.stripe.test/cs_test_1' : opts.url }; } } },
    webhooks: { constructEvent: (raw, sig) => { if (sig === 'bad') throw new Error('bad sig'); return JSON.parse(raw.toString()) as StripeEvent; } },
  };
}

// ─── pure logic ──────────────────────────────────────────────────────────────
test('priceKeyFor: core + bump collapses to core_bump; others map 1:1', () => {
  assert.equal(priceKeyFor({ tier: 'core', bump: true }), 'core_bump');
  assert.equal(priceKeyFor({ tier: 'core' }), 'core');
  assert.equal(priceKeyFor({ tier: 'pro', bump: true }), 'pro');
});

test('createCheckoutSession builds the right Stripe params and returns the URL', async () => {
  const created: Array<Record<string, unknown>> = [];
  const { url } = await createCheckoutSession(fakeStripe(created), cfg(), { tier: 'core', bump: true });
  assert.equal(url, 'https://pay.stripe.test/cs_test_1');
  const p = created[0]!;
  assert.equal(p.mode, 'payment');
  assert.deepEqual(p.line_items, [{ price: 'price_cb', quantity: 1 }]);
  assert.match(String(p.success_url), /\/intake\/\?tier=core&session=\{CHECKOUT_SESSION_ID\}/);
  assert.deepEqual(p.metadata, { tier: 'core', bump: '1' });
});

test('createCheckoutSession refuses an unknown or unconfigured tier', async () => {
  await assert.rejects(() => createCheckoutSession(fakeStripe([]), cfg(), { tier: 'nope' }), CheckoutError);
  await assert.rejects(() => createCheckoutSession(fakeStripe([]), cfg(), { tier: 'core_bump' }), CheckoutError);
  await assert.rejects(() => createCheckoutSession(fakeStripe([]), cfg(), { tier: 'pro', bump: true }), CheckoutError);
  await assert.rejects(() => createCheckoutSession(fakeStripe([]), cfg({ priceIds: { core: '' } }), { tier: 'core' }), CheckoutError);
});

test('orderFromEvent maps a completed checkout; ignores other events', () => {
  const ev: StripeEvent = { type: 'checkout.session.completed', data: { object: { id: 'cs_1', mode: 'payment', payment_status: 'paid', amount_total: 99700, currency: 'usd', metadata: { tier: 'core', bump: '1' }, customer_details: { email: 'a@b.com' } } } };
  const o = orderFromEvent(ev, 'T')!;
  assert.equal(o.session_id, 'cs_1');
  assert.equal(o.tier, 'core');
  assert.equal(o.bump, true);
  assert.equal(o.email, 'a@b.com');
  assert.equal(o.status, 'paid_awaiting_intake');
  assert.equal(orderFromEvent({ type: 'payment_intent.created' }, 'T'), null);
});

test('orderFromEvent refuses unpaid and subscription-mode Checkout Sessions', () => {
  const session = { id: 'cs_1', mode: 'payment', payment_status: 'paid', metadata: { tier: 'core' } };
  assert.equal(orderFromEvent({ type: 'checkout.session.completed', data: { object: { ...session, payment_status: 'unpaid' } } }, 'T'), null);
  assert.equal(orderFromEvent({ type: 'checkout.session.completed', data: { object: { ...session, mode: 'subscription' } } }, 'T'), null);
  assert.equal(orderFromEvent({ type: 'checkout.session.completed', data: { object: { ...session, id: '' } } }, 'T'), null);
  assert.equal(orderFromEvent({ type: 'checkout.session.completed', data: { object: { ...session, metadata: {} } } }, 'T'), null);
  assert.equal(orderFromEvent({ type: 'checkout.session.completed', data: { object: { ...session, metadata: { tier: 'mystery' } } } }, 'T'), null);
  assert.equal(orderFromEvent({ type: 'checkout.session.completed', data: { object: { ...session, metadata: { tier: 'pro', bump: '1' } } } }, 'T'), null);
});

test('fileOrderStore records, finds, and updates by session', () => {
  const f = path.join(os.tmpdir(), `r72-os-${process.pid}-${Math.round(performance.now())}.jsonl`);
  const store = fileOrderStore(f);
  const order: Order = { session_id: 'cs_9', tier: 'core', bump: false, email: null, amount_total: 99700, currency: 'usd', status: 'paid_awaiting_intake', paid_at: 'T' };
  store.record(order);
  assert.equal(store.find('cs_9')?.status, 'paid_awaiting_intake');
  store.update('cs_9', { status: 'building', run_dir: '/runs/x' });
  assert.equal(store.find('cs_9')?.status, 'building');
  assert.equal(store.find('cs_9')?.run_dir, '/runs/x');
  assert.equal(store.find('nope'), null);
  fs.rmSync(f, { force: true });
});

test('fileWebhookReceiptStore persists event replay receipts across reopen', () => {
  const f = path.join(os.tmpdir(), `r72-webhooks-${process.pid}-${Math.round(performance.now())}.jsonl`);
  const first = fileWebhookReceiptStore(f);
  assert.equal(first.has('evt_1'), false);
  assert.equal(first.record({ event_id: 'evt_1', type: 'checkout.session.completed', processed_at: 'T' }), true);
  assert.equal(fileWebhookReceiptStore(f).has('evt_1'), true);
  assert.equal(fileWebhookReceiptStore(f).record({ event_id: 'evt_1', type: 'checkout.session.completed', processed_at: 'T2' }), false);
  assert.equal(fs.readFileSync(f, 'utf8').trim().split('\n').length, 1);
  fs.rmSync(f, { force: true });
});

// ─── routes (fake req/res harness) ───────────────────────────────────────────
function req(method: string, url: string, body = '', headers: Record<string, string> = {}): IncomingMessage {
  const r = Readable.from([Buffer.from(body)]) as unknown as IncomingMessage;
  return Object.assign(r, { method, url, headers });
}
function res(): ServerResponse & { statusCode: number; _body: string; _headers: Record<string, string> } {
  const r = { statusCode: 0, _body: '', _headers: {} as Record<string, string> } as {
    statusCode: number; _body: string; _headers: Record<string, string>;
    setHeader: (k: string, v: string) => unknown;
    writeHead: (c: number, headers?: Record<string, string>) => unknown;
    end: (b?: string) => unknown;
  };
  r.setHeader = (k: string, v: string) => { r._headers[k.toLowerCase()] = v; return r; };
  r.writeHead = (c: number, headers = {}) => {
    r.statusCode = c;
    for (const [key, value] of Object.entries(headers)) r._headers[key.toLowerCase()] = value;
    return r;
  };
  r.end = (b?: string) => { r._body = b ?? ''; return r; };
  return r as unknown as ServerResponse & { statusCode: number; _body: string; _headers: Record<string, string> };
}
function memStore(): OrderStore & { data: Map<string, Order>; records: Order[] } {
  const data = new Map<string, Order>();
  const records: Order[] = [];
  return { data, records, record: (o) => { records.push(o); data.set(o.session_id, o); }, find: (id) => data.get(id) ?? null, update: (id, p) => { const c = data.get(id); if (!c) return null; const n = { ...c, ...p }; data.set(id, n); return n; } };
}
function app(over: Partial<Parameters<typeof createApp>[0]> = {}) {
  const created: Array<Record<string, unknown>> = [];
  const kicks: Array<{ session: string; product: string; through: string }> = [];
  const kickedIntakes: Array<Record<string, unknown>> = [];
  const store = memStore();
  const webhookReceipts = memoryWebhookReceiptStore();
  const handler = createApp({
    stripe: fakeStripe(created), cfg: cfg(), orders: store,
    kickPipeline: (_i, order, entitlement) => {
      kickedIntakes.push(_i);
      kicks.push({ session: order.session_id, product: entitlement.product, through: entitlement.through });
      return '/runs/kicked';
    },
    now: () => 'T', webhookReceipts, ...over,
  });
  return { handler, created, kicks, kickedIntakes, store, webhookReceipts };
}

test('GET /health reports test mode + configured', async () => {
  const { handler } = app(); const r = res();
  await handler(req('GET', '/health'), r);
  assert.equal(r.statusCode, 200);
  assert.deepEqual(JSON.parse(r._body), {
    ok: true,
    mode: 'test',
    configured: true,
    accepting_checkout: true,
    blockers: [],
    accepting_subscriptions: false,
    subscription_blockers: ['recurring platform subscriptions are preview-only and not accepting payment'],
    accepting_public_leads: false,
    build_mode: 'live',
    service_ready: true,
    service_readiness_blockers: [],
    portal_ready: false,
    portal_blockers: ['client portal is not mounted'],
  });
});

test('operational routes are pinned to the canonical host while probes remain available', async () => {
  const { handler } = app({ canonicalHost: 'hq.propertypredator.co.uk' });
  const wrong = res();
  await handler(req('GET', '/portal', '', { host: 'attacker.example' }), wrong);
  assert.equal(wrong.statusCode, 421);
  assert.deepEqual(JSON.parse(wrong._body), { error: 'misdirected request' });

  const health = res();
  await handler(req('GET', '/health', '', { host: 'render-internal.example' }), health);
  assert.equal(health.statusCode, 200);

  const canonical = res();
  await handler(req('GET', '/portal', '', { host: 'HQ.PROPERTYPREDATOR.CO.UK:443' }), canonical);
  assert.equal(canonical.statusCode, 404);
});

test('GET /ready fails closed until the secure portal is mounted', async () => {
  const { handler } = app({ portalBlockers: ['required PostgreSQL portal services did not pass readiness'] });
  const unavailable = res();
  await handler(req('GET', '/ready'), unavailable);
  assert.equal(unavailable.statusCode, 503);
  assert.deepEqual(JSON.parse(unavailable._body), {
    ready: false,
    blockers: ['required PostgreSQL portal services did not pass readiness'],
  });

  const mounted = app({ portal: {} as NonNullable<Parameters<typeof createApp>[0]['portal']> }).handler;
  const ready = res();
  await mounted(req('GET', '/ready'), ready);
  assert.equal(ready.statusCode, 200);
  assert.deepEqual(JSON.parse(ready._body), { ready: true, blockers: [] });
});

test('GET /ready fails closed on process-level production safety blockers', async () => {
  const { handler } = app({
    portal: {} as NonNullable<Parameters<typeof createApp>[0]['portal']>,
    serviceReadinessBlockers: ['Outbound Mailgun credential is forbidden in the public web process'],
  });
  const ready = res();
  await handler(req('GET', '/ready'), ready);
  assert.equal(ready.statusCode, 503);
  assert.deepEqual(JSON.parse(ready._body), {
    ready: false,
    blockers: ['Outbound Mailgun credential is forbidden in the public web process'],
  });
  const health = res();
  await handler(req('GET', '/health'), health);
  assert.equal(JSON.parse(health._body).service_ready, false);
});

test('GET /ready awaits the bounded live dependency probe while health stays liveness-only', async () => {
  let probes = 0;
  const { handler } = app({
    portal: {} as NonNullable<Parameters<typeof createApp>[0]['portal']>,
    runtimeReadinessProbe: async () => {
      probes += 1;
      return ['Protected PostgreSQL portal runtime is unavailable'];
    },
  });
  const health = res();
  await handler(req('GET', '/health'), health);
  assert.equal(health.statusCode, 200);
  assert.equal(probes, 0);

  const ready = res();
  await handler(req('GET', '/ready'), ready);
  assert.equal(ready.statusCode, 503);
  assert.equal(probes, 1);
  assert.deepEqual(JSON.parse(ready._body).blockers, [
    'Protected PostgreSQL portal runtime is unavailable',
  ]);
});

test('GET /ready fails closed when an enabled Property Predator bridge is degraded', async () => {
  const { handler } = app({
    portal: {} as NonNullable<Parameters<typeof createApp>[0]['portal']>,
    propertyPredatorExternalEvents: {
      enabled: true,
      ready: false,
      blockers: ['receipt store is unavailable'],
    },
  });
  const response = res();
  await handler(req('GET', '/ready'), response);
  assert.equal(response.statusCode, 503);
  assert.deepEqual(JSON.parse(response._body), {
    ready: false,
    blockers: ['Property Predator external events: receipt store is unavailable'],
  });
});

test('GET /ready and health expose an enabled but degraded Mailgun webhook without secrets', async () => {
  const { handler } = app({
    portal: {} as NonNullable<Parameters<typeof createApp>[0]['portal']>,
    propertyPredatorMailgunWebhook: {
      enabled: true,
      ready: false,
      blockers: ['protected receipt store is unavailable'],
    },
  });
  const ready = res();
  await handler(req('GET', '/ready'), ready);
  assert.equal(ready.statusCode, 503);
  assert.deepEqual(JSON.parse(ready._body), {
    ready: false,
    blockers: ['Mailgun webhook: protected receipt store is unavailable'],
  });

  const health = res();
  await handler(req('GET', '/health'), health);
  const status = JSON.parse(health._body);
  assert.deepEqual(status.property_predator_mailgun_webhook, {
    enabled: true,
    ready: false,
    blockers: ['protected receipt store is unavailable'],
  });
});

test('Mailgun webhook route is dark by default and delegates only when ready', async () => {
  const dark = app().handler;
  const hidden = res();
  await dark(req('POST', PROPERTY_PREDATOR_MAILGUN_WEBHOOK_PATH, '{}'), hidden);
  assert.equal(hidden.statusCode, 404);

  let calls = 0;
  const mounted = app({
    propertyPredatorMailgunWebhook: {
      enabled: true,
      ready: true,
      blockers: [],
      handle: async (_request, response) => {
        calls += 1;
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{"received":true}');
      },
    },
  }).handler;
  const accepted = res();
  await mounted(req('POST', PROPERTY_PREDATOR_MAILGUN_WEBHOOK_PATH, '{}'), accepted);
  assert.equal(accepted.statusCode, 200);
  assert.equal(calls, 1);
});

test('a required but unmounted portal returns a branded 503 and explicit health blocker', async () => {
  const { handler } = app({ portalBlockers: ['required PostgreSQL portal services did not pass readiness'] });
  const portal = res();
  await handler(req('GET', '/portal'), portal);
  assert.equal(portal.statusCode, 503);
  assert.match(portal._headers['content-type'] ?? '', /text\/html/);
  assert.match(portal._body, /temporarily unavailable/);
  assert.doesNotMatch(portal._body, /PostgreSQL|database|credential/i);

  const health = res();
  await handler(req('GET', '/health'), health);
  const status = JSON.parse(health._body) as Record<string, unknown>;
  assert.equal(status.portal_ready, false);
  assert.deepEqual(status.portal_blockers, ['required PostgreSQL portal services did not pass readiness']);
});

test('with no key: /health is up but unconfigured, and checkout/webhook 503 (deploys green)', async () => {
  const { handler } = app({ cfg: cfg({ secretKey: '' }) });
  const h = res();
  await handler(req('GET', '/health'), h);
  assert.equal(h.statusCode, 200);
  assert.equal(JSON.parse(h._body).configured, false);

  const c = res();
  await handler(req('POST', '/api/checkout', JSON.stringify({ tier: 'core' })), c);
  assert.equal(c.statusCode, 503);

  const w = res();
  await handler(req('POST', '/api/stripe/webhook', '{}', { 'stripe-signature': 'good' }), w);
  assert.equal(w.statusCode, 503);
});

test('POST /api/checkout returns a Stripe URL', async () => {
  const { handler } = app(); const r = res();
  await handler(req('POST', '/api/checkout', JSON.stringify({ tier: 'core' })), r);
  assert.equal(r.statusCode, 200);
  assert.match(JSON.parse(r._body).url, /pay\.stripe\.test/);
});

test('POST /api/checkout 400s an unknown tier', async () => {
  const { handler } = app(); const r = res();
  await handler(req('POST', '/api/checkout', JSON.stringify({ tier: 'bogus' })), r);
  assert.equal(r.statusCode, 400);
});

test('POST /api/stripe/webhook records the order on a good signature, 400s a bad one', async () => {
  const { handler, store, webhookReceipts } = app(); const r = res();
  const ev = JSON.stringify({ id: 'evt_hook', type: 'checkout.session.completed', data: { object: { id: 'cs_hook', mode: 'payment', payment_status: 'paid', metadata: { tier: 'pro' } } } });
  await handler(req('POST', '/api/stripe/webhook', ev, { 'stripe-signature': 'good' }), r);
  assert.equal(r.statusCode, 200);
  assert.equal(store.data.get('cs_hook')?.tier, 'pro');
  assert.equal(webhookReceipts.has('evt_hook'), true);

  const r2 = res();
  await handler(req('POST', '/api/stripe/webhook', ev, { 'stripe-signature': 'bad' }), r2);
  assert.equal(r2.statusCode, 400);
});

test('API request bodies are bounded before parsing or side effects', async () => {
  const { handler, created } = app();
  const tooLarge = JSON.stringify({ tier: 'core', padding: 'x'.repeat(70 * 1024) });
  const r = res();
  await handler(req('POST', '/api/checkout', tooLarge, { 'content-length': String(Buffer.byteLength(tooLarge)) }), r);
  assert.equal(r.statusCode, 413);
  assert.equal(created.length, 0);
});

test('a deployed test sandbox requires its private access code on checkout and intake', async () => {
  const token = 'private-founder-sandbox-code-123';
  const productionTest = cfg({ production: true, sandboxAccessToken: token });
  const { handler, created, store, kicks } = app({ cfg: productionTest });

  const missing = res();
  await handler(req('POST', '/api/checkout', JSON.stringify({ tier: 'core' })), missing);
  assert.equal(missing.statusCode, 401);
  assert.equal(created.length, 0);

  const wrong = res();
  await handler(req('POST', '/api/checkout', JSON.stringify({ tier: 'core' }), { 'x-relaunch72-sandbox-token': 'wrong' }), wrong);
  assert.equal(wrong.statusCode, 401);
  assert.equal(created.length, 0);

  const allowed = res();
  await handler(req('POST', '/api/checkout', JSON.stringify({ tier: 'core' }), { 'x-relaunch72-sandbox-token': token }), allowed);
  assert.equal(allowed.statusCode, 200);
  assert.equal(created.length, 1);

  store.record({ session_id: 'cs_private', tier: 'core', bump: false, email: 'founder@x.co', amount_total: 99700, currency: 'usd', status: 'paid_awaiting_intake', paid_at: 'T' });
  const intake = res();
  await handler(req('POST', '/api/intake', JSON.stringify({ ...validIntake(), consent: true, _stripe_session: 'cs_private' })), intake);
  assert.equal(intake.statusCode, 401);
  assert.equal(kicks.length, 0);
  assert.equal(store.find('cs_private')?.status, 'paid_awaiting_intake');
});

test('production test readiness fails closed when the private sandbox code is absent or weak', async () => {
  const { handler } = app({ cfg: cfg({ production: true, sandboxAccessToken: 'short' }) });
  const r = res();
  await handler(req('GET', '/health'), r);
  const health = JSON.parse(r._body);
  assert.equal(health.accepting_checkout, false);
  assert.match(health.blockers.join(' '), /SANDBOX_ACCESS_TOKEN/);
});

test('health and checkout fail closed when any advertised one-off price is missing', async () => {
  const partial = cfg({ priceIds: { autopsy: 'price_a', core: 'price_c', core_bump: '', pro: '' } });
  const { handler, created } = app({ cfg: partial });
  const h = res();
  await handler(req('GET', '/health'), h);
  const health = JSON.parse(h._body);
  assert.equal(health.accepting_checkout, false);
  assert.match(health.blockers.join(' '), /core_bump, pro/);

  const c = res();
  await handler(req('POST', '/api/checkout', JSON.stringify({ tier: 'autopsy' })), c);
  assert.equal(c.statusCode, 503);
  assert.equal(created.length, 0);
});

test('subscription checkout requires both explicit opt-in and the complete recurring catalogue', async () => {
  const disabled = app();
  const d = res();
  await disabled.handler(req('POST', '/api/subscription', JSON.stringify({ plan: 'platform_starter' })), d);
  assert.equal(d.statusCode, 503);
  assert.equal(disabled.created.length, 0);

  const partial = app({ cfg: cfg({
    platformSubscriptionsEnabled: true,
    planIds: { platform_starter: 'price_ps', platform_growth: '', platform_pro: '' },
  }) });
  const p = res();
  await partial.handler(req('POST', '/api/subscription', JSON.stringify({ plan: 'platform_starter' })), p);
  assert.equal(p.statusCode, 503);
  assert.match(JSON.parse(p._body).blockers.join(' '), /platform_growth, platform_pro/);
  assert.equal(partial.created.length, 0);
});

test('POST /api/checkout accepts the Core bump only as the literal boolean true', async () => {
  const { handler, created } = app();
  const response = res();
  await handler(req('POST', '/api/checkout', JSON.stringify({ tier: 'core', bump: 'false' })), response);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(created[0]!.line_items, [{ price: 'price_c', quantity: 1 }]);
  assert.deepEqual(created[0]!.metadata, { tier: 'core', bump: '0' });
});

test('checkout readiness blocks missing webhook configuration and every live Stripe key', async () => {
  const noWebhook = app({ cfg: cfg({ webhookSecret: '' }) });
  const missing = res();
  await noWebhook.handler(req('POST', '/api/checkout', JSON.stringify({ tier: 'core' })), missing);
  assert.equal(missing.statusCode, 503);
  assert.match(missing._body, /webhook secret/i);

  const live = app({ cfg: cfg({ secretKey: 'rk_live_money', keyMode: 'live', liveMode: true }) });
  const locked = res();
  await live.handler(req('POST', '/api/checkout', JSON.stringify({ tier: 'core' })), locked);
  assert.equal(locked.statusCode, 503);
  assert.match(locked._body, /live checkout is locked/i);
  live.store.record({ session_id: 'cs_live_external', tier: 'core', bump: false, email: null, amount_total: 99700, currency: 'gbp', status: 'paid_awaiting_intake', paid_at: 'T' });
  const liveIntake = res();
  await live.handler(req('POST', '/api/intake', JSON.stringify({ ...validIntake(), _stripe_session: 'cs_live_external', consent: true })), liveIntake);
  assert.equal(liveIntake.statusCode, 503, 'an external live Payment Link cannot bypass the build lock');
  assert.equal(live.store.find('cs_live_external')?.status, 'paid_awaiting_intake');

  const unknown = app({ cfg: cfg({ secretKey: 'future_money_key', keyMode: 'unknown', liveMode: false }) });
  const unrecognised = res();
  await unknown.handler(req('POST', '/api/checkout', JSON.stringify({ tier: 'core' })), unrecognised);
  assert.equal(unrecognised.statusCode, 503);
  assert.match(unrecognised._body, /not recognised/i);
});

test('POST /api/stripe/webhook acknowledges a replay without repeating side effects', async () => {
  const { handler, store } = app();
  const ev = JSON.stringify({ id: 'evt_replay', type: 'checkout.session.completed', data: { object: { id: 'cs_replay', mode: 'payment', payment_status: 'paid', metadata: { tier: 'core' } } } });
  await handler(req('POST', '/api/stripe/webhook', ev, { 'stripe-signature': 'good' }), res());
  const replay = res();
  await handler(req('POST', '/api/stripe/webhook', ev, { 'stripe-signature': 'good' }), replay);
  assert.equal(replay.statusCode, 200);
  assert.deepEqual(JSON.parse(replay._body), { received: true, replayed: true });
  assert.equal(store.records.length, 1);
});

test('a distinct webhook event cannot regress an already-claimed order or sync a test customer', async () => {
  const customers: string[] = [];
  const { handler, store } = app({ marketing: { onCustomer: async (order) => { customers.push(order.session_id); } } });
  const paid = (eventId: string) => JSON.stringify({ id: eventId, type: 'checkout.session.completed', data: { object: {
    id: 'cs_monotonic', mode: 'payment', payment_status: 'paid', amount_total: 99700, currency: 'usd',
    metadata: { tier: 'core', bump: '0' }, customer_details: { email: 'buyer@x.co' },
  } } });

  await handler(req('POST', '/api/stripe/webhook', paid('evt_first'), { 'stripe-signature': 'good' }), res());
  store.update('cs_monotonic', { status: 'building', run_dir: '/runs/already-started' });
  await handler(req('POST', '/api/stripe/webhook', paid('evt_distinct_duplicate'), { 'stripe-signature': 'good' }), res());
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(store.find('cs_monotonic')?.status, 'building');
  assert.equal(store.find('cs_monotonic')?.run_dir, '/runs/already-started');
  assert.deepEqual(customers, []);
});

test('POST /api/stripe/webhook rejects a verified payload without an event id', async () => {
  const { handler, store } = app();
  const ev = JSON.stringify({ type: 'checkout.session.completed', data: { object: { id: 'cs_no_event', mode: 'payment', payment_status: 'paid' } } });
  const r = res();
  await handler(req('POST', '/api/stripe/webhook', ev, { 'stripe-signature': 'good' }), r);
  assert.equal(r.statusCode, 400);
  assert.equal(store.records.length, 0);
});

test('POST /api/intake accepts a full intake and kicks the build; nudges a thin one', async () => {
  const { handler, kicks, store } = app();
  store.record({ session_id: 'cs_paid', tier: 'core', bump: false, email: null, amount_total: null, currency: null, status: 'paid_awaiting_intake', paid_at: 'T' });
  const good = { ...validIntake(), _stripe_session: 'cs_paid', consent: true };
  const r = res();
  await handler(req('POST', '/api/intake', JSON.stringify(good)), r);
  assert.equal(r.statusCode, 200);
  assert.equal(JSON.parse(r._body).accepted, true);
  assert.equal(kicks.length, 1);
  assert.equal(kicks[0]!.session, 'cs_paid');
  assert.equal(store.data.get('cs_paid')?.status, 'building');

  const replay = res();
  await handler(req('POST', '/api/intake', JSON.stringify(good)), replay);
  assert.equal(replay.statusCode, 200);
  assert.equal(JSON.parse(replay._body).duplicate, true);
  assert.equal(JSON.parse(replay._body).run, '/runs/kicked');
  assert.equal(kicks.length, 1, 'a repeated intake must not start another build');

  const thin = { A1: 'X' }; // missing almost everything
  const r2 = res();
  await handler(req('POST', '/api/intake', JSON.stringify(thin)), r2);
  assert.equal(r2.statusCode, 200);
  const b = JSON.parse(r2._body);
  assert.equal(b.accepted, false);
  assert.ok(Array.isArray(b.issues) && b.issues.length > 0);
});

test('POST /api/intake refuses a valid intake without an unconsumed paid order', async () => {
  const provisioned: string[] = [];
  const { handler, kicks, store } = app({ onIntakeAccepted: (_intake, order) => { provisioned.push(order.email ?? ''); } });
  const good = { ...validIntake(), consent: true };

  const noSession = res();
  await handler(req('POST', '/api/intake', JSON.stringify(good)), noSession);
  assert.equal(noSession.statusCode, 402);

  const unknown = res();
  await handler(req('POST', '/api/intake', JSON.stringify({ ...good, _stripe_session: 'cs_unknown' })), unknown);
  assert.equal(unknown.statusCode, 402);

  store.record({ session_id: 'cs_used', tier: 'core', bump: false, email: 'buyer@x.co', amount_total: null, currency: null, status: 'nudge_returned', paid_at: 'T' });
  const used = res();
  await handler(req('POST', '/api/intake', JSON.stringify({ ...good, _stripe_session: 'cs_used' })), used);
  assert.equal(used.statusCode, 409);
  assert.equal(kicks.length, 0);
  assert.equal(provisioned.length, 0);
});

test('POST /api/intake enforces the acknowledgement server-side before claiming payment', async () => {
  const { handler, store, kicks } = app();
  store.record({ session_id: 'cs_consent', tier: 'core', bump: false, email: 'buyer@x.co', amount_total: 99700, currency: 'usd', status: 'paid_awaiting_intake', paid_at: 'T' });
  const r = res();
  await handler(req('POST', '/api/intake', JSON.stringify({ ...validIntake(), _stripe_session: 'cs_consent', consent: false })), r);
  assert.equal(r.statusCode, 200);
  const body = JSON.parse(r._body);
  assert.equal(body.accepted, false);
  assert.equal(body.issues[0].field, 'consent');
  assert.equal(store.find('cs_consent')?.status, 'paid_awaiting_intake');
  assert.equal(kicks.length, 0);
});

test('POST /api/intake restores the paid entitlement after a synchronous launch failure', async () => {
  const store = memStore();
  store.record({ session_id: 'cs_retry', tier: 'core', bump: false, email: null, amount_total: null, currency: null, status: 'paid_awaiting_intake', paid_at: 'T' });
  const { handler } = app({ orders: store, kickPipeline: () => { throw new Error('launch failed'); } });
  const r = res();
  await handler(req('POST', '/api/intake', JSON.stringify({ ...validIntake(), _stripe_session: 'cs_retry', consent: true })), r);
  assert.equal(r.statusCode, 500);
  assert.equal(store.find('cs_retry')?.status, 'paid_awaiting_intake');
});

test('paid product metadata controls build scope and Autopsy never provisions a full portal', async () => {
  const provisioned: Array<string | null> = [];
  const { handler, store, kicks } = app({ onIntakeAccepted: (_intake, order) => { provisioned.push(order.email); } });
  store.record({ session_id: 'cs_autopsy', tier: 'autopsy', bump: false, email: 'audit@client.co', amount_total: 9700, currency: 'usd', status: 'paid_awaiting_intake', paid_at: 'T' });

  const response = res();
  await handler(req('POST', '/api/intake', JSON.stringify({ ...validIntake(), _stripe_session: 'cs_autopsy', consent: true })), response);

  assert.equal(response.statusCode, 200);
  assert.deepEqual(kicks, [{ session: 'cs_autopsy', product: 'autopsy', through: 'S1' }]);
  assert.deepEqual(provisioned, [], 'Autopsy does not include the full client portal');
});

test('Core bump receives the full S1-S9 build and preserves its fulfilment product', async () => {
  const { handler, store, kicks } = app();
  store.record({ session_id: 'cs_bump', tier: 'core', bump: true, email: 'core@client.co', amount_total: 114400, currency: 'usd', status: 'paid_awaiting_intake', paid_at: 'T' });
  const response = res();
  await handler(req('POST', '/api/intake', JSON.stringify({ ...validIntake(), _stripe_session: 'cs_bump', consent: true })), response);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(kicks, [{ session: 'cs_bump', product: 'core_bump', through: 'S9' }]);
});

test('an unknown legacy order product is not allowed to start a build', async () => {
  const { handler, store, kicks } = app();
  store.record({ session_id: 'cs_unknown_tier', tier: 'mystery', bump: false, email: null, amount_total: 1, currency: 'usd', status: 'paid_awaiting_intake', paid_at: 'T' });
  const response = res();
  await handler(req('POST', '/api/intake', JSON.stringify({ ...validIntake(), _stripe_session: 'cs_unknown_tier', consent: true })), response);
  assert.equal(response.statusCode, 409);
  assert.equal(store.find('cs_unknown_tier')?.status, 'paid_awaiting_intake');
  assert.deepEqual(kicks, []);
});

test('an accepted intake fires onIntakeAccepted with the verified order authority', async () => {
  const seen: Array<{ sessionId: string; email: string | null; name: unknown }> = [];
  const { handler, store } = app({
    onIntakeAccepted: (intake, order) => {
      seen.push({
        sessionId: order.session_id,
        email: order.email,
        name: intake.A1,
      });
    },
  });
  store.record({ session_id: 'cs_p', tier: 'core', bump: false, email: 'buyer@client.co', amount_total: null, currency: null, status: 'paid_awaiting_intake', paid_at: 'T' });

  const good = { ...validIntake(), _stripe_session: 'cs_p', consent: true };
  await handler(req('POST', '/api/intake', JSON.stringify(good)), res());
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.sessionId, 'cs_p');
  assert.equal(seen[0]!.email, 'buyer@client.co');

  // A repeated accepted intake returns the existing run and must NOT provision again.
  await handler(req('POST', '/api/intake', JSON.stringify(good)), res());
  assert.equal(seen.length, 1);

  // A rejected (thin) intake must NOT provision.
  await handler(req('POST', '/api/intake', JSON.stringify({ A1: 'X' })), res());
  assert.equal(seen.length, 1);
});

test('portal provisioning never trusts a caller-supplied intake email', async () => {
  const seen: Array<string | null> = [];
  const { handler, store } = app({ onIntakeAccepted: (_intake, order) => { seen.push(order.email); } });
  store.record({ session_id: 'cs_no_email', tier: 'core', bump: false, email: null, amount_total: null, currency: null, status: 'paid_awaiting_intake', paid_at: 'T' });

  const body = { ...validIntake(), _stripe_session: 'cs_no_email', _email: 'attacker@example.com', consent: true };
  const response = res();
  await handler(req('POST', '/api/intake', JSON.stringify(body)), response);

  assert.equal(response.statusCode, 200);
  assert.deepEqual(seen, [null]);
});

test('accepted intake strips checkout capabilities and non-contract fields before every side effect', async () => {
  const provisioned: Array<Record<string, unknown>> = [];
  const { handler, store, kickedIntakes } = app({ onIntakeAccepted: (intake) => { provisioned.push(intake); } });
  store.record({ session_id: 'cs_sanitized', tier: 'core', bump: false, email: 'verified@client.co', amount_total: 99700, currency: 'usd', status: 'paid_awaiting_intake', paid_at: 'T' });
  const body = {
    ...validIntake(),
    consent: true,
    _stripe_session: 'cs_sanitized',
    _tier: 'pro',
    _generated_by: 'caller-controlled',
    _email: 'attacker@example.com',
    extra_junk: 'must not persist',
  };

  const response = res();
  await handler(req('POST', '/api/intake', JSON.stringify(body)), response);
  assert.equal(response.statusCode, 200);
  assert.equal(kickedIntakes.length, 1);
  assert.equal(provisioned.length, 1);
  for (const safe of [kickedIntakes[0]!, provisioned[0]!]) {
    assert.equal(safe.A1, validIntake().A1);
    assert.equal(safe.consent, true);
    assert.equal('_stripe_session' in safe, false);
    assert.equal('_tier' in safe, false);
    assert.equal('_generated_by' in safe, false);
    assert.equal('_email' in safe, false);
    assert.equal('extra_junk' in safe, false);
  }
});

// ─── CORS (the site calls this API cross-origin) ─────────────────────────────
test('CORS: an allowed Origin is echoed back on a real response', async () => {
  const { handler } = app(); const r = res();
  await handler(req('POST', '/api/checkout', JSON.stringify({ tier: 'core' }), { origin: 'https://relaunch72.com' }), r);
  assert.equal(r.statusCode, 200);
  assert.equal(r._headers['access-control-allow-origin'], 'https://relaunch72.com');
  assert.equal(r._headers['vary'], 'Origin');
});

test('CORS: an OPTIONS preflight from an allowed origin returns 204 with the headers', async () => {
  const { handler } = app(); const r = res();
  await handler(req('OPTIONS', '/api/checkout', '', { origin: 'https://relaunch72.com' }), r);
  assert.equal(r.statusCode, 204);
  assert.equal(r._headers['access-control-allow-origin'], 'https://relaunch72.com');
  assert.match(String(r._headers['access-control-allow-methods']), /POST/);
  assert.match(String(r._headers['access-control-allow-headers']), /content-type/);
});

test('CORS: an origin NOT on the allowlist gets no allow-origin header', async () => {
  const { handler } = app(); const r = res();
  await handler(req('GET', '/health', '', { origin: 'https://evil.example' }), r);
  assert.equal(r.statusCode, 200);
  assert.equal(r._headers['access-control-allow-origin'], undefined);
});

// ─── marketing (Brevo) hooks ─────────────────────────────────────────────────
test('POST /api/subscribe calls onLead and reports synced', async () => {
  const leads: Array<{ email: string; firstName?: string }> = [];
  const { handler } = app({ marketing: { onLead: async (email, firstName) => { leads.push({ email, firstName }); } } });
  const r = res();
  await handler(req('POST', '/api/subscribe', JSON.stringify({ email: 'lead@x.com', firstName: 'Jo' })), r);
  assert.equal(r.statusCode, 200);
  assert.deepEqual(JSON.parse(r._body), { ok: true, synced: true });
  assert.deepEqual(leads, [{ email: 'lead@x.com', firstName: 'Jo' }]);
});

test('POST /api/subscribe 400s a bad email when enabled and 503s when delivery is off', async () => {
  const bad = res();
  await app({ marketing: { onLead: async () => undefined } }).handler(req('POST', '/api/subscribe', JSON.stringify({ email: 'nope' })), bad);
  assert.equal(bad.statusCode, 400);

  const off = res(); // no marketing dep configured
  await app().handler(req('POST', '/api/subscribe', JSON.stringify({ email: 'lead@x.com' })), off);
  assert.equal(off.statusCode, 503);
  assert.equal(JSON.parse(off._body).synced, false);
});

// ─── subscriptions (recurring billing) ───────────────────────────────────────
test('POST /api/subscription returns a subscription-mode Stripe URL', async () => {
  const { handler, created } = app({ cfg: cfg({ platformSubscriptionsEnabled: true }) });
  const r = res();
  await handler(req('POST', '/api/subscription', JSON.stringify({ plan: 'platform_growth', email: 'buyer@co.uk' })), r);
  assert.equal(r.statusCode, 200);
  assert.match(JSON.parse(r._body).url, /pay\.stripe\.test/);
  assert.equal(created[0]!.mode, 'subscription');
});

test('POST /api/subscription 400s an unknown plan', async () => {
  const { handler } = app({ cfg: cfg({ platformSubscriptionsEnabled: true }) }); const r = res();
  await handler(req('POST', '/api/subscription', JSON.stringify({ plan: 'bogus' })), r);
  assert.equal(r.statusCode, 400);
});

test('webhook records a subscription lifecycle event when a store is wired', async () => {
  const subs = memorySubscriptionStore();
  const { handler } = app({ subscriptions: subs });
  const ev = JSON.stringify({ id: 'evt_sub_hook', type: 'customer.subscription.created', data: { object: {
    id: 'sub_hook', customer: 'cus_1', status: 'active',
    items: { data: [{ price: { id: 'price_pg' } }] }, metadata: { email: 'boss@acme.co' },
  } } });
  const r = res();
  await handler(req('POST', '/api/stripe/webhook', ev, { 'stripe-signature': 'good' }), r);
  assert.equal(r.statusCode, 200);
  assert.equal(subs.find('sub_hook')?.status, 'active');
  assert.equal(subs.find('sub_hook')?.plan, 'platform_growth'); // resolved via cfg.planIds
  assert.equal(subs.findByEmail('boss@acme.co')?.subscription_id, 'sub_hook');
});

test('webhook without a subscription store still records the order (subscriptions optional)', async () => {
  const { handler, store } = app(); // no subscriptions dep
  const ev = JSON.stringify({ id: 'evt_ns', type: 'checkout.session.completed', data: { object: { id: 'cs_ns', mode: 'payment', payment_status: 'paid', metadata: { tier: 'core' } } } });
  const r = res();
  await handler(req('POST', '/api/stripe/webhook', ev, { 'stripe-signature': 'good' }), r);
  assert.equal(r.statusCode, 200);
  assert.equal(store.data.get('cs_ns')?.tier, 'core');
});

test('test-mode webhook never syncs an arbitrary checkout email to customer marketing', async () => {
  const customers: string[] = [];
  const { handler } = app({ marketing: { onCustomer: async (o) => { customers.push(o.email ?? ''); } } });
  const ev = JSON.stringify({ id: 'evt_m', type: 'checkout.session.completed', data: { object: { id: 'cs_m', mode: 'payment', payment_status: 'paid', metadata: { tier: 'core' }, customer_details: { email: 'buyer@x.com' } } } });
  const r = res();
  await handler(req('POST', '/api/stripe/webhook', ev, { 'stripe-signature': 'good' }), r);
  assert.equal(r.statusCode, 200);
  assert.deepEqual(customers, []);
});

test('live and unknown Stripe webhooks are acknowledged but quarantined without side effects', async () => {
  for (const lockedCfg of [
    cfg({ secretKey: 'sk_live_money', keyMode: 'live', liveMode: true }),
    cfg({ secretKey: 'future_money_key', keyMode: 'unknown', liveMode: false }),
  ]) {
    const customers: string[] = [];
    const subs = memorySubscriptionStore();
    const { handler, store, webhookReceipts } = app({
      cfg: lockedCfg,
      subscriptions: subs,
      marketing: { onCustomer: async (o) => { customers.push(o.email ?? ''); } },
    });
    const ev = JSON.stringify({ id: `evt_locked_${lockedCfg.keyMode}`, type: 'checkout.session.completed', data: { object: {
      id: `cs_locked_${lockedCfg.keyMode}`, mode: 'payment', payment_status: 'paid', metadata: { tier: 'core' }, customer_details: { email: 'victim@example.com' },
    } } });
    const r = res();
    await handler(req('POST', '/api/stripe/webhook', ev, { 'stripe-signature': 'good' }), r);
    assert.equal(r.statusCode, 200);
    assert.equal(JSON.parse(r._body).quarantined, true);
    assert.equal(store.records.length, 0);
    assert.equal(customers.length, 0);
    assert.equal(webhookReceipts.has(`evt_locked_${lockedCfg.keyMode}`), true);
  }
});
