import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { PgMhpHqService, type MhpHqSnapshot } from '../src/mhp/hq-service.js';
import { hqPage } from '../src/mhp/hq-view.js';
import { MhpCommerceError } from '../src/mhp/commerce-service.js';

const token = Buffer.alloc(32, 4).toString('base64url');
const id = '11700000-0000-4000-8000-000000000001';
const form = { commandId: id, productId: id, targetEmail: ' NEW@EXAMPLE.INVALID ', targetName: 'New person', note: 'Invoice INV-117', endsAt: '' };
const now = Date.parse('2026-10-28T12:00:00Z');
function fixture(error?: unknown) {
  const calls: { sql: string; args: unknown[] }[] = [];
  const pool = { query: async (sql: string, args: unknown[]) => { calls.push({ sql, args }); if (error) throw error;
    return { rows: [{ id, allowed: true, snapshot: { people: [], products: [], grants: [] } }] }; } } as unknown as Pick<Pool, 'query'>;
  return { service: new PgMhpHqService(pool, pool), calls };
}
test('manual grant hashes session, normalises person and records bounded command without a purchase', async () => {
  const f = fixture(); assert.equal(await f.service.grant(token, form, now), id);
  assert.equal(f.calls.length, 1); assert.match(f.calls[0]!.sql, /^SELECT app_private.mhp_grant_manual_access/);
  assert.deepEqual(f.calls[0]!.args, [createHash('sha256').update(token).digest(), id, 'new@example.invalid', 'New person', id, null, 'Invoice INV-117']);
});
test('manual grants accept only a real future UTC expiry', async () => {
  const f = fixture();
  for (const endsAt of ['2026-10-28T11:59', '2027-02-29T12:00', 'tomorrow', '2027-11-01T12:00Z']) {
    await assert.rejects(f.service.grant(token, { ...form, endsAt }, now), (e: unknown) => e instanceof MhpCommerceError && e.status === 400);
  }
  assert.equal(f.calls.length, 0);
  await f.service.grant(token, { ...form, endsAt: '2027-11-01T12:00' }, now);
  assert.equal(f.calls[0]!.args[5], '2027-11-01T12:00:00.000Z');
});
test('manual grant validation rejects malformed command, person and empty reason before querying', async () => {
  const f = fixture();
  for (const patch of [{ note: ' ' }, { targetEmail: 'not-email' }, { commandId: 'bad' }, { productId: 'bad' }, { targetName: 'line\nbreak' }]) {
    await assert.rejects(f.service.grant(token, { ...form, ...patch }, now), (e: unknown) => e instanceof MhpCommerceError && e.status === 400);
  }
  assert.equal(f.calls.length, 0);
});
test('database denial, changed replay and unexpected SQL details remain safe at HTTP boundary', async () => {
  for (const [code, expected] of [['42501', 403], ['40001', 409], ['22023', 400], ['XX000', 503]] as const) {
    const f = fixture({ code, message: 'private database details' });
    await assert.rejects(f.service.grant(token, form, now), (e: unknown) => e instanceof MhpCommerceError && e.status === expected && !e.message.includes('private'));
  }
});
test('owner navigation check and HQ search use scoped functions and bound parameters', async () => {
  const f = fixture(); assert.equal(await f.service.isOwner(token), true);
  await f.service.snapshot(token, '  invoice-person@example.invalid  ');
  assert.match(f.calls[0]!.sql, /mhp_is_owner/); assert.match(f.calls[1]!.sql, /mhp_hq_snapshot/);
  assert.equal(f.calls[1]!.args[1], 'invoice-person@example.invalid');
  await assert.rejects(f.service.snapshot(token, 'x'.repeat(201)));
});
test('HQ escapes audit/person content and labels grants separately from purchases', () => {
  const snapshot: MhpHqSnapshot = { people: [{ id, name: '<script>person</script>', email: 'test@example.invalid' }],
    products: [{ id, sku: 'mhp_course', name: 'Course & coaching' }],
    grants: [{ id, accountId: id, name: '<img src=x>', email: 'test@example.invalid', productName: 'Course & coaching',
      startsAt: '2026-10-28T12:00:00Z', endsAt: null, note: '<script>audit</script>', grantedBy: 'owner@example.invalid', grantedAt: '2026-10-28T12:00:00Z' }] };
  const html = hqPage({ snapshot, csrf: 'safe', granted: true });
  assert.doesNotMatch(html, /<script>|<img src=x>/); assert.match(html, /&lt;script&gt;audit/);
  assert.match(html, /name="commandId"/); assert.match(html, /No expiry/); assert.match(html, /no checkout is needed/);
  assert.match(html, /name="note" required/); assert.match(html, /action="\/hq\/grant"/);
});
