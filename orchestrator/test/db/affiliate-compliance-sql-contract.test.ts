import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migrationUrl = new URL(
  '../../src/db/migrations/0032_property_predator_affiliate_compliance_foundation.sql',
  import.meta.url,
);

function normalise(sql: string): string {
  return sql.replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ').trim();
}

test('0032 creates private append-only affiliate evidence with forced workspace isolation', async () => {
  const sql = normalise(await readFile(migrationUrl, 'utf8'));
  const tables = [
    'affiliate_compliance_policy_pack_versions',
    'affiliate_compliance_policy_review_events',
    'affiliate_compliance_policy_publication_events',
    'affiliate_compliance_subjects',
    'affiliate_compliance_lifecycle_events',
    'affiliate_compliance_acceptance_events',
    'affiliate_compliance_training_versions',
    'affiliate_compliance_training_approval_events',
    'affiliate_compliance_training_completion_events',
    'affiliate_compliance_declaration_events',
    'affiliate_compliance_specialist_decision_events',
    'affiliate_compliance_channel_authority_events',
    'affiliate_compliance_case_events',
    'affiliate_compliance_permission_grant_events',
    'affiliate_compliance_permission_decision_receipts',
  ];
  for (const table of tables) {
    assert.match(sql, new RegExp(`CREATE TABLE app_private\\.${table}`));
    assert.match(sql, new RegExp(`'${table}'`));
  }
  assert.match(sql, /ALTER TABLE app_private\.%I ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /ALTER TABLE app_private\.%I FORCE ROW LEVEL SECURITY/);
  assert.match(sql, /workspace_id = app_private\.current_workspace_id\(\)/);
  assert.match(sql, /app_private\.has_active_workspace_membership\( app_private\.current_user_id\(\), workspace_id \)/);
  assert.match(sql, /app_private\.can_manage_workspace\(recorded_by_user_id, workspace_id\)/);
  assert.match(sql, /reject_affiliate_compliance_mutation/);
  assert.match(sql, /BEFORE UPDATE OR DELETE/);
  assert.match(sql, /workspace_table_registry/);
  assert.match(sql, /FOREIGN KEY \(workspace_id, subject_id\)/);
  assert.match(sql, /FOREIGN KEY \(workspace_id, policy_pack_id, bundle_sha256\)/);
  assert.doesNotMatch(sql, /CREATE TABLE app\.(?:affiliate|compliance)/);
});

test('0032 pins exact solicitor-approved versions without storing documents or contact details', async () => {
  const sql = normalise(await readFile(migrationUrl, 'utf8'));
  assert.match(sql, /bundle_sha256 bytea NOT NULL/);
  assert.match(sql, /document_refs jsonb NOT NULL/);
  assert.match(sql, /source_commit_meaning = 'drafting-provenance-only'/);
  assert.match(sql, /review_dimension IN \('legal', 'commercial'\)/);
  assert.match(sql, /decision IN \('approved', 'qualified_approval', 'rejected', 'withdrawn'\)/);
  assert.match(sql, /publication_state IN \('published', 'superseded', 'withdrawn'\)/);
  assert.match(sql, /legal_review_dimension = 'legal'/);
  assert.match(sql, /commercial_review_dimension = 'commercial'/);
  assert.match(sql, /legal_decision = 'approved'/);
  assert.match(sql, /commercial_decision = 'approved'/);
  assert.match(sql, /Affiliate acceptance requires the exact current approved published bundle/);
  assert.match(sql, /guard_affiliate_compliance_policy_pack_insert/);
  assert.match(sql, /document_keys IS DISTINCT FROM ARRAY\[ 'contentSha256', 'documentId', 'documentType', 'documentVersion' \]::text\[\]/);
  assert.match(sql, /Affiliate policy document references have an unknown or missing field/);
  assert.match(sql, /document types must be unique inside a bundle/);
  assert.match(sql, /Affiliate compliance request references must be opaque tokens/);
  for (const reference of [
    'specialist_reference',
    'decision_reference',
    'publication_reference',
    'approval_reference',
    'decision_scope_ref',
    'party_reference',
    'responsibility_reference',
    'sender_party_reference',
    'account_scope_reference',
  ]) {
    assert.match(sql, new RegExp(`${reference}[^;]+\\^\\[A-Za-z0-9\\]`));
  }
  assert.match(sql, /accepted_legal_name_sha256 bytea NOT NULL/);
  assert.match(sql, /quiz_attempt_sha256 bytea NOT NULL/);
  assert.match(sql, /CREATE TABLE app_private\.affiliate_compliance_training_approval_events/);
  assert.match(sql, /training_approval_state = 'approved'/);
  assert.match(sql, /training_approval_event_id uuid NOT NULL/);
  assert.match(sql, /declaration_type IN \('business_tax', 'disclosure_claims', 'data_protection'\)/);
  for (const forbidden of [
    /document_body/i,
    /raw_document/i,
    /email_address/i,
    /phone_number/i,
    /postal_address/i,
    /password_hash/i,
    /affiliate_url/i,
  ]) {
    assert.doesNotMatch(sql, forbidden);
  }
  assert.doesNotMatch(sql, /affiliate_compliance_policy_pack_versions \([^;]+legal_status/);
  assert.doesNotMatch(sql, /affiliate_compliance_training_versions \([^;]+approval_status/);
});

test('0032 models changing affiliate lifecycle as immutable events instead of mutable subject state', async () => {
  const sql = normalise(await readFile(migrationUrl, 'utf8'));
  assert.match(sql, /CREATE TABLE app_private\.affiliate_compliance_subjects/);
  assert.match(sql, /CREATE TABLE app_private\.affiliate_compliance_lifecycle_events/);
  assert.match(sql, /FOREIGN KEY \(workspace_id, subject_id, supersedes_event_id\) REFERENCES app_private\.affiliate_compliance_lifecycle_events/);
  assert.doesNotMatch(sql, /CREATE TABLE app_private\.affiliate_compliance_subjects \([^;]+lifecycle_status/);
});

test('0032 keeps PECR parties, recruitment, financial perimeter, consumer and sanctions gates separate', async () => {
  const sql = normalise(await readFile(migrationUrl, 'utf8'));
  for (const decision of [
    'pecr_sender_route',
    'pecr_instigator_route',
    'affiliate_recruitment_policy',
    'financial_promotion_perimeter',
    'consumer_eligibility_review',
    'sanctions_screening',
  ]) {
    assert.match(sql, new RegExp(`'${decision}'`));
  }
  for (const route of [
    'solicited_request',
    'individual_consent',
    'individual_soft_opt_in',
    'corporate_subscriber_reg23',
    'unknown',
  ]) {
    assert.match(sql, new RegExp(`'${route}'`));
  }
  assert.match(sql, /party_reference text/);
  assert.match(sql, /responsibility_reference text/);
  assert.match(sql, /route_classification <> 'unknown'/);
  assert.match(sql, /channel = 'affiliate_recruitment' OR content_class <> 'affiliate_recruitment'/);
  assert.match(sql, /channel <> 'affiliate_recruitment' OR content_class = 'affiliate_recruitment'/);
  assert.match(sql, /ownership_control_checked boolean NOT NULL DEFAULT false/);
  assert.match(sql, /freeze_or_hold_required boolean NOT NULL DEFAULT false/);
  assert.match(sql, /ownership_control_checked IS TRUE AND freeze_or_hold_required IS FALSE/);
  assert.match(sql, /workspace_id, subject_id, supersedes_event_id, decision_kind/);
});

test('0032 is fail-closed and grants no delivery, publishing, payout or provider capability', async () => {
  const sql = normalise(await readFile(migrationUrl, 'utf8'));
  assert.match(sql, /CREATE ROLE r72_affiliate_compliance_command LOGIN NOINHERIT/);
  assert.match(sql, /grant_state IN \('requested', 'blocked', 'revoked', 'expired'\)/);
  assert.match(sql, /decision text NOT NULL CHECK \(decision = 'deny'\)/);
  assert.match(sql, /provider_effects boolean NOT NULL DEFAULT false CHECK \(provider_effects IS FALSE\)/);
  assert.match(sql, /expires_at <= evaluated_at \+ interval '5 minutes'/);
  assert.match(sql, /has_table_privilege\( 'r72_affiliate_compliance_command', 'app\.provider_operations', 'INSERT' \)/);
  assert.match(sql, /pg_has_role\( 'r72_affiliate_compliance_command', 'r72_worker', 'MEMBER' \)/);
  assert.doesNotMatch(sql, /GRANT (?:EXECUTE|INSERT)[^;]+provider_operations TO r72_affiliate_compliance_command/i);
  assert.doesNotMatch(sql, /GRANT[^;]+r72_provider_operation_definer TO r72_affiliate_compliance_command/i);
  assert.doesNotMatch(sql, /grant_state IN \([^)]*(?:'active'|'granted')/);
  assert.doesNotMatch(sql, /decision text NOT NULL CHECK \(decision = 'allow'\)/);
});
