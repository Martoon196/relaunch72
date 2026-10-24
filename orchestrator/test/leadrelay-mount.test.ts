import test from 'node:test';
import assert from 'node:assert/strict';
import { installationActions, loadGrants, panelBoot } from '../src/integrations/leadrelay/mount.js';

test('LeadRelay grants require canonical user AND workspace AND installation', () => {
  const grants = loadGrants(JSON.stringify([{userId:'martin',workspaceId:'growth',installationId:'pilot',actions:['GET:status','POST:pause']}]));
  assert.deepEqual(installationActions(grants,{userId:'martin',workspaceId:'growth'},'pilot'),['GET:status','POST:pause']);
  assert.deepEqual(installationActions(grants,{userId:'sabrina',workspaceId:'growth'},'pilot'),[]);
  assert.deepEqual(installationActions(grants,{userId:'martin',workspaceId:'pra'},'pilot'),[]);
  assert.deepEqual(installationActions(grants,{userId:'martin',workspaceId:'growth'},'pra'),[]);
  assert.deepEqual(loadGrants(),[]);
});
test('LeadRelay configuration refuses unknown actions and authority fields', () => {
  assert.throws(()=>loadGrants('[{"userId":"a","workspaceId":"b","installationId":"c","actions":["POST:call"]}]'));
  assert.throws(()=>loadGrants('[{"role":"owner"}]'));
  assert.match(panelBoot,/\/portal\/api\/leadrelay/);
  assert.doesNotMatch(panelBoot,/Bearer|localStorage/);
});
