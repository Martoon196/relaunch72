import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'pg';
import {
  buildPgPortalPlatform,
  createPgPortalInboxReadBoundary,
  postgresPortalEnabled,
} from '../src/portal/postgres-platform.js';

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

test('PostgreSQL portal cutover still requires its isolated CRM command identity', async () => {
  await assert.rejects(
    () => buildPgPortalPlatform({
      NODE_ENV: 'development',
      DATABASE_WEB_URL: 'postgresql://r72_web:secret@localhost/relaunch72_test?sslmode=disable',
      DATABASE_IDENTITY_COMMAND_URL: 'postgresql://r72_identity_command:secret@localhost/relaunch72_test?sslmode=disable',
    }),
    /DATABASE_CRM_COMMAND_URL is required/,
  );
});

test('Property Predator production requires its dedicated company-content command identity', async () => {
  await assert.rejects(
    () => buildPgPortalPlatform({
      NODE_ENV: 'production',
      PORTAL_PRODUCT_PROFILE: 'property_predator_growth',
      PROPERTY_PREDATOR_DATABASE_INSTALLATION_ID: '33333333-3333-4333-8333-333333333333',
      DATABASE_WEB_URL: 'postgresql://r72_web:secret@db.example.test/growth_hq?sslmode=verify-full',
      DATABASE_IDENTITY_COMMAND_URL: 'postgresql://r72_identity_command:secret@db.example.test/growth_hq?sslmode=verify-full',
      DATABASE_CRM_COMMAND_URL: 'postgresql://r72_crm_command:secret@db.example.test/growth_hq?sslmode=verify-full',
    }),
    /requires DATABASE_CONTENT_COMMAND_URL/,
  );
});

test('Property Predator production pins every runtime pool to one database installation', async () => {
  await assert.rejects(
    () => buildPgPortalPlatform({
      NODE_ENV: 'production',
      PORTAL_PRODUCT_PROFILE: 'property_predator_growth',
      DATABASE_WEB_URL: 'postgresql://r72_web:secret@db.example.test/growth_hq?sslmode=verify-full',
      DATABASE_IDENTITY_COMMAND_URL: 'postgresql://r72_identity_command:secret@db.example.test/growth_hq?sslmode=verify-full',
      DATABASE_CRM_COMMAND_URL: 'postgresql://r72_crm_command:secret@db.example.test/growth_hq?sslmode=verify-full',
      DATABASE_CONTENT_COMMAND_URL: 'postgresql://r72_content_command:secret@db.example.test/growth_hq?sslmode=verify-full',
    }),
    /requires its database installation identity/,
  );
});

test('conversion inbox composition resolves the opaque session before any RLS read and exposes no send surface', async () => {
  let readConnections = 0;
  const webPool = {
    query: async () => ({ rows: [], rowCount: 0 }),
    connect: async () => {
      readConnections += 1;
      throw new Error('must not connect for an unresolved session');
    },
  } as unknown as Pick<Pool, 'query' | 'connect'>;
  const inbox = createPgPortalInboxReadBoundary(webPool);

  const page = await inbox.listConversations({
    sessionToken: 'opaque-missing-session',
    requestId: 'request-inbox-1',
  });
  const thread = await inbox.thread!({
    sessionToken: 'opaque-missing-session',
    requestId: 'request-inbox-thread-1',
  }, '33333333-3333-4333-8333-333333333333');

  assert.equal(page, null);
  assert.equal(thread, null);
  assert.equal(readConnections, 0);
  assert.deepEqual(Object.keys(inbox), ['listConversations', 'thread']);
  assert.equal('thread' in inbox, true);
  assert.equal('send' in inbox, false);
  assert.equal('publish' in inbox, false);
});
