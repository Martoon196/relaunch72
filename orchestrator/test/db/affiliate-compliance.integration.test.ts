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

async function seedIdentity(
  pool: Pool,
  organizationId: string,
  workspaceA: string,
  workspaceB: string,
  ownerA: string,
  ownerB: string,
): Promise<void> {
  const suffix = organizationId.replaceAll('-', '').slice(0, 10);
  await ownerQuery(pool,
    `INSERT INTO app.organizations (id, name, slug, kind, status)
     VALUES ($1, 'Affiliate compliance integration', $2, 'direct_customer', 'active')`,
    [organizationId, `affiliate-compliance-${suffix}`]);
  await ownerQuery(pool,
    `INSERT INTO app.users (id, email, status, email_verified_at) VALUES
       ($1, $2, 'active', statement_timestamp()),
       ($3, $4, 'active', statement_timestamp())`,
    [ownerA, `affiliate-a-${suffix}@example.test`, ownerB,
      `affiliate-b-${suffix}@example.test`]);
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
       ($4, $2, $5, 'owner', 'active')`,
    [workspaceA, organizationId, ownerA, workspaceB, ownerB]);
}

test('affiliate compliance evidence is exact, append-only, workspace isolated and deny-only', {
  skip,
}, async () => {
  const pool = await openTestDatabase();
  const organizationId = randomUUID();
  const workspaceA = randomUUID();
  const workspaceB = randomUUID();
  const ownerA = randomUUID();
  const ownerB = randomUUID();
  const policyPackA = randomUUID();
  const legalReviewA = randomUUID();
  const commercialReviewA = randomUUID();
  const publicationA = randomUUID();
  const draftPackB = randomUUID();
  const subjectA = randomUUID();
  const subjectB = randomUUID();
  const trainingA = randomUUID();
  const trainingApprovalA = randomUUID();
  const contextA = { workspaceId: workspaceA, userId: ownerA, requestId: 'affiliate-a' };
  const contextB = { workspaceId: workspaceB, userId: ownerB, requestId: 'affiliate-b' };
  const documents = JSON.stringify([
    { documentType: 'terms', documentVersion: 'draft-v1', documentId: 'legal-terms-v1', contentSha256: HASH_A },
    { documentType: 'conduct', documentVersion: 'draft-v1', documentId: 'legal-conduct-v1', contentSha256: HASH_A },
    { documentType: 'privacy', documentVersion: 'draft-v1', documentId: 'legal-privacy-v1', contentSha256: HASH_A },
    { documentType: 'recruitment', documentVersion: 'draft-v1', documentId: 'legal-recruitment-v1', contentSha256: HASH_A },
    { documentType: 'marketing', documentVersion: 'draft-v1', documentId: 'legal-marketing-v1', contentSha256: HASH_A },
  ]);

  try {
    await resetIdentityTables(pool);
    await seedIdentity(pool, organizationId, workspaceA, workspaceB, ownerA, ownerB);

    const unsafeDocuments = JSON.stringify([
      ...JSON.parse(documents) as Record<string, string>[],
    ].map((document, index) => index === 0 ? { ...document, body: 'raw legal body' } : document));
    await expectPostgresError(scopedQuery(pool, 'r72_affiliate_compliance_command', contextA,
      `INSERT INTO app_private.affiliate_compliance_policy_pack_versions (
         id, workspace_id, pack_key, pack_version, bundle_sha256, document_refs,
         drafting_status, source_commit, source_commit_meaning,
         recorded_by_user_id, recorded_request_id
       ) VALUES ($1, $2, 'unsafe-pack', 'draft-v1', decode($3, 'hex'), $4::jsonb,
         'draft_complete', '3405cc8', 'drafting-provenance-only', $5, 'ignored')`,
      [randomUUID(), workspaceA, HASH_C, unsafeDocuments, ownerA]), '23514');
    const duplicateDocuments = JSON.stringify([
      ...JSON.parse(documents) as Record<string, string>[],
    ].map((document, index) => index === 1 ? { ...document, documentType: 'terms' } : document));
    await expectPostgresError(scopedQuery(pool, 'r72_affiliate_compliance_command', contextA,
      `INSERT INTO app_private.affiliate_compliance_policy_pack_versions (
         id, workspace_id, pack_key, pack_version, bundle_sha256, document_refs,
         drafting_status, source_commit, source_commit_meaning,
         recorded_by_user_id, recorded_request_id
       ) VALUES ($1, $2, 'duplicate-pack', 'draft-v1', decode($3, 'hex'), $4::jsonb,
         'draft_complete', '3405cc8', 'drafting-provenance-only', $5, 'ignored')`,
      [randomUUID(), workspaceA, HASH_C, duplicateDocuments, ownerA]), '23514');

    await scopedQuery(pool, 'r72_affiliate_compliance_command', contextA,
      `INSERT INTO app_private.affiliate_compliance_policy_pack_versions (
         id, workspace_id, pack_key, pack_version, bundle_sha256, document_refs,
         drafting_status, source_commit, source_commit_meaning,
         recorded_by_user_id, recorded_request_id
       ) VALUES (
         $1, $2, 'affiliate-core', 'draft-v1', decode($3, 'hex'), $4::jsonb,
         'draft_complete', '3405cc8', 'drafting-provenance-only', $5, 'ignored'
       )`, [policyPackA, workspaceA, HASH_A, documents, ownerA]);
    await scopedQuery(pool, 'r72_affiliate_compliance_command', contextA,
      `INSERT INTO app_private.affiliate_compliance_policy_review_events (
         id, workspace_id, policy_pack_id, bundle_sha256, review_dimension,
         decision, specialist_reference, decision_reference, decision_sha256,
         occurred_at, recorded_by_user_id, recorded_request_id
       ) VALUES
         ($1, $2, $3, decode($4, 'hex'), 'legal', 'approved',
          'solicitor-fixture', 'legal-fixture-approval', decode($5, 'hex'),
          statement_timestamp() - interval '2 hours', $6, 'ignored'),
         ($7, $2, $3, decode($4, 'hex'), 'commercial', 'approved',
          'commercial-owner-fixture', 'commercial-fixture-approval', decode($8, 'hex'),
          statement_timestamp() - interval '1 hour', $6, 'ignored')`,
      [legalReviewA, workspaceA, policyPackA, HASH_A, HASH_B, ownerA,
        commercialReviewA, HASH_C]);
    await expectPostgresError(scopedQuery(pool, 'r72_affiliate_compliance_command', contextA,
      `INSERT INTO app_private.affiliate_compliance_policy_review_events (
         id, workspace_id, policy_pack_id, bundle_sha256, review_dimension,
         decision, specialist_reference, decision_reference, decision_sha256,
         occurred_at, recorded_by_user_id, recorded_request_id
       ) VALUES ($1, $2, $3, decode($4, 'hex'), 'legal', 'rejected',
         'solicitor@example.test', 'pii-reference-attack', decode($5, 'hex'),
         statement_timestamp(), $6, 'ignored')`,
      [randomUUID(), workspaceA, policyPackA, HASH_A, HASH_C, ownerA]), '23514');
    await scopedQuery(pool, 'r72_affiliate_compliance_command', contextA,
      `INSERT INTO app_private.affiliate_compliance_policy_publication_events (
         id, workspace_id, policy_pack_id, bundle_sha256, publication_state,
         legal_review_event_id, commercial_review_event_id,
         effective_at, expires_at, reacceptance_class, publication_reference,
         recorded_by_user_id, recorded_request_id
       ) VALUES ($1, $2, $3, decode($4, 'hex'), 'published', $5, $6,
         statement_timestamp() - interval '30 minutes',
         statement_timestamp() + interval '365 days', 'all_permissions',
         'publication-fixture', $7, 'ignored')`,
      [publicationA, workspaceA, policyPackA, HASH_A,
        legalReviewA, commercialReviewA, ownerA]);
    await scopedQuery(pool, 'r72_affiliate_compliance_command', contextA,
      `INSERT INTO app_private.affiliate_compliance_subjects (
         id, workspace_id, source_system, source_subject_key,
         legal_identity_sha256,
         recorded_by_user_id, recorded_request_id
       ) VALUES ($1, $2, 'test-fixture', 'AFFILIATE-A', decode($3, 'hex'),
         $4, 'ignored')`,
      [subjectA, workspaceA, HASH_B, ownerA]);
    await scopedQuery(pool, 'r72_affiliate_compliance_command', contextA,
      `INSERT INTO app_private.affiliate_compliance_lifecycle_events (
         id, workspace_id, subject_id, lifecycle_status, reason_code,
         occurred_at, recorded_by_user_id, recorded_request_id
       ) VALUES ($1, $2, $3, 'compliance_review', 'fixture_onboarding',
         statement_timestamp(), $4, 'ignored')`,
      [randomUUID(), workspaceA, subjectA, ownerA]);

    const stamped = await scopedQuery<{ recorded_by_user_id: string; recorded_request_id: string }>(
      pool, 'r72_affiliate_compliance_command', contextA,
      `SELECT recorded_by_user_id::text, recorded_request_id
       FROM app_private.affiliate_compliance_subjects WHERE id = $1`, [subjectA],
    );
    assert.deepEqual(stamped, [{ recorded_by_user_id: ownerA, recorded_request_id: 'affiliate-a' }]);

    const visibleA = await scopedQuery<{ count: string }>(pool, 'r72_web', contextA,
      `SELECT count(*)::text AS count
       FROM app_private.affiliate_compliance_subjects`);
    const hiddenB = await scopedQuery<{ count: string }>(pool, 'r72_web', contextB,
      `SELECT count(*)::text AS count
       FROM app_private.affiliate_compliance_subjects`);
    assert.equal(visibleA[0]!.count, '1');
    assert.equal(hiddenB[0]!.count, '0');

    await expectPostgresError(scopedQuery(pool, 'r72_web', contextA,
      `INSERT INTO app_private.affiliate_compliance_subjects (
         id, workspace_id, source_system, source_subject_key,
         legal_identity_sha256,
         recorded_by_user_id, recorded_request_id
       ) VALUES ($1, $2, 'test-fixture', 'WEB-BYPASS', decode($3, 'hex'),
         $4, 'web-bypass')`,
      [randomUUID(), workspaceA, HASH_C, ownerA]), '42501');
    await expectPostgresError(ownerQuery(pool,
      `UPDATE app_private.affiliate_compliance_subjects
       SET legal_identity_sha256 = decode($2, 'hex') WHERE id = $1`,
      [subjectA, HASH_C]), '55000');

    await scopedQuery(pool, 'r72_affiliate_compliance_command', contextA,
      `INSERT INTO app_private.affiliate_compliance_acceptance_events (
         id, workspace_id, subject_id, policy_pack_id, publication_event_id,
         bundle_sha256, action,
         accepted_legal_name_sha256, capacity, capacity_verified,
         affirmation_sha256, receipt_sha256, occurred_at, expires_at,
         authentication_strength, interface_version,
         recorded_by_user_id, recorded_request_id
       ) VALUES ($1, $2, $3, $4, $5, decode($6, 'hex'), 'explicit_accept',
         decode($7, 'hex'), 'self', true, decode($8, 'hex'), decode($9, 'hex'),
         statement_timestamp(), statement_timestamp() + interval '180 days',
         'mfa', 'affiliate-compliance-v1', $10, 'ignored')`,
      [randomUUID(), workspaceA, subjectA, policyPackA, publicationA, HASH_A,
        HASH_B, HASH_B, HASH_C, ownerA]);
    const withdrawnLegalReview = randomUUID();
    await scopedQuery(pool, 'r72_affiliate_compliance_command', contextA,
      `INSERT INTO app_private.affiliate_compliance_policy_review_events (
         id, workspace_id, policy_pack_id, bundle_sha256, review_dimension,
         decision, specialist_reference, decision_reference, decision_sha256,
         occurred_at, supersedes_event_id,
         recorded_by_user_id, recorded_request_id
       ) VALUES ($1, $2, $3, decode($4, 'hex'), 'legal', 'withdrawn',
         'solicitor-fixture', 'legal-fixture-withdrawal', decode($5, 'hex'),
         statement_timestamp(), $6, $7, 'ignored')`,
      [withdrawnLegalReview, workspaceA, policyPackA, HASH_A,
        HASH_C, legalReviewA, ownerA]);
    const withdrawnPublication = randomUUID();
    await scopedQuery(pool, 'r72_affiliate_compliance_command', contextA,
      `INSERT INTO app_private.affiliate_compliance_policy_publication_events (
         id, workspace_id, policy_pack_id, bundle_sha256, publication_state,
         legal_review_event_id, commercial_review_event_id,
         effective_at, reacceptance_class, publication_reference,
         supersedes_event_id, recorded_by_user_id, recorded_request_id
       ) VALUES ($1, $2, $3, decode($4, 'hex'), 'withdrawn', $5, $6,
         statement_timestamp(), 'all_permissions', 'publication-fixture-withdrawal',
         $7, $8, 'ignored')`,
      [withdrawnPublication, workspaceA, policyPackA, HASH_A,
        legalReviewA, commercialReviewA, publicationA, ownerA]);
    await expectPostgresError(scopedQuery(pool, 'r72_affiliate_compliance_command', contextA,
      `INSERT INTO app_private.affiliate_compliance_acceptance_events (
         id, workspace_id, subject_id, policy_pack_id, publication_event_id,
         bundle_sha256, action, accepted_legal_name_sha256, capacity,
         capacity_verified, affirmation_sha256, receipt_sha256, occurred_at,
         authentication_strength, interface_version,
         recorded_by_user_id, recorded_request_id
       ) VALUES ($1, $2, $3, $4, $5, decode($6, 'hex'), 'explicit_accept',
         decode($7, 'hex'), 'self', true, decode($8, 'hex'), decode($9, 'hex'),
         statement_timestamp(), 'mfa', 'affiliate-compliance-v1', $10, 'ignored')`,
      [randomUUID(), workspaceA, subjectA, policyPackA, publicationA, HASH_A,
        HASH_B, HASH_B, HASH_C, ownerA]), '23514');

    await scopedQuery(pool, 'r72_affiliate_compliance_command', contextB,
      `INSERT INTO app_private.affiliate_compliance_policy_pack_versions (
         id, workspace_id, pack_key, pack_version, bundle_sha256, document_refs,
         drafting_status, source_commit, source_commit_meaning,
         recorded_by_user_id, recorded_request_id
       ) VALUES ($1, $2, 'affiliate-core', 'draft-v1', decode($3, 'hex'), $4::jsonb,
         'draft_complete', '3405cc8', 'drafting-provenance-only', $5, 'ignored')`,
      [draftPackB, workspaceB, HASH_A, documents, ownerB]);
    await scopedQuery(pool, 'r72_affiliate_compliance_command', contextB,
      `INSERT INTO app_private.affiliate_compliance_subjects (
         id, workspace_id, source_system, source_subject_key,
         legal_identity_sha256,
         recorded_by_user_id, recorded_request_id
       ) VALUES ($1, $2, 'test-fixture', 'AFFILIATE-B', decode($3, 'hex'),
         $4, 'ignored')`,
      [subjectB, workspaceB, HASH_B, ownerB]);
    await expectPostgresError(scopedQuery(pool, 'r72_affiliate_compliance_command', contextB,
      `INSERT INTO app_private.affiliate_compliance_acceptance_events (
         id, workspace_id, subject_id, policy_pack_id, publication_event_id,
         bundle_sha256, action,
         accepted_legal_name_sha256, capacity, capacity_verified,
         affirmation_sha256, receipt_sha256, occurred_at,
         authentication_strength, interface_version,
         recorded_by_user_id, recorded_request_id
       ) VALUES ($1, $2, $3, $4, $5, decode($6, 'hex'), 'explicit_accept',
         decode($7, 'hex'), 'self', true, decode($8, 'hex'), decode($9, 'hex'),
         statement_timestamp(), 'session', 'affiliate-compliance-v1', $10, 'ignored')`,
      [randomUUID(), workspaceB, subjectB, draftPackB, randomUUID(), HASH_A,
        HASH_B, HASH_B, HASH_C, ownerB]), '23514');

    await scopedQuery(pool, 'r72_affiliate_compliance_command', contextA,
      `INSERT INTO app_private.affiliate_compliance_training_versions (
         id, workspace_id, training_key, training_version, course_sha256,
         quiz_sha256, pass_percentage, recorded_by_user_id, recorded_request_id
       ) VALUES ($1, $2, 'affiliate-core', 'v1', decode($3, 'hex'),
         decode($4, 'hex'), 85, $5, 'ignored')`,
      [trainingA, workspaceA, HASH_A, HASH_B, ownerA]);
    await scopedQuery(pool, 'r72_affiliate_compliance_command', contextA,
      `INSERT INTO app_private.affiliate_compliance_training_approval_events (
         id, workspace_id, training_version_id, course_sha256, quiz_sha256,
         approval_state, approval_reference, approval_sha256,
         effective_at, expires_at, recorded_by_user_id, recorded_request_id
       ) VALUES ($1, $2, $3, decode($4, 'hex'), decode($5, 'hex'),
         'approved', 'training-owner-fixture', decode($6, 'hex'),
         statement_timestamp() - interval '1 day',
         statement_timestamp() + interval '365 days', $7, 'ignored')`,
      [trainingApprovalA, workspaceA, trainingA, HASH_A, HASH_B, HASH_C, ownerA]);
    await expectPostgresError(scopedQuery(pool, 'r72_affiliate_compliance_command', contextA,
      `INSERT INTO app_private.affiliate_compliance_training_completion_events (
         id, workspace_id, subject_id, training_version_id,
         training_approval_event_id, course_sha256,
         quiz_sha256, outcome, score_percentage, quiz_attempt_sha256,
         attestation_sha256, completed_at, recorded_by_user_id, recorded_request_id
       ) VALUES ($1, $2, $3, $4, $5, decode($6, 'hex'), decode($7, 'hex'),
         'passed', 80, decode($8, 'hex'), decode($9, 'hex'),
         statement_timestamp(), $10, 'ignored')`,
      [randomUUID(), workspaceA, subjectA, trainingA, trainingApprovalA,
        HASH_A, HASH_B, HASH_C, HASH_C, ownerA]), '23514');
    const withdrawnTraining = randomUUID();
    await scopedQuery(pool, 'r72_affiliate_compliance_command', contextA,
      `INSERT INTO app_private.affiliate_compliance_training_approval_events (
         id, workspace_id, training_version_id, course_sha256, quiz_sha256,
         approval_state, approval_reference, approval_sha256,
         effective_at, supersedes_event_id,
         recorded_by_user_id, recorded_request_id
       ) VALUES ($1, $2, $3, decode($4, 'hex'), decode($5, 'hex'),
         'withdrawn', 'training-owner-withdrawal', decode($6, 'hex'),
         statement_timestamp(), $7, $8, 'ignored')`,
      [withdrawnTraining, workspaceA, trainingA, HASH_A, HASH_B,
        HASH_C, trainingApprovalA, ownerA]);
    await expectPostgresError(scopedQuery(pool, 'r72_affiliate_compliance_command', contextA,
      `INSERT INTO app_private.affiliate_compliance_training_completion_events (
         id, workspace_id, subject_id, training_version_id,
         training_approval_event_id, course_sha256, quiz_sha256,
         outcome, score_percentage, quiz_attempt_sha256,
         attestation_sha256, completed_at, recorded_by_user_id, recorded_request_id
       ) VALUES ($1, $2, $3, $4, $5, decode($6, 'hex'), decode($7, 'hex'),
         'passed', 100, decode($8, 'hex'), decode($9, 'hex'),
         statement_timestamp(), $10, 'ignored')`,
      [randomUUID(), workspaceA, subjectA, trainingA, trainingApprovalA,
        HASH_A, HASH_B, HASH_C, HASH_C, ownerA]), '23514');

    await scopedQuery(pool, 'r72_affiliate_compliance_command', contextA,
      `INSERT INTO app_private.affiliate_compliance_permission_decision_receipts (
         id, workspace_id, subject_id, permission, decision, reason_codes,
         policy_pack_id, bundle_sha256, evidence_snapshot_sha256,
         evaluated_at, expires_at, provider_effects,
         recorded_by_user_id, recorded_request_id
       ) VALUES ($1, $2, $3, 'affiliate_link.issue', 'deny',
         '["solicitor_approval_missing"]'::jsonb, $4, decode($5, 'hex'),
         decode($6, 'hex'), statement_timestamp(),
         statement_timestamp() + interval '5 minutes', false, $7, 'ignored')`,
      [randomUUID(), workspaceA, subjectA, policyPackA, HASH_A, HASH_C, ownerA]);
    await expectPostgresError(scopedQuery(pool, 'r72_affiliate_compliance_command', contextA,
      `INSERT INTO app_private.affiliate_compliance_permission_decision_receipts (
         id, workspace_id, subject_id, permission, decision, reason_codes,
         evidence_snapshot_sha256, evaluated_at, expires_at,
         provider_effects, recorded_by_user_id, recorded_request_id
       ) VALUES ($1, $2, $3, 'affiliate_link.issue', 'allow', '["none"]'::jsonb,
         decode($4, 'hex'), statement_timestamp(),
         statement_timestamp() + interval '5 minutes', false, $5, 'ignored')`,
      [randomUUID(), workspaceA, subjectA, HASH_C, ownerA]), '23514');
    await expectPostgresError(scopedQuery(pool, 'r72_affiliate_compliance_command', contextA,
      `INSERT INTO app_private.affiliate_compliance_permission_decision_receipts (
         id, workspace_id, subject_id, permission, decision, reason_codes,
         evidence_snapshot_sha256, evaluated_at, expires_at,
         provider_effects, recorded_by_user_id, recorded_request_id
       ) VALUES ($1, $2, $3, 'email.send', 'deny', '["provider_effects_off"]'::jsonb,
         decode($4, 'hex'), statement_timestamp(),
         statement_timestamp() + interval '5 minutes', true, $5, 'ignored')`,
      [randomUUID(), workspaceA, subjectA, HASH_C, ownerA]), '23514');
    await expectPostgresError(scopedQuery(pool, 'r72_affiliate_compliance_command', contextA,
      `INSERT INTO app_private.affiliate_compliance_permission_grant_events (
         id, workspace_id, subject_id, permission, grant_state,
         policy_pack_id, bundle_sha256, permission_scope_sha256,
         reason_code, valid_from, provider_effects,
         recorded_by_user_id, recorded_request_id
       ) VALUES ($1, $2, $3, 'affiliate_link.issue', 'granted', $4,
         decode($5, 'hex'), decode($6, 'hex'), 'test_bypass',
         statement_timestamp(), false, $7, 'ignored')`,
      [randomUUID(), workspaceA, subjectA, policyPackA, HASH_A, HASH_C, ownerA]), '23514');

    await expectPostgresError(scopedQuery(pool, 'r72_affiliate_compliance_command', contextA,
      `INSERT INTO app.provider_operations (id) VALUES ($1)`, [randomUUID()]), '42501');
    const roleFacts = await ownerQuery<{
      can_insert_provider_operations: boolean;
      is_worker: boolean;
      can_bypass_rls: boolean;
    }>(pool,
      `SELECT
         has_table_privilege(
           'r72_affiliate_compliance_command', 'app.provider_operations', 'INSERT'
         ) AS can_insert_provider_operations,
         pg_has_role(
           'r72_affiliate_compliance_command', 'r72_worker', 'MEMBER'
         ) AS is_worker,
         rolbypassrls AS can_bypass_rls
       FROM pg_roles WHERE rolname = 'r72_affiliate_compliance_command'`);
    assert.deepEqual(roleFacts, [{
      can_insert_provider_operations: false,
      is_worker: false,
      can_bypass_rls: false,
    }]);

    await expectPostgresError(scopedQuery(pool, 'r72_affiliate_compliance_command', contextB,
      `INSERT INTO app_private.affiliate_compliance_channel_authority_events (
         id, workspace_id, subject_id, channel, content_class, authority_state,
         purpose_code, territory_code, sender_party_reference,
         account_scope_reference, authority_sha256, valid_from,
         recorded_by_user_id, recorded_request_id
       ) VALUES ($1, $2, $3, 'email', 'ordinary_product', 'approved',
         'affiliate_updates', 'GB', 'sender-fixture', 'account-fixture',
         decode($4, 'hex'), statement_timestamp(), $5, 'ignored')`,
      [randomUUID(), workspaceB, subjectA, HASH_C, ownerB]), '23503');
  } finally {
    await resetIdentityTables(pool);
    await pool.end();
  }
});
