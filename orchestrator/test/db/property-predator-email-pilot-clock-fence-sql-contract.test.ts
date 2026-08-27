import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migrationUrl = new URL(
  '../../src/db/migrations/0034_property_predator_email_pilot_clock_fence.sql',
  import.meta.url,
);

async function migration(): Promise<string> {
  return (await readFile(migrationUrl, 'utf8')).replace(/\r\n?/g, '\n');
}

test('0034 preserves provider facts while fencing operational chronology', async () => {
  const sql = await migration();

  assert.match(sql, /provider_occurred_at = p_occurred_at/);
  assert.match(
    sql,
    /THEN GREATEST\(p_occurred_at, operation\.created_at\)/,
  );
  assert.match(
    sql,
    /THEN GREATEST\(p_occurred_at, delivery\.queued_at\)/,
  );
  assert.doesNotMatch(
    sql,
    /WHEN p_status IN \('accepted', 'succeeded', 'failed'\) THEN p_occurred_at/,
  );
  assert.doesNotMatch(
    sql,
    /WHEN p_status = 'failed' THEN p_occurred_at/,
  );
});

test('0034 preserves the table-blind worker boundary and exact function owner', async () => {
  const sql = await migration();

  assert.match(sql, /SET LOCAL ROLE r72_mailgun_worker_definer/);
  assert.match(
    sql,
    /SECURITY DEFINER SET search_path = pg_catalog/,
  );
  assert.match(
    sql,
    /REVOKE ALL ON FUNCTION app_private\.settle_property_predator_email_pilot_call\([\s\S]*?\) FROM PUBLIC/,
  );
  assert.match(
    sql,
    /GRANT EXECUTE ON FUNCTION app_private\.settle_property_predator_email_pilot_call\([\s\S]*?\) TO r72_mailgun_worker_command/,
  );
  assert.match(
    sql,
    /REVOKE CREATE ON SCHEMA app_private FROM r72_mailgun_worker_definer/,
  );
  assert.doesNotMatch(
    sql,
    /GRANT (?:SELECT|INSERT|UPDATE|DELETE|TRUNCATE)[^;]*TO r72_mailgun_worker_command/,
  );
});

test('0034 keeps all original settlement fail-closed fences', async () => {
  const sql = await migration();

  assert.match(sql, /pg_advisory_xact_lock/);
  assert.match(sql, /selected\.state <> 'calling'/);
  assert.match(sql, /Mailgun reservation settlement conflict/);
  assert.match(sql, /operation\.state = 'calling'/);
  assert.match(sql, /delivery\.status = 'sending'/);
  assert.match(sql, /changed_rows <> 1/);
  assert.match(sql, /needs_attention is an\s*-- ambiguous outcome/);
});
