/**
 * <ghq-room> — waiting room, then player + chat / Q&A / polls / CTA. Also serves replays.
 * Auth: magic-link token → POST /join → 4h session token (+1h signed playback, refreshed).
 */
import { html, css, LitElement, nothing } from 'lit';
import { Api, ApiError, deviceId, emit, store } from './api.js';
import { localDate, localDateTime, localTime, timeOnly } from './format.js';
import { icon } from './icons.js';
import './player.js';
import { base, hueFor, initials } from './styles.js';
import type { ChatMessage, Cta, JoinPayload, Playback, Poll, RoomState } from './types.js';
import { countdownTiles, presenterCard, tilesCss, tokenKey } from './views.js';

const HEARTBEAT_MS = 30_000;

export class GhqRoom extends LitElement {
  static properties = {
    api: { attribute: false },
    slug: {},
    token: {},
    _p: { state: true },
    _room: { state: true },
    _playback: { state: true },
    _fetchedAt: { state: true },
    _error: { state: true },
    _now: { state: true },
    _messages: { state: true },
    _viewers: { state: true },
    _pushedCta: { state: true },
    _pushedPoll: { state: true },
    _pollResults: { state: true },
    _position: { state: true },
    _tab: { state: true },
    _announcement: { state: true },
    _conn: { state: true },
    _panelOpen: { state: true },
    _notice: { state: true },
    _unread: { state: true },
  };
  declare api: Api;
  declare slug: string;
  declare token: string | null;
  declare _p: JoinPayload | null;
  declare _room: RoomState | null;
  declare _playback: Playback | null;
  declare _fetchedAt: number;
  declare _error: { code: string; message: string } | null;
  declare _now: number;
  declare _messages: ChatMessage[];
  declare _viewers: number;
  declare _pushedCta: Cta | null;
  declare _pushedPoll: Poll | null;
  declare _pollResults: Record<string, Record<string, number>>;
  declare _position: number;
  declare _tab: 'chat' | 'qa';
  declare _announcement: string | null;
  declare _conn: 'connecting' | 'open' | 'closed';
  declare _panelOpen: boolean;
  declare _notice: string | null;
  declare _unread: number;

  private ws: WebSocket | null = null;
  private wsRetry = 0;
  private wsTimer: number | undefined;
  private tick: number | undefined;
  private hb: number | undefined;
  private refreshTimer: number | undefined;
  private playing = false;
  private stopped = false;

  static styles = [base, tilesCss, css`
    .layout { display: grid; gap: 16px; grid-template-columns: 1fr; align-items: start; }
    @media (min-width: 960px) { .layout.with-panel { grid-template-columns: minmax(0, 1fr) 350px; } }
    .head { display: flex; gap: 12px; align-items: center; justify-content: space-between; flex-wrap: wrap; margin-bottom: 12px; }
    .head h1 { font-size: 1.35rem; margin: 0; }
    .status { display: flex; gap: 8px; align-items: center; }
    .conn { display: inline-flex; align-items: center; gap: 6px; font-size: .75rem; color: var(--ghq-muted); }

    /* side panel */
    .panel { display: flex; flex-direction: column; height: min(72vh, 680px); padding: 0; overflow: hidden; }
    @media (max-width: 959px) { .panel { height: 60vh; } }
    .tabs { display: flex; border-bottom: 1px solid var(--ghq-border); padding: 0 6px; }
    .tabs button { flex: 1; border-radius: 0; border: none; background: none; color: var(--ghq-muted); min-height: 48px; position: relative; gap: 8px; }
    .tabs button:hover { transform: none; box-shadow: none; color: var(--ghq-text); }
    .tabs button svg { width: 17px; height: 17px; }
    .tabs button[aria-selected='true'] { color: var(--ghq-text); }
    .tabs button[aria-selected='true']::after { content: ''; position: absolute; left: 14px; right: 14px; bottom: -1px; height: 3px; border-radius: 3px 3px 0 0; background: var(--ghq-accent); }
    .tabs .count { font-size: .68rem; font-weight: 700; padding: 1px 7px; border-radius: 999px; background: var(--_accent-soft); color: var(--ghq-accent); }
    .msgs { flex: 1; overflow-y: auto; padding: 14px; display: flex; flex-direction: column; gap: 12px; scroll-behavior: smooth; overscroll-behavior: contain; }
    .msg { display: flex; gap: 10px; align-items: flex-start; font-size: .92rem; animation: ghq-rise .25s var(--_ease) both; }
    .msg .avatar { width: 30px; height: 30px; font-size: .68rem; margin-top: 2px; }
    .msg .b { flex: 1; min-width: 0; }
    .msg .who { font-weight: 700; font-size: .82rem; display: flex; align-items: center; gap: 6px; }
    .msg .who .t { font-weight: 500; color: var(--ghq-muted); font-size: .72rem; }
    .msg .who .host { font-size: .62rem; font-weight: 800; letter-spacing: .06em; text-transform: uppercase; padding: 1px 6px; border-radius: 999px; background: var(--ghq-accent); color: #fff; }
    .msg .txt { overflow-wrap: anywhere; }
    .msg.host .avatar { background: var(--ghq-accent); }
    .msg.pinned { background: var(--_accent-soft); border: 1px solid var(--_accent-line); border-radius: calc(var(--ghq-radius) * .8); padding: 10px 12px; }
    .msg .meta { font-size: .72rem; color: var(--ghq-muted); display: inline-flex; gap: 5px; align-items: center; }
    .msg .meta svg { width: 12px; height: 12px; }
    .answer { margin-top: 8px; padding: 8px 10px; border-left: 3px solid var(--ghq-accent); background: var(--ghq-surface); border-radius: 0 8px 8px 0; font-size: .88rem; }
    .answer .who { font-weight: 700; color: var(--ghq-accent); }
    .empty { margin: auto; text-align: center; color: var(--ghq-muted); font-size: .88rem; padding: 20px; }
    .empty svg { width: 28px; height: 28px; color: var(--ghq-accent); margin-bottom: 6px; }
    .compose { display: flex; gap: 8px; padding: 10px; border-top: 1px solid var(--ghq-border); background: var(--ghq-surface-2); }
    .compose input { flex: 1; min-height: 44px; background: var(--ghq-surface); }
    .compose button { min-height: 44px; width: 46px; padding: 0; }
    .compose button svg { width: 18px; height: 18px; }

    /* offer + poll */
    .cta { display: flex; gap: 16px; align-items: center; justify-content: space-between; flex-wrap: wrap; margin-top: 16px; border-color: var(--_accent-line); position: relative; overflow: hidden; }
    .cta::before { content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 5px; background: linear-gradient(var(--ghq-accent), var(--ghq-primary)); }
    .cta.card-style { flex-direction: column; align-items: stretch; }
    .cta img { max-width: 100%; border-radius: calc(var(--ghq-radius) * .7); }
    .cta .k { font-size: .7rem; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; color: var(--ghq-accent); display: flex; gap: 6px; align-items: center; margin-bottom: 4px; }
    .cta .k svg { width: 14px; height: 14px; }
    .cta strong { font-size: 1.05rem; }
    .poll { margin-top: 16px; }
    .poll .q { display: flex; gap: 8px; align-items: flex-start; font-weight: 700; font-size: 1.02rem; }
    .poll .q svg { width: 20px; height: 20px; color: var(--ghq-accent); flex: none; margin-top: 2px; }
    .poll .opts { display: grid; gap: 8px; }
    .poll .opt { position: relative; justify-content: space-between; background: var(--ghq-surface); color: var(--ghq-text); border: 1.5px solid var(--ghq-border); font-weight: 500; overflow: hidden; }
    .poll .opt:hover:not(:disabled) { border-color: var(--ghq-accent); transform: none; box-shadow: none; }
    .poll .opt[aria-pressed='true'] { border-color: var(--ghq-accent); font-weight: 700; }
    .poll .opt .fill { position: absolute; left: 0; top: 0; bottom: 0; background: var(--_accent-soft); transition: width .6s var(--_ease); z-index: 0; }
    .poll .opt > span { position: relative; z-index: 1; display: inline-flex; gap: 8px; align-items: center; }
    .poll .opt svg { width: 16px; height: 16px; color: var(--ghq-accent); }
    .poll .pct { font-variant-numeric: tabular-nums; color: var(--ghq-muted); font-weight: 600; }
    .poll .thanks { display: flex; gap: 6px; align-items: center; }
    .poll .thanks svg { width: 16px; height: 16px; color: #10b981; }

    /* waiting room */
    .wait { text-align: center; padding: 40px 24px; background: radial-gradient(ellipse at top, var(--_accent-soft), transparent 60%), var(--ghq-surface-2); }
    .wait .when { font-size: 1.05rem; font-weight: 600; }
    .wait .when span { color: var(--ghq-muted); font-weight: 500; }
    .wait .tiles { margin: 18px 0 14px; }
    .wait .open { display: inline-flex; align-items: center; gap: 8px; font-weight: 600; color: var(--ghq-text); }
    .wait .presenters { display: flex; flex-wrap: wrap; justify-content: center; gap: 20px 32px; margin: 26px auto 0; max-width: 720px; text-align: left; }
    .wait .presenter { display: flex; gap: 12px; align-items: flex-start; max-width: 320px; }
    .wait .agenda { text-align: left; max-width: 480px; margin: 26px auto 0; }
    .wait .agenda li { display: flex; gap: 10px; padding: 8px 0; border-top: 1px solid var(--ghq-border); }
    .wait .agenda li .t { color: var(--ghq-accent); font-weight: 700; font-variant-numeric: tabular-nums; min-width: 44px; }
    .chips { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
    .wait .chips { justify-content: center; margin-top: 22px; }
    .chips a { text-decoration: none; color: var(--ghq-text); }

    .end { text-align: center; padding: 40px 24px; }
    .end .ic { width: 60px; height: 60px; border-radius: 50%; display: grid; place-items: center; margin: 0 auto 14px; background: var(--_accent-soft); color: var(--ghq-accent); }
    .end .ic svg { width: 30px; height: 30px; }
    .announce { display: flex; justify-content: space-between; gap: 10px; align-items: center; padding: 10px 14px; margin-bottom: 12px; border-radius: calc(var(--ghq-radius) * .8); background: var(--ghq-primary); color: #fff; animation: ghq-rise .3s var(--_ease) both; }
    .announce .l { display: flex; gap: 10px; align-items: center; }
    .announce svg { width: 18px; height: 18px; flex: none; }
    .announce button { background: none; border: none; min-height: 0; padding: 4px; color: #fff; }
    .toggle { width: 100%; margin-top: 12px; }
    @media (min-width: 960px) { .toggle { display: none; } }
    .below { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 12px; }
  `];

  constructor() {
    super();
    this.slug = '';
    this.token = null;
    this._p = null;
    this._room = null;
    this._playback = null;
    this._fetchedAt = Date.now();
    this._error = null;
    this._now = Date.now();
    this._messages = [];
    this._viewers = 0;
    this._pushedCta = null;
    this._pushedPoll = null;
    this._pollResults = {};
    this._position = 0;
    this._tab = 'chat';
    this._announcement = null;
    this._conn = 'connecting';
    this._panelOpen = typeof matchMedia === 'function' ? matchMedia('(min-width: 960px)').matches : true;
    this._notice = null;
    this._unread = 0;
  }

  // ---------- lifecycle ----------

  connectedCallback() {
    super.connectedCallback();
    this.stopped = false;
    this.tick = window.setInterval(() => (this._now = Date.now()), 1000);
    addEventListener('pagehide', this.onLeave);
    void this.join();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.stopped = true;
    this.onLeave();
    removeEventListener('pagehide', this.onLeave);
    clearInterval(this.tick);
    clearInterval(this.hb);
    clearTimeout(this.refreshTimer);
    clearTimeout(this.wsTimer);
    this.ws?.close();
  }

  private magicToken(): string | null {
    const fromUrl = new URLSearchParams(location.search).get('ghq_token');
    if (fromUrl) {
      store.set(tokenKey(this.api.key, this.slug), fromUrl);
      // Keep the credential out of the address bar, history and analytics.
      const u = new URL(location.href);
      u.searchParams.delete('ghq_token');
      u.searchParams.delete('ghq_view');
      history.replaceState(history.state, '', u.toString());
      return fromUrl;
    }
    return this.token || store.get(tokenKey(this.api.key, this.slug));
  }

  private async join() {
    const token = this.magicToken();
    if (!token) {
      this._error = { code: 'no_token', message: 'Open the personal link from your registration email to join.' };
      return;
    }
    try {
      const p = await this.api.req<JoinPayload>('POST', '/join', { token, device_id: deviceId() });
      this._p = p;
      this.applyRoom(p.room, p.playback);
      emit(this, 'ghq:joined', { webinar: this.slug, state: p.room.state, session_id: p.session.id });
      this.connectWs();
    } catch (e) {
      const err = e instanceof ApiError ? e : new ApiError(0, 'error', 'Could not join');
      if (err.code === 'invalid_link') store.del(tokenKey(this.api.key, this.slug));
      this._error = { code: err.code, message: err.message };
    }
  }

  private applyRoom(room: RoomState, playback: Playback | null) {
    this._room = room;
    if (playback) {
      this._playback = playback;
      this._fetchedAt = Date.now();
      this.startHeartbeat();
      // Refresh the signed URL 5 minutes before it expires.
      clearTimeout(this.refreshTimer);
      const due = Date.parse(playback.expires_at) - Date.now() - 5 * 60_000;
      this.refreshTimer = window.setTimeout(() => void this.refreshPlayback(), Math.max(30_000, due));
    } else if (room.state === 'scheduled' || room.state === 'waiting' || room.state === 'processing') {
      // Re-check at the start time (evergreen) or every 20s once the room is open (live, waiting on the host).
      clearTimeout(this.refreshTimer);
      const startIn = room.starts_at ? Date.parse(room.starts_at) - Date.now() : 60_000;
      const delay = room.state === 'waiting' || room.state === 'processing' ? Math.min(20_000, Math.max(1000, startIn)) : Math.min(Math.max(5_000, startIn - 15 * 60_000), 2 ** 31 - 1);
      this.refreshTimer = window.setTimeout(() => void this.refreshPlayback(), delay);
    }
  }

  private async refreshPlayback() {
    if (this.stopped || !this._p) return;
    try {
      const r = await this.api.req<{ room: RoomState; playback: Playback | null }>('POST', '/playback', undefined, this._p.session_token);
      this.applyRoom(r.room, r.playback);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'session_expired') return void this.join();
      this.refreshTimer = window.setTimeout(() => void this.refreshPlayback(), 15_000);
    }
  }

  // ---------- tracking ----------

  private startHeartbeat() {
    if (this.hb) return;
    this.hb = window.setInterval(() => {
      if (!this._p) return;
      this.api.req('POST', '/events', { type: 'heartbeat', position_s: Math.floor(this._position), playing: this.playing }, this._p.session_token).catch(() => undefined);
    }, HEARTBEAT_MS);
  }

  private onLeave = () => {
    if (!this._p || !this._playback) return;
    this.api.beacon('/events', { session_token: this._p.session_token, type: 'leave', position_s: Math.floor(this._position) });
  };

  private onTime(e: CustomEvent<{ position: number; playing: boolean }>) {
    this._position = e.detail.position;
    this.playing = e.detail.playing;
  }

  /** Seconds into the content, for timed CTAs/polls. Live uses wall clock since the start. */
  private contentPosition(): number {
    const p = this._p;
    if (this._room?.state === 'live' && p?.webinar.type === 'live' && p.session.starts_at) {
      return Math.max(0, (this._now - Date.parse(p.session.starts_at)) / 1000);
    }
    return this._position;
  }

  // ---------- websocket ----------

  private connectWs() {
    if (!this._p || this.stopped) return;
    this._conn = 'connecting';
    const ws = new WebSocket(this._p.ws_url);
    this.ws = ws;
    ws.onopen = () => { this._conn = 'open'; this.wsRetry = 0; };
    ws.onmessage = (ev) => this.onWs(JSON.parse(String(ev.data)));
    ws.onclose = (ev) => {
      this._conn = 'closed';
      if (this.stopped || ev.code === 4001 || ev.code === 4003) return;
      const delay = Math.min(30_000, 1000 * 2 ** this.wsRetry++) + Math.random() * 1000;
      this.wsTimer = window.setTimeout(() => (this.wsRetry > 3 ? void this.join() : this.connectWs()), delay);
    };
  }

  private send(msg: Record<string, unknown>) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private upsert(m: ChatMessage) {
    const i = this._messages.findIndex((x) => x.id === m.id);
    this._messages = i >= 0 ? this._messages.map((x) => (x.id === m.id ? m : x)) : [...this._messages, m].slice(-300);
    if (i < 0 && m.kind === 'chat' && this._tab !== 'chat' && m.registrant_id !== this._p?.registrant.id) this._unread++;
  }

  private onWs(m: Record<string, any>) {
    switch (m.type) {
      case 'hello':
        this._messages = m.messages ?? [];
        this._viewers = m.viewers ?? 0;
        this._pushedCta = m.active_cta ?? null;
        this._pushedPoll = m.active_poll ?? null;
        if (m.active_poll && m.poll_results) this._pollResults = { ...this._pollResults, [m.active_poll.id]: m.poll_results };
        void this.updateComplete.then(() => this.scrollChat(true));
        break;
      case 'message':
      case 'message_update':
        this.upsert(m.message);
        void this.updateComplete.then(() => this.scrollChat());
        break;
      case 'message_removed':
        this._messages = this._messages.filter((x) => x.id !== m.id);
        break;
      case 'viewers':
        this._viewers = m.count;
        break;
      case 'cta':
        this._pushedCta = m.cta;
        break;
      case 'poll':
        this._pushedPoll = m.poll;
        if (m.results && (m.poll?.id || m.closed_id)) this._pollResults = { ...this._pollResults, [m.poll?.id ?? m.closed_id]: m.results };
        break;
      case 'poll_results':
        this._pollResults = { ...this._pollResults, [m.poll_id]: m.results };
        break;
      case 'voted':
        store.set(`ghq:vote:${m.poll_id}`, m.option);
        this.requestUpdate();
        break;
      case 'announcement':
        this._announcement = m.body;
        break;
      case 'session_status':
        void this.refreshPlayback();
        break;
      case 'replaced':
        this._notice = 'You joined from another device, so this window was disconnected.';
        break;
      case 'banned':
        this._error = { code: 'banned', message: 'You have been removed from this session.' };
        break;
      case 'error':
        this._notice = m.message;
        setTimeout(() => (this._notice = null), 4000);
        break;
    }
  }

  private scrollChat(force = false) {
    const el = this.renderRoot.querySelector('.msgs');
    if (el && (force || el.scrollHeight - el.scrollTop - el.clientHeight < 160)) el.scrollTop = el.scrollHeight;
  }

  // ---------- actions ----------

  private post(e: Event, kind: 'chat' | 'question') {
    e.preventDefault();
    const input = (e.target as HTMLFormElement).querySelector('input')!;
    const body = input.value.trim();
    if (!body) return;
    this.send({ type: kind, body });
    input.value = '';
  }

  private clickCta(c: Cta) {
    if (this._p) {
      this.api.req('POST', '/events', { type: 'cta_click', cta_id: c.id, position_s: Math.floor(this.contentPosition()) }, this._p.session_token).catch(() => undefined);
    }
    emit(this, 'ghq:cta-click', { webinar: this.slug, cta_id: c.id, label: c.label, url: c.url });
    window.open(c.url, '_blank', 'noopener');
  }

  private switchTab(tab: 'chat' | 'qa') {
    this._tab = tab;
    if (tab === 'chat') this._unread = 0;
    void this.updateComplete.then(() => this.scrollChat(true));
  }

  // ---------- render ----------

  private activeCta(): Cta | null {
    if (this._pushedCta) return this._pushedCta;
    const pos = this.contentPosition();
    return this._p?.ctas.find((c) => c.push_mode !== 'manual' && c.show_at_s != null && pos >= c.show_at_s && (c.hide_at_s == null || pos < c.hide_at_s)) ?? null;
  }

  private activePoll(): Poll | null {
    if (this._pushedPoll) return this._pushedPoll;
    const pos = this.contentPosition();
    return this._p?.polls.find((p) => p.show_at_s != null && pos >= p.show_at_s && !store.get(`ghq:vote:${p.id}`)) ?? null;
  }

  private renderCta(c: Cta) {
    return html`<div class="card cta rise ${c.style === 'card' ? 'card-style' : ''}" role="complementary" aria-label="Offer">
      ${c.image_url ? html`<img src=${c.image_url} alt="">` : nothing}
      <div>
        ${c.style === 'card' ? html`<div class="k">${icon.sparkle()} Offer</div><strong>${c.label}</strong>` : nothing}
        ${c.body ? html`<p class="small muted" style="margin:4px 0 0">${c.body}</p>` : nothing}
      </div>
      <button class="accent" @click=${() => this.clickCta(c)}>${c.label} ${icon.external()}</button>
    </div>`;
  }

  private renderPoll(p: Poll) {
    const voted = store.get(`ghq:vote:${p.id}`);
    const results = this._pollResults[p.id];
    const total = results ? Object.values(results).reduce((a, b) => a + b, 0) : 0;
    const pct = (o: string) => (results && total ? Math.round(((results[o] ?? 0) / total) * 100) : 0);
    return html`<div class="card poll stack rise" role="group" aria-label="Poll">
      <div class="q">${icon.poll()}<span>${p.question}</span></div>
      <div class="opts">
        ${p.options.map((o) => html`
          <button class="opt" ?disabled=${!!voted} aria-pressed=${voted === o ? 'true' : 'false'} @click=${() => this.send({ type: 'vote', poll_id: p.id, option: o })}>
            ${results ? html`<span class="fill" style="width:${pct(o)}%"></span>` : nothing}
            <span>${voted === o ? icon.check() : nothing}${o}</span>${results ? html`<span class="pct">${pct(o)}%</span>` : nothing}
          </button>`)}
      </div>
      ${results ? html`<p class="xs muted" style="margin:0">${total} ${total === 1 ? 'vote' : 'votes'}</p>` : voted ? html`<p class="small muted thanks" style="margin:0">${icon.checkCircle()} Thanks — your answer was recorded.</p>` : nothing}
    </div>`;
  }

  private renderMessage(m: ChatMessage, answers: ChatMessage[]) {
    const fromHost = !!m.host_id;
    return html`<div class="msg ${fromHost ? 'host' : ''} ${m.status === 'pinned' ? 'pinned' : ''}">
      <span class="avatar" style="--h:${hueFor(m.author_name)}">${initials(m.author_name)}</span>
      <div class="b">
        <div class="who">${m.author_name}${fromHost ? html`<span class="host">Host</span>` : nothing}<span class="t">${timeOnly(m.created_at)}</span>
          ${m.status === 'pinned' ? html`<span class="meta">${icon.pin()} Pinned</span>` : nothing}</div>
        <div class="txt">${m.body}</div>
        ${m.status === 'pending' ? html`<div class="meta">${icon.clock()} Awaiting approval</div>` : m.kind === 'question' && m.done_at && !answers.length ? html`<div class="meta">${icon.checkCircle()} Answered live</div>` : nothing}
        ${answers.map((a) => html`<div class="answer"><span class="who">${a.author_name}</span> ${a.body}</div>`)}
      </div>
    </div>`;
  }

  private renderPanel() {
    const p = this._p!;
    const chatOn = p.config.defaults.chat_enabled && this._room?.state === 'live';
    const tab = chatOn ? this._tab : 'qa';
    const answers = (id: string) => this._messages.filter((m) => m.kind === 'answer' && m.parent_id === id);
    const list = this._messages.filter((m) => (tab === 'chat' ? m.kind === 'chat' : m.kind === 'question'));
    const pinned = list.filter((m) => m.status === 'pinned');
    const rest = list.filter((m) => m.status !== 'pinned');
    const isReplay = this._room?.state !== 'live';
    const qCount = this._messages.filter((m) => m.kind === 'question').length;
    return html`
      <aside class="card panel" ?hidden=${!this._panelOpen} aria-label="Chat and questions">
        <div class="tabs" role="tablist">
          ${chatOn ? html`<button role="tab" aria-selected=${tab === 'chat'} @click=${() => this.switchTab('chat')}>${icon.chat()} Chat ${this._unread ? html`<span class="count">${this._unread}</span>` : nothing}</button>` : nothing}
          <button role="tab" aria-selected=${tab === 'qa'} @click=${() => this.switchTab('qa')}>${icon.question()} Questions ${qCount ? html`<span class="count">${qCount}</span>` : nothing}</button>
        </div>
        <div class="msgs" role="log" aria-live="polite" aria-relevant="additions">
          ${[...pinned, ...rest].map((m) => this.renderMessage(m, answers(m.id)))}
          ${!list.length ? html`<div class="empty">${tab === 'chat' ? html`${icon.chat()}<div>Say hello — you’re among the first here.</div>` : html`${icon.question()}<div>${isReplay ? 'Ask a question and the team will follow up by email.' : 'Ask the presenter anything.'}</div>`}</div>` : nothing}
        </div>
        <form class="compose" @submit=${(e: Event) => this.post(e, tab === 'chat' ? 'chat' : 'question')}>
          <label class="sr-only" for="compose">${tab === 'chat' ? 'Chat message' : 'Your question'}</label>
          <input id="compose" maxlength="500" autocomplete="off" placeholder=${tab === 'chat' ? 'Type a message…' : 'Ask a question…'} ?disabled=${this._conn !== 'open'}>
          <button type="submit" class="accent" aria-label="Send" ?disabled=${this._conn !== 'open'}>${icon.send()}</button>
        </form>
      </aside>`;
  }

  private renderWaiting() {
    const p = this._p!;
    const r = this._room!;
    const starts = r.starts_at ? Date.parse(r.starts_at) : null;
    const cfg = p.config;
    const locale = cfg.defaults.locale;
    return html`<div class="card wait fade-in">
      <span class="badge ${r.state === 'waiting' ? '' : 'neutral'}">${r.label}</span>
      <h1 style="margin-top:12px">${p.webinar.title}</h1>
      ${starts ? html`<p class="when">${localDate(r.starts_at!, locale)} <span>· ${localTime(r.starts_at!, locale)}</span></p>
        ${starts > this._now ? countdownTiles(starts - this._now) : html`<p class="muted">Starting…</p>`}` : nothing}
      <p class="open">${r.state === 'waiting' ? html`<span class="dot pulse"></span> ${p.webinar.type === 'live' ? 'The room is open — the presenter will start shortly.' : 'Starting shortly. Stay on this page.'}` : html`${icon.lock()} The room opens ${cfg.defaults.room_opens_min_before} minutes before the start.`}</p>
      ${p.webinar.presenters.length ? html`<div class="presenters">${p.webinar.presenters.map((pr) => presenterCard(pr, 'lg'))}</div>` : nothing}
      ${p.webinar.agenda?.length ? html`<div class="agenda"><h3>Agenda</h3><ul>${p.webinar.agenda.map((a) => html`<li>${a.time ? html`<span class="t">${a.time}</span>` : nothing}<span>${a.title}</span></li>`)}</ul></div>` : nothing}
      ${p.webinar.handouts.length ? html`<div class="chips">${p.webinar.handouts.map((h) => html`<a class="pill" href=${h.url} download>${icon.download()} ${h.label}</a>`)}</div>` : nothing}
      ${cfg.compliance.recording_notice ? html`<p class="xs muted" style="margin:22px 0 0">${cfg.compliance.recording_notice}</p>` : nothing}
    </div>`;
  }

  private renderEnd(title: string, body: string, ic: 'replay' | 'lock' | 'clock') {
    const cfg = this._p!.config;
    return html`<div class="card end fade-in"><div class="ic">${icon[ic]()}</div><h2>${title}</h2><p class="muted" style="max-width:46ch;margin:0 auto 18px">${body}</p>
      ${cfg.ctas.default ? html`<a class="btn accent" href=${cfg.ctas.default.url} target="_blank" rel="noopener">${cfg.ctas.default.label} ${icon.arrow()}</a>` : nothing}</div>`;
  }

  render() {
    if (this._error) {
      return html`<div class="card end fade-in" role="alert"><div class="ic">${icon.alert()}</div><p style="max-width:46ch;margin:0 auto 16px">${this._error.message}</p>
        ${this._error.code === 'no_token' || this._error.code === 'invalid_link'
          ? html`<button class="secondary" @click=${() => this.dispatchEvent(new CustomEvent('ghq-go', { detail: { view: 'register', slug: this.slug }, bubbles: true, composed: true }))}>Register ${icon.arrow()}</button>`
          : nothing}</div>`;
    }
    const p = this._p;
    const r = this._room;
    if (!p || !r) return html`<div class="card" aria-busy="true" aria-label="Joining"><div class="skeleton" style="width:40%;height:28px;margin-bottom:14px"></div><div class="skeleton" style="aspect-ratio:16/9;border-radius:var(--ghq-radius)"></div></div>`;
    const cfg = p.config;

    if (r.state === 'scheduled' || r.state === 'waiting') return this.renderWaiting();
    if (r.state === 'expired') return this.renderEnd(p.webinar.title, 'Access to this replay has ended.', 'lock');
    if (r.state === 'processing') return this.renderEnd(p.webinar.title, 'This video is being prepared. Please check back shortly.', 'clock');
    if (r.state === 'ended') return this.renderEnd('That’s a wrap', 'This session has ended. The replay will appear here soon — we’ll email you when it’s ready.', 'replay');

    const cta = this.activeCta();
    const poll = this.activePoll();
    const isLive = r.state === 'live' && p.webinar.type === 'live';
    return html`
      ${this._announcement ? html`<div class="announce" role="status"><span class="l">${icon.megaphone()}<span>${this._announcement}</span></span><button aria-label="Dismiss" @click=${() => (this._announcement = null)}>${icon.close()}</button></div>` : nothing}
      <div class="head fade-in">
        <h1>${p.webinar.title}</h1>
        <div class="status">
          <span class="badge ${isLive ? 'live' : ''}">${r.label}</span>
          ${r.state === 'live' ? html`<span class="pill" aria-label="viewers">${icon.users()} ${this._viewers}</span>` : nothing}
          ${this._conn !== 'open' ? html`<span class="conn"><span class="dot off"></span>${this._conn === 'connecting' ? 'Connecting…' : 'Reconnecting…'}</span>` : nothing}
        </div>
      </div>
      ${this._notice ? html`<div class="alert" role="status" style="margin-bottom:12px">${icon.alert()}<span>${this._notice}</span></div>` : nothing}
      <div class="layout with-panel">
        <div class="fade-in">
          <ghq-player .playback=${this._playback} .fetchedAt=${this._fetchedAt} .resumeKey=${r.seekable ? `ghq:pos:${p.session.id}:${p.webinar.id}` : null} title=${p.webinar.title} @ghq-time=${this.onTime}></ghq-player>
          ${cta ? this.renderCta(cta) : nothing}
          ${poll ? this.renderPoll(poll) : nothing}
          ${p.webinar.handouts.length || r.access_expires_at ? html`<div class="below">
            ${p.webinar.handouts.map((h) => html`<a class="pill" href=${h.url} download>${icon.download()} ${h.label}</a>`)}
            ${r.access_expires_at ? html`<span class="xs muted">Available until ${localDateTime(r.access_expires_at, cfg.defaults.locale)}</span>` : nothing}
          </div>` : nothing}
          ${cfg.compliance.risk_warning ? html`<p class="risk">${cfg.compliance.risk_warning}</p>` : nothing}
          <button class="secondary toggle" aria-expanded=${this._panelOpen} @click=${() => (this._panelOpen = !this._panelOpen)}>${this._panelOpen ? html`${icon.eyeOff()} Hide chat` : html`${icon.chat()} Chat & questions`}</button>
        </div>
        ${this.renderPanel()}
      </div>`;
  }
}

customElements.get('ghq-room') || customElements.define('ghq-room', GhqRoom);
