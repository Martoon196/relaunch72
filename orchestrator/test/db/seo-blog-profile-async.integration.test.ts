/** Run only on the disposable test database as the actual r72_content_command role. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { PgSeoBlogStore } from '../../src/seo-blog/pg-store.js';
import { SeoBlogEngine } from '../../src/seo-blog/engine.js';
import { profilePayload } from '../../src/seo-blog/profile-jobs.js';
import { harness } from '../seo-blog-fixtures.js';
import { openTestDatabase, testDatabaseSkipReason } from './database-helper.js';
import { withTransaction } from '../../src/db/transaction.js';

const skip = testDatabaseSkipReason();

async function contentLogin(admin: pg.Pool): Promise<pg.Pool> {
  const password = `profile-proof-${randomUUID()}`;
  const statement = await admin.query<{ sql: string }>("SELECT pg_catalog.format('ALTER ROLE %I PASSWORD %L', 'r72_content_command', $1::text) AS sql", [password]);
  await admin.query(statement.rows[0]!.sql);
  const url = new URL(process.env.TEST_DATABASE_URL!); url.username = 'r72_content_command'; url.password = password;
  return new pg.Pool({ connectionString: url.toString(), max: 6, application_name: 'relaunch72-disposable-profile-async' });
}

async function seedOwner(admin: pg.Pool) {
  const org = randomUUID(), user = randomUUID(), home = randomUUID(), token = randomUUID() + randomUUID();
  await admin.query("INSERT INTO app.organizations(id,name,slug,kind) VALUES($1,'Async proof',$2,'direct_customer')", [org, `async-${org}`]);
  await admin.query("INSERT INTO app.users(id,email,status) VALUES($1,$2,'active')", [user, `async-${user}@example.test`]);
  await admin.query("INSERT INTO app.organization_memberships(organization_id,user_id,role,status) VALUES($1,$2,'owner','active')", [org,user]);
  await admin.query("INSERT INTO app.workspaces(id,organization_id,name,slug) VALUES($1,$2,'Home',$3)", [home,org,`home-${home}`]);
  await admin.query("INSERT INTO app.workspace_memberships(workspace_id,organization_id,user_id,role,status,source_organization_id) VALUES($1,$2,$3,'owner','active',$2)", [home,org,user]);
  await admin.query("INSERT INTO app.user_sessions(token_hash,csrf_secret_hash,user_id,selected_workspace_id,expires_at) VALUES($1,$2,$3,$4,now()+interval '1 hour')", [createHash('sha256').update(token).digest(),createHash('sha256').update(`csrf${token}`).digest(),user,home]);
  return { user, home, token };
}

test('profile async actual-role boundary: coalesce, cancelled/stale late receipts, unknown reclaim, atomic completion rollback and one unconfirmed result', { skip, timeout: 180_000 }, async () => {
  const admin = await openTestDatabase(); const content = await contentLogin(admin);
  try {
    assert.equal((await content.query('SELECT current_user AS role')).rows[0].role, 'r72_content_command');
    const alice = await seedOwner(admin), bob = await seedOwner(admin);
    const h = harness(new Date().toISOString());
    const deps = { llm: h.llm, search: h.search, transport: h.web, publishers: new Map(), vault: h.vault, now: h.clock.now };
    const userStore = new PgSeoBlogStore(content, { kind: 'user', userId: alice.user, selectedWorkspaceId: alice.home, sessionToken: alice.token, requestId: randomUUID() });
    const workerStore = new PgSeoBlogStore(content, { kind: 'worker', requestId: randomUUID() });
    const owner = new SeoBlogEngine({ ...deps, store: userStore }), worker = new SeoBlogEngine({ ...deps, store: workerStore });
    const actor = { userId: alice.user };
    const { brand } = await owner.createBrand(actor, { commandId: randomUUID(), name: 'Harbour async', website: 'https://harbour.example' });
    const identity = await withTransaction(content, { actorKind: 'worker', workspaceId: brand.id, requestId: 'profile-identity-proof' }, async (t) => (await t.query("SELECT session_user,current_user,current_setting('app.actor_kind',true) AS actor,current_setting('app.user_id',true) AS user_id,current_setting('app.workspace_id',true) AS workspace_id")).rows[0]);
    assert.equal(identity.session_user, 'r72_content_command'); assert.equal(identity.current_user, 'r72_content_command');
    assert.equal(identity.actor, 'worker'); assert.equal(identity.user_id, ''); assert.equal(identity.workspace_id, brand.id);
    await owner.updateSettings(actor, brand.id, brand.rowVersion, { budgets: { modelTokensPerMonth: 1_000_000, searchCallsPerMonth: 0, imagesPerMonth: 0 } });
    await owner.uploadKnowledge(actor, brand.id, { category: 'product_facts', title: 'Offers', pastedText: 'Harbour Compliance Plan costs £49 per month.' });
    const request = (acknowledgePriorUsage = false) => owner.requestProfileExtraction(actor, brand.id, { commandId: randomUUID(), baseVersion: 0, acknowledgePriorUsage });
    let release!: () => void; let entered!: () => void;
    const original = h.llm.complete.bind(h.llm);
    const defer = () => {
      const gate = new Promise<void>((r) => { release = r; }); const started = new Promise<void>((r) => { entered = r; }); let first = true;
      h.llm.complete = async (req) => { if (first) { first = false; entered(); await gate; } return original(req); };
      return started;
    };
    const [first, coalesced] = await Promise.all([request(), request()]);
    assert.equal(first.id, coalesced.id); assert.equal(h.llm.calls.length, 0);
    await assert.rejects(workerStore.profileJobBoundary({ brandId: brand.id, jobId: first.id, requesterId: bob.user, now: h.clock.now(), decide: () => { throw new Error('foreign requester must not reach decision'); } }), /requester does not match/);
    let started = defer(); let running = worker.tick('pg-profile-1'); await started;
    await new SeoBlogEngine({ ...deps, store: new PgSeoBlogStore(content, { kind: 'worker', requestId: randomUUID() }) }).tick('pg-profile-duplicate');
    await owner.cancelJob(actor, brand.id, first.id); release(); await running;
    const cancelled = (await workerStore.getJob(brand.id, first.id))!;
    assert.equal(cancelled.state, 'cancelled'); assert.ok(profilePayload(cancelled).receipt); assert.equal(await owner.getProfile(actor, brand.id), null);
    const firstUsage = (await owner.usage(actor, brand.id)).model_tokens; assert.ok(firstUsage > 0);
    await worker.runJob(cancelled); assert.equal((await owner.usage(actor, brand.id)).model_tokens, firstUsage);

    const stale = await request(); started = defer(); running = worker.tick('pg-profile-stale'); await started;
    await owner.uploadKnowledge(actor, brand.id, { category: 'other', title: 'Updated source', pastedText: 'Use the current pricing page; do not invent figures.' });
    release(); await running;
    const blocked = (await workerStore.getJob(brand.id, stale.id))!;
    assert.equal(blocked.state, 'blocked'); assert.equal(profilePayload(blocked).reason, 'inputs_changed'); assert.ok(profilePayload(blocked).receipt); assert.equal(await owner.getProfile(actor, brand.id), null);

    const uncertain = await request();
    const [claim] = await workerStore.claimJobs({ brandId: brand.id, now: h.clock.now(), owner: 'dead-process', leaseMs: 600_000, limit: 1 });
    assert.equal(claim!.id, uncertain.id);
    await workerStore.updateJob({ ...claim!, payload: { ...profilePayload(claim!), start: { nonce: randomUUID(), at: h.clock.now() } } });
    h.clock.advance(11 * 60_000); const before = h.llm.calls.length; await worker.tick('restart');
    const unknown = (await workerStore.getJob(brand.id, uncertain.id))!;
    assert.equal(unknown.state, 'blocked'); assert.equal(profilePayload(unknown).reason, 'outcome_unknown'); assert.equal(h.llm.calls.length, before);
    await assert.rejects(owner.retryJob(actor, brand.id, unknown.id), /uncertain outcome/); await assert.rejects(request(), /may already have used/);

    const final = await request(true); const boundary = workerStore.profileJobBoundary.bind(workerStore); let rolledBack = false;
    workerStore.profileJobBoundary = (input) => boundary({ ...input, decide: (s) => {
      const result = input.decide(s);
      if (!rolledBack && result.profile) { rolledBack = true; throw new Error('simulate completion transaction rollback'); }
      return result;
    } });
    await worker.tick('pg-profile-final');
    const completed = (await workerStore.getJob(brand.id, final.id))!;
    assert.equal(completed.state, 'done'); assert.ok(rolledBack);
    const profile = (await owner.getProfile(actor, brand.id))!;
    assert.equal(profile.version, 1); assert.equal(profile.confirmedAt, null); assert.equal(h.llm.calls.length, 3);
    const usage = await admin.query('SELECT reference,count(*)::int AS n FROM app.seo_blog_usage WHERE workspace_id=$1 GROUP BY reference', [brand.id]);
    assert.equal(usage.rows.length, 3); assert.ok(usage.rows.every((r) => r.n === 1));
    await worker.runJob(completed); assert.equal(h.llm.calls.length, 3);
    assert.equal((await admin.query("SELECT count(*)::int AS n FROM app.seo_blog_records WHERE workspace_id=$1 AND kind='profile'", [brand.id])).rows[0].n, 1);
    assert.equal((await admin.query("SELECT count(*)::int AS n FROM app.seo_blog_usage WHERE workspace_id=$1", [brand.id])).rows[0].n, 3);
  } finally { await content.end(); await admin.end(); }
});
