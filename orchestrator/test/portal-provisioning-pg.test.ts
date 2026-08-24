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
};
const RAW_TOKEN = 'A'.repeat(43);

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
          created_now: true,
        }] } as never;
      },
    } as unknown as Pick<Pool, 'query'>,
    createSetupToken: () => RAW_TOKEN,
  });

  const provisioned = await service.provision({
    idempotencyKey: 'cs_verified_123',
    organizationName: '  Frayne   Electrical  ',
    ownerEmail: ' OWNER@Example.COM ',
    ownerDisplayName: '  Martin   Frayne ',
  });

  assert.equal(provisioned.setupToken, RAW_TOKEN);
  assert.equal(provisioned.createdNow, true);
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.text, /app_private\.provision_customer_workspace/);
  assert.equal(calls[0]!.values[0], 'cs_verified_123');
  assert.equal(calls[0]!.values[1], 'Frayne Electrical');
  assert.match(String(calls[0]!.values[2]), /^frayne-electrical-[a-f0-9]{10}$/);
  assert.equal(calls[0]!.values[5], 'owner@example.com');
  assert.deepEqual(calls[0]!.values[7], createHash('sha256').update(RAW_TOKEN).digest());
  assert.ok(!calls[0]!.values.includes(RAW_TOKEN), 'the raw setup token never crosses into PostgreSQL');
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
        created_now: false,
      }] }) as never,
    } as unknown as Pick<Pool, 'query'>,
    createSetupToken: () => RAW_TOKEN,
  });
  const replay = await service.provision({
    idempotencyKey: 'cs_verified_123',
    organizationName: 'Frayne Electrical',
    ownerEmail: 'owner@example.com',
  });
  assert.equal(replay.createdNow, false);
  assert.equal(replay.setupToken, null);
});

test('native provisioning rejects untrusted or malformed authority before SQL', async () => {
  let called = false;
  const service = new PgCustomerProvisioningService({
    commandPool: {
      query: async () => { called = true; return { rows: [] } as never; },
    } as unknown as Pick<Pool, 'query'>,
    createSetupToken: () => RAW_TOKEN,
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
