/**
 * Book sign-ups into Leads, without a database: which sign-ups start a copy, that the public form's answer never
 * changes or waits for it, how a failure is retried and logged, the task wording, the owner screens and the owner's
 * button. The CRM behaviour itself (dedupe, the trigger, consent, phone, races, faults) is proved on real PostgreSQL in
 * test/db/mhp-book-crm.integration.test.ts. All people and values are synthetic.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { PostgresPortalDeps } from '../src/portal/router.js';
import { handleMhpGrowth } from '../src/mhp/growth-router.js';
import { parseMhpSignup, type MhpRegistrantRecord, type MhpSignup } from '../src/mhp/growth-service.js';
import { MHP_BOOK_INTEREST_LABEL } from '../src/mhp/book-interest.js';
import { MhpBookLeadService, bookLeadPhone, bookTaskDescription, bookTaskDue, isBookSignup, MHP_BOOK_MODULE,
  type MhpBookLeadStatuses } from '../src/mhp/book-leads-service.js';
import type { CrmTransactionRunner } from '../src/crm-pg/types.js';
import { hqRegistrantsPage } from '../src/mhp/growth-view.js';
import { marketingWorkspacePage } from '../src/mhp/marketing-workspace-view.js';
import { MHP_MARKETING_WORKSPACE_ID, type MhpMarketingWorkspaceSnapshot } from '../src/mhp/marketing-workspace-service.js';

const SITE = 'https://martinhowardproperty.co.uk', APP = 'https://app.martinhowardproperty.co.uk';
const TOKEN = 'A'.repeat(43), USER = 'b1590000-0000-4000-8000-000000000001', WS = 'b1590000-0000-4000-8000-000000000002';
const OWNER = 'b1590000-0000-4000-8000-000000000003', PROSPECT = 'b1590000-0000-4000-8000-000000000004';
const SECRET = 'book-leads-synthetic-cursor-secret-32+';
const book = (extra: Partial<MhpSignup> = {}): MhpSignup => ({ email: 'reader@example.com', firstName: 'Reader', level: null, consent: true,
  kind: 'waitlist', label: MHP_BOOK_INTEREST_LABEL, module: MHP_BOOK_MODULE, link: `${SITE}/book/`, phone: null, ...extra });

/** A CRM runner that records each transaction and can be made to fail or hang. */
function runner(mode: 'fail' | 'hang' | 'ok' = 'ok') {
  const calls: string[] = [];
  const transactions: CrmTransactionRunner = { run: async (context) => {
    calls.push(String(context.userId));
    if (mode === 'hang') return new Promise<never>(() => undefined);
    if (mode === 'fail') throw Object.assign(new Error('relation "app.contacts" is locked by reader@example.com'), { code: '55P03' });
    throw new Error('not reached in these tests');
  } };
  return { calls, transactions };
}

test('only the book form starts a copy; webinar, cheat sheet and course waitlist sign-ups never do', () => {
  assert.equal(isBookSignup(book()), true);
  assert.equal(isBookSignup(book({ kind: 'webinar' })), false);
  assert.equal(isBookSignup(book({ kind: 'sheet' })), false);
  assert.equal(isBookSignup(book({ label: 'Course waitlist' })), false);
  assert.equal(isBookSignup(book({ module: 'course-waitlist' })), false);
  assert.equal(isBookSignup(book({ module: null })), false);
  const r = runner();
  const logs: string[] = [];
  const service = new MhpBookLeadService({ transactions: r.transactions, registrants: async () => [], ownerUserId: OWNER, cursorSecret: SECRET, log: l => logs.push(l) });
  for (const other of [book({ kind: 'webinar', label: 'Webinar', module: null }), book({ kind: 'sheet', label: 'Cheat sheet', module: 'sheet-1' }),
    book({ label: 'Course waitlist', module: 'course' })]) service.afterCapture(other, { prospectId: PROSPECT, signupId: WS });
  assert.deepEqual(r.calls, []);
  assert.deepEqual(logs, []);
});

test('the task says what they asked for, their mobile or that none was given, and the marketing permission', () => {
  const withMobile = bookTaskDescription({ phone: '07700 900159', marketingEmails: true });
  assert.match(withMobile, /asked for Chapter One and the launch updates/);
  assert.match(withMobile, /^Mobile: 07700 900159 \(they asked for a call\)\. The number has not been checked\.$/m);
  assert.match(withMobile, /^Marketing emails: yes/m);
  const none = bookTaskDescription({ phone: null, marketingEmails: false });
  assert.match(none, /^No mobile given\.$/m);
  assert.match(none, /^Marketing emails: no\. Contact them about the book only\.$/m);
  assert.doesNotMatch(none, /call/);
  assert.match(bookTaskDescription({ phone: '12', marketingEmails: true }), /does not look like a complete number/);
  assert.equal(bookLeadPhone('07700 900159'), '07700900159');
  assert.equal(bookLeadPhone('0044 7700 900159'), '+447700900159');
  assert.equal(bookLeadPhone('(0)7700-900-159'), '07700900159');
  assert.equal(bookLeadPhone('call me'), null);
  assert.equal(bookLeadPhone(null), null);
});

test('the follow-up is due in one working day: Friday, Saturday and Sunday sign-ups are due on Monday', () => {
  const day = (iso: string) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', weekday: 'short' }).format(new Date(bookTaskDue(Date.parse(iso))));
  assert.equal(day('2026-11-18T10:00:00Z'), 'Thu');
  assert.equal(day('2026-11-20T10:00:00Z'), 'Mon');
  assert.equal(day('2026-11-21T10:00:00Z'), 'Mon');
  assert.equal(day('2026-11-22T10:00:00Z'), 'Mon');
  assert.equal(Date.parse(bookTaskDue(Date.parse('2026-11-18T10:00:00Z'))), Date.parse('2026-11-19T10:00:00Z'));
});

test('a failed automatic copy never throws, is logged without the address or error text, and is retried then left to the catch-up', async () => {
  const r = runner('fail');
  const logs: string[] = [];
  const scheduled: number[] = [];
  const pending: (() => void)[] = [];
  const service = new MhpBookLeadService({ transactions: r.transactions, registrants: async () => [], ownerUserId: OWNER, cursorSecret: SECRET,
    log: l => logs.push(l), retryDelaysMs: [10, 20], schedule: (run, delay) => { scheduled.push(delay); pending.push(run); } });
  assert.doesNotThrow(() => service.afterCapture(book({ phone: '07700 900159' }), { prospectId: PROSPECT, signupId: WS }));
  const settle = () => new Promise(resolve => setImmediate(resolve));
  await settle();
  while (pending.length) { pending.shift()!(); await settle(); }
  assert.deepEqual(scheduled, [10, 20]);
  assert.equal(r.calls.length, 3, 'one attempt and two retries');
  assert.ok(r.calls.every(actor => actor === OWNER), 'the lead owner acts');
  assert.equal(logs.length, 3);
  for (const line of logs) {
    assert.match(line, /^mhp book leads: a book sign-up was saved but its lead was not created in Leads \(55P03\)/);
    assert.doesNotMatch(line, /reader@|example\.com|07700|locked/);
  }
  assert.match(logs.at(-1)!, /next visit to Book interest/);
});

test('with no lead owner configured and no owner visit yet, the copy waits for the catch-up and says so once', () => {
  const r = runner();
  const logs: string[] = [];
  const service = new MhpBookLeadService({ transactions: r.transactions, registrants: async () => [], ownerUserId: null, cursorSecret: SECRET, log: l => logs.push(l) });
  assert.equal(service.automatic, false);
  service.afterCapture(book(), { prospectId: PROSPECT, signupId: WS });
  service.afterCapture(book(), { prospectId: PROSPECT, signupId: WS });
  assert.deepEqual(r.calls, []);
  assert.equal(logs.length, 1);
  assert.match(logs[0]!, /^mhp book leads: a book sign-up was saved but not copied into Leads yet/);
  assert.throws(() => new MhpBookLeadService({ transactions: r.transactions, registrants: async () => [], ownerUserId: 'not-a-uuid', cursorSecret: SECRET }));
});

function growthFixture(bookLeads?: ConstructorParameters<typeof MhpBookLeadService>[0] | 'throws') {
  const captured: MhpSignup[] = [];
  const portal = { kind: 'postgres', secure: true, sessionSecret: 'mhp159-synthetic-secret-at-least32', abuseHashSecret: 'mhp159-abuse-secret-at-least32',
    auth: { resolve: async (token: string) => token === TOKEN ? { sessionToken: TOKEN, userId: USER, workspaceId: WS, userEmail: 'owner@example.invalid' } : null },
    requestContext: () => ({ requestId: USER, sourceHash: Buffer.alloc(32, 1), requestHash: Buffer.alloc(32, 2) }),
    abuse: { admit: async () => ({ allowed: true }), complete: async () => {} }, now: () => Date.parse('2026-11-17T12:00:00Z') } as unknown as PostgresPortalDeps;
  const service = bookLeads === 'throws' ? { afterCapture: () => { throw new Error('unexpected'); }, statuses: async () => { throw new Error('x'); }, catchUp: async () => { throw new Error('x'); } }
    : bookLeads ? new MhpBookLeadService(bookLeads) : undefined;
  const deps = { portal, unsubscribeSecret: 's'.repeat(48), marketingMode: 'test', learning: {} as never,
    growth: { capture: async (s: MhpSignup) => { captured.push(s); return { prospectId: PROSPECT, signupId: WS, campaign: s.kind === 'webinar' ? 'webinar-2026-11-04' : null, entryEventSequence: s.kind === 'webinar' ? '1' : null, queued: 0 }; },
      story: async () => {}, unsubscribe: async () => true, summary: async () => ({}) as never, listApplications: async () => [], listRegistrants: async () => [] },
    ...(service ? { bookLeads: service } : {}) };
  async function request(fields: Record<string, string>) {
    const result = { status: 0, headers: {} as Record<string, string>, body: '' };
    const req = Object.assign(Readable.from([Buffer.from(new URLSearchParams(fields).toString())]), { method: 'POST', url: '/api/mhp/subscribe',
      headers: { origin: SITE, 'content-type': 'application/x-www-form-urlencoded' } }) as unknown as IncomingMessage;
    const res = { writeHead(status: number, headers = {}) { result.status = status; Object.assign(result.headers, headers); }, end(body = '') { result.body = body; } } as unknown as ServerResponse;
    await handleMhpGrowth(req, res, new URL('/api/mhp/subscribe', APP), deps as never);
    return result;
  }
  return { request, captured };
}

const BOOK_FORM = { FIRSTNAME: 'Reader', EMAIL: 'reader@example.com', OPT_IN: '1', PHONE: '07700 900159', CHEATSHEET: MHP_BOOK_INTEREST_LABEL,
  CHEATSHEET_MODULE: MHP_BOOK_MODULE, CHEATSHEET_LINK: `${SITE}/book/` };

test('the public form answers exactly the same with or without the copy, when it fails, throws or hangs; other sign-ups too', async () => {
  const forms: Record<string, string>[] = [BOOK_FORM, { ...BOOK_FORM, PHONE: '' },
    { FIRSTNAME: 'Viewer', EMAIL: 'viewer@example.com', OPT_IN: '1', CHEATSHEET: 'Webinar', CHEATSHEET_LINK: `${SITE}/webinar/` },
    { FIRSTNAME: 'Sheet', EMAIL: 'sheet@example.com', OPT_IN: '1', CHEATSHEET: 'Deal checklist', CHEATSHEET_MODULE: 'deal-checklist', CHEATSHEET_LINK: `${SITE}/checklist/` }];
  for (const form of forms) {
    const parsed = parseMhpSignup(new URLSearchParams(form));
    assert.notEqual(parsed, 'honeypot');
    const baseline = await growthFixture().request(form);
    assert.equal(baseline.status, 303);
    for (const variant of [{ mode: 'ok' as const }, { mode: 'fail' as const }, { mode: 'hang' as const }, { mode: 'throws' as const }]) {
      const r = runner(variant.mode === 'throws' ? 'ok' : variant.mode);
      const f = growthFixture(variant.mode === 'throws' ? 'throws' : { transactions: r.transactions, registrants: async () => [], ownerUserId: OWNER,
        cursorSecret: SECRET, log: () => undefined, retryDelaysMs: [], schedule: () => undefined });
      const started = Date.now();
      const answer = await f.request(form);
      assert.ok(Date.now() - started < 1_000, 'a hanging copy never delays the answer');
      assert.deepEqual(answer, baseline, `${variant.mode}: same status, headers and body`);
      assert.equal(f.captured.length, 1, 'the sign-up itself is saved first');
      if (variant.mode !== 'throws') assert.equal(r.calls.length, isBookSignup(f.captured[0]!) ? 1 : 0);
    }
  }
});

const person = (extra: Partial<MhpRegistrantRecord> = {}): MhpRegistrantRecord => ({ id: PROSPECT, firstName: 'Reader', email: 'reader@example.com', phone: '07700 900159',
  level: null, marketingConsent: true, unsubscribed: false, firstSeenAt: '2026-11-17T00:00:00Z', lastSignupAt: '2026-11-17T00:00:00Z',
  signups: [MHP_BOOK_INTEREST_LABEL], webinar: false, applied: false, ...extra });

test('Book interest shows who is in Leads with a link, the mobile, a plain count, and what needs the owner; all escaped', () => {
  const other = 'b1590000-0000-4000-8000-000000000005', third = 'b1590000-0000-4000-8000-000000000006';
  const contact = 'b1590000-0000-4000-8000-000000000007';
  const people = [person(), person({ id: other, email: 'second@example.com', firstName: '<b>Second</b>', phone: null }), person({ id: third, email: 'third@example.com' })];
  const leads: MhpBookLeadStatuses = { available: true, inLeads: 1, total: 3, byProspect: new Map([
    [PROSPECT, { state: 'in_leads', contactId: contact, opportunityId: WS, stage: 'New <enquiry>', status: 'open', complete: true, messages: true }],
    [other, { state: 'not_yet' }], [third, { state: 'needs_you', reason: 'several_contacts' }]]) };
  const html = hqRegistrantsPage(people, true, leads);
  assert.match(html, /<strong>1 of 3 are in your Leads\.<\/strong>/);
  assert.match(html, new RegExp(`<a href="/portal/crm/contacts/${contact}">Yes, open lead</a> · New &lt;enquiry&gt;`));
  assert.match(html, /<td>07700 900159<\/td>/);
  assert.match(html, /&lt;b&gt;Second&lt;\/b&gt;/);
  assert.doesNotMatch(html, /<b>Second/);
  assert.match(html, /<td>Not yet<\/td>/);
  assert.match(html, /Needs you: More than one record in Leads has this email/);
  assert.match(html, /<th>In your Leads<\/th>/);
  const unavailable = hqRegistrantsPage(people, true, { available: false, byProspect: new Map(), inLeads: 0, total: 3 });
  assert.match(unavailable, /could not be checked just now/);
  assert.doesNotMatch(hqRegistrantsPage(people, false), /In your Leads/);
});

test('the marketing page puts "Bring book sign-ups into Leads" beside the webinar import, with the CSRF field and an escaped result', () => {
  const snapshot = { userId: USER, selectedWorkspaceId: MHP_MARKETING_WORKSPACE_ID, personalWorkspaceId: WS, marketingWorkspaceId: MHP_MARKETING_WORKSPACE_ID, marketingSelected: true } as MhpMarketingWorkspaceSnapshot;
  const html = marketingWorkspacePage(snapshot, 'csrf"<x>', USER, { enabled: true, bookLeadsEnabled: true });
  const webinarAt = html.indexOf('action="/hq/marketing/webinar-leads"'), bookAt = html.indexOf('action="/hq/marketing/book-leads"');
  assert.ok(webinarAt > 0 && bookAt > webinarAt, 'next to the webinar button');
  assert.match(html, /<button type="submit">Bring book sign-ups into Leads<\/button>/);
  assert.match(html, /name="csrf" value="csrf&quot;&lt;x&gt;"/);
  const after = marketingWorkspacePage(snapshot, 'c', USER, { enabled: true, bookLeadsEnabled: true,
    bookResult: { added: 2, alreadyIn: 3, completed: 1, needYou: 1, failed: false, processed: 7, hasMore: true, cursor: 'abc"def' } });
  assert.match(after, /2 added to Leads · 1 completed · 3 already in Leads · 1 need you/);
  assert.match(after, /Bring next book sign-ups into Leads/);
  assert.match(after, /name="cursor" value="abc&quot;def"/);
  assert.doesNotMatch(marketingWorkspacePage({ ...snapshot, marketingSelected: false, selectedWorkspaceId: WS } as MhpMarketingWorkspaceSnapshot, 'c', USER, { enabled: true, bookLeadsEnabled: true }), /book-leads/);
});

test('the owner button refuses a stale, forged or other-audience cursor before reading anyone', async () => {
  let reads = 0;
  const service = new MhpBookLeadService({ transactions: runner().transactions, registrants: async () => { reads++; return []; }, ownerUserId: OWNER, cursorSecret: SECRET });
  const identity = { sessionToken: TOKEN, userId: USER, workspaceId: MHP_MARKETING_WORKSPACE_ID, userEmail: 'owner@example.invalid' };
  for (const cursor of ['junk', 'a.b', `${'A'.repeat(20)}.${'B'.repeat(43)}`]) {
    await assert.rejects(service.importBatch(identity, 'req', cursor), /Refresh the book sign-up import/);
  }
  assert.equal(reads, 0);
  const empty = await service.importBatch(identity, 'req', '');
  assert.deepEqual(empty, { added: 0, alreadyIn: 0, completed: 0, needYou: 0, failed: false, processed: 0, hasMore: false, cursor: null });
  assert.equal(reads, 1);
});

// ── Consent wording (CONSENT_FORM / OPT_IN_MESSAGES) ─────────────────────────────────────────────────────────────

const forms = {
  webinar: { FIRSTNAME: 'Viewer', EMAIL: 'viewer@example.com', OPT_IN: '1', PHONE: '07700 900159', CHEATSHEET: 'Webinar', CHEATSHEET_LINK: `${SITE}/webinar/` },
  webinarNoTick: { FIRSTNAME: 'Viewer', EMAIL: 'viewer@example.com', CHEATSHEET: 'Webinar', CHEATSHEET_LINK: `${SITE}/webinar/` },
  sheet: { FIRSTNAME: 'Sheet', EMAIL: 'sheet@example.com', OPT_IN: 'on', CHEATSHEET: 'Deal checklist', CHEATSHEET_MODULE: 'deal-checklist', CHEATSHEET_LINK: `${SITE}/cheat-sheets/deal/` },
  course: { FIRSTNAME: 'Course', EMAIL: 'course@example.com', OPT_IN: 'true', CHEATSHEET: 'Course waitlist', CHEATSHEET_MODULE: 'course', CHEATSHEET_LINK: `${SITE}/course/` },
  book: BOOK_FORM,
};

/** The values the PG adapter sends to mhp_capture_signup_v3 for a parsed form. */
async function storedValues(fields: Record<string, string>): Promise<unknown[]> {
  const { PgMhpGrowthService, mhpWebinarConfig } = await import('../src/mhp/growth-service.js');
  let values: unknown[] = [];
  const pool = { query: async (_sql: string, v: unknown[] = []) => { values = v; return { rows: [{ outcome: { signupId: WS, prospectId: USER,
    campaign: v[5] === 'webinar' ? 'webinar-2026-11-04' : null, entryEventSequence: v[5] === 'webinar' ? '1' : null, queued: 0 } }] }; } };
  const signup = parseMhpSignup(new URLSearchParams(fields));
  assert.notEqual(signup, 'honeypot');
  await new PgMhpGrowthService(pool as never, pool as never, mhpWebinarConfig({})).capture(signup as MhpSignup, null, Date.parse('2026-11-17T12:00:00Z'));
  return values;
}

test('forms that send neither new field are parsed and stored exactly as before (webinar, cheat sheet, course waitlist, current book form)', async () => {
  const { MHP_CONSENT_VERSION } = await import('../src/mhp/growth-service.js');
  assert.equal(MHP_CONSENT_VERSION, 'site-2026-10');
  for (const [name, form] of Object.entries(forms)) {
    const parsed = parseMhpSignup(new URLSearchParams(form)) as MhpSignup;
    assert.equal('consentVersion' in parsed, false, name);
    assert.deepEqual(Object.keys(parsed), ['email', 'firstName', 'level', 'consent', 'kind', 'label', 'module', 'link', 'phone'], name);
    assert.equal((await storedValues(form))[4], 'site-2026-10', name);
  }
  // The required email tick for the waitlist is unchanged, whatever the new fields say.
  for (const extra of [{}, { CONSENT_FORM: 'book-2026-11' }, { CONSENT_FORM: 'book-2026-11', OPT_IN_MESSAGES: '1' }] as Record<string, string>[]) {
    assert.throws(() => parseMhpSignup(new URLSearchParams({ ...BOOK_FORM, OPT_IN: '', ...extra })), /Tick the box so we can email you/);
  }
});

test('CONSENT_FORM names an allow-listed wording; +messages only with the texts tick, the email tick and a usable mobile; anything else is ignored', async () => {
  const { MHP_CONSENT_WORDINGS, MHP_BOOK_EMAIL_CONSENT_TEXT, MHP_MESSAGES_CONSENT_TEXT, mhpMessagesConsented } = await import('../src/mhp/growth-service.js');
  assert.equal(MHP_CONSENT_WORDINGS['book-2026-11'], "Give me access to Chapter One and email me about Before You Buy, occasional property tips, and offers of Martin Howard Property's training and Property Predator software. I can unsubscribe at any time.");
  assert.equal(MHP_CONSENT_WORDINGS['book-2026-11+messages'], `${MHP_BOOK_EMAIL_CONSENT_TEXT} ${MHP_MESSAGES_CONSENT_TEXT}`);
  assert.match(MHP_MESSAGES_CONSENT_TEXT, /^Also send me occasional texts and WhatsApp messages from Martin Howard Property .* Reply STOP or unsubscribe at any time\.$/);
  const version = async (extra: Record<string, string>, base: Record<string, string> = BOOK_FORM) => (await storedValues({ ...base, ...extra }))[4];
  assert.equal(await version({ CONSENT_FORM: 'book-2026-11' }), 'book-2026-11');
  for (const tick of ['1', 'on', 'true']) assert.equal(await version({ CONSENT_FORM: 'book-2026-11', OPT_IN_MESSAGES: tick }), 'book-2026-11+messages');
  // No (or an unusable) mobile: the texts tick is not recorded.
  assert.equal(await version({ CONSENT_FORM: 'book-2026-11', OPT_IN_MESSAGES: '1', PHONE: '' }), 'book-2026-11');
  assert.equal(await version({ CONSENT_FORM: 'book-2026-11', OPT_IN_MESSAGES: '1', PHONE: '123 456' }), 'book-2026-11');
  assert.equal(await version({ CONSENT_FORM: 'book-2026-11', OPT_IN_MESSAGES: 'yes please' }), 'book-2026-11');
  assert.equal(await version({ OPT_IN_MESSAGES: '1' }), 'site-2026-10', 'the texts tick alone changes nothing');
  // The site default has no texts wording: never +messages.
  assert.equal(await version({ CONSENT_FORM: 'site-2026-10', OPT_IN_MESSAGES: '1' }), 'site-2026-10');
  // Hostile or unknown values: ignored, today's default, never an error.
  for (const hostile of ['book-2026-11+messages', 'book-2026-12', "book-2026-11'; DROP TABLE x;--", '<script>', 'x'.repeat(5000), '__proto__', 'constructor', 'toString', ' book-2026-11 x']) {
    const stored = await version({ CONSENT_FORM: hostile, OPT_IN_MESSAGES: '1' });
    assert.ok(stored === 'site-2026-10', `${hostile.slice(0, 30)} -> ${String(stored)}`);
  }
  // A webinar without the email tick cannot carry the texts wording.
  assert.equal(await version({ CONSENT_FORM: 'book-2026-11', OPT_IN_MESSAGES: '1' }, forms.webinarNoTick), 'book-2026-11');
  assert.equal(mhpMessagesConsented('book-2026-11+messages'), true);
  for (const value of ['book-2026-11', 'site-2026-10', 'forged+messages', null, undefined]) assert.equal(mhpMessagesConsented(value), false);
  // A hand-built sign-up with an unlisted version is stored with the default.
  const { mhpSignupConsentVersion } = await import('../src/mhp/growth-service.js');
  assert.equal(mhpSignupConsentVersion({ consentVersion: 'forged+messages' }), 'site-2026-10');
});

test('the lead and task say which texts/WhatsApp permission was given', async () => {
  const { bookCandidateFromCapture } = await import('../src/mhp/book-leads-service.js');
  const yes = bookCandidateFromCapture(parseMhpSignup(new URLSearchParams({ ...BOOK_FORM, CONSENT_FORM: 'book-2026-11', OPT_IN_MESSAGES: '1' })) as MhpSignup, { prospectId: PROSPECT, signupId: WS }, Date.now());
  assert.deepEqual([yes.consentVersion, yes.messages], ['book-2026-11+messages', true]);
  assert.match(bookTaskDescription(yes), /^Texts and WhatsApp offers: yes/m);
  const no = bookCandidateFromCapture(parseMhpSignup(new URLSearchParams({ ...BOOK_FORM, CONSENT_FORM: 'book-2026-11' })) as MhpSignup, { prospectId: PROSPECT, signupId: WS }, Date.now());
  assert.deepEqual([no.consentVersion, no.messages], ['book-2026-11', false]);
  assert.match(bookTaskDescription(no), /^Texts and WhatsApp: about the book only\.$/m);
  const today = bookCandidateFromCapture(parseMhpSignup(new URLSearchParams(BOOK_FORM)) as MhpSignup, { prospectId: PROSPECT, signupId: WS }, Date.now());
  assert.deepEqual([today.consentVersion, today.messages], ['site-2026-10', false]);
  assert.match(bookTaskDescription({ phone: '07700 900159', marketingEmails: true, messages: null }), /^Texts and WhatsApp: not recorded for this sign-up, so about the book only\.$/m);
});

test('Book interest and its CSV show "Texts/WhatsApp offers" from the stored version', async () => {
  const { registrantsCsv } = await import('../src/mhp/growth-view.js');
  const other = 'b1590000-0000-4000-8000-000000000008', third = 'b1590000-0000-4000-8000-000000000009';
  const people = [person(), person({ id: other, email: 'no@example.com' }), person({ id: third, email: 'later@example.com' })];
  const base = { state: 'in_leads' as const, contactId: USER, opportunityId: WS, stage: 'New enquiry', status: 'open', complete: true };
  const leads: MhpBookLeadStatuses = { available: true, inLeads: 2, total: 3, byProspect: new Map([[PROSPECT, { ...base, messages: true }], [other, { ...base, messages: false }], [third, { state: 'not_yet' }]]) };
  const html = hqRegistrantsPage(people, true, leads);
  assert.match(html, /<th>Texts\/WhatsApp offers<\/th><th>In your Leads<\/th>/);
  assert.deepEqual([...html.matchAll(/<td>(Yes|No|Not known yet)<\/td><td>(?:<a|Not yet)/g)].map(m => m[1]), ['Yes', 'No', 'Not known yet']);
  const csv = registrantsCsv(people, leads).split('\r\n');
  assert.match(csv[0]!, /,Texts\/WhatsApp offers$/);
  assert.deepEqual(csv.slice(1, 4).map(line => line.split(',').at(-1)), ['Yes', 'No', 'Not known yet']);
  assert.doesNotMatch(registrantsCsv(people).split('\r\n')[0]!, /Texts/);
});

test('sequence and owner email pages outside the brand workspace answer the same sentence with a link to /hq/marketing', async () => {
  const { marketingWorkspaceFirstPage, MARKETING_WORKSPACE_FIRST } = await import('../src/mhp/marketing-workspace-view.js');
  assert.equal(MARKETING_WORKSPACE_FIRST, 'Open the MHP marketing workspace first.');
  const html = marketingWorkspaceFirstPage();
  assert.match(html, /<p>Open the MHP marketing workspace first\.<\/p>/);
  assert.match(html, /<a href="\/hq\/marketing">Go to the MHP marketing workspace<\/a>/);
});
