import test from 'node:test';
import assert from 'node:assert/strict';
import { qaS1, qaS2 } from '../src/qa/checks.js';
import { scanBannedPhrases } from '../src/qa/banned.js';
import { validIntake } from './helpers.js';

const intake = validIntake();

function validS1() {
  return {
    scores: [
      { category: 'visibility', grade_1to10: 4, evidence: 'Their own words (F4): "showing up in Google when someone searches EICR near me" show discovery is search-led.', leak_cost_estimate: '£1,700/mo (= 2 missed landlords × £850 average certificate-to-rewire value)' },
      { category: 'message clarity', grade_1to10: 5, evidence: 'They describe it as (A2): "rewire and certify older houses for landlords" which is clear.', leak_cost_estimate: '£850/mo (= 1 confused enquiry lost × £850 average sale)' },
      { category: 'conversion path', grade_1to10: 4, evidence: 'Revenue reality (B4): "landlords who come back every year for certificates" — repeat-led.', leak_cost_estimate: '£1,700/mo (= 2 lost enquiries × £850)' },
      { category: 'follow-up', grade_1to10: 3, evidence: 'The list is cold (F2): "last emailed it eight months ago".', leak_cost_estimate: '£2,550/mo (= 3 lapsed landlords × £850 average value)' },
      { category: 'proof', grade_1to10: 4, evidence: 'Customers say things like (C2 via F4): "Word of mouth between landlords" but it is invisible online.', leak_cost_estimate: '£850/mo (= 1 lost job × £850)' },
      { category: 'offer strength', grade_1to10: 6, evidence: 'Their stated edge (E3): "turn certificates around in 24 hours" supports the premium position they claim.', leak_cost_estimate: '£1,700/mo (= 2 non-upsold certificates × £850)' },
    ],
    top_3_leaks: [
      'A 180-landlord email list untouched for eight months is compounding lost renewals.',
      'Search visibility depends on one profile while the certificate mills outrank them.',
      'No visible proof despite customers volunteering strong quotes about reliability.',
    ],
    quick_wins: [
      'Send one plain-text reactivation email to the 180-landlord list this week.',
      'Add three customer quotes to the homepage above the fold.',
      'Publish before/after photos on the Google Business Profile.',
    ],
    narrative_summary:
      'This is a business landlords already trust — the repeat certificate work proves it. The audit shows the demand side is fine; the leaks are almost all in follow-up and visibility. The email list alone represents the fastest recoverable revenue, and none of the fixes this quarter require new spend, just consistency.',
  };
}

test('qaS1 passes a well-grounded audit', () => {
  assert.deepEqual(qaS1(validS1(), intake), []);
});

test('qaS1 fails evidence without a verbatim quote', () => {
  const out = validS1();
  out.scores[0]!.evidence = 'The business clearly has visibility problems in its local market today.';
  const issues = qaS1(out, intake);
  assert.ok(issues.some((i) => i.check === 's1.evidence_not_verbatim'));
});

test('qaS1 fails evidence quoting words that are NOT in the intake', () => {
  const out = validS1();
  out.scores[0]!.evidence = 'They admitted (B4): "we have never once appeared in any search results anywhere" which is bad.';
  const issues = qaS1(out, intake);
  assert.ok(issues.some((i) => i.check === 's1.evidence_not_verbatim'));
});

test('qaS1 fails invented leak numbers', () => {
  const out = validS1();
  out.scores[0]!.leak_cost_estimate = '£123,456/mo based on industry benchmarks';
  const issues = qaS1(out, intake);
  assert.ok(issues.some((i) => i.check === 's1.leak_number_invented'));
});

test('qaS1 accepts leak numbers derived from B2/B3 with commas and annualisation', () => {
  const out = validS1();
  out.scores[0]!.leak_cost_estimate = '£10,200/yr (= 12 months × 1 lost landlord × £850 average sale)';
  assert.deepEqual(qaS1(out, intake), []);
});

function validS2() {
  return {
    profile_narrative:
      'The buyer is a portfolio landlord an hour away from his properties, self-managing four or five terraced houses while holding down another business. Renewal dates live in a spreadsheet he checks late at night, and every certificate deadline is another chance for something to slip. He is not shopping for an electrician; he is shopping for the feeling of not having to think about wiring again this year. When something trips or a purchase completes, he searches from his phone, rings three firms, and gives the job to whoever answers like a professional. He has been burned by paper-only certificate services before and now reads reports properly. The first company that explains findings in plain English and invoices cleanly becomes his default for every property — he does not want a supplier, he wants a routine. Price matters less than being able to delegate without checking up; what loses him is silence, vagueness, or an invoice his accountant queries. Win the first certificate and the rest of the portfolio follows without another sales conversation ever happening.',
    demographics: 'Landlords with 3–8 rental properties within reach of Buxton and north Derbyshire, typically managing remotely, spending around £850 per instruction.',
    situation: 'Self-managing landlord juggling compliance deadlines across several older terraced houses, an hour from the portfolio.',
    trigger_events: ['A renewal date looming on the compliance spreadsheet', 'A house purchase completing before tenants move in', 'A tenant reporting something tripping'],
    objections: ['The £99 certificate mills look cheaper', 'Will they actually show up when promised?', 'Will the report create expensive surprise work?'],
    desires_surface: 'A valid EICR certificate delivered fast with no chasing.',
    desires_deep: 'To stop carrying the low-level fear of invisible wiring problems and missed compliance deadlines — compliance as a routine someone else owns.',
    verbatims: ['the first electrician who actually turned up when he said he would', "You explained what the report meant in plain English, nobody's ever bothered before"],
    exclusions: ['Certificate-only buyers who want paper without a real inspection', 'Hagglers who dispute the bill after the work is done'],
    awareness_stage: 'solution aware',
    channels: ['Google search', 'FB groups'],
  };
}

test('qaS2 passes a grounded profile', () => {
  assert.deepEqual(qaS2(validS2(), intake), []);
});

test('qaS2 hard-fails a paraphrased verbatim (fact-echo)', () => {
  const out = validS2();
  out.verbatims[0] = 'the first electrician who actually showed up when he said he would'; // paraphrase
  const issues = qaS2(out, intake);
  assert.ok(issues.some((i) => i.check === 's2.verbatim_not_in_c2'));
});

test('qaS2 accepts verbatims differing only in smart quotes/whitespace', () => {
  const out = validS2();
  out.verbatims[1] = 'You explained what the report meant in plain English, nobody’s  ever bothered before';
  assert.deepEqual(qaS2(out, intake), []);
});

test('qaS2 requires at least two verbatims', () => {
  const out = validS2();
  out.verbatims = [out.verbatims[0] as string];
  const issues = qaS2(out, intake);
  assert.ok(issues.some((i) => i.check === 's2.verbatims_too_few'));
});

test('qaS2 rejects an awareness stage outside the Schwartz five', () => {
  const out = validS2();
  out.awareness_stage = 'hyper aware';
  const issues = qaS2(out, intake);
  assert.ok(issues.some((i) => i.check === 's2.awareness_stage_invalid'));
});

test('qaS2 accepts hyphen/case variants of a valid awareness stage', () => {
  const out = validS2();
  out.awareness_stage = 'Solution-Aware';
  assert.deepEqual(qaS2(out, intake), []);
});

test('qaS2 requires non-empty exclusions', () => {
  const out = validS2();
  out.exclusions = [];
  const issues = qaS2(out, intake);
  assert.ok(issues.some((i) => i.check === 's2.exclusions_empty'));
});

test('qaS2 rejects channels the customer never selected in C7', () => {
  const out = validS2();
  out.channels = ['TikTok'];
  const issues = qaS2(out, intake);
  assert.ok(issues.some((i) => i.check === 's2.channel_not_from_c7'));
});

test('qaS1 accepts period lengths and intake-echoed figures in leak estimates', () => {
  const out = validS1();
  out.scores[0]!.leak_cost_estimate = '£1,700 (= 2 lost landlords × £850) recovered inside a 90-day window';
  out.scores[1]!.leak_cost_estimate = 'the £400 wasted on the flopped magazine ad vs £850 average sale';
  assert.deepEqual(qaS1(out, intake), []);
});

test('qaS1 catches k-shorthand invented numbers (£29k must not pass as 29)', () => {
  const out = validS1();
  out.scores[0]!.leak_cost_estimate = 'roughly £29k/mo slipping away';
  const issues = qaS1(out, intake);
  assert.ok(issues.some((i) => i.check === 's1.leak_number_invented' && i.message.includes('29,000')));
});

test('qaS1 catches invented figures in top_3_leaks and narrative, not just estimates', () => {
  const out = validS1();
  out.top_3_leaks[0] = 'They are losing £5,000 every month to competitors nobody has heard of.';
  const issues = qaS1(out, intake);
  assert.ok(issues.some((i) => i.check === 's1.number_invented'));
});

test('qaS1 rejects the same quote reused as evidence for every category', () => {
  const out = validS1();
  for (const s of out.scores) {
    s.evidence = 'They said (A2): "rewire and certify older houses for landlords" which proves everything.';
  }
  const issues = qaS1(out, intake);
  assert.ok(issues.some((i) => i.check === 's1.evidence_repetitive'));
});

test('qaS1 rejects trivial full-value quotes ("850") as evidence', () => {
  const out = validS1();
  out.scores[0]!.evidence = 'Their average sale is (B2): "850" so visibility must be poor.';
  const issues = qaS1(out, intake);
  assert.ok(issues.some((i) => i.check === 's1.evidence_not_verbatim'));
});

test('qaS2 accepts a verbatim wrapped in quotation marks by the model', () => {
  const out = validS2();
  out.verbatims[0] = '"the first electrician who actually turned up when he said he would"';
  assert.deepEqual(qaS2(out, intake), []);
});

test('qaS2 rejects duplicated verbatims (distinct quotes required)', () => {
  const out = validS2();
  out.verbatims = [out.verbatims[0] as string, out.verbatims[0] as string];
  const issues = qaS2(out, intake);
  assert.ok(issues.some((i) => i.check === 's2.verbatims_too_few'));
});

test('qaS2 exempts double-quoted customer words from the banned scan, but not generated prose', () => {
  const quoted = validS2();
  quoted.profile_narrative += ' One customer called the process "totally seamless" in their review.';
  assert.deepEqual(qaS2(quoted, intake), []);

  const prose = validS2();
  prose.profile_narrative += ' We make the whole journey seamless for them.';
  const issues = qaS2(prose, intake);
  assert.ok(issues.some((i) => i.check === 'banned_phrase'));
});

test('qaS2 rejects channels that only share a generic token with C7', () => {
  const out = validS2();
  out.channels = ['LinkedIn search']; // customer picked "Google search"
  const issues = qaS2(out, intake);
  assert.ok(issues.some((i) => i.check === 's2.channel_not_from_c7'));
});

test('qaS2 rejects placeholder exclusions like "n/a"', () => {
  const out = validS2();
  out.exclusions = ['n/a'];
  const issues = qaS2(out, intake);
  assert.ok(issues.some((i) => i.check === 's2.exclusions_empty'));
});

test('banned phrase scan survives typography: curly apostrophe and un-hyphenated variants', () => {
  const issues = scanBannedPhrases(
    { a: 'In today’s fast-paced world, this is a real game changer.' },
    validIntake({ H3: null }),
  );
  assert.ok(issues.some((i) => i.message.includes("in today's fast-paced world")));
  assert.ok(issues.some((i) => i.message.includes('game-changer')));
});

test('qaS2 does NOT enforce H3 never-words on analysis docs (they bind S3+ copy)', () => {
  const out = validS2();
  out.objections = ['The cheap certificate mills undercut on price']; // "cheap" is in H3.never_use
  assert.deepEqual(qaS2(out, intake), []);
});

test('banned phrase scan catches global list and H3 never-words anywhere in the output', () => {
  const issues = scanBannedPhrases(
    { a: 'This offer is a real game-changer for you', nested: ['Our guru will help'] },
    intake, // H3.never_use includes "guru"
  );
  assert.ok(issues.some((i) => i.message.includes('game-changer')));
  assert.ok(issues.some((i) => i.message.includes('guru')));
});

test('banned phrase scan does not fire inside honest derived words', () => {
  // Single real-word bans get a trailing boundary: 'seamless' must not match
  // 'seamstress'/'seamlessly', 'elevate' must not match 'elevated'/'elevation'
  // (an "elevated fire risk" is honest prose, not the marketing cliché).
  const clean = scanBannedPhrases({ a: 'The seamstress noticed an elevated fire risk and worked seamlessly' }, validIntake({ H3: null }));
  assert.equal(clean.some((i) => i.message.includes('seamless')), false);
  assert.equal(clean.some((i) => i.message.includes('elevate')), false);
  // …but the standalone imperative cliché still fires.
  const dirty = scanBannedPhrases({ a: 'We elevate your brand with a seamless experience' }, validIntake({ H3: null }));
  assert.ok(dirty.some((i) => i.message.includes('elevate')));
  assert.ok(dirty.some((i) => i.message.includes('seamless')));
});
