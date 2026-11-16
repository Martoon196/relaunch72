/**
 * /portal/email: the owner's screens in every state, escaped, with no token or secret anywhere in the HTML; the same
 * origin and CSRF rules as the follow-ups page; the email rules tick enforced on the server; and the follow-ups page
 * banner turning into a plain "Connect email" link when the feature is on. Postmark and DNS are stand-ins.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createPostmarkAccountApi, EMAIL_CONNECT_BUSINESSES, EMAIL_TERMS, EmailConnectionService, loadEmailConnectConfig } from '../src/email-connections/index.js';
import { handleEmailConnection } from '../src/portal/email-connection-router.js';
import { renderEmailConnectionPage } from '../src/portal/email-connection-view.js';
import { portalCsrfToken } from '../src/portal/session.js';
import { ACCOUNT_TOKEN, FakePostmark, fakeResolver, MemoryEmailConnectionStore, OWNER_SESSION, PP_WS } from './email-connections-fixtures.js';

const ORIGIN = 'https://growth.relaunch72-test.co.uk';
const SESSION_SECRET = 'portal-session-secret-for-tests-0123456789';
const SECRET = 'whsec-synthetic-0123456789-abcdefghijklmnop';
const KEY = Buffer.alloc(32, 9).toString('base64');
const owner = { sessionToken: OWNER_SESSION, userId: '00000000-0000-4000-8000-000000000001', workspaceId: PP_WS, userEmail: 'owner@relaunch72-test.co.uk' };
const portal = { productProfile: { id: 'property_predator_growth' } as never, portalBaseUrl: ORIGIN, sessionSecret: SESSION_SECRET };

function setup(env: NodeJS.ProcessEnv = { EMAIL_CONNECT: 'enabled', POSTMARK_ACCOUNT_TOKEN: ACCOUNT_TOKEN, EMAIL_CONNECTION_KEY: KEY }, founder = false,
  resolver = fakeResolver({ ns: { 'propertypredator-test.co.uk': ['ada.ns.cloudflare.com'] } })) {
  const postmark = new FakePostmark(), store = new MemoryEmailConnectionStore(new Set([OWNER_SESSION]), { [OWNER_SESSION]: 'Pat <O\'Brien>' });
  const service = new EmailConnectionService({ config: loadEmailConnectConfig(env, { portalBaseUrl: ORIGIN }), store,
    account: createPostmarkAccountApi({ accountToken: ACCOUNT_TOKEN, fetch: postmark.fetch }),
    resolver, secret: () => SECRET, lockWaitMs: 2000, founder: async () => founder });
  const call = async (method: 'GET' | 'POST', path: string, fields?: Record<string, string>, headers: Record<string, string> = {}) => {
    const body = fields ? new URLSearchParams(fields).toString() : '';
    const captured = { status: 0, body: '', headers: {} as Record<string, string> };
    const req = Object.assign(Readable.from(body ? [Buffer.from(body)] : []), { method, url: path,
      headers: { host: 'growth.relaunch72-test.co.uk', ...(method === 'POST' ? { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'same-origin' } : {}), ...headers } }) as unknown as IncomingMessage;
    const res = { writeHead(status: number, h: Record<string, string>) { captured.status = status; captured.headers = h; }, end(text = '') { captured.body = String(text); } } as unknown as ServerResponse;
    const handled = await handleEmailConnection(req, res, new URL(path, ORIGIN), { portal, service, identity: owner });
    assert.equal(handled, true);
    return captured;
  };
  const csrf = portalCsrfToken(SESSION_SECRET, OWNER_SESSION);
  const commandId = '6f0d8f2a-3b1c-4d5e-8f90-123456789abc';
  return { postmark, store, service, call, csrf, commandId };
}

const sensitive = (html: string, postmark: FakePostmark) => {
  for (const value of [ACCOUNT_TOKEN, SECRET, KEY, ...postmark.servers.map(server => server.token)]) assert.equal(html.includes(value), false, 'no token or secret in the page');
  assert.doesNotMatch(html, /Postmark|EMAIL_CONNECT|POSTMARK_ACCOUNT_TOKEN|ErrorCode|api\.postmarkapp/u, 'no developer or provider wording');
};

test('every state of the page, from the form to connected, in plain English and escaped', async () => {
  const h = setup();
  // a. Step 1: the six rules and one required tick box; then step 2, the address form, carrying the tick.
  let page = await h.call('GET', '/portal/email');
  assert.equal(page.status, 200);
  assert.match(page.headers['content-security-policy']!, /script-src 'self'/u);
  for (const rule of EMAIL_TERMS) assert.ok(page.body.includes(rule.replace(/"/g, '&quot;').replace(/'/g, '&#39;')), rule);
  assert.match(page.body, /<form method="get" action="\/portal\/email"><label class="check" for="email-agree"><input id="email-agree" type="checkbox" name="agree" value="yes" required> I agree to these email rules<\/label><button type="submit">Next: your address<\/button>/u);
  assert.doesNotMatch(page.body, /Sender name/u, 'one step at a time');
  sensitive(page.body, h.postmark);
  page = await h.call('GET', '/portal/email?agree=yes');
  for (const label of ['Sender name', 'Send from (an address on your own domain)', 'Replies go to', '>Connect<']) assert.ok(page.body.includes(label), label);
  assert.match(page.body, /<input type="hidden" name="agree" value="yes">/u, 'the tick travels with the address');
  assert.equal((await h.call('GET', '/portal/email?agree=no')).status, 400);
  assert.match(page.body, /aria-label="Business"[^]*Property Predator/u, 'the Business picker offers Property Predator only');
  sensitive(page.body, h.postmark);
  // Unticked: refused on the server, nothing at Postmark.
  const base = { csrf: h.csrf, commandId: h.commandId, fromName: "PP & Co's Team", fromAddress: 'hello@propertypredator-test.co.uk', replyTo: '' };
  page = await h.call('POST', '/portal/email/connect', base);
  assert.equal(page.status, 400);
  assert.match(page.body, /Tick the email rules first\./u);
  assert.ok(page.body.includes('value="PP &amp; Co&#39;s Team"'), 'what was typed comes back escaped');
  assert.equal(h.postmark.calls.length, 0);
  // Free mailbox.
  page = await h.call('POST', '/portal/email/connect', { ...base, fromAddress: 'me@gmail.com', agree: 'yes' });
  assert.match(page.body, /That&#39;s a free mailbox \(gmail\.com\)\. Use an address on your own domain\./u);
  // b. Connected to the point of the two records.
  page = await h.call('POST', '/portal/email/connect', { ...base, fromName: 'Property Predator', agree: 'yes' });
  assert.equal(page.status, 200);
  assert.match(page.body, /Add two records at the company that manages your domain/u);
  const id = h.postmark.domains[0]!.id;
  assert.ok(page.body.includes(`<code>${id}pm._domainkey</code>`), 'the short host');
  assert.ok(page.body.includes(`<code>${id}pm._domainkey.propertypredator-test.co.uk</code>`), 'the full host');
  assert.match(page.body, /Most companies want this short name/u); assert.match(page.body, /Some companies want the full name instead/u);
  assert.match(page.body, /data-auto-check-note data-js-only hidden>While this page is open, it checks again by itself/u, 'the self-check is only promised with the script');
  assert.match(page.body, /action="\/portal\/email\/check" data-auto-check>/u);
  assert.match(page.body, /<code>pm-[0-9a-f]{10}<\/code>/u, 'the CNAME name is this business\'s proof label');
  assert.ok(page.body.includes('<code>pm.mtasv.net</code>'));
  assert.match(page.body, /data-type-field><span class="label">Type<\/span><code>TXT<\/code>/u); assert.match(page.body, /data-type-field><span class="label">Type<\/span><code>CNAME<\/code>/u);
  assert.match(page.body, /Record 1 <span class="waiting">Not found yet<\/span>/u);
  assert.match(page.body, /data-copy="[^"]+" hidden>Copy</u, 'Copy buttons only appear with JavaScript');
  assert.match(page.body, /Where do I add these\?[^]*Cloudflare[^]*DNS only[^]*grey cloud/u, 'Cloudflare detected from the name servers');
  assert.match(page.body, /href="mailto:\?subject=DNS%20records[^"]*"/u);
  assert.match(page.body, />Check</u);
  sensitive(page.body, h.postmark);
  // c. Check: not yet.
  page = await h.call('POST', '/portal/email/check', { csrf: h.csrf, commandId: h.commandId });
  assert.ok(page.body.includes('Not found yet. Records can take from a few minutes to a few hours to show up after they are added'));
  // d. Connected.
  h.postmark.domains[0]!.dkimVerified = true; h.postmark.domains[0]!.returnPathVerified = true;
  page = await h.call('POST', '/portal/email/check', { csrf: h.csrf, commandId: h.commandId });
  assert.match(page.body, /Both found\. Your email is connected\./u);
  assert.match(page.body, /Connected\. Sending is switched on in the next step\./u);
  assert.match(page.body, /hello@propertypredator-test\.co\.uk/u);
  assert.match(page.body, /Agreed by Pat &lt;O&#39;Brien&gt; on \d{1,2} [A-Z][a-z]+ \d{4}\./u, 'the agreement line, escaped');
  assert.match(page.body, />Disconnect</u);
  assert.doesNotMatch(page.body, /test-send|go-live|>Go live</iu, 'no test send and no go-live button in this release');
  sensitive(page.body, h.postmark);
  // e. Disconnect.
  page = await h.call('POST', '/portal/email/disconnect', { csrf: h.csrf, commandId: h.commandId });
  assert.match(page.body, /Email is disconnected/u);
  assert.match(page.body, />Next: your address</u, 'back to step 1');
});

test('Continue after an interruption, and the busy message', async () => {
  const h = setup();
  h.postmark.failOn(c => c.method === 'POST' && c.path === '/domains', 503);
  let page = await h.call('POST', '/portal/email/connect', { csrf: h.csrf, commandId: h.commandId, fromName: 'PP', fromAddress: 'hello@propertypredator-test.co.uk', replyTo: '', agree: 'yes' });
  assert.equal(page.status, 503);
  assert.match(page.body, /The email service is busy\. Try again in a minute\./u);
  page = await h.call('GET', '/portal/email');
  assert.match(page.body, /and it didn’t finish\. Press Continue/u);
  assert.doesNotMatch(page.body, /carry on where it stopped/u);
  assert.match(page.body, />Continue</u);
  assert.match(page.body, /<summary>More options<\/summary>[^]*action="\/portal\/email\/disconnect"><input[^]*?class="secondary">Start again</u, 'a safe Start again');
  assert.doesNotMatch(page.body, /use-domain/u, 'no take-over offered to anyone but the founder');
  page = await h.call('POST', '/portal/email/continue', { csrf: h.csrf, commandId: h.commandId });
  assert.match(page.body, /Add two records at the company/u);
});

test('same-origin, CSRF, exact fields and the allowed business are enforced; switched off says so plainly', async () => {
  const h = setup();
  const fields = { csrf: h.csrf, commandId: h.commandId };
  assert.equal((await h.call('POST', '/portal/email/check', { ...fields, csrf: 'forged' })).status, 403);
  assert.equal((await h.call('POST', '/portal/email/check', fields, { origin: 'https://evil.example.co.uk' })).status, 403);
  assert.equal((await h.call('POST', '/portal/email/check', fields, { 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await h.call('POST', '/portal/email/check', { ...fields, extra: '1' })).status, 400);
  assert.equal((await h.call('POST', '/portal/email/check', { ...fields, commandId: 'nope' })).status, 403);
  assert.equal((await h.call('GET', '/portal/email?business=2789228d-55a6-4688-b1e8-2f70abca990b')).status, 404);
  assert.equal((await h.call('GET', `/portal/email?business=${PP_WS}`)).status, 200);
  assert.equal((await h.call('GET', '/portal/email/copy.js')).headers['content-type'], 'text/javascript; charset=utf-8');
  assert.equal((await h.call('GET', '/portal/email', undefined, { host: 'other.relaunch72-test.co.uk' })).status, 404);
  assert.equal(h.postmark.calls.length, 0);
  const off = setup({});
  const page = await off.call('GET', '/portal/email');
  assert.match(page.body, /Email connection isn&#39;t switched on yet\./u);
  assert.doesNotMatch(page.body, /Sender name|EMAIL_CONNECT/u);
});

test('the page escapes every stored value', () => {
  const html = renderEmailConnectionPage({ csrf: 'c"sr<f', commandId: 'id', view: { offered: true, dnsHost: null,
    business: EMAIL_CONNECT_BUSINESSES[0]!,
    state: { status: 'dns_pending', step: null, domain: 'x.co.uk', fromName: '<img>', fromAddress: 'a@x.co.uk', replyTo: null, serverId: 1, domainId: 2, stream: 'broadcast',
      webhookId: 3, hasServerToken: true, hasWebhookSecret: true, mode: 'off', verifiedAt: null, rowVersion: 1,
      dns: { dkim: { host: '<script>.x.co.uk', value: '"><script>alert(1)</script>', verified: false }, returnPath: { host: 'pm-bounces.x.co.uk', value: 'pm.mtasv.net', verified: true } },
      protection: { state: 'ok', reason: null, since: null, dailyCap: 50, hourlyCap: 13, warmupStartedAt: null }, terms: null, goLiveApprovedAt: null, domainAttempted: false } } });
  assert.doesNotMatch(html, /<script>alert|<script>\.x/u);
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(html.includes('value="c&quot;sr&lt;f"'));
});

test('the founder sees "Use this domain" for a domain already in the account; a customer is asked for another domain', async () => {
  const fields = { fromName: 'PP', fromAddress: 'hello@propertypredator-test.co.uk', replyTo: '', agree: 'yes' };
  const f = setup(undefined, true);
  f.postmark.domains.push({ id: 5, name: 'propertypredator-test.co.uk', returnPath: 'pm-bounces.propertypredator-test.co.uk', dkimVerified: true, returnPathVerified: true });
  let page = await f.call('POST', '/portal/email/connect', { csrf: f.csrf, commandId: f.commandId, ...fields });
  assert.match(page.body, /This domain is already in our email account\. If it belongs to this business, press Use this domain\./u);
  assert.match(page.body, /action="\/portal\/email\/use-domain"[^]*>Use this domain</u);
  page = await f.call('POST', '/portal/email/use-domain', { csrf: f.csrf, commandId: f.commandId });
  assert.equal(page.status, 200);
  // That domain's records are already verified: the page says so, not "Add these 2 records".
  assert.match(page.body, /Your two records are already in place/u);
  assert.doesNotMatch(page.body, /Add these 2 records|Add the 2 records|Add two records/u);
  const c = setup();
  c.postmark.domains.push({ id: 5, name: 'propertypredator-test.co.uk', returnPath: 'pm-bounces.propertypredator-test.co.uk', dkimVerified: true, returnPathVerified: true });
  page = await c.call('POST', '/portal/email/connect', { csrf: c.csrf, commandId: c.commandId, ...fields });
  assert.ok(page.body.includes('That domain is already used in our email account, so it can&#39;t be connected from here.'));
  assert.doesNotMatch(page.body, /use-domain|Use this domain/u);
  assert.deepEqual(submitButtons(page.body).filter(b => b.primary).map(b => b.label), ['Connect with these details'], 'one next step: another domain, never Continue');
  page = await c.call('POST', '/portal/email/use-domain', { csrf: c.csrf, commandId: c.commandId });
  assert.equal(page.status, 403);
});

test('the home page links to Connect email only when it is switched on and the database has 0155', async () => {
  const { renderGrowthHomeBody } = await import('../src/portal/growth-home.js');
  const { PROPERTY_PREDATOR_GROWTH_PROFILE } = await import('../src/portal/product-profile.js');
  const h = setup();
  assert.equal(await h.service.available(), true);
  h.store.absent = true;
  assert.equal(await h.service.available(), false, 'at 0154: never shown');
  assert.equal(await setup({}).service.available(), false, 'switched off: never shown');
  {
    const snapshot = { workspace: { id: PP_WS, name: 'PP', snapshotAt: new Date().toISOString() }, stages: [], contacts: [], opportunities: [], tasks: [] } as never;
    assert.match(renderGrowthHomeBody(snapshot, PROPERTY_PREDATOR_GROWTH_PROFILE as never, undefined, { emailConnectAvailable: true }), /href="\/portal\/email">Connect email</u);
    assert.doesNotMatch(renderGrowthHomeBody(snapshot, PROPERTY_PREDATOR_GROWTH_PROFILE as never, undefined, { emailConnectAvailable: false }), /\/portal\/email"/u);
    // With the business's state read: one status card instead of the plain link.
    const card = renderGrowthHomeBody(snapshot, PROPERTY_PREDATOR_GROWTH_PROFILE as never, undefined, { emailConnectAvailable: true, emailStatus: { kind: 'in_progress', step: 3 } });
    assert.match(card, /Finish connecting your email: step 3 of 5[^]*href="\/portal\/email#email-step">Carry on</u);
    assert.equal(card.match(/href="\/portal\/email/gu)!.length, 1, 'one way in, not two');
    assert.doesNotMatch(renderGrowthHomeBody(snapshot, PROPERTY_PREDATOR_GROWTH_PROFILE as never, undefined, { emailConnectAvailable: false, emailStatus: { kind: 'live' } }), /\/portal\/email/u, 'gated exactly as before');
  }
});

const stateOf = (over: Record<string, unknown>) => ({ status: 'dns_pending', step: null, domain: 'propertypredator-test.co.uk', fromName: 'PP', fromAddress: 'hello@propertypredator-test.co.uk',
  replyTo: null, serverId: 1, domainId: 2, stream: 'broadcast', webhookId: 3, hasServerToken: true, hasWebhookSecret: true, mode: 'off', verifiedAt: null, rowVersion: 1,
  dns: { dkim: { host: '20261115pm._domainkey.propertypredator-test.co.uk', value: 'k=rsa; p=KEY', verified: false },
    returnPath: { host: 'pm-bounces.propertypredator-test.co.uk', value: 'pm.mtasv.net', verified: false } },
  protection: { state: 'ok', reason: null, since: null, dailyCap: 50, hourlyCap: 13, warmupStartedAt: null }, terms: null, goLiveApprovedAt: null, domainAttempted: false, ...over }) as never;
const submitButtons = (html: string) => [...html.matchAll(/<button type="submit"( class="secondary")?>([^<]+)<\/button>/gu)].map(m => ({ label: m[2], primary: !m[1] }));

test('a domain already in our account: one primary button, "Use this domain"; Continue is not offered beside it (it would only meet the same domain again)', () => {
  const view = { offered: true as const, dnsHost: null, business: EMAIL_CONNECT_BUSINESSES[0]!, state: stateOf({ status: 'needs_attention', step: 'domain', dns: null, domainId: null }) };
  const offered = submitButtons(renderEmailConnectionPage({ csrf: 'c', commandId: 'id', view, offerTakeOver: true }));
  assert.deepEqual(offered.filter(b => b.primary).map(b => b.label), ['Use this domain']);
  assert.equal(offered.some(b => b.label === 'Continue'), false);
  assert.ok(offered.some(b => b.label === 'Start again' && !b.primary), 'Start again stays, as a secondary button');
  assert.ok(offered.some(b => b.label === 'Connect with these details' && !b.primary), 'other details stay possible, as a secondary button');
  // Without the clash, Continue is the primary next step as before, and there is no take-over.
  const plain = submitButtons(renderEmailConnectionPage({ csrf: 'c', commandId: 'id', view }));
  assert.deepEqual(plain.filter(b => b.primary && b.label !== 'Connect with these details').map(b => b.label), ['Continue']);
  assert.equal(plain.some(b => b.label === 'Use this domain'), false);
});

test('the records screen: when both records are already found it says so and asks for Check, never "Add these 2 records"', () => {
  const found = { host: 'x', value: 'y', verified: true };
  const both = renderEmailConnectionPage({ csrf: 'c', commandId: 'id', message: { text: 'Nearly there. Both records are already in place for your domain, so press Check below to finish.', ok: true },
    view: { offered: true, dnsHost: 'cloudflare', business: EMAIL_CONNECT_BUSINESSES[0]!,
      state: stateOf({ dns: { dkim: { ...found, host: 'a._domainkey.propertypredator-test.co.uk' }, returnPath: { ...found, host: 'pm-bounces.propertypredator-test.co.uk' } } }) } });
  assert.match(both, /<h2>Your two records are already in place<\/h2>/u);
  assert.match(both, /Both records are already found, so there is nothing to add\. Press Check to finish connecting\./u);
  assert.doesNotMatch(both, /Add these 2 records|Add both records|Add the 2 records|Where do I add these|Email these to whoever/u);
  assert.ok(submitButtons(both).some(b => b.label === 'Check' && b.primary), 'the Check it names is on the page');
  // One or none found: the add-records screen as before.
  for (const dns of [{ dkim: { ...found, host: 'a._domainkey.propertypredator-test.co.uk' }, returnPath: { host: 'pm-bounces.propertypredator-test.co.uk', value: 'pm.mtasv.net', verified: false } }, undefined]) {
    const html = renderEmailConnectionPage({ csrf: 'c', commandId: 'id', view: { offered: true, dnsHost: null, business: EMAIL_CONNECT_BUSINESSES[0]!, state: stateOf(dns ? { dns } : {}) } });
    assert.match(html, /<h2>Add two records at the company that manages your domain<\/h2>/u);
    assert.doesNotMatch(html, /already in place/u);
  }
});

test('Connect for a domain whose records are already verified answers "already in place" in the banner too', async () => {
  const f = setup(undefined, true);
  f.postmark.domains.push({ id: 5, name: 'propertypredator-test.co.uk', returnPath: 'pm-bounces.propertypredator-test.co.uk', dkimVerified: true, returnPathVerified: true });
  const fields = { fromName: 'PP', fromAddress: 'hello@propertypredator-test.co.uk', replyTo: '', agree: 'yes' };
  await f.call('POST', '/portal/email/connect', { csrf: f.csrf, commandId: f.commandId, ...fields });
  const page = await f.call('POST', '/portal/email/use-domain', { csrf: f.csrf, commandId: f.commandId });
  assert.match(page.body, /role="status"><p>Nearly there\. Both records are already in place for your domain, so press Check below to finish\.<\/p>/u);
  assert.doesNotMatch(page.body, /Add the 2 records below/u);
});

test('the automatic check writes only a real change, keeps the owner\'s place when nothing changed, and shows a new problem', async () => {
  const dkimHost = () => `${h.postmark.domains[0]!.id}pm._domainkey.propertypredator-test.co.uk`;
  const txt: Record<string, string[][]> = {};
  const h = setup(undefined, false, fakeResolver({ ns: { 'propertypredator-test.co.uk': ['ada.ns.cloudflare.com'] }, txt }));
  await h.call('POST', '/portal/email/connect', { csrf: h.csrf, commandId: h.commandId, fromName: 'PP', fromAddress: 'hello@propertypredator-test.co.uk', replyTo: '', agree: 'yes' });
  const before = { events: h.store.events.length, version: h.store.row!.rowVersion };
  const postmarkBefore = h.postmark.calls.length;
  // Nothing found, as stored: the two verify calls, no store write, and the page is marked quiet for the script.
  let page = await h.call('POST', '/portal/email/check', { csrf: h.csrf, commandId: h.commandId, auto: 'yes' });
  assert.equal(page.status, 200);
  assert.deepEqual(h.postmark.calls.slice(postmarkBefore).map(c => `${c.method} ${c.path.replace(/[0-9]+/gu, 'N')}`), ['PUT /domains/N/verifyDkim', 'PUT /domains/N/verifyReturnPath']);
  assert.deepEqual([h.store.events.length, h.store.row!.rowVersion], [before.events, before.version], 'no event, no row version');
  assert.match(page.body, /data-message data-auto-quiet role="alert"><p>Not found yet\./u);
  // A manual Check with the same answer still writes exactly as before.
  await h.call('POST', '/portal/email/check', { csrf: h.csrf, commandId: h.commandId });
  assert.equal(h.store.events.length, before.events + 1);
  // Something the owner must act on (record 1 there with another value): said, not hidden as quiet.
  txt[dkimHost()] = [['v=other-value']];
  page = await h.call('POST', '/portal/email/check', { csrf: h.csrf, commandId: h.commandId, auto: 'yes' });
  assert.match(page.body, /Record 1 is there, but its Value doesn&#39;t match/u);
  assert.doesNotMatch(page.body, /data-auto-quiet/u, 'something new to act on: the script shows it');
  // A real change (one record found) is written as a manual Check writes it.
  const events = h.store.events.length;
  h.postmark.domains[0]!.dkimVerified = true;
  page = await h.call('POST', '/portal/email/check', { csrf: h.csrf, commandId: h.commandId, auto: 'yes' });
  assert.equal(h.store.events.length, events + 1);
  assert.equal(h.store.events.at(-1)!.outcome, 'partial');
  assert.doesNotMatch(page.body, /data-auto-quiet/u, 'a change replaces the page');
  assert.match(page.body, /data-records-found="1"/u);
});
