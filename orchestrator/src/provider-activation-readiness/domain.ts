import { createHash } from 'node:crypto';
import { isPlatformCapability, type PlatformCapability } from '../platform/capabilities.js';
import {
  providerRegistry,
  type ProviderCredentialAuthMode,
  type ProviderKind,
  type ProviderManifest,
  type ProviderRegistry,
  type ProviderWebhookVerificationMode,
} from '../providers/registry.js';

/**
 * A pure, dark-only assessment boundary for provider activation evidence.
 *
 * This module cannot load credentials, call adapters, create provider
 * operations, or authorise live effects. It only assesses bounded metadata and
 * immutable evidence references, with `internal_seed_ready` as a hard ceiling.
 */

export const PROVIDER_ACTIVATION_RAILS = Object.freeze([
  'mailgun_email',
  'whatsapp',
  'public_social',
  'social_dm',
] as const);

export type ProviderActivationRail = (typeof PROVIDER_ACTIVATION_RAILS)[number];

export const PROVIDER_ACTIVATION_READINESS_STAGES = Object.freeze([
  'adapter_contract_verified',
  'provider_test_verified',
  'internal_seed_ready',
] as const);

export type ProviderActivationReadinessStage =
  (typeof PROVIDER_ACTIVATION_READINESS_STAGES)[number];
export type ProviderActivationReadiness = 'not_ready' | ProviderActivationReadinessStage;

export const PROVIDER_ACTIVATION_READINESS_CEILING = 'internal_seed_ready' as const;

export const PROVIDER_ACTIVATION_GATES = Object.freeze([
  'commercialSaasRights',
  'dpa',
  'security',
  'dataRegion',
  'accountOwnership',
  'workspaceIsolation',
  'secretManagerReference',
  'signedWebhook',
  'replayProtection',
  'idempotency',
  'reconciliation',
  'consent',
  'purpose',
  'territory',
  'sender',
  'suppression',
  'approval',
  'version',
  'spendCaps',
  'volumeCaps',
  'emergencyPause',
  'runtimeEffectsSwitch',
  'databaseEffectsSwitch',
  'workspaceEffectsSwitch',
  'railEffectsSwitch',
  'export',
  'deletion',
  'exit',
  'adapterContract',
  'testProvider',
  'internalSeed',
] as const);

export type ProviderActivationGate = (typeof PROVIDER_ACTIVATION_GATES)[number];

export type ProviderEvidenceStatus = 'verified' | 'not_applicable' | 'missing' | 'failed';

export interface ProviderGateEvidence {
  readonly gate: ProviderActivationGate;
  readonly rail: ProviderActivationRail;
  readonly providerId: string;
  readonly adapterContractVersion: string;
  readonly workspaceId: string;
  readonly providerConnectionId: string;
  readonly assessedScopeVersion: 1;
  readonly assessedScopeSha256: string;
  readonly status: ProviderEvidenceStatus;
  readonly evidenceId: string | null;
  readonly evidenceSha256: string | null;
  readonly verifiedAt: string | null;
  readonly expiresAt: string | null;
}

export interface ProviderReadinessManifestMetadata {
  readonly providerId: string;
  readonly kind: ProviderKind;
  readonly outboundCredentialAuth: ProviderCredentialAuthMode;
  readonly inboundWebhookVerification: ProviderWebhookVerificationMode;
  readonly capabilities: readonly PlatformCapability[];
  readonly adapterContractVersion: string;
}

export interface ProviderActivationContractRegistration {
  readonly rail: ProviderActivationRail;
  readonly providerId: string;
  readonly adapterContractVersion: string;
}

/** Opaque, immutable resolver created only from provider-registry metadata. */
export interface ProviderActivationAuthority {
  readonly authorityVersion: 1;
  readonly manifestCount: number;
}

export interface ProviderReadinessWorkspaceScope {
  readonly workspaceId: string;
  readonly providerConnectionId: string;
}

export type CommercialRightsModel =
  | 'internal_use_only'
  | 'commercial_saas'
  | 'white_label_resale'
  | 'managed_service';

export interface CommercialRightsScope {
  readonly model: CommercialRightsModel;
  readonly territories: readonly string[];
}

export interface PrivacyAndRegionScope {
  readonly dpaRoleModel: 'controller_processor' | 'independent_controllers' | 'joint_controllers';
  readonly dataRegions: readonly ('GB' | 'EEA' | 'US' | 'OTHER')[];
  readonly transferMechanism:
    | 'not_required'
    | 'uk_adequacy'
    | 'uk_idta'
    | 'uk_addendum'
    | 'approved_other';
}

export interface ProviderAccountScope {
  readonly ownership: 'unknown' | 'operator_owned' | 'client_owned_managed';
  readonly providerAccountReferenceSha256: string;
}

export interface WorkspaceIsolationScope {
  readonly workspaceId: string;
  readonly providerConnectionId: string;
  readonly compositeLookupEnforced: boolean;
  readonly rowLevelSecurityEnforced: boolean;
  readonly crossWorkspaceTestPassed: boolean;
}

export interface SecretManagerMetadataReference {
  readonly manager:
    | 'render_secret'
    | 'aws_secrets_manager'
    | 'gcp_secret_manager'
    | 'azure_key_vault'
    | 'vault';
  readonly referenceId: string;
  readonly locatorSha256: string;
}

export interface WebhookAndReconciliationScope {
  readonly verificationMode: ProviderWebhookVerificationMode;
  readonly replayWindowSeconds: number;
  readonly idempotencyNamespaceSha256: string;
  readonly reconciliationMode: 'signed_webhook_and_poll' | 'signed_webhook_and_provider_query';
  readonly maxReconciliationLagSeconds: number;
}

export type ConsentRoute =
  | 'solicited_request'
  | 'individual_consent'
  | 'individual_soft_opt_in'
  | 'corporate_subscriber_reg_23'
  | 'not_applicable_public_broadcast';

export interface ChannelPolicyScope {
  readonly consentRoute: ConsentRoute;
  readonly purpose:
    | 'internal_seed_validation'
    | 'product_marketing'
    | 'customer_service'
    | 'approved_content_publish';
  readonly territories: readonly string[];
  readonly senderReferenceSha256: string;
  readonly suppressionScope:
    | 'recipient_workspace_provider'
    | 'public_broadcast_not_applicable';
}

export interface ApprovalAndVersionScope {
  readonly approvalId: string;
  readonly versionId: string;
  readonly contentSha256: string;
}

export interface SpendAndVolumeCaps {
  readonly currency: 'GBP' | 'USD' | 'EUR';
  readonly maxSpendPerOperationMinorUnits: number;
  readonly maxSpendPerDayMinorUnits: number;
  readonly maxSpendPerMonthMinorUnits: number;
  readonly maxVolumePerOperation: number;
  readonly maxVolumePerDay: number;
  readonly maxVolumePerMonth: number;
}

export interface DarkEffectsSwitchScope {
  readonly emergencyPaused: boolean;
  readonly runtimeEffects: 'off' | 'on';
  readonly databaseEffects: 'off' | 'on';
  readonly workspaceEffects: 'off' | 'on';
  readonly railEffects: 'off' | 'on';
}

export interface DataLifecycleScope {
  readonly exportPlanSha256: string;
  readonly deletionPlanSha256: string;
  readonly exitPlanSha256: string;
}

export interface TestProviderScope {
  readonly mode: 'simulated' | 'provider_sandbox';
  readonly fixturePackSha256: string;
  readonly testRunId: string;
}

export interface InternalSeedScope {
  readonly destinationScope: 'owned_internal_destinations_only';
  readonly ownershipVerified: boolean;
  readonly maxDestinations: number;
  /** Hash references only: never email addresses, phone numbers, handles or account IDs. */
  readonly destinationReferenceHashes: readonly string[];
}

export interface ProviderReadinessScope {
  readonly commercialRights: CommercialRightsScope;
  readonly privacy: PrivacyAndRegionScope;
  readonly account: ProviderAccountScope;
  readonly isolation: WorkspaceIsolationScope;
  readonly secretManager: SecretManagerMetadataReference;
  readonly webhook: WebhookAndReconciliationScope;
  readonly policy: ChannelPolicyScope;
  readonly approval: ApprovalAndVersionScope;
  readonly caps: SpendAndVolumeCaps;
  readonly switches: DarkEffectsSwitchScope;
  readonly lifecycle: DataLifecycleScope;
  readonly testProvider: TestProviderScope;
  readonly internalSeed: InternalSeedScope;
}

export interface ProviderActivationReadinessInput {
  readonly schemaVersion: 1;
  readonly rail: ProviderActivationRail;
  readonly provider: ProviderReadinessManifestMetadata;
  readonly workspace: ProviderReadinessWorkspaceScope;
  readonly scope: ProviderReadinessScope;
  readonly evidence: Readonly<Record<ProviderActivationGate, ProviderGateEvidence>>;
}

export type ProviderReadinessReasonCode =
  | 'INPUT_INVALID'
  | 'EVIDENCE_MISSING'
  | 'EVIDENCE_FAILED'
  | 'EVIDENCE_STALE'
  | 'NOT_APPLICABLE_INVALID'
  | 'PROVIDER_METADATA_MISMATCH'
  | 'COMMERCIAL_RIGHTS_INSUFFICIENT'
  | 'DATA_TRANSFER_UNRESOLVED'
  | 'ACCOUNT_OWNERSHIP_UNVERIFIED'
  | 'WORKSPACE_SCOPE_MISMATCH'
  | 'WORKSPACE_ISOLATION_UNVERIFIED'
  | 'WEBHOOK_CONTRACT_UNSAFE'
  | 'PROVIDER_TEST_SCOPE_INVALID'
  | 'CHANNEL_POLICY_SCOPE_INVALID'
  | 'TERRITORY_OUTSIDE_COMMERCIAL_RIGHTS'
  | 'DARK_SWITCH_INVARIANT_FAILED'
  | 'INTERNAL_SEED_SCOPE_INVALID';

export interface ProviderReadinessReason {
  readonly code: ProviderReadinessReasonCode;
  readonly gate: ProviderActivationGate | null;
  readonly message: string;
}

export type ProviderReadinessValidationCode =
  | 'INPUT_NOT_PLAIN_DATA'
  | 'INPUT_SHAPE_INVALID'
  | 'INPUT_VALUE_INVALID'
  | 'FORBIDDEN_CREDENTIAL_FIELD';

export interface ProviderReadinessValidationIssue {
  readonly code: ProviderReadinessValidationCode;
  readonly path: string;
  readonly message: string;
}

export interface ProviderReadinessStageResult {
  readonly stage: ProviderActivationReadinessStage;
  readonly ready: boolean;
  readonly blockers: readonly ProviderReadinessReason[];
}

export interface ProviderActivationReadinessReport {
  readonly schemaVersion: 1;
  readonly inputAccepted: boolean;
  readonly rail: ProviderActivationRail | null;
  readonly providerId: string | null;
  readonly workspaceId: string | null;
  readonly evaluatedAt: string;
  readonly readiness: ProviderActivationReadiness;
  readonly ceiling: typeof PROVIDER_ACTIVATION_READINESS_CEILING;
  readonly nextStage: ProviderActivationReadinessStage | null;
  readonly blockingReasons: readonly ProviderReadinessReason[];
  readonly validationIssues: readonly ProviderReadinessValidationIssue[];
  readonly stages: readonly ProviderReadinessStageResult[];
  readonly safety: Readonly<{
    liveAuthorised: false;
    providerEffectsAllowed: false;
    providerOperationsCreated: 0;
    separateActivationRequired: true;
  }>;
}

const ADAPTER_STAGE_GATES: readonly ProviderActivationGate[] = Object.freeze([
  'commercialSaasRights',
  'dpa',
  'security',
  'dataRegion',
  'accountOwnership',
  'workspaceIsolation',
  'secretManagerReference',
  'signedWebhook',
  'replayProtection',
  'idempotency',
  'reconciliation',
  'emergencyPause',
  'runtimeEffectsSwitch',
  'databaseEffectsSwitch',
  'workspaceEffectsSwitch',
  'railEffectsSwitch',
  'export',
  'deletion',
  'exit',
  'adapterContract',
]);

const PROVIDER_TEST_STAGE_GATES: readonly ProviderActivationGate[] = Object.freeze([
  ...ADAPTER_STAGE_GATES,
  'spendCaps',
  'volumeCaps',
  'testProvider',
]);

const INTERNAL_SEED_STAGE_GATES: readonly ProviderActivationGate[] = Object.freeze([
  ...PROVIDER_TEST_STAGE_GATES,
  'consent',
  'purpose',
  'territory',
  'sender',
  'suppression',
  'approval',
  'version',
  'internalSeed',
]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const PROVIDER_ID = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/;
const SEMVER = /^(?:0|[1-9][0-9]{0,3})\.(?:0|[1-9][0-9]{0,3})\.(?:0|[1-9][0-9]{0,3})$/;
const ISO_TERRITORY = /^[A-Z]{2}$/;
const CANONICAL_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MAX_INPUT_DEPTH = 16;
const MAX_ARRAY_ITEMS = 64;
const MAX_OBJECT_KEYS = 64;
const MAX_TOTAL_NODES = 2_048;
const MAX_TOTAL_KEYS = 1_024;
const MAX_KEY_BYTES = 128;
const MAX_STRING_BYTES = 1_024;
const MAX_TOTAL_PLAIN_DATA_BYTES = 128 * 1_024;

const FORBIDDEN_CREDENTIAL_KEYS = new Set([
  'apikey',
  'accesstoken',
  'refreshtoken',
  'password',
  'credential',
  'credentials',
  'clientsecret',
  'signingkey',
  'webhooksecret',
  'secretvalue',
  'privatekey',
  'bearer',
  'authorization',
]);

const PROVIDER_KINDS = new Set<ProviderKind>([
  'social', 'messaging', 'webinar', 'email', 'payments', 'analytics',
]);
const CREDENTIAL_MODES = new Set<ProviderCredentialAuthMode>([
  'oauth2', 'api_key', 'service_account', 'none',
]);
const WEBHOOK_MODES = new Set<ProviderWebhookVerificationMode>([
  'hmac_signature', 'asymmetric_signature', 'verification_token', 'none',
]);

const REQUIRED_CAPABILITIES_BY_RAIL: Readonly<
  Record<ProviderActivationRail, readonly PlatformCapability[]>
> = Object.freeze({
  mailgun_email: Object.freeze(['conversations.reply'] as const),
  whatsapp: Object.freeze(['channel.whatsapp', 'conversations.reply'] as const),
  public_social: Object.freeze(['social.publish'] as const),
  social_dm: Object.freeze(['conversations.reply'] as const),
});

interface TrustedProviderActivationManifest {
  readonly rail: ProviderActivationRail;
  readonly provider: ProviderManifest;
  readonly adapterContractVersion: string;
}

const AUTHORITY_MANIFESTS = new WeakMap<
  ProviderActivationAuthority,
  ReadonlyMap<string, TrustedProviderActivationManifest>
>();

function authorityKey(rail: ProviderActivationRail, providerId: string): string {
  return `${rail}\u0000${providerId}`;
}

/**
 * Bind reviewed adapter-contract versions to immutable provider-registry rows.
 *
 * Production uses the composed registry below. The current registry is empty,
 * so production assessments fail closed until a real adapter is registered and
 * explicitly given a reviewed contract version by composition.
 */
export function createProviderActivationAuthority(
  registry: ProviderRegistry,
  registrations: readonly ProviderActivationContractRegistration[],
): ProviderActivationAuthority {
  if (!Object.isFrozen(registry) || !Object.isFrozen(registry.providers)) {
    throw new Error('provider activation authority requires an immutable provider registry');
  }
  if (!Array.isArray(registrations) || registrations.length > 32) {
    throw new Error('provider activation authority registration count is invalid');
  }
  const manifests = new Map<string, TrustedProviderActivationManifest>();
  const reviewedRegistrations = registrations as readonly ProviderActivationContractRegistration[];
  for (const registration of reviewedRegistrations) {
    if (!PROVIDER_ACTIVATION_RAILS.includes(registration.rail)
        || !PROVIDER_ID.test(registration.providerId)
        || !SEMVER.test(registration.adapterContractVersion)) {
      throw new Error('provider activation authority registration is invalid');
    }
    let provider: ProviderManifest;
    try {
      provider = registry.get(registration.providerId);
    } catch {
      throw new Error(`provider activation authority references unknown provider: ${registration.providerId}`);
    }
    if (!Object.isFrozen(provider) || !Object.isFrozen(provider.capabilities)) {
      throw new Error('provider activation authority requires immutable provider manifests');
    }
    const requiredCapabilities = REQUIRED_CAPABILITIES_BY_RAIL[registration.rail];
    if (requiredCapabilities.some((capability) => !provider.capabilities.includes(capability))) {
      throw new Error(`provider ${provider.id} lacks the required ${registration.rail} capability`);
    }
    const key = authorityKey(registration.rail, registration.providerId);
    if (manifests.has(key)) throw new Error('duplicate provider activation authority registration');
    manifests.set(key, Object.freeze({
      rail: registration.rail,
      provider,
      adapterContractVersion: registration.adapterContractVersion,
    }));
  }
  const authority = Object.freeze({
    authorityVersion: 1 as const,
    manifestCount: manifests.size,
  });
  AUTHORITY_MANIFESTS.set(authority, manifests);
  return authority;
}

const DEFAULT_PROVIDER_ACTIVATION_AUTHORITY = createProviderActivationAuthority(providerRegistry, []);

type PlainRecord = Record<string, unknown>;

class ReadinessValidationError extends Error {
  readonly issue: ProviderReadinessValidationIssue;

  constructor(issue: ProviderReadinessValidationIssue) {
    super(issue.message);
    this.name = 'ReadinessValidationError';
    this.issue = Object.freeze({ ...issue });
  }
}

function invalid(
  code: ProviderReadinessValidationCode,
  path: string,
  message: string,
): never {
  throw new ReadinessValidationError({ code, path, message });
}

interface PlainDataBudget {
  nodes: number;
  keys: number;
  bytes: number;
}

function consumePlainDataBytes(
  budget: PlainDataBudget,
  value: string,
  path: string,
  perValueLimit: number,
): void {
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes > perValueLimit) {
    invalid('INPUT_VALUE_INVALID', path, `${path} exceeds its byte bound.`);
  }
  budget.bytes += bytes;
  if (budget.bytes > MAX_TOTAL_PLAIN_DATA_BYTES) {
    invalid('INPUT_VALUE_INVALID', 'input', 'Input exceeds the total plain-data byte bound.');
  }
}

function scanForCredentialFields(
  value: unknown,
  path: string,
  ancestors: WeakSet<object>,
  budget: PlainDataBudget,
  depth = 0,
): void {
  budget.nodes += 1;
  budget.bytes += 8;
  if (budget.nodes > MAX_TOTAL_NODES || budget.bytes > MAX_TOTAL_PLAIN_DATA_BYTES) {
    invalid('INPUT_VALUE_INVALID', 'input', 'Input exceeds the total plain-data bound.');
  }
  if (typeof value === 'string') {
    consumePlainDataBytes(budget, value, path, MAX_STRING_BYTES);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  if (depth > MAX_INPUT_DEPTH) {
    invalid('INPUT_NOT_PLAIN_DATA', path, 'Input nesting exceeds the supported limit.');
  }
  if (ancestors.has(value)) invalid('INPUT_NOT_PLAIN_DATA', path, 'Input must not contain circular references.');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype || value.length > MAX_ARRAY_ITEMS) {
        invalid('INPUT_VALUE_INVALID', path, 'Input array exceeds the supported limit.');
      }
      const keys = Reflect.ownKeys(value);
      const expectedKeys = [...Array(value.length).keys()].map(String);
      if (keys.length !== value.length + 1
          || keys.some((key) => typeof key !== 'string')
          || !expectedKeys.every((key) => Object.prototype.hasOwnProperty.call(value, key))) {
        invalid('INPUT_NOT_PLAIN_DATA', path, 'Input arrays must be dense plain-data arrays.');
      }
      expectedKeys.forEach((key, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor?.enumerable || !('value' in descriptor)) {
          invalid('INPUT_NOT_PLAIN_DATA', `${path}[${index}]`, 'Input arrays must contain data properties only.');
        }
        budget.keys += 1;
        if (budget.keys > MAX_TOTAL_KEYS) {
          invalid('INPUT_VALUE_INVALID', 'input', 'Input exceeds the total key bound.');
        }
        scanForCredentialFields(descriptor.value, `${path}[${index}]`, ancestors, budget, depth + 1);
      });
      return;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      invalid('INPUT_NOT_PLAIN_DATA', path, 'Input must contain plain data objects only.');
    }
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length > MAX_OBJECT_KEYS) {
      invalid('INPUT_VALUE_INVALID', path, 'Input object exceeds the supported key bound.');
    }
    if (ownKeys.some((key) => typeof key !== 'string')) {
      invalid('INPUT_NOT_PLAIN_DATA', path, 'Symbol properties are not supported.');
    }
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      budget.keys += 1;
      if (budget.keys > MAX_TOTAL_KEYS) {
        invalid('INPUT_VALUE_INVALID', 'input', 'Input exceeds the total key bound.');
      }
      consumePlainDataBytes(budget, key, `${path}.${key}`, MAX_KEY_BYTES);
      if (!descriptor.enumerable || !('value' in descriptor)) {
        invalid('INPUT_NOT_PLAIN_DATA', `${path}.${key}`, 'Input fields must be enumerable data properties.');
      }
      const normalised = key.replace(/[^a-z0-9]/giu, '').toLowerCase();
      if (FORBIDDEN_CREDENTIAL_KEYS.has(normalised)) {
        invalid(
          'FORBIDDEN_CREDENTIAL_FIELD',
          `${path}.${key}`,
          'Credential material is forbidden; provide only a secret-manager metadata reference.',
        );
      }
      scanForCredentialFields(descriptor.value, `${path}.${key}`, ancestors, budget, depth + 1);
    }
  } finally {
    ancestors.delete(value);
  }
}

function exactRecord(value: unknown, path: string, expectedKeys: readonly string[]): PlainRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return invalid('INPUT_NOT_PLAIN_DATA', path, `${path} must be a plain object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return invalid('INPUT_NOT_PLAIN_DATA', path, `${path} must be a plain object.`);
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    return invalid('INPUT_NOT_PLAIN_DATA', path, `${path} must not contain symbol properties.`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!descriptor.enumerable || !('value' in descriptor)) {
      return invalid('INPUT_NOT_PLAIN_DATA', `${path}.${key}`, `${path} must contain data properties only.`);
    }
  }
  const actual = Object.keys(descriptors).sort();
  const expected = [...expectedKeys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    return invalid('INPUT_SHAPE_INVALID', path, `${path} contains missing or unsupported fields.`);
  }
  const result: PlainRecord = {};
  for (const key of expectedKeys) result[key] = descriptors[key]!.value;
  return result;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], path: string): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    return invalid('INPUT_VALUE_INVALID', path, `${path} has an unsupported value.`);
  }
  return value as T;
}

function canonicalUuid(value: unknown, path: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) {
    return invalid('INPUT_VALUE_INVALID', path, `${path} must be a canonical lowercase UUID.`);
  }
  return value;
}

function sha256(value: unknown, path: string): string {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    return invalid('INPUT_VALUE_INVALID', path, `${path} must be a lowercase SHA-256 digest.`);
  }
  return value;
}

function booleanValue(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') {
    return invalid('INPUT_VALUE_INVALID', path, `${path} must be boolean.`);
  }
  return value;
}

function boundedInteger(value: unknown, path: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    return invalid('INPUT_VALUE_INVALID', path, `${path} is outside the supported integer range.`);
  }
  return value as number;
}

function canonicalInstant(value: unknown, path: string): string {
  if (typeof value !== 'string' || !CANONICAL_TIMESTAMP.test(value)) {
    return invalid('INPUT_VALUE_INVALID', path, `${path} must be a canonical RFC3339 UTC timestamp.`);
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    return invalid('INPUT_VALUE_INVALID', path, `${path} must be a real canonical UTC instant.`);
  }
  return value;
}

function canonicalJsonValue(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, canonicalJsonValue((value as Record<string, unknown>)[key])]),
    );
  }
  throw new Error('assessed provider scope is not canonical plain data');
}

export function providerActivationAssessedScopeSha256(
  input: Pick<ProviderActivationReadinessInput, 'schemaVersion' | 'rail' | 'provider' | 'workspace' | 'scope'>,
): string {
  const canonical = JSON.stringify(canonicalJsonValue({
    schemaVersion: input.schemaVersion,
    rail: input.rail,
    provider: input.provider,
    workspace: input.workspace,
    scope: input.scope,
  }));
  return createHash('sha256')
    .update('provider-activation-assessed-scope/v1\u0000', 'utf8')
    .update(canonical, 'utf8')
    .digest('hex');
}

const DAY_MS = 24 * 60 * 60 * 1_000;
const PROVIDER_GATE_MAX_AGE_MS: Readonly<Record<ProviderActivationGate, number>> = Object.freeze({
  commercialSaasRights: 365 * DAY_MS,
  dpa: 365 * DAY_MS,
  security: 90 * DAY_MS,
  dataRegion: 90 * DAY_MS,
  accountOwnership: 90 * DAY_MS,
  workspaceIsolation: 30 * DAY_MS,
  secretManagerReference: 30 * DAY_MS,
  signedWebhook: 30 * DAY_MS,
  replayProtection: 30 * DAY_MS,
  idempotency: 30 * DAY_MS,
  reconciliation: 30 * DAY_MS,
  consent: 7 * DAY_MS,
  purpose: 7 * DAY_MS,
  territory: 30 * DAY_MS,
  sender: 7 * DAY_MS,
  suppression: 7 * DAY_MS,
  approval: 7 * DAY_MS,
  version: 7 * DAY_MS,
  spendCaps: DAY_MS,
  volumeCaps: DAY_MS,
  emergencyPause: DAY_MS,
  runtimeEffectsSwitch: DAY_MS,
  databaseEffectsSwitch: DAY_MS,
  workspaceEffectsSwitch: DAY_MS,
  railEffectsSwitch: DAY_MS,
  export: 365 * DAY_MS,
  deletion: 365 * DAY_MS,
  exit: 365 * DAY_MS,
  adapterContract: 30 * DAY_MS,
  testProvider: DAY_MS,
  internalSeed: DAY_MS,
});

interface ExpectedEvidenceBinding {
  readonly gate: ProviderActivationGate;
  readonly rail: ProviderActivationRail;
  readonly providerId: string;
  readonly adapterContractVersion: string;
  readonly workspaceId: string;
  readonly providerConnectionId: string;
  readonly assessedScopeSha256: string;
}

function stringArray(
  value: unknown,
  path: string,
  minimum: number,
  maximum: number,
  item: (candidate: unknown, itemPath: string) => string,
): readonly string[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    return invalid('INPUT_VALUE_INVALID', path, `${path} has an unsupported number of items.`);
  }
  const parsed = value.map((candidate, index) => item(candidate, `${path}[${index}]`));
  if (new Set(parsed).size !== parsed.length) {
    return invalid('INPUT_VALUE_INVALID', path, `${path} must not contain duplicates.`);
  }
  return Object.freeze(parsed);
}

function territory(value: unknown, path: string): string {
  if (typeof value !== 'string' || !ISO_TERRITORY.test(value)) {
    return invalid('INPUT_VALUE_INVALID', path, `${path} must be an ISO alpha-2 territory code.`);
  }
  return value;
}

function parseGateEvidence(
  value: unknown,
  path: string,
  evaluatedAtMs: number,
  expected: ExpectedEvidenceBinding,
): ProviderGateEvidence {
  const record = exactRecord(value, path, [
    'gate', 'rail', 'providerId', 'adapterContractVersion', 'workspaceId',
    'providerConnectionId', 'assessedScopeVersion', 'assessedScopeSha256',
    'status', 'evidenceId', 'evidenceSha256', 'verifiedAt', 'expiresAt',
  ]);
  const binding = {
    gate: oneOf(record.gate, PROVIDER_ACTIVATION_GATES, `${path}.gate`),
    rail: oneOf(record.rail, PROVIDER_ACTIVATION_RAILS, `${path}.rail`),
    providerId: typeof record.providerId === 'string' && PROVIDER_ID.test(record.providerId)
      ? record.providerId
      : invalid('INPUT_VALUE_INVALID', `${path}.providerId`, `${path}.providerId is invalid.`),
    adapterContractVersion: typeof record.adapterContractVersion === 'string'
        && SEMVER.test(record.adapterContractVersion)
      ? record.adapterContractVersion
      : invalid(
        'INPUT_VALUE_INVALID', `${path}.adapterContractVersion`,
        `${path}.adapterContractVersion is invalid.`,
      ),
    workspaceId: canonicalUuid(record.workspaceId, `${path}.workspaceId`),
    providerConnectionId: canonicalUuid(record.providerConnectionId, `${path}.providerConnectionId`),
    assessedScopeVersion: record.assessedScopeVersion,
    assessedScopeSha256: sha256(record.assessedScopeSha256, `${path}.assessedScopeSha256`),
  };
  if (binding.assessedScopeVersion !== 1
      || binding.gate !== expected.gate
      || binding.rail !== expected.rail
      || binding.providerId !== expected.providerId
      || binding.adapterContractVersion !== expected.adapterContractVersion
      || binding.workspaceId !== expected.workspaceId
      || binding.providerConnectionId !== expected.providerConnectionId
      || binding.assessedScopeSha256 !== expected.assessedScopeSha256) {
    return invalid('INPUT_VALUE_INVALID', path, `${path} is not bound to the assessed provider scope.`);
  }
  const status = oneOf(record.status, ['verified', 'not_applicable', 'missing', 'failed'] as const, `${path}.status`);

  if (status === 'missing' || status === 'failed') {
    if (record.evidenceId !== null || record.evidenceSha256 !== null
        || record.verifiedAt !== null || record.expiresAt !== null) {
      return invalid(
        'INPUT_VALUE_INVALID',
        path,
        `${path} must not claim evidence metadata for a missing or failed gate.`,
      );
    }
    return Object.freeze({
      ...binding,
      assessedScopeVersion: 1 as const,
      status,
      evidenceId: null,
      evidenceSha256: null,
      verifiedAt: null,
      expiresAt: null,
    });
  }

  const evidenceId = canonicalUuid(record.evidenceId, `${path}.evidenceId`);
  const evidenceSha256 = sha256(record.evidenceSha256, `${path}.evidenceSha256`);
  const verifiedAt = canonicalInstant(record.verifiedAt, `${path}.verifiedAt`);
  const expiresAt = canonicalInstant(record.expiresAt, `${path}.expiresAt`);
  const verifiedAtMs = Date.parse(verifiedAt);
  const expiresAtMs = Date.parse(expiresAt);
  if (verifiedAtMs > evaluatedAtMs) {
    return invalid('INPUT_VALUE_INVALID', `${path}.verifiedAt`, `${path} cannot be verified in the future.`);
  }
  if (expiresAtMs <= verifiedAtMs) {
    return invalid('INPUT_VALUE_INVALID', `${path}.expiresAt`, `${path} expiry must follow verification.`);
  }
  if (expiresAtMs - verifiedAtMs > PROVIDER_GATE_MAX_AGE_MS[expected.gate]) {
    return invalid(
      'INPUT_VALUE_INVALID', `${path}.expiresAt`,
      `${path} expiry exceeds the maximum age for ${expected.gate}.`,
    );
  }
  return Object.freeze({
    ...binding,
    assessedScopeVersion: 1 as const,
    status,
    evidenceId,
    evidenceSha256,
    verifiedAt,
    expiresAt,
  });
}

function parseProvider(value: unknown): ProviderReadinessManifestMetadata {
  const record = exactRecord(value, 'input.provider', [
    'providerId', 'kind', 'outboundCredentialAuth', 'inboundWebhookVerification',
    'capabilities', 'adapterContractVersion',
  ]);
  if (typeof record.providerId !== 'string' || !PROVIDER_ID.test(record.providerId)) {
    return invalid('INPUT_VALUE_INVALID', 'input.provider.providerId', 'Provider id must be a bounded lowercase slug.');
  }
  if (typeof record.adapterContractVersion !== 'string' || !SEMVER.test(record.adapterContractVersion)) {
    return invalid(
      'INPUT_VALUE_INVALID',
      'input.provider.adapterContractVersion',
      'Adapter contract version must be a bounded semantic version.',
    );
  }
  if (typeof record.kind !== 'string' || !PROVIDER_KINDS.has(record.kind as ProviderKind)) {
    return invalid('INPUT_VALUE_INVALID', 'input.provider.kind', 'Provider kind is unsupported.');
  }
  if (typeof record.outboundCredentialAuth !== 'string'
      || !CREDENTIAL_MODES.has(record.outboundCredentialAuth as ProviderCredentialAuthMode)) {
    return invalid('INPUT_VALUE_INVALID', 'input.provider.outboundCredentialAuth', 'Provider auth mode is unsupported.');
  }
  if (typeof record.inboundWebhookVerification !== 'string'
      || !WEBHOOK_MODES.has(record.inboundWebhookVerification as ProviderWebhookVerificationMode)) {
    return invalid(
      'INPUT_VALUE_INVALID',
      'input.provider.inboundWebhookVerification',
      'Webhook verification mode is unsupported.',
    );
  }
  const capabilities = stringArray(
    record.capabilities,
    'input.provider.capabilities',
    1,
    32,
    (candidate, path) => {
      if (typeof candidate !== 'string' || !isPlatformCapability(candidate)) {
        return invalid('INPUT_VALUE_INVALID', path, `${path} is not a platform capability.`);
      }
      return candidate;
    },
  ) as readonly PlatformCapability[];
  return Object.freeze({
    providerId: record.providerId,
    kind: record.kind as ProviderKind,
    outboundCredentialAuth: record.outboundCredentialAuth as ProviderCredentialAuthMode,
    inboundWebhookVerification: record.inboundWebhookVerification as ProviderWebhookVerificationMode,
    capabilities,
    adapterContractVersion: record.adapterContractVersion,
  });
}

function parseWorkspace(value: unknown): ProviderReadinessWorkspaceScope {
  const record = exactRecord(value, 'input.workspace', ['workspaceId', 'providerConnectionId']);
  return Object.freeze({
    workspaceId: canonicalUuid(record.workspaceId, 'input.workspace.workspaceId'),
    providerConnectionId: canonicalUuid(record.providerConnectionId, 'input.workspace.providerConnectionId'),
  });
}

function parseScope(value: unknown): ProviderReadinessScope {
  const scope = exactRecord(value, 'input.scope', [
    'commercialRights', 'privacy', 'account', 'isolation', 'secretManager', 'webhook',
    'policy', 'approval', 'caps', 'switches', 'lifecycle', 'testProvider', 'internalSeed',
  ]);

  const commercial = exactRecord(scope.commercialRights, 'input.scope.commercialRights', ['model', 'territories']);
  const commercialRights = Object.freeze({
    model: oneOf(commercial.model, [
      'internal_use_only', 'commercial_saas', 'white_label_resale', 'managed_service',
    ] as const, 'input.scope.commercialRights.model'),
    territories: stringArray(
      commercial.territories,
      'input.scope.commercialRights.territories',
      1,
      32,
      territory,
    ),
  });

  const privacyRecord = exactRecord(scope.privacy, 'input.scope.privacy', [
    'dpaRoleModel', 'dataRegions', 'transferMechanism',
  ]);
  const privacy = Object.freeze({
    dpaRoleModel: oneOf(privacyRecord.dpaRoleModel, [
      'controller_processor', 'independent_controllers', 'joint_controllers',
    ] as const, 'input.scope.privacy.dpaRoleModel'),
    dataRegions: stringArray(
      privacyRecord.dataRegions,
      'input.scope.privacy.dataRegions',
      1,
      8,
      (candidate, path) => oneOf(candidate, ['GB', 'EEA', 'US', 'OTHER'] as const, path),
    ) as readonly ('GB' | 'EEA' | 'US' | 'OTHER')[],
    transferMechanism: oneOf(privacyRecord.transferMechanism, [
      'not_required', 'uk_adequacy', 'uk_idta', 'uk_addendum', 'approved_other',
    ] as const, 'input.scope.privacy.transferMechanism'),
  });

  const accountRecord = exactRecord(scope.account, 'input.scope.account', [
    'ownership', 'providerAccountReferenceSha256',
  ]);
  const account = Object.freeze({
    ownership: oneOf(accountRecord.ownership, [
      'unknown', 'operator_owned', 'client_owned_managed',
    ] as const, 'input.scope.account.ownership'),
    providerAccountReferenceSha256: sha256(
      accountRecord.providerAccountReferenceSha256,
      'input.scope.account.providerAccountReferenceSha256',
    ),
  });

  const isolationRecord = exactRecord(scope.isolation, 'input.scope.isolation', [
    'workspaceId', 'providerConnectionId', 'compositeLookupEnforced',
    'rowLevelSecurityEnforced', 'crossWorkspaceTestPassed',
  ]);
  const isolation = Object.freeze({
    workspaceId: canonicalUuid(isolationRecord.workspaceId, 'input.scope.isolation.workspaceId'),
    providerConnectionId: canonicalUuid(
      isolationRecord.providerConnectionId,
      'input.scope.isolation.providerConnectionId',
    ),
    compositeLookupEnforced: booleanValue(
      isolationRecord.compositeLookupEnforced,
      'input.scope.isolation.compositeLookupEnforced',
    ),
    rowLevelSecurityEnforced: booleanValue(
      isolationRecord.rowLevelSecurityEnforced,
      'input.scope.isolation.rowLevelSecurityEnforced',
    ),
    crossWorkspaceTestPassed: booleanValue(
      isolationRecord.crossWorkspaceTestPassed,
      'input.scope.isolation.crossWorkspaceTestPassed',
    ),
  });

  const secretRecord = exactRecord(scope.secretManager, 'input.scope.secretManager', [
    'manager', 'referenceId', 'locatorSha256',
  ]);
  const secretManager = Object.freeze({
    manager: oneOf(secretRecord.manager, [
      'render_secret', 'aws_secrets_manager', 'gcp_secret_manager', 'azure_key_vault', 'vault',
    ] as const, 'input.scope.secretManager.manager'),
    referenceId: canonicalUuid(secretRecord.referenceId, 'input.scope.secretManager.referenceId'),
    locatorSha256: sha256(secretRecord.locatorSha256, 'input.scope.secretManager.locatorSha256'),
  });

  const webhookRecord = exactRecord(scope.webhook, 'input.scope.webhook', [
    'verificationMode', 'replayWindowSeconds', 'idempotencyNamespaceSha256',
    'reconciliationMode', 'maxReconciliationLagSeconds',
  ]);
  const verificationMode = oneOf(webhookRecord.verificationMode, [
    'hmac_signature', 'asymmetric_signature', 'verification_token', 'none',
  ] as const, 'input.scope.webhook.verificationMode');
  const webhook = Object.freeze({
    verificationMode,
    replayWindowSeconds: boundedInteger(
      webhookRecord.replayWindowSeconds,
      'input.scope.webhook.replayWindowSeconds',
      30,
      86_400,
    ),
    idempotencyNamespaceSha256: sha256(
      webhookRecord.idempotencyNamespaceSha256,
      'input.scope.webhook.idempotencyNamespaceSha256',
    ),
    reconciliationMode: oneOf(webhookRecord.reconciliationMode, [
      'signed_webhook_and_poll', 'signed_webhook_and_provider_query',
    ] as const, 'input.scope.webhook.reconciliationMode'),
    maxReconciliationLagSeconds: boundedInteger(
      webhookRecord.maxReconciliationLagSeconds,
      'input.scope.webhook.maxReconciliationLagSeconds',
      30,
      604_800,
    ),
  });

  const policyRecord = exactRecord(scope.policy, 'input.scope.policy', [
    'consentRoute', 'purpose', 'territories', 'senderReferenceSha256', 'suppressionScope',
  ]);
  const policy = Object.freeze({
    consentRoute: oneOf(policyRecord.consentRoute, [
      'solicited_request',
      'individual_consent',
      'individual_soft_opt_in',
      'corporate_subscriber_reg_23',
      'not_applicable_public_broadcast',
    ] as const, 'input.scope.policy.consentRoute'),
    purpose: oneOf(policyRecord.purpose, [
      'internal_seed_validation', 'product_marketing', 'customer_service', 'approved_content_publish',
    ] as const, 'input.scope.policy.purpose'),
    territories: stringArray(policyRecord.territories, 'input.scope.policy.territories', 1, 32, territory),
    senderReferenceSha256: sha256(
      policyRecord.senderReferenceSha256,
      'input.scope.policy.senderReferenceSha256',
    ),
    suppressionScope: oneOf(policyRecord.suppressionScope, [
      'recipient_workspace_provider', 'public_broadcast_not_applicable',
    ] as const, 'input.scope.policy.suppressionScope'),
  });

  const approvalRecord = exactRecord(scope.approval, 'input.scope.approval', [
    'approvalId', 'versionId', 'contentSha256',
  ]);
  const approval = Object.freeze({
    approvalId: canonicalUuid(approvalRecord.approvalId, 'input.scope.approval.approvalId'),
    versionId: canonicalUuid(approvalRecord.versionId, 'input.scope.approval.versionId'),
    contentSha256: sha256(approvalRecord.contentSha256, 'input.scope.approval.contentSha256'),
  });

  const capsRecord = exactRecord(scope.caps, 'input.scope.caps', [
    'currency',
    'maxSpendPerOperationMinorUnits',
    'maxSpendPerDayMinorUnits',
    'maxSpendPerMonthMinorUnits',
    'maxVolumePerOperation',
    'maxVolumePerDay',
    'maxVolumePerMonth',
  ]);
  const caps = Object.freeze({
    currency: oneOf(capsRecord.currency, ['GBP', 'USD', 'EUR'] as const, 'input.scope.caps.currency'),
    maxSpendPerOperationMinorUnits: boundedInteger(
      capsRecord.maxSpendPerOperationMinorUnits,
      'input.scope.caps.maxSpendPerOperationMinorUnits',
      0,
      1_000_000,
    ),
    maxSpendPerDayMinorUnits: boundedInteger(
      capsRecord.maxSpendPerDayMinorUnits,
      'input.scope.caps.maxSpendPerDayMinorUnits',
      0,
      10_000_000,
    ),
    maxSpendPerMonthMinorUnits: boundedInteger(
      capsRecord.maxSpendPerMonthMinorUnits,
      'input.scope.caps.maxSpendPerMonthMinorUnits',
      0,
      100_000_000,
    ),
    maxVolumePerOperation: boundedInteger(
      capsRecord.maxVolumePerOperation,
      'input.scope.caps.maxVolumePerOperation',
      1,
      10_000,
    ),
    maxVolumePerDay: boundedInteger(
      capsRecord.maxVolumePerDay,
      'input.scope.caps.maxVolumePerDay',
      1,
      1_000_000,
    ),
    maxVolumePerMonth: boundedInteger(
      capsRecord.maxVolumePerMonth,
      'input.scope.caps.maxVolumePerMonth',
      1,
      10_000_000,
    ),
  });
  if (caps.maxSpendPerOperationMinorUnits > caps.maxSpendPerDayMinorUnits
      || caps.maxSpendPerDayMinorUnits > caps.maxSpendPerMonthMinorUnits
      || caps.maxVolumePerOperation > caps.maxVolumePerDay
      || caps.maxVolumePerDay > caps.maxVolumePerMonth) {
    return invalid('INPUT_VALUE_INVALID', 'input.scope.caps', 'Spend and volume caps must be monotonically bounded.');
  }

  const switchesRecord = exactRecord(scope.switches, 'input.scope.switches', [
    'emergencyPaused', 'runtimeEffects', 'databaseEffects', 'workspaceEffects', 'railEffects',
  ]);
  const switches = Object.freeze({
    emergencyPaused: booleanValue(switchesRecord.emergencyPaused, 'input.scope.switches.emergencyPaused'),
    runtimeEffects: oneOf(switchesRecord.runtimeEffects, ['off', 'on'] as const, 'input.scope.switches.runtimeEffects'),
    databaseEffects: oneOf(switchesRecord.databaseEffects, ['off', 'on'] as const, 'input.scope.switches.databaseEffects'),
    workspaceEffects: oneOf(switchesRecord.workspaceEffects, ['off', 'on'] as const, 'input.scope.switches.workspaceEffects'),
    railEffects: oneOf(switchesRecord.railEffects, ['off', 'on'] as const, 'input.scope.switches.railEffects'),
  });

  const lifecycleRecord = exactRecord(scope.lifecycle, 'input.scope.lifecycle', [
    'exportPlanSha256', 'deletionPlanSha256', 'exitPlanSha256',
  ]);
  const lifecycle = Object.freeze({
    exportPlanSha256: sha256(lifecycleRecord.exportPlanSha256, 'input.scope.lifecycle.exportPlanSha256'),
    deletionPlanSha256: sha256(lifecycleRecord.deletionPlanSha256, 'input.scope.lifecycle.deletionPlanSha256'),
    exitPlanSha256: sha256(lifecycleRecord.exitPlanSha256, 'input.scope.lifecycle.exitPlanSha256'),
  });

  const testProviderRecord = exactRecord(scope.testProvider, 'input.scope.testProvider', [
    'mode', 'fixturePackSha256', 'testRunId',
  ]);
  const testProvider = Object.freeze({
    mode: oneOf(testProviderRecord.mode, ['simulated', 'provider_sandbox'] as const, 'input.scope.testProvider.mode'),
    fixturePackSha256: sha256(
      testProviderRecord.fixturePackSha256,
      'input.scope.testProvider.fixturePackSha256',
    ),
    testRunId: canonicalUuid(testProviderRecord.testRunId, 'input.scope.testProvider.testRunId'),
  });

  const seedRecord = exactRecord(scope.internalSeed, 'input.scope.internalSeed', [
    'destinationScope', 'ownershipVerified', 'maxDestinations', 'destinationReferenceHashes',
  ]);
  const internalSeed = Object.freeze({
    destinationScope: oneOf(
      seedRecord.destinationScope,
      ['owned_internal_destinations_only'] as const,
      'input.scope.internalSeed.destinationScope',
    ),
    ownershipVerified: booleanValue(
      seedRecord.ownershipVerified,
      'input.scope.internalSeed.ownershipVerified',
    ),
    maxDestinations: boundedInteger(
      seedRecord.maxDestinations,
      'input.scope.internalSeed.maxDestinations',
      1,
      10,
    ),
    destinationReferenceHashes: stringArray(
      seedRecord.destinationReferenceHashes,
      'input.scope.internalSeed.destinationReferenceHashes',
      0,
      10,
      sha256,
    ),
  });
  if (internalSeed.destinationReferenceHashes.length > internalSeed.maxDestinations) {
    return invalid(
      'INPUT_VALUE_INVALID',
      'input.scope.internalSeed.destinationReferenceHashes',
      'Internal destination references exceed the declared hard cap.',
    );
  }

  return Object.freeze({
    commercialRights,
    privacy,
    account,
    isolation,
    secretManager,
    webhook,
    policy,
    approval,
    caps,
    switches,
    lifecycle,
    testProvider,
    internalSeed,
  });
}

function parseInput(input: unknown, evaluatedAtMs: number): ProviderActivationReadinessInput {
  scanForCredentialFields(
    input,
    'input',
    new WeakSet(),
    { nodes: 0, keys: 0, bytes: 0 },
  );
  const record = exactRecord(input, 'input', [
    'schemaVersion', 'rail', 'provider', 'workspace', 'scope', 'evidence',
  ]);
  if (record.schemaVersion !== 1) {
    return invalid('INPUT_VALUE_INVALID', 'input.schemaVersion', 'Only readiness schema version 1 is supported.');
  }
  const rail = oneOf(record.rail, PROVIDER_ACTIVATION_RAILS, 'input.rail');
  const provider = parseProvider(record.provider);
  const workspace = parseWorkspace(record.workspace);
  const scope = parseScope(record.scope);
  const assessedScopeSha256 = providerActivationAssessedScopeSha256({
    schemaVersion: 1,
    rail,
    provider,
    workspace,
    scope,
  });
  const evidenceRecord = exactRecord(record.evidence, 'input.evidence', PROVIDER_ACTIVATION_GATES);
  const parsedEvidence = {} as Record<ProviderActivationGate, ProviderGateEvidence>;
  const evidenceIds = new Set<string>();
  const evidenceDigests = new Set<string>();
  for (const gate of PROVIDER_ACTIVATION_GATES) {
    const parsed = parseGateEvidence(
      evidenceRecord[gate],
      `input.evidence.${gate}`,
      evaluatedAtMs,
      {
        gate,
        rail,
        providerId: provider.providerId,
        adapterContractVersion: provider.adapterContractVersion,
        workspaceId: workspace.workspaceId,
        providerConnectionId: workspace.providerConnectionId,
        assessedScopeSha256,
      },
    );
    if (parsed.evidenceId !== null) {
      if (evidenceIds.has(parsed.evidenceId) || evidenceDigests.has(parsed.evidenceSha256!)) {
        return invalid(
          'INPUT_VALUE_INVALID',
          `input.evidence.${gate}`,
          'Evidence records cannot be replayed across provider activation gates.',
        );
      }
      evidenceIds.add(parsed.evidenceId);
      evidenceDigests.add(parsed.evidenceSha256!);
    }
    parsedEvidence[gate] = parsed;
  }
  return Object.freeze({
    schemaVersion: 1,
    rail,
    provider,
    workspace,
    scope,
    evidence: Object.freeze(parsedEvidence),
  });
}

function reason(
  code: ProviderReadinessReasonCode,
  gate: ProviderActivationGate | null,
  message: string,
): ProviderReadinessReason {
  return Object.freeze({ code, gate, message });
}

function evidenceReason(
  gate: ProviderActivationGate,
  evidence: ProviderGateEvidence,
  rail: ProviderActivationRail,
  evaluatedAtMs: number,
): ProviderReadinessReason | null {
  if (evidence.status === 'missing') {
    return reason('EVIDENCE_MISSING', gate, `Evidence for ${gate} is missing.`);
  }
  if (evidence.status === 'failed') {
    return reason('EVIDENCE_FAILED', gate, `Evidence for ${gate} records a failed control.`);
  }
  if (evidence.status === 'not_applicable') {
    const permitted = rail === 'public_social' && (gate === 'consent' || gate === 'suppression');
    if (!permitted) {
      return reason('NOT_APPLICABLE_INVALID', gate, `${gate} cannot be marked not applicable for this rail.`);
    }
  }
  if (Date.parse(evidence.expiresAt!) <= evaluatedAtMs
      || evaluatedAtMs - Date.parse(evidence.verifiedAt!) > PROVIDER_GATE_MAX_AGE_MS[gate]) {
    return reason('EVIDENCE_STALE', gate, `Evidence for ${gate} is stale.`);
  }
  return null;
}

function uniqueReasons(reasons: readonly ProviderReadinessReason[]): readonly ProviderReadinessReason[] {
  const seen = new Set<string>();
  const result: ProviderReadinessReason[] = [];
  for (const item of reasons) {
    const key = `${item.code}:${item.gate ?? 'none'}:${item.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return Object.freeze(result);
}

function providerMetadataBlockers(
  input: ProviderActivationReadinessInput,
  authority: ProviderActivationAuthority,
): readonly ProviderReadinessReason[] {
  const { rail, provider } = input;
  const authorityTrusted = typeof authority === 'object'
    && authority !== null
    && AUTHORITY_MANIFESTS.has(authority);
  const authoritative = authorityTrusted ? AUTHORITY_MANIFESTS.get(authority)?.get(
    authorityKey(rail, provider.providerId),
  ) : undefined;
  const signed = provider.inboundWebhookVerification === 'hmac_signature'
    || provider.inboundWebhookVerification === 'asymmetric_signature';
  const candidateCapabilities = [...provider.capabilities].sort();
  const authoritativeCapabilities = authoritative
    ? [...authoritative.provider.capabilities].sort()
    : [];
  const requiredCapabilities = REQUIRED_CAPABILITIES_BY_RAIL[rail];
  let matches = authorityTrusted
    && authority.authorityVersion === 1
    && authoritative !== undefined
    && signed
    && provider.outboundCredentialAuth !== 'none'
    && provider.kind === authoritative.provider.kind
    && provider.outboundCredentialAuth === authoritative.provider.outboundCredentialAuth
    && provider.inboundWebhookVerification === authoritative.provider.inboundWebhookVerification
    && provider.adapterContractVersion === authoritative.adapterContractVersion
    && candidateCapabilities.length === authoritativeCapabilities.length
    && candidateCapabilities.every((capability, index) => capability === authoritativeCapabilities[index])
    && requiredCapabilities.every((capability) => candidateCapabilities.includes(capability));
  if (rail === 'mailgun_email') {
    matches = matches
      && provider.providerId === 'mailgun_eu'
      && provider.kind === 'email'
      && provider.outboundCredentialAuth === 'api_key'
      && provider.inboundWebhookVerification === 'hmac_signature';
  } else if (rail === 'whatsapp') {
    matches = matches
      && provider.kind === 'messaging'
      && (provider.outboundCredentialAuth === 'oauth2' || provider.outboundCredentialAuth === 'api_key');
  } else if (rail === 'public_social') {
    matches = matches
      && provider.kind === 'social'
      && provider.outboundCredentialAuth !== 'none';
  } else if (rail === 'social_dm') {
    matches = matches
      && (provider.kind === 'social' || provider.kind === 'messaging')
      && (provider.outboundCredentialAuth === 'oauth2' || provider.outboundCredentialAuth === 'api_key');
  }
  if (provider.inboundWebhookVerification !== input.scope.webhook.verificationMode) matches = false;
  return matches
    ? Object.freeze([])
    : Object.freeze([reason(
      'PROVIDER_METADATA_MISMATCH',
      'adapterContract',
      'Provider kind, outbound auth or signed-webhook metadata does not match the selected rail.',
    )]);
}

function adapterScopeBlockers(
  input: ProviderActivationReadinessInput,
  authority: ProviderActivationAuthority,
): readonly ProviderReadinessReason[] {
  const blockers: ProviderReadinessReason[] = [...providerMetadataBlockers(input, authority)];
  const { scope, workspace } = input;
  if (scope.commercialRights.model === 'internal_use_only') {
    blockers.push(reason(
      'COMMERCIAL_RIGHTS_INSUFFICIENT',
      'commercialSaasRights',
      'Commercial SaaS, managed-service or white-label rights are not evidenced.',
    ));
  }
  const nonGbRegion = scope.privacy.dataRegions.some((region) => region !== 'GB');
  if (nonGbRegion && scope.privacy.transferMechanism === 'not_required') {
    blockers.push(reason(
      'DATA_TRANSFER_UNRESOLVED',
      'dataRegion',
      'A non-GB processing region needs an approved transfer-mechanism decision.',
    ));
  }
  if (scope.account.ownership === 'unknown') {
    blockers.push(reason(
      'ACCOUNT_OWNERSHIP_UNVERIFIED',
      'accountOwnership',
      'The provider account owner has not been verified.',
    ));
  }
  if (scope.isolation.workspaceId !== workspace.workspaceId
      || scope.isolation.providerConnectionId !== workspace.providerConnectionId) {
    blockers.push(reason(
      'WORKSPACE_SCOPE_MISMATCH',
      'workspaceIsolation',
      'Workspace-isolation evidence does not match the assessed workspace-owned connection.',
    ));
  }
  if (!scope.isolation.compositeLookupEnforced
      || !scope.isolation.rowLevelSecurityEnforced
      || !scope.isolation.crossWorkspaceTestPassed) {
    blockers.push(reason(
      'WORKSPACE_ISOLATION_UNVERIFIED',
      'workspaceIsolation',
      'Composite ownership lookup, RLS and cross-workspace denial must all be evidenced.',
    ));
  }
  const signedWebhook = scope.webhook.verificationMode === 'hmac_signature'
    || scope.webhook.verificationMode === 'asymmetric_signature';
  if (!signedWebhook) {
    blockers.push(reason(
      'WEBHOOK_CONTRACT_UNSAFE',
      'signedWebhook',
      'The inbound callback contract is not cryptographically signed.',
    ));
  }
  if (!scope.switches.emergencyPaused
      || scope.switches.runtimeEffects !== 'off'
      || scope.switches.databaseEffects !== 'off'
      || scope.switches.workspaceEffects !== 'off'
      || scope.switches.railEffects !== 'off') {
    blockers.push(reason(
      'DARK_SWITCH_INVARIANT_FAILED',
      'emergencyPause',
      'Readiness assessment requires emergency pause engaged and every effects layer off.',
    ));
  }
  return uniqueReasons(blockers);
}

function internalSeedScopeBlockers(input: ProviderActivationReadinessInput): readonly ProviderReadinessReason[] {
  const blockers: ProviderReadinessReason[] = [];
  const { scope, rail } = input;
  const isPublic = rail === 'public_social';
  const consentEvidence = input.evidence.consent;
  const suppressionEvidence = input.evidence.suppression;
  if (isPublic) {
    if (scope.policy.consentRoute !== 'not_applicable_public_broadcast'
        || scope.policy.suppressionScope !== 'public_broadcast_not_applicable'
        || consentEvidence.status !== 'not_applicable'
        || suppressionEvidence.status !== 'not_applicable') {
      blockers.push(reason(
        'CHANNEL_POLICY_SCOPE_INVALID',
        'consent',
        'Public social must use an evidenced non-targeted public-broadcast route.',
      ));
    }
  } else if (scope.policy.consentRoute === 'not_applicable_public_broadcast'
      || scope.policy.suppressionScope !== 'recipient_workspace_provider'
      || consentEvidence.status === 'not_applicable'
      || suppressionEvidence.status === 'not_applicable') {
    blockers.push(reason(
      'CHANNEL_POLICY_SCOPE_INVALID',
      'consent',
      'Direct-message rails require a selected recipient route and recipient/workspace/provider suppression.',
    ));
  }
  const rights = new Set(scope.commercialRights.territories);
  if (scope.policy.territories.some((item) => !rights.has(item))) {
    blockers.push(reason(
      'TERRITORY_OUTSIDE_COMMERCIAL_RIGHTS',
      'territory',
      'The intended channel territory is outside the evidenced commercial rights.',
    ));
  }
  if (!scope.internalSeed.ownershipVerified
      || scope.internalSeed.destinationReferenceHashes.length === 0
      || scope.caps.maxVolumePerOperation > scope.internalSeed.maxDestinations) {
    blockers.push(reason(
      'INTERNAL_SEED_SCOPE_INVALID',
      'internalSeed',
      'Internal seed scope requires owned hashed destinations and an operation cap no larger than the seed cap.',
    ));
  }
  return uniqueReasons(blockers);
}

function stageBlockers(
  input: ProviderActivationReadinessInput,
  stage: ProviderActivationReadinessStage,
  evaluatedAtMs: number,
  authority: ProviderActivationAuthority,
): readonly ProviderReadinessReason[] {
  const gates = stage === 'adapter_contract_verified'
    ? ADAPTER_STAGE_GATES
    : stage === 'provider_test_verified'
      ? PROVIDER_TEST_STAGE_GATES
      : INTERNAL_SEED_STAGE_GATES;
  const blockers: ProviderReadinessReason[] = [];
  for (const gate of gates) {
    const blocked = evidenceReason(gate, input.evidence[gate], input.rail, evaluatedAtMs);
    if (blocked) blockers.push(blocked);
  }
  blockers.push(...adapterScopeBlockers(input, authority));
  if (stage !== 'adapter_contract_verified' && input.scope.testProvider.mode !== 'provider_sandbox') {
    blockers.push(reason(
      'PROVIDER_TEST_SCOPE_INVALID',
      'testProvider',
      'Provider-test and internal-seed readiness require a provider-issued sandbox/test scope.',
    ));
  }
  if (stage === 'internal_seed_ready') blockers.push(...internalSeedScopeBlockers(input));
  return uniqueReasons(blockers);
}

const DARK_SAFETY = Object.freeze({
  liveAuthorised: false as const,
  providerEffectsAllowed: false as const,
  providerOperationsCreated: 0 as const,
  separateActivationRequired: true as const,
});

function invalidReport(
  evaluatedAt: string,
  issue: ProviderReadinessValidationIssue,
): ProviderActivationReadinessReport {
  const blocker = reason('INPUT_INVALID', null, 'Readiness input is malformed and was denied.');
  const blockers = Object.freeze([blocker]);
  const stages = Object.freeze(PROVIDER_ACTIVATION_READINESS_STAGES.map((stage) => Object.freeze({
    stage,
    ready: false,
    blockers,
  })));
  return Object.freeze({
    schemaVersion: 1,
    inputAccepted: false,
    rail: null,
    providerId: null,
    workspaceId: null,
    evaluatedAt,
    readiness: 'not_ready',
    ceiling: PROVIDER_ACTIVATION_READINESS_CEILING,
    nextStage: 'adapter_contract_verified',
    blockingReasons: blockers,
    validationIssues: Object.freeze([Object.freeze({ ...issue })]),
    stages,
    safety: DARK_SAFETY,
  });
}

/**
 * Assess readiness metadata using a trusted server clock.
 *
 * Every result is detached and deeply immutable. Malformed input returns an
 * immutable denial rather than throwing through an activation caller.
 */
export function evaluateProviderActivationReadiness(
  candidate: unknown,
  clock: Date = new Date(),
  authority: ProviderActivationAuthority = DEFAULT_PROVIDER_ACTIVATION_AUTHORITY,
): ProviderActivationReadinessReport {
  const evaluatedAtMs = clock instanceof Date ? clock.getTime() : Number.NaN;
  const evaluatedAt = Number.isFinite(evaluatedAtMs)
    ? new Date(evaluatedAtMs).toISOString()
    : new Date(0).toISOString();
  if (!Number.isFinite(evaluatedAtMs)) {
    return invalidReport(evaluatedAt, Object.freeze({
      code: 'INPUT_VALUE_INVALID',
      path: 'clock',
      message: 'Readiness evaluation requires a valid trusted server clock.',
    }));
  }

  let input: ProviderActivationReadinessInput;
  try {
    input = parseInput(candidate, evaluatedAtMs);
  } catch (error) {
    if (error instanceof ReadinessValidationError) return invalidReport(evaluatedAt, error.issue);
    return invalidReport(evaluatedAt, Object.freeze({
      code: 'INPUT_NOT_PLAIN_DATA',
      path: 'input',
      message: 'Readiness input could not be treated as bounded plain data.',
    }));
  }

  const stages = Object.freeze(PROVIDER_ACTIVATION_READINESS_STAGES.map((stage) => {
    const blockers = stageBlockers(input, stage, evaluatedAtMs, authority);
    return Object.freeze({ stage, ready: blockers.length === 0, blockers });
  }));
  const adapterReady = stages[0]!.ready;
  const providerReady = stages[1]!.ready;
  const seedReady = stages[2]!.ready;
  const readiness: ProviderActivationReadiness = seedReady
    ? 'internal_seed_ready'
    : providerReady
      ? 'provider_test_verified'
      : adapterReady
        ? 'adapter_contract_verified'
        : 'not_ready';
  const nextStage = seedReady
    ? null
    : providerReady
      ? 'internal_seed_ready' as const
      : adapterReady
        ? 'provider_test_verified' as const
        : 'adapter_contract_verified' as const;
  const nextStageResult = nextStage === null
    ? null
    : stages.find((stage) => stage.stage === nextStage)!;

  return Object.freeze({
    schemaVersion: 1,
    inputAccepted: true,
    rail: input.rail,
    providerId: input.provider.providerId,
    workspaceId: input.workspace.workspaceId,
    evaluatedAt,
    readiness,
    ceiling: PROVIDER_ACTIVATION_READINESS_CEILING,
    nextStage,
    blockingReasons: nextStageResult?.blockers ?? Object.freeze([]),
    validationIssues: Object.freeze([]),
    stages,
    safety: DARK_SAFETY,
  });
}
