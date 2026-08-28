import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import {
  COMPANY_CONTENT_EMAIL_DRAFT_MIME_TYPE,
  COMPANY_CONTENT_EMAIL_DRAFT_SCHEMA,
  type CompanyContentExactReview,
} from '../src/company-content-pg/index.js';
import type { PortalAuthService } from '../src/portal/auth-service.js';
import type { PortalCompanyContentService } from '../src/portal/company-content-service.js';
import type { PortalCrmService } from '../src/portal/crm-service.js';
import {
  OWNED_SEED_MESSAGE_APPROVAL_REQUEST_ROUTE,
  verifyOwnedSeedWorkflowToken,
} from '../src/portal/owned-seed-actions.js';
import type { PortalOwnedSeedCampaignService } from '../src/portal/owned-seed-campaign-service.js';
import type { PortalOwnedSeedMessageService } from '../src/portal/owned-seed-message-service.js';
import { PROPERTY_PREDATOR_OWNED_SEED_PROOF_SOURCE_ITEM } from '../src/portal/owned-seed-proof-email.js';
import { PROPERTY_PREDATOR_GROWTH_PROFILE } from '../src/portal/product-profile.js';
import { handlePortal, type PostgresPortalDeps } from '../src/portal/router.js';
import { PORTAL_COOKIE } from '../src/portal/session.js';

const SECRET = 'owned-seed-router-secret-with-enough-entropy';
const SESSION = Buffer.alloc(32, 51).toString('base64url');
const COOKIE = `${PORTAL_COOKIE}=${SESSION}`;
const NOW = Date.parse('2026-08-29T12:00:00.000Z');
const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const CONTENT_ITEM_ID = '22222222-2222-4222-8222-222222222222';
const CONTENT_VERSION_ID = '33333333-3333-4333-8333-333333333333';
const MESSAGE_ID = '44444444-4444-4444-8444-444444444444';
const MESSAGE_VERSION_ID = '55555555-5555-4555-8555-555555555555';

const review: CompanyContentExactReview = Object.freeze({
  contentItemId: CONTENT_ITEM_ID,
  contentVersionId: CONTENT_VERSION_ID,
  versionNumber: 1,
  isLatest: true,
  origin: 'generated',
  kind: 'email',
  title: 'Owned office delivery proof',
  contentMimeType: COMPANY_CONTENT_EMAIL_DRAFT_MIME_TYPE,
  canonicalContent: '{"bodyText":"Proof body","schema":"propertypredator.email-draft/v1","subject":"Proof subject"}',
  canonicalByteLength: 96,
  contentSha256: 'a'.repeat(64),
  source: Object.freeze({
    system: 'propertypredator.company-content',
    itemId: PROPERTY_PREDATOR_OWNED_SEED_PROOF_SOURCE_ITEM,
    version: 'operational-proof-v1',
  }),
  blobSha256: 'b'.repeat(64),
  brandSha256: 'c'.repeat(64),
  approvalRequestId: '66666666-6666-4666-8666-666666666666',
  approvalDecisionId: '77777777-7777-4777-8777-777777777777',
  approvalStatus: 'approved',
  approvalStale: false,
  email: Object.freeze({
    schema: COMPANY_CONTENT_EMAIL_DRAFT_SCHEMA,
    subject: 'Proof subject',
    bodyText: 'Proof body',
    subjectSha256: 'd'.repeat(64),
    bodySha256: 'e'.repeat(64),
  }),
  createdAt: '2026-08-29T11:55:00.000Z',
});

const auth: PortalAuthService = {
  resolve: async (token) => token === SESSION ? {
    sessionToken: token,
    userId: '88888888-8888-4888-8888-888888888888',
    userEmail: 'founder@example.test',
    workspaceId: WORKSPACE_ID,
  } : null,
  login: async () => null,
  revoke: async () => undefined,
};

const crm: PortalCrmService = {
  snapshot: async () => ({
    workspace: { id: WORKSPACE_ID, name: 'Property Predator Growth HQ', timezone: 'Europe/London', snapshotAt: new Date(NOW).toISOString(), canWrite: true },
    contacts: [], stages: [], opportunities: [], tasks: [], timeline: [],
  }),
  workspaceShell: async () => ({
    workspace: { id: WORKSPACE_ID, name: 'Property Predator Growth HQ', timezone: 'Europe/London', snapshotAt: new Date(NOW).toISOString(), canWrite: true },
  }),
  createLead: async () => ({ ok: false, kind: 'unavailable', message: 'not used' }),
  moveOpportunity: async () => ({ ok: false, kind: 'unavailable', message: 'not used' }),
  completeTask: async () => ({ ok: false, kind: 'unavailable', message: 'not used' }),
};

function companyContent(): PortalCompanyContentService {
  return {
    snapshot: async () => ({ ok: false, kind: 'unavailable', message: 'not used' }),
    review: async () => ({
      ok: true,
      snapshot: {
        workspace: { workspaceId: WORKSPACE_ID, workspaceName: 'Property Predator Growth HQ', snapshotAt: new Date(NOW).toISOString(), canWrite: true, canManage: true },
        review,
      },
    }),
    requestApproval: async () => ({ ok: false, kind: 'unavailable', message: 'not used' }),
    decideApproval: async () => ({ ok: false, kind: 'unavailable', message: 'not used' }),
  };
}

function campaign(): PortalOwnedSeedCampaignService {
  return { stage: async () => ({ ok: false, kind: 'unavailable', message: 'not used' }) };
}

function messages(input: Readonly<{
  resumeResult?: Awaited<ReturnType<PortalOwnedSeedMessageService['resume']>>;
  approvalCalls?: unknown[];
}> = {}): PortalOwnedSeedMessageService {
  return {
    resume: async () => input.resumeResult ?? ({
      ok: true,
      result: {
        messageId: MESSAGE_ID,
        messageVersionId: MESSAGE_VERSION_ID,
        companyContentVersionId: CONTENT_VERSION_ID,
        phase: 'drafted',
        approvalRequestId: null,
        subjectSha256: review.email!.subjectSha256,
        bodySha256: review.email!.bodySha256,
        sourceContentSha256: review.contentSha256,
        recipient: 'office@propertypredator.com',
      },
    }),
    createDraft: async () => ({ ok: false, kind: 'unavailable', message: 'not used' }),
    requestApproval: async (identity, command) => {
      input.approvalCalls?.push({ identity, command });
      return {
        ok: true,
        result: {
          disposition: 'requested',
          messageId: MESSAGE_ID,
          messageVersionId: MESSAGE_VERSION_ID,
          approvalRequestId: '99999999-9999-4999-8999-999999999999',
          lifecycleAtCommand: 'approval_pending',
          subjectSha256: review.email!.subjectSha256,
          bodySha256: review.email!.bodySha256,
          sourceContentSha256: review.contentSha256,
          recipient: 'office@propertypredator.com',
          providerEffects: false,
        },
      };
    },
    decideApproval: async () => ({ ok: false, kind: 'unavailable', message: 'not used' }),
  };
}

function postgres(overrides: Partial<PostgresPortalDeps> = {}): PostgresPortalDeps {
  return {
    kind: 'postgres', sessionSecret: SECRET, secure: false,
    requestId: () => 'owned-seed-router-request', now: () => NOW,
    productProfile: PROPERTY_PREDATOR_GROWTH_PROFILE,
    auth, crm, companyContent: companyContent(), ownedSeedMessages: messages(),
    ownedSeedCampaign: campaign(), ...overrides,
  };
}

function request(url: string, method = 'GET', body = '') {
  const req = new EventEmitter() as EventEmitter & { method: string; url: string; headers: Record<string, string> };
  req.method = method;
  req.url = url;
  req.headers = {
    cookie: COOKIE,
    ...(body ? { 'content-type': 'application/x-www-form-urlencoded', 'content-length': String(Buffer.byteLength(body)) } : {}),
  };
  setImmediate(() => {
    if (body) req.emit('data', Buffer.from(body));
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
      for (const [key, value] of Object.entries(headers ?? {})) this.headers[key.toLowerCase()] = Array.isArray(value) ? value.join('\n') : value;
      return this;
    },
    end(body?: string) { if (body) this.body = body; },
  };
}

async function call(url: string, deps: PostgresPortalDeps, method = 'GET', body = '') {
  const res = response();
  await handlePortal(request(url, method, body) as never, res as never, deps);
  return res;
}

function exactReviewRoute(): string {
  return `/portal/content/items/${CONTENT_ITEM_ID}/versions/${CONTENT_VERSION_ID}/review`;
}

function hidden(html: string, name: string): string {
  const found = html.match(new RegExp(`name="${name}" value="([^"]+)"`));
  assert.ok(found?.[1], `missing protected ${name} field`);
  return found[1];
}

test('exact review reconstructs existing owned-seed phase and mints a fresh session token', async () => {
  const result = await call(exactReviewRoute(), postgres());
  assert.equal(result.statusCode, 200);
  assert.match(result.body, /Approve the LIVE message/);
  assert.doesNotMatch(result.body, /Create LIVE message draft/);
  const token = hidden(result.body, 'owned_seed_workflow_token');
  const verified = verifyOwnedSeedWorkflowToken(SECRET, SESSION, token, NOW);
  assert.equal(verified?.messageId, MESSAGE_ID);
  assert.equal(verified?.phase, 'drafted');
});

test('resumed workflow token is accepted by the next protected message command', async () => {
  const approvalCalls: unknown[] = [];
  const service = messages({ approvalCalls });
  const deps = postgres({ ownedSeedMessages: service });
  const page = await call(exactReviewRoute(), deps);
  const form = new URLSearchParams({
    _csrf: hidden(page.body, '_csrf'),
    command_key: hidden(page.body, 'command_key'),
    return_exact_item_id: CONTENT_ITEM_ID,
    return_exact_version_id: CONTENT_VERSION_ID,
    owned_seed_workflow_token: hidden(page.body, 'owned_seed_workflow_token'),
    review_note: 'Founder checked the exact office-only message.',
  }).toString();
  const result = await call(OWNED_SEED_MESSAGE_APPROVAL_REQUEST_ROUTE, deps, 'POST', form);
  assert.equal(result.statusCode, 303);
  assert.match(result.headers.location ?? '', new RegExp(`^${exactReviewRoute().replaceAll('/', '\\/')}\\?owned_seed=`));
  assert.deepEqual(approvalCalls, [{
    identity: { sessionToken: SESSION, requestId: 'owned-seed-router-request' },
    command: {
      commandKey: hidden(page.body, 'command_key'),
      messageId: MESSAGE_ID,
      reviewNote: 'Founder checked the exact office-only message.',
    },
  }]);
});

test('no prior message offers one draft while mismatched resume evidence fails closed', async () => {
  const empty = await call(exactReviewRoute(), postgres({
    ownedSeedMessages: messages({ resumeResult: { ok: true, result: null } }),
  }));
  assert.equal(empty.statusCode, 200);
  assert.match(empty.body, /Create LIVE message draft/);

  const mismatch = await call(exactReviewRoute(), postgres({
    ownedSeedMessages: messages({
      resumeResult: {
        ok: true,
        result: {
          messageId: MESSAGE_ID,
          messageVersionId: MESSAGE_VERSION_ID,
          companyContentVersionId: CONTENT_VERSION_ID,
          phase: 'drafted',
          approvalRequestId: null,
          subjectSha256: 'f'.repeat(64),
          bodySha256: review.email!.bodySha256,
          sourceContentSha256: review.contentSha256,
          recipient: 'office@propertypredator.com',
        },
      },
    }),
  }));
  assert.equal(mismatch.statusCode, 200);
  assert.doesNotMatch(mismatch.body, /Create LIVE message draft|Request message approval/);
});
