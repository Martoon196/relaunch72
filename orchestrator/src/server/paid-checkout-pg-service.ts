import { createHash } from 'node:crypto';
import type { Pool, QueryResultRow } from 'pg';
import type { ProductKey } from './entitlements.js';
import type { PgSetupDeliveryService } from '../portal/setup-delivery-pg-service.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CLAIM_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PRODUCT_SCOPE: Readonly<Record<ProductKey, Readonly<{
  entitlementVersion: 1;
  throughStage: 'S1' | 'S9';
  portalAccess: boolean;
}>>> = Object.freeze({
  autopsy: Object.freeze({ entitlementVersion: 1, throughStage: 'S1', portalAccess: false }),
  core: Object.freeze({ entitlementVersion: 1, throughStage: 'S9', portalAccess: true }),
  core_bump: Object.freeze({ entitlementVersion: 1, throughStage: 'S9', portalAccess: true }),
  pro: Object.freeze({ entitlementVersion: 1, throughStage: 'S9', portalAccess: true }),
});

export interface BeginPaidCheckoutInput {
  /** Browser-generated UUID reused only for an exact retry of this request. */
  requestIdempotencyKey: string;
  /** A 256-bit base64url credential retained by the browser, never PostgreSQL. */
  orderClaim: string;
  productKey: ProductKey;
  expectedPriceId: string;
  expectedAmountMinor: number;
  expectedCurrency: string;
  expectedLivemode: boolean;
}

export interface PaidCheckoutIntentAuthority {
  checkoutIntentId: string;
  /** Server-only Stripe request idempotency key. Never return this to a browser. */
  providerIdempotencyKey: string;
  intentExpiresAt: string;
  stripeSessionId: string | null;
  createdNow: boolean;
}

export interface BoundPaidCheckoutSession {
  checkoutIntentId: string;
  stripeSessionId: string;
  boundNow: boolean;
}

export interface VerifiedPaidCheckoutCompletion {
  eventId: string;
  eventType: string;
  rawPayload: Uint8Array;
  providerCreatedAt: string | Date;
  eventLivemode: boolean;
  sessionLivemode: boolean;
  /** Signed event metadata. Invalid/missing values become a rejected event. */
  reportedCheckoutIntentId: string | null;
  /** Authenticated Session.client_reference_id from Stripe retrieval. */
  clientReferenceIntentId: string | null;
  metadataSchemaVersion: number | null;
  stripeSessionId: string;
  sessionMode: string | null;
  paymentStatus: string | null;
  priceId: string | null;
  lineItemCount: number | null;
  quantity: number | null;
  amountTotal: number | null;
  currency: string | null;
  paymentIntentId: string | null;
  stripeCustomerId: string | null;
  receiptEmail: string | null;
}

export interface RecordedPaidCheckoutCompletion {
  eventDisposition: 'processed' | 'rejected';
  orderId: string | null;
  replayed: boolean;
}

export interface PaidPortalFulfilmentInput {
  stripeSessionId: string;
  orderClaim: string;
  organizationName: string;
  workspaceName?: string;
  ownerDisplayName?: string;
  timezone?: string;
  locale?: string;
  currency?: string;
}

export interface PaidPortalFulfilmentResult {
  organizationId: string;
  workspaceId: string;
  ownerUserId: string;
  setupActionTokenId: string;
  setupExpiresAt: string;
  setupDeliveryId: string;
  setupDeliveryGeneration: number;
  createdNow: boolean;
}

interface IntentRow extends QueryResultRow {
  checkout_intent_id: string;
  provider_idempotency_key: string;
  intent_expires_at: string | Date;
  stripe_session_id: string | null;
  created_now: boolean;
}

interface BindingRow extends QueryResultRow {
  checkout_intent_id: string;
  stripe_session_id: string;
  bound_now: boolean;
}

interface EventRow extends QueryResultRow {
  event_disposition: string;
  order_id: string | null;
  replayed: boolean;
}

interface AuthorizationRow extends QueryResultRow {
  order_id: string;
  product_key: string;
  receipt_email: string;
  fulfilment_status: string;
  organization_id: string | null;
  workspace_id: string | null;
  owner_user_id: string | null;
  setup_action_token_id: string | null;
  setup_delivery_id: string | null;
}

interface FulfilmentRow extends QueryResultRow {
  organization_id: string;
  workspace_id: string;
  owner_user_id: string;
  setup_action_token_id: string;
  setup_expires_at: string | Date;
  setup_delivery_id: string;
  setup_delivery_generation: number;
  created_now: boolean;
}

export interface PgPaidCheckoutDependencies {
  /** Authenticates as r72_public and can execute only begin/bind functions. */
  checkoutCommandPool: Pick<Pool, 'query'>;
  /** Authenticates as r72_webhook and can record exact signed payment facts. */
  webhookCommandPool: Pick<Pool, 'query'>;
  /** Authenticates as r72_provisioning_command; direct provisioning is revoked. */
  provisioningCommandPool: Pick<Pool, 'query'>;
  setupDelivery: Pick<PgSetupDeliveryService, 'prepare'>;
}

export class PaidCheckoutClaimError extends Error {
  constructor() {
    super('The paid checkout claim is unavailable, expired, or already used');
    this.name = 'PaidCheckoutClaimError';
  }
}

function canonicalUuid(value: unknown): string | null {
  return typeof value === 'string' && UUID_PATTERN.test(value) ? value.toLowerCase() : null;
}

function canonicalIsoDate(value: unknown, label: string): string {
  const raw = value instanceof Date ? value.toISOString() : value;
  const parsed = typeof raw === 'string' ? Date.parse(raw) : Number.NaN;
  if (!Number.isFinite(parsed)) throw new Error(`${label} returned an invalid timestamp`);
  return new Date(parsed).toISOString();
}

function canonicalClaimHash(rawClaim: string): Buffer {
  if (!CLAIM_PATTERN.test(rawClaim) || Buffer.from(rawClaim, 'base64url').byteLength !== 32) {
    throw new PaidCheckoutClaimError();
  }
  return createHash('sha256').update(rawClaim, 'ascii').digest();
}

function trimmed(value: string, label: string, maximum: number): string {
  const normalized = value.trim();
  if (!normalized || normalized !== value || normalized.length > maximum) {
    throw new Error(`${label} must be a trimmed value of 1 to ${maximum} characters`);
  }
  return normalized;
}

function compactText(value: string, label: string, maximum: number): string {
  const normalized = value.trim().replace(/\s+/g, ' ');
  if (!normalized || normalized.length > maximum) {
    throw new Error(`${label} must contain 1 to ${maximum} characters`);
  }
  return normalized;
}

function stableSlug(name: string, authority: string, suffix: string): string {
  const readable = name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || suffix;
  const digest = createHash('sha256').update(`${authority}\0${suffix}`).digest('hex').slice(0, 10);
  const prefix = readable.slice(0, 51).replace(/-+$/g, '') || suffix;
  return `${prefix}-${digest}`;
}

function optionalProviderText(value: string | null, maximum: number): string | null {
  if (value === null) return null;
  const normalized = value.trim();
  return normalized && normalized.length <= maximum ? normalized : null;
}

function validSessionId(value: string): string {
  return trimmed(value, 'stripeSessionId', 128);
}

function validCanonicalEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  return email.length <= 320 && EMAIL_PATTERN.test(email) ? email : null;
}

/**
 * PostgreSQL adapter for the new commerce boundary. It deliberately does not
 * start Checkout, a webhook listener, provisioning, or provider delivery by
 * construction; callers must invoke each stage explicitly.
 */
export class PgPaidCheckoutService {
  constructor(private readonly dependencies: PgPaidCheckoutDependencies) {}

  async begin(input: BeginPaidCheckoutInput): Promise<PaidCheckoutIntentAuthority> {
    const requestIdempotencyKey = canonicalUuid(input.requestIdempotencyKey);
    if (!requestIdempotencyKey || requestIdempotencyKey !== input.requestIdempotencyKey.toLowerCase()) {
      throw new Error('requestIdempotencyKey must be a canonical UUID');
    }
    const scope = PRODUCT_SCOPE[input.productKey];
    if (!scope) throw new Error('productKey is invalid');
    const expectedPriceId = trimmed(input.expectedPriceId, 'expectedPriceId', 255);
    if (!Number.isSafeInteger(input.expectedAmountMinor) || input.expectedAmountMinor <= 0) {
      throw new Error('expectedAmountMinor must be a positive safe integer');
    }
    if (!/^[a-z]{3}$/.test(input.expectedCurrency)) {
      throw new Error('expectedCurrency must be a lowercase three-letter ISO code');
    }
    if (typeof input.expectedLivemode !== 'boolean') throw new Error('expectedLivemode must be boolean');
    const orderClaimHash = canonicalClaimHash(input.orderClaim);

    const result = await this.dependencies.checkoutCommandPool.query<IntentRow>(
      `/* commerce.checkout.begin */
       SELECT checkout_intent_id, provider_idempotency_key, intent_expires_at,
              stripe_session_id, created_now
       FROM app_private.begin_one_off_checkout(
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10
       )`,
      [
        requestIdempotencyKey,
        input.productKey,
        scope.entitlementVersion,
        scope.throughStage,
        scope.portalAccess,
        expectedPriceId,
        input.expectedAmountMinor,
        input.expectedCurrency,
        input.expectedLivemode,
        orderClaimHash,
      ],
    );
    if (result.rows.length !== 1) throw new Error('Paid checkout begin did not return exactly one result');
    const row = result.rows[0]!;
    const checkoutIntentId = canonicalUuid(row.checkout_intent_id);
    const providerIdempotencyKey = typeof row.provider_idempotency_key === 'string'
      ? row.provider_idempotency_key.trim()
      : '';
    const stripeSessionId = row.stripe_session_id === null ? null : validSessionId(row.stripe_session_id);
    if (!checkoutIntentId
        || providerIdempotencyKey !== row.provider_idempotency_key
        || providerIdempotencyKey.length < 1
        || providerIdempotencyKey.length > 255
        || typeof row.created_now !== 'boolean') {
      throw new Error('Paid checkout begin returned invalid canonical data');
    }
    return Object.freeze({
      checkoutIntentId,
      providerIdempotencyKey,
      intentExpiresAt: canonicalIsoDate(row.intent_expires_at, 'paid checkout intent expiry'),
      stripeSessionId,
      createdNow: row.created_now,
    });
  }

  async bindSession(
    checkoutIntentIdInput: string,
    providerIdempotencyKeyInput: string,
    stripeSessionIdInput: string,
  ): Promise<BoundPaidCheckoutSession> {
    const checkoutIntentId = canonicalUuid(checkoutIntentIdInput);
    if (!checkoutIntentId) throw new Error('checkoutIntentId must be a UUID');
    const providerIdempotencyKey = trimmed(
      providerIdempotencyKeyInput,
      'providerIdempotencyKey',
      255,
    );
    const stripeSessionId = validSessionId(stripeSessionIdInput);
    const result = await this.dependencies.checkoutCommandPool.query<BindingRow>(
      `/* commerce.checkout.bind-session */
       SELECT checkout_intent_id, stripe_session_id, bound_now
       FROM app_private.bind_one_off_checkout_session($1, $2, $3)`,
      [checkoutIntentId, providerIdempotencyKey, stripeSessionId],
    );
    if (result.rows.length !== 1) throw new Error('Paid checkout Session binding was rejected');
    const row = result.rows[0]!;
    const returnedIntentId = canonicalUuid(row.checkout_intent_id);
    if (returnedIntentId !== checkoutIntentId
        || row.stripe_session_id !== stripeSessionId
        || typeof row.bound_now !== 'boolean') {
      throw new Error('Paid checkout Session binding returned invalid canonical data');
    }
    return Object.freeze({
      checkoutIntentId: returnedIntentId,
      stripeSessionId,
      boundNow: row.bound_now,
    });
  }

  async recordCompleted(input: VerifiedPaidCheckoutCompletion): Promise<RecordedPaidCheckoutCompletion> {
    const eventId = trimmed(input.eventId, 'eventId', 255);
    const eventType = trimmed(input.eventType, 'eventType', 255);
    const stripeSessionId = validSessionId(input.stripeSessionId);
    if (!(input.rawPayload instanceof Uint8Array)
        || input.rawPayload.byteLength < 1
        || input.rawPayload.byteLength > 256 * 1024) {
      throw new Error('rawPayload must contain 1 to 262144 bytes');
    }
    const reportedIntent = canonicalUuid(input.reportedCheckoutIntentId);
    const clientIntent = canonicalUuid(input.clientReferenceIntentId);
    const providerCreatedAt = canonicalIsoDate(input.providerCreatedAt, 'Stripe event created time');
    const payloadDigest = createHash('sha256').update(input.rawPayload).digest();
    const result = await this.dependencies.webhookCommandPool.query<EventRow>(
      `/* commerce.checkout.record-paid-completion */
       SELECT event_disposition, order_id, replayed
       FROM app_private.record_paid_checkout_completed(
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
         $11, $12, $13, $14, $15, $16, $17, $18, $19, $20
       )`,
      [
        eventId,
        eventType,
        payloadDigest,
        providerCreatedAt,
        input.eventLivemode,
        input.sessionLivemode,
        reportedIntent,
        clientIntent,
        input.metadataSchemaVersion,
        stripeSessionId,
        optionalProviderText(input.sessionMode, 50),
        optionalProviderText(input.paymentStatus, 50),
        optionalProviderText(input.priceId, 255),
        input.lineItemCount,
        input.quantity,
        input.amountTotal,
        input.currency?.trim().toLowerCase() ?? null,
        optionalProviderText(input.paymentIntentId, 255),
        optionalProviderText(input.stripeCustomerId, 255),
        validCanonicalEmail(input.receiptEmail),
      ],
    );
    if (result.rows.length !== 1) throw new Error('Paid checkout event did not return exactly one result');
    const row = result.rows[0]!;
    if ((row.event_disposition !== 'processed' && row.event_disposition !== 'rejected')
        || typeof row.replayed !== 'boolean') {
      throw new Error('Paid checkout event returned invalid canonical data');
    }
    const orderId = row.order_id === null ? null : canonicalUuid(row.order_id);
    if ((row.order_id !== null && !orderId)
        || (row.event_disposition === 'processed' && !orderId)) {
      throw new Error('Paid checkout event returned an invalid order reference');
    }
    return Object.freeze({
      eventDisposition: row.event_disposition,
      orderId,
      replayed: row.replayed,
    });
  }

  async fulfilPaidPortal(input: PaidPortalFulfilmentInput): Promise<PaidPortalFulfilmentResult> {
    const stripeSessionId = validSessionId(input.stripeSessionId);
    const claimHash = canonicalClaimHash(input.orderClaim);
    const authorization = await this.dependencies.provisioningCommandPool.query<AuthorizationRow>(
      `/* commerce.checkout.authorize-paid-portal */
       SELECT order_id, product_key, receipt_email, fulfilment_status,
              organization_id, workspace_id, owner_user_id,
              setup_action_token_id, setup_delivery_id
       FROM app_private.authorize_paid_portal_fulfilment($1, $2)`,
      [stripeSessionId, claimHash],
    );
    if (authorization.rows.length !== 1) throw new PaidCheckoutClaimError();
    const authority = authorization.rows[0]!;
    if (!canonicalUuid(authority.order_id)
        || !['core', 'core_bump', 'pro'].includes(authority.product_key)
        || !['awaiting_intake', 'provisioned'].includes(authority.fulfilment_status)) {
      throw new Error('Paid portal authorization returned invalid canonical data');
    }
    const receiptEmail = validCanonicalEmail(authority.receipt_email);
    if (!receiptEmail) throw new Error('Paid portal authorization returned an invalid receipt email');

    const organizationName = compactText(input.organizationName, 'organizationName', 200);
    const workspaceName = compactText(input.workspaceName ?? organizationName, 'workspaceName', 200);
    const ownerDisplayName = compactText(
      input.ownerDisplayName ?? `${organizationName} owner`,
      'ownerDisplayName',
      200,
    );
    const timezone = compactText(input.timezone ?? 'Europe/London', 'timezone', 100);
    const locale = compactText(input.locale ?? 'en-GB', 'locale', 20);
    const currency = (input.currency ?? 'GBP').trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) throw new Error('currency must be a three-letter ISO code');
    const encrypted = this.dependencies.setupDelivery.prepare(receiptEmail);
    const organizationSlug = stableSlug(organizationName, stripeSessionId, 'org');
    const workspaceSlug = stableSlug(workspaceName, stripeSessionId, 'workspace');

    const result = await this.dependencies.provisioningCommandPool.query<FulfilmentRow>(
      `/* commerce.checkout.fulfil-paid-portal */
       SELECT organization_id, workspace_id, owner_user_id,
              setup_action_token_id, setup_expires_at, setup_delivery_id,
              setup_delivery_generation, created_now
       FROM app_private.fulfil_paid_portal_checkout_with_setup_delivery(
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
         $11, $12, $13, $14, $15, $16, $17, $18
       )`,
      [
        stripeSessionId,
        claimHash,
        organizationName,
        organizationSlug,
        workspaceName,
        workspaceSlug,
        ownerDisplayName,
        encrypted.setupTokenHash,
        encrypted.recipientEmailHash,
        timezone,
        locale,
        currency,
        encrypted.deliveryId,
        encrypted.payloadVersion,
        encrypted.encryptionKeyId,
        encrypted.encryptionIv,
        encrypted.encryptedPayload,
        encrypted.authenticationTag,
      ],
    );
    if (result.rows.length !== 1) throw new PaidCheckoutClaimError();
    return this.parseFulfilment(result.rows[0]!);
  }

  private parseFulfilment(row: FulfilmentRow): PaidPortalFulfilmentResult {
    const organizationId = canonicalUuid(row.organization_id);
    const workspaceId = canonicalUuid(row.workspace_id);
    const ownerUserId = canonicalUuid(row.owner_user_id);
    const setupActionTokenId = canonicalUuid(row.setup_action_token_id);
    const setupDeliveryId = canonicalUuid(row.setup_delivery_id);
    if (!organizationId || !workspaceId || !ownerUserId || !setupActionTokenId || !setupDeliveryId
        || !Number.isInteger(row.setup_delivery_generation)
        || row.setup_delivery_generation < 1
        || typeof row.created_now !== 'boolean') {
      throw new Error('Paid portal fulfilment returned invalid canonical data');
    }
    return Object.freeze({
      organizationId,
      workspaceId,
      ownerUserId,
      setupActionTokenId,
      setupExpiresAt: canonicalIsoDate(row.setup_expires_at, 'paid portal setup expiry'),
      setupDeliveryId,
      setupDeliveryGeneration: row.setup_delivery_generation,
      createdNow: row.created_now,
    });
  }
}
