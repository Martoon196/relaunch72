import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
function claim(source: string, declaration: string): string {
  const normal = source.replace(/\r\n/gu, '\n'), start = normal.indexOf(declaration);
  assert.ok(start >= 0, 'Expected exact claim declaration');
  const end = normal.indexOf('\n$function$;', start); assert.ok(end > start);
  return normal.slice(start, end + '\n$function$;'.length);
}
test('MHP130 claim repair preserves every0056 guard, cap, lease and unknown-send branch except ambiguous conflict target', async () => {
  const original = claim(await readFile(new URL('../../src/db/migrations/0056_property_predator_twilio_sms_live_foundation.sql', import.meta.url), 'utf8'), 'CREATE FUNCTION app_private.claim_sms_live_job(');
  const repaired = claim(await readFile(new URL('../../src/db/migrations/0130_mhp_owned_sms_pilot.sql', import.meta.url), 'utf8'), 'CREATE OR REPLACE FUNCTION app_private.claim_sms_live_job(');
  const ambiguous = 'ON CONFLICT (workspace_id, job_id) DO UPDATE SET', exact = 'ON CONFLICT ON CONSTRAINT property_predator_sms_job_leases_pkey DO UPDATE SET';
  assert.equal(original.split(ambiguous).length, 2); assert.equal(repaired.split(exact).length, 2);
  assert.equal(repaired.replace('CREATE OR REPLACE FUNCTION', 'CREATE FUNCTION').replace(exact, ambiguous), original);
});
