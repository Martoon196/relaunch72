import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { handlePortal, type PostgresPortalDeps } from '../src/portal/router.js';
import { PORTAL_COOKIE, portalCsrfToken } from '../src/portal/session.js';
import type { FinanceSnapshot } from '../src/portal/finance-drafts-service.js';
const O = '22222222-2222-4222-8222-222222222222', W = '11111111-1111-4111-8111-111111111111', C = '44444444-4444-4444-8444-444444444444', U = '33333333-3333-4333-8333-333333333333';
const TOKEN = 'opaque-finance-test-token', SECRET = 'server-only-finance-test-secret-long-enough';
function setup() {
  let calculations = 0, saves = 0, catalogs = 0;
  const snapshot: FinanceSnapshot = { source: { workspaceId: W, workspaceName: 'Test', opportunityId: O, opportunityName: 'Deal', contactId: C, contactName: 'Client', opportunityVersion: 1, latestVersion: 0, canWrite: true }, versions: [] };
  const workspace = { id: W, name: 'Test', timezone: 'Europe/London', snapshotAt: '2026-10-26T00:00:00Z', canWrite: true };
  const deps: PostgresPortalDeps = { kind: 'postgres', secure: false, sessionSecret: SECRET, requestId: () => 'finance-router-test',
    auth: { async resolve() { return { sessionToken: TOKEN, userId: U, workspaceId: W, userEmail: 'synthetic@example.test' }; }, async login() { return null; }, async revoke() {} },
    crm: { async snapshot() { return { workspace, contacts: [], opportunities: [], stages: [], tasks: [], timeline: [] }; }, async workspaceShell() { return { workspace }; }, async createLead() { return { ok: true, disposition: 'applied' }; }, async moveOpportunity() { return { ok: true, disposition: 'applied' }; }, async completeTask() { return { ok: true, disposition: 'applied' }; } },
    financeDrafts: { async snapshot(identity, id) { assert.equal(identity.sessionToken, TOKEN); assert.equal(id, O); return snapshot; }, async catalog() { catalogs++; return { products: [] }; }, async calculate() { calculations++; throw Error('not expected'); }, async save() { saves++; return { version: 2 } as never; } },
  };
  async function call(method: string, suffix = '', body = '', contentType = 'application/x-www-form-urlencoded') {
    const req = new EventEmitter() as EventEmitter & { method: string; url: string; headers: Record<string, string> };
    Object.assign(req, { method, url: `/portal/crm/opportunities/${O}/finance${suffix}`, headers: { cookie: `${PORTAL_COOKIE}=${TOKEN}`, 'content-type': contentType } });
    const res = { statusCode: 0, headers: {} as Record<string, string>, body: '', writeHead(code: number, headers: Record<string, string>) { this.statusCode = code; this.headers = headers; return this; }, end(text = '') { this.body = text; } };
    const pending = handlePortal(req as never, res as never, deps);
    setImmediate(() => { if (body) req.emit('data', Buffer.from(body)); req.emit('end'); });
    await pending; return res;
  }
  return { deps, call, counts: () => ({ calculations, saves, catalogs }) };
}
test('saved finance GET renders without catalogue or calculation calls and keeps restrictive CSP', async () => {
  const h = setup(), response = await h.call('GET');
  assert.equal(response.statusCode, 200); assert.match(response.body, /No saved illustrations yet/);
  assert.deepEqual(h.counts(), { calculations: 0, saves: 0, catalogs: 0 }); assert.match(response.headers['content-security-policy']!, /default-src 'none'/); assert.doesNotMatch(response.headers['content-security-policy']!, /mh196-finance/);
});
test('finance save requires CSRF and form encoding before service mutation', async () => {
  const h = setup(); assert.equal((await h.call('POST', '/save', 'review_token=x')).statusCode, 403);
  assert.equal((await h.call('POST', '/save', '{}', 'application/json')).statusCode, 415); assert.equal(h.counts().saves, 0);
  const response = await h.call('POST', '/save', new URLSearchParams({ _csrf: portalCsrfToken(SECRET, TOKEN), review_token: 'signed-test' }).toString());
  assert.equal(response.statusCode, 303); assert.equal(response.headers.location, `/portal/crm/opportunities/${O}/finance?version=2`); assert.equal(h.counts().saves, 1);
});
test('no composed finance service means the new route is unavailable', async () => {
  const h = setup(); delete h.deps.financeDrafts; const response = await h.call('GET'); assert.equal(response.statusCode, 404); assert.equal(h.counts().calculations, 0);
});
