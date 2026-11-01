import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { idleUntilShutdown } from '../src/workers/seo-blog/lifecycle.js';

test('disabled worker lifecycle releases its keepalive and both signal listeners on SIGTERM', async () => {
  const termBefore = process.listenerCount('SIGTERM');
  const intBefore = process.listenerCount('SIGINT');
  const waiting = idleUntilShutdown();
  assert.equal(process.listenerCount('SIGTERM'), termBefore + 1);
  assert.equal(process.listenerCount('SIGINT'), intBefore + 1);
  process.emit('SIGTERM');
  await waiting;
  assert.equal(process.listenerCount('SIGTERM'), termBefore);
  assert.equal(process.listenerCount('SIGINT'), intBefore);
});

test('disabled CLI stays alive without database configuration until the shutdown handler fires', async () => {
  const env = { ...process.env, SEO_BLOG_ENABLED: '', DATABASE_CONTENT_COMMAND_URL: 'deliberately-invalid' };
  const child = spawn(process.execPath, [
    '--import', './test/windows-node24-shim.mjs', '--import', 'tsx', '--input-type=module', '-e',
    `await import('./src/workers/seo-blog/cli.ts');
     setTimeout(() => { console.log('disabled-worker-still-alive'); process.emit('SIGTERM'); }, 300);`,
  ], { cwd: fileURLToPath(new URL('../', import.meta.url)), env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', errors = '';
  child.stdout.on('data', (data: Buffer) => { output += data.toString(); });
  child.stderr.on('data', (data: Buffer) => { errors += data.toString(); });
  const killTimer = setTimeout(() => child.kill(), 15_000);
  try {
    const [code] = await once(child, 'exit');
    assert.equal(code, 0, errors);
    assert.match(output, /disabled; idle with no database or provider activity/);
    assert.match(output, /disabled-worker-still-alive/);
    assert.equal(errors, '');
  } finally { clearTimeout(killTimer); child.kill(); }
});
