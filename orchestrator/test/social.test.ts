import test from 'node:test';
import assert from 'node:assert/strict';
import { qaSocialPost } from '../src/qa/checks.js';
import { buildSchedule, composePost, type S8Output } from '../src/social/schedule.js';
import { MockPublisher } from '../src/social/mock.js';
import { MockClient } from '../src/llm/mock.js';
import { extractJson } from '../src/llm/json.js';
import { validIntake } from './helpers.js';

const intake = validIntake();

async function mockStage(stage: string): Promise<Record<string, unknown>> {
  const client = new MockClient(intake);
  const resp = await client.complete({ model: 'mock', maxTokens: 1, system: '', messages: [], meta: { stage, attempt: 1 } });
  const parsed = extractJson(resp.text);
  assert.ok('value' in parsed, `mock ${stage} must emit parseable JSON`);
  return JSON.parse(JSON.stringify((parsed as { value: unknown }).value)) as Record<string, unknown>;
}

async function priorS2S3S8(): Promise<Record<string, unknown>> {
  return { S2: await mockStage('S2'), S3: await mockStage('S3'), S8: await mockStage('S8') };
}

// ─── qaSocialPost: the pre-publish no-invention guard ────────────────────────

test('qaSocialPost passes a clean, in-limit post', async () => {
  const prior = await priorS2S3S8();
  const issues = qaSocialPost({ platform: 'Facebook', text: 'A quick, honest note about the work — priced in writing before anything starts.', day: 1 }, intake, prior);
  assert.deepEqual(issues, []);
});

test('qaSocialPost FATALs an invented statistic in an auto-publishing post', async () => {
  const prior = await priorS2S3S8();
  const issues = qaSocialPost({ platform: 'LinkedIn', text: 'We boost enquiries by 73% within 45 days, guaranteed.', day: 2 }, intake, prior);
  const hit = issues.find((i) => i.check === 'social.number_invented');
  assert.ok(hit && hit.fatal === true, 'invented 73%/45 must fatally block the post');
});

test('qaSocialPost FATALs a fabricated customer quote', async () => {
  const prior = await priorS2S3S8();
  const issues = qaSocialPost({ platform: 'Instagram', text: 'A customer told us: "the best electricians in the entire country by a mile".', day: 3 }, intake, prior);
  assert.ok(issues.some((i) => i.check === 'social.quote_fabricated' && i.fatal));
});

test('qaSocialPost flags a post over the platform character limit', async () => {
  const prior = await priorS2S3S8();
  const longText = 'word '.repeat(80).trim(); // ~400 chars, over X's 280
  const issues = qaSocialPost({ platform: 'X', text: longText, day: 4 }, intake, prior);
  assert.ok(issues.some((i) => i.check === 'social.too_long'));
});

test('qaSocialPost catches an H3 never-word in a post', async () => {
  const prior = await priorS2S3S8();
  // "cheap" is an H3 never-word in the fixture intake.
  const issues = qaSocialPost({ platform: 'Facebook', text: 'Grab this cheap deal on certificates today.', day: 5 }, intake, prior);
  assert.ok(issues.some((i) => i.check === 'banned_phrase'));
});

// ─── buildSchedule: S8 → dated posts ─────────────────────────────────────────

const sampleS8: S8Output = {
  platform_a: 'Facebook',
  platform_b: 'Instagram',
  posts: Array.from({ length: 30 }, (_, i) => ({
    day: i + 1,
    platform: i % 2 === 0 ? 'Facebook' : 'Instagram',
    format: 'text post',
    hook: `Hook ${i + 1}`,
    body: `Body copy for day ${i + 1} that is comfortably long enough to be a real post.`,
    cta: 'Send us a message',
    pillar: 'teach',
  })),
};

test('buildSchedule dates day N at startDate + (N-1) days', () => {
  const planned = buildSchedule(sampleS8, { startDate: '2026-08-01', time: '09:00' });
  assert.equal(planned.length, 30);
  assert.ok(planned[0]!.scheduleDate.startsWith('2026-08-01T09:00'));
  assert.ok(planned[1]!.scheduleDate.startsWith('2026-08-02T09:00'));
  assert.ok(planned[29]!.scheduleDate.startsWith('2026-08-30T09:00'));
});

test('buildSchedule composes hook + body + cta and filters by platform', () => {
  const planned = buildSchedule(sampleS8, { startDate: '2026-08-01', platforms: ['Instagram'] });
  assert.equal(planned.length, 15);
  assert.ok(planned.every((p) => p.platform === 'Instagram'));
  assert.equal(composePost(sampleS8.posts[0]!), 'Hook 1\n\nBody copy for day 1 that is comfortably long enough to be a real post.\n\nSend us a message');
});

test('buildSchedule rejects a bad start date', () => {
  assert.throws(() => buildSchedule(sampleS8, { startDate: 'not-a-date' }), /Invalid --schedule start date/);
});

// ─── MockPublisher: deterministic, records everything ────────────────────────

test('MockPublisher schedules deterministically and records posts', async () => {
  const pub = new MockPublisher();
  const [p] = buildSchedule(sampleS8, { startDate: '2026-08-01' });
  const r = await pub.schedule(p!);
  assert.equal(r.status, 'scheduled');
  assert.equal(r.id, 'mock-facebook-d1');
  assert.equal(r.costUsd, 0);
  assert.equal(pub.scheduled.length, 1);
  assert.equal((await pub.status('mock-facebook-d1')).status, 'scheduled');
});
