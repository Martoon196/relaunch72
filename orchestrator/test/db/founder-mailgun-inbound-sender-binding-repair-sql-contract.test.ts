import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migrationUrl = new URL(
  '../../src/db/migrations/0072_founder_mailgun_inbound_sender_binding_repair.sql',
  import.meta.url,
);

test('0072 binds the signed inbound sender to the settled delivery contact point', async () => {
  const sql = (await readFile(migrationUrl, 'utf8')).replace(/\r\n?/g, '\n');
  assert.match(sql, /CREATE OR REPLACE FUNCTION app_private\.record_property_predator_owned_seed_mailgun_inbound\(/u);
  assert.match(sql, /lower\(point\.normalized_value\) = p_normalized_sender/u);
  assert.doesNotMatch(sql, /p_normalized_sender <> 'office@propertypredator\.com'/u);
  assert.match(sql, /selected_delivery\.contact_point_id/u);
  assert.match(sql, /p_sender_identity_sha256 <> public\.digest\(p_normalized_sender, 'sha256'\)/u);
  assert.match(sql, /provider_id = 'mailgun_eu'/u);
  assert.match(sql, /job\.state = 'settled'/u);
  assert.match(sql, /delivery\.status IN \('accepted', 'delivered', 'read'\)/u);
  assert.match(sql, /REVOKE ALL ON FUNCTION app_private\.record_property_predator_owned_seed_mailgun_inbound/u);
  assert.match(sql, /has_function_privilege\([\s\S]*?'r72_mailgun_webhook_command'/u);
  assert.match(sql, /owner_role\.rolname = 'r72_mailgun_webhook_definer'/u);
  assert.match(sql, /procedure\.prosecdef/u);
  assert.match(sql, /procedure\.proconfig = ARRAY\['search_path=pg_catalog'\]::text\[\]/u);
});
