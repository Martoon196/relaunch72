import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  AYRSHARE_LIVE_TRANSPORT_SECURITY_CONTRACT,
  AYRSHARE_PUBLIC_SOCIAL_PROVIDER_ID,
  AyrshareHttpAdapter,
  PublicSocialOutboundContractError,
  PublicSocialOutboundDisabledError,
  createAyrshareCredentialBundle,
  createPublicSocialOutboundPlanSha256,
  createPublicSocialProviderNotes,
  createPublicSocialScriptedMediaResolver,
  createPublicSocialScriptedHttpTransport,
  readPublicSocialContractMediaResolutionRequests,
  readPublicSocialContractHttpRequests,
  type AyrshareCredentialBundle,
  type CreateAyrshareCredentialBundleInput,
  type PublicSocialContractMediaResolver,
  type PublicSocialContractHttpTransport,
  type PublicSocialOutboundContext,
  type PublicSocialOutboundDispatchRequest,
  type PublicSocialOutboundMediaEvidence,
  type PublicSocialResolvedMediaEvidence,
  type PublicSocialScriptedHttpStep,
  type PublicSocialScriptedMediaStep,
} from '../src/public-social-outbound/index.js';

const NOW = new Date('2026-08-28T10:00:00.000Z');
const SCHEDULED_FOR = '2026-08-28T11:00:00.000Z';
const VALID_UNTIL = '2026-08-28T12:00:00.000Z';
const TEXT = 'Approved Property Predator proof post.';
const sha = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

const IDS = Object.freeze({
  workspace: '11111111-1111-4111-8111-111111111111',
  connection: '22222222-2222-4222-8222-222222222222',
  profile: '33333333-3333-4333-8333-333333333333',
  operation: '44444444-4444-4444-8444-444444444444',
  correlation: '55555555-5555-4555-8555-555555555555',
  target: '66666666-6666-4666-8666-666666666666',
  approval: '77777777-7777-4777-8777-777777777777',
  contentVersion: '88888888-8888-4888-8888-888888888888',
  proof: '99999999-9999-4999-8999-999999999999',
  attestation: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  artifact: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  mediaVersion: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  other: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
});

const context: PublicSocialOutboundContext = Object.freeze({
  workspaceId: IDS.workspace,
  connectionId: IDS.connection,
  providerId: AYRSHARE_PUBLIC_SOCIAL_PROVIDER_ID,
  operationId: IDS.operation,
  idempotencyKey: 'durable-social-operation-v1',
  correlationId: IDS.correlation,
});

const mediaEvidence: PublicSocialOutboundMediaEvidence = Object.freeze({
  artifactId: IDS.artifact,
  contentVersionId: IDS.mediaVersion,
  contentSha256: 'a'.repeat(64),
  blobStorageKey: 'company/social/approved-card.png',
  blobSha256: 'b'.repeat(64),
  mimeType: 'image/png',
  validUntil: VALID_UNTIL,
});

function buildRequest(
  overrides: Partial<Omit<PublicSocialOutboundDispatchRequest, 'planSha256' | 'providerNotes'>> = {},
): PublicSocialOutboundDispatchRequest {
  const unsigned = Object.freeze({
    targetId: IDS.target,
    profileId: IDS.profile,
    network: 'x' as const,
    networkOptions: Object.freeze({
      kind: 'x_standard_post' as const,
      mediaMode: 'single_image' as const,
      shortenLinks: false as const,
    }),
    operationTag: 'pp-launch-proof-1',
    approvalDecisionId: IDS.approval,
    contentVersionId: IDS.contentVersion,
    contentSha256: sha(TEXT),
    text: TEXT,
    bodySha256: sha(TEXT),
    scheduledFor: SCHEDULED_FOR,
    freshness: Object.freeze({
      proofId: IDS.proof,
      sourceAttestationId: IDS.attestation,
      evidenceSha256: 'c'.repeat(64),
      validUntil: VALID_UNTIL,
    }),
    media: Object.freeze([mediaEvidence]),
    ...overrides,
  });
  const planSha256 = createPublicSocialOutboundPlanSha256(unsigned);
  return Object.freeze({
    ...unsigned,
    planSha256,
    providerNotes: createPublicSocialProviderNotes(unsigned.operationTag, planSha256),
  });
}

function resolvedMedia(overrides: Partial<PublicSocialResolvedMediaEvidence> = {}): PublicSocialResolvedMediaEvidence {
  return Object.freeze({
    ...mediaEvidence,
    downloadUrl: 'https://assets.propertypredator.com/social/approved-card.png?sig=test',
    downloadUrlValidUntil: VALID_UNTIL,
    ...overrides,
  });
}

function mediaResolver(
  step: PublicSocialScriptedMediaStep = Object.freeze({
    kind: 'resolved', media: Object.freeze([resolvedMedia()]),
  }),
): PublicSocialContractMediaResolver {
  return createPublicSocialScriptedMediaResolver([step]);
}

function credentialInput(
  overrides: Partial<CreateAyrshareCredentialBundleInput> = {},
): CreateAyrshareCredentialBundleInput {
  return Object.freeze({
    workspaceId: IDS.workspace,
    connectionId: IDS.connection,
    profileId: IDS.profile,
    credentialVersion: 'version-1',
    apiKey: 'test-primary-api-key',
    profileKey: 'test-profile-key',
    xOAuth1ApiKey: 'test-x-consumer-key',
    xOAuth1ApiSecret: 'test-x-consumer-secret',
    xOAuthLinkEvidenceSha256: 'e'.repeat(64),
    xOAuthLinkedAt: '2026-08-27T09:00:00.000Z',
    xOAuthEvidenceObservedAt: NOW.toISOString(),
    xOAuthPermissions: 'read_write',
    ...overrides,
  });
}

function credentialBundle(profileId = IDS.profile): AyrshareCredentialBundle {
  return createAyrshareCredentialBundle(credentialInput({ profileId }));
}

function setup(
  script: readonly PublicSocialScriptedHttpStep[],
  resolver?: PublicSocialContractMediaResolver,
): Readonly<{
  adapter: AyrshareHttpAdapter;
  transport: PublicSocialContractHttpTransport;
  resolver: PublicSocialContractMediaResolver;
}> {
  const transport = createPublicSocialScriptedHttpTransport(script);
  const effectiveResolver = resolver ?? createPublicSocialScriptedMediaResolver(
    script.map(() => Object.freeze({
      kind: 'resolved' as const,
      media: Object.freeze([resolvedMedia()]),
    })),
  );
  return Object.freeze({
    transport,
    resolver: effectiveResolver,
    adapter: new AyrshareHttpAdapter({
      executionMode: 'contract_test',
      credentials: credentialBundle(),
      http: transport,
      mediaResolver: effectiveResolver,
      timeoutMs: 4_000,
      observedAt: NOW.toISOString(),
    }),
  });
}

function response(body: unknown, status = 200): PublicSocialScriptedHttpStep {
  return Object.freeze({ kind: 'response', status, bodyUtf8: JSON.stringify(body) });
}

function scheduledAcceptance(id = 'ayr-post-123'): PublicSocialScriptedHttpStep {
  return response({
    status: 'scheduled', id, platforms: ['twitter'], scheduleDate: SCHEDULED_FOR,
  });
}

function immediateRequest(): PublicSocialOutboundDispatchRequest {
  return buildRequest({
    networkOptions: Object.freeze({
      kind: 'x_standard_post', mediaMode: 'none', shortenLinks: false,
    }),
    scheduledFor: null,
    media: Object.freeze([]),
  });
}

test('disabled mode touches neither hostile context nor dispatch material', async () => {
  const disabled = new AyrshareHttpAdapter();
  let reads = 0;
  const hostileContext = new Proxy(context, {
    get(target, property, receiver) {
      reads += 1;
      return Reflect.get(target, property, receiver) as unknown;
    },
  });
  const hostileRequest = new Proxy(buildRequest(), {
    get(target, property, receiver) {
      reads += 1;
      return Reflect.get(target, property, receiver) as unknown;
    },
  });
  await assert.rejects(disabled.publish(hostileContext, hostileRequest), PublicSocialOutboundDisabledError);
  assert.equal(reads, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(disabled)), {
    provider: 'ayrshare', executionMode: 'disabled', credentials: '[REDACTED]',
  });
});

test('rich scheduled X dispatch maps exact evidence to the bounded Ayrshare contract', async () => {
  const resolver = mediaResolver();
  const harness = setup([scheduledAcceptance()], resolver);
  const request = buildRequest();
  const result = await harness.adapter.publish(context, request);
  assert.equal(result.status, 'accepted');
  assert.equal(result.externalId, 'ayr-post-123');
  assert.equal(result.reconciliationRequired, false);
  const mediaCalls = readPublicSocialContractMediaResolutionRequests(resolver);
  assert.equal(mediaCalls.length, 1);
  assert.deepEqual(mediaCalls[0]?.media, request.media);
  assert.deepEqual(mediaCalls[0]?.context, context);
  assert.doesNotMatch(JSON.stringify(mediaCalls), /test-primary|test-profile-key|consumer-secret/u);
  const calls = readPublicSocialContractHttpRequests(harness.transport);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    method: 'POST',
    url: 'https://api.ayrshare.com/api/post',
    headers: {
      Authorization: 'Bearer test-primary-api-key',
      'Content-Type': 'application/json',
      'Profile-Key': 'test-profile-key',
      'X-Twitter-OAuth1-Api-Key': 'test-x-consumer-key',
      'X-Twitter-OAuth1-Api-Secret': 'test-x-consumer-secret',
    },
    bodyUtf8: calls[0]?.bodyUtf8,
    timeoutMs: 4_000,
    redirectPolicy: 'error',
    maximumResponseBytes: 65_536,
  });
  const body = JSON.parse(calls[0]!.bodyUtf8!) as Record<string, unknown>;
  assert.equal(body.post, TEXT);
  assert.deepEqual(body.platforms, ['twitter']);
  assert.deepEqual(body.mediaUrls, [resolvedMedia().downloadUrl]);
  assert.equal(body.scheduleDate, SCHEDULED_FOR);
  assert.equal(body.notes, request.providerNotes);
  assert.equal(body.shortenLinks, false);
  assert.match(String(body.idempotencyKey), /^r72-v1-[a-f0-9]{64}$/u);
  assert.doesNotMatch(calls[0]!.bodyUtf8!, /77777777|88888888|company\/social/u);
});

test('immediate acceptance requires exact platform success evidence', async () => {
  const harness = setup([response({
    status: 'success', id: 'ayr-immediate',
    postIds: [{ platform: 'twitter', status: 'success', id: 'twitter-123' }],
  })]);
  const result = await harness.adapter.publish(context, immediateRequest());
  assert.equal(result.status, 'accepted');
  const body = JSON.parse(readPublicSocialContractHttpRequests(harness.transport)[0]!.bodyUtf8!) as Record<string, unknown>;
  assert.equal('mediaUrls' in body, false);
  assert.equal('scheduleDate' in body, false);
});

test('provider idempotency remains stable when operation correlation rotates', async () => {
  const harness = setup([scheduledAcceptance('first'), scheduledAcceptance('second')]);
  await harness.adapter.publish(context, buildRequest());
  await harness.adapter.publish({ ...context, correlationId: IDS.other }, buildRequest());
  const bodies = readPublicSocialContractHttpRequests(harness.transport)
    .map((call) => JSON.parse(call.bodyUtf8!) as Record<string, unknown>);
  assert.equal(bodies[0]?.idempotencyKey, bodies[1]?.idempotencyKey);
});

test('prototype names and unproven networks fail before resolver or transport', async () => {
  const resolver = mediaResolver();
  const harness = setup([scheduledAcceptance()], resolver);
  for (const network of ['toString', 'constructor', '__proto__', 'linkedin']) {
    const invalid = { ...buildRequest(), network } as unknown as PublicSocialOutboundDispatchRequest;
    await assert.rejects(harness.adapter.publish(context, invalid), /not activation-ready/);
  }
  assert.equal(readPublicSocialContractMediaResolutionRequests(resolver).length, 0);
  assert.equal(readPublicSocialContractHttpRequests(harness.transport).length, 0);
});

test('missing, boolean, whitespace and unknown POST statuses never become acceptance', async () => {
  const harness = setup([
    response({ id: 'safe-1', platforms: ['twitter'], scheduleDate: SCHEDULED_FOR }),
    response({ status: true, id: 'safe-2', platforms: ['twitter'], scheduleDate: SCHEDULED_FOR }),
    response({ status: ' scheduled ', id: 'safe-3', platforms: ['twitter'], scheduleDate: SCHEDULED_FOR }),
    response({ status: 'queued', id: 'safe-4', platforms: ['twitter'], scheduleDate: SCHEDULED_FOR }),
  ]);
  for (const id of ['safe-1', 'safe-2', 'safe-3', 'safe-4']) {
    const result = await harness.adapter.publish(context, buildRequest());
    assert.equal(result.status, 'needs_attention');
    assert.equal(result.externalId, id);
    assert.equal(result.recovery.kind, 'exact_post');
  }
});

test('forged contract transport and copied credential bundle fail closed', () => {
  const forged = { kind: 'contract_mock' } as PublicSocialContractHttpTransport;
  assert.throws(() => new AyrshareHttpAdapter({
    executionMode: 'contract_test', credentials: credentialBundle(), http: forged,
    mediaResolver: mediaResolver(), observedAt: NOW.toISOString(),
  }), /authentic pure scripted/);

  let forgedResolverCodeReads = 0;
  const forgedResolver = Object.defineProperty({ kind: 'contract_media_mock' }, 'resolve', {
    enumerable: true,
    get() {
      forgedResolverCodeReads += 1;
      throw new Error('secret-bearing live resolver callback was executed');
    },
  }) as unknown as PublicSocialContractMediaResolver;
  assert.throws(() => new AyrshareHttpAdapter({
    executionMode: 'contract_test', credentials: credentialBundle(),
    http: createPublicSocialScriptedHttpTransport([]),
    mediaResolver: forgedResolver, observedAt: NOW.toISOString(),
  }), /authentic pure scripted media resolver/);
  assert.equal(forgedResolverCodeReads, 0);
  assert.throws(() => createPublicSocialScriptedMediaResolver([{
    kind: 'resolved',
    media: Array<PublicSocialResolvedMediaEvidence>(1),
  }]), /media script step 0 is invalid/);

  const real = credentialBundle();
  const copied = { ...real } as AyrshareCredentialBundle;
  assert.throws(() => new AyrshareHttpAdapter({
    executionMode: 'contract_test', credentials: copied,
    http: createPublicSocialScriptedHttpTransport([]),
    mediaResolver: mediaResolver(), observedAt: NOW.toISOString(),
  }), /not authentic/);
  assert.doesNotMatch(JSON.stringify(real), /test-primary|test-profile-key|consumer-key|consumer-secret/u);

  const incomplete = {
    workspaceId: IDS.workspace,
    connectionId: IDS.connection,
    profileId: IDS.profile,
    credentialVersion: 'version-1',
    apiKey: 'test-primary-api-key',
    profileKey: 'test-profile-key',
    xOAuth1ApiKey: 'test-x-consumer-key',
    xOAuthLinkEvidenceSha256: 'e'.repeat(64),
    xOAuthLinkedAt: '2026-08-27T09:00:00.000Z',
    xOAuthPermissions: 'read_write',
  };
  assert.throws(() => createAyrshareCredentialBundle(
    incomplete as unknown as Parameters<typeof createAyrshareCredentialBundle>[0],
  ), /unexpected fields/);

  assert.throws(() => createAyrshareCredentialBundle(credentialInput({
    xOAuthLinkedAt: '2026-08-29T10:00:00.000Z',
  })), /evidence observation is invalid/);
});

test('scripted resolver errors and evidence drift return one fixed safe failure before HTTP', async () => {
  const throwing = setup([scheduledAcceptance()], mediaResolver({
    kind: 'resolution_error', code: 'storage_unavailable',
  }));
  const thrownResult = await throwing.adapter.publish(context, buildRequest());
  assert.deepEqual({
    status: thrownResult.status,
    externalId: thrownResult.externalId,
    errorCode: thrownResult.errorCode,
    summary: thrownResult.summary,
  }, {
    status: 'failed',
    externalId: null,
    errorCode: 'ayrshare_media_resolution_failed',
    summary: 'Approved company media could not be resolved to exact fresh evidence',
  });
  assert.doesNotMatch(JSON.stringify(thrownResult), /storage_unavailable|script_exhausted/u);
  assert.equal(readPublicSocialContractHttpRequests(throwing.transport).length, 0);

  const drifted = setup([scheduledAcceptance()], mediaResolver({
    kind: 'resolved',
    media: [resolvedMedia({ blobSha256: 'd'.repeat(64) })],
  }));
  assert.equal((await drifted.adapter.publish(context, buildRequest())).errorCode,
    'ayrshare_media_resolution_failed');
  assert.equal(readPublicSocialContractHttpRequests(drifted.transport).length, 0);
});

test('approval, body, media and provider-note tampering fail before any effect seam', async () => {
  const resolver = mediaResolver();
  const harness = setup([scheduledAcceptance()], resolver);
  const request = buildRequest();
  const variants: PublicSocialOutboundDispatchRequest[] = [
    { ...request, approvalDecisionId: IDS.other },
    { ...request, text: `${request.text} tampered` },
    { ...request, media: [{ ...request.media[0]!, blobSha256: 'd'.repeat(64) }] },
    { ...request, providerNotes: `${request.providerNotes}-tampered` },
  ];
  for (const variant of variants) {
    await assert.rejects(harness.adapter.publish(context, variant), PublicSocialOutboundContractError);
  }
  assert.equal(readPublicSocialContractMediaResolutionRequests(resolver).length, 0);
  assert.equal(readPublicSocialContractHttpRequests(harness.transport).length, 0);
});

test('workspace, connection and profile swaps fail before resolution or HTTP', async () => {
  const resolver = mediaResolver();
  const harness = setup([scheduledAcceptance()], resolver);
  await assert.rejects(harness.adapter.publish(
    { ...context, workspaceId: IDS.other }, buildRequest(),
  ), /workspace connection/);
  await assert.rejects(harness.adapter.publish(
    { ...context, connectionId: IDS.other }, buildRequest(),
  ), /workspace connection/);
  await assert.rejects(harness.adapter.publish(
    context, buildRequest({ profileId: IDS.other }),
  ), /target profile/);
  assert.equal(readPublicSocialContractMediaResolutionRequests(resolver).length, 0);
  assert.equal(readPublicSocialContractHttpRequests(harness.transport).length, 0);
});

test('ambiguous HTTP preserves a safe provider ID and never retries blindly', async () => {
  const harness = setup([response({ id: 'known-post', secret: 'do-not-log' }, 503)]);
  const result = await harness.adapter.publish(context, buildRequest());
  assert.equal(result.status, 'needs_attention');
  assert.equal(result.externalId, 'known-post');
  assert.equal(result.retryable, false);
  assert.equal(result.recovery.kind, 'exact_post');
  assert.doesNotMatch(JSON.stringify(result), /do-not-log/u);
});

test('unknown POST is recovered by one exact history match without a second publish', async () => {
  const request = buildRequest();
  const harness = setup([
    { kind: 'transport_error', code: 'connection_reset' },
    response({
      history: [{
        id: 'history-proof-1', status: 'success', platforms: ['twitter'],
        post: request.text, notes: request.providerNotes, scheduleDate: request.scheduledFor,
      }],
    }),
  ]);
  const ambiguous = await harness.adapter.publish(context, request);
  assert.equal(ambiguous.recovery.kind, 'history_lookup');
  const recovered = await harness.adapter.recoverUnknown(context, request);
  assert.equal(recovered.status, 'succeeded');
  assert.equal(recovered.externalId, 'history-proof-1');
  const calls = readPublicSocialContractHttpRequests(harness.transport);
  assert.deepEqual(calls.map((call) => `${call.method} ${call.url}`), [
    'POST https://api.ayrshare.com/api/post',
    'GET https://api.ayrshare.com/api/history?limit=25&platforms=twitter',
  ]);
  for (const call of calls) {
    assert.equal(call.headers['X-Twitter-OAuth1-Api-Key'], 'test-x-consumer-key');
    assert.equal(call.headers['X-Twitter-OAuth1-Api-Secret'], 'test-x-consumer-secret');
  }
});

test('history recovery refuses zero, duplicate or wrong-note matches', async () => {
  const request = buildRequest();
  const matching = {
    id: 'one', status: 'scheduled', platforms: ['twitter'], post: request.text,
    notes: request.providerNotes, scheduleDate: request.scheduledFor,
  };
  const harness = setup([
    response({ history: [{ ...matching, notes: 'wrong' }] }),
    response({ history: [matching, { ...matching, id: 'two' }] }),
  ]);
  assert.equal((await harness.adapter.recoverUnknown(context, request)).errorCode,
    'ayrshare_history_match_not_found');
  assert.equal((await harness.adapter.recoverUnknown(context, request)).errorCode,
    'ayrshare_history_match_not_unique');
});

test('exact reconciliation binds ID, platform, body, schedule and plan-bound notes', async () => {
  const request = buildRequest();
  const base = {
    id: 'post-123', status: 'success', platforms: ['twitter'], post: request.text,
    notes: request.providerNotes, scheduleDate: request.scheduledFor,
  };
  const harness = setup([
    response(base),
    response({ ...base, platforms: ['linkedin'] }),
    response({ ...base, notes: 'wrong' }),
    response({ ...base, status: ' success ' }),
  ]);
  const expectation = Object.freeze({
    profileId: request.profileId,
    externalId: 'post-123',
    network: request.network,
    text: request.text,
    bodySha256: request.bodySha256,
    planSha256: request.planSha256,
    operationTag: request.operationTag,
    providerNotes: request.providerNotes,
    scheduledFor: request.scheduledFor,
  });
  assert.equal((await harness.adapter.reconcile(context, expectation)).status, 'succeeded');
  assert.equal((await harness.adapter.reconcile(context, expectation)).errorCode,
    'ayrshare_unbound_reconciliation_evidence');
  assert.equal((await harness.adapter.reconcile(context, expectation)).errorCode,
    'ayrshare_unbound_reconciliation_evidence');
  assert.equal((await harness.adapter.reconcile(context, expectation)).errorCode,
    'ayrshare_unknown_post_status');
  assert.equal(readPublicSocialContractHttpRequests(harness.transport)[0]?.url,
    'https://api.ayrshare.com/api/post/post-123');
  for (const call of readPublicSocialContractHttpRequests(harness.transport)) {
    assert.equal(call.headers['X-Twitter-OAuth1-Api-Key'], 'test-x-consumer-key');
    assert.equal(call.headers['X-Twitter-OAuth1-Api-Secret'], 'test-x-consumer-secret');
  }
});

test('past schedules, evidence expiry and signed URL expiry are fenced before POST', async () => {
  const harness = setup([scheduledAcceptance(), scheduledAcceptance(), scheduledAcceptance()]);
  const past = buildRequest({ scheduledFor: '2026-08-28T09:59:59.000Z' });
  await assert.rejects(harness.adapter.publish(context, past), /activation-ready window/);

  const shortEvidence = buildRequest({
    media: Object.freeze([{ ...mediaEvidence, validUntil: '2026-08-28T11:14:59.000Z' }]),
  });
  await assert.rejects(harness.adapter.publish(context, shortEvidence), /provider fetch fencing/);

  const expiringResolver = mediaResolver({
    kind: 'resolved',
    media: [resolvedMedia({ downloadUrlValidUntil: '2026-08-28T11:14:59.000Z' })],
  });
  const expiring = setup([scheduledAcceptance()], expiringResolver);
  assert.equal((await expiring.adapter.publish(context, buildRequest())).errorCode,
    'ayrshare_media_resolution_failed');
  assert.equal(readPublicSocialContractHttpRequests(harness.transport).length, 0);
  assert.equal(readPublicSocialContractHttpRequests(expiring.transport).length, 0);
});

test('network-specific unsupported options and media cardinality are blocked', async () => {
  const resolver = mediaResolver();
  const harness = setup([scheduledAcceptance()], resolver);
  const invalidOptions = [
    { kind: 'x_standard_post', mediaMode: 'single_image', shortenLinks: true },
    { kind: 'x_thread', mediaMode: 'single_image', shortenLinks: false },
    { kind: 'x_standard_post', mediaMode: 'none', shortenLinks: false },
  ];
  for (const options of invalidOptions) {
    const unsigned = buildRequest();
    const invalid = {
      ...unsigned,
      networkOptions: options,
    } as unknown as PublicSocialOutboundDispatchRequest;
    await assert.rejects(harness.adapter.publish(context, invalid), PublicSocialOutboundContractError);
  }
  for (const text of [
    'Unicode emoji 🚀 is not in the proven v1 seam',
    'Visit https://example.com',
    'Visit www.example.com',
    'Visit example.com/path',
    'Visit //example/path',
    'Use ftp:example',
    'Open 192.168.1.1',
  ]) {
    const invalid = buildRequest({ text, bodySha256: sha(text), contentSha256: sha(text) });
    await assert.rejects(harness.adapter.publish(context, invalid), /proven X text-post contract/);
  }
  const webp = buildRequest({
    media: Object.freeze([{
      ...mediaEvidence,
      mimeType: 'image/webp' as unknown as 'image/png',
    }]),
  });
  await assert.rejects(harness.adapter.publish(context, webp), /mimeType is not supported/);
  assert.equal(readPublicSocialContractMediaResolutionRequests(resolver).length, 0);
  assert.equal(readPublicSocialContractHttpRequests(harness.transport).length, 0);
});

test('foundation is dark and publishes only a non-executable live transport security contract', async () => {
  const source = (await Promise.all([
    'contracts.ts', 'ayrshare-http-adapter.ts', 'index.ts',
  ].map((name) => readFile(
    new URL(`../src/public-social-outbound/${name}`, import.meta.url), 'utf8',
  )))).join('\n');
  assert.doesNotMatch(source, /process\.env|globalThis\.fetch|\bfetch\s*\(|node:(?:http|https|net|tls|dgram)/u);
  assert.doesNotMatch(source, /executionMode:\s*'live'|readonly kind:\s*'live'/u);
  assert.doesNotMatch(source, /SocialPublishingProvider|SocialPublishRequest/u);
  assert.doesNotMatch(source, /mediaResolver\.resolve|interface PublicSocialMediaResolver|readonly now\?:\s*\(\)/u);
  assert.equal(AYRSHARE_LIVE_TRANSPORT_SECURITY_CONTRACT.origin, 'https://api.ayrshare.com');
  assert.equal(AYRSHARE_LIVE_TRANSPORT_SECURITY_CONTRACT.redirectPolicy, 'error');
  assert.equal(AYRSHARE_LIVE_TRANSPORT_SECURITY_CONTRACT.responseMode, 'bounded_stream');
  assert.equal(AYRSHARE_LIVE_TRANSPORT_SECURITY_CONTRACT.maximumResponseBytes, 65_536);
  assert.equal(AYRSHARE_LIVE_TRANSPORT_SECURITY_CONTRACT.abortSignalRequired, true);
  assert.deepEqual(AYRSHARE_LIVE_TRANSPORT_SECURITY_CONTRACT.xByoOAuth1Headers, [
    'X-Twitter-OAuth1-Api-Key', 'X-Twitter-OAuth1-Api-Secret',
  ]);
  assert.equal(AYRSHARE_LIVE_TRANSPORT_SECURITY_CONTRACT.xByoLinkedAccountEvidenceRequired, true);
});
