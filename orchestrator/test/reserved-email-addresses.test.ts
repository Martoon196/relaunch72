import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { allowReservedRecipientsForTestTransport, isReservedEmailAddress, refusesReservedRecipient } from '../src/email-bounces/undeliverable.js';
import { EmailBlockRegistry, EmailRecipientBlockedError, type EmailFact } from '../src/email-bounces/index.js';
import { refusalStopsPerson } from '../src/email-bounces/policy.js';
import { createMhpMarketingSender, mhpMarketingConfig, startMhpMarketingDispatcher } from '../src/mhp/marketing-mail.js';
import { dispatchMhpOwnerEmails, type MhpOwnerEmailDispatch, type MhpOwnerEmailPrepared } from '../src/mhp/owner-email-dispatch.js';
import { dispatchMhpSequenceEmails, type MhpSequenceDispatch } from '../src/mhp/followup-sequence-dispatch.js';
import type { MhpClaimedSend } from '../src/mhp/growth-service.js';
import { createMhpTransactionalMailer, MhpWelcomeDeliveryError } from '../src/mhp/transactional-mail.js';
import { dispatchMhpPurchaseWelcome } from '../src/mhp/purchase-welcome.js';
import { MHP_AUTH_ORIGIN } from '../src/mhp/auth-service.js';
import { emailHealthPage, RESERVED_ADDRESS_NOTE } from '../src/mhp/email-health.js';
import { MHP_MARKETING_WORKSPACE_ID as WS } from '../src/mhp/marketing-workspace-service.js';
import { EmailError, makePostmark } from '../src/email/postmark.js';
import { createPpPostmarkSender, PpNotSentError } from '../src/pp-followup/mail.js';
import { dispatchPpFollowupEmails } from '../src/pp-followup/dispatch.js';
import { ppMarketingConfig } from '../src/pp-followup/config.js';
import type { PpFollowupPrepared, PpFollowupQueue } from '../src/pp-followup/repository.js';
import { createPostmarkMailer, RESERVED_ADDRESS_BLOCK_REASON } from '../src/webinars/messages.js';
import type { WebinarSender } from '../src/webinars/config.js';
import { exact, ids, now } from './helpers/mhp-owner-email-fixture.js';

const REAL = 'reader@martinhowardproperty.co.uk';
const secret = 'synthetic-unsubscribe-secret-at-least-32-characters';

/** An UNMARKED fake fetch: the guard is on, exactly as with the real network fetch. It counts what would have been sent. */
function counting(reply: () => Response = () => new Response(JSON.stringify({ ErrorCode: 0, MessageID: 'pm-1' }), { status: 200 })) {
  const to: string[] = [];
  const fetcher = (async (_url: string, init: RequestInit) => { to.push(String(JSON.parse(String(init.body)).To ?? JSON.parse(String(init.body)).to?.[0]?.email)); return reply(); }) as unknown as typeof fetch;
  return { to, fetcher };
}

// ─── the helper ──────────────────────────────────────────────────────────────

test('every reserved test and documentation domain is recognised, in any case, with a trailing dot and on subdomains', () => {
  for (const address of [
    'f3-live-pilot-20261101@example.invalid', 'a@b.invalid', 'a@x.test', 'a@x.example', 'a@localhost', 'a@app.localhost',
    'a@example.com', 'a@example.net', 'a@example.org', 'a@mail.example.com', 'a@deep.sub.example.org',
    'A@EXAMPLE.COM', 'Pilot@Example.Invalid', '  padded@example.com  ', 'a@example.com.', 'a@x.test.', 'a@EXAMPLE.NET.',
    'Martin Howard <someone@example.invalid>', 'unbalanced <someone@example.com', '"quoted@real.co.uk"@example.com', 'ledger-probe@example.invalid',
    // Internationalised spellings that mail software converts to a reserved domain.
    'a@ｅｘａｍｐｌｅ.com', 'a@EXAMPLE.ＣＯＭ', 'a@x.ｔｅｓｔ',
  ]) assert.equal(isReservedEmailAddress(address), true, address);
});

test('near misses and real domains are never treated as reserved', () => {
  for (const address of [
    'a@myexample.com', 'a@example.co.uk', 'a@example.com.au', 'a@examples.com', 'a@test.co.uk', 'a@invalid.co.uk', 'a@localhost.co.uk',
    'a@testing.com', 'a@notexample.org', 'a@example-com.net', 'a@gmail.com', 'martin.howard1984@gmail.com', REAL,
    'example.com@gmail.com', 'a@example.invalid@gmail.com', 'Display example.com <real@gmail.com>', 'x.test@realdomain.uk',
    'a@xn--80ak6aa92e.com', 'a@münchen.de',
  ]) assert.equal(isReservedEmailAddress(address), false, address);
});

test('malformed and non-string input is not reserved (the senders refuse malformed addresses separately)', () => {
  for (const value of ['', '@example.com', 'example.com', 'a@', 'a@.', 'a@example..com', 'a@.example.com', '<>',
    'x'.repeat(2000) + '@example.com', null, undefined, 42, {}, ['a@example.com']]) {
    assert.equal(isReservedEmailAddress(value as unknown), false, String(value).slice(0, 40));
  }
});

test('the test-transport seam is explicit: only a marked fake skips the guard, and the real fetch can never be marked', () => {
  const fake = (async () => new Response('{}')) as unknown as typeof fetch;
  assert.equal(refusesReservedRecipient(fake, 'a@example.com'), true, 'an unmarked fake is guarded like the real network');
  assert.equal(refusesReservedRecipient(globalThis.fetch, 'a@example.com'), true);
  assert.equal(refusesReservedRecipient(undefined, 'a@example.com'), true);
  assert.equal(refusesReservedRecipient(allowReservedRecipientsForTestTransport(fake), 'a@example.com'), false);
  assert.throws(() => allowReservedRecipientsForTestTransport(globalThis.fetch), /real fetch/);
  assert.equal(refusesReservedRecipient(globalThis.fetch, 'a@example.com'), true);
});

test('no production source turns the guard off: the seam is used only by tests', () => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|mts|js|mjs)$/.test(name) && !full.endsWith(path.join('email-bounces', 'undeliverable.ts'))
        && readFileSync(full, 'utf8').includes('allowReservedRecipientsForTestTransport')) offenders.push(path.relative(root, full));
    }
  };
  walk(root);
  assert.deepEqual(offenders, []);
});

// ─── MHP marketing (built-in, owner emails, sequences) ───────────────────────

const mhpConfig = () => mhpMarketingConfig({ MHP_MARKETING_MODE: 'live', MHP_POSTMARK_SERVER_TOKEN: 'synthetic-token', MHP_MARKETING_FROM: 'owner@example.invalid' })!;
const rendered = { subject: 's', text: 't', html: '<p>t</p>', unsubscribe: 'https://app.martinhowardproperty.co.uk/email/unsubscribe?p=x' };

test('the MHP sender refuses a reserved address before Postmark, as a definite non-send that never stops the person', async () => {
  const net = counting();
  const sender = createMhpMarketingSender(mhpConfig(), secret, net.fetcher);
  for (const email of ['f3-live-pilot-20261101@example.invalid', 'Someone@Example.COM.']) {
    await assert.rejects(sender.sendRendered({ id: ids.send, email, tag: 'owner_sequence', prospectId: ids.prospect, rendered }),
      (error: unknown) => error instanceof EmailRecipientBlockedError && error.reason === 'reserved_address');
  }
  await assert.rejects(sender.sendRendered({ id: ids.send, email: 'owner@example.invalid', tag: 'owner_email_test', ownerTest: true, rendered }),
    (error: unknown) => error instanceof EmailRecipientBlockedError && error.reason === 'reserved_address', 'the owner\'s own test send is refused too');
  assert.equal(refusalStopsPerson('reserved_address'), false);
  assert.deepEqual(net.to, [], 'Postmark was never called');
  await sender.sendRendered({ id: ids.send, email: REAL, tag: 'owner_sequence', prospectId: ids.prospect, rendered });
  assert.deepEqual(net.to, [REAL], 'a real address still goes');
});

test('built-in sign-up emails to a reserved address are settled as not sent and the person is not stopped', async () => {
  const net = counting();
  const sender = createMhpMarketingSender(mhpConfig(), secret, net.fetcher);
  const item = (over: Partial<MhpClaimedSend>): MhpClaimedSend => ({ id: ids.send, prospectId: ids.prospect, template: 'webinar_90days', campaign: 'webinar-proof',
    context: { label: 'Webinar', link: 'https://martinhowardproperty.co.uk/webinar/' }, email: 'f3-live-pilot-20261101@example.invalid', firstName: 'Sam', level: null,
    attempts: 1, expiresAt: new Date(now + 86_400_000).toISOString(), ...over });
  const calls: string[] = []; let finished!: () => void; const done = new Promise<void>(resolve => { finished = resolve; });
  let claims = 0;
  const stop = startMhpMarketingDispatcher({ claim: async () => (claims++ === 0 ? [item({}), item({ id: ids.request, prospectId: ids.user, email: REAL })] : []),
    settle: async (id, accepted) => { calls.push(`settle ${id} ${accepted}`); if (calls.filter(c => c.startsWith('settle')).length === 2) finished(); } },
    sender, { testRecipients: null }, { intervalMs: 60_000, onBlocked: async prospectId => { calls.push(`stop ${prospectId}`); } });
  await done; stop();
  assert.deepEqual(calls, [`settle ${ids.send} false`, `settle ${ids.request} true`]);
  assert.deepEqual(net.to, [REAL]);
});

const lease = { id: ids.send, leaseId: ids.lease, leaseUntil: new Date(now + 120_000).toISOString() };
const prepared: MhpOwnerEmailPrepared = { ...lease, proofId: ids.proof, prospectId: ids.prospect, email: 'f3-live-pilot-20261101@example.invalid', firstName: 'Sam',
  context: { label: 'Webinar', link: 'https://martinhowardproperty.co.uk/webinar/' }, exact: { ...exact, approvalDecisionId: ids.approval } };

test('owner emails to a reserved address: one definite non-send, no stop, no Postmark call', async () => {
  const net = counting(); const calls: string[] = [];
  const queue: MhpOwnerEmailDispatch = { claim: async () => [lease], prepare: async () => prepared, settle: async (_l, accepted) => { calls.push(`settle ${accepted}`); } };
  const result = await dispatchMhpOwnerEmails({ queue, sender: createMhpMarketingSender(mhpConfig(), secret, net.fetcher), unsubscribeSecret: secret,
    testRecipients: null, now: () => now, onBlocked: async prospectId => { calls.push(`stop ${prospectId}`); } });
  assert.deepEqual(result, { sent: 0, failed: 1 });
  assert.deepEqual(calls, ['settle false']);
  assert.deepEqual(net.to, []);
});

test('sequences to a reserved address end as a definite rejection, never the unknown hold, and never stop the person', async () => {
  const net = counting(); const calls: string[] = [];
  const queue: MhpSequenceDispatch = { claim: async () => [lease], prepare: async () => prepared,
    settle: async (_l, accepted, reference) => { calls.push(`settle ${accepted} ${reference}`); }, unknown: async () => { calls.push('unknown'); } };
  const result = await dispatchMhpSequenceEmails({ queue, sender: createMhpMarketingSender(mhpConfig(), secret, net.fetcher), unsubscribeSecret: secret,
    testRecipients: null, now: () => now, onBlocked: async prospectId => { calls.push(`stop ${prospectId}`); } });
  assert.deepEqual(result, { sent: 0, failed: 1, unknown: 0 });
  assert.deepEqual(calls, ['settle false null']);
  assert.deepEqual(net.to, []);
});

// ─── MHP transactional (sign-in links, receipts) ─────────────────────────────

const transactionalEnv = { MHP_TRANSACTIONAL_PROVIDER: 'postmark', MHP_POSTMARK_SERVER_TOKEN: 'synthetic', MHP_POSTMARK_FROM: 'martin@propinvestuk.co.uk' };

test('a sign-in link to a reserved address is refused before Postmark; a real address still gets it', async () => {
  const net = counting(() => new Response('{}', { status: 200 }));
  const mailer = createMhpTransactionalMailer(transactionalEnv, net.fetcher);
  const url = `${MHP_AUTH_ORIGIN}/portal/auth/verify?t=x`;
  await assert.rejects(mailer.sendAuthLink('member@example.invalid', url, 'magic'), /reserved test address/);
  await assert.rejects(mailer.sendAccessInvite('member@example.com', 'Member', 'Course'));
  assert.deepEqual(net.to, []);
  await mailer.sendAuthLink(REAL, url, 'magic');
  assert.deepEqual(net.to, [REAL]);
});

test('a purchase welcome or kit receipt to a reserved address is a definite rejection, never unknown, and Postmark is not called', async () => {
  const net = counting();
  const mailer = createMhpTransactionalMailer(transactionalEnv, net.fetcher);
  await assert.rejects(mailer.sendPurchaseWelcome!('buyer@example.com', 'Buyer', 'Course', 'course'),
    (error: unknown) => error instanceof MhpWelcomeDeliveryError && error.outcome === 'rejected');
  await assert.rejects(mailer.sendKitReceipt!('buyer@x.test', 'Buyer', { kits: [{ name: 'Kit', module: 1 }], amountPence: 4900, paidAt: '2026-11-01T10:00:00Z', replay: false } as never),
    (error: unknown) => (error as { outcome?: string }).outcome === 'rejected');
  const settled: string[] = [];
  const job = { id: 'purchase', lease: 'lease', email: 'buyer@example.invalid', name: 'Buyer', productName: 'Course', kind: 'course' as const };
  const result = await dispatchMhpPurchaseWelcome({ billingEnabled: true, claimPurchaseWelcome: async () => job, beginPurchaseWelcome: async () => true,
    settlePurchaseWelcome: async (_job: unknown, outcome: string) => { settled.push(outcome); } } as never, mailer);
  assert.equal(result, 'rejected');
  assert.deepEqual(settled, ['rejected']);
  assert.deepEqual(net.to, []);
});

// ─── the generic Postmark client (setup links, delivery packs) ──────────────

test('the real Postmark client refuses a reserved address before any request', async () => {
  await assert.rejects(makePostmark('synthetic-token').send({ from: 'hello@relaunch72.com', to: 'customer@example.invalid', subject: 's', textBody: 't' }),
    (error: unknown) => error instanceof EmailError && /reserved test address/.test(error.message) && !error.message.includes('customer@'));
});

// ─── Property Predator follow-ups ────────────────────────────────────────────

const ppConfig = () => ppMarketingConfig({ PP_MARKETING_MODE: 'live', PP_POSTMARK_SERVER_TOKEN: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', PP_MARKETING_FROM: 'hello@propertypredator.com',
  PP_POSTMARK_BROADCAST_STREAM: 'pp-news', PORTAL_BASE_URL: 'https://hq.propertypredator.com', SESSION_SECRET: 'synthetic-pp-followup-secret-at-least-32-chars' }).config!;

test('the PP sender refuses a reserved address as a recipient refusal, before Postmark', async () => {
  const net = counting();
  const sender = createPpPostmarkSender(ppConfig(), net.fetcher);
  assert.equal(sender.refusesAddress?.('ann@example.com'), true);
  assert.equal(sender.refusesAddress?.(REAL), false);
  await assert.rejects(sender.sendRendered({ id: 'send-1', email: 'ann@example.com', tag: 'pp_followup', rendered }),
    (error: unknown) => error instanceof PpNotSentError && error.scope === 'recipient');
  assert.deepEqual(net.to, []);
  await sender.sendRendered({ id: 'send-2', email: REAL, tag: 'pp_followup', rendered });
  assert.deepEqual(net.to, [REAL]);
});

test('the PP dispatcher fails a run to a reserved address at once: undeliverable, no proof, no Postmark call, never unknown', async () => {
  const net = counting(); const calls: string[] = [];
  const leaseFor = { id: '4d7fa05e-6b3a-4e9c-9f4d-3c4d5e6f7081', leaseId: '5e80b16f-7c4b-4fad-a05e-4d5e6f708192', leaseUntil: new Date(Date.now() + 120_000).toISOString(),
    email: 'pilot@example.invalid' };
  const queue: PpFollowupQueue = { claim: async () => [leaseFor], prepare: async () => { calls.push('prepare'); return null as unknown as PpFollowupPrepared; },
    settle: async (_l: unknown, outcome: string) => { calls.push(`settle:${outcome}`); }, unknown: async () => { calls.push('unknown'); } } as unknown as PpFollowupQueue;
  const result = await dispatchPpFollowupEmails({ queue, sender: createPpPostmarkSender(ppConfig(), net.fetcher), unsubscribeSecret: 'synthetic-pp-followup-secret-at-least-32-chars',
    config: { testRecipients: null, link: 'https://propertypredator.com/', unsubscribeOrigin: 'https://hq.propertypredator.com', fromName: 'Property Predator' } });
  assert.deepEqual(result, { sent: 0, failed: 1, unknown: 0 });
  assert.deepEqual(calls, ['settle:undeliverable']);
  assert.deepEqual(net.to, []);
});

// ─── webinar event emails ────────────────────────────────────────────────────

test('the webinar Postmark mailer refuses a reserved address as a permanent rejection without calling Postmark', async () => {
  const net = counting();
  const mailer = createPostmarkMailer(net.fetcher);
  const sender = { from: 'Martin <martin@propinvestuk.co.uk>', token: 'synthetic', messageStream: 'outbound' } as WebinarSender;
  const message = { subject: 's', text: 't', html: '<p>t</p>' };
  assert.equal(mailer.refusesAddress?.('ann@example.test'), true, 'the worker asks this and settles the job as blocked before any attempt');
  assert.equal(mailer.refusesAddress?.(REAL), false);
  assert.deepEqual(await mailer.send(sender, 'ann@example.test', message, {}), { outcome: 'rejected', detail: RESERVED_ADDRESS_BLOCK_REASON });
  assert.deepEqual(net.to, []);
  assert.equal((await mailer.send(sender, REAL, message, {})).outcome, 'sent');
  assert.deepEqual(net.to, [REAL]);
});

// ─── owner page ──────────────────────────────────────────────────────────────

function snapshotWith(...emails: string[]) {
  const registry = new EmailBlockRegistry(() => now); registry.markReady();
  emails.forEach((email, index) => registry.record(WS, { sourceKey: 'mhp', stream: 'broadcast', id: `bounce:${index}`, kind: 'hard_bounce', email, at: now - 86_400_000 } as EmailFact));
  return registry.snapshot(WS);
}

test('the email health page explains reserved test addresses under the list only when one is listed', () => {
  const shown = emailHealthPage(snapshotWith('f3-live-pilot-20261101@example.invalid', 'gone@gmail.com'), 'csrf');
  assert.ok(shown.includes(`<p class="note">${RESERVED_ADDRESS_NOTE}</p>`));
  assert.equal(RESERVED_ADDRESS_NOTE, 'Addresses at example.com, or ending in .invalid or .test, are test addresses, not real people. We no longer send to them at all.');
  assert.ok(shown.indexOf('</table>') < shown.indexOf(RESERVED_ADDRESS_NOTE), 'the sentence sits under the list');
  assert.ok(!emailHealthPage(snapshotWith('gone@gmail.com'), 'csrf').includes(RESERVED_ADDRESS_NOTE));
  assert.ok(!emailHealthPage(snapshotWith(), 'csrf').includes(RESERVED_ADDRESS_NOTE));
  assert.ok(!emailHealthPage(snapshotWith('gone@myexample.com'), 'csrf').includes(RESERVED_ADDRESS_NOTE));
});

test('a hostile reserved address on the list stays escaped beside the sentence', () => {
  const html = emailHealthPage(snapshotWith('"<script>x</script>"@example.invalid'), 'csrf');
  assert.ok(html.includes(RESERVED_ADDRESS_NOTE));
  assert.ok(!html.includes('<script>x</script>'));
});

test('a crafted label the converter rejects cannot hide a reserved ending; ordinary domains stay ordinary', () => {
  for (const reserved of ['a@xn--abc.test', 'a@xn--a.invalid', 'a@xn--abc.example.com', 'A@XN--ABC.EXAMPLE.ORG.']) {
    assert.equal(isReservedEmailAddress(reserved), true, reserved);
  }
  for (const real of ['a@xn--abc.co.uk', 'a@xn--bcher-kva.de', 'jo@myexample.com', 'jo@example.co.uk']) {
    assert.equal(isReservedEmailAddress(real), false, real);
  }
});
