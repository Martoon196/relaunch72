import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePromptSource } from '../src/stages/prompt.js';

const lines = [
  '---',
  'version: 1.2.3',
  'stage: S-test',
  'model: test-model',
  'date: 2026-08-23',
  '---',
  'Write a truthful result.',
];

for (const [name, newline] of [['LF', '\n'], ['CRLF', '\r\n']] as const) {
  test(`prompt frontmatter parses ${name} line endings`, () => {
    const parsed = parsePromptSource(lines.join(newline), `test-${name}.md`);
    assert.deepEqual(parsed.header, {
      version: '1.2.3',
      stage: 'S-test',
      model: 'test-model',
      date: '2026-08-23',
    });
    assert.equal(parsed.body, 'Write a truthful result.');
    assert.match(parsed.sha256, /^[a-f0-9]{64}$/);
  });
}
