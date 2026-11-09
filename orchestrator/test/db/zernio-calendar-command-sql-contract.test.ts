import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migrationUrl = new URL(
  '../../src/db/migrations/0088_property_predator_zernio_calendar_command.sql',
  import.meta.url,
);

async function sql(): Promise<string> {
  return (await readFile(migrationUrl, 'utf8'))
    .replace(/--[^\n]*/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

test('0088 exposes one table-blind Zernio calendar command to the exact login role', async () => {
  const source = await sql();
  assert.match(
    source,
    /CREATE FUNCTION app_private\.enqueue_zernio_calendar_from_connected_account\(/u,
  );
  assert.match(source, /session_user <> 'r72_zernio_social_command'/u);
  assert.match(source, /current_setting\('app\.actor_kind', true\) IS DISTINCT FROM 'user'/u);
  assert.match(
    source,
    /current_setting\('transaction_isolation'\) IS DISTINCT FROM 'serializable'/u,
  );
  assert.match(
    source,
    /current_setting\('transaction_read_only'\) IS DISTINCT FROM 'off'/u,
  );
  assert.match(source, /membership\.role IN \('owner', 'admin'\)/u);
  assert.match(
    source,
    /GRANT EXECUTE ON FUNCTION app_private\.enqueue_zernio_calendar_from_connected_account[\s\S]+TO r72_zernio_social_command/u,
  );
  assert.match(source, /Zernio social command role is not table-blind/u);
  assert.doesNotMatch(source, /GRANT EXECUTE[^;]+ TO PUBLIC/u);
  assert.doesNotMatch(
    source,
    /GRANT (?:SELECT|INSERT|UPDATE|DELETE|TRUNCATE)[^;]+ TO r72_zernio_social_command/u,
  );
  assert.match(
    source,
    /RESET ROLE; SET LOCAL ROLE r72_owner; REVOKE CREATE ON SCHEMA app_private FROM r72_owned_social_definer;/u,
  );
});

test('0088 resolves an exact active account and the latest still-connected signed receipt', async () => {
  const source = await sql();
  assert.match(source, /account\.workspace_id = p_workspace_id/u);
  assert.match(source, /account\.provider_connection_id = p_provider_connection_id/u);
  assert.match(source, /account\.network = p_network/u);
  assert.match(
    source,
    /account\.provider_profile_id_sha256 = p_expected_provider_profile_id_sha256/u,
  );
  assert.match(
    source,
    /account\.provider_account_id_sha256 = p_expected_provider_account_id_sha256/u,
  );
  assert.match(source, /account\.status = 'active'/u);
  assert.match(source, /connection\.provider_id = 'zernio'/u);
  assert.match(source, /connection\.provider_kind = 'social'/u);
  assert.match(source, /connection\.environment = 'live'/u);
  assert.match(source, /connection\.status = 'active'/u);
  assert.match(source, /receipt\.event_type = 'account\.connected'/u);
  assert.match(source, /disconnected_receipt\.event_type = 'account\.disconnected'/u);
  assert.match(
    source,
    /disconnected_receipt\.occurred_at >= receipt\.occurred_at/u,
  );
  assert.match(
    source,
    /ORDER BY receipt\.occurred_at DESC, receipt\.received_at DESC, receipt\.event_id DESC LIMIT 1/u,
  );
});

test('0088 derives capability and immutable command digests in Postgres', async () => {
  const source = await sql();
  assert.match(
    source,
    /propertypredator\.zernio-calendar-publish-capability\/v1/u,
  );
  assert.match(source, /propertypredator\.zernio-calendar-command\/v1/u);
  assert.match(source, /propertypredator\.zernio-calendar-job\/v1/u);
  assert.match(source, /public\.digest\(pg_catalog\.format/u);
  assert.match(source, /public\.digest\(version\.content_body, 'sha256'\)/u);
  assert.doesNotMatch(
    source,
    /p_(?:publish_capability|idempotency_key|request)_sha256/u,
  );
});

test('0088 reuses only current non-revoked binding evidence or records it before enqueue', async () => {
  const source = await sql();
  assert.match(source, /'zernio-calendar-binding:'[\s\S]+7200085/u);
  assert.match(
    source,
    /binding\.publish_capability_evidence_sha256 = selected_capability_sha256/u,
  );
  assert.match(
    source,
    /binding\.ownership_evidence_sha256 = selected_account\.ownership_evidence_sha256/u,
  );
  assert.match(
    source,
    /property_predator_zernio_publish_binding_revocations/u,
  );
  const record = source.indexOf('app_private.record_zernio_calendar_publish_binding(');
  const enqueue = source.indexOf('app_private.enqueue_zernio_calendar_job(');
  assert.ok(record > 0 && enqueue > record, 'binding must be established before enqueue');
  assert.match(source, /RETURN QUERY SELECT selected_job_id, selected_idempotency_sha256, 1, 3/u);
});

test('0088 remains provider-effect and credential free', async () => {
  const source = await sql();
  assert.doesNotMatch(source, /api[_ ]?key|bearer|authorization|credential|http|fetch/iu);
  assert.doesNotMatch(source, /INSERT INTO app\.provider_operations/u);
  assert.doesNotMatch(source, /UPDATE app\.provider_connections/u);
});
