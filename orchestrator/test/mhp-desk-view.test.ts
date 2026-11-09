import test from 'node:test';
import assert from 'node:assert/strict';
import { MHP_CALCULATORS, calculateMhpDeal } from '../src/mhp/calculators.js';
import { calculatorPage, deskPage, verdictPage, verdictQueuePage } from '../src/mhp/desk-view.js';
import type { MhpDeskSnapshot, MhpDealFile } from '../src/mhp/desk-service.js';

const csrf = 'synthetic-csrf-only';
const snapshot = (): MhpDeskSnapshot => ({ access: { calculators: true, crm: true, readOnly: false, isAdmin: false, deskWriteEndsAt: '2026-11-27T12:00:00Z' },
  files: [], selected: null, lifetimeFileCount: 0, fileLimit: 3, verdict: null, canSubmitVerdict: true });
const inputs = { rooms: 6, room_rent_weekly: 125, bills_per_room_monthly: 75, management_pct: 10, voids_pct: 6, maintenance_pct: 8,
  compliance_annual: 800, insurance_annual: 450, yield_pct: 8, valuation_basis: 'net' };
const file = (): MhpDealFile => ({ id: '63000000-0000-4000-8000-000000000001', title: 'Station Road HMO', calculator: 'hmo',
  property: { address: '10 Station Road', notes: 'Check the rent evidence.' }, inputs, result: calculateMhpDeal('hmo', inputs), formulaVersion: 'mhp-2026-10-28.1',
  archived: false, version: 2, createdAt: '2026-10-28T12:00:00Z', updatedAt: '2026-10-28T12:00:00Z' });
const saveButton = (html: string): string => html.match(/<button[^>]*name="action" value="save"[^>]*>/)?.[0] ?? '';

test('all five rendered calculators expose only explicit input fields, source units and CSRF-protected actions', () => {
  for (const definition of MHP_CALCULATORS) {
    const html = calculatorPage({ snapshot: snapshot(), csrf, calculator: definition.id });
    assert.ok(html.includes(`action="/app/calculators/${definition.id}"`));
    assert.ok(html.includes('name="csrf" value="synthetic-csrf-only"'));
    assert.ok(html.includes('name="commandId"'));
    for (const field of definition.fields) {
      assert.ok(html.includes(`name="input_${field.key}"`), field.key);
      if (field.unit) assert.ok(html.includes(field.unit), field.unit);
      if (field.kind === 'select') assert.ok(html.includes('<option value="">Choose…</option>'));
    }
    assert.ok(!saveButton(html).includes('disabled'));
    assert.ok(!html.includes('<script'));
  }
});

test('saved inputs, title, address, notes and version return to the form alongside the saved result', () => {
  const saved = file(), state = snapshot(); state.files = [saved]; state.selected = saved; state.lifetimeFileCount = 1;
  const html = calculatorPage({ snapshot: state, csrf, calculator: 'hmo' });
  assert.ok(html.includes('name="input_rooms" type="number" inputmode="decimal" value="6"'));
  assert.ok(html.includes('<option value="net" selected>'));
  assert.ok(html.includes('name="title" maxlength="120" value="Station Road HMO"'));
  assert.ok(html.includes('>10 Station Road</textarea>'));
  assert.ok(html.includes('>Check the rent evidence.</textarea>'));
  assert.ok(html.includes('name="version" value="2"'));
  assert.ok(html.includes('£287,375.00'));
  assert.ok(html.includes('saved result'));
  assert.ok(html.includes('Updating this file does not use another slot.'));
});

test('posted numeric strings and explicit zero survive validation redisplay with entered notes', () => {
  const html = calculatorPage({ snapshot: snapshot(), csrf, calculator: 'hmo', error: 'Check yield.', errorField: 'yield_pct', values: {
    input_rooms: '6', input_room_rent_weekly: '125.50', input_management_pct: '0', input_valuation_basis: 'gross', input_yield_pct: '0',
    title: 'My draft', address: 'Address entered', notes: 'Keep these notes',
  } });
  assert.ok(html.includes('value="125.50"'));
  assert.ok(html.includes('name="input_management_pct" type="number" inputmode="decimal" value="0"'));
  assert.ok(html.includes('<option value="gross" selected>'));
  assert.ok(html.includes('aria-invalid="true"'));
  assert.ok(html.includes('>Keep these notes</textarea>'));
  assert.ok(html.includes('role="alert"'));
});

test('three lifetime files blocks only new saves, while archived and read-only states cannot save', () => {
  const state = snapshot(); state.lifetimeFileCount = 3;
  const full = calculatorPage({ snapshot: state, csrf, calculator: 'hmo' });
  assert.ok(saveButton(full).includes('disabled'));
  assert.ok(full.includes('three-file allowance is full'));
  state.selected = file();
  assert.ok(!saveButton(calculatorPage({ snapshot: state, csrf, calculator: 'hmo' })).includes('disabled'));
  state.selected.archived = true;
  const archived = calculatorPage({ snapshot: state, csrf, calculator: 'hmo' });
  assert.ok(saveButton(archived).includes('disabled'));
  assert.ok(archived.includes('Restore file'));
  assert.ok(archived.includes('still count towards your lifetime allowance'));
  state.access.readOnly = true;
  const expired = calculatorPage({ snapshot: state, csrf, calculator: 'hmo' });
  assert.ok(saveButton(expired).includes('disabled'));
  assert.ok(!expired.includes('action="/app/deals/archive"'));
  assert.ok(expired.includes('name="action" value="calculate"'));
});

test('Desk dashboard accurately explains the lifetime cap and archived files', () => {
  const state = snapshot(); state.files = [{ ...file(), archived: true }]; state.lifetimeFileCount = 3;
  const html = deskPage({ snapshot: state, csrf });
  assert.ok(html.includes('3 of 3 lifetime files used'));
  assert.ok(html.includes('Three files in total.'));
  assert.ok(html.includes('archiving does not free a slot'));
  assert.ok(html.includes('Archived · still counts'));
  assert.equal((html.match(/Open calculator/g) ?? []).length, 5);
});

test('all customer-supplied text is escaped in files, calculator errors and owner verdict views', () => {
  const attack = '<img src=x onerror=alert(1)>"&';
  const saved = file(); saved.title = attack; saved.property.address = attack; saved.property.notes = attack;
  const state = snapshot(); state.selected = saved; state.files = [saved];
  const verdict = { id: saved.id, status: 'reviewed', answers: { experience: attack, budget: attack, weeklyTime: attack, areas: attack, goals: attack, questions: attack },
    dueAt: '2026-11-04T12:00:00Z', submittedAt: '2026-10-28T12:00:00Z', response: attack, reviewedAt: '2026-10-29T12:00:00Z', version: 2 };
  state.verdict = verdict;
  for (const html of [deskPage({ snapshot: state, csrf, message: attack }), calculatorPage({ snapshot: state, csrf, calculator: 'hmo', error: attack }),
    verdictPage({ snapshot: state, csrf }), verdictQueuePage({ queue: { requests: [{ ...verdict, memberName: attack, memberEmail: attack }] }, csrf })]) {
    assert.ok(!html.includes('<img src=x'));
    assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;&quot;&amp;'));
  }
});

test('verdict intake and owner response carry separate CSRF/command fields and the agreed working-day wording', () => {
  const state = snapshot();
  const intake = verdictPage({ snapshot: state, csrf });
  assert.ok(intake.includes('action="/app/verdict"'));
  assert.ok(intake.includes('name="csrf" value="synthetic-csrf-only"'));
  assert.ok(intake.includes('counting Monday to Friday'));
  assert.ok(intake.includes('name="confirm" value="yes" required'));
  const queue = verdictQueuePage({ queue: { requests: [{ id: file().id, status: 'submitted', answers: {}, dueAt: '2026-11-04T12:00:00Z', submittedAt: '2026-10-28T12:00:00Z',
    response: null, reviewedAt: null, version: 1, memberName: 'Preview member', memberEmail: 'member@example.invalid' }] }, csrf });
  assert.ok(queue.includes('action="/hq/verdicts/review"'));
  assert.ok(queue.includes('name="csrf" value="synthetic-csrf-only"'));
  assert.ok(queue.includes('name="verdictId"'));
  assert.ok(queue.includes('name="version" value="1"'));
});
