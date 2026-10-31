import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { PostgresPortalDeps } from './router.js';
import type { PortalSessionIdentity } from './auth-service.js';
import { portalCsrfToken, verifyPortalCsrf } from './session.js';
import { FOLLOWUP_EDITOR_SCRIPT } from '../followup-sequences/editor-client.js';
import { FLOW_FORM_DRAFT, FLOW_FORM_SAVED, readNativeFlowForm, sendNativeFlow } from '../followup-sequences/http.js';
import { FlowWorkspaceError } from '../followup-sequences/workspace.js';
import { FlowDraftValidationError } from '../followup-sequences/channel-drafts.js';
import { FollowupSequenceValidationError } from '../followup-sequences/definition.js';
import { FLOW_SIMULATION_CASES } from '../followup-sequences/simulation.js';
import { PP_FOLLOWUP_ROUTE as BASE, ppNewFlow, type PortalFollowupFlowService, type PortalFlowSaveInput } from './followup-flow-service.js';
import { renderPortalFlowPage, type PortalFlowPageInput } from './followup-flow-view.js';
export async function handlePortalFollowupFlow(req: IncomingMessage, res: ServerResponse, url: URL, input: {
  portal: PostgresPortalDeps; flows: Pick<PortalFollowupFlowService, 'snapshot' | 'review' | 'save' | 'publish' | 'preview' | 'simulate' | 'message'>;
  identity: PortalSessionIdentity | null; requestId: string;
}): Promise<boolean> {
  const path = url.pathname.replace(/\/+$/, ''); if (path !== BASE && !path.startsWith(`${BASE}/`)) return false;
  try {
    const { portal, flows, identity, requestId } = input;
    let origin: URL; try { origin = new URL(portal.portalBaseUrl ?? ''); } catch { throw new FlowWorkspaceError(503, 'The native PP workspace address is unavailable.'); }
    if (portal.productProfile?.id !== 'property_predator_growth' || origin.protocol !== 'https:' || req.headers.host?.toLowerCase() !== origin.host.toLowerCase()) throw new FlowWorkspaceError(404, 'This flow workspace is not available on this host.');
    if (!identity) { res.writeHead(303, { location: '/portal/login', 'cache-control': 'no-store' }); res.end(); return true; }
    const reading = path === BASE || path === `${BASE}/editor.js` || path === `${BASE}/message`, method = req.method ?? 'GET';
    if (method !== (reading ? 'GET' : 'POST')) throw new FlowWorkspaceError(405, 'Use the native flow controls.');
    const page = async (extra: Partial<PortalFlowPageInput> = {}) => renderPortalFlowPage({ snapshot: await flows.snapshot(identity, requestId), csrf: portalCsrfToken(portal.sessionSecret, identity.sessionToken), commandId: randomUUID(), ...extra });
    if (path === `${BASE}/editor.js`) {
      if (url.search) throw new FlowWorkspaceError(400, 'Use the native editor script.');
      sendNativeFlow(res, 200, FOLLOWUP_EDITOR_SCRIPT, 'text/javascript; charset=utf-8'); return true;
    }
    if (path === `${BASE}/message`) {
      if (url.searchParams.size !== 3 || [...url.searchParams.keys()].some(key => !['item', 'version', 'channel'].includes(key) || url.searchParams.getAll(key).length !== 1)
          || !['email', 'sms', 'whatsapp'].includes(url.searchParams.get('channel') ?? '')) throw new FlowWorkspaceError(400, 'Choose an exact local message.');
      const message = await flows.message(identity, requestId, url.searchParams.get('channel') as 'email' | 'sms' | 'whatsapp', url.searchParams.get('item')!, url.searchParams.get('version')!);
      sendNativeFlow(res, 200, JSON.stringify(message), 'application/json; charset=utf-8'); return true;
    }
    if (path === BASE) {
      if ([...url.searchParams.keys()].some(key => !['new', 'item', 'version'].includes(key) || url.searchParams.getAll(key).length !== 1)) throw new FlowWorkspaceError(400, 'Use one saved flow link.');
      const item = url.searchParams.get('item'), version = url.searchParams.get('version'), fresh = url.searchParams.get('new');
      if (Boolean(item) !== Boolean(version) || fresh !== null && fresh !== '1' || fresh && item) throw new FlowWorkspaceError(400, 'Use one saved flow link.');
      sendNativeFlow(res, 200, await page({ detail: item && version ? await flows.review(identity, requestId, item, version) : undefined,
        draft: fresh ? ppNewFlow(randomUUID()) : undefined }), 'text/html; charset=utf-8'); return true;
    }
    if (url.search || req.headers.origin !== origin.origin || req.headers['sec-fetch-site'] !== undefined && req.headers['sec-fetch-site'] !== 'same-origin') throw new FlowWorkspaceError(403, 'Refresh the native PP flow form.');
    const action = path.slice(BASE.length + 1), editing = ['save', 'preview', 'simulate'].includes(action);
    if (!editing && !['publish', 'start', 'enrol', 'entry-activate', 'resume'].includes(action)) throw new FlowWorkspaceError(404, 'This flow action is unavailable.');
    const fields = await readNativeFlowForm(req, editing ? FLOW_FORM_DRAFT : FLOW_FORM_SAVED, editing), field = (name: string) => fields.get(name) ?? '';
    if (!verifyPortalCsrf(portal.sessionSecret, identity.sessionToken, field('csrf'))) throw new FlowWorkspaceError(403, 'Refresh the PP flow form before continuing.');
    if (['start', 'enrol', 'entry-activate', 'resume'].includes(action)) { await flows.snapshot(identity, requestId); throw new FlowWorkspaceError(409, 'Your PP flow is saved. Connect and test delivery before starting it.'); }
    if (editing) {
      let definition: unknown, inlineMessages: unknown;
      try { definition = JSON.parse(field('definition')); if (fields.has('inlineMessages')) inlineMessages = JSON.parse(field('inlineMessages')); }
      catch { throw new FlowWorkspaceError(400, 'Check the flow and inline message drafts.'); }
      if (fields.has('simulationCase') && !(FLOW_SIMULATION_CASES as readonly string[]).includes(field('simulationCase'))) throw new FlowWorkspaceError(400, 'Choose a synthetic simulation scenario.');
      const draft: PortalFlowSaveInput = { commandId: field('commandId'), contentItemId: field('contentItemId'), previousVersionId: field('previousVersionId'), definition,
        ...(inlineMessages === undefined ? {} : { inlineMessages }) };
      if (action === 'save') { const saved = await flows.save(identity, requestId, draft, portal.now?.() ?? Date.now());
        res.writeHead(303, { location: `${BASE}?item=${encodeURIComponent(saved.contentItemId)}&version=${encodeURIComponent(saved.contentVersionId)}`, 'cache-control': 'no-store' }); res.end(); return true; }
      if (action === 'simulate') { const result = await flows.simulate(identity, requestId, definition, inlineMessages, field('simulationCase') || 'happy');
        sendNativeFlow(res, 200, await page({ draft, preview: result, simulation: result.simulation }), 'text/html; charset=utf-8'); return true; }
      sendNativeFlow(res, 200, await page({ draft, preview: await flows.preview(identity, requestId, definition, inlineMessages) }), 'text/html; charset=utf-8'); return true;
    }
    await flows.publish(identity, requestId, field('itemId'), field('versionId'), field('commandId'), portal.now?.() ?? Date.now());
    sendNativeFlow(res, 200, await page({ detail: await flows.review(identity, requestId, field('itemId'), field('versionId')),
      message: 'Your messages and flow are published. Nothing was connected, no one was added and nothing was sent.' }), 'text/html; charset=utf-8'); return true;
  } catch (error) {
    const known = error instanceof FlowWorkspaceError, validation = error instanceof FlowDraftValidationError || error instanceof FollowupSequenceValidationError;
    sendNativeFlow(res, known ? error.status : validation ? 400 : 503, known || validation ? error.message : 'PP flow controls are temporarily unavailable.'); return true;
  }
}
