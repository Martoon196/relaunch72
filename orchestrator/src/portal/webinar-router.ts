/**
 * HTTP surface for /portal/webinars/… inside the existing portal.
 *
 * Identity comes from the portal session; webinar ids in the path are selectors
 * only — PostgreSQL re-locks the session and RLS limits every row to the
 * session's workspace for owners/admins. POSTs require the portal CSRF token.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { PortalSessionIdentity } from './auth-service.js';
import { portalCsrfToken, verifyPortalCsrf } from './session.js';
import {
  WEBINARS_ASSET, WEBINARS_BASE, WEBINARS_STUDIO_ASSET, WEBINARS_STUDIO_TICK_ASSET, detailsTab, eventFrame, hostTab, listPage, messagesTab, newPage, peopleTab, questionsTab, resultsTab,
  studioTab, unavailablePage, videoTab, type SetupStatus, type WebinarTab,
} from './webinar-view.js';
import { PORTAL_WEBINAR_SCRIPT, STUDIO_SCRIPT, STUDIO_TICK_SCRIPT } from '../webinars/client-scripts.js';
import { STUDIO_WS_ROUTE, type StudioRelay } from '../webinars/studio.js';
import { publicOriginFor } from '../webinars/config.js';
import { PUBLIC_PREVIEW_CSP, registrationPage } from '../webinars/public-view.js';
import { computeRoomState } from '../webinars/schedule.js';
import { WebinarError, type PgWebinarService, type WebinarEditInput } from '../webinars/service.js';
import { DEFAULT_SETTINGS, readSettings, type WebinarKind, type WebinarSettings } from '../webinars/types.js';
import { hlsAsset } from '../webinars/public-router.js';

export interface WebinarRouteInput {
  readonly service: PgWebinarService | undefined;
  readonly setup: Omit<SetupStatus, 'workspaceId'>;
  readonly identity: PortalSessionIdentity | null;
  /** Signed in at all (legacy sandbox sessions have no PostgreSQL identity). */
  readonly authenticated: boolean;
  readonly requestId: string;
  readonly sessionSecret: string;
  /** Browser-studio relay on this instance (absent when not composed). */
  readonly studio?: StudioRelay;
  /** Wraps a body in the standard portal shell with the Webinars menu item current. */
  readonly shell: (title: string, workspaceName: string, body: string, csrf: string) => string;
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const EVENT_PATH = new RegExp(`^${WEBINARS_BASE}/(${UUID})(?:/([a-z0-9./-]{1,80}))?$`, 'i');
const PAGE_CSP = "default-src 'none'; script-src 'self'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; "
  + "media-src 'self' blob: https://*.cloudflarestream.com https://*.videodelivery.net; connect-src 'self' https://*.cloudflarestream.com https://*.videodelivery.net; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

function send(res: ServerResponse, status: number, body: string, type = 'text/html; charset=utf-8', extra: Record<string, string> = {}): void {
  res.writeHead(status, {
    'content-type': type, 'content-length': String(Buffer.byteLength(body)), 'cache-control': 'no-store', 'referrer-policy': 'same-origin',
    'x-content-type-options': 'nosniff', 'x-robots-tag': 'noindex, nofollow', 'content-security-policy': PAGE_CSP, ...extra,
  });
  res.end(body);
}

function json(res: ServerResponse, status: number, value: unknown): void {
  send(res, status, JSON.stringify(value), 'application/json; charset=utf-8');
}

function redirect(res: ServerResponse, location: string): void {
  res.writeHead(303, { location, 'cache-control': 'no-store' });
  res.end();
}

function signed(secret: string, kind: 'n' | 'e', text: string): string {
  const m = Buffer.from(text.slice(0, 400)).toString('base64url');
  const s = createHmac('sha256', secret).update(`webinars:${kind}:${m}`).digest('base64url').slice(0, 22);
  return `${kind}=${m}&s=${s}`;
}

function readSigned(secret: string, url: URL): { notice: string | null; error: string | null } {
  const sig = url.searchParams.get('s') ?? '';
  for (const kind of ['n', 'e'] as const) {
    const m = url.searchParams.get(kind);
    if (!m) continue;
    const expected = createHmac('sha256', secret).update(`webinars:${kind}:${m}`).digest('base64url').slice(0, 22);
    if (sig.length === expected.length && timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
      const text = Buffer.from(m, 'base64url').toString('utf8');
      return kind === 'n' ? { notice: text, error: null } : { notice: null, error: text };
    }
  }
  return { notice: null, error: null };
}

async function readBody(req: IncomingMessage, max = 64 * 1024): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > max) throw new WebinarError(413, 'That form is too large.');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  const type = String(req.headers['content-type'] ?? '');
  if (!type.startsWith('application/x-www-form-urlencoded')) throw new WebinarError(415, 'Unsupported form submission.');
  const params = new URLSearchParams(await readBody(req));
  for (const key of new Set(params.keys())) if (params.getAll(key).length > 1) throw new WebinarError(400, 'Duplicate form field.');
  return params;
}

function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true; // older browsers omit Origin on same-origin form posts; CSRF token still required
  try {
    return new URL(origin).host === String(req.headers.host ?? '');
  } catch {
    return false;
  }
}

function parseQuestions(raw: string): unknown[] {
  return raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 5).map((line) => {
    const [head, opts] = line.split('|', 2) as [string, string | undefined];
    const required = /\*\s*$/.test(head);
    const label = head.replace(/\*\s*$/, '').trim();
    const options = (opts ?? '').split(',').map((o) => o.trim()).filter(Boolean);
    return { label, required, type: options.length >= 2 ? 'select' : 'text', options };
  });
}

function settingsFromForm(f: URLSearchParams): WebinarSettings {
  const num = (k: string) => { const v = (f.get(k) ?? '').trim(); return v === '' ? null : Number(v); };
  const ctaLabel = (f.get('ctaLabel') ?? '').trim();
  const ctaUrl = (f.get('ctaUrl') ?? '').trim();
  if ((ctaLabel && !ctaUrl) || (!ctaLabel && ctaUrl)) throw new WebinarError(400, 'A call to action needs both button text and a destination.');
  if (ctaUrl && !/^https:\/\/[^\s/?#]+/.test(ctaUrl)) throw new WebinarError(400, 'The call-to-action destination must be an https:// link.');
  const ctaMode = f.get('ctaMode') === 'timed' ? 'timed' : 'manual';
  const atMinutes = num('ctaAtMinutes');
  if (ctaLabel && ctaMode === 'timed' && (atMinutes === null || !Number.isInteger(atMinutes) || atMinutes < 0)) throw new WebinarError(400, 'Set how many minutes into the session the call to action appears.');
  const privacy = (f.get('privacyUrl') ?? '').trim();
  if (privacy && !/^https:\/\/[^\s/?#]+/.test(privacy)) throw new WebinarError(400, 'The privacy policy link must be an https:// link.');
  const reminders = (f.get('reminders') ?? '').split(',').map((s) => s.trim()).filter(Boolean).map(Number);
  if (reminders.some((n) => !Number.isInteger(n) || n < 5 || n > 10_080)) throw new WebinarError(400, 'Reminders must be whole minutes between 5 and 10080.');
  const days = num('replayDays');
  return readSettings({
    questions: parseQuestions(f.get('questions') ?? ''),
    serviceNotice: f.get('serviceNotice') ?? DEFAULT_SETTINGS.serviceNotice,
    marketingConsentText: f.get('marketingConsentText') ?? '',
    consentVersion: f.get('consentVersion') ?? DEFAULT_SETTINGS.consentVersion,
    privacyUrl: privacy,
    cta: ctaLabel ? { label: ctaLabel, url: ctaUrl, body: f.get('ctaBody') ?? '', mode: ctaMode, atSeconds: ctaMode === 'timed' ? (atMinutes ?? 0) * 60 : null } : null,
    replay: { enabled: f.get('replayEnabled') === '1', availableDays: days === null ? null : days },
    reminderOffsetsMinutes: reminders,
    roomOpensMinutesBefore: num('roomOpens') ?? DEFAULT_SETTINGS.roomOpensMinutesBefore,
    questionsEnabled: f.get('questionsEnabled') === '1',
    questionsModerated: f.get('questionsModerated') === '1',
    accentColor: f.get('accentColor') ?? '',
    crmOpportunityPrefix: f.get('crmPrefix') ?? '',
  });
}

function editFromForm(f: URLSearchParams): WebinarEditInput {
  const capacity = (f.get('capacity') ?? '').trim();
  return {
    kind: (f.get('kind') ?? 'live') as WebinarKind,
    title: f.get('title') ?? '',
    summary: (f.get('summary') ?? '').slice(0, 4000),
    presenterName: (f.get('presenterName') ?? '').trim().slice(0, 120),
    presenterTitle: (f.get('presenterTitle') ?? '').trim().slice(0, 160),
    timezone: f.get('timezone') ?? 'Europe/London',
    startsLocal: (f.get('startsLocal') ?? '').trim(),
    durationMinutes: Number(f.get('durationMinutes') ?? 60),
    capacity: capacity === '' ? null : Number(capacity),
    settings: settingsFromForm(f),
  };
}

function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** Returns true when the request was handled. */
export async function handleWebinars(req: IncomingMessage, res: ServerResponse, url: URL, input: WebinarRouteInput): Promise<boolean> {
  const p = url.pathname.replace(/\/+$/, '') || '/';
  if (p !== WEBINARS_BASE && !p.startsWith(`${WEBINARS_BASE}/`)) return false;
  const method = req.method ?? 'GET';

  // Static script for these pages (CSP script-src 'self').
  if (p === WEBINARS_ASSET && method === 'GET') {
    send(res, 200, PORTAL_WEBINAR_SCRIPT, 'text/javascript; charset=utf-8', { 'cache-control': 'private, max-age=300' });
    return true;
  }
  if ((p === WEBINARS_STUDIO_ASSET || p === WEBINARS_STUDIO_TICK_ASSET) && method === 'GET') {
    send(res, 200, p === WEBINARS_STUDIO_ASSET ? STUDIO_SCRIPT : STUDIO_TICK_SCRIPT, 'text/javascript; charset=utf-8', { 'cache-control': 'private, max-age=300' });
    return true;
  }
  if (p === `${WEBINARS_BASE}/_assets/hls.js` && method === 'GET') {
    const asset = await hlsAsset();
    if (!asset) { send(res, 404, 'Not found', 'text/plain; charset=utf-8'); return true; }
    send(res, 200, asset, 'text/javascript; charset=utf-8', { 'cache-control': 'private, max-age=86400' });
    return true;
  }

  if (!input.authenticated) { redirect(res, '/portal/login'); return true; }
  const service = input.service;
  const identity = input.identity;
  if (!service || !identity) {
    // Honest setup state for any signed-in user: names what enables the feature, never a 404.
    const csrfAny = identity ? portalCsrfToken(input.sessionSecret, identity.sessionToken) : '';
    send(res, 200, input.shell('Webinars', 'Your workspace', unavailablePage({ ...input.setup, workspaceId: identity?.workspaceId ?? null }), csrfAny));
    return true;
  }
  const csrf = portalCsrfToken(input.sessionSecret, identity.sessionToken);
  const setup: SetupStatus = { ...input.setup, workspaceId: identity.workspaceId };
  const { notice, error } = readSigned(input.sessionSecret, url);
  const back = (path: string, kind: 'n' | 'e', text: string) => redirect(res, `${path}?${signed(input.sessionSecret, kind, text)}`);

  try {
    if (method === 'POST') {
      const isJson = String(req.headers['content-type'] ?? '').startsWith('application/json');
      if (!sameOrigin(req)) throw new WebinarError(403, 'Cross-site request refused.');
      if (isJson) {
        if (!verifyPortalCsrf(input.sessionSecret, identity.sessionToken, String(req.headers['x-csrf-token'] ?? ''))) throw new WebinarError(403, 'Your session form token expired. Reload the page.');
      }
    }

    // List + create.
    if (p === WEBINARS_BASE && method === 'GET') {
      const { profile, webinars } = await service.list(identity, input.requestId);
      send(res, 200, input.shell('Webinars', profile.name, listPage({ profile, webinars, setup, notice, error }), csrf));
      return true;
    }
    if (p === `${WEBINARS_BASE}/new` && method === 'GET') {
      const profile = await service.profile(identity, input.requestId);
      if (!profile?.canManage) throw new WebinarError(403, 'Only a workspace owner or admin can manage webinars.');
      send(res, 200, input.shell('New webinar', profile.name, newPage({ profile, csrf, settings: DEFAULT_SETTINGS, error }), csrf));
      return true;
    }
    if (p === WEBINARS_BASE && method === 'POST') {
      const form = await readForm(req);
      if (!verifyPortalCsrf(input.sessionSecret, identity.sessionToken, form.get('_csrf') ?? undefined)) throw new WebinarError(403, 'Your session form token expired. Reload the page.');
      let edit: WebinarEditInput;
      try {
        edit = editFromForm(form);
        const id = await service.create(identity, input.requestId, edit);
        back(`${WEBINARS_BASE}/${id}`, 'n', 'Webinar created as a private draft.');
      } catch (err) {
        if (!(err instanceof WebinarError) || err.status !== 400) throw err;
        const profile = (await service.profile(identity, input.requestId))!;
        const values = Object.fromEntries(form.entries());
        send(res, 400, input.shell('New webinar', profile.name, newPage({ profile, csrf, settings: (() => { try { return settingsFromForm(form); } catch { return DEFAULT_SETTINGS; } })(), error: err.message, values }), csrf));
      }
      return true;
    }

    const m = EVENT_PATH.exec(p);
    if (!m) return false;
    const id = m[1]!.toLowerCase();
    const sub = (m[2] ?? '').toLowerCase();
    const base = `${WEBINARS_BASE}/${id}`;
    const questionMatch = /^questions\/([0-9a-f-]{36})$/.exec(sub);
    const tabFor = (s: string) => (s === 'session' || s === 'cta' ? 'host' : s === 'crm' ? 'people' : s.startsWith('questions') ? 'questions' : s === '' || s === 'status' ? '' : 'video');

    if (method === 'POST' && !String(req.headers['content-type'] ?? '').startsWith('application/json')) {
      const form = await readForm(req);
      if (!verifyPortalCsrf(input.sessionSecret, identity.sessionToken, form.get('_csrf') ?? undefined)) throw new WebinarError(403, 'Your session form token expired. Reload the page.');
      try {
        if (sub === '') {
          const result = await service.update(identity, input.requestId, id, Number(form.get('rowVersion')), editFromForm(form));
          back(base, 'n', result.rescheduled ? 'Saved. Registrants will be told about the new time and their reminders were replaced.' : 'Saved.');
          return true;
        }
        if (sub === 'status') {
          const action = form.get('action');
          if (action !== 'publish' && action !== 'unpublish' && action !== 'cancel' && action !== 'archive') throw new WebinarError(400, 'Unknown action.');
          await service.setStatus(identity, input.requestId, id, action);
          if (action === 'archive') { back(WEBINARS_BASE, 'n', 'Webinar archived.'); return true; }
          back(base, 'n', { publish: 'Published. Share the public registration link.', unpublish: 'Returned to draft.', cancel: 'Cancelled. Registrants are being told.' }[action]);
          return true;
        }
        if (sub === 'live-input') {
          await service.provisionLiveInput(identity, input.requestId, id);
          back(`${base}/video`, 'n', 'Live input request finished. See the result below.');
          return true;
        }
        if (sub === 'live-input/reconcile') {
          back(`${base}/video`, 'n', await service.reconcileLiveInput(identity, input.requestId, id));
          return true;
        }
        if (sub === 'live-input/credentials') {
          const got = await service.get(identity, input.requestId, id);
          const credentials = await service.liveCredentials(identity, input.requestId, id);
          const body = eventFrame({ profile: got.profile, event: got.event, counts: got.counts, tab: 'video', csrf, publicUrl: publicUrl(service, got.event), notice: null, error: null,
            body: videoTab({ event: got.event, csrf, setup, credentials, provisionState: await service.provisionState(identity, input.requestId, id) }) });
          send(res, 200, input.shell(got.event.title, got.profile.name, body, csrf));
          return true;
        }
        if (sub === 'session') {
          const action = form.get('action');
          if (action === 'start') await service.startSession(identity, input.requestId, id);
          else if (action === 'end') await service.endSession(identity, input.requestId, id);
          else throw new WebinarError(400, 'Unknown action.');
          back(`${base}/${form.get('return') === 'studio' ? 'studio' : 'host'}`, 'n', action === 'start' ? 'You are live. Attendees now see the broadcast.' : 'Session ended. The replay appears once Cloudflare finishes processing the recording.');
          return true;
        }
        if (sub === 'cta') {
          await service.setCta(identity, input.requestId, id, form.get('action') === 'reveal');
          back(`${base}/host`, 'n', form.get('action') === 'reveal' ? 'Call to action shown to attendees.' : 'Call to action hidden.');
          return true;
        }
        if (sub === 'crm') {
          const r = await service.sendToCrm(identity, input.requestId, id);
          back(`${base}/people`, r.failed ? 'e' : 'n', `CRM: ${r.linked} added, ${r.replayed} already there${r.failed ? `, ${r.failed} could not be sent` : ''}. ${r.remaining} still to send.`);
          return true;
        }
        if (questionMatch) {
          const action = form.get('action');
          if (action !== 'approve' && action !== 'answer' && action !== 'dismiss') throw new WebinarError(400, 'Unknown action.');
          await service.moderate(identity, input.requestId, id, questionMatch[1]!, action, form.get('answer') ?? '');
          back(`${base}/questions`, 'n', 'Question updated.');
          return true;
        }
        return false;
      } catch (err) {
        if (err instanceof WebinarError && err.status < 500) {
          const t = tabFor(sub);
          back(t ? `${base}/${t}` : base, 'e', err.message);
          return true;
        }
        throw err;
      }
    }

    if (method === 'POST' && sub === 'studio/ticket') {
      if (!input.studio) throw new WebinarError(409, 'The browser studio is not available on this deployment.');
      const ingest = await service.studioIngest(identity, input.requestId, id);
      let issued: { ticket: string; expiresAt: string };
      try {
        issued = input.studio.issueTicket({ ...ingest, userId: identity.userId });
      } catch (err) {
        throw new WebinarError(409, err instanceof Error ? err.message : 'The studio could not start.');
      }
      json(res, 200, { path: `${STUDIO_WS_ROUTE}?ticket=${issued.ticket}`, expiresAt: issued.expiresAt });
      return true;
    }
    if (method === 'POST' && sub === 'upload') {
      let body: { bytes?: unknown; name?: unknown };
      try { body = JSON.parse(await readBody(req, 4096)) as typeof body; } catch { throw new WebinarError(400, 'The upload request was not readable. Reload the page and try again.'); }
      json(res, 200, await service.beginUpload(identity, input.requestId, id, Number(body.bytes), String(body.name ?? 'video')));
      return true;
    }
    if (method === 'POST' && sub === 'upload/done') {
      const ev = await service.uploadFinished(identity, input.requestId, id);
      json(res, 200, { videoState: ev.videoState });
      return true;
    }
    if (method !== 'GET') return false;
    if (sub === 'host/state') {
      const ev = await service.refreshLive(identity, input.requestId, id).catch(() => null) ?? (await service.get(identity, input.requestId, id)).event;
      const room = computeRoomState({ event: ev, nowMs: service.clock(), providerConfigured: service.providerConfigured });
      const preview = await service.hostPreview(identity, input.requestId, id).catch(() => null);
      json(res, 200, { roomLabel: room.label, roomState: room.state, liveState: ev.liveState, sessionState: ev.sessionState, recordingState: ev.recordingState, preview,
        studio: input.studio?.sessionFor(id) ?? null });
      return true;
    }
    if (sub === 'people.csv') {
      const got = await service.get(identity, input.requestId, id);
      const rows = await service.registrants(identity, input.requestId, id, 5000);
      const qs = got.event.settings.questions;
      const header = ['Registered (UTC)', 'Name', 'Email', 'Status', 'Opened room (page visit)', 'Started player', 'Observed minutes', 'CTA clicked', 'Questions', 'Marketing opt-in', 'CRM linked', 'utm_source', 'utm_campaign', ...qs.map((q) => q.label)];
      const lines = [header, ...rows.map((r) => [r.createdAt, r.name, r.email, r.status, r.accessedRoom ? 'yes' : 'no', r.playerStarted ? 'yes' : 'no', Math.round(r.watchedSeconds / 60),
        r.ctaClicked ? 'yes' : 'no', r.questions, r.marketingConsent ? 'yes' : 'no', r.crmContactId ? 'yes' : 'no', r.attribution.utm_source ?? '', r.attribution.utm_campaign ?? '',
        ...qs.map((q) => r.answers[q.id] ?? '')])].map((cols) => cols.map(csvCell).join(',')).join('\r\n');
      send(res, 200, `${lines}\r\n`, 'text/csv; charset=utf-8', { 'content-disposition': `attachment; filename="webinar-${got.event.publicKey}-registrants.csv"` });
      return true;
    }
    if (sub === 'preview') {
      const got = await service.get(identity, input.requestId, id);
      send(res, 200, registrationPage({ event: got.event, brand: got.profile.brand, registered: got.counts.registered, preview: true, error: null, values: {}, nowMs: service.clock() }),
        'text/html; charset=utf-8', { 'content-security-policy': PUBLIC_PREVIEW_CSP });
      return true;
    }

    const tab = (sub || 'details') as WebinarTab;
    if (!['details', 'video', 'studio', 'host', 'people', 'questions', 'messages', 'results'].includes(tab)) return false;
    const got = await service.get(identity, input.requestId, id);
    const ev = got.event;
    let body: string;
    switch (tab) {
      case 'details': body = detailsTab({ profile: got.profile, event: { ...ev, rowVersion: got.rowVersion }, csrf }); break;
      case 'video': body = videoTab({ event: ev, csrf, setup, credentials: null, provisionState: await service.provisionState(identity, input.requestId, id) }); break;
      case 'studio': body = studioTab({ event: ev, csrf, setup, room: computeRoomState({ event: ev, nowMs: service.clock(), providerConfigured: service.providerConfigured }) }); break;
      case 'host': body = hostTab({ event: ev, csrf, setup, room: computeRoomState({ event: ev, nowMs: service.clock(), providerConfigured: service.providerConfigured }) }); break;
      case 'people': body = peopleTab({ event: ev, rows: await service.registrants(identity, input.requestId, id, 500), csrf, crmAvailable: service.crmAvailable }); break;
      case 'questions': body = questionsTab({ event: ev, rows: await service.questions(identity, input.requestId, id), csrf }); break;
      case 'messages': body = messagesTab({ event: ev, rows: await service.messageStatus(identity, input.requestId, id), setup }); break;
      default: body = resultsTab({ event: ev, results: await service.results(identity, input.requestId, id) });
    }
    const host = String(req.headers.host ?? '');
    // The studio opens a same-origin WebSocket; name it explicitly for browsers whose 'self' omits ws(s).
    const extra: Record<string, string> = tab === 'studio' && /^[a-z0-9.-]+(:\d{1,5})?$/i.test(host) ? { 'content-security-policy': PAGE_CSP.replace("connect-src 'self'", `connect-src 'self' wss://${host} ws://${host}`) } : {};
    send(res, 200, input.shell(ev.title, got.profile.name, eventFrame({ profile: got.profile, event: ev, counts: got.counts, tab, csrf, publicUrl: publicUrl(service, ev), notice, error, body }), csrf), 'text/html; charset=utf-8', extra);
    return true;
  } catch (err) {
    const status = err instanceof WebinarError ? err.status : 503;
    const message = err instanceof WebinarError ? err.message : 'Webinars are temporarily unavailable. Please try again.';
    if (!(err instanceof WebinarError)) console.error(`webinars ${req.method} ${p} failed (${input.requestId}): ${err instanceof Error ? err.message : 'error'}`);
    if (p.endsWith('/upload') || p.endsWith('/upload/done') || p.endsWith('/host/state') || p.endsWith('/studio/ticket')) {
      json(res, status, { error: message });
      return true;
    }
    if (method === 'GET' && p !== WEBINARS_BASE && status < 500) { back(WEBINARS_BASE, 'e', message); return true; }
    const body = `<header class="page-heading"><div><div class="eyebrow">Webinars</div><h1>${status === 403 ? 'Not available' : 'Something went wrong'}</h1><p>${message.replace(/[<>&"]/g, '')}</p></div></header>
<section class="panel"><div class="panel-body" style="padding-top:18px"><a class="button secondary" href="${WEBINARS_BASE}">Back to webinars</a></div></section>`;
    send(res, status, input.shell('Webinars', 'Your workspace', body, csrf));
    return true;
  }
}

function publicUrl(service: PgWebinarService, ev: { workspaceId: string; publicKey: string }): string | null {
  const origin = publicOriginFor(service.config, ev.workspaceId);
  return origin ? `${origin}/w/${ev.publicKey}` : `/w/${ev.publicKey}`;
}

