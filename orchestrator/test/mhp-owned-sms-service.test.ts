import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { MhpOwnedSmsService, mhpOwnedSmsConfig, assertMhpOwnedSmsBoundaryReady, MHP_OWNED_SMS_DEFAULT_BODY, type MhpOwnedSmsConfig, type MhpOwnedSmsDependencies, type MhpOwnedSmsSendResult } from '../src/mhp/owned-sms-service.js';
import { smsVerificationDisplayBrand } from '../src/sms-live-pg/phone-verification.js';
import { requestDatabaseContext } from '../src/db/rls.js';
import { ids, identity, review } from './helpers/mhp-owner-email-fixture.js';
const canonical = JSON.stringify({ bodyText: MHP_OWNED_SMS_DEFAULT_BODY, schema: 'growthhq.sms-draft/v1' });
const sha = createHash('sha256').update(canonical).digest('hex');
const config: MhpOwnedSmsConfig = { ownerUserId: ids.user, contactId: ids.prospect, phone: '+447510243096', connectionId: ids.send,
  bindingId: ids.approval, endpointId: ids.request, accountSid: `AC${'a'.repeat(32)}`, messagingServiceSid: `MG${'b'.repeat(32)}`, senderNumber: '+447861935832' };
export function ownedSmsServiceFixture() {
  const calls: string[] = [], state = { replay: false, reviewBlocked: false, verified: true, suppressed: false };
  const result: MhpOwnedSmsSendResult = { jobId: ids.send, commandId: ids.command, contentVersionId: ids.version,
    messageVersionId: ids.lease, state: 'queued', replayed: false, authorityExpiresAt: '2026-11-01T12:04:00.000Z' };
  const dependencies: MhpOwnedSmsDependencies = {
    config, blockers: [], marketingWorkspace: { snapshot: async given => ({ userId: given.userId, selectedWorkspaceId: given.workspaceId,
      personalWorkspaceId: ids.prospect, marketingWorkspaceId: identity.workspaceId, marketingSelected: given.workspaceId === identity.workspaceId }) },
    authorize: async (given, requestId) => requestDatabaseContext({ userId: given.userId, workspaceId: given.workspaceId, requestId,
      portalSessionTokenHash: createHash('sha256').update(given.sessionToken).digest() }),
    repository: { snapshot: async () => ({ contactId: config.contactId, contactPointId: ids.proof, bindingId: config.bindingId,
      senderNumber: config.senderNumber, verified: state.verified, suppressed: state.suppressed, lastResult: null }),
      lookup: async () => { calls.push('lookup'); return state.replay ? { ...result, replayed: true, state: 'needs_attention' } : null; },
      send: async (_context, _identity, input) => { calls.push('send'); assert.equal(input.pointId, ids.proof); return result; } },
    binding: { bindSender: async (_given, input) => { calls.push('bind'); assert.equal(input.senderNumber, config.senderNumber); return { ok: true, bindingId: config.bindingId, providerEffects: 'none' }; },
      requestPhoneVerification: async (_given, input) => { assert.equal(input.phone, config.phone); assert.equal(input.contactId, config.contactId); calls.push('request-code'); return { ok: true, challengeId: ids.request }; },
      confirmPhoneVerification: async () => { calls.push('confirm-code'); return { ok: true, contactPointId: ids.proof }; } },
    messages: { choices: async () => [], review: async () => { calls.push('review'); if (state.reviewBlocked) throw new Error('A newer draft exists');
      return { review: { ...review, kind: 'other', contentMimeType: 'application/vnd.growthhq.sms-draft+json',
        source: { system: 'mhp.owner-sms', itemId: `owner-sms:${ids.item}`, version: `edit:${ids.version}` }, canonicalContent: canonical, contentSha256: sha, blobSha256: sha },
        channel: 'sms', payload: { schema: 'growthhq.sms-draft/v1', bodyText: MHP_OWNED_SMS_DEFAULT_BODY }, valid: true, local: null, manifestSha256: sha }; },
      save: async () => ({ contentItemId: ids.item, contentVersionId: ids.version, contentSha256: sha, replayed: false }),
      publish: async () => { calls.push('publish'); } }, observe: async () => { calls.push('observe'); },
  };
  return { service: new MhpOwnedSmsService(dependencies), dependencies, state, calls, result };
}
const sendInput = { commandId: ids.command, itemId: ids.item, versionId: ids.version, pointId: ids.proof, sha256: sha, agreed: true };
test('owned MHP send checks historical outcome before current source and does not repeat approvals or enqueue', async () => {
  const f = ownedSmsServiceFixture(); f.state.replay = true; f.state.reviewBlocked = true; f.state.suppressed = true;
  const result = await f.service.send(identity, ids.request, sendInput);
  assert.equal(result.replayed, true); assert.equal(result.state, 'needs_attention'); assert.deepEqual(f.calls, ['lookup']);
});
test('new MHP self-test reviews and publishes exact existing0021 source before one composite operation', async () => {
  const f = ownedSmsServiceFixture(); const result = await f.service.send(identity, ids.request, sendInput);
  assert.equal(result.jobId, ids.send); assert.deepEqual(f.calls, ['lookup', 'review', 'observe', 'publish', 'send']);
});
test('missing one-test agreement has no publication, consent or queue effect', async () => {
  const f = ownedSmsServiceFixture(); await assert.rejects(f.service.send(identity, ids.request, { ...sendInput, agreed: false }), /agree/u); assert.deepEqual(f.calls, []);
});
test('another brand workspace and another owner cannot invoke the MHP pilot', async () => {
  const f = ownedSmsServiceFixture();
  await assert.rejects(f.service.snapshot({ ...identity, workspaceId: ids.prospect }, ids.request), /MHP marketing workspace/u);
  await assert.rejects(f.service.snapshot({ ...identity, userId: ids.prospect }, ids.request), /configured MHP owner/u); assert.deepEqual(f.calls, []);
});
test('a stale source before a new test cannot enqueue', async () => {
  const f = ownedSmsServiceFixture(); f.state.reviewBlocked = true;
  await assert.rejects(f.service.send(identity, ids.request, sendInput), /newer draft/u); assert.deepEqual(f.calls, ['lookup', 'review']);
});
test('verification always targets the server-owned number and accepts private six-digit code only', async () => {
  const f = ownedSmsServiceFixture(); assert.equal(await f.service.requestCode(identity, ids.request, ids.command), ids.request);
  assert.equal(await f.service.confirmCode(identity, ids.request, ids.request, '123456'), true);
  await assert.rejects(f.service.confirmCode(identity, ids.request, ids.request, '123'), /six-digit/u);
  assert.deepEqual(f.calls, ['request-code', 'confirm-code']);
});
test('existing SMS library save rejects Unicode and placeholders for the owned pilot', async () => {
  const f = ownedSmsServiceFixture(); for (const bodyText of ['Hi {{FIRSTNAME}}', 'Hello 👋']) await assert.rejects(f.service.save(identity, ids.request, { commandId: ids.command, bodyText, itemId: '', previousVersionId: '' }), /plain SMS/u);
});
test('optional OTP branding preserves PP default and admits MHP without control/markup injection', () => {
  assert.equal(smsVerificationDisplayBrand(), 'Property Predator'); assert.equal(smsVerificationDisplayBrand('Martin Howard Property'), 'Martin Howard Property');
  for (const value of [' MHP', 'MHP\nSend now', '<MHP>', '']) assert.throws(() => smsVerificationDisplayBrand(value), /display brand/u);
});
test('pilot configuration truthfully blocks missing tuple instead of borrowing PP settings', () => {
  assert.equal(mhpOwnedSmsConfig({ PROPERTY_PREDATOR_SMS_LIVE_WORKSPACE_ID: identity.workspaceId }).enabled, false);
  const result = mhpOwnedSmsConfig({ MHP_SMS_PILOT_ENABLED: 'true' }); assert.equal(result.config, null); assert.equal(result.blockers.length, 1);
});
test('optional MHP capability probe refuses an incomplete or leaked command boundary', async () => {
  for (const rows of [[], [{ ready: false }]]) await assert.rejects(assertMhpOwnedSmsBoundaryReady({ query: async () => ({ rows }) } as never), /not ready/u);
  await assertMhpOwnedSmsBoundaryReady({ query: async (sql: string) => { assert.match(sql, /NOT coalesce.*mhp_owned_sms_content/u); return { rows: [{ ready: true }] }; } } as never);
});
