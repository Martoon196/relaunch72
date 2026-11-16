import test from 'node:test';
import assert from 'node:assert/strict';
import type { KeywordCandidate, KeywordCandidateSource, KeywordIntent } from '../src/keyword/types.js';
import type { InventoryPage } from '../src/seo-blog/types.js';
import { topicSimilarity, topicTokens } from '../src/seo-blog/dedupe.js';
import {
  BANNED_COPY, DIFFICULTY_BANDS, buildKeywordPool, businessSeeds, difficultyBand, fit, intentLabel, normalisePhrase, opportunity,
  phraseKey, searchesLabel, setSimilarity, type PoolBusiness,
} from '../src/seo-blog/keyword-pool.js';

function c(phrase: string, searches: number | null, difficulty: number | null, intent: KeywordIntent | null, source: KeywordCandidateSource = 'ideas', extra: Partial<KeywordCandidate> = {}): KeywordCandidate {
  return {
    phrase, searches, measuredMonth: searches === null ? null : '2026-10', dataUpdatedAt: null, rankingDifficulty: difficulty, adCompetition: 0.9, cpc: 1.2,
    intent, secondaryIntents: [], source, parent: null, locationCode: 2826, languageCode: 'en', ...extra,
  };
}
function page(url: string, title: string, headings: string[] = []): InventoryPage {
  return { url, canonical: null, title, headings, excerpt: '', publishedAt: null, modifiedAt: null, fetchStatus: 'ok', httpStatus: 200, editorial: true };
}

const business: PoolBusiness = {
  profile: {
    offers: [
      { name: 'Fully managed lettings', description: 'We find tenants, collect rent and handle repairs for landlords', price: null, url: 'https://agency.example/managed', sourceDocumentId: null },
      { name: 'HMO licence support', description: 'Help with HMO licence applications and inspections', price: null, url: null, sourceDocumentId: null },
    ],
    audiences: ['Landlords with one to three properties in Leeds', 'First-time landlords'],
    exclusions: ['cheap'],
    voice: { tone: [], do: [], dont: ['guaranteed rent', 'a very long voice rule that has many words in it'], examples: [] },
    confirmedAt: '2026-10-01T00:00:00.000Z',
  },
  brandName: 'Agency Example',
  website: 'https://agency.example',
  locations: ['Leeds', 'Headingley'],
  competitorNames: ['Foxtons'],
  competitorDomains: ['https://www.northwood.co.uk'],
  pages: [
    page('https://agency.example/blog/first-time-landlord-tips', 'Tips for first-time landlords', ['Tips for first-time landlords']),
    page('https://agency.example/services/managed', 'Fully managed lettings in Leeds | Agency Example'),
  ],
  planned: [{ id: 'b1', title: 'HMO licence rules explained', targetQuery: 'what are the hmo licence rules', phrase: 'hmo licence rules' }],
  dismissed: ['Letting Agent Review'],
};

const candidates: KeywordCandidate[] = [
  c('letting agent leeds', 1300, 22, 'commercial'),
  c('Letting Agents Leeds', 1000, 25, 'commercial', 'site_keywords'),
  c('leeds letting agent', 720, 22, 'commercial', 'suggestions'),
  c('letting agent', 9900, 55, 'commercial'),
  c('how much do letting agents charge', 880, 18, 'informational'),
  c('letting agent fees', 590, 35, 'informational', 'suggestions', { parent: 'letting agent' }),
  c('what does a letting agent do', null, null, null, 'serp_question', { parent: 'letting agent' }),
  c('do i need a letting agent', null, null, null, 'serp_question'),
  c('hmo licence leeds', 260, 12, 'informational'),
  c('hmo license leeds', 90, 12, 'informational'),
  c('foxtons leeds', 2900, 40, 'commercial'),
  c('northwood lettings', 300, 20, 'commercial'),
  c('rightmove', 900000, 90, 'navigational'),
  c('cheap letting agent', 210, 20, 'commercial'),
  c('guaranteed rent scheme', 480, 25, 'commercial'),
  c('tenant eviction process', 5, 10, 'informational'),
  c('section 21 notice landlords', 2400, 65, 'informational', 'own_ranked', { ranking: { position: 15, url: 'https://agency.example/blog/s21' } }),
  c('landlord insurance', 1900, 30, 'commercial', 'own_ranked', { ranking: { position: 4, url: 'https://agency.example/insurance' } }),
  c('tips for first time landlords', 170, 15, 'informational'),
  c('hmo licence rules leeds', 140, 20, 'informational'),
  c('best pizza leeds', 5400, 30, 'commercial'),
  c('letting agent reviews', 320, 20, 'commercial'),
  c('escort leeds', 999, 5, 'transactional'),
  c('<script>alert(1)</script> landlord rent \u0000tips‮', 70, 10, 'informational'),
  c('', 10, 10, 'informational'),
  c('https://evil.example/landlord', 50, 1, 'informational'),
];

test('normalising phrases: markup, entities, control and invisible characters, addresses and over-long input', () => {
  assert.equal(normalisePhrase('  Letting   AGENTS, Leeds!  '), 'letting agents leeds');
  assert.equal(normalisePhrase('<b>landlord</b> &amp; tenant'), 'landlord tenant');
  assert.equal(normalisePhrase('Tom’s  “lettings”'), "tom's lettings");
  assert.equal(normalisePhrase('rent\u0000 ​guide‮'), 'rent guide');
  assert.equal(normalisePhrase('https://x.example/a'), null);
  assert.equal(normalisePhrase('www.example.com landlord'), null);
  assert.equal(normalisePhrase('12345'), null);
  assert.equal(normalisePhrase('a '.repeat(11)), null);
  assert.equal(normalisePhrase(42 as unknown as string), null);
});

test('de-duplication key treats case, punctuation, plurals, word order and US/UK spelling as one phrase', () => {
  const k = phraseKey(normalisePhrase('Letting agents, Leeds')!);
  assert.equal(phraseKey('leeds letting agent'), k);
  assert.equal(phraseKey('the letting agent leeds'), k);
  assert.equal(phraseKey('hmo license leeds'), phraseKey('hmo licence leeds'));
  assert.equal(phraseKey('colour schemes for flats'), phraseKey('color scheme for flat'));
  assert.equal(phraseKey('properties to let'), phraseKey('property to let'));
  assert.notEqual(phraseKey('letting agent uk'), phraseKey('letting agent'));
  assert.notEqual(phraseKey('glass'), phraseKey('glas'));
});

test('the set similarity used for speed is exactly dedupe.topicSimilarity', () => {
  const samples = ['letting agent fees', 'how much do letting agents charge', 'HMO licence rules explained', 'tips for first time landlords', 'best pizza', 'rent', 'the', 'section 21 notice for landlords'];
  for (const a of samples) for (const b of samples) assert.equal(setSimilarity(topicTokens(a), topicTokens(b)), topicSimilarity(a, b), `${a} / ${b}`);
});

test('difficulty bands: Easier 0-29, Medium 30-49, Harder 50+, Not rated yet', () => {
  assert.deepEqual(DIFFICULTY_BANDS, { easierMax: 29, mediumMax: 49 });
  assert.deepEqual([0, 29, 30, 49, 50, 100].map((d) => difficultyBand(d).label), ['Easier', 'Easier', 'Medium', 'Medium', 'Harder', 'Harder']);
  assert.deepEqual(difficultyBand(null), { band: 'not_rated', label: 'Not rated yet' });
  assert.equal(intentLabel('transactional')!.label, 'Buy'); assert.equal(intentLabel('commercial')!.label, 'Compare');
  assert.equal(intentLabel('informational')!.label, 'Learn'); assert.equal(intentLabel('navigational'), null);
});

test('ranking formula is the documented one', () => {
  assert.equal(opportunity({ searches: 9999, difficulty: 0, fit: 1, quickWin: true }), 1);
  assert.equal(opportunity({ searches: null, difficulty: null, fit: 0.3, quickWin: false }), Math.round((0.3 * 0.5 + 0.25 * 0.3) * 10_000) / 10_000);
  assert.equal(opportunity({ searches: 999, difficulty: 40, fit: 0.9, quickWin: false }), Math.round((0.35 * Math.log10(1000) / 4 + 0.3 * 0.6 + 0.25 * 0.9) * 10_000) / 10_000);
  assert.equal(fit('informational', true, false), 1); assert.equal(fit('commercial', true, false), 1);
  assert.equal(fit('informational', false, true), 0.9); assert.equal(fit('commercial', false, true), 0.8);
  assert.equal(fit('transactional', true, false), 0.6); assert.equal(fit(null, false, true), 0.6); assert.equal(fit('informational', false, false), 0.3);
});

test('seeds come from confirmed Brand DNA offers, audiences and locations, plus existing page titles', () => {
  const seeds = businessSeeds(business);
  const phrases = seeds.map((s) => s.phrase);
  assert.ok(phrases.includes('fully managed lettings'));
  assert.ok(phrases.includes('hmo licence support'));
  assert.ok(phrases.includes('fully managed lettings leeds'));
  assert.ok(phrases.includes('landlords one three'));
  assert.ok(phrases.includes('leeds'));
  assert.ok(phrases.includes('tips first-time landlords'));
  assert.ok(seeds.every((s) => s.phrase.split(' ').length <= 6 && normalisePhrase(s.phrase) === s.phrase));
  const unconfirmed = businessSeeds({ ...business, profile: { ...business.profile!, confirmedAt: null } });
  assert.ok(unconfirmed.every((s) => s.from === 'page' || s.from === 'location'), 'an unconfirmed profile contributes nothing');
  const excluded = businessSeeds({ ...business, profile: { ...business.profile!, offers: [{ ...business.profile!.offers[0]!, name: 'Cheap lettings' }] } });
  assert.ok(!excluded.some((s) => s.phrase.includes('cheap')));
});

test('worked example: filters record a reason, the ladder is honest, clusters and reasons read correctly', () => {
  const pool = buildKeywordPool(candidates, business);
  const reasons = new Map(pool.excluded.filter((e) => e.key).map((e) => [e.phrase, e.reason]));
  assert.equal(reasons.get('letting agent'), 'too_hard');
  assert.equal(reasons.get('foxtons leeds'), 'competitor_brand');
  assert.equal(reasons.get('northwood lettings'), 'competitor_brand');
  assert.equal(reasons.get('rightmove'), 'wrong_intent');
  assert.equal(reasons.get('cheap letting agent'), 'excluded_term');
  assert.equal(reasons.get('guaranteed rent scheme'), 'excluded_term');
  assert.equal(reasons.get('tenant eviction process'), 'too_small');
  assert.equal(reasons.get('landlord insurance'), 'already_covered');
  assert.equal(reasons.get('tips for first time landlords'), 'already_covered');
  assert.equal(reasons.get('hmo licence rules leeds'), 'cannibalises');
  assert.equal(reasons.get('best pizza leeds'), 'off_topic');
  assert.equal(reasons.get('letting agent reviews'), 'dismissed');
  assert.equal(reasons.get('escort leeds'), 'unsafe');
  assert.equal(pool.excluded.filter((e) => e.reason === 'invalid').length, 2);
  assert.deepEqual(pool.excluded.find((e) => e.phrase === 'landlord insurance')!.covered, { url: 'https://agency.example/insurance', how: 'ranks_top_10', position: 4 });

  const row = (phrase: string) => pool.rows.find((r) => r.phrase === phrase);
  const agentLeeds = row('letting agent leeds')!;
  assert.equal(agentLeeds.searches, 1300, 'the best-measured variant represents the merged phrase');
  assert.deepEqual(agentLeeds.variants, ['leeds letting agent', 'letting agent leeds', 'letting agents leeds']);
  assert.ok(!row('letting agents leeds') && !row('leeds letting agent'));
  assert.equal(row('hmo licence leeds')!.searches, 260); assert.ok(!row('hmo license leeds'));
  assert.equal(agentLeeds.labels.searches, 'About 1,300 searches a month, measured October 2026');

  const s21 = row('section 21 notice landlords')!;
  assert.equal(s21.band, 'harder'); assert.equal(s21.ownPosition, 15, 'Harder is kept only as a page-two quick win');
  assert.match(s21.why, /your site already appears on page two or three for it/);

  const wider = row('what does a letting agent do')!;
  assert.equal(wider.basis, 'parent_phrase'); assert.equal(wider.searches, null); assert.equal(wider.parentSearches, 9900);
  assert.equal(wider.parent, 'letting agent');
  assert.equal(wider.labels.searches, 'About 9,900 searches a month for the wider phrase, measured October 2026');
  assert.equal(wider.labels.basis, 'Wider phrase');
  const observed = row('do i need a letting agent')!;
  assert.equal(observed.basis, 'observed'); assert.equal(observed.searches, null); assert.equal(observed.parentSearches, null);
  assert.equal(observed.labels.searches, 'No search number yet');
  assert.equal(observed.why, 'We chose this because people ask this question when they search and it ties in with your Fully managed lettings.');

  const fees = row('letting agent fees')!;
  assert.equal(fees.why, 'We chose this because it is searched about 590 times a month, it is moderately hard to rank for and it ties in with your Fully managed lettings.');
  assert.equal(row('how much do letting agents charge')!.why, 'We chose this because it is searched about 880 times a month, it is easier to rank for and it ties in with your Fully managed lettings.');

  // Measured rows come before the wider-phrase rung, which comes before observed-only rows.
  const tiers = pool.rows.map((r) => ['measured', 'parent_phrase', 'observed'].indexOf(r.basis));
  assert.deepEqual(tiers, [...tiers].sort((a, b) => a - b));
  // Clusters: one pillar each; the fees question supports the broader letting-agent pillar.
  for (const cl of pool.clusters) assert.equal(pool.rows.filter((r) => r.clusterId === cl.id && r.role === 'pillar').length <= 1, true);
  assert.equal(row('letting agent fees')!.clusterId, agentLeeds.clusterId);
  assert.equal(pool.state, 'measured');
});

test('thin data: no measured phrases gives a "thin" pool; nothing at all gives "no_data"', () => {
  const thin = buildKeywordPool([c('do i need a letting agent', null, null, null, 'serp_question')], business);
  assert.equal(thin.state, 'thin'); assert.equal(thin.rows[0]!.basis, 'observed');
  assert.equal(buildKeywordPool([], business).state, 'no_data');
});

// ─── Property-style checks ──────────────────────────────────────────────────

function prng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const WORDS = ['letting', 'agent', 'agents', 'landlord', 'landlords', 'tenant', 'rent', 'deposit', 'hmo', 'licence', 'license', 'leeds', 'fees',
  'guide', 'how', 'to', 'much', 'repairs', 'inspection', 'notice', 'section', 'eviction', 'insurance', 'managed', 'lettings', 'property', 'properties',
  'cheap', 'foxtons', 'garden', 'colour', 'color', 'boiler', 'gas', 'safety', 'certificate', 'tips', 'first', 'time', 'Leeds', 'LETTING', 'Rent!'];
const HOSTILE = ['<img src=x onerror=alert(1)>', '\u0000', '‮', '​', '&lt;b&gt;', '"', "'", '\\', '\u0007', '`', '{{x}}', '${x}', ';DROP TABLE', '﻿'];
const SOURCES: KeywordCandidateSource[] = ['ideas', 'suggestions', 'related', 'site_keywords', 'own_ranked', 'competitor_ranked', 'serp_question', 'serp_related', 'overview'];
const INTENTS: (KeywordIntent | null)[] = ['informational', 'commercial', 'transactional', 'navigational', null];

function randomCandidates(n: number, seed: number): KeywordCandidate[] {
  const r = prng(seed);
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)]!;
  return Array.from({ length: n }, () => {
    const words = Array.from({ length: 1 + Math.floor(r() * 5) }, () => pick(WORDS));
    if (r() < 0.08) words.splice(Math.floor(r() * words.length), 0, pick(HOSTILE));
    const measured = r() < 0.75;
    const source = pick(SOURCES);
    return c(words.join(' '), measured ? Math.floor(r() * 20000) : null, r() < 0.85 ? Math.floor(r() * 101) : null, pick(INTENTS), source, {
      parent: r() < 0.4 ? Array.from({ length: 1 + Math.floor(r() * 2) }, () => pick(WORDS)).join(' ') : null,
      ...(source === 'own_ranked' ? { ranking: { position: 1 + Math.floor(r() * 60), url: `https://agency.example/p${Math.floor(r() * 9)}` } } : {}),
    });
  });
}
function shuffle<T>(xs: readonly T[], seed: number): T[] {
  const r = prng(seed); const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [out[i], out[j]] = [out[j]!, out[i]!]; }
  return out;
}

test('property: ranking is deterministic and independent of input order', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const input = randomCandidates(600, seed);
    const a = buildKeywordPool(input, business);
    const sortEx = (p: typeof a) => [...p.excluded].map((e) => JSON.stringify(e)).sort();
    for (const s of [11, 12]) {
      const b = buildKeywordPool(shuffle(input, seed * 100 + s), business);
      assert.deepEqual(b.rows, a.rows); assert.deepEqual(b.clusters, a.clusters); assert.deepEqual(sortEx(b), sortEx(a));
    }
    assert.deepEqual(buildKeywordPool(input, business), a);
  }
});

test('property: nothing dismissed, already covered or excluded is ever suggested, and every pick has a clean reason and labels', () => {
  for (const seed of [21, 22, 23, 24]) {
    const input = randomCandidates(800, seed);
    const r = prng(seed);
    const dismissed = input.filter(() => r() < 0.1).map((x) => x.phrase);
    const b: PoolBusiness = { ...business, dismissed };
    const pool = buildKeywordPool(input, b);
    const dismissedKeys = new Set(dismissed.map((d) => normalisePhrase(d)).filter((d): d is string => !!d).map(phraseKey));
    const excludedKeys = new Set(pool.excluded.map((e) => e.key));
    const ownTop10 = new Set(input.filter((x) => x.source === 'own_ranked' && x.ranking && x.ranking.position <= 10).map((x) => normalisePhrase(x.phrase)).filter((p): p is string => !!p).map(phraseKey));
    for (const row of pool.rows) {
      assert.ok(!dismissedKeys.has(row.key), `dismissed ${row.phrase}`);
      assert.ok(!excludedKeys.has(row.key), `excluded ${row.phrase}`);
      assert.ok(!ownTop10.has(row.key), `covered ${row.phrase}`);
      assert.ok(row.ownPosition === null || row.ownPosition > 10);
      assert.notEqual(row.intent, 'navigational');
      assert.ok(row.rankingDifficulty === null || row.rankingDifficulty <= 49 || (row.ownPosition !== null && row.ownPosition <= 30));
      assert.match(row.why, /^We chose this because [^.]+\.$/);
      for (const text of [row.why, ...Object.values(row.labels).filter((v): v is string => typeof v === 'string')]) {
        assert.doesNotMatch(text, BANNED_COPY, text);
        assert.doesNotMatch(text, /dataforseo|\bAPI\b|provider|model/i, text);
      }
    }
    assert.ok(pool.rows.length > 0);
  }
});

test('property: the thin-data ladder never yields a number that was not measured for that phrase or its named parent', () => {
  for (const seed of [31, 32, 33]) {
    const input = randomCandidates(700, seed);
    const pool = buildKeywordPool(input, business);
    const measured = new Map<string, Set<number>>();
    for (const x of input) {
      const p = normalisePhrase(x.phrase);
      if (p && typeof x.searches === 'number') { const k = phraseKey(p); (measured.get(k) ?? measured.set(k, new Set()).get(k)!).add(x.searches); }
    }
    for (const row of pool.rows) {
      if (row.basis === 'measured') {
        assert.ok(measured.get(row.key)?.has(row.searches!), `measured ${row.phrase}`);
        assert.equal(row.parentSearches, null);
      } else {
        assert.equal(row.searches, null); assert.equal(row.measuredMonth, null);
        if (row.basis === 'parent_phrase') assert.ok(measured.get(phraseKey(row.parent!))?.has(row.parentSearches!), `parent of ${row.phrase}`);
        else { assert.equal(row.parentSearches, null); assert.equal(row.labels.searches, 'No search number yet'); assert.doesNotMatch(row.why, /\d/); }
      }
      const shown = row.basis === 'measured' ? row.searches : row.parentSearches;
      assert.equal(row.labels.searches, searchesLabel(row.basis, shown, row.basis === 'measured' ? row.measuredMonth : row.parentMeasuredMonth));
    }
  }
});

test('property: hostile phrases with markup or control characters are neutralised', () => {
  const pool = buildKeywordPool(randomCandidates(1500, 41), business);
  for (const row of pool.rows) {
    for (const text of [row.phrase, row.parent ?? '', ...row.variants]) {
      assert.match(text, /^[\p{L}\p{N}' -]*$/u, JSON.stringify(text));
      assert.doesNotMatch(text, /[<>&"`\\{}$;]|[\u0000-\u001f\u007f-\u009f​-‏‪-‮﻿]/);
    }
  }
});

test('performance: 5,000 candidates rank in well under a second', () => {
  const input = randomCandidates(5000, 51);
  const pages = Array.from({ length: 300 }, (_, i) => page(`https://agency.example/blog/post-${i}`, `${WORDS[i % WORDS.length]} ${WORDS[(i * 7) % WORDS.length]} guide ${i}`));
  const planned = Array.from({ length: 60 }, (_, i) => ({ id: `b${i}`, title: `Planned ${WORDS[i % WORDS.length]} article ${i}`, targetQuery: `${WORDS[(i * 3) % WORDS.length]} question ${i}` }));
  buildKeywordPool(input.slice(0, 200), { ...business, pages, planned }); // warm up
  const started = performance.now();
  const pool = buildKeywordPool(input, { ...business, pages, planned });
  const ms = performance.now() - started;
  assert.ok(pool.rows.length > 0);
  assert.ok(ms < 1000, `took ${ms.toFixed(0)} ms`);
  console.log(`# keyword pool: 5,000 candidates in ${ms.toFixed(0)} ms`);
});
