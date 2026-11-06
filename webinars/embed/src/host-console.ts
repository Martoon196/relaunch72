/**
 * <ghq-host-console> — host / moderator console for one session (opened from the console link).
 * Viewer count, chat moderation (hide / pin / ban), question queue (approve / answer / done),
 * polls and CTAs (host only), announcements, preview player and End session (host only).
 */
import { html, css, LitElement, nothing } from 'lit';
import { Api, embedConfig } from './api.js';
import { timeOnly } from './format.js';
import { icon } from './icons.js';
import './player.js';
import { base, hueFor, initials } from './styles.js';
import type { ChatMessage, Cta, Playback, Poll } from './types.js';

interface ConsoleData {
  role: 'host' | 'moderator';
  name: string;
  webinar: { title: string; type: string };
  session: { id: string; kind: string; status: string; test_mode: boolean; starts_at: string | null };
  ctas: Cta[];
  polls: Poll[];
  playback: Playback | null;
  ws_url: string;
}

export class GhqHostConsole extends LitElement {
  static properties = {
    session: {},
    token: { attribute: false },
    _d: { state: true },
    _error: { state: true },
    _messages: { state: true },
    _viewers: { state: true },
    _peak: { state: true },
    _status: { state: true },
    _cta: { state: true },
    _poll: { state: true },
    _results: { state: true },
    _conn: { state: true },
    _answering: { state: true },
    _qFilter: { state: true },
  };
  declare session: string;
  declare token: string;
  declare _d: ConsoleData | null;
  declare _error: string | null;
  declare _messages: ChatMessage[];
  declare _viewers: number;
  declare _peak: number;
  declare _status: string;
  declare _cta: Cta | null;
  declare _poll: Poll | null;
  declare _results: Record<string, Record<string, number>>;
  declare _conn: string;
  declare _answering: string | null;
  declare _qFilter: 'open' | 'all';
  private ws: WebSocket | null = null;
  private api!: Api;
  private retry = 0;

  static styles = [base, css`
    :host {
      --ghq-bg: #0b0d12; --ghq-surface: #141821; --ghq-surface-2: #1a1f2b; --ghq-text: #e8eaf0; --ghq-muted: #8d95a6;
      --ghq-border: rgba(255,255,255,.08); --ghq-accent: #7aa2ff; --ghq-primary: #3b6cf5; --ghq-radius: 12px; --ghq-btn-radius: 10px;
      --ghq-btn-fill: var(--ghq-primary); --ghq-btn-text: #fff; --ghq-shadow: 0 1px 2px rgba(0,0,0,.5);
      display: block; min-height: 100vh; padding: 18px; background: var(--ghq-bg); color: var(--ghq-text);
    }
    .top { display: flex; gap: 16px; align-items: center; justify-content: space-between; flex-wrap: wrap; margin-bottom: 16px; }
    .top h1 { font-size: 1.2rem; margin: 0; }
    .stats { display: flex; gap: 10px; }
    .stat { display: grid; padding: 8px 14px; border-radius: 10px; background: var(--ghq-surface); border: 1px solid var(--ghq-border); min-width: 84px; }
    .stat b { font-size: 1.4rem; line-height: 1.1; font-variant-numeric: tabular-nums; }
    .stat span { font-size: .68rem; text-transform: uppercase; letter-spacing: .07em; color: var(--ghq-muted); }
    .danger { background: #e11d48; border-color: #e11d48; }
    .grid { display: grid; gap: 14px; grid-template-columns: 1fr; }
    @media (min-width: 1120px) { .grid { grid-template-columns: 1.1fr 1fr 380px; } }
    .col { display: flex; flex-direction: column; gap: 10px; padding: 14px; max-height: calc(100vh - 120px); overflow-y: auto; }
    .col h2 { display: flex; align-items: center; justify-content: space-between; font-size: .95rem; margin: 0 0 4px; }
    .col h2 .f { display: flex; gap: 4px; }
    .col h2 .f button { min-height: 26px; padding: 2px 9px; font-size: .72rem; }
    .m { display: flex; gap: 10px; border: 1px solid var(--ghq-border); border-radius: 10px; padding: 10px 12px; font-size: .9rem; background: var(--ghq-surface); animation: ghq-rise .25s var(--_ease) both; }
    .m .avatar { width: 30px; height: 30px; font-size: .68rem; }
    .m .b { flex: 1; min-width: 0; }
    .m.hidden { opacity: .4; }
    .m.pinned { border-color: var(--ghq-accent); }
    .m.pending { border-left: 3px solid #f59e0b; }
    .m.done { opacity: .6; }
    .m .who { font-weight: 700; display: flex; gap: 8px; align-items: center; font-size: .82rem; }
    .m .who .t { color: var(--ghq-muted); font-weight: 500; }
    .m .who .st { font-size: .62rem; font-weight: 800; letter-spacing: .06em; text-transform: uppercase; padding: 1px 6px; border-radius: 999px; background: rgba(255,255,255,.08); }
    .m .who .st.pending { background: #f59e0b; color: #111; }
    .m .who .st.pinned { background: var(--ghq-accent); color: #111; }
    .m .txt { overflow-wrap: anywhere; margin: 2px 0 6px; }
    .acts { display: flex; gap: 4px; flex-wrap: wrap; }
    .acts button { min-height: 28px; padding: 2px 9px; font-size: .74rem; border-width: 1px; gap: 5px; }
    .acts button svg { width: 13px; height: 13px; }
    .answer { margin: 4px 0 8px; padding: 6px 10px; border-left: 3px solid var(--ghq-accent); font-size: .85rem; color: var(--ghq-muted); }
    .answer b { color: var(--ghq-accent); }
    form.inline { display: flex; gap: 6px; margin-top: 6px; }
    form.inline input { min-height: 38px; padding: 6px 10px; }
    form.inline button { min-height: 38px; width: 42px; padding: 0; }
    .tool { padding: 12px; border: 1px solid var(--ghq-border); border-radius: 10px; background: var(--ghq-surface); }
    .tool .h { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
    .tool .h strong { font-size: .92rem; }
    .tool .live { font-size: .62rem; font-weight: 800; letter-spacing: .06em; text-transform: uppercase; color: #34d399; display: inline-flex; gap: 5px; align-items: center; }
    .tool .live .dot { background: #34d399; color: #34d399; }
    .res { display: grid; gap: 5px; margin: 8px 0 4px; }
    .res .r { display: grid; grid-template-columns: 1fr auto; gap: 8px; font-size: .8rem; align-items: center; }
    .res .bar { grid-column: 1 / -1; height: 5px; background: rgba(255,255,255,.08); border-radius: 3px; overflow: hidden; }
    .res .bar span { display: block; height: 100%; background: var(--ghq-accent); transition: width .5s var(--_ease); }
    .section { font-size: .7rem; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; color: var(--ghq-muted); margin: 10px 0 2px; display: flex; gap: 6px; align-items: center; }
    .section svg { width: 14px; height: 14px; }
    .empty { color: var(--ghq-muted); font-size: .85rem; text-align: center; padding: 24px 0; }
  `];

  constructor() {
    super();
    this.session = '';
    this.token = '';
    this._d = null;
    this._error = null;
    this._messages = [];
    this._viewers = 0;
    this._peak = 0;
    this._status = '';
    this._cta = null;
    this._poll = null;
    this._results = {};
    this._conn = 'connecting';
    this._answering = null;
    this._qFilter = 'open';
  }

  // Not connectedCallback: the console page may set `token` before this element is defined,
  // and Lit only restores such pre-upgrade properties at the first update.
  async firstUpdated() {
    const cfg = embedConfig();
    this.api = new Api(cfg.api, cfg.key);
    try {
      this._d = await this.api.req<ConsoleData>('POST', '/host/console', undefined, this.token);
      this._status = this._d.session.test_mode ? 'preview' : this._d.session.status;
      this.connect();
    } catch (e) {
      this._error = e instanceof Error ? e.message : 'Could not open console';
    }
  }

  private connect() {
    const ws = new WebSocket(this._d!.ws_url);
    this.ws = ws;
    ws.onopen = () => { this._conn = 'open'; this.retry = 0; };
    ws.onclose = () => {
      this._conn = 'closed';
      setTimeout(() => this.connect(), Math.min(15000, 1000 * 2 ** this.retry++));
    };
    ws.onmessage = (ev) => {
      const m = JSON.parse(String(ev.data));
      switch (m.type) {
        case 'hello':
          this._messages = m.messages; this._viewers = m.viewers; this._status = m.status; this._cta = m.active_cta; this._poll = m.active_poll;
          this._peak = Math.max(this._peak, m.viewers);
          if (m.active_poll && m.poll_results) this._results = { ...this._results, [m.active_poll.id]: m.poll_results };
          break;
        case 'message': case 'message_update': {
          const i = this._messages.findIndex((x) => x.id === m.message.id);
          this._messages = i >= 0 ? this._messages.map((x) => (x.id === m.message.id ? m.message : x)) : [...this._messages, m.message];
          break;
        }
        case 'viewers': this._viewers = m.count; this._peak = Math.max(this._peak, m.count); break;
        case 'session_status': this._status = m.status; break;
        case 'cta': this._cta = m.cta; break;
        case 'poll': this._poll = m.poll; if (m.results && (m.poll?.id || m.closed_id)) this._results = { ...this._results, [m.poll?.id ?? m.closed_id]: m.results }; break;
        case 'poll_results': this._results = { ...this._results, [m.poll_id]: m.results }; break;
        case 'error': this._error = m.message; setTimeout(() => (this._error = null), 4000); break;
      }
    };
  }

  private send(msg: Record<string, unknown>) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private mod(id: string, op: string) { this.send({ type: 'moderate', message_id: id, op }); }

  private answer(e: Event, id: string) {
    e.preventDefault();
    const input = (e.target as HTMLFormElement).querySelector('input')!;
    if (input.value.trim()) this.send({ type: 'answer', message_id: id, body: input.value.trim() });
    this._answering = null;
  }

  private submitText(e: Event, type: 'announce' | 'chat') {
    e.preventDefault();
    const input = (e.target as HTMLFormElement).querySelector('input')!;
    if (input.value.trim()) this.send({ type, body: input.value.trim() });
    input.value = '';
  }

  private async end() {
    if (!confirm('End the session for everyone? The recording becomes the replay.')) return;
    try {
      await this.api.req('POST', '/host/end', undefined, this.token);
    } catch (e) {
      this._error = e instanceof Error ? e.message : 'Could not end';
    }
  }

  private msg(m: ChatMessage) {
    const answers = this._messages.filter((a) => a.kind === 'answer' && a.parent_id === m.id);
    return html`<div class="m ${m.status} ${m.done_at ? 'done' : ''}">
      <span class="avatar" style="--h:${hueFor(m.author_name)}">${initials(m.author_name)}</span>
      <div class="b">
        <div class="who">${m.author_name}<span class="t">${timeOnly(m.created_at)}</span>
          ${m.status !== 'visible' ? html`<span class="st ${m.status}">${m.status}</span>` : nothing}
          ${m.done_at ? html`<span class="st">done</span>` : nothing}</div>
        <div class="txt">${m.body}</div>
        ${answers.map((a) => html`<div class="answer"><b>${a.author_name}:</b> ${a.body}</div>`)}
        <div class="acts">
          ${m.status === 'pending' ? html`<button class="sm" @click=${() => this.mod(m.id, 'approve')}>${icon.check()} Approve</button>` : nothing}
          ${m.kind === 'question' ? html`<button class="sm secondary" @click=${() => (this._answering = this._answering === m.id ? null : m.id)}>${icon.reply()} Answer</button>` : nothing}
          ${m.status === 'pinned' ? html`<button class="sm secondary" @click=${() => this.mod(m.id, 'unpin')}>${icon.pin()} Unpin</button>` : html`<button class="sm secondary" @click=${() => this.mod(m.id, 'pin')}>${icon.pin()} Pin</button>`}
          ${m.status === 'hidden' ? html`<button class="sm secondary" @click=${() => this.mod(m.id, 'show')}>${icon.eye()} Show</button>` : html`<button class="sm secondary" @click=${() => this.mod(m.id, 'hide')}>${icon.eyeOff()} Hide</button>`}
          ${m.kind === 'question' ? html`<button class="sm secondary" @click=${() => this.mod(m.id, m.done_at ? 'undone' : 'done')}>${m.done_at ? html`${icon.replay()} Reopen` : html`${icon.checkCircle()} Done`}</button>` : nothing}
          ${m.registrant_id ? html`<button class="sm ghost" @click=${() => confirm(`Remove ${m.author_name} from the session?`) && this.send({ type: 'ban', registrant_id: m.registrant_id })}>${icon.ban()} Ban</button>` : nothing}
        </div>
        ${this._answering === m.id ? html`<form class="inline" @submit=${(e: Event) => this.answer(e, m.id)}><input placeholder="Type your answer" autofocus><button class="accent" aria-label="Send answer">${icon.send()}</button></form>` : nothing}
      </div>
    </div>`;
  }

  render() {
    const d = this._d;
    if (!d) return html`<div class="${this._error ? 'alert' : 'muted'}">${this._error ? html`${icon.alert()}<span>${this._error}</span>` : 'Loading console…'}</div>`;
    const host = d.role === 'host';
    const chat = this._messages.filter((m) => m.kind === 'chat');
    const allQ = this._messages.filter((m) => m.kind === 'question');
    const openQ = allQ.filter((q) => !q.done_at);
    const questions = (this._qFilter === 'open' ? openQ : allQ).sort((a, b) => Number(b.status === 'pending') - Number(a.status === 'pending'));
    return html`
      <div class="top">
        <div><h1>${d.webinar.title}</h1><span class="small muted">${d.role} · ${d.name} · <span class="dot ${this._conn === 'open' ? '' : 'off'}" style="width:7px;height:7px"></span> ${this._conn}</span></div>
        <div class="row">
          <span class="badge ${this._status === 'live' ? 'live' : 'neutral'}">${this._status}</span>
          <div class="stats">
            <div class="stat"><b>${this._viewers}</b><span>watching</span></div>
            <div class="stat"><b>${this._peak}</b><span>peak</span></div>
            <div class="stat"><b>${openQ.length}</b><span>open Q</span></div>
          </div>
          ${host && d.session.kind === 'live' && this._status !== 'ended' ? html`<button class="sm danger" @click=${this.end}>${icon.stop()} End session</button>` : nothing}
        </div>
      </div>
      ${this._error ? html`<div class="alert" role="alert" style="margin-bottom:12px">${icon.alert()}<span>${this._error}</span></div>` : nothing}
      <div class="grid">
        <section class="col card flat" aria-label="Questions">
          <h2><span>Questions</span><span class="f"><button class="${this._qFilter === 'open' ? '' : 'secondary'}" @click=${() => (this._qFilter = 'open')}>Open ${openQ.length}</button><button class="${this._qFilter === 'all' ? '' : 'secondary'}" @click=${() => (this._qFilter = 'all')}>All ${allQ.length}</button></span></h2>
          ${questions.length ? questions.map((m) => this.msg(m)) : html`<div class="empty">No ${this._qFilter === 'open' ? 'open ' : ''}questions yet.</div>`}
        </section>
        <section class="col card flat" aria-label="Chat">
          <h2>Chat <span class="muted" style="font-weight:500">${chat.length}</span></h2>
          ${chat.length ? chat.map((m) => this.msg(m)) : html`<div class="empty">Quiet so far.</div>`}
          <form class="inline" @submit=${(e: Event) => this.submitText(e, 'chat')}><input placeholder="Message as ${d.name}"><button class="accent" aria-label="Send">${icon.send()}</button></form>
        </section>
        <section class="col card flat">
          ${d.playback ? html`<ghq-player .playback=${{ ...d.playback, offset_s: null, seekable: true, low_latency: d.playback.webrtc !== null }} title="Preview"></ghq-player>` : nothing}
          <div class="section">${icon.megaphone()} Announce</div>
          <form class="inline" style="margin:0" @submit=${(e: Event) => this.submitText(e, 'announce')}><input placeholder="Banner for everyone in the room"><button class="accent" aria-label="Send announcement">${icon.send()}</button></form>
          ${host ? html`
            <div class="section">${icon.sparkle()} Offers</div>
            ${d.ctas.map((c) => html`<div class="tool"><div class="h"><strong>${c.label}</strong>${this._cta?.id === c.id ? html`<span class="live"><span class="dot pulse"></span> On screen</span>` : nothing}</div>
              <div class="acts" style="margin-top:8px">${this._cta?.id === c.id
                ? html`<button class="sm secondary" @click=${() => this.send({ type: 'hide_cta' })}>${icon.eyeOff()} Hide</button>`
                : html`<button class="sm" @click=${() => this.send({ type: 'push_cta', cta: c })}>${icon.send()} Push live</button>`}
              <span class="xs muted" style="align-self:center">${c.push_mode === 'timed' && c.show_at_s != null ? `auto at ${Math.round(c.show_at_s / 60)} min` : 'manual'}</span></div></div>`)}
            <div class="section">${icon.poll()} Polls</div>
            ${d.polls.map((p) => {
              const r = this._results[p.id] ?? {};
              const total = Object.values(r).reduce((a, b) => a + b, 0);
              return html`<div class="tool"><div class="h"><strong>${p.question}</strong>${this._poll?.id === p.id ? html`<span class="live"><span class="dot pulse"></span> Open</span>` : nothing}</div>
                <div class="res">${p.options.map((o) => html`<div class="r"><span>${o}</span><span>${r[o] ?? 0}${total ? ` · ${Math.round(((r[o] ?? 0) / total) * 100)}%` : ''}</span><div class="bar"><span style="width:${total ? ((r[o] ?? 0) / total) * 100 : 0}%"></span></div></div>`)}</div>
                <div class="acts">${this._poll?.id === p.id
                  ? html`<button class="sm secondary" @click=${() => this.send({ type: 'close_poll' })}>${icon.stop()} Close poll</button>`
                  : html`<button class="sm" @click=${() => this.send({ type: 'push_poll', poll: { ...p, show_results: false } })}>${icon.send()} Launch</button>
                         <button class="sm secondary" @click=${() => this.send({ type: 'push_poll', poll: { ...p, show_results: true } })}>Launch + show results</button>`}</div></div>`;
            })}` : html`<p class="small muted">Moderators manage chat and questions. Offers, polls and ending the session are host-only.</p>`}
        </section>
      </div>`;
  }
}

customElements.get('ghq-host-console') || customElements.define('ghq-host-console', GhqHostConsole);
