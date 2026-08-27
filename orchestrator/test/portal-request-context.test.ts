import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import {
  createPortalRequestContextResolver,
  portalAbuseHash,
} from '../src/portal/request-context.js';

const SECRET = 'portal-abuse-test-secret-32-characters-minimum';

function request(headers: IncomingMessage['headers'] = {}): IncomingMessage {
  return Object.assign(Readable.from([]), { headers }) as unknown as IncomingMessage;
}

test('Render request context trusts only the first valid X-Forwarded-For address', () => {
  const resolve = createPortalRequestContextResolver({
    hashSecret: SECRET,
    proxyMode: 'render',
    requestId: () => 'request-1',
    directClientAddress: () => '127.0.0.1',
  });
  const context = resolve(request({
    'x-forwarded-for': '203.0.113.42, 10.0.0.1',
    'cf-ray': 'abc123-FRA',
  }));
  assert.ok(context);
  assert.equal(context.clientAddress, '203.0.113.42');
  assert.equal(context.requestId, 'request-1');
  assert.equal(context.cfRay, 'abc123-FRA');
  assert.deepEqual(context.sourceHash, portalAbuseHash(SECRET, 'source', '203.0.113.42'));
  assert.notDeepEqual(context.sourceHash, portalAbuseHash(SECRET, 'request', '203.0.113.42'));
  assert.notDeepEqual(context.requestHash, portalAbuseHash(SECRET, 'request', 'request-1'));
});

test('Render request context fails closed without a valid client address', () => {
  const resolve = createPortalRequestContextResolver({ hashSecret: SECRET, proxyMode: 'render' });
  assert.equal(resolve(request()), null);
  assert.equal(resolve(request({ 'x-forwarded-for': 'not-an-ip, 203.0.113.9' })), null);
  assert.equal(resolve(request({ 'x-forwarded-for': '' })), null);
});

test('equivalent IPv6 spellings resolve to one source identity', () => {
  const resolve = createPortalRequestContextResolver({
    hashSecret: SECRET,
    proxyMode: 'render',
    requestId: () => 'request-ipv6',
  });
  const expanded = resolve(request({
    'x-forwarded-for': '2001:0db8:0000:0000:0000:0000:0000:0001',
  }));
  const compressed = resolve(request({ 'x-forwarded-for': '2001:db8::1' }));
  assert.ok(expanded && compressed);
  assert.equal(expanded.clientAddress, '2001:db8::1');
  assert.deepEqual(expanded.sourceHash, compressed.sourceHash);
});

test('CF-Ray is bounded trace metadata and never a source key', () => {
  const resolve = createPortalRequestContextResolver({
    hashSecret: SECRET,
    proxyMode: 'render',
    requestId: () => 'request-2',
  });
  const invalid = resolve(request({
    'x-forwarded-for': '2001:db8::1',
    'cf-ray': 'bad trace value with spaces',
  }));
  const absent = resolve(request({ 'x-forwarded-for': '2001:db8::1' }));
  assert.ok(invalid && absent);
  assert.equal(invalid.cfRay, undefined);
  assert.deepEqual(invalid.sourceHash, absent.sourceHash);
  assert.deepEqual(invalid.requestHash, absent.requestHash);
});

test('direct mode uses only its explicit development resolver', () => {
  const resolve = createPortalRequestContextResolver({
    hashSecret: SECRET,
    proxyMode: 'direct',
    requestId: () => 'request-3',
    directClientAddress: () => '127.0.0.1',
  });
  const context = resolve(request({ 'x-forwarded-for': '198.51.100.4' }));
  assert.ok(context);
  assert.equal(context.clientAddress, '127.0.0.1');
});

test('request context refuses weak HMAC secrets', () => {
  assert.throws(
    () => createPortalRequestContextResolver({ hashSecret: 'weak', proxyMode: 'render' }),
    /at least 32/,
  );
});
