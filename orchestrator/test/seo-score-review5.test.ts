/**
 * The fifth review of the SEO score (review5-seo-score.md): its 21 good articles and its rubbish, judged in both
 * directions; each finding's fix and its cost; the known limits, kept exact and visible for the meaning check; and the
 * two quadratic patterns it found (S1, S2).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sentences, SEO_GATE_BAR, seoGate, seoScore, type SeoScore } from '../src/seo-blog/seo-score.js';
import { restoreCitationsDetailed } from '../src/seo-blog/citation-edit.js';
import type { ArticleBody } from '../src/seo-blog/types.js';
import * as R from './seo-score-review-fixtures.js';
import * as R2 from './seo-score-review2-fixtures.js';
import * as R3 from './seo-score-review3-fixtures.js';
import * as G4 from './seo-score-review4-good.js';
import * as RB4 from './seo-score-review4-rubbish.js';
import * as G5 from './seo-score-review5-good.js';
import * as RB5 from './seo-score-review5-rubbish.js';
import * as sp from './seo-panel-fixtures.js';

delete process.env.CONTENT_AREA_PREVIEW;

type Brief = Parameters<typeof seoScore>[0];
type Ctx = Parameters<typeof seoScore>[2];
const ctxOf = (x: { site: string; body: ArticleBody }) => ({ siteHosts: [x.site], selfUrl: `${x.site}/blog/${x.body.slug}`, checkIssues: [], targetMode: true });
const B = R2.REVIEW2_BRIEF, C = R2.REVIEW2_CONTEXT;
const rubbish = (prefix: string) => { const r = RB5.RUBBISH5.find(([n]) => n.startsWith(prefix)); assert.ok(r, prefix); const { brief, body, ctx } = r[1](); return seoScore(brief, body, ctx); };
const variant = (prefix: string) => { const v = G4.VARIANTS.find((x) => x.art.name.startsWith(prefix))!; return seoScore(v.art.brief, v.art.body, ctxOf(v.art)); };
const good5 = (prefix: string) => { const [x] = G5.GOOD21.find(([a]) => a.name.startsWith(prefix))!; return seoScore(x.brief, x.body, ctxOf(x)); };
const result = (s: SeoScore, id: string) => s.checks.find((c) => c.id === id)!.result;

// ─── The new good articles ───────────────────────────────────────────────────────────────────────────────────────

/**
 * The only good articles of any corpus scoring lower than at d4e5527, with the reason (both still pass the gate):
 * very short list items do not count towards an article's length or a part's length. That rule is what keeps
 * different short bullets from ever raising a score (the A2 property, asserted below); letting a kit list's items
 * count would let any one- to three-word bullets lift a page too.
 */
const LOWER_THAN_D4: Record<string, [number, number]> = {
  'P1 kit-list post (items of one to three words)': [93, 87], // was 96 / 90: length and one part short of 40 words
  'P7 checklist of short items with advice between': [93, 87], // was 94 / 88: one part short of 40 words
};

test('review 5, good side: the 21 new good articles pass the gate with and without a picture and score no lower than at d4e5527, apart from two named', () => {
  assert.equal(G5.GOOD21.length, 21);
  for (const [x, withPic, without] of G5.GOOD21) {
    const s = seoScore(x.brief, x.body, ctxOf(x)), n = seoScore(x.brief, R.withoutPicture(x.body), ctxOf(x));
    assert.equal(s.cap, null, x.name); assert.equal(n.cap, null, x.name);
    const lower = LOWER_THAN_D4[x.name];
    if (lower) assert.deepEqual([s.score, n.score], lower, x.name);
    else assert.ok(s.score >= withPic && n.score >= without, `${x.name}: ${s.score}/${n.score}, was ${withPic}/${without}`);
    assert.equal(seoGate(s).pass, true, x.name);
    // N6, the legal explainer quoting statute, was refused without a picture at d4e5527 too (84): held exactly there.
    if (x.name.startsWith('N6 ')) { assert.deepEqual([s.score, n.score], [90, 84]); assert.equal(seoGate(n).pass, false); }
    else assert.equal(seoGate(n).pass, true, `${x.name} without a picture`);
  }
});

test('review 5, good side: measured check by check as at d4e5527, apart from the named changes', () => {
  const BASE: Record<string, Record<string, string>> = JSON.parse(readFileSync(new URL('./seo-score-review5-baseline.json', import.meta.url), 'utf8'));
  const expected: Record<string, Record<string, string>> = {
    'N1 how-to, numbered steps + short tips': { 'read.spacing': 'pass' }, // review 4 N4: "### " lines start a new stretch
    'N12 several ### sub-headings per part': { 'phrase.heading': 'pass' }, // review 4: close forms count in a heading
    'P2 service page, 2-word phrase names the service': { 'page.subheadings': 'partly', 'phrase.use': 'pass' }, // a part of very short items is thin (A2); four uses are never too many (A3)
    'P1 kit-list post (items of one to three words)': { 'page.length': 'partly', 'page.subheadings': 'partly' }, // very short items are not length (A2)
    'P6 salon price list in tables': { 'page.subheadings': 'partly', 'read.linking': 'pass' }, // A2; linking measured on the sentences since review 4
    'P7 checklist of short items with advice between': { 'page.subheadings': 'partly' }, // A2
  };
  assert.equal(Object.keys(BASE).length, 21);
  for (const [x] of G5.GOOD21) {
    const now = Object.fromEntries(seoScore(x.brief, x.body, ctxOf(x)).checks.map((c) => [c.id, c.result]));
    assert.deepEqual(now, { ...BASE[x.name], ...expected[x.name] }, x.name);
  }
});

// ─── The rubbish ─────────────────────────────────────────────────────────────────────────────────────────────────

test('review 5, rubbish side: every row is refused the way it says, with and without a picture, or is a listed known limit', () => {
  const listed = (n: string) => RB5.KNOWN_LIMITS.some((k) => k.example === n || k.also?.includes(n));
  const seen = new Set<string>();
  for (const [name, f, outcome] of RB5.RUBBISH5) {
    assert.ok(!seen.has(name), `one row per name: ${name}`); seen.add(name);
    const { brief, body, ctx } = f();
    const s = seoScore(brief, body, ctx), n = seoScore(brief, R.withoutPicture(body), ctx);
    if (outcome === 'limit') {
      assert.equal(seoGate(s).pass, true, `${name} is a known limit: it passes (${s.score}), kept visible`);
      assert.ok(listed(name), `${name} is in KNOWN_LIMITS`);
      continue;
    }
    assert.ok(!listed(name), `${name} is refused, so it is not a known limit`);
    for (const x of [s, n]) {
      const g = seoGate(x);
      assert.equal(g.pass, false, `${name}: ${x.score} ${JSON.stringify(x.measures)}`);
      if (outcome === 'gate') { assert.equal(x.cap, null, name); assert.ok(g.reasons.length > 0, name); }
      else assert.equal(x.cap?.kind, outcome, `${name}: ${x.cap?.kind} ${JSON.stringify(x.measures)}`);
    }
  }
  assert.equal(RB5.RUBBISH5.length, 60);
});

test('KNOWN LIMITS: each passes the gate at its recorded score, and every passing row of every rubbish corpus is listed', () => {
  // Every rubbish article of every round, by name, with how the tests score it.
  const all = new Map<string, () => [Brief, ArticleBody, Ctx]>();
  for (const [n, f] of RB5.RUBBISH5) all.set(n, () => { const { brief, body, ctx } = f(); return [brief, body, ctx]; });
  for (const [n, f] of [...RB4.RUBBISH4, ...R3.DODGES.map(([a, g]) => [a, g] as const), ...R2.KNOWN_LIMIT, ...R2.ROUND2_RUBBISH, ...R3.BULLET_ATTACKS]) all.set(n, () => [B, f(), C]);
  const names = new Set<string>();
  for (const k of RB5.KNOWN_LIMITS) {
    assert.ok(k.name && k.why.length > 40, k.name);
    assert.doesNotMatch(k.why, /[–—]/, k.name);
    for (const n of [k.example, ...(k.also ?? [])]) {
      assert.ok(!names.has(n), `${n} is listed once`); names.add(n);
      const build = all.get(n); assert.ok(build, `${k.name}: example "${n}" is a corpus row`);
      const s = seoScore(...build());
      assert.equal(seoGate(s).pass, true, `${k.name}: "${n}" passes the gate (${s.score}): if it is caught now, take it off the list`);
      if (n === k.example) assert.equal(s.score, k.score, `${k.name}: "${n}"`);
    }
  }
  // The other direction: nothing that passes is missing from the list (the picture-description dodge is refused with
  // its picture; without one there is no description to stuff).
  for (const [n, build] of all) {
    const s = seoScore(...build());
    if (seoGate(s).pass) assert.ok(names.has(n), `"${n}" passes the gate (${s.score}) but is not in KNOWN_LIMITS`);
  }
  assert.equal(RB5.KNOWN_LIMITS.length, 11);
});

test('KNOWN LIMITS are mirrored in the documentation, under a plain heading, for the builder of the meaning check', () => {
  const doc = readFileSync(new URL('../../docs/seo-blog-engine.md', import.meta.url), 'utf8');
  const at = doc.indexOf('## Known limits of the SEO score');
  assert.ok(at >= 0, 'the section is there');
  const section = doc.slice(at, doc.indexOf('\n## ', at + 5) > 0 ? doc.indexOf('\n## ', at + 5) : undefined);
  for (const k of RB5.KNOWN_LIMITS) assert.ok(section.includes(`**${k.name}**`), k.name);
});

// ─── Each finding ────────────────────────────────────────────────────────────────────────────────────────────────

test('M1 kit lists and price lists are not refused: very short items are held over 25%, the "partly" hold with them', () => {
  for (const [p, share] of [['P1', 19.8], ['P6', 13.8], ['P7', 13.8]] as const) {
    const s = good5(p);
    assert.equal(s.measures.shortItems, share, p); assert.equal(s.cap, null, p); assert.equal(seoGate(s).pass, true, p);
    for (const id of ['read.sentences', 'read.ease']) assert.doesNotMatch(s.checks.find((c) => c.id === id)!.found, /short list items/, `${p} ${id}`);
  }
  assert.equal(good5('P6').score, 93, 'the price list one point above d4e5527');
  // Keyword bullets over the line are still held: the third review's X3b is at 26% and over.
  const x3 = seoScore(B, R3.BULLET_ATTACKS[4]![1](), C);
  assert.ok(x3.measures.shortItems > 25); assert.equal(x3.cap?.kind, 'short-items');
});

test('M2 a pasted list is not "a job every room shares" once different bullets are added; the room-by-room checklist keeps its 96', () => {
  for (const p of ['M2 the same 10 six-word', 'M2 the same + 11', 'M2 the same 10 bullets after 5', 'M2 two pasted lists']) {
    const s = rubbish(p); assert.deepEqual([s.score, s.cap?.kind], [40, 'repetition'], p);
  }
  const d = variant('1d');
  assert.deepEqual([d.score, d.cap, seoGate(d).pass], [96, null, true]);
});

test('G1 the on-record-question exemption: one excused heading or question per question, never a "### " line', () => {
  for (const p of ['E1 ', 'E3 ', 'E4 ', 'E5 ', 'E7 ', 'E8 ', 'E9 ']) assert.deepEqual([rubbish(p).score, rubbish(p).cap?.kind], [60, 'stuffing'], p);
  assert.deepEqual([variant('9a').score, variant('11a').score, variant('11b').score], [96, 99, 99], 'the real on-record questions are unchanged');
  for (const p of ['9a', '11a', '11b']) assert.equal(result(variant(p), 'phrase.use'), 'pass', p);
  // The phrase at the front of every heading and question: the heading check says so, and the gate refuses it.
  const e6 = rubbish('E6 ');
  assert.equal(e6.checks.find((c) => c.id === 'phrase.heading')!.found, '5 sub-headings use the phrase. More than two reads as forced.');
  assert.equal(e6.measures.phraseHeadings, 71);
  assert.deepEqual(seoGate(e6).reasons, ['The search phrase is in most of the sub-headings, which reads as forced. Keep it in one or two and word the others in your own way.']);
  // A one-word topic ("MOT") is named by every natural question about it: the MOT page keeps its 100.
  assert.deepEqual([good5('P3').score, good5('P3').measures.phraseHeadings], [100, 0]);
  // No good article of any corpus has the phrase stamped on its headings.
  for (const [x] of [...G5.GOOD21, ...G4.GOOD16]) assert.equal(seoScore(x.brief, x.body, ctxOf(x)).measures.phraseHeadings, 0, x.name);
});

test('G2 a list number is not a word: numbered and dashed bullets leave the phrase share where it was', () => {
  const plain = seoScore(B, R2.strongPlusPhrase(5), C).measures.phraseShare;
  for (const p of ['G2 the phrase at 2.6% + four numbered', 'G2 the phrase at 2.6% + six numbered', 'G2 the phrase at 2.6% + four dashed']) {
    const s = rubbish(p);
    assert.equal(s.measures.phraseShare, plain, p);
    assert.ok(seoGate(s).reasons.includes('The search phrase comes up more often than reads naturally. Use it fewer times; reworded forms of the phrase count as uses too.'), p);
  }
  // Different step-sized keyword bullets no longer lift the held fixtures out of their repetition cap.
  for (const p of ['D2 ', 'D3 ', 'D6 ']) assert.deepEqual([rubbish(p).score, rubbish(p).cap?.kind], [70, 'repetition'], p);
});

test('G2 property: different bullets of 1 to 9 words, any marker, never lift a score through the phrase, repetition or list measures, and 1 to 3 words never lift it at all', () => {
  // Every corpus, good and rubbish; with a picture for odd bullet lengths and without for even ones; the marker, the
  // dose, small words and a full stop rotate. A known limit stays: bullets of four to nine words are content for the
  // length, part-length and sentence-length checks (KNOWN_LIMITS), so a score can rise through those three only, and a
  // refused page can pass only within five points of the bar, through the sentence-length check.
  const corpus: [string, Brief, ArticleBody, Ctx][] = [
    ...G4.GOOD16.map(([x]) => [x.name, x.brief, x.body, ctxOf(x)] as [string, Brief, ArticleBody, Ctx]),
    ...G4.VARIANTS.map((v) => [v.art.name, v.art.brief, v.art.body, ctxOf(v.art)] as [string, Brief, ArticleBody, Ctx]),
    ...G5.GOOD21.map(([x]) => [x.name, x.brief, x.body, ctxOf(x)] as [string, Brief, ArticleBody, Ctx]),
    ...[R.A, R.B, R.C, R2.L, R2.R, R2.G, R2.Q, R2.Y].map((x, i) => [`fixture ${i}`, x.brief, x.body, ctxOf(x)] as [string, Brief, ArticleBody, Ctx]),
    ['strong', B, sp.strongBody(), C],
    ...RB4.RUBBISH4.map(([n, f]) => [n, B, f(), C] as [string, Brief, ArticleBody, Ctx]),
    ...RB5.RUBBISH5.map(([n, f]) => { const { brief, body, ctx } = f(); return [n, brief, body, ctx] as [string, Brief, ArticleBody, Ctx]; }),
  ];
  const MARKS = ['- ', '* ', '+ ', '• ', '– ', '— ', '1. ', '2) ', 'a) ', 'b. ', '> ', ''];
  const DOSES = [2, 8, 20];
  const CONTENT = new Set(['page.length', 'page.subheadings', 'read.sentences']);
  let uid = 0, trials = 0, raised = 0;
  corpus.forEach(([name, brief, body0, ctx], i) => {
    for (let w = 1; w <= 9; w++) {
      const body = w % 2 ? body0 : R.withoutPicture(body0);
      const before = seoScore(brief, body, ctx), passed = seoGate(before).pass;
      const mark = MARKS[(i + w) % MARKS.length]!, per = DOSES[(i + w) % DOSES.length]!, small = (i + w) % 2 === 0, stop = (i + w) % 5 === 0;
      const item = () => `${Array.from({ length: w }, (_, j) => (small && j % 3 === 1 ? 'in' : `zq${(uid++).toString(36)}x`)).join(' ')}${stop ? '.' : ''}`;
      const padded = { ...body, sections: body.sections.map((x) => ({ ...x, body: `${x.body}\n\n${Array.from({ length: per }, () => `${mark}${item()}`).join('\n')}` })) } as ArticleBody;
      const s = seoScore(brief, padded, ctx), g = seoGate(s);
      const at = `${name}, ${per} ${w}-word bullets "${mark}" per part: ${before.score} to ${s.score}`;
      trials++;
      if (before.cap) assert.ok(s.cap && s.cap.limit <= before.cap.limit, `${at}: the cap is not lifted`);
      assert.ok(s.measures.phraseShare >= before.measures.phraseShare, `${at}: phrase share ${before.measures.phraseShare} to ${s.measures.phraseShare}`);
      const gained = s.checks.filter((c) => c.points > (before.checks.find((o) => o.id === c.id)?.points ?? 0)).map((c) => c.id);
      if (w <= 3) { assert.ok(s.score <= before.score, at); if (!passed) assert.equal(g.pass, false, at); continue; }
      if (s.score > before.score) { raised++; for (const id of gained) assert.ok(CONTENT.has(id), `${at}: gained ${id}`); }
      if (!passed && g.pass) {
        assert.ok(gained.includes('read.sentences') && before.score >= g.bar - 5, `${at}: a flip only through the sentence-length check, within five points of the bar`);
      }
    }
  });
  assert.equal(trials, corpus.length * 9); assert.ok(corpus.length >= 150, String(corpus.length));
  assert.ok(raised > 0, 'the known limit is real: it is seen here');
});

test('G3 run-ons over 40 words, pasted items of short sentences, short sentences of prose said again and again', () => {
  // Run-ons: the share of prose words in sentences of over 40 words. The regulation (14.7%) and the legal explainer N6
  // stay free; one 50-word keyword sentence per part is 46.7%.
  assert.deepEqual([seoScore(R2.Q.brief, R2.Q.body, ctxOf(R2.Q)).measures.runOn, seoScore(R2.Q.brief, R2.Q.body, ctxOf(R2.Q)).cap], [14.7, null]);
  assert.deepEqual([good5('N6').measures.runOn, good5('N6').cap], [6.6, null]);
  assert.deepEqual([rubbish('O1 ').measures.runOn, rubbish('O1 ').cap?.kind], [46.7, 'run-on']);
  for (const p of ['O3 ', 'O4 ', 'O5 ', 'X1 ']) assert.equal(rubbish(p).cap?.kind, 'run-on', p);
  // A pasted bullet of five three-word sentences is compared whole: a repeat from its second copy.
  assert.deepEqual([rubbish('I4 ').score, rubbish('I4 ').cap?.kind], [40, 'repetition']);
  // A two- or three-word sentence of prose is a repeat from its sixth appearance; one-word answers never are.
  for (const p of ['S1 ', 'S2 ', 'S4 ']) assert.deepEqual([rubbish(p).score, rubbish(p).cap?.kind], [40, 'repetition'], p);
  const base = seoScore(B, sp.strongBody(), C).measures.repeatedSentences;
  const said = (text: string, times: number) => seoScore(B, R3.eachPart((i) => (i < times ? text : '')), C).measures.repeatedSentences;
  assert.equal(said('Stir well.', 4), base, '"Stir well." four times is ordinary');
  assert.equal(said('Stir well.', 5), base, 'and five');
  assert.ok(said('Stir well.', 6) > base, 'from the sixth it is a repeat');
  assert.equal(said('Yes.', 12), base, 'a one-word answer is never a repeat');
  assert.equal(variant('3b').score, 92, 'the FAQ page answering "Yes." and "No." keeps its 92');
  assert.equal(variant('7a').score, 95, 'the recipe with "Stir well." in each day\'s step keeps its 95');
  // A question said again is a repeat too.
  assert.deepEqual([rubbish('H4 ').score, rubbish('H4 ').cap?.kind], [40, 'repetition']);
});

test('N9 a list of names starting "The" is not a run of the same start; prose still is', () => {
  assert.equal(good5('N9').score, 100);
  const names = ['The Black Horse on Church Street, for tapas and a proper fire in winter', 'The Station Inn, opposite the railway station, for real ale and pies', 'The Endeavour on the harbour, for live music on most weekend evenings', 'The Fisherman\'s Wife, where dogs are welcome on the covered terrace all year'];
  const list = seoScore(B, R3.eachPart((i) => (i === 2 ? names.map((x) => `- ${x}`).join('\n') : '')), C);
  const prose = seoScore(B, R3.eachPart((i) => (i === 2 ? names.map((x) => `${x}.`).join(' ') : '')), C);
  assert.equal(result(list, 'read.starts'), result(seoScore(B, sp.strongBody(), C), 'read.starts'));
  assert.notEqual(result(prose, 'read.starts'), 'pass');
});

// ─── S1, S2: no quadratic scans ──────────────────────────────────────────────────────────────────────────────────

test('S1 restoreCitationsDetailed: 80,000 spaces are quick, and the typed-marker pattern matches exactly as before', () => {
  const t = performance.now();
  const r = restoreCitationsDetailed('A start and an end of the sentence here [src:a1].', `A start${' '.repeat(80_000)}and an end of the sentence here.`);
  assert.ok(performance.now() - t < 1000, `${(performance.now() - t).toFixed(0)} ms (11.8 s before)`);
  assert.equal(typeof r.text, 'string');
  const src = readFileSync(new URL('../src/seo-blog/citation-edit.ts', import.meta.url), 'utf8');
  assert.match(src, /const TYPED = \/\(\?<!\[ \\t\]\)\[ \\t\]\*\\\[src:\[\^\\\]\\n\]\*\\\]\/gi;/);
  const OLD = /[ \t]*\[src:[^\]\n]*\]/gi, NEW = /(?<![ \t])[ \t]*\[src:[^\]\n]*\]/gi;
  let x = 17; const rnd = () => (x = (x * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const BITS = [' ', '  ', '\t', '[src:a1]', '[SRC:b-2]', '[src:', ']', '[src:x\n]', 'word', '.', '\n', '[src:]'];
  for (let i = 0; i < 5000; i++) {
    const s = Array.from({ length: 1 + Math.floor(rnd() * 20) }, () => BITS[Math.floor(rnd() * BITS.length)]).join('');
    assert.deepEqual([...s.matchAll(NEW)].map((m) => [m.index, m[0]]), [...s.matchAll(OLD)].map((m) => [m.index, m[0]]), JSON.stringify(s));
    assert.equal(s.replace(NEW, ''), s.replace(OLD, ''));
  }
});

/** sentences() as it was before S2: the abbreviation patterns tested on the whole text before each full stop. */
function sentencesBefore(paragraph: string): string[] {
  const NEVER_END = /\b(?:e\.g|i\.e|mr|mrs|ms|dr|st|vs|cf)\.$/i;
  const END_IF_CAPITAL = /(?:\b(?:etc|approx|inc|ltd|co)|\b(?:[a-z]\.){1,}[a-z])\.$/i;
  const NUMBER_ABBREVIATION = /\bno\.$/i;
  const out: string[] = [];
  let start = 0;
  const text = paragraph.replace(/\s+/g, ' ').trim();
  for (const m of text.matchAll(/[.!?]+["”’)\]]*(?=\s|$)/g)) {
    const end = m.index! + m[0].length;
    const before = text.slice(start, m.index! + 1);
    const after = text.slice(end).trimStart();
    if (m[0][0] === '.' && m[0].length === 1) {
      if (NEVER_END.test(before)) continue;
      if (END_IF_CAPITAL.test(before) && after && !/^["“‘'(]?\p{Lu}/u.test(after)) continue;
      if (NUMBER_ABBREVIATION.test(before) && /^\d/.test(after)) continue;
    }
    const piece = text.slice(start, end).trim();
    if (piece) out.push(piece);
    start = end;
  }
  const rest = text.slice(start).trim();
  if (rest) out.push(rest);
  return out.filter((s) => /[\p{L}\p{N}]/u.test(s));
}

test('S2 sentences(): 1 MB of "No. 5 " is quick, and every split is the same as before, on random text and the whole corpus', () => {
  const t = performance.now();
  const parts = sentences('No. 5 '.repeat(170_000));
  assert.ok(performance.now() - t < 3000, `${(performance.now() - t).toFixed(0)} ms (over 60 s before, in the score)`);
  assert.equal(parts.length, 1);
  let x = 7; const rnd = () => (x = (x * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const BITS = ['No. 5 ', 'no. ', 'e.g. ', 'i.e.', 'Mr. ', 'St. ', 'vs. ', 'etc. ', 'approx. ', 'Ltd. ', 'Co. ', 'U.K. ', 'a.b.c. ', 'xa.b. ', 'The ', 'then ', '5 ', '"Quoted." ', '“Yes.” ', 'Él ', '. ', '! ', '? ', '... ', 'word ', '.) '];
  for (let i = 0; i < 5000; i++) {
    const s = Array.from({ length: 1 + Math.floor(rnd() * 25) }, () => BITS[Math.floor(rnd() * BITS.length)]).join('');
    assert.deepEqual(sentences(s), sentencesBefore(s), JSON.stringify(s));
  }
  for (let k = 1; k < 40; k++) for (const pre of ['', 'x', ' ', '1']) for (const post of [' Then', ' then', ' 5', '']) { const s = `${pre}${'a.'.repeat(k)}${post}`; assert.deepEqual(sentences(s), sentencesBefore(s), s); }
  const bodies = [...G5.GOOD21.map(([a]) => a.body), ...G4.GOOD16.map(([a]) => a.body), ...RB5.RUBBISH5.map(([, f]) => f().body)];
  for (const b of bodies) for (const t2 of [b.intro, ...b.sections.flatMap((s) => [s.heading, s.body]), ...b.faqs.flatMap((f) => [f.q, f.a]), b.conclusion]) {
    for (const p of [t2, ...t2.split(/\n+/)]) assert.deepEqual(sentences(p), sentencesBefore(p));
  }
});

test('timing: long and odd articles stay quick (one shared machine: generous bounds)', () => {
  const big = (n: number) => ({ ...sp.strongBody(), intro: Array.from({ length: n / 10 }, (_, i) => `Word${i % 997} and another word of plain text here ${i}.`).join(' ') }) as ArticleBody;
  for (const [what, body, ms] of [
    ['50,000 words', big(50_000), 4000],
    ['100,000 different three-word items', { ...sp.strongBody(), intro: Array.from({ length: 100_000 }, (_, i) => `- zq${i} in town${i}`).join('\n') }, 15_000],
    ['80,000 spaces in the opening', { ...sp.strongBody(), intro: `${' '.repeat(80_000)}word end.` }, 1000],
    ['1 MB of "No. 5 "', { ...sp.strongBody(), intro: 'No. 5 '.repeat(170_000) }, 6000],
  ] as const) {
    const t = performance.now();
    const s = seoScore(B, body, C);
    assert.ok(performance.now() - t < ms, `${what}: ${(performance.now() - t).toFixed(0)} ms`);
    assert.ok(s.score >= 0 && s.score <= 100, what);
  }
});

test('the gate stays honest: its new reason is plain English, and a pass is still never enough on its own', () => {
  const g = seoGate(rubbish('E6 '));
  for (const r of g.reasons) { assert.doesNotMatch(r, /[–—]|measure|percent|share|phraseHeadings/); assert.match(r, /^[A-Z].*\.$/); }
  assert.equal(seoGate(seoScore(B, sp.strongBody(), C)).sufficient, false);
  assert.equal(SEO_GATE_BAR.withPicture, 90);
});
