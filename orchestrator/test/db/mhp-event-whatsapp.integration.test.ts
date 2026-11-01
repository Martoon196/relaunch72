import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { expectPostgresError, openTestDatabase, ownerQuery, resetIdentityTables, testDatabaseSkipReason } from './database-helper.js';

// Real login roles: email proof -> WhatsApp's own signed JOIN -> worker Meta
// template read -> one owner review -> absolute-due worker on the 0053 rail.
// An SMS verification never counts, and WhatsApp STOP never touches SMS.
const skip = testDatabaseSkipReason();
const WS = '2789228d-55a6-4688-b1e8-2f70abca990b';
const OWNER = '0b131000-0000-4000-8000-000000000001';
const WA_CONNECTION = '0b132000-0000-4000-8000-000000000001';
const WA_BINDING = '0b132000-0000-4000-8000-000000000003';
const PROGRAMME = '0b131000-0000-4000-8000-00000000000a';
const META_ID = '1441099094827445';
const BODY = 'Thanks for registering for the Martin Howard Property webinar. The replay is now on your Desk.';
const sha = (value: string | Buffer): Buffer => createHash('sha256').update(value).digest();
const SESSION = sha('mhp-009b-owner-session');
const CONSENT_TEXT = 'Send me a WhatsApp follow-up about this Martin Howard Property webinar at this number. These messages are only about this webinar, not other marketing. Reply STOP to opt out.';
const ROLES = ['r72_identity_command', 'r72_whatsapp_live_command', 'r72_whatsapp_live_worker_command', 'r72_whatsapp_live_webhook_command'] as const;
type Role = typeof ROLES[number];
type Pools = Record<Role, Pool>;
type Actor = 'public' | 'owner' | 'worker' | 'webhook';

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
      pools[role] = new Pool({ connectionString: url.toString(), max: 3, application_name: `relaunch72-disposable-${role}-009c` });
    }
  } finally { client.release(); }
  return pools;
}
async function closeLoginPools(owner: Pool, pools: Partial<Pools>): Promise<void> {
  await Promise.allSettled(Object.values(pools).map(pool => pool.end()));
  const client = await owner.connect();
  try { for (const role of ROLES) await client.query(`ALTER ROLE ${role} PASSWORD NULL`); } finally { client.release(); }
}
async function withClient<T>(pool: Pool, actor: Actor, run: (client: PoolClient, request: string) => Promise<T>): Promise<T> {
  const client = await pool.connect(), request = `mhp-009c-${randomUUID()}`;
  try {
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    if (actor !== 'public') {
      await client.query(`SELECT set_config('app.workspace_id',$1,true),set_config('app.actor_kind',$2,true),set_config('app.user_id',$3,true),set_config('app.request_id',$4,true)`,
        [WS, actor === 'owner' ? 'user' : actor, actor === 'owner' ? OWNER : '', request]);
    }
    const result = await run(client, request);
    await client.query('COMMIT');
    return result;
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}
const as = <T extends QueryResultRow = QueryResultRow>(pool: Pool, actor: Actor, sql: string, values: unknown[] = []) =>
  withClient(pool, actor, async client => (await client.query<T>(sql, values)).rows);
const one = async <T>(pool: Pool, actor: Actor, sql: string, values: unknown[] = []): Promise<T> => (await as<{ value: T }>(pool, actor, sql, values))[0]!.value;
const phone = (n: number): string => `+4477009000${String(n).padStart(2, '0')}`;
const email = (n: number): string => `registrant-${n}@example.invalid`;
const nonce = (): string => Array.from(randomBytes(26), b => 'abcdefghijklmnopqrstuvwxyz234567'[b % 32]).join('');

async function chooseWhatsApp(p: Pools, n: number, number = phone(n)): Promise<{ capability: Buffer; nonce: string }> {
  const token = randomBytes(32), capability = randomBytes(32), command = randomUUID();
  const link = await one<{ send: boolean }>(p.r72_identity_command, 'public', 'SELECT app_private.mhp_event_phone_request_link($1,$2,$3,$4,$5) AS value',
    [email(n), command, sha(token), sha(command), randomBytes(32)]);
  assert.equal(link.send, true, 'a WhatsApp-only programme opens the email proof');
  assert.equal((await one<{ ok: boolean }>(p.r72_identity_command, 'public', 'SELECT app_private.mhp_event_phone_open($1,$2,$3,$4,$5) AS value',
    [sha(token), sha(capability), randomUUID(), randomBytes(32), randomBytes(32)])).ok, true);
  const joinNonce = nonce(), choose = randomUUID();
  const chosen = await one<{ ok: boolean }>(p.r72_identity_command, 'public', 'SELECT app_private.mhp_event_whatsapp_choose($1,$2,$3,$4,$5,$6,$7,$8) AS value',
    [sha(capability), choose, number, 'mhp.event-whatsapp/v1', sha(CONSENT_TEXT), sha(`mhp.event-whatsapp.join/v1:${joinNonce}`), sha(choose), randomBytes(32)]);
  assert.equal(chosen.ok, true, JSON.stringify(chosen));
  return { capability: sha(capability), nonce: joinNonce };
}
interface Inbound { id: string; body: string; sender: string; payload: Buffer; signature: Buffer; occurred: Date }
const inbound = (n: number, body: string): Inbound => ({ id: `wamid.${randomBytes(12).toString('hex')}`, body, sender: phone(n).slice(1),
  payload: randomBytes(32), signature: randomBytes(32), occurred: new Date(Date.now() - 1000) });
async function deliver(p: Pools, m: Inbound): Promise<string> {
  const external = `whatsapp-message:${m.id}`, senderSha = sha(m.sender), bodySha = sha(m.body);
  const identity = sha([external, m.id, senderSha.toString('hex'), bodySha.toString('hex'), m.payload.toString('hex'), m.signature.toString('hex')].join('\u001f'));
  return (await as<{ disposition: string }>(p.r72_whatsapp_live_webhook_command, 'webhook',
    'SELECT disposition FROM app_private.mhp_record_event_whatsapp_inbound($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
    [WS, WA_BINDING, external, m.id, m.sender, m.body, senderSha, bodySha, m.payload, m.signature, identity, m.occurred]))[0]!.disposition;
}
const observe = (p: Pools, status: string, body = BODY) => as(p.r72_whatsapp_live_worker_command, 'worker',
  'SELECT app_private.record_mhp_whatsapp_template_observation($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
  [WS, WA_BINDING, META_ID, 'mhp_webinar_20261104_reminder_v1', 'en_GB', status === 'READ_FAILED' ? 'UNKNOWN' : 'MARKETING', status, 0, sha(body), randomBytes(32), randomBytes(32)]);
interface Review { selectedReceiptIds: string[]; selectedRevisions: Record<string, number>; reviewSha256: string; programme: { programmeSha256: string; dueAt: string };
  templateObservation: { current: boolean; status: string | null }; awaitingOwnerReview: number; recipients: unknown[]; budget: { dayAvailable: number; monthAvailable: number } }
const review = (p: Pools) => one<Review>(p.r72_whatsapp_live_command, 'owner', 'SELECT app_private.mhp_event_whatsapp_review($1,$2) AS value', [SESSION, PROGRAMME]);
const activate = (p: Pools, command: string, r: Review) => withClient(p.r72_whatsapp_live_command, 'owner', async (client, request) =>
  (await client.query<{ value: Record<string, unknown> }>('SELECT app_private.mhp_event_whatsapp_activate($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) AS value',
    [SESSION, command, PROGRAMME, Buffer.from(r.programme.programmeSha256, 'hex'), r.selectedReceiptIds, JSON.stringify(r.selectedRevisions),
      Buffer.from(r.reviewSha256, 'hex'), request, true, false])).rows[0]!.value);

test('MHP009C WhatsApp follow-up: own JOIN, Meta read, owner batch and absolute-due worker under real roles', { skip, timeout: 420_000 }, async () => {
  const owner = await openTestDatabase();
  let pools: Partial<Pools> = {};
  try {
    await resetIdentityTables(owner);
    await ownerQuery(owner, 'TRUNCATE app_private.mhp_prospects CASCADE');
    await ownerQuery(owner, 'TRUNCATE app_private.mhp_unlinked_opt_events'); // no FK to a prospect by design; reset explicitly
    await ownerQuery(owner, await readFile(new URL('./mhp-event-whatsapp.fixture.sql', import.meta.url), 'utf8'));
    pools = await openLoginPools(owner);
    const p = pools as Pools;
    const due = new Date((await ownerQuery<{ due: string }>(owner, `SELECT content_body::jsonb->>'dueAt' AS due FROM app.company_content_versions WHERE id=$1`, [PROGRAMME]))[0]!.due);
    for (const role of ROLES) await expectPostgresError(as(p[role], role === 'r72_identity_command' ? 'public' : 'worker',
      'SELECT count(*) FROM app_private.mhp_event_whatsapp_intents'), '42501');

    // Registrants 1, 2 and 5 join through WhatsApp's own signed inbound path.
    const r1 = await chooseWhatsApp(p, 1), r2 = await chooseWhatsApp(p, 2), r5 = await chooseWhatsApp(p, 5);

    // Astra item 1 (WhatsApp). A signed STOP from a number with no WhatsApp point is recorded against the phone digest
    // under channel 'whatsapp' only; a pending WhatsApp JOIN is held; a later JOIN is held. An SMS-only key never counts.
    const seedUnlinked = async (channel: 'sms' | 'whatsapp', number: string, evidence: 'stop' | 'start'): Promise<void> => {
      const sms = channel === 'sms', id = sms ? `SM${randomBytes(16).toString('hex')}` : `wamid.${randomBytes(8).toString('hex')}`;
      await ownerQuery(owner, `INSERT INTO app_private.mhp_unlinked_opt_events(workspace_id,channel,provider_connection_id,whatsapp_binding_id,provider_event_id,
        provider_message_id,phone_identity_sha256,opt_evidence,body_sha256,payload_sha256,signature_sha256,event_identity_sha256,recorded_by_role,occurred_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,$9,$9,$10,statement_timestamp())`,
      [WS, channel, sms ? WA_CONNECTION : null, sms ? null : WA_BINDING, sms ? `inbound:${id}` : `whatsapp-message:${id}`, id, sha(number), evidence, randomBytes(32),
        sms ? 'r72_sms_webhook_command' : 'r72_whatsapp_live_webhook_command']);
    };
    await seedUnlinked('sms', phone(5), 'stop'); // registrant 5 still JOINs on WhatsApp below
    await chooseWhatsApp(p, 4, phone(8));
    const stop8 = inbound(8, 'STOP');
    assert.equal(await deliver(p, stop8), 'unlinked_stop');
    assert.equal(await deliver(p, stop8), 'replayed');
    await expectPostgresError(deliver(p, inbound(8, 'hello')), '23503'); // an ordinary message from an unknown number keeps the refusal
    const unlinked8 = await ownerQuery<{ wa: number; sms: number; held: number; points: number }>(owner, `SELECT
      (SELECT count(*)::int FROM app_private.mhp_unlinked_opt_events WHERE channel='whatsapp' AND phone_identity_sha256=$1 AND opt_evidence='stop') wa,
      (SELECT count(*)::int FROM app_private.mhp_unlinked_opt_events WHERE channel='sms' AND phone_identity_sha256=$1) sms,
      (SELECT count(*)::int FROM app_private.mhp_event_whatsapp_intents WHERE phone_e164=$2 AND state='held' AND hold_reason='suppressed') held,
      (SELECT count(*)::int FROM app.contact_points WHERE kind='whatsapp' AND normalized_value=$3) points`, [sha(phone(8)), phone(8), phone(8).slice(1)]);
    assert.deepEqual(unlinked8[0], { wa: 1, sms: 0, held: 1, points: 0 }, 'durable under whatsapp only; the pending JOIN is held; no contact or point');
    assert.equal(await deliver(p, inbound(9, 'STOP')), 'unlinked_stop');
    const r6 = await chooseWhatsApp(p, 6, phone(9));
    assert.equal(await deliver(p, inbound(9, `JOIN ${r6.nonce}`)), 'event_held', 'a later JOIN from a number whose latest WhatsApp event is STOP is held');
    await expectPostgresError(deliver(p, inbound(9, `JOIN ${r1.nonce}`)), '23503');
    const join1 = inbound(1, `JOIN ${r1.nonce.toUpperCase()}`);
    assert.equal(await deliver(p, join1), 'event_joined');
    assert.equal(await deliver(p, join1), 'replayed');
    assert.equal(await deliver(p, inbound(2, `join ${r2.nonce}`)), 'event_joined');
    assert.equal(await deliver(p, inbound(5, `JOIN ${r5.nonce}`)), 'event_joined');
    const facts = await ownerQuery<{ points: number; sms: number; marketing: number; event: number }>(owner, `SELECT
      (SELECT count(*)::int FROM app.contact_points WHERE kind='whatsapp' AND is_verified AND normalized_value ~ '^447') points,
      (SELECT count(*)::int FROM app.contact_points WHERE kind='phone') sms,
      (SELECT count(*)::int FROM app.communication_consent_events WHERE channel='whatsapp' AND purpose='marketing') marketing,
      (SELECT count(*)::int FROM app.communication_consent_events WHERE channel='whatsapp' AND purpose LIKE 'mhp.webinar.%' AND state='granted') event`);
    assert.deepEqual(facts[0], { points: 3, sms: 0, marketing: 0, event: 3 }, 'WhatsApp proof is its own; no SMS point, no general marketing');

    // Registrant 2 texts STOP on WhatsApp: WhatsApp suppression and event withdrawal only.
    assert.equal(await deliver(p, inbound(2, 'STOP')), 'applied');
    const stop = await ownerQuery<{ wa: number; sms: number }>(owner, `SELECT
      (SELECT count(*)::int FROM app.communication_suppression_events WHERE channel='whatsapp' AND reason='whatsapp_stop') wa,
      (SELECT count(*)::int FROM app.communication_suppression_events WHERE channel='sms') sms`);
    assert.deepEqual(stop[0], { wa: 1, sms: 0 });
    // STOP is matched as the first word, so a polite repeat is honoured too (and still never touches SMS).
    assert.equal(await deliver(p, inbound(2, 'Stop please')), 'applied');
    const again = await ownerQuery<{ wa: number; sms: number }>(owner, `SELECT
      (SELECT count(*)::int FROM app.communication_suppression_events WHERE channel='whatsapp' AND reason='whatsapp_stop') wa,
      (SELECT count(*)::int FROM app.communication_suppression_events WHERE channel='sms') sms`);
    assert.deepEqual(again[0], { wa: 2, sms: 0 });

    // No owner-typed approval: until the worker reads APPROVED from Meta nobody can be scheduled.
    // The worker learns exactly which template to read; the sealed credential decrypts only in the worker.
    const targets = await as<{ meta_template_id: string; template_name: string }>(p.r72_whatsapp_live_worker_command, 'worker',
      'SELECT meta_template_id,template_name FROM app_private.mhp_event_whatsapp_observation_targets($1,$2)', [WS, WA_BINDING]);
    assert.deepEqual(targets, [{ meta_template_id: META_ID, template_name: 'mhp_webinar_20261104_reminder_v1' }]);
    let first = await review(p);
    assert.equal(first.templateObservation.current, false); assert.equal(first.selectedReceiptIds.length, 0);
    await observe(p, 'PENDING');
    first = await review(p);
    assert.equal(first.templateObservation.status, 'PENDING'); assert.equal(first.selectedReceiptIds.length, 0);
    await observe(p, 'APPROVED', 'a different body');
    assert.equal((await review(p)).selectedReceiptIds.length, 0, 'an approved template whose body differs from the approved draft is not evidence');
    await observe(p, 'APPROVED');
    first = await review(p);
    assert.equal(first.templateObservation.current, true);
    assert.deepEqual([first.budget.dayAvailable, first.budget.monthAvailable], [1, 3], 'Astra item 3: an empty month reads 3 available, not 2');
    assert.equal(first.selectedReceiptIds.length, 1, 'unchanged 0053 cap: one WhatsApp send per day');
    assert.equal(first.awaitingOwnerReview, 1);
    const command = randomUUID();
    const done = await activate(p, command, first);
    assert.equal(done.count, 1); assert.equal(done.jobsCreated, 0);
    assert.equal((await activate(p, command, first)).replayed, true);
    const before = await ownerQuery<{ authorities: number; jobs: number; templates: number }>(owner, `SELECT
      (SELECT count(*)::int FROM app.property_predator_whatsapp_live_authorities) authorities,(SELECT count(*)::int FROM app.property_predator_whatsapp_live_jobs) jobs,
      (SELECT count(*)::int FROM app.property_predator_whatsapp_live_templates WHERE provider_status='approved') templates`);
    assert.deepEqual(before[0], { authorities: 0, jobs: 0, templates: 1 });

    // Before the due time nothing is prepared; afterwards exactly one event job.
    const prepare = () => one<{ prepared: unknown[] }>(p.r72_whatsapp_live_worker_command, 'worker', 'SELECT app_private.mhp_prepare_event_whatsapp($1,$2,3) AS value', [WS, WA_CONNECTION]);
    assert.equal((await prepare()).prepared.length, 0);
    const wait = due.getTime() - Date.now() + 1500;
    if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
    await observe(p, 'APPROVED');
    const raced = await Promise.all([prepare(), prepare()]);
    assert.equal(raced.reduce((n, r) => n + r.prepared.length, 0), 1);
    const provenance = await ownerQuery<{ kind: string; actor: string; user: string | null; permission: string | null }>(owner,
      `SELECT j.authority_kind kind,j.created_by_actor_kind actor,j.created_by_user_id::text "user",a.permission_use_receipt_id::text permission
       FROM app.property_predator_whatsapp_live_jobs j JOIN app.property_predator_whatsapp_live_authorities a ON a.id=j.authority_id`);
    assert.deepEqual(provenance, [{ kind: 'mhp_event', actor: 'worker', user: null, permission: null }]);

    // The legacy 0053 claim cannot see the event job.
    assert.equal((await as(p.r72_whatsapp_live_worker_command, 'worker', 'SELECT * FROM app_private.claim_whatsapp_live_job($1,$2,$3,60)', [WS, WA_CONNECTION, randomBytes(32)])).length, 0);
    const lease = randomBytes(32);
    const claimed = await as<{ job_id: string; lease_version: string }>(p.r72_whatsapp_live_worker_command, 'worker',
      'SELECT * FROM app_private.claim_event_whatsapp_job($1,$2,$3,60)', [WS, WA_CONNECTION, lease]);
    assert.equal(claimed.length, 1);
    const job = claimed[0]!;
    const material = await as<{ recipient: string; template_name: string; meta_template_id: string }>(p.r72_whatsapp_live_worker_command, 'worker',
      'SELECT recipient,template_name,meta_template_id FROM app_private.load_event_whatsapp_job($1,$2,$3,$4)', [WS, job.job_id, job.lease_version, lease]);
    assert.equal(material.length, 1); assert.notEqual(material[0]!.recipient, phone(2).slice(1));
    // Astra item 2: a failed fresh Meta read is recorded as READ_FAILED. The gate begin evaluates
    // (mhp_whatsapp_template_current: the latest observation must be APPROVED) is closed until a later read succeeds.
    await observe(p, 'READ_FAILED');
    const failedRead = await review(p);
    assert.deepEqual([failedRead.templateObservation.status, failedRead.templateObservation.current], ['READ_FAILED', false]);
    await observe(p, 'APPROVED');
    assert.equal((await review(p)).templateObservation.current, true);
    // Legacy load/begin are structurally blind to an event authority (no permission-use receipt).
    assert.equal((await as(p.r72_whatsapp_live_worker_command, 'worker', 'SELECT * FROM app_private.load_whatsapp_live_job($1,$2,$3,$4)', [WS, job.job_id, job.lease_version, lease])).length, 0);
    assert.equal(await one<boolean>(p.r72_whatsapp_live_worker_command, 'worker', 'SELECT app_private.begin_whatsapp_live_call($1,$2,$3,$4,true,false) AS value',
      [WS, job.job_id, job.lease_version, lease]), false);
    assert.equal(await one<boolean>(p.r72_whatsapp_live_worker_command, 'worker', 'SELECT app_private.begin_event_whatsapp_call($1,$2,$3,$4,true,false) AS value',
      [WS, job.job_id, job.lease_version, lease]), true);
    await as(p.r72_whatsapp_live_worker_command, 'worker', 'SELECT app_private.settle_whatsapp_live_call($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [WS, job.job_id, job.lease_version, lease, 'accepted', `wamid.${randomBytes(12).toString('hex')}`, randomBytes(32), 'meta_whatsapp_accepted', new Date()]);
    const final = await ownerQuery<{ state: string }>(owner, 'SELECT state FROM app.property_predator_whatsapp_live_jobs');
    assert.deepEqual(final, [{ state: 'awaiting_status' }]);
    assert.equal((await prepare()).prepared.length, 0, 'the daily cap and once-only step leave nothing else to prepare');
    // Astra item 1 (WhatsApp): the owner review and every scheduled send share the grant gate. The other granted
    // registrant still awaits a review; an unlinked WhatsApp STOP for that number removes them, an SMS key never does.
    const pending = await review(p);
    assert.equal(pending.recipients.length, 1);
    const pendingNumber = (await ownerQuery<{ phone: string }>(owner, `SELECT '+'||cp.normalized_value AS phone FROM app_private.mhp_event_whatsapp_receipts r
      JOIN app.contact_points cp ON cp.id=r.contact_point_id WHERE r.id=$1`, [(pending.recipients[0] as { receiptId: string }).receiptId]))[0]!.phone;
    await seedUnlinked('sms', pendingNumber, 'stop');
    assert.equal((await review(p)).recipients.length, 1, 'an SMS-only opt-out never counts for WhatsApp');
    await seedUnlinked('whatsapp', pendingNumber, 'stop');
    assert.equal((await review(p)).recipients.length, 0, 'the unlinked WhatsApp STOP removes the number from every future batch');
  } finally {
    await closeLoginPools(owner, pools);
    await owner.end();
  }
});
