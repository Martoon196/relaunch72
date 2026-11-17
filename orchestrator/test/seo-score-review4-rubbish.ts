/**
 * The fourth review's rubbish (copied from the reviewer's attack.ts, attack2.ts and dilute.ts, same seeds): every row of
 * its table "Rubbish that passed the gate", plus the dilution family behind its finding A2. Every article here must be
 * refused by the gate, apart from the few listed in KNOWN_LIMIT4 with the reason only a meaning check can catch them.
 */
import type { ArticleBody } from '../src/seo-blog/types.js';
import * as F from './seo-panel-fixtures.js';
import * as R2 from './seo-score-review2-fixtures.js';
import * as R3 from './seo-score-review3-fixtures.js';

const P = 'appraise a property deal';
const TOWN = `Leeds Bradford York Hull Sheffield Derby Leicester Coventry Luton Reading Slough Swindon Bristol Bath Exeter Plymouth Truro Cardiff Swansea Newport Wrexham Chester Crewe Stoke Stafford Telford Dudley Walsall Solihull Rugby Corby Bedford Ipswich Norwich Lincoln Grimsby Doncaster Barnsley Wakefield Halifax Burnley Preston Blackpool Lancaster Kendal Carlisle Durham Sunderland Gateshead Hexham Whitby Ripon Skipton Otley Ilkley Selby Goole Thirsk`.split(/\s+/);
const KW = `houses flats homes bungalows terraces cottages studios lofts plots garages shops offices units barns land rentals lets sales auctions bargains repossessions conversions refurbs investments yields mortgages loans surveys valuations lettings`.split(/\s+/);
const ADJ = `cheap best top quick easy local trusted new cheapest fast free low great prime hot`.split(/\s+/);
/** The reviewer's generator, seeded 7 afresh for every article. */
function rng() {
  let x = 7;
  const rnd = () => (x = (x * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  return { rnd, pick: <T,>(a: readonly T[]) => a[Math.floor(rnd() * a.length)]! };
}
const each = R3.eachPart;
type Body = ArticleBody;
const mapText = (b: Body, f: (t: string) => string): Body => ({ ...b, intro: f(b.intro), conclusion: f(b.conclusion), sections: b.sections.map((s) => ({ ...s, body: f(s.body) })), faqs: b.faqs.map((q) => ({ ...q, a: f(q.a) })) }) as Body;

/** `per` different bullets after every part: one word ("- Leeds") or two ("- Leeds houses"), as in dilute.ts. */
export const dilute = (b: Body, per: number, wordsEach: 1 | 2): Body => ({ ...b, sections: b.sections.map((s, i) => ({ ...s, body: `${s.body}\n\n${Array.from({ length: per }, (_, j) => { const k = i * per + j; return wordsEach === 1 ? `- ${TOWN[k % 58]}${k >= 58 ? ` ${KW[Math.floor(k / 58) % 30]}` : ''}` : `- ${TOWN[k % 58]} ${KW[(k * 7 + Math.floor(k / 58)) % 30]}`; }).join('\n')}` })) }) as Body;
const SYN: Record<string, string> = { property: 'home', deal: 'purchase', price: 'figure', value: 'worth', costs: 'bills', cost: 'bill', offer: 'bid', buy: 'purchase', sales: 'transactions', profit: 'margin', check: 'confirm', start: 'begin', need: 'require', similar: 'comparable', nearby: 'locally', recent: 'latest', often: 'frequently', lender: 'bank', agent: 'broker', numbers: 'sums', end: 'final', every: 'each', quickly: 'fast', good: 'sound', homes: 'houses', guide: 'article', maximum: 'top', subtract: 'deduct', take: 'use' };
/** Every part of the strong fixture followed by a synonym-swapped copy of itself. */
export const spunCopy = (): Body => { const spin = (t: string) => t.replace(/[A-Za-z]+/g, (w) => SYN[w.toLowerCase()] ?? w); const b = F.strongBody(); return { ...b, sections: b.sections.map((s) => ({ ...s, body: `${s.body}\n\n${spin(s.body.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1'))}` })) } as Body; };

const remarkX3b = (f: (item: string) => string) => mapText(R3.BULLET_ATTACKS[4]![1](), (t) => t.split('\n').map((l) => (/^- (?:\w+ in \w+|the \w+ \w+)$/.test(l) ? f(l.slice(2)) : l)).join('\n'));
/** 16 extra phrase sentences (the 3.9%-and-up stuffing case), with the phrase re-spelt in the added sentences only. */
const hidden = (k: number, form: (p: string) => string): Body => { const st = F.strongBody(); const plus = R2.strongPlusPhrase(k); return { ...plus, sections: plus.sections.map((x, i) => { const base = st.sections[i]!.body; const added = x.body.slice(base.length); return { ...x, body: base + added.replace(/appraise a property deal/gi, (m) => form(m)).replace(/appraising (a )?property deals?/gi, (m) => form(m)) }; }) } as Body; };
const T7 = ['Our team values %s every single week.', 'Buyers ask about %s before they offer.', 'You can view %s on any weekday.', 'We list %s for owners near you.', 'Agents price %s using three recent sales.', 'Most investors check %s twice a year.', 'Landlords often sell %s after the spring.', 'A surveyor inspects %s in an hour.', 'Sellers show %s best in good light.', 'Banks lend against %s at sensible rates.', 'Builders quote for %s within two days.', 'Families move into %s over the summer.'];
const shuffle = <T,>(a: readonly T[], rnd: () => number) => { const o = [...a]; for (let i = o.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [o[i], o[j]] = [o[j]!, o[i]!]; } return o; };

/** Every row of the review's table "Rubbish that passed the gate", then the A2 dilution family. */
export const RUBBISH4: readonly [string, () => Body][] = [
  ['A2 platitudes fixture + 20 different one-word bullets per part', () => dilute(R2.make(R2.GEN.platitude), 20, 1)],
  ['A2 four-templates fixture + 40 one-word bullets per part', () => dilute(R2.make(R2.GEN.templ), 40, 1)],
  ['B3 120 uses of the phrase as "### " lines', () => each((i) => Array.from({ length: 10 }, (_, j) => `### ${P} ${TOWN[(i * 10 + j) % TOWN.length]}`).join('\n'))],
  ['B3 480 keyword "### " lines, 69% of the page', () => { const { pick } = rng(); return each(() => Array.from({ length: 40 }, () => `### ${pick(ADJ)} ${pick(KW)} in ${pick(TOWN)}`).join('\n')); }],
  ['B3 the stuffing fixture (5.3%) diluted with "### " lines', () => { const { pick } = rng(); const b = R2.strongPlusPhrase(16); return { ...b, sections: b.sections.map((s) => ({ ...s, body: `${s.body}\n\n${Array.from({ length: 40 }, () => `### ${pick(ADJ)} ${pick(KW)} in ${pick(TOWN)}`).join('\n')}` })) } as Body; }],
  ['B4 X3b keyword bullets with "+ "', () => remarkX3b((x) => `+ ${x}`)],
  ['B4 X3b keyword bullets with "• "', () => remarkX3b((x) => `• ${x}`)],
  ['B4 X3b keyword bullets with "> "', () => remarkX3b((x) => `> ${x}`)],
  ['B4 X3b keyword bullets with "– "', () => remarkX3b((x) => `– ${x}`)],
  ['B4 X3b keyword bullets with no marker', () => remarkX3b((x) => x)],
  ['B4 keyword lines as blockquotes', () => { const { pick } = rng(); return each(() => Array.from({ length: 12 }, () => `> ${pick(ADJ)} ${pick(KW)} in ${pick(TOWN)}`).join('\n')); }],
  ['B4 one 140-word run-on keyword sentence per part', () => { const { pick } = rng(); return each(() => `We cover ${Array.from({ length: 34 }, () => `${pick(KW)} ${pick(['in', 'near', 'around', 'across'])} ${pick(TOWN)}`).join(' and ')}.`); }],
  ['B2 136 keyword bullets at 39.6% (distinctBullets(34))', () => R3.distinctBullets(34)],
  ['B2 240 one-word bullets, each used twice', () => { const { rnd } = rng(); return each((i) => shuffle([...TOWN.slice((i % 6) * 9, (i % 6) * 9 + 9), ...KW.slice((i % 6) * 5, (i % 6) * 5 + 5), ...ADJ.slice(0, 6).map((a) => `${a} ${KW[(i * 3) % 30]}`)], rnd).map((w) => `- ${w}`).join('\n')); }],
  ['B2 240 keyword bullets of exactly ten words', () => { const { pick } = rng(); return each(() => Array.from({ length: 20 }, () => `- We find ${pick(ADJ)} ${pick(KW)} and ${pick(ADJ)} ${pick(KW)} in ${pick(TOWN)} ${pick(['daily', 'weekly', 'today', 'now', 'fast'])}`).join('\n')); }],
  ['C2 twelve 7-word templates in rotation, 120 sentences', () => each((i) => Array.from({ length: 10 }, (_, j) => T7[(i * 10 + j) % 12]!.replace('%s', KW[(i * 7 + j * 3) % 30]!)).join(' '))],
  ['C3 24 phrase sentences re-written as "property deal appraisal"', () => hidden(24, () => 'property deal appraisal')],
  ['C3 16 phrase sentences re-written as "property deal appraisal"', () => hidden(16, () => 'property deal appraisal')],
  ['C4 16 phrase sentences hidden with U+034F', () => hidden(16, (p) => p.replace(/pp/, 'p͏p').replace(/ope/, 'o͏pe').replace(/ea/, 'e͏a'))],
  ['C4 16 phrase sentences hidden with U+FE0F', () => hidden(16, (p) => p.replace(/pp/, 'p️p').replace(/ope/, 'o️pe').replace(/ea/, 'e️a'))],
  ['C4 16 phrase sentences hidden with U+3164', () => hidden(16, (p) => p.replace(/pp/, 'pㅤp').replace(/ope/, 'oㅤpe').replace(/ea/, 'eㅤa'))],
  ['C4 16 phrase sentences hidden with U+0332', () => hidden(16, (p) => p.replace(/pp/, 'p̲p').replace(/ope/, 'o̲pe').replace(/ea/, 'e̲a'))],
  ['C4 16 phrase sentences hidden with dotless i', () => hidden(16, (p) => p.replace(/i/g, 'ı'))],
  ['C4 16 phrase sentences hidden with accents', () => hidden(16, (p) => p.replace(/o/g, 'ó').replace(/ea/, 'éa'))],
  ['C4 16 phrase sentences hidden with Latin alpha', () => hidden(16, (p) => p.replace(/a/g, 'ɑ'))],
  ['C4 16 phrase sentences hidden with Armenian o', () => hidden(16, (p) => p.replace(/o/g, 'օ'))],
  ['C4 16 phrase sentences hidden with Greek omicron with tonos', () => hidden(16, (p) => p.replace(/o/g, 'ό'))],
  ['N5 the phrase five times in the page title', () => ({ ...F.strongBody(), title: Array.from({ length: 5 }, () => P).join(', ') }) as Body],
  // The dilution family (A2): heavier repetition must not be let down a step by different short bullets.
  ['A2 synonym-swapped copy of every part + 10 one-word bullets per part', () => dilute(spunCopy(), 10, 1)],
  ['A2 synonym-swapped copy of every part + 40 two-word bullets per part', () => dilute(spunCopy(), 40, 2)],
  ['A2 platitudes + 40 two-word bullets per part', () => dilute(R2.make(R2.GEN.platitude), 40, 2)],
  ['A2 twelve templates + 20 one-word bullets per part', () => dilute(R2.make(R2.GEN.templ12), 20, 1)],
  ['A2 the same 30 bullets after every part + 20 one-word bullets', () => dilute(R3.BULLET_ATTACKS[1]![1](), 20, 1)],
];

/**
 * Rubbish the gate cannot refuse, kept visible: fluent filler that a word-counting score cannot tell from writing.
 * Each needs the separate meaning check the gate documents. [name, why].
 */
export const KNOWN_LIMIT4: readonly [string, string][] = [];
