import type { Pool, QueryResultRow } from 'pg';
import { assertExpectedDatabaseInstallation } from '../../db/installation-identity.js';
import { withTransaction } from '../../db/transaction.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

interface ReadinessRow extends QueryResultRow {
  correct_user: boolean;
  can_record: boolean;
  table_blind: boolean;
  cannot_assume_definer: boolean;
  can_check_binding: boolean;
}

export async function assertPgPropertyPredatorMailgunInboundReady(
  pool: Pick<Pool, 'query' | 'connect'>,
  workspaceId: string,
  providerConnectionId: string,
  expectedInstallationId: string,
): Promise<void> {
  if (!UUID.test(workspaceId) || !UUID.test(providerConnectionId)) {
    throw new Error('Mailgun inbound readiness binding is invalid');
  }
  await assertExpectedDatabaseInstallation(pool, expectedInstallationId);
  const result = await pool.query<ReadinessRow>(
    `/* property-predator-mailgun-inbound.protected-readiness */
     -- This role intentionally has no USAGE on app. Resolve the protected
     -- relation through pg_catalog so the blindness proof itself stays usable.
     WITH protected_relation AS (
       SELECT relation.oid
       FROM pg_catalog.pg_class AS relation
       JOIN pg_catalog.pg_namespace AS namespace
         ON namespace.oid = relation.relnamespace
       WHERE namespace.nspname = 'app'
         AND relation.relname = 'property_predator_mailgun_inbound_receipts'
         AND relation.relkind IN ('r', 'p')
     )
     SELECT current_user = 'r72_mailgun_webhook_command' AS correct_user,
            pg_catalog.has_function_privilege(
              current_user,
              'app_private.record_property_predator_owned_seed_mailgun_inbound(uuid,uuid,text,text,text,text,text,text,timestamp with time zone,bytea,bytea,bytea,timestamp with time zone,bytea,bytea,bytea,bytea)',
              'EXECUTE'
            ) AS can_record,
            NOT pg_catalog.has_table_privilege(
              current_user,
              (SELECT oid FROM protected_relation),
              'SELECT'
            )
            AND NOT pg_catalog.has_table_privilege(
              current_user,
              (SELECT oid FROM protected_relation),
              'INSERT'
            ) AS table_blind,
            NOT pg_catalog.pg_has_role(
              current_user, 'r72_mailgun_webhook_definer', 'MEMBER'
            ) AS cannot_assume_definer,
            pg_catalog.has_function_privilege(
              current_user,
              'app_private.property_predator_mailgun_inbound_binding_ready(uuid,uuid)',
              'EXECUTE'
            ) AS can_check_binding`,
  );
  const row = result.rows[0];
  if (result.rows.length !== 1 || !row?.correct_user || !row.can_record
      || !row.table_blind || !row.cannot_assume_definer || !row.can_check_binding) {
    throw new Error('Mailgun inbound database identity did not pass protected readiness');
  }
  const binding = await withTransaction(
    pool,
    { actorKind: 'webhook', workspaceId, requestId: 'mailgun-in:protected-readiness' },
    async (transaction) => transaction.query<{ ready: boolean } & QueryResultRow>(
      `/* property-predator-mailgun-inbound.binding-readiness */
       SELECT app_private.property_predator_mailgun_inbound_binding_ready($1, $2) AS ready`,
      [workspaceId, providerConnectionId],
    ),
    { readOnly: true, isolation: 'repeatable read' },
  );
  if (binding.rows.length !== 1 || binding.rows[0]?.ready !== true) {
    throw new Error('Mailgun inbound workspace/connection binding did not pass readiness');
  }
}
