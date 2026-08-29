import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import type { DatabaseRequestContext } from '../src/db/rls.js';
import {
  WHATSAPP_ACTIVATION_BLOCKER_CODES,
  WHATSAPP_ACTIVATION_COMMAND_TIME_EVIDENCE,
  WHATSAPP_ACTIVATION_DIMENSIONS,
  WHATSAPP_ACTIVATION_READINESS_CONTRACT,
  WhatsAppActivationReadinessError,
  buildWhatsAppActivationReadinessReport,
  formatWhatsAppActivationReadiness,
  ownedWhatsAppRecipientDigest,
  readWhatsAppActivationTarget,
  type WhatsAppActivationBlockerCode,
  type WhatsAppActivationDimension,
  type WhatsAppActivationDimensionResult,
  type WhatsAppActivationTarget,
} from '../src/whatsapp-activation/foundation.js';
import {
  PgWhatsAppActivationReadinessProbe,
  createPgWhatsAppActivationReadinessProbe,
} from '../src/whatsapp-activation-pg/probe.js';

const RECIPIENT = '+447700900123';
const RECIPIENT_DIGITS = '447700900123';
const EXPECTED_DIGEST = createHash('sha256').update(RECIPIENT_DIGITS, 'utf8').digest('hex');

const IDS = Object.freeze({
  workspace: '11111111-1111-4111-8111-111111111111',
  otherWorkspace: '99999999-9999-4999-8999-999999999999',
  binding: '22222222-2222-4222-8222-222222222222',
  template: '33333333-3333-4333-8333-333333333333',
  contact: '44444444-4444-4444-8444-444444444444',
  contactPoint: '55555555-5555-4555-8555-555555555555',
  consentEvent: '66666666-6666-4666-8666-666666666666',
  user: '77777777-7777-4777-8777-777777777777',
});

const PURPOSE = 'owned_activation_rehearsal';

function validEnv(overrides: Readonly<Record<string, string | undefined>> = {}): NodeJS.ProcessEnv {
  const env: Record<string, string | undefined> = {
    PROPERTY_PREDATOR_REHEARSAL_WORKSPACE_ID: IDS.workspace,
    PROPERTY_PREDATOR_WHATSAPP_LIVE_BINDING_ID: IDS.binding,
    PROPERTY_PREDATOR_REHEARSAL_WHATSAPP_TEMPLATE_ID: IDS.template,
    PROPERTY_PREDATOR_REHEARSAL_WHATSAPP_PERSON_ID: IDS.contact,
    PROPERTY_PREDATOR_REHEARSAL_WHATSAPP_ENDPOINT_ID: IDS.contactPoint,
    PROPERTY_PREDATOR_REHEARSAL_WHATSAPP_CONSENT_EVIDENCE_ID: IDS.consentEvent,
    PROPERTY_PREDATOR_REHEARSAL_WHATSAPP_PURPOSE: PURPOSE,
    PROPERTY_PREDATOR_REHEARSAL_WHATSAPP_RECIPIENT: RECIPIENT,
    PROPERTY_PREDATOR_REHEARSAL_WHATSAPP_RECIPIENT_OWNED: 'true',
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env as NodeJS.ProcessEnv;
}

function readyRows(): WhatsAppActivationDimensionResult[] {
  return WHATSAPP_ACTIVATION_DIMENSIONS.map((dimension) => ({
    dimension,
    ready: true,
    blockerCode: null,
  }));
}

function blockedRows(
  blocks: Readonly<Record<string, WhatsAppActivationBlockerCode>>,
): WhatsAppActivationDimensionResult[] {
  return readyRows().map((row) => {
    const blockerCode = blocks[row.dimension];
    return blockerCode ? { dimension: row.dimension, ready: false, blockerCode } : row;
  });
}

function target(
  overrides: Partial<WhatsAppActivationTarget> = {},
): WhatsAppActivationTarget {
  return Object.freeze({
    workspaceId: IDS.workspace,
    bindingId: IDS.binding,
    templateId: IDS.template,
    contactId: IDS.contact,
    contactPointId: IDS.contactPoint,
    consentEventId: IDS.consentEvent,
    purpose: PURPOSE,
    expectedRecipientSha256: EXPECTED_DIGEST,
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
    requestId: 'whatsapp-activation-readiness-request',
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
      if (text.includes('meta-whatsapp-activation.readiness')) {
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

function probeWith(pool: FakePool): PgWhatsAppActivationReadinessProbe {
  return new PgWhatsAppActivationReadinessProbe({ commandPool: pool.commandPool as never });
}

// ---------------------------------------------------------------------------
// foundation.ts — recipient digest
// ---------------------------------------------------------------------------

test('owned recipient digest hashes the E.164 without its leading plus', () => {
  assert.equal(ownedWhatsAppRecipientDigest(RECIPIENT), EXPECTED_DIGEST);
  assert.match(EXPECTED_DIGEST, /^[0-9a-f]{64}$/u);
  // The plus-inclusive digest must NOT be what the module produces.
  assert.notEqual(
    EXPECTED_DIGEST,
    createHash('sha256').update(RECIPIENT, 'utf8').digest('hex'),
  );
  assert.equal(ownedWhatsAppRecipientDigest(`  ${RECIPIENT}  `), EXPECTED_DIGEST);
});

test('owned recipient digest rejects every non owned-UK-E.164 shape', () => {
  const invalid = [
    '+15551234567',
    '447700900123',
    '+44770090012a',
    '',
    '   ',
    '+4477009001',
    '+447700900123456',
    '+44 7700 900123',
  ];
  for (const candidate of invalid) {
    assert.throws(
      () => ownedWhatsAppRecipientDigest(candidate),
      (error: unknown) => error instanceof WhatsAppActivationReadinessError
        && error.code === 'invalid_target'
        && error.name === 'WhatsAppActivationReadinessError',
      `expected rejection for ${JSON.stringify(candidate)}`,
    );
  }
});

// ---------------------------------------------------------------------------
// foundation.ts — target reading
// ---------------------------------------------------------------------------

test('a complete owned target reads as a frozen digest-only target', () => {
  const outcome = readWhatsAppActivationTarget(validEnv());
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.deepEqual({ ...outcome.target }, {
    workspaceId: IDS.workspace,
    bindingId: IDS.binding,
    templateId: IDS.template,
    contactId: IDS.contact,
    contactPointId: IDS.contactPoint,
    consentEventId: IDS.consentEvent,
    purpose: PURPOSE,
    expectedRecipientSha256: EXPECTED_DIGEST,
  });
  assert.equal(outcome.target.expectedRecipientSha256, ownedWhatsAppRecipientDigest(RECIPIENT));
  assert.equal(Object.isFrozen(outcome.target), true);
  assert.equal(Object.isFrozen(outcome), true);
  assert.throws(() => {
    (outcome.target as { purpose: string }).purpose = 'mutated';
  }, TypeError);
  const encoded = JSON.stringify(outcome.target);
  assert.equal(encoded.includes(RECIPIENT_DIGITS), false);
  assert.equal(encoded.includes(RECIPIENT), false);
  assert.equal(encoded.includes('7700900123'), false);
  assert.equal(encoded.includes('700900123'), false);
});

test('each malformed or absent identifier is reported by its exact setting name', () => {
  const cases: ReadonlyArray<readonly [string, string | undefined]> = [
    ['PROPERTY_PREDATOR_REHEARSAL_WORKSPACE_ID', undefined],
    ['PROPERTY_PREDATOR_WHATSAPP_LIVE_BINDING_ID', 'not-a-uuid'],
    ['PROPERTY_PREDATOR_REHEARSAL_WHATSAPP_TEMPLATE_ID', ''],
    ['PROPERTY_PREDATOR_REHEARSAL_WHATSAPP_PERSON_ID', '33333333-3333-4333-8333-33333333333'],
    ['PROPERTY_PREDATOR_REHEARSAL_WHATSAPP_ENDPOINT_ID', '55555555-5555-4555-8555-555555555555 extra'],
    ['PROPERTY_PREDATOR_REHEARSAL_WHATSAPP_CONSENT_EVIDENCE_ID', undefined],
  ];
  for (const [setting, value] of cases) {
    const outcome = readWhatsAppActivationTarget(validEnv({ [setting]: value }));
    assert.equal(outcome.ok, false, `expected ${setting} to be reported`);
    if (outcome.ok) continue;
    assert.deepEqual(outcome.missing, [setting]);
    assert.equal(Object.isFrozen(outcome.missing), true);
  }
});

test('purpose, recipient and ownership attestation are validated by exact setting name', () => {
  const cases: ReadonlyArray<readonly [string, string | undefined]> = [
    ['PROPERTY_PREDATOR_REHEARSAL_WHATSAPP_PURPOSE', 'Owned Rehearsal'],
    ['PROPERTY_PREDATOR_REHEARSAL_WHATSAPP_PURPOSE', '9_leading_digit'],
    ['PROPERTY_PREDATOR_REHEARSAL_WHATSAPP_PURPOSE', undefined],
    ['PROPERTY_PREDATOR_REHEARSAL_WHATSAPP_PURPOSE', `a${'b'.repeat(100)}`],
    ['PROPERTY_PREDATOR_REHEARSAL_WHATSAPP_RECIPIENT', '+15551234567'],
    ['PROPERTY_PREDATOR_REHEARSAL_WHATSAPP_RECIPIENT', '447700900123'],
    ['PROPERTY_PREDATOR_REHEARSAL_WHATSAPP_RECIPIENT', undefined],
    ['PROPERTY_PREDATOR_REHEARSAL_WHATSAPP_RECIPIENT_OWNED', 'false'],
    ['PROPERTY_PREDATOR_REHEARSAL_WHATSAPP_RECIPIENT_OWNED', undefined],
    ['PROPERTY_PREDATOR_REHEARSAL_WHATSAPP_RECIPIENT_OWNED', 'yes'],
    ['PROPERTY_PREDATOR_REHEARSAL_WHATSAPP_RECIPIENT_OWNED', '1'],
  ];
  for (const [setting, value] of cases) {
    const outcome = readWhatsAppActivationTarget(validEnv({ [setting]: value }));
    assert.equal(outcome.ok, false, `expected ${setting}=${String(value)} to be reported`);
    if (outcome.ok) continue;
    assert.deepEqual(outcome.missing, [setting]);
  }
});

test('the ownership attestation is required even when every other setting is valid', () => {
  const absent = readWhatsAppActivationTarget(
    validEnv({ PROPERTY_PREDATOR_REHEARSAL_WHATSAPP_RECIPIENT_OWNED: undefined }),
  );
  assert.deepEqual(absent, {
    ok: false,
    missing: ['PROPERTY_PREDATOR_REHEARSAL_WHATSAPP_RECIPIENT_OWNED'],
  });
  const denied = readWhatsAppActivationTarget(
    validEnv({ PROPERTY_PREDATOR_REHEARSAL_WHATSAPP_RECIPIENT_OWNED: 'false' }),
  );
  assert.deepEqual(denied, {
    ok: false,
    missing: ['PROPERTY_PREDATOR_REHEARSAL_WHATSAPP_RECIPIENT_OWNED'],
  });
  const affirmed = readWhatsAppActivationTarget(
    validEnv({ PROPERTY_PREDATOR_REHEARSAL_WHATSAPP_RECIPIENT_OWNED: '  TRUE  ' }),
  );
  assert.equal(affirmed.ok, true);
});

test('an entirely absent environment reports every setting in declaration order', () => {
  const outcome = readWhatsAppActivationTarget({} as NodeJS.ProcessEnv);
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.deepEqual(outcome.missing, [
    'PROPERTY_PREDATOR_REHEARSAL_WORKSPACE_ID',
    'PROPERTY_PREDATOR_WHATSAPP_LIVE_BINDING_ID',
    'PROPERTY_PREDATOR_REHEARSAL_WHATSAPP_TEMPLATE_ID',
    'PROPERTY_PREDATOR_REHEARSAL_WHATSAPP_PERSON_ID',
    'PROPERTY_PREDATOR_REHEARSAL_WHATSAPP_ENDPOINT_ID',
    'PROPERTY_PREDATOR_REHEARSAL_WHATSAPP_CONSENT_EVIDENCE_ID',
    'PROPERTY_PREDATOR_REHEARSAL_WHATSAPP_PURPOSE',
    'PROPERTY_PREDATOR_REHEARSAL_WHATSAPP_RECIPIENT',
    'PROPERTY_PREDATOR_REHEARSAL_WHATSAPP_RECIPIENT_OWNED',
  ]);
});

// ---------------------------------------------------------------------------
// foundation.ts — report building
// ---------------------------------------------------------------------------

test('twelve ready dimensions build a zero-send ready report with deferred request-bound evidence', () => {
  const report = buildWhatsAppActivationReadinessReport(readyRows());
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.contract, WHATSAPP_ACTIVATION_READINESS_CONTRACT);
  assert.equal(report.result, 'ready-for-separately-authorised-owned-test');
  assert.deepEqual(report.blockers, []);
  assert.equal(report.providerEffects, false);
  assert.equal(report.providerCallsMade, false);
  assert.equal(report.messagesSent, false);
  assert.deepEqual(
    report.dimensions.map((entry) => entry.dimension),
    [...WHATSAPP_ACTIVATION_DIMENSIONS],
  );
  assert.equal(report.dimensions.length, 12);
  assert.equal(report.dimensions.every((entry) => entry.ready && entry.blockerCode === null), true);
  assert.deepEqual(report.commandTimeEvidence, [
    'compliance_subject_id',
    'policy_publication_event_id',
    'pecr_sender_decision_event_id',
    'pecr_instigator_decision_event_id',
    'permission_use_receipt_id',
  ]);
  assert.deepEqual(report.commandTimeEvidence, [...WHATSAPP_ACTIVATION_COMMAND_TIME_EVIDENCE]);
  assert.equal(report.commandTimeEvidence.length, 5);
  assert.match(report.nextStep, /separate authorisation/u);
  assert.equal(Object.isFrozen(report), true);
  assert.equal(Object.isFrozen(report.dimensions), true);
});

test('malformed database evidence is rejected rather than silently passed as readiness', () => {
  const invalidSets: ReadonlyArray<readonly [string, readonly WhatsAppActivationDimensionResult[]]> = [
    ['too few rows', readyRows().slice(0, 11)],
    ['too many rows', [...readyRows(), readyRows()[0] as WhatsAppActivationDimensionResult]],
    ['no rows', []],
    ['out of order', (() => {
      const rows = readyRows();
      const first = rows[0] as WhatsAppActivationDimensionResult;
      rows[0] = rows[1] as WhatsAppActivationDimensionResult;
      rows[1] = first;
      return rows;
    })()],
    ['unknown dimension name', readyRows().map((row, index) => index === 0
      ? { ...row, dimension: 'operator_authority_v2' as WhatsAppActivationDimension }
      : row)],
    ['duplicate dimension', readyRows().map((row, index) => index === 1
      ? { ...row, dimension: 'operator_authority' as WhatsAppActivationDimension }
      : row)],
    ['ready with a blocker code', readyRows().map((row, index) => index === 3
      ? { ...row, ready: true, blockerCode: 'TEMPLATE_NOT_APPROVED' as WhatsAppActivationBlockerCode }
      : row)],
    ['blocked with a null blocker code', readyRows().map((row, index) => index === 3
      ? { ...row, ready: false, blockerCode: null }
      : row)],
    ['blocked with an unknown blocker code', readyRows().map((row, index) => index === 3
      ? { ...row, ready: false, blockerCode: 'TEMPLATE_EXPLODED' as WhatsAppActivationBlockerCode }
      : row)],
    ['non-boolean ready', readyRows().map((row, index) => index === 5
      ? { ...row, ready: 'true' as unknown as boolean }
      : row)],
  ];
  for (const [label, rows] of invalidSets) {
    assert.throws(
      () => buildWhatsAppActivationReadinessReport(rows),
      (error: unknown) => error instanceof WhatsAppActivationReadinessError
        && error.code === 'invalid_evidence',
      `expected invalid_evidence for ${label}`,
    );
  }
});

test('a blocked report lists its blockers in dimension order, not alphabetical order', () => {
  const report = buildWhatsAppActivationReadinessReport(blockedRows({
    provider_connection: 'PROVIDER_NOT_CONFIGURED',
    recipient_matches_supplied_owned_target: 'RECIPIENT_EVIDENCE_MISMATCH',
    emergency_pause_clear: 'EMERGENCY_PAUSED',
  }));
  assert.equal(report.result, 'blocked');
  assert.deepEqual(report.blockers, [
    'PROVIDER_NOT_CONFIGURED',
    'RECIPIENT_EVIDENCE_MISMATCH',
    'EMERGENCY_PAUSED',
  ]);
  assert.notDeepEqual(report.blockers, [...report.blockers].sort());
  assert.equal(report.providerEffects, false);
  assert.equal(report.messagesSent, false);
  assert.match(report.nextStep, /No command, enqueue or provider call was attempted/u);
  assert.equal(
    report.blockers.every((code) => WHATSAPP_ACTIVATION_BLOCKER_CODES.includes(code)),
    true,
  );
});

// ---------------------------------------------------------------------------
// foundation.ts — formatting
// ---------------------------------------------------------------------------

test('the rendered readiness always states ZERO SEND and never renders a recipient', () => {
  const blocked = formatWhatsAppActivationReadiness(buildWhatsAppActivationReadinessReport(
    blockedRows({
      owned_binding: 'BINDING_REVOKED',
      inbound_ingress: 'INGRESS_NOT_READY',
    }),
  ));
  assert.match(blocked, /ZERO SEND/u);
  assert.match(blocked, /Result: BLOCKED/u);
  const dash = '—';
  assert.equal(blocked.includes(`[BLOCKED] owned_binding ${dash} BINDING_REVOKED`), true);
  assert.equal(blocked.includes(`[BLOCKED] inbound_ingress ${dash} INGRESS_NOT_READY`), true);
  assert.match(blocked, /\[PASS\] operator_authority/u);
  assert.equal(blocked.includes('[PASS] owned_binding'), false);
  for (const item of WHATSAPP_ACTIVATION_COMMAND_TIME_EVIDENCE) {
    assert.equal(blocked.includes(`[DEFERRED] ${item}`), true);
  }
  assert.equal(blocked.includes(RECIPIENT_DIGITS), false);
  assert.equal(blocked.includes(RECIPIENT), false);
  assert.doesNotMatch(blocked, /\+?\d{9,}/u);

  const ready = formatWhatsAppActivationReadiness(
    buildWhatsAppActivationReadinessReport(readyRows()),
  );
  assert.match(ready, /ZERO SEND/u);
  assert.match(ready, /Result: READY FOR SEPARATE OWNED-TEST AUTHORISATION/u);
  assert.equal(ready.includes('[BLOCKED]'), false);
  assert.equal(ready.includes(RECIPIENT_DIGITS), false);
  assert.doesNotMatch(ready, /\+?\d{9,}/u);
});

// ---------------------------------------------------------------------------
// probe.ts — calling fences
// ---------------------------------------------------------------------------

test('the probe refuses every non-user, cross-workspace or undigested call before any SQL', async () => {
  const cases: ReadonlyArray<readonly [string, DatabaseRequestContext, WhatsAppActivationTarget]> = [
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
      'undigested recipient',
      userContext(),
      target({ expectedRecipientSha256: RECIPIENT_DIGITS }),
    ],
    [
      'uppercase digest',
      userContext(),
      target({ expectedRecipientSha256: EXPECTED_DIGEST.toUpperCase() }),
    ],
    [
      'short digest',
      userContext(),
      target({ expectedRecipientSha256: EXPECTED_DIGEST.slice(0, 63) }),
    ],
    [
      'empty digest',
      userContext(),
      target({ expectedRecipientSha256: '' }),
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
  const cases: ReadonlyArray<readonly [DatabaseRequestContext, WhatsAppActivationTarget]> = [
    [{ actorKind: 'worker', workspaceId: IDS.workspace, requestId: 'req-worker' }, target()],
    [userContext(), target({ workspaceId: IDS.otherWorkspace })],
    [userContext(), target({ expectedRecipientSha256: RECIPIENT_DIGITS })],
    [userContext(), target({ expectedRecipientSha256: `${EXPECTED_DIGEST}0` })],
  ];
  for (const [context, candidate] of cases) {
    const pool = fakePool([]);
    await assert.rejects(
      probeWith(pool).readiness(context, candidate),
      (error: unknown) => error instanceof WhatsAppActivationReadinessError
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
  const report = await createPgWhatsAppActivationReadinessProbe({
    commandPool: pool.commandPool as never,
  }).readiness(userContext(), target());

  assert.equal(report.result, 'ready-for-separately-authorised-owned-test');
  assert.deepEqual(report.blockers, []);
  assert.equal(report.messagesSent, false);
  assert.equal(pool.connects(), 1);
  assert.equal(pool.releases(), 1);
  assert.equal(pool.destroyed(), false);

  assert.equal(pool.statements[0]?.text, 'BEGIN ISOLATION LEVEL SERIALIZABLE READ ONLY');
  assert.match(pool.statements[1]?.text ?? '', /set_config\('app\.user_id'/u);
  assert.equal(pool.statements.at(-1)?.text, 'COMMIT');
  assert.equal(pool.statements.length, 4);

  const readinessStatements = pool.statements.filter(
    ({ text }) => text.includes('meta-whatsapp-activation.readiness'),
  );
  assert.equal(readinessStatements.length, 1);
  const statement = readinessStatements[0] as CapturedStatement;
  assert.match(statement.text, /\/\* meta-whatsapp-activation\.readiness \*\//u);
  assert.match(
    statement.text,
    /app_private\.property_predator_whatsapp_activation_readiness\(/u,
  );
  assert.match(statement.text, /decode\(\$8, 'hex'\)/u);
  assert.doesNotMatch(statement.text, /INSERT|UPDATE|DELETE|enqueue/iu);
  assert.deepEqual(statement.values, [
    IDS.workspace,
    IDS.binding,
    IDS.template,
    IDS.contact,
    IDS.contactPoint,
    IDS.consentEvent,
    PURPOSE,
    EXPECTED_DIGEST,
  ]);
});

test('the recipient digest travels as 64-char hex text, never as a buffer or a number', async () => {
  const pool = fakePool(readyRows() as unknown as Record<string, unknown>[]);
  await probeWith(pool).readiness(userContext(), target());
  const statement = pool.statements.find(
    ({ text }) => text.includes('meta-whatsapp-activation.readiness'),
  ) as CapturedStatement;
  const digest = statement.values?.[7];
  assert.equal(typeof digest, 'string');
  assert.equal(Buffer.isBuffer(digest), false);
  assert.equal((digest as string).length, 64);
  assert.match(digest as string, /^[0-9a-f]{64}$/u);
  assert.equal(digest, EXPECTED_DIGEST);

  const encoded = JSON.stringify(pool.statements);
  assert.equal(encoded.includes(RECIPIENT_DIGITS), false);
  assert.equal(encoded.includes('7700900123'), false);
  assert.doesNotMatch(encoded, /\+44/u);
});

test('the probe reduces database rows to blockers without exposing the target', async () => {
  const rows = blockedRows({
    approved_template: 'TEMPLATE_NOT_APPROVED',
    current_consent: 'CONSENT_NOT_CURRENT',
  }) as unknown as Record<string, unknown>[];
  const pool = fakePool(rows);
  const report = await probeWith(pool).readiness(userContext(), target());
  assert.equal(report.result, 'blocked');
  assert.deepEqual(report.blockers, ['TEMPLATE_NOT_APPROVED', 'CONSENT_NOT_CURRENT']);
  assert.equal(report.providerCallsMade, false);
  assert.equal(JSON.stringify(report).includes(RECIPIENT_DIGITS), false);
  assert.equal(JSON.stringify(report).includes(EXPECTED_DIGEST), false);
});

// Row shape is revalidated after the read-only transaction has already
// committed, so a malformed row set still leaves the client cleanly released.
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
  ];
  for (const [label, rows] of malformed) {
    const pool = fakePool(rows);
    await assert.rejects(
      probeWith(pool).readiness(userContext(), target()),
      (error: unknown) => error instanceof WhatsAppActivationReadinessError
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

test('the probe rejects a database row set that is not the twelve ordered dimensions', async () => {
  const rows = readyRows().slice(0, 11) as unknown as Record<string, unknown>[];
  const pool = fakePool(rows);
  await assert.rejects(
    probeWith(pool).readiness(userContext(), target()),
    (error: unknown) => error instanceof WhatsAppActivationReadinessError
      && error.code === 'invalid_evidence',
  );
  assert.equal(pool.statements.at(-1)?.text, 'COMMIT');
  assert.equal(pool.releases(), 1);
});
