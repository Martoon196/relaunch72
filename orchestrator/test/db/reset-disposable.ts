import '../../src/config.js';
import { loadDatabaseConfig } from '../../src/db/config.js';
import { createDatabasePool } from '../../src/db/pool.js';
import {
  assertDisposableTestDatabase,
  DISPOSABLE_BRANCH_CONFIRMATION,
} from './database-helper.js';

const APP_ROLES = [
  'r72_abuse_command',
  'r72_abuse_definer',
  'r72_affiliate_draft_command',
  'r72_affiliate_lifecycle_command',
  'r72_affiliate_legal_command',
  'r72_affiliate_commercial_command',
  'r72_affiliate_acceptance_command',
  'r72_affiliate_capacity_command',
  'r72_affiliate_declaration_command',
  'r72_affiliate_training_authority_command',
  'r72_affiliate_training_evidence_command',
  'r72_affiliate_specialist_command',
  'r72_affiliate_channel_command',
  'r72_affiliate_effect_command',
  'r72_affiliate_case_command',
  'r72_affiliate_receipt_command',
  'r72_commerce_definer',
  'r72_content_adapter',
  'r72_content_command',
  'r72_crm_command',
  'r72_customer_email_command',
  'r72_customer_email_definer',
  'r72_customer_email_webhook_command',
  'r72_customer_email_worker_command',
  'r72_external_event_definer',
  'r72_external_event_command',
  'r72_identity_command',
  'r72_import_command',
  'r72_journey_projector_definer',
  'r72_legacy_materializer_definer',
  'r72_mailgun_webhook_command',
  'r72_mailgun_webhook_definer',
  'r72_mailgun_worker_command',
  'r72_mailgun_worker_definer',
  'r72_onboarding_definer',
  'r72_owned_social_command',
  'r72_owned_social_definer',
  'r72_owned_social_worker_command',
  'r72_operational_inbox_definer',
  'r72_operational_inbox_reader_definer',
  'r72_owned_seed_campaign_command',
  'r72_owned_seed_message_command',
  'r72_owned_seed_message_definer',
  'r72_owner',
  'r72_provisioning_command',
  'r72_provider_operation_definer',
  'r72_public_social_command',
  'r72_public_social_definer',
  'r72_public_social_revalidator_command',
  'r72_public_social_worker_command',
  'r72_public',
  'r72_readonly',
  'r72_security_definer',
  'r72_setup_delivery_command',
  'r72_setup_delivery_definer',
  'r72_setup_reissue_command',
  'r72_sms_command',
  'r72_sms_definer',
  'r72_sms_webhook_command',
  'r72_sms_worker_command',
  'r72_test_inbox_webhook_command',
  'r72_test_inbox_webhook_definer',
  'r72_web',
  'r72_webhook',
  'r72_whatsapp_live_command',
  'r72_whatsapp_live_definer',
  'r72_whatsapp_live_webhook_command',
  'r72_whatsapp_live_worker_command',
  'r72_worker',
] as const;

const rawUrl = process.env.TEST_DATABASE_URL?.trim();
if (!rawUrl) throw new Error('TEST_DATABASE_URL is required');
assertDisposableTestDatabase(rawUrl);
if (process.env.TEST_DATABASE_RESET_CONFIRM?.trim() !== DISPOSABLE_BRANCH_CONFIRMATION) {
  throw new Error('Disposable database reset confirmation is missing');
}

const expectedDatabase = decodeURIComponent(new URL(rawUrl).pathname.replace(/^\//, ''));
const config = loadDatabaseConfig('migrator', {
  NODE_ENV: 'development',
  DATABASE_MIGRATOR_URL: rawUrl,
  DATABASE_SSL_MODE: process.env.TEST_DATABASE_SSL_MODE,
  DATABASE_POOL_MAX: '1',
});
const pool = createDatabasePool(config);
const client = await pool.connect();

try {
  await client.query('BEGIN');
  await client.query("SET LOCAL lock_timeout = '10s'");
  const identity = await client.query<{ database_name: string }>(
    'SELECT current_database() AS database_name',
  );
  if (identity.rows[0]?.database_name !== expectedDatabase) {
    throw new Error('Connected database does not match the guarded disposable target');
  }

  const ownerRole = await client.query<{ exists: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'r72_owner') AS exists",
  );
  if (ownerRole.rows[0]?.exists) {
    await client.query('SET LOCAL ROLE r72_owner');
    await client.query('DROP SCHEMA IF EXISTS app_private CASCADE');
    await client.query('DROP SCHEMA IF EXISTS app CASCADE');
    await client.query('RESET ROLE');
  }

  const existingRoles = await client.query<{ role_name: string }>(
    `SELECT rolname AS role_name
     FROM pg_catalog.pg_roles
     WHERE rolname = ANY ($1::text[])
     ORDER BY rolname`,
    [[...APP_ROLES]],
  );
  const roleNames = existingRoles.rows.map((row) => row.role_name);
  if (roleNames.length > 0) {
    // PostgreSQL 16 managed-role creators may receive ADMIN without SET. That
    // is enough to manage a role but not enough for DROP OWNED. On this
    // positively identified disposable database only, temporarily add SET to
    // the fixed application-role allowlist; dropping the roles removes these
    // memberships in the same transaction.
    for (const roleName of roleNames) {
      const grant = await client.query<{ sql: string }>(
        `SELECT pg_catalog.format(
           'GRANT %I TO %I WITH SET TRUE', $1::text, current_user
         ) AS sql`,
        [roleName],
      );
      await client.query(grant.rows[0]!.sql);
    }
    // Identifiers come exclusively from the fixed APP_ROLES allowlist above.
    const identifiers = roleNames.map((role) => `"${role}"`).join(', ');
    await client.query(`DROP OWNED BY ${identifiers}`);
    await client.query(`DROP ROLE ${identifiers}`);
  }

  await client.query('COMMIT');
  console.log('Disposable Relaunch72 schemas and roles reset successfully.');
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  client.release();
  await pool.end();
}
