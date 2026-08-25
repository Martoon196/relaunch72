import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  CompanyContentApprovalConflictError,
  CompanyContentCommandInProgressError,
  CompanyContentIdempotencyConflictError,
  CompanyContentNotFoundError,
  CompanyContentValidationError,
  CompanyContentVersionConflictError,
  type CompanyContentCatalogPage,
  type CompanyContentTransactionRunner,
} from '../src/company-content-pg/index.js';
import type { DatabaseRequestContext } from '../src/db/rls.js';
import { InactivePortalSessionError } from '../src/db/transaction.js';
import {
  PgPortalCompanyContentService,
  PgPortalCompanyContentWorkspaceAccessReader,
  type PgPortalCompanyContentDependencies,
} from '../src/portal/company-content-pg-service.js';
import type {
  PortalCompanyContentRequestIdentity,
  PortalCompanyContentWorkspaceAccess,
} from '../src/portal/company-content-service.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const WORKSPACE_ID = '22222222-2222-4222-8222-222222222222';
const CONTENT_ITEM_ID = '33333333-3333-4333-8333-333333333333';
const CONTENT_VERSION_ID = '44444444-4444-4444-8444-444444444444';
const APPROVAL_REQUEST_ID = '55555555-5555-4555-8555-555555555555';
const APPROVAL_DECISION_ID = '66666666-6666-4666-8666-666666666666';
const CONTENT_SHA = 'a'.repeat(64);

function identity(overrides: Partial<PortalCompanyContentRequestIdentity> = {}): PortalCompanyContentRequestIdentity {
  return {
    sessionToken: 'opaque-portal-session',
    requestId: 'request-content-1',
    ...overrides,
  };
}

function workspaceAccess(
  overrides: Partial<PortalCompanyContentWorkspaceAccess> = {},
): PortalCompanyContentWorkspaceAccess {
  return Object.freeze({
    workspaceId: WORKSPACE_ID,
    workspaceName: 'Property Predator',
    snapshotAt: '2026-08-26T12:00:00.000Z',
    canWrite: true,
    canManage: true,
    ...overrides,
  });
}

const EMPTY_CATALOG: CompanyContentCatalogPage = Object.freeze({
  items: Object.freeze([]),
  nextCursor: null,
});

function dependencies(
  overrides: Partial<PgPortalCompanyContentDependencies> = {},
): PgPortalCompanyContentDependencies {
  return {
    principalResolver: {
      resolve: async () => Object.freeze({ userId: USER_ID, workspaceId: WORKSPACE_ID }),
    },
    accessReader: { load: async () => workspaceAccess() },
    readService: { listCatalog: async () => EMPTY_CATALOG },
    commandService: {
      requestApproval: async () => Object.freeze({
        disposition: 'applied' as const,
        approvalRequestId: APPROVAL_REQUEST_ID,
        contentItemId: CONTENT_ITEM_ID,
        contentVersionId: CONTENT_VERSION_ID,
        requestNumber: 1,
        contentSha256: CONTENT_SHA,
      }),
      decideApproval: async () => Object.freeze({
        disposition: 'applied' as const,
        approvalDecisionId: APPROVAL_DECISION_ID,
        approvalRequestId: APPROVAL_REQUEST_ID,
        contentItemId: CONTENT_ITEM_ID,
        contentVersionId: CONTENT_VERSION_ID,
        decision: 'approved' as const,
        contentSha256: CONTENT_SHA,
      }),
    },
    ...overrides,
  };
}

function assertRlsContext(context: DatabaseRequestContext): void {
  assert.equal(context.actorKind, 'user');
  assert.equal(context.userId, USER_ID);
  assert.equal(context.workspaceId, WORKSPACE_ID);
  assert.equal(context.requestId, 'request-content-1');
  assert.deepEqual(
    context.portalSessionTokenHash,
    createHash('sha256').update('opaque-portal-session').digest(),
  );
}

test('portal company content snapshot resolves one server-owned RLS context and returns capabilities with the bounded catalog', async () => {
  const contexts: DatabaseRequestContext[] = [];
  let receivedQuery: unknown;
  const service = new PgPortalCompanyContentService(dependencies({
    accessReader: {
      load: async (context) => {
        contexts.push(context);
        return workspaceAccess({ canManage: false });
      },
    },
    readService: {
      listCatalog: async (context, query) => {
        contexts.push(context);
        receivedQuery = query;
        return EMPTY_CATALOG;
      },
    },
  }));

  const outcome = await service.snapshot(identity(), { limit: 25 });

  assert.equal(outcome.ok, true);
  assert.equal(contexts.length, 2);
  contexts.forEach(assertRlsContext);
  assert.strictEqual(contexts[0], contexts[1], 'access and catalog receive the exact same request context');
  assert.deepEqual(receivedQuery, { limit: 25 });
  if (!outcome.ok) return;
  assert.equal(outcome.snapshot.workspace.workspaceName, 'Property Predator');
  assert.equal(outcome.snapshot.workspace.canManage, false);
  assert.strictEqual(outcome.snapshot.catalog, EMPTY_CATALOG);
  assert.ok(Object.isFrozen(outcome));
  assert.ok(Object.isFrozen(outcome.snapshot));
});

test('portal company content stops an unresolved session before any workspace or content read', async () => {
  let calls = 0;
  const service = new PgPortalCompanyContentService(dependencies({
    principalResolver: { resolve: async () => null },
    accessReader: { load: async () => { calls += 1; return workspaceAccess(); } },
    readService: { listCatalog: async () => { calls += 1; return EMPTY_CATALOG; } },
  }));

  assert.deepEqual(await service.snapshot(identity()), {
    ok: false,
    kind: 'unauthenticated',
    message: 'This portal session is no longer active.',
  });
  assert.equal(calls, 0);
});

test('approval request always forwards the exact item and immutable version under the portal RLS context', async () => {
  const captures: { context: DatabaseRequestContext; input: unknown }[] = [];
  const service = new PgPortalCompanyContentService(dependencies({
    commandService: {
      requestApproval: async (context, input) => {
        captures.push({ context, input });
        return {
          disposition: 'replayed',
          approvalRequestId: APPROVAL_REQUEST_ID,
          contentItemId: CONTENT_ITEM_ID,
          contentVersionId: CONTENT_VERSION_ID,
          requestNumber: 2,
          contentSha256: CONTENT_SHA,
        };
      },
      decideApproval: async () => { throw new Error('not used'); },
    },
  }));
  const input = {
    commandKey: 'content-request-approval-1',
    contentItemId: CONTENT_ITEM_ID,
    contentVersionId: CONTENT_VERSION_ID,
    reviewNote: 'Check the exact reviewed copy.',
  };

  const outcome = await service.requestApproval(identity(), input);

  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.disposition, 'replayed');
  assert.equal(outcome.contentVersionId, CONTENT_VERSION_ID);
  assert.equal(captures.length, 1);
  const captured = captures[0]!;
  assert.deepEqual(captured.input, input);
  assertRlsContext(captured.context);
  assert.ok(Object.isFrozen(outcome));
});

test('read-only membership cannot request approval and never reaches the command service', async () => {
  let commands = 0;
  const service = new PgPortalCompanyContentService(dependencies({
    accessReader: { load: async () => workspaceAccess({ canWrite: false, canManage: false }) },
    commandService: {
      requestApproval: async () => { commands += 1; throw new Error('must not run'); },
      decideApproval: async () => { commands += 1; throw new Error('must not run'); },
    },
  }));

  const outcome = await service.requestApproval(identity(), {
    commandKey: 'content-request-approval-2',
    contentItemId: CONTENT_ITEM_ID,
    contentVersionId: CONTENT_VERSION_ID,
  });

  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.kind, 'forbidden');
  assert.match(outcome.message, /read-only/i);
  assert.equal(commands, 0);
});

test('approval decisions are manager-only before the command and command RLS remains authoritative', async () => {
  let commands = 0;
  const nonManager = new PgPortalCompanyContentService(dependencies({
    accessReader: { load: async () => workspaceAccess({ canWrite: true, canManage: false }) },
    commandService: {
      requestApproval: async () => { throw new Error('not used'); },
      decideApproval: async () => { commands += 1; throw new Error('must not run'); },
    },
  }));
  const decision = {
    commandKey: 'content-decision-1',
    approvalRequestId: APPROVAL_REQUEST_ID,
    decision: 'changes_requested' as const,
    decisionNote: 'Tighten the call to action.',
  };

  const denied = await nonManager.decideApproval(identity(), decision);
  assert.equal(denied.ok, false);
  if (!denied.ok) assert.equal(denied.kind, 'forbidden');
  assert.equal(commands, 0);

  let capturedContext: DatabaseRequestContext | null = null;
  const roleChangedDuringCommand = new PgPortalCompanyContentService(dependencies({
    commandService: {
      requestApproval: async () => { throw new Error('not used'); },
      decideApproval: async (context) => {
        commands += 1;
        capturedContext = context;
        throw Object.assign(new Error('permission denied for table'), { code: '42501' });
      },
    },
  }));

  const changed = await roleChangedDuringCommand.decideApproval(identity(), decision);
  assert.equal(changed.ok, false);
  if (!changed.ok) assert.equal(changed.kind, 'forbidden');
  assert.equal(commands, 1);
  assert.ok(capturedContext);
  assertRlsContext(capturedContext);
});

test('manager approval decision returns the immutable request, version and hash evidence', async () => {
  let capturedInput: unknown;
  const service = new PgPortalCompanyContentService(dependencies({
    commandService: {
      requestApproval: async () => { throw new Error('not used'); },
      decideApproval: async (_context, input) => {
        capturedInput = input;
        return {
          disposition: 'applied',
          approvalDecisionId: APPROVAL_DECISION_ID,
          approvalRequestId: APPROVAL_REQUEST_ID,
          contentItemId: CONTENT_ITEM_ID,
          contentVersionId: CONTENT_VERSION_ID,
          decision: 'approved',
          contentSha256: CONTENT_SHA,
        };
      },
    },
  }));
  const input = {
    commandKey: 'content-decision-2',
    approvalRequestId: APPROVAL_REQUEST_ID,
    decision: 'approved' as const,
    decisionNote: null,
  };

  const outcome = await service.decideApproval(identity(), input);

  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.approvalDecisionId, APPROVAL_DECISION_ID);
  assert.equal(outcome.contentVersionId, CONTENT_VERSION_ID);
  assert.equal(outcome.contentSha256, CONTENT_SHA);
  assert.deepEqual(capturedInput, input);
  assert.ok(Object.isFrozen(outcome));
});

test('portal boundary preserves distinct validation, idempotency, in-progress, version and approval conflicts', async (t) => {
  const cases: readonly Readonly<{
    name: string;
    error: Error;
    kind: string;
  }>[] = [
    { name: 'validation', error: new CompanyContentValidationError('internal detail'), kind: 'validation' },
    { name: 'not found', error: new CompanyContentNotFoundError('internal entity'), kind: 'not_found' },
    { name: 'idempotency', error: new CompanyContentIdempotencyConflictError(), kind: 'idempotency_conflict' },
    { name: 'in progress', error: new CompanyContentCommandInProgressError(), kind: 'command_in_progress' },
    { name: 'version', error: new CompanyContentVersionConflictError('internal version'), kind: 'version_conflict' },
    { name: 'approval', error: new CompanyContentApprovalConflictError('internal approval'), kind: 'approval_conflict' },
    { name: 'inactive session', error: new InactivePortalSessionError(), kind: 'unauthenticated' },
    { name: 'unknown', error: new Error('secret database detail'), kind: 'unavailable' },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const service = new PgPortalCompanyContentService(dependencies({
        commandService: {
          requestApproval: async () => { throw scenario.error; },
          decideApproval: async () => { throw new Error('not used'); },
        },
      }));
      const outcome = await service.requestApproval(identity(), {
        commandKey: 'content-conflict-case',
        contentItemId: CONTENT_ITEM_ID,
        contentVersionId: CONTENT_VERSION_ID,
      });
      assert.equal(outcome.ok, false);
      if (outcome.ok) return;
      assert.equal(outcome.kind, scenario.kind);
      assert.doesNotMatch(outcome.message, /internal|secret database detail/i);
    });
  }
});

test('workspace access reader runs read-only in the caller RLS context and validates the returned workspace', async () => {
  const context: DatabaseRequestContext = {
    actorKind: 'user',
    userId: USER_ID,
    workspaceId: WORKSPACE_ID,
    requestId: 'request-content-1',
    portalSessionTokenHash: Buffer.alloc(32, 7),
  };
  let sql = '';
  let receivedContext: DatabaseRequestContext | null = null;
  let receivedOptions: unknown;
  const transactionRunner: CompanyContentTransactionRunner = {
    run: async (candidate, operation, options) => {
      receivedContext = candidate;
      receivedOptions = options;
      return operation({
        async query<TRow extends Record<string, unknown> = Record<string, unknown>>(
          statement: string,
        ) {
          sql = statement;
          return {
            rows: [{
              workspaceId: WORKSPACE_ID.toUpperCase(),
              workspaceName: 'Property Predator',
              snapshotAt: new Date('2026-08-26T12:00:00.000Z'),
              canWrite: true,
              canManage: false,
            }] as unknown as TRow[],
            rowCount: 1,
          };
        },
      });
    },
  };
  const reader = new PgPortalCompanyContentWorkspaceAccessReader(transactionRunner);

  const access = await reader.load(context);

  assert.strictEqual(receivedContext, context);
  assert.deepEqual(receivedOptions, { readOnly: true });
  assert.match(sql, /app_private\.can_write_workspace/);
  assert.match(sql, /app_private\.can_manage_workspace/);
  assert.match(sql, /app_private\.current_workspace_id/);
  assert.deepEqual(access, workspaceAccess({ canManage: false }));
  assert.ok(Object.isFrozen(access));
});

test('router-facing service deliberately exposes no source import, provider or publish operation', () => {
  const service = new PgPortalCompanyContentService(dependencies()) as unknown as Record<string, unknown>;
  assert.equal('createVersion' in service, false);
  assert.equal('fetchSource' in service, false);
  assert.equal('publish' in service, false);
  assert.equal('schedule' in service, false);
  assert.equal('send' in service, false);
});
