import type {
  AnalyticsAttributionModel,
  AnalyticsConfidence,
  AnalyticsContentAttributionSnapshot,
  AnalyticsSourceAttributionSnapshot,
  AnalyticsTruth,
  GrowthAnalyticsSnapshot,
} from './growth-analytics-presenter.js';

export const PROPERTY_PREDATOR_ANALYTICS_AS_OF = '2026-08-26T10:30:00.000Z';
const OBSERVED_AT = '2026-08-26T10:15:00.000Z';

function evidence(truth: AnalyticsTruth, reference: string): Readonly<{
  truth: AnalyticsTruth;
  evidenceRef: string | null;
  observedAt: string | null;
}> {
  return Object.freeze({
    truth,
    evidenceRef: truth === 'measured' ? reference : null,
    observedAt: truth === 'measured' ? OBSERVED_AT : null,
  });
}

function content(args: Readonly<{
  id: string;
  title: string;
  format: string;
  model: AnalyticsAttributionModel;
  influenced: number | null;
  booked: number | null;
  revenue: number | null;
  truth: AnalyticsTruth;
}>): AnalyticsContentAttributionSnapshot {
  return Object.freeze({
    contentVersionId: args.id,
    title: args.title,
    format: args.format,
    attributionModel: args.model,
    influencedPeople: args.influenced,
    bookedConversions: args.booked,
    attributedRevenuePence: args.revenue,
    ...evidence(args.truth, `test-ledger:content:${args.id}`),
  });
}

function source(args: Readonly<{
  id: string;
  channel: string;
  source: string;
  affiliate: string | null;
  leads: number | null;
  qualified: number | null;
  bookings: number | null;
  revenue: number | null;
  truth: AnalyticsTruth;
  confidence: AnalyticsConfidence;
}>): AnalyticsSourceAttributionSnapshot {
  return Object.freeze({
    sourceId: args.id,
    channelLabel: args.channel,
    sourceLabel: args.source,
    affiliateLabel: args.affiliate,
    leads: args.leads,
    qualified: args.qualified,
    bookings: args.bookings,
    attributedRevenuePence: args.revenue,
    identityConfidence: args.confidence,
    ...evidence(args.truth, `test-ledger:source:${args.id}`),
  });
}

/**
 * An intentionally illustrative TEST fixture. Its measured rows represent
 * bounded observations in a fictional test ledger, never live trading results.
 */
export function createPropertyPredatorGrowthAnalyticsFixture(): GrowthAnalyticsSnapshot {
  return Object.freeze({
    workspaceName: 'Property Predator Growth HQ',
    asOf: PROPERTY_PREDATOR_ANALYTICS_AS_OF,
    periodLabel: 'Rolling 28 days · TEST evidence window',
    currency: 'GBP',
    environment: 'test',
    datasetKind: 'test_fixture',
    datasetLabel: 'Property Predator conversion rehearsal · fixture 04',
    funnel: Object.freeze([
      Object.freeze({
        milestoneId: 'captured',
        label: 'Captured',
        operatorMeaning: 'TEST identities accepted into the acquisition ledger with a source or explicit unknown marker.',
        order: 1,
        people: 480,
        ...evidence('measured', 'test-ledger:funnel:captured'),
      }),
      Object.freeze({
        milestoneId: 'engaged',
        label: 'Engaged',
        operatorMeaning: 'At least one evidenced content, message or site interaction in the TEST window.',
        order: 2,
        people: 312,
        ...evidence('measured', 'test-ledger:funnel:engaged'),
      }),
      Object.freeze({
        milestoneId: 'proof-consumed',
        label: 'Proof consumed',
        operatorMeaning: 'Consumed a bounded proof asset, webinar segment or deal-analysis lesson.',
        order: 3,
        people: 196,
        ...evidence('measured', 'test-ledger:funnel:proof-consumed'),
      }),
      Object.freeze({
        milestoneId: 'sales-ready',
        label: 'Sales ready',
        operatorMeaning: 'Reached the TEST score and intent threshold with a resolvable identity.',
        order: 4,
        people: 78,
        ...evidence('measured', 'test-ledger:funnel:sales-ready'),
      }),
      Object.freeze({
        milestoneId: 'autopsy-booked',
        label: 'Autopsy booked',
        operatorMeaning: 'Booked the Opportunity Autopsy conversion event inside the TEST ledger.',
        order: 5,
        people: 23,
        ...evidence('measured', 'test-ledger:funnel:autopsy-booked'),
      }),
      Object.freeze({
        milestoneId: 'closed-won',
        label: 'Closed won',
        operatorMeaning: 'A fictional TEST opportunity reached the closed-won milestone with an immutable value event.',
        order: 6,
        people: 7,
        ...evidence('measured', 'test-ledger:funnel:closed-won'),
      }),
    ]),
    content: Object.freeze([
      content({
        id: 'content-version-evidence-stack-v4',
        title: 'The postcode is not the opportunity. The evidence is.',
        format: 'LinkedIn authority post',
        model: 'assisted',
        influenced: 118,
        booked: 9,
        revenue: 13_500_00,
        truth: 'measured',
      }),
      content({
        id: 'content-version-autopsy-webinar-v5',
        title: 'Kill the Deal Before It Kills Your Capital',
        format: 'Webinar + replay',
        model: 'assisted',
        influenced: 86,
        booked: 8,
        revenue: 12_000_00,
        truth: 'measured',
      }),
      content({
        id: 'content-version-planning-trap-v3',
        title: 'The planning trap hidden in a pretty appraisal',
        format: 'Email lesson',
        model: 'last_touch',
        influenced: 74,
        booked: 4,
        revenue: 6_000_00,
        truth: 'measured',
      }),
      content({
        id: 'content-version-ownership-map-v2',
        title: 'Who actually controls the opportunity?',
        format: 'Evidence carousel',
        model: 'first_touch',
        influenced: 61,
        booked: 2,
        revenue: 3_000_00,
        truth: 'measured',
      }),
      content({
        id: 'content-version-replay-cut-v1',
        title: 'Three minutes that should kill a bad deal',
        format: 'Short-form video plan',
        model: 'linear',
        influenced: 95,
        booked: 6,
        revenue: 9_000_00,
        truth: 'simulated',
      }),
      content({
        id: 'content-version-whatsapp-proof-v1',
        title: 'Evidence clinic reminder sequence',
        format: 'WhatsApp rehearsal',
        model: 'last_touch',
        influenced: 42,
        booked: 5,
        revenue: 7_500_00,
        truth: 'simulated',
      }),
      content({
        id: 'content-version-social-listening-unbound',
        title: 'Unmatched social-listening mentions',
        format: 'Listening signal',
        model: 'assisted',
        influenced: null,
        booked: null,
        revenue: null,
        truth: 'unavailable',
      }),
    ]),
    sources: Object.freeze([
      source({
        id: 'affiliate-developers-circle',
        channel: 'Affiliate',
        source: 'Partner referral link',
        affiliate: 'The Developers Circle · TEST affiliate',
        leads: 124,
        qualified: 48,
        bookings: 8,
        revenue: 12_000_00,
        truth: 'measured',
        confidence: 'high',
      }),
      source({
        id: 'organic-linkedin',
        channel: 'LinkedIn',
        source: 'Organic authority content',
        affiliate: null,
        leads: 108,
        qualified: 39,
        bookings: 6,
        revenue: 9_000_00,
        truth: 'measured',
        confidence: 'high',
      }),
      source({
        id: 'owned-email',
        channel: 'Email',
        source: 'Owned education sequence',
        affiliate: null,
        leads: 92,
        qualified: 35,
        bookings: 4,
        revenue: 7_000_00,
        truth: 'measured',
        confidence: 'medium',
      }),
      source({
        id: 'direct-brand',
        channel: 'Direct',
        source: 'Property Predator branded entry',
        affiliate: null,
        leads: 73,
        qualified: 22,
        bookings: 2,
        revenue: 4_750_00,
        truth: 'measured',
        confidence: 'medium',
      }),
      source({
        id: 'whatsapp-rehearsal',
        channel: 'WhatsApp',
        source: 'Consent-gated follow-up plan',
        affiliate: null,
        leads: 42,
        qualified: 19,
        bookings: 5,
        revenue: 7_500_00,
        truth: 'simulated',
        confidence: 'unknown',
      }),
      source({
        id: 'unresolved-social',
        channel: 'Social listening',
        source: 'Unmatched mentions',
        affiliate: null,
        leads: null,
        qualified: null,
        bookings: null,
        revenue: null,
        truth: 'unavailable',
        confidence: 'unknown',
      }),
    ]),
    webinars: Object.freeze([
      Object.freeze({
        webinarId: 'webinar-evidence-clinic-04',
        title: 'Opportunity Evidence Clinic · rehearsal 04',
        sessionLabel: 'Observed TEST session · 21 August',
        registrations: 96,
        attended: 58,
        replayConsumers: 31,
        bookings: 8,
        attributedRevenuePence: 12_000_00,
        ...evidence('measured', 'test-ledger:webinar:evidence-clinic-04'),
      }),
      Object.freeze({
        webinarId: 'webinar-autopsy-scale-plan',
        title: 'Kill the Deal Before It Kills Your Capital · scale scenario',
        sessionLabel: 'Planning scenario · next cohort',
        registrations: 140,
        attended: 84,
        replayConsumers: 46,
        bookings: 14,
        attributedRevenuePence: 21_000_00,
        ...evidence('simulated', 'unused'),
      }),
    ]),
    cohorts: Object.freeze([
      Object.freeze({ cohortId: '2026-w30', label: 'W/C 27 Jul', leads: 96, qualified: 31, bookings: 4, attributedRevenuePence: 5_250_00, ...evidence('measured', 'test-ledger:cohort:2026-w30') }),
      Object.freeze({ cohortId: '2026-w31', label: 'W/C 03 Aug', leads: 112, qualified: 39, bookings: 5, attributedRevenuePence: 7_500_00, ...evidence('measured', 'test-ledger:cohort:2026-w31') }),
      Object.freeze({ cohortId: '2026-w32', label: 'W/C 10 Aug', leads: 126, qualified: 46, bookings: 7, attributedRevenuePence: 10_500_00, ...evidence('measured', 'test-ledger:cohort:2026-w32') }),
      Object.freeze({ cohortId: '2026-w33', label: 'W/C 17 Aug', leads: 146, qualified: 58, bookings: 7, attributedRevenuePence: 9_500_00, ...evidence('measured', 'test-ledger:cohort:2026-w33') }),
      Object.freeze({ cohortId: '2026-w34-plan', label: 'W/C 24 Aug · plan', leads: 160, qualified: 68, bookings: 10, attributedRevenuePence: 15_000_00, ...evidence('simulated', 'unused') }),
    ]),
    identity: Object.freeze({
      totalProfiles: 480,
      resolvedPeople: 436,
      unresolvedTouches: 31,
      duplicateCandidates: 12,
      ...evidence('measured', 'test-ledger:identity:resolution-04'),
    }),
    qualitySignals: Object.freeze([
      Object.freeze({ signalId: 'contact-resolution', label: 'Contact identity resolution', detail: 'Profiles attached to one stable TEST person identity.', scorePercent: 90.8, ...evidence('measured', 'test-ledger:quality:contact-resolution') }),
      Object.freeze({ signalId: 'affiliate-source', label: 'Affiliate source integrity', detail: 'Affiliate entry retains its exact source and immutable reference.', scorePercent: 88.4, ...evidence('measured', 'test-ledger:quality:affiliate-source') }),
      Object.freeze({ signalId: 'content-version', label: 'Content version attribution', detail: 'Influence events retain the exact approved content version.', scorePercent: 84.2, ...evidence('measured', 'test-ledger:quality:content-version') }),
      Object.freeze({ signalId: 'webinar-identity', label: 'Webinar identity match', detail: 'Registration, attendance and replay evidence resolve to one person.', scorePercent: 76.1, ...evidence('measured', 'test-ledger:quality:webinar-identity') }),
      Object.freeze({ signalId: 'consent-proof', label: 'Consent evidence coverage', detail: 'Addressable TEST profiles carry a current channel-purpose consent decision.', scorePercent: 94.5, ...evidence('measured', 'test-ledger:quality:consent-proof') }),
    ]),
  });
}
