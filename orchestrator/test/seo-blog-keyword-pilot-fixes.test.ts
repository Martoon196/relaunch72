/**
 * Fixes from the second review of keyword-first planning (review2-keyword-followups) before a one-business pilot:
 * P1 twin phrases, P2 a pillar whose title names its sub-topics, P3 the place rule. Each test below failed on
 * cda1d9dc and passes after its fix. The reviewer's own data (`keyword-fit-cases-review2.ts`) is run through the real
 * `bindByIds`, plus the reviewer's twin case through the real pool builder. Doubles only: no network and no paid call.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { bestFit, bindByIds, phraseFits, planningCandidates, type PlanningCandidates, type ShortlistRow } from '../src/seo-blog/keyword-planning.js';
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
  // Twins only half in the brief still tie (the reviewer's orphan case: "boiler repair" on a boiler servicing article).
  assert.deepEqual(bindOne(['boiler repair', 'boiler repair near me', 'new boiler cost'], 'boiler repair', 'How often should a boiler be serviced?', 'Boiler Servicing: How Often and What It Includes'),
    { phrase: null, reason: 'tied' });
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

test('P2: a pillar whose title names several sub-topics binds its broad phrase; an article about one sub-topic still refuses it', () => {
  const insurance = ['landlord insurance', 'landlord insurance cost', 'landlord insurance quotes', 'landlord contents insurance'];
  const pillar = ['What does landlord insurance cover and what does it cost?', 'Landlord Insurance: Cover, Costs and How to Compare Quotes'] as const;
  const cost = ['How much does landlord insurance cost?', 'Landlord Insurance Cost: What Affects Your Premium'] as const;
  const quotes = ['How do I compare landlord insurance quotes?', 'Comparing Landlord Insurance Quotes Properly'] as const;
  assert.deepEqual(bindOne(insurance, 'landlord insurance', ...pillar), { phrase: 'landlord insurance', reason: null });
  assert.deepEqual(bindOne(['loft conversion', 'loft conversion cost', 'loft conversion planning permission'], 'loft conversion', 'Is a loft conversion worth it?', 'Loft Conversions: Cost, Planning Permission and Added Value'),
    { phrase: 'loft conversion', reason: null });
  assert.deepEqual(bindOne(['self assessment', 'self assessment deadline', 'self assessment penalties', 'sole trader tax'], 'self assessment', 'How does self assessment work for a sole trader?',
    'Self Assessment: Deadlines, Penalties and How to File'), { phrase: 'self assessment', reason: null });
  // One sub-topic named: the narrower phrase is the article's; the broad one is refused, as before.
  assert.deepEqual(bindOne(insurance, 'landlord insurance', ...cost), { phrase: null, reason: 'fits_another_better' });
  assert.deepEqual(bindOne(insurance, 'landlord insurance', ...quotes), { phrase: null, reason: 'fits_another_better' });
  assert.equal(bindOne(insurance, 'landlord insurance cost', ...cost).phrase, 'landlord insurance cost');
  // A narrower phrase that covers every extra word still wins: "cost calculator" holds "cost".
  const calc = ['landlord insurance', 'landlord insurance cost', 'landlord insurance cost calculator'];
  assert.deepEqual(bindOne(calc, 'landlord insurance', 'How do I use a landlord insurance cost calculator?', 'Landlord Insurance Cost Calculator'), { phrase: null, reason: 'fits_another_better' });
  // The sub-topic phrases do not bind on the pillar: two of them fit it equally well.
  assert.deepEqual(bindOne(insurance, 'landlord insurance cost', ...pillar), { phrase: null, reason: 'tied' });
  // A broad phrase only half in the brief gains nothing from narrower phrases.
  assert.deepEqual(bindOne(['boiler service', 'boiler service cost', 'boiler service plan'], 'boiler service', 'How often does a boiler need checking?', 'Boiler Checks: Cost and Plans'),
    { phrase: null, reason: 'fits_another_better' });
});

test('P2 on the reviewer\'s data: both pillars that lost their phrase now bind, and still no sibling slip binds', (t) => {
  const s = shortlistTable(), p = pairTable();
  t.diagnostic(`shortlists: correct refused ${s.refused.length}/56 [${s.refused.join('; ')}], slips bound ${s.slipsBound.length}/336`);
  for (const pillar of ['G insurance broker: landlord insurance', 'H accountant: self assessment']) assert.ok(!s.refused.includes(pillar), pillar);
  for (const phrase of ['landlord insurance', 'loft conversion']) assert.ok(!p.rightRefused.some((r) => r.startsWith(`${phrase} ⇐`)), phrase);
  assert.deepEqual(s.slipsBound, [], 'no sibling slip binds');
  assert.ok(s.refused.length <= 1, `correct refused ${s.refused.length}/56 (at most 1: "boiler service" against servicing, a stem miss)`);
});

test('P3: the place rule binds a local phrase for the business\'s own area and still refuses a phrase for another place', () => {
  // The reviewer's refused right pairs, each with the place it names.
  const right: [string, string, string][] = [
    ['estate agents london', 'How do I choose an estate agent in North London?', 'Estate Agents in North London: How to Choose'],
    ['plumber manchester', 'Who is a reliable plumber in Greater Manchester?', 'Plumbers in Greater Manchester You Can Rely On'],
    ['wedding venues yorkshire', 'How do I choose a wedding venue in North Yorkshire?', 'Wedding Venues in North Yorkshire: Questions to Ask'],
    ['wedding venues north yorkshire', 'How do I choose a wedding venue in North Yorkshire?', 'Wedding Venues in North Yorkshire: Questions to Ask'],
    ['landlord gas safety certificate', 'How often do landlords need a gas safety check in England?', 'Gas Safety Checks for Landlords'],
    ['eviction notice period', 'How much notice does a landlord have to give in Scotland?', 'Eviction Notice in Scotland: How Long Tenants Get'],
    ['stamp duty calculator', 'How much stamp duty will I pay from April?', 'Working Out Your Stamp Duty'],
    ['furnished holiday let tax', 'How is income from Airbnb taxed?', 'Holiday Let Tax Rules'],
    ['house repairs', 'Who Pays For Repairs In Rented Houses?', 'Repairs In A Rental: Who Pays'],
    ['landlord insurance cost', 'How Much Is Landlord Insurance In January?', 'Landlord Insurance Prices'],
    ['boiler repair cost', 'What does boiler repair cost at Christmas?', 'Boiler Repair Prices'],
    ['emergency plumber leeds', 'Who can I call for an emergency plumber in Central Leeds?', 'Emergency Plumbers in Central Leeds'],
  ];
  for (const [phrase, q, title] of right) assert.equal(phraseFits(phrase, t(q, title)), true, `${phrase} ⇐ ${q}`);
  // A phrase for another place is still refused.
  const wrong: [string, string, string][] = [
    ['plumber leeds', 'How do I find a plumber in Bradford?', 'Finding a Plumber in Bradford'],
    ['plumber leeds', 'Can a plumber from Bradford work on my boiler?', 'Hiring a Plumber From Bradford'],
    ['boiler repair leeds', 'How much does boiler repair cost in Sheffield?', 'Boiler Repair Costs in Sheffield'],
    ['estate agents york', 'Which estate agents are best in New York?', 'New York Estate Agents Compared'],
    ['estate agents york', 'How do I choose an estate agent in North Yorkshire?', 'Estate Agents in North Yorkshire'],
    ['estate agents south london', 'How do I choose an estate agent in North London?', 'Estate Agents in North London: How to Choose'],
    ['plumber manchester', 'Who is a reliable plumber in Greater London?', 'Plumbers in Greater London'],
    ['landlord registration scotland', 'Do I have to register as a landlord in England?', 'Landlord Registration in England'],
    ['eviction notice scotland', 'How much notice does a landlord give in Wales?', 'Eviction Notice in Wales'],
    ['tenant referencing', 'What documents must I see before letting to a new tenant in England?', 'Right to Rent Checks: A Step-by-Step Guide'],
    ['afternoon tea york', 'Where can I get a good afternoon tea in New York?', 'Afternoon Tea in New York'],
  ];
  for (const [phrase, q, title] of wrong) assert.equal(phraseFits(phrase, t(q, title)), false, `${phrase} ⇐ ${q}`);
});

test('P3 on the reviewer\'s data: every right pair that names a place binds, with no more wrong pairs accepted and no sibling slip', (t) => {
  const p = pairTable(), s = shortlistTable();
  t.diagnostic(`pairs: right refused ${p.rightRefused.length}/56, wrong accepted ${p.wrongAccepted.length}/52; shortlists: correct refused ${s.refused.length}/56, slips bound ${s.slipsBound.length}/336`);
  const placeNotes = newPairs.filter((x) => x.kind === 'right' && /place/.test(x.note ?? ''));
  assert.equal(placeNotes.length, 9);
  for (const x of placeNotes) assert.ok(!p.rightRefused.includes(`${x.phrase} ⇐ ${x.q}`), `${x.phrase} ⇐ ${x.q}`);
  // Wrong pairs accepted were 31/52 at cda1d9dc; the place fix must not add one.
  assert.ok(p.wrongAccepted.length <= 31, `wrong pairs accepted ${p.wrongAccepted.length}`);
  for (const x of newPairs.filter((y) => y.kind === 'wrong' && y.note === 'place')) assert.ok(!p.wrongAccepted.includes(`${x.phrase} ⇐ ${x.q}`), `${x.phrase} ⇐ ${x.q}`);
  assert.deepEqual(s.slipsBound, []);
});
