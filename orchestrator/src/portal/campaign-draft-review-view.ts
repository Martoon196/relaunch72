import type { PropertyPredatorReviewCampaignDraft } from '../company-content-adapter/property-predator-campaign-draft-runtime.js';
import { CAMPAIGN_WIZARD_ROUTE } from './campaign-wizard-actions.js';
import { renderContentWorkspaceNavigation } from './content-workspace-navigation.js';
import { escapeHtml } from './ui.js';

const STYLE = `
  .cdr{--bg:#07090b;--panel:#0e1417;--line:#2a383e;--ink:#f3f7f6;--muted:#a7b4b7;--faint:#78898e;--teal:#00e5cc;--amber:#f2b94b;overflow:hidden;border:1px solid #020304;background:var(--bg);color:var(--ink)}
  .cdr *{box-sizing:border-box}.cdr h1,.cdr h2,.cdr p{margin-top:0}.cdr-hero{display:grid;grid-template-columns:minmax(0,1fr) minmax(260px,340px);gap:24px;padding:30px;background:radial-gradient(circle at 86% -20%,rgba(0,229,204,.2),transparent 38%),linear-gradient(135deg,#141d21,#080a0c 68%);border-bottom:1px solid var(--line)}.cdr-kicker{color:var(--teal);font:900 11px var(--mono,monospace);letter-spacing:.13em;text-transform:uppercase}.cdr-hero h1{margin:9px 0 10px;font-size:clamp(2.15rem,4.5vw,4.5rem);letter-spacing:-.05em;line-height:.95}.cdr-hero p{max-width:750px;margin-bottom:0;color:var(--muted);font-size:13px;line-height:1.65}.cdr-gate{border:1px solid #397b73;background:#071c19;padding:15px}.cdr-gate strong,.cdr-gate span{display:block}.cdr-gate strong{color:var(--teal);font:900 11px var(--mono,monospace);letter-spacing:.08em;text-transform:uppercase}.cdr-gate span{margin-top:8px;color:var(--muted);font-size:11px;line-height:1.5}.cdr-grid{display:grid;grid-template-columns:minmax(0,1.35fr) minmax(290px,.65fr)}.cdr-copy{padding:22px;border-right:1px solid var(--line)}.cdr-copy article{border:1px solid var(--line);background:var(--panel);padding:20px}.cdr-copy h2{margin-bottom:13px;font-size:23px}.cdr-body{white-space:pre-wrap;color:var(--ink);font-size:14px;line-height:1.75}.cdr-cta{display:inline-flex;margin-top:17px;border:1px solid var(--teal);padding:10px 13px;color:var(--teal);font-size:11px;font-weight:900;text-decoration:none}.cdr-side{display:grid;align-content:start;gap:12px;padding:22px}.cdr-card{border:1px solid var(--line);background:var(--panel);padding:14px}.cdr-card h2{margin-bottom:10px;font-size:14px}.cdr-card dl{display:grid;gap:8px;margin:0}.cdr-card div{border-top:1px solid var(--line);padding-top:8px}.cdr-card dt{color:var(--faint);font-size:9px;text-transform:uppercase}.cdr-card dd{margin:4px 0 0;color:var(--muted);font:750 10px var(--mono,monospace);overflow-wrap:anywhere}.cdr-proof{display:grid;gap:6px;margin:0;padding:0;list-style:none}.cdr-proof li{border-left:2px solid var(--teal);padding:7px 9px;background:#0a1012}.cdr-proof strong,.cdr-proof code{display:block;font-size:10px}.cdr-proof code{margin-top:3px;color:var(--faint);overflow-wrap:anywhere}.cdr-actions{display:flex;flex-wrap:wrap;gap:8px;padding:18px 22px;border-top:1px solid var(--line)}.cdr-button{display:inline-flex;min-height:44px;align-items:center;border:1px solid var(--teal);padding:0 14px;color:var(--teal);font-size:11px;font-weight:900;text-decoration:none}.cdr-button.secondary{border-color:var(--line);color:var(--muted)}
  @media(max-width:820px){.cdr-hero,.cdr-grid{grid-template-columns:1fr}.cdr-copy{border-right:0;border-bottom:1px solid var(--line)}}
  @media(max-width:560px){.cdr-hero,.cdr-copy,.cdr-side{padding:17px}.cdr-actions{display:grid}.cdr-button{justify-content:center}}
  @media(forced-colors:active){.cdr,.cdr-card,.cdr-copy article,.cdr-gate,.cdr-button{border-color:CanvasText}}
`;

function short(value: string): string {
  return `${value.slice(0, 12)}…`;
}

function safeCtaUrl(value: string): string | null {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return url.protocol === 'https:' && !url.username && !url.password
      && (host === 'propertypredator.com' || host.endsWith('.propertypredator.com'))
      ? url.href
      : null;
  } catch {
    return null;
  }
}

export function renderCampaignDraftReviewBody(
  result: PropertyPredatorReviewCampaignDraft,
): string {
  const ctaUrl = safeCtaUrl(result.draft.payload.cta_url);
  const facts = result.evidence.approvedFacts.map((item) =>
    `<li><strong>Approved fact · immutable v${item.versionNumber.toLocaleString('en-GB')}</strong><code>${escapeHtml(item.contentVersionId)} · ${escapeHtml(short(item.contentSha256))}</code></li>`).join('');
  const assets = result.evidence.approvedAssets.map((item) =>
    `<li><strong>Approved asset · immutable v${item.versionNumber.toLocaleString('en-GB')}</strong><code>${escapeHtml(item.contentVersionId)} · ${escapeHtml(short(item.blobSha256))}</code></li>`).join('');
  const cta = ctaUrl
    ? `<a class="cdr-cta" href="${escapeHtml(ctaUrl)}">Review destination</a>`
    : '<span class="cdr-cta" aria-disabled="true">Destination unavailable</span>';
  return `${renderContentWorkspaceNavigation('create', { companyAssetsAvailable: true, brandBrainAvailable: true })}<style data-property-predator-campaign-draft-review>${STYLE}</style><article class="cdr" aria-labelledby="cdr-title" data-review-required="true" data-publishable="false" data-sendable="false" data-schedulable="false" data-provider-effects="generation-only" data-outbound-effects="false"><header class="cdr-hero"><div><span class="cdr-kicker">Growth HQ · immutable source draft</span><h1 id="cdr-title">Generated. <em>Not unleashed.</em></h1><p>One real Property Predator company-content generation completed against the exact Brand Brain, fact and asset versions below. This result is review-only: it cannot send, schedule or publish.</p></div><aside class="cdr-gate"><strong>Human review required</strong><span>Approval status: unrequested. Provider effects ended with generation; outbound effects remain zero.</span></aside></header><div class="cdr-grid"><main class="cdr-copy"><article aria-labelledby="cdr-copy-title"><span class="cdr-kicker">${escapeHtml(result.draft.payload.platform)} draft</span><h2 id="cdr-copy-title">${escapeHtml(result.draft.payload.title)}</h2><div class="cdr-body">${escapeHtml(result.draft.payload.body)}</div>${cta}</article></main><aside class="cdr-side"><section class="cdr-card" aria-labelledby="cdr-proof-title"><h2 id="cdr-proof-title">Exact evidence</h2><ul class="cdr-proof">${facts}${assets}</ul></section><section class="cdr-card" aria-labelledby="cdr-source-title"><h2 id="cdr-source-title">Immutable source proof</h2><dl><div><dt>Source draft</dt><dd>${escapeHtml(result.immutableSource.draftId)}</dd></div><div><dt>Source version</dt><dd>${escapeHtml(result.immutableSource.versionId)} · v${result.immutableSource.itemVersion.toLocaleString('en-GB')}</dd></div><div><dt>Content SHA-256</dt><dd>${escapeHtml(result.immutableSource.contentSha256)}</dd></div><div><dt>Plan SHA-256</dt><dd>${escapeHtml(result.planSha256)}</dd></div><div><dt>Evidence SHA-256</dt><dd>${escapeHtml(result.evidenceSha256)}</dd></div><div><dt>Usage proof</dt><dd>${escapeHtml(result.immutableSource.usageSha256)}</dd></div><div><dt>Reserved ceiling</dt><dd>${result.maximumCostMinor.toLocaleString('en-GB')} minor units · token usage unpriced</dd></div></dl></section></aside></div><footer class="cdr-actions"><a class="cdr-button" href="${CAMPAIGN_WIZARD_ROUTE}?laps=${encodeURIComponent(result.evidence.plan.selectionKey)}">Generate another review draft</a><a class="cdr-button secondary" href="/portal/content">Return to Content Control</a></footer></article>`;
}
