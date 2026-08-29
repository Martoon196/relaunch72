import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  CONTACT_PERMISSION_DECISIONS,
  CONTACT_PERMISSION_EVIDENCE_SOURCES,
  CONTACT_PERMISSION_FORBIDDEN_INFERENCES,
  ContactPermissionError,
  deriveContactPermissionCommandKey,
  parseContactPermissionDecision,
  type ContactPermissionDecisionInput,
} from '../src/contact-permission/foundation.js';

const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const CONTACT = '22222222-2222-4222-8222-222222222222';
const POINT = '33333333-3333-4333-8333-333333333333';
const COMMAND_KEY = '44444444-4444-4444-8444-444444444444';

function decision(
  overrides: Partial<ContactPermissionDecisionInput> = {},
): ContactPermissionDecisionInput {
  return {
    contactId: CONTACT,
    contactPointId: POINT,
    channel: 'email',
    purpose: 'property_predator_marketing',
    decision: 'granted',
    lawfulBasis: 'consent',
    evidenceSource: 'founder.written_confirmation',
    policyVersion: 'pp-privacy-2026-08',
    policyTextSha256: 'a'.repeat(64),
    sourceEventId: 'signed-form-4821',
    occurredAt: '2026-08-30T09:00:00.000Z',
    operatorConfirmed: true,
    ...overrides,
  };
}

test('a complete witnessed decision parses into the exact database tuple', () => {
  const parsed = parseContactPermissionDecision(decision());
  assert.deepEqual(parsed, Object.freeze({
    contactId: CONTACT,
    contactPointId: POINT,
    channel: 'email',
    purpose: 'property_predator_marketing',
    decision: 'granted',
    lawfulBasis: 'consent',
    evidenceSource: 'founder.written_confirmation',
    policyVersion: 'pp-privacy-2026-08',
    policyTextSha256: 'a'.repeat(64),
    sourceEventId: 'signed-form-4821',
    occurredAt: '2026-08-30T09:00:00.000Z',
  }));
  assert.deepEqual([...CONTACT_PERMISSION_DECISIONS], ['granted', 'denied', 'withdrawn']);
});

test('an unconfirmed decision is refused before it can reach the ledger', () => {
  // Recording permission is a deliberate legal act, so the confirmation is a
  // precondition rather than a UI nicety.
  assert.throws(
    () => parseContactPermissionDecision(decision({ operatorConfirmed: false })),
    ContactPermissionError,
  );
  assert.throws(
    () => parseContactPermissionDecision(
      decision({ operatorConfirmed: 'yes' as unknown as boolean }),
    ),
    ContactPermissionError,
  );
});

test('permission is never inferred from activity, stage or history', () => {
  for (const inferred of CONTACT_PERMISSION_FORBIDDEN_INFERENCES) {
    assert.equal(
      (CONTACT_PERMISSION_EVIDENCE_SOURCES as readonly string[]).includes(inferred),
      false,
      `${inferred} must never be an evidence source`,
    );
    assert.throws(
      () => parseContactPermissionDecision(decision({ evidenceSource: inferred })),
      ContactPermissionError,
      `${inferred} must be refused as evidence`,
    );
  }
  // Every offered source names something a human witnessed.
  for (const source of CONTACT_PERMISSION_EVIDENCE_SOURCES) {
    assert.match(source, /^founder\./u);
  }
});

test('a grant carries its lawful basis and a denial or withdrawal never does', () => {
  assert.throws(
    () => parseContactPermissionDecision(decision({ lawfulBasis: null })),
    ContactPermissionError,
  );
  for (const state of ['denied', 'withdrawn'] as const) {
    assert.throws(
      () => parseContactPermissionDecision(decision({ decision: state })),
      ContactPermissionError,
      `${state} must not carry a lawful basis`,
    );
    const parsed = parseContactPermissionDecision(
      decision({ decision: state, lawfulBasis: null }),
    );
    assert.equal(parsed.decision, state);
    assert.equal(parsed.lawfulBasis, null);
  }
});

test('malformed identifiers, purposes, digests and instants are refused', () => {
  const rejected: Partial<ContactPermissionDecisionInput>[] = [
    { contactId: 'not-a-uuid' },
    { contactPointId: '33333333-3333-4333-8333-33333333333' },
    { channel: 'social_dm' },
    { channel: 'phone' },
    { purpose: 'Property_Predator' },
    { purpose: '' },
    { decision: 'revoked' },
    { lawfulBasis: 'because_i_said_so' },
    { policyVersion: 'a'.repeat(101) },
    { policyTextSha256: 'A'.repeat(64) },
    { policyTextSha256: 'a'.repeat(63) },
    { occurredAt: '2026-08-30T09:00:00Z' },
    { occurredAt: 'yesterday' },
  ];
  for (const override of rejected) {
    assert.throws(
      () => parseContactPermissionDecision(decision(override)),
      ContactPermissionError,
      `${JSON.stringify(override)} must be refused`,
    );
  }
});

test('optional evidence fields may be absent without weakening the decision', () => {
  const parsed = parseContactPermissionDecision(decision({
    policyVersion: null, policyTextSha256: null, sourceEventId: null,
  }));
  assert.equal(parsed.policyVersion, null);
  assert.equal(parsed.policyTextSha256, null);
  assert.equal(parsed.sourceEventId, null);
});

test('the command key digest is workspace-scoped and stable', () => {
  const derived = deriveContactPermissionCommandKey(WORKSPACE, COMMAND_KEY);
  assert.match(derived, /^[0-9a-f]{64}$/u);
  assert.equal(derived, deriveContactPermissionCommandKey(WORKSPACE, COMMAND_KEY));
  assert.equal(
    derived,
    createHash('sha256').update([
      'propertypredator.contact-permission-command/v1', WORKSPACE, COMMAND_KEY,
    ].join(String.fromCharCode(31)), 'utf8').digest('hex'),
  );
  // The same operator key in another workspace is a different key, so one
  // tenant's replay can never collide with another's decision.
  assert.notEqual(
    derived,
    deriveContactPermissionCommandKey('55555555-5555-4555-8555-555555555555', COMMAND_KEY),
  );
  assert.throws(
    () => deriveContactPermissionCommandKey(WORKSPACE, 'not-a-key'),
    ContactPermissionError,
  );
});
