import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MhpGrowthError, mhpSchedule, mhpUnsubscribeToken, mhpWebinarConfig, parseMhpSignup, parseMhpStory, verifyMhpUnsubscribeToken, type MhpSignup,
} from '../src/mhp/growth-service.js';
import { mhpMarketingConfig, renderMhpMarketingEmail } from '../src/mhp/marketing-mail.js';
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
  assert.throws(() => parseMhpSignup(form({ ...webinarForm, OPT_IN: '' })), MhpGrowthError);
  assert.throws(() => parseMhpSignup(form({ ...webinarForm, EMAIL: 'not-an-email' })), MhpGrowthError);
  assert.throws(() => parseMhpSignup(form({ ...webinarForm, CHEATSHEET_LINK: 'https://evil.example/webinar/' })), MhpGrowthError);
  assert.throws(() => parseMhpSignup(form({ ...webinarForm, FIRSTNAME: 'A\u0007' })), MhpGrowthError);
});

test('webinar schedule uses UK times and drops reminders that would arrive late', () => {
  const signup = parseMhpSignup(form(webinarForm)) as MhpSignup;
  const early = mhpSchedule(signup, webinar, Date.parse('2026-10-29T10:00:00Z'));
  assert.deepEqual(early.map(s => [s.template, s.dueAt]), [
    ['webinar_confirm', '2026-10-29T10:00:00.000Z'],
    ['webinar_24h', '2026-11-03T19:30:00.000Z'],
    ['webinar_1h', '2026-11-04T18:30:00.000Z'],
    ['webinar_replay', '2026-11-05T08:00:00.000Z'],
    ['webinar_followup', '2026-11-06T08:00:00.000Z'],
  ]);
  assert.ok(early.every(s => Date.parse(s.expiresAt) > Date.parse(s.dueAt) && s.campaign === 'webinar-2026-11-04'));
  const late = mhpSchedule(signup, webinar, Date.parse('2026-11-04T19:00:00Z'));
  assert.deepEqual(late.map(s => s.template), ['webinar_confirm', 'webinar_1h', 'webinar_replay', 'webinar_followup']);
  const after = mhpSchedule(signup, webinar, Date.parse('2026-11-05T12:00:00Z'));
  assert.deepEqual(after.map(s => s.template), ['webinar_replay', 'webinar_followup']);
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

test('marketing emails escape merge values, fill every placeholder and keep the disclosures', () => {
  for (const template of Object.keys(MHP_MARKETING_TEMPLATES)) {
    const email = renderMhpMarketingEmail({ template, firstName: '<b>Al</b> "x"', prospectId: '0b5a3d52-3c6a-4f43-9c0e-0123456789ab',
      context: { label: 'The <HMO> Checklist', link: 'javascript:alert(1)' } }, 's'.repeat(48));
    assert.doesNotMatch(email.html + email.text + email.subject, /\{\{|\}\}|\{%|contact\./);
    assert.doesNotMatch(email.html, /<b>Al<\/b>|javascript:|<HMO>|—/);
    assert.match(email.html, /Education, not legal, tax or financial advice/);
    assert.match(email.html, /Property Predator, Key Properties UK, Ordris and Hello New Home/);
    assert.match(email.html, /app\.martinhowardproperty\.co\.uk\/email\/unsubscribe\?p=/);
  }
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
