import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import test from 'node:test';
import type { Pool } from 'pg';
import { PgFinanceRepository } from '../src/portal/finance-drafts-pg-service.js';
import { requestDatabaseContext } from '../src/db/rls.js';
import { packet, parsePlanning, validateIllustration, type Planning } from '../src/integrations/mh196/planning-client.js';
import type { SignedReview } from '../src/portal/finance-drafts-service.js';

const W = '11111111-1111-4111-8111-111111111111', O = '22222222-2222-4222-8222-222222222222', C = '33333333-3333-4333-8333-333333333333', U = '44444444-4444-4444-8444-444444444444';
const fixture = JSON.parse(readFileSync(new URL('./fixtures/mh196-public-numeric.json', import.meta.url), 'utf8')) as { models: { request: { planning: Planning }; assumptions_as_of: string; response: unknown }[] };
const item = fixture.models[0]!, planning = parsePlanning(item.request.planning);
const review: SignedReview = { workspaceId: W, opportunityId: O, contactId: C, opportunityVersion: 2, expectedLatestVersion: 0, nonce: U, packet: packet(planning, item.assumptions_as_of), illustration: validateIllustration(item.response, planning, item.assumptions_as_of), calculatedAt: '2026-10-26T10:00:00Z', expiresAt: 0 };
const context = requestDatabaseContext({ userId: U, workspaceId: W, requestId: 'finance-command-test', portalSessionTokenHash: createHash('sha256').update('test-session').digest() });
function harness(options: { active?: boolean; canWrite?: boolean; contact?: string; version?: string; latest?: number } = {}) {
  const seen: string[] = []; let released = false;
  const pool = { async connect() { return { async query(sql: string, values: unknown[] = []) {
    seen.push(sql);
    // Reproduce the existing command-role boundary, not an extra database grant.
    if (/\bapp\.workspaces\b/.test(sql)) throw Object.assign(new Error('permission denied for table workspaces'), { code: '42501' });
    if (sql.includes('database.lock-portal-session')) return { rows: [{ active: options.active ?? true }] };
    if (sql.includes('finance.lock-source')) { assert.ok(sql.includes('FOR UPDATE OF o')); assert.deepEqual(values, [O]); return { rows: [{ workspace_id: W, contact_id: options.contact ?? C, row_version: options.version ?? '2', can_write: options.canWrite ?? true }] }; }
    if (sql.includes('finance.replay')) return { rows: [] };
    if (sql.includes('finance.latest-locked')) return { rows: [{ version: options.latest ?? 0 }] };
    if (sql.includes('finance.append')) return { rows: [{ id: O, version: 1, opportunity_version: '2', packet: review.packet, illustration: review.illustration, calculated_at: new Date(review.calculatedAt), created_at: new Date(review.calculatedAt) }] };
    return { rows: [] };
  }, release() { released = true; } }; } } as unknown as Pick<Pool, 'connect'>;
  return { repository: new PgFinanceRepository(pool, pool), seen, released: () => released };
}
test('finance save succeeds with command-role table permissions and preserves session-before-parent locking', async () => {
  const h = harness(), saved = await h.repository.save(context, review);
  assert.equal(saved.version, 1); assert.equal(h.released(), true);
  assert.ok(h.seen.findIndex(sql => sql.includes('database.lock-portal-session')) < h.seen.findIndex(sql => sql.includes('finance.lock-source')));
  assert.ok(h.seen.findIndex(sql => sql.includes('finance.lock-source')) < h.seen.findIndex(sql => sql.includes('finance.latest-locked')));
  assert.equal(h.seen.at(-1), 'COMMIT');
});
test('the narrowed query keeps session, writer, contact and source/latest-version rejection fences', async () => {
  for (const options of [{ active: false }, { canWrite: false }, { contact: U }, { version: '3' }, { latest: 1 }]) {
    const h = harness(options); await assert.rejects(h.repository.save(context, review));
    assert.equal(h.seen.some(sql => sql.includes('finance.append')), false); assert.equal(h.seen.at(-1), 'ROLLBACK'); assert.equal(h.released(), true);
  }
});
