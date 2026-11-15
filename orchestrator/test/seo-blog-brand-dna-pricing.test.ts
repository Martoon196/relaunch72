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
type Lines = { kind: string; text: string; label?: string | null; for?: string | null; total?: string | null }[];
/** One page (html, or stored text), some offers [name, price, proposed lines?], as the review's harness ran them. */
async function quick(src: string | { html: string; raw?: boolean }, offers: (readonly [string, string | null] | readonly [string, string | null, Lines | undefined])[], extra: Record<string, unknown> = {}, noPricing = false) {
  const text = typeof src === 'string' ? src : tagged(src.html, src.raw === true);
  const { docs, ...rest } = extra as { docs?: KnowledgeDocument[] };
  return make([kdoc('d1', text, 'https://x.example/pricing'), ...(docs ?? [])], { offers: offers.map(([name, price, lines]) => ({ name, description: '', price, url: null, sourceDocumentId: 'd1', ...(lines && !noPricing ? { pricing: { lines } } : {}) })), ...rest });
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

async function mhp(given: (id: Record<string, string>) => Record<string, unknown>) {
  const entries = Object.entries(MHP_PAGES);
  const ids = Object.fromEntries(entries.map(([p], i) => [p, `doc${i + 1}`]));
  const documents = entries.map(([path, html], i) => kdoc(`doc${i + 1}`, brandPageText(brandPageHtmlLines(html)), MHP_SITE + path, { title: path === '/' ? 'Home page' : path === '/join/' ? 'Join page' : 'Mentoring page' }));
  return { ...(await make(documents, given(ids), MHP_SITE)), documents };
}
const linesOf = (o: ProfileOffer | undefined) => (o?.pricing?.lines ?? []).map((l) => [l.role, ...(l.label ? [l.label] : []), l.text, ...(l.total ? [l.total] : []), ...(l.for ? [`for ${l.for}`] : [])]);

test('MHP, honest structured answer: what the check can confirm is shown; the rest asks exactly as 8eca59d', async () => {
  const { profile, documents } = await mhp(mhpStructuredAnswer);
  const by = (n: string) => profile.offers.find((o) => o.name === n);
  assert.deepEqual(linesOf(by('One Lane Mentoring')), [['plan', '6 x £699', '£4,194 in total', 'for £3,997']]);
  assert.deepEqual(linesOf(by('One Lane Private')), [['plan', '12 x £2,250', '£27,000 in total', 'for £25,000']]);
  assert.equal(by('Free cheat sheets')!.price, 'Free');
  // Property Done Properly: the Join card's "Webinar price:" line ends its card at 8eca59d, so the proposed webinar lines
  // are not in the run: refused, and asked as before. The Members' Room: the Mentoring page's "The Members' Room is
  // included…" paragraph starts a card for it (8eca59d), holding £3,997: refused, and asked as before.
  assert.equal(by('Property Done Properly')!.price, null); assert.equal(by("The Members' Room")!.price, null);
  assert.deepEqual(profile.conflicts.map((c) => c.offer), ['Property Done Properly', "The Members' Room"]);
  assert.equal(by('The Deal Desk')!.price, null, 'the model left it empty: nothing is filled');
  // The card: each checked price shows where it was found, with its line.
  const shown = brandDnaCard(profile, documents);
  for (const n of ['One Lane Mentoring', 'One Lane Private', 'Free cheat sheets']) { const o = shown.offers.find((x) => x.name === n)!; assert.ok(o.priceSource?.quote, n); }
  assert.equal(shown.offers.find((x) => x.name === 'Free cheat sheets')!.priceSource!.quote, 'Free cheat sheets | Five one-page guides to the numbers | Available free with an email address | None needed');
  const page = brandDnaPage(inputs.SHELL, { ...inputs.STATE, profile, card: shown, status: 'proposed' } as never, 'cmd');
  assert.match(page, /Or pay in instalments: 6 x £699 \(£4,194 in total\) for £3,997<\/span><span class="from"><a[^>]*>From your Join page<\/a>: <q>£3,997 or 6 x £699 \(£4,194 in total\)<\/q>/);
  // Writers receive the model's checked prices and nothing of the structure.
  const sent = profileForPrompt(profile);
  assert.ok(!JSON.stringify(sent).includes('pricing') && !JSON.stringify(sent).includes('6 x £699'));
  for (const o of sent.offers as Record<string, unknown>[]) assert.deepEqual(Object.keys(o), ['name', 'description', 'price', 'url', 'sourceDocumentId']);
  assert.ok(!JSON.stringify(resolveCreativeContext({ brand: { id: 'b', name: 'MHP', website: MHP_SITE }, profile: { ...profile, confirmedAt: 'x' } as BrandProfile, knowledge: [], kit: null })).includes('pricing'));
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
  assert.equal(brandDnaCard(structured.profile, [kdoc('d1', tagged('<h3>Valuation</h3><p>Free</p>'), 'https://x.example/pricing')]).offers[0]!.priceSource!.quote, 'Free');
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

test('B8, reader: a button inside a sentence stays inline; whole-line controls are marked; the stored words are 8eca59d\'s', () => {
  assert.equal(tagged('<p>Unlike other agents, <button>we</button> charge hidden fees to every landlord.</p>'), 'Unlike other agents, we charge hidden fees to every landlord.');
  assert.equal(tagged('<section><h3>Pro</h3><p>£49</p><a class="btn btn-primary">Start Pro: £49</a></section>'), '### Pro\n£49\n▸ Start Pro: £49');
  assert.equal(tagged('<p>(£1,575 in total)<span>Or 3 payments</span></p>'), '(£1,575 in total)Or 3 payments', 'no new spacing rule: the stored words are as at 8eca59d');
  assert.doesNotThrow(() => brandPageHtmlLines(`<html><body><main><p class="${'a '.repeat(130000)}">x</p></main></body></html>`));
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
    const docs = Object.entries(s.pages).map(([path, html], i) => kdoc(`doc${i + 1}`, tagged(html, s.raw === true), s.website + path));
    const ids = Object.fromEntries(Object.keys(s.pages).map((p, i) => [p, `doc${i + 1}`]));
    const given = s.answer(ids) as { offers: { name: string; price: string | null; pricing?: { lines: Lines } }[] };
    if (/COACH/.test(s.name)) given.offers = given.offers.map((o) => (o.name === 'Return to Work Programme' ? { ...o, price: '£795', pricing: { lines: [{ kind: 'plan', text: 'three monthly payments of £275', for: '£795' }] } } : o));
    tally(s.name, await make(docs, given, s.website), given.offers);
  }
  for (const s of EXTRA_SITES) {
    const r = await make([kdoc('d1', tagged(s.html), 'https://x.example/pricing')], { offers: s.offers.map((o) => ({ ...o, description: '', url: null, sourceDocumentId: 'd1' })) });
    tally(s.name, r, s.offers);
    assert.deepEqual(r.profile.conflicts.map((c) => c.offer), s.asks ?? [], s.name);
  }
  t.diagnostic(`TOTAL | prices kept ${total.kept}/${total.priced} | lines accepted ${total.accepted}/${total.proposed} | questions ${total.questions} | wrong price ${total.wrongPrice} | wrong role ${total.wrongRole}`);
});

// ─── Performance (the review's B2 inputs) ────────────────────────────────────

test('performance: the review\'s slow inputs, with structures proposed, each finish under 1 second', () => {
  const time = (label: string, f: () => unknown) => { const t0 = Date.now(); f(); const ms = Date.now() - t0; assert.ok(ms < 1000, `${label}: ${ms} ms`); };
  const full = (offers: unknown[], docs: { id: string; text: string }[]) => { strictProfileProblems(answer({ offers }) as unknown as ProfileFacts, docs); const r = repairProfileFacts(answer({ offers }) as unknown as ProfileFacts, docs); if (r) { const { offerNames: _n, ...k } = r.value; holdConflictedPrices(cleanProvenance(k, docs, true), docs); } };
  const plans12 = Array.from({ length: 12 }, (_, i) => ({ kind: 'plan', text: `3 x £${i + 1}`, for: '£9' }));
  const specials12 = Array.from({ length: 12 }, (_, i) => ({ kind: 'special', text: `£${i + 20}`, label: `Webinar ${'abcdefghijkl'[i]} price` }));
  const offer = (name: string, price: string, lines: unknown[]) => ({ name, description: '', price, url: null, sourceDocumentId: 'd0', pricing: { lines } });
  const many = (n: number, f: (i: number) => string) => Array.from({ length: n }, (_, i) => f(i)).join('');
  const row = (name: string) => `| ${name} | £9 or ${many(60, (i) => `3 x £${i % 12 + 1} (£${3 * (i % 12 + 1)} in total) or `)}3 x £1`;
  time('30 offers named Pro, 6,600 action lines "▸ Pro £1"', () => full(Array.from({ length: 30 }, () => offer('Pro', '£1', plans12)), [{ id: 'd0', text: '▸ Pro £1\n'.repeat(6600) }]));
  time('30 offers x 12 documents of ~190-plan rows, 12 proposed plans each', () => full(Array.from({ length: 30 }, (_, i) => offer(`www${i}`, '£9', plans12)), Array.from({ length: 12 }, (_, k) => ({ id: `d${k}`, text: Array.from({ length: 22 }, (_, i) => row(`www${i}`)).join('\n').slice(0, 59990) }))));
  time('30 offers, 49 anchors each, 12 documents', () => full(Array.from({ length: 30 }, (_, i) => offer(`www${i}`, '£9', specials12)), Array.from({ length: 12 }, (_, k) => ({ id: `d${k}`, text: many(1470, (i) => `# www${i % 30}\n£9 £20 £21 £22\n`).slice(0, 59990) }))));
});
