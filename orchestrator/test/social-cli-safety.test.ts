import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  runSocialCli,
  SOCIAL_PROVIDER_EFFECTS_SWITCH,
} from '../src/social/cli.js';
import { MockPublisher } from '../src/social/mock.js';
import type { SocialPublisher } from '../src/social/types.js';
import { validIntake } from './helpers.js';

function fixtureRun(t: TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r72-social-cli-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'intake.json'), JSON.stringify(validIntake()), 'utf8');
  fs.writeFileSync(path.join(dir, 's2.json'), '{}', 'utf8');
  fs.writeFileSync(path.join(dir, 's3.json'), '{}', 'utf8');
  fs.writeFileSync(path.join(dir, 's8.json'), JSON.stringify({
    platform_a: 'Facebook',
    platform_b: 'Instagram',
    posts: [{
      day: 1,
      platform: 'Facebook',
      format: 'text post',
      hook: 'A quick, honest note about the work',
      body: 'Everything is priced in writing before anything starts.',
      cta: 'Send us a message',
      pillar: 'teach',
    }],
  }), 'utf8');
  return dir;
}

function args(runDir: string, ...extra: string[]): string[] {
  return ['--run', runDir, '--schedule', '2026-08-01', ...extra];
}

function readPlan(runDir: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(runDir, 'social-plan.json'), 'utf8')) as Record<string, unknown>;
}

test('ordinary scheduling is a dry-run even when the old global switch is exact true', async (t) => {
  const runDir = fixtureRun(t);
  const code = await runSocialCli(args(runDir), {
    env: { [SOCIAL_PROVIDER_EFFECTS_SWITCH]: 'true' },
    createMockPublisher: () => new MockPublisher(),
    log: () => undefined,
  });

  assert.equal(code, 0);
  const plan = readPlan(runDir);
  assert.equal(plan.backend, 'mock');
  assert.equal(plan.action, 'preview_schedule');
  assert.equal(plan.provider_effects, 'none');
  assert.equal(plan.approval, null);
  assert.equal(plan.idempotency_sha256, null);
});

test('--publish remains a mock preview and cannot select a live adapter', async (t) => {
  const runDir = fixtureRun(t);
  await runSocialCli(args(runDir, '--publish'), {
    env: { [SOCIAL_PROVIDER_EFFECTS_SWITCH]: 'true' },
    createMockPublisher: () => new MockPublisher(),
    log: () => undefined,
  });

  const plan = readPlan(runDir);
  assert.equal(plan.backend, 'mock');
  assert.equal(plan.action, 'preview_publish');
  assert.equal(plan.provider_effects, 'none');
});

test('every provider-effect-shaped argument fails before reading files or constructing an adapter', async () => {
  let constructions = 0;
  const runtime = {
    env: { [SOCIAL_PROVIDER_EFFECTS_SWITCH]: 'true' },
    createMockPublisher: (): SocialPublisher => {
      constructions += 1;
      return new MockPublisher();
    },
    log: (): void => undefined,
  };
  const missingRun = path.join(os.tmpdir(), 'r72-social-cli-file-must-not-be-read');
  const cases = [
    ['--execute-provider-effects'],
    ['--approval-id', 'approval_fixture_001'],
    ['--approval-sha256', 'a'.repeat(64)],
    ['--idempotency-key', 'social-batch-fixture-001'],
    [
      '--execute-provider-effects',
      '--approval-id', 'approval_fixture_001',
      '--approval-sha256', 'a'.repeat(64),
      '--idempotency-key', 'social-batch-fixture-001',
    ],
  ];
  for (const effectArgs of cases) {
    await assert.rejects(
      runSocialCli(args(missingRun, ...effectArgs), runtime),
      /live social provider effects are unavailable/,
    );
  }
  assert.equal(constructions, 0);
});

test('legacy social CLI source contains no live adapter import or provider construction seam', async () => {
  const source = await fs.promises.readFile(
    new URL('../src/social/cli.ts', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(source, /from ['"]\.\/ayrshare\.js['"]/);
  assert.doesNotMatch(source, /createLivePublisher|new AyrsharedPublisher|provider_effects:\s*['"]executed['"]/);
});
