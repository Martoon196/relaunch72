import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const migrationUrl = new URL(
  '../../src/db/migrations/0063_contact_permission_founder_decisions.sql',
  import.meta.url,
);

const SIGNATURE = 'uuid, uuid, uuid, text, text, text, text, text, text, bytea, text, bytea, timestamptz';

function normalise(sql: string): string {
  return sql.replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ').trim();
}

async function migration(): Promise<string> {
  return normalise(await readFile(migrationUrl, 'utf8'));
}

function functionBody(sql: string): string {
  const start = sql.indexOf('CREATE FUNCTION app_private.record_contact_permission_decision(');
  assert.ok(start > 0, 'decision function not found');
  return sql.slice(start, sql.indexOf('$function$;', start));
}

test('0063 reuses the existing consent ledger instead of a second consent system', async () => {
  const sql = await migration();
  const body = functionBody(sql);
  assert.match(body, /INSERT INTO app\.communication_consent_events \(/);
  // No parallel decision table: the only new table is the idempotency receipt.
  const created = [...sql.matchAll(/CREATE TABLE app\.([a-z_]+)/g)].map((m) => m[1]);
  assert.deepEqual(created, ['contact_permission_command_receipts']);
});

test('0063 narrows the decision to an active owner or admin', async () => {
  const sql = await migration();
  const body = functionBody(sql);
  assert.match(sql, /CREATE ROLE r72_contact_permission_definer NOLOGIN NOINHERIT/);
  assert.match(sql, /GRANT r72_contact_permission_definer TO r72_owner/);
  assert.match(sql, /Unsafe contact permission definer role attributes/);
  assert.match(sql, /GRANT USAGE ON SCHEMA app, app_private TO r72_contact_permission_definer/);
  assert.match(
    sql,
    /GRANT EXECUTE ON FUNCTION app_private\.current_workspace_id\(\), app_private\.current_user_id\(\), app_private\.current_actor_kind\(\) TO r72_contact_permission_definer/,
  );
  assert.match(
    body,
    /membership\.status = 'active' AND membership\.role IN \('owner', 'admin'\)/,
  );
  // can_write_workspace also admits marketer and sales, which is too wide for
  // a legal permission record, so it must not be the gate here.
  assert.doesNotMatch(body, /can_write_workspace/);
  assert.match(body, /session_user <> 'r72_crm_command'/);
  assert.match(body, /current_setting\('app\.actor_kind', true\) IS DISTINCT FROM 'user'/);
});

test('0063 binds the decision to the exact contact, endpoint and channel', async () => {
  const sql = await migration();
  const body = functionBody(sql);
  assert.match(sql, /CREATE POLICY contact_permission_points_definer_select/);
  assert.match(sql, /CREATE POLICY contact_permission_memberships_definer_select/);
  assert.match(body, /point\.id = p_contact_point_id AND point\.contact_id = p_contact_id/);
  assert.match(body, /point\.deleted_at IS NULL/);
  assert.match(body, /Contact permission endpoint is not bound to this contact/);
  assert.match(body, /expected_kind := CASE p_channel WHEN 'email' THEN 'email' WHEN 'sms' THEN 'phone' ELSE 'whatsapp' END/);
  assert.match(body, /Contact permission channel does not match the endpoint kind/);
  // The endpoint digest is derived from the stored point, never supplied.
  assert.match(
    body,
    /endpoint_identity := public\.digest\( selected_point_kind \|\| pg_catalog\.chr\(31\) \|\| selected_point_value/,
  );
  assert.doesNotMatch(body, /SELECT point\.\*/);
});

test('0063 makes the command idempotent and refuses a reused key', async () => {
  const sql = await migration();
  const body = functionBody(sql);
  assert.match(sql, /UNIQUE \(workspace_id, command_key_sha256\)/);
  assert.match(body, /selected_receipt\.request_sha256 IS DISTINCT FROM computed_request_sha256/);
  assert.match(body, /Contact permission command key conflict/);
  assert.match(body, /RETURN QUERY SELECT 'replayed'::text/);
  assert.match(body, /RETURN QUERY SELECT 'applied'::text/);
  assert.match(body, /pg_advisory_xact_lock/);
});

test('0063 can never clear or override a suppression', async () => {
  const sql = await migration();
  const body = functionBody(sql);
  // Structural, not a promise about the body: the definer holds no write
  // privilege on the suppression ledger, and the apply fails if it ever does.
  assert.match(
    sql,
    /FOREACH privilege IN ARRAY ARRAY\['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'\] LOOP IF pg_catalog\.has_table_privilege\( 'r72_contact_permission_definer', 'app\.communication_suppression_events', privilege \)/,
  );
  assert.match(sql, /must never hold % on the suppression ledger/);
  assert.doesNotMatch(sql, /GRANT[^;]*ON app\.communication_suppression_events[^;]*TO r72_contact_permission_definer/);
  assert.doesNotMatch(body, /communication_suppression_events/);
});

test('0063 keeps permission evidence append-only', async () => {
  const sql = await migration();
  assert.match(sql, /Contact permission receipts are append-only/);
  assert.match(
    sql,
    /CREATE TRIGGER contact_permission_receipts_immutable BEFORE UPDATE OR DELETE/,
  );
  assert.match(sql, /must never hold % on %/);
  for (const forbidden of ['UPDATE', 'DELETE', 'TRUNCATE']) {
    assert.match(sql, new RegExp(`'${forbidden}'`));
  }
  assert.doesNotMatch(sql, /GRANT[^;]*\b(UPDATE|DELETE)\b[^;]*ON app\.communication_consent_events/);
});

test('0063 keeps the command identity blind to the receipt ledger', async () => {
  const sql = await migration();
  assert.match(sql, /r72_crm_command must not hold % on %/);
  assert.match(
    sql,
    new RegExp(`GRANT EXECUTE ON FUNCTION app_private\\.record_contact_permission_decision\\( ${SIGNATURE} \\) TO r72_crm_command`),
  );
  assert.match(
    sql,
    new RegExp(`REVOKE ALL ON FUNCTION app_private\\.record_contact_permission_decision\\( ${SIGNATURE} \\) FROM PUBLIC`),
  );
  assert.doesNotMatch(
    sql,
    /GRANT[^;]*ON app\.contact_permission_command_receipts[^;]*TO r72_crm_command/,
  );
});

test('0063 records the operator and never queues a message', async () => {
  const sql = await migration();
  const body = functionBody(sql);
  // The decision names the operator who recorded it, and the RLS policy
  // independently requires that operator to be the acting session user.
  assert.match(body, /'user', selected_user_id,/);
  assert.match(
    await migration(),
    /actor_kind = 'user' AND actor_user_id = app_private\.current_user_id\(\)/,
  );
  // A permission decision has no message path at all.
  for (const forbidden of [
    'property_predator_sms_jobs', 'property_predator_customer_email_jobs',
    'property_predator_whatsapp_live_jobs', 'message_deliveries',
    'provider_operations', 'enqueue', 'dispatch',
  ]) {
    assert.doesNotMatch(sql, new RegExp(forbidden, 'i'), `${forbidden} must not appear`);
  }
});

test('0063 requires a lawful basis for a grant and forbids one otherwise', async () => {
  const body = functionBody(await migration());
  assert.match(body, /\(p_decision = 'granted'\) <> \(p_lawful_basis IS NOT NULL\)/);
  assert.match(body, /Contact permission lawful basis is invalid/);
  assert.match(body, /p_decision NOT IN \('granted', 'denied', 'withdrawn'\)/);
});
