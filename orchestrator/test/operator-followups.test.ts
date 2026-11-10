/**
 * Operator follow-up tools: the plain-step builder against the real sequence
 * parsers, and the tools against a real MhpSequenceService over stub storage.
 * Nothing here can publish, enrol, schedule or send: those tools do not exist.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { CompanyContentService, CompanyContentTransactionRunner } from '../src/company-content-pg/index.js';
import type { DatabaseRequestContext } from '../src/db/rls.js';
import { parseFlowComposition } from '../src/followup-sequences/composition.js';
import { MhpSequenceService, type MhpSequenceRepository } from '../src/mhp/followup-sequence-service.js';
import { loadOperatorConfig } from '../src/operator/config.js';
import { buildSequence, describeSequence } from '../src/operator/sequence-builder.js';
import { createFollowupTools } from '../src/operator/followup-tools.js';
import { createOperatorTools } from '../src/operator/tools.js';
import { OperatorSessions } from '../src/operator/sessions.js';
import { PP_FOLLOWUP_CAMPAIGN } from '../src/portal/followup-flow-service.js';
import { ids, identity, now, snapshot as emailSnapshot, review as emailReview, local as emailLocal } from './helpers/mhp-owner-email-fixture.js';
import { sequenceIds, sequenceDefinition, sequenceSnapshot, sequenceDetail } from './helpers/mhp-sequence-fixture.js';

const CAMPAIGN = sequenceDefinition.campaign;
const savedEmail = { channel: 'email', contentItemId: ids.item, contentVersionId: ids.version, contentSha256: emailReview.contentSha256 };

test('plain steps become exactly the stored definition and inline drafts the real parsers accept', () => {
  const built = buildSequence('mhp', CAMPAIGN, {
    title: 'After the land webinar', entry: 'webinar_signup', retryWindowHours: 24, stopOn: { reply: true },
    steps: [
      { email: { subject: 'Thanks for registering, {{FIRSTNAME}}', body: 'Here is your link: {{LINK}}\n\n{{UNSUBSCRIBE}}' } },
      { wait: { days: 1, hours: 2 } },
      { sms: { body: 'Starting soon {{FIRSTNAME}}: {{LINK}}', name: 'Reminder text' } },
      { wait: { minutes: 30 } },
      { saved: savedEmail },
    ],
  });
  const parsed = parseFlowComposition(built.definition, built.inlineMessages);
  assert.equal(parsed.definition.schema, 'growthhq.followup-sequence/v2');
  assert.deepEqual(parsed.definition.entry, { mode: 'webinar_signup', source: 'mhp.capture/v2' });
  assert.deepEqual(parsed.definition.stopOn, { reply: true, booked: false, purchased: false });
  assert.deepEqual(parsed.definition.steps.map((s) => s.kind), ['email', 'wait', 'sms', 'wait', 'email']);
  assert.deepEqual(parsed.definition.steps.filter((s) => s.kind === 'wait').map((s) => 'minutes' in s && s.minutes), [1560, 30]);
  assert.deepEqual(Object.keys(parsed.inlineMessages), ['s1', 's3']);
  assert.equal(parsed.inlineMessages.s3!.title, 'Reminder text');
  assert.equal(parsed.inlineMessages.s1!.title, 'After the land webinar · step 1');
  const last = parsed.definition.steps[4]!;
  assert.ok(last.kind === 'email' && last.contentVersionId === ids.version, 'saved messages pass through unchanged');

  const pp = buildSequence('pp', PP_FOLLOWUP_CAMPAIGN, { title: 'PP nurture', steps: [{ email: { subject: 'Hi', body: 'Body' } }] });
  assert.deepEqual(parseFlowComposition(pp.definition, pp.inlineMessages).definition.entry, { mode: 'manual', source: 'manual_owner' });
});

test('the builder and parsers refuse malformed sequences with plain messages', () => {
  const bad = (sequence: unknown, brand: 'pp' | 'mhp' = 'mhp') => () => { const b = buildSequence(brand, CAMPAIGN, sequence); parseFlowComposition(b.definition, b.inlineMessages); };
  assert.throws(bad({ title: 'x', steps: [] }), /between 1 and 24/);
  assert.throws(bad({ title: 'x', steps: [{ email: { subject: 'a', body: 'b' } }, { wait: { days: 1 } }] }), /End the sequence with a message/);
  assert.throws(bad({ title: 'x', steps: [{ email: { subject: 'a', body: 'Hi {{NAME}}' } }] }), /double braces/);
  assert.throws(bad({ title: 'x', steps: [{ email: { subject: 'a', body: 'b' }, wait: { days: 1 } }] }), /exactly one of/);
  assert.throws(bad({ title: 'x', steps: [{ whatsapp: { body: 'b' } }] }), /WhatsApp templates are chosen from saved/);
  assert.throws(bad({ title: 'x', steps: [{ saved: { channel: 'email', contentItemId: ids.item } }] }), /contentSha256/);
  assert.throws(bad({ title: 'x', entry: 'webinar_signup', steps: [{ email: { subject: 'a', body: 'b' } }] }, 'pp'), /only for MHP/);
  assert.throws(bad({ title: 'x', retryWindowHours: 500, steps: [{ email: { subject: 'a', body: 'b' } }] }), /1–168/);
  assert.throws(bad({ title: 'x', stopOn: { opened: true }, steps: [{ email: { subject: 'a', body: 'b' } }] }), /stopOn/);
});

test('a stored sequence reads back as plain steps that rebuild the same steps', () => {
  const described = describeSequence(sequenceDetail.definition, [{ review: { contentVersionId: ids.version }, payload: { subject: 'Hello' } }]);
  assert.deepEqual(described.steps[1], { wait: { minutes: 1440 } });
  assert.deepEqual((described.steps[0] as { currentText?: unknown }).currentText, { subject: 'Hello' });
  const rebuilt = buildSequence('mhp', CAMPAIGN, described);
  const parsed = parseFlowComposition(rebuilt.definition, rebuilt.inlineMessages);
  assert.deepEqual(parsed.definition.steps.map((s) => s.kind === 'wait' ? s.minutes : s.contentVersionId), [ids.version, 1440, ids.version]);
});

function sequenceService() {
  const calls: string[] = [];
  const context = (value: DatabaseRequestContext) => { assert.equal(value.userId, identity.userId); assert.equal(value.workspaceId, identity.workspaceId); };
  const repository: MhpSequenceRepository = { snapshot: async () => sequenceSnapshot.database, local: async (_given, version) => version ? sequenceDetail.local : null,
    command: async () => { calls.push('command'); throw new Error('no enrolment from the operator'); } };
  const adapter: Pick<CompanyContentService, 'createVersion' | 'refreshSourceAttestation'> = {
    createVersion: async (given, command) => { context(given); calls.push(`save:${command.title}`); return { disposition: 'applied', contentItemId: sequenceIds.item, contentVersionId: sequenceIds.version, versionNumber: 1, contentSha256: 'a'.repeat(64), sourceAttestationId: ids.proof, sourceAttestationExpiresAt: new Date(now + 900_000).toISOString() }; },
    refreshSourceAttestation: async () => { calls.push('refresh'); throw new Error('publish is not an operator action'); },
  };
  const service = new MhpSequenceService({
    marketingWorkspace: { snapshot: async (given) => ({ userId: given.userId, selectedWorkspaceId: given.workspaceId, personalWorkspaceId: ids.prospect, marketingWorkspaceId: identity.workspaceId, marketingSelected: true }) },
    repository, reader: { listCatalog: async () => sequenceSnapshot.catalog, getExactReview: async () => sequenceDetail.review },
    adapter, adapterTransactions: { run: async () => { throw new Error('no publish'); } } as unknown as CompanyContentTransactionRunner,
    approvals: { requestApproval: async () => { calls.push('approve'); throw new Error('no approval'); }, decideApproval: async () => { calls.push('approve'); throw new Error('no approval'); } },
    emails: { snapshot: async () => emailSnapshot, review: async () => ({ review: emailReview, local: emailLocal }), get status() { return emailSnapshot.status; } },
    campaign: CAMPAIGN,
  });
  return { service, calls };
}

const sessions = { identity: async () => ({ ...identity }) };
const links = { ppOrigin: 'https://hq.propertypredator.com', mhpOrigin: 'https://app.martinhowardproperty.co.uk' };

test('check and save-draft run through the real MHP sequence service; nothing publishes, enrols or sends', async () => {
  const { service, calls } = sequenceService();
  const tools = createFollowupTools({ sessions, sequences: service, links });
  const tool = (name: string) => tools.find((t) => t.name === name)!;
  const sequence = { title: 'Land webinar follow-up', steps: [{ saved: savedEmail }, { wait: { days: 2 } }, { saved: savedEmail }] };
  const checked = await tool('followup_sequence_check').run({ brand: 'mhp', sequence, scenario: 'reply' }) as { timeline: unknown[]; blockers: string[]; simulation: unknown };
  assert.equal(checked.timeline.length, 2);
  assert.deepEqual(checked.blockers, []);
  assert.ok(checked.simulation);
  await assert.rejects(tool('followup_sequence_check').run({ brand: 'mhp', sequence, scenario: 'boom' }), /scenario must be one of/);
  const saved = await tool('followup_sequence_save_draft').run({ brand: 'mhp', sequence }) as { contentItemId: string; note: string };
  assert.equal(saved.contentItemId, sequenceIds.item);
  assert.match(saved.note, /Draft only: nothing was approved, scheduled or sent/);
  assert.match(saved.note, /https:\/\/app\.martinhowardproperty\.co\.uk\/hq\/marketing\/sequences/);
  assert.deepEqual(calls, ['save:Land webinar follow-up']);
  await assert.rejects(tool('followup_sequence_save_draft').run({ brand: 'mhp', sequence, contentItemId: sequenceIds.item }), /both contentItemId and previousVersionId/);
  const got = await tool('followup_sequence_get').run({ brand: 'mhp', contentItemId: sequenceIds.item, contentVersionId: sequenceIds.version }) as { sequence: { steps: unknown[] }; approvalStatus: string };
  assert.equal(got.sequence.steps.length, 3);
  await assert.rejects(tool('followups_overview').run({ brand: 'pp' }), /not composed/);
  await assert.rejects(tool('owner_emails_overview').run({}), /not composed/);
  assert.deepEqual(calls, ['save:Land webinar follow-up'], 'no approval, publish or enrolment call was ever made');
});

test('the operator catalogue offers drafting but never publish, enrol, schedule or send tools', () => {
  const config = loadOperatorConfig({ R72_OPERATOR_TOKEN: 't'.repeat(40), R72_OPERATOR_USER_ID: ids.user, R72_OPERATOR_WRITES: 'enabled' })!;
  const operatorSessions = new OperatorSessions(config, { pp: undefined, mhp: undefined });
  const crm = { snapshot: async () => null, createLead: async () => ({ ok: true as const, disposition: 'applied' as const }), moveOpportunity: async () => ({ ok: true as const, disposition: 'applied' as const }), completeTask: async () => ({ ok: true as const, disposition: 'applied' as const }) };
  const withWrites = createOperatorTools({ sessions: operatorSessions, crm, writes: true, followups: { links } }).listTools().map((t) => t.name);
  const readOnly = createOperatorTools({ sessions: operatorSessions, crm, writes: false, followups: { links } }).listTools().map((t) => t.name);
  for (const name of ['followups_overview', 'followup_sequence_get', 'followup_sequence_check', 'owner_emails_overview', 'owner_email_get', 'owner_email_preview']) {
    assert.ok(readOnly.includes(name), name);
  }
  for (const name of ['followup_sequence_save_draft', 'owner_email_save_draft']) {
    assert.ok(withWrites.includes(name) && !readOnly.includes(name), name);
  }
  assert.deepEqual(withWrites.filter((n) => /publish_sequence|enrol|schedule|send_email|activate|test_send|queue/.test(n)), []);
  assert.equal(new Set(withWrites).size, withWrites.length, 'tool names are unique');
});
