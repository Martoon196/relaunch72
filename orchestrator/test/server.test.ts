import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createCheckoutSession, priceKeyFor, orderFromEvent, CheckoutError, type StripeLike, type StripeEvent } from '../src/server/stripe.js';
import { loadStripeConfig, type StripeConfig } from '../src/server/config.js';
import { fileOrderStore, type Order, type OrderStore } from '../src/server/orders.js';
import { createApp } from '../src/server/app.js';
import { validIntake } from './helpers.js';

function cfg(over: Partial<StripeConfig> = {}): StripeConfig {
  return {
    secretKey: 'sk_test_x', webhookSecret: 'whsec_x',
    priceIds: { autopsy: 'price_a', core: 'price_c', core_bump: 'price_cb', pro: 'price_p' },
    publicBaseUrl: 'https://relaunch72.test', port: 4242, liveMode: false,
    dataDir: os.tmpdir(),
    ordersFile: path.join(os.tmpdir(), `r72-orders-${process.pid}-${Math.round(performance.now())}.jsonl`),
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
  await assert.rejects(() => createCheckoutSession(fakeStripe([]), cfg({ priceIds: { core: '' } }), { tier: 'core' }), CheckoutError);
});

test('orderFromEvent maps a completed checkout; ignores other events', () => {
  const ev: StripeEvent = { type: 'checkout.session.completed', data: { object: { id: 'cs_1', amount_total: 99700, currency: 'usd', metadata: { tier: 'core', bump: '1' }, customer_details: { email: 'a@b.com' } } } };
  const o = orderFromEvent(ev, 'T')!;
  assert.equal(o.session_id, 'cs_1');
  assert.equal(o.tier, 'core');
  assert.equal(o.bump, true);
  assert.equal(o.email, 'a@b.com');
  assert.equal(o.status, 'paid_awaiting_intake');
  assert.equal(orderFromEvent({ type: 'payment_intent.created' }, 'T'), null);
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

// ─── routes (fake req/res harness) ───────────────────────────────────────────
function req(method: string, url: string, body = '', headers: Record<string, string> = {}): IncomingMessage {
  const r = Readable.from([Buffer.from(body)]) as unknown as IncomingMessage;
  return Object.assign(r, { method, url, headers });
}
function res(): ServerResponse & { statusCode: number; _body: string; _headers: Record<string, string> } {
  const r = { statusCode: 0, _body: '', _headers: {} as Record<string, string> } as {
    statusCode: number; _body: string; _headers: Record<string, string>;
    setHeader: (k: string, v: string) => unknown; writeHead: (c: number) => unknown; end: (b?: string) => unknown;
  };
  r.setHeader = (k: string, v: string) => { r._headers[k.toLowerCase()] = v; return r; };
  r.writeHead = (c: number) => { r.statusCode = c; return r; };
  r.end = (b?: string) => { r._body = b ?? ''; return r; };
  return r as unknown as ServerResponse & { statusCode: number; _body: string; _headers: Record<string, string> };
}
function memStore(): OrderStore & { data: Map<string, Order> } {
  const data = new Map<string, Order>();
  return { data, record: (o) => { data.set(o.session_id, o); }, find: (id) => data.get(id) ?? null, update: (id, p) => { const c = data.get(id); if (!c) return null; const n = { ...c, ...p }; data.set(id, n); return n; } };
}
function app(over: Partial<Parameters<typeof createApp>[0]> = {}) {
  const created: Array<Record<string, unknown>> = [];
  const kicks: Array<{ session: string | null }> = [];
  const store = memStore();
  const handler = createApp({
    stripe: fakeStripe(created), cfg: cfg(), orders: store,
    kickPipeline: (_i, session) => { kicks.push({ session }); return '/runs/kicked'; },
    now: () => 'T', ...over,
  });
  return { handler, created, kicks, store };
}

test('GET /health reports test mode + configured', async () => {
  const { handler } = app(); const r = res();
  await handler(req('GET', '/health'), r);
  assert.equal(r.statusCode, 200);
  assert.deepEqual(JSON.parse(r._body), { ok: true, mode: 'test', configured: true });
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
  const { handler, store } = app(); const r = res();
  const ev = JSON.stringify({ type: 'checkout.session.completed', data: { object: { id: 'cs_hook', metadata: { tier: 'pro' } } } });
  await handler(req('POST', '/api/stripe/webhook', ev, { 'stripe-signature': 'good' }), r);
  assert.equal(r.statusCode, 200);
  assert.equal(store.data.get('cs_hook')?.tier, 'pro');

  const r2 = res();
  await handler(req('POST', '/api/stripe/webhook', ev, { 'stripe-signature': 'bad' }), r2);
  assert.equal(r2.statusCode, 400);
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

  const thin = { A1: 'X' }; // missing almost everything
  const r2 = res();
  await handler(req('POST', '/api/intake', JSON.stringify(thin)), r2);
  assert.equal(r2.statusCode, 200);
  const b = JSON.parse(r2._body);
  assert.equal(b.accepted, false);
  assert.ok(Array.isArray(b.issues) && b.issues.length > 0);
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

test('POST /api/subscribe 400s a bad email and 200s (unsynced) when marketing is off', async () => {
  const bad = res();
  await app().handler(req('POST', '/api/subscribe', JSON.stringify({ email: 'nope' })), bad);
  assert.equal(bad.statusCode, 400);

  const off = res(); // no marketing dep configured
  await app().handler(req('POST', '/api/subscribe', JSON.stringify({ email: 'lead@x.com' })), off);
  assert.equal(off.statusCode, 200);
  assert.equal(JSON.parse(off._body).synced, false);
});

test('webhook syncs a paying customer via onCustomer', async () => {
  const customers: string[] = [];
  const { handler } = app({ marketing: { onCustomer: async (o) => { customers.push(o.email ?? ''); } } });
  const ev = JSON.stringify({ type: 'checkout.session.completed', data: { object: { id: 'cs_m', metadata: { tier: 'core' }, customer_details: { email: 'buyer@x.com' } } } });
  const r = res();
  await handler(req('POST', '/api/stripe/webhook', ev, { 'stripe-signature': 'good' }), r);
  assert.equal(r.statusCode, 200);
  // onCustomer is fire-and-forget; let the microtask run before asserting.
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(customers, ['buyer@x.com']);
});
