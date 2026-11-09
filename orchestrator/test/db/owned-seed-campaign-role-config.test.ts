import assert from 'node:assert/strict';
import test from 'node:test';
import { DATABASE_ROLES, loadDatabaseConfig } from '../../src/db/config.js';
import { createOwnedSeedCampaignCommandDatabasePool } from '../../src/db/pool.js';

test('the owned-seed campaign portal command uses its exact table-blind identity', async () => {
  assert.ok(DATABASE_ROLES.includes('ownedSeedCampaignCommand'));
  assert.throws(() => loadDatabaseConfig('ownedSeedCampaignCommand', {
    NODE_ENV: 'production',
    DATABASE_OWNED_SEED_CAMPAIGN_URL:
      'postgresql://r72_crm_command:secret@db.example/relaunch72?sslmode=require',
  }), /least-privilege r72_owned_seed_campaign_command/);

  const config = loadDatabaseConfig('ownedSeedCampaignCommand', {
    NODE_ENV: 'production',
    DATABASE_OWNED_SEED_CAMPAIGN_URL:
      'postgresql://r72_owned_seed_campaign_command:secret@db.example/relaunch72?sslmode=require',
    DATABASE_OWNED_SEED_CAMPAIGN_POOL_MAX: '2',
  });
  assert.equal(config.sourceEnv, 'DATABASE_OWNED_SEED_CAMPAIGN_URL');
  assert.equal(config.expectedDatabaseUser, 'r72_owned_seed_campaign_command');
  assert.equal(config.applicationName, 'property-predator-owned-seed-campaign-command');
  assert.equal(config.maxConnections, 2);

  const pool = createOwnedSeedCampaignCommandDatabasePool({
    DATABASE_OWNED_SEED_CAMPAIGN_URL:
      'postgresql://r72_owned_seed_campaign_command:secret@localhost/relaunch72_test?sslmode=disable',
  }, { onBackgroundError: () => undefined });
  assert.equal(pool.options.application_name, 'property-predator-owned-seed-campaign-command');
  assert.equal(typeof pool.options.verify, 'function');
  await pool.end();
});

test('owned-seed campaign production never falls back to a generic database URL', () => {
  assert.throws(() => loadDatabaseConfig('ownedSeedCampaignCommand', {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgresql://owner:secret@db.example/relaunch72?sslmode=require',
  }), /production does not accept the generic DATABASE_URL fallback/);
});
