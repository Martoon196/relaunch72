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
