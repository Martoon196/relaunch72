import assert from 'node:assert/strict';
import test from 'node:test';
import { assertZernioSocialCommandBoundaryReady } from '../src/portal/zernio-social-connection-pg-service.js';

const exact = Object.freeze({
  exactRole: true,
  schemaUsage: true,
  requiredFunctions: true,
  tableBlind: true,
  elevatedRolesDenied: true,
});

test('Zernio readiness requires both read-only and write-side portal-session fences', async () => {
  let sql = '';
  await assertZernioSocialCommandBoundaryReady({ async query(statement: string) {
    sql = statement;
    return { rows: [exact] } as never;
  } } as never);
  assert.match(sql, /app_private\.active_portal_session\(bytea,uuid,uuid\)/u);
  assert.match(sql, /app_private\.lock_active_portal_session\(bytea,uuid,uuid\)/u);
  assert.match(sql, /app_private\.read_zernio_social_accounts\(uuid,uuid,bytea\)/u);
});

test('Zernio readiness fails closed when any boundary capability is missing', async () => {
  for (const field of Object.keys(exact)) {
    await assert.rejects(
      assertZernioSocialCommandBoundaryReady({ async query() {
        return { rows: [{ ...exact, [field]: false }] } as never;
      } } as never),
      /Zernio social command database boundary is not exact/u,
    );
  }
});

test('Zernio readiness hides connection diagnostics when verification cannot run', async () => {
  await assert.rejects(
    assertZernioSocialCommandBoundaryReady({ async query() {
      throw new Error('password authentication failed for user');
    } } as never),
    (error: unknown) => error instanceof Error
      && /could not be verified/u.test(error.message)
      && !/password/u.test(error.message),
  );
});
