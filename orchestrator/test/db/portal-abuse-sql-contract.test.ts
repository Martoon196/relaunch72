import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migrationUrl = new URL(
  '../../src/db/migrations/0036_portal_abuse_limits.sql',
  import.meta.url,
);

async function migration(): Promise<string> {
  return (await readFile(migrationUrl, 'utf8'))
    .replace(/--[^\n]*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

test('0036 creates a table-blind exact abuse command role and private definer', async () => {
  const sql = await migration();
  assert.match(sql, /\('r72_abuse_command', true\), \('r72_abuse_definer', false\)/);
  assert.match(sql, /CREATE ROLE %I %s NOINHERIT/);
  assert.match(sql, /NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls/);
  assert.match(sql, /REVOKE r72_owner, r72_security_definer FROM r72_abuse_command, r72_abuse_definer/);
  assert.match(sql, /member\.rolname IN \('r72_abuse_command', 'r72_abuse_definer'\)/);
  assert.match(sql, /GRANT r72_abuse_definer TO r72_owner/);
  assert.match(sql, /REVOKE ALL ON ALL TABLES IN SCHEMA app_private FROM r72_abuse_command, r72_abuse_definer/);
  assert.match(sql, /GRANT SELECT, INSERT, UPDATE, DELETE ON app_private\.portal_abuse_storage_state,[^;]+TO r72_abuse_definer/);
  assert.doesNotMatch(sql, /GRANT (?:SELECT|INSERT|UPDATE|DELETE|TRUNCATE)[^;]+TO r72_abuse_command/);
  assert.match(sql, /REVOKE CREATE ON SCHEMA app_private FROM r72_abuse_definer/);
  assert.match(sql, /Unsafe portal abuse capability: r72_abuse_command can access/);
});

test('0036 stores only allowlisted classes and fixed-size keyed evidence', async () => {
  const sql = await migration();
  const routeClasses = "'auth.login', 'auth.setup', 'auth.sso', 'read.overview', 'read.page', 'command'";
  const dimensions = "'source', 'source_daily', 'auth', 'account', 'account_daily', 'workspace', 'workspace_daily', 'route_account', 'route_workspace'";
  assert.ok(sql.includes(routeClasses));
  assert.ok(sql.includes(dimensions));
  assert.match(sql, /subject_hash bytea NOT NULL CHECK \(octet_length\(subject_hash\) = 32\)/);
  assert.match(sql, /evidence_hash bytea NOT NULL CHECK \(octet_length\(evidence_hash\) = 32\)/);
  assert.match(sql, /last_evidence_hash bytea NOT NULL CHECK \(octet_length\(last_evidence_hash\) = 32\)/);
  assert.match(sql, /reserved_cost integer NOT NULL CHECK \(reserved_cost BETWEEN 1 AND 100000\)/);
  assert.match(sql, /p_lease_hash IS NULL OR octet_length\(p_lease_hash\) <> 32/);
  assert.match(sql, /p_evidence_hash IS NULL OR octet_length\(p_evidence_hash\) <> 32/);
  assert.match(sql, /octet_length\(p_lease_hash\) <> 32/);
  assert.match(sql, /octet_length\(p_evidence_hash\) <> 32/);
  assert.doesNotMatch(sql, /\b(?:ip_address|email|user_agent|request_body|query_string|session_token|object_id)\b/i);
});

test('0036 enforces hard cardinality, expiry, and aggregate-retention bounds', async () => {
  const sql = await migration();
  assert.match(sql, /bucket_count BETWEEN 0 AND 100000/);
  assert.match(sql, /lease_count BETWEEN 0 AND 10000/);
  assert.match(sql, /denial_row_count BETWEEN 0 AND 100000/);
  assert.match(sql, /window_seconds BETWEEN 1 AND 86400/);
  assert.match(sql, /expires_at <= created_at \+ interval '30 seconds'/);
  assert.match(sql, /bucket\.last_seen_at <= v_now - interval '1 day'/);
  assert.match(sql, /denial\.last_denied_at <= v_now - interval '7 days'/);
  assert.match(sql, /LIMIT 64 FOR UPDATE/);
  assert.match(sql, /v_state\.bucket_count - v_reclaimable_buckets \+ v_missing_buckets > 100000/);
  assert.match(sql, /v_state\.lease_count - v_reclaimable_leases \+ v_lease_rows > 10000/);
  assert.match(sql, /IF v_state\.denial_row_count >= 100000 THEN/);
  assert.match(sql, /denial_count = denial\.denial_count \+ 1/);
  assert.match(sql, /PRIMARY KEY \( denied_minute, route_class, dimension_kind, subject_hash, denial_reason \)/);
});

test('0036 admission validates equal arrays and reserves every dimension atomically', async () => {
  const sql = await migration();
  assert.match(sql, /CREATE FUNCTION app_private\.admit_portal_abuse\( p_route_class text, p_dimension_kinds text\[\], p_subject_hashes bytea\[\], p_capacities integer\[\], p_window_seconds integer\[\], p_costs integer\[\], p_concurrency_limits integer\[\], p_lease_hash bytea, p_evidence_hash bytea \)/);
  assert.match(sql, /RETURNS TABLE \( allowed boolean, retry_after_seconds integer, lease_hash bytea \)/);
  assert.match(sql, /array_length\(p_subject_hashes, 1\) IS DISTINCT FROM v_length/);
  assert.match(sql, /array_length\(p_capacities, 1\) IS DISTINCT FROM v_length/);
  assert.match(sql, /array_length\(p_window_seconds, 1\) IS DISTINCT FROM v_length/);
  assert.match(sql, /array_length\(p_costs, 1\) IS DISTINCT FROM v_length/);
  assert.match(sql, /array_length\(p_concurrency_limits, 1\) IS DISTINCT FROM v_length/);
  assert.match(sql, /Portal abuse admission contains a duplicate dimension/);
  assert.match(sql, /SELECT state\.\* INTO STRICT v_state[^;]+FOR UPDATE/);
  assert.match(sql, /v_bucket\.tokens \+ \(v_elapsed_seconds \* p_capacities\[v_i\]::numeric \/ p_window_seconds\[v_i\]::numeric\)/);
  assert.match(sql, /count\(\*\)::integer, min\(lease\.expires_at\)/);
  assert.match(sql, /IF NOT v_all_allowed THEN[\s\S]+RETURN; END IF;[\s\S]+UPDATE app_private\.portal_abuse_buckets/);
  assert.match(sql, /tokens = v_available\[v_i\] - p_costs\[v_i\]/);
  assert.match(sql, /v_now \+ interval '30 seconds'/);
  assert.match(sql, /allowed := true; retry_after_seconds := 0; lease_hash := p_lease_hash/);
  assert.match(sql, /PRIMARY KEY \(dimension_kind, subject_hash\)/);
  assert.match(sql, /PRIMARY KEY \(lease_hash, dimension_kind, subject_hash\)/);
  assert.doesNotMatch(sql, /WHERE (?:bucket|lease)\.route_class = p_route_class/);

  const denialBranch = sql.indexOf('IF NOT v_all_allowed THEN');
  const admittedHousekeeping = sql.indexOf('DELETE FROM app_private.portal_abuse_buckets');
  const admittedLeaseHousekeeping = sql.indexOf('DELETE FROM app_private.portal_abuse_leases');
  assert.ok(denialBranch >= 0);
  assert.ok(admittedHousekeeping > denialBranch);
  assert.ok(admittedLeaseHousekeeping > denialBranch);
});

test('0036 denial and completion contracts are bounded and fail closed', async () => {
  const sql = await migration();
  assert.match(sql, /denial_reason IN \( 'rate', 'concurrency', 'storage' \)/);
  assert.match(sql, /retry_after_seconds BETWEEN 1 AND 86400/);
  assert.match(sql, /allowed := false; retry_after_seconds := v_retry_max; lease_hash := NULL/);
  assert.match(sql, /CREATE FUNCTION app_private\.complete_portal_abuse_lease\( p_lease_hash bytea, p_outcome text \)/);
  assert.match(sql, /p_outcome NOT IN \('success', 'auth_failure', 'service_error'\)/);
  assert.match(sql, /IF p_outcome IN \('success', 'service_error'\) THEN/);
  assert.match(sql, /bucket\.tokens \+ lease\.reserved_cost::numeric/);
  assert.match(sql, /lease\.dimension_kind = 'auth'/);
  assert.match(sql, /DELETE FROM app_private\.portal_abuse_leases AS lease WHERE lease\.lease_hash = p_lease_hash/);
  assert.match(sql, /RETURN true/);
});

test('0036 exposes only fixed-search-path functions and read-only readiness', async () => {
  const sql = await migration();
  assert.equal((sql.match(/SECURITY DEFINER SET search_path = pg_catalog/g) ?? []).length, 3);
  assert.match(sql, /CREATE FUNCTION app_private\.portal_abuse_ready\(\) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog/);
  assert.match(sql, /session_user = 'r72_abuse_command'/);
  assert.match(sql, /current_user = 'r72_abuse_definer'/);
  assert.match(sql, /migration\.filename = '0036_portal_abuse_limits\.sql'/);
  assert.match(sql, /state\.bucket_count = \( SELECT count\(\*\)::integer FROM app_private\.portal_abuse_buckets \)/);
  assert.match(sql, /REVOKE ALL ON FUNCTION app_private\.admit_portal_abuse\([^;]+\) FROM PUBLIC/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION app_private\.admit_portal_abuse\([^;]+\) TO r72_abuse_command/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION app_private\.complete_portal_abuse_lease\(bytea, text\) TO r72_abuse_command/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION app_private\.portal_abuse_ready\(\) TO r72_abuse_command/);

  const readinessBody = sql.match(
    /CREATE FUNCTION app_private\.portal_abuse_ready\(\)[\s\S]+?\$function\$;/,
  )?.[0];
  assert.ok(readinessBody);
  assert.doesNotMatch(
    readinessBody.replace(/'[^']*'/g, "''"),
    /\b(?:INSERT|UPDATE|DELETE|TRUNCATE)\b/,
  );
});
