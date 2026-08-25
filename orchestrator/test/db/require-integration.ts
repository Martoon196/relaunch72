import {
  assertDisposableTestDatabase,
  DATABASE_INTEGRATION_CONFIRMATION,
} from './database-helper.js';

const rawUrl = process.env.TEST_DATABASE_URL?.trim();

if (!rawUrl) {
  throw new Error(
    'test:db:integration requires TEST_DATABASE_URL; no PostgreSQL integration test was run',
  );
}

assertDisposableTestDatabase(rawUrl);

// Ordinary `npm test` discovers the integration files but must never make a
// network/database run merely because a developer keeps TEST_DATABASE_URL in
// .env. Only this guarded preflight turns the real tests on, so a green explicit
// command always means PostgreSQL was actually reached.
process.env.RELAUNCH72_DATABASE_INTEGRATION = DATABASE_INTEGRATION_CONFIRMATION;
await import('./rls.integration.test.js');
await import('./conversion-rls.integration.test.js');
await import('./external-event-shadow.integration.test.js');
await import('./growth-evidence-rls.integration.test.js');
await import('./legacy-lead-import.integration.test.js');
