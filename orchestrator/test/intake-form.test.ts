import test from 'node:test';
import assert from 'node:assert/strict';
import { renderIntakeForm } from '../src/intake/form.js';
import { INTAKE_FIELDS } from '../src/intake/spec.js';

const html = renderIntakeForm();

function embeddedSpec(): { fields: Array<Record<string, unknown>>; sections: Array<{ id: string }> } {
  const m = html.match(/<script id="intake-spec" type="application\/json">([\s\S]*?)<\/script>/);
  assert.ok(m, 'form must embed the intake spec JSON');
  return JSON.parse(m![1]!);
}

test('form embeds every one of the 45 A1–H4 fields, in contract order', () => {
  const spec = embeddedSpec();
  assert.equal(spec.fields.length, 45);
  assert.deepEqual(
    spec.fields.map((f) => f.id),
    INTAKE_FIELDS.map((f) => f.id),
  );
});

test('form field kinds, required flags and options mirror the canonical spec (no drift)', () => {
  const spec = embeddedSpec();
  const byId = new Map(spec.fields.map((f) => [f.id as string, f]));
  for (const f of INTAKE_FIELDS) {
    const cf = byId.get(f.id)!;
    assert.equal(cf.kind, f.kind, `${f.id} kind`);
    assert.equal(cf.required, f.required === true, `${f.id} required`);
    if (f.minWords) assert.equal(cf.minWords, f.minWords, `${f.id} minWords`);
    if (f.options) assert.deepEqual(cf.options, f.options, `${f.id} options`);
    if (typeof f.required === 'object') assert.deepEqual(cf.requiredIf, f.required, `${f.id} conditional required`);
  }
});

test('every field carries customer-facing "why we ask" microcopy', () => {
  const spec = embeddedSpec();
  for (const f of spec.fields) {
    assert.equal(typeof f.why, 'string');
    assert.ok((f.why as string).length > 0, `${f.id} missing why-we-ask microcopy`);
  }
});

test('sliders and two-box fields carry their sub-keys for the payload contract', () => {
  const spec = embeddedSpec();
  const byId = new Map(spec.fields.map((f) => [f.id as string, f]));
  const h1 = byId.get('H1')! as { sliders: Array<{ key: string }> };
  assert.deepEqual(h1.sliders.map((s) => s.key), ['formal_casual', 'playful_straight', 'bold_understated']);
  const h3 = byId.get('H3')! as { boxes: Array<{ key: string }> };
  assert.deepEqual(h3.boxes.map((b) => b.key), ['never_use', 'must_use']);
});

test('form ships all eight sections and the consent gate', () => {
  const spec = embeddedSpec();
  assert.deepEqual(spec.sections.map((s) => s.id), ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']);
  assert.match(html, /id="consent"/);
  assert.match(html, /72-hour/);
});
