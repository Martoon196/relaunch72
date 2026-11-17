/**
 * Migration 0159 (retire the hand-applied book sign-up trigger), read as text: it removes only what the two docs/ops
 * files added, touches no row, hard-codes no id, keeps 0134's SELECT on app.contact_points, and its pinned checksum is
 * exactly the file's bytes. The behaviour on real PostgreSQL is in mhp-book-crm.integration.test.ts.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { discoverMigrations } from '../../src/db/migrate.js';
import { MHP_BOOK_CRM_CHECKSUM, MHP_BOOK_CRM_MIGRATION } from '../../src/db/mhp-book-crm-schema.js';

const file = new URL(`../../src/db/migrations/${MHP_BOOK_CRM_MIGRATION}`, import.meta.url);
const opsFile = (name: string) => new URL(`../../../docs/ops/${name}`, import.meta.url);
const code = (sql: string) => sql.split('\n').filter(line => !line.trimStart().startsWith('--')).join('\n');

test('0159 is the 159th bundled file and its pinned checksum is exactly its bytes', async () => {
  const sql = (await readFile(file, 'utf8')).replace(/\r\n?/g, '\n');
  assert.equal(createHash('sha256').update(sql, 'utf8').digest('hex'), MHP_BOOK_CRM_CHECKSUM);
  const all = await discoverMigrations();
  assert.equal(all.length, 159);
  assert.deepEqual([all[158]!.filename, all[158]!.checksum], [MHP_BOOK_CRM_MIGRATION, MHP_BOOK_CRM_CHECKSUM]);
});

test('0159 touches no row, hard-codes no id, takes short lock timeouts and drops only the quick fix', async () => {
  const sql = code(await readFile(file, 'utf8'));
  const statements = sql.replace(/'[^']*'/g, "''");
  assert.doesNotMatch(statements, /^\s*(INSERT|UPDATE|DELETE|TRUNCATE|COPY|ALTER|CREATE|SELECT)\b/im, 'no statement reads or writes a row or creates anything');
  assert.doesNotMatch(statements, /\b(INSERT\s+INTO|DELETE\s+FROM|TRUNCATE|CREATE\s+(TABLE|FUNCTION|POLICY|TRIGGER|ROLE|INDEX|OR))\b/i);
  assert.doesNotMatch(statements, /\bUPDATE\s+app/i);
  assert.doesNotMatch(sql, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  assert.doesNotMatch(statements, /\bGRANT\b/i);
  assert.match(sql, /^SET LOCAL lock_timeout='5s';$/m);
  assert.match(sql, /^SET LOCAL statement_timeout='60s';$/m);
  assert.doesNotMatch(sql, /\bBEGIN;|\bCOMMIT;/i, 'the runner owns the transaction');
  assert.match(sql, /DROP TRIGGER IF EXISTS mhp_book_contact_after_signup ON app_private\.mhp_prospect_signups;/);
  assert.match(sql, /DROP FUNCTION IF EXISTS app_private\.mhp_book_contact_after_signup\(\);/);
  // Every policy and grant the two recorded files created is removed by name; SELECT on contact_points (0134) is not.
  const ops = (await readFile(opsFile('mhp-book-contact-sync-20261117.sql'), 'utf8')) + (await readFile(opsFile('mhp-book-pipeline-sync-20261117.sql'), 'utf8'));
  const policies = [...ops.matchAll(/CREATE POLICY (mhp_book_\w+) ON (app\.\w+)/g)].map(m => `${m[1]} ON ${m[2]}`);
  assert.equal(policies.length, 10);
  for (const policy of policies) assert.ok(sql.includes(`DROP POLICY IF EXISTS ${policy};`), policy);
  const revokes = [...sql.matchAll(/^REVOKE (.+) ON (.+) FROM r72_mhp_prospect_definer;$/gm)].map(m => `${m[1]} ON ${m[2]}`);
  assert.deepEqual(revokes, ['SELECT, INSERT ON app.contacts', 'INSERT ON app.contact_points', 'SELECT ON app.pipelines, app.pipeline_stages',
    'SELECT, INSERT ON app.opportunities', 'INSERT ON app.opportunity_stage_history, app.tasks', 'CREATE ON SCHEMA app_private']);
  assert.doesNotMatch(sql, /REVOKE[^;]*SELECT[^;]*app\.contact_points/);
  assert.match(sql, /NOT has_table_privilege\('r72_mhp_prospect_definer','app\.contact_points','SELECT'\)/, 'the end check proves 0134 grant is kept');
});
