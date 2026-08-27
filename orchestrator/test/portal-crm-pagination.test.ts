import assert from 'node:assert/strict';
import test from 'node:test';
import {
  crmPageCursorToken,
  verifyCrmPageCursor,
  type CrmContactsPageCursor,
  type CrmTasksPageCursor,
} from '../src/portal/crm-pagination.js';

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_WORKSPACE_ID = '22222222-2222-4222-8222-222222222222';
const RECORD_ID = '33333333-aaaa-4bbb-8ccc-333333333333';
const CURSOR_SECRET = 'server-only-crm-cursor-secret-for-tests-123456';
const OTHER_CURSOR_SECRET = 'different-server-only-cursor-secret-for-tests';

const contacts: CrmContactsPageCursor = Object.freeze({
  version: 1,
  kind: 'contacts',
  workspaceId: WORKSPACE_ID,
  updatedAt: '2026-08-26T09:30:00.000500Z',
  id: RECORD_ID,
});

test('CRM page cursors round-trip only for the exact session, workspace and route', () => {
  const token = crmPageCursorToken(CURSOR_SECRET, 'session-a', contacts);
  assert.ok(token.length > 40);
  assert.deepEqual(verifyCrmPageCursor(CURSOR_SECRET, 'session-a', token, {
    workspaceId: WORKSPACE_ID,
    kind: 'contacts',
  }), contacts);
  assert.equal(verifyCrmPageCursor(CURSOR_SECRET, 'session-b', token, {
    workspaceId: WORKSPACE_ID,
    kind: 'contacts',
  }), null);
  assert.equal(verifyCrmPageCursor(CURSOR_SECRET, 'session-a', token, {
    workspaceId: OTHER_WORKSPACE_ID,
    kind: 'contacts',
  }), null);
  assert.equal(verifyCrmPageCursor(CURSOR_SECRET, 'session-a', token, {
    workspaceId: WORKSPACE_ID,
    kind: 'pipeline',
  }), null);
  assert.equal(verifyCrmPageCursor(OTHER_CURSOR_SECRET, 'session-a', token, {
    workspaceId: WORKSPACE_ID,
    kind: 'contacts',
  }), null, 'knowing the browser session token is insufficient to forge a server-authenticated cursor');
});

test('CRM page cursors reject tampering, extra fields and non-canonical records', () => {
  const token = crmPageCursorToken(CURSOR_SECRET, 'session-a', contacts);
  const [payload, mac] = token.split('.');
  assert.equal(verifyCrmPageCursor(CURSOR_SECRET, 'session-a', `${payload}x.${mac}`, {
    workspaceId: WORKSPACE_ID,
    kind: 'contacts',
  }), null);
  assert.equal(crmPageCursorToken(CURSOR_SECRET, 'session-a', { ...contacts, extra: 'smuggled' } as never), '');
  assert.equal(crmPageCursorToken(CURSOR_SECRET, 'session-a', { ...contacts, id: RECORD_ID.toUpperCase() }), '');
  assert.equal(crmPageCursorToken(CURSOR_SECRET, '', contacts), '');
  assert.equal(crmPageCursorToken('too-short', 'session-a', contacts), '');
  assert.equal(verifyCrmPageCursor(CURSOR_SECRET, 'session-a', 'x'.repeat(2_049), {
    workspaceId: WORKSPACE_ID,
    kind: 'contacts',
  }), null);
});

test('task cursors bind the normalized filter and nullable due-date ordering state', () => {
  const cursor: CrmTasksPageCursor = Object.freeze({
    version: 1,
    kind: 'tasks',
    workspaceId: WORKSPACE_ID,
    filter: 'open',
    statusRank: 0,
    dueAt: null,
    updatedAt: '2026-08-26T09:30:00.000500Z',
    id: RECORD_ID,
  });
  const token = crmPageCursorToken(CURSOR_SECRET, 'session-a', cursor);
  assert.deepEqual(verifyCrmPageCursor(CURSOR_SECRET, 'session-a', token, {
    workspaceId: WORKSPACE_ID,
    kind: 'tasks',
    taskFilter: 'open',
  }), cursor);
  assert.equal(verifyCrmPageCursor(CURSOR_SECRET, 'session-a', token, {
    workspaceId: WORKSPACE_ID,
    kind: 'tasks',
    taskFilter: 'all',
  }), null);
});
