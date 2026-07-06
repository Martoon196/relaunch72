import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { qaS6, qaS7, qaS8, qaS9 } from '../src/qa/checks.js';
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

// S6–S9 QA reads prior-stage outputs — build the same priors the mock
// pipeline would have produced.
const prior: Record<string, unknown> = {};
before(async () => {
  for (const stage of ['S1', 'S2', 'S3', 'S4', 'S5']) prior[stage] = await mockOutput(stage);
});

interface S6Shape {
  home: {
    hero_variants: Array<{ angle: string; cta: string }>;
    sections: Array<{ id: string; body: string; cta?: string }>;
  };
  sales_page: { sections: Array<{ id: string; body: string }> };
}

test('qaS6 passes a grounded website pack (via mock)', async () => {
  assert.deepEqual(qaS6(await mockOutput('S6'), intake, prior), []);
});

test('qaS6 FATALLY fails a quoted passage no input ever said', async () => {
  const out = (await mockOutput('S6')) as unknown as S6Shape;
  out.home.sections[0]!.body += ' As one client told us: "this quote was never said by anyone at all".';
  const issues = qaS6(out, intake, prior);
  assert.ok(issues.some((i) => i.check === 's6.quote_fabricated'));
});

test('qaS6 flags an invented percentage and figure (retryable)', async () => {
  const out = (await mockOutput('S6')) as unknown as S6Shape;
  out.home.sections[0]!.body += ' Nine out of ten is not enough: 97% of customers agree.';
  out.sales_page.sections[0]!.body += ' Join over 5,000 happy customers.';
  const issues = qaS6(out, intake, prior);
  assert.equal(issues.filter((i) => i.check === 's6.number_invented').length, 2);
});

test('qaS6 FATALLY fails credential words no input supports', async () => {
  const out = (await mockOutput('S6')) as unknown as S6Shape;
  out.home.sections[0]!.body += ' An award-winning, top-rated team.';
  const issues = qaS6(out, intake, prior);
  assert.ok(issues.some((i) => i.check === 's6.proof_word_unsupported' && i.fatal === true));
});

test('qaS6 fails two heroes opening from the same angle', async () => {
  const out = (await mockOutput('S6')) as unknown as S6Shape;
  out.home.hero_variants[1]!.angle = out.home.hero_variants[0]!.angle;
  assert.ok(qaS6(out, intake, prior).some((i) => i.check === 's6.hero_angles_same'));
});

test('qaS6 fails a generic call to action', async () => {
  const out = (await mockOutput('S6')) as unknown as S6Shape;
  out.home.sections[0]!.cta = 'Learn more';
  assert.ok(qaS6(out, intake, prior).some((i) => i.check === 's6.cta_generic'));
});

interface S7Shape {
  welcome_seq: Array<{ subject_variants: Array<{ subject: string; hook_category: string }>; preview: string; body: string; cta: string }>;
  list_warmup_note: { list_status: string; reintro_email: unknown };
}

test('qaS7 passes a grounded email pack (via mock)', async () => {
  assert.deepEqual(qaS7(await mockOutput('S7'), intake, prior), []);
});

test('qaS7 fails a link-CTA email with no {{link}} at all', async () => {
  const out = (await mockOutput('S7')) as unknown as S7Shape;
  out.welcome_seq[0]!.body = out.welcome_seq[0]!.body.replace('{{link}}', 'click below'); // link-CTA, now 0 links
  const issues = qaS7(out, intake, prior);
  assert.ok(issues.some((i) => i.check === 's7.cta_count' && i.message.includes('welcome_seq[0]')));
});

test('qaS7 accepts {{link}} in both body and cta line (one destination)', async () => {
  const out = (await mockOutput('S7')) as unknown as S7Shape;
  out.welcome_seq[1]!.cta = 'Book your slot at {{link}}'; // link in cta AND body = one destination
  assert.ok(!qaS7(out, intake, prior).some((i) => i.check === 's7.cta_count' && i.message.includes('welcome_seq[1]')));
});

test('qaS7 still flags {{link}} in a subject or preview', async () => {
  const out = (await mockOutput('S7')) as unknown as S7Shape;
  out.welcome_seq[0]!.subject_variants[0]!.subject = 'Grab it here {{link}}';
  assert.ok(qaS7(out, intake, prior).some((i) => i.check === 's7.cta_count' && i.message.includes('subject')));
});

test('qaS7 accepts a reply-CTA email with no {{link}}', async () => {
  const out = (await mockOutput('S7')) as unknown as S7Shape;
  out.welcome_seq[0]!.body = out.welcome_seq[0]!.body.replace('{{link}}', 'and tell me how it went');
  out.welcome_seq[0]!.cta = 'Reply and tell me what your electrics are doing';
  assert.ok(!qaS7(out, intake, prior).some((i) => i.check === 's7.cta_count' && i.message.includes('welcome_seq[0]')));
});

test('qaS7 fails three subject lines sharing a hook category', async () => {
  const out = (await mockOutput('S7')) as unknown as S7Shape;
  const cat = out.welcome_seq[0]!.subject_variants[0]!.hook_category;
  for (const v of out.welcome_seq[0]!.subject_variants) v.hook_category = cat;
  assert.ok(qaS7(out, intake, prior).some((i) => i.check === 's7.hook_categories_not_distinct'));
});

test('qaS7 fails literal URLs and unknown merge tokens', async () => {
  const out = (await mockOutput('S7')) as unknown as S7Shape;
  out.welcome_seq[0]!.body += ' Or visit https://example.com and use {{company_name}}.';
  const issues = qaS7(out, intake, prior);
  assert.ok(issues.filter((i) => i.check === 's7.url_or_unknown_token').length >= 2);
});

test('qaS7 fabricated quote (fatal) and invented percentage (retryable)', async () => {
  const out = (await mockOutput('S7')) as unknown as S7Shape;
  out.welcome_seq[0]!.body += ' As Sarah from Leeds put it: "absolutely transformed everything for our family".';
  out.welcome_seq[1]!.body += ' Readers see a 45% lift on average.';
  const issues = qaS7(out, intake, prior);
  assert.ok(issues.some((i) => i.check === 's7.invented_quote'));
  assert.ok(issues.some((i) => i.check === 's7.invented_percentage'));
});

test('qaS7 fails a cold list without the warm-up email', async () => {
  const out = (await mockOutput('S7')) as unknown as S7Shape;
  out.list_warmup_note.list_status = 'cold';
  out.list_warmup_note.reintro_email = null;
  assert.ok(qaS7(out, intake, prior).some((i) => i.check === 's7.warmup_inconsistent'));
});

interface S8Shape {
  platform_a: string;
  platform_b: string;
  posts: Array<{ day: number; platform: string; format: string; body: string; pillar: string }>;
}

test('qaS8 passes a grounded content month (via mock)', async () => {
  assert.deepEqual(qaS8(await mockOutput('S8'), intake, prior), []);
});

test('qaS8 fails platforms that are not the F5 picks', async () => {
  const out = (await mockOutput('S8')) as unknown as S8Shape;
  out.platform_a = 'TikTok';
  assert.ok(qaS8(out, intake, prior).some((i) => i.check === 's8.platforms_match_f5'));
});

test('qaS8 fails a duplicated day and a format foreign to its platform', async () => {
  const out = (await mockOutput('S8')) as unknown as S8Shape;
  out.posts[1]!.day = 1;
  out.posts[0]!.format = 'reel'; // post 0 runs on Facebook
  const issues = qaS8(out, intake, prior);
  assert.ok(issues.some((i) => i.check === 's8.days_incomplete'));
  assert.ok(issues.some((i) => i.check === 's8.format_invalid_for_platform'));
});

test('qaS8 fails a month where one pillar dominates', async () => {
  const out = (await mockOutput('S8')) as unknown as S8Shape;
  for (const p of out.posts) if (p.pillar === 'conversation') p.pillar = 'teach';
  const issues = qaS8(out, intake, prior);
  assert.ok(issues.some((i) => i.check === 's8.pillar_distribution'));
});

test('qaS8 flags invented stats (retryable) and fabricated quotes (fatal)', async () => {
  const out = (await mockOutput('S8')) as unknown as S8Shape;
  out.posts[0]!.body += ' Over 5,000 jobs completed.';
  out.posts[2]!.body += ' One follower wrote: "the best decision our business ever made, hands down".';
  const issues = qaS8(out, intake, prior);
  assert.ok(issues.some((i) => i.check === 's8.invented_numbers'));
  assert.ok(issues.some((i) => i.check === 's8.invented_quote'));
});

interface S9Shape {
  snapshot: string;
  goals_90d: string;
  plan_summary: string;
  numbers_table: Array<{ label: string; value: string; source: string }>;
}

test('qaS9 passes a grounded one-pager (via mock)', async () => {
  assert.deepEqual(qaS9(await mockOutput('S9'), intake, prior), []);
});

test('qaS9 flags a table figure absent from its source (retryable)', async () => {
  const out = (await mockOutput('S9')) as unknown as S9Shape;
  out.numbers_table[0]!.value = '£9,999';
  const issues = qaS9(out, intake, prior);
  assert.ok(issues.some((i) => i.check === 's9.table_number_untraced'));
});

test('qaS9 flags an invented figure in prose (retryable)', async () => {
  const out = (await mockOutput('S9')) as unknown as S9Shape;
  out.snapshot += ' The local market is worth £450,000 a year to a business like this.';
  const issues = qaS9(out, intake, prior);
  assert.ok(issues.some((i) => i.check === 's9.number_invented'));
});

test('qaS9 fails projections beyond the 90-day horizon', async () => {
  const out = (await mockOutput('S9')) as unknown as S9Shape;
  out.plan_summary += ' Over the next 12 months this compounds further.';
  assert.ok(qaS9(out, intake, prior).some((i) => i.check === 's9.horizon_exceeded'));
});

test('qaS9 fails a table missing its commercial anchors', async () => {
  const out = (await mockOutput('S9')) as unknown as S9Shape;
  for (const row of out.numbers_table) if (row.source === 'B3') row.source = 'B2';
  // Values sourced from B2 must still trace — keep them honest for this test.
  for (const row of out.numbers_table) if (row.source === 'B2') row.value = '£850';
  assert.ok(qaS9(out, intake, prior).some((i) => i.check === 's9.table_missing_anchors'));
});

test('qaS9 fails goals that abandon the owner’s G1 wording', async () => {
  const out = (await mockOutput('S9')) as unknown as S9Shape;
  out.goals_90d = 'Do considerably better across the period ahead, with strong momentum throughout.';
  assert.ok(qaS9(out, intake, prior).some((i) => i.check === 's9.goal_not_g1'));
});
