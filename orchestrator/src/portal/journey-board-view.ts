/**
 * Pure server-rendered operational Journey Board.
 *
 * The board deliberately separates two concepts:
 * - workflow lanes are a team's review state and may be moved by an authorised user;
 * - journey milestones are immutable evidence projections and never change because
 *   a card was dragged.
 *
 * The companion client is progressive enhancement only. Every saved workflow move
 * remains a normal POST form with CSRF, idempotency and optimistic-concurrency data.
 */

import { escapeHtml } from './ui.js';

export const JOURNEY_BOARD_ROUTE = '/portal/journeys/board' as const;
export const JOURNEY_BOARD_CLIENT_ROUTE = '/portal/assets/journey-board.js' as const;

export const JOURNEY_BOARD_ROUTES = Object.freeze({
  board: JOURNEY_BOARD_ROUTE,
  clientAsset: JOURNEY_BOARD_CLIENT_ROUTE,
  moveWorkflow: (opportunityId: string): string => `${JOURNEY_BOARD_ROUTE}/opportunities/${encodeURIComponent(opportunityId)}/stage`,
  lead360: (contactId: string): string => `/portal/crm/contacts/${encodeURIComponent(contactId)}`,
  previewSignal: '/portal/journeys/board/test-signal',
});

export type JourneyBoardScoreBand = 'burning' | 'hot' | 'warm' | 'quiet' | 'unscored';
export type JourneyBoardNoticeKind = 'success' | 'info' | 'error' | 'conflict';
export type JourneyBoardOfferState =
  | 'presented'
  | 'accepted'
  | 'declined'
  | 'deferred'
  | 'requested_contact'
  | 'expired'
  | 'no_response';
export type JourneyBoardDueState = 'none' | 'due' | 'overdue' | 'done';

export interface JourneyBoardWorkspaceView {
  readonly name: string;
  readonly asOf: string;
  readonly timezone: string;
  readonly canWrite: boolean;
}

export interface JourneyBoardFilterOption {
  readonly value: string;
  readonly label: string;
}

export interface JourneyBoardFiltersView {
  readonly query: string;
  readonly route: string;
  readonly band: string;
  readonly routes: readonly JourneyBoardFilterOption[];
  readonly bands: readonly JourneyBoardFilterOption[];
}

export interface JourneyBoardLaneView {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly position: number;
  readonly cardCount: number;
  readonly totalCardCount: number;
  readonly attentionCount: number;
  readonly isClosed: boolean;
  readonly isPartial: boolean;
}

export interface JourneyBoardCoverageView {
  readonly loadedCardCount: number;
  readonly totalCardCount: number;
  readonly perLaneCardLimit: number;
  readonly partial: boolean;
}

export interface JourneyBoardSignalView {
  readonly kind: string;
  readonly label: string;
  readonly detail: string | null;
  readonly occurredAt: string;
  readonly progressPercent: number | null;
  /** True when the runtime, rather than a human workflow move, recorded it. */
  readonly automatic: boolean;
}

export interface JourneyBoardJourneyView {
  readonly routeKey: string;
  readonly routeLabel: string;
  readonly stageKey: string;
  readonly stageLabel: string;
  readonly stageSemantic: string;
  readonly lastAdvancedAt: string | null;
  readonly stageAutomatic: boolean;
  /** Other active or recently ended routes, excluding this primary route. */
  readonly otherJourneyCount: number;
  /** True only when a verified collected-payment fact reached the sale milestone. */
  readonly paymentVerifiedSale: boolean;
}

export interface JourneyBoardOfferView {
  readonly label: string;
  readonly state: JourneyBoardOfferState;
  readonly valueLabel: string | null;
}

export interface JourneyBoardNextMoveView {
  readonly label: string;
  readonly dueAt: string | null;
  readonly dueState: JourneyBoardDueState;
}

export interface JourneyBoardWorkflowMoveView {
  readonly commandKey: string;
  readonly expectedVersion: number;
  /** A server-approved subset of lane ids. The renderer never invents destinations. */
  readonly allowedLaneIds: readonly string[];
}

export interface JourneyBoardCardView {
  readonly id: string;
  readonly contactId: string;
  readonly laneId: string;
  readonly displayName: string;
  readonly companyName: string | null;
  readonly ownerName: string | null;
  readonly score: number | null;
  readonly scoreBand: JourneyBoardScoreBand;
  readonly sourceLabel: string;
  readonly affiliateLabel: string | null;
  readonly journey: JourneyBoardJourneyView;
  readonly latestSignal: JourneyBoardSignalView | null;
  readonly offer: JourneyBoardOfferView | null;
  readonly nextMove: JourneyBoardNextMoveView | null;
  readonly move: JourneyBoardWorkflowMoveView | null;
}

export interface JourneyBoardNoticeView {
  readonly kind: JourneyBoardNoticeKind;
  readonly title: string;
  readonly message: string;
}

export interface JourneyBoardPreviewSignalView {
  /** Must be literal true. Production presenters should omit this object entirely. */
  readonly enabled: true;
  readonly commandKey: string;
  readonly contacts: readonly JourneyBoardFilterOption[];
  readonly signals: readonly JourneyBoardFilterOption[];
}

export interface JourneyBoardView {
  readonly workspace: JourneyBoardWorkspaceView;
  readonly filters: JourneyBoardFiltersView;
  readonly lanes: readonly JourneyBoardLaneView[];
  readonly cards: readonly JourneyBoardCardView[];
  readonly coverage: JourneyBoardCoverageView;
  readonly csrfToken: string;
  readonly notice?: JourneyBoardNoticeView;
  readonly previewSignal?: JourneyBoardPreviewSignalView;
}

export interface JourneyBoardRenderOptions {
  /** Request-scoped notice may be supplied separately by a router/presenter. */
  readonly notice?: JourneyBoardNoticeView;
}

const BAND_LABELS: Readonly<Record<JourneyBoardScoreBand, string>> = Object.freeze({
  burning: 'Burning',
  hot: 'Hot',
  warm: 'Warm',
  quiet: 'Quiet',
  unscored: 'Unscored',
});

const OFFER_LABELS: Readonly<Record<JourneyBoardOfferState, string>> = Object.freeze({
  presented: 'Presented',
  accepted: 'Accepted',
  declined: 'Declined',
  deferred: 'Deferred',
  requested_contact: 'Requested contact',
  expired: 'Expired',
  no_response: 'No response',
});

const JOURNEY_BOARD_STYLE = `
  .jb{--jb-bg:#07090b;--jb-panel:#0d1013;--jb-raised:#12171b;--jb-line:#253038;--jb-line-strong:#36444e;--jb-ink:#f1f5f4;--jb-muted:#a5b1b4;--jb-faint:#7f8d92;--jb-teal:#00e5cc;--jb-amber:#f2b84b;--jb-danger:#ff7169;min-width:0;color:var(--jb-ink);font-family:var(--sans,ui-sans-serif,system-ui,sans-serif);background:var(--jb-bg);border:1px solid #020304;overflow:hidden}
  .jb *{box-sizing:border-box}.jb button,.jb input,.jb select{font:inherit}.jb h1,.jb h2,.jb h3,.jb p{margin-top:0}.jb a{text-decoration:none}.jb-visually-hidden{position:absolute!important;width:1px!important;height:1px!important;padding:0!important;margin:-1px!important;overflow:hidden!important;clip:rect(0,0,0,0)!important;white-space:nowrap!important;border:0!important}
  .jb-head{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:22px;align-items:end;padding:25px 27px 20px;border-bottom:1px solid var(--jb-line);background:radial-gradient(circle at 86% 0,rgba(0,229,204,.09),transparent 29%),linear-gradient(135deg,#111619,#080a0c 70%)}.jb-kicker{color:var(--jb-teal);font:800 12px/1.2 var(--mono,monospace);letter-spacing:.13em;text-transform:uppercase}.jb-head h1{margin:8px 0 7px;font-family:var(--display,var(--sans));font-size:clamp(2rem,3.7vw,3.65rem);font-weight:600;line-height:.95;letter-spacing:-.035em}.jb-head h1 em{color:var(--jb-teal);font-style:normal}.jb-head p{max-width:760px;margin:0;color:var(--jb-muted);font-size:14px;line-height:1.6}.jb-snapshot{min-width:210px;border:1px solid var(--jb-line-strong);background:rgba(5,7,8,.68);padding:13px 15px}.jb-snapshot small{display:block;color:var(--jb-faint);font:700 12px var(--mono,monospace);text-transform:uppercase}.jb-snapshot strong{display:block;margin-top:6px;font:850 20px var(--mono,monospace)}.jb-snapshot span{display:block;margin-top:4px;color:var(--jb-muted);font-size:12px}
  .jb-truth{display:grid;grid-template-columns:auto minmax(0,1fr);gap:12px;padding:12px 27px;border-bottom:1px solid var(--jb-line);background:#0a0d0f}.jb-truth strong{color:var(--jb-teal);font:850 12px var(--mono,monospace);letter-spacing:.08em;text-transform:uppercase}.jb-truth p{margin:0;color:var(--jb-muted);font-size:12px;line-height:1.55}.jb-truth b{color:var(--jb-ink)}
  .jb-notice{display:grid;grid-template-columns:auto 1fr;gap:10px;margin:16px 27px 0;border:1px solid var(--jb-line-strong);padding:12px 14px;background:var(--jb-panel)}.jb-notice::before{content:"";width:5px;background:var(--jb-teal)}.jb-notice.error::before,.jb-notice.conflict::before{background:var(--jb-danger)}.jb-notice strong{display:block;font-size:13px}.jb-notice p{margin:2px 0 0;color:var(--jb-muted);font-size:12px}.jb-notice.error,.jb-notice.conflict{border-color:#6b3836}
  .jb-toolbar{display:flex;align-items:end;gap:10px;padding:16px 27px;border-bottom:1px solid var(--jb-line);background:#0b0e11}.jb-filter{display:grid;gap:5px}.jb-filter.search{flex:1 1 280px}.jb-filter label{color:var(--jb-faint);font:750 12px var(--mono,monospace);letter-spacing:.06em;text-transform:uppercase}.jb-filter input,.jb-filter select{min-width:156px;height:44px;border:1px solid var(--jb-line-strong);border-radius:7px;background:var(--jb-raised);color:var(--jb-ink);padding:0 12px;font-size:13px}.jb-filter input{width:100%}.jb-filter input:focus,.jb-filter select:focus{border-color:var(--jb-teal);box-shadow:0 0 0 3px rgba(0,229,204,.13)}.jb-filter-button,.jb-clear{min-height:44px;border:1px solid var(--jb-line-strong);border-radius:7px;padding:0 14px;display:inline-flex;align-items:center;justify-content:center;font-size:12px;font-weight:800}.jb-filter-button{background:var(--jb-teal);border-color:var(--jb-teal);color:#03110f}.jb-clear{background:var(--jb-raised);color:var(--jb-ink)}
  .jb-mobile-stage-tabs{display:none}.jb-board-shell{padding:15px 15px 18px;background:#080a0c}.jb-board{display:grid;grid-auto-flow:column;grid-auto-columns:minmax(300px,320px);gap:10px;overflow-x:auto;overscroll-behavior-inline:contain;scroll-snap-type:x proximity;padding:1px 1px 10px;scrollbar-color:var(--jb-line-strong) transparent}.jb-lane{min-height:440px;display:flex;flex-direction:column;scroll-snap-align:start;border:1px solid var(--jb-line);border-radius:9px;background:var(--jb-panel)}.jb-lane[data-drop-target="true"]{border-color:var(--jb-teal);box-shadow:inset 0 0 0 1px var(--jb-teal),0 0 0 3px rgba(0,229,204,.09)}.jb-lane-head{position:sticky;top:0;z-index:2;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;padding:13px 13px 11px;border-bottom:2px solid var(--jb-line-strong);background:rgba(13,16,19,.97)}.jb-lane-head h2{margin:0;font-size:14px}.jb-lane-head p{margin:4px 0 0;color:var(--jb-muted);font-size:12px;line-height:1.4}.jb-lane-counts{display:flex;align-items:start;gap:5px}.jb-count,.jb-attention{min-width:27px;height:27px;display:inline-grid;place-items:center;border:1px solid var(--jb-line-strong);border-radius:999px;color:var(--jb-muted);font:800 12px var(--mono,monospace)}.jb-attention{border-color:#66552e;color:var(--jb-amber)}.jb-cards{list-style:none;display:grid;align-content:start;gap:8px;margin:0;padding:9px}.jb-empty{margin:10px 9px;border:1px dashed var(--jb-line-strong);padding:15px 12px;color:var(--jb-faint);font-size:12px;text-align:center}.jb-no-results{border:1px dashed var(--jb-line-strong);padding:30px;color:var(--jb-muted);font-size:13px;text-align:center}
  .jb-card{position:relative;border:1px solid var(--jb-line);border-left:3px solid var(--jb-teal);border-radius:8px;background:var(--jb-raised);overflow:hidden}.jb-card[data-band="burning"]{border-left-color:var(--jb-danger)}.jb-card[data-band="hot"]{border-left-color:#ff9f43}.jb-card[data-band="warm"]{border-left-color:var(--jb-amber)}.jb-card[data-dragging="true"]{opacity:.58}.jb-card-head{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:9px;padding:11px 11px 9px}.jb-identity{min-width:0}.jb-person{display:inline-block;color:var(--jb-ink);font-size:14px;font-weight:820;line-height:1.3}.jb-person:hover,.jb-person:focus-visible{color:var(--jb-teal)}.jb-company{display:block;margin-top:3px;color:var(--jb-muted);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.jb-score{min-width:50px;border:1px solid var(--jb-line-strong);padding:6px;text-align:center}.jb-score strong{display:block;font:900 18px/1 var(--mono,monospace)}.jb-score span{display:block;margin-top:4px;color:var(--jb-muted);font:800 12px/1 var(--mono,monospace);text-transform:uppercase}.jb-card[data-band="burning"] .jb-score strong,.jb-card[data-band="burning"] .jb-score span{color:var(--jb-danger)}.jb-card[data-band="hot"] .jb-score strong,.jb-card[data-band="hot"] .jb-score span{color:#ff9f43}.jb-card[data-band="warm"] .jb-score strong,.jb-card[data-band="warm"] .jb-score span{color:var(--jb-amber)}
  .jb-source{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:0 11px 9px;color:var(--jb-muted);font-size:12px}.jb-source span{border:1px solid var(--jb-line);border-radius:999px;padding:3px 7px}.jb-source .jb-affiliate{color:var(--jb-teal)}.jb-journey{margin:0 9px;padding:9px;border:1px solid var(--jb-line);background:#0a0d0f}.jb-journey-top{display:flex;align-items:center;justify-content:space-between;gap:7px}.jb-route{color:var(--jb-teal);font:800 12px var(--mono,monospace);text-transform:uppercase}.jb-route-count{color:var(--jb-faint);font-size:12px}.jb-stage{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:6px}.jb-stage strong{font-size:13px}.jb-stage small{color:var(--jb-faint);font-size:12px}.jb-payment-only{border:1px solid #2e746b;background:#0a2926;padding:3px 6px;color:var(--jb-teal);font:800 12px var(--mono,monospace);text-transform:uppercase}
  .jb-facts{display:grid;gap:7px;padding:9px 11px}.jb-fact{display:grid;grid-template-columns:74px minmax(0,1fr);gap:8px;align-items:start;padding-top:7px;border-top:1px solid var(--jb-line)}.jb-fact>span:first-child{color:var(--jb-faint);font:750 12px var(--mono,monospace);text-transform:uppercase}.jb-fact strong{display:block;font-size:12px;line-height:1.4}.jb-fact small{display:block;margin-top:2px;color:var(--jb-muted);font-size:12px;line-height:1.4}.jb-auto{display:inline-flex!important;align-items:center;gap:4px;color:var(--jb-teal)!important;font-weight:800}.jb-progress{color:var(--jb-amber)!important}.jb-due-overdue strong{color:var(--jb-danger)}.jb-due-done strong{color:#7bd7a5}
  .jb-move{border-top:1px solid var(--jb-line);padding:9px 11px 11px}.jb-move-row{display:grid;grid-template-columns:44px minmax(0,1fr) 64px;gap:7px;align-items:end}.jb-drag-handle{width:44px;height:44px;border:1px solid var(--jb-line-strong);border-radius:7px;background:#0a0d0f;color:var(--jb-teal);font:900 18px var(--mono,monospace);cursor:grab}.jb-drag-handle:active{cursor:grabbing}.jb-drag-handle[aria-pressed="true"]{border-color:var(--jb-teal);background:#0a2926}.jb-move-field{display:grid;gap:4px}.jb-move-field label{color:var(--jb-faint);font:750 12px var(--mono,monospace);text-transform:uppercase}.jb-move-field select{width:100%;height:44px;border:1px solid var(--jb-line-strong);border-radius:7px;background:#0a0d0f;color:var(--jb-ink);padding:0 8px;font-size:12px}.jb-move-submit{height:44px;border:1px solid var(--jb-line-strong);border-radius:7px;background:var(--jb-teal);color:#03110f;font-size:12px;font-weight:900}.jb-move-help{margin:7px 0 0;color:var(--jb-faint);font-size:12px;line-height:1.45}.jb-readonly{margin:0;border-top:1px solid var(--jb-line);padding:10px 11px;color:var(--jb-faint);font-size:12px}
  .jb-preview{margin:0 15px 18px;border:1px solid #765b2a;background:#171308;padding:14px}.jb-preview-head{display:flex;align-items:start;justify-content:space-between;gap:10px}.jb-preview h2{margin:0;font-size:14px}.jb-preview-badge{border:1px solid var(--jb-amber);padding:3px 7px;color:var(--jb-amber);font:850 12px var(--mono,monospace);text-transform:uppercase}.jb-preview p{margin:5px 0 12px;color:#c4b792;font-size:12px}.jb-preview-form{display:grid;grid-template-columns:minmax(150px,1fr) minmax(150px,1fr) auto;gap:8px;align-items:end}.jb-preview-form label{display:grid;gap:5px;color:#aa9d7d;font:750 12px var(--mono,monospace);text-transform:uppercase}.jb-preview-form select{height:44px;border:1px solid #66552e;border-radius:7px;background:#0f0d08;color:var(--jb-ink);padding:0 9px;font-size:12px}.jb-preview-form button{height:44px;border:1px solid var(--jb-amber);border-radius:7px;background:var(--jb-amber);color:#171008;padding:0 14px;font-size:12px;font-weight:900}
  .jb-drawer[hidden]{display:none}.jb-drawer{position:fixed;z-index:80;inset:0;display:grid;grid-template-columns:minmax(0,1fr) minmax(420px,760px);background:rgba(0,0,0,.63)}.jb-drawer-panel{grid-column:2;min-width:0;height:100%;overflow:auto;background:var(--jb-bg);border-left:1px solid var(--jb-line-strong);box-shadow:-24px 0 70px rgba(0,0,0,.4)}.jb-drawer-bar{position:sticky;z-index:4;top:0;display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:58px;padding:7px 13px;border-bottom:1px solid var(--jb-line);background:rgba(7,9,11,.96)}.jb-drawer-bar strong{font-size:13px}.jb-drawer-close{min-width:44px;height:44px;border:1px solid var(--jb-line-strong);border-radius:7px;background:var(--jb-raised);color:var(--jb-ink);font-size:20px}.jb-drawer-loading,.jb-drawer-error{padding:25px;color:var(--jb-muted);font-size:13px}.jb-drawer-error{color:var(--jb-danger)}.jb-drawer-content .lead360{border:0!important;border-radius:0!important}.jb-lock-scroll{overflow:hidden}.jb-live{position:fixed;left:50%;bottom:18px;z-index:100;transform:translateX(-50%);max-width:min(520px,calc(100vw - 28px));border:1px solid var(--jb-line-strong);background:#07110f;color:var(--jb-ink);padding:10px 13px;font-size:12px;box-shadow:0 12px 32px rgba(0,0,0,.38)}.jb-live:empty{display:none}
  @media(max-width:960px){.jb-head{grid-template-columns:1fr}.jb-snapshot{min-width:0}.jb-toolbar{flex-wrap:wrap}.jb-filter.search{flex-basis:100%}.jb-filter{flex:1 1 180px}.jb-filter input,.jb-filter select{width:100%;min-width:0}.jb-drawer{grid-template-columns:minmax(0,.25fr) minmax(400px,1fr)}}
  @media(max-width:760px){.jb-head{padding:22px 18px 18px}.jb-head h1{font-size:2.35rem}.jb-truth{grid-template-columns:1fr;padding:12px 18px}.jb-notice{margin-inline:18px}.jb-toolbar{padding:14px 18px}.jb-filter{flex-basis:calc(50% - 5px)}.jb-filter.search{flex-basis:100%}.jb-filter-button,.jb-clear{flex:1 1 calc(50% - 5px)}.jb-board-shell{padding:10px 0 17px}.jb-enhanced .jb-mobile-stage-tabs{display:flex;gap:6px;overflow-x:auto;padding:0 18px 10px;scrollbar-width:thin}.jb-mobile-stage-tab{flex:0 0 auto;min-height:44px;border:1px solid var(--jb-line-strong);border-radius:999px;background:var(--jb-panel);color:var(--jb-muted);padding:0 12px;font-size:12px;font-weight:800}.jb-mobile-stage-tab[aria-pressed="true"]{border-color:var(--jb-teal);background:#0a2926;color:var(--jb-teal)}.jb-board{display:block;overflow:visible;padding:0 18px}.jb-enhanced .jb-lane:not([data-mobile-active="true"]){display:none}.jb-lane{min-height:0}.jb-lane-head{position:static}.jb-empty{margin-block:9px;min-height:0}.jb-preview{margin-inline:18px}.jb-preview-form{grid-template-columns:1fr}.jb-drawer{display:block;background:var(--jb-bg)}.jb-drawer-panel{width:100%;height:100%;border-left:0}.jb-move-row{grid-template-columns:1fr}.jb-move-field,.jb-move-submit{grid-column:1/-1}.jb-drag-handle{display:none}}
  @media(max-width:480px){.jb-filter{flex-basis:100%}.jb-card-head{grid-template-columns:minmax(0,1fr) 54px}.jb-fact{grid-template-columns:68px minmax(0,1fr)}.jb-preview-head{display:block}.jb-preview-badge{display:inline-block;margin-bottom:8px}}
  @media(prefers-reduced-motion:reduce){.jb *{scroll-behavior:auto!important;animation:none!important;transition:none!important}}
  @media(forced-colors:active){.jb,.jb-card,.jb-lane,.jb-journey,.jb-drawer-panel{forced-color-adjust:auto}.jb-card,.jb-lane,.jb-drag-handle,.jb-mobile-stage-tab{border:2px solid CanvasText}.jb-card[data-band]{border-left:4px solid Highlight}.jb-payment-only{border:2px solid Highlight}}
`;

function safeDate(value: string | null): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function timestamp(value: string | null, timezone: string, fallback = 'Time not recorded'): string {
  const date = safeDate(value);
  if (!date) return escapeHtml(fallback);
  let label: string;
  try {
    label = new Intl.DateTimeFormat('en-GB', {
      dateStyle: 'medium', timeStyle: 'short', timeZone: timezone,
    }).format(date);
  } catch {
    label = `${new Intl.DateTimeFormat('en-GB', {
      dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC',
    }).format(date)} UTC`;
  }
  return `<time datetime="${escapeHtml(date.toISOString())}">${escapeHtml(label)}</time>`;
}

function finiteScore(score: number | null): string {
  return score !== null && Number.isFinite(score) && score >= 0 && score <= 100
    ? String(Math.round(score))
    : '—';
}

function progress(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '';
  const bounded = Math.max(0, Math.min(100, Math.round(value)));
  return `<small class="jb-progress">${escapeHtml(bounded)}% complete</small>`;
}

function validMutation(csrfToken: string, move: JourneyBoardWorkflowMoveView): boolean {
  return csrfToken.length >= 16
    && move.commandKey.trim().length >= 8
    && Number.isSafeInteger(move.expectedVersion)
    && move.expectedVersion >= 0;
}

function selected(value: string, current: string): string {
  return value === current ? ' selected' : '';
}

function filterOptions(options: readonly JourneyBoardFilterOption[], current: string, allLabel: string): string {
  return `<option value="">${escapeHtml(allLabel)}</option>${options.map((option) => (
    `<option value="${escapeHtml(option.value)}"${selected(option.value, current)}>${escapeHtml(option.label)}</option>`
  )).join('')}`;
}

function notice(view: JourneyBoardNoticeView | undefined): string {
  if (!view) return '';
  const role = view.kind === 'error' || view.kind === 'conflict' ? 'alert' : 'status';
  return `<aside class="jb-notice ${view.kind}" role="${role}"><div><strong>${escapeHtml(view.title)}</strong><p>${escapeHtml(view.message)}</p></div></aside>`;
}

function filters(view: JourneyBoardView): string {
  return `<form class="jb-toolbar" method="get" action="${JOURNEY_BOARD_ROUTES.board}" aria-label="Filter live journeys">
    <div class="jb-filter search"><label for="jb-search">Search people</label><input id="jb-search" name="q" type="search" value="${escapeHtml(view.filters.query)}" placeholder="Name, company or source"></div>
    <div class="jb-filter"><label for="jb-route">Journey</label><select id="jb-route" name="route">${filterOptions(view.filters.routes, view.filters.route, 'All journeys')}</select></div>
    <div class="jb-filter"><label for="jb-band">Score band</label><select id="jb-band" name="band">${filterOptions(view.filters.bands, view.filters.band, 'All scores')}</select></div>
    <button class="jb-filter-button" type="submit">Apply filters</button><a class="jb-clear" href="${JOURNEY_BOARD_ROUTES.board}">Clear</a>
  </form>`;
}

function signalFact(card: JourneyBoardCardView, timezone: string): string {
  const signal = card.latestSignal;
  if (!signal) return '<div class="jb-fact"><span>Latest signal</span><div><strong>No evidence recorded</strong><small>The board has not invented an activity.</small></div></div>';
  return `<div class="jb-fact"><span>Latest signal</span><div><strong>${escapeHtml(signal.label)}</strong>${signal.detail ? `<small>${escapeHtml(signal.detail)}</small>` : ''}${progress(signal.progressPercent)}<small${signal.automatic ? ' class="jb-auto"' : ''}>${signal.automatic ? 'AUTO · ' : ''}${timestamp(signal.occurredAt, timezone)}</small></div></div>`;
}

function offerFact(offer: JourneyBoardOfferView | null): string {
  if (!offer) return '<div class="jb-fact"><span>Offer</span><div><strong>No offer recorded</strong></div></div>';
  return `<div class="jb-fact"><span>Offer</span><div><strong>${escapeHtml(offer.label)}</strong><small>${escapeHtml(OFFER_LABELS[offer.state])}${offer.valueLabel ? ` · ${escapeHtml(offer.valueLabel)}` : ''}</small></div></div>`;
}

function nextMoveFact(move: JourneyBoardNextMoveView | null, timezone: string): string {
  if (!move) return '<div class="jb-fact"><span>Next move</span><div><strong>No evidence-based move</strong></div></div>';
  return `<div class="jb-fact jb-due-${move.dueState}"><span>Next move</span><div><strong>${escapeHtml(move.label)}</strong><small>${timestamp(move.dueAt, timezone, move.dueState === 'done' ? 'Completed' : 'No due time')}</small></div></div>`;
}

function journeyBlock(card: JourneyBoardCardView, timezone: string): string {
  const journey = card.journey;
  const sale = journey.paymentVerifiedSale
    ? '<span class="jb-payment-only">Sale · payment verified</span>'
    : '';
  const provenance = journey.stageKey === 'awaiting-enrolment'
    ? ''
    : `<small${journey.stageAutomatic ? ' class="jb-auto"' : ''}>${journey.stageAutomatic ? 'AUTO' : 'RECORDED'}</small>`;
  return `<div class="jb-journey" aria-label="${journey.stageAutomatic ? 'Automatic' : 'Recorded'} journey state"><div class="jb-journey-top"><span class="jb-route">${escapeHtml(journey.routeLabel)}</span>${journey.otherJourneyCount > 0 ? `<span class="jb-route-count">+${escapeHtml(journey.otherJourneyCount)} other route${journey.otherJourneyCount === 1 ? '' : 's'}</span>` : ''}</div><div class="jb-stage"><strong>${escapeHtml(journey.stageLabel)}</strong>${provenance}${journey.lastAdvancedAt ? `<small>Reached ${timestamp(journey.lastAdvancedAt, timezone)}</small>` : '<small>Reach time not recorded</small>'}${sale}</div></div>`;
}

function workflowMove(
  card: JourneyBoardCardView,
  lanes: readonly JourneyBoardLaneView[],
  view: JourneyBoardView,
  cardIndex: number,
): string {
  if (!view.workspace.canWrite || !card.move) {
    return '<p class="jb-readonly">Workflow movement is unavailable for this workspace role. Journey evidence remains read-only.</p>';
  }
  if (!validMutation(view.csrfToken, card.move)) {
    return '<p class="jb-readonly" role="status">Refresh the board before moving this workflow card.</p>';
  }
  const allowed = new Set(card.move.allowedLaneIds);
  const destinations = lanes.filter((lane) => lane.id !== card.laneId && allowed.has(lane.id));
  if (!destinations.length) {
    return '<p class="jb-readonly">No server-approved workflow destination is available. Journey evidence cannot be moved manually.</p>';
  }
  const selectId = `jb-move-${cardIndex}`;
  const helpId = `jb-move-help-${cardIndex}`;
  return `<form class="jb-move" method="post" action="${JOURNEY_BOARD_ROUTES.moveWorkflow(card.id)}" data-workflow-move-form>
    <input type="hidden" name="_csrf" value="${escapeHtml(view.csrfToken)}"><input type="hidden" name="command_key" value="${escapeHtml(card.move.commandKey)}"><input type="hidden" name="expected_version" value="${escapeHtml(card.move.expectedVersion)}"><input type="hidden" name="return_q" value="${escapeHtml(view.filters.query)}"><input type="hidden" name="return_route" value="${escapeHtml(view.filters.route)}"><input type="hidden" name="return_band" value="${escapeHtml(view.filters.band)}">
    <div class="jb-move-row"><button class="jb-drag-handle" type="button" draggable="true" aria-pressed="false" aria-describedby="${helpId}" data-drag-handle title="Move workflow card">⋮⋮<span class="jb-visually-hidden">Move ${escapeHtml(card.displayName)} between team workflow lanes</span></button><div class="jb-move-field"><label for="${selectId}">Team lane</label><select id="${selectId}" name="target_lane_id" required data-lane-select>${destinations.map((lane) => `<option value="${escapeHtml(lane.id)}">${escapeHtml(lane.label)}</option>`).join('')}</select></div><button class="jb-move-submit" type="submit">Move</button></div>
    <p class="jb-move-help" id="${helpId}">Drag, or press Space then arrows and Space. This changes team workflow only; it does not fabricate journey evidence, send a message or verify payment.</p>
  </form>`;
}

function cardMarkup(
  card: JourneyBoardCardView,
  lanes: readonly JourneyBoardLaneView[],
  view: JourneyBoardView,
  cardIndex: number,
): string {
  const leadHref = JOURNEY_BOARD_ROUTES.lead360(card.contactId);
  const owner = card.ownerName?.trim() || 'Unassigned';
  return `<li><article class="jb-card" data-journey-card data-card-id="${escapeHtml(card.id)}" data-lane-id="${escapeHtml(card.laneId)}" data-band="${escapeHtml(card.scoreBand)}" aria-labelledby="jb-card-${cardIndex}-name">
    <header class="jb-card-head"><div class="jb-identity"><a class="jb-person" id="jb-card-${cardIndex}-name" href="${leadHref}" data-lead360-link>${escapeHtml(card.displayName)}</a>${card.companyName ? `<span class="jb-company">${escapeHtml(card.companyName)} · Owner ${escapeHtml(owner)}</span>` : `<span class="jb-company">Owner ${escapeHtml(owner)}</span>`}</div><div class="jb-score" aria-label="Lead score ${escapeHtml(finiteScore(card.score))}, ${escapeHtml(BAND_LABELS[card.scoreBand])}"><strong>${escapeHtml(finiteScore(card.score))}</strong><span>${escapeHtml(BAND_LABELS[card.scoreBand])}</span></div></header>
    <div class="jb-source"><span>Source · ${escapeHtml(card.sourceLabel)}</span>${card.affiliateLabel ? `<span class="jb-affiliate">Affiliate · ${escapeHtml(card.affiliateLabel)}</span>` : ''}</div>
    ${journeyBlock(card, view.workspace.timezone)}
    <div class="jb-facts">${signalFact(card, view.workspace.timezone)}${offerFact(card.offer)}${nextMoveFact(card.nextMove, view.workspace.timezone)}</div>
    ${workflowMove(card, lanes, view, cardIndex)}
  </article></li>`;
}

function laneMarkup(
  lane: JourneyBoardLaneView,
  cards: readonly JourneyBoardCardView[],
  lanes: readonly JourneyBoardLaneView[],
  view: JourneyBoardView,
  filterActive: boolean,
  first: boolean,
  cardIndex: { value: number },
): string {
  const laneCards = cards.filter((card) => card.laneId === lane.id);
  const contents = laneCards.length
    ? laneCards.map((card) => cardMarkup(card, lanes, view, cardIndex.value++)).join('')
    : lane.isPartial && filterActive
      ? '<li class="jb-empty">No match in the loaded cards. This lane has additional saved cards that are not shown.</li>'
      : '<li class="jb-empty">No people in this workflow lane.</li>';
  return `<section class="jb-lane" id="jb-lane-panel-${escapeHtml(lane.id)}" data-journey-lane data-lane-id="${escapeHtml(lane.id)}" data-mobile-active="${first ? 'true' : 'false'}" aria-labelledby="jb-lane-${escapeHtml(lane.id)}"><header class="jb-lane-head"><div><h2 id="jb-lane-${escapeHtml(lane.id)}">${escapeHtml(lane.label)}</h2><p>${escapeHtml(lane.description)}</p></div><div class="jb-lane-counts"><span class="jb-count" aria-label="${escapeHtml(lane.cardCount)} visible of ${escapeHtml(lane.totalCardCount)} saved">${escapeHtml(lane.cardCount)}${lane.isPartial ? `/${escapeHtml(lane.totalCardCount)}` : ''}</span>${lane.attentionCount > 0 ? `<span class="jb-attention" aria-label="${escapeHtml(lane.attentionCount)} need attention">${escapeHtml(lane.attentionCount)}</span>` : ''}</div></header><ol class="jb-cards">${contents}</ol></section>`;
}

function previewSignal(view: JourneyBoardView): string {
  const preview = view.previewSignal;
  if (!preview || preview.enabled !== true || !validMutation(view.csrfToken, {
    commandKey: preview.commandKey, expectedVersion: 0, allowedLaneIds: [],
  })) return '';
  return `<aside class="jb-preview" aria-labelledby="jb-preview-title"><div class="jb-preview-head"><span class="jb-preview-badge">Preview fixtures only</span><div><h2 id="jb-preview-title">Inject a test signal</h2><p>This writes only to the explicitly configured disposable preview runtime. It never contacts a person, sends a message or claims a real payment.</p></div></div><form class="jb-preview-form" method="post" action="${JOURNEY_BOARD_ROUTES.previewSignal}"><input type="hidden" name="_csrf" value="${escapeHtml(view.csrfToken)}"><input type="hidden" name="command_key" value="${escapeHtml(preview.commandKey)}"><input type="hidden" name="preview_fixture_only" value="true"><label>Test person<select name="contact_id" required>${preview.contacts.map((option) => `<option value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</option>`).join('')}</select></label><label>Test signal<select name="signal_key" required>${preview.signals.map((option) => `<option value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</option>`).join('')}</select></label><button type="submit">Record test signal</button></form></aside>`;
}

/** Render a complete body fragment for insertion into the authenticated portal shell. */
export function renderJourneyBoardBody(
  view: JourneyBoardView,
  options: JourneyBoardRenderOptions = {},
): string {
  const lanes = [...view.lanes].sort((left, right) => left.position - right.position);
  const knownLaneIds = new Set(lanes.map((lane) => lane.id));
  const visibleCards = view.cards.filter((card) => knownLaneIds.has(card.laneId));
  const cardIndex = { value: 0 };
  const filterActive = Boolean(view.filters.query || view.filters.route || view.filters.band);
  const laneTabs = lanes.map((lane, index) => `<button class="jb-mobile-stage-tab" type="button" aria-pressed="${index === 0 ? 'true' : 'false'}" aria-controls="jb-lane-panel-${escapeHtml(lane.id)}" aria-label="Show ${escapeHtml(lane.label)} workflow lane, ${escapeHtml(lane.cardCount)} visible card${lane.cardCount === 1 ? '' : 's'}" data-lane-tab="${escapeHtml(lane.id)}">${escapeHtml(lane.label)} · ${escapeHtml(lane.cardCount)}</button>`).join('');
  const board = lanes.length
    ? lanes.map((lane, index) => laneMarkup(lane, visibleCards, lanes, view, filterActive, index === 0, cardIndex)).join('')
    : '<div class="jb-no-results">No workflow lanes have been configured. No journey state has been invented.</div>';
  const hiddenCards = view.cards.length - visibleCards.length;
  const summary = filterActive
    ? `${visibleCards.length} ${view.coverage.partial ? 'matches in loaded cards' : 'matching people'}`
    : view.coverage.partial
      ? `${visibleCards.length} loaded of ${view.coverage.totalCardCount} saved cards`
      : `${visibleCards.length} people in workflow`;
  const partialNotice = view.coverage.partial
    ? `<aside class="jb-notice info" role="status"><div><strong>Bounded live view</strong><p>Showing ${escapeHtml(view.coverage.loadedCardCount)} of ${escapeHtml(view.coverage.totalCardCount)} saved workflow cards, capped at ${escapeHtml(view.coverage.perLaneCardLimit)} per lane. Filters search the loaded cards only, so zero loaded matches does not mean no saved match exists.</p></div></aside>`
    : '';
  return `<style data-property-predator-journey-board>${JOURNEY_BOARD_STYLE}</style><article class="jb" data-journey-board aria-labelledby="jb-title">
    <header class="jb-head"><div><div class="jb-kicker">Growth HQ · Live journeys</div><h1 id="jb-title">People moving. <em>Evidence proving why.</em></h1><p>Work the human queue while the journey runtime records what each person actually watched, requested, booked or bought.</p></div><aside class="jb-snapshot" aria-label="Board snapshot"><small>Live workflow</small><strong>${escapeHtml(summary)}</strong><span>${escapeHtml(view.workspace.name)} · ${timestamp(view.workspace.asOf, view.workspace.timezone)}</span></aside></header>
    <section class="jb-truth" aria-label="Movement boundary"><strong>Two rails. No blurred truth.</strong><p><b>Dragging changes the team workflow lane only.</b> Journey stages advance from recorded evidence. A Sale journey badge is payment-only and appears only after verified collected payment.</p></section>
    ${notice(options.notice ?? view.notice)}${partialNotice}${filters(view)}
    <div class="jb-board-shell"><div class="jb-mobile-stage-tabs" role="group" aria-label="Choose a workflow lane">${laneTabs}</div><div class="jb-board" aria-label="Operational people board" aria-describedby="jb-board-instructions">${board}</div><p class="jb-visually-hidden" id="jb-board-instructions">Each card links to its full Lead 360 case file. Authorised users can move team workflow with the form or keyboard drag handle. Journey evidence and payment are not changed by a workflow move.</p>${hiddenCards > 0 ? `<p class="jb-readonly">${escapeHtml(hiddenCards)} card${hiddenCards === 1 ? '' : 's'} referenced an unavailable lane and were withheld for review.</p>` : ''}</div>
    ${previewSignal(view)}
    <div class="jb-drawer" data-lead360-drawer role="dialog" aria-modal="true" aria-labelledby="jb-drawer-title" hidden><section class="jb-drawer-panel"><header class="jb-drawer-bar"><strong id="jb-drawer-title">Lead 360</strong><button class="jb-drawer-close" type="button" data-drawer-close aria-label="Close Lead 360">×</button></header><div class="jb-drawer-content" data-drawer-content></div></section></div>
    <div class="jb-live" data-board-live role="status" aria-live="polite" aria-atomic="true"></div>
  </article><script src="${JOURNEY_BOARD_ROUTES.clientAsset}" defer></script>`;
}
