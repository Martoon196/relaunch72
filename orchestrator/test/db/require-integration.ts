import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { once } from 'node:events';
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

const integrationFiles = (await readdir(new URL('.', import.meta.url)))
  .filter((filename) => filename.endsWith('.integration.test.ts'))
  .sort()
  .map((filename) => `test/db/${filename}`);

if (integrationFiles.length < 20
    || !integrationFiles.includes('test/db/public-social-campaign.integration.test.ts')) {
  throw new Error('disposable integration test discovery is incomplete');
}

const child = spawn(process.execPath, [
  '--import', './test/windows-node24-shim.mjs',
  '--import', 'tsx',
  '--test',
  '--test-concurrency=1',
  ...integrationFiles,
], {
  cwd: process.cwd(),
  env: process.env,
  stdio: 'inherit',
  windowsHide: true,
});

const [code, signal] = await once(child, 'exit') as [number | null, NodeJS.Signals | null];
if (code !== 0) {
  throw new Error(`disposable integration suite failed (${signal ?? code ?? 'unknown'})`);
}
