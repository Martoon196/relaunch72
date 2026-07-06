import test from 'node:test';
import assert from 'node:assert/strict';
import {
  qaS1, qaS2, qaS3, qaS4, qaS5, qaS6, qaS7, qaS8, qaS9,
} from '../src/qa/checks.js';
import { scanBannedPhrases, customerMustWords, phraseRegex } from '../src/qa/banned.js';
import { extractNumbers } from '../src/util/text.js';
import { MockClient } from '../src/llm/mock.js';
import { extractJson } from '../src/llm/json.js';
import { validIntake } from './helpers.js';

const intake = validIntake();

async function mock(stage: string): Promise<Record<string, unknown>> {
  const client = new MockClient(intake);
  const resp = await client.complete({ model: 'mock', maxTokens: 1, system: '', messages: [], meta: { stage, attempt: 1 } });
  const parsed = extractJson(resp.text);
  assert.ok('value' in parsed);
  return JSON.parse(JSON.stringify((parsed as { value: unknown }).value)) as Record<string, unknown>;
}
async function priors(): Promise<Record<string, unknown>> {
  const p: Record<string, unknown> = {};
  for (const s of ['S1', 'S2', 'S3', 'S4', 'S5']) p[s] = await mock(s);
  return p;
}
const has = (issues: { check: string }[], id: string) => issues.some((i) => i.check === id);

// ── extractNumbers band shorthand (S1/S9 fatal root cause) ──────────────────
test('extractNumbers scales a band low bound: "£10–30k" → 10000 & 30000', () => {
  const vals = extractNumbers('£10–30k').map((n) => n.value);
  assert.ok(vals.includes(10000) && vals.includes(30000));
  const vals2 = extractNumbers('£3–10k').map((n) => n.value);
  assert.ok(vals2.includes(3000) && vals2.includes(10000));
});

// ── phraseRegex boundary ────────────────────────────────────────────────────
test('phraseRegex: single word gets a trailing boundary', () => {
  assert.ok(!phraseRegex('elevate').test('an elevated fire risk'));
  assert.ok(!phraseRegex('seamless').test('it works seamlessly'));
  assert.ok(phraseRegex('elevate').test('elevate your brand'));
  assert.ok(phraseRegex('game-changer').test('these game-changers')); // multi-token stays lenient
});

// ── banned scan: negated rebuttal allowed ───────────────────────────────────
test('banned scan allows a negated H3 rebuttal, still flags the plain claim', () => {
  const brand = validIntake({ H3: { never_use: 'naughty, stubborn', must_use: 'settle' } });
  const ok = scanBannedPhrases({ a: "A scared dog isn't being naughty or stubborn." }, brand, { includeCustomerWords: true, stripQuotedText: true });
  assert.equal(ok.length, 0);
  const bad = scanBannedPhrases({ a: 'Your dog is just naughty.' }, brand, { includeCustomerWords: true, stripQuotedText: true });
  assert.ok(bad.some((i) => i.message.includes('naughty')));
});

// ── H3 free-text parse: instruction fragment is not a must-word ─────────────
test('customerMustWords drops a subject-verb instruction clause', () => {
  const coachy = validIntake({ H3: { never_use: 'empower', must_use: "drowning, the deep end, 'the job you were actually promoted into' — and clients are engineers, never 'leaders'" } });
  const must = customerMustWords(coachy);
  assert.ok(must.includes('drowning'));
  assert.ok(must.includes('the job you were actually promoted into'));
  assert.ok(!must.includes('clients are engineers'));
  assert.ok(!must.includes('leaders'));
});

// ── S1 spelled-out multiplier ───────────────────────────────────────────────
test('qaS1 accepts a spelled-out multiplier in leak arithmetic', async () => {
  const out = (await mock('S1')) as { scores: Array<{ leak_cost_estimate: string }> };
  out.scores[0]!.leak_cost_estimate = '£1,700/mo (= two lost customers × £850 average sale, B2).';
  assert.ok(!has(qaS1(out, intake), 's1.leak_number_invented'));
});

// ── S2 verbatim floor + channel stemming ────────────────────────────────────
test('qaS2 accepts a punchy 10-char exact C2 quote', () => {
  const c2 = 'Honestly the first electrician who actually turned up. Sorted the consumer unit same day.';
  const out = { profile_narrative: 'x'.repeat(50), verbatims: ['consumer unit', 'the first electrician'], exclusions: ['time-wasters who haggle'], awareness_stage: 'problem aware', channels: ['Google search'] };
  const issues = qaS2(out, validIntake({ C2: c2, C7: ['Google search'] }));
  assert.ok(!has(issues, 's2.verbatim_too_short'));
  assert.ok(!has(issues, 's2.verbatims_too_few'));
});
test('qaS2 accepts a singular reword of a multi-word C7 entry', () => {
  const out = { profile_narrative: 'x'.repeat(50), verbatims: ['the consumer unit', 'plain English report'], exclusions: ['hagglers'], awareness_stage: 'problem aware', channels: ['letting agent contractor list'] };
  const issues = qaS2(out, validIntake({ C7: ["letting agents' contractor lists"] }));
  assert.ok(!has(issues, 's2.channel_not_from_c7'));
});

// ── S3 voice guardrail with a dash ──────────────────────────────────────────
test('qaS3 accepts a dash-form voice guardrail', async () => {
  const out = (await mock('S3')) as { voice: { tone_rules: string[] } };
  out.voice.tone_rules = out.voice.tone_rules.filter((r) => !/sounds? like/i.test(r));
  out.voice.tone_rules.push('Sounds like a master electrician at your kitchen table — not a national chain reading a script');
  assert.ok(!has(qaS3(out, intake), 's3.voice_guardrail_missing'));
});

// ── S4 outcome patterns: refund allowed, real promise parks ─────────────────
test('qaS4 allows a refund that names the amount, parks a real earnings promise', async () => {
  const p = await priors();
  const base = (await mock('S4')) as { risk_reversal_options: string[] };
  const refund = JSON.parse(JSON.stringify(base));
  refund.risk_reversal_options[0] = "If the wiring isn't right, you'll get every penny back — all £4,200, no quibble.";
  assert.ok(!has(qaS4(refund, intake, p), 's4.risk_reversal_promises_outcome'));
  const descriptive = JSON.parse(JSON.stringify(base));
  descriptive.risk_reversal_options[0] = 'A guarantee our past customers can point to — we redo the work free if a fault appears.';
  assert.ok(!has(qaS4(descriptive, intake, p), 's4.risk_reversal_promises_outcome'));
  const promise = JSON.parse(JSON.stringify(base));
  promise.risk_reversal_options[0] = 'We guarantee results within the first month or your money back.';
  assert.ok(has(qaS4(promise, intake, p), 's4.risk_reversal_promises_outcome'));
});

// ── S4 number: shown bundle sum + per-head division pass; nowhere-number parks
test('qaS4 accepts shown bundle addition and per-head division', async () => {
  const p = await priors();
  const priced = validIntake({ D1: 'Coat — £58. Bed — £119. Feeder — £24. Calm Kit bundle — £165.' });
  const out = (await mock('S4')) as { category_note: string; recommended_stack: Array<{ price: number }> };
  out.recommended_stack[0]!.price = 165;
  out.category_note += ' Bought separately the coat, bed and feeder are £58 + £119 + £24 = £201, so the £165 Calm Kit saves £36.';
  assert.ok(!has(qaS4(out, priced, p), 's4.number_invented'));
  const bad = (await mock('S4')) as { category_note: string };
  bad.category_note += ' Comparable specialists charge £7,543 for this.';
  assert.ok(has(qaS4(bad, priced, p), 's4.number_invented'));
});

// ── S4 d6: instructed name passes, refused thing still flags ─────────────────
test('qaS4 does not flag an offer named from the owner vocabulary', async () => {
  const p = await priors();
  const trades = validIntake({ D1: 'consumer unit swap £595, fuse board upgrade', A2: 'I swap fuse boards and rewire houses', D6: "won't do a board swap and leave known dangerous circuits live" });
  const out = (await mock('S4')) as { recommended_stack: Array<{ name: string }> };
  out.recommended_stack[0]!.name = 'Fuse Board Swap';
  assert.ok(!has(qaS4(out, trades, p), 's4.d6_conflict'));
});

// ── S5 number sees S4 prices; forbidden-channel subset; phase stem ──────────
test('qaS5 accepts a north star naming a real offer price (from S4)', async () => {
  const p = await priors();
  (p.S4 as { recommended_stack: Array<{ price: number }> }).recommended_stack[0]!.price = 165;
  const out = (await mock('S5')) as { north_star: string };
  out.north_star = 'Get the £165 Calm Kit onto 25 orders a month by end of September, up from 11.';
  assert.ok(!has(qaS5(out, validIntake({ G1: 'Calm Kit onto 25 orders a month' }), p), 's5.number_invented'));
});
test('qaS5 does not flag an organic action that only shares a platform word with a paid ban', async () => {
  const p = await priors();
  const out = (await mock('S5')) as { phases: Array<{ actions: Array<{ channel: string }> }>; do_not_do: string[] };
  out.do_not_do = ['Paid Facebook post boosts — they flopped in F3'];
  out.phases[0]!.actions[0]!.channel = 'Facebook groups';
  assert.ok(!has(qaS5(out, intake, p), 's5.action_on_forbidden_channel'));
});
test('qaS5 accepts a phase theme that pluralises the goal noun', async () => {
  const p = await priors();
  const out = (await mock('S5')) as { north_star: string; phases: Array<{ theme: string }> };
  out.north_star = 'Book 2 rewires a month by September';
  out.phases[0]!.theme = 'Land the first rewire on the calendar';
  assert.ok(!has(qaS5(out, validIntake({ G1: 'get to 2 full rewires booked every month' }), p), 's5.phase_theme_off_goal'));
});

// ── S6 number arithmetic + night period ─────────────────────────────────────
test('qaS6 accepts a night-length guarantee and a shown per-session price', async () => {
  const p = await priors();
  (p.S4 as { recommended_stack: Array<{ price: number }> }).recommended_stack[1]!.price = 1800;
  const out = (await mock('S6')) as { about: { body: string } };
  out.about.body += ' A 60-night calmer-or-send-it-back promise. The £1,800 programme is six sessions, so £300 a session.';
  assert.ok(!has(qaS6(out, validIntake({ D4: '60-night calmer or send it back' }), p), 's6.number_invented'));
});

// ── S7 restated S4 price + real C2 quote + warmup none ──────────────────────
test('qaS7 accepts an S4 price restated and a real C2 quote in email copy', async () => {
  const p = await priors();
  (p.S4 as { recommended_stack: Array<{ price: number }> }).recommended_stack[1]!.price = 1800;
  const out = (await mock('S7')) as { promo_seq: Array<{ body: string }> };
  out.promo_seq[0]!.body += ' The Deep End 1:1 is £1,800. One client said: "Sorted the consumer unit same day".';
  const issues = qaS7(out, validIntake({ C2: 'Sorted the consumer unit same day. No drama.' }), p);
  assert.ok(!has(issues, 's7.invented_number'));
  assert.ok(!has(issues, 's7.invented_quote'));
});
test('qaS7 allows list_status none when F2 says there is no list', async () => {
  const p = await priors();
  const out = (await mock('S7')) as { list_warmup_note: { list_status: string; reintro_email: unknown } };
  out.list_warmup_note.list_status = 'none';
  out.list_warmup_note.reintro_email = null;
  assert.ok(!has(qaS7(out, validIntake({ F2: 'no list. keep meaning to collect emails but never get round to it' }), p), 's7.warmup_status_vs_f2'));
});

// ── S8 measurement + case-insensitive quote ─────────────────────────────────
test('qaS8 accepts a physical measurement and a sentence-cased C2 quote', async () => {
  const p = await priors();
  // Run against the same (default) intake the mock quoted; the default C2
  // contains "Sorted the consumer unit same day" verbatim.
  const out = (await mock('S8')) as { posts: Array<{ body: string; hook: string }> };
  out.posts[0]!.body += ' Fits a 45cm to 60cm chest. As one owner put it: "Sorted the consumer unit same day".';
  const issues = qaS8(out, intake, p);
  assert.ok(!has(issues, 's8.invented_numbers'));
  assert.ok(!has(issues, 's8.invented_quote'));
  // …but a fabricated testimonial the customer never wrote still parks.
  const bad = (await mock('S8')) as { posts: Array<{ body: string }> };
  bad.posts[0]!.body += ' A happy buyer wrote: "This completely transformed our whole household overnight".';
  assert.ok(has(qaS8(bad, intake, p), 's8.invented_quote'));
});

// ── S9 band prose + spelled goal + baseline row ─────────────────────────────
test('qaS9 accepts an expanded revenue band and a spelled-out goal', async () => {
  const p = await priors();
  const iv = validIntake({ B1: '£10–30k', G1: 'Sign two corporate cohorts and get the waitlist to ten names by September' });
  const out = (await mock('S9')) as { snapshot: string; goals_90d: string };
  out.snapshot = 'Revenue runs £10,000 to £30,000 a month depending on the season. '.padEnd(140, '.');
  out.goals_90d = 'Sign two corporate cohorts and rebuild the waitlist to ten names by end of September.';
  const issues = qaS9(out, iv, p);
  assert.ok(!has(issues, 's9.number_invented'));
  assert.ok(!has(issues, 's9.goal_not_g1'));
});

// ── S5 forbidden-channel: verbose do_not_do that endorses the channel ───────
test('qaS5 does not flag an organic channel a verbose do_not_do actually endorses', async () => {
  const p = await priors();
  const out = (await mock('S5')) as { phases: Array<{ actions: Array<{ channel: string }> }>; do_not_do: string[] };
  // A real S5 do_not_do paragraph: bans PAID boosts, endorses organic groups.
  out.do_not_do = ['Paid social boosts on any platform: a £40 paid boost returned noise. Organic posts to local groups are already proven to pull enquiries at no cost — every social action here is organic only.'];
  out.phases[0]!.actions[0]!.channel = 'FB groups';
  assert.ok(!has(qaS5(out, intake, p), 's5.action_on_forbidden_channel'));
  // …but reusing the actual banned tactic still flags.
  out.do_not_do = ['No more local magazine advertising — it flopped last year.'];
  out.phases[0]!.actions[0]!.channel = 'local magazine advert';
  assert.ok(has(qaS5(out, intake, p), 's5.action_on_forbidden_channel'));
});
