import { TextDecoder } from 'node:util';
import type { IncomingHttpHeaders } from 'node:http';
import { MigrationCentreError } from '../legacy-import/migration-centre.js';
import type { CsvImportMapping } from '../legacy-import/csv-preview-types.js';
import type { PortalMigrationPreviewCommand } from './migration-centre-service.js';

export const MIGRATION_CSRF_HEADER = 'x-pp-migration-csrf' as const;
export const MIGRATION_MAPPING_HEADER = 'x-pp-migration-mapping' as const;
export const MIGRATION_SOURCE_SYSTEM_HEADER = 'x-pp-migration-source-system' as const;
export const MIGRATION_SOURCE_REFERENCE_HEADER = 'x-pp-migration-source-reference' as const;
export const MIGRATION_SOURCE_EXPORTED_AT_HEADER = 'x-pp-migration-source-exported-at' as const;
export const MIGRATION_IDEMPOTENCY_HEADER = 'idempotency-key' as const;

const MAPPING_BASE64URL = /^[A-Za-z0-9_-]{2,12000}$/u;
const MAX_MAPPING_BYTES = 8 * 1024;
const MAPPING_KEYS = new Set(['columns', 'affiliateSourceHeaders', 'requiredTargetFields']);

function oneHeader(headers: IncomingHttpHeaders, name: string): string | null {
  const value = headers[name];
  return typeof value === 'string' ? value : null;
}

function optionalHeader(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new MigrationCentreError('source_descriptor_invalid');
  return value;
}

function parseMapping(encoded: string | null): CsvImportMapping {
  if (!encoded || !MAPPING_BASE64URL.test(encoded) || encoded.length % 4 === 1) {
    throw new MigrationCentreError('mapping_invalid');
  }
  let bytes: Buffer;
  try {
    bytes = Buffer.from(encoded, 'base64url');
  } catch {
    throw new MigrationCentreError('mapping_invalid');
  }
  if (bytes.byteLength < 2 || bytes.byteLength > MAX_MAPPING_BYTES
      || bytes.toString('base64url') !== encoded) {
    throw new MigrationCentreError('mapping_invalid');
  }
  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new MigrationCentreError('mapping_invalid');
  }
  let mapping: unknown;
  try {
    mapping = JSON.parse(decoded);
  } catch {
    throw new MigrationCentreError('mapping_invalid');
  }
  if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)
      || Object.keys(mapping).some((key) => !MAPPING_KEYS.has(key))) {
    throw new MigrationCentreError('mapping_invalid');
  }
  return mapping as CsvImportMapping;
}

function declaredLength(headers: IncomingHttpHeaders): number | undefined {
  const value = headers['content-length'];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]{0,9})$/u.test(value)) {
    throw new MigrationCentreError('declared_length_invalid');
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new MigrationCentreError('declared_length_invalid');
  return parsed;
}

export function portalMigrationCsrfHeader(headers: IncomingHttpHeaders): string {
  return oneHeader(headers, MIGRATION_CSRF_HEADER) ?? '';
}

export function portalMigrationRequestIsSameOrigin(headers: IncomingHttpHeaders): boolean {
  const site = headers['sec-fetch-site'];
  return site === undefined || site === 'same-origin';
}

/** Parse bounded headers only. The request body remains untouched on failure. */
export function parsePortalMigrationPreviewCommand(
  headers: IncomingHttpHeaders,
  chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
): PortalMigrationPreviewCommand {
  const idempotencyKey = oneHeader(headers, MIGRATION_IDEMPOTENCY_HEADER);
  const sourceSystem = oneHeader(headers, MIGRATION_SOURCE_SYSTEM_HEADER);
  const contentType = oneHeader(headers, 'content-type');
  if (!idempotencyKey) throw new MigrationCentreError('idempotency_key_invalid');
  if (!sourceSystem) throw new MigrationCentreError('source_descriptor_invalid');
  if (!contentType) throw new MigrationCentreError('content_type_unsafe');
  const reference = optionalHeader(headers, MIGRATION_SOURCE_REFERENCE_HEADER);
  const exportedAt = optionalHeader(headers, MIGRATION_SOURCE_EXPORTED_AT_HEADER);
  const contentEncoding = optionalHeader(headers, 'content-encoding');
  const contentLength = declaredLength(headers);
  return Object.freeze({
    idempotencyKey,
    source: Object.freeze({
      system: sourceSystem,
      ...(reference === undefined ? {} : { reference }),
      ...(exportedAt === undefined ? {} : { exportedAt }),
    }),
    contentType,
    ...(contentEncoding === undefined ? {} : { contentEncoding }),
    ...(contentLength === undefined
      ? {}
      : { declaredContentLength: contentLength }),
    chunks,
    mapping: parseMapping(oneHeader(headers, MIGRATION_MAPPING_HEADER)),
  });
}
