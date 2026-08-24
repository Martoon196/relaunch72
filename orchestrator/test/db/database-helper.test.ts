import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertDisposableTestDatabase,
  DISPOSABLE_BRANCH_CONFIRMATION,
} from './database-helper.js';

const safeUrl = 'postgresql://owner:secret@ep-disposable.neon.tech/relaunch72_test?sslmode=verify-full&channel_binding=require';

test('destructive database proof requires both a test-named database and explicit branch reset confirmation', () => {
  assert.doesNotThrow(() => assertDisposableTestDatabase(safeUrl, DISPOSABLE_BRANCH_CONFIRMATION));
  assert.throws(
    () => assertDisposableTestDatabase(safeUrl, undefined),
    /isolated disposable branch\/project/,
  );
  assert.throws(
    () => assertDisposableTestDatabase(
      'postgresql://owner:secret@ep-production.neon.tech/relaunch72?sslmode=verify-full',
      DISPOSABLE_BRANCH_CONFIRMATION,
    ),
    /standalone test segment/,
  );
});
