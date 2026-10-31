import test from 'node:test';
import assert from 'node:assert/strict';
import { MHP_MARKETING_TEMPLATES } from '../src/mhp/marketing-templates.js';
import { renderMhpMarketingEmail } from '../src/mhp/marketing-mail.js';
const secret = 'synthetic-webinar-copy-secret-at-least32';
const render = (template: 'webinar_confirm' | 'webinar_24h' | 'webinar_1h' | 'webinar_replay') => renderMhpMarketingEmail({ template, firstName: 'Alex',
  prospectId: '0b5a3d52-3c6a-4f43-9c0e-0123456789ab', context: { label: 'Too Many Ideas, Not Enough Income', link: 'https://martinhowardproperty.co.uk/webinar/' } }, secret);
test('confirmation consistently identifies verified YouTube Live and retains the actual live and preparation links', () => {
  const email = render('webinar_confirm');
  assert.match(email.html, /YouTube Live/u); assert.match(email.text, /on YouTube Live/u); assert.doesNotMatch(email.subject + email.html + email.text, /Zoom/iu);
  for (const body of [email.html, email.text]) { assert.match(body, /Wednesday 4 November, 7:30pm UK/u); assert.match(body, /https:\/\/martinhowardproperty\.co\.uk\/webinar\/live\//u); assert.match(body, /https:\/\/martinhowardproperty\.co\.uk\/cheat-sheets\/01\//u); }
});
test('calendar reminders use explicit event date and time in subject, HTML and text without stale relative countdowns', () => {
  for (const key of ['webinar_24h', 'webinar_1h'] as const) {
    const email = render(key), source = MHP_MARKETING_TEMPLATES[key];
    for (const body of [email.subject, email.html, email.text]) { assert.match(body, /Wednesday 4 November/u); assert.match(body, /7:30pm UK/u); }
    assert.doesNotMatch(email.subject + email.html + email.text, /Tomorrow|Starting in an hour|One day to go|Doors open in 50 minutes/iu);
    assert.ok(source.html.includes(`<title>${source.subject}</title>`));
    for (const body of [email.html, email.text]) assert.match(body, /https:\/\/martinhowardproperty\.co\.uk\/webinar\/live\//u);
  }
});
test('verified published course counts replace only the obsolete count and preserve the existing replay route', () => {
  const email = render('webinar_replay');
  for (const body of [email.html, email.text]) { assert.match(body, /25 modules and 186 lessons/u); assert.doesNotMatch(body, /twenty-four modules/iu); assert.match(body, /https:\/\/martinhowardproperty\.co\.uk\/webinar\/replay\//u); }
});
test('attendance copy preserves actual unsubscribe rendering and existing disclosure/footer text', () => {
  for (const key of ['webinar_confirm', 'webinar_24h', 'webinar_1h'] as const) {
    const email = render(key);
    for (const body of [email.html, email.text]) { assert.match(body, /Education, not legal, tax or financial advice/u); assert.match(body, /No income is promised/u); assert.match(body, /Property Predator, Key Properties UK, Ordris and Hello New Home/u); assert.match(body, /MH196 2026 Ltd/u); }
    assert.match(email.unsubscribe, /^https:\/\/app\.martinhowardproperty\.co\.uk\/email\/unsubscribe\?/u);
    assert.doesNotMatch(email.subject + email.html + email.text, /\{\{|\}\}/u);
  }
});
