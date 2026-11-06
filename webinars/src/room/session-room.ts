/**
 * SessionRoom — one Durable Object per session. Uses the WebSocket Hibernation API so idle
 * rooms cost nothing. Holds chat/Q&A/poll/CTA state, fans out to every viewer, and flushes
 * messages to D1 in batches from an alarm (durable via DO storage, so hibernation is safe).
 *
 * The API Worker authenticates every socket and passes a trusted context in `x-room-ctx`;
 * this object is never reachable from the internet directly.
 */
import type { Env, Mode } from '../env.js';
import { emitEvent } from '../lib/events.js';
import { newId, nowIso, parseJson } from '../lib/util.js';

export type Role = 'attendee' | 'host' | 'moderator';

export interface RoomMeta {
  sid: string;
  wid: string;
  bid: string;
  mode: Mode;
  kind: 'live' | 'evergreen' | 'on_demand';
  status: 'scheduled' | 'preview' | 'live' | 'ended';
  chat_enabled: boolean;
  qa_moderation: boolean;
  one_device: boolean;
  ended_at?: string;
}

export interface SocketCtx {
  role: Role;
  rid?: string;
  hid?: string;
  name: string;
  dev?: string;
  lastMsgAt?: number;
}

export interface RoomMessage {
  id: string;
  session_id: string;
  registrant_id: string | null;
  host_id: string | null;
  author_name: string;
  kind: 'chat' | 'question' | 'answer';
  parent_id: string | null;
  body: string;
  status: 'visible' | 'hidden' | 'pinned' | 'pending';
  done_at: string | null;
  created_at: string;
}

export interface ActiveCta { id: string; label: string; url: string; style: string; body: string | null; image_url: string | null }
export interface ActivePoll { id: string; question: string; options: string[]; show_results: boolean }

/** The bits of DurableObjectState we use — narrowed so tests can provide a fake. */
export interface RoomState {
  storage: {
    get<T>(key: string): Promise<T | undefined>;
    put(key: string, value: unknown): Promise<void>;
    delete(key: string | string[]): Promise<unknown>;
    list<T>(opts: { prefix: string; limit?: number; reverse?: boolean }): Promise<Map<string, T>>;
    deleteAll(): Promise<void>;
    getAlarm(): Promise<number | null>;
    setAlarm(ms: number): Promise<void>;
  };
  acceptWebSocket(ws: WebSocket, tags?: string[]): void;
  getWebSockets(tag?: string): WebSocket[];
  getTags?(ws: WebSocket): string[];
}

type RoomEnv = Pick<Env, 'DB' | 'WEBHOOKS'>;

const MAX_BODY = 500;
const RECENT_LIMIT = 200;
const SEND_INTERVAL_MS = 750;     // per-socket chat rate limit
const FLUSH_DELAY_MS = 2000;
const CLEANUP_AFTER_MS = 7 * 86_400_000;

export class SessionRoom {
  private meta: RoomMeta | null = null;
  private now: () => number = () => Date.now();

  constructor(private state: RoomState, private env: RoomEnv) {}

  /** Test hook. */
  setClock(fn: () => number) {
    this.now = fn;
  }

  // ---------- HTTP entry (from the API Worker only) ----------

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/ws') {
      if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return new Response('expected websocket', { status: 426 });
      const raw = parseJson<(SocketCtx & { meta: RoomMeta }) | null>(request.headers.get('x-room-ctx'), null);
      if (!raw?.meta) return new Response('missing ctx', { status: 400 });
      const { meta, ...ctx } = raw;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pair = new (globalThis as any).WebSocketPair() as { 0: WebSocket; 1: WebSocket };
      const ok = await this.accept(pair[1], ctx, meta);
      if (!ok) return new Response('forbidden', { status: 403 });
      return new Response(null, { status: 101, webSocket: pair[0] } as ResponseInit);
    }
    if (url.pathname === '/control' && request.method === 'POST') {
      const body = parseJson<Record<string, unknown>>(await request.text(), {});
      return Response.json(await this.control(body));
    }
    if (url.pathname === '/state') {
      return Response.json(await this.snapshot('host'));
    }
    return new Response('not found', { status: 404 });
  }

  // ---------- connections ----------

  async accept(ws: WebSocket, ctx: SocketCtx, meta: RoomMeta): Promise<boolean> {
    const stored = await this.loadMeta();
    // The Worker reads status from D1 (the source of truth) on every connect.
    this.meta = { ...meta, ended_at: stored?.ended_at ?? (meta.status === 'ended' ? nowIso(this.now()) : undefined) };
    await this.state.storage.put('meta', this.meta);

    if (ctx.role === 'attendee' && ctx.rid) {
      const banned = await this.state.storage.get<boolean>(`ban:${ctx.rid}`);
      if (banned) return false;
      if (this.meta.one_device) {
        for (const other of this.state.getWebSockets(`rid:${ctx.rid}`)) {
          this.send(other, { type: 'replaced', message: 'You joined from another device.' });
          try { other.close(4001, 'replaced'); } catch { /* already closed */ }
        }
      }
    }
    const tags = [`role:${ctx.role}`];
    if (ctx.rid) tags.push(`rid:${ctx.rid}`);
    this.state.acceptWebSocket(ws, tags);
    ws.serializeAttachment(ctx);
    this.send(ws, { type: 'hello', you: { role: ctx.role, name: ctx.name, registrant_id: ctx.rid ?? null }, ...(await this.snapshot(ctx.role, ctx.rid)) });
    await this.scheduleFlush(); // viewer count broadcast
    return true;
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const ctx = ws.deserializeAttachment() as SocketCtx | null;
    if (!ctx) return;
    const msg = parseJson<Record<string, unknown>>(typeof raw === 'string' ? raw : new TextDecoder().decode(raw), {});
    const meta = (this.meta ??= (await this.loadMeta()) ?? null);
    if (!meta) return;
    const isStaff = ctx.role === 'host' || ctx.role === 'moderator';

    switch (msg.type) {
      case 'ping':
        this.send(ws, { type: 'pong', ts: this.now() });
        return;
      case 'chat':
      case 'question': {
        if (meta.status === 'ended' && meta.kind !== 'on_demand') return this.send(ws, { type: 'error', code: 'ended', message: 'This session has ended' });
        if (msg.type === 'chat' && !meta.chat_enabled && !isStaff) return this.send(ws, { type: 'error', code: 'chat_disabled', message: 'Chat is off for this session' });
        const body = String(msg.body ?? '').trim().slice(0, MAX_BODY);
        if (!body) return;
        const now = this.now();
        if (ctx.lastMsgAt && now - ctx.lastMsgAt < SEND_INTERVAL_MS && !isStaff) return this.send(ws, { type: 'error', code: 'slow_down', message: 'Slow down a little' });
        ctx.lastMsgAt = now;
        ws.serializeAttachment(ctx);
        const m: RoomMessage = {
          id: newId('msg'),
          session_id: meta.sid,
          registrant_id: ctx.rid ?? null,
          host_id: ctx.hid ?? null,
          author_name: ctx.name.slice(0, 80),
          kind: msg.type,
          parent_id: null,
          body,
          status: msg.type === 'question' && meta.qa_moderation && !isStaff ? 'pending' : 'visible',
          done_at: null,
          created_at: nowIso(now),
        };
        await this.saveMessage(m);
        this.deliver(m);
        if (m.kind === 'question' && m.registrant_id) {
          await emitEvent(this.env, {
            brandId: meta.bid, mode: meta.mode, type: 'question.asked', registrantId: m.registrant_id, sessionId: meta.sid, webinarId: meta.wid,
            data: { message_id: m.id, body: m.body }, now,
          }).catch((err) => console.error('question.asked emit', err));
        }
        return;
      }
      case 'vote':
        if (!ctx.rid) return;
        return this.vote(ws, ctx, String(msg.poll_id ?? ''), String(msg.option ?? ''));
      default:
        if (isStaff) {
          const res = await this.control({ ...msg, action: msg.type, actor: { role: ctx.role, hid: ctx.hid, name: ctx.name } });
          if (res.error) this.send(ws, { type: 'error', code: res.error, message: res.error });
        }
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    try { ws.close(1000, 'bye'); } catch { /* already closed */ }
    await this.scheduleFlush();
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws);
  }

  // ---------- control (REST admin actions + staff socket actions) ----------

  async control(body: Record<string, unknown>): Promise<{ ok?: true; error?: string; [k: string]: unknown }> {
    const meta = (this.meta ??= (await this.loadMeta()) ?? null);
    const action = String(body.action ?? '');
    const actor = (body.actor ?? { role: 'host' }) as { role: Role; hid?: string; name?: string };
    const hostOnly = ['push_cta', 'hide_cta', 'push_poll', 'close_poll', 'status', 'erase'];
    if (hostOnly.includes(action) && actor.role === 'moderator') return { error: 'host_only' };

    switch (action) {
      case 'status': {
        const status = String(body.status) as RoomMeta['status'];
        if (meta) {
          meta.status = status;
          if (status === 'ended') meta.ended_at = nowIso(this.now());
          await this.state.storage.put('meta', meta);
        }
        this.broadcast({ type: 'session_status', status });
        if (status === 'ended') await this.state.storage.setAlarm(this.now() + FLUSH_DELAY_MS);
        return { ok: true };
      }
      case 'push_cta': {
        const cta = body.cta as ActiveCta | undefined;
        if (!cta?.id) return { error: 'cta required' };
        await this.state.storage.put('active_cta', cta);
        this.broadcast({ type: 'cta', cta });
        return { ok: true };
      }
      case 'hide_cta':
        await this.state.storage.delete('active_cta');
        this.broadcast({ type: 'cta', cta: null });
        return { ok: true };
      case 'push_poll': {
        const poll = body.poll as ActivePoll | undefined;
        if (!poll?.id) return { error: 'poll required' };
        await this.state.storage.put('active_poll', poll);
        this.broadcast({ type: 'poll', poll, results: poll.show_results ? await this.tally(poll.id) : null });
        return { ok: true };
      }
      case 'close_poll': {
        const poll = await this.state.storage.get<ActivePoll>('active_poll');
        await this.state.storage.delete('active_poll');
        this.broadcast({ type: 'poll', poll: null, closed_id: poll?.id ?? null, results: poll ? await this.tally(poll.id) : null });
        return { ok: true };
      }
      case 'announce': {
        const text = String(body.body ?? '').trim().slice(0, 1000);
        if (!text) return { error: 'body required' };
        this.broadcast({ type: 'announcement', body: text, ts: nowIso(this.now()) });
        return { ok: true };
      }
      case 'moderate': {
        const id = String(body.message_id ?? '');
        const m = await this.state.storage.get<RoomMessage>(`msg:${id}`);
        if (!m) return { error: 'message not found' };
        const op = String(body.op ?? '');
        const prevStatus = m.status;
        if (op === 'hide') m.status = 'hidden';
        else if (op === 'show' || op === 'approve' || op === 'unpin') m.status = 'visible';
        else if (op === 'pin') m.status = 'pinned';
        else if (op === 'done') m.done_at = nowIso(this.now());
        else if (op === 'undone') m.done_at = null;
        else return { error: 'unknown op' };
        await this.saveMessage(m);
        this.deliver(m, prevStatus, m.parent_id ? await this.state.storage.get<RoomMessage>(`msg:${m.parent_id}`) : undefined);
        return { ok: true };
      }
      case 'answer': {
        const q = await this.state.storage.get<RoomMessage>(`msg:${String(body.message_id ?? '')}`);
        if (!q) return { error: 'message not found' };
        const text = String(body.body ?? '').trim().slice(0, 2000);
        if (!text) return { error: 'body required' };
        const now = nowIso(this.now());
        const a: RoomMessage = {
          id: newId('msg'), session_id: q.session_id, registrant_id: null, host_id: actor.hid ?? 'host', author_name: actor.name ?? 'Host',
          kind: 'answer', parent_id: q.id, body: text, status: 'visible', done_at: null, created_at: now,
        };
        q.done_at = now;
        await this.saveMessage(q);
        await this.saveMessage(a);
        this.deliver(q, q.status);
        this.deliver(a, undefined, q);
        return { ok: true, answer_id: a.id };
      }
      case 'message_update': {
        // A REST PATCH already wrote D1; mirror it here and fan it out.
        const m = body.message as RoomMessage | undefined;
        if (!m?.id) return { error: 'message required' };
        const prev = await this.state.storage.get<RoomMessage>(`msg:${m.id}`);
        await this.saveMessage(m);
        this.deliver(m, prev?.status ?? m.status, m.parent_id ? await this.state.storage.get<RoomMessage>(`msg:${m.parent_id}`) : undefined);
        return { ok: true };
      }
      case 'ban': {
        const rid = String(body.registrant_id ?? '');
        if (!rid) return { error: 'registrant_id required' };
        await this.state.storage.put(`ban:${rid}`, true);
        for (const ws of this.state.getWebSockets(`rid:${rid}`)) {
          this.send(ws, { type: 'banned' });
          try { ws.close(4003, 'banned'); } catch { /* closed */ }
        }
        // Hide everything they said.
        const list = await this.state.storage.list<RoomMessage>({ prefix: 'msg:' });
        for (const m of list.values()) {
          if (m.registrant_id === rid && m.status !== 'hidden') {
            const prev = m.status;
            m.status = 'hidden';
            await this.saveMessage(m);
            this.deliver(m, prev);
          }
        }
        await this.env.DB.prepare('UPDATE registrants SET banned = 1 WHERE id = ?').bind(rid).run();
        return { ok: true };
      }
      case 'erase': {
        // GDPR erasure: forget a registrant's messages held in this room.
        const rids = new Set((body.registrant_ids as string[] | undefined) ?? []);
        const list = await this.state.storage.list<RoomMessage>({ prefix: 'msg:' });
        const keys: string[] = [];
        const ids = new Set<string>();
        for (const [k, m] of list) if (m.registrant_id && rids.has(m.registrant_id)) { keys.push(k, `pending:${m.id}`); ids.add(m.id); }
        const idx = await this.state.storage.list<string>({ prefix: 'idx:' });
        for (const [k, id] of idx) if (ids.has(id)) keys.push(k);
        for (const rid of rids) keys.push(`ban:${rid}`);
        if (keys.length) await this.state.storage.delete(keys);
        return { ok: true, removed: ids.size };
      }
      default:
        return { error: 'unknown action' };
    }
  }

  // ---------- polls ----------

  private async vote(ws: WebSocket, ctx: SocketCtx, pollId: string, option: string) {
    const meta = this.meta!;
    const poll = await this.env.DB.prepare('SELECT id, options_json, crm_field, question FROM polls WHERE id = ? AND webinar_id = ?')
      .bind(pollId, meta.wid).first<{ id: string; options_json: string; crm_field: string | null; question: string }>();
    if (!poll) return this.send(ws, { type: 'error', code: 'poll_not_found', message: 'Poll not found' });
    if (!parseJson<string[]>(poll.options_json, []).includes(option)) return this.send(ws, { type: 'error', code: 'invalid_option', message: 'Invalid option' });
    const now = this.now();
    const res = await this.env.DB.prepare('INSERT INTO poll_votes (poll_id, registrant_id, session_id, option, created_at) VALUES (?,?,?,?,?) ON CONFLICT (poll_id, registrant_id) DO NOTHING')
      .bind(poll.id, ctx.rid, meta.sid, option, nowIso(now)).run();
    const counted = (res.meta?.changes ?? 0) > 0;
    if (counted) {
      const key = `tally:${poll.id}`;
      const t = (await this.state.storage.get<Record<string, number>>(key)) ?? {};
      t[option] = (t[option] ?? 0) + 1;
      await this.state.storage.put(key, t);
      await emitEvent(this.env, {
        brandId: meta.bid, mode: meta.mode, type: 'poll.answered', registrantId: ctx.rid!, sessionId: meta.sid, webinarId: meta.wid,
        data: { poll_id: poll.id, question: poll.question, option, crm_field: poll.crm_field }, now,
      }).catch((err) => console.error('poll.answered emit', err));
    }
    this.send(ws, { type: 'voted', poll_id: poll.id, option, counted });
    const active = await this.state.storage.get<ActivePoll>('active_poll');
    const results = await this.tally(poll.id);
    this.broadcastTo('role:host', { type: 'poll_results', poll_id: poll.id, results });
    this.broadcastTo('role:moderator', { type: 'poll_results', poll_id: poll.id, results });
    if (active?.id === poll.id && active.show_results) this.broadcastTo('role:attendee', { type: 'poll_results', poll_id: poll.id, results });
  }

  private async tally(pollId: string): Promise<Record<string, number>> {
    return (await this.state.storage.get<Record<string, number>>(`tally:${pollId}`)) ?? {};
  }

  // ---------- messages ----------

  private async saveMessage(m: RoomMessage) {
    await this.state.storage.put(`msg:${m.id}`, m);
    await this.state.storage.put(`idx:${m.created_at}:${m.id}`, m.id);
    await this.state.storage.put(`pending:${m.id}`, m);
    await this.scheduleFlush();
  }

  /** Who may see a message: staff see everything; attendees see visible/pinned, plus their own pending questions. */
  private visibleTo(m: RoomMessage, role: Role, rid?: string): boolean {
    if (role !== 'attendee') return true;
    if (m.status === 'visible' || m.status === 'pinned') return true;
    return m.status === 'pending' && !!rid && m.registrant_id === rid;
  }

  /** Answers follow their question's visibility; everything else uses its own status. */
  private canSee(m: RoomMessage, parent: RoomMessage | undefined, role: Role, rid?: string): boolean {
    if (m.kind === 'answer' && parent) return m.status !== 'hidden' && this.visibleTo(parent, role, rid);
    return this.visibleTo(m, role, rid);
  }

  /** Fan a new/updated message out. If it became invisible to someone, tell them to remove it. */
  private deliver(m: RoomMessage, prevStatus?: RoomMessage['status'], parent?: RoomMessage) {
    const isUpdate = prevStatus !== undefined;
    for (const ws of this.state.getWebSockets()) {
      const ctx = ws.deserializeAttachment() as SocketCtx | null;
      if (!ctx) continue;
      if (this.canSee(m, parent, ctx.role, ctx.rid)) this.send(ws, { type: isUpdate ? 'message_update' : 'message', message: m });
      else if (isUpdate) this.send(ws, { type: 'message_removed', id: m.id });
    }
  }

  private async recentMessages(): Promise<RoomMessage[]> {
    const idx = await this.state.storage.list<string>({ prefix: 'idx:', reverse: true, limit: RECENT_LIMIT });
    const out: RoomMessage[] = [];
    for (const id of idx.values()) {
      const m = await this.state.storage.get<RoomMessage>(`msg:${id}`);
      if (m) out.push(m);
    }
    return out.reverse();
  }

  private async snapshot(role: Role, rid?: string) {
    const meta = this.meta ?? (await this.loadMeta());
    const all = await this.recentMessages();
    const byId = new Map(all.map((m) => [m.id, m]));
    const messages = all.filter((m) => this.canSee(m, m.parent_id ? byId.get(m.parent_id) : undefined, role, rid));
    const poll = (await this.state.storage.get<ActivePoll>('active_poll')) ?? null;
    return {
      status: meta?.status ?? 'scheduled',
      chat_enabled: meta?.chat_enabled ?? true,
      viewers: this.viewerCount(),
      messages,
      active_cta: (await this.state.storage.get<ActiveCta>('active_cta')) ?? null,
      active_poll: poll,
      poll_results: poll && (role !== 'attendee' || poll.show_results) ? await this.tally(poll.id) : null,
    };
  }

  private viewerCount(): number {
    return this.state.getWebSockets('role:attendee').length;
  }

  // ---------- alarm: flush to D1, broadcast viewer count, cleanup ----------

  private async scheduleFlush() {
    const cur = await this.state.storage.getAlarm();
    if (cur === null) await this.state.storage.setAlarm(this.now() + FLUSH_DELAY_MS);
  }

  async alarm(): Promise<void> {
    const meta = this.meta ?? (await this.loadMeta());
    await this.flush();

    const viewers = this.viewerCount();
    const last = await this.state.storage.get<number>('last_viewers');
    if (last !== viewers) {
      await this.state.storage.put('last_viewers', viewers);
      this.broadcast({ type: 'viewers', count: viewers });
    }

    if (meta?.ended_at && this.now() - Date.parse(meta.ended_at) > CLEANUP_AFTER_MS && this.state.getWebSockets().length === 0) {
      await this.state.storage.deleteAll(); // D1 is the system of record; this was only the live cache
      return;
    }
    if (meta?.ended_at) await this.state.storage.setAlarm(Date.parse(meta.ended_at) + CLEANUP_AFTER_MS + 60_000);
  }

  async flush(): Promise<number> {
    const pending = await this.state.storage.list<RoomMessage>({ prefix: 'pending:', limit: 100 });
    if (pending.size === 0) return 0;
    const stmts = [...pending.values()].map((m) =>
      this.env.DB.prepare(
        `INSERT INTO messages (id, session_id, registrant_id, host_id, author_name, kind, parent_id, body, status, done_at, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT (id) DO UPDATE SET status = excluded.status, done_at = excluded.done_at, body = excluded.body`,
      ).bind(m.id, m.session_id, m.registrant_id, m.host_id, m.author_name, m.kind, m.parent_id, m.body, m.status, m.done_at, m.created_at),
    );
    try {
      await this.env.DB.batch(stmts);
      await this.state.storage.delete([...pending.keys()]);
    } catch (err) {
      console.error('room flush failed; will retry', err);
      await this.state.storage.setAlarm(this.now() + 10_000);
      return 0;
    }
    if (pending.size === 100) await this.state.storage.setAlarm(this.now() + 100);
    return pending.size;
  }

  // ---------- plumbing ----------

  private async loadMeta(): Promise<RoomMeta | null> {
    return (await this.state.storage.get<RoomMeta>('meta')) ?? null;
  }

  private send(ws: WebSocket, data: unknown) {
    try {
      ws.send(JSON.stringify(data));
    } catch {
      /* socket gone */
    }
  }

  private broadcast(data: unknown) {
    const s = JSON.stringify(data);
    for (const ws of this.state.getWebSockets()) {
      try { ws.send(s); } catch { /* gone */ }
    }
  }

  private broadcastTo(tag: string, data: unknown) {
    const s = JSON.stringify(data);
    for (const ws of this.state.getWebSockets(tag)) {
      try { ws.send(s); } catch { /* gone */ }
    }
  }
}
