import { createHash } from 'node:crypto';
import type { Pool, PoolClient, QueryResultRow } from 'pg';
import { requestDatabaseContext, type DatabaseRequestContext } from '../db/rls.js';
import { withTransaction } from '../db/transaction.js';
import { createPlanningClient, FinanceError } from '../integrations/mh196/planning-client.js';
import { createPgPortalCrmPrincipalResolver } from './crm-pg-service.js';
import { FinanceDraftsService, type FinanceRepository, type FinanceSnapshot, type FinanceSource, type SavedFinance, type SignedReview } from './finance-drafts-service.js';

interface SourceRow extends QueryResultRow { workspace_id: string; workspace_name: string; opportunity_id: string; opportunity_name: string; contact_id: string; contact_name: string; row_version: string; can_write: boolean; latest_version: number }
interface LockedSourceRow extends QueryResultRow { workspace_id: string; contact_id: string; row_version: string; can_write: boolean }
interface SavedRow extends QueryResultRow { id: string; version: number; opportunity_version: string; packet: SavedFinance['packet']; illustration: SavedFinance['illustration']; calculated_at: Date; created_at: Date; review_hash: Buffer }
const SOURCE_SQL = `/* finance.source */ SELECT w.id AS workspace_id, w.name AS workspace_name,
  o.id AS opportunity_id, o.name AS opportunity_name, o.contact_id, c.display_name AS contact_name,
  o.row_version, app_private.can_write_workspace(app_private.current_user_id(), w.id) AS can_write,
  COALESCE((SELECT max(f.version) FROM app.finance_planning_drafts f WHERE f.workspace_id = o.workspace_id AND f.opportunity_id = o.id), 0) AS latest_version
  FROM app.opportunities o JOIN app.workspaces w ON w.id = o.workspace_id
  JOIN app.contacts c ON c.workspace_id = o.workspace_id AND c.id = o.contact_id
  WHERE o.workspace_id = app_private.current_workspace_id() AND o.id = $1 AND c.deleted_at IS NULL`;
// The CRM command role deliberately cannot read workspace display metadata.
// Lock only its permitted parent/contact records; the session supplies scope.
const LOCKED_SOURCE_SQL = `/* finance.lock-source */ SELECT o.workspace_id, o.contact_id, o.row_version,
  app_private.can_write_workspace(app_private.current_user_id(), o.workspace_id) AS can_write
  FROM app.opportunities o JOIN app.contacts c ON c.workspace_id = o.workspace_id AND c.id = o.contact_id
  WHERE o.workspace_id = app_private.current_workspace_id() AND o.id = $1 AND c.deleted_at IS NULL
  FOR UPDATE OF o`;
function source(row: SourceRow): FinanceSource {
  const version = Number(row.row_version), latest = Number(row.latest_version);
  if (!Number.isSafeInteger(version) || version < 1 || !Number.isSafeInteger(latest) || latest < 0 || typeof row.can_write !== 'boolean') throw new FinanceError(503, 'The opportunity version could not be read.');
  return { workspaceId: row.workspace_id, workspaceName: row.workspace_name, opportunityId: row.opportunity_id, opportunityName: row.opportunity_name, contactId: row.contact_id, contactName: row.contact_name, opportunityVersion: version, latestVersion: latest, canWrite: row.can_write };
}
function saved(row: SavedRow): SavedFinance { return { id: row.id, version: row.version, opportunityVersion: Number(row.opportunity_version), packet: row.packet, illustration: row.illustration, calculatedAt: new Date(row.calculated_at).toISOString(), savedAt: new Date(row.created_at).toISOString() }; }
export class PgFinanceRepository implements FinanceRepository {
  constructor(private readonly readPool: Pick<Pool, 'connect'>, private readonly commandPool: Pick<Pool, 'connect'>) {}
  async snapshot(context: DatabaseRequestContext, opportunityId: string, version?: number): Promise<FinanceSnapshot | null> {
    return withTransaction(this.readPool, context, async tx => {
      const current = await tx.query<SourceRow>(SOURCE_SQL, [opportunityId]);
      if (current.rows.length !== 1) return null;
      const currentSource = source(current.rows[0]!);
      if (!currentSource.canWrite) return { source: currentSource, versions: [] };
      const rows = await tx.query<SavedRow>(`/* finance.versions */ SELECT * FROM app.finance_planning_drafts
        WHERE workspace_id = app_private.current_workspace_id() AND opportunity_id = $1
        AND ($2::integer IS NULL OR version = $2) ORDER BY version DESC LIMIT 20`, [opportunityId, version ?? null]);
      if (version !== undefined && rows.rows.length !== 1) throw new FinanceError(404, 'That saved finance version is not available.');
      return { source: currentSource, versions: rows.rows.map(saved) };
    }, { readOnly: true, isolation: 'repeatable read' });
  }
  async save(context: DatabaseRequestContext, review: SignedReview): Promise<SavedFinance> {
    return withTransaction(this.commandPool, context, async (tx: PoolClient) => {
      // Serialize versions on the existing parent, after the active-session lock.
      const current = await tx.query<LockedSourceRow>(LOCKED_SOURCE_SQL, [review.opportunityId]);
      if (current.rows.length !== 1) throw new FinanceError(404, 'That opportunity is no longer available.');
      const owned = current.rows[0]!;
      if (owned.can_write !== true || owned.workspace_id !== review.workspaceId || owned.contact_id !== review.contactId) throw new FinanceError(403, 'This workspace no longer permits that finance save.');
      const opportunityVersion = Number(owned.row_version);
      if (!Number.isSafeInteger(opportunityVersion) || opportunityVersion < 1) throw new FinanceError(503, 'The opportunity version could not be read.');
      const hash = createHash('sha256').update(JSON.stringify(review)).digest();
      const prior = await tx.query<SavedRow>(`/* finance.replay */ SELECT * FROM app.finance_planning_drafts
        WHERE workspace_id = app_private.current_workspace_id() AND creator_user_id = app_private.current_user_id() AND review_nonce = $1`, [review.nonce]);
      if (prior.rows.length) {
        if (!prior.rows[0]!.review_hash.equals(hash)) throw new FinanceError(409, 'This save reference was already used for different figures.');
        return saved(prior.rows[0]!);
      }
      // A lock waiter needs a fresh statement to see versions committed while it waited.
      const latest = await tx.query<{ version: number }>(`/* finance.latest-locked */ SELECT COALESCE(max(version), 0) AS version FROM app.finance_planning_drafts WHERE workspace_id = app_private.current_workspace_id() AND opportunity_id = $1`, [review.opportunityId]);
      if (opportunityVersion !== review.opportunityVersion || Number(latest.rows[0]?.version) !== review.expectedLatestVersion) throw new FinanceError(409, 'This opportunity or its saved finance changed. Reopen and calculate a new review.');
      const result = await tx.query<SavedRow>(`/* finance.append */ INSERT INTO app.finance_planning_drafts
        (workspace_id, opportunity_id, contact_id, version, opportunity_version, creator_user_id, review_nonce, review_hash, packet, illustration, calculated_at)
        VALUES (app_private.current_workspace_id(), $1, $2, $3, $4, app_private.current_user_id(), $5, $6, $7::jsonb, $8::jsonb, $9::timestamptz) RETURNING *`,
        [review.opportunityId, review.contactId, review.expectedLatestVersion + 1, review.opportunityVersion, review.nonce, hash, JSON.stringify(review.packet), JSON.stringify(review.illustration), review.calculatedAt]);
      return saved(result.rows[0]!);
    });
  }
}
export function createPgFinanceDraftsService(input: { webPool: Pool; commandPool: Pool; secret: string }): FinanceDraftsService {
  const principal = createPgPortalCrmPrincipalResolver(input.webPool);
  return new FinanceDraftsService({
    secret: input.secret, client: createPlanningClient(), repository: new PgFinanceRepository(input.webPool, input.commandPool),
    async context(identity) { const resolved = await principal.resolve(identity.sessionToken); return resolved ? requestDatabaseContext({ ...resolved, requestId: identity.requestId, portalSessionTokenHash: createHash('sha256').update(identity.sessionToken).digest() }) : null; },
  });
}
