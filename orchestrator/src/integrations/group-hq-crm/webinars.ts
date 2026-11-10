/**
 * Founder-only webinar listing for Group HQ's Webinars section.
 *
 * GET /api/group-hq/webinars?brand=pp|mhp with the same bearer token as the CRM read
 * bridge. Reads run under the configured owner's own RLS context on the content
 * identity, read-only, and only if that owner can manage the brand workspace; the
 * response carries portal paths (manage, host, studio) and the public registration
 * link, never tokens, secrets or attendee data.
 */

import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Pool } from 'pg';
import { requestDatabaseContext } from '../../db/rls.js';
import { withTransaction } from '../../db/transaction.js';
import { publicOriginFor, type WebinarConfig } from '../../webinars/config.js';
import { readProfile } from '../../webinars/service.js';
import type { GroupHqCrmConfig } from './read.js';

export const GROUP_HQ_WEBINARS_PATH = '/api/group-hq/webinars';
const KINDS = new Set(['live', 'on_demand', 'scheduled_recording']);
const STATUSES = new Set(['draft', 'published', 'cancelled', 'archived']);
const SESSIONS = new Set(['idle', 'live', 'ended']);

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

interface EventRow {
  id: string;
  public_key: string;
  kind: string;
  status: string;
  title: string;
  starts_at: Date | null;
  timezone: string;
  duration_minutes: number | null;
  session_state: string | null;
  registered: string | number;
  crm_linked: string | number;
  updated_at: Date;
}

export interface GroupHqWebinarSummary {
  readonly id: string;
  readonly title: string;
  readonly kind: string;
  readonly status: string;
  readonly startsAt: string | null;
  readonly timezone: string;
  readonly durationMinutes: number | null;
  readonly sessionState: string;
  readonly registered: number;
  readonly crmLinked: number;
  readonly updatedAt: string;
  /** Public registration page, when this brand has a public origin configured. */
  readonly publicUrl: string | null;
  /** Portal paths on the brand host; Group HQ opens them through the sign-in handoff. */
  readonly paths: { readonly manage: string; readonly host: string; readonly studio: string; readonly people: string };
}

export function createGroupHqWebinarsReadMount(pool: Pick<Pool, 'connect'>, config: GroupHqCrmConfig, webinarConfig: WebinarConfig | null) {
  async function list(brand: 'pp' | 'mhp') {
    const mapping = brand === 'pp' ? config : config.mhp;
    if (!mapping) return { brand, availability: 'not_connected' as const };
    const context = requestDatabaseContext({ workspaceId: mapping.workspaceId, userId: config.ownerUserId, requestId: randomUUID() });
    return withTransaction(pool, context, async (tx) => {
      // The content identity sees workspaces only through the webinar profile definer:
      // it answers for the request's workspace and says whether this user can manage it.
      const profile = await readProfile(tx);
      if (!profile || !profile.canManage || profile.workspaceId !== mapping.workspaceId) return { brand, availability: 'not_available' as const };
      const r = await tx.query<EventRow>(`/* group-hq.webinars.list */
        SELECT e.id, e.public_key, e.kind, e.status, e.title, e.starts_at, e.timezone, e.duration_minutes, e.session_state, e.updated_at,
          (SELECT count(*) FROM app.webinar_registrations g WHERE g.workspace_id = e.workspace_id AND g.event_id = e.id AND g.status = 'registered') AS registered,
          (SELECT count(*) FROM app.webinar_registrations g WHERE g.workspace_id = e.workspace_id AND g.event_id = e.id AND g.crm_contact_id IS NOT NULL) AS crm_linked
        FROM app.webinar_events e
        WHERE e.workspace_id = app_private.current_workspace_id() AND e.status <> 'archived'
        ORDER BY (e.status = 'published') DESC, e.starts_at DESC NULLS LAST, e.updated_at DESC
        LIMIT 100`);
      const origin = webinarConfig ? publicOriginFor(webinarConfig, mapping.workspaceId) : null;
      const webinars: GroupHqWebinarSummary[] = r.rows.map((row) => {
        if (!KINDS.has(row.kind) || !STATUSES.has(row.status) || !/^[a-z0-9][a-z0-9-]{2,70}[a-z0-9]$/.test(row.public_key)) throw new Error('Invalid webinar row');
        const base = `/portal/webinars/${row.id}`;
        return Object.freeze({
          id: row.id, title: String(row.title).slice(0, 200), kind: row.kind, status: row.status,
          startsAt: row.starts_at instanceof Date ? row.starts_at.toISOString() : null,
          timezone: String(row.timezone), durationMinutes: row.duration_minutes === null ? null : Number(row.duration_minutes),
          sessionState: SESSIONS.has(row.session_state ?? '') ? String(row.session_state) : 'idle',
          registered: Number(row.registered), crmLinked: Number(row.crm_linked),
          updatedAt: row.updated_at.toISOString(),
          publicUrl: origin ? `${origin}/w/${row.public_key}` : null,
          paths: Object.freeze({ manage: base, host: `${base}/host`, studio: `${base}/studio`, people: `${base}/people` }),
        });
      });
      return { brand, availability: 'available' as const, workspace: { id: profile.workspaceId, name: profile.name, timezone: profile.timezone }, webinars };
    }, { readOnly: true });
  }

  return {
    async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
      if (url.pathname !== GROUP_HQ_WEBINARS_PATH || req.method !== 'GET') { reply(res, 404, { error: 'not found' }); return; }
      if (!authorised(req, config.token)) { reply(res, 401, { error: 'unauthorised' }); return; }
      const brand = url.searchParams.get('brand');
      if ((brand !== 'pp' && brand !== 'mhp') || url.searchParams.getAll('brand').length !== 1
          || [...url.searchParams.keys()].some((key) => key !== 'brand')) {
        reply(res, 400, { error: 'invalid request' }); return;
      }
      reply(res, 200, await list(brand));
    },
  };
}
