import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';

const migrationsDir = new URL('../../src/db/migrations/', import.meta.url);
const auditMigrationUrl = new URL(
  '../../src/db/migrations/0062_operational_inbox_live_evidence_read_boundary.sql',
  import.meta.url,
);

/**
 * Words that open a table constraint rather than a column, so they are never
 * mistaken for a column name while reading a CREATE TABLE body.
 */
const CONSTRAINT_KEYWORDS = new Set([
  'primary', 'unique', 'foreign', 'check', 'constraint', 'exclude', 'like',
]);

/** Return the body of the parenthesised block that starts at openIndex. */
function parenBlock(sql: string, openIndex: number): string {
  let depth = 0;
  for (let i = openIndex; i < sql.length; i += 1) {
    if (sql[i] === '(') depth += 1;
    else if (sql[i] === ')') {
      depth -= 1;
      if (depth === 0) return sql.slice(openIndex + 1, i);
    }
  }
  throw new Error('unbalanced CREATE TABLE body');
}

/** Split a table body on commas that sit at parenthesis depth zero. */
function topLevelParts(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const character of body) {
    if (character === '(') depth += 1;
    if (character === ')') depth -= 1;
    if (character === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += character;
  }
  parts.push(current);
  return parts;
}

/**
 * Every column the migrations define for a table in the app schema, including
 * columns added later by ALTER TABLE and minus columns that were dropped.
 */
async function schemaColumns(): Promise<Map<string, Set<string>>> {
  const files = (await readdir(migrationsDir))
    .filter((name) => name.endsWith('.sql'))
    .sort();
  const columns = new Map<string, Set<string>>();
  for (const file of files) {
    const sql = (await readFile(new URL(file, migrationsDir), 'utf8'))
      .replace(/--[^\n]*/g, ' ');
    const createPattern = /CREATE TABLE (?:IF NOT EXISTS )?app\.([a-z0-9_]+)\s*\(/gi;
    let created: RegExpExecArray | null = createPattern.exec(sql);
    while (created !== null) {
      const table = created[1]!;
      const body = parenBlock(sql, createPattern.lastIndex - 1);
      const known = columns.get(table) ?? new Set<string>();
      for (const part of topLevelParts(body)) {
        const name = part.trim().split(/\s+/)[0]?.toLowerCase();
        if (name && !CONSTRAINT_KEYWORDS.has(name) && /^[a-z_][a-z0-9_]*$/.test(name)) {
          known.add(name);
        }
      }
      columns.set(table, known);
      created = createPattern.exec(sql);
    }
    const addPattern =
      /ALTER TABLE (?:IF EXISTS )?app\.([a-z0-9_]+)[^;]*?ADD COLUMN (?:IF NOT EXISTS )?([a-z0-9_]+)/gi;
    let added: RegExpExecArray | null = addPattern.exec(sql);
    while (added !== null) {
      const known = columns.get(added[1]!) ?? new Set<string>();
      known.add(added[2]!.toLowerCase());
      columns.set(added[1]!, known);
      added = addPattern.exec(sql);
    }
    const dropPattern =
      /ALTER TABLE (?:IF EXISTS )?app\.([a-z0-9_]+)[^;]*?DROP COLUMN (?:IF EXISTS )?([a-z0-9_]+)/gi;
    let dropped: RegExpExecArray | null = dropPattern.exec(sql);
    while (dropped !== null) {
      columns.get(dropped[1]!)?.delete(dropped[2]!.toLowerCase());
      dropped = dropPattern.exec(sql);
    }
  }
  return columns;
}

/** The (table, column) tuples 0062's definer column audit checks. */
function columnAuditCandidates(sql: string): { table: string; column: string }[] {
  const start = sql.indexOf('DO $definer_column_audit$');
  assert.ok(start > 0, 'definer column audit not found');
  const end = sql.indexOf('$definer_column_audit$;', start);
  const block = sql.slice(start, end);
  return [...block.matchAll(/\['([a-z0-9_]+)',\s*'([a-z0-9_]+)'\]/g)]
    .map((match) => ({ table: match[1]!, column: match[2]! }));
}

/** The table names 0062's r72_web blindness audit checks. */
function tableAuditCandidates(sql: string): string[] {
  const start = sql.indexOf('DO $web_table_blindness_audit$');
  assert.ok(start > 0, 'blindness audit not found');
  const end = sql.indexOf('$web_table_blindness_audit$;', start);
  const block = sql.slice(start, end);
  const array = block.slice(block.indexOf('ARRAY['), block.indexOf(']', block.indexOf('ARRAY[')));
  return [...array.matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]!);
}

test('the migration parser finds the columns a known table really declares', async () => {
  // Guards the parser itself: a parser that silently found nothing would make
  // every assertion below vacuous, which is how the stale name survived review.
  const columns = await schemaColumns();
  const receipts = columns.get('property_predator_mailgun_inbound_receipts');
  assert.ok(receipts, 'mailgun inbound receipts must be discovered');
  for (const column of ['id', 'workspace_id', 'conversation_id', 'inbound_message_id',
    'received_at', 'signature_token_sha256']) {
    assert.ok(receipts.has(column), `expected real column ${column}`);
  }
  // The exact name that failed the disposable-Neon apply with 42703.
  assert.equal(receipts.has('signature_sha256'), false);
  assert.ok((columns.get('property_predator_sms_jobs') ?? new Set()).has('recipient_sha256'));
});

test('every 0062 column-audit candidate names a real column', async () => {
  const sql = await readFile(auditMigrationUrl, 'utf8');
  const columns = await schemaColumns();
  const candidates = columnAuditCandidates(sql);
  assert.ok(candidates.length >= 8, 'expected the definer column audit candidates');
  const stale = candidates.filter(
    ({ table, column }) => !(columns.get(table)?.has(column) ?? false),
  );
  assert.deepEqual(
    stale, [],
    `0062 audits columns that do not exist: ${stale.map((s) => `${s.table}.${s.column}`).join(', ')}`,
  );
});

test('every 0062 blindness-audit candidate names a real table', async () => {
  const sql = await readFile(auditMigrationUrl, 'utf8');
  const columns = await schemaColumns();
  const tables = tableAuditCandidates(sql);
  assert.ok(tables.length >= 4, 'expected the r72_web blindness candidates');
  for (const table of tables) {
    assert.ok(columns.has(table), `0062 audits a table that does not exist: app.${table}`);
  }
});

test('0062 audits privileges by attnum so a stale name cannot raise 42703', async () => {
  const sql = (await readFile(auditMigrationUrl, 'utf8'))
    .replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ');
  // The name-based overload evaluates its column argument even when a guard
  // clause would have excluded the row, because PostgreSQL does not promise
  // WHERE-clause evaluation order. The attnum overload cannot fail that way.
  assert.match(
    sql,
    /has_column_privilege\(\s*'r72_operational_inbox_definer', resolved_relation, resolved_attnum, 'SELECT'\s*\)/,
  );
  assert.doesNotMatch(sql, /has_column_privilege\([^)]*format\(/);
  // The table audit resolves through to_regclass for the same reason.
  assert.match(sql, /has_table_privilege\(\s*'r72_web', resolved_relation,/);
  assert.match(sql, /must name a real table/);
  // A candidate that matches no real column must fail the apply loudly rather
  // than silently auditing nothing.
  assert.match(sql, /must name a real column/);
});
