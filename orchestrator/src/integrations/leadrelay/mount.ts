/** Reuses the reviewed LeadRelay bridge and the canonical portal identity.
 * No default grants: installation bindings are deployment-owned, never browser input.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { ALL_ACTIONS, createNodeHandler, loadInstallations } from './node-gateway.mjs';
import type { PortalSessionIdentity } from '../../portal/auth-service.js';
import { verifyPortalCsrf } from '../../portal/session.js';

export interface InstallationGrant {
  userId: string; workspaceId: string; installationId: string; actions: string[];
}
export function loadGrants(raw = '[]'): readonly InstallationGrant[] {
  const rows: unknown = JSON.parse(raw);
  if (!Array.isArray(rows) || rows.length > 200) throw new Error('Invalid installation grants');
  for (const row of rows) {
    if (!row || Object.keys(row).sort().join(',') !== 'actions,installationId,userId,workspaceId'
        || ![row.userId,row.workspaceId,row.installationId].every(v => typeof v === 'string' && v.length > 0 && v.length <= 100)
        || !Array.isArray(row.actions) || !row.actions.every((a: unknown) => typeof a === 'string' && ALL_ACTIONS.includes(a))) {
      throw new Error('Invalid installation grant');
    }
  }
  return rows;
}
export function installationActions(grants: readonly InstallationGrant[], identity: Pick<PortalSessionIdentity, 'userId' | 'workspaceId'>, id: string): string[] {
  return [...new Set(grants.filter(g => g.userId === identity.userId && g.workspaceId === identity.workspaceId && g.installationId === id).flatMap(g => g.actions))];
}
export const panelSource = readFileSync(new URL('./hq-panel.js', import.meta.url), 'utf8');
export const panelCss = readFileSync(new URL('./hq-panel.css', import.meta.url), 'utf8');
export const builderSource = readFileSync(new URL('./agent-builder.js', import.meta.url), 'utf8');
export const builderCss = readFileSync(new URL('./agent-builder.css', import.meta.url), 'utf8');
export const panelBoot = `import {mountLeadRelay} from '/portal/leadrelay/panel.js';
const root=document.getElementById('leadrelay-panel');
mountLeadRelay(root,{apiBase:'/portal/api/leadrelay',csrfToken:()=>root.dataset.csrf});`;

export async function handleLeadRelay(req: IncomingMessage, res: ServerResponse, identity: PortalSessionIdentity | null, sessionToken: string, sessionSecret: string): Promise<boolean> {
  const path = new URL(req.url ?? '/', 'https://hq.invalid').pathname;
  if (!path.startsWith('/portal/api/leadrelay')) return false;
  // Setup-only read of the canonical resolved session. No registry or grant is
  // consulted or created, and browser identity headers/query fields are ignored.
  if (path === '/portal/api/leadrelay/identity') {
    const status = !identity ? 401 : req.method !== 'GET' ? 405 : 200;
    res.writeHead(status, {
      'content-type':'application/json; charset=utf-8',
      'cache-control':'no-store',
      'x-content-type-options':'nosniff',
      ...(status === 405 ? {allow:'GET'} : {}),
    });
    res.end(JSON.stringify(status === 200
      ? {userId:identity!.userId, workspaceId:identity!.workspaceId}
      : {detail:status === 401 ? 'Sign in to Growth HQ' : 'Read-only setup endpoint'}));
    return true;
  }
  // Construct only on this route: absent bindings do not break unrelated HQ pages.
  const installations = loadInstallations();
  const grants = loadGrants(process.env.LEADRELAY_GRANTS_JSON);
  const handler = createNodeHandler({installations, apiBase:'/portal/api/leadrelay',
    authenticate: async () => identity,
    authorize: async (who, id) => installationActions(grants, who, id),
    verifyCsrf: async (_who, request) => {
      const token = request.headers['x-csrf-token'];
      return typeof token === 'string' && verifyPortalCsrf(sessionSecret, sessionToken, token);
    },
  });
  return handler(req, res);
}
