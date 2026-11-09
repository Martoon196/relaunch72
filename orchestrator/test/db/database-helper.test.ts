import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertDisposableTestDatabase,
  DATABASE_INTEGRATION_CONFIRMATION,
  DISPOSABLE_BRANCH_CONFIRMATION,
  testDatabaseSkipReason,
} from './database-helper.js';

const safeUrl = 'postgresql://owner:secret@ep-disposable.neon.tech/relaunch72_test?sslmode=verify-full&channel_binding=require';

test('destructive database proof requires both a test-named database and explicit branch reset confirmation', () => {
  assert.doesNotThrow(() => assertDisposableTestDatabase(safeUrl, DISPOSABLE_BRANCH_CONFIRMATION));
  assert.throws(
    () => assertDisposableTestDatabase(safeUrl, ''),
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

test('ordinary test discovery cannot activate real PostgreSQL from a saved .env URL', () => {
  const previousUrl = process.env.TEST_DATABASE_URL;
  const previousConfirmation = process.env.RELAUNCH72_DATABASE_INTEGRATION;
  try {
    process.env.TEST_DATABASE_URL = safeUrl;
    delete process.env.RELAUNCH72_DATABASE_INTEGRATION;
    assert.match(String(testDatabaseSkipReason()), /explicit test:db:integration command/);

    process.env.RELAUNCH72_DATABASE_INTEGRATION = DATABASE_INTEGRATION_CONFIRMATION;
    assert.equal(testDatabaseSkipReason(), false);
  } finally {
    if (previousUrl === undefined) delete process.env.TEST_DATABASE_URL;
    else process.env.TEST_DATABASE_URL = previousUrl;
    if (previousConfirmation === undefined) delete process.env.RELAUNCH72_DATABASE_INTEGRATION;
    else process.env.RELAUNCH72_DATABASE_INTEGRATION = previousConfirmation;
  }
});
