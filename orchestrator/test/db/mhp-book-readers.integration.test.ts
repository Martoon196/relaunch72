import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Pool } from 'pg';
import { openTestDatabase, ownerQuery, resetIdentityTables, testDatabaseSkipReason } from './database-helper.js';
import { MhpSequenceService, PgMhpSequenceRepository } from '../../src/mhp/followup-sequence-service.js';
import { PgMhpSequenceDispatch } from '../../src/mhp/followup-sequence-dispatch.js';
import { MhpCommerceError } from '../../src/mhp/commerce-service.js';
import { BOOK_READERS_DATABASE_STEP } from '../../src/followup-sequences/audience.js';
import { FOLLOWUP_SEQUENCE_MIME } from '../../src/followup-sequences/definition.js';
import type { CompanyContentExactReview } from '../../src/company-content-pg/index.js';

// Release B against the real 0160 functions, through the real repository and worker dispatch, as the real login roles.
const skip = testDatabaseSkipReason();
const WS = '2789228d-55a6-4688-b1e8-2f70abca990b', OWNER = '5afe4000-0000-4000-8000-000000000001', CAMPAIGN = 'webinar-2026-11-03';
const TOKEN = 'mhpSequenceSafetyOwnerSessionToken000000001';
const A = { item: '5afe4000-0000-4000-8000-0000000000a1', version: '5afe4000-0000-4000-8000-0000000000a2' };
const B = { item: '5afe4000-0000-4000-8000-0000000000b1', version: '5afe4000-0000-4000-8000-0000000000b2' };
const C = { item: '5afe4000-0000-4000-8000-0000000000c1', version: '5afe4000-0000-4000-8000-0000000000c2' };
const D = { item: '5afe4000-0000-4000-8000-0000000000d1', version: '5afe4000-0000-4000-8000-0000000000d2' };
const book = (n: number) => `5afe6000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const READER1 = '5afe5000-0000-4000-8000-000000000001';
const identity = { sessionToken: TOKEN, userId: OWNER, workspaceId: WS, userEmail: 'martin.howard1984@gmail.com' } as const;
const ROLES = ['r72_web', 'r72_identity_command'] as const;
const tokenHash = createHash('sha256').update(TOKEN).digest();

async function loginPools(owner: Pool, raw = process.env.TEST_DATABASE_URL!.trim()): Promise<Record<typeof ROLES[number], Pool>> {
  const pools = {} as Record<typeof ROLES[number], Pool>, client = await owner.connect();
  try {
    for (const role of ROLES) {
      const password = `book-readers-${randomUUID()}`;
      const statement = await client.query<{ sql: string }>(`SELECT pg_catalog.format('ALTER ROLE %I PASSWORD %L', $1::text, $2::text) AS sql`, [role, password]);
      await client.query(statement.rows[0]!.sql);
      const url = new URL(raw); url.username = role; url.password = password;
      pools[role] = new Pool({ connectionString: url.toString(), max: 2, application_name: `relaunch72-disposable-${role}-book-readers` });
    }
  } finally { client.release(); }
  return pools;
}
async function load(owner: Pool, file: string) {
  const sql = await readFile(new URL(file, import.meta.url), 'utf8'), client = await owner.connect();
  try { await client.query('BEGIN'); await client.query('SET LOCAL ROLE r72_owner'); await client.query("SELECT set_config('seq.token',$1,true)", [TOKEN]); await client.query(sql); await client.query('COMMIT'); }
  catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}
const runs = (owner: Pool) => ownerQuery<{ id: string; item: string; version: string; prospect: string; state: string; reason: string | null; audience: string; book_signup_id: string | null }>(owner,
  `SELECT id,sequence_item_id AS item,sequence_version_id AS version,prospect_id AS prospect,state,reason,audience,book_signup_id FROM app_private.mhp_followup_runs ORDER BY created_at,id`);
const code = (error: unknown) => (error as { code?: string }).code;

test('book readers audience against the real 0160 functions', { skip, timeout: 420_000 }, async () => {
  const owner = await openTestDatabase();
  let pools: Partial<Record<typeof ROLES[number], Pool>> = {};
  try {
    await ownerQuery(owner, 'TRUNCATE app_private.mhp_book_entry_receipts, app_private.mhp_book_entry_switches, app_private.mhp_followup_runs, app_private.mhp_marketing_sends, app_private.mhp_prospect_signups, app_private.mhp_prospects, app_private.email_address_blocks, app.purchases CASCADE');
    await resetIdentityTables(owner);
    await load(owner, './mhp-sequence-safety.fixture.sql');
    await load(owner, './mhp-book-readers.fixture.sql');
    pools = await loginPools(owner);
    const repository = new PgMhpSequenceRepository(pools.r72_web!, pools.r72_identity_command!);
    const commands = pools.r72_identity_command!;
    const req = () => `book-readers-${randomUUID()}`;

    // 1. Eligibility, each exclusion.
    const read = (await repository.eligible(identity, D.version, CAMPAIGN))!;
    assert.equal(read.audience, 'book_readers');
    assert.deepEqual(read.eligible.map(p => p.email).sort(), ['book-21@example.invalid', 'reader-1@example.invalid']);
    assert.deepEqual(read.heldBack, { noConsent: 1, unsubscribed: 1, blocked: 1, purchased: 1, alreadyIn: 0, earlierVersion: 0 });
    // Webinar registrants who are not book sign-ups are never eligible for a book readers sequence.
    for (const n of [2, 3, 4, 5, 6]) assert.ok(!read.eligible.some(p => p.prospectId === `5afe5000-0000-4000-8000-00000000000${n}`));
    // Versions saved without an audience, or "none yet", have nobody.
    for (const s of [B, C]) assert.equal((await repository.eligible(identity, s.version, CAMPAIGN))!.eligible.length, 0);

    // 2. The explicit-recipient start: one ineligible person on the list and nothing is started.
    await assert.rejects(commands.query('SELECT app_private.mhp_sequence_start_v2($1,$2,$3,$4,$5::uuid[],$6)', [tokenHash, randomUUID(), D.version, CAMPAIGN, [book(21), book(22)], req()]), (e: unknown) => code(e) === '23514');
    await assert.rejects(commands.query('SELECT app_private.mhp_sequence_start_v2($1,$2,$3,$4,$5::uuid[],$6)', [tokenHash, randomUUID(), D.version, CAMPAIGN, [book(25)], req()]), (e: unknown) => code(e) === '23514');
    await assert.rejects(commands.query('SELECT app_private.mhp_sequence_start_v2($1,$2,$3,$4,$5::uuid[],$6)', [tokenHash, randomUUID(), D.version, CAMPAIGN, ['5afe5000-0000-4000-8000-000000000002'], req()]), (e: unknown) => code(e) === '23514');
    assert.equal((await runs(owner)).length, 0);
    // A list with only reader-1: reader-1 starts, book-21 (eligible but not listed) does not.
    const started = await repository.startV2(identity, { commandId: randomUUID(), versionId: D.version, campaign: CAMPAIGN, recipients: [READER1], requestId: req() });
    assert.equal(started!.changed, 1);
    let all = await runs(owner);
    assert.deepEqual(all.map(r => [r.prospect, r.audience, r.state]), [[READER1, 'book_readers', 'active']]); assert.ok(all[0]!.book_signup_id);
    // Stopped once, never entered again (by any route).
    await commands.query('SELECT app_private.mhp_sequence_command($1,$2,$3,$4,$5,$6,NULL,$7)', [tokenHash, 'stop', randomUUID(), D.version, CAMPAIGN, all[0]!.id, req()]);
    const after = (await repository.eligible(identity, D.version, CAMPAIGN))!;
    assert.deepEqual(after.eligible.map(p => p.prospectId), [book(21)]);
    assert.deepEqual(after.alreadyIn.map(p => [p.email, p.state]), [['reader-1@example.invalid', 'stopped']]);
    await assert.rejects(repository.startV2(identity, { commandId: randomUUID(), versionId: D.version, campaign: CAMPAIGN, recipients: [READER1], requestId: req() }), (e: unknown) => e instanceof MhpCommerceError && e.status === 409);

    // 3. The database refuses unconfirmed or wrong-audience starts, and resumes of a sequence without an audience.
    await assert.rejects(commands.query('SELECT app_private.mhp_sequence_command($1,$2,$3,$4,$5,NULL,NULL,$6)', [tokenHash, 'enrol', randomUUID(), A.version, CAMPAIGN, req()]), (e: unknown) => code(e) === '23514');
    for (const s of [B, C]) await assert.rejects(commands.query('SELECT app_private.mhp_sequence_start_v2($1,$2,$3,$4,$5::uuid[],$6)', [tokenHash, randomUUID(), s.version, CAMPAIGN, ['5afe5000-0000-4000-8000-000000000002'], req()]), (e: unknown) => code(e) === '23514');
    // Webinar A still starts through the explicit list, and only the listed people.
    const webinar = (await repository.eligible(identity, A.version, CAMPAIGN))!;
    assert.equal(webinar.audience, 'webinar_signups'); assert.equal(webinar.eligible.length, 6);
    assert.equal((await repository.startV2(identity, { commandId: randomUUID(), versionId: A.version, campaign: CAMPAIGN, recipients: webinar.eligible.slice(0, 2).map(p => p.prospectId), requestId: req() }))!.changed, 2);
    assert.equal((await runs(owner)).filter(r => r.item === A.item).length, 2);
    // Webinar automatic entry is refused for a book sequence; the book switch is refused for a webinar sequence.
    await assert.rejects(commands.query('SELECT app_private.mhp_sequence_entry_command($1,$2,$3,$4,$5,NULL,$6,$7)', [tokenHash, 'activate', randomUUID(), D.version, CAMPAIGN, new Date(Date.now() + 86_400_000), req()]), (e: unknown) => code(e) === '23514');
    await assert.rejects(repository.bookEntry(identity, { action: 'on', versionId: A.version, campaign: CAMPAIGN, switchId: '' }), (e: unknown) => e instanceof MhpCommerceError && e.status === 409);
    // Legacy B: put someone in it the old way is no longer possible; resume of a legacy run is refused (fixture: pause one of A's then resume through B would mismatch).

    // 4. Automatic entry only after the switch moment.
    await ownerQuery(owner, `INSERT INTO app_private.mhp_prospects(id,email,first_name,marketing_consent,consent_version,consent_at) VALUES('${book(29)}','book-29@example.invalid','Book 29',true,'book-v1',clock_timestamp());
      INSERT INTO app_private.mhp_prospect_signups(prospect_id,kind,label,module,link,consent_given,consent_version,created_at) VALUES('${book(29)}','waitlist','Before You Buy — book interest','book-before-you-buy','https://martinhowardproperty.co.uk/book/',true,'book-v1',clock_timestamp()-interval '1 second')`);
    const on = (await repository.bookEntry(identity, { action: 'on', versionId: D.version, campaign: CAMPAIGN, switchId: '' }))!;
    assert.equal(on.state, 'on');
    await ownerQuery(owner, `INSERT INTO app_private.mhp_prospects(id,email,first_name,marketing_consent,consent_version,consent_at) VALUES('${book(28)}','book-28@example.invalid','Book 28',true,'book-v1',clock_timestamp());
      INSERT INTO app_private.mhp_prospect_signups(prospect_id,kind,label,module,link,consent_given,consent_version) VALUES('${book(28)}','waitlist','Before You Buy — book interest','book-before-you-buy','https://martinhowardproperty.co.uk/book/',true,'book-v1');
      INSERT INTO app_private.mhp_prospect_signups(prospect_id,kind,label,module,link,consent_given,consent_version) VALUES('${READER1}','waitlist','Before You Buy — book interest','book-before-you-buy','https://martinhowardproperty.co.uk/book/',true,'book-v1');
      INSERT INTO app_private.mhp_prospect_signups(prospect_id,kind,label,module,link,consent_given,consent_version) VALUES('5afe5000-0000-4000-8000-000000000002','webinar','Before You Buy live webinar',NULL,'https://martinhowardproperty.co.uk/webinar/',true,'v1')`);
    const dispatch = new PgMhpSequenceDispatch(commands);
    const sweep = (await dispatch.bookSweep(100))!;
    assert.deepEqual({ enrolled: sweep.enrolled, skipped: sweep.skipped }, { enrolled: 1, skipped: 1 });
    all = await runs(owner);
    assert.ok(all.some(r => r.prospect === book(28) && r.item === D.item && r.state === 'active'), 'the new book sign-up is entered');
    assert.ok(!all.some(r => r.prospect === book(29)), 'a sign-up from before the switch is not swept in');
    assert.equal(all.filter(r => r.prospect === READER1 && r.item === D.item).length, 1, 'the stopped person is never entered again');
    assert.ok(!all.some(r => r.prospect === '5afe5000-0000-4000-8000-000000000002' && r.item === D.item), 'a webinar sign-up is never a book reader');
    assert.equal((await dispatch.bookSweep(100))!.processed, 0, 'each sign-up is looked at once');
    const switches = (await repository.bookSwitches(identity))!;
    assert.deepEqual(switches.map(sw => [sw.state, sw.enrolled, sw.skipped]), [['on', 1, 1]]);

    // 5. Stop when they buy: book-28 buys, the next sweep stops their run with 'purchased' before any claim.
    await ownerQuery(owner, `INSERT INTO app.purchases(organization_id,product_id,stripe_account_id,stripe_session_id,stripe_customer_id,buyer_email,livemode,status,first_paid_at,last_snapshot_at)
      SELECT 'ba41b1a4-9752-4dbf-8312-d04a0f03d0b8',id,'acct_test1','cs_test_book28','cus_test28','book-28@example.invalid',false,'paid',clock_timestamp(),clock_timestamp() FROM app.products WHERE sku='mhp_kit_book_test'`);
    assert.equal((await dispatch.bookSweep(100))!.stoppedPurchased, 1);
    all = await runs(owner);
    assert.deepEqual(all.filter(r => r.prospect === book(28)).map(r => [r.state, r.reason]), [['stopped', 'purchased']]);

    // 6. Start book-21 through the service (the named confirmation path), then the worker claim leases exactly the right people.
    const reviewOf = async (versionId: string): Promise<CompanyContentExactReview> => {
      const local = (await repository.local(identity, versionId, null))!;
      return { contentItemId: local.contentItemId, contentVersionId: local.contentVersionId, versionNumber: 1, isLatest: true, origin: 'imported', kind: 'other', title: local.title,
        contentMimeType: FOLLOWUP_SEQUENCE_MIME, canonicalContent: local.canonicalContent, canonicalByteLength: Buffer.byteLength(local.canonicalContent), contentSha256: local.contentSha256,
        source: { system: 'mhp.followup-sequence', itemId: local.sourceItemId, version: local.sourceVersion }, blobSha256: local.blobSha256, brandSha256: local.brandSha256,
        approvalRequestId: null, approvalDecisionId: null, approvalStatus: 'approved', approvalStale: false, email: null, createdAt: new Date().toISOString() } as CompanyContentExactReview;
    };
    const emailSha = (await ownerQuery<{ sha: string }>(owner, "SELECT encode(content_sha256,'hex') AS sha FROM app.company_content_versions WHERE id='5afe4000-0000-4000-8000-000000000011'"))[0]!.sha;
    const service = new MhpSequenceService({
      marketingWorkspace: { snapshot: async given => ({ userId: given.userId, selectedWorkspaceId: WS, personalWorkspaceId: OWNER, marketingWorkspaceId: WS, marketingSelected: true }) },
      repository, reader: { listCatalog: async () => ({ items: [], nextCursor: null }), getExactReview: async (_c, input) => reviewOf(input.contentVersionId) },
      adapter: {} as never, approvals: {} as never, adapterTransactions: {} as never, campaign: CAMPAIGN,
      emails: { snapshot: async () => { throw new Error('unused'); },
        review: async () => ({ review: { isLatest: true, approvalStatus: 'approved', approvalStale: false, contentSha256: emailSha, email: { subject: 'Your first chapter' } }, local: { valid: true } }) as never,
        get status() { return { mode: 'live', providerReady: true, testRecipientCount: 0, testEnabled: false } as never; } },
    });
    const plan = await service.startPlan(identity, req(), D.item, D.version);
    assert.equal(plan.ready, true, plan.refusal?.message); assert.equal(plan.explicit, true);
    // A manual start may include people who signed up before the switch (book-29); only the switch never sweeps them in.
    assert.deepEqual(plan.recipients.map(p => p.email), ['book-21@example.invalid', 'book-29@example.invalid']);
    assert.deepEqual(plan.alreadyInPeople?.map(p => [p.email, p.state]).sort(), [['book-28@example.invalid', 'stopped'], ['reader-1@example.invalid', 'stopped']]);
    const startedPlan = await service.start(identity, req(), { commandId: randomUUID(), itemId: D.item, versionId: D.version, count: plan.count, digest: plan.digest, people: '', confirmed: true });
    assert.equal(startedPlan.kind, 'started'); assert.equal(startedPlan.kind === 'started' && startedPlan.started, 2);
    await commands.query('SELECT app_private.mhp_sequence_claim_v2(25,120,NULL)');
    const leased = await ownerQuery<{ prospect: string; item: string }>(owner, `SELECT r.prospect_id AS prospect,r.sequence_item_id AS item FROM app_private.mhp_marketing_sends s
      JOIN app_private.mhp_followup_runs r ON r.id=s.sequence_run_id WHERE s.lease_until IS NOT NULL ORDER BY 1`);
    const activeNow = (await runs(owner)).filter(r => r.state === 'active').map(r => r.prospect).sort();
    assert.deepEqual(leased.map(l => l.prospect).sort(), activeNow, 'the claim leases exactly the active people');
    assert.ok(leased.some(l => l.prospect === book(21) && l.item === D.item));
    for (const n of [22, 23, 24, 25, 28]) assert.ok(!leased.some(l => l.prospect === book(n)), `book-${n} is never leased`);
    // The book run's send carries the book sign-up's label and link, and passes the send check.
    const lease = (await ownerQuery<{ id: string; lease: string }>(owner, `SELECT s.id,s.owner_lease_id AS lease FROM app_private.mhp_marketing_sends s
      JOIN app_private.mhp_followup_runs r ON r.id=s.sequence_run_id WHERE r.prospect_id='${book(21)}' AND r.sequence_item_id='${D.item}'`))[0]!;
    const prepared = await commands.query<{ value: { context: { label: string; link: string } } | null }>('SELECT app_private.mhp_sequence_prepare_v2($1,$2) AS value', [lease.id, lease.lease]);
    assert.deepEqual(prepared.rows[0]!.value!.context, { label: 'Before You Buy — book interest', link: 'https://martinhowardproperty.co.uk/book/' });

    // 7. Resume by explicit run ids: refused for a person held for a newer version; works for a paused book reader.
    const bookRun = (await runs(owner)).find(r => r.prospect === book(21))!;
    await commands.query('SELECT app_private.mhp_sequence_command($1,$2,$3,$4,$5,$6,NULL,$7)', [tokenHash, 'pause', randomUUID(), D.version, CAMPAIGN, bookRun.id, req()]);
    const resumed = await repository.resumeV2(identity, { commandId: randomUUID(), versionId: D.version, campaign: CAMPAIGN, runIds: [bookRun.id], requestId: req() });
    // The claim above already leased and prepared their email, so the database counts them as needing a check rather than resuming blindly.
    assert.equal(resumed!.changed + resumed!.blocked, 1);
    await ownerQuery(owner, `UPDATE app_private.mhp_followup_runs SET state='held',reason='newer_sequence' WHERE id='${bookRun.id}'`);
    await assert.rejects(repository.resumeV2(identity, { commandId: randomUUID(), versionId: D.version, campaign: CAMPAIGN, runIds: [bookRun.id], requestId: req() }), (e: unknown) => e instanceof MhpCommerceError && e.status === 409);
    // The run's audience can never be rewritten.
    await assert.rejects(ownerQuery(owner, `UPDATE app_private.mhp_followup_runs SET audience='webinar_signups',book_signup_id=NULL WHERE id='${bookRun.id}'`), (e: unknown) => code(e) === '23514');

    // 8. Old 0128 entry points keep their names and signatures on the migrated database.
    for (const f of ['app_private.mhp_sequence_snapshot(bytea,text)', 'app_private.mhp_sequence_claim_v2(integer,integer,text[])', 'app_private.mhp_sequence_prepare_v2(uuid,uuid)',
      'app_private.mhp_sequence_enrol_captures(integer)', 'app_private.mhp_sequence_command(bytea,text,uuid,uuid,text,uuid,uuid,text)', 'app_private.mhp_sequence_local_version(bytea,uuid,text)'])
      assert.ok((await ownerQuery<{ ok: boolean }>(owner, `SELECT to_regprocedure('${f}') IS NOT NULL AS ok`))[0]!.ok, f);
    assert.equal((await repository.snapshot(identity, CAMPAIGN)).campaign, CAMPAIGN);
    await commands.query('SELECT app_private.mhp_sequence_enrol_captures(10)');

    // 9. Turning the switch off: later sign-ups are not added.
    await repository.bookEntry(identity, { action: 'off', versionId: D.version, campaign: CAMPAIGN, switchId: on.switchId });
    await ownerQuery(owner, `INSERT INTO app_private.mhp_prospects(id,email,first_name,marketing_consent,consent_version,consent_at) VALUES('${book(30)}','book-30@example.invalid','Book 30',true,'book-v1',clock_timestamp());
      INSERT INTO app_private.mhp_prospect_signups(prospect_id,kind,label,module,link,consent_given,consent_version) VALUES('${book(30)}','waitlist','Before You Buy — book interest','book-before-you-buy','https://martinhowardproperty.co.uk/book/',true,'book-v1')`);
    assert.equal((await dispatch.bookSweep(100))!.enrolled, 0);
    assert.ok(!(await runs(owner)).some(r => r.prospect === book(30)));
  } finally {
    const client = await owner.connect();
    try { for (const role of ROLES) await client.query(`ALTER ROLE ${role} PASSWORD NULL`); } finally { client.release(); }
    await Promise.allSettled(Object.values(pools).map(pool => pool!.end()));
    await owner.end();
  }
});

test('new code on a database still at 0159 degrades clearly', { skip, timeout: 420_000 }, async () => {
  // The 0160 functions are what the new code looks for. Hide exactly those (as at 0159) on the disposable database,
  // check the new code's behaviour, then put them back. A second migrated database on the same cluster is not supported
  // by the role-hardening migrations, so the 0159 shape is reproduced by absence, which is what the code detects.
  const owner = await openTestDatabase();
  const hidden = ['mhp_sequence_eligible(bytea,uuid,text)', 'mhp_sequence_start_v2(bytea,uuid,uuid,text,uuid[],text)', 'mhp_sequence_resume_v2(bytea,uuid,uuid,text,uuid[],text)',
    'mhp_book_entry_command(bytea,text,uuid,text,uuid)', 'mhp_book_entry_read(bytea)', 'mhp_book_sequence_sweep(integer)'];
  const rename = async (to: 'hide' | 'show') => {
    const client = await owner.connect();
    try {
      await client.query('BEGIN'); await client.query('SET LOCAL ROLE r72_owner'); await client.query('GRANT CREATE ON SCHEMA app_private TO r72_mhp_prospect_definer');
      await client.query('SET LOCAL ROLE r72_mhp_prospect_definer');
      for (const f of hidden) {
        const name = f.slice(0, f.indexOf('('));
        if (to === 'hide') await client.query(`ALTER FUNCTION app_private.${f} RENAME TO ${name}_hidden_0159`);
        else await client.query(`ALTER FUNCTION app_private.${name}_hidden_0159${f.slice(f.indexOf('('))} RENAME TO ${name}`);
      }
      await client.query('RESET ROLE'); await client.query('SET LOCAL ROLE r72_owner'); await client.query('REVOKE CREATE ON SCHEMA app_private FROM r72_mhp_prospect_definer');
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  };
  let pools: Partial<Record<typeof ROLES[number], Pool>> = {};
  await rename('hide');
  try {
    pools = await loginPools(owner);
    const repository = new PgMhpSequenceRepository(pools.r72_web!, pools.r72_identity_command!);
    assert.equal(await repository.eligible(identity, D.version, CAMPAIGN), null);
    assert.equal(await repository.startV2(identity, { commandId: randomUUID(), versionId: D.version, campaign: CAMPAIGN, recipients: [book(21)], requestId: 'b159' }), null);
    assert.equal(await repository.resumeV2(identity, { commandId: randomUUID(), versionId: D.version, campaign: CAMPAIGN, runIds: [randomUUID()], requestId: 'b159' }), null);
    assert.equal(await repository.bookSwitches(identity), null);
    assert.equal(await repository.bookEntry(identity, { action: 'on', versionId: D.version, campaign: CAMPAIGN, switchId: '' }), null);
    assert.equal(await new PgMhpSequenceDispatch(pools.r72_identity_command!).bookSweep(10), null);
    assert.ok(BOOK_READERS_DATABASE_STEP.startsWith('This will be ready after one database step'));
  } finally {
    await rename('show');
    const client = await owner.connect();
    try { for (const role of ROLES) await client.query(`ALTER ROLE ${role} PASSWORD NULL`); } finally { client.release(); }
    await Promise.allSettled(Object.values(pools).map(pool => pool!.end()));
    await owner.end();
  }
});
