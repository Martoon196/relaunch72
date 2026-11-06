/**
 * <ghq-host-console> — host / moderator console for one session (opened from the console link).
 * Viewer count, chat moderation (hide / pin / ban), question queue (approve / answer / done),
 * polls and CTAs (host only), announcements, preview player and End session (host only).
 */
import { html, css, LitElement, nothing } from 'lit';
import { Api, embedConfig } from './api.js';
import { timeOnly } from './format.js';
import './player.js';
import { base } from './styles.js';
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
    _status: { state: true },
    _cta: { state: true },
    _poll: { state: true },
    _results: { state: true },
    _conn: { state: true },
    _answering: { state: true },
  };
  declare session: string;
  declare token: string;
  declare _d: ConsoleData | null;
  declare _error: string | null;
  declare _messages: ChatMessage[];
  declare _viewers: number;
  declare _status: string;
  declare _cta: Cta | null;
  declare _poll: Poll | null;
  declare _results: Record<string, Record<string, number>>;
  declare _conn: string;
  declare _answering: string | null;
  private ws: WebSocket | null = null;
  private api!: Api;
  private retry = 0;

  static styles = [base, css`
    :host { --ghq-bg: #0f1115; --ghq-surface: #1a1d24; --ghq-text: #e5e7eb; --ghq-muted: #9ca3af; --ghq-border: #2b303b; --ghq-accent: #60a5fa; --ghq-primary: #2563eb; --ghq-radius: 8px; --ghq-btn-radius: 8px; padding: 16px; }
    .top { display: flex; gap: 12px; align-items: center; justify-content: space-between; flex-wrap: wrap; margin-bottom: 14px; }
    .grid { display: grid; gap: 14px; grid-template-columns: 1fr; }
    @media (min-width: 1100px) { .grid { grid-template-columns: 1fr 1fr 360px; } }
    .col { display: flex; flex-direction: column; gap: 10px; max-height: 80vh; overflow-y: auto; }
    .m { border: 1px solid var(--ghq-border); border-radius: 8px; padding: 8px 10px; font-size: .9rem; }
    .m.hidden { opacity: .45; }
    .m.pinned { border-color: var(--ghq-accent); }
    .m.pending { border-left: 4px solid #f59e0b; }
    .m .who { font-weight: 600; margin-right: 6px; }
    .acts { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 6px; }
    .acts button, .sm { min-height: 30px; padding: 3px 10px; font-size: .8rem; }
    .stat { font-size: 2rem; font-weight: 700; }
    .answer { margin: 6px 0 0 12px; padding-left: 8px; border-left: 3px solid var(--ghq-accent); }
    form.inline { display: flex; gap: 6px; margin-top: 6px; }
    form.inline input { min-height: 36px; padding: 6px 10px; }
  `];

  constructor() {
    super();
    this.session = '';
    this.token = '';
    this._d = null;
    this._error = null;
    this._messages = [];
    this._viewers = 0;
    this._status = '';
    this._cta = null;
    this._poll = null;
    this._results = {};
    this._conn = 'connecting';
    this._answering = null;
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
          if (m.active_poll && m.poll_results) this._results = { ...this._results, [m.active_poll.id]: m.poll_results };
          break;
        case 'message': case 'message_update': {
          const i = this._messages.findIndex((x) => x.id === m.message.id);
          this._messages = i >= 0 ? this._messages.map((x) => (x.id === m.message.id ? m.message : x)) : [...this._messages, m.message];
          break;
        }
        case 'viewers': this._viewers = m.count; break;
        case 'session_status': this._status = m.status; break;
        case 'cta': this._cta = m.cta; break;
        case 'poll': this._poll = m.poll; break;
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

  private announce(e: Event) {
    e.preventDefault();
    const input = (e.target as HTMLFormElement).querySelector('input')!;
    if (input.value.trim()) this.send({ type: 'announce', body: input.value.trim() });
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
    return html`<div class="m ${m.status}">
      <span class="who">${m.author_name}</span>${m.body}
      <div class="small muted">${timeOnly(m.created_at)} · ${m.status}${m.done_at ? ' · done' : ''}</div>
      ${answers.map((a) => html`<div class="answer small"><strong>${a.author_name}:</strong> ${a.body}</div>`)}
      <div class="acts">
        ${m.status === 'pending' ? html`<button class="sm" @click=${() => this.mod(m.id, 'approve')}>Approve</button>` : nothing}
        ${m.status === 'pinned' ? html`<button class="sm secondary" @click=${() => this.mod(m.id, 'unpin')}>Unpin</button>` : html`<button class="sm secondary" @click=${() => this.mod(m.id, 'pin')}>Pin</button>`}
        ${m.status === 'hidden' ? html`<button class="sm secondary" @click=${() => this.mod(m.id, 'show')}>Show</button>` : html`<button class="sm secondary" @click=${() => this.mod(m.id, 'hide')}>Hide</button>`}
        ${m.kind === 'question' ? html`
          <button class="sm secondary" @click=${() => (this._answering = m.id)}>Answer</button>
          <button class="sm secondary" @click=${() => this.mod(m.id, m.done_at ? 'undone' : 'done')}>${m.done_at ? 'Reopen' : 'Done'}</button>` : nothing}
        ${m.registrant_id ? html`<button class="sm secondary" @click=${() => confirm(`Remove ${m.author_name} from the session?`) && this.send({ type: 'ban', registrant_id: m.registrant_id })}>Ban</button>` : nothing}
      </div>
      ${this._answering === m.id ? html`<form class="inline" @submit=${(e: Event) => this.answer(e, m.id)}><input placeholder="Type your answer" autofocus><button class="sm">Send</button></form>` : nothing}
    </div>`;
  }

  render() {
    const d = this._d;
    if (!d) return html`<p class=${this._error ? 'error' : 'muted'}>${this._error ?? 'Loading console…'}</p>`;
    const host = d.role === 'host';
    const chat = this._messages.filter((m) => m.kind === 'chat');
    const questions = this._messages.filter((m) => m.kind === 'question').sort((a, b) => Number(!!a.done_at) - Number(!!b.done_at) || Number(b.status === 'pending') - Number(a.status === 'pending'));
    return html`
      <div class="top">
        <div><h1 style="font-size:1.2rem;margin:0">${d.webinar.title}</h1><span class="small muted">${d.role} · ${d.name} · ${this._conn}</span></div>
        <div class="row">
          <span class="badge ${this._status === 'live' ? 'live' : ''}">${this._status}</span>
          <span><span class="stat">${this._viewers}</span> <span class="muted">watching</span></span>
          ${host && d.session.kind === 'live' && this._status !== 'ended' ? html`<button class="sm" style="background:#dc2626;border-color:#dc2626" @click=${this.end}>End session</button>` : nothing}
        </div>
      </div>
      ${this._error ? html`<p class="error" role="alert">${this._error}</p>` : nothing}
      <div class="grid">
        <section class="col" aria-label="Questions">
          <h2>Questions (${questions.filter((q) => !q.done_at).length} open)</h2>
          ${questions.map((m) => this.msg(m))}
        </section>
        <section class="col" aria-label="Chat">
          <h2>Chat</h2>
          ${chat.map((m) => this.msg(m))}
          <form class="inline" @submit=${(e: Event) => { e.preventDefault(); const i = (e.target as HTMLFormElement).querySelector('input')!; if (i.value.trim()) this.send({ type: 'chat', body: i.value.trim() }); i.value = ''; }}>
            <input placeholder="Message as ${d.name}"><button class="sm">Send</button>
          </form>
        </section>
        <section class="col">
          ${d.playback ? html`<ghq-player .playback=${{ ...d.playback, offset_s: null, seekable: true, low_latency: d.playback.webrtc !== null }} title="Preview"></ghq-player>` : nothing}
          <form class="inline" @submit=${this.announce}><input placeholder="Announcement to everyone"><button class="sm">Send</button></form>
          ${host ? html`
            <h2>CTAs</h2>
            ${d.ctas.map((c) => html`<div class="m"><strong>${c.label}</strong>
              <div class="acts">${this._cta?.id === c.id
                ? html`<button class="sm secondary" @click=${() => this.send({ type: 'hide_cta' })}>Hide</button>`
                : html`<button class="sm" @click=${() => this.send({ type: 'push_cta', cta: c })}>Push live</button>`}
              <span class="small muted">${c.push_mode === 'timed' && c.show_at_s != null ? `auto at ${Math.round(c.show_at_s / 60)} min` : 'manual'}</span></div></div>`)}
            <h2>Polls</h2>
            ${d.polls.map((p) => {
              const r = this._results[p.id] ?? {};
              const total = Object.values(r).reduce((a, b) => a + b, 0);
              return html`<div class="m"><strong>${p.question}</strong>
                ${p.options.map((o) => html`<div class="small">${o}: ${r[o] ?? 0} ${total ? `(${Math.round(((r[o] ?? 0) / total) * 100)}%)` : ''}</div>`)}
                <div class="acts">${this._poll?.id === p.id
                  ? html`<button class="sm secondary" @click=${() => this.send({ type: 'close_poll' })}>Close poll</button>`
                  : html`<button class="sm" @click=${() => this.send({ type: 'push_poll', poll: { ...p, show_results: false } })}>Launch</button>
                         <button class="sm secondary" @click=${() => this.send({ type: 'push_poll', poll: { ...p, show_results: true } })}>Launch + show results</button>`}</div></div>`;
            })}` : html`<p class="small muted">Moderators can manage chat and questions. CTAs, polls and ending the session are host-only.</p>`}
        </section>
      </div>`;
  }
}

customElements.get('ghq-host-console') || customElements.define('ghq-host-console', GhqHostConsole);
