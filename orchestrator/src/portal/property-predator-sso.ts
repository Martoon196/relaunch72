import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import type { PortalExternalIdentityAssertion } from './auth-service.js';

export const PROPERTY_PREDATOR_SSO_START_ROUTE = '/portal/auth/property-predator';
export const PROPERTY_PREDATOR_SSO_CALLBACK_ROUTE = '/portal/auth/property-predator/callback';
export const PROPERTY_PREDATOR_SSO_COOKIE = 'r72_property_predator_sso';
export const PROPERTY_PREDATOR_SSO_TTL_SECONDS = 10 * 60;
export const PROPERTY_PREDATOR_SSO_ISSUER = 'https://propertypredator.com';
export const PROPERTY_PREDATOR_SSO_CLIENT_ID = 'growth-hq';
const PROPERTY_PREDATOR_SSO_CLOCK_SKEW_MS = 60 * 1000;
const PROPERTY_PREDATOR_SSO_ASSERTION_MAX_LIFETIME_MS = 10 * 60 * 1000;
const COOKIE_KEY_CONTEXT = 'relaunch72/key/property-predator-sso-cookie/v1\u0000';
const COOKIE_AAD = Buffer.from('relaunch72/session/property-predator-sso/v1\u0000');
const CONFIG_CONTEXT = 'relaunch72/property-predator-sso/config/v1\u0000';
const BASE64URL_32_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CLIENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;
const CLIENT_SECRET_PATTERN = /^[\x21-\x7e]+$/u;
const AFFILIATE_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const AFFILIATE_STATUS_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

export type PropertyPredatorSsoProviderHint = 'google';

export interface PropertyPredatorSsoConfig {
  issuer: string;
  authorizeUrl: string;
  tokenUrl: string;
  clientId: string;
  /** Secret. Never log, render or persist this value. */
  clientSecret: string;
  redirectUri: string;
  bootstrapUserId?: string;
  bootstrapEmails: ReadonlySet<string>;
}

export interface PropertyPredatorSsoTransaction {
  state: string;
  codeVerifier: string;
  configurationHash: string;
  issuedAt: number;
  expiresAt: number;
}

export interface PropertyPredatorSsoAuthorization {
  url: string;
  cookie: string;
}

export interface PropertyPredatorSsoExchange {
  assertion: PortalExternalIdentityAssertion;
  bootstrapUserId?: string;
}

export interface PropertyPredatorSsoClient {
  begin(
    provider: PropertyPredatorSsoProviderHint | undefined,
    now: number,
  ): PropertyPredatorSsoAuthorization;
  complete(
    code: string,
    state: string,
    transactionCookie: string | undefined,
    now: number,
  ): Promise<PropertyPredatorSsoExchange | null>;
  clearCookie(): string;
}

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Pick<Response, 'ok' | 'status' | 'headers' | 'text'>>;

export interface PropertyPredatorSsoDependencies {
  config: PropertyPredatorSsoConfig;
  sessionSecret: string;
  secure: boolean;
  fetch?: FetchLike;
  randomBytes?: (size: number) => Buffer;
}

export interface PropertyPredatorSsoComposition {
  state: 'disabled' | 'ready' | 'invalid';
  client?: PropertyPredatorSsoClient;
}

export class PropertyPredatorSsoConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PropertyPredatorSsoConfigurationError';
  }
}

export class PropertyPredatorSsoExchangeError extends Error {
  constructor(message = 'Property Predator identity exchange failed') {
    super(message);
    this.name = 'PropertyPredatorSsoExchangeError';
  }
}

function exactBoolean(raw: string | undefined, name: string): boolean {
  const value = raw?.trim().toLowerCase() ?? '';
  if (!value || value === 'false') return false;
  if (value === 'true') return true;
  throw new PropertyPredatorSsoConfigurationError(`${name} must be true or false`);
}

function exactUrl(
  raw: string | undefined,
  name: string,
  production: boolean,
  expectedPath?: string,
): URL {
  if (!raw?.trim() || raw.trim() !== raw) {
    throw new PropertyPredatorSsoConfigurationError(`${name} is required and must not contain surrounding whitespace`);
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new PropertyPredatorSsoConfigurationError(`${name} must be an absolute URL`);
  }
  const loopback = /^(?:localhost|127(?:\.\d{1,3}){3}|::1)$/i.test(parsed.hostname);
  if ((production || !loopback) && parsed.protocol !== 'https:') {
    throw new PropertyPredatorSsoConfigurationError(`${name} must use HTTPS`);
  }
  if (!['https:', 'http:'].includes(parsed.protocol)
      || parsed.username || parsed.password || parsed.search || parsed.hash
      || (expectedPath !== undefined && parsed.pathname !== expectedPath)) {
    throw new PropertyPredatorSsoConfigurationError(`${name} has an invalid origin, path or credential component`);
  }
  return parsed;
}

function canonicalOrigin(url: URL): string {
  return url.origin;
}

function canonicalEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return value === normalized
    && normalized.length >= 3
    && normalized.length <= 320
    && EMAIL_PATTERN.test(normalized)
    ? normalized
    : null;
}

function canonicalUuid(value: unknown): string | null {
  return typeof value === 'string' && UUID_PATTERN.test(value) ? value : null;
}

function nullableUuid(value: unknown): string | null | undefined {
  if (value === null) return null;
  return canonicalUuid(value) ?? undefined;
}

function nullableText(
  value: unknown,
  pattern: RegExp,
): string | null | undefined {
  if (value === null) return null;
  return typeof value === 'string' && pattern.test(value) ? value : undefined;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).sort().join(',') === [...expected].sort().join(',');
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function dateInstant(value: unknown): number | null {
  if (typeof value !== 'string' || value.length < 20 || value.length > 40) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function loadPropertyPredatorSsoConfig(
  env: NodeJS.ProcessEnv = process.env,
): PropertyPredatorSsoConfig | null {
  if (!exactBoolean(env.PROPERTY_PREDATOR_SSO_ENABLED, 'PROPERTY_PREDATOR_SSO_ENABLED')) return null;
  const production = env.NODE_ENV?.trim().toLowerCase() === 'production';
  const issuerUrl = exactUrl(env.PROPERTY_PREDATOR_SSO_ISSUER, 'PROPERTY_PREDATOR_SSO_ISSUER', production, '/');
  const authorizeUrl = exactUrl(
    env.PROPERTY_PREDATOR_SSO_AUTHORIZE_URL,
    'PROPERTY_PREDATOR_SSO_AUTHORIZE_URL',
    production,
    '/sso.html',
  );
  const tokenUrl = exactUrl(
    env.PROPERTY_PREDATOR_SSO_TOKEN_URL,
    'PROPERTY_PREDATOR_SSO_TOKEN_URL',
    production,
    '/api/auth/sso/token',
  );
  if (authorizeUrl.origin !== issuerUrl.origin || tokenUrl.origin !== issuerUrl.origin) {
    throw new PropertyPredatorSsoConfigurationError('Property Predator SSO endpoints must share the exact issuer origin');
  }
  if (canonicalOrigin(issuerUrl) !== PROPERTY_PREDATOR_SSO_ISSUER) {
    throw new PropertyPredatorSsoConfigurationError('PROPERTY_PREDATOR_SSO_ISSUER must be the canonical Property Predator origin');
  }
  const redirectUrl = exactUrl(
    env.PROPERTY_PREDATOR_SSO_REDIRECT_URI,
    'PROPERTY_PREDATOR_SSO_REDIRECT_URI',
    production,
    PROPERTY_PREDATOR_SSO_CALLBACK_ROUTE,
  );
  if (production && redirectUrl.origin !== 'https://hq.propertypredator.com') {
    throw new PropertyPredatorSsoConfigurationError('Production Property Predator SSO callback must use the canonical Growth HQ origin');
  }
  const clientId = env.PROPERTY_PREDATOR_SSO_CLIENT_ID?.trim() ?? '';
  if (clientId !== env.PROPERTY_PREDATOR_SSO_CLIENT_ID
      || !CLIENT_ID_PATTERN.test(clientId)
      || clientId !== PROPERTY_PREDATOR_SSO_CLIENT_ID) {
    throw new PropertyPredatorSsoConfigurationError('PROPERTY_PREDATOR_SSO_CLIENT_ID must be growth-hq');
  }
  const clientSecret = env.PROPERTY_PREDATOR_SSO_CLIENT_SECRET ?? '';
  if (clientSecret.length < (production ? 32 : 16)
      || clientSecret.length > 512
      || !CLIENT_SECRET_PATTERN.test(clientSecret)) {
    throw new PropertyPredatorSsoConfigurationError(
      'PROPERTY_PREDATOR_SSO_CLIENT_SECRET must contain only printable ASCII characters and have a valid length',
    );
  }
  const bootstrapUserId = env.PROPERTY_PREDATOR_SSO_BOOTSTRAP_USER_ID?.trim() || undefined;
  if (bootstrapUserId && !UUID_PATTERN.test(bootstrapUserId)) {
    throw new PropertyPredatorSsoConfigurationError('PROPERTY_PREDATOR_SSO_BOOTSTRAP_USER_ID must be a canonical UUID');
  }
  const bootstrapEmails = new Set<string>();
  for (const raw of (env.PROPERTY_PREDATOR_SSO_BOOTSTRAP_EMAILS ?? '').split(',')) {
    if (!raw.trim()) continue;
    const email = raw.trim().toLowerCase();
    if (email !== raw.trim() || !EMAIL_PATTERN.test(email) || email.length > 320) {
      throw new PropertyPredatorSsoConfigurationError('PROPERTY_PREDATOR_SSO_BOOTSTRAP_EMAILS contains an invalid email');
    }
    bootstrapEmails.add(email);
  }
  if (Boolean(bootstrapUserId) !== (bootstrapEmails.size > 0)) {
    throw new PropertyPredatorSsoConfigurationError('SSO bootstrap user id and email allowlist must be configured together');
  }
  return Object.freeze({
    issuer: canonicalOrigin(issuerUrl),
    authorizeUrl: authorizeUrl.toString(),
    tokenUrl: tokenUrl.toString(),
    clientId,
    clientSecret,
    redirectUri: redirectUrl.toString(),
    bootstrapUserId,
    bootstrapEmails,
  });
}

function configurationHash(config: PropertyPredatorSsoConfig): string {
  return createHash('sha256')
    .update(CONFIG_CONTEXT)
    .update(JSON.stringify([
      config.issuer,
      config.authorizeUrl,
      config.tokenUrl,
      config.clientId,
      config.redirectUri,
    ]))
    .digest('base64url');
}

function cookieKey(secret: string): Buffer {
  return createHmac('sha256', secret).update(COOKIE_KEY_CONTEXT).digest();
}

function canonicalBase64url(value: string, expectedLength?: number): Buffer | null {
  if (!value || !BASE64URL_PATTERN.test(value)) return null;
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.toString('base64url') !== value
      || (expectedLength !== undefined && decoded.length !== expectedLength)) return null;
  return decoded;
}

function encryptTransaction(
  secret: string,
  transaction: PropertyPredatorSsoTransaction,
  nonceSource: (size: number) => Buffer,
): string {
  const nonce = nonceSource(12);
  if (!Buffer.isBuffer(nonce) || nonce.length !== 12) throw new Error('SSO cookie nonce source failed');
  const cipher = createCipheriv('aes-256-gcm', cookieKey(secret), nonce);
  cipher.setAAD(COOKIE_AAD);
  const cleartext = Buffer.from(JSON.stringify({
    v: 1,
    aud: 'property-predator-sso',
    state: transaction.state,
    verifier: transaction.codeVerifier,
    cfg: transaction.configurationHash,
    iat: transaction.issuedAt,
    exp: transaction.expiresAt,
  }));
  const ciphertext = Buffer.concat([cipher.update(cleartext), cipher.final()]);
  return [nonce, ciphertext, cipher.getAuthTag()].map((part) => part.toString('base64url')).join('.');
}

export function verifyPropertyPredatorSsoTransaction(
  secret: string,
  config: PropertyPredatorSsoConfig,
  cookieValue: string | undefined,
  now: number,
): PropertyPredatorSsoTransaction | null {
  if (!secret || !cookieValue || !Number.isSafeInteger(now)) return null;
  const [nonceText, ciphertextText, tagText, extra] = cookieValue.split('.');
  if (extra !== undefined || !nonceText || !ciphertextText || !tagText) return null;
  const nonce = canonicalBase64url(nonceText, 12);
  const ciphertext = canonicalBase64url(ciphertextText);
  const tag = canonicalBase64url(tagText, 16);
  if (!nonce || !ciphertext || !tag || ciphertext.length > 2_048) return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', cookieKey(secret), nonce);
    decipher.setAAD(COOKIE_AAD);
    decipher.setAuthTag(tag);
    const parsed = JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')) as unknown;
    const payload = record(parsed);
    if (!payload || !exactKeys(payload, ['v', 'aud', 'state', 'verifier', 'cfg', 'iat', 'exp'])
        || payload.v !== 1
        || payload.aud !== 'property-predator-sso'
        || typeof payload.state !== 'string'
        || !BASE64URL_32_PATTERN.test(payload.state)
        || typeof payload.verifier !== 'string'
        || !BASE64URL_32_PATTERN.test(payload.verifier)
        || payload.cfg !== configurationHash(config)
        || typeof payload.iat !== 'number'
        || !Number.isSafeInteger(payload.iat)
        || typeof payload.exp !== 'number'
        || !Number.isSafeInteger(payload.exp)
        || payload.exp - payload.iat !== PROPERTY_PREDATOR_SSO_TTL_SECONDS * 1000
        || payload.iat > now + PROPERTY_PREDATOR_SSO_CLOCK_SKEW_MS
        || payload.exp <= now) return null;
    return Object.freeze({
      state: payload.state,
      codeVerifier: payload.verifier,
      configurationHash: payload.cfg,
      issuedAt: payload.iat,
      expiresAt: payload.exp,
    });
  } catch {
    return null;
  }
}

function transactionCookie(value: string, secure: boolean): string {
  const bits = [
    `${PROPERTY_PREDATOR_SSO_COOKIE}=${value}`,
    'HttpOnly',
    'SameSite=Lax',
    `Path=${PROPERTY_PREDATOR_SSO_CALLBACK_ROUTE}`,
    `Max-Age=${PROPERTY_PREDATOR_SSO_TTL_SECONDS}`,
  ];
  if (secure) bits.push('Secure');
  return bits.join('; ');
}

export function clearPropertyPredatorSsoCookie(secure: boolean): string {
  const bits = [
    `${PROPERTY_PREDATOR_SSO_COOKIE}=`,
    'HttpOnly',
    'SameSite=Lax',
    `Path=${PROPERTY_PREDATOR_SSO_CALLBACK_ROUTE}`,
    'Max-Age=0',
  ];
  if (secure) bits.push('Secure');
  return bits.join('; ');
}

function stateMatches(expected: string, supplied: string): boolean {
  if (!BASE64URL_32_PATTERN.test(expected) || !BASE64URL_32_PATTERN.test(supplied)) return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(supplied);
  return left.length === right.length && timingSafeEqual(left, right);
}

function parseIdentityResponse(
  raw: unknown,
  config: PropertyPredatorSsoConfig,
  now: number,
): PortalExternalIdentityAssertion | null {
  const root = record(raw);
  if (!root || !exactKeys(root, ['token_type', 'identity']) || root.token_type !== 'identity') return null;
  const identity = record(root.identity);
  if (!identity || !exactKeys(identity, [
    'schema_version', 'issuer', 'audience', 'subject', 'email', 'email_verified',
    'issued_at', 'expires_at', 'affiliate', 'attribution',
  ])) return null;
  const affiliate = record(identity.affiliate);
  const attribution = record(identity.attribution);
  if (!affiliate || !exactKeys(affiliate, ['member', 'affiliate_id', 'code', 'code_status'])
      || !attribution || !exactKeys(attribution, ['referrer_affiliate_id', 'attached_at'])) return null;
  const subject = canonicalUuid(identity.subject);
  const email = canonicalEmail(identity.email);
  const issuedAt = dateInstant(identity.issued_at);
  const expiresAt = dateInstant(identity.expires_at);
  const affiliateId = nullableUuid(affiliate.affiliate_id);
  const affiliateCode = nullableText(affiliate.code, AFFILIATE_CODE_PATTERN);
  const affiliateCodeStatus = nullableText(affiliate.code_status, AFFILIATE_STATUS_PATTERN);
  const referrerAffiliateId = nullableUuid(attribution.referrer_affiliate_id);
  const attachedAtMs = attribution.attached_at === null ? null : dateInstant(attribution.attached_at);
  if (identity.schema_version !== 1
      || identity.issuer !== config.issuer
      || identity.audience !== 'growth-hq'
      || !subject || !email || identity.email_verified !== true
      || issuedAt === null || expiresAt === null
      || issuedAt > now + PROPERTY_PREDATOR_SSO_CLOCK_SKEW_MS
      || expiresAt <= now
      || expiresAt <= issuedAt
      || expiresAt - issuedAt > PROPERTY_PREDATOR_SSO_ASSERTION_MAX_LIFETIME_MS
      || typeof affiliate.member !== 'boolean'
      || affiliateId === undefined
      || affiliateCode === undefined
      || affiliateCodeStatus === undefined
      || referrerAffiliateId === undefined
      || (attachedAtMs === null) !== (attribution.attached_at === null)
      || (attachedAtMs !== null && attachedAtMs > now + PROPERTY_PREDATOR_SSO_CLOCK_SKEW_MS)
      || (affiliate.member
        ? (affiliateId === null || affiliateCode === null || affiliateCodeStatus === null)
        : (affiliateId !== null || affiliateCode !== null || affiliateCodeStatus !== null))) {
    return null;
  }
  return Object.freeze({
    issuer: config.issuer,
    subject,
    email,
    emailVerified: true,
    issuedAt: new Date(issuedAt).toISOString(),
    expiresAt: new Date(expiresAt).toISOString(),
    affiliate: Object.freeze({
      member: affiliate.member,
      affiliateId,
      code: affiliateCode,
      codeStatus: affiliateCodeStatus,
    }),
    attribution: Object.freeze({
      referrerAffiliateId,
      attachedAt: attachedAtMs === null ? null : new Date(attachedAtMs).toISOString(),
    }),
  });
}

export class LivePropertyPredatorSsoClient implements PropertyPredatorSsoClient {
  readonly #fetch: FetchLike;
  readonly #randomBytes: (size: number) => Buffer;

  constructor(private readonly dependencies: PropertyPredatorSsoDependencies) {
    if (!dependencies.sessionSecret || dependencies.sessionSecret.length < 16) {
      throw new PropertyPredatorSsoConfigurationError('SSO transaction encryption requires the portal session secret');
    }
    if (dependencies.config.issuer !== PROPERTY_PREDATOR_SSO_ISSUER
        || dependencies.config.authorizeUrl !== `${PROPERTY_PREDATOR_SSO_ISSUER}/sso.html`
        || dependencies.config.tokenUrl !== `${PROPERTY_PREDATOR_SSO_ISSUER}/api/auth/sso/token`
        || dependencies.config.clientId !== PROPERTY_PREDATOR_SSO_CLIENT_ID
        || dependencies.config.clientSecret.length < 16
        || dependencies.config.clientSecret.length > 512
        || !CLIENT_SECRET_PATTERN.test(dependencies.config.clientSecret)) {
      throw new PropertyPredatorSsoConfigurationError('SSO client is not pinned to the canonical Property Predator contract');
    }
    const portalSecretHash = createHash('sha256').update(dependencies.sessionSecret).digest();
    const clientSecretHash = createHash('sha256').update(dependencies.config.clientSecret).digest();
    if (timingSafeEqual(portalSecretHash, clientSecretHash)) {
      throw new PropertyPredatorSsoConfigurationError('SSO client secret must be dedicated and cannot reuse the portal session secret');
    }
    this.#fetch = dependencies.fetch ?? globalThis.fetch;
    this.#randomBytes = dependencies.randomBytes ?? randomBytes;
  }

  begin(
    provider: PropertyPredatorSsoProviderHint | undefined,
    now: number,
  ): PropertyPredatorSsoAuthorization {
    if (!Number.isSafeInteger(now)) throw new Error('SSO start requires a safe clock');
    const state = this.#randomBytes(32).toString('base64url');
    const codeVerifier = this.#randomBytes(32).toString('base64url');
    if (!BASE64URL_32_PATTERN.test(state) || !BASE64URL_32_PATTERN.test(codeVerifier)) {
      throw new Error('SSO random source must return 32 bytes');
    }
    const codeChallenge = createHash('sha256').update(codeVerifier, 'ascii').digest('base64url');
    const transaction: PropertyPredatorSsoTransaction = Object.freeze({
      state,
      codeVerifier,
      configurationHash: configurationHash(this.dependencies.config),
      issuedAt: now,
      expiresAt: now + PROPERTY_PREDATOR_SSO_TTL_SECONDS * 1000,
    });
    const authorization = new URL(this.dependencies.config.authorizeUrl);
    authorization.searchParams.set('client_id', this.dependencies.config.clientId);
    authorization.searchParams.set('redirect_uri', this.dependencies.config.redirectUri);
    authorization.searchParams.set('state', state);
    authorization.searchParams.set('code_challenge', codeChallenge);
    authorization.searchParams.set('code_challenge_method', 'S256');
    if (provider) authorization.searchParams.set('provider', provider);
    return Object.freeze({
      url: authorization.toString(),
      cookie: transactionCookie(
        encryptTransaction(this.dependencies.sessionSecret, transaction, this.#randomBytes),
        this.dependencies.secure,
      ),
    });
  }

  async complete(
    code: string,
    state: string,
    transactionCookieValue: string | undefined,
    now: number,
  ): Promise<PropertyPredatorSsoExchange | null> {
    const transaction = verifyPropertyPredatorSsoTransaction(
      this.dependencies.sessionSecret,
      this.dependencies.config,
      transactionCookieValue,
      now,
    );
    if (!transaction || !stateMatches(transaction.state, state)
        || code.length < 16 || code.length > 2_048 || /[\u0000-\u001f\u007f]/u.test(code)) return null;

    let response: Pick<Response, 'ok' | 'status' | 'headers' | 'text'>;
    try {
      response = await this.#fetch(this.dependencies.config.tokenUrl, {
        method: 'POST',
        redirect: 'error',
        cache: 'no-store',
        signal: AbortSignal.timeout(5_000),
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          authorization: `Basic ${Buffer.from(`${this.dependencies.config.clientId}:${this.dependencies.config.clientSecret}`, 'utf8').toString('base64')}`,
        },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          client_id: this.dependencies.config.clientId,
          code,
          redirect_uri: this.dependencies.config.redirectUri,
          code_verifier: transaction.codeVerifier,
        }),
      });
    } catch {
      throw new PropertyPredatorSsoExchangeError();
    }
    const contentLength = Number(response.headers.get('content-length') ?? '0');
    const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
    if (!response.ok || response.status !== 200 || !contentType.startsWith('application/json')
        || (Number.isFinite(contentLength) && contentLength > 64 * 1024)) {
      throw new PropertyPredatorSsoExchangeError();
    }
    const text = await response.text();
    if (Buffer.byteLength(text) > 64 * 1024) throw new PropertyPredatorSsoExchangeError();
    let decoded: unknown;
    try {
      decoded = JSON.parse(text);
    } catch {
      throw new PropertyPredatorSsoExchangeError();
    }
    const assertion = parseIdentityResponse(decoded, this.dependencies.config, now);
    if (!assertion) throw new PropertyPredatorSsoExchangeError();
    const bootstrapUserId = this.dependencies.config.bootstrapEmails.has(assertion.email)
      ? this.dependencies.config.bootstrapUserId
      : undefined;
    return Object.freeze({ assertion, bootstrapUserId });
  }

  clearCookie(): string {
    return clearPropertyPredatorSsoCookie(this.dependencies.secure);
  }
}

/**
 * Keep native password access available when an operator supplies an incomplete
 * SSO configuration. Invalid values never create a partial/permissive client;
 * only the optional SSO routes disappear.
 */
export function composePropertyPredatorSso(
  env: NodeJS.ProcessEnv,
  sessionSecret: string,
  secure: boolean,
): PropertyPredatorSsoComposition {
  try {
    const config = loadPropertyPredatorSsoConfig(env);
    if (!config) return Object.freeze({ state: 'disabled' });
    return Object.freeze({
      state: 'ready',
      client: new LivePropertyPredatorSsoClient({ config, sessionSecret, secure }),
    });
  } catch (error) {
    if (error instanceof PropertyPredatorSsoConfigurationError) {
      return Object.freeze({ state: 'invalid' });
    }
    throw error;
  }
}
