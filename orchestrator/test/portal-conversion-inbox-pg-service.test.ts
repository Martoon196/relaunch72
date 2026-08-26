import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import type { SqlExecutor } from '../src/crm-pg/types.js';
import type { DatabaseRequestContext } from '../src/db/rls.js';
import {
  InboxCommandInProgressError,
  InboxConsentBlockedError,
  InboxIdempotencyConflictError,
  InboxNotFoundError,
  InboxValidationError,
  InboxVersionConflictError,
  type InboxCommandService,
  type InboxMessageMutationResult,
  type InboxTransactionRunner,
} from '../src/inbox-pg/index.js';
import {
  PgPortalConversionInboxCommandService,
  PgPortalConversionInboxWorkspaceAccessReader,
  type PgPortalConversionInboxDependencies,
} from '../src/portal/conversion-inbox-pg-service.js';
import type {
  PortalConversionInboxRequestIdentity,
  PortalConversionInboxWorkspaceAccess,
} from '../src/portal/conversion-inbox-service.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const WORKSPACE_ID = '22222222-2222-4222-8222-222222222222';
const CONVERSATION_ID = '33333333-3333-4333-8333-333333333333';
const CONTACT_POINT_ID = '44444444-4444-4444-8444-444444444444';
const MESSAGE_ID = '55555555-5555-4555-8555-555555555555';
const MESSAGE_VERSION_ID = '66666666-6666-4666-8666-666666666666';
const APPROVAL_REQUEST_ID = '77777777-7777-4777-8777-777777777777';
const APPROVAL_DECISION_ID = '88888888-8888-4888-8888-888888888888';
const PROVIDER_OPERATION_ID = '99999999-9999-4999-8999-999999999999';
const MESSAGE_DELIVERY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CONSENT_EVENT_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const BODY_SHA256 = createHash('sha256').update('Exact draft body', 'utf8').digest('hex');

function identity(
  overrides: Partial<PortalConversionInboxRequestIdentity> = {},
): PortalConversionInboxRequestIdentity {
  return Object.freeze({
    sessionToken: 'opaque-inbox-session',
    requestId: 'portal-inbox-command-1',
    ...overrides,
  });
}

function access(
  overrides: Partial<PortalConversionInboxWorkspaceAccess> = {},
): PortalConversionInboxWorkspaceAccess {
  return Object.freeze({
    workspaceId: WORKSPACE_ID,
    canWrite: true,
    canManage: true,
    ...overrides,
  });
}

function messageResult(
  overrides: Partial<InboxMessageMutationResult> = {},
): InboxMessageMutationResult {
  return Object.freeze({
    disposition: 'applied',
    conversationId: CONVERSATION_ID,
    messageId: MESSAGE_ID,
    messageVersionId: MESSAGE_VERSION_ID,
    versionNumber: 2,
    bodySha256: BODY_SHA256,
    lifecycle: 'draft',
    rowVersion: 2,
    ...overrides,
  });
}

type CommandBoundary = PgPortalConversionInboxDependencies['commandService'];

function commandService(overrides: Partial<CommandBoundary> = {}): CommandBoundary {
  return {
    createDraft: async () => messageResult({ versionNumber: 1, rowVersion: 1 }),
    reviseDraft: async () => messageResult(),
    requestApproval: async () => Object.freeze({
      ...messageResult({ lifecycle: 'approval_pending', rowVersion: 3 }),
      approvalRequestId: APPROVAL_REQUEST_ID,
      requestNumber: 1,
    }),
    decideApproval: async () => Object.freeze({
      ...messageResult({ lifecycle: 'approved', rowVersion: 4 }),
      approvalRequestId: APPROVAL_REQUEST_ID,
      approvalDecisionId: APPROVAL_DECISION_ID,
      decision: 'approved',
    }),
    queueApprovedMessage: async () => Object.freeze({
      ...messageResult({ lifecycle: 'committed', rowVersion: 5 }),
      providerOperationId: PROVIDER_OPERATION_ID,
      messageDeliveryId: MESSAGE_DELIVERY_ID,
      consentEventId: CONSENT_EVENT_ID,
    }),
    ...overrides,
  };
}

function dependencies(
  overrides: Partial<PgPortalConversionInboxDependencies> = {},
): PgPortalConversionInboxDependencies {
  return {
    principalResolver: {
      resolve: async () => Object.freeze({ userId: USER_ID, workspaceId: WORKSPACE_ID }),
    },
    accessReader: { load: async () => access() },
    commandService: commandService(),
    ...overrides,
  };
}

function assertRlsContext(context: DatabaseRequestContext): void {
  assert.equal(context.actorKind, 'user');
  assert.equal(context.userId, USER_ID);
  assert.equal(context.workspaceId, WORKSPACE_ID);
  assert.equal(context.requestId, 'portal-inbox-command-1');
  assert.deepEqual(
    context.portalSessionTokenHash,
    createHash('sha256').update('opaque-inbox-session').digest(),
  );
}

test('portal creates and revises exact immutable TEST draft versions from a server-owned RLS identity', async () => {
  const contexts: DatabaseRequestContext[] = [];
  const inputs: unknown[] = [];
  const service = new PgPortalConversionInboxCommandService(dependencies({
    accessReader: {
      load: async (context) => {
        contexts.push(context);
        return access();
      },
    },
    commandService: commandService({
      createDraft: async (context, input) => {
        contexts.push(context);
        inputs.push(input);
        return messageResult({ versionNumber: 1, rowVersion: 1 });
      },
      reviseDraft: async (context, input) => {
        contexts.push(context);
        inputs.push(input);
        return messageResult();
      },
    }),
  }));
  const sourceContent = Object.freeze({
    versionRef: 'property-predator:webinar:v3',
    sha256: 'c'.repeat(64),
    approvalRef: 'property-predator:approval:12',
  });

  const created = await service.createDraft(identity(), {
    commandKey: 'portal-create-draft-1',
    conversationId: CONVERSATION_ID,
    contactPointId: CONTACT_POINT_ID,
    body: 'Exact draft body',
    sourceContent,
  });
  const revised = await service.reviseDraft(identity(), {
    commandKey: 'portal-revise-draft-2',
    messageId: MESSAGE_ID,
    expectedRowVersion: '1',
    body: 'Exact draft body',
    sourceContent,
  });

  assert.equal(created.ok, true);
  assert.equal(revised.ok, true);
  if (!created.ok || !revised.ok) return;
  assert.equal(created.bodySha256, BODY_SHA256);
  assert.equal(created.messageVersionId, MESSAGE_VERSION_ID);
  assert.equal(created.versionNumber, 1);
  assert.equal(revised.bodySha256, BODY_SHA256);
  assert.equal(revised.versionNumber, 2);
  assert.ok(Object.isFrozen(created));
  assert.ok(Object.isFrozen(revised));
  assert.equal(contexts.length, 4);
  contexts.forEach(assertRlsContext);
  assert.strictEqual(contexts[0], contexts[1]);
  assert.strictEqual(contexts[2], contexts[3]);
  assert.deepEqual(inputs, [
    {
      commandKey: 'portal-create-draft-1',
      conversationId: CONVERSATION_ID,
      contactPointId: CONTACT_POINT_ID,
      body: 'Exact draft body',
      sourceContent,
    },
    {
      commandKey: 'portal-revise-draft-2',
      messageId: MESSAGE_ID,
      expectedRowVersion: 1,
      body: 'Exact draft body',
      sourceContent,
    },
  ]);
  assert.equal('workspaceId' in (inputs[0] as object), false);
  assert.equal('userId' in (inputs[0] as object), false);
  assert.equal('_csrf' in (inputs[0] as object), false);
});

test('portal approval and TEST queue pass exact version fences and expose no live-provider claim', async () => {
  const calls: Array<{ name: string; input: unknown }> = [];
  const service = new PgPortalConversionInboxCommandService(dependencies({
    commandService: commandService({
      requestApproval: async (_context, input) => {
        calls.push({ name: 'request', input });
        return {
          ...messageResult({ lifecycle: 'approval_pending', rowVersion: 3 }),
          approvalRequestId: APPROVAL_REQUEST_ID,
          requestNumber: 1,
        };
      },
      decideApproval: async (_context, input) => {
        calls.push({ name: 'decide', input });
        return {
          ...messageResult({ lifecycle: 'approved', rowVersion: 4 }),
          approvalRequestId: APPROVAL_REQUEST_ID,
          approvalDecisionId: APPROVAL_DECISION_ID,
          decision: 'approved',
        };
      },
      queueApprovedMessage: async (_context, input) => {
        calls.push({ name: 'queue', input });
        return {
          ...messageResult({ lifecycle: 'committed', rowVersion: 5 }),
          providerOperationId: PROVIDER_OPERATION_ID,
          messageDeliveryId: MESSAGE_DELIVERY_ID,
          consentEventId: CONSENT_EVENT_ID,
        };
      },
    }),
  }));

  const requested = await service.requestApproval(identity(), {
    commandKey: 'portal-approval-request-1',
    messageId: MESSAGE_ID,
    expectedRowVersion: '2',
    reviewNote: 'Check the exact promise before TEST queueing.',
  });
  const decided = await service.decideApproval(identity(), {
    commandKey: 'portal-approval-decision-1',
    approvalRequestId: APPROVAL_REQUEST_ID,
    decision: 'approved',
    decisionNote: 'Approved for TEST simulation only.',
  });
  const queued = await service.queueApprovedMessage(identity(), {
    commandKey: 'portal-test-queue-1',
    messageId: MESSAGE_ID,
    expectedRowVersion: '4',
    purpose: 'marketing',
  });

  assert.equal(requested.ok, true);
  assert.equal(decided.ok, true);
  assert.equal(queued.ok, true);
  if (!requested.ok || !decided.ok || !queued.ok) return;
  assert.equal(requested.messageVersionId, MESSAGE_VERSION_ID);
  assert.equal(requested.bodySha256, BODY_SHA256);
  assert.equal(decided.approvalRequestId, APPROVAL_REQUEST_ID);
  assert.equal(decided.approvalDecisionId, APPROVAL_DECISION_ID);
  assert.equal(queued.providerOperationId, PROVIDER_OPERATION_ID);
  assert.equal(queued.messageDeliveryId, MESSAGE_DELIVERY_ID);
  assert.equal(queued.consentEventId, CONSENT_EVENT_ID);
  assert.equal(queued.environment, 'test');
  assert.equal(queued.provider, 'test_conversation');
  assert.deepEqual(calls.map((call) => call.name), ['request', 'decide', 'queue']);
  assert.equal((calls[0]!.input as { expectedRowVersion: unknown }).expectedRowVersion, 2);
  assert.equal((calls[2]!.input as { expectedRowVersion: unknown }).expectedRowVersion, 4);
});

test('portal stops unresolved, read-only and non-manager sessions before any inbox mutation', async () => {
  let mutations = 0;
  const counted = commandService({
    createDraft: async () => { mutations += 1; return messageResult(); },
    decideApproval: async () => {
      mutations += 1;
      return {
        ...messageResult({ lifecycle: 'approved' }),
        approvalRequestId: APPROVAL_REQUEST_ID,
        approvalDecisionId: APPROVAL_DECISION_ID,
        decision: 'approved',
      };
    },
    queueApprovedMessage: async () => {
      mutations += 1;
      return {
        ...messageResult({ lifecycle: 'committed' }),
        providerOperationId: PROVIDER_OPERATION_ID,
        messageDeliveryId: MESSAGE_DELIVERY_ID,
        consentEventId: CONSENT_EVENT_ID,
      };
    },
  });
  const unresolved = new PgPortalConversionInboxCommandService(dependencies({
    principalResolver: { resolve: async () => null },
    commandService: counted,
  }));
  const noSession = await unresolved.createDraft(identity(), {
    commandKey: 'no-session', conversationId: CONVERSATION_ID,
    contactPointId: CONTACT_POINT_ID, body: 'Exact draft body',
  });
  assert.deepEqual(noSession, {
    ok: false,
    kind: 'unauthenticated',
    message: 'This portal session is no longer active.',
  });

  const readOnly = new PgPortalConversionInboxCommandService(dependencies({
    accessReader: { load: async () => access({ canWrite: false, canManage: false }) },
    commandService: counted,
  }));
  const deniedDraft = await readOnly.createDraft(identity(), {
    commandKey: 'read-only', conversationId: CONVERSATION_ID,
    contactPointId: CONTACT_POINT_ID, body: 'Exact draft body',
  });
  assert.equal(deniedDraft.ok, false);
  if (!deniedDraft.ok) assert.equal(deniedDraft.kind, 'forbidden');

  const writer = new PgPortalConversionInboxCommandService(dependencies({
    accessReader: { load: async () => access({ canManage: false }) },
    commandService: counted,
  }));
  const deniedDecision = await writer.decideApproval(identity(), {
    commandKey: 'writer-decision', approvalRequestId: APPROVAL_REQUEST_ID,
    decision: 'approved',
  });
  const deniedQueue = await writer.queueApprovedMessage(identity(), {
    commandKey: 'writer-queue', messageId: MESSAGE_ID,
    expectedRowVersion: '4', purpose: 'marketing',
  });
  assert.equal(deniedDecision.ok, false);
  assert.equal(deniedQueue.ok, false);
  if (!deniedDecision.ok) assert.equal(deniedDecision.kind, 'forbidden');
  if (!deniedQueue.ok) assert.equal(deniedQueue.kind, 'forbidden');
  assert.equal(mutations, 0);
});

test('portal rejects non-canonical browser row versions before resolving or mutating', async () => {
  let resolutions = 0;
  let mutations = 0;
  const service = new PgPortalConversionInboxCommandService(dependencies({
    principalResolver: {
      resolve: async () => {
        resolutions += 1;
        return { userId: USER_ID, workspaceId: WORKSPACE_ID };
      },
    },
    commandService: commandService({
      reviseDraft: async () => { mutations += 1; return messageResult(); },
      requestApproval: async () => {
        mutations += 1;
        return {
          ...messageResult(), approvalRequestId: APPROVAL_REQUEST_ID, requestNumber: 1,
        };
      },
      queueApprovedMessage: async () => {
        mutations += 1;
        return {
          ...messageResult(), providerOperationId: PROVIDER_OPERATION_ID,
          messageDeliveryId: MESSAGE_DELIVERY_ID, consentEventId: CONSENT_EVENT_ID,
        };
      },
    }),
  }));
  const revise = await service.reviseDraft(identity(), {
    commandKey: 'bad-revise', messageId: MESSAGE_ID,
    expectedRowVersion: '01', body: 'Exact draft body',
  });
  const request = await service.requestApproval(identity(), {
    commandKey: 'bad-request', messageId: MESSAGE_ID,
    expectedRowVersion: ' 2 ',
  });
  const queue = await service.queueApprovedMessage(identity(), {
    commandKey: 'bad-queue', messageId: MESSAGE_ID,
    expectedRowVersion: '9007199254740992', purpose: 'marketing',
  });
  for (const outcome of [revise, request, queue]) {
    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.equal(outcome.kind, 'validation');
  }
  assert.equal(resolutions, 0);
  assert.equal(mutations, 0);
});

test('portal create and revise enforce the complete-review cap in UTF-8 bytes', async () => {
  let resolutions = 0;
  let mutations = 0;
  const service = new PgPortalConversionInboxCommandService(dependencies({
    principalResolver: {
      resolve: async () => {
        resolutions += 1;
        return { userId: USER_ID, workspaceId: WORKSPACE_ID };
      },
    },
    commandService: commandService({
      createDraft: async () => { mutations += 1; return messageResult(); },
      reviseDraft: async () => { mutations += 1; return messageResult(); },
    }),
  }));
  const outsideBoundary = '🐆'.repeat(2_049);
  assert.ok(outsideBoundary.length < 8_192);
  assert.equal(Buffer.byteLength(outsideBoundary, 'utf8'), 8_196);

  const created = await service.createDraft(identity(), {
    commandKey: 'multibyte-create-too-large',
    conversationId: CONVERSATION_ID,
    contactPointId: CONTACT_POINT_ID,
    body: outsideBoundary,
  });
  const revised = await service.reviseDraft(identity(), {
    commandKey: 'multibyte-revise-too-large',
    messageId: MESSAGE_ID,
    expectedRowVersion: '1',
    body: outsideBoundary,
  });
  for (const outcome of [created, revised]) {
    assert.equal(outcome.ok, false);
    if (outcome.ok) continue;
    assert.equal(outcome.kind, 'validation');
    assert.match(outcome.message, /8,192 UTF-8 bytes/);
    assert.match(outcome.message, /complete immutable copy can be reviewed/);
  }
  assert.equal(resolutions, 0);
  assert.equal(mutations, 0);

  const exactBoundary = '🐆'.repeat(2_048);
  assert.equal(Buffer.byteLength(exactBoundary, 'utf8'), 8_192);
  const accepted = await service.createDraft(identity(), {
    commandKey: 'multibyte-create-at-boundary',
    conversationId: CONVERSATION_ID,
    contactPointId: CONTACT_POINT_ID,
    body: exactBoundary,
  });
  assert.equal(accepted.ok, true);
  assert.equal(resolutions, 1);
  assert.equal(mutations, 1);
});

test('portal maps durable inbox conflicts and consent refusal to safe outcomes', async (t) => {
  const cases: readonly [Error, string][] = [
    [new InboxValidationError('raw validation'), 'validation'],
    [new InboxNotFoundError('raw entity'), 'not_found'],
    [new InboxIdempotencyConflictError(), 'idempotency_conflict'],
    [new InboxCommandInProgressError(), 'command_in_progress'],
    [new InboxVersionConflictError('raw version'), 'version_conflict'],
    [new InboxConsentBlockedError('raw suppression details'), 'consent_blocked'],
  ];
  for (const [error, kind] of cases) {
    await t.test(kind, async () => {
      const service = new PgPortalConversionInboxCommandService(dependencies({
        commandService: commandService({
          queueApprovedMessage: async () => { throw error; },
        }),
      }));
      const outcome = await service.queueApprovedMessage(identity(), {
        commandKey: `error-${kind}`, messageId: MESSAGE_ID,
        expectedRowVersion: '4', purpose: 'marketing',
      });
      assert.equal(outcome.ok, false);
      if (outcome.ok) return;
      assert.equal(outcome.kind, kind);
      assert.doesNotMatch(outcome.message, /raw|suppression details/i);
    });
  }
});

test('portal preserves command keys for backend idempotency instead of inventing browser state', async () => {
  const keys: string[] = [];
  const service = new PgPortalConversionInboxCommandService(dependencies({
    commandService: commandService({
      createDraft: async (_context, input) => {
        keys.push(input.commandKey);
        return messageResult({ disposition: keys.length === 1 ? 'applied' : 'replayed' });
      },
    }),
  }));
  const input = {
    commandKey: 'portal-stable-idempotency-key',
    conversationId: CONVERSATION_ID,
    contactPointId: CONTACT_POINT_ID,
    body: 'Exact draft body',
  };
  const first = await service.createDraft(identity(), input);
  const second = await service.createDraft(identity(), input);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (first.ok && second.ok) {
    assert.equal(first.disposition, 'applied');
    assert.equal(second.disposition, 'replayed');
  }
  assert.deepEqual(keys, [input.commandKey, input.commandKey]);
});

test('workspace access reader performs one bounded read-only RLS query and fails closed on malformed rows', async () => {
  let rows: Record<string, unknown>[] = [{
    workspaceId: WORKSPACE_ID.toUpperCase(), canWrite: true, canManage: false,
  }];
  const calls: Array<{ sql: string; options: unknown }> = [];
  const runner: InboxTransactionRunner = {
    async run(context, operation, options) {
      assert.equal(context.workspaceId, WORKSPACE_ID);
      calls.push({ sql: '', options });
      const executor: SqlExecutor = {
        async query<T extends Record<string, unknown>>(sql: string) {
          calls[calls.length - 1]!.sql = sql;
          return { rows: rows as T[], rowCount: rows.length };
        },
      };
      return operation(executor);
    },
  };
  const reader = new PgPortalConversionInboxWorkspaceAccessReader(runner);
  const context: DatabaseRequestContext = {
    actorKind: 'user', userId: USER_ID, workspaceId: WORKSPACE_ID,
    requestId: 'access-reader', portalSessionTokenHash: Buffer.alloc(32, 5),
  };
  assert.deepEqual(await reader.load(context), {
    workspaceId: WORKSPACE_ID, canWrite: true, canManage: false,
  });
  assert.deepEqual(calls[0]!.options, { readOnly: true });
  assert.match(calls[0]!.sql, /current_workspace_id/);
  assert.match(calls[0]!.sql, /can_write_workspace/);
  assert.match(calls[0]!.sql, /can_manage_workspace/);

  rows = [{ workspaceId: WORKSPACE_ID, canWrite: 'true', canManage: false }];
  await assert.rejects(reader.load(context), /returned invalid data/);
  rows = [
    { workspaceId: WORKSPACE_ID, canWrite: true, canManage: true },
    { workspaceId: WORKSPACE_ID, canWrite: true, canManage: true },
  ];
  await assert.rejects(reader.load(context), /returned more than once/);
});

test('operational portal surface exposes durable commands but no dispatcher or network method', () => {
  const service = new PgPortalConversionInboxCommandService(dependencies());
  const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(service)).sort();
  assert.deepEqual(methods, [
    'constructor',
    'createDraft',
    'decideApproval',
    'queueApprovedMessage',
    'requestApproval',
    'reviseDraft',
  ]);
  assert.equal('dispatch' in service, false);
  assert.equal('sendMessage' in service, false);
  assert.equal('connectProvider' in service, false);
});
