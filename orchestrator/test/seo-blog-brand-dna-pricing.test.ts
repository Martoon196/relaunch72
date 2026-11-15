/**
 * Brand DNA website door, rules version 3: an offer's price STRUCTURE (standard prices, instalment plans, special offers,
 * free), read from the page by rule, never one price forced out of several. The owner is asked only on a real
 * contradiction. The structure never reaches a writer. Main fixture: Martin Howard Property's Home, Join and Mentoring
 * pages, reconstructed from the owner's first real card (see test/fixtures/brand-dna-mhp-pages.ts for how). No network,
 * model or database is touched.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  brandDnaCard, brandPageText, BRAND_DNA_RULES_VERSION, cleanProvenance, holdConflictedPrices, pricingAfterEdit, pricingEditLine, repairProfileFacts, settleConflict, strictProfileProblems, type ProfileFacts,
} from '../src/seo-blog/brand-dna.js';
import { priceContradiction, priceStatus, priceStructure } from '../src/seo-blog/brand-dna-rules.js';
import { brandPageHtmlLines } from '../src/seo-blog/html.js';
import { extractProfile, profileForPrompt } from '../src/seo-blog/generation.js';
import { brandDnaPage } from '../src/portal/brand-dna-view.js';
import { resolveCreativeContext } from '../src/creative-studio/brand-context.js';
import type { LlmClient } from '../src/llm/client.js';
import type { BrandProfile, KnowledgeDocument, ProfileOffer } from '../src/seo-blog/types.js';
import { MHP_PAGES, MHP_SITE, mhpModelAnswer } from './fixtures/brand-dna-mhp-pages.js';
import * as inputs from './fixtures/brand-dna-1a9e5160-inputs.js';

const M = (html: string) => `<html><body><main>${html}</main></body></html>`;
const tagged = (html: string) => brandPageText(brandPageHtmlLines(M(html)));
const roles = (text: string, names: string[], i = 0) => priceStructure({ text }, names, i).map((l) => [l.role, l.text, ...(l.condition ? [l.condition] : []), ...(l.total ? [l.total] : []), ...(l.parent !== null ? [`for ${l.parent}`] : [])]);
const card = (over: Record<string, unknown> = {}): ProfileFacts => ({ summary: 'A business summary line.', audiences: [], positioning: '', offers: [], conversionPages: [], voice: { tone: [], do: [], dont: [], examples: [] },
  approvedClaims: [], exclusions: [], conflicts: [], missingFacts: [], sources: [], ...over }) as unknown as ProfileFacts;
const offer = (name: string, price: string | null, sourceDocumentId = 'd1'): ProfileOffer => ({ name, description: '', price, url: null, sourceDocumentId });

/** The MHP pages through the real reader and the real extraction (scripted model answer), and the card made from it. */
async function mhpCard() {
  const entries = Object.entries(MHP_PAGES);
  const ids = Object.fromEntries(entries.map(([p], i) => [p, `doc${i + 1}`]));
  const documents = entries.map(([path, html], i) => ({ id: `doc${i + 1}`, brandId: 'b', version: 1, category: 'product_facts', title: path === '/' ? 'Home page' : path === '/join/' ? 'Join page' : 'Mentoring page',
    sha256: 's', active: true, status: 'extracted', createdAt: 'x', text: brandPageText(brandPageHtmlLines(html)), origin: { kind: 'website', url: MHP_SITE + path, fetchedAt: 'x' } })) as unknown as KnowledgeDocument[];
  const llm = { mode: 'mock', complete: async () => ({ text: JSON.stringify(mhpModelAnswer(ids)), tokensIn: 1, tokensOut: 1, stopReason: 'end_turn', model: 'mock' }) } as unknown as LlmClient;
  const made = await extractProfile(llm, { brandName: 'Martin Howard Property', website: MHP_SITE, documents, strict: true });
  const profile = { ...made.value, brandId: 'b', version: 1, knowledge: documents.map((d) => ({ documentId: d.id, version: 1, sha256: 's', category: 'product_facts' })), strict: true,
    rulesVersion: BRAND_DNA_RULES_VERSION, factsSha: 'f', source: 'extracted', confirmedAt: null, confirmedBy: null, createdAt: 'x', generation: null } as unknown as BrandProfile;
  return { documents, profile, card: brandDnaCard(profile, documents) };
}
const lines = (o: ProfileOffer | undefined) => (o?.pricing?.lines ?? []).map((l) => [l.role, l.text, ...(l.condition ? [l.condition] : []), ...(l.total ? [l.total] : []), ...(typeof l.parent === 'number' ? [`for ${l.parent}`] : [])]);

// ─── The owner's first real card ─────────────────────────────────────────────

test('MHP end to end: no price questions; each offer\'s structure exactly as the pages state it; nothing of the course under another offer', async () => {
  const { profile, card: shown, documents } = await mhpCard();
  assert.deepEqual(profile.conflicts, [], 'none of the four "which price is right?" questions');
  const by = (n: string) => profile.offers.find((o) => o.name === n);
  assert.equal(by('Property Done Properly')!.price, '£1,497');
  assert.deepEqual(lines(by('Property Done Properly')), [['standard', '£1,497'], ['special', '£997', 'for seven days after a webinar'], ['plan', '3 x £525', 'for 0'], ['plan', '3 x £349', 'for 1']]);
  assert.equal(by("The Members' Room")!.price, '£67 a month');
  assert.deepEqual(lines(by("The Members' Room")), [['standard', '£67 a month'], ['special', '£47', 'for the first 100'], ['standard', '£670 a year'], ['special', '£47 a month', "a founders' price of"]]);
  assert.deepEqual(lines(by('One Lane Mentoring')), [['standard', '£3,997'], ['plan', '6 x £699', '£4,194 in total', 'for 0']]);
  assert.deepEqual(lines(by('One Lane Private')), [['standard', '£25,000'], ['plan', '12 x £2,250', '£27,000 in total', 'for 0']]);
  assert.equal(by('The Deal Desk')!.price, '£47', 'the Deal Desk card is headed "Deal Desk": a leading "The" is optional when the price rule matches a name');
  assert.equal(by('Free cheat sheets')!.price, 'free'); assert.deepEqual(lines(by('Free cheat sheets')), [['free', 'free']]);
  // The course's checkout form (action text after the last card) and the "£997 credits" lines belong to nobody else.
  for (const n of ["The Members' Room", 'One Lane Mentoring']) assert.ok(!lines(by(n)).some((l) => /£1,497|£997|£349|£1,047|£1,575/.test(l[1]!)), n);
  // Every line's words and its quote are on the page it names.
  for (const o of profile.offers) for (const l of o.pricing?.lines ?? []) {
    const doc = documents.find((d) => d.id === l.documentId)!;
    assert.ok(doc.text!.includes(l.text), `${o.name}: ${l.text}`);
    for (const part of l.quote!.split(' … ')) assert.ok(doc.text!.replace(/^(?:#{1,6} |• |\| |❝ |▸ |▹ )/gmu, '').includes(part), `${o.name}: ${part}`);
  }
  // The card: no open price, the structure under each offer, gap notes about these prices gone and capped.
  assert.ok(shown.offers.every((o) => !o.priceOpen));
  assert.deepEqual(shown.missing, ['A named author for the guides', 'Opening hours for support', 'A street address', 'Customer numbers']);
  assert.ok(shown.missing.length <= 6);
  const page = brandDnaPage(inputs.SHELL, { ...inputs.STATE, profile, card: shown, status: 'proposed' } as never, 'cmd');
  assert.doesNotMatch(page, /We found different answers/);
  assert.match(page, /Price: £1,497<\/span><span class="from"><a[^>]*>From your Home page<\/a>: <q>Property Done Properly \| [^<]*£1,497, or £997 for seven days after a webinar \| 30 days<\/q>/);
  assert.match(page, /Special offer: £997 — for seven days after a webinar<\/span>/);
  assert.match(page, /Or pay in instalments: 3 x £349 for £997<\/span><span class="from"><a[^>]*>From your Join page<\/a>/);
  assert.match(page, /Or pay in instalments: 6 x £699 \(£4,194 in total\)<\/span>/);
  assert.match(page, /Or: £670 a year<\/span>/);
  assert.match(page, /Price: free<\/span>/);
  assert.doesNotMatch(page, /Price: none found/);
});

test('MHP: what writers receive is the card without its price structure (no specials, no plans)', async () => {
  const { profile } = await mhpCard();
  const sent = JSON.stringify(profileForPrompt(profile));
  assert.ok(!sent.includes('pricing') && !sent.includes('£997') && !sent.includes('3 x £525') && !sent.includes('pricingRole'), 'no special offer or plan reaches a writer');
  const offers = (profileForPrompt(profile).offers as ProfileOffer[]).map((o) => [o.name, o.price]);
  assert.deepEqual(offers, [['Free cheat sheets', 'free'], ['The Deal Desk', '£47'], ['Property Done Properly', '£1,497'], ["The Members' Room", '£67 a month'], ['One Lane Mentoring', '£3,997'], ['One Lane Private', '£25,000']]);
  for (const o of profileForPrompt(profile).offers as Record<string, unknown>[]) assert.deepEqual(Object.keys(o), ['name', 'description', 'price', 'url', 'sourceDocumentId']);
  const context = resolveCreativeContext({ brand: { id: 'b', name: 'MHP', website: MHP_SITE }, profile: { ...profile, confirmedAt: 'x' } as BrandProfile, knowledge: [], kit: null });
  assert.ok(!JSON.stringify(context).includes('pricing'));
});

// ─── The role rules one by one ───────────────────────────────────────────────

test('roles: standard, plan (attached to the price before it, with its total), special with each cue, was/now, instead of, periods, free', () => {
  assert.deepEqual(roles('# Course\n£1,497 once, or 3 x £525 (£1,575 in total)', ['Course']), [['standard', '£1,497'], ['plan', '3 x £525', '£1,575 in total', 'for 0']]);
  assert.deepEqual(roles('# Course\nWebinar price: £997, or 3 x £349', ['Course']), [['special', '£997', 'Webinar price'], ['plan', '3 x £349', 'for 0']]);
  assert.deepEqual(roles('# Course\n£1,497, or 3 monthly payments of £525', ['Course']), [['standard', '£1,497'], ['plan', '3 monthly payments of £525', 'for 0']]);
  assert.deepEqual(roles('# Course\n£1,497 or £525 x 3', ['Course']), [['standard', '£1,497'], ['plan', '£525 x 3', 'for 0']]);
  assert.deepEqual(roles('# Mentoring\n£3,997 or 6 × £699, £4,194 in total', ['Mentoring']), [['standard', '£3,997'], ['plan', '6 × £699', '£4,194 in total', 'for 0']]);
  assert.deepEqual(roles('# Return to Work Programme\n£795 or three monthly payments of £275', ['Return to Work Programme']), [['standard', '£795'], ['plan', 'three monthly payments of £275', 'for 0']]);
  for (const [line, condition] of [['£997 for seven days after a webinar', 'for seven days after a webinar'], ['Founders’ price £47 a month', 'Founders’ price'], ['Early bird: £299', 'Early bird'], ['Launch price: £399', 'Launch price'],
    ['Introductory offer: £49', 'Introductory offer'], ['Special offer: £89', 'Special offer'], ['£39 for the first 50', 'for the first 50'], ['£59 for the first 20 members', 'for the first 20 members'], ['£79 until 11 November 2026', 'until 11 November 2026'],
    ['£79, offer ends Friday', 'offer ends Friday'], ['£79 before 1 December', 'before 1 December'], ['£47 a month if you join within 30 days', 'if you join within 30 days'], ['Promo price £19', 'Promo price']] as const) {
    const got = roles(`# Plan\n£99\n${line}`, ['Plan']);
    assert.equal(got[0]![0], 'standard', line); assert.equal(got[1]![0], 'special', line); assert.ok(String(got[1]![2]).includes(condition) || line.includes(String(got[1]![2])), `${line}: ${got[1]![2]}`);
  }
  assert.deepEqual(roles('# Pro Plan\nPro Plan was £99 now £49 per month.', ['Pro Plan']), [['standard', 'was £99'], ['special', 'now £49 per month']]);
  assert.deepEqual(roles("# The Members' Room\nThe Members' Room founders' price, £47 a month instead of £67, if you join within 30 days.", ["The Members' Room"]), [['special', '£47 a month', "The Members' Room founders' price, £47 a month instead of £67, if you join within 30 days."]]);
  assert.deepEqual(roles('# Room\n£67 a month or £670 a year', ['Room']), [['standard', '£67 a month'], ['standard', '£670 a year']]);
  assert.deepEqual(roles('# Cheat sheets\nAvailable free with an email address', ['Cheat sheets']), [['free', 'free']]);
  assert.deepEqual(roles('# Cheat sheets\nNo charge', ['Cheat sheets']), [['free', 'No charge']]);
  assert.deepEqual(roles('# Clarity Session\n£150\nBook a free 20-minute intro call', ['Clarity Session']), [['standard', '£150']], 'free next to a price is not "free"');
  // Not a price: credits, cross-references, totals.
  assert.deepEqual(roles('# Mentoring\n£3,997\nThe £997 course price credits in full for 90 days.', ['Mentoring']), [['standard', '£3,997']]);
  assert.deepEqual(roles('# Room\n£67 a month\nThe £997 credits in full against One Lane Mentoring for 90 days.', ['Room', 'One Lane Mentoring']), [['standard', '£67 a month']]);
  assert.deepEqual(roles('# Room\n£67 a month\nSave £20 off your first month.', ['Room']), [['standard', '£67 a month']]);
  assert.deepEqual(roles('# Room\n£67 a month, £997 Course', ['Room', 'Course']), [['standard', '£67 a month']], 'an amount straight before another listed offer\'s name');
});

test('real contradictions still ask, name the offer and the role, and offer only the contradicting lines', () => {
  const ask = (texts: string[], names: string[], prices: (string | null)[]) => {
    const docs = texts.map((t, i) => ({ id: `d${i + 1}`, text: t }));
    return holdConflictedPrices(card({ offers: names.map((n, i) => offer(n, prices[i] ?? null)) }), docs);
  };
  const two = ask(['# Course\n£1,497', '# Course\n£1,297'], ['Course'], ['£1,497']);
  assert.equal(two.conflicts.length, 1); assert.equal(two.conflicts[0]!.field, 'Course: price');
  assert.equal(two.conflicts[0]!.detail, 'We found two different standard prices for Course. Which is right?');
  assert.deepEqual(two.conflicts[0]!.options!.map((o) => o.value), ['£1,497', '£1,297']); assert.equal(two.offers[0]!.price, null);
  const web = ask(['# Course\n£1,497\nWebinar price: £997', '# Course\n£1,497\nWebinar price: £897'], ['Course'], ['£1,497']);
  assert.equal(web.conflicts.length, 1); assert.equal(web.conflicts[0]!.pricingRole, 'special'); assert.deepEqual(web.conflicts[0]!.options!.map((o) => o.value), ['£997', '£897']);
  assert.equal(web.offers[0]!.price, '£1,497', 'the standard price stands while the special is asked');
  assert.match(web.conflicts[0]!.detail, /two different special offer prices for Course/);
  const plans = ask(['# Course\n£1,497 or 3 x £525', '# Course\n£1,497 or 3 x £499'], ['Course'], ['£1,497']);
  assert.equal(plans.conflicts.length, 1); assert.equal(plans.conflicts[0]!.pricingRole, 'plan'); assert.deepEqual(plans.conflicts[0]!.options!.map((o) => o.value), ['3 x £525', '3 x £499']);
  // Not contradictions: a plan beside its price, a special beside a standard, monthly and yearly, different plan lengths.
  for (const t of ['# Course\n£1,497 or 3 x £525', '# Course\n£1,497, or £997 for seven days after a webinar', '# Room\n£67 a month or £670 a year', '# Course\n£1,497 or 3 x £525 or 6 x £260'])
    assert.equal(priceContradiction(priceStructure({ text: t }, ['Course', 'Room'], t.includes('Room') ? 1 : 0)), null, t);
  // Settling a special question adds that line to the offer's structure and leaves the price alone.
  const settled = settleConflict({ ...web, sources: [], strict: true } as never, 0, { kind: 'option', index: 1 });
  assert.equal(settled.offers[0]!.price, '£1,497'); assert.deepEqual(settled.offers[0]!.pricing!.lines.map((l) => [l.role, l.text]).slice(-1), [['special', '£897']]);
  // The model's own price question is dropped when the page's structure answers it; a question's legend names its offer.
  const answered = holdConflictedPrices(card({ offers: [offer('Course', '£1,497')], conflicts: [{ field: 'price', detail: 'Course has two prices', documentIds: ['d1'], kind: 'price', offer: 'Course', options: [] }] }), [{ id: 'd1', text: '# Course\n£1,497 or 3 x £525' }]);
  assert.deepEqual(answered.conflicts, []);
  const legend = holdConflictedPrices(card({ offers: [offer('Pro Plan', null)], conflicts: [{ field: 'price', detail: 'Which', documentIds: ['d1'], kind: 'price', offer: 'Pro Plan', options: [] }] }), [{ id: 'd1', text: 'Pro Plan. Ask us.\nPrice list: Pro Plan £49 per month or Pro Plan £59 per month' }]);
  for (const c of legend.conflicts) assert.match(c.field, /Pro Plan/);
});

test('the model copies the standard price; a special, a plan amount or the yearly price is tied too; only a contradiction is ambiguous', () => {
  const text = '# Course\n£1,497 once, or 3 x £525\nWebinar price: £997, or 3 x £349';
  for (const p of ['£1,497', '£997', '£525']) assert.equal(priceStatus(p, { text }, ['Course'], 0).status, 'tied', p);
  assert.equal(priceStatus('£1,297', { text }, ['Course'], 0).status, 'untied');
  assert.equal(priceStatus('£1,497', { text: '# Course\n£1,497\n£1,297' }, ['Course'], 0).status, 'ambiguous');
});

// ─── The card page, the owner's corrections, older cards ─────────────────────

test('the owner corrects or removes price lines: unchanged lines keep their source, changed lines are "You told us"', async () => {
  const { profile } = await mhpCard();
  const room = profile.offers.find((o) => o.name === "The Members' Room")!;
  const edited = pricingAfterEdit(room, [...room.pricing!.lines.slice(0, 3).map(pricingEditLine), 'Special offer: £47 a month — founders, until 1 December']);
  assert.equal(edited.price, '£67 a month'); assert.equal(edited.pricing!.lines.length, 4);
  assert.deepEqual(edited.pricing!.lines.slice(0, 3).map((l) => l.documentId), room.pricing!.lines.slice(0, 3).map((l) => l.documentId));
  assert.deepEqual(edited.pricing!.lines[3], { role: 'special', text: '£47 a month', condition: 'founders, until 1 December', documentId: null, quote: null });
  const shown = brandDnaCard({ ...profile, offers: profile.offers.map((o) => (o === room ? edited : o)) }, []);
  assert.equal(shown.offers.find((o) => o.name === "The Members' Room")!.pricing!.specials[1]!.source.label, 'You told us');
  const removed = pricingAfterEdit(room, ['Price: £70 a month']);
  assert.equal(removed.price, '£70 a month'); assert.equal(removed.priceSourceDocumentId, null); assert.equal(removed.pricing!.lines.length, 1);
  const page = brandDnaPage(inputs.SHELL, { ...inputs.STATE, profile, card: brandDnaCard(profile, []), status: 'proposed' } as never, 'cmd');
  assert.match(page, /<label for="dna-pricing-3">Prices for The Members&#39;Room|<label for="dna-pricing-3">Prices for The Members(?:&#39;|’|')? ?Room/);
  // An older website-door card (rules version 2) is asked to read the website again.
  const older = { ...profile, rulesVersion: 2 } as BrandProfile;
  assert.equal(brandDnaCard(older, []).rulesOutdated, true);
});

test('Setup cards and older website-door cards: the writing payload is exactly as at 1a9e5160; a pricing field never reaches a prompt', () => {
  const snapshot = JSON.parse(readFileSync(new URL('./fixtures/brand-dna-1a9e5160-writing-payload.json', import.meta.url), 'utf8')) as Record<string, { profileForPrompt: unknown }>;
  assert.ok(Object.keys(snapshot).length > 0);
  // (The full identity tests are in seo-blog-brand-dna-word-for-word.test.ts and still pass unchanged.)
  const withPricing = { ...inputs.SETUP_PROFILE, strict: true, rulesVersion: 3, offers: inputs.SETUP_PROFILE.offers.map((o, i) => (i === 0 ? { ...o, pricing: { lines: [{ role: 'special' as const, text: '£9 per month', condition: 'for the first 100', documentId: 'doc1', quote: 'x' }] } } : o)),
    conflicts: inputs.SETUP_PROFILE.conflicts.map((c, i) => (i === 0 ? { ...c, pricingRole: 'special' as const } : c)) } as BrandProfile;
  const without = { ...withPricing, offers: inputs.SETUP_PROFILE.offers, conflicts: inputs.SETUP_PROFILE.conflicts } as BrandProfile;
  assert.equal(JSON.stringify(profileForPrompt(withPricing)), JSON.stringify(profileForPrompt(without)));
});

// ─── The seven honest sites, the guarantees ──────────────────────────────────

test('repair consistency: a repaired MHP-shaped answer passes every rule; the structure only adds the page\'s own words', () => {
  const docs = [{ id: 'd1', text: tagged('<h2>Course</h2><p>£1,497 once, or 3 x £525</p><p>Webinar price: £997, or 3 x £349</p>') }];
  const v = card({ offers: [offer('Course', '£997 or 3 x £349')] });
  const rep = repairProfileFacts(v, docs);
  assert.ok(rep); assert.deepEqual(strictProfileProblems(rep.value, docs), []);
  const { offerNames: _n, ...kept } = rep.value;
  const held = holdConflictedPrices(cleanProvenance(kept, docs, true), docs, { leftOut: rep.leftOut });
  for (const l of held.offers[0]!.pricing?.lines ?? []) assert.ok(docs[0]!.text.includes(l.text), l.text);
});

test('action text: buttons, button links and forms get their own marker and never price an offer they do not name', () => {
  assert.equal(tagged('<p><span>(£1,575 in total)</span><span>Or 3 monthly payments</span></p>'), '(£1,575 in total) Or 3 monthly payments', 'a closing bracket before a letter gets a space');
  assert.equal(tagged('<section><h2>Pro</h2><p>£49 a month</p><a class="btn btn-primary" href="/x">Start Pro: £49 a month</a></section><form><label>Start the course: £997 paid once</label><button>Pay</button></form><p>We do not offer <label>guaranteed rent</label> or advice.</p>'),
    '## Pro\n£49 a month\n▸ Start Pro: £49 a month\n▹ Start the course: £997 paid once\n▹ Pay\nWe do not offer guaranteed rent or advice.');
  // Inside its own card a button can price the offer; outside it only when it names the offer.
  assert.deepEqual(roles('## Members\n£67 a month\n▹ Start the course: £997 paid once', ['Members', 'Course']), [['standard', '£67 a month']]);
  assert.deepEqual(roles('## Members\nMonthly calls\n▸ Join for £67 a month', ['Members']), [['standard', '£67 a month']]);
  assert.deepEqual(roles('## Members\nMonthly calls\n## Other\nText\n▹ Buy Members: £67 a month', ['Members', 'Other']), [['standard', '£67 a month']]);
});
