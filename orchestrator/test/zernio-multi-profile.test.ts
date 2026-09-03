import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import type { PoolClient, QueryResult, QueryResultRow } from 'pg';
import {
  composePropertyPredatorZernioAccountWebhook,
} from '../src/integrations/zernio-account-webhook/router.js';
import { propertyPredatorZernioProviderProfileIds } from '../src/portal/postgres-platform.js';
import { PgPortalZernioSocialConnectionService } from '../src/portal/zernio-social-connection-pg-service.js';
import type { PortalZernioSocialConnectionService } from '../src/portal/zernio-social-connection-service.js';

const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const CONNECTION = '33333333-3333-4333-8333-333333333333';
const EVENT = '44444444-4444-4444-8444-444444444444';
const PRIMARY = '6a95a6ae41c1829b085cbe28';
const COMPANY = '6a98ac5a647e96173efa7ed8';
const SECRET = `whsec_${'m'.repeat(64)}`;

function queryResult<Row extends QueryResultRow>(rows: Row[]): QueryResult<Row> {
  return { rows, rowCount: rows.length, command: '', oid: 0, fields: [] };
}

class FakeClient {
  readonly calls: Array<{ sql: string; values?: unknown[] }> = [];
  async query<Row extends QueryResultRow>(sql: string, values?: unknown[]): Promise<QueryResult<Row>> {
    this.calls.push({ sql, values });
    if (sql.includes('portal_session')) {
      return queryResult([{ active: true }] as unknown as Row[]);
    }
    if (sql.includes('read_zernio_social_accounts')) {
      const profileHash = (values?.[2] as Buffer).toString('hex');
      const company = profileHash === createHash('sha256').update(COMPANY).digest('hex');
      return queryResult([{
        account_id: company
          ? '66666666-6666-4666-8666-666666666666'
          : '55555555-5555-4555-8555-555555555555',
        network: 'linkedin', username: company ? 'Property Predator' : 'Martin Howard',
        display_name: company ? 'Property Predator' : 'Martin Howard', status: 'active',
        linked_at: '2026-09-03T10:00:00.000Z', last_event_at: '2026-09-03T10:01:00.000Z',
        webhook_receipt_count: 1,
      }] as unknown as Row[]);
    }
    if (sql.includes('record_zernio_account_webhook')) {
      return queryResult([{ disposition: 'recorded' }] as unknown as Row[]);
    }
    return queryResult([] as Row[]);
  }
  release(): void {}
}

function pgService(client = new FakeClient()) {
  return {
    client,
    service: new PgPortalZernioSocialConnectionService({
      principalResolver: { async resolve() { return { userId: USER, workspaceId: WORKSPACE }; } },
      commandPool: { async connect() { return client as unknown as PoolClient; } },
      liveClient: { contract: 'r72-zernio-live-connect-v1', async prepare() {
        throw new Error('not used');
      } },
      workspaceId: WORKSPACE, providerConnectionId: CONNECTION,
      providerProfileId: PRIMARY, providerProfileIds: [PRIMARY, COMPANY],
    }),
  };
}

test('profile parsing keeps the existing profile primary and adds one bounded company profile', () => {
  assert.deepEqual(propertyPredatorZernioProviderProfileIds({
    PROPERTY_PREDATOR_ZERNIO_PROVIDER_PROFILE_ID: PRIMARY,
    PROPERTY_PREDATOR_ZERNIO_PROVIDER_PROFILE_IDS: `${PRIMARY}, ${COMPANY}`,
  }), [PRIMARY, COMPANY]);
  assert.throws(() => propertyPredatorZernioProviderProfileIds({
    PROPERTY_PREDATOR_ZERNIO_PROVIDER_PROFILE_ID: PRIMARY,
    PROPERTY_PREDATOR_ZERNIO_PROVIDER_PROFILE_IDS: 'not valid',
  }), /allowlist is invalid/u);
});

test('one repeatable-read snapshot returns personal and company accounts without changing the primary', async () => {
  const { client, service } = pgService();
  const result = await service.snapshot({ sessionToken: 'founder-session', requestId: 'multi-profile-read' });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(service.providerProfileId, PRIMARY);
  assert.deepEqual(service.providerProfileIds, [PRIMARY, COMPANY]);
  assert.deepEqual(result.accounts.map((account) => account.displayName), ['Martin Howard', 'Property Predator']);
  const reads = client.calls.filter((call) => call.sql.includes('read_zernio_social_accounts'));
  assert.equal(reads.length, 2);
  assert.deepEqual(reads.map((call) => (call.values?.[2] as Buffer).toString('hex')), [
    createHash('sha256').update(PRIMARY).digest('hex'),
    createHash('sha256').update(COMPANY).digest('hex'),
  ]);
  assert.equal(client.calls[0]?.sql, 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  assert.equal(client.calls.at(-1)?.sql, 'COMMIT');
});

test('the database receipt boundary admits only an allowlisted profile digest', async () => {
  const { client, service } = pgService();
  const base = {
    contract: 'r72-zernio-account-webhook-v1' as const,
    workspaceId: WORKSPACE, connectionId: CONNECTION, eventId: EVENT,
    event: 'account.connected' as const, network: 'linkedin' as const,
    occurredAt: '2026-09-03T10:01:00.000Z',
    providerAccountIdSha256: 'b'.repeat(64), rawBodySha256: 'c'.repeat(64),
    receiptSha256: 'd'.repeat(64), providerEffects: 'none' as const,
  };
  assert.deepEqual(await service.recordWebhook({
    ...base, providerProfileIdSha256: createHash('sha256').update('other-profile').digest('hex'),
  }), { ok: false, kind: 'forbidden' });
  assert.equal(client.calls.length, 0);
  assert.deepEqual(await service.recordWebhook({
    ...base, providerProfileIdSha256: createHash('sha256').update(COMPANY).digest('hex'),
  }), { ok: true, disposition: 'recorded', providerEffects: 'none' });
});

function signedBody(profileId: string) {
  const rawBody = Buffer.from(JSON.stringify({
    id: EVENT, event: 'account.connected', timestamp: '2026-09-03T10:01:00.000Z',
    account: {
      accountId: '6a98ae4677555aae01c8ec39', profileId,
      platform: 'linkedin', username: 'Property Predator', displayName: 'Property Predator',
    },
  }));
  return {
    rawBody,
    signature: createHmac('sha256', SECRET).update(rawBody).digest('hex'),
  };
}

async function invokeWebhook(
  service: PortalZernioSocialConnectionService,
  profileId: string,
): Promise<{ statusCode: number; body: string }> {
  const mount = composePropertyPredatorZernioAccountWebhook({
    PROPERTY_PREDATOR_PILOT_WORKSPACE_ID: WORKSPACE,
    ZERNIO_WEBHOOK_CREDENTIAL_VERSION: 'version-1', ZERNIO_WEBHOOK_SECRET: SECRET,
  }, service);
  assert.equal(mount.ready, true);
  const signed = signedBody(profileId);
  const req = new EventEmitter() as EventEmitter & {
    method: string; headers: Record<string, string>; resume(): void;
  };
  req.method = 'POST';
  req.headers = {
    'content-type': 'application/json', 'content-length': String(signed.rawBody.length),
    'x-zernio-signature': signed.signature, 'x-zernio-event-id': EVENT,
  };
  req.resume = () => undefined;
  const response = {
    statusCode: 0, body: '', headersSent: false,
    writeHead(statusCode: number) { this.statusCode = statusCode; this.headersSent = true; },
    end(body: string) { this.body = body; },
  };
  setImmediate(() => { req.emit('data', signed.rawBody); req.emit('end'); });
  await mount.handle!(req as never, response as never);
  return response;
}

test('the team webhook accepts the company profile but rejects profiles outside the allowlist', async () => {
  const accepted: string[] = [];
  const service: PortalZernioSocialConnectionService = {
    providerConnectionId: CONNECTION, providerProfileId: PRIMARY,
    providerProfileIds: [PRIMARY, COMPANY],
    async snapshot() { return { ok: true, accounts: [] }; },
    async begin() { return { ok: false, kind: 'unavailable' }; },
    async callback() { return { ok: false, kind: 'unavailable' }; },
    async recordWebhook(input) {
      accepted.push(input.providerProfileIdSha256);
      return { ok: true, disposition: 'recorded', providerEffects: 'none' };
    },
  };
  assert.equal((await invokeWebhook(service, COMPANY)).statusCode, 200);
  assert.deepEqual(accepted, [createHash('sha256').update(COMPANY).digest('hex')]);
  assert.equal((await invokeWebhook(service, 'unlisted-profile')).statusCode, 401);
  assert.equal(accepted.length, 1);
});
