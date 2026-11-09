import type { DatabaseRequestContext } from '../db/rls.js';
import {
  ConversionCommandService,
  type PublishConversionBlueprintResult,
} from './commands.js';
import { PROPERTY_PREDATOR_CONVERSION_BLUEPRINTS } from './property-predator-blueprints.js';

export interface PropertyPredatorBlueprintInstallResult {
  readonly selfServe: PublishConversionBlueprintResult;
  readonly agencyLaps: PublishConversionBlueprintResult;
}

/**
 * Installs or exactly replays the two immutable Property Predator definitions.
 *
 * The pair is published under one manager-gated transaction. A conflict in
 * either route rolls the complete foundation back, so a browser request cannot
 * leave a half-installed runtime.
 */
export async function installPropertyPredatorConversionBlueprints(
  service: Pick<ConversionCommandService, 'publishBlueprints'>,
  context: DatabaseRequestContext,
): Promise<PropertyPredatorBlueprintInstallResult> {
  if (!service || typeof service.publishBlueprints !== 'function') {
    throw new TypeError('service must provide publishBlueprints()');
  }
  const [selfServe, agencyLaps] = await service.publishBlueprints(
    context,
    PROPERTY_PREDATOR_CONVERSION_BLUEPRINTS,
  );
  if (!selfServe || !agencyLaps) {
    throw new TypeError('publishBlueprints() did not return both Property Predator routes');
  }
  return Object.freeze({ selfServe, agencyLaps });
}
