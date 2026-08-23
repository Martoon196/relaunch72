import { assertDisposableTestDatabase } from './database-helper.js';

const rawUrl = process.env.TEST_DATABASE_URL?.trim();

if (!rawUrl) {
  throw new Error(
    'test:db:integration requires TEST_DATABASE_URL; no PostgreSQL integration test was run',
  );
}

assertDisposableTestDatabase(rawUrl);

// The ordinary test suite imports this file directly and may skip when no
// disposable database exists. The explicit integration command comes through
// this preflight so a green exit always means PostgreSQL was actually reached.
await import('./rls.integration.test.js');
