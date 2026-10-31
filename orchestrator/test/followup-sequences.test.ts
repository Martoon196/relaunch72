import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalFollowupSequence, readCanonicalFollowupSequence, parseFollowupSequence, followupTimeline, followupActivationBlockers } from '../src/followup-sequences/definition.js';
import { nextFollowupMessage, followupCanPrepare } from '../src/followup-sequences/state.js';
import { mhpSequencePage, mhpSequenceNewDraft } from '../src/mhp/followup-sequence-view.js';
import { sequenceDefinition as definition, sequenceSnapshot as snapshot, sequenceDetail as detail } from './helpers/mhp-sequence-fixture.js';

test('canonical sequence reuses immutable message references without duplicating bodies', () => {
  const content = canonicalFollowupSequence({ ...definition, title: 'Quote " café £\u2028 end' });
  assert.equal(canonicalFollowupSequence(readCanonicalFollowupSequence(content)), content);
  assert.doesNotMatch(content, /bodyText|recipient|emailAddress/u);
  assert.throws(() => readCanonicalFollowupSequence(JSON.stringify({ ...definition })), /canonical/u);
});
test('ordered waits are relative to provider acceptance, including leading waits and immediate next step', () => {
  const parsed = parseFollowupSequence({ ...definition, steps: [{ key: 'before', kind: 'wait', minutes: 30 }, ...definition.steps] });
  assert.deepEqual(followupTimeline(parsed).map(step => [step.position, step.waitMinutes, step.earliestOffsetMinutes]), [[1, 30, 30], [3, 1440, 1470]]);
  assert.deepEqual(nextFollowupMessage(parsed, -1, '2026-11-01T00:00:00.000Z'), { position: 1, dueAt: '2026-11-01T00:30:00.000Z' });
  assert.deepEqual(nextFollowupMessage(parsed, 1, '2026-11-01T03:00:00.000Z'), { position: 3, dueAt: '2026-11-02T03:00:00.000Z' });
  assert.equal(nextFollowupMessage(parsed, 3, '2026-11-02T03:00:00.000Z'), null);
  assert.throws(() => nextFollowupMessage(parsed, 0.5, 'invalid'));
});
test('invalid identities, arbitrary destinations, repeated keys and malformed bounds cannot enter saved definitions', () => {
  for (const change of [{ title: '' }, { title: ' bad ' }, { expiryHours: 0 }, { expiryHours: 169 }, { expiryHours: 1.5 }, { brand: 'other' }, { campaign: 'space here' },
    { steps: [] }, { steps: [definition.steps[1]] }, { steps: [...definition.steps, definition.steps[0]] }, { steps: [definition.steps[0], { key: 'last', kind: 'wait', minutes: 1 }] },
    { steps: [definition.steps[0], { key: 'wait', kind: 'wait', minutes: -1 }, definition.steps[2]] }, { steps: [{ ...definition.steps[0], contentSha256: 'fake' }] },
    { steps: [{ ...definition.steps[0], recipient: 'somebody@example.invalid' }] }, { stopOn: { reply: true } }, { recipient: 'somebody@example.invalid' }]) {
    assert.throws(() => parseFollowupSequence({ ...definition, ...change }));
  }
});
test('24 blocks are bounded and total waits cannot exceed a year', () => {
  const steps = Array.from({ length: 24 }, (_, n) => ({ ...definition.steps[0]!, key: `message-${n}` }));
  assert.equal(parseFollowupSequence({ ...definition, steps }).steps.length, 24);
  assert.throws(() => parseFollowupSequence({ ...definition, steps: [...steps, { ...steps[0], key: 'extra' }] }));
  assert.throws(() => parseFollowupSequence({ ...definition, steps: [{ key: 'wait-1', kind: 'wait', minutes: 525600 }, definition.steps[0], { key: 'wait-2', kind: 'wait', minutes: 1 }, definition.steps[2]] }));
});
test('SMS/WhatsApp and unconnected stop rules are explicit activation blockers, never skipped', () => {
  const mixed = parseFollowupSequence({ ...definition, stopOn: { reply: true, booked: true, purchased: true },
    steps: [{ ...definition.steps[0], kind: 'sms' }, { ...definition.steps[2], kind: 'whatsapp' }] });
  assert.deepEqual(followupActivationBlockers(mixed, snapshot.readiness), ['sms_not_connected', 'whatsapp_not_connected', 'reply_stop_not_connected', 'booked_stop_not_connected', 'purchased_stop_not_connected']);
  assert.deepEqual(followupActivationBlockers(parseFollowupSequence(definition), snapshot.readiness), []);
});
test('pause, mismatched step, unknown outcome, expired lease, approval and permission each block prepare', () => {
  const input = { state: 'active' as const, currentPosition: 0, deliveryPosition: 0, dueAt: '2026-11-01T00:00:00.000Z', expiresAt: '2026-11-02T00:00:00.000Z',
    now: Date.parse('2026-11-01T01:00:00.000Z'), consent: true, exactApproval: true, unknownProofId: null };
  assert.equal(followupCanPrepare(input), true);
  for (const change of [{ state: 'paused' as const }, { deliveryPosition: 1 }, { consent: false }, { exactApproval: false }, { unknownProofId: 'unknown' }, { dueAt: 'invalid' }, { now: Date.parse('2026-11-03T00:00:00.000Z') }]) assert.equal(followupCanPrepare({ ...input, ...change }), false);
});
test('native owner page shows manual entry, safe version controls, actual setup gaps and readable builder', () => {
  const html = mhpSequencePage({ snapshot, detail, csrf: 'synthetic', commandId: 'synthetic', returnCommandId: 'synthetic' });
  assert.match(html, /17px/u); assert.match(html, /manual start with the current webinar sign-ups/u); assert.match(html, /Future new sign-ups are not automatically enrolled/u);
  assert.match(html, /data-sequence-editor/u); assert.match(html, /Open|Email library/u); assert.match(html, /Publish this version/u);
  assert.match(html, /SMS: setup needed · WhatsApp: setup needed/u); assert.match(html, /No message has been handed off|No matching runs yet/u);
  assert.doesNotMatch(html, /sourceSystem|api[_-]?key|access[_-]?token/u);
});
test('a published sequence has a separate explicit Start and shows blocked mixed channels', () => {
  const published = { ...detail, review: { ...detail.review, approvalStatus: 'approved' as const, approvalStale: false } };
  const html = mhpSequencePage({ snapshot, detail: published, csrf: 'synthetic', commandId: 'synthetic', returnCommandId: 'synthetic' });
  assert.match(html, /action="\/hq\/marketing\/sequences\/enrol"/u); assert.match(html, /Start remaining eligible sign-ups/u);
  assert.match(html, /not already enrolled in this version/u); assert.match(html, /A new version starts from the first step and can repeat earlier emails/u);
  assert.match(html, /does not enrol anyone or send a message/u);
  const blocked = mhpSequencePage({ snapshot, detail: { ...published, blockers: ['whatsapp_not_connected'] }, csrf: 'synthetic', commandId: 'synthetic', returnCommandId: 'synthetic' });
  assert.match(blocked, /<button data-saved-required disabled>Start remaining eligible sign-ups/u); assert.match(blocked, /approved templates/u);
});
test('view escapes names/content references and new draft starts with no fake saved message', () => {
  const malicious = { ...definition, title: '<script>bad</script>' };
  const html = mhpSequencePage({ snapshot, draft: { ...mhpSequenceNewDraft(definition.campaign, 'synthetic'), definition: malicious }, csrf: '<bad>', commandId: 'synthetic', returnCommandId: 'synthetic' });
  assert.doesNotMatch(html, /<script>bad<\/script>/u); assert.match(html, /&lt;script&gt;/u);
  assert.deepEqual((mhpSequenceNewDraft(definition.campaign, 'synthetic').definition as { steps: unknown[] }).steps, []);
});

test('old mixed history is displayed with proper-channel review guidance and no Start', () => {
  const mixed = parseFollowupSequence({ ...definition, steps: [{ ...definition.steps[0]!, kind: 'sms' }] });
  const html = mhpSequencePage({ snapshot, detail: { ...detail, definition: mixed, local: { ...detail.local, valid: false, exact: null },
    blockers: ['email_version_not_ready', 'sms_not_connected'], timeline: followupTimeline(mixed) }, csrf: 'synthetic', commandId: 'synthetic', returnCommandId: 'synthetic' });
  assert.match(html, /Text message/u); assert.match(html, /proper current local message version for each channel/u);
  assert.doesNotMatch(html, /action="\/hq\/marketing\/sequences\/enrol"/u);
});
