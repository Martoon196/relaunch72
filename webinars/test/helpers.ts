/**
 * Test harness: real SQL (node:sqlite) behind a D1-shaped API, plus fakes for Queues,
 * Durable Objects, Stream and Turnstile, and a controllable clock.
 */
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import type { Env, WebhookJob } from '../src/env.js';
import { SessionRoom, type RoomState } from '../src/room/session-room.js';
import type { Services } from '../src/services.js';
import type { StreamService } from '../src/lib/stream.js';
import { buildApp } from '../src/worker.js';

const MIGRATION = readFileSync(fileURLToPath(new URL('../migrations/0001_init.sql', import.meta.url)), 'utf8');

type Param = string | number | null | bigint | Uint8Array;
const toParam = (v: unknown): Param => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : (v as Param));
const plain = <T>(row: unknown): T => (row ? ({ ...(row as object) } as T) : (null as T));

class Stmt {
  constructor(private db: DatabaseSync, public sql: string, public params: Param[] = []) {}
  bind(...values: unknown[]) {
    return new Stmt(this.db, this.sql, values.map(toParam));
  }
  async first<T = Record<string, unknown>>(col?: string): Promise<T | null> {
    const row = this.db.prepare(this.sql).get(...this.params) as Record<string, unknown> | undefined;
    if (!row) return null;
    return (col ? row[col] : plain(row)) as T;
  }
  async all<T = Record<string, unknown>>() {
    const rows = this.db.prepare(this.sql).all(...this.params).map((r) => plain<T>(r));
    return { results: rows, success: true, meta: {} };
  }
  async run() {
    return this.exec();
  }
  exec() {
    const r = this.db.prepare(this.sql).run(...this.params);
    return { success: true, results: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }
}

export function createD1(): D1Database & { sqlite: DatabaseSync } {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(MIGRATION);
  const d1 = {
    sqlite: db,
    prepare: (sql: string) => new Stmt(db, sql),
    async batch(stmts: Stmt[]) {
      db.exec('BEGIN');
      try {
        const out = stmts.map((s) => (/^\s*select/i.test(s.sql) ? { success: true, results: db.prepare(s.sql).all(...s.params).map(plain), meta: {} } : s.exec()));
        db.exec('COMMIT');
        return out;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
    async exec(sql: string) {
      db.exec(sql);
      return { count: 0, duration: 0 };
    },
  };
  return d1 as unknown as D1Database & { sqlite: DatabaseSync };
}

export class FakeQueue {
  messages: { body: WebhookJob; delaySeconds?: number }[] = [];
  async send(body: WebhookJob, opts?: { delaySeconds?: number }) {
    this.messages.push({ body, delaySeconds: opts?.delaySeconds });
  }
  async sendBatch(msgs: { body: WebhookJob }[]) {
    this.messages.push(...msgs);
  }
}

export class FakeSocket {
  sent: Record<string, unknown>[] = [];
  closed: { code?: number; reason?: string } | null = null;
  private att: unknown = null;
  tags: string[] = [];
  send(s: string) {
    if (this.closed) throw new Error('closed');
    this.sent.push(JSON.parse(s));
  }
  close(code?: number, reason?: string) {
    this.closed = { code, reason };
  }
  serializeAttachment(v: unknown) {
    this.att = structuredClone(v);
  }
  deserializeAttachment() {
    return this.att;
  }
  ofType(type: string) {
    return this.sent.filter((m) => m.type === type);
  }
  last(type?: string) {
    const list = type ? this.ofType(type) : this.sent;
    return list[list.length - 1];
  }
}

export class FakeRoomState implements RoomState {
  data = new Map<string, unknown>();
  sockets: FakeSocket[] = [];
  alarm: number | null = null;
  storage = {
    get: async <T>(k: string) => structuredClone(this.data.get(k)) as T | undefined,
    put: async (k: string, v: unknown) => void this.data.set(k, structuredClone(v)),
    delete: async (k: string | string[]) => {
      for (const key of Array.isArray(k) ? k : [k]) this.data.delete(key);
      return true;
    },
    list: async <T>(o: { prefix: string; limit?: number; reverse?: boolean }) => {
      let keys = [...this.data.keys()].filter((k) => k.startsWith(o.prefix)).sort();
      if (o.reverse) keys.reverse();
      if (o.limit) keys = keys.slice(0, o.limit);
      return new Map(keys.map((k) => [k, structuredClone(this.data.get(k)) as T]));
    },
    deleteAll: async () => void this.data.clear(),
    getAlarm: async () => this.alarm,
    setAlarm: async (ms: number) => void (this.alarm = ms),
  };
  acceptWebSocket(ws: WebSocket, tags: string[] = []) {
    const s = ws as unknown as FakeSocket;
    s.tags = tags;
    this.sockets.push(s);
  }
  getWebSockets(tag?: string): WebSocket[] {
    return this.sockets.filter((s) => !s.closed && (!tag || s.tags.includes(tag))) as unknown as WebSocket[];
  }
}

/** DO namespace whose stubs route to in-process SessionRoom instances. */
export class FakeRoomNamespace {
  rooms = new Map<string, { room: SessionRoom; state: FakeRoomState }>();
  lastSocket: FakeSocket | null = null;
  constructor(private envRef: () => Pick<Env, 'DB' | 'WEBHOOKS'>, private clock: () => number) {}
  idFromName(name: string) {
    return { name, toString: () => name } as unknown as DurableObjectId;
  }
  room(name: string) {
    let r = this.rooms.get(name);
    if (!r) {
      const state = new FakeRoomState();
      const room = new SessionRoom(state, this.envRef());
      room.setClock(this.clock);
      r = { room, state };
      this.rooms.set(name, r);
    }
    return r;
  }
  get(id: DurableObjectId) {
    const name = (id as unknown as { name: string }).name;
    return {
      fetch: async (url: string, init?: RequestInit) => {
        const req = new Request(url, init);
        const { room } = this.room(name);
        if (new URL(req.url).pathname === '/ws') {
          // No WebSocketPair in Node: accept a fake socket directly.
          const raw = JSON.parse(req.headers.get('x-room-ctx') ?? '{}');
          const { meta, ...ctx } = raw;
          const sock = new FakeSocket();
          const ok = await room.accept(sock as unknown as WebSocket, ctx, meta);
          this.lastSocket = ok ? sock : null;
          return new Response(ok ? 'accepted' : 'forbidden', { status: ok ? 200 : 403 });
        }
        return room.fetch(req);
      },
    };
  }
}

export interface FakeStream extends StreamService {
  recording: { uid: string; duration: number; readyToStream: boolean } | null;
  calls: string[];
}

export function fakeStream(): FakeStream {
  const s: FakeStream = {
    recording: null,
    calls: [],
    async createLiveInput() {
      s.calls.push('createLiveInput');
      return { uid: 'live_input_1', rtmps: { url: 'rtmps://live.cloudflare.com:443/live/', streamKey: 'key123' }, srt: { url: 'srt://live.cloudflare.com:778', streamId: 'sid', passphrase: 'pp' }, webRTC: { url: 'https://customer-x.cloudflarestream.com/whip' } };
    },
    async createDirectUpload() {
      s.calls.push('createDirectUpload');
      return { uploadURL: 'https://upload.cloudflarestream.com/abc', uid: 'video_uploaded_1' };
    },
    async latestRecording() {
      s.calls.push('latestRecording');
      return s.recording;
    },
    async videoDetails(uid) {
      return { uid, duration: 3000, readyToStream: true };
    },
    async playback(uid, { live, ttlSeconds = 3600, nowMs = Date.now() }) {
      return { hls: `https://customer-x.cloudflarestream.com/TOKEN(${uid})/manifest/video.m3u8`, webrtc: live ? `https://customer-x.cloudflarestream.com/TOKEN(${uid})/webRTC/play` : null, expires_at: new Date(nowMs + ttlSeconds * 1000).toISOString() };
    },
  };
  return s;
}

export const ORIGIN = 'https://www.propinvest.co.uk';
export const BAD_ORIGIN = 'https://evil.example';

export function createHarness(startMs = Date.parse('2026-11-10T12:00:00Z')) {
  const clock = { now: startMs };
  const db = createD1();
  const queue = new FakeQueue();
  const stream = fakeStream();
  const turnstile = { ok: true, verify: async () => turnstile.ok };
  // eslint-disable-next-line prefer-const
  let env: Env;
  const rooms = new FakeRoomNamespace(() => env, () => clock.now);
  env = {
    DB: db,
    SESSION_ROOM: rooms as unknown as DurableObjectNamespace,
    WEBHOOKS: queue as unknown as Queue<WebhookJob>,
    PUBLIC_ORIGIN: 'https://webinars.growthhq.app',
    API_ORIGIN: 'https://api.webinars.growthhq.app',
    CDN_ORIGIN: 'https://cdn.webinars.growthhq.app',
    STREAM_CUSTOMER_CODE: 'x',
    TOKEN_SECRET: 'test-token-secret',
    DATA_KEY: Buffer.alloc(32, 7).toString('base64'),
    BOOTSTRAP_TOKEN: 'boot',
  };
  const services: Services = { stream, turnstile, now: () => clock.now };
  const app = buildApp(() => services);

  async function call(method: string, path: string, opts: { body?: unknown; headers?: Record<string, string>; origin?: string | null; key?: string; sk?: string; raw?: string } = {}) {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    if (opts.origin !== null) headers.origin = opts.origin ?? ORIGIN;
    if (opts.key) headers['x-ghq-key'] = opts.key;
    if (opts.sk) headers.authorization = `Bearer ${opts.sk}`;
    const res = await app.request(`https://api.webinars.growthhq.app${path}`, {
      method,
      headers,
      body: opts.raw ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
    }, env);
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json, text, headers: res.headers };
  }

  const keys = { account: '' };
  return { clock, db, queue, stream, turnstile, rooms, env, services, app, call, keys };
}

export type Harness = ReturnType<typeof createHarness>;

/** Bootstrap → brand → keys → webhook endpoint. */
export async function seedBrand(h: Harness, opts: { slug?: string; origins?: string[]; settings?: Record<string, unknown> } = {}) {
  const boot = await h.call('POST', '/v1/admin/bootstrap', { origin: null, headers: { 'x-bootstrap-token': 'boot' } });
  if (boot.status === 201) h.keys.account = boot.json.data.sk_live;
  const account = h.keys.account;
  const slug = opts.slug ?? 'prop-invest-uk';
  const brand = await h.call('POST', '/v1/admin/brands', {
    origin: null, sk: account,
    body: {
      name: slug === 'prop-invest-uk' ? 'Prop Invest UK' : slug, slug,
      theme: { colors: { primary: '#0b2545', accent: '#C8A04B' } },
      settings: {
        domains: { allowed_origins: opts.origins ?? [ORIGIN] },
        compliance: { risk_warning: 'Capital at risk.' },
        crm: { pipeline_id: 'pipe_1', stage_id: 'stage_1' },
        ...(opts.settings ?? {}),
      },
    },
  });
  if (brand.status !== 201) throw new Error(`brand create failed: ${brand.text}`);
  const brandId = brand.json.data.id as string;
  const pk = await h.call('POST', '/v1/admin/api-keys', { origin: null, sk: account, body: { type: 'pk', brand_id: brandId, name: 'site' } });
  const sk = await h.call('POST', '/v1/admin/api-keys', { origin: null, sk: account, body: { type: 'sk', brand_id: brandId, name: 'growth hq' } });
  const hook = await h.call('POST', '/v1/admin/webhook-endpoints', { origin: null, sk: sk.json.data.key, body: { url: 'https://hooks.growthhq.app/webinars', events: ['*'] } });
  return { account: account as string, brandId, pk: pk.json.data.key as string, sk: sk.json.data.key as string, webhookSecret: hook.json.data.secret as string };
}

export function eventsOf(h: Harness, type?: string) {
  const rows = h.db.sqlite.prepare(`SELECT type, data_json FROM events ${type ? 'WHERE type = ?' : ''} ORDER BY rowid`).all(...(type ? [type] : [])) as { type: string; data_json: string }[];
  return rows.map((r) => ({ type: r.type, payload: JSON.parse(r.data_json) }));
}
