import type {
  PortalCompanyContentSyncSnapshot,
} from './company-content-sync-service.js';
import {
  COMPANY_CONTENT_SYNC_ROUTE,
  type CompanyContentSyncNoticeView,
} from './company-content-sync-actions.js';
import { renderContentWorkspaceNavigation } from './content-workspace-navigation.js';
import { escapeHtml } from './ui.js';

export interface RenderCompanyContentSyncOptions {
  readonly csrfToken: string;
  readonly commandToken: string;
  readonly notice?: CompanyContentSyncNoticeView;
  readonly companyAssetsAvailable?: boolean;
  readonly assetsLabel?: string;
  readonly brandBrainAvailable?: boolean;
  readonly brainLabel?: string;
}

const STYLE = `
  .ppsync{--s-bg:#07090b;--s-panel:#0d1114;--s-raised:#12181c;--s-line:#29343b;--s-ink:#f2f7f6;--s-muted:#9faeb2;--s-faint:#76878c;--s-teal:#00e5cc;--s-green:#74d9a5;--s-amber:#f2b84b;--s-red:#ff746c;color:var(--s-ink);background:var(--s-bg);border:1px solid #020304;overflow:hidden}.ppsync *{box-sizing:border-box}.ppsync h1,.ppsync h2,.ppsync p{margin-top:0}.ppsync-hero{display:grid;grid-template-columns:minmax(0,1fr) minmax(250px,330px);gap:24px;align-items:end;padding:29px 30px 25px;border-bottom:1px solid var(--s-line);background:radial-gradient(circle at 87% 8%,rgba(0,229,204,.13),transparent 31%),linear-gradient(135deg,#12181b,#080a0c 70%)}.ppsync-kicker{color:var(--s-teal);font:850 12px var(--mono,monospace);letter-spacing:.13em;text-transform:uppercase}.ppsync h1{margin:9px 0;font-family:var(--display,var(--sans));font-size:clamp(2.1rem,4.3vw,4.25rem);font-weight:600;line-height:.94;letter-spacing:-.04em}.ppsync h1 em{color:var(--s-teal);font-style:normal}.ppsync-hero p{max-width:760px;margin:0;color:var(--s-muted);font-size:14px;line-height:1.65}.ppsync-command{border:1px solid #34515a;background:rgba(4,8,9,.75);padding:15px}.ppsync-command strong{display:block;font-size:14px}.ppsync-command p{margin:5px 0 12px;color:var(--s-muted);font-size:12px;line-height:1.5}.ppsync-command button{width:100%;min-height:46px;border:1px solid var(--s-teal);border-radius:7px;background:var(--s-teal);color:#03110f;font:900 12px var(--mono,monospace);letter-spacing:.04em;text-transform:uppercase;cursor:pointer}.ppsync-command button:disabled{border-color:var(--s-line);background:var(--s-raised);color:var(--s-faint);cursor:not-allowed}.ppsync-truth{display:flex;justify-content:space-between;gap:16px;padding:12px 30px;border-bottom:1px solid var(--s-line);background:#0a0e10;color:var(--s-muted);font-size:12px;line-height:1.55}.ppsync-truth strong{color:var(--s-ink)}.ppsync-truth code{color:var(--s-teal);white-space:nowrap}.ppsync-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));border-bottom:1px solid var(--s-line)}.ppsync-metric{padding:17px 18px;border-right:1px solid var(--s-line);background:var(--s-panel)}.ppsync-metric:last-child{border-right:0}.ppsync-metric span{display:block;color:var(--s-faint);font:800 11px var(--mono,monospace);letter-spacing:.07em;text-transform:uppercase}.ppsync-metric strong{display:block;margin:8px 0 4px;font:900 23px var(--mono,monospace)}.ppsync-metric small{color:var(--s-muted);font-size:11px;line-height:1.4}.ppsync-body{display:grid;grid-template-columns:minmax(0,1fr) minmax(300px,380px);gap:14px;padding:16px}.ppsync-panel{min-width:0;border:1px solid var(--s-line);background:var(--s-panel)}.ppsync-panel header{padding:16px 18px;border-bottom:1px solid var(--s-line)}.ppsync-panel h2{margin:0;font-size:16px}.ppsync-panel header p{margin:5px 0 0;color:var(--s-muted);font-size:12px;line-height:1.45}.ppsync-status{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:16px 18px;border-bottom:1px solid var(--s-line)}.ppsync-state{display:inline-flex;align-items:center;gap:7px;border:1px solid var(--s-line);padding:6px 9px;font:850 11px var(--mono,monospace);letter-spacing:.05em;text-transform:uppercase}.ppsync-state::before{content:"";width:8px;height:8px;border-radius:50%;background:var(--s-faint)}.ppsync-state.current{color:var(--s-green);border-color:#315c47}.ppsync-state.current::before{background:var(--s-green)}.ppsync-state.attention,.ppsync-state.retry_wait{color:var(--s-amber);border-color:#6d5a31}.ppsync-state.attention::before,.ppsync-state.retry_wait::before{background:var(--s-amber)}.ppsync-times{display:grid;gap:0}.ppsync-row{display:grid;grid-template-columns:145px minmax(0,1fr);gap:10px;padding:10px 18px;border-bottom:1px solid var(--s-line);font-size:12px}.ppsync-row:last-child{border-bottom:0}.ppsync-row span{color:var(--s-faint)}.ppsync-row code,.ppsync-row time{color:var(--s-ink);overflow-wrap:anywhere}.ppsync-blockers{list-style:none;margin:0;padding:9px}.ppsync-blocker{border:1px solid var(--s-line);border-left:3px solid var(--s-amber);background:var(--s-raised);padding:12px;margin-bottom:8px}.ppsync-blocker:last-child{margin-bottom:0}.ppsync-blocker[data-retryable="false"]{border-left-color:var(--s-red)}.ppsync-blocker strong{display:block;font:850 11px var(--mono,monospace);text-transform:uppercase}.ppsync-blocker p{margin:6px 0 0;color:var(--s-muted);font-size:12px;line-height:1.5}.ppsync-blocker code{display:block;margin-top:7px;color:var(--s-faint);font-size:11px;overflow-wrap:anywhere}.ppsync-clear{padding:22px;text-align:center;color:var(--s-muted);font-size:12px}.ppsync-clear strong{display:block;margin-bottom:5px;color:var(--s-green);font-size:14px}.ppsync-proof{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;padding:11px}.ppsync-proof div{border:1px solid var(--s-line);background:#090c0e;padding:10px}.ppsync-proof span{display:block;color:var(--s-faint);font:800 10px var(--mono,monospace);text-transform:uppercase}.ppsync-proof strong{display:block;margin-top:5px;color:var(--s-ink);font-size:12px;line-height:1.35}.ppsync-footer{display:flex;justify-content:space-between;gap:14px;padding:13px 18px;border-top:1px solid var(--s-line);color:var(--s-faint);font-size:11px}.ppsync-notice{padding:12px 30px;border-bottom:1px solid currentColor;background:#0b1b15;color:var(--s-green);font-size:12px}.ppsync-notice[data-kind="info"]{background:#211b0d;color:var(--s-amber)}.ppsync-notice[data-kind="error"]{background:#24100f;color:var(--s-red)}.ppsync-notice strong{display:block;margin-bottom:3px}.ppsync-notice span{color:var(--s-ink);font-weight:500}
  @media(max-width:900px){.ppsync-hero{grid-template-columns:1fr}.ppsync-grid{grid-template-columns:repeat(2,1fr)}.ppsync-metric:nth-child(2){border-right:0}.ppsync-metric:nth-child(n+3){border-top:1px solid var(--s-line)}.ppsync-body{grid-template-columns:1fr}}
  @media(max-width:560px){.ppsync-hero{padding:23px 19px 20px}.ppsync-truth,.ppsync-footer{flex-direction:column;padding-inline:19px}.ppsync-grid{grid-template-columns:1fr}.ppsync-metric{border-right:0}.ppsync-metric:nth-child(n+2){border-top:1px solid var(--s-line)}.ppsync-body{padding:9px}.ppsync-status{align-items:flex-start;flex-direction:column}.ppsync-row{grid-template-columns:1fr}.ppsync-proof{grid-template-columns:1fr}.ppsync-notice{padding-inline:19px}}
  @media(forced-colors:active){.ppsync,.ppsync-panel,.ppsync-state,.ppsync-command button{forced-color-adjust:auto}.ppsync-state::before{border:1px solid CanvasText}}
  @media(prefers-reduced-motion:reduce){.ppsync *{transition:none!important}}
`;

function count(value: number): string {
  return Number.isSafeInteger(value) && value >= 0 ? value.toLocaleString('en-GB') : '0';
}

function time(value: string | null, fallback: string): string {
  if (!value) return escapeHtml(fallback);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return escapeHtml(fallback);
  const label = new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC',
  }).format(parsed);
  return `<time datetime="${escapeHtml(parsed.toISOString())}">${escapeHtml(label)} UTC</time>`;
}

function digest(value: string | null): string {
  return value ? `<code>${escapeHtml(value.slice(0, 12))}…</code>` : '<span>Not checked</span>';
}

function blockers(snapshot: PortalCompanyContentSyncSnapshot): string {
  if (snapshot.sync.blockers.length === 0) {
    return '<div class="ppsync-clear"><strong>No sync blockers</strong>The approved company source, exact resources and local immutable projection agree.</div>';
  }
  return `<ol class="ppsync-blockers">${snapshot.sync.blockers.map((entry) => (
    `<li class="ppsync-blocker" data-retryable="${entry.retryable}"><strong>${escapeHtml(entry.code.replaceAll('_', ' '))}</strong><p>${escapeHtml(entry.message)}</p>${entry.itemRef ? `<code>${escapeHtml(entry.itemRef)}</code>` : ''}</li>`
  )).join('')}</ol>`;
}

export function renderCompanyContentSyncBody(
  snapshot: PortalCompanyContentSyncSnapshot,
  options: RenderCompanyContentSyncOptions,
): string {
  const sync = snapshot.sync;
  const commandEnabled = sync.canRetry && options.commandToken.length >= 32;
  const navigation = renderContentWorkspaceNavigation('sync', {
    companyContentSyncAvailable: true,
    companyAssetsAvailable: options.companyAssetsAvailable === true,
    assetsLabel: options.assetsLabel,
    brandBrainAvailable: options.brandBrainAvailable === true,
    brainLabel: options.brainLabel,
  });
  return `${navigation}<style data-property-predator-company-content-sync>${STYLE}</style><article class="ppsync" aria-labelledby="ppsync-title" data-provider-effects="none" data-customer-data="none" data-artwork-copy="none">
    <header class="ppsync-hero"><div><div class="ppsync-kicker">Property Predator · owned source sync</div><h1 id="ppsync-title">Bring the machine in. <em>Keep the proof.</em></h1><p>Pull only approved company-owned catalogue metadata, Brand Brain evidence and exact canonical content into Growth HQ. Every source byte is hash-checked; artwork stays source-authoritative and customer or affiliate-private data is rejected by contract.</p></div><form class="ppsync-command" method="post" action="${COMPANY_CONTENT_SYNC_ROUTE}"><input type="hidden" name="_csrf" value="${escapeHtml(options.csrfToken)}"><input type="hidden" name="command_token" value="${escapeHtml(options.commandToken)}"><strong>Effects-off operator sync</strong><p>This reads the scoped Property Predator source and writes only through the dedicated content-adapter database identity.</p><button type="submit"${!commandEnabled ? ' disabled' : ''}>${sync.state === 'not_run' ? 'Run owned-content sync' : sync.canRetry ? 'Sync and verify again' : 'Retry window active'}</button></form></header>
    ${options.notice ? `<div class="ppsync-notice" data-kind="${escapeHtml(options.notice.kind)}" role="status"><strong>${escapeHtml(options.notice.title)}</strong><span>${escapeHtml(options.notice.message)}</span></div>` : ''}
    <section class="ppsync-truth" aria-label="Effects-off boundary"><span><strong>No providers, publishing or generation.</strong> Exact content JSON may be stored; artwork bytes are verified in memory and never copied.</span><code>providerEffects=false</code></section>
    <section class="ppsync-grid" aria-label="Sync counts"><div class="ppsync-metric"><span>Source items</span><strong>${count(sync.counts.sourceItems)}</strong><small>Approved company-owned records</small></div><div class="ppsync-metric"><span>Imported versions</span><strong>${count(sync.counts.importedVersions)}</strong><small>Immutable canonical bytes stored</small></div><div class="ppsync-metric"><span>Proofs refreshed</span><strong>${count(sync.counts.refreshedAttestations)}</strong><small>Exact existing tuples re-attested</small></div><div class="ppsync-metric"><span>Blocked / quarantined</span><strong>${count(sync.counts.blockedItems + sync.counts.quarantinedItems + sync.counts.reviewIncompleteItems)}</strong><small>Skipped, with reasons below</small></div></section>
    <div class="ppsync-body"><section class="ppsync-panel" aria-labelledby="ppsync-evidence"><header><h2 id="ppsync-evidence">Freshness and immutable evidence</h2><p>What was checked, when the proof expires, and which source hashes Growth HQ accepted.</p></header><div class="ppsync-status"><span class="ppsync-state ${escapeHtml(sync.state)}">${escapeHtml(sync.state.replaceAll('_', ' '))}</span><span>${sync.sourceFresh ? 'Source proof is fresh' : 'Source proof is not fresh'}</span></div><div class="ppsync-times"><div class="ppsync-row"><span>Last attempt</span>${time(sync.lastAttemptAt, 'Not run')}</div><div class="ppsync-row"><span>Last safe completion</span>${time(sync.lastSuccessAt, 'No safe completion')}</div><div class="ppsync-row"><span>Source checked</span>${time(sync.sourceCheckedAt, 'Not checked')}</div><div class="ppsync-row"><span>Proof expires</span>${time(sync.sourceExpiresAt, 'No active proof')}</div><div class="ppsync-row"><span>Next automatic retry</span>${time(sync.nextRetryAt, 'No retry delay')}</div></div><div class="ppsync-proof"><div><span>Catalogue SHA</span><strong>${digest(sync.sourceCatalogSha256)}</strong></div><div><span>Release SHA</span><strong>${digest(sync.sourceReleaseSha256)}</strong></div><div><span>Brand Brain SHA</span><strong>${digest(sync.brandBrainPackageSha256)}</strong></div><div><span>Artwork bytes</span><strong>${count(sync.counts.verifiedArtworkBytes)} verified · 0 copied</strong></div></div></section><section class="ppsync-panel" aria-labelledby="ppsync-blockers"><header><h2 id="ppsync-blockers">Why anything is blocked</h2><p>Quarantines, exact-byte mismatches and retryable source failures remain visible and fail closed.</p></header>${blockers(snapshot)}</section></div>
    <footer class="ppsync-footer"><span>Workspace: ${escapeHtml(snapshot.workspace.workspaceName)}</span><span>Customer-private accepted: no · affiliate content accepted: no · provider effects: off</span></footer>
  </article>`;
}
