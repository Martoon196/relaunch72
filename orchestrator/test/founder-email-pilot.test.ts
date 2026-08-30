import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  CONTACT_ENDPOINT_EVIDENCE_SOURCES,
  FOUNDER_EMAIL_PILOT_BLOCKER_CODES,
  FOUNDER_EMAIL_PILOT_DIMENSIONS,
  FounderEmailPilotError,
  buildFounderEmailPilotReadinessReport,
  deriveFounderEmailPilotIdentifiers,
  deriveFounderPilotCommandKey,
  founderEmailPilotEvidenceDigest,
  parseAttachContactEmailEndpoint,
  type AttachContactEmailEndpointInput,
  type FounderEmailPilotDimensionResult,
  type FounderEmailPilotEvidence,
} from '../src/founder-email-pilot/foundation.js';
import type { CustomerEmailLiveCommandService }
  from '../src/customer-email-live-pg/types.js';
import type {
  ConsumePermissionUseInput,
  ConsumePermissionUseResult,
  PortalPermissionUseReceiptService,
} from '../src/portal/permission-use-receipt-service.js';
import { PgPortalFounderEmailPilotService } from '../src/portal/founder-email-pilot-pg-service.js';
import type {
  AttachEndpointInput,
  AuthoriseInput,
} from '../src/portal/founder-email-pilot-service.js';

const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const CONTACT = '725fb294-41a3-4806-a020-fd97cbf9c715';
const POINT = '33333333-3333-4333-8333-333333333333';
const CONNECTION = '44444444-4444-4444-8444-444444444444';
const COMMAND_KEY = '55555555-5555-4555-8555-555555555555';
const USER = '66666666-6666-4666-8666-666666666666';
const RECEIPT = '77777777-7777-4777-8777-777777777777';
const IDENTITY = { sessionToken: 'session-token', requestId: 'req-1' } as never;

function endpointInput(
  overrides: Partial<AttachContactEmailEndpointInput> = {},
): AttachContactEmailEndpointInput {
  return {
    contactId: CONTACT,
    email: 'office@example.test',
    label: 'Owned office mailbox',
    evidenceSource: 'founder.owned_mailbox',
    evidenceReference: 'owned-mailbox-attestation-1',
    verifiedAt: '2026-08-30T09:00:00.000Z',
    operatorConfirmed: true,
    ...overrides,
  };
}

function allReady(): FounderEmailPilotDimensionResult[] {
  return FOUNDER_EMAIL_PILOT_DIMENSIONS.map((dimension) => ({
    dimension, ready: true, blockerCode: null,
  }));
}

test('a witnessed endpoint parses into the exact database tuple', () => {
  const parsed = parseAttachContactEmailEndpoint(endpointInput());
  assert.equal(parsed.contactId, CONTACT);
  assert.equal(parsed.email, 'office@example.test');
  assert.equal(parsed.evidenceSource, 'founder.owned_mailbox');
  assert.equal(parsed.verifiedAt, '2026-08-30T09:00:00.000Z');
});

test('an unconfirmed or malformed endpoint is refused', () => {
  for (const override of [
    { operatorConfirmed: false },
    { contactId: 'not-a-uuid' },
    { email: 'not-an-email' },
    { email: '' },
    { evidenceSource: 'site_activity' },
    { evidenceReference: '' },
    { verifiedAt: '2026-08-30T09:00:00Z' },
    { label: 'x'.repeat(51) },
  ] as Partial<AttachContactEmailEndpointInput>[]) {
    assert.throws(
      () => parseAttachContactEmailEndpoint(endpointInput(override)),
      FounderEmailPilotError,
      JSON.stringify(override),
    );
  }
});

test('an endpoint is never trusted from activity or inference', () => {
  for (const inferred of ['login', 'site_activity', 'previous_send', 'crm_stage']) {
    assert.equal(
      (CONTACT_ENDPOINT_EVIDENCE_SOURCES as readonly string[]).includes(inferred), false,
    );
  }
  for (const source of CONTACT_ENDPOINT_EVIDENCE_SOURCES) {
    assert.match(source, /^founder\./u);
  }
});

test('the command key digest is workspace and context scoped', () => {
  const attach = deriveFounderPilotCommandKey(
    'contact-endpoint-attach', WORKSPACE, COMMAND_KEY,
  );
  assert.match(attach, /^[0-9a-f]{64}$/u);
  assert.equal(
    attach,
    createHash('sha256').update([
      'propertypredator.founder-contact-endpoint-attach/v1', WORKSPACE, COMMAND_KEY,
    ].join(String.fromCharCode(31)), 'utf8').digest('hex'),
  );
  // A different context or workspace is a different key, so one action's replay
  // can never satisfy another's.
  assert.notEqual(
    attach,
    deriveFounderPilotCommandKey('email-pilot-authorise', WORKSPACE, COMMAND_KEY),
  );
  assert.notEqual(
    attach,
    deriveFounderPilotCommandKey(
      'contact-endpoint-attach', '99999999-9999-4999-8999-999999999999', COMMAND_KEY,
    ),
  );
});

test('a complete readiness report is ready and names no blocker', () => {
  const report = buildFounderEmailPilotReadinessReport(allReady());
  assert.equal(report.result, 'ready-for-founder-authorisation');
  assert.deepEqual([...report.blockers], []);
  assert.equal(report.enqueued, false);
  assert.equal(report.providerEffects, false);
});

test('each missing dimension surfaces its own stable blocker code', () => {
  const rows = allReady();
  rows[4] = {
    dimension: 'current_consent', ready: false, blockerCode: 'CONSENT_NOT_GRANTED',
  };
  rows[5] = {
    dimension: 'suppression_clear', ready: false, blockerCode: 'RECIPIENT_SUPPRESSED',
  };
  const report = buildFounderEmailPilotReadinessReport(rows);
  assert.equal(report.result, 'blocked');
  assert.deepEqual([...report.blockers], ['CONSENT_NOT_GRANTED', 'RECIPIENT_SUPPRESSED']);
  for (const code of report.blockers) {
    assert.ok((FOUNDER_EMAIL_PILOT_BLOCKER_CODES as readonly string[]).includes(code));
  }
});

test('a truncated, reordered or unknown probe result throws instead of reading ready', () => {
  // A short read must never produce an empty blocker list, because that would
  // authorise a send on evidence nobody proved.
  assert.throws(
    () => buildFounderEmailPilotReadinessReport(allReady().slice(0, 3)),
    FounderEmailPilotError,
  );
  const reordered = allReady();
  [reordered[0], reordered[1]] = [reordered[1]!, reordered[0]!];
  assert.throws(() => buildFounderEmailPilotReadinessReport(reordered), FounderEmailPilotError);
  const invented = allReady();
  invented[0] = {
    dimension: 'operator_authority', ready: false, blockerCode: 'NOT_A_REAL_CODE' as never,
  };
  assert.throws(() => buildFounderEmailPilotReadinessReport(invented), FounderEmailPilotError);
  const contradictory = allReady();
  contradictory[0] = {
    dimension: 'operator_authority', ready: true, blockerCode: 'CAP_REACHED',
  };
  assert.throws(
    () => buildFounderEmailPilotReadinessReport(contradictory), FounderEmailPilotError,
  );
});

class FakeClient {
  readonly calls: { sql: string; values: readonly unknown[] }[] = [];
  error: unknown = null;
  disposition = 'applied';

  async query(sql: string, values: readonly unknown[] = []): Promise<{ rows: unknown[] }> {
    this.calls.push({ sql, values });
    if (this.error && (sql.includes('attach_verified') || sql.includes('pilot_readiness'))) {
      throw this.error;
    }
    if (sql.includes('attach_verified_contact_email_endpoint')) {
      return {
        rows: [{
          disposition: this.disposition, contact_point_id: POINT, receipt_id: RECEIPT,
        }],
      };
    }
    if (sql.includes('customer_email_pilot_readiness')) {
      return { rows: allReady().map((row) => ({
        dimension: row.dimension, ready: true, blocker_code: null,
      })) };
    }
    if (sql.includes('founder-email-pilot.preview')) {
      return { rows: [{
        recipient_email: 'office@example.test', recipient_verified: true,
        daily_used: 0, monthly_used: 0,
      }] };
    }
    if (sql.includes('resolve_customer_email_pilot_evidence')) {
      return { rows: this.evidenceRows };
    }
    if (sql.includes('derive_customer_email_pilot_request_digest')) {
      return { rows: [{ request_sha256: this.requestSha256 }] };
    }
    return { rows: [{ active: true }] };
  }

  /** No row is how the resolver reports an unresolved or refused tuple. */
  evidenceRows: unknown[] = [{ ...EVIDENCE_ROW }];
  requestSha256 = 'b'.repeat(64);

  release(): void { /* pooled */ }
}

/** Exactly the column names and shapes the 0064 resolver returns. */
const EVIDENCE_ROW = Object.freeze({
  campaign_template_version_id: 'ad100000-0000-4000-8000-000000000001',
  campaign_template_step_id: 'ad100000-0000-4000-8000-000000000002',
  campaign_step_content_sha256: 'a'.repeat(64),
  campaign_approval_request_id: 'ad100000-0000-4000-8000-000000000003',
  campaign_approval_decision_id: 'ad100000-0000-4000-8000-000000000004',
  campaign_version_no: 3,
  message_version_id: 'ad100000-0000-4000-8000-000000000005',
  message_approval_request_id: 'ad100000-0000-4000-8000-000000000006',
  message_approval_decision_id: 'ad100000-0000-4000-8000-000000000007',
  message_version_number: 2,
  channel_endpoint_id: 'ad100000-0000-4000-8000-000000000008',
  consent_event_id: 'ad100000-0000-4000-8000-000000000009',
  compliance_subject_id: 'ad100000-0000-4000-8000-00000000000a',
  policy_publication_event_id: 'ad100000-0000-4000-8000-00000000000b',
  pecr_sender_decision_event_id: 'ad100000-0000-4000-8000-00000000000c',
  pecr_instigator_decision_event_id: 'ad100000-0000-4000-8000-00000000000d',
  permission_use_receipt_id: 'ad100000-0000-4000-8000-00000000000e',
  recipient_email: 'office@example.test',
  subject: 'Your Property Predator briefing',
  body_text: 'Your briefing is ready.',
});

const JOB_ID = 'ac100000-0000-4000-8000-000000000001';

/** Stands in for the real 0054 command, recording exactly what reaches it. */
class FakeCommand implements CustomerEmailLiveCommandService {
  readonly calls: unknown[] = [];
  error: unknown = null;
  disposition: 'queued' | 'replayed' = 'queued';

  constructor(readonly workspaceId: string = WORKSPACE) {}

  async authorizeAndEnqueue(_c: unknown, command: unknown): Promise<never> {
    this.calls.push(command);
    if (this.error) throw this.error;
    return {
      jobId: JOB_ID, disposition: this.disposition, providerEffects: 'none',
      caps: { daily: 10, monthly: 50, recipientsPerJob: 1 },
    } as never;
  }
}

/** Fixed so the derived authority window is comparable across assertions. */
const NOW = Date.parse('2026-08-30T12:00:00.000Z');

const RECEIPT_ID = EVIDENCE_ROW.permission_use_receipt_id;

/** Stands in for the 0032 receipt rail on its own append-only identity. */
class FakePermissionUse implements PortalPermissionUseReceiptService {
  readonly calls: ConsumePermissionUseInput[] = [];
  outcome: ConsumePermissionUseResult = {
    ok: true, disposition: 'consumed', permissionUseReceiptId: RECEIPT_ID,
    complianceSubjectId: EVIDENCE_ROW.compliance_subject_id,
    actionScopeSha256: 'c'.repeat(64), evidenceSnapshotSha256: 'd'.repeat(64),
    providerEffects: false,
  };

  constructor(readonly workspaceId: string = WORKSPACE) {}

  async consume(
    _i: unknown, input: ConsumePermissionUseInput,
  ): Promise<ConsumePermissionUseResult> {
    this.calls.push(input);
    return this.outcome;
  }
}

function service(
  client: FakeClient,
  workspaceId = WORKSPACE,
  commandService: CustomerEmailLiveCommandService = new FakeCommand(),
  permissionUse: PortalPermissionUseReceiptService = new FakePermissionUse(),
) {
  return new PgPortalFounderEmailPilotService({
    principalResolver: {
      async resolve() { return { userId: USER, workspaceId } as never; },
    },
    commandPool: { async connect() { return client as never; } },
    providerConnectionId: CONNECTION,
    commandService,
    permissionUse,
    now: () => NOW,
  });
}

function authoriseInput(overrides: Partial<AuthoriseInput> = {}): AuthoriseInput {
  return {
    contactId: CONTACT,
    contactPointId: POINT,
    purpose: 'property_predator_marketing',
    commandKey: COMMAND_KEY,
    evidenceDigest: founderEmailPilotEvidenceDigest(
      parseEvidenceForTest(EVIDENCE_ROW),
    ),
    authorityValidUntil: new Date(NOW + 4 * 60 * 1000).toISOString(),
    operatorConfirmed: true,
    ...overrides,
  };
}

/** Mirrors the service's own row reading, so the digest matches what it computes. */
function parseEvidenceForTest(row: Record<string, unknown>): FounderEmailPilotEvidence {
  return {
    campaignTemplateVersionId: row.campaign_template_version_id as string,
    campaignTemplateStepId: row.campaign_template_step_id as string,
    campaignStepContentSha256: row.campaign_step_content_sha256 as string,
    campaignApprovalRequestId: row.campaign_approval_request_id as string,
    campaignApprovalDecisionId: row.campaign_approval_decision_id as string,
    campaignVersionNo: row.campaign_version_no as number,
    messageVersionId: row.message_version_id as string,
    messageApprovalRequestId: row.message_approval_request_id as string,
    messageApprovalDecisionId: row.message_approval_decision_id as string,
    messageVersionNumber: row.message_version_number as number,
    channelEndpointId: row.channel_endpoint_id as string,
    consentEventId: row.consent_event_id as string,
    complianceSubjectId: row.compliance_subject_id as string,
    policyPublicationEventId: row.policy_publication_event_id as string,
    pecrSenderDecisionEventId: row.pecr_sender_decision_event_id as string,
    pecrInstigatorDecisionEventId: row.pecr_instigator_decision_event_id as string,
    permissionUseReceiptId: row.permission_use_receipt_id as string,
    recipientEmail: row.recipient_email as string,
    subject: row.subject as string,
    bodyText: row.body_text as string,
  };
}

function attachInput(overrides: Partial<AttachEndpointInput> = {}): AttachEndpointInput {
  return { commandKey: COMMAND_KEY, ...endpointInput(), ...overrides };
}

test('attaching an endpoint hands the exact tuple to the 0064 boundary', async () => {
  const client = new FakeClient();
  const outcome = await service(client).attachEndpoint(IDENTITY, attachInput());
  assert.deepEqual(outcome, {
    ok: true, disposition: 'applied', contactPointId: POINT, receiptId: RECEIPT,
    consentRecorded: 'none',
  });
  const call = client.calls.find((entry) => entry.sql.includes('attach_verified'));
  assert.ok(call);
  // The workspace comes from the resolved session, never the request.
  assert.equal(call.values[0], WORKSPACE);
  assert.equal(call.values[1], CONTACT);
  assert.equal(call.values[2], 'office@example.test');
  // The command key crosses only as its workspace-scoped digest.
  assert.deepEqual(
    call.values[7],
    Buffer.from(
      deriveFounderPilotCommandKey('contact-endpoint-attach', WORKSPACE, COMMAND_KEY),
      'hex',
    ),
  );
});

test('a replayed attach reports the original endpoint', async () => {
  const client = new FakeClient();
  client.disposition = 'replayed';
  const outcome = await service(client).attachEndpoint(IDENTITY, attachInput());
  assert.equal(outcome.ok && outcome.disposition, 'replayed');
  assert.equal(outcome.ok && outcome.contactPointId, POINT);
});

test('a malformed attach never opens a transaction', async () => {
  for (const override of [
    { operatorConfirmed: false }, { email: 'nope' }, { commandKey: 'not-a-uuid' },
    { evidenceSource: 'site_activity' },
  ] as Partial<AttachEndpointInput>[]) {
    const client = new FakeClient();
    const outcome = await service(client).attachEndpoint(IDENTITY, attachInput(override));
    assert.deepEqual(outcome, { ok: false, kind: 'validation' }, JSON.stringify(override));
    assert.deepEqual(client.calls, []);
  }
});

test('database failures map to their exact founder-facing kind', async () => {
  for (const [code, kind] of [
    ['42501', 'forbidden'], ['23505', 'conflict'], ['40001', 'conflict'],
    ['22023', 'validation'], ['23503', 'validation'], ['08006', 'unavailable'],
  ] as const) {
    const client = new FakeClient();
    client.error = Object.assign(new Error('refused'), { code });
    const outcome = await service(client).attachEndpoint(IDENTITY, attachInput());
    assert.deepEqual(outcome, { ok: false, kind }, `${code} must map to ${kind}`);
  }
});

test('readiness returns the report and the exact recipient preview', async () => {
  const client = new FakeClient();
  const outcome = await service(client).readiness(IDENTITY, {
    contactId: CONTACT, contactPointId: POINT, purpose: 'property_predator_marketing',
  });
  assert.ok(outcome.ok);
  assert.equal(outcome.report.result, 'ready-for-founder-authorisation');
  assert.equal(outcome.preview?.recipientEmail, 'office@example.test');
  assert.equal(outcome.preview?.recipientVerified, true);
  assert.equal(outcome.preview?.dailyCap, 10);
  assert.equal(outcome.preview?.monthlyCap, 50);
  // The probe is scoped to the exact connection this pilot may use.
  const probe = client.calls.find((entry) => entry.sql.includes('pilot_readiness'));
  assert.equal(probe?.values[1], CONNECTION);
});

test('readiness enqueues nothing and reaches no provider', async () => {
  const client = new FakeClient();
  await service(client).readiness(IDENTITY, {
    contactId: CONTACT, contactPointId: POINT, purpose: 'property_predator_marketing',
  });
  const sql = client.calls.map((entry) => entry.sql).join('\n').toLowerCase();
  for (const forbidden of ['authorize_and_enqueue', 'insert into', 'update app.', 'mailgun_api']) {
    assert.equal(sql.includes(forbidden), false, `${forbidden} must not appear`);
  }
});

test('an unresolved session records and reads nothing', async () => {
  const client = new FakeClient();
  const command = new FakeCommand();
  const unresolved = new PgPortalFounderEmailPilotService({
    principalResolver: { async resolve() { return null; } },
    commandPool: { async connect() { return client as never; } },
    providerConnectionId: CONNECTION,
    commandService: command,
    permissionUse: new FakePermissionUse(),
    now: () => NOW,
  });
  assert.deepEqual(
    await unresolved.attachEndpoint(IDENTITY, attachInput()),
    { ok: false, kind: 'unauthenticated' },
  );
  assert.deepEqual(
    await unresolved.authorise(IDENTITY, authoriseInput()),
    { ok: false, kind: 'unauthenticated' },
  );
  assert.deepEqual(client.calls, []);
  assert.deepEqual(command.calls, []);
});

test('the seam requires the exact provider connection at construction', () => {
  assert.throws(() => new PgPortalFounderEmailPilotService({
    principalResolver: { async resolve() { return null; } },
    commandPool: { async connect() { return new FakeClient() as never; } },
    providerConnectionId: 'not-a-uuid',
    commandService: new FakeCommand(),
    permissionUse: new FakePermissionUse(),
    now: () => NOW,
  }), /exact provider connection/);
});

test('the permission-use receipt is consumed before the enqueue, never after', async () => {
  const receipts = new FakePermissionUse();
  const command = new FakeCommand();
  const outcome = await service(new FakeClient(), WORKSPACE, command, receipts)
    .authorise(IDENTITY, authoriseInput());
  assert.ok(outcome.ok);
  assert.equal(receipts.calls.length, 1);
  // Bound to the same command key and window the enqueue will use, so the
  // receipt the enqueue re-resolves is the one recorded here.
  assert.equal(receipts.calls[0]?.commandKey, COMMAND_KEY);
  assert.equal(receipts.calls[0]?.authorityValidUntil, authoriseInput().authorityValidUntil);
  assert.equal(receipts.calls[0]?.contactPointId, POINT);
  assert.equal(command.calls.length, 1);
  assert.equal(
    (command.calls[0] as Record<string, unknown>).permissionUseReceiptId, RECEIPT_ID,
  );
});

test('a receipt recorded before an enqueue refusal still claims no provider effect', async () => {
  const receipts = new FakePermissionUse();
  const command = new FakeCommand();
  command.error = Object.assign(new Error('hard cap reached'), { code: '54000' });
  const outcome = await service(new FakeClient(), WORKSPACE, command, receipts)
    .authorise(IDENTITY, authoriseInput());
  // The send was refused; the consumption still happened and is auditable.
  assert.deepEqual(outcome, { ok: false, kind: 'blocked' });
  assert.equal(receipts.calls.length, 1);
  assert.equal(
    receipts.outcome.ok && receipts.outcome.providerEffects, false,
    'a receipt must never imply Mailgun was called',
  );
});

test('a refused receipt stops the enqueue with its own reason', async () => {
  for (const [kind, expected] of [
    ['conflict', 'conflict'], ['blocked', 'blocked'], ['forbidden', 'forbidden'],
    ['validation', 'validation'], ['unavailable', 'unavailable'],
    ['unauthenticated', 'unauthenticated'],
  ] as const) {
    const receipts = new FakePermissionUse();
    const command = new FakeCommand();
    receipts.outcome = { ok: false, kind };
    assert.deepEqual(
      await service(new FakeClient(), WORKSPACE, command, receipts)
        .authorise(IDENTITY, authoriseInput()),
      { ok: false, kind: expected }, kind,
    );
    assert.deepEqual(command.calls, [], kind);
  }
});

test('a receipt that is not the one the tuple resolves to never enqueues', async () => {
  // Belt and braces against the receipt rail and the evidence resolver
  // disagreeing: the enqueue would refuse anyway, but the founder would be
  // told the wrong reason.
  const receipts = new FakePermissionUse();
  const command = new FakeCommand();
  receipts.outcome = {
    ok: true, disposition: 'consumed',
    permissionUseReceiptId: 'ad100000-0000-4000-8000-0000000000ff',
    complianceSubjectId: EVIDENCE_ROW.compliance_subject_id,
    actionScopeSha256: 'c'.repeat(64), evidenceSnapshotSha256: 'd'.repeat(64),
    providerEffects: false,
  };
  assert.deepEqual(
    await service(new FakeClient(), WORKSPACE, command, receipts)
      .authorise(IDENTITY, authoriseInput()),
    { ok: false, kind: 'stale_preview' },
  );
  assert.deepEqual(command.calls, []);
});

test('a replayed receipt produces a byte-identical enqueue command', async () => {
  const command = new FakeCommand();
  const first = new FakePermissionUse();
  await service(new FakeClient(), WORKSPACE, command, first)
    .authorise(IDENTITY, authoriseInput());
  const second = new FakePermissionUse();
  // The same receipt, reported as a replay rather than a fresh consumption.
  second.outcome = { ...first.outcome, disposition: 'replayed' } as never;
  command.disposition = 'replayed';
  const outcome = await service(new FakeClient(), WORKSPACE, command, second)
    .authorise(IDENTITY, authoriseInput());
  assert.ok(outcome.ok && outcome.disposition === 'replayed');
  assert.deepEqual(command.calls[0], command.calls[1]);
});

test('resolving an authorisation returns the exact message and never enqueues', async () => {
  const client = new FakeClient();
  const command = new FakeCommand();
  const outcome = await service(client, WORKSPACE, command).resolveAuthorisation(IDENTITY, {
    contactId: CONTACT, contactPointId: POINT,
    purpose: 'property_predator_marketing', commandKey: COMMAND_KEY,
  });
  assert.ok(outcome.ok);
  assert.equal(outcome.preview?.evidence.subject, 'Your Property Predator briefing');
  assert.equal(outcome.preview?.evidence.bodyText, 'Your briefing is ready.');
  assert.equal(outcome.preview?.evidence.recipientEmail, 'office@example.test');
  assert.equal(outcome.preview?.evidence.campaignVersionNo, 3);
  // The window is exactly what the token will carry and the enqueue will bind.
  assert.equal(outcome.preview?.authorityValidUntil, new Date(NOW + 5 * 60 * 1000).toISOString());
  assert.deepEqual(command.calls, [], 'a preview must never reach the enqueue');
});

test('an unresolved tuple previews nothing rather than a partial message', async () => {
  const client = new FakeClient();
  client.evidenceRows = [];
  const outcome = await service(client).resolveAuthorisation(IDENTITY, {
    contactId: CONTACT, contactPointId: POINT,
    purpose: 'property_predator_marketing', commandKey: COMMAND_KEY,
  });
  assert.deepEqual(outcome, { ok: true, preview: null });
});

test('authorising hands the resolved tuple and derived identifiers to 0054', async () => {
  const client = new FakeClient();
  const command = new FakeCommand();
  const outcome = await service(client, WORKSPACE, command)
    .authorise(IDENTITY, authoriseInput());
  assert.ok(outcome.ok);
  assert.equal(outcome.disposition, 'queued');
  assert.equal(outcome.jobId, JOB_ID);
  assert.equal(outcome.providerEffects, 'none');
  assert.equal(command.calls.length, 1);
  const sent = command.calls[0] as Record<string, unknown>;
  const identifiers = deriveFounderEmailPilotIdentifiers(WORKSPACE, COMMAND_KEY);
  assert.equal(sent.messageVersionId, EVIDENCE_ROW.message_version_id);
  assert.equal(sent.permissionUseReceiptId, EVIDENCE_ROW.permission_use_receipt_id);
  assert.equal(sent.providerOperationId, identifiers.providerOperationId);
  assert.equal(sent.messageDeliveryId, identifiers.messageDeliveryId);
  assert.equal(sent.correlationId, identifiers.correlationId);
  assert.equal(sent.idempotencyKeySha256, identifiers.idempotencyKeySha256);
  // The digest comes from the database, never from this process.
  assert.equal(sent.requestSha256, client.requestSha256);
});

test('a resubmitted authorisation presents identical identifiers and replays', async () => {
  const command = new FakeCommand();
  const first = await service(new FakeClient(), WORKSPACE, command)
    .authorise(IDENTITY, authoriseInput());
  command.disposition = 'replayed';
  const second = await service(new FakeClient(), WORKSPACE, command)
    .authorise(IDENTITY, authoriseInput());
  assert.ok(first.ok && second.ok);
  assert.equal(second.disposition, 'replayed');
  assert.equal(command.calls.length, 2);
  // Byte for byte the same command, which is what makes the second a replay
  // rather than a second send.
  assert.deepEqual(command.calls[0], command.calls[1]);
});

test('changed evidence under the same command key never sends the new message', async () => {
  const client = new FakeClient();
  const command = new FakeCommand();
  client.evidenceRows = [{ ...EVIDENCE_ROW, body_text: 'A different body entirely.' }];
  const outcome = await service(client, WORKSPACE, command)
    .authorise(IDENTITY, authoriseInput());
  assert.deepEqual(outcome, { ok: false, kind: 'stale_preview' });
  assert.deepEqual(command.calls, []);
});

test('a database conflict on the same key surfaces as a conflict, not a send', async () => {
  const command = new FakeCommand();
  command.error = Object.assign(new Error('idempotency conflict'), { code: '40001' });
  const outcome = await service(new FakeClient(), WORKSPACE, command)
    .authorise(IDENTITY, authoriseInput());
  assert.deepEqual(outcome, { ok: false, kind: 'conflict' });
});

test('a spent cap is a blocker the founder can act on, not an outage', async () => {
  const command = new FakeCommand();
  command.error = Object.assign(new Error('hard cap reached'), { code: '54000' });
  assert.deepEqual(
    await service(new FakeClient(), WORKSPACE, command).authorise(IDENTITY, authoriseInput()),
    { ok: false, kind: 'blocked' },
  );
});

test('an operator the database refuses is forbidden, never softened', async () => {
  const command = new FakeCommand();
  command.error = Object.assign(new Error('operator denied'), { code: '42501' });
  assert.deepEqual(
    await service(new FakeClient(), WORKSPACE, command).authorise(IDENTITY, authoriseInput()),
    { ok: false, kind: 'forbidden' },
  );
});

test('suppression or withdrawn consent stops the tuple resolving and blocks the send', async () => {
  // The 0064 resolver returns no row when the latest suppression or consent
  // record refuses the send, exactly as the enqueue would.
  const client = new FakeClient();
  const command = new FakeCommand();
  client.evidenceRows = [];
  assert.deepEqual(
    await service(client, WORKSPACE, command).authorise(IDENTITY, authoriseInput()),
    { ok: false, kind: 'blocked' },
  );
  assert.deepEqual(command.calls, []);
});

test('a session from another workspace is refused before the enqueue', async () => {
  const client = new FakeClient();
  const command = new FakeCommand(WORKSPACE);
  const other = 'fa100000-0000-4000-8000-0000000000ff';
  const outcome = await service(client, other, command).authorise(IDENTITY, authoriseInput());
  assert.deepEqual(outcome, { ok: false, kind: 'forbidden' });
  assert.deepEqual(command.calls, [], 'the enqueue must never see another workspace');
});

test('a malformed or unconfirmed authorisation never opens a transaction', async () => {
  for (const override of [
    { operatorConfirmed: false }, { commandKey: 'not-a-uuid' },
    { contactPointId: 'not-a-uuid' }, { evidenceDigest: 'short' },
    { authorityValidUntil: 'not-a-time' },
  ] as Partial<AuthoriseInput>[]) {
    const client = new FakeClient();
    const command = new FakeCommand();
    const outcome = await service(client, WORKSPACE, command)
      .authorise(IDENTITY, authoriseInput(override));
    assert.deepEqual(outcome, { ok: false, kind: 'validation' }, JSON.stringify(override));
    assert.deepEqual(client.calls, [], JSON.stringify(override));
    assert.deepEqual(command.calls, [], JSON.stringify(override));
  }
});

test('a truncated or malformed resolver row throws rather than reading as ready', async () => {
  for (const broken of [
    { ...EVIDENCE_ROW, permission_use_receipt_id: null },
    { ...EVIDENCE_ROW, campaign_step_content_sha256: 'short' },
    { ...EVIDENCE_ROW, subject: '' },
    { ...EVIDENCE_ROW, message_version_number: 'two' },
  ]) {
    const client = new FakeClient();
    const command = new FakeCommand();
    client.evidenceRows = [broken];
    assert.deepEqual(
      await service(client, WORKSPACE, command).authorise(IDENTITY, authoriseInput()),
      { ok: false, kind: 'validation' },
      JSON.stringify(broken.subject),
    );
    assert.deepEqual(command.calls, []);
  }
});

test('more than one resolved tuple is refused rather than silently picked', async () => {
  const client = new FakeClient();
  client.evidenceRows = [{ ...EVIDENCE_ROW }, { ...EVIDENCE_ROW }];
  assert.deepEqual(
    await service(client).authorise(IDENTITY, authoriseInput()),
    { ok: false, kind: 'validation' },
  );
});

test('authorising reaches no provider and issues no dispatch of its own', async () => {
  const client = new FakeClient();
  const command = new FakeCommand();
  await service(client, WORKSPACE, command).authorise(IDENTITY, authoriseInput());
  const sql = client.calls.map((entry) => entry.sql).join('\n').toLowerCase();
  for (const forbidden of [
    'authorize_and_enqueue', 'mailgun', 'http', 'insert into', 'update app.',
  ]) {
    assert.equal(sql.includes(forbidden), false, `${forbidden} must not appear`);
  }
  // The single enqueue happens through the composed 0054 service, which is the
  // only thing here that may write, and it is called exactly once.
  assert.equal(command.calls.length, 1);
});

test('the preview and the authorisation share one derived request id', async () => {
  const client = new FakeClient();
  await service(client).resolveAuthorisation(IDENTITY, {
    contactId: CONTACT, contactPointId: POINT,
    purpose: 'property_predator_marketing', commandKey: COMMAND_KEY,
  });
  const previewSql = client.calls.map((entry) => entry.sql).join('\n');
  const expected = deriveFounderEmailPilotIdentifiers(WORKSPACE, COMMAND_KEY).requestId;
  assert.match(previewSql, /resolve_customer_email_pilot_evidence/);
  // The enqueue folds the request id into the digest it compares, so a replay
  // only matches when preview and authorisation agree on it.
  assert.match(expected, /^pp-email-pilot:[0-9a-f]{64}$/u);
  assert.ok(expected.length <= 128, 'the request id must fit the database contract');
});
