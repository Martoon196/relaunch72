import assert from 'node:assert/strict';
import test from 'node:test';
import {
  propertyPredatorMailgunReplyAddress,
  propertyPredatorMailgunReplyDigest,
  propertyPredatorMailgunReplyToken,
} from '../src/providers/property-predator-mailgun-reply-correlation.js';

test('full SHA-256 reply correlation round-trips inside the SMTP local-part limit', () => {
  for (const digest of ['00'.repeat(32), 'ab'.repeat(32), 'ff'.repeat(32)]) {
    const token = propertyPredatorMailgunReplyToken(digest);
    const address = propertyPredatorMailgunReplyAddress(digest, 'MG.PropertyPredator.com');
    assert.equal(token.length, 52);
    assert.match(token, /^[a-z2-7]{52}$/);
    assert.equal(propertyPredatorMailgunReplyDigest(token), digest);
    assert.equal(address, `reply+${token}@mg.propertypredator.com`);
    assert.ok(Buffer.byteLength(address.split('@')[0]!, 'ascii') <= 64);
  }
});

test('reply correlation rejects truncation, non-canonical padding and malformed digests', () => {
  const token = propertyPredatorMailgunReplyToken('12'.repeat(32));
  for (const malformed of [token.slice(0, -1), `${token}=`, token.toUpperCase(), `${token.slice(0, -1)}9`]) {
    assert.throws(() => propertyPredatorMailgunReplyDigest(malformed), /correlation token/);
  }
  const nonCanonicalTail = `${token.slice(0, -1)}b`;
  assert.throws(() => propertyPredatorMailgunReplyDigest(nonCanonicalTail), /non-canonical/);
  assert.throws(() => propertyPredatorMailgunReplyToken('a'.repeat(63)), /canonical SHA-256/);
});
