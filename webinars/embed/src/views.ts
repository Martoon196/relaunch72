/** register · list · countdown views. The room lives in room.ts. */
import { html, css, LitElement, nothing } from 'lit';
import { Api, ApiError, emit, store } from './api.js';
import { countdown, localDateTime, shortDateTime, utmFromLocation } from './format.js';
import { base } from './styles.js';
import type { FormField, WebinarDetail } from './types.js';

declare global {
  interface Window { turnstile?: { render(el: HTMLElement, opts: Record<string, unknown>): string; reset(id?: string): void } }
}

let turnstileLoading: Promise<void> | null = null;
function loadTurnstile(): Promise<void> {
  if (window.turnstile) return Promise.resolve();
  turnstileLoading ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Turnstile failed to load'));
    document.head.appendChild(s);
  });
  return turnstileLoading;
}

export const tokenKey = (key: string, slug: string) => `ghq:${key.slice(0, 16)}:${slug}:token`;

// =====================================================================
// <ghq-register>
// =====================================================================

interface RegResult {
  registrant_id: string;
  already_registered: boolean;
  session: { id: string; starts_at: string | null; ends_at: string | null; kind: string };
  token: string | null;
  calendar: { ics_url: string; google_url: string; outlook_url: string } | null;
  thank_you_redirect_url: string | null;
}

export class GhqRegister extends LitElement {
  static properties = {
    api: { attribute: false },
    slug: {},
    turnstileKey: { attribute: false },
    _w: { state: true },
    _error: { state: true },
    _busy: { state: true },
    _done: { state: true },
    _slot: { state: true },
    _session: { state: true },
    _turnstileToken: { state: true },
  };
  declare api: Api;
  declare slug: string;
  declare turnstileKey: string | null;
  declare _w: WebinarDetail | null;
  declare _error: string | null;
  declare _busy: boolean;
  declare _done: RegResult | null;
  declare _slot: string;
  declare _session: string;
  declare _turnstileToken: string;
  private turnstileId: string | null = null;

  static styles = [base, css`
    .grid { display: grid; gap: 24px; grid-template-columns: 1fr; }
    @media (min-width: 820px) { .grid { grid-template-columns: 1.2fr 1fr; } }
    .presenter { display: flex; gap: 12px; align-items: center; }
    .presenter img { width: 56px; height: 56px; border-radius: 50%; object-fit: cover; }
    .slots { display: grid; gap: 8px; }
    .slot { display: flex; gap: 10px; align-items: center; padding: 10px 12px; border: 1px solid var(--ghq-border); border-radius: var(--ghq-radius); cursor: pointer; font-weight: 500; }
    .slot:has(input:checked) { border-color: var(--ghq-accent); box-shadow: 0 0 0 1px var(--ghq-accent); }
    .slot input { width: 18px; min-height: 18px; height: 18px; }
    .when { font-size: 1.05rem; font-weight: 600; }
    .cal a { margin-right: 14px; }
  `];

  constructor() {
    super();
    this.slug = '';
    this.turnstileKey = null;
    this._w = null;
    this._error = null;
    this._busy = false;
    this._done = null;
    this._slot = '';
    this._session = '';
    this._turnstileToken = '';
  }

  connectedCallback() {
    super.connectedCallback();
    void this.load();
  }

  private async load() {
    try {
      const res = await fetch(`${this.api.base}/v1/webinars/${encodeURIComponent(this.slug)}`, { headers: { 'x-ghq-key': this.api.key } });
      const json = await res.json();
      if (!res.ok) throw new ApiError(res.status, json.error?.code, json.error?.message ?? 'Not found');
      this._w = json.data as WebinarDetail;
      this.turnstileKey ??= json.turnstile_site_key ?? null;
      this._slot = this._w.slots[0] ?? '';
      this._session = this._w.sessions[0]?.id ?? '';
    } catch (e) {
      this._error = e instanceof Error ? e.message : 'Could not load this webinar';
    }
  }

  protected async updated() {
    const holder = this.renderRoot.querySelector<HTMLElement>('#turnstile');
    if (holder && !this.turnstileId && this.turnstileKey) {
      try {
        await loadTurnstile();
        this.turnstileId = window.turnstile!.render(holder, {
          sitekey: this.turnstileKey,
          callback: (t: string) => (this._turnstileToken = t),
          'expired-callback': () => (this._turnstileToken = ''),
          appearance: 'interaction-only',
        });
      } catch {
        this._error = 'Verification could not load. Please disable blockers and refresh.';
      }
    }
  }

  private async submit(e: Event) {
    e.preventDefault();
    const w = this._w!;
    const form = e.target as HTMLFormElement;
    const fd = new FormData(form);
    const answers: Record<string, string | boolean> = {};
    for (const f of w.config.registration.fields) {
      if (['name', 'email', 'phone'].includes(f.name)) continue;
      answers[f.name] = f.type === 'checkbox' ? fd.get(f.name) === 'on' : String(fd.get(f.name) ?? '');
    }
    this._busy = true;
    this._error = null;
    try {
      const sourceUrl = new URL(location.href);
      sourceUrl.searchParams.delete('ghq_token');
      const res = await this.api.req<RegResult>('POST', `/webinars/${encodeURIComponent(this.slug)}/registrations`, {
        email: fd.get('email'),
        name: fd.get('name') ?? '',
        phone: fd.get('phone') ?? '',
        answers,
        consent: fd.get('consent') === 'on',
        slot: w.type === 'evergreen' ? this._slot : undefined,
        session_id: w.type === 'live' ? this._session : undefined,
        turnstile_token: this._turnstileToken,
        source_url: sourceUrl.toString(),
        utm: utmFromLocation(),
      });
      if (res.token) store.set(tokenKey(this.api.key, this.slug), res.token);
      emit(this, 'ghq:registered', { webinar: this.slug, registrant_id: res.registrant_id, session: res.session, type: w.type });
      if (res.thank_you_redirect_url) {
        location.href = res.thank_you_redirect_url;
        return;
      }
      this._done = res;
    } catch (err) {
      this._error = err instanceof Error ? err.message : 'Registration failed';
      if (this.turnstileId) window.turnstile?.reset(this.turnstileId);
      this._turnstileToken = '';
    } finally {
      this._busy = false;
    }
  }

  private field(f: FormField) {
    const id = `f-${f.name}`;
    const req = !!f.required;
    if (f.type === 'checkbox') {
      return html`<label class="check" for=${id}><input id=${id} type="checkbox" name=${f.name} ?required=${req}> ${f.label}</label>`;
    }
    const input =
      f.type === 'select'
        ? html`<select id=${id} name=${f.name} ?required=${req}><option value="">Choose…</option>${(f.options ?? []).map((o) => html`<option>${o}</option>`)}</select>`
        : f.type === 'textarea'
          ? html`<textarea id=${id} name=${f.name} ?required=${req}></textarea>`
          : html`<input id=${id} name=${f.name} type=${f.type} ?required=${req} autocomplete=${f.name === 'email' ? 'email' : f.name === 'name' ? 'name' : f.name === 'phone' ? 'tel' : 'off'}>`;
    return html`<div><label for=${id}>${f.label}${req ? '' : html` <span class="muted small">(optional)</span>`}</label>${input}</div>`;
  }

  private joinNow() {
    this.dispatchEvent(new CustomEvent('ghq-go', { detail: { view: 'room', slug: this.slug }, bubbles: true, composed: true }));
  }

  private renderDone(w: WebinarDetail, r: RegResult) {
    const starts = r.session.starts_at;
    const opensSoon = !starts || Date.parse(starts) - Date.now() < w.config.defaults.room_opens_min_before * 60_000;
    return html`
      <div class="card stack" role="status" aria-live="polite">
        <h2>${r.already_registered ? 'You’re already registered' : 'You’re registered!'}</h2>
        ${starts ? html`<p class="when">${localDateTime(starts, w.config.defaults.locale)}</p>` : nothing}
        <p>${r.already_registered ? 'We’ve sent a fresh link to your email.' : 'Your personal link is on its way to your inbox.'}</p>
        ${r.token && opensSoon ? html`<button class="accent" @click=${this.joinNow}>Join now</button>` : nothing}
        ${r.calendar ? html`<p class="cal small">Add to calendar:
          <a href=${r.calendar.google_url} target="_blank" rel="noopener">Google</a>
          <a href=${r.calendar.outlook_url} target="_blank" rel="noopener">Outlook</a>
          <a href=${r.calendar.ics_url}>Apple / .ics</a></p>` : nothing}
      </div>`;
  }

  render() {
    if (this._error && !this._w) return html`<div class="card error" role="alert">${this._error}</div>`;
    const w = this._w;
    if (!w) return html`<div class="card muted" aria-busy="true">Loading…</div>`;
    const cfg = w.config;
    const locale = cfg.defaults.locale;
    return html`
      <div class="grid">
        <section class="stack">
          <span class="badge">${w.label}</span>
          <h1>${w.title}</h1>
          ${w.type === 'live' && w.sessions[0] ? html`<p class="when">${localDateTime(w.sessions[0].starts_at, locale)}</p>` : nothing}
          ${w.description ? html`<p>${w.description}</p>` : nothing}
          ${w.presenters.map((p) => html`<div class="presenter">${p.photo_url ? html`<img src=${p.photo_url} alt="">` : nothing}<div><strong>${p.name}</strong>${p.title ? html`<div class="muted small">${p.title}</div>` : nothing}</div></div>`)}
          ${w.agenda?.length ? html`<div><h2>What you’ll learn</h2><ul>${w.agenda.map((a) => html`<li>${a.title}</li>`)}</ul></div>` : nothing}
        </section>
        <section>
          ${this._done ? this.renderDone(w, this._done) : html`
          <form class="card stack" @submit=${this.submit} novalidate=${false}>
            <h2>${w.type === 'on_demand' ? 'Watch now' : 'Save your seat'}</h2>
            ${w.type === 'evergreen' ? html`
              <fieldset class="slots" style="border:0;padding:0;margin:0">
                <legend class="small" style="font-weight:600;margin-bottom:6px">Choose a time</legend>
                ${w.slots.length ? w.slots.slice(0, 6).map((s, i) => html`
                  <label class="slot"><input type="radio" name="slot" .checked=${i === 0} value=${s} @change=${() => (this._slot = s)}> ${shortDateTime(s, locale)}</label>`)
                  : html`<p class="muted">No upcoming times — check back soon.</p>`}
              </fieldset>` : nothing}
            ${w.type === 'live' && w.sessions.length > 1 ? html`
              <div><label for="f-session">Session</label>
                <select id="f-session" @change=${(e: Event) => (this._session = (e.target as HTMLSelectElement).value)}>
                  ${w.sessions.map((s) => html`<option value=${s.id}>${localDateTime(s.starts_at, locale)}</option>`)}
                </select></div>` : nothing}
            ${cfg.registration.fields.map((f) => this.field(f))}
            <label class="check small"><input type="checkbox" name="consent" required>
              <span>${cfg.registration.consent_text} ${cfg.registration.privacy_url ? html`<a href=${cfg.registration.privacy_url} target="_blank" rel="noopener">Privacy policy</a>` : nothing}</span></label>
            <div id="turnstile"></div>
            ${this._error ? html`<p class="error" role="alert">${this._error}</p>` : nothing}
            <button type="submit" class="accent" ?disabled=${this._busy || (w.type === 'evergreen' && !this._slot)}>${this._busy ? 'Registering…' : w.type === 'on_demand' ? 'Get instant access' : 'Register'}</button>
            ${cfg.compliance.risk_warning ? html`<p class="risk">${cfg.compliance.risk_warning}</p>` : nothing}
          </form>`}
        </section>
      </div>`;
  }
}

// =====================================================================
// <ghq-list>
// =====================================================================

export class GhqList extends LitElement {
  static properties = {
    api: { attribute: false },
    filter: {},
    layout: {},
    hrefTemplate: { attribute: false },
    _items: { state: true },
    _error: { state: true },
  };
  declare api: Api;
  declare filter: 'upcoming' | 'on_demand';
  declare layout: 'card' | 'list';
  declare hrefTemplate: string | null;
  declare _items: WebinarDetail[] | null;
  declare _error: string | null;

  static styles = [base, css`
    .cards { display: grid; gap: 16px; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); }
    .list { display: grid; gap: 10px; }
    .item { display: flex; flex-direction: column; gap: 8px; text-align: left; cursor: pointer; color: inherit; background: var(--ghq-surface); border: 1px solid var(--ghq-border); border-radius: var(--ghq-radius); padding: 18px; font-weight: 400; min-height: 0; }
    .list .item { flex-direction: row; align-items: center; justify-content: space-between; }
    .item:hover { border-color: var(--ghq-accent); }
    .item h3 { margin: 0; font-size: 1.05rem; }
  `];

  constructor() {
    super();
    this.filter = 'upcoming';
    this.layout = 'card';
    this.hrefTemplate = null;
    this._items = null;
    this._error = null;
  }

  connectedCallback() {
    super.connectedCallback();
    this.api.req<WebinarDetail[]>('GET', `/webinars?view=${this.filter}`).then((d) => (this._items = d), (e) => (this._error = e.message));
  }

  private open(w: WebinarDetail) {
    if (this.hrefTemplate) {
      location.href = this.hrefTemplate.replace('{slug}', encodeURIComponent(w.slug));
      return;
    }
    this.dispatchEvent(new CustomEvent('ghq-go', { detail: { view: 'register', slug: w.slug }, bubbles: true, composed: true }));
  }

  render() {
    if (this._error) return html`<p class="error">${this._error}</p>`;
    if (!this._items) return html`<p class="muted" aria-busy="true">Loading…</p>`;
    if (!this._items.length) return html`<p class="muted">No ${this.filter === 'on_demand' ? 'on-demand' : 'upcoming'} webinars right now.</p>`;
    return html`<div class=${this.layout === 'list' ? 'list' : 'cards'} role="list">
      ${this._items.map((w) => html`
        <button class="item" role="listitem" @click=${() => this.open(w)}>
          <span class="badge">${w.label}</span>
          <h3>${w.title}</h3>
          <span class="muted small">${w.next_start ? shortDateTime(w.next_start) : w.duration_s ? `${Math.round(w.duration_s / 60)} min` : 'Watch now'}</span>
        </button>`)}
    </div>`;
  }
}

// =====================================================================
// <ghq-countdown>
// =====================================================================

export class GhqCountdown extends LitElement {
  static properties = {
    api: { attribute: false },
    slug: {},
    href: {},
    _w: { state: true },
    _now: { state: true },
  };
  declare api: Api;
  declare slug: string;
  declare href: string;
  declare _w: WebinarDetail | null;
  declare _now: number;
  private timer: number | undefined;

  static styles = [base, css`
    .bar { display: flex; flex-wrap: wrap; gap: 10px 16px; align-items: center; justify-content: space-between; padding: 10px 16px; background: var(--ghq-primary); color: #fff; border-radius: var(--ghq-radius); }
    .bar strong { font-weight: 600; }
    .bar .btn { background: var(--ghq-accent); border-color: var(--ghq-accent); min-height: 38px; padding: 6px 14px; }
    .t { font-variant-numeric: tabular-nums; opacity: .9; }
  `];

  constructor() {
    super();
    this.slug = '';
    this.href = '';
    this._w = null;
    this._now = Date.now();
  }

  async connectedCallback() {
    super.connectedCallback();
    this.timer = window.setInterval(() => (this._now = Date.now()), 1000);
    try {
      if (this.slug) {
        const w = await this.api.req<WebinarDetail>('GET', `/webinars/${encodeURIComponent(this.slug)}`);
        w.next_start = w.sessions[0]?.starts_at ?? w.slots[0] ?? null;
        w.live_now = w.sessions[0]?.status === 'live';
        this._w = w;
      } else {
        this._w = (await this.api.req<WebinarDetail[]>('GET', '/webinars?view=upcoming'))[0] ?? null;
      }
    } catch {
      this._w = null;
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    clearInterval(this.timer);
  }

  render() {
    const w = this._w;
    if (!w?.next_start) return nothing;
    const ms = w.live_now ? 0 : Date.parse(w.next_start) - this._now;
    const link = this.href ? this.href.replace('{slug}', w.slug) : w.hosted_url ?? '#';
    return html`<div class="bar" role="region" aria-label="Upcoming webinar">
      <span><strong>${w.title}</strong> <span class="t">· ${w.live_now ? 'live now' : ms > 0 ? `${w.type === 'evergreen' ? 'next showing' : 'starts'} in ${countdown(ms)}` : 'starting now'}</span></span>
      <a class="btn" href=${link}>${w.live_now ? 'Join now' : 'Register free'}</a>
    </div>`;
  }
}

for (const [n, c] of [['ghq-register', GhqRegister], ['ghq-list', GhqList], ['ghq-countdown', GhqCountdown]] as const) {
  customElements.get(n) || customElements.define(n, c);
}
