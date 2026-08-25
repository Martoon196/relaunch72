import assert from 'node:assert/strict';
import test from 'node:test';
import type { DatabaseRequestContext } from '../src/db/rls.js';
import {
  CommunicationEligibilityService,
  evaluateEndpointInTransaction,
  type CommunicationEligibilitySqlExecutor,
  type CommunicationEligibilityTransactionRunner,
} from '../src/consent-pg/index.js';

const CONTEXT: DatabaseRequestContext = {
  actorKind: 'user',
  workspaceId: '11111111-1111-4111-8111-111111111111',
  userId: '22222222-2222-4222-8222-222222222222',
  requestId: 'consent-test',
};

const QUERY = {
  contactPointId: '33333333-3333-4333-8333-333333333333',
  channel: 'email' as const,
  purpose: 'property_predator_marketing',
};
const ENDPOINT_IDENTITY_HASH = Buffer.alloc(32, 7);

function service(input: {
  endpointAvailable?: boolean;
  endpointIdentityHash?: Uint8Array;
  consentIdentityHash?: Uint8Array;
  suppressionIdentityHash?: Uint8Array;
  suppressionId?: string;
  consentId?: string;
  consentState?: 'granted' | 'denied' | 'withdrawn';
  statements?: string[];
}): CommunicationEligibilityService {
  const executor: CommunicationEligibilitySqlExecutor = {
    async query<TRow extends Record<string, unknown>>(sql: string, values?: readonly unknown[]) {
      input.statements?.push(sql);
      if (sql.includes('current-endpoint')) {
        assert.deepEqual(values, [QUERY.contactPointId, QUERY.channel]);
        return {
          rows: (input.endpointAvailable === false
            ? []
            : [{ identityHash: input.endpointIdentityHash ?? ENDPOINT_IDENTITY_HASH }]) as unknown as TRow[],
        };
      }
      assert.deepEqual(values, [
        QUERY.contactPointId, QUERY.channel, QUERY.purpose,
        input.endpointIdentityHash ?? ENDPOINT_IDENTITY_HASH,
      ]);
      if (sql.includes('active-suppression')) {
        const identityMatches = !input.suppressionIdentityHash
          || Buffer.from(input.suppressionIdentityHash).equals(Buffer.from(values![3] as Uint8Array));
        return {
          rows: (input.suppressionId && identityMatches ? [{ id: input.suppressionId }] : []) as unknown as TRow[],
        };
      }
      if (sql.includes('latest-consent')) {
        const identityMatches = !input.consentIdentityHash
          || Buffer.from(input.consentIdentityHash).equals(Buffer.from(values![3] as Uint8Array));
        return {
          rows: (input.consentId && identityMatches
            ? [{ id: input.consentId, state: input.consentState ?? 'granted' }]
            : []) as unknown as TRow[],
        };
      }
      throw new Error('unexpected query');
    },
  };
  const runner: CommunicationEligibilityTransactionRunner = {
    async run(_context, operation) { return operation(executor); },
  };
  return new CommunicationEligibilityService(runner);
}

test('a live suppression blocks even when the latest consent is granted', async () => {
  const result = await service({ suppressionId: 's1', consentId: 'c1' })
    .evaluateEndpoint(CONTEXT, QUERY);
  assert.deepEqual(result, {
    status: 'blocked', reason: 'suppressed', consentEventId: 'c1', suppressionEventId: 's1',
  });
  assert.ok(Object.isFrozen(result));
});

test('latest consent evidence returns allowed, denied, withdrawn or unknown truthfully', async () => {
  assert.deepEqual(await service({ consentId: 'c1', consentState: 'granted' }).evaluateEndpoint(CONTEXT, QUERY), {
    status: 'allowed', reason: 'granted', consentEventId: 'c1', suppressionEventId: null,
  });
  assert.deepEqual(await service({ consentId: 'c2', consentState: 'denied' }).evaluateEndpoint(CONTEXT, QUERY), {
    status: 'blocked', reason: 'denied', consentEventId: 'c2', suppressionEventId: null,
  });
  assert.deepEqual(await service({ consentId: 'c3', consentState: 'withdrawn' }).evaluateEndpoint(CONTEXT, QUERY), {
    status: 'blocked', reason: 'withdrawn', consentEventId: 'c3', suppressionEventId: null,
  });
  assert.deepEqual(await service({}).evaluateEndpoint(CONTEXT, QUERY), {
    status: 'unknown', reason: 'no_evidence', consentEventId: null, suppressionEventId: null,
  });
});

test('inactive, unverified, quarantined, shared or channel-incompatible endpoints fail closed before evidence reads', async () => {
  const statements: string[] = [];
  const result = await service({ endpointAvailable: false, consentId: 'old-consent', statements })
    .evaluateEndpoint(CONTEXT, QUERY);
  assert.deepEqual(result, {
    status: 'blocked', reason: 'endpoint_unavailable', consentEventId: null, suppressionEventId: null,
  });
  assert.equal(statements.length, 1);
  assert.match(statements[0]!, /deleted_at IS NULL/);
  assert.match(statements[0]!, /is_verified/);
  assert.match(statements[0]!, /dedupe_state = 'normal'/);
  for (const mapping of [
    "WHEN 'email' THEN 'email'",
    "WHEN 'sms' THEN 'phone'",
    "WHEN 'whatsapp' THEN 'whatsapp'",
    "WHEN 'phone' THEN 'phone'",
    "WHEN 'social' THEN 'social'",
    "WHEN 'webinar' THEN 'email'",
    "WHEN 'web' THEN 'other'",
  ]) assert.match(statements[0]!, new RegExp(mapping));
});

test('evidence for an old endpoint identity cannot authorise an edited endpoint reusing the same UUID', async () => {
  const editedIdentity = Buffer.alloc(32, 8);
  const result = await service({
    endpointIdentityHash: editedIdentity,
    consentIdentityHash: ENDPOINT_IDENTITY_HASH,
    consentId: 'consent-for-old-address',
  }).evaluateEndpoint(CONTEXT, QUERY);
  assert.deepEqual(result, {
    status: 'unknown', reason: 'no_evidence', consentEventId: null, suppressionEventId: null,
  });
});

test('eligibility reads only immutable evidence and never the legacy consent hint', async () => {
  const statements: string[] = [];
  await service({ statements }).evaluateEndpoint(CONTEXT, QUERY);
  assert.equal(statements.length, 3);
  assert.ok(statements.every((sql) => !sql.includes('contact_points.consent_status')));
  assert.ok(statements.some((sql) => sql.includes('app.contact_points')));
  assert.ok(statements.some((sql) => sql.includes('communication_suppression_events')));
  assert.ok(statements.some((sql) => sql.includes('communication_consent_events')));
  for (const evidenceSql of statements.filter((sql) => /communication_(?:consent|suppression)_events/.test(sql))) {
    assert.match(evidenceSql, /endpoint_identity_sha256 = \$4/);
    assert.match(evidenceSql, /occurred_at <= statement_timestamp\(\) \+ interval '5 minutes'/);
  }
});

test('queue commands can evaluate permission inside their existing transaction', async () => {
  const statements: string[] = [];
  const executor: CommunicationEligibilitySqlExecutor = {
    async query<TRow extends Record<string, unknown>>(sql: string, values?: readonly unknown[]) {
      statements.push(sql);
      if (sql.includes('current-endpoint')) {
        assert.deepEqual(values, [QUERY.contactPointId, QUERY.channel]);
        return { rows: [{ identityHash: ENDPOINT_IDENTITY_HASH }] as unknown as TRow[] };
      }
      assert.deepEqual(values, [
        QUERY.contactPointId, QUERY.channel, QUERY.purpose, ENDPOINT_IDENTITY_HASH,
      ]);
      if (sql.includes('active-suppression')) return { rows: [] };
      if (sql.includes('latest-consent')) {
        return { rows: [{ id: 'consent-in-command', state: 'granted' }] as unknown as TRow[] };
      }
      throw new Error('unexpected query');
    },
  };

  assert.deepEqual(await evaluateEndpointInTransaction(executor, QUERY), {
    status: 'allowed',
    reason: 'granted',
    consentEventId: 'consent-in-command',
    suppressionEventId: null,
  });
  assert.equal(statements.length, 3);
});

test('eligibility rejects a malformed endpoint identity digest before evidence can authorize', async () => {
  await assert.rejects(
    service({ endpointIdentityHash: Buffer.alloc(31) }).evaluateEndpoint(CONTEXT, QUERY),
    /invalid identity digest/,
  );
});

test('eligibility rejects unscoped or unsafe endpoint queries before SQL', async () => {
  const eligibility = service({});
  await assert.rejects(
    eligibility.evaluateEndpoint({ ...CONTEXT, workspaceId: 'not-a-workspace' }, QUERY),
    /workspaceId must be a UUID/,
  );
  await assert.rejects(
    eligibility.evaluateEndpoint(CONTEXT, { ...QUERY, contactPointId: 'point-1' }),
    /contactPointId must be a UUID/,
  );
  await assert.rejects(
    eligibility.evaluateEndpoint(CONTEXT, { ...QUERY, purpose: 'bad purpose' }),
    /purpose must be a safe lowercase key/,
  );
  await assert.rejects(
    eligibility.evaluateEndpoint(CONTEXT, { ...QUERY, channel: 'carrier_pigeon' as never }),
    /channel is not supported/,
  );
});
