import test from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { PgPortalAbuseGuard } from '../src/portal/abuse-pg-service.js';
import type { PortalAbuseAdmission } from '../src/portal/abuse.js';

const requestHash = Buffer.alloc(32, 1);
const subjectHash = Buffer.alloc(32, 2);
const admission: PortalAbuseAdmission = Object.freeze({
  routeClass: 'auth.login',
  requestHash,
  cost: 1,
  now: 1_000,
  dimensions: Object.freeze([Object.freeze({
    name: 'auth', subjectHash, capacity: 5, windowSeconds: 900, maxConcurrency: 1,
  })]),
});

test('PostgreSQL abuse guard passes only fixed labels, integers and digests', async () => {
  const calls: Array<{ text: string; values?: unknown[] }> = [];
  const pool = {
    query: async (text: string, values?: unknown[]) => {
      calls.push({ text, values });
      if (text.includes('abuse-admit')) {
        return { rows: [{ allowed: true, retry_after_seconds: 0, lease_hash: values?.[7] }] };
      }
      if (text.includes('abuse-complete')) return { rows: [{ completed: true }] };
      return { rows: [{ ready: true }] };
    },
    end: async () => undefined,
  } as unknown as Pick<Pool, 'query' | 'end'>;
  const guard = new PgPortalAbuseGuard(pool);
  const decision = await guard.admit(admission);
  assert.equal(decision.allowed, true);
  assert.equal(calls[0]?.values?.[0], 'auth.login');
  assert.deepEqual(calls[0]?.values?.[1], ['auth']);
  assert.deepEqual(calls[0]?.values?.[2], [subjectHash]);
  assert.deepEqual(calls[0]?.values?.slice(3, 7), [[5], [900], [1], [1]]);
  assert.equal(JSON.stringify(calls[0]?.values).includes('owner@example.test'), false);
  if (decision.allowed && decision.leaseHash) {
    await guard.complete(decision.leaseHash, 'auth_failure');
  }
  await guard.assertReady();
  assert.match(calls[1]!.text, /complete_portal_abuse_lease/);
  assert.match(calls[2]!.text, /portal_abuse_ready/);
});

test('PostgreSQL abuse guard validates denial and allowed evidence exactly', async () => {
  for (const row of [
    { allowed: false, retry_after_seconds: 0, lease_hash: null },
    { allowed: false, retry_after_seconds: 5, lease_hash: Buffer.alloc(32) },
    { allowed: true, retry_after_seconds: 0, lease_hash: Buffer.alloc(31) },
  ]) {
    const pool = {
      query: async () => ({ rows: [row] }),
      end: async () => undefined,
    } as unknown as Pick<Pool, 'query' | 'end'>;
    await assert.rejects(() => new PgPortalAbuseGuard(pool).admit(admission), /invalid/);
  }
});

test('PostgreSQL abuse guard closes an owned pool once', async () => {
  let closes = 0;
  const pool = {
    query: async () => ({ rows: [] }),
    end: async () => { closes += 1; },
  } as unknown as Pick<Pool, 'query' | 'end'>;
  const guard = new PgPortalAbuseGuard(pool, { ownsPool: true });
  await guard.close();
  await guard.close();
  assert.equal(closes, 1);
  await assert.rejects(() => guard.assertReady(), /closed/);
});
