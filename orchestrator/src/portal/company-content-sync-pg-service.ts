import { createHash } from 'node:crypto';
import type { Pool, QueryResultRow } from 'pg';
import { BrandBrainService, createBrandBrainTransactionRunner } from '../brand-brain-pg/index.js';
import { CompanyAssetService, createCompanyAssetTransactionRunner } from '../company-asset-pg/index.js';
import { createPropertyPredatorCompanyAssetBridgeTransport } from '../company-asset-release/index.js';
import {
  PropertyPredatorCompanyContentAdapter,
  createPropertyPredatorHttpCatalogTransport,
} from '../company-content-adapter/property-predator.js';
import { createPropertyPredatorApprovedResourceTransport } from '../company-content-adapter/property-predator-resources.js';
import { CompanyContentService, createCompanyContentTransactionRunner } from '../company-content-pg/index.js';
import {
  PropertyPredatorContentSyncCoordinator,
  type PropertyPredatorContentSyncStatus,
} from '../company-content-sync/index.js';
import { requestDatabaseContext, type DatabaseRequestContext } from '../db/rls.js';
import { InactivePortalSessionError } from '../db/transaction.js';
import {
  PgPortalCompanyAssetsWorkspaceAccessReader,
  type PortalCompanyAssetsWorkspaceAccessReader,
} from './company-assets-pg-service.js';
import type {
  PortalCompanyContentSyncFailure,
  PortalCompanyContentSyncOutcome,
  PortalCompanyContentSyncRequestIdentity,
  PortalCompanyContentSyncService,
  PortalCompanyContentSyncWorkspaceAccess,
} from './company-content-sync-service.js';
import {
  createPgPortalCrmPrincipalResolver,
  type PortalCrmPrincipal,
  type PortalCrmPrincipalResolver,
} from './crm-pg-service.js';

const EXACT_PRODUCTION_SOURCE_ORIGIN = 'https://propertypredator.com';
const LOCAL_SOURCE_ORIGIN = /^http:\/\/(?:127\.0\.0\.1|localhost)(?::[1-9][0-9]{0,4})?$/u;

export interface PropertyPredatorContentSyncSourceConfig {
  readonly sourceOrigin: string;
  readonly sourceClientId: string;
  readonly sourceReadToken: string;
  readonly sourceTimeoutMs: number;
  readonly allowLocalHttp: boolean;
}

function boundedInteger(
  raw: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  if (!/^(?:0|[1-9][0-9]{0,8})$/u.test(raw.trim())) {
    throw new Error(`${label} must be a bounded integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

/**
 * Returns undefined only when the entire optional source boundary is absent.
 * A partial or permissive configuration fails startup rather than silently
 * mounting an operator button that cannot prove its source.
 */
export function loadPropertyPredatorContentSyncSourceConfig(
  env: NodeJS.ProcessEnv,
): PropertyPredatorContentSyncSourceConfig | undefined {
  const requiredNames = [
    'PROPERTY_PREDATOR_COMPANY_CONTENT_ORIGIN',
    'PROPERTY_PREDATOR_COMPANY_CONTENT_CLIENT_ID',
    'PROPERTY_PREDATOR_COMPANY_CONTENT_READ_TOKEN',
  ] as const;
  const anyNames = [
    ...requiredNames,
    'PROPERTY_PREDATOR_COMPANY_CONTENT_TIMEOUT_MS',
    'PROPERTY_PREDATOR_COMPANY_CONTENT_ALLOW_LOCAL_HTTP',
  ] as const;
  const anyPresent = anyNames.some((name) => Boolean(env[name]?.trim()));
  if (!anyPresent) return undefined;
  const requiredPresent = requiredNames.filter((name) => Boolean(env[name]?.trim()));
  if (requiredPresent.length !== requiredNames.length) {
    throw new Error('Property Predator company-content source configuration is incomplete');
  }
  const allowLocalHttp = env.PROPERTY_PREDATOR_COMPANY_CONTENT_ALLOW_LOCAL_HTTP === 'true';
  if (allowLocalHttp && env.NODE_ENV?.trim().toLowerCase() === 'production') {
    throw new Error('Local HTTP company-content source is forbidden in production');
  }
  const sourceOrigin = env.PROPERTY_PREDATOR_COMPANY_CONTENT_ORIGIN!.trim();
  if (sourceOrigin !== EXACT_PRODUCTION_SOURCE_ORIGIN
      && !(allowLocalHttp && LOCAL_SOURCE_ORIGIN.test(sourceOrigin))) {
    throw new Error('Company-content source must be the exact propertypredator.com origin');
  }
  const sourceClientId = env.PROPERTY_PREDATOR_COMPANY_CONTENT_CLIENT_ID!.trim();
  const sourceReadToken = env.PROPERTY_PREDATOR_COMPANY_CONTENT_READ_TOKEN!.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/u.test(sourceClientId)
      || Buffer.byteLength(sourceReadToken, 'utf8') < 32
      || Buffer.byteLength(sourceReadToken, 'utf8') > 512
      || /[^\x21-\x7e]/u.test(sourceReadToken)) {
    throw new Error('Property Predator company-content source credentials are invalid');
  }
  return Object.freeze({
    sourceOrigin,
    sourceClientId,
    sourceReadToken,
    sourceTimeoutMs: boundedInteger(
      env.PROPERTY_PREDATOR_COMPANY_CONTENT_TIMEOUT_MS,
      8_000,
      100,
      10_000,
      'PROPERTY_PREDATOR_COMPANY_CONTENT_TIMEOUT_MS',
    ),
    allowLocalHttp,
  });
}

interface ContentSyncCoordinator {
  snapshot(context: DatabaseRequestContext): PropertyPredatorContentSyncStatus;
  sync(context: DatabaseRequestContext): Promise<PropertyPredatorContentSyncStatus>;
}

export interface PgPortalCompanyContentSyncDependencies {
  readonly principalResolver: Pick<PortalCrmPrincipalResolver, 'resolve'>;
  readonly accessReader: PortalCompanyAssetsWorkspaceAccessReader;
  readonly coordinator: ContentSyncCoordinator;
  readonly syncLock: PortalCompanyContentSyncLock;
}

export type PortalCompanyContentSyncLockOutcome<T> =
  | Readonly<{ acquired: true; value: T }>
  | Readonly<{ acquired: false }>;

export interface PortalCompanyContentSyncLock {
  run<T>(
    workspaceId: string,
    operation: () => Promise<T>,
  ): Promise<PortalCompanyContentSyncLockOutcome<T>>;
}

interface AdvisoryLockRow extends QueryResultRow {
  readonly acquired: unknown;
}

const BEGIN_LOCK_TRANSACTION_SQL = '/* portal.company-content-sync.lock-begin */ BEGIN';
const TRY_WORKSPACE_LOCK_SQL = `/* portal.company-content-sync.workspace-lock */
  SELECT pg_try_advisory_xact_lock(
    hashtextextended('relaunch72:company-content-sync:' || $1::uuid::text, 0)
  ) AS acquired`;
const RELEASE_LOCK_TRANSACTION_SQL = '/* portal.company-content-sync.lock-release */ ROLLBACK';

/**
 * A transaction-scoped advisory lock stays pinned even behind a transaction
 * pooler. The reserved web connection performs no data read or write; it only
 * serialises one effects-off sync per exact workspace while adapter-role
 * transactions do the actual RLS-scoped work.
 */
export class PgPortalCompanyContentSyncLock implements PortalCompanyContentSyncLock {
  constructor(private readonly pool: Pool) {}

  async run<T>(
    workspaceId: string,
    operation: () => Promise<T>,
  ): Promise<PortalCompanyContentSyncLockOutcome<T>> {
    const client = await this.pool.connect();
    let transactionOpen = false;
    let destroyConnection = false;
    try {
      await client.query(BEGIN_LOCK_TRANSACTION_SQL);
      transactionOpen = true;
      const lock = await client.query<AdvisoryLockRow>(TRY_WORKSPACE_LOCK_SQL, [workspaceId]);
      if (lock.rows.length !== 1 || typeof lock.rows[0]?.acquired !== 'boolean') {
        destroyConnection = true;
        throw new Error('Company-content sync workspace lock returned invalid evidence');
      }
      if (lock.rows[0].acquired !== true) return Object.freeze({ acquired: false as const });
      return Object.freeze({ acquired: true as const, value: await operation() });
    } catch (error) {
      if (!transactionOpen) destroyConnection = true;
      throw error;
    } finally {
      if (transactionOpen) {
        try {
          await client.query(RELEASE_LOCK_TRANSACTION_SQL);
          transactionOpen = false;
        } catch {
          // Destroying the pinned connection terminates its transaction and
          // therefore releases the advisory lock even when ROLLBACK fails.
          destroyConnection = true;
        }
      }
      client.release(destroyConnection);
    }
  }
}

function databaseContext(
  identity: PortalCompanyContentSyncRequestIdentity,
  principal: PortalCrmPrincipal,
): DatabaseRequestContext {
  return requestDatabaseContext({
    ...principal,
    requestId: identity.requestId,
    portalSessionTokenHash: createHash('sha256').update(identity.sessionToken).digest(),
  });
}

function failure(
  kind: PortalCompanyContentSyncFailure['kind'],
  message: string,
): PortalCompanyContentSyncFailure {
  return Object.freeze({ ok: false, kind, message });
}

function outcome(
  workspace: PortalCompanyContentSyncWorkspaceAccess,
  sync: PropertyPredatorContentSyncStatus,
): PortalCompanyContentSyncOutcome {
  if (sync.workspaceId !== workspace.workspaceId || sync.providerEffects !== false
      || sync.customerPrivateDataAccepted !== false || sync.affiliateContentAccepted !== false
      || sync.artworkBytesCopied !== false) {
    return failure('unavailable', 'The company-content sync did not pass its effects-off boundary.');
  }
  return Object.freeze({
    ok: true,
    snapshot: Object.freeze({
      workspace,
      sync,
      dataset: 'postgres_authoritative' as const,
      providerEffects: false as const,
    }),
  });
}

export class PgPortalCompanyContentSyncService implements PortalCompanyContentSyncService {
  constructor(private readonly dependencies: PgPortalCompanyContentSyncDependencies) {}

  private async authorized(
    identity: PortalCompanyContentSyncRequestIdentity,
  ): Promise<Readonly<{ context: DatabaseRequestContext; workspace: PortalCompanyContentSyncWorkspaceAccess }>
      | PortalCompanyContentSyncFailure> {
    const principal = await this.dependencies.principalResolver.resolve(identity.sessionToken);
    if (!principal) return failure('unauthenticated', 'This portal session is no longer active.');
    const context = databaseContext(identity, principal);
    const workspace = await this.dependencies.accessReader.load(context);
    if (!workspace || !workspace.canManage) {
      return failure('forbidden', 'Founder or workspace-admin access is required for source sync.');
    }
    return Object.freeze({ context, workspace });
  }

  private readFailure(error: unknown): PortalCompanyContentSyncFailure {
    if (error instanceof InactivePortalSessionError) {
      return failure('unauthenticated', 'This portal session is no longer active.');
    }
    return failure('unavailable', 'The company-owned source sync is temporarily unavailable.');
  }

  async snapshot(
    identity: PortalCompanyContentSyncRequestIdentity,
  ): Promise<PortalCompanyContentSyncOutcome> {
    try {
      const authorization = await this.authorized(identity);
      if ('ok' in authorization) return authorization;
      return outcome(
        authorization.workspace,
        this.dependencies.coordinator.snapshot(authorization.context),
      );
    } catch (error) {
      return this.readFailure(error);
    }
  }

  async sync(
    identity: PortalCompanyContentSyncRequestIdentity,
  ): Promise<PortalCompanyContentSyncOutcome> {
    try {
      const authorization = await this.authorized(identity);
      if ('ok' in authorization) return authorization;
      const locked = await this.dependencies.syncLock.run(
        authorization.context.workspaceId,
        () => this.dependencies.coordinator.sync(authorization.context),
      );
      if (!locked.acquired) {
        return failure(
          'conflict',
          'Another protected source sync is already running for this workspace.',
        );
      }
      return outcome(authorization.workspace, locked.value);
    } catch (error) {
      return this.readFailure(error);
    }
  }
}

/**
 * Production role split: web resolves the active operator, while every source
 * metadata/body write uses only r72_content_adapter. Source transports are
 * authenticated read-only clients and expose no effect operation.
 */
export function createPgPortalCompanyContentSyncService(input: {
  readonly webPool: Pool;
  readonly adapterPool: Pool;
  readonly source: PropertyPredatorContentSyncSourceConfig;
}): PgPortalCompanyContentSyncService {
  const sourceOptions = Object.freeze({
    baseUrl: input.source.sourceOrigin,
    clientId: input.source.sourceClientId,
    readToken: input.source.sourceReadToken,
    timeoutMs: input.source.sourceTimeoutMs,
    allowLocalHttp: input.source.allowLocalHttp,
  });
  const adapterAssetRunner = createCompanyAssetTransactionRunner(input.adapterPool);
  return new PgPortalCompanyContentSyncService({
    principalResolver: createPgPortalCrmPrincipalResolver(input.webPool),
    accessReader: new PgPortalCompanyAssetsWorkspaceAccessReader(
      createCompanyAssetTransactionRunner(input.webPool),
    ),
    syncLock: new PgPortalCompanyContentSyncLock(input.webPool),
    coordinator: new PropertyPredatorContentSyncCoordinator({
      bridge: createPropertyPredatorCompanyAssetBridgeTransport(sourceOptions),
      catalog: new PropertyPredatorCompanyContentAdapter(
        createPropertyPredatorHttpCatalogTransport(sourceOptions),
      ),
      resources: createPropertyPredatorApprovedResourceTransport(sourceOptions),
      content: new CompanyContentService({
        transactionRunner: createCompanyContentTransactionRunner(input.adapterPool),
      }),
      assets: new CompanyAssetService({ transactionRunner: adapterAssetRunner }),
      brandBrain: new BrandBrainService({
        transactionRunner: createBrandBrainTransactionRunner(input.adapterPool),
      }),
    }),
  });
}
