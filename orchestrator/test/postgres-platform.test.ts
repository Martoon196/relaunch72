import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPgPortalPlatform, postgresPortalEnabled } from '../src/portal/postgres-platform.js';

test('PostgreSQL portal cutover requires an explicit, strictly parsed operator gate', () => {
  for (const value of [undefined, '', 'false', '0', 'no']) {
    assert.equal(postgresPortalEnabled({ PORTAL_POSTGRES_ENABLED: value }), false);
  }
  for (const value of ['true', '1', 'yes', ' TRUE ']) {
    assert.equal(postgresPortalEnabled({ PORTAL_POSTGRES_ENABLED: value }), true);
  }
  assert.throws(
    () => postgresPortalEnabled({ PORTAL_POSTGRES_ENABLED: 'sometimes' }),
    /must be true or false/,
  );
});

test('PostgreSQL portal cutover never reuses a generic development database identity', async () => {
  await assert.rejects(
    () => buildPgPortalPlatform({
      NODE_ENV: 'development',
      DATABASE_URL: 'postgresql://database_owner:secret@localhost/relaunch72_test?sslmode=disable',
    }),
    /requires DATABASE_WEB_URL authenticated as r72_web/,
  );
});

test('PostgreSQL portal cutover requires the isolated provisioning identity too', async () => {
  await assert.rejects(
    () => buildPgPortalPlatform({
      NODE_ENV: 'development',
      DATABASE_WEB_URL: 'postgresql://r72_web:secret@localhost/relaunch72_test?sslmode=disable',
      DATABASE_IDENTITY_COMMAND_URL: 'postgresql://r72_identity_command:secret@localhost/relaunch72_test?sslmode=disable',
      DATABASE_CRM_COMMAND_URL: 'postgresql://r72_crm_command:secret@localhost/relaunch72_test?sslmode=disable',
    }),
    /DATABASE_PROVISIONING_COMMAND_URL is required/,
  );
});
