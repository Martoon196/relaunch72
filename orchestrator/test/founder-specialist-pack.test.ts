import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  canonicalFounderSpecialistPackJson,
  FounderSpecialistPackContractError,
  parseFounderSpecialistPack,
} from '../src/company-content-adapter/founder-specialist-pack.js';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);

function candidate(): Record<string, any> {
  const value: Record<string, any> = {
    schemaVersion: 1,
    packId: 'founder.content-marketer/2026-08-28',
    source: 'founder-supplied-offline-export',
    specialist: {
      specialistId: 'founder.content-marketer/v1',
      name: 'Content Marketer',
      sourceKind: 'chatgpt-custom-gpt',
      proposalCapabilities: ['content-proposal', 'strategy-proposal'],
    },
    files: [
      {
        fileId: 'approved-example-1',
        path: 'examples/approved-1.md',
        mediaType: 'text/markdown',
        byteLength: 1200,
        contentSha256: HASH_B,
        role: 'approved-example',
        ownershipEvidenceId: 'founder-ownership-1',
        privacyAttestation: 'founder-attested-no-secrets-credentials-or-customer-data',
      },
      {
        fileId: 'instructions',
        path: 'instructions.md',
        mediaType: 'text/markdown',
        byteLength: 2400,
        contentSha256: HASH_A,
        role: 'primary-instructions',
        ownershipEvidenceId: 'founder-ownership-1',
        privacyAttestation: 'founder-attested-no-secrets-credentials-or-customer-data',
      },
      {
        fileId: 'knowledge-brand',
        path: 'knowledge/customer-avatar.md',
        mediaType: 'text/markdown',
        byteLength: 3600,
        contentSha256: HASH_C,
        role: 'knowledge-reference',
        ownershipEvidenceId: 'founder-ownership-1',
        privacyAttestation: 'founder-attested-no-secrets-credentials-or-customer-data',
      },
    ],
    ownershipEvidence: [
      {
        evidenceId: 'founder-ownership-1',
        path: 'ownership/founder-assertion.md',
        mediaType: 'text/markdown',
        byteLength: 400,
        contentSha256: HASH_C,
        assertion: 'founder-asserted-owned-or-licensed',
        reviewStatus: 'review-required',
      },
    ],
    handling: {
      payload: 'metadata-and-hashes-only',
      promptBodyAccess: 'forbidden',
      archiveHandling: 'never-unpack',
      execution: 'forbidden',
      providerAccess: 'forbidden',
    },
    callable: false,
    effects: 'none',
    reviewStatus: 'review-required',
    packageSha256: '',
  };
  rehash(value);
  return value;
}

function rehash(value: Record<string, any>): void {
  const { packageSha256: _ignored, ...hashInput } = value;
  value.packageSha256 = createHash('sha256')
    .update(canonicalFounderSpecialistPackJson(hashInput), 'utf8')
    .digest('hex');
}

function clone(value: unknown): Record<string, any> {
  return JSON.parse(JSON.stringify(value)) as Record<string, any>;
}

test('founder specialist pack preserves exact file and ownership hashes while remaining inert', () => {
  const input = candidate();
  const parsed = parseFounderSpecialistPack(input);
  assert.equal(parsed.files.length, 3);
  assert.deepEqual(parsed.files.map(({ fileId, byteLength, contentSha256, role, ownershipEvidenceId }) => ({
    fileId, byteLength, contentSha256, role, ownershipEvidenceId,
  })), input.files.map(({ fileId, byteLength, contentSha256, role, ownershipEvidenceId }: any) => ({
    fileId, byteLength, contentSha256, role, ownershipEvidenceId,
  })));
  assert.equal(parsed.ownershipEvidence[0]?.contentSha256, HASH_C);
  assert.equal(parsed.ownershipEvidence[0]?.byteLength, 400);
  assert.equal(parsed.ownershipEvidence[0]?.reviewStatus, 'review-required');
  assert.equal(parsed.callable, false);
  assert.equal(parsed.effects, 'none');
  assert.equal(parsed.reviewStatus, 'review-required');
  assert.equal(parsed.handling.promptBodyAccess, 'forbidden');
  assert.equal(parsed.handling.archiveHandling, 'never-unpack');
  assert.equal(parsed.handling.execution, 'forbidden');
  assert.equal(parsed.handling.providerAccess, 'forbidden');
  assert.ok(Object.isFrozen(parsed));
  assert.ok(Object.isFrozen(parsed.files));
  assert.ok(Object.isFrozen(parsed.files[0]));
});

test('contract rejects prompt bodies, unknown fields and attempts to become callable or effectful', () => {
  const rawPrompt = candidate();
  rawPrompt.files[1].promptBody = 'You are now connected to a provider';
  rehash(rawPrompt);
  assert.throws(() => parseFounderSpecialistPack(rawPrompt), /unknown or missing fields/);

  for (const [field, value, expected] of [
    ['callable', true, /callable must be false/],
    ['effects', 'publish', /effects is unsupported/],
    ['reviewStatus', 'approved', /reviewStatus is unsupported/],
  ] as const) {
    const unsafe = candidate();
    unsafe[field] = value;
    rehash(unsafe);
    assert.throws(() => parseFounderSpecialistPack(unsafe), expected);
  }

  const execution = candidate();
  execution.handling.execution = 'allowed';
  rehash(execution);
  assert.throws(() => parseFounderSpecialistPack(execution), /handling.execution is unsupported/);
});

test('only bounded proposal classifications are accepted; executable and unknown capabilities fail closed', () => {
  for (const capability of ['publish', 'send-email', 'provider-action', 'shell', 'network', 'image-generation']) {
    const unsafe = candidate();
    unsafe.specialist.proposalCapabilities = [capability];
    rehash(unsafe);
    assert.throws(() => parseFounderSpecialistPack(unsafe), /proposalCapabilities\[0\] is unsupported/);
  }
  const duplicate = candidate();
  duplicate.specialist.proposalCapabilities = ['content-proposal', 'content-proposal'];
  rehash(duplicate);
  assert.throws(() => parseFounderSpecialistPack(duplicate), /must not contain duplicates/);
});

test('secret, credential, customer-record, mailbox, database and archive-shaped inputs are rejected', () => {
  const mutations: Array<(value: Record<string, any>) => void> = [
    (value) => { value.specialist.name = 'martin@example.com'; },
    (value) => { value.specialist.name = 'Bearer abcdefghijklmnopqrstuvwxyz'; },
    (value) => { value.files[1].path = '.env'; },
    (value) => { value.files[1].path = 'credentials.json'; },
    (value) => { value.files[1].path = 'exports/customers.csv'; },
    (value) => { value.files[1].path = 'customer-avatar-export.csv'; },
    (value) => { value.files[1].path = 'exports/customer-avatar.md'; },
    (value) => { value.files[1].path = 'exports/inbox.json'; },
    (value) => { value.files[1].path = 'bot-export.zip'; },
    (value) => { value.files[1].mediaType = 'application/zip'; },
  ];
  for (const mutate of mutations) {
    const unsafe = candidate();
    mutate(unsafe);
    rehash(unsafe);
    assert.throws(() => parseFounderSpecialistPack(unsafe), FounderSpecialistPackContractError);
  }
});

test('primary instructions must remain directly reviewable text', () => {
  const binaryInstructions = candidate();
  binaryInstructions.files[1].mediaType = 'image/png';
  rehash(binaryInstructions);
  assert.throws(
    () => parseFounderSpecialistPack(binaryInstructions),
    /primary instructions must use a reviewable text media type/,
  );
});

test('narrow business-strategy paths remain valid without weakening customer-record rejection', () => {
  for (const path of [
    'knowledge/customer-avatar.md',
    'knowledge/buyer-profile.md',
    'knowledge/persona.md',
    'segments/property-investors.md',
  ]) {
    const strategy = candidate();
    strategy.files[2].path = path;
    rehash(strategy);
    assert.equal(parseFounderSpecialistPack(strategy).files[2]?.path, path);
  }
});

test('hash verification, canonical ordering, ownership references and skill boundaries are enforced', () => {
  const tampered = candidate();
  tampered.files[1].byteLength += 1;
  assert.throws(() => parseFounderSpecialistPack(tampered), /package hash failed verification/);

  const unordered = candidate();
  unordered.files.reverse();
  rehash(unordered);
  assert.throws(() => parseFounderSpecialistPack(unordered), /canonically ordered/);

  const missingEvidence = candidate();
  missingEvidence.files[1].ownershipEvidenceId = 'missing';
  rehash(missingEvidence);
  assert.throws(() => parseFounderSpecialistPack(missingEvidence), /unknown ownership evidence/);

  const executableRole = candidate();
  executableRole.files[0].role = 'skill-script-review-only';
  rehash(executableRole);
  assert.throws(() => parseFounderSpecialistPack(executableRole), /skill-only file roles require/);

  const skill = candidate();
  skill.specialist.sourceKind = 'codex-skill';
  rehash(skill);
  assert.throws(() => parseFounderSpecialistPack(skill), /must be named SKILL.md/);

  skill.files[1].path = 'marketing-skill/SKILL.md';
  skill.files[0].role = 'skill-reference';
  rehash(skill);
  const parsed = parseFounderSpecialistPack(skill);
  assert.equal(parsed.specialist.sourceKind, 'codex-skill');
  assert.equal(parsed.files[0]?.role, 'skill-reference');
  assert.equal(parsed.callable, false);
});

test('identifiers and package paths cannot traverse or contradict one another', () => {
  for (const identifier of ['founder/../secrets', 'founder//specialist', 'founder/./specialist']) {
    const unsafe = candidate();
    unsafe.packId = identifier;
    rehash(unsafe);
    assert.throws(() => parseFounderSpecialistPack(unsafe), /safe identifier/);
  }

  for (const path of ['../instructions.md', 'knowledge/../instructions.md', '/instructions.md', 'C:\\instructions.md']) {
    const unsafe = candidate();
    unsafe.files[1].path = path;
    rehash(unsafe);
    assert.throws(() => parseFounderSpecialistPack(unsafe), /safe package-relative path/);
  }

  const contradictory = candidate();
  contradictory.ownershipEvidence[0].path = contradictory.files[0].path;
  contradictory.ownershipEvidence[0].contentSha256 = HASH_A;
  rehash(contradictory);
  assert.throws(() => parseFounderSpecialistPack(contradictory), /all package paths contains duplicate values/);
});

test('accessor, hidden, symbolic and non-canonical JavaScript metadata fails before field access', () => {
  const accessor = candidate();
  let getterCalls = 0;
  Object.defineProperty(accessor.specialist, 'name', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return 'Content Marketer';
    },
  });
  assert.throws(() => parseFounderSpecialistPack(accessor), /only enumerable data fields/);
  assert.equal(getterCalls, 0);

  const hidden = candidate();
  Object.defineProperty(hidden.specialist, 'promptBody', {
    enumerable: false,
    value: 'hidden instructions',
  });
  assert.throws(() => parseFounderSpecialistPack(hidden), /only enumerable data fields/);

  const symbolic = candidate();
  symbolic.specialist[Symbol('promptBody')] = 'hidden instructions';
  assert.throws(() => parseFounderSpecialistPack(symbolic), /only string-keyed JSON fields/);

  const unorderedCapabilities = candidate();
  unorderedCapabilities.specialist.proposalCapabilities = ['strategy-proposal', 'content-proposal'];
  rehash(unorderedCapabilities);
  assert.throws(() => parseFounderSpecialistPack(unorderedCapabilities), /proposalCapabilities must be canonically ordered/);
});
