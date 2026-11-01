import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { expectPostgresError, openTestDatabase, ownerQuery, resetIdentityTables, testDatabaseSkipReason } from './database-helper.js';

// Real login roles end to end: public email proof -> signed JOIN -> one owner
// batch review -> absolute-due worker -> existing SMS lease/begin/settle, with
// STOP before begin, replay/conflict, legacy isolation and a prepare race.
const skip = testDatabaseSkipReason();
const WS = '2789228d-55a6-4688-b1e8-2f70abca990b';
const OWNER = '0b131000-0000-4000-8000-000000000001';
const CONNECTION = '0b131000-0000-4000-8000-000000000002';
const PROGRAMME = '0b131000-0000-4000-8000-00000000000a';
const sha = (value: string | Buffer): Buffer => createHash('sha256').update(value).digest();
const SESSION = sha('mhp-009b-owner-session');
const CONSENT_REVISION = 'mhp.event-phone-sms/v1';
const CONSENT_TEXT = 'Text me a reminder about this Martin Howard Property webinar at this mobile number. These texts are only about this webinar, not other marketing. Reply STOP to opt out.';
const ROLES = ['r72_identity_command', 'r72_sms_command', 'r72_sms_worker_command', 'r72_sms_webhook_command'] as const;
type Role = typeof ROLES[number];
type Pools = Record<Role, Pool>;
type Actor = 'public' | 'owner' | 'worker' | 'webhook';

async function openLoginPools(owner: Pool): Promise<Pools> {
  const rawUrl = process.env.TEST_DATABASE_URL?.trim();
  if (!rawUrl) throw new Error('TEST_DATABASE_URL is required');
  const pools = {} as Pools;
  const client = await owner.connect();
  try {
    for (const role of ROLES) {
      const password = `mhp-009b-${randomUUID()}`;
      const statement = await client.query<{ sql: string }>(`SELECT pg_catalog.format('ALTER ROLE %I PASSWORD %L', $1::text, $2::text) AS sql`, [role, password]);
      await client.query(statement.rows[0]!.sql);
      const url = new URL(rawUrl); url.username = role; url.password = password;
      pools[role] = new Pool({ connectionString: url.toString(), max: 3, application_name: `relaunch72-disposable-${role}-009b` });
    }
  } finally { client.release(); }
  return pools;
}

async function closeLoginPools(owner: Pool, pools: Partial<Pools>): Promise<void> {
  await Promise.allSettled(Object.values(pools).map(pool => pool.end()));
  const client = await owner.connect();
  try { for (const role of ROLES) await client.query(`ALTER ROLE ${role} PASSWORD NULL`); } finally { client.release(); }
}

async function withClient<T>(pool: Pool, actor: Actor, run: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    if (actor !== 'public') {
      await client.query(`SELECT set_config('app.workspace_id',$1,true),set_config('app.actor_kind',$2,true),
        set_config('app.user_id',$3,true),set_config('app.request_id',$4,true)`,
        [WS, actor === 'owner' ? 'user' : actor, actor === 'owner' ? OWNER : '', `mhp-009b-${randomUUID()}`]);
    }
    const result = await run(client);
    await client.query('COMMIT');
    return result;
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}
async function as<T extends QueryResultRow = QueryResultRow>(pool: Pool, actor: Actor, sql: string, values: unknown[] = []): Promise<T[]> {
  return withClient(pool, actor, async client => (await client.query<T>(sql, values)).rows);
}
async function one<T>(pool: Pool, actor: Actor, sql: string, values: unknown[] = []): Promise<T> {
  return (await as<{ value: T }>(pool, actor, sql, values))[0]!.value;
}

const phone = (n: number): string => `+4477009000${String(n).padStart(2, '0')}`;
const email = (n: number): string => `registrant-${n}@example.invalid`;
const nonce = (): string => Array.from(randomBytes(26), b => 'abcdefghijklmnopqrstuvwxyz234567'[b % 32]).join('');

interface Joined { capability: Buffer; intentId: string; nonce: string }
async function openAndChoose(pools: Pools, n: number): Promise<Joined> {
  const token = randomBytes(32), capability = randomBytes(32), command = randomUUID();
  const link = await one<{ send: boolean }>(pools.r72_identity_command, 'public',
    'SELECT app_private.mhp_event_phone_request_link($1,$2,$3,$4,$5) AS value',
    [email(n), command, sha(Buffer.concat([Buffer.from('mhp.event-phone.access/v1:'), token])), sha(command), randomBytes(32)]);
  assert.equal(link.send, true);
  const opened = await one<{ ok: boolean }>(pools.r72_identity_command, 'public', 'SELECT app_private.mhp_event_phone_open($1,$2,$3,$4,$5) AS value',
    [sha(Buffer.concat([Buffer.from('mhp.event-phone.access/v1:'), token])), sha(capability), randomUUID(), randomBytes(32), randomBytes(32)]);
  assert.equal(opened.ok, true);
  const joinNonce = nonce(), choose = randomUUID();
  const chosen = await one<{ ok: boolean; intentId: string }>(pools.r72_identity_command, 'public',
    'SELECT app_private.mhp_event_phone_choose($1,$2,$3,$4,$5,$6,$7,$8) AS value',
    [sha(capability), choose, phone(n), CONSENT_REVISION, sha(CONSENT_TEXT), sha(`mhp.event-phone.join/v1:${joinNonce}`), sha(choose), randomBytes(32)]);
  assert.equal(chosen.ok, true, JSON.stringify(chosen));
  return { capability: sha(capability), intentId: chosen.intentId, nonce: joinNonce };
}

interface Inbound { sid: string; body: string; sender: string; payload: Buffer; signature: Buffer; occurred: Date }
function inbound(n: number, body: string): Inbound {
  return { sid: `SM${randomBytes(16).toString('hex')}`, body, sender: phone(n).slice(1), payload: randomBytes(32), signature: randomBytes(32), occurred: new Date(Date.now() - 1000) };
}
async function deliverInbound(pools: Pools, message: Inbound, opt = ''): Promise<string> {
  const external = `inbound:${message.sid}`, senderSha = sha(message.sender), bodySha = sha(message.body);
  const identity = sha([external, message.sid, senderSha.toString('hex'), bodySha.toString('hex'), message.payload.toString('hex'),
    message.signature.toString('hex')].join('\u001f'));
  const rows = await as<{ disposition: string }>(pools.r72_sms_webhook_command, 'webhook',
    'SELECT disposition FROM app_private.mhp_record_event_sms_inbound($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)',
    [WS, CONNECTION, external, message.sid, message.sender, opt, message.body, senderSha, bodySha, message.payload, message.signature, identity, message.occurred]);
  return rows[0]!.disposition;
}

interface Review { selectedReceiptIds: string[]; selectedRevisions: Record<string, number>; reviewSha256: string; maxBatch: number;
  programme: { programmeSha256: string; dueAt: string }; recipients: { receiptId: string }[]; excluded: Record<string, number> }
const review = (pools: Pools): Promise<Review> => one<Review>(pools.r72_sms_command, 'owner',
  'SELECT app_private.mhp_event_phone_review($1,$2) AS value', [SESSION, PROGRAMME]);
async function activate(pools: Pools, command: string, r: Review, override: Partial<{ receipts: string[]; reviewSha: string }> = {}): Promise<Record<string, unknown>> {
  return withClient(pools.r72_sms_command, 'owner', async client => {
    const request = (await client.query<{ r: string }>(`SELECT current_setting('app.request_id') AS r`)).rows[0]!.r;
    const receipts = override.receipts ?? r.selectedReceiptIds;
    const revisions = Object.fromEntries(receipts.map(id => [id, r.selectedRevisions[id] ?? 1]));
    return (await client.query<{ value: Record<string, unknown> }>('SELECT app_private.mhp_event_phone_activate($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) AS value',
      [SESSION, command, PROGRAMME, Buffer.from(r.programme.programmeSha256, 'hex'), receipts, JSON.stringify(revisions),
        Buffer.from(override.reviewSha ?? r.reviewSha256, 'hex'), request, true, false])).rows[0]!.value;
  });
}
const prepare = (pools: Pools) => one<{ prepared: { calendarId: string; jobId: string; replayed: boolean }[]; held: { reason: string }[] }>(
  pools.r72_sms_worker_command, 'worker', 'SELECT app_private.mhp_prepare_event_sms($1,$2,10) AS value', [WS, CONNECTION]);

test('MHP009B event phone permission, owner batch and absolute-due worker under real roles', { skip, timeout: 420_000 }, async () => {
  const owner = await openTestDatabase();
  let pools: Partial<Pools> = {};
  try {
    await resetIdentityTables(owner);
    await ownerQuery(owner, 'TRUNCATE app_private.mhp_prospects CASCADE');
    await ownerQuery(owner, await readFile(new URL('./mhp-event-phone.fixture.sql', import.meta.url), 'utf8'));
    pools = await openLoginPools(owner);
    const p = pools as Pools;
    const due = new Date((await ownerQuery<{ due: string }>(owner, `SELECT (content_body::jsonb->>'dueAt') AS due FROM app.company_content_versions WHERE id=$1`, [PROGRAMME]))[0]!.due);

    // Email proof: unknown email is uniform, replay never re-sends, a used link stays used.
    const unknown = await one<{ send: boolean }>(p.r72_identity_command, 'public', 'SELECT app_private.mhp_event_phone_request_link($1,$2,$3,$4,$5) AS value',
      ['nobody@example.invalid', randomUUID(), randomBytes(32), randomBytes(32), randomBytes(32)]);
    assert.equal(unknown.send, false);
    const command = randomUUID(), token = randomBytes(32), tokenSha = sha(Buffer.concat([Buffer.from('mhp.event-phone.access/v1:'), token]));
    const link = await one<{ send: boolean; email: string }>(p.r72_identity_command, 'public', 'SELECT app_private.mhp_event_phone_request_link($1,$2,$3,$4,$5) AS value',
      [email(6), command, tokenSha, sha(command), randomBytes(32)]);
    assert.equal(link.send, true); assert.equal(link.email, email(6));
    const replay = await one<{ send: boolean; replayed: boolean }>(p.r72_identity_command, 'public', 'SELECT app_private.mhp_event_phone_request_link($1,$2,$3,$4,$5) AS value',
      [email(6), command, tokenSha, sha(command), randomBytes(32)]);
    assert.deepEqual([replay.send, replay.replayed], [false, true]);
    await expectPostgresError(as(p.r72_identity_command, 'public', 'SELECT app_private.mhp_event_phone_request_link($1,$2,$3,$4,$5)',
      [email(6), command, tokenSha, randomBytes(32), randomBytes(32)]), '40001');
    const capability = randomBytes(32);
    assert.equal((await one<{ ok: boolean }>(p.r72_identity_command, 'public', 'SELECT app_private.mhp_event_phone_open($1,$2,$3,$4,$5) AS value',
      [tokenSha, sha(capability), randomUUID(), randomBytes(32), randomBytes(32)])).ok, true);
    const reused = await one<{ ok: boolean; reason: string }>(p.r72_identity_command, 'public', 'SELECT app_private.mhp_event_phone_open($1,$2,$3,$4,$5) AS value',
      [tokenSha, sha(randomBytes(32)), randomUUID(), randomBytes(32), randomBytes(32)]);
    assert.deepEqual([reused.ok, reused.reason], [false, 'used']);
    // Changed wording or a non-UK-mobile number is refused; no intent, no grant.
    await expectPostgresError(as(p.r72_identity_command, 'public', 'SELECT app_private.mhp_event_phone_choose($1,$2,$3,$4,$5,$6,$7,$8)',
      [sha(capability), randomUUID(), phone(6), CONSENT_REVISION, sha('other words'), randomBytes(32), randomBytes(32), randomBytes(32)]), '40001');
    await expectPostgresError(as(p.r72_identity_command, 'public', 'SELECT app_private.mhp_event_phone_choose($1,$2,$3,$4,$5,$6,$7,$8)',
      [sha(capability), randomUUID(), '+441632960000', CONSENT_REVISION, sha(CONSENT_TEXT), randomBytes(32), randomBytes(32), randomBytes(32)]), '22023');
    // Runtime roles are table-blind.
    for (const role of ROLES) await expectPostgresError(as(p[role], role === 'r72_identity_command' ? 'public' : 'worker',
      'SELECT count(*) FROM app_private.mhp_event_phone_intents'), '42501');

    // Registrants 1 (existing CRM contact by email), 2 and 5 (no CRM contact) choose and JOIN.
    const r1 = await openAndChoose(p, 1), r2 = await openAndChoose(p, 2), r5 = await openAndChoose(p, 5), r3 = await openAndChoose(p, 3);
    // A JOIN from the wrong number is ordinary inbound (unknown sender: existing refusal), never a grant.
    await expectPostgresError(deliverInbound(p, inbound(9, `JOIN ${r1.nonce}`)), '23503');
    const join1 = inbound(1, `JOIN ${r1.nonce.toUpperCase()}`);
    assert.equal(await deliverInbound(p, join1), 'event_joined');
    assert.equal(await deliverInbound(p, join1), 'replayed');
    assert.equal(await deliverInbound(p, inbound(2, ` join ${r2.nonce} `)), 'event_joined');
    assert.equal(await deliverInbound(p, inbound(5, `JOIN ${r5.nonce}`)), 'event_joined');
    assert.equal(await deliverInbound(p, inbound(3, `JOIN ${r3.nonce}`)), 'event_joined');
    const crm = await ownerQuery<{ n: number; source: string | null; verified: boolean; marketing: number; event: number }>(owner, `
      SELECT (SELECT count(*)::int FROM app.contacts c WHERE c.workspace_id=$1) n,
       (SELECT c.source FROM app.contacts c JOIN app.contact_points cp ON cp.contact_id=c.id WHERE cp.normalized_value=$2) source,
       (SELECT bool_and(cp.is_verified) FROM app.contact_points cp WHERE cp.kind='phone') verified,
       (SELECT count(*)::int FROM app.communication_consent_events e WHERE e.channel='sms' AND e.purpose='marketing') marketing,
       (SELECT count(*)::int FROM app.communication_consent_events e WHERE e.channel='sms' AND e.purpose LIKE 'mhp.webinar.%' AND e.state='granted') event`,
    [WS, phone(5)]);
    assert.equal(crm[0]!.n, 5, 'four imported contacts reused, one new contact for registrant 5');
    assert.match(crm[0]!.source!, /^mhp:event-phone:webinar-/u);
    assert.equal(crm[0]!.verified, true); assert.equal(crm[0]!.marketing, 0); assert.equal(crm[0]!.event, 4);

    // Registrant 3 withdraws through their own bounded capability: excluded from review.
    const status3 = await one<{ sms: { grantReceiptId: string; state: string } }>(p.r72_identity_command, 'public', 'SELECT app_private.mhp_event_phone_status($1) AS value', [r3.capability]);
    assert.equal(status3.sms.state, 'verified');
    const withdraw = randomUUID();
    assert.equal((await one<{ ok: boolean }>(p.r72_identity_command, 'public', 'SELECT app_private.mhp_event_phone_withdraw($1,$2,$3,$4) AS value',
      [r3.capability, withdraw, status3.sms.grantReceiptId, sha(withdraw)])).ok, true);

    // One owner review of the exact recipients; no authority/job/send created.
    const first = await review(p);
    assert.equal(first.selectedReceiptIds.length, 3); assert.equal(first.excluded.withdrawn, 1);
    const stale = { ...first, reviewSha256: randomBytes(32).toString('hex') };
    await expectPostgresError(activate(p, randomUUID(), stale), '40001');
    const unsorted = [...first.selectedReceiptIds].reverse();
    await expectPostgresError(activate(p, randomUUID(), first, { receipts: unsorted }), '42501');
    const activation = randomUUID();
    const done = await activate(p, activation, first);
    assert.equal(done.count, 3); assert.equal(done.authorityCreated, false); assert.equal(done.jobsCreated, 0);
    const again = await activate(p, activation, first);
    assert.equal(again.replayed, true); assert.deepEqual(again.scheduled, done.scheduled);
    const counts = await ownerQuery<{ authorities: number; jobs: number; deliveries: number; reserved: number; committed: number }>(owner, `
      SELECT (SELECT count(*)::int FROM app.property_predator_sms_authorities) authorities,(SELECT count(*)::int FROM app.property_predator_sms_jobs) jobs,
       (SELECT count(*)::int FROM app.message_deliveries d WHERE d.status='queued' AND d.purpose LIKE 'mhp.webinar.%') deliveries,
       (SELECT count(*)::int FROM app.provider_operations o WHERE o.state='reconciliation_required' AND o.last_error_code='twilio_sms_live_reserved' AND o.next_attempt_at='infinity') reserved,
       (SELECT count(*)::int FROM app.messages m WHERE m.lifecycle='committed' AND m.created_by_user_id=$1) committed`, [OWNER]);
    assert.deepEqual(counts[0], { authorities: 0, jobs: 0, deliveries: 3, reserved: 3, committed: 3 });
    // A later entrant waits for a new owner review; the reviewed batch is not extended.
    const r4 = await openAndChoose(p, 4);
    assert.equal(await deliverInbound(p, inbound(4, `JOIN ${r4.nonce}`)), 'event_joined');
    const second = await review(p);
    assert.equal(second.selectedReceiptIds.length, 1);

    // Legacy isolation: the email claim and the owner-SMS rail never touch the SMS calendar.
    const emailClaim = await one<unknown[]>(p.r72_identity_command, 'public', 'SELECT app_private.mhp_claim_marketing_sends(50,60,NULL) AS value');
    assert.ok(emailClaim.every(row => (row as { template: string }).template !== 'event_sms_1h'));
    await as(p.r72_identity_command, 'public', 'SELECT app_private.mhp_unsubscribe_prospect($1)', ['0b131100-0000-4000-8000-000000000002']);
    const legacyState = await ownerQuery<{ cancelled: number; leased: number }>(owner, `SELECT count(*) FILTER (WHERE cancelled_at IS NOT NULL)::int cancelled,
      count(*) FILTER (WHERE lease_until IS NOT NULL)::int leased FROM app_private.mhp_marketing_sends WHERE delivery_channel='sms'`);
    assert.deepEqual(legacyState[0], { cancelled: 0, leased: 0 });

    // Before the absolute due time the worker prepares nothing.
    assert.equal((await prepare(p)).prepared.length, 0);
    const wait = due.getTime() - Date.now() + 1500;
    if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));

    // Two distinct backends race the same due rows: exactly one job per row.
    const raced = await Promise.all([prepare(p), prepare(p)]);
    const created = raced.flatMap(r => r.prepared.filter(x => !x.replayed));
    assert.equal(created.length, 3);
    assert.equal(new Set(created.map(x => x.calendarId)).size, 3);
    const provenance = await ownerQuery<{ kind: string; actor: string; user: string | null; role: string; operator: string | null; permission: string | null }>(owner, `
      SELECT j.authority_kind kind,j.created_by_actor_kind actor,j.created_by_user_id::text "user",a.evaluated_by_role role,a.operator_user_id::text operator,
       a.permission_use_receipt_id::text permission FROM app.property_predator_sms_jobs j JOIN app.property_predator_sms_authorities a ON a.id=j.authority_id`);
    assert.ok(provenance.every(r => r.kind === 'mhp_event' && r.actor === 'worker' && r.user === null && r.role === 'r72_sms_worker_command'
      && r.operator === null && r.permission === null));
    assert.equal((await prepare(p)).prepared.length, 0, 'prepared rows are no longer candidates');

    // The old owner-SMS worker cannot claim or load event jobs.
    const legacyClaim = await as(p.r72_sms_worker_command, 'worker', 'SELECT * FROM app_private.claim_sms_live_job($1,$2,$3,60)', [WS, CONNECTION, randomBytes(32)]);
    assert.equal(legacyClaim.length, 0);

    // Registrant 2 texts STOP after preparation, before any claim: never leased, cancelled.
    assert.equal(await deliverInbound(p, inbound(2, 'STOP'), 'stop'), 'applied');
    const claim = async (): Promise<{ job: { job_id: string; lease_version: string }; lease: Buffer; recipient: string } | null> => {
      const lease = randomBytes(32);
      const claimed = await as<{ job_id: string; lease_version: string }>(p.r72_sms_worker_command, 'worker',
        'SELECT * FROM app_private.claim_event_sms_job($1,$2,$3,60)', [WS, CONNECTION, lease]);
      if (claimed.length === 0) return null;
      const material = await one<{ recipient: string; body: string; providerExpiresAt: string } | null>(p.r72_sms_worker_command, 'worker',
        'SELECT app_private.load_event_sms_job($1,$2,$3,$4) AS value', [WS, claimed[0]!.job_id, claimed[0]!.lease_version, lease]);
      assert.ok(material); assert.notEqual(material.recipient, phone(2)); assert.match(material.providerExpiresAt, /Z$/u);
      // The old owner begin refuses an event lease without touching it.
      const legacyBegin = await one<boolean>(p.r72_sms_worker_command, 'worker', 'SELECT app_private.begin_sms_live_call($1,$2,$3,$4,true,true,false) AS value',
        [WS, claimed[0]!.job_id, claimed[0]!.lease_version, lease]);
      assert.equal(legacyBegin, false);
      return { job: claimed[0]!, lease, recipient: material.recipient };
    };
    const begin = (c: { job: { job_id: string; lease_version: string }; lease: Buffer }) => one<boolean>(p.r72_sms_worker_command, 'worker',
      'SELECT app_private.begin_event_sms_call($1,$2,$3,$4,true,true,false) AS value', [WS, c.job.job_id, c.job.lease_version, c.lease]);
    // Next leased job: its registrant texts STOP after the claim and before begin -> denied.
    const leased = await claim();
    assert.ok(leased);
    const stopper = [1, 5].find(n => phone(n) === leased.recipient)!;
    assert.equal(await deliverInbound(p, inbound(stopper, 'STOP'), 'stop'), 'applied');
    assert.equal(await begin(leased), false);
    // The last job is current, begins once and settles through the shared settlement.
    const last = await claim();
    assert.ok(last);
    assert.equal(await begin(last), true);
    assert.equal(await begin(last), false, 'a call begins exactly once');
    await as(p.r72_sms_worker_command, 'worker', 'SELECT app_private.settle_sms_live_call($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
      [WS, last.job.job_id, last.job.lease_version, last.lease, 'accepted', `SM${randomBytes(16).toString('hex')}`, new Date(), false, null, 'Accepted by Twilio', randomBytes(32)]);
    assert.equal(await claim(), null);
    const final = await ownerQuery<{ state: string; n: number }>(owner, `SELECT state,count(*)::int n FROM app.property_predator_sms_jobs GROUP BY state ORDER BY state`);
    assert.deepEqual(final, [{ state: 'awaiting_receipt', n: 1 }, { state: 'cancelled', n: 1 }, { state: 'needs_attention', n: 1 }]);
    // Nothing is claimable twice and no email row was ever marked sent for an SMS step.
    const emailSent = await ownerQuery<{ n: number }>(owner, `SELECT count(*)::int n FROM app_private.mhp_marketing_sends WHERE delivery_channel='sms' AND sent_at IS NOT NULL`);
    assert.equal(emailSent[0]!.n, 0);
  } finally {
    await closeLoginPools(owner, pools);
    await owner.end();
  }
});
