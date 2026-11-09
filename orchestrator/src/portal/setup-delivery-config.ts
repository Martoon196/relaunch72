import { SetupDeliveryKeyring } from './setup-delivery-pg-service.js';

const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
const CANONICAL_32_BYTE_BASE64URL_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface SetupDeliveryRuntimeConfig {
  keyring: SetupDeliveryKeyring;
  portalOrigin: string;
  setupUrl: string;
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

function parseKeyring(env: NodeJS.ProcessEnv): SetupDeliveryKeyring {
  const rawActiveKeyId = env.SETUP_DELIVERY_ACTIVE_KEY_ID;
  const activeKeyId = rawActiveKeyId?.trim() ?? '';
  if (!activeKeyId || activeKeyId !== rawActiveKeyId || !KEY_ID_PATTERN.test(activeKeyId)) {
    throw new Error('SETUP_DELIVERY_ACTIVE_KEY_ID must be a valid, trimmed key id');
  }

  const rawKeys = env.SETUP_DELIVERY_KEYS_JSON?.trim();
  if (!rawKeys) {
    throw new Error('SETUP_DELIVERY_KEYS_JSON is required');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawKeys);
  } catch {
    // Deliberately discard the parser message: some runtimes include excerpts
    // of the secret-bearing value in JSON syntax errors.
    throw new Error('SETUP_DELIVERY_KEYS_JSON must be valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('SETUP_DELIVERY_KEYS_JSON must be a JSON object');
  }

  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length < 1 || entries.length > 32) {
    throw new Error('SETUP_DELIVERY_KEYS_JSON must contain 1 to 32 keys');
  }

  const keys: Record<string, Uint8Array> = Object.create(null) as Record<string, Uint8Array>;
  for (const [keyId, encoded] of entries) {
    if (!KEY_ID_PATTERN.test(keyId)) {
      throw new Error('SETUP_DELIVERY_KEYS_JSON contains an invalid key id');
    }
    if (typeof encoded !== 'string'
        || !CANONICAL_32_BYTE_BASE64URL_PATTERN.test(encoded)) {
      throw new Error(`SETUP_DELIVERY_KEYS_JSON key ${keyId} must be a canonical 32-byte base64url value`);
    }
    const decoded = Buffer.from(encoded, 'base64url');
    if (decoded.byteLength !== 32 || decoded.toString('base64url') !== encoded) {
      throw new Error(`SETUP_DELIVERY_KEYS_JSON key ${keyId} must be a canonical 32-byte base64url value`);
    }
    keys[keyId] = decoded;
  }

  if (!Object.hasOwn(keys, activeKeyId)) {
    throw new Error('SETUP_DELIVERY_ACTIVE_KEY_ID is not present in SETUP_DELIVERY_KEYS_JSON');
  }
  return new SetupDeliveryKeyring({ activeKeyId, keys });
}

function parsePortalOrigin(env: NodeJS.ProcessEnv): URL {
  const raw = env.PORTAL_BASE_URL?.trim();
  if (!raw) throw new Error('PORTAL_BASE_URL is required for native onboarding');

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('PORTAL_BASE_URL must be a valid absolute origin');
  }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('PORTAL_BASE_URL must contain only an origin, with no credentials, path, query or fragment');
  }

  const production = env.NODE_ENV?.trim().toLowerCase() === 'production';
  const permittedDevelopmentHttp = !production
    && url.protocol === 'http:'
    && isLoopbackHostname(url.hostname);
  if (url.protocol !== 'https:' && !permittedDevelopmentHttp) {
    throw new Error('PORTAL_BASE_URL must use HTTPS; HTTP is allowed only on loopback in development');
  }
  return url;
}

/**
 * Load the secrets and canonical portal origin needed to create durable setup
 * deliveries. The raw key material is retained only inside the keyring.
 */
export function loadSetupDeliveryRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
): SetupDeliveryRuntimeConfig {
  const keyring = parseKeyring(env);
  const portal = parsePortalOrigin(env);
  const portalOrigin = portal.origin;
  return Object.freeze({
    keyring,
    portalOrigin,
    setupUrl: `${portalOrigin}/portal/setup`,
  });
}
