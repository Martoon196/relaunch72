import type { DatabaseRequestContext } from '../db/rls.js';
import { validateDatabaseContext } from '../db/rls.js';
import { PgPropertyPredatorOwnedSeedCampaignRepository } from './repository.js';
import {
  PropertyPredatorOwnedSeedCampaignValidationError,
  type PropertyPredatorOwnedSeedCampaignRepository,
  type PropertyPredatorOwnedSeedCampaignServiceDependencies,
  type StagePropertyPredatorOwnedSeedCampaignCommand,
  type StagePropertyPredatorOwnedSeedCampaignResult,
} from './types.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COMMAND_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function normalizeCommand(
  command: StagePropertyPredatorOwnedSeedCampaignCommand,
): StagePropertyPredatorOwnedSeedCampaignCommand {
  if (!command || typeof command !== 'object') {
    throw new PropertyPredatorOwnedSeedCampaignValidationError(
      'Owned-seed campaign command is required',
    );
  }
  if (!UUID.test(command.messageVersionId)) {
    throw new PropertyPredatorOwnedSeedCampaignValidationError(
      'Owned-seed campaign messageVersionId must be a UUID',
    );
  }
  if (!UUID.test(command.runId)) {
    throw new PropertyPredatorOwnedSeedCampaignValidationError(
      'Owned-seed campaign runId must be a UUID',
    );
  }
  if (typeof command.commandKey !== 'string'
      || !COMMAND_KEY.test(command.commandKey)) {
    throw new PropertyPredatorOwnedSeedCampaignValidationError(
      'Owned-seed campaign commandKey is invalid',
    );
  }
  return Object.freeze({ ...command });
}

export class PropertyPredatorOwnedSeedCampaignService {
  readonly #repository: PropertyPredatorOwnedSeedCampaignRepository;
  readonly #workspaceId: string;

  constructor(dependencies: PropertyPredatorOwnedSeedCampaignServiceDependencies) {
    if (!UUID.test(dependencies.workspaceId)) {
      throw new PropertyPredatorOwnedSeedCampaignValidationError(
        'Owned-seed campaign workspaceId must be a UUID',
      );
    }
    this.#workspaceId = dependencies.workspaceId;
    this.#repository = new PgPropertyPredatorOwnedSeedCampaignRepository({
      commandPool: dependencies.commandPool,
      workspaceId: dependencies.workspaceId,
    });
  }

  async stage(
    context: DatabaseRequestContext,
    command: StagePropertyPredatorOwnedSeedCampaignCommand,
  ): Promise<StagePropertyPredatorOwnedSeedCampaignResult> {
    validateDatabaseContext(context);
    if (context.actorKind !== 'user' || !context.userId) {
      throw new PropertyPredatorOwnedSeedCampaignValidationError(
        'Owned-seed campaign staging requires an authenticated user context',
      );
    }
    if (context.workspaceId !== this.#workspaceId) {
      throw new PropertyPredatorOwnedSeedCampaignValidationError(
        'Owned-seed campaign context is outside the configured workspace',
      );
    }
    return this.#repository.stage(context, normalizeCommand(command));
  }

  async assertReady(): Promise<void> {
    return this.#repository.assertReady();
  }
}

export function createPropertyPredatorOwnedSeedCampaignService(
  dependencies: PropertyPredatorOwnedSeedCampaignServiceDependencies,
): PropertyPredatorOwnedSeedCampaignService {
  return new PropertyPredatorOwnedSeedCampaignService(dependencies);
}
