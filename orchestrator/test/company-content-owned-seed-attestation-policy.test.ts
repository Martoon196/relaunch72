import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CompanyContentValidationError,
  companyContentEmailDraftVersionCommand,
  normalizeCompanyContentVersionCommand,
} from '../src/company-content-pg/index.js';
import {
  PROPERTY_PREDATOR_OWNED_SEED_PROOF_BODY,
  propertyPredatorOwnedSeedProofEmailCommand,
} from '../src/portal/owned-seed-proof-email.js';

const now = Date.parse('2026-08-29T12:00:00.000Z');

function normalizeProof(
  mutate: (command: ReturnType<typeof propertyPredatorOwnedSeedProofEmailCommand>) => unknown
    = (command) => command,
): ReturnType<typeof normalizeCompanyContentVersionCommand> {
  const command = propertyPredatorOwnedSeedProofEmailCommand('proof-policy-0001', now);
  return normalizeCompanyContentVersionCommand(companyContentEmailDraftVersionCommand(
    mutate(command) as ReturnType<typeof propertyPredatorOwnedSeedProofEmailCommand>,
  ));
}

test('the exact deterministic owned-office proof receives the narrow 24-hour window', () => {
  const normalized = normalizeProof();
  assert.equal(
    Date.parse(normalized.sourceExpiresAt) - Date.parse(normalized.sourceCheckedAt),
    24 * 60 * 60 * 1_000,
  );
});

test('the 24-hour exception fails closed when any owned-proof identity changes', () => {
  const attacks = [
    (command: ReturnType<typeof propertyPredatorOwnedSeedProofEmailCommand>) => ({
      ...command,
      source: { ...command.source, system: 'propertypredator.other-content' },
    }),
    (command: ReturnType<typeof propertyPredatorOwnedSeedProofEmailCommand>) => ({
      ...command,
      source: { ...command.source, itemId: 'another-owned-item' },
    }),
    (command: ReturnType<typeof propertyPredatorOwnedSeedProofEmailCommand>) => ({
      ...command,
      source: { ...command.source, version: 'operational-proof-unbounded' },
    }),
    (command: ReturnType<typeof propertyPredatorOwnedSeedProofEmailCommand>) => ({
      ...command,
      bodyText: `${PROPERTY_PREDATOR_OWNED_SEED_PROOF_BODY}\nChanged bytes.`,
    }),
    (command: ReturnType<typeof propertyPredatorOwnedSeedProofEmailCommand>) => ({
      ...command,
      metadata: { ...command.metadata, recipientBoundary: 'customer_list' },
    }),
    (command: ReturnType<typeof propertyPredatorOwnedSeedProofEmailCommand>) => ({
      ...command,
      metadata: { ...command.metadata, providerEffects: true },
    }),
  ];

  for (const attack of attacks) {
    assert.throws(
      () => normalizeProof(attack),
      (error: unknown) => error instanceof CompanyContentValidationError
        && /may not exceed 15 minutes/.test(error.message),
    );
  }
});

test('even the exact owned proof cannot request longer than 24 hours', () => {
  assert.throws(
    () => normalizeProof((command) => ({
      ...command,
      attestation: {
        ...command.attestation,
        expiresAt: new Date(now + (24 * 60 * 60 * 1_000) + 1).toISOString(),
      },
    })),
    /may not exceed 24 hours/,
  );
});
