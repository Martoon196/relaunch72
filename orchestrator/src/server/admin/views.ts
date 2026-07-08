/**
 * Server-rendered admin HTML. Deliberately dependency-free and self-contained —
 * one dark, functional control-room look. All dynamic text is HTML-escaped.
 */

import type { RunSummary, RunDetail, Order } from './store.js';

export function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

const CSS = `
  :root{--bg:#0b0e14;--panel:#141924;--line:#252c3a;--ink:#e7ebf3;--muted:#95a0b5;--faint:#6b7688;--electric:#6d86ff;--good:#3fce8f;--warn:#e0a648;--bad:#ff6b6b;--mono:ui-monospace,"SF Mono",Menlo,monospace;--sans:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
  *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--sans);line-height:1.5}
  a{color:var(--electric);text-decoration:none}a:hover{text-decoration:underline}
  .wrap{max-width:960px;margin:0 auto;padding:24px}
  header.bar{border-bottom:1px solid var(--line);background:#0d111a}
  header.bar .wrap{display:flex;align-items:center;justify-content:space-between;padding:14px 24px}
  .mark{font-weight:800;letter-spacing:-.02em}.mark b{color:var(--electric)} .mark small{color:var(--faint);font-weight:600;font-family:var(--mono);font-size:11px;margin-left:8px}
  h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:22px 0 10px}
  .muted{color:var(--muted)}.mono{font-family:var(--mono)}
  table{width:100%;border-collapse:collapse;font-size:14px}
  th,td{text-align:left;padding:10px 12px;border-bottom:1px solid var(--line);vertical-align:top}
  th{color:var(--faint);font-family:var(--mono);font-size:11px;text-transform:uppercase;letter-spacing:.06em;font-weight:600}
  tr:hover td{background:#10151f}
  .pill{display:inline-block;font-family:var(--mono);font-size:11px;font-weight:600;padding:2px 8px;border-radius:999px;text-transform:uppercase;letter-spacing:.04em}
  .p-parked{background:#2a2110;color:var(--warn)} .p-approved,.p-passed{background:#10281d;color:var(--good)}
  .p-assembled,.p-awaiting_signoff{background:#141b2a;color:var(--electric)} .p-sent_back,.p-failed{background:#2a1414;color:var(--bad)}
  .p-default{background:#1a212b;color:var(--muted)}
  .panel{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:18px;margin:14px 0}
  .btn{display:inline-block;font:inherit;font-weight:650;border:none;border-radius:9px;padding:11px 18px;cursor:pointer;background:var(--electric);color:#07101f}
  .btn.ghost{background:transparent;border:1px solid var(--line);color:var(--ink)} .btn.danger{background:#3a1a1a;color:#ffb4b4}
  .btn:hover{filter:brightness(1.08)}
  input,textarea{width:100%;background:#0c1017;border:1px solid var(--line);color:var(--ink);border-radius:9px;padding:11px 13px;font:inherit}
  input:focus,textarea:focus{outline:none;border-color:var(--electric)}
  .row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
  .kv{display:grid;grid-template-columns:150px 1fr;gap:6px 14px;font-size:14px}.kv b{color:var(--muted);font-weight:600}
  .doc h3{color:var(--electric);font-size:13px;font-family:var(--mono);text-transform:uppercase;letter-spacing:.05em;margin:18px 0 6px}
  .doc p{margin:4px 0}.doc ul{margin:4px 0 4px 18px}.doc .q{border-left:3px solid var(--electric);padding-left:10px;color:var(--muted)}
  .err{background:#2a1414;border:1px solid #52302f;color:#ffb4b4;padding:10px 12px;border-radius:9px;margin-bottom:12px;font-size:14px}
  .empty{color:var(--faint);padding:30px;text-align:center}
  code{font-family:var(--mono);font-size:12.5px;background:#0c1017;padding:1px 5px;border-radius:5px}
  .foot{color:var(--faint);font-size:12px;margin-top:30px;border-top:1px solid var(--line);padding-top:14px}
`;

function pill(status: string): string {
  const cls = ['parked', 'approved', 'passed', 'assembled', 'awaiting_signoff', 'sent_back', 'failed'].includes(status) ? `p-${status}` : 'p-default';
  return `<span class="pill ${cls}">${esc(status)}</span>`;
}

function layout(title: string, body: string, opts: { authed: boolean } = { authed: true }): string {
  const nav = opts.authed
    ? `<div class="row"><a href="/admin">Runs</a> · <form method="post" action="/admin/logout" style="display:inline"><button class="btn ghost" style="padding:5px 12px">Log out</button></form></div>`
    : '';
  return `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>${esc(title)} · Relaunch72 admin</title><style>${CSS}</style></head><body>
<header class="bar"><div class="wrap"><a class="mark" href="/admin">Relaunch<b>72</b><small>admin</small></a>${nav}</div></header>
<main class="wrap">${body}</main></body></html>`;
}

export function loginPage(error?: string): string {
  return layout('Sign in', `
    <div class="panel" style="max-width:380px;margin:60px auto">
      <h1>Admin</h1><p class="muted" style="margin-top:0">Your control room. Password required.</p>
      ${error ? `<div class="err">${esc(error)}</div>` : ''}
      <form method="post" action="/admin/login">
        <input type="password" name="password" placeholder="Admin password" autofocus autocomplete="current-password"/>
        <div style="margin-top:12px"><button class="btn" type="submit">Sign in</button></div>
      </form>
    </div>`, { authed: false });
}

function money(n: number): string { return `$${(n || 0).toFixed(2)}`; }
function when(iso: string): string { return iso ? esc(iso.replace('T', ' ').replace(/\..*/, '') + ' UTC') : '—'; }

export function dashboardPage(runs: RunSummary[], orders: Order[]): string {
  const runRows = runs.length ? runs.map((r) => `
    <tr>
      <td><a href="/admin/run/${esc(r.id)}"><b>${esc(r.business)}</b></a><div class="muted mono" style="font-size:11px">${esc(r.id.slice(0, 40))}…</div></td>
      <td>${pill(r.status)}${r.parkedStage ? `<div class="muted" style="font-size:12px;margin-top:4px">at ${esc(r.parkedStage)}</div>` : ''}</td>
      <td class="mono">${esc(r.through || '—')}</td>
      <td class="mono">${money(r.costUsd)}</td>
      <td class="mono" style="font-size:12px">${when(r.createdAt)}</td>
    </tr>`).join('') : `<tr><td colspan="5" class="empty">No runs yet. When a paid intake kicks a build, it lands here.</td></tr>`;

  const orderRows = orders.slice(0, 25).map((o) => `
    <tr><td class="mono">${esc(o.tier)}${o.bump ? ' +bump' : ''}</td><td>${esc(o.email || '—')}</td>
    <td class="mono">${o.amount_total != null ? '$' + (o.amount_total / 100).toFixed(2) : '—'}</td>
    <td>${pill(o.status)}</td><td class="mono" style="font-size:12px">${when(o.paid_at || '')}</td></tr>`).join('');

  return layout('Runs', `
    <h1>Control room</h1>
    <p class="muted">Every build and order. Click a run to review the pack and sign it off.</p>
    <h2>Builds</h2>
    <div class="panel" style="padding:0"><table><thead><tr><th>Business</th><th>Status</th><th>Through</th><th>Cost</th><th>Started</th></tr></thead><tbody>${runRows}</tbody></table></div>
    <h2>Orders</h2>
    <div class="panel" style="padding:0"><table><thead><tr><th>Tier</th><th>Email</th><th>Paid</th><th>Status</th><th>When</th></tr></thead><tbody>${orderRows || `<tr><td colspan="5" class="empty">No orders recorded yet.</td></tr>`}</tbody></table></div>
    <div class="foot">Test mode. Customer data — keep this password private.</div>`);
}

/** Generic, readable render of a deliverable's JSON — headings for keys, quotes styled. */
export function renderDeliverable(obj: unknown): string {
  const val = (v: unknown): string => {
    if (v == null) return '';
    if (typeof v === 'string') return `<p${/^["“]/.test(v.trim()) ? ' class="q"' : ''}>${esc(v)}</p>`;
    if (typeof v === 'number' || typeof v === 'boolean') return `<p>${esc(v)}</p>`;
    if (Array.isArray(v)) {
      if (v.every((x) => typeof x === 'string' || typeof x === 'number')) return `<ul>${v.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`;
      return v.map((x) => `<div class="panel" style="margin:8px 0;padding:12px">${block(x as Record<string, unknown>)}</div>`).join('');
    }
    if (typeof v === 'object') return block(v as Record<string, unknown>);
    return '';
  };
  const label = (k: string): string => k.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  const block = (o: Record<string, unknown>): string =>
    Object.entries(o).filter(([k]) => !k.startsWith('_')).map(([k, v]) => `<h3>${esc(label(k))}</h3>${val(v)}`).join('');
  return `<div class="doc">${typeof obj === 'object' && obj ? block(obj as Record<string, unknown>) : '<p class="muted">Empty.</p>'}</div>`;
}

export function runDetailPage(d: RunDetail, view: { stage: string; html: string } | null): string {
  const s = d.summary;
  const parked = d.stages.find((x) => x.status === 'parked');
  const stageRows = d.stages.map((x) => `
    <tr><td class="mono"><b>${esc(x.stage)}</b></td><td>${pill(x.status)}</td><td class="mono">${esc(x.model || '—')}</td><td class="mono">${money(x.costUsd)}</td>
    <td>${x.hasOutput ? `<a href="/admin/run/${esc(d.id)}?view=${esc(x.stage)}">view →</a>` : (x.issues.length ? `<span class="muted" style="font-size:12px">${esc(x.issues[0])}</span>` : '<span class="muted">—</span>')}</td></tr>`).join('');

  const signoffPanel = s.signoff
    ? `<div class="panel"><h2 style="margin-top:0">Sign-off</h2><p>${pill(s.signoff.decision)} by <b>${esc(s.signoff.by)}</b> · ${when(s.signoff.at)}</p>${s.signoff.note ? `<p class="muted">"${esc(s.signoff.note)}"</p>` : ''}</div>`
    : s.hasBundle
      ? `<div class="panel"><h2 style="margin-top:0">Sign-off</h2><p class="muted">Read the pack, then decide. Approving unlocks delivery.</p>
         <form method="post" action="/admin/run/${esc(d.id)}/signoff" class="row" style="align-items:flex-start">
           <input type="hidden" name="decision" value="approved"/>
           <button class="btn" name="decision" value="approved" type="submit">Approve ✓</button>
         </form>
         <form method="post" action="/admin/run/${esc(d.id)}/signoff" style="margin-top:12px">
           <textarea name="notes" rows="2" placeholder="What to fix (required to send back)…"></textarea>
           <div style="margin-top:8px"><button class="btn danger" name="decision" value="sent_back" type="submit">Send back</button></div>
         </form></div>`
      : `<div class="panel"><h2 style="margin-top:0">Parked — needs attention</h2>
         <p>${parked ? `Stopped at <b>${esc(parked.stage)}</b>: <span class="muted">${esc(parked.issues[0] || s.parkReason)}</span>` : `This run hasn't assembled a pack yet (status: ${esc(s.status)}).`}</p>
         <p class="muted">Fix the prompt/gate, then it'll clear on the next build. Sign-off unlocks once a full pack assembles.</p></div>`;

  const viewer = view ? `<div class="panel"><h2 style="margin-top:0">${esc(view.stage)} — deliverable</h2>${view.html}</div>` : '';

  return layout(s.business, `
    <p><a href="/admin">← all runs</a></p>
    <h1>${esc(s.business)}</h1>
    <div class="row" style="margin-bottom:10px">${pill(s.status)} <span class="muted mono" style="font-size:12px">${esc(s.id)}</span></div>
    <div class="panel"><div class="kv">
      <b>Mode</b><span>${esc(s.mode)}</span><b>Through</b><span class="mono">${esc(s.through || '—')}</span>
      <b>Cost</b><span class="mono">${money(s.costUsd)}</span><b>Started</b><span>${when(s.createdAt)}</span>
      <b>Finished</b><span>${when(s.finishedAt)}</span>${s.signoff ? `<b>Email</b><span>${esc(d.intakeEmail || '—')}</span>` : ''}
    </div></div>
    ${signoffPanel}
    <h2>Stages</h2>
    <div class="panel" style="padding:0"><table><thead><tr><th>Stage</th><th>Status</th><th>Model</th><th>Cost</th><th>Output</th></tr></thead><tbody>${stageRows}</tbody></table></div>
    ${viewer}
    <div class="foot">Customer data — private.</div>`);
}
