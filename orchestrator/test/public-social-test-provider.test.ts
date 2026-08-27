import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  DeterministicPublicSocialTestProvider,
  SocialCampaignPgContractError,
  type PublicSocialTestProviderContext,
  type PublicSocialTestProviderRequest,
} from '../src/social-campaign-pg/index.js';

const NOW = new Date('2026-08-27T12:00:00.000Z');
const context: PublicSocialTestProviderContext = Object.freeze({
  workspaceId: '11111111-1111-4111-8111-111111111111',
  connectionId: '22222222-2222-4222-8222-222222222222',
  operationId: '33333333-3333-4333-8333-333333333333',
  correlationId: '44444444-4444-4444-8444-444444444444',
  idempotencyKey: 'public-social-test-operation-1',
});
const text = 'A fictional, non-routable Property Predator TEST post.';
const request: PublicSocialTestProviderRequest = Object.freeze({
  targetId: '55555555-5555-4555-8555-555555555555',
  network: 'facebook',
  testAccountRef: 'test-account:facebook:property-predator',
  text,
  bodySha256: createHash('sha256').update(text, 'utf8').digest('hex'),
  planSha256: 'a'.repeat(64),
  contentVersionId: '66666666-6666-4666-8666-666666666666',
  contentSha256: 'b'.repeat(64),
  media: Object.freeze([Object.freeze({
    contentVersionId: '77777777-7777-4777-8777-777777777777',
    contentSha256: 'c'.repeat(64),
    blobStorageKey: 'test-assets/property-predator/social-card.png',
    blobSha256: 'd'.repeat(64),
    mimeType: 'image/png',
  })]),
});

test('TEST provider is deterministic, non-routable and keeps only digest audit evidence', async () => {
  const provider = new DeterministicPublicSocialTestProvider({ now: () => NOW, auditCapacity: 16 });
  const first = await provider.simulate(context, request);
  const replay = await provider.simulate(context, request);
  assert.equal(first.status, 'succeeded');
  assert.equal(first.testReference, replay.testReference);
  assert.match(first.testReference ?? '', /^social_test_ref_[a-f0-9]{32}$/);
  assert.equal(first.occurredAt, NOW.toISOString());
  assert.equal(first.externalPublishAttempted, false);
  assert.equal(provider.audit.length, 2);
  assert.ok(provider.audit.every((entry) => entry.externalPublishAttempted === false));
  assert.doesNotMatch(JSON.stringify(provider.audit), /Property Predator TEST post|test-account:/);
  assert.equal(provider.audit[0]?.bodySha256, request.bodySha256);
  assert.equal(provider.audit[0]?.accountSha256,
    createHash('sha256').update(request.testAccountRef, 'utf8').digest('hex'));
  const reconciled = await provider.reconcile(context, first.testReference!);
  assert.equal(reconciled.testReference, first.testReference);
  assert.equal(provider.audit[2]?.mode, 'reconcile');
  const recoveredWithoutReference = await provider.reconcile(context, null);
  assert.equal(recoveredWithoutReference.testReference, first.testReference);
  assert.equal(provider.audit[3]?.mode, 'reconcile');
});

test('TEST provider rejects routable/mismatched accounts, changed bytes and forged reconciliation', async () => {
  const provider = new DeterministicPublicSocialTestProvider({ now: () => NOW, auditCapacity: 16 });
  await assert.rejects(provider.simulate(context, {
    ...request, testAccountRef: 'facebook:real-account',
  }), SocialCampaignPgContractError);
  await assert.rejects(provider.simulate(context, {
    ...request, network: 'instagram',
  }), /network-bound/);
  await assert.rejects(provider.simulate(context, {
    ...request, text: `${request.text} changed`,
  }), /does not match text/);
  await assert.rejects(provider.reconcile(
    context, 'social_test_ref_00000000000000000000000000000000',
  ), /reference is invalid/);
  assert.equal(provider.audit.length, 0);
});

test('TEST provider audit capture is opt-in and remains a bounded ring', async () => {
  const productionDefault = new DeterministicPublicSocialTestProvider({ now: () => NOW });
  await productionDefault.simulate(context, request);
  assert.equal(productionDefault.audit.length, 0);

  const bounded = new DeterministicPublicSocialTestProvider({
    now: () => NOW,
    auditCapacity: 2,
  });
  const simulated = await bounded.simulate(context, request);
  await bounded.reconcile(context, simulated.testReference);
  await bounded.reconcile(context, null);
  assert.equal(bounded.audit.length, 2);
  assert.deepEqual(bounded.audit.map((entry) => entry.mode), ['reconcile', 'reconcile']);
});

test('TEST provider snapshots hostile getters once before hashing and simulation', async () => {
  const reads = new Map<string, number>();
  const once = <T>(name: string, first: T, later: T): T => {
    const count = (reads.get(name) ?? 0) + 1;
    reads.set(name, count);
    return count === 1 ? first : later;
  };
  const hostile = Object.defineProperties({}, {
    targetId: { enumerable: true, get: () => once('targetId', request.targetId, context.workspaceId) },
    network: { enumerable: true, get: () => once('network', request.network, 'instagram') },
    testAccountRef: {
      enumerable: true,
      get: () => once('testAccountRef', request.testAccountRef, 'test-account:instagram:victim'),
    },
    text: { enumerable: true, get: () => once('text', request.text, 'changed') },
    bodySha256: { enumerable: true, get: () => once('bodySha256', request.bodySha256, 'd'.repeat(64)) },
    planSha256: { enumerable: true, get: () => once('planSha256', request.planSha256, 'd'.repeat(64)) },
    contentVersionId: {
      enumerable: true,
      get: () => once('contentVersionId', request.contentVersionId, context.workspaceId),
    },
    contentSha256: { enumerable: true, get: () => once('contentSha256', request.contentSha256, 'd'.repeat(64)) },
    media: { enumerable: true, get: () => once('media', request.media, []) },
  }) as PublicSocialTestProviderRequest;
  const result = await new DeterministicPublicSocialTestProvider({ now: () => NOW })
    .simulate(context, hostile);
  assert.equal(result.status, 'succeeded');
  for (const [field, count] of reads) assert.equal(count, 1, `${field} read ${count} times`);
});

test('TEST provider source has no network client, provider SDK or live status', async () => {
  const source = await readFile(
    new URL('../src/social-campaign-pg/test-provider.ts', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(source, /\bfetch\s*\(|node:(?:http|https|net|tls|dgram)|axios|ayrshare|hootsuite/i);
  assert.doesNotMatch(source, /access[_-]?token|api[_-]?key|status:\s*['"]published['"]/i);
  assert.match(source, /externalPublishAttempted:\s*false/g);
});
