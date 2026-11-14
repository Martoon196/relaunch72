/**
 * The independent review of 0156, as tests on a disposable PostgreSQL with the real roles (each was a probe script):
 *   - a hold or a full cap that outlasts a flow's retry window fails nobody, and the held people then go in order (B2);
 *   - the send path reads by index at a year of volume (S1), and pruning removes only rows no decision reads;
 *   - tests never dilute a rate (S2); late bounces after a founder lift change nothing (S5); a switch-off counts as a
 *     pause for the 90-day rule (S6); a reconnect on a new domain needs a new test and the founder again and restarts
 *     the ramp, the same domain keeps its step (S7); apply refuses caps off the ramp and a sample passed early;
 *   - disconnecting while held holds (B1); tests to the business's own list go while the owner has paused.
 * Postmark is not involved. All people and values are synthetic.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { openTestDatabase, ownerQuery, resetIdentityTables, testDatabaseSkipReason } from './database-helper.js';
import { loginRole } from './webinar-harness.js';
import { EMAIL_TERMS_VERSION, EmailConnectionVault, PgEmailConnectionStore } from '../../src/email-connections/index.js';
import { EmailProtectionService, PgEmailProtectionStore, sendingPlan } from '../../src/email-protection/index.js';
import { createPortalFollowupFlowService, PP_FOLLOWUP_CAMPAIGN } from '../../src/portal/followup-flow-service.js';
import { buildSequence } from '../../src/operator/sequence-builder.js';
import { PgPpFollowupQueue } from '../../src/pp-followup/repository.js';
import type { PortalSessionIdentity } from '../../src/portal/auth-service.js';

const skip = testDatabaseSkipReason();
const PP = 'd975ff66-336a-46c2-b36b-d7095a11af97', OTHER_WS = '0b156000-0000-4000-8000-000000000012';
const DOMAIN = 'mail.pp-review-proof.co.uk', NEW_DOMAIN = 'mail.brand-new-review.co.uk';
const vault = new EmailConnectionVault(Buffer.alloc(32, 9));
type Admin = Awaited<ReturnType<typeof openTestDatabase>>;

async function session(admin: Admin, user: string, workspace: string): Promise<string> {
  const token = `email-review-${randomUUID()}${randomUUID()}`;
  await ownerQuery(admin, `INSERT INTO app.user_sessions(token_hash,csrf_secret_hash,user_id,selected_workspace_id,expires_at) VALUES($1,$2,$3,$4,now()+interval '2 hours')`,
    [createHash('sha256').update(token).digest(), createHash('sha256').update(`csrf${token}`).digest(), user, workspace]);
  return token;
}
async function people(admin: Admin) {
  await resetIdentityTables(admin);
  for (const table of ['email_send_events', 'email_protection_alerts', 'email_sending_controls', 'email_protection_events', 'email_connection_events', 'email_connections', 'email_account_events']) {
    await ownerQuery(admin, `DELETE FROM app_private.${table}`).catch(() => undefined);
  }
  await ownerQuery(admin, `UPDATE app_private.email_account_protection SET state='ok',reason=NULL,since=NULL,counted_since=NULL`);
  const org = randomUUID(), otherOrg = randomUUID(), owner = randomUUID(), founder = randomUUID();
  await ownerQuery(admin, `DO $s$ BEGIN
    PERFORM set_config('app.request_id','email-review-fixture',true);
    INSERT INTO app.organizations(id,name,slug,kind) VALUES('${org}','Property Predator','pp-review-proof','direct_customer'),('${otherOrg}','Other','other-review-proof','direct_customer');
    INSERT INTO app.workspaces(id,organization_id,name,slug,timezone) VALUES('${PP}','${org}','Property Predator Growth HQ','pp-review-proof','Europe/London'),('${OTHER_WS}','${otherOrg}','Other','other-review-proof','Europe/London');
    INSERT INTO app.users(id,email,display_name,status,email_verified_at) VALUES('${owner}','owner-review@pp-review-proof.co.uk','Pat Owner','active',clock_timestamp()),
     ('${founder}','founder-review@pp-review-proof.co.uk','Fay Founder','active',clock_timestamp());
    INSERT INTO app.organization_memberships(organization_id,user_id,role,status) VALUES('${org}','${owner}','owner','active'),('${otherOrg}','${founder}','billing','active');
    INSERT INTO app.workspace_memberships(workspace_id,organization_id,user_id,role,status) VALUES('${PP}','${org}','${owner}','owner','active'),('${OTHER_WS}','${otherOrg}','${founder}','viewer','active');
  END $s$`);
  await ownerQuery(admin, 'INSERT INTO app_private.seo_limit_operators(user_id) VALUES($1) ON CONFLICT DO NOTHING', [founder]);
  return { org, owner, founder, ownerToken: await session(admin, owner, PP), founderToken: await session(admin, founder, OTHER_WS) };
}
async function connect(connections: PgEmailConnectionStore, token: string, domain: string, first: boolean): Promise<void> {
  if (first) await connections.acceptTerms(token, PP, EMAIL_TERMS_VERSION);
  assert.equal(await connections.begin(token, PP, { domain, fromName: 'Property Predator', fromAddress: `hello@${domain}`, replyTo: null }, EMAIL_TERMS_VERSION), 'started');
  await connections.intend(token, PP, 'server');
  await connections.saveSealed(token, PP, 'server_token', vault.seal(PP, 'server_token', 'srv-token-review-proof-0123456789'));
  await connections.record(token, PP, 'server', 'created', { serverId: 6161 });
  await connections.intend(token, PP, 'stream'); await connections.record(token, PP, 'stream', 'created', { stream: 'broadcast' });
  await connections.intend(token, PP, 'secret'); await connections.saveSealed(token, PP, 'webhook_secret', vault.seal(PP, 'webhook_secret', 'whsec-review-proof-0123456789-abcdef'));
  await connections.intend(token, PP, 'webhook'); await connections.record(token, PP, 'webhook', 'created', { webhookId: 91 });
  await connections.intend(token, PP, 'domain');
  const dns = { dkim: { host: `x._domainkey.${domain}`, value: 'k=rsa; p=X', verified: true }, returnPath: { host: `pm.${domain}`, value: 'pm.mtasv.net', verified: true } };
  await connections.record(token, PP, 'domain', 'created', { domainId: first ? 901 : 902, dns });
  assert.equal(await connections.checked(token, PP, dns, true, true), 'verified');
}
/** Connected, footer saved, a test accepted, asked, approved by the founder: live. */
async function goLive(store: PgEmailProtectionStore, ownerToken: string, founderToken: string): Promise<void> {
  await store.details(ownerToken, PP, { businessName: 'Property Predator Ltd', postalAddress: '1 High Street, Leeds LS1 1AA', testRecipients: [] });
  const key = `test:${randomUUID()}:0`;
  assert.equal(await store.testReserve(ownerToken, PP, key), 'ok');
  await store.testResult(ownerToken, PP, key, true);
  assert.equal(await store.command(ownerToken, PP, 'live', EMAIL_TERMS_VERSION, true), 'requested');
  const status = await store.founderView(founderToken);
  assert.equal(await store.founderAct(founderToken, PP, 'approve', status.businesses[0]!.rowVersion), 'done');
}
const seedSends = (admin: Admin, n: number, purpose: 'live' | 'test', ago = '1 hour') => ownerQuery(admin, `INSERT INTO app_private.email_send_events(workspace_id,kind,event_key,purpose,state,occurred_at,settled_at)
  SELECT $1,'send','seed:'||gen_random_uuid(),$2,'accepted',now()-$4::interval,now() FROM generate_series(1,$3)`, [PP, purpose, n, ago]);
const seedFacts = (admin: Admin, n: number, kind: string, ago = '10 minutes') => ownerQuery(admin, `INSERT INTO app_private.email_send_events(workspace_id,kind,event_key,state,occurred_at)
  SELECT $1,$2,'bounce:'||gen_random_uuid(),'fact',now()-$4::interval FROM generate_series(1,$3)`, [PP, kind, n, ago]);

test('0156 review on real roles: B1, S2, S5, S6, S7, the apply checks, tests while owner-paused, and pruning', { skip, timeout: 300_000 }, async () => {
  const admin = await openTestDatabase();
  const identity = await loginRole(admin, 'r72_identity_command');
  try {
    const { ownerToken, founderToken } = await people(admin);
    const connections = new PgEmailConnectionStore(identity), store = new PgEmailProtectionStore(identity);
    await connect(connections, ownerToken, DOMAIN, true);
    await goLive(store, ownerToken, founderToken);
    const counts = async () => (await store.numbers())!.businesses.find(b => b.workspaceId === PP)!;
    const config = async () => (await store.sendingConfig(PP))!;
    assert.deepEqual([(await config()).mode, (await config()).approvedCurrent, (await config()).testCurrent], ['live', true, true]);

    // Tests to the business's own list still go while the owner has paused; marketing does not.
    assert.equal(await store.command(ownerToken, PP, 'pause', EMAIL_TERMS_VERSION, false), 'paused');
    assert.equal(await store.testReserve(ownerToken, PP, `test:${randomUUID()}:0`), 'ok');
    assert.equal(await store.reserve(PP, 'lease:owner-paused', 'live'), 'owner_paused');
    await store.command(ownerToken, PP, 'resume', EMAIL_TERMS_VERSION, false);

    // S2: 100 live sends and 5 bounces is the paused line; 155 test sends change nothing about it.
    await ownerQuery(admin, `UPDATE app_private.email_sending_controls SET sample_state='passed' WHERE workspace_id=$1`, [PP]);
    await seedSends(admin, 100, 'live'); await seedFacts(admin, 5, 'soft_bounce');
    await seedSends(admin, 155, 'test');
    let c = await counts();
    assert.deepEqual([c.sends7, c.soft7, c.sends30, c.last50Sends], [100, 5, 100, 50], 'live sends only in every denominator');
    const service = new EmailProtectionService({ store });
    assert.equal(await service.evaluate(PP), 'paused');

    // S5: the founder lifts; 5 late bounces arrive before anything new is sent: nothing changes.
    let status = await store.founderView(founderToken);
    assert.equal(await store.founderAct(founderToken, PP, 'lift', status.businesses[0]!.rowVersion), 'done');
    await seedFacts(admin, 5, 'hard_bounce', '1 second');
    c = await counts();
    assert.deepEqual([c.hard7, c.hardLast50, c.last50Sends, c.sends7, c.sampleBounces], [0, 0, 0, 0, 0], 'nothing counts before the first live send after the lift');
    assert.equal(await service.evaluate(PP), null, 'no step at all');
    assert.equal((await config()).protectionState, 'slowed');

    // S6: a switch-off counts as a pause for the 90-day rule (no "paused" in the last 90 days, a switch-off 80 days ago).
    await ownerQuery(admin, `DELETE FROM app_private.email_protection_events WHERE workspace_id=$1`, [PP]);
    await ownerQuery(admin, `INSERT INTO app_private.email_protection_events(workspace_id,kind,numbers,actor_kind,occurred_at) VALUES($1,'switched_off','{"cause":"own"}','system',now()-interval '80 days'),
      ($1,'paused','{"cause":"own"}','system',now()-interval '95 days')`, [PP]);
    const step = (to: string, kind: string | null, daily = 0, hourly = 0) => store.apply(PP, { from: 'slowed', to: to as never, kind, cause: 'own', reason: 'Proof.', numbers: {}, daily, hourly, step: null, stepAt: null, sample: null });
    assert.equal(await step('paused', 'paused'), 'off', 'a switch-off 80 days ago makes this pause the second');
    status = await store.founderView(founderToken);
    assert.equal(await store.founderAct(founderToken, PP, 'reinstate', status.businesses[0]!.rowVersion), 'done');

    // The apply checks: caps must be the ramp's (step 0, slowed: 25 and 7); the step may move only when its days are over;
    // a sample passes only 2 hours after its 50th email.
    assert.equal(await step('slowed', null, 100000, 100000), 'refused');
    assert.equal(await step('slowed', null, 25, 7), 'unchanged');
    assert.equal(await store.apply(PP, { from: 'slowed', to: 'slowed', kind: null, cause: null, reason: null, numbers: {}, daily: 125, hourly: 32, step: 5, stepAt: new Date().toISOString(), sample: null }), 'refused', 'no jump to step 5');
    await ownerQuery(admin, `UPDATE app_private.email_sending_controls SET sample_state='waiting',sample_full_at=now() WHERE workspace_id=$1`, [PP]);
    assert.equal(await store.apply(PP, { from: 'slowed', to: 'slowed', kind: 'sample_passed', cause: null, reason: null, numbers: {}, daily: 25, hourly: 7, step: null, stepAt: null, sample: 'passed' }), 'refused', 'not before its wait');
    await ownerQuery(admin, `UPDATE app_private.email_sending_controls SET sample_full_at=now()-interval '2 hours' WHERE workspace_id=$1`, [PP]);
    assert.equal(await store.apply(PP, { from: 'slowed', to: 'slowed', kind: 'sample_passed', cause: null, reason: null, numbers: {}, daily: 25, hourly: 7, step: null, stepAt: null, sample: 'passed' }), 'slowed');

    // Pruning: only rows older than 180 days AND older than the 50th latest live send.
    await seedSends(admin, 3, 'live', '200 days'); await seedFacts(admin, 2, 'hard_bounce', '200 days');
    const before = Number((await ownerQuery<{ n: string }>(admin, `SELECT count(*) n FROM app_private.email_send_events WHERE workspace_id=$1`, [PP]))[0]!.n);
    assert.equal(await store.prune(PP), 5);
    assert.equal(Number((await ownerQuery<{ n: string }>(admin, `SELECT count(*) n FROM app_private.email_send_events WHERE workspace_id=$1`, [PP]))[0]!.n), before - 5);

    // B1 on the database: a held sample, then the owner disconnects: the plan holds ("not connected"), never the env sender.
    await ownerQuery(admin, `UPDATE app_private.email_sending_controls SET sample_state='held' WHERE workspace_id=$1`, [PP]);
    await connections.disconnect(ownerToken, PP);
    const held = await config();
    assert.equal(held.status, 'disconnected');
    assert.deepEqual(sendingPlan(held, vault), { kind: 'hold', reason: 'not_connected', workspaceId: PP });

    await ownerQuery(admin, `DELETE FROM app_private.email_send_events WHERE workspace_id=$1`, [PP]);
    // S7: reconnect on a NEW domain: a new test and the founder's approval again, and the ramp from its first step.
    await ownerQuery(admin, `UPDATE app_private.email_sending_controls SET sample_state='passed',warmup_step=4 WHERE workspace_id=$1`, [PP]);
    await ownerQuery(admin, `UPDATE app_private.email_connections SET protection_state='ok',protection_reason=NULL,daily_cap=1000,hourly_cap=250 WHERE workspace_id=$1`, [PP]);
    await connect(connections, ownerToken, NEW_DOMAIN, false);
    let now = await config();
    assert.deepEqual([now.mode, now.approvedCurrent, now.testCurrent], ['live', false, false]);
    assert.equal(await store.reserve(PP, `lease:${randomUUID()}`, 'live'), 'not_approved');
    assert.equal(await store.command(ownerToken, PP, 'live', EMAIL_TERMS_VERSION, true), 'needs_test');
    const key = `test:${randomUUID()}:0`;
    await store.testReserve(ownerToken, PP, key); await store.testResult(ownerToken, PP, key, true);
    assert.equal(await store.command(ownerToken, PP, 'live', EMAIL_TERMS_VERSION, true), 'requested');
    status = await store.founderView(founderToken);
    await assert.rejects(store.founderAct(ownerToken, PP, 'approve', status.businesses[0]!.rowVersion));
    assert.equal(await store.founderAct(founderToken, PP, 'approve', status.businesses[0]!.rowVersion), 'done');
    const row = (await ownerQuery<{ warmup_step: number; daily_cap: number; hourly_cap: number; sample_state: string; approved_domain: string }>(admin,
      `SELECT s.warmup_step,c.daily_cap,c.hourly_cap,s.sample_state,s.approved_domain FROM app_private.email_connections c JOIN app_private.email_sending_controls s USING(workspace_id)`))[0]!;
    assert.deepEqual([row.warmup_step, row.daily_cap, row.hourly_cap, row.sample_state, row.approved_domain], [0, 50, 13, 'sending', NEW_DOMAIN]);
    assert.equal(await store.reserve(PP, `lease:${randomUUID()}`, 'live'), 'ok');
    // The SAME domain reconnected: the step is kept; only a new test is needed and the sample starts again.
    await ownerQuery(admin, `UPDATE app_private.email_sending_controls SET warmup_step=3,sample_state='passed' WHERE workspace_id=$1`, [PP]);
    await ownerQuery(admin, `UPDATE app_private.email_connections SET daily_cap=500,hourly_cap=125 WHERE workspace_id=$1`, [PP]);
    await connections.disconnect(ownerToken, PP);
    await connect(connections, ownerToken, NEW_DOMAIN, false);
    now = await config();
    assert.deepEqual([now.approvedCurrent, now.testCurrent], [true, false]);
    assert.equal(await store.reserve(PP, `lease:${randomUUID()}`, 'live'), 'needs_test');
    const again = `test:${randomUUID()}:0`;
    await store.testReserve(ownerToken, PP, again); await store.testResult(ownerToken, PP, again, true);
    assert.equal(await store.reserve(PP, `lease:${randomUUID()}`, 'live'), 'ok');
    const kept = (await ownerQuery<{ warmup_step: number; sample_state: string }>(admin, `SELECT warmup_step,sample_state FROM app_private.email_sending_controls`))[0]!;
    assert.deepEqual([kept.warmup_step, kept.sample_state], [3, 'sending'], 'step kept; the first 50 go first again');
    // The founder functions refuse the owner's session for every action.
    for (const action of ['approve', 'lift', 'reinstate', 'release_sample', 'lift_account'] as const) {
      await assert.rejects(store.founderAct(ownerToken, action === 'lift_account' ? null : PP, action, 1), { name: 'EmailProtectionForbiddenError' });
    }
  } finally {
    await identity.end();
    await admin.end();
  }
});

test('S1: at a year of 2,000 live sends a day the send path reads by index: no sequential scan of the counter table', { skip, timeout: 300_000 }, async () => {
  const admin = await openTestDatabase();
  const identity = await loginRole(admin, 'r72_identity_command');
  const one = new pg.Pool({ connectionString: (identity as unknown as { options: { connectionString: string } }).options.connectionString, max: 1 });
  try {
    const { ownerToken, founderToken } = await people(admin);
    const connections = new PgEmailConnectionStore(identity), store = new PgEmailProtectionStore(one);
    await connect(connections, ownerToken, DOMAIN, true);
    await goLive(new PgEmailProtectionStore(identity), ownerToken, founderToken);
    await ownerQuery(admin, `INSERT INTO app_private.email_send_events(workspace_id,kind,event_key,purpose,state,occurred_at,settled_at)
      SELECT $1,'send','seed:'||g,'live','accepted',now()-(g*43.2||' seconds')::interval,now() FROM generate_series(1,730000) g`, [PP]);
    await ownerQuery(admin, `INSERT INTO app_private.email_send_events(workspace_id,kind,event_key,state,occurred_at)
      SELECT $1,'soft_bounce','bounce:'||g,'fact',now()-(g*4320||' seconds')::interval FROM generate_series(1,7300) g`, [PP]);
    await ownerQuery(admin, 'ANALYZE app_private.email_send_events');
    await ownerQuery(admin, `UPDATE app_private.email_connections SET daily_cap=100000,hourly_cap=100000 WHERE workspace_id=$1`, [PP]);
    await ownerQuery(admin, `UPDATE app_private.email_sending_controls SET sample_state='passed',sample_started_at=now()-interval '365 days',warmup_step=4,warmup_step_at=now()-interval '330 days'`);
    const scans = async () => (await ownerQuery<{ seq: string; idx: string }>(admin, `SELECT seq_scan::text seq,coalesce(idx_scan,0)::text idx FROM pg_stat_user_tables WHERE relname='email_send_events'`))[0]!;
    const flush = async () => { await one.query('SELECT pg_stat_force_next_flush()'); await one.query('SELECT 1'); };
    await flush();
    const before = await scans();
    for (let i = 0; i < 6; i++) {
      await store.numbers();
      await store.sendingConfig(PP);
      assert.equal(await store.reserve(PP, `lease:perf${i}`, 'live'), 'ok');
      await store.settle(PP, `lease:perf${i}`, true);
      await store.count(PP, 'hard_bounce', `bounce:perf${i}`, Date.now());
    }
    await flush();
    const after = await scans();
    assert.equal(Number(after.seq) - Number(before.seq), 0, 'no sequential scan of email_send_events on the send path');
    assert.ok(Number(after.idx) > Number(before.idx), 'index scans instead');
  } finally {
    await ownerQuery(admin, 'DELETE FROM app_private.email_send_events').catch(() => undefined);
    await Promise.allSettled([one.end(), identity.end()]);
    await admin.end();
  }
});

test('B2: a hold or a full cap that outlasts the flow\'s retry window fails nobody; once it lifts they go first-due first', { skip, timeout: 300_000 }, async () => {
  const admin = await openTestDatabase();
  const identity = await loginRole(admin, 'r72_identity_command'), web = await loginRole(admin, 'r72_web');
  const adapter = await (async () => { const p = await loginRole(admin, 'r72_content_command'); return p; })();
  const password = randomUUID() + randomUUID();
  await admin.query(`ALTER ROLE r72_content_adapter PASSWORD '${password}'`);
  const adapterUrl = new URL(process.env.TEST_DATABASE_URL!); adapterUrl.username = 'r72_content_adapter'; adapterUrl.password = password;
  const contentAdapter = new pg.Pool({ connectionString: adapterUrl.toString(), max: 4 });
  try {
    const { org, owner, ownerToken } = await people(admin);
    const ownerId = { sessionToken: ownerToken, userId: owner, workspaceId: PP, userEmail: 'owner-review@pp-review-proof.co.uk' } as PortalSessionIdentity;
    const flows = createPortalFollowupFlowService({ webPool: web, adapterPool: contentAdapter, commandPool: adapter, workspaceId: PP,
      delivery: { identityPool: identity, status: { mode: 'live', ready: true, problems: [] } } });
    const request = () => `email-review-${randomUUID()}`.slice(0, 64);
    const built = buildSequence('pp', PP_FOLLOWUP_CAMPAIGN, { title: `Hold proof ${randomUUID().slice(0, 8)}`, retryWindowHours: 1, steps: [
      { email: { subject: 'Hello {{FIRSTNAME}}', body: 'Thanks.\n\n{{LINK}}\n\nUnsubscribe: {{UNSUBSCRIBE}}' } }] });
    const saved = await flows.save(ownerId, request(), { commandId: randomUUID(), contentItemId: '', previousVersionId: '', definition: built.definition, inlineMessages: built.inlineMessages });
    await flows.publish(ownerId, request(), saved.contentItemId, saved.contentVersionId, randomUUID());
    const people4: { name: string; point: string }[] = [];
    for (const name of ['Ann', 'Ben', 'Cal', 'Dee']) {
      const id = randomUUID(), point = randomUUID(), email = `${name.toLowerCase()}-${point.slice(0, 8)}@pp-review-proof.co.uk`;
      await admin.query("INSERT INTO app.contacts(id,workspace_id,display_name) VALUES($1,$2,$3)", [id, PP, `${name} Example`]);
      await admin.query("INSERT INTO app.contact_points(id,workspace_id,contact_id,kind,value,normalized_value,is_primary) VALUES($1,$2,$3,'email',$4,$4,true)", [point, PP, id, email]);
      await admin.query(`INSERT INTO app.communication_consent_events(workspace_id,contact_id,contact_point_id,channel,purpose,state,lawful_basis,source,actor_kind,occurred_at)
        VALUES($1,$2,$3,'email','marketing','granted','consent','pp.proof','system',now()-interval '1 hour')`, [PP, id, point]);
      const result = await flows.command(ownerId, request(), { action: 'enrol', commandId: randomUUID(), itemId: saved.contentItemId, versionId: saved.contentVersionId, contactPointId: point, runId: '', ackProofId: '' });
      assert.equal(result.changed, 1);
      people4.push({ name, point });
    }
    void org;
    const runs = async () => (await admin.query<{ contact_point_id: string; state: string; reason: string | null; due_at: Date }>(
      `SELECT contact_point_id,state,reason,due_at FROM app_private.pp_followup_runs WHERE workspace_id=$1 ORDER BY due_at,id`, [PP])).rows;
    // Dee is the control: due 2 hours ago (past her 1-hour window) and nothing restarts it: the claim fails her, as 0152 does.
    const dee = people4[3]!.point;
    await admin.query(`UPDATE app_private.pp_followup_runs SET due_at=now()-interval '2 hours' WHERE contact_point_id=$1`, [dee]);
    // The others are held: due 50, 40 and 30 minutes ago (Ann first), well inside... and then the hold goes on for hours.
    for (const [index, minutes] of [[0, 50], [1, 40], [2, 30]] as const) {
      await admin.query(`UPDATE app_private.pp_followup_runs SET due_at=now()-make_interval(mins=>$2) WHERE contact_point_id=$1`, [people4[index]!.point, minutes]);
    }
    const queue = new PgPpFollowupQueue(identity), store = new PgEmailProtectionStore(identity);
    // The control first (it must fail), restricted to Dee's address.
    const deeEmail = (await admin.query<{ normalized_value: string }>('SELECT normalized_value FROM app.contact_points WHERE id=$1', [dee])).rows[0]!.normalized_value;
    assert.deepEqual(await queue.claim(25, 120, [deeEmail]), []);
    assert.equal((await runs()).find(r => r.contact_point_id === dee)!.reason, 'delivery_expired', 'without the wait, a held person fails');
    // Three hours of hold, one sweep at a time: each sweep restarts the windows once the oldest has waited 20 minutes.
    for (let hour = 0; hour < 6; hour++) {
      assert.equal(await store.holdWait(), 3, 'the held runs were moved');
      // Half an hour passes while held.
      await admin.query(`UPDATE app_private.pp_followup_runs SET due_at=due_at-interval '30 minutes' WHERE state='active'`);
    }
    assert.equal(await store.holdWait(), 3);
    const held = (await runs()).filter(r => r.contact_point_id !== dee);
    assert.ok(held.every(r => r.state === 'active'), 'nobody failed');
    assert.deepEqual(held.map(r => r.contact_point_id), people4.slice(0, 3).map(p => p.point), 'still in their order');
    // The hold lifts: they are claimed first-due first and none is expired.
    const leases = await queue.claim(25, 120, null);
    assert.deepEqual(leases.map(l => l.email.split('-')[0]), ['ann', 'ben', 'cal'], 'first-due first');
    // A full cap: a step already claimed and handed back ("deferred") keeps its place and its window moves with it.
    await queue.settle(leases[0]!, 'deferred', null);
    for (const lease of leases.slice(1)) await queue.settle(lease, 'deferred', null);
    await admin.query(`UPDATE app_private.pp_followup_sends SET due_at=due_at-interval '50 minutes',expires_at=expires_at-interval '50 minutes',lease_until=now()-interval '1 second' WHERE workspace_id=$1`, [PP]);
    await admin.query(`UPDATE app_private.pp_followup_runs SET due_at=due_at-interval '50 minutes' WHERE state='active'`);
    assert.equal(await store.holdWait(), 3);
    const sends = (await admin.query<{ expires_at: Date }>(`SELECT expires_at FROM app_private.pp_followup_sends WHERE workspace_id=$1 AND sent_at IS NULL AND failed_at IS NULL`, [PP])).rows;
    assert.ok(sends.length === 3 && sends.every(s => s.expires_at.getTime() > Date.now() + 30 * 60_000), 'each handed-back step\'s window moved with it');
    const again = await queue.claim(25, 120, null);
    assert.equal(again.length, 3, 'nobody failed under the cap either');
    assert.deepEqual((await runs()).filter(r => r.contact_point_id !== dee).map(r => r.state), ['active', 'active', 'active']);
    // Nothing to do when nothing has waited: cheap and idempotent.
    assert.equal(await store.holdWait(), 0);
    await assert.rejects(web.query('SELECT app_private.pp_followup_hold_wait()'), /permission denied/u);
  } finally {
    await Promise.allSettled([identity.end(), web.end(), adapter.end(), contentAdapter.end()]);
    await admin.end();
  }
});
