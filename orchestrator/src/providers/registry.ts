import { isPlatformCapability, type PlatformCapability } from '../platform/capabilities.js';

export type ProviderKind = 'social' | 'messaging' | 'webinar' | 'email' | 'payments' | 'analytics';
export type ProviderCredentialAuthMode = 'oauth2' | 'api_key' | 'service_account' | 'none';
export type ProviderWebhookVerificationMode =
  | 'hmac_signature'
  | 'asymmetric_signature'
  | 'verification_token'
  | 'none';

export interface ProviderManifest {
  id: string;
  name: string;
  kind: ProviderKind;
  /** How an adapter authenticates outbound requests to the provider. */
  outboundCredentialAuth: ProviderCredentialAuthMode;
  /** How an adapter verifies inbound callbacks before accepting their payload. */
  inboundWebhookVerification: ProviderWebhookVerificationMode;
  capabilities: readonly PlatformCapability[];
}

export interface ProviderRegistry {
  readonly providers: readonly ProviderManifest[];
  get(id: string): ProviderManifest;
  forCapability(capability: PlatformCapability): readonly ProviderManifest[];
}

const CREDENTIAL_AUTH_MODES = new Set<ProviderCredentialAuthMode>([
  'oauth2',
  'api_key',
  'service_account',
  'none',
]);
const WEBHOOK_VERIFICATION_MODES = new Set<ProviderWebhookVerificationMode>([
  'hmac_signature',
  'asymmetric_signature',
  'verification_token',
  'none',
]);
const PROVIDER_KINDS = new Set<ProviderKind>(['social', 'messaging', 'webinar', 'email', 'payments', 'analytics']);

/**
 * Build provider discovery metadata.
 *
 * This registry does not hold credentials and is not a tenant-isolation
 * boundary. Workers must load a provider connection with a composite
 * `(workspace_id, id)` predicate inside a workspace-scoped transaction. The
 * database foreign keys and RLS policy are what enforce connection ownership.
 */
export function createProviderRegistry(input: readonly ProviderManifest[]): ProviderRegistry {
  const byId = new Map<string, ProviderManifest>();
  for (const source of input) {
    const id = source.id.trim();
    if (!id || !source.name.trim()) throw new Error('provider id and name are required');
    if (byId.has(id)) throw new Error(`duplicate provider id: ${id}`);
    if (!PROVIDER_KINDS.has(source.kind)) throw new Error(`provider ${id} has an invalid kind`);
    if (!CREDENTIAL_AUTH_MODES.has(source.outboundCredentialAuth)) {
      throw new Error(`provider ${id} has an invalid outbound credential auth mode`);
    }
    if (!WEBHOOK_VERIFICATION_MODES.has(source.inboundWebhookVerification)) {
      throw new Error(`provider ${id} has an invalid inbound webhook verification mode`);
    }
    if (!Array.isArray(source.capabilities)
        || source.capabilities.some((capability) => !isPlatformCapability(capability))) {
      throw new Error(`provider ${id} has an invalid capability`);
    }
    const capabilities = [...new Set(source.capabilities)];
    if (!capabilities.length) throw new Error(`provider ${id} must expose at least one capability`);
    byId.set(id, Object.freeze({ ...source, id, capabilities: Object.freeze(capabilities) }));
  }
  const providers = Object.freeze([...byId.values()].sort((a, b) => a.name.localeCompare(b.name)));
  return Object.freeze({
    providers,
    get(id: string): ProviderManifest {
      const provider = byId.get(id);
      if (!provider) throw new Error(`unknown provider: ${id}`);
      return provider;
    },
    forCapability(capability: PlatformCapability): readonly ProviderManifest[] {
      return Object.freeze(providers.filter((provider) => provider.capabilities.includes(capability)));
    },
  });
}

/** Providers are registered by composition only after their adapter is real. */
export const providerRegistry = createProviderRegistry([]);
