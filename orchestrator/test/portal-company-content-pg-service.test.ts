import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  COMPANY_CONTENT_EMAIL_DRAFT_MIME_TYPE,
  COMPANY_CONTENT_EMAIL_DRAFT_SCHEMA,
  CompanyContentApprovalConflictError,
  CompanyContentCommandInProgressError,
  CompanyContentIdempotencyConflictError,
  CompanyContentNotFoundError,
  CompanyContentValidationError,
  CompanyContentVersionConflictError,
  type CompanyContentCatalogPage,
  type CompanyContentExactReview,
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
import { createPropertyPredatorContentCatalogFixture } from '../src/portal/content-control-room-fixtures.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const WORKSPACE_ID = '22222222-2222-4222-8222-222222222222';
const CONTENT_ITEM_ID = '33333333-3333-4333-8333-333333333333';
const CONTENT_VERSION_ID = '44444444-4444-4444-8444-444444444444';
const APPROVAL_REQUEST_ID = '55555555-5555-4555-8555-555555555555';
const APPROVAL_DECISION_ID = '66666666-6666-4666-8666-666666666666';
const CONTENT_SHA = 'a'.repeat(64);

const EXACT_EMAIL_REVIEW: CompanyContentExactReview = Object.freeze({
  contentItemId: CONTENT_ITEM_ID,
  contentVersionId: CONTENT_VERSION_ID,
  versionNumber: 1,
  isLatest: true,
  origin: 'generated',
  kind: 'email',
  title: 'Owned-seed welcome draft',
  contentMimeType: COMPANY_CONTENT_EMAIL_DRAFT_MIME_TYPE,
  canonicalContent: '{"bodyText":"Fixture body","schema":"propertypredator.email-draft/v1","subject":"Fixture subject"}',
  canonicalByteLength: 104,
  contentSha256: CONTENT_SHA,
  source: Object.freeze({
    system: 'propertypredator.company-content',
    itemId: 'owned-seed-welcome',
    version: 'v1',
  }),
  blobSha256: 'b'.repeat(64),
  brandSha256: 'c'.repeat(64),
  approvalRequestId: APPROVAL_REQUEST_ID,
  approvalDecisionId: null,
  approvalStatus: 'pending',
  approvalStale: false,
  email: Object.freeze({
    schema: COMPANY_CONTENT_EMAIL_DRAFT_SCHEMA,
    subject: 'Fixture subject',
    bodyText: 'Fixture body',
    subjectSha256: 'd'.repeat(64),
    bodySha256: 'e'.repeat(64),
  }),
  createdAt: '2026-08-28T14:00:00.000Z',
});

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

test('portal exact review resolves authenticated workspace context and returns exact immutable copy', async () => {
  const contexts: DatabaseRequestContext[] = [];
  let receivedInput: unknown;
  const service = new PgPortalCompanyContentService(dependencies({
    accessReader: {
      load: async (context) => {
        contexts.push(context);
        return workspaceAccess();
      },
    },
    readService: {
      listCatalog: async () => EMPTY_CATALOG,
      getExactReview: async (context, input) => {
        contexts.push(context);
        receivedInput = input;
        return EXACT_EMAIL_REVIEW;
      },
    },
  }));
  const input = { contentItemId: CONTENT_ITEM_ID, contentVersionId: CONTENT_VERSION_ID };

  const outcome = await service.review(identity(), input);

  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.deepEqual(receivedInput, input);
  assert.strictEqual(outcome.snapshot.review, EXACT_EMAIL_REVIEW);
  assert.equal(outcome.snapshot.review.email?.subject, 'Fixture subject');
  assert.equal(contexts.length, 2);
  contexts.forEach(assertRlsContext);
  assert.strictEqual(contexts[0], contexts[1]);
  assert.ok(Object.isFrozen(outcome));
  assert.ok(Object.isFrozen(outcome.snapshot));
});

test('portal exact review fails closed when the version is absent or the seam is not composed', async () => {
  const absent = new PgPortalCompanyContentService(dependencies({
    readService: {
      listCatalog: async () => EMPTY_CATALOG,
      getExactReview: async () => null,
    },
  }));
  assert.deepEqual(await absent.review(identity(), {
    contentItemId: CONTENT_ITEM_ID,
    contentVersionId: CONTENT_VERSION_ID,
  }), {
    ok: false,
    kind: 'not_found',
    message: 'That exact content version is not available in this workspace.',
  });

  const uncomposed = new PgPortalCompanyContentService(dependencies());
  assert.deepEqual(await uncomposed.review(identity(), {
    contentItemId: CONTENT_ITEM_ID,
    contentVersionId: CONTENT_VERSION_ID,
  }), {
    ok: false,
    kind: 'review_unavailable',
    message: 'Exact company content review is temporarily unavailable.',
  });
});

test('portal company content snapshot preserves a publishable claim when the exact review route is available', async () => {
  const sourceCatalog = createPropertyPredatorContentCatalogFixture();
  assert.equal(sourceCatalog.items[0]?.publishable, true);
  const service = new PgPortalCompanyContentService(dependencies({
    readService: { listCatalog: async () => sourceCatalog },
  }));

  const outcome = await service.snapshot(identity());

  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.snapshot.catalog.items[0]?.publishable, true);
  assert.equal(sourceCatalog.items[0]?.publishable, true);
  assert.ok(Object.isFrozen(outcome.snapshot.catalog));
  assert.ok(Object.isFrozen(outcome.snapshot.catalog.items));
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

test('manager-only portal seam persists one server-assembled email draft without approving it', async () => {
  let capturedContext: DatabaseRequestContext | null = null;
  let capturedInput: unknown;
  const input = {
    commandKey: 'campaign-email-draft-persist-1',
    origin: 'generated' as const,
    title: 'Owned-seed welcome email',
    subject: 'Exact fixture subject',
    bodyText: 'Exact fixture body for owned-seed review only.',
    source: {
      system: 'propertypredator.company-content',
      itemId: 'campaign-owned-seed-welcome',
      version: 'draft-v1',
    },
    blob: { storageKey: 'company-content/campaign-owned-seed-welcome/v1', sha256: 'b'.repeat(64) },
    brand: { snapshotRef: 'brand/property-predator/runtime-v1', sha256: 'c'.repeat(64) },
    attestation: {
      catalogSha256: 'd'.repeat(64),
      checkedAt: '2026-08-28T14:00:00.000Z',
      expiresAt: '2026-08-28T14:10:00.000Z',
    },
    metadata: { evidenceSha256: 'e'.repeat(64), approvalStatus: 'unrequested' },
  };
  const service = new PgPortalCompanyContentService(dependencies({
    draftService: {
      createEmailDraftVersion: async (context, command) => {
        capturedContext = context;
        capturedInput = command;
        return Object.freeze({
          disposition: 'applied' as const,
          contentItemId: CONTENT_ITEM_ID,
          contentVersionId: CONTENT_VERSION_ID,
          versionNumber: 1,
          contentSha256: CONTENT_SHA,
          sourceAttestationId: '77777777-7777-4777-8777-777777777777',
          sourceAttestationExpiresAt: '2026-08-28T14:10:00.000Z',
        });
      },
    },
  }));

  const outcome = await service.createEmailDraftVersion(identity(), input);

  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.contentVersionId, CONTENT_VERSION_ID);
  assert.deepEqual(capturedInput, input);
  assert.ok(capturedContext);
  assertRlsContext(capturedContext);
  assert.equal('approvalDecisionId' in outcome, false);

  let commands = 0;
  const readOnly = new PgPortalCompanyContentService(dependencies({
    accessReader: { load: async () => workspaceAccess({ canManage: false }) },
    draftService: {
      createEmailDraftVersion: async () => {
        commands += 1;
        throw new Error('must not run');
      },
    },
  }));
  const denied = await readOnly.createEmailDraftVersion(identity(), input);
  assert.equal(denied.ok, false);
  if (!denied.ok) assert.equal(denied.kind, 'forbidden');
  assert.equal(commands, 0);
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

test('manager rejection returns immutable request, version and hash evidence', async () => {
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
          decision: input.decision,
          contentSha256: CONTENT_SHA,
        };
      },
    },
  }));
  const input = {
    commandKey: 'content-decision-2',
    approvalRequestId: APPROVAL_REQUEST_ID,
    decision: 'rejected' as const,
    decisionNote: 'Exact review content is unavailable.',
  };

  const outcome = await service.decideApproval(identity(), input);

  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.approvalDecisionId, APPROVAL_DECISION_ID);
  assert.equal(outcome.contentVersionId, CONTENT_VERSION_ID);
  assert.equal(outcome.contentSha256, CONTENT_SHA);
  assert.equal(outcome.decision, 'rejected');
  assert.deepEqual(capturedInput, input);
  assert.ok(Object.isFrozen(outcome));
});

test('manager approval fails closed before the command service while exact review content is unavailable', async () => {
  let commands = 0;
  const service = new PgPortalCompanyContentService(dependencies({
    commandService: {
      requestApproval: async () => { throw new Error('not used'); },
      decideApproval: async () => {
        commands += 1;
        throw new Error('must not run');
      },
    },
  }));

  const outcome = await service.decideApproval(identity(), {
    commandKey: 'content-decision-approval-locked',
    approvalRequestId: APPROVAL_REQUEST_ID,
    decision: 'approved',
    decisionNote: null,
  });

  assert.deepEqual(outcome, {
    ok: false,
    kind: 'review_unavailable',
    message: 'Approval is locked until the exact hash-bound content can be shown for review.',
  });
  assert.equal(commands, 0);
});

test('exact-reviewed approval re-reads the pending item, version, request and hash before deciding', async () => {
  let capturedInput: unknown;
  const service = new PgPortalCompanyContentService(dependencies({
    readService: {
      listCatalog: async () => EMPTY_CATALOG,
      getExactReview: async () => EXACT_EMAIL_REVIEW,
    },
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
          decision: input.decision,
          contentSha256: CONTENT_SHA,
        };
      },
    },
  }));

  const outcome = await service.decideExactReviewedApproval(identity(), {
    commandKey: 'content-decision-exact-approved',
    approvalRequestId: APPROVAL_REQUEST_ID,
    decision: 'approved',
    decisionNote: 'Reviewed the exact subject and body.',
    contentItemId: CONTENT_ITEM_ID,
    contentVersionId: CONTENT_VERSION_ID,
    contentSha256: CONTENT_SHA,
  });

  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.decision, 'approved');
  assert.deepEqual(capturedInput, {
    commandKey: 'content-decision-exact-approved',
    approvalRequestId: APPROVAL_REQUEST_ID,
    decision: 'approved',
    decisionNote: 'Reviewed the exact subject and body.',
  });
});

test('exact-reviewed approval fails closed if any immutable target changed', async () => {
  let commands = 0;
  const service = new PgPortalCompanyContentService(dependencies({
    readService: {
      listCatalog: async () => EMPTY_CATALOG,
      getExactReview: async () => Object.freeze({
        ...EXACT_EMAIL_REVIEW,
        contentSha256: 'f'.repeat(64),
      }),
    },
    commandService: {
      requestApproval: async () => { throw new Error('not used'); },
      decideApproval: async () => {
        commands += 1;
        throw new Error('must not run');
      },
    },
  }));

  const outcome = await service.decideExactReviewedApproval(identity(), {
    commandKey: 'content-decision-exact-stale',
    approvalRequestId: APPROVAL_REQUEST_ID,
    decision: 'approved',
    contentItemId: CONTENT_ITEM_ID,
    contentVersionId: CONTENT_VERSION_ID,
    contentSha256: CONTENT_SHA,
  });
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.kind, 'review_unavailable');
  assert.equal(commands, 0);
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
