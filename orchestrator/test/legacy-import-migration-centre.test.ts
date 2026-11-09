import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createHmacMigrationReceiptSigner,
  hashMigrationPublicApiToken,
  MigrationCentreBoundary,
  MigrationCentreError,
  type MigrationAuthenticatedPrincipal,
  type MigrationCommandFence,
  type MigrationCommandFenceRequest,
  type MigrationCsvAcquisitionCommand,
  type MigrationPublicApiTokenDirectory,
  type MigrationRateLimitGate,
  type MigrationRateLimitRequest,
} from '../src/legacy-import/migration-centre.js';
import type { CsvImportMapping } from '../src/legacy-import/csv-preview.js';

const encoder = new TextEncoder();
const NOW = '2026-08-28T12:00:00.000Z';
const RESET_AT = '2026-08-28T12:01:00.000Z';
const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const ACTOR_ID = '22222222-2222-4222-8222-222222222222';
const BATCH_ID = '33333333-3333-4333-8333-333333333333';
const COMMIT_ID = '44444444-4444-4444-8444-444444444444';
const TOKEN = `ppmig_${'A'.repeat(48)}`;

const mapping: CsvImportMapping = Object.freeze({
  columns: Object.freeze([
    Object.freeze({ sourceHeader: 'Name', targetField: 'contact.full_name' as const }),
    Object.freeze({ sourceHeader: 'Email', targetField: 'contact.email' as const }),
    Object.freeze({ sourceHeader: 'Opportunity', targetField: 'lead.title' as const }),
  ]),
  affiliateSourceHeaders: Object.freeze(['Affiliate Source', 'Affiliate Campaign']),
  requiredTargetFields: Object.freeze(['contact.email' as const]),
});

const portalPrincipal: MigrationAuthenticatedPrincipal = Object.freeze({
  workspaceId: WORKSPACE_ID,
  actorId: ACTOR_ID,
  role: 'founder',
  authentication: 'portal_session',
  authenticationProofSha256: 'a'.repeat(64),
});

function errorCode(error: unknown): string {
  assert.ok(error && typeof error === 'object' && 'code' in error);
  return String((error as { code: unknown }).code);
}

async function* chunked(bytes: Uint8Array, splitAt = Math.max(1, Math.floor(bytes.length / 2))) {
  yield bytes.subarray(0, splitAt);
  yield bytes.subarray(splitAt);
}

function command(
  csv: string,
  idempotencyKey = 'preview-request-key-0001',
  overrides: Partial<MigrationCsvAcquisitionCommand> = {},
): MigrationCsvAcquisitionCommand {
  const bytes = encoder.encode(csv);
  return {
    idempotencyKey,
    adapterId: 'legacy-csv-v1',
    source: {
      system: 'affiliate-stash',
      reference: 'export-batch-00000001',
      exportedAt: '2026-08-28T11:30:00.000Z',
    },
    contentType: 'text/csv; charset="utf-8"',
    contentEncoding: 'identity',
    declaredContentLength: bytes.byteLength,
    chunks: chunked(bytes),
    mapping,
    ...overrides,
  };
}

class TestFence implements MigrationCommandFence {
  readonly requests: MigrationCommandFenceRequest[] = [];
  private readonly entries = new Map<string, Readonly<{
    commandSha256: string;
    opaqueId: string;
    issuedAt: string;
  }>>();

  claim(input: MigrationCommandFenceRequest) {
    this.requests.push(input);
    const key = [input.namespace, input.workspaceId, input.actorFingerprintSha256,
      input.idempotencyKeySha256].join(':');
    const existing = this.entries.get(key);
    if (existing) {
      if (existing.commandSha256 !== input.commandSha256) {
        return Object.freeze({ disposition: 'conflict' as const });
      }
      return Object.freeze({
        disposition: 'replayed' as const,
        opaqueId: existing.opaqueId,
        issuedAt: existing.issuedAt,
      });
    }
    this.entries.set(key, Object.freeze({
      commandSha256: input.commandSha256,
      opaqueId: input.proposedOpaqueId,
      issuedAt: input.proposedAt,
    }));
    return Object.freeze({
      disposition: 'new' as const,
      opaqueId: input.proposedOpaqueId,
      issuedAt: input.proposedAt,
    });
  }
}

class TestRateLimit implements MigrationRateLimitGate {
  readonly requests: MigrationRateLimitRequest[] = [];
  deny = false;

  reserve(input: MigrationRateLimitRequest) {
    this.requests.push(input);
    if (this.deny) return Object.freeze({ allowed: false as const, retryAfterSeconds: 30 });
    return Object.freeze({
      allowed: true as const,
      reservationSha256: `${this.requests.length}`.padStart(64, '0'),
      remaining: 99 - this.requests.length,
      resetAt: RESET_AT,
    });
  }
}

interface HarnessOptions {
  readonly apiTokens?: MigrationPublicApiTokenDirectory;
  readonly now?: () => Date;
  readonly maxChunks?: number;
}

function harness(options: HarnessOptions = {}) {
  const fence = new TestFence();
  const rateLimit = new TestRateLimit();
  const ids = [BATCH_ID, COMMIT_ID,
    '55555555-5555-4555-8555-555555555555',
    '66666666-6666-4666-8666-666666666666'];
  let idIndex = 0;
  const boundary = new MigrationCentreBoundary({
    signer: createHmacMigrationReceiptSigner('11'.repeat(32)),
    fence,
    rateLimit,
    apiTokens: options.apiTokens,
    now: options.now ?? (() => new Date(NOW)),
    opaqueId: () => ids[idIndex++]!,
    maxChunks: options.maxChunks,
  });
  return { boundary, fence, rateLimit };
}

const safeCsv = [
  'Name,Email,Opportunity,Affiliate Source,Affiliate Campaign',
  'Joan,joan@example.test,North House,partner-seven,launch-72',
  'Morgan,morgan@example.test,Vendor lead,partner-eight,webinar-one',
].join('\r\n');

test('authenticated portal upload streams into a bound preview and preserves exact affiliate attribution', async () => {
  const { boundary, fence, rateLimit } = harness();
  const result = await boundary.previewPortal(portalPrincipal, command(safeCsv));

  assert.equal(result.disposition, 'new');
  assert.equal(result.receipt.batchId, BATCH_ID);
  assert.equal(result.acquisition.acquisition, 'portal_upload');
  assert.equal(result.acquisition.mediaType, 'text/csv');
  assert.equal(result.acquisition.charset, 'utf-8');
  assert.equal(result.acquisition.sourceSha256, result.preview.receipt.sourceSha256);
  assert.equal(result.acquisition.sourceReferenceSha256?.length, 64);
  assert.deepEqual(result.preview.records.map((record) => record.affiliateSources), [
    [
      { column: 'affiliate_source', value: 'partner-seven' },
      { column: 'affiliate_campaign', value: 'launch-72' },
    ],
    [
      { column: 'affiliate_source', value: 'partner-eight' },
      { column: 'affiliate_campaign', value: 'webinar-one' },
    ],
  ]);
  assert.equal(result.receipt.affiliateSourceHeaderCount, 2);
  assert.equal(result.receipt.affiliateValueCount, 4);
  assert.deepEqual(result.receipt.effects, {
    customerDataWrites: 0,
    providerCalls: 0,
    externalMutations: 0,
    controlMetadata: 'rate_limit_and_idempotency_only',
  });
  assert.deepEqual(result.acquisition.effects, {
    requestBodyReads: 1,
    databaseWrites: 0,
    externalMutations: 0,
    providerCalls: 0,
  });
  const serialized = JSON.stringify({ receipt: result.receipt, acquisition: result.acquisition });
  assert.doesNotMatch(serialized, /preview-request-key-0001|export-batch-00000001|joan@|partner-seven/iu);
  assert.equal(fence.requests[0]?.idempotencyKeySha256.length, 64);
  assert.equal(rateLimit.requests[0]?.tokenSha256, null);
});

test('portal authentication, operator role and workspace receipt binding fail closed', async () => {
  const wrongAuthentication = {
    ...portalPrincipal,
    authentication: 'public_api_token' as const,
  };
  await assert.rejects(
    harness().boundary.previewPortal(wrongAuthentication, command(safeCsv, 'auth-kind-key-0000001')),
    (error) => errorCode(error) === 'principal_invalid',
  );

  const forbiddenRole = {
    ...portalPrincipal,
    role: 'viewer',
  } as unknown as MigrationAuthenticatedPrincipal;
  await assert.rejects(
    harness().boundary.previewPortal(forbiddenRole, command(safeCsv, 'auth-role-key-0000001')),
    (error) => errorCode(error) === 'principal_forbidden',
  );

  const { boundary } = harness();
  const preview = await boundary.previewPortal(
    portalPrincipal,
    command(safeCsv, 'auth-workspace-key-0001'),
  );
  const otherWorkspace = {
    ...portalPrincipal,
    workspaceId: '77777777-7777-4777-8777-777777777777',
  };
  await assert.rejects(boundary.commitReceiptPortal(otherWorkspace, {
    idempotencyKey: 'auth-workspace-commit-0001',
    confirmation: 'commit_exact_preview',
    expectedBatchId: preview.receipt.batchId,
    expectedPreviewReceiptSha256: preview.receipt.receiptSha256,
    expectedSourceSha256: preview.receipt.sourceSha256,
    expectedAffiliateAttributionSha256: preview.receipt.affiliateAttributionSha256,
    previewResult: preview,
  }), (error) => errorCode(error) === 'receipt_invalid');
});

test('content metadata, stream bytes, chunks, declared length, rows and columns remain bounded', async () => {
  const badInputs: ReadonlyArray<readonly [string, MigrationCsvAcquisitionCommand, string]> = [
    ['media type', command(safeCsv, 'preview-bounds-key-0001', {
      contentType: 'application/vnd.ms-excel',
    }), 'content_type_unsafe'],
    ['content encoding', command(safeCsv, 'preview-bounds-key-0002', {
      contentEncoding: 'gzip',
    }), 'content_encoding_unsafe'],
    ['declared maximum', command(safeCsv, 'preview-bounds-key-0003', {
      declaredContentLength: 101,
      limits: { maxBytes: 100 },
    }), 'declared_length_invalid'],
    ['actual maximum', command(safeCsv, 'preview-bounds-key-0004', {
      declaredContentLength: undefined,
      limits: { maxBytes: 50 },
    }), 'source_too_large'],
    ['length mismatch', command(safeCsv, 'preview-bounds-key-0005', {
      declaredContentLength: encoder.encode(safeCsv).byteLength - 1,
    }), 'source_length_mismatch'],
    ['row cap', command(safeCsv, 'preview-bounds-key-0006', {
      limits: { maxRows: 1 },
    }), 'csv_too_many_rows'],
    ['column cap', command(safeCsv, 'preview-bounds-key-0007', {
      limits: { maxColumns: 3 },
    }), 'csv_too_many_columns'],
  ];
  for (const [label, input, expected] of badInputs) {
    const { boundary } = harness();
    await assert.rejects(boundary.previewPortal(portalPrincipal, input), (error) => {
      assert.equal(errorCode(error), expected, label);
      return true;
    });
  }

  const { boundary } = harness({ maxChunks: 1 });
  await assert.rejects(
    boundary.previewPortal(portalPrincipal, command(safeCsv, 'preview-bounds-key-0008')),
    (error) => errorCode(error) === 'source_stream_invalid',
  );
});

test('an acquisition exception fails with a fixed error and never exposes source text', async () => {
  async function* broken() {
    yield encoder.encode('Email\n');
    throw new Error('owner@example.test secret source failure');
  }
  const { boundary } = harness();
  await assert.rejects(boundary.previewPortal(portalPrincipal, command(
    'unused',
    'preview-stream-key-0001',
    { chunks: broken(), declaredContentLength: undefined },
  )), (error) => {
    assert.equal(errorCode(error), 'source_stream_failed');
    assert.doesNotMatch((error as Error).message, /owner@|secret source/iu);
    return true;
  });
});

test('preview idempotency replays byte-stably and conflicts when source bytes change', async () => {
  const { boundary, fence } = harness();
  const first = await boundary.previewPortal(portalPrincipal, command(safeCsv));
  const replay = await boundary.previewPortal(portalPrincipal, command(safeCsv));
  assert.equal(replay.disposition, 'replayed');
  assert.deepEqual(replay.receipt, first.receipt);
  assert.deepEqual(replay.acquisition, first.acquisition);
  assert.equal(fence.requests[0]?.idempotencyKeySha256, fence.requests[1]?.idempotencyKeySha256);
  assert.equal(fence.requests[0]?.commandSha256, fence.requests[1]?.commandSha256);

  await assert.rejects(boundary.previewPortal(
    portalPrincipal,
    command(safeCsv.replace('North House', 'Different House')),
  ), (error) => errorCode(error) === 'idempotency_conflict');
});

test('idempotency and source references reject PII or secret-shaped values before use', async () => {
  const cases: ReadonlyArray<readonly [MigrationCsvAcquisitionCommand, string]> = [
    [command(safeCsv, 'owner@example.test'), 'idempotency_key_invalid'],
    [command(safeCsv, 'migration-access-token-0001'), 'idempotency_key_invalid'],
    [command(safeCsv, 'preview-safe-key-00001', {
      source: { system: 'affiliate-stash', reference: 'owner@example.test' },
    }), 'source_descriptor_invalid'],
    [command(safeCsv, 'preview-safe-key-00002', {
      source: { system: '07700900123', reference: 'export-batch-00000001' },
    }), 'source_descriptor_invalid'],
    [command(safeCsv, 'preview-safe-key-00003', {
      adapterId: 'access_token_archive',
    }), 'source_descriptor_invalid'],
    [command(safeCsv, 'preview-safe-key-00004', {
      source: {
        system: 'affiliate-stash',
        reference: 'export-batch-00000001',
        exportedAt: '2026-08-28T12:06:00.000Z',
      },
    }), 'source_descriptor_invalid'],
  ];
  for (const [input, expected] of cases) {
    const { boundary } = harness();
    await assert.rejects(
      boundary.previewPortal(portalPrincipal, input),
      (error) => errorCode(error) === expected,
    );
  }
});

test('mapping metadata is bounded before any customer-data stream is read', async () => {
  let streamTouched = false;
  async function* untouched() {
    streamTouched = true;
    yield encoder.encode(safeCsv);
  }
  const tooManyAffiliateHeaders = Array.from(
    { length: 17 },
    (_, index) => `Affiliate Source ${index + 1}`,
  );
  const { boundary } = harness();
  await assert.rejects(boundary.previewPortal(portalPrincipal, command(
    safeCsv,
    'mapping-envelope-key-0001',
    {
      chunks: untouched(),
      mapping: { ...mapping, affiliateSourceHeaders: tooManyAffiliateHeaders },
    },
  )), (error) => errorCode(error) === 'mapping_invalid');
  assert.equal(streamTouched, false);
});

test('pluggable control failures collapse to fixed errors without leaking details', async () => {
  const leaking = 'database password=owner@example.test';
  const rateBoundary = new MigrationCentreBoundary({
    signer: createHmacMigrationReceiptSigner('11'.repeat(32)),
    fence: new TestFence(),
    rateLimit: {
      reserve() { throw new Error(leaking); },
    },
    now: () => new Date(NOW),
    opaqueId: () => BATCH_ID,
  });
  await assert.rejects(
    rateBoundary.previewPortal(portalPrincipal, command(safeCsv, 'control-rate-key-00001')),
    (error) => {
      assert.equal(errorCode(error), 'control_unavailable');
      assert.doesNotMatch((error as Error).message, /password|owner@/iu);
      return true;
    },
  );

  const signingBoundary = new MigrationCentreBoundary({
    signer: {
      sign() { throw new Error(leaking); },
      verify() { throw new Error(leaking); },
    },
    fence: new TestFence(),
    rateLimit: new TestRateLimit(),
    now: () => new Date(NOW),
    opaqueId: () => BATCH_ID,
  });
  await assert.rejects(
    signingBoundary.previewPortal(portalPrincipal, command(safeCsv, 'control-sign-key-00001')),
    (error) => {
      assert.equal(errorCode(error), 'control_unavailable');
      assert.doesNotMatch((error as Error).message, /password|owner@/iu);
      return true;
    },
  );
});

test('explicit commit returns only a signed dark receipt and is independently idempotent', async () => {
  const { boundary } = harness();
  const preview = await boundary.previewPortal(portalPrincipal, command(safeCsv));
  const input = {
    idempotencyKey: 'commit-receipt-key-0001',
    confirmation: 'commit_exact_preview' as const,
    expectedBatchId: preview.receipt.batchId,
    expectedPreviewReceiptSha256: preview.receipt.receiptSha256,
    expectedSourceSha256: preview.receipt.sourceSha256,
    expectedAffiliateAttributionSha256: preview.receipt.affiliateAttributionSha256,
    previewResult: preview,
  };
  const committed = await boundary.commitReceiptPortal(portalPrincipal, input);
  assert.equal(committed.disposition, 'new');
  assert.equal(committed.receipt.receiptId, COMMIT_ID);
  assert.equal(committed.receipt.execution, 'not_executed_dark_contract');
  assert.equal(committed.receipt.liveCustomerImport, false);
  assert.equal(committed.receipt.effects.customerDataWrites, 0);
  assert.equal(committed.receipt.affiliateAttributionSha256,
    preview.receipt.affiliateAttributionSha256);

  const replay = await boundary.commitReceiptPortal(portalPrincipal, input);
  assert.equal(replay.disposition, 'replayed');
  assert.deepEqual(replay.receipt, committed.receipt);
});

test('commit rejects assertion changes, affiliate tampering, bad HMAC and expired previews', async () => {
  let now = new Date(NOW);
  const { boundary } = harness({ now: () => now });
  const preview = await boundary.previewPortal(portalPrincipal, command(safeCsv));
  const base = {
    idempotencyKey: 'commit-integrity-key-0001',
    confirmation: 'commit_exact_preview' as const,
    expectedBatchId: preview.receipt.batchId,
    expectedPreviewReceiptSha256: preview.receipt.receiptSha256,
    expectedSourceSha256: preview.receipt.sourceSha256,
    expectedAffiliateAttributionSha256: preview.receipt.affiliateAttributionSha256,
    previewResult: preview,
  };
  await assert.rejects(boundary.commitReceiptPortal(portalPrincipal, {
    ...base, expectedSourceSha256: '0'.repeat(64),
  }), (error) => errorCode(error) === 'commit_confirmation_invalid');

  const firstRecord = preview.preview.records[0]!;
  const tampered = {
    ...preview,
    preview: {
      ...preview.preview,
      records: [
        {
          ...firstRecord,
          affiliateSources: [{ column: 'affiliate_source', value: 'attacker-rewrite' }],
        },
        ...preview.preview.records.slice(1),
      ],
    },
  } as typeof preview;
  await assert.rejects(boundary.commitReceiptPortal(portalPrincipal, {
    ...base, previewResult: tampered,
  }), (error) => errorCode(error) === 'receipt_invalid');

  const badHmac = {
    ...preview,
    receipt: { ...preview.receipt, receiptHmacSha256: '0'.repeat(64) },
  } as typeof preview;
  await assert.rejects(boundary.commitReceiptPortal(portalPrincipal, {
    ...base, previewResult: badHmac,
  }), (error) => errorCode(error) === 'receipt_invalid');

  now = new Date('2026-08-29T12:00:00.000Z');
  await assert.rejects(
    boundary.commitReceiptPortal(portalPrincipal, base),
    (error) => errorCode(error) === 'receipt_expired',
  );
});

test('public API hashes the scoped bearer token, authorises its digest and never returns raw token text', async () => {
  const authorizations: Array<{ tokenSha256: string; operation: string }> = [];
  const apiTokens: MigrationPublicApiTokenDirectory = {
    authorize(input) {
      authorizations.push(input);
      return {
        allowed: true,
        principal: {
          ...portalPrincipal,
          authentication: 'public_api_token',
          authenticationProofSha256: input.tokenSha256,
        },
      };
    },
  };
  const { boundary, rateLimit } = harness({ apiTokens });
  const preview = await boundary.previewPublicApi({
    ...command(safeCsv, 'public-api-preview-key-0001'),
    bearerToken: TOKEN,
  });
  assert.equal(authorizations[0]?.tokenSha256, hashMigrationPublicApiToken(TOKEN));
  assert.equal(authorizations[0]?.operation, 'preview');
  assert.equal(preview.acquisition.acquisition, 'public_api_body');
  assert.equal(preview.receipt.authentication, 'public_api_token');
  assert.equal(rateLimit.requests[0]?.tokenSha256, hashMigrationPublicApiToken(TOKEN));
  assert.doesNotMatch(JSON.stringify(preview), new RegExp(TOKEN, 'u'));

  const commit = await boundary.commitReceiptPublicApi({
    bearerToken: TOKEN,
    idempotencyKey: 'public-api-commit-key-0001',
    confirmation: 'commit_exact_preview',
    expectedBatchId: preview.receipt.batchId,
    expectedPreviewReceiptSha256: preview.receipt.receiptSha256,
    expectedSourceSha256: preview.receipt.sourceSha256,
    expectedAffiliateAttributionSha256: preview.receipt.affiliateAttributionSha256,
    previewResult: preview,
  });
  assert.equal(authorizations[1]?.operation, 'commit_receipt');
  assert.equal(commit.receipt.authentication, 'public_api_token');
  assert.equal(commit.receipt.execution, 'not_executed_dark_contract');
  assert.doesNotMatch(JSON.stringify(commit), new RegExp(TOKEN, 'u'));
});

test('invalid or unauthorized API tokens and exhausted rate limits fail before import effects', async () => {
  let tokenDirectoryCalls = 0;
  const apiTokens: MigrationPublicApiTokenDirectory = {
    authorize() {
      tokenDirectoryCalls += 1;
      return { allowed: false, reason: 'revoked' };
    },
  };
  const { boundary } = harness({ apiTokens });
  await assert.rejects(boundary.previewPublicApi({
    ...command(safeCsv, 'public-api-invalid-key-0001'),
    bearerToken: 'not-a-token',
  }), (error) => errorCode(error) === 'api_token_invalid');
  assert.equal(tokenDirectoryCalls, 0);
  await assert.rejects(boundary.previewPublicApi({
    ...command(safeCsv, 'public-api-revoked-key-0001'),
    bearerToken: TOKEN,
  }), (error) => errorCode(error) === 'api_token_unauthorized');

  const allowed: MigrationPublicApiTokenDirectory = {
    authorize(input) {
      return {
        allowed: true,
        principal: {
          ...portalPrincipal,
          authentication: 'public_api_token',
          authenticationProofSha256: input.tokenSha256,
        },
      };
    },
  };
  const limited = harness({ apiTokens: allowed });
  limited.rateLimit.deny = true;
  let streamTouched = false;
  async function* untouched() {
    streamTouched = true;
    yield encoder.encode(safeCsv);
  }
  await assert.rejects(limited.boundary.previewPublicApi({
    ...command(safeCsv, 'public-api-limited-key-0001'),
    chunks: untouched(),
    bearerToken: TOKEN,
  }), (error) => {
    assert.equal(errorCode(error), 'rate_limited');
    assert.equal((error as MigrationCentreError).retryAfterSeconds, 30);
    return true;
  });
  assert.equal(streamTouched, false, 'rate limiting must happen before reading upload bytes');
});
