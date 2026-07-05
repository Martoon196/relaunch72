import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { s10Lint } from '../src/stages/s10.js';
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

async function fullStack(): Promise<Record<string, unknown>> {
  const outputs: Record<string, unknown> = {};
  for (const stage of ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9']) {
    outputs[stage] = await mockOutput(stage);
  }
  return outputs;
}

let outputs: Record<string, unknown>;
before(async () => {
  outputs = await fullStack();
});

function clone(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(outputs)) as Record<string, unknown>;
}

test('s10Lint passes a consistent full stack (via mock)', () => {
  assert.deepEqual(s10Lint(intake, outputs), []);
});

test('s10Lint flags a price in copy that agrees with neither S4 nor the intake', () => {
  const out = clone();
  const s6 = out.S6 as { home: { sections: Array<{ body: string }> } };
  s6.home.sections[0]!.body += ' Yours today for just £9,999.';
  assert.ok(s10Lint(intake, out).some((i) => i.check === 's10.price_conflict'));
});

test('s10Lint accepts a copy price that matches an S4 recommended price', () => {
  const out = clone();
  const s4 = out.S4 as { recommended_stack: Array<{ price: number }> };
  const s6 = out.S6 as { home: { sections: Array<{ body: string }> } };
  s6.home.sections[0]!.body += ` The main engagement runs at £${s4.recommended_stack[1]!.price}.`;
  assert.ok(!s10Lint(intake, out).some((i) => i.check === 's10.price_conflict'));
});

test('s10Lint enforces S3 voice additions across the copy stages', () => {
  const out = clone();
  const s3 = out.S3 as { voice: { banned_words: string[] } };
  s3.voice.banned_words.push('synergy');
  const s8 = out.S8 as { posts: Array<{ body: string }> };
  s8.posts[0]!.body += ' Pure synergy in action.';
  assert.ok(s10Lint(intake, out).some((i) => i.check === 's10.s3_banned_word' && i.message.includes('S8')));
});

test('s10Lint flags a one-pager that never echoes the positioning', () => {
  const out = clone();
  const s9 = out.S9 as { snapshot: string; market: string; offer: string };
  s9.snapshot = 'Figures hold steady. Demand stays firm. Margins remain sensible. Delivery runs quick.';
  s9.market = 'Local demand stays consistent through seasonal swings, and repeat orders arrive steadily.';
  s9.offer = 'Three tiers exist. Each tier holds a fixed scope. Payment happens upfront.';
  assert.ok(s10Lint(intake, out).some((i) => i.check === 's10.positioning_drift' && i.message.includes('S9')));
});

test('s10Lint flags a promo sequence that never names a stack offer', () => {
  const out = clone();
  const s7 = out.S7 as { promo_seq: Array<{ body: string }> };
  for (const e of s7.promo_seq) e.body = e.body.replace(/The place to start is "[^"]*" — the lowest-friction way in\./, '');
  assert.ok(s10Lint(intake, out).some((i) => i.check === 's10.lead_offer_unsold'));
});

test('s10Lint re-runs the banned-phrase scan over the shipped set', () => {
  const out = clone();
  const s6 = out.S6 as { about: { body: string } };
  s6.about.body += ' A seamless experience awaits.';
  assert.ok(s10Lint(intake, out).some((i) => i.check === 's10.banned_phrase' && i.message.includes('S6')));
});
