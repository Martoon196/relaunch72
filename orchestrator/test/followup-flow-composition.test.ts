import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalFlowMessage, FLOW_SMS_DRAFT_SCHEMA, FLOW_WHATSAPP_DRAFT_SCHEMA, flowMessageContract, flowSmsFeedback, parseFlowMessageDraft, previewFlowMessage, readFlowMessage } from '../src/followup-sequences/channel-drafts.js';
import { flowCommandUuid, parseFlowComposition, resolveFlowComposition } from '../src/followup-sequences/composition.js';
import { simulateFollowupFlow, DEFAULT_FLOW_SIMULATION } from '../src/followup-sequences/simulation.js';
import { followupSequenceSha, type FollowupSequenceDefinition } from '../src/followup-sequences/definition.js';
import { sequenceDefinition, sequenceIds } from './helpers/mhp-sequence-fixture.js';
import { ids } from './helpers/mhp-owner-email-fixture.js';
import { renderFlowEditor } from '../src/followup-sequences/editor-view.js';
import { FOLLOWUP_EDITOR_SCRIPT } from '../src/followup-sequences/editor-client.js';
import { MHP_SEQUENCE_EDITOR_SCRIPT } from '../src/mhp/followup-sequence-client.js';
const sms = { schema: FLOW_SMS_DRAFT_SCHEMA, bodyText: 'Hi Alex, your sample follow-up.' };
const whatsapp = { schema: FLOW_WHATSAPP_DRAFT_SCHEMA, templateName: 'sample_followup', language: 'en_GB', bodyText: 'Hi {{1}}, here is your sample {{2}}.' };
const readiness = { email: true, sms: false, whatsapp: false, reply: false, booked: false, purchased: false };
test('proper channel payloads have distinct canonical MIME/source identity without provider approval', () => {
  for (const brand of ['mhp', 'pp'] as const) for (const channel of ['email', 'sms', 'whatsapp'] as const) {
    const contract = flowMessageContract(brand, channel); assert.equal(contract.source, `${brand}.owner-${channel}`);
    assert.equal(contract.kind, channel === 'email' ? 'email' : 'other');
  }
  const canonical = canonicalFlowMessage('whatsapp', whatsapp); assert.deepEqual(readFlowMessage('whatsapp', canonical), whatsapp);
  const preview = previewFlowMessage('whatsapp', whatsapp); assert.equal(preview.providerApproved, false); assert.equal(preview.simulation, true); assert.equal(preview.parameterCount, 2);
  assert.match(preview.text, /Sample 1/u); assert.doesNotMatch(preview.text, /\{\{/u);
});
test('unsupported SMS encoding is retained truthfully; exact supported text uses existing segment calculation', () => {
  assert.equal(flowSmsFeedback('A'.repeat(160)).segments, 1); assert.equal(flowSmsFeedback('A'.repeat(161)).segments, 2);
  const body = '£47 café 👋 {{FIRSTNAME}}'; assert.equal(parseFlowMessageDraft('sms', { ...sms, bodyText: body }).bodyText, body);
  assert.equal(flowSmsFeedback(body).supported, false); assert.equal(flowSmsFeedback(body).segments, null); assert.match(flowSmsFeedback(body).message, /Draft retained/u);
});
test('malformed channel payloads, destinations, placeholders and oversized text fail closed', () => {
  for (const payload of [{ ...sms, recipient: '+44123456789' }, { ...sms, bodyText: '{{PASSWORD}}' }, { ...sms, bodyText: 'A'.repeat(1531) }, { ...sms, bodyText: 'bad\0text' }]) assert.throws(() => parseFlowMessageDraft('sms', payload));
  for (const payload of [{ ...whatsapp, bodyText: '{{2}} only' }, { ...whatsapp, bodyText: '{{NAME}}' }, { ...whatsapp, templateName: 'bad-name' }, { ...whatsapp, providerApproved: true }, { ...whatsapp, bodyText: '{{11}}' }]) assert.throws(() => parseFlowMessageDraft('whatsapp', payload));
  assert.throws(() => readFlowMessage('sms', JSON.stringify(sms)));
});
test('inline copy remains outside the saved sequence, requiring actual matching0021refs after writes', () => {
  const flow = { ...sequenceDefinition, steps: [{ ...sequenceDefinition.steps[0]!, kind: 'sms', contentItemId: '', contentVersionId: '', contentSha256: '' }] };
  const composition = parseFlowComposition(flow, { first: { channel: 'sms', title: 'Sample text', contentItemId: '', previousVersionId: '', payload: sms } });
  assert.doesNotMatch(JSON.stringify(composition.definition), /bodyText|sample follow-up/u);
  assert.throws(() => resolveFlowComposition(composition, {}));
  const step = composition.definition.steps[0]!; if (step.kind === 'wait') throw new Error('message expected');
  assert.throws(() => resolveFlowComposition(composition, { first: step }));
  const saved = resolveFlowComposition(composition, { first: { contentItemId: ids.item, contentVersionId: ids.version, contentSha256: followupSequenceSha(canonicalFlowMessage('sms', sms)) } });
  assert.equal(saved.steps[0]!.kind, 'sms'); assert.doesNotMatch(JSON.stringify(saved), /bodyText/u);
  assert.equal(flowCommandUuid(ids.command, 'first'), flowCommandUuid(ids.command, 'first')); assert.notEqual(flowCommandUuid(ids.command, 'first'), flowCommandUuid(ids.command, 'second'));
});
test('inline editing rejects forged predecessor, unrelated step, cross-channel and extra identity fields', () => {
  const inline = { channel: 'email', title: 'Message', contentItemId: sequenceIds.item, previousVersionId: sequenceIds.version, payload: { schema: 'propertypredator.email-draft/v1', subject: 'Sample', bodyText: 'Hello {{FIRSTNAME}}' } };
  assert.throws(() => parseFlowComposition(sequenceDefinition, { first: inline }));
  assert.throws(() => parseFlowComposition(sequenceDefinition, { unknown: { ...inline, contentItemId: '', previousVersionId: '' } }));
  assert.throws(() => parseFlowComposition(sequenceDefinition, { first: { ...inline, channel: 'sms', contentItemId: '', previousVersionId: '', payload: sms } }));
});

test('actual message-save replay metadata stays outside strict persisted steps after partial-save retry', () => {
  const flow = { ...sequenceDefinition, steps: [{ ...sequenceDefinition.steps[0]!, kind: 'sms', contentItemId: '', contentVersionId: '', contentSha256: '' }] };
  const composition = parseFlowComposition(flow, { first: { channel: 'sms', title: 'Sample text', contentItemId: '', previousVersionId: '', payload: sms } });
  const actual = { contentItemId: ids.item, contentVersionId: ids.version, contentSha256: followupSequenceSha(canonicalFlowMessage('sms', sms)), replayed: true };
  const result = resolveFlowComposition(composition, { first: actual });
  assert.deepEqual(result.steps[0], { key: 'first', kind: 'sms', contentItemId: actual.contentItemId, contentVersionId: actual.contentVersionId, contentSha256: actual.contentSha256 });
  assert.doesNotMatch(JSON.stringify(result), /replayed/u);
  assert.throws(() => resolveFlowComposition(composition, {}));
  assert.throws(() => resolveFlowComposition(composition, { first: { ...actual, contentSha256: '0'.repeat(64) } }));
});
function mixed(): FollowupSequenceDefinition { const message = sequenceDefinition.steps[0]!; if (message.kind === 'wait') throw new Error('message expected');
  return { ...sequenceDefinition, steps: [{ ...message, key: 'email' }, { key: 'wait1', kind: 'wait', minutes: 60 }, { ...message, key: 'sms', kind: 'sms' }, { key: 'wait2', kind: 'wait', minutes: 120 }, { ...message, key: 'wa', kind: 'whatsapp' }] }; }
test('synthetic simulation walks all channels with relative waits while separately reporting actual blockers', () => {
  const result = simulateFollowupFlow(mixed(), readiness); assert.equal(result.state, 'completed'); assert.equal(result.noEffects, true); assert.equal(result.actualStartBlocked, true);
  assert.deepEqual(result.lines.map(line => line.kind), ['email', 'sms', 'whatsapp']); assert.equal(result.lines[1]!.at, '2026-11-01T10:00:00.000Z'); assert.equal(result.lines[2]!.at, '2026-11-01T12:00:00.000Z');
  const real = simulateFollowupFlow(mixed(), readiness, { ...DEFAULT_FLOW_SIMULATION, assumeConnections: false }); assert.equal(real.state, 'held'); assert.deepEqual(real.lines.map(line => line.kind), ['real_blocker']);
});
test('simulated failure/unknown never advances; pause changes acceptance time and unsubscribe stops future steps', () => {
  for (const result of ['failed', 'unknown'] as const) { const simulation = simulateFollowupFlow(mixed(), readiness, { ...DEFAULT_FLOW_SIMULATION, outcomes: [{ position: 2, result }] });
    assert.equal(simulation.lines.filter(line => line.kind !== 'simulated_event').length, 2); assert.equal(simulation.state, result === 'unknown' ? 'held' : 'failed'); }
  const paused = simulateFollowupFlow(mixed(), readiness, { ...DEFAULT_FLOW_SIMULATION, events: [{ atMinutes: 30, type: 'pause' }, { atMinutes: 90, type: 'resume' }] });
  assert.equal(paused.lines.find(line => line.kind === 'sms')!.at, '2026-11-01T10:30:00.000Z'); assert.equal(paused.lines.find(line => line.kind === 'whatsapp')!.at, '2026-11-01T12:30:00.000Z');
  const stopped = simulateFollowupFlow(mixed(), readiness, { ...DEFAULT_FLOW_SIMULATION, events: [{ atMinutes: 30, type: 'unsubscribe' }] }); assert.equal(stopped.state, 'stopped'); assert.equal(stopped.lines.filter(line => line.kind === 'email').length, 1); assert.equal(stopped.lines.some(line => line.kind === 'sms'), false);
});
test('both native facades use one actual client and shared inline editor without provider or identity fields', () => {
  assert.equal(MHP_SEQUENCE_EDITOR_SCRIPT, FOLLOWUP_EDITOR_SCRIPT); assert.doesNotThrow(() => new Function(FOLLOWUP_EDITOR_SCRIPT));
  for (const brand of ['mhp', 'pp'] as const) {
    const html = renderFlowEditor({ profile: { brand, base: brand === 'mhp' ? '/hq/marketing/sequences' : '/portal/follow-ups', libraryHref: null, futureWebinarEntry: brand === 'mhp' },
      csrf: 'synthetic', commandId: ids.command, contentItemId: '', previousVersionId: '', definition: { ...sequenceDefinition, brand }, choices: [] });
    assert.match(html, /name="inlineMessages"/u); assert.match(html, /Simulate journey/u); assert.match(html, /data-message-endpoint/u);
    assert.doesNotMatch(html, /name="(?:workspaceId|userId|recipient|providerApproved|token)"/u);
    if (brand === 'pp') { assert.match(html, /Build now; connect and test before starting/u); assert.doesNotMatch(html, /data-entry-mode/u); }
    else assert.match(html, /data-entry-mode/u);
  }
});
