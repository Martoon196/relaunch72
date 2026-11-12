import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { Client, type Pool } from 'pg';
import { assertDisposableTestDatabase, testDatabaseSkipReason } from './database-helper.js';
import { createInboxCrmRunner } from '../../src/integrations/group-hq-crm/inbox.js';
import { PgLeadRelayCrmWriter } from '../../src/integrations/leadrelay/crm-feed-writer.js';
import { LeadRelayCrmFeed, leadRelayEventKey, leadRelayLeadKey } from '../../src/integrations/leadrelay/crm-feed.js';
import { createLeadRelayFeedClient } from '../../src/integrations/leadrelay/crm-feed-client.js';
import { createPgCommunicationEligibilityService } from '../../src/consent-pg/eligibility.js';
import { workerDatabaseContext } from '../../src/db/rls.js';

/** A stand-in for LeadRelay's read/ack API, serving the exact shapes LeadRelay's api.py returns. */
function fakeLeadRelay(rows: Record<string, unknown>[], leads: Record<string, Record<string, unknown>>) {
  const acked = new Set<string>(); const requests: { method: string; url: string }[] = [];
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method!, url: req.url! });
    const send = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.method === 'GET' && req.url === '/api/outbox?limit=200') return send(200, rows.filter(r => !acked.has(String(r.id))).slice(0, 200));
    const lead = /^\/api\/leads\/([^/]+)$/u.exec(req.url!);
    if (req.method === 'GET' && lead) return leads[lead[1]!] ? send(200, { lead: leads[lead[1]!], activities: [], jobs: [], consent_receipts: [], bookings: [] }) : send(404, { detail: 'Not found' });
    const ack = /^\/api\/outbox\/([^/]+)\/ack$/u.exec(req.url!);
    if (req.method === 'POST' && ack) { acked.add(ack[1]!); return send(200, { ok: true }); }
    send(404, { detail: 'Not found' });
  });
  return { server, acked, requests, async listen() { await new Promise<void>(r => server.listen(0, '127.0.0.1', r)); return `http://127.0.0.1:${(server.address() as AddressInfo).port}`; } };
}

test('LeadRelay feed copies enquiries, call results and a calls-only stop under the real CRM command role, once',
  { skip: testDatabaseSkipReason() }, async () => {
    const url = process.env.TEST_DATABASE_URL!;
    assertDisposableTestDatabase(url);
    const seed = new Client({ connectionString: url }); await seed.connect();
    const org = randomUUID(), workspace = randomUUID(), owner = randomUUID(), pipeline = randomUUID(), stage = randomUUID(), suffix = randomUUID();
    const clients: Client[] = [];
    const rolePool = (role: 'r72_crm_command' | 'r72_worker') => ({ async connect() {
      const c = new Client({ connectionString: url }); await c.connect(); clients.push(c); await c.query(`SET ROLE ${role}`);
      return { query: c.query.bind(c), release() { void c.end(); } };
    } }) as unknown as Pick<Pool, 'connect'>;
    const fake = fakeLeadRelay([], {});
    try {
      await seed.query('SET ROLE r72_owner');
      await seed.query('INSERT INTO app.organizations(id,name,slug,kind) VALUES($1,$2,$3,\'direct_customer\')', [org, 'LeadRelay feed proof', 'lr-' + suffix]);
      await seed.query('INSERT INTO app.users(id,email,status) VALUES($1,$2,\'active\')', [owner, `lr-${suffix}@example.test`]);
      await seed.query('INSERT INTO app.workspaces(id,organization_id,name,slug) VALUES($1,$2,\'LeadRelay proof\',\'lr-proof\')', [workspace, org]);
      await seed.query('INSERT INTO app.organization_memberships(organization_id,user_id,role,status) VALUES($1,$2,\'owner\',\'active\')', [org, owner]);
      await seed.query('INSERT INTO app.workspace_memberships(workspace_id,organization_id,user_id,role,status) VALUES($1,$2,$3,\'owner\',\'active\')', [workspace, org, owner]);
      await seed.query('INSERT INTO app.pipelines(id,workspace_id,name,slug,is_default) VALUES($1,$2,\'Enquiries\',\'enquiries\',true)', [pipeline, workspace]);
      await seed.query('INSERT INTO app.pipeline_stages(id,workspace_id,pipeline_id,name,slug,position,stage_type) VALUES($1,$2,$3,\'New\',\'new\',1,\'open\')', [stage, workspace, pipeline]);

      const writer = new PgLeadRelayCrmWriter(createInboxCrmRunner(rolePool('r72_crm_command')), { workspaceId: workspace, ownerUserId: owner, pipelineId: pipeline, stageId: stage });
      const lrWs = randomUUID(), at = Math.floor(Date.now() / 1000) - 600;
      const L = { a: randomUUID(), b: randomUUID(), c: randomUUID(), d: randomUUID(), e: randomUUID() };
      const lead = (id: string, extra: Record<string, unknown>) => ({ id, workspace_id: lrWs, name: 'Proof person', email: null, phone: null, company: '',
        custom: { message: 'free text that must never be copied' }, source: 'website_chat', status: 'new', is_demo: false, created_at: at, updated_at: at, ...extra });
      const leads = {
        [L.a]: lead(L.a, { email: `alpha-${suffix}@example.test`, phone: '+447700900111' }),
        [L.b]: lead(L.b, { email: `beta-${suffix}@example.test` }),
        [L.c]: lead(L.c, { email: `alpha-${suffix}@example.test`, phone: '+447700900222' }),
        [L.d]: lead(L.d, { email: `delta-${suffix}@example.test`, phone: '+447700900333' }),
        [L.e]: lead(L.e, { phone: '+447700900444' }),
      };
      // L.d's email belongs to one contact and its phone to another: it must be refused untouched.
      const other1 = randomUUID(), other2 = randomUUID();
      for (const [contact, kind, value] of [[other1, 'email', `delta-${suffix}@example.test`], [other2, 'phone', '+447700900333']] as const) {
        await seed.query('INSERT INTO app.contacts(id,workspace_id,display_name) VALUES($1,$2,\'Existing\')', [contact, workspace]);
        await seed.query('INSERT INTO app.contact_points(id,workspace_id,contact_id,kind,value,normalized_value,is_primary,consent_status) VALUES($1,$2,$3,$4,$5,$5,true,\'opted_in\')',
          [randomUUID(), workspace, contact, kind, value]);
      }
      // L.e's number belongs to an archived contact: also refused untouched.
      const archived = randomUUID();
      await seed.query('INSERT INTO app.contacts(id,workspace_id,display_name,lifecycle_status) VALUES($1,$2,\'Archived\',\'archived\')', [archived, workspace]);
      await seed.query('INSERT INTO app.contact_points(id,workspace_id,contact_id,kind,value,normalized_value,is_primary) VALUES($1,$2,$3,\'phone\',$4,$4,true)',
        [randomUUID(), workspace, archived, '+447700900444']);
      const row = (id: string, kind: string, leadId: string | null, payload: Record<string, unknown>, offset: number) =>
        ({ id, workspace_id: lrWs, lead_id: leadId, kind, payload: { lead_id: leadId, ...payload }, created_at: at + offset, delivered_at: null });
      const E = { aNew: randomUUID(), bNew: randomUUID(), aCall: randomUUID(), aOut: randomUUID(), aUnsub: randomUUID(), cNew: randomUUID(), dNew: randomUUID(), dCall: randomUUID(), eNew: randomUUID() };
      const rows = [
        row(E.aNew, 'lead.created', L.a, { source: 'website_chat', is_demo: false }, 1),
        row(E.bNew, 'lead.created', L.b, { source: 'hook', is_demo: false }, 2),
        row(E.aCall, 'call.provider_outcome', L.a, { job_id: 'j1', call_id: 'c1', outcome: 'no_answer', summary: 'transcript text that must never be copied' }, 3),
        row(E.aOut, 'call.provider_outcome', L.a, { job_id: 'j2', call_id: 'c2', outcome: 'opt_out', summary: 'please stop calling me' }, 4),
        row(E.aUnsub, 'lead.status', L.a, { status: 'unsubscribed' }, 5),
        row(E.cNew, 'lead.created', L.c, { source: 'website_chat', is_demo: false }, 6),
        row(E.dNew, 'lead.created', L.d, { source: 'website_chat', is_demo: false }, 7),
        row(E.dCall, 'call.provider_outcome', L.d, { outcome: 'answered' }, 8),
        row(E.eNew, 'lead.created', L.e, { source: 'website_chat', is_demo: false }, 9),
      ];
      const served = fakeLeadRelay(rows, leads);
      const base = await served.listen();
      const lines: string[] = [];
      const feed = () => new LeadRelayCrmFeed({ state: 'on', key: 'k'.repeat(48), baseUrl: base, brand: 'pp',
        scope: { workspaceId: workspace, ownerUserId: owner, pipelineId: pipeline, stageId: stage } },
        { writer, client: createLeadRelayFeedClient({ baseUrl: base, key: 'k'.repeat(48), request: http.request }), log: l => lines.push(l) });
      const first = feed();
      await first.runOnce();
      assert.equal(served.acked.size, rows.length, 'every row is acknowledged after its write or deliberate skip');
      assert.ok(served.requests.every(r => (r.method === 'GET' && /^\/api\/(outbox\?limit=200|leads\/[0-9a-f-]+)$/u.test(r.url)) || (r.method === 'POST' && /^\/api\/outbox\/[0-9a-f-]+\/ack$/u.test(r.url))));
      const status = first.status('pp');
      assert.deepEqual(status.today, { enquiriesCopied: 3, callResultsCopied: 2, doNotCallRecorded: 1, skipped: 1, needsTheOwner: 2 });
      assert.match(status.summary, /1 LeadRelay enquiry matches two CRM contacts and was not copied\./u);
      assert.match(status.summary, /1 LeadRelay enquiry belongs to an archived CRM contact and was not copied\./u);

      const snapshot = async () => (await seed.query(`SELECT
          (SELECT count(*)::int FROM app.contacts WHERE workspace_id=$1) AS contacts,
          (SELECT count(*)::int FROM app.contact_points WHERE workspace_id=$1) AS points,
          (SELECT count(*)::int FROM app.opportunities WHERE workspace_id=$1) AS opportunities,
          (SELECT count(*)::int FROM app.activities WHERE workspace_id=$1) AS activities,
          (SELECT count(*)::int FROM app.communication_suppression_events WHERE workspace_id=$1) AS suppressions,
          (SELECT count(*)::int FROM app.command_receipts WHERE workspace_id=$1) AS receipts`, [workspace])).rows[0];
      const before = await snapshot();
      assert.deepEqual({ ...before, receipts: undefined }, { contacts: 5, points: 6, opportunities: 2, activities: 6, suppressions: 1, receipts: undefined });

      // L.a: new contact, both points 'unknown', one opportunity. L.c shares L.a's email and the contact already has an
      // open deal, so it becomes a timeline entry with no second opportunity and no new point.
      const alpha = await seed.query(`SELECT c.id,c.source,(SELECT count(*)::int FROM app.opportunities o WHERE o.contact_id=c.id) AS opps
        FROM app.contacts c JOIN app.contact_points p ON p.contact_id=c.id WHERE c.workspace_id=$1 AND p.normalized_value=$2`, [workspace, `alpha-${suffix}@example.test`]);
      assert.equal(alpha.rows.length, 1); assert.equal(alpha.rows[0].source, 'leadrelay:website_chat'); assert.equal(alpha.rows[0].opps, 1);
      const alphaId = alpha.rows[0].id as string;
      const points = await seed.query('SELECT kind,normalized_value,consent_status,is_verified FROM app.contact_points WHERE contact_id=$1 ORDER BY kind', [alphaId]);
      assert.deepEqual(points.rows.map(p => [p.kind, p.consent_status]), [['email', 'unknown'], ['phone', 'unknown']]);
      const timeline = await seed.query('SELECT activity_type,subject,body,metadata,actor_user_id FROM app.activities WHERE contact_id=$1 ORDER BY occurred_at,created_at', [alphaId]);
      assert.deepEqual(timeline.rows.map(r => r.activity_type).sort(),
        ['crm.lead.created', 'leadrelay.call_result', 'leadrelay.do_not_call', 'leadrelay.enquiry', 'leadrelay.note'].sort());
      assert.ok(timeline.rows.every(r => r.actor_user_id === owner));
      const text = JSON.stringify(timeline.rows);
      assert.doesNotMatch(text, /transcript|please stop calling|free text/u, 'no transcript, summary or free text is copied');
      assert.match(text, /Asked not to be called/u); assert.match(text, /AI call: no answer/u);

      // The stop: one calls-only suppression on the exact phone LeadRelay called, keyed by LeadRelay's event id.
      const stop = await seed.query('SELECT channel,purpose,state,reason,source,source_event_id,contact_point_id,actor_kind FROM app.communication_suppression_events WHERE workspace_id=$1', [workspace]);
      assert.equal(stop.rows.length, 1);
      assert.deepEqual({ ...stop.rows[0], contact_point_id: undefined }, { channel: 'phone', purpose: null, state: 'suppressed', reason: 'do_not_call',
        source: 'leadrelay', source_event_id: E.aOut, contact_point_id: undefined, actor_kind: 'user' });
      const phonePoint = await seed.query('SELECT id FROM app.contact_points WHERE contact_id=$1 AND kind=\'phone\'', [alphaId]);
      assert.equal(stop.rows[0].contact_point_id, phonePoint.rows[0].id);

      // Nothing about the existing two contacts changed, and their opted_in stays exactly as it was.
      const others = await seed.query('SELECT consent_status FROM app.contact_points WHERE contact_id=ANY($1::uuid[])', [[other1, other2]]);
      assert.deepEqual(others.rows.map(r => r.consent_status), ['opted_in', 'opted_in']);
      assert.equal((await seed.query('SELECT count(*)::int AS n FROM app.activities WHERE contact_id=ANY($1::uuid[])', [[other1, other2, archived]])).rows[0].n, 0);
      assert.equal((await seed.query('SELECT count(*)::int AS n FROM app.opportunities WHERE contact_id=ANY($1::uuid[])', [[other1, other2, archived]])).rows[0].n, 0);

      // Replay: LeadRelay serves every row again (as if no ack had arrived) to a fresh process. Nothing is written twice.
      served.acked.clear();
      const second = feed();
      await second.runOnce();
      assert.deepEqual(await snapshot(), before);
      assert.deepEqual(second.status('pp').today, { enquiriesCopied: 0, callResultsCopied: 0, doNotCallRecorded: 0, skipped: 1, needsTheOwner: 0 });
      assert.equal(served.acked.size, rows.length);
      // And directly: the same opt-out event recorded again is a replay with no new row.
      const again = await writer.recordTimeline({ eventKey: leadRelayEventKey(lrWs, E.aOut), leadKey: leadRelayLeadKey(lrWs, L.a), leadRelayEventId: E.aOut,
        activityType: 'leadrelay.do_not_call', subject: 'Asked not to be called', body: null, occurredAt: new Date().toISOString(), metadata: {}, doNotCall: true });
      assert.equal(again.replayed, true);
      assert.deepEqual(await snapshot(), before);

      // consent_status was never written by the feed: every point it created is still 'unknown'.
      const created = await seed.query(`SELECT consent_status FROM app.contact_points WHERE workspace_id=$1 AND contact_id <> ALL($2::uuid[])`, [workspace, [other1, other2, archived]]);
      assert.ok(created.rows.length >= 3 && created.rows.every(r => r.consent_status === 'unknown'));

      // Eligibility (the existing consent-pg rules, read as the worker role): with the phone endpoint verified, calls are
      // blocked by the suppression while SMS and WhatsApp on the same number are untouched (no evidence either way).
      await seed.query('UPDATE app.contact_points SET is_verified=true WHERE id=$1', [phonePoint.rows[0].id]);
      const whatsapp = randomUUID();
      await seed.query('INSERT INTO app.contact_points(id,workspace_id,contact_id,kind,value,normalized_value,is_primary,is_verified) VALUES($1,$2,$3,\'whatsapp\',$4,$4,true,true)',
        [whatsapp, workspace, alphaId, '+447700900111']);
      const eligibility = createPgCommunicationEligibilityService(rolePool('r72_worker'));
      const ctx = workerDatabaseContext({ workspaceId: workspace, requestId: 'leadrelay-proof' });
      for (const purpose of ['marketing', 'service']) {
        const phone = await eligibility.evaluateEndpoint(ctx, { contactPointId: phonePoint.rows[0].id, channel: 'phone', purpose });
        const sms = await eligibility.evaluateEndpoint(ctx, { contactPointId: phonePoint.rows[0].id, channel: 'sms', purpose });
        const wa = await eligibility.evaluateEndpoint(ctx, { contactPointId: whatsapp, channel: 'whatsapp', purpose });
        assert.deepEqual([phone.status, phone.reason], ['blocked', 'suppressed']);
        assert.deepEqual([sms.status, sms.reason], ['unknown', 'no_evidence']);
        assert.deepEqual([wa.status, wa.reason], ['unknown', 'no_evidence']);
      }

      // No log line carries a name, email, phone number, free text or the key.
      for (const line of lines) assert.doesNotMatch(line, /example\.test|\+44|Proof person|transcript|free text|kkkkkkkk/u);

      // A revoked owner writes nothing: the runner re-checks management in every transaction.
      await seed.query('UPDATE app.workspace_memberships SET status=\'suspended\',updated_at=clock_timestamp() WHERE workspace_id=$1 AND user_id=$2', [workspace, owner]);
      await assert.rejects(writer.copyEnquiry({ leadKey: 'lr.lead.revoked', occurredAt: new Date().toISOString(),
        lead: { displayName: 'After revocation', companyName: null, email: `rev-${suffix}@example.test`, phone: null, source: 'leadrelay:x' } }));
      await seed.query('UPDATE app.workspace_memberships SET status=\'active\',updated_at=clock_timestamp() WHERE workspace_id=$1 AND user_id=$2', [workspace, owner]);
      served.server.close();
    } finally {
      fake.server.close();
      try {
        await seed.query('SET ROLE r72_owner');
        for (const table of ['communication_suppression_events', 'activities', 'opportunity_stage_history', 'tasks', 'opportunities', 'contact_points', 'contacts',
          'command_receipts', 'outbox_events', 'pipeline_stages', 'pipelines', 'workspace_memberships'])
          await seed.query(`DELETE FROM app.${table} WHERE workspace_id=$1`, [workspace]);
        await seed.query('DELETE FROM app.organization_memberships WHERE organization_id=$1', [org]);
        await seed.query('DELETE FROM app.workspaces WHERE organization_id=$1', [org]);
        await seed.query('DELETE FROM app.organizations WHERE id=$1', [org]);
        await seed.query('DELETE FROM app.users WHERE id=$1', [owner]);
      } finally { await seed.end(); }
    }
  });
