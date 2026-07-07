import type { Intake } from '../src/types.js';

/**
 * A minimal-but-valid synthetic intake (fictional electrician) used by unit
 * tests. Fictional test data only — never marketing proof.
 */
export function validIntake(overrides: Partial<Record<string, unknown>> = {}): Intake {
  const base: Intake = {
    A1: 'Brightmoor Electrical (fictional)',
    A2: 'I rewire and certify older houses for landlords across the Peak District who need paperwork done right',
    A3: ['https://brightmoor-electrical.example', 'https://facebook.example/brightmoorsparks'],
    A4: '6–10',
    A5: 'Buxton, covering the Peak District and north Derbyshire',
    A6: 'local service or trades',
    A7: '2–5',
    B1: '$3–10k',
    B2: 850,
    B3: 6,
    B4: 'mostly landlords who come back every year for certificates, plus their word of mouth to other landlords',
    B5: '<$200',
    B6: '30–60%',
    C1:
      'Best customer is a landlord with four or five terraced houses who lives an hour away. ' +
      'He wants the certificate sorted without chasing, photos of anything dodgy, and an invoice that his accountant will not query. ' +
      'He found us after his old sparky retired and now sends every new purchase our way before tenants move in.',
    C2:
      "Honestly the first electrician who actually turned up when he said he would. Sorted the consumer unit same day.\n" +
      "You explained what the report meant in plain English, nobody's ever bothered before. Will be using you for all my properties.\n" +
      'Quick, tidy, no drama. The tenants barely knew you were there.',
    C3: 'They are really paying to stop worrying about compliance deadlines and dangerous wiring they cannot see, not for the certificate itself',
    C4: 'Usually a renewal date looming, a house purchase completing, or a tenant reporting something tripping',
    C5: 'Price versus the cheap certificate mills, whether we will actually show up, and if the report will create expensive surprise work',
    C6: 'Anyone who wants a certificate without the inspection actually being done properly, or who haggles after the work is finished',
    C7: ['Google search', 'FB groups', 'local/offline'],
    C8: 'Cheap online certificate services or whoever answers first on a directory site',
    D1: 'EICR certificate — $180 per property — landlords\nConsumer unit replacement — $650 — homeowners and landlords\nFull rewire — $4,500 — older properties',
    D2: 'Rewires are most profitable, certificates are easiest to sell and lead to everything else',
    D3: 'More consumer unit upgrades because they book in fast and lead to rewires',
    D4: 'All work guaranteed for 12 months, certificates redone free if the paperwork is queried',
    D5: 'a stretch',
    D6: 'No cash-in-hand jobs and no signing off work someone else did',
    E1: 'Peak Spark Ltd, Derwent Electrical, and the national certificate-mill sites',
    E2: 'We lose to the $99 certificate websites when a landlord only cares about the cheapest bit of paper',
    E3: 'We photograph everything, explain the report in plain English, and turn certificates around in 24 hours which nobody local matches',
    E4: 'premium',
    E5: 'The way Checkatrade tradesmen show before and after photos',
    F1: ['website', 'Google Business Profile', 'email list'],
    F2: 'About 180 landlords on the list, last emailed it eight months ago',
    F3: 'Paid $400 for a local magazine ad, got one call from someone selling us insurance',
    F4: 'Word of mouth between landlords and showing up in Google when someone searches EICR near me',
    F5: ['Facebook', 'Google Business Profile'],
    G1: 'Get to 25 landlord certificates a month on repeat contracts by the end of the quarter',
    G2: '2–5',
    G3: '$200–500',
    G4: 'New regs update in autumn always causes a rush',
    H1: { formal_casual: 4, playful_straight: 4, bold_understated: 2 },
    H2: 'Timpson for how they talk to customers, and a fictional tool brand that never shouts',
    H3: { never_use: 'cheap, guru, hack', must_use: 'certified, plain English' },
    H4: 'Busiest season is winter, please do not suggest weekly video content',
    _fixture_notice: 'FICTIONAL synthetic test intake for unit tests',
  };
  return { ...base, ...overrides } as Intake;
}
