/**
 * Martin Howard Property's Home, Join and Mentoring pages, RECONSTRUCTED for the Brand DNA price-structure tests.
 *
 * The public pages are not served from this repository (orchestrator/src/mhp serves only the members' app; the public site
 * at martinhowardproperty.co.uk lives elsewhere), and this environment has no network. So every price line below is a line
 * the owner's first real card quoted, copied exactly, placed in the markup a page builder typically produces:
 *   - Home: a comparison table (table-row form), one row per offer, as the card's quotes show ("Name | what you get | price | refund").
 *   - Join: one card per offer (card form), then the course checkout form after the last card, whose labels the old reader
 *     glued into one line ("Start the course: £997 paid once Start the course: £1,497 paid once Or 3 monthly payments …").
 *   - Mentoring: the programme page, no prices.
 * Words not quoted by the card (descriptions, headings, the Deal Desk and cheat-sheet lines) are short and follow
 * src/mhp/catalog.ts (The Deal Desk is £47 once). The Join page heads the Deal Desk card "Deal Desk" while the Home table and
 * the model name it "The Deal Desk": that is the reconstruction's account of "none found" (see the test for what changed).
 */
export const MHP_SITE = 'https://martinhowardproperty.co.uk';

const page = (title: string, main: string) => `<!doctype html><html><head><title>${title} | Martin Howard Property</title></head><body>
<header><nav><a href="/">Home</a> <a href="/join/">Join</a> <a href="/mentoring/">Mentoring</a></nav></header>
<main>${main}</main><footer><p>Martin Howard Property is a trading name of MH196 Ltd.</p></footer></body></html>`;

export const MHP_HOME = page('Home', `<h1>Learn property investing properly</h1>
<p>Martin Howard Property teaches one lane of property investing at a time, with the tools to run your own deals.</p>
<h2>Ways to work with us</h2>
<table class="offers"><thead><tr><th>Offer</th><th>What you get</th><th>Price</th><th>Refund</th></tr></thead><tbody>
<tr><td>Free cheat sheets</td><td>Five one-page guides to the numbers</td><td>Available free with an email address</td><td>None needed</td></tr>
<tr><td>The Deal Desk</td><td>Your own Desk (CRM, enquiry page, deal files) and the calculators</td><td>See the join page</td><td>14 days</td></tr>
<tr><td>Property Done Properly</td><td>Twenty-six modules, 192 lessons, 23 worked deal clinics, the calculators, a 3-month Property Predator seat, your own Desk (CRM, enquiry page, deal files)</td><td>£1,497, or £997 for seven days after a webinar</td><td>30 days</td></tr>
<tr><td>The Members' Room</td><td>Monthly live calls and the deal review queue</td><td>£67 a month or £47 for the first 100</td><td>30 days</td></tr>
<tr><td>One Lane Mentoring</td><td>90 days, twelve people, one lane of property investing</td><td>£3,997, or 6 x £699</td><td>Full refund before the first call; then none</td></tr>
</tbody></table>`);

export const MHP_JOIN = page('Join', `<h1>Join</h1>
<div class="cards">
<section class="card"><h2>Property Done Properly</h2><p>The course: every module, lesson and deal clinic.</p><p>£1,497 once, or 3 x £525</p><p>Webinar price: £997, or 3 x £349</p></section>
<section class="card"><h2>One Lane Mentoring</h2><p>Twelve people, ninety days, one lane.</p><p>£3,997 or 6 x £699 (£4,194 in total)</p><p>The £997 course price credits in full for 90 days.</p></section>
<section class="card"><h2>One Lane Private</h2><p>One to one, for twelve months.</p><p>£25,000 or 12 x £2,250 (£27,000 in total)</p></section>
<section class="card"><h2>Deal Desk</h2><p>Your Desk and the calculators, ready the same day.</p><p>£47 once</p></section>
<section class="card"><h2>The Members' Room</h2><p>£67 a month or £670 a year, with a founders' price of £47 a month.</p><p>The Members' Room founders' price, £47 a month instead of £67, if you join within 30 days.</p><p>The £997 credits in full against One Lane Mentoring for 90 days.</p></section>
</div>
<form class="course-checkout" method="post" action="https://app.martinhowardproperty.co.uk/checkout/course"><label><input type="radio" name="plan" value="web">Start the course: £997 paid once</label><label><input type="radio" name="plan" value="full">Start the course: £1,497 paid once</label><label><input type="radio" name="plan" value="web3">Or 3 monthly payments of £349 (£1,047 in total)</label><label><input type="radio" name="plan" value="3x">Or 3 monthly payments of £525 (£1,575 in total)</label><button type="submit">Continue to payment</button></form>`);

export const MHP_MENTORING = page('Mentoring', `<h1>One Lane Mentoring</h1>
<p>Ninety days in a group of twelve, working one lane of property investing with Martin.</p>
<h2>How it works</h2><ul><li>A call every week</li><li>Your deals reviewed in the group</li><li>Full refund before the first call</li></ul>
<h2>One Lane Private</h2><p>Twelve months one to one. By application only.</p>`);

export const MHP_PAGES: Record<string, string> = { '/': MHP_HOME, '/join/': MHP_JOIN, '/mentoring/': MHP_MENTORING };

/** The model's answer, as the owner's card shows it: the four price questions, the gap notes, and prices where it gave them. */
export function mhpModelAnswer(id: Record<string, string>): Record<string, unknown> {
  const home = id['/']!, join = id['/join/']!;
  return {
    summary: 'Martin Howard Property teaches one lane of property investing at a time, with the tools to run your own deals.',
    audiences: [], positioning: '', conversionPages: [], voice: { tone: ['plain'], do: [], dont: [], examples: [] }, approvedClaims: [], exclusions: [],
    offers: [
      { name: 'Free cheat sheets', description: 'One-page guides to the numbers.', price: null, url: null, sourceDocumentId: home },
      { name: 'The Deal Desk', description: 'Your own Desk and the calculators.', price: null, url: null, sourceDocumentId: home },
      { name: 'Property Done Properly', description: 'The course.', price: '£1,497', url: null, sourceDocumentId: home },
      { name: "The Members' Room", description: 'Monthly live calls.', price: null, url: null, sourceDocumentId: home },
      { name: 'One Lane Mentoring', description: 'Ninety days in a group.', price: null, url: null, sourceDocumentId: home },
      { name: 'One Lane Private', description: 'One to one for twelve months.', price: null, url: null, sourceDocumentId: join },
    ],
    conflicts: [
      { field: 'price', detail: 'The home page and the join page state different standard prices and instalment options for Property Done Properly.', documentIds: [home, join], kind: 'price', offer: null,
        options: [{ value: '£1,497', documentId: home, quote: '£1,497, or £997 for seven days after a webinar' }, { value: '£997', documentId: home, quote: '£1,497, or £997 for seven days after a webinar' }, { value: '£525', documentId: join, quote: '£1,497 once, or 3 x £525' }, { value: '£349', documentId: join, quote: 'Webinar price: £997, or 3 x £349' }] },
      { field: 'price', detail: "The home page lists £67 a month or £47 for the first 100. The join page lists £67 a month or £670 a year, with a founders' price of £47 a month.", documentIds: [home, join], kind: 'price', offer: "The Members' Room",
        options: [{ value: '£47 a month', documentId: join, quote: "The Members' Room founders' price, £47 a month instead of £67" }, { value: '£67', documentId: join, quote: '£47 a month instead of £67' }] },
      { field: 'price', detail: 'One Lane Mentoring is £3,997 or 6 x £699.', documentIds: [home, join], kind: 'price', offer: 'One Lane Mentoring',
        options: [{ value: '£3,997', documentId: home, quote: '£3,997, or 6 x £699' }, { value: '£699', documentId: home, quote: '£3,997, or 6 x £699' }] },
      { field: 'One Lane Private: price', detail: 'Two prices are written.', documentIds: [join], kind: 'price', offer: 'One Lane Private',
        options: [{ value: '£25,000', documentId: join, quote: '£25,000 or 12 x £2,250 (£27,000 in total)' }, { value: '£2,250', documentId: join, quote: '£25,000 or 12 x £2,250 (£27,000 in total)' }] },
    ],
    missingFacts: ['Confirmed single price for Property Done Properly (standard vs webinar)', "Whether the Members' Room founders' price is still open", 'The Deal Desk price is shown on the join page only',
      'Whether One Lane Mentoring instalments carry interest', 'A named author for the guides', 'Opening hours for support', 'A street address', 'Customer numbers'],
    sources: [],
  };
}
