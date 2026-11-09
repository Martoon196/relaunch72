import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import {
  AyrshareProfileLinkingError,
  createAyrshareProfileLinkingService,
  type AyrshareProfileBinding,
  type AyrshareProfileBindingRepository,
} from '../src/public-social-outbound/ayrshare-profile-linking.js';

const WORKSPACE_ID = '72000000-0000-4000-8000-000000000001';
const COMMAND_ID = '72000000-0000-4000-8000-000000000002';
const PROFILE_KEY = '7TVRLEZ-24A43C0-NJW0Z82-F11984N';
const PROFILE_TITLE = 'Property Predator Growth HQ';
const WORKSPACE_HASH = createHash('sha256').update(WORKSPACE_ID).digest('hex');
const PROVIDER_PROFILE_TITLE = `${PROFILE_TITLE} [pp-${WORKSPACE_HASH.slice(0, 32)}]`;
const JWT_TOKEN = `${'a'.repeat(32)}.${'b'.repeat(48)}.${'c'.repeat(64)}`;
const PRIVATE_KEY = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
  type: 'pkcs8', format: 'pem',
}).toString();
const LEASE_ID = '72000000-0000-4000-8000-000000000003';

class MemoryBindings implements AyrshareProfileBindingRepository {
  readonly securityContract = 'workspace_scoped_encrypted_profile_key_v1' as const;
  value: AyrshareProfileBinding | null = null;
  state: 'idle' | 'claimed' | 'outcome_unknown' = 'idle';
  intentSha256: string | null = null;
  commandId: string | null = null;

  async claimProfileCreation(input: Readonly<{
    workspaceId: string; commandId: string; profileTitle: string; profileIntentSha256: string;
  }>): Promise<
    | Readonly<{ state: 'existing'; binding: AyrshareProfileBinding }>
    | Readonly<{ state: 'claimed'; leaseId: string }>
    | Readonly<{ state: 'in_progress' | 'outcome_unknown' | 'conflict' }>
  > {
    if (this.value) return this.value.workspaceId === input.workspaceId
      && this.value.profileTitle === input.profileTitle
      ? { state: 'existing', binding: this.value } : { state: 'conflict' };
    if (this.state === 'outcome_unknown') return { state: 'outcome_unknown' };
    if (this.state === 'claimed') return this.intentSha256 === input.profileIntentSha256
      ? { state: 'in_progress' } : { state: 'conflict' };
    this.state = 'claimed';
    this.intentSha256 = input.profileIntentSha256;
    this.commandId = input.commandId;
    return { state: 'claimed', leaseId: LEASE_ID };
  }

  async completeProfileCreation(input: Readonly<{
    workspaceId: string; commandId: string; leaseId: string; profileIntentSha256: string;
    binding: AyrshareProfileBinding;
  }>): Promise<'stored' | 'replayed' | 'conflict'> {
    if (this.value) return JSON.stringify(this.value) === JSON.stringify(input.binding) ? 'replayed' : 'conflict';
    if (this.state !== 'claimed' || input.leaseId !== LEASE_ID
        || input.profileIntentSha256 !== this.intentSha256 || input.commandId !== this.commandId) return 'conflict';
    this.value = Object.freeze({ ...input.binding });
    this.state = 'idle';
    return 'stored';
  }

  async markProfileCreationOutcomeUnknown(input: Readonly<{
    workspaceId: string; commandId: string; leaseId: string; profileIntentSha256: string;
  }>): Promise<void> {
    assert.equal(input.leaseId, LEASE_ID);
    this.state = 'outcome_unknown';
  }
}

function command() {
  return Object.freeze({
    workspaceId: WORKSPACE_ID,
    commandId: COMMAND_ID,
    profileTitle: PROFILE_TITLE,
    redirectUrl: 'https://hq.propertypredator.com/portal/social/accounts?linked=1',
    allowedSocial: Object.freeze(['facebook', 'instagram', 'linkedin', 'x'] as const),
  });
}

function jwtSuccess(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    status: 'success', title: PROVIDER_PROFILE_TITLE, token: JWT_TOKEN,
    url: `https://profile.ayrshare.com/?domain=hq.propertypredator.com&jwt=${JWT_TOKEN}`,
    emailSent: false, expiresIn: '5m', ...overrides,
  };
}

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

test('creates and stores one profile before issuing a five-minute owned linking URL', async () => {
  const repository = new MemoryBindings();
  const calls: Array<{ url: string; init: RequestInit; body: Record<string, unknown> }> = [];
  const fetchImpl: typeof fetch = async (input, init = {}) => {
    const url = String(input);
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    calls.push({ url, init, body });
    if (url.endsWith('/api/profiles')) {
      return response({ status: 'success', title: PROVIDER_PROFILE_TITLE, refId: 'profile_ref_12345',
        profileKey: PROFILE_KEY, messagingActive: false });
    }
    assert.equal(repository.value?.profileKey, PROFILE_KEY,
      'the one-time Profile Key must be durably completed before JWT generation');
    return response(jwtSuccess());
  };
  const service = createAyrshareProfileLinkingService({
    apiKey: 'ayrshare-test-api-key-value',
    privateKeyBase64: Buffer.from(PRIVATE_KEY, 'utf8').toString('base64'),
    domain: 'hq.propertypredator.com',
    repository,
    fetch: fetchImpl,
    now: () => new Date('2026-08-28T18:00:00.000Z'),
  });

  const result = await service.createLink(command());
  assert.equal(result.profileCreated, true);
  assert.equal(result.expiresAt, '2026-08-28T18:05:00.000Z');
  assert.match(result.profileKeySha256, /^[0-9a-f]{64}$/u);
  assert.equal('profileKey' in result, false);
  assert.equal(JSON.stringify(result).includes(PROFILE_KEY), false);
  assert.equal(JSON.stringify(result).includes(JWT_TOKEN), false);
  assert.equal(JSON.stringify(result).includes(PRIVATE_KEY), false);
  assert.equal(JSON.stringify(result).includes('ayrshare-test-api-key-value'), false);
  assert.equal(result.linkingUrl.includes(JWT_TOKEN), true);
  assert.equal(result.cacheControl, 'private, no-store');
  assert.equal(result.referrerPolicy, 'no-referrer');
  assert.equal(repository.value?.profileKey, PROFILE_KEY);
  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.url, 'https://api.ayrshare.com/api/profiles');
  assert.equal(calls[0]?.body.title, PROVIDER_PROFILE_TITLE);
  assert.deepEqual(calls[0]?.body.tags, ['property-predator',
    `workspace-sha256:${WORKSPACE_HASH.slice(0, 32)}`]);
  assert.equal(calls[1]?.url, 'https://api.ayrshare.com/api/profiles/generateJWT');
  assert.equal(calls[1]?.body.profileKey, PROFILE_KEY);
  assert.equal(calls[1]?.body.privateKey, PRIVATE_KEY);
  assert.deepEqual(calls[1]?.body.allowedSocial, ['facebook', 'instagram', 'linkedin', 'twitter']);
  assert.equal(calls[1]?.body.expiresIn, 5);
  assert.equal(calls.every((call) => !call.url.includes(PROFILE_KEY)), true);
  const headers = calls[0]?.init.headers as Record<string, string>;
  assert.equal(headers.authorization, 'Bearer ayrshare-test-api-key-value');
});

test('reuses the encrypted repository binding and never creates a second profile', async () => {
  const repository = new MemoryBindings();
  repository.value = Object.freeze({
    workspaceId: WORKSPACE_ID,
    profileTitle: PROVIDER_PROFILE_TITLE,
    refId: 'profile_ref_12345',
    profileKey: PROFILE_KEY,
    profileKeySha256: 'ce3710cf81bfdecec4739de66bc192056bbeb37e38711468240d845b3db74f6c',
    createdAt: '2026-08-28T17:00:00.000Z',
  });
  const urls: string[] = [];
  const service = createAyrshareProfileLinkingService({
    apiKey: 'ayrshare-test-api-key-value',
    privateKeyBase64: Buffer.from(PRIVATE_KEY, 'utf8').toString('base64'),
    domain: 'hq.propertypredator.com',
    repository,
    fetch: async (input) => {
      urls.push(String(input));
      return response(jwtSuccess());
    },
    now: () => new Date('2026-08-28T18:00:00.000Z'),
  });

  const result = await service.createLink(command());
  assert.equal(result.profileCreated, false);
  assert.deepEqual(urls, ['https://api.ayrshare.com/api/profiles/generateJWT']);
});

test('fails closed on untrusted redirects, duplicate networks and provider link origins', async () => {
  const make = (fetchImpl: typeof fetch) => createAyrshareProfileLinkingService({
    apiKey: 'ayrshare-test-api-key-value',
    privateKeyBase64: Buffer.from(PRIVATE_KEY, 'utf8').toString('base64'),
    domain: 'hq.propertypredator.com',
    repository: new MemoryBindings(),
    fetch: fetchImpl,
  });

  await assert.rejects(
    () => make(async () => response({})).createLink({
      ...command(), redirectUrl: 'https://evil.test/portal/social/accounts',
    }),
    (error: unknown) => error instanceof AyrshareProfileLinkingError
      && error.code === 'invalid_command',
  );
  await assert.rejects(
    () => make(async () => response({})).createLink({
      ...command(), redirectUrl: 'http://localhost/portal/social/accounts?linked=1',
    }),
    (error: unknown) => error instanceof AyrshareProfileLinkingError
      && error.code === 'invalid_command',
  );
  await assert.rejects(
    () => make(async () => response({})).createLink({
      ...command(),
      redirectUrl: 'https://hq.propertypredator.com/portal/social/accounts?linked=1&jwt=secret',
    }),
    (error: unknown) => error instanceof AyrshareProfileLinkingError
      && error.code === 'invalid_command',
  );
  await assert.rejects(
    () => make(async () => response({})).createLink({
      ...command(), allowedSocial: ['facebook', 'facebook'],
    }),
    (error: unknown) => error instanceof AyrshareProfileLinkingError
      && error.code === 'invalid_command',
  );

  let call = 0;
  await assert.rejects(
    () => make(async () => {
      call += 1;
      return call === 1
        ? response({ status: 'success', title: PROVIDER_PROFILE_TITLE, refId: 'profile_ref_12345',
          profileKey: PROFILE_KEY, messagingActive: false })
        : response(jwtSuccess({ url: `https://evil.test/?domain=hq.propertypredator.com&jwt=${JWT_TOKEN}` }));
    }).createLink(command()),
    (error: unknown) => error instanceof AyrshareProfileLinkingError
      && error.code === 'invalid_provider_response',
  );
});

test('does not leak provider response bodies or secrets through errors', async () => {
  const service = createAyrshareProfileLinkingService({
    apiKey: 'ayrshare-test-api-key-value',
    privateKeyBase64: Buffer.from(PRIVATE_KEY, 'utf8').toString('base64'),
    domain: 'hq.propertypredator.com',
    repository: new MemoryBindings(),
    fetch: async () => response({ secret: 'provider-secret-body' }, 401),
  });
  await assert.rejects(
    () => service.createLink(command()),
    (error: unknown) => error instanceof AyrshareProfileLinkingError
      && error.code === 'profile_creation_outcome_unknown'
      && !error.message.includes('provider-secret-body')
      && !error.message.includes('ayrshare-test-api-key-value'),
  );
});

test('atomically fences concurrent Create Profile calls for one workspace', async () => {
  const repository = new MemoryBindings();
  let releaseCreate!: () => void;
  let markCreateStarted!: () => void;
  const createGate = new Promise<void>((resolve) => { releaseCreate = resolve; });
  const createStarted = new Promise<void>((resolve) => { markCreateStarted = resolve; });
  let createCalls = 0;
  const service = createAyrshareProfileLinkingService({
    apiKey: 'ayrshare-test-api-key-value',
    privateKeyBase64: Buffer.from(PRIVATE_KEY, 'utf8').toString('base64'),
    domain: 'hq.propertypredator.com',
    repository,
    fetch: async (input) => {
      if (String(input).endsWith('/api/profiles')) {
        createCalls += 1;
        markCreateStarted();
        await createGate;
        return response({ status: 'success', title: PROVIDER_PROFILE_TITLE,
          refId: 'profile_ref_12345', profileKey: PROFILE_KEY, messagingActive: false });
      }
      return response(jwtSuccess());
    },
    now: () => new Date('2026-08-28T18:00:00.000Z'),
  });

  const first = service.createLink(command());
  await createStarted;
  try {
    await assert.rejects(
      () => service.createLink({ ...command(), commandId: '72000000-0000-4000-8000-000000000004' }),
      (error: unknown) => error instanceof AyrshareProfileLinkingError
        && error.code === 'profile_creation_in_progress',
    );
    assert.equal(createCalls, 1);
  } finally {
    releaseCreate();
  }
  await first;
  assert.equal(createCalls, 1);
});

test('permanently fences automatic retry after an ambiguous Create Profile outcome', async () => {
  const repository = new MemoryBindings();
  let calls = 0;
  const service = createAyrshareProfileLinkingService({
    apiKey: 'ayrshare-test-api-key-value',
    privateKeyBase64: Buffer.from(PRIVATE_KEY, 'utf8').toString('base64'),
    domain: 'hq.propertypredator.com',
    repository,
    fetch: async () => {
      calls += 1;
      return response({ status: 'error' }, 503);
    },
  });

  await assert.rejects(
    () => service.createLink(command()),
    (error: unknown) => error instanceof AyrshareProfileLinkingError
      && error.code === 'profile_creation_outcome_unknown',
  );
  await assert.rejects(
    () => service.createLink(command()),
    (error: unknown) => error instanceof AyrshareProfileLinkingError
      && error.code === 'profile_creation_outcome_unknown',
  );
  assert.equal(calls, 1, 'an unknown Create Profile outcome must never be automatically repeated');
});

test('rejects non-exact Generate JWT responses and tenant-crossed bindings', async () => {
  const binding = Object.freeze({
    workspaceId: WORKSPACE_ID,
    profileTitle: PROVIDER_PROFILE_TITLE,
    refId: 'profile_ref_12345',
    profileKey: PROFILE_KEY,
    profileKeySha256: 'ce3710cf81bfdecec4739de66bc192056bbeb37e38711468240d845b3db74f6c',
    createdAt: '2026-08-28T17:00:00.000Z',
  });
  const invalidResponses = [
    jwtSuccess({ unexpected: true }),
    jwtSuccess({ token: `${'d'.repeat(32)}.${'e'.repeat(48)}.${'f'.repeat(64)}` }),
    jwtSuccess({ url: `https://profile.ayrshare.com/?domain=hq.propertypredator.com&jwt=${JWT_TOKEN}&jwt=${JWT_TOKEN}` }),
  ];
  for (const providerResponse of invalidResponses) {
    const repository = new MemoryBindings();
    repository.value = binding;
    const service = createAyrshareProfileLinkingService({
      apiKey: 'ayrshare-test-api-key-value',
      privateKeyBase64: Buffer.from(PRIVATE_KEY, 'utf8').toString('base64'),
      domain: 'hq.propertypredator.com',
      repository,
      fetch: async () => response(providerResponse),
    });
    await assert.rejects(
      () => service.createLink(command()),
      (error: unknown) => error instanceof AyrshareProfileLinkingError
        && error.code === 'invalid_provider_response',
    );
  }

  const crossedRepository = new MemoryBindings();
  crossedRepository.value = Object.freeze({ ...binding,
    workspaceId: '72000000-0000-4000-8000-000000000099' });
  let providerCalled = false;
  const crossedService = createAyrshareProfileLinkingService({
    apiKey: 'ayrshare-test-api-key-value',
    privateKeyBase64: Buffer.from(PRIVATE_KEY, 'utf8').toString('base64'),
    domain: 'hq.propertypredator.com',
    repository: crossedRepository,
    fetch: async () => {
      providerCalled = true;
      return response(jwtSuccess());
    },
  });
  await assert.rejects(
    () => crossedService.createLink(command()),
    (error: unknown) => error instanceof AyrshareProfileLinkingError
      && (error.code === 'profile_binding_conflict' || error.code === 'idempotency_conflict'),
  );
  assert.equal(providerCalled, false);
});
