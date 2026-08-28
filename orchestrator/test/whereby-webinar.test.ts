import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import {
  WherebyWebinarBridgeError,
  WherebyWebinarIngestService,
  WherebyWebinarRetryableError,
  WherebyWebhookAuthenticationError,
  WherebyWebhookContractError,
  type WherebyAttendancePair,
  type WherebyParticipantBinding,
  type WherebyWebinarIngestDependencies,
  verifyWherebyWebhook,
} from '../src/whereby-webinar/index.js';

const SECRET = Buffer.from('whereby-test-secret-00000000000000000001', 'utf8');
const NOW_SECONDS = 1_787_923_200;
const CONNECTION_ID = '22222222-2222-4222-8222-222222222222';
const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const ACCOUNT_ID = '33333333-3333-4333-8333-333333333333';

function payload(
  type: 'room.client.joined' | 'room.client.left' | 'room.session.started' | 'room.session.ended',
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const client = type === 'room.client.joined' || type === 'room.client.left';
  return {
    id: type === 'room.client.joined' ? 'evt_join_001' : type === 'room.client.left' ? 'evt_left_001' : `evt_${type}`,
    apiVersion: '1.0',
    createdAt: type === 'room.client.joined'
      ? '2026-08-28T17:00:00.000Z'
      : '2026-08-28T17:45:00.000Z',
    type,
    data: {
      meetingId: 'meeting-001',
      roomName: '/property-predator-live-001',
      roomSessionId: 'session-001',
      subdomain: 'propertypredator',
      ...(client ? {
        displayName: 'Owned Seed Attendee',
        participantId: 'participant-001',
        metadata: 'opaque-campaign-reference',
        externalId: 'attendee-binding-001',
        roleName: 'visitor',
        numClients: type === 'room.client.joined' ? 2 : 1,
        numClientsByRoleName: { host: 1, visitor: type === 'room.client.joined' ? 1 : 0 },
        isDialIn: false,
      } : {}),
      ...overrides,
    },
  };
}

function signed(value: Record<string, unknown>, timestamp = NOW_SECONDS): {
  rawBody: Buffer;
  signatureHeader: string;
} {
  const rawBody = Buffer.from(JSON.stringify(value), 'utf8');
  const digest = createHmac('sha256', SECRET)
    .update(String(timestamp), 'ascii')
    .update('.', 'ascii')
    .update(rawBody)
    .digest('hex');
  return { rawBody, signatureHeader: `t=${timestamp},v1=${digest}` };
}

function verify(value: Record<string, unknown>, timestamp = NOW_SECONDS) {
  return verifyWherebyWebhook({
    ...signed(value, timestamp),
    webhookSecret: SECRET,
    expectedSubdomain: 'propertypredator',
    nowSeconds: NOW_SECONDS,
  });
}

test('verifies exact Whereby bytes and parses the documented join contract', () => {
  const event = verify(payload('room.client.joined'));
  assert.equal(event.type, 'room.client.joined');
  assert.equal(event.data.externalId, 'attendee-binding-001');
  assert.equal(event.data.roleName, 'visitor');
  assert.match(event.rawBodySha256, /^[a-f0-9]{64}$/u);
  assert.ok(Object.isFrozen(event));
  assert.ok(Object.isFrozen(event.data));
});

test('snapshots caller-owned raw bytes before authenticating and parsing', () => {
  const valid = signed(payload('room.client.joined'));
  let reads = 0;
  const event = verifyWherebyWebhook({
    get rawBody() {
      reads += 1;
      return reads === 1 ? valid.rawBody : Buffer.from('{}', 'utf8');
    },
    signatureHeader: valid.signatureHeader,
    webhookSecret: SECRET,
    expectedSubdomain: 'propertypredator',
    nowSeconds: NOW_SECONDS,
  });
  assert.equal(reads, 1);
  assert.equal(event.id, 'evt_join_001');
});

test('rejects tampering, stale timestamps, cross-subdomain events and ambiguous headers', () => {
  const valid = signed(payload('room.client.joined'));
  assert.throws(() => verifyWherebyWebhook({
    ...valid,
    rawBody: Buffer.concat([valid.rawBody, Buffer.from(' ')]),
    webhookSecret: SECRET,
    expectedSubdomain: 'propertypredator',
    nowSeconds: NOW_SECONDS,
  }), WherebyWebhookAuthenticationError);
  assert.throws(() => verify(payload('room.client.joined'), NOW_SECONDS - 301), WherebyWebhookAuthenticationError);
  assert.throws(() => verifyWherebyWebhook({
    ...valid,
    signatureHeader: `${valid.signatureHeader},v1=${'0'.repeat(64)}`,
    webhookSecret: SECRET,
    expectedSubdomain: 'propertypredator',
    nowSeconds: NOW_SECONDS,
  }), WherebyWebhookAuthenticationError);
  const wrongSubdomain = signed(payload('room.client.joined', { subdomain: 'attacker' }));
  assert.throws(() => verifyWherebyWebhook({
    ...wrongSubdomain,
    webhookSecret: SECRET,
    expectedSubdomain: 'propertypredator',
    nowSeconds: NOW_SECONDS,
  }), WherebyWebhookAuthenticationError);
});

test('rejects unsupported events, fields and malformed participant counts', () => {
  assert.throws(() => verify({ ...payload('room.client.joined'), type: 'recording.finished' }), WherebyWebhookContractError);
  assert.throws(() => verify({ ...payload('room.client.joined'), surprise: true }), WherebyWebhookContractError);
  assert.throws(() => verify(payload('room.client.joined', { numClients: -1 })), WherebyWebhookContractError);
});

function dependencies(pair: WherebyAttendancePair | null): {
  deps: WherebyWebinarIngestDependencies;
  projected: Array<Parameters<WherebyWebinarIngestDependencies['journeyEvents']['record']>[0]>;
  joins: unknown[];
  leaves: unknown[];
  receiptClaims: unknown[];
  bindingResolutions: unknown[];
  receiptReleases: number;
} {
  const claimed = new Map<string, Readonly<{
    payloadSha256: string;
    leaseToken: string;
    completed: boolean;
  }>>();
  const projected: Array<Parameters<WherebyWebinarIngestDependencies['journeyEvents']['record']>[0]> = [];
  const joins: unknown[] = [];
  const leaves: unknown[] = [];
  const receiptClaims: unknown[] = [];
  const bindingResolutions: unknown[] = [];
  let receiptReleases = 0;
  let leaseSequence = 0;
  const binding: WherebyParticipantBinding = {
    workspaceId: WORKSPACE_ID,
    accountId: ACCOUNT_ID,
    connectionId: CONNECTION_ID,
    contentKey: 'webinar.property-predator-live',
    contentVersion: '2026-08-28',
    title: 'Property Predator Live',
    scheduledDurationSeconds: 3_600,
    completionThresholdBasisPoints: 7_500,
  };
  return {
    projected,
    joins,
    leaves,
    receiptClaims,
    bindingResolutions,
    get receiptReleases() { return receiptReleases; },
    deps: {
      workspaceId: WORKSPACE_ID,
      connectionId: CONNECTION_ID,
      providerEffectsEnabled: false,
      emergencyPaused: true,
      receipts: {
        async claim(input) {
          receiptClaims.push(input);
          const key = `${input.workspaceId}:${input.connectionId}:${input.eventId}`;
          const existing = claimed.get(key);
          if (existing?.payloadSha256 !== undefined
              && existing.payloadSha256 !== input.payloadSha256) {
            return { disposition: 'conflict' };
          }
          if (existing?.completed) return { disposition: 'replayed' };
          if (existing) return { disposition: 'in_progress' };
          leaseSequence += 1;
          const leaseToken = `lease_${String(leaseSequence).padStart(16, '0')}`;
          claimed.set(key, { payloadSha256: input.payloadSha256, leaseToken, completed: false });
          return { disposition: 'claimed', leaseToken };
        },
        async complete(input) {
          assert.match(input.outcomeSha256, /^[a-f0-9]{64}$/u);
          const key = `${input.workspaceId}:${input.connectionId}:${input.eventId}`;
          const existing = claimed.get(key);
          if (!existing || existing.leaseToken !== input.leaseToken
              || existing.payloadSha256 !== input.payloadSha256) return 'lost';
          claimed.set(key, { ...existing, completed: true });
          return 'completed';
        },
        async release(input) {
          const key = `${input.workspaceId}:${input.connectionId}:${input.eventId}`;
          const existing = claimed.get(key);
          if (!existing || existing.completed || existing.leaseToken !== input.leaseToken) {
            return 'lost';
          }
          claimed.delete(key);
          receiptReleases += 1;
          return 'released';
        },
      },
      bindings: {
        async resolve(input) {
          bindingResolutions.push(input);
          return binding;
        },
      },
      attendance: {
        async recordJoin(input) {
          joins.push(input);
          return { disposition: 'opened' };
        },
        async recordLeave(input) {
          leaves.push(input);
          return pair === null
            ? { disposition: 'pending' }
            : { disposition: 'paired', pair };
        },
      },
      journeyEvents: {
        async record(input) { projected.push(input); return 'recorded'; },
      },
    },
  };
}

test('opens attendance on join and projects a verified completion into Lead 360 event vocabulary', async () => {
  const fixture = dependencies({
    workspaceId: WORKSPACE_ID,
    connectionId: CONNECTION_ID,
    meetingId: 'meeting-001',
    roomSessionId: 'session-001',
    participantId: 'participant-001',
    externalId: 'attendee-binding-001',
    joinedEventId: 'evt_join_001',
    leftEventId: 'evt_left_001',
    joinedAt: '2026-08-28T17:00:00.000Z',
    leftAt: '2026-08-28T17:45:00.000Z',
  });
  const service = new WherebyWebinarIngestService(fixture.deps);
  const joined = await service.ingest(verify(payload('room.client.joined')));
  assert.equal(joined.disposition, 'attendance_opened');
  assert.equal(fixture.joins.length, 1);
  const left = await service.ingest(verify(payload('room.client.left')));
  assert.equal(left.disposition, 'projected');
  assert.equal(left.projectedEvent?.type, 'content.consumption.completed');
  assert.equal(left.projectedEvent?.subject.id, ACCOUNT_ID);
  assert.deepEqual(left.projectedEvent?.data, {
    contentKey: 'webinar.property-predator-live',
    contentVersion: '2026-08-28',
    title: 'Property Predator Live',
    medium: 'video',
    progressBasisPoints: 10_000,
    consumedSeconds: 2_700,
  });
  assert.equal(fixture.projected.length, 1);
  assert.equal(fixture.projected[0]?.workspaceId, WORKSPACE_ID);
  assert.equal(fixture.projected[0]?.connectionId, CONNECTION_ID);
  assert.deepEqual(fixture.bindingResolutions[0], {
    workspaceId: WORKSPACE_ID,
    connectionId: CONNECTION_ID,
    meetingId: 'meeting-001',
    externalId: 'attendee-binding-001',
  });
  assert.equal((fixture.receiptClaims[0] as { connectionId: string }).connectionId, CONNECTION_ID);
  assert.equal((fixture.receiptClaims[0] as { workspaceId: string }).workspaceId, WORKSPACE_ID);
  assert.match(left.projectedEvent?.id ?? '', /^[0-9a-f-]{36}$/u);
});

test('projects partial attendance without inventing completion and replays once', async () => {
  const fixture = dependencies({
    workspaceId: WORKSPACE_ID,
    connectionId: CONNECTION_ID,
    meetingId: 'meeting-001',
    roomSessionId: 'session-001',
    participantId: 'participant-001',
    externalId: 'attendee-binding-001',
    joinedEventId: 'evt_join_001',
    leftEventId: 'evt_left_001',
    joinedAt: '2026-08-28T17:00:00.000Z',
    leftAt: '2026-08-28T17:10:00.000Z',
  });
  const service = new WherebyWebinarIngestService(fixture.deps);
  const event = verify(payload('room.client.left'));
  const first = await service.ingest(event);
  assert.equal(first.projectedEvent?.type, 'content.consumption.progressed');
  assert.equal(first.projectedEvent?.data.progressBasisPoints, 1_666);
  const replay = await service.ingest(event);
  assert.equal(replay.disposition, 'replayed');
  assert.equal(fixture.projected.length, 1);
});

test('unbound attendees do not reach Lead 360 and provider effects cannot be enabled', async () => {
  const fixture = dependencies(null);
  fixture.deps.bindings.resolve = async () => null;
  const service = new WherebyWebinarIngestService(fixture.deps);
  const result = await service.ingest(verify(payload('room.client.joined')));
  assert.equal(result.disposition, 'ignored_unbound');
  assert.equal(fixture.projected.length, 0);
  assert.throws(() => new WherebyWebinarIngestService({
    ...fixture.deps,
    providerEffectsEnabled: true,
  } as unknown as WherebyWebinarIngestDependencies), WherebyWebinarBridgeError);
});

test('rejects structurally forged verified events before receipt acquisition', async () => {
  const fixture = dependencies(null);
  const service = new WherebyWebinarIngestService(fixture.deps);
  const authenticated = verify(payload('room.client.joined'));
  await assert.rejects(
    service.ingest({ ...authenticated }),
    WherebyWebinarBridgeError,
  );
  assert.equal(fixture.receiptClaims.length, 0);
});

test('retains an out-of-order leave and projects once the matching join arrives', async () => {
  const fixture = dependencies(null);
  let pendingLeave: {
    eventId: string;
    leftAt: string;
  } | null = null;
  fixture.deps.attendance.recordLeave = async (input) => {
    pendingLeave = { eventId: input.eventId, leftAt: input.leftAt };
    return { disposition: 'pending' };
  };
  fixture.deps.attendance.recordJoin = async (input) => {
    assert.ok(pendingLeave);
    return {
      disposition: 'paired',
      pair: {
        workspaceId: WORKSPACE_ID,
        connectionId: CONNECTION_ID,
        meetingId: 'meeting-001',
        roomSessionId: 'session-001',
        participantId: 'participant-001',
        externalId: 'attendee-binding-001',
        joinedEventId: input.eventId,
        leftEventId: pendingLeave.eventId,
        joinedAt: input.joinedAt,
        leftAt: pendingLeave.leftAt,
      },
    };
  };
  const service = new WherebyWebinarIngestService(fixture.deps);
  const left = await service.ingest(verify(payload('room.client.left')));
  assert.equal(left.disposition, 'attendance_pending');
  assert.equal(fixture.projected.length, 0);
  const joined = await service.ingest(verify(payload('room.client.joined')));
  assert.equal(joined.disposition, 'projected');
  assert.equal(joined.projectedEvent?.occurredAt, '2026-08-28T17:45:00.000Z');
  assert.equal(joined.projectedEvent?.type, 'content.consumption.completed');
  if (joined.projectedEvent?.type !== 'content.consumption.completed') {
    assert.fail('expected completed content-consumption event');
  }
  assert.equal(joined.projectedEvent.data.consumedSeconds, 2_700);
  assert.equal(fixture.projected.length, 1);

  const orderedFixture = dependencies({
    workspaceId: WORKSPACE_ID,
    connectionId: CONNECTION_ID,
    meetingId: 'meeting-001',
    roomSessionId: 'session-001',
    participantId: 'participant-001',
    externalId: 'attendee-binding-001',
    joinedEventId: 'evt_join_001',
    leftEventId: 'evt_left_001',
    joinedAt: '2026-08-28T17:00:00.000Z',
    leftAt: '2026-08-28T17:45:00.000Z',
  });
  const ordered = await new WherebyWebinarIngestService(orderedFixture.deps)
    .ingest(verify(payload('room.client.left')));
  assert.equal(joined.projectedEvent.id, ordered.projectedEvent?.id);
});

test('releases a receipt lease after downstream failure so the provider retry can succeed', async () => {
  const fixture = dependencies({
    workspaceId: WORKSPACE_ID,
    connectionId: CONNECTION_ID,
    meetingId: 'meeting-001',
    roomSessionId: 'session-001',
    participantId: 'participant-001',
    externalId: 'attendee-binding-001',
    joinedEventId: 'evt_join_001',
    leftEventId: 'evt_left_001',
    joinedAt: '2026-08-28T17:00:00.000Z',
    leftAt: '2026-08-28T17:45:00.000Z',
  });
  const originalRecord = fixture.deps.journeyEvents.record.bind(fixture.deps.journeyEvents);
  let attempts = 0;
  fixture.deps.journeyEvents.record = async (input) => {
    attempts += 1;
    if (attempts === 1) throw new Error('simulated sink outage');
    return originalRecord(input);
  };
  const service = new WherebyWebinarIngestService(fixture.deps);
  const event = verify(payload('room.client.left'));
  await assert.rejects(service.ingest(event), /simulated sink outage/u);
  assert.equal(fixture.receiptReleases, 1);
  const retry = await service.ingest(event);
  assert.equal(retry.disposition, 'projected');
  assert.equal(attempts, 2);
  assert.equal(fixture.projected.length, 1);
});

test('surfaces an in-progress duplicate as retryable instead of acknowledging and losing it', async () => {
  const fixture = dependencies(null);
  fixture.deps.receipts.claim = async () => ({ disposition: 'in_progress' });
  const service = new WherebyWebinarIngestService(fixture.deps);
  await assert.rejects(
    service.ingest(verify(payload('room.session.started'))),
    WherebyWebinarRetryableError,
  );
});

test('rejects a reused provider event ID whose exact signed payload bytes changed', async () => {
  const fixture = dependencies({
    workspaceId: WORKSPACE_ID,
    connectionId: CONNECTION_ID,
    meetingId: 'meeting-001',
    roomSessionId: 'session-001',
    participantId: 'participant-001',
    externalId: 'attendee-binding-001',
    joinedEventId: 'evt_join_001',
    leftEventId: 'evt_left_001',
    joinedAt: '2026-08-28T17:00:00.000Z',
    leftAt: '2026-08-28T17:45:00.000Z',
  });
  const service = new WherebyWebinarIngestService(fixture.deps);
  await service.ingest(verify(payload('room.client.left')));
  await assert.rejects(
    service.ingest(verify(payload('room.client.left', { displayName: 'Changed Signed Payload' }))),
    /reused with different payload bytes/u,
  );
  assert.equal(fixture.projected.length, 1);
});

test('fails closed and releases the lease for a cross-connection binding', async () => {
  const fixture = dependencies(null);
  fixture.deps.bindings.resolve = async () => ({
    workspaceId: WORKSPACE_ID,
    accountId: ACCOUNT_ID,
    connectionId: '44444444-4444-4444-8444-444444444444',
    contentKey: 'webinar.property-predator-live',
    contentVersion: '2026-08-28',
    title: 'Property Predator Live',
    scheduledDurationSeconds: 3_600,
    completionThresholdBasisPoints: 7_500,
  });
  const service = new WherebyWebinarIngestService(fixture.deps);
  await assert.rejects(
    service.ingest(verify(payload('room.client.joined'))),
    /crossed the configured tenant boundary/u,
  );
  assert.equal(fixture.receiptReleases, 1);
  assert.equal(fixture.projected.length, 0);
});

test('rejects forged duration accounting instead of trusting store-supplied seconds', async () => {
  const fixture = dependencies({
    workspaceId: WORKSPACE_ID,
    connectionId: CONNECTION_ID,
    meetingId: 'meeting-001',
    roomSessionId: 'session-001',
    participantId: 'participant-001',
    externalId: 'attendee-binding-001',
    joinedEventId: 'evt_join_001',
    leftEventId: 'evt_left_001',
    joinedAt: 'not-a-timestamp',
    leftAt: '2026-08-28T17:45:00.000Z',
  });
  const service = new WherebyWebinarIngestService(fixture.deps);
  await assert.rejects(
    service.ingest(verify(payload('room.client.left'))),
    /attendance pair is invalid/u,
  );
  assert.equal(fixture.receiptReleases, 1);
  assert.equal(fixture.projected.length, 0);
});
