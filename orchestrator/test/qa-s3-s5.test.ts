import test from 'node:test';
import assert from 'node:assert/strict';
import { qaS3, qaS4, qaS5 } from '../src/qa/checks.js';
import { MockClient } from '../src/llm/mock.js';
import { extractJson } from '../src/llm/json.js';
import { validIntake } from './helpers.js';

const intake = validIntake();

async function mockOutput(stage: string): Promise<Record<string, unknown>> {
  const client = new MockClient(intake);
  const resp = await client.complete({ model: 'mock', maxTokens: 1, system: '', messages: [], meta: { stage, attempt: 1 } });
  const parsed = extractJson(resp.text);
  assert.ok('value' in parsed, `mock ${stage} must emit parseable JSON`);
  return JSON.parse(JSON.stringify((parsed as { value: unknown }).value)) as Record<string, unknown>;
}

test('qaS3 passes a grounded message guide (via mock)', async () => {
  assert.deepEqual(qaS3(await mockOutput('S3'), intake), []);
});

test('qaS3 fails a differentiator that does not quote E2/E3', async () => {
  const out = (await mockOutput('S3')) as { differentiators: string[] };
  out.differentiators[0] = 'They are simply much better at customer service than everyone else around.';
  assert.ok(qaS3(out, intake).some((i) => i.check === 's3.differentiator_untraced'));
});

test('qaS3 fails when H3 never-words are missing from banned_words', async () => {
  const out = (await mockOutput('S3')) as { voice: { banned_words: string[] } };
  out.voice.banned_words = out.voice.banned_words.filter((w) => w !== 'guru');
  assert.ok(qaS3(out, intake).some((i) => i.check === 's3.banned_words_incomplete' && i.message.includes('guru')));
});

test('qaS3 fails a 61+ word elevator pitch and a banned word inside it', async () => {
  const out = (await mockOutput('S3')) as { elevator_pitch: string };
  out.elevator_pitch = Array(31).fill('very good work').join(' ');
  assert.ok(qaS3(out, intake).some((i) => i.check === 's3.pitch_too_long'));
  const out2 = (await mockOutput('S3')) as { elevator_pitch: string };
  out2.elevator_pitch = 'We make the whole thing seamless for every customer we serve.';
  assert.ok(qaS3(out2, intake).some((i) => i.check === 's3.pitch_contains_banned'));
});

test('qaS3 fails sliders that contradict H1', async () => {
  const out = (await mockOutput('S3')) as { voice: { sliders: Record<string, number> } };
  out.voice.sliders.formal_casual = 1; // helper intake says 4
  assert.ok(qaS3(out, intake).some((i) => i.check === 's3.sliders_mismatch'));
});

test('qaS4 passes a grounded offer stack (via mock)', async () => {
  assert.deepEqual(qaS4(await mockOutput('S4'), intake), []);
});

test('qaS4 fails a rationale that cites nothing from the D-fields', async () => {
  const out = (await mockOutput('S4')) as { recommended_stack: Array<{ rationale: string }> };
  out.recommended_stack[0]!.rationale = 'This is a strong opener because customers generally like starting small.';
  assert.ok(qaS4(out, intake).some((i) => i.check === 's4.recommendation_uncited'));
});

test('qaS4 fails an unexplained 10x price jump', async () => {
  const out = (await mockOutput('S4')) as { recommended_stack: Array<{ price: number; rationale: string }> };
  out.recommended_stack[1]!.price = 9000; // B2 is 850
  out.recommended_stack[1]!.rationale = 'Premium tier (D1).';
  assert.ok(qaS4(out, intake).some((i) => i.check === 's4.price_unjustified'));
});

test('qaS4 fails a risk reversal that promises outcomes', async () => {
  const out = (await mockOutput('S4')) as { risk_reversal_options: string[] };
  out.risk_reversal_options[0] = 'We guarantee results within 60 days or you pay nothing at all.';
  assert.ok(qaS4(out, intake).some((i) => i.check === 's4.risk_reversal_promises_outcome'));
});

test('qaS5 passes a plan that fits the owner (via mock)', async () => {
  assert.deepEqual(qaS5(await mockOutput('S5'), intake), []);
});

test('qaS5 hard-fails hours beyond the G2 band', async () => {
  const out = (await mockOutput('S5')) as { weekly_hours_total: number };
  out.weekly_hours_total = 9; // helper G2 is "2–5"
  assert.ok(qaS5(out, intake).some((i) => i.check === 's5.hours_exceed_g2'));
});

test('qaS5 fails an action on a channel the plan itself forbids', async () => {
  const out = (await mockOutput('S5')) as {
    do_not_do: string[];
    phases: Array<{ actions: Array<{ channel: string }> }>;
  };
  out.do_not_do = ['No more local magazine advertising, it flopped badly last year.'];
  out.phases[0]!.actions[0]!.channel = 'local magazine';
  assert.ok(qaS5(out, intake).some((i) => i.check === 's5.action_on_forbidden_channel'));
});

test('qaS5 fails a north star without a number or without G1 grounding', async () => {
  const out = (await mockOutput('S5')) as { north_star: string };
  out.north_star = 'Become the most beloved brand in the region.';
  assert.ok(qaS5(out, intake).some((i) => i.check === 's5.north_star_not_g1'));
});

test('qaS5 fails a channel priority sourced from neither C7 nor F4/F1', async () => {
  const out = (await mockOutput('S5')) as { channel_priorities: string[] };
  out.channel_priorities = ['TikTok'];
  assert.ok(qaS5(out, intake).some((i) => i.check === 's5.channel_priority_unsourced'));
});
