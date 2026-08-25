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
 * Each publication keeps the manager-gated command boundary from migration
 * 0014. If the second transaction is interrupted the first remains a valid
 * published definition and an exact rerun safely completes the pair; runtime
 * readiness stays closed until both active versions exist.
 */
export async function installPropertyPredatorConversionBlueprints(
  service: Pick<ConversionCommandService, 'publishBlueprint'>,
  context: DatabaseRequestContext,
): Promise<PropertyPredatorBlueprintInstallResult> {
  if (!service || typeof service.publishBlueprint !== 'function') {
    throw new TypeError('service must provide publishBlueprint()');
  }
  const [selfServeBlueprint, agencyBlueprint] = PROPERTY_PREDATOR_CONVERSION_BLUEPRINTS;
  const selfServe = await service.publishBlueprint(context, selfServeBlueprint!);
  const agencyLaps = await service.publishBlueprint(context, agencyBlueprint!);
  return Object.freeze({ selfServe, agencyLaps });
}
