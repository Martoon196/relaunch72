import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { Pool } from 'pg';
import { requestDatabaseContext } from '../../src/db/rls.js';
import { PgFinanceRepository } from '../../src/portal/finance-drafts-pg-service.js';
import type { SignedReview } from '../../src/portal/finance-drafts-service.js';
import { packet, parsePlanning, validateIllustration, type Planning } from '../../src/integrations/mh196/planning-client.js';
import { expectPostgresError, openTestDatabase, ownerQuery, resetIdentityTables, scopedQuery, testDatabaseSkipReason, withOwnerClient } from './database-helper.js';

/** This file is opt-in and uses the existing disposable DB lease/name/role guards. */
test('0106 isolated migration, finance RLS, source/session fencing and immutable concurrency', { skip: testDatabaseSkipReason() }, async t => {
  const pool = await openTestDatabase();
  try {
    await resetIdentityTables(pool);
    const org = randomUUID(), workspace = randomUUID(), otherWorkspace = randomUUID(), user = randomUUID(), viewer = randomUUID(), contact = randomUUID(), otherContact = randomUUID(), pipeline = randomUUID(), stage = randomUUID(), opportunity = randomUUID();
    const tokenHash = createHash('sha256').update('synthetic-finance-session').digest();
    await withOwnerClient(pool, async tx => {
      await tx.query(`INSERT INTO app.organizations(id,name,slug,kind) VALUES ($1,'Finance test','finance-test','agency')`, [org]);
      await tx.query(`INSERT INTO app.users(id,email,status,email_verified_at) VALUES ($1,'finance@example.test','active',clock_timestamp()),($2,'viewer@example.test','active',clock_timestamp())`, [user, viewer]);
      await tx.query(`INSERT INTO app.workspaces(id,organization_id,name,slug) VALUES ($1,$3,'Finance A','finance-a'),($2,$3,'Finance B','finance-b')`, [workspace, otherWorkspace, org]);
      await tx.query(`INSERT INTO app.workspace_memberships(workspace_id,organization_id,user_id,role,status,granted_at) VALUES ($1,$4,$3,'owner','active',statement_timestamp()-interval '1 minute'),($2,$4,$3,'owner','active',statement_timestamp()-interval '1 minute'),($1,$4,$5,'viewer','active',statement_timestamp()-interval '1 minute')`, [workspace, otherWorkspace, user, org, viewer]);
      await tx.query(`INSERT INTO app.contacts(id,workspace_id,display_name) VALUES ($1,$3,'Synthetic A'),($2,$4,'Synthetic B')`, [contact, otherContact, workspace, otherWorkspace]);
      await tx.query(`INSERT INTO app.pipelines(id,workspace_id,name,slug,is_default) VALUES ($1,$2,'Finance','finance',true)`, [pipeline, workspace]);
      await tx.query(`INSERT INTO app.pipeline_stages(id,workspace_id,pipeline_id,name,slug,position,stage_type,is_terminal) VALUES ($1,$2,$3,'Open','open',1,'open',false)`, [stage, workspace, pipeline]);
      await tx.query(`INSERT INTO app.opportunities(id,workspace_id,contact_id,pipeline_id,stage_id,name) VALUES ($1,$2,$3,$4,$5,'Synthetic deal')`, [opportunity, workspace, contact, pipeline, stage]);
      await tx.query(`INSERT INTO app.user_sessions(token_hash,csrf_secret_hash,user_id,selected_workspace_id,expires_at) VALUES ($1,$1,$2,$3,clock_timestamp()+interval '1 hour')`, [tokenHash, user, workspace]);
    });
    // Each test connection is discarded, so SET ROLE cannot leak to another test.
    const rolePool = (role: 'r72_web' | 'r72_crm_command'): Pick<Pool, 'connect'> => ({ async connect() { const client = await pool.connect(); try { await client.query(`SET ROLE ${role}`); } catch (error) { client.release(true); throw error; } const release = client.release.bind(client); client.release = () => release(true); return client; } }) as Pick<Pool, 'connect'>;
    const repository = new PgFinanceRepository(rolePool('r72_web'), rolePool('r72_crm_command'));
    const context = requestDatabaseContext({ userId: user, workspaceId: workspace, requestId: 'finance-isolation', portalSessionTokenHash: tokenHash });
    const data = JSON.parse(readFileSync(new URL('../fixtures/mh196-public-numeric.json', import.meta.url), 'utf8')) as { models: { model: string; request: { planning: Planning }; assumptions_as_of: string; response: unknown }[] };
    const sample = data.models.find(item => item.model === 'bridging_refurb')!, planning = parsePlanning(sample.request.planning); planning.inputs.borrower_broker_fee = '0';
    const review: SignedReview = { opportunityId: opportunity, workspaceId: workspace, contactId: contact, opportunityVersion: 1, expectedLatestVersion: 0, nonce: randomUUID(), packet: packet(planning, sample.assumptions_as_of), illustration: validateIllustration(sample.response, planning, sample.assumptions_as_of), calculatedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: Date.now() + 60000 };
    await t.test('read-only preparation and workspace isolation', async () => {
      assert.equal((await repository.snapshot(context, opportunity))!.source.latestVersion, 0);
      assert.equal(await repository.snapshot(requestDatabaseContext({ userId: user, workspaceId: otherWorkspace, requestId: 'other' }), opportunity), null);
      const viewerSnapshot = await repository.snapshot(requestDatabaseContext({ userId: viewer, workspaceId: workspace, requestId: 'viewer' }), opportunity);
      assert.equal(viewerSnapshot!.source.canWrite, false); assert.deepEqual(viewerSnapshot!.versions, []);
    });
    let winner = review;
    await t.test('concurrent reviewed saves append once; exact retry replays', async () => {
      const second = { ...review, nonce: randomUUID() };
      const results = await Promise.allSettled([repository.save(context, review), repository.save(context, second)]);
      const rejectionDiagnostics = results.filter(result => result.status === 'rejected').map(result => {
        const reason = (result as PromiseRejectedResult).reason as { code?: unknown; message?: unknown } | null;
        return { code: typeof reason?.code === 'string' ? reason.code.slice(0, 40) : null,
          message: typeof reason?.message === 'string' ? reason.message.replace(/postgres(?:ql)?:\/\/\S+/gi, '[database URL redacted]').slice(0, 500) : 'No error message' };
      });
      assert.equal(results.filter(r => r.status === 'fulfilled').length, 1, JSON.stringify(rejectionDiagnostics));
      assert.equal(results.filter(r => r.status === 'rejected').length, 1);
      winner = results[0]!.status === 'fulfilled' ? review : second;
      assert.equal((await repository.save(context, winner)).version, 1);
      assert.equal((await repository.snapshot(context, opportunity))!.versions.length, 1);
    });
    await t.test('viewer, wrong contact and immutable row grants fail closed', async () => {
      await assert.rejects(repository.save(requestDatabaseContext({ userId: viewer, workspaceId: workspace, requestId: 'viewer' }), { ...review, nonce: randomUUID(), expectedLatestVersion: 1 }));
      await assert.rejects(repository.save(context, { ...review, nonce: randomUUID(), contactId: otherContact, expectedLatestVersion: 1 }));
      await expectPostgresError(scopedQuery(pool, 'r72_crm_command', { workspaceId: workspace, userId: user }, 'UPDATE app.finance_planning_drafts SET version=10'), '42501');
      await expectPostgresError(scopedQuery(pool, 'r72_web', { workspaceId: workspace, userId: user }, `INSERT INTO app.finance_planning_drafts SELECT * FROM app.finance_planning_drafts`), '42501');
      const foreign = [workspace, opportunity, otherContact, user, randomUUID(), Buffer.alloc(32), JSON.stringify(review.packet), JSON.stringify(review.illustration), review.calculatedAt];
      await expectPostgresError(ownerQuery(pool, `INSERT INTO app.finance_planning_drafts(workspace_id,opportunity_id,contact_id,version,opportunity_version,creator_user_id,review_nonce,review_hash,packet,illustration,calculated_at) VALUES($1,$2,$3,2,1,$4,$5,$6,$7::jsonb,$8::jsonb,$9)`, foreign), '23503');
    });
    await t.test('changed opportunity and revoked session reject saves', async () => {
      await ownerQuery(pool, 'UPDATE app.opportunities SET row_version=row_version+1 WHERE id=$1', [opportunity]);
      await assert.rejects(repository.save(context, { ...review, nonce: randomUUID(), expectedLatestVersion: 1 }));
      await ownerQuery(pool, 'UPDATE app.user_sessions SET revoked_at=clock_timestamp() WHERE token_hash=$1', [tokenHash]);
      await assert.rejects(repository.save(context, { ...review, nonce: randomUUID(), opportunityVersion: 2, expectedLatestVersion: 1 }));
    });
    await t.test('added finance rows follow existing parent deletion; no migration rewrite', async () => {
      await ownerQuery(pool, 'DELETE FROM app.opportunities WHERE id=$1', [opportunity]);
      const count = await ownerQuery<{ count: string }>(pool, 'SELECT count(*) FROM app.finance_planning_drafts'); assert.equal(count[0]!.count, '0');
      const migrations = await pool.query<{ filename: string }>("SELECT filename FROM app_private.schema_migrations WHERE filename = '0106_finance_planning_drafts.sql'"); assert.equal(migrations.rows.length, 1);
      const registered = await ownerQuery(pool, "SELECT table_name FROM app_private.workspace_table_registry WHERE schema_name='app' AND table_name='finance_planning_drafts' AND workspace_column='workspace_id'"); assert.equal(registered.length, 1);
    });
  } finally { await pool.end(); }
});
