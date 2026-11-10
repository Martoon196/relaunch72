/**
 * Operator API on a disposable PostgreSQL with the actual roles: delegated sessions
 * through r72_identity_command, CRM tools through r72_web / r72_crm_command and
 * webinar tools through r72_content_command, all acting as the configured user.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { openTestDatabase, testDatabaseSkipReason } from './database-helper.js';
import { loginRole, seedBrand } from './webinar-harness.js';
import { CrmCommandService, createPgCrmTransactionRunner } from '../../src/crm-pg/index.js';
import { loadOperatorConfig } from '../../src/operator/config.js';
import { OperatorSessions } from '../../src/operator/sessions.js';
import { OperatorOAuth } from '../../src/operator/oauth.js';
import { PgOperatorOAuthStore } from '../../src/operator/oauth-store.js';
import { createOperatorTools } from '../../src/operator/tools.js';
import { PgPortalAuthService } from '../../src/portal/auth-pg-service.js';
import { createPgPortalCrmService } from '../../src/portal/crm-pg-service.js';
import { loadWebinarConfig } from '../../src/webinars/config.js';
import { PgWebinarService } from '../../src/webinars/service.js';

const skip = testDatabaseSkipReason();

test('operator tools act as the configured owner through delegated sessions on actual roles', { skip, timeout: 300_000 }, async () => {
  const admin = await openTestDatabase();
  const identityPool = await loginRole(admin, 'r72_identity_command');
  const webPool = await loginRole(admin, 'r72_web');
  const crmPool = await loginRole(admin, 'r72_crm_command');
  const content = await loginRole(admin, 'r72_content_command');
  try {
    const a = await seedBrand(admin, 'Alpha');
    const b = await seedBrand(admin, 'Bravo');
    const auth = new PgPortalAuthService({ readPool: webPool, commandPool: identityPool });
    const crm = createPgPortalCrmService({ webPool, commandPool: crmPool, cursorSecret: 'cursor-secret-synthetic-at-least-32-chars!!' });
    const webinarConfig = loadWebinarConfig({ WEBINAR_ACCESS_SECRET: 's'.repeat(40), WEBINAR_PUBLIC_ORIGIN: 'https://app.example.test' });
    const webinars = new PgWebinarService({ pool: content, config: webinarConfig, stream: null,
      crm: { commands: new CrmCommandService({ transactionRunner: createPgCrmTransactionRunner(crmPool) }), pool: crmPool } });
    const env = { R72_OPERATOR_TOKEN: 't'.repeat(40), R72_OPERATOR_USER_ID: a.owner.userId, R72_GROUP_HQ_CRM_PP_WORKSPACE_ID: a.ws, R72_OPERATOR_WRITES: 'enabled' };
    const tools = createOperatorTools({ sessions: new OperatorSessions(loadOperatorConfig(env)!, { pp: auth, mhp: undefined }), crm, webinars, writes: true });

    const overview = await tools.callTool('workspace_overview', { brand: 'pp' }) as { workspace: { id: string; canWrite: boolean }; stages: { id: string; name: string }[] };
    assert.equal(overview.workspace.id, a.ws);
    assert.equal(overview.workspace.canWrite, true);
    const stage = overview.stages.find((s) => s.name === 'New')!;
    const created = await tools.callTool('crm_create_lead', { brand: 'pp', commandKey: 'operator.test.lead-1', displayName: 'Land Buyer', email: 'buyer@example.test', opportunityTitle: 'Unregistered plot', stageId: stage.id, taskTitle: 'Call back' });
    assert.deepEqual(created, { ok: true, disposition: 'applied' });
    assert.deepEqual(await tools.callTool('crm_create_lead', { brand: 'pp', commandKey: 'operator.test.lead-1', displayName: 'Land Buyer', email: 'buyer@example.test', opportunityTitle: 'Unregistered plot', stageId: stage.id, taskTitle: 'Call back' }), { ok: true, disposition: 'replayed' }, 'same command key and payload replays');
    await assert.rejects(tools.callTool('crm_create_lead', { brand: 'pp', commandKey: 'operator.test.lead-1', displayName: 'Someone Else', email: 'buyer@example.test', opportunityTitle: 'Unregistered plot', stageId: stage.id, taskTitle: 'Call back' }), /conflict/, 'same key with a different payload is refused');
    const contacts = await tools.callTool('crm_contacts', { brand: 'pp' }) as { contacts: { displayName: string; id: string }[] };
    assert.ok(contacts.contacts.some((c) => c.displayName === 'Land Buyer'));
    const pipeline = await tools.callTool('crm_pipeline', { brand: 'pp' }) as { opportunities: { title: string; rowVersion: number; id: string }[] };
    assert.ok(pipeline.opportunities.some((o) => o.title === 'Unregistered plot'));
    const tasks = await tools.callTool('crm_tasks', { brand: 'pp', filter: 'open' }) as { tasks: { title: string; id: string; rowVersion: number }[] };
    const task = tasks.tasks.find((t) => t.title === 'Call back')!;
    assert.deepEqual(await tools.callTool('crm_complete_task', { brand: 'pp', taskId: task.id, expectedRowVersion: task.rowVersion }), { ok: true, disposition: 'applied' });
    await assert.rejects(tools.callTool('crm_complete_task', { brand: 'pp', taskId: task.id, expectedRowVersion: task.rowVersion + 10, commandKey: 'operator.test.stale' }), /conflict|not_found/);
    const lead = await tools.callTool('crm_lead_360', { brand: 'pp', contactId: contacts.contacts.find((c) => c.displayName === 'Land Buyer')!.id }) as { identity: { displayName: string } };
    assert.equal(lead.identity.displayName, 'Land Buyer');

    const webinar = await tools.callTool('webinar_create', { brand: 'pp', title: 'Unregistered land', presenterName: 'Martin', startsLocal: '2026-11-25T19:00', durationMinutes: 60, settings: { crmAutoHandoff: false } }) as { event: { id: string; status: string; title: string; settings: { crmAutoHandoff: boolean } }; rowVersion: number };
    assert.deepEqual([webinar.event.status, webinar.event.title, webinar.event.settings.crmAutoHandoff], ['draft', 'Unregistered land', false]);
    const published = await tools.callTool('webinar_set_status', { brand: 'pp', id: webinar.event.id, action: 'publish' }) as { event: { status: string }; rowVersion: number };
    assert.equal(published.event.status, 'published');
    const updated = await tools.callTool('webinar_update', { brand: 'pp', id: webinar.event.id, rowVersion: published.rowVersion, summary: 'How to buy it.' }) as { webinar: { event: { summary: string; title: string; startsAt: string } } };
    assert.deepEqual([updated.webinar.event.title, updated.webinar.event.summary, updated.webinar.event.startsAt], ['Unregistered land', 'How to buy it.', '2026-11-25T19:00:00.000Z'], 'omitted fields keep their value');
    const list = await tools.callTool('webinars_list', { brand: 'pp' }) as { webinars: { event: { id: string } }[] };
    assert.equal(list.webinars.length, 1);
    assert.deepEqual(await tools.callTool('webinar_registrants', { brand: 'pp', id: webinar.event.id }), []);

    // The other brand's owner is not the operator: nothing of theirs is reachable, and a non-owner operator is refused.
    const bravoTools = createOperatorTools({ sessions: new OperatorSessions(loadOperatorConfig({ ...env, R72_OPERATOR_USER_ID: a.viewer.userId })!, { pp: auth, mhp: undefined }), crm, webinars, writes: true });
    await assert.rejects(bravoTools.callTool('workspace_overview', { brand: 'pp' }), /not an owner/);
    const crossTools = createOperatorTools({ sessions: new OperatorSessions(loadOperatorConfig({ ...env, R72_GROUP_HQ_CRM_PP_WORKSPACE_ID: b.ws })!, { pp: auth, mhp: undefined }), crm, webinars, writes: true });
    await assert.rejects(crossTools.callTool('webinars_list', { brand: 'pp' }), /not an owner/);
  } finally {
    await Promise.all([identityPool.end(), webPool.end(), crmPool.end(), content.end()]);
    await admin.end();
  }
});

test('0148 operator OAuth on actual roles: one redemption across instances, client-bound rotation, reuse and owner revocation', { skip, timeout: 300_000 }, async () => {
  const admin = await openTestDatabase();
  const instanceA = await loginRole(admin, 'r72_identity_command');
  // A second, independent pool with the same login stands in for a second server instance.
  const instanceB = new pg.Pool({ ...(instanceA as unknown as { options: pg.PoolConfig }).options, max: 6 });
  try {
    const a = await seedBrand(admin, 'Alpha');
    const secret = 'operator-oauth-secret-integration-0123456789';
    const oauthA = new OperatorOAuth(secret, new PgOperatorOAuthStore(instanceA));
    const oauthB = new OperatorOAuth(secret, new PgOperatorOAuthStore(instanceB));
    const client = oauthA.register({ redirect_uris: ['https://claude.ai/api/mcp/auth_callback'], client_name: 'Claude' })!;
    assert.equal(oauthB.client(client.id)?.name, 'Claude', 'client ids verify on every instance');
    const pkce = () => { const verifier = randomBytes(32).toString('base64url'); return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }; };
    const exchange = (oauth: OperatorOAuth, code: string, verifier: string) => oauth.exchange(new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: client.redirectUris[0]!, client_id: client.id, code_verifier: verifier }));

    // Nothing but hashes is stored.
    const p1 = pkce();
    const code = (await oauthA.issueCode(client, client.redirectUris[0]!, p1.challenge, a.owner.userId))!;
    const stored = await admin.query('SELECT code_hash FROM app_private.operator_oauth_codes');
    assert.equal(stored.rowCount, 1);
    assert.notEqual(stored.rows[0].code_hash.toString('base64url'), code);
    assert.equal(await oauthA.issueCode(client, client.redirectUris[0]!, p1.challenge, randomUUID()), null, 'unknown users get no code');

    // The same code presented to two instances at the same moment: exactly one wins.
    const [r1, r2] = await Promise.all([exchange(oauthA, code, p1.verifier), exchange(oauthB, code, p1.verifier)]);
    assert.deepEqual([r1.status, r2.status].sort(), [200, 400]);
    const winner = (r1.status === 200 ? r1 : r2).body as Record<string, string>;
    // The loser's replay revoked what the winner received.
    assert.equal(await oauthA.subject(winner.access_token!), null, 'a replayed code ends its connection');
    const reason = await admin.query("SELECT revoked_reason FROM app_private.operator_oauth_grants");
    assert.deepEqual(reason.rows.map((r) => r.revoked_reason), ['code_replay']);

    // A clean connection, refreshed on the other instance; the old refresh token is spent.
    const p2 = pkce();
    const code2 = (await oauthB.issueCode(client, client.redirectUris[0]!, p2.challenge, a.owner.userId))!;
    assert.equal((await exchange(oauthA, code2, pkce().verifier)).body.error, 'invalid_grant', 'wrong verifier');
    const t1 = (await exchange(oauthA, code2, p2.verifier)).body as Record<string, string>;
    assert.equal(await oauthB.subject(t1.access_token!), a.owner.userId, 'access tokens resolve on every instance');
    const refresh = (oauth: OperatorOAuth, token: string, clientId = client.id) => oauth.exchange(new URLSearchParams({ grant_type: 'refresh_token', refresh_token: token, client_id: clientId }));
    const t2 = (await refresh(oauthB, t1.refresh_token!)).body as Record<string, string>;
    assert.ok(t2.access_token && t2.refresh_token && t2.refresh_token !== t1.refresh_token);
    assert.equal(await oauthA.subject(t2.access_token!), a.owner.userId);
    assert.equal(await oauthA.subject(t1.access_token!), a.owner.userId, 'the earlier access token lives out its hour');
    assert.equal((await refresh(oauthA, t1.refresh_token!)).body.error, 'invalid_grant', 'a rotated refresh token is refused');
    assert.equal(await oauthA.subject(t2.access_token!), null, 'and presenting it again ends the whole connection');
    assert.equal((await refresh(oauthA, t2.refresh_token!)).body.error, 'invalid_grant');

    // Refresh tokens are bound to their client.
    const other = oauthA.register({ redirect_uris: ['https://claude.ai/api/mcp/auth_callback'], client_name: 'Other' })!;
    const p3 = pkce();
    const t3 = (await exchange(oauthA, (await oauthA.issueCode(client, client.redirectUris[0]!, p3.challenge, a.owner.userId))!, p3.verifier)).body as Record<string, string>;
    assert.equal((await refresh(oauthB, t3.refresh_token!, other.id)).body.error, 'invalid_grant');
    assert.equal(await oauthA.subject(t3.access_token!), null, 'a refresh token from another client ends the connection');

    // The owner lists and revokes; a revoked connection stops at once.
    const p4 = pkce();
    const t4 = (await exchange(oauthB, (await oauthB.issueCode(client, client.redirectUris[0]!, p4.challenge, a.owner.userId))!, p4.verifier)).body as Record<string, string>;
    const grants = await oauthA.listGrants(a.owner.userId);
    assert.equal(grants.length, 4);
    const live = grants.filter((g) => g.revokedAt === null);
    assert.equal(live.length, 1);
    assert.equal(await oauthA.revokeGrant(a.viewer.userId, live[0]!.grantId), false, 'only the subject can revoke it');
    assert.equal(await oauthA.revokeGrant(a.owner.userId, live[0]!.grantId), true);
    assert.equal(await oauthB.subject(t4.access_token!), null);
    assert.equal((await refresh(oauthA, t4.refresh_token!)).body.error, 'invalid_grant');
    const reasons = (await admin.query('SELECT revoked_reason FROM app_private.operator_oauth_grants ORDER BY created_at')).rows.map((r) => r.revoked_reason);
    assert.deepEqual(reasons, ['code_replay', 'refresh_reuse', 'client_mismatch', 'owner']);

    // RFC 7009 revocation by the client, and a deactivated user stops resolving.
    const p5 = pkce();
    const t5 = (await exchange(oauthA, (await oauthA.issueCode(client, client.redirectUris[0]!, p5.challenge, a.owner.userId))!, p5.verifier)).body as Record<string, string>;
    await oauthA.revoke(new URLSearchParams({ token: t5.access_token!, client_id: client.id }));
    assert.equal(await oauthA.subject(t5.access_token!), null);
    const p6 = pkce();
    const t6 = (await exchange(oauthA, (await oauthA.issueCode(client, client.redirectUris[0]!, p6.challenge, a.owner.userId))!, p6.verifier)).body as Record<string, string>;
    await admin.query("UPDATE app.users SET status = 'suspended' WHERE id = $1", [a.owner.userId]);
    assert.equal(await oauthA.subject(t6.access_token!), null, 'a suspended user cannot use a live token');
    assert.equal((await refresh(oauthA, t6.refresh_token!)).body.error, 'invalid_grant');

    // The identity role cannot read the tables directly.
    await assert.rejects(instanceA.query('SELECT 1 FROM app_private.operator_oauth_tokens'), /permission denied/);
  } finally {
    await Promise.all([instanceA.end(), instanceB.end()]);
    await admin.end();
  }
});
