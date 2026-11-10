/**
 * Operator API for Claude: configuration, signed blobs, the OAuth 2.1 server, the
 * stateless MCP server and the HTTP mount, all with stub services. No database.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { OPERATOR_MCP_PATH, OPERATOR_OAUTH_PATHS, deriveGroupHqOperatorToken, loadOperatorConfig } from '../src/operator/config.js';
import { signBlob, verifyBlob } from '../src/operator/tokens.js';
import { OperatorOAuth, authorizationServerMetadata, validRedirectUri } from '../src/operator/oauth.js';
import type { OperatorGrantRow, OperatorOAuthStore } from '../src/operator/oauth-store.js';
import { McpServer, type McpToolHost } from '../src/operator/mcp.js';
import { createOperatorMount } from '../src/operator/mount.js';
import { OperatorSessions } from '../src/operator/sessions.js';
import { createOperatorTools } from '../src/operator/tools.js';
import { portalCsrfToken } from '../src/portal/session.js';
import { MHP_MARKETING_WORKSPACE_ID } from '../src/mhp/marketing-workspace-service.js';

const USER = '12400000-0000-4000-8000-00000000bb01';
const PP_WS = '12400000-0000-4000-8000-00000000bb02';
const TOKEN = 'operator-static-token-synthetic-0123456789abcdef';
const SECRET = 'operator-oauth-secret-synthetic-fedcba9876543210';
const SESSION_SECRET = 'synthetic-session-secret-at-least-32-characters-long';
const ORIGIN = 'https://hq.propertypredator.com';
let NOW = Date.parse('2026-11-10T10:00:00Z');
const env = { R72_OPERATOR_TOKEN: TOKEN, R72_OPERATOR_OAUTH_SECRET: SECRET, R72_OPERATOR_USER_ID: USER, R72_GROUP_HQ_CRM_PP_WORKSPACE_ID: PP_WS, R72_OPERATOR_WRITES: 'enabled' };

test('operator configuration is off by default and strict when present', () => {
  assert.equal(loadOperatorConfig({}), undefined);
  assert.throws(() => loadOperatorConfig({ R72_OPERATOR_TOKEN: TOKEN }), /R72_OPERATOR_USER_ID/);
  assert.throws(() => loadOperatorConfig({ R72_OPERATOR_TOKEN: 'short', R72_OPERATOR_USER_ID: USER }), /32–256/);
  assert.throws(() => loadOperatorConfig({ R72_OPERATOR_USER_ID: USER }), /must be set/);
  assert.throws(() => loadOperatorConfig({ R72_OPERATOR_TOKEN: TOKEN, R72_OPERATOR_OAUTH_SECRET: TOKEN, R72_OPERATOR_USER_ID: USER }), /differ/);
  const config = loadOperatorConfig(env)!;
  assert.deepEqual([config.token, config.oauthSecret, config.userId, config.writes], [TOKEN, SECRET, USER, true]);
  assert.deepEqual(config.workspaces, { pp: PP_WS, mhp: MHP_MARKETING_WORKSPACE_ID });
  assert.equal(loadOperatorConfig({ ...env, R72_OPERATOR_WRITES: 'yes' })!.writes, false);
  assert.equal(loadOperatorConfig({ R72_OPERATOR_OAUTH_SECRET: SECRET, R72_OPERATOR_USER_ID: USER })!.token, null);
});

test('signed client ids verify only for their secret and are tamper-evident', () => {
  const now = Math.floor(NOW / 1000);
  const client = signBlob(SECRET, 'oauth-client', { uris: ['https://claude.ai/cb'], exp: now + 60 });
  assert.deepEqual(verifyBlob(SECRET, 'oauth-client', client, now), { uris: ['https://claude.ai/cb'], exp: now + 60 });
  assert.equal(verifyBlob('x'.repeat(SECRET.length), 'oauth-client', client, now), null);
  assert.equal(verifyBlob(SECRET, 'oauth-client', client, now + 60), null, 'expired');
  assert.equal(verifyBlob(SECRET, 'oauth-client', `${client}x`, now), null);
  assert.equal(verifyBlob(SECRET, 'oauth-client', null, now), null);
});

/** Mirrors migration 0148's rules in memory; the database integration test proves the real functions. */
class MemoryStore implements OperatorOAuthStore {
  codes = new Map<string, { client: string; name: string; uri: string; cc: string; sub: string; exp: number; consumed: boolean; grant: string | null }>();
  tokens = new Map<string, { grant: string; kind: 'access' | 'refresh'; exp: number; rotated: boolean }>();
  grants = new Map<string, { sub: string; client: string; name: string; created: number; revoked: string | null }>();
  private k = (b: Buffer) => b.toString('hex');
  async issueCode(i: Parameters<OperatorOAuthStore['issueCode']>[0]) { this.codes.set(this.k(i.codeHash), { client: this.k(i.clientIdHash), name: i.clientName, uri: this.k(i.redirectUriHash), cc: i.codeChallenge, sub: i.subject, exp: i.expiresAt.getTime(), consumed: false, grant: null }); return true; }
  async redeemCode(i: Parameters<OperatorOAuthStore['redeemCode']>[0]) {
    const c = this.codes.get(this.k(i.codeHash));
    if (!c) return { outcome: 'invalid' as const, subject: null };
    if (c.consumed) { const g = this.grants.get(c.grant!); if (g && !g.revoked) g.revoked = 'code_replay'; return { outcome: 'replayed' as const, subject: null }; }
    if (c.exp <= i.now.getTime() || c.client !== this.k(i.clientIdHash) || c.uri !== this.k(i.redirectUriHash) || c.cc !== i.verifierChallenge) return { outcome: 'invalid' as const, subject: null };
    const grant = randomUUID(); this.grants.set(grant, { sub: c.sub, client: c.client, name: c.name, created: i.now.getTime(), revoked: null });
    c.consumed = true; c.grant = grant;
    this.tokens.set(this.k(i.accessHash), { grant, kind: 'access', exp: i.accessExpiresAt.getTime(), rotated: false });
    this.tokens.set(this.k(i.refreshHash), { grant, kind: 'refresh', exp: i.refreshExpiresAt.getTime(), rotated: false });
    return { outcome: 'issued' as const, subject: c.sub };
  }
  async refresh(i: Parameters<OperatorOAuthStore['refresh']>[0]) {
    const t = this.tokens.get(this.k(i.refreshHash));
    if (!t || t.kind !== 'refresh') return { outcome: 'invalid' as const, subject: null };
    const g = this.grants.get(t.grant)!;
    if (g.revoked) return { outcome: 'invalid' as const, subject: null };
    if (g.client !== this.k(i.clientIdHash)) { g.revoked = 'client_mismatch'; return { outcome: 'client_mismatch' as const, subject: null }; }
    if (t.rotated) { g.revoked = 'refresh_reuse'; return { outcome: 'reused' as const, subject: null }; }
    if (t.exp <= i.now.getTime()) return { outcome: 'invalid' as const, subject: null };
    t.rotated = true;
    this.tokens.set(this.k(i.accessHash), { grant: t.grant, kind: 'access', exp: i.accessExpiresAt.getTime(), rotated: false });
    this.tokens.set(this.k(i.newRefreshHash), { grant: t.grant, kind: 'refresh', exp: i.refreshExpiresAt.getTime(), rotated: false });
    return { outcome: 'issued' as const, subject: g.sub };
  }
  async resolve(h: Buffer, now: Date) { const t = this.tokens.get(this.k(h)); const g = t && this.grants.get(t.grant); return t && g && t.kind === 'access' && t.exp > now.getTime() && !g.revoked ? g.sub : null; }
  async revokeToken(h: Buffer, client: Buffer) { const t = this.tokens.get(this.k(h)); const g = t && this.grants.get(t.grant); if (!g || g.revoked || g.client !== this.k(client)) return false; g.revoked = 'client'; return true; }
  async listGrants(sub: string): Promise<OperatorGrantRow[]> { return [...this.grants.entries()].filter(([, g]) => g.sub === sub).map(([id, g]) => ({ grantId: id, clientName: g.name, createdAt: new Date(g.created).toISOString(), lastUsedAt: null, revokedAt: g.revoked ? new Date(NOW).toISOString() : null, revokedReason: g.revoked })); }
  async revokeGrant(sub: string, id: string) { const g = this.grants.get(id); if (!g || g.sub !== sub || g.revoked) return false; g.revoked = 'owner'; return true; }
}

function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

test('OAuth: registration, request validation, single-use PKCE codes, client-bound rotating refresh tokens', async () => {
  const store = new MemoryStore();
  const oauth = new OperatorOAuth(SECRET, store, () => NOW);
  assert.equal(validRedirectUri('https://claude.ai/api/mcp/auth_callback'), true);
  assert.equal(validRedirectUri('http://127.0.0.1:5173/callback'), true);
  assert.equal(validRedirectUri('http://evil.example/cb'), false);
  assert.equal(validRedirectUri('https://claude.ai/cb#frag'), false);
  assert.equal(oauth.register({ redirect_uris: ['http://evil.example/cb'] }), null);
  assert.equal(oauth.register({ redirect_uris: [] }), null);
  const client = oauth.register({ redirect_uris: ['https://claude.ai/api/mcp/auth_callback'], client_name: 'Claude' })!;
  const other = oauth.register({ redirect_uris: ['https://claude.ai/api/mcp/auth_callback'], client_name: 'Other' })!;
  assert.equal(client.name, 'Claude');
  assert.equal(oauth.client(`${client.id}x`), null);
  const { verifier, challenge } = pkce();
  const params = new URLSearchParams({ response_type: 'code', client_id: client.id, redirect_uri: 'https://claude.ai/api/mcp/auth_callback', code_challenge: challenge, code_challenge_method: 'S256', state: 'abc', scope: 'operator' });
  const request = oauth.authorizationRequest(params)!;
  assert.equal(request.state, 'abc');
  for (const [k, v] of [['redirect_uri', 'https://claude.ai/other'], ['code_challenge_method', 'plain'], ['response_type', 'token'], ['scope', 'admin'], ['code_challenge', 'short'], ['code_challenge', `${challenge}x`]] as const) {
    const bad = new URLSearchParams(params); bad.set(k, v);
    assert.equal(oauth.authorizationRequest(bad), null, `${k}=${v}`);
  }
  const code = (await oauth.issueCode(request.client, request.redirectUri, request.challenge, USER))!;
  assert.match(code, /^[A-Za-z0-9_-]{43}$/);
  const form = (over: Record<string, string> = {}) => new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: 'https://claude.ai/api/mcp/auth_callback', client_id: client.id, code_verifier: verifier, ...over });
  assert.equal((await oauth.exchange(form({ code_verifier: randomBytes(32).toString('base64url') }))).body.error, 'invalid_grant', 'wrong verifier');
  assert.equal((await oauth.exchange(form({ redirect_uri: 'https://claude.ai/other' }))).body.error, 'invalid_grant', 'wrong redirect');
  assert.equal((await oauth.exchange(form({ client_id: other.id }))).body.error, 'invalid_grant', 'another client');
  assert.equal((await oauth.exchange(form({ client_id: 'forged' }))).status, 401);
  const ok = await oauth.exchange(form());
  assert.equal(ok.status, 200);
  const first = ok.body as Record<string, string>;
  assert.equal(first.token_type, 'Bearer');
  assert.equal(await oauth.subject(first.access_token!), USER);
  const replay = await oauth.exchange(form());
  assert.equal(replay.body.error, 'invalid_grant', 'a code is single use');
  assert.equal(await oauth.subject(first.access_token!), null, 'replaying a code revokes what it issued');

  // A fresh connection for the rotation rules.
  const code2 = (await oauth.issueCode(request.client, request.redirectUri, request.challenge, USER))!;
  const second = (await oauth.exchange(form({ code: code2 }))).body as Record<string, string>;
  const refresh = (token: string, clientId = client.id) => oauth.exchange(new URLSearchParams({ grant_type: 'refresh_token', refresh_token: token, client_id: clientId }));
  assert.equal((await oauth.exchange(new URLSearchParams({ grant_type: 'refresh_token', refresh_token: second.refresh_token! }))).status, 401, 'client id is required');
  const rotated = await refresh(second.refresh_token!);
  assert.equal(rotated.status, 200);
  const third = rotated.body as Record<string, string>;
  assert.notEqual(third.refresh_token, second.refresh_token, 'refresh tokens rotate');
  assert.equal(await oauth.subject(third.access_token!), USER);
  assert.equal((await refresh(second.refresh_token!)).body.error, 'invalid_grant', 'an old refresh token is refused');
  assert.equal(await oauth.subject(third.access_token!), null, 'and its reuse ends the whole connection');
  assert.equal((await refresh(third.refresh_token!)).body.error, 'invalid_grant');

  const code3 = (await oauth.issueCode(request.client, request.redirectUri, request.challenge, USER))!;
  const fourth = (await oauth.exchange(form({ code: code3 }))).body as Record<string, string>;
  assert.equal((await refresh(fourth.refresh_token!, other.id)).body.error, 'invalid_grant', 'refresh tokens are bound to their client');
  assert.equal(await oauth.subject(fourth.access_token!), null, 'a mismatched client ends the connection');

  const code4 = (await oauth.issueCode(request.client, request.redirectUri, request.challenge, USER))!;
  const fifth = (await oauth.exchange(form({ code: code4 }))).body as Record<string, string>;
  assert.equal((await oauth.revoke(new URLSearchParams({ token: fifth.access_token!, client_id: other.id }))).status, 200);
  assert.equal(await oauth.subject(fifth.access_token!), USER, 'another client cannot revoke it');
  assert.equal((await oauth.revoke(new URLSearchParams({ token: fifth.refresh_token!, client_id: client.id }))).status, 200);
  assert.equal(await oauth.subject(fifth.access_token!), null, 'revoking either token ends the connection');
  assert.equal((await oauth.exchange(new URLSearchParams({ grant_type: 'password' }))).body.error, 'unsupported_grant_type');
  assert.equal((await oauth.exchange(new URLSearchParams({ grant_type: 'authorization_code', code: 'x' }))).body.error, 'invalid_request');
  assert.equal(await oauth.subject('not-a-token'), null);

  const metadata = authorizationServerMetadata(ORIGIN);
  assert.equal(metadata.token_endpoint, `${ORIGIN}${OPERATOR_OAUTH_PATHS.token}`);
  assert.equal(metadata.revocation_endpoint, `${ORIGIN}${OPERATOR_OAUTH_PATHS.revoke}`);
  assert.deepEqual(metadata.code_challenge_methods_supported, ['S256']);
});

function stubHost(writes: boolean): McpToolHost & { calls: string[] } {
  const calls: string[] = [];
  const sessions = new OperatorSessions(loadOperatorConfig({ ...env, R72_OPERATOR_WRITES: writes ? 'enabled' : 'off' })!, {
    pp: { resolve: async () => null, loginDelegated: async (input) => { calls.push(`login:${input.workspaceId}`); return { sessionToken: 's'.repeat(43), userId: input.userId, workspaceId: input.workspaceId, userEmail: 'op@example.test', expiresAt: new Date(NOW + 3_600_000).toISOString() }; } },
    mhp: undefined,
  }, () => NOW);
  const tools = createOperatorTools({
    sessions, writes,
    crm: {
      snapshot: async (identity, request) => { calls.push(`snapshot:${request?.section}:${identity.sessionToken.length}`); return { workspace: { id: PP_WS, name: 'PP', timezone: 'Europe/London', snapshotAt: new Date(NOW).toISOString(), canWrite: true }, contacts: [], stages: [{ id: PP_WS, name: 'New', position: 1, isClosed: false }], opportunities: [], tasks: [], timeline: [] }; },
      lead360: async () => null,
      createLead: async (_identity, input) => { calls.push(`create:${input.displayName}:${input.commandKey.startsWith('operator.')}`); return { ok: true, disposition: 'applied' }; },
      moveOpportunity: async () => ({ ok: false, kind: 'conflict', message: 'row changed' }),
      completeTask: async () => ({ ok: true, disposition: 'replayed' }),
    },
  });
  return Object.assign(tools, { calls });
}

test('MCP server: initialize, list, call, batches, notifications and errors over stub tools', async () => {
  const host = stubHost(false);
  const mcp = new McpServer(host, { name: 'relaunch72', version: '1' });
  const init = await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude', version: '1' } } });
  assert.equal(init.status, 200);
  assert.deepEqual((init.body as { result: { capabilities: unknown; protocolVersion: string } }).result.protocolVersion, '2025-06-18');
  assert.equal((await mcp.handle({ jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
  const list = await mcp.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const names = (list.body as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name);
  assert.ok(names.includes('workspace_overview') && names.includes('webinars_list'));
  assert.ok(!names.includes('crm_create_lead'), 'write tools hidden when writes are off');
  const call = await mcp.handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'workspace_overview', arguments: { brand: 'pp' } } });
  const result = (call.body as { result: { isError: boolean; content: { text: string }[] } }).result;
  assert.equal(result.isError, false);
  assert.equal(JSON.parse(result.content[0]!.text).workspace.name, 'PP');
  assert.deepEqual(host.calls, [`login:${PP_WS}`, 'snapshot:overview:43']);
  await mcp.handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'workspace_overview', arguments: { brand: 'pp' } } });
  assert.equal(host.calls.filter((c) => c.startsWith('login')).length, 1, 'the delegated session is reused');
  const unknown = await mcp.handle({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'crm_create_lead', arguments: {} } });
  assert.equal((unknown.body as { error: { code: number } }).error.code, -32602);
  const badBrand = await mcp.handle({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'workspace_overview', arguments: { brand: 'kp' } } });
  assert.equal((badBrand.body as { result: { isError: boolean } }).result.isError, true);
  const mhp = await mcp.handle({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'workspace_overview', arguments: { brand: 'mhp' } } });
  assert.match((mhp.body as { result: { content: { text: string }[] } }).result.content[0]!.text, /MHP host is not composed/);
  assert.equal((await mcp.handle({ jsonrpc: '2.0', id: 8, method: 'resources/list' })).body && (await mcp.handle({ jsonrpc: '2.0', id: 8, method: 'resources/list' }) as { body: { error: { code: number } } }).body.error.code, -32601);
  const batch = await mcp.handle([{ jsonrpc: '2.0', id: 9, method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/x' }]);
  assert.equal(batch.status, 200);
  assert.equal((batch.body as unknown[]).length, 1);
  assert.equal((await mcp.handle('nope')).status, 400);
  assert.equal((await mcp.handle([])).status, 400);
});

test('write tools run as the operator with generated idempotency keys and surface service refusals', async () => {
  const host = stubHost(true);
  assert.ok(host.listTools().some((t) => t.name === 'crm_create_lead'));
  const created = await host.callTool('crm_create_lead', { brand: 'pp', displayName: 'Ann', opportunityTitle: 'Land', stageId: PP_WS });
  assert.deepEqual(created, { ok: true, disposition: 'applied' });
  assert.ok(host.calls.includes('create:Ann:true'));
  await assert.rejects(host.callTool('crm_move_opportunity', { brand: 'pp', opportunityId: PP_WS, targetStageId: PP_WS, expectedRowVersion: 3 }), /conflict: row changed/);
  await assert.rejects(host.callTool('crm_create_lead', { brand: 'pp', displayName: 'Ann', opportunityTitle: 'Land', stageId: 'not-a-uuid' }), /stageId must be a UUID/);
  await assert.rejects(host.callTool('webinars_list', { brand: 'pp' }), /not composed/);
});

interface Captured { status: number; body: string; headers: Record<string, string | string[]> }
function request(method: string, path: string, body = '', headers: Record<string, string> = {}): IncomingMessage {
  return Object.assign(Readable.from([Buffer.from(body)]), { method, url: path, headers: { host: 'hq.propertypredator.com', 'content-length': String(Buffer.byteLength(body)), ...headers } }) as unknown as IncomingMessage;
}
function response(): { res: ServerResponse; captured: Captured } {
  const captured: Captured = { status: 0, body: '', headers: {} };
  const res = { headersSent: false, writeHead(status: number, headers: Record<string, string | string[]> = {}) { captured.status = status; Object.assign(captured.headers, headers); (this as { headersSent: boolean }).headersSent = true; }, setHeader() {}, end(body = '') { captured.body = String(body); } } as unknown as ServerResponse;
  return { res, captured };
}

test('HTTP mount: metadata, registration, consent for the signed-in operator only, token exchange and bearer-guarded MCP', async () => {
  const config = loadOperatorConfig(env)!;
  const session = 'p'.repeat(43);
  const store = new MemoryStore();
  const mount = createOperatorMount({ config, origin: ORIGIN, tools: stubHost(true), sessionSecret: SESSION_SECRET, now: () => NOW, store,
    auth: { resolve: async (token) => token === session ? { sessionToken: token, userId: USER, workspaceId: PP_WS, userEmail: 'op@example.test' } : token === 'other' ? { sessionToken: token, userId: PP_WS, workspaceId: PP_WS, userEmail: 'x@example.test' } : null } });
  const run = async (method: string, path: string, body = '', headers: Record<string, string> = {}) => { const { res, captured } = response(); await mount.handle(request(method, path, body, headers), res, new URL(`${ORIGIN}${path}`)); return captured; };

  const prm = await run('GET', OPERATOR_OAUTH_PATHS.protectedResource);
  assert.equal(prm.status, 200);
  assert.deepEqual(JSON.parse(prm.body).authorization_servers, [ORIGIN]);
  assert.equal(JSON.parse((await run('GET', OPERATOR_OAUTH_PATHS.authorizationServer)).body).registration_endpoint, `${ORIGIN}${OPERATOR_OAUTH_PATHS.register}`);

  const registered = await run('POST', OPERATOR_OAUTH_PATHS.register, JSON.stringify({ redirect_uris: ['https://claude.ai/api/mcp/auth_callback'], client_name: 'Claude' }), { 'content-type': 'application/json' });
  assert.equal(registered.status, 201);
  const clientId = JSON.parse(registered.body).client_id as string;
  assert.equal((await run('POST', OPERATOR_OAUTH_PATHS.register, JSON.stringify({ redirect_uris: ['http://evil.example/'] }))).status, 400);

  const { verifier, challenge } = pkce();
  const query = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: 'https://claude.ai/api/mcp/auth_callback', code_challenge: challenge, code_challenge_method: 'S256', state: 'st' }).toString();
  const signedOut = await run('GET', `${OPERATOR_OAUTH_PATHS.authorize}?${query}`);
  assert.equal(signedOut.status, 401);
  assert.match(signedOut.body, /Sign in to Growth HQ first/);
  const wrongUser = await run('GET', `${OPERATOR_OAUTH_PATHS.authorize}?${query}`, '', { cookie: 'r72_portal=other' });
  assert.equal(wrongUser.status, 401, 'another portal user cannot authorise the operator');
  const consent = await run('GET', `${OPERATOR_OAUTH_PATHS.authorize}?${query}`, '', { cookie: `r72_portal=${session}` });
  assert.equal(consent.status, 200);
  assert.match(consent.body, /Allow <em>Claude<\/em>/);
  assert.match(consent.body, /create or change leads/);
  // Browsers apply form-action to the redirect after Allow/Deny: the client's origin must be allowed, and only there.
  assert.match(String(consent.headers['content-security-policy']), /form-action 'self' https:\/\/claude\.ai;/);
  assert.match(String(signedOut.headers['content-security-policy']), /form-action 'self';/);
  assert.match(consent.body, /sending stay with you in the portal/);
  assert.equal((await run('GET', `${OPERATOR_OAUTH_PATHS.authorize}?${query}&redirect_uri=https://evil.example/`, '', { cookie: `r72_portal=${session}` })).status, 400);

  const csrf = portalCsrfToken(SESSION_SECRET, session);
  const form = (decision: string, token = csrf) => `${query}&csrf=${encodeURIComponent(token)}&decision=${decision}`;
  assert.equal((await run('POST', OPERATOR_OAUTH_PATHS.authorize, form('allow', 'bad'), { cookie: `r72_portal=${session}` })).status, 403);
  const denied = await run('POST', OPERATOR_OAUTH_PATHS.authorize, form('deny'), { cookie: `r72_portal=${session}` });
  assert.equal(denied.status, 303);
  assert.match(String(denied.headers.location), /^https:\/\/claude\.ai\/api\/mcp\/auth_callback\?error=access_denied&state=st$/);
  const allowed = await run('POST', OPERATOR_OAUTH_PATHS.authorize, form('allow'), { cookie: `r72_portal=${session}` });
  assert.equal(allowed.status, 303);
  const code = new URL(String(allowed.headers.location)).searchParams.get('code')!;
  assert.ok(code);

  const exchanged = await run('POST', OPERATOR_OAUTH_PATHS.token, new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: 'https://claude.ai/api/mcp/auth_callback', client_id: clientId, code_verifier: verifier }).toString());
  assert.equal(exchanged.status, 200);
  assert.equal(exchanged.headers['cache-control'], 'no-store');
  const access = JSON.parse(exchanged.body).access_token as string;

  const rpc = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'workspace_overview', arguments: { brand: 'pp' } } });
  const noAuth = await run('POST', OPERATOR_MCP_PATH, rpc);
  assert.equal(noAuth.status, 401);
  assert.match(String(noAuth.headers['www-authenticate']), /resource_metadata="https:\/\/hq\.propertypredator\.com\/\.well-known\/oauth-protected-resource"/);
  assert.equal((await run('POST', OPERATOR_MCP_PATH, rpc, { authorization: `Bearer ${TOKEN}x` })).status, 401);
  for (const bearer of [TOKEN, access]) {
    const ok = await run('POST', OPERATOR_MCP_PATH, rpc, { authorization: `Bearer ${bearer}` });
    assert.equal(ok.status, 200, bearer === TOKEN ? 'static token' : 'oauth access token');
    assert.equal(JSON.parse(ok.body).result.isError, false);
  }
  assert.equal((await run('GET', OPERATOR_MCP_PATH, '', { authorization: `Bearer ${TOKEN}` })).status, 405);
  assert.equal((await run('POST', OPERATOR_MCP_PATH, '{', { authorization: `Bearer ${TOKEN}` })).status, 400);
  assert.equal((await run('POST', OPERATOR_MCP_PATH, JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }), { authorization: `Bearer ${TOKEN}` })).status, 202);

  // Connected apps: the operator lists and revokes their own connections.
  const list = await run('GET', OPERATOR_OAUTH_PATHS.connections, '', { cookie: `r72_portal=${session}` });
  assert.equal(list.status, 200);
  assert.match(list.body, /<strong>Claude<\/strong>/);
  assert.equal((await run('GET', OPERATOR_OAUTH_PATHS.connections, '', { cookie: 'r72_portal=other' })).status, 401);
  const grant = [...store.grants.keys()][0]!;
  assert.equal((await run('POST', OPERATOR_OAUTH_PATHS.connections, `csrf=bad&grant=${grant}`, { cookie: `r72_portal=${session}` })).status, 403);
  const revoked = await run('POST', OPERATOR_OAUTH_PATHS.connections, `csrf=${encodeURIComponent(csrf)}&grant=${grant}`, { cookie: `r72_portal=${session}` });
  assert.equal(revoked.status, 200);
  assert.match(revoked.body, /Revoked\./);
  assert.equal((await run('POST', OPERATOR_MCP_PATH, rpc, { authorization: `Bearer ${access}` })).status, 401, 'a revoked connection is refused at once');

  const noStore = createOperatorMount({ config, origin: ORIGIN, tools: stubHost(false), sessionSecret: SESSION_SECRET, now: () => NOW, auth: { resolve: async () => null } });
  const ns = response();
  await noStore.handle(request('GET', OPERATOR_OAUTH_PATHS.authorizationServer), ns.res, new URL(`${ORIGIN}${OPERATOR_OAUTH_PATHS.authorizationServer}`));
  assert.equal(ns.captured.status, 404, 'OAuth stays off until migration 0148 provides the store');

  const oauthOnly = createOperatorMount({ config: loadOperatorConfig({ R72_OPERATOR_OAUTH_SECRET: SECRET, R72_OPERATOR_USER_ID: USER })!, origin: ORIGIN, tools: stubHost(false), sessionSecret: SESSION_SECRET, now: () => NOW, store: new MemoryStore(), auth: { resolve: async () => null } });
  const r = response();
  await oauthOnly.handle(request('POST', OPERATOR_MCP_PATH, rpc, { authorization: `Bearer ${TOKEN}` }), r.res, new URL(`${ORIGIN}${OPERATOR_MCP_PATH}`));
  assert.equal(r.captured.status, 401, 'no static token when only OAuth is configured');
  const tokenOnly = createOperatorMount({ config: loadOperatorConfig({ R72_OPERATOR_TOKEN: TOKEN, R72_OPERATOR_USER_ID: USER })!, origin: ORIGIN, tools: stubHost(false), sessionSecret: SESSION_SECRET, now: () => NOW, store: new MemoryStore(), auth: { resolve: async () => null } });
  const m = response();
  await tokenOnly.handle(request('GET', OPERATOR_OAUTH_PATHS.authorizationServer), m.res, new URL(`${ORIGIN}${OPERATOR_OAUTH_PATHS.authorizationServer}`));
  assert.equal(m.captured.status, 404, 'no OAuth metadata without a secret');
});

test('Group HQ relay bearer: derived from the shared handoff secret, off unless switched on, accepted by the mount', async () => {
  const shared = 'group-hq-shared-secret-synthetic-0123456789abcdef';
  const base = { R72_OPERATOR_OAUTH_SECRET: SECRET, R72_OPERATOR_USER_ID: USER, R72_GROUP_HQ_SSO_SECRET: shared };
  assert.equal(loadOperatorConfig(base)!.groupHqToken, null, 'sharing the handoff secret alone grants nothing');
  assert.throws(() => loadOperatorConfig({ R72_OPERATOR_OAUTH_SECRET: SECRET, R72_OPERATOR_USER_ID: USER, R72_OPERATOR_GROUP_HQ: 'enabled' }), /R72_GROUP_HQ_SSO_SECRET/);
  const config = loadOperatorConfig({ ...base, R72_OPERATOR_GROUP_HQ: 'enabled' })!;
  // Pinned vector; app/services/relaunch72_operator.py in Group HQ must derive the same bytes.
  assert.equal(config.groupHqToken, deriveGroupHqOperatorToken(shared));
  assert.equal(deriveGroupHqOperatorToken(shared), 'vSvqRI-KLf62_AAErvHo3X0_isVsT-aXT9jMwmRUNxs');
  assert.notEqual(config.groupHqToken, shared);
  const rpc = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' });
  const call = async (cfg: NonNullable<ReturnType<typeof loadOperatorConfig>>, bearer: string) => {
    const mount = createOperatorMount({ config: cfg, origin: ORIGIN, tools: stubHost(false), sessionSecret: SESSION_SECRET, now: () => NOW, store: new MemoryStore(), auth: { resolve: async () => null } });
    const { res, captured } = response();
    await mount.handle(request('POST', OPERATOR_MCP_PATH, rpc, { authorization: `Bearer ${bearer}` }), res, new URL(`${ORIGIN}${OPERATOR_MCP_PATH}`));
    return captured.status;
  };
  assert.equal(await call(config, config.groupHqToken!), 200);
  assert.equal(await call(config, shared), 401, 'the shared secret itself is not a bearer');
  assert.equal(await call(loadOperatorConfig(base)!, deriveGroupHqOperatorToken(shared)), 401, 'refused while the relay is off');
});
