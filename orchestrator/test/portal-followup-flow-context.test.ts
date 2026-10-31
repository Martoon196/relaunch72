import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { PortalFlowContext } from '../src/portal/followup-flow-context.js';
import type { CompanyContentTransactionRunner } from '../src/company-content-pg/index.js';
import { ids } from './helpers/mhp-owner-email-fixture.js';
const workspaceId = 'd975ff66-336a-46c2-b36b-d7095a11af97', organizationId = '28f53f34-b890-48a7-b37f-7a7b26bec0bf';
const context = { actorKind: 'user' as const, workspaceId, userId: ids.user, requestId: ids.request };
function fixture() {
  const row: Record<string, unknown> = { workspaceId, organizationId, workspaceName: 'Growth HQ', productName: 'Property Predator',
    primaryColor: null, accentColor: null, supportEmail: null, logoStorageKey: null, logoSha256: null,
    brandingRevision: null, brandingPresent: false, organizationRevision: '2026-10-30T00:00:00Z', workspaceRevision: '2026-10-31T00:00:00Z', canManage: true };
  let sql = '';
  const reader = { run: async (_context: unknown, operation: (transaction: unknown) => Promise<unknown>) => operation({ query: async (value: string) => { sql = value; return { rows: [row] }; } }) } as CompanyContentTransactionRunner;
  const principal = { resolve: async () => ({ workspaceId, userId: ids.user }) };
  return { row, principal, context: new PortalFlowContext(principal, reader, workspaceId), sql: () => sql };
}
test('native flow brand uses actual organization when optional branding is absent, binding both revisions', async () => {
  const f = fixture(), brand = await f.context.brand(context), canonical = JSON.parse(brand.canonical);
  assert.match(f.sql(), /JOIN app.organizations o/u); assert.match(f.sql(), /LEFT JOIN app.organization_branding/u);
  assert.equal(brand.productName, 'Property Predator'); assert.equal(brand.primaryColor, null); assert.equal(brand.accentColor, null);
  assert.equal(canonical.brandingPresent, false); assert.equal(canonical.brandingRevision, null);
  assert.equal(canonical.organizationRevision, '2026-10-30T00:00:00.000Z'); assert.equal(canonical.workspaceRevision, '2026-10-31T00:00:00.000Z');
  assert.equal(brand.sha256, createHash('sha256').update(brand.canonical).digest('hex'));
  f.row.workspaceRevision = '2026-10-31T01:00:00Z'; assert.notEqual((await f.context.brand(context)).sha256, brand.sha256);
});
test('actual optional branding revision and values remain in canonical provenance', async () => {
  const f = fixture(); Object.assign(f.row, { brandingPresent: true, brandingRevision: '2026-10-31T02:00:00Z', primaryColor: '#123b48', accentColor: '#E8A33D', supportEmail: 'synthetic@example.invalid' });
  const brand = await f.context.brand(context), canonical = JSON.parse(brand.canonical);
  assert.equal(canonical.brandingPresent, true); assert.equal(canonical.brandingRevision, '2026-10-31T02:00:00.000Z'); assert.equal(brand.primaryColor, '#123b48');
  f.row.brandingRevision = '2026-10-31T03:00:00Z'; assert.notEqual((await f.context.brand(context)).sha256, brand.sha256);
});
test('optional branding never weakens actual native workspace, owner or revision checks', async () => {
  for (const patch of [{ canManage: false }, { workspaceId: ids.prospect }, { organizationRevision: null }, { workspaceRevision: 'invalid' }, { brandingPresent: true }, { brandingPresent: false, brandingRevision: '2026-10-31' }]) {
    const f = fixture(); Object.assign(f.row, patch); await assert.rejects(f.context.brand(context));
  }
  const f = fixture(); await assert.rejects(f.context.brand({ ...context, workspaceId: ids.prospect }));
  f.principal.resolve = async () => ({ workspaceId: ids.prospect, userId: ids.user });
  await assert.rejects(f.context.authorize({ sessionToken: 'opaque-synthetic', requestId: ids.request }));
});
