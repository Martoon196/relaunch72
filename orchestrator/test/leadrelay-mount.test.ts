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


test('Agent setup actions require individually recorded canonical grants', () => {
  const grants = loadGrants(JSON.stringify([{userId:'martin',workspaceId:'growth',installationId:'pilot',actions:['GET:agent-status','POST:agent-scan']} ]));
  assert.deepEqual(installationActions(grants,{userId:'martin',workspaceId:'growth'},'pilot'),['GET:agent-status','POST:agent-scan']);
  assert.deepEqual(installationActions(grants,{userId:'martin',workspaceId:'other'},'pilot'),[]);
  assert.equal(installationActions(grants,{userId:'martin',workspaceId:'growth'},'pilot').includes('POST:agent-test-call'),false);
});

test('Native provider connection grants are explicit and remain bound to canonical identity', () => {
  const old = loadGrants(JSON.stringify([{userId:'owner',workspaceId:'growth',installationId:'pilot',actions:['POST:agent-publish','PUT:settings']}]));
  assert.equal(installationActions(old,{userId:'owner',workspaceId:'growth'},'pilot').includes('POST:agent-connect'),false);
  assert.equal(installationActions(old,{userId:'owner',workspaceId:'growth'},'pilot').includes('POST:agent-phone-numbers'),false);
  const actions=['GET:agent-connection','POST:agent-voices','POST:agent-phone-numbers','POST:agent-connect'];
  const grants=loadGrants(JSON.stringify([{userId:'owner',workspaceId:'growth',installationId:'pilot',actions}]));
  assert.deepEqual(installationActions(grants,{userId:'owner',workspaceId:'growth'},'pilot'),actions);
  assert.deepEqual(installationActions(grants,{userId:'owner',workspaceId:'another'},'pilot'),[]);
  assert.deepEqual(installationActions(grants,{userId:'another',workspaceId:'growth'},'pilot'),[]);
  assert.deepEqual(installationActions(grants,{userId:'owner',workspaceId:'growth'},'other-installation'),[]);
  assert.deepEqual(installationActions(loadGrants(),{userId:'owner',workspaceId:'growth'},'pilot'),[]);
});
