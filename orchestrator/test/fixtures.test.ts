import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { FIXTURES_DIR } from '../src/paths.js';
import { runS0 } from '../src/intake/s0.js';
import type { Intake } from '../src/types.js';

const EXPECTED = ['trades', 'coach', 'ecom'];

test('all three fixtures exist and pass the S0 intake gate', () => {
  for (const name of EXPECTED) {
    const file = path.join(FIXTURES_DIR, `${name}.json`);
    assert.ok(fs.existsSync(file), `missing fixture: ${name}.json`);
    const intake = JSON.parse(fs.readFileSync(file, 'utf8')) as Intake;
    const s0 = runS0(intake);
    assert.deepEqual(
      s0.issues,
      [],
      `fixture "${name}" should pass S0 cleanly:\n${s0.issues.map((i) => `${i.field}: ${i.reason}`).join('\n')}`,
    );
    assert.ok(
      typeof intake._fixture_notice === 'string' && intake._fixture_notice.includes('FICTIONAL'),
      `fixture "${name}" must carry the _fixture_notice marker (hard rule #1)`,
    );
  }
});
