import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import Stripe from 'stripe';
import { MHP_BRAND, MHP_CATALOG, MHP_ORIGIN, MHP_PRIVATE_TERMS_URL, MHP_SITE, MHP_STRIPE_EVENTS, MHP_TERMS_URL, mhpCourseSku, mhpPriceStatement,
  mhpPrivateOfferAllowed, mhpProduct, mhpSellable, type MhpCoursePlan, type MhpGrants, type MhpPrivateOffer, type MhpProduct } from './catalog.js';
import type { MhpCommerceConfig } from './commerce-config.js';

/** Where Stripe returns a buyer. Static pages on the public site explain what happens next. */
export const MHP_COURSE_WELCOME_URL = `${MHP_SITE}/join/welcome/`;
export const MHP_MENTORING_WELCOME_URL = `${MHP_SITE}/mentoring/welcome/`;
const WINDOW_SKUS = ['mhp_course_web', 'mhp_course_web_3x'] as const;
/** Stripe's shortest Checkout expiry is 30 minutes; one extra minute covers network time. */
const MIN_CHECKOUT_SECONDS = 1_860;
export interface MhpPrivateOfferLink {
  id: string; url: string; active: boolean; paid: boolean; sku: string; name: string; priceStatement: string;
  applicationId: string; email: string; createdAt: string;
}
/** Returned once a checkout receipt is recorded, so the router can send the welcome email. */
export interface MhpPurchaseNotice { email: string; name: string; sku: string; productName: string; kind: 'course' | 'mentoring' }

type QueryPool = Pick<Pool, 'query'>;
const digest = (value: string | Buffer): Buffer => createHash('sha256').update(value).digest();
const idOf = (value: string | { id: string } | null | undefined): string | null => typeof value === 'string' ? value : value?.id ?? null;
const iso = (seconds: number): string => new Date(seconds * 1_000).toISOString();
/** Stripe monthly billing anchors clamp the original day to the month end. */
export function mhpInstalmentEnd(anchorSeconds: number, months: number): number {
  requireEvidence(Number.isSafeInteger(anchorSeconds) && anchorSeconds > 0 && [3,6,12].includes(months));
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
export interface MhpCourseCreditSnapshot {
  availablePence: number; expiresAt: string | null; status: 'available' | 'reserved' | 'used' | 'expired' | 'unavailable';
  checkoutExpiresAt: string | null;
}
interface CreditCheckoutPlan {
  id: string; creditId: string; actorId: string; sourcePurchaseId: string; accountId: string; live: boolean;
  customerId: string; email: string; cataloguePriceId: string; productId: string; amountPence: number;
  expiresAt: string; sessionId: string | null; url: string | null; status: 'creating' | 'open' | 'complete' | 'expired';
}
interface PaymentEvidence { id: string; paymentIntentId: string; chargeId: string; amount: number; refunded: number; paidAt: string }
interface PurchaseEvidence {
  sessionId: string; sku: string; customerId: string; subscriptionId: string | null; scheduleId: string | null;
  email: string; live: boolean; cancelled: boolean; firstPaidAt: string; periodEnd: string | null;
  observedAt: string; payments: PaymentEvidence[]; creditAttemptId?: string;
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
  /** True only with a sandbox (rk_test_) key; enables the app's sandbox checkout test page. */
  get sandbox(): boolean { return this.billingEnabled && this.config?.live === false; }
  /** Webinar-price cut-over in milliseconds, or null when billing is off. */
  get windowEndsAt(): number | null { return this.config?.windowEndsAt ?? null; }
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
          requireEvidence(mhpSellable(product) && config.prices[product.sku]
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
  async creditSnapshot(sessionToken: string): Promise<MhpCourseCreditSnapshot> {
    const r = await this.readPool.query<{ snapshot: MhpCourseCreditSnapshot }>(
      'SELECT app_private.mhp_course_credit_snapshot($1) AS snapshot', [digest(sessionToken)]);
    if (!r.rows[0]?.snapshot) throw new MhpCommerceError(503, 'Your course credit could not be loaded.');
    return r.rows[0].snapshot;
  }
  /** An authenticated, purchase-bound credit; never a public discount code. */
  async courseCheckout(sessionToken: string, commandId: string): Promise<string> {
    const { stripe, config } = this.enabled();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(commandId)) throw new MhpCommerceError(400, 'Reload your account and try again.');
    await this.verifyAccount();
    const priceId = config.prices.mhp_course; requireEvidence(priceId);
    const price = await stripe.prices.retrieve(priceId, { expand: ['product'] });
    const product = price.product;
    requireEvidence(price.active && price.livemode === config.live && price.currency === 'gbp' && price.unit_amount === 149700
      && price.type === 'one_time' && typeof product !== 'string' && !product.deleted
      && product.metadata.brand === MHP_BRAND && product.metadata.sku === 'mhp_course');
    // Founder-approved: 30 minutes to finish, plus up to one minute for setup.
    // This leaves room for Stripe's 30-minute creation floor and network time.
    // The exact deadline is persisted and never extends on retries.
    const expiresAt = iso(Math.floor(this.now() / 1000) + 1860);
    const r = await this.commandPool.query<{ plan: CreditCheckoutPlan }>(
      'SELECT app_private.mhp_begin_course_checkout($1,$2,$3,$4,$5) AS plan', [digest(sessionToken), commandId, price.id, product.id, expiresAt]);
    const plan = r.rows[0]?.plan;
    requireEvidence(plan && plan.accountId === config.accountId && plan.live === config.live && plan.cataloguePriceId === priceId && plan.productId === product.id && plan.amountPence === 145000);
    if (plan.status === 'complete') throw new MhpCommerceError(409, 'Your course payment is being confirmed. Refresh your account shortly.');
    if (plan.status === 'expired') throw new MhpCommerceError(409, 'That checkout has expired. Reload your account to start again.');
    const session = await this.ensureCreditSession(plan, this.commandPool);
    if (session.status !== 'open' || !session.url) throw new MhpCommerceError(409, 'That checkout is no longer open. Reload your account to see its status.');
    const url = new URL(session.url);
    requireEvidence(url.protocol === 'https:' && url.hostname === 'checkout.stripe.com');
    return url.href;
  }
  private checkCreditSession(session: Stripe.Checkout.Session, plan: CreditCheckoutPlan): void {
    const { config } = this.enabled();
    requireEvidence(plan.accountId === config.accountId && plan.live === config.live && session.livemode === config.live
      && idOf(session.customer) === plan.customerId && session.mode === 'payment' && !session.subscription
      && session.metadata?.brand === MHP_BRAND && session.metadata.sku === 'mhp_course'
      && session.metadata.mhp_credit_attempt === plan.id && session.metadata.mhp_account === plan.actorId
      && session.client_reference_id === plan.id && session.amount_total === plan.amountPence && session.currency === 'gbp'
      && session.expires_at === Math.floor(Date.parse(plan.expiresAt) / 1000)
      && (session.total_details?.amount_discount ?? 0) === 0 && (session.total_details?.amount_tax ?? 0) === 0);
  }
  private async ensureCreditSession(plan: CreditCheckoutPlan, pool: QueryPool): Promise<Stripe.Checkout.Session> {
    const { stripe, config } = this.enabled();
    let session: Stripe.Checkout.Session | undefined;
    if (plan.sessionId) session = await stripe.checkout.sessions.retrieve(plan.sessionId);
    else {
      // A network failure can occur after Stripe created the session but before
      // its ID was saved. Recover it before retrying the stable create command.
      const prior = await stripe.checkout.sessions.list({ customer: plan.customerId, limit: 100 }, { timeout: 8_000, maxNetworkRetries: 0 });
      requireEvidence(!prior.has_more);
      const matches = prior.data.filter(s => s.metadata?.mhp_credit_attempt === plan.id);
      requireEvidence(matches.length <= 1);
      session = matches[0];
      if (!session) {
        try {
          session = await stripe.checkout.sessions.create({ mode: 'payment', customer: plan.customerId,
            client_reference_id: plan.id, expires_at: Math.floor(Date.parse(plan.expiresAt) / 1000),
            payment_method_types: ['card'], billing_address_collection: 'required', customer_update: { name: 'auto', address: 'auto' },
            allow_promotion_codes: false, invoice_creation: { enabled: true },
            line_items: [{ price_data: { product: plan.productId, currency: 'gbp', unit_amount: plan.amountPence }, quantity: 1 }],
            custom_text: { submit: { message: 'Your £47 Deal Desk credit is included. Course total: £1,450.' } },
            metadata: { brand: MHP_BRAND, sku: 'mhp_course', mhp_credit_attempt: plan.id, mhp_account: plan.actorId },
            payment_intent_data: { metadata: { brand: MHP_BRAND, sku: 'mhp_course', mhp_credit_attempt: plan.id, mhp_account: plan.actorId } },
            success_url: `${MHP_ORIGIN}/app/account?course=received`, cancel_url: `${MHP_ORIGIN}/app/account` },
          { idempotencyKey: `mhp-course-credit:${plan.id}`, timeout: 8_000, maxNetworkRetries: 1 });
        } catch (error) {
          // A rejected expiry creates no provider object. Release only this
          // known non-executed attempt; uncertain/network failures stay held.
          if (error instanceof Stripe.errors.StripeInvalidRequestError && error.param === 'expires_at') {
            await pool.query('SELECT app_private.mhp_abandon_credit_checkout($1,$2)', [plan.id, config.accountId]);
            throw new MhpCommerceError(409, 'The checkout reservation expired. Reload your account and try again.');
          }
          throw error;
        }
      }
    }
    this.checkCreditSession(session, plan);
    await pool.query('SELECT app_private.mhp_record_credit_checkout($1,$2,$3,$4,$5,$6)',
      [plan.id, config.accountId, session.id, session.url, session.status, iso(session.expires_at)]);
    return session;
  }
  private async closeCreditCheckouts(purchaseSession: string, pool: QueryPool): Promise<void> {
    const { stripe, config } = this.enabled();
    const r = await pool.query<{ plans: CreditCheckoutPlan[] }>('SELECT app_private.mhp_credit_refund_checkouts($1,$2) AS plans', [config.accountId, purchaseSession]);
    for (const plan of r.rows[0]?.plans ?? []) {
      let session: Stripe.Checkout.Session;
      try { session = await this.ensureCreditSession(plan, pool); }
      catch (error) { if (error instanceof MhpCommerceError && error.status === 409) continue; throw error; }
      if (session.status === 'open') {
        try { session = await stripe.checkout.sessions.expire(session.id, {}, { idempotencyKey: `mhp-credit-refund-expire:${plan.id}` }); }
        catch { session = await stripe.checkout.sessions.retrieve(session.id); }
        this.checkCreditSession(session, plan);
        requireEvidence(session.status !== 'open');
        await pool.query('SELECT app_private.mhp_record_credit_checkout($1,$2,$3,$4,$5,$6)',
          [plan.id, config.accountId, session.id, session.url, session.status, iso(session.expires_at)]);
      }
      // A course already paid remains a separate purchase. Refunding the Desk
      // does not silently charge £47 back or cancel that course.
    }
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
    if (plan.sku === 'mhp_deal_desk') await this.closeCreditCheckouts(plan.sessionId, this.commandPool);
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
  async webhook(raw: Buffer, signature: string): Promise<MhpPurchaseNotice | null | void> {
    const { stripe, config, pool } = this.enabled();
    let event: Stripe.Event;
    try { event = stripe.webhooks.constructEvent(raw, signature, config.webhookSecret, 300); }
    catch { throw new MhpCommerceError(400, 'Invalid Stripe signature.'); }
    requireEvidence(event.livemode === config.live && (!event.account || event.account === config.accountId));
    if (!(MHP_STRIPE_EVENTS as readonly string[]).includes(event.type)) return null;
    await this.verifyAccount();
    const observedAt = new Date(this.now()).toISOString();
    const sessionId = await this.sessionForEvent(event);
    const { evidence, buyerName } = await this.purchaseEvidence(sessionId, observedAt);
    if (evidence.sku === 'mhp_deal_desk' && evidence.payments.every(p => p.refunded === p.amount)) {
      // Freeze new reservations before enumerating sessions. Otherwise a buyer
      // could open another discounted checkout between expiry and the receipt.
      await pool.query('SELECT app_private.mhp_freeze_course_credit($1,$2)', [config.accountId, sessionId]);
      await this.closeCreditCheckouts(sessionId, pool);
    }
    await pool.query('SELECT app_private.record_mhp_commerce_event($1,$2,$3,$4,$5)',
      [config.accountId, event.id, event.type, digest(raw), JSON.stringify(evidence)]);
    if (event.type !== 'checkout.session.completed' || evidence.cancelled || evidence.payments.every(p => p.refunded === p.amount)) return null;
    const product = mhpProduct(evidence.sku);
    if (!product) return null;
    if (product.availability === 'window' && Date.parse(evidence.firstPaidAt) >= config.windowEndsAt) {
      // Only possible if the cut-over expiry could not reach Stripe. Recorded so the
      // money and access stay consistent; logged without identifiers for the owner.
      console.warn(JSON.stringify({ event: 'mhp.window.late-payment', sku: product.sku }));
    }
    const name = buyerName || evidence.email.split('@')[0]!;
    return { email: evidence.email, name, sku: product.sku, productName: product.name,
      kind: product.type === 'course' ? 'course' : 'mentoring' };
  }
  /** Public course checkout. The server clock picks the price; a browser cannot choose the webinar price. */
  async publicCourseCheckout(plan: MhpCoursePlan): Promise<string> {
    const { stripe, config } = this.enabled();
    if (plan !== 'full' && plan !== '3x') throw new MhpCommerceError(400, 'Choose a payment option.');
    await this.verifyAccount();
    const now = this.now();
    const sku = mhpCourseSku(plan, now, config.windowEndsAt);
    const product = mhpProduct(sku); const priceId = config.prices[sku];
    requireEvidence(product && priceId);
    const nowSeconds = Math.floor(now / 1_000), windowEnd = Math.floor(config.windowEndsAt / 1_000);
    // A window checkout expires at the window end; in the final 31 minutes Stripe's
    // 30-minute floor applies and the window closer expires it at the cut-over.
    const expiresAt = product.availability === 'window'
      ? Math.max(nowSeconds + MIN_CHECKOUT_SECONDS, Math.min(nowSeconds + 23 * 3_600, windowEnd))
      : nowSeconds + 23 * 3_600;
    const statement = mhpPriceStatement(product);
    const metadata = { brand: MHP_BRAND, sku, mhp_checkout: 'course' };
    const session = await stripe.checkout.sessions.create({
      mode: product.interval ? 'subscription' : 'payment', line_items: [{ price: priceId, quantity: 1 }], expires_at: expiresAt,
      billing_address_collection: 'required', allow_promotion_codes: false, payment_method_types: ['card'],
      consent_collection: { terms_of_service: 'required' },
      custom_text: {
        terms_of_service_acceptance: { message: `I agree to the [course terms](${MHP_TERMS_URL}), including the 30-day refund policy.` },
        submit: { message: `${product.name}. ${statement}` },
      },
      metadata,
      ...(product.interval
        ? { subscription_data: { metadata, description: statement } }
        : { customer_creation: 'always' as const, invoice_creation: { enabled: true }, payment_intent_data: { metadata } }),
      success_url: MHP_COURSE_WELCOME_URL, cancel_url: `${MHP_SITE}/join/`,
    }, { timeout: 8_000, maxNetworkRetries: 1 });
    requireEvidence(session.livemode === config.live && session.status === 'open' && session.url && session.amount_total === product.pricePence);
    const url = new URL(session.url);
    requireEvidence(url.protocol === 'https:' && url.hostname === 'checkout.stripe.com');
    return url.href;
  }
  /**
   * Expire every open webinar-price checkout once the window has ended. Stripe
   * already expires checkouts created more than 31 minutes before the end; this
   * closes the rest at the cut-over. Idempotent; returns counts only.
   */
  async expireWindowCheckouts(): Promise<{ expired: number; stillOpen: number }> {
    const { stripe, config } = this.enabled();
    if (this.now() < config.windowEndsAt) return { expired: 0, stillOpen: 0 };
    await this.verifyAccount();
    const options: Stripe.RequestOptions = { timeout: 8_000, maxNetworkRetries: 1 };
    const sessions = await stripe.checkout.sessions.list({ status: 'open', limit: 100,
      created: { gte: Math.floor(config.windowEndsAt / 1_000) - 25 * 3_600 } }, options).autoPagingToArray({ limit: 2_000 });
    let expired = 0, stillOpen = 0;
    for (const session of sessions) {
      if (session.metadata?.brand !== MHP_BRAND || !(WINDOW_SKUS as readonly string[]).includes(session.metadata.sku ?? '')) continue;
      try {
        const closed = await stripe.checkout.sessions.expire(session.id, {}, { ...options, idempotencyKey: `mhp-window-expire:${session.id}` });
        if (closed.status === 'open') stillOpen++; else expired++;
      } catch {
        const current = await stripe.checkout.sessions.retrieve(session.id, {}, options).catch(() => null);
        if (!current || current.status === 'open') stillOpen++;
      }
    }
    return { expired, stillOpen };
  }
  /** Single-use private link for a named applicant. Callers must already have proved the owner and the application. */
  async createPrivateOffer(input: { sku: string; commandId: string; applicationId: string; applicationReceivedAt: string;
    email: string; name: string; createdBy: string }): Promise<MhpPrivateOfferLink> {
    const { stripe, config } = this.enabled();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.commandId)
      || !/^[0-9a-f-]{36}$/i.test(input.applicationId)) throw new MhpCommerceError(400, 'Reload the applications page and try again.');
    if (!mhpPrivateOfferAllowed(input.sku, input.applicationReceivedAt)) {
      throw new MhpCommerceError(400, 'That offer is not available for this application. Founding prices need an application received by 7 November, 23:59 GMT.');
    }
    const sku: MhpPrivateOffer = input.sku;
    const product = mhpProduct(sku); const priceId = config.prices[sku];
    requireEvidence(product && priceId);
    await this.verifyAccount();
    const statement = mhpPriceStatement(product);
    const isPrivate = sku === 'mhp_private' || sku === 'mhp_private_12x';
    const metadata = { brand: MHP_BRAND, sku, mhp_offer_link: '1', mhp_application: input.applicationId,
      mhp_email: input.email.slice(0, 320), mhp_created_by: input.createdBy.slice(0, 320), mhp_created_at: new Date(this.now()).toISOString() };
    const link = await stripe.paymentLinks.create({
      line_items: [{ price: priceId, quantity: 1 }], restrictions: { completed_sessions: { limit: 1 } },
      after_completion: { type: 'redirect', redirect: { url: MHP_MENTORING_WELCOME_URL } },
      billing_address_collection: 'required', allow_promotion_codes: false, consent_collection: { terms_of_service: 'required' },
      inactive_message: 'This payment link has already been used or has been withdrawn. Reply to Martin’s email and he will send a new one.',
      custom_text: {
        terms_of_service_acceptance: { message: isPrivate
          ? `I agree to the [One Lane Private terms](${MHP_PRIVATE_TERMS_URL}): a full refund up to the first one-to-one session, then as those terms set out.`
          : `I agree to the [terms](${MHP_TERMS_URL}), including the 30-day refund policy.` },
        submit: { message: `${product.name} for ${input.name.slice(0, 80)}. ${statement}` },
      },
      metadata,
      ...(product.interval
        ? { subscription_data: { metadata: { brand: MHP_BRAND, sku, mhp_application: input.applicationId }, description: statement } }
        : { customer_creation: 'always' as const, invoice_creation: { enabled: true }, payment_intent_data: { metadata: { brand: MHP_BRAND, sku, mhp_application: input.applicationId } } }),
    }, { idempotencyKey: `mhp-private-offer:${input.commandId}`, timeout: 8_000, maxNetworkRetries: 1 });
    const offer = this.offerFromLink(link);
    requireEvidence(offer && link.livemode === config.live && offer.applicationId === input.applicationId && offer.sku === sku);
    return offer;
  }
  private offerFromLink(link: Stripe.PaymentLink): MhpPrivateOfferLink | null {
    const m = link.metadata ?? {};
    const product = mhpProduct(m.sku ?? '');
    if (m.brand !== MHP_BRAND || m.mhp_offer_link !== '1' || !product || product.availability !== 'private') return null;
    const url = new URL(link.url);
    if (url.protocol !== 'https:' || (url.hostname !== 'buy.stripe.com' && !url.hostname.endsWith('.stripe.com'))) return null;
    if (m.mhp_email) url.searchParams.set('prefilled_email', m.mhp_email);
    const used = (link.restrictions?.completed_sessions?.count ?? 0) >= 1;
    return { id: link.id, url: url.href, active: link.active, paid: used, sku: product.sku, name: product.name,
      priceStatement: mhpPriceStatement(product), applicationId: m.mhp_application ?? '', email: m.mhp_email ?? '', createdAt: m.mhp_created_at ?? '' };
  }
  /** Owner-created links, newest first. Stripe is the record; nothing is copied into the database. */
  async privateOffers(): Promise<MhpPrivateOfferLink[]> {
    const { stripe } = this.enabled();
    await this.verifyAccount();
    const links = await stripe.paymentLinks.list({ limit: 100 }, { timeout: 8_000, maxNetworkRetries: 1 }).autoPagingToArray({ limit: 1_000 });
    return links.map(link => this.offerFromLink(link)).filter((o): o is MhpPrivateOfferLink => o !== null)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async withdrawPrivateOffer(linkId: string): Promise<void> {
    const { stripe } = this.enabled();
    if (!/^plink_[A-Za-z0-9]+$/.test(linkId)) throw new MhpCommerceError(400, 'Choose a saved link.');
    await this.verifyAccount();
    const link = await stripe.paymentLinks.retrieve(linkId);
    if (!this.offerFromLink(link)) throw new MhpCommerceError(404, 'That link is not an applicant link.');
    if (link.active) await stripe.paymentLinks.update(linkId, { active: false });
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
      if (!subscription && event.type === 'invoice.paid') {
        const payments = await stripe.invoicePayments.list({ invoice: invoice.id, status: 'paid', limit: 2 });
        requireEvidence(!payments.has_more && payments.data.length === 1 && payments.data[0]!.payment.type === 'payment_intent');
        const intent = idOf(payments.data[0]!.payment.payment_intent); requireEvidence(intent);
        const sessions = await stripe.checkout.sessions.list({ payment_intent: intent, limit: 2 });
        requireEvidence(!sessions.has_more && sessions.data.length === 1 && sessions.data[0]?.status === 'complete');
        return sessions.data[0]!.id;
      }
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
  private async paymentEvidence(paymentIntentId: string, providerId: string, paidAt?: number, credit?: CreditCheckoutPlan): Promise<PaymentEvidence> {
    const { stripe, config } = this.enabled();
    const intent = await stripe.paymentIntents.retrieve(paymentIntentId);
    requireEvidence(intent.status === 'succeeded' && intent.livemode === config.live && intent.currency === 'gbp');
    if (credit) requireEvidence(intent.amount_received === credit.amountPence && idOf(intent.customer) === credit.customerId
      && intent.metadata.brand === MHP_BRAND && intent.metadata.sku === 'mhp_course'
      && intent.metadata.mhp_credit_attempt === credit.id && intent.metadata.mhp_account === credit.actorId);
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
    requireEvidence(mhpSellable(product) && priceId);
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
  /** buyerName is for the welcome email only; it is never stored as purchase evidence. */
  private async purchaseEvidence(sessionId: string, observedAt: string): Promise<{ evidence: PurchaseEvidence; buyerName: string }> {
    const { stripe, config } = this.enabled();
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    const lines = await stripe.checkout.sessions.listLineItems(sessionId, { limit: 2 });
    requireEvidence(session.status === 'complete' && session.payment_status === 'paid' && session.livemode === config.live
      && session.currency === 'gbp' && lines.data.length === 1 && !lines.has_more);
    const line = lines.data[0]!;
    requireEvidence(line.price);
    let credit: CreditCheckoutPlan | undefined;
    if (session.metadata?.mhp_credit_attempt) {
      requireEvidence(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(session.metadata.mhp_credit_attempt));
      const found = await this.enabled().pool.query<{ plan: CreditCheckoutPlan }>('SELECT app_private.mhp_credit_evidence($1,$2,$3) AS plan',
        [config.accountId, session.id, session.metadata.mhp_credit_attempt]);
      credit = found.rows[0]?.plan;
      requireEvidence(credit && credit.cataloguePriceId === config.prices.mhp_course && credit.amountPence === 145000);
      this.checkCreditSession(session, credit);
    }
    const product = credit ? mhpProduct('mhp_course') : MHP_CATALOG.find(p => config.prices[p.sku] === line.price?.id);
    const expectedAmount = credit?.amountPence ?? product?.pricePence;
    requireEvidence(product && mhpSellable(product) && config.prices[product.sku]
      && (!credit || idOf(line.price?.product) === credit.productId)
      && line.quantity === 1 && line.price?.unit_amount === expectedAmount
      && line.price.currency === 'gbp' && line.amount_total === expectedAmount && session.amount_total === expectedAmount
      && session.total_details?.amount_discount === 0 && (session.total_details?.amount_tax ?? 0) === 0
      && session.mode === (product.interval ? 'subscription' : 'payment'));
    // Provenance: a window price only from the server-created course checkout,
    // created before the window ended; a private offer only from an owner-sent link.
    if (product.availability === 'window') {
      requireEvidence(session.metadata?.brand === MHP_BRAND && session.metadata.sku === product.sku
        && session.metadata.mhp_checkout === 'course' && session.created * 1_000 < config.windowEndsAt && !session.payment_link);
    }
    if (product.availability === 'private') {
      const linkId = idOf(session.payment_link);
      requireEvidence(linkId);
      // Stripe copies link metadata to its sessions; read the link itself if it did not.
      const offer = session.metadata?.mhp_offer_link === '1' ? session.metadata : (await stripe.paymentLinks.retrieve(linkId)).metadata;
      requireEvidence(offer?.brand === MHP_BRAND && offer.sku === product.sku
        && offer.mhp_offer_link === '1' && /^[0-9a-f-]{36}$/i.test(offer.mhp_application ?? ''));
    }
    const customerId = idOf(session.customer);
    const email = session.customer_details?.email?.trim().toLowerCase();
    requireEvidence(customerId && email && email.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email));
    if (credit) requireEvidence(email === credit.email);
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
      payments.push(await this.paymentEvidence(pi, pi, undefined, credit));
      if (credit) requireEvidence(Date.parse(payments[0]!.paidAt) <= Date.parse(credit.expiresAt));
    }
    payments.sort((a, b) => a.paidAt.localeCompare(b.paidAt));
    return { evidence: { sessionId, sku: product.sku, customerId, subscriptionId, scheduleId, email, live: config.live,
      cancelled, firstPaidAt: payments[0]!.paidAt, periodEnd, observedAt, payments, ...(credit ? { creditAttemptId: credit.id } : {}) },
    buyerName: session.customer_details?.name?.trim().slice(0, 200) ?? '' };
  }
}
