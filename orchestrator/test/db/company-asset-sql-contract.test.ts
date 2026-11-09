import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migrationUrl = new URL(
  '../../src/db/migrations/0033_property_predator_company_asset_foundation.sql',
  import.meta.url,
);

function normalise(sql: string): string {
  return sql.replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ').trim();
}

async function migration(): Promise<string> {
  return normalise(await readFile(migrationUrl, 'utf8'));
}

const TABLES = [
  'company_asset_releases',
  'company_asset_release_items',
  'company_asset_source_attestations',
  'company_asset_eval_reports',
  'company_asset_eval_cases',
  'company_asset_founder_approvals',
  'company_asset_quarantine_decisions',
  'company_asset_reconciliations',
] as const;

test('0033 creates private immutable manager-only workspace facts with forced RLS', async () => {
  const sql = await migration();
  for (const table of TABLES) {
    assert.match(sql, new RegExp(`CREATE TABLE app_private\\.${table}`));
    assert.match(sql, new RegExp(`'${table}'`));
  }
  assert.match(sql, /ALTER TABLE app_private\.%I ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /ALTER TABLE app_private\.%I FORCE ROW LEVEL SECURITY/);
  assert.match(sql, /company_asset_releases[\s\S]+workspace_id uuid NOT NULL REFERENCES app\.workspaces/);
  assert.match(sql, /FOREIGN KEY \(workspace_id, recorded_by_user_id\) REFERENCES app\.workspace_memberships/);
  assert.match(sql, /app_private\.can_manage_workspace\( app_private\.current_user_id\(\), workspace_id \)/);
  assert.match(sql, /reject_company_asset_mutation/);
  assert.match(sql, /BEFORE UPDATE OR DELETE/);
  assert.match(sql, /NEW\.recorded_at := statement_timestamp\(\)/);
  assert.match(sql, /workspace_table_registry/);
  assert.doesNotMatch(sql, /CREATE TABLE app\.company_asset/);
});

test('0033 stores only exact immutable release/item metadata and the fixed effects-off generation contract', async () => {
  const sql = await migration();
  assert.match(sql, /release_id = 'property-predator\.company-content-growth-hq\/v1'/);
  assert.match(sql, /source_commit = 'b5986c94d0f8690236c9f290ba14b49cc978e887'/);
  for (const column of [
    'release_sha256', 'source_catalog_sha256', 'scope_sha256',
    'runtime_brand_sha256', 'brand_brain_package_sha256',
    'content_sha256', 'blob_sha256', 'brand_sha256',
  ]) assert.match(sql, new RegExp(`${column} bytea`));
  assert.match(sql, /generation_mode = 'simulated_draft_only'/);
  assert.match(sql, /ownership_mode = 'company_owned'/);
  for (const input of [
    'affiliate_input', 'session_input', 'customer_input',
    'customer_private_data_input', 'private_data_input',
    'raw_prompt_input', 'raw_knowledge_input',
  ]) assert.match(sql, new RegExp(`${input} = 'forbidden'`));
  for (const effect of ['model_calls', 'source_calls', 'provider_effects', 'publish_effects']) {
    assert.match(sql, new RegExp(`${effect} IS FALSE`));
  }
  assert.match(sql, /approval_expires_at timestamptz CHECK \(approval_expires_at IS NULL\)/);
  assert.match(sql, /approval_expiry_status = 'missing'/);
  assert.match(sql, /hq_use_status = 'review-required'/);
  assert.match(sql, /ownership_status = 'source-asserted-company-owned'/);
  assert.match(sql, /privacy_status = 'customer-private-data-forbidden'/);
  assert.match(sql, /quarantine_status = 'not-recorded-at-source'/);
  assert.match(sql, /source_approval_status = 'source-approved-exact-version'/);
  assert.match(sql, /content_resource_path = '\/api\/internal\/company-content\/versions\/' \|\| version_id/);
  assert.match(sql, /asset_resource_path = '\/api\/internal\/company-content\/assets\/' \|\| version_id \|\| '\/file'/);
  for (const forbiddenColumn of [
    /content_body\s/, /prompt_body\s/, /knowledge_body\s/, /customer_body\s/,
    /private_body\s/, /asset_bytes\s/, /legal_text\s/, /email_address\s/,
    /phone_number\s/, /provider_credential\s/,
  ]) assert.doesNotMatch(sql, forbiddenColumn);
});

test('0033 binds freshness, founder approval and every decision to exact release/item tuples', async () => {
  const sql = await migration();
  assert.match(sql, /company_asset_source_attestations[\s\S]+source_commit text NOT NULL/);
  assert.match(sql, /checked_at >= recorded_at - interval '5 minutes'/);
  assert.match(sql, /expires_at <= checked_at \+ interval '15 minutes'/);
  assert.match(sql, /source attestation requires the exact complete item projection/i);
  assert.match(sql, /company_asset_founder_approvals[\s\S]+approval_status = 'founder_approved'/);
  assert.match(sql, /approval_authority = 'growth_hq_founder'/);
  assert.match(sql, /hq_human_approval IS TRUE/);
  assert.match(sql, /approval_expires_at > approved_at/);
  assert.match(sql, /FOREIGN KEY \( workspace_id, source_release_id, release_sha256, source_catalog_sha256, scope_sha256, runtime_brand_sha256, brand_brain_package_sha256 \)/);
  assert.match(sql, /quarantine decision is not bound to the exact item tuple/i);
  assert.match(sql, /item_content_sha256 bytea NOT NULL/);
  assert.match(sql, /item_brand_sha256 bytea NOT NULL/);
  assert.match(sql, /evidence_sha256 bytea NOT NULL/);
});

test('0033 accepts only hash-only golden/rejected evaluation and allowlisted quarantine evidence', async () => {
  const sql = await migration();
  assert.match(sql, /runner_version = 'property-predator-company-asset-offline-eval\/v1'/);
  assert.match(sql, /case_kind IN \('golden', 'rejected'\)/);
  assert.match(sql, /dimension IN \('brand', 'avatar', 'claims', 'disclosure', 'visual_policy'\)/);
  assert.match(sql, /input_sha256 bytea NOT NULL/);
  assert.match(sql, /output_sha256 bytea NOT NULL/);
  assert.match(sql, /evidence_sha256 bytea NOT NULL/);
  assert.match(sql, /passed boolean GENERATED ALWAYS AS/);
  assert.match(sql, /count\(DISTINCT dimension \|\| ':' \|\| case_kind\) = 10/);
  assert.match(sql, /guard_company_asset_eval_case_insert/);
  assert.match(sql, /Company asset evaluation is sealed by reconciliation/);
  assert.match(sql, /Company asset evaluation cannot gain added cases/);
  assert.match(sql, /decision_dimension IN \('visual_policy', 'claim', 'asset'\)/);
  assert.match(sql, /decision_outcome IN \('clear', 'quarantined'\)/);
  for (const reason of [
    'visual_policy_match', 'visual_policy_conflict', 'claims_supported',
    'claims_unsubstantiated', 'no_claims_present',
    'asset_integrity_verified', 'asset_integrity_failed', 'no_asset_payload',
  ]) assert.match(sql, new RegExp(`'${reason}'`));
  assert.doesNotMatch(sql, /reason_code ~ '\^/);
});

test('0033 computes reconciliation authority and stays unusable on expiry/quarantine unknowns', async () => {
  const sql = await migration();
  assert.match(sql, /guard_company_asset_reconciliation_insert/);
  assert.match(sql, /Company asset reconciliation rejects changed, missing or unapproved scope/);
  assert.match(sql, /Company asset reconciliation rejects missing or added material/);
  assert.match(sql, /source_approval_status = 'unapproved'/);
  assert.match(sql, /approval_expiry_status = 'missing'/);
  assert.match(sql, /approval_expiry_status = 'unknown'/);
  assert.match(sql, /quarantine_status IN \('not-recorded-at-source', 'unknown'\)/);
  assert.match(sql, /'source_approval_expiry_missing'/);
  assert.match(sql, /'source_quarantine_unknown'/);
  assert.match(sql, /'source_attestation_missing_or_expired'/);
  assert.match(sql, /'evaluation_missing_or_failed'/);
  assert.match(sql, /'quarantine_decision_missing'/);
  assert.match(sql, /NEW\.usable := expected_status = 'reconciled' AND cardinality\(usability_reasons\) = 0 AND cardinality\(guard_reasons\) = 0/);
  assert.doesNotMatch(sql, /NEW\.usable := COALESCE/);
  assert.match(sql, /'company-asset-release:' \|\| NEW\.workspace_id::text/);
  assert.match(sql, /'company-asset-eval:' \|\| NEW\.workspace_id::text/);
});

test('0033 preserves staging/decision role separation and grants no web/provider/worker capability', async () => {
  const sql = await migration();
  assert.match(sql, /FOR INSERT TO r72_content_adapter/);
  assert.match(sql, /FOR INSERT TO r72_content_command/);
  assert.match(sql, /company_asset_founder_approvals', 'company_asset_quarantine_decisions/);
  assert.match(sql, /company_asset_releases', 'company_asset_release_items'/);
  assert.match(sql, /has_table_privilege\('r72_web', 'app_private\.' \|\| table_name, 'SELECT'\)/);
  assert.match(sql, /has_table_privilege\('r72_content_adapter', 'app\.provider_operations', 'INSERT'\)/);
  assert.match(sql, /has_table_privilege\('r72_content_command', 'app\.provider_operations', 'INSERT'\)/);
  assert.match(sql, /pg_has_role\('r72_content_adapter', 'r72_worker', 'MEMBER'\)/);
  assert.match(sql, /pg_has_role\('r72_content_command', 'r72_worker', 'MEMBER'\)/);
  assert.match(sql, /pg_has_role\('r72_content_adapter', 'r72_content_command', 'MEMBER'\)/);
  assert.match(sql, /pg_has_role\('r72_content_command', 'r72_content_adapter', 'MEMBER'\)/);
  assert.doesNotMatch(sql, /GRANT (?:SELECT|INSERT) ON[^;]+TO r72_web/);
  assert.doesNotMatch(sql, /GRANT INSERT ON[^;]+company_asset_founder_approvals[^;]+TO r72_content_adapter/);
  assert.doesNotMatch(sql, /GRANT INSERT ON[^;]+company_asset_releases[^;]+TO r72_content_command/);
});
