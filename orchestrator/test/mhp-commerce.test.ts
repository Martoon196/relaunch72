import test from 'node:test';
import assert from 'node:assert/strict';
import Stripe from 'stripe';
import type { Pool } from 'pg';
import { MHP_CATALOG, MHP_STANDARD_CATALOG, mhpPriceEnvironmentName } from '../src/mhp/catalog.js';
import { mhpCommerceConfig, type MhpCommerceConfig } from '../src/mhp/commerce-config.js';
import { PgMhpCommerceService, MhpCommerceError, mhpInstalmentEnd } from '../src/mhp/commerce-service.js';
import { accountPage } from '../src/mhp/account-view.js';

const sdk = new Stripe('rk_test_fixture');
const config: MhpCommerceConfig = { secretKey: 'rk_test_fixture', accountId: 'acct_mhp', webhookSecret: 'whsec_test', live: false,
  portalConfigurationId: 'bpc_mhp', prices: Object.fromEntries(MHP_CATALOG.map(p => [p.sku, `price_${p.sku}`])) as MhpCommerceConfig['prices'] };
const buyer = 'buyer@example.com';
const sessionId = 'cs_test_mhp';
const now = Math.floor(Date.now() / 1000);
type Call = { sql: string; args: unknown[] };
function fixture(sku = 'mhp_course') {
  const product = MHP_CATALOG.find(p => p.sku === sku)!;
  const calls: Call[] = [];
  const providerCalls: string[] = [];
  const subscription = { id: 'sub_mhp', livemode: false, customer: 'cus_mhp', status: 'active', schedule: null,
    metadata: { brand: 'martin_howard_property', sku: product.sku },
    items: { data: [{ price: { id: config.prices[product.sku], currency: 'gbp', unit_amount: product.pricePence, recurring: { interval: product.interval, interval_count: 1 } }, quantity: 1, current_period_end: now + 100000 }] } };
  const charge = { id: 'ch_mhp', paid: true, amount: product.pricePence, amount_refunded: 0, created: now - 100, livemode: false, currency: 'gbp' };
  let schedule = { id: 'sub_sched_mhp', livemode: false, customer: 'cus_mhp', metadata: {} as Record<string,string>, status: 'active', end_behavior: 'release',
    phases: [{ start_date: now - 100, end_date: now + 100000, trial_end: null, discounts: [], items: [{ price: config.prices[product.sku], quantity: 1, discounts: [] }] }] };
  const stripe = {
    webhooks: sdk.webhooks,
    accounts: { retrieve: async () => ({ id: 'acct_mhp' }) },
    checkout: { sessions: {
      retrieve: async () => ({ id: sessionId, livemode: false, status: 'complete', payment_status: 'paid', currency: 'gbp',
        amount_total: product.pricePence, mode: product.interval ? 'subscription' : 'payment', total_details: { amount_discount: 0, amount_tax: 0 },
        customer: 'cus_mhp', customer_details: { email: buyer }, subscription: product.interval ? 'sub_mhp' : null, payment_intent: product.interval ? null : 'pi_mhp' }),
      listLineItems: async () => ({ data: [{ price: { id: config.prices[product.sku], unit_amount: Number(product.pricePence), currency: 'gbp' }, quantity: 1, amount_total: Number(product.pricePence) }], has_more: false }),
      list: async () => ({ data: [{ id: sessionId, status: 'complete' }], has_more: false }),
    } },
    paymentIntents: { retrieve: async () => ({ id: 'pi_mhp', status: 'succeeded', livemode: false, currency: 'gbp', amount_received: product.pricePence, latest_charge: 'ch_mhp' }) },
    charges: { retrieve: async () => charge },
    subscriptions: { list: async () => ({ data: [subscription], has_more: false }), retrieve: async () => subscription, cancel: async () => { providerCalls.push('cancel'); return { id: 'sub_mhp' }; } },
    subscriptionSchedules: {
      create: async () => { providerCalls.push('schedule-create'); return { id: 'sub_sched_mhp' }; },
      retrieve: async () => schedule,
      update: async (_id: string, params: { metadata: Record<string,string>; end_behavior: string; phases: { start_date: number; end_date: number }[] }) => {
        assert.equal(params.end_behavior, 'cancel');
        assert.equal(params.phases[0]?.end_date, mhpInstalmentEnd(Number(params.metadata.mhp_anchor), product.instalments!));
        schedule = { ...schedule, metadata: params.metadata, end_behavior: params.end_behavior,
          phases: [{ ...schedule.phases[0]!, start_date: params.phases[0]!.start_date, end_date: params.phases[0]!.end_date }] };
        providerCalls.push('schedule-bounded'); return schedule;
      },
      cancel: async () => { providerCalls.push('schedule-cancel'); return {}; },
    },
    invoices: { list: async () => ({ data: [{ id: 'in_mhp', customer: 'cus_mhp', amount_paid: product.pricePence, currency: 'gbp', livemode: false,
      status_transitions: { paid_at: now - 100 }, lines: { has_more: false, data: [{ period: { start: now - 100, end: now + 1000 } }] } }], has_more: false }) },
    invoicePayments: { list: async () => ({ data: [{ payment: { type: 'payment_intent', payment_intent: 'pi_mhp' } }], has_more: false }) },
    refunds: { create: async (_params: unknown, options: { idempotencyKey: string }) => { providerCalls.push(options.idempotencyKey); return { id: 're_mhp' }; } },
    billingPortal: { sessions: { create: async () => ({ url: 'https://billing.stripe.com/p/session/test' }) } },
  };
  let refundPlan: unknown;
  const pool = { query: async (sql: string, args: unknown[] = []) => {
    calls.push({ sql, args });
    if (sql.includes('mhp_begin_refund')) return { rows: [{ plan: refundPlan }] };
    if (sql.includes('mhp_account_snapshot')) return { rows: [{ snapshot: { access: product.grants, purchases: [] } }] };
    return { rows: [{ session: null }] };
  } } as unknown as Pick<Pool, 'query'>;
  const service = new PgMhpCommerceService(pool, pool, pool, stripe as unknown as Stripe, config);
  const signed = (event: object) => {
    const body = Buffer.from(JSON.stringify({ id: 'evt_mhp', livemode: false, type: 'checkout.session.completed', data: { object: { id: sessionId } }, ...event }));
    return { body, signature: sdk.webhooks.generateTestHeaderString({ payload: body.toString(), secret: config.webhookSecret }) };
  };
  return { service, stripe, calls, signed, providerCalls, subscription, charge, getSchedule: () => schedule, setSchedule: (s: typeof schedule) => { schedule = s; }, setRefundPlan: (v: unknown) => { refundPlan = v; } };
}

test('MHP prices and grants match founder-approved offers', () => {
  assert.deepEqual(MHP_CATALOG.map(p => p.pricePence), [4700,149700,52500,99700,34900,6700,67000,4700,399700,69900,299700,52500,750000]);
  assert.equal(MHP_CATALOG[0].grants.crm, false);
  assert.equal(MHP_CATALOG[1].grants.emailWorkflow, false);
  assert.equal(MHP_CATALOG[8].grants.emailWorkflow, true);
  assert.equal(MHP_CATALOG.filter(p => p.availability === 'gated').length, 6);
  assert.equal(MHP_CATALOG[0].refundDays, 14);
  assert.equal(MHP_CATALOG.slice(1).every(p => p.refundDays === 30), true);
});
test('MHP configuration never falls back to Property Predator secrets', () => {
  assert.equal(mhpCommerceConfig({ STRIPE_SECRET_KEY: 'rk_live_pp' }), null);
  assert.throws(() => mhpCommerceConfig({ MHP_BILLING_ENABLED: 'true', STRIPE_SECRET_KEY: 'rk_live_pp' }));
  const env: NodeJS.ProcessEnv = { MHP_BILLING_ENABLED: 'true', MHP_STRIPE_SECRET_KEY: 'rk_test_fixture', MHP_STRIPE_ACCOUNT_ID: 'acct_mhp', MHP_STRIPE_WEBHOOK_SECRET: 'whsec_test', MHP_STRIPE_PORTAL_CONFIGURATION_ID: 'bpc_mhp' };
  for (const p of MHP_STANDARD_CATALOG) env[mhpPriceEnvironmentName(p.sku)] = `price_${p.sku.replaceAll('_','')}`;
  assert.equal(mhpCommerceConfig(env)?.live, false);
  assert.equal(Object.keys(mhpCommerceConfig(env)!.prices).length, 6);
  assert.throws(() => mhpCommerceConfig({ ...env, MHP_STRIPE_PRICE_PARTNERSHIP: 'price_manual' }));
  assert.throws(() => mhpCommerceConfig({ ...env, MHP_STRIPE_PRICE_DEAL_DESK: 'invalid' }));
});
test('signed matching checkout records purchase evidence without granting identity from an email', async () => {
  const f = fixture(); const e = f.signed({}); await f.service.webhook(e.body, e.signature);
  assert.equal(f.calls.length, 1); assert.match(f.calls[0]!.sql, /record_mhp_commerce_event/);
  const payload = JSON.parse(f.calls[0]!.args[4] as string);
  assert.equal(payload.email, buyer); assert.equal(payload.sku, 'mhp_course'); assert.equal(payload.accountId, undefined);
  assert.equal(payload.payments[0].amount, 149700);
});
test('invalid signature, wrong mode and wrong connected account cannot record entitlements', async () => {
  const f = fixture(); const e = f.signed({});
  await assert.rejects(f.service.webhook(e.body, 'invalid'), (e: unknown) => e instanceof MhpCommerceError && e.status === 400);
  for (const invalid of [{ livemode: true }, { account: 'acct_other' }]) {
    const signed = f.signed(invalid); await assert.rejects(f.service.webhook(signed.body, signed.signature));
  }
  assert.equal(f.calls.length, 0);
});

test('configured gated and manual prices cannot create paid entitlements', async () => {
  for (const p of MHP_CATALOG.filter(p => p.availability !== 'standard')) {
    const f = fixture(p.sku); const signed = f.signed({});
    await assert.rejects(f.service.webhook(signed.body,signed.signature), (error: unknown) => error instanceof MhpCommerceError && error.status===422);
    assert.equal(f.calls.length,0); assert.equal(f.providerCalls.length,0);
  }
});
test('restricted key account is checked before payment reads', async () => {
  const f = fixture(); f.stripe.accounts.retrieve = async () => ({ id: 'acct_other' }); const e = f.signed({});
  await assert.rejects(f.service.webhook(e.body, e.signature)); assert.equal(f.calls.length, 0);
});
test('changed price and amount are rejected before the receipt write', async () => {
  const f = fixture(); f.stripe.checkout.sessions.listLineItems = async () => ({ data: [{ price: { id: 'price_other', unit_amount: 1, currency: 'gbp' }, quantity: 1, amount_total: 1 }], has_more: false });
  const e = f.signed({}); await assert.rejects(f.service.webhook(e.body, e.signature)); assert.equal(f.calls.length, 0);
});
for (const sku of ['mhp_course_3x', 'mhp_mentoring_6x']) test(`${sku} schedules exact finite payments and uses paid invoice period`, async () => {
  const f = fixture(sku); const e = f.signed({}); await f.service.webhook(e.body, e.signature);
  assert.deepEqual(f.providerCalls, ['schedule-create','schedule-bounded']);
  const payload = JSON.parse(f.calls[0]!.args[4] as string);
  assert.equal(payload.scheduleId, 'sub_sched_mhp'); assert.equal(payload.periodEnd, new Date((now + 1000) * 1000).toISOString());
});
test('finite schedule clamps month end and never adds months from a delayed current phase', async () => {
  assert.equal(mhpInstalmentEnd(Date.parse('2026-01-31T10:00:00Z') / 1000, 3), Date.parse('2026-04-30T10:00:00Z') / 1000);
  const f = fixture('mhp_course_3x');
  const anchor = now - 35 * 86400;
  const original = f.stripe.invoices.list;
  f.stripe.invoices.list = async () => { const invoices = await original(); invoices.data[0]!.lines.data[0]!.period.start = anchor; return invoices; };
  const e = f.signed({}); await f.service.webhook(e.body, e.signature);
  assert.equal(f.getSchedule().phases[0]!.end_date, mhpInstalmentEnd(anchor, 3));
  assert.notEqual(f.getSchedule().phases[0]!.end_date, mhpInstalmentEnd(now - 100, 3));
});
test('matching schedule metadata cannot hide an extended end date or altered price', async () => {
  const f = fixture('mhp_course_3x'); const e = f.signed({}); await f.service.webhook(e.body, e.signature);
  f.subscription.schedule = 'sub_sched_mhp' as unknown as null;
  const s = f.getSchedule(); s.phases[0]!.end_date += 86400; f.setSchedule(s);
  await assert.rejects(f.service.webhook(e.body, e.signature));
  assert.equal(f.calls.length, 1);
});
test('provider refund cancels future subscription payments first and uses stable idempotency', async () => {
  const f = fixture('mhp_course_3x'); const id = '3895b487-c9d9-4145-9297-74b3e8c51840';
  f.setRefundPlan({ purchaseId: id, accountId: 'acct_mhp', live: false, sessionId, customerId: 'cus_mhp', sku: 'mhp_course_3x', subscriptionId: 'sub_mhp', scheduleId: null, refunded: false, payments: [{ chargeId: 'ch_mhp', amount: 52500, refunded: 0 }] });
  await f.service.refund('session-token', id);
  assert.deepEqual(f.providerCalls, ['cancel', `mhp-full-refund:${id}:ch_mhp`]);
  assert.match(f.calls[0]!.sql, /mhp_begin_refund/); assert.match(f.calls[1]!.sql, /mhp_refund_submitted/);
});
test('refund from another configured account fails before financial changes', async () => {
  const f = fixture(); const id = '3895b487-c9d9-4145-9297-74b3e8c51840';
  f.setRefundPlan({ purchaseId: id, accountId: 'acct_other', live: false, refunded: false, payments: [{}] });
  await assert.rejects(f.service.refund('session-token', id)); assert.equal(f.providerCalls.length, 0);
});
test('manual-pilot account can load with billing disconnected; provider actions stay unavailable', async () => {
  const f = fixture(); const pool = { query: async () => ({ rows: [{ snapshot: { purchases: [], access: MHP_CATALOG[1].grants } }] }) } as unknown as Pick<Pool,'query'>;
  const service = new PgMhpCommerceService(pool,pool,null,null,null);
  assert.deepEqual((await service.snapshot('opaque')).purchases, []);
  await assert.rejects(service.billingPortal('opaque','id'), (e: unknown) => e instanceof MhpCommerceError && e.status === 503);
  assert.equal(f.calls.length, 0);
});
test('account view escapes content and asks for explicit refund confirmation', () => {
  const html = accountPage({ csrf: 'test', billingEnabled: true, snapshot: { access: { ...MHP_CATALOG[1].grants, emailWritable: false, readOnly: false, endsAt: null }, purchases: [{ id: 'purchase', sku: 'mhp_course', name: '<script>bad</script>', status: 'paid', firstPaidAt: new Date().toISOString(), refundUntil: new Date().toISOString(), canRefund: true, refundPending: false, customerId: 'cus_mhp', subscriptionId: null, paidPence: 99700 }] } });
  assert.ok(html.includes('&lt;script&gt;')); assert.ok(!html.includes('<script>bad'));
  assert.match(html, /name="confirm" value="yes" required/); assert.match(html, /action="\/app\/account\/refund"/);
});
test('kit-only accounts can sign out without a Desk link; verified administrator override retains Desk', () => {
  const snapshot = { purchases: [], access: { ...MHP_CATALOG[0].grants, emailWritable: false, readOnly: false, endsAt: null } };
  const html = accountPage({ snapshot, csrf: 'csrf', billingEnabled: false });
  assert.match(html, /action="\/portal\/logout"/); assert.match(html, /name="_csrf" value="csrf"/);
  assert.ok(!html.includes('href="/portal/investors"')); assert.match(html, /kit is a standalone purchase/);
  assert.ok(accountPage({ snapshot, csrf: 'csrf', billingEnabled: false, deskAccess: true }).includes('href="/portal/investors"'));
});
test('startup reconciliation repairs a missing webhook schedule without writing financial receipts', async () => {
  const f = fixture('mhp_course_3x');
  assert.deepEqual(await f.service.reconcileScheduleBatch(), { nextCursor: null, checked: 1, failures: 0 });
  assert.deepEqual(f.providerCalls, ['schedule-create','schedule-bounded']);
  assert.equal(f.calls.length, 0);
});
test('overdue finite plans are automatically cancelled without charges, refunds or synthetic receipts', async () => {
  const f = fixture('mhp_course_3x'); const original = f.stripe.invoices.list;
  f.stripe.invoices.list = async () => { const invoices = await original(); invoices.data[0]!.lines.data[0]!.period.start = now - 120 * 86400; return invoices; };
  assert.deepEqual(await f.service.reconcileScheduleBatch(), { nextCursor: null, checked: 1, failures: 0 });
  assert.deepEqual(f.providerCalls, ['cancel']); assert.equal(f.calls.length, 0);
});
test('reconciliation ignores other brands and refuses a mismatched finite-plan price', async () => {
  const f = fixture('mhp_course_3x'); f.subscription.metadata.brand = 'other_brand';
  assert.deepEqual(await f.service.reconcileScheduleBatch(), { nextCursor: null, checked: 0, failures: 0 });
  f.subscription.metadata.brand = 'martin_howard_property'; f.subscription.items.data[0]!.price.id = 'price_other';
  assert.deepEqual(await f.service.reconcileScheduleBatch(), { nextCursor: null, checked: 0, failures: 1 });
  assert.equal(f.providerCalls.length, 0); assert.equal(f.calls.length, 0);
});
