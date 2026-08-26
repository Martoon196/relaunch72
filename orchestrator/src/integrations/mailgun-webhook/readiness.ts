import type { Pool, QueryResultRow } from 'pg';
import { withTransaction } from '../../db/transaction.js';
import { assertExpectedDatabaseInstallation } from '../../db/installation-identity.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

interface ReadinessRow extends QueryResultRow {
  correct_user: boolean;
  can_record: boolean;
  table_blind: boolean;
  cannot_assume_definer: boolean;
  can_check_binding: boolean;
}

/** Prove the exact receipt-only capability without reading tenant data. */
export async function assertPgMailgunWebhookIngressReady(
  pool: Pick<Pool, 'query' | 'connect'>,
  workspaceId: string,
  providerConnectionId: string,
  expectedInstallationId: string,
): Promise<void> {
  if (!UUID.test(workspaceId) || !UUID.test(providerConnectionId)) {
    throw new Error('Mailgun webhook readiness binding is invalid');
  }
  await assertExpectedDatabaseInstallation(pool, expectedInstallationId);
  const result = await pool.query<ReadinessRow>(
    `/* mailgun-webhook.protected-readiness */
     SELECT current_user = 'r72_mailgun_webhook_command' AS correct_user,
            pg_catalog.has_function_privilege(
              current_user,
              'app_private.record_mailgun_webhook_event(uuid,uuid,text,text,timestamp with time zone,text,bytea,bytea,bytea,timestamp with time zone,bytea,text)',
              'EXECUTE'
            ) AS can_record,
            NOT pg_catalog.has_table_privilege(
              current_user, 'app.mailgun_webhook_events', 'SELECT'
            )
            AND NOT pg_catalog.has_table_privilege(
              current_user, 'app.mailgun_webhook_events', 'INSERT'
            )
            AND NOT pg_catalog.has_table_privilege(
              current_user, 'app.mailgun_webhook_signature_tokens', 'SELECT'
            ) AS table_blind,
            NOT pg_catalog.pg_has_role(
              current_user, 'r72_mailgun_webhook_definer', 'MEMBER'
            ) AS cannot_assume_definer,
            pg_catalog.has_function_privilege(
              current_user,
              'app_private.mailgun_webhook_binding_ready(uuid,uuid)',
              'EXECUTE'
            ) AS can_check_binding`,
  );
  const row = result.rows[0];
  if (result.rows.length !== 1 || !row?.correct_user || !row.can_record
      || !row.table_blind || !row.cannot_assume_definer || !row.can_check_binding) {
    throw new Error('Mailgun webhook database identity did not pass protected readiness');
  }
  const bindingReady = await withTransaction(
    pool,
    { actorKind: 'webhook', workspaceId, requestId: 'mailgun:protected-readiness' },
    async (transaction) => transaction.query<{ ready: boolean } & QueryResultRow>(
      `/* mailgun-webhook.binding-readiness */
       SELECT app_private.mailgun_webhook_binding_ready($1, $2) AS ready`,
      [workspaceId, providerConnectionId],
    ),
    { readOnly: true, isolation: 'repeatable read' },
  );
  if (bindingReady.rows.length !== 1 || bindingReady.rows[0]?.ready !== true) {
    throw new Error('Mailgun webhook workspace/connection binding did not pass readiness');
  }
}
