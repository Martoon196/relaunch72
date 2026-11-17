/**
 * Test material from the second review of the SEO score (copied, not changed in substance):
 * - five more good shapes: a listicle (L), recipe-style steps (R), a glossary (G), an article quoting a regulation
 *   (Q) and a short buy page (Y), each with its brief and site;
 * - the second round of rubbish generators: small-word salad (N0), grammatical-looking filler (N1), and templates,
 *   spun platitudes and phrase stuffing (N2 to N7).
 * N0 and N1 are the known limit of a word-counting score: they read as fluent English, say nothing, and score high.
 */
import type { ArticleBody } from '../src/seo-blog/types.js';
import * as F from './seo-panel-fixtures.js';
import type { GoodArticle } from './seo-score-review-fixtures.js';

const cite = (url: string, title: string) => ({ sourceId: title, url, title, retrievedAt: '2026-11-01T10:00:00.000Z', passage: title, public: true });
const img = (url: string, alt: string) => ({ kind: 'brand_asset', url, alt, provenance: '', width: 1536, height: 1024 });
const sec = (rows: [string, string][]) => rows.map(([heading, body], i) => ({ id: `s${i}`, heading, body }));

// ───────── L: a listicle of 15 items ─────────
export const L: GoodArticle = { site: 'https://www.kestrelauctions.example', brief: { targetQuery: 'buying a house at auction', searchIntent: 'learn',
  relatedQuestions: ['Can you get a mortgage on an auction property?', 'How much deposit do you need at auction?', 'What happens if you pull out after the hammer falls?'] },
body: { title: 'Buying a house at auction: 15 things to check first', seoTitle: 'Buying a house at auction: 15 things to check first',
  metaDescription: 'Buying a house at auction can be quick and good value, but the hammer is final. Here are 15 things to check before you raise your hand.',
  excerpt: 'Fifteen checks to make before auction day.', slug: 'buying-a-house-at-auction',
  intro: `Buying a house at auction is fast, open and, on a good day, cheaper than buying through an estate agent. It is also unforgiving. When the hammer falls you have exchanged contracts, and there is no cooling-off period and no survey to hide behind.\n\nAlmost every horror story we hear comes down to homework that was skipped. These are the fifteen checks we ask every bidder to make, roughly in the order you will meet them.`,
  sections: sec([
    ['1. Read the legal pack from cover to cover', `The legal pack is the bundle of documents the seller’s solicitor uploads before the sale: title register, plan, searches, any leases and the special conditions. Download it the day the catalogue comes out. If a document you would expect is missing, ask why. A thin pack is a warning in itself.`],
    ['2. Pay a solicitor to read it too', `Most conveyancers will review an auction pack for a fixed fee, often within two or three working days. They know where sellers bury bad news. A couple of hundred pounds spent here is the cheapest insurance in the whole process, and it buys you somebody to call when a late document appears.`],
    ['3. Look hard at the special conditions', `Special conditions override the standard ones, and sellers use them to pass on costs. We have seen buyers made to pay the seller’s legal fees, the auctioneer’s fee, arrears of ground rent and even the cost of the searches. Add every one of these to your budget before you settle on a figure.`],
    ['4. Treat the guide price as an opening line', `A guide price is there to attract interest. The reserve, which is the lowest price the seller will accept, can sit up to 10% above it, and the room often goes further still. Base your limit on what similar homes have sold for nearby, never on the number in the catalogue.`],
    ['5. View it more than once', `Go once on your own and once with somebody who knows buildings. Visit at a different time of day if you can. Open cupboards, lift the corner of a carpet, run the taps and look at the ceilings directly under the bathroom. Block viewings are rushed, so arrive early and stay to the end.`],
    ['6. Get a survey, or at least a builder’s opinion', `You can commission a survey before an auction exactly as you would for any purchase. If time is short, pay a builder for an hour on site and a rough price for the work. Either way you want the damp, the roof and the electrics priced before you bid, because afterwards they are yours.`],
    ['7. Have the money ready before you bid', `You will normally pay a 10% deposit on the day and the balance within 28 days. Some lots complete in 14. Know exactly where both payments are coming from. If you need to borrow, get a decision in principle from a lender or broker who understands auction timescales before you register.`],
    ['8. Check the property can be mortgaged', `Lenders turn down homes with no working kitchen or bathroom, short leases, some kinds of non-standard construction and flats above certain shops. If a mainstream mortgage is out, you may need bridging finance to buy and a refinance later, which costs more. Find this out now.`],
    ['9. Add up the fees', `On top of the hammer price, expect a buyer’s administration fee, usually several hundred pounds plus VAT. Some auction houses also charge a buyer’s premium, a percentage of the price. Stamp duty is due on the usual timetable. Put all of it in one column so nothing surprises you.`],
    ['10. Read the title plan against the ground', `Stand in the garden with the title plan and compare the red line with the fences. Check who owns the driveway, whether the neighbour has a right of way and whether the garage at the end is included. Boundary and access problems are a common reason a lot is in the auction at all.`],
    ['11. Ask who is living there', `Vacant possession should be stated in the pack. If the property is tenanted, find out what kind of tenancy it is, whether the rent is up to date and where the deposit is held. Buying with a sitting tenant can be a good deal, but only if that is the deal you meant to do.`],
    ['12. Understand the two kinds of sale', `In a traditional, or unconditional, auction you exchange when the hammer falls. In the modern method you pay a reservation fee and get a set period, often 56 days, to exchange and complete. The reservation fee is usually not part of the price, so it is an extra cost.`],
    ['13. Look at the addendum on the day', `Auctioneers publish a sheet of late changes on the morning of the sale. Lots are withdrawn, guide prices move and conditions are corrected. It is read out before bidding starts and it forms part of the contract, whether or not you were listening.`],
    ['14. Set a limit and write it down', `Work out your maximum at home, with the fees and the building work included, and write the number on the catalogue. Auction rooms are designed to be exciting. The buyers who do well are the ones who put their hand down when the bidding passes their figure.`],
    ['15. Arrange insurance for the moment you win', `Risk passes to you when the hammer falls, not when you get the keys. If the house floods that night, it is your loss. Line up a buildings insurance quote in advance so that one phone call from the car park puts cover in place.`],
  ]),
  conclusion: `None of this is difficult, but all of it has to happen before auction day and not after. If you would like a second pair of eyes on a legal pack or a lot you have spotted, we are happy to look. You can see how that works on our [pre-auction review page](https://www.kestrelauctions.example/services/pre-auction-review).`,
  cta: { label: 'Book a pre-auction review', url: 'https://www.kestrelauctions.example/book' },
  faqs: [
    { q: 'Can you get a mortgage on an auction property?', a: 'Yes, provided the property is one a lender will accept and the lender can move fast enough. Many buyers use a bridging loan to complete inside 28 days and then switch to a mortgage.' },
    { q: 'How much deposit do you need at auction?', a: 'Normally 10% of the hammer price, paid on the day by bank transfer or debit card, along with the buyer’s administration fee. Some auction houses set a minimum deposit of a few thousand pounds.' },
    { q: 'What happens if you pull out after the hammer falls?', a: 'You lose your deposit, and the seller can also claim any loss if the property later sells for less. Once the hammer falls you are legally committed to complete.' },
  ],
  citations: [cite('https://www.gov.uk/guidance/sdlt-residential-property-rates', 'HMRC: Stamp Duty Land Tax rates')],
  image: img('https://www.kestrelauctions.example/img/room.jpg', 'Bidders holding catalogues in a property auction room'), author: null } as unknown as ArticleBody };

// ───────── R: a recipe-style step list with short imperative sentences ─────────
export const R: GoodArticle = { site: 'https://www.harperheating.example', brief: { targetQuery: 'how to change a tap washer', searchIntent: 'learn',
  relatedQuestions: ['Do you need to turn the water off to change a tap washer?', 'What size tap washer do I need?', 'Why is my tap still dripping after changing the washer?'] },
body: { title: 'How to change a tap washer', seoTitle: 'How to change a tap washer and stop a dripping tap',
  metaDescription: 'A dripping tap usually needs a new washer. Here is how to change a tap washer in about twenty minutes, with a list of the tools you need.',
  excerpt: 'Stop a dripping tap in twenty minutes.', slug: 'how-to-change-a-tap-washer',
  intro: `A tap that drips from the spout nearly always has a worn washer. The fix costs pennies. This is how to change a tap washer on an ordinary kitchen or basin tap with separate hot and cold handles.\n\nSet aside twenty minutes. Read the steps through once before you pick up a spanner.`,
  sections: sec([
    ['What you need', `Gather these first. You do not want to go hunting with the water off.\n\n- an adjustable spanner\n- a flat-headed screwdriver and a cross-headed one\n- a new washer, or a mixed pack\n- an old cloth\n- a little silicone grease`],
    ['Do you need to turn the water off to change a tap washer?', `Yes. Always. Find the isolation valve on the pipe under the sink. It has a small slot in it. Turn the slot across the pipe with a screwdriver. That shuts it.\n\nNo valve? Turn off the stopcock instead. It is usually under the kitchen sink. Then open the tap. Let it run until it stops. Put the plug in. Screws love plugholes.`],
    ['Take the tap apart', `Work slowly. Old taps are brittle.\n\n1. Prise off the cap on top of the handle. Use the flat screwdriver.\n2. Undo the screw underneath. Keep it safe.\n3. Lift the handle off. Wiggle it if it sticks.\n4. Unscrew the metal cover, if there is one. Hand pressure is normally enough.\n5. Wrap the cloth round the tap body. Grip it.\n6. Fit the spanner to the large nut. Turn it anticlockwise.\n7. Lift out the whole valve.`],
    ['Swap the washer', `Turn the valve over. The washer sits on the bottom. A small nut or a button holds it.\n\n1. Undo the nut, or prise the washer off the button.\n2. Take the old washer to the shop if you are unsure of the size.\n3. Press the new washer on. It must sit flat.\n4. Refit the nut. Nip it up. Do not force it.\n5. Smear a little grease on the threads.`],
    ['What size tap washer do I need?', `Most basin and kitchen taps take a half-inch washer. Bath taps take three-quarter inch. Measure the old one if you can. Take it with you. A mixed pack costs about two pounds and covers both.`],
    ['Put it back together', `Reverse the steps.\n\n1. Lower the valve into the tap body.\n2. Tighten the large nut. Firm is enough.\n3. Refit the cover and the handle.\n4. Replace the screw and the cap.\n5. Close the tap.\n6. Turn the water back on. Go slowly.\n7. Open the tap. Let the air splutter out.\n8. Close it. Watch the spout for a minute.`],
    ['Why is my tap still dripping after changing the washer?', `Check the washer first. Is it the right size? Is it sitting flat? If so, look at the seat. That is the brass ring the washer presses on. A pitted seat will chew up a new washer in weeks. You can regrind it with a cheap tool, or fit a plastic seat insert.\n\nSome taps have no washer at all. A quarter-turn tap uses a ceramic cartridge. Those are replaced whole. If yours is one of these, or the seat is beyond saving, [our tap repair service](https://www.harperheating.example/services/tap-repairs) can sort it in one visit.`],
  ]),
  conclusion: `That is the whole job. Keep the spare washers in a drawer. The other tap will be next.`,
  cta: { label: 'Book a tap repair', url: 'https://www.harperheating.example/book' },
  faqs: [
    { q: 'How long does a tap washer last?', a: 'Several years in normal use. Hard water and overtightening the tap both shorten its life, so close the tap gently and stop when the water stops.' },
    { q: 'Can I change a washer on a mixer tap?', a: 'Yes, if the mixer has two handles. Each handle has its own valve and washer, and the steps are the same. Single-lever mixers use a cartridge.' },
    { q: 'Is a dripping tap expensive to ignore?', a: 'It adds up. A steady drip can waste thousands of litres a year, and a dripping hot tap wastes the energy used to heat that water as well.' },
  ],
  citations: [cite('https://www.waterwise.org.uk/save-water/', 'Waterwise: save water at home')],
  image: img('https://www.harperheating.example/img/washer.jpg', 'A brass tap valve with a new rubber washer beside a spanner'), author: null } as unknown as ArticleBody };

// ───────── G: a glossary ─────────
export const G: GoodArticle = { site: 'https://www.fernleymortgages.example', brief: { targetQuery: 'mortgage terms explained', searchIntent: 'learn',
  relatedQuestions: ['What does LTV mean on a mortgage?', 'What is the difference between a fixed and a tracker mortgage?', 'What is an early repayment charge?'] },
body: { title: 'Mortgage terms explained: a plain-English glossary', seoTitle: 'Mortgage terms explained: a plain-English glossary',
  metaDescription: 'Mortgage terms explained without the jargon. Twenty words and abbreviations you will meet when you borrow, each with a one-line example.',
  excerpt: 'Twenty mortgage words in plain English.', slug: 'mortgage-terms-explained',
  intro: `Mortgage paperwork has a language of its own. Here are the common mortgage terms explained in plain English, grouped by the stage at which you are likely to meet them. Each entry is short on purpose. Where a number helps, we have used one.`,
  sections: sec([
    ['Borrowing and deposits', `- **Deposit**: the part of the price you pay from your own money. On a £250,000 home, a 10% deposit is £25,000.\n- **Loan to value (LTV)**: the loan as a percentage of the property’s value. Borrow £225,000 against £250,000 and your LTV is 90%.\n- **Equity**: the share of the home you own outright. It is the value minus what you still owe.\n- **Affordability assessment**: the lender’s check that you can meet the payments, based on your income and regular spending.\n- **Decision in principle**: a lender’s written estimate of what it would lend you, given before you find a property. It is not a guarantee.\n- **Guarantor**: somebody, usually a parent, who agrees to make the payments if you cannot.`],
    ['What does LTV mean on a mortgage, and why does it matter?', `LTV stands for loan to value. Lenders price their deals in LTV bands, typically 60%, 75%, 85%, 90% and 95%. The lower your band, the less risk the lender takes and the lower the interest rate tends to be. Moving down a band, even by a small amount, can open up cheaper deals, which is why a slightly larger deposit sometimes saves more than you would expect.`],
    ['Rates and deals', `- **Fixed rate**: the interest rate stays the same for a set period, commonly two or five years, so your payment does not change.\n- **Tracker**: the rate follows the Bank of England base rate at a set margin above it. When the base rate moves, so does your payment.\n- **Standard variable rate (SVR)**: the lender’s default rate, which you move on to when a deal ends. It is usually the most expensive option.\n- **Discount rate**: a set reduction on the SVR for an agreed period. It rises and falls when the lender changes its SVR.\n- **Annual percentage rate of charge (APRC)**: one figure that combines the rate and the fees over the whole term, so that deals can be compared.\n- **Product transfer**: switching to a new deal with the lender you already have, without moving your mortgage elsewhere.`],
    ['What is the difference between a fixed and a tracker mortgage?', `A fixed mortgage gives you certainty. Your payment is the same every month until the fixed period ends, whatever happens to interest rates in the meantime. A tracker gives you movement. If the base rate falls you pay less straight away, and if it rises you pay more. People who need a predictable budget tend to fix. People with room in their budget, who think rates will fall, sometimes prefer to track.`],
    ['Fees and charges', `- **Arrangement fee**: the lender’s charge for setting up the deal, sometimes called a product fee. It can often be added to the loan, though you then pay interest on it.\n- **Valuation fee**: the cost of the lender’s own check that the property is worth the price. It is for the lender’s benefit and is not a survey.\n- **Early repayment charge (ERC)**: a penalty for paying off the loan, or more than the permitted amount, during the deal period.\n- **Exit fee**: a small administration charge when the mortgage is finally repaid.\n- **Stamp duty**: the tax paid to the government when you buy property above a certain price. It is separate from the mortgage but due at completion.`],
    ['What is an early repayment charge?', `An early repayment charge is what the lender bills you for leaving a deal before it ends. It is usually a percentage of the amount repaid, and it often steps down each year. On a five-year fix it might be 5% in year one and 1% in year five. Most deals let you overpay up to 10% of the balance a year without triggering it. Always check the charge before you remortgage or move.`],
    ['From offer to completion', `- **Mortgage offer**: the lender’s formal agreement to lend, normally valid for three to six months.\n- **Conveyancing**: the legal work of transferring ownership, carried out by a solicitor or licensed conveyancer.\n- **Exchange of contracts**: the point at which buyer and seller become legally bound. The deposit is paid here.\n- **Completion**: the day the money moves, the keys are released and the home becomes yours.\n- **Redemption statement**: a letter from a lender showing exactly how much is needed to pay a mortgage off on a given date.`],
  ]),
  conclusion: `If a word in your own paperwork is not on this list, ask. A good adviser would much rather explain a term twice than have you sign something you do not follow. You can [put a question to one of our advisers](https://www.fernleymortgages.example/advice/ask-a-question) at any time.`,
  cta: { label: 'Talk to a mortgage adviser', url: 'https://www.fernleymortgages.example/contact' },
  faqs: [
    { q: 'What is a remortgage?', a: 'Replacing your current mortgage with a new one, usually with a different lender, without moving home. People do it to get a better rate or to borrow more.' },
    { q: 'What does porting a mortgage mean?', a: 'Taking your existing mortgage deal with you when you move house. The lender has to approve the new property and reassess what you can afford.' },
    { q: 'What is a mortgage term?', a: 'The length of time over which the loan is repaid. Twenty-five years is traditional, although terms of thirty or thirty-five years are now common.' },
  ],
  citations: [cite('https://www.moneyhelper.org.uk/en/homes/buying-a-home/mortgage-jargon-buster', 'MoneyHelper: mortgage jargon buster')],
  image: img('https://www.fernleymortgages.example/img/paperwork.jpg', 'A mortgage offer letter on a desk with a pen and reading glasses'), author: null } as unknown as ArticleBody };

// ───────── Q: an article that quotes a regulation at length ─────────
export const Q: GoodArticle = { site: 'https://www.oakandashgardenrooms.example', brief: { targetQuery: 'permitted development rules for outbuildings', searchIntent: 'learn',
  relatedQuestions: ['What is Class E permitted development?', 'How high can an outbuilding be under permitted development?', 'Does permitted development apply in a conservation area?'] },
body: { title: 'Permitted development rules for outbuildings: what the law actually says', seoTitle: 'Permitted development rules for outbuildings: the law itself',
  metaDescription: 'The permitted development rules for outbuildings come from one short piece of law. We quote the wording and explain each limit in plain English.',
  excerpt: 'The wording of the outbuilding rules, with a plain-English reading.', slug: 'permitted-development-rules-for-outbuildings',
  intro: `Most guides to the permitted development rules for outbuildings paraphrase the law. That is helpful until you are standing in the garden with a tape measure and a neighbour with a different opinion. So this article does it the other way round. It sets out the wording first, then says what each part means in practice.\n\nThe text below is our working summary of the conditions as they apply in England. Always check the current legislation and the government’s technical guidance before you build.`,
  sections: sec([
    ['What is Class E permitted development?', `Class E is the part of the permitted development order that deals with buildings in the garden of a house. It permits:\n\n“The provision within the curtilage of the dwellinghouse of any building or enclosure, swimming or other pool required for a purpose incidental to the enjoyment of the dwellinghouse as such, or the maintenance, improvement or other alteration of such a building or enclosure.”\n\nThree phrases do the work. “Curtilage” means the garden and grounds that belong with the house. “Dwellinghouse” means a house, not a flat. “Incidental to the enjoyment of the dwellinghouse” means the building must serve the home, which is why a shed, a studio or an office for your own use qualifies and a separate home does not.`],
    ['The limits, in the words of the order', `Development is not permitted by Class E if any of the following applies:\n\n“(a) the total area of ground covered by buildings, enclosures and containers within the curtilage (other than the original dwellinghouse) would exceed 50% of the total area of the curtilage (excluding the ground area of the original dwellinghouse);\n\n(b) any part of the building, enclosure, pool or container would be situated on land forward of a wall forming the principal elevation of the original dwellinghouse;\n\n(c) the building would have more than a single storey;\n\n(d) the height of the building, enclosure or container would exceed (i) 4 metres in the case of a building with a dual-pitched roof, (ii) 2.5 metres in the case of a building, enclosure or container within 2 metres of the boundary of the curtilage of the dwellinghouse, or (iii) 3 metres in any other case;\n\n(e) the height of the eaves of the building would exceed 2.5 metres;\n\n(f) the building, enclosure, pool or container would be situated within the curtilage of a listed building;\n\n(g) it would include the construction or provision of a verandah, balcony or raised platform;\n\n(h) it relates to a dwelling or a microwave antenna; or\n\n(i) the capacity of the container would exceed 3,500 litres.”`],
    ['How high can an outbuilding be under permitted development?', `Paragraphs (d) and (e) answer this between them, and they are the ones people get wrong. Read them as a short series of tests.\n\nFirst, is any part of the building within 2 metres of the boundary? If so, nothing may be higher than 2.5 metres, whatever the shape of the roof. Second, if the building is further in, does it have a dual-pitched roof? Then the ridge may reach 4 metres. Any other roof, including a flat or single-slope one, stops at 3 metres. Third, in every case the eaves must be no higher than 2.5 metres.\n\nHeight is measured from the highest ground next to the building. A “raised platform” under paragraph (g) is taken in the guidance to mean anything more than 0.3 metres high, which is why low decking is usually fine and a balcony never is.`],
    ['Covering half the garden', `Paragraph (a) is about the whole plot, not the one building you are planning. Everything added since the house was first built counts towards the 50%: extensions, sheds, greenhouses and oil tanks included. The “original dwellinghouse” is the house as it stood on 1 July 1948, or as built if later.\n\nIn practice this limit rarely stops a garden room in an ordinary garden. It does catch small plots where a previous owner has already extended twice.`],
    ['Does permitted development apply in a conservation area?', `It does, with extra restrictions. The order goes on to say that on what it calls article 2(3) land, which includes conservation areas:\n\n“development is not permitted by Class E if any part of the building, enclosure, pool or container would be situated on land between a wall forming a side elevation of the dwellinghouse and the boundary of the curtilage of the dwellinghouse.”\n\nSo in a conservation area nothing may go at the side of the house without an application. In national parks, areas of outstanding natural beauty and World Heritage Sites there is a further limit of 10 square metres on buildings more than 20 metres from the house. A council can also remove these rights altogether with an Article 4 direction, so a quick check with the planning department is always worthwhile.`],
    ['What the wording does not cover', `Class E is about planning. It says nothing on how a building is constructed, which is the business of building regulations, and nothing on private matters such as covenants in your deeds. A building can satisfy every paragraph above and still need building regulations approval for its electrics.\n\nIf you would like us to read your plot against the order, that is part of [our free site survey](https://www.oakandashgardenrooms.example/site-survey).`],
  ]),
  conclusion: `The rules are shorter than their reputation suggests: half the plot, behind the front wall, one storey, three height limits and no balconies. Read the wording once with your own garden in mind and most questions answer themselves.`,
  cta: { label: 'Book a free site survey', url: 'https://www.oakandashgardenrooms.example/site-survey' },
  faqs: [
    { q: 'Do flats have permitted development rights for outbuildings?', a: 'No. Class E applies to a dwellinghouse, and a flat or maisonette is not one for this purpose. An outbuilding for a flat needs a planning application.' },
    { q: 'Can I get written proof that my outbuilding is lawful?', a: 'Yes. You can apply to the council for a lawful development certificate. It is optional, there is a fee, and it is useful evidence when you sell.' },
    { q: 'Are the rules the same in Wales and Scotland?', a: 'They are similar but not identical. Each nation has its own order with its own measurements, so check the rules for where the property is.' },
  ],
  citations: [cite('https://www.legislation.gov.uk/uksi/2015/596/schedule/2/part/1/crossheading/class-e-buildings-etc-incidental-to-the-enjoyment-of-a-dwellinghouse', 'The Town and Country Planning (General Permitted Development) (England) Order 2015, Class E')],
  image: img('https://www.oakandashgardenrooms.example/img/tape.jpg', 'A tape measure held against the eaves of a timber garden building'), author: null } as unknown as ArticleBody };

// ───────── Y: a short "buy" page of about 550 words ─────────
export const Y: GoodArticle = { site: 'https://www.harperheating.example', brief: { targetQuery: 'boiler service Leeds', searchIntent: 'buy',
  relatedQuestions: ['How much does a boiler service cost in Leeds?', 'How long does a boiler service take?', 'How often should a boiler be serviced?'] },
body: { title: 'Boiler service in Leeds', seoTitle: 'Boiler service Leeds: fixed price, Gas Safe engineers | Harper Heating',
  metaDescription: 'Book a boiler service in Leeds for a fixed £79. Gas Safe registered engineers, evening and Saturday visits, and a written report the same day.',
  excerpt: 'A fixed-price boiler service across Leeds.', slug: 'boiler-service-leeds',
  intro: `Looking for a boiler service in Leeds? Harper Heating services gas boilers across the city for a fixed £79, including VAT. Every visit is carried out by one of our own Gas Safe registered engineers, and you get a written report before we leave.`,
  sections: sec([
    ['What a boiler service includes', `A proper service takes the case off. Ours follows the manufacturer’s schedule for your model and always covers:\n\n- a visual check of the boiler, flue and pipework\n- a flue gas analysis to confirm the boiler is burning cleanly\n- gas pressure and gas rate checks\n- cleaning the condensate trap and, where needed, the burner\n- testing the safety devices and the controls\n- checking system pressure and the expansion vessel\n\nIf we find a fault, we explain it and give you a price before doing anything further. Nothing is added to the bill without your say-so.`],
    ['How much does a boiler service cost in Leeds?', `Our price is £79 for any gas combi, system or regular boiler, wherever you are in Leeds. There is no call-out charge and no extra for evenings or Saturdays. Landlords who need a gas safety certificate at the same visit pay £99 for both. If a part is needed, we quote separately and you decide.`],
    ['How long does a boiler service take?', `Allow about 45 minutes. Older boilers and those in awkward cupboards can take up to an hour. We give you a two-hour arrival window, and the engineer rings when they are on the way, so you are not kept waiting in all day.`],
    ['Where we work', `We cover every LS postcode from LS1 to LS29, including Headingley, Roundhay, Horsforth, Pudsey, Morley, Garforth and Otley. Our engineers live locally, which keeps travelling time short and means we can usually offer a visit within three working days.`],
    ['How often should a boiler be serviced?', `Once a year. Most manufacturers make an annual service a condition of the warranty, and a boiler that is checked every twelve months is less likely to fail on the coldest morning of the winter. Early autumn is the best time to book. If your boiler is also due some attention on the heating side, have a look at [our power flushing service](https://www.harperheating.example/services/power-flushing).`],
  ]),
  conclusion: `Booking takes two minutes. Choose a time online or ring 0113 496 0123, and we will confirm by text.`,
  cta: { label: 'Book a boiler service', url: 'https://www.harperheating.example/book' },
  faqs: [
    { q: 'Are your engineers Gas Safe registered?', a: 'Yes, every one of them. The engineer will show you a Gas Safe ID card on arrival, and you can check the number on the Gas Safe Register website.' },
    { q: 'Do you service all makes of boiler?', a: 'We service all the main makes, including Worcester Bosch, Vaillant, Ideal, Baxi and Viessmann. Tell us the make and model when you book so the engineer brings the right parts.' },
    { q: 'Will I get a certificate after the boiler service?', a: 'You get a written service report by email the same day. Landlords can add a gas safety certificate to the boiler service for a small extra charge.' },
  ],
  citations: [cite('https://www.gassaferegister.co.uk/gas-safety/gas-safety-in-the-home/get-your-appliances-checked/', 'Gas Safe Register: get your appliances checked')],
  image: img('https://www.harperheating.example/img/engineer.jpg', 'A Harper Heating engineer servicing a wall-hung gas boiler'), author: null } as unknown as ArticleBody };


// ─── Rubbish, round two ──────────────────────────────────────────────────────

const brief = F.brief();
const P = 'appraise a property deal';
const QS = brief.relatedQuestions;
let seed = 11; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const pick = <T,>(a: readonly T[]) => a[Math.floor(rnd() * a.length)]!;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const NOUN = `cat dog sun moon tree road shoe hat milk bread stone river cloud field barn gate lamp desk chair spoon fork plate bowl cup jar lid pen page book shelf door wall roof floor step path hill lake pond fish bird frog bee fox owl hen pig cow goat lamb wolf bear deer hare crab seal swan duck goose crow dove hawk moth snail worm rose fern moss reed oak elm pine plum pear fig lime bean pea corn rice oat salt jam pie cake bun tea soup stew egg ham nut seed leaf root stem bark twig log coal sand clay mud dust rain snow hail fog mist wind storm frost dew tide wave reef bay cove dock pier ship boat raft sail oar mast deck rope knot hook net trap cage yard farm mill forge shop inn hall hut tent camp fort town port bridge lane street park bell drum horn harp flute pipe song tune verse word name sign mark ring loop bend curve edge window garden kitchen cellar attic stable orchard meadow harbour village market chapel tower tunnel valley forest desert island castle cottage`.split(/\s+/);
const ADJ = `old new big small wet dry cold warm red green blue grey tall short wide thin soft hard loud quiet bright dark clean muddy heavy light empty full round flat sharp blunt fresh stale sweet sour quick slow young proud shy calm brave odd plain neat rough smooth`.split(/\s+/);
const VERB = `kept found moved held saw took left met hid sold bought washed carried counted painted mended borrowed followed lifted opened closed pushed pulled watched cleaned filled fixed dropped passed crossed climbed reached covered packed`.split(/\s+/);
const VBASE = `keep find move hold see take leave meet hide sell buy wash carry count paint mend borrow follow lift open close push pull watch clean fill fix drop pass cross climb reach cover pack`.split(/\s+/);
const DET = ['the', 'a', 'this', 'that', 'each', 'every', 'some', 'any', 'my', 'your', 'our', 'their', 'his', 'her'];
const PREP = ['in', 'on', 'at', 'by', 'with', 'from', 'under', 'over', 'near', 'beside', 'behind', 'across', 'through', 'around', 'before', 'after'];
const LINK = ['because', 'so', 'although', 'while', 'since', 'unless', 'but', 'then', 'yet', 'however', 'instead', 'also'];
const np = () => `${pick(DET)} ${rnd() < 0.5 ? pick(ADJ) + ' ' : ''}${pick(NOUN)}`;
// A: grammatical-looking filler with plenty of joining words
const madlib = (): string => { const r = rnd();
  if (r < 0.3) return cap(`${np()} ${pick(VERB)} ${np()} ${pick(PREP)} ${np()}.`);
  if (r < 0.6) return cap(`${np()} ${pick(VERB)} ${pick(PREP)} ${np()} ${pick(LINK)} ${np()} was ${pick(PREP)} ${np()}.`);
  if (r < 0.75) return `It is the case that ${np()} and ${np()} are ${pick(PREP)} ${np()}.`;
  if (r < 0.9) return `When ${np()} is ${pick(ADJ)}, ${np()} can ${pick(VBASE)} ${np()} ${pick(PREP)} ${np()}.`;
  return `You should ${pick(VBASE)} ${np()} ${pick(PREP)} ${np()} before ${np()} ${pick(VERB)} it.`; };
// B: the coordinator's exact family
const caseThat = () => `It is the case that the ${pick(NOUN)} and the ${pick(NOUN)} are in the ${pick(NOUN)}.`;
// C: four template sentences, three words swapped each time
const T = [(a: string, b: string, c: string) => `A good ${a} should always think about the ${b} before making any ${c} at all.`,
  (a: string, b: string, c: string) => `Many people forget the ${a} because they want a ${b} and cannot wait for the ${c}.`,
  (a: string, b: string, c: string) => `However, the right ${a} will usually save your ${b} from a great deal of ${c}.`,
  (a: string, b: string, c: string) => `In the end, every ${a} depends on its own ${b}, so choose the ${c} that suits you.`];
let tk = 0; const templ = () => T[tk++ % T.length]!(pick(NOUN), pick(NOUN), pick(NOUN));
// D: synonym-spun platitudes (real words, says nothing)
const o = (...x: string[]) => pick(x);
const SPUN = [
  () => `It is ${o('always', 'usually', 'often', 'nearly always')} a ${o('good', 'sound', 'wise', 'smart', 'sensible', 'prudent')} ${o('idea', 'plan', 'move', 'step', 'habit', 'rule')} to ${o('think', 'reflect', 'reason', 'ponder')} about your ${o('goals', 'aims', 'targets', 'plans', 'hopes', 'wishes')} before you ${o('spend', 'use', 'commit', 'invest', 'risk')} any ${o('money', 'cash', 'funds', 'savings', 'capital')}.`,
  () => `${o('Many', 'Most', 'Some', 'Plenty of')} ${o('people', 'buyers', 'investors', 'owners', 'beginners')} ${o('forget', 'miss', 'skip', 'ignore', 'overlook')} this ${o('point', 'step', 'lesson', 'detail')}, because they are in a ${o('hurry', 'rush', 'race', 'scramble')} to ${o('start', 'begin', 'launch', 'open')} something ${o('new', 'fresh', 'exciting', 'different')}.`,
  () => `However, a ${o('clear', 'careful', 'steady', 'simple', 'solid', 'tidy')} ${o('plan', 'method', 'routine', 'system', 'approach')} will ${o('usually', 'often', 'generally', 'normally')} ${o('save', 'spare', 'protect')} you ${o('time', 'effort', 'worry', 'stress', 'trouble')} over the ${o('months', 'weeks', 'years', 'seasons')} that ${o('follow', 'come', 'lie ahead')}.`,
  () => `You ${o('should', 'could', 'might', 'may')} also ${o('speak', 'talk', 'listen', 'turn')} to a ${o('trusted', 'seasoned', 'friendly', 'patient', 'local')} ${o('adviser', 'expert', 'mentor', 'friend', 'guide')} who ${o('understands', 'knows', 'sees', 'respects')} what you ${o('want', 'need', 'hope', 'mean')} to ${o('achieve', 'build', 'reach', 'gain')}.`,
  () => `In the end, the ${o('right', 'best', 'wisest', 'safest')} ${o('choice', 'answer', 'path', 'route', 'option')} depends on your own ${o('needs', 'wishes', 'limits', 'means')}, your ${o('budget', 'purse', 'income', 'pocket')} and how much ${o('risk', 'doubt', 'change', 'delay')} you can ${o('accept', 'bear', 'stand', 'carry')}.`,
  () => `Every ${o('investor', 'buyer', 'owner', 'person', 'family')} is ${o('different', 'unique', 'special', 'distinct')}, so ${o('take', 'pick', 'choose', 'follow')} the ${o('road', 'route', 'course', 'way')} that ${o('suits', 'fits', 'serves', 'helps')} you and not ${o('somebody', 'someone', 'anybody', 'anyone')} else.`,
  () => `${o('Remember', 'Note', 'Recall', 'Accept')} that a ${o('decision', 'choice', 'promise', 'target', 'budget')} ${o('made', 'set', 'fixed', 'agreed')} ${o('today', 'this week', 'this month', 'now')} can ${o('still', 'always', 'easily')} be ${o('reviewed', 'changed', 'revisited', 'adjusted')} when ${o('things', 'markets', 'plans', 'prices')} ${o('change', 'shift', 'move', 'turn')}.`,
];
let sk = 0; const spun = () => SPUN[sk++ % SPUN.length]!();
// N0: word salad with small words sprinkled in (not grammatical at all)
const SMALL = ['the', 'of', 'is', 'to', 'in', 'and', 'a', 'it', 'that', 'on', 'for', 'with', 'as', 'was', 'by', 'at', 'from', 'this', 'are', 'or', 'be', 'but', 'not', 'you', 'we', 'so', 'if', 'they', 'because', 'while'];
const sprinkled = () => cap(Array.from({ length: 11 }, () => (rnd() < 0.36 ? pick(SMALL) : pick(NOUN))).join(' ') + '.');

const OPEN = ['In most cases', 'As a rule', 'More often than not', 'Sooner or later', 'Broadly speaking', 'In our experience', 'Truth be told', 'On balance', 'By and large', 'As things stand', 'From time to time', 'In the long run', 'Day to day', 'All things considered', 'Looking back', 'Put simply', 'Without doubt', 'In practice', 'Quite often', 'These days'];
const SUBJ = ['a careful buyer', 'the wise investor', 'every new landlord', 'a patient owner', 'the average family', 'a first-time buyer', 'any sensible person', 'the busy professional', 'a thoughtful couple', 'the seasoned developer', 'an honest seller', 'the cautious lender', 'a good neighbour', 'the keen beginner', 'a steady saver', 'the local agent', 'an older client', 'the younger partner', 'a modest household', 'the experienced builder'];
const VERBP = ['tends to value', 'comes to respect', 'should never ignore', 'learns to welcome', 'often overlooks', 'quietly depends on', 'eventually meets', 'can always improve', 'rarely regrets', 'must weigh up', 'is right to expect', 'will happily accept', 'does well to keep', 'soon begins to notice', 'has reason to trust', 'would rather have', 'ought to plan for', 'might well prefer', 'usually ends with', 'gladly returns to'];
const OBJ = ['a steady routine', 'the bigger picture', 'sound advice', 'a clear plan', 'good timing', 'the small details', 'honest numbers', 'a second opinion', 'plain common sense', 'the longer view', 'a fair outcome', 'real peace of mind', 'a sensible margin', 'the right moment', 'open conversation', 'a simple checklist', 'proper preparation', 'a realistic budget', 'the next step', 'lasting value'];
const TAIL = ['because it pays later', 'so things feel easier', 'although effort is needed', 'while others rush ahead', 'since nothing stands still', 'for years to come', 'with a calm head', 'at every single stage', 'in good times and bad', 'on the road ahead', 'from the very start', 'without too much fuss', 'after a little thought', 'before the moment passes', 'whatever the market does', 'as plans take shape', 'when pressure is on', 'in a changing world', 'however the week goes', 'instead of guessing'];
const platitude = () => `${pick(OPEN)}, ${pick(SUBJ)} ${pick(VERBP)} ${pick(OBJ)} ${pick(TAIL)}.`;
const T12 = [...T,
  (a: string, b: string, c: string) => `Before you sign anything, look at the ${a} and ask whether the ${b} is worth the ${c}.`,
  (a: string, b: string, c: string) => `Nobody likes a ${a}, yet a ${b} handled early is far better than a ${c} left late.`,
  (a: string, b: string, c: string) => `We tell every client that the ${a} matters more than the ${b}, whatever the ${c} may say.`,
  (a: string, b: string, c: string) => `If the ${a} looks wrong, step back from the ${b} and take a second look at the ${c}.`,
  (a: string, b: string, c: string) => `Your ${a} is only as strong as the ${b} behind it, which is where a ${c} comes in.`,
  (a: string, b: string, c: string) => `Try to picture the ${a} a year from now, with the ${b} finished and the ${c} paid for.`,
  (a: string, b: string, c: string) => `There is no shame in asking about the ${a}, since the ${b} often hides inside the ${c}.`,
  (a: string, b: string, c: string) => `Once the ${a} is settled, the ${b} tends to follow, and the ${c} looks after itself.`];
let t12 = 0; const templ12 = () => T12[t12++ % T12.length]!(pick(NOUN), pick(NOUN), pick(NOUN));

const STUFF = ['Take your time when you appraise a property deal for the very first time.', 'Nobody can appraise a property deal well without a calm head and a notebook.', 'We always appraise a property deal twice, once on paper and once in person.', 'Good investors appraise a property deal slowly and then act on it quickly.', 'Ask a friend to appraise a property deal alongside you and compare your notes.', 'It pays to appraise a property deal on a wet day as well as a dry one.', 'Before lunch is the best time to appraise a property deal with fresh eyes.', 'Learn to appraise a property deal from the street before you step inside.', 'Our clients appraise a property deal faster once they have a simple routine.', 'Never appraise a property deal in a hurry just because the agent is waiting.', 'Some buyers appraise a property deal by gut feel and regret it afterwards.', 'To appraise a property deal fairly you must ignore the asking price at first.', 'Smart landlords appraise a property deal against the rent it could earn.', 'Couples should appraise a property deal together so nothing is missed.', 'Builders appraise a property deal by the cost of the work it needs.', 'Lenders appraise a property deal in their own way, as we explain below.', 'Anyone can appraise a property deal after a little practice with real examples.', 'Remember to appraise a property deal again if the survey brings surprises.', 'Brokers appraise a property deal with the mortgage in mind from the start.', 'You can appraise a property deal on your phone while standing in the garden.', 'Friends who appraise a property deal for you may miss what matters to you.', 'Agents rarely appraise a property deal the way a careful buyer would.', 'Families appraise a property deal with schools and transport near the top.', 'Sellers appraise a property deal too, from the other side of the table.'];

export interface BuildOptions { parts?: number; per?: number; picture?: boolean; extra?: (i: number) => string; breaks?: boolean }
function build(gen: () => string, o: BuildOptions = {}): ArticleBody {
  const parts = o.parts ?? 9, per = o.per ?? 10;
  const para = (k: number) => o.breaks === false ? Array.from({ length: k }, gen).join(' ') : Array.from({ length: k }, (_, i) => gen() + ((i + 1) % 4 === 0 && i + 1 < k ? '\n\n' : ' ')).join('').trim();
  const secs = [{ id: 's0', heading: `How to ${P} in plain steps`, body: `When you ${P}, keep the following thoughts in mind every time. ${para(per)}` }] as { id: string; heading: string; body: string }[];
  QS.forEach((q, i) => secs.push({ id: `q${i}`, heading: q, body: `${q.replace(/\?$/, '').replace(/^(How|What) (do|does|should|long should) /i, '')} is something people often ask us about. ${para(per)}` }));
  for (let i = secs.length; i < parts; i++) secs.push({ id: `s${i}`, heading: `${cap(pick(ADJ))} ${pick(NOUN)} and ${pick(ADJ)} ${pick(NOUN)} ${i}`, body: `${i === 5 ? `So before you ${P}, slow down and read the next part twice. ` : ''}${para(per)}${o.extra ? ' ' + o.extra(i) : ''}` });
  secs[1]!.body += ` See our [deal review page](https://www.martinhowardproperty.example/deal-review) and the [official price index](https://example.org/x).`;
  const s = F.strongBody();
  return { ...s, title: 'x', seoTitle: `Appraise a property deal: a plain guide for buyers`, metaDescription: `Learn how to appraise a property deal in plain steps, so you know what to look at first and what can wait until later.`,
    slug: 'appraise-a-property-deal', intro: `This guide shows you how to ${P} without any fuss at all. ${para(3)}`, sections: secs,
    faqs: QS.slice(0, 3).map((q) => ({ q, a: `${q.replace(/\?$/, '')} depends on a few things. ${para(2)}` })), conclusion: para(2),
    cta: { label: 'Book a deal review', url: 'https://www.martinhowardproperty.example/deal-review' },
    image: o.picture === false ? { kind: 'none', url: null, alt: '', provenance: '', width: null, height: null } : { kind: 'brand_asset', url: 'https://www.martinhowardproperty.example/a.jpg', alt: `An investor about to ${P} on a terraced street`, provenance: '', width: 1200, height: 800 } } as ArticleBody;
}
export const REVIEW2_CONTEXT = { siteHosts: ['https://www.martinhowardproperty.example'], selfUrl: 'https://www.martinhowardproperty.example/blog/appraise-a-property-deal', checkIssues: [] as never[], targetMode: true };
export const REVIEW2_BRIEF = brief;
/** Build one of the review's articles with its generator, from the review's seed. */
export function make(gen: () => string, o: BuildOptions = {}): ArticleBody { seed = 11; tk = 0; sk = 0; t12 = 0; return build(gen, o); }
export const GEN = { sprinkled, madlib, caseThat, templ, spun, templ12: () => templ12(), platitude, mixed: () => (rnd() < 0.5 ? madlib() : spun()) };
/** The first-round file built without paragraph breaks; the second with them. */
export const ROUND2_RUBBISH: readonly [string, () => ArticleBody][] = [
  ['N2 "It is the case that the X and the Y are in the Z"', () => make(caseThat, { breaks: false })],
  ['N3 four templates, three words swapped', () => make(templ)],
  ['N3 four templates, no paragraph breaks', () => make(templ, { breaks: false })],
  ['N3b twelve templates, three words swapped', () => make(GEN.templ12)],
  ['N4 spun platitudes, respun in every part', () => make(spun, { breaks: false })],
  ['N5 about 4,900 words of mad-lib and platitudes', () => make(GEN.mixed, { parts: 34, per: 11, breaks: false })],
  ['N5b about 4,900 words of spun platitudes', () => make(spun, { parts: 30, per: 9, breaks: false })],
  ['N5c about 4,900 words of platitudes', () => make(platitude, { parts: 30, per: 11 })],
  ['N7 platitudes, never the same sentence twice', () => make(platitude)],
  ...[14, 18, 20, 22, 24].map((k) => [`N6 spun platitudes + ${k} phrase sentences`, () => make(spun, { parts: 9, per: 9, breaks: false, extra: (i: number) => STUFF.slice((i - 5) * 6, (i - 5) * 6 + 6).filter((_, j) => (i - 5) * 6 + j < k).join(' ') })] as [string, () => ArticleBody]),
];
/** The strong fixture with `k` extra phrase sentences, two to a part (the review's N6b). */
export function strongPlusPhrase(k: number): ArticleBody {
  const st = F.strongBody();
  return { ...st, sections: st.sections.map((x, i) => ({ ...x, body: `${x.body}\n\n${STUFF.slice(i * 2, i * 2 + 2).filter((_, j) => i * 2 + j < k).join(' ')}`.trim() })) } as ArticleBody;
}
/** The known limit: fluent filler and small-word salad that a word-counting score cannot tell from writing. */
export const KNOWN_LIMIT: readonly [string, () => ArticleBody][] = [
  ['N0 word salad with small words sprinkled in', () => make(sprinkled)],
  ['N1 grammatical-looking filler (mad-lib sentences)', () => make(madlib)],
];
