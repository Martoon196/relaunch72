/**
 * Test material from the independent review of the SEO score (copied, not changed in substance):
 * - three good natural articles (a how-to, a comparison, a long guide), each with its brief and site;
 * - the reviewer's rubbish generators: word salad, one empty paragraph repeated with a word swapped, phrase stuffing in
 *   several forms, and padding with one repeated checklist.
 * The score must put every good article in the 90s and every rubbish article at 70 or below.
 */
import type { ArticleBody, ArticleBrief } from '../src/seo-blog/types.js';
import * as sp from './seo-panel-fixtures.js';

export interface GoodArticle { readonly site: string; readonly brief: Pick<ArticleBrief, 'targetQuery' | 'searchIntent' | 'relatedQuestions'>; readonly body: ArticleBody }

const cite = (url: string, title: string) => ({ sourceId: title, url, title, retrievedAt: '2026-11-01T10:00:00.000Z', passage: title, public: true });
const img = (url: string, alt: string) => ({ kind: 'brand_asset', url, alt, provenance: '', width: 1536, height: 1024 });

// ───────── A: how-to with a numbered list ─────────
export const A: GoodArticle = { site: 'https://www.harperheating.example', brief: { targetQuery: 'how to bleed a radiator', searchIntent: 'learn',
  relatedQuestions: ['How often should you bleed radiators?', 'Do you bleed radiators with the heating on or off?', 'Why is my radiator cold at the top?', 'What happens if you don’t bleed your radiators?'] },
body: {
  title: 'How to bleed a radiator in ten minutes', seoTitle: 'How to bleed a radiator: a ten-minute job you can do yourself',
  metaDescription: 'Cold at the top, warm at the bottom? Here is how to bleed a radiator safely with a £2 key, and what to check on the boiler afterwards.',
  excerpt: 'A cold patch at the top of a radiator is trapped air. Letting it out takes ten minutes.', slug: 'how-to-bleed-a-radiator',
  intro: `If a radiator is hot at the bottom and cold at the top, there is air trapped inside it. The air sits where the hot water should be, so the room never quite warms up and the boiler works harder than it needs to. The cure is to let the air out, which heating engineers call bleeding.\n\nHere is how to bleed a radiator yourself. You need a radiator key, an old cloth and about ten minutes.`,
  sections: [
    { id: 'a1', heading: 'What you need before you start', body: `Almost every radiator made in the last fifty years has a small square valve at one of the top corners. A radiator key fits over it. You can buy one for a couple of pounds at any DIY shop, and some modern valves will also take a flat-headed screwdriver.\n\nYou will also want:\n\n- an old cloth or tea towel to catch drips\n- a small bowl or mug if the carpet is pale\n- a pair of gloves if you have just had the heating on\n\nThat is all. You do not need to drain anything or turn off the water.` },
    { id: 'a2', heading: 'Do you bleed radiators with the heating on or off?', body: `Off. Turn the heating off at the programmer and give the radiators twenty minutes or so to cool down.\n\nThere are two reasons. The first is safety: the water in a running system is hot enough to scald, and it comes out of the valve under pressure. The second is that the pump keeps the water moving while the heating is on, which can pull more air into the radiator while you are trying to let it out.` },
    { id: 'a3', heading: 'How to bleed a radiator, step by step', body: `Start with the radiator furthest from the boiler, which in most homes means upstairs, and work your way back towards it.\n\n1. Hold the cloth under the valve and fit the key.\n2. Turn the key anticlockwise, slowly. A quarter of a turn is usually plenty.\n3. Listen for the hiss. That is the air leaving.\n4. Wait. On a badly affected radiator this can take a minute.\n5. When the hiss stops and water starts to dribble out, close the valve by turning the key clockwise.\n6. Wipe the valve dry and move on to the next radiator.\n\nDo not take the valve right out, and do not overtighten it when you close it. Finger-tight with the key is enough. If the water that comes out is dark brown or black, make a note of it. We will come back to that.` },
    { id: 'a4', heading: 'Check the boiler pressure afterwards', body: `Letting air out lowers the pressure in the system, and a boiler that is short of pressure will lock itself out. Once you have been round the house, look at the gauge on the front of the boiler. On most combination boilers the needle should sit between 1 and 1.5 bar when the system is cold.\n\nIf it has dropped below 1, top it up with the filling loop. This is normally a braided silver hose under the boiler with a small lever or tap at one or both ends. Open it gently, watch the needle climb to just over 1, and close it firmly. Your boiler manual will show exactly where it is. Then turn the heating back on and check each radiator after half an hour. They should be warm all the way up.` },
    { id: 'a5', heading: 'How often should you bleed radiators?', body: `Once a year is a sensible habit, and early autumn is the best time, before the first cold snap. It takes less than an hour to go round a three-bedroom house.\n\nA healthy sealed system does not take in much air, though. If you find yourself bleeding the same radiator every few weeks, something else is going on. The usual suspects are a slow leak, a tired expansion vessel in the boiler, or corrosion inside the radiators producing gas. Any of those is worth a visit from an engineer.` },
    { id: 'a6', heading: 'Why is my radiator cold at the top after bleeding?', body: `Give it an hour first. If it is still cold at the top, bleed it again, because a second pocket of air sometimes works its way round.\n\nCold at the bottom is a different problem. That points to sludge, a mix of rust and scale that settles in the lowest part of the radiator and blocks the flow. Black water when you bled the system is another sign. Bleeding will not shift sludge. The system needs flushing and a dose of inhibitor, which is the chemical that stops the rust forming in the first place. You can read how we do that on our [power flushing page](https://www.harperheating.example/services/power-flushing).` },
  ],
  conclusion: `Bleeding radiators is one of the few heating jobs that is safe, quick and worth doing yourself. If the cold spots come straight back, or the pressure keeps falling, the air is a symptom and not the cause, and that is the point to ring someone.`,
  cta: { label: 'Book a heating check', url: 'https://www.harperheating.example/book' },
  faqs: [
    { q: 'What happens if you don’t bleed your radiators?', a: 'The trapped air stays where it is. The top of the radiator stays cold, rooms take longer to heat, and you pay to run the boiler for longer. Over time, air in the system also speeds up rust.' },
    { q: 'Can I bleed a radiator without a key?', a: 'Sometimes. Many newer valves have a slot for a flat-headed screwdriver. Pliers will chew up the square, so buy a key if yours has no slot.' },
    { q: 'Which radiator do you bleed first?', a: 'The one furthest from the boiler. In a two-storey house, do upstairs first and finish with the radiator nearest the boiler.' },
  ],
  citations: [cite('https://energysavingtrust.org.uk/advice/heating-your-home', 'Energy Saving Trust: heating your home')],
  image: img('https://www.harperheating.example/images/bleed.jpg', 'A hand turning a radiator key on a white radiator, with a cloth held underneath'), author: null } as unknown as ArticleBody };

// ───────── B: a comparison ─────────
export const B: GoodArticle = { site: 'https://www.fernleymortgages.example', brief: { targetQuery: 'repayment or interest only mortgage', searchIntent: 'compare',
  relatedQuestions: ['Is an interest only mortgage cheaper than repayment?', 'What happens at the end of an interest only mortgage?', 'Can I switch from interest only to repayment?', 'Can first time buyers get an interest only mortgage?'] },
body: {
  title: 'Repayment or interest only: which mortgage suits you?', seoTitle: 'Repayment or interest only mortgage: which one suits you?',
  metaDescription: 'Should you choose a repayment or interest only mortgage? We compare the monthly cost, the total cost and the risk, with a worked example.',
  excerpt: 'One clears the debt, the other only services it. Here is how the two compare.', slug: 'repayment-or-interest-only-mortgage',
  intro: `Every mortgage asks the same question sooner or later: are you going to pay the loan back as you go, or pay only the interest and settle the debt at the end? Choosing between a repayment or interest only mortgage changes what leaves your account each month, how much the house costs you in total, and what you owe on the day the term finishes.\n\nNeither is right for everybody. This guide sets the two side by side so you can see which fits your plans.`,
  sections: [
    { id: 'b1', heading: 'How a repayment mortgage works', body: `With a repayment mortgage, each monthly payment has two parts. One part covers the interest the lender has charged that month. The other chips away at the loan itself.\n\nIn the early years most of the payment is interest, because the debt is at its largest. As the balance falls, the interest falls with it and more of each payment goes towards the loan. Keep up the payments for the full term and you owe nothing at the end. The house is yours.\n\nThat certainty is the main attraction. It is also why most lenders treat repayment as the standard choice for a home you live in.` },
    { id: 'b2', heading: 'How an interest only mortgage works', body: `An interest only mortgage does what the name says. Your monthly payment covers the interest and nothing else. The amount you borrowed does not go down.\n\nAt the end of the term you still owe every pound of the original loan, and the lender will expect it back in one go. You therefore need a plan for raising that money, which lenders call a repayment vehicle. Common ones are selling the property, selling another property, or cashing in investments or a pension lump sum.\n\nLenders check that plan before they agree to lend, and many will ask about it again during the term.` },
    { id: 'b3', heading: 'Is an interest only mortgage cheaper than repayment?', body: `Month by month, yes. Over the whole term, no.\n\nTake a £200,000 loan over 25 years at 5%. On repayment, the monthly payment is about £1,169. On interest only it is about £833, which is £336 a month less.\n\nNow look at the total. The repayment borrower pays roughly £150,700 in interest over the 25 years and finishes owing nothing. The interest only borrower pays £250,000 in interest and still owes the £200,000. The lower payment is real, but it is bought with a much larger bill later.\n\nThese figures assume the rate never changes, which it will. They are here to show the shape of the difference, not to predict your payments.` },
    { id: 'b4', heading: 'The risks on each side', body: `Repayment carries one main risk: the payment is higher, so there is less slack in a tight month. If rates rise at the end of a fixed deal, the jump is felt straight away.\n\nInterest only carries more. Your plan to clear the loan may fall short if investments underperform or the property sells for less than you hoped. You build no equity through your payments, so if prices fall you can owe more than the home is worth. Remortgaging is also harder, because fewer lenders offer interest only deals and those that do tend to want a bigger deposit.` },
    { id: 'b5', heading: 'Who each one tends to suit', body: `Repayment suits most people buying a home to live in. If your aim is to own the place outright by the time you stop working, it is the only route that gets you there by default.\n\nInterest only is far more common among landlords. A buy-to-let investor usually cares about monthly cash flow and plans to sell or refinance at the end, and the rent covers the interest in the meantime. It can also suit borrowers with large but irregular income, such as annual bonuses, who make lump-sum overpayments when the money arrives.\n\nSome lenders offer a part and part mortgage, where a portion of the loan is on repayment and the rest is interest only. It is a middle path, and worth asking about if the full repayment figure is just out of reach.` },
    { id: 'b6', heading: 'What happens at the end of an interest only mortgage?', body: `The lender writes to you well before the end date, usually more than once, asking how you intend to repay. On the final day the whole loan is due.\n\nIf your plan has worked, you pay it off and that is that. If it has not, you have a few options: sell the property, remortgage on to a repayment deal if your age and income allow, or ask the lender for more time. Lenders are expected to treat borrowers in this position fairly, but they are not obliged to extend. The earlier you raise a shortfall, the more choices you have.` },
    { id: 'b7', heading: 'Can I switch from interest only to repayment?', body: `Usually, and it is often simple. Most lenders will move you to repayment during the term if you ask, and many do not charge for it. Your monthly payment will go up, so the lender will check you can afford the new figure.\n\nGoing the other way is harder. Moving from repayment to interest only means passing the lender’s interest only rules, including showing a credible way to repay the loan. If you are thinking about either switch, [speak to one of our advisers](https://www.fernleymortgages.example/advice/talk-to-an-adviser) before you call your lender, so you know what to expect.` },
  ],
  conclusion: `A repayment mortgage costs more each month and less overall, and it ends with the debt gone. An interest only mortgage costs less each month and more overall, and it ends with the debt intact. Start from how you intend to clear the loan. If you do not have a firm answer to that, repayment is the safer choice.`,
  cta: { label: 'Talk to a mortgage adviser', url: 'https://www.fernleymortgages.example/contact' },
  faqs: [
    { q: 'Can first time buyers get an interest only mortgage?', a: 'It is rare for a home you will live in. Most lenders want a large deposit, a high income and a clear way to repay the loan, which rules out many first time buyers. Part and part deals are sometimes easier to get.' },
    { q: 'Can I overpay on an interest only mortgage?', a: 'Most deals allow overpayments of up to 10% of the balance a year without a charge. Overpayments reduce the loan, so they also reduce the interest you pay afterwards.' },
    { q: 'Does the choice affect my interest rate?', a: 'Sometimes. Interest only deals often come with slightly higher rates or a lower maximum loan compared with the value of the property.' },
  ],
  citations: [cite('https://www.moneyhelper.org.uk/en/homes/buying-a-home/mortgage-interest-only-or-repayment', 'MoneyHelper: interest-only or repayment mortgages'), cite('https://www.fca.org.uk/consumers/interest-only-mortgages', 'FCA: interest-only mortgages')],
  image: img('https://www.fernleymortgages.example/images/compare.jpg', 'A couple at a kitchen table comparing two mortgage illustrations side by side'), author: null } as unknown as ArticleBody };

// ───────── C: a long guide ─────────
export const C: GoodArticle = { site: 'https://www.oakandashgardenrooms.example', brief: { targetQuery: 'garden office planning permission', searchIntent: 'learn',
  relatedQuestions: ['How big can a garden office be without planning permission?', 'How close to a boundary can a garden office be?', 'Do garden offices need building regulations?', 'Can I run a business from a garden office?', 'Do I need planning permission for a garden office in a conservation area?'] },
body: {
  title: 'Garden office planning permission: the complete guide', seoTitle: 'Garden office planning permission: when you need it, and when not',
  metaDescription: 'Most garden offices need no planning permission, but height, position and how you use the building all matter. Here are the rules in plain English.',
  excerpt: 'Most garden offices are allowed without an application. Here are the limits, and the cases where you must apply.', slug: 'garden-office-planning-permission',
  intro: `The first thing nearly everybody asks us is whether they need garden office planning permission before we can build. For most homes in England the answer is no. A garden office normally counts as an outbuilding, and outbuildings are covered by permitted development rights, which let you build without making an application as long as you stay inside certain limits.\n\nThe limits are the important part. This guide goes through them one at a time, then covers the situations where permitted development does not apply at all. The rules described here are for England. Wales, Scotland and Northern Ireland have similar schemes with their own details.`,
  sections: [
    { id: 'c1', heading: 'What permitted development means', body: `Permitted development is planning permission that Parliament has already granted for certain kinds of minor work. You do not apply for it. You simply build within the conditions.\n\nFor outbuildings, the conditions cover size, height, position and use. Break any one of them and the building needs a full planning application like any other. It is also worth knowing that the rights belong to houses. Flats and maisonettes do not have them, and neither do some converted buildings, such as barns turned into homes under their own special rules.\n\nA council can remove permitted development rights from a particular property or a whole street. This is done through a condition on an earlier planning permission or through what is called an Article 4 direction. New-build estates are the usual place to find the first kind. Your council’s planning department can tell you in a few minutes whether either applies to your address.` },
    { id: 'c2', heading: 'How big can a garden office be without planning permission?', body: `There is no single maximum floor area for a garden office. Instead there is a rule about how much of your plot can be covered.\n\nOutbuildings, sheds, extensions and other additions together must not cover more than half of the land around the original house. “Original” means the house as it stood on 1 July 1948, or as first built if it is newer than that. So a previous owner’s extension and the old shed at the end of the garden both count towards the half.\n\nIn an ordinary suburban garden this rule is rarely the one that bites. A four metre by three metre office takes up twelve square metres, and most gardens can spare that many times over. Height is the limit people run into first.` },
    { id: 'c3', heading: 'Height limits, and why two metres matters', body: `The building must be single storey. Beyond that, three numbers apply:\n\n- the eaves, where the wall meets the roof, can be no higher than 2.5 metres\n- the overall height can be up to 4 metres with a dual-pitched roof, or 3 metres with any other roof\n- if any part of the building is within 2 metres of a boundary, the whole building can be no higher than 2.5 metres\n\nThe last of these shapes most garden offices. Few people want to give up a two metre strip all the way round, so the building goes near the fence and the 2.5 metre cap applies. That is enough for a comfortable room with a flat or gently sloping roof, but it rules out a tall pitched one.\n\nHeight is measured from the highest point of the natural ground next to the building. On a sloping garden that works in your favour at one end and against you at the other, so measure before you settle on a spot. Raised platforms, including decking, are limited to 30 centimetres above the ground. Balconies and verandas are not allowed at all.` },
    { id: 'c4', heading: 'How close to a boundary can a garden office be?', body: `Planning rules do not set a minimum distance. You may build right up to the boundary if the building is no taller than 2.5 metres.\n\nIn practice we suggest leaving at least half a metre. You need room to treat or repair the outside wall, and gutters must not overhang next door. Building regulations take an interest too. A building within one metre of the boundary and over 15 square metres inside has to be made substantially of materials that will not burn, to slow a fire spreading between properties.\n\nOne position is always ruled out. An outbuilding cannot sit forward of the principal elevation, which for most homes simply means it cannot go in the front garden.` },
    { id: 'c5', heading: 'When you do need planning permission', body: `You will need to apply if any of the following is true:\n\n- the property is a flat or maisonette\n- the house is a listed building, in which case any outbuilding in its grounds needs permission\n- permitted development rights have been removed from the property\n- the design goes over the height or coverage limits\n- the building would stand in front of the house\n- it will be used as separate living accommodation\n\nIf you are unsure, you can ask the council for a lawful development certificate. It is optional and there is a fee, but it is written proof that the building did not need permission. Buyers’ solicitors often ask for one when you come to sell, and it is far easier to get at the time than ten years later.` },
    { id: 'c6', heading: 'Do I need planning permission for a garden office in a conservation area?', body: `Not automatically, but the rules tighten. On what the legislation calls designated land, which includes conservation areas, national parks, areas of outstanding natural beauty and World Heritage Sites, an outbuilding at the side of the house always needs permission.\n\nIn national parks, areas of outstanding natural beauty and World Heritage Sites there is a further limit. Outbuildings more than 20 metres from the house are restricted to 10 square metres in total. Many conservation areas also have Article 4 directions that remove outbuilding rights altogether, so a quick call to the council is time well spent. Where an application is needed, councils tend to look kindly on modest timber buildings tucked away at the rear.` },
    { id: 'c7', heading: 'Can I run a business from a garden office?', body: `Permitted development covers buildings used for a purpose “incidental” to enjoying the house. Working at a desk on your own counts. So does a hobby room, a gym or a studio.\n\nThe position changes when the use starts to alter the character of the property. Regular client visits, staff who travel in each day, deliveries, noise or a sign at the gate can all tip a home office into business use, and that requires permission for a change of use. A bookkeeper who sees the occasional client is very unlikely to trouble anybody. A dog groomer with six appointments a day probably will.\n\nSleeping is the other line. A garden office with a sofa bed for the odd guest is generally accepted. A building with its own kitchen and shower that someone lives in is a separate dwelling in the eyes of the council, and it needs a full application.` },
    { id: 'c8', heading: 'Do garden offices need building regulations?', body: `Building regulations are separate from planning and deal with how something is built, not whether it may be. A garden office is normally exempt if it is under 15 square metres inside and has no sleeping accommodation.\n\nBetween 15 and 30 square metres it remains exempt provided there is no sleeping accommodation and it is either at least one metre from every boundary or built substantially of non-combustible materials. Over 30 square metres, full building regulations approval is required.\n\nElectrics are the exception at every size. The supply to a garden building is notifiable work under Part P, so it must be installed and certified by a registered electrician, or inspected by building control. Keep the certificate with the deeds.` },
    { id: 'c9', heading: 'A quick way to check your own garden', body: `Before you ask for quotes, spend ten minutes on these five questions.\n\n1. Is the property a house, and not listed?\n2. Will the office sit behind the front wall of the house?\n3. Will it be within two metres of a boundary? If so, can you live with 2.5 metres in height?\n4. Will everything added since 1948 still cover less than half the plot?\n5. Will you use it for your own work, without regular visitors or staff?\n\nFive yeses mean you are very likely within permitted development. If one answer is a no or a maybe, that is the point to talk to the council or to us. We check every site against these rules as part of [our free site survey](https://www.oakandashgardenrooms.example/site-survey), and we handle the application when one is needed.` },
  ],
  conclusion: `Most garden offices never need a planning application. Keep the building to a single storey, mind the 2.5 metre limit near a boundary, stay behind the front of the house and use the room for your own work, and you are on safe ground. Listed buildings, flats and designated land are the main exceptions, and a lawful development certificate is cheap reassurance if you have any doubt.`,
  cta: { label: 'Book a free site survey', url: 'https://www.oakandashgardenrooms.example/site-survey' },
  faqs: [
    { q: 'How long does planning permission take if I need it?', a: 'Councils aim to decide householder applications within eight weeks of accepting them as valid. Allow two or three weeks before that for drawings.' },
    { q: 'Will my neighbours be consulted?', a: 'Only when an application is made. For a building under permitted development there is no consultation, although it is good manners to mention your plans before work starts.' },
    { q: 'Does a garden office add to my council tax?', a: 'Not when it is used as part of the home. A building used as a separate dwelling, or only for business, can be assessed on its own.' },
  ],
  citations: [cite('https://www.planningportal.co.uk/permission/common-projects/outbuildings/planning-permission', 'Planning Portal: outbuildings'), cite('https://www.gov.uk/government/publications/permitted-development-rights-for-householders-technical-guidance', 'Permitted development rights for householders: technical guidance')],
  image: img('https://www.oakandashgardenrooms.example/images/office.jpg', 'A cedar-clad garden office with a flat roof at the end of a lawn'), author: null } as unknown as ArticleBody };

/** The good article without its picture. */
export const withoutPicture = (b: ArticleBody): ArticleBody => ({ ...b, image: { kind: 'none', url: null, alt: '', provenance: '', width: null, height: null } } as unknown as ArticleBody);

// ─── Rubbish, from the review's generators ───────────────────────────────────

export const SITE = ['https://www.martinhowardproperty.example'];
export const REVIEW_CONTEXT = { siteHosts: SITE, selfUrl: 'https://www.martinhowardproperty.example/blog/appraise-a-property-deal', checkIssues: [] as never[] };
const P = 'appraise a property deal';

/** A deterministic pseudo-random source (the review used seed 7). */
function rng(seed = 7) {
  let s = seed;
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  return <T,>(a: readonly T[]) => a[Math.floor(rnd() * a.length)]!;
}
const W = `cat dog sun moon tree road shoe hat milk bread stone river cloud field barn gate lamp desk chair spoon fork plate bowl cup jar lid pen ink page book shelf door wall roof floor step path hill lake pond fish bird frog bee ant fox owl hen pig cow goat lamb wolf bear deer hare mole crab seal swan duck goose crow dove hawk lark wren moth snail worm rose fern moss reed oak elm ash pine yew plum pear fig lime bean pea corn rice oat rye salt jam pie cake bun tea soup stew egg ham beef pork cod eel nut seed leaf root stem bark twig log coal sand clay mud dust rain snow hail fog mist wind storm frost dew tide wave reef bay cape cove dock pier ship boat raft sail oar mast keel deck rope knot hook net trap cage pen yard farm mill forge shop inn hall hut tent camp fort town port bridge lane street park green brown blue red pink grey black white gold tin lead iron steel brass zinc glass wool silk lace felt tweed cord thread pin clip bolt nail screw hinge latch lock key bell drum horn harp flute pipe song tune beat verse line word name sign mark dot ring loop arc bend curve edge side back front top base end start`.split(/\s+/);
const LINK = ['because', 'however', 'so', 'although', 'while', 'since', 'unless', 'then', 'also', 'yet', 'instead', 'still'];
const STARTS = ['The', 'A', 'One', 'Every', 'Some', 'Each', 'Most', 'Many', 'That', 'This', 'Our', 'Your', 'Any', 'No', 'His', 'Her', 'Their', 'Old', 'New', 'Big', 'Small', 'Wet', 'Dry', 'Cold', 'Warm'];

export interface SaladOptions { parts?: number; perPart?: number; n?: number; uses?: number; faqA?: (q: string, pick: <T>(a: readonly T[]) => T) => string; title?: string; desc?: string; own?: string; ext?: string; cta?: { label: string; url: string }; alt?: string }
/** Word salad: sentences of random nouns, built to meet every limit of the score (the review's G1 to G5). */
export function wordSalad(opts: SaladOptions = {}): ArticleBody {
  const pick = rng(7);
  const Q = sp.brief().relatedQuestions;
  const salad = (n = 11, link = false) => {
    const ws = Array.from({ length: n - 1 }, () => pick(W));
    if (link) ws[Math.floor(n / 2)] = pick(LINK);
    return `${pick(STARTS)} ${ws.join(' ')}.`;
  };
  const para = (k: number, n = 11) => Array.from({ length: k }, (_, i) => salad(n, i % 5 < 2)).join(' ');
  const parts = opts.parts ?? 9, per = opts.perPart ?? 11, n = opts.n ?? 11;
  const usePhrase = () => `The cat can ${P} beside the old red barn today.`;
  const secs = [] as { id: string; heading: string; body: string }[];
  secs.push({ id: 's0', heading: `How to ${P} with a spoon`, body: `${usePhrase()} ${para(per, n)}` });
  Q.forEach((q, i) => secs.push({ id: `q${i}`, heading: q, body: `${q.replace(/\?$/, '').replace(/^(How|What) (do|does|should|long should) /i, '')} ${para(1, n)} ${para(per - 1, n)}` }));
  for (let i = secs.length; i < parts; i++) secs.push({ id: `s${i}`, heading: `${pick(STARTS)} ${pick(W)} ${pick(W)} ${pick(W)}`, body: `${i < (opts.uses ?? 3) ? `${usePhrase()} ` : ''}${para(per, n)}` });
  const own = opts.own ?? '[spoon fork](https://www.martinhowardproperty.example/blog/spoon)';
  const ext = opts.ext ?? '[plate bowl](https://example.org/x)';
  secs[1]!.body += ` See ${own} and ${ext}.`;
  return { ...sp.strongBody(),
    title: 'x', seoTitle: opts.title ?? 'Appraise a property deal: spoon fork plate bowl', metaDescription: opts.desc ?? 'You can appraise a property deal beside the barn while the cat, the dog and the hen watch the moon.',
    slug: 'appraise-a-property-deal', intro: `You can ${P} with a spoon and a fork today. ${para(3, n)}`,
    sections: secs, faqs: Q.slice(0, 3).map((q) => ({ q, a: opts.faqA ? opts.faqA(q, pick) : `${q.replace(/\?$/, '')} ${para(1, 12)}` })),
    conclusion: para(2, n), cta: opts.cta ?? { label: 'Go now', url: 'https://www.martinhowardproperty.example/x' },
    citations: [],
    image: { kind: 'brand_asset', url: 'https://www.martinhowardproperty.example/a.jpg', alt: opts.alt ?? `A cat about to ${P}`, provenance: '', width: 1200, height: 800 } } as unknown as ArticleBody;
}

const ADJ = ['good', 'sound', 'solid', 'decent', 'proper', 'careful', 'sensible', 'steady', 'tidy', 'clear', 'plain', 'honest', 'fair', 'wise', 'smart', 'neat', 'calm', 'firm', 'keen', 'sharp', 'fresh', 'bright', 'handy', 'useful', 'simple', 'modest', 'prudent', 'robust', 'reliable', 'thorough'];
const spun = (k: number) => {
  const a = ADJ[k % ADJ.length]!;
  return [
    `It is always a ${a} idea to think about your goals before you spend any money at all.`,
    `Many people forget this ${a} point, because they are in a hurry to get started on something new.`,
    `However, a ${a} plan will usually save you time, effort and worry over the months that follow.`,
    `You should also speak to a ${a} adviser who understands what you are trying to achieve this year.`,
    `In the end, the ${a} choice depends on your own needs, your budget and how much risk you can accept.`,
    `Every investor is different, so take the ${a} route that suits you rather than copying somebody else.`,
    `Remember that a ${a} decision made today can still be reviewed again when things change tomorrow.`,
  ].join(' ');
};
/** One empty paragraph repeated in every part, one adjective swapped per sentence (the review's R2). */
export function spunArticle(parts = 12): ArticleBody {
  const strong = sp.strongBody();
  const brief = sp.brief();
  const secs = [{ id: 'a', heading: 'How to appraise a property deal the right way', body: `When you appraise a property deal, keep these thoughts in mind. ${spun(0)}` },
    ...brief.relatedQuestions.map((q, i) => ({ id: `q${i}`, heading: q, body: `${q.replace(/\?$/, '')} is something people often ask. ${spun(i + 1)}` })),
    ...Array.from({ length: parts - 5 }, (_, i) => ({ id: `p${i}`, heading: `More ${ADJ[(i + 7) % ADJ.length]} thoughts for investors, part ${i + 1}`, body: `${i === 0 ? 'So when you appraise a property deal, slow down and think it over first. ' : ''}${spun(i + 5)}${i === 1 ? ' See our [deal review](https://www.martinhowardproperty.example/deal-review) page.' : ''}` }))];
  return { ...strong, intro: `If you want to appraise a property deal, this guide is for you. ${spun(29)}`, sections: secs,
    faqs: brief.relatedQuestions.slice(0, 3).map((q, i) => ({ q, a: `${q.replace(/\?$/, '')} depends on your goals. ${spun(20 + i).split('. ').slice(0, 2).join('. ')}.` })), conclusion: spun(28) } as ArticleBody;
}

/** The strong fixture with extra text appended to every part. */
export const stuffed = (per: (i: number) => string): ArticleBody => { const b = sp.strongBody(); return { ...b, sections: b.sections.map((s, i) => ({ ...s, body: `${s.body}\n\n${per(i)}` })) }; };
const X = ['slowly', 'weekly', 'properly', 'calmly', 'twice', 'early', 'together', 'alone', 'online', 'today', 'tonight', 'again'];
const WHO = ['Smart', 'Careful', 'Busy', 'New', 'Seasoned', 'Local', 'Cautious', 'Keen', 'Patient', 'Young', 'Older', 'Wise'];
const N = ['Buyers', 'Owners', 'Investors', 'Landlords', 'Couples', 'Brokers', 'Builders', 'Agents', 'Lenders', 'Sellers', 'Friends', 'Families'];
/** The review's stuffing cases, by name. */
export const STUFFING = {
  /** R3a: one more real-sentence use in every part. */
  onePerPart: () => stuffed((i) => `Take your time when you appraise a property deal like this one in part ${i + 1}.`),
  /** R3b: three six-word phrase sentences in every part. */
  sixWordRepeats: () => stuffed(() => 'You should appraise a property deal. Always appraise a property deal carefully. Now appraise a property deal again.'),
  /** R3c: three "-ing" variants per part. */
  ingVariants: () => stuffed(() => 'Appraising a property deal takes care, so appraising property deals well matters when appraising any property deal at all.'),
  /** R3d: the phrase as a bullet, five per part. */
  phraseBullets: () => stuffed(() => Array.from({ length: 5 }, () => '- Appraise a property deal').join('\n')),
  /** R3e: one real and one six-word unique phrase sentence per part. */
  twoUniquePerPart: () => stuffed((i) => `${WHO[i]} investors appraise a property deal ${X[i]}, and they are glad they did. ${WHO[(i + 5) % 12]} buyers appraise a property deal ${X[(i + 3) % 12]}.`),
  /** R3g: 36 inflected and reordered variants, every sentence different (the review's "36 variants"). */
  variants36: () => stuffed((i) => `${WHO[i]} investors keep appraising property deals ${X[i]}, so appraising a property deal well, and property deal appraisal in general, becomes a habit for them.`),
  /** R3f: 36 more unique six-word exact sentences, 38 exact uses in all (the review's "38 uses"). */
  exact38: () => stuffed((i) => `${N[i]} appraise a property deal ${X[i]}. ${N[(i + 4) % 12]} appraise a property deal ${X[(i + 7) % 12]}. ${N[(i + 8) % 12]} appraise a property deal ${X[(i + 2) % 12]}.`),
  /** R3h: 60 bullets "Appraise a property deal <word>". */
  bullets60: () => stuffed((i) => Array.from({ length: 5 }, (_, k) => `- Appraise a property deal ${X[(i + k) % 12]}`).join('\n')),
} as const;

const CHECKLIST = ['Check the street first and note the sold prices nearby', 'Ask the agent why the seller wants to move this year', 'Walk round the outside before you go through the door', 'Look up at the roof line, gutters and chimney stacks', 'Test every tap, switch, window and radiator you can reach', 'Photograph each room so you can price the work later', 'Write down the cost of every job while it is fresh', 'Ring two builders and compare what they tell you', 'Add stamp duty, legal fees, surveys and finance charges', 'Take off the profit you need for the risk involved', 'Sleep on the number before you make any offer', 'Offer slightly less so there is room to negotiate'].map((x) => `- ${x}`).join('\n');
/** The strong fixture padded with parts that each hold the same 12-item checklist `reps` times (the review's R4). */
export function padded(reps: number, parts: number): ArticleBody {
  const strong = sp.strongBody();
  return { ...strong, sections: [...strong.sections, ...Array.from({ length: parts }, (_, i) => ({ id: `x${i}`, heading: `Checklist number ${i + 1} for deal ${i * 7 + 3}`, body: Array.from({ length: reps }, () => CHECKLIST).join('\n') }))] } as ArticleBody;
}

/**
 * Ordinary sentences without repeats, for a very long article: a plain template whose word slots cycle through lists
 * of different prime lengths, so no run of five words comes back within thousands of sentences.
 */
export function variedSentences(sentenceCount: number): string[] {
  const L = (x: string) => x.split(' ');
  const who = L('buyers owners landlords tenants builders lenders surveyors agents investors neighbours families couples students sellers planners valuers brokers'); // 17
  const verb = L('check compare measure price photograph review question list record repair insure value inspect paint clean rent sell visit plan'); // 19
  const adj = L('old new damp narrow wide shared rear front upper lower painted wooden cracked tiled brick stone metal plastic modern original small large quiet'); // 23
  const noun = L('roof window boiler gutter wall kitchen bathroom cellar radiator chimney porch loft wiring driveway garage fence hallway floor staircase drain shed patio meter door ceiling sink bath gate lawn'); // 29
  const place = L('terrace semi bungalow flat cottage farmhouse townhouse maisonette villa barn studio mansion chalet lodge annexe apartment duplex mews vicarage rectory manor grange croft hall court tower mill forge priory abbey house'); // 31
  const when = L('today weekly monthly yearly early later soon first twice again quickly carefully slowly'); // 13
  const link = L('because so while since although unless once whereas until though as'); // 11
  const pron = L('they we you she he people everyone'); // 7
  const verb2 = L('spot avoid save plan budget fix find note test track price book order measure judge choose keep sort agree ask settle trust weigh share cut add count study learn follow watch rate log map grade sketch solve chart'); // 37
  const noun2 = L('costs risks delays faults leaks cracks gaps bills fees rates rents loans quotes deposits savings offers margins values prices taxes charges permits plans notes forms dates hours days weeks months years rooms walls tiles pipes wires slates bricks'); // 41
  const adv = L('sooner cheaply safely calmly fairly simply neatly clearly honestly properly wisely gently firmly openly promptly quietly briskly freely evenly fully kindly lightly loosely mostly nearly partly rarely roughly sharply smoothly softly solely steadily strictly surely swiftly tightly truly warmly widely boldly'); // 43
  const at = <T,>(a: readonly T[], i: number) => a[i % a.length]!;
  const cap = (w: string) => w.charAt(0).toUpperCase() + w.slice(1);
  const out: string[] = [];
  for (let i = 0; i < sentenceCount; i++) out.push(`${cap(at(who, i))} often ${at(verb, i)} the ${at(adj, i)} ${at(noun, i)} in the ${at(place, i)} ${at(when, i)}, ${at(link, i)} ${at(pron, i)} can ${at(verb2, i)} the ${at(noun2, i)} ${at(adv, i)}.`);
  return out;
}
/** The strong fixture with parts of varied sentences added (`sentenceCount` of them, 12 to a part). */
export function longVariedBody(sentenceCount: number): ArticleBody {
  const L = (x: string) => x.split(' ');
  const adj = L('old new damp narrow wide shared rear front upper lower painted wooden cracked tiled brick stone metal plastic modern original small large quiet');
  const noun = L('roof window boiler gutter wall kitchen bathroom cellar radiator chimney porch loft wiring driveway garage fence hallway floor staircase drain shed patio meter door ceiling sink bath gate lawn');
  const at = <T,>(a: readonly T[], i: number) => a[i % a.length]!;
  const out = variedSentences(sentenceCount);
  const parts: { id: string; heading: string; body: string }[] = [];
  for (let i = 0; i * 12 < out.length; i++) parts.push({ id: `p${i}`, heading: `Part ${i + 1}: the ${at(adj, i)} ${at(noun, i)}`, body: `${out.slice(i * 12, i * 12 + 6).join(' ')}\n\n${out.slice(i * 12 + 6, i * 12 + 12).join(' ')}` });
  return { ...sp.strongBody(), sections: [...sp.strongBody().sections, ...parts] } as ArticleBody;
}
