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
  brandDnaCard, brandPageText, brandPageTextRead, BRAND_DNA_RULES_VERSION, websiteDocuments, collapsedPositions, cleanProvenance, holdConflictedPrices, pricingAfterEdit, pricingEditText, repairProfileFacts, settleConflict, strictProfileProblems, type ProfileFacts,
} from '../src/seo-blog/brand-dna.js';
import { basisPositions, basisText, checkAllPricing, checkPricing, keyOf, proposedLines, withoutMarkers } from '../src/seo-blog/brand-dna-rules.js';
import { brandPageHtmlLines, brandPageHtmlRead } from '../src/seo-blog/html.js';
import { buildAcquisitionEvidence } from '../src/seo-blog/acquisition-evidence.js';
import { actionMarked, extractProfile, profileForPrompt } from '../src/seo-blog/generation.js';
import { brandDnaPage } from '../src/portal/brand-dna-view.js';
import { resolveCreativeContext } from '../src/creative-studio/brand-context.js';
import type { LlmClient } from '../src/llm/client.js';
import type { BrandProfile, KnowledgeDocument, ProfileOffer } from '../src/seo-blog/types.js';
import { MHP_PAGES, MHP_SITE, mhpModelAnswer, mhpStructuredAnswer } from './fixtures/brand-dna-mhp-pages.js';
import { MHP_REAL_PAGES, MHP_REAL_SITE, mhpRealHomeAnswer, mhpRealJoinAnswer } from './fixtures/brand-dna-mhp-real-pages.js';
import { makeCase } from './fixtures/brand-dna-random-cards.js';
import { sites } from './fixtures/brand-dna-honest-sites.js';
import * as inputs from './fixtures/brand-dna-1a9e5160-inputs.js';

const wrap = (html: string) => `<html><head><title>x</title></head><body><header><nav>Home Fees About Contact</nav></header><main>${html}</main><footer>(c)</footer></body></html>`;
/** A page as the website read stores it: its words, and (beside them) which lines were wholly action text. */
const read = (html: string, raw = false) => brandPageTextRead(brandPageHtmlRead(raw ? html : wrap(html)));
const tagged = (html: string, raw = false) => read(html, raw).text;
const answer = (p: Record<string, unknown>) => ({ summary: 'A business summary line.', audiences: [], positioning: '', offers: [], conversionPages: [], voice: { tone: [], do: [], dont: [], examples: [] },
  approvedClaims: [], exclusions: [], conflicts: [], missingFacts: [], sources: [], ...p });
const kdoc = (id: string, text: string, url?: string | null, extra: Record<string, unknown> = {}, actionLines: readonly number[] = []) => ({ id, brandId: 'b', version: 1, category: 'product_facts', title: 'Page', filename: null, format: 'txt', mime: 'text/plain', sizeBytes: 1,
  sha256: 's', blobId: null, status: 'extracted', statusDetail: '', text, pagesRead: null, pagesTotal: null, active: true, createdAt: 'x', ...(url ? { origin: { kind: 'website', url, fetchedAt: 'x', ...(actionLines.length ? { actionLines } : {}) } } : {}), ...extra }) as unknown as KnowledgeDocument;
/** A website page document read from html, as stored (words and action lines). */
const wdoc = (id: string, html: string, url: string, raw = false, extra: Record<string, unknown> = {}) => { const r = read(html, raw); return kdoc(id, r.text, url, extra, r.actionLines); };
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
type Lines = { kind: string; text: string; label?: string | null; for?: string | null; total?: string | null }[];
/** One page (html, or stored text), some offers [name, price, proposed lines?], as the review's harness ran them. */
async function quick(src: string | { html: string; raw?: boolean }, offers: (readonly [string, string | null] | readonly [string, string | null, Lines | undefined])[], extra: Record<string, unknown> = {}, noPricing = false) {
  const page = typeof src === 'string' ? kdoc('d1', src, 'https://x.example/pricing') : wdoc('d1', src.html, 'https://x.example/pricing', src.raw === true);
  const { docs, ...rest } = extra as { docs?: KnowledgeDocument[] };
  return make([page, ...(docs ?? [])], { offers: offers.map(([name, price, lines]) => ({ name, description: '', price, url: null, sourceDocumentId: 'd1', ...(lines && !noPricing ? { pricing: { lines } } : {}) })), ...rest });
}
const lineFmt = (o: ProfileOffer) => (o.pricing?.lines ?? []).map((l) => `${l.role}:${l.label ? `[${l.label}] ` : ''}${l.text}${l.total ? ` (total ${l.total})` : ''}${l.for ? ` for ${l.for}` : ''}${l.documentId === null ? ' {owner}' : ''}`);
type Made = { refused: boolean; profile: BrandProfile };
/** The outcome as the review's harnesses printed it: offers and prices (and any accepted structure), questions, and (r7) what was left out. */
const fmt = (r: Made, withLeftOut = false) => r.refused ? 'REFUSED' : r.profile.offers.map((o) => `${o.name}: price=${JSON.stringify(o.price)}${o.pricing ? ` {${lineFmt(o).join(' ; ')}}` : ''}`).join(' || ')
  + (r.profile.conflicts.length ? ` ?? ${r.profile.conflicts.map((c) => `[${(c.options ?? []).map((o) => o.value).join(' / ')}]`).join(' ?? ')}` : '')
  + (withLeftOut && r.profile.leftOut?.length ? ` leftOut ${JSON.stringify(r.profile.leftOut.map((l) => `${l.what}:${l.text}${l.found ? `(${l.found})` : ''}`))}` : '');

// ─── Without a proposed structure: exactly 8eca59d, no exceptions ────────────

const jsonl = <T>(file: string) => readFileSync(new URL(`./fixtures/${file}`, import.meta.url), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as T);
type Case = { file: string; label: string; html: string; offers: ([string, string | null] | [string, string | null, Lines | undefined])[]; extra: Record<string, unknown>; raw: boolean; base: string };

test('the review\'s r6 cases (153): with no proposed structure every outcome is exactly what 8eca59d gave', async () => {
  const cases = jsonl<Case>('brand-dna-review-r6-8eca59d.jsonl');
  assert.equal(cases.length, 153);
  for (const c of cases) assert.equal(fmt(await quick({ html: c.html, raw: c.raw }, c.offers, c.extra, true)), c.base, `${c.file} ${c.label}`);
});

/** r7 cases where an honest proposed structure is (rightly) accepted; every other proposal ends as 8eca59d did. */
const R7_ACCEPTED: Record<string, string> = {
  'M3b right parent, not directly before': 'Course: price="£1,497" {special:[for webinar attendees] £997 ; plan:3 x £525}',
  "M9a tier blurb: another offer's price as other": 'Starter plan: price="£19 a month" || Pro plan: price="£49 a month" {other:£490 a year}',
  'M10d amount beside another listed offer': 'Pro: price="£49 a month" {other:£490 a year} || Starter: price="£19 a month"',
  'O1 price copied with its small print "£1,497 once" (prompt: copy all small print)': 'Course: price="£1,497 once" {plan:3 x £525 for £1,497 ; special:[Webinar price] £997 ; plan:3 x £349 for £997}',
  'O2 same, for written without "once"': 'Course: price="£1,497 once" {plan:3 x £525 for £1,497 ; special:[Webinar price] £997 ; plan:3 x £349 for £997}',
  'O4 label given with its colon / different case / trailing words': 'Course: price="£1,497" {special:[Webinar price:] £997}',
  'O8 plan total omitted though the page writes it': 'Mentoring: price="£3,997" {plan:6 x £699 for £3,997}',
  // Round 4 (change A): the labelled line sits in the offer's own section past where the 8eca59d run stops.
  'M9d unlisted add-on written "Label: £x" as other': 'Boiler service: price="£85" {other:[Carbon monoxide alarm] £25}',
};
test('the review\'s r7 cases (98: paragraph anchors, runs and action text, mistaken and honest proposals): plain path exact; proposals refused unless honest', async () => {
  const cases = jsonl<Case>('brand-dna-review-r7-8eca59d.jsonl');
  assert.equal(cases.length, 98);
  for (const c of cases) {
    assert.equal(fmt(await quick({ html: c.html, raw: c.raw }, c.offers, c.extra, true), true), c.base, `no pricing: ${c.file} ${c.label}`);
    const withPricing = fmt(await quick({ html: c.html, raw: c.raw }, c.offers, c.extra), true);
    assert.equal(withPricing, R7_ACCEPTED[c.label] ?? c.base, `with pricing: ${c.file} ${c.label}`);
  }
});

test('the review\'s ten sloppy answers end exactly as 8eca59d (a refusal and a question, or an empty price)', async () => {
  const cases = jsonl<{ label: string; text: string; offers: ([string, string | null] | [string, string | null, Lines | undefined])[]; base: string }>('brand-dna-sloppy-8eca59d.jsonl');
  assert.equal(cases.length, 13);
  for (const c of cases) assert.equal(fmt(await quick(c.text, c.offers), true), c.base, c.label);
});

test('400 random cards with `pricing` removed: every outcome is exactly what 8eca59d made (hashes recorded from 8eca59d)', () => {
  const base = JSON.parse(readFileSync(new URL('./fixtures/brand-dna-random-cards-8eca59d.json', import.meta.url), 'utf8')) as string[];
  assert.equal(base.length, 400);
  for (let i = 0; i < base.length; i++) {
    const c = makeCase(i);
    const offers = c.offers.map(({ pricing: _p, ...o }) => o);
    const rep = repairProfileFacts(answer({ offers }) as unknown as ProfileFacts, c.docs, { website: 'https://x.example' });
    let res: unknown = 'refused';
    if (rep) { const { offerNames: _n, ...kept } = rep.value; res = { held: holdConflictedPrices(cleanProvenance(kept, c.docs, true), c.docs), leftOut: rep.leftOut }; }
    assert.equal(createHash('sha256').update(JSON.stringify(res)).digest('hex').slice(0, 16), base[i], `case ${i}`);
  }
});

test('400 random cards with proposed structures: never a price, line, role, parent or total the model did not propose; all or nothing', () => {
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
      if (!o.pricing) continue;
      const from = model.find((m) => m.price === o.price && m.pricing);
      assert.ok(from, `case ${i}: a structure the model proposed`);
      assert.equal(o.pricing.lines.length, from!.pricing!.lines.length, `case ${i}: all or nothing`);
      o.pricing.lines.forEach((l, k) => {
        const p = from!.pricing!.lines[k]!;
        assert.equal(l.role, p.kind); assert.equal(keyOf(l.text), keyOf(p.text)); assert.equal(l.label ?? null, p.label ?? null);
        if (l.for) assert.equal(keyOf(l.for), keyOf(p.for ?? ''));
        if (l.total) assert.equal(keyOf(l.total), keyOf(p.total ?? ''));
      });
    }
  }
});

// ─── The owner's first real card (MHP) ───────────────────────────────────────

async function mhp(given: (id: Record<string, string>) => Record<string, unknown>, pages: Record<string, string> = MHP_PAGES, uploads: KnowledgeDocument[] = []) {
  const entries = Object.entries(pages);
  const ids = Object.fromEntries(entries.map(([p], i) => [p, `doc${i + 1}`]));
  const documents = [...entries.map(([path, html], i) => wdoc(`doc${i + 1}`, html, MHP_SITE + path, true, { title: path === '/' ? 'Home page' : path === '/join/' ? 'Join page' : 'Mentoring page' })), ...uploads];
  return { ...(await make(documents, given(ids), MHP_SITE)), documents };
}
const reordered = (order: number[]) => (id: Record<string, string>) => { const a = mhpStructuredAnswer(id) as { offers: unknown[] }; return { ...a, offers: order.map((k) => a.offers[k]) }; };
const linesOf = (o: ProfileOffer | undefined) => (o?.pricing?.lines ?? []).map((l) => [l.role, ...(l.label ? [l.label] : []), l.text, ...(l.total ? [l.total] : []), ...(l.for ? [`for ${l.for}`] : [])]);

const MHP_NAMES = ['Free cheat sheets', 'The Deal Desk', 'Property Done Properly', "The Members' Room", 'One Lane Mentoring', 'One Lane Private'];
function mhpDocs() {
  return Object.values(MHP_PAGES).map((html, i) => { const r = read(html, true); return { id: `doc${i + 1}`, text: r.text, actionLines: r.actionLines }; });
}

test('MHP, honest structured answer: the structure check accepts every proposed structure, in any order of offers', () => {
  const docs = mhpDocs();
  const given = (mhpStructuredAnswer({ '/': 'doc1', '/join/': 'doc2', '/mentoring/': 'doc3' }) as { offers: { name: string; price: string | null; pricing?: unknown; sourceDocumentId: string }[] }).offers;
  const run = (order: number[]) => {
    const names = order.map((k) => given[k]!.name);
    const r = checkAllPricing(docs, names, order.map((k, i) => ({ self: i, price: given[k]!.price, proposed: proposedLines(given[k]!.pricing), citedId: given[k]!.sourceDocumentId })));
    return Object.fromEntries(order.map((k, i) => [given[k]!.name, r[i] ? r[i]!.lines.map((l) => `${l.role}:${l.label ? `[${l.label}] ` : ''}${l.text}`) : null]));
  };
  const want = { 'Free cheat sheets': [], 'The Deal Desk': null, 'Property Done Properly': ['plan:3 x £525', 'special:[Webinar price] £997', 'plan:3 x £349'],
    "The Members' Room": ['other:£670 a year', "special:[founders' price] £47 a month", 'special:[for the first 100] £47'], 'One Lane Mentoring': ['plan:6 x £699'], 'One Lane Private': ['plan:12 x £2,250'] };
  assert.deepEqual(run([0, 1, 2, 3, 4, 5]), want);
  assert.deepEqual(run([5, 4, 3, 2, 1, 0]), want);
  assert.deepEqual(run([4, 0, 3, 5, 2, 1]), want);
  // Without One Lane Mentoring's accepted claim, the Mentoring page's "The Members' Room is included for a year." paragraph
  // leaves £3,997 and 6 x £699 unaccounted for The Members' Room (as at round 3): refused.
  const noMentoring = given.map((o) => (o.name === 'One Lane Mentoring' ? { ...o, pricing: { lines: [{ kind: 'plan', text: '6 x £699', for: '£3,997', total: '£4,999 in total' }] } } : o));
  const r = checkAllPricing(docs, MHP_NAMES, noMentoring.map((o, i) => ({ self: i, price: o.price, proposed: proposedLines(o.pricing), citedId: o.sourceDocumentId })));
  assert.equal(r[4], null); assert.equal(r[3], null, "The Members' Room: nothing is excused when the claiming offer's check fails");
});

test('MHP, honest structured answer: no price questions, in any order of offers; every price and line with its source', async () => {
  for (const order of [[0, 1, 2, 3, 4, 5], [5, 4, 3, 2, 1, 0], [4, 0, 3, 5, 2, 1]]) {
    const { profile } = await mhp(reordered(order));
    assert.deepEqual(profile.conflicts, [], `no questions (order ${order})`);
    const room = profile.offers.find((o) => o.name === "The Members' Room");
    assert.equal(room!.price, '£67 a month');
    assert.deepEqual(linesOf(room), [['other', '£670 a year'], ['special', "founders' price", '£47 a month'], ['special', 'for the first 100', '£47']], `order ${order}`);
  }
  const { profile, documents } = await mhp(mhpStructuredAnswer);
  const by = (n: string) => profile.offers.find((o) => o.name === n);
  // The cross-source backstop: The Members' Room's window on the Mentoring page ("The Members' Room is included for a
  // year." then "£3,997, or 6 x £699") reads amounts whose very occurrences One Lane Mentoring's accepted structure claims;
  // its Home window's £1,497 / £997 are Property Done Properly's. Those are not read, so nothing disagrees.
  assert.deepEqual(profile.conflicts, []);
  assert.deepEqual(profile.offers.map((o) => [o.name, o.price]), [['Free cheat sheets', 'Free'], ['The Deal Desk', null], ['Property Done Properly', '£1,497'], ["The Members' Room", '£67 a month'], ['One Lane Mentoring', '£3,997'], ['One Lane Private', '£25,000']]);
  // Property Done Properly: its Join section runs past the "Webinar price:" line where the 8eca59d run stops (change A).
  assert.deepEqual(linesOf(by('Property Done Properly')), [['plan', '3 x £525', 'for £1,497'], ['special', 'Webinar price', '£997'], ['plan', '3 x £349', 'for £997']]);
  assert.deepEqual(linesOf(by("The Members' Room")), [['other', '£670 a year'], ['special', "founders' price", '£47 a month'], ['special', 'for the first 100', '£47']]);
  assert.deepEqual(linesOf(by('One Lane Mentoring')), [['plan', '6 x £699', '£4,194 in total', 'for £3,997']]);
  assert.deepEqual(linesOf(by('One Lane Private')), [['plan', '12 x £2,250', '£27,000 in total', 'for £25,000']]);
  assert.equal(by('The Deal Desk')!.price, null, 'the model left it empty: nothing is filled');
  // The card: each checked price shows where it was found, with its line.
  const shown = brandDnaCard(profile, documents);
  assert.deepEqual(shown.offers.map((o) => o.priceSource?.quote ?? null), [
    'Free cheat sheets | Five one-page guides to the numbers | Available free with an email address | None needed', null, '£1,497 once, or 3 x £525',
    "£67 a month or £670 a year, with a founders' price of £47 a month.", '£3,997 or 6 x £699 (£4,194 in total)', '£25,000 or 12 x £2,250 (£27,000 in total)']);
  assert.equal(shown.offers.find((x) => x.name === 'Free cheat sheets')!.priceSource!.quote, 'Free cheat sheets | Five one-page guides to the numbers | Available free with an email address | None needed');
  const page = brandDnaPage(inputs.SHELL, { ...inputs.STATE, profile, card: shown, status: 'proposed' } as never, 'cmd');
  assert.match(page, /Or pay in instalments: 6 x £699 \(£4,194 in total\) for £3,997<\/span><span class="from"><a[^>]*>From your Join page<\/a>: <q>£3,997 or 6 x £699 \(£4,194 in total\)<\/q>/);
  // Writers receive the model's checked prices and nothing of the structure.
  const sent = profileForPrompt(profile);
  assert.ok(!JSON.stringify(sent).includes('pricing') && !JSON.stringify(sent).includes('6 x £699'));
  for (const o of sent.offers as Record<string, unknown>[]) assert.deepEqual(Object.keys(o), ['name', 'description', 'price', 'url', 'sourceDocumentId']);
  assert.ok(!JSON.stringify(resolveCreativeContext({ brand: { id: 'b', name: 'MHP', website: MHP_SITE }, profile: { ...profile, confirmedAt: 'x' } as BrandProfile, knowledge: [], kit: null })).includes('pricing'));
});

test('MHP: the Home row\'s "for seven days after a webinar" as the special\'s label is accepted too', async () => {
  const { profile } = await mhp((id) => { const a = mhpStructuredAnswer(id) as { offers: Record<string, unknown>[] }; return { ...a, offers: a.offers.map((o) => (o.name === 'Property Done Properly'
    ? { ...o, pricing: { lines: [{ kind: 'plan', text: '3 x £525', for: '£1,497' }, { kind: 'special', text: '£997', label: 'for seven days after a webinar' }, { kind: 'plan', text: '3 x £349', for: '£997' }] } } : o)) }; });
  assert.deepEqual(linesOf(profile.offers.find((o) => o.name === 'Property Done Properly')), [['plan', '3 x £525', 'for £1,497'], ['special', 'for seven days after a webinar', '£997'], ['plan', '3 x £349', 'for £997']]);
});

test('the backstop still asks: a different price in an upload, an equal amount claimed elsewhere (B1d), an unclaimed amount, an unmappable page', async () => {
  // An uploaded list states another price for The Members' Room.
  const upload = kdoc('u1', "Price list\nThe Members' Room is now £77 a month.", null);
  const a = await mhp(mhpStructuredAnswer, MHP_PAGES, [upload]);
  assert.deepEqual(a.profile.conflicts.map((c) => c.offer), ["The Members' Room"]);
  // (Its answers are the backstop's first six, as at 8eca59d: the upload's £77 a month is what makes the sources disagree.)
  assert.equal(a.profile.offers.find((o) => o.name === "The Members' Room")!.price, null);
  // B1(d): "New price £1,597" in an upload against the accepted £1,497, while another offer's accepted structure holds an
  // equal "£1,597 a year" at a different position: never ignored.
  const page = wdoc('d1', '<h3>Property Course</h3><p>Twelve modules.</p><p>£1,497</p><h3>Annual Club</h3><p>£149 a month or £1,597 a year</p>', 'https://x.example/pricing');
  const note = kdoc('u2', 'Property Course. New price £1,597.', null);
  const b = await make([page, note], { offers: [
    { name: 'Property Course', description: '', price: '£1,497', url: null, sourceDocumentId: 'd1', pricing: { lines: [] } },
    { name: 'Annual Club', description: '', price: '£149 a month', url: null, sourceDocumentId: 'd1', pricing: { lines: [{ kind: 'other', text: '£1,597 a year' }] } }] });
  assert.equal(b.profile.offers[1]!.pricing!.lines[0]!.text, '£1,597 a year', "Annual Club's structure is accepted");
  assert.deepEqual(b.profile.conflicts.map((c) => [c.offer, c.options?.map((o) => o.value)]), [['Property Course', ['£1,497', '£1,597']]]);
  // An amount near the offer's name that no accepted offer claims.
  const c = await make([wdoc('d1', '<h3>Pro</h3><p>£29 per month</p><h3>Team</h3><p>£99 per month</p>', 'https://x.example/pricing'), kdoc('u3', 'Pro is £35 per month.', null)], { offers: [
    { name: 'Pro', description: '', price: '£29 per month', url: null, sourceDocumentId: 'd1', pricing: { lines: [] } },
    { name: 'Team', description: '', price: '£99 per month', url: null, sourceDocumentId: 'd1', pricing: { lines: [] } }] });
  assert.deepEqual(c.profile.conflicts.map((x) => x.offer), ['Pro']);
  // A Mentoring page whose positions cannot be mapped with certainty (a combining accent the normalisation joins): nothing on
  // it is ignored, so the backstop still asks about The Members' Room and One Lane Private. Round 7 (item 6): both structures
  // were accepted, so each is asked 8eca59d's same-page question on its cited page (the Join page) instead of the
  // cross-source one; the offers are held either way.
  const d = await mhp(mhpStructuredAnswer, { ...MHP_PAGES, '/mentoring/': MHP_PAGES['/mentoring/']!.replace('Ninety days', 'Cafe\u0301 talks. Ninety days') });
  assert.deepEqual(d.profile.conflicts.map((x) => [x.offer, x.detail, x.options?.map((o) => `${o.value}@${o.documentId}`)]), [
    ["The Members' Room", "We found more than one price for The Members' Room. Which is right?", ['£67 a month@doc2', '£670 a year@doc2', '£47 a month@doc2', '£67@doc2', '£997@doc2', '£1,497@doc2']],
    ['One Lane Private', 'We found more than one price for One Lane Private. Which is right?', ['£25,000@doc2', '£2,250@doc2', '£27,000@doc2']]]);
  assert.ok(d.profile.offers.filter((o) => ["The Members' Room", 'One Lane Private'].includes(o.name)).every((o) => o.price === null && !o.pricing));
});

test('the backstop\'s position map: collapsed text to document text to the rules\' basis, exact, or nothing', () => {
  const text = '# Pro  plan\n\n| Pro | £9\u00a0a month |   £90 a year\n▸ Buy\t now £5\u200b£6 ² £7';
  const collapsed = text.replace(/\s+/g, ' '), toText = collapsedPositions(text), toBasis = basisPositions(text)!, basis = basisText(text);
  assert.ok(toBasis, 'no joining normalisation: certain');
  assert.equal(toText.length, collapsed.length + 1);
  for (let c = 0; c < collapsed.length; c++) {
    const t = toText[c]!;
    if (/\s/.test(collapsed[c]!)) assert.ok(/\s/.test(text[t]!), `white space at ${c}`); else assert.equal(text[t], collapsed[c], `char at ${c}`);
    if (collapsed[c] === '£') assert.equal(basis[toBasis[t]!], '£', `£ at ${c}`);
  }
  // Removed characters map nowhere; a footnote mark becomes a space; a code point's second half is not a start.
  assert.equal(toBasis[text.indexOf('\u200b')], -1);
  assert.equal(basis[toBasis[text.indexOf('²')]!], ' ');
  const astral = basisPositions('a𝐀£1')!; assert.equal(astral[2], -1); assert.equal(basisText('a𝐀£1')[astral[3]!], '£');
  assert.equal(basisPositions('Cafe\u0301 £5'), null, 'normalisation joins characters: no position is certain');
});

test('MHP, the owner\'s real (unstructured) answer: handled exactly as at 8eca59d', async () => {
  const { profile } = await mhp(mhpModelAnswer);
  assert.ok(profile.conflicts.length > 0); assert.ok(profile.offers.every((o) => !o.pricing));
});

// ─── The check, rule by rule ─────────────────────────────────────────────────

test('S1: a special, a sale, a fee, a plan total or the second amount given as the price is refused (8eca59d then asks or empties)', () => {
  const ck = (text: string, price: string, lines: Lines = [], names = ['Course']) => checkPricing([{ id: 'd', text }], names, 0, price, lines as never, 'd');
  assert.equal(ck('## Course\n£997 (webinar attendees only), normally £1,497', '£997', [{ kind: 'other', text: '£1,497', label: 'normally' }]), null);
  assert.equal(ck("## Course\n£47 a month. Founders' price, limited to the first 100. Then £67 a month.", '£47 a month', [{ kind: 'other', text: '£67 a month', label: 'Then' }]), null);
  assert.equal(ck('## Course\nBlack Friday price £49. Usual price £99.', '£49', [{ kind: 'other', text: '£99', label: 'Usual price' }]), null);
  assert.equal(ck('## Course\nSale: £49\nNormal price: £99', '£49', [{ kind: 'other', text: '£99', label: 'Normal price' }]), null);
  assert.equal(ck('## Course\nNew customers £60. Existing customers £85.', '£60', [{ kind: 'other', text: '£85', label: 'Existing customers' }]), null);
  assert.equal(ck('## Course\n£695 until 31 January, then £895', '£695', [{ kind: 'other', text: '£895', label: 'then' }]), null);
  assert.equal(ck('## Course\nWas £99, now £49', 'Was £99', [{ kind: 'special', text: 'now £49', label: 'now' }]), null);
  for (const [fee, real] of [['Enrolment £30', '£120 a term'], ['Registration fee £50', '£40 a month'], ['Taster class £5', '£12 a class'], ['Initial assessment £65', '£45 a session'], ['£25 admin fee', '£300']] as const)
    assert.equal(ck(`## Course\n${fee}\n${real}`, fee.match(/£\d+/)![0], [{ kind: 'other', text: real }]), null, fee);
  assert.equal(ck('# Our fees\nWe charge a fee of £495 on completion of your mortgage. For buy-to-let and complex cases the fee is £695.', '£695', [{ kind: 'other', text: '£495', label: 'on completion of your mortgage' }], ['Our fees']), null, 'the first amount is £495');
  assert.equal(ck('## Course\n| Members | £10\n| Non-members | £12', '£10', [{ kind: 'other', text: '£12', label: 'Members' }]), null, '"Members" is not "Non-members"');
  for (const label of ['Course', 'price', 'a year']) assert.equal(ck('## Course\n£10 a month, offer price £12 a month', '£10 a month', [{ kind: 'special', text: '£12 a month', label }]), null, label);
  assert.equal(ck('## Course\n£9 per bag or 3 x £8', '£9 per bag', [{ kind: 'plan', text: '3 x £8', for: '£9 per bag' }]), null, 'a parent with a unit is not a one-off price');
  assert.equal(ck('## Course\n£1,497 or 3 x £525 (£1,575 in total)', '£1,575', []), null, 'a plan total is not the price');
  assert.equal(ck('## Course\n£997, or £1,497 if you pay later with credit', '£997', []), null, '"with credit" excuses nothing');
  assert.ok(ck('## Course\n£3,997 or 6 x £699 (£4,194 in total)\nThe £997 course price credits in full for 90 days.', '£3,997', [{ kind: 'plan', text: '6 x £699', for: '£3,997', total: '£4,194 in total' }]), 'credits in full is a cross-reference');
  assert.ok(ck('## Course\n£1,497 once, or 3 x £525', '£1,497 once', [{ kind: 'plan', text: '3 x £525', for: '£1,497' }]));
});

test('S2, Free: only with a structure, a run with no amount, and the name or a whole "Free" line that is not a label\'s value', async () => {
  const ck = (text: string, names = ['Valuation']) => checkPricing([{ id: 'd', text }], names, 0, 'Free', [], 'd');
  assert.ok(ck('## Valuation\nFree')); assert.ok(ck('## Valuation\nNo charge.')); assert.ok(ck('## Free valuation\nBook online.', ['Free valuation']));
  assert.ok(ck('| Valuation | Free')); assert.ok(ck('## Valuation\nPrice:\nFree'));
  for (const t of ['## Valuation\nFree\n£29 a month', '| Valuation | Delivery | Free', '## Valuation\nHome survey:\nFree', '## Valuation\nStress-free letting.', '## Valuation\nGet a free quote'])
    assert.equal(ck(t), null, t);
  // Without a structure, "Free" is handled exactly as at 8eca59d (it is no amount on the page).
  const plain = await quick({ html: '<h3>Valuation</h3><p>Free</p>' }, [['Valuation', 'Free']]);
  assert.equal(plain.profile.offers[0]!.price, null);
  const structured = await quick({ html: '<h3>Valuation</h3><p>Free</p>' }, [['Valuation', 'Free', []]]);
  assert.equal(structured.profile.offers[0]!.price, 'Free');
  assert.equal(brandDnaCard(structured.profile, [wdoc('d1', '<h3>Valuation</h3><p>Free</p>', 'https://x.example/pricing')]).offers[0]!.priceSource!.quote, 'Free');
});

test('S3, fix 7: action text is read as the ordinary line it was at 8eca59d; an uploaded document\'s own "▸ " bullets are its own words', async () => {
  for (const html of ['<div class="acc"><button class="acc-head">Boiler service</button><div class="panel"><p>£85</p></div></div>', '<div class="tile"><a class="cta" href="/a">Boiler service</a><p>£85</p></div>', '<p>Boiler service <a class="btn" href="/x">£85</a></p>'])
    assert.equal((await quick({ html }, [['Boiler service', '£85']])).profile.offers[0]!.price, '£85', html);
  const claim = await quick({ html: '<p><a class="btn" href="/x">We are Gas Safe registered engineers.</a></p><p>We service boilers.</p>' }, [], { approvedClaims: ['We are Gas Safe registered engineers.'], sources: [{ field: 'claim', value: 'We are Gas Safe registered engineers.', documentId: 'd1', quote: 'We are Gas Safe registered engineers.' }] });
  assert.deepEqual(claim.profile.approvedClaims, ['We are Gas Safe registered engineers.']);
  const upload = kdoc('u1', '▸ We are Gas Safe registered engineers.\n▸ Boiler service £85', null);
  const r = await make([upload], { offers: [{ name: 'Boiler service', description: '', price: '£85', url: null, sourceDocumentId: 'u1' }], approvedClaims: ['We are Gas Safe registered engineers.'], sources: [{ field: 'claim', value: 'We are Gas Safe registered engineers.', documentId: 'u1', quote: 'We are Gas Safe registered engineers.' }] });
  assert.equal(r.profile.offers[0]!.price, '£85');
});

test('B7: an unchanged price box changes nothing; an edited box is the owner\'s own; answering a price question is never undone by a later save', async () => {
  const { profile } = await mhp(mhpStructuredAnswer);
  const mentoring = profile.offers.find((o) => o.name === 'One Lane Mentoring')!;
  assert.equal(pricingAfterEdit(mentoring, pricingEditText(mentoring)), mentoring);
  assert.equal(pricingAfterEdit(mentoring, `${pricingEditText(mentoring)}\r\n`), mentoring);
  const edited = pricingAfterEdit(mentoring, 'Instalments: 6 x £699\nSpecial offer: £3,497 until Friday');
  assert.equal(edited.price, '£3,997');
  assert.deepEqual(edited.pricing!.lines, [{ role: 'plan', text: '6 x £699', documentId: null, quote: null }, { role: 'special', text: '£3,497 until Friday', documentId: null, quote: null }]);
  const settled = settleConflict({ offers: [{ name: 'X', description: '', price: null, url: null, sourceDocumentId: 'd' }], approvedClaims: [], conflicts: [{ field: 'X: price', detail: '', documentIds: ['d'], kind: 'price', offer: 'X', options: [{ value: '£5', documentId: 'd', quote: 'X £5' }] }], sources: [], strict: true } as never, 0, { kind: 'option', index: 0 });
  assert.equal(pricingAfterEdit(settled.offers[0]!, '').price, '£5');
});

test('B8, reader: a button inside a sentence stays inline; whole-line controls are recorded beside the words; the stored words are 8eca59d\'s', () => {
  assert.deepEqual(read('<p>Unlike other agents, <button>we</button> charge hidden fees to every landlord.</p>'), { text: 'Unlike other agents, we charge hidden fees to every landlord.', actionLines: [] });
  assert.deepEqual(read('<section><h3>Pro</h3><p>£49</p><a class="btn btn-primary">Start Pro: £49</a></section>'), { text: '### Pro\n£49\nStart Pro: £49', actionLines: [2] });
  assert.equal(tagged('<p>(£1,575 in total)<span>Or 3 payments</span></p>'), '(£1,575 in total)Or 3 payments', 'no new spacing rule: the stored words are as at 8eca59d');
  assert.doesNotThrow(() => brandPageHtmlLines(`<html><body><main><p class="${'a '.repeat(130000)}">x</p></main></body></html>`));
});

// ─── The review's P1, P1d, P2, P2e, P3, R22, R23 (round 4) ─────────────────

const PR_PAGES = {
  P1: '<h2>Our services</h2><div class="card"><h3>Boiler service</h3><p>A full annual service by a Gas Safe engineer.</p><p>£75</p></div><div class="card"><h3>Gas safety check</h3><p>For landlords.</p></div><h2>Price list</h2><p>Boiler service £85</p><p>Gas safety check £70</p>',
  P1d: '<div class="card"><h3>Full Management</h3><p>12% of monthly rent</p></div><h2>Landlord offer</h2><p>Full Management is 10% of monthly rent for portfolio landlords.</p>',
  P2: '<div class="card"><h3>Wedding photography</h3><p>Packages to suit every couple. Ask for our brochure.</p><p>Engagement shoot: £150</p></div>',
  P2e: '<h3>Website care plan</h3><p>Hosting, updates and backups.</p><p>Set-up fee: £199</p>',
  P3: "<h3>One Lane Mentoring</h3><p>Ninety days in a group.</p><p>The Members' Room: £67 a month</p>",
  R22: '<div class="plan"><h3>Pro</h3><p>£29 per month</p><a class="btn" href="/signup">Choose Pro</a><p>Billed monthly.</p><p>Or pay yearly:</p><p>£290 per year</p></div>',
  R23: '<div class="plan"><h3>Pro</h3><p>£29 per month</p><a class="btn" href="/signup">Choose Pro</a><ul><li>Everything in Starter</li><li>Priority support</li></ul><p>Pro is £35 per month from January.</p></div>',
} as const;
/** What 8eca59d made of each page (recorded from the export of 8eca59d, the review's both.mts harness). */
const PR_BASE: Record<keyof typeof PR_PAGES, string> = {
  P1: 'Boiler service: price=null || Gas safety check: price="£70" ?? [£75 / £85]',
  P1d: 'Full Management: price=null ?? [12% of monthly rent / 10% of monthly rent]',
  P2: 'Wedding photography: price=null leftOut ["price:Wedding photography"]',
  P2e: 'Website care plan: price=null leftOut ["price:Website care plan"]',
  P3: 'One Lane Mentoring: price=null || The Members\' Room: price="£67 a month" leftOut ["price:One Lane Mentoring"]',
  R22: 'Pro: price=null ?? [£29 per month / £290 per year]',
  R23: 'Pro: price=null ?? [£29 per month / £35 per month]',
};
type PrCase = [keyof typeof PR_PAGES, string, ([string, string | null] | [string, string | null, Lines | undefined])[], string | null];
const PR_CASES: PrCase[] = [
  // (i) the structure ignores the second amount: refused, exactly 8eca59d.
  ['P1', 'i', [['Boiler service', '£75', []], ['Gas safety check', '£70', []]], null],
  ['P1d', 'i', [['Full Management', '12% of monthly rent', []]], null],
  ['P2', 'i', [['Wedding photography', '£150', []]], null],
  ['P2e', 'i', [['Website care plan', '£199', []]], null],
  ['P3', 'i', [['One Lane Mentoring', '£67 a month', []], ["The Members' Room", '£67 a month']], null],
  ['R22', 'i', [['Pro', '£29 per month', []]], null],
  ['R23', 'i', [['Pro', '£29 per month', []]], null],
  // (ii) the second amount proposed: accepted only when honest and labelled.
  ['P1', 'ii: £85 as an other line, no label', [['Boiler service', '£75', [{ kind: 'other', text: '£85' }]], ['Gas safety check', '£70', []]], null],
  ['P1', 'ii: £85 labelled by the "Price list" heading (a heading is never a label)', [['Boiler service', '£75', [{ kind: 'other', text: '£85', label: 'Price list' }]], ['Gas safety check', '£70', []]], null],
  ['P1', 'ii: £85 as the price', [['Boiler service', '£85', [{ kind: 'other', text: '£75' }]], ['Gas safety check', '£70', []]], null],
  // Round 6 (veto scoped): the heading "Landlord offer" below the price holds only the weak word "offer", which counts in
  // the price's own clause and label only. The 10% is the page's conditional price "for portfolio landlords": a special.
  ['P1d', 'ii: special "for portfolio landlords"', [['Full Management', '12% of monthly rent', [{ kind: 'special', text: '10% of monthly rent', label: 'for portfolio landlords' }]]], 'Full Management: price="12% of monthly rent" {special:[for portfolio landlords] 10% of monthly rent}'],
  ['P1d', 'ii: other, no label', [['Full Management', '12% of monthly rent', [{ kind: 'other', text: '10% of monthly rent' }]]], null],
  ['P2', 'ii: "Engagement shoot" with £150 also as the price', [['Wedding photography', '£150', [{ kind: 'other', text: '£150', label: 'Engagement shoot' }]]], null],
  ['P2e', 'ii: "Set-up fee" with £199 also as the price', [['Website care plan', '£199', [{ kind: 'other', text: '£199', label: 'Set-up fee' }]]], null],
  ['P3', 'ii: Mentoring\'s line labelled with another offer\'s name', [['One Lane Mentoring', '£67 a month', [{ kind: 'other', text: '£67 a month', label: "The Members' Room" }]], ["The Members' Room", '£67 a month']], null],
  // Round 6 (fix 4): "£290 per year" has a short label line of its own above it ("Or pay yearly:"), so without that label it is refused.
  ['R22', 'ii: £290 per year as an other line (differs by period only)', [['Pro', '£29 per month', [{ kind: 'other', text: '£290 per year' }]]], null],
  ['R22', 'ii: £290 per year labelled "pay yearly"', [['Pro', '£29 per month', [{ kind: 'other', text: '£290 per year', label: 'pay yearly' }]]], 'Pro: price="£29 per month" {other:[pay yearly] £290 per year}'],
  ['R23', 'ii: £35 per month as an other line, no label (same period)', [['Pro', '£29 per month', [{ kind: 'other', text: '£35 per month' }]]], null],
  // Round 7 (rule 1): a special dearer than the price ("Pro is £35 per month from January", a coming rise) is refused.
  ['R23', 'ii: £35 per month as a special labelled "from January"', [['Pro', '£29 per month', [{ kind: 'special', text: '£35 per month', label: 'from January' }]]], null],
];
test('the review\'s P1, P1d, P2, P2e, P3, R22, R23: a structure ignoring the second amount is refused (8eca59d); an honest labelled one is accepted', async () => {
  for (const [k, what, offers, accepted] of PR_CASES) {
    assert.equal(fmt(await quick({ html: PR_PAGES[k] }, offers, {}, true), true), PR_BASE[k], `${k} without pricing`);
    assert.equal(fmt(await quick({ html: PR_PAGES[k] }, offers), true), accepted ?? PR_BASE[k], `${k} ${what}`);
  }
});

// ─── Ten honest sites, with honest structured answers ────────────────────────

const EXTRA_SITES: { name: string; html: string; offers: { name: string; price: string | null; pricing?: { lines: Lines } }[]; asks?: string[] }[] = [
  { name: '8 SAAS TIERS (sale badge)', html: '<h1>Pricing</h1><div class="tier"><h3>Starter</h3><span class="badge">Sale</span><p>Was £19 a month, now £12 a month</p><p>For one site.</p></div><div class="tier"><h3>Growth</h3><p>£49 a month or £490 a year</p><p>Up to ten sites.</p><a class="btn" href="/signup">Start free trial</a></div><div class="tier"><h3>Agency</h3><p>£149 a month</p><p>Set-up fee: £299</p></div>',
    offers: [{ name: 'Starter', price: null }, { name: 'Growth', price: '£49 a month', pricing: { lines: [{ kind: 'other', text: '£490 a year' }] } }, { name: 'Agency', price: '£149 a month', pricing: { lines: [{ kind: 'other', text: '£299', label: 'Set-up fee' }] } }], asks: ['Starter'] },
  { name: '9 COURSE (payment plan, early bird)', html: '<h1>The Landlord Course</h1><h2>Landlord Foundations</h2><p>Eight modules and weekly questions answered.</p><p>£399, or 3 monthly payments of £139 (£417 in total). Early bird: £299 until 1 March</p>',
    offers: [{ name: 'Landlord Foundations', price: '£399', pricing: { lines: [{ kind: 'plan', text: '3 monthly payments of £139', for: '£399', total: '£417 in total' }, { kind: 'special', text: '£299', label: 'Early bird' }] } }] },
  { name: '10 MEMBERSHIP (founders)', html: '<h2>The Kitchen Club</h2><p>Monthly recipes and live cook-alongs.</p><p>£15 a month. Founders’ price: £9 a month for the first 200 members</p>',
    offers: [{ name: 'The Kitchen Club', price: '£15 a month', pricing: { lines: [{ kind: 'special', text: '£9 a month', label: 'Founders’ price' }] } }] },
];

test('ten honest sites with honest structured answers: wrong price 0, wrong role 0', async (t) => {
  const total = { kept: 0, priced: 0, accepted: 0, proposed: 0, questions: 0, wrongPrice: 0, wrongRole: 0 };
  const tally = (name: string, r: Made, given: { name: string; price: string | null; pricing?: { lines: Lines } }[]) => {
    const priced = given.filter((o) => o.price);
    const kept = r.profile.offers.filter((o) => o.price && priced.some((p) => p.name === o.name && p.price === o.price)).length;
    const wrongPrice = r.profile.offers.filter((o) => o.price && !priced.some((p) => p.name === o.name && p.price === o.price)).length;
    const wrongRole = r.profile.offers.flatMap((o) => (o.pricing?.lines ?? []).filter((l) => !given.find((g) => g.name === o.name)?.pricing?.lines.some((p) => p.kind === l.role && keyOf(p.text) === keyOf(l.text)))).length;
    const proposed = given.reduce((n, o) => n + (o.pricing?.lines.length ?? 0), 0), accepted = r.profile.offers.reduce((n, o) => n + (o.pricing?.lines.length ?? 0), 0);
    total.kept += kept; total.priced += priced.length; total.accepted += accepted; total.proposed += proposed; total.questions += r.profile.conflicts.length; total.wrongPrice += wrongPrice; total.wrongRole += wrongRole;
    t.diagnostic(`${name} | prices kept ${kept}/${priced.length} | lines accepted ${accepted}/${proposed} | questions ${r.profile.conflicts.length} | wrong price ${wrongPrice} | wrong role ${wrongRole}`);
    assert.equal(wrongPrice, 0, name); assert.equal(wrongRole, 0, name);
  };
  for (const s of sites) {
    const docs = Object.entries(s.pages).map(([path, html], i) => wdoc(`doc${i + 1}`, html, s.website + path, s.raw === true));
    const ids = Object.fromEntries(Object.keys(s.pages).map((p, i) => [p, `doc${i + 1}`]));
    const given = s.answer(ids) as { offers: { name: string; price: string | null; pricing?: { lines: Lines } }[] };
    if (/COACH/.test(s.name)) given.offers = given.offers.map((o) => (o.name === 'Return to Work Programme' ? { ...o, price: '£795', pricing: { lines: [{ kind: 'plan', text: 'three monthly payments of £275', for: '£795' }] } } : o));
    tally(s.name, await make(docs, given, s.website), given.offers);
  }
  for (const s of EXTRA_SITES) {
    const r = await make([wdoc('d1', s.html, 'https://x.example/pricing')], { offers: s.offers.map((o) => ({ ...o, description: '', url: null, sourceDocumentId: 'd1' })) });
    tally(s.name, r, s.offers);
    assert.deepEqual(r.profile.conflicts.map((c) => c.offer), s.asks ?? [], s.name);
  }
  t.diagnostic(`TOTAL | prices kept ${total.kept}/${total.priced} | lines accepted ${total.accepted}/${total.proposed} | questions ${total.questions} | wrong price ${total.wrongPrice} | wrong role ${total.wrongRole}`);
});

// ─── Round 6: the review's round-8 fixes ─────────────────────────────────────

test('round 6, fixes 1 and 2: action text is recorded beside the stored words, which are 8eca59d\'s byte for byte (limit, own "▸ " bullets)', async () => {
  // A long page of "Book now" buttons: the 8,000-character limit cuts exactly the words 8eca59d kept (recorded from 8eca59d:
  // 7,988 characters, ending in the last two lines), and 8eca59d's question stands.
  const card = (i: number) => `<div class="card"><h3>Service ${i}</h3><p>We do this job properly and tidy up afterwards, every time, for every customer in the area.</p><a class="btn" href="/book">Book now</a></div>`;
  const html = Array.from({ length: 68 }, (_, i) => card(i)).join('') + '<div class="card"><h3>Boiler service</h3><p>£85</p></div><h2>Price changes</h2><p>Boiler service £95 from January.</p><p>We are Gas Safe registered engineers.</p>';
  const r = read(html);
  assert.equal(r.text, tagged(html)); assert.equal(r.text.length, 7988); assert.ok(r.text.endsWith('Boiler service £95 from January.\nWe are Gas Safe registered engineers.'));
  assert.equal(r.actionLines.length, 68); assert.ok(r.actionLines.every((i) => r.text.split('\n')[i] === 'Book now'));
  assert.equal(fmt(await quick({ html }, [['Boiler service', '£85']])), 'Boiler service: price=null ?? [£85 / £95]');
  // A page's own "▸ " is its own words: stored as written, with no invisible character and no action line.
  const own = read('<p>▸ Gas Safe registered</p><a class="btn" href="/b">Book a service</a><h3>Boiler service</h3><p>£85</p>');
  assert.deepEqual(own, { text: '▸ Gas Safe registered\nBook a service\n### Boiler service\n£85', actionLines: [1] });
  // Only the website door's prompt marks action lines, and escapes a line of the page's own that starts "▸ ".
  assert.equal(actionMarked(own.text, own.actionLines), '​▸ Gas Safe registered\n▸ Book a service\n### Boiler service\n£85');
  // Stored with the page: the line numbers sit in the document's origin, cut to the stored text.
  const [doc] = websiteDocuments({ brandId: 'b', existing: [], now: 'n', pages: [{ url: 'https://x.example/', fetchStatus: 'ok', text: own.text, actionLines: own.actionLines } as never] }).documents;
  assert.equal(doc!.text, own.text); assert.deepEqual(doc!.origin!.actionLines, [1]);
  // Setup's prompt and the acquisition evidence read the stored words exactly as at 8eca59d (structure markers off, nothing else).
  const docs = [{ ...kdoc('w1', own.text, 'https://x.example/', {}, own.actionLines), category: 'faqs' }] as KnowledgeDocument[];
  let sent = '';
  const llm = { mode: 'mock', complete: async (req: { messages: { content: string }[] }) => { sent = req.messages[0]!.content; return { text: JSON.stringify(answer({ offers: [] })), tokensIn: 1, tokensOut: 1, model: 'mock' }; } } as unknown as LlmClient;
  await extractProfile(llm, { brandName: 'Hearth', website: 'https://x.example', documents: docs });
  assert.ok(sent.includes(JSON.stringify(withoutMarkers(own.text)).slice(1, -1)), 'Setup is sent the page as 8eca59d sent it');
  assert.ok(!sent.includes('​') && !sent.includes('\\u200b'));
  const facts = buildAcquisitionEvidence({ profile: { ...inputs.SETUP_PROFILE, knowledge: [{ documentId: 'w1', version: 1, sha256: 's', category: 'faqs' }] } as never, knowledge: docs, plans: [], articles: [] }).facts;
  assert.equal(facts[0]!.text, withoutMarkers(own.text).replace(/\s+/g, ' ').trim());
});

test('round 6, fix 3: `pricing: { lines: [] }` beside an ordinary price is no proposal at all (8eca59d, its source line and its questions)', async () => {
  for (const [html, name, price] of [['<h3>Boiler service</h3><p>A full annual service.</p><p>£85</p>', 'Boiler service', '£85'],
    ['<div><h3>Pro</h3><p>£29 per month</p><p>Five users.</p><p>Priority support.</p><form><label>Pay £35 per month by card</label><input><button>Pay</button></form></div>', 'Pro', '£29 per month']] as const) {
    const empty = await quick({ html }, [[name, price, []]]), none = await quick({ html }, [[name, price]]);
    assert.equal(fmt(empty, true), fmt(none, true), html);
    assert.deepEqual(brandDnaCard(empty.profile, [wdoc('d1', html, 'https://x.example/pricing')]).offers[0]!.priceSource, brandDnaCard(none.profile, [wdoc('d1', html, 'https://x.example/pricing')]).offers[0]!.priceSource);
  }
  assert.equal(fmt(await quick({ html: '<div><h3>Pro</h3><p>£29 per month</p><p>Five users.</p><p>Priority support.</p><form><label>Pay £35 per month by card</label><input><button>Pay</button></form></div>' }, [['Pro', '£29 per month', []]])), 'Pro: price=null ?? [£29 per month / £35 per month]');
});

test('round 6, fixes 4 and 5: an unlabelled "other" with a label of its own is refused; only the exact occurrences matched are claimed', async () => {
  // Fix 4: "£5 a month" belongs to "Email hosting", the short line above it.
  const hosting = '<h3>Website hosting</h3><p>£120 a year</p><p>Email hosting</p><p>£5 a month</p>';
  assert.equal(fmt(await quick({ html: hosting }, [['Website hosting', '£120 a year', [{ kind: 'other', text: '£5 a month' }]]])), fmt(await quick({ html: hosting }, [['Website hosting', '£120 a year']])));
  assert.equal(checkPricing([{ id: 'd', text: '| Website hosting | £120 a year | Email hosting | £5 a month' }], ['Website hosting'], 0, '£120 a year', [{ kind: 'other', text: '£5 a month' }], 'd'), null, 'a label cell before it');
  assert.ok(checkPricing([{ id: 'd', text: '## Website hosting\n£120 a year or £12 a month' }], ['Website hosting'], 0, '£120 a year', [{ kind: 'other', text: '£12 a month' }], 'd'), 'beside the price, it is the price\'s own pair');
  // Fix 5: "The Members' Room lifetime access: £3,997" inside Mentoring's card equals Mentoring's price but is labelled with
  // The Members' Room's name: Mentoring does not claim it, so The Members' Room is asked about.
  const join = kdoc('d1', "# Join\n## The Members' Room\n£67 a month or £670 a year\n## One Lane Mentoring\n£3,997 or 6 x £699", 'https://x.example/join');
  const mentoring = kdoc('d3', "# One Lane Mentoring\n£3,997, or 6 x £699\nThe Members' Room lifetime access: £3,997", 'https://x.example/mentoring');
  const offers = [{ name: "The Members' Room", description: '', price: '£67 a month', url: null, sourceDocumentId: 'd1', pricing: { lines: [{ kind: 'other', text: '£670 a year' }] } },
    { name: 'One Lane Mentoring', description: '', price: '£3,997', url: null, sourceDocumentId: 'd1', pricing: { lines: [{ kind: 'plan', text: '6 x £699', for: '£3,997' }] } }];
  const r = await make([join, mentoring], { offers });
  assert.equal(r.profile.offers[0]!.price, null); assert.deepEqual(r.profile.conflicts.map((c) => c.offer), ["The Members' Room"]);
  const claims = checkAllPricing([{ id: 'd1', text: join.text }, { id: 'd3', text: mentoring.text }], offers.map((o) => o.name), offers.map((o, i) => ({ self: i, price: o.price, proposed: proposedLines(o.pricing), citedId: 'd1' })))[1]!.claims!;
  assert.ok(!claims.includes(`d3:${basisText(mentoring.text!).lastIndexOf('£3,997')}`));
  // Without that line, the Mentoring page's restated amounts are Mentoring's, and nothing is asked (MHP).
  const plain = await make([join, kdoc('d3', "# One Lane Mentoring\n£3,997, or 6 x £699\nThe Members' Room is included for a year.\n£3,997, or 6 x £699", 'https://x.example/mentoring')], { offers });
  assert.deepEqual(plain.profile.conflicts, []);
});

test('round 6, the veto by place: strong and weak words, the price\'s own clause and label, explained clauses; every S1 shape still refused', () => {
  const ck = (text: string, price: string, lines: Lines = [], names = ['Course']) => checkPricing([{ id: 'd', text }], names, 0, price, lines as never, 'd');
  // Honest: a strong word in the clause of an accounted special; weak words in the cell after.
  assert.ok(ck('## Course\n£1,497, or £997 for seven days after a webinar', '£1,497', [{ kind: 'special', text: '£997', label: 'for seven days after a webinar' }]));
  assert.ok(ck('| Course | £3,997, or 6 x £699 | Full refund before the first call; then none', '£3,997', [{ kind: 'plan', text: '6 x £699', for: '£3,997' }]));
  assert.ok(ck('## Course\n£1,497. Webinar price: £997', '£1,497', [{ kind: 'special', text: '£997', label: 'Webinar price' }]), 'the special\'s own sentence');
  assert.ok(ck('## Course\n£40 a month\nFirst lesson booked online', '£40 a month'), 'a weak word below the price');
  // Refused: a strong word outside the price's own clause that no accounted amount explains, or in the cell after it.
  assert.equal(ck("## Course\n£47 a month. Founders' price, limited to the first 100. Then £67 a month.", '£47 a month', [{ kind: 'other', text: '£67 a month', label: 'Then' }]), null);
  assert.equal(ck('| Course | £85 | Introductory price', '£85'), null);
  assert.equal(ck('## Course\n£85\nIntroductory price', '£85'), null, 'a strong word on a short label line below');
  assert.equal(ck('## Course\n£997\nWebinar price\n£1,497\nStandard price', '£997', [{ kind: 'other', text: '£1,497', label: 'Webinar price' }]), null, 'a label line between two amounts is never explained (M1c)');
  // Weak words still count in the price's own clause and own label.
  assert.equal(ck('## Course\n£85 until Friday', '£85'), null); assert.equal(ck('## Course\nFirst month: £85', '£85'), null); assert.equal(ck('## Course\nNormally\n£85', '£85'), null);
  assert.equal(ck('## Course\nWas £99, now £49', '£49'), null, '"now" after "was"');
});

test('MHP, honest structured answer cited to the Home table: no price questions; each price shown with its Home row', async () => {
  const { profile, documents } = await mhp((id) => { const a = mhpStructuredAnswer(id) as { offers: Record<string, unknown>[] };
    return { ...a, offers: a.offers.map((o) => (o.pricing && !['Free cheat sheets', 'One Lane Private'].includes(o.name as string) ? { ...o, sourceDocumentId: id['/'] } : o)) }; });
  assert.deepEqual(profile.conflicts, []);
  assert.deepEqual(profile.offers.map((o) => [o.name, o.price, linesOf(o).length]), [['Free cheat sheets', 'Free', 0], ['The Deal Desk', null, 0], ['Property Done Properly', '£1,497', 3], ["The Members' Room", '£67 a month', 3], ['One Lane Mentoring', '£3,997', 1], ['One Lane Private', '£25,000', 1]]);
  assert.equal(brandDnaCard(profile, documents).offers.find((o) => o.name === 'One Lane Mentoring')!.priceSource!.quote, 'One Lane Mentoring | 90 days, twelve people, one lane of property investing | £3,997, or 6 x £699 | Full refund before the first call; then none');
});

// ─── Round 7: structural refusals, own cards, the owner's real pages ────────

test('round 7, rules 1 to 3: the ordinary price is never the cheaper one; a fee beside a subscription; "only" and "offer" are not cues', () => {
  const ck = (text: string, price: string, lines: Lines = [], names = ['Pro Plan']) => checkPricing([{ id: 'd', text }], names, 0, price, lines as never, 'd');
  // Rule 1: a dearer labelled other of the same period, or a dearer special, means a concession or intro price was given as the price.
  for (const [text, price, lines] of [
    ['### Pro Plan\n£47 a month (first three months)\nStandard price: £67 a month', '£47 a month', [{ kind: 'other', text: '£67 a month', label: 'Standard price' }]],
    ['### Pro Plan\n£47 a month. First 100 members only.\nStandard price: £67 a month', '£47 a month', [{ kind: 'other', text: '£67 a month', label: 'Standard price' }]],
    ["### Pro Plan\nFounders' price for the first hundred members who join us\n£47 a month\nUsual price: £67 a month", '£47 a month', [{ kind: 'other', text: '£67 a month', label: 'Usual price' }]],
    ['### Pro Plan\n£997. Webinar price until Friday then £1,497.', '£997', [{ kind: 'other', text: '£1,497', label: 'then' }]],
    ['### Pro Plan\n£997 or £1,497 after the webinar price ends', '£997', [{ kind: 'special', text: '£1,497', label: 'after the webinar price ends' }]],
    ['### Pro Plan\nClearance price: £49\nRRP: £99', '£49', [{ kind: 'other', text: '£99', label: 'RRP' }]],
    ['### Pro Plan\nHalf price: £49\nNormal price: £99', '£49', [{ kind: 'other', text: '£99', label: 'Normal price' }]],
    ['### Pro Plan\nStudent price £8\nAdults: £12', '£8', [{ kind: 'other', text: '£12', label: 'Adults' }]],
  ] as const) assert.equal(ck(text, price, lines as unknown as Lines), null, text);
  // Rule 2: a one-off price with a label of its own beside a line with a period.
  assert.equal(ck('### Pro Plan\nSign-up fee: £30\nMonthly membership: £45 a month', '£30', [{ kind: 'other', text: '£45 a month', label: 'Monthly membership' }]), null);
  assert.equal(ck('### Pro Plan\nActivation fee £30\n£45 a month', '£30', [{ kind: 'other', text: '£45 a month' }]), null);
  // Still accepted: a cheaper special, a dearer line of another period, "only", "offer", a plan, the offer's own heading.
  assert.ok(ck('### Pro Plan\nOnly £85 or £8 a month on our plan', 'Only £85', [{ kind: 'other', text: '£8 a month', label: 'on our plan' }]));
  assert.ok(ck('### Pro Plan\n£85 a year only, or £8 a month', '£85 a year', [{ kind: 'other', text: '£8 a month' }]));
  assert.ok(ck('### Pro Plan\nOur offer: £85 a year or £8 a month', '£85 a year', [{ kind: 'other', text: '£8 a month' }]));
  assert.ok(ck('### Pro Plan\n£85 or £8 a month on our plan', '£85', [{ kind: 'other', text: '£8 a month', label: 'on our plan' }]), 'a one-off price with no label of its own beside a monthly one');
  assert.ok(ck('### Pro Plan\n£67 a month or £670 a year', '£67 a month', [{ kind: 'other', text: '£670 a year' }]));
  assert.ok(ck('### Pro Plan\n£1,497 or 3 x £525. Webinar price: £997', '£1,497', [{ kind: 'plan', text: '3 x £525', for: '£1,497' }, { kind: 'special', text: '£997', label: 'Webinar price' }]));
});

test('round 7, items 4 and 5: an offer with its own card reads its first amount there; a list item naming it inside another card does not; "The" aliases on the cited page', () => {
  const page = "## The Course\n£1,497\n• The Members' Room founders' price, £47 a month instead of £67, if you join within 30 days.\n## The Members' Room\n£67 a month, or £670 a year\nFounders' price: £47 a month, locked for as long as you stay.";
  const names = ['The Course', "The Members' Room"], room = [{ kind: 'other', text: '£670 a year' }, { kind: 'special', text: '£47 a month', label: "Founders' price" }];
  assert.ok(checkPricing([{ id: 'd', text: page }], names, 1, '£67 a month', room as never, 'd'), 'the own card sets the first amount');
  // Without a card of its own on the page, the list item is still where the first amount is read (as before).
  assert.equal(checkPricing([{ id: 'd', text: page.split('\n## The Members')[0]! + "\nThe Members' Room is £67 a month, or £670 a year." }], names, 1, '£67 a month', room as never, 'd'), null);
  // Item 5: a heading that is the name without its "The" is the offer's own card on its cited page, so a list item naming it
  // inside another listed offer's card no longer sets its first amount.
  const aliased = "## The Course\n£1,497\n• Members' Room founders' price, £47 a month instead of £67.\n## The Members' Room\n£67 a month, or £670 a year\nFounders' price: £47 a month.";
  assert.ok(checkPricing([{ id: 'd', text: aliased }], ['The Course', "Members' Room"], 1, '£67 a month', room as never, 'd'));
});

/** The owner's real pages, stored as the reader keeps them (with their action lines). */
async function mhpReal(given: (id: Record<string, string>) => Record<string, unknown>) {
  const ids = Object.fromEntries(MHP_REAL_PAGES.map((p, i) => [p.path, `doc${i + 1}`]));
  const documents = MHP_REAL_PAGES.map((p, i) => kdoc(`doc${i + 1}`, p.text, MHP_REAL_SITE + p.path, { title: p.title }, p.actionLines));
  return { ...(await make(documents, given(ids), MHP_REAL_SITE)), documents };
}

test('the owner\'s REAL pages, honest answer cited to the Join page: every price and line with its source; the one question left (The Members\' Room)', async () => {
  const { profile, documents } = await mhpReal(mhpRealJoinAnswer);
  const by = (n: string) => profile.offers.find((o) => o.name === n)!;
  assert.deepEqual(profile.offers.map((o) => [o.name, o.price]), [['Free cheat sheets', 'Free'], ['The Deal Desk', '£47'], ['Property Done Properly', '£1,497'], ["The Members' Room", null], ['One Lane Mentoring', '£3,997'], ['One Lane Private', '£25,000'], ['The Deal Partnership', '£7,500']]);
  assert.deepEqual(linesOf(by('Property Done Properly')), [['plan', '3 x £525', 'for £1,497'], ['special', 'Webinar price', '£997'], ['plan', '3 x £349', 'for £997']]);
  assert.deepEqual(linesOf(by('One Lane Mentoring')), [['plan', '6 x £699', '£4,194 in total', 'for £3,997']]);
  assert.deepEqual(linesOf(by('One Lane Private')), [['plan', '12 x £2,250', '£27,000 in total', 'for £25,000']]);
  const card = brandDnaCard(profile, documents);
  assert.deepEqual(card.offers.map((o) => o.priceSource?.quote ?? null), ['FREE CHEAT SHEETS', 'The Deal Desk … £47 once', '£1,497 once, or 3 x £525', null, '£3,997 or 6 x £699 (£4,194 in total)', '£25,000 or 12 x £2,250 (£27,000 in total)', 'The Deal Partnership, £7,500']);
  // The Members' Room: its structure (£67 a month, other £670 a year, founders' price £47 a month) is ACCEPTED by the check
  // (round 7, item 4: its own "## The Members' Room" card sets the first amount, not the course card's bullet). The
  // cross-source backstop still reads, beside the Room's name, the course card's "• The £997 credits in full against One Lane
  // Mentoring for 90 days." and, on the Mentoring page, "### Standard / £3,997 / or 6 monthly payments of £699 …" after "…the
  // course and the Members' Room included.", which no accepted structure claims. Item 6: it is asked 8eca59d's same-page
  // question on the Join page instead of the cross-source one. Clearing it needs a looser backstop (not done: see round 7 report).
  const checked = checkAllPricing(documents.map((d) => ({ id: d.id, text: d.text, actionLines: d.origin?.actionLines })), (mhpRealJoinAnswer({ '/': 'doc1', '/join/': 'doc2', '/mentoring/': 'doc3' }).offers as { name: string }[]).map((o) => o.name),
    (mhpRealJoinAnswer({ '/': 'doc1', '/join/': 'doc2', '/mentoring/': 'doc3' }).offers as { price: string; pricing?: unknown; sourceDocumentId: string }[]).map((o, i) => ({ self: i, price: o.price, proposed: o.pricing ? proposedLines(o.pricing) : null, citedId: o.sourceDocumentId })));
  assert.deepEqual(checked[3]!.lines.map((l) => [l.role, l.label, l.text]), [['other', null, '£670 a year'], ['special', "Founders' price", '£47 a month']]);
  assert.deepEqual(profile.conflicts.map((c) => [c.field, c.options?.map((o) => o.value)]), [["The Members' Room: price", ['£47 a month', '£67', '£997', '£1,497', '£349', '£1,047']]]);
});

test('the owner\'s REAL pages, honest answer cited to the Home table: two questions, each 8eca59d\'s same-page question', async () => {
  const { profile } = await mhpReal(mhpRealHomeAnswer);
  assert.deepEqual(profile.offers.map((o) => [o.name, o.price]), [['Free cheat sheets', 'Free'], ['The Deal Desk', '£47'], ['Property Done Properly', null], ["Members' Room", null], ['One Lane Mentoring', '£3,997'], ['One Lane Private', '£25,000'], ['Deal Partnership', '£7,500']]);
  // Property Done Properly: refused, as the model names the Room "Members' Room", the Join course card's bullet
  // "• The Members' Room founders' price, £47 a month instead of £67, …" is no Room anchor, so its £47 a month is unaccounted
  // in the course's own Join section. Members' Room: accepted, but the backstop reads the Join page's Room prices.
  assert.deepEqual(profile.conflicts.map((c) => [c.field, c.options?.map((o) => o.value)]), [['Property Done Properly: price', ['£1,497', '£997']], ["Members' Room: price", ['£67 a month', '£47']]]);
});

// ─── Performance (the review's B2 inputs) ────────────────────────────────────

test('performance: the review\'s slow inputs, with structures proposed, each finish under 2 seconds (best of three, measured alone)', () => {
  // Each case is timed on its own, three times, and the best run counts: a parallel test run's load does not hide a regression
  // or fail a fast one (8eca59d took 147 to 521 ms on these; round 6 measures are in its report).
  const time = (label: string, f: () => unknown) => { let best = Infinity; for (let k = 0; k < 3; k++) { const t0 = performance.now(); f(); best = Math.min(best, performance.now() - t0); } assert.ok(best < 2000, `${label}: ${Math.round(best)} ms`); };
  const full = (offers: unknown[], docs: { id: string; text: string; actionLines?: number[] }[]) => { strictProfileProblems(answer({ offers }) as unknown as ProfileFacts, docs); const r = repairProfileFacts(answer({ offers }) as unknown as ProfileFacts, docs); if (r) { const { offerNames: _n, ...k } = r.value; holdConflictedPrices(cleanProvenance(k, docs, true), docs); } };
  const plans12 = Array.from({ length: 12 }, (_, i) => ({ kind: 'plan', text: `3 x £${i + 1}`, for: '£9' }));
  const specials12 = Array.from({ length: 12 }, (_, i) => ({ kind: 'special', text: `£${i + 20}`, label: `Webinar ${'abcdefghijkl'[i]} price` }));
  const offer = (name: string, price: string, lines: unknown[]) => ({ name, description: '', price, url: null, sourceDocumentId: 'd0', pricing: { lines } });
  const many = (n: number, f: (i: number) => string) => Array.from({ length: n }, (_, i) => f(i)).join('');
  const row = (name: string) => `| ${name} | £9 or ${many(60, (i) => `3 x £${i % 12 + 1} (£${3 * (i % 12 + 1)} in total) or `)}3 x £1`;
  time('30 offers named Pro, 6,600 action lines "Pro £1"', () => full(Array.from({ length: 30 }, () => offer('Pro', '£1', plans12)), [{ id: 'd0', text: 'Pro £1\n'.repeat(6600), actionLines: Array.from({ length: 6600 }, (_, i) => i) }]));
  time('30 offers x 12 documents of ~190-plan rows, 12 proposed plans each', () => full(Array.from({ length: 30 }, (_, i) => offer(`www${i}`, '£9', plans12)), Array.from({ length: 12 }, (_, k) => ({ id: `d${k}`, text: Array.from({ length: 22 }, (_, i) => row(`www${i}`)).join('\n').slice(0, 59990) }))));
  time('30 offers, 49 anchors each, 12 documents', () => full(Array.from({ length: 30 }, (_, i) => offer(`www${i}`, '£9', specials12)), Array.from({ length: 12 }, (_, k) => ({ id: `d${k}`, text: many(1470, (i) => `# www${i % 30}\n£9 £20 £21 £22\n`).slice(0, 59990) }))));
});
