import type { PropertyPredatorReviewCampaignDraft } from '../company-content-adapter/property-predator-campaign-draft-runtime.js';
import type { StagedPropertyPredatorGeneratedDraft } from '../company-content-adapter/property-predator-generation-approval.js';
import { CAMPAIGN_WIZARD_GENERATE_REVIEW_DRAFT_ROUTE, CAMPAIGN_WIZARD_ROUTE } from './campaign-wizard-actions.js';
import { renderContentWorkspaceNavigation } from './content-workspace-navigation.js';
import { escapeHtml } from './ui.js';
import type { CampaignMediaVariant } from './campaign-media-variants.js';
import type { PortalCampaignDraftOutcome } from './campaign-draft-service.js';

export interface CampaignDraftChannelFailure {
  readonly platform: string;
  readonly kind: Extract<PortalCampaignDraftOutcome, { ok: false }>['kind'];
}

const CHANNEL_FAILURE_GUIDANCE: Readonly<Record<CampaignDraftChannelFailure['kind'], string>> = Object.freeze({
  validation: 'Update the source brief before trying this channel again. Remove private contact details or active HTML.',
  conflict: 'The evidence changed. Refresh the campaign evidence before starting another request.',
  forbidden: 'Workspace owner or admin access is required. Check your workspace access before continuing.',
  unauthenticated: 'Your session ended. Sign in again before continuing.',
  unavailable: 'The draft could not be saved safely. Retry this same request.',
});

const STYLE = `
  .cdr{--cdr-bg:#07090b;--cdr-panel:#0e1417;--cdr-line:#2a383e;--cdr-ink:#f3f7f6;--cdr-muted:#a7b4b7;--cdr-faint:#78898e;--cdr-teal:#00e5cc;--cdr-amber:#f2b94b;overflow:hidden;border:1px solid #020304;background:var(--cdr-bg);color:var(--cdr-ink)}.cdr>*{--bg:var(--cdr-bg);--panel:var(--cdr-panel);--line:var(--cdr-line);--ink:var(--cdr-ink);--muted:var(--cdr-muted);--faint:var(--cdr-faint);--teal:var(--cdr-teal);--amber:var(--cdr-amber)}
  .cdr *{box-sizing:border-box}.cdr h1,.cdr h2,.cdr p{margin-top:0}.cdr-hero{display:grid;grid-template-columns:minmax(0,1fr) minmax(260px,340px);gap:24px;padding:30px;background:radial-gradient(circle at 86% -20%,rgba(0,229,204,.2),transparent 38%),linear-gradient(135deg,#141d21,#080a0c 68%);border-bottom:1px solid var(--line)}.cdr-kicker{color:var(--teal);font:900 11px var(--mono,monospace);letter-spacing:.13em;text-transform:uppercase}.cdr-hero h1{margin:9px 0 10px;font-size:clamp(2.15rem,4.5vw,4.5rem);letter-spacing:-.05em;line-height:.95}.cdr-hero p{max-width:750px;margin-bottom:0;color:var(--muted);font-size:13px;line-height:1.65}.cdr-gate{border:1px solid #397b73;background:#071c19;padding:15px}.cdr-gate strong,.cdr-gate span{display:block}.cdr-gate strong{color:var(--teal);font:900 11px var(--mono,monospace);letter-spacing:.08em;text-transform:uppercase}.cdr-gate span{margin-top:8px;color:var(--muted);font-size:11px;line-height:1.5}.cdr-grid{display:grid;grid-template-columns:minmax(0,1.35fr) minmax(290px,.65fr)}.cdr-copy{padding:22px;border-right:1px solid var(--line)}.cdr-copy article{border:1px solid var(--line);background:var(--panel);padding:20px}.cdr-copy h2{margin-bottom:13px;font-size:23px}.cdr-body{white-space:pre-wrap;color:var(--ink);font-size:14px;line-height:1.75}.cdr-cta{display:inline-flex;margin-top:17px;border:1px solid var(--teal);padding:10px 13px;color:var(--teal);font-size:11px;font-weight:900;text-decoration:none}.cdr-side{display:grid;align-content:start;gap:12px;padding:22px}.cdr-card{border:1px solid var(--line);background:var(--panel);padding:14px}.cdr-card h2{margin-bottom:10px;font-size:14px}.cdr-card dl{display:grid;gap:8px;margin:0}.cdr-card div{border-top:1px solid var(--line);padding-top:8px}.cdr-card dt{color:var(--faint);font-size:9px;text-transform:uppercase}.cdr-card dd{margin:4px 0 0;color:var(--muted);font:750 10px var(--mono,monospace);overflow-wrap:anywhere}.cdr-proof{display:grid;gap:6px;margin:0;padding:0;list-style:none}.cdr-proof li{border-left:2px solid var(--teal);padding:7px 9px;background:#0a1012}.cdr-proof strong,.cdr-proof code{display:block;font-size:10px}.cdr-proof code{margin-top:3px;color:var(--faint);overflow-wrap:anywhere}.cdr-actions{display:flex;flex-wrap:wrap;gap:8px;padding:18px 22px;border-top:1px solid var(--line)}.cdr-button{display:inline-flex;min-height:44px;align-items:center;border:1px solid var(--teal);padding:0 14px;color:var(--teal);font-size:11px;font-weight:900;text-decoration:none}.cdr-button.secondary{border-color:var(--line);color:var(--muted)}
  .cdr-pack{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;padding:22px}.cdr-pack article{display:grid;align-content:start;border:1px solid var(--line);background:var(--panel);padding:20px}.cdr-pack-head{display:flex;justify-content:space-between;gap:10px;align-items:center;margin-bottom:12px}.cdr-pack-head strong{color:var(--teal);font:900 11px var(--mono,monospace);letter-spacing:.12em;text-transform:uppercase}.cdr-pack-head span{color:var(--faint);font-size:9px}.cdr-pack h2{font-size:21px}.cdr-pack .cdr-body{min-height:190px}.cdr-pack .cdr-card{margin-top:16px}.cdr-pack-media{margin:0 0 14px;border:1px solid var(--line);background:#050708;padding:6px}.cdr-pack-media img,.cdr-pack-media video{display:block;width:100%;max-height:360px;object-fit:cover}.cdr-pack-media figcaption{padding:7px 3px 2px;color:var(--faint);font:750 9px var(--mono,monospace);text-transform:uppercase}.cdr-failures{margin:0 22px 22px;border:1px solid var(--amber);padding:14px;color:var(--muted)}.cdr-failures strong{color:var(--amber)}
  @media(max-width:820px){.cdr-hero,.cdr-grid,.cdr-pack{grid-template-columns:1fr}.cdr-copy{border-right:0;border-bottom:1px solid var(--line)}}
  @media(max-width:560px){.cdr-hero,.cdr-copy,.cdr-side{padding:17px}.cdr-actions{display:grid}.cdr-button{justify-content:center}}
  html[data-theme="light"] .cdr{--cdr-bg:var(--canvas);--cdr-panel:var(--panel);--cdr-line:var(--line);--cdr-ink:var(--ink);--cdr-muted:var(--muted);--cdr-faint:var(--faint);--cdr-teal:var(--accent-deep);--cdr-amber:var(--accent-deep);border-color:var(--line)}html[data-theme="light"] .cdr-hero{background:linear-gradient(135deg,var(--panel),var(--panel-subtle))}html[data-theme="light"] .cdr-gate,html[data-theme="light"] .cdr-proof li{background:var(--accent-soft)}html[data-theme="light"] .cdr-pack-media{background:var(--panel-subtle)}
  @media(prefers-color-scheme:light){html[data-theme="system"] .cdr{--cdr-bg:var(--canvas);--cdr-panel:var(--panel);--cdr-line:var(--line);--cdr-ink:var(--ink);--cdr-muted:var(--muted);--cdr-faint:var(--faint);--cdr-teal:var(--accent-deep);--cdr-amber:var(--accent-deep);border-color:var(--line)}html[data-theme="system"] .cdr-hero{background:linear-gradient(135deg,var(--panel),var(--panel-subtle))}html[data-theme="system"] .cdr-gate,html[data-theme="system"] .cdr-proof li{background:var(--accent-soft)}html[data-theme="system"] .cdr-pack-media{background:var(--panel-subtle)}}
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

function artworkInstructions(value: string | undefined): string {
  return value
    ? `<section class="cdr-card"><h2>Artwork instructions</h2><div class="cdr-body">${escapeHtml(value)}</div></section>`
    : '';
}

function mediaPlacementLabel(media: CampaignMediaVariant): string {
  if (media.platform === 'instagram') {
    return media.mediaType === 'video' ? 'feed + Reel + Story' : 'feed + Story';
  }
  if (media.platform === 'tiktok') {
    return media.mediaType === 'video' ? 'video post' : 'photo post';
  }
  return 'feed post';
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
  return `${renderContentWorkspaceNavigation('create', { companyAssetsAvailable: true, brandBrainAvailable: true })}<style data-property-predator-campaign-draft-review>${STYLE}</style><article class="cdr" aria-labelledby="cdr-title" data-review-required="true" data-publishable="false" data-sendable="false" data-schedulable="false" data-provider-effects="generation-only" data-outbound-effects="false"><header class="cdr-hero"><div><span class="cdr-kicker">Growth HQ · immutable source draft</span><h1 id="cdr-title">Generated. <em>Not unleashed.</em></h1><p>One real Property Predator company-content generation completed against the exact Brand Brain, fact and asset versions below. This result is review-only: it cannot send, schedule or publish.</p></div><aside class="cdr-gate"><strong>Human review required</strong><span>Approval status: unrequested. Provider effects ended with generation; outbound effects remain zero.</span></aside></header><div class="cdr-grid"><main class="cdr-copy"><article aria-labelledby="cdr-copy-title"><span class="cdr-kicker">${escapeHtml(result.draft.payload.platform)} draft</span><h2 id="cdr-copy-title">${escapeHtml(result.draft.payload.title)}</h2><div class="cdr-body">${escapeHtml(result.draft.payload.body)}</div>${cta}</article>${artworkInstructions(result.draft.payload.artwork_instructions)}</main><aside class="cdr-side"><section class="cdr-card" aria-labelledby="cdr-proof-title"><h2 id="cdr-proof-title">Exact evidence</h2><ul class="cdr-proof">${facts}${assets}</ul></section><section class="cdr-card" aria-labelledby="cdr-source-title"><h2 id="cdr-source-title">Immutable source proof</h2><dl><div><dt>Source draft</dt><dd>${escapeHtml(result.immutableSource.draftId)}</dd></div><div><dt>Source version</dt><dd>${escapeHtml(result.immutableSource.versionId)} · v${result.immutableSource.itemVersion.toLocaleString('en-GB')}</dd></div><div><dt>Content SHA-256</dt><dd>${escapeHtml(result.immutableSource.contentSha256)}</dd></div><div><dt>Plan SHA-256</dt><dd>${escapeHtml(result.planSha256)}</dd></div><div><dt>Evidence SHA-256</dt><dd>${escapeHtml(result.evidenceSha256)}</dd></div><div><dt>Usage proof</dt><dd>${escapeHtml(result.immutableSource.usageSha256)}</dd></div><div><dt>Reserved ceiling</dt><dd>${result.maximumCostMinor.toLocaleString('en-GB')} minor units · token usage unpriced</dd></div></dl></section></aside></div><footer class="cdr-actions"><a class="cdr-button" href="${CAMPAIGN_WIZARD_ROUTE}?laps=${encodeURIComponent(result.evidence.plan.selectionKey)}">Generate another review draft</a><a class="cdr-button secondary" href="/portal/content">Return to Content Control</a></footer></article>`;
}

/** Render independently reviewable drafts created from one shared source. */
export function renderCampaignDraftPackReviewBody(
  results: readonly PropertyPredatorReviewCampaignDraft[],
  failedPlatforms: readonly string[] = [],
  mediaVariants: readonly CampaignMediaVariant[] = [],
): string {
  if (results.length < 1) throw new Error('A channel pack requires a confirmed draft');
  const first = results[0]!;
  const cards = results.map((result, index) => {
    const ctaUrl = safeCtaUrl(result.draft.payload.cta_url);
    const cta = ctaUrl
      ? `<a class="cdr-cta" href="${escapeHtml(ctaUrl)}">Review destination</a>`
      : '<span class="cdr-cta" aria-disabled="true">Destination unavailable</span>';
    const media = mediaVariants.find((item) => item.platform === result.draft.payload.platform);
    const mediaMarkup = media
      ? `<figure class="cdr-pack-media">${media.mediaType === 'image'
        ? `<img src="${escapeHtml(media.url)}" alt="${escapeHtml(media.platform)} media version preview">`
        : `<video src="${escapeHtml(media.url)}" controls preload="metadata"></video>`}<figcaption>${escapeHtml(media.platform)} ${escapeHtml(mediaPlacementLabel(media))} · ${media.width.toLocaleString('en-GB')} × ${media.height.toLocaleString('en-GB')} · ${escapeHtml(media.treatment.replaceAll('_', ' '))}</figcaption></figure>`
      : '';
    return `<article aria-labelledby="cdr-pack-${index}"><header class="cdr-pack-head"><strong>${escapeHtml(result.draft.payload.platform)}</strong><span>Review required</span></header>${mediaMarkup}<h2 id="cdr-pack-${index}">${escapeHtml(result.draft.payload.title)}</h2><div class="cdr-body">${escapeHtml(result.draft.payload.body)}</div>${cta}${artworkInstructions(result.draft.payload.artwork_instructions)}<section class="cdr-card"><h2>Version proof</h2><dl><div><dt>Version</dt><dd>${escapeHtml(result.immutableSource.versionId)}</dd></div><div><dt>Content</dt><dd>${escapeHtml(short(result.immutableSource.contentSha256))}</dd></div><div><dt>Usage</dt><dd>${escapeHtml(short(result.immutableSource.usageSha256))}</dd></div>${media ? `<div><dt>Media</dt><dd>${escapeHtml(short(media.contentSha256))}</dd></div>` : ''}</dl></section></article>`;
  }).join('');
  const failures = failedPlatforms.length > 0
    ? `<aside class="cdr-failures" role="status"><strong>Some channels need another try.</strong> ${escapeHtml(failedPlatforms.join(', '))} did not return a confirmed version. Successful drafts were kept and will not be repeated automatically.</aside>`
    : '';
  const evidence = [...first.evidence.approvedFacts, ...first.evidence.approvedAssets]
    .map((item) => `<li><strong>Approved ${item.kind} · immutable v${item.versionNumber.toLocaleString('en-GB')}</strong><code>${escapeHtml(item.contentVersionId)} · ${escapeHtml(short(item.contentSha256))}</code></li>`)
    .join('');
  return `${renderContentWorkspaceNavigation('create', { companyAssetsAvailable: true, brandBrainAvailable: true })}<style data-property-predator-campaign-draft-review>${STYLE}</style><article class="cdr" aria-labelledby="cdr-title" data-channel-pack data-review-required="true" data-publishable="false" data-sendable="false" data-schedulable="false" data-provider-effects="generation-only" data-outbound-effects="false"><header class="cdr-hero"><div><span class="cdr-kicker">Growth HQ · Property Predator channel pack</span><h1 id="cdr-title">One source. <em>${results.length.toLocaleString('en-GB')} native draft${results.length === 1 ? '' : 's'}.</em></h1><p>The same approved source, Brand Brain and conversion move produced separate channel expressions. Compare them here; each remains an immutable review draft.</p></div><aside class="cdr-gate"><strong>Nothing published</strong><span>${results.length.toLocaleString('en-GB')} draft${results.length === 1 ? '' : 's'} confirmed. Approval remains unrequested and every outbound effect remains off.</span></aside></header><main class="cdr-pack">${cards}</main>${failures}<aside class="cdr-side"><section class="cdr-card" aria-labelledby="cdr-pack-proof"><h2 id="cdr-pack-proof">Shared source evidence</h2><ul class="cdr-proof">${evidence}</ul></section></aside><footer class="cdr-actions"><a class="cdr-button" href="${CAMPAIGN_WIZARD_ROUTE}?laps=${encodeURIComponent(first.evidence.plan.selectionKey)}">Create another channel pack</a><a class="cdr-button secondary" href="/portal/content">Return to Content Control</a></footer></article>`;
}

/** Review summary for drafts already persisted into the owned HQ catalogue. */
export function renderStagedCampaignDraftPackReviewBody(
  results: readonly StagedPropertyPredatorGeneratedDraft[],
  failedPlatforms: readonly string[],
  mediaVariants: readonly CampaignMediaVariant[] = [],
  retry?: Readonly<{ csrfToken: string; commandKey: string; expectedPlanSha256: string; expectedEvidenceSha256: string; selection: string; tone: string; topic: string; factVersionIds: readonly string[]; assetVersionIds: readonly string[] }>,
  failureDetails: readonly CampaignDraftChannelFailure[] = [],
): string {
  const cards = results.map((result, index) => {
    const payload = result.draft.payload;
    const href = `/portal/content/items/${encodeURIComponent(result.reviewTarget.contentItemId)}`
      + `/versions/${encodeURIComponent(result.reviewTarget.contentVersionId)}/review`;
    const cta = payload.cta_url ? `<p class="cdr-cta">${escapeHtml(payload.cta_url)}</p>` : '';
    const media = mediaVariants.find((item) => item.platform === payload.platform);
    const mediaMarkup = media ? `<figure class="cdr-pack-media">${media.mediaType === 'image' ? `<img src="${escapeHtml(media.url)}" alt="${escapeHtml(media.platform)} prepared media preview">` : `<video src="${escapeHtml(media.url)}" controls preload="metadata"></video>`}<figcaption>${escapeHtml(media.platform)} ${escapeHtml(mediaPlacementLabel(media))} · media preview · not saved with this text version</figcaption></figure>` : '';
    return `<article aria-labelledby="cdr-saved-${index}"><header class="cdr-pack-head"><strong>${escapeHtml(payload.platform)}</strong><span>Saved · review required</span></header>${mediaMarkup}<h2 id="cdr-saved-${index}">${escapeHtml(payload.title)}</h2><div class="cdr-body">${escapeHtml(payload.body)}</div>${cta}${artworkInstructions(payload.artwork_instructions)}<section class="cdr-card"><h2>Saved version</h2><dl><div><dt>Version</dt><dd>v${result.reviewTarget.versionNumber.toLocaleString('en-GB')}</dd></div><div><dt>Approval</dt><dd>Not requested</dd></div></dl></section><a class="cdr-button" href="${href}">Review saved version</a></article>`;
  }).join('');
  const channelFailures = failedPlatforms.map((platform) => ({
    platform,
    kind: failureDetails.find((failure) => failure.platform === platform)?.kind ?? 'unavailable',
  }));
  const retryPlatforms = channelFailures.filter((failure) => failure.kind === 'unavailable')
    .map((failure) => failure.platform);
  const correctionRequired = retryPlatforms.length !== failedPlatforms.length;
  const hidden = (name: string, value: string) => `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`;
  const retryForm = retry && retryPlatforms.length > 0 ? `<form method="post" action="${CAMPAIGN_WIZARD_GENERATE_REVIEW_DRAFT_ROUTE}" class="cdr-actions">${hidden('_csrf', retry.csrfToken)}${hidden('command_key', retry.commandKey)}${hidden('expected_plan_sha256', retry.expectedPlanSha256)}${hidden('expected_evidence_sha256', retry.expectedEvidenceSha256)}${hidden('laps', retry.selection)}${hidden('tone', retry.tone)}${hidden('topic', retry.topic)}${hidden('provider_effects', 'generation_only')}${hidden('confirm_generation_only', 'confirmed')}${retryPlatforms.map((p) => hidden('platform', p)).join('')}${retry.factVersionIds.map((v) => hidden('approved_fact_version_id', v)).join('')}${retry.assetVersionIds.map((v) => hidden('approved_asset_version_id', v)).join('')}${mediaVariants.filter((m) => retryPlatforms.includes(m.platform)).map((m) => hidden('media_variant', JSON.stringify(m))).join('')}<button class="cdr-button" type="submit">Retry only failed channels</button><span>Retry: ${retryPlatforms.map(escapeHtml).join(', ')}. Your saved drafts stay in the library.</span></form>` : '';
  const failures = failedPlatforms.length > 0
    ? `<section class="cdr-failures" role="status"><strong>Some channels could not be saved:</strong><ul>${channelFailures.map((failure) => `<li><strong>${escapeHtml(failure.platform)}</strong>: ${escapeHtml(CHANNEL_FAILURE_GUIDANCE[failure.kind])}</li>`).join('')}</ul><p>Saved channels remain available in your library.</p></section>`
    : '';
  const correctionLink = correctionRequired
    ? `<a class="cdr-button secondary" href="${CAMPAIGN_WIZARD_ROUTE}${retry ? `?laps=${encodeURIComponent(retry.selection)}` : ''}">Review campaign source and evidence</a>` : '';
  return `${renderContentWorkspaceNavigation('create', { companyAssetsAvailable: true, brandBrainAvailable: true })}<style data-property-predator-campaign-draft-review>${STYLE}</style><article class="cdr" aria-labelledby="cdr-title" data-review-required="true" data-publishable="false" data-sendable="false" data-schedulable="false"><header class="cdr-hero"><div><span class="cdr-kicker">Property Predator content studio</span><h1 id="cdr-title">${results.length ? 'Drafts saved. <em>Review next.</em>' : 'Drafts could not be saved.'}</h1><p>${results.length ? 'Each successful channel is now a saved content version. Open a version to review its exact words and request approval before planning it.' : 'Nothing was approved, scheduled or posted. Check the channel guidance below before continuing.'}</p></div><aside class="cdr-gate"><strong>Nothing was posted</strong><span>Approval is unrequested. No channel was scheduled or published.</span></aside></header>${failures}<section class="cdr-pack" aria-label="Saved channel drafts">${cards}</section>${retryForm}<footer class="cdr-actions">${correctionLink}<a class="cdr-button secondary" href="/portal/content">Open your library</a></footer></article>`;
}
