/**
 * <ghq-room> — waiting room, then player + chat / Q&A / polls / CTA. Also serves replays.
 * Auth: magic-link token → POST /join → 4h session token (+1h signed playback, refreshed).
 */
import { html, css, LitElement, nothing } from 'lit';
import { Api, ApiError, deviceId, emit, store } from './api.js';
import { countdown, localDateTime, timeOnly } from './format.js';
import './player.js';
import { base } from './styles.js';
import type { ChatMessage, Cta, JoinPayload, Playback, Poll, RoomState } from './types.js';
import { tokenKey } from './views.js';

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

  private ws: WebSocket | null = null;
  private wsRetry = 0;
  private wsTimer: number | undefined;
  private tick: number | undefined;
  private hb: number | undefined;
  private refreshTimer: number | undefined;
  private playing = false;
  private stopped = false;

  static styles = [base, css`
    .layout { display: grid; gap: 16px; grid-template-columns: 1fr; }
    @media (min-width: 900px) { .layout.with-panel { grid-template-columns: minmax(0, 1fr) 340px; } }
    .head { display: flex; gap: 10px; align-items: center; justify-content: space-between; flex-wrap: wrap; margin-bottom: 10px; }
    .head h1 { font-size: 1.3rem; margin: 0; }
    .panel { display: flex; flex-direction: column; min-height: 420px; max-height: 70vh; padding: 0; overflow: hidden; }
    @media (max-width: 899px) { .panel { max-height: 60vh; } }
    .tabs { display: flex; border-bottom: 1px solid var(--ghq-border); }
    .tabs button { flex: 1; border-radius: 0; border: none; background: none; color: var(--ghq-muted); min-height: 44px; }
    .tabs button[aria-selected='true'] { color: var(--ghq-text); box-shadow: inset 0 -3px 0 var(--ghq-accent); }
    .msgs { flex: 1; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 10px; }
    .msg { font-size: .92rem; }
    .msg .who { font-weight: 600; margin-right: 6px; }
    .msg.host .who { color: var(--ghq-accent); }
    .msg.pinned { background: var(--ghq-bg); border: 1px solid var(--ghq-accent); border-radius: var(--ghq-radius); padding: 8px; }
    .msg .meta { font-size: .75rem; color: var(--ghq-muted); }
    .answer { margin: 6px 0 0 14px; padding-left: 10px; border-left: 3px solid var(--ghq-accent); }
    .compose { display: flex; gap: 8px; padding: 10px; border-top: 1px solid var(--ghq-border); }
    .compose input { flex: 1; }
    .compose button { min-height: 44px; padding: 8px 14px; }
    .cta { display: flex; gap: 14px; align-items: center; justify-content: space-between; flex-wrap: wrap; margin-top: 14px; border-color: var(--ghq-accent); }
    .cta.card-style { flex-direction: column; align-items: stretch; }
    .cta img { max-width: 100%; border-radius: var(--ghq-radius); }
    .poll { margin-top: 14px; }
    .poll .opts { display: grid; gap: 8px; }
    .poll .opt { justify-content: space-between; background: var(--ghq-bg); color: var(--ghq-text); border: 1px solid var(--ghq-border); font-weight: 500; }
    .bar { height: 6px; background: var(--ghq-border); border-radius: 3px; overflow: hidden; }
    .bar > span { display: block; height: 100%; background: var(--ghq-accent); }
    .big { font-size: clamp(2rem, 6vw, 3.25rem); font-weight: 700; font-variant-numeric: tabular-nums; margin: 8px 0; }
    .wait { text-align: center; padding: 32px 20px; }
    .announce { background: var(--ghq-accent); color: #fff; padding: 10px 14px; border-radius: var(--ghq-radius); margin-bottom: 10px; display: flex; justify-content: space-between; gap: 10px; }
    .announce button { background: none; border: none; min-height: 0; padding: 0 4px; color: #fff; }
    .conn { font-size: .75rem; color: var(--ghq-muted); }
    .toggle { width: 100%; margin-top: 10px; }
    @media (min-width: 900px) { .toggle { display: none; } }
    .handouts a { display: inline-block; margin: 0 12px 6px 0; }
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
    this._panelOpen = typeof matchMedia === 'function' ? matchMedia('(min-width: 900px)').matches : true;
    this._notice = null;
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
  }

  private onWs(m: Record<string, any>) {
    switch (m.type) {
      case 'hello':
        this._messages = m.messages ?? [];
        this._viewers = m.viewers ?? 0;
        this._pushedCta = m.active_cta ?? null;
        this._pushedPoll = m.active_poll ?? null;
        if (m.active_poll && m.poll_results) this._pollResults = { ...this._pollResults, [m.active_poll.id]: m.poll_results };
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

  private scrollChat() {
    const el = this.renderRoot.querySelector('.msgs');
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 160) el.scrollTop = el.scrollHeight;
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
    return html`<div class="card cta ${c.style === 'card' ? 'card-style' : ''}" role="complementary" aria-label="Offer">
      ${c.image_url ? html`<img src=${c.image_url} alt="">` : nothing}
      <div>${c.style === 'card' ? html`<strong>${c.label}</strong>` : nothing}${c.body ? html`<p class="small" style="margin:4px 0 0">${c.body}</p>` : nothing}</div>
      <button class="accent" @click=${() => this.clickCta(c)}>${c.label}</button>
    </div>`;
  }

  private renderPoll(p: Poll) {
    const voted = store.get(`ghq:vote:${p.id}`);
    const results = this._pollResults[p.id];
    const total = results ? Object.values(results).reduce((a, b) => a + b, 0) : 0;
    return html`<div class="card poll stack" role="group" aria-label="Poll">
      <strong>${p.question}</strong>
      <div class="opts">
        ${p.options.map((o) => html`
          <button class="opt" ?disabled=${!!voted} aria-pressed=${voted === o ? 'true' : 'false'} @click=${() => this.send({ type: 'vote', poll_id: p.id, option: o })}>
            <span>${voted === o ? '✓ ' : ''}${o}</span>${results ? html`<span class="small">${total ? Math.round(((results[o] ?? 0) / total) * 100) : 0}%</span>` : nothing}
          </button>
          ${results ? html`<div class="bar"><span style="width:${total ? ((results[o] ?? 0) / total) * 100 : 0}%"></span></div>` : nothing}`)}
      </div>
      ${voted && !results ? html`<p class="small muted">Thanks — your answer was recorded.</p>` : nothing}
    </div>`;
  }

  private renderMessage(m: ChatMessage, answers: ChatMessage[]) {
    const fromHost = !!m.host_id;
    return html`<div class="msg ${fromHost ? 'host' : ''} ${m.status === 'pinned' ? 'pinned' : ''}">
      ${m.status === 'pinned' ? html`<div class="meta">📌 Pinned</div>` : nothing}
      <span class="who">${m.author_name}${fromHost ? ' (host)' : ''}</span><span>${m.body}</span>
      <div class="meta">${timeOnly(m.created_at)}${m.status === 'pending' ? ' · awaiting approval' : ''}${m.kind === 'question' && m.done_at ? ' · answered' : ''}</div>
      ${answers.map((a) => html`<div class="answer"><span class="who">${a.author_name}</span>${a.body}</div>`)}
    </div>`;
  }

  private renderPanel() {
    const p = this._p!;
    const chatOn = p.config.defaults.chat_enabled && (this._room?.state === 'live');
    const tab = chatOn ? this._tab : 'qa';
    const answers = (id: string) => this._messages.filter((m) => m.kind === 'answer' && m.parent_id === id);
    const list = this._messages.filter((m) => (tab === 'chat' ? m.kind === 'chat' : m.kind === 'question'));
    const pinned = list.filter((m) => m.status === 'pinned');
    const rest = list.filter((m) => m.status !== 'pinned');
    const isReplay = this._room?.state !== 'live';
    return html`
      <aside class="card panel" ?hidden=${!this._panelOpen} aria-label="Chat and questions">
        <div class="tabs" role="tablist">
          ${chatOn ? html`<button role="tab" aria-selected=${tab === 'chat'} @click=${() => (this._tab = 'chat')}>Chat</button>` : nothing}
          <button role="tab" aria-selected=${tab === 'qa'} @click=${() => (this._tab = 'qa')}>Questions</button>
        </div>
        <div class="msgs" role="log" aria-live="polite" aria-relevant="additions">
          ${[...pinned, ...rest].map((m) => this.renderMessage(m, answers(m.id)))}
          ${!list.length ? html`<p class="muted small">${tab === 'chat' ? 'Say hello 👋' : isReplay ? 'Ask a question — the team will follow up by email.' : 'Ask the presenter a question.'}</p>` : nothing}
        </div>
        <form class="compose" @submit=${(e: Event) => this.post(e, tab === 'chat' ? 'chat' : 'question')}>
          <label class="sr-only" for="compose">${tab === 'chat' ? 'Chat message' : 'Your question'}</label>
          <input id="compose" maxlength="500" autocomplete="off" placeholder=${tab === 'chat' ? 'Type a message…' : 'Ask a question…'} ?disabled=${this._conn !== 'open'}>
          <button type="submit" ?disabled=${this._conn !== 'open'}>Send</button>
        </form>
      </aside>`;
  }

  private renderWaiting() {
    const p = this._p!;
    const r = this._room!;
    const starts = r.starts_at ? Date.parse(r.starts_at) : null;
    const cfg = p.config;
    return html`<div class="card wait stack">
      <span class="badge">${r.label}</span>
      <h1>${p.webinar.title}</h1>
      ${starts ? html`<p>${localDateTime(r.starts_at!, cfg.defaults.locale)}</p>
        <div class="big" aria-live="off">${starts > this._now ? countdown(starts - this._now) : 'Starting…'}</div>` : nothing}
      <p class="muted">${r.state === 'waiting' ? (p.webinar.type === 'live' ? 'The room is open — the presenter will start shortly.' : 'Starting shortly. Stay on this page.') : `The room opens ${cfg.defaults.room_opens_min_before} minutes before the start.`}</p>
      ${p.webinar.presenters.map((pr) => html`<p><strong>${pr.name}</strong>${pr.bio ? html` — <span class="muted">${pr.bio}</span>` : nothing}</p>`)}
      ${p.webinar.agenda?.length ? html`<div style="text-align:left;max-width:520px;margin:0 auto"><h2>Agenda</h2><ul>${p.webinar.agenda.map((a) => html`<li>${a.time ? html`<strong>${a.time}</strong> ` : nothing}${a.title}</li>`)}</ul></div>` : nothing}
      ${p.webinar.handouts.length ? html`<p class="handouts">${p.webinar.handouts.map((h) => html`<a href=${h.url} download>⬇ ${h.label}</a>`)}</p>` : nothing}
      ${cfg.compliance.recording_notice ? html`<p class="small muted">${cfg.compliance.recording_notice}</p>` : nothing}
    </div>`;
  }

  render() {
    if (this._error) {
      return html`<div class="card stack" role="alert"><p>${this._error.message}</p>
        ${this._error.code === 'no_token' || this._error.code === 'invalid_link'
          ? html`<button class="secondary" @click=${() => this.dispatchEvent(new CustomEvent('ghq-go', { detail: { view: 'register', slug: this.slug }, bubbles: true, composed: true }))}>Register</button>`
          : nothing}</div>`;
    }
    const p = this._p;
    const r = this._room;
    if (!p || !r) return html`<div class="card muted" aria-busy="true">Joining…</div>`;
    const cfg = p.config;

    if (r.state === 'scheduled' || r.state === 'waiting') return this.renderWaiting();
    if (r.state === 'expired') return html`<div class="card"><h2>${p.webinar.title}</h2><p>Access to this replay has ended.</p>${cfg.ctas.default ? html`<a class="btn accent" href=${cfg.ctas.default.url}>${cfg.ctas.default.label}</a>` : nothing}</div>`;
    if (r.state === 'ended' || r.state === 'processing') {
      return html`<div class="card stack"><h2>${p.webinar.title}</h2>
        <p>${r.state === 'processing' ? 'This video is being prepared. Please check back shortly.' : 'This session has ended. The replay will be available here soon — we’ll email you when it’s ready.'}</p>
        ${cfg.ctas.default ? html`<a class="btn accent" href=${cfg.ctas.default.url} target="_blank" rel="noopener">${cfg.ctas.default.label}</a>` : nothing}</div>`;
    }

    const cta = this.activeCta();
    const poll = this.activePoll();
    return html`
      ${this._announcement ? html`<div class="announce" role="status"><span>${this._announcement}</span><button aria-label="Dismiss" @click=${() => (this._announcement = null)}>✕</button></div>` : nothing}
      <div class="head">
        <h1>${p.webinar.title}</h1>
        <div class="row">
          <span class="badge ${r.state === 'live' && p.webinar.type === 'live' ? 'live' : ''}">${r.label}</span>
          ${r.state === 'live' ? html`<span class="small muted" aria-label="viewers">👥 ${this._viewers}</span>` : nothing}
          ${this._conn !== 'open' ? html`<span class="conn">${this._conn === 'connecting' ? 'Connecting…' : 'Reconnecting…'}</span>` : nothing}
        </div>
      </div>
      ${this._notice ? html`<p class="small error" role="status">${this._notice}</p>` : nothing}
      <div class="layout with-panel">
        <div>
          <ghq-player .playback=${this._playback} .fetchedAt=${this._fetchedAt} .resumeKey=${r.seekable ? `ghq:pos:${p.session.id}:${p.webinar.id}` : null} title=${p.webinar.title} @ghq-time=${this.onTime}></ghq-player>
          ${cta ? this.renderCta(cta) : nothing}
          ${poll ? this.renderPoll(poll) : nothing}
          ${cfg.compliance.risk_warning ? html`<p class="risk">${cfg.compliance.risk_warning}</p>` : nothing}
          ${p.webinar.handouts.length ? html`<p class="handouts small">${p.webinar.handouts.map((h) => html`<a href=${h.url} download>⬇ ${h.label}</a>`)}</p>` : nothing}
          ${r.access_expires_at ? html`<p class="small muted">Available until ${localDateTime(r.access_expires_at, cfg.defaults.locale)}.</p>` : nothing}
          <button class="secondary toggle" aria-expanded=${this._panelOpen} @click=${() => (this._panelOpen = !this._panelOpen)}>${this._panelOpen ? 'Hide chat' : 'Show chat & questions'}</button>
        </div>
        ${this.renderPanel()}
      </div>`;
  }
}

customElements.get('ghq-room') || customElements.define('ghq-room', GhqRoom);
