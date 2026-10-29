import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Pool } from 'pg';
import { requestDatabaseContext } from '../../db/rls.js';
import { withTransaction } from '../../db/transaction.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CURSOR_TIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/u;
const PATH = '/api/group-hq/crm/leads';
const PAGE_SIZE = 50;

export interface GroupHqCrmConfig {
  token: string;
  workspaceId: string;
  organizationId: string;
  ownerUserId: string;
}

export function loadGroupHqCrmConfig(env: NodeJS.ProcessEnv): GroupHqCrmConfig | undefined {
  const token = env.R72_GROUP_HQ_CRM_TOKEN?.trim() ?? '';
  const workspaceId = env.R72_GROUP_HQ_CRM_PP_WORKSPACE_ID?.trim() ?? '';
  const organizationId = env.R72_GROUP_HQ_CRM_PP_ORGANIZATION_ID?.trim() ?? '';
  const ownerUserId = env.R72_GROUP_HQ_CRM_OWNER_USER_ID?.trim() ?? '';
  if (!token && !workspaceId && !organizationId && !ownerUserId) return undefined;
  if (env.PORTAL_PRODUCT_PROFILE?.trim() !== 'property_predator_growth'
      || token.length < 32 || token.length > 256 || !UUID.test(workspaceId)
      || !UUID.test(organizationId) || !UUID.test(ownerUserId)) {
    throw new Error('Group HQ CRM read boundary is incomplete or outside the Property Predator profile');
  }
  return { token, workspaceId: workspaceId.toLowerCase(), organizationId: organizationId.toLowerCase(), ownerUserId: ownerUserId.toLowerCase() };
}

function reply(res: ServerResponse, status: number, body: unknown): void {
  const value = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(value),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(value);
}

function authorised(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const presented = Buffer.from(header.slice(7), 'utf8');
  const expected = Buffer.from(token, 'utf8');
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

interface PageCursor { updatedAt: string; id: string }

function decodeCursor(value: string | null): PageCursor | null {
  if (value === null) return null;
  if (value.length < 4 || value.length > 256 || !/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error('invalid cursor');
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')); }
  catch { throw new Error('invalid cursor'); }
  if (!parsed || typeof parsed !== 'object') throw new Error('invalid cursor');
  const row = parsed as Record<string, unknown>;
  if (typeof row.updatedAt !== 'string' || !CURSOR_TIME.test(row.updatedAt)
      || !Number.isFinite(Date.parse(row.updatedAt)) || typeof row.id !== 'string' || !UUID.test(row.id)) {
    throw new Error('invalid cursor');
  }
  return { updatedAt: row.updatedAt, id: row.id.toLowerCase() };
}

interface LeadRow {
  id: string;
  display_name: string;
  source: string | null;
  lifecycle_status: string;
  stage_name: string | null;
  next_task_at: Date | null;
  last_activity_at: Date | null;
  owner_user_id: string | null;
  updated_at: Date;
  cursor_updated_at: string;
}

export function createGroupHqCrmReadMount(pool: Pick<Pool, 'connect'>, config: GroupHqCrmConfig) {
  return {
    async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
      if (url.pathname !== PATH || req.method !== 'GET') { reply(res, 404, { error: 'not found' }); return; }
      if (!authorised(req, config.token)) { reply(res, 401, { error: 'unauthorised' }); return; }
      if (url.searchParams.get('brand') !== 'pp'
          || [...url.searchParams.keys()].some(key => key !== 'brand' && key !== 'cursor')
          || url.searchParams.getAll('brand').length !== 1 || url.searchParams.getAll('cursor').length > 1) {
        reply(res, 400, { error: 'invalid request' }); return;
      }
      let cursor: PageCursor | null;
      try { cursor = decodeCursor(url.searchParams.get('cursor')); }
      catch { reply(res, 400, { error: 'invalid cursor' }); return; }
      try {
        const context = requestDatabaseContext({
          workspaceId: config.workspaceId, userId: config.ownerUserId, requestId: randomUUID(),
        });
        const page = await withTransaction(pool, context, async tx => {
          const allowed = await tx.query<{ allowed: boolean }>(
            `SELECT app_private.can_manage_workspace($1::uuid, $2::uuid)
              AND EXISTS (SELECT 1 FROM app.workspaces w JOIN app.organizations o
                ON o.id=w.organization_id WHERE w.id=$2::uuid AND o.id=$3::uuid) AS allowed`,
            [config.ownerUserId, config.workspaceId, config.organizationId],
          );
          if (allowed.rows[0]?.allowed !== true) return null;
          const result = await tx.query<LeadRow>(`/* group-hq.crm.pp-leads */
            SELECT c.id, c.display_name, c.source, c.lifecycle_status, c.owner_user_id, c.updated_at,
              to_char(c.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_updated_at,
              (SELECT s.name FROM app.opportunities o JOIN app.pipeline_stages s
                ON s.workspace_id=o.workspace_id AND s.id=o.stage_id
                WHERE o.workspace_id=c.workspace_id AND o.contact_id=c.id AND o.status='open'
                ORDER BY o.updated_at DESC, o.id DESC LIMIT 1) AS stage_name,
              (SELECT min(t.due_at) FROM app.tasks t WHERE t.workspace_id=c.workspace_id
                AND t.contact_id=c.id AND t.status='open') AS next_task_at,
              (SELECT max(a.occurred_at) FROM app.activities a WHERE a.workspace_id=c.workspace_id
                AND a.contact_id=c.id) AS last_activity_at
            FROM app.contacts c
            WHERE c.workspace_id=$1::uuid AND c.deleted_at IS NULL
              AND ($2::timestamptz IS NULL OR (c.updated_at,c.id)<($2::timestamptz,$3::uuid))
            ORDER BY c.updated_at DESC,c.id DESC LIMIT $4`,
            [config.workspaceId, cursor?.updatedAt ?? null, cursor?.id ?? null, PAGE_SIZE + 1]);
          const rows = result.rows.slice(0, PAGE_SIZE);
          const last = rows.at(-1);
          return {
            brand: 'pp', workspace: 'Property Predator',
            leads: rows.map(row => ({
              id: row.id, name: row.display_name, source: row.source,
              lifecycle: row.lifecycle_status, stage: row.stage_name,
              nextTaskAt: row.next_task_at?.toISOString() ?? null,
              lastActivityAt: row.last_activity_at?.toISOString() ?? null,
              ownerUserId: row.owner_user_id,
              updatedAt: row.updated_at.toISOString(),
            })),
            nextCursor: result.rows.length > PAGE_SIZE && last
              ? Buffer.from(JSON.stringify({ updatedAt: last.cursor_updated_at, id: last.id })).toString('base64url')
              : null,
          };
        }, { readOnly: true });
        if (!page) { reply(res, 403, { error: 'forbidden' }); return; }
        reply(res, 200, page);
      } catch {
        reply(res, 503, { error: 'temporarily unavailable' });
      }
    },
  };
}
