import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/**
 * 0065 exists because the owned-seed preparation path is not merely defaulted
 * to one mailbox, it is joined and digested against it inside applied
 * migrations. These tests hold the replacement to the properties that make it
 * a genuine replacement rather than a second version of the same lock.
 */

const migrationUrl = new URL(
  '../../src/db/migrations/0065_founder_pilot_preparation_and_evidence.sql',
  import.meta.url,
);
const liveUrl = new URL(
  '../../src/db/migrations/0054_property_predator_customer_email_live_foundation.sql',
  import.meta.url,
);
const pilotUrl = new URL(
  '../../src/db/migrations/0064_founder_email_pilot_endpoint_and_readiness.sql',
  import.meta.url,
);
const seedCampaignUrl = new URL(
  '../../src/db/migrations/0047_property_predator_owned_seed_campaign_loop.sql',
  import.meta.url,
);
const seedMessageUrl = new URL(
  '../../src/db/migrations/0048_property_predator_owned_seed_live_message.sql',
  import.meta.url,
);

const PREPARE_SIGNATURE = 'uuid, uuid, uuid, uuid, text, text, text, text, bytea, bytea';

function normalise(sql: string): string {
  return sql.replace(/--[^\n]*/gu, ' ').replace(/\s+/gu, ' ').trim();
}

async function migration(): Promise<string> {
  return normalise(await readFile(migrationUrl, 'utf8'));
}

function bodyOf(sql: string, name: string): string {
  const start = sql.indexOf(`CREATE FUNCTION app_private.${name}(`);
  assert.ok(start > 0, `${name} not found`);
  return sql.slice(start, sql.indexOf('$function$;', start));
}

test('the blocker is real: 0047 and 0048 join on one hard-coded mailbox', async () => {
  // This is the disproof the task asked for, kept as a test so the claim can
  // be re-checked rather than believed. If either migration ever stops naming
  // the address, 0065 can be reconsidered; until then it is required.
  const [campaign, message] = await Promise.all([
    readFile(seedCampaignUrl, 'utf8'),
    readFile(seedMessageUrl, 'utf8'),
  ]);
  assert.ok(
    campaign.includes('office@propertypredator.com'),
    '0047 no longer pins the address; re-evaluate whether 0065 is needed',
  );
  assert.ok(message.includes('office@propertypredator.com'));
  // Not a default that could be parameterised: it is compared and digested.
  assert.match(message, /lower\(point\.normalized_value\) = 'office@propertypredator\.com'/);
  assert.match(campaign, /public\.digest\(\s*'office@propertypredator\.com', 'sha256'\s*\)/);
});

test('0065 carries no address of any kind, in any executable form', async () => {
  const raw = await readFile(migrationUrl, 'utf8');
  // The header names the old mailbox once, to say what this migration exists
  // to replace. Prose is not a dependency; scan what actually runs.
  const executable = raw
    .replace(/\/\*[\s\S]*?\*\//gu, ' ')
    .replace(/--[^\n]*/gu, ' ');
  assert.doesNotMatch(executable, /office@propertypredator\.com/);
  assert.doesNotMatch(executable, /martin\.howard1984/iu);
  // No literal email address at all: the recipient is a row, never a string.
  assert.doesNotMatch(executable, /'[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}'/u);
  // And it never digests one either, which is how 0047 pinned its recipient.
  assert.doesNotMatch(executable, /digest\(\s*'[^']*@/u);
  // The one mention must genuinely be the explanation, not a hidden literal.
  const mentions = raw.match(/office@propertypredator\.com/gu) ?? [];
  assert.equal(mentions.length, 1);
  assert.ok(
    raw.indexOf('office@propertypredator.com') < raw.indexOf('DO $roles$'),
    'the only mention must be in the header, before any statement',
  );
  // No personal address anywhere, comment or not.
  assert.doesNotMatch(raw, /martin\.howard1984/iu);
});

test('0065 resolves the recipient by identifier and demands it be verified', async () => {
  const body = bodyOf(await migration(), 'prepare_founder_email_pilot_content');
  assert.match(body, /point\.id = p_contact_point_id/);
  assert.match(body, /point\.contact_id = p_contact_id/);
  assert.match(body, /point\.kind = 'email'/);
  assert.match(body, /point\.deleted_at IS NULL/);
  assert.match(body, /point\.is_verified/);
  assert.match(body, /point\.dedupe_state = 'normal'/);
  assert.match(body, /requires a verified email endpoint/);
  // The endpoint is never compared against a value the caller supplies, so a
  // different endpoint cannot be substituted for the one the founder verified:
  // the identifier is the only way in, and an unverified row resolves to none.
  assert.doesNotMatch(body, /normalized_value =/);
  assert.doesNotMatch(body, /p_email|p_recipient|p_address/);
});

test('0065 refuses copy that names a recipient', async () => {
  const body = bodyOf(await migration(), 'prepare_founder_email_pilot_content');
  // The campaign step column enforces this too. Refusing here means the
  // founder is told why rather than meeting a constraint violation.
  assert.match(body, /p_subject ~\* '\[A-Z0-9\._%\+-\]\+@/);
  assert.match(body, /p_body ~\* '\[A-Z0-9\._%\+-\]\+@/);
  assert.match(body, /Founder pilot preparation evidence is invalid/);
});

test('0065 preparation creates no provider call and no delivery intent', async () => {
  const sql = await migration();
  const body = bodyOf(sql, 'prepare_founder_email_pilot_content');
  for (const forbidden of [
    'message_deliveries', 'provider_operations', 'authorize_and_enqueue',
    'property_predator_customer_email_jobs', 'property_predator_mailgun_jobs',
    'mailgun', 'http',
  ]) {
    assert.doesNotMatch(body, new RegExp(forbidden, 'iu'), `${forbidden} must not appear`);
  }
  // Structural, not a promise: the receipt cannot be written claiming either.
  assert.match(
    sql,
    /provider_effects boolean NOT NULL DEFAULT false CHECK \(provider_effects IS FALSE\)/,
  );
  assert.match(
    sql,
    /delivery_intent_created boolean NOT NULL DEFAULT false CHECK \(delivery_intent_created IS FALSE\)/,
  );
  assert.match(sql, /The founder pilot preparation definer must never hold % on %/);
});

test('0065 produces every identifier the 0064 resolver returns to the enqueue', async () => {
  // The point of preparation is that the exact 0054 tuple then resolves. Pair
  // this migration's outputs against what 0064 must find, so a missing record
  // fails here rather than as an opaque refusal at authorisation time.
  const [sql, pilot] = await Promise.all([migration(), readFile(pilotUrl, 'utf8').then(normalise)]);
  const prepared = bodyOf(sql, 'prepare_founder_email_pilot_content');
  const resolver = bodyOf(pilot, 'resolve_customer_email_pilot_evidence');
  for (const [inserted, resolved] of [
    ['app.campaign_template_versions', 'campaign_template_version_id'],
    ['app.campaign_template_steps', 'campaign_template_step_id'],
    ['app.campaign_template_approval_requests', 'campaign_approval_request_id'],
    ['app.campaign_template_approval_decisions', 'campaign_approval_decision_id'],
    ['app.message_versions', 'message_version_id'],
    ['app.message_approval_requests', 'message_approval_request_id'],
    ['app.message_approval_decisions', 'message_approval_decision_id'],
    ['app.property_predator_email_pilot_approved_content', 'permission_use_receipt_id'],
  ] as const) {
    assert.match(prepared, new RegExp(`INSERT INTO ${inserted.replace(/\./gu, '\\.')}`), inserted);
    assert.match(resolver, new RegExp(resolved), resolved);
  }
  // The conversation the enqueue joins on, with the subject it compares.
  assert.match(prepared, /INSERT INTO app\.conversations/);
  assert.match(prepared, /'open', p_subject/);
  // The message body must equal the campaign step body, which is what 0054
  // compares. Both are written from the same parameter here.
  assert.match(prepared, /body_template[\s\S]*p_body/);
  assert.match(prepared, /version_number, body_text[\s\S]*1, p_body/);
});

test('0065 preparation replays on an identical retry and conflicts on changed copy', async () => {
  const sql = await migration();
  const body = bodyOf(sql, 'prepare_founder_email_pilot_content');
  assert.match(sql, /UNIQUE \(workspace_id, command_key_sha256\)/);
  assert.match(body, /selected_receipt\.request_sha256 IS DISTINCT FROM computed_request_sha256/);
  assert.match(body, /Founder pilot preparation command key conflict/);
  assert.match(body, /RETURN QUERY SELECT 'replayed'::text/);
  assert.match(body, /RETURN QUERY SELECT 'prepared'::text/);
  assert.match(body, /pg_advisory_xact_lock/);
  // The digest binds the endpoint and the exact copy, so changing either under
  // one command key is a conflict rather than a quiet second draft.
  assert.match(body, /'propertypredator\.founder-pilot-preparation\/v1'/);
  for (const bound of [
    'p_contact_point_id::text', 'p_purpose',
    "pg_catalog.encode(selected_subject_sha, 'hex')",
    "pg_catalog.encode(selected_body_sha, 'hex')", 'selected_user_id::text',
  ]) {
    assert.ok(body.includes(bound), `${bound} must be bound into the request digest`);
  }
});

test('0065 evidence binds the exact action scope the enqueue rebuilds', async () => {
  const [sql, live] = await Promise.all([migration(), readFile(liveUrl, 'utf8').then(normalise)]);
  const body = bodyOf(sql, 'record_founder_pilot_compliance_evidence');
  assert.match(live, /format\( 'email:%s:%s:%s:%s:%s:%s:%s:%s:%s:%s'/u);
  assert.match(body, /format\( 'email:%s:%s:%s:%s:%s:%s:%s:%s:%s:%s'/u);
  // The scope is rebuilt from the resolved content chain, never accepted from
  // the caller, so a route decision cannot be pointed at a different send.
  assert.doesNotMatch(body, /p_action_scope/);
  assert.match(body, /action_scope_sha256, decision_state[\s\S]*expected_action_scope/);
  assert.match(body, /decision_kind, decision_scope_ref, action_scope_sha256/);
  // Both route decisions carry it, and both are written in one statement.
  assert.match(body, /'pecr_sender_route'/);
  assert.match(body, /'pecr_instigator_route'/);
});

test('0065 evidence binds the acting user and the exact request', async () => {
  const sql = await migration();
  const body = bodyOf(sql, 'record_founder_pilot_compliance_evidence');
  // Every record carries who recorded it and under which request, which is
  // what makes the attestation auditable rather than anonymous.
  assert.equal(
    (body.match(/selected_user_id, selected_request_id/gu) ?? []).length >= 5,
    true,
    'every recorded fact must carry the acting user and request',
  );
  assert.match(body, /membership\.role IN \('owner', 'admin'\)/);
  assert.match(body, /session_user <> 'r72_founder_pilot_evidence_command'/);
  assert.match(sql, /action_scope_sha256 bytea NOT NULL CHECK \(octet_length\(action_scope_sha256\) = 32\)/);
});

test('0065 records the founder attestation and invents no approval', async () => {
  const body = bodyOf(await migration(), 'record_founder_pilot_compliance_evidence');
  // Every specialist reference, digest and occurrence time is a parameter. An
  // absent one refuses; none is defaulted, generated or inferred.
  for (const supplied of [
    'p_legal_specialist_reference', 'p_legal_decision_reference',
    'p_legal_decision_sha256', 'p_legal_occurred_at',
    'p_commercial_specialist_reference', 'p_commercial_decision_reference',
    'p_commercial_decision_sha256', 'p_commercial_occurred_at',
    'p_publication_reference', 'p_sender_decision_sha256',
    'p_instigator_decision_sha256', 'p_route_classification',
  ]) {
    assert.match(body, new RegExp(`${supplied} IS NULL`), `${supplied} must be required`);
  }
  assert.match(body, /Founder pilot compliance attestation is incomplete/);
  // A decision cannot be recorded as having happened in the future.
  assert.match(body, /p_legal_occurred_at > statement_timestamp\(\)/);
  assert.match(body, /p_commercial_occurred_at > statement_timestamp\(\)/);
  assert.match(body, /p_effective_at > statement_timestamp\(\)/);
  // It records approvals; it never records a rejection as an approval.
  assert.doesNotMatch(body, /'rejected'|'qualified_approval'|'withdrawn'/);
});

test('0065 evidence replays on an identical retry and conflicts on changed evidence', async () => {
  const sql = await migration();
  const body = bodyOf(sql, 'record_founder_pilot_compliance_evidence');
  assert.match(body, /selected_receipt\.request_sha256 IS DISTINCT FROM computed_request_sha256/);
  // The scope is compared too: the same references against a different send
  // must not silently reuse a stored publication.
  assert.match(
    body,
    /selected_receipt\.action_scope_sha256 IS DISTINCT FROM expected_action_scope/,
  );
  assert.match(body, /Founder pilot evidence command key conflict/);
  assert.match(body, /RETURN QUERY SELECT 'replayed'::text/);
  assert.match(body, /RETURN QUERY SELECT 'recorded'::text/);
});

test('0065 keeps both identities away from the enqueue and each other', async () => {
  const sql = await migration();
  assert.match(sql, /The founder pilot evidence definer must never hold % on %/);
  assert.match(sql, /The founder pilot evidence identity must hold only its own recorder/);
  assert.match(sql, /REVOKE r72_founder_pilot_prep_definer FROM r72_founder_pilot_evidence_definer/);
  assert.match(sql, /REVOKE r72_founder_pilot_evidence_definer FROM r72_founder_pilot_prep_definer/);
  // Exactly one grant reaches the evidence identity, and it is its own function.
  const grants = sql.match(/GRANT[^;]*r72_founder_pilot_evidence_command/gu) ?? [];
  assert.equal(grants.length, 1);
  assert.match(grants[0] ?? '', /GRANT EXECUTE ON FUNCTION app_private\.record_founder_pilot_compliance_evidence/);
  assert.match(sql, new RegExp(
    `GRANT EXECUTE ON FUNCTION app_private\\.prepare_founder_email_pilot_content`
    + `\\( ${PREPARE_SIGNATURE} \\) TO r72_crm_command`,
  ));
});

test('0065 never records consent, releases a suppression or edits history', async () => {
  const sql = await migration();
  for (const name of [
    'prepare_founder_email_pilot_content', 'record_founder_pilot_compliance_evidence',
  ]) {
    const body = bodyOf(sql, name);
    assert.doesNotMatch(body, /INSERT INTO app\.communication_consent_events/, name);
    assert.doesNotMatch(body, /INSERT INTO app\.communication_suppression_events/, name);
    assert.doesNotMatch(body, /DELETE FROM/, name);
  }
  // Both receipt ledgers are append-only.
  assert.match(sql, /Founder pilot receipts are append-only/);
  assert.match(
    sql,
    /CREATE TRIGGER founder_pilot_preparation_receipts_immutable BEFORE UPDATE OR DELETE/,
  );
  assert.match(
    sql,
    /CREATE TRIGGER founder_pilot_evidence_receipts_immutable BEFORE UPDATE OR DELETE/,
  );
  // And no applied migration is edited: 0065 adds, it does not alter history.
  assert.doesNotMatch(sql, /DROP FUNCTION|DROP TABLE|ALTER TABLE app\.contact_points/);
});
