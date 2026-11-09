import { createHmac, timingSafeEqual } from 'node:crypto';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ORDERING_TIMESTAMP_PATTERN = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\.(\d{3,6})Z$/;
const CURSOR_CONTEXT = 'relaunch72/portal/crm-page-cursor/v1\u0000';
const MAX_CURSOR_TOKEN_LENGTH = 2_048;

export const CRM_PAGE_SIZE = 50;
export const CRM_PAGE_QUERY_KEY = 'after';

export type CrmPageKind = 'contacts' | 'pipeline' | 'tasks';
export type CrmTaskPageFilter = 'open' | 'completed' | 'all';

interface CrmPageCursorBase {
  readonly version: 1;
  readonly kind: CrmPageKind;
  readonly workspaceId: string;
}

export interface CrmContactsPageCursor extends CrmPageCursorBase {
  readonly kind: 'contacts';
  readonly updatedAt: string;
  readonly id: string;
}

export interface CrmPipelinePageCursor extends CrmPageCursorBase {
  readonly kind: 'pipeline';
  readonly updatedAt: string;
  readonly id: string;
}

export interface CrmTasksPageCursor extends CrmPageCursorBase {
  readonly kind: 'tasks';
  readonly filter: CrmTaskPageFilter;
  readonly statusRank: 0 | 1 | 2;
  readonly dueAt: string | null;
  readonly updatedAt: string;
  readonly id: string;
}

export type CrmPageCursor = CrmContactsPageCursor | CrmPipelinePageCursor | CrmTasksPageCursor;

function canonicalUuid(value: unknown): string | null {
  return typeof value === 'string' && UUID_PATTERN.test(value) ? value : null;
}

function canonicalTimestamp(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = ORDERING_TIMESTAMP_PATTERN.exec(value);
  if (!match) return null;
  const millisecondProjection = `${match[1]}.${match[2]!.slice(0, 3)}Z`;
  const parsed = new Date(millisecondProjection);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== millisecondProjection) return null;
  return value;
}

function parseCursor(value: unknown): CrmPageCursor | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row.version !== 1) return null;
  const workspaceId = canonicalUuid(row.workspaceId);
  const updatedAt = canonicalTimestamp(row.updatedAt);
  const id = canonicalUuid(row.id);
  if (!workspaceId || !updatedAt || !id) return null;

  if (row.kind === 'contacts' || row.kind === 'pipeline') {
    const expectedKeys = ['id', 'kind', 'updatedAt', 'version', 'workspaceId'];
    if (Object.keys(row).sort().join(',') !== expectedKeys.sort().join(',')) return null;
    return Object.freeze({
      version: 1,
      kind: row.kind,
      workspaceId,
      updatedAt,
      id,
    });
  }

  if (row.kind !== 'tasks') return null;
  const expectedKeys = [
    'dueAt', 'filter', 'id', 'kind', 'statusRank', 'updatedAt', 'version', 'workspaceId',
  ];
  if (Object.keys(row).sort().join(',') !== expectedKeys.sort().join(',')) return null;
  if (row.filter !== 'open' && row.filter !== 'completed' && row.filter !== 'all') return null;
  if (row.statusRank !== 0 && row.statusRank !== 1 && row.statusRank !== 2) return null;
  const dueAt = row.dueAt === null ? null : canonicalTimestamp(row.dueAt);
  if (row.dueAt !== null && !dueAt) return null;
  return Object.freeze({
    version: 1,
    kind: 'tasks',
    workspaceId,
    filter: row.filter,
    statusRank: row.statusRank,
    dueAt,
    updatedAt,
    id,
  });
}

function cursorKey(serverSecret: string, sessionToken: string): Buffer | null {
  if (serverSecret.length < 32 || serverSecret.length > 4_096
      || !sessionToken || sessionToken.length > 4_096) return null;
  return createHmac('sha256', serverSecret)
    .update(`${CURSOR_CONTEXT}session-key\u0000`, 'utf8')
    .update(sessionToken, 'utf8')
    .digest();
}

function cursorMac(serverSecret: string, sessionToken: string, encodedPayload: string): Buffer | null {
  const key = cursorKey(serverSecret, sessionToken);
  return key
    ? createHmac('sha256', key)
      .update(`${CURSOR_CONTEXT}payload\u0000`, 'utf8')
      .update(encodedPayload, 'ascii')
      .digest()
    : null;
}

/**
 * Opaque, server-authenticated and session-bound keyset cursor. A fresh first
 * page starts a new walk; records edited during a walk may legitimately move.
 */
export function crmPageCursorToken(serverSecret: string, sessionToken: string, cursor: CrmPageCursor): string {
  const parsed = parseCursor(cursor);
  if (!parsed) return '';
  const payload = Buffer.from(JSON.stringify(parsed), 'utf8').toString('base64url');
  const mac = cursorMac(serverSecret, sessionToken, payload);
  if (!mac) return '';
  const token = `${payload}.${mac.toString('base64url')}`;
  return token.length <= MAX_CURSOR_TOKEN_LENGTH ? token : '';
}

export function verifyCrmPageCursor(
  serverSecret: string,
  sessionToken: string,
  token: string | null | undefined,
  expected: Readonly<{
    workspaceId: string;
    kind: CrmPageKind;
    taskFilter?: CrmTaskPageFilter;
  }>,
): CrmPageCursor | null {
  if (!token || token.length > MAX_CURSOR_TOKEN_LENGTH) return null;
  const segments = token.split('.');
  if (segments.length !== 2 || !segments[0] || !segments[1]) return null;
  const expectedMac = cursorMac(serverSecret, sessionToken, segments[0]);
  if (!expectedMac) return null;

  let suppliedMac: Buffer;
  try {
    suppliedMac = Buffer.from(segments[1], 'base64url');
  } catch {
    return null;
  }
  if (suppliedMac.length !== expectedMac.length || !timingSafeEqual(suppliedMac, expectedMac)) return null;

  let decoded: unknown;
  try {
    const text = Buffer.from(segments[0], 'base64url').toString('utf8');
    if (!text || Buffer.byteLength(text, 'utf8') > 1_024) return null;
    decoded = JSON.parse(text);
  } catch {
    return null;
  }
  const cursor = parseCursor(decoded);
  if (!cursor || cursor.workspaceId !== expected.workspaceId || cursor.kind !== expected.kind) return null;
  if (cursor.kind === 'tasks' && cursor.filter !== expected.taskFilter) return null;
  if (cursor.kind !== 'tasks' && expected.taskFilter !== undefined) return null;
  return cursor;
}
