import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migrationUrl = new URL(
  '../../src/db/migrations/0078_company_content_adapter_catalog_acl_repair.sql',
  import.meta.url,
);

function normalise(sql: string): string {
  return sql.replace(/--[^\n]*/gu, ' ').replace(/\s+/gu, ' ').trim();
}

test('0078 grants only the approval columns used by the adapter catalogue read', async () => {
  const sql = normalise(await readFile(migrationUrl, 'utf8'));
  assert.match(sql, /CREATE POLICY company_content_approval_requests_adapter_catalog_select ON app\.company_content_approval_requests FOR SELECT TO r72_content_adapter/);
  assert.match(sql, /CREATE POLICY company_content_approval_decisions_adapter_catalog_select ON app\.company_content_approval_decisions FOR SELECT TO r72_content_adapter/);
  assert.match(sql, /GRANT SELECT \( id, workspace_id, content_item_id, content_version_id, request_number \) ON app\.company_content_approval_requests TO r72_content_adapter/);
  assert.match(sql, /GRANT SELECT \( id, workspace_id, approval_request_id, decision \) ON app\.company_content_approval_decisions TO r72_content_adapter/);
  assert.match(sql, /has_active_workspace_membership\( app_private\.current_user_id\(\), workspace_id \)/);
  for (const forbidden of [
    'review_note', 'requested_by_user_id', 'requested_request_id',
    'decision_note', 'decided_by_user_id', 'decided_request_id',
  ]) {
    assert.match(sql, new RegExp(forbidden));
  }
  assert.match(sql, /private approval-request column %/);
  assert.match(sql, /private approval-decision column %/);
  assert.doesNotMatch(sql, /GRANT (?:INSERT|UPDATE|DELETE|TRUNCATE)/);
  assert.doesNotMatch(sql, /GRANT SELECT ON app\.company_content_approval/);
  assert.doesNotMatch(sql, /(?:publish|enqueue|schedule|worker_lease|claim_job)/iu);
});
