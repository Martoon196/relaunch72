import test from 'node:test';
import assert from 'node:assert/strict';
import { guardedTarget, seal, unseal } from './webinar-rehearsal.mjs';
const env = () => ({ REHEARSAL_DISPOSABLE_DATABASE:'rl72-private-webinar-rehearsal-20261109', NODE_ENV:'production',
  REHEARSAL_DATABASE_URL:'postgresql://rl72_webinar_rehearsal_db_20261109_user:synthetic@dpg-dbp2tpon74is73eqn260-a/rl72_webinar_rehearsal_db_20261109',
  SESSION_SECRET:'s'.repeat(40), PORTAL_ABUSE_HASH_SECRET:'a'.repeat(40), REHEARSAL_ROLE_SECRET:'r'.repeat(40),
  REHEARSAL_OWNER_PASSWORD:'p'.repeat(40), WEBINAR_ACCESS_SECRET:'w'.repeat(40), APOLLO_ENABLED:'false', WEBINAR_EMAIL_MODE:'off' });
test('bootstrap refuses another host/database, unrelated effect credentials, or reused secrets before connecting', () => {
  assert.equal(guardedTarget(env()).pathname,'/rl72_webinar_rehearsal_db_20261109');
  assert.throws(() => guardedTarget({...env(),REHEARSAL_DATABASE_URL:env().REHEARSAL_DATABASE_URL.replace('dpg-dbp2tpon74is73eqn260-a','production.example.test')}));
  assert.throws(() => guardedTarget({...env(),REHEARSAL_DATABASE_URL:env().REHEARSAL_DATABASE_URL.replace('/rl72_webinar_rehearsal_db_20261109','/neondb')}));
  assert.throws(() => guardedTarget({...env(),APOLLO_API_KEY:'unexpected'}));
  assert.throws(() => guardedTarget({...env(),SESSION_SECRET:env().PORTAL_ABUSE_HASH_SECRET}));
});
test('private signing cache rejects modification and a different installation key', () => {
  const sealed=seal({id:'synthetic',jwk:'never-a-real-key'},'s'.repeat(40));
  assert.equal(unseal(sealed,'s'.repeat(40)).id,'synthetic');
  assert.throws(() => unseal(sealed,'x'.repeat(40)));
  const changed=Buffer.from(sealed,'base64');changed[30]^=1;
  assert.throws(() => unseal(changed.toString('base64'),'s'.repeat(40)));
});
