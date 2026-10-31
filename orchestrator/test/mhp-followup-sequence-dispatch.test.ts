import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatchMhpSequenceEmails, PgMhpSequenceDispatch, type MhpSequenceDispatch } from '../src/mhp/followup-sequence-dispatch.js';
import type { MhpOwnerEmailPrepared } from '../src/mhp/owner-email-dispatch.js';
import { startMhpMarketingDispatcher } from '../src/mhp/marketing-mail.js';
import { exact, ids, now } from './helpers/mhp-owner-email-fixture.js';
const secret = 'synthetic-sequence-unsubscribe-secret-at-least-32';
const lease = { id: ids.send, leaseId: ids.lease, leaseUntil: new Date(now + 120_000).toISOString() };
const prepared: MhpOwnerEmailPrepared = { ...lease, proofId: ids.proof, prospectId: ids.prospect, email: 'consented@example.invalid', firstName: 'Sam',
  context: { label: 'Webinar', link: 'https://martinhowardproperty.co.uk/webinar/' }, exact: { ...exact, approvalDecisionId: ids.approval } };
function fixture() {
  const state = { calls: [] as string[], provider: false, settle: false, unknown: false, noProof: false, prepareFailure: false };
  const queue: MhpSequenceDispatch = { claim: async (_limit, _leaseSeconds, emails) => { assert.deepEqual(emails, ['consented@example.invalid']); state.calls.push('claim'); return [lease]; },
    prepare: async () => { state.calls.push('prepare'); if (state.prepareFailure) throw new Error('DB response lost'); return state.noProof ? null : prepared; },
    settle: async (_lease, accepted) => { assert.equal(accepted, true); state.calls.push('accepted'); if (state.settle) throw new Error('Settlement response lost'); },
    unknown: async () => { state.calls.push('unknown'); if (state.unknown) throw new Error('DB unavailable'); } };
  const sender = { sendRendered: async (send: { tag?: string; rendered: { text: string } }) => { state.calls.push('provider'); assert.equal(send.tag, 'owner_sequence'); assert.match(send.rendered.text, /£500 café/u);
    if (state.provider) throw new Error('Postmark response lost'); return 'synthetic-sequence-reference'; } };
  const run = () => dispatchMhpSequenceEmails({ queue, sender, unsubscribeSecret: secret, testRecipients: ['consented@example.invalid'], now: () => now });
  return { state, queue, run };
}
test('sequence uses existing exact rendered sender and only true provider acceptance settles a successful step', async () => {
  const f = fixture(); assert.deepEqual(await f.run(), { sent: 1, failed: 0, unknown: 0 });
  assert.deepEqual(f.state.calls, ['claim', 'prepare', 'provider', 'accepted']);
});
test('post-proof network exceptions preserve unknown and never record a definite rejection or retry', async () => {
  const f = fixture(); f.state.provider = true;
  assert.deepEqual(await f.run(), { sent: 0, failed: 0, unknown: 1 });
  assert.deepEqual(f.state.calls, ['claim', 'prepare', 'provider', 'unknown']);
});
test('lost settlement response is unknown even after provider returned a reference', async () => {
  const f = fixture(); f.state.settle = true;
  assert.deepEqual(await f.run(), { sent: 0, failed: 0, unknown: 1 });
  assert.deepEqual(f.state.calls, ['claim', 'prepare', 'provider', 'accepted', 'unknown']);
});
test('unknown-state persistence failure cannot initiate another provider operation', async () => {
  const f = fixture(); f.state.provider = true; f.state.unknown = true;
  assert.equal((await f.run()).unknown, 1); assert.equal(f.state.calls.filter(call => call === 'provider').length, 1);
});
test('paused or invalid prepare does not send, settle false or claim a successful progression', async () => {
  const paused = fixture(); paused.state.noProof = true;
  assert.deepEqual(await paused.run(), { sent: 0, failed: 0, unknown: 0 }); assert.deepEqual(paused.state.calls, ['claim', 'prepare']);
  const missing = fixture(); missing.state.prepareFailure = true;
  assert.deepEqual(await missing.run(), { sent: 0, failed: 1, unknown: 0 }); assert.deepEqual(missing.state.calls, ['claim', 'prepare']);
});
test('PG sequence adapter calls only fixed restricted capabilities and keeps existing pinned proof validation', async () => {
  const calls: { sql: string; values: unknown[] }[] = []; let value: unknown = [lease];
  const queue = new PgMhpSequenceDispatch({ query: async (sql: string, values: unknown[]) => { calls.push({ sql, values }); return { rows: [{ jobs: value, prepared: value }] }; } } as any);
  assert.deepEqual(await queue.claim(25, 120, null), [lease]);
  value = { ...prepared, leaseId: ids.request }; await assert.rejects(queue.prepare(lease), /pinned owner email proof/u);
  value = prepared; assert.equal((await queue.prepare(lease))?.proofId, ids.proof);
  await queue.settle(lease, true, 'synthetic'); await queue.unknown(lease);
  assert.ok(calls.every(call => call.sql.startsWith('SELECT app_private.mhp_')));
  assert.deepEqual(calls.at(-1)?.values, [lease.id, lease.leaseId]);
});
test('existing marketing interval calls sequence sweep after unchanged legacy and standalone paths', async () => {
  const calls: string[] = []; let finished!: () => void; const done = new Promise<void>(resolve => { finished = resolve; });
  const stop = startMhpMarketingDispatcher({ claim: async () => { calls.push('legacy'); return []; }, settle: async () => {} }, { send: async () => 'unused' },
    { testRecipients: null }, { owner: { queue: { claim: async () => { calls.push('standalone'); return []; }, prepare: async () => null, settle: async () => {} }, sender: { sendRendered: async () => 'unused' }, unsubscribeSecret: secret },
      sequences: { queue: { claim: async () => { calls.push('sequence'); finished(); return []; }, prepare: async () => null, settle: async () => {}, unknown: async () => {} }, sender: { sendRendered: async () => 'unused' }, unsubscribeSecret: secret } });
  await done; stop(); assert.deepEqual(calls, ['legacy', 'standalone', 'sequence']);
});
