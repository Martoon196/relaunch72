import { createHash } from 'node:crypto';
import { canonicalCompanyContentJson, createCompanyContentTransactionRunner, type CompanyContentTransactionRunner } from '../company-content-pg/index.js';
import { requestDatabaseContext, type DatabaseRequestContext } from '../db/rls.js';
import { createPgPortalCrmPrincipalResolver, type PortalCrmPrincipalResolver } from './crm-pg-service.js';
import { FOLLOWUP_SEQUENCE_UUID, followupSequenceSha } from '../followup-sequences/definition.js';
import { FlowWorkspaceError, type FlowBrandSnapshot } from '../followup-sequences/workspace.js';
import type { Pool } from 'pg';
export interface PortalFlowIdentity { readonly sessionToken: string; readonly requestId: string }
const brandSql = `/* portal.followup-flow.native-brand */
 SELECT w.id::text AS "workspaceId",w.organization_id::text AS "organizationId",w.name AS "workspaceName",
  COALESCE(b.product_name,o.name) AS "productName",b.primary_color AS "primaryColor",b.accent_color AS "accentColor",b.support_email::text AS "supportEmail",
  b.logo_storage_key AS "logoStorageKey",encode(b.logo_sha256,'hex') AS "logoSha256",b.updated_at AS "brandingRevision",
  o.updated_at AS "organizationRevision",w.updated_at AS "workspaceRevision",(b.organization_id IS NOT NULL) AS "brandingPresent",
  app_private.can_manage_workspace(app_private.current_user_id(),w.id) AS "canManage"
 FROM app.workspaces w JOIN app.organizations o ON o.id=w.organization_id
 LEFT JOIN app.organization_branding b ON b.organization_id=o.id
 WHERE w.id=app_private.current_workspace_id()`;
export function ppFlowContentRunner(pool: Pick<Pool, 'connect'>, workspaceId: string): CompanyContentTransactionRunner {
  if (!FOLLOWUP_SEQUENCE_UUID.test(workspaceId)) throw new Error('PP flow workspace must be configured by the server');
  const base = createCompanyContentTransactionRunner(pool);
  return { run(context, operation, options) {
    if (context.actorKind !== 'user' || context.workspaceId !== workspaceId || !context.userId || !context.portalSessionTokenHash) throw new FlowWorkspaceError(403, 'Open the Property Predator workspace with an owner or admin account.');
    return base.run(context, async transaction => {
      const result = await transaction.query<{ allowed: boolean }>('SELECT app_private.can_manage_workspace(app_private.current_user_id(),app_private.current_workspace_id()) AS allowed');
      if (result.rows.length !== 1 || result.rows[0]?.allowed !== true) throw new FlowWorkspaceError(403, 'An active owner or admin is required for flow authoring.');
      return operation(transaction);
    }, options);
  } };
}
export class PortalFlowContext {
  constructor(private readonly principal: Pick<PortalCrmPrincipalResolver, 'resolve'>, private readonly reader: CompanyContentTransactionRunner, readonly workspaceId: string) {
    if (!FOLLOWUP_SEQUENCE_UUID.test(workspaceId)) throw new Error('PP flow workspace must be configured by the server');
  }
  async authorize(identity: PortalFlowIdentity): Promise<DatabaseRequestContext> {
    const principal = await this.principal.resolve(identity.sessionToken);
    if (!principal || principal.workspaceId !== this.workspaceId) throw new FlowWorkspaceError(403, 'Select the Property Predator Growth HQ workspace before opening its flows.');
    return requestDatabaseContext({ ...principal, requestId: identity.requestId, portalSessionTokenHash: createHash('sha256').update(identity.sessionToken).digest() });
  }
  async brand(context: DatabaseRequestContext): Promise<FlowBrandSnapshot> {
    if (context.workspaceId !== this.workspaceId) throw new FlowWorkspaceError(403, 'This flow belongs to another workspace.');
    return this.reader.run(context, async transaction => {
      const result = await transaction.query<Record<string, unknown>>(brandSql), row = result.rows[0];
      if (result.rows.length !== 1 || !row || row.workspaceId !== this.workspaceId || typeof row.organizationId !== 'string' || !FOLLOWUP_SEQUENCE_UUID.test(row.organizationId)
          || row.canManage !== true || typeof row.productName !== 'string' || !row.productName.trim() || row.productName.length > 100
          || typeof row.workspaceName !== 'string' || row.workspaceName.length > 160
          || ![row.primaryColor, row.accentColor].every(color => color === null || typeof color === 'string' && /^#[0-9a-f]{6}$/iu.test(color))
          || typeof row.brandingPresent !== 'boolean'
          || ![row.organizationRevision,row.workspaceRevision].every(validRevision)
          || (row.brandingPresent ? !validRevision(row.brandingRevision) : row.brandingRevision !== null)
          || !(row.supportEmail === null || typeof row.supportEmail === 'string' && row.supportEmail.length <= 320)
          || !(row.logoStorageKey === null || typeof row.logoStorageKey === 'string' && row.logoStorageKey.length <= 2000)
          || !(row.logoSha256 === null || typeof row.logoSha256 === 'string' && /^[0-9a-f]{64}$/u.test(row.logoSha256))
          || (row.logoStorageKey === null) !== (row.logoSha256 === null)) throw new FlowWorkspaceError(503, 'The selected workspace’s current brand details could not be verified.');
      const canonical = canonicalCompanyContentJson({ schema: 'growthhq.native-organization-brand/v1', workspaceId: row.workspaceId, organizationId: row.organizationId,
        workspaceName: row.workspaceName, productName: row.productName, primaryColor: row.primaryColor, accentColor: row.accentColor,
        supportEmail: row.supportEmail, logoStorageKey: row.logoStorageKey, logoSha256: row.logoSha256,
        brandingPresent: row.brandingPresent, brandingRevision: row.brandingRevision === null ? null : new Date(row.brandingRevision as Date | string).toISOString(),
        organizationRevision: new Date(row.organizationRevision as Date | string).toISOString(), workspaceRevision: new Date(row.workspaceRevision as Date | string).toISOString() });
      const sha256 = followupSequenceSha(canonical);
      return Object.freeze({ canonical, sha256, ref: `native-organization-brand/v1:${row.organizationId}:${sha256}`, productName: row.productName,
        primaryColor: row.primaryColor as string | null, accentColor: row.accentColor as string | null });
    }, { readOnly: true });
  }
}
function validRevision(value: unknown): value is Date | string {
  return (value instanceof Date || typeof value === 'string') && Number.isFinite(new Date(value).getTime());
}
export function createPortalFlowContext(webPool: Pool, workspaceId: string) {
  return new PortalFlowContext(createPgPortalCrmPrincipalResolver(webPool), ppFlowContentRunner(webPool, workspaceId), workspaceId);
}
