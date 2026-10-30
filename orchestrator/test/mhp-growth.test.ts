import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MhpGrowthError, mhpApplicationConfig, mhpSchedule, mhpUnsubscribeToken, mhpWebinarConfig, parseMhpApplication, parseMhpEvent, parseMhpSignup,
  parseMhpStory, verifyMhpUnsubscribeToken, type MhpApplication, type MhpApplicationRecord, type MhpClaimedSend, type MhpSignup,
} from '../src/mhp/growth-service.js';
import { createMhpMarketingSender, mhpMarketingConfig, renderMhpMarketingEmail } from '../src/mhp/marketing-mail.js';
import { hqApplicationsPage, hqGrowthPage } from '../src/mhp/growth-view.js';
import { MHP_MARKETING_TEMPLATES } from '../src/mhp/marketing-templates.js';
import { renderMhpMarkdown } from '../src/mhp/markdown.js';
import { parseMhpCourseBundle, MhpLearningError } from '../src/mhp/learning-service.js';
import { parseMultipart } from '../src/mhp/growth-router.js';

const form = (o: Record<string, string>) => new URLSearchParams(o);
const webinarForm = { FIRSTNAME: ' Alex ', EMAIL: ' Alex@Example.COM ', OPT_IN: '1', LEVEL: 'l2', CHEATSHEET: 'Webinar 4 November',
  CHEATSHEET_MODULE: 'Module 1', CHEATSHEET_LINK: 'https://martinhowardproperty.co.uk/webinar/', email_address_check: '', locale: 'en' };
const webinar = mhpWebinarConfig({});

test('site sign-up fields map to a normalised webinar, sheet or waitlist sign-up', () => {
  const signup = parseMhpSignup(form(webinarForm)) as MhpSignup;
  assert.deepEqual({ ...signup }, { email: 'alex@example.com', firstName: 'Alex', level: 'L2', consent: true, kind: 'webinar',
    label: 'Webinar 4 November', module: 'Module 1', link: 'https://martinhowardproperty.co.uk/webinar/' });
  const sheet = parseMhpSignup(form({ ...webinarForm, CHEATSHEET: 'The HMO Checklist, Wales First', CHEATSHEET_LINK: 'https://martinhowardproperty.co.uk/cheat-sheets/12/' })) as MhpSignup;
  assert.equal(sheet.kind, 'sheet');
  const wait = parseMhpSignup(form({ ...webinarForm, CHEATSHEET: 'Course waitlist', CHEATSHEET_LINK: 'https://martinhowardproperty.co.uk/join/' })) as MhpSignup;
  assert.equal(wait.kind, 'waitlist');
  assert.equal(parseMhpSignup(form({ ...webinarForm, email_address_check: 'bot' })), 'honeypot');
});

test('sign-up rejects missing consent, bad email and links off the site', () => {
  const sheetForm = { ...webinarForm, CHEATSHEET: 'The HMO Checklist, Wales First', CHEATSHEET_LINK: 'https://martinhowardproperty.co.uk/cheat-sheets/12/' };
  assert.throws(() => parseMhpSignup(form({ ...sheetForm, OPT_IN: '' })), MhpGrowthError);
  assert.throws(() => parseMhpSignup(form({ ...webinarForm, OPT_IN: '', CHEATSHEET: 'Course waitlist', CHEATSHEET_LINK: 'https://martinhowardproperty.co.uk/join/' })), MhpGrowthError);
  assert.throws(() => parseMhpSignup(form({ ...webinarForm, EMAIL: 'not-an-email' })), MhpGrowthError);
  assert.throws(() => parseMhpSignup(form({ ...webinarForm, CHEATSHEET_LINK: 'https://evil.example/webinar/' })), MhpGrowthError);
  assert.throws(() => parseMhpSignup(form({ ...webinarForm, FIRSTNAME: 'A\u0007' })), MhpGrowthError);
});

test('webinar sign-up without the optional box is a service-only registration', () => {
  const signup = parseMhpSignup(form({ ...webinarForm, OPT_IN: '' })) as MhpSignup;
  assert.equal(signup.kind, 'webinar');
  assert.equal(signup.consent, false);
  const early = mhpSchedule(signup, webinar, Date.parse('2026-10-29T10:00:00Z'));
  assert.deepEqual(early.map(s => [s.template, s.dueAt]), [
    ['webinar_confirm', '2026-10-29T10:00:00.000Z'],
    ['webinar_24h', '2026-11-03T19:30:00.000Z'],
    ['webinar_1h', '2026-11-04T18:30:00.000Z'],
    ['webinar_replay_plain', '2026-11-05T08:00:00.000Z'],
  ]);
});

test('webinar schedule uses UK times and drops reminders that would arrive late', () => {
  const signup = parseMhpSignup(form(webinarForm)) as MhpSignup;
  const early = mhpSchedule(signup, webinar, Date.parse('2026-10-29T10:00:00Z'));
  assert.deepEqual(early.map(s => [s.template, s.dueAt, s.expiresAt]), [
    ['webinar_confirm', '2026-10-29T10:00:00.000Z', '2026-11-04T19:30:00.000Z'],
    ['webinar_24h', '2026-11-03T19:30:00.000Z', '2026-11-04T17:30:00.000Z'],
    ['webinar_1h', '2026-11-04T18:30:00.000Z', '2026-11-04T19:30:00.000Z'],
    ['webinar_replay', '2026-11-05T08:00:00.000Z', '2026-11-11T19:30:00.000Z'],
    ['webinar_followup', '2026-11-06T08:00:00.000Z', '2026-11-12T19:30:00.000Z'],
    // Saturday 7 November 08:00 UK; gone at midnight after the 23:59 close.
    ['webinar_90days', '2026-11-07T08:00:00.000Z', '2026-11-08T00:00:00.000Z'],
    ['webinar_casestudy', '2026-11-08T08:00:00.000Z', '2026-11-12T19:30:00.000Z'],
  ]);
  assert.ok(early.every(s => Date.parse(s.expiresAt) > Date.parse(s.dueAt) && s.campaign === 'webinar-2026-11-04'));
  const late = mhpSchedule(signup, webinar, Date.parse('2026-11-04T19:00:00Z'));
  assert.deepEqual(late.map(s => s.template), ['webinar_confirm', 'webinar_1h', 'webinar_replay', 'webinar_followup', 'webinar_90days', 'webinar_casestudy']);
  const after = mhpSchedule(signup, webinar, Date.parse('2026-11-05T12:00:00Z'));
  assert.deepEqual(after.map(s => s.template), ['webinar_replay', 'webinar_followup', 'webinar_90days', 'webinar_casestudy']);
  const sunday = mhpSchedule(signup, webinar, Date.parse('2026-11-08T00:30:00Z'));
  assert.deepEqual(sunday.map(s => s.template), ['webinar_replay', 'webinar_followup', 'webinar_casestudy']);
  const sheet = mhpSchedule({ ...signup, kind: 'sheet', module: 'Module 12' }, webinar, Date.parse('2026-10-29T10:00:00Z'));
  assert.deepEqual(sheet.map(s => [s.template, s.campaign]), [['sheet_delivery', 'sheet-module-12']]);
  assert.deepEqual(mhpSchedule({ ...signup, kind: 'waitlist' }, webinar, Date.now()), []);
});

test('stories require permission and never carry money amounts', () => {
  const ok = { NAME: 'Sabrina', TOWN: 'Swansea', EMAIL: 's@example.com', DOOR: 'Source', WHAT_YOU_DID: 'Sent my first lawful sourcing letters and booked two viewings.',
    BEFORE: 'Stuck', WHAT_CHANGED: 'Confidence', NUMBER: '2 viewings', WHEN: '2026-10', PUBLISH_NAME: 'First name only', PUBLISH_DOOR: 'Yes', DO_NOT_SAY: '', CONSENT: '1', FORM: 'testimonial' };
  assert.equal(parseMhpStory(form(ok)).doNotSay, null);
  assert.throws(() => parseMhpStory(form({ ...ok, NUMBER: '£12,000' })), /money amounts/);
  assert.throws(() => parseMhpStory(form({ ...ok, CONSENT: '' })), /permission/);
  assert.throws(() => parseMhpStory(form({ ...ok, DOOR: 'Lambo' })), MhpGrowthError);
  assert.throws(() => parseMhpStory(form({ ...ok, WHAT_YOU_DID: 'Too short' })), MhpGrowthError);
});

test('unsubscribe tokens are bound to the prospect and the secret', () => {
  const id = '0b5a3d52-3c6a-4f43-9c0e-0123456789ab', secret = 's'.repeat(48);
  const token = mhpUnsubscribeToken(secret, id);
  assert.equal(verifyMhpUnsubscribeToken(secret, id, token), true);
  assert.equal(verifyMhpUnsubscribeToken('t'.repeat(48), id, token), false);
  assert.equal(verifyMhpUnsubscribeToken(secret, '0b5a3d52-3c6a-4f43-9c0e-0123456789ac', token), false);
  assert.equal(verifyMhpUnsubscribeToken(secret, 'not-a-uuid', token), false);
});

const applicationRecord: MhpApplicationRecord = {
  id: '1b5a3d52-3c6a-4f43-9c0e-0123456789ab', name: 'Sam <script>', email: 'sam@example.com', phone: null, location: 'Swansea', experience: 'None yet',
  door: 'Source', hours: '5 to 10', objective: 'First lawful sourcing letters\nand two viewings', obstacle: 'Time', support: 'Group mentoring', discuss: true,
  marketingConsent: false, source: 'live', status: 'received', createdAt: '2026-11-05T09:00:00.000Z',
};

test('marketing emails escape merge values, fill every placeholder and keep the disclosures', () => {
  for (const template of Object.keys(MHP_MARKETING_TEMPLATES)) {
    for (const bookingUrl of [null, 'https://cal.example/martin?x=1&y=<2>']) {
      const email = renderMhpMarketingEmail({ template, firstName: '<b>Al</b> "x"', prospectId: '0b5a3d52-3c6a-4f43-9c0e-0123456789ab',
        context: { label: 'The <HMO> Checklist', link: 'javascript:alert(1)' }, application: applicationRecord }, 's'.repeat(48), { bookingUrl });
      assert.doesNotMatch(email.html + email.text + email.subject, /\{\{|\}\}|\{%|contact\.|\u2014/);
      assert.doesNotMatch(email.html, /<b>Al<\/b>|javascript:|<HMO>|<script>|<2>/);
      if (template === 'application_notify') {
        // Internal notification to the owner: transactional, no marketing footer or unsubscribe.
        assert.equal(email.stream, 'outbound');
        assert.equal(email.subject, 'New mentoring application: Sam <script>, Source');
        assert.match(email.text, /Door: Source\n/);
        assert.match(email.text, /https:\/\/app\.martinhowardproperty\.co\.uk\/hq\/applications/);
        assert.doesNotMatch(email.html + email.text, /unsubscribe/i);
        continue;
      }
      assert.equal(email.stream, template === 'application_received' ? 'outbound' : 'broadcast');
      for (const body of [email.html, email.text]) {
        assert.match(body, /Martin Howard Property is a trading name of MH196 2026 Ltd/);
        assert.match(body, /Education, not legal, tax or financial advice\. No income is promised\./);
        assert.match(body, /Property Predator, Key Properties UK, Ordris and Hello New Home/);
        assert.match(body, /app\.martinhowardproperty\.co\.uk\/email\/unsubscribe\?p=/);
      }
      const links = [...email.html.matchAll(/href="([^"]+)"/g)].map(m => m[1]!);
      assert.ok(links.every(link => link.startsWith('https://')), `${template} links are absolute https`);
      if (template === 'application_received') {
        if (bookingUrl) assert.match(email.html, /href="https:\/\/cal\.example\/martin\?x=1&amp;y=%3C2%3E"[^>]*>Book your 20-minute call/);
        else assert.match(email.text, /I'll email you within one working day with a time for your call\./);
      }
    }
  }
  const plain = renderMhpMarketingEmail({ template: 'webinar_replay_plain', firstName: 'Al', prospectId: '0b5a3d52-3c6a-4f43-9c0e-0123456789ab', context: {} }, 's'.repeat(48));
  assert.doesNotMatch(plain.html + plain.text, /webinar\/apply|Mentoring|founding/i);
  const replay = renderMhpMarketingEmail({ template: 'webinar_replay', firstName: 'Al', prospectId: '0b5a3d52-3c6a-4f43-9c0e-0123456789ab', context: {} }, 's'.repeat(48));
  assert.match(replay.text, /3\. If you want help putting it into practice/);
  assert.throws(() => renderMhpMarketingEmail({ template: 'application_notify', firstName: null, prospectId: 'x', context: {} }, 's'));
  assert.throws(() => renderMhpMarketingEmail({ template: 'nope', firstName: null, prospectId: 'x', context: {} }, 's'));
});

test('marketing mode defaults to off and test mode requires named inboxes', () => {
  assert.equal(mhpMarketingConfig({}), null);
  const base = { MHP_POSTMARK_SERVER_TOKEN: 'pm', MHP_MARKETING_FROM: 'martin@martinhowardproperty.co.uk' };
  assert.throws(() => mhpMarketingConfig({ ...base, MHP_MARKETING_MODE: 'test' }), /TEST_TO/);
  assert.deepEqual(mhpMarketingConfig({ ...base, MHP_MARKETING_MODE: 'test', MHP_MARKETING_TEST_TO: 'Martin.Howard1984@gmail.com' })?.testRecipients, ['martin.howard1984@gmail.com']);
  assert.equal(mhpMarketingConfig({ ...base, MHP_MARKETING_MODE: 'live' })?.testRecipients, null);
  assert.throws(() => mhpMarketingConfig({ MHP_MARKETING_MODE: 'live' }), /configured/);
  assert.throws(() => mhpMarketingConfig({ MHP_MARKETING_MODE: 'loud' }), /off, test or live/);
});

test('application form validates every field and collects no balances', () => {
  const ok = { NAME: ' Sam Jones ', EMAIL: 'Sam@Example.com', PHONE: '+44 (0)7700 900-123', LOCATION: 'Swansea', EXPERIENCE: 'Some reading or courses',
    DOOR: 'Source', HOURS: '5 to 10', OBJECTIVE: 'Send my first sourcing letters.', OBSTACLE: 'Time', SUPPORT: 'Group mentoring',
    PRICE_UNDERSTOOD: 'yes', DISCUSS: 'yes', CONSENT: '1', FORM: 'apply', email_address_check: '' };
  assert.deepEqual({ ...parseMhpApplication(form(ok)) as MhpApplication }, { name: 'Sam Jones', email: 'sam@example.com', phone: '+44 (0)7700 900-123',
    location: 'Swansea', experience: 'Some reading or courses', door: 'Source', hours: '5 to 10', objective: 'Send my first sourcing letters.',
    obstacle: 'Time', support: 'Group mentoring', discuss: true, optIn: false, source: 'site' });
  assert.equal((parseMhpApplication(form({ ...ok, OPT_IN: '1', SOURCE: 'replay', PHONE: '' })) as MhpApplication).optIn, true);
  assert.equal((parseMhpApplication(form({ ...ok, SOURCE: 'replay', PHONE: '' })) as MhpApplication).phone, null);
  assert.equal(parseMhpApplication(form({ ...ok, email_address_check: 'x' })), 'honeypot');
  for (const bad of <Record<string, string>[]>[{ NAME: '' }, { NAME: 'A\nB' }, { NAME: 'x'.repeat(121) }, { EMAIL: 'nope' }, { PHONE: '0770 abc' }, { PHONE: '1'.repeat(31) },
    { LOCATION: '' }, { EXPERIENCE: 'Expert' }, { DOOR: 'Flip' }, { HOURS: '40' }, { OBJECTIVE: '' }, { OBJECTIVE: 'x'.repeat(601) },
    { OBSTACLE: 'Money' }, { SUPPORT: '1:1' }, { PRICE_UNDERSTOOD: 'no' }, { DISCUSS: 'maybe' }, { CONSENT: '' }, { SOURCE: 'ads' }, { LOCATION: 'Bad\u0007' }]) {
    assert.throws(() => parseMhpApplication(form({ ...ok, ...bad })), MhpGrowthError, JSON.stringify(bad));
  }
});

test('page events accept only allow-listed names and site paths', () => {
  assert.deepEqual(parseMhpEvent('e=live_page_opened&p=/webinar/live/'), { name: 'live_page_opened', path: '/webinar/live/' });
  assert.deepEqual(parseMhpEvent('e=offer_viewed&p=/mentoring/?utm=x#y'), { name: 'offer_viewed', path: '/mentoring/' });
  for (const bad of ['e=watched&p=/webinar/', 'e=live_page_opened&p=https://evil.example/', 'e=live_page_opened', 'e=live_page_opened&p=/a b',
    `e=live_page_opened&p=/${'a'.repeat(130)}`, `e=live_page_opened&p=/x&pad=${'a'.repeat(520)}`]) assert.equal(parseMhpEvent(bad), null, bad);
});

test('application config defaults the owner address and requires an https booking link', () => {
  assert.deepEqual({ ...mhpApplicationConfig({}) }, { notifyTo: 'martin.howard1984@gmail.com', bookingUrl: null });
  assert.equal(mhpApplicationConfig({ MHP_BOOKING_URL: 'https://cal.example/martin', MHP_APPLICATION_NOTIFY_TO: 'Owner@Example.com' }).notifyTo, 'owner@example.com');
  assert.throws(() => mhpApplicationConfig({ MHP_BOOKING_URL: 'http://cal.example/martin' }), /https/);
  assert.throws(() => mhpApplicationConfig({ MHP_APPLICATION_NOTIFY_TO: 'nobody' }), /NOTIFY_TO/);
});

test('sender routes application mail to the transactional stream and the owner, inside the test list', async () => {
  const config = mhpMarketingConfig({ MHP_MARKETING_MODE: 'test', MHP_POSTMARK_SERVER_TOKEN: 'pm', MHP_MARKETING_FROM: 'martin@martinhowardproperty.co.uk',
    MHP_MARKETING_TEST_TO: 'martin.howard1984@gmail.com,sam@example.com', MHP_BOOKING_URL: 'https://cal.example/martin' })!;
  const bodies: Record<string, unknown>[] = [];
  const fetcher = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ ErrorCode: 0, MessageID: `pm-${bodies.length}` }), { status: 200 });
  }) as typeof fetch;
  const sender = createMhpMarketingSender(config, 's'.repeat(48), fetcher);
  const item = (template: string): MhpClaimedSend => ({ id: 'i', prospectId: '0b5a3d52-3c6a-4f43-9c0e-0123456789ab', template, campaign: 'c', context: {},
    email: 'sam@example.com', firstName: 'Sam', level: null, attempts: 1, expiresAt: '2026-12-01T00:00:00Z', application: applicationRecord });
  await sender.send(item('application_notify'));
  await sender.send(item('application_received'));
  await sender.send(item('webinar_90days'));
  assert.deepEqual(bodies.map(b => [b.To, b.MessageStream, Boolean(b.Headers)]), [
    ['martin.howard1984@gmail.com', 'outbound', false], ['sam@example.com', 'outbound', false], ['sam@example.com', 'broadcast', true]]);
  assert.match(String(bodies[1]!.HtmlBody), /Book your 20-minute call/);
  const strict = { ...config, testRecipients: ['sam@example.com'] };
  await assert.rejects(createMhpMarketingSender(strict, 's'.repeat(48), fetcher).send(item('application_notify')), /test list/);
});

test('HQ pages escape applicant text and show the funnel', () => {
  const html = hqApplicationsPage([applicationRecord]);
  assert.match(html, /Sam &lt;script&gt;/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /href="\/hq\/applications"/);
  assert.match(hqApplicationsPage([]), /No applications yet/);
  const growth = hqGrowthPage({ prospects: 10, unsubscribed: 0, signupsToday: 1, byKind: { webinar: 8 }, byLabel: [], byLevel: {}, sends: { sent: 0, pending: 0, failed: 0 },
    stories: 0, storiesWaiting: 0, course: { modules: 0, lessons: 0, loadedAt: null }, learners: 0, lessonsCompleted: 0,
    applications: { total: 2, today: 1 }, applicationsByDoor: { Source: 2 }, events: { live_page_opened: 4 } }, 'off');
  assert.match(growth, /<b>8<\/b><span>webinar registrations/);
  assert.match(growth, /&rarr; 50%<\/span><div class="stat"><b>4<\/b><span>live page opens/);
  assert.match(growth, /&rarr; 50%<\/span><div class="stat"><b>2<\/b><span>applications/);
  assert.match(growth, /recorded manually for now/);
  assert.match(growth, /not proof that anyone watched/);
});

test('course markdown is escaped before formatting and only http(s) links survive', () => {
  const html = renderMhpMarkdown([
    '<script>alert(1)</script> **bold** and *italic* and `x<y`',
    '[ok](https://www.gov.wales/rent-smart) [bad](javascript:alert(1)) \\[DATE\\]',
    '', '| A | B |', '| --- | --- |', '| **x** | <img src=x onerror=alert(1)> |',
    '', '- one', '   - nested', '- two', '', '1. first', '2. second', '', '> quoted', '', '```', '<b>raw</b>', '```',
  ].join('\n'));
  assert.doesNotMatch(html, /<script|<img|javascript:/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /<strong>bold<\/strong> and <em>italic<\/em> and <code>x&lt;y<\/code>/);
  assert.match(html, /<a href="https:\/\/www\.gov\.wales\/rent-smart" rel="noopener noreferrer" target="_blank">ok<\/a> bad\) \[DATE\]/);
  assert.match(html, /<table><thead><tr><th>A<\/th><th>B<\/th><\/tr><\/thead><tbody><tr><td><strong>x<\/strong><\/td><td>&lt;img/);
  assert.match(html, /<ul><li>one<ul><li>nested<\/li><\/ul><\/li><li>two<\/li><\/ul>/);
  assert.match(html, /<ol><li>first<\/li><li>second<\/li><\/ol>/);
  assert.match(html, /<blockquote><p>quoted<\/p><\/blockquote>/);
  assert.match(html, /<pre><code>&lt;b&gt;raw&lt;\/b&gt;<\/code><\/pre>/);
});

test('course bundles are validated before upload', () => {
  const lesson = { number: 1, slug: 'the-words', title: 'The words', minutes: 10, task: 'Write five terms.', body: 'Body' };
  const module = { number: 0, slug: 'start', title: 'Start', promise: null, door: 'foundation', level: 'L1', overview: '', sources: '', lessons: [lesson] };
  assert.equal(parseMhpCourseBundle(JSON.stringify({ modules: [module] })).modules[0]!.lessons[0]!.title, 'The words');
  for (const bad of ['nope', '{}', JSON.stringify({ modules: [module, module] }), JSON.stringify({ modules: [{ ...module, lessons: [{ ...lesson, minutes: 0 }] }] }),
    JSON.stringify({ modules: [{ ...module, lessons: [lesson, lesson] }] })]) {
    assert.throws(() => parseMhpCourseBundle(bad), MhpLearningError);
  }
});

test('multipart reader returns named parts and rejects duplicates', () => {
  const boundary = '----x123';
  const body = Buffer.from([`--${boundary}`, 'Content-Disposition: form-data; name="csrf"', '', 'abc',
    `--${boundary}`, 'Content-Disposition: form-data; name="bundle"; filename="b.json"', 'Content-Type: application/json', '', '{"a":1}', `--${boundary}--`, ''].join('\r\n'));
  const parts = parseMultipart(body, `multipart/form-data; boundary=${boundary}`);
  assert.equal(parts.get('csrf')?.toString(), 'abc');
  assert.equal(parts.get('bundle')?.toString(), '{"a":1}');
  const twice = Buffer.from([`--${boundary}`, 'Content-Disposition: form-data; name="csrf"', '', 'a', `--${boundary}`, 'Content-Disposition: form-data; name="csrf"', '', 'b', `--${boundary}--`].join('\r\n'));
  assert.throws(() => parseMultipart(twice, `multipart/form-data; boundary=${boundary}`));
});
