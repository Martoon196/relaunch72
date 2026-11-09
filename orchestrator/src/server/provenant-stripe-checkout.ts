import type { StripeConfig } from './config.js';
import { CATALOG } from './catalog.js';
import { priceKeyFor, type CheckoutRequest } from './stripe.js';
import { isCheckoutTier } from './entitlements.js';
import type {
  PgPaidCheckoutService,
  RecordedPaidCheckoutCompletion,
} from './paid-checkout-pg-service.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface StripeReference {
  id: string;
}

interface StripeLineItem {
  quantity?: number | null;
  price?: string | StripeReference | null;
}

export interface RetrievedCheckoutSession extends Record<string, unknown> {
  id: string;
  url?: string | null;
  livemode?: boolean;
  client_reference_id?: string | null;
  mode?: string | null;
  payment_status?: string | null;
  amount_total?: number | null;
  currency?: string | null;
  payment_intent?: string | StripeReference | null;
  customer?: string | StripeReference | null;
  customer_email?: string | null;
  customer_details?: { email?: string | null } | null;
  line_items?: {
    data?: StripeLineItem[];
    has_more?: boolean;
  } | null;
}

export interface ProvenantStripeEvent {
  id?: string;
  type: string;
  created?: number;
  livemode?: boolean;
  data?: { object?: Record<string, unknown> };
}

export interface ProvenantStripeLike {
  checkout: {
    sessions: {
      create(
        params: Record<string, unknown>,
        options: { idempotencyKey: string },
      ): Promise<RetrievedCheckoutSession>;
      retrieve(
        sessionId: string,
        params?: Record<string, unknown>,
      ): Promise<RetrievedCheckoutSession>;
    };
  };
  webhooks: {
    constructEvent(
      payload: string | Buffer,
      signature: string,
      secret: string,
    ): ProvenantStripeEvent;
  };
}

export interface ProvenantCheckoutRequest extends CheckoutRequest {
  requestIdempotencyKey: string;
  orderClaim: string;
}

export interface ProvenantCheckoutResult {
  url: string;
  checkoutIntentId: string;
  /** The caller stores its own claim under this key before navigating away. */
  claimStorageKey: string;
  resumed: boolean;
}

export type PaidCheckoutWebhookResult =
  | Readonly<{ outcome: 'ignored'; eventType: string }>
  | Readonly<{
      outcome: 'processed' | 'rejected';
      orderId: string | null;
      replayed: boolean;
    }>;

export class ProvenantCheckoutError extends Error {}

function canonicalUuid(value: unknown): string | null {
  return typeof value === 'string' && UUID_PATTERN.test(value) ? value.toLowerCase() : null;
}

function referenceId(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null;
  if (value && typeof value === 'object' && typeof (value as StripeReference).id === 'string') {
    return (value as StripeReference).id.trim() || null;
  }
  return null;
}

function validCheckoutUrl(raw: unknown): string {
  if (typeof raw !== 'string') throw new ProvenantCheckoutError('Stripe returned no Checkout URL');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ProvenantCheckoutError('Stripe returned an invalid Checkout URL');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new ProvenantCheckoutError('Stripe returned an unsafe Checkout URL');
  }
  return url.toString();
}

function validSessionId(raw: unknown): string {
  if (typeof raw !== 'string'
      || raw !== raw.trim()
      || raw.length < 1
      || raw.length > 128) {
    throw new ProvenantCheckoutError('Stripe returned an invalid Checkout Session id');
  }
  return raw;
}

function eventMetadata(event: ProvenantStripeEvent): Record<string, unknown> {
  const value = event.data?.object?.metadata;
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function schemaVersion(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d{1,3}$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function exactLineItem(session: RetrievedCheckoutSession): StripeLineItem | null {
  const lines = session.line_items;
  if (!lines
      || lines.has_more !== false
      || !Array.isArray(lines.data)
      || lines.data.length !== 1) {
    return null;
  }
  return lines.data[0] ?? null;
}

function exactLineItemCount(session: RetrievedCheckoutSession): number | null {
  const lines = session.line_items;
  return lines
    && lines.has_more === false
    && Array.isArray(lines.data)
    ? lines.data.length
    : null;
}

function receiptEmail(session: RetrievedCheckoutSession): string | null {
  const raw = session.customer_details?.email ?? session.customer_email;
  return typeof raw === 'string' ? raw : null;
}

/**
 * Commit a database intent before contacting Stripe, then bind the exact
 * returned Session. A retry uses the same database and Stripe idempotency keys.
 */
export async function createProvenantCheckoutSession(
  stripe: ProvenantStripeLike,
  database: Pick<PgPaidCheckoutService, 'begin' | 'bindSession'>,
  config: StripeConfig,
  request: ProvenantCheckoutRequest,
  now: () => number = Date.now,
): Promise<ProvenantCheckoutResult> {
  if (config.keyMode !== 'test' && config.keyMode !== 'live') {
    throw new ProvenantCheckoutError('Stripe key mode is not safe for paid Checkout');
  }
  if (!isCheckoutTier(request.tier) || (request.bump === true && request.tier !== 'core')) {
    throw new ProvenantCheckoutError('Checkout product is invalid');
  }
  const productKey = priceKeyFor(request);
  const catalog = CATALOG.find((item) => item.key === productKey);
  const priceId = config.priceIds[productKey];
  if (!catalog || !priceId) throw new ProvenantCheckoutError('Checkout product is not configured');
  const expectedLivemode = config.keyMode === 'live';
  const authority = await database.begin({
    requestIdempotencyKey: request.requestIdempotencyKey,
    orderClaim: request.orderClaim,
    productKey: productKey as 'autopsy' | 'core' | 'core_bump' | 'pro',
    expectedPriceId: priceId,
    expectedAmountMinor: catalog.amount,
    expectedCurrency: 'usd',
    expectedLivemode,
  });
  const expiresAt = Date.parse(authority.intentExpiresAt);
  const currentTime = now();
  if (!Number.isFinite(currentTime)
      || !Number.isFinite(expiresAt)
      || expiresAt - currentTime < 30 * 60 * 1_000) {
    throw new ProvenantCheckoutError('Checkout intent is too close to expiry');
  }

  const successUrl = `${config.publicBaseUrl}/intake/?intent=${encodeURIComponent(authority.checkoutIntentId)}&session={CHECKOUT_SESSION_ID}`;
  const cancelUrl = new URL('/checkout.html', `${config.publicBaseUrl}/`);
  cancelUrl.searchParams.set('tier', request.tier);

  const session = authority.stripeSessionId
    ? await stripe.checkout.sessions.retrieve(authority.stripeSessionId)
    : await stripe.checkout.sessions.create({
        mode: 'payment',
        payment_method_types: ['card'],
        line_items: [{ price: priceId, quantity: 1 }],
        client_reference_id: authority.checkoutIntentId,
        success_url: successUrl,
        cancel_url: cancelUrl.toString(),
        expires_at: Math.floor(expiresAt / 1_000),
        metadata: {
          schema_version: '1',
          checkout_intent_id: authority.checkoutIntentId,
        },
      }, {
        idempotencyKey: authority.providerIdempotencyKey,
      });

  const sessionId = validSessionId(session.id);
  if (authority.stripeSessionId && sessionId !== authority.stripeSessionId) {
    throw new ProvenantCheckoutError('Stripe returned a different Checkout Session for this intent');
  }
  if (session.client_reference_id !== authority.checkoutIntentId
      || session.livemode !== expectedLivemode) {
    throw new ProvenantCheckoutError('Stripe returned a Checkout Session with mismatched provenance');
  }
  await database.bindSession(
    authority.checkoutIntentId,
    authority.providerIdempotencyKey,
    sessionId,
  );
  return Object.freeze({
    url: validCheckoutUrl(session.url),
    checkoutIntentId: authority.checkoutIntentId,
    claimStorageKey: `r72:paid-order-claim:${authority.checkoutIntentId}`,
    resumed: !authority.createdNow,
  });
}

/**
 * Verify the raw webhook bytes, retrieve the authoritative Session with its
 * exact line item, and let PostgreSQL reconcile every fact to the bound intent.
 */
export async function processProvenantCheckoutWebhook(
  stripe: ProvenantStripeLike,
  database: Pick<PgPaidCheckoutService, 'recordCompleted'>,
  config: StripeConfig,
  rawPayload: Buffer,
  signature: string,
): Promise<PaidCheckoutWebhookResult> {
  let event: ProvenantStripeEvent;
  try {
    event = stripe.webhooks.constructEvent(rawPayload, signature, config.webhookSecret);
  } catch {
    throw new ProvenantCheckoutError('Stripe webhook signature is invalid');
  }
  if (event.type !== 'checkout.session.completed') {
    return Object.freeze({ outcome: 'ignored', eventType: event.type });
  }
  const eventId = typeof event.id === 'string' ? event.id.trim() : '';
  const eventSessionId = referenceId(event.data?.object?.id);
  if (!eventId
      || !eventSessionId
      || !Number.isSafeInteger(event.created)
      || (event.created ?? 0) <= 0
      || typeof event.livemode !== 'boolean') {
    throw new ProvenantCheckoutError('Stripe webhook event is incomplete');
  }
  const session = await stripe.checkout.sessions.retrieve(eventSessionId, {
    expand: ['line_items.data.price'],
  });
  if (validSessionId(session.id) !== eventSessionId || typeof session.livemode !== 'boolean') {
    throw new ProvenantCheckoutError('Stripe Session retrieval did not match the signed event');
  }
  const metadata = eventMetadata(event);
  const line = exactLineItem(session);
  const recorded: RecordedPaidCheckoutCompletion = await database.recordCompleted({
    eventId,
    eventType: event.type,
    rawPayload,
    providerCreatedAt: new Date((event.created ?? 0) * 1_000),
    eventLivemode: event.livemode,
    sessionLivemode: session.livemode,
    reportedCheckoutIntentId: canonicalUuid(metadata.checkout_intent_id),
    clientReferenceIntentId: canonicalUuid(session.client_reference_id),
    metadataSchemaVersion: schemaVersion(metadata.schema_version),
    stripeSessionId: eventSessionId,
    sessionMode: typeof session.mode === 'string' ? session.mode : null,
    paymentStatus: typeof session.payment_status === 'string' ? session.payment_status : null,
    priceId: line ? referenceId(line.price) : null,
    lineItemCount: exactLineItemCount(session),
    quantity: line && Number.isSafeInteger(line.quantity) ? line.quantity ?? null : null,
    amountTotal: Number.isSafeInteger(session.amount_total) ? session.amount_total ?? null : null,
    currency: typeof session.currency === 'string' ? session.currency : null,
    paymentIntentId: referenceId(session.payment_intent),
    stripeCustomerId: referenceId(session.customer),
    receiptEmail: receiptEmail(session),
  });
  return Object.freeze({
    outcome: recorded.eventDisposition,
    orderId: recorded.orderId,
    replayed: recorded.replayed,
  });
}
