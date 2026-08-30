import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const migrationUrl = new URL(
  '../../src/db/migrations/0064_founder_email_pilot_endpoint_and_readiness.sql',
  import.meta.url,
);

const ATTACH_SIGNATURE = 'uuid, uuid, text, text, text, text, timestamptz, bytea';
const READINESS_SIGNATURE = 'uuid, uuid, uuid, uuid, text';

function normalise(sql: string): string {
  return sql.replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ').trim();
}

async function migration(): Promise<string> {
  return normalise(await readFile(migrationUrl, 'utf8'));
}

function bodyOf(sql: string, name: string): string {
  const start = sql.indexOf(`CREATE FUNCTION app_private.${name}(`);
  assert.ok(start > 0, `${name} not found`);
  return sql.slice(start, sql.indexOf('$function$;', start));
}

test('0064 attaches an endpoint without being able to create a contact', async () => {
  const sql = await migration();
  // Structural, not a promise about the body: the definer holds no write
  // privilege on contacts or opportunities, so "Create a lead" duplication is
  // impossible through this command however it is edited later.
  assert.match(
    sql,
    /FOREACH target IN ARRAY ARRAY\[ 'app\.contacts', 'app\.opportunities', 'app\.communication_suppression_events', 'app\.communication_consent_events' \]/,
  );
  assert.match(sql, /The contact endpoint definer must never hold % on %/);
  assert.doesNotMatch(sql, /GRANT[^;]*ON app\.contacts[^;]*TO r72_contact_endpoint_definer/);
  assert.doesNotMatch(sql, /GRANT[^;]*ON app\.opportunities[^;]*TO r72_contact_endpoint_definer/);
  const body = bodyOf(sql, 'attach_verified_contact_email_endpoint');
  assert.doesNotMatch(body, /INSERT INTO app\.contacts/);
  assert.doesNotMatch(body, /INSERT INTO app\.opportunities/);
});

test('0064 never records consent or releases a suppression', async () => {
  const sql = await migration();
  const body = bodyOf(sql, 'attach_verified_contact_email_endpoint');
  assert.doesNotMatch(body, /communication_consent_events/);
  assert.doesNotMatch(body, /communication_suppression_events/);
  // The readiness reader evaluates suppression but can never write it.
  assert.match(sql, /The email pilot readiness definer must never hold % on %/);
});

test('0064 narrows both founder commands to an active owner or admin', async () => {
  const sql = await migration();
  for (const name of [
    'attach_verified_contact_email_endpoint', 'customer_email_pilot_readiness',
  ]) {
    const body = bodyOf(sql, name);
    assert.match(body, /session_user <> 'r72_crm_command'/, name);
    assert.match(
      body,
      /membership\.status = 'active' AND membership\.role IN \('owner', 'admin'\)/,
      name,
    );
    assert.match(body, /current_setting\('app\.actor_kind', true\) IS DISTINCT FROM 'user'/, name);
  }
});

test('0064 makes the endpoint attach idempotent and refuses a reused key', async () => {
  const sql = await migration();
  const body = bodyOf(sql, 'attach_verified_contact_email_endpoint');
  assert.match(sql, /UNIQUE \(workspace_id, command_key_sha256\)/);
  assert.match(body, /selected_receipt\.request_sha256 IS DISTINCT FROM computed_request_sha256/);
  assert.match(body, /Contact endpoint command key conflict/);
  assert.match(body, /RETURN QUERY SELECT 'replayed'::text/);
  assert.match(body, /RETURN QUERY SELECT 'applied'::text/);
  assert.match(body, /pg_advisory_xact_lock/);
});

test('0064 re-verifies an existing endpoint rather than duplicating it', async () => {
  const body = bodyOf(await migration(), 'attach_verified_contact_email_endpoint');
  assert.match(body, /point\.kind = 'email' AND point\.normalized_value = normalized/);
  assert.match(body, /UPDATE app\.contact_points AS point SET is_verified = true/);
  // A deliberately deleted endpoint is never silently resurrected.
  assert.match(body, /was deleted and cannot be re-verified here/);
});

test('0064 keeps endpoint verification evidence append-only', async () => {
  const sql = await migration();
  assert.match(sql, /Contact endpoint verification receipts are append-only/);
  assert.match(
    sql,
    /CREATE TRIGGER contact_endpoint_receipts_immutable BEFORE UPDATE OR DELETE/,
  );
  assert.match(sql, /evidence_source text NOT NULL/);
  assert.match(sql, /evidence_reference text NOT NULL/);
  assert.match(sql, /verified_at timestamptz NOT NULL/);
});

test('0064 readiness is read-only and emits every typed dimension', async () => {
  const sql = await migration();
  const body = bodyOf(sql, 'customer_email_pilot_readiness');
  assert.match(
    sql,
    /RETURNS TABLE \(dimension text, ready boolean, blocker_code text\) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog/,
  );
  for (const dimension of [
    'operator_authority', 'provider_connection', 'recipient_endpoint',
    'sender_endpoint', 'current_consent', 'suppression_clear',
    'approved_campaign_version', 'approved_message_version',
    'approved_pilot_content', 'cap_headroom',
  ]) {
    assert.match(body, new RegExp(`dimension := '${dimension}'`), dimension);
  }
  for (const code of [
    'OPERATOR_NOT_AUTHORISED', 'PROVIDER_NOT_CONFIGURED', 'RECIPIENT_ENDPOINT_MISSING',
    'SENDER_ENDPOINT_MISSING', 'CONSENT_NOT_GRANTED', 'RECIPIENT_SUPPRESSED',
    'CAMPAIGN_APPROVAL_REQUIRED', 'MESSAGE_APPROVAL_REQUIRED',
    'PILOT_CONTENT_NOT_APPROVED', 'CAP_REACHED',
  ]) {
    assert.match(body, new RegExp(code), code);
  }
  // Read-only by construction: it must never write or enqueue.
  assert.doesNotMatch(body, /INSERT INTO|UPDATE app\.|DELETE FROM/);
  assert.doesNotMatch(body, /authorize_and_enqueue/);
});

test('0064 evaluates suppression latest-wins per scope, as the enqueue does', async () => {
  const body = bodyOf(await migration(), 'customer_email_pilot_readiness');
  assert.match(body, /suppression\.purpose IS NULL OR suppression\.purpose = p_purpose/);
  assert.match(body, /latest\.purpose IS NOT DISTINCT FROM suppression\.purpose/);
  assert.match(body, /ORDER BY latest\.occurred_at DESC, latest\.recorded_at DESC, latest\.id DESC/);
});

test('0064 derives the endpoint digest from the stored point, never the caller', async () => {
  const body = bodyOf(await migration(), 'attach_verified_contact_email_endpoint');
  assert.match(
    body,
    /endpoint_identity := public\.digest\( 'email' \|\| pg_catalog\.chr\(31\) \|\| p_email/,
  );
});

test('0064 grants only the two functions to the command identity', async () => {
  const sql = await migration();
  for (const [name, signature] of [
    ['attach_verified_contact_email_endpoint', ATTACH_SIGNATURE],
    ['customer_email_pilot_readiness', READINESS_SIGNATURE],
  ] as const) {
    assert.match(sql, new RegExp(
      `GRANT EXECUTE ON FUNCTION app_private\\.${name}\\( ${signature} \\) TO r72_crm_command`,
    ));
    assert.match(sql, new RegExp(
      `REVOKE ALL ON FUNCTION app_private\\.${name}\\( ${signature} \\) FROM PUBLIC`,
    ));
  }
  assert.match(sql, /r72_crm_command must not hold % on the endpoint receipt ledger/);
});

test('0064 keeps the two definers isolated from each other', async () => {
  const sql = await migration();
  assert.match(sql, /REVOKE r72_contact_endpoint_definer FROM r72_email_pilot_readiness_definer/);
  assert.match(sql, /REVOKE r72_email_pilot_readiness_definer FROM r72_contact_endpoint_definer/);
  assert.match(sql, /Unsafe founder email pilot definer attributes/);
  assert.match(sql, /Unsafe founder email pilot definer parent/);
});

test('0064 sends nothing and calls no provider', async () => {
  // Block comments are prose, not behaviour: normalise strips only `--`, and
  // these doc comments legitimately say the functions cannot dispatch. Scan the
  // executable statements instead.
  const raw = await readFile(migrationUrl, 'utf8');
  const sql = normalise(raw.replace(/\/\*[\s\S]*?\*\//g, ' '));
  for (const forbidden of [
    // 'mailgun_eu' is the provider id the probe matches on, which is evidence,
    // not a call. These tokens are the ways a call could actually be made.
    'authorize_and_enqueue', 'mailgun_api', 'http', 'dispatch', 'provider_operations',
  ]) {
    assert.doesNotMatch(sql, new RegExp(forbidden, 'i'), `${forbidden} must not appear`);
  }
});
