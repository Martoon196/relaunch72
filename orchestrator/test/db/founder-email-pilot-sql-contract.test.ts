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

const RESOLVER_SIGNATURE = 'uuid, uuid, uuid, uuid, text, timestamptz';
const DIGEST_SIGNATURE = 'uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, '
  + 'uuid, uuid, uuid, uuid, uuid, timestamptz, uuid, uuid, uuid, bytea';

/** The exact argument list a `concat_ws(chr(31), ...)` digest is built from. */
function digestFields(sql: string, marker: string): string {
  const start = sql.indexOf(marker);
  assert.ok(start > 0, `${marker} not found`);
  const open = sql.indexOf('pg_catalog.concat_ws(pg_catalog.chr(31),', start);
  assert.ok(open > 0, `no concat_ws after ${marker}`);
  const from = open + 'pg_catalog.concat_ws(pg_catalog.chr(31),'.length;
  // Walk to the matching close paren so nested calls are not truncated.
  let depth = 1;
  let index = from;
  while (index < sql.length && depth > 0) {
    const character = sql[index];
    if (character === '(') depth += 1;
    if (character === ')') depth -= 1;
    index += 1;
  }
  assert.equal(depth, 0, `unbalanced concat_ws after ${marker}`);
  return sql.slice(from, index - 1).trim();
}

test('0064 derives the same request digest 0054 compares, field for field', async () => {
  // The whole point of the derivation is that the enqueue accepts it. If either
  // side gains, loses or reorders a field, every authorisation fails at the
  // digest comparison with no useful diagnostic. This catches that here instead.
  const [pilot, live] = await Promise.all([
    migration(),
    readFile(
      new URL(
        '../../src/db/migrations/0054_property_predator_customer_email_live_foundation.sql',
        import.meta.url,
      ),
      'utf8',
    ).then(normalise),
  ]);
  assert.equal(
    digestFields(pilot, 'CREATE FUNCTION app_private.derive_customer_email_pilot_request_digest('),
    digestFields(live, 'expected_request_sha := public.digest('),
  );
});

test('0064 builds the same action scope the enqueue binds every decision to', async () => {
  const [pilot, live] = await Promise.all([
    migration(),
    readFile(
      new URL(
        '../../src/db/migrations/0054_property_predator_customer_email_live_foundation.sql',
        import.meta.url,
      ),
      'utf8',
    ).then(normalise),
  ]);
  const scope = /expected_action_scope := public\.digest\(format\( 'email:%s[^;]*?\), 'sha256'\)/u;
  const inLive = live.match(scope);
  assert.ok(inLive, '0054 action scope not found');
  // The derivation must repeat 0054's exactly; a route decision recorded
  // against a different scope would never match.
  assert.ok(pilot.includes(inLive[0]), 'the pilot digest must reuse 0054 action scope');
});

test('0064 resolves the exact tuple and the words that would be sent', async () => {
  const body = bodyOf(await migration(), 'resolve_customer_email_pilot_evidence');
  for (const returned of [
    'campaign_template_version_id', 'campaign_approval_decision_id',
    'message_version_id', 'message_approval_decision_id', 'channel_endpoint_id',
    'consent_event_id', 'compliance_subject_id', 'policy_publication_event_id',
    'pecr_sender_decision_event_id', 'pecr_instigator_decision_event_id',
    'permission_use_receipt_id', 'recipient_email', 'subject', 'body_text',
  ]) {
    assert.match(body, new RegExp(returned), returned);
  }
  // A partially resolved tuple returns nothing rather than a half-built row.
  assert.match(body, /IF selected_campaign IS NULL THEN RETURN; END IF;/);
  assert.match(body, /IF selected_message IS NULL THEN RETURN; END IF;/);
  assert.match(body, /IF selected_compliance IS NULL THEN RETURN; END IF;/);
});

test('0064 repeats the enqueue predicates rather than relaxing them', async () => {
  const body = bodyOf(await migration(), 'resolve_customer_email_pilot_evidence');
  // Consent latest-wins, suppression latest-wins per scope, and current
  // approvals only: the same three the enqueue applies.
  assert.match(body, /consent\.state = 'granted'/);
  assert.match(body, /lawful_basis IN \('consent', 'legitimate_interests'\)/);
  assert.match(body, /latest\.purpose IS NOT DISTINCT FROM suppression\.purpose/);
  assert.match(body, /decision\.decision = 'approved'/);
  assert.match(body, /message_decision\.decision = 'approved'/);
  assert.match(body, /message\.lifecycle = 'approved'/);
  // The permission use is bound to this operator and this exact request.
  assert.match(body, /permission_use\.recorded_by_user_id = selected_user_id/);
  assert.match(
    body,
    /permission_use\.recorded_request_id = current_setting\('app\.request_id'\)/,
  );
});

test('0064 keeps the resolver and the digest read-only', async () => {
  const sql = await migration();
  for (const name of [
    'resolve_customer_email_pilot_evidence',
    'derive_customer_email_pilot_request_digest',
  ]) {
    const body = bodyOf(sql, name);
    assert.match(body, /session_user <> 'r72_crm_command'/, name);
    assert.match(
      body,
      /membership\.status = 'active' AND membership\.role IN \('owner', 'admin'\)/,
      name,
    );
    assert.doesNotMatch(body, /INSERT INTO|UPDATE app\.|DELETE FROM/, name);
    assert.doesNotMatch(body, /authorize_and_enqueue/, name);
  }
  assert.match(
    sql,
    /RETURNS bytea LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog/,
  );
});

test('0064 grants the two new functions only to the command identity', async () => {
  const sql = await migration();
  for (const [name, signature] of [
    ['resolve_customer_email_pilot_evidence', RESOLVER_SIGNATURE],
    ['derive_customer_email_pilot_request_digest', DIGEST_SIGNATURE],
  ] as const) {
    assert.match(sql, new RegExp(
      `REVOKE ALL ON FUNCTION app_private\\.${name}\\( ${signature} \\) FROM PUBLIC`,
    ), name);
    assert.match(sql, new RegExp(
      `GRANT EXECUTE ON FUNCTION app_private\\.${name}\\( ${signature} \\) TO r72_crm_command`,
    ), name);
  }
  // Resolving evidence must never become a way to enqueue.
  assert.match(sql, /r72_crm_command must never hold the customer email enqueue/);
});

test('0064 reads compliance evidence through its own workspace-scoped policies', async () => {
  const sql = await migration();
  for (const table of [
    'affiliate_compliance_policy_publication_events',
    'affiliate_compliance_specialist_decision_events',
    'affiliate_compliance_permission_use_receipts',
  ]) {
    assert.match(sql, new RegExp(
      `ON app_private\\.${table} FOR SELECT TO r72_email_pilot_readiness_definer`,
    ), table);
  }
  // Reading them must never come with a way to write them.
  assert.match(
    sql,
    /'app_private\.affiliate_compliance_permission_use_receipts',/,
  );
});

test('0064 names the durable evidence blockers rather than refusing opaquely', async () => {
  const body = bodyOf(await migration(), 'customer_email_pilot_readiness');
  for (const [dimension, code] of [
    ['policy_authority', 'POLICY_AUTHORITY_MISSING'],
    ['pecr_decisions', 'PECR_DECISIONS_MISSING'],
    ['permission_use_receipt', 'PERMISSION_USE_RECEIPT_MISSING'],
  ] as const) {
    assert.match(body, new RegExp(`dimension := '${dimension}'`), dimension);
    assert.match(body, new RegExp(code), code);
  }
});

test('0064 sends nothing and calls no provider', async () => {
  // Two exclusions, both deliberate. Block comments are prose, not behaviour:
  // normalise strips only `--`, and these doc comments legitimately say the
  // functions cannot dispatch. The isolation audits name the enqueue and the
  // tables it writes precisely in order to prove this rail holds none of them,
  // which is the opposite of using them. Scan what executes against the data.
  const raw = await readFile(migrationUrl, 'utf8');
  const audits = [...raw.matchAll(/DO \$(\w+_audit)\$([\s\S]*?)\$\1\$;/g)];
  assert.equal(audits.length, 3, 'every audit must be accounted for before exclusion');
  for (const [, name, body] of audits) {
    // An excluded block must be a privilege assertion and nothing else, so the
    // exclusion can never become a place to hide a write.
    assert.match(
      body ?? '', /has_table_privilege|has_function_privilege/, name,
    );
    assert.doesNotMatch(
      body ?? '', /INSERT INTO|UPDATE app|DELETE FROM|PERFORM|RETURN QUERY/, name,
    );
  }
  const sql = normalise(
    audits.reduce(
      (text, [block]) => text.replace(block, ' '),
      raw.replace(/\/\*[\s\S]*?\*\//g, ' '),
    ),
  );
  for (const forbidden of [
    // 'mailgun_eu' is the provider id the probe matches on, which is evidence,
    // not a call. These tokens are the ways a call could actually be made.
    'authorize_and_enqueue', 'mailgun_api', 'http', 'dispatch', 'provider_operations',
  ]) {
    assert.doesNotMatch(sql, new RegExp(forbidden, 'i'), `${forbidden} must not appear`);
  }
});
