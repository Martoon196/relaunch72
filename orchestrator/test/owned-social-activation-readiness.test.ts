import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import type { DatabaseRequestContext } from '../src/db/rls.js';
import {
  OWNED_SOCIAL_ACTIVATION_BLOCKER_CODES,
  OWNED_SOCIAL_ACTIVATION_CONTRACT,
  OWNED_SOCIAL_ACTIVATION_DIMENSIONS,
  OWNED_SOCIAL_ACTIVATION_TARGET_SETTINGS,
  OWNED_SOCIAL_DAILY_CAP,
  OWNED_SOCIAL_MAX_POST_CHARACTERS,
  OWNED_SOCIAL_MONTHLY_CAP,
  OwnedSocialActivationError,
  buildOwnedSocialActivationReadinessReport,
  deriveOwnedSocialPublicationRehearsal,
  deriveOwnedSocialStagingDigests,
  deriveOwnedSocialStagingIdempotencyKey,
  formatOwnedSocialActivationReadiness,
  ownedSocialAccountDigest,
  readOwnedSocialActivationTarget,
  type OwnedSocialActivationBlockerCode,
  type OwnedSocialActivationDimension,
  type OwnedSocialActivationDimensionResult,
  type OwnedSocialActivationTarget,
} from '../src/owned-social-activation/foundation.js';
import {
  PgOwnedSocialActivationReadinessProbe,
  createPgOwnedSocialActivationReadinessProbe,
} from '../src/owned-social-activation-pg/probe.js';
import {
  assertOwnedPublicSocialCommandBoundaryReady,
} from '../src/owned-public-social-pg/readiness.js';

const ACCOUNT_REFERENCE = '@PropertyPredatorHQ';
const EXPECTED_DIGEST = createHash('sha256').update(ACCOUNT_REFERENCE, 'utf8').digest('hex');

const IDS = Object.freeze({
  workspace: '11111111-1111-4111-8111-111111111111',
  otherWorkspace: '99999999-9999-4999-8999-999999999999',
  connection: '22222222-2222-4222-8222-222222222222',
  profile: '33333333-3333-4333-8333-333333333333',
  contentItem: '44444444-4444-4444-8444-444444444444',
  contentVersion: '55555555-5555-4555-8555-555555555555',
  approvalRequest: '66666666-6666-4666-8666-666666666666',
  approvalDecision: '77777777-7777-4777-8777-777777777777',
  sourceAttestation: '88888888-8888-4888-8888-888888888888',
  user: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  alternate: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
});

const OPERATION_TAG = 'owned-social:activation-rehearsal';
const EM_DASH = '\u2014';

/** ASCII only, no dot, colon or double slash anywhere. Exactly 280 characters. */
const CLEAN_280 =
  'Owned social rehearsal proves the exact boundary '.repeat(6).slice(0, 280);

function validEnv(overrides: Readonly<Record<string, string | undefined>> = {}): NodeJS.ProcessEnv {
  const env: Record<string, string | undefined> = {
    PROPERTY_PREDATOR_REHEARSAL_WORKSPACE_ID: IDS.workspace,
    PROPERTY_PREDATOR_PUBLIC_SOCIAL_LIVE_CONNECTION_ID: IDS.connection,
    PROPERTY_PREDATOR_REHEARSAL_SOCIAL_PROFILE_ID: IDS.profile,
    PROPERTY_PREDATOR_REHEARSAL_SOCIAL_CONTENT_ITEM_ID: IDS.contentItem,
    PROPERTY_PREDATOR_REHEARSAL_SOCIAL_CONTENT_VERSION_ID: IDS.contentVersion,
    PROPERTY_PREDATOR_REHEARSAL_SOCIAL_APPROVAL_REQUEST_ID: IDS.approvalRequest,
    PROPERTY_PREDATOR_REHEARSAL_SOCIAL_APPROVAL_ID: IDS.approvalDecision,
    PROPERTY_PREDATOR_REHEARSAL_SOCIAL_SOURCE_ATTESTATION_ID: IDS.sourceAttestation,
    PROPERTY_PREDATOR_REHEARSAL_SOCIAL_ACCOUNT_REF: ACCOUNT_REFERENCE,
    PROPERTY_PREDATOR_REHEARSAL_SOCIAL_PROFILE_OWNED: 'true',
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env as NodeJS.ProcessEnv;
}

function readyRows(): OwnedSocialActivationDimensionResult[] {
  return OWNED_SOCIAL_ACTIVATION_DIMENSIONS.map((dimension) => ({
    dimension,
    ready: true,
    blockerCode: null,
  }));
}

function blockedRows(
  blocks: Readonly<Record<string, OwnedSocialActivationBlockerCode>>,
): OwnedSocialActivationDimensionResult[] {
  return readyRows().map((row) => {
    const blockerCode = blocks[row.dimension];
    return blockerCode ? { dimension: row.dimension, ready: false, blockerCode } : row;
  });
}

function target(
  overrides: Partial<OwnedSocialActivationTarget> = {},
): OwnedSocialActivationTarget {
  return Object.freeze({
    workspaceId: IDS.workspace,
    providerConnectionId: IDS.connection,
    profileId: IDS.profile,
    contentItemId: IDS.contentItem,
    contentVersionId: IDS.contentVersion,
    approvalRequestId: IDS.approvalRequest,
    approvalDecisionId: IDS.approvalDecision,
    sourceAttestationId: IDS.sourceAttestation,
    expectedOwnedAccountSha256: EXPECTED_DIGEST,
    scheduledFor: null,
    ...overrides,
  });
}

function userContext(
  overrides: Partial<DatabaseRequestContext> = {},
): DatabaseRequestContext {
  return {
    actorKind: 'user',
    userId: IDS.user,
    workspaceId: IDS.workspace,
    requestId: 'owned-social-activation-readiness-request',
    ...overrides,
  };
}

interface CapturedStatement {
  readonly text: string;
  readonly values?: readonly unknown[];
}

interface FakePool {
  readonly commandPool: { connect(): Promise<unknown> };
  readonly statements: CapturedStatement[];
  connects(): number;
  releases(): number;
  destroyed(): boolean | undefined;
}

function fakePool(rows: readonly Record<string, unknown>[]): FakePool {
  const statements: CapturedStatement[] = [];
  let connects = 0;
  let releases = 0;
  let destroyFlag: boolean | undefined;
  const client = {
    async query(text: string, values?: readonly unknown[]) {
      statements.push({ text, values });
      if (text.includes('owned-social-activation.readiness')) {
        return { rows: rows.map((row) => ({ ...row })), rowCount: rows.length };
      }
      if (text.startsWith('BEGIN ') || text === 'COMMIT' || text === 'ROLLBACK'
          || text.includes("set_config('app.user_id'")) {
        return { rows: [], rowCount: 0 };
      }
      throw new Error('unexpected query');
    },
    release(destroy?: boolean) {
      releases += 1;
      destroyFlag = destroy;
    },
  };
  return {
    commandPool: {
      async connect() {
        connects += 1;
        return client;
      },
    },
    statements,
    connects: () => connects,
    releases: () => releases,
    destroyed: () => destroyFlag,
  };
}

function probeWith(pool: FakePool): PgOwnedSocialActivationReadinessProbe {
  return new PgOwnedSocialActivationReadinessProbe({ commandPool: pool.commandPool as never });
}

function rehearsal(
  overrides: Partial<OwnedSocialActivationTarget> = {},
  input: Partial<{ operationTag: string; approvedText: string; expectedContentSha256: string }> = {},
) {
  const approvedText = input.approvedText ?? 'Owned social rehearsal proves the exact boundary';
  return deriveOwnedSocialPublicationRehearsal({
    target: target(overrides),
    operationTag: input.operationTag ?? OPERATION_TAG,
    approvedText,
    expectedContentSha256: input.expectedContentSha256
      ?? createHash('sha256').update(approvedText, 'utf8').digest('hex'),
  });
}

// ---------------------------------------------------------------------------
// foundation.ts — owned account digest
// ---------------------------------------------------------------------------

test('the owned account digest is the sha256 of the trimmed reference', () => {
  assert.equal(ownedSocialAccountDigest(ACCOUNT_REFERENCE), EXPECTED_DIGEST);
  assert.equal(ownedSocialAccountDigest(`  ${ACCOUNT_REFERENCE}  `), EXPECTED_DIGEST);
  assert.match(EXPECTED_DIGEST, /^[0-9a-f]{64}$/u);
  assert.equal(
    ownedSocialAccountDigest('x'),
    createHash('sha256').update('x', 'utf8').digest('hex'),
  );
  assert.notEqual(ownedSocialAccountDigest('@Other'), EXPECTED_DIGEST);
  // A 200-character reference is the longest accepted, and still hashes exactly.
  const longest = 'a'.repeat(200);
  assert.equal(
    ownedSocialAccountDigest(longest),
    createHash('sha256').update(longest, 'utf8').digest('hex'),
  );
});

test('the owned account digest refuses an empty or oversized reference', () => {
  const invalid = ['', '   ', '\t\n ', 'a'.repeat(201), `  ${'b'.repeat(201)}  `];
  for (const candidate of invalid) {
    assert.throws(
      () => ownedSocialAccountDigest(candidate),
      (error: unknown) => error instanceof OwnedSocialActivationError
        && error.code === 'invalid_target'
        && error.name === 'OwnedSocialActivationError',
      `expected rejection for a ${candidate.length}-character reference`,
    );
  }
});

// ---------------------------------------------------------------------------
// foundation.ts — target reading
// ---------------------------------------------------------------------------

test('a complete owned environment reads as a frozen digest-only target', () => {
  const outcome = readOwnedSocialActivationTarget(validEnv());
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.deepEqual({ ...outcome.target }, {
    workspaceId: IDS.workspace,
    providerConnectionId: IDS.connection,
    profileId: IDS.profile,
    contentItemId: IDS.contentItem,
    contentVersionId: IDS.contentVersion,
    approvalRequestId: IDS.approvalRequest,
    approvalDecisionId: IDS.approvalDecision,
    sourceAttestationId: IDS.sourceAttestation,
    expectedOwnedAccountSha256: EXPECTED_DIGEST,
    scheduledFor: null,
  });
  assert.equal(outcome.target.expectedOwnedAccountSha256, ownedSocialAccountDigest(ACCOUNT_REFERENCE));
  assert.equal(Object.isFrozen(outcome), true);
  assert.equal(Object.isFrozen(outcome.target), true);
  assert.throws(() => {
    (outcome.target as { profileId: string }).profileId = 'mutated';
  }, TypeError);

  const encoded = JSON.stringify(outcome.target);
  assert.equal(encoded.includes(ACCOUNT_REFERENCE), false);
  assert.equal(encoded.includes('PropertyPredatorHQ'), false);
  assert.equal(encoded.includes('PredatorHQ'), false);
  assert.equal(encoded.toLowerCase().includes('propertypredator'), false);
  assert.equal(encoded.includes('@'), false);
});

test('each malformed or absent identifier is reported by its exact setting name', () => {
  const cases: ReadonlyArray<readonly [string, string | undefined]> = [
    ['PROPERTY_PREDATOR_REHEARSAL_WORKSPACE_ID', undefined],
    ['PROPERTY_PREDATOR_PUBLIC_SOCIAL_LIVE_CONNECTION_ID', 'not-a-uuid'],
    ['PROPERTY_PREDATOR_REHEARSAL_SOCIAL_PROFILE_ID', ''],
    ['PROPERTY_PREDATOR_REHEARSAL_SOCIAL_CONTENT_ITEM_ID', '44444444-4444-4444-8444-44444444444'],
    ['PROPERTY_PREDATOR_REHEARSAL_SOCIAL_CONTENT_VERSION_ID', undefined],
    ['PROPERTY_PREDATOR_REHEARSAL_SOCIAL_APPROVAL_REQUEST_ID',
      '66666666-6666-4666-8666-666666666666 extra'],
    ['PROPERTY_PREDATOR_REHEARSAL_SOCIAL_APPROVAL_ID', '77777777-7777-4777-c777-777777777777'],
    ['PROPERTY_PREDATOR_REHEARSAL_SOCIAL_SOURCE_ATTESTATION_ID', 'null'],
  ];
  assert.equal(cases.length, 8, 'all eight UUID settings must be exercised');
  for (const [setting, value] of cases) {
    const outcome = readOwnedSocialActivationTarget(validEnv({ [setting]: value }));
    assert.equal(outcome.ok, false, `expected ${setting}=${String(value)} to be reported`);
    if (outcome.ok) continue;
    assert.deepEqual(outcome.missing, [setting]);
    assert.equal(Object.isFrozen(outcome.missing), true);
  }
});

test('the account reference and the ownership attestation are validated by exact setting name', () => {
  const cases: ReadonlyArray<readonly [string, string | undefined]> = [
    ['PROPERTY_PREDATOR_REHEARSAL_SOCIAL_ACCOUNT_REF', ''],
    ['PROPERTY_PREDATOR_REHEARSAL_SOCIAL_ACCOUNT_REF', '   '],
    ['PROPERTY_PREDATOR_REHEARSAL_SOCIAL_ACCOUNT_REF', undefined],
    ['PROPERTY_PREDATOR_REHEARSAL_SOCIAL_ACCOUNT_REF', 'z'.repeat(201)],
    ['PROPERTY_PREDATOR_REHEARSAL_SOCIAL_PROFILE_OWNED', 'false'],
    ['PROPERTY_PREDATOR_REHEARSAL_SOCIAL_PROFILE_OWNED', undefined],
    ['PROPERTY_PREDATOR_REHEARSAL_SOCIAL_PROFILE_OWNED', 'yes'],
    ['PROPERTY_PREDATOR_REHEARSAL_SOCIAL_PROFILE_OWNED', '1'],
    ['PROPERTY_PREDATOR_REHEARSAL_SOCIAL_PROFILE_OWNED', 'true false'],
  ];
  for (const [setting, value] of cases) {
    const outcome = readOwnedSocialActivationTarget(validEnv({ [setting]: value }));
    assert.equal(outcome.ok, false, `expected ${setting}=${String(value)} to be reported`);
    if (outcome.ok) continue;
    assert.deepEqual(outcome.missing, [setting]);
  }
  // A 200-character reference remains acceptable; only 201 is refused.
  const longest = readOwnedSocialActivationTarget(
    validEnv({ PROPERTY_PREDATOR_REHEARSAL_SOCIAL_ACCOUNT_REF: 'z'.repeat(200) }),
  );
  assert.equal(longest.ok, true);
  // Ownership is compared case-insensitively after trimming.
  const affirmed = readOwnedSocialActivationTarget(
    validEnv({ PROPERTY_PREDATOR_REHEARSAL_SOCIAL_PROFILE_OWNED: '  TRUE  ' }),
  );
  assert.equal(affirmed.ok, true);
});

test('an entirely absent environment reports every setting in declaration order', () => {
  const outcome = readOwnedSocialActivationTarget({} as NodeJS.ProcessEnv);
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.deepEqual(outcome.missing, [
    'PROPERTY_PREDATOR_REHEARSAL_WORKSPACE_ID',
    'PROPERTY_PREDATOR_PUBLIC_SOCIAL_LIVE_CONNECTION_ID',
    'PROPERTY_PREDATOR_REHEARSAL_SOCIAL_PROFILE_ID',
    'PROPERTY_PREDATOR_REHEARSAL_SOCIAL_CONTENT_ITEM_ID',
    'PROPERTY_PREDATOR_REHEARSAL_SOCIAL_CONTENT_VERSION_ID',
    'PROPERTY_PREDATOR_REHEARSAL_SOCIAL_APPROVAL_REQUEST_ID',
    'PROPERTY_PREDATOR_REHEARSAL_SOCIAL_APPROVAL_ID',
    'PROPERTY_PREDATOR_REHEARSAL_SOCIAL_SOURCE_ATTESTATION_ID',
    'PROPERTY_PREDATOR_REHEARSAL_SOCIAL_ACCOUNT_REF',
    'PROPERTY_PREDATOR_REHEARSAL_SOCIAL_PROFILE_OWNED',
  ]);
  assert.deepEqual(outcome.missing, [...OWNED_SOCIAL_ACTIVATION_TARGET_SETTINGS]);
});

// ---------------------------------------------------------------------------
// foundation.ts — report building
// ---------------------------------------------------------------------------

test('twelve ready dimensions build a zero-publication ready report', () => {
  const report = buildOwnedSocialActivationReadinessReport(readyRows());
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.contract, OWNED_SOCIAL_ACTIVATION_CONTRACT);
  assert.equal(report.contract, 'propertypredator.owned-social-activation-readiness/v1');
  assert.equal(report.result, 'ready-for-separately-authorised-owned-test');
  assert.deepEqual(report.blockers, []);
  assert.equal(report.providerEffects, false);
  assert.equal(report.providerCallsMade, false);
  assert.equal(report.postsPublished, false);
  assert.equal(report.dimensions.length, 12);
  assert.deepEqual(
    report.dimensions.map((entry) => entry.dimension),
    [...OWNED_SOCIAL_ACTIVATION_DIMENSIONS],
  );
  assert.equal(report.dimensions.every((entry) => entry.ready && entry.blockerCode === null), true);
  assert.match(report.nextStep, /separate authorisation/u);
  assert.equal(Object.isFrozen(report), true);
  assert.equal(Object.isFrozen(report.dimensions), true);
  assert.equal(Object.isFrozen(report.blockers), true);
});

test('malformed database evidence is rejected rather than silently passed as readiness', () => {
  const invalidSets: ReadonlyArray<
    readonly [string, readonly OwnedSocialActivationDimensionResult[]]
  > = [
    ['too few rows', readyRows().slice(0, 11)],
    ['too many rows', [...readyRows(), readyRows()[0] as OwnedSocialActivationDimensionResult]],
    ['no rows', []],
    ['out of order', (() => {
      const rows = readyRows();
      const first = rows[0] as OwnedSocialActivationDimensionResult;
      rows[0] = rows[1] as OwnedSocialActivationDimensionResult;
      rows[1] = first;
      return rows;
    })()],
    ['unknown dimension name', readyRows().map((row, index) => index === 0
      ? { ...row, dimension: 'operator_authority_v2' as OwnedSocialActivationDimension }
      : row)],
    ['duplicate dimension', readyRows().map((row, index) => index === 1
      ? { ...row, dimension: 'operator_authority' as OwnedSocialActivationDimension }
      : row)],
    ['ready with a blocker code', readyRows().map((row, index) => index === 3
      ? {
        ...row,
        ready: true,
        blockerCode: 'CAP_REACHED' as OwnedSocialActivationBlockerCode,
      }
      : row)],
    ['blocked with a null blocker code', readyRows().map((row, index) => index === 3
      ? { ...row, ready: false, blockerCode: null }
      : row)],
    ['blocked with an unknown blocker code', readyRows().map((row, index) => index === 3
      ? { ...row, ready: false, blockerCode: 'ACCOUNT_EXPLODED' as OwnedSocialActivationBlockerCode }
      : row)],
    ['non-boolean ready', readyRows().map((row, index) => index === 5
      ? { ...row, ready: 'true' as unknown as boolean }
      : row)],
    ['null ready', readyRows().map((row, index) => index === 7
      ? { ...row, ready: null as unknown as boolean }
      : row)],
  ];
  for (const [label, rows] of invalidSets) {
    assert.throws(
      () => buildOwnedSocialActivationReadinessReport(rows),
      (error: unknown) => error instanceof OwnedSocialActivationError
        && error.code === 'invalid_evidence',
      `expected invalid_evidence for ${label}`,
    );
  }
});

test('a blocked report lists its blockers in dimension order, not alphabetical order', () => {
  const report = buildOwnedSocialActivationReadinessReport(blockedRows({
    provider_connection: 'PROVIDER_NOT_CONFIGURED',
    owned_account_matches_supplied: 'OWNED_ACCOUNT_EVIDENCE_MISMATCH',
    publishable_text: 'CONTENT_NOT_PUBLISHABLE',
    emergency_pause_clear: 'EMERGENCY_PAUSED',
  }));
  assert.equal(report.result, 'blocked');
  assert.deepEqual(report.blockers, [
    'PROVIDER_NOT_CONFIGURED',
    'OWNED_ACCOUNT_EVIDENCE_MISMATCH',
    'CONTENT_NOT_PUBLISHABLE',
    'EMERGENCY_PAUSED',
  ]);
  assert.notDeepEqual(report.blockers, [...report.blockers].sort());
  assert.equal(report.providerEffects, false);
  assert.equal(report.postsPublished, false);
  assert.match(report.nextStep, /No command, enqueue or provider call was attempted/u);
  assert.equal(
    report.blockers.every((code) => OWNED_SOCIAL_ACTIVATION_BLOCKER_CODES.includes(code)),
    true,
  );
});

// ---------------------------------------------------------------------------
// foundation.ts — deterministic publication rehearsal
// ---------------------------------------------------------------------------

test('the rehearsal is deterministic for byte-identical input', () => {
  const first = rehearsal();
  const second = rehearsal();
  assert.equal(first.idempotencyKeySha256, second.idempotencyKeySha256);
  assert.equal(first.requestSha256, second.requestSha256);
  assert.equal(first.contentSha256, second.contentSha256);
  assert.match(first.idempotencyKeySha256, /^[0-9a-f]{64}$/u);
  assert.match(first.requestSha256, /^[0-9a-f]{64}$/u);
  assert.notEqual(first.idempotencyKeySha256, first.requestSha256);
  assert.equal(first.schemaVersion, 1);
  assert.equal(first.contract, OWNED_SOCIAL_ACTIVATION_CONTRACT);
  assert.equal(first.ownedAccountSha256, EXPECTED_DIGEST);
  assert.equal(Object.isFrozen(first), true);
});

test('every identity input changes the idempotency key', () => {
  const baseline = rehearsal();
  const identityChanges: ReadonlyArray<readonly [string, () => ReturnType<typeof rehearsal>]> = [
    ['workspaceId', () => rehearsal({ workspaceId: IDS.otherWorkspace })],
    ['providerConnectionId', () => rehearsal({ providerConnectionId: IDS.alternate })],
    ['profileId', () => rehearsal({ profileId: IDS.alternate })],
    ['contentVersionId', () => rehearsal({ contentVersionId: IDS.alternate })],
    ['approvalDecisionId', () => rehearsal({ approvalDecisionId: IDS.alternate })],
    ['scheduledFor', () => rehearsal({ scheduledFor: '2026-09-01T09:00:00.000Z' })],
    ['operationTag', () => rehearsal({}, { operationTag: 'owned-social:other-tag' })],
  ];
  const keys = new Set<string>([baseline.idempotencyKeySha256]);
  for (const [label, build] of identityChanges) {
    const changed = build();
    assert.notEqual(
      changed.idempotencyKeySha256,
      baseline.idempotencyKeySha256,
      `${label} must change the idempotency key`,
    );
    assert.notEqual(
      changed.requestSha256,
      baseline.requestSha256,
      `${label} must also change the request digest`,
    );
    keys.add(changed.idempotencyKeySha256);
  }
  assert.equal(keys.size, identityChanges.length + 1, 'every identity change must be distinct');
});

// The staging identity is identifier-only so the founder portal can derive the
// same key without ever reading the approved post body. The approved bytes
// still bind the request digest.
test('the portal staging key matches the offline rehearsal key exactly', () => {
  const baseline = rehearsal();
  assert.equal(
    deriveOwnedSocialStagingIdempotencyKey(target(), OPERATION_TAG),
    baseline.idempotencyKeySha256,
  );
  const scheduled = '2026-09-01T09:00:00.000Z';
  assert.equal(
    deriveOwnedSocialStagingIdempotencyKey(
      target({ scheduledFor: scheduled }),
      OPERATION_TAG,
    ),
    rehearsal({ scheduledFor: scheduled }).idempotencyKeySha256,
  );
  assert.throws(
    () => deriveOwnedSocialStagingIdempotencyKey(target(), 'not a valid tag'),
    (error: unknown) => error instanceof OwnedSocialActivationError,
  );
  assert.throws(
    () => deriveOwnedSocialStagingIdempotencyKey(
      target({ scheduledFor: '2026-09-01' }), OPERATION_TAG,
    ),
    (error: unknown) => error instanceof OwnedSocialActivationError,
  );
});

// Both digests are identifier-only so the portal, which is table-blind and
// cannot read content_body, derives exactly what the offline rehearsal does.
// The approved bytes are still reported as separate evidence.
test('the approved bytes are reported as evidence, not folded into the digests', () => {
  const baseline = rehearsal();
  const changed = rehearsal({}, { approvedText: 'A different approved sentence' });
  assert.equal(changed.idempotencyKeySha256, baseline.idempotencyKeySha256);
  assert.equal(changed.requestSha256, baseline.requestSha256);
  assert.notEqual(changed.contentSha256, baseline.contentSha256);
  assert.equal(changed.contentMatchesApproval, true);
  // A version whose bytes no longer match its recorded approval is visible.
  const mismatched = rehearsal({}, {
    approvedText: 'Owned social rehearsal proves the exact boundary',
    expectedContentSha256: 'f'.repeat(64),
  });
  assert.equal(mismatched.contentMatchesApproval, false);
});

test('the staging digest pair is distinct and both halves are stable', () => {
  const digests = deriveOwnedSocialStagingDigests(target(), OPERATION_TAG);
  assert.match(digests.idempotencyKeySha256, /^[0-9a-f]{64}$/u);
  assert.match(digests.requestSha256, /^[0-9a-f]{64}$/u);
  assert.notEqual(digests.idempotencyKeySha256, digests.requestSha256);
  assert.deepEqual(digests, deriveOwnedSocialStagingDigests(target(), OPERATION_TAG));
  // Request-only identifiers move the request digest, never the staging key.
  for (const override of [
    { contentItemId: IDS.alternate },
    { approvalRequestId: IDS.alternate },
    { sourceAttestationId: IDS.alternate },
    { expectedOwnedAccountSha256: 'a'.repeat(64) },
  ]) {
    const changed = deriveOwnedSocialStagingDigests(target(override), OPERATION_TAG);
    assert.equal(changed.idempotencyKeySha256, digests.idempotencyKeySha256);
    assert.notEqual(changed.requestSha256, digests.requestSha256);
  }
});

// operationTag and scheduledFor are the only variable-width identity fields and
// they sit next to each other. An operation tag may legally contain ':', '.'
// and '-', so a delimiter-free concatenation would let a tag swallow the whole
// schedule: tag='tag' + schedule='2026-09-01T09:00:00.000Z' would produce the
// same bytes as tag='tag2026-09-01T09:00:00.000Z' + no schedule.
test('adjacent variable-width identity fields cannot be shifted into one another', () => {
  const schedule = '2026-09-01T09:00:00.000Z';
  const shifted = rehearsal({ scheduledFor: schedule }, { operationTag: 'tag' });
  const unshifted = rehearsal({ scheduledFor: null }, { operationTag: `tag${schedule}` });
  assert.notEqual(shifted.idempotencyKeySha256, unshifted.idempotencyKeySha256);
  assert.notEqual(shifted.requestSha256, unshifted.requestSha256);
});

// The schedule is folded into the identity digest, so the rehearsal must refuse
// exactly the timestamps the command boundary would refuse.
test('the rehearsal refuses a schedule the command boundary would reject', () => {
  for (const schedule of [
    'X', 'nonsense', '2026-09-01T09:00:00Z', '2026-09-01 09:00:00+00', '2026-09-01', '',
  ]) {
    assert.throws(
      () => rehearsal({ scheduledFor: schedule }),
      (error: unknown) => error instanceof OwnedSocialActivationError
        && error.code === 'invalid_rehearsal',
      `schedule ${JSON.stringify(schedule)} must be refused`,
    );
  }
  assert.doesNotThrow(() => rehearsal({ scheduledFor: '2026-09-01T09:00:00.000Z' }));
  assert.doesNotThrow(() => rehearsal({ scheduledFor: null }));
});

test('request-only inputs change the request digest but never the idempotency key', () => {
  const baseline = rehearsal();
  const otherDigest = ownedSocialAccountDigest('@SomeOtherOwnedAccount');
  assert.notEqual(otherDigest, EXPECTED_DIGEST);
  const requestChanges: ReadonlyArray<readonly [string, ReturnType<typeof rehearsal>]> = [
    ['contentItemId', rehearsal({ contentItemId: IDS.alternate })],
    ['approvalRequestId', rehearsal({ approvalRequestId: IDS.alternate })],
    ['sourceAttestationId', rehearsal({ sourceAttestationId: IDS.alternate })],
    ['expectedOwnedAccountSha256', rehearsal({ expectedOwnedAccountSha256: otherDigest })],
  ];
  const digests = new Set<string>([baseline.requestSha256]);
  for (const [label, changed] of requestChanges) {
    assert.equal(
      changed.idempotencyKeySha256,
      baseline.idempotencyKeySha256,
      `${label} must not change the idempotency key`,
    );
    assert.notEqual(
      changed.requestSha256,
      baseline.requestSha256,
      `${label} must change the request digest`,
    );
    digests.add(changed.requestSha256);
  }
  assert.equal(digests.size, requestChanges.length + 1);
});

test('the rehearsal hashes the approved bytes and compares them to the approval digest', () => {
  const approvedText = 'Owned social rehearsal proves the exact boundary';
  const expected = createHash('sha256').update(approvedText, 'utf8').digest('hex');
  const matching = rehearsal({}, { approvedText, expectedContentSha256: expected });
  assert.equal(matching.contentSha256, expected);
  assert.equal(matching.contentMatchesApproval, true);
  assert.equal(matching.characterCount, approvedText.length);

  const mismatched = rehearsal({}, {
    approvedText,
    expectedContentSha256: createHash('sha256').update(`${approvedText} `, 'utf8').digest('hex'),
  });
  assert.equal(mismatched.contentSha256, expected);
  assert.equal(mismatched.contentMatchesApproval, false);
  // The mismatch is content-only: identity and request digests are unaffected.
  assert.equal(mismatched.idempotencyKeySha256, matching.idempotencyKeySha256);
  assert.equal(mismatched.requestSha256, matching.requestSha256);
});

test('the rehearsal refuses a malformed operation tag or undigested evidence', () => {
  const invalid: ReadonlyArray<readonly [string, () => unknown]> = [
    ['empty operation tag', () => rehearsal({}, { operationTag: '' })],
    ['operation tag with a space', () => rehearsal({}, { operationTag: 'owned social' })],
    ['operation tag starting with a dot', () => rehearsal({}, { operationTag: '.leading' })],
    ['operation tag over 100 characters', () => rehearsal({}, { operationTag: `a${'b'.repeat(100)}` })],
    ['undigested owned account', () => rehearsal({ expectedOwnedAccountSha256: ACCOUNT_REFERENCE })],
    ['uppercase account digest', () => rehearsal({
      expectedOwnedAccountSha256: EXPECTED_DIGEST.toUpperCase(),
    })],
    ['short account digest', () => rehearsal({
      expectedOwnedAccountSha256: EXPECTED_DIGEST.slice(0, 63),
    })],
    ['malformed approval digest', () => rehearsal({}, { expectedContentSha256: 'not-a-digest' })],
  ];
  for (const [label, build] of invalid) {
    assert.throws(
      build,
      (error: unknown) => error instanceof OwnedSocialActivationError
        && error.code === 'invalid_rehearsal',
      `expected invalid_rehearsal for ${label}`,
    );
  }
});

test('the rehearsal states the hard caps and the exact expected receipt shape', () => {
  const derived = rehearsal();
  assert.deepEqual({ ...derived.caps }, { daily: 1, monthly: 3, perJob: 1 });
  assert.equal(derived.caps.daily, OWNED_SOCIAL_DAILY_CAP);
  assert.equal(derived.caps.monthly, OWNED_SOCIAL_MONTHLY_CAP);
  assert.equal(Object.isFrozen(derived.caps), true);
  assert.deepEqual(derived.expectedReceipt.eventKinds, [
    'accepted', 'published', 'failed', 'outcome_unknown',
  ]);
  assert.equal(derived.expectedReceipt.eventKinds.length, 4);
  assert.deepEqual({ ...derived.expectedReceipt, eventKinds: undefined }, {
    eventKinds: undefined,
    uniqueOn: 'workspace_id, job_id, lease_version',
    evidenceColumn: 'receipt_sha256',
    acceptedBecomes: 'reconciliation_pending',
    publishedBecomes: 'succeeded',
    outcomeUnknownBecomes: 'needs_attention',
  });
  assert.equal(Object.isFrozen(derived.expectedReceipt), true);
});

test('the rehearsal is pure: no provider call, no database handle, no enqueue', () => {
  // The function accepts no pool, adapter or fetch implementation, so there is
  // nothing to stub: purity is proven by it completing with no I/O available
  // and by the effect flags it publishes.
  const derived = deriveOwnedSocialPublicationRehearsal({
    target: target(),
    operationTag: OPERATION_TAG,
    approvedText: CLEAN_280,
    expectedContentSha256: createHash('sha256').update(CLEAN_280, 'utf8').digest('hex'),
  });
  assert.equal(derived instanceof Promise, false, 'the rehearsal must be synchronous');
  assert.equal(derived.providerEffects, false);
  assert.equal(derived.providerCallsMade, false);
  assert.equal(derived.postsPublished, false);
  assert.equal(deriveOwnedSocialPublicationRehearsal.length, 1);
  // Repeating it many times cannot accumulate any state.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const again = rehearsal();
    assert.equal(again.providerCallsMade, false);
    assert.equal(again.postsPublished, false);
  }
});

// ---------------------------------------------------------------------------
// foundation.ts — publishable-text rules (migration 0052, byte-for-byte)
// ---------------------------------------------------------------------------

test('a clean 280-character ASCII post is publishable with no failures', () => {
  assert.equal(CLEAN_280.length, 280);
  assert.equal(OWNED_SOCIAL_MAX_POST_CHARACTERS, 280);
  const derived = rehearsal({}, { approvedText: CLEAN_280 });
  assert.deepEqual(derived.publishableFailures, []);
  assert.equal(derived.publishable, true);
  assert.equal(derived.characterCount, 280);
});

test('281 characters is over the X v1 limit', () => {
  const derived = rehearsal({}, { approvedText: `${CLEAN_280}x` });
  assert.equal(derived.characterCount, 281);
  assert.equal(derived.publishable, false);
  assert.deepEqual(derived.publishableFailures, ['OVER_280_CHARACTERS']);
});

test('empty approved bytes fail as EMPTY and nothing else', () => {
  const derived = rehearsal({}, { approvedText: '' });
  assert.equal(derived.publishable, false);
  assert.deepEqual(derived.publishableFailures, ['EMPTY']);
  assert.equal(derived.characterCount, 0);
  assert.equal(
    derived.contentSha256,
    createHash('sha256').update('', 'utf8').digest('hex'),
  );
});

test('any non-ASCII character fails the printable-ASCII rule', () => {
  const nonAscii: ReadonlyArray<readonly [string, string]> = [
    ['em dash', `Owned rehearsal ${EM_DASH} nothing publishes`],
    ['emoji', 'Owned rehearsal \u{1F680} nothing publishes'],
    ['curly quote', 'Owned \u2019rehearsal\u2019 nothing publishes'],
    ['non-breaking space', 'Owned\u00a0rehearsal nothing publishes'],
    ['tab', 'Owned\trehearsal nothing publishes'],
  ];
  for (const [label, text] of nonAscii) {
    const derived = rehearsal({}, { approvedText: text });
    assert.equal(derived.publishable, false, `${label} must not be publishable`);
    assert.deepEqual(
      derived.publishableFailures,
      ['NON_PRINTABLE_ASCII'],
      `${label} must fail exactly on printable ASCII`,
    );
  }
});

test('every link-shaped fragment is refused as CONTAINS_LINK_OR_DOMAIN', () => {
  const linked = [
    'see https://x.com',
    'visit www.example.com',
    'go to example.com',
    'a//b',
    'mailto:me@x.io',
  ];
  for (const text of linked) {
    const derived = rehearsal({}, { approvedText: text });
    assert.equal(derived.publishable, false, `${text} must not be publishable`);
    assert.equal(
      derived.publishableFailures.includes('CONTAINS_LINK_OR_DOMAIN'),
      true,
      `${text} must be flagged as link-shaped`,
    );
  }
});

test('a post with no link-shaped content is not flagged', () => {
  const clean = [
    'Owned rehearsal proves the exact boundary before any publication',
    'No enqueue, no provider call and no post occurred',
    CLEAN_280,
  ];
  for (const text of clean) {
    const derived = rehearsal({}, { approvedText: text });
    assert.deepEqual(derived.publishableFailures, [], `${text.slice(0, 40)} must be clean`);
    assert.equal(derived.publishable, true);
  }
});

// A full stop followed by a space is NOT a bare domain: the SQL and TS regexes
// both require a letter immediately after the dot, so ordinary prose survives.
test('a plain sentence with full stops is not falsely flagged as a domain', () => {
  const derived = rehearsal({}, { approvedText: 'Hello there. Great day.' });
  assert.deepEqual(derived.publishableFailures, []);
  assert.equal(derived.publishable, true);
  const multi = rehearsal({}, {
    approvedText: 'Owned rehearsal ran. Nothing published. Evidence stands. Done.',
  });
  assert.deepEqual(multi.publishableFailures, []);
  // A dot with no space before the next letter IS treated as a bare domain.
  const joined = rehearsal({}, { approvedText: 'Hello there.Great day' });
  assert.deepEqual(joined.publishableFailures, ['CONTAINS_LINK_OR_DOMAIN']);
});

test('multiple publishable-text rules are reported together in rule order', () => {
  const derived = rehearsal({}, { approvedText: `${EM_DASH}${'a'.repeat(281)}.com` });
  assert.equal(derived.publishable, false);
  assert.deepEqual(derived.publishableFailures, [
    'OVER_280_CHARACTERS',
    'NON_PRINTABLE_ASCII',
    'CONTAINS_LINK_OR_DOMAIN',
  ]);
});

// ---------------------------------------------------------------------------
// foundation.ts — formatting
// ---------------------------------------------------------------------------

test('the rendered readiness always states ZERO PUBLICATION and marks blocked dimensions', () => {
  const blocked = formatOwnedSocialActivationReadiness(buildOwnedSocialActivationReadinessReport(
    blockedRows({
      owned_profile: 'IDENTITY_BINDING_REVOKED',
      publishable_text: 'CONTENT_NOT_PUBLISHABLE',
    }),
  ));
  assert.match(blocked, /ZERO PUBLICATION/u);
  assert.match(blocked, /Result: BLOCKED/u);
  assert.equal(
    blocked.includes(`[BLOCKED] owned_profile ${EM_DASH} IDENTITY_BINDING_REVOKED`),
    true,
  );
  assert.equal(
    blocked.includes(`[BLOCKED] publishable_text ${EM_DASH} CONTENT_NOT_PUBLISHABLE`),
    true,
  );
  assert.match(blocked, /\[PASS\] operator_authority/u);
  assert.equal(blocked.includes('[PASS] owned_profile'), false);
  assert.equal(blocked.includes(ACCOUNT_REFERENCE), false);
  assert.equal(blocked.includes(EXPECTED_DIGEST), false);
  assert.match(blocked, /No command, enqueue or provider call was attempted/u);

  const ready = formatOwnedSocialActivationReadiness(
    buildOwnedSocialActivationReadinessReport(readyRows()),
  );
  assert.match(ready, /ZERO PUBLICATION/u);
  assert.match(ready, /Result: READY FOR SEPARATE OWNED-TEST AUTHORISATION/u);
  assert.equal(ready.includes('[BLOCKED]'), false);
  for (const dimension of OWNED_SOCIAL_ACTIVATION_DIMENSIONS) {
    assert.equal(ready.includes(`[PASS] ${dimension}`), true);
  }
  assert.equal(ready.includes(ACCOUNT_REFERENCE), false);
});

// ---------------------------------------------------------------------------
// probe.ts — calling fences
// ---------------------------------------------------------------------------

test('the probe refuses every non-user, cross-workspace or undigested call before any SQL', async () => {
  const cases: ReadonlyArray<readonly [string, DatabaseRequestContext, OwnedSocialActivationTarget]> = [
    [
      'worker actor kind',
      { actorKind: 'worker', workspaceId: IDS.workspace, requestId: 'req-worker' },
      target(),
    ],
    [
      'system actor kind',
      { actorKind: 'system', workspaceId: IDS.workspace, requestId: 'req-system' },
      target(),
    ],
    [
      'webhook actor kind',
      { actorKind: 'webhook', workspaceId: IDS.workspace, requestId: 'req-webhook' },
      target(),
    ],
    [
      'missing user id',
      { actorKind: 'user', workspaceId: IDS.workspace, requestId: 'req-no-user' },
      target(),
    ],
    [
      'cross-workspace target',
      userContext(),
      target({ workspaceId: IDS.otherWorkspace }),
    ],
    [
      'cross-workspace context',
      userContext({ workspaceId: IDS.otherWorkspace, requestId: 'req-cross' }),
      target(),
    ],
    [
      'undigested owned account',
      userContext(),
      target({ expectedOwnedAccountSha256: ACCOUNT_REFERENCE }),
    ],
    [
      'uppercase digest',
      userContext(),
      target({ expectedOwnedAccountSha256: EXPECTED_DIGEST.toUpperCase() }),
    ],
    [
      'short digest',
      userContext(),
      target({ expectedOwnedAccountSha256: EXPECTED_DIGEST.slice(0, 63) }),
    ],
    [
      'empty digest',
      userContext(),
      target({ expectedOwnedAccountSha256: '' }),
    ],
    [
      'non-canonical scheduled timestamp',
      userContext(),
      target({ scheduledFor: '2026-09-01T09:00:00Z' }),
    ],
    [
      'local-time scheduled timestamp',
      userContext(),
      target({ scheduledFor: '2026-09-01 09:00:00+00' }),
    ],
    [
      'date-only scheduled timestamp',
      userContext(),
      target({ scheduledFor: '2026-09-01' }),
    ],
  ];
  for (const [label, context, candidate] of cases) {
    const pool = fakePool(readyRows() as unknown as Record<string, unknown>[]);
    await assert.rejects(
      probeWith(pool).readiness(context, candidate),
      Error,
      `expected refusal for ${label}`,
    );
    assert.equal(pool.connects(), 0, `${label} must not acquire a pool client`);
    assert.deepEqual(pool.statements, [], `${label} must not issue SQL`);
  }
});

test('the probe raises invalid_target for authenticated but mis-scoped or undigested calls', async () => {
  const cases: ReadonlyArray<readonly [DatabaseRequestContext, OwnedSocialActivationTarget]> = [
    [{ actorKind: 'worker', workspaceId: IDS.workspace, requestId: 'req-worker' }, target()],
    [userContext(), target({ workspaceId: IDS.otherWorkspace })],
    [userContext(), target({ expectedOwnedAccountSha256: ACCOUNT_REFERENCE })],
    [userContext(), target({ expectedOwnedAccountSha256: `${EXPECTED_DIGEST}0` })],
    [userContext(), target({ scheduledFor: '2026-09-01T09:00:00Z' })],
  ];
  for (const [context, candidate] of cases) {
    const pool = fakePool([]);
    await assert.rejects(
      probeWith(pool).readiness(context, candidate),
      (error: unknown) => error instanceof OwnedSocialActivationError
        && error.code === 'invalid_target',
    );
    assert.equal(pool.connects(), 0);
  }
});

// ---------------------------------------------------------------------------
// probe.ts — the one read-only statement
// ---------------------------------------------------------------------------

test('the probe issues one definer read inside a serializable read-only transaction', async () => {
  const pool = fakePool(readyRows() as unknown as Record<string, unknown>[]);
  const report = await createPgOwnedSocialActivationReadinessProbe({
    commandPool: pool.commandPool as never,
  }).readiness(userContext(), target());

  assert.equal(report.result, 'ready-for-separately-authorised-owned-test');
  assert.deepEqual(report.blockers, []);
  assert.equal(report.postsPublished, false);
  assert.equal(pool.connects(), 1);
  assert.equal(pool.releases(), 1);
  assert.equal(pool.destroyed(), false);

  assert.equal(pool.statements[0]?.text, 'BEGIN ISOLATION LEVEL SERIALIZABLE READ ONLY');
  assert.match(pool.statements[0]?.text ?? '', /SERIALIZABLE/u);
  assert.match(pool.statements[0]?.text ?? '', /READ ONLY/u);
  assert.doesNotMatch(pool.statements[0]?.text ?? '', /READ WRITE/u);
  assert.match(pool.statements[1]?.text ?? '', /set_config\('app\.user_id'/u);
  assert.equal(pool.statements.at(-1)?.text, 'COMMIT');
  assert.equal(pool.statements.length, 4);

  const readinessStatements = pool.statements.filter(
    ({ text }) => text.includes('owned-social-activation.readiness'),
  );
  assert.equal(readinessStatements.length, 1);
  const statement = readinessStatements[0] as CapturedStatement;
  assert.match(statement.text, /\/\* owned-social-activation\.readiness \*\//u);
  assert.match(
    statement.text,
    /app_private\.property_predator_owned_social_activation_readiness\(/u,
  );
  assert.match(statement.text, /decode\(\$9, 'hex'\)/u);
  assert.match(statement.text, /\$10::timestamptz/u);
  assert.doesNotMatch(statement.text, /INSERT|UPDATE|DELETE|enqueue/iu);
  assert.deepEqual(statement.values, [
    IDS.workspace,
    IDS.connection,
    IDS.profile,
    IDS.contentItem,
    IDS.contentVersion,
    IDS.approvalRequest,
    IDS.approvalDecision,
    IDS.sourceAttestation,
    EXPECTED_DIGEST,
    null,
  ]);
});

test('the owned account digest travels as 64-char hex text, never as a buffer', async () => {
  const pool = fakePool(readyRows() as unknown as Record<string, unknown>[]);
  await probeWith(pool).readiness(userContext(), target());
  const statement = pool.statements.find(
    ({ text }) => text.includes('owned-social-activation.readiness'),
  ) as CapturedStatement;
  const digest = statement.values?.[8];
  assert.equal(typeof digest, 'string');
  assert.equal(Buffer.isBuffer(digest), false);
  assert.equal((digest as string).length, 64);
  assert.match(digest as string, /^[0-9a-f]{64}$/u);
  assert.equal(digest, EXPECTED_DIGEST);
  assert.match(statement.text, /decode\(\$9, 'hex'\)/u);

  const encoded = JSON.stringify(pool.statements);
  assert.equal(encoded.includes(ACCOUNT_REFERENCE), false);
  assert.equal(encoded.includes('PropertyPredatorHQ'), false);
});

test('a canonical scheduled timestamp is passed through unchanged as the tenth value', async () => {
  const scheduledFor = '2026-09-01T09:00:00.000Z';
  const pool = fakePool(readyRows() as unknown as Record<string, unknown>[]);
  await probeWith(pool).readiness(userContext(), target({ scheduledFor }));
  const statement = pool.statements.find(
    ({ text }) => text.includes('owned-social-activation.readiness'),
  ) as CapturedStatement;
  assert.equal(statement.values?.length, 10);
  assert.equal(statement.values?.[9], scheduledFor);
});

test('the probe reduces database rows to blockers without exposing the target', async () => {
  const rows = blockedRows({
    approved_content: 'APPROVED_CONTENT_REQUIRED',
    cap_headroom: 'CAP_REACHED',
  }) as unknown as Record<string, unknown>[];
  const pool = fakePool(rows);
  const report = await probeWith(pool).readiness(userContext(), target());
  assert.equal(report.result, 'blocked');
  assert.deepEqual(report.blockers, ['APPROVED_CONTENT_REQUIRED', 'CAP_REACHED']);
  assert.equal(report.providerCallsMade, false);
  assert.equal(JSON.stringify(report).includes(EXPECTED_DIGEST), false);
  assert.equal(JSON.stringify(report).includes(ACCOUNT_REFERENCE), false);
});

test('the probe rejects malformed rows and still returns its pool client', async () => {
  const malformed: ReadonlyArray<readonly [string, Record<string, unknown>[]]> = [
    ['non-string dimension', readyRows().map((row, index) => index === 0
      ? { ...row, dimension: 7 }
      : { ...row })],
    ['null dimension', readyRows().map((row, index) => index === 0
      ? { ...row, dimension: null }
      : { ...row })],
    ['non-boolean ready', readyRows().map((row, index) => index === 2
      ? { ...row, ready: 'true' }
      : { ...row })],
    ['undefined ready', readyRows().map((row, index) => index === 2
      ? { ...row, ready: undefined }
      : { ...row })],
    ['non-string non-null blocker code', readyRows().map((row, index) => index === 4
      ? { ...row, ready: false, blockerCode: 42 }
      : { ...row })],
    ['undefined blocker code', readyRows().map((row, index) => index === 4
      ? { ...row, blockerCode: undefined }
      : { ...row })],
    ['unknown dimension name', readyRows().map((row, index) => index === 6
      ? { ...row, dimension: 'publishable_text_v2' }
      : { ...row })],
    ['eleven rows', readyRows().slice(0, 11).map((row) => ({ ...row }))],
  ];
  for (const [label, rows] of malformed) {
    const pool = fakePool(rows);
    await assert.rejects(
      probeWith(pool).readiness(userContext(), target()),
      (error: unknown) => error instanceof OwnedSocialActivationError
        && error.code === 'invalid_evidence',
      `expected invalid_evidence for ${label}`,
    );
    assert.equal(pool.connects(), 1);
    assert.equal(pool.releases(), 1);
    assert.equal(pool.destroyed(), false);
    assert.equal(pool.statements.at(-1)?.text, 'COMMIT');
    assert.equal(pool.statements.filter(({ text }) => text === 'ROLLBACK').length, 0);
  }
});

// ---------------------------------------------------------------------------
// readiness.ts — the founder command identity boundary
// ---------------------------------------------------------------------------

const EXACT_COMMAND_BOUNDARY = Object.freeze({
  exactRole: true,
  schemaUsage: true,
  recordProfileExecute: true,
  revokeProfileExecute: true,
  enqueueExecute: true,
  activationReadinessExecute: true,
  sessionLockExecute: true,
  ledgerExecute: true,
  installationExecute: true,
  workerFunctionsDenied: true,
  tableBlind: true,
  elevatedRolesDenied: true,
});

function boundaryPool(
  rows: readonly Record<string, unknown>[],
): { pool: { query(statement: string): Promise<unknown> }; sql(): string } {
  let captured = '';
  return {
    pool: {
      async query(statement: string) {
        captured = statement;
        return { rows: rows.map((row) => ({ ...row })) };
      },
    },
    sql: () => captured,
  };
}

test('the command boundary probe resolves for an exact all-true boundary', async () => {
  const fake = boundaryPool([{ ...EXACT_COMMAND_BOUNDARY }]);
  await assertOwnedPublicSocialCommandBoundaryReady(fake.pool as never);
  const sql = fake.sql();
  assert.match(sql, /\/\* owned-social\.command-runtime-boundary \*\//u);
  assert.match(sql, /current_user = 'r72_owned_social_command' AS "exactRole"/u);
  assert.match(
    sql,
    /'app_private\.property_predator_owned_social_activation_readiness\(uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,bytea,timestamp with time zone\)'/u,
  );
  assert.match(sql, /AS "activationReadinessExecute"/u);
  assert.match(sql, /'app_private\.record_owned_social_profile\(/u);
  assert.match(sql, /'app_private\.revoke_owned_social_profile\(uuid,uuid,uuid,bytea,text\)'/u);
  assert.match(
    sql,
    /'app_private\.enqueue_owned_social_job\(uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,bytea,bytea,timestamp with time zone\)'/u,
  );
  assert.match(sql, /'app_private\.lock_active_portal_session\(bytea,uuid,uuid\)'/u);
  assert.match(sql, /app_private\.runtime_schema_migrations\(\)/u);
  assert.match(sql, /app_private\.runtime_database_installation_id\(\)/u);
  // Booleans only: no binding, account reference or secret can leave this query,
  // and the statement is a single catalog SELECT with no DML of any kind.
  // (INSERT/UPDATE/DELETE appear only as has_table_privilege privilege names.)
  assert.match(sql, /^\/\* owned-social\.command-runtime-boundary \*\/\s+SELECT\b/u);
  assert.doesNotMatch(sql, /INSERT INTO|DELETE FROM|\bSET\b|account_ref|secret|token/iu);
});

test('the command boundary probe denies all four worker dispatch functions', async () => {
  const fake = boundaryPool([{ ...EXACT_COMMAND_BOUNDARY }]);
  await assertOwnedPublicSocialCommandBoundaryReady(fake.pool as never);
  const sql = fake.sql();
  const workerFunctions = [
    'claim_owned_social_job\\(uuid,uuid,bytea,integer\\)',
    'load_owned_social_job\\(uuid,uuid,bigint,bytea\\)',
    'begin_owned_social_call\\(uuid,uuid,bigint,bytea,boolean,boolean\\)',
    'settle_owned_social_call\\('
      + 'uuid,uuid,bigint,bytea,text,text,bytea,timestamp with time zone,text\\)',
  ];
  for (const fn of workerFunctions) {
    assert.match(
      sql,
      new RegExp(`NOT has_function_privilege\\(\\s*current_user,\\s*'app_private\\.${fn}'`, 'u'),
      `expected ${fn} to be explicitly denied`,
    );
  }
  assert.match(sql, /AS "workerFunctionsDenied"/u);
  assert.equal(workerFunctions.length, 4);
});

test('the command boundary probe asserts table blindness and denies the definer roles', async () => {
  const fake = boundaryPool([{ ...EXACT_COMMAND_BOUNDARY }]);
  await assertOwnedPublicSocialCommandBoundaryReady(fake.pool as never);
  const sql = fake.sql();
  assert.match(sql, /NOT EXISTS/u);
  assert.match(sql, /pg_catalog\.pg_class/u);
  assert.match(sql, /namespace\.nspname IN \('app', 'app_private'\)/u);
  for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) {
    assert.match(
      sql,
      new RegExp(`has_table_privilege\\(current_user, relation\\.oid, '${privilege}'\\)`, 'u'),
    );
  }
  assert.match(sql, /AS "tableBlind"/u);
  assert.match(sql, /NOT pg_has_role\(current_user, 'r72_owner', 'MEMBER'\)/u);
  assert.match(sql, /NOT pg_has_role\(current_user, 'r72_security_definer', 'MEMBER'\)/u);
  assert.match(sql, /NOT pg_has_role\(current_user, 'r72_owned_social_definer', 'MEMBER'\)/u);
  assert.match(sql, /AS "elevatedRolesDenied"/u);
});

test('any single false boundary field makes the command boundary inexact', async () => {
  const fields = Object.keys(EXACT_COMMAND_BOUNDARY);
  assert.equal(fields.length, 12);
  for (const field of fields) {
    const fake = boundaryPool([{ ...EXACT_COMMAND_BOUNDARY, [field]: false }]);
    await assert.rejects(
      assertOwnedPublicSocialCommandBoundaryReady(fake.pool as never),
      /Owned public-social command database boundary is not exact/u,
      `expected ${field}: false to be refused`,
    );
  }
  // Anything that is not exactly true is refused, including truthy stand-ins.
  for (const value of [null, undefined, 'true', 1, 0]) {
    const fake = boundaryPool([{ ...EXACT_COMMAND_BOUNDARY, tableBlind: value }]);
    await assert.rejects(
      assertOwnedPublicSocialCommandBoundaryReady(fake.pool as never),
      /command database boundary is not exact/u,
      `expected tableBlind=${String(value)} to be refused`,
    );
  }
});

test('a boundary row set that is not exactly one row is refused', async () => {
  for (const rows of [[], [{ ...EXACT_COMMAND_BOUNDARY }, { ...EXACT_COMMAND_BOUNDARY }]]) {
    const fake = boundaryPool(rows);
    await assert.rejects(
      assertOwnedPublicSocialCommandBoundaryReady(fake.pool as never),
      /command database boundary is not exact/u,
    );
  }
});

test('a failing boundary query reports that the boundary could not be verified', async () => {
  await assert.rejects(
    assertOwnedPublicSocialCommandBoundaryReady({
      async query() { throw new Error('permission denied for schema app_private'); },
    } as never),
    /Owned public-social command database boundary could not be verified/u,
  );
  // The underlying database message must not leak into the readiness error.
  await assert.rejects(
    assertOwnedPublicSocialCommandBoundaryReady({
      async query() { throw new Error('password authentication failed for user'); },
    } as never),
    (error: unknown) => error instanceof Error
      && /could not be verified/u.test(error.message)
      && !/password/u.test(error.message),
  );
});
