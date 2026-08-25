import { defineConversionJourney } from './definition.js';
import type {
  ConversionJourneyTriggerDefinition,
  ConversionScoreModelDefinitionInput,
} from './types.js';

const SCORE_BANDS = [
  { key: 'quiet', name: 'Quiet', minScore: 0, maxScore: 21 },
  { key: 'warm', name: 'Warm', minScore: 22, maxScore: 44 },
  { key: 'hot', name: 'Hot', minScore: 45, maxScore: 69 },
  { key: 'burning', name: 'Burning', minScore: 70, maxScore: 100 },
] as const;

const SCORE_MODEL: ConversionScoreModelDefinitionInput = {
  slug: 'property-predator-lead-score',
  name: 'Property Predator lead score',
  version: 1,
  components: [
    { key: 'fit', name: 'Fit', maxPoints: 30 },
    { key: 'engagement', name: 'Engagement', maxPoints: 35 },
    { key: 'intent', name: 'Intent', maxPoints: 35 },
  ],
  bands: SCORE_BANDS,
  // V1 scores only facts in the currently accepted bridge catalogue. Fit and
  // intent remain unallocated until explicit, evidence-backed signals exist;
  // pricing/checkout placeholders are not treated as if they are live facts.
  rules: [
    {
      key: 'account-created', componentKey: 'engagement',
      kind: 'event',
      sourceKey: 'identity.account.created', points: 5,
      reason: 'Created a Property Predator account.',
      mode: 'direct', frequency: 'once_per_enrollment',
    },
    {
      key: 'analysis-completed', componentKey: 'engagement',
      kind: 'event',
      sourceKey: 'product.analysis.completed', points: 30,
      reason: 'Completed a Property Predator analysis.',
      mode: 'direct', frequency: 'once_per_enrollment',
    },
  ],
};

const event = (sourceKey: string, milestoneKey: string): ConversionJourneyTriggerDefinition => ({
  kind: 'event', sourceKey, milestoneKey,
  mode: 'direct', frequency: 'once_per_enrollment',
});

const paymentCollected = (milestoneKey: string): ConversionJourneyTriggerDefinition => ({
  kind: 'commerce', sourceKey: 'payment_collected', milestoneKey,
  mode: 'direct', frequency: 'once_per_enrollment',
});

export const PROPERTY_PREDATOR_SELF_SERVE_JOURNEY = defineConversionJourney({
  slug: 'property-predator-self-serve',
  name: 'Property Predator self-serve conversion',
  description: 'Product-led conversion from an identified account through meaningful product activation and offer exposure to an authoritative paid sale.',
  version: 1,
  milestones: [
    { key: 'lead', name: 'Lead', position: 1, semantic: 'lead', isCompletion: false },
    { key: 'activated', name: 'Activated', position: 2, semantic: 'activation', isCompletion: false },
    { key: 'priced', name: 'Priced', position: 3, semantic: 'offer', isCompletion: false },
    { key: 'sale', name: 'Sale', position: 4, semantic: 'sale', isCompletion: true },
  ],
  triggers: [
    event('identity.account.created', 'lead'),
    event('product.analysis.completed', 'activated'),
    // Priced is intentionally unmapped in V1: pricing and checkout source
    // events are reserved, not accepted facts in the current PP bridge.
    paymentCollected('sale'),
  ],
  scoreModel: SCORE_MODEL,
});

export const PROPERTY_PREDATOR_AGENCY_LAPS_JOURNEY = defineConversionJourney({
  slug: 'property-predator-agency-laps',
  name: 'Property Predator agency LAPS',
  description: 'Sales-assisted Lead, Appointment, Presentation and Sale journey for agency and organisation opportunities.',
  version: 1,
  milestones: [
    { key: 'lead', name: 'Lead', position: 1, semantic: 'lead', isCompletion: false },
    { key: 'appointment', name: 'Appointment', position: 2, semantic: 'appointment', isCompletion: false },
    { key: 'presentation', name: 'Presentation', position: 3, semantic: 'presentation', isCompletion: false },
    { key: 'sale', name: 'Sale', position: 4, semantic: 'sale', isCompletion: true },
  ],
  triggers: [
    event('identity.account.created', 'lead'),
    // Appointment and Presentation wait for explicit calendar/attendance facts.
    paymentCollected('sale'),
  ],
  scoreModel: SCORE_MODEL,
});

export const PROPERTY_PREDATOR_CONVERSION_BLUEPRINTS = Object.freeze([
  PROPERTY_PREDATOR_SELF_SERVE_JOURNEY,
  PROPERTY_PREDATOR_AGENCY_LAPS_JOURNEY,
]);
