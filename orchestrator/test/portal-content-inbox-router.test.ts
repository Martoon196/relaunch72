import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import type { PortalAuthService } from '../src/portal/auth-service.js';
import type { PortalCompanyContentService } from '../src/portal/company-content-service.js';
import { createPropertyPredatorContentCatalogFixture } from '../src/portal/content-control-room-fixtures.js';
import { createPropertyPredatorTestInboxSnapshot } from '../src/portal/conversion-inbox-fixtures.js';
import type { PortalCrmService } from '../src/portal/crm-service.js';
import { PROPERTY_PREDATOR_GROWTH_PROFILE } from '../src/portal/product-profile.js';
import {
  handlePortal,
  type PortalInboxReadBoundary,
  type PostgresPortalDeps,
} from '../src/portal/router.js';
import { PORTAL_COOKIE } from '../src/portal/session.js';
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

test('Content Control renders the immutable catalogue with bounded local filters and no mutation surface', async () => {
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
  assert.match(result.body, /Eligible is not published/);
  assert.doesNotMatch(result.body, /Publish now|Schedule now|Connect provider|action="\/portal\/content\//i);
  assert.deepEqual(queries, [{
    identity: { sessionToken: SESSION, requestId: 'router-request-1' },
    query: { limit: 100 },
  }]);
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
  assert.match(result.body, /Nothing here has contacted a real person/);
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
