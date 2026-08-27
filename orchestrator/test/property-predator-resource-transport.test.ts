import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { canonicalCompanyContentJson } from '../src/company-content-pg/validation.js';
import {
  createPropertyPredatorApprovedResourceTransport,
} from '../src/company-content-adapter/property-predator-resources.js';

const VERSION_ID = '22222222-2222-4222-8222-222222222222';
const APPROVAL_ID = '11111111-1111-4111-8111-111111111111';
const BRAND_SHA = 'ab'.repeat(32);
const PNG = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);

function sha(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function mediaEnvelope() {
  const payload = {
    active: true,
    body: 'Property intelligence turns a postcode into a decision-ready brief.',
    category: 'Social posts',
    kind: 'text',
    schema: 'propertypredator.company-content/v1',
    title: 'Lead with the evidence',
    type: 'media',
  };
  return {
    schemaVersion: 1,
    item: {
      approvalId: APPROVAL_ID,
      approvedAt: '2026-08-26T20:00:00Z',
      blobSha256: null,
      brandSha256: BRAND_SHA,
      contentSha256: sha(canonicalCompanyContentJson(payload)),
      itemId: '33333333-3333-4333-8333-333333333333',
      itemType: 'media',
      itemVersion: 4,
      payload,
      versionId: VERSION_ID,
    },
  };
}

function transport(fetchImpl: typeof fetch) {
  return createPropertyPredatorApprovedResourceTransport({
    baseUrl: 'http://127.0.0.1:8000',
    allowLocalHttp: true,
    clientId: 'growth-hq-test',
    readToken: 'test-read-token-that-is-at-least-thirty-two-bytes',
    fetchImpl,
  });
}

test('loads one exact approved body through the scoped read boundary and verifies its hash', async () => {
  const source = mediaEnvelope();
  let called = '';
  let init: RequestInit | undefined;
  const client = transport(async (input, options) => {
    called = String(input);
    init = options;
    return new Response(JSON.stringify(source), {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });
  const version = await client.loadVersion(VERSION_ID, source.item.contentSha256);
  assert.equal(version.versionId, VERSION_ID);
  assert.equal(version.itemType, 'media');
  assert.equal(version.contentSha256, source.item.contentSha256);
  assert.deepEqual(version.payload, source.item.payload);
  assert.equal(called, `http://127.0.0.1:8000/api/internal/company-content/versions/${VERSION_ID}`);
  assert.equal(init?.method, 'GET');
  assert.equal(init?.cache, 'no-store');
  assert.equal(init?.credentials, 'omit');
  assert.equal(init?.redirect, 'error');
  const headers = new Headers(init?.headers);
  assert.equal(headers.get('x-content-client'), 'growth-hq-test');
  assert.match(headers.get('authorization') ?? '', /^Bearer test-read-token/);
  assert.equal('publish' in client, false);
  assert.equal('generate' in client, false);
});

test('loads exact approved artwork bytes only after MIME, ETag and digest verification', async () => {
  const digest = sha(PNG);
  const client = transport(async () => new Response(PNG, {
    status: 200,
    headers: {
      'content-type': 'image/png',
      etag: `"sha256-${digest}"`,
    },
  }));
  const asset = await client.loadAsset(VERSION_ID, digest);
  assert.equal(asset.mediaType, 'image/png');
  assert.equal(asset.sha256, digest);
  assert.deepEqual(asset.bytes, PNG);
});

test('rejects tampered bodies, assets, hostile shapes and escaped origins', async () => {
  const body = mediaEnvelope();
  body.item.payload.body = 'Changed after approval';
  await assert.rejects(
    transport(async () => new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })).loadVersion(VERSION_ID),
    /content digest failed verification/,
  );

  await assert.rejects(
    transport(async () => new Response(Uint8Array.from([...PNG, 1]), {
      status: 200,
      headers: { 'content-type': 'image/png', etag: `"sha256-${sha(PNG)}"` },
    })).loadAsset(VERSION_ID, sha(PNG)),
    /asset digest failed verification/,
  );

  assert.throws(() => createPropertyPredatorApprovedResourceTransport({
    baseUrl: 'http://propertypredator.example',
    clientId: 'growth-hq',
    readToken: 'x'.repeat(40),
  }), /clean HTTPS origin/);
  assert.throws(() => createPropertyPredatorApprovedResourceTransport({
    baseUrl: 'https://propertypredator.example/path',
    clientId: 'growth-hq',
    readToken: 'x'.repeat(40),
  }), /clean HTTPS origin/);
  assert.throws(() => createPropertyPredatorApprovedResourceTransport({
    baseUrl: 'https://propertypredator.example',
    clientId: 'growth-hq',
    readToken: 'weak',
  }), /read credential is invalid/);
});

test('rejects oversized resources before buffering them', async () => {
  const client = transport(async () => new Response('{}', {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'content-length': String(129 * 1024),
    },
  }));
  await assert.rejects(client.loadVersion(VERSION_ID), /response length is invalid/);
});
