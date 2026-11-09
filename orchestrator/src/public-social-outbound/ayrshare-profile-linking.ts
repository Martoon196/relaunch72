import { createHash, createPrivateKey } from 'node:crypto';

const AYRSHARE_API_ORIGIN = 'https://api.ayrshare.com';
const AYRSHARE_PROFILE_ORIGIN = 'https://profile.ayrshare.com';
const MAX_RESPONSE_BYTES = 65_536;
const MAX_TITLE_CODE_POINTS = 80;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const PROFILE_KEY = /^[A-Z0-9][A-Z0-9-]{15,99}$/u;
const REF_ID = /^[A-Za-z0-9_-]{8,200}$/u;
const JWT = /^[A-Za-z0-9_-]{10,4096}\.[A-Za-z0-9_-]{10,8192}\.[A-Za-z0-9_-]{10,8192}$/u;
const SAFE_DOMAIN = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/u;
const PEM_PRIVATE_KEY = /^-----BEGIN (?:RSA )?PRIVATE KEY-----\r?\n[A-Za-z0-9+/=\r\n]{64,16384}-----END (?:RSA )?PRIVATE KEY-----\r?\n?$/u;

export const AYRSHARE_PROFILE_LINKING_CONTRACT =
  'propertypredator.ayrshare-profile-linking/v1' as const;

/** No portal composition is approved until the durable repository is implemented and reviewed. */
export const AYRSHARE_PROFILE_LINKING_PORTAL_READY = false as const;

export const AYRSHARE_LINKABLE_SOCIALS = Object.freeze([
  'facebook', 'instagram', 'linkedin', 'x', 'tiktok', 'youtube', 'threads', 'pinterest',
] as const);

export type AyrshareLinkableSocial = typeof AYRSHARE_LINKABLE_SOCIALS[number];

export interface AyrshareProfileBinding {
  readonly workspaceId: string;
  readonly profileTitle: string;
  readonly refId: string;
  /** Secret: repository implementations must encrypt this at rest and never render it. */
  readonly profileKey: string;
  readonly profileKeySha256: string;
  readonly createdAt: string;
}

export interface AyrshareProfileBindingRepository {
  /** Production implementations must be workspace-qualified and encrypt Profile Keys at rest. */
  readonly securityContract: 'workspace_scoped_encrypted_profile_key_v1';
  /**
   * Durable, atomic pre-provider fence. A claimed lease must survive process
   * death; in-progress/unknown claims must block another Create Profile call.
   */
  claimProfileCreation(input: Readonly<{
    workspaceId: string;
    commandId: string;
    profileTitle: string;
    profileIntentSha256: string;
  }>): Promise<
    | Readonly<{ state: 'existing'; binding: AyrshareProfileBinding }>
    | Readonly<{ state: 'claimed'; leaseId: string }>
    | Readonly<{ state: 'in_progress' | 'outcome_unknown' | 'conflict' }>
  >;
  /** Stores the one-time Profile Key before the lease can become complete. */
  completeProfileCreation(input: Readonly<{
    workspaceId: string;
    commandId: string;
    leaseId: string;
    profileIntentSha256: string;
    binding: AyrshareProfileBinding;
  }>): Promise<'stored' | 'replayed' | 'conflict'>;
  /** Permanently fences automatic retry after an ambiguous provider outcome. */
  markProfileCreationOutcomeUnknown(input: Readonly<{
    workspaceId: string;
    commandId: string;
    leaseId: string;
    profileIntentSha256: string;
  }>): Promise<void>;
}

export interface AyrshareProfileLinkingCommand {
  readonly workspaceId: string;
  readonly commandId: string;
  readonly profileTitle: string;
  readonly redirectUrl: string;
  readonly allowedSocial: readonly AyrshareLinkableSocial[];
}

export interface AyrshareProfileLinkingResult {
  readonly contract: typeof AYRSHARE_PROFILE_LINKING_CONTRACT;
  readonly workspaceId: string;
  readonly commandId: string;
  readonly linkingUrl: string;
  readonly sensitive: true;
  readonly cacheControl: 'private, no-store';
  readonly referrerPolicy: 'no-referrer';
  readonly expiresAt: string;
  readonly profileCreated: boolean;
  readonly profileKeySha256: string;
}

export interface AyrshareProfileLinkingOptions {
  readonly apiKey: string;
  /** Base64-encoded private.key from the Ayrshare Integration Package. */
  readonly privateKeyBase64: string;
  readonly domain: string;
  readonly repository: AyrshareProfileBindingRepository;
  /** Explicit effect boundary. There is deliberately no global-fetch default. */
  readonly fetch: typeof fetch;
  readonly now?: () => Date;
  readonly timeoutMs?: number;
  /** Tests only. Production remains pinned to the official HTTPS origins. */
  readonly allowLocalHttp?: boolean;
  readonly apiOrigin?: string;
  readonly profileOrigin?: string;
}

export class AyrshareProfileLinkingError extends Error {
  constructor(readonly code:
    | 'invalid_configuration'
    | 'invalid_command'
    | 'repository_unavailable'
    | 'provider_rejected'
    | 'provider_unavailable'
    | 'invalid_provider_response'
    | 'profile_binding_conflict'
    | 'profile_creation_in_progress'
    | 'profile_creation_outcome_unknown'
    | 'idempotency_conflict') {
    super(`Ayrshare profile linking failed: ${code}`);
    this.name = 'AyrshareProfileLinkingError';
  }
}

function fail(code: AyrshareProfileLinkingError['code']): never {
  throw new AyrshareProfileLinkingError(code);
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function exactUuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) fail('invalid_command');
  return value;
}

function safeTitle(value: unknown): string {
  if (typeof value !== 'string' || value !== value.trim()
      || [...value].length < 3 || [...value].length > MAX_TITLE_CODE_POINTS
      || /[\u0000-\u001f\u007f<>]/u.test(value)) fail('invalid_command');
  return value;
}

function safeApiKey(value: unknown): string {
  if (typeof value !== 'string' || value.length < 16 || value.length > 500
      || /[\u0000-\u0020\u007f]/u.test(value)) fail('invalid_configuration');
  return value;
}

function privateKey(value: unknown): string {
  if (typeof value !== 'string' || value.length < 80 || value.length > 32_768
      || !/^[A-Za-z0-9+/=]+$/u.test(value)) fail('invalid_configuration');
  let decoded: string;
  try {
    const bytes = Buffer.from(value, 'base64');
    if (bytes.toString('base64') !== value) fail('invalid_configuration');
    decoded = bytes.toString('utf8');
  } catch {
    fail('invalid_configuration');
  }
  if (!PEM_PRIVATE_KEY.test(decoded)) fail('invalid_configuration');
  try {
    const parsed = createPrivateKey(decoded);
    if (parsed.asymmetricKeyType !== 'rsa'
        || (parsed.asymmetricKeyDetails?.modulusLength ?? 0) < 2_048) {
      fail('invalid_configuration');
    }
  } catch {
    fail('invalid_configuration');
  }
  return decoded;
}

function safeDomain(value: unknown): string {
  if (typeof value !== 'string' || value !== value.trim().toLowerCase()
      || value.length > 253 || !SAFE_DOMAIN.test(value)
      || value.split('.').some((label) => label.length < 1 || label.length > 63)) {
    fail('invalid_configuration');
  }
  return value;
}

function safeOrigins(
  apiOrigin: string | undefined,
  profileOrigin: string | undefined,
  allowLocalHttp: boolean,
): Readonly<{ api: string; profile: string }> {
  let api: URL;
  let profile: URL;
  try {
    api = new URL(apiOrigin ?? AYRSHARE_API_ORIGIN);
    profile = new URL(profileOrigin ?? AYRSHARE_PROFILE_ORIGIN);
  } catch {
    fail('invalid_configuration');
  }
  const local = (url: URL): boolean => url.protocol === 'http:'
    && (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1');
  if (api.username || api.password || api.search || api.hash || api.pathname !== '/'
      || profile.username || profile.password || profile.search || profile.hash
      || profile.pathname !== '/') fail('invalid_configuration');
  if (allowLocalHttp) {
    if ((!local(api) && api.origin !== AYRSHARE_API_ORIGIN)
        || (!local(profile) && profile.origin !== AYRSHARE_PROFILE_ORIGIN)) {
      fail('invalid_configuration');
    }
  } else if (api.origin !== AYRSHARE_API_ORIGIN || profile.origin !== AYRSHARE_PROFILE_ORIGIN) {
    fail('invalid_configuration');
  }
  return Object.freeze({ api: api.origin, profile: profile.origin });
}

function safeRedirect(value: unknown, allowLocalHttp: boolean): string {
  if (typeof value !== 'string') fail('invalid_command');
  let url: URL;
  try { url = new URL(value); } catch { fail('invalid_command'); }
  const loopback = url.protocol === 'http:'
    && (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1');
  if ((loopback && !allowLocalHttp)
      || (!loopback && (url.protocol !== 'https:' || url.hostname !== 'hq.propertypredator.com'))
      || url.username || url.password || url.hash
      || url.pathname !== '/portal/social/accounts'
      || [...url.searchParams.keys()].length !== 1
      || url.searchParams.getAll('linked').length !== 1
      || url.searchParams.get('linked') !== '1') fail('invalid_command');
  return url.toString();
}

function safeSocials(value: unknown): readonly AyrshareLinkableSocial[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > AYRSHARE_LINKABLE_SOCIALS.length) {
    fail('invalid_command');
  }
  const allowed = new Set<string>(AYRSHARE_LINKABLE_SOCIALS);
  const socials = value.map((item) => {
    if (typeof item !== 'string' || !allowed.has(item)) fail('invalid_command');
    return item as AyrshareLinkableSocial;
  });
  if (new Set(socials).size !== socials.length) fail('invalid_command');
  return Object.freeze([...socials]);
}

async function boundedJson(response: Response): Promise<Record<string, unknown>> {
  const mediaType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (mediaType !== 'application/json') fail('invalid_provider_response');
  const lengthHeader = response.headers.get('content-length');
  if (lengthHeader !== null
      && (!/^[0-9]{1,10}$/u.test(lengthHeader) || Number(lengthHeader) > MAX_RESPONSE_BYTES)) {
    fail('invalid_provider_response');
  }
  const reader = response.body?.getReader();
  if (!reader) fail('invalid_provider_response');
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      total += item.value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        fail('invalid_provider_response');
      }
      chunks.push(item.value);
    }
  } catch (error) {
    if (error instanceof AyrshareProfileLinkingError) throw error;
    fail('invalid_provider_response');
  }
  if (total < 2) fail('invalid_provider_response');
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { fail('invalid_provider_response'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid_provider_response');
  return value as Record<string, unknown>;
}

function safeBinding(value: unknown, workspaceId: string): AyrshareProfileBinding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('profile_binding_conflict');
  }
  const candidate = value as Partial<AyrshareProfileBinding>;
  let profileTitle: string;
  try { profileTitle = safeTitle(candidate.profileTitle); }
  catch { fail('profile_binding_conflict'); }
  let createdAt: string;
  try { createdAt = new Date(candidate.createdAt as string).toISOString(); }
  catch { fail('profile_binding_conflict'); }
  if (candidate.workspaceId !== workspaceId || typeof candidate.workspaceId !== 'string'
      || !UUID.test(candidate.workspaceId)
      || typeof candidate.refId !== 'string' || !REF_ID.test(candidate.refId)
      || typeof candidate.profileKey !== 'string' || !PROFILE_KEY.test(candidate.profileKey)
      || typeof candidate.profileKeySha256 !== 'string' || !SHA256.test(candidate.profileKeySha256)
      || candidate.profileKeySha256 !== sha256(candidate.profileKey)
      || createdAt !== candidate.createdAt) {
    fail('profile_binding_conflict');
  }
  return Object.freeze({
    workspaceId: candidate.workspaceId, profileTitle,
    refId: candidate.refId, profileKey: candidate.profileKey,
    profileKeySha256: candidate.profileKeySha256, createdAt: candidate.createdAt,
  });
}

function uniqueProviderTitle(displayTitle: string, workspaceId: string): string {
  const suffix = ` [pp-${sha256(workspaceId).slice(0, 32)}]`;
  const available = MAX_TITLE_CODE_POINTS - [...suffix].length;
  return `${[...displayTitle].slice(0, available).join('').trimEnd()}${suffix}`;
}

function exactProviderKeys(
  value: Record<string, unknown>, expected: readonly string[],
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail('invalid_provider_response');
  }
}

function createdProfile(
  value: Record<string, unknown>, profileTitle: string,
): Readonly<{ refId: string; profileKey: string }> {
  exactProviderKeys(value, ['status', 'title', 'refId', 'profileKey', 'messagingActive']);
  if (value.status !== 'success' || value.title !== profileTitle
      || value.messagingActive !== false || typeof value.refId !== 'string'
      || !REF_ID.test(value.refId) || typeof value.profileKey !== 'string'
      || !PROFILE_KEY.test(value.profileKey)) fail('invalid_provider_response');
  return Object.freeze({ refId: value.refId, profileKey: value.profileKey });
}

function exactLinkingUrl(
  value: Record<string, unknown>, profileTitle: string, domain: string, profileOrigin: string,
): string {
  exactProviderKeys(value, ['status', 'title', 'token', 'url', 'emailSent', 'expiresIn']);
  if (value.status !== 'success' || value.title !== profileTitle
      || typeof value.token !== 'string' || !JWT.test(value.token)
      || typeof value.url !== 'string' || value.url.length > 24_000
      || typeof value.emailSent !== 'boolean' || value.expiresIn !== '5m') {
    fail('invalid_provider_response');
  }
  let linkingUrl: URL;
  try { linkingUrl = new URL(value.url); } catch { fail('invalid_provider_response'); }
  const keys = [...linkingUrl.searchParams.keys()];
  if (linkingUrl.origin !== profileOrigin || linkingUrl.pathname !== '/'
      || linkingUrl.username || linkingUrl.password || linkingUrl.hash
      || keys.length !== 2 || keys.some((key) => key !== 'domain' && key !== 'jwt')
      || linkingUrl.searchParams.getAll('domain').length !== 1
      || linkingUrl.searchParams.getAll('jwt').length !== 1
      || linkingUrl.searchParams.get('domain') !== domain
      || linkingUrl.searchParams.get('jwt') !== value.token) fail('invalid_provider_response');
  return linkingUrl.toString();
}

export function createAyrshareProfileLinkingService(options: AyrshareProfileLinkingOptions): Readonly<{
  createLink(command: AyrshareProfileLinkingCommand): Promise<AyrshareProfileLinkingResult>;
}> {
  const apiKey = safeApiKey(options.apiKey);
  const decodedPrivateKey = privateKey(options.privateKeyBase64);
  const domain = safeDomain(options.domain);
  if (!options.repository
      || options.repository.securityContract !== 'workspace_scoped_encrypted_profile_key_v1'
      || typeof options.repository.claimProfileCreation !== 'function'
      || typeof options.repository.completeProfileCreation !== 'function'
      || typeof options.repository.markProfileCreationOutcomeUnknown !== 'function') {
    fail('invalid_configuration');
  }
  const fetchImpl = options.fetch;
  if (typeof fetchImpl !== 'function') fail('invalid_configuration');
  const now = options.now ?? (() => new Date());
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 30_000) {
    fail('invalid_configuration');
  }
  const origins = safeOrigins(options.apiOrigin, options.profileOrigin, options.allowLocalHttp === true);

  const post = async (path: string, body: unknown): Promise<Record<string, unknown>> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    let response: Response;
    try {
      response = await fetchImpl(`${origins.api}${path}`, {
        method: 'POST',
        headers: Object.freeze({
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
          accept: 'application/json',
        }),
        body: JSON.stringify(body),
        redirect: 'error',
        signal: controller.signal,
      });
    } catch {
      clearTimeout(timer);
      fail('provider_unavailable');
    }
    try {
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        fail(response.status >= 500 || response.status === 408
          || response.status === 409 || response.status === 425 || response.status === 429
          ? 'provider_unavailable' : 'provider_rejected');
      }
      return await boundedJson(response);
    } catch (error) {
      if (error instanceof AyrshareProfileLinkingError) throw error;
      if (controller.signal.aborted) fail('provider_unavailable');
      fail('invalid_provider_response');
    } finally {
      clearTimeout(timer);
    }
  };

  return Object.freeze({
    createLink: async (input: AyrshareProfileLinkingCommand): Promise<AyrshareProfileLinkingResult> => {
      const workspaceId = exactUuid(input.workspaceId);
      const commandId = exactUuid(input.commandId);
      const profileTitle = uniqueProviderTitle(safeTitle(input.profileTitle), workspaceId);
      const redirectUrl = safeRedirect(input.redirectUrl, options.allowLocalHttp === true);
      const allowedSocial = safeSocials(input.allowedSocial);
      const providerAllowedSocial = Object.freeze(allowedSocial.map((social) =>
        social === 'x' ? 'twitter' : social));
      const profileRequest = Object.freeze({
        title: profileTitle,
        messagingActive: false,
        hideTopHeader: false,
        topHeader: 'Connect Property Predator social accounts',
        subHeader: 'Choose an owned account to connect to Growth HQ',
        tags: Object.freeze([
          'property-predator', `workspace-sha256:${sha256(workspaceId).slice(0, 32)}`,
        ]),
      });
      const profileIntentSha256 = sha256(JSON.stringify({
        contract: AYRSHARE_PROFILE_LINKING_CONTRACT, workspaceId, profileRequest,
      }));
      let claim: Awaited<ReturnType<AyrshareProfileBindingRepository['claimProfileCreation']>>;
      try {
        claim = await options.repository.claimProfileCreation({
          workspaceId, commandId, profileTitle, profileIntentSha256,
        });
      } catch {
        fail('repository_unavailable');
      }
      if (!claim || typeof claim !== 'object') fail('repository_unavailable');
      if (claim.state === 'in_progress') fail('profile_creation_in_progress');
      if (claim.state === 'outcome_unknown') fail('profile_creation_outcome_unknown');
      if (claim.state === 'conflict') fail('idempotency_conflict');
      let binding: AyrshareProfileBinding;
      let profileCreated = false;
      if (claim.state === 'existing') {
        binding = safeBinding(claim.binding, workspaceId);
        if (binding.profileTitle !== profileTitle) fail('idempotency_conflict');
      } else if (claim.state === 'claimed') {
        if (typeof claim.leaseId !== 'string' || !UUID.test(claim.leaseId)) {
          fail('repository_unavailable');
        }
        const leaseId = claim.leaseId;
        const markUnknown = async (): Promise<never> => {
          try {
            await options.repository.markProfileCreationOutcomeUnknown({
              workspaceId, commandId, leaseId, profileIntentSha256,
            });
          } catch {
            // The public result must remain non-retryable even if the durable fence is unhealthy.
          }
          fail('profile_creation_outcome_unknown');
        };
        let created: Readonly<{ refId: string; profileKey: string }>;
        try {
          created = createdProfile(await post('/api/profiles', profileRequest), profileTitle);
        } catch {
          return markUnknown();
        }
        let observed: Date;
        try { observed = now(); }
        catch { return markUnknown(); }
        if (!(observed instanceof Date) || !Number.isFinite(observed.getTime())) return markUnknown();
        binding = Object.freeze({
          workspaceId,
          profileTitle,
          refId: created.refId,
          profileKey: created.profileKey,
          profileKeySha256: sha256(created.profileKey),
          createdAt: observed.toISOString(),
        });
        let stored: 'stored' | 'replayed' | 'conflict';
        try {
          stored = await options.repository.completeProfileCreation({
            workspaceId, commandId, leaseId, profileIntentSha256, binding,
          });
        } catch {
          return markUnknown();
        }
        if (stored === 'conflict') return markUnknown();
        if (stored !== 'stored' && stored !== 'replayed') return markUnknown();
        profileCreated = stored === 'stored';
      } else {
        fail('repository_unavailable');
      }
      let jwtRequestedAt: Date;
      try { jwtRequestedAt = now(); }
      catch { fail('repository_unavailable'); }
      if (!(jwtRequestedAt instanceof Date) || !Number.isFinite(jwtRequestedAt.getTime())) {
        fail('repository_unavailable');
      }
      const linked = await post('/api/profiles/generateJWT', Object.freeze({
        domain,
        privateKey: decodedPrivateKey,
        profileKey: binding.profileKey,
        redirect: redirectUrl,
        allowedSocial: providerAllowedSocial,
        logout: false,
        verify: false,
        expiresIn: 5,
      }));
      const linkingUrl = exactLinkingUrl(linked, binding.profileTitle, domain, origins.profile);
      const safeResult = {
        contract: AYRSHARE_PROFILE_LINKING_CONTRACT,
        workspaceId,
        commandId,
        linkingUrl,
        sensitive: true as const,
        cacheControl: 'private, no-store' as const,
        referrerPolicy: 'no-referrer' as const,
        expiresAt: new Date(jwtRequestedAt.getTime() + 5 * 60 * 1_000).toISOString(),
        profileCreated,
        profileKeySha256: binding.profileKeySha256,
      };
      return Object.freeze({
        ...safeResult,
        /** JSON logs/responses redact the JWT; portal wiring must use a direct no-store Location redirect. */
        toJSON: () => Object.freeze({ ...safeResult, linkingUrl: '[REDACTED]' }),
      });
    },
  });
}
