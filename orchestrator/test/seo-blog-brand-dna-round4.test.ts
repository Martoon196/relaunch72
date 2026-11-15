/**
 * Brand DNA website door, round 4: the page reader is separate from `parseHtmlPage` and linear; block elements never glue
 * words together; Setup cards, settling and uploaded documents are exactly as at 1a9e5160 (snapshot taken from a checkout
 * of 1a9e5160 over test/fixtures/brand-dna-1a9e5160-inputs.ts); customer words, price units, hints, the lines shown
 * beside a price, card starts, list items, shared-host links, tables and the seven honest sites. No network, model or
 * database is touched.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  brandDnaCard, brandPageText, BRAND_DNA_RULES_VERSION, cleanProvenance, holdConflictedPrices, priceLineSources, repairProfileFacts, strictProfileProblems, type ProfileFacts,
} from '../src/seo-blog/brand-dna.js';
import { audienceUnit, offerNameProblem, priceCandidates, priceStatus, withoutMarkers } from '../src/seo-blog/brand-dna-rules.js';
import { BRAND_HTML_LIMIT, brandPageHtmlLines, brandPageLines, parseHtmlPage } from '../src/seo-blog/html.js';
import { buildInventory } from '../src/seo-blog/inventory.js';
import { extractProfile } from '../src/seo-blog/generation.js';
import { buildAcquisitionEvidence } from '../src/seo-blog/acquisition-evidence.js';
import { brandDnaPage } from '../src/portal/brand-dna-view.js';
import type { LlmClient } from '../src/llm/client.js';
import type { BrandProfile, KnowledgeDocument, ProfileOffer } from '../src/seo-blog/types.js';
import * as inputs from './fixtures/brand-dna-1a9e5160-inputs.js';
import { sites } from './fixtures/brand-dna-honest-sites.js';

const D = (id: string, text: string, page?: string) => ({ id, text, ...(page ? { page } : {}) });
const card = (over: Record<string, unknown> = {}): ProfileFacts => ({ summary: 'A business summary line.', audiences: [], positioning: '', offers: [], conversionPages: [], voice: { tone: [], do: [], dont: [], examples: [] },
  approvedClaims: [], exclusions: [], conflicts: [], missingFacts: [], sources: [], ...over }) as unknown as ProfileFacts;
const offer = (name: string, price: string | null, sourceDocumentId = 'd1'): ProfileOffer => ({ name, description: '', price, url: null, sourceDocumentId });
const claim = (value: string, documentId = 'd1', quote = value) => ({ field: 'claim' as const, value, documentId, quote });
const aud = (value: string, documentId = 'd1', quote = value) => ({ field: 'audience' as const, value, documentId, quote });
const wrap = (html: string) => `<html><head><title>x</title></head><body><header><nav>Home Fees About Contact</nav></header><main>${html}</main><footer>(c)</footer></body></html>`;
const tagged = (html: string, raw = false) => brandPageText(brandPageHtmlLines(raw ? html : wrap(html)));
const ctx = { website: 'https://x.example' };
function door(value: ProfileFacts, docs: { id: string; text: string; page?: string }[], c: { website?: string } = ctx) {
  const problems = strictProfileProblems(value, docs, c);
  const rep = repairProfileFacts(value, docs, c);
  assert.ok(rep, 'repairable');
  assert.deepEqual(strictProfileProblems(rep.value, docs, c), [], 'a repaired card passes every rule');
  const { offerNames: _n, ...kept } = rep.value;
  return { problems, rep, final: holdConflictedPrices(cleanProvenance(kept, docs, true), docs) };
}
/** One page through the reader and the door: which claims stay and what each offer's price becomes. */
function onPage(html: string, o: { claims?: string[]; offers?: [string, string | null][]; auds?: [string, string][] }) {
  const text = tagged(html); const docs = [D('d1', text, 'https://x.example/')];
  const r = door(card({ approvedClaims: o.claims ?? [], audiences: (o.auds ?? []).map((a) => a[0]), sources: [...(o.claims ?? []).map((c) => claim(c)), ...(o.auds ?? []).map(([a, q]) => aud(a, 'd1', q))],
    offers: (o.offers ?? []).map(([n, p]) => offer(n, p)) }), docs);
  const price = (name: string) => r.final.offers.find((x) => x.name === name)?.price ?? null;
  const hint = (name: string) => r.rep.leftOut.find((l) => l.what === 'price' && l.text === name)?.found ?? null;
  return { text, r, price, hint, kept: (c: string) => r.final.approvedClaims.includes(c), keptAudience: (a: string) => r.final.audiences.includes(a) };
}

// ─── 1. The page reader: separate, linear, capped ────────────────────────────

test('parseHtmlPage, the inventory and the research parser are exactly as at 1a9e5160 (snapshot from a 1a9e5160 checkout)', async () => {
  const base = JSON.parse(readFileSync(new URL('./fixtures/brand-dna-1a9e5160-setup-card.json', import.meta.url), 'utf8'));
  for (const [k, v] of Object.entries(inputs.SAMPLE_PAGES)) {
    const page = parseHtmlPage(v, `https://hearth.example/${k}`);
    assert.deepEqual(JSON.parse(JSON.stringify(page)), base.parsed[k], k);
    assert.ok(!('structured' in page), 'parseHtmlPage computes nothing for Brand DNA');
  }
  const transport = { fetch: async (url: string) => {
    const path = new URL(url).pathname.replace(/^\//, '') || 'index';
    const body = inputs.SAMPLE_PAGES[path] ?? (path === 'sitemap.xml' ? inputs.SITEMAP : null);
    if (body === null) return { url, finalUrl: url, status: 404, contentType: 'text/html', body: Buffer.from('not found'), truncated: false, headers: {} };
    return { url, finalUrl: url, status: 200, contentType: path.endsWith('.xml') ? 'application/xml' : 'text/html; charset=utf-8', body: Buffer.from(body), truncated: false, headers: {} };
  } };
  assert.deepEqual(JSON.parse(JSON.stringify(await buildInventory('b', 'https://hearth.example', transport, { now: '2026-11-01T00:00:00.000Z' }))), base.inventory);
  // With Brand DNA's page text kept, every other field of every page is still what 1a9e5160 produced.
  const withText = await buildInventory('b', 'https://hearth.example', transport, { now: '2026-11-01T00:00:00.000Z', captureText: true });
  assert.deepEqual(JSON.parse(JSON.stringify({ ...withText, pages: withText.pages.map(({ text: _t, ...p }) => p) })), base.inventoryWithTextOtherwise);
  assert.match(withText.pages[0]!.text!, /^# Boiler service in Bristol\n/);
});

test('the Brand DNA reader: the reviewers’ hostile pages each finish under 500 ms, and pages over 2 MB are cut first', () => {
  // The better of two runs, so a busy test machine (the suite runs files in parallel) does not decide it.
  const time = (label: string, html: string) => {
    const once = () => { const t0 = Date.now(); brandPageHtmlLines(html); return Date.now() - t0; };
    const ms = Math.min(once(), once()); assert.ok(ms < 500, `${label}: ${ms} ms`);
  };
  time('100,000 unclosed <s>', '<body><main>' + '<s>a '.repeat(100000) + '</main></body>');
  time('100,000 nested <div> then 100,000 </span>', '<body><main>' + '<div>'.repeat(100000) + 'x' + '</span>'.repeat(100000) + '</main></body>');
  time('60,000 nested <div>, 60,000 stray </p>, 60,000 </div>', '<body><main>' + '<div>'.repeat(60000) + 'x' + '</p>'.repeat(60000) + '</div>'.repeat(60000) + '</main></body>');
  time('150,000 <td> in one row', '<body><main><table><tr>' + '<td>a</td>'.repeat(150000) + '</tr></table></main></body>');
  time('1.4 MB of "<"', '<body><main>' + '< '.repeat(700000) + '</main></body>');
  time('a large ordinary page', '<body><main>' + '<div class="row"><h3>Title</h3><p>Some ordinary text with a <a href="/x">link</a> and a price £10.</p><ul><li>one</li><li>two</li></ul></div>'.repeat(9000) + '</main></body>');
  time('30,000 unclosed <svg>', '<body><main>' + '<svg>a '.repeat(30000) + '</main></body>');
  time('5 MB of paragraphs', '<body><main>' + '<p>Words on a page.</p>'.repeat(250000) + '</main></body>');
  assert.equal(BRAND_HTML_LIMIT, 2_000_000);
  assert.doesNotMatch(brandPageHtmlLines('<body><main><p>a</p>' + ' '.repeat(BRAND_HTML_LIMIT) + '<p>after the cap</p></main></body>'), /after the cap/);
  // Struck text is removed in the same pass, whatever is left unclosed.
  assert.equal(brandPageLines('<p>Kept <s>gone <del>gone</del> gone</s> kept.</p><strike><p>never closed</p><p>also gone'), 'Kept kept.');
  assert.equal(brandPageLines('<p>Kept <s>gone</p><p>kept, the paragraph closed it.</p>'), 'Kept\nkept, the paragraph closed it.');
});

// ─── 2. Words are never glued ────────────────────────────────────────────────

test('no two words separated by anything but a pure inline tag are ever joined; sup/sub never join a digit', () => {
  const INLINE = ['a', 'span', 'b', 'strong', 'i', 'em', 'u', 'small', 'sup', 'sub', 'mark', 'abbr', 'code', 'label', 'button'];
  const BLOCK = ['div', 'p', 'td', 'th', 'tr', 'li', 'ul', 'h3', 'section', 'article', 'header', 'footer', 'aside', 'figure', 'figcaption', 'dt', 'dd', 'blockquote', 'address', 'form', 'fieldset', 'details', 'summary', 'nav', 'main', 'table', 'tbody', 'center', 'font', 'time', 'picture', 'unknown-tag'];
  let seed = 7; const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  for (let n = 0; n < 400; n++) {
    let html = '<table><tr><td>', last = '';
    const blockPairs: string[] = [];
    for (let k = 0; k < 12; k++) {
      const word = `w${n}x${k}`;
      if (last) {
        const r = random();
        const tag = r < 0.5 ? BLOCK[Math.floor(random() * BLOCK.length)]! : INLINE[Math.floor(random() * INLINE.length)]!;
        const sep = random() < 0.3 ? `<br>` : random() < 0.5 ? `<${tag}>` : `</${tag}>`;
        if (sep === '<br>' || !INLINE.includes(tag) || tag === 'sup' || tag === 'sub') blockPairs.push(`${last}${word}`);
        html += sep;
      }
      html += word; last = word;
    }
    html += '</td><td>£1</td></tr></table>';
    const out = brandPageHtmlLines(`<body><main>${html}</main></body>`);
    for (const glued of blockPairs) assert.ok(!out.includes(glued), `${glued} in ${JSON.stringify(out)} from ${html}`);
  }
  // The reviewer's reproductions.
  const t1 = tagged('<table><tr><td>Boiler service</td><td><div class="price">£85</div><div class="small">12 month guarantee</div></td></tr><tr><td>Power flush</td><td><p>from £350</p><p>2 hour visit</p></td></tr></table>');
  assert.equal(t1, '| Boiler service | £85 12 month guarantee\n| Power flush | from £350 2 hour visit');
  assert.equal(tagged('<table><tr><td>Full Management</td><td><p>We charge</p><p>12% of monthly rent</p></td></tr></table>'), '| Full Management | We charge 12% of monthly rent');
  assert.equal(tagged('<p>£85<sup>1</sup> per visit and £2<sub>3</sub></p>'), '£85 1 per visit and £2 3');
  const glued = onPage('<table><tr><td>Boiler service</td><td><div>£85</div><div>12 month guarantee</div></td></tr><tr><td>Power flush</td><td><p>from £350</p><p>2 hour visit</p></td></tr></table>', { offers: [['Boiler service', '£8512'], ['Power flush', 'from £3502']] });
  assert.equal(glued.price('Boiler service'), null); assert.equal(glued.price('Power flush'), null);
  const fine = onPage('<table><tr><td>Boiler service</td><td><div>£85</div><div>12 month guarantee</div></td></tr><tr><td>Power flush</td><td><p>from £350</p><p>2 hour visit</p></td></tr></table>', { offers: [['Boiler service', '£85'], ['Power flush', 'from £350']] });
  assert.equal(fine.price('Boiler service'), '£85'); assert.equal(fine.price('Power flush'), 'from £350');
});

// ─── 3. Outside the website door: as at 1a9e5160 ─────────────────────────────

test('a Setup card’s view model and rendered page are identical to 1a9e5160 (snapshot from a 1a9e5160 checkout)', () => {
  const base = JSON.parse(readFileSync(new URL('./fixtures/brand-dna-1a9e5160-setup-card.json', import.meta.url), 'utf8'));
  const shown = brandDnaCard(inputs.SETUP_PROFILE, inputs.SETUP_DOCUMENTS);
  assert.deepEqual(JSON.parse(JSON.stringify(shown)), base.card);
  assert.ok(!('fromWebsite' in shown) && !('rulesOutdated' in shown));
  assert.equal(brandDnaPage(inputs.SHELL, { ...inputs.STATE, profile: inputs.SETUP_PROFILE, card: shown } as never, 'cmd-1'), base.html);
});

test('uploaded documents reach acquisition evidence and Setup’s extraction exactly as at 1a9e5160; Brand DNA pages reach them without markers', async () => {
  const upload = { id: 'u1', brandId: 'b', version: 1, category: 'faqs', title: 'FAQ', sha256: 'h1', active: true, status: 'extracted', createdAt: 'x', text: '# Not a marker in an upload\n• kept as written\n| also kept' };
  const page = { id: 'p1', brandId: 'b', version: 1, category: 'faqs', title: 'FAQ page', sha256: 'h2', active: true, status: 'extracted', createdAt: 'x', text: '## Questions\n• Do you cover Bath?\n❝ Great service.',
    origin: { kind: 'website', url: 'https://x.example/faq', fetchedAt: 'x' } };
  const profile = { brandId: 'b', version: 1, knowledge: [{ documentId: 'u1', version: 1, sha256: 'h1' }, { documentId: 'p1', version: 1, sha256: 'h2' }], offers: [], approvedClaims: [] } as unknown as BrandProfile;
  const facts = buildAcquisitionEvidence({ profile, knowledge: [upload, page] as unknown as KnowledgeDocument[], plans: [], articles: [] }).facts.map((f) => f.text);
  // (Evidence text is one line, as it always was: only the page's markers are new, and only they are taken off.)
  assert.deepEqual(facts, ['# Not a marker in an upload • kept as written | also kept', 'Questions Do you cover Bath? Great service.']);
  // Setup's documents-only extraction is sent the upload as written and the page without markers (its prompt does not explain them).
  let sent = '';
  const llm = { mode: 'mock', complete: async (req: { messages?: { content: string }[]; user?: string }) => { sent = JSON.stringify(req);
    return { text: JSON.stringify(card({ summary: 'A business.' })), tokensIn: 1, tokensOut: 1, stopReason: 'end_turn', model: 'mock' }; } } as unknown as LlmClient;
  await extractProfile(llm, { brandName: 'Quay', website: null, documents: [upload, page] as unknown as KnowledgeDocument[] });
  const inPrompt = (text: string) => sent.includes(JSON.stringify(JSON.stringify(text).slice(1, -1)).slice(1, -1));
  assert.ok(inPrompt('# Not a marker in an upload\n• kept as written\n| also kept'), 'upload unchanged');
  assert.ok(inPrompt('Questions\nDo you cover Bath?\nGreat service.'), 'page without markers');
  assert.ok(!sent.includes('❝'));
  // The website door is sent its pages with markers (its prompt explains them).
  await extractProfile(llm, { brandName: 'Quay', website: null, documents: [page] as unknown as KnowledgeDocument[], strict: true }).catch(() => null);
  assert.ok(sent.includes('❝ Great service.'));
});

// ─── 4. Customer words ───────────────────────────────────────────────────────

test('customer words: whole class tokens only, never on html/body/main; heading sections end at the next heading or when the container closes', () => {
  const body = `<h2>Get a free quote</h2><p>We offer free, no-obligation quotes for every job.</p><ul><li>All work guaranteed for 12 months</li></ul><p>Boiler service £85</p>`;
  const want = { claims: ['We offer free, no-obligation quotes for every job.', 'All work guaranteed for 12 months'], offers: [['Boiler service', '£85']] as [string, string][] };
  for (const wrapper of ['<section class="get-a-quote">', '<div id="quote">', '<section class="post-preview">', '<section class="painting-decorating">', '<div class="rating-panel">', '<div class="quotes">', '<div class="reviewed-by">']) {
    const r = onPage(`${wrapper}${body}</${wrapper.slice(1, wrapper.indexOf(' '))}>`, want);
    assert.ok(r.kept(want.claims[0]!) && r.kept(want.claims[1]!), `${wrapper}: ${r.text}`); assert.equal(r.price('Boiler service'), '£85', wrapper);
  }
  for (const page of [`<html><body class="testimonials"><main class="reviews">${body}</main></body></html>`]) {
    const t = brandPageText(brandPageHtmlLines(page)); assert.doesNotMatch(t, /❝/, 'a class on html, body or main marks nothing');
  }
  for (const cls of ['testimonial', 'testimonials', 'review', 'reviews', 'customer-review', 'customer-reviews', 'client-review', 'client-reviews', 'star-rating', 'trustpilot', 'feefo', 'google-reviews']) {
    assert.match(tagged(`<div class="card ${cls}"><p>They were brilliant from start to finish.</p></div>`), /^❝ They were brilliant/, cls);
  }
  // A heading section ends when the heading's container closes, or at the next heading.
  const sect = tagged('<section><h2>What our customers say</h2><p>Brilliant work, thank you.</p></section><section><p>We are Gas Safe registered and fully insured.</p></section><h2>Testimonials</h2><p>Lovely job.</p><h2>Our services</h2><p>We fit boilers across Bristol.</p>');
  assert.deepEqual(sect.split('\n'), ['## What our customers say', '❝ Brilliant work, thank you.', 'We are Gas Safe registered and fully insured.', '## Testimonials', '❝ Lovely job.', '## Our services', 'We fit boilers across Bristol.']);
  for (const h of ["Don't just take our word for it", 'Don’t take our word for it', 'Happy customers', 'Happy clients', 'What people say', 'Client stories', 'Customer stories', 'Success stories', 'Kind words', 'Google reviews', 'What our landlords say'])
    assert.match(tagged(`<h2>${h}</h2><p>Simply the best letting agent in Kent.</p>`), /\n❝ Simply the best/, h);
  for (const h of ['CV Review', 'Boiler review', 'Get a free quote', 'Our ratings explained', 'Annual review service']) assert.doesNotMatch(tagged(`<h2>${h}</h2><p>We check every part of it for you.</p>`), /❝/, h);
  // Accepted loss: a review business whose own work sits under a "Reviews" heading is read as customer words (left out, never invented).
  assert.ok(!onPage('<h1>Reviews</h1><p>We test every boiler ourselves for a month before we write about it.</p>', { claims: ['We test every boiler ourselves for a month before we write about it.'] }).kept('We test every boiler ourselves for a month before we write about it.'));
});

test('attribution lines mark a sentence only beside italics, quote marks or a star rating; other short lines change nothing; typed dash bullets are items', () => {
  const kept = (html: string, claims: string[]) => { const r = onPage(html, { claims }); for (const c of claims) assert.ok(r.kept(c), `${c} | ${r.text}`); };
  const refused = (html: string, claims: string[]) => { const r = onPage(html, { claims }); for (const c of claims) assert.ok(!r.kept(c), `${c} | ${r.text}`); };
  kept('<div><p>We work across the whole of east Kent.</p><p>Whitstable, Herne Bay and Canterbury</p></div>', ['We work across the whole of east Kent.']);
  kept('<div><p>Our entry plan suits a single flat.</p><p>Plan B</p><p>Our second plan suits a small portfolio.</p></div>', ['Our entry plan suits a single flat.', 'Our second plan suits a small portfolio.']);
  kept('<p>We look forward to hearing from you.</p><p>Jane Moore, Founder</p><p>I started this business in 2017.</p>', ['We look forward to hearing from you.', 'I started this business in 2017.']);
  kept('<p>Every dog is groomed one to one in our studio.</p><p>Sarah</p>', ['Every dog is groomed one to one in our studio.']);
  refused('<div><p><em>Simply the best letting agent in Kent.</em></p><p>Sarah</p></div>', ['Simply the best letting agent in Kent.']);
  refused('<div><p>“My rent has been paid on time every month.”</p><p>The Patel family, Herne Bay</p></div>', ['My rent has been paid on time every month.']);
  refused('<div><p>"Really friendly team who know their stuff."</p><p>Tom, 34, first-time landlord</p></div>', ['Really friendly team who know their stuff.']);
  refused('<div><span class="stars">★★★★★</span><p>Excellent service, they sold my house in a week.</p><p>John D.</p></div>', ['Excellent service, they sold my house in a week.']);
  const bullets = tagged('<p>We promise every customer three things.<br>- Fixed prices agreed first<br>– Fully insured engineers<br>* Tidy work</p>');
  assert.equal(bullets, 'We promise every customer three things.\n• Fixed prices agreed first\n• Fully insured engineers\n• Tidy work');
  kept('<p>We promise every customer three things.<br>- Fixed prices agreed first</p>', ['We promise every customer three things.', 'Fixed prices agreed first']);
});

// ─── 5. Price units and the left-out hint ────────────────────────────────────

test('price units: one to three words after per/a/an/each/every; a percentage base of up to four words; the hint only when the rule is sure', () => {
  const table = '<table><tr><td>Flat roof replacement</td><td>from £85 per square metre</td></tr><tr><td>Fencing</td><td>£95 per metre fitted</td></tr><tr><td>Window cleaning</td><td>£2 per window</td></tr><tr><td>Copywriting</td><td>£120 per 1,000 words</td></tr><tr><td>Dog walking</td><td>£14 per walk</td></tr><tr><td>Lawn mowing</td><td>£25 each visit, all year</td></tr></table>';
  const whole: [string, string][] = [['Flat roof replacement', 'from £85 per square metre'], ['Fencing', '£95 per metre fitted'], ['Window cleaning', '£2 per window'], ['Copywriting', '£120 per 1,000 words'], ['Dog walking', '£14 per walk'], ['Lawn mowing', '£25 each visit']];
  const r = onPage(table, { offers: whole });
  for (const [n, p] of whole) assert.equal(r.price(n), p, n);
  const cut = onPage(table, { offers: whole.map(([n, p]) => [n, p.replace(/ (per|each) .*$/, '')]) });
  for (const [n, p] of whole) { assert.equal(cut.price(n), null, n); assert.equal(cut.hint(n), p, `hint for ${n}`); }
  const pct = onPage('<h3>Rent Collection</h3><p>8% of rent collected</p><h3>Full Management</h3><p>12% of the monthly rent received</p>', { offers: [['Rent Collection', '8% of rent collected'], ['Full Management', '12% of the monthly rent received']] });
  assert.equal(pct.price('Rent Collection'), '8% of rent collected'); assert.equal(pct.price('Full Management'), '12% of the monthly rent received');
  // No hint when the offer's own price was set aside and another amount is the only candidate; none from a price-above-name page.
  const aside = onPage('<h3>Full Management</h3><p>12% + VAT</p><p>Tenant referencing £50 per tenant</p>', { offers: [['Full Management', '12% + VAT']] });
  assert.equal(aside.price('Full Management'), null); assert.equal(aside.hint('Full Management'), null);
  const above = onPage('<p>£29 per month</p><p>Starter</p><p>For one property.</p><p>£49 per month</p><p>Pro</p><p>Up to five.</p>', { offers: [['Pro', '£49']] });
  assert.equal(above.price('Pro'), null); assert.equal(above.hint('Pro'), null);
  // No hint when the expression runs on into words the rule did not read.
  const trails = priceStatus('£85', { text: '# Boiler service\n£85 per boiler annually inspected and certified here' }, ['Boiler service'], 0);
  assert.equal(trails.status, 'untied'); assert.equal(trails.hint, null);
  assert.equal(priceStatus('£85', { text: '# Boiler service\n£85 per boiler.' }, ['Boiler service'], 0).hint, '£85 per boiler');
  assert.equal(priceStatus('£40', { text: '# Boiler service\nFrom £85.\n# Repairs\n£60 per hour' }, ['Boiler service', 'Repairs'], 0).hint, 'From £85');
});

// ─── 6. The lines beside a price ─────────────────────────────────────────────

test('the card shows the lines the price rule used (name line and price line), carried from the decision, never the first place the amount occurs', async () => {
  const text = tagged('<h2>Our prices</h2><h3>Boiler service</h3><p>A yearly check of your boiler.</p><p>£85</p><h3>Gas safety certificate</h3><p>For landlords.</p><p>£85</p><table><tr><td>Power flush</td><td>from £350</td></tr></table><p>A Clarity Session costs £150.</p>');
  const docs = [D('d1', text, 'https://x.example/prices')];
  const v = card({ offers: [offer('Boiler service', '£85'), offer('Gas safety certificate', '£85'), offer('Power flush', 'from £350'), offer('Clarity Session', '£150')] });
  assert.deepEqual(priceLineSources(v, docs).map((s) => [s.value, s.quote]), [
    ['Boiler service', 'Boiler service … £85'], ['Gas safety certificate', 'Gas safety certificate … £85'], ['Power flush', 'Power flush | from £350'], ['Clarity Session', 'A Clarity Session costs £150.']]);
  // Through the real extraction: the lines are recorded on the card and shown on the page.
  const documents = [{ id: 'd1', brandId: 'b', version: 1, category: 'product_facts', title: 'Prices', sha256: 's', active: true, status: 'extracted', createdAt: 'x', text, origin: { kind: 'website', url: 'https://x.example/prices', fetchedAt: 'x' } }] as unknown as KnowledgeDocument[];
  const llm = { mode: 'mock', complete: async () => ({ text: JSON.stringify(v), tokensIn: 1, tokensOut: 1, stopReason: 'end_turn', model: 'mock' }) } as unknown as LlmClient;
  const made = await extractProfile(llm, { brandName: 'X', website: 'https://x.example', documents, strict: true });
  const profile = { ...made.value, brandId: 'b', version: 1, knowledge: [{ documentId: 'd1', version: 1, sha256: 's', category: 'product_facts' }], strict: true, rulesVersion: BRAND_DNA_RULES_VERSION,
    factsSha: 'f', source: 'extracted', confirmedAt: null, confirmedBy: null, createdAt: 'x', generation: null } as unknown as BrandProfile;
  const shown = brandDnaCard(profile, documents);
  assert.deepEqual(shown.offers.map((o) => o.priceSource?.quote), ['Boiler service … £85', 'Gas safety certificate … £85', 'Power flush | from £350', 'A Clarity Session costs £150.']);
  // An owner-settled price shows where they chose it, with no line; a price changed since shows no stale line.
  const settled = brandDnaCard({ ...profile, offers: profile.offers.map((o, i) => i === 0 ? { ...o, price: '£90', priceSourceDocumentId: null } : i === 1 ? { ...o, price: '£95' } : o) } as BrandProfile, documents);
  assert.equal(settled.offers[0]!.priceSource!.label, 'You told us'); assert.equal(settled.offers[0]!.priceSource!.quote, null); assert.equal(settled.offers[1]!.priceSource!.quote, null);
  const page = brandDnaPage(inputs.SHELL, { ...inputs.STATE, profile, card: shown } as never, 'cmd');
  assert.match(page, /Price: £85<\/span><span class="from"><a[^>]*>From your Prices page<\/a>: <q>Gas safety certificate … £85<\/q>/);
  assert.match(page, /Each price is copied as your page writes it, with the line we found it on and the line naming what it is for\./);
  const start = brandDnaPage(inputs.SHELL, { ...inputs.STATE, profile: null, card: null } as never, 'cmd');
  assert.match(start, /Prices and claims show where we found them\. You confirm the card before anything is used\./);
});

// ─── 7. Card starts ──────────────────────────────────────────────────────────

test('a short line between a name and its price does not start a new card; a sub-heading under the name belongs to it', () => {
  const r = onPage('<h3>Starter</h3><p>Perfect for one property</p><p>£29 per month</p><h3>Pro</h3><p>For growing portfolios</p><p>£49 per month</p>', { offers: [['Starter', '£29 per month'], ['Pro', '£49 per month']] });
  assert.equal(r.price('Starter'), '£29 per month'); assert.equal(r.price('Pro'), '£49 per month');
  const sub = onPage('<h3>Premium</h3><h4>Everything in Pro and more</h4><p>£99 per month</p>', { offers: [['Premium', '£99 per month']] });
  assert.equal(sub.price('Premium'), '£99 per month');
  const soup = onPage('<div><div>Bath &amp; Tidy</div><div>A wash, blow dry and brush out</div><div>from £30</div></div><div><div>Full Groom</div><div>Bath, clip, nails and ears</div><div>from £45</div></div>', { offers: [['Bath & Tidy', 'from £30'], ['Full Groom', 'from £45']] });
  assert.equal(soup.price('Bath & Tidy'), 'from £30'); assert.equal(soup.price('Full Groom'), 'from £45');
  // After a completed card, a short label followed by an amount is the next card: its amount is not this offer's.
  const next = priceCandidates({ text: '# Boiler service\n£85\nGas check\n£70' }, ['Boiler service'], 0).map((x) => x.text);
  assert.deepEqual(next, ['£85']);
});

// ─── 8. List items as claims ─────────────────────────────────────────────────

test('list items: an item’s own negation is allowed under a clean lead-in; pain-point and question lead-ins refuse the whole list', () => {
  const clean = onPage('<p>Why choose us</p><ul><li>No call-out charge</li><li>Free, no-obligation quotes</li><li>No hidden fees</li><li>Not VAT registered</li></ul><p>We offer free, no-obligation quotes.</p><ul><li>All work guaranteed for 12 months</li></ul>',
    { claims: ['No call-out charge', 'Free, no-obligation quotes', 'No hidden fees', 'Not VAT registered', 'All work guaranteed for 12 months'] });
  for (const c of ['No call-out charge', 'Free, no-obligation quotes', 'No hidden fees', 'Not VAT registered', 'All work guaranteed for 12 months']) assert.ok(clean.kept(c), c);
  for (const lead of ['Tired of letting agents who:', 'Fed up with agents who', 'Struggling with tenants?', 'Worried about voids', 'Sound familiar?', 'Sick of waiting', 'Frustrated with your agent', 'Agents who let you down',
    'Companies that cut corners', 'Firms that overcharge', 'What others do', 'Other agents will', 'Other companies', 'Other firms', 'Common problems', 'The problem with DIY', 'Mistakes landlords make', 'Pitfalls to avoid',
    'Is your agent letting you down?', 'We do not:', 'We never', 'What we cannot do']) {
    const r = onPage(`<p>${lead}</p><ul><li>Rent paid to you within two days</li><li>No hidden fees</li></ul>`, { claims: ['Rent paid to you within two days', 'No hidden fees'] });
    assert.ok(!r.kept('Rent paid to you within two days') && !r.kept('No hidden fees'), lead);
  }
  for (const item of ['✗ Guaranteed rent', '❌ FCA regulated', 'Myth: rent is guaranteed', 'A common misconception is that rent is guaranteed', 'False: you can evict in two weeks', 'We hope to open in Bath', 'We aim to reply in an hour'])
    assert.ok(!onPage(`<p>Why choose us</p><ul><li>${item}</li></ul>`, { claims: [item] }).kept(item), item);
});

// ─── 10. Tables ──────────────────────────────────────────────────────────────

test('tables: one-column or long-celled tables are layout; omitted end tags; name/price/name/price rows tie each price to its own name', () => {
  assert.equal(tagged('<table><tr><td><h1>Bright Spark</h1><p>We are Gas Safe registered.</p><h3>Boiler service</h3><p>£85</p><ul><li>One hour</li></ul></td></tr></table>'), '# Bright Spark\nWe are Gas Safe registered.\n### Boiler service\n£85\n• One hour');
  const long = 'We look after everything for you so you never have to worry about anything at all. '.repeat(4);
  assert.equal(tagged(`<table><tr><td><p>${long.trim()}</p></td><td><h3>Pro</h3><p>£49</p></td></tr></table>`), `${long.trim()}\n### Pro\n£49`);
  assert.equal(tagged('<table><tr><td>Boiler service<td>£85<tr><td>Power flush<td>from £350</table><ul><li>No hidden extras<li>Fully insured engineers</ul>'), '| Boiler service | £85\n| Power flush | from £350\n• No hidden extras\n• Fully insured engineers');
  const pairs = onPage('<table><tr><td>Boiler service</td><td>£85</td><td>Power flush</td><td>from £350</td></tr></table>', { offers: [['Boiler service', '£85'], ['Power flush', 'from £350']] });
  assert.equal(pairs.price('Boiler service'), '£85'); assert.equal(pairs.price('Power flush'), 'from £350');
  const swapped = onPage('<table><tr><td>Boiler service</td><td>£85</td><td>Power flush</td><td>from £350</td></tr></table>', { offers: [['Boiler service', 'from £350'], ['Power flush', '£85']] });
  assert.equal(swapped.price('Boiler service'), null); assert.equal(swapped.price('Power flush'), null);
});

// ─── 11. Unreliability words ─────────────────────────────────────────────────

test('audiences and offer names in sentences about plans, questions or the future are refused', () => {
  const lines = ['We are working towards serving landlords in Sussex.', 'Ask about our HMO Licensing Help.', 'Landlords often ask about guaranteed rent schemes.', 'Tenants have asked about pet insurance.',
    'We are looking into commercial landlords.', 'We are considering a Rent Guarantee Plan.', 'Commercial lettings coming soon.', 'Soon we will help holiday let owners.'];
  const text = lines.join('\n');
  for (const [a, line] of [['landlords in Sussex', 0], ['guaranteed rent schemes', 2], ['pet insurance', 3], ['commercial landlords', 4], ['holiday let owners', 7]] as const) assert.equal(audienceUnit(a, { text }), null, lines[line]);
  for (const name of ['HMO Licensing Help', 'Rent Guarantee Plan', 'Commercial lettings']) assert.ok(offerNameProblem(name, { text }), name);
  assert.equal(audienceUnit('private landlords in Kent', { text: 'We help private landlords in Kent.' })?.text, 'We help private landlords in Kent.');
});

// ─── The seven honest sites ──────────────────────────────────────────────────

test('seven honest sites through the real reader: every true price kept, no wrong price, the roofer, dog groomer and plumber as the reviewer expects', (t) => {
  const totals = Array<number>(12).fill(0);
  for (const s of sites) {
    const docs = Object.entries(s.pages).map(([path, html], i) => D(`doc${i + 1}`, tagged(html, s.raw === true), s.website + path));
    const ids = Object.fromEntries(Object.keys(s.pages).map((p, i) => [p, `doc${i + 1}`]));
    const v = card(s.answer(ids));
    const r = door(v, docs, { website: s.website });
    const f = r.final, priced = v.offers.filter((o) => o.price);
    const right = f.offers.filter((o) => o.price && priced.some((p) => p.name === o.name && p.price === o.price)).length;
    const wrong = f.offers.filter((o) => o.price && !priced.some((p) => p.name === o.name && p.price === o.price)).length;
    const row = [f.offers.length, v.offers.length, right, s.truth, f.audiences.length, v.audiences.length, f.approvedClaims.length, v.approvedClaims.length, f.exclusions!.length, v.exclusions!.length, f.conflicts.length, wrong];
    row.forEach((x, i) => { totals[i] = totals[i]! + x; });
    const lines = priceLineSources(v, docs, { website: s.website });
    t.diagnostic(`${s.name} | offers ${row[0]}/${row[1]} | true prices ${row[2]}/${row[3]} | audiences ${row[4]}/${row[5]} | claims ${row[6]}/${row[7]} | never-say ${row[8]}/${row[9]} | questions ${row[10]} | wrong ${wrong} | first-pass problems ${r.problems.length} | lines ${JSON.stringify(lines.map((l) => l.quote))}`);
    assert.equal(wrong, 0, `${s.name}: wrong prices`);
    // Every price the honest answer gave stays (the broker's £495 and the coach's programme are not given as one offer's price).
    assert.equal(row[2], priced.length, `${s.name}: true prices`);
    assert.equal(row[6], row[7], `${s.name}: claims`); assert.equal(row[4], row[5], `${s.name}: audiences`);
    assert.equal(r.problems.length, 0, `${s.name}: first-pass problems`);
    for (const l of lines) assert.ok(l.quote!.split(' … ').every((part) => withoutMarkers(docs.find((d) => d.id === l.documentId)!.text).includes(part)), `${s.name}: ${l.quote}`);
    if (/ROOFER/.test(s.name)) {
      assert.equal(f.offers.find((o) => o.name === 'Flat roof replacement')!.price, 'from £85 per square metre');
      for (const c of ['We give free, fixed-price quotes within 24 hours of our visit.', 'Every quote is written down and itemised.', 'Free, no-obligation quotes']) assert.ok(f.approvedClaims.includes(c), c);
    }
    if (/DOG GROOMER/.test(s.name)) { assert.equal(f.offers.find((o) => o.name === 'Bath & Tidy')!.price, 'from £30'); assert.equal(f.offers.find((o) => o.name === 'Full Groom')!.price, 'from £45'); }
    if (/PLUMBER/.test(s.name)) for (const c of ['No call-out charge', 'Free, no-obligation quotes']) assert.ok(f.approvedClaims.includes(c), c);
  }
  t.diagnostic(`TOTAL | offers ${totals[0]}/${totals[1]} | true prices ${totals[2]}/${totals[3]} | audiences ${totals[4]}/${totals[5]} | claims ${totals[6]}/${totals[7]} | never-say ${totals[8]}/${totals[9]} | questions ${totals[10]} | wrong ${totals[11]}`);
});
