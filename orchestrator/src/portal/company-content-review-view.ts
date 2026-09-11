import type {
  CompanyContentReviewDecisionView,
  CompanyContentReviewPendingDimensionView,
  CompanyContentReviewView,
} from './company-content-review-presenter.js';
import { escapeHtml } from './ui.js';
import type { PortalCompanyContentReviewSnapshot } from './company-content-service.js';
import {
  CONTENT_APPROVAL_DECISION_ROUTE,
  CONTENT_APPROVAL_REQUEST_ROUTE,
  CONTENT_SOCIAL_REVISION_ROUTE,
  type ContentControlNoticeView,
} from './content-control-room-actions.js';
import {
  OWNED_SEED_CAMPAIGN_STAGE_ROUTE,
  OWNED_SEED_MESSAGE_APPROVAL_DECISION_ROUTE,
  OWNED_SEED_MESSAGE_APPROVAL_REQUEST_ROUTE,
  OWNED_SEED_MESSAGE_CREATE_ROUTE,
  type OwnedSeedWorkflowState,
} from './owned-seed-actions.js';
import { CONTENT_CALENDAR_ROUTE } from './content-calendar-presenter.js';

const STYLE = `
  .pcr{--pcr-bg:#050708;--pcr-panel:#0b1012;--pcr-raised:#11191c;--pcr-soft:#080c0e;--pcr-line:#253238;--pcr-strong:#3b4c53;--pcr-ink:#f5f8f7;--pcr-muted:#a5b2b4;--pcr-faint:#75858a;--pcr-teal:#00e5cc;--pcr-teal-soft:#082622;--pcr-amber:#f0b451;--pcr-amber-soft:#211707;--pcr-red:#ff746c;--pcr-red-soft:#25100f;min-width:0;overflow:hidden;border:1px solid #020303;background:var(--pcr-bg);color:var(--pcr-ink)}.pcr *{box-sizing:border-box}.pcr h1,.pcr h2,.pcr h3,.pcr p,.pcr figure{margin-top:0}.pcr a{color:inherit}.pcr code{font-family:var(--mono,monospace);font-variant-numeric:tabular-nums}.pcr :focus-visible{outline:3px solid var(--pcr-teal);outline-offset:3px}
  .pcr-top{display:flex;align-items:center;justify-content:space-between;gap:16px;min-height:58px;padding:8px 24px;border-bottom:1px solid var(--pcr-line);background:#080b0d}.pcr-back{min-height:44px;display:inline-flex;align-items:center;gap:9px;color:var(--pcr-muted);font-size:12px;font-weight:800;text-decoration:none}.pcr-back:hover{color:var(--pcr-ink)}.pcr-back span{color:var(--pcr-teal);font:900 18px var(--mono,monospace)}.pcr-lockup{display:flex;align-items:center;gap:9px;color:var(--pcr-muted);font:800 10px var(--mono,monospace);letter-spacing:.12em;text-transform:uppercase}.pcr-mark{width:30px;height:30px;display:grid;place-items:center;border:1px solid var(--pcr-teal);color:var(--pcr-teal);font-size:9px;letter-spacing:-.04em;transform:rotate(45deg)}.pcr-mark b{transform:rotate(-45deg)}
  .pcr-hero{position:relative;display:grid;grid-template-columns:minmax(0,1.4fr) minmax(280px,.58fr);gap:28px;align-items:end;padding:clamp(28px,5vw,58px);border-bottom:1px solid var(--pcr-line);background:radial-gradient(circle at 78% 0,rgba(0,229,204,.16),transparent 30%),linear-gradient(137deg,#151d20 0,#080b0c 68%)}.pcr-hero::after{content:"";position:absolute;right:8%;top:22%;width:94px;height:94px;border:1px solid rgba(0,229,204,.18);transform:rotate(45deg);pointer-events:none}.pcr-kicker{color:var(--pcr-teal);font:850 11px var(--mono,monospace);letter-spacing:.15em;text-transform:uppercase}.pcr h1{max-width:820px;margin:10px 0 15px;font-family:var(--display,Georgia,serif);font-size:clamp(2.7rem,6vw,6.1rem);font-weight:600;line-height:.82;letter-spacing:-.048em}.pcr h1 em{color:var(--pcr-teal);font-style:normal}.pcr-lead{max-width:760px;margin:0;color:var(--pcr-muted);font-size:14px;line-height:1.7}.pcr-lead strong{color:var(--pcr-ink)}
  .pcr-status{position:relative;z-index:1;border:1px solid #72542a;background:rgba(22,15,6,.82);padding:18px}.pcr-status small{display:block;color:var(--pcr-amber);font:900 10px var(--mono,monospace);letter-spacing:.13em;text-transform:uppercase}.pcr-status strong{display:block;margin:8px 0 7px;font:900 clamp(1.4rem,3vw,2rem)/1 var(--mono,monospace);text-transform:uppercase}.pcr-status span{display:block;color:#d5c2a0;font-size:11px;line-height:1.55}.pcr-status[data-state=quarantined]{border-color:#743e3b;background:rgba(31,10,9,.86)}.pcr-status[data-state=quarantined] small,.pcr-status[data-state=quarantined] strong{color:var(--pcr-red)}
  .pcr-truth{display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:16px;align-items:center;padding:14px clamp(20px,4vw,42px);border-bottom:1px solid var(--pcr-line);background:#090d0f}.pcr-truth strong{color:var(--pcr-amber);font:900 11px var(--mono,monospace);letter-spacing:.08em;text-transform:uppercase}.pcr-truth p{margin:0;color:var(--pcr-muted);font-size:12px;line-height:1.55}.pcr-effects{border:1px solid #2d756c;background:var(--pcr-teal-soft);padding:5px 9px;color:var(--pcr-teal);font:850 10px var(--mono,monospace);letter-spacing:.06em;text-transform:uppercase;white-space:nowrap}
  .pcr-layout{display:grid;grid-template-columns:minmax(0,1.45fr) minmax(310px,.55fr);gap:14px;padding:14px}.pcr-main,.pcr-side{min-width:0;display:grid;align-content:start;gap:14px}.pcr-panel{min-width:0;border:1px solid var(--pcr-line);background:var(--pcr-panel)}.pcr-panel-head{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;padding:16px 17px 13px;border-bottom:1px solid var(--pcr-line)}.pcr-panel-head h2{margin:0;font-size:16px}.pcr-panel-head p{margin:5px 0 0;color:var(--pcr-muted);font-size:11px;line-height:1.5}.pcr-chip{display:inline-flex;min-height:25px;align-items:center;border:1px solid var(--pcr-strong);padding:3px 8px;color:var(--pcr-muted);font:850 9px var(--mono,monospace);letter-spacing:.05em;text-transform:uppercase;white-space:nowrap}.pcr-chip.good{border-color:#2d756c;background:var(--pcr-teal-soft);color:var(--pcr-teal)}.pcr-chip.warn{border-color:#72542a;background:var(--pcr-amber-soft);color:var(--pcr-amber)}.pcr-chip.block{border-color:#743e3b;background:var(--pcr-red-soft);color:var(--pcr-red)}
  .pcr-content-meta{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:11px 15px;border-bottom:1px solid var(--pcr-line);background:var(--pcr-soft)}.pcr-content-meta strong{font-size:13px}.pcr-content-meta span{color:var(--pcr-faint);font:750 10px var(--mono,monospace)}.pcr-readable{padding:clamp(18px,3vw,30px)}.pcr-readable-label{display:block;margin-bottom:10px;color:var(--pcr-teal);font:850 10px var(--mono,monospace);letter-spacing:.1em;text-transform:uppercase}.pcr-body{max-height:540px;min-height:220px;margin:0;overflow:auto;overscroll-behavior:contain;border-left:3px solid var(--pcr-teal);padding:18px 20px;background:#080c0e;color:var(--pcr-ink);white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;font:500 16px/1.75 var(--sans,system-ui,sans-serif);scrollbar-color:var(--pcr-strong) #070a0b}.pcr-body code{font:inherit}.pcr-body:focus{background:#0a1012}.pcr-cta{display:grid;gap:6px;margin-top:14px;border:1px solid var(--pcr-line);background:var(--pcr-soft);padding:11px 13px}.pcr-cta strong{color:var(--pcr-faint);font:850 9px var(--mono,monospace);letter-spacing:.08em;text-transform:uppercase}.pcr-cta code{font-size:11px;overflow-wrap:anywhere}.pcr-canonical{border-top:1px solid var(--pcr-line);background:#06090a}.pcr-canonical summary{min-height:48px;display:flex;align-items:center;justify-content:space-between;gap:12px;cursor:pointer;padding:10px 15px;color:var(--pcr-muted);font-size:11px;font-weight:850;list-style:none}.pcr-canonical summary::-webkit-details-marker{display:none}.pcr-canonical summary::before{content:"+";color:var(--pcr-teal);font:900 16px var(--mono,monospace)}.pcr-canonical[open] summary::before{content:"−"}.pcr-canonical summary span{margin-left:auto;color:var(--pcr-faint);font:750 9px var(--mono,monospace);text-transform:uppercase}.pcr-copy{max-height:420px;margin:0;overflow:auto;overscroll-behavior:contain;border-top:1px solid var(--pcr-line);padding:18px;background:#050708;color:#dce8e6;white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;font:500 11px/1.7 var(--mono,monospace);scrollbar-color:var(--pcr-strong) #070a0b}.pcr-copy:focus{background:#070b0c}.pcr-copy-proof{display:flex;justify-content:space-between;gap:12px;padding:11px 15px;border-top:1px solid var(--pcr-line);color:var(--pcr-faint);font:750 10px var(--mono,monospace)}
  .pcr-art-stage{display:grid;place-items:center;min-height:420px;padding:clamp(14px,3vw,28px);background:linear-gradient(45deg,#080c0e 25%,#0b1113 25%,#0b1113 50%,#080c0e 50%,#080c0e 75%,#0b1113 75%);background-size:28px 28px}.pcr-art-stage img{display:block;max-width:100%;max-height:620px;width:auto;height:auto;object-fit:contain;border:1px solid var(--pcr-strong);background:#050708;box-shadow:0 24px 70px rgba(0,0,0,.34)}.pcr-art-caption{margin:0;padding:13px 16px;border-top:1px solid var(--pcr-line);color:var(--pcr-muted);font-size:11px;line-height:1.6}.pcr-sealed{display:flex;gap:10px;align-items:flex-start;padding:12px 16px;border-top:1px solid var(--pcr-line);background:var(--pcr-soft);color:var(--pcr-faint);font-size:10px;line-height:1.55}.pcr-sealed b{color:var(--pcr-teal);font-family:var(--mono,monospace);white-space:nowrap}
  .pcr-blocker{border-color:#72542a;background:linear-gradient(145deg,#211707,#0d0d0b 70%)}.pcr-blocker[data-state=quarantined]{border-color:#743e3b;background:linear-gradient(145deg,#25100f,#0e0b0b 70%)}.pcr-blocker-body{padding:17px}.pcr-blocker-label{display:block;margin-bottom:7px;color:var(--pcr-amber);font:900 10px var(--mono,monospace);letter-spacing:.12em;text-transform:uppercase}.pcr-blocker[data-state=quarantined] .pcr-blocker-label{color:var(--pcr-red)}.pcr-blocker-body h2{margin:0 0 9px;font:900 18px/1.2 var(--mono,monospace);text-transform:uppercase}.pcr-blocker-body p{margin:0;color:#d5c7ad;font-size:12px;line-height:1.65}
  .pcr-subhead{padding:14px 16px 10px}.pcr-subhead h2{margin:0;font-size:14px}.pcr-subhead p{margin:4px 0 0;color:var(--pcr-muted);font-size:10px;line-height:1.5}.pcr-list{list-style:none;margin:0;padding:0 14px 13px}.pcr-list li{padding:11px 2px;border-top:1px solid var(--pcr-line)}.pcr-list strong{display:block;font-size:11px}.pcr-list span{display:block;margin-top:4px;color:var(--pcr-muted);font-size:10px;line-height:1.5}.pcr-pending strong{color:var(--pcr-amber)}.pcr-complete strong{color:var(--pcr-teal)}
  .pcr-decisions{list-style:none;margin:0;padding:0}.pcr-decision{display:grid;grid-template-columns:minmax(110px,.65fr) minmax(110px,.6fr) minmax(0,1fr);gap:10px;align-items:start;padding:12px 16px;border-top:1px solid var(--pcr-line)}.pcr-decision>strong{font-size:11px}.pcr-decision>span{color:var(--pcr-muted);font-size:10px;line-height:1.45}.pcr-decision>code{color:var(--pcr-faint);font-size:9px;overflow-wrap:anywhere}.pcr-decision[data-outcome=quarantined]>strong{color:var(--pcr-red)}.pcr-decision[data-outcome=clear]>strong{color:var(--pcr-teal)}
  .pcr-proof-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;padding:13px}.pcr-proof{min-width:0;border:1px solid var(--pcr-line);background:var(--pcr-soft);padding:10px}.pcr-proof.wide{grid-column:1/-1}.pcr-proof strong{display:block;margin-bottom:6px;color:var(--pcr-faint);font:850 9px var(--mono,monospace);letter-spacing:.06em;text-transform:uppercase}.pcr-proof code,.pcr-proof time,.pcr-proof span{display:block;color:var(--pcr-ink);font-size:10px;line-height:1.55;overflow-wrap:anywhere}.pcr-proof .not-approval{color:var(--pcr-amber);font-weight:850}
  .pcr-safety{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px;padding:12px}.pcr-safety div{border:1px solid var(--pcr-line);background:var(--pcr-soft);padding:9px}.pcr-safety strong{display:block;color:var(--pcr-teal);font-size:10px}.pcr-safety span{display:block;margin-top:4px;color:var(--pcr-faint);font-size:9px;line-height:1.45}.pcr-footer{display:flex;justify-content:space-between;gap:16px;padding:13px 18px;border-top:1px solid var(--pcr-line);background:#07090a;color:var(--pcr-faint);font-size:10px}.pcr-footer strong{color:var(--pcr-muted)}
  .pcr-action-link{display:inline-flex;min-height:44px;align-items:center;justify-content:center;border:1px solid var(--pcr-teal);background:var(--pcr-teal-soft);padding:9px 14px;color:var(--pcr-teal);font-weight:850;text-decoration:none}.pcr-action-link:hover{filter:brightness(1.08)}
  html[data-theme=light] .pcr{--pcr-bg:#f4f7f6;--pcr-panel:#fff;--pcr-raised:#edf3f1;--pcr-soft:#f7faf9;--pcr-line:#d6e1de;--pcr-strong:#afc3be;--pcr-ink:#14201f;--pcr-muted:#526865;--pcr-faint:#687d79;--pcr-teal:#087f72;--pcr-teal-soft:#e1f5f1;--pcr-amber:#9a6109;--pcr-amber-soft:#fff4df;--pcr-red:#a9323a;--pcr-red-soft:#fcebed;border-color:#d6e1de}.pcr[data-theme=light]{}
  html[data-theme=light] .pcr-top,html[data-theme=light] .pcr-truth,html[data-theme=light] .pcr-footer{background:#fff}html[data-theme=light] .pcr-hero{background:radial-gradient(circle at 78% 0,rgba(8,127,114,.12),transparent 31%),linear-gradient(137deg,#edf5f3 0,#fff 68%)}html[data-theme=light] .pcr-status{border-color:#d7b879;background:#fff7e8}html[data-theme=light] .pcr-status span{color:#68563b}html[data-theme=light] .pcr-body,html[data-theme=light] .pcr-copy{background:#f7faf9;color:#14201f;scrollbar-color:#afc3be #edf3f1}html[data-theme=light] .pcr-body:focus,html[data-theme=light] .pcr-copy:focus{background:#eef5f3}html[data-theme=light] .pcr-canonical{background:#f7faf9}
  @media(prefers-color-scheme:light){html[data-theme=system] .pcr{--pcr-bg:#f4f7f6;--pcr-panel:#fff;--pcr-raised:#edf3f1;--pcr-soft:#f7faf9;--pcr-line:#d6e1de;--pcr-strong:#afc3be;--pcr-ink:#14201f;--pcr-muted:#526865;--pcr-faint:#687d79;--pcr-teal:#087f72;--pcr-teal-soft:#e1f5f1;--pcr-amber:#9a6109;--pcr-amber-soft:#fff4df;--pcr-red:#a9323a;--pcr-red-soft:#fcebed;border-color:#d6e1de}html[data-theme=system] .pcr-top,html[data-theme=system] .pcr-truth,html[data-theme=system] .pcr-footer{background:#fff}html[data-theme=system] .pcr-hero{background:radial-gradient(circle at 78% 0,rgba(8,127,114,.12),transparent 31%),linear-gradient(137deg,#edf5f3 0,#fff 68%)}html[data-theme=system] .pcr-status{border-color:#d7b879;background:#fff7e8}html[data-theme=system] .pcr-status span{color:#68563b}html[data-theme=system] .pcr-body,html[data-theme=system] .pcr-copy{background:#f7faf9;color:#14201f}html[data-theme=system] .pcr-canonical{background:#f7faf9}}
  @media(max-width:1050px){.pcr-hero,.pcr-layout{grid-template-columns:1fr}.pcr-side{grid-template-columns:repeat(2,minmax(0,1fr))}.pcr-side .pcr-blocker,.pcr-side .pcr-pending-panel{grid-column:auto}.pcr-side .pcr-proof-panel,.pcr-side .pcr-safety-panel{grid-column:1/-1}}
  @media(max-width:720px){.pcr-top{padding-inline:15px}.pcr-lockup>span:last-child{display:none}.pcr-hero{padding:30px 20px}.pcr h1{font-size:clamp(2.6rem,14vw,4.5rem)}.pcr-truth{grid-template-columns:1fr;padding:14px 20px}.pcr-effects{justify-self:start}.pcr-layout{padding:8px}.pcr-side{grid-template-columns:1fr}.pcr-side .pcr-proof-panel,.pcr-side .pcr-safety-panel{grid-column:auto}.pcr-panel-head{display:grid}.pcr-chip{justify-self:start}.pcr-decision{grid-template-columns:1fr}.pcr-art-stage{min-height:280px}.pcr-footer{flex-direction:column}}
  @media(max-width:450px){.pcr-proof-grid,.pcr-safety{grid-template-columns:1fr}.pcr-proof.wide{grid-column:auto}.pcr-copy{padding:14px;font-size:11px}.pcr-copy-proof{flex-direction:column}.pcr-top{align-items:flex-start}.pcr-back{max-width:210px}.pcr-mark{margin-top:7px}}
  @media(prefers-reduced-motion:reduce){.pcr *,.pcr *::before,.pcr *::after{scroll-behavior:auto!important;transition:none!important;animation:none!important}.pcr-mark{transform:none}.pcr-mark b{transform:none}}
  @media(forced-colors:active){.pcr,.pcr-panel,.pcr-status,.pcr-chip,.pcr-proof,.pcr-safety div,.pcr-art-stage img{forced-color-adjust:auto;border-color:CanvasText}.pcr-effects,.pcr-chip.good{border:2px solid Highlight}.pcr-status,.pcr-chip.warn,.pcr-blocker{border:2px solid Mark}.pcr-status[data-state=quarantined],.pcr-chip.block,.pcr-blocker[data-state=quarantined]{border:3px double CanvasText}.pcr-mark{transform:none}.pcr-mark b{transform:none}}
`;

export interface RenderPortalCompanyContentReviewOptions {
  readonly notice?: ContentControlNoticeView;
  readonly security?: Readonly<{
    readonly csrfToken: string;
    readonly requestCommandKey?: string;
    readonly decisionCommandKey?: string;
    readonly exactApprovalToken?: string;
    readonly revisionCommandKey?: string;
    readonly exactRevisionToken?: string;
    readonly ownedSeedAvailable?: boolean;
    readonly ownedSeedStageAvailable?: boolean;
    readonly ownedSeedWorkflow?: OwnedSeedWorkflowState;
    readonly ownedSeedWorkflowToken?: string;
    readonly ownedSeedCommandKey?: string;
    readonly ownedSeedRunId?: string;
  }>;
}

function exactReviewNotice(notice: ContentControlNoticeView | undefined): string {
  if (!notice) return '';
  return `<section class="pcr-status" role="status" style="margin:14px" data-state="${notice.kind === 'error' ? 'quarantined' : 'pending'}"><small>${escapeHtml(notice.kind)}</small><strong>${escapeHtml(notice.title)}</strong><span>${escapeHtml(notice.message)}</span></section>`;
}

function validProtectedValue(value: string | undefined): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{20,512}$/u.test(value);
}

function validCommandKey(value: string | undefined): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u.test(value);
}

function validExactApprovalToken(value: string | undefined): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._-]{20,768}$/u.test(value);
}

function validOwnedSeedWorkflowToken(value: string | undefined): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{20,1800}\.[A-Za-z0-9_-]{20,128}$/u.test(value);
}

function validUuid(value: string | undefined): value is string {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value);
}

function socialRevisionActions(
  snapshot: PortalCompanyContentReviewSnapshot,
  options: RenderPortalCompanyContentReviewOptions,
): string {
  const review = snapshot.review;
  const social = review.social;
  const security = options.security;
  if (!social || !review.isLatest || review.approvalStale || !snapshot.workspace.canWrite
      || !validProtectedValue(security?.csrfToken)
      || !validCommandKey(security?.revisionCommandKey)
      || !validExactApprovalToken(security?.exactRevisionToken)) return '';
  return `<details class="pcr-panel" id="edit-version"><summary class="pcr-panel-head"><span><strong>Edit post</strong><small style="display:block;margin-top:5px;color:var(--pcr-muted)">Your previous copy stays in your history.</small></span><span aria-hidden="true">⌄</span></summary><form class="pcr-readable" method="post" action="${CONTENT_SOCIAL_REVISION_ROUTE}"><input type="hidden" name="_csrf" value="${escapeHtml(security.csrfToken)}"><input type="hidden" name="command_key" value="${escapeHtml(security.revisionCommandKey)}"><input type="hidden" name="content_item_id" value="${escapeHtml(review.contentItemId)}"><input type="hidden" name="previous_version_id" value="${escapeHtml(review.contentVersionId)}"><input type="hidden" name="expected_content_sha256" value="${escapeHtml(review.contentSha256)}"><input type="hidden" name="exact_revision_token" value="${escapeHtml(security.exactRevisionToken)}"><input type="hidden" name="return_exact_item_id" value="${escapeHtml(review.contentItemId)}"><input type="hidden" name="return_exact_version_id" value="${escapeHtml(review.contentVersionId)}"><label class="pcr-readable-label" for="pcr-publication-copy">Post text</label><textarea class="pcr-body" style="width:100%" id="pcr-publication-copy" name="publication_copy" maxlength="900000" required>${escapeHtml(social.publicationCopy)}</textarea><label class="pcr-readable-label" style="margin-top:22px" for="pcr-artwork-instructions">Image or video notes</label><textarea class="pcr-body" style="width:100%;min-height:150px" id="pcr-artwork-instructions" name="artwork_instructions" maxlength="50000" placeholder="Describe the image or video separately from the words people will read.">${escapeHtml(social.artworkInstructions ?? '')}</textarea><button class="pcr-action-link" style="margin-top:14px" type="submit">Save changes</button><p style="margin:10px 0 0;color:var(--pcr-muted);font-size:11px">Saved changes will need approval before use.</p></form></details>`;
}

function exactReviewActions(
  snapshot: PortalCompanyContentReviewSnapshot,
  options: RenderPortalCompanyContentReviewOptions,
): string {
  const review = snapshot.review;
  const security = options.security;
  if (!snapshot.workspace.canWrite || !validProtectedValue(security?.csrfToken)) {
    return '<section class="pcr-panel"><header class="pcr-subhead"><h2>Approval</h2><p>You can read this post. Ask a workspace editor to make changes.</p></header></section>';
  }
  if (!review.isLatest || review.approvalStale) {
    return '<section class="pcr-panel"><header class="pcr-subhead"><h2>Older version</h2><p>A newer version exists. Return to your content and open the latest copy.</p></header></section>';
  }
  const returnFields = `<input type="hidden" name="return_exact_item_id" value="${escapeHtml(review.contentItemId)}"><input type="hidden" name="return_exact_version_id" value="${escapeHtml(review.contentVersionId)}">`;
  if (review.approvalStatus === 'pending' && review.approvalRequestId) {
    if (!snapshot.workspace.canManage || !validCommandKey(security?.decisionCommandKey)
        || !validExactApprovalToken(security?.exactApprovalToken)) {
      return '<section class="pcr-panel"><header class="pcr-subhead"><h2>Waiting for a reviewer</h2><p>A workspace owner or admin can approve this post.</p></header></section>';
    }
    return `<section class="pcr-panel"><header class="pcr-subhead"><h2>Ready to approve?</h2><p>Check the wording above, then approve it or ask for changes. Approval does not publish it.</p></header><form class="pcr-readable" method="post" action="${CONTENT_APPROVAL_DECISION_ROUTE}"><input type="hidden" name="_csrf" value="${escapeHtml(security.csrfToken)}"><input type="hidden" name="command_key" value="${escapeHtml(security.decisionCommandKey)}"><input type="hidden" name="approval_request_id" value="${escapeHtml(review.approvalRequestId)}"><input type="hidden" name="review_content_item_id" value="${escapeHtml(review.contentItemId)}"><input type="hidden" name="review_content_version_id" value="${escapeHtml(review.contentVersionId)}"><input type="hidden" name="review_content_sha256" value="${escapeHtml(review.contentSha256)}"><input type="hidden" name="exact_approval_token" value="${escapeHtml(security.exactApprovalToken)}">${returnFields}<label class="pcr-readable-label" for="pcr-decision-note">Review note</label><textarea class="pcr-body" style="min-height:120px;max-height:220px;width:100%" id="pcr-decision-note" name="decision_note" maxlength="4000" placeholder="Add a note. If asking for changes or rejecting, explain why."></textarea><div style="display:flex;flex-wrap:wrap;gap:9px;margin-top:12px"><button class="pcr-chip good" type="submit" name="decision" value="approved">Approve post</button><button class="pcr-chip warn" type="submit" name="decision" value="changes_requested">Request changes</button><button class="pcr-chip block" type="submit" name="decision" value="rejected">Reject</button></div></form></section>`;
  }
  if (['unrequested', 'rejected', 'changes_requested'].includes(review.approvalStatus)
      && validCommandKey(security?.requestCommandKey)) {
    return `<section class="pcr-panel"><header class="pcr-subhead"><h2>Send for approval</h2><p>Happy with the wording? Send this version for review.</p></header><form class="pcr-readable" method="post" action="${CONTENT_APPROVAL_REQUEST_ROUTE}"><input type="hidden" name="_csrf" value="${escapeHtml(security.csrfToken)}"><input type="hidden" name="command_key" value="${escapeHtml(security.requestCommandKey)}"><input type="hidden" name="content_item_id" value="${escapeHtml(review.contentItemId)}"><input type="hidden" name="content_version_id" value="${escapeHtml(review.contentVersionId)}">${returnFields}<details class="pcr-notes"><summary>Add a note for the reviewer (optional)</summary><label class="pcr-readable-label" for="pcr-review-note">Your note</label><textarea class="pcr-body" style="min-height:100px;max-height:200px;width:100%" id="pcr-review-note" name="review_note" maxlength="2000" placeholder="Anything the reviewer should know?"></textarea></details><button class="pcr-chip good" style="margin-top:12px" type="submit">Send for approval</button></form></section>`;
  }
  return `<section class="pcr-panel"><header class="pcr-subhead"><h2>Approval</h2><p>${review.approvalStatus === 'approved' ? 'This version is approved. Nothing has been published.' : 'Reload this post to see its latest status.'}</p></header></section>`;
}

function ownedSeedWorkflowActions(
  snapshot: PortalCompanyContentReviewSnapshot,
  options: RenderPortalCompanyContentReviewOptions,
): string {
  const review = snapshot.review;
  const security = options.security;
  if (!security?.ownedSeedAvailable || review.approvalStatus !== 'approved'
      || review.approvalStale || !review.isLatest || !review.email) return '';

  const workflow = security.ownedSeedWorkflow;
  const workflowMatchesReview = !workflow
    || workflow.companyContentVersionId === review.contentVersionId;
  if (!workflowMatchesReview) {
    return '<section class="pcr-panel"><header class="pcr-subhead"><h2>Owned-seed proof · refresh required</h2><p>The signed workflow state belongs to a different immutable company-content version. No action is available from this page.</p></header></section>';
  }
  if (!snapshot.workspace.canManage || !validProtectedValue(security.csrfToken)
      || !validCommandKey(security.ownedSeedCommandKey)) {
    return '<section class="pcr-panel"><header class="pcr-subhead"><h2>Owned-seed proof · inspect only</h2><p>The exact email is approved, but this workspace role cannot advance the internal proof workflow.</p></header></section>';
  }

  const common = `<input type="hidden" name="_csrf" value="${escapeHtml(security.csrfToken)}"><input type="hidden" name="command_key" value="${escapeHtml(security.ownedSeedCommandKey)}"><input type="hidden" name="return_exact_item_id" value="${escapeHtml(review.contentItemId)}"><input type="hidden" name="return_exact_version_id" value="${escapeHtml(review.contentVersionId)}">`;
  const boundary = '<p><strong>Controlled live boundary:</strong> the first three steps record internal evidence only. The final stage button creates one LIVE delivery intent; an enabled worker may call Mailgun. The job remains constrained to <code>office@propertypredator.com</code>, one message per run and three per month.</p>';

  if (!workflow) {
    return `<section class="pcr-panel" aria-labelledby="pcr-owned-seed-title"><header class="pcr-panel-head"><div><h2 id="pcr-owned-seed-title">Owned-seed delivery proof</h2><p>Turn this approved company-content version into a separate immutable LIVE message draft.</p></div><span class="pcr-chip warn">Step 1 of 4</span></header><div class="pcr-readable">${boundary}<form method="post" action="${OWNED_SEED_MESSAGE_CREATE_ROUTE}">${common}<input type="hidden" name="company_content_version_id" value="${escapeHtml(review.contentVersionId)}"><button class="pcr-chip good" type="submit">Create LIVE message draft</button></form></div></section>`;
  }

  if (!validOwnedSeedWorkflowToken(security.ownedSeedWorkflowToken)) {
    return '<section class="pcr-panel"><header class="pcr-subhead"><h2>Owned-seed proof · signed state required</h2><p>The internal message exists, but its short-lived session-bound workflow token is missing or invalid. Refresh before advancing it.</p></header></section>';
  }
  const signed = `${common}<input type="hidden" name="owned_seed_workflow_token" value="${escapeHtml(security.ownedSeedWorkflowToken)}"><input type="hidden" name="message_id" value="${escapeHtml(workflow.messageId)}"><input type="hidden" name="message_version_id" value="${escapeHtml(workflow.messageVersionId)}">`;

  if (workflow.phase === 'drafted') {
    return `<section class="pcr-panel" aria-labelledby="pcr-owned-seed-title"><header class="pcr-panel-head"><div><h2 id="pcr-owned-seed-title">Approve the LIVE message</h2><p>The message is a separate immutable delivery object. It needs its own human approval.</p></div><span class="pcr-chip warn">Step 2 of 4</span></header><form class="pcr-readable" method="post" action="${OWNED_SEED_MESSAGE_APPROVAL_REQUEST_ROUTE}">${signed}${boundary}<label class="pcr-readable-label" for="pcr-owned-seed-review-note">Message review brief</label><textarea class="pcr-body" style="min-height:100px;max-height:200px;width:100%" id="pcr-owned-seed-review-note" name="review_note" maxlength="2000" placeholder="Confirm the owned office-only recipient, exact subject and exact body."></textarea><button class="pcr-chip good" style="margin-top:12px" type="submit">Request message approval</button></form></section>`;
  }

  if (workflow.phase === 'approval_pending') {
    if (!snapshot.workspace.canManage || !workflow.approvalRequestId) {
      return '<section class="pcr-panel"><header class="pcr-subhead"><h2>Message approval pending</h2><p>An owner or admin must decide this exact LIVE message version.</p></header></section>';
    }
    return `<section class="pcr-panel" aria-labelledby="pcr-owned-seed-title"><header class="pcr-panel-head"><div><h2 id="pcr-owned-seed-title">Decide the LIVE message</h2><p>This decision is distinct from the company-content approval above.</p></div><span class="pcr-chip warn">Step 3 of 4</span></header><form class="pcr-readable" method="post" action="${OWNED_SEED_MESSAGE_APPROVAL_DECISION_ROUTE}">${signed}<input type="hidden" name="approval_request_id" value="${escapeHtml(workflow.approvalRequestId)}">${boundary}<label class="pcr-readable-label" for="pcr-owned-seed-decision-note">Review note</label><textarea class="pcr-body" style="min-height:100px;max-height:200px;width:100%" id="pcr-owned-seed-decision-note" name="decision_note" maxlength="4000" placeholder="Record why this exact LIVE message is approved, rejected or changing."></textarea><div style="display:flex;flex-wrap:wrap;gap:9px;margin-top:12px"><button class="pcr-chip good" type="submit" name="decision" value="approved">Approve LIVE message</button><button class="pcr-chip warn" type="submit" name="decision" value="changes_requested">Request changes</button><button class="pcr-chip block" type="submit" name="decision" value="rejected">Reject message</button></div></form></section>`;
  }

  if (workflow.phase === 'approved') {
    if (!security.ownedSeedStageAvailable || !snapshot.workspace.canManage
        || !validUuid(security.ownedSeedRunId)) {
      return `<section class="pcr-panel"><header class="pcr-subhead"><h2>LIVE message approved</h2><p>The separate message approval is complete. The capped office-only staging rail is not available to this role or environment. No provider call has occurred.</p></header></section>`;
    }
    return `<section class="pcr-panel" aria-labelledby="pcr-owned-seed-title"><header class="pcr-panel-head"><div><h2 id="pcr-owned-seed-title">Stage the office-only proof</h2><p>Resolve the fixed owned recipient and stage one capped delivery job for the existing worker gate.</p></div><span class="pcr-chip good">Step 4 of 4</span></header><form class="pcr-readable" method="post" action="${OWNED_SEED_CAMPAIGN_STAGE_ROUTE}">${signed}<input type="hidden" name="run_id" value="${escapeHtml(security.ownedSeedRunId)}">${boundary}<button class="pcr-chip good" type="submit">Stage capped office-only job</button></form></section>`;
  }

  const label = workflow.phase === 'staged' ? 'Owned-seed job staged' : 'Owned-seed proof blocked';
  const copy = workflow.phase === 'staged'
    ? 'The capped LIVE job is queued for the worker boundary. Delivery may already have been attempted; use the signed receipt ledger for current provider truth.'
    : 'The server blocked this workflow state. Refresh the exact review and resolve the recorded reason before trying again.';
  return `<section class="pcr-panel"><header class="pcr-subhead"><h2>${label}</h2><p>${copy}</p></header></section>`;
}

function time(value: string): string {
  const date = new Date(value);
  const label = new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  }).format(date);
  return `<time datetime="${escapeHtml(date.toISOString())}">${escapeHtml(label)} UTC</time>`;
}

function bytes(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) return '0 bytes';
  if (value < 1_024) return `${value.toLocaleString('en-GB')} bytes`;
  if (value < 1_048_576) return `${(value / 1_024).toFixed(1)} KiB`;
  return `${(value / 1_048_576).toFixed(1)} MiB`;
}

function pending(view: CompanyContentReviewPendingDimensionView): string {
  return `<li><strong>${escapeHtml(view.dimensionLabel)} · pending</strong><span>${escapeHtml(view.explanation)}</span></li>`;
}

function decision(view: CompanyContentReviewDecisionView): string {
  return `<li class="pcr-decision" data-outcome="${escapeHtml(view.outcome)}"><strong>${escapeHtml(view.dimensionLabel)} · ${escapeHtml(view.outcomeLabel)}</strong><span>${escapeHtml(view.reasonLabel)}<br>${time(view.recordedAt)}</span><code title="Decision evidence SHA-256">${escapeHtml(view.evidenceSha256)}</code></li>`;
}

function proof(label: string, value: string, wide = false): string {
  return `<div class="pcr-proof${wide ? ' wide' : ''}"><strong>${escapeHtml(label)}</strong><code>${escapeHtml(value)}</code></div>`;
}

function exactContentPanel(view: CompanyContentReviewView): string {
  const content = view.exactContent;
  if (content.canonicalContent !== null && content.canonicalByteLength !== null) {
    const readableBody = content.readableBody ?? '';
    const cta = content.ctaUrl
      ? `<div class="pcr-cta"><strong>Call-to-action destination · shown as evidence only</strong><code>${escapeHtml(content.ctaUrl)}</code></div>`
      : '';
    return `<section class="pcr-panel" aria-labelledby="pcr-content-title"><header class="pcr-panel-head"><div><h2 id="pcr-content-title">Actual reviewed copy</h2><p>The exact human-readable body from the safe review payload, with whitespace preserved.</p></div><span class="pcr-chip good">Verified exact copy</span></header><div class="pcr-content-meta"><strong>${escapeHtml(content.title)}</strong><span>${escapeHtml(content.contextLabel)}</span></div><div class="pcr-readable"><span class="pcr-readable-label">Content body</span><pre class="pcr-body" tabindex="0" aria-label="Exact human-readable company content"><code>${escapeHtml(readableBody)}</code></pre>${cta}</div><details class="pcr-canonical"><summary>Canonical JSON hash evidence <span>${escapeHtml(bytes(content.canonicalByteLength))} · SHA-256 verified</span></summary><pre class="pcr-copy" tabindex="0" aria-label="Exact canonical company content"><code>${escapeHtml(content.canonicalContent)}</code></pre><footer class="pcr-copy-proof"><span>${escapeHtml(content.mediaType)} · ${escapeHtml(bytes(content.canonicalByteLength))} UTF-8</span><span>Complete bounded representation</span></footer></details></section>`;
  }
  const artwork = view.artwork;
  if (!artwork) return '';
  const caption = content.caption
    ? escapeHtml(content.caption)
    : 'No public-facing caption is attached to this exact artwork version.';
  return `<section class="pcr-panel" aria-labelledby="pcr-content-title"><header class="pcr-panel-head"><div><h2 id="pcr-content-title">Verified artwork preview</h2><p>The image response is bound to this item, byte count and immutable blob digest.</p></div><span class="pcr-chip good">${escapeHtml(artwork.verificationLabel)}</span></header><div class="pcr-content-meta"><strong>${escapeHtml(content.title)}</strong><span>${escapeHtml(content.contextLabel)} · ${escapeHtml(artwork.mediaType)}</span></div><figure><div class="pcr-art-stage"><img src="${escapeHtml(artwork.fileHref)}" alt="Verified Property Predator artwork preview for ${escapeHtml(content.title)}" loading="eager" decoding="async" referrerpolicy="no-referrer"></div><figcaption class="pcr-art-caption">${caption}</figcaption></figure><div class="pcr-sealed"><b>Exact asset boundary</b><span>Text metadata that could disclose a file name is deliberately not reproduced. The preview is verified against ${escapeHtml(bytes(artwork.expectedByteLength))} and the blob SHA-256 shown below.</span></div></section>`;
}

export function renderCompanyContentReviewBody(view: CompanyContentReviewView): string {
  const pendingItems = view.item.pendingDimensions.length
    ? view.item.pendingDimensions.map(pending).join('')
    : '<li class="pcr-complete"><strong>No evidence dimensions pending</strong><span>This does not create Growth HQ approval. The exact item remains review required.</span></li>';
  const decisionItems = view.item.decisions.length
    ? view.item.decisions.map(decision).join('')
    : '<li class="pcr-decision"><strong>No decisions recorded</strong><span>Every evidence dimension remains pending.</span><code>Evidence unavailable</code></li>';
  const artworkProof = view.artwork
    ? `${proof('Artwork blob SHA-256', view.artwork.blobSha256, true)}${proof('Expected artwork size', bytes(view.artwork.expectedByteLength))}${proof('Artwork response', view.artwork.verificationLabel)}`
    : '';
  return `<style data-property-predator-company-content-review>${STYLE}</style><article class="pcr" aria-labelledby="pcr-title"><header class="pcr-top"><a class="pcr-back" href="/portal/content/assets"><span aria-hidden="true">←</span> Back to Company Assets</a><div class="pcr-lockup"><span class="pcr-mark" aria-hidden="true"><b>PP</b></span><span>Property Predator · Growth HQ</span></div></header><section class="pcr-hero"><div><div class="pcr-kicker">Exact-content evidence room · immutable v${view.item.itemVersion.toLocaleString('en-GB')}</div><h1 id="pcr-title">Inspect the exact.<br><em>Keep authority honest.</em></h1><p class="pcr-lead"><strong>${escapeHtml(view.exactContent.title)}</strong> is shown at the verified response boundary. Review the complete copy or artwork, evidence decisions and exact hashes without granting permission or triggering an outside system.</p></div><aside class="pcr-status" data-state="${escapeHtml(view.item.state)}" aria-label="Growth HQ use status"><small>Growth HQ use status</small><strong>${escapeHtml(view.item.hqUseLabel)}</strong><span>${escapeHtml(view.item.stateLabel)}. This read-only page cannot clear, approve or distribute the item.</span></aside></section><section class="pcr-truth" aria-label="Approval boundary"><strong>Source provenance ≠ HQ approval</strong><p>The source record identifies an exact upstream version. It is evidence of provenance only—not permission from Growth HQ to use this content.</p><span class="pcr-effects">Provider effects off</span></section><div class="pcr-layout"><div class="pcr-main">${exactContentPanel(view)}<section class="pcr-panel" aria-labelledby="pcr-decisions-title"><header class="pcr-panel-head"><div><h2 id="pcr-decisions-title">Recorded evidence decisions</h2><p>Each decision is bound to its own immutable evidence digest.</p></div><span class="pcr-chip ${view.item.quarantined ? 'block' : view.item.decisions.length === 3 ? 'good' : 'warn'}">${view.item.decisions.length.toLocaleString('en-GB')} of 3 recorded</span></header><ul class="pcr-decisions">${decisionItems}</ul></section></div><aside class="pcr-side" aria-label="Review evidence and blockers"><section class="pcr-panel pcr-blocker" data-state="${escapeHtml(view.item.state)}"><div class="pcr-blocker-body"><span class="pcr-blocker-label">Why this item is blocked</span><h2>${escapeHtml(view.item.stateLabel)}</h2><p>${escapeHtml(view.item.whyBlocked)}</p></div></section><section class="pcr-panel pcr-pending-panel" aria-labelledby="pcr-pending-title"><header class="pcr-subhead"><h2 id="pcr-pending-title">Pending dimensions</h2><p>Missing evidence remains blocking; silence never means clear.</p></header><ul class="pcr-list pcr-pending">${pendingItems}</ul></section><section class="pcr-panel pcr-proof-panel" aria-labelledby="pcr-proof-title"><header class="pcr-subhead"><h2 id="pcr-proof-title">Exact identity &amp; hash proof</h2><p>Immutable identifiers for the version visible on this page.</p></header><div class="pcr-proof-grid">${proof('Release item', view.item.releaseItemId, true)}${proof('Source release', view.item.sourceReleaseId)}${proof('Source version', view.item.sourceVersionId)}${proof('Source item', `${view.item.itemType}:${view.item.itemId}`)}${proof('Content SHA-256', view.item.contentSha256, true)}${artworkProof}${proof('Runtime brand SHA-256', view.item.brandSha256, true)}<div class="pcr-proof"><strong>Source provenance ID</strong><code>${escapeHtml(view.item.sourceApproval.approvalId)}</code></div><div class="pcr-proof"><strong>Source recorded</strong>${time(view.item.sourceApproval.approvedAt)}</div><div class="pcr-proof wide"><strong>Authority meaning</strong><span>${escapeHtml(view.item.sourceApproval.provenanceLabel)}</span><span class="not-approval">${escapeHtml(view.item.sourceApproval.hqMeaningLabel)}</span></div></div></section><section class="pcr-panel pcr-safety-panel" aria-labelledby="pcr-safety-title"><header class="pcr-subhead"><h2 id="pcr-safety-title">Sealed safety boundary</h2><p>All four claims are asserted false by the verified review response.</p></header><div class="pcr-safety"><div><strong>Effects off</strong><span>No provider operation</span></div><div><strong>Private data rejected</strong><span>Customer-private input not accepted</span></div><div><strong>Affiliate copy rejected</strong><span>Affiliate content not accepted</span></div><div><strong>Authority separated</strong><span>Source record not promoted</span></div></div></section></aside></div><footer class="pcr-footer"><span><strong>${escapeHtml(view.workspace.name)}</strong> · snapshot ${time(view.workspace.snapshotAt)}</span><span>Read-only evidence · exact version · HQ use review required</span></footer></article>`;
}

/**
 * Authenticated review body for versions stored in Growth HQ's immutable
 * company-content ledger. It renders the exact subject/body and the digest
 * evidence together; it contains no send, schedule or provider controls.
 */

export function renderPortalCompanyContentReviewBody(
  snapshot: PortalCompanyContentReviewSnapshot,
  options: RenderPortalCompanyContentReviewOptions = {},
): string {
  const review = snapshot.review;
  const email = review.email;
  const social = review.social;
  const labels: Record<string, string> = { unrequested: 'Draft', pending: 'Awaiting approval',
    approved: 'Approved', rejected: 'Not approved', changes_requested: 'Changes requested', stale: 'Needs a new review' };
  const status = !review.isLatest || review.approvalStale ? 'Older version' : labels[review.approvalStatus] ?? 'Needs attention';
  const exactCopy = email
    ? `<section class="pcr-panel"><header class="pcr-panel-head"><h2>Email preview</h2></header><div class="pcr-readable"><span class="pcr-readable-label">Subject</span><div class="pcr-post-text">${escapeHtml(email.subject)}</div><span class="pcr-readable-label">Message</span><div class="pcr-post-text">${escapeHtml(email.bodyText)}</div></div></section>`
    : social
      ? `<section class="pcr-panel" aria-labelledby="pcr-social-title"><header class="pcr-panel-head"><h2 id="pcr-social-title">Your post</h2><span class="pcr-channel">${escapeHtml(social.platform)}</span></header><div class="pcr-readable"><div class="pcr-post-text">${escapeHtml(social.publicationCopy)}</div>${social.legacyCombined ? '<p class="pcr-help">This older draft may include image notes in the post text. Use Edit post to separate them before approval.</p>' : ''}${social.artworkInstructions ? `<details class="pcr-notes"><summary>Image or video notes</summary><div class="pcr-post-text">${escapeHtml(social.artworkInstructions)}</div><p class="pcr-help">These are instructions, not an attached image. They are included in your review.</p></details>` : ''}${social.ctaUrl ? `<div class="pcr-cta"><strong>Link in this post</strong><span>${escapeHtml(social.ctaUrl)}</span></div>` : ''}</div></section>`
      : `<section class="pcr-panel"><header class="pcr-panel-head"><h2>Content preview</h2></header><div class="pcr-readable"><div class="pcr-post-text">${escapeHtml(review.canonicalContent)}</div></div></section>`;
  const planAction = social && review.isLatest && !review.approvalStale && review.approvalStatus === 'approved'
    ? `<section class="pcr-panel"><header class="pcr-subhead"><h2>Next: plan your post</h2><p>Your wording is approved. Check that it is ready for scheduling in your library, then choose a date in Calendar.</p></header><div class="pcr-readable"><a class="pcr-action-link" href="/portal/content">Check in my library</a> <a class="pcr-back" href="${CONTENT_CALENDAR_ROUTE}?content_version=${encodeURIComponent(review.contentVersionId)}#new-plan">Open calendar →</a></div></section>` : '';
  const evidence = `<details class="pcr-panel pcr-canonical"><summary>Technical details &amp; history</summary><div class="pcr-proof-grid">${proof('Version', String(review.versionNumber))}${proof('Content item', review.contentItemId, true)}${proof('Content version', review.contentVersionId, true)}${proof('Content SHA-256', review.contentSha256, true)}${email ? `${proof('Subject SHA-256', email.subjectSha256, true)}${proof('Body SHA-256', email.bodySha256, true)}` : ''}${social ? `${proof('Post SHA-256', social.publicationCopySha256, true)}${proof('Image notes SHA-256', social.artworkInstructionsSha256 ?? 'No image notes', true)}` : ''}${proof('Brand SHA-256', review.brandSha256, true)}${proof('Blob SHA-256', review.blobSha256, true)}${proof('Source system', review.source.system)}${proof('Source item', review.source.itemId)}${proof('Source version', review.source.version)}${proof('MIME type', review.contentMimeType, true)}${proof('Request ID', review.approvalRequestId ?? 'Not requested', true)}${proof('Decision ID', review.approvalDecisionId ?? 'No decision', true)}${proof('Content size', bytes(review.canonicalByteLength))}</div><details class="pcr-notes"><summary>Stored content</summary><pre class="pcr-copy" tabindex="0"><code>${escapeHtml(review.canonicalContent)}</code></pre></details></details>`;
  const simplifiedStyle = `
    .pcr-simple{max-width:1000px;margin-inline:auto}.pcr-simple .pcr-hero{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;padding:24px;background:var(--pcr-panel)}.pcr-simple .pcr-hero h1{font-size:30px;line-height:1.2;margin:0 0 8px}.pcr-simple .pcr-lead{font-size:15px;line-height:1.6;max-width:650px}.pcr-simple .pcr-layout{display:block;padding:16px}.pcr-simple .pcr-main{display:grid;gap:16px}.pcr-simple .pcr-readable{padding:24px}.pcr-simple .pcr-post-text{white-space:pre-wrap;overflow-wrap:anywhere;font:400 17px/1.8 var(--sans,system-ui);color:var(--pcr-ink);padding:4px 0 18px;max-height:none}.pcr-simple .pcr-body{font-family:var(--sans,system-ui);font-size:16px;line-height:1.7}.pcr-simple .pcr-panel-head h2,.pcr-simple .pcr-subhead h2{font-size:19px}.pcr-simple .pcr-subhead p,.pcr-simple .pcr-panel-head p{font-size:15px;line-height:1.6}.pcr-simple .pcr-hero::after{display:none}.pcr-simple #edit-version summary small{font-size:14px}.pcr-simple #edit-version form>p{font-size:14px!important}.pcr-simple .pcr-channel{font-size:14px;color:var(--pcr-muted)}.pcr-simple .pcr-notes{padding:12px 0}.pcr-simple summary{cursor:pointer;min-height:44px;font-family:var(--sans,system-ui);text-transform:none;letter-spacing:0}.pcr-simple .pcr-help{font-size:14px;line-height:1.6;color:var(--pcr-muted)}.pcr-simple .pcr-chip{min-height:44px;padding:10px 16px;font:650 14px var(--sans,system-ui);text-transform:none;letter-spacing:0}.pcr-simple .pcr-action-link{min-height:46px;font-size:15px;padding:12px 18px}.pcr-simple .pcr-readable-label{font:600 14px var(--sans,system-ui);text-transform:none;letter-spacing:0}.pcr-simple .pcr-status-plain{padding:8px 12px;border:1px solid var(--pcr-line);border-radius:999px;font-size:14px;white-space:nowrap}.pcr-simple .pcr-footer{font-size:13px}.pcr-simple a:focus-visible,.pcr-simple summary:focus-visible{outline:3px solid var(--pcr-teal);outline-offset:3px}@media(max-width:600px){.pcr-simple .pcr-hero{flex-direction:column;padding:20px}.pcr-simple .pcr-layout{padding:8px}.pcr-simple .pcr-readable{padding:18px}.pcr-simple .pcr-post-text{font-size:16px}.pcr-simple .pcr-proof-grid{grid-template-columns:1fr}}
  `;
  return `<style data-property-predator-company-content-review>${STYLE}${simplifiedStyle}</style><article class="pcr pcr-simple" aria-labelledby="pcr-ledger-title"><header class="pcr-top"><a class="pcr-back" href="/portal/content"><span aria-hidden="true">←</span> Back to your content</a><span>Property Predator · Growth HQ</span></header>${exactReviewNotice(options.notice)}<section class="pcr-hero"><div><h1 id="pcr-ledger-title">${social ? 'Review your post' : 'Review your content'}</h1><p class="pcr-lead">${escapeHtml(review.title)}</p></div><span class="pcr-status-plain">${escapeHtml(status)}</span></section><div class="pcr-layout"><div class="pcr-main">${exactCopy}${socialRevisionActions(snapshot, options)}${exactReviewActions(snapshot, options)}${planAction}${ownedSeedWorkflowActions(snapshot, options)}${evidence}</div></div><footer class="pcr-footer"><span>Approval saves your decision. It does not publish this content.</span><span>${escapeHtml(snapshot.workspace.workspaceName)}</span></footer></article>`;
}
