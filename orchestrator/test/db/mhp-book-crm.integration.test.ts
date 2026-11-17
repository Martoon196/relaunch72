/**
 * Book sign-ups into the MHP brand CRM, and migration 0159, on a disposable PostgreSQL with the real roles and runner.
 *
 * 1. Migration 0159 converges both starting states: fresh (0001-0158 only: every statement a no-op, privileges and
 *    objects identical before and after) and production-shaped (0001-0158 plus the two docs/ops files applied as their
 *    recorded roles: the trigger, function, ten policies and the quick fix's grants removed, 0134's SELECT on
 *    app.contact_points kept, no CRM or sign-up row touched). A run rolled back half way leaves production-shaped state
 *    as it was; a second run of the file is a no-op.
 * 2. Release order A, production-shaped: the new code while the trigger is still live (one enquiry, one task, the
 *    trigger's lead enriched with phone, permission and sign-up evidence, stage/owner/tasks untouched; the trigger still
 *    fails a sign-up on a CRM fault, which is what 0159 cures); then 0159 by the runner; then the new code alone: a lead
 *    with and without a mobile, a repeat sign-up that adds a mobile, a repeat after the enquiry was closed, two sign-ups
 *    racing, an existing contact with the same email, an ambiguous contact, a test address, a CRM fault injected at
 *    each step (the sign-up is saved; the next catch-up creates the lead), a webinar sign-up at the same time
 *    (unaffected), the owner's statuses, catch-up and button, and the run-time workspace owner.
 * 3. Release order B: fresh to 0159 first, then the new code.
 * Nothing is sent: no email, SMS or WhatsApp row is written and no consent ledger event is recorded. All synthetic.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { assertDisposableTestDatabase, openTestDatabase, ownerQuery, testDatabaseSkipReason } from './database-helper.js';
import { discoverMigrations, runMigrations } from '../../src/db/migrate.js';
import { assertRuntimeSchemaCurrent } from '../../src/db/runtime-readiness.js';
import { MHP_BOOK_CRM_MIGRATION } from '../../src/db/mhp-book-crm-schema.js';
import { createInboxCrmRunner } from '../../src/integrations/group-hq-crm/inbox.js';
import { CrmCommandService } from '../../src/crm-pg/commands.js';
import type { CrmTransactionRunner } from '../../src/crm-pg/types.js';
import { requestDatabaseContext } from '../../src/db/rls.js';
import { PgMhpGrowthService, mhpWebinarConfig, MHP_CONSENT_VERSION, type MhpSignup } from '../../src/mhp/growth-service.js';
import { MHP_BOOK_INTEREST_LABEL } from '../../src/mhp/book-interest.js';
import { MHP_MARKETING_WORKSPACE_ID as WS } from '../../src/mhp/marketing-workspace-service.js';
import { MhpBookLeadService, bookCandidateFromCapture, bookTaskDue, readMhpWorkspaceOwner, MHP_BOOK_MODULE,
  MHP_BOOK_SOURCE } from '../../src/mhp/book-leads-service.js';

const skip = testDatabaseSkipReason();
type Admin = Awaited<ReturnType<typeof openTestDatabase>>;
const OWNER = '5a3e599f-c3bd-4fdc-acc0-a3f5fa95fab4';
const SECRET = 'book-crm-integration-cursor-secret-0159';
const CRM_TABLES = ['contacts', 'contact_points', 'opportunities', 'opportunity_stage_history', 'tasks', 'activities', 'command_receipts', 'outbox_events'];
const SEVEN = ['contacts', 'contact_points', 'pipelines', 'pipeline_stages', 'opportunities', 'opportunity_stage_history', 'tasks'];
const repoRoot = new URL('../../../', import.meta.url);

async function login(admin: Admin, role: string, max = 6): Promise<pg.Pool> {
  assertDisposableTestDatabase(process.env.TEST_DATABASE_URL ?? '');
  const password = randomUUID() + randomUUID();
  const statement = await admin.query<{ sql: string }>("SELECT format('ALTER ROLE %I PASSWORD %L', $1::text, $2::text) AS sql", [role, password]);
  await admin.query(statement.rows[0]!.sql);
  const url = new URL(process.env.TEST_DATABASE_URL!);
  url.username = role;
  url.password = password;
  return new pg.Pool({ connectionString: url.toString(), max, application_name: 'relaunch72-disposable-book-crm' });
}

async function prefixDirectory(count: number): Promise<string> {
  const prefix = (await discoverMigrations()).slice(0, count);
  const directory = await mkdtemp(path.join(tmpdir(), `r72-book-crm-${count}-`));
  await Promise.all(prefix.map(m => writeFile(path.join(directory, m.filename), m.sql, 'utf8')));
  return directory;
}

async function resetDisposable(): Promise<void> {
  const child = spawn(process.execPath, ['--import', './test/windows-node24-shim.mjs', '--import', 'tsx', 'test/db/reset-disposable.ts'],
    { cwd: process.cwd(), env: process.env, stdio: ['ignore', 'ignore', 'inherit'], windowsHide: true });
  const [code] = await once(child, 'exit') as [number | null];
  assert.equal(code, 0, 'the disposable reset ran');
}

/** Run SQL text (several statements) in one transaction on one migrator connection, exactly like a hand-applied file. */
async function script(admin: Admin, sql: string, finish: 'COMMIT' | 'ROLLBACK' = 'COMMIT', role?: string): Promise<void> {
  const client = await admin.connect();
  try {
    await client.query('BEGIN');
    if (role) await client.query(`SET LOCAL ROLE ${role}`);
    await client.query(sql);
    await client.query(finish);
  } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
  finally { client.release(); }
}

/** The synthetic production-like MHP brand workspace: the ids the recorded docs/ops files hard-code, so they run unchanged. */
const SEED = `SELECT set_config('app.request_id','book-crm-seed',true);
UPDATE app.users SET email='seeded-pending-owner@example.test' WHERE email='martin.howard1984@gmail.com' AND id<>'${OWNER}';
INSERT INTO app.users(id,email,display_name,status,email_verified_at) VALUES('${OWNER}','martin.howard1984@gmail.com','Synthetic owner','active',clock_timestamp());
INSERT INTO app_private.investor_programme_admins(user_id) VALUES('${OWNER}');
INSERT INTO app.organization_memberships(organization_id,user_id,role,status) VALUES('ba41b1a4-9752-4dbf-8312-d04a0f03d0b8','${OWNER}','owner','active');
INSERT INTO app.workspaces(id,organization_id,name,slug) VALUES('${WS}','ba41b1a4-9752-4dbf-8312-d04a0f03d0b8','Martin Howard Property · Marketing','mhp-brand-marketing');
INSERT INTO app.workspace_memberships(workspace_id,organization_id,user_id,role,status) VALUES('${WS}','ba41b1a4-9752-4dbf-8312-d04a0f03d0b8','${OWNER}','owner','active');
WITH p AS (INSERT INTO app.pipelines(workspace_id,name,slug,is_default) VALUES('${WS}','Enquiries and follow-ups','enquiries',true) RETURNING id)
INSERT INTO app.pipeline_stages(workspace_id,pipeline_id,name,slug,position,stage_type,is_terminal)
SELECT '${WS}',p.id,label,slug,position,kind,kind IN('won','lost') FROM p,(VALUES
 ('New enquiry','new',10,'open'),('Contacted','contacted',20,'open'),('Call booked','call-booked',30,'open'),
 ('Qualified','qualified',40,'open'),('Opportunity shared','opportunity-shared',50,'open'),
 ('Follow-up','follow-up',60,'open'),('Completed','completed',70,'won'),('Not proceeding','not-proceeding',80,'lost')) s(label,slug,position,kind);`;

async function applyQuickFix(admin: Admin): Promise<void> {
  for (const file of ['mhp-book-contact-sync-20261117.sql', 'mhp-book-pipeline-sync-20261117.sql']) {
    await script(admin, await readFile(new URL(`docs/ops/${file}`, repoRoot), 'utf8'));
  }
}

/** Every privilege, policy, function, trigger and membership that the quick fix or 0159 could touch, as sorted lines. */
async function listing(admin: Admin): Promise<string[]> {
  const rows = await admin.query<{ line: string }>(`
    SELECT 'table-acl|'||n.nspname||'.'||c.relname||'|'||a.privilege_type||'|'||a.grantor::regrole::text AS line
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace CROSS JOIN LATERAL aclexplode(c.relacl) a
      WHERE a.grantee='r72_mhp_prospect_definer'::regrole
    UNION ALL SELECT 'column-acl|'||c.relname||'.'||at.attname||'|'||a.privilege_type FROM pg_attribute at JOIN pg_class c ON c.oid=at.attrelid
      CROSS JOIN LATERAL aclexplode(at.attacl) a WHERE a.grantee='r72_mhp_prospect_definer'::regrole
    UNION ALL SELECT 'schema-acl|'||n.nspname||'|'||a.privilege_type FROM pg_namespace n CROSS JOIN LATERAL aclexplode(n.nspacl) a
      WHERE a.grantee='r72_mhp_prospect_definer'::regrole
    UNION ALL SELECT 'policy|'||schemaname||'.'||tablename||'|'||policyname||'|'||cmd||'|'||array_to_string(roles,',') FROM pg_policies
      WHERE (schemaname='app' AND tablename=ANY($1::text[])) OR 'r72_mhp_prospect_definer'=ANY(roles)
    UNION ALL SELECT 'function|'||p.oid::regprocedure::text||'|'||pg_get_userbyid(p.proowner) FROM pg_proc p WHERE p.proname LIKE 'mhp\\_book\\_%'
    UNION ALL SELECT 'function-acl|'||p.oid::regprocedure::text||'|'||coalesce(a.grantee::regrole::text,'PUBLIC')||'|'||a.privilege_type||'|'||p.prosecdef::text||'|'||array_to_string(p.proconfig,',')
      FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a WHERE p.proname LIKE 'mhp\_book\_%' AND a.grantee<>0
    UNION ALL SELECT 'function-public|'||p.oid::regprocedure::text FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
      WHERE p.proname LIKE 'mhp\_book\_%' AND a.grantee=0
    UNION ALL SELECT 'column|'||a.attrelid::regclass::text||'.'||a.attname||'|'||format_type(a.atttypid,a.atttypmod)||'|'||a.attnotnull::text FROM pg_attribute a
      WHERE a.attrelid='app_private.mhp_prospect_signups'::regclass AND a.attnum>0 AND NOT a.attisdropped
    UNION ALL SELECT 'constraint|'||conname||'|'||pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid='app_private.mhp_prospect_signups'::regclass
    UNION ALL SELECT 'owned-functions|'||count(*)::text FROM pg_proc WHERE proowner='r72_mhp_prospect_definer'::regrole
    UNION ALL SELECT 'trigger|'||tgrelid::regclass::text||'|'||tgname FROM pg_trigger
      WHERE NOT tgisinternal AND tgrelid IN ('app_private.mhp_prospect_signups'::regclass,'app_private.mhp_prospects'::regclass)
    UNION ALL SELECT 'membership|'||r.rolname FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.roleid WHERE m.member='r72_mhp_prospect_definer'::regrole
    UNION ALL SELECT 'crm-command-acl|'||c.relname||'|'||a.privilege_type FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
      WHERE c.relnamespace='app'::regnamespace AND c.relname=ANY($1::text[]) AND a.grantee='r72_crm_command'::regrole`, [SEVEN]);
  return rows.rows.map(r => r.line).sort();
}

/** A digest of every CRM, prospect and sign-up row in the brand workspace (0159 must not touch one). */
async function rowsDigest(admin: Admin): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const table of [...CRM_TABLES.map(t => `app.${t}`), 'app.pipelines', 'app.pipeline_stages']) {
    out[table] = (await ownerQuery<{ d: string }>(admin, `SELECT coalesce(md5(string_agg(t::text, '|' ORDER BY t::text)),'') AS d FROM ${table} t WHERE workspace_id=$1`, [WS]))[0]!.d;
  }
  out['app_private.mhp_prospects'] = (await ownerQuery<{ d: string }>(admin, `SELECT coalesce(md5(string_agg(t::text, '|' ORDER BY t::text)),'') AS d FROM app_private.mhp_prospects t`))[0]!.d;
  // Every column the sign-ups had before 0159, value for value; 0159's new phone column must be empty on every old row.
  out['app_private.mhp_prospect_signups'] = (await ownerQuery<{ d: string }>(admin, `SELECT coalesce(md5(string_agg((to_jsonb(t)-'phone')::text, '|' ORDER BY (to_jsonb(t)-'phone')::text)),'') AS d FROM app_private.mhp_prospect_signups t`))[0]!.d;
  out['phones on sign-ups'] = (await ownerQuery<{ n: string }>(admin, `SELECT count(*) FILTER (WHERE (to_jsonb(t)->>'phone') IS NOT NULL)::text AS n FROM app_private.mhp_prospect_signups t`))[0]!.n;
  return out;
}

/** Messages of any kind and consent-ledger events: this release must never add one. */
async function sendsDigest(admin: Admin): Promise<string> {
  const counts = await ownerQuery<{ c: string }>(admin, `SELECT concat_ws(',',
    (SELECT count(*) FROM app_private.mhp_marketing_sends),(SELECT count(*) FROM app.messages),(SELECT count(*) FROM app.message_deliveries),
    (SELECT count(*) FROM app.provider_operations),(SELECT count(*) FROM app.communication_consent_events),
    (SELECT count(*) FROM app.communication_suppression_events),(SELECT count(*) FROM app_private.mhp_event_phone_intents)) AS c`);
  return counts[0]!.c;
}

interface Lead { contacts: number; opportunities: { id: string; name: string; stage: string; status: string; owner: string | null; rowVersion: number }[];
  tasks: { title: string; status: string; assignee: string | null; description: string | null; dueAt: Date | null }[];
  points: { kind: string; value: string; normalized: string; verified: boolean; consent: string; primary: boolean }[];
  source: string | null; fields: Record<string, unknown>; activities: string[]; contactOwner: string | null }

async function lead(admin: Admin, email: string): Promise<Lead | null> {
  const contact = (await ownerQuery<{ id: string; source: string | null; fields: Record<string, unknown>; owner: string | null }>(admin,
    `SELECT c.id,c.source,c.custom_fields AS fields,c.owner_user_id AS owner FROM app.contacts c JOIN app.contact_points p ON p.workspace_id=c.workspace_id AND p.contact_id=c.id
     WHERE c.workspace_id=$1 AND p.kind='email' AND lower(p.normalized_value)=$2 AND p.deleted_at IS NULL`, [WS, email]));
  if (contact.length === 0) return null;
  assert.equal(contact.length, 1, `one contact holds ${email}`);
  const id = contact[0]!.id;
  const opportunities = await ownerQuery<Lead['opportunities'][number]>(admin, `SELECT o.id,o.name,s.name AS stage,o.status,o.owner_user_id AS owner,o.row_version::integer AS "rowVersion"
    FROM app.opportunities o JOIN app.pipeline_stages s ON s.workspace_id=o.workspace_id AND s.id=o.stage_id WHERE o.workspace_id=$1 AND o.contact_id=$2 ORDER BY o.created_at`, [WS, id]);
  const tasks = await ownerQuery<Lead['tasks'][number]>(admin, `SELECT title,status,assignee_user_id AS assignee,description,due_at AS "dueAt" FROM app.tasks
    WHERE workspace_id=$1 AND contact_id=$2 ORDER BY created_at`, [WS, id]);
  const points = await ownerQuery<Lead['points'][number]>(admin, `SELECT kind,value,normalized_value AS normalized,is_verified AS verified,consent_status AS consent,is_primary AS primary
    FROM app.contact_points WHERE workspace_id=$1 AND contact_id=$2 AND deleted_at IS NULL ORDER BY kind,created_at`, [WS, id]);
  const activities = (await ownerQuery<{ t: string }>(admin, 'SELECT activity_type AS t FROM app.activities WHERE workspace_id=$1 AND contact_id=$2 ORDER BY occurred_at,created_at', [WS, id])).map(r => r.t);
  return { contacts: 1, opportunities, tasks, points, source: contact[0]!.source, fields: contact[0]!.fields, activities, contactOwner: contact[0]!.owner };
}

const bookSignup = (email: string, firstName: string | null, phone: string | null = null): MhpSignup => ({ email, firstName, level: null, consent: true,
  kind: 'waitlist', label: MHP_BOOK_INTEREST_LABEL, module: MHP_BOOK_MODULE, link: 'https://martinhowardproperty.co.uk/book/', phone });
const webinarSignup = (email: string): MhpSignup => ({ email, firstName: 'Viewer', level: 'L1', consent: true, kind: 'webinar', label: 'Webinar',
  module: null, link: 'https://martinhowardproperty.co.uk/webinar/', phone: '07700 900777' });

/** Everything the release composes, on the real logins. */
async function world(admin: Admin) {
  const web = await login(admin, 'r72_web'), identityPool = await login(admin, 'r72_identity_command'), crm = await login(admin, 'r72_crm_command', 8);
  const growth = new PgMhpGrowthService(web, identityPool, mhpWebinarConfig({}));
  const base = createInboxCrmRunner(crm);
  let fault: string | null = null;
  let transactions = 0;
  /** The real CRM command runner, with an optional fault injected at the first statement whose text contains `fault`. */
  const runner: CrmTransactionRunner = { run: (context, operation) => { transactions++; return base.run(context, tx => operation({ query: async (sql, values) => {
    if (fault && sql.includes(fault)) throw Object.assign(new Error(`injected fault at ${fault}`), { code: 'XX159' });
    return tx.query(sql, values);
  } })); } };
  const logs: string[] = [];
  const token = randomUUID().replace(/-/g, '') + 'abcdefghijk';
  assert.equal(token.length, 43);
  await ownerQuery(admin, `INSERT INTO app.user_sessions(token_hash,csrf_secret_hash,user_id,selected_workspace_id,expires_at,product_audience)
    VALUES($1,$2,$3,$4,now()+interval '2 hours','martin_howard_property')`,
  [createHash('sha256').update(token).digest(), createHash('sha256').update(`csrf${token}`).digest(), OWNER, WS]);
  const identity = { sessionToken: token, userId: OWNER, workspaceId: WS, userEmail: 'martin.howard1984@gmail.com' };
  const service = (ownerUserId: string | null = OWNER) => new MhpBookLeadService({ transactions: runner, ownerUserId, cursorSecret: SECRET,
    registrants: t => growth.listRegistrants(t), bookSignups: t => growth.listBookSignups(t), workspaceOwner: who => readMhpWorkspaceOwner(web, who), log: line => logs.push(line),
    retryDelaysMs: [], schedule: () => undefined });
  /** The public form: the sign-up is committed, then the copy runs (awaited here so the test can look at the result). */
  const kept: string[] = [];
  /** What the router does: capture, keep a book mobile on its sign-up (0159), then the CRM copy. */
  const capture = async (signup: MhpSignup) => {
    const captured = await growth.capture(signup, null);
    if (signup.kind === 'waitlist' && signup.module === MHP_BOOK_MODULE && signup.phone) kept.push(await growth.keepBookPhone(captured, signup.phone));
    return captured;
  };
  const signUp = async (signup: MhpSignup, books = service()) => {
    const captured = await capture(signup);
    const outcome = signup.kind === 'waitlist' ? await books.project(OWNER, bookCandidateFromCapture(signup, captured, Date.now())) : null;
    return { captured, outcome };
  };
  const commands = new CrmCommandService({ transactionRunner: base });
  const ownerContext = () => requestDatabaseContext({ workspaceId: WS, userId: OWNER, requestId: `owner-${randomUUID()}` });
  const close = async () => { await Promise.all([web.end(), identityPool.end(), crm.end()]); };
  return { web, growth, runner, logs, identity, service, signUp, capture, kept, commands, ownerContext, close,
    setFault: (value: string | null) => { fault = value; }, transactions: () => transactions };
}

const trimmed = (lines: string[]) => lines.filter(l => !l.startsWith('crm-command-acl|'));

test('0159 changes nothing on a fresh database and converges a production-shaped one to it; rolled back or repeated it is safe', { skip, timeout: 900_000 }, async () => {
  const admin = await openTestDatabase();
  const outDir = process.env.BOOK_CRM_LISTING_DIR?.trim();
  try {
    await resetDisposable();
    const all = await discoverMigrations();
    // 0160 (book readers audience) is a later, separate release: this test stops at 0159.
    assert.ok(all.length >= 159);
    assert.equal(all[158]!.filename, MHP_BOOK_CRM_MIGRATION);
    const sql159 = all[158]!.sql;

    // Fresh: 0001-0158 only, then 0159 by the runner.
    await runMigrations(admin, await prefixDirectory(158));
    await script(admin, SEED, 'COMMIT', 'r72_owner');
    const fresh158 = await listing(admin);
    const freshRows = await rowsDigest(admin);
    assert.deepEqual((await runMigrations(admin, await prefixDirectory(159))).applied, [MHP_BOOK_CRM_MIGRATION]);
    const fresh159 = await listing(admin);
    // On a fresh database 0159 changes nothing that existed; it adds exactly the column, its check and the two functions.
    const added159 = fresh159.filter(l => !fresh158.includes(l)), removed159 = fresh158.filter(l => !fresh159.includes(l));
    assert.deepEqual(removed159, ['owned-functions|92']);
    assert.deepEqual(added159.sort(), [
      'column|app_private.mhp_prospect_signups.phone|text|false',
      "constraint|mhp_prospect_signups_phone_check|CHECK (((phone IS NULL) OR (((length(phone) >= 6) AND (length(phone) <= 30)) AND (phone ~ '^[0-9 +()-]+$'::text))))",
      'function-acl|app_private.mhp_book_signup_keep_phone(uuid,uuid,text)|r72_identity_command|EXECUTE|true|search_path=pg_catalog',
      'function-acl|app_private.mhp_book_signup_keep_phone(uuid,uuid,text)|r72_mhp_prospect_definer|EXECUTE|true|search_path=pg_catalog',
      'function-acl|app_private.mhp_book_signups(bytea)|r72_mhp_prospect_definer|EXECUTE|true|search_path=pg_catalog',
      'function-acl|app_private.mhp_book_signups(bytea)|r72_web|EXECUTE|true|search_path=pg_catalog',
      'function|app_private.mhp_book_signup_keep_phone(uuid,uuid,text)|r72_mhp_prospect_definer',
      'function|app_private.mhp_book_signups(bytea)|r72_mhp_prospect_definer',
      'owned-functions|94',
    ].sort());
    assert.deepEqual(await rowsDigest(admin), freshRows);
    assert.ok(fresh158.includes('table-acl|app.contact_points|SELECT|r72_owner'), "0134's SELECT on app.contact_points is there before and kept");
    await script(admin, sql159);
    assert.deepEqual(await listing(admin), fresh159, 'a second run of the file is a no-op');
    if (outDir) {
      await writeFile(path.join(outDir, 'fresh-0158.txt'), fresh158.join('\n') + '\n');
      await writeFile(path.join(outDir, 'fresh-0159.txt'), fresh159.join('\n') + '\n');
    }

    // Production-shaped: 0001-0158, the synthetic brand workspace, then the two docs/ops files as recorded.
    await resetDisposable();
    await runMigrations(admin, await prefixDirectory(158));
    await script(admin, SEED, 'COMMIT', 'r72_owner');
    const before = await listing(admin);
    await applyQuickFix(admin);
    const prod158 = await listing(admin);
    const added = prod158.filter(l => !before.includes(l)), removed = before.filter(l => !prod158.includes(l));
    assert.deepEqual(removed, ['owned-functions|92'], 'the quick fix only added things (the count of owned functions goes 92 to 93)');
    assert.deepEqual(trimmed(added).sort(), [
      'function|app_private.mhp_book_contact_after_signup()|r72_mhp_prospect_definer',
      'function-acl|app_private.mhp_book_contact_after_signup()|r72_mhp_prospect_definer|EXECUTE|true|search_path=pg_catalog',
      'owned-functions|93',
      ...['contact_points|mhp_book_point_insert|INSERT', 'contact_points|mhp_book_point_read|SELECT', 'contacts|mhp_book_contact_insert|INSERT',
        'contacts|mhp_book_contact_read|SELECT', 'opportunities|mhp_book_opportunity_insert|INSERT', 'opportunities|mhp_book_opportunity_read|SELECT',
        'opportunity_stage_history|mhp_book_history_insert|INSERT', 'pipeline_stages|mhp_book_stage_read|SELECT', 'pipelines|mhp_book_pipeline_read|SELECT',
        'tasks|mhp_book_task_insert|INSERT'].map(p => { const [t, n, c] = p.split('|'); return `policy|app.${t}|${n}|${c}|r72_mhp_prospect_definer`; }),
      ...['contact_points|INSERT', 'contacts|INSERT', 'contacts|SELECT', 'opportunities|INSERT', 'opportunities|SELECT', 'opportunity_stage_history|INSERT',
        'pipeline_stages|SELECT', 'pipelines|SELECT', 'tasks|INSERT'].map(p => { const [t, c] = p.split('|'); return `table-acl|app.${t}|${c}|r72_owner`; }),
      'trigger|app_private.mhp_prospect_signups|mhp_book_contact_after_signup',
    ].sort());
    assert.ok(before.includes('owned-functions|92'));
    // A real trigger-made lead and repeat, before 0159 (the production lead's shape).
    const signupsBefore = await ownerQuery<{ n: string }>(admin, 'SELECT count(*) AS n FROM app_private.mhp_prospect_signups');
    const w = await world(admin);
    try { await w.growth.capture(bookSignup('trigger-lead@example.com', 'Martin'), null); } finally { await w.close(); }
    const made = await lead(admin, 'trigger-lead@example.com');
    assert.equal(made?.opportunities.length, 1);
    assert.equal(made?.tasks.length, 1);
    const rowsBefore = await rowsDigest(admin);

    // A run of 0159 rolled back half way (here: at its end) leaves the production-shaped state exactly as it was.
    await script(admin, sql159, 'ROLLBACK');
    assert.deepEqual(await listing(admin), prod158);
    const prod159Result = await runMigrations(admin, await prefixDirectory(159));
    assert.deepEqual(prod159Result.applied, [MHP_BOOK_CRM_MIGRATION]);
    const prod159 = await listing(admin);
    assert.deepEqual(prod159, fresh159, 'production-shaped converges to exactly what a fresh database has after 0159');
    assert.deepEqual(await rowsDigest(admin), rowsBefore, 'no CRM, prospect or sign-up row was touched');
    assert.ok(Number((await ownerQuery<{ n: string }>(admin, 'SELECT count(*) AS n FROM app_private.mhp_prospect_signups'))[0]!.n) > Number(signupsBefore[0]!.n));
    await script(admin, sql159);
    assert.deepEqual(await listing(admin), fresh159, 'a retry after success is a no-op');
    assert.equal((await runMigrations(admin, await prefixDirectory(159))).applied.length, 0);
    if (outDir) {
      await writeFile(path.join(outDir, 'prod-0158.txt'), prod158.join('\n') + '\n');
      await writeFile(path.join(outDir, 'prod-0159.txt'), prod159.join('\n') + '\n');
    }
  } finally { await admin.end().catch(() => undefined); }
});

test('order A: the new code with the trigger live, then 0159, then the new code alone', { skip, timeout: 900_000 }, async () => {
  const admin = await openTestDatabase();
  try {
    await resetDisposable();
    await runMigrations(admin, await prefixDirectory(158));
    await script(admin, SEED, 'COMMIT', 'r72_owner');
    await applyQuickFix(admin);
    let w = await world(admin);
    try {
      // The build is ready while 0159 is pending (production-shaped database).
      await assertRuntimeSchemaCurrent(w.web, await prefixDirectory(159), {});
      const sends0 = await sendsDigest(admin);

      // The one real lead in production, made by the trigger before the new code: owner unset on the contact, email
      // point "unknown" and not primary, no phone, no evidence; enquiry and task by the trigger.
      await w.growth.capture(bookSignup('martin-reader@example.com', 'Martin', '07700 900100'), null);
      const trigger = (await lead(admin, 'martin-reader@example.com'))!;
      assert.equal(trigger.source, MHP_BOOK_SOURCE);
      assert.equal(trigger.contactOwner, null);
      assert.deepEqual(trigger.points.map(p => [p.kind, p.consent, p.primary, p.verified]), [['email', 'unknown', false, false]]);
      assert.equal(trigger.opportunities[0]!.name, 'Before You Buy book enquiry · Martin');
      assert.equal(trigger.opportunities[0]!.stage, 'New enquiry');
      assert.equal(trigger.opportunities[0]!.owner, OWNER);
      assert.deepEqual(trigger.tasks.map(t => [t.title, t.status, t.assignee]), [['Follow up Before You Buy book enquiry', 'open', OWNER]]);
      assert.equal('mhpSignup' in trigger.fields, false);
      const triggerTask = trigger.tasks[0]!;

      // The owner moves it on to "Contacted" before the new code arrives.
      const contacted = (await ownerQuery<{ id: string }>(admin, "SELECT id FROM app.pipeline_stages WHERE workspace_id=$1 AND slug='contacted'", [WS]))[0]!.id;
      await w.commands.moveOpportunityStage(w.ownerContext(), { commandKey: `move-${randomUUID()}`, opportunityId: trigger.opportunities[0]!.id,
        targetStageId: contacted, expectedRowVersion: trigger.opportunities[0]!.rowVersion });

      // New code, trigger still live: the owner's first visit fills in what the trigger skipped and nothing else.
      const catchUp = await w.service().catchUp(w.identity);
      assert.deepEqual(catchUp, { processed: 1, failed: 0 });
      const enriched = (await lead(admin, 'martin-reader@example.com'))!;
      assert.deepEqual(enriched.opportunities.map(o => [o.name, o.stage, o.owner]), [['Before You Buy book enquiry · Martin', 'Contacted', OWNER]]);
      assert.deepEqual(enriched.tasks, [triggerTask], 'the task the trigger made is untouched');
      assert.equal(enriched.contactOwner, null, 'the contact owner is not changed');
      // The mobile of a book (waitlist) sign-up is not stored by the capture (0136 keeps it for webinar sign-ups only),
      // so the owner-visit catch-up cannot add it: only the copy made at the moment of the sign-up carries it.
      assert.deepEqual(enriched.points.map(p => [p.kind, p.normalized, p.consent, p.primary, p.verified]),
        [['email', 'martin-reader@example.com', 'opted_in', true, false]]);
      assert.equal((await ownerQuery<{ phone: string | null }>(admin, "SELECT phone FROM app_private.mhp_prospects WHERE email='martin-reader@example.com'"))[0]!.phone, null);
      assert.equal(enriched.fields.mhpProspectId, trigger.fields.mhpProspectId);
      assert.equal((enriched.fields.mhpSignup as Record<string, unknown>).form, MHP_BOOK_INTEREST_LABEL);
      assert.ok(enriched.activities.includes('mhp.book.signup'));
      // A second visit and the button change nothing more.
      assert.deepEqual(await w.service().catchUp(w.identity), { processed: 0, failed: 0 });
      const pressed = await w.service().importBatch(w.identity, randomUUID(), '');
      assert.deepEqual([pressed.added, pressed.completed, pressed.alreadyIn, pressed.failed], [0, 0, 1, false]);
      assert.deepEqual(await lead(admin, 'martin-reader@example.com'), enriched);

      // A new sign-up with the trigger AND the new code live: one enquiry, one task, the trigger's lead enriched.
      const both = await w.signUp(bookSignup('both-live@example.com', 'Bea', '07700 900101'));
      // Code before 0159: the keep-phone function and the owner read are missing; both are skipped softly.
      assert.deepEqual(w.kept, ['missing']);
      assert.equal(await w.growth.listBookSignups(w.identity.sessionToken), null);
      assert.equal(both.outcome?.outcome, 'enriched');
      const bea = (await lead(admin, 'both-live@example.com'))!;
      assert.equal(bea.opportunities.length, 1);
      assert.equal(bea.tasks.length, 1);
      assert.deepEqual(bea.points.map(p => [p.kind, p.consent]), [['email', 'opted_in'], ['phone', 'unknown']]);
      assert.equal((bea.fields.mhpSignup as Record<string, unknown>).consentVersion, MHP_CONSENT_VERSION);
      assert.equal((bea.fields.mhpSignup as Record<string, unknown>).consentGiven, true);
      assert.equal((bea.fields.mhpSignup as Record<string, unknown>).link, 'https://martinhowardproperty.co.uk/book/');
      // Repeat sign-up, trigger live: still one of each.
      assert.equal((await w.signUp(bookSignup('both-live@example.com', 'Bea', '07700 900101'))).outcome?.outcome, 'present');
      const beaAgain = (await lead(admin, 'both-live@example.com'))!;
      assert.equal(beaAgain.opportunities.length, 1);
      assert.equal(beaAgain.tasks.length, 1);
      // Two sign-ups racing for one new person, trigger live.
      const raced = await Promise.all([w.signUp(bookSignup('race-trigger@example.com', 'Rae')), w.signUp(bookSignup('race-trigger@example.com', 'Rae'))]);
      assert.ok(raced.every(r => r.outcome?.outcome === 'enriched' || r.outcome?.outcome === 'present'));
      const rae = (await lead(admin, 'race-trigger@example.com'))!;
      assert.equal(rae.opportunities.length, 1);
      assert.equal(rae.tasks.length, 1);

      // The quick fix's defect, still present until 0159: a CRM fault in the trigger fails the sign-up itself.
      await ownerQuery(admin, "UPDATE app.pipelines SET slug='enquiries-renamed',updated_at=clock_timestamp() WHERE workspace_id=$1", [WS]);
      await assert.rejects(w.growth.capture(bookSignup('lost-by-trigger@example.com', 'Lou'), null));
      assert.equal((await ownerQuery(admin, "SELECT 1 FROM app_private.mhp_prospects WHERE email='lost-by-trigger@example.com'")).length, 0,
        'before 0159 the trigger loses the sign-up');
      await ownerQuery(admin, "UPDATE app.pipelines SET slug='enquiries',updated_at=clock_timestamp() WHERE workspace_id=$1", [WS]);
      assert.equal(await sendsDigest(admin), sends0, 'nothing sent or queued, no consent event recorded');
    } finally { await w.close(); }

    // 0159 by the runner. Every row stays as it is; the build stays ready.
    const rows = await rowsDigest(admin);
    assert.deepEqual((await runMigrations(admin, await prefixDirectory(159))).applied, [MHP_BOOK_CRM_MIGRATION]);
    assert.deepEqual(await rowsDigest(admin), rows);
    w = await world(admin);
    try {
      await assertRuntimeSchemaCurrent(w.web, await prefixDirectory(159), {});
      const sends0 = await sendsDigest(admin);
      const beforeMartin = (await lead(admin, 'martin-reader@example.com'))!;
      // The trigger-made lead after 0159: recognised, never duplicated; a repeat sign-up with the mobile adds it.
      assert.equal((await w.signUp(bookSignup('martin-reader@example.com', 'Martin', '07700 900100'))).outcome?.outcome, 'enriched');
      const afterMartin = (await lead(admin, 'martin-reader@example.com'))!;
      assert.deepEqual(afterMartin.opportunities, beforeMartin.opportunities);
      assert.deepEqual(afterMartin.tasks, beforeMartin.tasks);
      assert.deepEqual(afterMartin.points.map(p => [p.kind, p.normalized, p.consent]), [['email', 'martin-reader@example.com', 'opted_in'], ['phone', '07700900100', 'unknown']]);
      assert.equal((await w.signUp(bookSignup('martin-reader@example.com', 'Martin', '07700 900100'))).outcome?.outcome, 'present');

      // A CRM fault no longer loses anything: the same renamed pipeline, the sign-up is saved, the next catch-up adds it.
      await ownerQuery(admin, "UPDATE app.pipelines SET slug='enquiries-renamed',updated_at=clock_timestamp() WHERE workspace_id=$1", [WS]);
      const kept = await w.growth.capture(bookSignup('kept@example.com', 'Kit', '07700 900102'), null);
      await assert.rejects(w.service().project(OWNER, bookCandidateFromCapture(bookSignup('kept@example.com', 'Kit', '07700 900102'), kept, Date.now())), /New enquiry stage unavailable/);
      assert.equal(await lead(admin, 'kept@example.com'), null);
      assert.equal((await ownerQuery(admin, 'SELECT 1 FROM app_private.mhp_prospect_signups WHERE id=$1', [kept.signupId])).length, 1, 'the sign-up is saved');
      await ownerQuery(admin, "UPDATE app.pipelines SET slug='enquiries',updated_at=clock_timestamp() WHERE workspace_id=$1", [WS]);

      // A fault injected at each step of the projection: nothing half-made, the sign-up saved, the catch-up completes it.
      const steps = ['/* mhp.book-lead-lock */', '/* mhp.book-lead-classify */', '/* mhp.book-new-stage */', '/* crm.claim-command */', '/* crm.find-contact-point */',
        '/* crm.insert-contact */', '/* crm.insert-contact-point */', '/* crm.get-pipeline-stage */', '/* crm.insert-opportunity */', '/* crm.insert-task */',
        '/* crm.insert-activity */', '/* crm.insert-outbox-event */', '/* crm.complete-command */', '/* mhp.book-lead-contact */', '/* mhp.book-lead-evidence */',
        '/* mhp.book-lead-email */', '/* crm.has-primary-contact-point */'];
      for (const [index, step] of steps.entries()) {
        const email = `fault-${index}@example.com`;
        const signup = bookSignup(email, `Fault ${index}`, `07700 9002${String(index).padStart(2, '0')}`);
        const captured = await w.capture(signup);
        w.setFault(step);
        await assert.rejects(w.service().project(OWNER, bookCandidateFromCapture(signup, captured, Date.now())), new RegExp(`injected fault|New enquiry stage unavailable`), step);
        // The automatic path: logged in plain words, never thrown.
        const logs = w.logs.length;
        w.service().afterCapture(signup, captured);
        for (let i = 0; i < 50 && w.logs.length === logs; i++) await new Promise(resolve => setTimeout(resolve, 20));
        assert.match(w.logs.at(-1)!, /^mhp book leads: a book sign-up was saved but its lead was not created in Leads \(XX159\)/, step);
        assert.doesNotMatch(w.logs.at(-1)!, /@|07700/);
        w.setFault(null);
        assert.equal(await lead(admin, email), null, `${step}: nothing half-made`);
        assert.equal((await ownerQuery(admin, 'SELECT 1 FROM app_private.mhp_prospect_signups WHERE id=$1', [captured.signupId])).length, 1, `${step}: sign-up saved`);
      }
      const caught = await w.service().catchUp(w.identity, undefined, { limit: 25, budgetMs: 60_000 });
      assert.equal(caught.failed, 0);
      assert.ok(caught.processed >= steps.length + 1);
      for (const [index] of steps.entries()) {
        const made = (await lead(admin, `fault-${index}@example.com`))!;
        assert.equal(made.opportunities.length, 1);
        assert.equal(made.tasks.length, 1);
        assert.deepEqual(made.points.map(p => p.kind), ['email', 'phone'], 'a CRM outage longer than the retries no longer loses the mobile: it is on the sign-up');
      }
      assert.equal((await lead(admin, 'kept@example.com'))!.opportunities.length, 1);

      // A new lead without a mobile, through the CRM's own command, as the lead owner.
      const ben = await w.signUp(bookSignup('ben@example.com', 'Ben'));
      assert.equal(ben.outcome?.outcome, 'created');
      const benLead = (await lead(admin, 'ben@example.com'))!;
      assert.equal(benLead.source, MHP_BOOK_SOURCE);
      assert.equal(benLead.contactOwner, OWNER);
      assert.deepEqual(benLead.points.map(p => [p.kind, p.consent, p.primary, p.verified]), [['email', 'opted_in', true, false]]);
      assert.deepEqual(benLead.opportunities.map(o => [o.name, o.stage, o.status, o.owner]), [['Before You Buy book enquiry · Ben', 'New enquiry', 'open', OWNER]]);
      assert.equal(benLead.tasks.length, 1);
      const task = benLead.tasks[0]!;
      assert.deepEqual([task.title, task.status, task.assignee], ['Follow up Before You Buy book enquiry', 'open', OWNER]);
      assert.match(task.description!, /^No mobile given\.$/m);
      assert.match(task.description!, /^Marketing emails: yes/m);
      const due = task.dueAt!.getTime(), expected = Date.parse(bookTaskDue(Date.now()));
      assert.ok(Math.abs(due - expected) < 120_000, 'due in one working day');
      assert.ok(!['Sat', 'Sun'].includes(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', weekday: 'short' }).format(task.dueAt!)));
      const evidence = benLead.fields.mhpSignup as Record<string, unknown>;
      assert.deepEqual([evidence.form, evidence.module, evidence.link, evidence.consentGiven, evidence.consentVersion, evidence.signupId, evidence.recordedFrom],
        [MHP_BOOK_INTEREST_LABEL, MHP_BOOK_MODULE, 'https://martinhowardproperty.co.uk/book/', true, MHP_CONSENT_VERSION, ben.captured.signupId, 'sign-up']);
      assert.equal(benLead.fields.mhpProspectId, ben.captured.prospectId);
      assert.deepEqual(benLead.activities.sort(), ['crm.lead.created', 'mhp.book.signup']);

      // A repeat sign-up that adds a mobile adds the phone point and nothing else.
      const benAgain = await w.signUp(bookSignup('ben@example.com', 'Ben', '+44 7700 900103'));
      assert.equal(benAgain.outcome?.outcome, 'enriched');
      const benPhone = (await lead(admin, 'ben@example.com'))!;
      assert.deepEqual(benPhone.points.map(p => [p.kind, p.normalized, p.verified]), [['email', 'ben@example.com', false], ['phone', '+447700900103', false]]);
      assert.deepEqual(benPhone.opportunities, benLead.opportunities);
      assert.deepEqual(benPhone.tasks, benLead.tasks);

      // A repeat sign-up after the enquiry was closed and its task done never resets or re-opens anything.
      const completed = (await ownerQuery<{ id: string }>(admin, "SELECT id FROM app.pipeline_stages WHERE workspace_id=$1 AND slug='completed'", [WS]))[0]!.id;
      await w.commands.moveOpportunityStage(w.ownerContext(), { commandKey: `close-${randomUUID()}`, opportunityId: benPhone.opportunities[0]!.id,
        targetStageId: completed, expectedRowVersion: benPhone.opportunities[0]!.rowVersion });
      const benTask = (await ownerQuery<{ id: string; v: number }>(admin, 'SELECT id,row_version AS v FROM app.tasks WHERE workspace_id=$1 AND opportunity_id=$2', [WS, benPhone.opportunities[0]!.id]))[0]!;
      await w.commands.completeTask(w.ownerContext(), { commandKey: `done-${randomUUID()}`, taskId: benTask.id, expectedRowVersion: Number(benTask.v) });
      const closed = (await lead(admin, 'ben@example.com'))!;
      assert.deepEqual(closed.opportunities.map(o => [o.stage, o.status]), [['Completed', 'won']]);
      assert.equal((await w.signUp(bookSignup('ben@example.com', 'Ben', '+44 7700 900103'))).outcome?.outcome, 'present');
      assert.equal((await w.signUp(bookSignup('ben@example.com', 'Benjamin', '07700 900104'))).outcome?.outcome, 'enriched');
      const reopened = (await lead(admin, 'ben@example.com'))!;
      assert.deepEqual(reopened.opportunities, closed.opportunities, 'still closed, same stage, same owner');
      assert.deepEqual(reopened.tasks, closed.tasks, 'no new task; the done task stays done');
      assert.equal(reopened.points.filter(p => p.kind === 'phone').length, 2, 'a new mobile is added as another unverified number');

      // Two sign-ups racing for one new person.
      const race = await Promise.all([w.signUp(bookSignup('race@example.com', 'Ray', '07700 900105')), w.signUp(bookSignup('race@example.com', 'Ray', '07700 900105'))]);
      assert.deepEqual(race.map(r => r.outcome?.outcome).sort(), ['created', 'present']);
      const ray = (await lead(admin, 'race@example.com'))!;
      assert.equal(ray.opportunities.length, 1);
      assert.equal(ray.tasks.length, 1);
      assert.equal(ray.points.length, 2);

      // An existing contact with the same email (made by the owner, opted out): reused; its opt-out and name are kept.
      const ids = (await ownerQuery<{ pipelineId: string; stageId: string }>(admin, `SELECT p.id AS "pipelineId",s.id AS "stageId" FROM app.pipelines p
        JOIN app.pipeline_stages s ON s.workspace_id=p.workspace_id AND s.pipeline_id=p.id WHERE p.workspace_id=$1 AND p.slug='enquiries' AND s.slug='contacted'`, [WS]))[0]!;
      const existing = await w.commands.createLead(w.ownerContext(), { commandKey: `owner-${randomUUID()}`, displayName: 'Dana Existing', ownerUserId: OWNER,
        source: 'owner:manual', contactPoints: [{ kind: 'email', value: 'dana@example.com', isPrimary: true, consentStatus: 'opted_out' }],
        pipelineId: ids.pipelineId, stageId: ids.stageId, opportunityName: 'Deal room enquiry · Dana' });
      const dana = await w.signUp(bookSignup('dana@example.com', 'Dana'));
      assert.equal(dana.outcome?.outcome, 'created');
      const danaLead = (await lead(admin, 'dana@example.com'))!;
      assert.deepEqual(danaLead.opportunities.map(o => o.name), ['Deal room enquiry · Dana', 'Before You Buy book enquiry · Dana']);
      assert.equal(danaLead.tasks.length, 1);
      assert.deepEqual(danaLead.points.map(p => [p.kind, p.consent]), [['email', 'opted_out']], 'an opt-out recorded in the CRM is never overridden');
      assert.equal(danaLead.source, 'owner:manual');
      assert.equal((await ownerQuery<{ n: string }>(admin, 'SELECT display_name AS n FROM app.contacts WHERE id=$1', [existing.contactId]))[0]!.n, 'Dana Existing');

      // An ambiguous email (a second, shared record holds it): skipped and reported, nothing created.
      await ownerQuery(admin, `DO $d$ DECLARE a uuid:=gen_random_uuid(); b uuid:=gen_random_uuid(); BEGIN
        PERFORM set_config('app.request_id','book-ambiguous',true);
        INSERT INTO app.contacts(id,workspace_id,display_name) VALUES(a,'${WS}','Shared one'),(b,'${WS}','Shared two');
        INSERT INTO app.contact_points(workspace_id,contact_id,kind,value,normalized_value) VALUES('${WS}',a,'email','shared@example.com','shared@example.com');
        INSERT INTO app.contact_points(workspace_id,contact_id,kind,value,normalized_value,dedupe_state) VALUES('${WS}',b,'email','shared@example.com','shared@example.com','shared');
      END $d$`);
      const ambiguous = await w.signUp(bookSignup('shared@example.com', 'Sam'));
      assert.deepEqual(ambiguous.outcome, { outcome: 'skipped', reason: 'several_contacts' });
      assert.equal((await ownerQuery(admin, "SELECT 1 FROM app.opportunities WHERE workspace_id=$1 AND name LIKE 'Before You Buy book enquiry · Sam'", [WS])).length, 0);
      // A test address: skipped.
      assert.deepEqual((await w.signUp(bookSignup('reader@example.invalid', 'Test'))).outcome, { outcome: 'skipped', reason: 'test_address' });
      assert.equal(await lead(admin, 'reader@example.invalid'), null);

      // A webinar sign-up at the same time as a book sign-up: the webinar path is exactly as before.
      const before = w.transactions();
      const [webinar, bookAtSameTime] = await Promise.all([w.signUp(webinarSignup('viewer@example.com')), w.signUp(bookSignup('same-time@example.com', 'Sid'))]);
      assert.equal(webinar.outcome, null);
      // (The configured webinar date is in the past for this run, so its schedule is empty; the count is whatever the
      // unchanged capture queued, checked against the sends table below.)
      assert.equal(webinar.captured.campaign, mhpWebinarConfig({}).campaign);
      w.service().afterCapture(webinarSignup('viewer@example.com'), webinar.captured);
      assert.equal(await lead(admin, 'viewer@example.com'), null, 'no CRM record for a webinar sign-up');
      assert.equal(bookAtSameTime.outcome?.outcome, 'created');
      assert.ok(w.transactions() > before);
      const webinarSends = await ownerQuery<{ n: string }>(admin, 'SELECT count(*) AS n FROM app_private.mhp_marketing_sends WHERE prospect_id=$1', [webinar.captured.prospectId]);
      assert.equal(Number(webinarSends[0]!.n), webinar.captured.queued);

      // The owner's screen: who is in Leads, with the plain count.
      const registrants = (await w.growth.listRegistrants(w.identity.sessionToken)).filter(r => r.signups.includes(MHP_BOOK_INTEREST_LABEL));
      const statuses = await w.service().statuses(w.identity, registrants);
      assert.equal(statuses.available, true);
      assert.equal(statuses.total, registrants.length);
      const needs = [...statuses.byProspect.values()].filter(s => s.state === 'needs_you').map(s => s.state === 'needs_you' ? s.reason : '').sort();
      assert.deepEqual(needs, ['several_contacts', 'test_address']);
      assert.equal(statuses.inLeads, registrants.length - 2);

      // No lead owner configured: the button acts as the workspace owner resolved now (never a stored id).
      const resolved = w.service(null);
      assert.equal(resolved.automatic, false);
      const pressed = await resolved.importBatch(w.identity, randomUUID(), '');
      assert.equal(pressed.failed, false);
      assert.equal(pressed.added, 0);
      assert.equal(resolved.automatic, false, 'no silent arming: without a configured owner, sign-ups wait for the press');
      assert.equal(resolved.mode, 'no_owner');
      assert.equal(await readMhpWorkspaceOwner(w.web, w.identity), OWNER);

      assert.equal(await sendsDigest(admin), String(sends0).replace(/^\d+/, n => String(Number(n) + webinar.captured.queued)),
        'nothing sent or queued by the book path, no consent event; only the webinar capture queued its own emails');
    } finally { await w.close(); }
  } finally { await admin.end().catch(() => undefined); }
});

test('order B: fresh to 0159 first, then the new code', { skip, timeout: 900_000 }, async () => {
  const admin = await openTestDatabase();
  try {
    await resetDisposable();
    await runMigrations(admin, await prefixDirectory(158));
    await script(admin, SEED, 'COMMIT', 'r72_owner');
    assert.deepEqual((await runMigrations(admin, await prefixDirectory(159))).applied, [MHP_BOOK_CRM_MIGRATION]);
    const w = await world(admin);
    try {
      await assertRuntimeSchemaCurrent(w.web, await prefixDirectory(159), {});
      const zoe = await w.signUp(bookSignup('zoe@example.com', null, '07700 900106'));
      assert.equal(zoe.outcome?.outcome, 'created');
      const made = (await lead(admin, 'zoe@example.com'))!;
      assert.deepEqual(made.opportunities.map(o => [o.name, o.stage]), [['Before You Buy book enquiry · zoe@example.com', 'New enquiry']]);
      assert.match(made.tasks[0]!.description!, /^Mobile: 07700 900106 \(they asked for a call\)\./m);
      assert.deepEqual(made.points.map(p => [p.kind, p.verified]), [['email', false], ['phone', false]]);
      assert.equal((await w.signUp(bookSignup('zoe@example.com', null, '07700 900106'))).outcome?.outcome, 'present');
      assert.equal((await lead(admin, 'zoe@example.com'))!.opportunities.length, 1);
      assert.equal((await lead(admin, 'zoe@example.com'))!.points.find(p => p.kind === 'phone')!.consent, 'unknown', "today's form: the mobile is for the book only, said in the task, never as an opt-out");

      // The book form's named wordings: texts/WhatsApp offers recorded only with the +messages tick.
      const versioned = (email: string, version: string, phone: string | null) => ({ ...bookSignup(email, 'Vee', phone), consentVersion: version });
      const phoneOf = async (email: string) => (await lead(admin, email))!.points.find(p => p.kind === 'phone')?.consent;
      await w.signUp(versioned('msg@example.com', 'book-2026-11+messages', '07700 900201'));
      assert.equal(await phoneOf('msg@example.com'), 'opted_in');
      assert.match((await lead(admin, 'msg@example.com'))!.tasks[0]!.description!, /^Texts and WhatsApp offers: yes/m);
      const stored = await ownerQuery<{ v: string }>(admin, "SELECT s.consent_version AS v FROM app_private.mhp_prospect_signups s JOIN app_private.mhp_prospects p ON p.id=s.prospect_id WHERE p.email='msg@example.com'");
      assert.deepEqual(stored.map(r => r.v), ['book-2026-11+messages'], 'the wording agreed is the stored evidence');
      // No tick, then a later sign-up with the tick: upgraded (it was this projection's own "about the book only").
      await w.signUp(versioned('up@example.com', 'book-2026-11', '07700 900202'));
      assert.equal(await phoneOf('up@example.com'), 'unknown');
      assert.match((await lead(admin, 'up@example.com'))!.tasks[0]!.description!, /^Texts and WhatsApp: about the book only\.$/m);
      assert.equal((await w.signUp(versioned('up@example.com', 'book-2026-11+messages', '07700 900202'))).outcome?.outcome, 'enriched');
      assert.equal(await phoneOf('up@example.com'), 'opted_in');
      const upEvidence = await ownerQuery<{ v: string }>(admin, "SELECT s.consent_version AS v FROM app_private.mhp_prospect_signups s JOIN app_private.mhp_prospects p ON p.id=s.prospect_id WHERE p.email='up@example.com' ORDER BY s.created_at");
      assert.deepEqual(upEvidence.map(r => r.v), ['book-2026-11', 'book-2026-11+messages'], 'one sign-up row per wording, as today');
      // A tick never undoes a recorded STOP / suppression.
      await w.signUp(versioned('stop@example.com', 'book-2026-11', '07700 900203'));
      const stopPoint = (await ownerQuery<{ id: string; contact: string }>(admin, "SELECT id,contact_id AS contact FROM app.contact_points WHERE workspace_id=$1 AND kind='phone' AND normalized_value='07700900203'", [WS]))[0]!;
      await ownerQuery(admin, `INSERT INTO app.communication_suppression_events(workspace_id,contact_id,contact_point_id,channel,state,reason,source,actor_kind,endpoint_identity_sha256,occurred_at)
        VALUES($1,$2,$3,'sms','suppressed','stop_keyword','sms.inbound','webhook',public.digest('x','sha256'),now())`, [WS, stopPoint.contact, stopPoint.id]);
      await w.signUp(versioned('stop@example.com', 'book-2026-11+messages', '07700 900203'));
      assert.equal(await phoneOf('stop@example.com'), 'unknown', 'a STOP always wins: never upgraded');
      // Not ticking again is not a withdrawal: an opted-in mobile stays opted in.
      await w.signUp(versioned('msg@example.com', 'book-2026-11', '07700 900201'));
      assert.equal(await phoneOf('msg@example.com'), 'opted_in');
      // The owner's column follows the latest sign-up's version.
      const registrants = (await w.growth.listRegistrants(w.identity.sessionToken)).filter(r => r.signups.includes(MHP_BOOK_INTEREST_LABEL));
      const statuses = await w.service().statuses(w.identity, registrants);
      const messagesOf = (email: string) => { const st = statuses.byProspect.get(registrants.find(r => r.email === email)!.id); return st?.state === 'in_leads' ? st.messages : 'missing'; };
      assert.deepEqual(['up@example.com', 'msg@example.com', 'zoe@example.com'].map(messagesOf), [true, false, false]);
    } finally { await w.close(); }
  } finally { await admin.end().catch(() => undefined); }
});


/** The owner WhatsApp gate's answer for a number (0151), called as its owner. */
async function waBlocked(admin: Admin, number: string): Promise<string | null> {
  const owner = (await admin.query<{ o: string }>("SELECT pg_get_userbyid(proowner) AS o FROM pg_proc WHERE oid='app_private.mhp_wa_owner_number_blocked(text)'::regprocedure")).rows[0]!.o;
  const client = await admin.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL ROLE ${owner}`);
    const value = (await client.query<{ v: string | null }>('SELECT app_private.mhp_wa_owner_number_blocked($1) AS v', [number])).rows[0]!.v;
    await client.query('ROLLBACK');
    return value;
  } finally { client.release(); }
}

test('fix round after 0159: WhatsApp gate unchanged, race losers enrich, durable mobile through restart/outage/no owner, webinar numbers never used', { skip, timeout: 900_000 }, async () => {
  const admin = await openTestDatabase();
  try {
    await resetDisposable();
    await runMigrations(admin, await prefixDirectory(158));
    await script(admin, SEED, 'COMMIT', 'r72_owner');
    // A pl/pgsql function holding a %ROWTYPE of the sign-ups table, compiled on a long-lived connection before 0159,
    // keeps working on that connection after 0159 adds the column (the event-phone and sequence functions do this).
    await script(admin, `CREATE FUNCTION app_private.book_crm_rowtype_probe() RETURNS integer LANGUAGE plpgsql AS $f$
      DECLARE s app_private.mhp_prospect_signups%ROWTYPE; n integer := 0;
      BEGIN FOR s IN SELECT * FROM app_private.mhp_prospect_signups LOOP n := n + 1; END LOOP; RETURN n; END $f$`, 'COMMIT', 'r72_owner');
    const held = await admin.connect();
    try {
      await held.query('SET ROLE r72_owner');
      await held.query('SELECT app_private.book_crm_rowtype_probe()');
      assert.deepEqual((await runMigrations(admin, await prefixDirectory(159))).applied, [MHP_BOOK_CRM_MIGRATION]);
      await ownerQuery(admin, `INSERT INTO app_private.mhp_prospects(email) VALUES('rowtype@example.com')`);
      await ownerQuery(admin, `INSERT INTO app_private.mhp_prospect_signups(prospect_id,kind,label,consent_given,consent_version)
        SELECT id,'sheet','Probe',true,'site-2026-10' FROM app_private.mhp_prospects WHERE email='rowtype@example.com'`);
      assert.equal((await held.query<{ n: number }>('SELECT app_private.book_crm_rowtype_probe() AS n')).rows[0]!.n, 1);
    } finally { await held.query('RESET ROLE').catch(() => undefined); held.release(); }
    await script(admin, 'DROP FUNCTION app_private.book_crm_rowtype_probe()', 'COMMIT', 'r72_owner');

    const w = await world(admin);
    try {
      const sends0 = await sendsDigest(admin);
      // M1: the owner WhatsApp gate answers the same before and after any book sign-up, with or without the tick, and
      // for a number another contact already holds (written another way).
      const holder = await w.commands.createLead(w.ownerContext(), { commandKey: `wa-${randomUUID()}`, displayName: 'WhatsApp person', ownerUserId: OWNER,
        source: 'owner:manual', contactPoints: [{ kind: 'email', value: 'wa-person@example.com' }, { kind: 'whatsapp', value: '+447700900555' }, { kind: 'phone', value: '+447700900555' }],
        pipelineId: (await ownerQuery<{ id: string }>(admin, "SELECT id FROM app.pipelines WHERE workspace_id=$1 AND slug='enquiries'", [WS]))[0]!.id,
        stageId: (await ownerQuery<{ id: string }>(admin, "SELECT id FROM app.pipeline_stages WHERE workspace_id=$1 AND slug='new'", [WS]))[0]!.id });
      const numbers = ['447700900123', '447700900124', '447700900555'];
      const before = await Promise.all(numbers.map(n => waBlocked(admin, n)));
      await w.signUp(bookSignup('m1-none@example.com', 'Nia', '07700 900123'));
      await w.signUp({ ...bookSignup('m1-tick@example.com', 'Tia', '07700 900124'), consentVersion: 'book-2026-11+messages' });
      await w.signUp(bookSignup('m1-stranger@example.com', 'Stan', '07700 900555'));
      await w.signUp({ ...bookSignup('m1-stranger2@example.com', 'Stan', '+44 7700 900555'), consentVersion: 'book-2026-11' });
      assert.deepEqual(await Promise.all(numbers.map(n => waBlocked(admin, n))), before, 'no book sign-up changes the WhatsApp gate');
      assert.equal((await ownerQuery(admin, "SELECT 1 FROM app.contact_points WHERE workspace_id=$1 AND kind='phone' AND consent_status='opted_out'", [WS])).length, 0,
        'the projection never writes opted_out on a phone point');
      const stranger = (await lead(admin, 'm1-stranger@example.com'))!;
      assert.deepEqual(stranger.points.map(p => p.kind), ['email'], "someone else's number (07… or +44…) is never attached");
      const holderPoints = await ownerQuery<{ contact: string; consent: string }>(admin, "SELECT contact_id AS contact, consent_status AS consent FROM app.contact_points WHERE workspace_id=$1 AND normalized_value='+447700900555'", [WS]);
      assert.ok(holderPoints.every(p => p.contact === holder.contactId && p.consent === 'unknown'), "the other contact's points are untouched");
      assert.equal((await lead(admin, 'm1-tick@example.com'))!.points.find(p => p.kind === 'phone')!.consent, 'opted_in');
      assert.match((await lead(admin, 'm1-none@example.com'))!.tasks[0]!.description!, /^Texts and WhatsApp: about the book only\.$/m);

      // S1: three sign-ups per person racing (two different mobiles and one without), plus the catch-up and the button:
      // everyone ends with every mobile they typed.
      const people = Array.from({ length: 8 }, (_, i) => `race-${i}@example.com`);
      const service = w.service(), other = w.service();
      const one = async (email: string, phone: string | null, books: MhpBookLeadService) => {
        const signup = bookSignup(email, 'Race', phone);
        const captured = await w.capture(signup);
        await books.project(OWNER, bookCandidateFromCapture(signup, captured, Date.now()));
      };
      await Promise.all([...people.flatMap((email, i) => [one(email, `07700 9011${String(i).padStart(2, '0')}`, service), one(email, null, other),
        one(email, `07700 9012${String(i).padStart(2, '0')}`, service)]), other.catchUp(w.identity, undefined, { limit: 25, budgetMs: 60_000 }),
        service.importBatch(w.identity, randomUUID(), '')]);
      for (const [i, email] of people.entries()) {
        const made = (await lead(admin, email))!;
        assert.equal(made.opportunities.length, 1, email);
        assert.equal(made.tasks.length, 1, email);
        const pad = String(i).padStart(2, '0');
        assert.deepEqual(made.points.filter(p => p.kind === 'phone').map(p => p.normalized).sort(), [`077009011${pad}`, `077009012${pad}`], email);
      }

      // A restart between the capture and the copy: the mobile is on the sign-up; the next catch-up makes the lead with
      // it and with the exact consent evidence.
      const restart = await w.capture({ ...bookSignup('restart@example.com', 'Rhea', '07700 900130'), consentVersion: 'book-2026-11+messages' });
      assert.equal(w.kept.at(-1), 'kept');
      assert.equal(await lead(admin, 'restart@example.com'), null);
      await w.service().catchUp(w.identity, undefined, { budgetMs: 60_000 });
      const rhea = (await lead(admin, 'restart@example.com'))!;
      assert.deepEqual(rhea.points.map(p => [p.kind, p.normalized, p.consent]), [['email', 'restart@example.com', 'opted_in'], ['phone', '07700900130', 'opted_in']]);
      const evidence = rhea.fields.mhpSignup as Record<string, unknown>;
      assert.deepEqual([evidence.signupId, evidence.consentGiven, evidence.consentVersion, evidence.recordedFrom],
        [restart.signupId, true, 'book-2026-11+messages', 'sign-up-record'], 'exact evidence, not nulls');
      assert.match(rhea.tasks[0]!.description!, /^Mobile: 07700 900130 \(they asked for a call\)/m);

      // A CRM outage longer than the retries: the copy fails, the mobile is kept, the catch-up later adds it.
      const outage = bookSignup('outage@example.com', 'Otto', '07700 900131');
      const kept = await w.capture(outage);
      w.setFault('/* crm.insert-contact */');
      await assert.rejects(w.service().project(OWNER, bookCandidateFromCapture(outage, kept, Date.now())));
      w.setFault(null);
      await w.service().catchUp(w.identity, undefined, { budgetMs: 60_000 });
      assert.deepEqual((await lead(admin, 'outage@example.com'))!.points.map(p => p.kind), ['email', 'phone']);

      // No configured owner: nothing is copied silently, the page says how many wait, one press brings them in with mobiles.
      const unowned = w.service(null);
      const nobody = bookSignup('no-owner@example.com', 'Noor', '07700 900132');
      const nobodyCaptured = await w.capture(nobody);
      unowned.afterCapture(nobody, nobodyCaptured);
      assert.deepEqual(await unowned.catchUp(w.identity), { processed: 0, failed: 0 });
      assert.equal(await lead(admin, 'no-owner@example.com'), null);
      const registrants = (await w.growth.listRegistrants(w.identity.sessionToken)).filter(r => r.signups.includes(MHP_BOOK_INTEREST_LABEL));
      const waiting = await unowned.statuses(w.identity, registrants);
      assert.equal(waiting.mode, 'no_owner');
      assert.equal(waiting.waiting, 1);
      assert.equal(waiting.book?.get(nobodyCaptured.prospectId)?.mobile, '07700 900132', 'the page shows the mobile before the person is in Leads');
      assert.ok(w.logs.some(l => /wait for "Bring book sign-ups into Leads", because no MHP lead owner is configured/.test(l)));
      let pressed = await unowned.importBatch(w.identity, randomUUID(), '');
      while (pressed.hasMore) pressed = await unowned.importBatch(w.identity, randomUUID(), pressed.cursor!);
      assert.deepEqual((await lead(admin, 'no-owner@example.com'))!.points.map(p => p.kind), ['email', 'phone']);

      // S3: a webinar-given number is never a book mobile; the task says "No mobile given".
      await w.growth.capture(webinarSignup('both-kinds@example.com'), null);
      assert.equal((await ownerQuery<{ p: string }>(admin, "SELECT phone AS p FROM app_private.mhp_prospects WHERE email='both-kinds@example.com'"))[0]!.p, '07700 900777');
      await w.capture(bookSignup('both-kinds@example.com', 'Viewer'));
      await w.service().catchUp(w.identity, undefined, { budgetMs: 60_000 });
      const both = (await lead(admin, 'both-kinds@example.com'))!;
      assert.deepEqual(both.points.map(p => p.kind), ['email']);
      assert.match(both.tasks[0]!.description!, /^No mobile given\.$/m);
      // Non-book sign-ups never have the new column set.
      assert.equal((await ownerQuery(admin, "SELECT 1 FROM app_private.mhp_prospect_signups WHERE phone IS NOT NULL AND NOT (kind='waitlist' AND module='book-before-you-buy')")).length, 0);

      // S6: an unsubscribe reaches Leads at the next visit; ticking again lifts our own opt-out.
      const sub = await w.signUp(bookSignup('sub@example.com', 'Sue'));
      await w.growth.unsubscribe(sub.captured.prospectId);
      await w.service().catchUp(w.identity, undefined, { budgetMs: 60_000 });
      assert.equal((await lead(admin, 'sub@example.com'))!.points[0]!.consent, 'opted_out');
      await w.signUp(bookSignup('sub@example.com', 'Sue'));
      assert.equal((await lead(admin, 'sub@example.com'))!.points[0]!.consent, 'opted_in');

      // The keep-phone function writes only a fresh, phone-less book sign-up of that prospect; logins are fenced.
      const fresh = await w.growth.capture(bookSignup('fence@example.com', 'Fen'), null);
      assert.equal(await w.growth.keepBookPhone({ ...fresh, prospectId: randomUUID() }, '07700 900140'), 'not_kept');
      assert.equal(await w.growth.keepBookPhone(fresh, 'not a number'), 'not_kept');
      assert.equal(await w.growth.keepBookPhone(fresh, '07700 900140'), 'kept');
      assert.equal(await w.growth.keepBookPhone(fresh, '07700 900141'), 'not_kept', 'never overwritten');
      const webinar = await w.growth.capture(webinarSignup('fence-web@example.com'), null);
      assert.equal(await w.growth.keepBookPhone(webinar, '07700 900142'), 'not_kept');
      const old = await w.growth.capture(bookSignup('fence-old@example.com', 'Ola'), null);
      await ownerQuery(admin, "UPDATE app_private.mhp_prospect_signups SET created_at=created_at-interval '11 minutes' WHERE id=$1", [old.signupId]);
      assert.equal(await w.growth.keepBookPhone(old, '07700 900144'), 'not_kept', 'only within 10 minutes of the sign-up');
      await assert.rejects(w.web.query("SELECT app_private.mhp_book_signup_keep_phone(gen_random_uuid(),gen_random_uuid(),'07700 900143')"), /permission denied/);
      const id = await login(admin, 'r72_identity_command', 1);
      try { await assert.rejects(id.query("SELECT app_private.mhp_book_signups(decode(repeat('00',32),'hex'))"), /permission denied/); } finally { await id.end(); }

      // Nothing sent or queued by the book path: only the two webinar captures may queue their own emails (none here,
      // the configured webinar date has passed); messages, deliveries, provider operations and both ledgers unchanged.
      const tail = (d: string) => d.split(',').slice(1).join(',');
      assert.equal(tail(await sendsDigest(admin)), tail(sends0));
    } finally { await w.close(); }
  } finally { await admin.end().catch(() => undefined); }
});

test('last round: a stuck person is skipped and never blocks the button; keep-phone is cut at 2 s; the first mobile after 0159 is kept; other-format tick upgrades', { skip, timeout: 900_000 }, async () => {
  const admin = await openTestDatabase();
  try {
    await resetDisposable();
    await runMigrations(admin, await prefixDirectory(158));
    await script(admin, SEED, 'COMMIT', 'r72_owner');
    // SF2: a process that learnt "function missing" before 0159 keeps the first mobile after it, without a restart.
    let w = await world(admin);
    try {
      const before = bookSignup('pre-0159@example.com', 'Pia', '07700 900301');
      const c0 = await w.growth.capture(before, null);
      assert.equal(await w.growth.keepBookPhone(c0, '07700 900301'), 'missing');
      assert.deepEqual((await runMigrations(admin, await prefixDirectory(159))).applied, [MHP_BOOK_CRM_MIGRATION]);
      await new Promise(resolve => setTimeout(resolve, 5_200));
      const after = await w.growth.capture(bookSignup('post-0159@example.com', 'Pol', '07700 900302'), null);
      assert.equal(await w.growth.keepBookPhone(after, '07700 900302'), 'kept');
      assert.equal((await ownerQuery<{ p: string }>(admin, 'SELECT phone AS p FROM app_private.mhp_prospect_signups WHERE id=$1', [after.signupId]))[0]!.p, '07700 900302');
      assert.notEqual(await w.growth.listBookSignups(w.identity.sessionToken), null, 'the owner read works again too');
    } finally { await w.close(); }
    w = await world(admin);
    try {
      // SF3: the new row locked by another session: keep-phone gives up at about 2 s; the sign-up is saved.
      const slow = await w.growth.capture(bookSignup('locked@example.com', 'Lok', '07700 900303'), null);
      const locker = await admin.connect();
      try {
        await locker.query('BEGIN');
        await locker.query('SET LOCAL ROLE r72_owner');
        await locker.query('SELECT 1 FROM app_private.mhp_prospect_signups WHERE id=$1 FOR UPDATE', [slow.signupId]);
        const started = Date.now();
        await assert.rejects(w.growth.keepBookPhone(slow, '07700 900303'), (e: { code?: string }) => e.code === 'timeout');
        const took = Date.now() - started;
        assert.ok(took >= 1_900 && took < 3_000, `cut at about 2 s (${took} ms)`);
        await locker.query('ROLLBACK');
      } finally { locker.release(); }
      assert.equal((await ownerQuery(admin, 'SELECT 1 FROM app_private.mhp_prospect_signups WHERE id=$1', [slow.signupId])).length, 1, 'sign-up saved');

      // SF1: a lead made, then its email moved onto another record with no book enquiry.
      const people = ['x1@example.com', 'x2@example.com', 'x3@example.com'];
      const ids: Record<string, string> = {};
      for (const [i, email] of people.entries()) ids[email] = (await w.capture(bookSignup(email, 'P', `07700 90040${i}`))).prospectId;
      const order = [...people].sort((a, b) => (ids[a]! < ids[b]! ? -1 : 1));
      const middle = order[1]!;
      const signup = bookSignup(middle, 'P');
      assert.equal((await w.service().project(OWNER, bookCandidateFromCapture(signup, { prospectId: ids[middle]!, signupId: randomUUID() }, Date.now()))).outcome, 'created');
      const moved = randomUUID();
      await ownerQuery(admin, `DO $d$ BEGIN PERFORM set_config('app.request_id','move',true);
        INSERT INTO app.contacts(id,workspace_id,display_name,source) VALUES('${moved}','${WS}','Moved by owner','owner:manual');
        UPDATE app.contact_points SET contact_id='${moved}' WHERE workspace_id='${WS}' AND kind='email' AND normalized_value='${middle}'; END $d$`);
      const stuck = await w.service().project(OWNER, bookCandidateFromCapture(signup, { prospectId: ids[middle]!, signupId: randomUUID() }, Date.now()));
      assert.deepEqual(stuck, { outcome: 'skipped', reason: 'lead_moved' }, 'no throw, a plain reason');
      // In every mode the button brings in the people after the stuck one, and presses do not loop on them.
      for (const owner of [OWNER, null]) {
        const books = w.service(owner);
        let press = await books.importBatch(w.identity, randomUUID(), ''), presses = 1;
        while (press.hasMore && presses < 5) { press = await books.importBatch(w.identity, randomUUID(), press.cursor!); presses++; }
        assert.equal(press.failed, false);
        assert.ok(press.needYou >= 1 || presses > 1);
      }
      for (const email of order.filter(e => e !== middle)) assert.equal((await lead(admin, email))!.opportunities.length, 1, email);
      const registrants = (await w.growth.listRegistrants(w.identity.sessionToken)).filter(r => r.signups.includes(MHP_BOOK_INTEREST_LABEL));
      const statuses = await w.service().statuses(w.identity, registrants);
      assert.deepEqual(statuses.byProspect.get(ids[middle]!), { state: 'needs_you', reason: 'lead_moved' }, 'listed under Needs you');
      // A refused owner: later sign-ups are not stuck behind them either (the button acts as the workspace owner).
      // (a configured owner who is not a member of the workspace: the real CRM runner refuses with forbidden_scope)
      const refused = w.service(randomUUID());
      assert.equal(await refused.probe(), 'owner_cannot_manage');
      await w.capture(bookSignup('x4@example.com', 'P', '07700 900404'));
      let press = await refused.importBatch(w.identity, randomUUID(), '');
      while (press.hasMore) press = await refused.importBatch(w.identity, randomUUID(), press.cursor!);
      assert.equal(press.failed, false);
      assert.equal((await lead(admin, 'x4@example.com'))!.opportunities.length, 1);

      // A tick typed in the other UK format upgrades the person's own book-only number.
      await w.signUp(bookSignup('format@example.com', 'Fay', '07700 900405'));
      assert.equal((await lead(admin, 'format@example.com'))!.points.find(p => p.kind === 'phone')!.consent, 'unknown');
      await w.signUp({ ...bookSignup('format@example.com', 'Fay', '+44 (0)7700 900405'), consentVersion: 'book-2026-11+messages' });
      const fay = (await lead(admin, 'format@example.com'))!;
      assert.deepEqual(fay.points.filter(p => p.kind === 'phone').map(p => [p.normalized, p.consent]), [['07700900405', 'opted_in']]);
    } finally { await w.close(); }
  } finally { await admin.end().catch(() => undefined); }
});
