/**
 * /portal/email: the owner's screens in every state, escaped, with no token or secret anywhere in the HTML; the same
 * origin and CSRF rules as the follow-ups page; the email rules tick enforced on the server; and the follow-ups page
 * banner turning into a plain "Connect email" link when the feature is on. Postmark and DNS are stand-ins.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createPostmarkAccountApi, EMAIL_TERMS, EmailConnectionService, loadEmailConnectConfig } from '../src/email-connections/index.js';
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

function setup(env: NodeJS.ProcessEnv = { EMAIL_CONNECT: 'enabled', POSTMARK_ACCOUNT_TOKEN: ACCOUNT_TOKEN, EMAIL_CONNECTION_KEY: KEY }, founder = false) {
  const postmark = new FakePostmark(), store = new MemoryEmailConnectionStore(new Set([OWNER_SESSION]), { [OWNER_SESSION]: 'Pat <O\'Brien>' });
  const service = new EmailConnectionService({ config: loadEmailConnectConfig(env, { portalBaseUrl: ORIGIN }), store,
    account: createPostmarkAccountApi({ accountToken: ACCOUNT_TOKEN, fetch: postmark.fetch }),
    resolver: fakeResolver({ ns: { 'propertypredator-test.co.uk': ['ada.ns.cloudflare.com'] } }), secret: () => SECRET, lockWaitMs: 2000, founder: async () => founder });
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
  // a. the form, with the six rules and one required tick box.
  let page = await h.call('GET', '/portal/email');
  assert.equal(page.status, 200);
  assert.match(page.headers['content-security-policy']!, /script-src 'self'/u);
  for (const label of ['Sender name', 'Send from (an address on your own domain)', 'Replies go to', '>Connect<', 'I agree to these email rules']) assert.ok(page.body.includes(label), label);
  for (const rule of EMAIL_TERMS) assert.ok(page.body.includes(rule.replace(/"/g, '&quot;').replace(/'/g, '&#39;')), rule);
  assert.match(page.body, /<input id="email-agree" type="checkbox" name="agree" value="yes" required>/u);
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
  assert.match(page.body, /Add these 2 records where your domain is managed/u);
  const id = h.postmark.domains[0]!.id;
  assert.ok(page.body.includes(`<code>${id}pm._domainkey</code>`), 'the short host');
  assert.ok(page.body.includes(`<code>${id}pm._domainkey.propertypredator-test.co.uk</code>`), 'the full host');
  assert.match(page.body, /Most hosts want this short name/u); assert.match(page.body, /Some hosts want the full name/u);
  assert.doesNotMatch(page.body, /by itself/u);
  assert.ok(page.body.includes('<code>pm-bounces</code>') && page.body.includes('<code>pm.mtasv.net</code>'));
  assert.match(page.body, /TXT record/u); assert.match(page.body, /CNAME record/u);
  assert.match(page.body, /data-copy="[^"]+" hidden>Copy</u, 'Copy buttons only appear with JavaScript');
  assert.match(page.body, /Where do I add these\?[^]*Cloudflare[^]*DNS only[^]*grey cloud/u, 'Cloudflare detected from the name servers');
  assert.match(page.body, /href="mailto:\?subject=DNS%20records[^"]*"/u);
  assert.match(page.body, />Check</u);
  sensitive(page.body, h.postmark);
  // c. Check: not yet.
  page = await h.call('POST', '/portal/email/check', { csrf: h.csrf, commandId: h.commandId });
  assert.match(page.body, /Not found yet\. This can take up to 48 hours; press Check again later\./u);
  // d. Connected.
  h.postmark.domains[0]!.dkimVerified = true; h.postmark.domains[0]!.returnPathVerified = true;
  page = await h.call('POST', '/portal/email/check', { csrf: h.csrf, commandId: h.commandId });
  assert.match(page.body, /Both found\. Your email is connected\./u);
  assert.match(page.body, /Connected\. Sending is switched on in the next step\./u);
  assert.match(page.body, /hello@propertypredator-test\.co\.uk/u);
  assert.match(page.body, /Agreed by Pat &lt;O&#39;Brien&gt; on \d{1,2} [A-Z][a-z]+ \d{4}\./u, 'the agreement line, escaped');
  assert.match(page.body, />Disconnect</u);
  assert.doesNotMatch(page.body, /test send|Go live/iu, 'no test send and no go-live button in this release');
  sensitive(page.body, h.postmark);
  // e. Disconnect.
  page = await h.call('POST', '/portal/email/disconnect', { csrf: h.csrf, commandId: h.commandId });
  assert.match(page.body, /Email is disconnected/u);
  assert.match(page.body, /Sender name/u, 'back to the form');
});

test('Continue after an interruption, and the busy message', async () => {
  const h = setup();
  h.postmark.failOn(c => c.method === 'POST' && c.path === '/domains', 503);
  let page = await h.call('POST', '/portal/email/connect', { csrf: h.csrf, commandId: h.commandId, fromName: 'PP', fromAddress: 'hello@propertypredator-test.co.uk', replyTo: '', agree: 'yes' });
  assert.equal(page.status, 503);
  assert.match(page.body, /The email service is busy\. Try again in a minute\./u);
  page = await h.call('GET', '/portal/email');
  assert.match(page.body, /Setting up didn’t finish\. Press Continue to carry on where it stopped\./u);
  assert.match(page.body, />Continue</u);
  assert.match(page.body, /<summary>Start again<\/summary>[^]*action="\/portal\/email\/disconnect"/u, 'a safe Start again');
  assert.doesNotMatch(page.body, /use-domain/u, 'no take-over offered to anyone but the founder');
  page = await h.call('POST', '/portal/email/continue', { csrf: h.csrf, commandId: h.commandId });
  assert.match(page.body, /Add these 2 records/u);
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
    business: { workspaceId: PP_WS, name: 'Property Predator', sourceKey: 'conn-d975ff66', replacesSourceKey: 'pp' },
    state: { status: 'dns_pending', step: null, domain: 'x.co.uk', fromName: '<img>', fromAddress: 'a@x.co.uk', replyTo: null, serverId: 1, domainId: 2, stream: 'broadcast',
      webhookId: 3, hasServerToken: true, hasWebhookSecret: true, mode: 'off', verifiedAt: null, rowVersion: 1,
      dns: { dkim: { host: '<script>.x.co.uk', value: '"><script>alert(1)</script>', verified: false }, returnPath: { host: 'pm-bounces.x.co.uk', value: 'pm.mtasv.net', verified: true } },
      protection: { state: 'ok', reason: null, since: null, dailyCap: 50, hourlyCap: 13, warmupStartedAt: null }, terms: null, goLiveApprovedAt: null, domainAttempted: false } } });
  assert.doesNotMatch(html, /<script>alert|<script>\.x/u);
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(html.includes('value="c&quot;sr&lt;f"'));
});

test('the founder sees "Use this domain" for a domain already in the account; a customer sees "contact support"', async () => {
  const fields = { fromName: 'PP', fromAddress: 'hello@propertypredator-test.co.uk', replyTo: '', agree: 'yes' };
  const f = setup(undefined, true);
  f.postmark.domains.push({ id: 5, name: 'propertypredator-test.co.uk', returnPath: 'pm-bounces.propertypredator-test.co.uk', dkimVerified: true, returnPathVerified: true });
  let page = await f.call('POST', '/portal/email/connect', { csrf: f.csrf, commandId: f.commandId, ...fields });
  assert.match(page.body, /This domain is already in our email account\. If it belongs to this business, press Use this domain\./u);
  assert.match(page.body, /action="\/portal\/email\/use-domain"[^]*>Use this domain</u);
  page = await f.call('POST', '/portal/email/use-domain', { csrf: f.csrf, commandId: f.commandId });
  assert.equal(page.status, 200);
  assert.match(page.body, /Add these 2 records/u);
  const c = setup();
  c.postmark.domains.push({ id: 5, name: 'propertypredator-test.co.uk', returnPath: 'pm-bounces.propertypredator-test.co.uk', dkimVerified: true, returnPathVerified: true });
  page = await c.call('POST', '/portal/email/connect', { csrf: c.csrf, commandId: c.commandId, ...fields });
  assert.match(page.body, /That domain is already in use\. If it is yours, contact support\./u);
  assert.doesNotMatch(page.body, /use-domain|Use this domain/u);
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
  }
});
