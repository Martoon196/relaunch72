import assert from 'node:assert/strict';
import test from 'node:test';
import {
  exactReviewApprovalToken,
  verifyExactReviewApprovalToken,
} from '../src/portal/content-control-room-actions.js';

const SECRET = 'test-session-secret-with-enough-entropy';
const SESSION = 'opaque-portal-session';
const NOW = Date.parse('2026-08-29T09:00:00.000Z');
const exact = Object.freeze({
  contentItemId: '11111111-1111-4111-8111-111111111111',
  contentVersionId: '22222222-2222-4222-8222-222222222222',
  approvalRequestId: '33333333-3333-4333-8333-333333333333',
  contentSha256: 'a'.repeat(64),
});

test('exact-review approval capability is session and immutable-version bound', () => {
  const token = exactReviewApprovalToken(SECRET, SESSION, exact, NOW);
  assert.match(token, /^[A-Za-z0-9._-]+$/u);
  assert.equal(verifyExactReviewApprovalToken(SECRET, SESSION, token, exact, NOW), true);
  assert.equal(verifyExactReviewApprovalToken(SECRET, 'another-session', token, exact, NOW), false);
  assert.equal(verifyExactReviewApprovalToken(SECRET, SESSION, token, {
    ...exact,
    contentSha256: 'b'.repeat(64),
  }, NOW), false);
  assert.equal(verifyExactReviewApprovalToken(SECRET, SESSION, token, {
    ...exact,
    approvalRequestId: '44444444-4444-4444-8444-444444444444',
  }, NOW), false);
});

test('exact-review approval capability expires and rejects malformed input', () => {
  const token = exactReviewApprovalToken(SECRET, SESSION, exact, NOW);
  assert.equal(verifyExactReviewApprovalToken(
    SECRET,
    SESSION,
    token,
    exact,
    NOW + (15 * 60 * 1_000) + 1,
  ), false);
  assert.equal(verifyExactReviewApprovalToken(SECRET, SESSION, `${token}x`, exact, NOW), false);
  assert.equal(verifyExactReviewApprovalToken(SECRET, SESSION, undefined, exact, NOW), false);
});
