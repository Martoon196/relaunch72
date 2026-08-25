import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import type { Pool, QueryResultRow } from 'pg';
import {
  expectPostgresError,
  openTestDatabase,
  ownerQuery,
  resetIdentityTables,
  scopedQuery,
  testDatabaseSkipReason,
} from './database-helper.js';

const skip = testDatabaseSkipReason();

interface DispositionRow extends QueryResultRow {
  disposition: string;
  replayed: boolean;
}

interface SideEffectCountRow extends QueryResultRow {
  crm_contacts: number;
  crm_opportunities: number;
  journey_enrollments: number;
  journey_milestones: number;
  journey_commerce: number;
  consent_events: number;
  suppression_events: number;
  outbox_events: number;
}

interface ReceiptCountRow extends QueryResultRow {
  receipt_count: number;
}

interface CapabilityRow extends QueryResultRow {
  function_name: string;
}

interface RecorderSecurityRow extends QueryResultRow {
  role_is_hardened: boolean;
  recorder_owner: string;
  recorder_security_definer: boolean;
  recorder_config: string[] | null;
  command_has_any_table_privilege: boolean;
}

const recordSql = `
  SELECT disposition, replayed
  FROM app_private.record_external_event_shadow_receipt(
    $1::uuid, $2::text, $3::uuid, $4::text, $5::smallint,
    $6::timestamptz, $7::uuid, $8::text, $9::uuid, $10::bytea,
    $11::jsonb, $12::text, $13::timestamptz
  )`;

async function sideEffectCounts(pool: Pool): Promise<SideEffectCountRow> {
  const rows = await ownerQuery<SideEffectCountRow>(pool, `
    SELECT
      (SELECT count(*)::integer FROM app.contacts) AS crm_contacts,
      (SELECT count(*)::integer FROM app.opportunities) AS crm_opportunities,
      (SELECT count(*)::integer FROM app.conversion_enrollments) AS journey_enrollments,
      (SELECT count(*)::integer FROM app.conversion_milestone_facts) AS journey_milestones,
      (SELECT count(*)::integer FROM app.conversion_commerce_facts) AS journey_commerce,
      (SELECT count(*)::integer FROM app.communication_consent_events) AS consent_events,
      (SELECT count(*)::integer FROM app.communication_suppression_events) AS suppression_events,
      (SELECT count(*)::integer FROM app.outbox_events) AS outbox_events`);
  assert.equal(rows.length, 1);
  return rows[0]!;
}

test('live shadow receipt is idempotent, conflict-safe, protected, and side-effect free', { skip }, async () => {
  const pool = await openTestDatabase();
  try {
    await resetIdentityTables(pool);
    const organizationId = randomUUID();
    const workspaceId = randomUUID();
    const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
    await ownerQuery(pool, `
      INSERT INTO app.organizations (id, name, slug, kind)
      VALUES ($1, 'External event integration', $2, 'direct_customer')
    `, [organizationId, `external-event-${suffix}`]);
    await ownerQuery(pool, `
      INSERT INTO app.workspaces (id, organization_id, name, slug)
      VALUES ($1, $2, 'Property Predator', $3)`, [
      workspaceId,
      organizationId,
      `property-predator-${suffix}`,
    ]);

    const event = {
      id: randomUUID(),
      type: 'identity.account.created',
      version: 1,
      occurredAt: '2026-08-25T12:00:00.000Z',
      correlationId: randomUUID(),
      subject: { kind: 'account', id: randomUUID() },
      data: { email: 'integration@example.test', signupMethod: 'password' },
    };
    const rawBody = Buffer.from(JSON.stringify(event));
    const payloadSha256 = createHash('sha256').update(rawBody).digest();
    const values = [
      workspaceId,
      'property_predator',
      event.id,
      event.type,
      event.version,
      event.occurredAt,
      event.correlationId,
      event.subject.kind,
      event.subject.id,
      payloadSha256,
      JSON.stringify(event),
      'pp-integration-v1',
      '2026-08-25T12:00:01.000Z',
    ];
    const context = {
      workspaceId,
      requestId: `property-predator:${event.id}`,
    };
    const before = await sideEffectCounts(pool);

    const recorderSecurity = await ownerQuery<RecorderSecurityRow>(pool, `
      SELECT
        command_role.rolcanlogin
          AND NOT command_role.rolinherit
          AND NOT command_role.rolsuper
          AND NOT command_role.rolcreatedb
          AND NOT command_role.rolcreaterole
          AND NOT command_role.rolreplication
          AND NOT command_role.rolbypassrls
          AND NOT EXISTS (
            SELECT 1 FROM pg_catalog.pg_auth_members
            WHERE member = command_role.oid
          ) AS role_is_hardened,
        owner_role.rolname AS recorder_owner,
        recorder.prosecdef AS recorder_security_definer,
        recorder.proconfig AS recorder_config,
        EXISTS (
          SELECT 1
          FROM pg_catalog.pg_class AS relation
          JOIN pg_catalog.pg_namespace AS namespace
            ON namespace.oid = relation.relnamespace
          WHERE namespace.nspname IN ('app', 'app_private')
            AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
            AND (
              pg_catalog.has_table_privilege(command_role.oid, relation.oid, 'SELECT')
              OR pg_catalog.has_table_privilege(command_role.oid, relation.oid, 'INSERT')
              OR pg_catalog.has_table_privilege(command_role.oid, relation.oid, 'UPDATE')
              OR pg_catalog.has_table_privilege(command_role.oid, relation.oid, 'DELETE')
              OR pg_catalog.has_table_privilege(command_role.oid, relation.oid, 'TRUNCATE')
              OR pg_catalog.has_table_privilege(command_role.oid, relation.oid, 'REFERENCES')
              OR pg_catalog.has_table_privilege(command_role.oid, relation.oid, 'TRIGGER')
            )
        ) AS command_has_any_table_privilege
      FROM pg_catalog.pg_roles AS command_role
      CROSS JOIN pg_catalog.pg_proc AS recorder
      JOIN pg_catalog.pg_roles AS owner_role ON owner_role.oid = recorder.proowner
      WHERE command_role.rolname = 'r72_external_event_command'
        AND recorder.oid = pg_catalog.to_regprocedure(
          'app_private.record_external_event_shadow_receipt(uuid,text,uuid,text,smallint,timestamptz,uuid,text,uuid,bytea,jsonb,text,timestamptz)'
        )`);
    assert.deepEqual(recorderSecurity, [{
      role_is_hardened: true,
      recorder_owner: 'r72_external_event_definer',
      recorder_security_definer: true,
      recorder_config: ['search_path=pg_catalog'],
      command_has_any_table_privilege: false,
    }]);

    const executableFunctions = await ownerQuery<CapabilityRow>(pool, `
      SELECT procedure.proname AS function_name
      FROM pg_catalog.pg_proc AS procedure
      JOIN pg_catalog.pg_namespace AS namespace
        ON namespace.oid = procedure.pronamespace
      WHERE namespace.nspname = 'app_private'
        AND pg_catalog.has_function_privilege(
          'r72_external_event_command', procedure.oid, 'EXECUTE'
        )
      ORDER BY procedure.proname`);
    assert.deepEqual(executableFunctions, [
      { function_name: 'current_actor_kind' },
      { function_name: 'current_request_id' },
      { function_name: 'current_workspace_id' },
      { function_name: 'record_external_event_shadow_receipt' },
    ]);

    const first = await scopedQuery<DispositionRow>(
      pool, 'r72_external_event_command', context, recordSql, values,
    );
    assert.deepEqual(first, [{ disposition: 'shadow', replayed: false }]);

    const replay = await scopedQuery<DispositionRow>(
      pool, 'r72_external_event_command', context, recordSql, values,
    );
    assert.deepEqual(replay, [{ disposition: 'shadow', replayed: true }]);
    assert.deepEqual(Object.keys(replay[0]!), ['disposition', 'replayed']);

    const changedBytes = [...values];
    changedBytes[9] = createHash('sha256').update(Buffer.concat([
      rawBody,
      Buffer.from(' '),
    ])).digest();
    await expectPostgresError(
      scopedQuery(pool, 'r72_external_event_command', context, recordSql, changedBytes),
      '22000',
    );

    await expectPostgresError(
      scopedQuery(
        pool,
        'r72_external_event_command',
        context,
        'SELECT payload_sha256 FROM app_private.external_event_shadow_receipts',
      ),
      '42501',
    );

    await expectPostgresError(
      scopedQuery(pool, 'r72_webhook', context, recordSql, values),
      '42501',
    );

    for (const forbiddenWrite of [
      'INSERT INTO app.contacts DEFAULT VALUES',
      'INSERT INTO app.conversion_enrollments DEFAULT VALUES',
      'INSERT INTO app.communication_consent_events DEFAULT VALUES',
      'INSERT INTO app.communication_suppression_events DEFAULT VALUES',
      'INSERT INTO app.outbox_events DEFAULT VALUES',
      'INSERT INTO app_private.external_event_shadow_receipts DEFAULT VALUES',
    ]) {
      await expectPostgresError(
        scopedQuery(
          pool,
          'r72_external_event_command',
          context,
          forbiddenWrite,
        ),
        '42501',
      );
    }

    const receipts = await ownerQuery<ReceiptCountRow>(pool, `
      SELECT count(*)::integer AS receipt_count
      FROM app_private.external_event_shadow_receipts
      WHERE workspace_id = $1 AND source = 'property_predator' AND event_id = $2
    `, [workspaceId, event.id]);
    assert.deepEqual(receipts, [{ receipt_count: 1 }]);
    assert.deepEqual(await sideEffectCounts(pool), before);
  } finally {
    await pool.end();
  }
});
