import { createHash } from 'node:crypto';
import {
  LegacyImportValidationError,
  type LegacyImportValidationIssue,
  type LegacyLeadAttributionInput,
  type LegacyLeadBatchInput,
  type LegacyLeadIdentityInput,
  type LegacyLeadRowInput,
  type LegacyUnresolvedAttributionInput,
  type NormalizedLegacyLeadAttribution,
  type NormalizedLegacyLeadBatch,
  type NormalizedLegacyLeadIdentity,
  type NormalizedLegacyLeadRow,
  type NormalizedLegacyUnresolvedAttribution,
} from './types.js';

const SOURCE_SYSTEM = /^[a-z][a-z0-9_.:/-]{0,99}$/;
const BATCH_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const QUARANTINE_REASON = /^[a-z][a-z0-9_.:-]{0,99}$/;

function stableJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('non-finite numbers are not valid JSON');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => (
      `${JSON.stringify(key)}:${stableJson(record[key])}`
    )).join(',')}}`;
  }
  throw new TypeError(`${typeof value} is not valid JSON`);
}

function hash(json: string): Uint8Array {
  return createHash('sha256').update(json, 'utf8').digest();
}

function text(
  value: unknown,
  path: string,
  max: number,
  issues: LegacyImportValidationIssue[],
  required: true,
): string;
function text(
  value: unknown,
  path: string,
  max: number,
  issues: LegacyImportValidationIssue[],
  required: false,
): string | null;
function text(
  value: unknown,
  path: string,
  max: number,
  issues: LegacyImportValidationIssue[],
  required: boolean,
): string | null {
  if (value == null) {
    if (required) issues.push({ path, message: 'is required' });
    return required ? '' : null;
  }
  if (typeof value !== 'string') {
    issues.push({ path, message: 'must be text' });
    return required ? '' : null;
  }
  const candidate = value.trim();
  if (!candidate) {
    if (required) issues.push({ path, message: 'is required' });
    return required ? '' : null;
  }
  if (candidate.length > max) issues.push({ path, message: `must be at most ${max} characters` });
  if (CONTROL.test(candidate)) issues.push({ path, message: 'must not contain control characters' });
  return candidate;
}

function timestamp(
  value: unknown,
  path: string,
  now: Date,
  issues: LegacyImportValidationIssue[],
): string {
  const candidate = text(value, path, 50, issues, true);
  const components = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/.exec(candidate);
  if (!components) {
    issues.push({ path, message: 'must be an RFC3339 timestamp with an explicit timezone' });
    return '';
  }
  const year = Number(components[1]);
  const month = Number(components[2]);
  const day = Number(components[3]);
  const hour = Number(components[4]);
  const minute = Number(components[5]);
  const second = Number(components[6]);
  const offset = components[8]!;
  const calendar = new Date(0);
  calendar.setUTCFullYear(year, month - 1, day);
  calendar.setUTCHours(hour, minute, second, 0);
  const invalidOffset = offset !== 'Z'
    && (Number(offset.slice(1, 3)) > 23 || Number(offset.slice(4, 6)) > 59);
  if (year < 1 || month < 1 || month > 12 || day < 1
      || hour > 23 || minute > 59 || second > 59 || invalidOffset
      || calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1
      || calendar.getUTCDate() !== day || calendar.getUTCHours() !== hour
      || calendar.getUTCMinutes() !== minute || calendar.getUTCSeconds() !== second) {
    issues.push({ path, message: 'must be a real calendar timestamp' });
    return '';
  }
  const parsed = new Date(candidate);
  if (!Number.isFinite(parsed.getTime())) {
    issues.push({ path, message: 'must be a real calendar timestamp' });
    return '';
  }
  if (parsed.getTime() > now.getTime()) issues.push({ path, message: 'must not be in the future' });
  return parsed.toISOString();
}

function normalizeIdentity(
  input: LegacyLeadIdentityInput,
  path: string,
  issues: LegacyImportValidationIssue[],
): NormalizedLegacyLeadIdentity {
  if (!input || typeof input !== 'object') {
    issues.push({ path, message: 'must be an object' });
    return { kind: 'email', value: '', normalizedValue: '', verified: false, label: null, primary: false };
  }
  const value = text(input.value, `${path}.value`, 320, issues, true);
  let normalizedValue = '';
  if (input.kind === 'email') {
    normalizedValue = value.toLowerCase();
    if (!EMAIL.test(normalizedValue)) issues.push({ path: `${path}.value`, message: 'must be a valid email address' });
  } else if (input.kind === 'phone') {
    let number = value.replace(/[\s().-]/g, '');
    if (number.startsWith('00')) number = `+${number.slice(2)}`;
    if (!/^\+\d{7,15}$/.test(number)) {
      issues.push({ path: `${path}.value`, message: 'must be an E.164 phone number including country code' });
    }
    normalizedValue = number;
  } else {
    issues.push({ path: `${path}.kind`, message: 'must be email or phone' });
  }
  if (typeof input.verified !== 'boolean') {
    issues.push({ path: `${path}.verified`, message: 'must be true or false' });
  }
  if (input.primary !== undefined && typeof input.primary !== 'boolean') {
    issues.push({ path: `${path}.primary`, message: 'must be true or false' });
  }
  return {
    kind: input.kind === 'phone' ? 'phone' : 'email',
    value,
    normalizedValue,
    verified: input.verified === true,
    label: text(input.label, `${path}.label`, 50, issues, false),
    primary: input.primary === true,
  };
}

function normalizeAttribution(
  input: LegacyLeadAttributionInput,
  path: string,
  originalCreatedAt: string,
  now: Date,
  issues: LegacyImportValidationIssue[],
): NormalizedLegacyLeadAttribution {
  if (!input || typeof input !== 'object') {
    issues.push({ path, message: 'must be an object' });
  }
  const raw = input?.raw;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).length === 0) {
    issues.push({ path: `${path}.raw`, message: 'must be a non-empty JSON object' });
  }
  try {
    const bytes = Buffer.byteLength(stableJson(raw ?? {}), 'utf8');
    if (bytes > 262_144) issues.push({ path: `${path}.raw`, message: 'must be at most 256 KiB' });
  } catch {
    issues.push({ path: `${path}.raw`, message: 'must contain JSON-safe values only' });
  }
  const attributedAt = input?.attributedAt == null
    ? originalCreatedAt
    : timestamp(input.attributedAt, `${path}.attributedAt`, now, issues);
  return {
    affiliateSourceId: text(input?.affiliateSourceId, `${path}.affiliateSourceId`, 300, issues, false),
    affiliateName: text(input?.affiliateName, `${path}.affiliateName`, 300, issues, false),
    affiliateCode: text(input?.affiliateCode, `${path}.affiliateCode`, 300, issues, false),
    referralCode: text(input?.referralCode, `${path}.referralCode`, 300, issues, false),
    utmSource: text(input?.utmSource, `${path}.utmSource`, 300, issues, false),
    utmMedium: text(input?.utmMedium, `${path}.utmMedium`, 300, issues, false),
    utmCampaign: text(input?.utmCampaign, `${path}.utmCampaign`, 500, issues, false),
    utmTerm: text(input?.utmTerm, `${path}.utmTerm`, 500, issues, false),
    utmContent: text(input?.utmContent, `${path}.utmContent`, 500, issues, false),
    referrerUrl: text(input?.referrerUrl, `${path}.referrerUrl`, 2048, issues, false),
    landingUrl: text(input?.landingUrl, `${path}.landingUrl`, 2048, issues, false),
    attributedAt,
    raw: (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {},
  };
}

function normalizeUnresolvedAttribution(
  input: LegacyUnresolvedAttributionInput,
  path: string,
  now: Date,
  issues: LegacyImportValidationIssue[],
): NormalizedLegacyUnresolvedAttribution {
  const kinds = new Set(['affiliate', 'referral', 'commission', 'attribution']);
  const reasons = new Set([
    'missing_contact', 'missing_affiliate_owner', 'broken_reference',
    'source_integrity_conflict',
  ]);
  if (!input || typeof input !== 'object') issues.push({ path, message: 'must be an object' });
  if (!kinds.has(input?.recordKind)) {
    issues.push({ path: `${path}.recordKind`, message: 'must be affiliate, referral, commission or attribution' });
  }
  if (!reasons.has(input?.reason)) {
    issues.push({ path: `${path}.reason`, message: 'must be a supported quarantine reason' });
  }
  const raw = input?.raw;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).length === 0) {
    issues.push({ path: `${path}.raw`, message: 'must be a non-empty JSON object' });
  }
  const normalized = {
    recordKind: kinds.has(input?.recordKind) ? input.recordKind : 'attribution' as const,
    sourceRecordId: text(input?.sourceRecordId, `${path}.sourceRecordId`, 300, issues, true),
    referredSourceRecordId: text(input?.referredSourceRecordId, `${path}.referredSourceRecordId`, 300, issues, false),
    originalCreatedAt: timestamp(input?.originalCreatedAt, `${path}.originalCreatedAt`, now, issues),
    reason: reasons.has(input?.reason) ? input.reason : 'source_integrity_conflict' as const,
    affiliateSourceId: text(input?.affiliateSourceId, `${path}.affiliateSourceId`, 300, issues, false),
    affiliateCode: text(input?.affiliateCode, `${path}.affiliateCode`, 300, issues, false),
    referralCode: text(input?.referralCode, `${path}.referralCode`, 300, issues, false),
    raw: (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {},
  };
  let payloadJson = '';
  try {
    payloadJson = stableJson(normalized);
    if (Buffer.byteLength(payloadJson, 'utf8') > 524_288) {
      issues.push({ path, message: 'canonical unresolved record must be at most 512 KiB' });
    }
  } catch {
    issues.push({ path, message: 'must contain JSON-safe values only' });
  }
  return { ...normalized, payloadJson, payloadHash: hash(payloadJson) };
}

export function normalizeLegacyLeadBatch(
  input: LegacyLeadBatchInput,
  now = new Date(),
): NormalizedLegacyLeadBatch {
  const issues: LegacyImportValidationIssue[] = [];
  if (!input || typeof input !== 'object') {
    throw new LegacyImportValidationError([{ path: '$', message: 'must be an object' }]);
  }
  if (input.schemaVersion !== 1) {
    issues.push({ path: 'schemaVersion', message: 'must equal 1' });
  }
  const sourceSystem = text(input.sourceSystem, 'sourceSystem', 100, issues, true).toLowerCase();
  if (!SOURCE_SYSTEM.test(sourceSystem)) {
    issues.push({ path: 'sourceSystem', message: 'must use lowercase letters, numbers, dot, underscore, slash, colon or hyphen' });
  }
  const batchKey = text(input.batchKey, 'batchKey', 128, issues, true);
  if (!BATCH_KEY.test(batchKey)) {
    issues.push({ path: 'batchKey', message: 'must use letters, numbers, dot, underscore, colon or hyphen' });
  }
  const unresolvedInput = input.unresolvedAttributions ?? [];
  if (!Array.isArray(input.rows) || !Array.isArray(unresolvedInput)
      || input.rows.length + unresolvedInput.length < 1
      || input.rows.length + unresolvedInput.length > 10_000) {
    issues.push({ path: '$', message: 'rows plus unresolvedAttributions must contain between 1 and 10000 records' });
  }
  const sourceIds = new Set<string>();
  const rows: NormalizedLegacyLeadRow[] = [];
  const inputRows: readonly LegacyLeadRowInput[] = Array.isArray(input.rows) ? input.rows : [];
  for (const [index, row] of inputRows.entries()) {
    const path = `rows[${index}]`;
    if (!row || typeof row !== 'object') {
      issues.push({ path, message: 'must be an object' });
      continue;
    }
    const sourceRecordId = text(row.sourceRecordId, `${path}.sourceRecordId`, 300, issues, true);
    if (sourceIds.has(sourceRecordId)) {
      issues.push({ path: `${path}.sourceRecordId`, message: 'must be unique within the batch' });
    }
    sourceIds.add(sourceRecordId);
    const originalCreatedAt = timestamp(row.originalCreatedAt, `${path}.originalCreatedAt`, now, issues);
    if (!Array.isArray(row.identities) || row.identities.length < 1 || row.identities.length > 20) {
      issues.push({ path: `${path}.identities`, message: 'must contain between 1 and 20 entries' });
    }
    const identityInputs: readonly LegacyLeadIdentityInput[] = Array.isArray(row.identities)
      ? row.identities
      : [];
    const identities = identityInputs
      .map((identity, identityIndex) => normalizeIdentity(identity, `${path}.identities[${identityIndex}]`, issues));
    const keys = new Set<string>();
    const primaryKinds = new Set<string>();
    for (const identity of identities) {
      const key = `${identity.kind}\u0000${identity.normalizedValue}`;
      if (keys.has(key)) issues.push({ path: `${path}.identities`, message: 'must not contain duplicate identities' });
      keys.add(key);
      if (identity.primary && primaryKinds.has(identity.kind)) {
        issues.push({ path: `${path}.identities`, message: `must not contain more than one primary ${identity.kind}` });
      }
      if (identity.primary) primaryKinds.add(identity.kind);
    }
    const sourceQuarantineReasons: string[] = [];
    if (row.sourceQuarantineReasons !== undefined) {
      if (!Array.isArray(row.sourceQuarantineReasons)
          || row.sourceQuarantineReasons.length > 20) {
        issues.push({
          path: `${path}.sourceQuarantineReasons`,
          message: 'must contain at most 20 reason codes',
        });
      } else {
        for (const [reasonIndex, value] of row.sourceQuarantineReasons.entries()) {
          const reasonPath = `${path}.sourceQuarantineReasons[${reasonIndex}]`;
          const reason = text(value, reasonPath, 100, issues, true);
          if (!QUARANTINE_REASON.test(reason)) {
            issues.push({ path: reasonPath, message: 'must be a canonical reason code' });
          }
          if (sourceQuarantineReasons.includes(reason)) {
            issues.push({ path: reasonPath, message: 'must not be duplicated' });
          }
          sourceQuarantineReasons.push(reason);
        }
      }
    }
    const normalized = {
      sourceRecordId,
      displayName: text(row.displayName, `${path}.displayName`, 200, issues, true),
      companyName: text(row.companyName, `${path}.companyName`, 200, issues, false),
      originalCreatedAt,
      identities,
      attribution: row.attribution == null
        ? null
        : normalizeAttribution(row.attribution, `${path}.attribution`, originalCreatedAt, now, issues),
      sourceQuarantineReasons,
    };
    // `sourceQuarantineReasons` was added after schema v1 was already in use.
    // Preserve the exact pre-existing canonical bytes when it is absent/empty
    // so staged batches and receipts remain replay-compatible. Runtime callers
    // still receive an explicit empty array through `normalized`.
    const canonicalPayload = sourceQuarantineReasons.length > 0
      ? normalized
      : {
          sourceRecordId: normalized.sourceRecordId,
          displayName: normalized.displayName,
          companyName: normalized.companyName,
          originalCreatedAt: normalized.originalCreatedAt,
          identities: normalized.identities,
          attribution: normalized.attribution,
        };
    let payloadJson = '';
    try {
      payloadJson = stableJson(canonicalPayload);
      if (Buffer.byteLength(payloadJson, 'utf8') > 524_288) {
        issues.push({ path, message: 'canonical row must be at most 512 KiB' });
      }
    } catch {
      issues.push({ path, message: 'must contain JSON-safe values only' });
    }
    rows.push({ ...normalized, payloadJson, payloadHash: hash(payloadJson) });
  }

  const unresolvedKeys = new Set<string>();
  const unresolvedAttributions = (Array.isArray(unresolvedInput) ? unresolvedInput : [])
    .map((item, index) => {
      const normalized = normalizeUnresolvedAttribution(
        item,
        `unresolvedAttributions[${index}]`,
        now,
        issues,
      );
      const key = `${normalized.recordKind}\u0000${normalized.sourceRecordId}`;
      if (unresolvedKeys.has(key)) {
        issues.push({
          path: `unresolvedAttributions[${index}].sourceRecordId`,
          message: 'must be unique per record kind within the batch',
        });
      }
      unresolvedKeys.add(key);
      return normalized;
    });

  if (issues.length > 0) throw new LegacyImportValidationError(issues);
  const inputJson = stableJson({
    schemaVersion: 1,
    sourceSystem,
    batchKey,
    rows: rows.map((row) => JSON.parse(row.payloadJson)),
    unresolvedAttributions: unresolvedAttributions.map((row) => JSON.parse(row.payloadJson)),
  });
  if (Buffer.byteLength(inputJson, 'utf8') > 50 * 1024 * 1024) {
    throw new LegacyImportValidationError([{ path: '$', message: 'canonical batch must be at most 50 MiB' }]);
  }
  return {
    schemaVersion: 1,
    sourceSystem,
    batchKey,
    rows,
    unresolvedAttributions,
    inputJson,
    inputHash: hash(inputJson),
  };
}

export function bytesToHex(value: Uint8Array): string {
  return Buffer.from(value).toString('hex');
}

export function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return Buffer.from(left).equals(Buffer.from(right));
}
