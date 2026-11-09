import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Pool } from 'pg';
import { requestDatabaseContext } from '../../db/rls.js';
import { withTransaction } from '../../db/transaction.js';
import { PORTAL_LIVE_CHANNEL_BLOCKER_CODES } from '../../portal/live-channel-truth-service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CURSOR_TIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/u;
const PATH = '/api/group-hq/crm/leads';
const WHATSAPP_PATH = '/api/group-hq/channels/whatsapp';
const PAGE_SIZE = 50;

export interface GroupHqCrmConfig {
  token: string;
  workspaceId: string;
  organizationId: string;
  ownerUserId: string;
  mhp?: { workspaceId: string; organizationId: string };
}

export function loadGroupHqCrmConfig(env: NodeJS.ProcessEnv): GroupHqCrmConfig | undefined {
  const token = env.R72_GROUP_HQ_CRM_TOKEN?.trim() ?? '';
  const workspaceId = env.R72_GROUP_HQ_CRM_PP_WORKSPACE_ID?.trim() ?? '';
  const organizationId = env.R72_GROUP_HQ_CRM_PP_ORGANIZATION_ID?.trim() ?? '';
  const ownerUserId = env.R72_GROUP_HQ_CRM_OWNER_USER_ID?.trim() ?? '';
  const mhpWorkspaceId = env.R72_GROUP_HQ_CRM_MHP_WORKSPACE_ID?.trim() ?? '';
  const mhpOrganizationId = env.R72_GROUP_HQ_CRM_MHP_ORGANIZATION_ID?.trim() ?? '';
  if (!token && !workspaceId && !organizationId && !ownerUserId && !mhpWorkspaceId && !mhpOrganizationId) return undefined;
  if (env.PORTAL_PRODUCT_PROFILE?.trim() !== 'property_predator_growth'
      || token.length < 32 || token.length > 256 || !UUID.test(workspaceId)
      || !UUID.test(organizationId) || !UUID.test(ownerUserId)) {
    throw new Error('Group HQ CRM read boundary is incomplete or outside the Property Predator profile');
  }
  if ((mhpWorkspaceId || mhpOrganizationId) && (!UUID.test(mhpWorkspaceId) || !UUID.test(mhpOrganizationId)
      || mhpWorkspaceId.toLowerCase() === workspaceId.toLowerCase()
      || mhpOrganizationId.toLowerCase() === organizationId.toLowerCase())) {
    throw new Error('Group HQ MHP workspace mapping is incomplete or overlaps Property Predator');
  }
  return { token, workspaceId: workspaceId.toLowerCase(), organizationId: organizationId.toLowerCase(), ownerUserId: ownerUserId.toLowerCase(),
    ...(mhpWorkspaceId ? { mhp: { workspaceId: mhpWorkspaceId.toLowerCase(), organizationId: mhpOrganizationId.toLowerCase() } } : {}) };
}

const CONNECTIONS = new Set(['not_configured', 'configured', 'ready', 'degraded', 'revoked', 'not_composed']);
const INBOUND = new Set(['not_supported', 'not_ready', 'ready', 'degraded']);
const OUTBOUND = new Set(['not_supported', 'effects_disabled', 'blocked', 'approval_required', 'ready', 'cap_reached']);
const RECEIPTS = new Set(['none', 'pending', 'healthy', 'needs_attention', 'outcome_unknown']);
const BLOCKERS = new Set<string>(PORTAL_LIVE_CHANNEL_BLOCKER_CODES);

async function whatsappStatus(pool: Pick<Pool, 'connect'>, config: GroupHqCrmConfig, brand: 'pp' | 'mhp') {
  const mapping = brand === 'pp' ? config : config.mhp;
  if (!mapping) return { brand, channel: 'whatsapp', availability: 'not_connected' };
  const context = requestDatabaseContext({ workspaceId: mapping.workspaceId, userId: config.ownerUserId, requestId: randomUUID() });
  return withTransaction(pool, context, async tx => {
    const allowed = await tx.query<{ allowed: boolean }>(
      `SELECT app_private.can_manage_workspace($1::uuid, $2::uuid)
        AND EXISTS (SELECT 1 FROM app.workspaces w JOIN app.organizations o
          ON o.id=w.organization_id WHERE w.id=$2::uuid AND o.id=$3::uuid) AS allowed`,
      [config.ownerUserId, mapping.workspaceId, mapping.organizationId],
    );
    if (allowed.rows[0]?.allowed !== true) return null;
    const result = await tx.query(`/* group-hq.whatsapp.readiness */
      SELECT snapshot_at, connection_state, inbound_state, outbound_or_reply_state,
        receipt_state, blocker_codes, latest_receipt_at
      FROM app_private.property_predator_live_channel_truth() WHERE rail='whatsapp'`);
    const row = result.rows[0];
    const snapshotAt = row?.snapshot_at instanceof Date ? row.snapshot_at.toISOString() : null;
    const receiptAt = row?.latest_receipt_at instanceof Date ? row.latest_receipt_at.toISOString() : null;
    if (result.rows.length !== 1 || !snapshotAt || !CONNECTIONS.has(row.connection_state)
        || !INBOUND.has(row.inbound_state) || !OUTBOUND.has(row.outbound_or_reply_state)
        || !RECEIPTS.has(row.receipt_state) || !Array.isArray(row.blocker_codes)
        || row.blocker_codes.length > BLOCKERS.size || row.blocker_codes.some((code: unknown) => typeof code !== 'string' || !BLOCKERS.has(code))
        || (row.latest_receipt_at !== null && !receiptAt)) throw new Error('Invalid WhatsApp status');
    return { brand, channel: 'whatsapp', availability: 'available', snapshotAt,
      connectionState: row.connection_state, inboundState: row.inbound_state,
      outboundState: row.outbound_or_reply_state, receiptState: row.receipt_state,
      blockerCodes: [...new Set(row.blocker_codes)], lastReceiptAt: receiptAt };
  }, { readOnly: true });
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
      if (![PATH, WHATSAPP_PATH].includes(url.pathname) || req.method !== 'GET') { reply(res, 404, { error: 'not found' }); return; }
      if (!authorised(req, config.token)) { reply(res, 401, { error: 'unauthorised' }); return; }
      if (url.pathname === WHATSAPP_PATH) {
        const brand = url.searchParams.get('brand');
        if ((brand !== 'pp' && brand !== 'mhp') || url.searchParams.getAll('brand').length !== 1
            || [...url.searchParams.keys()].some(key => key !== 'brand')) {
          reply(res, 400, { error: 'invalid request' }); return;
        }
        try {
          const status = await whatsappStatus(pool, config, brand);
          reply(res, status ? 200 : 403, status ?? { error: 'forbidden' });
        } catch { reply(res, 503, { error: 'temporarily unavailable' }); }
        return;
      }
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
