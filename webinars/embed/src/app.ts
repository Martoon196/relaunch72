/**
 * <ghq-webinar webinar="slug" view="register|room|replay|list|countdown"
 *              theme="light|dark" accent="#C8A04B" layout="card|list" filter="upcoming|on_demand"
 *              href="/webinars/{slug}" key="pk_…">
 * Everything renders inside Shadow DOM, themed from the brand's config. Emits
 * ghq:registered, ghq:joined and ghq:cta-click on the element (bubbling, composed)
 * so the host site can fire its own Meta / GA4 pixels.
 */
import { html, css, LitElement, nothing } from 'lit';
import { Api, embedConfig } from './api.js';
import './host-console.js';
import './room.js';
import { base, loadFont, themeVars } from './styles.js';
import type { PublicConfig } from './types.js';
import './views.js';
import { tokenKey } from './views.js';
import { store } from './api.js';

type View = 'register' | 'room' | 'replay' | 'list' | 'countdown';

export class GhqWebinar extends LitElement {
  static properties = {
    webinar: { reflect: true },
    view: { reflect: true },
    theme: { reflect: true },
    accent: {},
    layout: {},
    filter: {},
    href: {},
    key: {},
    token: {},
    _cfg: { state: true },
    _turnstile: { state: true },
    _error: { state: true },
  };
  declare webinar: string;
  declare view: View;
  declare theme: 'light' | 'dark' | 'auto';
  declare accent: string | null;
  declare layout: 'card' | 'list';
  declare filter: 'upcoming' | 'on_demand';
  declare href: string;
  declare key: string;
  declare token: string | null;
  declare _cfg: PublicConfig | null;
  declare _turnstile: string | null;
  declare _error: string | null;
  private api!: Api;

  static styles = [base, css`
    :host { background: transparent; }
    .root { color: var(--ghq-text); }
    :host([theme='dark']) .root { background: var(--ghq-bg); border-radius: var(--ghq-radius); padding: 18px; }
    @media (prefers-color-scheme: dark) { :host([theme='auto']) .root { background: var(--ghq-bg); border-radius: var(--ghq-radius); padding: 18px; } }
  `];

  constructor() {
    super();
    this.webinar = '';
    this.view = 'register';
    this.theme = 'light';
    this.accent = null;
    this.layout = 'card';
    this.filter = 'upcoming';
    this.href = '';
    this.key = '';
    this.token = null;
    this._cfg = null;
    this._turnstile = null;
    this._error = null;
  }

  connectedCallback() {
    super.connectedCallback();
    const cfg = embedConfig();
    this.api = new Api(cfg.api, this.key || cfg.key);
    // Magic-link deep links land on whatever page registered the person.
    const q = new URLSearchParams(location.search);
    if (q.get('ghq_token') && (q.get('ghq_view') === 'room' || this.view === 'register')) this.view = 'room';
    else if (this.view === 'register' && this.webinar && store.get(tokenKey(this.api.key, this.webinar)) && q.get('ghq_view') === 'room') this.view = 'room';
    this.addEventListener('ghq-go', ((e: CustomEvent<{ view: View; slug: string }>) => {
      this.webinar = e.detail.slug;
      this.view = e.detail.view;
    }) as EventListener);
    this.api.req<{ config: PublicConfig; turnstile_site_key: string | null }>('GET', '/brand').then(
      (r) => {
        this._cfg = r.config;
        this._turnstile = r.turnstile_site_key;
        loadFont(r.config.theme.font_url);
      },
      (e) => (this._error = e.message),
    );
  }

  private mode(): 'light' | 'dark' {
    if (this.theme === 'dark') return 'dark';
    if (this.theme === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches) return 'dark';
    return 'light';
  }

  render() {
    if (this._error) return html`<p class="error" role="alert">${this._error}</p>`;
    if (!this._cfg) return html`<div aria-busy="true" aria-label="Loading" style="min-height:120px"></div>`;
    const style = themeVars(this._cfg.theme, this.mode(), this.accent);
    const v = this.view;
    let body: unknown = nothing;
    if (v === 'list') body = html`<ghq-list .api=${this.api} filter=${this.filter} layout=${this.layout} .hrefTemplate=${this.href || null}></ghq-list>`;
    else if (v === 'countdown') body = html`<ghq-countdown .api=${this.api} slug=${this.webinar} href=${this.href}></ghq-countdown>`;
    else if (!this.webinar) body = html`<p class="error">Missing webinar attribute.</p>`;
    else if (v === 'room' || v === 'replay') body = html`<ghq-room .api=${this.api} slug=${this.webinar} token=${this.token ?? ''}></ghq-room>`;
    else body = html`<ghq-register .api=${this.api} slug=${this.webinar} .turnstileKey=${this._turnstile}></ghq-register>`;
    return html`<div class="root" style=${style} part="root">${body}</div>`;
  }
}

customElements.get('ghq-webinar') || customElements.define('ghq-webinar', GhqWebinar);
