import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import type { Pool } from 'pg';
import {
  PgPublicSocialRevalidationQueue,
  type PublicSocialRevalidationClaim,
  type PublicSocialRevalidationLease,
} from '../src/workers/public-social-revalidator/queue.js';
import { PgPropertyPredatorJitSourceAttestor } from '../src/workers/public-social-revalidator/source-attestor.js';

const WORKER = '33333333-3333-4333-8333-333333333333';
const JOB = '44444444-4444-4444-8444-444444444444';
const WORKSPACE = '55555555-5555-4555-8555-555555555555';
const INTENT = '66666666-6666-4666-8666-666666666666';
const ITEM = '77777777-7777-4777-8777-777777777777';
const VERSION = '88888888-8888-4888-8888-888888888888';
const PROOF = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const POST = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OPERATION = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const SOURCE_VERSION = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const MEDIA_ITEM = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const MEDIA_VERSION = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const MEDIA_SOURCE_VERSION = '12121212-1212-4121-8121-121212121212';
const APPROVAL = '13131313-1313-4131-8131-131313131313';
const APPROVED_AT = '2026-08-27T10:00:00.000Z';
const SHA = '1'.repeat(64);
const MEDIA_CONTENT_SHA = '2'.repeat(64);
const MEDIA_BLOB_SHA = '3'.repeat(64);
const BRAND_SHA = '4'.repeat(64);

function lease(): PublicSocialRevalidationLease {
  return Object.freeze({ workerId: WORKER, token: Buffer.alloc(32, 7) });
}

function claim(media = false): PublicSocialRevalidationClaim {
  return Object.freeze({
    jobId: JOB,
    workspaceId: WORKSPACE,
    intentId: INTENT,
    leaseVersion: 2,
    desiredFor: '2026-08-27T12:05:00.000Z',
    contentItemId: ITEM,
    contentVersionId: VERSION,
    sourceSystem: 'propertypredator.company-content',
    sourceItemId: 'media:campaign-1',
    sourceVersion: '1',
    sourceResourceVersionId: SOURCE_VERSION,
    sourceApprovalId: APPROVAL,
    sourceApprovedAt: APPROVED_AT,
    contentSha256: SHA,
    blobSha256: SHA,
    brandSha256: BRAND_SHA,
    media: media ? Object.freeze([Object.freeze({
      ordinal: 1,
      contentItemId: MEDIA_ITEM,
      contentVersionId: MEDIA_VERSION,
      sourceSystem: 'propertypredator.company-content',
      sourceItemId: 'asset:hero-1',
      sourceVersion: '1',
      sourceResourceVersionId: MEDIA_SOURCE_VERSION,
      sourceApprovalId: APPROVAL,
      sourceApprovedAt: APPROVED_AT,
      contentSha256: MEDIA_CONTENT_SHA,
      blobSha256: MEDIA_BLOB_SHA,
      brandSha256: BRAND_SHA,
    })]) : Object.freeze([]),
  });
}

function sourceProof(media = false) {
  return Object.freeze({
    sourceCatalogSha256: '5'.repeat(64),
    checkedAt: '2026-08-27T12:00:00.000Z',
    expiresAt: '2026-08-27T12:15:00.000Z',
    content: Object.freeze({
      sourceResourceVersionId: SOURCE_VERSION,
      sourceApprovalId: APPROVAL,
      sourceApprovedAt: APPROVED_AT,
    }),
    media: media ? Object.freeze([Object.freeze({
      sourceResourceVersionId: MEDIA_SOURCE_VERSION,
      sourceApprovalId: APPROVAL,
      sourceApprovedAt: APPROVED_AT,
    })]) : Object.freeze([]),
  });
}

test('queue hashes leases, parses immutable source approval evidence and uses one atomic completion function', async () => {
  const queries: ReadonlyArray<unknown>[] = [];
  const pool = {
    async query(sql: string, values?: readonly unknown[]) {
      queries.push([sql, values]);
      if (sql.includes('public-social-revalidator.claim')) {
        return { rows: [{
          jobId: JOB,
          workspaceId: WORKSPACE,
          intentId: INTENT,
          leaseVersion: '2',
          desiredFor: new Date('2026-08-27T12:05:00.000Z'),
          contentItemId: ITEM,
          contentVersionId: VERSION,
          sourceSystem: 'propertypredator.company-content',
          sourceItemId: 'media:campaign-1',
          sourceVersion: '1',
          sourceResourceVersionId: SOURCE_VERSION,
          sourceApprovalId: APPROVAL,
          sourceApprovedAt: APPROVED_AT,
          contentSha256: SHA,
          blobSha256: SHA,
          brandSha256: BRAND_SHA,
          media: [],
        }] };
      }
      if (sql.includes('public-social-revalidator.complete-and-materialize')) {
        return { rows: [{
          proofId: PROOF, postId: POST, operationIds: [OPERATION], disposition: 'applied',
        }] };
      }
      throw new Error('unexpected query');
    },
    async connect() { throw new Error('completion must not open a second transaction boundary'); },
  } as unknown as Pick<Pool, 'query' | 'connect'>;
  const queue = new PgPublicSocialRevalidationQueue(pool);
  const current = await queue.claim(lease());
  assert.deepEqual(current, claim());
  const claimValues = queries[0]?.[1] as readonly unknown[];
  assert.equal(claimValues[0], WORKER);
  assert.deepEqual(claimValues[1], createHash('sha256').update(Buffer.alloc(32, 7)).digest());
  assert.notDeepEqual(claimValues[1], Buffer.alloc(32, 7));

  assert.deepEqual(await queue.completeAndMaterialize(
    current!, lease(), sourceProof(), PROOF, POST,
  ), {
    proofId: PROOF, postId: POST, operationIds: [OPERATION], disposition: 'applied',
  });
  assert.equal(queries.length, 2);
  assert.match(queries[1]?.[0] as string, /complete_and_materialize_test_social_revalidation/);
  assert.doesNotMatch(queries.map(([sql]) => String(sql)).join('\n'), /\bBEGIN\b|\bCOMMIT\b/);
  const completionValues = queries[1]?.[1] as readonly unknown[];
  assert.equal(completionValues[7], SOURCE_VERSION);
  assert.equal(completionValues[8], APPROVAL);
  assert.equal(completionValues[9], APPROVED_AT);
});

test('queue refuses altered remote approval provenance before any completion query', async () => {
  let queries = 0;
  const queue = new PgPublicSocialRevalidationQueue({
    async query() { queries += 1; return { rows: [] }; },
    async connect() { throw new Error('not reached'); },
  } as unknown as Pick<Pool, 'query' | 'connect'>);
  const altered = {
    ...sourceProof(),
    content: { ...sourceProof().content, sourceApprovalId: PROOF },
  };
  await assert.rejects(
    queue.completeAndMaterialize(claim(), lease(), altered, PROOF, POST),
    /not the exact leased evidence/,
  );
  assert.equal(queries, 0);
});

test('source verifier rereads only the leased tuple function and returns system provenance without table writes', async () => {
  const calls: string[] = [];
  const loaded: string[] = [];
  const assets: string[] = [];
  const pool = {
    async query(sql: string) {
      calls.push(sql);
      if (!sql.includes('load_leased_test_social_source_versions')) {
        throw new Error('unexpected database capability');
      }
      return { rows: [
        {
          resourceOrdinal: 0,
          contentItemId: ITEM,
          contentVersionId: VERSION,
          sourceSystem: 'propertypredator.company-content',
          sourceItemId: 'media:campaign-1',
          sourceVersion: '1',
          contentSha256: SHA,
          bodySha256: SHA,
          blobSha256: SHA,
          brandSha256: BRAND_SHA,
          sourceResourceVersionId: SOURCE_VERSION,
          sourceApprovalId: APPROVAL,
          sourceApprovedAt: APPROVED_AT,
        },
        {
          resourceOrdinal: 1,
          contentItemId: MEDIA_ITEM,
          contentVersionId: MEDIA_VERSION,
          sourceSystem: 'propertypredator.company-content',
          sourceItemId: 'asset:hero-1',
          sourceVersion: '1',
          contentSha256: MEDIA_CONTENT_SHA,
          bodySha256: MEDIA_CONTENT_SHA,
          blobSha256: MEDIA_BLOB_SHA,
          brandSha256: BRAND_SHA,
          sourceResourceVersionId: MEDIA_SOURCE_VERSION,
          sourceApprovalId: APPROVAL,
          sourceApprovedAt: APPROVED_AT,
        },
      ] };
    },
  } as unknown as Pick<Pool, 'query'>;
  const attestor = new PgPropertyPredatorJitSourceAttestor({
    pool,
    now: () => new Date('2026-08-27T12:00:00.000Z'),
    transport: Object.freeze({
      async loadVersion(versionId: string, expectedSha?: string) {
        loaded.push(`${versionId}:${expectedSha}`);
        const asset = versionId === MEDIA_SOURCE_VERSION;
        return Object.freeze({
          versionId,
          itemId: asset ? 'hero-1' : 'campaign-1',
          itemType: asset ? 'asset' as const : 'media' as const,
          itemVersion: 1,
          approvalId: APPROVAL,
          approvedAt: APPROVED_AT,
          contentSha256: asset ? MEDIA_CONTENT_SHA : SHA,
          blobSha256: asset ? MEDIA_BLOB_SHA : null,
          brandSha256: BRAND_SHA,
          payload: Object.freeze({}),
          canonicalContent: '{}',
          assetResourcePath: asset
            ? `/api/internal/company-content/assets/${versionId}/file` : null,
        });
      },
      async loadAsset(versionId: string, expectedSha: string) {
        assets.push(`${versionId}:${expectedSha}`);
        return Object.freeze({
          versionId, mediaType: 'image/png' as const,
          sha256: expectedSha, bytes: new Uint8Array([1]),
        });
      },
    }),
  });
  const result = await attestor.attest(claim(true), lease());
  assert.deepEqual(result.content, {
    sourceResourceVersionId: SOURCE_VERSION,
    sourceApprovalId: APPROVAL,
    sourceApprovedAt: APPROVED_AT,
  });
  assert.deepEqual(result.media, [{
    sourceResourceVersionId: MEDIA_SOURCE_VERSION,
    sourceApprovalId: APPROVAL,
    sourceApprovedAt: APPROVED_AT,
  }]);
  assert.equal(result.checkedAt, '2026-08-27T12:00:00.000Z');
  assert.equal(result.expiresAt, '2026-08-27T12:15:00.000Z');
  assert.match(result.sourceCatalogSha256, /^[0-9a-f]{64}$/u);
  assert.deepEqual(loaded, [
    `${SOURCE_VERSION}:${SHA}`,
    `${MEDIA_SOURCE_VERSION}:${MEDIA_CONTENT_SHA}`,
  ]);
  assert.deepEqual(assets, [`${MEDIA_SOURCE_VERSION}:${MEDIA_BLOB_SHA}`]);
  assert.equal(calls.length, 1);
  assert.doesNotMatch(calls[0]!, /INSERT|company_content_source_attestations/iu);
});

test('source verifier rejects remote approval drift and effect-shaped transports', async () => {
  const current = claim();
  const pool = {
    async query() {
      return { rows: [{
        resourceOrdinal: 0,
        contentItemId: ITEM,
        contentVersionId: VERSION,
        sourceSystem: current.sourceSystem,
        sourceItemId: current.sourceItemId,
        sourceVersion: current.sourceVersion,
        contentSha256: SHA,
        bodySha256: SHA,
        blobSha256: SHA,
        brandSha256: BRAND_SHA,
        sourceResourceVersionId: SOURCE_VERSION,
        sourceApprovalId: APPROVAL,
        sourceApprovedAt: APPROVED_AT,
      }] };
    },
  } as unknown as Pick<Pool, 'query'>;
  const drifted = new PgPropertyPredatorJitSourceAttestor({
    pool,
    transport: Object.freeze({
      async loadVersion() {
        return Object.freeze({
          versionId: SOURCE_VERSION, itemId: 'campaign-1', itemType: 'media' as const,
          itemVersion: 1, approvalId: APPROVAL,
          approvedAt: '2026-08-27T10:00:00.000001Z',
          contentSha256: SHA, blobSha256: null, brandSha256: BRAND_SHA,
          payload: Object.freeze({}), canonicalContent: '{}', assetResourcePath: null,
        });
      },
      async loadAsset() { throw new Error('not reached'); },
    }),
  });
  await assert.rejects(drifted.attest(current, lease()), /no longer matches/);

  assert.throws(() => new PgPropertyPredatorJitSourceAttestor({
    pool,
    transport: {
      async loadVersion() { throw new Error('not reached'); },
      async loadAsset() { throw new Error('not reached'); },
      async publish() { return undefined; },
    } as never,
  }), /forbidden effect method/);
});
