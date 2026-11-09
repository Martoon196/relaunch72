import assert from 'node:assert/strict';
import test from 'node:test';
import type { PoolClient } from 'pg';
import {
  PgPortalCreatorWatchService,
  assertCreatorWatchCommandBoundaryReady,
  assertCreatorWatchReadBoundaryReady,
} from '../src/portal/creator-watch-pg-service.js';
import {
  CREATOR_WATCH_INTEGRATION_CONTRACT,
  CREATOR_WATCH_RELEVANCE_ROUTE,
} from '../src/portal/creator-watch-service.js';
import { renderCreatorWatchFragment } from '../src/portal/creator-watch-view.js';

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const PROGRAMME_ID = '33333333-3333-4333-8333-333333333333';
const FAMILY_ID = '44444444-4444-4444-8444-444444444444';
const CONTENT_VERSION_ID = '55555555-5555-4555-8555-555555555555';
const POST_ID = '66666666-6666-4666-8666-666666666666';
const SUBJECT_ID = '77777777-7777-4777-8777-777777777777';
const DECISION_ID = '88888888-8888-4888-8888-888888888888';
const ASSIGNMENT_ID = '99999999-9999-4999-8999-999999999999';
const NOW = Date.parse('2026-09-02T10:00:00.000Z');
const HASH = 'a'.repeat(64);

const family = Object.freeze({
  messageFamilyVersionId: FAMILY_ID,
  familyKey: 'authority.useful_comment',
  versionNumber: 1,
  programmeVersionId: PROGRAMME_ID,
  channel: 'linkedin',
  purpose: 'authority_comment',
  lapsStage: 'prospect',
  audienceSegmentKey: 'property_developers',
  nextAction: 'open_conversation',
  allowedContextFields: ['post_topic', 'relationship_context'],
  toneVariant: 'founder_direct',
  cooldownSeconds: 86_400,
  maxPerCreatorPerUtcDay: 2,
  maxPerChannelPerUtcDay: 20,
  maxPerCreatorRolling7Days: 5,
  configurationSha256: HASH,
  contentVersionId: CONTENT_VERSION_ID,
  contentSha256: 'b'.repeat(64),
  effectiveFrom: '2026-09-01T00:00:00.000Z',
  effectiveUntil: null,
  executionState: 'approved_review_only',
});

const queued = Object.freeze({
  observedPostId: POST_ID,
  subjectVersionId: SUBJECT_ID,
  subjectKey: 'rob_moore',
  subjectVersionNumber: 1,
  network: 'linkedin',
  sourceKind: 'official_provider_event',
  providerPostRefSha256: 'c'.repeat(64),
  sourceReferenceSha256: 'd'.repeat(64),
  postContentSha256: 'e'.repeat(64),
  observedAt: '2026-09-02T09:55:00.000Z',
  expiresAt: '2026-09-02T11:00:00.000Z',
  latestRelevanceDecisionId: null,
  relevanceDecision: null,
  commentPurpose: null,
  noCommentReason: null,
  commentAssignmentId: null,
  effectState: 'unassigned_review_only',
  cooldownUntil: null,
  creatorDayCount: '0',
  creatorWeekCount: '0',
  maxCommentsPerUtcDay: 2,
  maxCommentsRolling7Days: 5,
});

interface Call { readonly sql: string; readonly values: readonly unknown[] }

function client(input: Readonly<{
  families?: readonly object[];
  queue?: readonly object[];
  relevanceDisposition?: 'recorded' | 'replayed';
  initialReplay?: object;
  calls: Call[];
}>): PoolClient {
  let committedReplay: object | null = input.initialReplay ?? null;
  return {
    async query(sql: string, values: readonly unknown[] = []) {
      input.calls.push({ sql, values });
      if (sql.includes('active_portal_session')) return { rows: [{ active: true }] };
      if (sql.includes('resolve_daily_outreach_creator_watch_replay')) {
        return { rows: committedReplay ? [committedReplay] : [] };
      }
      if (sql.includes('read_daily_outreach_message_families')) {
        return { rows: values[1] === 'linkedin' ? [...(input.families ?? [family])] : [] };
      }
      if (sql.includes('read_daily_outreach_creator_watch_queue')) {
        return { rows: [...(input.queue ?? [queued])] };
      }
      if (sql.includes('record_daily_outreach_creator_watch_relevance')) {
        committedReplay = {
          disposition: 'replayed',
          observedPostId: values[1],
          previousDecisionId: values[2],
          decision: values[3],
          commentPurpose: values[4],
          noCommentReason: values[5],
          decisionSource: 'human_review',
          relevanceDecisionId: DECISION_ID,
          decidedByUserId: USER_ID,
          messageFamilyVersionId: null,
          commentAssignmentId: null,
          assignedByUserId: null,
          effectState: null,
        };
        return { rows: [{
          disposition: input.relevanceDisposition ?? 'recorded',
          relevanceDecisionId: DECISION_ID,
        }] };
      }
      if (sql.includes('assign_current_daily_outreach_creator_watch_comment')) {
        committedReplay = {
          ...(committedReplay ?? {}),
          messageFamilyVersionId: values[3],
          commentAssignmentId: ASSIGNMENT_ID,
          assignedByUserId: USER_ID,
          effectState: 'review_only',
        };
        return { rows: [{
          disposition: 'recorded',
          commentAssignmentId: ASSIGNMENT_ID,
          effectState: 'review_only',
          cooldownUntil: '2026-09-03T10:00:00.000Z',
        }] };
      }
      return { rows: [] };
    },
    release() {},
  } as unknown as PoolClient;
}

function service(input: Readonly<{
  families?: readonly object[];
  queue?: readonly object[];
  withCommand?: boolean;
  readCalls?: Call[];
  commandCalls?: Call[];
  initialReplay?: object;
}> = {}) {
  const readCalls = input.readCalls ?? [];
  const commandCalls = input.commandCalls ?? [];
  const readClient = client({
    calls: readCalls,
    ...(input.families ? { families: input.families } : {}),
    ...(input.queue ? { queue: input.queue } : {}),
  });
  const commandClient = client({
    calls: commandCalls,
    ...(input.initialReplay ? { initialReplay: input.initialReplay } : {}),
  });
  return new PgPortalCreatorWatchService({
    principalResolver: {
      resolve: async () => Object.freeze({ userId: USER_ID, workspaceId: WORKSPACE_ID }),
    },
    readPool: { connect: async () => readClient },
    ...(input.withCommand ? { commandPool: { connect: async () => commandClient } } : {}),
    now: () => NOW,
  });
}

const identity = Object.freeze({ sessionToken: 'opaque-session', requestId: 'creator-watch-test' });

test('Creator Watch reads only bounded approved families and hash-only review evidence', async () => {
  const calls: Call[] = [];
  const outcome = await service({ readCalls: calls }).snapshot(identity);
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.snapshot.dataset, 'postgres_authoritative');
  assert.equal(outcome.snapshot.workspace.id, WORKSPACE_ID);
  assert.equal(outcome.snapshot.messageFamilies.length, 1);
  assert.equal(outcome.snapshot.messageFamilies[0]?.executionState, 'approved_review_only');
  assert.equal(outcome.snapshot.queue[0]?.reviewState, 'awaiting_decision');
  assert.equal(outcome.snapshot.queue[0]?.providerEffectsEnabled, false);
  assert.equal(outcome.snapshot.externalEffects, false);
  assert.equal(outcome.snapshot.autonomousCommentEnabled, false);
  assert.equal(outcome.snapshot.commandBoundaryAvailable, false);
  const domainCalls = calls.filter((call) => call.sql.includes('portal.creator-watch.'));
  assert.equal(domainCalls.length, 3);
  assert.ok(domainCalls.every((call) => (
    call.sql.includes('read_daily_outreach_message_families')
    || call.sql.includes('read_daily_outreach_creator_watch_queue')
  )));
  assert.ok(domainCalls.every((call) => !/provider_operations|deliver|send|publish/iu.test(call.sql)));
});

test('Creator Watch parser fails contradictory review evidence closed', async () => {
  const contradictory = { ...queued, relevanceDecision: 'comment', commentPurpose: null };
  const outcome = await service({ queue: [contradictory] }).snapshot(identity);
  assert.deepEqual(outcome, {
    ok: false,
    kind: 'unavailable',
    message: 'The authoritative Creator Watch queue is temporarily unavailable.',
  });
});

test('Creator Watch rejects an over-limit message-family collection rather than truncating silently', async () => {
  const oversized = Array.from({ length: 33 }, (_, index) => ({
    ...family,
    messageFamilyVersionId: `${String(index + 1).padStart(8, '0')}-4444-4444-8444-444444444444`,
    familyKey: `authority.family_${index}`,
  }));
  const outcome = await service({ families: oversized }).snapshot(identity);
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.kind, 'unavailable');
});

test('Creator Watch renderer is truthful about the review-only, no-provider boundary', async () => {
  const result = await service({ withCommand: true }).snapshot(identity);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  let keyNumber = 0;
  const html = renderCreatorWatchFragment(result.snapshot, {
    csrfToken: 'csrf-token',
    nextCommandKey: () => `creator-watch-${++keyNumber}`,
  });
  assert.match(html, /Be useful—or don’t comment/);
  assert.match(html, /Human approval required/);
  assert.match(html, /Autonomous comments OFF/);
  assert.match(html, /1 awaiting review/);
  assert.match(html, /0 review-only assignments/);
  assert.match(html, /0 frequency-capped/);
  assert.match(html, new RegExp(CREATOR_WATCH_RELEVANCE_ROUTE));
  assert.match(html, /Add useful evidence/);
  assert.match(html, /No useful comment/);
  assert.doesNotMatch(html, /provider_operations|publish now|send now/iu);
  assert.doesNotMatch(html, /https?:\/\//u);
});

test('Creator Watch UI disables comment assignment when the approved family is missing', async () => {
  const result = await service({ withCommand: true, families: [] }).snapshot(identity);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const html = renderCreatorWatchFragment(result.snapshot, {
    csrfToken: 'csrf-token',
    nextCommandKey: () => 'missing-family-command',
  });
  assert.match(html, /No current approved comment family is available/u);
  assert.match(html, /Approved family unavailable · no comment/u);
  assert.doesNotMatch(html, /Add useful evidence/u);
});

test('one-tap human relevance atomically pins the server-resolved approved family', async () => {
  const commandCalls: Call[] = [];
  const runtime = service({ withCommand: true, commandCalls });
  const input = Object.freeze({
    observedPostId: POST_ID,
    previousDecisionId: null,
    decision: 'comment' as const,
    commentPurpose: 'add_useful_evidence' as const,
    noCommentReason: null,
    commandKey: 'creator-watch-one-tap-1',
  });
  const first = await runtime.recordRelevance(identity, input);
  const second = await runtime.recordRelevance(identity, input);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (!first.ok || !second.ok) return;
  assert.equal(first.effectState, 'review_only');
  assert.equal(second.disposition, 'replayed');
  assert.equal(first.messageFamilyVersionId, FAMILY_ID);
  assert.equal(first.commentAssignmentId, ASSIGNMENT_ID);
  const relevanceCalls = commandCalls.filter((call) => (
    call.sql.includes('portal.creator-watch.record-human-relevance')
  ));
  const assignmentCalls = commandCalls.filter((call) => (
    call.sql.includes('portal.creator-watch.assign-approved-review-family')
  ));
  assert.equal(relevanceCalls.length, 1);
  assert.equal(assignmentCalls.length, 1);
  assert.ok(relevanceCalls.every((call) => (
    call.sql.includes('record_daily_outreach_creator_watch_relevance')
    && !/provider_operations|send|publish/iu.test(call.sql)
  )));
  for (const call of relevanceCalls) {
    assert.equal(call.values[0], WORKSPACE_ID);
    assert.equal(call.values[1], POST_ID);
    assert.equal(call.values[3], 'comment');
    assert.equal(call.values[4], 'add_useful_evidence');
    assert.ok(Buffer.isBuffer(call.values[6]) && call.values[6].length === 32);
    assert.ok(Buffer.isBuffer(call.values[7]) && call.values[7].length === 32);
    assert.ok(Buffer.isBuffer(call.values[8]) && call.values[8].length === 32);
  }
  for (const call of assignmentCalls) {
    assert.match(call.sql, /assign_current_daily_outreach_creator_watch_comment/u);
    assert.doesNotMatch(call.sql, /content_item_id|approval_request_id|approval_decision_id/u);
    assert.deepEqual(call.values.slice(0, 4), [
      WORKSPACE_ID, POST_ID, DECISION_ID, FAMILY_ID,
    ]);
    assert.ok(Buffer.isBuffer(call.values[4]) && call.values[4].length === 32);
    assert.ok(Buffer.isBuffer(call.values[5]) && call.values[5].length === 32);
  }
  const replayCalls = commandCalls.filter((call) => (
    call.sql.includes('resolve_daily_outreach_creator_watch_replay')
  ));
  assert.equal(replayCalls.length, 2);
  assert.ok(replayCalls.every((call) => (
    call.sql.includes('portal.creator-watch.resolve-command-replay')
    && !/provider_operations|send|publish/iu.test(call.sql)
  )));
  assert.ok(commandCalls.some((call) => /BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY/u.test(call.sql)));
  assert.ok(commandCalls.some((call) => /BEGIN ISOLATION LEVEL READ COMMITTED/u.test(call.sql)));
  assert.ok(commandCalls.every((call) => !/provider_operations|send|publish/iu.test(call.sql)));
});

test('one-tap comment assignment fails closed when approved-family selection is ambiguous', async () => {
  const calls: Call[] = [];
  const duplicate = {
    ...family,
    messageFamilyVersionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    familyKey: 'authority.second_family',
  };
  const outcome = await service({
    withCommand: true,
    commandCalls: calls,
    families: [family, duplicate],
  }).recordRelevance(identity, {
    observedPostId: POST_ID,
    previousDecisionId: null,
    decision: 'comment',
    commentPurpose: 'add_useful_evidence',
    noCommentReason: null,
    commandKey: 'ambiguous-family',
  });
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.kind, 'conflict');
  assert.match(outcome.message, /More than one approved comment family/u);
  assert.equal(calls.some((call) => (
    call.sql.includes('record_daily_outreach_creator_watch_relevance')
    || call.sql.includes('assign_current_daily_outreach_creator_watch_comment')
  )), false);
});

test('one-tap no-comment records only the human decision and never assigns a family', async () => {
  const calls: Call[] = [];
  const outcome = await service({ withCommand: true, commandCalls: calls }).recordRelevance(
    identity,
    {
      observedPostId: POST_ID,
      previousDecisionId: null,
      decision: 'no_comment',
      commentPurpose: null,
      noCommentReason: 'no_useful_contribution',
      commandKey: 'creator-watch-no-comment',
    },
  );
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.messageFamilyVersionId, null);
  assert.equal(outcome.commentAssignmentId, null);
  assert.equal(calls.filter((call) => (
    call.sql.includes('record_daily_outreach_creator_watch_relevance')
  )).length, 1);
  assert.equal(calls.some((call) => (
    call.sql.includes('assign_current_daily_outreach_creator_watch_comment')
  )), false);
});

test('a committed Creator Watch review replays before expired queue evidence is read', async () => {
  const calls: Call[] = [];
  const readCalls: Call[] = [];
  const outcome = await service({
    withCommand: true,
    commandCalls: calls,
    readCalls,
    queue: [{ ...queued, expiresAt: '2026-09-02T09:00:00.000Z' }],
    initialReplay: {
      disposition: 'replayed',
      observedPostId: POST_ID,
      previousDecisionId: null,
      decision: 'comment',
      commentPurpose: 'add_useful_evidence',
      noCommentReason: null,
      decisionSource: 'human_review',
      relevanceDecisionId: DECISION_ID,
      decidedByUserId: USER_ID,
      messageFamilyVersionId: FAMILY_ID,
      commentAssignmentId: ASSIGNMENT_ID,
      assignedByUserId: USER_ID,
      effectState: 'review_only',
    },
  }).recordRelevance(identity, {
    observedPostId: POST_ID,
    previousDecisionId: null,
    decision: 'comment',
    commentPurpose: 'add_useful_evidence',
    noCommentReason: null,
    commandKey: 'creator-watch-expired-replay',
  });
  assert.deepEqual(outcome, {
    ok: true,
    disposition: 'replayed',
    relevanceDecisionId: DECISION_ID,
    messageFamilyVersionId: FAMILY_ID,
    commentAssignmentId: ASSIGNMENT_ID,
    effectState: 'review_only',
  });
  assert.equal(readCalls.length, 0);
  assert.equal(calls.some((call) => (
    call.sql.includes('record_daily_outreach_creator_watch_relevance')
    || call.sql.includes('assign_current_daily_outreach_creator_watch_comment')
  )), false);
});

test('Creator Watch replay rejects command-key reuse for another post before queue reads', async () => {
  const otherPost = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const readCalls: Call[] = [];
  const commandCalls: Call[] = [];
  const outcome = await service({
    withCommand: true,
    readCalls,
    commandCalls,
    initialReplay: {
      disposition: 'replayed',
      observedPostId: POST_ID,
      previousDecisionId: null,
      decision: 'no_comment',
      commentPurpose: null,
      noCommentReason: 'no_useful_contribution',
      decisionSource: 'human_review',
      relevanceDecisionId: DECISION_ID,
      decidedByUserId: USER_ID,
      messageFamilyVersionId: null,
      commentAssignmentId: null,
      assignedByUserId: null,
      effectState: null,
    },
  }).recordRelevance(identity, {
    observedPostId: otherPost,
    previousDecisionId: null,
    decision: 'no_comment',
    commentPurpose: null,
    noCommentReason: 'no_useful_contribution',
    commandKey: 'creator-watch-cross-post-conflict',
  });
  assert.deepEqual(outcome, {
    ok: false,
    kind: 'conflict',
    message: 'That command key has already been used for another Creator Watch review.',
  });
  assert.equal(readCalls.length, 0);
  assert.equal(commandCalls.some((call) => (
    call.sql.includes('record_daily_outreach_creator_watch_relevance')
  )), false);
});

test('Creator Watch replay rejects a non-human decision source before queue reads', async () => {
  const readCalls: Call[] = [];
  const commandCalls: Call[] = [];
  const outcome = await service({
    withCommand: true,
    readCalls,
    commandCalls,
    initialReplay: {
      disposition: 'replayed',
      observedPostId: POST_ID,
      previousDecisionId: null,
      decision: 'no_comment',
      commentPurpose: null,
      noCommentReason: 'no_useful_contribution',
      decisionSource: 'brand_brain_assist',
      relevanceDecisionId: DECISION_ID,
      decidedByUserId: USER_ID,
      messageFamilyVersionId: null,
      commentAssignmentId: null,
      assignedByUserId: null,
      effectState: null,
    },
  }).recordRelevance(identity, {
    observedPostId: POST_ID,
    previousDecisionId: null,
    decision: 'no_comment',
    commentPurpose: null,
    noCommentReason: 'no_useful_contribution',
    commandKey: 'creator-watch-source-conflict',
  });
  assert.deepEqual(outcome, {
    ok: false,
    kind: 'conflict',
    message: 'That command key has already been used for another Creator Watch review.',
  });
  assert.equal(readCalls.length, 0);
  assert.equal(commandCalls.some((call) => (
    call.sql.includes('record_daily_outreach_creator_watch_relevance')
  )), false);
});

test('Creator Watch rejects browser-supplied contradictions before command acquisition', async () => {
  const calls: Call[] = [];
  const outcome = await service({ withCommand: true, commandCalls: calls }).recordRelevance(identity, {
    observedPostId: POST_ID,
    previousDecisionId: null,
    decision: 'no_comment',
    commentPurpose: 'ask_sharp_question',
    noCommentReason: 'irrelevant',
    commandKey: 'contradictory-review',
  });
  assert.deepEqual(outcome, {
    ok: false,
    kind: 'validation',
    message: 'That Creator Watch review choice is invalid.',
  });
  assert.equal(calls.length, 0);
});

test('Creator Watch exact-role readiness checks reject incomplete boundaries', async () => {
  let readSql = '';
  await assertCreatorWatchReadBoundaryReady({ async query(sql: string) {
    readSql = sql;
    return { rows: [{ ready: true }] } as never;
  } } as never);
  assert.match(readSql, /current_user = 'r72_daily_outreach_read'/);
  assert.match(readSql, /read_daily_outreach_message_families/);
  assert.match(readSql, /read_daily_outreach_creator_watch_queue/);
  assert.match(readSql, /NOT pg_catalog\.has_function_privilege/);

  let commandSql = '';
  await assertCreatorWatchCommandBoundaryReady({ async query(sql: string) {
    commandSql = sql;
    return { rows: [{ ready: true }] } as never;
  } } as never);
  assert.match(commandSql, /current_user = 'r72_daily_outreach_command'/);
  assert.match(commandSql, /record_daily_outreach_creator_watch_relevance/);
  assert.match(commandSql, /assign_current_daily_outreach_creator_watch_comment/);
  assert.match(commandSql, /resolve_daily_outreach_creator_watch_replay/);
  assert.match(commandSql, /NOT pg_catalog\.has_function_privilege/u);
  await assert.rejects(assertCreatorWatchReadBoundaryReady({
    async query() { return { rows: [{ ready: false }] } as never; },
  } as never), /read boundary is incomplete/);
});

test('Creator Watch documents the exact server-resolved assignment boundary', () => {
  assert.equal(CREATOR_WATCH_INTEGRATION_CONTRACT.providerEffects, false);
  assert.equal(CREATOR_WATCH_INTEGRATION_CONTRACT.autonomousComments, false);
  assert.match(CREATOR_WATCH_INTEGRATION_CONTRACT.assignmentRequirement, /behind the command boundary/);
  assert.match(CREATOR_WATCH_INTEGRATION_CONTRACT.serverResolvedAssignment,
    /assign_current_daily_outreach_creator_watch_comment/);
});
