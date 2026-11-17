import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Pool } from 'pg';
import { openTestDatabase, ownerQuery, resetIdentityTables, testDatabaseSkipReason } from './database-helper.js';
import { MhpSequenceService, PgMhpSequenceRepository } from '../../src/mhp/followup-sequence-service.js';
import { MhpCommerceError } from '../../src/mhp/commerce-service.js';
import { FOLLOWUP_NO_AUDIENCE_LINE } from '../../src/followup-sequences/audience.js';
import { FOLLOWUP_SEQUENCE_MIME } from '../../src/followup-sequences/definition.js';
import type { CompanyContentExactReview } from '../../src/company-content-pg/index.js';

// The sequence safety release against the real app_private.mhp_sequence_command, snapshot,
// local-version and webinar-candidate functions, through the real repository, as the real
// login roles (r72_web reads, r72_identity_command commands). Nothing here sends: runs are
// created and paused, but no claim/prepare/dispatch function is called.
const skip = testDatabaseSkipReason();
const WS = '2789228d-55a6-4688-b1e8-2f70abca990b', OWNER = '5afe4000-0000-4000-8000-000000000001', CAMPAIGN = 'webinar-2026-11-03';
const TOKEN = 'mhpSequenceSafetyOwnerSessionToken000000001';
const A = { item: '5afe4000-0000-4000-8000-0000000000a1', version: '5afe4000-0000-4000-8000-0000000000a2' };
const B = { item: '5afe4000-0000-4000-8000-0000000000b1', version: '5afe4000-0000-4000-8000-0000000000b2' };
const C = { item: '5afe4000-0000-4000-8000-0000000000c1', version: '5afe4000-0000-4000-8000-0000000000c2' };
const identity = { sessionToken: TOKEN, userId: OWNER, workspaceId: WS, userEmail: 'martin.howard1984@gmail.com' } as const;
const ROLES = ['r72_web', 'r72_identity_command'] as const;

async function loginPools(owner: Pool): Promise<Record<typeof ROLES[number], Pool>> {
  const raw = process.env.TEST_DATABASE_URL!.trim(), pools = {} as Record<typeof ROLES[number], Pool>, client = await owner.connect();
  try {
    for (const role of ROLES) {
      const password = `seq-safety-${randomUUID()}`;
      const statement = await client.query<{ sql: string }>(`SELECT pg_catalog.format('ALTER ROLE %I PASSWORD %L', $1::text, $2::text) AS sql`, [role, password]);
      await client.query(statement.rows[0]!.sql);
      const url = new URL(raw); url.username = role; url.password = password;
      pools[role] = new Pool({ connectionString: url.toString(), max: 2, application_name: `relaunch72-disposable-${role}-seq-safety` });
    }
  } finally { client.release(); }
  return pools;
}
async function runs(owner: Pool) {
  return ownerQuery<{ id: string; sequence_item_id: string; sequence_version_id: string; state: string; email: string }>(owner,
    `SELECT r.id,r.sequence_item_id,r.sequence_version_id,r.state,p.email::text AS email FROM app_private.mhp_followup_runs r JOIN app_private.mhp_prospects p ON p.id=r.prospect_id ORDER BY p.email`);
}

test('sequence safety against the real MHP sequence functions', { skip, timeout: 420_000 }, async () => {
  const owner = await openTestDatabase();
  let pools: Partial<Record<typeof ROLES[number], Pool>> = {};
  try {
    await ownerQuery(owner, 'TRUNCATE app_private.mhp_followup_runs, app_private.mhp_marketing_sends, app_private.mhp_prospect_signups, app_private.mhp_prospects CASCADE').catch(() => undefined);
    await resetIdentityTables(owner);
    const fixture = await readFile(new URL('./mhp-sequence-safety.fixture.sql', import.meta.url), 'utf8');
    const client = await owner.connect();
    try { await client.query('BEGIN'); await client.query('SET LOCAL ROLE r72_owner'); await client.query("SELECT set_config('seq.token',$1,true)", [TOKEN]); await client.query(fixture); await client.query('COMMIT'); }
    catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    pools = await loginPools(owner);
    const repository = new PgMhpSequenceRepository(pools.r72_web!, pools.r72_identity_command!);

    // The audience key this release stores is tolerated by the database's exact validator: every version is valid.
    for (const s of [A, B, C]) {
      const local = await repository.local(identity, s.version, null);
      assert.equal(local?.valid, true, `version ${s.version} must stay valid`); assert.ok(local?.exact);
    }
    assert.deepEqual((await repository.local(identity, A.version, null))!.metadata.mhpSequence && ((await repository.local(identity, A.version, null))!.metadata.mhpSequence as { audience: unknown }).audience,
      { schema: 'mhp.followup-sequence-audience/v1', kind: 'webinar_signups', campaign: CAMPAIGN });

    // The candidate reader agrees exactly with the database's enrol audience.
    const page = await repository.audienceCandidates(identity, CAMPAIGN, null);
    assert.equal(page.candidates.length, 8); assert.equal(page.hasMore, false);
    const database = await repository.snapshot(identity, CAMPAIGN);
    assert.equal(database.eligible, 6); assert.equal(page.candidates.filter(c => c.marketingConsent && !c.unsubscribed && c.signupConsentGiven).length, database.eligible);

    // The real service over the real repository; only content review and email status are stubbed.
    const reviewOf = async (versionId: string): Promise<CompanyContentExactReview> => {
      const local = (await repository.local(identity, versionId, null))!;
      return { contentItemId: local.contentItemId, contentVersionId: local.contentVersionId, versionNumber: 1, isLatest: true, origin: 'imported', kind: 'other', title: local.title,
        contentMimeType: FOLLOWUP_SEQUENCE_MIME, canonicalContent: local.canonicalContent, canonicalByteLength: Buffer.byteLength(local.canonicalContent), contentSha256: local.contentSha256,
        source: { system: 'mhp.followup-sequence', itemId: local.sourceItemId, version: local.sourceVersion }, blobSha256: local.blobSha256, brandSha256: local.brandSha256,
        approvalRequestId: null, approvalDecisionId: null, approvalStatus: 'approved', approvalStale: false, email: null, createdAt: new Date().toISOString() } as CompanyContentExactReview;
    };
    const service = new MhpSequenceService({
      marketingWorkspace: { snapshot: async given => ({ userId: given.userId, selectedWorkspaceId: WS, personalWorkspaceId: OWNER, marketingWorkspaceId: WS, marketingSelected: true }) },
      repository, reader: { listCatalog: async () => ({ items: [], nextCursor: null }), getExactReview: async (_c, input) => reviewOf(input.contentVersionId) },
      adapter: {} as never, approvals: {} as never, adapterTransactions: {} as never, campaign: CAMPAIGN,
      emails: { snapshot: async () => { throw new Error('unused'); }, review: async () => ({ review: { isLatest: true, approvalStatus: 'approved', approvalStale: false, contentSha256: '', email: { subject: 'Your replay is ready' } }, local: { valid: true } }) as never,
        get status() { return { mode: 'live', providerReady: true, testRecipientCount: 0, testEnabled: false } as never; } },
    });
    // The email review stub must match each step's digest for the sequence to be ready.
    const emailSha = (await ownerQuery<{ sha: string }>(owner, "SELECT encode(content_sha256,'hex') AS sha FROM app.company_content_versions WHERE id='5afe4000-0000-4000-8000-000000000011'"))[0]!.sha;
    (service as unknown as { dependencies: { emails: { review: unknown } } }).dependencies.emails.review = async () => ({ review: { isLatest: true, approvalStatus: 'approved', approvalStale: false, contentSha256: emailSha, email: { subject: 'Your replay is ready' } }, local: { valid: true } });

    // C ("none yet") and B (legacy, never used) cannot be started; nothing is created.
    for (const s of [C, B]) {
      const plan = await service.startPlan(identity, randomUUID(), s.item, s.version);
      assert.equal(plan.refusal?.code, 'no_audience'); assert.equal(plan.recipients.length, 0);
      await assert.rejects(service.start(identity, randomUUID(), { commandId: randomUUID(), itemId: s.item, versionId: s.version, count: 6, digest: 'a'.repeat(64), people: '', confirmed: true }),
        (error: unknown) => error instanceof MhpCommerceError && error.status === 409 && error.message === FOLLOWUP_NO_AUDIENCE_LINE);
    }
    assert.equal((await runs(owner)).length, 0);

    // A: the confirmation lists exactly who the real database then enrols.
    const plan = await service.startPlan(identity, randomUUID(), A.item, A.version);
    assert.equal(plan.ready, true, plan.refusal?.message); assert.equal(plan.count, 6); assert.equal(plan.webinar.label, 'Before You Buy live webinar');
    assert.deepEqual(plan.heldBack, { noConsent: 1, unsubscribed: 1, alreadyIn: 0, earlierVersion: 0 });
    // The audience changes between looking and pressing: nothing is started.
    await ownerQuery(owner, `UPDATE app_private.mhp_prospects SET unsubscribed_at=clock_timestamp() WHERE email='reader-6@example.invalid'`);
    const changed = await service.start(identity, randomUUID(), { commandId: randomUUID(), itemId: A.item, versionId: A.version, count: plan.count, digest: plan.digest,
      people: plan.recipients.map(p => p.prospectId.slice(-8)).join(''), confirmed: true });
    assert.equal(changed.kind, 'changed'); assert.equal(changed.kind === 'changed' && changed.removed.map(p => p.email).join(), 'reader-6@example.invalid');
    assert.equal((await runs(owner)).length, 0);
    const fresh = await service.startPlan(identity, randomUUID(), A.item, A.version); assert.equal(fresh.count, 5);
    const command = randomUUID();
    const started = await service.start(identity, randomUUID(), { commandId: command, itemId: A.item, versionId: A.version, count: fresh.count, digest: fresh.digest, people: '', confirmed: true });
    assert.equal(started.kind, 'started'); assert.equal(started.kind === 'started' && started.started, 5); assert.equal(started.kind === 'started' && started.unexpected, 0);
    assert.deepEqual((await runs(owner)).map(r => r.email), fresh.recipients.map(p => p.email).sort());
    // The same confirmation again is the earlier start, not a second one.
    const again = await service.start(identity, randomUUID(), { commandId: command, itemId: A.item, versionId: A.version, count: fresh.count, digest: fresh.digest,
      people: fresh.recipients.map(p => p.prospectId.slice(-8)).join(''), confirmed: true });
    assert.equal(again.kind, 'already_started'); assert.equal((await runs(owner)).length, 5);

    // B gets people directly through the database (as if started before this release), so pause-everyone has something to leave alone.
    await pools.r72_identity_command!.query('SELECT app_private.mhp_sequence_command($1,$2,$3,$4,$5,$6,$7,$8) AS value',
      [Buffer.from(await sha256(TOKEN)), 'enrol', randomUUID(), B.version, CAMPAIGN, null, null, 'seq-safety-legacy-b']);
    const afterB = await runs(owner); assert.equal(afterB.filter(r => r.sequence_item_id === B.item).length, 5);
    // B is now "used with the webinar": the legacy rule classifies it as webinar sign-ups.
    assert.equal((await service.startPlan(identity, randomUUID(), B.item, B.version)).audience.origin, 'legacy_runs');

    // Pause one person; a stale second press is reported as already paused.
    const first = afterB.find(r => r.sequence_item_id === A.item)!;
    const one = await service.personAction(identity, randomUUID(), { action: 'pause', commandId: randomUUID(), itemId: A.item, versionId: A.version, runId: first.id, ackProofId: '' });
    assert.equal(one.code, 'done'); assert.equal(one.after, 'paused');
    const stale = await service.personAction(identity, randomUUID(), { action: 'pause', commandId: randomUUID(), itemId: A.item, versionId: A.version, runId: first.id, ackProofId: '' });
    assert.equal(stale.code, 'already');

    // Pause everyone in A: every A person paused, every B person untouched.
    const paused = await service.pauseAll(identity, randomUUID(), { commandId: randomUUID(), itemId: A.item, versionId: A.version });
    assert.equal(paused.changed, 4); assert.equal(paused.remaining, 0);
    const now = await runs(owner);
    assert.ok(now.filter(r => r.sequence_item_id === A.item).every(r => r.state === 'paused'));
    assert.ok(now.filter(r => r.sequence_item_id === B.item).every(r => r.state === 'active'));

    // Resume everyone in A is bound to the exact list; then resumes only A.
    const resume = await service.resumePlan(identity, randomUUID(), A.item, A.version);
    assert.equal(resume.ready, true); assert.equal(resume.people.length, 5);
    const bad = await service.resumeAll(identity, randomUUID(), { commandId: randomUUID(), itemId: A.item, versionId: A.version, count: 4, digest: resume.digest });
    assert.equal('kind' in bad && bad.kind, 'changed');
    const resumed = await service.resumeAll(identity, randomUUID(), { commandId: randomUUID(), itemId: A.item, versionId: A.version, count: resume.people.length, digest: resume.digest });
    assert.equal('changed' in resumed && resumed.changed, 5);
    assert.ok((await runs(owner)).every(r => r.state === 'active'));
    // No send work was claimed or prepared by any of this.
    const sends = await ownerQuery<{ n: number }>(owner, 'SELECT count(*)::int AS n FROM app_private.mhp_marketing_sends WHERE sequence_run_id IS NOT NULL AND (sent_at IS NOT NULL OR lease_until IS NOT NULL)');
    assert.equal(sends[0]!.n, 0);
  } finally {
    const client = await owner.connect();
    try { for (const role of ROLES) await client.query(`ALTER ROLE ${role} PASSWORD NULL`); } finally { client.release(); }
    await Promise.allSettled(Object.values(pools).map(pool => pool!.end()));
    await owner.end();
  }
});
async function sha256(value: string): Promise<Buffer> { const { createHash } = await import('node:crypto'); return createHash('sha256').update(value).digest(); }
