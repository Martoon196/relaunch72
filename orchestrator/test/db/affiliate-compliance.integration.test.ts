import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { Pool } from 'pg';
import {
  expectPostgresError,
  openTestDatabase,
  ownerQuery,
  resetIdentityTables,
  scopedQuery,
  testDatabaseSkipReason,
} from './database-helper.js';

const skip = testDatabaseSkipReason();
const HASH_A = '11'.repeat(32);
const HASH_B = '22'.repeat(32);
const HASH_C = '33'.repeat(32);
const ACTION_SCOPE = '44'.repeat(32);
const SNAPSHOT = '55'.repeat(32);
const NONCE_A = '66'.repeat(32);
const NONCE_B = '77'.repeat(32);

const AFFILIATE_ROLES = [
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

async function seedIdentity(
  pool: Pool,
  organizationId: string,
  workspaceA: string,
  workspaceB: string,
  ownerA: string,
  ownerB: string,
  viewerA: string,
): Promise<void> {
  const suffix = organizationId.replaceAll('-', '').slice(0, 10);
  await ownerQuery(pool,
    `INSERT INTO app.organizations (id, name, slug, kind, status)
     VALUES ($1, 'Affiliate compliance integration', $2, 'direct_customer', 'active')`,
    [organizationId, `affiliate-compliance-${suffix}`]);
  await ownerQuery(pool,
    `INSERT INTO app.users (id, email, status, email_verified_at) VALUES
       ($1, $2, 'active', statement_timestamp()),
       ($3, $4, 'active', statement_timestamp()),
       ($5, $6, 'active', statement_timestamp())`,
    [ownerA, `affiliate-a-${suffix}@example.test`, ownerB,
      `affiliate-b-${suffix}@example.test`, viewerA,
      `affiliate-viewer-${suffix}@example.test`]);
  await ownerQuery(pool,
    `INSERT INTO app.workspaces (id, organization_id, name, slug, status) VALUES
       ($1, $2, 'Affiliate A', $3, 'active'),
       ($4, $2, 'Affiliate B', $5, 'active')`,
    [workspaceA, organizationId, `affiliate-a-${suffix}`,
      workspaceB, `affiliate-b-${suffix}`]);
  await ownerQuery(pool,
    `INSERT INTO app.workspace_memberships (
       workspace_id, organization_id, user_id, role, status
     ) VALUES
       ($1, $2, $3, 'owner', 'active'),
       ($4, $2, $5, 'owner', 'active'),
       ($1, $2, $6, 'viewer', 'active')`,
    [workspaceA, organizationId, ownerA, workspaceB, ownerB, viewerA]);
}

test('affiliate compliance evidence rejects authority, scope, history, PII and capability attacks', {
  skip,
}, async () => {
  const pool = await openTestDatabase();
  const organizationId = randomUUID();
  const workspaceA = randomUUID();
  const workspaceB = randomUUID();
  const ownerA = randomUUID();
  const ownerB = randomUUID();
  const viewerA = randomUUID();
  const policyPackA = randomUUID();
  const policyPackB = randomUUID();
  const subjectA = randomUUID();
  const subjectB = randomUUID();
  const legalReviewA = randomUUID();
  const commercialReviewA = randomUUID();
  const publicationA = randomUUID();
  const trainingA = randomUUID();
  const trainingApprovalA = randomUUID();
  const lifecycleRoot = randomUUID();
  const lifecycleChild = randomUUID();
  const channelA = randomUUID();
  const contextA = { workspaceId: workspaceA, userId: ownerA, requestId: 'affiliate-a' };
  const contextB = { workspaceId: workspaceB, userId: ownerB, requestId: 'affiliate-b' };
  const viewerContext = { workspaceId: workspaceA, userId: viewerA, requestId: 'affiliate-viewer' };
  const documents = JSON.stringify([
    { documentType: 'terms', documentVersion: 'draft-v1', documentId: 'legal-terms-v1', contentSha256: HASH_A },
    { documentType: 'conduct', documentVersion: 'draft-v1', documentId: 'legal-conduct-v1', contentSha256: HASH_A },
    { documentType: 'privacy', documentVersion: 'draft-v1', documentId: 'legal-privacy-v1', contentSha256: HASH_A },
    { documentType: 'recruitment', documentVersion: 'draft-v1', documentId: 'legal-recruitment-v1', contentSha256: HASH_A },
    { documentType: 'marketing', documentVersion: 'draft-v1', documentId: 'legal-marketing-v1', contentSha256: HASH_A },
  ]);

  try {
    await resetIdentityTables(pool);
    await seedIdentity(pool, organizationId, workspaceA, workspaceB, ownerA, ownerB, viewerA);

    const unsafeDocuments = JSON.stringify((JSON.parse(documents) as Record<string, string>[])
      .map((document, index) => index === 0 ? { ...document, body: 'raw legal body' } : document));
    await expectPostgresError(scopedQuery(pool, 'r72_affiliate_draft_command', contextA,
      `INSERT INTO app_private.affiliate_compliance_policy_pack_versions (
         id, workspace_id, pack_key, pack_version, bundle_sha256, document_refs,
         drafting_status, source_commit, source_commit_meaning,
         recorded_by_user_id, recorded_request_id
       ) VALUES ($1, $2, 'unsafe-pack', 'draft-v1', decode($3, 'hex'), $4::jsonb,
         'draft_complete', '3405cc8', 'drafting-provenance-only', $5, 'ignored')`,
      [randomUUID(), workspaceA, HASH_C, unsafeDocuments, ownerA]), '23514');

    for (const [workspaceId, ownerId, policyPackId, packKey, context] of [
      [workspaceA, ownerA, policyPackA, 'affiliate-core-a', contextA],
      [workspaceB, ownerB, policyPackB, 'affiliate-core-b', contextB],
    ] as const) {
      await scopedQuery(pool, 'r72_affiliate_draft_command', context,
        `INSERT INTO app_private.affiliate_compliance_policy_pack_versions (
           id, workspace_id, pack_key, pack_version, bundle_sha256, document_refs,
           drafting_status, source_commit, source_commit_meaning,
           recorded_by_user_id, recorded_request_id
         ) VALUES ($1, $2, $3, 'draft-v1', decode($4, 'hex'), $5::jsonb,
           'draft_complete', '3405cc8', 'drafting-provenance-only', $6, 'ignored')`,
        [policyPackId, workspaceId, packKey, HASH_A, documents, ownerId]);
    }

    for (const [workspaceId, ownerId, subjectId, key, context] of [
      [workspaceA, ownerA, subjectA, 'AFFILIATE-A', contextA],
      [workspaceB, ownerB, subjectB, 'AFFILIATE-B', contextB],
    ] as const) {
      await scopedQuery(pool, 'r72_affiliate_draft_command', context,
        `INSERT INTO app_private.affiliate_compliance_subjects (
           id, workspace_id, source_system, source_subject_key, legal_identity_sha256,
           recorded_by_user_id, recorded_request_id
         ) VALUES ($1, $2, 'test-fixture', $3, decode($4, 'hex'), $5, 'ignored')`,
        [subjectId, workspaceId, key, HASH_B, ownerId]);
    }

    const managerRead = await scopedQuery<{ count: string }>(pool, 'r72_web', contextA,
      `SELECT count(*)::text AS count FROM app_private.affiliate_compliance_subjects`);
    const viewerRead = await scopedQuery<{ count: string }>(pool, 'r72_web', viewerContext,
      `SELECT count(*)::text AS count FROM app_private.affiliate_compliance_subjects`);
    const otherWorkspaceRead = await scopedQuery<{ count: string }>(pool, 'r72_web', contextB,
      `SELECT count(*)::text AS count FROM app_private.affiliate_compliance_subjects`);
    assert.equal(managerRead[0]!.count, '1');
    assert.equal(viewerRead[0]!.count, '0');
    assert.equal(otherWorkspaceRead[0]!.count, '1');

    await expectPostgresError(ownerQuery(pool,
      `UPDATE app_private.affiliate_compliance_subjects
       SET legal_identity_sha256 = decode($2, 'hex') WHERE id = $1`,
      [subjectA, HASH_C]), '55000');

    await scopedQuery(pool, 'r72_affiliate_legal_command', contextA,
      `INSERT INTO app_private.affiliate_compliance_policy_review_events (
         id, workspace_id, policy_pack_id, bundle_sha256, review_dimension,
         decision, specialist_reference, decision_reference, decision_sha256,
         occurred_at, recorded_by_user_id, recorded_request_id
       ) VALUES ($1, $2, $3, decode($4, 'hex'), 'legal', 'approved',
         'solicitor-fixture', 'legal-fixture-approval', decode($5, 'hex'),
         statement_timestamp(), $6, 'ignored')`,
      [legalReviewA, workspaceA, policyPackA, HASH_A, HASH_B, ownerA]);
    await expectPostgresError(scopedQuery(pool, 'r72_affiliate_legal_command', contextA,
      `INSERT INTO app_private.affiliate_compliance_policy_review_events (
         id, workspace_id, policy_pack_id, bundle_sha256, review_dimension,
         decision, specialist_reference, decision_reference, decision_sha256,
         occurred_at, recorded_by_user_id, recorded_request_id
       ) VALUES ($1, $2, $3, decode($4, 'hex'), 'commercial', 'approved',
         'commercial-fixture', 'commercial-role-confusion', decode($5, 'hex'),
         statement_timestamp(), $6, 'ignored')`,
      [randomUUID(), workspaceA, policyPackA, HASH_A, HASH_C, ownerA]), '42501');
    await expectPostgresError(scopedQuery(pool, 'r72_affiliate_legal_command', contextA,
      `INSERT INTO app_private.affiliate_compliance_policy_review_events (
         id, workspace_id, policy_pack_id, bundle_sha256, review_dimension,
         decision, specialist_reference, decision_reference, decision_sha256,
         occurred_at, recorded_by_user_id, recorded_request_id
       ) VALUES ($1, $2, $3, decode($4, 'hex'), 'legal', 'approved',
         'solicitor-fixture', 'second-root', decode($5, 'hex'),
         statement_timestamp(), $6, 'ignored')`,
      [randomUUID(), workspaceA, policyPackA, HASH_A, HASH_C, ownerA]), '23505');
    await scopedQuery(pool, 'r72_affiliate_commercial_command', contextA,
      `INSERT INTO app_private.affiliate_compliance_policy_review_events (
         id, workspace_id, policy_pack_id, bundle_sha256, review_dimension,
         decision, specialist_reference, decision_reference, decision_sha256,
         occurred_at, recorded_by_user_id, recorded_request_id
       ) VALUES ($1, $2, $3, decode($4, 'hex'), 'commercial', 'approved',
         'commercial-fixture', 'commercial-fixture-approval', decode($5, 'hex'),
         statement_timestamp(), $6, 'ignored')`,
      [commercialReviewA, workspaceA, policyPackA, HASH_A, HASH_C, ownerA]);
    await expectPostgresError(scopedQuery(pool, 'r72_affiliate_legal_command', contextA,
      `INSERT INTO app_private.affiliate_compliance_policy_publication_events (
         id, workspace_id, policy_pack_id, bundle_sha256, publication_state,
         legal_review_event_id, commercial_review_event_id, effective_at,
         reacceptance_class, publication_reference, recorded_by_user_id, recorded_request_id
       ) VALUES ($1, $2, $3, decode($4, 'hex'), 'published', $5, $6,
         statement_timestamp(), 'all_permissions', 'illegal-publication', $7, 'ignored')`,
      [randomUUID(), workspaceA, policyPackA, HASH_A, legalReviewA, commercialReviewA, ownerA]), '42501');
    await scopedQuery(pool, 'r72_affiliate_commercial_command', contextA,
      `INSERT INTO app_private.affiliate_compliance_policy_publication_events (
         id, workspace_id, policy_pack_id, bundle_sha256, publication_state,
         legal_review_event_id, commercial_review_event_id, effective_at, expires_at,
         reacceptance_class, publication_reference, recorded_by_user_id, recorded_request_id
       ) VALUES ($1, $2, $3, decode($4, 'hex'), 'published', $5, $6,
         statement_timestamp(), statement_timestamp() + interval '365 days',
         'all_permissions', 'publication-fixture', $7, 'ignored')`,
      [publicationA, workspaceA, policyPackA, HASH_A, legalReviewA, commercialReviewA, ownerA]);

    await expectPostgresError(scopedQuery(pool, 'r72_affiliate_draft_command', contextA,
      `INSERT INTO app_private.affiliate_compliance_acceptance_events (
         id, workspace_id, subject_id, policy_pack_id, publication_event_id,
         bundle_sha256, action, accepted_legal_name_sha256, capacity,
         affirmation_sha256, receipt_sha256, occurred_at,
         authentication_strength, interface_version, recorded_by_user_id, recorded_request_id
       ) VALUES ($1, $2, $3, $4, $5, decode($6, 'hex'), 'explicit_accept',
         decode($7, 'hex'), 'self', decode($8, 'hex'), decode($9, 'hex'),
         statement_timestamp(), 'mfa', 'v1', $10, 'ignored')`,
      [randomUUID(), workspaceA, subjectA, policyPackA, publicationA, HASH_A,
        HASH_B, HASH_B, HASH_C, ownerA]), '42501');
    await scopedQuery(pool, 'r72_affiliate_acceptance_command', contextA,
      `INSERT INTO app_private.affiliate_compliance_acceptance_events (
         id, workspace_id, subject_id, policy_pack_id, publication_event_id,
         bundle_sha256, action, accepted_legal_name_sha256, capacity,
         affirmation_sha256, receipt_sha256, occurred_at, expires_at,
         authentication_strength, interface_version, recorded_by_user_id, recorded_request_id
       ) VALUES ($1, $2, $3, $4, $5, decode($6, 'hex'), 'explicit_accept',
         decode($7, 'hex'), 'self', decode($8, 'hex'), decode($9, 'hex'),
         statement_timestamp(), statement_timestamp() + interval '180 days',
         'mfa', 'v1', $10, 'ignored')`,
      [randomUUID(), workspaceA, subjectA, policyPackA, publicationA, HASH_A,
        HASH_B, HASH_B, HASH_C, ownerA]);

    await scopedQuery(pool, 'r72_affiliate_capacity_command', contextA,
      `INSERT INTO app_private.affiliate_compliance_capacity_decision_events (
         id, workspace_id, subject_id, decision_state, capacity_reference,
         evidence_sha256, occurred_at, expires_at,
         recorded_by_user_id, recorded_request_id
       ) VALUES ($1, $2, $3, 'verified', 'capacity-fixture', decode($4, 'hex'),
         statement_timestamp(), statement_timestamp() + interval '180 days', $5, 'ignored')`,
      [randomUUID(), workspaceA, subjectA, HASH_C, ownerA]);
    await scopedQuery(pool, 'r72_affiliate_declaration_command', contextA,
      `INSERT INTO app_private.affiliate_compliance_declaration_events (
         id, workspace_id, subject_id, declaration_type, declaration_version,
         declaration_sha256, decision, evidence_sha256, occurred_at, expires_at,
         recorded_by_user_id, recorded_request_id
       ) VALUES ($1, $2, $3, 'business_tax', 'v1', decode($4, 'hex'), 'affirmed',
         decode($5, 'hex'), statement_timestamp(), statement_timestamp() + interval '365 days',
         $6, 'ignored')`,
      [randomUUID(), workspaceA, subjectA, HASH_B, HASH_C, ownerA]);

    await scopedQuery(pool, 'r72_affiliate_training_authority_command', contextA,
      `INSERT INTO app_private.affiliate_compliance_training_versions (
         id, workspace_id, training_key, training_version, course_sha256,
         quiz_sha256, pass_percentage, recorded_by_user_id, recorded_request_id
       ) VALUES ($1, $2, 'affiliate_core', 'v1', decode($3, 'hex'),
         decode($4, 'hex'), 85, $5, 'ignored')`,
      [trainingA, workspaceA, HASH_A, HASH_B, ownerA]);
    await expectPostgresError(scopedQuery(pool, 'r72_affiliate_training_evidence_command', contextA,
      `INSERT INTO app_private.affiliate_compliance_training_approval_events (
         id, workspace_id, training_version_id, training_key, course_sha256,
         quiz_sha256, approval_state, approval_reference, approval_sha256,
         effective_at, recorded_by_user_id, recorded_request_id
       ) VALUES ($1, $2, $3, 'affiliate_core', decode($4, 'hex'), decode($5, 'hex'),
         'approved', 'wrong-authority', decode($6, 'hex'), statement_timestamp(), $7, 'ignored')`,
      [randomUUID(), workspaceA, trainingA, HASH_A, HASH_B, HASH_C, ownerA]), '42501');
    await scopedQuery(pool, 'r72_affiliate_training_authority_command', contextA,
      `INSERT INTO app_private.affiliate_compliance_training_approval_events (
         id, workspace_id, training_version_id, training_key, course_sha256,
         quiz_sha256, approval_state, approval_reference, approval_sha256,
         effective_at, expires_at, recorded_by_user_id, recorded_request_id
       ) VALUES ($1, $2, $3, 'affiliate_core', decode($4, 'hex'), decode($5, 'hex'),
         'approved', 'training-approval', decode($6, 'hex'), statement_timestamp(),
         statement_timestamp() + interval '365 days', $7, 'ignored')`,
      [trainingApprovalA, workspaceA, trainingA, HASH_A, HASH_B, HASH_C, ownerA]);
    await expectPostgresError(scopedQuery(pool, 'r72_affiliate_training_evidence_command', contextA,
      `INSERT INTO app_private.affiliate_compliance_training_completion_events (
         id, workspace_id, subject_id, training_version_id, training_key,
         training_approval_event_id, course_sha256, quiz_sha256, outcome,
         score_percentage, quiz_attempt_sha256, attestation_sha256, completed_at,
         recorded_by_user_id, recorded_request_id
       ) VALUES ($1, $2, $3, $4, 'affiliate_core', $5, decode($6, 'hex'), decode($7, 'hex'),
         'passed', 80, decode($8, 'hex'), decode($9, 'hex'), statement_timestamp(), $10, 'ignored')`,
      [randomUUID(), workspaceA, subjectA, trainingA, trainingApprovalA,
        HASH_A, HASH_B, HASH_C, HASH_C, ownerA]), '23514');
    await scopedQuery(pool, 'r72_affiliate_training_evidence_command', contextA,
      `INSERT INTO app_private.affiliate_compliance_training_completion_events (
         id, workspace_id, subject_id, training_version_id, training_key,
         training_approval_event_id, course_sha256, quiz_sha256, outcome,
         score_percentage, quiz_attempt_sha256, attestation_sha256, completed_at, expires_at,
         recorded_by_user_id, recorded_request_id
       ) VALUES ($1, $2, $3, $4, 'affiliate_core', $5, decode($6, 'hex'), decode($7, 'hex'),
         'passed', 90, decode($8, 'hex'), decode($9, 'hex'), statement_timestamp(),
         statement_timestamp() + interval '365 days', $10, 'ignored')`,
      [randomUUID(), workspaceA, subjectA, trainingA, trainingApprovalA,
        HASH_A, HASH_B, HASH_C, HASH_C, ownerA]);

    await scopedQuery(pool, 'r72_affiliate_lifecycle_command', contextA,
      `INSERT INTO app_private.affiliate_compliance_lifecycle_events (
         id, workspace_id, subject_id, lifecycle_status, reason_code, occurred_at,
         recorded_by_user_id, recorded_request_id
       ) VALUES ($1, $2, $3, 'active', 'approved_activation', statement_timestamp(), $4, 'ignored')`,
      [lifecycleRoot, workspaceA, subjectA, ownerA]);
    await scopedQuery(pool, 'r72_affiliate_lifecycle_command', contextA,
      `INSERT INTO app_private.affiliate_compliance_lifecycle_events (
         id, workspace_id, subject_id, lifecycle_status, reason_code, occurred_at,
         supersedes_event_id, recorded_by_user_id, recorded_request_id
       ) VALUES ($1, $2, $3, 'terminated', 'terminated_for_cause', statement_timestamp(),
         $4, $5, 'ignored')`,
      [lifecycleChild, workspaceA, subjectA, lifecycleRoot, ownerA]);
    await expectPostgresError(scopedQuery(pool, 'r72_affiliate_lifecycle_command', contextA,
      `INSERT INTO app_private.affiliate_compliance_lifecycle_events (
         id, workspace_id, subject_id, lifecycle_status, reason_code, occurred_at,
         supersedes_event_id, recorded_by_user_id, recorded_request_id
       ) VALUES ($1, $2, $3, 'withdrawn', 'affiliate_withdrawal', statement_timestamp(),
         $4, $5, 'ignored')`,
      [randomUUID(), workspaceA, subjectA, lifecycleRoot, ownerA]), '23505');

    await scopedQuery(pool, 'r72_affiliate_channel_command', contextA,
      `INSERT INTO app_private.affiliate_compliance_channel_authority_events (
         id, workspace_id, subject_id, channel, content_class, authority_state,
         purpose_code, territory_code, sender_party_reference, account_scope_reference,
         action_scope_sha256, authority_sha256, valid_from, valid_until,
         recorded_by_user_id, recorded_request_id
       ) VALUES ($1, $2, $3, 'affiliate_link', 'ordinary_product', 'approved',
         'affiliate_marketing', 'GB', 'sender-fixture', 'account-fixture',
         decode($4, 'hex'), decode($5, 'hex'), statement_timestamp(),
         statement_timestamp() + interval '30 days', $6, 'ignored')`,
      [channelA, workspaceA, subjectA, ACTION_SCOPE, HASH_C, ownerA]);
    await expectPostgresError(scopedQuery(pool, 'r72_affiliate_channel_command', contextB,
      `INSERT INTO app_private.affiliate_compliance_channel_authority_events (
         id, workspace_id, subject_id, channel, content_class, authority_state,
         purpose_code, territory_code, sender_party_reference, account_scope_reference,
         action_scope_sha256, authority_sha256, valid_from,
         recorded_by_user_id, recorded_request_id
       ) VALUES ($1, $2, $3, 'email', 'ordinary_product', 'approved',
         'affiliate_updates', 'GB', 'sender-fixture', 'account-fixture',
         decode($4, 'hex'), decode($5, 'hex'), statement_timestamp(), $6, 'ignored')`,
      [randomUUID(), workspaceB, subjectA, ACTION_SCOPE, HASH_C, ownerB]), '23503');

    await expectPostgresError(scopedQuery(pool, 'r72_affiliate_specialist_command', contextA,
      `INSERT INTO app_private.affiliate_compliance_specialist_decision_events (
         id, workspace_id, subject_id, decision_kind, decision_scope_ref,
         action_scope_sha256, decision_state, specialist_reference, decision_sha256,
         ownership_control_checked, freeze_or_hold_required, valid_from,
         recorded_by_user_id, recorded_request_id
       ) VALUES ($1, $2, $3, 'sanctions_screening', 'payee-fixture', decode($4, 'hex'),
         'approved', 'ofsi-screen-fixture', decode($5, 'hex'), true, false,
         statement_timestamp(), $6, 'ignored')`,
      [randomUUID(), workspaceA, subjectA, ACTION_SCOPE, HASH_C, ownerA]), '23514');

    await scopedQuery(pool, 'r72_affiliate_case_command', contextA,
      `INSERT INTO app_private.affiliate_compliance_case_events (
         id, workspace_id, subject_id, case_reference, event_type, severity,
         hold_kind, reason_code, evidence_sha256, permission_effect, occurred_at,
         recorded_by_user_id, recorded_request_id
       ) VALUES ($1, $2, $3, 'CASE-001', 'opened', 'high', 'fraud',
         'fraud_review', decode($4, 'hex'), 'block', statement_timestamp(), $5, 'ignored')`,
      [randomUUID(), workspaceA, subjectA, HASH_C, ownerA]);
    await expectPostgresError(scopedQuery(pool, 'r72_affiliate_receipt_command', contextA,
      `INSERT INTO app_private.affiliate_compliance_case_events (
         id, workspace_id, subject_id, case_reference, event_type, severity,
         hold_kind, reason_code, evidence_sha256, permission_effect, occurred_at,
         recorded_by_user_id, recorded_request_id
       ) VALUES ($1, $2, $3, 'CASE-002', 'opened', 'high', 'security',
         'wrong_authority', decode($4, 'hex'), 'block', statement_timestamp(), $5, 'ignored')`,
      [randomUUID(), workspaceA, subjectA, HASH_C, ownerA]), '42501');

    await expectPostgresError(scopedQuery(pool, 'r72_affiliate_receipt_command', contextA,
      `INSERT INTO app_private.affiliate_compliance_permission_decision_receipts (
         id, workspace_id, subject_id, permission, decision, reason_codes,
         action_scope_sha256, decision_nonce_sha256, evidence_snapshot_sha256,
         evaluated_at, expires_at, recorded_by_user_id, recorded_request_id
       ) VALUES ($1, $2, $3, 'affiliate_link.issue', 'deny', ARRAY['real@example.com'],
         decode($4, 'hex'), decode($5, 'hex'), decode($6, 'hex'), statement_timestamp(),
         statement_timestamp() + interval '5 minutes', $7, 'ignored')`,
      [randomUUID(), workspaceA, subjectA, ACTION_SCOPE, NONCE_A, SNAPSHOT, ownerA]), '23514');
    await expectPostgresError(scopedQuery(pool, 'r72_affiliate_receipt_command', contextA,
      `INSERT INTO app_private.affiliate_compliance_permission_decision_receipts (
         id, workspace_id, subject_id, permission, decision, reason_codes,
         action_scope_sha256, decision_nonce_sha256, evidence_snapshot_sha256,
         evaluated_at, expires_at, recorded_by_user_id, recorded_request_id
       ) VALUES ($1, $2, $3, 'affiliate_link.issue', 'allow', ARRAY['EVIDENCE_INVALID'],
         decode($4, 'hex'), decode($5, 'hex'), decode($6, 'hex'), statement_timestamp(),
         statement_timestamp() + interval '5 minutes', $7, 'ignored')`,
      [randomUUID(), workspaceA, subjectA, ACTION_SCOPE, NONCE_A, SNAPSHOT, ownerA]), '23514');

    await expectPostgresError(scopedQuery(pool, 'r72_affiliate_receipt_command', contextA,
      `INSERT INTO app_private.affiliate_compliance_permission_fact_events (
         id, workspace_id, subject_id, permission, permission_state, policy_pack_id,
         bundle_sha256, channel_authority_event_id, channel, action_scope_sha256,
         evidence_sha256, reason_code, valid_from, recorded_by_user_id, recorded_request_id
       ) VALUES ($1, $2, $3, 'affiliate_link.issue', 'granted', $4, decode($5, 'hex'),
         $6, 'affiliate_link', decode($7, 'hex'), decode($8, 'hex'), 'manual_block',
         statement_timestamp(), $9, 'ignored')`,
      [randomUUID(), workspaceA, subjectA, policyPackA, HASH_A, channelA,
        ACTION_SCOPE, HASH_C, ownerA]), '23514');
    await expectPostgresError(scopedQuery(pool, 'r72_affiliate_receipt_command', contextA,
      `INSERT INTO app_private.affiliate_compliance_permission_fact_events (
         id, workspace_id, subject_id, permission, permission_state, policy_pack_id,
         bundle_sha256, channel_authority_event_id, channel, action_scope_sha256,
         evidence_sha256, reason_code, valid_from, recorded_by_user_id, recorded_request_id
       ) VALUES ($1, $2, $3, 'email.send', 'blocked', $4, decode($5, 'hex'),
         $6, 'affiliate_link', decode($7, 'hex'), decode($8, 'hex'), 'channel_gate',
         statement_timestamp(), $9, 'ignored')`,
      [randomUUID(), workspaceA, subjectA, policyPackA, HASH_A, channelA,
        ACTION_SCOPE, HASH_C, ownerA]), '23514');

    await scopedQuery(pool, 'r72_affiliate_receipt_command', contextA,
      `INSERT INTO app_private.affiliate_compliance_permission_use_receipts (
         id, workspace_id, subject_id, permission, action_scope_sha256,
         evidence_snapshot_sha256, decision_nonce_sha256, eligibility_decision,
         evaluated_at, decision_expires_at, consumed_at,
         recorded_by_user_id, recorded_request_id
       ) VALUES ($1, $2, $3, 'affiliate_link.issue', decode($4, 'hex'), decode($5, 'hex'),
         decode($6, 'hex'), 'allow', statement_timestamp(),
         statement_timestamp() + interval '5 minutes', statement_timestamp(), $7, 'ignored')`,
      [randomUUID(), workspaceA, subjectA, ACTION_SCOPE, SNAPSHOT, NONCE_B, ownerA]);
    await expectPostgresError(scopedQuery(pool, 'r72_affiliate_receipt_command', contextA,
      `INSERT INTO app_private.affiliate_compliance_permission_use_receipts (
         id, workspace_id, subject_id, permission, action_scope_sha256,
         evidence_snapshot_sha256, decision_nonce_sha256, eligibility_decision,
         evaluated_at, decision_expires_at, consumed_at,
         recorded_by_user_id, recorded_request_id
       ) VALUES ($1, $2, $3, 'content.export_linked', decode($4, 'hex'), decode($5, 'hex'),
         decode($6, 'hex'), 'allow', statement_timestamp(),
         statement_timestamp() + interval '5 minutes', statement_timestamp(), $7, 'ignored')`,
      [randomUUID(), workspaceA, subjectA, ACTION_SCOPE, SNAPSHOT, NONCE_B, ownerA]), '23505');
    await expectPostgresError(scopedQuery(pool, 'r72_affiliate_receipt_command', contextA,
      `INSERT INTO app_private.affiliate_compliance_permission_use_receipts (
         id, workspace_id, subject_id, permission, action_scope_sha256,
         evidence_snapshot_sha256, decision_nonce_sha256, eligibility_decision,
         evaluated_at, decision_expires_at, consumed_at, provider_effects,
         recorded_by_user_id, recorded_request_id
       ) VALUES ($1, $2, $3, 'email.send', decode($4, 'hex'), decode($5, 'hex'),
         decode($6, 'hex'), 'allow', statement_timestamp(),
         statement_timestamp() + interval '5 minutes', statement_timestamp(), true, $7, 'ignored')`,
      [randomUUID(), workspaceA, subjectA, ACTION_SCOPE, SNAPSHOT, NONCE_A, ownerA]), '23514');

    const roleFacts = await ownerQuery<{
      role_name: string;
      can_insert_provider_operations: boolean;
      is_worker: boolean;
      is_provider_definer: boolean;
      can_bypass_rls: boolean;
    }>(pool,
      `SELECT role_name,
         has_table_privilege(role_name, 'app.provider_operations', 'INSERT')
           AS can_insert_provider_operations,
         pg_has_role(role_name, 'r72_worker', 'MEMBER') AS is_worker,
         pg_has_role(role_name, 'r72_provider_operation_definer', 'MEMBER')
           AS is_provider_definer,
         roles.rolbypassrls AS can_bypass_rls
       FROM unnest($1::text[]) AS names(role_name)
       JOIN pg_roles AS roles ON roles.rolname = names.role_name
       ORDER BY role_name`, [[...AFFILIATE_ROLES]]);
    assert.equal(roleFacts.length, AFFILIATE_ROLES.length);
    assert.ok(roleFacts.every((row) => !row.can_insert_provider_operations
      && !row.is_worker && !row.is_provider_definer && !row.can_bypass_rls));
  } finally {
    await resetIdentityTables(pool);
    await pool.end();
  }
});
