/**
 * Server-rendered portal views. All numbers and artifacts come from the tenant
 * dashboard object; unavailable expansion modules are labelled as planned and
 * never rendered as functioning controls.
 */

import type { DashboardData } from './data.js';
import type { BillingView } from './billing.js';
import { PIPELINE_STAGES, type PipelineStage } from '../crm/types.js';
import { appShell, escapeHtml as esc, icon, pageHead, plannedPortalModules, portalModuleIcon } from './ui.js';

export function accountSetupPage(setupCsrfToken: string, error?: string): string {
  return `${pageHead('Relaunch72 — Set up your account')}<body>
    <main class="auth-shell">
      <section class="auth-panel" aria-labelledby="setup-title">
        <div class="auth-card">
          <div class="auth-brand"><span class="brand-mark">R72</span><strong>RELAUNCH72</strong></div>
          <h1 id="setup-title">Choose your password.</h1>
          <p class="auth-lead">Use at least 12 characters. This private setup link works once.</p>
          ${error ? `<div class="auth-error" role="alert">${icon('lock')}<span>${esc(error)}</span></div>` : ''}
          <form method="post" action="/portal/setup">
            <input type="hidden" name="_setup_csrf" value="${esc(setupCsrfToken)}">
            <div class="field"><label for="password">Password</label><input id="password" name="password" type="password" minlength="12" maxlength="1024" autocomplete="new-password" aria-describedby="password-hint" required autofocus></div>
            <p class="auth-foot" id="password-hint" style="text-align:left;margin:-7px 0 15px">12–1,024 characters · a password manager is recommended</p>
            <div class="field"><label for="confirm">Confirm password</label><input id="confirm" name="confirm" type="password" minlength="12" maxlength="1024" autocomplete="new-password" required></div>
            <button class="button auth-button" type="submit">Set password and continue ${icon('chevron')}</button>
          </form>
          <p class="auth-foot">Private one-time setup · the link cannot be reused</p>
        </div>
      </section>
      <aside class="auth-story" aria-label="Account security"><div class="auth-story-inner"><div class="auth-kicker">One secure step</div><h2>Your workspace<br>is waiting.</h2><p>Set your password to open the private Relaunch72 command centre. Your account stays isolated to its own workspace.</p><div class="auth-modules"><span>One-use setup link</span><span>Secure session</span><span>No public publishing</span></div></div></aside>
    </main>
  </body></html>`;
}

export function accountSetupUnavailablePage(message = 'Account setup is not open yet. Ask the Relaunch72 team to provision pilot access.'): string {
  return `${pageHead('Relaunch72 — Account setup')}<body>
    <main class="auth-shell">
      <section class="auth-panel" aria-labelledby="setup-title">
        <div class="auth-card">
          <a class="auth-brand" href="/portal/login" aria-label="Relaunch72 sign in"><span class="brand-mark">R72</span><strong>RELAUNCH72</strong></a>
          <h1 id="setup-title">Setup is currently paused.</h1>
          <div class="auth-error" role="status">${icon('lock')}<span>${esc(message)}</span></div>
          <a class="button auth-button" href="/portal/login">Return to sign in ${icon('chevron')}</a>
          <p class="auth-foot">No password or account change has been made.</p>
        </div>
      </section>
      <aside class="auth-story" aria-label="Account security"><div class="auth-story-inner"><div class="auth-kicker">Pilot access</div><h2>Deliberate setup.<br>Clean access.</h2><p>New workspaces stay locked until identity, CRM data and the private dashboard are provisioned together.</p><div class="auth-modules"><span>Least-privilege access</span><span>Workspace isolation</span><span>No silent fallback</span></div></div></aside>
    </main>
  </body></html>`;
}

export function loginPage(error?: string, email = '', loginCsrfToken = ''): string {
  return `${pageHead('Relaunch72 — Sign in')}<body>
    <main class="auth-shell">
      <section class="auth-panel" aria-labelledby="login-title">
        <div class="auth-card">
          <a class="auth-brand" href="/portal/login" aria-label="Relaunch72 sign in"><span class="brand-mark">R72</span><strong>RELAUNCH72</strong></a>
          <h1 id="login-title">Welcome back.</h1>
          <p class="auth-lead">Sign in to your private marketing workspace.</p>
          ${error ? `<div class="auth-error" role="alert">${icon('lock')}<span>${esc(error)}</span></div>` : ''}
          <form method="post" action="/portal/login">
            <input type="hidden" name="_login_csrf" value="${esc(loginCsrfToken)}">
            <div class="field"><label for="email">Email address</label><input id="email" name="email" type="email" inputmode="email" autocomplete="username" autocapitalize="none" spellcheck="false" value="${esc(email)}" required autofocus></div>
            <div class="field"><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required></div>
            <button class="button auth-button" type="submit">Sign in securely ${icon('chevron')}</button>
          </form>
          <p class="auth-foot">Private sandbox · secure session · no public publishing</p>
        </div>
      </section>
      <aside class="auth-story" aria-label="Product preview">
        <div class="auth-story-inner"><div class="auth-kicker">Your marketing command centre</div><h2>Clear work.<br>Calm control.</h2><p>Work your contacts, opportunities and tasks alongside generated drafts. Channel publishing remains safely locked until each integration is production-ready.</p>
          <div class="auth-modules" aria-label="Workspace modules"><span>CRM workspace</span><span>Content drafts</span><span class="planned">Social · planned</span><span class="planned">WhatsApp · planned</span><span class="planned">Listening · planned</span></div>
        </div>
      </aside>
    </main>
  </body></html>`;
}

const ACTIVITY_MARK: Record<string, string> = { rail_run: '✦', stage_changed: '→', contact_created: '+', message_sent: '↗', note: '•' };
const STAGE_CLASS: Record<PipelineStage, string> = { lead: 'stage-lead', contacted: 'stage-contacted', qualified: 'stage-qualified', won: 'stage-won', lost: 'stage-lost' };

function billingStat(billing: BillingView): { cls: string; label: string } {
  if (billing.active) return { cls: 'ok', label: billing.status === 'trialing' ? 'Trialing' : 'Active' };
  if (billing.status === 'past_due' || billing.status === 'unpaid') return { cls: 'warn', label: 'Payment due' };
  if (billing.status === 'canceled') return { cls: '', label: 'Canceled' };
  if (billing.status === 'none') return { cls: '', label: 'No plan' };
  return { cls: '', label: billing.status.replace(/_/g, ' ') };
}

function billingCard(billing: BillingView): string {
  const state = billingStat(billing);
  const renewal = billing.active && billing.currentPeriodEnd
    ? `<p class="event-time">Renews ${esc(billing.currentPeriodEnd.slice(0, 10))}</p>` : '';
  return `<section class="panel" aria-labelledby="plan-card-title">
    <div class="panel-head"><div class="panel-title-wrap"><h2 id="plan-card-title">Your plan</h2><p class="panel-subtitle">Workspace subscription</p></div>${icon('billing')}</div>
    <div class="panel-body"><div class="plan-card-inline"><span class="plan-name">${esc(billing.planName ?? 'Not subscribed')}</span><span class="status ${state.cls}"><span class="dot"></span>${esc(state.label)}</span></div>${renewal}<a class="billing-link" href="/portal/billing">${billing.active ? 'Manage plan' : 'See planned tiers'} ${icon('chevron')}</a></div>
  </section>`;
}

export function billingPage(tenantName: string, billing: BillingView, opts: { canManage?: boolean; canSubscribe?: boolean; notice?: string; crmAvailable?: boolean; csrfToken?: string } = {}): string {
  const state = billingStat(billing);
  const previewNotice = opts.canSubscribe === true ? '' : `<div class="notice" role="note">${icon('lock')}<span><strong>Plan preview only.</strong> Recurring checkout is paused while the durable platform and connected delivery services are completed.</span></div>`;
  const notice = opts.notice ? `<div class="notice" role="status">${icon('activity')}<span>${esc(opts.notice)}</span></div>` : '';
  const renewal = billing.active && billing.currentPeriodEnd ? ` · renews ${esc(billing.currentPeriodEnd.slice(0, 10))}` : '';
  const csrfField = opts.csrfToken ? `<input type="hidden" name="_csrf" value="${esc(opts.csrfToken)}">` : '';
  const manage = opts.canManage && billing.customerId
    ? `<form method="post" action="/portal/manage">${csrfField}<button class="button secondary" type="submit">Manage billing ${icon('chevron')}</button></form>` : '';

  const plans = billing.options.map((option) => {
    const current = billing.active && billing.planKey === option.key;
    const callToAction = current
      ? '<div class="current-plan-tag">✓ Your current plan</div>'
      : billing.active
        ? '<div class="current-plan-tag">Use Manage billing</div>'
        : opts.canSubscribe === true
          ? `<form method="post" action="/portal/subscribe">${csrfField}<input type="hidden" name="plan" value="${esc(option.key)}"><button class="button" style="width:100%" type="submit">Subscribe →</button></form>`
          : `<div class="current-plan-tag">${icon('lock')} Checkout paused</div>`;
    return `<article class="plan${current ? ' current' : ''}"><h3>${esc(option.name)}</h3><div class="plan-price">${esc(option.priceLabel)}</div><p class="plan-description">${esc(option.description)}</p>${callToAction}</article>`;
  }).join('');

  const body = `<header class="page-heading"><div><div class="eyebrow">${icon('billing')}Workspace settings</div><h1>Your subscription</h1><p>${opts.canSubscribe === true ? 'Choose or manage a recurring plan.' : 'Review the planned recurring tiers. They are not available to purchase yet.'}</p></div></header>
    ${notice}${previewNotice}
    <div class="stack">
      <section class="panel" aria-labelledby="billing-status-title"><div class="panel-head"><div><h2 id="billing-status-title">Current plan</h2><p class="panel-subtitle">Billing status for this workspace</p></div></div><div class="panel-body"><div class="billing-summary"><div><h2>${esc(billing.planName ?? 'Not subscribed yet')}</h2><p>${esc(state.label)}${renewal}</p></div><div class="billing-actions"><span class="status ${state.cls}"><span class="dot"></span>${esc(state.label)}</span>${manage}</div></div></div></section>
      <section class="panel" aria-labelledby="plans-title"><div class="panel-head"><div><h2 id="plans-title">${opts.canSubscribe === true ? (billing.active ? 'Change your plan' : 'Choose a plan') : 'Planned tiers'}</h2><p class="panel-subtitle">${opts.canSubscribe === true ? 'Billed monthly · cancel anytime' : 'Preview pricing · no checkout'}</p></div></div><div class="panel-body"><div class="plans">${plans}</div></div></section>
    </div>`;

  return appShell({ title: 'Relaunch72 — Billing', tenantName, active: 'billing', billingAvailable: true, crmAvailable: opts.crmAvailable, csrfToken: opts.csrfToken, body });
}

function pipelinePanel(data: DashboardData): string {
  const total = PIPELINE_STAGES.reduce((sum, stage) => sum + (data.pipeline[stage] ?? 0), 0);
  const stages = PIPELINE_STAGES.map((stage) => {
    const count = data.pipeline[stage] ?? 0;
    const share = total > 0 ? `${Math.round((count / total) * 100)}% of contacts` : 'No contacts';
    return `<div class="stage ${STAGE_CLASS[stage]}"><div class="c">${count}</div><div class="l">${esc(stage)}</div><div class="share">${share}</div></div>`;
  }).join('');
  return `<span id="pipeline" aria-hidden="true"></span><section class="panel" id="crm" aria-labelledby="pipeline-title"><div class="panel-head"><div class="panel-title-wrap"><h2 id="pipeline-title">Pipeline</h2><p class="panel-subtitle">Read-only contacts by current stage · ${total} total</p></div><span class="pill draft">CRM preview</span></div><div class="panel-body"><div class="pipeline" aria-label="Pipeline stages">${stages}</div></div></section>`;
}

function formatKeywordVolume(value: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return '—';
  return `~${new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 }).format(value)}`;
}

function contentPanel(data: DashboardData): string {
  const cards: string[] = [];
  if (data.artifacts.post) {
    cards.push(`<article class="draft-card"><div class="draft-meta"><span class="draft-label">${esc(data.artifacts.post.platform)} draft</span><span class="pill draft">Not scheduled</span></div><p class="hook">${esc(data.artifacts.post.hook)}</p><p>${esc(data.artifacts.post.body)}</p></article>`);
  }
  if (data.artifacts.cluster) {
    cards.push(`<article class="draft-card${data.artifacts.post ? '' : ' wide'}"><div class="draft-meta"><span class="draft-label">Content cluster</span><span class="pill draft">Not published</span></div><h4>${esc(data.artifacts.cluster.topic)}</h4><ul class="draft-list">${data.artifacts.cluster.articles.map((article) => `<li><span class="draft-role">${esc(article.role === 'pillar' ? 'Pillar' : article.intent)}</span><span>${esc(article.title)}</span></li>`).join('')}</ul></article>`);
  }
  if (data.artifacts.keywords) {
    cards.push(`<article class="draft-card"><div class="draft-meta"><span class="draft-label">Simulated keyword estimates</span><span class="pill paused">Mock data</span></div><p style="margin-bottom:9px">Planning estimates only · not live search volumes</p>${data.artifacts.keywords.map((keyword) => `<div class="keyword-row"><span>${esc(keyword.query)}</span><span class="volume">${esc(formatKeywordVolume(keyword.volume))}</span></div>`).join('')}</article>`);
  }
  if (data.artifacts.ad) {
    cards.push(`<article class="draft-card"><div class="draft-meta"><span class="draft-label">Simulated ad-set draft</span><span class="pill paused">Paused · not published</span></div><div class="ad-headlines">${data.artifacts.ad.headlines.map((headline) => `<span>${esc(headline)}</span>`).join('')}</div><p>${esc(data.artifacts.ad.primary)}</p></article>`);
  }
  const body = cards.length
    ? `<div class="content-grid">${cards.join('')}</div>`
    : `<div class="empty-state" role="status"><span class="empty-icon">${icon('content')}</span><strong>No drafts generated yet</strong><p>Use “Generate draft set” to prepare reviewable mock content. Nothing will be scheduled or published.</p></div>`;
  return `<section class="panel" id="content" aria-labelledby="content-title"><div class="panel-head"><div class="panel-title-wrap"><h2 id="content-title">Content workspace</h2><p class="panel-subtitle">Reviewable drafts only · publishing is not connected</p></div><span class="pill draft">Preview</span></div><div class="panel-body">${body}</div></section>`;
}

function contactsPanel(data: DashboardData): string {
  const rows = data.contacts.map((contact) => `<tr><td data-label="Contact"><span class="contact-name">${esc(contact.name)}</span></td><td data-label="Reach"><span class="contact-reach">${esc(contact.email ?? contact.phone ?? 'Not supplied')}</span></td><td data-label="Stage"><span class="stage-badge">${esc(contact.stage)}</span></td></tr>`).join('');
  const body = rows
    ? `<table class="data-table"><thead><tr><th>Contact</th><th>Reach</th><th>Stage</th></tr></thead><tbody>${rows}</tbody></table>`
    : `<div class="empty-state" role="status"><span class="empty-icon">${icon('contacts')}</span><strong>No contacts yet</strong><p>Your workspace is ready for the CRM foundation. Contact creation and import controls are not connected in this sandbox.</p></div>`;
  return `<section class="panel" id="contacts" aria-labelledby="contacts-title"><div class="panel-head"><div class="panel-title-wrap"><h2 id="contacts-title">Contacts</h2><p class="panel-subtitle">Read-only workspace snapshot · ${data.contacts.length} total</p></div><span class="pill draft">CRM preview</span></div><div class="panel-body">${body}</div></section>`;
}

function activityPanel(data: DashboardData): string {
  const feed = data.activity.slice(0, 14).map((activity) => `<div class="event"><span class="event-icon${activity.kind === 'rail_run' ? ' run' : ''}">${ACTIVITY_MARK[activity.kind] ?? '•'}</span><div><div class="event-summary">${esc(activity.summary)}</div><div class="event-time">${esc(activity.at.slice(0, 10))} · ${esc(activity.channel)}</div></div></div>`).join('');
  const body = feed || `<div class="empty-state" role="status"><span class="empty-icon">${icon('activity')}</span><strong>No recorded activity</strong><p>Workspace operations will appear here when they happen.</p></div>`;
  return `<section class="panel" aria-labelledby="activity-title"><div class="panel-head"><div class="panel-title-wrap"><h2 id="activity-title">Activity</h2><p class="panel-subtitle">Recorded operations · newest first</p></div>${icon('activity')}</div><div class="panel-body timeline">${body}</div></section>`;
}

function brandPanel(data: DashboardData): string {
  if (!data.brand) return `<section class="panel" aria-labelledby="brand-title"><div class="panel-head"><div><h2 id="brand-title">Brand brain</h2><p class="panel-subtitle">Strategy source</p></div>${icon('sparkles')}</div><div class="panel-body"><div class="empty-state" role="status"><strong>Not generated yet</strong><p>Your strategy will appear here after the first mock draft run.</p></div></div></section>`;
  const pillars = data.brand.pillars.map((pillar, index) => `<div class="pillar"><span class="pillar-index">${index + 1}</span><span>${esc(pillar)}</span></div>`).join('');
  return `<section class="panel" aria-labelledby="brand-title"><div class="panel-head"><div><h2 id="brand-title">Brand brain</h2><p class="panel-subtitle">Strategy used for every draft</p></div>${icon('sparkles')}</div><div class="panel-body">${data.brand.positioning ? `<p class="brand-quote">${esc(data.brand.positioning)}</p>` : ''}${pillars}</div></section>`;
}

function expansionModules(): string {
  return `<section class="module-preview" aria-labelledby="expansion-title"><div class="panel-head" style="padding-left:0;padding-right:0"><div><h2 id="expansion-title">Expansion modules</h2><p class="panel-subtitle">Designed into the platform boundary · not available in this sandbox</p></div></div><div class="module-preview-grid">${plannedPortalModules.map((module) => `<article class="module-card"><div class="module-card-top">${portalModuleIcon(module.id)}<span class="lock-label">${icon('lock')}Planned</span></div><h3>${esc(module.label)}</h3><p>${esc(module.description)}</p></article>`).join('')}</div></section>`;
}

export function dashboardPage(data: DashboardData, billing?: BillingView, opts: { crmAvailable?: boolean; csrfToken?: string } = {}): string {
  const won = data.pipeline.won ?? 0;
  const socialDraftSamples = data.artifacts.post ? 1 : 0;
  const articleBriefs = data.artifacts.cluster?.articles.length ?? 0;
  const adSetDrafts = data.artifacts.ad ? 1 : 0;

  const csrfField = opts.csrfToken ? `<input type="hidden" name="_csrf" value="${esc(opts.csrfToken)}">` : '';
  const body = `<header class="page-heading"><div><div class="eyebrow">${icon('overview')}Workspace overview</div><h1>Good to see you, ${esc(data.tenant.name)}.</h1><p>A focused view of your read-only contact and pipeline snapshot alongside reviewable mock drafts. Nothing shown here is presented as scheduled or published.</p></div><div class="page-heading-actions"><div><form method="post" action="/portal/run">${csrfField}<button class="button" type="submit" aria-describedby="run-mode-note">${icon('sparkles')}Generate draft set</button></form><div class="run-helper" id="run-mode-note">Mock generation · review only</div></div></div></header>
    <section class="metric-grid" id="analytics" aria-label="Workspace summary">
      <article class="metric"><div class="metric-head"><span class="metric-icon">${icon('contacts')}</span><span class="metric-context">CRM preview</span></div><div class="n">${data.contacts.length}</div><div class="l">contacts · ${won} won</div></article>
      <article class="metric"><div class="metric-head"><span class="metric-icon">${icon('content')}</span><span class="metric-context">Draft only</span></div><div class="n">${articleBriefs}</div><div class="l">article briefs drafted</div></article>
      <article class="metric"><div class="metric-head"><span class="metric-icon">${icon('social')}</span><span class="metric-context">Not scheduled</span></div><div class="n">${socialDraftSamples}</div><div class="l">social draft samples</div></article>
      <article class="metric"><div class="metric-head"><span class="metric-icon">${icon('activity')}</span><span class="metric-context">Not published</span></div><div class="n">${adSetDrafts}</div><div class="l">ad-set drafts (paused)</div></article>
    </section>
    <div class="dashboard-grid"><div class="stack">${pipelinePanel(data)}${contentPanel(data)}${contactsPanel(data)}</div><aside class="stack" aria-label="Workspace context">${billing ? billingCard(billing) : ''}${activityPanel(data)}${brandPanel(data)}</aside></div>
    ${expansionModules()}`;

  return appShell({ title: `Relaunch72 — ${data.tenant.name}`, tenantName: data.tenant.name, active: 'overview', billingAvailable: !!billing, crmAvailable: opts.crmAvailable, csrfToken: opts.csrfToken, body });
}
