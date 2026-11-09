/**
 * Public attendee routes under /w/<public key>/… on the canonical app host and
 * on brand app hosts (e.g. the MHP app host). Unauthenticated: access is the
 * HMAC link token, exchanged once for an HttpOnly cookie scoped to this webinar's
 * path, so the token never stays in the address bar, history or analytics.
 */

import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { accessCookie, accessCookieName, readAccessToken, type AccessClaim } from './access.js';
import { PUBLIC_ROOM_SCRIPT } from './client-scripts.js';
import { icsCalendar } from './messages.js';
import {
  PUBLIC_ASSET_HLS, PUBLIC_ASSET_ROOM, PUBLIC_CSP, accessLinkPage, confirmationPage, messagePage, registrationPage, roomPage,
} from './public-view.js';
import { WebinarError, type PgWebinarService } from './service.js';

export const WEBINAR_PUBLIC_PREFIX = '/w/';
const KEY = /^\/w\/([a-z0-9][a-z0-9-]{2,70}[a-z0-9])(?:\/([a-z.-]{1,30}))?$/;
const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

let hlsCache: Promise<string | null> | null = null;
/** Pinned hls.js (orchestrator dependency) served from our own origin under CSP script-src 'self'. */
export function hlsAsset(): Promise<string | null> {
  hlsCache ??= (async () => {
    try {
      const require = createRequire(import.meta.url);
      return await readFile(require.resolve('hls.js/dist/hls.min.js'), 'utf8');
    } catch {
      return null;
    }
  })();
  return hlsCache;
}

/** Simple per-process limiter for registration and link requests (bounded memory). */
class Limiter {
  private readonly hits = new Map<string, number[]>();
  constructor(private readonly max: number, private readonly windowMs: number) {}
  allow(key: string, now: number): boolean {
    if (this.hits.size > 20_000) this.hits.clear();
    const list = (this.hits.get(key) ?? []).filter((t) => t > now - this.windowMs);
    if (list.length >= this.max) { this.hits.set(key, list); return false; }
    list.push(now);
    this.hits.set(key, list);
    return true;
  }
}

const registerLimiter = new Limiter(10, 10 * 60_000);
const linkLimiter = new Limiter(5, 10 * 60_000);
const jsonLimiter = new Limiter(240, 60_000);

export interface WebinarPublicInput {
  readonly service: PgWebinarService;
  /** Secure cookies everywhere except plain-http local development. */
  readonly secureCookies: boolean;
  readonly clientKey?: (req: IncomingMessage) => string;
  readonly now?: () => number;
}

function headers(type: string, extra: Record<string, string> = {}): Record<string, string> {
  return { 'content-type': type, 'cache-control': 'no-store', 'referrer-policy': 'same-origin', 'x-content-type-options': 'nosniff',
    'content-security-policy': PUBLIC_CSP, 'permissions-policy': 'camera=(), microphone=(), geolocation=()', ...extra };
}

function sendHtml(res: ServerResponse, status: number, html: string, extra: Record<string, string> = {}): void {
  res.writeHead(status, headers('text/html; charset=utf-8', { 'content-length': String(Buffer.byteLength(html)), ...extra }));
  res.end(html);
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(status, headers('application/json; charset=utf-8', { 'content-length': String(Buffer.byteLength(body)) }));
  res.end(body);
}

function redirect(res: ServerResponse, location: string, extra: Record<string, string> = {}): void {
  res.writeHead(303, { location, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', ...extra });
  res.end();
}

async function body(req: IncomingMessage, max: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > max) throw new WebinarError(413, 'Request too large.');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function cookies(req: IncomingMessage): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
  }
  return out;
}

function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin || origin === 'null') return origin === undefined;
  try { return new URL(origin).host === String(req.headers.host ?? ''); } catch { return false; }
}

function externalReferrerHost(req: IncomingMessage): string {
  try {
    const ref = new URL(String(req.headers.referer ?? ''));
    return ref.host && ref.host !== req.headers.host ? ref.hostname.slice(0, 120) : '';
  } catch {
    return '';
  }
}

/** Returns true when handled. */
export async function handleWebinarPublic(req: IncomingMessage, res: ServerResponse, url: URL, input: WebinarPublicInput): Promise<boolean> {
  const path = url.pathname.replace(/\/+$/, '');
  const method = req.method ?? 'GET';
  const now = input.now ?? (() => input.service.clock());
  if (path === PUBLIC_ASSET_ROOM && method === 'GET') {
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'public, max-age=300', 'x-content-type-options': 'nosniff' });
    res.end(PUBLIC_ROOM_SCRIPT);
    return true;
  }
  if (path === PUBLIC_ASSET_HLS && method === 'GET') {
    const asset = await hlsAsset();
    if (!asset) return false;
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'public, max-age=86400', 'x-content-type-options': 'nosniff' });
    res.end(asset);
    return true;
  }
  const m = KEY.exec(path);
  if (!m) return false;
  const key = m[1]!;
  const sub = m[2] ?? '';
  const svc = input.service;
  const client = input.clientKey?.(req) ?? String(req.socket.remoteAddress ?? 'unknown');
  const secret = svc.config.accessSecret;

  try {
    const loaded = await svc.publicEvent(key);
    if (!loaded) { sendHtml(res, 404, '<!doctype html><title>Not found</title><p>This webinar link is not available.</p>'); return true; }
    const { event, brand } = loaded;
    const cookieName = accessCookieName(key);
    const claimFromCookie = (): AccessClaim | null => (secret ? readAccessToken(secret, key, cookies(req).get(cookieName)) : null);
    const attendee = async () => {
      const claim = claimFromCookie();
      if (!claim) return null;
      const a = await svc.attendee(key, claim);
      return a ? { claim, ...a } : null;
    };

    // ── registration ──
    if (sub === '' && method === 'GET') {
      const existing = await attendee().catch(() => null);
      const values: Record<string, string> = {};
      for (const k of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term']) {
        const v = url.searchParams.get(k);
        if (v) values[k] = v.slice(0, 120);
      }
      const ref = externalReferrerHost(req);
      if (ref) values.referrerHost = ref;
      sendHtml(res, 200, registrationPage({ event, brand, registered: loaded.registered, preview: false, error: null, values, nowMs: now(),
        roomPath: existing ? `/w/${key}/room` : null }));
      return true;
    }
    if (sub === 'register' && method === 'POST') {
      if (!sameOrigin(req)) throw new WebinarError(403, 'Please register from the webinar page.');
      if (!String(req.headers['content-type'] ?? '').startsWith('application/x-www-form-urlencoded')) throw new WebinarError(415, 'Unsupported form.');
      const form = new URLSearchParams(await body(req, 16 * 1024));
      const values = Object.fromEntries([...form.entries()].map(([k, v]) => [k, v.slice(0, 500)]));
      const fail = (status: number, message: string) => sendHtml(res, status, registrationPage({ event, brand, registered: loaded.registered, preview: false, error: message, values, nowMs: now() }));
      if (form.get('website')) { redirect(res, `/w/${key}/registered`); return true; } // honeypot: silent success
      if (!registerLimiter.allow(`${client}:${key}`, now())) { fail(429, 'Too many attempts from this connection. Please wait a few minutes.'); return true; }
      if (!secret) { fail(503, 'Registration is temporarily unavailable.'); return true; }
      const answers: Record<string, string> = {};
      for (const q of event.settings.questions) {
        const v = (form.get(q.id) ?? '').trim().slice(0, 500);
        if (q.required && !v) { fail(400, `Please answer: ${q.label}`); return true; }
        if (v && q.type === 'select' && !q.options.includes(v)) { fail(400, `Please choose an option for: ${q.label}`); return true; }
        if (v) answers[q.id] = v;
      }
      const email = (form.get('email') ?? '').trim();
      if (!EMAIL.test(email)) { fail(400, 'Enter a valid email address.'); return true; }
      const marketing = Boolean(event.settings.marketingConsentText) && form.get('marketing') === '1';
      const attribution: Record<string, string> = {};
      for (const k of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'referrerHost']) {
        const v = (form.get(k) ?? '').trim();
        if (v) attribution[k] = v.slice(0, 120);
      }
      const result = await svc.register(key, {
        email, name: form.get('name') ?? '', answers, marketing, attribution,
        consent: { serviceNotice: event.settings.serviceNotice, marketingText: event.settings.marketingConsentText, marketing, version: event.settings.consentVersion,
          privacyUrl: event.settings.privacyUrl, at: new Date(now()).toISOString() },
      });
      if (result.outcome === 'full') { fail(409, 'Sorry, this webinar is full.'); return true; }
      if (result.outcome === 'closed' || result.outcome === 'unavailable') { fail(409, 'Registration for this webinar is closed.'); return true; }
      if (result.outcome === 'existing') {
        // Never hand an existing registrant's access to whoever typed their address.
        await svc.requestAccessLink(key, email);
        sendHtml(res, 200, messagePage(event, brand, "You're already registered", 'We have emailed the personal link for that address. Use it to enter the room on any device.'));
        return true;
      }
      redirect(res, `/w/${key}/registered`, { 'set-cookie': accessCookie(key, result.token!, input.secureCookies) });
      return true;
    }
    if (sub === 'registered' && method === 'GET') {
      const a = await attendee();
      if (!a) { redirect(res, `/w/${key}`); return true; }
      sendHtml(res, 200, confirmationPage({ event, brand, roomPath: `/w/${key}/room`, calendarPath: event.startsAt && event.kind !== 'on_demand' ? `/w/${key}/calendar.ics` : null,
        emailMode: svc.config.emailMode, nowMs: now() }));
      return true;
    }
    if (sub === 'link') {
      if (method === 'GET') { sendHtml(res, 200, accessLinkPage(event, brand, false)); return true; }
      if (method === 'POST') {
        if (!sameOrigin(req)) throw new WebinarError(403, 'Please use the webinar page.');
        const form = new URLSearchParams(await body(req, 4096));
        const email = (form.get('email') ?? '').trim();
        if (!form.get('website') && EMAIL.test(email) && linkLimiter.allow(`${client}:${key}`, now())) await svc.requestAccessLink(key, email);
        sendHtml(res, 200, accessLinkPage(event, brand, true));
        return true;
      }
    }

    // ── room ──
    if (sub === 'room' && method === 'GET') {
      const token = url.searchParams.get('t');
      if (token) {
        // Exchange the emailed token for a path-scoped cookie and drop it from the URL.
        const claim = secret ? readAccessToken(secret, key, token) : null;
        if (!claim || !(await svc.attendee(key, claim))) {
          sendHtml(res, 403, messagePage(event, brand, 'This link is not valid', 'It may be incomplete or out of date. Request your personal link again.', { href: `/w/${key}/link`, label: 'Email me my link' }));
          return true;
        }
        redirect(res, `/w/${key}/room`, { 'set-cookie': accessCookie(key, token, input.secureCookies) });
        return true;
      }
      const a = await attendee();
      if (!a) {
        sendHtml(res, 401, messagePage(event, brand, 'Register to watch', 'This room is for registered attendees. Register, or use the personal link from your email.', { href: `/w/${key}`, label: 'Register' }));
        return true;
      }
      await svc.signal(key, a.claim, 'room_accessed', 'waiting', null, null).catch(() => false);
      sendHtml(res, 200, roomPage({ event, brand, attendeeName: a.name }));
      return true;
    }
    if (sub === 'state' && method === 'GET') {
      if (!jsonLimiter.allow(`${client}:state`, now())) { sendJson(res, 429, { error: 'slow_down' }); return true; }
      const a = await attendee();
      if (!a) { sendJson(res, 401, { error: 'registration_required' }); return true; }
      const pb = svc.playback(a.event.event);
      sendJson(res, 200, {
        state: pb.room.state, label: pb.room.label, message: pb.room.message, playMode: pb.room.playMode, seekable: pb.room.seekable,
        offsetSeconds: pb.room.offsetSeconds, opensAt: pb.room.opensAt, startsAt: pb.room.startsAt, endsAt: pb.room.endsAt, replayUntil: pb.room.replayUntil,
        sessionStartedAt: a.event.event.sessionStartedAt, hlsUrl: pb.hlsUrl, expiresAt: pb.expiresAt, cta: pb.cta, serverNow: pb.serverNow,
      });
      return true;
    }
    if (sub === 'signal' && method === 'POST') {
      if (!sameOrigin(req)) { sendJson(res, 403, { error: 'cross_site' }); return true; }
      if (!jsonLimiter.allow(`${client}:signal`, now())) { sendJson(res, 429, { error: 'slow_down' }); return true; }
      const a = claimFromCookie();
      if (!a) { sendJson(res, 401, { error: 'registration_required' }); return true; }
      let payload: Record<string, unknown> = {};
      try { payload = JSON.parse(await body(req, 1024)) as Record<string, unknown>; } catch { /* invalid */ }
      const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 1000) / 1000 : null);
      const ok = await svc.signal(key, a, String(payload.kind ?? ''), String(payload.mode ?? ''), num(payload.from), num(payload.to));
      sendJson(res, 200, { recorded: ok });
      return true;
    }
    if (sub === 'questions') {
      const a = claimFromCookie();
      if (!a) { sendJson(res, 401, { error: 'registration_required' }); return true; }
      if (method === 'GET') { sendJson(res, 200, { questions: await svc.publicQuestions(key, a) }); return true; }
      if (method === 'POST') {
        if (!sameOrigin(req)) { sendJson(res, 403, { error: 'cross_site' }); return true; }
        let payload: Record<string, unknown> = {};
        try { payload = JSON.parse(await body(req, 4096)) as Record<string, unknown>; } catch { /* invalid */ }
        const outcome = await svc.ask(key, a, String(payload.body ?? ''));
        sendJson(res, outcome === 'accepted' ? 200 : outcome === 'rate_limited' ? 429 : 400, { outcome });
        return true;
      }
    }
    if (sub === 'calendar.ics' && method === 'GET') {
      const token = url.searchParams.get('t');
      const claim = token && secret ? readAccessToken(secret, key, token) : claimFromCookie();
      const a = claim ? await svc.attendee(key, claim) : null;
      if (!a || !event.startsAt || event.kind === 'on_demand' || !claim) { sendHtml(res, 404, '<!doctype html><p>No calendar entry for this link.</p>'); return true; }
      const roomUrl = svc.roomUrl(event, claim) ?? `/w/${key}/room`;
      const ics = icsCalendar(event, roomUrl, brand.productName ?? brand.workspaceName);
      res.writeHead(200, { 'content-type': 'text/calendar; charset=utf-8', 'content-disposition': `attachment; filename="${key}.ics"`, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      res.end(ics);
      return true;
    }
    return false;
  } catch (error) {
    const status = error instanceof WebinarError ? error.status : 503;
    if (!(error instanceof WebinarError)) console.error(`webinar public ${method} ${path} failed: ${error instanceof Error ? error.message : 'error'}`);
    if (sub === 'state' || sub === 'signal' || sub === 'questions') { sendJson(res, status, { error: 'unavailable' }); return true; }
    sendHtml(res, status, `<!doctype html><meta charset="utf-8"><title>Unavailable</title><p>${error instanceof WebinarError ? error.message.replace(/[<>&]/g, '') : 'This webinar page is temporarily unavailable. Please try again shortly.'}</p>`);
    return true;
  }
}
