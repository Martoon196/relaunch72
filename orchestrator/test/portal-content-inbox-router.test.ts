import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import type { PortalAuthService } from '../src/portal/auth-service.js';
import type { PortalCompanyContentService } from '../src/portal/company-content-service.js';
import { createPropertyPredatorContentCatalogFixture } from '../src/portal/content-control-room-fixtures.js';
import { createPropertyPredatorTestInboxSnapshot } from '../src/portal/conversion-inbox-fixtures.js';
import type { PortalConversionInboxCommandService } from '../src/portal/conversion-inbox-service.js';
import type { PortalCrmService } from '../src/portal/crm-service.js';
import { PROPERTY_PREDATOR_GROWTH_PROFILE } from '../src/portal/product-profile.js';
import {
  handlePortal,
  type PortalInboxReadBoundary,
  type PostgresPortalDeps,
} from '../src/portal/router.js';
import { PORTAL_COOKIE, portalCsrfToken } from '../src/portal/session.js';
import type { InboxConversationQuery } from '../src/inbox-pg/read-model.js';

const SECRET = 'content-inbox-router-secret';
const SESSION = Buffer.alloc(32, 17).toString('base64url');
const WORKSPACE_ID = '70000000-0000-4000-8000-000000000001';
const COOKIE = `${PORTAL_COOKIE}=${SESSION}`;
const fixture = createPropertyPredatorTestInboxSnapshot();

const auth: PortalAuthService = {
  resolve: async (token) => token === SESSION ? {
    sessionToken: token,
    userId: '71000000-0000-4000-8000-000000000001',
    userEmail: 'owner@example.test',
    workspaceId: WORKSPACE_ID,
  } : null,
  login: async () => null,
  revoke: async () => undefined,
};

const crm: PortalCrmService = {
  snapshot: async () => ({
    workspace: {
      id: WORKSPACE_ID,
      name: 'Property Predator Growth HQ',
      timezone: 'Europe/London',
      snapshotAt: '2026-08-26T08:42:00.000Z',
      canWrite: true,
    },
    contacts: [], stages: [], opportunities: [], tasks: [], timeline: [],
  }),
  workspaceShell: async () => ({
    workspace: {
      id: WORKSPACE_ID,
      name: 'Property Predator Growth HQ',
      timezone: 'Europe/London',
      snapshotAt: '2026-08-26T08:42:00.000Z',
      canWrite: true,
    },
  }),
  createLead: async () => ({ ok: false, kind: 'unavailable', message: 'not used' }),
  moveOpportunity: async () => ({ ok: false, kind: 'unavailable', message: 'not used' }),
  completeTask: async () => ({ ok: false, kind: 'unavailable', message: 'not used' }),
};

function postgres(over: Partial<PostgresPortalDeps> = {}): PostgresPortalDeps {
  return {
    kind: 'postgres',
    sessionSecret: SECRET,
    secure: false,
    now: () => 1_000_000,
    requestId: () => 'router-request-1',
    productProfile: PROPERTY_PREDATOR_GROWTH_PROFILE,
    auth,
    crm,
    ...over,
  };
}

function request(url: string, cookie?: string) {
  const req = new EventEmitter() as EventEmitter & {
    method: string;
    url: string;
    headers: Record<string, string>;
  };
  req.method = 'GET';
  req.url = url;
  req.headers = cookie ? { cookie } : {};
  queueMicrotask(() => req.emit('end'));
  return req;
}

function postRequest(url: string, fields: Readonly<Record<string, string>>, cookie?: string) {
  const body = new URLSearchParams(fields).toString();
  const req = new EventEmitter() as EventEmitter & {
    method: string;
    url: string;
    headers: Record<string, string>;
  };
  req.method = 'POST';
  req.url = url;
  req.headers = {
    ...(cookie ? { cookie } : {}),
    'content-type': 'application/x-www-form-urlencoded',
    'content-length': String(Buffer.byteLength(body)),
  };
  setImmediate(() => {
    req.emit('data', Buffer.from(body));
    req.emit('end');
  });
  return req;
}

function response() {
  return {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: '',
    writeHead(code: number, headers?: Record<string, string | string[]>) {
      this.statusCode = code;
      for (const [key, value] of Object.entries(headers ?? {})) {
        this.headers[key.toLowerCase()] = Array.isArray(value) ? value.join('\n') : value;
      }
      return this;
    },
    end(body?: string) { if (body) this.body = body; },
  };
}

async function call(url: string, deps: PostgresPortalDeps, cookie?: string) {
  const res = response();
  await handlePortal(request(url, cookie) as never, res as never, deps);
  return res;
}

async function post(
  url: string,
  fields: Readonly<Record<string, string>>,
  deps: PostgresPortalDeps,
  cookie?: string,
) {
  const res = response();
  await handlePortal(postRequest(url, fields, cookie) as never, res as never, deps);
  return res;
}

function contentService(
  snapshot: PortalCompanyContentService['snapshot'],
): PortalCompanyContentService {
  return {
    snapshot,
    requestApproval: async () => ({
      ok: false, kind: 'unavailable', message: 'No write route exists here.',
    }),
    decideApproval: async () => ({
      ok: false, kind: 'unavailable', message: 'No write route exists here.',
    }),
  };
}

test('Content and Inbox stay authenticated and unavailable modules grant no shell capability', async () => {
  const unauthenticated = await call('/portal/content', postgres());
  assert.equal(unauthenticated.statusCode, 302);
  assert.equal(unauthenticated.headers.location, '/portal/login');

  const missingContent = await call('/portal/content', postgres(), COOKIE);
  assert.equal(missingContent.statusCode, 404);
  assert.match(missingContent.body, /Content Control not connected/);
  assert.doesNotMatch(missingContent.body, /<a class="nav-item" href="\/portal\/content"/);

  const missingInbox = await call('/portal/inbox', postgres(), COOKIE);
  assert.equal(missingInbox.statusCode, 404);
  assert.match(missingInbox.body, /TEST\/SIMULATED conversation read service is not enabled/);
  assert.doesNotMatch(missingInbox.body, /<a class="nav-item" href="\/portal\/inbox"/);
});

test('Content Control renders the immutable catalogue with bounded filters and protected approval controls', async () => {
  const queries: unknown[] = [];
  const companyContent = contentService(async (identity, query) => {
    queries.push({ identity, query });
    return {
      ok: true,
      snapshot: {
        workspace: {
          workspaceId: WORKSPACE_ID,
          workspaceName: 'Property Predator Growth HQ',
          snapshotAt: '2026-08-26T08:42:00.000Z',
          canWrite: true,
          canManage: true,
        },
        catalog: createPropertyPredatorContentCatalogFixture(),
      },
    };
  });
  const result = await call(
    '/portal/content?q=follow-up&channel=email&format=email',
    postgres({ companyContent }),
    COOKIE,
  );

  assert.equal(result.statusCode, 200);
  assert.match(result.body, /Growth HQ · Content control/);
  assert.match(result.body, /Predator Briefing: mixed-use intelligence follow-up/);
  assert.doesNotMatch(result.body, /The postcode is not the opportunity/);
  assert.match(result.body, /href="\/portal\/content" aria-current="page"/);
  assert.match(result.body, /Exact review is available; outbound remains separate/);
  assert.match(result.body, /action="\/portal\/content\/approval-decisions"/);
  assert.match(result.body, /name="approval_request_id"/);
  assert.match(result.body, /name="_csrf"/);
  assert.doesNotMatch(result.body, /Publish now|Schedule now|Connect provider/i);
  assert.deepEqual(queries, [{
    identity: { sessionToken: SESSION, requestId: 'router-request-1' },
    query: { limit: 100 },
  }]);
});

test('Content approval POSTs are CSRF-bound, workspace-derived and preserve filtered return context', async () => {
  const calls: unknown[] = [];
  const companyContent: PortalCompanyContentService = {
    snapshot: async () => ({ ok: false, kind: 'unavailable', message: 'not used' }),
    requestApproval: async (identity, input) => {
      calls.push({ action: 'request', identity, input });
      return {
        ok: true, disposition: 'applied',
        approvalRequestId: '73000000-0000-4000-8000-000000000001',
        contentItemId: input.contentItemId,
        contentVersionId: input.contentVersionId,
        requestNumber: 1,
        contentSha256: '11'.repeat(32),
      };
    },
    decideApproval: async (identity, input) => {
      calls.push({ action: 'decide', identity, input });
      return {
        ok: true, disposition: 'applied',
        approvalDecisionId: '74000000-0000-4000-8000-000000000001',
        approvalRequestId: input.approvalRequestId,
        contentItemId: '75000000-0000-4000-8000-000000000001',
        contentVersionId: '76000000-0000-4000-8000-000000000001',
        decision: input.decision,
        contentSha256: '22'.repeat(32),
      };
    },
  };
  const common = {
    _csrf: portalCsrfToken(SECRET, SESSION),
    return_q: 'briefing',
    return_channel: 'email',
    return_format: 'email',
    return_anchor: 'ccr-content-2',
  };
  const requested = await post('/portal/content/approval-requests', {
    ...common,
    command_key: 'request-command-00000001',
    content_item_id: '75000000-0000-4000-8000-000000000001',
    content_version_id: '76000000-0000-4000-8000-000000000001',
    review_note: 'Check the exact Property Predator promise.',
    workspace_id: 'attacker-workspace',
  }, postgres({ companyContent }), COOKIE);
  assert.equal(requested.statusCode, 303);
  const requestedLocation = requested.headers.location ?? '';
  assert.match(requestedLocation, /^\/portal\/content\?notice=requested\./);
  assert.match(requestedLocation, /q=briefing/);
  assert.match(requestedLocation, /channel=email/);
  assert.match(requestedLocation, /format=email/);
  assert.match(requestedLocation, /#ccr-content-2$/);

  const decided = await post('/portal/content/approval-decisions', {
    ...common,
    command_key: 'decision-command-00000001',
    approval_request_id: '73000000-0000-4000-8000-000000000001',
    decision: 'changes_requested',
    decision_note: 'Replace the unsupported superlative.',
  }, postgres({ companyContent }), COOKIE);
  assert.equal(decided.statusCode, 303);
  assert.match(decided.headers.location ?? '', /^\/portal\/content\?notice=changes_requested\./);
  assert.deepEqual(calls, [{
    action: 'request',
    identity: { sessionToken: SESSION, requestId: 'router-request-1' },
    input: {
      commandKey: 'request-command-00000001',
      contentItemId: '75000000-0000-4000-8000-000000000001',
      contentVersionId: '76000000-0000-4000-8000-000000000001',
      reviewNote: 'Check the exact Property Predator promise.',
    },
  }, {
    action: 'decide',
    identity: { sessionToken: SESSION, requestId: 'router-request-1' },
    input: {
      commandKey: 'decision-command-00000001',
      approvalRequestId: '73000000-0000-4000-8000-000000000001',
      decision: 'changes_requested',
      decisionNote: 'Replace the unsupported superlative.',
    },
  }]);
});

test('Content approval POSTs fail closed before commands on missing CSRF, invalid decisions or unavailable review content', async () => {
  let commands = 0;
  const companyContent = contentService(async () => ({
    ok: false, kind: 'unavailable', message: 'not used',
  }));
  companyContent.requestApproval = async () => {
    commands += 1;
    return { ok: false, kind: 'unavailable', message: 'must not run' };
  };
  companyContent.decideApproval = async () => {
    commands += 1;
    return { ok: false, kind: 'unavailable', message: 'must not run' };
  };
  const missingCsrf = await post('/portal/content/approval-requests', {
    command_key: 'request-command-00000001',
    content_item_id: '75000000-0000-4000-8000-000000000001',
    content_version_id: '76000000-0000-4000-8000-000000000001',
  }, postgres({ companyContent }), COOKIE);
  assert.equal(missingCsrf.statusCode, 303);
  assert.match(missingCsrf.headers.location ?? '', /^\/portal\/content\?notice=invalid\./);

  const invalidDecision = await post('/portal/content/approval-decisions', {
    _csrf: portalCsrfToken(SECRET, SESSION),
    command_key: 'decision-command-00000001',
    approval_request_id: '73000000-0000-4000-8000-000000000001',
    decision: 'publish_now',
  }, postgres({ companyContent }), COOKIE);
  assert.equal(invalidDecision.statusCode, 303);
  assert.match(invalidDecision.headers.location ?? '', /^\/portal\/content\?notice=invalid\./);

  const forgedApproval = await post('/portal/content/approval-decisions', {
    _csrf: portalCsrfToken(SECRET, SESSION),
    command_key: 'decision-command-00000002',
    approval_request_id: '73000000-0000-4000-8000-000000000001',
    decision: 'approved',
  }, postgres({ companyContent }), COOKIE);
  assert.equal(forgedApproval.statusCode, 303);
  assert.match(
    forgedApproval.headers.location ?? '',
    /^\/portal\/content\?notice=review_unavailable\./,
  );
  assert.equal(commands, 0);
});

test('Content Control maps safe read failures without exposing a catalogue or provider controls', async () => {
  const companyContent = contentService(async () => ({
    ok: false,
    kind: 'unavailable',
    message: 'The company content catalogue is temporarily unavailable.',
  }));
  const result = await call('/portal/content', postgres({ companyContent }), COOKIE);
  assert.equal(result.statusCode, 503);
  assert.match(result.body, /company content catalogue is temporarily unavailable/);
  assert.doesNotMatch(result.body, /Version catalogue|Publish now|Schedule now/);
});

test('Conversion Inbox passes bounded filters, loads only the selected visible thread and stays simulated', async () => {
  const queries: InboxConversationQuery[] = [];
  const threadCalls: string[] = [];
  const inbox: PortalInboxReadBoundary = {
    listConversations: async (_identity, query = {}) => {
      queries.push(query);
      return fixture.page;
    },
    thread: async (_identity, conversationId) => {
      threadCalls.push(conversationId);
      return fixture.threads.find((item) => item.conversationId === conversationId) ?? null;
    },
  };
  const selectedId = fixture.page.conversations[1]!.conversationId;
  const result = await call(
    `/portal/inbox?q=Priya&channel=whatsapp&queue=open&conversation=${selectedId}`,
    postgres({ inbox }),
    COOKIE,
  );

  assert.equal(result.statusCode, 200);
  assert.match(result.body, /Growth HQ · Conversion Inbox/);
  assert.match(result.body, /Priya Nair/);
  assert.doesNotMatch(result.body, /Aisha Rahman/);
  assert.match(result.body, /TEST \/ SIMULATED/);
  assert.match(result.body, /Contact records may be workspace CRM data/);
  assert.match(result.body, /no message here has contacted anyone/);
  assert.match(result.body, /aria-label="TEST rail activity: Queued for simulator"/);
  assert.match(result.body, /data-rail-state="queued"/);
  assert.match(result.body, /Trace TEST 91000000…0002/);
  assert.doesNotMatch(result.body, /91000000-0000-4000-8000-000000000002/);
  assert.match(result.body, /href="\/portal\/inbox" aria-current="page"/);
  assert.doesNotMatch(result.body, /action="[^"]*(?:send|deliver|publish)/i);
  assert.deepEqual(queries, [{
    limit: 50,
    channel: 'whatsapp',
    state: 'open',
    search: 'Priya',
  }]);
  assert.deepEqual(threadCalls, [selectedId]);
});

test('Conversion Inbox routes signed LinkedIn social projections read-only and generates no action controls', async () => {
  const summary = fixture.page.conversations[0]!;
  const baseThread = fixture.threads[0]!;
  const inbound = baseThread.messages.find((message) => message.direction === 'inbound')!;
  const linkedInSummary = {
    ...summary,
    channel: 'linkedin' as const,
    environment: 'live' as const,
    subject: 'LinkedIn owned-post comment',
    requiresApproval: false,
  };
  const linkedInThread = {
    ...baseThread,
    environment: 'live' as const,
    messages: [{
      ...inbound,
      inboundEvidence: {
        kind: 'signed_zernio_inbound' as const,
        source: 'zernio' as const,
        network: 'linkedin' as const,
        receiptId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        verifiedAt: '2026-08-26T08:37:01.000Z',
      },
    }],
    consents: [{
      channel: 'social' as const, state: 'permitted' as const,
      basis: 'Existing social evidence', updatedAt: '2026-08-26T08:00:00.000Z',
    }],
  };
  const queries: InboxConversationQuery[] = [];
  const inbox: PortalInboxReadBoundary = {
    listConversations: async (_identity, query = {}) => {
      queries.push(query);
      return { ...fixture.page, conversations: [linkedInSummary] };
    },
    thread: async () => linkedInThread,
  };
  const result = await call(
    `/portal/inbox?channel=linkedin&conversation=${summary.conversationId}`,
    postgres({
      inbox,
      inboxCommands: {} as PortalConversionInboxCommandService,
      inboxOperations: {} as never,
    }),
    COOKIE,
  );

  assert.equal(result.statusCode, 200);
  assert.deepEqual(queries, [{
    limit: 50, channel: 'linkedin', state: null, search: null,
  }]);
  assert.match(result.body, /LinkedIn · LIVE SOCIAL READ-ONLY/);
  assert.match(result.body, /Evidence visible · actions unavailable/);
  assert.match(result.body, /Signed social inbound · LI/);
  assert.doesNotMatch(result.body, /zernio/i);
  assert.doesNotMatch(result.body, /Open Action Centre|Create TEST draft|Queue TEST operation/);
  assert.doesNotMatch(result.body, /\/assignment|\/internal-notes|\/admin-calls|\/test-queue/);
  assert.doesNotMatch(result.body, /cccccccc-cccc-4ccc-8ccc-cccccccccccc/);
});

test('canonical Conversion Inbox approval queue selects a summary backed by an undecided exact approval', async () => {
  const threadCalls: string[] = [];
  const inbox: PortalInboxReadBoundary = {
    listConversations: async () => fixture.page,
    thread: async (_identity, conversationId) => {
      threadCalls.push(conversationId);
      return fixture.threads.find((item) => item.conversationId === conversationId) ?? null;
    },
  };

  const result = await call('/portal/inbox?queue=approval', postgres({ inbox }), COOKIE);
  const approvalConversationId = fixture.page.conversations[0]!.conversationId;

  assert.equal(result.statusCode, 200);
  assert.match(result.body, /Aisha Rahman/);
  assert.match(result.body, /Approval pending/);
  assert.doesNotMatch(result.body, /Priya Nair|Sophie Grant|Liam Carter/);
  assert.deepEqual(threadCalls, [approvalConversationId]);
});

test('Conversion Inbox exposes protected draft, approval and TEST queue controls only when command service is composed', async () => {
  const inbox: PortalInboxReadBoundary = {
    listConversations: async () => fixture.page,
    thread: async (_identity, conversationId) => {
      const thread = fixture.threads.find((item) => item.conversationId === conversationId) ?? null;
      return thread?.conversationId === fixture.threads[3]!.conversationId
        ? { ...thread, draft: { ...thread.draft, purpose: 'marketing' } }
        : thread;
    },
  };
  const commands = {
    createDraft: async () => ({ ok: false as const, kind: 'unavailable' as const, message: 'not used' }),
    reviseDraft: async () => ({ ok: false as const, kind: 'unavailable' as const, message: 'not used' }),
    requestApproval: async () => ({ ok: false as const, kind: 'unavailable' as const, message: 'not used' }),
    decideApproval: async () => ({ ok: false as const, kind: 'unavailable' as const, message: 'not used' }),
    queueApprovedMessage: async () => ({ ok: false as const, kind: 'unavailable' as const, message: 'not used' }),
  } satisfies PortalConversionInboxCommandService;

  const liam = fixture.threads[4]!;
  const draftResult = await call(
    `/portal/inbox?channel=facebook&conversation=${liam.conversationId}`,
    postgres({ inbox, inboxCommands: commands }),
    COOKIE,
  );
  assert.equal(draftResult.statusCode, 200);
  assert.match(draftResult.body, /action="\/portal\/inbox\/messages\/60000000-0000-4000-8000-000000000005\/versions"/);
  assert.match(draftResult.body, /action="\/portal\/inbox\/messages\/60000000-0000-4000-8000-000000000005\/approval-requests"/);
  assert.match(draftResult.body, /name="_csrf"/);

  const sophie = fixture.threads[3]!;
  const queueResult = await call(
    `/portal/inbox?channel=sms&conversation=${sophie.conversationId}`,
    postgres({ inbox, inboxCommands: commands }),
    COOKIE,
  );
  assert.match(queueResult.body, /action="\/portal\/inbox\/messages\/60000000-0000-4000-8000-000000000004\/test-queue"/);
  assert.match(queueResult.body, /name="purpose" value="marketing"/);
  assert.match(queueResult.body, /Queue TEST operation/);
  assert.doesNotMatch(queueResult.body, /action="[^"]*(?:send|deliver|publish)/i);
});

test('Conversion Inbox POSTs are CSRF-bound, workspace-derived and preserve return context', async () => {
  const calls: unknown[] = [];
  const messageSuccess = (messageId: string, lifecycle: 'draft' | 'approval_pending' | 'approved') => ({
    ok: true as const,
    disposition: 'applied' as const,
    conversationId: fixture.threads[0]!.conversationId,
    messageId,
    messageVersionId: '81000000-0000-4000-8000-000000000001',
    versionNumber: 2,
    bodySha256: '11'.repeat(32),
    lifecycle,
    rowVersion: 2,
  });
  const inboxCommands: PortalConversionInboxCommandService = {
    createDraft: async (identity, input) => {
      calls.push({ action: 'create', identity, input });
      return messageSuccess('60000000-0000-4000-8000-000000000009', 'draft');
    },
    reviseDraft: async (identity, input) => {
      calls.push({ action: 'revise', identity, input });
      return messageSuccess(input.messageId, 'draft');
    },
    requestApproval: async (identity, input) => {
      calls.push({ action: 'request', identity, input });
      return {
        ...messageSuccess(input.messageId, 'approval_pending'),
        approvalRequestId: '80000000-0000-4000-8000-000000000009',
        requestNumber: 1,
      };
    },
    decideApproval: async (identity, input) => {
      calls.push({ action: 'decide', identity, input });
      return {
        ...messageSuccess('60000000-0000-4000-8000-000000000001', 'approved'),
        approvalRequestId: input.approvalRequestId,
        approvalDecisionId: '82000000-0000-4000-8000-000000000001',
        decision: input.decision,
      };
    },
    queueApprovedMessage: async (identity, input) => {
      calls.push({ action: 'queue', identity, input });
      return {
        ...messageSuccess(input.messageId, 'approved'),
        providerOperationId: '83000000-0000-4000-8000-000000000001',
        messageDeliveryId: '84000000-0000-4000-8000-000000000001',
        consentEventId: '85000000-0000-4000-8000-000000000001',
        environment: 'test',
        provider: 'test_conversation',
      };
    },
  };
  const common = {
    _csrf: portalCsrfToken(SECRET, SESSION),
    return_q: 'Predator',
    return_channel: 'facebook',
    return_queue: 'open',
    return_conversation: fixture.threads[4]!.conversationId,
    workspace_id: 'attacker-workspace',
    user_id: 'attacker-user',
  };
  const deps = postgres({ inboxCommands });

  const created = await post('/portal/inbox/drafts', {
    ...common,
    command_key: 'create-command-1',
    conversation_id: fixture.threads[4]!.conversationId,
    contact_point_id: fixture.threads[4]!.contactPointId!,
    body: 'Create a protected TEST draft.',
  }, deps, COOKIE);
  assert.equal(created.statusCode, 303);
  assert.match(created.headers.location ?? '', /^\/portal\/inbox\?notice=draft_created\./);

  const revised = await post('/portal/inbox/messages/60000000-0000-4000-8000-000000000005/versions', {
    ...common, command_key: 'revise-command-1', expected_row_version: '1', body: 'Revised body.',
  }, deps, COOKIE);
  assert.match(revised.headers.location ?? '', /^\/portal\/inbox\?notice=draft_saved\./);

  const requested = await post('/portal/inbox/messages/60000000-0000-4000-8000-000000000005/approval-requests', {
    ...common, command_key: 'request-command-1', expected_row_version: '1', review_note: 'Check this exact copy.',
  }, deps, COOKIE);
  assert.match(requested.headers.location ?? '', /^\/portal\/inbox\?notice=approval_requested\./);

  const decided = await post('/portal/inbox/approval-requests/80000000-0000-4000-8000-000000000001/decisions', {
    ...common, command_key: 'decision-command-1', decision: 'approved', decision_note: 'Approved for TEST queue only.',
  }, deps, COOKIE);
  assert.match(decided.headers.location ?? '', /^\/portal\/inbox\?notice=approved\./);

  const queued = await post('/portal/inbox/messages/60000000-0000-4000-8000-000000000004/test-queue', {
    ...common, command_key: 'queue-command-1', expected_row_version: '2', purpose: 'marketing',
  }, deps, COOKIE);
  const queuedLocation = queued.headers.location ?? '';
  assert.match(queuedLocation, /^\/portal\/inbox\?notice=test_queued\./);
  assert.match(queuedLocation, /q=Predator/);
  assert.match(queuedLocation, /channel=facebook/);
  assert.match(queuedLocation, /queue=open/);
  assert.match(queuedLocation, /conversation=10000000-0000-4000-8000-000000000005/);

  assert.equal(calls.length, 5);
  for (const callValue of calls) {
    const record = callValue as { identity: unknown; input: Record<string, unknown> };
    assert.deepEqual(record.identity, { sessionToken: SESSION, requestId: 'router-request-1' });
    assert.equal('workspaceId' in record.input, false);
    assert.equal('workspace_id' in record.input, false);
    assert.equal('userId' in record.input, false);
    assert.equal('user_id' in record.input, false);
  }
});

test('Conversion Inbox commands fail closed before mutation on missing CSRF, invalid route ids or live-like purposes', async () => {
  let commandCount = 0;
  const unavailable = async () => {
    commandCount += 1;
    return { ok: false as const, kind: 'unavailable' as const, message: 'must not run' };
  };
  const inboxCommands: PortalConversionInboxCommandService = {
    createDraft: unavailable,
    reviseDraft: unavailable,
    requestApproval: unavailable,
    decideApproval: unavailable,
    queueApprovedMessage: unavailable,
  };
  const deps = postgres({ inboxCommands });
  const missingCsrf = await post('/portal/inbox/messages/60000000-0000-4000-8000-000000000005/versions', {
    command_key: 'revise-command-1', expected_row_version: '1', body: 'No token.',
  }, deps, COOKIE);
  assert.equal(missingCsrf.statusCode, 303);
  assert.match(missingCsrf.headers.location ?? '', /^\/portal\/inbox\?notice=invalid\./);

  const invalidPurpose = await post('/portal/inbox/messages/60000000-0000-4000-8000-000000000004/test-queue', {
    _csrf: portalCsrfToken(SECRET, SESSION), command_key: 'queue-command-1',
    expected_row_version: '2', purpose: 'marketing_live_blast',
  }, deps, COOKIE);
  assert.match(invalidPurpose.headers.location ?? '', /^\/portal\/inbox\?notice=invalid\./);
  assert.equal(commandCount, 0);
});

test('a forged oversized approval POST preserves the backend review-boundary failure', async () => {
  const exactImmutableBody = 'x'.repeat(8_193);
  let decisionCalls = 0;
  const unavailable = async () => ({
    ok: false as const, kind: 'unavailable' as const, message: 'not used',
  });
  const inboxCommands: PortalConversionInboxCommandService = {
    createDraft: unavailable,
    reviseDraft: unavailable,
    requestApproval: unavailable,
    decideApproval: async (_identity, input) => {
      decisionCalls += 1;
      assert.equal(input.decision, 'approved');
      assert.ok(Buffer.byteLength(exactImmutableBody, 'utf8') > 8_192);
      return {
        ok: false as const,
        kind: 'validation' as const,
        message: 'The exact immutable draft is outside the complete review boundary.',
      };
    },
    queueApprovedMessage: unavailable,
  };

  const result = await post(
    '/portal/inbox/approval-requests/80000000-0000-4000-8000-000000000001/decisions',
    {
      _csrf: portalCsrfToken(SECRET, SESSION),
      command_key: 'forged-oversized-approval',
      decision: 'approved',
      decision_note: 'Attempted outside the rendered approval control.',
    },
    postgres({ inboxCommands }),
    COOKIE,
  );

  assert.equal(decisionCalls, 1);
  assert.equal(result.statusCode, 303);
  assert.match(result.headers.location ?? '', /^\/portal\/inbox\?notice=invalid\./);
  assert.doesNotMatch(result.headers.location ?? '', /notice=approved\./);
});

test('Conversion Inbox never invents detail and discards a mismatched thread projection', async () => {
  const requestedId = fixture.page.conversations[0]!.conversationId;
  const mismatched = fixture.threads[1]!;
  const inbox: PortalInboxReadBoundary = {
    listConversations: async () => fixture.page,
    thread: async () => mismatched,
  };
  const result = await call(
    `/portal/inbox?conversation=${requestedId}`,
    postgres({ inbox }),
    COOKIE,
  );

  assert.equal(result.statusCode, 200);
  assert.match(result.body, /Select a loaded test conversation/);
  assert.match(result.body, /No provider is connected/);
  assert.doesNotMatch(result.body, /id="ci-reply-draft"|Thanks for watching the agency briefing/);
});

test('Conversion Inbox rejects cross-workspace pages before rendering any conversation data', async () => {
  const inbox: PortalInboxReadBoundary = {
    listConversations: async () => ({
      ...fixture.page,
      workspaceId: '72000000-0000-4000-8000-000000000001',
    }),
  };
  const result = await call('/portal/inbox', postgres({ inbox }), COOKIE);
  assert.equal(result.statusCode, 403);
  assert.match(result.body, /cannot read a matching workspace-scoped TEST conversation queue/);
  assert.doesNotMatch(result.body, /Aisha Rahman|Priya Nair|Reply draft/);
});
