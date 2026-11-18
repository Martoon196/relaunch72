/**
 * The second independent review's fit-rule cases (review2-keyword-followups, `data-new.mts`), copied verbatim: 108
 * hand-written phrase/brief pairs (56 right, 52 deliberate near misses; a pair with `shortlist` is judged by the real
 * bindByIds with those other target candidates present) and 8 shortlists of 7 phrases across trades, legal, health and
 * beauty, hospitality, e-commerce, lettings, insurance and accountancy. Data only.
 */
// A pair with `shortlist` is judged by the real bindByIds with those other target candidates present.
export type P = { kind: 'right' | 'wrong'; phrase: string; q: string; t: string; note?: string; shortlist?: string[] };
const R = (phrase: string, q: string, t: string, note?: string, shortlist?: string[]): P => ({ kind: 'right', phrase, q, t, note, shortlist });
const W = (phrase: string, q: string, t: string, note?: string, shortlist?: string[]): P => ({ kind: 'wrong', phrase, q, t, note, shortlist });
export const newPairs: P[] = [
  // ── RIGHT ──
  // better-fit rule against the correct choice
  R('landlord insurance', 'What does landlord insurance cover and what does it cost?', 'Landlord Insurance: Cover, Costs and How to Compare Quotes', 'better-fit: pillar title names sub-topics', ['landlord insurance cost', 'landlord insurance quotes']),
  R('loft conversion', 'Is a loft conversion worth it?', 'Loft Conversions: Cost, Planning Permission and Added Value', 'better-fit: pillar title names sub-topics', ['loft conversion cost', 'loft conversion planning permission']),
  R('boiler repair', 'What should I do when my boiler breaks down?', 'Boiler Repair: What to Check Before You Call an Engineer', 'tie: "near me" twin in the shortlist', ['boiler repair near me', 'boiler service']),
  R('estate agent fees', 'How much do estate agents charge to sell a house?', 'Estate Agent Fees Explained', 'tie: plural twin in the shortlist', ['estate agents fees', 'online estate agents']),
  R('conveyancing solicitors', 'How do I choose a conveyancing solicitor?', 'Choosing a Conveyancing Solicitor: Fees, Speed and Red Flags', 'tie: "near me" twin in the shortlist', ['conveyancing fees', 'conveyancing solicitors near me']),
  R('boiler service', 'How often should a boiler be serviced?', 'Boiler Servicing: How Often and What It Includes', 'tie after stem miss: service/serviced/servicing', ['boiler repair', 'new boiler cost']),
  R('personal injury solicitors', 'When should I speak to a personal injury solicitor?', 'Personal Injury Solicitors: When to Get Advice', 'control with shortlist', ['personal injury claim', 'personal injury lawyers']),
  R('emergency plumber', 'Who do I call for a burst pipe at night?', 'Burst Pipe at Night? What an Emergency Plumber Will Do', 'control with shortlist', ['24 hour plumber', 'plumber near me']),
  // digits and years
  R('section 21 notice', 'Can I still ask a tenant to leave without giving a reason?', 'Section 21 Notices After the Renters’ Rights Act', 'digit, paraphrased question'),
  R('loft conversion cost 2026', 'How much does a loft conversion cost this year?', 'Loft Conversion Costs: A Realistic Budget', 'year only in the phrase'),
  R('24 hour plumber', 'Can I get a plumber out in the middle of the night?', '24-Hour Plumbers: What a Night Call-Out Costs', 'digit'),
  R('5 star hotel london', 'Which five-star London hotels are worth the price?', 'Five-Star Hotels in London Worth Paying For', 'digit against the word'),
  R('iphone 16 case', 'Which case protects an iPhone 16 best?', 'The Best iPhone 16 Cases for Drop Protection', 'digit'),
  R('2 bed flat to rent', 'What should I look for when renting a two-bedroom flat?', 'Renting a 2-Bed Flat: A Viewing Checklist', 'digit'),
  R('grade 2 listed building insurance', 'How do I insure a Grade II listed house?', 'Insuring a Grade II Listed Building', 'digit against roman numeral'),
  R('stamp duty rates 2026', 'What are the stamp duty rates in 2026?', 'Stamp Duty Rates 2026', 'year'),
  // letter grades
  R('epc rating c', 'How do I get my rental up to an EPC C?', 'Getting a Rental to EPC C: What It Costs', 'letter: brief says "EPC C" not "rating C"'),
  R('council tax band d', 'How much is Band D council tax this year?', 'Band D Council Tax Bills Compared', 'letter'),
  R('vitamin d supplements', 'Should I take vitamin D in winter?', 'Vitamin D Supplements: Who Needs Them', 'letter'),
  R('class 4 mot', 'What is checked in a class 4 MOT?', 'Class 4 MOT: The Full Checklist', 'digit'),
  R('a level tutors', 'How do I find a good A-level tutor?', 'A-Level Tutors: How to Choose', 'letter before qualifier'),
  // negation
  R('no win no fee solicitors', 'How do no win, no fee agreements work?', 'No Win No Fee Solicitors: What You Really Pay', 'negation'),
  R('non surgical nose job', 'Can you reshape a nose without surgery?', 'The Non-Surgical Nose Job: Results and Risks', 'negation'),
  R('mortgage without deposit', 'Can I buy a house with no deposit?', '100% Mortgages: Buying With No Deposit', 'negation: without against no'),
  R('gluten free bakery', 'Where can coeliacs buy fresh bread?', 'Our Gluten-Free Bakery: What We Bake Each Day', 'free'),
  // places
  R('estate agents london', 'How do I choose an estate agent in North London?', 'Estate Agents in North London: How to Choose', 'place: North London against london'),
  R('plumber manchester', 'Who is a reliable plumber in Greater Manchester?', 'Plumbers in Greater Manchester You Can Rely On', 'place: Greater Manchester against manchester'),
  R('landlord gas safety certificate', 'How often do landlords need a gas safety check in England?', 'Gas Safety Checks for Landlords', 'place: "in England" with one phrase word missing'),
  R('selective licensing', 'Do I need a selective licence in Nottingham?', 'Selective Licensing: Does Your Street Need One?', 'place named, phrase has none'),
  R('holiday let mortgage', 'Can I get a mortgage for a holiday cottage in Cornwall?', 'Holiday Let Mortgages: What Lenders Want', 'place named, phrase has none'),
  R('wedding venues yorkshire', 'How do I choose a wedding venue in North Yorkshire?', 'Wedding Venues in North Yorkshire: Questions to Ask', 'place: North Yorkshire against yorkshire'),
  R('stamp duty calculator', 'How much stamp duty will I pay from April?', 'Working Out Your Stamp Duty', 'place rule: "from April"'),
  R('furnished holiday let tax', 'How is income from Airbnb taxed?', 'Holiday Let Tax Rules', 'place rule: "from Airbnb"'),
  R('eviction notice period', 'How much notice does a landlord have to give in Scotland?', 'Eviction Notice in Scotland: How Long Tenants Get', 'place rule: "in Scotland" with one word missing'),
  // stems, singular/plural, UK/US
  R('property management', 'Is it worth paying someone to manage my rental?', 'Managing a Rental Yourself or Using an Agent', 'stem: management/manage/managing'),
  R('house clearance', 'Who clears a house after a death?', 'Clearing a House After a Bereavement', 'stem: clearance/clear'),
  R('carpet cleaning', 'How do I get my carpets cleaned properly?', 'Carpet Cleaners: Professional or DIY?', 'stem'),
  R('leg waxing', 'How long does a leg wax last?', 'Leg Wax: How Long It Lasts', 'stem: waxing/wax'),
  R('removals company', 'How do I choose a removal firm?', 'Choosing a Removal Firm: Seven Checks', 'plural'),
  R('jewellery repair', 'Can a jeweler fix a snapped chain?', 'Jewelry Repair: What Can Be Fixed', 'UK/US spelling'),
  R('colour consultation', 'What happens at a color consultation?', 'Your Color Consultation: What to Expect', 'UK/US spelling'),
  R('driving licence renewal', 'How do I renew my driver’s license?', 'Renewing a Driving License', 'UK/US spelling'),
  R('tyre fitting', 'How long does it take to fit new tires?', 'Tire Fitting: How Long It Takes', 'UK/US spelling'),
  // one word
  R('remortgage', 'When is the right time to switch mortgage deal?', 'Remortgaging: When to Switch', 'one word, -ing form'),
  R('conveyancing', 'What does a conveyancer actually do?', 'Conveyancing Explained', 'one word'),
  R('botox', 'How long does Botox last?', 'Botox: How Long It Lasts', 'one word'),
  // questions that do not repeat the phrase (the planner prompt allows it)
  R('rent arrears', 'What can I do when a tenant stops paying?', 'Tenant Not Paying? Your Options', 'paraphrase'),
  R('probate solicitors', 'Who can help me sort out my late mother’s estate?', 'Dealing With an Estate After a Death', 'paraphrase'),
  R('lash lift', 'How can I make my eyelashes look longer without extensions?', 'Longer-Looking Lashes Without Extensions', 'paraphrase'),
  R('private dining room', 'Where can we hold a birthday dinner for twenty?', 'Hosting a Birthday Dinner for Twenty', 'paraphrase'),
  R('cheap van insurance', 'How can a courier cut the cost of insuring a van?', 'Cutting the Cost of Van Cover', 'paraphrase'),
  R('emergency dentist', 'What should I do about a broken tooth on a Sunday?', 'A Broken Tooth Out of Hours: Who to Call', 'paraphrase'),
  // other scripts
  R('wynajem mieszkania londyn', 'Jak wynająć mieszkanie w Londynie?', 'Wynajem mieszkania w Londynie: poradnik', 'Polish (inflected)'),
  R('租房 伦敦', '在伦敦租房需要什么?', '伦敦租房指南', 'Chinese (no spaces)'),
  R('адвокат по разводам', 'Сколько стоит адвокат по разводам?', 'Адвокат по разводам: цены', 'Russian'),
  R('محامي طلاق', 'كم يكلف محامي طلاق في لندن؟', 'محامي طلاق: الأسعار', 'Arabic'),
  // ── WRONG ──
  // digits and years
  W('stamp duty rates 2025', 'What are the stamp duty rates in 2026?', 'Stamp Duty Rates 2026', 'year'),
  W('landlord tax changes 2025', 'What tax changes hit landlords in 2026?', 'Landlord Tax Changes for 2026', 'year'),
  W('section 8 notice', 'What are 8 things to check before serving a section 21 notice?', '8 Checks Before a Section 21 Notice', 'digit present for another reason'),
  W('iphone 15 case', 'Which case protects an iPhone 16 best?', 'The Best iPhone 16 Cases for Drop Protection', 'digit'),
  W('grade ii listed building insurance', 'How do I insure a Grade I listed house?', 'Insuring a Grade I Listed Building', 'roman numeral'),
  W('type 1 diabetes diet', 'What should I eat with type 2 diabetes?', 'A Type 2 Diabetes Diet That Works', 'digit'),
  W('3 bed house extension cost', 'How much does a 2 bed house extension cost?', '2 Bed House Extension Costs', 'digit'),
  // letters
  W('vitamin c serum', 'Should I take vitamin D in winter?', 'Vitamin D Supplements: Who Needs Them', 'letter after a word not in the qualifier list'),
  W('vitamin d supplements', 'Does vitamin C serum brighten skin?', 'Vitamin C Serum: Does It Work?', 'letter after a word not in the qualifier list'),
  W('form e divorce', 'What is Form A in a divorce?', 'Form A: Starting Financial Proceedings in Divorce', 'letter after a word not in the qualifier list'),
  W('hepatitis b vaccine', 'Is there a hepatitis C vaccine?', 'Hepatitis C: Why There Is No Vaccine Yet', 'letter after a word not in the qualifier list'),
  W('epc c rating', 'What does an EPC rating of E mean?', 'EPC Rating E: Can You Still Let?', 'letter before the qualifier'),
  W('council tax band d', 'How much is council tax band E?', 'Council Tax Band E Explained', 'letter'),
  W('category b licence', 'What can I drive on a category C licence?', 'Category C Licences Explained', 'letter'),
  W('e bike insurance', 'Do I need insurance for my bike?', 'Bike Insurance: Is It Worth It?', 'letter prefix: e bike'),
  // negation
  W('no deposit mortgage', 'Is there no way to avoid a big deposit on a buy-to-let mortgage?', 'Buy-to-Let Mortgage Deposits Explained', 'negation word elsewhere in the brief'),
  W('sugar free cake', 'How much sugar is in a slice of cake?', 'Sugar in Cake: The Numbers', 'negation: free'),
  W('unfurnished flat to rent', 'Should I rent out my flat furnished?', 'Letting a Flat Furnished: Pros and Cons', 'negation: un-'),
  W('cordless vacuum', 'Is a corded vacuum more powerful?', 'Corded Vacuums: Still the Most Powerful?', 'negation: -less'),
  W('smoking area pub', 'Which pubs are non-smoking throughout?', 'Non-Smoking Pubs', 'negation in the brief only'),
  W('non alcoholic beer', 'Which alcoholic beers are gluten free?', 'Gluten-Free Beer: A Guide', 'negation'),
  W('mortgage without deposit', 'How much deposit do I need for a mortgage?', 'Mortgage Deposits Explained', 'negation'),
  // places
  W('plumber leeds', 'Who is the best Bradford plumber?', 'Bradford Plumbers Compared', 'place with no preposition'),
  W('hair salon leeds', 'How do I choose a hair salon?', 'Choosing a Hair Salon: What to Look For', 'local phrase, national article'),
  W('estate agents york', 'Which estate agents sell most homes around Yorkshire?', 'Yorkshire Estate Agents Ranked', 'place'),
  W('wedding venues kent', 'Where are the best wedding venues? We compare Surrey and Sussex', 'Wedding Venues: Surrey vs Sussex', 'place with no preposition'),
  W('restaurants newcastle', 'Where should I eat in Newcastle-under-Lyme?', 'Eating Out in Newcastle-under-Lyme', 'place sharing a name'),
  W('bath fitters', 'Who fits kitchens in Bath?', 'Kitchen Fitters in Bath', 'place that is also a word'),
  W('reading glasses', 'Where can I get my eyes tested in Reading?', 'Opticians in Reading: Eye Tests and Glasses', 'place that is also a word'),
  W('dentist richmond', 'How do I find a dentist near Richmond Park?', 'Dentists Near Richmond Park', 'place'),
  // stems and plurals that merge different words
  W('glass repair', 'Can broken glasses be repaired?', 'Glasses Repair: Frames, Hinges and Lenses', 'plural merge: glass/glasses'),
  W('personal training', 'Can I take a personal bike on a train?', 'Bikes on Trains: The Rules', 'stem merge: training/train'),
  W('market stall insurance', 'Do I need insurance for a marketing agency?', 'Marketing Agency Insurance', 'stem merge: marketing/market'),
  W('booking system', 'Which books explain the tax system?', 'Books on the Tax System', 'stem merge: booking/book'),
  W('customs charges', 'How much do custom wardrobes cost?', 'Custom Wardrobe Charges', 'plural merge: customs/custom'),
  W('nail bar', 'Which nails hold a breakfast bar worktop?', 'Fixing a Breakfast Bar: Nails or Screws?', 'homonym'),
  // one generic word, all common words
  W('mortgage', 'How much do mortgage brokers charge?', 'Mortgage Broker Fees', 'one generic word'),
  W('mortgage', 'Is it worth paying for mortgage advice?', 'Do You Need a Mortgage Adviser?', 'one generic word, own phrase paraphrased', ['mortgage broker fees', 'remortgage']),
  W('insurance', 'What does landlord insurance cover?', 'Landlord Insurance: What It Covers', 'one generic word, own phrase not offered', ['landlord insurance cost', 'landlord building insurance']),
  W('what is the best', 'What is the best way to sell a house?', 'The Best Way to Sell', 'all common words'),
  W('near me', 'Where is the nearest plumber to me?', 'Plumbers Near Me', 'all common words'),
  // better-fit rule with the true phrase absent or paraphrased
  W('landlord insurance', 'Do landlords need an electrical safety certificate?', 'EICR Rules for Landlords', 'siblings tie', ['landlord tax', 'landlord licence']),
  W('landlord gas safety certificate', 'Is an EICR required for a rented property?', 'Electrical Safety Certificates for Landlords', 'true phrase not offered', ['landlord insurance', 'landlord tax']),
  W('boiler service cost', 'How much does a boiler repair cost?', 'Boiler Repair Costs', 'true phrase not offered', ['boiler service', 'new boiler cost']),
  W('loft conversion cost', 'How much does a garage conversion cost?', 'Garage Conversion Costs', 'true phrase not offered', ['loft conversion', 'dormer loft conversion']),
  W('lip filler aftercare', 'What should I do after Botox?', 'Botox Aftercare: The First Day', 'sibling', ['lip filler', 'botox cost']),
  W('divorce cost', 'How much does a will cost?', 'What a Will Costs With a Solicitor', 'generic shared word', ['divorce solicitors', 'will writing']),
  W('afternoon tea york', 'Where can I get a good Sunday lunch in York?', 'Sunday Lunch in York', 'place shared only', ['private dining york', 'bottomless brunch york']),
  // other scripts
  W('адвокат по разводам', 'Сколько стоит адвокат по наследству?', 'Адвокат по наследству: цены', 'Russian sibling'),
  W('محامي طلاق', 'كم يكلف محامي عقارات؟', 'محامي عقارات', 'Arabic sibling'),
  W('租房 伦敦', '伦敦买房指南', '在伦敦买房', 'Chinese'),
  W('wynajem mieszkania londyn', 'Jak sprzedać mieszkanie w Londynie?', 'Sprzedaż mieszkania w Londynie', 'Polish sibling'),
];

export type B = [phrase: string, question: string, title: string];
export const newClusters: Record<string, B[]> = {
  'A trades: boiler engineer (nested head term, "near me", service/servicing)': [
    ['boiler repair', 'What should I do when my boiler breaks down?', 'Boiler Repair: What to Check Before You Call an Engineer'],
    ['boiler repair cost', 'How much does a boiler repair cost?', 'Boiler Repair Costs in 2026'],
    ['boiler repair near me', 'How do I find a trustworthy boiler repair engineer near me?', 'Finding a Local Boiler Repair Engineer You Can Trust'],
    ['emergency boiler repair', 'What counts as an emergency boiler repair?', 'Emergency Boiler Repair: When to Call Out of Hours'],
    ['boiler service', 'How often should a boiler be serviced?', 'Boiler Servicing: How Often and What It Includes'],
    ['boiler service cost', 'How much is a boiler service?', 'Boiler Service Cost: What You Should Pay'],
    ['new boiler cost', 'How much does a new boiler cost?', 'New Boiler Costs: Supply, Fitting and Extras'],
  ],
  'B legal: family solicitor (form letters, negation, orders)': [
    ['divorce solicitors', 'Do I need a solicitor to get divorced?', 'Divorce Solicitors: When You Need One and When You Do Not'],
    ['no fault divorce', 'How does a no fault divorce work?', 'No Fault Divorce: The Process Step by Step'],
    ['divorce cost', 'How much does a divorce cost?', 'What a Divorce Costs in 2026'],
    ['form e divorce', 'What is Form E and how do I fill it in?', 'Form E: Financial Disclosure in Divorce'],
    ['consent order', 'What is a consent order and do I need one?', 'Consent Orders Explained'],
    ['child arrangements order', 'How do I apply for a child arrangements order?', 'Child Arrangements Orders: Applying to the Court'],
    ['clean break order', 'What is a clean break order?', 'Clean Break Orders: Ending Financial Ties'],
  ],
  'C health and beauty: aesthetics clinic (nested pairs, one-word phrases)': [
    ['laser hair removal', 'Does laser hair removal really work?', 'Laser Hair Removal: Results, Sessions and Aftercare'],
    ['laser hair removal cost', 'How much does laser hair removal cost?', 'Laser Hair Removal Prices: What to Expect'],
    ['lip filler', 'How long does lip filler last?', 'Lip Filler: How Long It Lasts and What Affects It'],
    ['lip filler aftercare', 'What should I avoid after lip fillers?', 'Lip Filler Aftercare: The First Two Weeks'],
    ['microblading', 'Is microblading worth it?', 'Microblading: Cost, Pain and How Long It Lasts'],
    ['hydrafacial', 'What does a HydraFacial do for your skin?', 'HydraFacial: What Happens and Who It Suits'],
    ['skin tag removal', 'Can skin tags be removed safely?', 'Skin Tag Removal: Safe Options and Costs'],
  ],
  'D hospitality: York restaurant and venue (one town in every phrase)': [
    ['sunday lunch york', 'Where can I get a good Sunday lunch in York?', 'Sunday Lunch in York: What Makes a Proper Roast'],
    ['afternoon tea york', 'Where does the best afternoon tea in York come from?', 'Afternoon Tea in York: A Local Guide'],
    ['bottomless brunch york', 'Which York restaurants do bottomless brunch?', 'Bottomless Brunch: The York Guide'],
    ['private dining york', 'Where can I book a private dining room in York?', 'Private Dining Rooms in York for Parties'],
    ['wedding venues north yorkshire', 'How do I choose a wedding venue in North Yorkshire?', 'Wedding Venues in North Yorkshire: Questions to Ask'],
    ['dog friendly pubs york', 'Which York pubs welcome dogs?', 'Dog Friendly Pubs in York'],
    ['christmas party venues york', 'Where should we hold our work Christmas party in York?', 'Christmas Party Venues in York: Booking Tips'],
  ],
  'E e-commerce: bike shop (sizes with digits, e bike, vs)': [
    ['electric bikes', 'Are electric bikes worth the money?', 'Electric Bikes: Are They Worth It?'],
    ['e bike conversion kit', 'Can I convert my bike with an e-bike conversion kit?', 'E-Bike Conversion Kits: What You Need to Know'],
    ['kids bike sizes', 'What size bike does my child need?', "Kids' Bike Sizes: A Chart by Age and Height"],
    ['26 inch mountain bike', 'Who should ride a 26 inch mountain bike?', '26 Inch Mountain Bikes: Who They Still Suit'],
    ['29 inch mountain bike', 'Is a 29 inch mountain bike too big for me?', '29 Inch Mountain Bikes: Fit and Handling'],
    ['bike helmets', 'How do I choose a bike helmet that fits?', 'Bike Helmets: Fit, Safety Ratings and Price'],
    ['road bike vs gravel bike', 'Should I buy a road bike or a gravel bike?', 'Road Bike or Gravel Bike: Which Suits You?'],
  ],
  'F lettings: questions in the reader\'s own words, titles carry the phrase': [
    ['hmo licence', 'Do I need a licence to rent my house to sharers?', 'HMO Licensing: Who Needs One'],
    ['epc rating c', 'What will the new minimum energy rating mean for my rental?', 'EPC Rating C: What Landlords Must Do by 2030'],
    ['section 21 notice', 'Can I still ask a tenant to leave without giving a reason?', 'Section 21 Notices After the Renters’ Rights Act'],
    ['rent guarantee insurance', 'What happens if my tenant stops paying?', 'Rent Guarantee Insurance: Is It Worth It?'],
    ['landlord registration scotland', 'Do I have to register as a landlord in Scotland?', 'Landlord Registration in Scotland: The Rules'],
    ['right to rent check', 'What documents must I see before letting to a new tenant in England?', 'Right to Rent Checks: A Step-by-Step Guide'],
    ['tenant referencing', 'How do I check a tenant can afford the rent?', 'Tenant Referencing: What to Check'],
  ],
  'G insurance broker: landlord insurance (pillar is the head term of every supporting phrase)': [
    ['landlord insurance', 'What does landlord insurance cover and what does it cost?', 'Landlord Insurance: Cover, Costs and How to Compare Quotes'],
    ['landlord insurance cost', 'How much does landlord insurance cost?', 'Landlord Insurance Cost: What Affects Your Premium'],
    ['landlord insurance quotes', 'How do I compare landlord insurance quotes?', 'Comparing Landlord Insurance Quotes Properly'],
    ['landlord contents insurance', 'Do landlords need contents insurance?', 'Landlord Contents Insurance for Furnished Lets'],
    ['landlord building insurance', 'Is landlord buildings insurance a legal requirement?', 'Landlord Buildings Insurance: Is It Compulsory?'],
    ['rent guarantee insurance', 'Is rent guarantee insurance worth having?', 'Rent Guarantee Insurance: Is It Worth It?'],
    ['landlord liability insurance', 'What does landlord liability insurance protect against?', 'Landlord Liability Insurance Explained'],
  ],
  'H accountant: sole trader tax (pillar is the head term; the brief words reuse the cluster\'s words)': [
    ['self assessment', 'How does self assessment work for a sole trader?', 'Self Assessment: Deadlines, Penalties and How to File'],
    ['self assessment deadline', 'When is the self assessment deadline?', 'The Self Assessment Deadline and What Happens If You Miss It'],
    ['self assessment penalties', 'What are the penalties for late self assessment?', 'Self Assessment Penalties Explained'],
    ['sole trader tax', 'How much tax does a sole trader pay?', 'Sole Trader Tax: Rates and Allowances'],
    ['sole trader vs limited company', 'Should I stay a sole trader or set up a limited company?', 'Sole Trader or Limited Company: Which Pays Less Tax?'],
    ['allowable expenses', 'What expenses can a sole trader claim?', 'Allowable Expenses for the Self-Employed'],
    ['payment on account', 'What is a payment on account?', 'Payments on Account: Why Your Tax Bill Looks Doubled'],
  ],
};
