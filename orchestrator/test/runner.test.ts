import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runStage } from '../src/stages/runner.js';
import { STAGES } from '../src/stages/defs.js';
import { MockClient } from '../src/llm/mock.js';
import { validIntake } from './helpers.js';

function tmpRunDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'relaunch72-test-'));
}

const intake = validIntake();

test('runStage passes cleanly on first attempt with a healthy mock', async () => {
  const runDir = tmpRunDir();
  const { record, output } = await runStage(STAGES.S2!, intake, {}, { runDir, client: new MockClient(intake) });
  assert.equal(record.status, 'passed');
  assert.equal(record.attempts.length, 1);
  assert.notEqual(output, null);
  assert.ok(fs.existsSync(path.join(runDir, 's2.json')));
  assert.ok(fs.existsSync(path.join(runDir, 's2-attempt-1.txt')));
  assert.equal(record.prompt_version, '1.0.0');
});

test('runStage retries once with critique after a failing first attempt, then passes', async () => {
  const runDir = tmpRunDir();
  const client = new MockClient(intake, { failStages: ['S2'] });
  const { record, output } = await runStage(STAGES.S2!, intake, {}, { runDir, client });
  assert.equal(record.status, 'passed');
  assert.equal(record.attempts.length, 2);
  const first = record.attempts[0]!;
  assert.ok(first.schema_errors.length + first.qa_issues.length > 0, 'first attempt must have recorded failures');
  assert.notEqual(output, null);
});

test('runStage QA-fails an S1 with invented numbers and no verbatim, then recovers on retry', async () => {
  const runDir = tmpRunDir();
  const client = new MockClient(intake, { failStages: ['S1'] });
  const { record } = await runStage(STAGES.S1!, intake, {}, { runDir, client });
  assert.equal(record.status, 'passed');
  assert.equal(record.attempts.length, 2);
  const checks = record.attempts[0]!.qa_issues.map((i) => i.check);
  assert.ok(checks.includes('s1.evidence_not_verbatim'));
  assert.ok(checks.includes('s1.leak_number_invented'));
});

test('runStage parks after a second failure (retry policy: one retry, then human queue)', async () => {
  const runDir = tmpRunDir();
  const client = new MockClient(intake, { alwaysFailStages: ['S2'] });
  const { record, output } = await runStage(STAGES.S2!, intake, {}, { runDir, client });
  assert.equal(record.status, 'parked');
  assert.equal(record.attempts.length, 2);
  assert.equal(output, null);
  assert.ok(record.flags.some((f) => f.includes('parked for human queue')));
  assert.equal(record.output_file, null);
});

test('runStage parks IMMEDIATELY on a fatal (no-invention) QA issue — no retry', async () => {
  const runDir = tmpRunDir();
  const fatalDef = {
    ...STAGES.S2!,
    qa: () => [{ check: 'no_invention.fabricated_testimonial', message: 'invented quote', fatal: true }],
  };
  const { record, output } = await runStage(fatalDef, intake, {}, { runDir, client: new MockClient(intake) });
  assert.equal(record.status, 'parked');
  assert.equal(record.attempts.length, 1, 'fatal issues must not trigger the retry');
  assert.equal(output, null);
  assert.ok(record.flags.some((f) => f.includes('no_invention') && f.includes('NO retry')));
});
