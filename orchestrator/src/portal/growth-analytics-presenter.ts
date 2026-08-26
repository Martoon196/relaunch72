/**
 * Pure, side-effect-free Growth Analytics & Attribution read model.
 *
 * `measured` means observed in the supplied evidence snapshot. It never means
 * live or production unless the enclosing dataset explicitly says so. A
 * measured row without a bounded evidence reference and a credible observation
 * instant fails closed to unavailable.
 */

export const GROWTH_ANALYTICS_ROUTE = '/portal/analytics' as const;
export const GROWTH_ANALYTICS_MAX_MILESTONES = 12;
export const GROWTH_ANALYTICS_MAX_CONTENT = 18;
export const GROWTH_ANALYTICS_MAX_SOURCES = 16;
export const GROWTH_ANALYTICS_MAX_WEBINARS = 8;
export const GROWTH_ANALYTICS_MAX_COHORTS = 12;
export const GROWTH_ANALYTICS_MAX_QUALITY_SIGNALS = 10;
export const GROWTH_ANALYTICS_MAX_TEXT = 180;

const MAX_COUNT = 10_000_000;
const MAX_REVENUE_PENCE = 1_000_000_000_00;

export type AnalyticsTruth = 'measured' | 'simulated' | 'unavailable';
export type AnalyticsDatasetKind = 'test_fixture' | 'connected_read_model';
export type AnalyticsConfidence = 'high' | 'medium' | 'low' | 'unknown';
export type AnalyticsAttributionModel = 'first_touch' | 'last_touch' | 'linear' | 'assisted';

export interface AnalyticsEvidenceSnapshot {
  readonly truth: AnalyticsTruth;
  readonly evidenceRef: string | null;
  readonly observedAt: string | null;
}

export interface AnalyticsFunnelMilestoneSnapshot extends AnalyticsEvidenceSnapshot {
  readonly milestoneId: string;
  readonly label: string;
  readonly operatorMeaning: string;
  readonly order: number;
  readonly people: number | null;
}

export interface AnalyticsContentAttributionSnapshot extends AnalyticsEvidenceSnapshot {
  readonly contentVersionId: string;
  readonly title: string;
  readonly format: string;
  readonly attributionModel: AnalyticsAttributionModel;
  readonly influencedPeople: number | null;
  readonly bookedConversions: number | null;
  readonly attributedRevenuePence: number | null;
}

export interface AnalyticsSourceAttributionSnapshot extends AnalyticsEvidenceSnapshot {
  readonly sourceId: string;
  readonly channelLabel: string;
  readonly sourceLabel: string;
  readonly affiliateLabel: string | null;
  readonly leads: number | null;
  readonly qualified: number | null;
  readonly bookings: number | null;
  readonly attributedRevenuePence: number | null;
  readonly identityConfidence: AnalyticsConfidence;
}

export interface AnalyticsWebinarContributionSnapshot extends AnalyticsEvidenceSnapshot {
  readonly webinarId: string;
  readonly title: string;
  readonly sessionLabel: string;
  readonly registrations: number | null;
  readonly attended: number | null;
  readonly replayConsumers: number | null;
  readonly bookings: number | null;
  readonly attributedRevenuePence: number | null;
}

export interface AnalyticsCohortSnapshot extends AnalyticsEvidenceSnapshot {
  readonly cohortId: string;
  readonly label: string;
  readonly leads: number | null;
  readonly qualified: number | null;
  readonly bookings: number | null;
  readonly attributedRevenuePence: number | null;
}

export interface AnalyticsQualitySignalSnapshot extends AnalyticsEvidenceSnapshot {
  readonly signalId: string;
  readonly label: string;
  readonly detail: string;
  readonly scorePercent: number | null;
}

export interface AnalyticsIdentitySnapshot extends AnalyticsEvidenceSnapshot {
  readonly totalProfiles: number | null;
  readonly resolvedPeople: number | null;
  readonly unresolvedTouches: number | null;
  readonly duplicateCandidates: number | null;
}

export interface GrowthAnalyticsSnapshot {
  readonly workspaceName: string;
  readonly asOf: string;
  readonly periodLabel: string;
  readonly currency: 'GBP';
  readonly environment: 'test' | 'live';
  readonly datasetKind: AnalyticsDatasetKind;
  readonly datasetLabel: string;
  readonly funnel: readonly AnalyticsFunnelMilestoneSnapshot[];
  readonly content: readonly AnalyticsContentAttributionSnapshot[];
  readonly sources: readonly AnalyticsSourceAttributionSnapshot[];
  readonly webinars: readonly AnalyticsWebinarContributionSnapshot[];
  readonly cohorts: readonly AnalyticsCohortSnapshot[];
  readonly identity: AnalyticsIdentitySnapshot;
  readonly qualitySignals: readonly AnalyticsQualitySignalSnapshot[];
}

export interface AnalyticsTruthView {
  readonly truth: AnalyticsTruth;
  readonly truthLabel: 'MEASURED' | 'SIMULATED' | 'UNAVAILABLE';
  readonly truthDetail: string;
  readonly truthValid: boolean;
  readonly evidenceRef: string | null;
  readonly observedAt: string | null;
}

export interface AnalyticsFunnelMilestoneView extends AnalyticsTruthView {
  readonly milestoneId: string;
  readonly label: string;
  readonly operatorMeaning: string;
  readonly order: number;
  readonly indexLabel: string;
  readonly people: number | null;
  readonly peopleLabel: string;
  readonly stepConversionPercent: number | null;
  readonly stepConversionLabel: string;
  readonly totalConversionPercent: number | null;
  readonly totalConversionLabel: string;
  readonly widthPercent: number;
  readonly coherent: boolean;
}

export interface AnalyticsContentAttributionView extends AnalyticsTruthView {
  readonly contentVersionId: string;
  readonly title: string;
  readonly format: string;
  readonly attributionModel: AnalyticsAttributionModel;
  readonly attributionModelLabel: string;
  readonly influencedPeople: number | null;
  readonly influencedPeopleLabel: string;
  readonly bookedConversions: number | null;
  readonly bookedConversionsLabel: string;
  readonly attributedRevenuePence: number | null;
  readonly revenueLabel: string;
  readonly revenueWidthPercent: number;
}

export interface AnalyticsSourceAttributionView extends AnalyticsTruthView {
  readonly sourceId: string;
  readonly channelLabel: string;
  readonly sourceLabel: string;
  readonly affiliateLabel: string | null;
  readonly leads: number | null;
  readonly leadsLabel: string;
  readonly qualified: number | null;
  readonly qualifiedLabel: string;
  readonly bookings: number | null;
  readonly bookingsLabel: string;
  readonly attributedRevenuePence: number | null;
  readonly revenueLabel: string;
  readonly identityConfidence: AnalyticsConfidence;
  readonly identityConfidenceLabel: string;
}

export interface AnalyticsWebinarContributionView extends AnalyticsTruthView {
  readonly webinarId: string;
  readonly title: string;
  readonly sessionLabel: string;
  readonly registrations: number | null;
  readonly registrationsLabel: string;
  readonly attended: number | null;
  readonly attendedLabel: string;
  readonly replayConsumers: number | null;
  readonly replayConsumersLabel: string;
  readonly bookings: number | null;
  readonly bookingsLabel: string;
  readonly attributedRevenuePence: number | null;
  readonly revenueLabel: string;
  readonly attendanceRateLabel: string;
}

export interface AnalyticsCohortView extends AnalyticsTruthView {
  readonly cohortId: string;
  readonly label: string;
  readonly leads: number | null;
  readonly leadsLabel: string;
  readonly qualified: number | null;
  readonly qualifiedLabel: string;
  readonly bookings: number | null;
  readonly bookingsLabel: string;
  readonly attributedRevenuePence: number | null;
  readonly revenueLabel: string;
  readonly conversionLabel: string;
  readonly widthPercent: number;
}

export interface AnalyticsQualitySignalView extends AnalyticsTruthView {
  readonly signalId: string;
  readonly label: string;
  readonly detail: string;
  readonly scorePercent: number | null;
  readonly scoreLabel: string;
  readonly tone: 'strong' | 'watch' | 'weak' | 'unknown';
}

export interface AnalyticsIdentityView extends AnalyticsTruthView {
  readonly totalProfiles: number | null;
  readonly totalProfilesLabel: string;
  readonly resolvedPeople: number | null;
  readonly resolvedPeopleLabel: string;
  readonly unresolvedTouches: number | null;
  readonly unresolvedTouchesLabel: string;
  readonly duplicateCandidates: number | null;
  readonly duplicateCandidatesLabel: string;
  readonly resolutionPercent: number | null;
  readonly resolutionLabel: string;
  readonly confidence: AnalyticsConfidence;
  readonly confidenceLabel: string;
}

export interface GrowthAnalyticsView {
  readonly workspaceName: string;
  readonly asOf: string;
  readonly periodLabel: string;
  readonly currency: 'GBP';
  readonly environment: 'test' | 'live';
  readonly environmentLabel: 'TEST' | 'LIVE';
  readonly datasetKind: AnalyticsDatasetKind;
  readonly datasetLabel: string;
  readonly datasetBoundary: string;
  readonly funnel: readonly AnalyticsFunnelMilestoneView[];
  readonly content: readonly AnalyticsContentAttributionView[];
  readonly sources: readonly AnalyticsSourceAttributionView[];
  readonly webinars: readonly AnalyticsWebinarContributionView[];
  readonly cohorts: readonly AnalyticsCohortView[];
  readonly identity: AnalyticsIdentityView;
  readonly qualitySignals: readonly AnalyticsQualitySignalView[];
  readonly headline: Readonly<{
    peopleLabel: string;
    bookingsLabel: string;
    revenueLabel: string;
    funnelConversionLabel: string;
  }>;
  readonly truthLedger: Readonly<{
    measured: number;
    simulated: number;
    unavailable: number;
    invalidMeasured: number;
  }>;
  readonly integrity: Readonly<{
    coherent: boolean;
    label: 'COHERENT' | 'CHECK REQUIRED';
    issueCount: number;
    detail: string;
  }>;
  readonly inputTruncated: boolean;
  readonly readOnly: true;
  readonly providerEffects: 'none';
}

const ATTRIBUTION_MODEL_LABELS: Readonly<Record<AnalyticsAttributionModel, string>> = Object.freeze({
  first_touch: 'First touch',
  last_touch: 'Last touch',
  linear: 'Linear',
  assisted: 'Assisted influence',
});

const CONFIDENCE_LABELS: Readonly<Record<AnalyticsConfidence, string>> = Object.freeze({
  high: 'High confidence',
  medium: 'Medium confidence',
  low: 'Low confidence',
  unknown: 'Unknown confidence',
});

function bounded(value: unknown, fallback = ''): string {
  if (typeof value !== 'string') return fallback;
  return [...value.trim()].slice(0, GROWTH_ANALYTICS_MAX_TEXT).join('') || fallback;
}

function instant(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.min(Math.round(value), MAX_COUNT)
    : null;
}

function pence(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.min(Math.round(value), MAX_REVENUE_PENCE)
    : null;
}

function percent(value: number | null, denominator: number | null): number | null {
  if (value === null || denominator === null || denominator <= 0 || value > denominator) return null;
  return Math.round((value / denominator) * 1_000) / 10;
}

function percentLabel(value: number | null): string {
  return value === null ? 'Unavailable' : `${value.toFixed(1)}%`;
}

function countLabel(value: number | null): string {
  return value === null ? 'Unavailable' : new Intl.NumberFormat('en-GB').format(value);
}

function moneyLabel(value: number | null): string {
  return value === null
    ? 'Unavailable'
    : new Intl.NumberFormat('en-GB', {
      style: 'currency',
      currency: 'GBP',
      maximumFractionDigits: value % 100 === 0 ? 0 : 2,
    }).format(value / 100);
}

function evidenceView(
  evidence: AnalyticsEvidenceSnapshot,
  asOfMs: number,
  datasetKind: AnalyticsDatasetKind,
): AnalyticsTruthView {
  const evidenceRef = evidence.evidenceRef === null ? null : bounded(evidence.evidenceRef);
  const observedAt = instant(evidence.observedAt);
  const observedMs = observedAt === null ? Number.NaN : Date.parse(observedAt);
  const measuredValid = evidence.truth !== 'measured'
    || Boolean(evidenceRef && Number.isFinite(observedMs) && observedMs <= asOfMs);
  const truth: AnalyticsTruth = measuredValid ? evidence.truth : 'unavailable';
  const truthLabel = truth === 'measured' ? 'MEASURED' : truth === 'simulated' ? 'SIMULATED' : 'UNAVAILABLE';
  const truthDetail = truth === 'measured'
    ? datasetKind === 'test_fixture'
      ? 'Observed in the bounded TEST evidence ledger; not a live production claim.'
      : 'Observed in the connected bounded read model with an evidence reference.'
    : truth === 'simulated'
      ? 'A planning or rehearsal assumption; never reported as observed performance.'
      : measuredValid
        ? 'No dependable evidence is available for this row.'
        : 'Supplied as measured without valid evidence; failed closed to unavailable.';
  return Object.freeze({ truth, truthLabel, truthDetail, truthValid: measuredValid, evidenceRef, observedAt });
}

function visibleNumber<T extends number | null>(value: T, truth: AnalyticsTruth): T | null {
  return truth === 'unavailable' ? null : value;
}

function confidenceFromPercent(value: number | null): AnalyticsConfidence {
  if (value === null) return 'unknown';
  if (value >= 90) return 'high';
  if (value >= 70) return 'medium';
  return 'low';
}

function presentFunnel(
  source: readonly AnalyticsFunnelMilestoneSnapshot[],
  asOfMs: number,
  datasetKind: AnalyticsDatasetKind,
): readonly AnalyticsFunnelMilestoneView[] {
  const ordered = [...source]
    .slice(0, GROWTH_ANALYTICS_MAX_MILESTONES)
    .sort((a, b) => a.order - b.order);
  const firstRaw = ordered[0];
  const firstEvidence = firstRaw ? evidenceView(firstRaw, asOfMs, datasetKind) : null;
  const firstPeople = firstRaw && firstEvidence ? visibleNumber(count(firstRaw.people), firstEvidence.truth) : null;
  let previous: number | null = null;
  return Object.freeze(ordered.map((row, index) => {
    const evidence = evidenceView(row, asOfMs, datasetKind);
    const people = visibleNumber(count(row.people), evidence.truth);
    const coherent = previous === null || people === null || people <= previous;
    const step = index === 0 ? 100 : coherent ? percent(people, previous) : null;
    const total = percent(people, firstPeople);
    const widthPercent = firstPeople && people !== null
      ? Math.max(3, Math.min(100, (people / firstPeople) * 100))
      : 0;
    previous = people;
    return Object.freeze({
      ...evidence,
      milestoneId: bounded(row.milestoneId, `milestone-${index + 1}`),
      label: bounded(row.label, `Milestone ${index + 1}`),
      operatorMeaning: bounded(row.operatorMeaning, 'No operator definition supplied.'),
      order: Number.isFinite(row.order) ? Math.max(0, Math.round(row.order)) : index + 1,
      indexLabel: String(index + 1).padStart(2, '0'),
      people,
      peopleLabel: countLabel(people),
      stepConversionPercent: step,
      stepConversionLabel: percentLabel(step),
      totalConversionPercent: total,
      totalConversionLabel: percentLabel(total),
      widthPercent,
      coherent,
    });
  }));
}

function presentContent(
  source: readonly AnalyticsContentAttributionSnapshot[],
  asOfMs: number,
  datasetKind: AnalyticsDatasetKind,
): readonly AnalyticsContentAttributionView[] {
  const rows = source.slice(0, GROWTH_ANALYTICS_MAX_CONTENT).map((row, index) => {
    const evidence = evidenceView(row, asOfMs, datasetKind);
    const influencedPeople = visibleNumber(count(row.influencedPeople), evidence.truth);
    const bookedConversions = visibleNumber(count(row.bookedConversions), evidence.truth);
    const attributedRevenuePence = visibleNumber(pence(row.attributedRevenuePence), evidence.truth);
    return {
      ...evidence,
      contentVersionId: bounded(row.contentVersionId, `content-version-${index + 1}`),
      title: bounded(row.title, `Content version ${index + 1}`),
      format: bounded(row.format, 'Content'),
      attributionModel: row.attributionModel,
      attributionModelLabel: ATTRIBUTION_MODEL_LABELS[row.attributionModel],
      influencedPeople,
      influencedPeopleLabel: countLabel(influencedPeople),
      bookedConversions,
      bookedConversionsLabel: countLabel(bookedConversions),
      attributedRevenuePence,
      revenueLabel: moneyLabel(attributedRevenuePence),
    };
  });
  const maxRevenue = Math.max(0, ...rows.map((row) => row.attributedRevenuePence ?? 0));
  return Object.freeze(rows.map((row) => Object.freeze({
    ...row,
    revenueWidthPercent: maxRevenue > 0 && row.attributedRevenuePence !== null
      ? Math.max(4, (row.attributedRevenuePence / maxRevenue) * 100)
      : 0,
  })));
}

function presentSources(
  source: readonly AnalyticsSourceAttributionSnapshot[],
  asOfMs: number,
  datasetKind: AnalyticsDatasetKind,
): readonly AnalyticsSourceAttributionView[] {
  return Object.freeze(source.slice(0, GROWTH_ANALYTICS_MAX_SOURCES).map((row, index) => {
    const evidence = evidenceView(row, asOfMs, datasetKind);
    const leads = visibleNumber(count(row.leads), evidence.truth);
    const qualified = visibleNumber(count(row.qualified), evidence.truth);
    const bookings = visibleNumber(count(row.bookings), evidence.truth);
    const revenue = visibleNumber(pence(row.attributedRevenuePence), evidence.truth);
    return Object.freeze({
      ...evidence,
      sourceId: bounded(row.sourceId, `source-${index + 1}`),
      channelLabel: bounded(row.channelLabel, 'Unknown channel'),
      sourceLabel: bounded(row.sourceLabel, 'Unknown source'),
      affiliateLabel: row.affiliateLabel === null ? null : bounded(row.affiliateLabel, 'Unlabelled affiliate'),
      leads,
      leadsLabel: countLabel(leads),
      qualified,
      qualifiedLabel: countLabel(qualified),
      bookings,
      bookingsLabel: countLabel(bookings),
      attributedRevenuePence: revenue,
      revenueLabel: moneyLabel(revenue),
      identityConfidence: row.identityConfidence,
      identityConfidenceLabel: CONFIDENCE_LABELS[row.identityConfidence],
    });
  }));
}

function presentWebinars(
  source: readonly AnalyticsWebinarContributionSnapshot[],
  asOfMs: number,
  datasetKind: AnalyticsDatasetKind,
): readonly AnalyticsWebinarContributionView[] {
  return Object.freeze(source.slice(0, GROWTH_ANALYTICS_MAX_WEBINARS).map((row, index) => {
    const evidence = evidenceView(row, asOfMs, datasetKind);
    const registrations = visibleNumber(count(row.registrations), evidence.truth);
    const attended = visibleNumber(count(row.attended), evidence.truth);
    const replayConsumers = visibleNumber(count(row.replayConsumers), evidence.truth);
    const bookings = visibleNumber(count(row.bookings), evidence.truth);
    const revenue = visibleNumber(pence(row.attributedRevenuePence), evidence.truth);
    return Object.freeze({
      ...evidence,
      webinarId: bounded(row.webinarId, `webinar-${index + 1}`),
      title: bounded(row.title, `Webinar ${index + 1}`),
      sessionLabel: bounded(row.sessionLabel, 'Session not scheduled'),
      registrations,
      registrationsLabel: countLabel(registrations),
      attended,
      attendedLabel: countLabel(attended),
      replayConsumers,
      replayConsumersLabel: countLabel(replayConsumers),
      bookings,
      bookingsLabel: countLabel(bookings),
      attributedRevenuePence: revenue,
      revenueLabel: moneyLabel(revenue),
      attendanceRateLabel: percentLabel(percent(attended, registrations)),
    });
  }));
}

function presentCohorts(
  source: readonly AnalyticsCohortSnapshot[],
  asOfMs: number,
  datasetKind: AnalyticsDatasetKind,
): readonly AnalyticsCohortView[] {
  const rows = source.slice(0, GROWTH_ANALYTICS_MAX_COHORTS).map((row, index) => {
    const evidence = evidenceView(row, asOfMs, datasetKind);
    const leads = visibleNumber(count(row.leads), evidence.truth);
    const qualified = visibleNumber(count(row.qualified), evidence.truth);
    const bookings = visibleNumber(count(row.bookings), evidence.truth);
    const revenue = visibleNumber(pence(row.attributedRevenuePence), evidence.truth);
    return {
      ...evidence,
      cohortId: bounded(row.cohortId, `cohort-${index + 1}`),
      label: bounded(row.label, `Cohort ${index + 1}`),
      leads,
      leadsLabel: countLabel(leads),
      qualified,
      qualifiedLabel: countLabel(qualified),
      bookings,
      bookingsLabel: countLabel(bookings),
      attributedRevenuePence: revenue,
      revenueLabel: moneyLabel(revenue),
      conversionLabel: percentLabel(percent(bookings, leads)),
    };
  });
  const maxBookings = Math.max(0, ...rows.map((row) => row.bookings ?? 0));
  return Object.freeze(rows.map((row) => Object.freeze({
    ...row,
    widthPercent: maxBookings > 0 && row.bookings !== null ? Math.max(6, (row.bookings / maxBookings) * 100) : 0,
  })));
}

function presentQuality(
  source: readonly AnalyticsQualitySignalSnapshot[],
  asOfMs: number,
  datasetKind: AnalyticsDatasetKind,
): readonly AnalyticsQualitySignalView[] {
  return Object.freeze(source.slice(0, GROWTH_ANALYTICS_MAX_QUALITY_SIGNALS).map((row, index) => {
    const evidence = evidenceView(row, asOfMs, datasetKind);
    const raw = typeof row.scorePercent === 'number' && Number.isFinite(row.scorePercent)
      ? Math.max(0, Math.min(100, Math.round(row.scorePercent * 10) / 10))
      : null;
    const scorePercent = visibleNumber(raw, evidence.truth);
    const tone = scorePercent === null ? 'unknown' : scorePercent >= 90 ? 'strong' : scorePercent >= 70 ? 'watch' : 'weak';
    return Object.freeze({
      ...evidence,
      signalId: bounded(row.signalId, `quality-${index + 1}`),
      label: bounded(row.label, `Quality signal ${index + 1}`),
      detail: bounded(row.detail, 'No quality definition supplied.'),
      scorePercent,
      scoreLabel: percentLabel(scorePercent),
      tone,
    });
  }));
}

function presentIdentity(
  source: AnalyticsIdentitySnapshot,
  asOfMs: number,
  datasetKind: AnalyticsDatasetKind,
): AnalyticsIdentityView {
  const evidence = evidenceView(source, asOfMs, datasetKind);
  const totalProfiles = visibleNumber(count(source.totalProfiles), evidence.truth);
  const resolvedPeople = visibleNumber(count(source.resolvedPeople), evidence.truth);
  const unresolvedTouches = visibleNumber(count(source.unresolvedTouches), evidence.truth);
  const duplicateCandidates = visibleNumber(count(source.duplicateCandidates), evidence.truth);
  const resolutionPercent = percent(resolvedPeople, totalProfiles);
  const confidence = confidenceFromPercent(resolutionPercent);
  return Object.freeze({
    ...evidence,
    totalProfiles,
    totalProfilesLabel: countLabel(totalProfiles),
    resolvedPeople,
    resolvedPeopleLabel: countLabel(resolvedPeople),
    unresolvedTouches,
    unresolvedTouchesLabel: countLabel(unresolvedTouches),
    duplicateCandidates,
    duplicateCandidatesLabel: countLabel(duplicateCandidates),
    resolutionPercent,
    resolutionLabel: percentLabel(resolutionPercent),
    confidence,
    confidenceLabel: CONFIDENCE_LABELS[confidence],
  });
}

function allTruthRows(view: Pick<GrowthAnalyticsView, 'funnel' | 'content' | 'sources' | 'webinars' | 'cohorts' | 'identity' | 'qualitySignals'>): readonly AnalyticsTruthView[] {
  return [...view.funnel, ...view.content, ...view.sources, ...view.webinars, ...view.cohorts, view.identity, ...view.qualitySignals];
}

export function presentGrowthAnalytics(snapshot: GrowthAnalyticsSnapshot): GrowthAnalyticsView {
  const asOf = instant(snapshot.asOf) ?? new Date(0).toISOString();
  const asOfMs = Date.parse(asOf);
  const funnel = presentFunnel(snapshot.funnel, asOfMs, snapshot.datasetKind);
  const content = presentContent(snapshot.content, asOfMs, snapshot.datasetKind);
  const sources = presentSources(snapshot.sources, asOfMs, snapshot.datasetKind);
  const webinars = presentWebinars(snapshot.webinars, asOfMs, snapshot.datasetKind);
  const cohorts = presentCohorts(snapshot.cohorts, asOfMs, snapshot.datasetKind);
  const identity = presentIdentity(snapshot.identity, asOfMs, snapshot.datasetKind);
  const qualitySignals = presentQuality(snapshot.qualitySignals, asOfMs, snapshot.datasetKind);
  const inputTruncated = snapshot.funnel.length > GROWTH_ANALYTICS_MAX_MILESTONES
    || snapshot.content.length > GROWTH_ANALYTICS_MAX_CONTENT
    || snapshot.sources.length > GROWTH_ANALYTICS_MAX_SOURCES
    || snapshot.webinars.length > GROWTH_ANALYTICS_MAX_WEBINARS
    || snapshot.cohorts.length > GROWTH_ANALYTICS_MAX_COHORTS
    || snapshot.qualitySignals.length > GROWTH_ANALYTICS_MAX_QUALITY_SIGNALS;
  const provisional = { funnel, content, sources, webinars, cohorts, identity, qualitySignals };
  const truthRows = allTruthRows(provisional);
  const invalidMeasured = truthRows.filter((row) => !row.truthValid).length;
  const funnelIssues = funnel.filter((row) => !row.coherent).length;
  const impossibleSources = sources.filter((row) => (
    row.leads !== null && row.qualified !== null && row.qualified > row.leads
  ) || (
    row.qualified !== null && row.bookings !== null && row.bookings > row.qualified
  )).length;
  const impossibleWebinars = webinars.filter((row) => (
    row.registrations !== null && row.attended !== null && row.attended > row.registrations
  )).length;
  const issueCount = funnelIssues + impossibleSources + impossibleWebinars + invalidMeasured + (inputTruncated ? 1 : 0);
  const first = funnel[0];
  const last = funnel[funnel.length - 1];
  const measuredRevenue = sources
    .filter((row) => row.truth === 'measured')
    .reduce((sum, row) => sum + (row.attributedRevenuePence ?? 0), 0);
  const measuredBookings = sources
    .filter((row) => row.truth === 'measured')
    .reduce((sum, row) => sum + (row.bookings ?? 0), 0);
  const datasetBoundary = snapshot.datasetKind === 'test_fixture'
    ? 'Illustrative TEST evidence only. MEASURED means observed inside this bounded fixture; it is not production performance.'
    : snapshot.environment === 'live'
      ? 'Connected read model. MEASURED rows require a bounded evidence reference and observation time.'
      : 'Connected TEST read model. MEASURED rows are observed test evidence, not production performance.';
  return Object.freeze({
    workspaceName: bounded(snapshot.workspaceName, 'Growth HQ'),
    asOf,
    periodLabel: bounded(snapshot.periodLabel, 'Reporting period unavailable'),
    currency: 'GBP',
    environment: snapshot.environment,
    environmentLabel: snapshot.environment === 'live' ? 'LIVE' : 'TEST',
    datasetKind: snapshot.datasetKind,
    datasetLabel: bounded(snapshot.datasetLabel, 'Analytics evidence snapshot'),
    datasetBoundary,
    funnel,
    content,
    sources,
    webinars,
    cohorts,
    identity,
    qualitySignals,
    headline: Object.freeze({
      peopleLabel: first?.peopleLabel ?? 'Unavailable',
      bookingsLabel: countLabel(measuredBookings),
      revenueLabel: moneyLabel(measuredRevenue),
      funnelConversionLabel: first && last ? percentLabel(percent(last.people, first.people)) : 'Unavailable',
    }),
    truthLedger: Object.freeze({
      measured: truthRows.filter((row) => row.truth === 'measured').length,
      simulated: truthRows.filter((row) => row.truth === 'simulated').length,
      unavailable: truthRows.filter((row) => row.truth === 'unavailable').length,
      invalidMeasured,
    }),
    integrity: Object.freeze({
      coherent: issueCount === 0,
      label: issueCount === 0 ? 'COHERENT' : 'CHECK REQUIRED',
      issueCount,
      detail: issueCount === 0
        ? 'The bounded snapshot passes monotonic funnel, source, webinar and evidence checks.'
        : `${issueCount} evidence or sequence check${issueCount === 1 ? '' : 's'} need operator review; affected claims fail closed where possible.`,
    }),
    inputTruncated,
    readOnly: true,
    providerEffects: 'none',
  });
}
