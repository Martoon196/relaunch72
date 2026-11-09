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

export interface StudioProbe {
  readonly available: boolean;
  readonly detail: string;
}

type SpawnFn = (cmd: string, args: readonly string[]) => ChildProcessWithoutNullStreams;

function run(spawnFn: SpawnFn, cmd: string, args: readonly string[], timeoutMs = 5000): Promise<string | null> {
  return new Promise((resolve) => {
    let out = '';
    let child: ChildProcessWithoutNullStreams;
    try { child = spawnFn(cmd, args); } catch { resolve(null); return; }
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(null); }, timeoutMs);
    child.stdout.on('data', (d: Buffer) => { if (out.length < 200_000) out += d.toString('utf8'); });
    child.stderr.on('data', (d: Buffer) => { if (out.length < 200_000) out += d.toString('utf8'); });
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', (code) => { clearTimeout(timer); resolve(code === 0 ? out : null); });
  });
}

/** Checks that the configured ffmpeg exists and can push RTMPS with an AAC encoder. */
export async function probeFfmpeg(ffmpegPath: string, spawnFn: SpawnFn = nodeSpawn as SpawnFn): Promise<StudioProbe> {
  const version = await run(spawnFn, ffmpegPath, ['-hide_banner', '-version']);
  if (version === null) return { available: false, detail: `ffmpeg was not found at "${ffmpegPath}" on this server.` };
  const protocols = (await run(spawnFn, ffmpegPath, ['-hide_banner', '-protocols'])) ?? '';
  const output = protocols.split(/Output:/i)[1] ?? '';
  if (!/^\s*rtmps\s*$/m.test(output)) return { available: false, detail: 'The server\'s ffmpeg was built without RTMPS (TLS) output.' };
  const encoders = (await run(spawnFn, ffmpegPath, ['-hide_banner', '-encoders'])) ?? '';
  if (!/^\s*A\S*\s+aac\s/m.test(encoders)) return { available: false, detail: 'The server\'s ffmpeg has no AAC audio encoder.' };
  return { available: true, detail: (version.split('\n')[0] ?? 'ffmpeg').slice(0, 120) };
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
  private probeResult: StudioProbe = { available: false, detail: 'Not checked yet.' };

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
