import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migrationUrl = new URL(
  '../../src/db/migrations/0027_property_predator_founder_bootstrap.sql',
  import.meta.url,
);

async function migration(): Promise<string> {
  return (await readFile(migrationUrl, 'utf8')).replace(/\r\n?/g, '\n');
}

test('0027 is a function-only offline boundary unavailable to every runtime identity', async () => {
  const sql = await migration();
  assert.match(sql, /CREATE FUNCTION app_private\.bootstrap_property_predator_founder\(/);
  assert.match(sql, /SECURITY DEFINER\s+SET search_path = pg_catalog/);
  assert.match(sql, /procedure\.proowner = 'r72_onboarding_definer'::regrole/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION app_private\.provision_customer_workspace\([\s\S]*?TO r72_onboarding_definer/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION app_private\.bootstrap_property_predator_founder\([\s\S]*?TO r72_owner/);
  for (const role of [
    'r72_web', 'r72_identity_command', 'r72_crm_command',
    'r72_content_command', 'r72_mailgun_webhook_command',
    'r72_mailgun_worker_command', 'r72_provisioning_command',
    'r72_setup_delivery_command', 'r72_setup_reissue_command',
  ]) {
    assert.match(sql, new RegExp(`'${role}'`));
    assert.doesNotMatch(
      sql,
      new RegExp(`GRANT EXECUTE ON FUNCTION app_private\\.bootstrap_property_predator_founder\\([\\s\\S]*?TO ${role}`),
    );
  }
  assert.match(sql, /has_function_privilege\(runtime_role, function_oid, 'EXECUTE'\)/);
});

test('0027 requires the exact 27-file checksum ledger and exact database installation', async () => {
  const sql = await migration();
  const required = /required_migration_filenames text\[\] := ARRAY\[(.*?)\];/s.exec(sql)?.[1];
  assert.ok(required);
  const filenames = [...required.matchAll(/'([0-9]{4}_[a-z0-9_]+[.]sql)'/g)].map((match) => match[1]);
  assert.equal(filenames.length, 27);
  assert.equal(filenames[0], '0001_extensions_roles.sql');
  assert.equal(filenames.at(-1), '0027_property_predator_founder_bootstrap.sql');
  assert.match(sql, /jsonb_array_length\(p_expected_migration_ledger\) <> 27/);
  assert.match(sql, /coalesce\(item\.value->>'checksum', ''\) !~ '\^\[0-9a-f\]\{64\}\$'/);
  assert.match(sql, /expected_migration_filenames <> required_migration_filenames/);
  assert.match(sql, /FROM app_private\.runtime_schema_migrations\(\)/);
  assert.match(sql, /actual_migration_ledger <> p_expected_migration_ledger/);
  assert.match(sql, /app_private\.runtime_database_installation_id\(\)/);
  assert.match(sql, /actual_installation_id IS DISTINCT FROM p_expected_installation_id/);
  assert.doesNotMatch(sql, /pg_catalog\.coalesce/);
});

test('0027 is empty-only, globally serialized, idempotent and conflict detecting', async () => {
  const sql = await migration();
  assert.match(sql, /pg_advisory_xact_lock\(1382302770, 7200027\)/);
  assert.match(sql, /WHERE receipt\.change_reference = normalized_change_reference/);
  assert.match(sql, /selected_receipt\.request_hash <> stable_request_hash/);
  assert.match(sql, /founder bootstrap change reference conflict/);
  assert.match(sql, /RETURN QUERY SELECT[\s\S]*selected_receipt\.organization_id[\s\S]*false/);
  for (const relation of [
    'app_private.property_predator_founder_bootstrap_receipts',
    'app_private.customer_provisioning_receipts',
    'app.organizations', 'app.workspaces', 'app.users',
    'app.provider_connections',
    'app.property_predator_email_pilot_control_events',
    'app.property_predator_email_pilot_seed_events',
  ]) {
    assert.match(sql, new RegExp(`EXISTS \\(\\s*SELECT 1 FROM ${relation.replace('.', '\\.')}`));
  }
  assert.match(sql, /requires an empty, unbootstrapped database/);
  assert.match(sql, /FROM app_private\.provision_customer_workspace\(/);
  assert.match(sql, /provisioned\.created_now IS DISTINCT FROM true/);
});

test('0027 pins a credential-free Mailgun EU connection and the dark manifest policy', async () => {
  const sql = await migration();
  assert.match(sql, /'mailgun_eu'[\s\S]*'email'[\s\S]*'live'[\s\S]*'active'/);
  assert.match(sql, /'Property Predator Mailgun EU'/);
  assert.match(sql, /'\["email\.events", "email\.send"\]'::jsonb/);
  assert.doesNotMatch(sql, /mailgun_(?:api_)?key|mailgun_secret|provider_credential/i);
  assert.match(sql, /false,\s*false,\s*true,\s*10,\s*10000,\s*10,\s*100,\s*100000,\s*1000000,/);
  assert.match(sql, /'founder_bootstrap\.dark'/);
  assert.match(sql, /'office@propertypredator\.com'/);
  assert.match(sql, /'Owned Property Predator internal founder and seed mailbox'/);
});

test('0027 creates no message, contact, consent, inbox or operation record', async () => {
  const sql = await migration();
  for (const forbidden of [
    'app.contacts', 'app.contact_points', 'app.channel_endpoints', 'app.inboxes',
    'app.conversations', 'app.messages', 'app.message_versions',
    'app.communication_consent_events', 'app.communication_suppression_events',
    'app.provider_operations', 'app.message_deliveries',
  ]) {
    assert.doesNotMatch(sql, new RegExp(`INSERT INTO ${forbidden.replace('.', '\\.')}`));
  }
});

test('0027 keeps the receipt and token evidence append-only and hash-only', async () => {
  const sql = await migration();
  const receipt = /CREATE TABLE app_private\.property_predator_founder_bootstrap_receipts \((.*?)\n\);/s.exec(sql)?.[1];
  assert.ok(receipt);
  assert.match(receipt, /request_hash bytea NOT NULL CHECK \(octet_length\(request_hash\) = 32\)/);
  assert.match(receipt, /owner_email_sha256 bytea NOT NULL CHECK \(octet_length\(owner_email_sha256\) = 32\)/);
  assert.match(receipt, /setup_action_token_id uuid NOT NULL UNIQUE/);
  assert.doesNotMatch(receipt, /setup_token_hash|setup_token text|setup_url|raw_token/);
  assert.match(sql, /BEFORE UPDATE OR DELETE[\s\S]*property_predator_founder_bootstrap_receipts/);
  assert.match(sql, /founder bootstrap receipt is append-only/);
  assert.match(sql, /p_setup_token_hash bytea/);
  assert.match(sql, /octet_length\(p_setup_token_hash\) <> 32/);
  assert.doesNotMatch(sql, /RETURNS TABLE \([\s\S]*?(?:raw_)?setup_token\s+text/);
});
