import type { Pool, QueryResult, QueryResultRow } from 'pg';
import { assertExpectedDatabaseInstallation } from '../db/installation-identity.js';
import { withTransaction } from '../db/transaction.js';
import {
  TEST_INBOX_WEBHOOK_PROVIDER_IDS,
  type TestInboxWebhookTrustedBinding,
} from './types.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PROVIDERS = new Set<string>(TEST_INBOX_WEBHOOK_PROVIDER_IDS);

interface ReadinessRow extends QueryResultRow {
  correctUser: boolean;
  canRecord: boolean;
  tableBlind: boolean;
  cannotAssumeDefiner: boolean;
  canCheckBinding: boolean;
  canCheckInstallation: boolean;
  cannotUseAppSchema: boolean;
}

function exactBinding(
  binding: Readonly<TestInboxWebhookTrustedBinding>,
): Readonly<TestInboxWebhookTrustedBinding> {
  const ids = [
    binding.workspaceId,
    binding.providerConnectionId,
    binding.inboxId,
    binding.contactId,
    binding.contactPointId,
  ];
  if (ids.some((value) => !UUID.test(value)) || !PROVIDERS.has(binding.providerId)) {
    throw new Error('Test inbox webhook readiness binding is invalid');
  }
  return Object.freeze({ ...binding });
}

/**
 * Prove one command-only TEST webhook identity before accepting signed events.
 * The checks return booleans only: no endpoint, contact, message or receipt data
 * crosses the readiness boundary.
 */
export async function assertPgTestInboxWebhookIngressReady(
  pool: Pick<Pool, 'query' | 'connect'>,
  binding: Readonly<TestInboxWebhookTrustedBinding>,
  expectedInstallationId: string,
): Promise<void> {
  const exact = exactBinding(binding);
  await assertExpectedDatabaseInstallation(pool, expectedInstallationId);

  let protectedReadiness: QueryResult<ReadinessRow>;
  try {
    protectedReadiness = await pool.query<ReadinessRow>(
      `/* test-inbox-webhook.protected-readiness */
       WITH protected_relations AS (
         SELECT relation.relname, relation.oid
         FROM pg_catalog.pg_class AS relation
         JOIN pg_catalog.pg_namespace AS namespace
           ON namespace.oid = relation.relnamespace
         WHERE namespace.nspname = 'app'
           AND relation.relname IN (
             'test_inbox_webhook_receipts',
             'messages',
             'message_versions'
           )
           AND relation.relkind IN ('r', 'p')
       )
       SELECT current_user = 'r72_test_inbox_webhook_command' AS "correctUser",
              pg_catalog.has_function_privilege(
                current_user,
                'app_private.record_test_inbox_webhook_inbound(uuid,uuid,text,uuid,uuid,uuid,text,bytea,bytea,bytea,bytea,bytea,text,bytea,timestamp with time zone,uuid,uuid,uuid)',
                'EXECUTE'
              ) AS "canRecord",
              NOT EXISTS (
                SELECT 1 FROM protected_relations AS relation
                WHERE pg_catalog.has_table_privilege(
                  current_user, relation.oid, 'SELECT'
                ) OR pg_catalog.has_table_privilege(
                  current_user, relation.oid, 'INSERT'
                ) OR pg_catalog.has_table_privilege(
                  current_user, relation.oid, 'UPDATE'
                ) OR pg_catalog.has_table_privilege(
                  current_user, relation.oid, 'DELETE'
                ) OR pg_catalog.has_table_privilege(
                  current_user, relation.oid, 'TRUNCATE'
                ) OR pg_catalog.has_table_privilege(
                  current_user, relation.oid, 'REFERENCES'
                ) OR pg_catalog.has_table_privilege(
                  current_user, relation.oid, 'TRIGGER'
                )
              ) AS "tableBlind",
              NOT pg_catalog.pg_has_role(
                current_user, 'r72_test_inbox_webhook_definer', 'MEMBER'
              ) AS "cannotAssumeDefiner",
              pg_catalog.has_function_privilege(
                current_user,
                'app_private.test_inbox_webhook_binding_ready(uuid,uuid,text,uuid,uuid,uuid)',
                'EXECUTE'
              ) AS "canCheckBinding",
              pg_catalog.has_function_privilege(
                current_user,
                'app_private.runtime_database_installation_id()',
                'EXECUTE'
              ) AS "canCheckInstallation",
              NOT pg_catalog.has_schema_privilege(
                current_user, 'app', 'USAGE'
              ) AS "cannotUseAppSchema"`,
    );
  } catch {
    throw new Error('Test inbox webhook database identity could not be verified');
  }

  const row = protectedReadiness.rows[0];
  if (protectedReadiness.rows.length !== 1 || !row?.correctUser
      || !row.canRecord || !row.tableBlind || !row.cannotAssumeDefiner
      || !row.canCheckBinding || !row.canCheckInstallation
      || !row.cannotUseAppSchema) {
    throw new Error('Test inbox webhook database identity did not pass protected readiness');
  }

  let bindingReady: QueryResult<{ ready: boolean } & QueryResultRow>;
  try {
    bindingReady = await withTransaction(
      pool,
      {
        actorKind: 'webhook',
        workspaceId: exact.workspaceId,
        requestId: 'test-inbox:protected-readiness',
      },
      async (transaction) => transaction.query<{ ready: boolean } & QueryResultRow>(
        `/* test-inbox-webhook.binding-readiness */
         SELECT app_private.test_inbox_webhook_binding_ready(
           $1, $2, $3, $4, $5, $6
         ) AS ready`,
        [
          exact.workspaceId,
          exact.providerConnectionId,
          exact.providerId,
          exact.inboxId,
          exact.contactId,
          exact.contactPointId,
        ],
      ),
      { readOnly: true, isolation: 'repeatable read' },
    );
  } catch {
    throw new Error('Test inbox webhook binding could not be verified');
  }

  if (bindingReady.rows.length !== 1 || bindingReady.rows[0]?.ready !== true) {
    throw new Error('Test inbox webhook workspace binding did not pass readiness');
  }
}
