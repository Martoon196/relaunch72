import { TextDecoder } from 'node:util';

/**
 * Property Predator's first-party growth signal catalogue.
 *
 * These are source events, not trusted Relaunch72 PlatformEvents. In
 * particular, this wire contract has no workspace field: the authenticated
 * connection must resolve the destination workspace before persistence.
 */
export const PROPERTY_PREDATOR_EXTERNAL_EVENT_TYPES = [
  'identity.account.created',
  'privacy.consent.updated',
  'affiliate.referral.attributed',
  'product.analysis.completed',
  'content.consumption.progressed',
  'content.consumption.completed',
  'offer.presented',
  'offer.responded',
  'sales.appointment.booked',
  'sales.presentation.completed',
  'commerce.purchase.completed',
  'commerce.purchase.refunded',
  'commerce.subscription.cancelled',
] as const;

export type PropertyPredatorExternalEventType =
  (typeof PROPERTY_PREDATOR_EXTERNAL_EVENT_TYPES)[number];

export const PROPERTY_PREDATOR_EXTERNAL_EVENT_VERSION = 1 as const;
export const PROPERTY_PREDATOR_EXTERNAL_EVENT_MAX_BODY_BYTES = 32 * 1024;

export interface PropertyPredatorAccountSubject {
  readonly kind: 'account';
  readonly id: string;
}

export interface PropertyPredatorAccountCreatedData {
  readonly email: string;
  readonly signupMethod: 'password' | 'google';
  readonly displayName?: string;
}

export interface PropertyPredatorConsentUpdatedData {
  readonly purpose: 'property_predator_marketing' | 'partner_marketing';
  readonly channel: 'email';
  readonly state: 'granted' | 'denied' | 'withdrawn';
  readonly source: 'registration' | 'account_preferences' | 'unsubscribe';
  readonly email?: string;
  readonly policyVersion?: string;
  readonly policyTextSha256?: string;
}

export interface PropertyPredatorReferralAttributedData {
  readonly affiliateId: string;
  readonly referralCode: string;
  readonly model: 'last_click';
}

export interface PropertyPredatorAnalysisCompletedData {
  readonly toolKey: string;
  readonly accessMode: 'demo' | 'free' | 'paid';
  readonly unitsSpent: number;
}

interface PropertyPredatorContentConsumptionData {
  readonly contentKey: string;
  readonly contentVersion: string;
  readonly title: string;
  readonly medium: 'video' | 'audio' | 'article' | 'document' | 'other';
  readonly progressBasisPoints: number;
  readonly consumedSeconds: number;
}

export interface PropertyPredatorContentConsumptionProgressedData
  extends PropertyPredatorContentConsumptionData {}

export interface PropertyPredatorContentConsumptionCompletedData
  extends PropertyPredatorContentConsumptionData {
  readonly progressBasisPoints: 10_000;
}

export interface PropertyPredatorOfferPrice {
  readonly amountMinor: number;
  readonly currency: string;
}

export interface PropertyPredatorOfferPresentedData {
  readonly offerKey: string;
  readonly offerVersion: string;
  readonly productKey: string;
  readonly label: string;
  readonly price: Readonly<PropertyPredatorOfferPrice>;
  readonly placement: string;
}

export interface PropertyPredatorOfferRespondedData {
  readonly presentationEventId: string;
  readonly response: 'accepted' | 'declined' | 'deferred' | 'requested_contact';
}

export interface PropertyPredatorAppointmentBookedData {
  readonly appointmentId: string;
  readonly startsAt: string;
  readonly bookingSource: 'self_serve_calendar' | 'team' | 'partner_referral';
  readonly meetingKind: 'discovery' | 'strategy' | 'partner';
}

export interface PropertyPredatorPresentationCompletedData {
  readonly appointmentId: string;
  readonly presentationKey: string;
  readonly durationSeconds: number;
  readonly outcome: 'completed' | 'follow_up_requested' | 'proposal_requested';
}

export interface PropertyPredatorPurchaseCompletedData {
  readonly provider: 'stripe';
  readonly providerEventId: string;
  readonly checkoutSessionId: string;
  readonly productKey: string;
  readonly billingKind: 'one_off' | 'subscription';
  readonly subscriptionId?: string;
  readonly amountMinor: number;
  readonly currency: string;
}

export interface PropertyPredatorPurchaseRefundedData {
  readonly provider: 'stripe';
  readonly providerEventId: string;
  readonly checkoutSessionId: string;
  readonly productKey: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly reasonCode?: string;
}

export interface PropertyPredatorSubscriptionCancelledData {
  readonly provider: 'stripe';
  readonly providerEventId: string;
  readonly subscriptionId: string;
  readonly productKey: string;
  readonly effectiveAt: string;
}

interface PropertyPredatorExternalEventBase<
  TType extends PropertyPredatorExternalEventType,
  TData,
> {
  readonly id: string;
  readonly type: TType;
  readonly version: typeof PROPERTY_PREDATOR_EXTERNAL_EVENT_VERSION;
  readonly occurredAt: string;
  readonly correlationId: string;
  readonly subject: PropertyPredatorAccountSubject;
  readonly data: Readonly<TData>;
}

export type PropertyPredatorExternalEvent =
  | PropertyPredatorExternalEventBase<'identity.account.created', PropertyPredatorAccountCreatedData>
  | PropertyPredatorExternalEventBase<'privacy.consent.updated', PropertyPredatorConsentUpdatedData>
  | PropertyPredatorExternalEventBase<'affiliate.referral.attributed', PropertyPredatorReferralAttributedData>
  | PropertyPredatorExternalEventBase<'product.analysis.completed', PropertyPredatorAnalysisCompletedData>
  | PropertyPredatorExternalEventBase<'content.consumption.progressed', PropertyPredatorContentConsumptionProgressedData>
  | PropertyPredatorExternalEventBase<'content.consumption.completed', PropertyPredatorContentConsumptionCompletedData>
  | PropertyPredatorExternalEventBase<'offer.presented', PropertyPredatorOfferPresentedData>
  | PropertyPredatorExternalEventBase<'offer.responded', PropertyPredatorOfferRespondedData>
  | PropertyPredatorExternalEventBase<'sales.appointment.booked', PropertyPredatorAppointmentBookedData>
  | PropertyPredatorExternalEventBase<'sales.presentation.completed', PropertyPredatorPresentationCompletedData>
  | PropertyPredatorExternalEventBase<'commerce.purchase.completed', PropertyPredatorPurchaseCompletedData>
  | PropertyPredatorExternalEventBase<'commerce.purchase.refunded', PropertyPredatorPurchaseRefundedData>
  | PropertyPredatorExternalEventBase<'commerce.subscription.cancelled', PropertyPredatorSubscriptionCancelledData>;

export class PropertyPredatorExternalEventContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PropertyPredatorExternalEventContractError';
  }
}

export class PropertyPredatorExternalEventBodyTooLargeError
  extends PropertyPredatorExternalEventContractError {
  constructor() {
    super(`external event body must not exceed ${PROPERTY_PREDATOR_EXTERNAL_EVENT_MAX_BODY_BYTES} bytes`);
    this.name = 'PropertyPredatorExternalEventBodyTooLargeError';
  }
}

type DataRecord = Record<string, unknown>;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CANONICAL_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SAFE_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SAFE_GROWTH_KEY_PATTERN = /^[a-z0-9][a-z0-9._:-]*$/;
const SAFE_REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const SAFE_REFERRAL_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MAX_CONSUMED_SECONDS = 2_147_483_647;

function fail(message: string): never {
  throw new PropertyPredatorExternalEventContractError(message);
}

function dataRecord(value: unknown, path: string): DataRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return fail(`${path} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return fail(`${path} must be a plain object`);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') return fail(`${path} must not contain symbol keys`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !('value' in descriptor)) {
      return fail(`${path}.${key} must be an enumerable data property`);
    }
  }
  return value as DataRecord;
}

function exactKeys(
  value: DataRecord,
  path: string,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${path} contains unsupported field: ${key}`);
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) fail(`${path}.${key} is required`);
  }
}

function stringValue(value: unknown, path: string, maximum: number): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum || value.trim() !== value) {
    return fail(`${path} must be a trimmed string of 1 to ${maximum} characters`);
  }
  return value;
}

function safeDisplayString(value: unknown, path: string, maximum: number): string {
  const candidate = stringValue(value, path, maximum);
  if (/\p{Cc}/u.test(candidate)) return fail(`${path} must not contain control characters`);
  return candidate;
}

function literal<TValue extends string>(
  value: unknown,
  path: string,
  allowed: readonly TValue[],
): TValue {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    return fail(`${path} is invalid`);
  }
  return value as TValue;
}

function canonicalUuid(value: unknown, path: string): string {
  const candidate = stringValue(value, path, 36);
  if (!UUID_PATTERN.test(candidate)) return fail(`${path} must be a canonical lowercase UUID`);
  return candidate;
}

function canonicalTimestamp(value: unknown, path: string): string {
  const candidate = stringValue(value, path, 24);
  if (!CANONICAL_TIMESTAMP_PATTERN.test(candidate)) {
    return fail(`${path} must be a canonical RFC3339 UTC timestamp`);
  }
  const parsed = new Date(candidate);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== candidate) {
    return fail(`${path} must be a valid canonical RFC3339 UTC timestamp`);
  }
  return candidate;
}

function safeKey(value: unknown, path: string): string {
  const candidate = stringValue(value, path, 64);
  if (!SAFE_KEY_PATTERN.test(candidate)) return fail(`${path} must be a safe lowercase key`);
  return candidate;
}

function safeGrowthKey(value: unknown, path: string, maximum: number): string {
  const candidate = stringValue(value, path, maximum);
  if (!SAFE_GROWTH_KEY_PATTERN.test(candidate)) return fail(`${path} must be a safe lowercase key`);
  return candidate;
}

function safeReference(value: unknown, path: string, maximum: number): string {
  const candidate = stringValue(value, path, maximum);
  if (!SAFE_REFERENCE_PATTERN.test(candidate)) return fail(`${path} must be a safe provider reference`);
  return candidate;
}

function positiveSafeInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    return fail(`${path} must be a positive safe integer`);
  }
  return value as number;
}

function boundedInteger(value: unknown, path: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    return fail(`${path} must be an integer from ${minimum} to ${maximum}`);
  }
  return value as number;
}

function currency(value: unknown, path: string): string {
  if (typeof value !== 'string' || !/^[a-z]{3}$/.test(value)) {
    return fail(`${path} must be a lowercase three-letter ISO currency code`);
  }
  return value;
}

function email(value: unknown, path: string): string {
  const candidate = stringValue(value, path, 320);
  if (candidate !== candidate.toLowerCase() || !EMAIL_PATTERN.test(candidate)) {
    return fail(`${path} must be a canonical lowercase email address`);
  }
  return candidate;
}

function sha256(value: unknown, path: string): string {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    return fail(`${path} must be a lowercase hexadecimal SHA-256 digest`);
  }
  return value;
}

function parseSubject(value: unknown): PropertyPredatorAccountSubject {
  const subject = dataRecord(value, 'subject');
  exactKeys(subject, 'subject', ['kind', 'id']);
  return Object.freeze({
    kind: literal(subject.kind, 'subject.kind', ['account'] as const),
    id: canonicalUuid(subject.id, 'subject.id'),
  });
}

function parseAccountCreated(value: unknown): Readonly<PropertyPredatorAccountCreatedData> {
  const data = dataRecord(value, 'data');
  exactKeys(data, 'data', ['email', 'signupMethod'], ['displayName']);
  const displayName = Object.hasOwn(data, 'displayName')
    ? safeDisplayString(data.displayName, 'data.displayName', 200)
    : undefined;
  return Object.freeze({
    email: email(data.email, 'data.email'),
    signupMethod: literal(data.signupMethod, 'data.signupMethod', ['password', 'google'] as const),
    ...(displayName === undefined ? {} : { displayName }),
  });
}

function parseConsentUpdated(value: unknown): Readonly<PropertyPredatorConsentUpdatedData> {
  const data = dataRecord(value, 'data');
  exactKeys(
    data,
    'data',
    ['purpose', 'channel', 'state', 'source'],
    ['email', 'policyVersion', 'policyTextSha256'],
  );
  const canonicalEmail = Object.hasOwn(data, 'email')
    ? email(data.email, 'data.email')
    : undefined;
  const policyVersion = Object.hasOwn(data, 'policyVersion')
    ? safeDisplayString(data.policyVersion, 'data.policyVersion', 100)
    : undefined;
  const policyTextSha256 = Object.hasOwn(data, 'policyTextSha256')
    ? sha256(data.policyTextSha256, 'data.policyTextSha256')
    : undefined;
  return Object.freeze({
    purpose: literal(data.purpose, 'data.purpose', ['property_predator_marketing', 'partner_marketing'] as const),
    channel: literal(data.channel, 'data.channel', ['email'] as const),
    state: literal(data.state, 'data.state', ['granted', 'denied', 'withdrawn'] as const),
    source: literal(data.source, 'data.source', ['registration', 'account_preferences', 'unsubscribe'] as const),
    ...(canonicalEmail === undefined ? {} : { email: canonicalEmail }),
    ...(policyVersion === undefined ? {} : { policyVersion }),
    ...(policyTextSha256 === undefined ? {} : { policyTextSha256 }),
  });
}

function parseReferralAttributed(value: unknown): Readonly<PropertyPredatorReferralAttributedData> {
  const data = dataRecord(value, 'data');
  exactKeys(data, 'data', ['affiliateId', 'referralCode', 'model']);
  const referralCode = stringValue(data.referralCode, 'data.referralCode', 64);
  if (!SAFE_REFERRAL_CODE_PATTERN.test(referralCode)) fail('data.referralCode must be a safe referral code');
  return Object.freeze({
    affiliateId: canonicalUuid(data.affiliateId, 'data.affiliateId'),
    referralCode,
    model: literal(data.model, 'data.model', ['last_click'] as const),
  });
}

function parseAnalysisCompleted(value: unknown): Readonly<PropertyPredatorAnalysisCompletedData> {
  const data = dataRecord(value, 'data');
  exactKeys(data, 'data', ['toolKey', 'accessMode', 'unitsSpent']);
  return Object.freeze({
    toolKey: safeKey(data.toolKey, 'data.toolKey'),
    accessMode: literal(data.accessMode, 'data.accessMode', ['demo', 'free', 'paid'] as const),
    unitsSpent: boundedInteger(data.unitsSpent, 'data.unitsSpent', 0, 1_000),
  });
}

function parseContentConsumptionProgressed(
  value: unknown,
): Readonly<PropertyPredatorContentConsumptionProgressedData> {
  const data = dataRecord(value, 'data');
  exactKeys(data, 'data', [
    'contentKey', 'contentVersion', 'title', 'medium',
    'progressBasisPoints', 'consumedSeconds',
  ]);
  return Object.freeze({
    contentKey: safeGrowthKey(data.contentKey, 'data.contentKey', 150),
    contentVersion: safeDisplayString(data.contentVersion, 'data.contentVersion', 100),
    title: safeDisplayString(data.title, 'data.title', 200),
    medium: literal(data.medium, 'data.medium', ['video', 'audio', 'article', 'document', 'other'] as const),
    progressBasisPoints: boundedInteger(data.progressBasisPoints, 'data.progressBasisPoints', 0, 10_000),
    consumedSeconds: boundedInteger(data.consumedSeconds, 'data.consumedSeconds', 0, MAX_CONSUMED_SECONDS),
  });
}

function parseContentConsumptionCompleted(
  value: unknown,
): Readonly<PropertyPredatorContentConsumptionCompletedData> {
  const data = dataRecord(value, 'data');
  exactKeys(data, 'data', [
    'contentKey', 'contentVersion', 'title', 'medium',
    'progressBasisPoints', 'consumedSeconds',
  ]);
  const progressBasisPoints = boundedInteger(
    data.progressBasisPoints,
    'data.progressBasisPoints',
    0,
    10_000,
  );
  if (progressBasisPoints !== 10_000) {
    fail('data.progressBasisPoints must be 10000 for a completed content event');
  }
  return Object.freeze({
    contentKey: safeGrowthKey(data.contentKey, 'data.contentKey', 150),
    contentVersion: safeDisplayString(data.contentVersion, 'data.contentVersion', 100),
    title: safeDisplayString(data.title, 'data.title', 200),
    medium: literal(data.medium, 'data.medium', ['video', 'audio', 'article', 'document', 'other'] as const),
    progressBasisPoints: 10_000,
    consumedSeconds: boundedInteger(data.consumedSeconds, 'data.consumedSeconds', 0, MAX_CONSUMED_SECONDS),
  });
}

function parseOfferPrice(value: unknown): Readonly<PropertyPredatorOfferPrice> {
  const price = dataRecord(value, 'data.price');
  exactKeys(price, 'data.price', ['amountMinor', 'currency']);
  return Object.freeze({
    amountMinor: boundedInteger(price.amountMinor, 'data.price.amountMinor', 0, Number.MAX_SAFE_INTEGER),
    currency: currency(price.currency, 'data.price.currency'),
  });
}

function parseOfferPresented(value: unknown): Readonly<PropertyPredatorOfferPresentedData> {
  const data = dataRecord(value, 'data');
  exactKeys(data, 'data', [
    'offerKey', 'offerVersion', 'productKey', 'label', 'price', 'placement',
  ]);
  return Object.freeze({
    offerKey: safeGrowthKey(data.offerKey, 'data.offerKey', 150),
    offerVersion: safeDisplayString(data.offerVersion, 'data.offerVersion', 100),
    productKey: safeGrowthKey(data.productKey, 'data.productKey', 150),
    label: safeDisplayString(data.label, 'data.label', 200),
    price: parseOfferPrice(data.price),
    placement: safeGrowthKey(data.placement, 'data.placement', 100),
  });
}

function parseOfferResponded(value: unknown): Readonly<PropertyPredatorOfferRespondedData> {
  const data = dataRecord(value, 'data');
  exactKeys(data, 'data', ['presentationEventId', 'response']);
  return Object.freeze({
    presentationEventId: canonicalUuid(data.presentationEventId, 'data.presentationEventId'),
    response: literal(
      data.response,
      'data.response',
      ['accepted', 'declined', 'deferred', 'requested_contact'] as const,
    ),
  });
}

function parseAppointmentBooked(value: unknown): Readonly<PropertyPredatorAppointmentBookedData> {
  const data = dataRecord(value, 'data');
  exactKeys(data, 'data', ['appointmentId', 'startsAt', 'bookingSource', 'meetingKind']);
  return Object.freeze({
    appointmentId: safeReference(data.appointmentId, 'data.appointmentId', 128),
    startsAt: canonicalTimestamp(data.startsAt, 'data.startsAt'),
    bookingSource: literal(
      data.bookingSource,
      'data.bookingSource',
      ['self_serve_calendar', 'team', 'partner_referral'] as const,
    ),
    meetingKind: literal(
      data.meetingKind,
      'data.meetingKind',
      ['discovery', 'strategy', 'partner'] as const,
    ),
  });
}

function parsePresentationCompleted(
  value: unknown,
): Readonly<PropertyPredatorPresentationCompletedData> {
  const data = dataRecord(value, 'data');
  exactKeys(data, 'data', [
    'appointmentId', 'presentationKey', 'durationSeconds', 'outcome',
  ]);
  return Object.freeze({
    appointmentId: safeReference(data.appointmentId, 'data.appointmentId', 128),
    presentationKey: safeGrowthKey(data.presentationKey, 'data.presentationKey', 150),
    durationSeconds: boundedInteger(
      data.durationSeconds,
      'data.durationSeconds',
      1,
      MAX_CONSUMED_SECONDS,
    ),
    outcome: literal(
      data.outcome,
      'data.outcome',
      ['completed', 'follow_up_requested', 'proposal_requested'] as const,
    ),
  });
}

function parsePurchaseCompleted(value: unknown): Readonly<PropertyPredatorPurchaseCompletedData> {
  const data = dataRecord(value, 'data');
  exactKeys(data, 'data', [
    'provider', 'providerEventId', 'checkoutSessionId', 'productKey',
    'billingKind', 'amountMinor', 'currency',
  ], ['subscriptionId']);
  const billingKind = literal(
    data.billingKind,
    'data.billingKind',
    ['one_off', 'subscription'] as const,
  );
  const subscriptionId = Object.hasOwn(data, 'subscriptionId')
    ? safeReference(data.subscriptionId, 'data.subscriptionId', 255)
    : undefined;
  if ((billingKind === 'subscription') !== (subscriptionId !== undefined)) {
    fail('data.subscriptionId is required only for subscription billing');
  }
  return Object.freeze({
    provider: literal(data.provider, 'data.provider', ['stripe'] as const),
    providerEventId: safeReference(data.providerEventId, 'data.providerEventId', 255),
    checkoutSessionId: safeReference(data.checkoutSessionId, 'data.checkoutSessionId', 128),
    productKey: safeKey(data.productKey, 'data.productKey'),
    billingKind,
    ...(subscriptionId === undefined ? {} : { subscriptionId }),
    amountMinor: positiveSafeInteger(data.amountMinor, 'data.amountMinor'),
    currency: currency(data.currency, 'data.currency'),
  });
}

function parsePurchaseRefunded(value: unknown): Readonly<PropertyPredatorPurchaseRefundedData> {
  const data = dataRecord(value, 'data');
  exactKeys(data, 'data', [
    'provider', 'providerEventId', 'checkoutSessionId', 'productKey',
    'amountMinor', 'currency',
  ], ['reasonCode']);
  const reasonCode = Object.hasOwn(data, 'reasonCode')
    ? safeKey(data.reasonCode, 'data.reasonCode')
    : undefined;
  return Object.freeze({
    provider: literal(data.provider, 'data.provider', ['stripe'] as const),
    providerEventId: safeReference(data.providerEventId, 'data.providerEventId', 255),
    checkoutSessionId: safeReference(data.checkoutSessionId, 'data.checkoutSessionId', 128),
    productKey: safeKey(data.productKey, 'data.productKey'),
    amountMinor: positiveSafeInteger(data.amountMinor, 'data.amountMinor'),
    currency: currency(data.currency, 'data.currency'),
    ...(reasonCode === undefined ? {} : { reasonCode }),
  });
}

function parseSubscriptionCancelled(value: unknown): Readonly<PropertyPredatorSubscriptionCancelledData> {
  const data = dataRecord(value, 'data');
  exactKeys(data, 'data', [
    'provider', 'providerEventId', 'subscriptionId', 'productKey', 'effectiveAt',
  ]);
  return Object.freeze({
    provider: literal(data.provider, 'data.provider', ['stripe'] as const),
    providerEventId: safeReference(data.providerEventId, 'data.providerEventId', 255),
    subscriptionId: safeReference(data.subscriptionId, 'data.subscriptionId', 255),
    productKey: safeKey(data.productKey, 'data.productKey'),
    effectiveAt: canonicalTimestamp(data.effectiveAt, 'data.effectiveAt'),
  });
}

function eventType(value: unknown): PropertyPredatorExternalEventType {
  if (typeof value !== 'string'
      || !(PROPERTY_PREDATOR_EXTERNAL_EVENT_TYPES as readonly string[]).includes(value)) {
    return fail('type is not supported by the Property Predator V1 event contract');
  }
  return value as PropertyPredatorExternalEventType;
}

export function parsePropertyPredatorExternalEvent(value: unknown): PropertyPredatorExternalEvent {
  const event = dataRecord(value, 'event');
  exactKeys(event, 'event', [
    'id', 'type', 'version', 'occurredAt', 'correlationId', 'subject', 'data',
  ]);
  const type = eventType(event.type);
  if (event.version !== PROPERTY_PREDATOR_EXTERNAL_EVENT_VERSION) {
    fail('version must be 1');
  }
  const common = {
    id: canonicalUuid(event.id, 'id'),
    version: PROPERTY_PREDATOR_EXTERNAL_EVENT_VERSION,
    occurredAt: canonicalTimestamp(event.occurredAt, 'occurredAt'),
    correlationId: canonicalUuid(event.correlationId, 'correlationId'),
    subject: parseSubject(event.subject),
  } as const;

  switch (type) {
    case 'identity.account.created':
      return Object.freeze({ ...common, type, data: parseAccountCreated(event.data) });
    case 'privacy.consent.updated':
      return Object.freeze({ ...common, type, data: parseConsentUpdated(event.data) });
    case 'affiliate.referral.attributed':
      return Object.freeze({ ...common, type, data: parseReferralAttributed(event.data) });
    case 'product.analysis.completed':
      return Object.freeze({ ...common, type, data: parseAnalysisCompleted(event.data) });
    case 'content.consumption.progressed':
      return Object.freeze({ ...common, type, data: parseContentConsumptionProgressed(event.data) });
    case 'content.consumption.completed':
      return Object.freeze({ ...common, type, data: parseContentConsumptionCompleted(event.data) });
    case 'offer.presented':
      return Object.freeze({ ...common, type, data: parseOfferPresented(event.data) });
    case 'offer.responded':
      return Object.freeze({ ...common, type, data: parseOfferResponded(event.data) });
    case 'sales.appointment.booked':
      return Object.freeze({ ...common, type, data: parseAppointmentBooked(event.data) });
    case 'sales.presentation.completed':
      return Object.freeze({ ...common, type, data: parsePresentationCompleted(event.data) });
    case 'commerce.purchase.completed':
      return Object.freeze({ ...common, type, data: parsePurchaseCompleted(event.data) });
    case 'commerce.purchase.refunded':
      return Object.freeze({ ...common, type, data: parsePurchaseRefunded(event.data) });
    case 'commerce.subscription.cancelled':
      return Object.freeze({ ...common, type, data: parseSubscriptionCancelled(event.data) });
  }
}

export function parsePropertyPredatorExternalEventBody(
  rawBody: Uint8Array,
): PropertyPredatorExternalEvent {
  if (!(rawBody instanceof Uint8Array)) {
    throw new TypeError('rawBody must be a Uint8Array');
  }
  if (rawBody.byteLength > PROPERTY_PREDATOR_EXTERNAL_EVENT_MAX_BODY_BYTES) {
    throw new PropertyPredatorExternalEventBodyTooLargeError();
  }
  if (rawBody.byteLength === 0) fail('external event body must not be empty');

  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(rawBody);
  } catch {
    return fail('external event body must be valid UTF-8 JSON');
  }

  let value: unknown;
  try {
    value = JSON.parse(decoded) as unknown;
  } catch {
    return fail('external event body must be valid UTF-8 JSON');
  }
  return parsePropertyPredatorExternalEvent(value);
}
