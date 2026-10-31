import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { encryptMetaWhatsAppDispatchCredentials } from '../../src/whatsapp-live/foundation.js';
import { assertMetaWhatsAppLiveCommandBoundaryReady } from '../../src/whatsapp-live-pg/readiness.js';
import { expectPostgresError, openTestDatabase, ownerQuery, resetIdentityTables, testDatabaseSkipReason } from './database-helper.js';

const skip = testDatabaseSkipReason();
const WS = '2789228d-55a6-4688-b1e8-2f70abca990b';
const OWNER = '0b131000-0000-4000-8000-000000000001';
const CONTACT = '0b132000-0000-4000-8000-000000000001';
const VERSION = '0b132000-0000-4000-8000-000000000003';
const PHONE = '+447700900999';
const sha = (value: string): Buffer => createHash('sha256').update(value).digest();
const SESSION = sha('mhp-009b-owner-session');
const ROLES = ['r72_whatsapp_live_command', 'r72_whatsapp_live_worker_command', 'r72_identity_command'] as const;
type Role = typeof ROLES[number];
type Pools = Record<Role, Pool>;

async function openLoginPools(owner: Pool): Promise<Pools> {
  const rawUrl = process.env.TEST_DATABASE_URL!.trim();
  const pools = {} as Pools;
  const client = await owner.connect();
  try {
    for (const role of ROLES) {
      const password = `mhp-009c-${randomUUID()}`;
      const statement = await client.query<{ sql: string }>(`SELECT pg_catalog.format('ALTER ROLE %I PASSWORD %L', $1::text, $2::text) AS sql`, [role, password]);
      await client.query(statement.rows[0]!.sql);
      const url = new URL(rawUrl); url.username = role; url.password = password;
      pools[role] = new Pool({ connectionString: url.toString(), max: 1 });
    }
  } finally { client.release(); }
  return pools;
}
async function closeLoginPools(owner: Pool, pools: Partial<Pools>): Promise<void> {
  await Promise.allSettled(Object.values(pools).map(pool => pool.end()));
  const client = await owner.connect();
  try { for (const role of ROLES) await client.query(`ALTER ROLE ${role} PASSWORD NULL`); } finally { client.release(); }
}
async function as<T extends QueryResultRow = QueryResultRow>(pool: Pool, actor: 'public' | 'owner' | 'worker', sql: string, values: unknown[] = []): Promise<T[]> {
  const client: PoolClient = await pool.connect();
  try {
    await client.query('BEGIN');
    if (actor !== 'public') await client.query(`SELECT set_config('app.workspace_id',$1,true),set_config('app.actor_kind',$2,true),
      set_config('app.user_id',$3,true),set_config('app.request_id',$4,true)`, [WS, actor === 'owner' ? 'user' : 'worker', actor === 'owner' ? OWNER : '', `mhp-009c-${randomUUID()}`]);
    const result = await client.query<T>(sql, values);
    await client.query('COMMIT');
    return result.rows;
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}

test('MHP009C: owner connects WhatsApp, pins the approved template and sends one owned test through the unchanged rail', { skip }, async () => {
  const owner = await openTestDatabase();
  let pools: Partial<Pools> = {};
  try {
    await resetIdentityTables(owner);
    await ownerQuery(owner, 'TRUNCATE TABLE app_private.mhp_prospects CASCADE');
    await ownerQuery(owner, await readFile(new URL('./mhp-event-sms.fixture.sql', import.meta.url), 'utf8'));
    await ownerQuery(owner, await readFile(new URL('./mhp-owned-whatsapp.fixture.sql', import.meta.url), 'utf8'));
    const contentSha = (await ownerQuery<{ content_sha256: Buffer }>(owner, 'SELECT content_sha256 FROM app.company_content_versions WHERE id=$1', [VERSION]))[0]!.content_sha256;
    pools = await openLoginPools(owner);
    const p = pools as Pools;
    const cmd = p.r72_whatsapp_live_command;

    // The Property Predator command-role probe still passes with the new grants.
    await assert.doesNotReject(assertMetaWhatsAppLiveCommandBoundaryReady(cmd));
    // Boundaries.
    await expectPostgresError(as(p.r72_identity_command, 'public', 'SELECT app_private.mhp_whatsapp_snapshot($1,$2,$3)', [SESSION, CONTACT, PHONE]), '42501');
    await expectPostgresError(as(p.r72_whatsapp_live_worker_command, 'worker', 'SELECT app_private.mhp_whatsapp_snapshot($1,$2,$3)', [SESSION, CONTACT, PHONE]), '42501');
    await expectPostgresError(as(cmd, 'owner', 'SELECT app_private.mhp_whatsapp_snapshot($1,$2,$3)', [sha('not-a-session'), CONTACT, PHONE]), '42501');

    let snap = (await as<{ v: Record<string, unknown> }>(cmd, 'owner', 'SELECT app_private.mhp_whatsapp_snapshot($1,$2,$3) AS v', [SESSION, CONTACT, PHONE]))[0]!.v;
    assert.equal(snap.bindingId, null);
    assert.equal(snap.possessionProven, true, 'the owner proved this number with an SMS code');

    // Step 1: connect with an envelope sealed off-web (the worker key never reaches the web process).
    const connectionId = randomUUID(), bindingId = randomUUID();
    const binding = { workspaceId: WS, connectionId, appId: '1451249570430398', wabaId: '1874194210608511', phoneNumberId: '1412753418582729', graphApiVersion: 'v24.0' as const };
    const envelope = encryptMetaWhatsAppDispatchCredentials({ binding, credentials: { accessToken: `EAA${'x'.repeat(60)}` }, encryptionKey: randomBytes(32), keyVersion: 'disposable-v1' });
    const connect = (command: string, confirmed = true) => as<{ v: Record<string, unknown> }>(cmd, 'owner',
      'SELECT app_private.mhp_whatsapp_connect($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) AS v',
      [SESSION, command, connectionId, bindingId, binding.appId, binding.wabaId, binding.phoneNumberId, '+447861935832', envelope.keyVersion,
        Buffer.from(envelope.ivBase64, 'base64'), Buffer.from(envelope.ciphertextBase64, 'base64'), Buffer.from(envelope.authTagBase64, 'base64'),
        Buffer.from(envelope.aadSha256, 'hex'), Buffer.from(envelope.secretPayloadSha256, 'hex'), 'Meta Business Manager WABA 1874194210608511 owned by MH196 Ltd', confirmed]);
    await expectPostgresError(connect(randomUUID(), false), '42501');
    const connectCommand = randomUUID();
    const connected = (await connect(connectCommand))[0]!.v;
    assert.equal(connected.bindingId, bindingId);
    assert.equal((await connect(connectCommand))[0]!.v.replayed, true, 'same command replays');
    await expectPostgresError(connect(randomUUID()), '23505');
    const inbox = await ownerQuery(owner, `SELECT 1 FROM app.inboxes WHERE workspace_id=$1 AND channel='whatsapp' AND environment='live' AND status='active'`, [WS]);
    assert.equal(inbox.length, 1, 'inbound replies have their one live inbox');

    // Step 2: pin the approved, parameter-free template.
    const templateId = randomUUID();
    const record = (command: string) => as<{ v: Record<string, unknown> }>(cmd, 'owner',
      'SELECT app_private.mhp_whatsapp_record_template($1,$2,$3,$4,$5,$6,$7,$8,$9,true) AS v',
      [SESSION, command, bindingId, templateId, VERSION, contentSha, 'marketing', '1441099094827445', 'Meta WhatsApp Manager shows template 1441099094827445 Approved']);
    const pinned = (await record(randomUUID()))[0]!.v;
    assert.equal(pinned.templateName, 'mhp_webinar_20261104_reminder_v1');
    assert.equal(pinned.language, 'en_GB');

    // Step 3: one owned test.
    const send = (command: string, confirmed = true) => as<{ v: Record<string, unknown> }>(cmd, 'owner',
      'SELECT app_private.mhp_owned_whatsapp_send($1,$2,$3,$4,$5,$6,$7,false) AS v', [SESSION, command, bindingId, templateId, CONTACT, PHONE, confirmed]);
    await expectPostgresError(send(randomUUID(), false), '42501');
    await expectPostgresError(as(cmd, 'owner', 'SELECT app_private.mhp_owned_whatsapp_send($1,$2,$3,$4,$5,$6,true,false)',
      [SESSION, randomUUID(), bindingId, templateId, CONTACT, '+447700900111']), '42501');
    const command = randomUUID();
    const sent = (await send(command))[0]!.v;
    assert.equal(sent.state, 'queued');
    assert.equal(sent.providerEffects, 'none');
    const replay = (await send(command))[0]!.v;
    assert.equal(replay.replayed, true);
    assert.equal(replay.jobId, sent.jobId);
    await expectPostgresError(send(randomUUID()), '42501');
    const jobs = await ownerQuery<{ n: string }>(owner, 'SELECT count(*)::text AS n FROM app.property_predator_whatsapp_live_jobs');
    assert.equal(jobs[0]!.n, '1', 'the 0053 one-a-day cap holds');
    const evidence = await ownerQuery<{ operator: string; actor: string; consent_user: string; kind: string; verified: boolean }>(owner, `
      SELECT a.operator_user_id::text AS operator,c.actor_kind AS actor,c.actor_user_id::text AS consent_user,p.kind,p.is_verified AS verified
      FROM app.property_predator_whatsapp_live_authorities a
      JOIN app.communication_consent_events c ON c.workspace_id=a.workspace_id AND c.id=a.consent_event_id
      JOIN app.contact_points p ON p.workspace_id=a.workspace_id AND p.id=a.contact_point_id`);
    assert.deepEqual(evidence, [{ operator: OWNER, actor: 'user', consent_user: OWNER, kind: 'whatsapp', verified: true }],
      'the owner is both the operator and, as recipient, the person who gave the one-test permission');

    snap = (await as<{ v: Record<string, unknown> }>(cmd, 'owner', 'SELECT app_private.mhp_whatsapp_snapshot($1,$2,$3) AS v', [SESSION, CONTACT, PHONE]))[0]!.v;
    assert.equal(snap.bindingId, bindingId);
    assert.equal(snap.senderNumber, '+447861935832');
    assert.equal((snap.templates as unknown[]).length, 1);
    assert.equal((snap.lastResult as { state: string }).state, 'queued');

    // The 0053 worker (claim repaired in 0132) claims the job; no provider call is made.
    const worker = p.r72_whatsapp_live_worker_command;
    const claimed = await as<{ job_id: string; lease_version: string }>(worker, 'worker',
      'SELECT * FROM app_private.claim_whatsapp_live_job($1,$2,$3,60)', [WS, connectionId, randomBytes(32)]);
    assert.equal(claimed.length, 1);
    assert.equal(claimed[0]!.job_id, sent.jobId);
    // An expired lease runs the repaired recovery branch, then the job is claimed again.
    await ownerQuery(owner, `UPDATE app.property_predator_whatsapp_live_jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`, [sent.jobId]);
    const lease = randomBytes(32);
    const reclaimed = await as<{ job_id: string; lease_version: string }>(worker, 'worker',
      'SELECT * FROM app_private.claim_whatsapp_live_job($1,$2,$3,60)', [WS, connectionId, lease]);
    assert.equal(reclaimed[0]!.job_id, sent.jobId);
    assert.equal(Number(reclaimed[0]!.lease_version), Number(claimed[0]!.lease_version) + 1);
    // The unchanged pre-call re-proof accepts the owner authority.
    const began = await as<{ ok: boolean }>(worker, 'worker', 'SELECT app_private.begin_whatsapp_live_call($1,$2,$3,$4,true,false) AS ok',
      [WS, sent.jobId, reclaimed[0]!.lease_version, lease]);
    assert.equal(began[0]!.ok, true);
  } finally {
    await closeLoginPools(owner, pools).catch(() => undefined);
    await owner.end();
  }
});
