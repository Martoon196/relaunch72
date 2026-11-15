/**
 * /portal/email, release 2: the sending controls once connected (details, "Send a test to me", "Go live" with the
 * founder's approval, back to testing, the owner's pause), the banner in each state, "This address works now", and the
 * founder's page. Same origin and CSRF as release 1; everything escaped; no token, secret or provider wording on the
 * owner's page. Postmark is a stand-in.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createPostmarkAccountApi, EmailConnectionService, EmailConnectionVault, EMAIL_TERMS_VERSION, loadEmailConnectConfig } from '../src/email-connections/index.js';
import { handleEmailConnection } from '../src/portal/email-connection-router.js';
import { OwnerSendingService, SENDING_MESSAGES } from '../src/email-protection/owner.js';
import { portalCsrfToken } from '../src/portal/session.js';
import { ACCOUNT_TOKEN, FakePostmark, fakeResolver, MemoryEmailConnectionStore, OWNER_SESSION, PP_WS } from './email-connections-fixtures.js';
import { counts, FOUNDER, MemoryProtectionStore } from './email-protection-fixtures.js';

const ORIGIN = 'https://growth.relaunch72-test.co.uk';
const SESSION_SECRET = 'portal-session-secret-for-tests-0123456789';
const SECRET = 'whsec-synthetic-0123456789-abcdefghijklmnop';
const KEY = Buffer.alloc(32, 9).toString('base64');
const owner = { sessionToken: OWNER_SESSION, userId: '00000000-0000-4000-8000-000000000001', workspaceId: PP_WS, userEmail: 'owner@pp-send-proof.co.uk' };
const founderIdentity = { ...owner, sessionToken: FOUNDER, userId: '00000000-0000-4000-8000-000000000002' };
const portal = { productProfile: { id: 'property_predator_growth' } as never, portalBaseUrl: ORIGIN, sessionSecret: SESSION_SECRET };

async function setup() {
  const postmark = new FakePostmark(), store = new MemoryEmailConnectionStore(new Set([OWNER_SESSION]), { [OWNER_SESSION]: 'Pat Owner' });
  const emails: { token: string; body: Record<string, unknown> }[] = [];
  let emailAnswer: () => Response = () => new Response(JSON.stringify({ ErrorCode: 0, MessageID: 'pm-test' }), { status: 200 });
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === '/email') { emails.push({ token: (init!.headers as Record<string, string>)['X-Postmark-Server-Token']!, body: JSON.parse(String(init!.body)) }); return emailAnswer(); }
    return postmark.fetch(input, init);
  }) as typeof fetch;
  const config = loadEmailConnectConfig({ EMAIL_CONNECT: 'enabled', POSTMARK_ACCOUNT_TOKEN: ACCOUNT_TOKEN, EMAIL_CONNECTION_KEY: KEY }, { portalBaseUrl: ORIGIN });
  const service = new EmailConnectionService({ config, store, account: createPostmarkAccountApi({ accountToken: ACCOUNT_TOKEN, fetch: postmark.fetch }),
    resolver: fakeResolver({}), secret: () => SECRET, lockWaitMs: 2000 });
  const protection = new MemoryProtectionStore(counts({ mode: 'off', goLiveApprovedAt: null }));
  const lifts: string[] = [], reactivations: string[] = [];
  let liftAnswer = { lifted: 1, released: 0, spamComplaint: false, alreadyLifted: false };
  let providerAnswer: 'deleted' | 'failed' | 'unavailable' | 'none' = 'deleted';
  const bounces = {
    registry: { snapshot: () => ({ blocked: [{ email: 'gone<b>@pp-send-proof.co.uk', reason: 'hard_bounce', since: '2026-11-10T00:00:00Z' }, { email: 'unsub@pp-send-proof.co.uk', reason: 'unsubscribed', since: 'x' }] }) },
    ownerLiftHardBounce: async (input: { email: string }) => { lifts.push(input.email); return liftAnswer; },
    refreshLedger: async () => undefined,
    reactivateAtProvider: async (_ws: string, email: string) => { reactivations.push(email); return providerAnswer; },
  } as never;
  const soon: string[] = [];
  let mailer = true;
  const sending = new OwnerSendingService({ protection, connections: store, vault: new EmailConnectionVault(Buffer.from(KEY, 'base64')), fetcher, bounces,
    evaluator: { soon: ws => soon.push(ws) }, founder: async identity => identity.sessionToken === FOUNDER, portalOrigin: ORIGIN, mailer: () => mailer });
  const call = async (method: 'GET' | 'POST', path: string, fields?: Record<string, string>, identity = owner, headers: Record<string, string> = {}) => {
    const body = fields ? new URLSearchParams(fields).toString() : '';
    const captured = { status: 0, body: '' };
    const req = Object.assign(Readable.from(body ? [Buffer.from(body)] : []), { method, url: path,
      headers: { host: 'growth.relaunch72-test.co.uk', ...(method === 'POST' ? { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'same-origin' } : {}), ...headers } }) as unknown as IncomingMessage;
    const res = { writeHead(status: number) { captured.status = status; }, end(text = '') { captured.body = String(text); } } as unknown as ServerResponse;
    assert.equal(await handleEmailConnection(req, res, new URL(path, ORIGIN), { portal, service, identity, sending }), true);
    return captured;
  };
  const csrf = portalCsrfToken(SESSION_SECRET, OWNER_SESSION), commandId = '6f0d8f2a-3b1c-4d5e-8f90-123456789abc';
  // Connect and verify, as release 1 does.
  await call('POST', '/portal/email/connect', { csrf, commandId, fromName: 'Property Predator', fromAddress: 'hello@pp-send-proof.co.uk', replyTo: '', agree: 'yes' });
  for (const domain of postmark.domains) { domain.dkimVerified = true; domain.returnPathVerified = true; }
  await call('POST', '/portal/email/check', { csrf, commandId });
  assert.equal(store.row!.status, 'verified');
  const form = (extra: Record<string, string> = {}) => ({ csrf, commandId, ...extra });
  return { postmark, store, protection, call, form, emails, setEmailAnswer: (f: () => Response) => { emailAnswer = f; }, lifts, reactivations, soon,
    setLift: (a: typeof liftAnswer) => { liftAnswer = a; }, setProvider: (a: typeof providerAnswer) => { providerAnswer = a; }, csrf, commandId,
    setMailer: (value: boolean) => { mailer = value; } };
}

const clean = (html: string, h: Awaited<ReturnType<typeof setup>>) => {
  for (const value of [ACCOUNT_TOKEN, SECRET, KEY, ...h.postmark.servers.map(server => server.token)]) assert.equal(html.includes(value), false, 'no token or secret in the page');
  assert.doesNotMatch(html, /Postmark|EMAIL_|ErrorCode|api\.postmarkapp|_cap|sample_/u, 'no developer or provider wording');
};

test('connected: the sending section, the footer details, the test list and the buttons, escaped', async () => {
  const h = await setup();
  let page = await h.call('GET', '/portal/email');
  assert.equal(page.status, 200);
  for (const text of ['<h2>Sending</h2>', 'Sending is not switched on yet.', 'Send a test to me', '>Go live<', 'Your business\'s real name', 'Postal address (one line)',
    'Send tests to (up to 10 addresses, separated by commas; leave empty to use your own)']) assert.ok(page.body.includes(text), text);
  assert.doesNotMatch(page.body, /Sending is switched on in the next step/u, 'release 1\'s "next step" note is gone once sending is offered');
  assert.ok(page.body.includes('<span>gone&lt;b&gt;@pp-send-proof.co.uk</span>'), 'hard bounces are listed, escaped');
  assert.doesNotMatch(page.body, /unsub@pp-send-proof/u, 'only hard bounces can be said to work now');
  clean(page.body, h);
  // Footer details: refused plainly when wrong, kept in the form; saved when right.
  page = await h.call('POST', '/portal/email/details', h.form({ businessName: 'A', postalAddress: '1 High Street, Leeds LS1 1AA', testList: '' }));
  assert.equal(page.status, 409);
  assert.ok(page.body.includes('Enter your business&#39;s real name (2 to 120 characters, without &lt; &gt; &quot; \\ or @).'));
  assert.match(SENDING_MESSAGES.needBusinessName, /^Enter your business's real name/u);
  page = await h.call('POST', '/portal/email/details', h.form({ businessName: 'Smith & Co <Ltd>', postalAddress: '1 High Street, Leeds LS1 1AA', testList: '' }));
  assert.equal(page.status, 409, '< > are refused');
  assert.ok(page.body.includes('value="Smith &amp; Co &lt;Ltd&gt;"'), 'what was typed comes back escaped');
  page = await h.call('POST', '/portal/email/details', h.form({ businessName: 'Smith & Co Ltd', postalAddress: '1 High Street\nLeeds LS1 1AA', testList: 'a@pp-send-proof.co.uk, b@test.invalid' }));
  assert.match(page.body, /Enter up to 10 test addresses/u, 'a reserved test address cannot be a test address');
  page = await h.call('POST', '/portal/email/details', h.form({ businessName: 'Smith & Co Ltd', postalAddress: '1 High Street\nLeeds LS1 1AA', testList: 'A@pp-send-proof.co.uk' }));
  assert.equal(page.status, 200); assert.match(page.body, />Saved\.</u);
  assert.deepEqual([h.protection.sending.businessName, h.protection.sending.postalAddress, h.protection.sending.testRecipients], ['Smith & Co Ltd', '1 High Street, Leeds LS1 1AA', ['a@pp-send-proof.co.uk']]);
  // Same origin and CSRF, as every other action.
  assert.equal((await h.call('POST', '/portal/email/go-live', { csrf: 'wrong', commandId: h.commandId })).status, 403);
  assert.equal((await h.call('POST', '/portal/email/go-live', h.form(), owner, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await h.call('POST', '/portal/email/go-live', h.form({ extra: '1' }))).status, 400);
  assert.equal(h.protection.commands.length, 0);
});

test('"Send a test to me": through the business\'s own server and stream to the test list (or the owner\'s own address), with a true answer', async () => {
  const h = await setup();
  let page = await h.call('POST', '/portal/email/test-send', h.form());
  assert.equal(page.status, 200); assert.match(page.body, /Sent\. Check your inbox and spam folder\./u);
  const sent = h.emails[0]!;
  assert.equal(sent.token, h.postmark.servers[0]!.token, 'the business\'s own server token');
  assert.deepEqual([sent.body.To, sent.body.From, sent.body.MessageStream, sent.body.Subject], ['owner@pp-send-proof.co.uk', '"Property Predator" <hello@pp-send-proof.co.uk>', 'broadcast', 'Test email from Property Predator']);
  assert.match(String(sent.body.TextBody), /Property Predator Ltd · 1 High Street, Leeds LS1 1AA/u, 'the footer as it will appear');
  assert.deepEqual(h.protection.testResults.map(r => r.accepted), [true], 'a test that arrived counts as passed');
  assert.ok(h.protection.reserved.every(r => !r.key.includes('@')));
  // True failures.
  h.setEmailAnswer(() => new Response(JSON.stringify({ ErrorCode: 406, Message: 'inactive' }), { status: 422 }));
  page = await h.call('POST', '/portal/email/test-send', h.form());
  assert.equal(page.status, 409);
  assert.ok(page.body.includes('The email service won&#39;t send to owner@pp-send-proof.co.uk: it bounced or was reported as spam before. Use another test address.'));
  h.setEmailAnswer(() => new Response(JSON.stringify({ ErrorCode: 10, Message: 'bad token' }), { status: 401 }));
  assert.ok((await h.call('POST', '/portal/email/test-send', h.form())).body.includes('The email service didn&#39;t accept the test from your address.'));
  h.setEmailAnswer(() => { throw new TypeError('network'); });
  assert.ok((await h.call('POST', '/portal/email/test-send', h.form())).body.includes('We couldn&#39;t tell whether the test was sent.'));
  assert.deepEqual(h.protection.testResults.map(r => r.accepted), [true, false, false], 'an unknown outcome is left counted, never marked passed');
  h.protection.reserveAnswer = 'test_limit';
  assert.ok((await h.call('POST', '/portal/email/test-send', h.form())).body.includes('You have sent 20 test emails in the last hour.'));
  h.protection.reserveAnswer = 'off';
  assert.ok((await h.call('POST', '/portal/email/test-send', h.form())).body.includes('Email sending is switched off for this business, so tests can&#39;t be sent.'));
});

test('"Go live": Postmark is asked whether the webhook is verified; the first time waits for the founder; then the owner controls test and live', async () => {
  const h = await setup();
  let page = await h.call('POST', '/portal/email/go-live', h.form());
  assert.equal(page.status, 200);
  assert.match(page.body, /Waiting for approval\. We will email you\./u);
  assert.deepEqual(h.protection.commands.at(-1), { action: 'live', terms: EMAIL_TERMS_VERSION, webhookOk: true });
  assert.deepEqual(h.soon, [PP_WS]);
  // The banner says the same until the founder approves.
  h.protection.sending = { ...h.protection.sending, goLiveRequestedAt: '2026-11-20T00:00:00Z' };
  page = await h.call('GET', '/portal/email');
  assert.match(page.body, /<h2>Waiting for approval<\/h2><p>Waiting for approval\. We will email you\.<\/p>/u);
  assert.doesNotMatch(page.body, />Go live</u, 'no second request button while waiting');
  // The webhook gone at Postmark: not verified, so the database is told so.
  h.postmark.servers[0]!.webhooks.length = 0;
  h.protection.commandAnswer = 'needs_webhook';
  page = await h.call('POST', '/portal/email/go-live', h.form());
  assert.equal(h.protection.commands.at(-1)!.webhookOk, false);
  assert.match(page.body, /We couldn&#39;t confirm the email service will tell us about bounces\./u);
  for (const [answer, text] of [['needs_footer', 'Add your business&#39;s real name and postal address first.'], ['needs_test', 'Send a test to yourself first. It must be accepted for sending since your email was last connected.'],
    ['needs_terms', 'Tick the latest email rules first.'], ['switched_off', 'Email sending is switched off for this business.'], ['live', 'You are live. Your marketing emails will now go out.']] as const) {
    h.protection.commandAnswer = answer;
    assert.ok((await h.call('POST', '/portal/email/go-live', h.form())).body.includes(text), answer);
  }
  // Without a working alert sender we never promise an email.
  h.protection.commandAnswer = 'requested'; h.setMailer(false);
  assert.match((await h.call('POST', '/portal/email/go-live', h.form())).body, /Waiting for approval\. Check this page for the answer\./u);
  h.setMailer(true); h.protection.commandAnswer = null;
  // Each mode button only from its own mode: "Back to testing" from live, "Start testing" from off.
  assert.match((await h.call('POST', '/portal/email/back-to-test', h.form())).body, /That isn&#39;t available from here\./u, 'mode is off: not from here');
  assert.match((await h.call('POST', '/portal/email/start-test', h.form())).body, /You are testing\. Only your test addresses get emails\./u);
  h.store.row!.mode = 'live';
  assert.match((await h.call('POST', '/portal/email/start-test', h.form())).body, /That isn&#39;t available from here\./u);
  assert.match((await h.call('POST', '/portal/email/back-to-test', h.form())).body, /You are testing\. Only your test addresses get emails\./u);
  assert.match((await h.call('POST', '/portal/email/pause', h.form())).body, /Paused\. No marketing emails will go until you press Resume\./u);
  // Resumed: only "can go again" when nothing else holds them; otherwise what still does.
  h.protection.config = null;
  assert.match((await h.call('POST', '/portal/email/resume', h.form())).body, /Resumed\. Your marketing emails can go again\./u);
  h.protection.config = { workspaceId: PP_WS, status: 'verified', mode: 'live', serverId: 1, stream: 'broadcast', sealedServerToken: 'x', fromName: 'P', fromAddress: 'hello@pp-send-proof.co.uk',
    replyTo: null, businessName: 'B Ltd', postalAddress: '1 High Street, Leeds', testRecipients: [], protectionState: 'paused', protectionReason: null, ownerPaused: false, sampleState: 'passed',
    dailyCap: 0, hourlyCap: 0, accountHeld: false, liveDay: 0, liveHour: 0, goLiveRequestedAt: null, goLiveApprovedAt: 'x', approvedCurrent: true, testCurrent: true, lastStep: null };
  assert.match((await h.call('POST', '/portal/email/resume', h.form())).body, /Resumed\. Your marketing emails are still paused by our protection; only we can restart them\./u);
  assert.deepEqual(h.protection.commands.slice(-4).map(c => c.action), ['test', 'pause', 'resume', 'resume']);
});

test('the banner in each protection state, on the email page, with what tripped and what to do', async () => {
  const h = await setup();
  h.store.row!.mode = 'live';
  h.store.row!.protection = { ...h.store.row!.protection, state: 'paused', dailyCap: 0, hourlyCap: 0 };
  h.protection.sending = { ...h.protection.sending, lastStep: { kind: 'paused', at: '2026-11-20T00:00:00Z', line: 'bounce_rate', count: 6, total: 120, limit: 4, days: 7 } };
  let page = await h.call('GET', '/portal/email');
  assert.match(page.body, /<section class="card alert" role="alert"><h2>Your marketing emails are paused<\/h2><p>In the last 7 days, 6 of your 120 emails bounced \(5%\)\. Our limit is 4%\. Sign-in links, receipts and booking and webinar confirmations still go\. No other business is affected\./u);
  assert.match(page.body, /Only we can restart it\. A second pause within 90 days can switch your email off\./u);
  clean(page.body, h);
  h.store.row!.protection = { ...h.store.row!.protection, state: 'slowed', dailyCap: 25, hourlyCap: 7 };
  h.protection.sending = { ...h.protection.sending, lastStep: { kind: 'slowed', at: 'x', line: 'complaints', count: 2, total: 300, limit: 2, days: 30 } };
  page = await h.call('GET', '/portal/email');
  assert.match(page.body, /<h2>We have slowed your marketing emails<\/h2><p>2 people marked your emails as spam in the last 30 days\. Our limit is 2\. They still go, at up to 25 emails a day; the rest wait their turn\./u);
  h.store.row!.protection = { ...h.store.row!.protection, state: 'off' };
  h.protection.sending = { ...h.protection.sending, lastStep: { kind: 'switched_off', at: 'x', line: 'hard_last50', count: 5, total: 50, limit: 5 } };
  page = await h.call('GET', '/portal/email');
  assert.match(page.body, /<h2>Your email sending is switched off<\/h2><p>5 emails came straight back as undeliverable while your last 50 were going out\. Our limit is 5\./u);
  assert.doesNotMatch(page.body, /Send a test to me|>Go live</u, 'nothing to press while switched off');
  h.store.row!.protection = { ...h.store.row!.protection, state: 'ok', dailyCap: 50 };
  h.protection.counts = { ...h.protection.counts, sampleState: 'held' };
  h.protection.sending = { ...h.protection.sending, lastStep: { kind: 'sample_held', at: 'x', line: 'sample', count: 2, total: 50, limit: 1, ownCount: 0, ownTotal: 50 } };
  page = await h.call('GET', '/portal/email');
  assert.match(page.body, /<h2>We have held the rest of your list<\/h2><p>We sent the first 50 emails and checked them: 2 bounced and 0 people marked one as spam\./u);
  h.protection.counts = { ...h.protection.counts, sampleState: 'passed' };
  h.protection.sending = { ...h.protection.sending, accountHeld: true };
  assert.match((await h.call('GET', '/portal/email')).body, /<h2>Marketing emails are on hold for everyone<\/h2>/u);
});

test('"This address works now": our block is lifted, then the email service is asked too, and the page says what happened', async () => {
  const h = await setup();
  let page = await h.call('POST', '/portal/email/works-now', h.form({ email: 'Gone@pp-send-proof.co.uk' }));
  assert.equal(page.status, 200);
  assert.match(page.body, /We no longer block gone@pp-send-proof\.co\.uk, and the email service will send to it again too\./u);
  assert.deepEqual([h.lifts, h.reactivations], [['gone@pp-send-proof.co.uk'], ['gone@pp-send-proof.co.uk']]);
  h.setProvider('failed');
  assert.match((await h.call('POST', '/portal/email/works-now', h.form({ email: 'gone@pp-send-proof.co.uk' }))).body, /kept it on its own list, so it still won&#39;t send to it\./u);
  h.setProvider('unavailable');
  assert.match((await h.call('POST', '/portal/email/works-now', h.form({ email: 'gone@pp-send-proof.co.uk' }))).body, /couldn&#39;t be reached to let it go too\. Press the button again in a minute\./u);
  h.setLift({ lifted: 0, released: 0, spamComplaint: true, alreadyLifted: false });
  page = await h.call('POST', '/portal/email/works-now', h.form({ email: 'spam@pp-send-proof.co.uk' }));
  assert.match(page.body, /spam@pp-send-proof\.co\.uk stays blocked: they marked one of your emails as spam\. A spam report can&#39;t be undone, here or at the email service\./u);
  assert.equal(h.reactivations.length, 3, 'a spam report is never sent to the email service to delete');
  h.setLift({ lifted: 0, released: 0, spamComplaint: false, alreadyLifted: false });
  assert.match((await h.call('POST', '/portal/email/works-now', h.form({ email: 'never@pp-send-proof.co.uk' }))).body, /has no bounce recorded in your records, so nothing changed here\./u);
  clean(page.body, h);
});

test('the founder\'s page: founder only; one line and one button per decision, recorded through the database\'s own founder check', async () => {
  const h = await setup();
  assert.equal((await h.call('GET', '/portal/email/founder')).status, 403, 'the owner is not the founder');
  let page = await h.call('GET', '/portal/email/founder', undefined, founderIdentity);
  assert.equal(page.status, 200);
  assert.match(page.body, /Nothing needs you\. Every business is sending within our lines\./u);
  h.protection.sending = { ...h.protection.sending, goLiveRequestedAt: '2026-11-20T00:00:00Z' };
  page = await h.call('GET', '/portal/email/founder', undefined, founderIdentity);
  assert.match(page.body, /<strong>Property Predator Ltd is ready to go live\.<\/strong>/u);
  assert.match(page.body, /name="action" value="approve"[^]*name="version" value="3"[^]*>Approve<\/button>/u);
  const founderForm = (fields: Record<string, string>) => ({ csrf: portalCsrfToken(SESSION_SECRET, FOUNDER), commandId: h.commandId, ...fields });
  assert.equal((await h.call('POST', '/portal/email/founder/act', { ...h.form(), action: 'approve', workspace: PP_WS, version: '3' })).status, 403, 'the owner cannot press it');
  page = await h.call('POST', '/portal/email/founder/act', founderForm({ action: 'approve', workspace: PP_WS, version: '2' }), founderIdentity);
  assert.equal(page.status, 409); assert.match(page.body, /This changed since the page was opened\. Nothing was changed\./u);
  page = await h.call('POST', '/portal/email/founder/act', founderForm({ action: 'approve', workspace: PP_WS, version: '3' }), founderIdentity);
  assert.equal(page.status, 200); assert.match(page.body, /Done\./u);
  assert.equal((await h.call('POST', '/portal/email/founder/act', founderForm({ action: 'delete', workspace: PP_WS, version: '3' }), founderIdentity)).status, 400);
  // A paused business: the numbers and the lift button.
  h.protection.counts = { ...h.protection.counts, state: 'paused', sends7: 120, hard7: 6, ownPauses90: 1 };
  h.protection.events.push({ kind: 'paused', numbers: { line: 'bounce_rate', count: 6, total: 120, limit: 4, days: 7, cause: 'own' }, actor: null, at: Date.now() });
  page = await h.call('GET', '/portal/email/founder', undefined, founderIdentity);
  assert.match(page.body, /Emails paused for Property Predator Ltd\. 6 of their last 120 emails bounced \(5%, last 7 days\)\. Our line is 4%, Postmark&#39;s is 10%\./u);
  assert.match(page.body, /Last 7 days: 120 sent, 6 bounced \(5%\)\. Last 30 days: 0 spam reports\. Own pauses in the last 90 days: 1\./u);
  assert.match(page.body, /value="lift"[^]*>Lift the pause<\/button>/u);
  page = await h.call('POST', '/portal/email/founder/act', founderForm({ action: 'lift', workspace: PP_WS, version: String(h.protection.rowVersion) }), founderIdentity);
  assert.match(page.body, /Done\./u);
  assert.deepEqual(h.protection.founderActs.map(a => a.action), ['approve', 'approve', 'lift']);
  assert.ok(h.protection.events.some(e => e.kind === 'lifted' && e.actor === FOUNDER), 'who pressed it is recorded');
});

test('at 0155 (no sender protection in the database) the page is exactly release 1\'s and no sending action changes anything', async () => {
  const h = await setup();
  h.protection.absent = true;
  const page = await h.call('GET', '/portal/email');
  assert.equal(page.status, 200);
  assert.match(page.body, /Connected\. Sending is switched on in the next step\./u);
  assert.doesNotMatch(page.body, /<h2>Sending<\/h2>|Send a test to me|>Go live</u);
  const go = await h.call('POST', '/portal/email/go-live', h.form());
  assert.match(go.body, /Sending isn&#39;t switched on here yet\./u);
  assert.equal(h.protection.commands.length, 0);
  assert.equal(h.emails.length, 0, 'nothing was sent');
  assert.equal((await h.call('GET', '/portal/email/founder', undefined, founderIdentity)).status, 403, 'no founder page either');
});

test('review fixes on the page: a double submit sends one test; our own key failure is ours; a connection in charge but not connected says so; given-up alerts stay visible', async () => {
  const h = await setup();
  // The same commandId twice: one email.
  const form = { csrf: h.csrf, commandId: '7a0d8f2a-3b1c-4d5e-8f90-123456789abc' };
  assert.match((await h.call('POST', '/portal/email/test-send', form)).body, /Sent\. Check your inbox and spam folder\./u);
  h.protection.reserveAnswer = 'replayed';
  assert.match((await h.call('POST', '/portal/email/test-send', form)).body, /That test was already sent once\. Check your inbox and spam folder\./u);
  assert.equal(h.emails.length, 1);
  assert.deepEqual(h.protection.reserved.map(r => r.key), ['test:7a0d8f2a-3b1c-4d5e-8f90-123456789abc:0', 'test:7a0d8f2a-3b1c-4d5e-8f90-123456789abc:0']);
  h.protection.reserveAnswer = 'ok';
  // The saved token cannot be opened with our key: never blamed on the email service.
  h.store.row!.sealedServerToken = new EmailConnectionVault(Buffer.alloc(32, 1)).seal(PP_WS, 'server_token', 'srv-other-key-0123456789abcdef');
  const unreadable = await h.call('POST', '/portal/email/test-send', h.form());
  assert.match(unreadable.body, /We couldn&#39;t open your saved connection on our side\./u);
  assert.equal(h.emails.length, 1);
  // A business that went live, now back to waiting for its records: the banner says nothing is sent.
  h.store.row!.mode = 'live';
  h.store.row!.status = 'dns_pending';
  h.protection.sending = { ...h.protection.sending, goLiveApprovedAt: '2026-11-01T00:00:00Z', approvedCurrent: true };
  const page = await h.call('GET', '/portal/email');
  assert.match(page.body, /<h2>Email is not connected right now<\/h2><p>Email is not connected right now, so nothing is being sent\. Reconnect it to carry on\./u);
  assert.doesNotMatch(page.body, /<h2>Sending<\/h2>/u, 'no sending controls until connected again');
  // The founder sees alert emails that could not be sent.
  const status = h.protection.status_();
  h.protection.status_ = () => ({ ...status, undelivered: [{ workspaceId: PP_WS, audience: 'owner', kind: 'paused', at: '2026-11-20T10:00:00Z' }] });
  const founderPage = await h.call('GET', '/portal/email/founder', undefined, founderIdentity);
  assert.match(founderPage.body, /<strong>1 alert email could not be sent in the last 30 days<\/strong>, so it is shown here instead:<\/p><ul><li>A pause \(to the business owner\), 20 November<\/li>/u);
});
