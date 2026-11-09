import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool, PoolClient } from 'pg';
import {
  PROPERTY_PREDATOR_OWNED_SEED_EMAIL,
  PropertyPredatorOwnedSeedCampaignService,
  PropertyPredatorOwnedSeedCampaignValidationError,
} from '../src/property-predator-owned-seed-campaign-pg/index.js';

const IDS = Object.freeze({
  workspace: '11111111-1111-4111-8111-111111111111',
  user: '22222222-2222-4222-8222-222222222222',
  version: '33333333-3333-4333-8333-333333333333',
  run: '44444444-4444-4444-8444-444444444444',
  job: '55555555-5555-4555-8555-555555555555',
  connection: '66666666-6666-4666-8666-666666666666',
});

type Call = Readonly<{ sql: string; values: readonly unknown[] }>;

function database(respond: (sql: string) => unknown[]): Readonly<{
  pool: Pick<Pool, 'connect'>;
  calls: Call[];
}> {
  const calls: Call[] = [];
  const query = async (sql: string, values: readonly unknown[] = []) => {
    calls.push({ sql, values });
    if (sql.startsWith('BEGIN') || sql === 'COMMIT' || sql === 'ROLLBACK') {
      return { rows: [] };
    }
    if (sql.includes("set_config('app.user_id'")) return { rows: [{}] };
    return { rows: respond(sql) };
  };
  const client = { query, release: () => undefined } as unknown as PoolClient;
  return Object.freeze({
    pool: { connect: async () => client } as Pick<Pool, 'connect'>,
    calls,
  });
}

function context() {
  return {
    actorKind: 'user' as const,
    workspaceId: IDS.workspace,
    userId: IDS.user,
    requestId: 'owned-seed-unit-test',
  };
}

function command() {
  return {
    commandKey: 'campaign-wizard:approved:001',
    messageVersionId: IDS.version,
    runId: IDS.run,
  };
}

test('service stages one server-resolved owned seed without accepting delivery evidence', async () => {
  const requestSha = 'a'.repeat(64);
  const db = database((sql) => sql.includes('stage_property_predator_owned_seed_campaign')
    ? [{
      disposition: 'staged', reason: null, jobId: IDS.job,
      providerConnectionId: IDS.connection, messageVersionId: IDS.version,
      requestSha256: Buffer.from(requestSha, 'hex'),
      estimatedSpendUsdMicros: '1500',
      deliveryState: 'queued',
    }] : []);
  const service = new PropertyPredatorOwnedSeedCampaignService({
    commandPool: db.pool,
    workspaceId: IDS.workspace,
  });

  const staged = await service.stage(context(), command());
  assert.deepEqual(staged, {
    disposition: 'staged', reason: null, jobId: IDS.job,
    providerConnectionId: IDS.connection, messageVersionId: IDS.version,
    requestSha256: requestSha, estimatedSpendUsdMicros: 1500,
    recipient: PROPERTY_PREDATOR_OWNED_SEED_EMAIL,
    providerCallMadeByThisCommand: false,
    deliveryIntentCreated: true,
    deliveryState: 'queued',
  });
  const call = db.calls.find((candidate) => (
    candidate.sql.includes('stage_property_predator_owned_seed_campaign')
  ));
  assert.ok(call);
  assert.deepEqual(call.values, [
    IDS.workspace, IDS.version, IDS.run, command().commandKey,
  ]);
  assert.doesNotMatch(JSON.stringify(call.values), /@|recipient|consent|approval|provider/i);
});

test('service returns fail-closed block evidence without inventing identifiers', async () => {
  const db = database((sql) => sql.includes('stage_property_predator_owned_seed_campaign')
    ? [{
      disposition: 'blocked', reason: 'recipient_evidence_not_current',
      jobId: null, providerConnectionId: IDS.connection,
      messageVersionId: IDS.version, requestSha256: null,
      estimatedSpendUsdMicros: '1500',
      deliveryState: 'blocked',
    }] : []);
  const service = new PropertyPredatorOwnedSeedCampaignService({
    commandPool: db.pool, workspaceId: IDS.workspace,
  });
  assert.deepEqual(await service.stage(context(), command()), {
    disposition: 'blocked', reason: 'recipient_evidence_not_current',
    jobId: null, providerConnectionId: IDS.connection,
    messageVersionId: IDS.version, requestSha256: null,
    estimatedSpendUsdMicros: 1500,
    recipient: PROPERTY_PREDATOR_OWNED_SEED_EMAIL,
    providerCallMadeByThisCommand: false,
    deliveryIntentCreated: false,
    deliveryState: 'blocked',
  });
});

test('service replay returns current stored worker state without inventing a queued job', async () => {
  const requestSha = 'd'.repeat(64);
  const db = database((sql) => sql.includes('stage_property_predator_owned_seed_campaign')
    ? [{
      disposition: 'replayed', reason: null, jobId: IDS.job,
      providerConnectionId: IDS.connection, messageVersionId: IDS.version,
      requestSha256: Buffer.from(requestSha, 'hex'),
      estimatedSpendUsdMicros: '1500', deliveryState: 'settled',
    }] : []);
  const service = new PropertyPredatorOwnedSeedCampaignService({
    commandPool: db.pool, workspaceId: IDS.workspace,
  });
  const replay = await service.stage(context(), command());
  assert.equal(replay.disposition, 'replayed');
  assert.equal(replay.deliveryIntentCreated, true);
  assert.equal(replay.deliveryState, 'settled');
  assert.equal(replay.providerCallMadeByThisCommand, false);
  assert.equal('providerCallMade' in replay, false);
});

test('service rejects non-user contexts and malformed command identity before SQL', async () => {
  const db = database(() => []);
  const service = new PropertyPredatorOwnedSeedCampaignService({
    commandPool: db.pool, workspaceId: IDS.workspace,
  });
  await assert.rejects(
    service.stage({
      actorKind: 'system', workspaceId: IDS.workspace,
      requestId: 'owned-seed-system',
    }, command()),
    PropertyPredatorOwnedSeedCampaignValidationError,
  );
  await assert.rejects(
    service.stage(context(), { ...command(), commandKey: 'contains spaces' }),
    /commandKey is invalid/,
  );
  assert.equal(db.calls.length, 0);
});

test('service proves the dedicated table-blind command boundary is ready', async () => {
  const db = database((sql) => (
    sql.includes('property_predator_owned_seed_campaign_boundary_ready')
      ? [{ ready: true }] : []
  ));
  const service = new PropertyPredatorOwnedSeedCampaignService({
    commandPool: db.pool, workspaceId: IDS.workspace,
  });
  await service.assertReady();
  assert.ok(db.calls.some((call) => (
    call.sql.includes('property_predator_owned_seed_campaign_boundary_ready')
  )));
});
