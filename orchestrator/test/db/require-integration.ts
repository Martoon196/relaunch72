import '../../src/config.js';
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
await import('./property-predator-snapshot.integration.test.js');
await import('./legacy-lead-board-materialization.integration.test.js');
await import('./company-content.integration.test.js');
await import('./inbox-provider.integration.test.js');
await import('./property-predator-email-pilot.integration.test.js');
await import('./property-predator-founder-bootstrap.integration.test.js');
await import('./operator-action-control.integration.test.js');
await import('./property-predator-sso.integration.test.js');
await import('./brand-brain.integration.test.js');
await import('./affiliate-compliance.integration.test.js');
await import('./company-asset.integration.test.js');
