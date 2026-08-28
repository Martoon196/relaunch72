import assert from 'node:assert/strict';
import test from 'node:test';
import {
  COMPANY_CONTENT_EMAIL_DRAFT_MIME_TYPE,
  COMPANY_CONTENT_EMAIL_DRAFT_SCHEMA,
  type CompanyContentExactReview,
} from '../src/company-content-pg/index.js';
import { renderPortalCompanyContentReviewBody } from '../src/portal/company-content-review-view.js';
import type { OwnedSeedWorkflowState } from '../src/portal/owned-seed-actions.js';

const review: CompanyContentExactReview = Object.freeze({
  contentItemId: '11111111-1111-4111-8111-111111111111',
  contentVersionId: '22222222-2222-4222-8222-222222222222',
  versionNumber: 1,
  isLatest: true,
  origin: 'generated',
  kind: 'email',
  title: 'Owned-seed <welcome> draft',
  contentMimeType: COMPANY_CONTENT_EMAIL_DRAFT_MIME_TYPE,
  canonicalContent: '{"bodyText":"Hi <script>alert(1)</script> & review","schema":"propertypredator.email-draft/v1","subject":"A & B <today>"}',
  canonicalByteLength: 128,
  contentSha256: 'a'.repeat(64),
  source: Object.freeze({
    system: 'propertypredator.company-content',
    itemId: 'owned-seed-welcome',
    version: 'draft-v1',
  }),
  blobSha256: 'b'.repeat(64),
  brandSha256: 'c'.repeat(64),
  approvalRequestId: '33333333-3333-4333-8333-333333333333',
  approvalDecisionId: null,
  approvalStatus: 'pending',
  approvalStale: false,
  email: Object.freeze({
    schema: COMPANY_CONTENT_EMAIL_DRAFT_SCHEMA,
    subject: 'A & B <today>',
    bodyText: 'Hi <script>alert(1)</script> & review',
    subjectSha256: 'd'.repeat(64),
    bodySha256: 'e'.repeat(64),
  }),
  createdAt: '2026-08-28T14:00:00.000Z',
});

const approvedReview: CompanyContentExactReview = Object.freeze({
  ...review,
  approvalDecisionId: '55555555-5555-4555-8555-555555555555',
  approvalStatus: 'approved',
});

const workflow: OwnedSeedWorkflowState = Object.freeze({
  phase: 'drafted',
  companyContentVersionId: review.contentVersionId,
  messageId: '66666666-6666-4666-8666-666666666666',
  messageVersionId: '77777777-7777-4777-8777-777777777777',
  approvalRequestId: null,
  subjectSha256: 'd'.repeat(64),
  bodySha256: 'e'.repeat(64),
  sourceContentSha256: review.contentSha256,
});

const ownedSeedSecurity = Object.freeze({
  csrfToken: 'csrf_token_with_enough_entropy',
  ownedSeedAvailable: true,
  ownedSeedStageAvailable: true,
  ownedSeedCommandKey: 'owned-seed-command-key-001',
  ownedSeedWorkflowToken: `${'a'.repeat(48)}.${'b'.repeat(43)}`,
  ownedSeedRunId: '88888888-8888-4888-8888-888888888888',
});

function exactSnapshot(exactReview: CompanyContentExactReview = approvedReview, canManage = true) {
  return {
    workspace: Object.freeze({
      workspaceId: '44444444-4444-4444-8444-444444444444',
      workspaceName: 'Property Predator',
      snapshotAt: '2026-08-28T14:01:00.000Z',
      canWrite: true,
      canManage,
    }),
    review: exactReview,
  };
}

test('exact email review renders subject, body and hash proof without executable markup or provider controls', () => {
  const body = renderPortalCompanyContentReviewBody({
    workspace: Object.freeze({
      workspaceId: '44444444-4444-4444-8444-444444444444',
      workspaceName: 'Property Predator',
      snapshotAt: '2026-08-28T14:01:00.000Z',
      canWrite: true,
      canManage: true,
    }),
    review,
  });

  assert.match(body, /Exact email draft/);
  assert.match(body, /A &amp; B &lt;today&gt;/);
  assert.match(body, /Hi &lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; review/);
  assert.match(body, new RegExp(review.contentSha256));
  assert.match(body, new RegExp(review.email!.subjectSha256));
  assert.match(body, new RegExp(review.email!.bodySha256));
  assert.match(body, /Review page · no direct call/);
  assert.doesNotMatch(body, /<script\b/i);
  assert.doesNotMatch(body, /<form\b|<button\b|action=/i);
  assert.doesNotMatch(body, /Send now|Publish now|Schedule now/i);
});

test('exact review falls back to complete canonical bytes for non-email content', () => {
  const body = renderPortalCompanyContentReviewBody({
    workspace: Object.freeze({
      workspaceId: '44444444-4444-4444-8444-444444444444',
      workspaceName: 'Property Predator',
      snapshotAt: '2026-08-28T14:01:00.000Z',
      canWrite: true,
      canManage: true,
    }),
    review: Object.freeze({
      ...review,
      kind: 'document' as const,
      contentMimeType: 'text/plain',
      canonicalContent: 'Exact document bytes',
      canonicalByteLength: 20,
      email: null,
    }),
  });
  assert.match(body, /Exact immutable content/);
  assert.match(body, /Exact document bytes/);
});

test('pending exact review renders approval only with its short-lived exact-review capability', () => {
  const body = renderPortalCompanyContentReviewBody({
    workspace: Object.freeze({
      workspaceId: '44444444-4444-4444-8444-444444444444',
      workspaceName: 'Property Predator',
      snapshotAt: '2026-08-28T14:01:00.000Z',
      canWrite: true,
      canManage: true,
    }),
    review,
  }, {
    security: {
      csrfToken: 'csrf_token_with_enough_entropy',
      decisionCommandKey: 'decision-command-key-001',
      exactApprovalToken: `${review.contentItemId}.${review.contentVersionId}.${review.approvalRequestId}.${review.contentSha256}.1787994900000.capability_mac_value`,
    },
  });
  assert.match(body, /Approve exact version/);
  assert.match(body, /name="exact_approval_token"/);
  assert.match(body, /name="review_content_sha256"/);
  assert.doesNotMatch(body, /Send now|Publish now|Schedule now/i);
});

test('historical or stale exact versions remain read-only even with protected form material', () => {
  for (const stale of [
    { isLatest: false, approvalStale: false },
    { isLatest: true, approvalStale: true },
  ]) {
    const body = renderPortalCompanyContentReviewBody({
      workspace: Object.freeze({
        workspaceId: '44444444-4444-4444-8444-444444444444',
        workspaceName: 'Property Predator',
        snapshotAt: '2026-08-28T14:01:00.000Z',
        canWrite: true,
        canManage: true,
      }),
      review: Object.freeze({ ...review, ...stale }),
    }, {
      security: {
        csrfToken: 'csrf_token_with_enough_entropy',
        decisionCommandKey: 'decision-command-key-001',
        exactApprovalToken: `${review.contentItemId}.${review.contentVersionId}.${review.approvalRequestId}.${review.contentSha256}.1787994900000.capability_mac_value`,
      },
    });
    assert.match(body, /Historical version · read only/);
    assert.doesNotMatch(body, /<form\b|Approve exact version|Request human approval/i);
  }
});

test('approved current email exposes only the first owned-seed message-draft step', () => {
  const body = renderPortalCompanyContentReviewBody(exactSnapshot(), {
    security: ownedSeedSecurity,
  });

  assert.match(body, /Owned-seed delivery proof/);
  assert.match(body, /Step 1 of 4/);
  assert.match(body, /action="\/portal\/content\/owned-seed\/message"/);
  assert.match(body, new RegExp(`name="company_content_version_id" value="${review.contentVersionId}"`));
  assert.match(body, /Create LIVE message draft/);
  assert.match(body, /Controlled live boundary/);
  assert.match(body, /final stage button creates one LIVE delivery intent/);
  assert.match(body, /office@propertypredator\.com/);
  assert.doesNotMatch(body, /Send now|Publish now|Schedule now/i);
});

test('drafted owned-seed message exposes its separate approval request', () => {
  const body = renderPortalCompanyContentReviewBody(exactSnapshot(), {
    security: { ...ownedSeedSecurity, ownedSeedWorkflow: workflow },
  });

  assert.match(body, /Approve the LIVE message/);
  assert.match(body, /Step 2 of 4/);
  assert.match(body, /action="\/portal\/content\/owned-seed\/message\/approval-request"/);
  assert.match(body, new RegExp(`name="message_id" value="${workflow.messageId}"`));
  assert.match(body, /name="owned_seed_workflow_token"/);
  assert.match(body, /Request message approval/);
  assert.doesNotMatch(body, /Stage capped office-only job/);
});

test('pending owned-seed message exposes manager decision for the exact request', () => {
  const pendingWorkflow: OwnedSeedWorkflowState = Object.freeze({
    ...workflow,
    phase: 'approval_pending',
    approvalRequestId: '99999999-9999-4999-8999-999999999999',
  });
  const body = renderPortalCompanyContentReviewBody(exactSnapshot(), {
    security: { ...ownedSeedSecurity, ownedSeedWorkflow: pendingWorkflow },
  });

  assert.match(body, /Decide the LIVE message/);
  assert.match(body, /Step 3 of 4/);
  assert.match(body, /action="\/portal\/content\/owned-seed\/message\/approval-decision"/);
  assert.match(body, new RegExp(`name="approval_request_id" value="${pendingWorkflow.approvalRequestId}"`));
  assert.match(body, /Approve LIVE message/);
  assert.match(body, /Request changes/);
  assert.match(body, /Reject message/);

  const readOnly = renderPortalCompanyContentReviewBody(exactSnapshot(approvedReview, false), {
    security: { ...ownedSeedSecurity, ownedSeedWorkflow: pendingWorkflow },
  });
  assert.match(readOnly, /cannot advance/i);
  assert.doesNotMatch(readOnly, /Approve LIVE message/);
});

test('approved LIVE message exposes capped office-only staging without a provider-send control', () => {
  const approvedWorkflow: OwnedSeedWorkflowState = Object.freeze({
    ...workflow,
    phase: 'approved',
    approvalRequestId: '99999999-9999-4999-8999-999999999999',
  });
  const body = renderPortalCompanyContentReviewBody(exactSnapshot(), {
    security: { ...ownedSeedSecurity, ownedSeedWorkflow: approvedWorkflow },
  });

  assert.match(body, /Stage the office-only proof/);
  assert.match(body, /Step 4 of 4/);
  assert.match(body, /action="\/portal\/content\/owned-seed\/stage"/);
  assert.match(body, new RegExp(`name="run_id" value="${ownedSeedSecurity.ownedSeedRunId}"`));
  assert.match(body, /Stage capped office-only job/);
  assert.match(body, /one message per run and three per month/);
  assert.doesNotMatch(body, /Send now|Publish now|Schedule now/i);
});

test('staged and mismatched owned-seed states expose evidence only', () => {
  const staged: OwnedSeedWorkflowState = Object.freeze({
    ...workflow,
    phase: 'staged',
    approvalRequestId: '99999999-9999-4999-8999-999999999999',
  });
  const stagedBody = renderPortalCompanyContentReviewBody(exactSnapshot(), {
    security: { ...ownedSeedSecurity, ownedSeedWorkflow: staged },
  });
  assert.match(stagedBody, /Owned-seed job staged/);
  assert.match(stagedBody, /Delivery may already have been attempted/);
  assert.match(stagedBody, /signed receipt ledger/);
  assert.doesNotMatch(stagedBody, /Stage capped office-only job/);

  const mismatchBody = renderPortalCompanyContentReviewBody(exactSnapshot(), {
    security: {
      ...ownedSeedSecurity,
      ownedSeedWorkflow: Object.freeze({
        ...workflow,
        companyContentVersionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      }),
    },
  });
  assert.match(mismatchBody, /different immutable company-content version/);
  assert.doesNotMatch(mismatchBody, /Request message approval|Stage capped office-only job/);
});

test('owned-seed workflow is absent until exact current email approval exists', () => {
  for (const ineligibleReview of [
    review,
    Object.freeze({ ...approvedReview, approvalStale: true }),
    Object.freeze({ ...approvedReview, isLatest: false }),
    Object.freeze({ ...approvedReview, email: null }),
  ]) {
    const body = renderPortalCompanyContentReviewBody(exactSnapshot(ineligibleReview), {
      security: ownedSeedSecurity,
    });
    assert.doesNotMatch(body, /Owned-seed delivery proof|Create LIVE message draft/);
  }
});

test('editor can inspect approved proof copy but cannot advance owner-only owned-seed commands', () => {
  const body = renderPortalCompanyContentReviewBody(exactSnapshot(approvedReview, false), {
    security: ownedSeedSecurity,
  });
  assert.match(body, /Owned-seed proof · inspect only/);
  assert.doesNotMatch(body, /Create LIVE message draft|Request message approval|Stage capped office-only job/);
});
