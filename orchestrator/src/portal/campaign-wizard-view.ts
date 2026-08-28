import {
  CAMPAIGN_WIZARD_ROUTE,
  isCampaignWizardCreateActionReady,
  type CampaignWizardCreateAction,
  type CampaignWizardOperationOutcome,
} from './campaign-wizard-actions.js';
import type {
  CampaignWizardChannelGroupView,
  CampaignWizardContentOptionView,
  CampaignWizardView,
} from './campaign-wizard-presenter.js';
import { renderContentWorkspaceNavigation } from './content-workspace-navigation.js';
import { escapeHtml } from './ui.js';

const CAMPAIGN_WIZARD_STYLE = `
  .cwiz{--w-bg:#07090b;--w-panel:#0d1215;--w-raised:#12191d;--w-line:#27343a;--w-line2:#405158;--w-ink:#f2f6f5;--w-muted:#a5b1b4;--w-faint:#788a8f;--w-teal:#00e5cc;--w-teal2:#75f5e6;--w-amber:#f2b94b;--w-red:#ff756e;overflow:hidden;border:1px solid #020304;background:var(--w-bg);color:var(--w-ink);font-family:var(--sans,ui-sans-serif,system-ui,sans-serif)}
  .cwiz *{box-sizing:border-box}.cwiz h1,.cwiz h2,.cwiz h3,.cwiz p{margin-top:0}.cwiz button,.cwiz input,.cwiz select,.cwiz textarea{font:inherit}.cwiz-hero{display:grid;grid-template-columns:minmax(0,1fr) minmax(260px,340px);gap:26px;align-items:end;padding:30px;background:radial-gradient(circle at 82% -20%,rgba(0,229,204,.2),transparent 38%),linear-gradient(135deg,#131b1f,#080a0c 68%);border-bottom:1px solid var(--w-line)}.cwiz-kicker{color:var(--w-teal);font:900 11px var(--mono,monospace);letter-spacing:.14em;text-transform:uppercase}.cwiz-hero h1{margin:9px 0 10px;font-size:clamp(2.3rem,4.8vw,4.9rem);font-weight:620;letter-spacing:-.055em;line-height:.92}.cwiz-hero h1 em{color:var(--w-teal);font-style:normal}.cwiz-hero p{max-width:760px;margin-bottom:0;color:var(--w-muted);font-size:14px;line-height:1.65}.cwiz-boundary{border:1px solid #35766e;background:rgba(5,27,24,.78);padding:16px}.cwiz-boundary strong,.cwiz-boundary span,.cwiz-boundary small{display:block}.cwiz-boundary strong{color:var(--w-teal);font:900 12px var(--mono,monospace);letter-spacing:.07em;text-transform:uppercase}.cwiz-boundary span{margin:9px 0 5px;font-weight:850}.cwiz-boundary small{color:var(--w-muted);font-size:11px;line-height:1.5}
  .cwiz-progress{display:grid;grid-template-columns:repeat(4,1fr);margin:0;padding:0;list-style:none;border-bottom:1px solid var(--w-line);background:#090d0f}.cwiz-progress li{min-width:0;padding:12px 15px;border-right:1px solid var(--w-line);color:var(--w-muted);font-size:11px;font-weight:850}.cwiz-progress li:last-child{border-right:0}.cwiz-progress span{display:block;margin-bottom:4px;color:var(--w-teal);font:900 10px var(--mono,monospace)}
  .cwiz-outcome{margin:16px 18px 0;border:1px solid #33756d;border-left:4px solid var(--w-teal);background:#091b19;padding:12px 14px}.cwiz-outcome[data-kind="info"]{border-color:#705d32;border-left-color:var(--w-amber);background:#171308}.cwiz-outcome[data-kind="error"]{border-color:#763f3b;border-left-color:var(--w-red);background:#190d0d}.cwiz-outcome strong{display:block;font-size:13px}.cwiz-outcome p{margin:4px 0 0;color:var(--w-muted);font-size:12px;line-height:1.5}.cwiz-outcome code{display:block;margin-top:7px;color:var(--w-faint);font:750 10px var(--mono,monospace);overflow-wrap:anywhere}
  .cwiz-form{display:grid;grid-template-columns:minmax(0,1fr) minmax(285px,.38fr);align-items:start}.cwiz-main{display:grid;gap:14px;padding:18px;border-right:1px solid var(--w-line)}.cwiz-step{min-width:0;border:1px solid var(--w-line);background:var(--w-panel);padding:0}.cwiz-step>legend{margin-left:14px;padding:0 7px;color:var(--w-teal);font:900 11px var(--mono,monospace);letter-spacing:.08em;text-transform:uppercase}.cwiz-step-body{display:grid;gap:13px;padding:17px}.cwiz-two{display:grid;grid-template-columns:1fr 1fr;gap:12px}.cwiz-field{display:grid;gap:6px;color:var(--w-muted);font-size:11px;font-weight:850}.cwiz-field span{color:var(--w-faint);font-weight:600;line-height:1.45}.cwiz-field input,.cwiz-field textarea,.cwiz-field select{width:100%;min-height:46px;border:1px solid var(--w-line2);border-radius:7px;background:#090d0f;color:var(--w-ink);padding:9px 11px}.cwiz-field textarea{min-height:90px;resize:vertical;line-height:1.5}.cwiz-field input:focus,.cwiz-field textarea:focus,.cwiz-field select:focus{border-color:var(--w-teal);box-shadow:0 0 0 3px rgba(0,229,204,.13);outline:0}.cwiz-field input:focus-visible,.cwiz-field textarea:focus-visible,.cwiz-field select:focus-visible,.cwiz button:focus-visible{outline:3px solid rgba(0,229,204,.36);outline-offset:2px}
  .cwiz-option-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.cwiz-option{position:relative;display:grid;grid-template-columns:22px minmax(0,1fr);gap:9px;align-items:start;min-height:72px;border:1px solid var(--w-line2);border-radius:8px;background:#0b1012;padding:11px;color:var(--w-muted);cursor:pointer}.cwiz-option:has(input:checked){border-color:var(--w-teal);background:#08211e;box-shadow:inset 0 0 0 1px var(--w-teal)}.cwiz-option:has(input:disabled){opacity:.62;cursor:not-allowed}.cwiz-option input{width:20px;height:20px;margin:1px 0;accent-color:var(--w-teal)}.cwiz-option strong{display:block;color:var(--w-ink);font-size:12px;line-height:1.35}.cwiz-option small{display:block;margin-top:4px;color:var(--w-faint);font:700 10px/1.45 var(--mono,monospace)}.cwiz-group{border-top:1px solid var(--w-line);padding-top:13px}.cwiz-group:first-child{border-top:0;padding-top:0}.cwiz-group h3{margin-bottom:8px;font-size:12px}.cwiz-empty{border:1px dashed var(--w-line2);padding:17px;color:var(--w-muted);font-size:12px;line-height:1.55;text-align:center}
  .cwiz-review{position:sticky;top:84px;display:grid;gap:14px;padding:18px}.cwiz-review-card{border:1px solid var(--w-line);background:var(--w-panel);padding:15px}.cwiz-review-card h2{margin-bottom:9px;font-size:15px}.cwiz-review-card p{margin-bottom:0;color:var(--w-muted);font-size:11px;line-height:1.55}.cwiz-facts{display:grid;gap:8px;margin:12px 0 0}.cwiz-facts div{display:flex;justify-content:space-between;gap:12px;border-top:1px solid var(--w-line);padding-top:8px}.cwiz-facts dt{color:var(--w-faint);font-size:10px}.cwiz-facts dd{margin:0;color:var(--w-ink);font:850 10px var(--mono,monospace);text-align:right}.cwiz-confirm{display:grid;grid-template-columns:22px 1fr;gap:9px;align-items:start;color:var(--w-muted);font-size:11px;line-height:1.5}.cwiz-confirm input{width:20px;height:20px;margin:1px 0;accent-color:var(--w-teal)}.cwiz-submit{width:100%;min-height:49px;border:1px solid var(--w-teal);border-radius:7px;background:var(--w-teal);color:#03110f;font-size:12px;font-weight:950;cursor:pointer}.cwiz-submit[disabled]{border-color:var(--w-line2);background:#141b1e;color:var(--w-faint);cursor:not-allowed}.cwiz-submit-note{margin:7px 0 0;color:var(--w-faint);font-size:10px;line-height:1.5}.cwiz-truncated{margin:0;border:1px solid #6f592c;background:#171308;padding:10px 12px;color:var(--w-amber);font-size:11px;line-height:1.5}
  @media(max-width:900px){.cwiz-form{grid-template-columns:1fr}.cwiz-main{border-right:0}.cwiz-review{position:static;border-top:1px solid var(--w-line)}.cwiz-hero{grid-template-columns:1fr}.cwiz-option-list{grid-template-columns:1fr 1fr}}
  @media(max-width:580px){.cwiz-hero{padding:23px 18px}.cwiz-progress{grid-template-columns:1fr 1fr}.cwiz-progress li:nth-child(2){border-right:0}.cwiz-progress li:nth-child(n+3){border-top:1px solid var(--w-line)}.cwiz-main,.cwiz-review{padding:10px}.cwiz-two,.cwiz-option-list{grid-template-columns:1fr}.cwiz-step-body{padding:13px}.cwiz-review{top:auto}}
  @media(forced-colors:active){.cwiz,.cwiz-step,.cwiz-option,.cwiz-boundary,.cwiz-review-card{forced-color-adjust:auto}.cwiz-option:has(input:checked){border:3px solid Highlight}.cwiz-submit{border:2px solid ButtonText}}
  @media(prefers-reduced-motion:reduce){.cwiz *{scroll-behavior:auto!important;transition:none!important}}
`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export interface RenderCampaignWizardOptions {
  readonly action?: CampaignWizardCreateAction;
  readonly outcome?: CampaignWizardOperationOutcome;
  readonly companyAssetsAvailable?: boolean;
  readonly assetsLabel?: string;
  readonly brandBrainAvailable?: boolean;
  readonly brainLabel?: string;
}

function safeOutcomeText(value: string, fallback: string, maxLength: number): string {
  const clean = typeof value === 'string' ? value.trim() : '';
  return clean && clean.length <= maxLength
    && !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(clean)
    ? clean
    : fallback;
}

function outcome(view: CampaignWizardOperationOutcome | undefined): string {
  if (!view) return '';
  const title = safeOutcomeText(view.title, 'TEST planning result', 120);
  const detail = safeOutcomeText(view.detail, 'The command completed without exposing raw provider or error data.', 500);
  const intent = typeof view.intentId === 'string' && UUID.test(view.intentId)
    ? `<code>Planning intent ${escapeHtml(view.intentId)}${view.disposition ? ` · ${escapeHtml(view.disposition)}` : ''}</code>`
    : '';
  return `<aside class="cwiz-outcome" data-kind="${escapeHtml(view.kind)}" role="${view.kind === 'error' ? 'alert' : 'status'}"><strong>${escapeHtml(title)}</strong><p>${escapeHtml(detail)}</p>${intent}</aside>`;
}

function contentOption(item: CampaignWizardContentOptionView, index: number): string {
  return `<label class="cwiz-option"><input type="radio" name="content_version_id" value="${escapeHtml(item.contentVersionId)}"${index === 0 && item.eligible ? ' checked' : ''}${item.eligible ? '' : ' disabled'} required><span><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.kindLabel)} · immutable v${item.versionNumber.toLocaleString('en-GB')} · ${escapeHtml(item.shortHash)}…<br>${escapeHtml(item.gateLabel)}</small></span></label>`;
}

function mediaOption(item: CampaignWizardContentOptionView): string {
  return `<label class="cwiz-option"><input type="checkbox" name="media_version_ids" value="${escapeHtml(item.contentVersionId)}"${item.eligible ? '' : ' disabled'}><span><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.kindLabel)} · immutable v${item.versionNumber.toLocaleString('en-GB')} · ${escapeHtml(item.shortHash)}…<br>${escapeHtml(item.gateLabel)}</small></span></label>`;
}

function targetGroup(group: CampaignWizardChannelGroupView): string {
  const targets = group.targets.map((target) => `<label class="cwiz-option"><input type="checkbox" name="target_ids" value="${escapeHtml(target.targetId)}"${target.eligible ? '' : ' disabled'}><span><strong>${escapeHtml(target.targetLabel)}</strong><small>${escapeHtml(target.networkLabel)} · ${escapeHtml(target.gateLabel)}</small></span></label>`).join('');
  return `<section class="cwiz-group" aria-labelledby="cwiz-channel-${escapeHtml(group.network)}"><h3 id="cwiz-channel-${escapeHtml(group.network)}">${escapeHtml(group.label)}</h3><div class="cwiz-option-list">${targets}</div></section>`;
}

function hidden(name: string, value: string): string {
  return `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`;
}

export function renderCampaignWizardBody(
  view: CampaignWizardView,
  options: RenderCampaignWizardOptions = {},
): string {
  const actionReady = isCampaignWizardCreateActionReady(options.action);
  const eligibleContent = view.content.filter((item) => item.eligible);
  const eligibleMedia = view.media.filter((item) => item.eligible);
  const canSubmit = actionReady && view.eligibleContentCount > 0 && view.eligibleTargetCount > 0;
  const content = eligibleContent.length > 0
    ? `<div class="cwiz-option-list">${eligibleContent.map(contentOption).join('')}</div>`
    : '<p class="cwiz-empty" role="status">No exact approved, source-fresh company version is currently eligible. Nothing can be planned.</p>';
  const media = eligibleMedia.length > 0
    ? `<div class="cwiz-option-list" data-media-selection data-max-selections="10">${eligibleMedia.map(mediaOption).join('')}</div>`
    : '<p class="cwiz-empty" role="status">No separately approved artwork or media version is loaded. The campaign can continue without media.</p>';
  const channels = view.channelGroups.length > 0
    ? view.channelGroups.map(targetGroup).join('')
    : '<p class="cwiz-empty" role="status">No workspace-owned TEST target is available. Provider accounts and credentials are never exposed here.</p>';
  const protection = actionReady
    ? `${hidden('_csrf', options.action.csrfToken)}${hidden('command_key', options.action.commandKey)}${hidden('environment', 'test')}${hidden('timezone', view.timezone)}${options.action.returnTo ? hidden('return_to', options.action.returnTo) : ''}`
    : '';
  const formOpen = actionReady
    ? `<form class="cwiz-form" method="post" action="${escapeHtml(options.action.actionUrl)}" data-campaign-wizard-form>`
    : '<div class="cwiz-form" data-campaign-wizard-form data-read-only="true">';
  const formClose = actionReady ? '</form>' : '</div>';
  const truncated = view.inputTruncated
    ? '<p class="cwiz-truncated" role="status"><strong>Safe option boundary reached.</strong> More company content or TEST targets exist than this bounded wizard loaded. Nothing omitted was selected automatically.</p>'
    : '';
  const disabledNote = actionReady
    ? canSubmit
      ? 'Creates durable TEST planning evidence only. It cannot call a provider or publish.'
      : 'Exact eligible content and at least one TEST target are required.'
    : 'The router has not supplied a protected command boundary. This surface is read-only.';

  return `${renderContentWorkspaceNavigation('create', {
    companyAssetsAvailable: options.companyAssetsAvailable,
    assetsLabel: options.assetsLabel,
    brandBrainAvailable: options.brandBrainAvailable ?? false,
    brainLabel: options.brainLabel,
  })}<style data-property-predator-campaign-wizard>${CAMPAIGN_WIZARD_STYLE}</style><article class="cwiz" aria-labelledby="cwiz-title" data-campaign-wizard data-environment="test" data-provider-effects="none"><header class="cwiz-hero"><div><span class="cwiz-kicker">Growth HQ · Campaign flight plan</span><h1 id="cwiz-title">Build the rhythm. <em>Keep control.</em></h1><p>Create one auditable TEST campaign plan from approved company content. Choose the signal, the exact immutable version, separately approved artwork, the owned TEST targets and the desired rehearsal time—without exposing copy, credentials or provider effects.</p></div><aside class="cwiz-boundary" aria-label="Campaign wizard safety boundary"><strong>Durable TEST intent · zero delivery</strong><span>${escapeHtml(view.workspaceName)}</span><small>${escapeHtml(view.timezone)} workspace · snapshot ${escapeHtml(view.asOf)}. The server revalidates ownership, approval, source freshness and target eligibility.</small></aside></header><ol class="cwiz-progress" aria-label="Campaign creation steps"><li><span>01</span>Campaign brief</li><li><span>02</span>Exact content</li><li><span>03</span>Channels &amp; targets</li><li><span>04</span>Timing &amp; confirm</li></ol>${outcome(options.outcome)}${formOpen}${protection}<div class="cwiz-main"><fieldset class="cwiz-step"${actionReady ? '' : ' disabled'}><legend>01 · Define the campaign</legend><div class="cwiz-step-body"><label class="cwiz-field">Campaign name<input name="title" maxlength="160" autocomplete="off" required${actionReady ? '' : ' disabled'} placeholder="e.g. Property Predator investor sprint"><span>Operator-facing title only. It is not post copy.</span></label><label class="cwiz-field">Objective<textarea name="objective" maxlength="1000" required${actionReady ? '' : ' disabled'} placeholder="What should this TEST campaign prove?"></textarea><span>Describe the commercial outcome and audience—not a provider instruction.</span></label></div></fieldset><fieldset class="cwiz-step"${actionReady ? '' : ' disabled'}><legend>02 · Pin exact company content</legend><div class="cwiz-step-body"><div><h3>Required social-post copy</h3><p class="cwiz-submit-note">Choose one exact approved copy version. The body is reviewed server-side; this form sends only its ID.</p>${content}</div><div class="cwiz-group"><h3>Approved artwork or media · optional</h3><p class="cwiz-submit-note">Reuse up to 10 separately approved company assets. Storage keys and binary data never enter this form.</p>${media}</div></div></fieldset><fieldset class="cwiz-step"${actionReady ? '' : ' disabled'}><legend>03 · Choose TEST targets</legend><div class="cwiz-step-body">${channels}</div></fieldset><fieldset class="cwiz-step"${actionReady ? '' : ' disabled'}><legend>04 · Set the rehearsal window</legend><div class="cwiz-step-body"><div class="cwiz-two"><label class="cwiz-field">Desired TEST time<input type="datetime-local" name="desired_for_local" step="300" required${actionReady ? '' : ' disabled'}><span>${escapeHtml(view.timezone)} wall time; the server resolves the instant and rejects DST ambiguity.</span></label><label class="cwiz-field">Maximum simulator attempts<select name="max_attempts"${actionReady ? '' : ' disabled'}><option value="1" selected>1 · deliberate</option><option value="2">2 · one retry</option><option value="3">3 · maximum TEST retry</option></select><span>Applies only to the dark simulator; never to a live platform.</span></label></div>${truncated}</div></fieldset></div><aside class="cwiz-review" aria-labelledby="cwiz-review-title"><div class="cwiz-review-card"><h2 id="cwiz-review-title">Flight check</h2><p>The durable command will reference IDs and hashes. Text bodies, media storage keys, account references and secrets are not browser fields.</p><dl class="cwiz-facts"><div><dt>Eligible copy</dt><dd>${view.eligibleContentCount.toLocaleString('en-GB')}</dd></div><div><dt>Eligible media</dt><dd>${view.eligibleMediaCount.toLocaleString('en-GB')}</dd></div><div><dt>Eligible TEST targets</dt><dd>${view.eligibleTargetCount.toLocaleString('en-GB')}</dd></div><div><dt>Environment</dt><dd>TEST</dd></div><div><dt>Provider effects</dt><dd>NONE</dd></div></dl></div><label class="cwiz-confirm"><input type="checkbox" name="confirm_test_only" value="confirmed" required${actionReady ? '' : ' disabled'}><span>I understand this records a TEST planning intent. It does not schedule or publish on any external platform.</span></label><button class="cwiz-submit" type="submit"${canSubmit ? '' : ' disabled aria-disabled="true"'}>Create durable TEST campaign</button><p class="cwiz-submit-note">${escapeHtml(disabledNote)}</p><a href="${CAMPAIGN_WIZARD_ROUTE}" hidden aria-hidden="true" tabindex="-1">Reset wizard</a></aside>${formClose}</article>`;
}
