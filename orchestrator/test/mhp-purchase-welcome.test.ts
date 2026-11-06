import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatchMhpPurchaseWelcome } from '../src/mhp/purchase-welcome.js';
import { createMhpTransactionalMailer, MhpWelcomeDeliveryError } from '../src/mhp/transactional-mail.js';

const job = { id: 'purchase', lease: 'lease', email: 'buyer@example.com', name: 'Buyer', productName: 'One Lane Mentoring', kind: 'mentoring' as const };
function fixture(outcome?: Error) {
  const calls: string[] = [];
  const queue = { billingEnabled: true,
    claimPurchaseWelcome: async () => { calls.push('claim'); return job; },
    beginPurchaseWelcome: async () => { calls.push('begin'); return true; },
    settlePurchaseWelcome: async (_job: typeof job, result: string) => { calls.push(result); },
  };
  const mail = { configured: true, sendPurchaseWelcome: async () => { calls.push('send'); if (outcome) throw outcome; } };
  return { calls, queue, mail };
}
test('welcome requires both billing and transactional sender configuration', async () => {
  const f = fixture(); f.queue.billingEnabled = false;
  assert.equal(await dispatchMhpPurchaseWelcome(f.queue, f.mail), 'idle');
  f.queue.billingEnabled = true; f.mail.configured = false;
  assert.equal(await dispatchMhpPurchaseWelcome(f.queue, f.mail), 'idle');
  assert.deepEqual(f.calls, []);
});
test('a revoked or changed welcome lease never calls the provider', async () => {
  const f = fixture(); f.queue.beginPurchaseWelcome = async () => false;
  assert.equal(await dispatchMhpPurchaseWelcome(f.queue, f.mail), 'idle');
  assert.deepEqual(f.calls, ['claim']);
});
test('welcome sends only after durable begin and settles the provider acknowledgement', async () => {
  const f = fixture();
  assert.equal(await dispatchMhpPurchaseWelcome(f.queue, f.mail), 'sent');
  assert.deepEqual(f.calls, ['claim', 'begin', 'send', 'sent']);
});
for (const [error, expected] of [[new MhpWelcomeDeliveryError('rejected'), 'rejected'], [new Error('connection lost'), 'unknown']] as const) {
  test(`welcome records ${expected} without retrying inside the send attempt`, async () => {
    const f = fixture(error);
    assert.equal(await dispatchMhpPurchaseWelcome(f.queue, f.mail), expected);
    assert.deepEqual(f.calls, ['claim', 'begin', 'send', expected]);
  });
}
test('settlement failure propagates without a second provider call', async () => {
  const f = fixture(); f.queue.settlePurchaseWelcome = async () => { throw new Error('database unavailable'); };
  await assert.rejects(dispatchMhpPurchaseWelcome(f.queue, f.mail), /database unavailable/);
  assert.deepEqual(f.calls, ['claim', 'begin', 'send']);
});
for (const [status, body, outcome] of [
  [200, { ErrorCode: 0, MessageID: 'provider-message' }, 'sent'],
  [422, {}, 'rejected'], [429, {}, 'rejected'], [503, {}, 'unknown'],
  [200, { ErrorCode: 0 }, 'unknown'], [200, { ErrorCode: 10 }, 'unknown'],
] as const) {
  test(`purchase provider receipt ${status}/${JSON.stringify(body)} is ${outcome}`, async () => {
    const mail = createMhpTransactionalMailer({ MHP_TRANSACTIONAL_PROVIDER: 'postmark', MHP_POSTMARK_SERVER_TOKEN: 'fixture', MHP_POSTMARK_FROM: 'mail@example.com' },
      (async () => new Response(JSON.stringify(body), { status })) as typeof fetch);
    const send = mail.sendPurchaseWelcome!(job.email, job.name, job.productName, job.kind);
    if (outcome === 'sent') await send;
    else await assert.rejects(send, (error: unknown) => error instanceof MhpWelcomeDeliveryError && error.outcome === outcome);
  });
}
