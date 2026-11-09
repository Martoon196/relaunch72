import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import type { Pool } from 'pg';
import { PgCustomerProvisioningService } from '../src/portal/provisioning-pg-service.js';

const IDS = {
  organization: '11111111-1111-4111-8111-111111111111',
  workspace: '22222222-2222-4222-8222-222222222222',
  user: '33333333-3333-4333-8333-333333333333',
  action: '44444444-4444-4444-8444-444444444444',
  delivery: '55555555-5555-4555-8555-555555555555',
};
const RAW_TOKEN = 'A'.repeat(43);
const preparedDelivery = {
  deliveryId: IDS.delivery,
  setupTokenHash: createHash('sha256').update(RAW_TOKEN).digest(),
  recipientEmailHash: createHash('sha256').update('owner@example.com').digest(),
  payloadVersion: 1 as const,
  encryptionKeyId: 'setup-key-v1',
  encryptionIv: Buffer.alloc(12, 1),
  encryptedPayload: Buffer.from('authenticated encrypted payload'),
  authenticationTag: Buffer.alloc(16, 2),
};

test('native provisioning sends only a setup-token hash and canonical stable customer data', async () => {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const service = new PgCustomerProvisioningService({
    commandPool: {
      query: async (text: string, values?: unknown[]) => {
        calls.push({ text, values: values ?? [] });
        return { rows: [{
          organization_id: IDS.organization,
          workspace_id: IDS.workspace,
          owner_user_id: IDS.user,
          setup_action_token_id: IDS.action,
          setup_expires_at: '2030-01-02T00:00:00.000Z',
          setup_delivery_id: IDS.delivery,
          setup_delivery_generation: 1,
          created_now: true,
        }] } as never;
      },
    } as unknown as Pick<Pool, 'query'>,
    setupDelivery: { prepare: () => preparedDelivery },
  });

  const provisioned = await service.provision({
    idempotencyKey: 'cs_verified_123',
    organizationName: '  Frayne   Electrical  ',
    ownerEmail: ' OWNER@Example.COM ',
    ownerDisplayName: '  Martin   Frayne ',
  });

  assert.equal(provisioned.createdNow, true);
  assert.equal(provisioned.setupDeliveryId, IDS.delivery);
  assert.equal(provisioned.setupDeliveryGeneration, 1);
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.text, /app_private\.provision_customer_workspace_with_setup_delivery/);
  assert.equal(calls[0]!.values[0], 'cs_verified_123');
  assert.equal(calls[0]!.values[1], 'Frayne Electrical');
  assert.match(String(calls[0]!.values[2]), /^frayne-electrical-[a-f0-9]{10}$/);
  assert.equal(calls[0]!.values[5], 'owner@example.com');
  assert.deepEqual(calls[0]!.values[7], createHash('sha256').update(RAW_TOKEN).digest());
  assert.ok(!calls[0]!.values.includes(RAW_TOKEN), 'the raw setup token never crosses into PostgreSQL');
  assert.deepEqual(calls[0]!.values[8], preparedDelivery.recipientEmailHash);
  assert.equal(calls[0]!.values[12], IDS.delivery);
  assert.deepEqual(calls[0]!.values[16], preparedDelivery.encryptedPayload);
});

test('idempotent replay never exposes the unrelated fresh token', async () => {
  const service = new PgCustomerProvisioningService({
    commandPool: {
      query: async () => ({ rows: [{
        organization_id: IDS.organization,
        workspace_id: IDS.workspace,
        owner_user_id: IDS.user,
        setup_action_token_id: IDS.action,
        setup_expires_at: new Date('2030-01-02T00:00:00.000Z'),
        setup_delivery_id: IDS.delivery,
        setup_delivery_generation: 1,
        created_now: false,
      }] }) as never,
    } as unknown as Pick<Pool, 'query'>,
    setupDelivery: { prepare: () => preparedDelivery },
  });
  const replay = await service.provision({
    idempotencyKey: 'cs_verified_123',
    organizationName: 'Frayne Electrical',
    ownerEmail: 'owner@example.com',
  });
  assert.equal(replay.createdNow, false);
  assert.equal(replay.setupDeliveryId, IDS.delivery);
  assert.equal('setupToken' in replay, false);
});

test('native provisioning rejects untrusted or malformed authority before SQL', async () => {
  let called = false;
  const service = new PgCustomerProvisioningService({
    commandPool: {
      query: async () => { called = true; return { rows: [] } as never; },
    } as unknown as Pick<Pool, 'query'>,
    setupDelivery: { prepare: () => preparedDelivery },
  });
  await assert.rejects(() => service.provision({
    idempotencyKey: ' cs_browser ',
    organizationName: 'Client',
    ownerEmail: 'owner@example.com',
  }), /idempotencyKey/);
  await assert.rejects(() => service.provision({
    idempotencyKey: 'cs_verified',
    organizationName: 'Client',
    ownerEmail: 'not-an-email',
  }), /ownerEmail/);
  assert.equal(called, false);
});

test('native provisioning fails closed when durable delivery encryption is not configured', async () => {
  let called = false;
  const service = new PgCustomerProvisioningService({
    commandPool: {
      query: async () => { called = true; return { rows: [] } as never; },
    } as unknown as Pick<Pool, 'query'>,
  });
  await assert.rejects(() => service.provision({
    idempotencyKey: 'cs_verified',
    organizationName: 'Client',
    ownerEmail: 'owner@example.com',
  }), /requires durable setup delivery configuration/);
  assert.equal(called, false);
});
