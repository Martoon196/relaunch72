import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  OWNED_PUBLIC_SOCIAL_DAILY_PUBLISH_CAP,
  OWNED_PUBLIC_SOCIAL_MONTHLY_PUBLISH_CAP,
} from '../../src/owned-public-social-pg/command-types.js';
import {
  OWNED_SOCIAL_DAILY_CAP,
  OWNED_SOCIAL_MONTHLY_CAP,
  OWNED_SOCIAL_MAX_POST_CHARACTERS,
} from '../../src/owned-social-activation/foundation.js';

const migration52Url = new URL(
  '../../src/db/migrations/0052_property_predator_owned_public_social_live_foundation.sql',
  import.meta.url,
);
const migration57Url = new URL(
  '../../src/db/migrations/0057_property_predator_live_channel_emergency_pause.sql',
  import.meta.url,
);
const migration59Url = new URL(
  '../../src/db/migrations/0059_property_predator_owned_social_activation_readiness.sql',
  import.meta.url,
);

function normalise(sql: string): string {
  return sql.replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ').trim();
}

test('0059 adds a read-only probe that cannot publish, enqueue or write', async () => {
  const sql = normalise(await readFile(migration59Url, 'utf8'));
  assert.match(
    sql,
    /CREATE FUNCTION app_private\.property_predator_owned_social_activation_readiness\(/,
  );
  assert.match(sql, /RETURNS TABLE \(dimension text, ready boolean, blocker_code text\)/);
  assert.match(sql, /LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog/);

  const probe = sql.slice(
    sql.indexOf('CREATE FUNCTION app_private.property_predator_owned_social_activation_readiness('),
    sql.indexOf('RESET ROLE'),
  );
  assert.ok(probe.length > 0, 'the probe body must be present');
  for (const mutation of [
    /\bINSERT INTO\b/, /\bUPDATE app\./, /\bDELETE FROM\b/, /\bTRUNCATE\b/,
    /\bnextval\b/, /\bFOR UPDATE\b/, /\bCOMMIT\b/,
  ]) {
    assert.doesNotMatch(probe, mutation,
      `the readiness probe must not contain ${String(mutation)}`);
  }
  assert.doesNotMatch(probe, /enqueue_owned_social_job/);
  assert.doesNotMatch(probe, /property_predator_owned_social_jobs \(/);
});

test('0059 keeps the probe behind the exact founder command identity', async () => {
  const sql = normalise(await readFile(migration59Url, 'utf8'));
  assert.match(sql, /session_user <> 'r72_owned_social_command'/);
  assert.match(sql, /current_setting\('app\.actor_kind', true\) IS DISTINCT FROM 'user'/);
  assert.match(sql, /current_setting\('app\.user_id', true\) !~ '\^\[0-9a-f-\]\{36\}\$'/);
  assert.match(sql, /RAISE EXCEPTION 'Owned social activation readiness denied' USING ERRCODE = '42501'/);
  assert.match(
    sql,
    /GRANT EXECUTE ON FUNCTION app_private\.property_predator_owned_social_activation_readiness\( uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, bytea, timestamptz \) TO r72_owned_social_command/,
  );
  assert.match(
    sql,
    /REVOKE ALL ON FUNCTION app_private\.property_predator_owned_social_activation_readiness\( uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, bytea, timestamptz \) FROM PUBLIC/,
  );
  assert.match(sql, /Unsafe owned-social activation readiness capability/);
  assert.match(sql, /REVOKE CREATE ON SCHEMA app_private FROM r72_owned_social_definer/);
});

test('0059 proves the owned account by digest and never returns it', async () => {
  const sql = normalise(await readFile(migration59Url, 'utf8'));
  assert.match(sql, /p_expected_owned_account_sha256 bytea/);
  assert.match(sql, /octet_length\(p_expected_owned_account_sha256\) <> 32/);
  assert.match(sql, /selected_account_sha = p_expected_owned_account_sha256/);
  assert.match(sql, /'OWNED_ACCOUNT_EVIDENCE_MISMATCH'/);
  assert.doesNotMatch(sql, /RETURNS TABLE \([^)]*account[^)]*\)/);
  assert.doesNotMatch(sql, /dimension := profile\./);
  assert.doesNotMatch(sql, /blocker_code := selected_body/);
});

test('0059 re-proves the exact evidence chain the command boundary enforces', async () => {
  const sql = normalise(await readFile(migration59Url, 'utf8'));
  const foundation = normalise(await readFile(migration52Url, 'utf8'));

  // Connection facts the rail-level truth does not re-assert.
  assert.match(sql, /connection\.provider_id = 'ayrshare'/);
  assert.match(sql, /connection\.provider_kind = 'social'/);
  assert.match(sql, /connection\.environment = 'live'/);
  assert.match(sql, /connection\.status = 'active'/);

  // Owned, non-revoked profile plus its ownership evidence.
  assert.match(sql, /property_predator_owned_social_profile_revocations/);
  assert.match(sql, /'IDENTITY_BINDING_REVOKED'/);
  assert.match(sql, /'IDENTITY_BINDING_REQUIRED'/);
  assert.match(sql, /selected_permissions = 'read_write'/);
  assert.match(sql, /'OWNERSHIP_EVIDENCE_REQUIRED'/);

  // Approval chain: request and decision pinned to the same content digest.
  assert.match(sql, /decision\.decision = 'approved'/);
  assert.match(sql, /request\.content_sha256 = version\.content_sha256/);
  assert.match(sql, /version\.content_kind = 'social_post'/);
  assert.match(sql, /public\.digest\(version\.content_body, 'sha256'\) = version\.content_sha256/);
  assert.match(sql, /'APPROVED_CONTENT_REQUIRED'/);
  assert.match(sql, /'CONTENT_VERSION_SUPERSEDED'/);

  // Attestation freshness uses the same fifteen-minute fence as 0052.
  assert.match(sql, /attestation\.expires_at > selected_effect_at \+ interval '15 minutes'/);
  assert.match(foundation, /interval '15 minutes'/);
  assert.match(sql, /'SOURCE_ATTESTATION_EXPIRED'/);

  assert.match(sql, /membership\.role IN \('owner', 'admin'\)/);
  assert.match(sql, /'OPERATOR_AUTHORITY_REQUIRED'/);
  assert.match(sql, /pause\.scope IN \('all', 'owned_social'\)/);
  assert.match(sql, /'EMERGENCY_PAUSED'/);
});

test('0059 applies the exact X v1 publishable-text rules 0052 enforces', async () => {
  const sql = normalise(await readFile(migration59Url, 'utf8'));
  const foundation = normalise(await readFile(migration52Url, 'utf8'));
  const linkRule =
    /!~\* '\(\/\/\|\(\^\|\[\^A-Za-z\]\)\[A-Za-z\]\[A-Za-z0-9\+\.-\]\*:\|www\[\.\]\|\[A-Za-z0-9\]\[A-Za-z0-9-\]\{0,62\}\[\.\]\[A-Za-z\]\{2,63\}\)'/;
  // The probe must reject exactly what the command boundary rejects, so a
  // rehearsal can never pass where the real publication would be refused.
  assert.match(sql, linkRule);
  assert.match(foundation, linkRule);
  assert.match(sql, /~ '\^\[\\r\\n -~\]\+\$'/);
  assert.match(foundation, /~ '\^\[\\r\\n -~\]\+\$'/);
  assert.match(sql, /length\(selected_body\) BETWEEN 1 AND 280/);
  assert.match(sql, /'CONTENT_NOT_PUBLISHABLE'/);
  assert.equal(OWNED_SOCIAL_MAX_POST_CHARACTERS, 280);
});

test('the publish caps agree across the migration, the command types and the probe', async () => {
  const foundation = normalise(await readFile(migration52Url, 'utf8'));
  const sql = normalise(await readFile(migration59Url, 'utf8'));

  // 0052 counts per owned profile; nothing previously asserted that the
  // TypeScript constants still match the migration that enforces them.
  assert.match(foundation, /AND job\.state <> 'cancelled'\) >= 1/);
  assert.match(foundation, /AND job\.state <> 'cancelled'\) >= 3/);
  assert.equal(OWNED_PUBLIC_SOCIAL_DAILY_PUBLISH_CAP, 1);
  assert.equal(OWNED_PUBLIC_SOCIAL_MONTHLY_PUBLISH_CAP, 3);
  assert.equal(OWNED_SOCIAL_DAILY_CAP, OWNED_PUBLIC_SOCIAL_DAILY_PUBLISH_CAP);
  assert.equal(OWNED_SOCIAL_MONTHLY_CAP, OWNED_PUBLIC_SOCIAL_MONTHLY_PUBLISH_CAP);

  assert.match(sql, /job\.profile_id = p_profile_id/);
  assert.match(
    sql,
    new RegExp(`daily_used < ${OWNED_SOCIAL_DAILY_CAP} AND monthly_used < ${OWNED_SOCIAL_MONTHLY_CAP}`),
  );
  assert.match(sql, /'CAP_REACHED'/);
});

test('0059 surfaces missing approved content through the existing typed contract', async () => {
  const sql = normalise(await readFile(migration59Url, 'utf8'));
  const paused = normalise(await readFile(migration57Url, 'utf8'));

  assert.match(sql, /CREATE OR REPLACE FUNCTION app_private\.property_predator_live_channel_truth\(\)/);
  assert.match(sql, /truth\.rail = 'owned_social'/);
  assert.match(sql, /'APPROVED_CONTENT_REQUIRED'/);

  // The 0058 WhatsApp evidence and the 0057 pause evidence must both survive.
  assert.match(sql, /truth\.rail = 'whatsapp'/);
  assert.match(sql, /'TEMPLATE_REQUIRED'/);
  assert.match(sql, /pause\.scope IN \('all', truth\.rail\)/);
  assert.match(sql, /truth\.rail <> 'social_dm' AND EXISTS/);
  assert.match(sql, /FROM app_private\.property_predator_live_channel_truth_unpaused\(\) AS truth/);
  assert.match(paused, /FROM app_private\.property_predator_live_channel_truth_unpaused\(\) AS truth/);

  // Cap, state and receipt truth pass through untouched.
  for (const column of [
    'truth\\.daily_used', 'truth\\.daily_limit', 'truth\\.monthly_used',
    'truth\\.monthly_limit', 'truth\\.connection_state', 'truth\\.inbound_state',
    'truth\\.outbound_or_reply_state', 'truth\\.receipt_state',
    'truth\\.latest_receipt_id', 'truth\\.latest_receipt_outcome',
    'truth\\.latest_receipt_at', 'truth\\.latest_receipt_evidence_sha256',
  ]) {
    assert.match(sql, new RegExp(column));
  }
  assert.match(sql, /GRANT EXECUTE ON FUNCTION app_private\.property_predator_live_channel_truth\(\) TO r72_web/);
  assert.doesNotMatch(sql, /GRANT EXECUTE ON FUNCTION app_private\.property_predator_live_channel_truth_unpaused/);
});

test('0059 gives the truth definer column-scoped content reads only', async () => {
  const sql = normalise(await readFile(migration59Url, 'utf8'));

  // It must learn that an approved social post exists without being able to
  // read post bodies, titles, metadata or reviewer notes.
  assert.match(
    sql,
    /GRANT SELECT \(workspace_id, id, content_item_id, content_kind, version_number\) ON app\.company_content_versions TO r72_operational_inbox_definer/,
  );
  assert.match(
    sql,
    /GRANT SELECT \(workspace_id, content_item_id, content_version_id, decision\) ON app\.company_content_approval_decisions TO r72_operational_inbox_definer/,
  );
  assert.doesNotMatch(sql, /GRANT SELECT ON app\.company_content_versions/);
  assert.doesNotMatch(sql, /GRANT SELECT ON app\.company_content_approval_decisions/);
  assert.match(sql, /content_kind = 'social_post'/);
  assert.match(sql, /decision = 'approved'/);
  assert.match(sql, /Live channel truth must not read company content column/);
  assert.match(sql, /Live channel truth must not read approval decision notes/);
  for (const column of ['content_body', 'title', 'metadata', 'decision_note']) {
    assert.match(sql, new RegExp(`'${column}'`));
  }

  // Every added read stays tenant scoped and portal-user scoped.
  const policies = sql.match(
    /CREATE POLICY [a-z0-9_]+ ON [a-z0-9_.]+ FOR SELECT TO [a-z0-9_]+ USING \([^;]*?\)(?= ;|;)/g,
  ) ?? [];
  assert.ok(policies.length >= 3, 'each new read must be tenant scoped');
  for (const policy of policies) {
    assert.match(policy, /workspace_id = nullif\(current_setting\('app\.workspace_id', true\), ''\)::uuid/);
  }
  assert.match(sql, /REVOKE CREATE ON SCHEMA app_private FROM r72_operational_inbox_definer/);
});
