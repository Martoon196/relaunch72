import test from 'node:test';
import assert from 'node:assert/strict';
import { createGroupHqCrmReadMount, loadGroupHqCrmConfig } from '../src/integrations/group-hq-crm/read.js';

const workspaceId = 'd975ff66-336a-46c2-b36b-d7095a11af97';
const organizationId = '28f53f34-b890-48a7-b37f-7a7b26bec0bf';
const ownerUserId = '82a1705e-0cd7-4414-a5f0-2cd8975c2322';
const token = 'test-group-hq-secret-with-at-least-32-chars';
const config = { token, workspaceId, organizationId, ownerUserId };

function response() {
  return {
    status: 0, headers: {} as Record<string, string>, body: '',
    writeHead(status: number, headers: Record<string, string>) { this.status = status; this.headers = headers; },
    end(body: string) { this.body = body; },
  };
}

function request(authorization?: string) {
  return { method: 'GET', headers: authorization ? { authorization } : {} };
}

test('Group HQ CRM configuration is off by default and rejects partial or wrong-profile setup', () => {
  assert.equal(loadGroupHqCrmConfig({}), undefined);
  assert.throws(() => loadGroupHqCrmConfig({ R72_GROUP_HQ_CRM_TOKEN: token }), /incomplete/);
  assert.throws(() => loadGroupHqCrmConfig({
    PORTAL_PRODUCT_PROFILE: 'martin_howard_property', R72_GROUP_HQ_CRM_TOKEN: token,
    R72_GROUP_HQ_CRM_PP_WORKSPACE_ID: workspaceId,
    R72_GROUP_HQ_CRM_PP_ORGANIZATION_ID: organizationId,
    R72_GROUP_HQ_CRM_OWNER_USER_ID: ownerUserId,
  }), /outside/);
});

test('Group HQ CRM rejects unauthorised, wrong-brand and malformed cursor requests without database access', async () => {
  const pool = { connect() { throw new Error('database must not be reached'); } };
  const mount = createGroupHqCrmReadMount(pool as never, config);
  for (const [auth, url, status] of [
    [undefined, 'https://hq.propertypredator.com/api/group-hq/crm/leads?brand=pp', 401],
    [`Bearer ${token}`, 'https://hq.propertypredator.com/api/group-hq/crm/leads?brand=mhp', 400],
    [`Bearer ${token}`, 'https://hq.propertypredator.com/api/group-hq/crm/leads?brand=pp&cursor=bad!', 400],
  ] as const) {
    const res = response();
    await mount.handle(request(auth) as never, res as never, new URL(url));
    assert.equal(res.status, status);
    assert.equal(res.headers['cache-control'], 'no-store');
  }
});

test('Group HQ CRM requires configured owner rights and returns a fixed PP lead shape', async () => {
  const calls: Array<{ sql: string; values: unknown[] | undefined }> = [];
  let owner = true;
  const client = {
    async query(sql: string, values?: unknown[]) {
      calls.push({ sql, values });
      if (sql.includes('can_manage_workspace')) return { rows: [{ allowed: owner }] };
      if (sql.includes('group-hq.crm.pp-leads')) return { rows: [{
        id: '59e2f6cf-c35e-4a23-991f-012d29fbecba', display_name: 'Test Lead', source: 'form',
        lifecycle_status: 'lead', owner_user_id: ownerUserId, updated_at: new Date('2026-10-29T12:00:00.123Z'),
        cursor_updated_at: '2026-10-29T12:00:00.123456Z', stage_name: 'New', next_task_at: null,
        last_activity_at: null,
      }] };
      return { rows: [] };
    },
    release() {},
  };
  const mount = createGroupHqCrmReadMount({ connect: async () => client } as never, config);
  const url = new URL('https://hq.propertypredator.com/api/group-hq/crm/leads?brand=pp');
  const res = response();
  await mount.handle(request(`Bearer ${token}`) as never, res as never, url);
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.brand, 'pp');
  assert.deepEqual(Object.keys(body.leads[0]).sort(),
    ['id', 'name', 'source', 'lifecycle', 'stage', 'nextTaskAt', 'lastActivityAt', 'ownerUserId', 'updatedAt'].sort());
  assert.equal(body.leads[0].name, 'Test Lead');
  assert.equal(calls.some(call => call.sql.includes('READ ONLY')), true);
  assert.equal(calls.some(call => call.sql.includes('JOIN app.organizations')), true);
  owner = false;
  const denied = response();
  await mount.handle(request(`Bearer ${token}`) as never, denied as never, url);
  assert.equal(denied.status, 403);
});

test('WhatsApp read bridge rejects missing auth, arbitrary scope and writes before database access', async () => {
  const mount = createGroupHqCrmReadMount({ connect() { throw new Error('must not connect'); } } as never, config);
  for (const [auth, query, method, expected] of [
    [undefined, '?brand=pp', 'GET', 401],
    [`Bearer ${token}`, '?brand=other', 'GET', 400],
    [`Bearer ${token}`, '?brand=pp&brand=mhp', 'GET', 400],
    [`Bearer ${token}`, '?brand=pp&workspaceId=arbitrary', 'GET', 400],
    [`Bearer ${token}`, '?brand=pp', 'POST', 404],
  ] as const) {
    const res = response();
    await mount.handle({ ...request(auth), method } as never, res as never,
      new URL(`https://hq.propertypredator.com/api/group-hq/channels/whatsapp${query}`));
    assert.equal(res.status, expected);
  }
  const mhp = response();
  await mount.handle(request(`Bearer ${token}`) as never, mhp as never,
    new URL('https://hq.propertypredator.com/api/group-hq/channels/whatsapp?brand=mhp'));
  assert.deepEqual(JSON.parse(mhp.body), { brand: 'mhp', channel: 'whatsapp', availability: 'not_connected' });
});

test('WhatsApp bridge uses selected fixed workspace, saved truth and read-only owner authority', async () => {
  const mhp = { workspaceId: '93c3bca1-c112-4ecb-981b-568358d9bef1', organizationId: '57787df3-aa08-4f2c-83b6-80b15ab554ce' };
  const calls: Array<{ sql: string; values?: unknown[] }> = [];
  let allowed = true;
  let corrupt = false;
  const client = {
    async query(sql: string, values?: unknown[]) {
      calls.push({ sql, values });
      if (sql.includes('can_manage_workspace')) return { rows: [{ allowed }] };
      if (sql.includes('group-hq.whatsapp.readiness')) return { rows: [{
        snapshot_at: new Date('2026-10-30T01:00:00Z'), connection_state: 'not_configured', inbound_state: 'not_ready',
        outbound_or_reply_state: 'blocked', receipt_state: 'none', latest_receipt_at: null,
        blocker_codes: corrupt ? ['PRIVATE_PROVIDER_ERROR'] : ['PROVIDER_NOT_CONFIGURED'],
      }] };
      return { rows: [] };
    }, release() {},
  };
  const mount = createGroupHqCrmReadMount({ connect: async () => client } as never, { ...config, mhp });
  for (const brand of ['pp', 'mhp']) {
    calls.length = 0;
    const res = response();
    await mount.handle(request(`Bearer ${token}`) as never, res as never,
      new URL(`https://hq.propertypredator.com/api/group-hq/channels/whatsapp?brand=${brand}`));
    assert.equal(res.status, 200);
    assert.equal(res.headers['cache-control'], 'no-store');
    const body = JSON.parse(res.body);
    assert.equal(body.brand, brand);
    assert.deepEqual(body.blockerCodes, ['PROVIDER_NOT_CONFIGURED']);
    assert.equal(Object.keys(body).length, 10);
    assert.equal(calls.some(c => c.sql.includes('READ ONLY')), true);
    assert.deepEqual(calls.find(c => c.sql.includes('can_manage_workspace'))?.values,
      [ownerUserId, brand === 'pp' ? workspaceId : mhp.workspaceId, brand === 'pp' ? organizationId : mhp.organizationId]);
    assert.equal(calls.some(c => /INSERT|UPDATE|DELETE|enqueue/iu.test(c.sql)), false);
  }
  allowed = false;
  const forbidden = response();
  await mount.handle(request(`Bearer ${token}`) as never, forbidden as never,
    new URL('https://hq.propertypredator.com/api/group-hq/channels/whatsapp?brand=mhp'));
  assert.equal(forbidden.status, 403);
  allowed = true; corrupt = true;
  const unavailable = response();
  await mount.handle(request(`Bearer ${token}`) as never, unavailable as never,
    new URL('https://hq.propertypredator.com/api/group-hq/channels/whatsapp?brand=pp'));
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.body.includes('PRIVATE_PROVIDER_ERROR'), false);
});

test('MHP mapping must be complete and distinct from the PP workspace and organisation', () => {
  const env = { PORTAL_PRODUCT_PROFILE: 'property_predator_growth', R72_GROUP_HQ_CRM_TOKEN: token,
    R72_GROUP_HQ_CRM_PP_WORKSPACE_ID: workspaceId, R72_GROUP_HQ_CRM_PP_ORGANIZATION_ID: organizationId,
    R72_GROUP_HQ_CRM_OWNER_USER_ID: ownerUserId };
  assert.throws(() => loadGroupHqCrmConfig({ ...env, R72_GROUP_HQ_CRM_MHP_WORKSPACE_ID: workspaceId }), /incomplete/);
  assert.throws(() => loadGroupHqCrmConfig({ ...env, R72_GROUP_HQ_CRM_MHP_WORKSPACE_ID: workspaceId,
    R72_GROUP_HQ_CRM_MHP_ORGANIZATION_ID: organizationId }), /overlaps/);
});
