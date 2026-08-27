import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  AFFILIATE_COMPLIANCE_CHANNELS,
  AFFILIATE_COMPLIANCE_PERMISSIONS,
  AFFILIATE_COMPLIANCE_REASON_CODES,
} from '../../src/affiliate-compliance-pg/index.js';

const migrationUrl = new URL(
  '../../src/db/migrations/0032_property_predator_affiliate_compliance_foundation.sql',
  import.meta.url,
);

function normalise(sql: string): string {
  return sql.replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ').trim();
}

async function migration(): Promise<string> {
  return normalise(await readFile(migrationUrl, 'utf8'));
}

const TABLES = [
  'affiliate_compliance_policy_pack_versions',
  'affiliate_compliance_policy_review_events',
  'affiliate_compliance_policy_publication_events',
  'affiliate_compliance_subjects',
  'affiliate_compliance_lifecycle_events',
  'affiliate_compliance_acceptance_events',
  'affiliate_compliance_capacity_decision_events',
  'affiliate_compliance_training_versions',
  'affiliate_compliance_training_approval_events',
  'affiliate_compliance_training_completion_events',
  'affiliate_compliance_declaration_events',
  'affiliate_compliance_specialist_decision_events',
  'affiliate_compliance_channel_authority_events',
  'affiliate_compliance_effect_evidence_events',
  'affiliate_compliance_case_events',
  'affiliate_compliance_permission_fact_events',
  'affiliate_compliance_permission_decision_receipts',
  'affiliate_compliance_permission_use_receipts',
] as const;

const ROLES = [
  'r72_affiliate_draft_command',
  'r72_affiliate_lifecycle_command',
  'r72_affiliate_legal_command',
  'r72_affiliate_commercial_command',
  'r72_affiliate_acceptance_command',
  'r72_affiliate_capacity_command',
  'r72_affiliate_declaration_command',
  'r72_affiliate_training_authority_command',
  'r72_affiliate_training_evidence_command',
  'r72_affiliate_specialist_command',
  'r72_affiliate_channel_command',
  'r72_affiliate_effect_command',
  'r72_affiliate_case_command',
  'r72_affiliate_receipt_command',
] as const;

test('0032 creates private append-only evidence with forced manager-only workspace isolation', async () => {
  const sql = await migration();
  for (const table of TABLES) {
    assert.match(sql, new RegExp(`CREATE TABLE app_private\\.${table}`));
    assert.match(sql, new RegExp(`'${table}'`));
  }
  assert.match(sql, /ALTER TABLE app_private\.%I ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /ALTER TABLE app_private\.%I FORCE ROW LEVEL SECURITY/);
  assert.match(sql, /workspace_id = app_private\.current_workspace_id\(\)/);
  assert.match(sql, /app_private\.can_manage_workspace\( app_private\.current_user_id\(\), workspace_id \)/);
  assert.match(sql, /reject_affiliate_compliance_mutation/);
  assert.match(sql, /BEFORE UPDATE OR DELETE/);
  assert.match(sql, /workspace_table_registry/);
  assert.doesNotMatch(sql, /CREATE TABLE app\.(?:affiliate|compliance)/);
  assert.doesNotMatch(sql, /USING \( workspace_id = app_private\.current_workspace_id\(\) AND app_private\.has_active_workspace_membership/);
});

test('0032 separates actor authorities and grants no cross-authority or provider capability', async () => {
  const sql = await migration();
  assert.match(sql, /CREATE ROLE %I LOGIN NOINHERIT/);
  for (const role of ROLES) assert.match(sql, new RegExp(`'${role}'`));
  assert.doesNotMatch(sql, /r72_affiliate_compliance_command/);

  assert.match(sql, /affiliate_legal_review_insert[^;]+TO r72_affiliate_legal_command[^;]+review_dimension = 'legal'/);
  assert.match(sql, /affiliate_commercial_review_insert[^;]+TO r72_affiliate_commercial_command[^;]+review_dimension = 'commercial'/);
  assert.match(sql, /affiliate_lifecycle_authority_insert[^;]+TO r72_affiliate_lifecycle_command/);
  assert.match(sql, /affiliate_acceptance_evidence_insert[^;]+TO r72_affiliate_acceptance_command/);
  assert.match(sql, /affiliate_capacity_decision_insert[^;]+TO r72_affiliate_capacity_command/);
  assert.match(sql, /affiliate_declaration_evidence_insert[^;]+TO r72_affiliate_declaration_command/);
  assert.match(sql, /affiliate_training_approval_authority_insert[^;]+TO r72_affiliate_training_authority_command/);
  assert.match(sql, /affiliate_training_completion_evidence_insert[^;]+TO r72_affiliate_training_evidence_command/);
  assert.match(sql, /affiliate_specialist_decision_insert[^;]+TO r72_affiliate_specialist_command/);
  assert.match(sql, /affiliate_channel_authority_insert[^;]+TO r72_affiliate_channel_command/);
  assert.match(sql, /affiliate_effect_evidence_insert[^;]+TO r72_affiliate_effect_command/);
  assert.match(sql, /affiliate_case_evidence_insert[^;]+TO r72_affiliate_case_command/);
  assert.match(sql, /affiliate_deny_receipt_insert[^;]+TO r72_affiliate_receipt_command/);
  assert.match(sql, /Affiliate evidence authority separation is not intact/);

  assert.match(sql, /has_table_privilege\( role_name, 'app\.provider_operations', 'INSERT' \)/);
  assert.match(sql, /pg_has_role\(role_name, 'r72_worker', 'MEMBER'\)/);
  assert.match(sql, /pg_has_role\( role_name, 'r72_provider_operation_definer', 'MEMBER' \)/);
  assert.doesNotMatch(sql, /GRANT (?:EXECUTE|INSERT)[^;]+provider_operations TO r72_affiliate_/i);
});

test('0032 pins exact legal/training facts and rejects raw document or PII fields', async () => {
  const sql = await migration();
  assert.match(sql, /bundle_sha256 bytea NOT NULL/);
  assert.match(sql, /document_refs jsonb NOT NULL/);
  assert.match(sql, /source_commit_meaning = 'drafting-provenance-only'/);
  assert.match(sql, /review_dimension IN \('legal', 'commercial'\)/);
  assert.match(sql, /legal_review_dimension = 'legal'/);
  assert.match(sql, /commercial_review_dimension = 'commercial'/);
  assert.match(sql, /legal_decision = 'approved'/);
  assert.match(sql, /commercial_decision = 'approved'/);
  assert.match(sql, /Affiliate acceptance requires the exact current approved published bundle/);
  assert.match(sql, /document_keys IS DISTINCT FROM ARRAY\[ 'contentSha256', 'documentId', 'documentType', 'documentVersion' \]::text\[\]/);
  assert.match(sql, /document types must be unique inside a bundle/);
  assert.match(sql, /training_key text NOT NULL/);
  assert.match(sql, /training_approval_state = 'approved'/);
  assert.match(sql, /outcome <> 'passed' OR expires_at IS NOT NULL/);
  assert.match(sql, /declaration_type IN \('business_tax', 'disclosure_claims', 'data_protection'\)/);
  for (const forbidden of [
    /document_body/i, /raw_document/i, /email_address/i, /phone_number/i,
    /postal_address/i, /password_hash/i, /affiliate_url/i,
  ]) assert.doesNotMatch(sql, forbidden);
});

test('SQL and TypeScript use one exact permission/channel vocabulary with a total mapping', async () => {
  const sql = await migration();
  for (const permission of AFFILIATE_COMPLIANCE_PERMISSIONS) {
    assert.match(sql, new RegExp(`'${permission.replace('.', '\\.')}'`));
  }
  for (const channel of AFFILIATE_COMPLIANCE_CHANNELS) {
    assert.match(sql, new RegExp(`'${channel}'`));
  }
  const mapping: Readonly<Record<(typeof AFFILIATE_COMPLIANCE_PERMISSIONS)[number], (typeof AFFILIATE_COMPLIANCE_CHANNELS)[number]>> = {
    'affiliate_link.issue': 'affiliate_link',
    'content.export_linked': 'content_export',
    'public_social.manual_publish': 'public_social',
    'public_social.provider_publish': 'public_social',
    'affiliate_recruitment.manual_publish': 'affiliate_recruitment',
    'affiliate_recruitment.provider_publish': 'affiliate_recruitment',
    'email.send': 'email',
    'sms.send': 'sms',
    'whatsapp.send': 'whatsapp',
    'social_dm.send': 'social_dm',
    'audience.upload': 'audience_upload',
    'paid_ads.launch': 'paid_ads',
    'phone.marketing': 'phone',
    'affiliate_attribution.write': 'tracking',
    'commission.payout': 'payout',
  };
  for (const [permission, channel] of Object.entries(mapping)) {
    assert.match(sql, new RegExp(`WHEN '${permission.replace('.', '\\.')}' THEN '${channel}'`));
  }
});

test('0032 enforces linear scoped histories, decisive states, canonical reasons and one-use allow consumption', async () => {
  const sql = await migration();
  for (const stream of [
    'policy_review', 'policy_publication', 'lifecycle', 'acceptance', 'capacity',
    'training_approval', 'training_completion', 'declaration', 'specialist',
    'channel', 'effect', 'case', 'permission_fact', 'decision_receipt',
  ]) {
    assert.match(sql, new RegExp(`CREATE UNIQUE INDEX affiliate_${stream}_one_root`));
    assert.match(sql, new RegExp(`CREATE UNIQUE INDEX affiliate_${stream}_one_child`));
  }
  assert.match(sql, /workspace_id, subject_id, supersedes_event_id, decision_kind, action_scope_sha256/);
  assert.match(sql, /workspace_id, subject_id, supersedes_event_id, channel, action_scope_sha256/);
  assert.match(sql, /decision_state IN \('approved', 'blocked', 'withdrawn'\)/);
  assert.match(sql, /authority_state IN \('approved', 'blocked', 'revoked', 'expired'\)/);
  assert.match(sql, /channel IN \('audience_upload', 'phone', 'tracking', 'payout'\)[^;]+content_class = 'operational_only'/);
  assert.match(sql, /decision_kind IN \('pecr_sender_route', 'pecr_instigator_route'\)[^;]+route_classification IS NULL[^;]+party_reference IS NULL[^;]+responsibility_reference IS NULL/);
  assert.match(sql, /decision_kind <> 'sanctions_screening'[^;]+valid_until IS NOT NULL/);

  assert.match(sql, /reason_codes text\[\] NOT NULL/);
  assert.match(sql, /cardinality\(reason_codes\) BETWEEN 1 AND 50/);
  for (const reason of AFFILIATE_COMPLIANCE_REASON_CODES) assert.match(sql, new RegExp(`'${reason}'`));
  assert.doesNotMatch(sql, /reason_codes jsonb/);
  assert.doesNotMatch(sql, /reason_code text NOT NULL CHECK \(reason_code ~/);

  assert.match(sql, /decision text NOT NULL CHECK \(decision = 'deny'\)/);
  assert.match(sql, /eligibility_decision text NOT NULL DEFAULT 'allow' CHECK \( eligibility_decision = 'allow' \)/);
  assert.match(sql, /UNIQUE \(workspace_id, decision_nonce_sha256\)/);
  assert.match(sql, /action_scope_sha256 bytea NOT NULL/);
  assert.match(sql, /evidence_snapshot_sha256 bytea NOT NULL/);
  assert.match(sql, /consumed_at < decision_expires_at/);
  assert.match(sql, /decision_expires_at <= evaluated_at \+ interval '5 minutes'/);
  assert.match(sql, /provider_effects boolean NOT NULL DEFAULT false CHECK \(provider_effects IS FALSE\)/);
  assert.match(sql, /permission_state IN \('requested', 'blocked', 'revoked', 'expired'\)/);
  assert.doesNotMatch(sql, /permission_state IN \([^)]*(?:'active'|'granted')/);
});
