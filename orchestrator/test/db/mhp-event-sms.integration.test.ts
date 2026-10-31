import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import {
  expectPostgresError,
  openTestDatabase,
  ownerQuery,
  resetIdentityTables,
  testDatabaseSkipReason,
} from './database-helper.js';

const skip = testDatabaseSkipReason();
const WS = '2789228d-55a6-4688-b1e8-2f70abca990b';
const OWNER = '0b131000-0000-4000-8000-000000000001';
const CONNECTION = '0b131000-0000-4000-8000-000000000002';
const VERSION = '0b131000-0000-4000-8000-000000000005';
const CAMPAIGN = 'webinar-2026-11-04';
const CONSENT_TEXT = 'Yes, text me reminders about this Martin Howard Property webinar on this mobile. Only about this webinar. Reply STOP to any text to opt out.';
const sha = (value: string): Buffer => createHash('sha256').update(value).digest();
const SESSION = sha('mhp-009b-owner-session');
const ROLES = ['r72_identity_command', 'r72_sms_command', 'r72_sms_worker_command'] as const;
type Role = typeof ROLES[number];
type Pools = Record<Role, Pool>;

async function openLoginPools(owner: Pool): Promise<Pools> {
  const rawUrl = process.env.TEST_DATABASE_URL?.trim();
  if (!rawUrl) throw new Error('TEST_DATABASE_URL is required');
  const pools = {} as Pools;
  const client = await owner.connect();
  try {
    for (const role of ROLES) {
      const password = `mhp-009b-${randomUUID()}`;
      const statement = await client.query<{ sql: string }>(
        `SELECT pg_catalog.format('ALTER ROLE %I PASSWORD %L', $1::text, $2::text) AS sql`, [role, password]);
      await client.query(statement.rows[0]!.sql);
      const url = new URL(rawUrl);
      url.username = role;
      url.password = password;
      pools[role] = new Pool({ connectionString: url.toString(), max: 1, application_name: `relaunch72-disposable-${role}-009b` });
    }
  } finally {
    client.release();
  }
  return pools;
}

async function closeLoginPools(owner: Pool, pools: Partial<Pools>): Promise<void> {
  await Promise.allSettled(Object.values(pools).map(pool => pool.end()));
  const client = await owner.connect();
  try {
    for (const role of ROLES) await client.query(`ALTER ROLE ${role} PASSWORD NULL`);
  } finally {
    client.release();
  }
}

async function as<T extends QueryResultRow = QueryResultRow>(pool: Pool, actor: 'public' | 'owner' | 'worker', sql: string,
  values: unknown[] = [], isolation: 'read committed' | 'serializable' = 'read committed'): Promise<T[]> {
  const client: PoolClient = await pool.connect();
  try {
    await client.query(`BEGIN ISOLATION LEVEL ${isolation.toUpperCase()}`);
    if (actor !== 'public') {
      await client.query(`SELECT set_config('app.workspace_id',$1,true),set_config('app.actor_kind',$2,true),
        set_config('app.user_id',$3,true),set_config('app.request_id',$4,true)`,
        [WS, actor === 'owner' ? 'user' : 'worker', actor === 'owner' ? OWNER : '', `mhp-009b-${randomUUID()}`]);
    }
    const result = await client.query<T>(sql, values);
    await client.query('COMMIT');
    return result.rows;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function phone(n: number): string { return `+4477009000${String(n).padStart(2, '0')}`; }

async function requestOptin(pools: Pools, email: string, n: number, source = randomBytes(32)): Promise<string> {
  const rows = await as<{ value: { optinId: string } }>(pools.r72_identity_command, 'public',
    'SELECT app_private.mhp_event_sms_optin_request($1,$2,$3,$4,$5,$6,$7) AS value',
    [email, phone(n), CAMPAIGN, 'mhp.event-sms/v1', sha(CONSENT_TEXT), source, randomUUID()]);
  return rows[0]!.value.optinId;
}

async function deliverCodes(pools: Pools): Promise<number> {
  let sent = 0;
  for (;;) {
    const claimed = await as<{ optin_id: string }>(pools.r72_sms_worker_command, 'worker',
      'SELECT optin_id FROM app_private.mhp_event_sms_code_claim($1,$2)', [WS, CONNECTION]);
    if (claimed.length === 0) return sent;
    const id = claimed[0]!.optin_id;
    const armed = await as<{ ok: boolean }>(pools.r72_sms_worker_command, 'worker',
      'SELECT app_private.mhp_event_sms_code_arm($1,$2,$3) AS ok', [WS, id, '123456']);
    assert.equal(armed[0]!.ok, true);
    const settled = await as<{ ok: boolean }>(pools.r72_sms_worker_command, 'worker',
      'SELECT app_private.mhp_event_sms_code_settle($1,$2,$3,$4) AS ok', [WS, id, 'sent', `SM${randomBytes(16).toString('hex')}`]);
    assert.equal(settled[0]!.ok, true);
    sent += 1;
  }
}

async function confirm(pools: Pools, id: string, code: string): Promise<string> {
  const rows = await as<{ value: string }>(pools.r72_identity_command, 'public',
    'SELECT app_private.mhp_event_sms_optin_confirm($1,$2) AS value', [id, code]);
  return rows[0]!.value;
}

interface Snapshot {
  recipients: { optinId: string; email: string; status: string }[];
  readyCount: number; batchSha256: string | null; daySegmentsUsed: number; bindingReady: boolean;
  batches: { batchId: string; recipientCount: number; jobStates: Record<string, number> }[];
}
async function snapshot(pools: Pools): Promise<Snapshot> {
  const rows = await as<{ value: Snapshot }>(pools.r72_sms_command, 'owner',
    'SELECT app_private.mhp_event_sms_batch_snapshot($1,$2,$3,$4) AS value', [SESSION, CAMPAIGN, VERSION, cachedContentSha]);
  return rows[0]!.value;
}
let cachedContentSha: Buffer | undefined;

async function send(pools: Pools, command: string, batchSha: string, confirmed = true) {
  const rows = await as<{ value: Record<string, unknown> }>(pools.r72_sms_command, 'owner',
    'SELECT app_private.mhp_event_sms_batch_send($1,$2,$3,$4,$5,$6,$7,false) AS value',
    [SESSION, command, CAMPAIGN, VERSION, cachedContentSha, Buffer.from(batchSha, 'hex'), confirmed]);
  return rows[0]!.value;
}

test('MHP009B: public opt-in, owner exact-batch send and unchanged live-worker pre-call acceptance', { skip }, async () => {
  const owner = await openTestDatabase();
  let pools: Partial<Pools> = {};
  try {
    await resetIdentityTables(owner);
    await ownerQuery(owner, 'TRUNCATE TABLE app_private.mhp_prospects CASCADE');
    const fixture = await readFile(new URL('./mhp-event-sms.fixture.sql', import.meta.url), 'utf8');
    await ownerQuery(owner, fixture);
    cachedContentSha = (await ownerQuery<{ content_sha256: Buffer }>(owner,
      'SELECT content_sha256 FROM app.company_content_versions WHERE id=$1', [VERSION]))[0]!.content_sha256;
    // Registrant 4 previously replied STOP on this phone; that must hold forever.
    await ownerQuery(owner, `
      WITH p AS (INSERT INTO app.contact_points(workspace_id,contact_id,kind,value,normalized_value)
        VALUES($1,'0b131200-0000-4000-8000-000000000004','phone',$2,$2) RETURNING id,contact_id,kind,value,normalized_value)
      INSERT INTO app.communication_suppression_events(workspace_id,contact_id,contact_point_id,channel,purpose,state,reason,source,actor_kind,endpoint_identity_sha256,occurred_at)
      SELECT $1,p.contact_id,p.id,'sms',NULL,'suppressed','twilio_stop','twilio.webhook','webhook',
        public.digest(p.kind||chr(31)||p.value||chr(31)||p.normalized_value,'sha256'),clock_timestamp() FROM p`, [WS, phone(4)]);
    pools = await openLoginPools(owner);
    const p = pools as Pools;

    // Boundaries: each runtime role can reach only its own functions.
    await expectPostgresError(as(p.r72_sms_command, 'owner', 'SELECT app_private.mhp_event_sms_optin_request($1,$2,$3,$4,$5,$6,$7)',
      ['registrant-1@example.invalid', phone(1), CAMPAIGN, 'mhp.event-sms/v1', sha(CONSENT_TEXT), randomBytes(32), randomUUID()]), '42501');
    await expectPostgresError(as(p.r72_identity_command, 'public', 'SELECT app_private.mhp_event_sms_batch_snapshot($1,$2,$3,$4)',
      [SESSION, CAMPAIGN, VERSION, cachedContentSha]), '42501');
    await expectPostgresError(as(p.r72_sms_command, 'owner', 'SELECT * FROM app_private.mhp_event_sms_verified_optins($1)', [CAMPAIGN]), '42501');
    await expectPostgresError(as(p.r72_identity_command, 'public', 'SELECT count(*) FROM app_private.mhp_event_sms_optins'), '42501');
    await expectPostgresError(as(p.r72_sms_worker_command, 'worker', 'SELECT app_private.mhp_event_sms_optin_confirm($1,$2)', [randomUUID(), '123456']), '42501');
    // The public step refuses consent wording it did not show.
    await expectPostgresError(as(p.r72_identity_command, 'public', 'SELECT app_private.mhp_event_sms_optin_request($1,$2,$3,$4,$5,$6,$7)',
      ['registrant-1@example.invalid', phone(1), CAMPAIGN, 'mhp.event-sms/v1', sha('other words'), randomBytes(32), randomUUID()]), '22023');

    const ids = new Map<number, string>();
    for (const n of [1, 2, 3, 4, 5]) ids.set(n, await requestOptin(p, `registrant-${n}@example.invalid`, n));
    const unsubscribed = await requestOptin(p, 'registrant-6@example.invalid', 6);
    const unknown = await requestOptin(p, 'nobody@example.invalid', 7);
    const stored = await ownerQuery<{ id: string }>(owner, 'SELECT id FROM app_private.mhp_event_sms_optins ORDER BY created_at');
    assert.equal(stored.length, 5, 'unknown and unsubscribed emails create nothing');
    assert.ok(!stored.some(row => row.id === unsubscribed || row.id === unknown));
    // Repeating the same phone while a code is live returns the same opt-in, no second code.
    assert.equal(await requestOptin(p, 'registrant-1@example.invalid', 1), ids.get(1));
    assert.equal(await deliverCodes(p), 5);
    assert.equal(await deliverCodes(p), 0);
    assert.equal(await confirm(p, unknown, '123456'), 'unavailable');
    assert.equal(await confirm(p, ids.get(1)!, '123456'), 'verified');
    assert.equal(await confirm(p, ids.get(1)!, '123456'), 'already');
    assert.equal(await confirm(p, ids.get(2)!, '000000'), 'retry');
    assert.equal(await confirm(p, ids.get(2)!, '123456'), 'verified');
    for (let attempt = 0; attempt < 4; attempt += 1) await confirm(p, ids.get(3)!, '999999');
    assert.equal(await confirm(p, ids.get(3)!, '999999'), 'unavailable');
    assert.equal(await confirm(p, ids.get(3)!, '123456'), 'unavailable', 'five wrong codes lock the opt-in');
    assert.equal(await confirm(p, ids.get(4)!, '123456'), 'verified');
    assert.equal(await confirm(p, ids.get(5)!, '123456'), 'verified');
    // Nothing reached the CRM before the owner review.
    assert.equal((await ownerQuery(owner, `SELECT 1 FROM app.communication_consent_events WHERE source='mhp.event-sms.public-optin'`)).length, 0);

    const first = await snapshot(p);
    assert.equal(first.bindingReady, true);
    const status = Object.fromEntries(first.recipients.map(r => [r.email, r.status]));
    assert.deepEqual(status, {
      'registrant-1@example.invalid': 'ready', 'registrant-2@example.invalid': 'ready',
      'registrant-4@example.invalid': 'opted_out', 'registrant-5@example.invalid': 'needs_import',
    });
    assert.equal(first.readyCount, 2);
    assert.match(first.batchSha256 ?? '', /^[0-9a-f]{64}$/u);

    await expectPostgresError(as(p.r72_sms_command, 'owner', 'SELECT app_private.mhp_event_sms_batch_snapshot($1,$2,$3,$4)',
      [sha('not-a-session'), CAMPAIGN, VERSION, cachedContentSha]), '42501');
    // A registrant who verifies after the owner looked must wait for a fresh review.
    const late = await requestOptin(p, 'registrant-3@example.invalid', 21);
    assert.equal(await deliverCodes(p), 1);
    assert.equal(await confirm(p, late, '123456'), 'verified');
    await expectPostgresError(send(p, randomUUID(), first.batchSha256!), '40001');
    const reviewed = await snapshot(p);
    assert.equal(reviewed.readyCount, 3);
    await expectPostgresError(send(p, randomUUID(), first.batchSha256!, false), '42501');
    await expectPostgresError(send(p, randomUUID(), '00'.repeat(32)), '40001');
    const command = randomUUID();
    const result = await send(p, command, reviewed.batchSha256!);
    assert.equal(result.recipientCount, 3);
    assert.equal(result.replayed, false);
    assert.equal(result.providerEffects, 'none');
    assert.equal((result.jobIds as string[]).length, 3);
    const replay = await send(p, command, reviewed.batchSha256!);
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.jobIds, result.jobIds);

    const evidence = await ownerQuery<{ operator: string; request: string; consent_actor: string; consent_user: string | null;
      verified: boolean; job_state: string; created_by: string }>(owner, `
      SELECT a.operator_user_id::text AS operator,a.operator_request_id AS request,c.actor_kind AS consent_actor,c.actor_user_id::text AS consent_user,
       p.is_verified AS verified,j.state AS job_state,j.created_by_user_id::text AS created_by
      FROM app_private.mhp_event_sms_batch_recipients r
      JOIN app.property_predator_sms_jobs j ON j.workspace_id=r.workspace_id AND j.id=r.job_id
      JOIN app.property_predator_sms_authorities a ON a.workspace_id=j.workspace_id AND a.id=j.authority_id
      JOIN app.communication_consent_events c ON c.workspace_id=r.workspace_id AND c.id=r.consent_event_id
      JOIN app.contact_points p ON p.workspace_id=r.workspace_id AND p.id=r.contact_point_id`);
    assert.equal(evidence.length, 3);
    for (const row of evidence) {
      assert.equal(row.operator, OWNER, 'the reviewing owner is the operator');
      assert.equal(row.created_by, OWNER);
      assert.equal(row.consent_actor, 'system', 'the registrant consent is never recorded as the owner');
      assert.equal(row.consent_user, null);
      assert.equal(row.verified, true);
      assert.equal(row.job_state, 'queued');
    }
    assert.equal(new Set(evidence.map(row => row.request)).size, 1, 'one owner request authorised the whole batch');

    const after = await snapshot(p);
    assert.equal(after.readyCount, 0);
    assert.equal(after.batchSha256, null);
    assert.equal(after.daySegmentsUsed, 3);
    assert.deepEqual(after.recipients.filter(r => r.status === 'already_sent').map(r => r.email).sort(),
      ['registrant-1@example.invalid', 'registrant-2@example.invalid', 'registrant-3@example.invalid']);
    assert.equal(after.batches[0]?.recipientCount, 3);
    assert.equal(after.batches[0]?.jobStates.queued, 3);
    await expectPostgresError(send(p, randomUUID(), reviewed.batchSha256!), '40001');

    // The unchanged 0056/0130 live worker claims the job and its pre-call
    // re-proof accepts the owner-review authority. No provider call is made.
    const lease = randomBytes(32);
    const claimed = await as<{ job_id: string; lease_version: string }>(p.r72_sms_worker_command, 'worker',
      'SELECT * FROM app_private.claim_sms_live_job($1,$2,$3,60)', [WS, CONNECTION, lease]);
    assert.equal(claimed.length, 1);
    assert.ok((result.jobIds as string[]).includes(claimed[0]!.job_id));
    const began = await as<{ ok: boolean }>(p.r72_sms_worker_command, 'worker',
      'SELECT app_private.begin_sms_live_call($1,$2,$3,$4,true,true,false) AS ok', [WS, claimed[0]!.job_id, claimed[0]!.lease_version, lease]);
    assert.equal(began[0]!.ok, true);

    // Evidence is append-only.
    await expectPostgresError(ownerQuery(owner, `UPDATE app_private.mhp_event_sms_batches SET recipient_count=recipient_count`), '42501');
    // Per-source request limit: five new opt-ins per 24 hours from one source.
    const source = randomBytes(32);
    for (const n of [11, 12, 13, 14, 15]) await requestOptin(p, 'registrant-3@example.invalid', n, source);
    await expectPostgresError(requestOptin(p, 'registrant-3@example.invalid', 16, source), '54000');
  } finally {
    await closeLoginPools(owner, pools).catch(() => undefined);
    await owner.end();
  }
});
