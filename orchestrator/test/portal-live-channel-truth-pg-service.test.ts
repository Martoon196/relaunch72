import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { InactivePortalSessionError } from '../src/db/transaction.js';
import {
  createPgPortalLiveChannelTruthService,
  PgPortalLiveChannelTruthService,
  type PgPortalLiveChannelTruthDependencies,
} from '../src/portal/live-channel-truth-pg-service.js';

const SESSION = 'opaque-live-channel-truth-session';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const WORKSPACE_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_WORKSPACE_ID = '33333333-3333-4333-8333-333333333333';
const SNAPSHOT_AT = '2026-08-29T09:00:00.000Z';
const RECEIPT_AT = '2026-08-29T08:55:00.000Z';
const EVIDENCE_SHA256 = 'a'.repeat(64);

type TruthRow = Record<string, unknown>;

function row(
  rail: 'customer_email' | 'owned_social' | 'whatsapp' | 'sms' | 'social_dm',
  overrides: Readonly<Record<string, unknown>> = {},
): TruthRow {
  const defaults: Record<typeof rail, TruthRow> = {
    customer_email: {
      workspaceId: WORKSPACE_ID,
      snapshotAt: SNAPSHOT_AT,
      rail,
      connectionState: 'ready',
      inboundState: 'ready',
      outboundOrReplyState: 'effects_disabled',
      receiptState: 'healthy',
      dailyUsed: '2',
      dailyLimit: '10',
      monthlyUsed: '9',
      monthlyLimit: '50',
      blockerCodes: ['EFFECTS_DISABLED', 'EFFECTS_DISABLED'],
      latestReceiptId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      latestReceiptOutcome: 'succeeded',
      latestReceiptAt: RECEIPT_AT,
      latestReceiptEvidenceSha256: EVIDENCE_SHA256,
    },
    owned_social: {
      workspaceId: WORKSPACE_ID,
      snapshotAt: SNAPSHOT_AT,
      rail,
      connectionState: 'not_configured',
      inboundState: 'not_supported',
      outboundOrReplyState: 'effects_disabled',
      receiptState: 'none',
      dailyUsed: 0,
      dailyLimit: 1,
      monthlyUsed: 0,
      monthlyLimit: 3,
      blockerCodes: ['PROVIDER_NOT_CONFIGURED', 'EFFECTS_DISABLED'],
      latestReceiptId: null,
      latestReceiptOutcome: null,
      latestReceiptAt: null,
      latestReceiptEvidenceSha256: null,
    },
    whatsapp: {
      workspaceId: WORKSPACE_ID,
      snapshotAt: SNAPSHOT_AT,
      rail,
      connectionState: 'configured',
      inboundState: 'not_ready',
      outboundOrReplyState: 'approval_required',
      receiptState: 'pending',
      dailyUsed: 0,
      dailyLimit: 1,
      monthlyUsed: 0,
      monthlyLimit: 3,
      blockerCodes: ['INGRESS_NOT_READY', 'APPROVAL_REQUIRED'],
      latestReceiptId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      latestReceiptOutcome: 'accepted',
      latestReceiptAt: RECEIPT_AT,
      latestReceiptEvidenceSha256: 'b'.repeat(64),
    },
    sms: {
      workspaceId: WORKSPACE_ID,
      snapshotAt: SNAPSHOT_AT,
      rail,
      connectionState: 'not_configured',
      inboundState: 'not_ready',
      outboundOrReplyState: 'blocked',
      receiptState: 'none',
      dailyUsed: '0',
      dailyLimit: '10',
      monthlyUsed: '0',
      monthlyLimit: '50',
      blockerCodes: ['PROVIDER_NOT_CONFIGURED', 'INGRESS_NOT_READY'],
      latestReceiptId: null,
      latestReceiptOutcome: null,
      latestReceiptAt: null,
      latestReceiptEvidenceSha256: null,
    },
    social_dm: {
      workspaceId: WORKSPACE_ID,
      snapshotAt: SNAPSHOT_AT,
      rail,
      connectionState: 'not_composed',
      inboundState: 'not_ready',
      outboundOrReplyState: 'not_supported',
      receiptState: 'none',
      dailyUsed: 0,
      dailyLimit: 0,
      monthlyUsed: 0,
      monthlyLimit: 0,
      blockerCodes: ['LIVE_ADAPTER_NOT_COMPOSED'],
      latestReceiptId: null,
      latestReceiptOutcome: null,
      latestReceiptAt: null,
      latestReceiptEvidenceSha256: null,
    },
  };
  return { ...defaults[rail], ...overrides };
}

function rows(): TruthRow[] {
  return [row('whatsapp'), row('social_dm'), row('sms'), row('customer_email'), row('owned_social')];
}

function dependencies(
  returnedRows: readonly TruthRow[] = rows(),
  overrides: Partial<PgPortalLiveChannelTruthDependencies> = {},
): PgPortalLiveChannelTruthDependencies {
  return {
    principalResolver: {
      resolve: async () => Object.freeze({ userId: USER_ID, workspaceId: WORKSPACE_ID }),
    },
    readRunner: {
      async run(_context, operation) {
        return operation({
          query: async () => ({ rows: [...returnedRows], rowCount: returnedRows.length }),
        } as never);
      },
    },
    ...overrides,
  };
}

test('live-channel truth resolves the opaque session and returns one canonical safe rail set', async () => {
  let queryText = '';
  const contexts: unknown[] = [];
  const service = new PgPortalLiveChannelTruthService(dependencies(rows(), {
    principalResolver: {
      async resolve(sessionToken) {
        assert.equal(sessionToken, SESSION);
        return Object.freeze({ userId: USER_ID, workspaceId: WORKSPACE_ID });
      },
    },
    readRunner: {
      async run(context, operation, options) {
        contexts.push(context);
        assert.deepEqual(options, { readOnly: true, serializable: true });
        return operation({
          async query(sql: string, values?: readonly unknown[]) {
            queryText = sql;
            assert.deepEqual(values, undefined);
            return { rows: rows(), rowCount: 5 };
          },
        } as never);
      },
    },
  }));

  const outcome = await service.snapshot({ sessionToken: SESSION, requestId: 'channel-truth-request-1' });

  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(contexts.length, 1);
  assert.deepEqual(contexts[0], {
    actorKind: 'user',
    userId: USER_ID,
    workspaceId: WORKSPACE_ID,
    requestId: 'channel-truth-request-1',
    portalSessionTokenHash: createHash('sha256').update(SESSION).digest(),
  });
  assert.match(queryText, /FROM app_private\.property_predator_live_channel_truth\(\) AS truth/u);
  assert.doesNotMatch(queryText, /FROM\s+app\./iu);
  assert.doesNotMatch(queryText, /recipient|address|payload|secret|credential|token/iu);
  assert.equal(outcome.snapshot.dataset, 'postgres_authoritative');
  assert.equal(outcome.snapshot.workspaceId, WORKSPACE_ID);
  assert.deepEqual(outcome.snapshot.rails.map((entry) => entry.rail), [
    'customer_email', 'owned_social', 'whatsapp', 'sms', 'social_dm',
  ]);
  assert.deepEqual(outcome.snapshot.rails[0]?.blockerCodes, ['EFFECTS_DISABLED']);
  assert.deepEqual(outcome.snapshot.rails[0]?.caps.daily, { used: 2, limit: 10, remaining: 8 });
  assert.deepEqual(outcome.snapshot.rails[0]?.latestReceipt, {
    receiptId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    outcome: 'succeeded',
    recordedAt: RECEIPT_AT,
    evidenceSha256: EVIDENCE_SHA256,
  });
  const encoded = JSON.stringify(outcome.snapshot);
  assert.doesNotMatch(
    encoded,
    /mailgun|meta|@|bearer|api[_-]?key|providerExternalId|provider_payload/iu,
  );
  assert.equal('enqueue' in service, false);
  assert.equal('connect' in service, false);
});

test('live-channel truth fails before the definer read when the session is unresolved', async () => {
  let reads = 0;
  const service = new PgPortalLiveChannelTruthService(dependencies(rows(), {
    principalResolver: { resolve: async () => null },
    readRunner: {
      async run() {
        reads += 1;
        throw new Error('must not run');
      },
    },
  }));
  assert.deepEqual(
    await service.snapshot({ sessionToken: SESSION, requestId: 'channel-truth-request-2' }),
    { ok: false, kind: 'unauthenticated', message: 'This portal session is no longer active.' },
  );
  assert.equal(reads, 0);
});

test('live-channel truth rejects missing, duplicate and unknown rails', async () => {
  const invalidSets: readonly TruthRow[][] = [
    rows().slice(0, 4),
    [row('customer_email'), row('owned_social'), row('whatsapp'), row('sms'), row('whatsapp')],
    [row('customer_email'), row('owned_social'), row('whatsapp'), row('sms'), row('social_dm', { rail: 'pager' })],
  ];
  for (const [index, invalidRows] of invalidSets.entries()) {
    const outcome = await new PgPortalLiveChannelTruthService(dependencies(invalidRows)).snapshot({
      sessionToken: SESSION,
      requestId: `channel-truth-set-${index}`,
    });
    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.equal(outcome.kind, 'invalid_snapshot');
  }
});

test('live-channel truth rejects cross-workspace and inconsistent snapshot projections', async () => {
  for (const [index, invalidRows] of [
    rows().map((entry, rowIndex) => rowIndex === 0
      ? { ...entry, workspaceId: OTHER_WORKSPACE_ID }
      : entry),
    rows().map((entry, rowIndex) => rowIndex === 0
      ? { ...entry, snapshotAt: '2026-08-29T09:00:01.000Z' }
      : entry),
  ].entries()) {
    const outcome = await new PgPortalLiveChannelTruthService(dependencies(invalidRows)).snapshot({
      sessionToken: SESSION,
      requestId: `channel-truth-scope-${index}`,
    });
    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.equal(outcome.kind, 'invalid_snapshot');
  }
});

test('live-channel truth rejects malformed and secret-shaped database rows', async () => {
  const invalidRows: readonly TruthRow[] = [
    row('customer_email', { providerToken: 'DO-NOT-PROJECT-SECRET' }),
    row('customer_email', { blockerCodes: ['EFFECTS_DISABLED', 'MAILGUN_API_KEY=secret'] }),
    row('customer_email', { latestReceiptEvidenceSha256: 'customer@example.test' }),
    row('customer_email', { latestReceiptAt: '2026-08-29 08:55:00+00' }),
  ];
  for (const [index, invalid] of invalidRows.entries()) {
    const candidate = rows().map((entry) => entry.rail === 'customer_email' ? invalid : entry);
    const outcome = await new PgPortalLiveChannelTruthService(dependencies(candidate)).snapshot({
      sessionToken: SESSION,
      requestId: `channel-truth-secret-${index}`,
    });
    assert.deepEqual(outcome, {
      ok: false,
      kind: 'invalid_snapshot',
      message: 'Live channel evidence did not pass its safe typed boundary.',
    });
    assert.doesNotMatch(JSON.stringify(outcome), /DO-NOT-PROJECT|example\.test|MAILGUN_API_KEY/u);
  }
});

test('live-channel truth enforces bounded monotonic cap and receipt invariants', async () => {
  const invalidOverrides: readonly Record<string, unknown>[] = [
    { dailyUsed: 11 },
    { monthlyUsed: 51 },
    { dailyUsed: 6, monthlyUsed: 5 },
    { dailyLimit: 51, monthlyLimit: 50 },
    { dailyLimit: 1_000_001, monthlyLimit: 1_000_001 },
    { dailyUsed: 10, monthlyUsed: 10 },
    {
      dailyUsed: 10,
      monthlyUsed: 10,
      outboundOrReplyState: 'cap_reached',
      blockerCodes: ['EFFECTS_DISABLED'],
    },
    {
      dailyUsed: 9,
      outboundOrReplyState: 'cap_reached',
      blockerCodes: ['CAP_REACHED'],
    },
    { receiptState: 'none' },
    { receiptState: 'pending', latestReceiptOutcome: 'failed' },
    { receiptState: 'needs_attention', latestReceiptOutcome: 'failed', blockerCodes: [] },
    {
      receiptState: 'outcome_unknown',
      latestReceiptOutcome: 'outcome_unknown',
      blockerCodes: ['RECEIPT_NEEDS_ATTENTION'],
    },
    { latestReceiptAt: '2026-08-29T09:00:01.000Z' },
  ];
  for (const [index, overrides] of invalidOverrides.entries()) {
    const candidate = rows().map((entry) => entry.rail === 'customer_email'
      ? row('customer_email', overrides)
      : entry);
    const outcome = await new PgPortalLiveChannelTruthService(dependencies(candidate)).snapshot({
      sessionToken: SESSION,
      requestId: `channel-truth-cap-${index}`,
    });
    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.equal(outcome.kind, 'invalid_snapshot');
  }
});

test('live-channel truth represents an exhausted positive cap without negative remaining volume', async () => {
  const capped = rows().map((entry) => entry.rail === 'customer_email'
    ? row('customer_email', {
        dailyUsed: 10,
        monthlyUsed: 10,
        outboundOrReplyState: 'cap_reached',
        blockerCodes: ['CAP_REACHED'],
      })
    : entry);
  const outcome = await new PgPortalLiveChannelTruthService(dependencies(capped)).snapshot({
    sessionToken: SESSION,
    requestId: 'channel-truth-cap-reached',
  });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.deepEqual(outcome.snapshot.rails[0]?.caps.daily, {
    used: 10,
    limit: 10,
    remaining: 0,
  });
  assert.equal(outcome.snapshot.rails[0]?.outboundOrReplyState, 'cap_reached');
});

test('live-channel truth requires stable blockers for each blocking operational state', async () => {
  const invalidOverrides: readonly Record<string, unknown>[] = [
    { connectionState: 'not_configured', blockerCodes: ['EFFECTS_DISABLED'] },
    { connectionState: 'not_composed', blockerCodes: ['EFFECTS_DISABLED'] },
    { outboundOrReplyState: 'effects_disabled', blockerCodes: [] },
    { outboundOrReplyState: 'approval_required', blockerCodes: ['EFFECTS_DISABLED'] },
  ];
  for (const [index, overrides] of invalidOverrides.entries()) {
    const candidate = rows().map((entry) => entry.rail === 'customer_email'
      ? row('customer_email', overrides)
      : entry);
    const outcome = await new PgPortalLiveChannelTruthService(dependencies(candidate)).snapshot({
      sessionToken: SESSION,
      requestId: `channel-truth-blocker-state-${index}`,
    });
    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.equal(outcome.kind, 'invalid_snapshot');
  }
});

test('social DM cannot claim a composed live adapter or ready ingress', async () => {
  const fabricated = rows().map((entry) => entry.rail === 'social_dm'
    ? row('social_dm', {
        connectionState: 'ready',
        inboundState: 'ready',
        outboundOrReplyState: 'ready',
        blockerCodes: [],
      })
    : entry);
  const outcome = await new PgPortalLiveChannelTruthService(dependencies(fabricated)).snapshot({
    sessionToken: SESSION,
    requestId: 'channel-truth-social-dm',
  });
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.kind, 'invalid_snapshot');
});

test('live-channel truth maps inactive, permission and unknown failures without exception detail', async () => {
  const cases = [
    {
      error: new InactivePortalSessionError(),
      kind: 'unauthenticated',
      message: 'This portal session is no longer active.',
    },
    {
      error: { code: '42501', detail: 'private-table-name provider secret' },
      kind: 'forbidden',
      message: 'This workspace role cannot read live channel evidence.',
    },
    {
      error: new Error('postgres host and raw provider payload'),
      kind: 'unavailable',
      message: 'Live channel evidence is temporarily unavailable.',
    },
  ] as const;
  for (const [index, selected] of cases.entries()) {
    const outcome = await new PgPortalLiveChannelTruthService(dependencies(rows(), {
      readRunner: {
        async run() {
          throw selected.error;
        },
      },
    })).snapshot({ sessionToken: SESSION, requestId: `channel-truth-error-${index}` });
    assert.deepEqual(outcome, { ok: false, kind: selected.kind, message: selected.message });
    assert.doesNotMatch(JSON.stringify(outcome), /private-table|postgres host|provider payload/u);
  }
});

test('production factory revalidates the session inside one serializable read-only transaction', async () => {
  const statements: Array<{ sql: string; values?: readonly unknown[] }> = [];
  let released = false;
  const transactionClient = {
    async query(sql: string, values?: readonly unknown[]) {
      statements.push({ sql, values });
      if (sql.startsWith('BEGIN ') || sql === 'COMMIT' || sql === 'ROLLBACK'
          || sql.includes("set_config('app.user_id'")) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes('database.lock-portal-session')) {
        return { rows: [{ active: true }], rowCount: 1 };
      }
      if (sql.includes('portal.live-channel-truth.snapshot')) {
        return { rows: rows(), rowCount: 5 };
      }
      throw new Error('unexpected query');
    },
    release(destroy?: boolean) {
      assert.equal(destroy, false);
      released = true;
    },
  };
  const service = createPgPortalLiveChannelTruthService({
    webPool: {
      async query(sql: string, values?: readonly unknown[]) {
        statements.push({ sql, values });
        assert.match(sql, /portal\.crm\.resolve-session/u);
        assert.deepEqual(values, [createHash('sha256').update(SESSION).digest()]);
        return { rows: [{ user_id: USER_ID, selected_workspace_id: WORKSPACE_ID }], rowCount: 1 };
      },
      connect: async () => transactionClient,
    } as never,
  });

  const outcome = await service.snapshot({ sessionToken: SESSION, requestId: 'channel-truth-production' });

  assert.equal(outcome.ok, true);
  assert.equal(released, true);
  assert.match(statements[1]?.sql ?? '', /^BEGIN ISOLATION LEVEL SERIALIZABLE READ ONLY$/u);
  assert.match(statements[2]?.sql ?? '', /app_private\.active_portal_session/u);
  assert.doesNotMatch(statements[2]?.sql ?? '', /lock_active_portal_session/u);
  assert.equal(statements.filter(({ sql }) => sql.includes('portal.live-channel-truth.snapshot')).length, 1);
  assert.equal(statements.at(-1)?.sql, 'COMMIT');
});
