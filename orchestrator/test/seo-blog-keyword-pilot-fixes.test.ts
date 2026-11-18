/**
 * Fixes from the second review of keyword-first planning (review2-keyword-followups) before a one-business pilot:
 * P1 twin phrases, P2 a pillar whose title names its sub-topics, P3 the place rule. Each test below failed on
 * cda1d9dc and passes after its fix. The reviewer's own data (`keyword-fit-cases-review2.ts`) is run through the real
 * `bindByIds`, plus the reviewer's twin case through the real pool builder. Doubles only: no network and no paid call.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { bestFit, bindByIds, planningCandidates, type PlanningCandidates, type ShortlistRow } from '../src/seo-blog/keyword-planning.js';
import { buildKeywordPool } from '../src/seo-blog/keyword-pool.js';
import { newClusters, newPairs } from './keyword-fit-cases-review2.js';

const t = (question: string, title = question) => ({ question, title });
const short = (phrase: string, i: number, searches = 1000 + i * 100): ShortlistRow => ({ id: `r${i}`, phrase, basis: 'measured', searches, measuredMonth: '2026-10',
  measuredAt: '2026-11-01T00:00:00.000Z', parent: null, parentSearches: null, difficulty: 20, intent: 'informational', clusterId: 'c', role: i ? 'supporting' : 'pillar', why: '' });
/** The phrase bound for one brief that chose `chosen` among `phrases` (all target candidates), or null. */
function bindOne(phrases: readonly string[], chosen: string, question: string, title: string): { phrase: string | null; reason: string | null } {
  const c: PlanningCandidates = { primary: phrases.map((p, i) => short(p, i)), secondary: [] };
  const out = bindByIds([{ key: 'b', primaryId: `K${phrases.indexOf(chosen) + 1}`, secondaryIds: [], text: { question, title } }], c);
  return { phrase: out.bound.get('b')!.primary?.phrase ?? null, reason: out.dropped[0]?.reason ?? null };
}

test('P1: of twin phrases (same meaning words: "near me", "uk", "best", a plural) the one worded closer to the brief binds; a slip between twins does not', () => {
  const twins = ['boiler repair', 'boiler repair near me', 'boiler repair uk', 'best boiler repair', 'boiler repair cost'];
  const repair = ['What should I do when my boiler breaks down?', 'Boiler Repair: What to Check Before You Call an Engineer'] as const;
  const nearMe = ['How do I find a trustworthy boiler repair engineer near me?', 'Finding a Local Boiler Repair Engineer You Can Trust'] as const;
  assert.deepEqual(bindOne(twins, 'boiler repair', ...repair), { phrase: 'boiler repair', reason: null });
  assert.deepEqual(bindOne(twins, 'boiler repair near me', ...nearMe), { phrase: 'boiler repair near me', reason: null });
  // The twin that is worded less closely is refused, so a slip between twins never binds.
  assert.deepEqual(bindOne(twins, 'boiler repair near me', ...repair), { phrase: null, reason: 'tied' });
  assert.deepEqual(bindOne(twins, 'boiler repair uk', ...repair), { phrase: null, reason: 'tied' });
  assert.deepEqual(bindOne(twins, 'boiler repair', ...nearMe), { phrase: null, reason: 'tied' });
  assert.deepEqual(bindOne(twins, 'best boiler repair', 'Who is the best boiler repair engineer in town?', 'The Best Boiler Repair Engineers'), { phrase: 'best boiler repair', reason: null });
  // Twins worded equally close (a plural twin the pool did not merge): the planner's choice stands, whichever it was.
  const fees = ['estate agent fees', 'estate agents fees', 'online estate agents'];
  assert.equal(bindOne(fees, 'estate agent fees', 'How much do estate agents charge to sell a house?', 'Estate Agent Fees Explained').phrase, 'estate agent fees');
  assert.equal(bindOne(fees, 'estate agents fees', 'How much do estate agents charge to sell a house?', 'Estate Agent Fees Explained').phrase, 'estate agents fees');
  // A tie with a phrase that is not a twin still binds neither.
  const landlord = ['landlord insurance', 'landlord tax', 'landlord licence'].map((p, i) => short(p, i));
  assert.equal(bestFit(landlord[0]!, t('What must a landlord do by law?'), landlord), 'tied');
  assert.equal(bestFit(landlord[1]!, t('What must a landlord do by law?'), landlord), 'tied');
});

test('P1 through the real pool builder (the reviewer\'s twins case): "boiler repair" and "boiler repair near me" each bind for their own article', () => {
  const now = '2026-11-16T10:00:00.000Z';
  const c = (phrase: string, searches: number, difficulty = 20, intent = 'commercial') => ({ phrase, searches, measuredMonth: '2026-10', dataUpdatedAt: null, rankingDifficulty: difficulty, adCompetition: 0.9,
    cpc: 1.2, intent, secondaryIntents: [], source: 'ideas', parent: null, locationCode: 2826, languageCode: 'en' });
  const business = { profile: { offers: [{ name: 'Boiler repair', description: 'Boiler repair, boiler servicing and new boiler installation for homes in Leeds', price: null, url: null, sourceDocumentId: null }],
    audiences: ['Homeowners in Leeds', 'Landlords'], exclusions: [], voice: { tone: [], do: [], dont: [], examples: [] }, confirmedAt: '2026-10-01T00:00:00.000Z' },
  brandName: 'Aire Heating', website: 'https://aire.example', locations: ['Leeds'], competitorNames: [], competitorDomains: [], pages: [], planned: [], dismissed: [] };
  const cands = [c('boiler repair', 40500), c('boiler repair near me', 33100), c('boiler repairs', 9900), c('best boiler repair', 320), c('boiler repair uk', 480), c('boiler repair leeds', 880),
    c('boiler repair cost', 1900, 15, 'informational'), c('emergency boiler repair', 2400), c('boiler service', 27100), c('boiler service near me', 18100), c('boiler servicing', 5400),
    c('boiler service cost', 3600, 15, 'informational'), c('new boiler cost', 14800, 25, 'informational'), c('gas engineer near me', 22200), c('gas engineer', 12100)];
  const pool = buildKeywordPool(cands as never, business as never);
  const pc = planningCandidates({ rows: pool.rows.map((r) => ({ ...r, measuredAt: now })), locationCode: 2826 } as never, [], now);
  const k = (phrase: string) => `K${pc.primary.findIndex((r) => r.phrase === phrase) + 1}`;
  for (const p of ['boiler repair', 'boiler repair near me', 'boiler repair uk', 'best boiler repair']) assert.ok(pc.primary.some((r) => r.phrase === p), `${p} is a target candidate`);
  const out = bindByIds([
    { key: 'repair', primaryId: k('boiler repair'), secondaryIds: [], text: t('What should I do when my boiler breaks down?', 'Boiler Repair: What to Check Before You Call an Engineer') },
    { key: 'near', primaryId: k('boiler repair near me'), secondaryIds: [], text: t('How do I find a trustworthy boiler repair engineer near me?', 'Finding a Local Boiler Repair Engineer You Can Trust') },
  ], pc);
  assert.equal(out.bound.get('repair')!.primary?.phrase, 'boiler repair');
  assert.equal(out.bound.get('repair')!.primary?.searches, 40500);
  assert.equal(out.bound.get('near')!.primary?.phrase, 'boiler repair near me');
  assert.equal(out.bound.get('near')!.primary?.searches, 33100);
  assert.deepEqual(out.dropped, []);
});

/** The reviewer's eight new shortlists through the real bindByIds: correct choices refused and sibling slips bound. */
function shortlistTable(): { refused: string[]; slipsBound: string[] } {
  const refused: string[] = [], slipsBound: string[] = [];
  for (const [name, c] of Object.entries(newClusters)) {
    const cands: PlanningCandidates = { primary: c.map(([phrase], i) => short(phrase, i)), secondary: [] };
    for (let i = 0; i < c.length; i++) for (let j = 0; j < c.length; j++) {
      const out = bindByIds([{ key: 'b', primaryId: `K${j + 1}`, secondaryIds: [], text: { question: c[i]![1], title: c[i]![2] } }], cands);
      const got = out.bound.get('b')!.primary;
      if (i === j && !got) refused.push(`${name.split(':')[0]}: ${c[i]![0]}`);
      if (i !== j && got) slipsBound.push(`${name.split(':')[0]}: "${got.phrase}" on ${c[i]![2]}`);
    }
  }
  return { refused, slipsBound };
}
/** The reviewer's 108 pairs (a pair with a shortlist through bindByIds, else the pairwise rule). */
function pairTable(): { rightRefused: string[]; wrongAccepted: string[] } {
  const rightRefused: string[] = [], wrongAccepted: string[] = [];
  for (const p of newPairs) {
    const ok = p.shortlist ? bindOne([p.phrase, ...p.shortlist], p.phrase, p.q, p.t).phrase !== null
      : bindOne([p.phrase], p.phrase, p.q, p.t).phrase !== null;
    if (p.kind === 'right' && !ok) rightRefused.push(`${p.phrase} ⇐ ${p.q}`);
    if (p.kind === 'wrong' && ok) wrongAccepted.push(`${p.phrase} ⇐ ${p.q}`);
  }
  return { rightRefused, wrongAccepted };
}

test('P1 on the reviewer\'s data: no twin tie refuses a correct choice, and no sibling slip binds', (t) => {
  const s = shortlistTable(), p = pairTable();
  t.diagnostic(`shortlists: correct refused ${s.refused.length}/56, slips bound ${s.slipsBound.length}/336; pairs: right refused ${p.rightRefused.length}/56, wrong accepted ${p.wrongAccepted.length}/52`);
  for (const twin of ['A trades: boiler repair', 'A trades: boiler repair near me']) assert.ok(!s.refused.includes(twin), twin);
  for (const phrase of ['boiler repair', 'estate agent fees']) assert.ok(!p.rightRefused.some((r) => r.startsWith(`${phrase} ⇐`)), phrase);
  assert.deepEqual(s.slipsBound, [], 'no sibling slip binds');
});
