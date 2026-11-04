import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createMhpMount } from '../src/mhp/mount.js';
import type { PostgresPortalDeps } from '../src/portal/router.js';
import type { PortalCrmService } from '../src/portal/crm-service.js';
import { startMhpWindowCloser } from '../src/mhp/window-closer.js';

const HOST = 'app.martinhowardproperty.co.uk';
const SITE = 'https://martinhowardproperty.co.uk';
const ID = '11300000-0000-4000-8000-000000000001';

function harness(options: { billing?: boolean; sandbox?: boolean; admit?: boolean; welcome?: () => Promise<void> } = {}) {
  const calls: string[] = [];
  const portal: PostgresPortalDeps = {
    kind: 'postgres', secure: true, sessionSecret: 'mhp-course-checkout-test-secret-at-least-32-chars', sessionCookieName: '__Host-mhp_session',
    auth: { resolve: async () => null, login: async () => null, revoke: async () => {} },
    crm: {} as PortalCrmService,
    abuseHashSecret: 'different-mhp-course-checkout-abuse-secret-32-chars',
    requestContext: () => ({ requestId: ID, requestHash: Buffer.alloc(32, 1), sourceHash: Buffer.alloc(32, 2) }),
    abuse: { admit: async () => (options.admit === false ? { allowed: false, leaseHash: null, retryAfterSeconds: 60 }
      : { allowed: true, leaseHash: Buffer.alloc(32, 1), retryAfterSeconds: 0 }) as never,
      complete: async () => { calls.push('lease-complete'); }, assertReady: async () => {}, close: async () => {} },
  };
  const mount = createMhpMount({ portal, authMount: { handle: async () => false }, readiness: async () => [],
    mail: { configured: true, sendAccessInvite: async () => {}, sendPurchaseWelcome: async (email, name, product, kind) => {
      calls.push(`welcome:${email}:${name}:${product}:${kind}`); await options.welcome?.();
    } },
    hq: { isOwner: async () => false, snapshot: async () => ({ people: [], products: [], grants: [] }), grant: async () => ID },
    commerce: {
      billingEnabled: options.billing ?? true, sandbox: options.sandbox ?? false,
      snapshot: async () => { throw new Error('unused'); }, refund: async () => {}, billingPortal: async () => '',
      webhook: async () => { calls.push('webhook'); return { email: 'buyer@example.com', name: 'Pat', sku: 'mhp_course_web', productName: 'Property Done Properly, webinar price', kind: 'course' as const }; },
      publicCourseCheckout: async plan => { calls.push(`checkout:${plan}`); return 'https://checkout.stripe.com/c/pay/cs_test_fixture'; },
    },
  });
  const request = async (method: string, url: string, body = '', headers: Record<string, string> = {}) => {
    const req = Object.assign(Readable.from([Buffer.from(body)]), { method, url, headers: {
      host: HOST, 'content-type': 'application/x-www-form-urlencoded', ...headers } }) as unknown as IncomingMessage;
    const captured = { status: 0, body: '', headers: {} as Record<string, string> };
    const res = { headersSent: false, writeHead(status: number, h = {}) { captured.status = status; Object.assign(captured.headers, h); },
      setHeader(k: string, v: string) { captured.headers[k.toLowerCase()] = v; }, end(b = '') { captured.body = b; } } as unknown as ServerResponse;
    await mount.handle(req, res); return captured;
  };
  return { calls, request };
}

test('course checkout posts from the site redirect to Stripe with the chosen plan', async () => {
  for (const origin of [SITE, 'https://www.martinhowardproperty.co.uk']) {
    for (const plan of ['full', '3x']) {
      const h = harness();
      const r = await h.request('POST', '/api/mhp/checkout/course', `plan=${plan}`, { origin });
      assert.equal(r.status, 303); assert.equal(r.headers.location, 'https://checkout.stripe.com/c/pay/cs_test_fixture');
      assert.deepEqual(h.calls.filter(c => c.startsWith('checkout')), [`checkout:${plan}`]);
      assert.ok(h.calls.includes('lease-complete'));
    }
  }
});
test('course checkout refuses other origins, bad plans, extra fields and rate-limited sources', async () => {
  const cases: [string, Record<string, string>, number, boolean?][] = [
    ['plan=full', { origin: 'https://evil.example' }, 403],
    ['plan=full', { origin: `https://${HOST}` }, 403],
    ['plan=full', {}, 403],
    ['plan=12x', { origin: SITE }, 400],
    ['plan=full&price=99700', { origin: SITE }, 400],
    ['plan=full&plan=3x', { origin: SITE }, 400],
    ['plan=full', { origin: SITE, 'content-type': 'application/json' }, 415],
    ['plan=full', { origin: SITE }, 429, false],
  ];
  for (const [body, headers, status, admit] of cases) {
    const h = harness({ admit: admit ?? true });
    const r = await h.request('POST', '/api/mhp/checkout/course', body, headers);
    assert.equal(r.status, status, `${body} ${JSON.stringify(headers)}`);
    assert.equal(h.calls.some(c => c.startsWith('checkout')), false);
  }
});
test('course checkout says it is opening shortly when billing is not connected', async () => {
  const h = harness({ billing: false });
  const r = await h.request('POST', '/api/mhp/checkout/course', 'plan=full', { origin: SITE });
  assert.equal(r.status, 503); assert.match(r.body, /opening shortly/);
});
test('a GET goes back to the course page; only a sandbox key shows the app test page', async () => {
  const live = harness();
  const r = await live.request('GET', '/api/mhp/checkout/course');
  assert.equal(r.status, 303); assert.equal(r.headers.location, `${SITE}/join/`);
  const sandbox = harness({ sandbox: true });
  const page = await sandbox.request('GET', '/api/mhp/checkout/course');
  assert.equal(page.status, 200); assert.match(page.body, /Sandbox course checkout/);
  assert.match(page.headers['content-security-policy']!, /form-action 'self' https:\/\/checkout\.stripe\.com/);
  const fromApp = await sandbox.request('POST', '/api/mhp/checkout/course', 'plan=3x', { origin: `https://${HOST}` });
  assert.equal(fromApp.status, 303);
});
test('the welcome email goes out after the webhook 200 and a mail failure does not change the response', async () => {
  const h = harness({ welcome: async () => { throw new Error('provider down'); } });
  const r = await h.request('POST', '/api/stripe/webhook', '{}', { 'stripe-signature': 't=1,v1=x', 'content-type': 'application/json' });
  assert.equal(r.status, 200);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.calls.filter(c => c !== 'lease-complete'), ['webhook', 'welcome:buyer@example.com:Pat:Property Done Properly, webinar price:course']);
});
test('window closer runs at the end, repeats, and stops after the closing period', async () => {
  let clock = 1_000_000;
  const runs: number[] = [];
  const stop = startMhpWindowCloser({ billingEnabled: true, windowEndsAt: 1_000_000 + 20,
    expireWindowCheckouts: async () => { runs.push(clock); return { expired: 1, stillOpen: 0 }; } }, { now: () => clock, intervalMs: 1_000 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(runs.length, 0, 'nothing before the end');
  clock += 60; await new Promise(resolve => setTimeout(resolve, 400));
  assert.ok(runs.length >= 1, 'runs at the end');
  stop();
  assert.equal(typeof startMhpWindowCloser({ billingEnabled: false, windowEndsAt: 1, expireWindowCheckouts: async () => ({ expired: 0, stillOpen: 0 }) }), 'function');
});
