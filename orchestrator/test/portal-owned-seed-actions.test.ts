import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { canonicalCompanyContentEmailDraft } from '../src/company-content-pg/index.js';
import {
  ownedSeedWorkflowToken,
  verifyOwnedSeedWorkflowToken,
  type OwnedSeedWorkflowState,
} from '../src/portal/owned-seed-actions.js';
import {
  PROPERTY_PREDATOR_OWNED_SEED_PROOF_BODY,
  PROPERTY_PREDATOR_OWNED_SEED_PROOF_SOURCE_ITEM,
  PROPERTY_PREDATOR_OWNED_SEED_PROOF_SOURCE_VERSION,
  PROPERTY_PREDATOR_OWNED_SEED_PROOF_SUBJECT,
  propertyPredatorOwnedSeedProofEmailCommand,
} from '../src/portal/owned-seed-proof-email.js';

const secret = 'portal-session-secret-with-sufficient-entropy';
const session = 'portal-session-token-with-sufficient-entropy';
const now = Date.parse('2026-08-29T10:00:00.000Z');
const state: OwnedSeedWorkflowState = Object.freeze({
  phase: 'approval_pending',
  companyContentVersionId: '11111111-1111-4111-8111-111111111111',
  messageId: '22222222-2222-4222-8222-222222222222',
  messageVersionId: '33333333-3333-4333-8333-333333333333',
  approvalRequestId: '44444444-4444-4444-8444-444444444444',
  subjectSha256: 'a'.repeat(64),
  bodySha256: 'b'.repeat(64),
  sourceContentSha256: 'c'.repeat(64),
});

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

test('owned-seed workflow token is exact-state and portal-session bound', () => {
  const token = ownedSeedWorkflowToken(secret, session, state, now);
  assert.ok(token);
  assert.deepEqual(verifyOwnedSeedWorkflowToken(secret, session, token, now + 1_000), state);
  assert.equal(verifyOwnedSeedWorkflowToken(secret, `${session}-other`, token, now + 1_000), null);
  assert.equal(verifyOwnedSeedWorkflowToken(secret, session, `${token}x`, now + 1_000), null);
});

test('owned-seed workflow token expires and rejects impossible phase evidence', () => {
  const token = ownedSeedWorkflowToken(secret, session, state, now);
  assert.equal(verifyOwnedSeedWorkflowToken(secret, session, token, now + (30 * 60 * 1_000) + 1), null);
  assert.equal(ownedSeedWorkflowToken(secret, session, {
    ...state,
    phase: 'approved',
    approvalRequestId: null,
  }, now), '');
  assert.equal(verifyOwnedSeedWorkflowToken(secret, session, 'not-a-token', now), null);
});

test('owned proof command seals exact brand copy with evidence longer than the workflow', () => {
  const command = propertyPredatorOwnedSeedProofEmailCommand('proof-command-0001', now);
  const canonical = canonicalCompanyContentEmailDraft(
    PROPERTY_PREDATOR_OWNED_SEED_PROOF_SUBJECT,
    PROPERTY_PREDATOR_OWNED_SEED_PROOF_BODY,
  );
  assert.equal(command.subject, PROPERTY_PREDATOR_OWNED_SEED_PROOF_SUBJECT);
  assert.equal(command.bodyText, PROPERTY_PREDATOR_OWNED_SEED_PROOF_BODY);
  assert.equal(command.source.system, 'propertypredator.company-content');
  assert.equal(command.source.itemId, PROPERTY_PREDATOR_OWNED_SEED_PROOF_SOURCE_ITEM);
  assert.equal(command.source.version, PROPERTY_PREDATOR_OWNED_SEED_PROOF_SOURCE_VERSION);
  assert.equal(command.blob.sha256, sha256(canonical));
  assert.equal(command.metadata?.providerEffects, false);
  assert.equal(command.metadata?.recipientBoundary, 'fixed_owned_office');
  assert.equal(Date.parse(command.attestation.expiresAt) - Date.parse(command.attestation.checkedAt), 24 * 60 * 60 * 1_000);
});

test('expired proof evidence can advance to a new immutable predecessor-bound revision', () => {
  const revision = Object.freeze({
    contentItemId: '55555555-5555-4555-8555-555555555555',
    previousVersionId: '66666666-6666-4666-8666-666666666666',
    sourceVersion: 'operational-proof-20260829110000000-0123456789abcdef',
  });
  const command = propertyPredatorOwnedSeedProofEmailCommand('proof-command-0002', now, revision);
  assert.equal(command.contentItemId, revision.contentItemId);
  assert.equal(command.previousVersionId, revision.previousVersionId);
  assert.equal(command.source.version, revision.sourceVersion);
  assert.match(command.blob.storageKey, new RegExp(`${revision.sourceVersion}$`));
  assert.equal(command.metadata?.providerEffects, false);
});
