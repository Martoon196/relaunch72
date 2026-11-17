/**
 * Test material for the third review of the SEO score (its findings F1 and F2), all built on the strong fixture:
 * - F1, short list items: the reviewer's seven bullet articles (X1 to X5, and one 30-bullet list pasted 12, 36 and
 *   300 times), rebuilt from the review's scripts with the same fixed seed;
 * - honest lists that must not be marked down: a tools list, a steps list, pros and cons sharing an item;
 * - the dodges around the fix, for the adversarial tests.
 */
import type { ArticleBody } from '../src/seo-blog/types.js';
import * as F from './seo-panel-fixtures.js';

const TOWN = `Leeds Bradford York Hull Sheffield Derby Leicester Coventry Luton Reading Slough Swindon Bristol Bath Exeter Plymouth Truro Cardiff Swansea Newport Wrexham Chester Crewe Stoke Stafford Telford Dudley Walsall Solihull Rugby Corby Bedford Ipswich Norwich Lincoln Grimsby Doncaster Barnsley Wakefield Halifax Burnley Preston Blackpool Lancaster Kendal Carlisle Durham Sunderland Gateshead Hexham Whitby Ripon Skipton Otley Ilkley Selby Goole Thirsk`.split(/\s+/);
const KW = `cheap houses flats homes bungalows terraces cottages studios lofts plots garages shops offices units barns land rentals lets sales auctions bargains repossessions conversions refurbs investments yields mortgages loans surveys valuations lettings`.split(/\s+/);
const KW2 = KW.slice(1);
const ADJ = `cheap best top quick easy local trusted new cheapest fast free low great prime hot`.split(/\s+/);

/** The strong fixture with text added after each part's body (part index i). */
export function eachPart(add: (i: number) => string, base: ArticleBody = F.strongBody()): ArticleBody {
  return { ...base, sections: base.sections.map((s, i) => ({ ...s, body: `${s.body}\n\n${add(i)}`.trim() })) } as ArticleBody;
}
/** The review's fixed pseudo-random sequence, so every run builds the same articles. */
function seeded(seed: number) {
  let x = seed;
  const rnd = () => (x = (x * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  return { rnd, pick: <T,>(a: readonly T[]) => a[Math.floor(rnd() * a.length)]! };
}

/** The same 30 three-word bullets ("- houses in Leeds"). */
export const SAME_30 = Array.from({ length: 30 }, (_, i) => `- ${KW2[i]} in ${TOWN[i]}`);

/** The third review's bullet articles. Each scored 92 to 98 before the fix and passed the gate. */
export const BULLET_ATTACKS: readonly [string, () => ArticleBody][] = [
  ['X1 40 different fragment bullets per part ("- So houses cheap.")', () => { const { pick } = seeded(21); return eachPart(() => Array.from({ length: 40 }, () => `- ${pick(['So', 'But', 'Then', 'Now', 'Yes', 'Still', 'And', 'Or'])} ${pick(KW)} ${pick(ADJ)}.`).join('\n')); }],
  ['X2c the same 30 bullets after every part (12 times over)', () => eachPart(() => SAME_30.join('\n'))],
  ['X2d that list 36 times over', () => eachPart(() => [...SAME_30, ...SAME_30, ...SAME_30].join('\n'))],
  ['X2e that list 300 times over (27,857 words)', () => eachPart(() => Array.from({ length: 25 }, () => SAME_30.join('\n')).join('\n'))],
  ['X3b 30 different keyword bullets per part, each with a small word', () => { const { rnd, pick } = seeded(21); return eachPart(() => Array.from({ length: 30 }, () => (rnd() < 0.5 ? `- ${pick(KW)} in ${pick(TOWN)}` : `- the ${pick(ADJ)} ${pick(KW)}`)).join('\n')); }],
  ['X4 20 bullets per part, all "We ..." of 6 to 8 words, no linking words', () => { const { pick } = seeded(21); return eachPart(() => Array.from({ length: 20 }, () => `- We ${pick(['find', 'sell', 'value', 'check', 'list', 'price', 'view', 'buy'])} ${pick(ADJ)} ${pick(KW)} in ${pick(TOWN)} ${pick(['daily', 'weekly', 'today', 'now', 'fast'])}.`).join('\n')); }],
  ['X5 every part nothing but keyword bullets', () => { const { rnd, pick } = seeded(21); const b = F.strongBody(); return { ...b, sections: b.sections.map((s) => ({ ...s, body: Array.from({ length: 28 }, () => (rnd() < 0.5 ? `- ${pick(KW)} in ${pick(TOWN)}` : `- the ${pick(ADJ)} ${pick(KW)}`)).join('\n') })) } as ArticleBody; }],
];

/** Honest lists that must not be marked down (each in one part of the strong fixture). */
export const HONEST_LISTS: readonly [string, () => ArticleBody][] = [
  ['a tools list of eight short items', () => eachPart((i) => (i === 1 ? ['- a tape measure', '- a notebook', '- a torch', '- a damp meter', '- your phone camera', '- the agent details', '- recent sold prices', '- a calculator'].join('\n') : ''))],
  ['a numbered list of six short steps', () => eachPart((i) => (i === 2 ? ['1. Find the end value.', '2. Price the works.', '3. Add the buying costs.', '4. Add the holding costs.', '5. Take off your profit.', '6. What is left is your offer.'].join('\n') : ''))],
  ['pros and cons sharing one item', () => eachPart((i) => (i === 3 ? ['Pros:', '- Lower price', '- Quick sale', '- Less competition', '- Cost', '', 'Cons:', '- Higher risk', '- Cost', '- Short deadline', '- No survey'].join('\n') : ''))],
  ['a parallel steps list ("Turn off the gas", "Turn off the water")', () => eachPart((i) => (i === 4 ? ['- Turn off the gas', '- Turn off the water', '- Turn off the electricity', '- Lock the back door'].join('\n') : ''))],
  ['all of them together', () => eachPart((i) => (i === 1 ? ['- a tape measure', '- a notebook', '- a torch', '- a damp meter'].join('\n') : i === 2 ? ['1. Find the end value.', '2. Price the works.', '3. Add the buying costs.'].join('\n') : i === 3 ? ['- Lower price', '- Quick sale', '- Cost', '- Higher risk', '- Cost'].join('\n') : i === 4 ? ['- Turn off the gas', '- Turn off the water'].join('\n') : ''))],
];

/** `n` different short bullets ("- flats in York") in each of the first four parts: the short-item share rises with n. */
export const distinctBullets = (n: number) => eachPart((i) => (i < 4 ? Array.from({ length: n }, (_, j) => `- ${KW2[(j + i * 7) % 30]} in ${TOWN[(j * 7 + i) % 30]}`).join('\n') : ''));

const ZW = '​';
/** Cyrillic look-alike letters in place of Latin e, o and a. */
export const lookAlike = (s: string) => s.replace(/e/g, 'е').replace(/o/g, 'о').replace(/a/g, 'а');
const P = 'appraise a property deal';

/** Dodges around the fix: [name, article, what is expected]. */
export const DODGES: readonly [string, () => ArticleBody, 'stuffing' | 'repetition' | 'short-items' | 'gate' | 'not caught'][] = [
  // 'gate': no cap, but the gate refuses it (the score is under the bar, or it gives a reason).
  ['the phrase stuffed into list items', () => eachPart((i) => (i < 6 ? `- How to ${P} in ${TOWN[i]} today\n- ${P[0]!.toUpperCase()}${P.slice(1)} near ${TOWN[i + 10]} quickly` : '')), 'stuffing'],
  ['the phrase stuffed into table cells', () => eachPart((i) => `| Town | Tip |\n|---|---|\n| ${TOWN[i]} | ${P} early |\n| ${TOWN[i + 1]} | ${P} slowly |`), 'stuffing'],
  ['one table row pasted 20 times in every part', () => eachPart(() => Array.from({ length: 20 }, () => '| houses | in Leeds | cheap |').join('\n')), 'repetition'],
  ['the phrase added to every sub-heading', () => { const b = F.strongBody(); return { ...b, sections: b.sections.map((s) => ({ ...s, heading: `${s.heading}: ${P}` })) } as ArticleBody; }, 'stuffing'],
  ['the phrase stuffed into every answer', () => { const b = F.strongBody(); return { ...b, faqs: b.faqs.map((f) => ({ ...f, a: `${f.a} To ${P} well, ${P} twice and ${P} again.` })) } as ArticleBody; }, 'stuffing'],
  ['the phrase hidden in link text', () => eachPart((i) => `Read [${P}](https://www.martinhowardproperty.example/blog/x${i}) and [how to ${P}](https://www.martinhowardproperty.example/blog/y${i}).`), 'stuffing'],
  ['the phrase written with look-alike letters', () => eachPart((i) => `${['Smart buyers', 'Careful owners'][i % 2]} ${lookAlike(P)} before they offer in ${TOWN[i]}. They ${lookAlike(P)} twice.`), 'repetition'],
  ['the phrase split by zero-width spaces', () => eachPart((i) => `Smart buyers app${ZW}raise a prop${ZW}erty deal before they offer in ${TOWN[i]}. They appraise a property${ZW} deal twice.`), 'repetition'],
  ['a pasted list disguised with look-alike letters in every other copy', () => eachPart((k) => SAME_30.map((x) => (k % 2 ? lookAlike(x) : x)).join('\n')), 'repetition'],
  ['a pasted list disguised with zero-width characters', () => eachPart((k) => SAME_30.map((x) => x.replace('in', `i${ZW.repeat(k % 3)}n`)).join('\n')), 'repetition'],
  ['a pasted list written with "+" bullets', () => eachPart(() => SAME_30.map((x) => `+ ${x.slice(2)}`).join('\n')), 'repetition'],
  ['a pasted list of one-word items', () => eachPart(() => TOWN.slice(0, 30).map((t) => `- ${t}`).join('\n')), 'repetition'],
  ['a pasted list written as short lines without bullets', () => eachPart(() => SAME_30.map((x) => x.slice(2)).join('\n\n')), 'gate'],
  ['a pasted list written as short sentences of prose', () => eachPart(() => SAME_30.map((x) => `${x.slice(2)}.`).join(' ')), 'gate'],
  ['a pasted list written as short lines in one paragraph, no bullets', () => eachPart(() => SAME_30.map((x) => x.slice(2)).join('\n')), 'repetition'],
  ['the same 30 bullets in only two parts', () => eachPart((k) => (k < 2 ? SAME_30.join('\n') : '')), 'repetition'],
  ['a list pasted with one word changed in every item, after every part', () => eachPart((k) => SAME_30.map((_, i) => `- ${KW2[i]} in ${TOWN[(i + k) % 30]}`).join('\n')), 'short-items'],
  ['the phrase said three times in the picture description', () => { const b = F.strongBody(); return { ...b, image: { ...b.image, alt: 'Appraise a property deal: appraise a property deal, property deal appraisal, appraising property deals' } } as ArticleBody; }, 'gate'],
  ['a list with one word changed in every item, in two parts only (a quarter of the words)', () => eachPart((k) => (k < 2 ? SAME_30.map((_, i) => `- ${KW2[i]} in ${TOWN[(i + k) % 30]}`).join('\n') : '')), 'short-items'],
  // Not caught, on purpose (see the test).
  ['the phrase split across two different list items', () => eachPart((i) => `- ${['Appraise a', 'Always appraise the', 'First appraise your', 'Then appraise a'][i % 4]}\n- property deal in ${TOWN[i]}`), 'not caught'],
];
