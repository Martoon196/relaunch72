import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  PgPortalOwnedSeedMessageService,
  type PgPortalOwnedSeedMessageDependencies,
} from '../src/portal/owned-seed-message-pg-service.js';

const IDS = Object.freeze({
  workspace: '11111111-1111-4111-8111-111111111111',
  user: '22222222-2222-4222-8222-222222222222',
  contentVersion: '33333333-3333-4333-8333-333333333333',
  message: '44444444-4444-4444-8444-444444444444',
  messageVersion: '55555555-5555-4555-8555-555555555555',
  approvalRequest: '66666666-6666-4666-8666-666666666666',
});

test('portal resume resolves the active principal and binds the read to that portal session', async () => {
  const seen: unknown[] = [];
  const result = Object.freeze({
    messageId: IDS.message, messageVersionId: IDS.messageVersion,
    companyContentVersionId: IDS.contentVersion, phase: 'approved' as const,
    approvalRequestId: IDS.approvalRequest,
    subjectSha256: 'a'.repeat(64), bodySha256: 'b'.repeat(64),
    sourceContentSha256: 'c'.repeat(64),
    recipient: 'office@propertypredator.com' as const,
  });
  const dependencies = {
    principalResolver: {
      resolve: async () => ({ userId: IDS.user, workspaceId: IDS.workspace }),
    },
    messages: {
      resume: async (context: unknown, input: unknown) => {
        seen.push(context, input);
        return result;
      },
    },
  } as unknown as PgPortalOwnedSeedMessageDependencies;
  const service = new PgPortalOwnedSeedMessageService(dependencies);
  const identity = Object.freeze({
    sessionToken: 'active-owned-seed-session', requestId: 'resume-request-001',
  });
  assert.deepEqual(await service.resume(identity, {
    companyContentVersionId: IDS.contentVersion,
  }), { ok: true, result });
  assert.deepEqual(seen[1], { companyContentVersionId: IDS.contentVersion });
  assert.deepEqual(
    (seen[0] as { portalSessionTokenHash: Buffer }).portalSessionTokenHash,
    createHash('sha256').update(identity.sessionToken).digest(),
  );
});

test('portal resume returns unauthenticated without touching the message boundary', async () => {
  let called = false;
  const dependencies = {
    principalResolver: { resolve: async () => null },
    messages: { resume: async () => { called = true; return null; } },
  } as unknown as PgPortalOwnedSeedMessageDependencies;
  const service = new PgPortalOwnedSeedMessageService(dependencies);
  const outcome = await service.resume({
    sessionToken: 'expired-owned-seed-session', requestId: 'resume-request-002',
  }, { companyContentVersionId: IDS.contentVersion });
  assert.deepEqual(outcome, {
    ok: false, kind: 'unauthenticated',
    message: 'This portal session is no longer active.',
  });
  assert.equal(called, false);
});
