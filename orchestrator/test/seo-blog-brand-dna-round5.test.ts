/**
 * Brand DNA website door, round 5: inline tags never glue a letter or digit to another; pence written apart are unsure;
 * customer words by class/id name parts and page-builder heading widgets; name lines with a role or place; the own-run stop
 * and "price on request"; question lead-ins; bounded units and percentage bases; the 2 MB cut; heading markers in the prompt.
 * Every input is a reviewer reproduction (scratchpad dna-review/r4). No network, model or database is touched.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { brandPageText, cleanProvenance, holdConflictedPrices, repairProfileFacts, strictProfileProblems, type ProfileFacts } from '../src/seo-blog/brand-dna.js';
import { audienceUnit, offerNameProblem, priceCandidates } from '../src/seo-blog/brand-dna-rules.js';
import { BRAND_HTML_LIMIT, brandPageHtmlLines, brandPageLines } from '../src/seo-blog/html.js';
import { loadPrompt } from '../src/stages/prompt.js';
import type { ProfileOffer } from '../src/seo-blog/types.js';

const D = (id: string, text: string, page?: string) => ({ id, text, ...(page ? { page } : {}) });
const card = (over: Record<string, unknown> = {}): ProfileFacts => ({ summary: 'A business summary line.', audiences: [], positioning: '', offers: [], conversionPages: [], voice: { tone: [], do: [], dont: [], examples: [] },
  approvedClaims: [], exclusions: [], conflicts: [], missingFacts: [], sources: [], ...over }) as unknown as ProfileFacts;
const offer = (name: string, price: string | null): ProfileOffer => ({ name, description: '', price, url: null, sourceDocumentId: 'd1' });
const claim = (value: string) => ({ field: 'claim' as const, value, documentId: 'd1', quote: value });
const aud = (value: string, quote: string) => ({ field: 'audience' as const, value, documentId: 'd1', quote });
const M = (html: string) => `<html><body><main>${html}</main></body></html>`;
const tagged = (html: string) => brandPageText(brandPageHtmlLines(M(html)));
function onPage(src: string | { html: string }, o: { claims?: string[]; offers?: [string, string | null][]; auds?: [string, string][] }) {
  const text = typeof src === 'string' ? src : tagged(src.html);
  const docs = [D('d1', text, 'https://x.example/')];
  const v = card({ approvedClaims: o.claims ?? [], audiences: (o.auds ?? []).map((a) => a[0]), sources: [...(o.claims ?? []).map(claim), ...(o.auds ?? []).map(([a, q]) => aud(a, q))], offers: (o.offers ?? []).map(([n, p]) => offer(n, p)) });
  const rep = repairProfileFacts(v, docs, { website: 'https://x.example' });
  assert.ok(rep, 'repairable');
  assert.deepEqual(strictProfileProblems(rep.value, docs, { website: 'https://x.example' }), []);
  const { offerNames: _n, ...kept } = rep.value;
  const final = holdConflictedPrices(cleanProvenance(kept, docs, true), docs);
  return {
    text, final,
    price: (name: string) => final.offers.find((x) => x.name === name)?.price ?? null,
    on: (name: string) => final.offers.some((x) => x.name === name),
    hint: (name: string) => rep.leftOut.find((l) => l.what === 'price' && l.text === name)?.found ?? null,
    kept: (c: string) => final.approvedClaims.includes(c), keptAudience: (a: string) => final.audiences.includes(a),
  };
}

// ─── 1. Inline glue, and pence written apart ─────────────────────────────────

test('an inline tag never joins a letter or digit to another; "£" + "85" and "£85" + "/month" still join', () => {
  assert.equal(tagged('<p><span class="amount">£85</span><span class="per">12 months</span></p>'), '£85 12 months');
  assert.equal(tagged('<p><strong>£350</strong><small>2 hour visit</small></p>'), '£350 2 hour visit');
  assert.equal(tagged('<p><b>2009</b><b>300</b></p>'), '2009 300');
  assert.equal(tagged('<p><span>£</span><span>85</span><span>/month</span> and <b>Tenant</b><i>s</i>, <a href="/x">Fees</a>.</p>'), '£85/month and Tenant s, Fees.');
  const dense = '<div class="card"><span class="title">Tenant Find</span><span class="desc">We market your property and reference your tenants.</span><span class="price">£499</span><span class="term">12 month contract</span></div><div class="card"><span class="title">Full Management</span><span class="desc">We handle repairs and inspections.</span><span class="price">£99</span><span class="per">per month</span></div><div><a href="/a">Landlords</a><a href="/b">Tenants</a><b>Since</b><b>2009</b></div>';
  assert.equal(tagged(dense), 'Tenant Find We market your property and reference your tenants.£499 12 month contract\nFull Management We handle repairs and inspections.£99 per month\nLandlords Tenants Since 2009');
  const r = onPage({ html: dense }, { offers: [['Tenant Find', '£499'], ['Full Management', '£99 per month']] });
  assert.ok(r.on('Tenant Find') && r.on('Full Management'), 'both offers stay on the card');
  assert.equal(r.price('Tenant Find'), null, '"£499 12" is unsure: left empty'); assert.equal(r.hint('Tenant Find'), null); assert.equal(r.price('Full Management'), '£99 per month');
  for (const [html, wrong] of [['<p>Boiler service <span class="amount">£85</span><span class="per">12 months</span></p>', '£8512'], ['<p>Power flush <strong>£350</strong><small>2 hour visit</small></p>', '£3502']] as const) {
    const name = html.includes('Boiler') ? 'Boiler service' : 'Power flush';
    const g = onPage({ html }, { offers: [[name, wrong]] }); assert.equal(g.price(name), null); assert.ok(!g.text.includes(wrong));
  }
  // "£49 99 /mo": pence written apart are unsure, not a candidate, no hint.
  const pence = onPage('# Pro Plan\n£49 99 /mo\n# Starter\n£29 per month', { offers: [['Pro Plan', '£49'], ['Starter', '£29 per month']] });
  assert.equal(pence.price('Pro Plan'), null); assert.equal(pence.hint('Pro Plan'), null); assert.equal(pence.price('Starter'), '£29 per month');
  assert.deepEqual(priceCandidates({ text: '# Pro Plan\n£49 99 /mo' }, ['Pro Plan'], 0), []);
});

test('property: no two words are ever joined across any tag, inline ones included', () => {
  const TAGS = ['a', 'span', 'b', 'strong', 'i', 'em', 'u', 'small', 'sup', 'sub', 'mark', 'abbr', 'code', 'label', 'button', 'div', 'p', 'td', 'li', 'h3', 'section', 'time', 'font', 'unknown-tag'];
  let seed = 11; const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  for (let n = 0; n < 400; n++) {
    let html = '', last = '';
    const pairs: string[] = [];
    for (let k = 0; k < 12; k++) {
      const word = random() < 0.5 ? `w${n}x${k}` : `${k}${n}`;
      if (last) { const tag = TAGS[Math.floor(random() * TAGS.length)]!; html += random() < 0.2 ? '<br>' : random() < 0.5 ? `<${tag}>` : `</${tag}>`; pairs.push(`${last}${word}`); }
      html += word; last = word;
    }
    const out = brandPageHtmlLines(M(`<table><tr><td>${html}</td><td>£1</td></tr></table>`));
    for (const glued of pairs) assert.ok(!out.includes(glued), `${glued} in ${JSON.stringify(out)} from ${html}`);
  }
});

// ─── 2. Customer words ───────────────────────────────────────────────────────

test('customer words by class or id name parts; "quote" only for block quotes; never "rating", "preview", html, body or main', () => {
  for (const cls of ['testimonial-card', 'client-testimonial', 'reviews-grid', 'review-item', 'elementor-testimonial', 'elementor-testimonial-content', 'elementor-testimonial-name', 'wp-block-quote', 'blockquote', 'site_reviews', 'trustpilot-widget', 'feefo-badge'])
    assert.match(tagged(`<div class="${cls}"><p>They were brilliant from start to finish.</p></div>`), /^❝ They were brilliant/, cls);
  assert.match(tagged('<figure class="quote"><p>They were brilliant from start to finish.</p></figure>'), /^❝ /);
  for (const [tag, cls] of [['div', 'quote'], ['div', 'quote-form'], ['div', 'get-a-quote'], ['div', 'rating'], ['div', 'star-ratings-panel'], ['div', 'post-preview'], ['div', 'previews'], ['figure', 'quote big'], ['section', 'reviewer-list']] as const)
    assert.doesNotMatch(tagged(`<${tag} class="${cls}"><p>We service boilers across Bristol.</p></${tag}>`), /❝/, `${tag}.${cls}`);
  assert.doesNotMatch(brandPageText(brandPageHtmlLines('<html><body class="reviews testimonial"><main class="review"><p>We service boilers.</p></main></body></html>')), /❝/);
});

test('a customer-words heading alone in its container covers the next sibling container (page-builder widgets), up to the next heading', () => {
  const elementor = `<div class="elementor-widget elementor-widget-heading"><div class="elementor-widget-container"><h2 class="elementor-heading-title">What our customers say</h2></div></div><div class="elementor-widget elementor-widget-text"><div class="elementor-widget-container"><p>Turned up when they said and left the place spotless.</p><p>Dave Hughes</p></div></div><div class="elementor-widget"><div class="elementor-widget-container"><p>We are members of the National Federation of Roofing Contractors.</p></div></div>`;
  assert.equal(tagged(elementor), '## What our customers say\n❝ Turned up when they said and left the place spotless.\n❝ Dave Hughes\nWe are members of the National Federation of Roofing Contractors.');
  const r = onPage({ html: elementor }, { claims: ['Turned up when they said and left the place spotless.', 'We are members of the National Federation of Roofing Contractors.'] });
  assert.ok(!r.kept('Turned up when they said and left the place spotless.')); assert.ok(r.kept('We are members of the National Federation of Roofing Contractors.'));
  // Ends at the next heading too; and a heading with words of its own in its container ends with that container, as before.
  assert.equal(tagged('<div><h2>Testimonials</h2></div><div><p>Lovely job.</p><h3>Our services</h3><p>We fit boilers.</p></div>'), '## Testimonials\n❝ Lovely job.\n### Our services\nWe fit boilers.');
  assert.equal(tagged('<section><h2>What our customers say</h2><p>Brilliant work.</p></section><section><p>We are Gas Safe registered.</p></section>'), '## What our customers say\n❝ Brilliant work.\nWe are Gas Safe registered.');
});

test('a name line with a role or place, or a title and initial, marks the line above it; place lists, dash bullets and labels do not', () => {
  for (const name of ['Sarah T, landlord', 'Mark, Whitstable', 'Mrs K', 'D. Hughes, Crookes', 'Mark, Charlton Kings']) {
    const r = onPage({ html: `<div><p>Simply the best letting agent in Kent.</p><p>${name}</p></div>` }, { claims: ['Simply the best letting agent in Kent.'] });
    assert.ok(!r.kept('Simply the best letting agent in Kent.'), name);
    // The same lines stored without the reader's markers (an older page) are read the same way.
    assert.ok(!onPage(`Simply the best letting agent in Kent.\n${name}\nAnother line.`, { claims: ['Simply the best letting agent in Kent.'] }).kept('Simply the best letting agent in Kent.'), `one-per-line: ${name}`);
  }
  for (const html of ['<div><p>We work across the whole of east Kent.</p><p>Whitstable, Herne Bay and Canterbury</p></div>', '<div><p>We work across the whole of east Kent.</p><p>Whitstable, Herne Bay, Canterbury</p></div>',
    '<p>We work across the whole of east Kent.<br>- Fixed prices agreed first</p>', '<div><p>We work across the whole of east Kent.</p><p>Plan B</p></div>'])
    assert.ok(onPage({ html }, { claims: ['We work across the whole of east Kent.'] }).kept('We work across the whole of east Kent.'), html);
});

// ─── 3. The own run ──────────────────────────────────────────────────────────

test('the run: a tagline or sub-heading only straight under the name; after that a label, heading or card start ends it; "price on request" is no price', () => {
  const soup = onPage({ html: '<div><div>Bath &amp; Tidy</div><div>A wash and brush out</div><div>Price on request</div></div><div><div>Full Groom</div><div>Bath, clip, nails and ears</div><div>from £45</div></div>' }, { offers: [['Bath & Tidy', 'from £45']] });
  assert.equal(soup.price('Bath & Tidy'), null); assert.equal(soup.hint('Bath & Tidy'), null);
  const heads = onPage({ html: '<h3>Bath &amp; Tidy</h3><p>A wash and brush out</p><h3>Full Groom</h3><p>Bath, clip, nails and ears</p><p>from £45</p>' }, { offers: [['Bath & Tidy', 'from £45']] });
  assert.equal(heads.price('Bath & Tidy'), null);
  const sub = onPage({ html: '<h2>Boiler service</h2><p>Annual check of your boiler</p><h3>Power flush</h3><p>from £350</p>' }, { offers: [['Boiler service', 'from £350']] });
  assert.equal(sub.price('Boiler service'), null);
  for (const poa of ['Price on request', 'POA', 'Call for a price', 'Price on application', 'Contact us for a quote']) {
    const r = onPage(`# Bespoke kitchens\n${poa}\nFrom £5,000 for a small room`, { offers: [['Bespoke kitchens', 'From £5,000']] });
    assert.equal(r.price('Bespoke kitchens'), null, poa); assert.equal(r.hint('Bespoke kitchens'), null, poa);
  }
  // The tagline cards keep their prices.
  const tag = onPage({ html: '<div><h3>Starter</h3><p>Perfect for one property</p><p>£29 per month</p></div><div><h3>Pro</h3><span class="badge">Most popular</span><div>£49 per month</div></div><div><h3>Premium</h3><h4>Everything in Pro and more</h4><p>£99 per month</p></div>' },
    { offers: [['Starter', '£29 per month'], ['Pro', '£49 per month'], ['Premium', '£99 per month']] });
  assert.equal(tag.price('Starter'), '£29 per month'); assert.equal(tag.price('Pro'), '£49 per month'); assert.equal(tag.price('Premium'), '£99 per month');
  const groomer = onPage({ html: '<div><div>Bath &amp; Tidy</div><div>A wash, blow dry and brush out</div><div>from £30</div></div><div><div>Full Groom</div><div>Bath, clip, nails and ears</div><div>from £45</div></div>' }, { offers: [['Bath & Tidy', 'from £30'], ['Full Groom', 'from £45']] });
  assert.equal(groomer.price('Bath & Tidy'), 'from £30'); assert.equal(groomer.price('Full Groom'), 'from £45');
});

// ─── 4. Lists under question headings; "soon" ────────────────────────────────

test('lists: a question alone does not refuse a list; second-person or complaint wording and "not yet" lead-ins do', () => {
  const kept = ['No call-out charge', 'All work guaranteed for 12 months', 'Fully insured engineers', 'A full flue gas check'];
  const q = onPage({ html: '<h2>Why choose us?</h2><ul><li>No call-out charge</li><li>All work guaranteed for 12 months</li><li>Fully insured engineers</li></ul><h2>What\'s included?</h2><ul><li>A full flue gas check</li></ul>' }, { claims: kept });
  for (const c of kept) assert.ok(q.kept(c), c);
  const honest = onPage({ html: '<p>We fix all common boiler problems:</p><ul><li>No heating or hot water</li></ul><p>We help companies that need:</p><ul><li>Payroll run every month</li></ul>' }, { claims: ['No heating or hot water', 'Payroll run every month'] });
  assert.ok(honest.kept('No heating or hot water') && honest.kept('Payroll run every month'));
  for (const lead of ['Does your agent:', 'Do you get:', 'Are you still waiting for:', 'Is your agent:', 'Have you had:', 'Tired of agents who:', 'Sound familiar?', 'Unlike other agents, we never:', 'Five myths:', 'Coming soon', 'Launching soon:', 'Planned for next year:', 'In development:'])
    assert.ok(!onPage({ html: `<p>${lead}</p><ul><li>Online rent statements</li></ul>` }, { claims: ['Online rent statements'] }).kept('Online rent statements'), lead);
  assert.ok(!onPage({ html: '<h3>Coming soon</h3><ul><li>Online rent statements</li></ul>' }, { claims: ['Online rent statements'] }).kept('Online rent statements'));
  // A question to the reader counts only where it opens a sentence: these are ordinary benefit headings.
  for (const lead of ['What do you get?', 'What do you get:', 'Here is what you get when you are with us:'])
    assert.ok(onPage({ html: `<h2>${lead}</h2><ul><li>Online rent statements</li></ul>` }, { claims: ['Online rent statements'] }).kept('Online rent statements'), lead);
  assert.ok(!onPage({ html: '<p>Tell us what you need. Do you want it all done for you?</p><ul><li>Online rent statements</li></ul>' }, { claims: ['Online rent statements'] }).kept('Online rent statements'));
});

test('"will soon" refuses an audience or offer name only in its own clause; "coming soon" and "launching soon" anywhere in the sentence', () => {
  const text = 'We serve landlords in Kent and will soon open in Sussex.\nHoliday let owners will soon be welcome.\nOur Rent Guarantee Plan is launching soon.\nWe will be in touch as soon as we can.\nCommercial lettings coming soon.';
  assert.equal(audienceUnit('landlords in Kent', { text })?.text, 'We serve landlords in Kent and will soon open in Sussex.');
  assert.equal(audienceUnit('holiday let owners', { text }), null);
  assert.ok(offerNameProblem('Rent Guarantee Plan', { text })); assert.ok(offerNameProblem('Commercial lettings', { text }));
  assert.equal(audienceUnit('landlords', { text: 'We call landlords back as soon as we can.' })?.text, 'We call landlords back as soon as we can.', 'a bare "soon" refuses nothing');
});

// ─── 5. Bounded units and percentage bases ───────────────────────────────────

test('a unit after per/each/every and a percentage base stop before amounts, capitalised words, listed names, verbs and joining words', () => {
  const one = (text: string, names: string[], i = 0) => priceCandidates({ text: `${text}\nA second line.` }, names, i).map((x) => x.text);
  assert.deepEqual(one('Annual check £85 per boiler service Power flush £350', ['Annual check', 'Power flush']), ['£85 per boiler service', '£350']);
  assert.deepEqual(one('Rent Collection 8% of rent collected Full Management 12% of rent collected', ['Rent Collection', 'Full Management']), ['8% of rent collected', '12% of rent collected']);
  assert.deepEqual(one('Gutter clean £75 per terraced house Roof survey £150', ['Gutter clean', 'Roof survey']), ['£75 per terraced house', '£150']);
  assert.deepEqual(one('Gutter clean £75 per gutter clean done', ['Gutter clean']), ['£75'], 'a listed name ends the unit');
  assert.deepEqual(one('Window cleaning £2 per window done', ['Window cleaning']), ['£2 per window done'], 'only a whole listed name ends it');
  const card = (t: string, names: string[], i = 0) => priceCandidates({ text: t }, names, i).map((x) => x.text);
  assert.deepEqual(card('# Copywriting\n£120 per 1,000 words 24 hour turnaround', ['Copywriting']), ['£120 per 1,000 words']);
  assert.deepEqual(card('# Sourcing\n2% of the purchase price of the property', ['Sourcing']), ['2% of the purchase price']);
  assert.deepEqual(card('# Lessons\n£38 each lesson lasts an hour', ['Lessons']), ['£38 each lesson']);
  assert.deepEqual(card('# Boiler service\n£85 a great price for peace of mind', ['Boiler service']), [], '"a" opening prose: unsure');
  assert.deepEqual(card('# Call-out\n£60 an hour after 6pm', ['Call-out']), ['£60 an hour']);
  assert.deepEqual(card('# Window cleaning\n£2 a window.', ['Window cleaning']), ['£2 a window']);
  assert.deepEqual(card('# Cleaning\n£30 every two weeks', ['Cleaning']), ['£30 every two weeks']);
  assert.deepEqual(card("# Tenant Find\n75% of the first month's rent", ['Tenant Find']), ["75% of the first month's rent"]);
  assert.deepEqual(card('# Sales\n1.5% of the agreed sale price plus VAT', ['Sales']), ['1.5% of the agreed sale price plus VAT']);
  for (const [n, p] of [['Flat roof replacement', 'from £85 per square metre'], ['Fencing', '£95 per metre fitted'], ['Window cleaning', '£2 per window'], ['Dog walking', '£14 per walk']] as const)
    assert.deepEqual(card(`| ${n} | ${p}`, [n]), [p], n);
});

// ─── 6. The 2 MB cut; heading markers in the prompt ──────────────────────────

test('the 2 MB cut keeps no part of a tag and no cut-off word or number; the site prompt names every heading marker', () => {
  // A page whose 2 MB cut lands 30 characters into the tail: inside a tag, inside an entity, inside a number.
  const head = `<p>${'w'.repeat(BRAND_HTML_LIMIT - 30 - 7)}</p>`;
  for (const tail of ['<p>Boiler service</p><div data-price="£99" class="very-long-class-name-here">x</div>', '<p>Costs &pound;85 and a certificate &pound;70</p>', '<p>Costs only £1,950,000 for the lot</p>']) {
    const lines = brandPageLines(head + tail + '<p>after the cut</p>').split('\n').slice(1);
    assert.deepEqual(lines, tail.startsWith('<p>Boiler') ? ['Boiler service'] : [], tail);
  }
  const prompt = loadPrompt('seo-blog-profile-site.md');
  assert.equal(prompt.header.version, '1.4.0'); assert.match(prompt.body, /"# " to "###### " a heading/);
  assert.equal(tagged('<h1>A</h1><h2>B</h2><h6>C</h6>'), '# A\n## B\n###### C');
});
