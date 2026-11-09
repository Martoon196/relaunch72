import { isIP } from 'node:net';

const ENABLED_VALUES = new Set(['1', 'true', 'yes']);
const DISABLED_VALUES = new Set(['', '0', 'false', 'no']);
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const CANONICAL_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface PropertyPredatorExternalEventKeyBindingConfig {
  readonly keyId: string;
  readonly workspaceId: string;
  readonly sharedSecret: Uint8Array;
}

export interface PropertyPredatorExternalEventEnvConfig {
  readonly enabled: boolean;
  readonly configurationReady: boolean;
  readonly production: boolean;
  /** Exact socket peer addresses allowed to assert X-Forwarded-Proto. */
  readonly trustedProxyAddresses: readonly string[];
  /** Render's documented edge contract is active for this web service. */
  readonly renderProxyTrusted: boolean;
  /** Safe for health output. Never contains configured values. */
  readonly blockers: readonly string[];
  readonly binding?: PropertyPredatorExternalEventKeyBindingConfig;
}

function enabledState(raw: string | undefined): { enabled: boolean; invalid: boolean } {
  const normalized = raw?.trim().toLowerCase() ?? '';
  if (DISABLED_VALUES.has(normalized)) return { enabled: false, invalid: false };
  if (ENABLED_VALUES.has(normalized)) return { enabled: true, invalid: false };
  // A non-empty invalid opt-in is treated as an attempted enablement. This
  // keeps the route closed while making the configuration fault visible.
  return { enabled: true, invalid: true };
}

function decodedSecret(raw: string): Uint8Array | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(raw)) return undefined;
  const decoded = Buffer.from(raw, 'base64url');
  if (decoded.byteLength < 32 || decoded.byteLength > 1_024) return undefined;
  if (decoded.toString('base64url') !== raw) return undefined;
  return decoded;
}

/**
 * Load one dedicated key-to-workspace mapping without touching the database.
 * Disabled is the default. Invalid attempted enablement is returned as safe
 * readiness blockers so the process can stay live while the route fails closed.
 */
export function loadPropertyPredatorExternalEventConfig(
  env: NodeJS.ProcessEnv = process.env,
): PropertyPredatorExternalEventEnvConfig {
  const state = enabledState(env.PROPERTY_PREDATOR_EXTERNAL_EVENTS_ENABLED);
  const production = env.NODE_ENV?.trim().toLowerCase() === 'production';
  if (!state.enabled) {
    return Object.freeze({
      enabled: false,
      configurationReady: false,
      production,
      trustedProxyAddresses: Object.freeze([]),
      renderProxyTrusted: false,
      blockers: Object.freeze(['Property Predator external-event bridge is disabled']),
    });
  }

  const blockers: string[] = [];
  if (state.invalid) {
    blockers.push('PROPERTY_PREDATOR_EXTERNAL_EVENTS_ENABLED must be true or false');
  }
  const rawTrustedProxyAddresses =
    env.PROPERTY_PREDATOR_EXTERNAL_EVENTS_TRUSTED_PROXY_ADDRESSES?.trim() ?? '';
  const trustedProxyAddresses = rawTrustedProxyAddresses
    ? rawTrustedProxyAddresses.split(',').map((address) => address.trim())
    : [];
  const renderProxyTrusted = production
    && env.RENDER?.trim() === 'true'
    && env.RENDER_SERVICE_TYPE?.trim() === 'web'
    && env.PORTAL_PROXY_MODE?.trim() === 'render';
  if (trustedProxyAddresses.some((address) => !address || isIP(address) === 0)) {
    blockers.push(
      'PROPERTY_PREDATOR_EXTERNAL_EVENTS_TRUSTED_PROXY_ADDRESSES must contain only IP addresses',
    );
  }
  if (new Set(trustedProxyAddresses).size !== trustedProxyAddresses.length) {
    blockers.push(
      'PROPERTY_PREDATOR_EXTERNAL_EVENTS_TRUSTED_PROXY_ADDRESSES must not contain duplicates',
    );
  }
  const legacyTrustProxy = enabledState(
    env.PROPERTY_PREDATOR_EXTERNAL_EVENTS_TRUST_FORWARDED_PROTO,
  );
  if (legacyTrustProxy.enabled || legacyTrustProxy.invalid) {
    blockers.push(
      'PROPERTY_PREDATOR_EXTERNAL_EVENTS_TRUST_FORWARDED_PROTO is unsupported; configure exact trusted proxy addresses',
    );
  }
  const keyId = env.PROPERTY_PREDATOR_EXTERNAL_EVENTS_KEY_ID?.trim() ?? '';
  if (!KEY_ID_PATTERN.test(keyId)) {
    blockers.push('PROPERTY_PREDATOR_EXTERNAL_EVENTS_KEY_ID is missing or invalid');
  }
  const workspaceId = env.PROPERTY_PREDATOR_EXTERNAL_EVENTS_WORKSPACE_ID?.trim() ?? '';
  if (!CANONICAL_UUID_PATTERN.test(workspaceId)) {
    blockers.push('PROPERTY_PREDATOR_EXTERNAL_EVENTS_WORKSPACE_ID is missing or invalid');
  }
  const rawSecret = env.PROPERTY_PREDATOR_EXTERNAL_EVENTS_HMAC_SECRET_BASE64URL?.trim() ?? '';
  const sharedSecret = decodedSecret(rawSecret);
  if (!sharedSecret) {
    blockers.push('PROPERTY_PREDATOR_EXTERNAL_EVENTS_HMAC_SECRET_BASE64URL is missing or invalid');
  }

  // This source bridge has a dedicated HMAC key. It never falls back to, or
  // knowingly accepts an exact reuse of, another configured application secret.
  const otherSecrets = [
    env.STRIPE_SECRET_KEY,
    env.STRIPE_WEBHOOK_SECRET,
    env.SESSION_SECRET,
    env.SANDBOX_ACCESS_TOKEN,
    env.POSTMARK_SERVER_TOKEN,
    env.BREVO_API_KEY,
  ].map((value) => value?.trim()).filter((value): value is string => Boolean(value));
  if (rawSecret && otherSecrets.includes(rawSecret)) {
    blockers.push('Property Predator HMAC secret must be dedicated to the external-event bridge');
  }

  if (blockers.length > 0 || !sharedSecret) {
    return Object.freeze({
      enabled: true,
      configurationReady: false,
      production,
      trustedProxyAddresses: Object.freeze([...trustedProxyAddresses]),
      renderProxyTrusted,
      blockers: Object.freeze(blockers),
    });
  }
  return Object.freeze({
    enabled: true,
    configurationReady: true,
    production,
    trustedProxyAddresses: Object.freeze([...trustedProxyAddresses]),
    renderProxyTrusted,
    blockers: Object.freeze([]),
    binding: Object.freeze({ keyId, workspaceId, sharedSecret }),
  });
}
