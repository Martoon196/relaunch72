/**
 * Group HQ handoff on a disposable PostgreSQL (migration 0147) with the actual
 * r72_identity_command, r72_content_command and r72_crm_command roles: delegated
 * sessions for both audiences, the founder's webinar listing bridge, and the
 * worker's automatic CRM handoff acting as the webinar's creator.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { openTestDatabase, testDatabaseSkipReason } from './database-helper.js';
import { loginRole, seedBrand, sha } from './webinar-harness.js';
import { CrmCommandService, createPgCrmTransactionRunner } from '../../src/crm-pg/index.js';
import { PgPortalAuthService } from '../../src/portal/auth-pg-service.js';
import { PgMhpAuthService } from '../../src/mhp/auth-service.js';
import { createGroupHqWebinarsReadMount } from '../../src/integrations/group-hq-crm/webinars.js';
import { loadWebinarConfig } from '../../src/webinars/config.js';
import type { WebinarMailer } from '../../src/webinars/messages.js';
import { PgWebinarService } from '../../src/webinars/service.js';
import { DEFAULT_SETTINGS, readSettings } from '../../src/webinars/types.js';
import { WebinarWorker } from '../../src/webinars/worker.js';

const skip = testDatabaseSkipReason();

function response() {
  return {
    status: 0, headers: {} as Record<string, string>, body: '',
    writeHead(status: number, headers: Record<string, string>) { this.status = status; this.headers = headers; },
    end(body: string) { this.body = body; },
  };
}

test('0147 Group HQ handoff: delegated sessions, webinar bridge and automatic CRM handoff on actual roles', { skip, timeout: 300_000 }, async () => {
  const admin = await openTestDatabase();
  const identityPool = await loginRole(admin, 'r72_identity_command');
  const content = await loginRole(admin, 'r72_content_command');
  const crmPool = await loginRole(admin, 'r72_crm_command');
  try {
    const a = await seedBrand(admin, 'Alpha');
    const b = await seedBrand(admin, 'Bravo');
    const orgOf = async (ws: string) => String((await admin.query('SELECT organization_id FROM app.workspaces WHERE id = $1', [ws])).rows[0]!.organization_id);
    // Delegated sessions expire relative to the database clock, so the test clock is real time.
    let clock = Date.now();
    const context = () => ({ now: clock, sourceHash: Buffer.alloc(32, 3), userAgent: 'synthetic-browser' });

    // â”€â”€ delegated sessions: PP audience â”€â”€
    const auth = new PgPortalAuthService({ readPool: admin, commandPool: identityPool });
    const session = await auth.loginDelegated({ userId: a.owner.userId, workspaceId: a.ws }, context());
    assert.ok(session, 'an active owner gets a session');
    assert.equal(session.userId, a.owner.userId);
    assert.equal(session.workspaceId, a.ws);
    assert.equal(session.userEmail, a.owner.userEmail);
    assert.equal(Date.parse(session.expiresAt!) - clock <= 12 * 3_600_000 + 5_000, true, 'bounded to twelve hours');
    const resolved = await auth.resolve(session.sessionToken, clock);
    assert.deepEqual(resolved, { sessionToken: session.sessionToken, userId: a.owner.userId, userEmail: a.owner.userEmail, workspaceId: a.ws });
    const audience = await admin.query('SELECT product_audience, ip_hash IS NOT NULL AS ip, user_agent_hash IS NOT NULL AS ua FROM app.user_sessions WHERE token_hash = $1', [Buffer.from(sha(session.sessionToken), 'hex')]);
    assert.equal(audience.rowCount, 1);
    // Different server instances race the same trusted handoff token against
    // the shared unique session hash: exactly one may mint a session.
    const handoffSessionToken = randomBytes(32).toString('base64url');
    const otherAuth = new PgPortalAuthService({ readPool: admin, commandPool: identityPool });
    const raced = await Promise.all([auth, otherAuth].map(instance => instance.loginDelegated({
      userId: a.owner.userId, workspaceId: a.ws, handoffSessionToken,
    }, context())));
    assert.equal(raced.filter(Boolean).length, 1);
    assert.equal(await otherAuth.loginDelegated({ userId: a.owner.userId, workspaceId: a.ws, handoffSessionToken }, context()), null);
    assert.deepEqual(audience.rows[0], { product_audience: 'property_predator_growth', ip: true, ua: true });
    assert.equal(await auth.loginDelegated({ userId: a.viewer.userId, workspaceId: a.ws }, context()), null, 'a viewer is not an owner');
    assert.equal(await auth.loginDelegated({ userId: a.owner.userId, workspaceId: b.ws }, context()), null, 'owner of another brand is refused');
    assert.equal(await auth.loginDelegated({ userId: randomUUID(), workspaceId: a.ws }, context()), null, 'unknown user');
    assert.equal(await auth.loginDelegated({ userId: 'nope', workspaceId: a.ws }, context()), null);
    await assert.rejects(auth.loginDelegated({ userId: a.owner.userId, workspaceId: a.ws }, { now: clock }), /source evidence/, 'source evidence is mandatory');

    // â”€â”€ delegated sessions: MHP audience only lands in the MHP marketing workspace â”€â”€
    const mhpAuth = new PgMhpAuthService({ readPool: admin, commandPool: identityPool });
    assert.equal(await mhpAuth.loginDelegated({ userId: a.owner.userId, workspaceId: a.ws }, context()), null, 'an ordinary workspace is not the MHP marketing workspace');
    assert.equal((await admin.query("SELECT count(*)::int AS n FROM app.user_sessions WHERE user_id = $1 AND product_audience = 'martin_howard_property'", [a.owner.userId])).rows[0]!.n, 0);

    // â”€â”€ webinar bridge for Group HQ â”€â”€
    const webinarConfig = loadWebinarConfig({ WEBINAR_ACCESS_SECRET: 's'.repeat(40), WEBINAR_PUBLIC_ORIGIN: 'https://app.example.test' });
    const crm = { commands: new CrmCommandService({ transactionRunner: createPgCrmTransactionRunner(crmPool) }), pool: crmPool };
    const svc = new PgWebinarService({ pool: content, config: webinarConfig, stream: null, crm, now: () => clock });
    const req = () => randomUUID();
    const edit = (over: Partial<Parameters<PgWebinarService['create']>[2]> = {}) => ({
      kind: 'live' as const, title: 'Unregistered land: how to buy it', summary: 'Synthetic fixture.', presenterName: 'Sam Host', presenterTitle: 'Founder',
      timezone: 'Europe/London', startsLocal: '2026-11-25T19:00', durationMinutes: 60, capacity: 50,
      settings: readSettings({ ...DEFAULT_SETTINGS }), ...over,
    });
    const autoId = await svc.create(a.owner, req(), edit());
    await svc.setStatus(a.owner, req(), autoId, 'publish');
    const manualId = await svc.create(a.owner, req(), edit({ title: 'Manual handoff', settings: readSettings({ ...DEFAULT_SETTINGS, crmAutoHandoff: false }) }));
    await svc.setStatus(a.owner, req(), manualId, 'publish');
    const token = 'group-hq-bridge-token-synthetic-0123456789';
    const bridge = createGroupHqWebinarsReadMount(content, {
      token, workspaceId: a.ws, organizationId: await orgOf(a.ws), ownerUserId: a.owner.userId,
      mhp: { workspaceId: b.ws, organizationId: await orgOf(b.ws) },
    }, webinarConfig);
    const call = async (authorization: string | undefined, url: string) => {
      const res = response();
      await bridge.handle({ method: 'GET', headers: authorization ? { authorization } : {} } as never, res as never, new URL(url));
      return res;
    };
    assert.equal((await call(undefined, 'https://hq.example/api/group-hq/webinars?brand=pp')).status, 401);
    assert.equal((await call(`Bearer ${token}`, 'https://hq.example/api/group-hq/webinars?brand=nope')).status, 400);
    const pp = await call(`Bearer ${token}`, 'https://hq.example/api/group-hq/webinars?brand=pp');
    assert.equal(pp.status, 200);
    const listed = JSON.parse(pp.body);
    assert.equal(listed.availability, 'available');
    assert.equal(listed.workspace.id, a.ws);
    assert.equal(listed.webinars.length, 2);
    const auto = listed.webinars.find((w: { id: string }) => w.id === autoId);
    assert.equal(auto.status, 'published');
    assert.equal(auto.registered, 0);
    assert.match(auto.publicUrl, /^https:\/\/app\.example\.test\/w\/[a-z0-9-]+$/);
    assert.deepEqual(auto.paths, { manage: `/portal/webinars/${autoId}`, host: `/portal/webinars/${autoId}/host`, studio: `/portal/webinars/${autoId}/studio`, people: `/portal/webinars/${autoId}/people` });
    assert.doesNotMatch(pp.body, /token|secret|@example\.test/i, 'the listing carries no secrets or attendee data');
    const mhp = await call(`Bearer ${token}`, 'https://hq.example/api/group-hq/webinars?brand=mhp');
    assert.equal(JSON.parse(mhp.body).availability, 'not_available', 'the configured owner cannot manage the other brand');

    // â”€â”€ automatic CRM handoff by the worker, acting as the creator â”€â”€
    const key = (await svc.get(a.owner, req(), autoId)).event.publicKey;
    const manualKey = (await svc.get(a.owner, req(), manualId)).event.publicKey;
    const legacyId = await svc.create(a.owner, req(), edit({ title: 'Legacy webinar without saved auto-import choice' }));
    await admin.query("UPDATE app.webinar_events SET settings=settings-'crmAutoHandoff' WHERE id=$1", [legacyId]);
    await svc.setStatus(a.owner, req(), legacyId, 'publish');
    const legacyKey = (await svc.get(a.owner, req(), legacyId)).event.publicKey;
    const consent = { serviceNotice: 'x', marketing: false, version: 'webinar-1' };
    for (const [k, email, marketing] of [[key, 'ann@example.test', true], [key, 'bob@example.test', false], [manualKey, 'cat@example.test', false], [legacyKey, 'dan@example.test', false]] as const) {
      assert.equal((await svc.register(k, { email, name: email.split('@')[0]!, answers: {}, marketing, consent, attribution: { utm_source: 'whatsapp' } })).outcome, 'created');
    }
    const mailer: WebinarMailer = { send: async () => ({ outcome: 'sent', messageId: randomUUID() }) };
    const worker = new WebinarWorker({ pool: content, config: webinarConfig, stream: null, mailer, webinars: svc, now: () => clock });
    const stats = await worker.tick();
    assert.equal(stats.crmHandoffEvents, 1, 'only the webinar with automatic handoff on is processed');
    assert.equal(stats.crmHandoffLinked, 2);
    assert.equal(stats.crmHandoffFailed ?? 0, 0);
    const linked = await admin.query<{ email: string; linked: boolean }>('SELECT email, crm_contact_id IS NOT NULL AS linked FROM app.webinar_registrations WHERE workspace_id = $1 ORDER BY email', [a.ws]);
    assert.deepEqual(linked.rows, [{ email: 'ann@example.test', linked: true }, { email: 'bob@example.test', linked: true }, { email: 'cat@example.test', linked: false }, { email: 'dan@example.test', linked: false }]);
    const leads = await admin.query<{ display_name: string; owner_user_id: string; source: string }>('SELECT c.display_name, c.owner_user_id, c.source FROM app.contacts c WHERE c.workspace_id = $1 ORDER BY c.display_name', [a.ws]);
    assert.deepEqual(leads.rows.map((r) => [r.display_name, r.owner_user_id, r.source.startsWith(`webinar:${key}:`)]), [['ann', a.owner.userId, true], ['bob', a.owner.userId, true]]);
    const consentRows = await admin.query<{ value: string; consent_status: string }>("SELECT value, consent_status FROM app.contact_points WHERE workspace_id = $1 AND kind = 'email' ORDER BY value", [a.ws]);
    assert.deepEqual(consentRows.rows, [{ value: 'ann@example.test', consent_status: 'opted_in' }, { value: 'bob@example.test', consent_status: 'unknown' }]);
    clock += 60_000;
    const again = await worker.tick();
    assert.equal(again.crmHandoffEvents ?? 0, 0, 'nothing left to hand off');
    const bridged = JSON.parse((await call(`Bearer ${token}`, 'https://hq.example/api/group-hq/webinars?brand=pp')).body);
    assert.equal(bridged.webinars.find((w: { id: string }) => w.id === autoId).crmLinked, 2);
    // Manual send still works for the webinar that opted out.
    const manual = await svc.sendToCrm(a.owner, req(), manualId);
    assert.deepEqual([manual.linked, manual.remaining], [1, 0]);
  } finally {
    await Promise.all([identityPool.end(), content.end(), crmPool.end()]);
    await admin.end();
  }
});
