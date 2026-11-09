import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migrationUrl = new URL(
  '../../src/db/migrations/0097_property_predator_zernio_calendar_safe_cutover.sql',
  import.meta.url,
);

async function sql(): Promise<string> {
  return (await readFile(migrationUrl, 'utf8'))
    .replace(/--[^\n]*/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function splitPostgresStatements(source: string): string[] {
  type State = 'normal' | 'line-comment' | 'block-comment' | 'single-quote' |
    'double-quote' | 'dollar-quote';
  const statements: string[] = [];
  let state: State = 'normal';
  let dollarTag = '';
  let blockDepth = 0;
  let start = 0;
  let index = 0;

  while (index < source.length) {
    const current = source[index];
    const next = source[index + 1];
    if (state === 'line-comment') {
      if (current === '\n') state = 'normal';
      index += 1;
      continue;
    }
    if (state === 'block-comment') {
      if (current === '/' && next === '*') {
        blockDepth += 1;
        index += 2;
      } else if (current === '*' && next === '/') {
        blockDepth -= 1;
        index += 2;
        if (blockDepth === 0) state = 'normal';
      } else {
        index += 1;
      }
      continue;
    }
    if (state === 'single-quote') {
      if (current === "'" && next === "'") index += 2;
      else if (current === "'") {
        state = 'normal';
        index += 1;
      } else index += 1;
      continue;
    }
    if (state === 'double-quote') {
      if (current === '"' && next === '"') index += 2;
      else if (current === '"') {
        state = 'normal';
        index += 1;
      } else index += 1;
      continue;
    }
    if (state === 'dollar-quote') {
      if (source.startsWith(dollarTag, index)) {
        index += dollarTag.length;
        dollarTag = '';
        state = 'normal';
      } else index += 1;
      continue;
    }

    if (current === '-' && next === '-') {
      state = 'line-comment';
      index += 2;
    } else if (current === '/' && next === '*') {
      state = 'block-comment';
      blockDepth = 1;
      index += 2;
    } else if (current === "'") {
      state = 'single-quote';
      index += 1;
    } else if (current === '"') {
      state = 'double-quote';
      index += 1;
    } else if (current === '$') {
      const matchedTag = /^(?:\$[A-Za-z_][A-Za-z0-9_]*\$|\$\$)/u.exec(
        source.slice(index),
      )?.[0];
      if (matchedTag) {
        dollarTag = matchedTag;
        state = 'dollar-quote';
        index += matchedTag.length;
      } else index += 1;
    } else if (current === ';') {
      const statement = source.slice(start, index).trim();
      if (statement) statements.push(statement);
      start = index + 1;
      index += 1;
    } else index += 1;
  }

  assert.ok(
    state === 'normal' || state === 'line-comment',
    `unterminated PostgreSQL lexical state: ${state}${dollarTag ? ` ${dollarTag}` : ''}`,
  );
  assert.equal(blockDepth, 0, 'unterminated PostgreSQL block comment');
  const tail = source.slice(start).trim();
  if (tail) statements.push(tail);
  return statements;
}

test('0097 is a complete quote-aware PostgreSQL script with closed DO and function bodies', async () => {
  const source = (await readFile(migrationUrl, 'utf8')).replace(/\r\n?/gu, '\n');
  const statements = splitPostgresStatements(source);
  assert.equal(statements.length, 69);

  const roles = statements[0] ?? '';
  assert.match(roles, /\bDO \$roles\$/u);
  assert.match(roles, /END\s+\$roles\$$/u);
  assert.equal(roles.match(/\$roles\$/gu)?.length, 2);

  const functions = statements.filter((statement) =>
    /\bCREATE(?: OR REPLACE)? FUNCTION app_private\./u.test(statement),
  );
  assert.equal(functions.length, 5);
  for (const statement of functions) {
    assert.equal(statement.match(/\$function\$/gu)?.length, 2);
    assert.match(statement, /\$function\$$/u);
  }

  const audit = statements.at(-1) ?? '';
  assert.match(audit, /^DO \$cutover_audit\$/u);
  assert.match(audit, /END\s+\$cutover_audit\$$/u);
  assert.equal(audit.match(/\$cutover_audit\$/gu)?.length, 2);
  assert.ok(statements.every((statement) => !/^DECLARE\b/u.test(statement)));
});

test('0097 makes direct schedules immutable and revokes every direct mutation/probe', async () => {
  const source = await sql();
  assert.match(
    source,
    /CREATE TRIGGER property_predator_zernio_direct_schedules_immutable BEFORE UPDATE OR DELETE ON app\.property_predator_zernio_direct_schedules/u,
  );
  for (const signature of [
    'reserve_zernio_direct_schedule',
    'reserve_zernio_direct_schedule_v2',
    'settle_zernio_direct_schedule',
    'record_zernio_calendar_account_probe',
  ]) {
    assert.match(
      source,
      new RegExp(`REVOKE EXECUTE ON FUNCTION app_private\\.${signature}\\([\\s\\S]+?\\) FROM r72_zernio_social_command`, 'u'),
    );
  }
  assert.match(
    source,
    /NOT pg_catalog\.has_function_privilege\( 'r72_zernio_social_command', 'app_private\.list_zernio_direct_schedules\([^)]+\)', 'EXECUTE' \)/u,
  );
  assert.doesNotMatch(
    source,
    /(?:DELETE FROM|UPDATE) app\.property_predator_zernio_direct_schedules/u,
  );
});

test('0097 records an append-only exact TEST-to-LIVE promotion', async () => {
  const source = await sql();
  assert.match(
    source,
    /CREATE TABLE app\.property_predator_zernio_calendar_target_promotions/u,
  );
  assert.match(source, /test_environment text NOT NULL DEFAULT 'test'/u);
  assert.match(source, /live_environment text NOT NULL DEFAULT 'live'/u);
  assert.match(source, /test_account_ref_sha256 bytea NOT NULL/u);
  assert.match(source, /provider_account_id_sha256 bytea NOT NULL/u);
  assert.match(source, /connected_receipt_id uuid NOT NULL/u);
  assert.match(source, /publish_capability_evidence_sha256 bytea NOT NULL/u);
  assert.match(
    source,
    /FOREIGN KEY \( workspace_id, planning_intent_id, planning_target_id, test_provider_connection_id, network, test_environment, test_account_ref_sha256 \) REFERENCES app\.public_social_planning_intent_targets/u,
  );
  assert.match(
    source,
    /REFERENCES app\.property_predator_zernio_publish_bindings \( workspace_id, id, provider_connection_id, provider_id, network, zernio_account_id, provider_profile_id_sha256, provider_account_id_sha256, publish_capability_evidence_sha256, ownership_evidence_sha256 \)/u,
  );
  assert.match(
    source,
    /ALTER TABLE app\.property_predator_zernio_calendar_target_promotions FORCE ROW LEVEL SECURITY/u,
  );
  assert.match(
    source,
    /CREATE TRIGGER property_predator_zernio_calendar_target_promotions_immutable BEFORE UPDATE OR DELETE/u,
  );
  assert.match(
    source,
    /UNIQUE \(workspace_id, planning_intent_id, planning_target_id\)/u,
  );
});

test('0097 installs an explicit deterministic TEST bootstrap without migration-time provider effects', async () => {
  const source = await sql();
  const bootstrapStart = source.indexOf(
    'CREATE FUNCTION app_private.bootstrap_zernio_calendar_planner_target(',
  );
  const outerStart = source.indexOf(
    'CREATE OR REPLACE FUNCTION app_private.enqueue_zernio_calendar_from_connected_account(',
  );
  assert.ok(bootstrapStart > 0 && outerStart > bootstrapStart);
  const bootstrap = source.slice(bootstrapStart, outerStart);
  assert.match(source, /CREATE ROLE r72_zernio_calendar_bootstrap_definer NOLOGIN NOINHERIT/u);
  assert.match(bootstrap, /provider_id = 'public_social_dark_simulator'/u);
  assert.match(bootstrap, /provider_kind = 'social'/u);
  assert.match(bootstrap, /environment = 'test'/u);
  assert.match(bootstrap, /'\["social\.publish"\]'::jsonb/u);
  assert.match(
    bootstrap,
    /'test-account:' \|\| p_network \|\| ':' \|\| encode\(p_expected_provider_account_id_sha256, 'hex'\)/u,
  );
  const deterministicUuidFormats = source.match(
    /'5' \|\| substr\((?:seed_hex|selected_(?:connection|target)_seed), 14, 3\), '8' \|\| substr\((?:seed_hex|selected_(?:connection|target)_seed), 18, 3\)/gu,
  );
  assert.equal(deterministicUuidFormats?.length, 3);
  assert.doesNotMatch(
    source,
    /substr\((?:seed_hex|selected_(?:connection|target)_seed), 13, 4\), substr\((?:seed_hex|selected_(?:connection|target)_seed), 17, 4\)/u,
  );
  assert.match(bootstrap, /current_setting\('transaction_isolation'\) IS DISTINCT FROM 'serializable'/u);
  assert.match(bootstrap, /connected\.event_type = 'account\.connected'/u);
  assert.match(bootstrap, /disconnected\.event_type = 'account\.disconnected'/u);
  assert.match(bootstrap, /disconnected\.occurred_at >= connected\.occurred_at/u);
  assert.match(
    source,
    /GRANT EXECUTE ON FUNCTION app_private\.register_test_social_campaign_target\([^)]+\) TO r72_zernio_calendar_bootstrap_definer/u,
  );
  assert.equal(source.match(/INSERT INTO app\.provider_connections/gu)?.length, 1);
  assert.ok(source.indexOf('INSERT INTO app.provider_connections') > bootstrapStart);
  assert.ok(source.indexOf('INSERT INTO app.provider_connections') < outerStart);
  assert.doesNotMatch(source.slice(0, bootstrapStart), /INSERT INTO app\.provider_connections/u);
  assert.doesNotMatch(source, /INSERT INTO app\.public_social_targets/u);
  assert.doesNotMatch(source, /migration-0097-zernio-planner-bootstrap/u);
  assert.doesNotMatch(source, /INSERT INTO app\.provider_operations/u);
  assert.doesNotMatch(source, /https?:\/\//u);
});

test('0097 repairs effective creator grants and permits only the exact non-effective Neon edge', async () => {
  const source = await sql();
  const ownerGrant = source.indexOf(
    'GRANT r72_zernio_calendar_bootstrap_definer TO r72_owner;',
  );
  const creatorMembershipRepair = source.indexOf(
    'SELECT pg_catalog.count(*)::integer INTO effective_creator_grants',
    ownerGrant,
  );
  const membershipAudit = source.indexOf(
    "SELECT member.rolname || '->' || parent.rolname INTO unsafe_membership",
    creatorMembershipRepair,
  );
  assert.ok(ownerGrant >= 0, 'bootstrap definer must be granted to r72_owner');
  assert.ok(
    creatorMembershipRepair > ownerGrant,
    'effective creator grants must be repaired after preserving the owner edge',
  );
  assert.ok(
    membershipAudit > creatorMembershipRepair,
    'bootstrap membership must be audited after the creator-grant repair',
  );
  const roleBoundary = source.slice(ownerGrant, membershipAudit);
  assert.match(
    roleBoundary,
    /'REVOKE r72_zernio_calendar_bootstrap_definer FROM %I GRANTED BY %I RESTRICT'/u,
  );
  assert.match(roleBoundary, /member\.oid = database_owner_oid/u);
  assert.match(roleBoundary, /grantor\.rolsuper/u);
  assert.match(roleBoundary, /membership\.admin_option/u);
  assert.match(roleBoundary, /NOT membership\.inherit_option/u);
  assert.match(
    roleBoundary,
    /\(pg_catalog\.to_jsonb\(membership\)->>'set_option'\)::boolean,\s*true\s*\) IS NOT TRUE/u,
  );
  assert.match(
    source.slice(membershipAudit, source.indexOf('$roles$;', membershipAudit)),
    /member\.rolname = 'r72_owner'\s*OR \(\s*member\.oid = database_owner_oid\s*AND grantor\.rolsuper\s*AND membership\.admin_option\s*AND NOT membership\.inherit_option/u,
  );
  assert.equal(
    source.match(/safe_creator_grants <> 1 OR owner_memberships <> 1/gu)?.length,
    2,
    'both role bootstrap and final cutover audit must require exactly one owner and one managed creator edge',
  );
  const finalAudit = source.slice(source.indexOf('DO $cutover_audit$'));
  assert.match(finalAudit, /unsafe_bootstrap_membership/u);
  assert.match(finalAudit, /grantor\.rolsuper/u);
  assert.match(finalAudit, /member\.oid = database_owner_oid/u);
});

test('0097 outer command creates or reuses promotion before the V2 inner enqueue', async () => {
  const source = await sql();
  const outerStart = source.indexOf(
    'CREATE OR REPLACE FUNCTION app_private.enqueue_zernio_calendar_from_connected_account(',
  );
  const innerStart = source.indexOf(
    'CREATE OR REPLACE FUNCTION app_private.enqueue_zernio_calendar_job(',
  );
  assert.ok(outerStart > 0 && innerStart > outerStart);
  const outer = source.slice(outerStart, innerStart);
  assert.match(outer, /INSERT INTO app\.property_predator_zernio_calendar_target_promotions/u);
  assert.match(outer, /propertypredator\.zernio-calendar-command\/v2/u);
  assert.match(outer, /propertypredator\.zernio-calendar-job\/v2/u);
  assert.match(outer, /selected_promotion_id/u);
  assert.match(outer, /selected_target\.test_account_ref_sha256/u);
  assert.match(outer, /selected_account\.provider_account_id_sha256/u);
  assert.match(
    outer,
    /registry\.test_account_ref = 'test-account:' \|\| p_network \|\| ':' \|\| encode\(selected_account\.provider_account_id_sha256, 'hex'\)/u,
  );
  assert.match(outer, /app_private\.enqueue_zernio_calendar_job\(/u);
});

test('0097 inner enqueue validates the same promotion hash and preserves approval, media and caps', async () => {
  const source = await sql();
  const innerStart = source.indexOf(
    'CREATE OR REPLACE FUNCTION app_private.enqueue_zernio_calendar_job(',
  );
  const inner = source.slice(innerStart);
  assert.match(inner, /promotion\.workspace_id, promotion\.id, promotion\.planning_intent_id/u);
  assert.match(inner, /propertypredator\.zernio-calendar-command\/v2/u);
  assert.match(inner, /propertypredator\.zernio-calendar-job\/v2/u);
  assert.match(inner, /decision\.decision = 'approved'/u);
  assert.match(inner, /media_decision\.decision = 'approved'/u);
  assert.match(inner, /media_attestation\.expires_at > statement_timestamp\(\)/u);
  assert.match(inner, /Zernio calendar hard publish cap reached/u);
  assert.match(inner, />= 1/u);
  assert.match(inner, />= 3/u);
  assert.doesNotMatch(
    inner,
    /target\.account_ref_sha256 = p_expected_provider_account_id_sha256/u,
  );

  const promotionContracts = source.match(
    /'propertypredator\.zernio-calendar-target-promotion\/v1'/gu,
  );
  assert.equal(promotionContracts?.length, 3);
  assert.match(
    source,
    /p_workspace_id, selected_promotion_id, p_planning_intent_id, p_planning_target_id/u,
  );
  assert.equal(
    source.match(
      /promotion\.workspace_id, promotion\.id, promotion\.planning_intent_id, promotion\.planning_target_id/gu,
    )?.length,
    2,
  );
});

test('0097 replaces worker effect readiness with the exact immutable promotion bridge', async () => {
  const source = await sql();
  const effectStart = source.indexOf(
    'CREATE OR REPLACE FUNCTION app_private.zernio_calendar_job_effect_ready(',
  );
  const aclStart = source.indexOf(
    'REVOKE ALL ON FUNCTION app_private.enqueue_zernio_calendar_job(',
    effectStart,
  );
  assert.ok(effectStart > 0 && aclStart > effectStart);
  const effect = source.slice(effectStart, aclStart);
  assert.match(effect, /app_private\.owned_social_job_effect_ready_v2\(p_workspace_id, p_job_id\)/u);
  assert.match(effect, /app_private\.zernio_calendar_binding_ready\(p_workspace_id, p_job_id\)/u);
  assert.match(effect, /JOIN app\.property_predator_zernio_calendar_target_promotions AS promotion/u);
  assert.match(effect, /promotion\.test_account_ref_sha256/u);
  assert.match(effect, /promotion\.provider_account_id_sha256/u);
  assert.match(
    effect,
    /registry\.test_account_ref = 'test-account:' \|\| job\.network \|\| ':' \|\| encode\(promotion\.provider_account_id_sha256, 'hex'\)/u,
  );
  assert.match(effect, /connected_receipt\.event_id = promotion\.connected_receipt_id/u);
  assert.match(effect, /disconnected\.occurred_at >= connected_receipt\.occurred_at/u);
  assert.match(effect, /property_predator_zernio_publish_binding_revocations AS revocation/u);
  assert.match(effect, /propertypredator\.zernio-calendar-target-promotion\/v1/u);
  assert.match(effect, /job\.idempotency_key_sha256 = public\.digest/u);
  assert.match(effect, /propertypredator\.zernio-calendar-command\/v2/u);
  assert.match(effect, /job\.request_sha256 = public\.digest/u);
  assert.match(effect, /propertypredator\.zernio-calendar-job\/v2/u);
  assert.doesNotMatch(
    effect,
    /(?:planned_target|target)\.account_ref_sha256 = binding\.provider_account_id_sha256/u,
  );
});

test('0097 creates cutover functions under the narrow definers before applying final ACLs', async () => {
  const source = await sql();
  const bootstrapRole = source.indexOf('SET LOCAL ROLE r72_zernio_calendar_bootstrap_definer');
  const bootstrapFunction = source.indexOf(
    'CREATE FUNCTION app_private.bootstrap_zernio_calendar_planner_target(',
  );
  const ownedRole = source.indexOf('SET LOCAL ROLE r72_owned_social_definer', bootstrapFunction);
  const outer = source.indexOf(
    'CREATE OR REPLACE FUNCTION app_private.enqueue_zernio_calendar_from_connected_account(',
  );
  const inner = source.indexOf(
    'CREATE OR REPLACE FUNCTION app_private.enqueue_zernio_calendar_job(',
  );
  const effect = source.indexOf(
    'CREATE OR REPLACE FUNCTION app_private.zernio_calendar_job_effect_ready(',
  );
  const explicitOwnedAclRole = source.indexOf(
    'RESET ROLE; SET LOCAL ROLE r72_owned_social_definer;',
    effect,
  );
  const finalAcl = source.indexOf(
    'REVOKE ALL ON FUNCTION app_private.enqueue_zernio_calendar_job(',
    effect,
  );
  const directRevoke = source.indexOf(
    'REVOKE EXECUTE ON FUNCTION app_private.settle_zernio_direct_schedule(',
    finalAcl,
  );
  const explicitProbeRole = source.indexOf(
    'SET LOCAL ROLE r72_zernio_social_definer;',
    directRevoke,
  );
  const probeRevoke = source.indexOf(
    'REVOKE EXECUTE ON FUNCTION app_private.record_zernio_calendar_account_probe(',
    explicitProbeRole,
  );
  assert.ok(
    bootstrapRole < bootstrapFunction &&
      bootstrapFunction < ownedRole &&
      ownedRole < outer &&
      outer < inner &&
      inner < effect &&
      effect < explicitOwnedAclRole &&
      explicitOwnedAclRole < finalAcl &&
      finalAcl < directRevoke &&
      directRevoke < explicitProbeRole &&
      explicitProbeRole < probeRevoke,
  );
  assert.match(
    source,
    /bootstrap_zernio_calendar_planner_target[^;]+::regprocedure::oid, 'r72_zernio_calendar_bootstrap_definer'::text/u,
  );
  assert.equal(
    source.match(/::regprocedure::oid, 'r72_owned_social_definer'::text/gu)?.length,
    7,
  );
  assert.match(
    source,
    /record_zernio_calendar_account_probe[^;]+::regprocedure::oid, 'r72_zernio_social_definer'::text/u,
  );
  assert.match(
    source,
    /JOIN pg_catalog\.pg_proc AS procedure ON procedure\.oid = expected\.function_oid JOIN pg_catalog\.pg_roles AS owner_role ON owner_role\.oid = procedure\.proowner WHERE owner_role\.rolname <> expected\.owner_name/u,
  );
  assert.doesNotMatch(
    source,
    /pg_get_userbyid\(\s*'app_private\.[^']+'::regprocedure::oid/u,
  );
  assert.doesNotMatch(
    source,
    /REVOKE ALL ON ALL FUNCTIONS IN SCHEMA app_private FROM r72_zernio_calendar_bootstrap_definer/u,
  );
  assert.match(
    source,
    /procedure\.oid NOT IN \( 'app_private\.bootstrap_zernio_calendar_planner_target\(uuid,uuid,text,bytea,bytea\)'::regprocedure::oid, 'app_private\.register_test_social_campaign_target\(uuid,uuid,uuid,text,text,text\)'::regprocedure::oid \) AND pg_catalog\.has_function_privilege\( 'r72_zernio_calendar_bootstrap_definer', procedure\.oid, 'EXECUTE' \)/u,
  );
  assert.match(source, /Zernio calendar bootstrap function ACL is unsafe/u);
});

test('0097 exposes a sanitized worker-job calendar projection and exact ACLs', async () => {
  const source = await sql();
  assert.match(
    source,
    /CREATE FUNCTION app_private\.list_zernio_calendar_jobs\( p_workspace_id uuid, p_from timestamptz, p_to timestamptz, p_limit integer \) RETURNS TABLE\( job_id uuid, network text, content_body text, scheduled_for timestamptz, state text, provider_external_id text, safe_code text, created_at timestamptz \)/u,
  );
  assert.match(source, /job\.provider_id = 'zernio'/u);
  assert.match(source, /LEFT JOIN LATERAL \( SELECT receipt\.safe_code/u);
  assert.match(source, /ORDER BY receipt\.recorded_at DESC/u);
  assert.match(
    source,
    /GRANT EXECUTE ON FUNCTION app_private\.list_zernio_calendar_jobs\([^)]+\) TO r72_zernio_social_command/u,
  );
  assert.match(
    source,
    /REVOKE EXECUTE ON FUNCTION app_private\.enqueue_zernio_calendar_job\([^)]+\) FROM r72_zernio_social_command/u,
  );
  assert.match(
    source,
    /REVOKE EXECUTE ON FUNCTION app_private\.zernio_calendar_job_effect_ready\( uuid, uuid \) FROM r72_zernio_social_command, r72_owned_social_worker_command/u,
  );
  assert.match(source, /Zernio calendar command login is not table-blind/u);
  assert.doesNotMatch(
    source,
    /GRANT (?:SELECT|INSERT|UPDATE|DELETE|TRUNCATE)[^;]+ TO r72_zernio_social_command/u,
  );
  assert.doesNotMatch(source, /(?:api[_ ]?key|bearer|authorization|credential|secret)/iu);
});
