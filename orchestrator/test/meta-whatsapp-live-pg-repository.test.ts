import assert from 'node:assert/strict';
import test from 'node:test';
import { PgMetaWhatsAppLiveRepository } from '../src/whatsapp-live-pg/repository.js';

const IDS = Object.freeze({
  workspace: '11111111-1111-4111-8111-111111111111',
  connection: '22222222-2222-4222-8222-222222222222',
  binding: '33333333-3333-4333-8333-333333333333',
  job: '44444444-4444-4444-8444-444444444444',
  operation: '55555555-5555-4555-8555-555555555555',
});

test('repository claim is constructor-bound to exactly one workspace and connection', async () => {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const repository = new PgMetaWhatsAppLiveRepository({
    async query(sql: string, values: unknown[]) {
      calls.push({ sql, values });
      return { rows: [{ jobId: IDS.job, bindingId: IDS.binding, leaseVersion: '1' }] };
    },
  } as never, { workspaceId: IDS.workspace, connectionId: IDS.connection });
  const claim = await repository.claimOne({ leaseToken: Buffer.alloc(32, 1), leaseSeconds: 60 });
  assert.deepEqual(claim, { workspaceId: IDS.workspace, connectionId: IDS.connection,
    bindingId: IDS.binding, jobId: IDS.job, leaseVersion: 1 });
  assert.deepEqual(calls[0]?.values.slice(0, 2), [IDS.workspace, IDS.connection]);
  assert.match(calls[0]?.sql ?? '', /claim_whatsapp_live_job/u);
});

test('repository maps only exact encrypted material and never exposes a token SQL column', async () => {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const repository = new PgMetaWhatsAppLiveRepository({
    async query(sql: string, values: unknown[]) {
      calls.push({ sql, values });
      return { rows: [{
        providerConnectionId: IDS.connection, bindingId: IDS.binding,
        appId: '100001234567890', wabaId: '200001234567890',
        phoneNumberId: '300001234567890', graphApiVersion: 'v24.0',
        secretKeyVersion: 'render-kms-v1', secretIv: Buffer.alloc(12, 1),
        secretCiphertext: Buffer.alloc(128, 2), secretAuthTag: Buffer.alloc(16, 3),
        secretAadSha256: Buffer.alloc(32, 4), secretPayloadSha256: Buffer.alloc(32, 5),
        recipient: '447700900123', templateName: 'property_predator_owned_proof',
        languageCode: 'en_GB', operationId: IDS.operation,
        requestSha256: 'a'.repeat(64),
      }] };
    },
  } as never, { workspaceId: IDS.workspace, connectionId: IDS.connection });
  const material = await repository.loadClaimed({
    workspaceId: IDS.workspace, connectionId: IDS.connection, bindingId: IDS.binding,
    jobId: IDS.job, leaseVersion: 1, leaseToken: Buffer.alloc(32, 1),
  });
  assert.equal(material.envelope.algorithm, 'aes-256-gcm-v1');
  assert.equal(material.recipient, '447700900123');
  assert.doesNotMatch(calls[0]?.sql ?? '', /access_token|app_secret|verify_token/iu);
  assert.deepEqual(calls[0]?.values.slice(0, 2), [IDS.workspace, IDS.job]);
});

test('repository rejects cross-workspace calling fences before SQL execution', async () => {
  let called = false;
  const repository = new PgMetaWhatsAppLiveRepository({
    async query() { called = true; return { rows: [] }; },
  } as never, { workspaceId: IDS.workspace, connectionId: IDS.connection });
  await assert.rejects(repository.markCalling({
    workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    connectionId: IDS.connection, bindingId: IDS.binding, jobId: IDS.job,
    leaseVersion: 1, leaseToken: Buffer.alloc(32, 1),
    providerEffectsEnabled: true, emergencyPaused: false,
  }));
  assert.equal(called, false);
});

test('settlement stores only bounded evidence after a durable calling attempt', async () => {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const repository = new PgMetaWhatsAppLiveRepository({
    async query(sql: string, values: unknown[]) { calls.push({ sql, values }); return { rows: [] }; },
  } as never, { workspaceId: IDS.workspace, connectionId: IDS.connection });
  await repository.settle({
    workspaceId: IDS.workspace, connectionId: IDS.connection, bindingId: IDS.binding,
    jobId: IDS.job, leaseVersion: 1, leaseToken: Buffer.alloc(32, 1),
    result: { state: 'outcome_unknown', providerMessageId: null,
      receiptSha256: 'b'.repeat(64), safeCode: 'meta_transport_outcome_unknown',
      occurredAt: '2026-08-29T10:00:00.000Z' },
  });
  assert.match(calls[0]?.sql ?? '', /settle_whatsapp_live_call/u);
  assert.equal(calls[0]?.values[4], 'outcome_unknown');
  assert.equal(calls[0]?.values[5], null);
});
