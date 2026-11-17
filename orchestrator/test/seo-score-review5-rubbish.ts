/**
 * The fifth review's rubbish (copied from the reviewer's attack5.ts, attack5b.ts, shared.ts and dbg3.ts, same seeds,
 * same hosts): every attempt aimed at the fourth round's rules. Each row says how it is refused, or that it is a
 * KNOWN LIMIT: low-value text a word-counting score cannot tell from writing without refusing good pages too. The
 * known limits are listed once, in KNOWN_LIMITS below, with why a word count cannot decide each one: that list is the
 * to-do list of the separate meaning check the gate requires (see seoGate in src/seo-blog/seo-score.ts).
 */
import type { ArticleBody, ArticleBrief } from '../src/seo-blog/types.js';
import * as F from './seo-panel-fixtures.js';
import * as R2 from './seo-score-review2-fixtures.js';
import * as R3 from './seo-score-review3-fixtures.js';
import { DAMP, HEATPUMP, MOT, PROBATE } from './seo-score-review5-good.js';
import * as G4 from './seo-score-review4-good.js';
import type { Art } from './seo-score-review4-good.js';

type Brief = Pick<ArticleBrief, 'targetQuery'> & Partial<Pick<ArticleBrief, 'relatedQuestions' | 'searchIntent'>>;
type Ctx = { siteHosts: string[]; selfUrl: string; checkIssues: never[]; targetMode: true };
export interface Case { readonly brief: Brief; readonly body: ArticleBody; readonly ctx: Ctx }
/**
 * How a row is refused: by a cap (its kind), by the gate's own reasons with no cap ('gate': the phrase a little high,
 * or the score under the bar), or not at all ('limit': listed in KNOWN_LIMITS).
 */
export type Outcome = 'repetition' | 'stuffing' | 'short-items' | 'run-on' | 'not-sentences' | 'gate' | 'limit';

const B: Brief = R2.REVIEW2_BRIEF;
const C = R2.REVIEW2_CONTEXT as Ctx;
const P = 'appraise a property deal';
const TOWN = `Leeds Bradford York Hull Sheffield Derby Leicester Coventry Luton Reading Slough Swindon Bristol Bath Exeter Plymouth Truro Cardiff Swansea Newport Wrexham Chester Crewe Stoke Stafford Telford Dudley Walsall Solihull Rugby Corby Bedford Ipswich Norwich Lincoln Grimsby Doncaster Barnsley Wakefield Halifax Burnley Preston Blackpool Lancaster Kendal Carlisle Durham Sunderland Gateshead Hexham Whitby Ripon Skipton Otley Ilkley Selby Goole Thirsk`.split(/\s+/);
const KW = `houses flats homes bungalows terraces cottages studios lofts plots garages shops offices units barns land rentals lets sales auctions bargains repossessions conversions refurbs investments yields mortgages loans surveys valuations lettings`.split(/\s+/);
const ADJ = `cheap best top quick easy local trusted new cheapest fast free low great prime hot`.split(/\s+/);
const T = (i: number) => TOWN[((i % TOWN.length) + TOWN.length) % TOWN.length]!;
const K = (i: number) => KW[((i % KW.length) + KW.length) % KW.length]!;
/** As the reviewer's scripts index the towns (some go past the end of the list, as there). */
const TR = (i: number) => String(TOWN[i]);
const J = (i: number) => ADJ[((i % ADJ.length) + ADJ.length) % ADJ.length]!;
/** The reviewer's generator (seed 7 unless given), started afresh for every article. */
function rng(seed = 7) {
  let x = seed;
  const rnd = () => (x = (x * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  return { rnd, pick: <V,>(a: readonly V[]) => a[Math.floor(rnd() * a.length)]! };
}
const cap1 = (s: string) => `${s[0]!.toUpperCase()}${s.slice(1)}`;
const each = R3.eachPart;
const ctxOf = (x: Art): Ctx => ({ siteHosts: [x.site], selfUrl: `${x.site}/blog/${x.body.slug}`, checkIssues: [], targetMode: true });
const addEach = (b: ArticleBody, add: (i: number) => string): ArticleBody => ({ ...b, sections: b.sections.map((s, i) => ({ ...s, body: `${s.body}\n\n${add(i)}` })) }) as ArticleBody;
const withPhraseQuestion: Brief = { ...B, relatedQuestions: [...(B.relatedQuestions ?? []), 'How do I appraise a property deal?'] };
/** Step-sized keyword bullets ("- cheap houses in Leeds for best flats"), `w` words, `per` after every part. */
const stepBullets = (b: ArticleBody, per: number, w: number, seed = 3): ArticleBody => { const { pick } = rng(seed); let k = 0; return addEach(b, () => Array.from({ length: per }, () => { k++; return `- ${[pick(ADJ), pick(KW), 'in', T(k), 'for', pick(ADJ), pick(KW), 'near', T(k * 7)].slice(0, w).join(' ')}`; }).join('\n')); };
const longSentence = (pick: <V,>(a: readonly V[]) => V, n: number) => `We cover ${Array.from({ length: n }, () => `${pick(KW)} ${pick(['in', 'near', 'around', 'across'])} ${pick(TOWN)}`).join(' and ')}.`;
const fifteen = (pick: <V,>(a: readonly V[]) => V) => `- ${Array.from({ length: 4 }, () => `${pick(ADJ)} ${pick(KW)} in ${pick(TOWN)}`).join(' and ')}`;
const SAME = Array.from({ length: 10 }, (_, i) => `- We sell ${J(i)} ${K(i)} near ${T(i)} daily`);
const fresh = (k: number) => `- They let ${J(k * 7)} ${K(k * 11 + 3)} around ${T(k * 13 + 20)} weekly`;
const SAME3 = Array.from({ length: 6 }, (_, i) => `- ${K(i)} in ${T(i)}`);
/** The phrase k times more (R2.strongPlusPhrase) and `per` one-word bullets after every part, numbered or dashed. */
const numbered = (k: number, per: number, num: boolean): ArticleBody => { let i = 0; return addEach(R2.strongPlusPhrase(k), () => Array.from({ length: per }, () => { const t = T(i++); return num ? `${(i % per) + 1}. ${t}` : `- ${t}`; }).join('\n')); };

const rows: [string, () => Case, Outcome][] = [];
const A = (name: string, body: () => ArticleBody, outcome: Outcome, brief: Brief = B, ctx: Ctx = C) => rows.push([name, () => ({ brief, body: body(), ctx }), outcome]);

// ── G1: the on-record-question exemption as a hiding place for the phrase (attack5.ts E1 to E4, attack5b.ts E5 to E9)
A('E1 good article N4 + 40 "### Rising damp treatment <town>" lines', () => ({ ...DAMP.body, sections: DAMP.body.sections.map((s, i) => ({ ...s, body: `${s.body}\n\n${Array.from({ length: 10 }, (_, j) => `### Rising damp treatment ${T(i * 10 + j)}`).join('\n')}` })) }) as ArticleBody, 'stuffing', DAMP.brief, ctxOf(DAMP));
A('E2 good article N4 + 12 extra parts headed "Rising damp treatment cost in <town>"', () => { const { pick } = rng(); return { ...DAMP.body, sections: [...DAMP.body.sections, ...Array.from({ length: 12 }, (_, i) => ({ id: `x${i}`, heading: `Rising damp treatment cost in ${T(i)}`, body: `Our ${pick(ADJ)} team in ${T(i)} looks after ${pick(KW)} and ${pick(KW)} every week of the year, so you can ring us when it suits you. We also cover ${T(i + 20)} and ${T(i + 30)}, because many of our customers have moved there. Ask for a price and we will give you one on the day.` }))] } as ArticleBody; }, 'repetition', DAMP.brief, ctxOf(DAMP));
A('E3 strong fixture, one more on-record question holding the phrase, + 60 "### Appraise a property deal in <town>" lines', () => each((i) => Array.from({ length: 5 }, (_, j) => `### Appraise a property deal in ${T(i * 5 + j)}`).join('\n')), 'stuffing', withPhraseQuestion);
A('E4 the stuffing fixture with every added phrase sentence turned into a "### " line, one more on-record question', () => { const st = F.strongBody(); const plus = R2.strongPlusPhrase(16); return { ...plus, sections: plus.sections.map((x, i) => { const base = st.sections[i]!.body; const added = x.body.slice(base.length).trim(); return { ...x, body: `${base}\n\n${added.split(/(?<=\.)\s+/).filter(Boolean).map((s) => `### ${s.replace(/\.$/, '')}`).join('\n')}` }; }) } as ArticleBody; }, 'stuffing', withPhraseQuestion);
A('E5 good article N4 + 100 "### Rising damp treatment <town>" lines', () => addEach(DAMP.body, (i) => Array.from({ length: 25 }, (_, j) => `### Rising damp treatment ${T(i * 25 + j)}${i * 25 + j >= TOWN.length ? ` ${K(i * 25 + j)}` : ''}`).join('\n')), 'stuffing', DAMP.brief, ctxOf(DAMP));
A('E6 good article N4 with the phrase at the front of every part heading and question', () => ({ ...DAMP.body, sections: DAMP.body.sections.map((s) => ({ ...s, heading: /rising damp treatment/i.test(s.heading) ? s.heading : `Rising damp treatment: ${s.heading[0]!.toLowerCase()}${s.heading.slice(1)}` })), faqs: DAMP.body.faqs.map((f) => ({ ...f, q: `Rising damp treatment: ${f.q[0]!.toLowerCase()}${f.q.slice(1)}` })) }) as ArticleBody, 'gate', DAMP.brief, ctxOf(DAMP));
A('E7 good article N13 ("probate") + 60 "### Probate <town> <word> advice" lines', () => addEach(PROBATE.body, (i) => Array.from({ length: 12 }, (_, j) => `### Probate ${TR(i * 12 + j)} ${K(i * 12 + j)} advice`).join('\n')), 'stuffing', PROBATE.brief, ctxOf(PROBATE));
A('E8 good page P3 ("MOT") + 40 "### Cheap MOT <town> <word>" lines', () => addEach(MOT.body, (i) => Array.from({ length: 10 }, (_, j) => `### ${cap1(J(i * 10 + j))} MOT ${T(i * 10 + j)} ${K(i * 3 + j)}`).join('\n')), 'stuffing', MOT.brief, ctxOf(MOT));
A('E9 good article N12 (heat pump) + 30 "### Air source heat pump installation cost <town>" lines', () => addEach(HEATPUMP.body, (i) => Array.from({ length: 6 }, (_, j) => `### Air source heat pump installation cost ${T(i * 6 + j)}`).join('\n')), 'stuffing', HEATPUMP.brief, ctxOf(HEATPUMP));

// ── G2: step-sized bullets (4 to 9 words) and numbered bullets as a diluter
A('D1 platitudes fixture + 12 different five-word keyword bullets per part', () => stepBullets(R2.make(R2.GEN.platitude), 12, 5), 'repetition');
A('D2 platitudes fixture + 20 different six-word keyword bullets per part', () => stepBullets(R2.make(R2.GEN.platitude), 20, 6), 'repetition');
A('D3 four-templates fixture + 20 different nine-word keyword bullets per part', () => stepBullets(R2.make(R2.GEN.templ), 20, 9), 'repetition');
A('D4 the stuffing fixture + 22 different six-word keyword bullets per part', () => stepBullets(R2.strongPlusPhrase(16), 22, 6), 'stuffing');
A('D5 strong fixture + 15 six-word keyword bullets per part (about 55% of the page)', () => stepBullets(F.strongBody(), 15, 6), 'short-items');
A('D6 platitudes fixture + 8 different eight-word bullets per part', () => { let k = 0; return addEach(R2.make(R2.GEN.platitude), () => Array.from({ length: 8 }, () => { k++; return `- ${J(k)} ${K(k)} in ${TR(k % 60)} for ${J(k * 7)} ${K(k * 11)} near ${TR((k * 13) % 60)}`; }).join('\n')); }, 'repetition');
A('D7 the phrase five times in the page title + 7 seven-word bullets per part', () => { let k = 0; return addEach({ ...F.strongBody(), title: Array.from({ length: 5 }, () => P).join(', ') } as ArticleBody, () => Array.from({ length: 7 }, () => { k++; return `- ${J(k)} ${K(k)} in ${TR(k % 60)} for ${J(k * 7)} ${K(k * 11)}`; }).join('\n')); }, 'repetition');
A('D8 the phrase a little high (strongPlusPhrase(8)) + 6 six-word keyword bullets per part', () => { let k = 0; return addEach(R2.strongPlusPhrase(8), () => Array.from({ length: 6 }, () => { k++; return `- ${J(k)} ${K(k)} in ${TR(k % 60)} for ${K(k * 11)}`; }).join('\n')); }, 'stuffing');
A('G2 the phrase at 2.6% + four numbered one-word bullets per part ("1. Leeds")', () => numbered(5, 4, true), 'gate');
A('G2 the phrase at 2.6% + six numbered one-word bullets per part', () => numbered(5, 6, true), 'gate');
A('G2 the phrase at 2.6% + four dashed one-word bullets per part (the control)', () => numbered(5, 4, false), 'gate');

// ── M2: a pasted list made to look like "a job every room shares" (shared.ts)
A('M2 the same 10 six-word keyword bullets after 4 parts', () => each((i) => (i < 4 ? SAME.join('\n') : '')), 'repetition');
A('M2 the same + 11 different six-word bullets in each of those 4 lists', () => each((i) => (i < 4 ? [...SAME, ...Array.from({ length: 11 }, (_, j) => fresh(i * 11 + j))].join('\n') : '')), 'repetition');
A('M2 the same 10 bullets after 5 parts + 11 different in each', () => each((i) => (i < 5 ? [...SAME, ...Array.from({ length: 11 }, (_, j) => fresh(i * 11 + j))].join('\n') : '')), 'repetition');
A('M2 two pasted lists of 8 (parts 1-4 and 5-8) + 9 different in each list', () => each((i) => (i < 8 ? [...Array.from({ length: 8 }, (_, j) => `- We ${i < 4 ? 'sell' : 'rent'} ${J(j)} ${K(j + (i < 4 ? 0 : 10))} near ${T(j)} daily`), ...Array.from({ length: 9 }, (_, j) => fresh(i * 9 + j))].join('\n') : '')), 'repetition');
A('M2 the same 6 three-word bullets after 4 parts', () => each((i) => (i < 4 ? SAME3.join('\n') : '')), 'repetition');
A('M2 the same 6 three-word bullets + 7 different three-word bullets in each', () => each((i) => (i < 4 ? [...SAME3, ...Array.from({ length: 7 }, (_, j) => `- ${K(i * 7 + j + 9)} near ${T(i * 7 + j + 30)}`)].join('\n') : '')), 'repetition');

// ── G3: short lines that are not items, pasted short paragraphs, and bullets of many two- or three-word sentences
A('S1 the same 3 three-word keyword lines as separate paragraphs after every part (36 pasted lines)', () => each(() => ['Cheap houses Leeds.', 'Best flats York.', 'Top homes Hull.'].join('\n\n')), 'repetition');
A('S2 "Cheap houses Leeds." pasted as 30 separate paragraphs', () => each((i) => (i < 10 ? Array.from({ length: 3 }, () => 'Cheap houses Leeds.').join('\n\n') : '')), 'repetition');
A('S3 3 different three-word keyword sentences inside a paragraph, after every part', () => { const { pick } = rng(); return each(() => Array.from({ length: 3 }, () => `${pick(ADJ)[0]!.toUpperCase()}${pick(ADJ).slice(1)} ${pick(KW)} ${pick(TOWN)}.`).join(' ')); }, 'limit');
A('S4 "Call us today." as its own paragraph twice after every part (24 copies)', () => each(() => 'Call us today.\n\nCall us today.'), 'repetition');
A('S5 5 different three-word keyword paragraphs after every part (60 lines)', () => { const { pick } = rng(); return each(() => Array.from({ length: 5 }, () => `${pick(ADJ)} ${pick(KW)} ${pick(TOWN)}`).join('\n\n')); }, 'limit');
A('I1 3 bullets per part, each 8 different two-word keyword "sentences"', () => { const { rnd } = rng(); let k = 0; const fat = (n: number) => Array.from({ length: 8 }, (_, j) => `${cap1(J(n + j))} ${K(n * 3 + j * 5 + Math.floor(rnd() * 30))}.`).join(' '); return each(() => Array.from({ length: 3 }, () => `- ${fat(k++)}`).join('\n')); }, 'not-sentences');
A('I2 one bullet of 8 two-word "sentences" pasted 3 times after every part', () => each(() => Array.from({ length: 3 }, () => '- Cheap houses. Best flats. Top homes. Quick sales. Easy lets. Local plots. New barns. Low rents.').join('\n')), 'repetition');
A('I3 one bullet of five three-word "sentences" with a small word, pasted 4 times after every part', () => each(() => Array.from({ length: 4 }, () => '- Cheap houses in Leeds. Best flats in York. Top homes in Hull. Quick sales in Bath. Easy lets in Derby.').join('\n')), 'repetition');
A('I4 one 15-word bullet of five 3-word keyword sentences pasted 3 times after every part (36 copies)', () => each(() => Array.from({ length: 3 }, () => '- Houses in Leeds. Flats in York. Homes in Hull. Sales in Bath. Lets in Derby.').join('\n')), 'repetition');
A('I5 3 different such bullets after every part', () => { const { pick } = rng(); return each(() => Array.from({ length: 3 }, () => `- ${Array.from({ length: 5 }, () => `${cap1(pick(KW))} in ${pick(TOWN)}.`).join(' ')}`).join('\n')); }, 'limit');

// ── G3: long items, wide table rows, run-ons
A('L1 5 bullets per part of 15 keyword words each ("cheap houses in Leeds and best flats in York and ...")', () => { const { pick } = rng(); return each(() => Array.from({ length: 5 }, () => fifteen(pick)).join('\n')); }, 'limit');
A('L2 a keyword table after every part: 5 rows of 15 cells', () => { const { pick } = rng(); return each(() => `| ${Array.from({ length: 15 }, (_, j) => `c${j}`).join(' | ')} |\n|${'---|'.repeat(15)}\n${Array.from({ length: 5 }, () => `| ${Array.from({ length: 5 }, () => `${pick(ADJ)} | ${pick(KW)} | ${pick(TOWN)}`).join(' | ')} |`).join('\n')}`); }, 'not-sentences');
A('L3 240 keyword bullets of exactly 15 words ("We find cheap houses and best flats in Leeds daily for ...")', () => { const { pick } = rng(); return each(() => Array.from({ length: 20 }, () => `- We find ${pick(ADJ)} ${pick(KW)} and ${pick(ADJ)} ${pick(KW)} in ${pick(TOWN)} ${pick(['daily', 'weekly', 'today', 'now', 'fast'])} for ${pick(ADJ)} buyers and ${pick(ADJ)} sellers`).join('\n')); }, 'repetition');
A('L4 10 bullets per part of 15 keyword words (68% of the page)', () => { const { pick } = rng(); return each(() => Array.from({ length: 10 }, () => fifteen(pick)).join('\n')); }, 'limit');
A('L5 platitudes fixture + 5 bullets per part of 15 keyword words', () => { const { pick } = rng(); return addEach(R2.make(R2.GEN.platitude), () => Array.from({ length: 5 }, () => fifteen(pick)).join('\n')); }, 'repetition');
A('O1 one 50-word keyword sentence per part', () => { const { pick } = rng(); return each(() => longSentence(pick, 12)); }, 'run-on');
A('O2 one 140-word keyword run-on in the whole article', () => { const { pick } = rng(); return each((i) => (i === 0 ? longSentence(pick, 34) : '')); }, 'limit');
A('O3 three 45-word keyword sentences per part', () => { const { pick } = rng(); return each(() => Array.from({ length: 3 }, () => longSentence(pick, 11)).join(' ')); }, 'run-on');
A('O4 two 50-word keyword sentences per part', () => { const { pick } = rng(); return each(() => Array.from({ length: 2 }, () => longSentence(pick, 12)).join('\n\n')); }, 'run-on');
A('O5 three 50-word keyword sentences in every other part', () => { const { pick } = rng(); return each((i) => (i % 2 ? '' : Array.from({ length: 3 }, () => longSentence(pick, 12)).join(' '))); }, 'run-on');
A('X1 per part: one 50-word keyword sentence, 3 bullets of 15 keyword words, 4 six-word keyword bullets, 1 two-word bullet', () => { const { pick } = rng(); return each(() => [longSentence(pick, 12), [...Array.from({ length: 3 }, () => fifteen(pick)), ...Array.from({ length: 4 }, () => `- ${pick(ADJ)} ${pick(KW)} in ${pick(TOWN)} for ${pick(KW)}`), `- ${pick(KW)} ${pick(TOWN)}`].join('\n')].join('\n\n')); }, 'run-on');

// ── S4, S5: the phrase said in ways the count does not see; headings and questions outside the measures
A('U1 16 sentence pairs splitting the phrase with a full stop', () => each((i) => (i < 8 ? `In ${T(i)} buyers ask how to appraise. A property deal there needs local figures first. Investors near ${T(i + 20)} learn to appraise. A property deal rewards patient sums.` : '')), 'repetition');
A('U2 24 sentences using two of its three main words ("property deal")', () => each((i) => `A property deal in ${T(i)} moves quickly in spring. Every property deal near ${T(i + 20)} needs a second look.`), 'limit');
A('U3 the page title set to 60 keyword words, the phrase once', () => { const { pick } = rng(); return { ...F.strongBody(), title: `How to ${P}: ${Array.from({ length: 18 }, () => `${pick(ADJ)} ${pick(KW)} ${pick(TOWN)}`).join(', ')}` } as ArticleBody; }, 'limit');
A('H1 150 extra questions, each a keyword line with an empty answer', () => { const { pick } = rng(); const b = F.strongBody(); return { ...b, faqs: [...b.faqs, ...Array.from({ length: 150 }, () => ({ q: `${pick(ADJ)} ${pick(KW)} in ${pick(TOWN)}?`, a: '' }))] } as ArticleBody; }, 'limit');
A('H2 the stuffing fixture + 150 keyword questions with empty answers', () => { const { pick } = rng(); const b = R2.strongPlusPhrase(16); return { ...b, faqs: [...b.faqs, ...Array.from({ length: 150 }, () => ({ q: `${pick(ADJ)} ${pick(KW)} for sale in ${pick(TOWN)} today?`, a: '' }))] } as ArticleBody; }, 'gate');
A('H3 200 extra parts: a keyword heading over an empty body', () => { const { pick } = rng(); const b = F.strongBody(); return { ...b, sections: [...b.sections, ...Array.from({ length: 200 }, (_, i) => ({ id: `k${i}`, heading: `${pick(ADJ)} ${pick(KW)} in ${pick(TOWN)} ${i}`, body: '' }))] } as ArticleBody; }, 'limit');
A('H4 the same keyword question 100 times with an empty answer', () => { const b = F.strongBody(); return { ...b, faqs: [...b.faqs, ...Array.from({ length: 100 }, () => ({ q: 'Cheap houses for sale in Leeds?', a: '' }))] } as ArticleBody; }, 'repetition');

// ── Just under each list line
A('M1 very short keyword bullets at about 11% and six-word keyword bullets at about 55%, together', () => { const { pick } = rng(); return each((i) => `${Array.from({ length: 14 }, () => `- ${pick(ADJ)} ${pick(KW)} in ${pick(TOWN)} for ${pick(KW)}`).join('\n')}\n\nAlso:\n\n${Array.from({ length: 4 }, (_, j) => `- ${K(i * 4 + j)} ${T(i * 4 + j)}`).join('\n')}`); }, 'short-items');
A('M2b distinctBullets(6): very short keyword bullets at 11.5%', () => R3.distinctBullets(6), 'limit');
A('M3 100 five-word template bullets, one word changed ("- We buy houses in <town>")', () => each((i) => Array.from({ length: 8 }, (_, j) => `- We buy houses in ${T(i * 8 + j)}`).join('\n')), 'repetition');
A('M4 60 four-word template sentences of prose ("We buy Leeds houses.")', () => each((i) => Array.from({ length: 5 }, (_, j) => `${['We', 'They', 'Buyers', 'Agents', 'Banks'][j]} ${['buy', 'sell', 'want', 'list', 'fund'][j]} ${T(i * 5 + j)} ${K(i * 5 + j)}.`).join(' ')), 'limit');

// ── G2's residue: different bullets of four to nine words still count as sentences for the sentence-length check
const FAQ3C = G4.VARIANTS.find((v) => v.art.name.startsWith('3c'))!.art;
const NO_PICTURE = { kind: 'none', url: null, alt: '', provenance: '', width: null, height: null };
A('G2r the 3c FAQ page without a picture (refused at 84) + 33 different four-word bullets in each of four parts', () => { let k = 0; return { ...FAQ3C.body, image: NO_PICTURE, sections: FAQ3C.body.sections.map((s, i) => (i < 4 ? { ...s, body: `${s.body}\n\n${Array.from({ length: 33 }, () => { k++; return `- zq${k}a in zq${k}b zq${k}c`; }).join('\n')}` } : s)) } as ArticleBody; }, 'limit', FAQ3C.brief, ctxOf(FAQ3C));

/** Every row of the fifth review's rubbish: [name, the article, how it is refused]. */
export const RUBBISH5: readonly (readonly [string, () => Case, Outcome])[] = rows;

/** One known limit: low-value text the gate lets through, kept visible for the meaning check. */
export interface KnownLimit {
  /** The family, in plain words. */
  readonly name: string;
  /** The article that shows it: a row name in RUBBISH5, the fourth review's RUBBISH4, the third review's DODGES or the
   * second review's KNOWN_LIMIT. Scored with its own brief and context, as the tests score that corpus. */
  readonly example: string;
  /** Its score on this tree (with the picture it has); the gate passes it. A change that catches it must move it out. */
  readonly score: number;
  /** Other rows of the same family, which pass the gate too. */
  readonly also?: readonly string[];
  /** Why a word count cannot decide it without refusing good pages too. */
  readonly why: string;
}
/**
 * KNOWN LIMITS: what the meaning check must catch, because this score cannot. Each passes the gate today; the tests
 * keep the list exact (every row of the corpora that passes is here, and everything here passes at this score).
 */
export const KNOWN_LIMITS: readonly KnownLimit[] = [
  { name: 'Fluent empty filler', example: 'N1 grammatical-looking filler (mad-lib sentences)', score: 98, also: ['N0 word salad with small words sprinkled in'],
    why: 'Grammatical sentences that say nothing have the same lengths, small words and variety as sentences that say something; only meaning tells them apart.' },
  { name: 'Very short keyword items under the 25% line', example: 'B4 keyword lines as blockquotes', score: 98, also: ['M2b distinctBullets(6): very short keyword bullets at 11.5%', 'a list with one word changed in every item, in two parts only (a quarter of the words)'],
    why: 'A kit list is 19.8% very short items ("Tent", "Spare pegs") and a price list 13.8%; keyword lines at 11% to 24% look the same to a counter, and "Spare pegs", "Spare socks" is one word changed too.' },
  { name: 'Long keyword items with no full stop', example: 'L1 5 bullets per part of 15 keyword words each ("cheap houses in Leeds and best flats in York and ...")', score: 98, also: ['L4 10 bullets per part of 15 keyword words (68% of the page)'],
    why: 'An item of 15 words joined by "and" and "in" has the small words of a sentence, and a thorough checklist is 45% items as long ("Cut the grass and weed the borders, if the garden is yours").' },
  { name: 'Different two- or three-word sentences of prose', example: 'S3 3 different three-word keyword sentences inside a paragraph, after every part', score: 92, also: ['S5 5 different three-word keyword paragraphs after every part (60 lines)', 'I5 3 different such bullets after every part'],
    why: 'Short sentences are ordinary ("Yes.", "Stir well.", "Call us."); only repeats of them are caught (from the sixth), and different keyword ones are not repeats.' },
  { name: 'Four-word template sentences', example: 'M4 60 four-word template sentences of prose ("We buy Leeds houses.")', score: 95,
    why: 'Templates are matched with one word changed from five words up; at four words every pair of plain sentences ("We buy the house.", "We sell the flat.") would match.' },
  { name: 'One long run-on in a long article', example: 'O2 one 140-word keyword run-on in the whole article', score: 97,
    why: 'It is 16.9% of the prose words; the article quoting a regulation has 14.7% in long sentences, so a line low enough to catch one run-on refuses good legal writing.' },
  { name: 'Two of the three main words of the phrase', example: 'U2 24 sentences using two of its three main words ("property deal")', score: 100,
    why: 'Natural writing about a phrase says its parts often ("the property", "the deal"); counting them as uses refuses the good price guide (2.7%).' },
  { name: 'The phrase split by a full stop or across two list items', example: 'the phrase split across two different list items', score: 97,
    why: 'Neither readers nor search engines read it as the phrase, so it is not counted as a use; the volume is held by the list measures.' },
  { name: 'A page title of keywords', example: 'U3 the page title set to 60 keyword words, the phrase once', score: 97,
    why: 'The page title is one line outside the text measures; how long a title may be is an editorial choice the score does not make.' },
  { name: 'Keyword questions with empty answers', example: 'H1 150 extra questions, each a keyword line with an empty answer', score: 97, also: ['H3 200 extra parts: a keyword heading over an empty body'],
    why: 'Questions and headings are not list items or sentences of the text. Empty parts are a must-fix of the quality checks (a part under 25 words), which hold the score at 59 when they run; whether the writer can produce an empty answer is not verified here.' },
  { name: 'Different bullets of four to nine words count as content', example: 'G2r the 3c FAQ page without a picture (refused at 84) + 33 different four-word bullets in each of four parts', score: 89,
    why: 'Steps and checklist items of four to nine words are content: they count towards length, part length and the sentence-length check. Leaving them out of those lowers 11, 9 and 4 good pages, so different bullets can still add points there (never through the phrase, repetition or list measures; at most the 11 points of those three checks, five seen) and lift a refused page over the bar (seen only within five points of it).' },
];
