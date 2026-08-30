import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  CONTACT_ENDPOINT_EVIDENCE_SOURCES,
  FOUNDER_EMAIL_PILOT_BLOCKER_CODES,
  FOUNDER_EMAIL_PILOT_DIMENSIONS,
  FounderEmailPilotError,
  buildFounderEmailPilotReadinessReport,
  deriveFounderPilotCommandKey,
  parseAttachContactEmailEndpoint,
  type AttachContactEmailEndpointInput,
  type FounderEmailPilotDimensionResult,
} from '../src/founder-email-pilot/foundation.js';
import { PgPortalFounderEmailPilotService } from '../src/portal/founder-email-pilot-pg-service.js';
import type { AttachEndpointInput } from '../src/portal/founder-email-pilot-service.js';

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
    email: 'office@propertypredator.com',
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
  assert.equal(parsed.email, 'office@propertypredator.com');
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
        recipient_email: 'office@propertypredator.com', recipient_verified: true,
        daily_used: 0, monthly_used: 0,
      }] };
    }
    return { rows: [{ active: true }] };
  }

  release(): void { /* pooled */ }
}

function service(client: FakeClient, workspaceId = WORKSPACE) {
  return new PgPortalFounderEmailPilotService({
    principalResolver: {
      async resolve() { return { userId: USER, workspaceId } as never; },
    },
    commandPool: { async connect() { return client as never; } },
    providerConnectionId: CONNECTION,
  });
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
  assert.equal(call.values[2], 'office@propertypredator.com');
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
  assert.equal(outcome.preview?.recipientEmail, 'office@propertypredator.com');
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
  const unresolved = new PgPortalFounderEmailPilotService({
    principalResolver: { async resolve() { return null; } },
    commandPool: { async connect() { return client as never; } },
    providerConnectionId: CONNECTION,
  });
  assert.deepEqual(
    await unresolved.attachEndpoint(IDENTITY, attachInput()),
    { ok: false, kind: 'unauthenticated' },
  );
  assert.deepEqual(client.calls, []);
});

test('the seam requires the exact provider connection at construction', () => {
  assert.throws(() => new PgPortalFounderEmailPilotService({
    principalResolver: { async resolve() { return null; } },
    commandPool: { async connect() { return new FakeClient() as never; } },
    providerConnectionId: 'not-a-uuid',
  }), /exact provider connection/);
});
