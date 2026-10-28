import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import Stripe from 'stripe';
import { MHP_BRAND, MHP_CATALOG, MHP_ORIGIN, MHP_STRIPE_EVENTS, mhpProduct, type MhpGrants, type MhpProduct } from './catalog.js';
import type { MhpCommerceConfig } from './commerce-config.js';

type QueryPool = Pick<Pool, 'query'>;
const digest = (value: string | Buffer): Buffer => createHash('sha256').update(value).digest();
const idOf = (value: string | { id: string } | null | undefined): string | null => typeof value === 'string' ? value : value?.id ?? null;
const iso = (seconds: number): string => new Date(seconds * 1_000).toISOString();
/** Stripe monthly billing anchors clamp the original day to the month end. */
export function mhpInstalmentEnd(anchorSeconds: number, months: number): number {
  requireEvidence(Number.isSafeInteger(anchorSeconds) && anchorSeconds > 0 && [3,6].includes(months));
  const anchor = new Date(anchorSeconds * 1_000);
  const target = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + months, 1,
    anchor.getUTCHours(), anchor.getUTCMinutes(), anchor.getUTCSeconds()));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(anchor.getUTCDate(), lastDay));
  return Math.floor(target.getTime() / 1000);
}
export class MhpCommerceError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
function requireEvidence(condition: unknown): asserts condition {
  if (!condition) throw new MhpCommerceError(422, 'Payment evidence does not match the MHP catalogue.');
}
export interface MhpAccess extends MhpGrants { emailWritable: boolean; readOnly: boolean; endsAt: string | null }
export interface MhpAccountPurchase {
  id: string; sku: string; name: string; status: 'paid' | 'cancelled' | 'refunded';
  firstPaidAt: string; refundUntil: string; canRefund: boolean; refundPending: boolean;
  customerId: string; subscriptionId: string | null; paidPence: number;
}
export interface MhpAccountSnapshot { access: MhpAccess; purchases: MhpAccountPurchase[] }
interface PaymentEvidence { id: string; paymentIntentId: string; chargeId: string; amount: number; refunded: number; paidAt: string }
interface PurchaseEvidence {
  sessionId: string; sku: string; customerId: string; subscriptionId: string | null; scheduleId: string | null;
  email: string; live: boolean; cancelled: boolean; firstPaidAt: string; periodEnd: string | null;
  observedAt: string; payments: PaymentEvidence[];
}
interface RefundPlan {
  purchaseId: string; accountId: string; live: boolean; sessionId: string; customerId: string; sku: string; subscriptionId: string | null;
  scheduleId: string | null; refunded: boolean; payments: { chargeId: string; amount: number; refunded: number }[];
}

/** Receipts reconcile current provider state instead of trusting event arrival order. */
export class PgMhpCommerceService {
  private accountCheck?: Promise<void>;
  constructor(private readonly readPool: QueryPool, private readonly commandPool: QueryPool,
    private readonly webhookPool: QueryPool | null, private readonly stripe: Stripe | null,
    private readonly config: MhpCommerceConfig | null, private readonly now: () => number = Date.now) {}

  get billingEnabled(): boolean { return this.config !== null && this.stripe !== null && this.webhookPool !== null; }
  private enabled(): { stripe: Stripe; config: MhpCommerceConfig; pool: QueryPool } {
    if (!this.stripe || !this.config || !this.webhookPool) throw new MhpCommerceError(503, 'MHP billing is not connected yet.');
    return { stripe: this.stripe, config: this.config, pool: this.webhookPool };
  }
  async verifyAccount(): Promise<void> {
    const { stripe, config } = this.enabled();
    if (!this.accountCheck) {
      this.accountCheck = stripe.accounts.retrieve(null).then(account => {
        if (account.id !== config.accountId) throw new MhpCommerceError(503, 'MHP Stripe account does not match its configuration.');
      }).catch(error => { this.accountCheck = undefined; throw error; });
    }
    return this.accountCheck;
  }
  /** Schedule-only recovery for a missing webhook; it never synthesises a receipt or entitlement. */
  async reconcileScheduleBatch(cursor?: string): Promise<{ nextCursor: string | null; checked: number; failures: number }> {
    const { stripe, config } = this.enabled();
    await this.verifyAccount();
    const options: Stripe.RequestOptions = { timeout: 8_000, maxNetworkRetries: 0 };
    const page = await stripe.subscriptions.list({ status: 'all', limit: 25, ...(cursor ? { starting_after: cursor } : {}) }, options);
    let checked = 0, failures = 0;
    let lastId = cursor;
    const deadline = this.now() + 20_000;
    for (const subscription of page.data) {
      if (lastId && this.now() >= deadline) return { nextCursor: lastId, checked, failures };
      const product = mhpProduct(subscription.metadata.sku ?? '');
      try {
        if (subscription.metadata.brand === MHP_BRAND && product?.instalments && subscription.status !== 'canceled') {
          requireEvidence(product.availability === 'standard' && config.prices[product.sku]
            && subscription.livemode === config.live && subscription.items.data.length === 1
            && subscription.items.data[0]!.quantity === 1 && subscription.items.data[0]!.price.id === config.prices[product.sku]
            && subscription.items.data[0]!.price.currency === 'gbp' && subscription.items.data[0]!.price.unit_amount === product.pricePence
            && subscription.items.data[0]!.price.recurring?.interval === 'month' && subscription.items.data[0]!.price.recurring.interval_count === 1);
          const invoices = await stripe.invoices.list({ subscription: subscription.id, status: 'paid', limit: 100 }, options);
          requireEvidence(!invoices.has_more);
          if (invoices.data.length) {
            let anchor = Number.POSITIVE_INFINITY;
            for (const invoice of invoices.data) {
              requireEvidence(invoice.livemode === config.live && invoice.currency === 'gbp' && invoice.amount_paid === product.pricePence
                && idOf(invoice.customer) === idOf(subscription.customer) && !invoice.lines.has_more && invoice.lines.data.length === 1);
              anchor = Math.min(anchor, invoice.lines.data[0]!.period.start);
            }
            const end = mhpInstalmentEnd(anchor, product.instalments);
            if (end <= Math.floor(this.now() / 1000)) {
              const schedule = idOf(subscription.schedule);
              const cancellationOptions = { ...options, idempotencyKey: `mhp-overdue:${subscription.id}:${end}` };
              if (schedule) await stripe.subscriptionSchedules.cancel(schedule, { invoice_now: false, prorate: false }, cancellationOptions);
              else await stripe.subscriptions.cancel(subscription.id, { invoice_now: false, prorate: false }, cancellationOptions);
            } else {
              await this.ensureSchedule(subscription, product, anchor, options);
            }
            checked++;
          }
        }
      } catch {
        // A malformed/changed subscription must not starve every later member.
        // Retry it on the next full sweep; never log customer/provider identifiers.
        failures++;
      }
      lastId = subscription.id;
    }
    return { nextCursor: page.has_more ? lastId ?? null : null, checked, failures };
  }
  async snapshot(sessionToken: string): Promise<MhpAccountSnapshot> {
    const r = await this.readPool.query<{ snapshot: MhpAccountSnapshot }>(
      'SELECT app_private.mhp_account_snapshot($1) AS snapshot', [digest(sessionToken)]);
    if (!r.rows[0]?.snapshot) throw new MhpCommerceError(503, 'Your account could not be loaded.');
    return r.rows[0].snapshot;
  }
  async billingPortal(sessionToken: string, purchaseId: string): Promise<string> {
    const { stripe, config } = this.enabled();
    await this.verifyAccount();
    const owned = (await this.snapshot(sessionToken)).purchases.find(p => p.id === purchaseId);
    if (!owned) throw new MhpCommerceError(403, 'This purchase is not available to your account.');
    const session = await stripe.billingPortal.sessions.create({ customer: owned.customerId,
      configuration: config.portalConfigurationId, return_url: `${MHP_ORIGIN}/app/account` });
    const url = new URL(session.url);
    if (url.protocol !== 'https:' || url.hostname !== 'billing.stripe.com') throw new MhpCommerceError(503, 'Billing portal is unavailable.');
    return url.href;
  }
  async refund(sessionToken: string, purchaseId: string): Promise<void> {
    const { stripe, config } = this.enabled();
    if (!/^[0-9a-f-]{36}$/i.test(purchaseId)) throw new MhpCommerceError(400, 'Choose a valid purchase.');
    await this.verifyAccount();
    const r = await this.commandPool.query<{ plan: RefundPlan }>('SELECT app_private.mhp_begin_refund($1,$2) AS plan', [digest(sessionToken), purchaseId]);
    const plan = r.rows[0]?.plan;
    requireEvidence(plan && plan.accountId === config.accountId && plan.live === config.live && Array.isArray(plan.payments) && plan.payments.length > 0);
    if (plan.refunded) return;
    // Persisted request authorises retries beyond the deadline. Stop future
    // instalments before refunding, including recovery after partial failure.
    if (plan.subscriptionId) {
      const subscription = await stripe.subscriptions.retrieve(plan.subscriptionId);
      if (subscription.status !== 'canceled') {
        const scheduleId = idOf(subscription.schedule);
        if (scheduleId) await stripe.subscriptionSchedules.cancel(scheduleId, { invoice_now: false, prorate: false },
          { idempotencyKey: `mhp-refund-cancel:${purchaseId}` });
        else await stripe.subscriptions.cancel(subscription.id, { invoice_now: false, prorate: false },
          { idempotencyKey: `mhp-refund-cancel:${purchaseId}` });
      }
    }
    const refundable = new Map(plan.payments.map(p => [p.chargeId, p]));
    if (plan.subscriptionId) {
      // A renewal may have settled between the DB claim and cancellation.
      // Reconcile paid invoices after cancellation so it cannot escape a full refund.
      const product = mhpProduct(plan.sku); requireEvidence(product);
      const invoices = await stripe.invoices.list({ subscription: plan.subscriptionId, status: 'paid', limit: 100 });
      requireEvidence(!invoices.has_more);
      for (const invoice of invoices.data) {
        requireEvidence(idOf(invoice.customer) === plan.customerId && invoice.amount_paid === product.pricePence && invoice.currency === 'gbp' && invoice.livemode === config.live);
        const ip = await stripe.invoicePayments.list({ invoice: invoice.id, status: 'paid', limit: 2 });
        requireEvidence(!ip.has_more && ip.data.length === 1 && ip.data[0]!.payment.type === 'payment_intent');
        const pi = idOf(ip.data[0]!.payment.payment_intent); requireEvidence(pi);
        const payment = await this.paymentEvidence(pi, invoice.id);
        refundable.set(payment.chargeId, payment);
      }
    }
    for (const payment of refundable.values()) {
      const charge = await stripe.charges.retrieve(payment.chargeId);
      requireEvidence(charge.livemode === config.live && charge.currency === 'gbp' && charge.amount === payment.amount);
      if (charge.amount_refunded >= charge.amount) continue;
      // Re-read the charge each retry and omit amount: refund the remaining
      // balance. Stable per-charge idempotency prevents duplicate requests.
      await stripe.refunds.create({ charge: charge.id, metadata: { mhp_purchase_id: purchaseId } },
        { idempotencyKey: `mhp-full-refund:${purchaseId}:${charge.id}` });
    }
    await this.commandPool.query('SELECT app_private.mhp_refund_submitted($1,$2)', [digest(sessionToken), purchaseId]);
    // Only the signed provider event changes the entitlement to read-only.
  }
  async webhook(raw: Buffer, signature: string): Promise<void> {
    const { stripe, config, pool } = this.enabled();
    let event: Stripe.Event;
    try { event = stripe.webhooks.constructEvent(raw, signature, config.webhookSecret, 300); }
    catch { throw new MhpCommerceError(400, 'Invalid Stripe signature.'); }
    requireEvidence(event.livemode === config.live && (!event.account || event.account === config.accountId));
    if (!(MHP_STRIPE_EVENTS as readonly string[]).includes(event.type)) return;
    await this.verifyAccount();
    const observedAt = new Date(this.now()).toISOString();
    const sessionId = await this.sessionForEvent(event);
    const evidence = await this.purchaseEvidence(sessionId, observedAt);
    await pool.query('SELECT app_private.record_mhp_commerce_event($1,$2,$3,$4,$5)',
      [config.accountId, event.id, event.type, digest(raw), JSON.stringify(evidence)]);
  }
  private async sessionForEvent(event: Stripe.Event): Promise<string> {
    const { stripe, config, pool } = this.enabled();
    if (event.type === 'checkout.session.completed') return event.data.object.id;
    let subscription: string | null = null;
    let charge: string | null = null;
    if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.deleted') subscription = event.data.object.id;
    else if (event.type === 'invoice.paid' || event.type === 'invoice.payment_failed') {
      const invoice = await stripe.invoices.retrieve(event.data.object.id);
      subscription = idOf(invoice.parent?.subscription_details?.subscription);
    } else if (event.type === 'charge.refunded') charge = event.data.object.id;
    const found = await pool.query<{ session: string | null }>('SELECT app_private.mhp_purchase_for_provider($1,$2,$3) AS session', [config.accountId, charge, subscription]);
    if (found.rows[0]?.session) return found.rows[0].session;
    if (subscription) {
      const sessions = await stripe.checkout.sessions.list({ subscription, limit: 2 });
      requireEvidence(sessions.data.length === 1 && !sessions.has_more && sessions.data[0]?.status === 'complete');
      return sessions.data[0]!.id;
    }
    // A refund arriving before its checkout receipt must retry. Never claim a
    // receipt processed while silently dropping its financial consequence.
    throw new MhpCommerceError(503, 'The related purchase has not been recorded yet.');
  }
  private async paymentEvidence(paymentIntentId: string, providerId: string, paidAt?: number): Promise<PaymentEvidence> {
    const { stripe, config } = this.enabled();
    const intent = await stripe.paymentIntents.retrieve(paymentIntentId);
    requireEvidence(intent.status === 'succeeded' && intent.livemode === config.live && intent.currency === 'gbp');
    const chargeId = idOf(intent.latest_charge); requireEvidence(chargeId);
    const charge = await stripe.charges.retrieve(chargeId);
    requireEvidence(charge.paid && charge.livemode === config.live && charge.currency === 'gbp' && charge.amount === intent.amount_received);
    return { id: providerId, paymentIntentId, chargeId, amount: charge.amount, refunded: charge.amount_refunded, paidAt: iso(paidAt ?? charge.created) };
  }
  private validateSchedule(schedule: Stripe.SubscriptionSchedule, product: MhpProduct, anchor: number): void {
    const { config } = this.enabled();
    requireEvidence(product.instalments && schedule.end_behavior === 'cancel' && schedule.metadata?.mhp_sku === product.sku
      && schedule.metadata.mhp_instalments === String(product.instalments) && schedule.metadata.mhp_anchor === String(anchor)
      && schedule.phases.length === 1);
    const phase = schedule.phases[0]!;
    requireEvidence(phase.end_date === mhpInstalmentEnd(anchor, product.instalments) && phase.start_date >= anchor
      && phase.start_date < phase.end_date && phase.items.length === 1 && phase.items[0]!.quantity === 1
      && idOf(phase.items[0]!.price) === config.prices[product.sku] && !phase.trial_end
      && phase.discounts.length === 0 && phase.items[0]!.discounts.length === 0);
  }
  private async ensureSchedule(subscription: Stripe.Subscription, product: MhpProduct, anchor: number, options: Stripe.RequestOptions = {}): Promise<string | null> {
    const { stripe, config } = this.enabled();
    if (!product.instalments) return idOf(subscription.schedule);
    const priceId = config.prices[product.sku];
    requireEvidence(product.availability === 'standard' && priceId);
    let scheduleId = idOf(subscription.schedule);
    if (!scheduleId) {
      requireEvidence(subscription.status !== 'canceled');
      try {
        const created = await stripe.subscriptionSchedules.create({ from_subscription: subscription.id },
          { ...options, idempotencyKey: `mhp-schedule:${subscription.id}` });
        scheduleId = created.id;
      } catch (error) {
        const current = await stripe.subscriptions.retrieve(subscription.id, {}, options);
        scheduleId = idOf(current.schedule);
        if (!scheduleId) throw error;
      }
    }
    const schedule = await stripe.subscriptionSchedules.retrieve(scheduleId, {}, options);
    requireEvidence(schedule.livemode === config.live && idOf(schedule.customer) === idOf(subscription.customer));
    if (schedule.metadata?.mhp_sku === product.sku) {
      this.validateSchedule(schedule, product, anchor);
      return scheduleId;
    }
    requireEvidence(!schedule.metadata?.mhp_sku && schedule.phases.length === 1 && schedule.status === 'active');
    const phase = schedule.phases[0]!;
    requireEvidence(phase.items.length === 1 && idOf(phase.items[0]!.price) === config.prices[product.sku] && phase.items[0]!.quantity === 1);
    const end = mhpInstalmentEnd(anchor, product.instalments);
    requireEvidence(phase.start_date >= anchor && phase.start_date < end && end > Math.floor(this.now() / 1000));
    const updated = await stripe.subscriptionSchedules.update(scheduleId, { end_behavior: 'cancel',
      metadata: { mhp_sku: product.sku, mhp_instalments: String(product.instalments), mhp_anchor: String(anchor) }, proration_behavior: 'none',
      phases: [{ start_date: phase.start_date, end_date: end,
        items: [{ price: priceId, quantity: 1 }], proration_behavior: 'none' }] },
    { ...options, idempotencyKey: `mhp-schedule-terms:${subscription.id}` });
    this.validateSchedule(updated, product, anchor);
    return scheduleId;
  }
  private async purchaseEvidence(sessionId: string, observedAt: string): Promise<PurchaseEvidence> {
    const { stripe, config } = this.enabled();
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    const lines = await stripe.checkout.sessions.listLineItems(sessionId, { limit: 2 });
    requireEvidence(session.status === 'complete' && session.payment_status === 'paid' && session.livemode === config.live
      && session.currency === 'gbp' && lines.data.length === 1 && !lines.has_more);
    const line = lines.data[0]!;
    const product = MHP_CATALOG.find(p => config.prices[p.sku] === line.price?.id);
    requireEvidence(product && product.availability === 'standard' && config.prices[product.sku]
      && line.quantity === 1 && line.price?.unit_amount === product.pricePence
      && line.price.currency === 'gbp' && line.amount_total === product.pricePence && session.amount_total === product.pricePence
      && session.total_details?.amount_discount === 0 && (session.total_details?.amount_tax ?? 0) === 0
      && session.mode === (product.interval ? 'subscription' : 'payment'));
    const customerId = idOf(session.customer);
    const email = session.customer_details?.email?.trim().toLowerCase();
    requireEvidence(customerId && email && email.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email));
    const subscriptionId = idOf(session.subscription);
    let scheduleId: string | null = null, periodEnd: string | null = null, cancelled = false;
    const payments: PaymentEvidence[] = [];
    let paidPeriodEnd = 0;
    let firstPeriodStart = Number.POSITIVE_INFINITY;
    if (product.interval) {
      requireEvidence(subscriptionId);
      const subscription = await stripe.subscriptions.retrieve(subscriptionId);
      requireEvidence(subscription.livemode === config.live && idOf(subscription.customer) === customerId
        && subscription.items.data.length === 1 && subscription.items.data[0]!.price.id === line.price.id
        && subscription.items.data[0]!.quantity === 1 && subscription.items.data[0]!.price.recurring?.interval === product.interval);
      const invoices = await stripe.invoices.list({ subscription: subscriptionId, status: 'paid', limit: 100 });
      requireEvidence(!invoices.has_more); // bounded; do not silently truncate paid instalments
      for (const invoice of invoices.data) {
        requireEvidence(invoice.amount_paid === product.pricePence && invoice.currency === 'gbp' && invoice.livemode === config.live);
        requireEvidence(!invoice.lines.has_more && invoice.lines.data.length === 1 && invoice.lines.data[0]!.period.end > 0);
        paidPeriodEnd = Math.max(paidPeriodEnd, invoice.lines.data[0]!.period.end);
        firstPeriodStart = Math.min(firstPeriodStart, invoice.lines.data[0]!.period.start);
        const ip = await stripe.invoicePayments.list({ invoice: invoice.id, status: 'paid', limit: 2 });
        requireEvidence(!ip.has_more && ip.data.length === 1 && ip.data[0]!.payment.type === 'payment_intent');
        const pi = idOf(ip.data[0]!.payment.payment_intent); requireEvidence(pi);
        payments.push(await this.paymentEvidence(pi, invoice.id, invoice.status_transitions.paid_at ?? undefined));
      }
      requireEvidence(payments.length > 0);
      cancelled = ['canceled', 'unpaid', 'incomplete_expired', 'paused'].includes(subscription.status);
      // A fully paid finite schedule can already have completed and detached.
      if (product.instalments && !subscription.schedule && cancelled) {
        const prior = await this.enabled().pool.query<{ schedule: string | null }>('SELECT app_private.mhp_purchase_schedule($1,$2) AS schedule', [config.accountId, sessionId]);
        requireEvidence(prior.rows[0]?.schedule);
        const completed = await stripe.subscriptionSchedules.retrieve(prior.rows[0].schedule);
        requireEvidence(completed.metadata?.mhp_sku === product.sku && completed.end_behavior === 'cancel'
          && idOf(completed.customer) === customerId && completed.livemode === config.live);
        this.validateSchedule(completed, product, firstPeriodStart);
        scheduleId = completed.id;
      } else scheduleId = await this.ensureSchedule(subscription, product, firstPeriodStart);
      requireEvidence(!product.instalments || payments.length <= product.instalments);
      // A failed renewal can move Stripe's current period forward. Access is
      // bounded by the last paid invoice, never an unpaid future period.
      periodEnd = iso(paidPeriodEnd);
    } else {
      const pi = idOf(session.payment_intent); requireEvidence(pi && !subscriptionId);
      payments.push(await this.paymentEvidence(pi, pi));
    }
    payments.sort((a, b) => a.paidAt.localeCompare(b.paidAt));
    return { sessionId, sku: product.sku, customerId, subscriptionId, scheduleId, email, live: config.live,
      cancelled, firstPaidAt: payments[0]!.paidAt, periodEnd, observedAt, payments };
  }
}
