import test from 'node:test';
import assert from 'node:assert/strict';
import { runS0 } from '../src/intake/s0.js';
import { validIntake } from './helpers.js';

test('S0 accepts a fully valid intake', () => {
  const result = runS0(validIntake());
  assert.deepEqual(result.issues, []);
  assert.equal(result.accepted, true);
  assert.equal(result.action, 'accept');
});

test('S0 rejects missing required fields', () => {
  const result = runS0(validIntake({ C2: undefined, A1: '' }));
  assert.equal(result.accepted, false);
  assert.equal(result.action, 'nudge');
  const fields = result.issues.map((i) => i.field);
  assert.ok(fields.includes('C2'));
  assert.ok(fields.includes('A1'));
});

test('S0 enforces min-word thresholds', () => {
  const result = runS0(validIntake({ A2: 'too short answer' }));
  assert.equal(result.accepted, false);
  assert.ok(result.issues.some((i) => i.field === 'A2' && i.reason.includes('at least 8 words')));
});

test('S0 rejects placeholder echoes', () => {
  const result = runS0(
    validIntake({ A2: "I fit high-end kitchens for families in Kent who've been burned by cowboy builders" }),
  );
  assert.equal(result.accepted, false);
  assert.ok(result.issues.some((i) => i.field === 'A2' && i.reason.includes('copy of our example')));
});

test('S0 validates select options exactly', () => {
  const result = runS0(validIntake({ E4: 'somewhat premium' }));
  assert.equal(result.accepted, false);
  assert.ok(result.issues.some((i) => i.field === 'E4'));
});

test('S0 enforces F5 max two platforms', () => {
  const result = runS0(validIntake({ F5: ['Facebook', 'Instagram', 'LinkedIn'] }));
  assert.equal(result.accepted, false);
  assert.ok(result.issues.some((i) => i.field === 'F5' && i.reason.includes('at most 2')));
});

test('S0 requires F2 only when F1 includes the email list', () => {
  const withList = runS0(validIntake({ F2: '' }));
  assert.ok(withList.issues.some((i) => i.field === 'F2'));

  const withoutList = runS0(validIntake({ F1: ['website', 'SEO'], F2: '' }));
  assert.equal(withoutList.issues.some((i) => i.field === 'F2'), false);
});

test('S0 validates voice sliders range', () => {
  const result = runS0(validIntake({ H1: { formal_casual: 9, playful_straight: 2, bold_understated: 3 } }));
  assert.equal(result.accepted, false);
  assert.ok(result.issues.some((i) => i.field === 'H1'));
});

test('S0 flags unknown field IDs (contract violation)', () => {
  const result = runS0(validIntake({ Z9: 'what is this' }));
  assert.equal(result.accepted, false);
  assert.ok(result.issues.some((i) => i.field === 'Z9'));
});

test('S0 accepts B2 provided as a currency string', () => {
  const result = runS0(validIntake({ B2: '£1,250' }));
  assert.equal(result.accepted, true);
});
