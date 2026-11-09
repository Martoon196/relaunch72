import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { canonicalCompanyContentJson } from '../src/company-content-pg/validation.js';
import {
  createPropertyPredatorHttpCatalogTransport,
  parsePropertyPredatorCompanyContentCatalog,
  propertyPredatorItemToVersionCommand,
} from '../src/company-content-adapter/property-predator.js';

const BRAND_SHA = 'a'.repeat(64);
const APPROVAL_ID = '11111111-1111-4111-8111-111111111111';
const VERSION_ID = '22222222-2222-4222-8222-222222222222';

function sha(value: unknown): string {
  return createHash('sha256').update(
    typeof value === 'string' ? value : canonicalCompanyContentJson(value),
    'utf8',
  ).digest('hex');
}

function mediaItem(body = 'Property intelligence turns a postcode into a decision-ready brief.') {
  const payload = {
    active: true,
    body,
    category: 'Social posts',
    kind: 'text',
    schema: 'propertypredator.company-content/v1',
    title: 'Lead with the evidence',
    type: 'media',
  };
  return {
    approvalId: APPROVAL_ID,
    approvedAt: '2026-08-26T20:00:00+00:00',
    blobSha256: null,
    brandSha256: BRAND_SHA,
    contentSha256: sha(payload),
    itemId: '33333333-3333-4333-8333-333333333333',
    itemType: 'media',
    itemVersion: 4,
    payload,
    versionId: VERSION_ID,
  };
}

function catalog(items: readonly Record<string, unknown>[]) {
  const manifest = { brandSha256: BRAND_SHA, items, schemaVersion: 1 };
  return {
    ...manifest,
    catalogSha256: sha(manifest),
    generatedAt: '2026-08-26T20:01:00+00:00',
    itemCount: items.length,
  };
}

function catalogResponse(source: ReturnType<typeof catalog>, headers: Record<string, string> = {}) {
  const body = JSON.stringify(source);
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'application/json',
      etag: `"sha256-${sha(body)}"`,
      'x-catalog-sha256': source.catalogSha256,
      'x-source-observed-at': source.generatedAt,
      ...headers,
    },
  });
}

test('validates the exact Property Predator catalog and maps one source version without affiliate semantics', () => {
  const parsed = parsePropertyPredatorCompanyContentCatalog(catalog([mediaItem()]));
  assert.equal(parsed.itemCount, 1);
  assert.ok(Object.isFrozen(parsed));
  assert.ok(Object.isFrozen(parsed.items));
  const item = parsed.items[0]!;
  const command = propertyPredatorItemToVersionCommand(
    parsed,
    item,
    'import:pp:media:4',
    '2026-08-26T20:01:01Z',
    '2026-08-26T20:06:01Z',
  );
  assert.equal(command.origin, 'imported');
  assert.equal(command.kind, 'social_post');
  assert.equal(command.contentMimeType, 'application/json');
  assert.equal(sha(command.content), item.contentSha256);
  assert.deepEqual(command.source, {
    system: 'propertypredator.company-content',
    itemId: `media:${item.itemId}`,
    version: '4',
  });
  assert.equal(command.blob.sha256, item.contentSha256);
  assert.equal(command.brand.sha256, BRAND_SHA);
  assert.deepEqual(command.attestation, {
    catalogSha256: parsed.catalogSha256,
    checkedAt: '2026-08-26T20:01:01Z',
    expiresAt: '2026-08-26T20:06:01Z',
  });
  assert.equal(command.metadata?.sourceApprovalId, APPROVAL_ID);
  assert.doesNotMatch(command.content, /#ad|\?ref=|affiliate/i);
});

test('accepts an honestly empty, hash-verified catalog', () => {
  const parsed = parsePropertyPredatorCompanyContentCatalog(catalog([]));
  assert.equal(parsed.itemCount, 0);
  assert.deepEqual(parsed.items, []);
});

test('rejects changed payload bytes even when the surrounding catalog hash is recomputed', () => {
  const item = mediaItem() as Record<string, unknown>;
  item.payload = { ...(item.payload as Record<string, unknown>), body: 'Changed after source approval' };
  assert.throws(
    () => parsePropertyPredatorCompanyContentCatalog(catalog([item])),
    /content hash failed verification/,
  );
});

test('rejects affiliate and personal-result language even with internally consistent hashes', () => {
  const item = mediaItem('I used this on my deal and saved thousands. #ad {{LINK}}') as Record<string, unknown>;
  assert.throws(
    () => parsePropertyPredatorCompanyContentCatalog(catalog([item])),
    /affiliate or personal-result language/,
  );
});

test('rejects obvious customer-private data and personalisation fields before import', () => {
  const privateBodies = [
    'Send this to jane.customer@example.test after the call.',
    'Call the client on 07700 900123 before noon.',
    'The customer address is SW1A 1AA.',
    'Hello {{first_name}}, here is your private deal update.',
    'Customer name: Jane Customer.',
  ];
  for (const body of privateBodies) {
    const item = mediaItem(body);
    assert.throws(
      () => parsePropertyPredatorCompanyContentCatalog(catalog([item])),
      /customer-private data or personalisation fields/,
      body,
    );
  }
});

test('rejects stale brand approval and duplicate source versions', () => {
  const stale = { ...mediaItem(), brandSha256: 'b'.repeat(64) };
  assert.throws(
    () => parsePropertyPredatorCompanyContentCatalog(catalog([stale])),
    /brand hash is stale/,
  );
  const item = mediaItem();
  assert.throws(
    () => parsePropertyPredatorCompanyContentCatalog(catalog([item, item])),
    /repeats a source version/,
  );
});

test('HTTP transport is scoped, no-store, bounded and never includes a publish operation', async () => {
  const source = catalog([mediaItem()]);
  let calledUrl = '';
  let calledInit: RequestInit = {};
  const transport = createPropertyPredatorHttpCatalogTransport({
    baseUrl: 'http://127.0.0.1:8000',
    allowLocalHttp: true,
    clientId: 'growth-hq-test',
    readToken: 'test-read-token-that-is-at-least-thirty-two-bytes',
    fetchImpl: async (input, init) => {
      calledUrl = String(input);
      calledInit = init ?? {};
      return catalogResponse(source);
    },
  });

  assert.deepEqual(await transport.loadCatalog(), source);
  assert.equal(calledUrl, 'http://127.0.0.1:8000/api/internal/company-content/catalog');
  assert.equal(calledInit.method, 'GET');
  assert.equal(calledInit.cache, 'no-store');
  assert.equal(calledInit.redirect, 'error');
  const headers = new Headers(calledInit.headers);
  assert.equal(headers.get('x-content-client'), 'growth-hq-test');
  assert.match(headers.get('authorization') ?? '', /^Bearer test-read-token/);
  assert.doesNotMatch(calledUrl, /publish|affiliate|ref=/i);
});

test('HTTP transport fails closed for insecure origins, weak credentials and oversized replies', async () => {
  assert.throws(() => createPropertyPredatorHttpCatalogTransport({
    baseUrl: 'http://propertypredator.example',
    clientId: 'growth-hq',
    readToken: 'x'.repeat(40),
  }), /approved origin/);
  assert.throws(() => createPropertyPredatorHttpCatalogTransport({
    baseUrl: 'https://propertypredator.example',
    clientId: 'growth-hq',
    readToken: 'short',
  }), /too short/);

  const transport = createPropertyPredatorHttpCatalogTransport({
    baseUrl: 'https://propertypredator.example',
    clientId: 'growth-hq',
    readToken: 'x'.repeat(40),
    fetchImpl: async () => new Response('{}', {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'content-length': String(3 * 1024 * 1024),
      },
    }),
  });
  await assert.rejects(transport.loadCatalog(), /too large/);
});

test('HTTP transport stream-counts actual bytes and rejects malformed length or unsafe UTF-8', async () => {
  const makeTransport = (response: Response) => createPropertyPredatorHttpCatalogTransport({
    baseUrl: 'https://propertypredator.example',
    clientId: 'growth-hq',
    readToken: 'x'.repeat(40),
    fetchImpl: async () => response,
  });
  await assert.rejects(
    makeTransport(new Response('{}', {
      headers: { 'content-type': 'application/json', 'content-length': '12.5' },
    })).loadCatalog(),
    /content-length is malformed/,
  );
  await assert.rejects(
    makeTransport(new Response(new Uint8Array(2 * 1024 * 1024 + 1), {
      headers: { 'content-type': 'application/json' },
    })).loadCatalog(),
    /too large/,
  );
  await assert.rejects(
    makeTransport(new Response(Uint8Array.from([0x7b, 0xff, 0x7d]), {
      headers: { 'content-type': 'application/json' },
    })).loadCatalog(),
    /canonical UTF-8/,
  );
});

test('HTTP transport rejects a strong ETag or catalogue component header that does not match', async () => {
  const source = catalog([mediaItem()]);
  const invalidHeaders: readonly Record<string, string>[] = [
    { etag: `"sha256-${'0'.repeat(64)}"` },
    { 'x-catalog-sha256': '0'.repeat(64) },
    { 'x-source-observed-at': '2026-08-26T20:01:01+00:00' },
  ];
  for (const headers of invalidHeaders) {
    const transport = createPropertyPredatorHttpCatalogTransport({
      baseUrl: 'https://propertypredator.example',
      clientId: 'growth-hq',
      readToken: 'x'.repeat(40),
      fetchImpl: async () => catalogResponse(source, headers),
    });
    await assert.rejects(transport.loadCatalog(), /ETag|component headers/);
  }
});
