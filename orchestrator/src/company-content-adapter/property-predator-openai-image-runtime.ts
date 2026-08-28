import {
  createPropertyPredatorOpenAiImageTransport,
  PROPERTY_PREDATOR_OPENAI_IMAGE_CREDENTIAL_BOUNDARY,
  type PropertyPredatorImageCostEvidenceProvider,
  type PropertyPredatorImageInspector,
  type PropertyPredatorEditImageCommand,
  type PropertyPredatorGenerateImageCommand,
  type PropertyPredatorImagePolicy,
  type PropertyPredatorOpenAiImageTransport,
  type PropertyPredatorOwnedReferenceRegistry,
} from './property-predator-openai-image.js';

export const PROPERTY_PREDATOR_OPENAI_IMAGE_SERVICE =
  'property-predator-openai-image' as const;
export const PROPERTY_PREDATOR_OPENAI_IMAGE_MODEL = 'gpt-image-2' as const;
export const PROPERTY_PREDATOR_OPENAI_IMAGE_BASE_URL =
  'https://api.openai.com' as const;

export type PropertyPredatorOpenAiImageRuntimeMode =
  | 'dark-production'
  | 'review-proposal-live';

export interface PropertyPredatorOpenAiImageRuntimeReadiness {
  readonly schemaVersion: 1;
  readonly event: 'ready';
  readonly service: typeof PROPERTY_PREDATOR_OPENAI_IMAGE_SERVICE;
  readonly mode: PropertyPredatorOpenAiImageRuntimeMode;
  readonly model: typeof PROPERTY_PREDATOR_OPENAI_IMAGE_MODEL;
  readonly provider: Readonly<{
    endpoint: typeof PROPERTY_PREDATOR_OPENAI_IMAGE_BASE_URL;
    credentialBoundary: typeof PROPERTY_PREDATOR_OPENAI_IMAGE_CREDENTIAL_BOUNDARY;
    dedicatedCredentialConfigured: boolean;
  }>;
  readonly composition: Readonly<{
    policy: boolean;
    costEvidence: boolean;
    inspector: boolean;
    ownedReferenceRegistry: boolean;
    commandBoundary: boolean;
    providerAdapterInstantiated: boolean;
  }>;
  readonly safety: Readonly<{
    providerEffectsEnabled: boolean;
    imageEffectsEnabled: boolean;
    generationEnabled: boolean;
    emergencyPaused: boolean;
    providerNetworkCallsMadeAtReadiness: false;
    publishCapability: false;
    customerAttachmentCapability: false;
  }>;
  readonly activationReady: boolean;
  readonly blockers: readonly PropertyPredatorOpenAiImageRuntimeBlocker[];
}

export type PropertyPredatorOpenAiImageRuntimeBlocker =
  | 'PROVIDER_EFFECTS_DISABLED'
  | 'IMAGE_EFFECTS_DISABLED'
  | 'IMAGE_GENERATION_DISABLED'
  | 'IMAGE_EMERGENCY_PAUSED'
  | 'IMAGE_COMMAND_BOUNDARY_DISABLED'
  | 'IMAGE_CREDENTIAL_MISSING'
  | 'IMAGE_POLICY_NOT_COMPOSED'
  | 'IMAGE_COST_EVIDENCE_NOT_COMPOSED'
  | 'IMAGE_INSPECTOR_NOT_COMPOSED';

export interface PropertyPredatorOpenAiImageRuntimeDependencies {
  readonly env?: NodeJS.ProcessEnv;
  readonly policy?: PropertyPredatorImagePolicy;
  readonly costEvidence?: PropertyPredatorImageCostEvidenceProvider;
  readonly inspector?: PropertyPredatorImageInspector;
  readonly ownedReferenceRegistry?: PropertyPredatorOwnedReferenceRegistry;
  readonly commandBoundary?: PropertyPredatorOpenAiImageCommandBoundary;
  readonly fetchImpl?: typeof fetch;
}

export interface PropertyPredatorOpenAiImageCommandBoundary {
  /** Authorize the exact proposal command before the provider transport can run. */
  authorizeExact(
    operation: 'generate',
    command: PropertyPredatorGenerateImageCommand,
  ): Promise<void>;
  authorizeExact(
    operation: 'edit',
    command: PropertyPredatorEditImageCommand,
  ): Promise<void>;
}

export interface PropertyPredatorOpenAiImageRuntime {
  readonly readiness: PropertyPredatorOpenAiImageRuntimeReadiness;
  /** Null in dark mode; no caller can manufacture a provider operation. */
  readonly transport: PropertyPredatorOpenAiImageTransport | null;
}

const SHA256 = /^[0-9a-f]{64}$/u;
const IMAGE_KEY_MIN_BYTES = 32;
const IMAGE_KEY_MAX_BYTES = 512;
const FORBIDDEN_IMAGE_PROCESS_SECRETS = Object.freeze([
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'MAILGUN_API_KEY',
  'MAILGUN_DOMAIN_SENDING_KEY',
  'MAILGUN_SIGNING_KEY',
  'SESSION_SECRET',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
]);

function exactSwitch(
  env: NodeJS.ProcessEnv,
  setting: string,
  expected: 'true' | 'false',
): void {
  if (env[setting]?.trim() !== expected) {
    throw new Error(`${setting} must be exactly ${expected}`);
  }
}

function exactSha(env: NodeJS.ProcessEnv, setting: string): string {
  const value = env[setting]?.trim() ?? '';
  if (!SHA256.test(value)) throw new Error(`${setting} must be a lowercase SHA-256 digest`);
  return value;
}

function imageCredentialConfigured(env: NodeJS.ProcessEnv): boolean {
  const value = env.OPENAI_IMAGE_API_KEY ?? '';
  const byteLength = Buffer.byteLength(value, 'utf8');
  return byteLength >= IMAGE_KEY_MIN_BYTES
    && byteLength <= IMAGE_KEY_MAX_BYTES
    && /^[\x21-\x7e]+$/u.test(value);
}

function assertIsolatedImageProcess(env: NodeJS.ProcessEnv): void {
  if (FORBIDDEN_IMAGE_PROCESS_SECRETS.some((name) => Boolean(env[name]?.trim()))) {
    throw new Error('OpenAI image runtime received a secret owned by another process');
  }
  const databaseUrls = Object.keys(env).filter((name) => Boolean(env[name]?.trim())
    && (name === 'DATABASE_URL' || name === 'TEST_DATABASE_URL'
      || /^DATABASE_[A-Z0-9_]+_URL$/u.test(name)));
  if (databaseUrls.some((name) => name !== 'DATABASE_OPENAI_IMAGE_WORKER_URL')) {
    throw new Error('OpenAI image runtime received a database identity outside its isolated role');
  }
}

function mode(env: NodeJS.ProcessEnv): PropertyPredatorOpenAiImageRuntimeMode {
  const value = env.PROPERTY_PREDATOR_IMAGE_RUNTIME_MODE?.trim();
  if (value === 'dark-production' || value === 'review-proposal-live') return value;
  throw new Error('PROPERTY_PREDATOR_IMAGE_RUNTIME_MODE is invalid');
}

function blockers(
  env: NodeJS.ProcessEnv,
  dependencies: PropertyPredatorOpenAiImageRuntimeDependencies,
): readonly PropertyPredatorOpenAiImageRuntimeBlocker[] {
  const values: PropertyPredatorOpenAiImageRuntimeBlocker[] = [];
  if (env.PROPERTY_PREDATOR_PROVIDER_EFFECTS_ENABLED !== 'true') {
    values.push('PROVIDER_EFFECTS_DISABLED');
  }
  if (env.PROPERTY_PREDATOR_IMAGE_PROVIDER_EFFECTS_ENABLED !== 'true') {
    values.push('IMAGE_EFFECTS_DISABLED');
  }
  if (env.PROPERTY_PREDATOR_IMAGE_GENERATION_ENABLED !== 'true') {
    values.push('IMAGE_GENERATION_DISABLED');
  }
  if (env.PROPERTY_PREDATOR_IMAGE_EMERGENCY_PAUSED !== 'false') {
    values.push('IMAGE_EMERGENCY_PAUSED');
  }
  if (env.PROPERTY_PREDATOR_IMAGE_COMMAND_BOUNDARY_ENABLED !== 'true'
      || !dependencies.commandBoundary) {
    values.push('IMAGE_COMMAND_BOUNDARY_DISABLED');
  }
  if (!imageCredentialConfigured(env)) values.push('IMAGE_CREDENTIAL_MISSING');
  if (!dependencies.policy) values.push('IMAGE_POLICY_NOT_COMPOSED');
  if (!dependencies.costEvidence) values.push('IMAGE_COST_EVIDENCE_NOT_COMPOSED');
  if (!dependencies.inspector) values.push('IMAGE_INSPECTOR_NOT_COMPOSED');
  return Object.freeze(values);
}

function readiness(
  runtimeMode: PropertyPredatorOpenAiImageRuntimeMode,
  env: NodeJS.ProcessEnv,
  dependencies: PropertyPredatorOpenAiImageRuntimeDependencies,
  activationBlockers: readonly PropertyPredatorOpenAiImageRuntimeBlocker[],
  adapterInstantiated: boolean,
): PropertyPredatorOpenAiImageRuntimeReadiness {
  const live = runtimeMode === 'review-proposal-live';
  return Object.freeze({
    schemaVersion: 1,
    event: 'ready',
    service: PROPERTY_PREDATOR_OPENAI_IMAGE_SERVICE,
    mode: runtimeMode,
    model: PROPERTY_PREDATOR_OPENAI_IMAGE_MODEL,
    provider: Object.freeze({
      endpoint: PROPERTY_PREDATOR_OPENAI_IMAGE_BASE_URL,
      credentialBoundary: PROPERTY_PREDATOR_OPENAI_IMAGE_CREDENTIAL_BOUNDARY,
      dedicatedCredentialConfigured: imageCredentialConfigured(env),
    }),
    composition: Object.freeze({
      policy: Boolean(dependencies.policy),
      costEvidence: Boolean(dependencies.costEvidence),
      inspector: Boolean(dependencies.inspector),
      ownedReferenceRegistry: Boolean(dependencies.ownedReferenceRegistry),
      commandBoundary: Boolean(dependencies.commandBoundary),
      providerAdapterInstantiated: adapterInstantiated,
    }),
    safety: Object.freeze({
      providerEffectsEnabled: live,
      imageEffectsEnabled: live,
      generationEnabled: live,
      emergencyPaused: !live,
      providerNetworkCallsMadeAtReadiness: false,
      publishCapability: false,
      customerAttachmentCapability: false,
    }),
    activationReady: live && activationBlockers.length === 0 && adapterInstantiated,
    blockers: activationBlockers,
  });
}

/**
 * Compose the production GPT Image 2 proposal rail without making a provider
 * call. Dark mode returns no transport at all. Live proposal mode exists only
 * when every global, rail and command switch is exact, the emergency pause is
 * deliberately released, the image-only key is valid, and the accounting and
 * inspection services are supplied by the trusted process composition.
 */
export function composePropertyPredatorOpenAiImageRuntime(
  dependencies: PropertyPredatorOpenAiImageRuntimeDependencies = {},
): PropertyPredatorOpenAiImageRuntime {
  const env = dependencies.env ?? process.env;
  if (env.NODE_ENV?.trim() !== 'production') {
    throw new Error('OpenAI image runtime requires NODE_ENV=production');
  }
  assertIsolatedImageProcess(env);
  const runtimeMode = mode(env);
  const activationBlockers = blockers(env, dependencies);

  if (runtimeMode === 'dark-production') {
    exactSwitch(env, 'PROPERTY_PREDATOR_PROVIDER_EFFECTS_ENABLED', 'false');
    exactSwitch(env, 'PROPERTY_PREDATOR_IMAGE_PROVIDER_EFFECTS_ENABLED', 'false');
    exactSwitch(env, 'PROPERTY_PREDATOR_IMAGE_GENERATION_ENABLED', 'false');
    exactSwitch(env, 'PROPERTY_PREDATOR_IMAGE_EMERGENCY_PAUSED', 'true');
    exactSwitch(env, 'PROPERTY_PREDATOR_IMAGE_COMMAND_BOUNDARY_ENABLED', 'false');
    return Object.freeze({
      readiness: readiness(runtimeMode, env, dependencies, activationBlockers, false),
      transport: null,
    });
  }

  exactSwitch(env, 'PROPERTY_PREDATOR_PROVIDER_EFFECTS_ENABLED', 'true');
  exactSwitch(env, 'PROPERTY_PREDATOR_IMAGE_PROVIDER_EFFECTS_ENABLED', 'true');
  exactSwitch(env, 'PROPERTY_PREDATOR_IMAGE_GENERATION_ENABLED', 'true');
  exactSwitch(env, 'PROPERTY_PREDATOR_IMAGE_EMERGENCY_PAUSED', 'false');
  exactSwitch(env, 'PROPERTY_PREDATOR_IMAGE_COMMAND_BOUNDARY_ENABLED', 'true');
  if (env.OPENAI_IMAGE_BASE_URL?.trim() !== PROPERTY_PREDATOR_OPENAI_IMAGE_BASE_URL) {
    throw new Error('OPENAI_IMAGE_BASE_URL must be exactly https://api.openai.com');
  }
  if (activationBlockers.length > 0 || !dependencies.policy
      || !dependencies.costEvidence || !dependencies.inspector
      || !dependencies.commandBoundary) {
    throw new Error('OpenAI image runtime activation inputs are incomplete');
  }

  const apiKey = env.OPENAI_IMAGE_API_KEY ?? '';
  const providerTransport = createPropertyPredatorOpenAiImageTransport({
    baseUrl: PROPERTY_PREDATOR_OPENAI_IMAGE_BASE_URL,
    credential: Object.freeze({
      boundary: PROPERTY_PREDATOR_OPENAI_IMAGE_CREDENTIAL_BOUNDARY,
      purpose: 'image_api_only',
      apiKey,
      contentReadCredentialSha256: exactSha(
        env, 'PROPERTY_PREDATOR_CONTENT_READ_CREDENTIAL_SHA256',
      ),
      contentSyncCredentialSha256: exactSha(
        env, 'PROPERTY_PREDATOR_CONTENT_SYNC_CREDENTIAL_SHA256',
      ),
      textGenerationCredentialSha256: exactSha(
        env, 'PROPERTY_PREDATOR_TEXT_GENERATION_CREDENTIAL_SHA256',
      ),
    }),
    policy: dependencies.policy,
    costEvidence: dependencies.costEvidence,
    inspector: dependencies.inspector,
    ownedReferenceRegistry: dependencies.ownedReferenceRegistry,
    fetchImpl: dependencies.fetchImpl,
  });
  const commandBoundary = dependencies.commandBoundary;
  const transport: PropertyPredatorOpenAiImageTransport = Object.freeze({
    generate: async (command: PropertyPredatorGenerateImageCommand) => {
      await commandBoundary.authorizeExact('generate', command);
      return providerTransport.generate(command);
    },
    edit: async (command: PropertyPredatorEditImageCommand) => {
      await commandBoundary.authorizeExact('edit', command);
      return providerTransport.edit(command);
    },
  });
  return Object.freeze({
    readiness: readiness(runtimeMode, env, dependencies, activationBlockers, true),
    transport,
  });
}
