import test from 'node:test';
import assert from 'node:assert/strict';
import { contactBody, BrevoError, type BrevoLike, type BrevoContact } from '../src/email/brevo.js';

test('contactBody maps a contact to the Brevo /v3/contacts body', () => {
  const b = contactBody({ email: 'sam@acme.com', firstName: 'Sam', listIds: [7], attributes: { SOURCE: 'scorecard' } });
  assert.equal(b.email, 'sam@acme.com');
  assert.deepEqual(b.listIds, [7]);
  assert.equal(b.updateEnabled, true); // upsert, not error-on-existing
  assert.deepEqual(b.attributes, { SOURCE: 'scorecard', FIRSTNAME: 'Sam' });
});

test('contactBody defaults listIds to [] and omits FIRSTNAME when absent', () => {
  const b = contactBody({ email: 'a@b.com' });
  assert.deepEqual(b.listIds, []);
  assert.deepEqual(b.attributes, {});
});

test('contactBody refuses an invalid email', () => {
  assert.throws(() => contactBody({ email: 'nope' }), BrevoError);
  assert.throws(() => contactBody({ email: '' }), BrevoError);
});

test('a BrevoLike client receives the upsert', async () => {
  const got: BrevoContact[] = [];
  const fake: BrevoLike = { upsertContact: async (c) => { got.push(c); } };
  await fake.upsertContact({ email: 'sam@acme.com', firstName: 'Sam', listIds: [7] });
  assert.equal(got.length, 1);
  assert.equal(got[0]!.email, 'sam@acme.com');
});
