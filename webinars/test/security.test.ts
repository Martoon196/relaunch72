import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateApiKey, hasScope, isOriginAllowed, mintSessionToken, originMatches, parseKeyShape, readHostToken, readSessionToken } from '../src/lib/auth.js';
import { decryptSecret, encryptSecret, signToken, verifyToken } from '../src/lib/crypto.js';
import { signWebhook, verifyWebhookSignature } from '../src/lib/webhooks.js';
import { toCsv, deepMerge } from '../src/lib/util.js';

test('api key shape', () => {
  const k = generateApiKey('pk', 'live');
  assert.match(k.raw, /^pk_live_[0-9a-z]{32}$/);
  assert.equal(k.prefix, k.raw.slice(0, 12));
  assert.deepEqual(parseKeyShape(k.raw), { type: 'pk', mode: 'live' });
  assert.equal(parseKeyShape('pk_live_short'), null);
});

test('scopes', () => {
  assert.ok(hasScope('["*"]', 'gdpr'));
  assert.ok(hasScope('["webinars:write"]', 'webinars:read'));
  assert.ok(!hasScope('["webinars:read"]', 'webinars:write'));
  assert.ok(hasScope('["webinars:*"]', 'webinars:write'));
  assert.ok(!hasScope('["moderation"]', 'gdpr'));
});

test('origin lock', () => {
  assert.ok(originMatches('https://www.example.com', 'https://www.example.com/'));
  assert.ok(originMatches('https://a.example.com', 'https://*.example.com'));
  assert.ok(!originMatches('https://example.com.evil.io', 'https://*.example.com'));
  assert.ok(!originMatches('http://a.example.com', 'https://*.example.com'));
  assert.ok(!isOriginAllowed(null, ['https://x.com']));
  assert.ok(!isOriginAllowed('null', ['https://x.com']));
});

test('session tokens: signed, typed, expiring', async () => {
  const now = Date.parse('2026-11-10T12:00:00Z');
  const t = await mintSessionToken('s3cret', { rid: 'r', sid: 's', wid: 'w', bid: 'b', mode: 'live', dev: 'd' }, now);
  assert.equal((await readSessionToken('s3cret', t, now))?.rid, 'r');
  assert.equal(await readSessionToken('other', t, now), null, 'wrong secret');
  assert.equal(await readSessionToken('s3cret', t, now + 4 * 3600_000 + 1000), null, 'expired after 4h');
  assert.equal(await readHostToken('s3cret', t, now), null, 'session token is not a host token');
  const [body, sig] = t.split('.');
  const forged = Buffer.from(JSON.stringify({ typ: 'sess', rid: 'someone-else', exp: 9e9 })).toString('base64url');
  assert.equal(await readSessionToken('s3cret', `${forged}.${sig}`, now), null, 'tampered body');
  assert.ok(body);
  assert.equal(await verifyToken('s3cret', 'garbage', 'sess'), null);
  assert.ok(await verifyToken('k', await signToken('k', { typ: 'x', exp: 9e9 }), 'x'));
});

test('webhook signatures', async () => {
  const body = '{"id":"evt_1"}';
  const ts = 1_800_000_000;
  const header = await signWebhook('whsec', body, ts);
  assert.ok(await verifyWebhookSignature('whsec', header, body, ts + 10));
  assert.ok(!(await verifyWebhookSignature('whsec', header, body + ' ', ts)), 'body tamper');
  assert.ok(!(await verifyWebhookSignature('whsec', header, body, ts + 301)), 'replay window');
  assert.ok(!(await verifyWebhookSignature('nope', header, body, ts)));
});

test('AES-GCM secrets at rest', async () => {
  const key = Buffer.alloc(32, 1).toString('base64');
  const enc = await encryptSecret(key, 'whsec_abc');
  assert.notEqual(enc, 'whsec_abc');
  assert.equal(await decryptSecret(key, enc), 'whsec_abc');
  await assert.rejects(decryptSecret(Buffer.alloc(32, 2).toString('base64'), enc));
});

test('csv escapes and neutralises formulas', () => {
  const csv = toCsv([{ a: '=HYPERLINK("x")', b: 'one, two', c: null }]);
  assert.equal(csv, 'a,b,c\n"\'=HYPERLINK(""x"")","one, two",\n');
});

test('deepMerge: objects merge, arrays replace', () => {
  assert.deepEqual(deepMerge({ a: { b: 1, c: [1, 2] } }, { a: { c: [3] } }), { a: { b: 1, c: [3] } });
});
