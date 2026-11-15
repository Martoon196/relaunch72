/**
 * The second independent review of 0156, on a disposable PostgreSQL with the real roles:
 *   - B-1: test mode that lasts longer than a flow's retry window fails nobody already in it; after go-live the people
 *     outside the test list are sent to;
 *   - S-2: one run that cannot wait never makes the others move on every call; a step whose unknown outcome the owner
 *     acknowledged can wait;
 *   - S-1: a go-live request is only ever for the domain it was made for, reaches the founder for a new domain, and can
 *     never approve another one;
 *   - S-5: a reconnect never restarts a sample that is sending, waiting its 2 hours or held;
 *   - S-7: 'blocked' is its own counter, read only by the slowed line;
 *   - a replayed "Send a test to me" says what happened to the first attempt.
 * Postmark is never called: the sender's fetch is a stub. All people and values are synthetic.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { openTestDatabase, ownerQuery, resetIdentityTables, testDatabaseSkipReason } from './database-helper.js';
import { loginRole } from './webinar-harness.js';
import { EMAIL_TERMS_VERSION, EmailConnectionVault, PgEmailConnectionStore } from '../../src/email-connections/index.js';
import { founderToday, PgEmailProtectionStore, resolveSendingPlan } from '../../src/email-protection/index.js';
import { createPortalFollowupFlowService, PP_FOLLOWUP_CAMPAIGN } from '../../src/portal/followup-flow-service.js';
import { buildSequence } from '../../src/operator/sequence-builder.js';
import { PgPpFollowupQueue } from '../../src/pp-followup/repository.js';
import { runPpFollowupDelivery } from '../../src/pp-followup/delivery.js';
import type { PortalSessionIdentity } from '../../src/portal/auth-service.js';

const skip = testDatabaseSkipReason();
const PP = 'd975ff66-336a-46c2-b36b-d7095a11af97', OTHER_WS = '0b156000-0000-4000-8000-000000000022';
const DOMAIN = 'mail.pp-second-review.co.uk', NEW_DOMAIN = 'mail.new-second-review.co.uk', THIRD_DOMAIN = 'mail.third-second-review.co.uk';
const vault = new EmailConnectionVault(Buffer.alloc(32, 11));
type Admin = Awaited<ReturnType<typeof openTestDatabase>>;

async function session(admin: Admin, user: string, workspace: string): Promise<string> {
  const token = `email-review2-${randomUUID()}${randomUUID()}`;
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
    PERFORM set_config('app.request_id','email-review2-fixture',true);
    INSERT INTO app.organizations(id,name,slug,kind) VALUES('${org}','Property Predator','pp-review2-proof','direct_customer'),('${otherOrg}','Other','other-review2-proof','direct_customer');
    INSERT INTO app.workspaces(id,organization_id,name,slug,timezone) VALUES('${PP}','${org}','Property Predator Growth HQ','pp-review2-proof','Europe/London'),('${OTHER_WS}','${otherOrg}','Other','other-review2-proof','Europe/London');
    INSERT INTO app.users(id,email,display_name,status,email_verified_at) VALUES('${owner}','owner-review2@pp-second-review.co.uk','Pat Owner','active',clock_timestamp()),
     ('${founder}','founder-review2@pp-second-review.co.uk','Fay Founder','active',clock_timestamp());
    INSERT INTO app.organization_memberships(organization_id,user_id,role,status) VALUES('${org}','${owner}','owner','active'),('${otherOrg}','${founder}','billing','active');
    INSERT INTO app.workspace_memberships(workspace_id,organization_id,user_id,role,status) VALUES('${PP}','${org}','${owner}','owner','active'),('${OTHER_WS}','${otherOrg}','${founder}','viewer','active');
  END $s$`);
  await ownerQuery(admin, 'INSERT INTO app_private.seo_limit_operators(user_id) VALUES($1) ON CONFLICT DO NOTHING', [founder]);
  return { org, owner, founder, ownerToken: await session(admin, owner, PP), founderToken: await session(admin, founder, OTHER_WS) };
}
async function connect(connections: PgEmailConnectionStore, token: string, domain: string, first: boolean, domainId: number): Promise<void> {
  if (first) await connections.acceptTerms(token, PP, EMAIL_TERMS_VERSION);
  assert.equal(await connections.begin(token, PP, { domain, fromName: 'Property Predator', fromAddress: `hello@${domain}`, replyTo: null }, EMAIL_TERMS_VERSION), 'started');
  await connections.intend(token, PP, 'server');
  await connections.saveSealed(token, PP, 'server_token', vault.seal(PP, 'server_token', 'srv-token-review2-proof-0123456789'));
  await connections.record(token, PP, 'server', 'created', { serverId: 7171 });
  await connections.intend(token, PP, 'stream'); await connections.record(token, PP, 'stream', 'created', { stream: 'broadcast' });
  await connections.intend(token, PP, 'secret'); await connections.saveSealed(token, PP, 'webhook_secret', vault.seal(PP, 'webhook_secret', 'whsec-review2-proof-0123456789-abcdef'));
  await connections.intend(token, PP, 'webhook'); await connections.record(token, PP, 'webhook', 'created', { webhookId: 92 });
  await connections.intend(token, PP, 'domain');
  const dns = { dkim: { host: `x._domainkey.${domain}`, value: 'k=rsa; p=X', verified: true }, returnPath: { host: `pm.${domain}`, value: 'pm.mtasv.net', verified: true } };
  await connections.record(token, PP, 'domain', 'created', { domainId, dns });
  assert.equal(await connections.checked(token, PP, dns, true, true), 'verified');
}
async function testAccepted(store: PgEmailProtectionStore, ownerToken: string): Promise<void> {
  const key = `test:${randomUUID()}:0`;
  assert.equal(await store.testReserve(ownerToken, PP, key), 'ok');
  await store.testResult(ownerToken, PP, key, true);
}
const founderRow = async (store: PgEmailProtectionStore, founderToken: string) => (await store.founderView(founderToken)).businesses.find(b => b.workspaceId === PP)!;
const row = async <T extends Record<string, unknown>>(admin: Admin, sql: string) => (await ownerQuery<T>(admin, sql, [PP]))[0]!;

test('S-1, S-5, S-7 and test replays on real roles', { skip, timeout: 300_000 }, async () => {
  const admin = await openTestDatabase();
  const identity = await loginRole(admin, 'r72_identity_command');
  try {
    const { ownerToken, founderToken } = await people(admin);
    const connections = new PgEmailConnectionStore(identity), store = new PgEmailProtectionStore(identity);
    await connect(connections, ownerToken, DOMAIN, true, 911);
    await store.details(ownerToken, PP, { businessName: 'Property Predator Ltd', postalAddress: '1 High Street, Leeds LS1 1AA', testRecipients: [] });

    // A replayed "Send a test to me" says what happened to the first attempt.
    const refused = `test:${randomUUID()}:0`, silent = `test:${randomUUID()}:0`, sent = `test:${randomUUID()}:0`;
    assert.equal(await store.testReserve(ownerToken, PP, refused), 'ok');
    await store.testResult(ownerToken, PP, refused, false);
    assert.equal(await store.testReserve(ownerToken, PP, refused), 'replayed_refused');
    assert.equal(await store.testReserve(ownerToken, PP, silent), 'ok');
    assert.equal(await store.testReserve(ownerToken, PP, silent), 'replayed_unknown', 'no answer was recorded');
    assert.equal(await store.testReserve(ownerToken, PP, sent), 'ok');
    await store.testResult(ownerToken, PP, sent, true);
    assert.equal(await store.testReserve(ownerToken, PP, sent), 'replayed');

    // First go-live, approved for DOMAIN.
    assert.equal(await store.command(ownerToken, PP, 'live', EMAIL_TERMS_VERSION, true), 'requested');
    assert.equal(await store.founderAct(founderToken, PP, 'approve', (await founderRow(store, founderToken)).rowVersion), 'done');
    assert.equal((await row<{ approved_domain: string }>(admin, 'SELECT approved_domain FROM app_private.email_sending_controls WHERE workspace_id=$1')).approved_domain, DOMAIN);

    // S-1: a new domain. Its request reaches the founder (approved before, for another domain), naming the new domain.
    await connections.disconnect(ownerToken, PP);
    await connect(connections, ownerToken, NEW_DOMAIN, false, 912);
    await testAccepted(store, ownerToken);
    assert.equal(await store.command(ownerToken, PP, 'live', EMAIL_TERMS_VERSION, true), 'requested');
    assert.equal(await store.command(ownerToken, PP, 'live', EMAIL_TERMS_VERSION, true), 'already_requested');
    let business = await founderRow(store, founderToken);
    assert.ok(business.goLiveRequestedAt && business.goLiveApprovedAt, 'asked again after an earlier approval');
    assert.equal(business.domain, NEW_DOMAIN);
    const today = founderToday(await store.founderView(founderToken), 'u');
    assert.deepEqual(today.lines.map(l => [l.kind, l.sentence]), [['go_live_requested', `Property Predator Ltd is ready to go live, sending from ${NEW_DOMAIN}.`]]);
    const asked = await ownerQuery<{ numbers: Record<string, unknown> }>(admin, `SELECT numbers FROM app_private.email_protection_alerts WHERE workspace_id=$1 AND audience='founder' AND kind='go_live_requested' ORDER BY created_at DESC LIMIT 1`, [PP]);
    assert.equal(asked[0]!.numbers.domain, NEW_DOMAIN, 'the founder\'s alert names the domain');
    // Before the founder answers, the owner changes domain again: the request was for NEW_DOMAIN and is gone.
    await connections.disconnect(ownerToken, PP);
    await connect(connections, ownerToken, THIRD_DOMAIN, false, 913);
    await testAccepted(store, ownerToken);
    business = await founderRow(store, founderToken);
    assert.equal(business.goLiveRequestedAt, null, 'a request for another domain is no request');
    assert.equal((await store.state(ownerToken, PP)).goLiveRequestedAt, null);
    assert.equal((await store.sendingConfig(PP))!.goLiveRequestedAt, null);
    assert.equal(await store.founderAct(founderToken, PP, 'approve', business.rowVersion), 'not_needed', 'never approved for THIRD_DOMAIN');
    assert.equal((await store.sendingConfig(PP))!.approvedCurrent, false);
    // Even a page that still showed the old request cannot approve it: the stored request names NEW_DOMAIN.
    assert.equal((await row<{ go_live_requested_domain: string }>(admin, 'SELECT go_live_requested_domain FROM app_private.email_sending_controls WHERE workspace_id=$1')).go_live_requested_domain, NEW_DOMAIN);
    assert.equal(await store.command(ownerToken, PP, 'live', EMAIL_TERMS_VERSION, true), 'requested', 'asked again, for the domain in use');
    business = await founderRow(store, founderToken);
    assert.equal(await store.founderAct(founderToken, PP, 'approve', business.rowVersion), 'done');
    const approved = await row<{ approved_domain: string; warmup_step: number; daily_cap: number }>(admin,
      'SELECT s.approved_domain,s.warmup_step,c.daily_cap FROM app_private.email_sending_controls s JOIN app_private.email_connections c USING(workspace_id) WHERE s.workspace_id=$1');
    assert.deepEqual([approved.approved_domain, approved.warmup_step, approved.daily_cap], [THIRD_DOMAIN, 0, 50]);
    assert.equal((await founderRow(store, founderToken)).goLiveRequestedAt, null, 'answered');

    // S-5: a reconnect of the same domain never restarts a sample that is sending, waiting or held.
    for (const sample of ['waiting', 'held', 'sending'] as const) {
      await ownerQuery(admin, `UPDATE app_private.email_sending_controls SET sample_state=$2,sample_started_at=now()-interval '1 hour',sample_full_at=CASE WHEN $2='waiting' THEN now() END WHERE workspace_id=$1`, [PP, sample]);
      const before = await row<{ sample_started_at: Date }>(admin, 'SELECT sample_started_at FROM app_private.email_sending_controls WHERE workspace_id=$1');
      await connections.disconnect(ownerToken, PP);
      await connect(connections, ownerToken, THIRD_DOMAIN, false, 913);
      await testAccepted(store, ownerToken);
      const outcome = await store.reserve(PP, `lease:${randomUUID()}`, 'live');
      assert.equal(outcome, { waiting: 'sample_wait', held: 'sample_held', sending: 'ok' }[sample], sample);
      const after = await row<{ sample_state: string; sample_started_at: Date }>(admin, 'SELECT sample_state,sample_started_at FROM app_private.email_sending_controls WHERE workspace_id=$1');
      assert.deepEqual([after.sample_state, after.sample_started_at.getTime()], [sample, before.sample_started_at.getTime()], `${sample}: not restarted by the reconnect`);
    }
    // A passed sample is restarted by a reconnect (the first 50 go first again).
    await ownerQuery(admin, `UPDATE app_private.email_sending_controls SET sample_state='passed' WHERE workspace_id=$1`, [PP]);
    await connections.disconnect(ownerToken, PP);
    await connect(connections, ownerToken, THIRD_DOMAIN, false, 913);
    await testAccepted(store, ownerToken);
    assert.equal(await store.reserve(PP, `lease:${randomUUID()}`, 'live'), 'ok');
    assert.equal((await row<{ sample_state: string }>(admin, 'SELECT sample_state FROM app_private.email_sending_controls WHERE workspace_id=$1')).sample_state, 'sending');

    // S-7: 'blocked' is its own counter: in blocked7 and the day table, never in the sample's bounces or the account's.
    assert.equal(await store.count(PP, 'blocked', `bounce:${randomUUID()}`, Date.now()), 'recorded');
    await store.count(PP, 'soft_bounce', `bounce:${randomUUID()}`, Date.now());
    const numbers = (await store.numbers())!;
    const c = numbers.businesses.find(b => b.workspaceId === PP)!;
    assert.deepEqual([c.blocked7, c.soft7, c.sampleBounces], [1, 1, 1], 'the sample counts the soft bounce only');
    assert.equal(numbers.account.bounces7, 1, 'the account lines count bounces only');
    const day = (await store.state(ownerToken, PP)).days[0]!;
    assert.deepEqual([day.blocked, day.softBounces], [1, 1]);
  } finally {
    await identity.end();
    await admin.end();
  }
});

test('B-1 and S-2: test mode longer than the retry window fails nobody, then go-live sends them; one run that cannot wait never moves the rest every call', { skip, timeout: 300_000 }, async () => {
  const admin = await openTestDatabase();
  const identity = await loginRole(admin, 'r72_identity_command'), web = await loginRole(admin, 'r72_web');
  const adapter = await loginRole(admin, 'r72_content_command');
  const password = randomUUID() + randomUUID();
  await admin.query(`ALTER ROLE r72_content_adapter PASSWORD '${password}'`);
  const adapterUrl = new URL(process.env.TEST_DATABASE_URL!); adapterUrl.username = 'r72_content_adapter'; adapterUrl.password = password;
  const contentAdapter = new pg.Pool({ connectionString: adapterUrl.toString(), max: 4 });
  try {
    const { owner, ownerToken, founderToken } = await people(admin);
    const connections = new PgEmailConnectionStore(identity), store = new PgEmailProtectionStore(identity), queue = new PgPpFollowupQueue(identity);
    const ownerId = { sessionToken: ownerToken, userId: owner, workspaceId: PP, userEmail: 'owner-review2@pp-second-review.co.uk' } as PortalSessionIdentity;
    const flows = createPortalFollowupFlowService({ webPool: web, adapterPool: contentAdapter, commandPool: adapter, workspaceId: PP,
      delivery: { identityPool: identity, status: { mode: 'live', ready: true, problems: [] } } });
    const request = () => `email-review2-${randomUUID()}`.slice(0, 64);
    const built = buildSequence('pp', PP_FOLLOWUP_CAMPAIGN, { title: `Test mode proof ${randomUUID().slice(0, 8)}`, retryWindowHours: 1, steps: [
      { email: { subject: 'Hello {{FIRSTNAME}}', body: 'Thanks.\n\n{{LINK}}\n\nUnsubscribe: {{UNSUBSCRIBE}}' } }] });
    const saved = await flows.save(ownerId, request(), { commandId: randomUUID(), contentItemId: '', previousVersionId: '', definition: built.definition, inlineMessages: built.inlineMessages });
    await flows.publish(ownerId, request(), saved.contentItemId, saved.contentVersionId, randomUUID());
    // Ann, Ben and Cal are started while the environment sender is in charge (live): they are active, not held.
    const who: Record<string, { point: string; email: string }> = {};
    for (const name of ['Ann', 'Ben', 'Cal']) {
      const id = randomUUID(), point = randomUUID(), email = `${name.toLowerCase()}-${point.slice(0, 8)}@pp-second-review.co.uk`;
      await admin.query("INSERT INTO app.contacts(id,workspace_id,display_name) VALUES($1,$2,$3)", [id, PP, `${name} Example`]);
      await admin.query("INSERT INTO app.contact_points(id,workspace_id,contact_id,kind,value,normalized_value,is_primary) VALUES($1,$2,$3,'email',$4,$4,true)", [point, PP, id, email]);
      await admin.query(`INSERT INTO app.communication_consent_events(workspace_id,contact_id,contact_point_id,channel,purpose,state,lawful_basis,source,actor_kind,occurred_at)
        VALUES($1,$2,$3,'email','marketing','granted','consent','pp.proof','system',now()-interval '1 hour')`, [PP, id, point]);
      assert.equal((await flows.command(ownerId, request(), { action: 'enrol', commandId: randomUUID(), itemId: saved.contentItemId, versionId: saved.contentVersionId, contactPointId: point, runId: '', ackProofId: '' })).changed, 1);
      who[name] = { point, email };
    }
    const runs = async () => (await admin.query<{ contact_point_id: string; state: string; reason: string | null; due_at: Date }>(
      `SELECT contact_point_id,state,reason,due_at FROM app_private.pp_followup_runs WHERE workspace_id=$1 ORDER BY due_at,id`, [PP])).rows;
    const dueOf = async (name: string) => (await runs()).find(r => r.contact_point_id === who[name]!.point)!.due_at.getTime();
    const setDue = (name: string, ago: string) => admin.query(`UPDATE app_private.pp_followup_runs SET due_at=now()-$2::interval WHERE contact_point_id=$1`, [who[name]!.point, ago]);

    // S-2: Cal's step is in flight (claimed, lease live) and long overdue; Ann and Ben are due but moved a moment ago.
    await setDue('Cal', '10 minutes');
    const calLease = await queue.claim(5, 600, [who.Cal!.email]);
    assert.equal(calLease.length, 1);
    // Handed off: the proof is written and Postmark's answer never comes (an unknown outcome).
    assert.ok(await queue.prepare(calLease[0]!), 'the hand-off proof is written');
    await setDue('Cal', '3 hours');
    // Its claimed step keeps the same times as the run (due 3 hours ago, its 1-hour window gone 2 hours ago).
    await admin.query(`UPDATE app_private.pp_followup_sends SET due_at=now()-interval '3 hours',expires_at=now()-interval '2 hours' WHERE run_id=(SELECT id FROM app_private.pp_followup_runs WHERE contact_point_id=$1)`, [who.Cal!.point]);
    await setDue('Ann', '5 minutes'); await setDue('Ben', '4 minutes');
    assert.equal(await store.holdWait(), 0, 'the oldest run that can wait has waited 5 minutes: nothing moves, whatever Cal is');
    await setDue('Ann', '30 minutes');
    assert.equal(await store.holdWait(), 2, 'Ann has waited 30 minutes: both move');
    const annAt = await dueOf('Ann');
    assert.equal(await store.holdWait(), 0, 'back to back: the in-flight, overdue Cal never makes them move again');
    assert.equal(await dueOf('Ann'), annAt);
    // An unknown outcome the owner acknowledged can wait; one not acknowledged cannot.
    await ownerQuery(admin, `UPDATE app_private.pp_followup_sends SET lease_until=now()-interval '1 second' WHERE run_id=(SELECT id FROM app_private.pp_followup_runs WHERE contact_point_id=$1)`, [who.Cal!.point]);
    const calAt = await dueOf('Cal');
    await setDue('Ann', '30 minutes');
    assert.equal(await store.holdWait(), 2, 'Ann and Ben move; Cal\'s unresolved hand-off is never touched');
    assert.equal(await dueOf('Cal'), calAt);
    await ownerQuery(admin, `UPDATE app_private.pp_followup_runs r SET unknown_ack_proof_id=(SELECT p.id FROM app_private.pp_followup_dispatch_proofs p WHERE p.send_id=r.current_send_id ORDER BY p.checked_at DESC LIMIT 1)
      WHERE contact_point_id=$1`, [who.Cal!.point]);
    assert.equal(await store.holdWait(), 3, 'acknowledged by the owner: Cal can wait now too (the oldest, 3 hours)');
    assert.ok(await dueOf('Cal') > calAt);
    // B-1: the stored connection in test mode (test list: the owner only), then three hours of sweeps.
    await connect(connections, ownerToken, DOMAIN, true, 921);
    await store.details(ownerToken, PP, { businessName: 'Property Predator Ltd', postalAddress: '1 High Street, Leeds LS1 1AA', testRecipients: ['tess@pp-second-review.co.uk'] });
    assert.equal(await store.command(ownerToken, PP, 'test', EMAIL_TERMS_VERSION, false), 'test');
    await testAccepted(store, ownerToken);
    const posted: string[] = [];
    const fetcher = (async (_url: string, init: RequestInit) => { const body = JSON.parse(String(init.body)) as { To: string }; posted.push(body.To);
      return new Response(JSON.stringify({ ErrorCode: 0, MessageID: `pm-${randomUUID()}`, To: body.To }), { status: 200 }); }) as unknown as typeof fetch;
    const sweep = () => runPpFollowupDelivery({ queue, unsubscribeSecret: 'synthetic-pp-followup-secret-at-least-32-chars', connection: {
      plan: () => resolveSendingPlan(store, vault, PP), store, fetcher, link: 'https://propertypredator.com/', unsubscribeOrigin: 'https://hq.propertypredator.com' } });
    await setDue('Ann', '50 minutes'); await setDue('Ben', '40 minutes');
    for (let half = 0; half < 6; half++) {
      const result = await sweep();
      assert.equal(result.sender, 'connection');
      // Half an hour passes in test mode.
      await admin.query(`UPDATE app_private.pp_followup_runs SET due_at=due_at-interval '30 minutes' WHERE state='active'`);
      await admin.query(`UPDATE app_private.pp_followup_sends SET due_at=due_at-interval '30 minutes',expires_at=expires_at-interval '30 minutes' WHERE sent_at IS NULL`);
    }
    await sweep();
    assert.deepEqual(posted, [], 'nobody outside the test list was emailed in test mode');
    assert.deepEqual((await runs()).map(r => [r.state, r.reason]), [['active', null], ['active', null], ['active', null]], 'three hours of test mode (a 1-hour window): nobody failed');
    // Go live: asked, approved by the founder; the sample's first 50 may go.
    assert.equal(await store.command(ownerToken, PP, 'live', EMAIL_TERMS_VERSION, true), 'requested');
    assert.equal(await store.founderAct(founderToken, PP, 'approve', (await founderRow(store, founderToken)).rowVersion), 'done');
    const live = await sweep();
    assert.deepEqual([live.sender, live.sent], ['connection', 3]);
    assert.deepEqual(posted.sort(), [who.Ann!.email, who.Ben!.email, who.Cal!.email].sort(), 'after go-live the people outside the test list are sent to (Cal\'s acknowledged step too)');
    assert.deepEqual((await runs()).map(r => r.state), ['completed', 'completed', 'completed']);
  } finally {
    await Promise.allSettled([identity.end(), web.end(), adapter.end(), contentAdapter.end()]);
    await admin.end();
  }
});
