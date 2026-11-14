/**
 * Migration 0154 on a disposable PostgreSQL with the real roles: Martin Howard Property's content tools attach to its
 * EXISTING workspace. Only an active owner of the MHP organisation who can manage the MHP workspace may attach it; the
 * attach is idempotent, creates no workspace or membership, touches nothing outside the two blog tables (and the
 * engine's own activity line), and the 0145 trigger starts every allowance at 0 whatever settings are passed. All
 * people and addresses are synthetic.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { expectPostgresError, openTestDatabase, ownerQuery, resetIdentityTables, testDatabaseSkipReason } from './database-helper.js';
import { loginRole } from './webinar-harness.js';
import { PgSeoBlogStore } from '../../src/seo-blog/pg-store.js';
import { SeoBlogEngine } from '../../src/seo-blog/engine.js';
import { EXISTING_WORKSPACE } from '../../src/seo-blog/existing-workspace.js';
import { DEFAULT_BRAND_SETTINGS, SeoBlogError } from '../../src/seo-blog/types.js';
import { harness } from '../seo-blog-fixtures.js';

const skip = testDatabaseSkipReason();
const MHP = '2789228d-55a6-4688-b1e8-2f70abca990b', ORG = 'ba41b1a4-9752-4dbf-8312-d04a0f03d0b8';

type Admin = Awaited<ReturnType<typeof openTestDatabase>>;
interface Person { readonly user: string; readonly home: string; readonly token: string }

/** One person with their own home organisation and workspace and a portal session selected on it (never MHP). */
async function person(admin: Admin, label: string, email = `${label}-${randomUUID().slice(0, 8)}@example.invalid`): Promise<Person> {
  const user = randomUUID(), org = randomUUID(), home = randomUUID(), token = `${label}-${randomUUID()}${randomUUID()}`;
  await ownerQuery(admin, `DO $s$ BEGIN
    PERFORM set_config('app.user_id','${user}',true); PERFORM set_config('app.request_id','attach-fixture',true);
    INSERT INTO app.users(id,email,display_name,status,email_verified_at) VALUES('${user}','${email}','${label}','active',clock_timestamp());
    INSERT INTO app.organizations(id,name,slug,kind) VALUES('${org}','${label} home','home-${org.slice(0, 8)}','direct_customer');
    INSERT INTO app.organization_memberships(organization_id,user_id,role,status) VALUES('${org}','${user}','owner','active');
    INSERT INTO app.workspaces(id,organization_id,name,slug) VALUES('${home}','${org}','${label} home','home-${home.slice(0, 8)}');
    INSERT INTO app.workspace_memberships(workspace_id,organization_id,user_id,role,status,source_organization_id) VALUES('${home}','${org}','${user}','owner','active','${org}');
  END $s$`);
  await ownerQuery(admin, `INSERT INTO app.user_sessions(token_hash,csrf_secret_hash,user_id,selected_workspace_id,expires_at) VALUES($1,$2,$3,$4,now()+interval '1 hour')`,
    [createHash('sha256').update(token).digest(), createHash('sha256').update(`csrf${token}`).digest(), user, home]);
  return { user, home, token };
}

async function mhpMember(admin: Admin, who: Person, orgRole: 'owner' | 'admin' | 'billing', workspaceRole: 'owner' | 'admin' | 'viewer') {
  await ownerQuery(admin, `DO $s$ BEGIN
    PERFORM set_config('app.user_id','${who.user}',true); PERFORM set_config('app.request_id','attach-fixture',true);
    INSERT INTO app.organization_memberships(organization_id,user_id,role,status) VALUES('${ORG}','${who.user}','${orgRole}','active');
    INSERT INTO app.workspace_memberships(workspace_id,organization_id,user_id,role,status) VALUES('${MHP}','${ORG}','${who.user}','${workspaceRole}','active');
    -- MHP's own rule (0124/0151): only a programme admin who owns the organisation and the workspace manages it.
    INSERT INTO app_private.investor_programme_admins(user_id) VALUES('${who.user}');
  END $s$`);
}

/** Every row of every table in app and app_private the owner role can read, hashed per table. */
async function fingerprint(admin: Admin): Promise<Map<string, string>> {
  const tables = await ownerQuery<{ t: string }>(admin, `SELECT format('%I.%I',schemaname,tablename) AS t FROM pg_tables WHERE schemaname IN ('app','app_private') ORDER BY 1`);
  const out = new Map<string, string>();
  for (const { t } of tables) {
    const rows = await ownerQuery<{ h: string | null }>(admin, `SELECT md5(coalesce(string_agg(x::text,'|' ORDER BY x::text),'')) AS h FROM ${t} x`).catch(() => null);
    if (rows) out.set(t, rows[0]!.h ?? '');
  }
  return out;
}

test('0154 attach on real roles: only the eligible MHP owner, only the MHP workspace, once, at a zero allowance, and nothing outside the blog tables changes', { skip, timeout: 180_000 }, async () => {
  const admin = await openTestDatabase();
  const content = await loginRole(admin, 'r72_content_command'), web = await loginRole(admin, 'r72_web');
  try {
    await resetIdentityTables(admin);
    // The live MHP brand workspace as 0124 makes it, with one synthetic CRM contact that must stay untouched.
    await ownerQuery(admin, `DO $s$ BEGIN
      PERFORM set_config('app.request_id','attach-fixture',true);
      INSERT INTO app.organizations(id,name,slug,kind) VALUES('${ORG}','Martin Howard Property','mhp-attach-proof','direct_customer');
      INSERT INTO app.workspaces(id,organization_id,name,slug) VALUES('${MHP}','${ORG}','Martin Howard Property · Marketing','mhp-brand-marketing');
      INSERT INTO app.contacts(workspace_id,display_name) VALUES('${MHP}','Synthetic CRM contact');
    END $s$`);
    // MHP's programme-admin rule pins two addresses (0116/0124); the founder holds one, the viewer-owner the other.
    const founder = await person(admin, 'founder', 'martin.howard1984@gmail.com'), admin2 = await person(admin, 'mhpadmin'),
      viewer = await person(admin, 'viewerowner', 'office@propertypredator.com'),
      stranger = await person(admin, 'otherowner');
    await mhpMember(admin, founder, 'owner', 'owner');
    await mhpMember(admin, admin2, 'admin', 'admin');      // a workspace admin and programme admin who is not an organisation owner
    await mhpMember(admin, viewer, 'owner', 'viewer');     // an organisation owner who cannot manage the workspace
    // stranger: owner of another organisation only.
    const h = harness();
    const engineFor = (p: Person) => new SeoBlogEngine({
      store: new PgSeoBlogStore(content, { kind: 'user', userId: p.user, requestId: `attach-${randomUUID()}`, sessionToken: p.token, selectedWorkspaceId: p.home }),
      llm: h.llm, search: h.search, transport: h.web, publishers: new Map(), vault: h.vault, now: h.clock.now,
    });
    const workspacesBefore = await ownerQuery<{ n: number }>(admin, 'SELECT count(*)::int AS n FROM app.workspaces');
    const membershipsBefore = await ownerQuery<{ n: number }>(admin, 'SELECT (SELECT count(*) FROM app.workspace_memberships)::int+(SELECT count(*) FROM app.organization_memberships)::int AS n');
    const before = await fingerprint(admin);

    // Who is offered the card, and who may attach.
    assert.equal(await engineFor(founder).existingWorkspaceOffer({ userId: founder.user }), true);
    for (const p of [admin2, viewer, stranger]) {
      assert.equal(await engineFor(p).existingWorkspaceOffer({ userId: p.user }), false);
      await assert.rejects(engineFor(p).attachExistingWorkspace({ userId: p.user }, { commandId: randomUUID() }),
        (e: unknown) => e instanceof SeoBlogError && e.status === 403);
    }
    // A direct call: another database role has no EXECUTE; the owning role itself is refused unless the session user is
    // the content command role; any other workspace id is refused; the offer for another id is simply false.
    await expectPostgresError(web.query('SELECT app_private.seo_blog_attach_workspace($1,$2,NULL,$3)', [randomUUID(), MHP, '{}']), '42501');
    await expectPostgresError(web.query('SELECT app_private.seo_blog_attach_workspace_offer($1)', [MHP]), '42501');
    const boundary = { code: '42501', message: /Content command boundary required/ };
    await assert.rejects(ownerQuery(admin, `SELECT set_config('app.user_id',$1,true),set_config('app.workspace_id',$2,true),set_config('app.actor_kind','user',true),
      app_private.seo_blog_attach_workspace($3,$4,NULL,'{}')`, [founder.user, founder.home, randomUUID(), MHP]), boundary);
    await assert.rejects(ownerQuery(admin, 'SELECT app_private.seo_blog_attach_workspace_offer($1)', [MHP]), boundary);
    const raw = await content.connect();
    try {
      await raw.query('BEGIN');
      await raw.query(`SELECT set_config('app.user_id',$1,true),set_config('app.workspace_id',$2,true),set_config('app.actor_kind','user',true),set_config('app.request_id','x',true)`, [founder.user, founder.home]);
      await raw.query('SAVEPOINT a');
      await assert.rejects(raw.query('SELECT app_private.seo_blog_attach_workspace($1,$2,NULL,$3)', [randomUUID(), founder.home, '{}']),
        { code: '42501', message: /Only the Martin Howard Property workspace can be attached/ });
      await raw.query('ROLLBACK TO SAVEPOINT a');
      assert.equal((await raw.query('SELECT app_private.seo_blog_attach_workspace_offer($1) AS o', [founder.home])).rows[0].o, false);
      // Passing spend authority in the settings cannot bypass the 0145 trigger: the row still starts at zero.
      const greedy = { ...DEFAULT_BRAND_SETTINGS, budgets: { modelTokensPerMonth: 9_000_000, searchCallsPerMonth: 9_000, imagesPerMonth: 900 },
        operatorLimits: { modelTokens: null, searchCalls: null, images: null, studioImages: null }, studioImages: { enabled: true, perMonth: 50 } };
      const r = await raw.query('SELECT app_private.seo_blog_attach_workspace($1,$2,NULL,$3) AS r', [randomUUID(), MHP, JSON.stringify(greedy)]);
      assert.equal(r.rows[0].r.attached, true);
      const s = (await raw.query<{ b: { settings: Record<string, any> } }>('SELECT app_private.seo_blog_list_brands() AS b')).rows.find((x) => x.b.settings && (x.b as any).id === MHP)!.b.settings;
      assert.deepEqual(s.budgets, { modelTokensPerMonth: 0, searchCallsPerMonth: 0, imagesPerMonth: 0 });
      assert.deepEqual([s.operatorLimits.modelTokens, s.operatorLimits.searchCalls, s.operatorLimits.images, s.operatorLimits.studioImages], [0, 0, 0, 0]);
      assert.deepEqual(s.studioImages, { enabled: false, perMonth: 0 });
      await raw.query('ROLLBACK');
    } finally { raw.release(); }
    assert.equal((await ownerQuery<{ n: number }>(admin, 'SELECT count(*)::int AS n FROM app.seo_blog_brands')).at(0)!.n, 0, 'the rolled-back probe left nothing');

    // The founder attaches: two clicks at once and a replay attach exactly once.
    const command = randomUUID();
    const [first, second] = await Promise.all([
      engineFor(founder).attachExistingWorkspace({ userId: founder.user }, { commandId: command }),
      engineFor(founder).attachExistingWorkspace({ userId: founder.user }, { commandId: randomUUID() }),
    ]);
    assert.deepEqual([first.attached, second.attached].sort(), [false, true]);
    const replay = await engineFor(founder).attachExistingWorkspace({ userId: founder.user }, { commandId: command });
    assert.equal(replay.attached, false);
    assert.equal(replay.brand.id, MHP);
    assert.equal(await engineFor(founder).existingWorkspaceOffer({ userId: founder.user }), false, 'the card goes once attached');
    // A command id already used for another business is refused, not re-pointed.
    const other = await engineFor(founder).createBrand({ userId: founder.user }, { commandId: randomUUID(), name: 'Harbour Lettings' });
    const reused = (await ownerQuery<{ command_id: string }>(admin, 'SELECT command_id FROM app.seo_blog_brand_commands WHERE workspace_id=$1', [other.brand.id]))[0]!.command_id;
    await assert.rejects(engineFor(founder).attachExistingWorkspace({ userId: founder.user }, { commandId: reused }), (e: unknown) => e instanceof SeoBlogError && e.status === 400);

    // The row, and what listBrands returns: the founder sees it; nobody else does (MHP's workspace rule admits only its owner).
    const rows = await ownerQuery<{ workspace_id: string; organization_id: string; created_by_user_id: string; website: string | null; settings: Record<string, any> }>(admin,
      'SELECT workspace_id,organization_id,created_by_user_id,website,settings FROM app.seo_blog_brands WHERE workspace_id=$1', [MHP]);
    assert.equal(rows.length, 1);
    const row = rows[0]!;
    assert.deepEqual([row.workspace_id, row.organization_id, row.website], [MHP, ORG, null]);
    assert.ok([founder.user].includes(row.created_by_user_id));
    assert.deepEqual(row.settings.budgets, { modelTokensPerMonth: 0, searchCallsPerMonth: 0, imagesPerMonth: 0 });
    assert.deepEqual([row.settings.operatorLimits.modelTokens, row.settings.operatorLimits.searchCalls, row.settings.operatorLimits.images, row.settings.operatorLimits.studioImages], [0, 0, 0, 0]);
    assert.equal(row.settings.operatorLimits.configuredBy, 'system');
    for (const key of ['autoPublish', 'ongoingProduction', 'autoAcceptPlans', 'pauseAll'] as const) assert.equal(row.settings[key], false, key);
    const listed = (await engineFor(founder).listBrands({ userId: founder.user })).find((b) => b.id === MHP)!;
    assert.deepEqual({ id: listed.id, organizationId: listed.organizationId, createdBy: listed.createdBy, website: listed.website, budgets: listed.settings.budgets },
      { id: MHP, organizationId: ORG, createdBy: row.created_by_user_id, website: null, budgets: row.settings.budgets });
    assert.equal(listed.name, 'Martin Howard Property · Marketing', 'the existing workspace keeps its own name');
    assert.equal(replay.brand.rowVersion, listed.rowVersion);
    for (const p of [admin2, viewer, stranger]) assert.equal((await engineFor(p).listBrands({ userId: p.user })).some((b) => b.id === MHP), false);
    // Brand DNA opens for it like any business, and the activity says what happened, once.
    assert.equal((await engineFor(founder).getBrand({ userId: founder.user }, MHP)).id, MHP);
    assert.equal((await ownerQuery<{ n: number }>(admin, "SELECT count(*)::int AS n FROM app.seo_blog_activity WHERE workspace_id=$1 AND kind='brand.attached'", [MHP]))[0]!.n, 1);

    // Nothing else was created or changed: no workspace or membership beyond Harbour Lettings' own, no CRM, consent,
    // webinar, email or MHP row. Only the blog tables and the sessions' own bookkeeping differ.
    assert.equal((await ownerQuery<{ n: number }>(admin, 'SELECT count(*)::int AS n FROM app.workspaces'))[0]!.n, workspacesBefore[0]!.n + 1);
    assert.equal((await ownerQuery<{ n: number }>(admin, 'SELECT (SELECT count(*) FROM app.workspace_memberships)::int+(SELECT count(*) FROM app.organization_memberships)::int AS n'))[0]!.n, membershipsBefore[0]!.n + 1);
    const after = await fingerprint(admin);
    const changed = [...after.keys()].filter((t) => after.get(t) !== before.get(t)).sort();
    const expected = new Set(['app.seo_blog_activity', 'app.seo_blog_brand_commands', 'app.seo_blog_brands', 'app.workspaces', 'app.workspace_memberships', 'app.user_sessions']);
    assert.deepEqual(changed.filter((t) => !expected.has(t)), [], `unexpected changes: ${changed.join(', ')}`);
    assert.equal((await ownerQuery<{ n: number }>(admin, "SELECT count(*)::int AS n FROM app.workspaces WHERE organization_id=$1", [ORG]))[0]!.n, 1, 'no second MHP workspace');
    assert.deepEqual((await ownerQuery<{ display_name: string }>(admin, 'SELECT display_name FROM app.contacts WHERE workspace_id=$1', [MHP])).map((c) => c.display_name), ['Synthetic CRM contact']);
  } finally {
    await content.end(); await web.end(); await admin.end();
  }
});
