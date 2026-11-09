export type GrowthDataState = 'live' | 'empty' | 'preview';
export type GrowthTrack = 'self_serve' | 'agency';
export type GrowthScoreBand = 'burning' | 'hot' | 'warm' | 'quiet' | 'unscored';
export type GrowthEvidenceKind =
  | 'watched'
  | 'listened'
  | 'read'
  | 'downloaded'
  | 'offer_shown'
  | 'reply'
  | 'appointment'
  | 'product'
  | 'commerce';

export interface GrowthFunnelStageView {
  readonly key: string;
  readonly label: string;
  readonly count: number;
  /** Percentage of the previous stage that reached this stage. Null at Lead. */
  readonly stepConversionPercent: number | null;
  readonly movedInWindow: number;
}

export interface GrowthFunnelView {
  readonly track: GrowthTrack;
  readonly label: string;
  readonly description: string;
  readonly stages: readonly GrowthFunnelStageView[];
}

export interface GrowthEvidenceView {
  readonly kind: GrowthEvidenceKind;
  readonly label: string;
  readonly detail: string;
  readonly occurredAt: string;
}

export interface GrowthLeadView {
  readonly contactId: string;
  readonly displayName: string;
  readonly companyName: string | null;
  readonly track: GrowthTrack;
  readonly stage: string;
  readonly score: number | null;
  readonly band: GrowthScoreBand;
  readonly lastEvidence: GrowthEvidenceView | null;
  readonly contentSummary: string | null;
  readonly offerSummary: string | null;
  readonly nextMove: string;
}

export interface GrowthEvidenceTotalsView {
  readonly contentStarted: number;
  readonly contentCompleted: number;
  readonly offersShown: number;
  readonly replies: number;
  readonly appointments: number;
}

export interface GrowthIntelligenceView {
  readonly dataState: GrowthDataState;
  readonly asOf: string;
  readonly windowLabel: string;
  readonly funnels: readonly GrowthFunnelView[];
  readonly hotLeads: readonly GrowthLeadView[];
  readonly evidenceTotals: GrowthEvidenceTotalsView;
}

export function emptyGrowthIntelligence(asOf: string): GrowthIntelligenceView {
  return Object.freeze({
    dataState: 'empty',
    asOf,
    windowLabel: 'All recorded time',
    funnels: Object.freeze([
      Object.freeze({
        track: 'self_serve',
        label: 'Self-serve conversion',
        description: 'Captured identity to first weapon, priced intent and paid sale.',
        stages: Object.freeze([
          Object.freeze({ key: 'lead', label: 'Lead', count: 0, stepConversionPercent: null, movedInWindow: 0 }),
          Object.freeze({ key: 'activated', label: 'Activated', count: 0, stepConversionPercent: null, movedInWindow: 0 }),
          Object.freeze({ key: 'priced', label: 'Priced', count: 0, stepConversionPercent: null, movedInWindow: 0 }),
          Object.freeze({ key: 'sale', label: 'Sale', count: 0, stepConversionPercent: null, movedInWindow: 0 }),
        ]),
      }),
      Object.freeze({
        track: 'agency',
        label: 'Agency LAPS',
        description: 'Named agency lead to appointment, presentation and collected sale.',
        stages: Object.freeze([
          Object.freeze({ key: 'lead', label: 'Lead', count: 0, stepConversionPercent: null, movedInWindow: 0 }),
          Object.freeze({ key: 'appointment', label: 'Appointment', count: 0, stepConversionPercent: null, movedInWindow: 0 }),
          Object.freeze({ key: 'presentation', label: 'Presentation', count: 0, stepConversionPercent: null, movedInWindow: 0 }),
          Object.freeze({ key: 'sale', label: 'Sale', count: 0, stepConversionPercent: null, movedInWindow: 0 }),
        ]),
      }),
    ]),
    hotLeads: Object.freeze([]),
    evidenceTotals: Object.freeze({
      contentStarted: 0,
      contentCompleted: 0,
      offersShown: 0,
      replies: 0,
      appointments: 0,
    }),
  });
}
