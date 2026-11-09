// Explicit isolated-branch proof. Never part of routine CI; never resets data.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { CompanyContentService } from '../src/company-content-pg/service.ts';

const url = process.env.HQ_SOURCE_REFRESH_PROOF_URL;
assert.ok(url, 'Explicit isolated branch URL required');
assert.equal(new URL(url).hostname, 'ep-still-math-b2aod02s-pooler.c-6.eu-central-1.aws.neon.tech');
const pool = new pg.Pool({ connectionString: url, max: 1 });
const client = await pool.connect();
let passed = 0;
const pass = (name) => { passed++; console.log(`PASS ${name}`); };
try {
  await client.query('BEGIN');
  const { rows: [v] } = await client.query(`SELECT *, encode(content_sha256,'hex') AS content_hash,
    encode(blob_sha256,'hex') AS blob_hash, encode(brand_sha256,'hex') AS brand_hash
    FROM app.company_content_versions WHERE id='a366b6f7-398e-4c2c-981a-7fc3d4b97f46'`);
  assert.ok(v);
  const context = { actorKind: 'user', workspaceId: v.workspace_id, userId: v.created_by_user_id, requestId: 'source013-branch-proof' };
  const runner = (role) => ({ async run(ctx, operation) {
    assert.ok(['r72_content_adapter','r72_content_command','r72_web'].includes(role));
    await client.query('SAVEPOINT proof_operation');
    try {
      await client.query(`SET LOCAL ROLE ${role}`);
      await client.query(`SELECT set_config('app.workspace_id',$1,true),set_config('app.user_id',$2,true),
        set_config('app.request_id',$3,true),set_config('app.actor_kind','user',true)`, [ctx.workspaceId,ctx.userId,ctx.requestId]);
      const result = await operation(client);
      await client.query('RESET ROLE');
      await client.query('RELEASE SAVEPOINT proof_operation');
      return result;
    } catch (error) {
      await client.query('ROLLBACK TO SAVEPOINT proof_operation');
      await client.query('RELEASE SAVEPOINT proof_operation');
      await client.query('RESET ROLE');
      throw error;
    }
  }});
  const service = new CompanyContentService({ transactionRunner: runner('r72_content_adapter') });
  const before = await service.listVersionApprovalStates(context, v.content_item_id);
  assert.equal(before[0].approvalStatus, 'approved');
  pass('adapter reads exact approved version history');
  const counts = async () => (await client.query(`SELECT
    (SELECT count(*)::int FROM app.company_content_versions) AS versions,
    (SELECT count(*)::int FROM app.company_content_approval_decisions) AS approvals,
    (SELECT count(*)::int FROM app.company_content_source_attestations) AS attestations`)).rows[0];
  const originalCounts = await counts();
  const checkedAt = new Date();
  const command = { commandKey: randomUUID(), contentItemId: v.content_item_id, contentVersionId: v.id,
    expected: { source: { system:v.source_system,itemId:v.source_item_id,version:v.source_version },
      contentSha256:v.content_hash,blobSha256:v.blob_hash,brandSha256:v.brand_hash },
    attestation: { catalogSha256:'ab'.repeat(32), checkedAt:checkedAt.toISOString(), expiresAt:new Date(+checkedAt+600000).toISOString() } };
  const first = await service.refreshSourceAttestation(context, command);
  assert.equal(first.disposition,'applied'); assert.equal(first.providerEffects,false);
  pass('real service claims receipt, locks exact version, inserts attestation, completes receipt');
  const retry = await service.refreshSourceAttestation(context, command);
  assert.deepEqual(retry,{...first,disposition:'replayed'});
  pass('retry replays same attestation without duplicate write');
  await assert.rejects(service.refreshSourceAttestation(context,{...command,expected:{...command.expected,contentSha256:'cd'.repeat(32)}}), {name:'CompanyContentIdempotencyConflictError'});
  pass('changed payload cannot reuse receipt');
  await assert.rejects(service.refreshSourceAttestation(context,{...command,commandKey:randomUUID(),expected:{...command.expected,contentSha256:'cd'.repeat(32)}}), {name:'CompanyContentVersionConflictError'});
  pass('new receipt still rejects changed exact content');
  for (const role of ['r72_web','r72_content_command']) {
    const other = new CompanyContentService({transactionRunner:runner(role)});
    await assert.rejects(other.refreshSourceAttestation(context,{...command,commandKey:randomUUID()}), {code:'42501'});
    pass(`${role} cannot refresh`);
  }
  for (const changed of [{workspaceId:randomUUID()},{userId:randomUUID()}]) {
    await assert.rejects(service.refreshSourceAttestation({...context,...changed},{...command,commandKey:randomUUID()}), {code:'42501'});
    pass(`${Object.keys(changed)[0]} mismatch denied`);
  }
  await assert.rejects(runner('r72_content_adapter').run(context, tx=>tx.query('SELECT decision_note FROM app.company_content_approval_decisions LIMIT 1')), {code:'42501'});
  pass('private approval notes remain denied');
  await assert.rejects(service.requestApproval(context,{commandKey:randomUUID(),contentItemId:v.content_item_id,contentVersionId:v.id}), {code:'42501'});
  pass('adapter still cannot request approval');
  assert.deepEqual(await service.listVersionApprovalStates(context,v.content_item_id),before);
  assert.deepEqual(await counts(),{...originalCounts,attestations:originalCounts.attestations+1});
  pass('same saved post and approval; exactly one temporary proof added');
  console.log(JSON.stringify({passed,failed:0,skipped:0,branch:'br-muddy-king-b2dl02a4',transaction:'rolled back in finally',limits:'Uses SET LOCAL ROLE on isolated clone; no provider call or portal session recheck.'}));
} finally {
  await client.query('ROLLBACK');
  client.release();
  await pool.end();
}
