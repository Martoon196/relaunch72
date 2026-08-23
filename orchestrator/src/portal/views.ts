/**
 * Server-rendered portal HTML — login + the client dashboard. Same brand as the
 * demo artifact (ink ground, amber accent), but driven by real data from the
 * store + run dir. Kept dependency-free: one <style>, minimal inline JS.
 */

import type { DashboardData } from './data.js';
import type { BillingView } from './billing.js';
import { PIPELINE_STAGES } from '../crm/types.js';

function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

const STYLE = `
  :root{--bg:#0d131d;--surface:#141d2a;--raised:#1b2532;--line:#26324a;--text:#d3dbe8;--muted:#8b98ac;--faint:#61708a;--amber:#f2ab45;--amber-soft:#f2ab4520;--won:#4bbd8e;--blue:#6e97d1;--mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace;--sans:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
  @media(prefers-color-scheme:light){:root{--bg:#eef1f6;--surface:#fff;--raised:#f5f8fc;--line:#dce3ed;--text:#1f2836;--muted:#5c6a7e;--faint:#8a97a9;--amber:#b8651a;--amber-soft:#b8651a14;--won:#2f9a6f;--blue:#4f7bc4}}
  *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:var(--sans);line-height:1.55;-webkit-font-smoothing:antialiased}
  a{color:inherit}h1,h2,h3{margin:0}.mono{font-family:var(--mono)}
  .logo{font-family:var(--mono);font-weight:700;letter-spacing:.1em;font-size:.85rem}.logo b{color:var(--amber)}
  .login{min-height:100vh;display:grid;place-items:center;padding:24px;background:radial-gradient(130% 90% at 50% -20%,var(--amber-soft),transparent 60%)}
  .card{background:var(--surface);border:1px solid var(--line);border-radius:16px;padding:26px}
  .lcard{width:100%;max-width:370px}.lcard h2{font-size:1.3rem;margin:18px 0 4px}.lcard p{color:var(--muted);font-size:.9rem;margin:0 0 18px}
  label{display:block;font-family:var(--mono);font-size:.68rem;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin:0 0 5px}
  input{width:100%;padding:11px 13px;border-radius:10px;border:1px solid var(--line);background:var(--raised);color:var(--text);font-size:.95rem;margin-bottom:12px}
  input:focus-visible{outline:2px solid var(--amber);outline-offset:1px}
  .btn{border:0;border-radius:10px;background:var(--amber);color:#141d2a;padding:11px 15px;font-weight:700;font-size:.92rem;cursor:pointer;font-family:var(--sans)}
  .err{color:#e0605a;font-size:.85rem;margin:0 0 12px}
  .wrap{max-width:1080px;margin:0 auto;padding:0 20px 70px}
  .top{display:flex;align-items:center;justify-content:space-between;padding:15px 0;border-bottom:1px solid var(--line);position:sticky;top:0;background:var(--bg);z-index:2;gap:12px;flex-wrap:wrap}
  .pill{font-family:var(--mono);font-size:.62rem;letter-spacing:.1em;color:var(--amber);border:1px solid var(--amber);border-radius:999px;padding:3px 9px;background:var(--amber-soft)}
  .hello{display:flex;justify-content:space-between;align-items:flex-start;gap:14px;margin:22px 0 18px;flex-wrap:wrap}
  .hello h1{font-size:1.4rem;letter-spacing:-.02em}.hello p{color:var(--muted);margin:5px 0 0;font-size:.92rem}
  .kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:22px}@media(max-width:620px){.kpis{grid-template-columns:repeat(2,1fr)}}
  .kpi{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:14px 15px}
  .kpi .n{font-family:var(--mono);font-size:1.5rem;font-weight:700;font-variant-numeric:tabular-nums}.kpi .l{font-size:.74rem;color:var(--muted);margin-top:2px}
  .grid{display:grid;grid-template-columns:1fr 320px;gap:18px;align-items:start}@media(max-width:880px){.grid{grid-template-columns:1fr}}
  .box{background:var(--surface);border:1px solid var(--line);border-radius:13px;padding:16px 18px;margin-bottom:18px}
  .box h3{font-size:.92rem;margin-bottom:3px}.box .s{color:var(--faint);font-size:.76rem;font-family:var(--mono);margin-bottom:12px}
  .pipe{display:grid;grid-template-columns:repeat(5,1fr);gap:7px}.st{border:1px solid var(--line);border-radius:9px;padding:10px 6px;text-align:center;background:var(--raised)}
  .st .c{font-family:var(--mono);font-size:1.3rem;font-weight:700}.st .l{font-size:.62rem;color:var(--muted);text-transform:capitalize}
  .row{display:flex;gap:9px;align-items:center;padding:8px 0;border-bottom:1px solid var(--line);font-size:.86rem}.row:last-child{border-bottom:0}
  .it{font-family:var(--mono);font-size:.56rem;text-transform:uppercase;border:1px solid var(--line);color:var(--muted);border-radius:5px;padding:2px 6px;width:60px;text-align:center;flex-shrink:0}
  table{width:100%;border-collapse:collapse;font-size:.86rem}th{text-align:left;font-family:var(--mono);font-size:.64rem;text-transform:uppercase;letter-spacing:.05em;color:var(--faint);padding:7px 5px;border-bottom:1px solid var(--line)}
  td{padding:10px 5px;border-bottom:1px solid var(--line)}tr:last-child td{border-bottom:0}
  .badge{font-family:var(--mono);font-size:.66rem;padding:3px 8px;border-radius:999px;background:var(--raised);text-transform:capitalize}
  .ev{display:grid;grid-template-columns:20px 1fr;gap:9px;padding:8px 0;border-bottom:1px solid var(--line)}.ev:last-child{border-bottom:0}
  .ev .i{width:20px;height:20px;border-radius:5px;background:var(--amber);color:#141d2a;display:grid;place-items:center;font-size:.65rem;margin-top:1px}
  .ev .i.sys{background:var(--faint);color:#fff}.ev .s{font-size:.83rem}.ev .t{font-size:.66rem;color:var(--faint);font-family:var(--mono)}
  .kw{display:grid;grid-template-columns:1fr auto;gap:10px;padding:7px 0;border-bottom:1px solid var(--line);font-size:.84rem}.kw:last-child{border-bottom:0}.kw .v{font-family:var(--mono);color:var(--amber);font-weight:650}
  .chips{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px}.chips span{font-size:.8rem;background:var(--raised);border:1px solid var(--line);border-radius:7px;padding:5px 10px}
  .runbtn{border:0;border-radius:10px;background:var(--amber);color:#141d2a;padding:10px 15px;font-weight:700;font-size:.88rem;cursor:pointer;font-family:var(--sans)}
  .quote{font-size:.84rem;color:var(--muted);border-left:2px solid var(--amber);padding-left:11px;font-style:italic}
  .stat{display:flex;align-items:center;gap:8px;font-family:var(--mono);font-size:.7rem;letter-spacing:.05em;text-transform:uppercase;padding:3px 9px;border-radius:999px;border:1px solid var(--line);background:var(--raised)}
  .stat .dot{width:7px;height:7px;border-radius:999px;background:var(--faint)}
  .stat.ok{color:var(--won);border-color:var(--won)}.stat.ok .dot{background:var(--won)}
  .stat.warn{color:var(--amber);border-color:var(--amber)}.stat.warn .dot{background:var(--amber)}
  .stat.off{color:var(--faint)}
  .plans{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin:6px 0 4px}@media(max-width:760px){.plans{grid-template-columns:1fr}}
  .plan{background:var(--surface);border:1px solid var(--line);border-radius:13px;padding:18px;display:flex;flex-direction:column}
  .plan.cur{border-color:var(--amber);box-shadow:0 0 0 1px var(--amber)}
  .plan h4{margin:0 0 2px;font-size:1rem}.plan .price{font-family:var(--mono);font-size:1.3rem;font-weight:700;color:var(--amber);margin:6px 0}
  .plan p{color:var(--muted);font-size:.85rem;margin:0 0 16px;flex:1}
  .plan .cur-tag{font-family:var(--mono);font-size:.6rem;letter-spacing:.08em;color:var(--amber);text-transform:uppercase}
  .note{font-size:.85rem;color:var(--muted);background:var(--amber-soft);border:1px solid var(--amber);border-radius:10px;padding:10px 13px;margin:0 0 18px}
`;

export function loginPage(error?: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Relaunch72 — Sign in</title><style>${STYLE}</style></head><body>
  <div class="login"><form class="card lcard" method="post" action="/portal/login">
    <div class="logo">🚀 <b>RELAUNCH72</b></div>
    <h2>Welcome back</h2><p>Sign in to your marketing dashboard.</p>
    ${error ? `<p class="err">${esc(error)}</p>` : ''}
    <label for="e">Email</label><input id="e" name="email" type="email" autocomplete="username" required>
    <label for="p">Password</label><input id="p" name="password" type="password" autocomplete="current-password" required>
    <button class="btn" type="submit" style="width:100%">Sign in →</button>
  </form></div></body></html>`;
}

const STAGE_ICON: Record<string, string> = { rail_run: '✦', stage_changed: '→', contact_created: '+', message_sent: '✉', note: '•' };

/** Map a billing status to a label + severity class for the status pill. */
function billingStat(b: BillingView): { cls: string; label: string } {
  if (b.active) return { cls: 'ok', label: b.status === 'trialing' ? 'Trialing' : 'Active' };
  if (b.status === 'past_due' || b.status === 'unpaid') return { cls: 'warn', label: 'Payment due' };
  if (b.status === 'canceled') return { cls: 'off', label: 'Canceled' };
  if (b.status === 'none') return { cls: 'off', label: 'No plan' };
  return { cls: 'off', label: b.status.replace(/_/g, ' ') };
}

/** Compact billing card for the dashboard aside. */
function billingCard(b: BillingView): string {
  const s = billingStat(b);
  const renew = b.active && b.currentPeriodEnd ? `<div class="t" style="margin-top:8px;font-family:var(--mono);font-size:.66rem;color:var(--faint)">renews ${esc(b.currentPeriodEnd.slice(0, 10))}</div>` : '';
  return `<div class="box"><h3>Your plan</h3><div class="s">subscription</div>
    <div style="display:flex;align-items:center;justify-content:space-between;gap:10px">
      <div style="font-weight:650;font-size:.92rem">${esc(b.planName ?? 'Not subscribed')}</div>
      <span class="stat ${s.cls}"><span class="dot"></span>${esc(s.label)}</span>
    </div>${renew}
    <a href="/portal/billing" style="display:inline-block;margin-top:12px;font-family:var(--mono);font-size:.72rem;color:var(--amber)">${b.active ? 'Manage plan' : 'See plans'} →</a>
  </div>`;
}

export function billingPage(tenantName: string, b: BillingView, opts: { canManage?: boolean; canSubscribe?: boolean; notice?: string } = {}): string {
  const s = billingStat(b);
  const previewNotice = opts.canSubscribe === true
    ? ''
    : '<div class="note">Plan preview only — recurring checkout is paused while the durable platform and connected delivery services are completed.</div>';
  const notice = `${opts.notice ? `<div class="note">${esc(opts.notice)}</div>` : ''}${previewNotice}`;
  const renew = b.active && b.currentPeriodEnd ? ` · renews ${esc(b.currentPeriodEnd.slice(0, 10))}` : '';
  const manage = opts.canManage && b.customerId
    ? `<form method="post" action="/portal/manage" style="margin:0"><button class="btn" style="background:var(--raised);color:var(--text);font-weight:550">Manage billing →</button></form>` : '';

  const plans = b.options.map((o) => {
    const current = b.active && b.planKey === o.key;
    const cta = current
      ? `<div class="cur-tag">✓ Your current plan</div>`
      : b.active
        ? '<div class="cur-tag">Use Manage billing</div>'
      : opts.canSubscribe === true
        ? `<form method="post" action="/portal/subscribe" style="margin:0"><input type="hidden" name="plan" value="${esc(o.key)}"><button class="btn" style="width:100%" type="submit">${b.active ? 'Switch to this' : 'Subscribe'} →</button></form>`
        : '<div class="cur-tag">Checkout paused</div>';
    return `<div class="plan${current ? ' cur' : ''}"><h4>${esc(o.name)}</h4><div class="price">${esc(o.priceLabel)}</div><p>${esc(o.description)}</p>${cta}</div>`;
  }).join('');

  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Relaunch72 — Billing</title><style>${STYLE}</style></head><body>
  <div class="wrap">
    <div class="top"><div style="display:flex;align-items:center;gap:12px"><div class="logo">🚀 <b>RELAUNCH72</b></div><span class="pill">BILLING</span></div>
      <a href="/portal" style="font-family:var(--mono);font-size:.75rem;color:var(--amber)">← dashboard</a></div>

    <div class="hello"><div><h1>Your subscription</h1><p>${opts.canSubscribe === true ? 'Choose or manage a recurring plan.' : 'Review the planned recurring tiers. They are not available to purchase yet.'}</p></div></div>
    ${notice}
    <div class="box"><h3>Current plan</h3><div class="s">status</div>
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap">
        <div><div style="font-weight:700;font-size:1.05rem">${esc(b.planName ?? 'Not subscribed yet')}</div>
          <div style="color:var(--muted);font-size:.86rem;margin-top:2px">${esc(s.label)}${renew}</div></div>
        <div style="display:flex;align-items:center;gap:10px"><span class="stat ${s.cls}"><span class="dot"></span>${esc(s.label)}</span>${manage}</div>
      </div>
    </div>

    <div class="box"><h3>${opts.canSubscribe === true ? (b.active ? 'Change your plan' : 'Choose a plan') : 'Planned tiers'}</h3><div class="s">${opts.canSubscribe === true ? 'billed monthly · cancel anytime' : 'preview pricing · no checkout'}</div>
      <div class="plans">${plans}</div>
    </div>
  </div></body></html>`;
}

export function dashboardPage(d: DashboardData, billing?: BillingView): string {
  const won = d.pipeline.won ?? 0;
  const socialDraftSamples = d.artifacts.post ? 1 : 0;
  const articleBriefs = d.artifacts.cluster?.articles.length ?? 0;
  const adSetDrafts = d.artifacts.ad ? 1 : 0;

  const pipe = PIPELINE_STAGES.map((st) => `<div class="st"><div class="c">${d.pipeline[st] ?? 0}</div><div class="l">${st}</div></div>`).join('');
  const contacts = d.contacts.map((c) => `<tr><td>${esc(c.name)}</td><td class="mono" style="color:var(--muted)">${esc(c.email ?? c.phone ?? '—')}</td><td><span class="badge">${esc(c.stage)}</span></td></tr>`).join('') || '<tr><td colspan="3" style="color:var(--muted)">No contacts yet.</td></tr>';
  const feed = d.activity.slice(0, 14).map((a) => `<div class="ev"><div class="i ${a.kind === 'rail_run' ? '' : 'sys'}">${STAGE_ICON[a.kind] ?? '•'}</div><div><div class="s">${esc(a.summary)}</div><div class="t">${esc(a.at.slice(0, 10))}</div></div></div>`).join('') || '<p style="color:var(--muted);font-size:.85rem">No activity yet — generate this week’s drafts when the brand brain is ready.</p>';

  const cluster = d.artifacts.cluster ? `<div class="box"><h3>This week's content-cluster draft</h3><div class="s">article briefs · topic · ${esc(d.artifacts.cluster.topic)} · not published</div>${d.artifacts.cluster.articles.map((a) => `<div class="row"><span class="it">${esc(a.role === 'pillar' ? 'pillar' : a.intent)}</span><span>${esc(a.title)}</span></div>`).join('')}</div>` : '';
  const keywords = d.artifacts.keywords ? `<div class="box"><h3>Simulated keyword estimates</h3><div class="s">mock planning data · not live search volumes</div>${d.artifacts.keywords.map((k) => `<div class="kw"><span>${esc(k.query)}</span><span class="v">~${k.volume?.toLocaleString('en-GB') ?? '—'}</span></div>`).join('')}</div>` : '';
  const ad = d.artifacts.ad ? `<div class="box"><h3>Simulated ad-set draft · paused</h3><div class="s">planning preview · not published</div><div class="chips">${d.artifacts.ad.headlines.map((h) => `<span>${esc(h)}</span>`).join('')}</div><p style="color:var(--muted);font-size:.86rem;margin:0 0 8px">${esc(d.artifacts.ad.primary)}</p></div>` : '';

  const brand = d.brand ? `<div class="box"><h3>Your brand brain</h3><div class="s">the strategy every task is built from</div>${d.brand.positioning ? `<p class="quote">${esc(d.brand.positioning)}</p>` : ''}${d.brand.pillars.length ? `<div style="margin:12px 0 6px;font-family:var(--mono);font-size:.64rem;letter-spacing:.06em;color:var(--faint);text-transform:uppercase">Message pillars</div>${d.brand.pillars.map((p, i) => `<div class="row" style="border:0;padding:5px 0"><span class="mono" style="color:var(--amber)">${i + 1}</span><span>${esc(p)}</span></div>`).join('')}` : ''}</div>` : '';

  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Relaunch72 — ${esc(d.tenant.name)}</title><style>${STYLE}</style></head><body>
  <div class="wrap">
    <div class="top"><div style="display:flex;align-items:center;gap:12px"><div class="logo">🚀 <b>RELAUNCH72</b></div><span class="pill">MOCK · £0</span></div>
      <div style="display:flex;align-items:center;gap:10px"><div style="text-align:right;font-weight:650;font-size:.9rem">${esc(d.tenant.name)}</div>
      <form method="post" action="/portal/logout" style="margin:0"><button class="btn" style="background:var(--raised);color:var(--text);font-weight:550;padding:7px 12px">Sign out</button></form></div></div>

    <div class="hello"><div><h1>Hi, ${esc(d.tenant.name)}.</h1><p>Your AI marketing manager prepares on-brand drafts for review — nothing here is presented as published.</p></div>
      <form method="post" action="/portal/run" style="margin:0"><button class="runbtn" type="submit">▶ Generate this week's drafts</button></form></div>

    <div class="kpis">
      <div class="kpi"><div class="n">${d.contacts.length}</div><div class="l">contacts · ${won} won</div></div>
      <div class="kpi"><div class="n">${articleBriefs}</div><div class="l">article briefs drafted</div></div>
      <div class="kpi"><div class="n">${socialDraftSamples}</div><div class="l">social draft samples</div></div>
      <div class="kpi"><div class="n">${adSetDrafts}</div><div class="l">ad-set drafts (paused)</div></div>
    </div>

    <div class="grid">
      <main>
        <div class="box"><h3>Your pipeline</h3><div class="s">contacts by stage</div><div class="pipe">${pipe}</div></div>
        ${cluster}${keywords}${ad}
        <div class="box"><h3>Contacts</h3><div class="s">stored in this workspace</div><table><thead><tr><th>Name</th><th>Reach</th><th>Stage</th></tr></thead><tbody>${contacts}</tbody></table></div>
      </main>
      <aside>
        ${billing ? billingCard(billing) : ''}
        <div class="box"><h3>Activity</h3><div class="s">recorded operations · newest first</div>${feed}</div>
        ${brand}
      </aside>
    </div>
  </div></body></html>`;
}
