import test from 'node:test';
import assert from 'node:assert/strict';
import {
  authSubjectAbuseAdmission,
  classifyPortalAbuseRoute,
  principalAbuseAdmission,
  sourceAbuseAdmission,
} from '../src/portal/abuse.js';
import { portalAbuseHash, type PortalRequestContext } from '../src/portal/request-context.js';

const SECRET = 'portal-abuse-test-secret-32-characters-minimum';
const context: PortalRequestContext = Object.freeze({
  requestId: 'request-1',
  requestHash: portalAbuseHash(SECRET, 'request', 'request-1'),
  clientAddress: '203.0.113.42',
  sourceHash: portalAbuseHash(SECRET, 'source', '203.0.113.42'),
});

test('route classification is a small value-only allowlist', () => {
  assert.equal(classifyPortalAbuseRoute('/portal/login', 'POST'), 'auth.login');
  assert.equal(classifyPortalAbuseRoute('/portal/setup', 'GET'), 'auth.setup');
  assert.equal(classifyPortalAbuseRoute('/portal/auth/property-predator/callback', 'GET'), 'auth.sso');
  assert.equal(classifyPortalAbuseRoute('/portal', 'GET'), 'read.overview');
  assert.equal(classifyPortalAbuseRoute('/portal/crm/contacts/secret-id', 'GET'), 'read.page');
  assert.equal(classifyPortalAbuseRoute('/portal/crm/contacts/secret-id', 'POST'), 'command');
});

test('source policies are conservative and never contain the raw source', () => {
  const login = sourceAbuseAdmission(context, 'auth.login', 1_000)!;
  assert.deepEqual(login.dimensions.map((item) => [
    item.name, item.capacity, item.windowSeconds, item.maxConcurrency,
  ]), [
    ['source', 30, 900, 2],
    ['source_daily', 20_000, 86_400, 0],
  ]);
  assert.notDeepEqual(login.dimensions[0]?.subjectHash, context.sourceHash);
  assert.deepEqual(login.dimensions[1]?.subjectHash, context.sourceHash);
  assert.notDeepEqual(
    login.dimensions[0]?.subjectHash,
    sourceAbuseAdmission(context, 'read.page', 1_000)?.dimensions[0]?.subjectHash,
  );
  assert.equal(JSON.stringify(login).includes('203.0.113.42'), false);
});

test('authentication subjects are HMAC-only and domain separated', () => {
  const email = authSubjectAbuseAdmission(context, 'auth.login', SECRET, 'owner@example.test', 2_000);
  const setup = authSubjectAbuseAdmission(context, 'auth.setup', SECRET, 'owner@example.test', 2_000);
  assert.equal(email.dimensions[0]?.capacity, 5);
  assert.equal(email.dimensions[0]?.windowSeconds, 900);
  assert.equal(email.dimensions[0]?.maxConcurrency, 1);
  assert.notDeepEqual(email.dimensions[0]?.subjectHash, setup.dimensions[0]?.subjectHash);
  assert.equal(JSON.stringify(email).includes('owner@example.test'), false);
});

test('principal policy combines account, workspace, route, daily and concurrency bounds', () => {
  const admission = principalAbuseAdmission(context, 'read.page', SECRET, {
    sessionToken: 'opaque',
    userId: '11111111-1111-4111-8111-111111111111',
    workspaceId: '22222222-2222-4222-8222-222222222222',
    userEmail: 'owner@example.test',
  }, 3_000);
  assert.deepEqual(admission.dimensions.map((item) => [
    item.name, item.capacity, item.windowSeconds, item.maxConcurrency,
  ]), [
    ['account', 120, 60, 4],
    ['account_daily', 10_000, 86_400, 0],
    ['workspace', 600, 60, 12],
    ['workspace_daily', 50_000, 86_400, 0],
    ['route_account', 20, 60, 2],
    ['route_workspace', 100, 60, 4],
  ]);
  const serialized = JSON.stringify(admission);
  assert.equal(serialized.includes('owner@example.test'), false);
  assert.equal(serialized.includes('11111111-1111-4111-8111-111111111111'), false);
  assert.equal(serialized.includes('22222222-2222-4222-8222-222222222222'), false);
});
