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
import type { PpFollowupSender, PpRenderedSend } from '../../src/pp-followup/mail.js';
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
      delivery: { identityPool, status: { mode: 'test', ready: true, problems: [] } } });
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
    await assert.rejects(flows.command(ownerId, request(), { action: 'enrol', commandId: randomUUID(), itemId: saved.contentItemId, versionId: saved.contentVersionId, contactPointId: a.point, runId: '', ackProofId: '' }), /Publish the latest flow/u);
    const repo = new PgPpFollowupRepository(web, identityPool);
    await assert.rejects(repo.command(ownerId, { action: 'enrol', commandId: randomUUID(), itemId: saved.contentItemId, versionId: saved.contentVersionId, contactPointId: a.point, runId: '', ackProofId: '', requestId: request() }), /approval changed/u);

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
    const suppression = (await admin.query("SELECT * FROM app.communication_suppression_events WHERE contact_point_id=$1", [d.point])).rows;
    assert.equal(suppression.length, 1); assert.equal(suppression[0].purpose, 'marketing'); assert.equal(suppression[0].source, 'pp.followup.unsubscribe');

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
    await assert.rejects(queue.settle({ id: unknownSend.id, leaseId: randomUUID(), leaseUntil: new Date().toISOString() }, true, 'pm-forged'), /no longer current/u);

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
    await assert.rejects(enrol((await contact('Gus', true)).point), /Publish the latest flow|Open the latest/u);
    assert.equal(sender.sent.length, 4, 'exactly four provider acceptances in the whole proof');

    // Stop and cancel always work, even for held runs.
    const stopped = await flows.command(ownerId, request(), { action: 'stop', commandId: randomUUID(), itemId: saved.contentItemId, versionId: saved.contentVersionId, contactPointId: '', runId: '', ackProofId: '' });
    assert.equal(stopped.changed, 1);
  } finally {
    await Promise.allSettled([web.end(), identityPool.end(), adapter.end(), command.end()]);
    await admin.end();
  }
});
