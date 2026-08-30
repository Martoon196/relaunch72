import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import {
  PROPERTY_PREDATOR_OWNED_SEED_PROOF_BODY,
  PROPERTY_PREDATOR_OWNED_SEED_PROOF_RECIPIENT_BOUNDARY,
  PROPERTY_PREDATOR_OWNED_SEED_PROOF_SUBJECT,
  propertyPredatorOwnedSeedProofEmailCommand,
} from '../src/portal/owned-seed-proof-email.js';

/**
 * The founder pilot must carry no recipient of its own.
 *
 * The owned-seed rail it replaces was locked to one mailbox in applied
 * migrations and in the copy itself. These tests hold the new flow to the
 * opposite property: the recipient exists only as a verified row on the Lead
 * 360 contact, and nothing in the source knows what it is.
 */

/** Every file the founder pilot flow is actually made of. */
const FOUNDER_PILOT_SOURCES: readonly string[] = Object.freeze([
  'src/founder-email-pilot/foundation.ts',
  'src/portal/founder-email-pilot-service.ts',
  'src/portal/founder-email-pilot-pg-service.ts',
  'src/portal/founder-email-pilot-actions.ts',
  'src/portal/permission-use-receipt-service.ts',
  'src/portal/permission-use-receipt-pg-service.ts',
  'src/portal/owned-seed-proof-email.ts',
  'src/company-content-pg/property-predator-owned-seed-attestation-policy.ts',
]);

const ADDRESS = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/u;

async function source(relative: string): Promise<string> {
  return readFile(new URL(`../${relative}`, import.meta.url), 'utf8');
}

test('no founder pilot source names a recipient of any kind', async () => {
  for (const relative of FOUNDER_PILOT_SOURCES) {
    const text = await source(relative);
    assert.doesNotMatch(text, /office@propertypredator\.com/u, relative);
    // The one authorised address for this pilot is real personal data. It
    // belongs in the database as a verified endpoint, never in the repository.
    assert.doesNotMatch(text, /martin\.howard1984/iu, relative);
    assert.doesNotMatch(text, ADDRESS, relative);
  }
});

test('the approved proof copy carries no address and states the boundary instead', () => {
  const proof = `${PROPERTY_PREDATOR_OWNED_SEED_PROOF_SUBJECT}\n`
    + PROPERTY_PREDATOR_OWNED_SEED_PROOF_BODY;
  assert.doesNotMatch(proof, ADDRESS);
  assert.doesNotMatch(proof, /@/u);
  assert.match(proof, /verified founder email endpoint shown in Lead 360/u);
  assert.equal(
    PROPERTY_PREDATOR_OWNED_SEED_PROOF_RECIPIENT_BOUNDARY, 'verified_founder_endpoint',
  );
});

test('the proof command names a boundary rule, never a mailbox', () => {
  const command = propertyPredatorOwnedSeedProofEmailCommand(
    'proof-command-purity', Date.parse('2026-08-30T10:00:00.000Z'),
  );
  assert.equal(command.metadata?.recipientBoundary, 'verified_founder_endpoint');
  assert.doesNotMatch(JSON.stringify(command), ADDRESS);
});

test('the recipient reaches the pilot only as a resolved endpoint identifier', async () => {
  // Every seam that touches the recipient takes a contactPointId and reads the
  // address back out of the database. None accepts an address as input, which
  // is what makes substituting a different endpoint impossible from outside.
  for (const relative of [
    'src/portal/founder-email-pilot-service.ts',
    'src/portal/permission-use-receipt-service.ts',
  ]) {
    const text = await source(relative);
    assert.match(text, /contactPointId: string/u, relative);
    // No input field carries an address into these boundaries.
    assert.doesNotMatch(text, /readonly (recipient|toAddress|emailAddress): string/u, relative);
  }
  const pg = await source('src/portal/founder-email-pilot-pg-service.ts');
  // The recipient is read from the resolver's row, never written into a query.
  assert.match(pg, /recipientEmail: recipient/u);
  assert.match(pg, /input\.contactPointId\.toLowerCase\(\)/u);
});

test('no unapplied founder migration reintroduces a hard-coded recipient', async () => {
  // 0064 and 0065 are the only unapplied migrations in this strike. Applied
  // history is left exactly as it is; these two must stay address-free.
  const directory = new URL('../src/db/migrations/', import.meta.url);
  const files = (await readdir(directory)).filter(
    (name) => name.startsWith('0064') || name.startsWith('0065'),
  );
  assert.equal(files.length, 2, 'both unapplied founder migrations must be present');
  for (const name of files) {
    const raw = await readFile(new URL(name, directory), 'utf8');
    const executable = raw
      .replace(/\/\*[\s\S]*?\*\//gu, ' ')
      .replace(/--[^\n]*/gu, ' ');
    assert.doesNotMatch(executable, /'[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}'/u, name);
    assert.doesNotMatch(raw, /martin\.howard1984/iu, name);
  }
});

test('the only purpose the founder pilot uses is the canonical marketing one', async () => {
  // A second purpose key would silently create a second consent scope, and the
  // recipient could then be reached under permission they never gave.
  const router = await source('src/portal/router.ts');
  assert.match(router, /FOUNDER_PILOT_PURPOSE = 'property_predator_marketing'/u);
  const contracts = await source('src/integrations/external-events/contracts.ts');
  assert.ok(
    contracts.includes('property_predator_marketing'),
    'the purpose must come from the shared contract, not be invented here',
  );
});
