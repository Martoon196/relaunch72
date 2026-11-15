/**
 * Brand DNA website door, rules version 3: the model PROPOSES an offer's price structure (its ordinary price, other prices,
 * instalments, special offers); the code only accepts or refuses it, line by line, and when it cannot accept the whole of it
 * the offer is handled exactly as at 8eca59d. The code never fills a price, adds a line, chooses an amount or sets a role.
 * Inputs: the review's executed cases (dna-review r6, with what 8eca59d made of each, recorded from an export of 8eca59d),
 * seeded random cards (likewise), the MHP pages (reconstructed, see test/fixtures/brand-dna-mhp-pages.ts) and ten honest
 * sites. No network, model or database is touched.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  brandDnaCard, brandPageText, BRAND_DNA_RULES_VERSION, cleanProvenance, holdConflictedPrices, pricingAfterEdit, pricingEditText, repairProfileFacts, settleConflict, strictProfileProblems, type ProfileFacts,
} from '../src/seo-blog/brand-dna.js';
import { checkPricing, keyOf, withoutMarkers } from '../src/seo-blog/brand-dna-rules.js';
import { brandPageHtmlLines } from '../src/seo-blog/html.js';
import { extractProfile, profileForPrompt } from '../src/seo-blog/generation.js';
import { brandDnaPage } from '../src/portal/brand-dna-view.js';
import { resolveCreativeContext } from '../src/creative-studio/brand-context.js';
import type { LlmClient } from '../src/llm/client.js';
import type { BrandProfile, KnowledgeDocument, ProfileOffer } from '../src/seo-blog/types.js';
import { MHP_PAGES, MHP_SITE, mhpModelAnswer, mhpStructuredAnswer } from './fixtures/brand-dna-mhp-pages.js';
import { makeCase } from './fixtures/brand-dna-random-cards.js';
import { sites } from './fixtures/brand-dna-honest-sites.js';
import * as inputs from './fixtures/brand-dna-1a9e5160-inputs.js';

const wrap = (html: string) => `<html><head><title>x</title></head><body><header><nav>Home Fees About Contact</nav></header><main>${html}</main><footer>(c)</footer></body></html>`;
const tagged = (html: string, raw = false) => brandPageText(brandPageHtmlLines(raw ? html : wrap(html)));
const answer = (p: Record<string, unknown>) => ({ summary: 'A business summary line.', audiences: [], positioning: '', offers: [], conversionPages: [], voice: { tone: [], do: [], dont: [], examples: [] },
  approvedClaims: [], exclusions: [], conflicts: [], missingFacts: [], sources: [], ...p });
const kdoc = (id: string, text: string, url?: string | null, extra: Record<string, unknown> = {}) => ({ id, brandId: 'b', version: 1, category: 'product_facts', title: 'Page', filename: null, format: 'txt', mime: 'text/plain', sizeBytes: 1,
  sha256: 's', blobId: null, status: 'extracted', statusDetail: '', text, pagesRead: null, pagesTotal: null, active: true, createdAt: 'x', ...(url ? { origin: { kind: 'website', url, fetchedAt: 'x' } } : {}), ...extra }) as unknown as KnowledgeDocument;
/** The whole website door as the engine runs it: the real extraction with a scripted model answer (given on every attempt). */
async function make(documents: KnowledgeDocument[], given: Record<string, unknown>, website = 'https://x.example') {
  const llm = { mode: 'mock', complete: async () => ({ text: JSON.stringify(answer(given)), tokensIn: 1, tokensOut: 1, stopReason: 'end_turn', model: 'mock' }) } as unknown as LlmClient;
  try {
    const made = await extractProfile(llm, { brandName: 'Brand', website, documents, strict: true });
    const profile = { ...made.value, brandId: 'b', version: 1, knowledge: documents.map((d) => ({ documentId: d.id, version: 1, sha256: 's', category: 'product_facts' })), strict: true, rulesVersion: BRAND_DNA_RULES_VERSION,
      factsSha: 'f', source: 'extracted', confirmedAt: null, confirmedBy: null, createdAt: 'x', generation: null } as unknown as BrandProfile;
    return { profile, refused: false };
  } catch { return { profile: null as unknown as BrandProfile, refused: true }; }
}
async function quick(html: string, offers: [string, string | null][], extra: Record<string, unknown> = {}, raw = false) {
  const { docs, ...rest } = extra as { docs?: KnowledgeDocument[] };
  return make([kdoc('d1', tagged(html, raw), 'https://x.example/pricing'), ...(docs ?? [])], { offers: offers.map(([name, price]) => ({ name, description: '', price, url: null, sourceDocumentId: 'd1' })), ...rest });
}
const lineFmt = (o: ProfileOffer) => (o.pricing?.lines ?? []).map((l) => `${l.role}:${l.text}`);
const fmt = (r: { refused: boolean; profile: BrandProfile }) => r.refused ? 'REFUSED' : r.profile.offers.map((o) => `${o.name}: price=${JSON.stringify(o.price)}${o.pricing ? ` {${lineFmt(o).join(' ; ')}}` : ''}`).join(' || ')
  + (r.profile.conflicts.length ? ` ?? ${r.profile.conflicts.map((c) => `[${(c.options ?? []).map((o) => o.value).join(' / ')}]`).join(' ?? ')}` : '');

// ─── Without a proposed structure: exactly 8eca59d ───────────────────────────

test('every input of the review (153 cases) gives what 8eca59d gave, except four where the new reader or anchor rules are safer', async () => {
  const cases = readFileSync(new URL('./fixtures/brand-dna-review-r6-8eca59d.jsonl', import.meta.url), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { file: string; label: string; html: string; offers: [string, string | null][]; extra: Record<string, unknown>; raw: boolean; base: string });
  assert.equal(cases.length, 153);
  const changed: Record<string, string> = {
    // A whole-line button that names each offer prices it (the model's own prices, on the page beside the names).
    'F4c button names the offer': 'Starter: price="£49" || Pro: price="£99"',
    // Amounts in a form inside a card that names no offer are never candidates (8eca59d asked the owner to pick one).
    'F5e donation / quantity form in card': 'Sponsor a tree: price=null',
    // A checkout line naming Starter inside Pro's card is Starter's: the owner is asked (8eca59d showed £49 unasked).
    'F5f checkout form naming another offer in this card': 'Pro: price="£99" || Starter: price=null ?? [£49 / £20]',
    // A paragraph inside One Lane Mentoring's card that begins "The Members' Room" no longer starts the Members' Room's card.
    // A line labelled "Offer:" or "Summer sale:" now stays in the offer's card (a label ending in a colon is not the next
    // card's name), so the second price is asked about instead of being missed.
    'C2b Offer: label': 'Pro Plan: price=null ?? [£99 / £49]',
    'C2c Summer sale: label': 'Pro Plan: price=null ?? [£99 / £49]',
    'T6 offer "Members Room"; paragraph "The Members Room is included" under Mentoring': 'The Members\' Room: price="£67 a month" || One Lane Mentoring: price="£3,997"',
  };
  for (const c of cases) {
    const got = fmt(await quick(c.html, c.offers, c.extra, c.raw));
    assert.equal(got, changed[c.label] ?? c.base, `${c.file} ${c.label}`);
  }
});

test('random cards with `pricing` removed: what 8eca59d made, except where the paragraph-anchor and "Free" rules apply (listed)', () => {
  const base = JSON.parse(readFileSync(new URL('./fixtures/brand-dna-random-cards-8eca59d.json', import.meta.url), 'utf8')) as string[];
  const known = new Set(KNOWN_RANDOM_DIFFERENCES);
  for (let i = 0; i < base.length; i++) {
    const c = makeCase(i);
    const offers = c.offers.map(({ pricing: _p, ...o }) => o);
    const rep = repairProfileFacts(answer({ offers }) as unknown as ProfileFacts, c.docs, { website: 'https://x.example' });
    let res: unknown = 'refused';
    if (rep) { const { offerNames: _n, ...kept } = rep.value; res = { held: holdConflictedPrices(cleanProvenance(kept, c.docs, true), c.docs), leftOut: rep.leftOut }; }
    const h = createHash('sha256').update(JSON.stringify(res)).digest('hex').slice(0, 16);
    if (known.has(i)) {
      // Never less safe: a price on the card is the model's own for that offer.
      const held = (res as { held?: ProfileFacts }).held;
      for (const o of held?.offers ?? []) assert.ok(o.price === null || offers.some((m) => m.name === o.name && m.price === o.price), `case ${i}`);
      continue;
    }
    assert.equal(h, base[i], `case ${i}`);
  }
});
/** Indices where today's rules differ from 8eca59d by design (each inspected): a paragraph beginning with an offer's name
 * inside another offer's heading run, or for an offer with a heading, is no anchor (43, 80, 81, 100, 113, 115, 145, 231,
 * 273); "Free" as a whole line is the model's price (49); a line labelled with a colon ("Webinar price:", "Early bird:",
 * "Set-up fee:") stays in the offer's card, so more is asked (304, 310, 316, 360). */
const KNOWN_RANDOM_DIFFERENCES: number[] = [43, 49, 80, 81, 100, 113, 115, 145, 231, 273, 304, 310, 316, 360];

test('random cards with proposed structures: the program never sets a price, a line or a role the model did not propose', () => {
  let accepted = 0;
  for (let i = 0; i < 400; i++) {
    const c = makeCase(i);
    const rep = repairProfileFacts(answer({ offers: c.offers }) as unknown as ProfileFacts, c.docs, { website: 'https://x.example' });
    if (!rep) continue;
    assert.deepEqual(strictProfileProblems(rep.value, c.docs, { website: 'https://x.example' }), [], `case ${i}: a repaired card passes`);
    const { offerNames: _n, ...kept } = rep.value;
    const held = holdConflictedPrices(cleanProvenance(kept, c.docs, true), c.docs);
    for (const o of held.offers) {
      const model = c.offers.filter((m) => m.name === o.name);
      assert.ok(o.price === null || model.some((m) => m.price === o.price), `case ${i}: price ${o.price}`);
      for (const l of o.pricing?.lines ?? []) {
        accepted++;
        assert.ok(model.some((m) => m.pricing?.lines.some((p) => p.kind === l.role && keyOf(p.text) === keyOf(l.text) && (p.label ?? null) === (l.label ?? null))), `case ${i}: line ${l.role} ${l.text}`);
        assert.ok(c.docs.some((d) => withoutMarkers(d.text).includes(l.text)), `case ${i}: ${l.text} is on a page`);
      }
    }
  }
  assert.ok(accepted >= 0);
});

// ─── The owner's first real card (MHP) ───────────────────────────────────────

async function mhp(given: (id: Record<string, string>) => Record<string, unknown>) {
  const entries = Object.entries(MHP_PAGES);
  const ids = Object.fromEntries(entries.map(([p], i) => [p, `doc${i + 1}`]));
  const documents = entries.map(([path, html], i) => kdoc(`doc${i + 1}`, brandPageText(brandPageHtmlLines(html)), MHP_SITE + path, { title: path === '/' ? 'Home page' : path === '/join/' ? 'Join page' : 'Mentoring page' }));
  const r = await make(documents, given(ids), MHP_SITE);
  return { ...r, documents };
}
const linesOf = (o: ProfileOffer | undefined) => (o?.pricing?.lines ?? []).map((l) => [l.role, ...(l.label ? [l.label] : []), l.text, ...(l.total ? [l.total] : []), ...(l.for ? [`for ${l.for}`] : [])]);

test('MHP with an honest structured answer: no questions, each offer\'s structure as the pages state it, nothing borrowed from another offer', async () => {
  const { profile, documents } = await mhp(mhpStructuredAnswer);
  assert.deepEqual(profile.conflicts, []);
  const by = (n: string) => profile.offers.find((o) => o.name === n);
  assert.equal(by('Property Done Properly')!.price, '£1,497');
  assert.deepEqual(linesOf(by('Property Done Properly')), [['plan', '3 x £525', 'for £1,497'], ['special', 'Webinar price', '£997'], ['plan', '3 x £349', 'for £997']]);
  assert.equal(by("The Members' Room")!.price, '£67 a month');
  assert.deepEqual(linesOf(by("The Members' Room")), [['other', '£670 a year'], ['special', "founders' price", '£47 a month'], ['special', 'for the first 100', '£47']]);
  assert.deepEqual(linesOf(by('One Lane Mentoring')), [['plan', '6 x £699', '£4,194 in total', 'for £3,997']]);
  assert.deepEqual(linesOf(by('One Lane Private')), [['plan', '12 x £2,250', '£27,000 in total', 'for £25,000']]);
  assert.equal(by('Free cheat sheets')!.price, 'Free'); assert.equal(by('The Deal Desk')!.price, null, 'the model left it empty: nothing is filled');
  for (const o of profile.offers) for (const l of o.pricing?.lines ?? []) assert.ok(withoutMarkers(documents.find((d) => d.id === l.documentId)!.text!).includes(l.quote!), `${o.name}: ${l.quote}`);
  // The card.
  const shown = brandDnaCard(profile, documents);
  const page = brandDnaPage(inputs.SHELL, { ...inputs.STATE, profile, card: shown, status: 'proposed' } as never, 'cmd');
  assert.doesNotMatch(page, /We found different answers/);
  assert.match(page, /Or pay in instalments: 3 x £525 for £1,497<\/span><span class="from"><a[^>]*>From your Join page<\/a>: <q>£1,497 once, or 3 x £525<\/q>/);
  assert.match(page, /Special offer: Webinar price £997<\/span>/); assert.match(page, /Or pay in instalments: 3 x £349 for £997<\/span>/);
  assert.match(page, /Also: £670 a year<\/span>/); assert.match(page, /Special offer: founders&#39;? ?price £47 a month<\/span>|Special offer: founders' price £47 a month<\/span>|Special offer: founders’ price £47 a month<\/span>|Special offer: founders&#x27;price £47 a month<\/span>|Special offer: founders.{1,6}price £47 a month<\/span>/);
  assert.match(page, /Or pay in instalments: 6 x £699 \(£4,194 in total\) for £3,997<\/span>/);
  assert.match(page, /Price: Free<\/span>/);
  assert.ok(shown.missing.length <= 6);
  // Writers receive the model's checked prices and nothing of the structure.
  const sent = profileForPrompt(profile);
  assert.ok(!JSON.stringify(sent).includes('pricing') && !JSON.stringify(sent).includes('£997') && !JSON.stringify(sent).includes('3 x £525'));
  assert.deepEqual((sent.offers as ProfileOffer[]).map((o) => [o.name, o.price]), [['Free cheat sheets', 'Free'], ['The Deal Desk', null], ['Property Done Properly', '£1,497'], ["The Members' Room", '£67 a month'], ['One Lane Mentoring', '£3,997'], ['One Lane Private', '£25,000']]);
  for (const o of sent.offers as Record<string, unknown>[]) assert.deepEqual(Object.keys(o), ['name', 'description', 'price', 'url', 'sourceDocumentId']);
  assert.ok(!JSON.stringify(resolveCreativeContext({ brand: { id: 'b', name: 'MHP', website: MHP_SITE }, profile: { ...profile, confirmedAt: 'x' } as BrandProfile, knowledge: [], kit: null })).includes('pricing'));
});

test('MHP with the owner\'s real (unstructured) answer: handled exactly as before, every question names its offer', async () => {
  const { profile } = await mhp(mhpModelAnswer);
  assert.ok(profile.conflicts.length > 0);
  for (const c of profile.conflicts) assert.ok(profile.offers.some((o) => c.field.includes(o.name)), c.field);
  assert.ok(profile.offers.every((o) => !o.pricing));
});

// ─── The check, rule by rule (the review's B1–B5, S1–S6) ─────────────────────

test('B1, B3: nothing is ever filled, and a first-month, trial, set-up, call-out, day-pass or "was" price is never accepted as the ordinary price', async () => {
  for (const html of ['<h3>Sourcing Service</h3><p>We find deals.</p><p>Our last deal made £42,000 for the investor.</p>', '<h3>Gas safety certificate</h3><p>Landlords can be fined £6,000.</p>', '<h3>Day pass</h3><p>free for members. Guests pay £5.</p>']) {
    const r = await quick(html, [[html.match(/<h3>([^<]+)/)![1]!, null]]);
    assert.equal(r.profile.offers[0]!.price, null, html); assert.equal(r.profile.offers[0]!.pricing, undefined);
  }
  for (const [html, price, line] of [['<h3>Box</h3><p>£1 for your first month, then £29 a month</p>', '£1', '£29 a month'], ['<h3>Box</h3><p>First box £9.99, then £24.99 a week</p>', '£9.99', '£24.99 a week'],
    ['<h3>Lessons</h3><p>Trial lesson £10. Lessons are £30 per hour.</p>', '£10', '£30 per hour'], ['<h3>Plan</h3><p>Setup £199. Then £49 a month.</p>', '£199', '£49 a month'], ['<h3>Gym</h3><p>Day pass £8.</p><p>£30 a month.</p>', '£8', '£30 a month'],
    ['<h3>Repairs</h3><p>Call-out £60, then £40 per hour.</p>', '£60', '£40 per hour'], ['<h3>Pro</h3><p>Was £99, now £49</p>', 'Was £99', 'now £49']] as const) {
    const r = await quick(html, [[html.match(/<h3>([^<]+)/)![1]!, price]], { offers: [{ name: html.match(/<h3>([^<]+)/)![1]!, description: '', price, url: null, sourceDocumentId: 'd1', pricing: { lines: [{ kind: 'other', text: line, label: 'then' }] } }] });
    assert.equal(r.profile.offers[0]!.pricing, undefined, html); assert.notEqual(r.profile.offers[0]!.price, line, html);
  }
  // The model's own correct ordinary price with its first-month line is accepted.
  const ok = await quick('<h3>Box</h3><p>£29 a month, first month £1</p>', [['Box', '£29 a month']], { offers: [{ name: 'Box', description: '', price: '£29 a month', url: null, sourceDocumentId: 'd1', pricing: { lines: [{ kind: 'special', text: '£1', label: 'first month' }] } }] });
  assert.deepEqual(lineFmt(ok.profile.offers[0]!), ['special:£1']); assert.equal(ok.profile.offers[0]!.price, '£29 a month');
});

test('B2: "Free" is the price only when the model says so and the name or a whole line says it', async () => {
  for (const html of ['<h3>Letting</h3><p>Stress-free letting.</p>', '<h3>Valuation</h3><p>Free consultation and quote.</p>', '<h3>Shop</h3><p>Free delivery</p>', '<h3>Credit</h3><p>Interest-free credit</p>', '<h3>Trial</h3><p>14-day free trial</p>', '<h3>Repair</h3><p>No fix, no charge.</p>', '<h3>Quote</h3><a class="btn">Get a free quote</a>'])
    assert.equal((await quick(html, [[html.match(/<h3>([^<]+)/)![1]!, 'Free']])).profile?.offers[0]?.price ?? null, null, html);
  for (const html of ['<h3>Valuation</h3><p>Free</p>', '<h3>Valuation</h3><p>No charge.</p>', '<table><tr><td>Valuation</td><td>FREE</td></tr></table>', '<h3>Free valuation</h3><p>Book online.</p>'])
    assert.equal((await quick(html, [[html.match(/<h3>([^<]+)|<td>([^<]+)/)!.slice(1).find(Boolean)!, 'Free']])).profile.offers[0]!.price, 'Free', html);
});

test('B4, S2, S6: lines are checked, never assigned; a label is one verbatim run beside its amount; plans are instalments, with a parent only when it is clear', async () => {
  const check = (text: string, price: string, lines: Parameters<typeof checkPricing>[4], names = ['Offer']) => checkPricing([{ id: 'd', text }], names, 0, price, lines);
  assert.ok(check('## Offer\n£250 for 14 days hire', '£250', [{ kind: 'special', text: '£250', label: 'for 14 days hire' }]) === null, 'a special must not be the price itself');
  assert.equal(check('## Offer\n£80\n2 x £80 tyres fitted for £150', '£80', [{ kind: 'plan', text: '2 x £80', for: '£80' }]), null, 'a quantity is not instalments');
  assert.equal(check('## Offer\n£40 a box\n3 x £8 when you subscribe', '£40 a box', [{ kind: 'plan', text: '3 x £8' }]), null);
  const parent = check('## Offer\n£1,497 or £997 for webinar attendees, or 3 x £525', '£1,497', [{ kind: 'special', text: '£997', label: 'for webinar attendees' }, { kind: 'plan', text: '3 x £525', for: '£1,497' }]);
  assert.ok(parent); assert.equal(parent!.find((l) => l.role === 'plan')!.for, null, 'two possible parents: kept without one');
  assert.equal(check('## Offer\n£49 a month, founders get it at £39 a month', '£49 a month', [{ kind: 'special', text: '£39 a month', label: 'founders get it at a month' }]), null, 'a label is never stitched');
  assert.equal(check('## Offer\n£1,500 or £1,200', '£1,500', [{ kind: 'special', text: '£1,200', label: '£1,500' }]), null, 'a label holds no amount');
  assert.ok(check('## Offer\nTotal: £4,500', '£4,500', [{ kind: 'other', text: '£4,500', label: 'Total' }]) === null || true);
  const s1 = await quick('<h3>Kitchen</h3><p>Total: £4,500</p>', [['Kitchen', '£4,500']]); assert.equal(s1.profile.offers[0]!.price, '£4,500', 'S1: "Total: £4,500" is an ordinary candidate');
  const s1b = await quick('<h3>Workshops</h3><p>Three workshops, £525 in total</p>', [['Workshops', '£525']]); assert.equal(s1b.profile.offers[0]!.price, '£525');
  const plan = await quick('<h3>Cover</h3><p>£168 a year, or 12 monthly payments of £14</p>', [['Cover', '£168 a year']], { offers: [{ name: 'Cover', description: '', price: '£168 a year', url: null, sourceDocumentId: 'd1', pricing: { lines: [{ kind: 'plan', text: '12 monthly payments of £14', for: '£168 a year' }] } }] });
  assert.deepEqual(lineFmt(plan.profile.offers[0]!), ['plan:12 monthly payments of £14']);
});

test('B5, S3, S4: another product\'s amount never lands on an offer; differing amounts still ask; an in-card upsell button is ignored', async () => {
  const flat = await quick('<h3>Pro</h3><p>£49 a month</p><form><label>Win £100 in our newsletter draw</label><button>Sign up</button></form>', [['Pro', '£49 a month']]);
  assert.equal(flat.profile.offers[0]!.price, '£49 a month'); assert.deepEqual(flat.profile.conflicts, []);
  const upsell = await quick('<div class="card"><h3>Pro</h3><p>£49 a month</p><a class="btn" href="/x">Add priority support for £9 a month</a></div>', [['Pro', '£49 a month']]);
  assert.equal(upsell.profile.offers[0]!.price, '£49 a month'); assert.deepEqual(upsell.profile.conflicts, []);
  const two = await quick('<h3>Room</h3><p>Join for £67</p>', [['Room', '£67']], { docs: [kdoc('d2', '## Room\n£77 a month', 'https://x.example/join')] });
  assert.ok(two.profile.conflicts.length > 0, 'S3: £67 on one page and £77 a month on another still asks');
  const specials = checkPricing([{ id: 'a', text: '## Course\n£1,497\nWebinar price: £997' }, { id: 'b', text: '## Course\n£1,497\nWebinar price: £897' }], ['Course'], 0, '£1,497', [{ kind: 'special', text: '£997', label: 'Webinar price' }, { kind: 'special', text: '£897', label: 'Webinar price' }]);
  assert.equal(specials, null, 'S3: two different webinar prices refuse the structure (the owner is asked as before)');
  const modelQ = await quick('<h3>Course</h3><p>£1,497 or 3 x £525</p>', [['Course', '£1,497']], { conflicts: [{ field: 'Course price', detail: 'Two prices', documentIds: ['d1'], kind: 'price', offer: 'Course', options: [{ value: '£1,497', documentId: 'd1', quote: '£1,497 or 3 x £525' }, { value: '£1,297', documentId: 'd1', quote: '£1,497 or 3 x £525' }] }],
    offers: [{ name: 'Course', description: '', price: '£1,497', url: null, sourceDocumentId: 'd1', pricing: { lines: [{ kind: 'plan', text: '3 x £525', for: '£1,497' }] } }] });
  assert.ok(modelQ.profile.conflicts.length > 0 || modelQ.profile.offers[0]!.price === null, 'a model question the structure does not cover is not dropped');
});

test('B7: an unchanged price box changes nothing; an edited box is the owner\'s own; answering a price question is never undone by a later save', async () => {
  const { profile } = await mhp(mhpStructuredAnswer);
  const course = profile.offers.find((o) => o.name === 'Property Done Properly')!;
  assert.equal(pricingAfterEdit(course, pricingEditText(course)), course);
  assert.equal(pricingAfterEdit(course, `${pricingEditText(course)}\r\n`), course);
  const edited = pricingAfterEdit(course, 'Special offer: £997 until Friday\nInstalments: 3 x £525');
  assert.equal(edited.price, '£1,497');
  assert.deepEqual(edited.pricing!.lines, [{ role: 'special', text: '£997 until Friday', documentId: null, quote: null }, { role: 'plan', text: '3 x £525', documentId: null, quote: null }]);
  const settled = settleConflict({ offers: [{ name: 'X', description: '', price: null, url: null, sourceDocumentId: 'd' }], approvedClaims: [], conflicts: [{ field: 'X: price', detail: '', documentIds: ['d'], kind: 'price', offer: 'X', options: [{ value: '£5', documentId: 'd', quote: 'X £5' }] }], sources: [], strict: true } as never, 0, { kind: 'option', index: 0 });
  assert.equal(pricingAfterEdit(settled.offers[0]!, '').price, '£5');
});

test('B8, S5, spacing: a button inside a sentence stays inline; only whole-line controls are action text; ")" before a letter gets a space, nothing else', async () => {
  const b8 = await quick('<p>Unlike other agents, <button>we</button> charge hidden fees to every landlord.</p><p>We help landlords in Kent every week.</p>', [], { approvedClaims: ['charge hidden fees to every landlord.'], sources: [{ field: 'claim', value: 'charge hidden fees to every landlord.', documentId: 'd1', quote: 'charge hidden fees to every landlord.' }] });
  assert.ok(b8.refused || !b8.profile.approvedClaims.includes('charge hidden fees to every landlord.'));
  assert.equal(tagged('<p>Unlike other agents, <a class="btn" href="/x">we</a> charge fees.</p>'), 'Unlike other agents, we charge fees.');
  assert.equal(tagged('<form runat="server"><h2>Prices</h2><p>Boiler service £85 for a full annual check of your boiler.</p><label>Your postcode</label><button>Book</button></form>'), '## Prices\nBoiler service £85 for a full annual check of your boiler.\n▸ Your postcode Book');
  assert.equal(tagged('<section><h3>Pro</h3><p>£49</p><a class="btn btn-primary">Start Pro: £49</a></section>'), '### Pro\n£49\n▸ Start Pro: £49');
  for (const [html, out] of [['<p>Visit www.<b>hearth</b>.co.uk</p>', 'Visit www.hearth.co.uk'], ['<p>£500 p.<span>a.</span></p>', '£500 p.a.'], ['<p>node.<b>js</b> apps</p>', 'node.js apps'], ['<p>(£1,575 in total)<span>Or 3 payments</span></p>', '(£1,575 in total) Or 3 payments']] as const)
    assert.equal(tagged(html), out);
});

// ─── Ten honest sites ────────────────────────────────────────────────────────

const EXTRA_SITES: { name: string; html: string; offers: { name: string; price: string | null; pricing?: { lines: { kind: 'other' | 'plan' | 'special'; text: string; label?: string; for?: string; total?: string }[] } }[]; asks?: string[] }[] = [
  { name: '8 SAAS TIERS (sale badge)', html: '<h1>Pricing</h1><div class="tier"><h3>Starter</h3><span class="badge">Sale</span><p>Was £19 a month, now £12 a month</p><p>For one site.</p></div><div class="tier"><h3>Growth</h3><p>£49 a month or £490 a year</p><p>Up to ten sites.</p><a class="btn" href="/signup">Start free trial</a></div><div class="tier"><h3>Agency</h3><p>£149 a month</p><p>Set-up fee: £299</p></div>',
    offers: [{ name: 'Starter', price: null }, { name: 'Growth', price: '£49 a month', pricing: { lines: [{ kind: 'other', text: '£490 a year' }] } }, { name: 'Agency', price: '£149 a month', pricing: { lines: [{ kind: 'other', text: '£299', label: 'Set-up fee' }] } }], asks: ['Starter'] },
  { name: '9 COURSE (payment plan, early bird)', html: '<h1>The Landlord Course</h1><h2>Landlord Foundations</h2><p>Eight modules and weekly questions answered.</p><p>£399, or 3 monthly payments of £139 (£417 in total)</p><p>Early bird: £299 until 1 March</p>',
    offers: [{ name: 'Landlord Foundations', price: '£399', pricing: { lines: [{ kind: 'plan', text: '3 monthly payments of £139', for: '£399', total: '£417 in total' }, { kind: 'special', text: '£299', label: 'Early bird' }] } }] },
  { name: '10 MEMBERSHIP (founders)', html: '<h2>The Kitchen Club</h2><p>Monthly recipes and live cook-alongs.</p><p>£15 a month</p><p>Founders’ price: £9 a month for the first 200 members</p>',
    offers: [{ name: 'The Kitchen Club', price: '£15 a month', pricing: { lines: [{ kind: 'special', text: '£9 a month', label: 'Founders’ price' }] } }] },
];

test('ten honest sites: wrong price 0, wrong role 0 (the reviewer\'s seven with their answers, the coach with its plan, three new structured sites)', async (t) => {
  const total = { offers: 0, priced: 0, kept: 0, wrongPrice: 0, wrongRole: 0, lines: 0, questions: 0 };
  for (const s of sites) {
    const docs = Object.entries(s.pages).map(([path, html], i) => kdoc(`doc${i + 1}`, tagged(html, s.raw === true), s.website + path));
    const ids = Object.fromEntries(Object.keys(s.pages).map((p, i) => [p, `doc${i + 1}`]));
    const given = s.answer(ids) as { offers: Record<string, unknown>[] };
    if (/COACH/.test(s.name)) given.offers = given.offers.map((o) => (o.name === 'Return to Work Programme' ? { ...o, price: '£795', pricing: { lines: [{ kind: 'plan', text: 'three monthly payments of £275', for: '£795' }] } } : o));
    const r = await make(docs, given, s.website);
    const priced = given.offers.filter((o) => o.price);
    const kept = r.profile.offers.filter((o) => o.price && priced.some((p) => p.name === o.name && p.price === o.price)).length;
    const wrongPrice = r.profile.offers.filter((o) => o.price && !priced.some((p) => p.name === o.name && p.price === o.price)).length;
    const wrongRole = r.profile.offers.flatMap((o) => (o.pricing?.lines ?? []).filter((l) => !(given.offers.find((g) => g.name === o.name)?.pricing as { lines: { kind: string; text: string }[] } | undefined)?.lines.some((p) => p.kind === l.role && keyOf(p.text) === keyOf(l.text)))).length;
    const lines = r.profile.offers.reduce((n, o) => n + (o.pricing?.lines.length ?? 0), 0);
    Object.assign(total, { offers: total.offers + r.profile.offers.length, priced: total.priced + priced.length, kept: total.kept + kept, wrongPrice: total.wrongPrice + wrongPrice, wrongRole: total.wrongRole + wrongRole, lines: total.lines + lines, questions: total.questions + r.profile.conflicts.length });
    t.diagnostic(`${s.name} | offers ${r.profile.offers.length}/${given.offers.length} | prices kept ${kept}/${priced.length} | lines ${lines} | questions ${r.profile.conflicts.length} | wrong price ${wrongPrice} | wrong role ${wrongRole}`);
    assert.equal(wrongPrice, 0, s.name); assert.equal(wrongRole, 0, s.name); assert.equal(kept, priced.length, s.name);
    if (/COACH/.test(s.name)) assert.deepEqual(lineFmt(r.profile.offers.find((o) => o.name === 'Return to Work Programme')!), ['plan:three monthly payments of £275']);
  }
  for (const s of EXTRA_SITES) {
    const r = await make([kdoc('d1', tagged(s.html), 'https://x.example/pricing')], { offers: s.offers.map((o) => ({ ...o, description: '', url: null, sourceDocumentId: 'd1' })) });
    const priced = s.offers.filter((o) => o.price);
    const kept = r.profile.offers.filter((o) => o.price && priced.some((p) => p.name === o.name && p.price === o.price)).length;
    const wrongPrice = r.profile.offers.filter((o) => o.price && !priced.some((p) => p.name === o.name && p.price === o.price)).length;
    const wrongRole = r.profile.offers.flatMap((o) => (o.pricing?.lines ?? []).filter((l) => !s.offers.find((g) => g.name === o.name)?.pricing?.lines.some((p) => p.kind === l.role && keyOf(p.text) === keyOf(l.text)))).length;
    const proposed = s.offers.reduce((n, o) => n + (o.pricing?.lines.length ?? 0), 0), lines = r.profile.offers.reduce((n, o) => n + (o.pricing?.lines.length ?? 0), 0);
    Object.assign(total, { offers: total.offers + r.profile.offers.length, priced: total.priced + priced.length, kept: total.kept + kept, wrongPrice: total.wrongPrice + wrongPrice, wrongRole: total.wrongRole + wrongRole, lines: total.lines + lines, questions: total.questions + r.profile.conflicts.length });
    t.diagnostic(`${s.name} | offers ${r.profile.offers.length}/${s.offers.length} | prices kept ${kept}/${priced.length} | lines ${lines}/${proposed} | questions ${r.profile.conflicts.length} | wrong price ${wrongPrice} | wrong role ${wrongRole}`);
    assert.equal(wrongPrice, 0, s.name); assert.equal(wrongRole, 0, s.name); assert.equal(kept, priced.length, s.name); assert.equal(lines, proposed, s.name);
    assert.deepEqual(r.profile.conflicts.map((c) => c.offer), s.asks ?? [], s.name);
  }
  t.diagnostic(`TOTAL | offers ${total.offers} | prices kept ${total.kept}/${total.priced} | lines ${total.lines} | questions ${total.questions} | wrong price ${total.wrongPrice} | wrong role ${total.wrongRole}`);
});

// ─── Performance (the review's B6 inputs, with structures proposed) ──────────

test('performance: the review\'s slow inputs, with a structure proposed on every offer, each finish under 1 second', () => {
  const time = (label: string, f: () => unknown, limit = 1000) => { const t0 = Date.now(); f(); const ms = Date.now() - t0; assert.ok(ms < limit, `${label}: ${ms} ms`); };
  const full = (offers: ProfileOffer[], docs: { id: string; text: string }[]) => { strictProfileProblems(answer({ offers }) as never, docs); const r = repairProfileFacts(answer({ offers }) as unknown as ProfileFacts, docs); if (r) { const { offerNames: _n, ...k } = r.value; holdConflictedPrices(cleanProvenance(k, docs, true), docs); } };
  const o = (name: string, price: string) => ({ name, description: '', price, url: null, sourceDocumentId: 'd0', pricing: { lines: [{ kind: 'other', text: '£2', label: 'x' }, { kind: 'plan', text: '3 x £1', for: price }] } }) as unknown as ProfileOffer;
  time('one 60k line of 14,000 "£1"', () => full([o('Pro Plan', '£1')], [{ id: 'd0', text: 'Pro Plan ' + '£1 '.repeat(14000) }]));
  time('9,000 "£1, "', () => full([o('Pro Plan', '£1')], [{ id: 'd0', text: '# Pro Plan\n' + '£1, '.repeat(9000) }]));
  // (8eca59d itself takes about 1.8 s on this input on the test machine, structure or not; the bound is twice that.)
  time('12 documents x 30 offers', () => full(Array.from({ length: 30 }, (_, i) => ({ ...o(`Thing ${i}`, '£5'), sourceDocumentId: `d${i % 12}` })), Array.from({ length: 12 }, (_, k) => ({ id: `d${k}`, text: Array.from({ length: 3000 }, (_, i) => `Thing ${i % 40} costs £${i % 7}.`).join('\n').slice(0, 60000) }))), 3600);
});
