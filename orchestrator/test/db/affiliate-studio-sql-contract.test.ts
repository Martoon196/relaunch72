/**
 * Migration 0158 (Affiliate Studio, slice 1, data layer) read as source: purely additive, every function a checked
 * definer that asks the owner rule first, append-only forced-RLS tables, and nothing existing changed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { AFFILIATE_CHECKSUM, AFFILIATE_MIGRATION } from '../../src/db/affiliate-schema.js';
import { discoverMigrations } from '../../src/db/migrate.js';

const url = new URL(`../../src/db/migrations/${AFFILIATE_MIGRATION}`, import.meta.url);
const normalise = (sql: string) => sql.replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ').trim();
const TABLES = ['affiliate_products', 'affiliate_product_commands', 'affiliate_programme_settings', 'affiliate_report_imports'];
const COMMANDS = ['affiliate_product_command', 'affiliate_programme_command', 'affiliate_report_command'];
const HELPERS = ['affiliate_owner', 'affiliate_uuid', 'affiliate_product_json', 'affiliate_settings_json'];

test('0158 is the pinned, ASCII-only, LF-only file the runner hashes', async () => {
  const raw = await readFile(url);
  assert.ok([...raw].every(b => b < 0x80), 'ASCII only');
  assert.ok(!raw.includes(0x0d), 'LF line endings only');
  assert.equal(createHash('sha256').update(raw).digest('hex'), AFFILIATE_CHECKSUM);
  const discovered = (await discoverMigrations()).find(m => m.version === 158);
  assert.deepEqual([discovered?.filename, discovered?.checksum], [AFFILIATE_MIGRATION, AFFILIATE_CHECKSUM]);
});

test('0158 is purely additive: no existing table altered, locked, referenced, triggered or policed; nothing replaced or dropped', async () => {
  const sql = normalise(await readFile(url, 'utf8'));
  assert.match(sql, /^SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='60s';/u);
  assert.doesNotMatch(sql, /\bLOCK TABLE\b|\bTRUNCATE app|\bDROP\b|CREATE OR REPLACE|ALTER POLICY|ALTER FUNCTION|ALTER ROLE|ALTER DEFAULT|ALTER SCHEMA|BEGIN;|COMMIT|VALIDATE CONSTRAINT/u);
  // ALTER TABLE only inside the loop over the four new tables.
  assert.deepEqual([...sql.matchAll(/ALTER TABLE ([^ ]+)/g)].map(m => m[1]), ['app.%I', 'app.%I']);
  assert.match(sql, /FOREACH t IN ARRAY ARRAY\['affiliate_products','affiliate_product_commands','affiliate_programme_settings','affiliate_report_imports'\] LOOP/u);
  // Every table created is one of the four; every foreign key points at one of them.
  assert.deepEqual([...sql.matchAll(/CREATE TABLE ([a-z_.]+)\(/g)].map(m => m[1]), TABLES.map(t => `app.${t}`));
  assert.deepEqual([...sql.matchAll(/REFERENCES ([a-z_.]+)/g)].map(m => m[1]), ['app.affiliate_products']);
  // Triggers and policies only through the loop (on the new tables); no trigger or policy names another table.
  assert.deepEqual([...sql.matchAll(/CREATE TRIGGER (\S+) [^;]* ON ([^ ]+) /g)].map(m => m[2]), ['app.%I', 'app.%I']);
  assert.deepEqual([...sql.matchAll(/CREATE POLICY (\S+) ON ([^ ]+) /g)].map(m => m[2]), ['app.%I', 'app.%I']);
  // Outside function bodies, the only row written is the registry's.
  const applied = sql.replace(/\$f\$[\s\S]*?\$f\$/gu, '$f$ $f$');
  assert.deepEqual([...applied.matchAll(/(INSERT INTO|UPDATE|DELETE FROM) ([a-z_.]+)/g)].map(m => `${m[1]} ${m[2]}`), ['INSERT INTO app_private.workspace_table_registry']);
  // Inside function bodies, rows are only ever inserted, and only into the four new tables.
  const bodies = [...sql.matchAll(/\$f\$([\s\S]*?)\$f\$/gu)].map(m => m[1]!).join(' ');
  assert.doesNotMatch(bodies, /\bUPDATE app|\bDELETE FROM|\bTRUNCATE\b/u);
  for (const m of bodies.matchAll(/INSERT INTO ([a-z_.]+)/g)) assert.ok(TABLES.map(t => `app.${t}`).includes(m[1]!), m[1]);
  // Grants on existing objects: exactly the five helpers and the two schemas, to the new role only.
  assert.match(sql, /GRANT USAGE ON SCHEMA app,app_private TO r72_affiliate_definer;/u);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION app_private\.current_workspace_id\(\),app_private\.current_user_id\(\),app_private\.current_actor_kind\(\), app_private\.seo_blog_brand\(uuid\),app_private\.seo_media_owner\(uuid,bytea\) TO r72_affiliate_definer;/u);
  const grants = [...sql.matchAll(/GRANT ([^;]+);/g)].map(m => m[1]!);
  assert.deepEqual(grants, [
    'r72_affiliate_definer TO r72_owner',
    "SELECT,INSERT ON app.%I TO r72_affiliate_definer',t)",
    'USAGE ON SCHEMA app,app_private TO r72_affiliate_definer',
    'EXECUTE ON FUNCTION app_private.current_workspace_id(),app_private.current_user_id(),app_private.current_actor_kind(), app_private.seo_blog_brand(uuid),app_private.seo_media_owner(uuid,bytea) TO r72_affiliate_definer',
    'CREATE ON SCHEMA app_private TO r72_affiliate_definer',
    'EXECUTE ON FUNCTION app_private.affiliate_product_command(uuid,bytea,text,jsonb), app_private.affiliate_programme_command(uuid,bytea,text,jsonb), app_private.affiliate_report_command(uuid,bytea,text,jsonb) TO r72_content_command',
  ]);
  assert.match(sql, /EXECUTE format\('GRANT SELECT,INSERT ON app\.%I TO r72_affiliate_definer',t\);/u, 'select and insert only: append-only');
  assert.ok(sql.lastIndexOf('REVOKE CREATE ON SCHEMA app_private FROM r72_affiliate_definer;') > sql.lastIndexOf('$f$;'), 'CREATE is taken back after the functions');
});

test('0158 tables: forced RLS, owner plus workspace-scope policy, append-only for rows and truncation, registered', async () => {
  const sql = normalise(await readFile(url, 'utf8'));
  for (const part of [
    "EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY',t);",
    "EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY',t);",
    "EXECUTE format('REVOKE ALL ON app.%I FROM PUBLIC',t);",
    "EXECUTE format('CREATE POLICY %I ON app.%I FOR ALL TO r72_owner USING(true) WITH CHECK(true)',t||'_owner',t);",
    "EXECUTE format('CREATE POLICY %I ON app.%I FOR ALL TO r72_affiliate_definer USING(workspace_id=app_private.current_workspace_id()) WITH CHECK(workspace_id=app_private.current_workspace_id())',t||'_scope',t);",
    "EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON app.%I FOR EACH ROW EXECUTE FUNCTION app_private.seo_blog_append_only()',t||'_immutable',t);",
    "EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON app.%I FOR EACH STATEMENT EXECUTE FUNCTION app_private.seo_blog_append_only()',t||'_no_truncate',t);",
    "INSERT INTO app_private.workspace_table_registry(schema_name,table_name,workspace_column) VALUES('app',t,'workspace_id');",
  ]) assert.ok(sql.includes(part), part);
  // A programme is one line in each CHECK naming it.
  assert.equal((sql.match(/programme text NOT NULL CHECK\(programme IN\('amazon_uk'\)\)/g) ?? []).length, 3);
  assert.match(sql, /affiliate_url text NOT NULL CHECK/u);
  assert.match(sql, /affiliate_url~'\^https:\/\/www\\\.amazon\\\.co\\\.uk\/dp\/\[A-Z0-9\]\{10\}\\\?tag=\[A-Za-z0-9\]\[A-Za-z0-9-\]\{0,60\}-21\$'/u);
  assert.match(sql, /CHECK\(programme<>'amazon_uk' OR tracking_id~'\^\[A-Za-z0-9\]\[A-Za-z0-9-\]\{0,60\}-21\$'\)/u);
  assert.match(sql, /site_listed_confirmed boolean NOT NULL CHECK\(site_listed_confirmed\), account_confirmed boolean NOT NULL CHECK\(account_confirmed\)/u);
  assert.match(sql, /status text NOT NULL CHECK\(status IN\('active','retired'\)\)/u);
  assert.match(sql, /notes text CHECK\(notes IS NULL OR \(length\(notes\) BETWEEN 1 AND 2000/u);
});

test('0158 functions: a NOLOGIN NOINHERIT guarded owner; every function a pinned-search-path definer; every command asks the owner rule first', async () => {
  const sql = normalise(await readFile(url, 'utf8'));
  assert.match(sql, /CREATE ROLE r72_affiliate_definer NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;/u);
  assert.match(sql, /IF EXISTS\(SELECT 1 FROM pg_auth_members m JOIN pg_roles p ON p\.oid=m\.roleid JOIN pg_roles c ON c\.oid=m\.member WHERE p\.rolname='r72_affiliate_definer' AND c\.rolname NOT IN \('r72_owner',current_user\)\) THEN RAISE EXCEPTION 'Runtime membership in affiliate function owner denied' USING ERRCODE='42501';/u);
  assert.match(sql, /AND NOT rolcanlogin AND NOT rolinherit AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls\) OR EXISTS\(SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r\.oid=m\.member WHERE r\.rolname='r72_affiliate_definer'\)/u);
  const created = [...sql.matchAll(/CREATE FUNCTION app_private\.([a-z_]+)\(/g)].map(m => m[1]);
  assert.deepEqual(created.sort(), [...HELPERS, ...COMMANDS].sort());
  assert.equal((sql.match(/SECURITY DEFINER/g) ?? []).length, created.length);
  assert.equal((sql.match(/SECURITY DEFINER SET search_path=pg_catalog AS \$f\$/g) ?? []).length, created.length);
  // Functions are created while the role is the new definer, and only then.
  const start = sql.indexOf('SET LOCAL ROLE r72_affiliate_definer;'), end = sql.lastIndexOf('RESET ROLE; SET LOCAL ROLE r72_owner;');
  for (const m of sql.matchAll(/CREATE FUNCTION/g)) assert.ok(m.index! > start && m.index! < end);
  // The owner rule: the content-command session, a 32-byte session of a signed-in person, 0137's seo_media_owner, a content business.
  const owner = /CREATE FUNCTION app_private\.affiliate_owner\(p_workspace uuid,p_session bytea\) RETURNS uuid [^$]*\$f\$(.*?)\$f\$/u.exec(sql)![1]!;
  assert.match(owner, /^ DECLARE actor uuid; BEGIN IF NOT pg_has_role\(session_user,'r72_content_command','MEMBER'\) THEN RAISE EXCEPTION 'Affiliate boundary required' USING ERRCODE='42501'; END IF;/u);
  assert.match(owner, /octet_length\(p_session\)<>32 OR app_private\.current_actor_kind\(\) IS DISTINCT FROM 'user' THEN RAISE EXCEPTION [^;]+ USING ERRCODE='42501'/u);
  assert.match(owner, /actor:=app_private\.seo_media_owner\(p_workspace,p_session\); IF actor IS NULL OR app_private\.seo_blog_brand\(p_workspace\) IS NULL THEN RAISE EXCEPTION 'Business unavailable' USING ERRCODE='42501';/u);
  for (const fn of COMMANDS) {
    const body = new RegExp(`CREATE FUNCTION app_private\\.${fn}\\(p_workspace uuid,p_session bytea,p_action text,p_input jsonb\\) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS \\$f\\$ DECLARE [^$]*? BEGIN (.*?)\\$f\\$`, 'u').exec(sql);
    assert.ok(body, fn);
    assert.match(body[1]!, /^actor:=app_private\.affiliate_owner\(p_workspace,p_session\);/u, `${fn} asks the owner rule before anything else`);
    // Every table read or written is scoped to the workspace that was checked.
    // (or, in the latest-revision subquery, to the already scoped outer row).
    for (const m of body[1]!.matchAll(/FROM app\.affiliate_[a-z_]+ (\w+) WHERE (\w+)\.workspace_id=([\w.]+)/g)) assert.ok(['p_workspace', 'x.workspace_id'].includes(m[3]!), `${fn}: ${m[0]}`);
    assert.ok(!/FROM app\.affiliate_[a-z_]+ \w+ WHERE (?!\w+\.workspace_id=(?:p_workspace|x\.workspace_id))/u.test(body[1]!), `${fn}: an unscoped read`);
  }
  // Replays, the caps and the serialising locks.
  assert.match(sql, /PERFORM pg_advisory_xact_lock\(hashtextextended\('affiliate-products:'\|\|p_workspace::text,158\)\);/u);
  assert.match(sql, /IF active_count>=500 THEN RAISE EXCEPTION 'A business can use at most 500 products at once' USING ERRCODE='54000'/u);
  assert.match(sql, />=200 THEN RAISE EXCEPTION 'A business can keep at most 200 reports' USING ERRCODE='54000'/u);
  assert.equal((sql.match(/DETAIL='affiliate_command_reused'/g) ?? []).length, 3);
  // Execute: the three commands to r72_content_command only; the helpers to nobody.
  assert.match(sql, /REVOKE ALL ON FUNCTION app_private\.affiliate_owner\(uuid,bytea\), app_private\.affiliate_uuid\(jsonb,text\), app_private\.affiliate_product_json\(app\.affiliate_products\), app_private\.affiliate_settings_json\(uuid,text\), app_private\.affiliate_product_command\(uuid,bytea,text,jsonb\), app_private\.affiliate_programme_command\(uuid,bytea,text,jsonb\), app_private\.affiliate_report_command\(uuid,bytea,text,jsonb\) FROM PUBLIC;/u);
  assert.equal((sql.match(/TO r72_content_command/g) ?? []).length, 1);
  assert.doesNotMatch(sql, /TO (?:PUBLIC|r72_web|r72_worker|r72_webhook|r72_public|r72_readonly|r72_identity_command)\b/u);
});
