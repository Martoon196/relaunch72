import {
  COMPANY_ASSET_QUARANTINE_ROUTE,
  type CompanyAssetsNoticeView,
} from './company-assets-actions.js';
import type {
  CompanyAssetDecisionView,
  CompanyAssetItemView,
  CompanyAssetsView,
} from './company-assets-presenter.js';
import { renderContentWorkspaceNavigation } from './content-workspace-navigation.js';
import { escapeHtml } from './ui.js';

export interface CompanyAssetsActionSecurity {
  readonly csrfToken: string;
  /** Keyed by exact release-item UUID plus decision dimension. */
  readonly quarantineKeys: Readonly<Record<string, string>>;
}

export interface RenderCompanyAssetsOptions {
  readonly security?: CompanyAssetsActionSecurity;
  readonly brandBrainAvailable?: boolean;
  readonly brandBrainLabel?: string;
  readonly assetsLabel?: string;
}

const STYLE = `
  .pal{--bg:#050708;--panel:#0c1012;--raised:#12181b;--soft:#080b0d;--line:#243036;--strong:#34434a;--ink:#f2f6f5;--muted:#a0adb0;--faint:#718087;--teal:#00e5cc;--amber:#f2b84b;--red:#ff7169;min-width:0;color:var(--ink);background:var(--bg);border:1px solid #020303;overflow:hidden}.pal *{box-sizing:border-box}.pal h1,.pal h2,.pal h3,.pal p{margin-top:0}.pal code{font-family:var(--mono,monospace);overflow-wrap:anywhere}.pal a{text-decoration:none}
  .pal-hero{display:grid;grid-template-columns:minmax(0,1.3fr) minmax(260px,.55fr);gap:24px;align-items:end;padding:30px;border-bottom:1px solid var(--line);background:radial-gradient(circle at 83% 0,rgba(0,229,204,.15),transparent 31%),linear-gradient(132deg,#141b1e,#07090a 70%)}.pal-kicker{color:var(--teal);font:850 12px var(--mono,monospace);letter-spacing:.14em;text-transform:uppercase}.pal h1{margin:8px 0 10px;font-family:var(--display,var(--sans));font-size:clamp(2.3rem,5vw,4.7rem);font-weight:600;line-height:.91;letter-spacing:-.045em}.pal h1 em{color:var(--teal);font-style:normal}.pal-hero p{max-width:780px;margin:0;color:var(--muted);font-size:14px;line-height:1.68}.pal-effects{border:1px solid #6b3e3b;background:rgba(28,10,10,.72);padding:16px}.pal-effects small{display:block;color:var(--red);font:900 11px var(--mono,monospace);letter-spacing:.12em;text-transform:uppercase}.pal-effects strong{display:block;margin:7px 0 6px;font:900 22px/1 var(--mono,monospace)}.pal-effects p{color:#d4b8b6;font-size:11px;line-height:1.5}
  .pal-truth{display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:13px;align-items:center;padding:12px 30px;border-bottom:1px solid var(--line);background:#090c0e}.pal-truth>strong{color:var(--teal);font:850 11px var(--mono,monospace);letter-spacing:.08em;text-transform:uppercase}.pal-truth p{margin:0;color:var(--muted);font-size:12px;line-height:1.5}.pal-dataset{border:1px solid var(--strong);padding:4px 8px;color:var(--faint);font:800 10px var(--mono,monospace);text-transform:uppercase;white-space:nowrap}
  .pal-notice{margin:14px 16px 0;border:1px solid var(--strong);border-left:4px solid var(--teal);background:#0b1514;padding:12px 14px}.pal-notice[data-kind=info]{border-left-color:var(--amber);background:#171308}.pal-notice[data-kind=error]{border-left-color:var(--red);background:#190d0d}.pal-notice strong{display:block;font-size:13px}.pal-notice p{margin:4px 0 0;color:var(--muted);font-size:12px;line-height:1.5}
  .pal-metrics{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));border-bottom:1px solid var(--line);background:var(--panel)}.pal-metric{min-width:0;padding:16px 18px;border-right:1px solid var(--line)}.pal-metric:last-child{border-right:0}.pal-metric small{display:block;color:var(--faint);font:800 10px var(--mono,monospace);letter-spacing:.06em;text-transform:uppercase}.pal-metric strong{display:block;margin:7px 0 4px;font:900 23px/1 var(--mono,monospace)}.pal-metric span{display:block;color:var(--muted);font-size:11px;line-height:1.45}.pal-metric.warn strong{color:var(--amber)}.pal-metric.block strong{color:var(--red)}
  .pal-release{display:grid;grid-template-columns:minmax(0,1.35fr) minmax(300px,.65fr);gap:12px;padding:16px;border-bottom:1px solid var(--line)}.pal-panel{min-width:0;border:1px solid var(--line);background:var(--panel)}.pal-panel-head{display:flex;justify-content:space-between;gap:14px;align-items:flex-start;padding:15px 16px 12px;border-bottom:1px solid var(--line)}.pal-panel-head h2{margin:0;font-size:15px}.pal-panel-head p{margin:4px 0 0;color:var(--muted);font-size:11px;line-height:1.45}.pal-chip{display:inline-flex;align-items:center;min-height:23px;border:1px solid var(--strong);padding:3px 7px;color:var(--muted);font:800 10px var(--mono,monospace);text-transform:uppercase;white-space:nowrap}.pal-chip.good{border-color:#2a7b70;color:var(--teal);background:#072824}.pal-chip.warn{border-color:#6b5832;color:var(--amber);background:#171308}.pal-chip.block{border-color:#6b3e3b;color:var(--red);background:#190d0d}.pal-proof-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;padding:12px}.pal-proof{min-width:0;border:1px solid var(--line);background:var(--soft);padding:9px}.pal-proof strong{display:block;margin-bottom:5px;color:var(--faint);font:800 10px var(--mono,monospace);text-transform:uppercase}.pal-proof code,.pal-proof time{font-size:10px}.pal-gates{list-style:none;margin:0;padding:8px 14px}.pal-gates li{display:flex;justify-content:space-between;gap:12px;padding:9px 0;border-bottom:1px solid var(--line);font-size:11px}.pal-gates li:last-child{border-bottom:0}.pal-gates span{color:var(--muted)}
  .pal-catalog{padding:0 16px 16px}.pal-catalog-head{display:flex;justify-content:space-between;gap:14px;align-items:flex-start;padding:17px 0 12px}.pal-catalog-head h2{margin:0;font-size:17px}.pal-catalog-head p{margin:4px 0 0;color:var(--muted);font-size:11px}.pal-items{list-style:none;display:grid;gap:10px;margin:0;padding:0}.pal-card{border:1px solid var(--line);border-left:4px solid var(--teal);background:var(--raised);overflow:hidden}.pal-card.quarantined{border-left-color:var(--red)}.pal-card-head{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:12px;padding:14px;border-bottom:1px solid var(--line)}.pal-meta{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:7px}.pal-card h3{margin:0;font-size:15px}.pal-id{display:block;margin-top:5px;color:var(--faint);font:650 10px var(--mono,monospace);overflow-wrap:anywhere}.pal-status{text-align:right}.pal-status code{display:block;margin-top:5px;color:var(--faint);font-size:9px}.pal-card-grid{display:grid;grid-template-columns:minmax(0,1.15fr) minmax(300px,.85fr)}.pal-evidence{padding:12px;border-right:1px solid var(--line)}.pal-evidence-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px}.pal-evidence .pal-proof.wide{grid-column:1/-1}.pal-decisions{list-style:none;margin:10px 0 0;padding:0}.pal-decision{display:grid;grid-template-columns:minmax(110px,.7fr) minmax(110px,.7fr) minmax(0,1fr);gap:8px;padding:8px 0;border-top:1px solid var(--line);font-size:10px}.pal-decision span{color:var(--muted)}.pal-decision.quarantined strong{color:var(--red)}
  .pal-controls{padding:12px;background:#090d0e}.pal-controls h4{margin:0;font-size:12px}.pal-controls>p{margin:5px 0 10px;color:var(--muted);font-size:10px;line-height:1.45}.pal-action{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:7px;align-items:end;margin-top:8px;padding-top:8px;border-top:1px solid var(--line)}.pal-action label{display:grid;gap:4px;color:var(--faint);font:750 9px var(--mono,monospace);text-transform:uppercase}.pal-action input{height:40px;min-width:0;border:1px solid var(--strong);background:var(--raised);color:var(--ink);padding:0 9px;font:650 10px var(--mono,monospace)}.pal-action button{min-height:40px;border:1px solid #78413d;background:#190d0d;color:var(--red);padding:0 10px;font-size:10px;font-weight:900;cursor:pointer}.pal-locks{display:grid;grid-template-columns:1fr 1fr;gap:7px;margin-top:10px}.pal-lock{border:1px solid var(--line);background:var(--soft);padding:8px}.pal-lock strong{display:block;color:var(--amber);font-size:10px}.pal-lock span{display:block;margin-top:4px;color:var(--faint);font-size:9px;line-height:1.4}.pal-empty{padding:32px;border:1px dashed var(--strong);text-align:center;color:var(--muted)}.pal-footer{display:flex;justify-content:space-between;gap:14px;padding:13px 18px;border-top:1px solid var(--line);background:#07090a;color:var(--faint);font-size:10px}.pal-footer strong{color:var(--muted)}
  @media(max-width:1000px){.pal-hero,.pal-release{grid-template-columns:1fr}.pal-metrics{grid-template-columns:repeat(3,1fr)}.pal-card-grid{grid-template-columns:1fr}.pal-evidence{border-right:0;border-bottom:1px solid var(--line)}}@media(max-width:680px){.pal-hero{padding:24px 20px}.pal-truth{grid-template-columns:1fr;padding:12px 20px}.pal-dataset{justify-self:start}.pal-metrics{grid-template-columns:repeat(2,1fr)}.pal-proof-grid,.pal-evidence-grid{grid-template-columns:1fr}.pal-card-head{grid-template-columns:1fr}.pal-status{text-align:left}.pal-decision{grid-template-columns:1fr}.pal-action{grid-template-columns:1fr}.pal-locks{grid-template-columns:1fr}.pal-footer{flex-direction:column}}@media(max-width:430px){.pal-metrics{grid-template-columns:1fr}.pal-release,.pal-catalog{padding-left:9px;padding-right:9px}}@media(prefers-reduced-motion:reduce){.pal *{scroll-behavior:auto!important;transition:none!important}}
`;

function count(value: number): string {
  return Number.isSafeInteger(value) && value >= 0 ? value.toLocaleString('en-GB') : '0';
}

function time(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 'Not recorded';
  const label = new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC',
  }).format(date);
  return `<time datetime="${escapeHtml(date.toISOString())}">${escapeHtml(label)} UTC</time>`;
}

function notice(view: CompanyAssetsNoticeView | undefined): string {
  if (!view) return '';
  return `<section class="pal-notice" data-kind="${escapeHtml(view.kind)}" role="status"><strong>${escapeHtml(view.title)}</strong><p>${escapeHtml(view.message)}</p></section>`;
}

function decision(view: CompanyAssetDecisionView): string {
  return `<li class="pal-decision ${escapeHtml(view.outcome)}"><span>${escapeHtml(view.dimensionLabel)}</span><strong>${escapeHtml(view.outcomeLabel)}</strong><code title="Evidence SHA-256">${escapeHtml(view.evidenceSha256)}</code><span>${escapeHtml(view.reasonLabel)} · ${time(view.recordedAt)}</span></li>`;
}

function validToken(value: string | undefined): value is string {
  return typeof value === 'string' && value.length >= 16 && value.length <= 512;
}

function validCommandKey(value: string | undefined): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u.test(value);
}

function controls(
  item: CompanyAssetItemView,
  view: CompanyAssetsView,
  security: CompanyAssetsActionSecurity | undefined,
): string {
  const csrfToken = security?.csrfToken;
  const forms = view.canQuarantine && validToken(csrfToken)
    ? item.quarantineActions.map((action) => {
        const commandKey = security?.quarantineKeys[`${item.releaseItemId}:${action.dimension}`];
        if (!validCommandKey(commandKey)) return '';
        return `<form class="pal-action" method="post" action="${COMPANY_ASSET_QUARANTINE_ROUTE}"><input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}"><input type="hidden" name="command_key" value="${escapeHtml(commandKey)}"><input type="hidden" name="source_release_id" value="${escapeHtml(item.sourceReleaseId)}"><input type="hidden" name="release_item_id" value="${escapeHtml(item.releaseItemId)}"><input type="hidden" name="item_type" value="${escapeHtml(item.itemType)}"><input type="hidden" name="item_id" value="${escapeHtml(item.itemId)}"><input type="hidden" name="item_content_sha256" value="${escapeHtml(item.contentSha256)}"><input type="hidden" name="item_brand_sha256" value="${escapeHtml(item.brandSha256)}"><input type="hidden" name="dimension" value="${escapeHtml(action.dimension)}"><input type="hidden" name="outcome" value="quarantined"><input type="hidden" name="reason_code" value="${escapeHtml(action.reasonCode)}"><input type="hidden" name="evidence_sha256" value="${escapeHtml(action.evidenceSha256)}"><input type="hidden" name="return_anchor" value="${escapeHtml(item.anchorId)}"><div><strong>${escapeHtml(action.label)}</strong><span class="pal-id">Evidence is the exact stored content SHA-256.</span></div><button type="submit">Record quarantine</button></form>`;
      }).join('')
    : '';
  const restrictive = forms || `<p>${item.decisionComplete ? 'All three immutable decision dimensions are already recorded.' : view.canManage ? 'Refresh to obtain protected quarantine commands.' : 'Founder or workspace-admin access is required.'}</p>`;
  return `<section class="pal-controls" aria-label="Founder quarantine controls"><h4>Restrictive founder decision</h4><p>Quarantine can only remove this exact hash-bound item from consideration. It cannot clear, approve, publish or call a provider.</p>${restrictive}<div class="pal-locks"><div class="pal-lock"><strong>Clear locked</strong><span>Exact content or artwork is not reviewable on this metadata surface.</span></div><div class="pal-lock"><strong>Approval locked</strong><span>Source approval metadata is evidence, not a new Growth HQ approval.</span></div></div></section>`;
}

function card(
  item: CompanyAssetItemView,
  view: CompanyAssetsView,
  security: CompanyAssetsActionSecurity | undefined,
): string {
  const decisions = item.decisions.length
    ? `<ul class="pal-decisions" aria-label="Recorded item decisions">${item.decisions.map(decision).join('')}</ul>`
    : '<div class="pal-empty">No founder decision is recorded for this exact item yet.</div>';
  return `<li><article class="pal-card${item.quarantined ? ' quarantined' : ''}" id="${escapeHtml(item.anchorId)}" aria-labelledby="${escapeHtml(item.anchorId)}-title"><header class="pal-card-head"><div><div class="pal-meta"><span class="pal-chip">${escapeHtml(item.itemTypeLabel)}</span><span class="pal-chip">Immutable v${count(item.itemVersion)}</span><span class="pal-chip good">${escapeHtml(item.sourceApprovalLabel)}</span></div><h3 id="${escapeHtml(item.anchorId)}-title">${escapeHtml(item.itemLabel)}</h3><code class="pal-id">${escapeHtml(item.itemId)}</code></div><div class="pal-status"><span class="pal-chip ${item.quarantined ? 'block' : item.decisionComplete ? 'good' : 'warn'}">${item.quarantined ? 'Quarantined' : item.decisionComplete ? 'Decision complete' : 'Review incomplete'}</span><code>${escapeHtml(item.releaseItemId)}</code></div></header><div class="pal-card-grid"><section class="pal-evidence" aria-label="Immutable item proof"><div class="pal-evidence-grid"><div class="pal-proof"><strong>Version identity</strong><code>${escapeHtml(item.versionId)}</code></div><div class="pal-proof"><strong>Source approval</strong><code>${escapeHtml(item.approvalId)}</code></div><div class="pal-proof wide"><strong>Content SHA-256</strong><code>${escapeHtml(item.contentSha256)}</code></div>${item.blobSha256 ? `<div class="pal-proof wide"><strong>Artwork/blob SHA-256</strong><code>${escapeHtml(item.blobSha256)}</code></div>` : ''}<div class="pal-proof wide"><strong>Runtime brand SHA-256</strong><code>${escapeHtml(item.brandSha256)}</code></div><div class="pal-proof"><strong>Ownership</strong><span>${escapeHtml(item.ownershipLabel)}</span></div><div class="pal-proof"><strong>Privacy</strong><span>${escapeHtml(item.privacyLabel)}</span></div></div>${decisions}</section>${controls(item, view, security)}</div></article></li>`;
}

export function renderCompanyAssetsBody(
  view: CompanyAssetsView,
  options: RenderCompanyAssetsOptions = {},
): string {
  const release = view.release;
  const cards = view.items.map((item) => card(item, view, options.security)).join('');
  const navigation = renderContentWorkspaceNavigation('assets', {
    companyAssetsAvailable: true,
    assetsLabel: options.assetsLabel,
    brandBrainAvailable: options.brandBrainAvailable === true,
    brainLabel: options.brandBrainLabel,
  });
  return `${navigation}<style data-property-predator-company-assets>${STYLE}</style><article class="pal" aria-labelledby="pal-title"><header class="pal-hero"><div><div class="pal-kicker">Growth HQ · Company asset library</div><h1 id="pal-title">Own the source.<br><em>Prove the exact item.</em></h1><p>Inspect the immutable Property Predator release, source approvals and hash-only founder decisions without copying content, artwork, prompts or knowledge into this page.</p></div><aside class="pal-effects"><small>Runtime boundary</small><strong>PROVIDER EFFECTS OFF</strong><p>No generation, model call, post, message, schedule, purchase or provider operation can start here.</p></aside></header><section class="pal-truth"><strong>Metadata only</strong><p><b>Raw content and artwork are intentionally absent.</b> A founder may quarantine an exact digest tuple because that only narrows use. Clear and approval remain locked.</p><span class="pal-dataset">${escapeHtml(view.datasetLabel)}</span></section>${notice(view.notice)}<section class="pal-metrics" aria-label="Company asset summary"><div class="pal-metric"><small>Items loaded</small><strong>${count(view.metrics.loadedItems)}</strong><span>Bounded immutable rows</span></div><div class="pal-metric"><small>Artwork assets</small><strong>${count(view.metrics.assetItems)}</strong><span>References and digests only</span></div><div class="pal-metric"><small>Decisions</small><strong>${count(view.metrics.recordedDecisions)}</strong><span>Exact item dimensions</span></div><div class="pal-metric block"><small>Quarantined</small><strong>${count(view.metrics.quarantinedItems)}</strong><span>Excluded, never activated</span></div><div class="pal-metric warn"><small>Unresolved</small><strong>${count(view.metrics.unresolvedDimensions)}</strong><span>Remain fail-closed</span></div></section>${release ? `<section class="pal-release"><article class="pal-panel"><header class="pal-panel-head"><div><h2>Canonical source release</h2><p>One immutable migration 0033 release; no source path or payload.</p></div><span class="pal-chip ${release.sourceFresh ? 'good' : 'block'}">${release.sourceFresh ? 'Source proof fresh' : 'Source proof stale'}</span></header><div class="pal-proof-grid"><div class="pal-proof"><strong>Release identity</strong><code>${escapeHtml(release.sourceReleaseId)}</code></div><div class="pal-proof"><strong>Recorded</strong>${time(release.recordedAt)}</div><div class="pal-proof"><strong>Release SHA-256</strong><code>${escapeHtml(release.releaseSha256)}</code></div><div class="pal-proof"><strong>Catalog SHA-256</strong><code>${escapeHtml(release.sourceCatalogSha256)}</code></div><div class="pal-proof"><strong>Scope SHA-256</strong><code>${escapeHtml(release.scopeSha256)}</code></div><div class="pal-proof"><strong>Brand Brain SHA-256</strong><code>${escapeHtml(release.brandBrainPackageSha256)}</code></div></div></article><aside class="pal-panel"><header class="pal-panel-head"><div><h2>Release gates</h2><p>Every missing or negative fact stays blocking.</p></div><span class="pal-chip ${release.latestUsable ? 'good' : 'warn'}">${release.latestUsable ? 'Reconciliation gates passed' : 'Runtime locked'}</span></header><ul class="pal-gates"><li><span>Golden evaluation</span><strong>${release.evaluationPassed ? 'Passed' : 'Not passed'}</strong></li><li><span>Founder scope approval</span><strong>${release.founderApproved ? 'Recorded' : 'Missing'}</strong></li><li><span>Decision coverage</span><strong>${release.quarantineDecisionComplete ? 'Complete' : 'Incomplete'}</strong></li><li><span>Any quarantine</span><strong>${release.quarantined ? 'Yes · blocked' : 'No'}</strong></li></ul></aside></section>` : ''}<section class="pal-catalog" aria-labelledby="pal-catalog-title"><header class="pal-catalog-head"><div><h2 id="pal-catalog-title">Exact release items</h2><p>Identifiers, ownership classes, approvals and hashes only.</p></div><span class="pal-chip">${count(view.items.length)} shown</span></header>${cards ? `<ol class="pal-items">${cards}</ol>` : '<div class="pal-empty"><strong>No immutable company assets are recorded.</strong><p>Nothing has been invented and no source payload was fetched.</p></div>'}</section><footer class="pal-footer"><span><strong>${escapeHtml(view.workspaceName)}</strong> · snapshot ${time(view.asOf)}</span><span>${view.illustrative ? 'Illustrative fixture · ' : ''}${view.inputTruncated ? 'Bounded page · ' : ''}clear locked · approval locked · provider effects off</span></footer></article>`;
}
