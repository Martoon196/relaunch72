import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  SMS_ACTIVATION_BLOCKER_CODES,
  SMS_ACTIVATION_DIMENSIONS,
  SMS_DAILY_SEGMENT_HARD_CAP,
  SMS_MONTHLY_SEGMENT_HARD_CAP,
} from '../../src/sms-activation/foundation.js';

const migration56Url = new URL(
  '../../src/db/migrations/0056_property_predator_twilio_sms_live_foundation.sql',
  import.meta.url,
);
const migration60Url = new URL(
  '../../src/db/migrations/0060_property_predator_twilio_sms_founder_binding.sql',
  import.meta.url,
);

function normalise(sql: string): string {
  return sql.replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ').trim();
}

async function migration60(): Promise<string> {
  return normalise(await readFile(migration60Url, 'utf8'));
}

/** The exact function bodies, so a claim about one cannot be met by another. */
function bodyOf(sql: string, signature: string): string {
  const start = sql.indexOf(signature);
  assert.notEqual(start, -1, `${signature} must be present`);
  const end = sql.indexOf('$function$;', start);
  assert.notEqual(end, -1, `${signature} must be terminated`);
  return sql.slice(start, end);
}

test('0060 widens provider_kind to admit the SMS rail and refuses a silent no-op', async () => {
  const sql = await migration60();

  // 0056 is inert until this widening: every SMS predicate needs provider_kind
  // = 'sms', which no row could satisfy under the 0022 check.
  assert.match(sql, /ALTER TABLE app\.provider_connections DROP CONSTRAINT %I/);
  assert.match(
    sql,
    /ADD CONSTRAINT provider_connections_provider_kind_check CHECK \(provider_kind IN \('messaging', 'email', 'social', 'sms'\)\)/,
  );
  for (const kind of ['messaging', 'email', 'social', 'sms']) {
    assert.match(sql, new RegExp(`candidates\\.definition LIKE '%${kind}%'|'${kind}'`));
  }

  // Finding no narrow check means the assumption this migration rests on is
  // wrong, so it must fail loudly rather than appear to succeed.
  assert.match(sql, /candidates\.definition NOT LIKE '%sms%'/);
  assert.match(
    sql,
    /IF narrow_constraint IS NULL THEN RAISE EXCEPTION 'Expected the narrow provider_kind check that blocks the SMS rail'/,
  );
});

test('0060 gates both founder commands on the exact SMS command identity', async () => {
  const sql = await migration60();
  for (const signature of [
    'CREATE FUNCTION app_private.record_sms_live_binding(',
    'CREATE FUNCTION app_private.revoke_sms_live_binding(',
  ]) {
    const body = bodyOf(sql, signature);
    assert.match(body, /session_user <> 'r72_sms_command'/, signature);
    assert.match(
      body,
      /current_setting\('app\.workspace_id', true\) IS DISTINCT FROM p_workspace_id::text/,
      signature,
    );
    assert.match(
      body,
      /current_setting\('app\.actor_kind', true\) IS DISTINCT FROM 'user'/,
      signature,
    );
    assert.match(
      body,
      /current_setting\('app\.user_id', true\) !~ '\^\[0-9a-f-\]\{36\}\$'/,
      signature,
    );
    assert.match(body, /USING ERRCODE = '42501'/, signature);

    // Authority is a live owner/admin membership, re-proved inside the definer.
    assert.match(
      body,
      /membership\.status = 'active' AND membership\.role IN \('owner', 'admin'\)/,
      signature,
    );
  }

  assert.match(
    sql,
    /GRANT EXECUTE ON FUNCTION app_private\.record_sms_live_binding\( uuid, uuid, uuid, uuid, text, bytea, bytea, text, bytea, bytea, timestamptz \) TO r72_sms_command/,
  );
  assert.match(
    sql,
    /GRANT EXECUTE ON FUNCTION app_private\.revoke_sms_live_binding\( uuid, uuid, text, bytea \) TO r72_sms_command/,
  );
  assert.match(
    sql,
    /REVOKE ALL ON FUNCTION app_private\.record_sms_live_binding\( uuid, uuid, uuid, uuid, text, bytea, bytea, text, bytea, bytea, timestamptz \) FROM PUBLIC/,
  );
  assert.match(
    sql,
    /REVOKE ALL ON FUNCTION app_private\.revoke_sms_live_binding\( uuid, uuid, text, bytea \) FROM PUBLIC/,
  );
  assert.match(sql, /REVOKE CREATE ON SCHEMA app_private FROM r72_sms_definer/);

  // r72_sms_command is the only grantee anywhere in the migration, so no
  // second identity can reach a founder command by a different door.
  const grantees = new Set(
    (sql.match(/GRANT EXECUTE ON FUNCTION [^;]*? TO ([a-z0-9_]+)/g) ?? [])
      .map((line) => line.slice(line.lastIndexOf(' ') + 1)),
  );
  assert.deepEqual([...grantees], ['r72_sms_command']);
});

test('0060 binding creates exactly one live Twilio connection and its owned sender', async () => {
  const sql = await migration60();
  const body = bodyOf(sql, 'CREATE FUNCTION app_private.record_sms_live_binding(');

  assert.match(
    body,
    /INSERT INTO app\.provider_connections \( id, workspace_id, provider_id, provider_kind, environment, status, display_name, capabilities, created_by_user_id \) VALUES \( p_provider_connection_id, p_workspace_id, 'twilio_messaging', 'sms', 'live', 'active', p_display_name, '\["sms\.send"\]'::jsonb, selected_user \)/,
  );
  assert.match(
    body,
    /INSERT INTO app\.channel_endpoints \( id, workspace_id, provider_connection_id, channel, environment, direction, address, normalized_address, display_name, status \) VALUES \( p_channel_endpoint_id, p_workspace_id, p_provider_connection_id, 'sms', 'live', 'bidirectional', p_sender_number, p_sender_number, p_display_name, 'active' \)/,
  );

  // The same shape is enforced twice: by the insert and by the definer policy
  // that bounds what the definer could ever write.
  assert.match(
    sql,
    /CREATE POLICY provider_connections_sms_definer_insert ON app\.provider_connections FOR INSERT TO r72_sms_definer WITH CHECK \([^;]*provider_id = 'twilio_messaging' AND provider_kind = 'sms' AND environment = 'live' AND status = 'active' AND capabilities @> '\["sms\.send"\]'::jsonb \)/,
  );
  assert.match(
    sql,
    /CREATE POLICY channel_endpoints_sms_definer_insert ON app\.channel_endpoints FOR INSERT TO r72_sms_definer WITH CHECK \([^;]*channel = 'sms' AND environment = 'live' AND status = 'active' AND direction = 'bidirectional' AND address = normalized_address AND normalized_address ~ '\^\\\+44\[0-9\]\{9,10\}\$' \)/,
  );
  assert.match(body, /p_sender_number !~ '\^\\\+44\[0-9\]\{9,10\}\$'/);
});

test('0060 makes revocation one-per-binding, append-only and connection-disabling', async () => {
  const sql = await migration60();

  // One revocation per binding: a rotation is a revoke plus a fresh binding.
  assert.match(
    sql,
    /CREATE TABLE app\.property_predator_sms_binding_revocations \([^;]*UNIQUE \(workspace_id, binding_id\)/,
  );
  assert.match(
    sql,
    /CREATE TRIGGER property_predator_sms_binding_revocations_immutable BEFORE UPDATE OR DELETE ON app\.property_predator_sms_binding_revocations FOR EACH ROW EXECUTE FUNCTION app_private\.sms_live_immutable_guard\(\)/,
  );
  assert.match(
    sql,
    /CREATE TRIGGER property_predator_sms_bindings_immutable BEFORE UPDATE OR DELETE ON app\.property_predator_sms_bindings FOR EACH ROW EXECUTE FUNCTION app_private\.sms_live_immutable_guard\(\)/,
  );

  const body = bodyOf(sql, 'CREATE FUNCTION app_private.revoke_sms_live_binding(');
  assert.match(
    body,
    /UPDATE app\.provider_connections AS connection SET status = 'disabled', row_version = connection\.row_version \+ 1/,
  );
  assert.match(body, /connection\.provider_id = 'twilio_messaging' AND connection\.provider_kind = 'sms'/);
  // A differing replay is a conflict, an identical one is idempotent.
  assert.match(body, /RAISE EXCEPTION 'Twilio SMS revocation conflict' USING ERRCODE = '40001'/);
  assert.match(body, /RETURN existing\.id/);

  // The definer may only ever move a connection towards disabled.
  assert.match(
    sql,
    /GRANT UPDATE \(status, row_version, updated_at\) ON app\.provider_connections TO r72_sms_definer/,
  );
  assert.match(
    sql,
    /CREATE POLICY provider_connections_sms_definer_update ON app\.provider_connections FOR UPDATE TO r72_sms_definer USING \([^;]*\) WITH CHECK \([^;]*AND status = 'disabled' \)/,
  );
  assert.doesNotMatch(sql, /DELETE FROM app\.property_predator_sms_binding_revocations/);
});

test('0060 stores no Twilio secret of any kind', async () => {
  const raw = await readFile(migration60Url, 'utf8');
  for (const forbidden of [
    /auth_token/i,
    /TWILIO_AUTH_TOKEN/i,
    /\bapi_key\b/i,
    /\bapi_secret\b/i,
    /\bapi_key_sid\b/i,
    /\baccess_token\b/i,
  ]) {
    assert.doesNotMatch(raw, forbidden,
      `the founder binding migration must never name ${String(forbidden)}`);
  }

  // What it does store is digests of the two identifiers, never their text.
  const sql = normalise(raw);
  assert.match(
    sql,
    /account_sid_sha256 bytea NOT NULL CHECK \(octet_length\(account_sid_sha256\) = 32\)/,
  );
  assert.match(
    sql,
    /messaging_service_sid_sha256 bytea NOT NULL CHECK \(octet_length\(messaging_service_sid_sha256\) = 32\)/,
  );
  assert.doesNotMatch(sql, /account_sid text/);
  assert.doesNotMatch(sql, /messaging_service_sid text/);
  // Only the routable sender number is clear, because channel_endpoints needs it.
  assert.match(sql, /sender_number text NOT NULL CHECK \(sender_number ~ '\^\\\+44\[0-9\]\{9,10\}\$'\)/);
});

test('0060 derives the request digest 0056 re-computes, on the same contract', async () => {
  const sixty = await migration60();
  const fiftySix = normalise(await readFile(migration56Url, 'utf8'));
  const body = bodyOf(sixty, 'CREATE FUNCTION app_private.derive_sms_live_request_digest(');

  assert.match(body, /RETURNS bytea LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog/);
  assert.match(body, /session_user <> 'r72_sms_command'/);
  assert.match(body, /RAISE EXCEPTION 'Twilio SMS request digest derivation denied' USING ERRCODE = '42501'/);
  assert.match(
    sixty,
    /GRANT EXECUTE ON FUNCTION app_private\.derive_sms_live_request_digest\( uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, timestamptz, uuid, uuid, uuid, bytea \) TO r72_sms_command/,
  );
  assert.match(
    sixty,
    /REVOKE ALL ON FUNCTION app_private\.derive_sms_live_request_digest\( uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, timestamptz, uuid, uuid, uuid, bytea \) FROM PUBLIC/,
  );

  // If either half drifted, the derived digest would never match and the
  // command would raise a request-digest conflict for every founder staging.
  const contract = /'propertypredator\.twilio-sms-live\/v1'/;
  const instantFormat = /'YYYY-MM-DD"T"HH24:MI:SS\.MS"Z"'/;
  for (const [label, text] of [['0060', sixty], ['0056', fiftySix]] as const) {
    assert.match(text, contract, `${label} must carry the live contract token`);
    assert.match(text, instantFormat, `${label} must carry the same instant format`);
  }
  assert.match(body, contract);
  assert.match(body, instantFormat);
  assert.match(body, /pg_catalog\.concat_ws\(pg_catalog\.chr\(31\)/);
  assert.match(fiftySix, /pg_catalog\.concat_ws\(pg_catalog\.chr\(31\)/);
});

test('0060 readiness is read-only and emits every typed dimension and blocker', async () => {
  const sql = await migration60();
  const body = bodyOf(
    sql,
    'CREATE FUNCTION app_private.property_predator_sms_activation_readiness(',
  );

  assert.match(body, /RETURNS TABLE \(dimension text, ready boolean, blocker_code text\)/);
  assert.match(body, /LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog/);
  for (const mutation of [
    /\bINSERT INTO\b/, /\bUPDATE app\./, /\bDELETE FROM\b/, /\bTRUNCATE\b/,
    /\bnextval\b/, /\bFOR UPDATE\b/, /\bCOMMIT\b/,
  ]) {
    assert.doesNotMatch(body, mutation,
      `the readiness probe must not contain ${String(mutation)}`);
  }
  assert.doesNotMatch(body, /authorize_and_enqueue_sms_live_job/);

  for (const dimension of SMS_ACTIVATION_DIMENSIONS) {
    assert.match(body, new RegExp(`dimension := '${dimension}'`), dimension);
  }
  assert.equal(SMS_ACTIVATION_BLOCKER_CODES.length, 13);
  for (const code of SMS_ACTIVATION_BLOCKER_CODES) {
    assert.match(body, new RegExp(`'${code}'`), code);
  }

  assert.match(body, /session_user <> 'r72_sms_command'/);
  assert.match(body, /RAISE EXCEPTION 'Twilio SMS activation readiness denied' USING ERRCODE = '42501'/);
  assert.match(
    sql,
    /GRANT EXECUTE ON FUNCTION app_private\.property_predator_sms_activation_readiness\( uuid, uuid, uuid, uuid, uuid, uuid, uuid, text, bytea \) TO r72_sms_command/,
  );

  // The recipient is proved by digest and never returned.
  assert.match(body, /octet_length\(p_expected_recipient_sha256\) <> 32/);
  assert.match(body, /selected_recipient_sha = p_expected_recipient_sha256/);
  assert.doesNotMatch(body, /RETURNS TABLE \([^)]*recipient[^)]*\)/);
});

test('0060 readiness checks the pause scopes and sums segments against the caps', async () => {
  const sql = await migration60();
  const body = bodyOf(
    sql,
    'CREATE FUNCTION app_private.property_predator_sms_activation_readiness(',
  );

  assert.match(body, /pause\.scope IN \('all', 'sms'\)/);
  assert.match(body, /'EMERGENCY_PAUSED'/);

  // Summed, never counted: one three-segment job must consume three of ten.
  assert.match(body, /coalesce\(sum\(job\.segment_count\), 0\)::integer INTO day_segments/);
  assert.match(body, /coalesce\(sum\(job\.segment_count\), 0\)::integer INTO month_segments/);
  assert.match(body, /job\.utc_day = \(statement_timestamp\(\) AT TIME ZONE 'UTC'\)::date/);
  assert.match(
    body,
    /job\.utc_month = date_trunc\('month', statement_timestamp\(\) AT TIME ZONE 'UTC'\)::date/,
  );
  assert.match(body, /job\.state <> 'cancelled'/);
  // An unresolved message leaves the segment count unknown, so headroom cannot
  // be claimed at all rather than defaulted to something optimistic.
  assert.match(body, /ready := selected_segments IS NOT NULL/);
  assert.match(
    body,
    new RegExp(`day_segments \\+ selected_segments <= ${SMS_DAILY_SEGMENT_HARD_CAP}`),
  );
  assert.match(
    body,
    new RegExp(`month_segments \\+ selected_segments <= ${SMS_MONTHLY_SEGMENT_HARD_CAP}`),
  );
  assert.equal(SMS_DAILY_SEGMENT_HARD_CAP, 10);
  assert.equal(SMS_MONTHLY_SEGMENT_HARD_CAP, 50);
  assert.match(body, /'CAP_REACHED'/);
});

test('0060 re-proves the three SMS command roles are still table-blind', async () => {
  const sql = await migration60();

  assert.match(
    sql,
    /FOREACH checked_role IN ARRAY ARRAY\[ 'r72_sms_command', 'r72_sms_worker_command', 'r72_sms_webhook_command' \] LOOP/,
  );
  for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) {
    assert.match(
      sql,
      new RegExp(`has_table_privilege\\(checked_role, relation\\.oid, '${privilege}'\\)`),
      privilege,
    );
  }
  assert.match(sql, /namespace\.nspname IN \('app', 'app_private'\)/);
  assert.match(
    sql,
    /RAISE EXCEPTION 'Unsafe Twilio SMS founder binding capability: % -> %', checked_role, unsafe_object/,
  );

  // Both new tables are tenant scoped and registered for the workspace audit.
  assert.match(sql, /ALTER TABLE app\.property_predator_sms_bindings FORCE ROW LEVEL SECURITY/);
  assert.match(
    sql,
    /ALTER TABLE app\.property_predator_sms_binding_revocations FORCE ROW LEVEL SECURITY/,
  );
  assert.match(
    sql,
    /INSERT INTO app_private\.workspace_table_registry \(schema_name, table_name, workspace_column\) VALUES \('app', 'property_predator_sms_bindings', 'workspace_id'\), \('app', 'property_predator_sms_binding_revocations', 'workspace_id'\)/,
  );
});

// The 10/50 segment caps exist as three independent TypeScript constant pairs
// plus two migrations. Nothing previously asserted they agree, so a change to
// one would surface to a founder as a number the database does not enforce.
test('every SMS segment cap constant agrees with the migrations that enforce them', async () => {
  const activation = await import('../../src/sms-activation/foundation.js');
  const commandTypes = await import('../../src/sms-live-pg/types.js');
  const liveFoundation = await import('../../src/sms-live/foundation.js');

  const daily = [
    activation.SMS_DAILY_SEGMENT_HARD_CAP,
    commandTypes.SMS_DAILY_SEGMENT_CAP,
    liveFoundation.TWILIO_SMS_DAILY_SEGMENT_HARD_CAP,
  ];
  const monthly = [
    activation.SMS_MONTHLY_SEGMENT_HARD_CAP,
    commandTypes.SMS_MONTHLY_SEGMENT_CAP,
    liveFoundation.TWILIO_SMS_MONTHLY_SEGMENT_HARD_CAP,
  ];
  assert.deepEqual(new Set(daily), new Set([10]), 'daily segment caps diverged');
  assert.deepEqual(new Set(monthly), new Set([50]), 'monthly segment caps diverged');

  // 0056 admits pre-insertion; 0060's probe reports the same ceiling.
  const enforcement = normalise(await readFile(migration56Url, 'utf8'));
  const probe = normalise(await readFile(migration60Url, 'utf8'));
  assert.match(enforcement, /day_segments \+ selected_segment_count > 10/);
  assert.match(enforcement, /month_segments \+ selected_segment_count > 50/);
  assert.match(probe, /day_segments \+ selected_segments <= 10/);
  assert.match(probe, /month_segments \+ selected_segments <= 50/);
});
