import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import {
  ConversionBlueprintActivationConflictError,
  ConversionBlueprintIntegrityError,
  ConversionBlueprintVersionConflictError,
  ConversionCommandService,
  InvalidConversionCommandContextError,
} from '../conversion-pg/commands.js';
import {
  createPgJourneyManagerReadService,
  type JourneyManagerReadService,
  type JourneyManagerReadSnapshot,
} from '../conversion-pg/journey-manager.js';
import { installPropertyPredatorConversionBlueprints } from '../conversion-pg/property-predator-bootstrap.js';
import { createPgConversionTransactionRunner } from '../conversion-pg/repository.js';
import { requestDatabaseContext, type DatabaseRequestContext } from '../db/rls.js';
import { InactivePortalSessionError } from '../db/transaction.js';
import {
  createPgPortalCrmPrincipalResolver,
  type PortalCrmPrincipal,
  type PortalCrmPrincipalResolver,
} from './crm-pg-service.js';

export interface PortalJourneyManagerRequestIdentity {
  readonly sessionToken: string;
  readonly requestId: string;
}

export type PortalJourneyManagerInstallOutcome =
  | {
      readonly ok: true;
      readonly disposition: 'applied' | 'replayed';
      readonly routes: Readonly<{
        selfServe: 'applied' | 'replayed';
        agencyLaps: 'applied' | 'replayed';
      }>;
    }
  | {
      readonly ok: false;
      readonly kind: 'forbidden' | 'conflict' | 'unavailable';
      readonly message: string;
    };

export interface PortalJourneyManagerService {
  snapshot(identity: PortalJourneyManagerRequestIdentity): Promise<JourneyManagerReadSnapshot | null>;
  /**
   * Publishes only the reviewed immutable route and score definitions.
   * The command never sends a message, calls a provider or advances a lead.
   */
  installFoundation(identity: PortalJourneyManagerRequestIdentity): Promise<PortalJourneyManagerInstallOutcome>;
}

export interface PgPortalJourneyManagerDependencies {
  readonly principalResolver: Pick<PortalCrmPrincipalResolver, 'resolve'>;
  readonly readService: Pick<JourneyManagerReadService, 'load'>;
  readonly commandService: Pick<ConversionCommandService, 'publishBlueprints'>;
}

function databaseContext(
  identity: PortalJourneyManagerRequestIdentity,
  principal: PortalCrmPrincipal,
): DatabaseRequestContext {
  return requestDatabaseContext({
    ...principal,
    requestId: identity.requestId,
    portalSessionTokenHash: createHash('sha256').update(identity.sessionToken).digest(),
  });
}

function postgresCode(error: unknown): string | null {
  return typeof error === 'object' && error !== null && 'code' in error
    && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : null;
}

function installFailure(error: unknown): PortalJourneyManagerInstallOutcome {
  if (error instanceof InactivePortalSessionError
      || error instanceof InvalidConversionCommandContextError
      || postgresCode(error) === '42501') {
    return Object.freeze({
      ok: false,
      kind: 'forbidden',
      message: 'Only an active workspace owner or admin can install the journey foundation.',
    });
  }
  if (error instanceof ConversionBlueprintVersionConflictError
      || error instanceof ConversionBlueprintActivationConflictError
      || error instanceof ConversionBlueprintIntegrityError) {
    return Object.freeze({
      ok: false,
      kind: 'conflict',
      message: 'The stored journey definitions do not match the reviewed Property Predator foundation. No outbound action was triggered.',
    });
  }
  return Object.freeze({
    ok: false,
    kind: 'unavailable',
    message: 'The journey foundation could not be installed safely. No message or provider action was triggered.',
  });
}

export class PgPortalJourneyManagerService implements PortalJourneyManagerService {
  constructor(private readonly dependencies: PgPortalJourneyManagerDependencies) {}

  private async context(identity: PortalJourneyManagerRequestIdentity): Promise<DatabaseRequestContext | null> {
    const principal = await this.dependencies.principalResolver.resolve(identity.sessionToken);
    return principal ? databaseContext(identity, principal) : null;
  }

  async snapshot(identity: PortalJourneyManagerRequestIdentity): Promise<JourneyManagerReadSnapshot | null> {
    const context = await this.context(identity);
    if (!context) return null;
    try {
      return await this.dependencies.readService.load(context);
    } catch (error) {
      if (error instanceof InactivePortalSessionError) return null;
      throw error;
    }
  }

  async installFoundation(
    identity: PortalJourneyManagerRequestIdentity,
  ): Promise<PortalJourneyManagerInstallOutcome> {
    try {
      const context = await this.context(identity);
      if (!context) return installFailure(new InactivePortalSessionError());

      // This read gives the browser an immediate, truthful permission result.
      // The command transaction re-locks the session and RLS re-checks the
      // owner/admin membership, so a role change between these calls is safe.
      const current = await this.dependencies.readService.load(context);
      if (!current.canManage) {
        return Object.freeze({
          ok: false,
          kind: 'forbidden',
          message: 'Only a workspace owner or admin can install the journey foundation.',
        });
      }
      if (current.routes.some((route) => route.publication === 'conflict')
          || current.scoreModel.publication === 'conflict') {
        return Object.freeze({
          ok: false,
          kind: 'conflict',
          message: 'The stored journey definitions conflict with the reviewed Property Predator foundation. Nothing was changed.',
        });
      }

      const result = await installPropertyPredatorConversionBlueprints(
        this.dependencies.commandService,
        context,
      );
      const routes = Object.freeze({
        selfServe: result.selfServe.disposition,
        agencyLaps: result.agencyLaps.disposition,
      });
      return Object.freeze({
        ok: true,
        disposition: routes.selfServe === 'replayed' && routes.agencyLaps === 'replayed'
          ? 'replayed'
          : 'applied',
        routes,
      });
    } catch (error) {
      return installFailure(error);
    }
  }
}

export function createPgPortalJourneyManagerService(input: {
  readonly webPool: Pool;
  readonly commandPool: Pool;
}): PgPortalJourneyManagerService {
  return new PgPortalJourneyManagerService({
    principalResolver: createPgPortalCrmPrincipalResolver(input.webPool),
    readService: createPgJourneyManagerReadService(input.webPool),
    commandService: new ConversionCommandService({
      transactionRunner: createPgConversionTransactionRunner(input.commandPool),
    }),
  });
}
