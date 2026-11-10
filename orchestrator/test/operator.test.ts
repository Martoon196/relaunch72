/**
 * Operator API for Claude: configuration, signed blobs, the OAuth 2.1 server, the
 * stateless MCP server and the HTTP mount, all with stub services. No database.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { OPERATOR_MCP_PATH, OPERATOR_OAUTH_PATHS, loadOperatorConfig } from '../src/operator/config.js';
import { ConsumedNonces, signBlob, verifyBlob } from '../src/operator/tokens.js';
import { OperatorOAuth, authorizationServerMetadata, validRedirectUri } from '../src/operator/oauth.js';
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

test('signed blobs verify only for their kind, secret and lifetime; nonces are single use', () => {
  const now = Math.floor(NOW / 1000);
  const access = signBlob(SECRET, 'oauth-access', { sub: USER, exp: now + 60 });
  assert.deepEqual(verifyBlob(SECRET, 'oauth-access', access, now), { sub: USER, exp: now + 60 });
  assert.equal(verifyBlob(SECRET, 'oauth-refresh', access, now), null, 'kind is part of the signature');
  assert.equal(verifyBlob('x'.repeat(SECRET.length), 'oauth-access', access, now), null);
  assert.equal(verifyBlob(SECRET, 'oauth-access', access, now + 60), null, 'expired');
  assert.equal(verifyBlob(SECRET, 'oauth-access', `${access}x`, now), null);
  assert.equal(verifyBlob(SECRET, 'oauth-access', null, now), null);
  const nonces = new ConsumedNonces(2);
  assert.equal(nonces.consume('a', now + 100, now), true);
  assert.equal(nonces.consume('a', now + 100, now), false);
  assert.equal(nonces.consume('b', now + 100, now), true);
  assert.equal(nonces.consume('c', now + 100, now), false, 'full');
  assert.equal(nonces.consume('c', now + 300, now + 200), true, 'swept after expiry');
});

function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

test('OAuth: dynamic registration, authorization request validation, PKCE exchange, replay and refresh', () => {
  const oauth = new OperatorOAuth(SECRET, () => NOW);
  assert.equal(validRedirectUri('https://claude.ai/api/mcp/auth_callback'), true);
  assert.equal(validRedirectUri('http://127.0.0.1:5173/callback'), true);
  assert.equal(validRedirectUri('http://evil.example/cb'), false);
  assert.equal(validRedirectUri('https://claude.ai/cb#frag'), false);
  assert.equal(oauth.register({ redirect_uris: ['http://evil.example/cb'] }), null);
  assert.equal(oauth.register({ redirect_uris: [] }), null);
  const client = oauth.register({ redirect_uris: ['https://claude.ai/api/mcp/auth_callback'], client_name: 'Claude' })!;
  assert.equal(client.name, 'Claude');
  assert.equal(oauth.client(client.id)?.redirectUris[0], 'https://claude.ai/api/mcp/auth_callback');
  assert.equal(oauth.client(`${client.id}x`), null);
  const { verifier, challenge } = pkce();
  const params = new URLSearchParams({ response_type: 'code', client_id: client.id, redirect_uri: 'https://claude.ai/api/mcp/auth_callback', code_challenge: challenge, code_challenge_method: 'S256', state: 'abc', scope: 'operator' });
  const request = oauth.authorizationRequest(params)!;
  assert.equal(request.state, 'abc');
  for (const [k, v] of [['redirect_uri', 'https://claude.ai/other'], ['code_challenge_method', 'plain'], ['response_type', 'token'], ['scope', 'admin'], ['code_challenge', 'short']] as const) {
    const bad = new URLSearchParams(params); bad.set(k, v);
    assert.equal(oauth.authorizationRequest(bad), null, `${k}=${v}`);
  }
  const code = oauth.issueCode(request.client, request.redirectUri, request.challenge, USER);
  const form = (over: Record<string, string> = {}) => new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: 'https://claude.ai/api/mcp/auth_callback', client_id: client.id, code_verifier: verifier, ...over });
  assert.equal(oauth.exchange(form({ code_verifier: randomBytes(32).toString('base64url') })).body.error, 'invalid_grant', 'wrong verifier');
  assert.equal(oauth.exchange(form({ redirect_uri: 'https://claude.ai/other' })).body.error, 'invalid_grant', 'wrong redirect');
  assert.equal(oauth.exchange(form({ client_id: oauth.register({ redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] })!.id })).body.error, 'invalid_grant', 'another client');
  const ok = oauth.exchange(form());
  assert.equal(ok.status, 200);
  const tokens = ok.body as Record<string, string>;
  assert.equal(tokens.token_type, 'Bearer');
  assert.equal(oauth.subject(tokens.access_token!), USER);
  assert.equal(oauth.exchange(form()).body.error, 'invalid_grant', 'a code is single use');
  NOW += 3601_000;
  assert.equal(oauth.subject(tokens.access_token!), null, 'access tokens live one hour');
  const refreshed = oauth.exchange(new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token!, client_id: client.id }));
  assert.equal(refreshed.status, 200);
  assert.equal(oauth.subject((refreshed.body as Record<string, string>).access_token!), USER);
  assert.equal(oauth.exchange(new URLSearchParams({ grant_type: 'password' })).body.error, 'unsupported_grant_type');
  NOW -= 3601_000;
  const metadata = authorizationServerMetadata(ORIGIN);
  assert.equal(metadata.token_endpoint, `${ORIGIN}${OPERATOR_OAUTH_PATHS.token}`);
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
  const mount = createOperatorMount({ config, origin: ORIGIN, tools: stubHost(true), sessionSecret: SESSION_SECRET, now: () => NOW,
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

  const oauthOnly = createOperatorMount({ config: loadOperatorConfig({ R72_OPERATOR_OAUTH_SECRET: SECRET, R72_OPERATOR_USER_ID: USER })!, origin: ORIGIN, tools: stubHost(false), sessionSecret: SESSION_SECRET, now: () => NOW, auth: { resolve: async () => null } });
  const r = response();
  await oauthOnly.handle(request('POST', OPERATOR_MCP_PATH, rpc, { authorization: `Bearer ${TOKEN}` }), r.res, new URL(`${ORIGIN}${OPERATOR_MCP_PATH}`));
  assert.equal(r.captured.status, 401, 'no static token when only OAuth is configured');
  const tokenOnly = createOperatorMount({ config: loadOperatorConfig({ R72_OPERATOR_TOKEN: TOKEN, R72_OPERATOR_USER_ID: USER })!, origin: ORIGIN, tools: stubHost(false), sessionSecret: SESSION_SECRET, now: () => NOW, auth: { resolve: async () => null } });
  const m = response();
  await tokenOnly.handle(request('GET', OPERATOR_OAUTH_PATHS.authorizationServer), m.res, new URL(`${ORIGIN}${OPERATOR_OAUTH_PATHS.authorizationServer}`));
  assert.equal(m.captured.status, 404, 'no OAuth metadata without a secret');
});
