# Before You Buy: chapter readers. Follow-up journey (for Martin to approve)

Prepared 17 November 2026. Nothing has been written into any live system and nothing has been sent.

Files:
- Email-only sequence, can run today: `/tmp/claude-0/-home-user/437a5277-f9bf-563b-9330-1386174fa1df/scratchpad/book-sequence/sequence-email.json`
- Email + text sequence for when SMS is switched on (part 1 of 2): `/tmp/claude-0/-home-user/437a5277-f9bf-563b-9330-1386174fa1df/scratchpad/book-sequence/sequence-email-sms.json`
- This plan: `/tmp/claude-0/-home-user/437a5277-f9bf-563b-9330-1386174fa1df/scratchpad/book-sequence/sequence-plan.md`

## 0. Method and the decisions I made

Built with the DigitalMarketer Customer Value Journey and the Excite-stage (welcome sequence) method, run non-interactively. The reader has just completed Subscribe. The journey takes them Excite (a first win from the chapter) > Convert (Hunter at £9.75) > Ascend (£47 kit, then the course, then mentoring) > Advocate (reply with their rule) > Promote (send the book page to one person), then into Martin's normal occasional emails.

Decisions made without asking:
1. All twelve Fibonacci slots are used (days 0, 1, 2, 4, 7, 12, 19, 26, 33, 40, 47, 54). Each one carries a distinct lesson from Chapter One, Chapter Two or the companion, so none is a filler pitch. Five of twelve emails sell nothing.
2. The Convert pitch comes on day 2, not later, because the reader offer card on /book/thanks/ already made it on day 0: the emails should match what the reader has already seen. Day 4 handles the main objection and carries the free Chrome extension as the fallback for people not ready to pay.
3. Ascend order follows price and readiness: First Purchase Kit £47 (day 7), Property Done Properly £1,497 (day 12), One Lane Mentoring £3,997 (day 19). The day 12 "masterclass / deeper training" slot is the course, because both masterclasses on the site are dated (4 Nov ran; 18 Nov is tomorrow) and the replays are time-limited or unconfirmed as permanent. A swap-in masterclass email is in section 9 for when a live date exists.
4. Day 26 gives the free two-area search pack with a Chapter Two preview. It is genuinely available (PDF in the repo and live). Chapter Two itself is not released, so no email says it is.
5. Advocate (day 33) asks for a reply, not a testimonial form: /stories/share/ is written for course and Room members ("Before the course or the Room..."), so it does not suit readers yet.
6. The software is described only in the four verified Hunter lines and the wording already on /book/thanks/. Every pitch has an "if you've already done this, ignore me" line because stop-on-purchase is not connected.
7. Footer adds the registered office (as on every other page of the site) alongside company name and number, and the education-not-advice line.
8. Texts and WhatsApp are book-only: delivery check, the promised call, the worksheet, two chapter questions, and one "I've emailed you a reader offer". They stop after day 15 unless the person replies.
9. Each text/WhatsApp touch goes by ONE channel per person (WhatsApp where they have opted in and the template is approved, otherwise SMS), never both.
10. Times assume Martin enrols readers at 09:00 UK (entry is manual today), so emails land at 09:00 and texts at 10:00, 14:00, 12:00 or 18:00. If entry ever becomes automatic at sign-up time, a 09:00 to 20:00 send window for texts must be built first.
11. READ75 has no stated deadline, so no email invents one.
12. Mentoring copy does not say "applications are open" (that can change); it says applying takes a few minutes and links to the form, which shows the live status.

## 1. Offer ladder (what Martin actually sells or gives away)

Checked against the website repo on 17 Nov 2026. "Open" means a buy or sign-up button exists in the page today.

| CVJ position | Offer | Price | What is included (quoted or close-quoted) | URL | Open now? | Source |
|---|---|---|---|---|---|---|
| Subscribe (lead magnet) | Before You Buy, Chapter One "Does This Fit Me?" | Free | "Free PDF download after signup. No card details." | /book/ , /assets/downloads/before-you-buy-chapter-one.pdf | Yes | book/index.html, book/thanks/index.html |
| Excite (first win) | Buying-brief worksheet + four first checks | Free | Seven brief fields; "Your answers stay on this page... not sent to us"; "The worksheets on this page are free to use. Video examples and the knotweed pack are not available yet." | /book/companion/#brief | Yes (videos "in preparation") | book/companion/index.html |
| Excite / Engage | Two-area search pack (Chapter Two companion) | Free | "two area-research sheets, space for twenty comparable listings, a three-property shortlist and a buying-fit check" | /assets/downloads/before-you-buy-area-search-pack.pdf | Yes | book/companion/index.html, docs/book/chapter-02.md |
| Engage | 24 cheat sheets, First Door Diagnostic, Start quiz | Free (cheat sheets "free with an email") | "Twenty-four two-page tick lists"; diagnostic "eight questions... Nothing is sent anywhere" | /cheat-sheets/ , /webinar/diagnostic/ , /start/ | Yes | cheat-sheets, webinar/diagnostic, start |
| Engage / Convert fallback | Property Predator Chrome extension | Free | "Review supported property listings in your browser", desktop Chrome | https://propertypredator.com/extension | Yes | Brief (verified facts) |
| Convert (entry-point offer) | Property Predator Hunter with READ75 | £9.75 first month, then £39 a month, cancel any time | "Unlimited appraisals, all 4 strategies"; "Predator Verdicts + Auction Mode"; "Max-offer solver + 3-way valuation"; "Saved deals, pipeline + PDF reports". Not owner look-ups or off-market sourcing | reader link (see emails 3, 4) | Yes | assets/config.js (bookOfferCode READ75, bookOfferPlan pro_buyer, Was £39, Now £9.75, 75%); book/thanks/index.html offer card |
| Convert / Ascend (entry) | First Purchase Kit (starter) | £47 once | Calculator (deposit, cash needed, monthly payment, up to three deals), 17-page field guide, 28-point checklist, decision sheet, 5 questions for professionals, 7 lessons / 2 hours, worked deal clinic; "14-day refund, no questions asked"; "doesn't expire" | /kits/property-from-the-beginning/ | Yes (kitCheckoutAction set; the page also carries a hidden fallback "Checkout opens later today", confirm live) | kits/property-from-the-beginning/index.html, assets/kits.json (4700p, available true) |
| Ascend (entry) | Pick Your Door Kit (starter) | £47 once | "Stop starting. Pick one lane." 90-Day Scorecard, 8 lessons / 2.5 hours | /kits/one-lane-pick-your-door/ | Yes | kits/index.html |
| Core offer (small) | Specialist kits, e.g. Searches Kit | £97 once each | Searches Kit: 8 lessons / 2 hours, Search Risk Tracker, 19-page field guide, decision sheet, deal clinic "a Rhondda Fach terrace with coal, a tip, radon and surface water" | /kits/ground-and-environment-what-the-searches-tell-you/ | Yes | kits/ground-and-environment.../index.html; kits/index.html "Starter kits are £47. Every other kit is £97." |
| Profit maximiser (on kit thank-you page only) | Two more kits for the price of one | Price of the dearer kit | "Pick any two more kits. Pay for one." | /kits/thanks/ | Yes, post-purchase only | kits/thanks/index.html |
| Core offer | Property Done Properly (the course) | £1,497 once, or 3 x £525 (£1,575) | 26 modules, 192 lessons each with a task; 23 worked deal clinics; Your Desk for life; six calculators for life; one deal clinic booking a quarter; lifetime access and quarterly rule re-check; "30-day refund, no questions"; kits paid in the last 90 days come off | /join/ | Yes | join/index.html |
| Ascension (profit maximiser) | One Lane Mentoring | £3,997, or 6 x £699 (£4,194) | 12 places, 90 days: path session, personal 90-day plan, fortnightly group mentoring, toolkit, weekly scorecard, WhatsApp group "with published hours and response times", all 26 modules / 192 lessons, 90-day review; 30 extra days of group support if still blocked at day 90 | /mentoring/ , apply at /webinar/apply/ | Applications "for the next cohort are open" (founding cohort closed 7 Nov) | mentoring/index.html, join/index.html, webinar/apply/index.html ("Martin reads every application himself") |
| Top rung | One Lane Private | £25,000 or 12 x £2,250 (£27,000) | Martin one to one for 12 months; "Two places a year, by application and a call" | /mentoring/private-terms/ | By application | mentoring/index.html |
| Top rung | The Deal Partnership | £7,500, credited against Martin's share | "For course or cohort members with a deal in hand"; "Six a year" | /join/ | By application (members only) | join/index.html |
| Not open | The Deal Desk | £47 once | Six calculators, Desk for 30 days, One Lane Verdict | /join/ | No: "Not on sale yet" | join/index.html |
| Not open | The Members' Room | £67 a month or £670 a year (founders £47) | Monthly live deal clinic, recordings, Property Predator seat | /join/ | No: "Not open yet" | join/index.html |

Date-bound items (none used in the evergreen sequence):
- Masterclass "Too Many Ideas. Not Enough Income." ran Wednesday 4 November 2026; replay page exists (/webinar/replay/) but its permanence is not stated.
- Course webinar price £997 (3 x £349) ended Wednesday 11 November 2026, 7:30pm GMT. Standard price £1,497 applies now.
- Land masterclass ran 11 November; Land Gap Kit £27 launch price ended Sunday 15 November, 11:59pm GMT; now £97.
- Off-market deals masterclass: Wednesday 18 November 2026, 7:30pm GMT (tomorrow). Registrants get a 7-day replay. Swap-in only.
- Mentoring founding cohort closed 7 November.
- Inconsistency to fix on the site: assets/kits.json marks Capital Stack, Lender Ready, Investor and JV, Money Mindset and Sales kits as available: false, while /kits/ lists them at £97.

## 2. The journey on one page

Emails at 09:00 on each email day (assuming 09:00 enrolment). Texts are "add when switched on"; each text slot is sent as WhatsApp instead for people opted in to WhatsApp.

| Day / time | Channel | CVJ stage | Message | One job | Single call to action |
|---|---|---|---|---|---|
| Day 0, 09:00 | Email | Excite (first win) | Book 1: your chapter, and one thing to do tonight | Deliver the chapter again and get the buying brief written tonight | Open the buying-brief worksheet |
| Day 0, 10:00 | Text or WhatsApp (add when switched on) | Excite / service | Book text 1: did the chapter arrive | Check delivery; invite a question | Reply |
| Day 1, 09:00 | Email | Excite (trust) | Book 2: the ordinary Tuesday test | Build trust with the Cardiff story; teach the ordinary Tuesday test | Reply with the property type and the first job it would create |
| Day 1, 14:00 | Text or WhatsApp (add when switched on) | Excite / the call the form promised | Book text 2: the promised call | Book the call | Reply |
| Day 2, 09:00 | Email | Convert (main pitch) | Book 3: your walk-away price, before you fall for the house | Teach 'write your limit first' with the chapter's sum; show Property Predator doing that job; make the READ75 offer | Start Hunter at £9.75 with READ75 |
| Day 3, 12:00 | Text or WhatsApp (add when switched on) | Excite / worksheet nudge | Book text 3: buying brief nudge | Get the brief written | Reply |
| Day 4, 09:00 | Email | Convert (objections + fallback) | Book 4: is it worth it for a few properties? | Answer the 'only a few properties' objection; repeat the offer; give the free extension to those not ready | Start Hunter with READ75 (fallback: free Chrome extension) |
| Day 5, 12:00 | Text or WhatsApp (add when switched on) | Convert, the one permitted mention | Book text 4: reader offer is in your inbox | Point to the D2/D4 email, once | Look at the email (no link) |
| Day 7, 09:00 | Email | Ascend (entry kit) | Book 5: investigate, negotiate or leave it alone | Teach the three-way written decision; offer the £47 First Purchase Kit to first-time investors | Get the First Purchase Kit (£47) |
| Day 9, 18:00 | Text or WhatsApp (add when switched on) | Engage / chapter question | Book text 5: first three jobs | Prompt a reply | Reply |
| Day 12, 09:00 | Email | Ascend (core offer: the course) | Book 6: what if the work takes three months longer? | Teach the three 'suppose' stress questions; offer Property Done Properly | See the course (£1,497 or 3 x £525) |
| Day 15, 18:00 | Text or WhatsApp (add when switched on) | Engage / chapter question, last text | Book text 6: last text, what would make you walk away | Prompt a reply; end texting | Reply |
| Day 19, 09:00 | Email | Ascend (profit maximiser: mentoring) | Book 7: we'll get someone in is not a plan | Teach 'name the person'; explain One Lane Mentoring plainly, who it is and isn't for | Apply for One Lane Mentoring |
| Day 26, 09:00 | Email | Excite (renewed value) into Advocate | Book 8: two streets apart, two different markets | Preview Chapter Two (Townhill and Cockett); give the free two-area search pack | Download the free search pack |
| Day 33, 09:00 | Email | Advocate | Book 9: what's your rejection rule? | Invite a reply: their rejection rule, or what they did with Chapter One | Reply with your rejection rule |
| Day 40, 09:00 | Email | Promote | Book 10: know someone about to buy? | Ask them to send the book page to one person who is about to buy | Share the book page with one person |
| Day 47, 09:00 | Email | Nurture with soft Ascend | Book 11: a flood flag on a house uphill | Teach the flood-flag lesson and four first checks; soft pointer to the Searches Kit | See the Searches Kit (£97) |
| Day 54, 09:00 | Email | Nurture close (end of series) | Book 12: the last email in this series | Leave them with the chapter's key line; say plainly this is the last of the series; how to stay in touch | Keep the book companion page |

After day 54: the reader drops into Martin's normal occasional emails (property tips and book news), which is what the tick-box covered.

## 3. Every message, final copy

### 3a. Emails (sequence A, runs today, email only)

Subject marked (pick) is the one in the JSON. Body is exactly as in the JSON.

#### Email 1, day 0: Book 1: your chapter, and one thing to do tonight

- CVJ stage: Excite (first win)
- Job: Deliver the chapter again and get the buying brief written tonight
- Call to action: Open the buying-brief worksheet
- Subject A: Your chapter, and one thing to do tonight (pick)
- Subject B: Before You Buy: Chapter One is here 
- Preview text: Seven lines to write before your next viewing
- Words (including footer): 311

```text
{{FIRSTNAME}}, here is Chapter One of Before You Buy, as promised.

https://martinhowardproperty.co.uk/assets/downloads/before-you-buy-chapter-one.pdf

It's called Does This Fit Me? It opens with the first property venture my business partner Meirion and I ran: a serviced apartment in Cardiff that looked the part, and a business inside it that didn't suit us.

If you only do one thing tonight, make it this. Open the buying-brief worksheet and answer it for the next deal you could actually take on.

https://martinhowardproperty.co.uk/book/companion/#brief

There are seven lines: your main goal, your starting approach, your deal money and a separate contingency, the hours you can give each week, the work you'll do and the help you'll need, a setback you could cope with, and your rejection rule.

Your answers stay on that page and aren't sent to me, so print it or save it as a PDF before you close it. Then keep it beside you when you search.

The line most people leave blank is the rejection rule. Write it anyway. It's the one that protects you when you fall for a house.

If you gave us your mobile number, I or one of my team will give you a quick call about the book and the property you're looking at. If you'd rather not have the call, reply and say so.

Over the next few weeks I'll send you the practical checks I use on a property and, now and then, a tool, kit or programme of mine that does part of the job. Every email has a way to leave at the bottom.

Martin

You're getting this because you asked for Chapter One of Before You Buy. Martin Howard Property is a trading name of MH196 Ltd, registered in England and Wales, company number 15060897. Registered office: 5 Clothier Meadow, Castle Cary, Somerset BA7 7HA. Property education, not financial, legal, tax or survey advice.

{{UNSUBSCRIBE}}
```

#### Email 2, day 1: Book 2: the ordinary Tuesday test

- CVJ stage: Excite (trust)
- Job: Build trust with the Cardiff story; teach the ordinary Tuesday test
- Call to action: Reply with the property type and the first job it would create
- Subject A: The question we didn't ask in Cardiff (pick)
- Subject B: Picture an ordinary Tuesday 
- Preview text: Who gets the call on a Friday night?
- Words (including footer): 347

```text
{{FIRSTNAME}}, when Meirion and I set up our first serviced apartment in Cardiff, we thought hard about the apartment. We didn't think hard enough about the business we'd be running inside it.

We had started at a difficult time of year. Some weeks, Friday arrived with the weekend still empty. Between bookings came the cleaning, the guest questions, the coffee sachets and the fresh bedding. One guest who was supposed to have a quiet stay held a party and upset the neighbours.

The property was fine. The job that came with it didn't suit us. So we moved into finding properties for investors instead, and that work suited us better.

I've been involved in more than £30 million of property projects, and that lesson from Cardiff is the one I'd put first. A lovely property doesn't automatically make a lovely business.

So here's the test I'd run before your next viewing.

Picture an ordinary Tuesday in the business that property creates. Then picture a Friday evening when something goes wrong. Who gets the call? Who can attend? Who makes the decision?

Now write down the first three jobs the purchase would create. For a refurbishment, that might be agreeing the scope, checking prices and arranging access. For a ready-to-let property, it might be checking the condition, arranging management and finding out what has to happen before a tenant moves in.

Give each job a name, a cost and a place in the diary. If those lines stay blank, you've found a gap in your plan. Fix it while the property still belongs to someone else.

I'd like to know what you're looking at. Reply and tell me in a line: what kind of property is it, and what's the first job it would give you?

Martin

You're getting this because you asked for Chapter One of Before You Buy. Martin Howard Property is a trading name of MH196 Ltd, registered in England and Wales, company number 15060897. Registered office: 5 Clothier Meadow, Castle Cary, Somerset BA7 7HA. Property education, not financial, legal, tax or survey advice.

{{UNSUBSCRIBE}}
```

#### Email 3, day 2: Book 3: your walk-away price, before you fall for the house

- CVJ stage: Convert (main pitch)
- Job: Teach 'write your limit first' with the chapter's sum; show Property Predator doing that job; make the READ75 offer
- Call to action: Start Hunter at £9.75 with READ75
- Subject A: Write your limit before you fall for the house (pick)
- Subject B: A thank-you for reading: your first month for £9.75 
- Preview text: The £7,000 gap most buyers miss
- Words (including footer): 453

```text
{{FIRSTNAME}}, in Chapter One I called it changing your rules because you like the house.

You set a maximum budget. Then you find a property with "so much potential". Suddenly the budget becomes flexible, the contingency gets smaller and the awkward questions can apparently wait.

The fix isn't exciting, but it works. Write your limits before you fall in love with a listing.

Remember the sum in the chapter. You have £30,000 available after protecting your household reserve. The deposit is £25,000, so the property looks affordable. Add £4,000 of purchase costs and £8,000 of work and the plan needs £37,000. You're £7,000 short before a single delay or surprise repair. Those were made-up figures to show the problem. The mistake is real, and it's usually made on the one property someone has already fallen for.

Doing that sum properly on every property you look at takes time. That's the job Property Predator does. It's my own software, built on the same thinking as the book, and the plan I'd point a reader to is called Hunter. It gives you:

Unlimited appraisals, all 4 strategies. Check every property you view, not only the one you've fallen for.

Predator Verdicts and Auction Mode. A clear read on whether the figures stack up, and help setting your limit before the room gets loud.

Max-offer solver and 3-way valuation. Know your walk-away price before you pick up the phone.

Saved deals, pipeline and PDF reports. Keep your search in one place and take the numbers with you.

Hunter is normally £39 a month. As a thank-you for reading, the code READ75 takes 75% off your first month, so it costs £9.75. After that it's £39 a month until you cancel, and you can cancel any time. This link applies the code for you:

https://propertypredator.com/app?plan=pro_buyer&promo=READ75&utm_source=mhp-book&utm_medium=email&utm_campaign=before-you-buy

Here's what I'd do with it this week. Run the property you're most excited about, and one you've already dismissed. Take the max-offer figure on the favourite, write it on your buying brief next to your rejection rule, and don't move it at the viewing.

It gives you figures and information to help you decide. It won't decide for you and it won't find deals for you. It isn't financial, legal, tax or survey advice, and the checks that belong to your surveyor, conveyancer and broker still belong to them.

If you've already started Hunter, ignore this, and thank you.

Martin

You're getting this because you asked for Chapter One of Before You Buy. Martin Howard Property is a trading name of MH196 Ltd, registered in England and Wales, company number 15060897. Registered office: 5 Clothier Meadow, Castle Cary, Somerset BA7 7HA. Property education, not financial, legal, tax or survey advice.

{{UNSUBSCRIBE}}
```

#### Email 4, day 4: Book 4: is it worth it for a few properties?

- CVJ stage: Convert (objections + fallback)
- Job: Answer the 'only a few properties' objection; repeat the offer; give the free extension to those not ready
- Call to action: Start Hunter with READ75 (fallback: free Chrome extension)
- Subject A: Is it worth it if I only look at a few properties? (pick)
- Subject B: Straight answers about Property Predator 
- Preview text: Four straight answers, and a free option
- Words (including footer): 329

```text
{{FIRSTNAME}}, here's a fair question to ask before you pay for anything: is Property Predator worth it if I'm only looking at a few properties?

My honest answer is that a few properties is when it matters most. When you're only looking at two or three, one of them becomes the favourite quickly, and that's the one you're most likely to talk yourself into. Unlimited appraisals means you can run the ones around it too, and see whether your favourite still looks good beside them.

Three more straight answers.

Will it tell me to buy?
No. It gives you figures and a verdict on whether they stack up. The decision stays with you, and so do the checks that belong to your surveyor, conveyancer and broker.

Will it find me a deal?
No. Hunter is for appraising properties you've already found. It doesn't include owner look-ups or off-market sourcing.

Is this another subscription I'll forget about?
The first month is £9.75 with READ75, then £39 a month until you cancel, and you can cancel any time. If you only want it for the month you're making a decision, that's a perfectly fair way to use it.

If you'd like to try it, the code is already in this link:

https://propertypredator.com/app?plan=pro_buyer&promo=READ75&utm_source=mhp-book&utm_medium=email&utm_campaign=before-you-buy

Not ready to pay for anything yet? That's sensible too. Property Predator has a free Chrome extension, for Chrome on a desktop or laptop, that lets you review supported property listings in your browser. It costs nothing:

https://propertypredator.com/extension

Either way, keep your buying brief beside you. A tool is only as useful as the limits you bring to it.

If you've already signed up, ignore this one.

Martin

You're getting this because you asked for Chapter One of Before You Buy. Martin Howard Property is a trading name of MH196 Ltd, registered in England and Wales, company number 15060897. Registered office: 5 Clothier Meadow, Castle Cary, Somerset BA7 7HA. Property education, not financial, legal, tax or survey advice.

{{UNSUBSCRIBE}}
```

#### Email 5, day 7: Book 5: investigate, negotiate or leave it alone

- CVJ stage: Ascend (entry kit)
- Job: Teach the three-way written decision; offer the £47 First Purchase Kit to first-time investors
- Call to action: Get the First Purchase Kit (£47)
- Subject A: Investigate, negotiate or leave it alone (pick)
- Subject B: The one-page sheet I'd want at every viewing 
- Preview text: Why 'maybe' is where the evenings go
- Words (including footer): 336

```text
{{FIRSTNAME}}, the promise of Before You Buy is simple. Take a property that catches your eye and reach a reasoned first decision: investigate it, negotiate on it, or leave it alone.

Most people only have two settings, yes and maybe. Maybe is where the evenings go.

So give every property a written decision, including the ones you reject. Write the numbers down, pick one of the three, and say why. "Too expensive" isn't a reason. "Once I include the works and purchase costs, the rent doesn't support my plan at that price" is a reason, and it's one an agent can do something with.

If you've never bought an investment property, or you've bought one home with a normal mortgage and nothing since, my First Purchase Kit is built for exactly that stage. It's £47, paid once, and it includes:

The First Purchase Calculator. Deposit, cash needed and monthly payment, for up to three deals side by side, so the Chapter One sum gets done before you offer.

The decision sheet. One page per property: go, renegotiate or walk away, and why.

7 lessons, 2 hours in all, with a one-lesson-a-day plan and a task on a real property each day.

A 17-page field guide to print, with a 28-point checklist and 5 questions to take to the professionals.

A worked deal clinic, with the numbers and the decision.

It's in your members area as soon as you pay, and it doesn't expire. There's a 14-day refund, no questions asked. If you later want the full course, whatever you've paid for kits in the last 90 days comes off it.

https://martinhowardproperty.co.uk/kits/property-from-the-beginning/

If you've already got it, or you're past this stage, ignore this one.

Martin

You're getting this because you asked for Chapter One of Before You Buy. Martin Howard Property is a trading name of MH196 Ltd, registered in England and Wales, company number 15060897. Registered office: 5 Clothier Meadow, Castle Cary, Somerset BA7 7HA. Property education, not financial, legal, tax or survey advice.

{{UNSUBSCRIBE}}
```

#### Email 6, day 12: Book 6: what if the work takes three months longer?

- CVJ stage: Ascend (core offer: the course)
- Job: Teach the three 'suppose' stress questions; offer Property Done Properly
- Call to action: See the course (£1,497 or 3 x £525)
- Subject A: What if the work takes three months longer? (pick)
- Subject B: Three questions to ask before every offer 
- Preview text: Your first deal should leave you calm
- Words (including footer): 383

```text
{{FIRSTNAME}}, here are three questions from Chapter One I'd ask before every offer.

Suppose the work takes three months longer. Could you keep paying the bills?

Suppose the rent comes in below your estimate. Would ownership still be manageable?

Suppose the refinance releases less money than you hoped. Could you leave more cash in the property?

If the deal only works when the work finishes on the earliest date, the highest rent is achieved and every pound comes back on refinance, you have very little room to manoeuvre. A delay that's manageable for one buyer can force another into a rushed sale.

Your first deal should leave you able to make the next decision calmly.

Putting real numbers against those questions, for the kind of property you actually want, is what my full course is for. It's called Property Done Properly, and it's for anyone who wants to run one property approach on their own patch without joining a mastermind. You get:

26 modules and 192 lessons, each with a task, across the four ways into property I teach: Refer, Source, Run and Own. Wales first, England second.

23 worked deal clinics with real-shaped numbers, so you see the method tested on a deal before you use it.

The six calculators, for life, kept current as the rules change.

Your Desk for life: a CRM for your contacts and pipeline, an enquiry page and unlimited deal files.

One live deal clinic booking a quarter, with your deal on the screen, plus lifetime access and a quarterly re-check of the rules.

It's £1,497 paid once, or 3 monthly payments of £525 (£1,575 in total). There's a 30-day refund, no questions asked. If you've bought any of my kits in the last 90 days, what you paid comes off.

https://martinhowardproperty.co.uk/join/

If a whole course is more than you need right now, that's fine. The chapter and your buying brief are still the right place to start.

If you've already joined, ignore this one.

Martin

You're getting this because you asked for Chapter One of Before You Buy. Martin Howard Property is a trading name of MH196 Ltd, registered in England and Wales, company number 15060897. Registered office: 5 Clothier Meadow, Castle Cary, Somerset BA7 7HA. Property education, not financial, legal, tax or survey advice.

{{UNSUBSCRIBE}}
```

#### Email 7, day 19: Book 7: we'll get someone in is not a plan

- CVJ stage: Ascend (profit maximiser: mentoring)
- Job: Teach 'name the person'; explain One Lane Mentoring plainly, who it is and isn't for
- Call to action: Apply for One Lane Mentoring
- Subject A: "We'll get someone in" isn't a plan (pick)
- Subject B: If you'd like someone beside you for 90 days 
- Preview text: Who it's for, who it isn't, and the price
- Words (including footer): 366

```text
{{FIRSTNAME}}, there's a line in Chapter One I come back to a lot: "We will get someone in" leaves an important part of the plan unanswered.

If you need help, name the person or the role. Find out what they'll do, what they'll charge and what stays your responsibility.

Sometimes the missing person is a builder or a conveyancer. Sometimes it's someone to check your thinking every couple of weeks, and to notice when you've started changing your rules because you like the house.

That's what One Lane Mentoring is for. It's a 90-day implementation programme for a group of twelve. You get:

A one-to-one path session at the start, to agree your starting point and route.
A personal 90-day plan, set for your hours and your money.
Fortnightly group sessions, where members' deals are worked on live.
A weekly scorecard, reviewed.
A WhatsApp group between sessions, with published hours and response times.
The full course, Property Done Properly, included, so nothing is paid twice.

The price is published, so it won't be a surprise: £3,997, or 6 monthly payments of £699 (£4,194 in total). You get the price, instalments, cancellation rights and support limits in writing before you pay.

Who it suits: you can give a few focused hours every week, including the bad weeks, and you'll fill in the scorecard when nothing has happened yet.

Who it isn't for: anyone who needs the money this month, anyone who wants a promised result (nobody honest can give one), and anyone looking for financial, mortgage, tax or legal advice.

Applying isn't buying. It takes a few minutes and there's no card. I read every application myself, and it leads to a free 20-minute Income Path Call where we decide together whether it fits. If it isn't right for you, I'll say so.

https://martinhowardproperty.co.uk/webinar/apply/?src=book

If you've already applied, thank you. There's nothing more to do.

Martin

You're getting this because you asked for Chapter One of Before You Buy. Martin Howard Property is a trading name of MH196 Ltd, registered in England and Wales, company number 15060897. Registered office: 5 Clothier Meadow, Castle Cary, Somerset BA7 7HA. Property education, not financial, legal, tax or survey advice.

{{UNSUBSCRIBE}}
```

#### Email 8, day 26: Book 8: two streets apart, two different markets

- CVJ stage: Excite (renewed value) into Advocate
- Job: Preview Chapter Two (Townhill and Cockett); give the free two-area search pack
- Call to action: Download the free search pack
- Subject A: Two streets apart, two different markets (pick)
- Subject B: Where should you look? A free search pack 
- Preview text: A preview of Chapter Two, and a free pack
- Words (including footer): 320

```text
{{FIRSTNAME}}, Chapter One was about what you're trying to buy. Chapter Two asks where you should look, and here's a preview.

When Meirion and I started sourcing, I lived in Somerset and he lived in Carmarthen. We needed somewhere we could actually get to and work in. So we looked up and down the M5 and across the M4, comparing purchase prices with the rents we thought properties could achieve. As we moved west past Bridgend, the relationship between price and rent looked more attractive, and we ended up working in Swansea.

Then we learned it, street by street. Townhill and Cockett sit next to each other. In the places we were looking, you could drive a very short distance, cross a road, and find a noticeable change in the housing, the feel of the street and the prices people would pay.

A postcode is too big to buy on. My old sourcing checklist had a simple instruction for this: walk it and talk it. Walk the streets, at different times where practical. Ask local agents specific questions. "Is it a good area?" gets you a vague answer. "What changes when I cross this road?" gets you something you can use.

To put that into practice, there's a free two-area search pack: two area-research sheets, space for ten comparable listings in each area, a three-property shortlist, and a buying-fit check that carries your Chapter One limits into the search.

https://martinhowardproperty.co.uk/assets/downloads/before-you-buy-area-search-pack.pdf

Print it, pick two areas, and mark each property reject, investigate or ready to view. You're choosing where to spend your next hour, not committing to a purchase.

Martin

You're getting this because you asked for Chapter One of Before You Buy. Martin Howard Property is a trading name of MH196 Ltd, registered in England and Wales, company number 15060897. Registered office: 5 Clothier Meadow, Castle Cary, Somerset BA7 7HA. Property education, not financial, legal, tax or survey advice.

{{UNSUBSCRIBE}}
```

#### Email 9, day 33: Book 9: what's your rejection rule?

- CVJ stage: Advocate
- Job: Invite a reply: their rejection rule, or what they did with Chapter One
- Call to action: Reply with your rejection rule
- Subject A: What's your rejection rule? (pick)
- Subject B: One line, by reply 
- Preview text: No tool, no kit. Just a question
- Words (including footer): 200

```text
{{FIRSTNAME}}, no tool and no kit today. Just a question.

What did you write as your rejection rule?

It's the last line of the buying brief, and the one most people skip. It's the condition that makes you leave a deal alone, written before you've seen the house, so enthusiasm can't do the maths for you.

It can be simple. As examples only: "If the total cash needed eats into my contingency, I walk." Or: "If the plan only works at the highest rent, I walk."

Reply and tell me yours, or tell me what's stopped you writing one. If you've used anything from Chapter One on a real property, I'd like to hear that too: what you did, and what you decided.

I read the replies. If I ever want to share something you've said, I'll ask you first, and I won't use it without your permission.

Martin

You're getting this because you asked for Chapter One of Before You Buy. Martin Howard Property is a trading name of MH196 Ltd, registered in England and Wales, company number 15060897. Registered office: 5 Clothier Meadow, Castle Cary, Somerset BA7 7HA. Property education, not financial, legal, tax or survey advice.

{{UNSUBSCRIBE}}
```

#### Email 10, day 40: Book 10: know someone about to buy?

- CVJ stage: Promote
- Job: Ask them to send the book page to one person who is about to buy
- Call to action: Share the book page with one person
- Subject A: Know someone about to buy a property? (pick)
- Subject B: A small favour, if the chapter helped 
- Preview text: The best time to read it is before the viewing
- Words (including footer): 158

```text
{{FIRSTNAME}}, one small favour, if Chapter One has been useful to you.

Do you know someone who's about to buy a property? A first rental, a do-up, a flat that looks a little too cheap. The best time to read Chapter One is before the viewing, while changing your mind still costs very little.

If so, send them the book page with a line of your own. They can get the same free chapter and use the same buying-brief worksheet, with no card details:

https://martinhowardproperty.co.uk/book/

That's all I'm asking. And if you've got a question about the property you're looking at, reply. I read the replies.

Martin

You're getting this because you asked for Chapter One of Before You Buy. Martin Howard Property is a trading name of MH196 Ltd, registered in England and Wales, company number 15060897. Registered office: 5 Clothier Meadow, Castle Cary, Somerset BA7 7HA. Property education, not financial, legal, tax or survey advice.

{{UNSUBSCRIBE}}
```

#### Email 11, day 47: Book 11: a flood flag on a house uphill

- CVJ stage: Nurture with soft Ascend
- Job: Teach the flood-flag lesson and four first checks; soft pointer to the Searches Kit
- Call to action: See the Searches Kit (£97)
- Subject A: Fifty metres is a distance, not a height (pick)
- Subject B: Flood, knotweed, coal: which ones kill a deal? 
- Preview text: A map flag is the start of the question
- Words (including footer): 343

```text
{{FIRSTNAME}}, my approach to a property starts with four questions. Is the building straight and true? Is there Japanese knotweed? What does the title reveal? And what does a flood warning mean for this particular property?

Flooding is the one people get wrong in both directions.

I have bought properties flagged for flood risk where the house was uphill from the river. So a flag on a map isn't, on its own, a reason to walk away.

It's also a reason to be precise. Fifty metres from a river is a distance, not a height. A hillside position doesn't rule out flooding: water can run down the hill or back up through drainage. Check the building-specific position, every relevant source of water, the history, the insurance terms and what your lender will need.

Knotweed is similar. It doesn't make every property unbuyable. It gives you a job to understand and cost: identification, extent, a costed management proposal and the funding requirements.

The skill is telling which findings kill a deal and which ones just change the price. That's what my Searches Kit is for: coal, radon, flood, knotweed and the other ground and environmental searches, for buyers in the Valleys and anywhere else with a history under the ground. It's £97 and includes 8 lessons, the Search Risk Tracker (does each finding kill the deal, price it, or nothing?), a 19-page field guide, the decision sheet, and a worked deal clinic on a Rhondda Fach terrace with coal, a tip, radon and surface water on one set of searches.

https://martinhowardproperty.co.uk/kits/ground-and-environment-what-the-searches-tell-you/

There's a 14-day refund, no questions asked. It doesn't replace a survey, your searches or your conveyancer. It helps you ask them better questions.

If you've already got it, ignore this.

Martin

You're getting this because you asked for Chapter One of Before You Buy. Martin Howard Property is a trading name of MH196 Ltd, registered in England and Wales, company number 15060897. Registered office: 5 Clothier Meadow, Castle Cary, Somerset BA7 7HA. Property education, not financial, legal, tax or survey advice.

{{UNSUBSCRIBE}}
```

#### Email 12, day 54: Book 12: the last email in this series

- CVJ stage: Nurture close (end of series)
- Job: Leave them with the chapter's key line; say plainly this is the last of the series; how to stay in touch
- Call to action: Keep the book companion page
- Subject A: The last email in this series 
- Subject B: "Someone else would buy it" is no reason (pick)
- Preview text: The line I'd most like you to remember
- Words (including footer): 246

```text
{{FIRSTNAME}}, this is the last email in this series, so I'll leave you with the line from Chapter One I'd most like you to remember.

"Someone else would buy it" is no reason for you to buy it.

A problem can be fixable and still be wrong for you. A specialist may know exactly how to solve it, but the cost, the delay or the cash required may fall outside your limits. That isn't you being timid. That's your buying brief doing its job.

So before your next offer, take out the brief you wrote and read your rejection rule again. If the property breaks it, leave it alone, and don't feel bad about it.

The companion page is where your worksheets and the four first checks live. It's planned to grow into a numbered library of walkthroughs, and I'll tell you when they're ready:

https://martinhowardproperty.co.uk/book/companion/

From here you'll hear from me now and then, with property tips and news about the full book when it's available. If you've got a question about a property you're looking at, reply to any of my emails. That doesn't end with this series.

Thank you for reading.

Martin

You're getting this because you asked for Chapter One of Before You Buy. Martin Howard Property is a trading name of MH196 Ltd, registered in England and Wales, company number 15060897. Registered office: 5 Clothier Meadow, Castle Cary, Somerset BA7 7HA. Property education, not financial, legal, tax or survey advice.

{{UNSUBSCRIBE}}
```

### 3b. Texts (SMS), add when switched on

Character counts are with a 10-letter first name filled in. All GSM-7. Every text says who it is from and how to stop. Text 4 is the only one that mentions an offer, and it does not link to it.

- **Day 0, 10:00, Book text 1: did the chapter arrive** (152/160 chars)

  `Hi {{FIRSTNAME}}, it's Martin Howard. Did Chapter One of Before You Buy arrive OK? Reply with any question about the book or your property. STOP to opt out`

- **Day 1, 14:00, Book text 2: the promised call** (155/160 chars)

  `Hi {{FIRSTNAME}}, Martin Howard Property here. You added your mobile for a quick call about the book. When suits, and what are you looking at? STOP to opt out`

- **Day 3, 12:00, Book text 3: buying brief nudge** (151/160 chars)

  `Hi {{FIRSTNAME}}, Martin here. Done your buying brief yet? Start with the rejection rule: martinhowardproperty.co.uk/book/companion/#brief STOP to opt out`

- **Day 5, 12:00, Book text 4: reader offer is in your inbox** (160/160 chars)

  `Hi {{FIRSTNAME}}, Martin here. I've emailed you a reader offer as a thank-you for reading Before You Buy. Any questions on the chapter, just reply. STOP to opt out`

- **Day 9, 18:00, Book text 5: first three jobs** (151/160 chars)

  `Hi {{FIRSTNAME}}, Martin here. Chapter One asks: what are the first 3 jobs your purchase would create? Reply with yours for a second view. STOP to opt out`

- **Day 15, 18:00, Book text 6: last text, what would make you walk away** (153/160 chars)

  `Hi {{FIRSTNAME}}, Martin here. Last text unless you reply: what would make you walk away from the property you're looking at? Happy to talk. STOP to opt out`

Text 4 is exactly 160 characters with a 10-letter name; a longer name makes it a two-part text. If the system cannot cap names, shorten "Any questions on the chapter, just reply." to "Questions? Just reply."

### 3c. WhatsApp, add when switched on (list only: this tool cannot create WhatsApp steps yet)

Template-style messages for approval in WhatsApp Business. {{1}} is the first name. Send each one INSTEAD of the text on the same slot for people who have opted in to WhatsApp. Utility templates relate directly to what the person asked for (the chapter and the promised call). The rest are classed by WhatsApp as marketing even though they are about the book, so they need the WhatsApp marketing opt-in and an opt-out button ("Stop messages"). Once someone replies, the 24-hour service window allows free-form replies from Martin or the team.

- **Day 0, D0 +1h (in place of text 1): template `book_chapter_ready`, utility** (234 chars)

  `Hi {{1}}, this is Martin Howard Property. Your free Chapter One of Before You Buy is here: https://martinhowardproperty.co.uk/assets/downloads/before-you-buy-chapter-one.pdf Reply to this message with any question about the book.`

- **Day 1, D1 +5h (in place of text 2): template `book_call_arrange`, utility** (194 chars)

  `Hi {{1}}, you added your number for a quick call about Before You Buy. Reply with a day and time that suits you, and the property you're looking at, and Martin or one of the team will call.`

- **Day 3, D3 12:00 (in place of text 3): template `book_brief_nudge`, needs marketing opt-in** (200 chars)

  `Hi {{1}}, Martin here. Have you written your buying brief yet? The rejection rule is the line that protects you when you fall for a house: https://martinhowardproperty.co.uk/book/companion/#brief`

- **Day 5, D5 12:00 (in place of text 4): template `book_reader_offer_note`, needs marketing opt-in** (173 chars)

  `Hi {{1}}, Martin here. I've emailed you a reader offer as a thank-you for reading Before You Buy. If you have a question about the chapter or your property, reply here.`

- **Day 9, D9 18:00 (in place of text 5): template `book_three_jobs`, needs marketing opt-in** (157 chars)

  `Hi {{1}}, Martin here. Chapter One asks you to write down the first three jobs your purchase would create. Reply with yours if you'd like a second view.`

- **Day 15, D15 18:00 (in place of text 6): template `book_walk_away`, needs marketing opt-in** (162 chars)

  `Hi {{1}}, Martin here. This is my last message unless you reply. What would make you walk away from the property you're looking at? Happy to talk it through.`

## 4. The combined email + text version

It does not fit in one sequence. Twelve emails need 23 steps on their own; adding six texts and their waits makes 35. Options considered:
1. One sequence, drop emails: would mean ending the emails at day 12 (no mentoring, Advocate or Promote). Rejected.
2. One sequence, drop texts: defeats the point.
3. Two linked sequences (recommended). Part 1 is days 0 to 15 with all six emails of that period and all six texts: exactly 23 steps, in `sequence-email-sms.json`. Part 2 is the emails from day 19 to day 54, starting with a wait so the Fibonacci gaps are unbroken.

Part 1 steps (as in the JSON): Email 1 (day 0, 09:00) > wait 1h > Text 1 > wait 23h > Email 2 (day 1) > wait 5h > Text 2 > wait 19h > Email 3 (day 2) > wait 1d 3h > Text 3 (day 3, 12:00) > wait 21h > Email 4 (day 4) > wait 1d 3h > Text 4 (day 5, 12:00) > wait 1d 21h > Email 5 (day 7) > wait 2d 9h > Text 5 (day 9, 18:00) > wait 2d 15h > Email 6 (day 12) > wait 3d 9h > Text 6 (day 15, 18:00). 12 messages + 11 waits = 23 steps.

Part 2 (build when sequence linking exists; 12 steps): wait 3d 15h (so it lands on day 19 at 09:00 if Part 2 starts the moment Part 1 ends) > Email 7 > wait 7d > Email 8 > wait 7d > Email 9 > wait 7d > Email 10 > wait 7d > Email 11 > wait 7d > Email 12. The email copy is identical to steps 13 to 23 of `sequence-email.json`.

Alternative if Martin prefers the mentoring email inside Part 1: drop Text 6 (day 15). Part 1 then runs to Email 7 on day 19 (7 emails + 5 texts = 23 steps) and Part 2 starts with a 7-day wait before Email 8. I recommend keeping Text 6, because it is the one that tells people texting stops.

Until linking exists: run `sequence-email.json` for everyone. When SMS is switched on, run Part 1 for people with a mobile number and Part 2 for them by manual enrolment on day 15 or 16.

## 5. Permission rules applied, and the extra tick-box wording

What the form allows today:
- Email: "Give me access to Chapter One and email me about Before You Buy and occasional property tips from Martin Howard Property." The sequence leads with something useful in every email and keeps one main call to action per email (email 4 has the extension as a fallback for people who say no to the main one).
- Mobile: "Add your mobile and Martin or one of his team will give you a quick call to answer your questions about the book and the property you're looking at" and "If you give a mobile number we'll use it to call or message you about the book." So texts and WhatsApp in this plan are only about the book and the reader's property questions. None sells software, kits or mentoring. Text 4 mentions once that a reader offer has been emailed, with no link and no price.

Plainly: under the current form, Martin may not send promotional texts or WhatsApp messages (offers, kits, mentoring, Property Predator, masterclass invitations) to this list.

Extra tick-box wording for the book form, if he wants promotional texts and WhatsApp in future (separate, unticked, optional, below the mobile field):

> "Also send me occasional texts and WhatsApp messages from Martin Howard Property with property tips and offers, including Martin's kits, courses, mentoring and his Property Predator software. Reply STOP or unsubscribe at any time."

Recommended tightening of the email tick, for new sign-ups (the present wording mentions the book and tips but not offers, and the sequence does pitch):

> "Give me access to Chapter One and email me about Before You Buy, occasional property tips, and offers of Martin Howard Property's training and Property Predator software. I can unsubscribe at any time."

## 6. What Martin has to decide or supply

1. Is the email sequence approved to run as written, given that the current tick-box does not mention offers? Recommended: yes, run it (the pitches are relevant to the book and each leads with a lesson), and change the tick wording for new sign-ups now as in section 5.
2. Who makes the promised calls, and how quickly? Recommended: within two working days of sign-up, by Martin or one named team member, logged so text 2 is skipped for anyone already called.
3. What time will you enrol readers each day while entry is manual? Recommended: once a day at 09:00 UK, so emails land at 09:00 and texts at sensible hours.
4. Do you want a deadline on READ75? Recommended: not in this sequence. If you want one, make it a real per-reader window enforced by Property Predator (for example 14 days from download), then add one honest line to emails 3 and 4. Do not add a date that the checkout does not enforce.
5. Is the kit and course checkout live? The First Purchase Kit page carries a fallback "Checkout opens later today". Recommended: buy one kit yourself (refund it) before the first enrolment.
6. Is the flood story safe to tell? It comes from your editorial notes ("Martin reports buying properties flagged by maps but physically uphill from the river"), not yet from a published chapter. Recommended: yes, as written in email 11, if it is accurate.
7. Will mentoring applications stay open? Recommended: keep email 7 as written (it does not claim they are open); if a cohort fills, the apply page should say so.
8. Who reads the replies? Emails 2, 9 and 10 and every text ask for a reply. Recommended: use a monitored reply-to (martin@propinvestuk.co.uk is the address on the site) and answer within two working days.
9. Until stop-on-purchase exists, should buyers be removed by hand? Recommended: yes, weekly, remove anyone who bought Hunter, a kit, the course or applied for mentoring from the matching sequence.
10. Do you want the off-market masterclass (or the next one) promoted to readers? Recommended: only by a one-off broadcast or the swap-in email in section 9 while the date is live, never in the evergreen sequence.
11. Should the D12 email be the course, or would you rather send a free recorded masterclass? Recommended: the course, unless you confirm a replay that stays up permanently and does not show expired prices.
12. Fix the kits.json / kits page mismatch for the five unavailable kits (none is mentioned in this sequence).

## 7. What needs building for the full version

1. A "book sign-up" entry rule: anyone who submits the /book/ form joins this sequence automatically (today entry is manual or webinar sign-up only). It should also tag the reader `book-reader` and record whether a mobile was given.
2. The SMS switch for the MHP brand, plus a send window (09:00 to 20:00 UK, no Sundays recommended) so texts never land at night when entry becomes automatic, and STOP handling.
3. The WhatsApp switch: a WhatsApp Business sender, the six templates above submitted for approval (two utility, four marketing), the WhatsApp marketing opt-in record, an opt-out button, and a way to create WhatsApp steps in a sequence.
4. Stop rules connected for this brand: stop on reply (at least for texts), stop on booked call, and stop on purchase. Purchase needs Property Predator (Hunter with READ75) and the members app (kits, course, mentoring) to send purchase events back.
5. Sequence linking (Part 1 to Part 2), or a raised step limit.
6. The extra consent tick for promotional texts and WhatsApp (section 5), stored with time stamp and wording, and the tightened email wording.
7. Channel rule: one of SMS or WhatsApp per touch per person, never both.
8. Name-length cap or two-part handling for texts (text 4 sits at 160 characters with a 10-letter name).

## 8. Validation output

Checked by a Python script run on the two JSON files:

```text
== sequence-email.json: parsed OK, 23 steps (limit 24), ends with a message
   email days from waits: [0, 1, 2, 4, 7, 12, 19, 26, 33, 40, 47, 54] OK
   11 distinct URLs, all verified or present in the website repo
   RESULT: PASS
== sequence-email-sms.json: parsed OK, 23 steps (limit 24), ends with a message
   email days from waits: [0, 1, 2, 4, 7, 12] OK
   SMS at day 0 +1h, 152/160 chars with 10-letter name, GSM-7 only: Book text 1: did the chapter arrive
   SMS at day 1 +5h, 155/160 chars with 10-letter name, GSM-7 only: Book text 2: the promised call
   SMS at day 3 +3h, 151/160 chars with 10-letter name, GSM-7 only: Book text 3: buying brief nudge
   SMS at day 5 +3h, 160/160 chars with 10-letter name, GSM-7 only: Book text 4: reader offer is in your inbox
   SMS at day 9 +9h, 151/160 chars with 10-letter name, GSM-7 only: Book text 5: first three jobs
   SMS at day 15 +9h, 153/160 chars with 10-letter name, GSM-7 only: Book text 6: last text, what would make you walk away
   6 distinct URLs, all verified or present in the website repo
   RESULT: PASS
OVERALL: PASS

Checks applied to every message: placeholders limited to {{FIRSTNAME}} {{LABEL}} {{LINK}} {{UNSUBSCRIBE}} (SMS: {{FIRSTNAME}} {{LINK}});
{{UNSUBSCRIBE}} on its own line at the end of every email; no exclamation mark, em or en dash, emoji, HTML,
markdown or curly quotes in any subject or body; every URL on its own line in emails; every URL is the verified
reader link, the verified extension link, or a file/page that exists in the website repo.
```

All live URLs were also confirmed with a GET request on 17 Nov 2026 (all returned 200): the Chapter One PDF, /book/, /book/companion/, the search pack PDF, the First Purchase Kit, the Searches Kit, /join/, /webinar/apply/?src=book, https://propertypredator.com/extension and the READ75 reader link.

## 9. Swap-in email (only while a live masterclass date exists)

Not in either JSON. Replace Email 6 (day 12) for the weeks before a dated masterclass, then switch back.

Name: Book 6 (swap-in): a free live masterclass. Subject A: "Free on [DAY DATE]: [TITLE]" (pick). Subject B: "Can you make [DAY] evening?"

```text
{{FIRSTNAME}}, here are three questions from Chapter One I'd ask before every offer. [keep the first five paragraphs of Email 6]

If you'd like to see this done on real deals, I'm running a free live masterclass on [DAY DATE] at [TIME] UK: [TITLE]. [One sentence from the masterclass page, quoted exactly.] It's free, online, and there's nothing to install.

[REGISTRATION URL, on its own line]

[Replay terms quoted from the page, for example "Can't make it live? Register anyway and you'll get the replay for 7 days."]

If you've already registered, I'll see you there.

Martin

[footer]

{{UNSUBSCRIBE}}
```

## 10. What changed from the interrupted draft

- Re-timed to the Fibonacci rule. The draft's gaps were 1,1,2,2,2,2,3,2,3,3 (emails on days 0,1,2,4,6,8,10,13,15,18,21); they are now 1,1,2,3,5,7,7,7,7,7,7 (days 0,1,2,4,7,12,19,26,33,40,47,54).
- Twelve emails instead of eleven. Draft emails 4 and 5 (objections, extension) merged into one day-4 email; new day-12 email for the course (Property Done Properly, £1,497 or 3 x £525, now that the £997 window has passed); new final email that says plainly the series has ended. The old "last email" (share the book) is now day 40 and no longer claims to be the last.
- Worksheet lines in email 1 now match the live companion page labels ("deal money and a separate contingency", "the work you'll do and the help you'll need").
- Removed claims I could not source: "I have... before a kitchen gets my attention" (replaced with the four questions from /book/), "the lender's requirements decide a lot" (replaced with the companion's knotweed wording), "if any of the three is blank" (now matches the chapter), "since we started" and "much better" (not in the chapter).
- Mentoring email no longer says "applications are open" (could go stale) and uses the apply page's own words for the process.
- Search pack email now describes the pack as the chapter does (ten comparables in each of two areas; the buying-fit check carries the Chapter One limits) and adds the chapter's "reject, investigate or ready to view" step.
- Footer now includes the registered office, as on the rest of the site.
- Every fact, price and URL re-checked against the repo; every URL GET-checked.
