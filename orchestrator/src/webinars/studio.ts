/**
 * Browser studio relay. The host's browser composites camera, microphone and
 * screen share and sends H.264/Opus media over a WebSocket; this relay remuxes
 * it with ffmpeg (video copied, audio to AAC) and pushes RTMPS to the webinar's
 * existing recorded, signed-URL Cloudflare live input. Recording, replay and
 * signed playback are therefore unchanged.
 *
 * The stream key never leaves this process: the browser holds only a one-time
 * ticket. ffmpeg output is redacted before it is logged or shown. Video is
 * never transcoded here (bounded CPU on a small instance); a browser that cannot
 * produce H.264 is told so plainly.
 */

import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketConnection } from './websocket.js';
import { CHROME_SHAPE_MKV, SAFARI_SHAPE_MP4 } from './studio-probe-media.js';
import { accessSync, constants as fsConstants, existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';

export const STUDIO_WS_ROUTE = '/api/webinars/studio';

/** MediaRecorder types the relay accepts: H.264 video (copied), Opus or AAC audio. */
const ACCEPTED_MIME = /^video\/(webm|x-matroska|mp4);\s*codecs="?(h264|avc1(\.[0-9a-f]{6})?),(opus|mp4a(\.[0-9.a-z]+)?)"?$/i;

export function acceptedStudioMime(mime: unknown): boolean {
  return typeof mime === 'string' && mime.length <= 100 && ACCEPTED_MIME.test(mime.replace(/\s+/g, ''));
}

export interface StudioRelayConfig {
  /** ffmpeg binary (PATH name or absolute path). */
  readonly ffmpegPath: string;
  /** Concurrent studio broadcasts on this instance. */
  readonly maxSessions: number;
  /** Hard stop for one studio broadcast. */
  readonly maxMinutes: number;
  /** Tests only: allow rtmp://127.0.0.1 ingest instead of Cloudflare RTMPS. */
  readonly allowLocalIngest?: boolean;
}

export interface StudioCheck {
  readonly id: string;
  readonly label: string;
  readonly ok: boolean;
  /** Required for every browser; false means Safari-only. */
  readonly required: boolean;
  readonly detail: string;
}

export interface StudioProbe {
  /** True when every required check passed (Chrome and Edge can broadcast). */
  readonly available: boolean;
  /** True when the Safari (fragmented MP4) path also passed. */
  readonly safari: boolean;
  /** One-line summary for the setup panel. */
  readonly detail: string;
  /** The executable actually used (resolved from PATH when no path was configured). */
  readonly path: string | null;
  readonly version: string | null;
  readonly checks: readonly StudioCheck[];
}

type SpawnFn = (cmd: string, args: readonly string[]) => ChildProcessWithoutNullStreams;

interface RunResult { readonly code: number | null; readonly stdout: Buffer; readonly stderr: string }

/** Runs a bounded child process (no shell), optionally feeding stdin; never throws. */
function run(spawnFn: SpawnFn, cmd: string, args: readonly string[], input?: Buffer, timeoutMs = 8000): Promise<RunResult | null> {
  return new Promise((resolve) => {
    const out: Buffer[] = [];
    let size = 0;
    let err = '';
    let child: ChildProcessWithoutNullStreams;
    try { child = spawnFn(cmd, args); } catch { resolve(null); return; }
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(null); }, timeoutMs);
    child.stdout.on('data', (d: Buffer) => { if (size < 4_000_000) { out.push(d); size += d.length; } });
    child.stderr.on('data', (d: Buffer) => { if (err.length < 200_000) err += d.toString('utf8'); });
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout: Buffer.concat(out), stderr: err }); });
    child.stdin.on('error', () => undefined);
    child.stdin.end(input ?? undefined);
  });
}

/** Resolves a bare command name against PATH, as the OS would. */
export function resolveOnPath(cmd: string, pathEnv = process.env.PATH ?? ''): string | null {
  if (cmd.includes('/')) return existsSync(cmd) ? cmd : null;
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, cmd);
    try { accessSync(candidate, fsConstants.X_OK); return candidate; } catch { /* next */ }
  }
  return null;
}

function listed(text: string, section: RegExp | null, pattern: RegExp): boolean {
  const body = section ? (text.split(section)[1] ?? '') : text;
  return pattern.test(body);
}

/**
 * Detects and verifies the ffmpeg the relay will use: the exact protocols,
 * demuxers, muxer and codecs it needs, then a bounded local smoke test that
 * pushes browser-shaped clips through the relay's own arguments to stdout and
 * reads the result back. No network, no provider. It cannot prove the RTMPS
 * connection to Cloudflare itself; that is the live test.
 */
export async function probeFfmpeg(ffmpegPath: string, spawnFn: SpawnFn = nodeSpawn as SpawnFn, pathEnv?: string): Promise<StudioProbe> {
  const resolved = resolveOnPath(ffmpegPath, pathEnv);
  const fail = (detail: string): StudioProbe => ({ available: false, safari: false, detail, path: resolved, version: null, checks: [] });
  if (!resolved) return fail(ffmpegPath.includes('/') ? `ffmpeg was not found at ${ffmpegPath}.` : 'ffmpeg was not found on PATH.');
  const version = await run(spawnFn, resolved, ['-hide_banner', '-version']);
  if (!version || version.code !== 0) return fail(`${resolved} did not run (ffmpeg -version failed).`);
  const first = (version.stdout.toString('utf8').split('\n')[0] ?? '').trim();
  const versionLine = (/^ffmpeg version (\S+)/.exec(first)?.[1] ? `ffmpeg ${/^ffmpeg version (\S+)/.exec(first)![1]}` : first).slice(0, 80);
  const text = async (flag: string) => { const r = await run(spawnFn, resolved, ['-hide_banner', flag]); return r && r.code === 0 ? r.stdout.toString('utf8') : ''; };
  const [protocols, demuxers, muxers, decoders, encoders] = [await text('-protocols'), await text('-demuxers'), await text('-muxers'), await text('-decoders'), await text('-encoders')];

  const checks: StudioCheck[] = [];
  const add = (id: string, label: string, ok: boolean, required: boolean, detail: string) => checks.push({ id, label, ok, required, detail });
  add('pipe-input', 'Reads media from the relay (pipe input)', listed(protocols, /Output:/i, /^\s*pipe\s*$/m) || listed(protocols.split(/Output:/i)[0] ?? '', null, /^\s*pipe\s*$/m), true, 'protocol "pipe" (input)');
  add('rtmps-output', 'Sends to Cloudflare over RTMPS', listed(protocols, /Output:/i, /^\s*rtmps\s*$/m), true, 'protocol "rtmps" (output; needs TLS support)');
  add('webm-demux', 'Reads Chrome/Edge recordings (WebM/Matroska)', /^\s*D\S*\s+matroska,webm\s/m.test(demuxers), true, 'demuxer "matroska,webm"');
  add('mp4-demux', 'Reads Safari recordings (MP4)', /^\s*D\S*\s+mov,mp4[\w,]*\s/m.test(demuxers), false, 'demuxer "mov,mp4,…"');
  add('flv-mux', 'Packages for RTMP (FLV)', /^\s*\S*E\S*\s+flv\s/m.test(muxers), true, 'muxer "flv"');
  add('opus-decode', 'Decodes browser audio (Opus)', /^\s*A\S*\s+(opus|libopus)\s/m.test(decoders), true, 'decoder "opus"');
  add('aac-decode', 'Decodes Safari audio (AAC)', /^\s*A\S*\s+aac\s/m.test(decoders), false, 'decoder "aac"');
  add('aac-encode', 'Encodes Cloudflare audio (AAC)', /^\s*A\S*\s+aac\s/m.test(encoders), true, 'encoder "aac"');

  const smoke = async (clip: Buffer): Promise<{ ok: boolean; detail: string }> => {
    const remux = await run(spawnFn, resolved, ffmpegArgs('pipe:1'), clip);
    if (!remux || remux.code !== 0 || remux.stdout.length < 100 || remux.stdout.subarray(0, 3).toString('latin1') !== 'FLV') {
      return { ok: false, detail: `remux failed${remux?.stderr ? `: ${remux.stderr.trim().split('\n').slice(-1)[0]!.slice(0, 160)}` : ''}` };
    }
    const back = await run(spawnFn, resolved, ['-hide_banner', '-i', 'pipe:0', '-f', 'null', '-'], remux.stdout);
    const info = back?.stderr ?? '';
    const video = /Stream #0:\d+.*Video: h264/.test(info), audio = /Stream #0:\d+.*Audio: aac/.test(info);
    return video && audio && back?.code === 0 ? { ok: true, detail: 'H.264 copied, audio converted to AAC, FLV read back' } : { ok: false, detail: `output read back as ${video ? 'H.264' : 'no H.264'} / ${audio ? 'AAC' : 'no AAC'}` };
  };
  const chrome = await smoke(CHROME_SHAPE_MKV);
  add('smoke-chrome', 'Smoke test: Chrome/Edge-shaped clip through the relay pipeline', chrome.ok, true, chrome.detail);
  const safari = await smoke(SAFARI_SHAPE_MP4);
  add('smoke-safari', 'Smoke test: Safari-shaped clip through the relay pipeline', safari.ok, false, safari.detail);

  const missing = checks.filter((c) => c.required && !c.ok);
  const safariOk = checks.filter((c) => !c.required).every((c) => c.ok);
  return {
    available: missing.length === 0,
    safari: missing.length === 0 && safariOk,
    detail: missing.length === 0
      ? `${versionLine} at ${resolved}${safariOk ? '' : ' (Safari recordings not supported by this build)'}`
      : `${versionLine} at ${resolved} failed: ${missing.map((c) => `${c.label} (${c.detail})`).join('; ')}.`,
    path: resolved,
    version: versionLine,
    checks,
  };
}

/** Removes any ingest URL and stream key from text before it is logged or shown. */
export function redactIngest(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of secrets) if (s) out = out.split(s).join('[redacted]');
  return out.replace(/rtmps?:\/\/\S+/gi, 'rtmps://[redacted]').replace(/srt:\/\/\S+/gi, 'srt://[redacted]');
}

export function ffmpegArgs(target: string): string[] {
  return [
    '-hide_banner', '-loglevel', 'error', '-nostats',
    '-fflags', '+genpts+discardcorrupt', '-thread_queue_size', '2048',
    '-i', 'pipe:0',
    '-map', '0:v:0', '-map', '0:a:0',
    '-c:v', 'copy',
    '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2',
    '-f', 'flv', '-flvflags', 'no_duration_filesize',
    target,
  ];
}

export interface StudioTicketInput {
  readonly workspaceId: string;
  readonly eventId: string;
  readonly userId: string;
  /** From the live input (server-side only). */
  readonly ingestUrl: string;
  readonly streamKey: string;
}

interface Ticket extends StudioTicketInput {
  readonly expiresAt: number;
}

export type StudioState = 'idle' | 'starting' | 'sending' | 'stopping' | 'error';

interface Session {
  readonly eventId: string;
  readonly ws: WebSocketConnection;
  ffmpeg: ChildProcessWithoutNullStreams | null;
  state: StudioState;
  bytes: number;
  startedAt: number;
  stderr: string;
  secrets: string[];
  timer: NodeJS.Timeout | null;
  ending: boolean;
}

export interface StudioStatus {
  readonly state: StudioState;
  readonly bytes: number;
  readonly seconds: number;
}

const MAX_PENDING = 16 * 1024 * 1024;

export class StudioRelay {
  private readonly tickets = new Map<string, Ticket>();
  private readonly sessions = new Map<string, Session>();
  private probeResult: StudioProbe = { available: false, safari: false, detail: 'Not checked yet.', path: null, version: null, checks: [] };

  constructor(
    private readonly config: StudioRelayConfig,
    private readonly deps: { spawn?: SpawnFn; now?: () => number; log?: (line: string) => void } = {},
  ) {}

  private get now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private log(line: string): void {
    (this.deps.log ?? ((l: string) => console.warn(l)))(line);
  }

  async probe(): Promise<StudioProbe> {
    this.probeResult = await probeFfmpeg(this.config.ffmpegPath, this.deps.spawn);
    return this.probeResult;
  }

  get status(): StudioProbe {
    return this.probeResult;
  }

  sessionFor(eventId: string): StudioStatus | null {
    const s = this.sessions.get(eventId);
    return s ? { state: s.state, bytes: s.bytes, seconds: Math.round((this.now - s.startedAt) / 1000) } : null;
  }

  private target(ingestUrl: string, streamKey: string): string {
    let u: URL;
    try { u = new URL(ingestUrl); } catch { throw new Error('The live input has no usable RTMPS address.'); }
    const cloudflare = u.protocol === 'rtmps:' && (u.hostname === 'live.cloudflare.com' || u.hostname.endsWith('.cloudflare.com'));
    const local = this.config.allowLocalIngest === true && u.protocol === 'rtmp:' && u.hostname === '127.0.0.1';
    if (!cloudflare && !local) throw new Error('The live input address is not a Cloudflare RTMPS ingest.');
    if (!/^[A-Za-z0-9_-]{8,200}$/.test(streamKey)) throw new Error('The live input has no usable stream key.');
    return `${u.toString().replace(/\/?$/, '/')}${streamKey}`;
  }

  /** One-time, 60-second ticket for opening the studio channel. Throws a plain-English reason. */
  issueTicket(input: StudioTicketInput): { ticket: string; expiresAt: string } {
    if (!this.probeResult.available) throw new Error(`The browser studio is not available on this server: ${this.probeResult.detail}`);
    this.target(input.ingestUrl, input.streamKey);
    const active = [...this.sessions.values()].filter((s) => s.eventId !== input.eventId).length;
    if (active >= this.config.maxSessions) throw new Error('The server is already relaying the maximum number of studio broadcasts. Try again when one ends, or use an encoder.');
    for (const [k, t] of this.tickets) if (t.expiresAt < this.now) this.tickets.delete(k);
    if (this.tickets.size > 100) throw new Error('Too many pending studio requests. Try again shortly.');
    const ticket = randomBytes(32).toString('base64url');
    const expiresAt = this.now + 60_000;
    this.tickets.set(ticket, { ...input, expiresAt });
    return { ticket, expiresAt: new Date(expiresAt).toISOString() };
  }

  private takeTicket(raw: string | null): Ticket | null {
    if (!raw || !/^[A-Za-z0-9_-]{43}$/.test(raw)) return null;
    for (const [k, t] of this.tickets) {
      if (k.length === raw.length && timingSafeEqual(Buffer.from(k), Buffer.from(raw))) {
        this.tickets.delete(k);
        return t.expiresAt >= this.now ? t : null;
      }
    }
    return null;
  }

  /** Handles an HTTP upgrade for STUDIO_WS_ROUTE; returns false for other paths. */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== STUDIO_WS_ROUTE) return false;
    const refuse = (status: string) => { socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); };
    const origin = req.headers.origin;
    let sameOrigin = false;
    try { sameOrigin = typeof origin === 'string' && new URL(origin).host === String(req.headers.host ?? ''); } catch { sameOrigin = false; }
    if (!sameOrigin) { refuse('403 Forbidden'); return true; }
    const ticket = this.takeTicket(url.searchParams.get('ticket'));
    if (!ticket) { refuse('401 Unauthorized'); return true; }
    let target: string;
    try { target = this.target(ticket.ingestUrl, ticket.streamKey); } catch { refuse('409 Conflict'); return true; }
    const previous = this.sessions.get(ticket.eventId);
    if (previous) this.stop(previous, 'Replaced by a newer studio tab.');

    let session!: Session;
    const ws = WebSocketConnection.accept(req, socket, head, { maxFrame: 4 * 1024 * 1024, maxMessage: 8 * 1024 * 1024 }, {
      onMessage: (data, text) => this.onMessage(session, target, data, text),
      onClose: () => this.stop(session, null),
    });
    if (!ws) { refuse('400 Bad Request'); return true; }
    if (typeof (socket as { setTimeout?: (ms: number) => void }).setTimeout === 'function') (socket as unknown as { setTimeout(ms: number): void }).setTimeout(0);
    session = { eventId: ticket.eventId, ws, ffmpeg: null, state: 'idle', bytes: 0, startedAt: this.now, stderr: '', secrets: [ticket.streamKey, target], timer: null, ending: false };
    this.sessions.set(ticket.eventId, session);
    this.send(session, 'idle', 'Connected to the server. Starting…');
    return true;
  }

  private send(s: Session, state: StudioState, message: string): void {
    s.state = state;
    s.ws.sendText(JSON.stringify({ type: 'status', state, message, bytes: s.bytes, seconds: Math.round((this.now - s.startedAt) / 1000) }));
  }

  private onMessage(s: Session, target: string, data: Buffer, text: boolean): void {
    if (text) {
      let msg: { type?: unknown; mimeType?: unknown };
      try { msg = JSON.parse(data.toString('utf8')) as typeof msg; } catch { this.stop(s, 'Unreadable message.'); return; }
      if (msg.type === 'start' && !s.ffmpeg) {
        if (!acceptedStudioMime(msg.mimeType)) { this.stop(s, 'This browser does not record H.264 video. Use Chrome, Edge or Safari, or an encoder.'); return; }
        if (/^video\/mp4/i.test(String(msg.mimeType)) && !this.probeResult.safari) { this.stop(s, "This server's ffmpeg cannot read Safari's recording format. Use Chrome or Edge, or an encoder."); return; }
        this.startFfmpeg(s, target);
        return;
      }
      if (msg.type === 'stop') { this.stop(s, null); return; }
      return;
    }
    if (!s.ffmpeg || s.ending) return;
    if (s.ffmpeg.stdin.writableLength > MAX_PENDING) {
      this.stop(s, 'The connection from this server to Cloudflare cannot keep up. Lower the quality or use an encoder.');
      return;
    }
    s.bytes += data.length;
    s.ffmpeg.stdin.write(data);
    if (s.state === 'starting' && s.bytes > 0) this.send(s, 'sending', 'Sending to Cloudflare.');
  }

  private startFfmpeg(s: Session, target: string): void {
    const child = (this.deps.spawn ?? (nodeSpawn as SpawnFn))(this.config.ffmpegPath, ffmpegArgs(target));
    s.ffmpeg = child;
    s.startedAt = this.now;
    this.send(s, 'starting', 'Connecting to Cloudflare…');
    child.stdin.on('error', () => undefined);
    child.stderr.on('data', (d: Buffer) => { s.stderr = (s.stderr + d.toString('utf8')).slice(-2000); });
    child.on('error', () => this.stop(s, 'The relay could not start ffmpeg on the server.'));
    child.on('close', (code) => {
      s.ffmpeg = null;
      if (s.ending) { this.finish(s, null); return; }
      const detail = redactIngest(s.stderr.trim().split('\n').slice(-2).join(' '), s.secrets).slice(0, 300);
      if (code !== 0) this.log(`webinar studio ${s.eventId}: relay exited (${code}): ${detail}`);
      this.finish(s, code === 0 ? null : `The relay to Cloudflare stopped${detail ? `: ${detail}` : '.'}`);
    });
    s.timer = setInterval(() => {
      if (this.now - s.startedAt > this.config.maxMinutes * 60_000) { this.stop(s, `Studio broadcasts stop after ${this.config.maxMinutes} minutes.`); return; }
      if (s.state === 'sending') this.send(s, 'sending', 'Sending to Cloudflare.');
    }, 2000);
    s.timer.unref();
  }

  private stop(s: Session | undefined, error: string | null): void {
    if (!s || s.ending) return;
    s.ending = true;
    if (s.timer) clearInterval(s.timer);
    if (s.ffmpeg) {
      if (s.ws.isOpen) this.send(s, 'stopping', error ?? 'Stopping…');
      const child = s.ffmpeg;
      child.stdin.end();
      const kill = setTimeout(() => child.kill('SIGKILL'), 5000);
      kill.unref();
      child.once('close', () => clearTimeout(kill));
      if (error) (s as { pendingError?: string }).pendingError = error;
      return;
    }
    this.finish(s, error);
  }

  private finish(s: Session, error: string | null): void {
    s.ending = true;
    if (s.timer) clearInterval(s.timer);
    const err = error ?? (s as { pendingError?: string }).pendingError ?? null;
    if (this.sessions.get(s.eventId) === s) this.sessions.delete(s.eventId);
    if (s.ws.isOpen) {
      s.state = err ? 'error' : 'idle';
      s.ws.sendText(JSON.stringify({ type: 'status', state: s.state, message: err ?? 'Stopped. Cloudflare keeps the recording.', bytes: s.bytes, seconds: Math.round((this.now - s.startedAt) / 1000) }));
      s.ws.close(err ? 1011 : 1000, err ? 'relay error' : 'stopped');
    }
  }

  /** Stops every relay (server shutdown). */
  stopAll(): void {
    for (const s of [...this.sessions.values()]) this.stop(s, 'The server is restarting.');
  }
}
