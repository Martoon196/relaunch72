import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migrationUrl = new URL(
  '../../src/db/migrations/0079_property_predator_zernio_reply_lifecycle.sql',
  import.meta.url,
);

function normalise(sql: string): string {
  return sql.replace(/--[^\n]*/gu, ' ').replace(/\s+/gu, ' ').trim();
}

test('0079 creates an immutable approved Zernio reply lifecycle with a one-shot send fence', async () => {
  const sql = normalise(await readFile(migrationUrl, 'utf8'));
  for (const table of [
    'property_predator_zernio_reply_drafts',
    'property_predator_zernio_reply_approval_requests',
    'property_predator_zernio_reply_approval_decisions',
    'property_predator_zernio_reply_deliveries',
  ]) {
    assert.match(sql, new RegExp(`CREATE TABLE app\\.${table}`));
    assert.match(sql, new RegExp(`ALTER TABLE app\\.${table} ENABLE ROW LEVEL SECURITY`));
    assert.match(sql, new RegExp(`ALTER TABLE app\\.${table} FORCE ROW LEVEL SECURITY`));
  }
  assert.match(sql, /body_text = btrim\(body_text\)/u);
  assert.match(sql, /public\.digest\(p_body, 'sha256'\) <> p_body_sha256/u);
  assert.match(sql, /decision text NOT NULL CHECK \(decision IN \('approved', 'rejected'\)\)/u);
  assert.match(sql, /state text NOT NULL CHECK \(state IN \('calling', 'accepted', 'failed', 'outcome_unknown'\)\)/u);
  assert.match(sql, /selected_decision\.decision <> 'approved'/u);
  assert.match(sql, /RETURN QUERY SELECT \('already_' \|\| existing\.state\)::text, NULL::text/u);
  assert.match(sql, /OLD\.state <> 'calling'/u);
  assert.match(sql, /p_state = 'outcome_unknown'/u);
  assert.match(sql, /session_user <> 'r72_zernio_social_command'/u);
  assert.match(sql, /membership\.role IN \('owner', 'admin'\)/u);
  assert.match(sql, /account\.network = 'instagram' AND account\.status = 'active'/u);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION app_private\.create_zernio_reply_draft/u);
  assert.match(sql, /app_private\.claim_zernio_reply_send/u);
  assert.match(sql, /app_private\.settle_zernio_reply_send/u);
  assert.match(sql, /pg_catalog\.aclexplode\(/u);
  assert.match(sql, /privilege\.grantee = 0/u);
  assert.match(sql, /privilege\.privilege_type = 'EXECUTE'/u);
  assert.doesNotMatch(sql, /has_function_privilege\('PUBLIC'/u);
  assert.doesNotMatch(sql, /GRANT (?:SELECT|INSERT|UPDATE|DELETE|TRUNCATE)[^;]+ TO r72_zernio_social_command/u);
  assert.doesNotMatch(sql, /GRANT EXECUTE[^;]+ TO PUBLIC/u);
});
