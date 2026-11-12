import assert from 'node:assert/strict';
import test from 'node:test';
import { CrmCommandService } from '../src/crm-pg/commands.js';
import { IdempotencyKeyReusedError, InvalidCrmStateError } from '../src/crm-pg/errors.js';
import type { CrmTransactionRunner, SqlExecutor } from '../src/crm-pg/types.js';
import { requestDatabaseContext } from '../src/db/rls.js';
import {
  CREATE_LEAD_ARCHIVED, CREATE_LEAD_DELETED, CREATE_LEAD_TWO_CONTACTS, LEAD_COMMAND, PgLeadRelayCrmWriter, ownerRefusal,
} from '../src/integrations/leadrelay/crm-feed-writer.js';

const ID = (n: string) => `${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`;
const SCOPE = { workspaceId: ID('1'), ownerUserId: ID('3'), pipelineId: ID('4'), stageId: ID('5') };
type Answer = (sql: string, values: readonly unknown[]) => { rows: Record<string, unknown>[]; rowCount?: number } | undefined;
const runnerFor = (answer: Answer, seen: string[] = []): CrmTransactionRunner => ({
  async run(_context, operation) {
    const tx: SqlExecutor = { async query(sql, values = []) {
      seen.push(sql);
      const result = answer(sql, values) ?? { rows: [] };
      return { rows: result.rows as never[], rowCount: result.rowCount ?? result.rows.length };
    } };
    return operation(tx);
  },
});
const claim: Answer = (sql, values) => sql.includes('crm.claim-command') ? { rows: [{ id: ID('9'), payloadHash: values[5], status: 'started', result: null }] }
  : sql.includes('crm.complete-command') ? { rows: [{ id: ID('9') }], rowCount: 1 } : undefined;

test('the createLead refusals that need the owner are recognised by createLead\'s own exact texts, and nothing else is', async () => {
  for (const [states, expected] of [[['active', 'active'], 'two_contacts'], [['archived'], 'archived_contact'], [['deleted'], 'archived_contact']] as const) {
    const contacts = [ID('a'), ID('b')];
    let point = 0;
    const commands = new CrmCommandService({ transactionRunner: runnerFor((sql, values) => {
      if (sql.includes('crm.find-contact-point')) {
        const i = point++;
        return i < states.length ? { rows: [{ id: ID('c'), contactId: contacts[i], contactState: states[i] }] } : { rows: [] };
      }
      return claim(sql, values);
    }) });
    const error = await commands.createLead(requestDatabaseContext({ workspaceId: SCOPE.workspaceId, userId: SCOPE.ownerUserId, requestId: 'test' }), {
      commandKey: 'lr.lead.test', displayName: 'Test', pipelineId: SCOPE.pipelineId, stageId: SCOPE.stageId,
      contactPoints: [{ kind: 'email', value: 'a@b.example' }, { kind: 'phone', value: '+447700900001' }] }).catch((e: unknown) => e);
    assert.ok(error instanceof InvalidCrmStateError, String(error));
    assert.equal(ownerRefusal(error), expected, (error as Error).message);
  }
  assert.equal(ownerRefusal(new InvalidCrmStateError(CREATE_LEAD_TWO_CONTACTS)), 'two_contacts');
  assert.equal(ownerRefusal(new InvalidCrmStateError(CREATE_LEAD_ARCHIVED)), 'archived_contact');
  assert.equal(ownerRefusal(new InvalidCrmStateError(CREATE_LEAD_DELETED)), 'archived_contact');
  assert.equal(ownerRefusal(new InvalidCrmStateError('A new lead must start in an open pipeline stage')), null);
  assert.equal(ownerRefusal(new Error(CREATE_LEAD_TWO_CONTACTS)), null);
});

test('when createLead says the key was used with different details (LeadRelay changed the lead), the first lead is linked', async () => {
  let createdLookups = 0;
  const seen: string[] = [];
  const runner = runnerFor((sql, values) => {
    if (sql.includes('leadrelay.feed.receipt')) {
      if (values[1] === LEAD_COMMAND) return { rows: [] };
      // Not visible at the first check (another instance was still creating it), visible afterwards.
      return createdLookups++ === 0 ? { rows: [] } : { rows: [{ status: 'succeeded', result: { contactId: ID('7'), opportunityId: ID('8') } }] };
    }
    if (sql.includes('leadrelay.feed.phone-point')) return { rows: [{ id: ID('6') }] };
    return claim(sql, values);
  }, seen);
  const writer = new PgLeadRelayCrmWriter(runner, SCOPE, { commands: { async createLead() { throw new IdempotencyKeyReusedError(); } } });
  const result = await writer.copyEnquiry({ leadKey: 'lr.lead.changed', occurredAt: new Date().toISOString(),
    lead: { displayName: 'Changed name', companyName: null, email: 'a@b.example', phone: '+447700900001', source: 'leadrelay:x' } });
  assert.deepEqual(result, { outcome: 'created', contactId: ID('7'), replayed: false });
  const completed = seen.filter(s => s.includes('crm.complete-command'));
  assert.equal(completed.length, 1);
  assert.ok(!seen.some(s => s.includes('leadrelay.feed.activity')), 'no "already has an open deal" entry');
});

test('a lead created on an earlier attempt is linked at once, without matching or a timeline entry', async () => {
  const seen: string[] = [];
  let created = 0;
  const runner = runnerFor((sql, values) => {
    if (sql.includes('leadrelay.feed.receipt')) return values[1] === LEAD_COMMAND ? { rows: [] } : { rows: [{ status: 'succeeded', result: { contactId: ID('7') } }] };
    if (sql.includes('leadrelay.feed.phone-point')) return { rows: [] };
    return claim(sql, values);
  }, seen);
  const writer = new PgLeadRelayCrmWriter(runner, SCOPE, { commands: { async createLead() { created++; throw new Error('not expected'); } } });
  const result = await writer.copyEnquiry({ leadKey: 'lr.lead.restart', occurredAt: new Date().toISOString(),
    lead: { displayName: 'Restart', companyName: null, email: 'a@b.example', phone: null, source: 'leadrelay:x' } });
  assert.deepEqual(result, { outcome: 'created', contactId: ID('7'), replayed: false });
  assert.equal(created, 0);
  assert.ok(!seen.some(s => s.includes('crm.find-contact-point') || s.includes('leadrelay.feed.activity') || s.includes('open-opportunity')));
});
