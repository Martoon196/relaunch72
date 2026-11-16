/**
 * /portal/email as one guided path: every state the service can be in, with every message the page can show there,
 * has exactly one primary (filled) button; every button a visible sentence tells the owner to press is on the page;
 * and none of the words DNS, TXT, CNAME, DKIM or Return-Path appears in running text (only in a record's own Type
 * field, a host's own menu names quoted from their site, and the message written for whoever looks after the website).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EMAIL_CONNECT_BUSINESSES, EMAIL_CONNECTION_MESSAGES, EMAIL_TERMS_VERSION } from '../src/email-connections/index.js';
import { renderEmailConnectionPage, type EmailConnectionPageInput } from '../src/portal/email-connection-view.js';
import { bannerFor, SENDING_MESSAGES, type OwnerSendingView } from '../src/email-protection/owner.js';
import { emailEntryStatus, emailStepNow, renderEmailEntryCard } from '../src/portal/email-connection-progress.js';
import { counts } from './email-protection-fixtures.js';

const business = EMAIL_CONNECT_BUSINESSES[0]!;
const terms = { version: EMAIL_TERMS_VERSION, acceptedAt: '2026-11-14T10:12:00Z', acceptedByName: 'Pat Owner' };
const dns = (dkim: boolean, rp: boolean) => ({ dkim: { host: '2026pm._domainkey.pp-guided.co.uk', value: 'k=rsa; p=KEY', verified: dkim },
  returnPath: { host: 'pm-3fa91c07d2.pp-guided.co.uk', value: 'pm.mtasv.net', verified: rp }, origin: 'created' as const });
const protection = (over: Record<string, unknown> = {}) => ({ state: 'ok', reason: null, since: null, dailyCap: 50, hourlyCap: 13, warmupStartedAt: null, ...over });
const state = (over: Record<string, unknown> = {}) => ({ status: 'not_connected', step: null, domain: null, fromName: null, fromAddress: null, replyTo: null, serverId: null, domainId: null,
  stream: null, webhookId: null, hasServerToken: false, hasWebhookSecret: false, mode: 'off', dns: null, verifiedAt: null, rowVersion: 1, protection: protection(), terms: null,
  goLiveApprovedAt: null, domainAttempted: false, ...over }) as never;
const addr = { domain: 'pp-guided.co.uk', fromName: 'PP Guided', fromAddress: 'hello@pp-guided.co.uk', terms };
const pending = (d = false, r = false, over: Record<string, unknown> = {}) => state({ ...addr, status: 'dns_pending', dns: dns(d, r), serverId: 1, domainId: 2, stream: 'broadcast', webhookId: 3, ...over });
const verified = (over: Record<string, unknown> = {}) => state({ ...addr, status: 'verified', dns: dns(true, true), serverId: 1, domainId: 2, stream: 'broadcast', webhookId: 3, verifiedAt: '2026-11-14T11:00:00Z', ...over });
const sendingState = (over: Record<string, unknown> = {}) => ({ defaultTestEmail: 'pat@pp-guided.co.uk', ownerEmailCount: 1, testCurrent: false, approvedCurrent: false, lastOwnerAlert: null,
  businessName: null, postalAddress: null, testRecipients: [], testPassedAt: null, ownerPausedAt: null, goLiveRequestedAt: null, goLiveApprovedAt: null, sampleState: 'none', warmupStep: 0,
  accountHeld: false, lastStep: null, counts: counts({ mode: 'off' }), days: [], ...over }) as never;
const footer = { businessName: 'PP Guided Ltd', postalAddress: '1 High Street, Leeds LS1 1AA' };
const sending = (connection: never, over: Record<string, unknown> = {}, willEmail = true): OwnerSendingView => {
  const s = sendingState(over);
  return { offered: true, sending: s, banner: bannerFor(connection, s, { mailer: willEmail, allowed: true }), testList: ['pat@pp-guided.co.uk'], bounced: [{ email: 'gone@pp-guided.co.uk', since: 'x' }], willEmail };
};
const view = (s: never, extra: Record<string, unknown> = {}) => ({ offered: true, business, state: s, dnsHost: null, ...extra }) as never;
const base = { csrf: 'c', commandId: '6f0d8f2a-3b1c-4d5e-8f90-123456789abc' };
const bad = (text: string) => ({ text, ok: false }), good = (text: string) => ({ text, ok: true });

type Case = readonly [string, EmailConnectionPageInput];
const cases: Case[] = [];
const add = (name: string, input: Omit<EmailConnectionPageInput, 'csrf' | 'commandId'>, messages: readonly ({ text: string; ok: boolean } | undefined)[] = [undefined]) => {
  for (const message of messages) cases.push([`${name}${message ? `: ${message.text.slice(0, 50)}` : ''}`, { ...base, ...input, ...(message ? { message } : {}) }]);
};

// Steps 1 and 2.
add('step 1', { view: view(state()) }, [undefined, good(EMAIL_CONNECTION_MESSAGES.disconnected), bad(EMAIL_CONNECTION_MESSAGES.nothingToContinue)]);
add('step 1 refused (no tick)', { view: view(state()), form: { fromName: 'PP', fromAddress: 'hello@pp-guided.co.uk', replyTo: '' } }, [bad(EMAIL_CONNECTION_MESSAGES.termsFirst)]);
add('step 2', { view: view(state({ status: 'disconnected' })), agreed: true }, [undefined, bad(EMAIL_CONNECTION_MESSAGES.needName), bad(EMAIL_CONNECTION_MESSAGES.needFrom),
  bad(EMAIL_CONNECTION_MESSAGES.needReplyTo), bad(EMAIL_CONNECTION_MESSAGES.freeMailbox('gmail.com')), bad(EMAIL_CONNECTION_MESSAGES.reservedDomain),
  bad(EMAIL_CONNECTION_MESSAGES.publicSuffix), bad(EMAIL_CONNECTION_MESSAGES.domainTaken), bad(EMAIL_CONNECTION_MESSAGES.locked)]);
// Step 3, setting up (creating / needs_attention), every failure the run can report.
for (const status of ['creating', 'needs_attention']) {
  add(`setting up (${status})`, { view: view(state({ ...addr, status, step: 'webhook' })) }, [undefined, bad(EMAIL_CONNECTION_MESSAGES.busy), bad(EMAIL_CONNECTION_MESSAGES.locked),
    bad(EMAIL_CONNECTION_MESSAGES.awaitingApproval), bad(EMAIL_CONNECTION_MESSAGES.unfinished), bad(EMAIL_CONNECTION_MESSAGES.interrupted),
    bad(EMAIL_CONNECTION_MESSAGES.planLimit + EMAIL_CONNECTION_MESSAGES.logged), bad(EMAIL_CONNECTION_MESSAGES.planLimit + EMAIL_CONNECTION_MESSAGES.tryLater),
    bad(EMAIL_CONNECTION_MESSAGES.needsHand + EMAIL_CONNECTION_MESSAGES.logged), bad(EMAIL_CONNECTION_MESSAGES.notAvailable + EMAIL_CONNECTION_MESSAGES.tryLater),
    bad(EMAIL_CONNECTION_MESSAGES.webhookUnreachable), bad(EMAIL_CONNECTION_MESSAGES.freeMailbox('pp-guided.co.uk'))]);
}
add('domain clash, founder', { view: view(state({ ...addr, status: 'needs_attention', step: 'domain' })), offerTakeOver: true }, [bad(EMAIL_CONNECTION_MESSAGES.founderTakeOver)]);
add('domain clash, customer', { view: view(state({ ...addr, status: 'needs_attention', step: 'domain' })), clash: true, agreed: true }, [bad(EMAIL_CONNECTION_MESSAGES.domainInUse)]);
// Step 3, the records.
for (const [d, r] of [[false, false], [true, false], [false, true]] as const) {
  for (const dnsHost of ['cloudflare', 'godaddy', 'namecheap', '123-reg', 'ionos', 'other', null]) {
    add(`records ${Number(d) + Number(r)} found (${dnsHost})`, { view: view(pending(d, r), { dnsHost }) }, [undefined, good(EMAIL_CONNECTION_MESSAGES.started),
      bad(EMAIL_CONNECTION_MESSAGES.checkNone), bad(EMAIL_CONNECTION_MESSAGES.checkOne(d ? 'CNAME' : 'TXT')), bad(EMAIL_CONNECTION_MESSAGES.checkMismatch('TXT')),
      bad(EMAIL_CONNECTION_MESSAGES.checkMismatch('CNAME')), bad(EMAIL_CONNECTION_MESSAGES.busy), bad(EMAIL_CONNECTION_MESSAGES.wrongDomain), bad(EMAIL_CONNECTION_MESSAGES.alreadyConnected),
      good(EMAIL_CONNECTION_MESSAGES.repaired), good(EMAIL_CONNECTION_MESSAGES.bounceWorkingCheck), good(EMAIL_CONNECTION_MESSAGES.bounceRemade), good(EMAIL_CONNECTION_MESSAGES.bounceRemadeLive)]);
  }
}
add('records both found', { view: view(pending(true, true), { dnsHost: 'cloudflare' }) }, [good(EMAIL_CONNECTION_MESSAGES.startedFound), good(EMAIL_CONNECTION_MESSAGES.bounceRemade)]);
add('records, bounce repair offered', { view: view(pending(true, true)), offerBounceRepair: true }, [bad(EMAIL_CONNECTION_MESSAGES.bounceStillFailing), bad(EMAIL_CONNECTION_MESSAGES.bounceUnclear),
  bad(EMAIL_CONNECTION_MESSAGES.bounceNotSaved), bad(EMAIL_CONNECTION_MESSAGES.busy)]);
add('records, no records saved yet', { view: view(pending(false, false, { dns: null })) }, [undefined]);
add('records, outdated rules', { view: view(pending(false, true, { terms: { ...terms, version: 'old' } })) }, [bad(EMAIL_CONNECTION_MESSAGES.termsFirst)]);
add('secrets unreadable (records)', { view: view(pending(false, true), { repair: true }) }, [undefined, good(EMAIL_CONNECTION_MESSAGES.autoCheckNeedsRepair)]);
add('secrets unreadable (connected)', { view: view(verified(), { repair: true }) }, [undefined, bad(SENDING_MESSAGES.testKeyUnreadable)]);
add('connected, release 1 only', { view: view(verified()) }, [good(EMAIL_CONNECTION_MESSAGES.checkBoth), good(EMAIL_CONNECTION_MESSAGES.connectedNext)]);
// Steps 4 and 5, and live.
const c = verified();
const step4 = [undefined, good(EMAIL_CONNECTION_MESSAGES.checkBoth), bad(SENDING_MESSAGES.needBusinessName), bad(SENDING_MESSAGES.needPostalAddress), bad(SENDING_MESSAGES.needTestList),
  bad(SENDING_MESSAGES.testNoAddress), bad(SENDING_MESSAGES.testLimit), bad(SENDING_MESSAGES.testRefusedSender), bad(SENDING_MESSAGES.testReplayedRefused),
  bad(SENDING_MESSAGES.testRefusedRecipient('pat@pp-guided.co.uk')), bad(SENDING_MESSAGES.testReserved('a@b.invalid')), bad(SENDING_MESSAGES.testUnknown), bad(SENDING_MESSAGES.busy),
  bad(SENDING_MESSAGES.notFromHere), good(SENDING_MESSAGES.test)];
add('step 4, no footer', { view: view(c), sending: sending(c) }, step4);
add('step 4, footer, no test', { view: view(c), sending: sending(c, footer) }, step4);
add('step 4, after the test', { view: view(c), sending: sending(c, { ...footer, testCurrent: true }), testSent: true }, [good(SENDING_MESSAGES.testSent), good(SENDING_MESSAGES.testReplayed)]);
add('step 5', { view: view(c), sending: sending(c, { ...footer, testCurrent: true }) }, [undefined, good(SENDING_MESSAGES.detailsSaved), good(EMAIL_CONNECTION_MESSAGES.bounceWorking),
  good(EMAIL_CONNECTION_MESSAGES.bounceRepaired), bad(SENDING_MESSAGES.needsTerms), bad(SENDING_MESSAGES.needsFooter), bad(SENDING_MESSAGES.needsTest), good(SENDING_MESSAGES.unchanged)]);
add('step 5 testing', { view: view(verified({ mode: 'test' })), sending: sending(verified({ mode: 'test' }), { ...footer, testCurrent: true }) }, [good(SENDING_MESSAGES.test)]);
add('step 5 go-live refused (bounce reporting)', { view: view(c), sending: sending(c, { ...footer, testCurrent: true }), offerBounceRepair: true }, [bad(SENDING_MESSAGES.needsWebhook),
  bad(EMAIL_CONNECTION_MESSAGES.bounceStillFailing), bad(EMAIL_CONNECTION_MESSAGES.bounceUnclear), bad(EMAIL_CONNECTION_MESSAGES.bounceNotSaved), bad(EMAIL_CONNECTION_MESSAGES.busy)]);
for (const willEmail of [true, false]) {
  add(`waiting for approval (email ${willEmail})`, { view: view(c), sending: sending(c, { ...footer, testCurrent: true, goLiveRequestedAt: '2026-11-16T09:41:00Z' }, willEmail) },
    [undefined, good(willEmail ? SENDING_MESSAGES.requested : SENDING_MESSAGES.requestedNoEmail)]);
}
const liveOver = { ...footer, testCurrent: true, approvedCurrent: true, goLiveApprovedAt: '2026-11-16T10:00:00Z' };
const live = (p: Record<string, unknown> = {}) => verified({ mode: 'live', goLiveApprovedAt: '2026-11-16T10:00:00Z', protection: protection(p) });
add('live', { view: view(live()), sending: sending(live(), liveOver) }, [undefined, good(SENDING_MESSAGES.live), good(SENDING_MESSAGES.resumed), good(SENDING_MESSAGES.testSent),
  good(LIFT('x')), bad(SENDING_MESSAGES.notFromHere)]);
add('live, first emails', { view: view(live()), sending: sending(live(), { ...liveOver, sampleState: 'sending' }) });
add('live, own pause', { view: view(live()), sending: sending(live(), { ...liveOver, ownerPausedAt: '2026-11-17T00:00:00Z' }) }, [good(SENDING_MESSAGES.paused)]);
add('live, slowed', { view: view(live({ state: 'slowed', dailyCap: 25 })), sending: sending(live({ state: 'slowed', dailyCap: 25 }), { ...liveOver,
  lastStep: { kind: 'slowed', at: 'x', line: 'complaints', count: 2, total: 300, limit: 2, days: 30 } }) });
add('live, paused by protection', { view: view(live({ state: 'paused', dailyCap: 0 })), sending: sending(live({ state: 'paused', dailyCap: 0 }), { ...liveOver,
  lastStep: { kind: 'paused', at: 'x', line: 'bounce_rate', count: 6, total: 120, limit: 4, days: 7 } }) }, [undefined, bad(SENDING_MESSAGES.protectionPaused),
  good(SENDING_MESSAGES.resumedStillHeld('Your marketing emails are still paused by our protection; only we can restart them.'))]);
add('live, switched off', { view: view(live({ state: 'off', dailyCap: 0 })), sending: sending(live({ state: 'off', dailyCap: 0 }), { ...liveOver,
  lastStep: { kind: 'switched_off', at: 'x', line: 'hard_last50', count: 5, total: 50, limit: 5 } }) }, [undefined, bad(SENDING_MESSAGES.switchedOff), bad(SENDING_MESSAGES.testOff)]);
add('live, account held', { view: view(live()), sending: sending(live(), { ...liveOver, accountHeld: true }) });
add('live, list held', { view: view(live()), sending: sending(live(), { ...liveOver, sampleState: 'held', lastStep: { kind: 'sample_held', at: 'x', line: 'sample', count: 2, total: 50, limit: 1 } }) });
add('live, new domain needs approval', { view: view(live()), sending: sending(live(), { ...liveOver, approvedCurrent: false }) });
add('live, reconnected needs a test', { view: view(live()), sending: sending(live(), { ...liveOver, testCurrent: false }) });
add('in charge but not connected', { view: view(pending(true, false, { mode: 'live' })), sending: sending(pending(true, false, { mode: 'live' }), liveOver) });
function LIFT(address: string) { return `We no longer block ${address}.`; }

// Round 2: the owner's own pause on every sending screen, and the states the review found.
const pausedAt = { ownerPausedAt: '2026-11-17T00:00:00Z' };
const testMode = verified({ mode: 'test' });
add('owner paused, test mode, step 4', { view: view(testMode), sending: sending(testMode, { ...footer, ...pausedAt }) }, [undefined, good(SENDING_MESSAGES.paused)]);
add('owner paused, test mode, step 5', { view: view(testMode), sending: sending(testMode, { ...footer, testCurrent: true, ...pausedAt }) }, [undefined, good(SENDING_MESSAGES.paused)]);
add('owner paused, step 4 after the test', { view: view(testMode), sending: sending(testMode, { ...footer, testCurrent: true, ...pausedAt }), testSent: true }, [good(SENDING_MESSAGES.testSent)]);
add('owner paused, waiting for approval', { view: view(testMode), sending: sending(testMode, { ...footer, testCurrent: true, goLiveRequestedAt: '2026-11-16T09:41:00Z', ...pausedAt }) });
add('owner paused, after Back to testing (was live)', { view: view(verified({ mode: 'test', goLiveApprovedAt: '2026-11-16T10:00:00Z' })),
  sending: sending(verified({ mode: 'test', goLiveApprovedAt: '2026-11-16T10:00:00Z' }), { ...liveOver, ...pausedAt }) }, [good(SENDING_MESSAGES.test)]);
add('owner paused, go live refused for bounce reporting', { view: view(testMode), sending: sending(testMode, { ...footer, testCurrent: true, ...pausedAt }), offerBounceRepair: true }, [bad(SENDING_MESSAGES.needsWebhook)]);
add('owner paused, live, repair offered', { view: view(live()), sending: sending(live(), { ...liveOver, ...pausedAt }), offerBounceRepair: true });
add('switched off, with the details form', { view: view(live({ state: 'off', dailyCap: 0 })), sending: sending(live({ state: 'off', dailyCap: 0 }), { ...liveOver,
  lastStep: { kind: 'switched_off', at: 'x', line: 'hard_last50', count: 5, total: 50, limit: 5 } }) }, [good(SENDING_MESSAGES.detailsSaved)]);
add('secrets unreadable, live and paused', { view: view(live(), { repair: true }), sending: sending(live(), { ...liveOver, ...pausedAt }) }, [undefined, bad(SENDING_MESSAGES.testKeyUnreadable)]);
add('secrets unreadable, test mode', { view: view(testMode, { repair: true }), sending: sending(testMode, { ...footer, testCurrent: true }) });
add('waiting, but a fresh test is needed (step 4)', { view: view(c), sending: sending(c, { ...footer, goLiveRequestedAt: '2026-11-16T09:41:00Z' }) });

// The reviewer's walk: every combination of mode, protection, footer, test, approval, request and the owner's pause,
// plain and with each page variant.
const walked: Case[] = [];
for (const mode of ['off', 'test', 'live'] as const) for (const p of ['ok', 'slowed', 'paused', 'off'] as const) for (const hasFooter of [false, true]) for (const testCurrent of [false, true])
  for (const approved of [false, true]) for (const requested of [false, true]) for (const ownerPaused of [false, true]) {
    if (approved && requested) continue;
    const conn = verified({ mode, protection: protection({ state: p, dailyCap: p === 'paused' || p === 'off' ? 0 : 50 }), goLiveApprovedAt: approved ? '2026-11-16T10:00:00Z' : null });
    const over = { ...(hasFooter ? footer : {}), testCurrent, approvedCurrent: approved, goLiveApprovedAt: approved ? 'x' : null, goLiveRequestedAt: requested ? '2026-11-16T09:41:00Z' : null,
      ...(ownerPaused ? pausedAt : {}) };
    const name = `walk mode=${mode} prot=${p} footer=${+hasFooter} test=${+testCurrent} approved=${+approved} requested=${+requested} ownerPaused=${+ownerPaused}`;
    for (const [variant, extra] of [['', {}], [' + repair offered', { offerBounceRepair: true }], [' + test just sent', { testSent: true }]] as const)
      walked.push([name + variant, { ...base, view: view(conn), sending: sending(conn, over), ...extra }]);
    walked.push([`${name} + secrets unreadable`, { ...base, view: view(conn, { repair: true }), sending: sending(conn, over) }]);
  }
cases.push(...walked);

/** Every button the page can show (a sentence may only tell the owner to press one of these, and it must be rendered). */
const LABELS = ['Next: your address', 'Check for the answer', 'Connect with these details', 'Connect', 'Continue', 'Use this domain', 'Use different details', 'Check again', 'Check', 'Repair bounce reporting', 'Repair',
  'Start again', 'Disconnect', 'Save and send me a test', 'Save', 'Send a test to me', 'Send it again', 'Yes, go to the last step', 'Go live', 'Check for the answer', 'Start testing',
  'Back to testing', 'Pause', 'Resume', 'Open your follow-ups', 'Back to Growth HQ', 'This address works now'];

const visible = (html: string) => html.replace(/<head>[^]*?<\/head>/u, '').replace(/<[^>]+>/gu, ' ').replace(/&#39;/gu, '\'').replace(/&quot;/gu, '"').replace(/&lt;/gu, '<').replace(/&gt;/gu, '>').replace(/&amp;/gu, '&').replace(/\s+/gu, ' ');
const withoutExempt = (html: string) => html.replace(/<div class="field" data-type-field>[^]*?<\/div>/gu, '').replace(/<span class="ui-name">[^<]*<\/span>/gu, '').replace(/<div data-for-helper>[^]*?<\/div>/gu, '');
const primaries = (html: string) => (html.match(/<button type="submit">/gu) ?? []).length + (html.match(/<a class="button"/gu) ?? []).length;
const rendered = (html: string) => new Set([...html.matchAll(/<button[^>]*>([^<]+)<\/button>/gu), ...html.matchAll(/<a class="button[^"]*"[^>]*>([^<]+)<\/a>/gu)].map(m => visible(m[1]!).trim()));

test('every state and message: exactly one primary button, every button a sentence names is on the page, no jargon in running text', () => {
  assert.ok(cases.length > 200, `walked ${cases.length} states`);
  for (const [name, input] of cases) {
    const html = renderEmailConnectionPage(input);
    assert.equal(primaries(html), 1, `${name}: exactly one primary button`);
    const shown = rendered(html);
    const text = visible(withoutExempt(html).replace(/<span class="ui-name">[^<]*<\/span>/gu, ''));
    // "press X" and "Press X", "presses", "pressing": the control's name starts with a capital.
    for (const match of text.matchAll(/\b[Pp]ress(?:ing|es)? ((?:the )?[A-Z][^.;:,(]*)/gu)) {
      const named = match[1]!.replace(/^the /u, '');
      const candidates = LABELS.filter(label => named.startsWith(label));
      assert.ok(candidates.length, `${name}: "${match[0]}" names a known button`);
      assert.ok(candidates.some(label => shown.has(label)), `${name}: "${match[0]}" names a button that is on the page (${[...shown].join(' | ')})`);
    }
    const jargon = visible(withoutExempt(html)).match(/\b(?:DNS|TXT|CNAME|DKIM)\b|Return-Path/iu);
    assert.equal(jargon, null, `${name}: no jargon in running text (${jargon?.[0]})`);
    // The record's own Type field is exact.
    if (/data-type-field/u.test(html)) assert.match(html, /data-type-field><span class="label">Type<\/span><code>(?:TXT|CNAME)<\/code>/u, name);
  }
});

test('the progress strip: exactly one step is "now" (or every step done when live), and the step names are the five steps', () => {
  for (const [name, input] of cases) {
    const html = renderEmailConnectionPage(input);
    const now = (html.match(/aria-current="step"/gu) ?? []).length, done = (html.match(/<li class="done"/gu) ?? []).length;
    // A database without sending controls: steps 1 to 3 done and nothing "now" (nothing is needed from the owner).
    const held = /release 1 only/u.test(name);
    assert.ok(held ? now === 0 && done === 3 : now === 1 || done === 5, `${name}: one step now, or all done`);
    for (const step of ['1 Email rules', '2 Your address', '3 Your domain', '4 Send yourself a test', '5 Go live']) assert.ok(html.includes(`<strong>${step}</strong>`), `${name}: ${step}`);
  }
});

test('the status card for the home and follow-ups pages: not started, step N of 5 (landing on the step), live', () => {
  const at = (s: never, sv?: OwnerSendingView) => emailEntryStatus(view(s), sv);
  assert.deepEqual(at(state()), { kind: 'not_started' });
  assert.deepEqual(at(pending()), { kind: 'in_progress', step: 3 });
  assert.deepEqual(at(c, sending(c)), { kind: 'in_progress', step: 4 });
  assert.deepEqual(at(c, sending(c, { ...footer, testCurrent: true })), { kind: 'in_progress', step: 5 });
  assert.deepEqual(at(live(), sending(live(), liveOver)), { kind: 'live' });
  assert.equal(emailEntryStatus({ offered: false, message: 'off' }, null), null);
  assert.equal(emailStepNow(view(state()), null, true), 2);
  assert.match(renderEmailEntryCard({ kind: 'not_started' }), /Connect your email \(about 5 minutes\)[^]*<a class="button" href="\/portal\/email">Connect email<\/a>/u);
  assert.match(renderEmailEntryCard({ kind: 'in_progress', step: 3 }), /Finish connecting your email: step 3 of 5[^]*href="\/portal\/email#email-step"/u);
  assert.match(renderEmailEntryCard({ kind: 'live' }), /Email connected ✓/u);
});

const rendersAction = (html: string, name: string) => new RegExp(`action="/portal/email/${name}"`, 'u').test(html);

test('the owner\'s own pause: Resume is on every sending screen while paused, and Pause is offered in test or live mode', () => {
  for (const [name, input] of cases) {
    const s = input.sending?.sending, conn = input.view.offered ? input.view.state : null;
    if (!s || !conn || conn.status !== 'verified' || conn.protection.state === 'off') continue;
    const html = renderEmailConnectionPage(input);
    if (s.ownerPausedAt) assert.ok(rendersAction(html, 'resume') && />Resume</u.test(html), `${name}: Resume is on the page`);
    else if (conn.mode !== 'off') assert.ok(rendersAction(html, 'pause'), `${name}: Pause is on the page (on the live card or under More options)`);
  }
  // Paused at step 5 in test mode (Back to testing from live): Go live stays the one primary, Resume is right in the card.
  const back = verified({ mode: 'test', goLiveApprovedAt: '2026-11-16T10:00:00Z' });
  const html = renderEmailConnectionPage({ ...base, view: view(back), sending: sending(back, { ...footer, testCurrent: true, approvedCurrent: true, goLiveApprovedAt: 'x', ...pausedAt }) });
  assert.match(html, /You have paused your marketing emails[^]*<button type="submit" class="secondary">Resume<\/button>[^]*<button type="submit">Go live<\/button>/u);
  // Waiting and paused: Resume is the one primary.
  const waiting = renderEmailConnectionPage({ ...base, view: view(testMode), sending: sending(testMode, { ...footer, testCurrent: true, goLiveRequestedAt: '2026-11-16T09:41:00Z', ...pausedAt }) });
  assert.match(waiting, /<button type="submit">Resume<\/button>/u);
  assert.match(waiting, /<a class="button secondary" href="\/portal\/email">Check for the answer<\/a>/u);
});

test('step 2 says the rules are agreed by pressing Connect; the strip says nothing untrue before then', () => {
  const html = renderEmailConnectionPage({ ...base, view: view(state()), agreed: true });
  assert.match(html, /<p class="agree-line">By pressing Connect you agree to our email rules\. <a href="\/portal\/email">Read the rules again<\/a><\/p>\s*<button type="submit">Connect<\/button>/u);
  assert.match(html, /Read: you agree when you press Connect\./u);
  assert.doesNotMatch(html, /You ticked the email rules/u);
});

test('states that keep what the old page had: switched off keeps the details form; unreadable secrets keep the sending controls', () => {
  const off = live({ state: 'off', dailyCap: 0 });
  let html = renderEmailConnectionPage({ ...base, view: view(off), sending: sending(off, liveOver) });
  assert.ok(rendersAction(html, 'details'), 'switched off: Change your business details');
  assert.doesNotMatch(html, /test-send|go-live/u, 'and still nothing to send');
  html = renderEmailConnectionPage({ ...base, view: view(live(), { repair: true }), sending: sending(live(), { ...liveOver, ...pausedAt }) });
  assert.deepEqual((html.match(/<button type="submit">([^<]+)<\/button>/gu) ?? []), ['<button type="submit">Repair</button>']);
  for (const name of ['resume', 'details', 'works-now']) assert.ok(rendersAction(html, name), `secrets unreadable: ${name}`);
  html = renderEmailConnectionPage({ ...base, view: view(live(), { repair: true }), sending: sending(live(), liveOver) });
  assert.ok(rendersAction(html, 'pause'), 'secrets unreadable, not paused: Pause');
});

test('smaller truths: no "You are here" without sending controls; waiting shows on any step card; several test addresses', () => {
  let html = renderEmailConnectionPage({ ...base, view: view(c) });
  assert.doesNotMatch(html, /You are here/u);
  assert.match(html, /Nothing else is needed from you right now/u);
  html = renderEmailConnectionPage({ ...base, view: view(c), sending: sending(c, { ...footer, goLiveRequestedAt: '2026-11-16T09:41:00Z' }) });
  assert.match(html, /<h2>Send yourself a test<\/h2>/u);
  assert.match(html, /waiting for the platform owner’s approval/u);
  const several = { ...sending(c, footer), testList: ['a@pp-guided.co.uk', 'b@pp-guided.co.uk'] };
  html = renderEmailConnectionPage({ ...base, view: view(c), sending: several });
  assert.match(html, /send a test email to each address \(a@pp-guided\.co\.uk, b@pp-guided\.co\.uk\)/u);
  assert.doesNotMatch(html, /one test email to you/u);
});

test('the status card\'s light read: one query, a 300 ms limit, a plain link on anything slow or failing, and true words when live', async () => {
  const { readEmailEntry, emailEntryFromLight, EMAIL_ENTRY_TIMEOUT_MS } = await import('../src/portal/email-connection-progress.js');
  const { OwnerSendingService } = await import('../src/email-protection/owner.js');
  const { MemoryProtectionStore } = await import('./email-protection-fixtures.js');
  const { MemoryEmailConnectionStore, PP_WS } = await import('./email-connections-fixtures.js');
  assert.equal(EMAIL_ENTRY_TIMEOUT_MS, 300);
  const config = (over: Record<string, unknown> = {}) => ({ workspaceId: PP_WS, status: 'verified', mode: 'live', serverId: 1, stream: 'broadcast', sealedServerToken: 'x', fromName: 'P',
    fromAddress: 'hello@pp-guided.co.uk', replyTo: null, businessName: 'B Ltd', postalAddress: '1 High Street, Leeds', testRecipients: [], protectionState: 'ok', protectionReason: null,
    ownerPaused: false, sampleState: 'passed', dailyCap: 50, hourlyCap: 13, accountHeld: false, liveDay: 0, liveHour: 0, goLiveRequestedAt: null, goLiveApprovedAt: 'x', approvedCurrent: true,
    testCurrent: true, lastStep: null, ...over }) as never;
  // The words: live, paused (by the owner or by protection), off; never "step 4 of 5" for a connected business whose sending can't be read.
  assert.deepEqual(emailEntryFromLight({ config: config() }), { kind: 'live' });
  assert.deepEqual(emailEntryFromLight({ config: config({ ownerPaused: true }) }), { kind: 'live', note: 'paused' });
  assert.deepEqual(emailEntryFromLight({ config: config({ protectionState: 'paused' }) }), { kind: 'live', note: 'paused' });
  assert.deepEqual(emailEntryFromLight({ config: config({ protectionState: 'off' }) }), { kind: 'live', note: 'off' });
  assert.deepEqual(emailEntryFromLight({ config: config({ testCurrent: false }) }), { kind: 'in_progress', step: 4 });
  assert.deepEqual(emailEntryFromLight({ config: config({ mode: 'test' }) }), { kind: 'in_progress', step: 5 });
  assert.deepEqual(emailEntryFromLight({ config: config({ status: 'dns_pending' }) }), { kind: 'in_progress', step: 3 });
  assert.deepEqual(emailEntryFromLight({ config: null }), { kind: 'not_started' });
  assert.equal(emailEntryFromLight({ config: 'absent', state: verified() }), null, 'connected without sending controls: the plain link');
  assert.match(renderEmailEntryCard({ kind: 'live', note: 'paused' }), /Email connected ✓ \(paused\)/u);
  assert.match(renderEmailEntryCard({ kind: 'live', note: 'off' }), /Email connected: sending is off/u);
  // Through the real services: the card reads the sender's config only (one query) and never the full page view.
  const protection = new MemoryProtectionStore(counts({ mode: 'live' }));
  protection.config = config({ ownerPaused: true });
  const calls: string[] = [];
  const spy = <T extends object>(target: T, label: string): T => new Proxy(target, { get(t, key, r) { const v = Reflect.get(t, key, r);
    return typeof v === 'function' ? (...args: unknown[]) => { calls.push(`${label}.${String(key)}`); return v.apply(t, args); } : v; } });
  const connections = spy(new MemoryEmailConnectionStore(), 'connections');
  const owner = new OwnerSendingService({ protection: spy(protection, 'protection'), connections, vault: null });
  const status = await readEmailEntry({ config: () => owner.entryConfig(PP_WS), state: async () => { calls.push('state'); return null; } });
  assert.deepEqual(status, { kind: 'live', note: 'paused' });
  assert.deepEqual(calls, ['protection.present', 'protection.sendingConfig'], 'one query (the readiness check is cached in production)');
  // Slow: the page waits at most the limit, then shows the plain link. Failing: the plain link, never a throw.
  const started = Date.now();
  assert.equal(await readEmailEntry({ config: () => new Promise(resolve => setTimeout(() => resolve(config()), 1_500)), state: async () => null }), null);
  assert.ok(Date.now() - started < 1_000, `a slow read is cut off (${Date.now() - started} ms)`);
  assert.equal(await readEmailEntry({ config: async () => { throw new Error('database down'); }, state: async () => null }), null);
  assert.equal(await readEmailEntry({ config: async () => 'absent', state: async () => { throw new Error('down'); } }), null);
});
