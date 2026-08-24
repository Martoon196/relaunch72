import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import type { Pool } from 'pg';
import {
  MissingSetupDeliveryKeyError,
  PgSetupDeliveryService,
  SetupDeliveryKeyring,
  setupDeliveryAad,
} from '../src/portal/setup-delivery-pg-service.js';

const IDS = {
  delivery: '11111111-1111-4111-8111-111111111111',
  otherDelivery: '22222222-2222-4222-8222-222222222222',
  user: '33333333-3333-4333-8333-333333333333',
  workspace: '44444444-4444-4444-8444-444444444444',
  action: '55555555-5555-4555-8555-555555555555',
};
const SETUP_TOKEN = 'S'.repeat(43);
const LEASE_TOKEN = 'L'.repeat(43);
const KEY = Buffer.alloc(32, 7);
const IV = Buffer.alloc(12, 9);

function keyring(keyId = 'setup-key-v1'): SetupDeliveryKeyring {
  return new SetupDeliveryKeyring({ activeKeyId: keyId, keys: { [keyId]: KEY } });
}

function unusedPool(): Pick<Pool, 'query'> {
  return { query: async () => ({ rows: [] }) as never } as unknown as Pick<Pool, 'query'>;
}

test('AES-GCM setup delivery uses exact domain-separated UUID AAD and rejects tampering', () => {
  const ring = keyring();
  const service = new PgSetupDeliveryService({
    deliveryCommandPool: unusedPool(),
    keyring: ring,
    setupUrl: 'https://portal.example.test/portal/setup',
    createSetupToken: () => SETUP_TOKEN,
    createDeliveryId: () => IDS.delivery.toUpperCase(),
    createIv: () => IV,
  });
  const encrypted = service.prepare(' OWNER@Example.TEST ');
  const expectedAad = Buffer.concat([
    Buffer.from('r72/setup-link/v1', 'utf8'),
    Buffer.from([0]),
    Buffer.from(IDS.delivery, 'ascii'),
  ]);
  assert.deepEqual(setupDeliveryAad(IDS.delivery), expectedAad);
  assert.equal(encrypted.deliveryId, IDS.delivery);
  assert.equal(encrypted.encryptionKeyId, 'setup-key-v1');
  assert.equal(encrypted.encryptedPayload.includes(Buffer.from(SETUP_TOKEN)), false);
  assert.deepEqual(encrypted.setupTokenHash, createHash('sha256').update(SETUP_TOKEN).digest());

  const opened = ring.open({
    deliveryId: encrypted.deliveryId,
    payloadVersion: encrypted.payloadVersion,
    encryptionKeyId: encrypted.encryptionKeyId,
    encryptionIv: encrypted.encryptionIv,
    encryptedPayload: encrypted.encryptedPayload,
    authenticationTag: encrypted.authenticationTag,
    aadContext: expectedAad,
  });
  assert.equal(opened.recipientEmail, 'owner@example.test');
  assert.equal(new URL(opened.setupUrl).searchParams.get('token'), SETUP_TOKEN);

  const tampered = Buffer.from(encrypted.encryptedPayload);
  tampered[0] = tampered[0]! ^ 1;
  assert.throws(() => ring.open({
    deliveryId: encrypted.deliveryId,
    payloadVersion: 1,
    encryptionKeyId: encrypted.encryptionKeyId,
    encryptionIv: encrypted.encryptionIv,
    encryptedPayload: tampered,
    authenticationTag: encrypted.authenticationTag,
    aadContext: expectedAad,
  }), /authentication failed/);
  assert.throws(() => ring.open({
    deliveryId: IDS.otherDelivery,
    payloadVersion: 1,
    encryptionKeyId: encrypted.encryptionKeyId,
    encryptionIv: encrypted.encryptionIv,
    encryptedPayload: encrypted.encryptedPayload,
    authenticationTag: encrypted.authenticationTag,
    aadContext: expectedAad,
  }), /AAD does not match/);
});

test('setup delivery base URL is strict HTTPS portal authority with loopback-only HTTP', () => {
  const options = {
    deliveryCommandPool: unusedPool(),
    keyring: keyring(),
  };
  for (const setupUrl of [
    'http://portal.example.test/portal/setup',
    'https://portal.example.test/not-setup',
    'https://portal.example.test/portal/setup?from=config',
    'https://portal.example.test/portal/setup#fragment',
    'https://user:pass@portal.example.test/portal/setup',
  ]) {
    assert.throws(() => new PgSetupDeliveryService({ ...options, setupUrl }), /setupUrl must/);
  }
  assert.doesNotThrow(() => new PgSetupDeliveryService({
    ...options,
    setupUrl: 'http://127.0.0.1:3210/portal/setup',
  }));
  assert.doesNotThrow(() => new PgSetupDeliveryService({
    ...options,
    setupUrl: 'https://portal.example.test/portal/setup',
  }));
});

test('claim decrypts a stable payload while SQL receives only a lease hash', async () => {
  const ring = keyring();
  let claimedSql = '';
  let claimedValues: unknown[] = [];
  let encrypted: ReturnType<PgSetupDeliveryService['prepare']>;
  const pool = {
    query: async (text: string, values?: unknown[]) => {
      claimedSql = text;
      claimedValues = values ?? [];
      return { rows: [{
        delivery_id: encrypted.deliveryId,
        user_id: IDS.user,
        workspace_id: IDS.workspace,
        action_token_id: IDS.action,
        payload_version: encrypted.payloadVersion,
        encryption_key_id: encrypted.encryptionKeyId,
        encryption_iv: encrypted.encryptionIv,
        encrypted_payload: encrypted.encryptedPayload,
        authentication_tag: encrypted.authenticationTag,
        recipient_email_hash: encrypted.recipientEmailHash,
        aad_context: setupDeliveryAad(encrypted.deliveryId),
        attempt_count: 1,
        lease_expires_at: '2030-01-01T00:01:00.000Z',
      }] } as never;
    },
  } as unknown as Pick<Pool, 'query'>;
  const service = new PgSetupDeliveryService({
    deliveryCommandPool: pool,
    keyring: ring,
    setupUrl: 'https://portal.example.test/portal/setup',
    createSetupToken: () => SETUP_TOKEN,
    createDeliveryId: () => IDS.delivery,
    createLeaseToken: () => LEASE_TOKEN,
    createIv: () => IV,
  });
  encrypted = service.prepare('owner@example.test');
  const jobs = await service.claim(1, 60);
  assert.match(claimedSql, /claim_account_setup_deliveries/);
  assert.match(claimedSql, /recipient_email_hash/);
  assert.deepEqual(claimedValues[0], createHash('sha256').update(LEASE_TOKEN).digest());
  assert.equal(claimedValues.includes(LEASE_TOKEN), false);
  assert.equal(claimedSql.includes('token_hash'), false, 'claim result never selects the setup-token hash');
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]!.providerIdempotencyKey, IDS.delivery);
  assert.equal(jobs[0]!.leaseToken, LEASE_TOKEN);
  assert.equal(new URL(jobs[0]!.setupUrl).searchParams.get('token'), SETUP_TOKEN);
});

test('claim stays single-row so a corrupt or unavailable-key job cannot strand a valid batch', async () => {
  const service = new PgSetupDeliveryService({
    deliveryCommandPool: { query: async () => ({ rows: [], rowCount: 0 }) } as never,
    keyring: keyring(),
    setupUrl: 'https://portal.example.test/portal/setup',
  });

  await assert.rejects(
    () => service.claim(2, 60),
    /batchSize must be exactly 1/,
  );
});

test('authenticated payload corruption returns no provider work and releases the batch to retry', async () => {
  const ring = keyring();
  const producer = new PgSetupDeliveryService({
    deliveryCommandPool: unusedPool(),
    keyring: ring,
    setupUrl: 'https://portal.example.test/portal/setup',
    createSetupToken: () => SETUP_TOKEN,
    createDeliveryId: () => IDS.delivery,
    createIv: () => IV,
  });
  const encrypted = producer.prepare('owner@example.test');
  const tamperedTag = Buffer.from(encrypted.authenticationTag);
  tamperedTag[0] = tamperedTag[0]! ^ 1;
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const pool = {
    query: async (text: string, values?: unknown[]) => {
      calls.push({ text, values: values ?? [] });
      if (text.includes('.claim_account_setup_deliveries')) {
        return { rows: [{
          delivery_id: encrypted.deliveryId,
          user_id: IDS.user,
          workspace_id: IDS.workspace,
          action_token_id: IDS.action,
          payload_version: encrypted.payloadVersion,
          encryption_key_id: encrypted.encryptionKeyId,
          encryption_iv: encrypted.encryptionIv,
          encrypted_payload: encrypted.encryptedPayload,
          authentication_tag: tamperedTag,
          recipient_email_hash: encrypted.recipientEmailHash,
          aad_context: setupDeliveryAad(encrypted.deliveryId),
          attempt_count: 1,
          lease_expires_at: '2030-01-01T00:01:00.000Z',
        }] } as never;
      }
      return { rows: [{
        delivery_state: 'retry',
        available_at: '2030-01-01T00:02:00.000Z',
      }] } as never;
    },
  } as unknown as Pick<Pool, 'query'>;
  const worker = new PgSetupDeliveryService({
    deliveryCommandPool: pool,
    keyring: ring,
    setupUrl: 'https://portal.example.test/portal/setup',
    createLeaseToken: () => LEASE_TOKEN,
  });
  await assert.rejects(() => worker.claim(), /authentication failed/);
  assert.equal(calls.length, 2);
  assert.match(calls[1]!.text, /fail_account_setup_delivery/);
  assert.equal(calls[1]!.values[2], 'payload_batch_rejected');
  assert.equal(calls.flatMap((call) => call.values).includes(LEASE_TOKEN), false);
});

test('claim binds the encrypted recipient to the database-authoritative email hash', async () => {
  const ring = keyring();
  const encrypted = new PgSetupDeliveryService({
    deliveryCommandPool: unusedPool(),
    keyring: ring,
    setupUrl: 'https://portal.example.test/portal/setup',
    createSetupToken: () => SETUP_TOKEN,
    createDeliveryId: () => IDS.delivery,
    createIv: () => IV,
  }).prepare('owner@example.test');
  let failures = 0;
  const pool = {
    query: async (text: string) => {
      if (text.includes('.claim_account_setup_deliveries')) {
        return { rows: [{
          delivery_id: encrypted.deliveryId,
          user_id: IDS.user,
          workspace_id: IDS.workspace,
          action_token_id: IDS.action,
          payload_version: encrypted.payloadVersion,
          encryption_key_id: encrypted.encryptionKeyId,
          encryption_iv: encrypted.encryptionIv,
          encrypted_payload: encrypted.encryptedPayload,
          authentication_tag: encrypted.authenticationTag,
          recipient_email_hash: createHash('sha256').update('someone-else@example.test').digest(),
          aad_context: setupDeliveryAad(encrypted.deliveryId),
          attempt_count: 1,
          lease_expires_at: '2030-01-01T00:01:00.000Z',
        }] } as never;
      }
      failures += 1;
      return { rows: [{ delivery_state: 'retry', available_at: '2030-01-01T00:02:00.000Z' }] } as never;
    },
  } as unknown as Pick<Pool, 'query'>;
  const worker = new PgSetupDeliveryService({
    deliveryCommandPool: pool,
    keyring: ring,
    setupUrl: 'https://portal.example.test/portal/setup',
    createLeaseToken: () => LEASE_TOKEN,
  });

  await assert.rejects(() => worker.claim(), /recipient does not match database authority/);
  assert.equal(failures, 1, 'the fenced row is returned to retry without provider work');
});

test('decrypted setup URL must retain the configured portal origin', async () => {
  const ring = keyring();
  const otherOrigin = new PgSetupDeliveryService({
    deliveryCommandPool: unusedPool(),
    keyring: ring,
    setupUrl: 'https://other.example.test/portal/setup',
    createSetupToken: () => SETUP_TOKEN,
    createDeliveryId: () => IDS.delivery,
    createIv: () => IV,
  }).prepare('owner@example.test');
  let failures = 0;
  const pool = {
    query: async (text: string) => {
      if (text.includes('.claim_account_setup_deliveries')) {
        return { rows: [{
          delivery_id: otherOrigin.deliveryId,
          user_id: IDS.user,
          workspace_id: IDS.workspace,
          action_token_id: IDS.action,
          payload_version: 1,
          encryption_key_id: otherOrigin.encryptionKeyId,
          encryption_iv: otherOrigin.encryptionIv,
          encrypted_payload: otherOrigin.encryptedPayload,
          authentication_tag: otherOrigin.authenticationTag,
          recipient_email_hash: otherOrigin.recipientEmailHash,
          aad_context: setupDeliveryAad(otherOrigin.deliveryId),
          attempt_count: 1,
          lease_expires_at: '2030-01-01T00:01:00.000Z',
        }] } as never;
      }
      failures += 1;
      return { rows: [{ delivery_state: 'retry', available_at: '2030-01-01T00:02:00.000Z' }] } as never;
    },
  } as unknown as Pick<Pool, 'query'>;
  const worker = new PgSetupDeliveryService({
    deliveryCommandPool: pool,
    keyring: ring,
    setupUrl: 'https://portal.example.test/portal/setup',
    createLeaseToken: () => LEASE_TOKEN,
  });
  await assert.rejects(() => worker.claim(), /does not match the configured portal/);
  assert.equal(failures, 1);
});

test('ack, renewal and retry commands fence with a hash and never pass the raw lease', async () => {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const pool = {
    query: async (text: string, values?: unknown[]) => {
      calls.push({ text, values: values ?? [] });
      if (text.includes('.renew_account_setup_delivery_lease')) {
        return { rows: [{ lease_expires_at: '2030-01-01T00:02:00.000Z' }] } as never;
      }
      if (text.includes('.acknowledge_account_setup_delivery')) {
        return { rows: [{ acknowledged: true }] } as never;
      }
      return { rows: [{ delivery_state: 'retry', available_at: '2030-01-01T00:03:00.000Z' }] } as never;
    },
  } as unknown as Pick<Pool, 'query'>;
  const service = new PgSetupDeliveryService({
    deliveryCommandPool: pool,
    keyring: keyring(),
    setupUrl: 'https://portal.example.test/portal/setup',
  });
  assert.equal(await service.renew(IDS.delivery, LEASE_TOKEN, 60), '2030-01-01T00:02:00.000Z');
  assert.equal(await service.acknowledge(IDS.delivery, LEASE_TOKEN), true);
  assert.deepEqual(
    await service.fail(IDS.delivery, LEASE_TOKEN, 'provider_unavailable', '2030-01-01T00:03:00.000Z'),
    { state: 'retry', availableAt: '2030-01-01T00:03:00.000Z' },
  );
  const leaseHash = createHash('sha256').update(LEASE_TOKEN).digest();
  for (const call of calls) {
    assert.equal(call.values.includes(LEASE_TOKEN), false);
    assert.deepEqual(call.values[1], leaseHash);
  }
});

test('trusted reissue sends encrypted payload plus token hash and returns no credential', async () => {
  let values: unknown[] = [];
  const reissuePool = {
    query: async (_text: string, input?: unknown[]) => {
      values = input ?? [];
      return { rows: [{
        setup_action_token_id: IDS.action,
        setup_expires_at: '2030-01-02T00:00:00.000Z',
        setup_delivery_id: IDS.delivery,
        setup_delivery_generation: 2,
        created_now: true,
      }] } as never;
    },
  } as unknown as Pick<Pool, 'query'>;
  const service = new PgSetupDeliveryService({
    deliveryCommandPool: unusedPool(),
    reissueCommandPool: reissuePool,
    keyring: keyring(),
    setupUrl: 'https://portal.example.test/portal/setup',
    createSetupToken: () => SETUP_TOKEN,
    createDeliveryId: () => IDS.delivery,
    createIv: () => IV,
  });
  const result = await service.reissue({
    idempotencyKey: 'support-ticket-123',
    workspaceId: IDS.workspace,
    userId: IDS.user,
    operatorRequest: 'ticket:123:owner-requested-new-link',
    recipientEmail: 'owner@example.test',
  });
  assert.equal(result.createdNow, true);
  assert.equal(result.setupDeliveryGeneration, 2);
  assert.equal('setupToken' in result, false);
  assert.equal(values.includes(SETUP_TOKEN), false);
  assert.deepEqual(values[4], createHash('sha256').update(SETUP_TOKEN).digest());
  assert.deepEqual(values[5], createHash('sha256').update('owner@example.test').digest());
  assert.equal((values[10] as Buffer).includes(Buffer.from(SETUP_TOKEN)), false);
});

test('missing historical key fails readiness and claim without dead-lettering', async () => {
  const ring = keyring('current-key');
  const readinessPool = {
    query: async () => ({ rows: [{ encryption_key_id: 'retired-key' }] }) as never,
  } as unknown as Pick<Pool, 'query'>;
  const service = new PgSetupDeliveryService({
    deliveryCommandPool: readinessPool,
    keyring: ring,
    setupUrl: 'https://portal.example.test/portal/setup',
  });
  await assert.rejects(
    () => service.assertReadyForPendingDeliveries(),
    (error: unknown) => error instanceof MissingSetupDeliveryKeyError
      && error.keyId === 'retired-key',
  );
});
