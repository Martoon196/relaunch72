/**
 * PP follow-up email sequences (0152) on a disposable PostgreSQL with the actual roles. The owner saves and
 * publishes a flow through the real PP portal service (r72_web, r72_content_adapter, r72_content_command),
 * starts CRM contacts through r72_identity_command, and the dispatcher claims, proves and settles through the
 * same identity. Postmark is a recording stand-in; nothing real is called.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { openTestDatabase, assertDisposableTestDatabase, testDatabaseSkipReason } from './database-helper.js';
import { createPortalFollowupFlowService, PP_FOLLOWUP_CAMPAIGN } from '../../src/portal/followup-flow-service.js';
import { buildSequence } from '../../src/operator/sequence-builder.js';
import { PgPpFollowupQueue, PgPpFollowupRepository, PP_FOLLOWUP_WORKSPACE_ID } from '../../src/pp-followup/repository.js';
import { dispatchPpFollowupEmails } from '../../src/pp-followup/dispatch.js';
import { createPpPostmarkSender, type PpFollowupSender, type PpRenderedSend } from '../../src/pp-followup/mail.js';
import type { PpMarketingConfig } from '../../src/pp-followup/config.js';
import { verifyPpUnsubscribeToken } from '../../src/pp-followup/content.js';
import type { PortalSessionIdentity } from '../../src/portal/auth-service.js';

const skip = testDatabaseSkipReason();
const WS = PP_FOLLOWUP_WORKSPACE_ID, SECRET = 'synthetic-pp-followup-unsubscribe-secret-0152';
const CONFIG = { testRecipients: null, link: 'https://propertypredator.com/', unsubscribeOrigin: 'https://hq.propertypredator.com', fromName: 'Property Predator' };

async function login(admin: pg.Pool, role: string): Promise<pg.Pool> {
  assertDisposableTestDatabase(process.env.TEST_DATABASE_URL ?? '');
  const password = randomUUID() + randomUUID();
  const statement = await admin.query<{ sql: string }>("SELECT format('ALTER ROLE %I PASSWORD %L', $1::text, $2::text) AS sql", [role, password]);
  await admin.query(statement.rows[0]!.sql);
  const url = new URL(process.env.TEST_DATABASE_URL!); url.username = role; url.password = password;
  return new pg.Pool({ connectionString: url.toString(), max: 4, application_name: 'relaunch72-disposable-pp-followup' });
}
function recordingSender(behaviour: () => 'accept' | 'throw' = () => 'accept'): PpFollowupSender & { sent: PpRenderedSend[] } {
  const sent: PpRenderedSend[] = [];
  return { sent, async sendRendered(item) { if (behaviour() === 'throw') throw new Error('synthetic provider timeout'); sent.push(item); return `pm-${randomUUID()}`; } };
}

test('PP follow-up email runs: approval, permission, suppression, idempotent claim/proof/settle and unknown outcomes', { skip, timeout: 300_000 }, async () => {
  const admin = await openTestDatabase();
  const web = await login(admin, 'r72_web'), identityPool = await login(admin, 'r72_identity_command');
  const adapter = await login(admin, 'r72_content_adapter'), command = await login(admin, 'r72_content_command');
  try {
    // Workspace, owner and a non-manager member. The PP workspace id is the one 0152 is pinned to.
    let org = (await admin.query<{ organization_id: string }>('SELECT organization_id FROM app.workspaces WHERE id=$1', [WS])).rows[0]?.organization_id;
    if (!org) {
      org = randomUUID();
      await admin.query("INSERT INTO app.organizations(id,name,slug,kind) VALUES($1,'Property Predator','pp-followup-proof-org','direct_customer')", [org]);
      await admin.query("INSERT INTO app.workspaces(id,organization_id,name,slug,timezone) VALUES($1,$2,'Property Predator Growth HQ','pp-followup-proof-ws','Europe/London')", [WS, org]);
    }
    const owner = randomUUID(), viewer = randomUUID(), ownerToken = randomUUID() + randomUUID(), viewerToken = randomUUID() + randomUUID();
    await admin.query("INSERT INTO app.users(id,email,status,display_name) VALUES($1,$2,'active','Owner'),($3,$4,'active','Viewer')", [owner, `owner-${owner}@example.test`, viewer, `viewer-${viewer}@example.test`]);
    await admin.query("INSERT INTO app.organization_memberships(organization_id,user_id,role,status) VALUES($1,$2,'owner','active')", [org, owner]);
    await admin.query("INSERT INTO app.workspace_memberships(workspace_id,organization_id,user_id,role,status,source_organization_id) VALUES($1,$2,$3,'owner','active',$2),($1,$2,$4,'viewer','active',NULL)", [WS, org, owner, viewer]);
    for (const [user, token] of [[owner, ownerToken], [viewer, viewerToken]] as const) {
      await admin.query("INSERT INTO app.user_sessions(token_hash,csrf_secret_hash,user_id,selected_workspace_id,expires_at) VALUES($1,$2,$3,$4,now()+interval '2 hours')",
        [createHash('sha256').update(token).digest(), createHash('sha256').update(`csrf${token}`).digest(), user, WS]);
    }
    const ownerId: PortalSessionIdentity = { sessionToken: ownerToken, userId: owner, workspaceId: WS, userEmail: `owner-${owner}@example.test` } as PortalSessionIdentity;
    const viewerId: PortalSessionIdentity = { sessionToken: viewerToken, userId: viewer, workspaceId: WS, userEmail: `viewer-${viewer}@example.test` } as PortalSessionIdentity;

    const flows = createPortalFollowupFlowService({ webPool: web, adapterPool: adapter, commandPool: command, workspaceId: WS,
      delivery: { identityPool, status: { mode: 'live', ready: true, problems: [] } } });
    const request = () => `pp-followup-${randomUUID()}`.slice(0, 64);
    const built = buildSequence('pp', PP_FOLLOWUP_CAMPAIGN, { title: `Owner follow-up ${randomUUID().slice(0, 8)}`, retryWindowHours: 24, steps: [
      { email: { subject: 'Hello {{FIRSTNAME}}', body: 'Thanks for your interest.\n\n{{LINK}}\n\nUnsubscribe: {{UNSUBSCRIBE}}' } },
      { wait: { days: 1 } },
      { email: { subject: 'Still interested, {{FIRSTNAME}}?', body: 'One more note from {{LABEL}}.' } },
    ] });
    const saved = await flows.save(ownerId, request(), { commandId: randomUUID(), contentItemId: '', previousVersionId: '', definition: built.definition, inlineMessages: built.inlineMessages });
    let detail = await flows.review(ownerId, request(), saved.contentItemId, saved.contentVersionId);
    assert.equal(detail.valid, true);
    assert.ok(detail.blockers.includes('message_not_published'), 'unapproved emails block starting');

    // CRM contacts: A has email/marketing consent; B has none; C consented then was suppressed; D and E consent.
    const contact = async (name: string, consent: boolean, suppressed = false) => {
      const id = randomUUID(), point = randomUUID(), email = `${name.toLowerCase()}-${point.slice(0, 8)}@example.test`;
      await admin.query("INSERT INTO app.contacts(id,workspace_id,display_name) VALUES($1,$2,$3)", [id, WS, `${name} Example`]);
      await admin.query("INSERT INTO app.contact_points(id,workspace_id,contact_id,kind,value,normalized_value,is_primary) VALUES($1,$2,$3,'email',$4,$4,true)", [point, WS, id, email]);
      if (consent) await admin.query(`INSERT INTO app.communication_consent_events(workspace_id,contact_id,contact_point_id,channel,purpose,state,lawful_basis,source,actor_kind,occurred_at)
        VALUES($1,$2,$3,'email','marketing','granted','consent','pp.proof','system',now()-interval '1 hour')`, [WS, id, point]);
      if (suppressed) await admin.query(`INSERT INTO app.communication_suppression_events(workspace_id,contact_id,contact_point_id,channel,purpose,state,reason,source,actor_kind,occurred_at)
        VALUES($1,$2,$3,'email',NULL,'suppressed','hard_bounce','pp.proof','system',now()-interval '1 minute')`, [WS, id, point]);
      return { id, point, email };
    };
    const a = await contact('Alice', true), b = await contact('Bob', false), c = await contact('Cara', true, true), d = await contact('Dan', true), e = await contact('Eve', true);

    // Before publication: Start is refused by the service and by the database.
    await assert.rejects(flows.command(ownerId, request(), { action: 'enrol', commandId: randomUUID(), itemId: saved.contentItemId, versionId: saved.contentVersionId, contactPointId: a.point, runId: '', ackProofId: '' }), /Publish the latest version first/u);
    const repo = new PgPpFollowupRepository(web, identityPool);
    await assert.rejects(repo.command(ownerId, { action: 'enrol', commandId: randomUUID(), itemId: saved.contentItemId, versionId: saved.contentVersionId, contactPointId: a.point, runId: '', ackProofId: '', requestId: request() }), /out of date/u);

    await flows.publish(ownerId, request(), saved.contentItemId, saved.contentVersionId, randomUUID());
    detail = await flows.review(ownerId, request(), saved.contentItemId, saved.contentVersionId);
    assert.deepEqual(detail.blockers, []);
    let snapshot = await flows.snapshot(ownerId, request());
    assert.equal(snapshot.executable, true);
    const permittedPoints = snapshot.delivery!.database!.contacts.map(x => x.contactPointId);
    for (const ok of [a, d, e]) assert.ok(permittedPoints.includes(ok.point));
    for (const blocked of [b, c]) assert.ok(!permittedPoints.includes(blocked.point), 'no consent or suppressed is never offered');

    // A viewer cannot read or command; a non-PP selection is refused in SQL.
    await assert.rejects(repo.snapshot(viewerId), /owner or admin/u);
    await assert.rejects(repo.command(viewerId, { action: 'enrol', commandId: randomUUID(), itemId: saved.contentItemId, versionId: saved.contentVersionId, contactPointId: a.point, runId: '', ackProofId: '', requestId: request() }), /owner or admin/u);

    const enrol = (point: string, commandId = randomUUID()) => flows.command(ownerId, request(), { action: 'enrol', commandId, itemId: saved.contentItemId, versionId: saved.contentVersionId, contactPointId: point, runId: '', ackProofId: '' });
    assert.equal((await enrol(b.point)).reason, 'not_permitted');
    assert.equal((await enrol(c.point)).reason, 'not_permitted');
    const once = randomUUID(), first = await enrol(a.point, once);
    assert.equal(first.changed, 1); assert.equal(first.replayed, false);
    const replay = await enrol(a.point, once);
    assert.equal(replay.replayed, true); assert.equal(replay.changed, 1);
    assert.equal((await enrol(a.point)).reason, 'already_enrolled');
    for (const person of [d, e]) assert.equal((await enrol(person.point)).changed, 1);

    // Runtime grants: the web role reads only through the snapshot function, the dispatch role has no tables.
    await assert.rejects(web.query('SELECT app_private.pp_followup_claim(1,60,NULL)'), /permission denied/u);
    await assert.rejects(identityPool.query('SELECT * FROM app_private.pp_followup_runs'), /permission denied/u);
    await assert.rejects(web.query('SELECT * FROM app_private.pp_followup_sends'), /permission denied/u);

    const queue = new PgPpFollowupQueue(identityPool);
    // Test mode: a claim filtered to other addresses leases nothing.
    assert.deepEqual(await queue.claim(25, 120, ['someone-else@example.test']), []);
    const sender = recordingSender();
    const firstSweep = await dispatchPpFollowupEmails({ queue, sender, unsubscribeSecret: SECRET, config: CONFIG });
    assert.deepEqual(firstSweep, { sent: 3, failed: 0, unknown: 0 });
    const toAlice = sender.sent.find(item => item.email === a.email)!;
    assert.equal(toAlice.rendered.subject, 'Hello Alice');
    const unsubscribe = new URL(toAlice.rendered.unsubscribe);
    assert.equal(unsubscribe.searchParams.get('p'), a.point);
    assert.ok(verifyPpUnsubscribeToken(SECRET, a.point, unsubscribe.searchParams.get('t')!));
    assert.match(toAlice.rendered.text, /https:\/\/propertypredator\.com\//u);
    const aliceRun = (await admin.query('SELECT * FROM app_private.pp_followup_runs WHERE contact_point_id=$1', [a.point])).rows[0];
    assert.equal(aliceRun.state, 'active'); assert.equal(aliceRun.position, 2); assert.ok(aliceRun.due_at > new Date(Date.now() + 23 * 3600_000));
    const aliceSend = (await admin.query('SELECT * FROM app_private.pp_followup_sends WHERE run_id=$1 AND step=0', [aliceRun.id])).rows[0];
    assert.ok(aliceSend.sent_at); assert.match(aliceSend.provider_reference, /^pm-/u);
    const proof = (await admin.query('SELECT * FROM app_private.pp_followup_dispatch_proofs WHERE send_id=$1', [aliceSend.id])).rows[0];
    assert.equal(proof.accepted, true); assert.equal(proof.provider_reference, aliceSend.provider_reference);
    await assert.rejects(admin.query('UPDATE app_private.pp_followup_dispatch_proofs SET accepted=false WHERE id=$1', [proof.id]), /immutable/u);
    // Nothing else is due: a second sweep sends nothing and leaves the provider untouched.
    assert.deepEqual(await dispatchPpFollowupEmails({ queue, sender, unsubscribeSecret: SECRET, config: CONFIG }), { sent: 0, failed: 0, unknown: 0 });
    assert.equal(sender.sent.length, 3);

    // Step two becomes due. A provider failure after the proof is an unknown outcome: never sent, never retried silently.
    await admin.query("UPDATE app_private.pp_followup_runs SET due_at=now()-interval '1 minute' WHERE contact_point_id=ANY($1)", [[a.point, d.point, e.point]]);
    // E withdraws permission first: the claim stops that run before anything is sent.
    await admin.query(`INSERT INTO app.communication_consent_events(workspace_id,contact_id,contact_point_id,channel,purpose,state,source,actor_kind,occurred_at)
      VALUES($1,$2,$3,'email','marketing','withdrawn','pp.proof','system',now())`, [WS, e.id, e.point]);
    // D unsubscribes through the signed link capability.
    assert.deepEqual(await repo.unsubscribe(d.point), { known: true, recorded: true, stopped: 1 });
    assert.deepEqual(await repo.unsubscribe(d.point), { known: true, recorded: false, stopped: 0 });
    const failing = recordingSender(() => 'throw');
    assert.deepEqual(await dispatchPpFollowupEmails({ queue, sender: failing, unsubscribeSecret: SECRET, config: CONFIG }), { sent: 0, failed: 0, unknown: 1 });
    const runs = new Map((await admin.query('SELECT contact_point_id,state,reason,position FROM app_private.pp_followup_runs WHERE contact_point_id=ANY($1)', [[a.point, d.point, e.point]])).rows
      .map(row => [row.contact_point_id, row]));
    assert.deepEqual([runs.get(a.point).state, runs.get(a.point).reason], ['held', 'outcome_unknown']);
    assert.deepEqual([runs.get(d.point).state, runs.get(d.point).reason], ['stopped', 'unsubscribed']);
    assert.deepEqual([runs.get(e.point).state, runs.get(e.point).reason], ['stopped', 'unsubscribed']);
    const unknownSend = (await admin.query('SELECT * FROM app_private.pp_followup_sends WHERE run_id=$1 AND step=2', [aliceRun.id])).rows[0];
    assert.equal(unknownSend.sent_at, null); assert.equal(unknownSend.provider_reference, null);
    const suppression = (await admin.query("SELECT * FROM app.communication_suppression_events WHERE contact_point_id=$1 ORDER BY purpose", [d.point])).rows;
    assert.deepEqual(suppression.map(row => [row.purpose, row.state, row.source]), [['marketing', 'suppressed', 'pp.followup.unsubscribe'], ['property_predator_marketing', 'suppressed', 'pp.followup.unsubscribe']],
      'one unsubscribe suppresses both Property Predator marketing purposes');

    // The held run is not claimed again. Resume needs the owner to acknowledge that exact attempt.
    assert.deepEqual(await dispatchPpFollowupEmails({ queue, sender, unsubscribeSecret: SECRET, config: CONFIG }), { sent: 0, failed: 0, unknown: 0 });
    snapshot = await flows.snapshot(ownerId, request());
    const held = snapshot.delivery!.database!.runs.find(run => run.contactPointId === a.point)!;
    assert.ok(held.unknownProofId);
    await admin.query("UPDATE app_private.pp_followup_sends SET lease_until=now()-interval '1 second' WHERE id=$1", [unknownSend.id]);
    const blind = await flows.command(ownerId, request(), { action: 'resume', commandId: randomUUID(), itemId: saved.contentItemId, versionId: saved.contentVersionId, contactPointId: '', runId: held.id, ackProofId: '' });
    assert.deepEqual([blind.changed, blind.blocked], [0, 1]);
    const acknowledged = await flows.command(ownerId, request(), { action: 'resume', commandId: randomUUID(), itemId: saved.contentItemId, versionId: saved.contentVersionId, contactPointId: '', runId: held.id, ackProofId: held.unknownProofId! });
    assert.equal(acknowledged.changed, 1);
    assert.deepEqual(await dispatchPpFollowupEmails({ queue, sender, unsubscribeSecret: SECRET, config: CONFIG }), { sent: 1, failed: 0, unknown: 0 });
    assert.equal(sender.sent.at(-1)!.rendered.subject, 'Still interested, Alice?');
    assert.match(sender.sent.at(-1)!.rendered.text, /One more note from Property Predator\./u);
    const completed = (await admin.query('SELECT state,last_accepted_at FROM app_private.pp_followup_runs WHERE id=$1', [aliceRun.id])).rows[0];
    assert.equal(completed.state, 'completed'); assert.ok(completed.last_accepted_at);

    // Settle without a current lease or proof is refused; a stale lease cannot mark anything sent.
    await assert.rejects(queue.settle({ id: unknownSend.id, leaseId: randomUUID(), leaseUntil: new Date().toISOString(), email: a.email }, 'accepted', 'pm-forged'), /no longer current/u);

    // A newer flow version holds open runs of the old one and the old version can no longer start people.
    const f = await contact('Fay', true);
    assert.equal((await enrol(f.point)).changed, 1);
    const edited = buildSequence('pp', PP_FOLLOWUP_CAMPAIGN, { title: detail.definition.title, retryWindowHours: 24, steps: [
      { saved: { channel: 'email', contentItemId: detail.definition.steps[0]!.kind === 'wait' ? '' : (detail.definition.steps[0] as { contentItemId: string }).contentItemId,
        contentVersionId: (detail.definition.steps[0] as { contentVersionId: string }).contentVersionId, contentSha256: (detail.definition.steps[0] as { contentSha256: string }).contentSha256 } },
    ] });
    await flows.save(ownerId, request(), { commandId: randomUUID(), contentItemId: saved.contentItemId, previousVersionId: saved.contentVersionId, definition: edited.definition, inlineMessages: {} });
    assert.deepEqual(await dispatchPpFollowupEmails({ queue, sender, unsubscribeSecret: SECRET, config: CONFIG }), { sent: 0, failed: 0, unknown: 0 });
    const fay = (await admin.query('SELECT state,reason FROM app_private.pp_followup_runs WHERE contact_point_id=$1', [f.point])).rows[0];
    assert.deepEqual([fay.state, fay.reason], ['held', 'newer_sequence']);
    await assert.rejects(enrol((await contact('Gus', true)).point), /Publish the latest version first|Open the latest/u);
    assert.equal(sender.sent.length, 4, 'exactly four provider acceptances in the whole proof');

    // Stop and cancel always work, even for held runs.
    const stopped = await flows.command(ownerId, request(), { action: 'stop', commandId: randomUUID(), itemId: saved.contentItemId, versionId: saved.contentVersionId, contactPointId: '', runId: '', ackProofId: '' });
    assert.equal(stopped.changed, 1);
  } finally {
    await Promise.allSettled([web.end(), identityPool.end(), adapter.end(), command.end()]);
    await admin.end();
  }
});

/** A fresh owner, portal services in live and test mode, and helpers to publish a flow, add CRM people and send. */
async function world() {
  const admin = await openTestDatabase();
  const web = await login(admin, 'r72_web'), identityPool = await login(admin, 'r72_identity_command');
  const adapter = await login(admin, 'r72_content_adapter'), command = await login(admin, 'r72_content_command'), crm = await login(admin, 'r72_crm_command');
  let org = (await admin.query<{ organization_id: string }>('SELECT organization_id FROM app.workspaces WHERE id=$1', [WS])).rows[0]?.organization_id;
  if (!org) {
    org = randomUUID();
    await admin.query("INSERT INTO app.organizations(id,name,slug,kind) VALUES($1,'Property Predator','pp-followup-proof-org','direct_customer')", [org]);
    await admin.query("INSERT INTO app.workspaces(id,organization_id,name,slug,timezone) VALUES($1,$2,'Property Predator Growth HQ','pp-followup-proof-ws','Europe/London')", [WS, org]);
  }
  const owner = randomUUID(), ownerToken = randomUUID() + randomUUID();
  await admin.query("INSERT INTO app.users(id,email,status,display_name) VALUES($1,$2,'active','Owner')", [owner, `owner-${owner}@example.test`]);
  await admin.query("INSERT INTO app.organization_memberships(organization_id,user_id,role,status) VALUES($1,$2,'owner','active')", [org, owner]);
  await admin.query("INSERT INTO app.workspace_memberships(workspace_id,organization_id,user_id,role,status,source_organization_id) VALUES($1,$2,$3,'owner','active',$2)", [WS, org, owner]);
  await admin.query("INSERT INTO app.user_sessions(token_hash,csrf_secret_hash,user_id,selected_workspace_id,expires_at) VALUES($1,$2,$3,$4,now()+interval '2 hours')",
    [createHash('sha256').update(ownerToken).digest(), createHash('sha256').update(`csrf${ownerToken}`).digest(), owner, WS]);
  const ownerId = { sessionToken: ownerToken, userId: owner, workspaceId: WS, userEmail: `owner-${owner}@example.test` } as PortalSessionIdentity;
  const request = () => `pp-followup-${randomUUID()}`.slice(0, 64);
  const service = (status: { mode: 'test' | 'live' }, testRecipients: readonly string[] | null = null) => createPortalFollowupFlowService({ webPool: web, adapterPool: adapter, commandPool: command, workspaceId: WS,
    delivery: { identityPool, status: { ...status, ready: true, problems: [] }, testRecipients } });
  const flows = service({ mode: 'live' });
  const repo = new PgPpFollowupRepository(web, identityPool), queue = new PgPpFollowupQueue(identityPool);
  /** A CRM person with one email address and no permission events yet. */
  const person = async (name: string, local = name.toLowerCase()) => {
    const id = randomUUID(), point = randomUUID(), email = `${local}-${point.slice(0, 8)}@example.test`;
    await admin.query('INSERT INTO app.contacts(id,workspace_id,display_name) VALUES($1,$2,$3)', [id, WS, `${name} Example`]);
    await admin.query("INSERT INTO app.contact_points(id,workspace_id,contact_id,kind,value,normalized_value,is_primary) VALUES($1,$2,$3,'email',$4,$4,true)", [point, WS, id, email]);
    return { id, point, email };
  };
  type Person = Awaited<ReturnType<typeof person>>;
  /** One consent event exactly as the two real writers record it: the owner ('marketing') or the product (0018). */
  const consent = (who: Person, purpose: string, state: 'granted' | 'denied' | 'withdrawn', ago = '1 hour') => admin.query(
    `INSERT INTO app.communication_consent_events(workspace_id,contact_id,contact_point_id,channel,purpose,state,lawful_basis,source,actor_kind,occurred_at)
     VALUES($1,$2,$3,'email',$4,$5,$6,$7,$8,now()-$9::interval)`,
    [WS, who.id, who.point, purpose, state, state === 'granted' ? 'consent' : null, purpose === 'marketing' ? 'pp.proof' : 'property_predator', purpose === 'marketing' ? 'system' : 'webhook', ago]);
  const published: { itemId: string; versionId: string }[] = [];
  const publish = async (emails = 1, retryWindowHours = 24) => {
    const steps: unknown[] = [];
    for (let index = 0; index < emails; index++) { if (index) steps.push({ wait: { days: 1 } }); steps.push({ email: { subject: `Note ${index + 1} for {{FIRSTNAME}}`, body: `Hello from {{LABEL}}.\n\n{{UNSUBSCRIBE}}` } }); }
    const built = buildSequence('pp', PP_FOLLOWUP_CAMPAIGN, { title: `Proof flow ${randomUUID().slice(0, 8)}`, retryWindowHours, steps });
    const saved = await flows.save(ownerId, request(), { commandId: randomUUID(), contentItemId: '', previousVersionId: '', definition: built.definition, inlineMessages: built.inlineMessages });
    await flows.publish(ownerId, request(), saved.contentItemId, saved.contentVersionId, randomUUID());
    const flow = { itemId: saved.contentItemId, versionId: saved.contentVersionId }; published.push(flow);
    return flow;
  };
  type Flow = Awaited<ReturnType<typeof publish>>;
  const act = (flow: Flow, action: 'enrol' | 'pause' | 'resume' | 'stop', extra: { point?: string; runId?: string; ackProofId?: string } = {}, through = flows) =>
    through.command(ownerId, request(), { action, commandId: randomUUID(), itemId: flow.itemId, versionId: flow.versionId, contactPointId: extra.point ?? '', runId: extra.runId ?? '', ackProofId: extra.ackProofId ?? '' });
  const run = async (who: Person) => (await admin.query('SELECT * FROM app_private.pp_followup_runs WHERE contact_point_id=$1 ORDER BY created_at DESC LIMIT 1', [who.point])).rows[0];
  const send = async (who: Person) => (await admin.query('SELECT s.* FROM app_private.pp_followup_sends s JOIN app_private.pp_followup_runs r ON r.id=s.run_id WHERE r.contact_point_id=$1 ORDER BY s.step DESC LIMIT 1', [who.point])).rows[0];
  /** One sweep that can only ever touch the named people (the claim filter), so each scenario is independent. */
  const sweep = (who: readonly Person[], sender: PpFollowupSender, onSenderRefused?: () => void) =>
    dispatchPpFollowupEmails({ queue, sender, unsubscribeSecret: SECRET, config: { ...CONFIG, testRecipients: who.map(x => x.email) }, ...(onSenderRefused ? { onSenderRefused } : {}) });
  /** The real PP founder-pilot permission check (0064) for the product purpose, as r72_crm_command would run it. */
  const productPermission = async (who: Person) => {
    const client = await crm.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.workspace_id',$1,true),set_config('app.actor_kind','user',true),set_config('app.user_id',$2,true),set_config('app.request_id',$3,true)", [WS, owner, request()]);
      const rows = (await client.query<{ dimension: string; ready: boolean; blocker_code: string | null }>(
        'SELECT dimension,ready,blocker_code FROM app_private.customer_email_pilot_readiness($1,$2,$3,$4,$5)', [WS, randomUUID(), who.id, who.point, 'property_predator_marketing'])).rows;
      await client.query('COMMIT');
      return new Map(rows.map(row => [row.dimension, row]));
    } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; } finally { client.release(); }
  };
  // Leave no open run behind, pass or fail: the first proof in this file counts exact provider acceptances.
  const close = async () => {
    for (const flow of published) await act(flow, 'stop').catch(() => undefined);
    await Promise.allSettled([web.end(), identityPool.end(), adapter.end(), command.end(), crm.end()]); await admin.end();
  };
  return { admin, ownerId, request, service, flows, repo, queue, person, consent, publish, act, run, send, sweep, productPermission, close };
}
const SENDER: PpMarketingConfig = { mode: 'live', token: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', from: 'hello@propertypredator.com', fromName: 'Property Predator',
  replyTo: 'office@propertypredator.com', stream: 'broadcast', testRecipients: null, link: 'https://propertypredator.com/', unsubscribeOrigin: 'https://hq.propertypredator.com' };
/** The real Postmark sender over a stand-in fetch: the scenarios below decide what "Postmark" answers. */
function postmark(answer: () => Response | Error) {
  const to: string[] = [];
  const fetcher = (async (_url: string, init: RequestInit) => { const reply = answer(); if (reply instanceof Error) throw reply; to.push(JSON.parse(String(init.body)).To as string); return reply; }) as unknown as typeof fetch;
  return { to, sender: createPpPostmarkSender(SENDER, fetcher) };
}
const accepted = () => new Response(JSON.stringify({ ErrorCode: 0, MessageID: `pm-${randomUUID()}` }), { status: 200 });

test('PP marketing permission reads both purposes: a product opt-out always wins and a product opt-in is enough', { skip, timeout: 300_000 }, async () => {
  const w = await world();
  try {
    const flow = await w.publish(), sender = recordingSender();
    const optedOut = await w.person('Hana'), productOnly = await w.person('Ivo'), partnerOnly = await w.person('Jay'), later = await w.person('Kit'), atPrepare = await w.person('Lou'), suppressed = await w.person('Mia');
    // The owner recorded 'marketing' permission, but the person has since opted out in the product itself.
    await w.consent(optedOut, 'marketing', 'granted', '2 hours'); await w.consent(optedOut, 'property_predator_marketing', 'withdrawn', '1 hour');
    await w.consent(productOnly, 'property_predator_marketing', 'granted');
    await w.consent(partnerOnly, 'partner_marketing', 'granted');
    await w.consent(later, 'marketing', 'granted'); await w.consent(atPrepare, 'marketing', 'granted');
    await w.consent(suppressed, 'property_predator_marketing', 'granted', '2 hours');
    await w.admin.query(`INSERT INTO app.communication_suppression_events(workspace_id,contact_id,contact_point_id,channel,purpose,state,reason,source,actor_kind,occurred_at)
      VALUES($1,$2,$3,'email','property_predator_marketing','suppressed','recipient_unsubscribe','pp.proof','system',now()-interval '1 minute')`, [WS, suppressed.id, suppressed.point]);

    // Point 1, the picker and enrolment.
    const offered = async (who: { email: string; point: string }) => (await w.flows.snapshot(w.ownerId, w.request(), { itemId: flow.itemId, search: who.email })).delivery!.database!.contacts.some(x => x.contactPointId === who.point);
    assert.equal(await offered(optedOut), false, 'a product opt-out blocks despite a marketing grant');
    assert.equal(await offered(productOnly), true, 'a product opt-in alone qualifies');
    assert.equal(await offered(partnerOnly), false, 'partner marketing is a different permission');
    assert.equal(await offered(suppressed), false, 'a product-purpose suppression blocks');
    for (const blocked of [optedOut, partnerOnly, suppressed]) assert.equal((await w.act(flow, 'enrol', { point: blocked.point })).reason, 'not_permitted');
    for (const ok of [productOnly, later, atPrepare]) assert.equal((await w.act(flow, 'enrol', { point: ok.point })).changed, 1);
    assert.deepEqual(await w.sweep([productOnly], sender), { sent: 1, failed: 0, unknown: 0 });
    assert.equal(sender.sent.at(-1)!.email, productOnly.email); assert.equal((await w.run(productOnly)).state, 'completed');

    // Point 2, the claim: a product opt-out recorded after enrolment stops the run before anything is leased.
    await w.consent(later, 'property_predator_marketing', 'denied', '0 seconds');
    assert.deepEqual(await w.sweep([later], sender), { sent: 0, failed: 0, unknown: 0 });
    assert.deepEqual([(await w.run(later)).state, (await w.run(later)).reason], ['stopped', 'unsubscribed']);

    // Point 3, the prepare: an opt-out that lands between the claim and the hand-off still stops it. No proof, no attempt.
    const [lease] = await w.queue.claim(25, 120, [atPrepare.email]);
    assert.ok(lease); assert.equal(lease.email, atPrepare.email);
    await w.consent(atPrepare, 'property_predator_marketing', 'withdrawn', '0 seconds');
    assert.equal(await w.queue.prepare(lease), null);
    assert.equal((await w.send(atPrepare)).attempts, 0);
    await w.admin.query("UPDATE app_private.pp_followup_sends SET lease_until=now()-interval '1 second' WHERE id=$1", [lease.id]);
    await w.queue.claim(25, 120, [atPrepare.email]);
    assert.equal((await w.run(atPrepare)).state, 'stopped');
    assert.equal(sender.sent.length, 1, 'only the person with current product permission received anything');

    // Unsubscribing from a follow-up email also stops other Property Predator marketing: the real 0064 permission
    // check for the product purpose reports the address as suppressed afterwards.
    const leaver = await w.person('Nia'); await w.consent(leaver, 'property_predator_marketing', 'granted');
    assert.equal((await w.act(flow, 'enrol', { point: leaver.point })).changed, 1);
    const before = await w.productPermission(leaver);
    assert.deepEqual([before.get('current_consent')!.ready, before.get('suppression_clear')!.ready], [true, true]);
    assert.deepEqual(await w.repo.unsubscribe(leaver.point), { known: true, recorded: true, stopped: 1 });
    const after = await w.productPermission(leaver);
    assert.deepEqual([after.get('suppression_clear')!.ready, after.get('suppression_clear')!.blocker_code], [false, 'RECIPIENT_SUPPRESSED']);
    assert.equal(await offered(leaver), false);
    assert.equal((await w.act(flow, 'enrol', { point: leaver.point })).reason, 'not_permitted');
  } finally { await w.close(); }
});

test('PP follow-up resume restarts the clock, attempts are spent at hand-off and definite refusals are never "unknown"', { skip, timeout: 300_000 }, async () => {
  const w = await world();
  try {
    const flow = await w.publish(1, 24);
    const start = async (name: string, local?: string) => { const who = await w.person(name, local); await w.consent(who, 'marketing', 'granted'); assert.equal((await w.act(flow, 'enrol', { point: who.point })).changed, 1); return who; };
    const overdue = (who: { point: string }) => w.admin.query("UPDATE app_private.pp_followup_runs SET due_at=now()-interval '30 hours' WHERE contact_point_id=$1", [who.point]);
    const expireLease = (who: { point: string }) => w.admin.query("UPDATE app_private.pp_followup_sends s SET lease_until=now()-interval '1 second' FROM app_private.pp_followup_runs r WHERE r.id=s.run_id AND r.contact_point_id=$1", [who.point]);

    // Paused for longer than the 24 hour retry window: Resume really resumes it and the email goes out.
    const paused = await start('Oli'), ignored = await start('Pam');
    assert.equal((await w.act(flow, 'pause', { runId: (await w.run(paused)).id })).changed, 1);
    await overdue(paused); await overdue(ignored);
    const resumed = await w.act(flow, 'resume', { runId: (await w.run(paused)).id });
    assert.deepEqual([resumed.changed, resumed.blocked], [1, 0]);
    assert.ok((await w.run(paused)).due_at > new Date(Date.now() - 60_000), 'the retry window starts again at resume');
    const good = postmark(accepted);
    assert.deepEqual(await w.sweep([paused], good.sender), { sent: 1, failed: 0, unknown: 0 });
    assert.equal((await w.run(paused)).state, 'completed');
    // A run nobody paused keeps the documented rule: a step still unsent after its window fails as expired.
    assert.deepEqual(await w.sweep([ignored], good.sender), { sent: 0, failed: 0, unknown: 0 });
    assert.deepEqual([(await w.run(ignored)).state, (await w.run(ignored)).reason], ['failed', 'delivery_expired']);

    // Lost leases (a worker that dies after claiming) spend nothing.
    const lost = await start('Quin');
    for (let round = 0; round < 6; round++) { assert.equal((await w.queue.claim(25, 120, [lost.email])).length, 1); await expireLease(lost); }
    assert.deepEqual([(await w.send(lost)).attempts, (await w.run(lost)).state], [0, 'active'], 'six lost leases do not use the five-attempt budget');
    assert.deepEqual(await w.sweep([lost], good.sender), { sent: 1, failed: 0, unknown: 0 });
    assert.equal((await w.send(lost)).attempts, 1);

    // A refused server token is a definite non-send: nothing is held as unknown and no attempt is spent.
    const token = await start('Rae'); let refusals = 0;
    const badToken = postmark(() => new Response(JSON.stringify({ ErrorCode: 10, Message: 'Bad or missing Server API token.' }), { status: 401 }));
    assert.deepEqual(await w.sweep([token], badToken.sender, () => { refusals++; }), { sent: 0, failed: 1, unknown: 0 });
    assert.equal(refusals, 1);
    assert.deepEqual([(await w.run(token)).state, (await w.run(token)).reason, (await w.send(token)).attempts, (await w.send(token)).last_failure], ['active', null, 0, 'sender_not_ready']);
    assert.equal((await w.admin.query('SELECT accepted FROM app_private.pp_followup_dispatch_proofs WHERE send_id=$1', [(await w.send(token)).id])).rows[0].accepted, false);
    assert.deepEqual(await w.sweep([token], good.sender), { sent: 0, failed: 0, unknown: 0 }, 'it waits five minutes before the next try');
    await expireLease(token);
    assert.deepEqual(await w.sweep([token], good.sender), { sent: 1, failed: 0, unknown: 0 }, 'once the token is fixed the same run sends');

    // Postmark refusing this message (422) spends the attempt and backs off; it is not "unknown".
    const refused = await start('Sol');
    const invalid = postmark(() => new Response(JSON.stringify({ ErrorCode: 300, Message: 'Invalid email request' }), { status: 422 }));
    assert.deepEqual(await w.sweep([refused], invalid.sender), { sent: 0, failed: 1, unknown: 0 });
    const refusedSend = await w.send(refused);
    assert.deepEqual([(await w.run(refused)).state, refusedSend.attempts, refusedSend.last_failure], ['active', 1, 'delivery_not_accepted']);
    assert.ok(refusedSend.lease_until > new Date(Date.now() + 4 * 60_000));
    // An inactive recipient at Postmark (406) can never be sent to: the run fails at once.
    const inactive = await start('Tess');
    assert.deepEqual(await w.sweep([inactive], postmark(() => new Response(JSON.stringify({ ErrorCode: 406 }), { status: 422 })).sender), { sent: 0, failed: 1, unknown: 0 });
    assert.deepEqual([(await w.run(inactive)).state, (await w.run(inactive)).reason], ['failed', 'delivery_failed']);

    // A timeout is genuinely uncertain and still holds the run for the owner.
    const unsure = await start('Uma');
    assert.deepEqual(await w.sweep([unsure], postmark(() => new Error('synthetic timeout')).sender), { sent: 0, failed: 0, unknown: 1 });
    assert.deepEqual([(await w.run(unsure)).state, (await w.run(unsure)).reason], ['held', 'outcome_unknown']);

    // A slow success: the answer arrives after the lease ran out and the run was already held as unknown.
    const slow = await start('Val');
    const [lease] = await w.queue.claim(25, 120, [slow.email]);
    assert.ok(await w.queue.prepare(lease!));
    await expireLease(slow);
    assert.deepEqual(await w.queue.claim(25, 120, [slow.email]), []);
    assert.deepEqual([(await w.run(slow)).state, (await w.run(slow)).reason], ['held', 'outcome_unknown']);
    await w.queue.settle(lease!, 'accepted', 'pm-late-answer');
    assert.deepEqual([(await w.run(slow)).state, (await w.run(slow)).reason, (await w.send(slow)).provider_reference], ['completed', null, 'pm-late-answer']);
    await assert.rejects(w.queue.settle(lease!, 'accepted', 'pm-second-answer'), /no longer current/u);

    // An apostrophe is a valid address character.
    const irish = await start('Wyn', "o'brien");
    assert.deepEqual(await w.sweep([irish], good.sender), { sent: 1, failed: 0, unknown: 0 });
    assert.equal(good.to.at(-1), irish.email); assert.match(irish.email, /^o'brien-/u);
  } finally { await w.close(); }
});

test('PP follow-up test mode holds other people for the owner, and search reaches people beyond the page caps', { skip, timeout: 300_000 }, async () => {
  const w = await world();
  try {
    const flow = await w.publish(), sender = recordingSender();
    const tester = await w.person('Xan'), real = await w.person('Yas', "y'asmin");
    for (const who of [tester, real]) await w.consent(who, 'marketing', 'granted');
    const testing = w.service({ mode: 'test' }, [tester.email]);
    assert.equal((await w.act(flow, 'enrol', { point: tester.point }, testing)).heldForTest, 0);
    const added = await w.act(flow, 'enrol', { point: real.point }, testing);
    assert.deepEqual([added.changed, added.heldForTest], [1, 1]);
    assert.deepEqual([(await w.run(real)).state, (await w.run(real)).reason], ['held', 'test_mode']);
    // Test mode sends to the test address only; resuming the other person is refused while testing.
    assert.deepEqual(await w.sweep([tester], sender), { sent: 1, failed: 0, unknown: 0 });
    const refused = await w.act(flow, 'resume', { runId: (await w.run(real)).id }, testing);
    assert.deepEqual([refused.changed, refused.blocked, refused.heldForTest], [0, 1, 1]);
    // The switch to live sends nothing by itself: the run is still held until the owner resumes it.
    assert.deepEqual(await dispatchPpFollowupEmails({ queue: w.queue, sender, unsubscribeSecret: SECRET, config: { ...CONFIG, testRecipients: [real.email] } }), { sent: 0, failed: 0, unknown: 0 });
    assert.equal(sender.sent.length, 1);
    assert.equal((await w.act(flow, 'resume', { runId: (await w.run(real)).id })).changed, 1);
    assert.deepEqual(await w.sweep([real], sender), { sent: 1, failed: 0, unknown: 0 });
    assert.equal(sender.sent.at(-1)!.email, real.email);

    // Search by name or by email, for the people who can be started and for the people already in this flow.
    const view = async (search: string) => (await w.flows.snapshot(w.ownerId, w.request(), { itemId: flow.itemId, search })).delivery!.database!;
    const waiting = await w.person('Zed'); await w.consent(waiting, 'property_predator_marketing', 'granted');
    const byEmail = await view(waiting.email.toUpperCase());
    assert.deepEqual(byEmail.contacts.map(x => x.contactPointId), [waiting.point]); assert.equal(byEmail.contactMatches, 1); assert.deepEqual(byEmail.runs, []);
    const byName = await view("y'asmin");
    assert.deepEqual(byName.runs.map(x => x.contactPointId), [real.point]); assert.equal(byName.runMatches, 1);
    assert.ok((await view('yas example')).runs.some(x => x.contactPointId === real.point), 'matches the display name');
    const wildcard = await view('%');
    assert.deepEqual([wildcard.contacts.length, wildcard.runs.length], [0, 0], 'search text is literal, never a pattern');
    const whole = await view('');
    assert.equal(whole.runMatches, 2); assert.ok(whole.permitted >= whole.contactMatches && whole.contactMatches >= 3);
    assert.ok(whole.runs.every(x => x.contentItemId === flow.itemId), 'the run list follows the flow on screen');
    await assert.rejects(w.repo.snapshot(w.ownerId, { itemId: flow.itemId, search: 'x'.repeat(101) }), /shorter/u);
  } finally { await w.close(); }
});
