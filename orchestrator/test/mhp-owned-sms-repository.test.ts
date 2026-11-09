import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { PgMhpOwnedSmsRepository, MHP_OWNED_SMS_REVIEW_VERSION, type MhpOwnedSmsSendResult } from '../src/mhp/owned-sms-service.js';
import { requestDatabaseContext } from '../src/db/rls.js';
import { ids, identity } from './helpers/mhp-owner-email-fixture.js';
const context = requestDatabaseContext({ userId: identity.userId, workspaceId: identity.workspaceId, requestId: ids.request,
  portalSessionTokenHash: createHash('sha256').update(identity.sessionToken).digest() });
const command = { commandId: ids.command, bindingId: ids.approval, contactId: ids.prospect, pointId: ids.proof, versionId: ids.version, sha256: 'a'.repeat(64) };
function fixture(value: MhpOwnedSmsSendResult | { not_started: true }) {
  const calls: { sql: string; parameters?: readonly unknown[] }[] = [];
  const client = { query: async (sql: string, parameters?: readonly unknown[]) => {
    calls.push({ sql, parameters });
    if (sql.includes('lock_active_portal_session')) return { rows: [{ active: true }] };
    if (sql.includes('mhp_owned_sms_send')) return { rows: [{ value }] };
    return { rows: [] };
  }, release() {} };
  return { calls, repository: new PgMhpOwnedSmsRepository({ connect: async () => client } as never) };
}
test('new native SMS operation uses READ COMMITTED for fresh snapshots after the content lock', async () => {
  const result = { jobId: ids.send, messageVersionId: ids.lease, contentVersionId: ids.version, commandId: ids.command,
    authorityExpiresAt: '2026-11-01T12:04:00.000Z', state: 'queued', replayed: false };
  const f = fixture(result); assert.deepEqual(await f.repository.send(context, identity, command), result);
  assert.equal(f.calls[0]?.sql, 'BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE');
  const call = f.calls.find(call => call.sql.includes('mhp_owned_sms_send'))!;
  assert.equal(call.parameters?.[7], MHP_OWNED_SMS_REVIEW_VERSION); assert.equal(call.parameters?.[8], true); assert.equal(call.parameters?.[9], false);
  assert.ok(f.calls.findIndex(call => call.sql.includes('lock_active_portal_session')) < f.calls.indexOf(call));
  assert.ok(f.calls.findIndex(call => call.sql.includes("set_config('app.user_id'")) < f.calls.indexOf(call));
});
test('historical lookup remains SERIALIZABLE, never requests mutation, and preserves unknown outcome', async () => {
  const result = { jobId: ids.send, messageVersionId: ids.lease, contentVersionId: ids.version, commandId: ids.command,
    authorityExpiresAt: '2026-11-01T12:04:00.000Z', state: 'needs_attention', replayed: true };
  const f = fixture(result); assert.deepEqual(await f.repository.lookup(context, identity, command), result);
  assert.equal(f.calls[0]?.sql, 'BEGIN ISOLATION LEVEL SERIALIZABLE READ WRITE');
  assert.equal(f.calls.find(call => call.sql.includes('mhp_owned_sms_send'))?.parameters?.[9], true);
  const absent = fixture({ not_started: true }); assert.equal(await absent.repository.lookup(context, identity, command), null);
});
