import {
  MigrationCentreBoundary,
  MigrationCentreError,
  type MigrationCentreErrorCode,
  type MigrationPreviewResult,
} from '../legacy-import/migration-centre.js';
import type {
  CsvImportMapping,
  CsvImportMappedEntity,
} from '../legacy-import/csv-preview-types.js';
import type { PortalCrmRequestIdentity } from './crm-service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const SAFE_WORKSPACE_NAME = /^[^\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]{1,120}$/u;

export const MIGRATION_CENTRE_ROUTE = '/portal/migrations' as const;
export const MIGRATION_CENTRE_PREVIEW_ROUTE = '/portal/migrations/preview' as const;
export const MIGRATION_CENTRE_CLIENT_ROUTE = '/portal/assets/migration-centre.js' as const;
export const MIGRATION_CENTRE_ADAPTER_ID = 'portal-legacy-csv-v1' as const;

/**
 * The portal intentionally starts smaller than the reusable import engine.
 * This keeps a browser response useful and bounded while the live executor is
 * still absent. A later durable import job may use a different reviewed limit.
 */
export const PORTAL_MIGRATION_PREVIEW_LIMITS = Object.freeze({
  maxBytes: 2 * 1024 * 1024,
  maxRows: 1_000,
  maxColumns: 100,
  maxCellBytes: 16 * 1024,
});

const RESPONSE_ROW_LIMIT = 25;
const RESPONSE_QUARANTINE_LIMIT = 100;
const RESPONSE_VALUE_CODEPOINT_LIMIT = 512;

export type PortalMigrationRole = 'founder' | 'admin';

/**
 * Produced only after resolving the opaque portal session against canonical
 * membership state. Browser claims never select a workspace, user or role.
 */
export interface PortalMigrationAccess {
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly actorId: string;
  readonly role: PortalMigrationRole;
  /** Hash of the exact upstream authentication/authorisation evidence. */
  readonly authenticationProofSha256: string;
}

export interface PortalMigrationAuthorizer {
  authorize(identity: PortalCrmRequestIdentity): Promise<PortalMigrationAccess | null>;
}

export interface PortalMigrationPreviewCommand {
  readonly idempotencyKey: string;
  readonly source: Readonly<{
    system: string;
    reference?: string;
    exportedAt?: string;
  }>;
  readonly contentType: string;
  readonly contentEncoding?: string;
  readonly declaredContentLength?: number;
  readonly chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array>;
  readonly mapping: CsvImportMapping;
}

export type PortalMigrationAccessOutcome =
  | Readonly<{ ok: true; workspaceName: string; role: PortalMigrationRole }>
  | Readonly<{ ok: false; kind: 'forbidden' | 'unavailable'; message: string }>;

export type PortalMigrationPreviewOutcome =
  | Readonly<{ ok: true; workspaceName: string; result: MigrationPreviewResult }>
  | Readonly<{
      ok: false;
      code: MigrationCentreErrorCode | 'forbidden';
      message: string;
      retryAfterSeconds: number | null;
    }>;

export interface PortalMigrationCentreService {
  access(identity: PortalCrmRequestIdentity): Promise<PortalMigrationAccessOutcome>;
  preview(
    identity: PortalCrmRequestIdentity,
    command: PortalMigrationPreviewCommand,
  ): Promise<PortalMigrationPreviewOutcome>;
}

export interface PortalMigrationCentreServiceOptions {
  readonly boundary: MigrationCentreBoundary;
  readonly authorizer: PortalMigrationAuthorizer;
}

function validatedAccess(value: PortalMigrationAccess | null): PortalMigrationAccess | null {
  if (!value) return null;
  if (!UUID.test(value.workspaceId) || !UUID.test(value.actorId)
      || (value.role !== 'founder' && value.role !== 'admin')
      || !SHA256.test(value.authenticationProofSha256)
      || !SAFE_WORKSPACE_NAME.test(value.workspaceName)
      || value.workspaceName.trim() !== value.workspaceName) {
    throw new MigrationCentreError('control_unavailable');
  }
  return Object.freeze({ ...value });
}

async function resolveAccess(
  authorizer: PortalMigrationAuthorizer,
  identity: PortalCrmRequestIdentity,
): Promise<PortalMigrationAccess | null> {
  try {
    return validatedAccess(await authorizer.authorize(identity));
  } catch (error) {
    if (error instanceof MigrationCentreError) throw error;
    throw new MigrationCentreError('control_unavailable');
  }
}

/**
 * Adapts the reviewed effects-free boundary to an opaque portal session. It
 * deliberately exposes preview only: no commit or customer repository exists.
 */
export function createPortalMigrationCentreService(
  options: PortalMigrationCentreServiceOptions,
): PortalMigrationCentreService {
  if (!options?.boundary || !options.authorizer) {
    throw new MigrationCentreError('control_unavailable');
  }
  return Object.freeze({
    async access(identity: PortalCrmRequestIdentity): Promise<PortalMigrationAccessOutcome> {
      try {
        const access = await resolveAccess(options.authorizer, identity);
        return access
          ? Object.freeze({ ok: true, workspaceName: access.workspaceName, role: access.role })
          : Object.freeze({
              ok: false,
              kind: 'forbidden',
              message: 'This account cannot use the Migration Centre.',
            });
      } catch {
        return Object.freeze({
          ok: false,
          kind: 'unavailable',
          message: 'The Migration Centre access check is temporarily unavailable.',
        });
      }
    },

    async preview(
      identity: PortalCrmRequestIdentity,
      command: PortalMigrationPreviewCommand,
    ): Promise<PortalMigrationPreviewOutcome> {
      try {
        const access = await resolveAccess(options.authorizer, identity);
        if (!access) {
          return Object.freeze({
            ok: false,
            code: 'forbidden',
            message: 'This account cannot preview legacy data.',
            retryAfterSeconds: null,
          });
        }
        const result = await options.boundary.previewPortal({
          workspaceId: access.workspaceId,
          actorId: access.actorId,
          role: access.role,
          authentication: 'portal_session',
          authenticationProofSha256: access.authenticationProofSha256,
        }, {
          idempotencyKey: command.idempotencyKey,
          adapterId: MIGRATION_CENTRE_ADAPTER_ID,
          source: command.source,
          contentType: command.contentType,
          ...(command.contentEncoding ? { contentEncoding: command.contentEncoding } : {}),
          ...(command.declaredContentLength === undefined
            ? {}
            : { declaredContentLength: command.declaredContentLength }),
          chunks: command.chunks,
          mapping: command.mapping,
          limits: PORTAL_MIGRATION_PREVIEW_LIMITS,
        });
        return Object.freeze({ ok: true, workspaceName: access.workspaceName, result });
      } catch (error) {
        const safe = error instanceof MigrationCentreError
          ? error
          : new MigrationCentreError('control_unavailable');
        return Object.freeze({
          ok: false,
          code: safe.code,
          message: safe.message,
          retryAfterSeconds: safe.retryAfterSeconds,
        });
      }
    },
  });
}

interface PortalMigrationResponseValue {
  readonly value: string;
  readonly truncated: boolean;
}

function boundedValue(value: string): PortalMigrationResponseValue {
  const codepoints = Array.from(value);
  if (codepoints.length <= RESPONSE_VALUE_CODEPOINT_LIMIT) {
    return Object.freeze({ value, truncated: false });
  }
  return Object.freeze({
    value: codepoints.slice(0, RESPONSE_VALUE_CODEPOINT_LIMIT).join(''),
    truncated: true,
  });
}

function boundedEntity(entity: CsvImportMappedEntity | null): Readonly<Record<string, PortalMigrationResponseValue>> | null {
  if (!entity) return null;
  return Object.freeze(Object.fromEntries(
    Object.entries(entity.fields).map(([field, value]) => [field, boundedValue(value)]),
  ));
}

/**
 * Only this bounded projection crosses the HTTP response. Full CSV bytes and
 * unsampled accepted rows remain request-local and never enter receipts/logs.
 */
export function presentPortalMigrationPreview(result: MigrationPreviewResult) {
  const preview = result.preview;
  const acceptedRows = preview.records.slice(0, RESPONSE_ROW_LIMIT).map((record) => Object.freeze({
    sourceRowNumber: record.provenance.sourceRowNumber,
    contact: boundedEntity(record.contact),
    lead: boundedEntity(record.lead),
    affiliateSources: Object.freeze(record.affiliateSources.map((entry) => Object.freeze({
      column: entry.column,
      ...boundedValue(entry.value),
    }))),
  }));
  const quarantineRows = preview.quarantinedRows
    .slice(0, RESPONSE_QUARANTINE_LIMIT)
    .map((row) => Object.freeze({
      sourceRowNumber: row.sourceRowNumber,
      reasons: row.reasons,
      unsafeColumnIndexes: row.unsafeColumnIndexes,
    }));
  return Object.freeze({
    ok: true as const,
    schemaVersion: 1 as const,
    disposition: result.disposition,
    summary: Object.freeze({
      acceptedRowCount: result.receipt.acceptedRowCount,
      quarantinedRowCount: result.receipt.quarantinedRowCount,
      affiliateSourceHeaderCount: result.receipt.affiliateSourceHeaderCount,
      affiliateValueCount: result.receipt.affiliateValueCount,
      returnedAcceptedRowCount: acceptedRows.length,
      omittedAcceptedRowCount: Math.max(0, result.receipt.acceptedRowCount - acceptedRows.length),
      returnedQuarantinedRowCount: quarantineRows.length,
      omittedQuarantinedRowCount: Math.max(
        0,
        result.receipt.quarantinedRowCount - quarantineRows.length,
      ),
      quarantineReasonCounts: preview.receipt.quarantineReasonCounts,
    }),
    acceptedRows: Object.freeze(acceptedRows),
    quarantinedRows: Object.freeze(quarantineRows),
    receipt: result.receipt,
    acquisition: result.acquisition,
    rateLimit: result.rateLimit,
    execution: Object.freeze({
      previewOnly: true as const,
      liveCustomerImport: false as const,
      commitAvailable: false as const,
    }),
  });
}
