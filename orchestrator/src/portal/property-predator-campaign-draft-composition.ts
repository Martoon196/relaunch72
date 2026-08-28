import { createHash } from 'node:crypto';
import {
  createPropertyPredatorGenerationTransport,
  PROPERTY_PREDATOR_GENERATE_CREDENTIAL_BOUNDARY,
  type PropertyPredatorGenerationPolicy,
  type PropertyPredatorGenerationPolicyDecision,
  type PropertyPredatorGenerationPolicyOutcome,
  type PropertyPredatorGenerationPolicyRequest,
} from '../company-content-adapter/property-predator-generation.js';
import { PropertyPredatorCampaignDraftRuntime } from
  '../company-content-adapter/property-predator-campaign-draft-runtime.js';

const EXACT_PRODUCT_PROFILE = 'property_predator_growth';
const EXACT_PRODUCTION_SOURCE_ORIGIN = 'https://propertypredator.com';
const LOCAL_SOURCE_ORIGIN = /^http:\/\/(?:127\.0\.0\.1|localhost)(?::[1-9][0-9]{0,4})?$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const SAFE_CLIENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/u;
const VISIBLE_ASCII = /^[\x21-\x7e]+$/u;

/**
 * A deliberately small per-command defence. The Property Predator source
 * remains the durable request/idempotency quota authority (currently scoped
 * per source client); Growth HQ does not manufacture a second in-memory daily
 * ledger that would reset on restart or diverge across instances.
 */
export const PROPERTY_PREDATOR_CAMPAIGN_LOCAL_MAXIMUM_COST_MINOR = 250;
export const PROPERTY_PREDATOR_CAMPAIGN_QUOTA_AUTHORITY =
  'property_predator_source_durable' as const;

const ACTIVATION_ENV = Object.freeze([
  'PROPERTY_PREDATOR_CAMPAIGN_GENERATION_ENABLED',
  'PROPERTY_PREDATOR_CAMPAIGN_GENERATION_PROVIDER_EFFECTS_ENABLED',
  'PROPERTY_PREDATOR_CAMPAIGN_GENERATION_EMERGENCY_PAUSED',
  'PROPERTY_PREDATOR_COMPANY_CONTENT_ORIGIN',
  'PROPERTY_PREDATOR_COMPANY_CONTENT_CLIENT_ID',
  'PROPERTY_PREDATOR_COMPANY_CONTENT_GENERATE_TOKEN',
  'PROPERTY_PREDATOR_COMPANY_CONTENT_TIMEOUT_MS',
  'PROPERTY_PREDATOR_COMPANY_CONTENT_ALLOW_LOCAL_HTTP',
] as const);

const REQUIRED_CREDENTIAL_ENV = Object.freeze([
  'PROPERTY_PREDATOR_COMPANY_CONTENT_ORIGIN',
  'PROPERTY_PREDATOR_COMPANY_CONTENT_CLIENT_ID',
  'PROPERTY_PREDATOR_COMPANY_CONTENT_GENERATE_TOKEN',
  'PROPERTY_PREDATOR_COMPANY_CONTENT_READ_TOKEN',
  'DATABASE_CONTENT_ADAPTER_URL',
] as const);

export type PropertyPredatorCampaignDraftCompositionBlocker =
  | 'GENERATION_DISABLED'
  | 'GENERATION_PROVIDER_EFFECTS_DISABLED'
  | 'GENERATION_EMERGENCY_PAUSED'
  | 'GENERATION_CREDENTIALS_INCOMPLETE';

export interface PropertyPredatorCampaignDraftCompositionReadiness {
  readonly state: 'disabled' | 'review-generation-ready';
  readonly quotaAuthority: typeof PROPERTY_PREDATOR_CAMPAIGN_QUOTA_AUTHORITY;
  readonly localMaximumCostMinor: typeof PROPERTY_PREDATOR_CAMPAIGN_LOCAL_MAXIMUM_COST_MINOR;
  readonly providerEffects: 'none' | 'generation_only';
  readonly outboundEffects: false;
  readonly publishCapability: false;
  readonly sendCapability: false;
  readonly scheduleCapability: false;
  readonly providerNetworkCallsMadeAtReadiness: false;
  readonly blockers: readonly PropertyPredatorCampaignDraftCompositionBlocker[];
}

export interface PropertyPredatorCampaignDraftComposition {
  readonly readiness: PropertyPredatorCampaignDraftCompositionReadiness;
  readonly runtime?: PropertyPredatorCampaignDraftRuntime;
}

export interface PropertyPredatorCampaignDraftCompositionDependencies {
  readonly fetchImpl?: typeof fetch;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function disabledReadiness(
  blockers: readonly PropertyPredatorCampaignDraftCompositionBlocker[],
): PropertyPredatorCampaignDraftCompositionReadiness {
  return Object.freeze({
    state: 'disabled',
    quotaAuthority: PROPERTY_PREDATOR_CAMPAIGN_QUOTA_AUTHORITY,
    localMaximumCostMinor: PROPERTY_PREDATOR_CAMPAIGN_LOCAL_MAXIMUM_COST_MINOR,
    providerEffects: 'none',
    outboundEffects: false,
    publishCapability: false,
    sendCapability: false,
    scheduleCapability: false,
    providerNetworkCallsMadeAtReadiness: false,
    blockers: Object.freeze([...blockers]),
  });
}

function readyReadiness(): PropertyPredatorCampaignDraftCompositionReadiness {
  return Object.freeze({
    state: 'review-generation-ready',
    quotaAuthority: PROPERTY_PREDATOR_CAMPAIGN_QUOTA_AUTHORITY,
    localMaximumCostMinor: PROPERTY_PREDATOR_CAMPAIGN_LOCAL_MAXIMUM_COST_MINOR,
    providerEffects: 'generation_only',
    outboundEffects: false,
    publishCapability: false,
    sendCapability: false,
    scheduleCapability: false,
    providerNetworkCallsMadeAtReadiness: false,
    blockers: Object.freeze([]),
  });
}

function activationBlockers(
  env: NodeJS.ProcessEnv,
): readonly PropertyPredatorCampaignDraftCompositionBlocker[] {
  const blockers: PropertyPredatorCampaignDraftCompositionBlocker[] = [];
  if (env.PROPERTY_PREDATOR_CAMPAIGN_GENERATION_ENABLED?.trim() !== 'true') {
    blockers.push('GENERATION_DISABLED');
  }
  if (env.PROPERTY_PREDATOR_CAMPAIGN_GENERATION_PROVIDER_EFFECTS_ENABLED?.trim() !== 'true') {
    blockers.push('GENERATION_PROVIDER_EFFECTS_DISABLED');
  }
  if (env.PROPERTY_PREDATOR_CAMPAIGN_GENERATION_EMERGENCY_PAUSED?.trim() !== 'false') {
    blockers.push('GENERATION_EMERGENCY_PAUSED');
  }
  if (!REQUIRED_CREDENTIAL_ENV.every((name) => Boolean(env[name]?.trim()))) {
    blockers.push('GENERATION_CREDENTIALS_INCOMPLETE');
  }
  return Object.freeze(blockers);
}

function boundedTimeout(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return 8_000;
  const canonical = raw.trim();
  if (!/^[1-9][0-9]{2,4}$/u.test(canonical)) {
    throw new Error('PROPERTY_PREDATOR_COMPANY_CONTENT_TIMEOUT_MS must be a bounded integer');
  }
  const value = Number(canonical);
  if (!Number.isSafeInteger(value) || value < 100 || value > 10_000) {
    throw new Error('PROPERTY_PREDATOR_COMPANY_CONTENT_TIMEOUT_MS must be between 100 and 10000');
  }
  return value;
}

function exactSourceOrigin(env: NodeJS.ProcessEnv): Readonly<{
  sourceOrigin: string;
  allowLocalHttp: boolean;
}> {
  const sourceOrigin = env.PROPERTY_PREDATOR_COMPANY_CONTENT_ORIGIN?.trim() ?? '';
  const allowLocalHttp = env.PROPERTY_PREDATOR_COMPANY_CONTENT_ALLOW_LOCAL_HTTP?.trim() === 'true';
  if (allowLocalHttp && env.NODE_ENV?.trim().toLowerCase() === 'production') {
    throw new Error('Local HTTP campaign generation source is forbidden in production');
  }
  if (sourceOrigin !== EXACT_PRODUCTION_SOURCE_ORIGIN
      && !(allowLocalHttp && LOCAL_SOURCE_ORIGIN.test(sourceOrigin))) {
    throw new Error('Campaign generation source must be the exact propertypredator.com origin');
  }
  return Object.freeze({ sourceOrigin, allowLocalHttp });
}

function exactCredential(env: NodeJS.ProcessEnv): Readonly<{
  sourceClientId: string;
  generateToken: string;
  readCredentialSha256: string;
  syncCredentialSha256: string;
}> {
  const sourceClientId = env.PROPERTY_PREDATOR_COMPANY_CONTENT_CLIENT_ID?.trim() ?? '';
  const generateToken = env.PROPERTY_PREDATOR_COMPANY_CONTENT_GENERATE_TOKEN ?? '';
  const readToken = env.PROPERTY_PREDATOR_COMPANY_CONTENT_READ_TOKEN ?? '';
  const contentAdapterUrl = env.DATABASE_CONTENT_ADAPTER_URL ?? '';
  if (!SAFE_CLIENT_ID.test(sourceClientId)
      || generateToken !== generateToken.trim()
      || Buffer.byteLength(generateToken, 'utf8') < 32
      || Buffer.byteLength(generateToken, 'utf8') > 512
      || !VISIBLE_ASCII.test(generateToken)
      || readToken !== readToken.trim()
      || Buffer.byteLength(readToken, 'utf8') < 32
      || Buffer.byteLength(readToken, 'utf8') > 512
      || !VISIBLE_ASCII.test(readToken)
      || contentAdapterUrl !== contentAdapterUrl.trim()
      || Buffer.byteLength(contentAdapterUrl, 'utf8') < 16
      || Buffer.byteLength(contentAdapterUrl, 'utf8') > 4_096
      || !VISIBLE_ASCII.test(contentAdapterUrl)) {
    throw new Error('Property Predator campaign generation credentials are invalid');
  }
  return Object.freeze({
    sourceClientId,
    generateToken,
    // Derive separation evidence from the exact credentials already mounted in
    // this process. Only their digests enter the generate bridge object.
    readCredentialSha256: sha256(readToken),
    syncCredentialSha256: sha256(contentAdapterUrl),
  });
}

function validPolicyRequest(input: PropertyPredatorGenerationPolicyRequest): boolean {
  return Boolean(input && typeof input === 'object'
    && SHA256.test(input.requestSha256)
    && SHA256.test(input.idempotencyKeySha256)
    && SHA256.test(input.expectedBrandSha256)
    && SHA256.test(input.contextSha256)
    && input.kind === 'post'
    && Number.isSafeInteger(input.requestBytes) && input.requestBytes > 0
    && Number.isSafeInteger(input.maximumCostMinor) && input.maximumCostMinor > 0);
}

/**
 * Stateless by design. It authorises one bounded Growth HQ call while the
 * source endpoint performs the durable per-client quota and idempotency claim.
 * `recordOutcome` intentionally keeps no restart-sensitive counter; immutable
 * usage evidence is returned by, and retained at, the source instead.
 */
export function createPropertyPredatorUpstreamAuthoritativeGenerationPolicy():
PropertyPredatorGenerationPolicy {
  return Object.freeze({
    async reserve(
      request: PropertyPredatorGenerationPolicyRequest,
    ): Promise<PropertyPredatorGenerationPolicyDecision> {
      if (!validPolicyRequest(request)) {
        return Object.freeze({ allowed: false, reasonCode: 'policy_unavailable' });
      }
      if (request.maximumCostMinor > PROPERTY_PREDATOR_CAMPAIGN_LOCAL_MAXIMUM_COST_MINOR) {
        return Object.freeze({ allowed: false, reasonCode: 'spend_exhausted' });
      }
      const reservationSha256 = sha256([
        PROPERTY_PREDATOR_CAMPAIGN_QUOTA_AUTHORITY,
        request.requestSha256,
        request.idempotencyKeySha256,
        String(request.maximumCostMinor),
      ].join(':'));
      return Object.freeze({
        allowed: true,
        reservationId: `upstream-authority:${reservationSha256}`,
        generationEnabled: true,
        providerEffectsEnabled: true,
        emergencyPaused: false,
        availableRequestSlots: 1,
        availableSpendMinor: PROPERTY_PREDATOR_CAMPAIGN_LOCAL_MAXIMUM_COST_MINOR,
        approvedMaximumCostMinor: request.maximumCostMinor,
      });
    },
    async recordOutcome(_outcome: PropertyPredatorGenerationPolicyOutcome): Promise<void> {
      // The Property Predator source owns durable reservation, usage and replay evidence.
    },
  });
}

/**
 * Builds no provider adapter unless every campaign-specific switch and scoped
 * credential is exact. A dark or incomplete configuration is a valid disabled
 * state, allowing the Campaign Wizard GET to remain honest without exposing a
 * button that would fail later. Any campaign configuration on another product
 * profile fails closed as a cross-product secret-placement error.
 */
export function composePropertyPredatorCampaignDraftRuntime(
  env: NodeJS.ProcessEnv = process.env,
  dependencies: PropertyPredatorCampaignDraftCompositionDependencies = {},
): PropertyPredatorCampaignDraftComposition {
  const exactProfile = env.PORTAL_PRODUCT_PROFILE?.trim() === EXACT_PRODUCT_PROFILE;
  const anyConfigured = ACTIVATION_ENV.some((name) => Boolean(env[name]?.trim()));
  if (anyConfigured && !exactProfile) {
    throw new Error(
      'Property Predator campaign generation is forbidden outside property_predator_growth',
    );
  }
  const blockers = activationBlockers(env);
  if (!exactProfile || blockers.length > 0) {
    return Object.freeze({ readiness: disabledReadiness(blockers) });
  }

  const source = exactSourceOrigin(env);
  const credential = exactCredential(env);
  const generation = createPropertyPredatorGenerationTransport({
    baseUrl: source.sourceOrigin,
    credential: Object.freeze({
      boundary: PROPERTY_PREDATOR_GENERATE_CREDENTIAL_BOUNDARY,
      clientId: credential.sourceClientId,
      generateToken: credential.generateToken,
      readCredentialSha256: credential.readCredentialSha256,
      syncCredentialSha256: credential.syncCredentialSha256,
    }),
    approvedCtaHosts: Object.freeze(['propertypredator.com', 'www.propertypredator.com']),
    policy: createPropertyPredatorUpstreamAuthoritativeGenerationPolicy(),
    timeoutMs: boundedTimeout(env.PROPERTY_PREDATOR_COMPANY_CONTENT_TIMEOUT_MS),
    fetchImpl: dependencies.fetchImpl,
    allowLocalHttp: source.allowLocalHttp,
  });
  return Object.freeze({
    readiness: readyReadiness(),
    runtime: new PropertyPredatorCampaignDraftRuntime({
      generation,
      providerEffectsEnabled: true,
      emergencyPaused: false,
      hardMaximumCostMinor: PROPERTY_PREDATOR_CAMPAIGN_LOCAL_MAXIMUM_COST_MINOR,
    }),
  });
}
