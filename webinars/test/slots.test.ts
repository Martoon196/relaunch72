import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isRuleSlot, upcomingSlots, zonedToUtc, type SlotRule } from '../src/lib/slots.js';

test('fixed Tue/Thu 7pm London — handles GMT and BST', () => {
  const rule: SlotRule = { kind: 'fixed', rule: { days: [2, 4], times: ['19:00'] }, timezone: 'Europe/London' };
  // Monday 9 Nov 2026 (GMT)
  const slots = upcomingSlots([rule], Date.parse('2026-11-09T10:00:00Z'), 4);
  assert.deepEqual(slots, ['2026-11-10T19:00:00.000Z', '2026-11-12T19:00:00.000Z', '2026-11-17T19:00:00.000Z', '2026-11-19T19:00:00.000Z']);
  // In summer, 7pm BST = 18:00Z. Mon 6 Jul 2026 → Tue 7 Jul.
  const summer = upcomingSlots([rule], Date.parse('2026-07-06T10:00:00Z'), 1);
  assert.deepEqual(summer, ['2026-07-07T18:00:00.000Z']);
});

test('fixed rule across the October DST change', () => {
  const rule: SlotRule = { kind: 'fixed', rule: { times: ['19:00'] }, timezone: 'Europe/London' };
  const slots = upcomingSlots([rule], Date.parse('2026-10-24T00:00:00Z'), 2); // clocks go back 25 Oct
  assert.deepEqual(slots, ['2026-10-24T18:00:00.000Z', '2026-10-25T19:00:00.000Z']);
});

test('one-off fixed dates in another timezone', () => {
  const rule: SlotRule = { kind: 'fixed', rule: { dates: ['2026-12-01T09:30'] }, timezone: 'America/New_York' };
  assert.deepEqual(upcomingSlots([rule], Date.parse('2026-11-01T00:00:00Z'), 3), ['2026-12-01T14:30:00.000Z']);
});

test('interval rule within a daily window', () => {
  const rule: SlotRule = { kind: 'interval', rule: { every_minutes: 120, from: '09:00', to: '13:00' }, timezone: 'UTC' };
  const slots = upcomingSlots([rule], Date.parse('2026-11-09T10:00:00Z'), 4);
  assert.deepEqual(slots, ['2026-11-09T11:00:00.000Z', '2026-11-09T13:00:00.000Z', '2026-11-10T09:00:00.000Z', '2026-11-10T11:00:00.000Z']);
});

test('just-in-time: next slot always within the interval', () => {
  const rule: SlotRule = { kind: 'just_in_time', rule: { every_minutes: 15 }, timezone: 'UTC' };
  const now = Date.parse('2026-11-09T10:07:12Z');
  const slots = upcomingSlots([rule], now, 5);
  assert.deepEqual(slots, ['2026-11-09T10:15:00.000Z', '2026-11-09T10:30:00.000Z']);
  assert.ok(Date.parse(slots[0]!) - now <= 15 * 60_000);
});

test('rules merge, de-duplicate and sort', () => {
  const a: SlotRule = { kind: 'fixed', rule: { times: ['19:00'] }, timezone: 'UTC' };
  const b: SlotRule = { kind: 'fixed', rule: { times: ['19:00', '12:00'] }, timezone: 'UTC' };
  assert.deepEqual(upcomingSlots([a, b], Date.parse('2026-11-09T00:00:00Z'), 3), ['2026-11-09T12:00:00.000Z', '2026-11-09T19:00:00.000Z', '2026-11-10T12:00:00.000Z']);
});

test('isRuleSlot accepts generated slots only', () => {
  const rule: SlotRule = { kind: 'fixed', rule: { days: [2], times: ['19:00'] }, timezone: 'Europe/London' };
  const now = Date.parse('2026-11-09T10:00:00Z');
  assert.equal(isRuleSlot([rule], '2026-11-10T19:00:00.000Z', now), true);
  assert.equal(isRuleSlot([rule], '2026-11-10T19:05:00.000Z', now), false);
  assert.equal(isRuleSlot([rule], '2026-11-03T19:00:00.000Z', now), false, 'past slot');
  assert.equal(isRuleSlot([rule], 'not a date', now), false);
});

test('zonedToUtc', () => {
  assert.equal(new Date(zonedToUtc(2026, 3, 29, 1, 30, 'Europe/London')).toISOString(), '2026-03-29T01:30:00.000Z'); // non-existent → rolls forward
  assert.equal(new Date(zonedToUtc(2026, 1, 15, 9, 0, 'Asia/Tokyo')).toISOString(), '2026-01-15T00:00:00.000Z');
});
