import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FounderSpecialistPackContractError,
  parseFounderSpecialistPack,
} from '../src/company-content-adapter/founder-specialist-pack.js';
import {
  PROPERTY_PREDATOR_MARKETING_PACK,
  PROPERTY_PREDATOR_MARKETING_SOURCE_BYTE_LENGTH,
  PROPERTY_PREDATOR_MARKETING_SOURCE_FILE_COUNT,
  PROPERTY_PREDATOR_MARKETING_SOURCE_INVENTORY_SHA256,
} from '../src/company-content-adapter/property-predator-marketing-pack-registry.js';

function clonePack(): Record<string, any> {
  return JSON.parse(JSON.stringify(PROPERTY_PREDATOR_MARKETING_PACK)) as Record<string, any>;
}

test('adapted Property Predator marketing registry preserves exact private-source hashes and stays inert', () => {
  const pack = PROPERTY_PREDATOR_MARKETING_PACK;

  assert.equal(pack.packId, 'property-predator-marketing');
  assert.equal(pack.specialist.specialistId, 'property-predator-marketing');
  assert.equal(pack.specialist.sourceKind, 'codex-skill');
  assert.equal(pack.files.length, 13);
  assert.equal(pack.files.find((file) => file.fileId === 'instructions.primary')?.contentSha256,
    'ddabda030f6ff845b3974eb9307a6a686ec42fe6e830da139884aeae7bf8cbad');
  assert.equal(pack.files.find((file) => file.fileId === 'reference.brand-guidelines')?.contentSha256,
    '824e165d76feb2ec558a48c2fbbdcca3c34b4f335de2fe39f840a6ebf165e5e2');
  assert.equal(pack.files.find((file) => file.fileId === 'reference.proposal-schema')?.contentSha256,
    'a4c543749833efd1fa6f31da55972f39060aa66dbbc98ad3de05362304c55504');
  assert.equal(pack.ownershipEvidence[0]?.contentSha256,
    'e1ca1980b7e083c71ed6a75c30507e182e237bbed65726993f9a99050b846c3f');
  assert.equal(pack.packageSha256,
    'd73c1a3c299dba60f3be74813a5d7d766a6514e88baeac2522c6c7482e4bc21d');
  assert.equal(PROPERTY_PREDATOR_MARKETING_SOURCE_INVENTORY_SHA256,
    '352068edf5fb1be30b9d692ff5a6a11aa91e500019b7da86b9f60aae50c0cf3b');
  assert.equal(PROPERTY_PREDATOR_MARKETING_SOURCE_FILE_COUNT, 13);
  assert.equal(PROPERTY_PREDATOR_MARKETING_SOURCE_BYTE_LENGTH, 117_060);
  assert.equal(pack.files.reduce((total, file) => total + file.byteLength, 0), 117_060);
  assert.equal(pack.handling.payload, 'metadata-and-hashes-only');
  assert.equal(pack.handling.promptBodyAccess, 'forbidden');
  assert.equal(pack.handling.archiveHandling, 'never-unpack');
  assert.equal(pack.handling.execution, 'forbidden');
  assert.equal(pack.handling.providerAccess, 'forbidden');
  assert.equal(pack.callable, false);
  assert.equal(pack.effects, 'none');
  assert.equal(pack.reviewStatus, 'review-required');
});

test('adapted registry contains metadata only and exposes no provider capability or prompt body', () => {
  const encoded = JSON.stringify(PROPERTY_PREDATOR_MARKETING_PACK);

  assert.doesNotMatch(encoded, /rawPrompt|promptBody\s*"?:|systemPrompt|providerCapability|providerCredential/iu);
  assert.doesNotMatch(encoded, /\.zip|\.7z|\.rar|\.tar|\.tgz/iu);
  assert.ok(PROPERTY_PREDATOR_MARKETING_PACK.files.every((file) => file.byteLength > 0));
  assert.ok(PROPERTY_PREDATOR_MARKETING_PACK.files.every((file) => /^[0-9a-f]{64}$/u.test(file.contentSha256)));
});

test('adapted registry contract fails closed on prompt, callability, effects and provider-access escalation', () => {
  const prompt = clonePack();
  prompt.rawPrompt = 'forbidden';
  assert.throws(() => parseFounderSpecialistPack(prompt), FounderSpecialistPackContractError);

  const callable = clonePack();
  callable.callable = true;
  assert.throws(() => parseFounderSpecialistPack(callable), /callable must be false/);

  const effectful = clonePack();
  effectful.effects = 'provider';
  assert.throws(() => parseFounderSpecialistPack(effectful), /effects is unsupported/);

  const provider = clonePack();
  provider.handling.providerAccess = 'allowed';
  assert.throws(() => parseFounderSpecialistPack(provider), /handling.providerAccess is unsupported/);
});
