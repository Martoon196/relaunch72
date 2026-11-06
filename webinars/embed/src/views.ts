/** register · list · countdown views. The room lives in room.ts. */
import { html, css, LitElement, nothing } from 'lit';
import { Api, ApiError, emit, store } from './api.js';
import { countdownParts, localDate, localTime, shortDateTime, utmFromLocation } from './format.js';
import { icon } from './icons.js';
import { base, hueFor, initials } from './styles.js';
import type { FormField, Presenter, WebinarDetail } from './types.js';

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

export const presenterCard = (p: Presenter, size: 'md' | 'lg' = 'md') => html`
  <div class="presenter ${size}">
    ${p.photo_url ? html`<img class="avatar" src=${p.photo_url} alt="">` : html`<span class="avatar" style="--h:${hueFor(p.name)}">${initials(p.name)}</span>`}
    <div><strong>${p.name}</strong>${p.title ? html`<div class="muted small">${p.title}</div>` : nothing}${size === 'lg' && p.bio ? html`<p class="small muted" style="margin:6px 0 0">${p.bio}</p>` : nothing}</div>
  </div>`;

/** Segmented countdown (days · hours · minutes · seconds). */
export const countdownTiles = (ms: number) => {
  const parts = countdownParts(ms);
  return html`<div class="tiles" role="timer" aria-live="off">
    ${parts.map((p) => html`<div class="tile"><span class="n">${String(p.value).padStart(2, '0')}</span><span class="l">${p.label}</span></div>`)}
  </div>`;
};

export const tilesCss = css`
  .tiles { display: inline-flex; gap: 8px; }
  .tile { display: grid; justify-items: center; min-width: 64px; padding: 10px 8px 8px; border-radius: calc(var(--ghq-radius) * .8); background: var(--ghq-surface); border: 1px solid var(--ghq-border); }
  .tile .n { font-size: 1.75rem; font-weight: 800; line-height: 1; font-variant-numeric: tabular-nums; letter-spacing: -.02em; }
  .tile .l { font-size: .65rem; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: var(--ghq-muted); margin-top: 6px; }
`;

const skeletonCss = css`
  .sk-grid { display: grid; gap: 24px; grid-template-columns: 1fr; }
  @media (min-width: 820px) { .sk-grid { grid-template-columns: 1.15fr 1fr; } }
  .sk-grid .skeleton { margin-bottom: 14px; }
`;

const skeletonRegister = html`<div class="sk-grid" aria-busy="true" aria-label="Loading">
  <div><div class="skeleton" style="width:90px;height:20px"></div><div class="skeleton" style="width:70%;height:38px"></div><div class="skeleton" style="width:45%;height:22px"></div><div class="skeleton" style="height:60px"></div><div class="skeleton" style="width:60%;height:44px"></div></div>
  <div class="card"><div class="skeleton" style="width:40%;height:24px"></div><div class="skeleton" style="height:46px"></div><div class="skeleton" style="height:46px"></div><div class="skeleton" style="height:46px"></div><div class="skeleton" style="width:40%;height:46px;border-radius:999px"></div></div>
</div>`;

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

  static styles = [base, skeletonCss, css`
    .grid { display: grid; gap: 28px; grid-template-columns: 1fr; align-items: start; }
    @media (min-width: 820px) { .grid { grid-template-columns: 1.15fr 1fr; gap: 40px; } .form { position: sticky; top: 16px; } }
    .lede { font-size: 1.05rem; color: var(--ghq-muted); max-width: 56ch; }
    .meta { display: flex; flex-wrap: wrap; gap: 8px; margin: 14px 0 18px; }
    .presenters { display: grid; gap: 14px; margin-top: 8px; }
    .presenter { display: flex; gap: 12px; align-items: flex-start; }
    .presenter .avatar { width: 48px; height: 48px; }
    .learn li { display: flex; gap: 10px; align-items: flex-start; padding: 6px 0; }
    .learn li svg { width: 20px; height: 20px; color: var(--ghq-accent); flex: none; margin-top: 2px; }
    .learn li .t { color: var(--ghq-muted); font-variant-numeric: tabular-nums; margin-right: 4px; }
    .form h2 { display: flex; align-items: center; gap: 8px; }
    .form h2 svg { width: 20px; height: 20px; color: var(--ghq-accent); }
    .slots { display: grid; gap: 8px; }
    .slots .choice .d { flex: 1; }
    .slots .choice .t { font-weight: 700; font-variant-numeric: tabular-nums; }
    .slots .soon { font-size: .7rem; font-weight: 700; color: var(--ghq-accent); text-transform: uppercase; letter-spacing: .06em; }
    .submit { width: 100%; font-size: 1rem; }
    .done { text-align: center; padding: 34px 24px; }
    .done .tick { width: 64px; height: 64px; border-radius: 50%; display: grid; place-items: center; margin: 0 auto 16px; background: var(--_accent-soft); color: var(--ghq-accent); }
    .done .tick svg { width: 34px; height: 34px; }
    .done .when { font-size: 1.1rem; font-weight: 700; }
    .cal { display: flex; flex-wrap: wrap; gap: 8px; justify-content: center; margin-top: 18px; }
    .cal a { text-decoration: none; color: var(--ghq-text); }
    .privacy { margin-top: 2px; }
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
    if (!form.reportValidity()) return;
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
      return html`<label class="check" for=${id}><input id=${id} type="checkbox" name=${f.name} ?required=${req}> <span>${f.label}</span></label>`;
    }
    const input =
      f.type === 'select'
        ? html`<select id=${id} name=${f.name} ?required=${req}><option value="">Choose…</option>${(f.options ?? []).map((o) => html`<option>${o}</option>`)}</select>`
        : f.type === 'textarea'
          ? html`<textarea id=${id} name=${f.name} ?required=${req}></textarea>`
          : html`<input id=${id} name=${f.name} type=${f.type} ?required=${req} autocomplete=${f.name === 'email' ? 'email' : f.name === 'name' ? 'name' : f.name === 'phone' ? 'tel' : 'off'}>`;
    return html`<div><label for=${id}>${f.label}${req ? '' : html` <span class="muted" style="font-weight:400">(optional)</span>`}</label>${input}</div>`;
  }

  private joinNow() {
    this.dispatchEvent(new CustomEvent('ghq-go', { detail: { view: 'room', slug: this.slug }, bubbles: true, composed: true }));
  }

  private renderDone(w: WebinarDetail, r: RegResult) {
    const starts = r.session.starts_at;
    const opensSoon = !starts || Date.parse(starts) - Date.now() < w.config.defaults.room_opens_min_before * 60_000;
    const locale = w.config.defaults.locale;
    return html`
      <div class="card done rise" role="status" aria-live="polite">
        <div class="tick">${icon.check()}</div>
        <h2>${r.already_registered ? 'You’re already registered' : 'You’re in!'}</h2>
        ${starts ? html`<p class="when">${localDate(starts, locale)}<br><span class="muted" style="font-weight:500">${localTime(starts, locale)}</span></p>` : nothing}
        <p class="muted">${r.already_registered ? 'We’ve sent a fresh link to your inbox.' : w.type === 'on_demand' ? 'Your personal link is on its way, and you can start watching right now.' : 'Your personal link is on its way to your inbox.'}</p>
        ${r.token && opensSoon ? html`<button class="accent" @click=${this.joinNow}>${w.type === 'on_demand' ? 'Watch now' : 'Join now'} ${icon.arrow()}</button>` : nothing}
        ${r.calendar ? html`<div class="cal">
          <a class="pill" href=${r.calendar.google_url} target="_blank" rel="noopener">${icon.calendar()} Google</a>
          <a class="pill" href=${r.calendar.outlook_url} target="_blank" rel="noopener">${icon.calendar()} Outlook</a>
          <a class="pill" href=${r.calendar.ics_url}>${icon.download()} Apple / .ics</a></div>` : nothing}
      </div>`;
  }

  render() {
    if (this._error && !this._w) return html`<div class="alert" role="alert">${icon.alert()}<span>${this._error}</span></div>`;
    const w = this._w;
    if (!w) return skeletonRegister;
    const cfg = w.config;
    const locale = cfg.defaults.locale;
    const next = w.type === 'live' ? w.sessions[0]?.starts_at : w.type === 'evergreen' ? w.slots[0] : null;
    const now = Date.now();
    return html`
      <div class="grid fade-in">
        <section>
          <span class="eyebrow">${w.label}</span>
          <h1>${w.title}</h1>
          <div class="meta">
            ${next ? html`<span class="pill">${icon.calendar()} ${w.type === 'evergreen' ? 'Next showing' : ''} ${shortDateTime(next, locale)}</span>` : nothing}
            ${w.duration_s ? html`<span class="pill">${icon.clock()} ${Math.round(w.duration_s / 60)} min</span>` : nothing}
            ${w.type === 'on_demand' ? html`<span class="pill">${icon.play()} Watch any time</span>` : nothing}
          </div>
          ${w.description ? html`<p class="lede">${w.description}</p>` : nothing}
          ${w.presenters.length ? html`<div class="presenters">${w.presenters.map((p) => presenterCard(p))}</div>` : nothing}
          ${w.agenda?.length ? html`<div style="margin-top:22px"><h3>What you’ll learn</h3><ul class="learn">${w.agenda.map((a) => html`<li>${icon.checkCircle()}<span>${a.time ? html`<span class="t">${a.time}</span>` : nothing}${a.title}</span></li>`)}</ul></div>` : nothing}
        </section>
        <section class="form">
          ${this._done ? this.renderDone(w, this._done) : html`
          <form class="card stack" @submit=${this.submit} novalidate>
            <h2>${w.type === 'on_demand' ? html`${icon.play()} Watch now` : html`${icon.sparkle()} Save your seat`}</h2>
            ${w.type === 'evergreen' ? html`
              <fieldset class="slots" style="border:0;padding:0;margin:0">
                <legend class="small" style="font-weight:600;margin-bottom:8px">Choose a time</legend>
                ${w.slots.length ? w.slots.slice(0, 6).map((s, i) => html`
                  <label class="choice"><input type="radio" name="slot" .checked=${i === 0} value=${s} @change=${() => (this._slot = s)}>
                    <span class="d">${localDate(s, locale)}</span><span class="t">${localTime(s, locale)}</span>
                    ${Date.parse(s) - now < 20 * 60_000 ? html`<span class="soon">Starting soon</span>` : nothing}</label>`)
                  : html`<p class="muted">No upcoming times — check back soon.</p>`}
              </fieldset>` : nothing}
            ${w.type === 'live' && w.sessions.length > 1 ? html`
              <div><label for="f-session">Session</label>
                <select id="f-session" @change=${(e: Event) => (this._session = (e.target as HTMLSelectElement).value)}>
                  ${w.sessions.map((s) => html`<option value=${s.id}>${shortDateTime(s.starts_at, locale)}</option>`)}
                </select></div>` : nothing}
            ${cfg.registration.fields.map((f) => this.field(f))}
            <label class="check small"><input type="checkbox" name="consent" required>
              <span>${cfg.registration.consent_text} ${cfg.registration.privacy_url ? html`<a class="privacy" href=${cfg.registration.privacy_url} target="_blank" rel="noopener">Privacy policy</a>` : nothing}</span></label>
            <div id="turnstile"></div>
            ${this._error ? html`<div class="alert" role="alert">${icon.alert()}<span>${this._error}</span></div>` : nothing}
            <button type="submit" class="accent submit ${this._busy ? 'busy' : ''}" ?disabled=${this._busy || (w.type === 'evergreen' && !this._slot)}>
              ${this._busy ? 'One moment…' : w.type === 'on_demand' ? 'Get instant access' : 'Register free'} ${this._busy ? nothing : icon.arrow()}
            </button>
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
    .cards { display: grid; gap: 16px; grid-template-columns: repeat(auto-fill, minmax(270px, 1fr)); }
    .list { display: grid; gap: 10px; }
    .item {
      display: flex; flex-direction: column; gap: 10px; text-align: left; cursor: pointer; color: inherit; min-height: 0; padding: 0;
      background: var(--ghq-surface-2); border: 1px solid var(--ghq-border); border-radius: var(--ghq-radius); font-weight: 400; overflow: hidden;
      box-shadow: var(--ghq-shadow);
    }
    .item .top { height: 5px; width: 100%; background: linear-gradient(90deg, var(--ghq-primary), var(--ghq-accent)); }
    .item .body { padding: 14px 18px 18px; display: flex; flex-direction: column; gap: 10px; width: 100%; }
    .list .item .body { flex-direction: row; align-items: center; gap: 14px; }
    .list .item .top { display: none; }
    .list .item h3 { flex: 1; }
    .item:hover { transform: translateY(-2px); border-color: var(--_accent-line); }
    .item h3 { margin: 0; font-size: 1.08rem; }
    .item .when { display: inline-flex; align-items: center; gap: 6px; font-size: .85rem; color: var(--ghq-muted); }
    .item .when svg { width: 15px; height: 15px; }
    .item .go { margin-top: auto; display: inline-flex; align-items: center; gap: 6px; color: var(--ghq-accent); font-weight: 600; font-size: .9rem; }
    .item .go svg { width: 16px; height: 16px; transition: transform .2s; }
    .item:hover .go svg { transform: translateX(3px); }
    .list .item .go { margin: 0; }
    .empty { text-align: center; padding: 30px; color: var(--ghq-muted); }
    .empty svg { width: 32px; height: 32px; margin-bottom: 8px; color: var(--ghq-accent); }
    .sk { display: grid; gap: 16px; grid-template-columns: repeat(auto-fill, minmax(270px, 1fr)); }
    .sk .skeleton { height: 150px; border-radius: var(--ghq-radius); }
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
    if (this._error) return html`<div class="alert" role="alert">${icon.alert()}<span>${this._error}</span></div>`;
    if (!this._items) return html`<div class="sk" aria-busy="true"><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div></div>`;
    if (!this._items.length) return html`<div class="card flat empty">${icon.calendar()}<div>No ${this.filter === 'on_demand' ? 'on-demand' : 'upcoming'} webinars right now.</div></div>`;
    return html`<div class="${this.layout === 'list' ? 'list' : 'cards'} fade-in" role="list">
      ${this._items.map((w, i) => html`
        <button class="item rise" style="animation-delay:${i * 50}ms" role="listitem" @click=${() => this.open(w)}>
          <span class="top"></span>
          <span class="body">
            <span class="badge ${w.live_now ? 'live' : ''}">${w.live_now ? 'Live now' : w.label}</span>
            <h3>${w.title}</h3>
            <span class="when">${w.next_start ? html`${icon.calendar()} ${shortDateTime(w.next_start)}` : html`${icon.clock()} ${w.duration_s ? `${Math.round(w.duration_s / 60)} min · ` : ''}Watch any time`}</span>
            <span class="go">${w.live_now ? 'Join now' : w.type === 'on_demand' ? 'Watch' : 'Register'} ${icon.arrow()}</span>
          </span>
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

  static styles = [base, tilesCss, css`
    .bar {
      display: flex; flex-wrap: wrap; gap: 12px 20px; align-items: center; justify-content: space-between; padding: 14px 18px;
      background: linear-gradient(110deg, var(--ghq-primary), color-mix(in srgb, var(--ghq-primary) 70%, var(--ghq-accent))); color: #fff; border-radius: var(--ghq-radius);
      box-shadow: var(--ghq-shadow);
    }
    .bar .t { font-size: .72rem; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; opacity: .8; }
    .bar strong { font-size: 1.05rem; display: block; }
    .bar .btn { background: var(--ghq-accent); border-color: var(--ghq-accent); color: #fff; min-height: 42px; padding: 8px 18px; }
    .tiles { gap: 6px; }
    .tile { min-width: 52px; padding: 7px 6px 6px; background: rgba(255,255,255,.12); border-color: rgba(255,255,255,.18); color: #fff; }
    .tile .n { font-size: 1.3rem; }
    .tile .l { color: rgba(255,255,255,.75); margin-top: 3px; }
    .live { display: inline-flex; align-items: center; gap: 8px; font-weight: 700; }
    .live .dot { background: #fb7185; color: #fb7185; }
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
    return html`<div class="bar fade-in" role="region" aria-label="Upcoming webinar">
      <span><span class="t">${w.live_now ? 'Happening now' : w.type === 'evergreen' ? 'Next showing' : 'Live webinar'}</span><strong>${w.title}</strong></span>
      ${w.live_now ? html`<span class="live"><span class="dot pulse"></span> Live now</span>` : ms > 0 ? countdownTiles(ms) : html`<span class="live">Starting…</span>`}
      <a class="btn" href=${link}>${w.live_now ? 'Join now' : 'Register free'} ${icon.arrow()}</a>
    </div>`;
  }
}

for (const [n, c] of [['ghq-register', GhqRegister], ['ghq-list', GhqList], ['ghq-countdown', GhqCountdown]] as const) {
  customElements.get(n) || customElements.define(n, c);
}
