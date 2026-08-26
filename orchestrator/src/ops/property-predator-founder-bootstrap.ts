import { createHash, randomBytes } from 'node:crypto';
import type { Pool, PoolClient, QueryResultRow } from 'pg';
import {
  assertSchemaCurrent,
  discoverMigrations,
  type SqlMigration,
} from '../db/migrate.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CHANGE_REFERENCE_PATTERN = /^[a-z][a-z0-9._:-]{7,79}$/;

export const PROPERTY_PREDATOR_FOUNDER_EMAIL = 'office@propertypredator.com';
export const PROPERTY_PREDATOR_FOUNDER_PORTAL_ORIGIN = 'https://hq.propertypredator.co.uk';
export const PROPERTY_PREDATOR_FOUNDER_BOOTSTRAP_MIGRATIONS = Object.freeze([
  '0001_extensions_roles.sql',
  '0002_identity_workspaces.sql',
  '0003_crm_first_loop.sql',
  '0004_portal_sessions.sql',
  '0005_canonical_portal_identity.sql',
  '0006_customer_provisioning.sql',
  '0007_public_schema_hardening.sql',
  '0008_setup_delivery_recovery.sql',
  '0009_neon_integration_repairs.sql',
  '0010_delivery_lease_portability.sql',
  '0011_stable_chronology_defaults.sql',
  '0012_paid_checkout_provenance.sql',
  '0013_setup_delivery_provider_settlement.sql',
  '0014_conversion_journeys.sql',
  '0015_external_event_shadow_bridge.sql',
  '0016_property_predator_growth_evidence.sql',
  '0017_property_predator_growth_projector.sql',
  '0018_property_predator_journey_runtime.sql',
  '0019_legacy_lead_import_foundation.sql',
  '0020_legacy_lead_journey_board_materialization.sql',
  '0021_company_content_versions_and_approvals.sql',
  '0022_provider_operations_and_inbox_core.sql',
  '0023_provider_operation_dispatch.sql',
  '0024_mailgun_webhook_evidence.sql',
  '0025_property_predator_email_pilot_boundary.sql',
  '0026_database_installation_identity.sql',
  '0027_property_predator_founder_bootstrap.sql',
] as const);

export interface PropertyPredatorFounderBootstrapConfig {
  changeReference: string;
  expectedInstallationId: string;
}

export interface PropertyPredatorFounderBootstrapHandoff {
  schemaVersion: 1;
  purpose: 'property-predator-founder-bootstrap';
  createdNow: boolean;
  organizationId: string;
  workspaceId: string;
  ownerUserId: string;
  setupActionTokenId: string;
  setupExpiresAt: string;
  providerConnectionId: string;
  controlEventId: string;
  seedEventId: string;
  ownerEmail: typeof PROPERTY_PREDATOR_FOUNDER_EMAIL;
  setup: {
    status: 'created' | 'unavailable-on-idempotent-replay';
    url?: string;
  };
  render: {
    PROPERTY_PREDATOR_PILOT_WORKSPACE_ID: string;
    PROPERTY_PREDATOR_MAILGUN_CONNECTION_ID: string;
    PROPERTY_PREDATOR_DATABASE_INSTALLATION_ID: string;
    PROPERTY_PREDATOR_EMAIL_INTERNAL_SEEDS: typeof PROPERTY_PREDATOR_FOUNDER_EMAIL;
  };
}

interface FounderBootstrapRow extends QueryResultRow {
  organization_id: unknown;
  workspace_id: unknown;
  owner_user_id: unknown;
  setup_action_token_id: unknown;
  setup_expires_at: unknown;
  provider_connection_id: unknown;
  control_event_id: unknown;
  seed_event_id: unknown;
  created_now: unknown;
}

export interface PropertyPredatorFounderBootstrapDependencies {
  pool: Pick<Pool, 'connect'>;
  migrationsDirectory?: string;
  setupTokenBytes?: () => Buffer;
}

function exactUuid(value: unknown, label: string): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new Error(`${label} was not a canonical UUID`);
  }
  return value;
}

function exactTimestamp(value: unknown): string {
  const raw = value instanceof Date ? value.toISOString() : value;
  const epoch = typeof raw === 'string' ? Date.parse(raw) : Number.NaN;
  if (!Number.isFinite(epoch)) throw new Error('setup expiry was invalid');
  return new Date(epoch).toISOString();
}

export function loadPropertyPredatorFounderBootstrapConfig(
  env: NodeJS.ProcessEnv = process.env,
): PropertyPredatorFounderBootstrapConfig {
  const changeReference = env.PROPERTY_PREDATOR_FOUNDER_BOOTSTRAP_CHANGE_REFERENCE?.trim() ?? '';
  if (changeReference !== env.PROPERTY_PREDATOR_FOUNDER_BOOTSTRAP_CHANGE_REFERENCE
      || !CHANGE_REFERENCE_PATTERN.test(changeReference)) {
    throw new Error(
      'PROPERTY_PREDATOR_FOUNDER_BOOTSTRAP_CHANGE_REFERENCE must be a canonical lowercase change reference',
    );
  }
  const expectedInstallationId = env.PROPERTY_PREDATOR_DATABASE_INSTALLATION_ID?.trim() ?? '';
  if (expectedInstallationId !== env.PROPERTY_PREDATOR_DATABASE_INSTALLATION_ID
      || !UUID_PATTERN.test(expectedInstallationId)) {
    throw new Error('PROPERTY_PREDATOR_DATABASE_INSTALLATION_ID must be a canonical UUID');
  }
  return Object.freeze({ changeReference, expectedInstallationId });
}

export function propertyPredatorFounderMigrationLedger(
  migrations: readonly SqlMigration[],
): ReadonlyArray<Readonly<{ filename: string; checksum: string }>> {
  const filenames = migrations.map((migration) => migration.filename);
  if (filenames.length !== PROPERTY_PREDATOR_FOUNDER_BOOTSTRAP_MIGRATIONS.length
      || filenames.some((filename, index) => (
        filename !== PROPERTY_PREDATOR_FOUNDER_BOOTSTRAP_MIGRATIONS[index]
      ))) {
    throw new Error('Founder bootstrap release does not contain the exact reviewed migration ledger');
  }
  return Object.freeze(migrations.map((migration) => Object.freeze({
    filename: migration.filename,
    checksum: migration.checksum,
  })));
}

async function rollbackWithoutLeaking(client: PoolClient): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } catch {
    // The caller receives a fixed error below. A connection/provider message can
    // contain credential-bearing configuration and must never be re-emitted.
  }
}

/**
 * Run the reviewed founder bootstrap against a direct administrative database
 * connection. This function performs no HTTP request and never imports or
 * invokes a provider adapter. PostgreSQL receives only the SHA-256 token hash.
 */
export async function bootstrapPropertyPredatorFounder(
  dependencies: PropertyPredatorFounderBootstrapDependencies,
  config: PropertyPredatorFounderBootstrapConfig,
): Promise<PropertyPredatorFounderBootstrapHandoff> {
  const migrations = await discoverMigrations(dependencies.migrationsDirectory);
  const ledger = propertyPredatorFounderMigrationLedger(migrations);
  await assertSchemaCurrent(dependencies.pool, dependencies.migrationsDirectory);

  const rawTokenBytes = (dependencies.setupTokenBytes ?? (() => randomBytes(32)))();
  if (!Buffer.isBuffer(rawTokenBytes) || rawTokenBytes.byteLength !== 32) {
    throw new Error('Founder setup-token source must return exactly 32 random bytes');
  }
  const setupToken = rawTokenBytes.toString('base64url');
  const setupTokenHash = createHash('sha256').update(setupToken, 'ascii').digest();
  const client = await dependencies.pool.connect();
  let committed = false;
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE r72_owner');
    const result = await client.query<FounderBootstrapRow>(
      `/* ops.property-predator.founder-bootstrap */
       SELECT organization_id, workspace_id, owner_user_id,
              setup_action_token_id, setup_expires_at,
              provider_connection_id, control_event_id, seed_event_id,
              created_now
       FROM app_private.bootstrap_property_predator_founder(
         $1, $2, $3::jsonb, $4
       )`,
      [
        config.changeReference,
        config.expectedInstallationId,
        JSON.stringify(ledger),
        setupTokenHash,
      ],
    );
    if (result.rows.length !== 1) {
      throw new Error('Founder bootstrap did not return exactly one receipt');
    }
    const row = result.rows[0]!;
    const createdNow = row.created_now;
    if (typeof createdNow !== 'boolean') {
      throw new Error('Founder bootstrap receipt had an invalid creation state');
    }
    const organizationId = exactUuid(row.organization_id, 'organization id');
    const workspaceId = exactUuid(row.workspace_id, 'workspace id');
    const ownerUserId = exactUuid(row.owner_user_id, 'owner user id');
    const setupActionTokenId = exactUuid(row.setup_action_token_id, 'setup action token id');
    const providerConnectionId = exactUuid(row.provider_connection_id, 'provider connection id');
    const controlEventId = exactUuid(row.control_event_id, 'control event id');
    const seedEventId = exactUuid(row.seed_event_id, 'seed event id');
    const setupExpiresAt = exactTimestamp(row.setup_expires_at);

    await client.query('COMMIT');
    committed = true;
    const setup = createdNow
      ? Object.freeze({
        status: 'created' as const,
        url: `${PROPERTY_PREDATOR_FOUNDER_PORTAL_ORIGIN}/portal/setup?token=${encodeURIComponent(setupToken)}`,
      })
      : Object.freeze({ status: 'unavailable-on-idempotent-replay' as const });
    return Object.freeze({
      schemaVersion: 1 as const,
      purpose: 'property-predator-founder-bootstrap' as const,
      createdNow,
      organizationId,
      workspaceId,
      ownerUserId,
      setupActionTokenId,
      setupExpiresAt,
      providerConnectionId,
      controlEventId,
      seedEventId,
      ownerEmail: PROPERTY_PREDATOR_FOUNDER_EMAIL,
      setup,
      render: Object.freeze({
        PROPERTY_PREDATOR_PILOT_WORKSPACE_ID: workspaceId,
        PROPERTY_PREDATOR_MAILGUN_CONNECTION_ID: providerConnectionId,
        PROPERTY_PREDATOR_DATABASE_INSTALLATION_ID: config.expectedInstallationId,
        PROPERTY_PREDATOR_EMAIL_INTERNAL_SEEDS: PROPERTY_PREDATOR_FOUNDER_EMAIL,
      }),
    });
  } catch {
    if (!committed) await rollbackWithoutLeaking(client as PoolClient);
    throw new Error('Property Predator founder bootstrap failed closed');
  } finally {
    client.release(!committed);
    rawTokenBytes.fill(0);
    setupTokenHash.fill(0);
  }
}
