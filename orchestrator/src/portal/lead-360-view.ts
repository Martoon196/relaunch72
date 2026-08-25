/**
 * Pure, read-only Lead 360 rendering.
 *
 * This view consumes a deliberately narrow case-file projection. Provider
 * payloads, delivery credentials and event hashes do not belong in the view
 * model, which makes it harder to leak operational data into the portal.
 */

import { escapeHtml } from './ui.js';

export type Lead360ScoreBand = 'burning' | 'hot' | 'warm' | 'quiet' | 'unscored';
export type Lead360StageState = 'complete' | 'current' | 'upcoming';
export type Lead360EvidenceKind =
  | 'watched'
  | 'listened'
  | 'read'
  | 'downloaded'
  | 'product'
  | 'offer'
  | 'reply'
  | 'appointment'
  | 'commerce';
export type Lead360OfferState = 'presented' | 'accepted' | 'declined' | 'deferred' | 'requested_contact' | 'expired' | 'no_response';
export type Lead360ConsentState = 'permitted' | 'denied' | 'unknown' | 'withdrawn' | 'suppressed';
export type Lead360CrmState = 'open' | 'won' | 'lost' | 'complete';

export interface Lead360IdentityView {
  readonly contactId: string;
  readonly displayName: string;
  readonly companyName: string | null;
  readonly primaryEmail: string | null;
  readonly primaryPhone: string | null;
  readonly ownerName: string | null;
}

export interface Lead360JourneyStageView {
  readonly key: string;
  readonly label: string;
  readonly state: Lead360StageState;
  readonly reachedAt: string | null;
}

export interface Lead360JourneyView {
  readonly label: string;
  readonly stages: readonly Lead360JourneyStageView[];
}

export interface Lead360EvidenceView {
  readonly id: string;
  readonly kind: Lead360EvidenceKind;
  readonly title: string;
  readonly detail: string | null;
  readonly percentage: number | null;
  readonly occurredAt: string;
  readonly sourceLabel: string;
}

export interface Lead360NextMoveView {
  readonly label: string;
  readonly reason: string;
  readonly dueAt: string | null;
}

export interface Lead360OfferView {
  readonly id: string;
  readonly title: string;
  readonly valueLabel: string | null;
  readonly state: Lead360OfferState;
  readonly presentedAt: string;
  readonly responseAt: string | null;
  readonly responseDetail: string | null;
}

export interface Lead360ConsentView {
  readonly channelLabel: string;
  readonly state: Lead360ConsentState;
  readonly basis: string | null;
  readonly updatedAt: string | null;
}

export interface Lead360OpportunityView {
  readonly id: string;
  readonly title: string;
  readonly stageLabel: string;
  readonly state: Exclude<Lead360CrmState, 'complete'>;
  readonly valueLabel: string | null;
}

export interface Lead360TaskView {
  readonly id: string;
  readonly title: string;
  readonly state: 'open' | 'complete' | 'cancelled';
  readonly dueAt: string | null;
}

export interface Lead360CrmSummaryView {
  readonly opportunities: readonly Lead360OpportunityView[];
  readonly tasks: readonly Lead360TaskView[];
}

export interface Lead360View {
  readonly identity: Lead360IdentityView;
  readonly score: number | null;
  readonly scoreExplanation: string | null;
  readonly journey: Lead360JourneyView;
  readonly evidence: readonly Lead360EvidenceView[];
  readonly nextMove: Lead360NextMoveView | null;
  readonly offers: readonly Lead360OfferView[];
  readonly consent: readonly Lead360ConsentView[];
  readonly suppressionReason: string | null;
  readonly crm: Lead360CrmSummaryView;
  readonly asOf: string;
}

const EVIDENCE_LABELS: Readonly<Record<Lead360EvidenceKind, string>> = Object.freeze({
  watched: 'Watched',
  listened: 'Listened',
  read: 'Read',
  downloaded: 'Downloaded',
  product: 'Used product',
  offer: 'Offer',
  reply: 'Reply',
  appointment: 'Appointment',
  commerce: 'Commerce',
});

const OFFER_LABELS: Readonly<Record<Lead360OfferState, string>> = Object.freeze({
  presented: 'Presented',
  accepted: 'Accepted',
  declined: 'Declined',
  deferred: 'Deferred',
  requested_contact: 'Requested contact',
  expired: 'Expired',
  no_response: 'No response',
});

const CONSENT_LABELS: Readonly<Record<Lead360ConsentState, string>> = Object.freeze({
  permitted: 'Permitted',
  denied: 'Denied',
  unknown: 'Not evidenced',
  withdrawn: 'Withdrawn',
  suppressed: 'Suppressed',
});

const SCORE_LABELS: Readonly<Record<Lead360ScoreBand, string>> = Object.freeze({
  burning: 'Burning',
  hot: 'Hot',
  warm: 'Warm',
  quiet: 'Quiet',
  unscored: 'Unscored',
});

export function lead360ScoreBand(score: number | null): Lead360ScoreBand {
  if (score === null || !Number.isFinite(score)) return 'unscored';
  if (score >= 70) return 'burning';
  if (score >= 45) return 'hot';
  if (score >= 22) return 'warm';
  return 'quiet';
}

function finiteScore(score: number | null): string {
  return score !== null && Number.isFinite(score) ? String(Math.round(score)) : '—';
}

function timestamp(value: string | null, fallback = 'Time not recorded'): string {
  if (!value) return `<span class="lead360-time-missing">${escapeHtml(fallback)}</span>`;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) return `<span class="lead360-time-missing">${escapeHtml(fallback)}</span>`;
  const canonical = parsed.toISOString();
  const label = new Intl.DateTimeFormat('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false, timeZone: 'UTC', timeZoneName: 'short',
  }).format(parsed);
  return `<time datetime="${escapeHtml(canonical)}">${escapeHtml(label)}</time>`;
}

function safePercentage(value: number | null): string {
  if (value === null || !Number.isFinite(value) || value < 0 || value > 100) return '';
  const precision = Number.isInteger(value) ? 0 : 1;
  return `<span class="lead360-progress">${escapeHtml(value.toFixed(precision))}% complete</span>`;
}

function emptyState(title: string, detail: string): string {
  return `<div class="lead360-empty" role="status"><strong>${escapeHtml(title)}</strong><p>${escapeHtml(detail)}</p></div>`;
}

function contactLine(identity: Lead360IdentityView): string {
  const details = [identity.companyName, identity.primaryEmail, identity.primaryPhone]
    .filter((value): value is string => Boolean(value && value.trim()));
  return details.length
    ? details.map((item) => `<span>${escapeHtml(item)}</span>`).join('<i aria-hidden="true"></i>')
    : '<span>No contact details recorded</span>';
}

function stageRail(journey: Lead360JourneyView): string {
  if (!journey.stages.length) {
    return emptyState('No journey enrolled', 'This lead has no recorded conversion stage yet.');
  }
  return `<nav class="lead360-journey" aria-label="Journey stages"><div class="lead360-section-label">${escapeHtml(journey.label)}</div><ol>${journey.stages.map((stage, index) => `<li class="is-${stage.state}"${stage.state === 'current' ? ' aria-current="step"' : ''}>
    <span class="lead360-stage-node">${escapeHtml(String(index + 1).padStart(2, '0'))}</span>
    <span class="lead360-stage-copy"><strong>${escapeHtml(stage.label)}</strong>${stage.reachedAt ? timestamp(stage.reachedAt) : `<small>${stage.state === 'upcoming' ? 'Not reached' : 'Time not recorded'}</small>`}</span>
  </li>`).join('')}</ol></nav>`;
}

function evidenceTimeline(evidence: readonly Lead360EvidenceView[]): string {
  if (!evidence.length) {
    return emptyState('No recorded engagement evidence', 'Nothing watched, listened to, read, downloaded or actioned has been recorded for this lead.');
  }
  const ordered = evidence.map((item, index) => ({ item, index })).sort((left, right) => {
    const rightTime = new Date(right.item.occurredAt).valueOf();
    const leftTime = new Date(left.item.occurredAt).valueOf();
    const safeRight = Number.isNaN(rightTime) ? Number.NEGATIVE_INFINITY : rightTime;
    const safeLeft = Number.isNaN(leftTime) ? Number.NEGATIVE_INFINITY : leftTime;
    return safeRight - safeLeft || left.index - right.index;
  });
  return `<ol class="lead360-timeline" aria-label="Recorded evidence, newest first">${ordered.map(({ item }) => {
    const detail = item.detail ? `<p>${escapeHtml(item.detail)}</p>` : '';
    const source = item.sourceLabel.trim() || 'Source not recorded';
    return `<li class="lead360-event" data-evidence-kind="${item.kind}">
      <span class="lead360-event-mark" aria-hidden="true"></span>
      <article><header><span class="lead360-evidence-type">${escapeHtml(EVIDENCE_LABELS[item.kind])}</span>${safePercentage(item.percentage)}</header>
      <h3>${escapeHtml(item.title)}</h3>${detail}<footer>${timestamp(item.occurredAt)}<span>Source · ${escapeHtml(source)}</span></footer></article>
    </li>`;
  }).join('')}</ol>`;
}

function nextMove(move: Lead360NextMoveView | null): string {
  if (!move) {
    return emptyState('No evidence-based next move', 'Review the case after a recorded signal or CRM task is added.');
  }
  return `<div class="lead360-next-move"><div class="lead360-move-flag">Recommended</div><h3>${escapeHtml(move.label)}</h3><p>${escapeHtml(move.reason)}</p>${move.dueAt ? `<div class="lead360-due"><span>Suggested by</span>${timestamp(move.dueAt)}</div>` : ''}<small>Recommendation only · nothing has been sent or changed.</small></div>`;
}

function offerHistory(offers: readonly Lead360OfferView[]): string {
  if (!offers.length) {
    return emptyState('No offer history', 'No presented offer or prospect response has been recorded.');
  }
  return `<ol class="lead360-offers">${offers.map((offer) => `<li><div class="lead360-offer-head"><strong>${escapeHtml(offer.title)}</strong><span class="state-${offer.state}">${escapeHtml(OFFER_LABELS[offer.state])}</span></div>${offer.valueLabel ? `<div class="lead360-offer-value">${escapeHtml(offer.valueLabel)}</div>` : ''}<dl><div><dt>Presented</dt><dd>${timestamp(offer.presentedAt)}</dd></div><div><dt>Response</dt><dd>${offer.responseAt ? timestamp(offer.responseAt) : 'No response recorded'}</dd></div></dl>${offer.responseDetail ? `<p>${escapeHtml(offer.responseDetail)}</p>` : ''}</li>`).join('')}</ol>`;
}

function consentStatus(consent: readonly Lead360ConsentView[], suppressionReason: string | null): string {
  const suppression = suppressionReason
    ? `<div class="lead360-suppression" role="note"><strong>Active suppression</strong><p>${escapeHtml(suppressionReason)}</p></div>`
    : '';
  if (!consent.length) {
    return `${suppression}${emptyState('No channel evidence', 'Consent and suppression status have not been recorded for any channel.')}`;
  }
  return `${suppression}<ul class="lead360-consent">${consent.map((item) => `<li><div><strong>${escapeHtml(item.channelLabel)}</strong>${item.basis ? `<small>${escapeHtml(item.basis)}</small>` : '<small>No lawful-basis note recorded</small>'}</div><span class="state-${item.state}">${escapeHtml(CONSENT_LABELS[item.state])}</span>${item.updatedAt ? timestamp(item.updatedAt) : '<span class="lead360-time-missing">Time not recorded</span>'}</li>`).join('')}</ul>`;
}

function crmSummary(crm: Lead360CrmSummaryView): string {
  const opportunities = crm.opportunities.length
    ? `<ul class="lead360-crm-list">${crm.opportunities.map((item) => `<li><div><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(item.stageLabel)}${item.valueLabel ? ` · ${escapeHtml(item.valueLabel)}` : ''}</span></div><span class="state-${item.state}">${escapeHtml(item.state)}</span></li>`).join('')}</ul>`
    : emptyState('No CRM opportunities', 'This contact has no saved opportunity.');
  const tasks = crm.tasks.length
    ? `<ul class="lead360-crm-list lead360-task-list">${crm.tasks.map((item) => `<li><div><strong>${escapeHtml(item.title)}</strong><span>${item.dueAt ? timestamp(item.dueAt) : 'No due time recorded'}</span></div><span class="state-${item.state}">${item.state === 'complete' ? 'Complete' : item.state === 'cancelled' ? 'Cancelled' : 'Open'}</span></li>`).join('')}</ul>`
    : emptyState('No CRM tasks', 'There is no saved human follow-up task for this contact.');
  return `<div class="lead360-crm-block"><h3>Opportunities</h3>${opportunities}<h3>Tasks</h3>${tasks}</div>`;
}

const LEAD_360_STYLE = `
  .lead360{--case-bg:#0b0d0e;--case-panel:#121516;--case-raised:#191d1e;--case-line:#2d3233;--case-muted:#969d9c;--case-ink:#f5f2e9;--case-accent:var(--accent,#efaa22);--case-danger:var(--danger,#cf4943);font-family:var(--sans,ui-sans-serif,system-ui,sans-serif);color:var(--case-ink);background:var(--case-bg);border:1px solid #050606;border-radius:var(--radius,16px);overflow:hidden;box-shadow:0 28px 70px rgba(5,7,7,.28)}
  .lead360 *{box-sizing:border-box}.lead360 h1,.lead360 h2,.lead360 h3,.lead360 p{margin-top:0}.lead360-case-head{position:relative;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:28px;padding:30px 32px 25px;border-bottom:1px solid var(--case-line);background:radial-gradient(circle at 82% 0,rgba(239,170,34,.14),transparent 31%),linear-gradient(125deg,#171a1a,#0c0e0f 72%)}
  .lead360-case-head::before{content:"";position:absolute;inset:0 auto 0 0;width:5px;background:var(--case-accent)}.lead360-kicker,.lead360-section-label{font:800 .63rem/1.2 var(--mono,monospace);letter-spacing:.14em;text-transform:uppercase;color:var(--case-accent)}.lead360-case-head h1{font-size:clamp(1.7rem,3.1vw,2.65rem);line-height:1.02;letter-spacing:-.045em;margin:8px 0 10px}.lead360-contact-line{display:flex;align-items:center;flex-wrap:wrap;gap:8px;color:var(--case-muted);font-size:.77rem}.lead360-contact-line i{width:3px;height:3px;border-radius:50%;background:#59605f}.lead360-owner{display:block;margin-top:11px;color:#c6cac6;font-size:.7rem}.lead360-owner b{color:var(--case-muted);font-weight:600}
  .lead360-score{min-width:132px;align-self:center;display:grid;grid-template-columns:auto 1fr;align-items:center;gap:12px;border:1px solid var(--case-line);border-radius:3px;padding:13px 15px;background:rgba(5,7,7,.48)}.lead360-score strong{font:900 2.15rem/1 var(--mono,monospace);letter-spacing:-.08em}.lead360-score span{display:grid;gap:2px}.lead360-score span b{font:900 .72rem var(--mono,monospace);letter-spacing:.08em;text-transform:uppercase}.lead360-score small{color:var(--case-muted);font-size:.59rem}.lead360-score.is-burning{border-color:#a73731;box-shadow:inset 4px 0 var(--case-danger)}.lead360-score.is-burning strong,.lead360-score.is-burning b{color:#ff746a}.lead360-score.is-hot{box-shadow:inset 4px 0 #ed8625}.lead360-score.is-hot strong,.lead360-score.is-hot b{color:#f3a04e}.lead360-score.is-warm{box-shadow:inset 4px 0 var(--case-accent)}.lead360-score.is-warm strong,.lead360-score.is-warm b{color:#f1c66a}.lead360-score.is-quiet,.lead360-score.is-unscored{box-shadow:inset 4px 0 #64706f}
  .lead360-journey{padding:18px 32px 20px;border-bottom:1px solid var(--case-line);background:#101313}.lead360-journey ol{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));list-style:none;padding:0;margin:13px 0 0}.lead360-journey li{position:relative;display:grid;grid-template-columns:31px 1fr;gap:9px;align-items:start;padding-right:15px}.lead360-journey li:not(:last-child)::after{content:"";position:absolute;top:14px;left:31px;right:0;height:1px;background:#343a3a}.lead360-stage-node{position:relative;z-index:1;width:29px;height:29px;display:grid;place-items:center;border:1px solid #4a5150;border-radius:50%;background:#121515;color:#8c9593;font:800 .59rem var(--mono,monospace)}.lead360-stage-copy{display:grid;gap:3px;min-width:0}.lead360-stage-copy strong{font-size:.72rem}.lead360-stage-copy time,.lead360-stage-copy small{color:#78817f;font:600 .55rem var(--mono,monospace)}.lead360-journey .is-complete .lead360-stage-node{border-color:#737d78;color:#dce1db}.lead360-journey .is-current .lead360-stage-node{border-color:var(--case-accent);background:var(--case-accent);color:#141713;box-shadow:0 0 0 4px rgba(239,170,34,.11)}.lead360-journey .is-current .lead360-stage-copy strong{color:var(--case-accent)}.lead360-journey .is-upcoming{opacity:.5}
  .lead360-layout{display:grid;grid-template-columns:minmax(180px,.62fr) minmax(380px,1.45fr) minmax(260px,.88fr);align-items:start}.lead360-column{min-width:0;padding:24px}.lead360-column+.lead360-column{border-left:1px solid var(--case-line)}.lead360-centre{background:#0e1011}.lead360-section{padding-bottom:25px}.lead360-section+.lead360-section{padding-top:24px;border-top:1px solid var(--case-line)}.lead360-section-head{display:flex;align-items:baseline;justify-content:space-between;gap:10px;margin-bottom:16px}.lead360-section h2{font-size:.94rem;letter-spacing:-.01em;margin:5px 0 0}.lead360-section-head>span{color:var(--case-muted);font:600 .57rem var(--mono,monospace)}
  .lead360-timeline{list-style:none;padding:0;margin:0}.lead360-event{position:relative;display:grid;grid-template-columns:17px 1fr;gap:13px;padding-bottom:20px}.lead360-event:not(:last-child)::before{content:"";position:absolute;left:5px;top:12px;bottom:0;width:1px;background:#343a3a}.lead360-event-mark{position:relative;z-index:1;width:11px;height:11px;margin-top:5px;border:2px solid var(--case-accent);border-radius:50%;background:#111415}.lead360-event article{border:1px solid var(--case-line);border-radius:4px;background:var(--case-panel);padding:14px 15px}.lead360-event article header,.lead360-event article footer{display:flex;align-items:center;justify-content:space-between;gap:9px;flex-wrap:wrap}.lead360-evidence-type{color:var(--case-accent);font:850 .57rem var(--mono,monospace);letter-spacing:.11em;text-transform:uppercase}.lead360-progress{border:1px solid #4a4030;background:#211d16;color:#eec16f;padding:2px 6px;font:750 .53rem var(--mono,monospace);text-transform:uppercase}.lead360-event h3{font-size:.82rem;margin:8px 0 4px}.lead360-event p{color:#b6bcba;font-size:.71rem;line-height:1.5;margin:0 0 10px}.lead360-event footer{padding-top:9px;border-top:1px solid #282d2d;color:#7f8886;font:600 .55rem var(--mono,monospace)}.lead360-event footer span:last-child{overflow-wrap:anywhere}
  .lead360-next-move{position:relative;border:1px solid #544426;background:linear-gradient(145deg,#221d14,#171714);padding:17px 16px 15px}.lead360-move-flag{display:inline-block;margin-bottom:9px;color:#17150e;background:var(--case-accent);padding:3px 7px;font:900 .55rem var(--mono,monospace);letter-spacing:.09em;text-transform:uppercase}.lead360-next-move h3{font-size:.92rem;margin:0 0 7px}.lead360-next-move p{color:#c1b9a9;font-size:.71rem;line-height:1.55;margin:0 0 13px}.lead360-next-move>small{display:block;margin-top:12px;color:#8c8679;font-size:.58rem}.lead360-due{display:flex;align-items:center;justify-content:space-between;gap:8px;padding-top:10px;border-top:1px solid #3b3426;color:#c4b99e;font:650 .56rem var(--mono,monospace)}.lead360-due span{color:#8c8679;text-transform:uppercase}
  .lead360-offers,.lead360-consent,.lead360-crm-list{list-style:none;padding:0;margin:0}.lead360-offers{display:grid;gap:9px}.lead360-offers>li{border:1px solid var(--case-line);background:var(--case-panel);padding:13px}.lead360-offer-head{display:flex;align-items:flex-start;justify-content:space-between;gap:8px}.lead360-offer-head strong{font-size:.72rem}.lead360-offer-head>span,.lead360-consent>li>span:nth-child(2),.lead360-crm-list>li>span{border:1px solid #3c4442;padding:2px 5px;font:750 .5rem var(--mono,monospace);text-transform:uppercase;color:#abb1af}.lead360-offer-head .state-accepted,.lead360-consent .state-permitted,.lead360-crm-list .state-won,.lead360-crm-list .state-complete{border-color:#315c47;color:#73c99d}.lead360-offer-head .state-declined,.lead360-consent .state-withdrawn,.lead360-consent .state-suppressed,.lead360-crm-list .state-lost{border-color:#693b38;color:#eb7c73}.lead360-offer-value{color:var(--case-accent);font:800 .64rem var(--mono,monospace);margin-top:5px}.lead360-offers dl{display:grid;gap:5px;margin:10px 0 0}.lead360-offers dl>div{display:grid;grid-template-columns:58px 1fr;gap:7px}.lead360-offers dt{color:#7d8583;font:700 .52rem var(--mono,monospace);text-transform:uppercase}.lead360-offers dd{margin:0;color:#afb5b3;font:600 .54rem var(--mono,monospace)}.lead360-offers p{margin:10px 0 0;padding-top:9px;border-top:1px solid #2b3030;color:#b1b7b5;font-size:.67rem;line-height:1.5}
  .lead360-consent .state-denied,.lead360-crm-list .state-cancelled{border-color:#693b38;color:#eb7c73}.lead360-offer-head .state-requested_contact{border-color:#315c47;color:#73c99d}
  .lead360-suppression{margin-bottom:10px;border:1px solid #6a3935;background:#211413;padding:11px}.lead360-suppression strong{color:#f1847a;font:800 .59rem var(--mono,monospace);text-transform:uppercase}.lead360-suppression p{margin:4px 0 0;color:#c8a5a1;font-size:.66rem}.lead360-consent{display:grid;gap:7px}.lead360-consent li{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:4px 8px;padding:10px;border:1px solid var(--case-line);background:var(--case-panel)}.lead360-consent li>div{display:grid}.lead360-consent strong{font-size:.69rem}.lead360-consent small{color:#7e8785;font-size:.56rem}.lead360-consent time,.lead360-consent .lead360-time-missing{grid-column:1/-1;color:#737c7a;font:600 .52rem var(--mono,monospace)}
  .lead360-crm-block>h3{font:800 .59rem var(--mono,monospace);letter-spacing:.08em;text-transform:uppercase;color:#a7aeac;margin:0 0 8px}.lead360-crm-block>h3:not(:first-child){margin-top:18px}.lead360-crm-list{display:grid;gap:6px}.lead360-crm-list li{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:start;gap:9px;padding:10px 11px;border-left:2px solid #414846;background:#151819}.lead360-crm-list li>div{display:grid;gap:2px}.lead360-crm-list strong{font-size:.68rem}.lead360-crm-list li>div>span{color:#858e8b;font-size:.57rem}.lead360-crm-list time{font:600 .54rem var(--mono,monospace)}
  .lead360-empty{border:1px dashed #3c4342;background:#111414;padding:18px;text-align:left}.lead360-empty strong{display:block;font-size:.7rem;color:#c7ccca}.lead360-empty p{color:#7f8886;font-size:.64rem;line-height:1.5;margin:5px 0 0}.lead360-time-missing{color:#78817f;font:600 .55rem var(--mono,monospace)}.lead360-as-of{padding:11px 32px;border-top:1px solid var(--case-line);background:#090b0c;color:#6e7775;font:600 .55rem var(--mono,monospace);text-align:right}
  @media(max-width:1120px){.lead360-layout{grid-template-columns:minmax(0,1.35fr) minmax(250px,.8fr)}.lead360-left{grid-column:1/-1;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:22px;border-bottom:1px solid var(--case-line)}.lead360-column+.lead360-column{border-left:0}.lead360-right{border-left:1px solid var(--case-line)!important}}
  @media(max-width:760px){.lead360-case-head{grid-template-columns:1fr;padding:25px 21px 21px}.lead360-score{justify-self:start}.lead360-journey{padding:17px 21px}.lead360-journey ol{display:grid;grid-template-columns:1fr;gap:8px}.lead360-journey li:not(:last-child)::after{left:14px;right:auto;top:29px;bottom:-9px;width:1px;height:auto}.lead360-layout{display:block}.lead360-left{display:block}.lead360-column{padding:21px}.lead360-column+.lead360-column,.lead360-right{border-left:0!important;border-top:1px solid var(--case-line)}.lead360-as-of{padding-inline:21px;text-align:left}}
  @media(forced-colors:active){.lead360,.lead360-event article,.lead360-next-move,.lead360-offers>li,.lead360-consent li{forced-color-adjust:auto}.lead360-event-mark,.lead360-stage-node{border:2px solid CanvasText}}
`;

export function renderLead360Body(view: Lead360View): string {
  const band = lead360ScoreBand(view.score);
  const owner = view.identity.ownerName ? escapeHtml(view.identity.ownerName) : 'Unassigned';
  return `<style data-property-predator-lead-360>${LEAD_360_STYLE}</style><article class="lead360" aria-labelledby="lead360-title">
    <header class="lead360-case-head"><div><div class="lead360-kicker">Lead 360 · Evidence case file</div><h1 id="lead360-title">${escapeHtml(view.identity.displayName)}</h1><div class="lead360-contact-line">${contactLine(view.identity)}</div><span class="lead360-owner"><b>CRM owner ·</b> ${owner}</span></div>
      <div class="lead360-score is-${band}" aria-label="Lead score ${escapeHtml(finiteScore(view.score))}, ${escapeHtml(SCORE_LABELS[band])}"><strong>${escapeHtml(finiteScore(view.score))}</strong><span><b>${escapeHtml(SCORE_LABELS[band])}</b><small>Evidence score</small></span></div>
    </header>
    ${stageRail(view.journey)}
    <div class="lead360-layout">
      <aside class="lead360-column lead360-left" aria-label="Lead context"><section class="lead360-section" aria-labelledby="lead360-score-reason"><div class="lead360-section-head"><div><div class="lead360-section-label">Scoring</div><h2 id="lead360-score-reason">Why this score?</h2></div></div>${view.scoreExplanation ? `<p class="lead360-case-note">${escapeHtml(view.scoreExplanation)}</p>` : emptyState('No score explanation', 'A score has not been justified by recorded evidence.')}</section><section class="lead360-section" aria-labelledby="lead360-crm"><div class="lead360-section-head"><div><div class="lead360-section-label">Saved records</div><h2 id="lead360-crm">CRM summary</h2></div></div>${crmSummary(view.crm)}</section></aside>
      <section class="lead360-column lead360-centre" aria-labelledby="lead360-evidence"><div class="lead360-section-head"><div><div class="lead360-section-label">Exact chronology</div><h2 id="lead360-evidence">Engagement evidence</h2></div><span>Newest first</span></div>${evidenceTimeline(view.evidence)}</section>
      <aside class="lead360-column lead360-right" aria-label="Decision rail"><section class="lead360-section" aria-labelledby="lead360-next"><div class="lead360-section-head"><div><div class="lead360-section-label">Human judgement</div><h2 id="lead360-next">Best next move</h2></div></div>${nextMove(view.nextMove)}</section><section class="lead360-section" aria-labelledby="lead360-offers"><div class="lead360-section-head"><div><div class="lead360-section-label">Commercial evidence</div><h2 id="lead360-offers">Offer history</h2></div></div>${offerHistory(view.offers)}</section><section class="lead360-section" aria-labelledby="lead360-consent"><div class="lead360-section-head"><div><div class="lead360-section-label">Contact safety</div><h2 id="lead360-consent">Consent + suppression</h2></div></div>${consentStatus(view.consent, view.suppressionReason)}</section></aside>
    </div>
    <footer class="lead360-as-of">Case file viewed as of ${timestamp(view.asOf)}</footer>
  </article>`;
}
