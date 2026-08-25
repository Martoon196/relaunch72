import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const coreUrl = new URL(
  '../../src/db/migrations/0022_provider_operations_and_inbox_core.sql',
  import.meta.url,
);
const dispatchUrl = new URL(
  '../../src/db/migrations/0023_provider_operation_dispatch.sql',
  import.meta.url,
);

function normalise(sql: string): string {
  return sql.replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ').trim();
}

test('0022 creates workspace-composite inbox, immutable versions, approvals and delivery intents', async () => {
  const sql = normalise(await readFile(coreUrl, 'utf8'));
  for (const table of [
    'provider_connections', 'channel_endpoints', 'inboxes', 'conversations',
    'messages', 'message_versions', 'message_approval_requests',
    'message_approval_decisions', 'provider_operations', 'message_deliveries',
    'provider_operation_attempts', 'provider_operation_receipts',
  ]) {
    assert.match(sql, new RegExp(`CREATE TABLE app\\.${table}`));
    assert.match(sql, new RegExp(`'app', '${table}', 'workspace_id'`));
  }
  assert.match(sql, /UNIQUE \(workspace_id, conversation_id, id\)/);
  assert.match(sql, /messages_current_version_exact_fk/);
  assert.match(sql, /DEFERRABLE INITIALLY DEFERRED/);
  assert.match(sql, /body_sha256 bytea GENERATED ALWAYS AS/);
  assert.match(sql, /FOREIGN KEY \( workspace_id, conversation_id, message_id, message_version_id, version_number, body_sha256 \) REFERENCES app\.message_versions/);
  assert.match(sql, /FOREIGN KEY \( workspace_id, conversation_id, message_id, message_version_id, approval_request_id, approval_decision_id, version_number, body_sha256, approval_decision \) REFERENCES app\.message_approval_decisions/);
  assert.match(sql, /FOREIGN KEY \(workspace_id, provider_operation_id, message_delivery_id\) REFERENCES app\.message_deliveries/);
  assert.match(sql, /provider_operations_exact_delivery_fk FOREIGN KEY \(workspace_id, id, message_delivery_id\) REFERENCES app\.message_deliveries/);
  assert.doesNotMatch(sql, /REFERENCES app\.company_content_/);
  assert.match(sql, /source_content_version_ref text/);
  assert.match(sql, /source_content_approval_ref text/);
});

test('0022 forces RLS and grants no direct runtime settlement or immutable mutation', async () => {
  const sql = normalise(await readFile(coreUrl, 'utf8'));
  assert.match(sql, /ALTER TABLE app\.%I ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /ALTER TABLE app\.%I FORCE ROW LEVEL SECURITY/);
  assert.match(sql, /BEFORE UPDATE OR DELETE ON app\.%I/);
  assert.match(sql, /command_name LIKE 'inbox\.%'/);
  assert.match(sql, /provider_id = 'test_conversation'/);
  assert.match(sql, /environment = 'test'/);
  assert.match(sql, /[[]\+]447700900\[0-9\]\{3\}/);
  assert.ok(sql.includes('[.]invalid'));
  assert.doesNotMatch(sql, /GRANT UPDATE ON app\.provider_operations[^;]*TO r72_worker/);
  assert.doesNotMatch(sql, /GRANT INSERT ON app\.provider_operation_attempts[^;]*TO r72_worker/);
  assert.doesNotMatch(sql, /GRANT INSERT ON app\.provider_operation_receipts[^;]*TO r72_crm_command/);
  assert.doesNotMatch(sql, /FOR SELECT TO r72_worker/);
  assert.doesNotMatch(sql, /GRANT SELECT[^;]*TO r72_web, r72_crm_command, r72_worker/);
  assert.match(sql, /unsafe direct worker read capability on/);
});

test('0022 re-checks exact current consent, endpoint digest and approval before queueing', async () => {
  const sql = normalise(await readFile(coreUrl, 'utf8'));
  const guard = /CREATE FUNCTION app_private\.guard_message_delivery_insert\(\)(.*?)\$function\$;/.exec(sql)?.[1];
  assert.ok(guard);
  assert.match(guard, /decision\.message_version_id = message\.current_version_id/);
  assert.match(guard, /decision\.body_sha256 = message\.current_body_sha256/);
  assert.match(guard, /message\.contact_id = NEW\.contact_id/);
  assert.match(guard, /NEW\.endpoint_identity_sha256 := public\.digest/);
  assert.match(guard, /latest_consent IS DISTINCT FROM NEW\.consent_event_id/);
  assert.match(guard, /consent\.state = 'granted'/);
  assert.match(guard, /suppression\.state = 'suppressed'/);
});

test('0023 uses an isolated no-login definer and function-only worker surface', async () => {
  const sql = normalise(await readFile(dispatchUrl, 'utf8'));
  assert.match(sql, /CREATE ROLE r72_provider_operation_definer NOLOGIN NOINHERIT/);
  assert.match(sql, /NOT rolbypassrls/);
  assert.match(sql, /REVOKE ALL ON ALL TABLES IN SCHEMA app FROM r72_provider_operation_definer/);
  assert.match(sql, /CREATE FUNCTION app_private\.claim_provider_operations/);
  assert.match(sql, /CREATE FUNCTION app_private\.load_test_provider_dispatch_payload/);
  assert.match(sql, /CREATE FUNCTION app_private\.mark_provider_operation_calling/);
  assert.match(sql, /CREATE FUNCTION app_private\.renew_provider_operation_lease/);
  assert.match(sql, /CREATE FUNCTION app_private\.cancel_provider_operation_before_call/);
  assert.match(sql, /CREATE FUNCTION app_private\.settle_provider_operation/);
  assert.match(sql, /CREATE FUNCTION app_private\.record_test_provider_delivery_receipt/);
  assert.equal((sql.match(/SECURITY DEFINER/g) ?? []).length, 7);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION app_private\.claim_provider_operations\([^;]*\) TO r72_worker/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION app_private\.load_test_provider_dispatch_payload\([^;]*\) TO r72_worker/);
  assert.match(sql, /record_test_provider_delivery_receipt\([^;]*\) TO r72_crm_command/);
  assert.doesNotMatch(sql, /GRANT (?:INSERT|UPDATE|DELETE)[^;]*app\.(?:provider_operations|message_deliveries|provider_operation_attempts)[^;]*TO r72_worker/);

  const payload = /CREATE FUNCTION app_private\.load_test_provider_dispatch_payload\((.*?)\$function\$;/.exec(sql)?.[1];
  assert.ok(payload);
  assert.match(payload, /operation\.lease_token_hash = p_lease_token_hash/);
  assert.match(payload, /operation\.lease_version = p_lease_version/);
  assert.match(payload, /attempt\.worker_id = p_worker_id/);
  assert.match(payload, /attempt\.attempt_kind = 'dispatch'/);
  assert.match(payload, /connection\.provider_id = 'test_conversation'/);
  assert.match(payload, /operation\.environment = 'test'/);
  assert.match(payload, /latest_consent_id = evaluated\.consent_event_id/);
  assert.match(payload, /eligibility_status/);
});

test('0023 fences calling, makes expiry ambiguous and never auto-requeues it', async () => {
  const sql = normalise(await readFile(dispatchUrl, 'utf8'));
  assert.match(sql, /attempt\.state = 'calling'/);
  assert.match(sql, /error_code = 'ambiguous_lease_expiry'/);
  assert.match(sql, /state = 'reconciliation_required'/);
  assert.match(sql, /operation\.state = 'leased' AND operation\.lease_expires_at <= statement_timestamp\(\)/);
  assert.match(sql, /selected_attempt_kind/);
  assert.match(sql, /THEN 'reconcile' ELSE 'dispatch'/);
  assert.match(sql, /operation\.state = 'reconciliation_required' AND operation\.provider_reference IS NOT NULL/);
  assert.match(sql, /operation\.lease_token_hash = p_lease_token_hash/);
  assert.match(sql, /operation\.lease_version = p_lease_version/);
  assert.match(sql, /operation\.lease_expires_at > statement_timestamp\(\)/);
  const markCalling = /CREATE FUNCTION app_private\.mark_provider_operation_calling\((.*?)\$function\$;/.exec(sql)?.[1];
  assert.ok(markCalling);
  assert.match(markCalling, /delivery\.endpoint_identity_sha256 = public\.digest/);
  assert.match(markCalling, /consent\.state = 'granted'/);
  assert.match(markCalling, /current_suppression\.state = 'suppressed'/);
  assert.ok(markCalling.indexOf('consent changed before call') < markCalling.indexOf("SET state = 'calling'"));
  assert.doesNotMatch(sql, /state = 'retry_wait'[^;]*ambiguous_lease_expiry/);

  const claim = /CREATE FUNCTION app_private\.claim_provider_operations\((.*?)\$function\$;/.exec(sql)?.[1];
  assert.ok(claim);
  const expirySweeps = claim.slice(0, claim.indexOf('RETURN QUERY'));
  assert.equal((expirySweeps.match(/connection\.provider_id = 'test_conversation'/g) ?? []).length, 6);
  assert.equal((expirySweeps.match(/connection\.environment = 'test'/g) ?? []).length, 6);
  assert.equal((expirySweeps.match(/connection\.status = 'active'/g) ?? []).length, 6);
  assert.equal((expirySweeps.match(/operation\.environment = 'test'/g) ?? []).length, 6);
});

test('0023 emits only identifiers and normalized status in durable audit events', async () => {
  const sql = normalise(await readFile(dispatchUrl, 'utf8'));
  const settlement = /CREATE FUNCTION app_private\.settle_provider_operation\((.*?)\$function\$;/.exec(sql)?.[1];
  assert.ok(settlement);
  assert.match(settlement, /'operationId', p_operation_id/);
  assert.match(settlement, /'deliveryId', selected_delivery\.id/);
  assert.match(settlement, /'messageId', selected_delivery\.message_id/);
  assert.match(settlement, /'providerId', 'test_conversation'/);
  assert.doesNotMatch(settlement, /body_text|normalized_value|recipient|request\.text|provider_payload|raw_body/);
  assert.match(sql, /test provider receipt replay conflict/);
  assert.match(sql, /payload_sha256 IS DISTINCT FROM p_payload_sha256/);
});

test('0022 uses executable immutable digests and places the required delivery key on operations', async () => {
  const sql = normalise(await readFile(coreUrl, 'utf8'));
  const versions = /CREATE TABLE app\.message_versions \((.*?)\); CREATE TABLE/.exec(sql)?.[1];
  assert.ok(versions);
  assert.match(
    versions,
    /body_sha256 bytea GENERATED ALWAYS AS \( public\.digest\(body_text, 'sha256'\) \) STORED/,
  );
  assert.doesNotMatch(versions, /convert_to\(body_text/);

  const operations = /CREATE TABLE app\.provider_operations \((.*?)\); CREATE INDEX/.exec(sql)?.[1];
  assert.ok(operations);
  assert.match(operations, /message_delivery_id uuid NOT NULL/);
  assert.match(operations, /UNIQUE \(workspace_id, id, message_delivery_id\)/);

  const repository = normalise(await readFile(
    new URL('../../src/inbox-pg/repository.ts', import.meta.url),
    'utf8',
  ));
  const insertOperation = /\/\* inbox\.insert-provider-operation \*\/(.*?)\/\* inbox\.insert-message-delivery \*\//.exec(repository)?.[1];
  assert.ok(insertOperation);
  assert.match(insertOperation, /INSERT INTO app\.provider_operations \([^)]*message_delivery_id/);
  assert.match(insertOperation, /\$3, 'test', 'queued'/);
});

test('0021-0023 terminate every PL/pgSQL function and anonymous block', async () => {
  for (const migrationUrl of [
    new URL('../../src/db/migrations/0021_company_content_versions_and_approvals.sql', import.meta.url),
    coreUrl,
    dispatchUrl,
  ]) {
    const sql = await readFile(migrationUrl, 'utf8');
    const label = migrationUrl.pathname.split('/').at(-1)!;
    const functions = [...sql.matchAll(
      /CREATE FUNCTION app_private\.([a-z0-9_]+)\([^]*?AS \$function\$([^]*?)\$function\$;/g,
    )];
    assert.ok(functions.length > 0, `${label} should expose PL/pgSQL functions`);
    for (const match of functions) {
      assert.match(match[2]!, /\bEND;\s*$/, `${label}:${match[1]} must end with END;`);
    }
    for (const match of sql.matchAll(/DO \$([a-z0-9_]+)\$([^]*?)\$\1\$;/g)) {
      assert.match(match[2]!, /\bEND;\s*$/, `${label}:${match[1]} must end with END;`);
    }
  }
});

test('0022 and 0023 parenthesize CASE values at comparison boundaries', async () => {
  const core = normalise(await readFile(coreUrl, 'utf8'));
  assert.match(core, /point_kind IS DISTINCT FROM \(CASE NEW\.consent_channel .*? END\) THEN/);

  const dispatch = normalise(await readFile(dispatchUrl, 'utf8'));
  assert.match(
    dispatch,
    /point\.kind = \(CASE delivery\.consent_channel .*? ELSE 'social' END\)/,
  );
});

test('0022 append-only facts are trigger-locked without granting mutation', async () => {
  const sql = normalise(await readFile(coreUrl, 'utf8'));
  const triggerBlock = /DO \$append_only_triggers\$(.*?)\$append_only_triggers\$;/.exec(sql)?.[1];
  assert.ok(triggerBlock);
  for (const table of [
    'message_versions',
    'message_approval_requests',
    'message_approval_decisions',
    'provider_operation_receipts',
  ]) assert.ok(triggerBlock.includes(`'${table}'`));
  assert.match(triggerBlock, /BEFORE UPDATE OR DELETE ON app\.%I/);
  assert.doesNotMatch(sql, /GRANT (?:UPDATE|DELETE)[^;]*ON app\.(?:message_versions|message_approval_requests|message_approval_decisions|provider_operation_receipts)/);
});

test('0023 claims and returns the new fenced lease values with qualified RETURNING targets', async () => {
  const sql = normalise(await readFile(dispatchUrl, 'utf8'));
  const claim = /CREATE FUNCTION app_private\.claim_provider_operations\((.*?)\$function\$;/.exec(sql)?.[1];
  assert.ok(claim);
  assert.match(claim, /lease_version = operation\.lease_version \+ 1/);
  assert.match(claim, /RETURNING operation\.\*, candidates\.selected_attempt_kind/);
  assert.match(claim, /claimed\.attempt_count, p_worker_id, claimed\.lease_version/);
  assert.match(claim, /RETURNING inserted_attempt\.workspace_id, inserted_attempt\.provider_operation_id, inserted_attempt\.attempt_number, inserted_attempt\.lease_version/);
  assert.match(claim, /attempts\.lease_version, operation\.lease_expires_at/);

  assert.match(sql, /RETURNING operation\.lease_expires_at INTO renewed_until/);
  const receiptInsert = /INSERT INTO app\.provider_operation_receipts AS ([a-z_]+)(.*?)RETURNING \1\.id INTO inserted_id/.exec(sql);
  assert.ok(receiptInsert, 'receipt INSERT and RETURNING must use the same explicit target alias');
  assert.match(sql, /RETURNING delivery\.status INTO selected_status/);
});
