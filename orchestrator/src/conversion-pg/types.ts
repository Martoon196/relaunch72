/**
 * Pure, storage-agnostic contracts for versioned conversion journeys.
 *
 * Definitions use only direct source facts. Consent, communication permission
 * and suppression remain separate eligibility concerns and can never become
 * lead-score points.
 */

export const CONVERSION_JOURNEY_SCHEMA_VERSION = 1 as const;

export type ConversionMappingMode = 'direct';
export type ConversionMappingFrequency = 'once_per_enrollment';
export type ConversionTriggerKind = 'event' | 'commerce';
export type ConversionMilestoneSemantic =
  | 'lead'
  | 'appointment'
  | 'presentation'
  | 'activation'
  | 'offer'
  | 'sale'
  | 'retention'
  | 'custom';

export interface ConversionMilestoneDefinition {
  readonly key: string;
  readonly name: string;
  readonly position: number;
  readonly semantic: ConversionMilestoneSemantic;
  readonly isCompletion: boolean;
}

export interface ConversionJourneyTriggerDefinition {
  readonly kind: ConversionTriggerKind;
  readonly sourceKey: string;
  readonly milestoneKey: string;
  readonly mode: ConversionMappingMode;
  readonly frequency: ConversionMappingFrequency;
}

export interface ConversionScoreComponentDefinition {
  readonly key: string;
  readonly name: string;
  readonly maxPoints: number;
}

export interface ConversionScoreBandDefinition {
  readonly key: string;
  readonly name: string;
  readonly minScore: number;
  readonly maxScore: number;
}

export interface ConversionScoreRuleDefinition {
  readonly key: string;
  readonly componentKey: string;
  readonly kind: ConversionTriggerKind;
  readonly sourceKey: string;
  readonly points: number;
  /** Human-readable explanation retained with each applied score reason. */
  readonly reason: string;
  readonly mode: ConversionMappingMode;
  readonly frequency: ConversionMappingFrequency;
}

export interface ConversionScoreModelDefinitionInput {
  readonly slug: string;
  readonly name: string;
  readonly version: number;
  readonly components: readonly ConversionScoreComponentDefinition[];
  readonly bands: readonly ConversionScoreBandDefinition[];
  readonly rules: readonly ConversionScoreRuleDefinition[];
}

export interface ConversionScoreModelDefinition extends ConversionScoreModelDefinitionInput {
  readonly schemaVersion: typeof CONVERSION_JOURNEY_SCHEMA_VERSION;
  /** Lowercase hexadecimal SHA-256 of the canonical score-model payload. */
  readonly definitionHash: string;
}

export interface ConversionJourneyDefinitionInput {
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  readonly version: number;
  readonly milestones: readonly ConversionMilestoneDefinition[];
  readonly triggers: readonly ConversionJourneyTriggerDefinition[];
  readonly scoreModel: ConversionScoreModelDefinitionInput;
}

export interface ConversionJourneyDefinition
  extends Omit<ConversionJourneyDefinitionInput, 'scoreModel'> {
  readonly schemaVersion: typeof CONVERSION_JOURNEY_SCHEMA_VERSION;
  readonly scoreModel: ConversionScoreModelDefinition;
  /** Lowercase hexadecimal SHA-256 of the canonical journey payload. */
  readonly definitionHash: string;
}
