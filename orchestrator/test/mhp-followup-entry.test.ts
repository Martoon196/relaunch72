import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalFollowupSequence, readCanonicalFollowupSequence, followupEntryIntent, parseFollowupSequence, FOLLOWUP_SEQUENCE_V2_SCHEMA } from '../src/followup-sequences/definition.js';
import { followupCanEnableEntry, followupEntryExpiry } from '../src/followup-sequences/entry.js';
import { mhpSequenceNewDraft, mhpSequencePage } from '../src/mhp/followup-sequence-view.js';
import { sequenceDefinition as legacy, sequenceSnapshot as snapshot, sequenceDetail as detail } from './helpers/mhp-sequence-fixture.js';
import { PgMhpGrowthService, mhpSchedule, mhpWebinarConfig, parseMhpSignup, type MhpSignup } from '../src/mhp/growth-service.js';
import { ids } from './helpers/mhp-owner-email-fixture.js';

const automatic = { ...legacy, schema: FOLLOWUP_SEQUENCE_V2_SCHEMA, entry: { mode: 'webinar_signup', source: 'mhp.capture/v2' } };
test('v1 definition bytes and manual intent remain compatible; v2 entry intent is canonical and hash-bound', () => {
  const old = canonicalFollowupSequence(legacy);
  assert.doesNotMatch(old, /"entry"/u); assert.equal(canonicalFollowupSequence(readCanonicalFollowupSequence(old)), old);
  assert.deepEqual(followupEntryIntent(readCanonicalFollowupSequence(old)), { mode: 'manual', source: 'manual_owner' });
  const current = canonicalFollowupSequence(automatic), parsed = readCanonicalFollowupSequence(current);
  assert.deepEqual(followupEntryIntent(parsed), automatic.entry); assert.equal(canonicalFollowupSequence(parsed), current);
  assert.notEqual(current, old);
});
test('entry mode/source pairs, extra fields, old-schema additions and cross-brand source inheritance fail closed', () => {
  for (const value of [{ ...automatic, entry: { mode: 'manual', source: 'mhp.capture/v2' } },
    { ...automatic, entry: { mode: 'webinar_signup', source: 'manual_owner' } },
    { ...automatic, entry: { mode: 'webinar_signup', source: 'mhp.capture/v2', campaign: 'browser-choice' } },
    { ...automatic, entry: undefined }, { ...legacy, entry: automatic.entry }, { ...automatic, brand: 'pp' }]) assert.throws(() => parseFollowupSequence(value));
});
test('future entry needs exact published intent and actual email readiness, never a default from Save', () => {
  const definition = parseFollowupSequence(automatic);
  assert.equal(followupCanEnableEntry(definition, true, true), true);
  assert.equal(followupCanEnableEntry(definition, false, true), false); assert.equal(followupCanEnableEntry(definition, true, false), false);
  assert.equal(followupCanEnableEntry(parseFollowupSequence(legacy), true, true), false);
  const draft = mhpSequenceNewDraft(legacy.campaign, 'synthetic');
  assert.equal((draft.definition as { entry: { mode: string } }).entry.mode, 'manual');
});
test('expiry is an explicit future UTC calendar time and does not normalise an impossible date', () => {
  const now = Date.parse('2026-11-01T00:00:00Z');
  assert.equal(followupEntryExpiry('2026-11-05T19:30', now), '2026-11-05T19:30:00.000Z');
  for (const value of ['', '2026-02-30T10:00', '2026-11-01T00:00', '2026-11-05T19:30Z', '2026-11-05T25:00']) assert.throws(() => followupEntryExpiry(value, now));
});
test('native editor distinguishes saved future intent from an enabled rule and preserves manual entry', () => {
  const future = parseFollowupSequence(automatic);
  const html = mhpSequencePage({ snapshot, detail: { ...detail, definition: future }, csrf: 'synthetic', commandId: 'synthetic', returnCommandId: 'synthetic' });
  assert.match(html, /Future opted-in webinar sign-ups/u); assert.match(html, /saving or publishing does not switch it on/u); assert.match(html, /data-entry-mode/u);
  const manual = mhpSequencePage({ snapshot, detail, csrf: 'synthetic', commandId: 'synthetic', returnCommandId: 'synthetic' });
  assert.match(manual, /manual start with the current webinar sign-ups/u); assert.match(manual, /Future new sign-ups are not automatically enrolled/u);
});

test('published future intent exposes one explicit activation, current rule counters and independent off action', () => {
  const definition = parseFollowupSequence(automatic);
  const rule = { id: ids.request, contentItemId: detail.review.contentItemId, contentVersionId: detail.review.contentVersionId,
    state: 'active' as const, activatedAt: '2026-11-01T00:00:00Z', expiresAt: '2026-11-05T00:00:00Z', heldReason: null,
    cursorSequence: '51', cursorSignupId: ids.prospect, cursorAt: '2026-11-01T01:00:00Z', lastSweptAt: '2026-11-01T01:01:00Z', processed: 51, enrolled: 25, skipped: 20, blocked: 6 };
  const html = mhpSequencePage({ snapshot: { ...snapshot, entryAvailable: true, database: { ...snapshot.database, entryRules: [rule] } },
    detail: { ...detail, definition, blockers: [], review: { ...detail.review, approvalStatus: 'approved', approvalStale: false } }, csrf: 'synthetic', commandId: 'synthetic', returnCommandId: 'synthetic' });
  assert.match(html, /action="\/hq\/marketing\/sequences\/entry-activate"/u); assert.match(html, /name="expiresAt" required/u);
  assert.match(html, /25 enrolled · 20 skipped · 6 blocked · 51 events processed/u); assert.match(html, /Turn off future entry/u);
  assert.match(html, /does not stop or recall messages in existing runs/u); assert.match(html, /pending events from before the new action are not backfilled/u);
});
test('native capture uses the trusted server campaign and actual returned signup identity; automaticfive stays exact', async () => {
  const config = mhpWebinarConfig({ MHP_WEBINAR_CAMPAIGN: 'server-webinar' }), now = Date.parse('2026-10-31T00:00:00Z');
  const signup = parseMhpSignup(new URLSearchParams({ EMAIL: 'test@example.invalid', OPT_IN: '1', CHEATSHEET: 'Webinar signup', CHEATSHEET_LINK: 'https://martinhowardproperty.co.uk/webinar/' })) as MhpSignup;
  const calls: { sql: string; args: unknown[] }[] = [];
  const service = new PgMhpGrowthService({ query: async () => { throw new Error('No public read'); } } as any,
    { query: async (sql: string, args: unknown[]) => { calls.push({ sql, args }); return { rows: [{ outcome: { prospectId: ids.prospect, signupId: ids.request, queued: 5, campaign: config.campaign, entryEventSequence: '21' } }] }; } } as any, config);
  const result = await service.capture({ ...signup, campaign: 'browser-choice', sequenceId: ids.item } as any, Buffer.alloc(32, 7), now);
  assert.equal(result.signupId, ids.request); assert.equal(result.entryEventSequence, '21');
  assert.match(calls[0]!.sql, /^SELECT app_private\.mhp_capture_signup_v2/u); assert.equal(calls[0]!.args.length, 12); assert.equal(calls[0]!.args[11], 'server-webinar');
  assert.deepEqual(JSON.parse(calls[0]!.args[10] as string), mhpSchedule(signup, config, now)); assert.deepEqual(calls[0]!.args[9], Buffer.alloc(32, 7));
});
test('exact campaign capture survives an empty old schedule; nonwebinar capture stays unlinked', async () => {
  const config = mhpWebinarConfig({}), calls: unknown[][] = [];
  const pool = { query: async (_sql: string, args: unknown[]) => { calls.push(args); return { rows: [{ outcome: { prospectId: ids.prospect, signupId: ids.request, queued: 0,
    campaign: args[11], entryEventSequence: args[11] === null ? null : '22' } }] }; } } as any;
  const service = new PgMhpGrowthService(pool, pool, config);
  const signup: MhpSignup = { email: 'test@example.invalid', firstName: 'Test', level: null, consent: true, kind: 'webinar', label: 'Webinar', module: null, link: 'https://martinhowardproperty.co.uk/webinar/' };
  await service.capture(signup, null, Date.parse('2026-11-30T00:00:00Z')); assert.deepEqual(JSON.parse(calls[0]![10] as string), []); assert.equal(calls[0]![11], config.campaign);
  const result = await service.capture({ ...signup, kind: 'waitlist' }, null); assert.equal(result.campaign, null); assert.equal(result.entryEventSequence, null); assert.equal(calls[1]![11], null);
});
test('capture refuses missing or mismatched actual DB event identity without claiming a successful signup', async () => {
  const config = mhpWebinarConfig({}), signup: MhpSignup = { email: 'test@example.invalid', firstName: null, level: null, consent: true, kind: 'webinar', label: 'Webinar', module: null, link: null };
  for (const change of [{ signupId: '' }, { campaign: 'forged' }, { entryEventSequence: null }, { entryEventSequence: '0' }, { queued: -1 }]) {
    const pool = { query: async () => ({ rows: [{ outcome: { prospectId: ids.prospect, signupId: ids.request, queued: 0, campaign: config.campaign, entryEventSequence: '23', ...change } }] }) } as any;
    await assert.rejects(new PgMhpGrowthService(pool, pool, config).capture(signup, null), { status: 503 });
  }
});
