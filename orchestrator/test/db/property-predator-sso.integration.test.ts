import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import type { Pool, QueryResultRow } from 'pg';
import {
  expectPostgresError,
  openTestDatabase,
  ownerQuery,
  resetIdentityTables,
  roleQuery,
  testDatabaseSkipReason,
} from './database-helper.js';

const skip = testDatabaseSkipReason();
const ORGANIZATION_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const WORKSPACE_ID = '33333333-3333-4333-8333-333333333333';
const SUBJECT = '44444444-4444-4444-8444-444444444444';
const AFFILIATE_ID = '55555555-5555-4555-8555-555555555555';

interface ExternalSessionRow extends QueryResultRow {
  session_id: string;
  user_id: string;
  user_email: string;
  selected_workspace_id: string;
  expires_at: Date;
}

function digest(label: string): Buffer {
  return createHash('sha256').update(`property-predator-sso-integration:${label}`).digest();
}

async function externalLogin(
  pool: Pool,
  values: {
    issuer?: string;
    subject?: string;
    email?: string;
    bootstrapUserId?: string | null;
    member?: boolean;
    affiliateId?: string | null;
    affiliateCode?: string | null;
    affiliateStatus?: string | null;
    sessionLabel?: string;
  } = {},
): Promise<ExternalSessionRow[]> {
  const label = values.sessionLabel ?? 'default';
  return roleQuery<ExternalSessionRow>(
    pool,
    'r72_identity_command',
    `SELECT session_id, user_id, user_email, selected_workspace_id, expires_at
       FROM app_private.create_portal_external_identity_session(
         $1::text, $2::uuid, $3::text, true, $4::uuid,
         $5::boolean, $6::uuid, $7::text, $8::text,
         NULL::uuid, NULL::timestamptz,
         $9::bytea, $10::bytea, NULL::bytea, NULL::bytea
       )`,
    [
      values.issuer ?? 'https://propertypredator.com',
      values.subject ?? SUBJECT,
      values.email ?? 'martin.howard1984@gmail.com',
      values.bootstrapUserId ?? null,
      values.member ?? true,
      values.affiliateId === undefined ? AFFILIATE_ID : values.affiliateId,
      values.affiliateCode === undefined ? 'founder_01' : values.affiliateCode,
      values.affiliateStatus === undefined ? 'active' : values.affiliateStatus,
      digest(`session:${label}`),
      digest(`csrf:${label}`),
    ],
  );
}

async function seedFounder(pool: Pool): Promise<void> {
  await resetIdentityTables(pool);
  await ownerQuery(pool, `
    INSERT INTO app.organizations (id, name, slug, kind)
    VALUES ($1, 'Property Predator', 'property-predator', 'direct_customer')
  `, [ORGANIZATION_ID]);
  await ownerQuery(pool, `
    INSERT INTO app.users (id, email, display_name, status)
    VALUES ($1, 'office@propertypredator.com', 'Property Predator Founder', 'pending')
  `, [USER_ID]);
  await ownerQuery(pool, `
    INSERT INTO app.workspaces (id, organization_id, name, slug)
    VALUES ($1, $2, 'Property Predator Growth HQ', 'growth-hq')
  `, [WORKSPACE_ID, ORGANIZATION_ID]);
  await ownerQuery(pool, `
    INSERT INTO app.organization_memberships (organization_id, user_id, role, status)
    VALUES ($1, $2, 'owner', 'active')
  `, [ORGANIZATION_ID, USER_ID]);
  await ownerQuery(pool, `
    INSERT INTO app.workspace_memberships (
      workspace_id, organization_id, user_id, role, status, source_organization_id
    ) VALUES ($1, $2, $3, 'owner', 'active', $2)
  `, [WORKSPACE_ID, ORGANIZATION_ID, USER_ID]);
  await ownerQuery(pool, `
    INSERT INTO app.identity_action_tokens (
      user_id, workspace_id, purpose, token_hash, expires_at, request_id
    ) VALUES (
      $1, $2, 'account_setup', $3, statement_timestamp() + interval '1 day', 'sso-integration'
    )
  `, [USER_ID, WORKSPACE_ID, digest('setup-token')]);
}

test('0029 links only an explicit founder, activates it and issues auditable opaque sessions', {
  skip,
}, async () => {
  const pool = await openTestDatabase();
  try {
    await seedFounder(pool);

    assert.deepEqual(await externalLogin(pool, { sessionLabel: 'no-bootstrap' }), []);
    assert.deepEqual(await ownerQuery(pool, `
      SELECT
        (SELECT count(*)::integer FROM app.user_external_identities) AS identities,
        (SELECT count(*)::integer FROM app.user_sessions) AS sessions,
        (SELECT status FROM app.users WHERE id = $1) AS user_status
    `, [USER_ID]), [{ identities: 0, sessions: 0, user_status: 'pending' }]);

    const first = await externalLogin(pool, {
      bootstrapUserId: USER_ID,
      sessionLabel: 'first',
    });
    assert.equal(first.length, 1);
    assert.equal(first[0]!.user_id, USER_ID);
    assert.equal(first[0]!.user_email, 'office@propertypredator.com');
    assert.equal(first[0]!.selected_workspace_id, WORKSPACE_ID);

    const facts = await ownerQuery<{
      user_status: string;
      canonical_email: string;
      canonical_email_verified_at: Date | null;
      asserted_email: string;
      issuer: string;
      subject: string;
      setup_revoked: boolean;
      external_identity_id: string;
      session_external_identity_id: string;
      session_ttl_seconds: number;
    }>(pool, `
      SELECT
        person.status AS user_status,
        person.email::text AS canonical_email,
        person.email_verified_at AS canonical_email_verified_at,
        identity.asserted_email::text AS asserted_email,
        identity.issuer,
        identity.subject::text,
        action_token.revoked_at IS NOT NULL AS setup_revoked,
        identity.id::text AS external_identity_id,
        session.external_identity_id::text AS session_external_identity_id,
        extract(epoch FROM (session.expires_at - session.created_at))::integer AS session_ttl_seconds
      FROM app.users AS person
      JOIN app.user_external_identities AS identity ON identity.user_id = person.id
      JOIN app.user_sessions AS session ON session.external_identity_id = identity.id
      JOIN app.identity_action_tokens AS action_token ON action_token.user_id = person.id
      WHERE person.id = $1
    `, [USER_ID]);
    assert.equal(facts.length, 1);
    assert.equal(facts[0]!.user_status, 'active');
    assert.equal(facts[0]!.canonical_email, 'office@propertypredator.com');
    assert.equal(facts[0]!.canonical_email_verified_at, null, 'external assertion never rewrites/verifies a different canonical contact email');
    assert.equal(facts[0]!.asserted_email, 'martin.howard1984@gmail.com');
    assert.equal(facts[0]!.issuer, 'https://propertypredator.com');
    assert.equal(facts[0]!.subject, SUBJECT);
    assert.equal(facts[0]!.setup_revoked, true);
    assert.equal(facts[0]!.session_external_identity_id, facts[0]!.external_identity_id);
    assert.ok(facts[0]!.session_ttl_seconds >= 86_390 && facts[0]!.session_ttl_seconds <= 86_400);

    const returning = await externalLogin(pool, {
      bootstrapUserId: null,
      email: 'a-new-display-claim@example.test',
      sessionLabel: 'returning',
    });
    assert.equal(returning.length, 1, 'immutable issuer + subject signs in without repeating bootstrap authority');
    assert.equal(returning[0]!.user_id, USER_ID);
    assert.deepEqual(await ownerQuery(pool, `
      SELECT
        (SELECT count(*)::integer FROM app.user_external_identities) AS identities,
        (SELECT count(*)::integer FROM app.user_sessions) AS sessions,
        (SELECT email::text FROM app.users WHERE id = $1) AS canonical_email
    `, [USER_ID]), [{ identities: 1, sessions: 2, canonical_email: 'office@propertypredator.com' }]);
  } finally {
    await pool.end();
  }
});

test('0029 rejects wrong issuers, incomplete affiliate facts and all direct runtime table access', {
  skip,
}, async () => {
  const pool = await openTestDatabase();
  try {
    await seedFounder(pool);
    await expectPostgresError(externalLogin(pool, {
      issuer: 'https://attacker.example',
      bootstrapUserId: USER_ID,
      sessionLabel: 'issuer',
    }), '22023');
    await expectPostgresError(externalLogin(pool, {
      bootstrapUserId: USER_ID,
      member: true,
      affiliateId: null,
      affiliateCode: null,
      affiliateStatus: null,
      sessionLabel: 'affiliate',
    }), '22023');
    await expectPostgresError(
      roleQuery(pool, 'r72_web', 'SELECT * FROM app.user_external_identities'),
      '42501',
    );
    await expectPostgresError(
      roleQuery(pool, 'r72_identity_command', 'SELECT * FROM app.user_external_identities'),
      '42501',
    );
    await expectPostgresError(
      roleQuery(
        pool,
        'r72_web',
        `SELECT * FROM app_private.create_portal_external_identity_session(
          $1::text, $2::uuid, $3::text, true, $4::uuid,
          true, $5::uuid, 'founder_01', 'active',
          NULL::uuid, NULL::timestamptz,
          $6::bytea, $7::bytea, NULL::bytea, NULL::bytea
        )`,
        [
          'https://propertypredator.com', SUBJECT, 'martin.howard1984@gmail.com',
          USER_ID, AFFILIATE_ID, digest('web-session'), digest('web-csrf'),
        ],
      ),
      '42501',
    );
  } finally {
    await pool.end();
  }
});

test('0029 revalidates membership for every linked external sign-in', {
  skip,
}, async () => {
  const pool = await openTestDatabase();
  try {
    await seedFounder(pool);
    assert.equal((await externalLogin(pool, { bootstrapUserId: USER_ID, sessionLabel: 'first' })).length, 1);
    await ownerQuery(pool, `
      UPDATE app.workspace_memberships
         SET status = 'suspended', updated_at = statement_timestamp()
       WHERE workspace_id = $1 AND user_id = $2
    `, [WORKSPACE_ID, USER_ID]);
    assert.deepEqual(await externalLogin(pool, { sessionLabel: 'suspended' }), []);
    assert.deepEqual(await ownerQuery(pool, `
      SELECT count(*)::integer AS sessions FROM app.user_sessions
    `), [{ sessions: 1 }]);
  } finally {
    await pool.end();
  }
});
