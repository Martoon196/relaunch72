/**
 * Pure, read-only Lead 360 rendering.
 *
 * This view consumes a deliberately narrow case-file projection. Provider
 * payloads, delivery credentials and event hashes do not belong in the view
 * model, which makes it harder to leak operational data into the portal.
 */

import { escapeHtml } from './ui.js';
import {
  CONTACT_PERMISSION_CONFIRM_VALUE,
  CONTACT_PERMISSION_ROUTE,
} from './contact-permission-actions.js';
import {
  CONTACT_ENDPOINT_CONFIRM_VALUE,
  CONTACT_ENDPOINT_ATTACH_ROUTE,
  EMAIL_PILOT_AUTHORISE_ROUTE,
  EMAIL_PILOT_POLICY_ROUTE,
  EMAIL_PILOT_PREPARE_ROUTE,
} from './founder-email-pilot-actions.js';

/** Witnessed evidence only, mirroring the 0064 contract. */
const ENDPOINT_EVIDENCE_SOURCES: readonly (readonly [string, string])[] = Object.freeze([
  ['founder.owned_mailbox', 'A mailbox this company owns and controls'],
  ['founder.written_confirmation', 'Written confirmation from the contact'],
  ['founder.signed_form', 'Signed form from the contact'],
  ['founder.verified_reply', 'A verified reply received from this address'],
] as const);

/** Channels this workflow binds a decision to, matching the 0063 contract. */
const PERMISSION_CHANNELS: readonly string[] = Object.freeze(['email', 'sms', 'whatsapp']);

const PERMISSION_DECISIONS: readonly (readonly [string, string])[] = Object.freeze([
  ['granted', 'Grant permission'],
  ['denied', 'Deny permission'],
  ['withdrawn', 'Withdraw permission'],
] as const);

const PERMISSION_LAWFUL_BASES: readonly string[] = Object.freeze([
  'consent', 'legitimate_interests', 'contract',
  'legal_obligation', 'vital_interests', 'public_task',
]);

/**
 * Witnessed evidence only. Inferred signals are deliberately absent from this
 * list so the form cannot offer one.
 */
const PERMISSION_EVIDENCE_SOURCES: readonly (readonly [string, string])[] = Object.freeze([
  ['founder.written_confirmation', 'Written confirmation from the contact'],
  ['founder.recorded_call', 'Recorded call with the contact'],
  ['founder.signed_form', 'Signed form from the contact'],
  ['founder.inbound_request', 'Inbound request from the contact'],
  ['founder.verbal_confirmation', 'Verbal confirmation, witnessed and noted'],
] as const);

/** One blocker the founder must clear before the pilot can be authorised. */
export interface Lead360PilotBlockerView {
  readonly code: string;
  readonly message: string;
}

/** Exactly what would be sent, shown before any authorisation. */
export interface Lead360PilotPreviewView {
  readonly recipientEmail: string;
  readonly recipientVerified: boolean;
  readonly purpose: string;
  readonly dailyUsed: number;
  readonly dailyCap: number;
  readonly monthlyUsed: number;
  readonly monthlyCap: number;
}

export interface Lead360PilotReadinessView {
  readonly ready: boolean;
  readonly blockers: readonly Lead360PilotBlockerView[];
  readonly preview: Lead360PilotPreviewView | null;
}

/**
 * The two preparation steps, shown with everything they will record.
 *
 * The policy is rendered clause by clause, and the message is rendered in full,
 * because a founder confirming a compliance review should read the words that
 * go into the ledger rather than a summary of them.
 */
export interface Lead360PilotPreparationView {
  /** Session-bound action tokens submitted by the buttons, not hidden inputs. */
  readonly prepareToken: string;
  readonly policyToken: string;
  readonly contactPointId: string;
  readonly purpose: string;
  readonly recipientEmail: string;
  readonly subject: string;
  readonly bodyText: string;
  readonly contentPrepared: boolean;
  readonly policyRecorded: boolean;
  /** How the ledger will describe the authority. Never a solicitor's approval. */
  readonly reviewAuthority: string;
  readonly routeClassification: string;
  readonly sender: string;
  readonly instigator: string;
  readonly policyVersion: string;
  readonly policyClauses: readonly {
    readonly ref: string; readonly heading: string; readonly text: string;
  }[];
}

/** The exact resolved message, shown in full before a founder authorises it. */
export interface Lead360PilotAuthorisationView {
  readonly recipientEmail: string;
  readonly subject: string;
  readonly bodyText: string;
  readonly campaignVersionNo: number;
  readonly messageVersionNumber: number;
  readonly authorityValidUntil: string;
  /** Session-bound proof that this exact message was rendered here. */
  readonly previewToken: string;
}

export interface Lead360RenderOptions {
  /** True only when the founder permission command boundary is composed. */
  readonly permissionCommandAvailable?: boolean;
  /** Fresh per-render key, so a double submit replays instead of re-deciding. */
  readonly permissionCommandKey?: string;
  /** True only when the founder endpoint/pilot boundary is composed. */
  readonly endpointCommandAvailable?: boolean;
  readonly endpointCommandKey?: string;
  /** Absent when the pilot has not been evaluated for this contact. */
  readonly pilotReadiness?: Lead360PilotReadinessView | null;
  /** Present only when the exact evidence tuple resolved and a send is offerable. */
  readonly pilotAuthorisation?: Lead360PilotAuthorisationView | null;
  /** The two preparation steps that must precede any authorisation. */
  readonly pilotPreparation?: Lead360PilotPreparationView | null;
  readonly csrfToken?: string;
  // Structural rather than one rail's type: the permission and pilot notices
  // have the same shape and both render here.
  readonly notice?: {
    readonly code: string;
    readonly tone: 'success' | 'warning' | 'danger';
    readonly title: string;
    readonly message: string;
  } | null;
}

export type Lead360ScoreBand = 'burning' | 'hot' | 'warm' | 'quiet' | 'unscored';
export type Lead360StageState = 'complete' | 'current' | 'upcoming';
export type Lead360JourneyStatus = 'active' | 'completed' | 'withdrawn' | 'disqualified';
export type Lead360EvidenceKind =
  | 'watched'
  | 'listened'
  | 'read'
  | 'downloaded'
  | 'product'
  | 'offer'
  | 'reply'
  | 'appointment'
  | 'commerce'
  | 'email';
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

export interface Lead360JourneyScoreView {
  readonly total: number;
  readonly explanation: string | null;
  readonly sourceOccurredAt: string;
  readonly evaluatedAt: string;
}

export interface Lead360JourneyView {
  readonly label: string;
  readonly stages: readonly Lead360JourneyStageView[];
  /** True only for the route that owns the headline score and recommendation context. */
  readonly isPrimary?: boolean;
  /** Runtime metadata is optional so older portal adapters remain source-compatible. */
  readonly status?: Lead360JourneyStatus;
  readonly enrolledAt?: string;
  readonly lastEventAt?: string | null;
  readonly endedAt?: string | null;
  readonly score?: Lead360JourneyScoreView | null;
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
  /** The exact endpoint the decision is bound to, shown in full. */
  readonly endpoint: string;
  readonly contactPointId: string;
  readonly channel: string;
  readonly purpose: string | null;
  /** Evidence a human witnessed, never an inferred signal. */
  readonly evidenceSource: string | null;
  readonly policyVersion: string | null;
  readonly policyTextSha256: string | null;
  /** Effective time versus ledger time; both are shown because they differ. */
  readonly effectiveAt: string | null;
  readonly recordedAt: string | null;
  readonly recordedBy: string | null;
  readonly suppressionState: string | null;
  readonly suppressionReason: string | null;
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
  /** Explicit route context for the headline score and best-next-move panel. */
  readonly primaryJourneyLabel?: string | null;
  /** All active/recent runtime enrollments. Falls back to `journey` when absent. */
  readonly journeys?: readonly Lead360JourneyView[];
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
  email: 'Email',
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

const JOURNEY_STATUS_LABELS: Readonly<Record<Lead360JourneyStatus, string>> = Object.freeze({
  active: 'Active',
  completed: 'Completed',
  withdrawn: 'Withdrawn',
  disqualified: 'Disqualified',
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

function journeyTiming(journey: Lead360JourneyView): string {
  if (!journey.status) return '';
  if (journey.status === 'active') {
    const latest = journey.lastEventAt ?? journey.enrolledAt ?? null;
    return latest
      ? `<span class="lead360-journey-time">Latest event ${timestamp(latest)}</span>`
      : '<span class="lead360-journey-time">No event time recorded</span>';
  }
  return journey.endedAt
    ? `<span class="lead360-journey-time">Ended ${timestamp(journey.endedAt)}</span>`
    : '<span class="lead360-journey-time">End time not recorded</span>';
}

function journeyScore(score: Lead360JourneyScoreView | null | undefined): string {
  if (score === undefined) return '';
  if (score === null) {
    return '<div class="lead360-journey-score is-unscored"><strong>Unscored</strong><span>No score recorded for this enrollment.</span></div>';
  }
  const band = lead360ScoreBand(score.total);
  return `<div class="lead360-journey-score is-${band}"><div><strong>${escapeHtml(finiteScore(score.total))}</strong><span>${escapeHtml(SCORE_LABELS[band])}</span></div>${score.explanation ? `<p>${escapeHtml(score.explanation)}</p>` : '<p>No score explanation recorded.</p>'}<dl><div><dt>Evidence through</dt><dd>${timestamp(score.sourceOccurredAt)}</dd></div><div><dt>Evaluated</dt><dd>${timestamp(score.evaluatedAt)}</dd></div></dl></div>`;
}

function stageRail(journey: Lead360JourneyView): string {
  const status = journey.status
    ? `<span class="lead360-journey-status state-${journey.status}">${escapeHtml(JOURNEY_STATUS_LABELS[journey.status])}</span>`
    : '';
  const stages = journey.stages.length
    ? `<ol>${journey.stages.map((stage, index) => `<li class="is-${stage.state}"${stage.state === 'current' ? ' aria-current="step"' : ''}>
    <span class="lead360-stage-node">${escapeHtml(String(index + 1).padStart(2, '0'))}</span>
    <span class="lead360-stage-copy"><strong>${escapeHtml(stage.label)}</strong>${stage.reachedAt ? timestamp(stage.reachedAt) : `<small>${stage.state === 'upcoming' ? 'Not reached' : 'Time not recorded'}</small>`}</span>
  </li>`).join('')}</ol>`
    : emptyState('No milestones recorded', 'This enrollment has no recorded conversion milestones.');
  const primary = journey.isPrimary
    ? '<span class="lead360-primary-route">Primary route</span>'
    : '';
  return `<nav class="lead360-journey" aria-label="${journey.isPrimary ? 'Primary journey stages' : 'Journey stages'}"${journey.isPrimary ? ' data-primary-route="true"' : ''}><header class="lead360-journey-head"><div><div class="lead360-section-label">${escapeHtml(journey.label)}</div>${journeyTiming(journey)}</div><div class="lead360-journey-flags">${primary}${status}</div></header>${stages}${journeyScore(journey.score)}</nav>`;
}

function journeyRails(view: Lead360View): string {
  const journeys = view.journeys === undefined
    ? (view.journey.stages.length ? [view.journey] : [])
    : view.journeys;
  if (!journeys.length) {
    return emptyState('No journey enrolled', 'This lead has no recorded conversion stage yet.');
  }
  const explicitPrimary = journeys.some((journey) => journey.isPrimary);
  return `<section class="lead360-journeys" aria-label="Conversion journeys">${journeys.map((journey, index) => (
    stageRail(explicitPrimary || index !== 0 ? journey : { ...journey, isPrimary: true })
  )).join('')}</section>`;
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

function nextMove(move: Lead360NextMoveView | null, primaryJourneyLabel: string | null): string {
  if (!move) {
    return emptyState('No evidence-based next move', 'Review the case after a recorded signal or CRM task is added.');
  }
  const routeContext = primaryJourneyLabel
    ? `<div class="lead360-move-route">Primary route · ${escapeHtml(primaryJourneyLabel)}</div>`
    : '<div class="lead360-move-route">Contact-wide context · no primary route</div>';
  return `<div class="lead360-next-move"><div class="lead360-move-flag">Recommended</div>${routeContext}<h3>${escapeHtml(move.label)}</h3><p>${escapeHtml(move.reason)}</p>${move.dueAt ? `<div class="lead360-due"><span>Suggested by</span>${timestamp(move.dueAt)}</div>` : ''}<small>Route context names the score source; consent and CRM tasks remain contact-wide. Nothing has been sent or changed.</small></div>`;
}

function offerHistory(offers: readonly Lead360OfferView[]): string {
  if (!offers.length) {
    return emptyState('No offer history', 'No presented offer or prospect response has been recorded.');
  }
  return `<ol class="lead360-offers">${offers.map((offer) => `<li><div class="lead360-offer-head"><strong>${escapeHtml(offer.title)}</strong><span class="state-${offer.state}">${escapeHtml(OFFER_LABELS[offer.state])}</span></div>${offer.valueLabel ? `<div class="lead360-offer-value">${escapeHtml(offer.valueLabel)}</div>` : ''}<dl><div><dt>Presented</dt><dd>${timestamp(offer.presentedAt)}</dd></div><div><dt>Response</dt><dd>${offer.responseAt ? timestamp(offer.responseAt) : 'No response recorded'}</dd></div></dl>${offer.responseDetail ? `<p>${escapeHtml(offer.responseDetail)}</p>` : ''}</li>`).join('')}</ol>`;
}

function permissionDetail(item: Lead360ConsentView): string {
  const row = (label: string, value: string | null, missing: string): string =>
    `<div><dt>${escapeHtml(label)}</dt><dd>${value === null || value.trim() === ''
      ? `<span class="lead360-time-missing">${escapeHtml(missing)}</span>`
      : escapeHtml(value)}</dd></div>`;
  const suppression = item.suppressionState === null
    ? '<div><dt>Suppression</dt><dd>No suppression recorded</dd></div>'
    : `<div><dt>Suppression</dt><dd><b class="lead360-suppression-state">${escapeHtml(item.suppressionState)}</b>${item.suppressionReason ? ` · ${escapeHtml(item.suppressionReason)}` : ''}</dd></div>`;
  return `<dl class="lead360-permission-detail">
    ${row('Endpoint', item.endpoint, 'Endpoint not recorded')}
    ${row('Purpose', item.purpose, 'No purpose recorded')}
    ${row('Evidence source', item.evidenceSource, 'No evidence source recorded')}
    ${row('Policy version', item.policyVersion, 'No policy version recorded')}
    ${row('Policy digest', item.policyTextSha256, 'No policy digest recorded')}
    ${row('Effective', item.effectiveAt, 'Time not recorded')}
    ${row('Recorded', item.recordedAt, 'Time not recorded')}
    ${row('Recording operator', item.recordedBy, 'Operator not recorded')}
    ${suppression}
  </dl>`;
}

function consentStatus(consent: readonly Lead360ConsentView[], suppressionReason: string | null): string {
  const suppression = suppressionReason
    ? `<div class="lead360-suppression" role="note"><strong>Active suppression</strong><p>${escapeHtml(suppressionReason)}</p></div>`
    : '';
  if (!consent.length) {
    return `${suppression}${emptyState('No channel evidence', 'Consent and suppression status have not been recorded for any channel. Record a decision below to start this contact’s permission history.')}`;
  }
  return `${suppression}<ul class="lead360-consent">${consent.map((item) => `<li><div><strong>${escapeHtml(item.channelLabel)}</strong>${item.basis ? `<small>${escapeHtml(item.basis)}</small>` : '<small>No lawful-basis note recorded</small>'}</div><span class="state-${item.state}">${escapeHtml(CONSENT_LABELS[item.state])}</span>${item.updatedAt ? timestamp(item.updatedAt) : '<span class="lead360-time-missing">Time not recorded</span>'}${permissionDetail(item)}</li>`).join('')}</ul>`;
}

/** Founder-only decision form. Absent entirely unless the boundary is composed. */
/**
 * Attach and verify an email endpoint on this existing contact.
 *
 * Deliberately not "Create a lead": that route would make a second contact and
 * a second opportunity for a person who already has both.
 */
function endpointCommands(
  view: Lead360View,
  options: Lead360RenderOptions,
): string {
  const head = '<div class="lead360-section-head"><div><div class="lead360-section-label">Contact reach</div><h2 id="lead360-endpoint">Attach a verified email endpoint</h2></div></div>';
  if (!options.endpointCommandAvailable) {
    return `<section class="lead360-section" aria-labelledby="lead360-endpoint">${head}<div class="lead360-permission-body"><p>The contact endpoint boundary is not composed for this workspace, so no endpoint can be attached here.</p></div></section>`;
  }
  const csrf = escapeHtml(options.csrfToken ?? '');
  const commandKey = escapeHtml(options.endpointCommandKey ?? '');
  return `<section class="lead360-section" aria-labelledby="lead360-endpoint">${head}
    <div class="lead360-permission-body">
      <p>This attaches an address to the contact already open, with the evidence that verified it. It creates no second contact and no second opportunity, records no permission, and sends nothing.</p>
      <form method="post" action="${CONTACT_ENDPOINT_ATTACH_ROUTE}" autocomplete="off">
        <input type="hidden" name="_csrf" value="${csrf}">
        <input type="hidden" name="command_key" value="${commandKey}">
        <input type="hidden" name="contact_id" value="${escapeHtml(view.identity.contactId)}">
        <label class="lead360-field"><span>Email address</span><input type="email" name="email" required maxlength="320" autocomplete="off"></label>
        <label class="lead360-field"><span>Label, optional</span><input type="text" name="label" maxlength="50" autocomplete="off"></label>
        <label class="lead360-field"><span>Verification evidence</span><select name="evidence_source" required>${ENDPOINT_EVIDENCE_SOURCES.map(([value, label]) => `<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>`).join('')}</select></label>
        <label class="lead360-field"><span>Evidence reference</span><input type="text" name="evidence_reference" required maxlength="200" autocomplete="off"></label>
        <label class="lead360-field"><span>Verified at, UTC instant</span><input type="text" name="verified_at" required maxlength="40" autocomplete="off"></label>
        <label class="lead360-permission-check"><input type="checkbox" name="confirm_endpoint" value="${CONTACT_ENDPOINT_CONFIRM_VALUE}" required> I verified this address belongs to this contact and recorded the evidence above.</label>
        <button class="lead360-permission-button" type="submit">Attach and verify endpoint</button>
      </form>
      <p class="lead360-permission-note">Attaching an endpoint never grants permission and never clears a suppression.</p>
    </div>
  </section>`;
}

/** Why the capped pilot enqueue would refuse, and exactly what would be sent. */
function pilotReadinessPanel(options: Lead360RenderOptions): string {
  const readiness = options.pilotReadiness;
  if (!readiness) return '';
  const head = '<div class="lead360-section-head"><div><div class="lead360-section-label">Founder pilot</div><h2 id="lead360-pilot">Customer email pilot readiness</h2></div></div>';
  const blockers = readiness.blockers.length === 0
    ? '<p class="lead360-pilot-clear">Every dimension is proven. Authorising a send remains a separate, explicit act.</p>'
    : `<ul class="lead360-pilot-blockers">${readiness.blockers.map((blocker) => `<li><b>${escapeHtml(blocker.code)}</b><span>${escapeHtml(blocker.message)}</span></li>`).join('')}</ul>`;
  const preview = readiness.preview === null
    ? '<p class="lead360-time-missing">No recipient is resolved, so there is nothing to preview.</p>'
    : `<dl class="lead360-permission-detail">
      <div><dt>Recipient</dt><dd>${escapeHtml(readiness.preview.recipientEmail)}</dd></div>
      <div><dt>Endpoint verified</dt><dd>${readiness.preview.recipientVerified ? 'Yes' : 'No'}</dd></div>
      <div><dt>Purpose</dt><dd>${escapeHtml(readiness.preview.purpose)}</dd></div>
      <div><dt>Today</dt><dd>${readiness.preview.dailyUsed} of ${readiness.preview.dailyCap} sends used</dd></div>
      <div><dt>This month</dt><dd>${readiness.preview.monthlyUsed} of ${readiness.preview.monthlyCap} sends used</dd></div>
    </dl>`;
  return `<section class="lead360-section" aria-labelledby="lead360-pilot">${head}
    <div class="lead360-permission-body">
      <p>Read-only evidence from the database. This panel cannot queue a job, call Mailgun or send anything.</p>
      ${blockers}
      <h3 class="lead360-pilot-subhead">Exact recipient and caps</h3>
      ${preview}
    </div>
  </section>`;
}

/**
 * The two preparation steps, with everything each will record.
 *
 * Each button carries one short-lived, session-bound action token. Contact and
 * evidence references are derived and verified server-side, where a browser
 * cannot alter them.
 */
function pilotPreparationPanel(
  view: Lead360View,
  options: Lead360RenderOptions,
): string {
  const preparation = options.pilotPreparation;
  if (!preparation) return '';
  const head = '<div class="lead360-section-head"><div><div class="lead360-section-label">Founder pilot</div><h2 id="lead360-prepare">Prepare and review this pilot</h2></div></div>';
  const step = (done: boolean, label: string): string => (done
    ? `<span class="lead360-pilot-step is-done">Done · ${escapeHtml(label)}</span>`
    : `<span class="lead360-pilot-step">Not yet · ${escapeHtml(label)}</span>`);
  const contentForm = preparation.contentPrepared
    ? '<p class="lead360-pilot-clear">The approved campaign version, step, message and both approvals are recorded for this endpoint.</p>'
    : `<form method="post" action="${EMAIL_PILOT_PREPARE_ROUTE}/${escapeHtml(preparation.prepareToken)}" autocomplete="off">
        <button class="lead360-permission-button" type="submit">Prepare approved email</button>
      </form>`;
  const policyForm = preparation.policyRecorded
    ? '<p class="lead360-pilot-clear">The founder and operator compliance review is recorded, with ownership and control evidence marked unchecked.</p>'
    : `<form method="post" action="${EMAIL_PILOT_POLICY_ROUTE}/${escapeHtml(preparation.policyToken)}" autocomplete="off">
        <button class="lead360-permission-button" type="submit">Record compliance review</button>
      </form>`;
  return `<section class="lead360-section" aria-labelledby="lead360-prepare">${head}
    <div class="lead360-permission-body">
      <p class="lead360-pilot-warning"><b>This is a founder and operator compliance review, not legal advice.</b> No solicitor has approved it, and recording it claims no solicitor approval. Neither step below queues anything or calls Mailgun.</p>
      <p>${step(preparation.contentPrepared, 'approved content')} ${step(preparation.policyRecorded, 'compliance review')}</p>
      <h3 class="lead360-pilot-subhead">Step one · the exact message</h3>
      <dl class="lead360-permission-detail">
        <div><dt>To</dt><dd>${escapeHtml(preparation.recipientEmail)}</dd></div>
        <div><dt>Purpose</dt><dd>${escapeHtml(preparation.purpose)}</dd></div>
        <div><dt>Subject</dt><dd>${escapeHtml(preparation.subject)}</dd></div>
      </dl>
      <pre class="lead360-pilot-body">${escapeHtml(preparation.bodyText)}</pre>
      ${contentForm}
      <h3 class="lead360-pilot-subhead">Step two · the policy you are confirming</h3>
      <dl class="lead360-permission-detail">
        <div><dt>Review authority</dt><dd>${escapeHtml(preparation.reviewAuthority)}</dd></div>
        <div><dt>PECR route</dt><dd>${escapeHtml(preparation.routeClassification)}</dd></div>
        <div><dt>Sender</dt><dd>${escapeHtml(preparation.sender)}</dd></div>
        <div><dt>Instigator</dt><dd>${escapeHtml(preparation.instigator)}</dd></div>
        <div><dt>Ownership evidence</dt><dd>None supplied, recorded as unchecked</dd></div>
        <div><dt>Policy version</dt><dd>${escapeHtml(preparation.policyVersion)}</dd></div>
      </dl>
      <ol class="lead360-pilot-policy">${preparation.policyClauses.map((clause) => `<li><b>${escapeHtml(clause.heading)}</b><span>${escapeHtml(clause.text)}</span></li>`).join('')}</ol>
      ${policyForm}
      <p class="lead360-permission-note">Every reference and digest recorded by these steps is derived from the deployed policy, the approved copy, the current permission and this session. None of it is taken from this page.</p>
    </div>
  </section>`;
}

/**
 * The final authorisation: the exact words that would be sent, then one act.
 *
 * The body is rendered in full and escaped. A founder authorising a live send
 * to a real person should read the message, not a summary of it, and should be
 * able to see that the portal is not paraphrasing.
 */
function pilotAuthorisationPanel(
  _view: Lead360View,
  options: Lead360RenderOptions,
): string {
  const authorisation = options.pilotAuthorisation;
  if (!authorisation) return '';
  const head = '<div class="lead360-section-head"><div><div class="lead360-section-label">Founder pilot</div><h2 id="lead360-authorise">Authorise this exact send</h2></div></div>';
  return `<section class="lead360-section" aria-labelledby="lead360-authorise">${head}
    <div class="lead360-permission-body">
      <p>Every piece of evidence the capped rail requires resolved. Read the message below: this is exactly what would be queued, to exactly this address.</p>
      <dl class="lead360-permission-detail">
        <div><dt>To</dt><dd>${escapeHtml(authorisation.recipientEmail)}</dd></div>
        <div><dt>Subject</dt><dd>${escapeHtml(authorisation.subject)}</dd></div>
        <div><dt>Campaign version</dt><dd>v${authorisation.campaignVersionNo}, approved</dd></div>
        <div><dt>Message version</dt><dd>v${authorisation.messageVersionNumber}, approved</dd></div>
        <div><dt>Authority expires</dt><dd>${escapeHtml(authorisation.authorityValidUntil)}</dd></div>
      </dl>
      <h3 class="lead360-pilot-subhead">Full message body</h3>
      <pre class="lead360-pilot-body">${escapeHtml(authorisation.bodyText)}</pre>
      <form method="post" action="${EMAIL_PILOT_AUTHORISE_ROUTE}/${escapeHtml(authorisation.previewToken)}" autocomplete="off">
        <button class="lead360-permission-button" type="submit">Send this email now</button>
      </form>
      <p class="lead360-permission-note">This queues one job on the capped rail. It does not call Mailgun: the existing worker owns dispatch and the signed receipt lands in the Conversion Inbox. Submitting twice replays the same job rather than sending twice.</p>
    </div>
  </section>`;
}

function permissionCommands(
  view: Lead360View,
  options: Lead360RenderOptions,
): string {
  const head = '<div class="lead360-section-head"><div><div class="lead360-section-label">Contact permission</div><h2 id="lead360-permission">Record a permission decision</h2></div></div>';
  if (!options.permissionCommandAvailable) {
    // A sentence rather than a disabled button: with no boundary composed the
    // case file stays entirely control-free, which is the read-only guarantee
    // the rest of this page has always made.
    return `<section class="lead360-section" aria-labelledby="lead360-permission">${head}<div class="lead360-permission-body"><p>The contact permission boundary is not composed for this workspace, so no decision can be recorded here. This page will not imply a permission it cannot prove.</p></div></section>`;
  }
  const endpoints = view.consent.filter((item) => PERMISSION_CHANNELS.includes(item.channel));
  if (!endpoints.length) {
    return `<section class="lead360-section" aria-labelledby="lead360-permission">${head}<div class="lead360-permission-body"><p>This contact has no email, SMS or WhatsApp endpoint to bind a decision to. Add and verify an endpoint first.</p></div></section>`;
  }
  const csrf = escapeHtml(options.csrfToken ?? '');
  const commandKey = escapeHtml(options.permissionCommandKey ?? '');
  const option = (value: string, label: string): string =>
    `<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>`;
  return `<section class="lead360-section" aria-labelledby="lead360-permission">${head}
    <div class="lead360-permission-body">
      <p>A decision is appended to this contact’s permission history for one exact endpoint and purpose. It never queues or sends a message, and it never clears an existing suppression.</p>
      <form method="post" action="${CONTACT_PERMISSION_ROUTE}" autocomplete="off">
        <input type="hidden" name="_csrf" value="${csrf}">
        <input type="hidden" name="command_key" value="${commandKey}">
        <input type="hidden" name="contact_id" value="${escapeHtml(view.identity.contactId)}">
        <label class="lead360-field"><span>Endpoint</span><select name="contact_point_id" required>${endpoints.map((item) => `<option value="${escapeHtml(item.contactPointId)}">${escapeHtml(`${item.channel} · ${item.endpoint}`)}</option>`).join('')}</select></label>
        <label class="lead360-field"><span>Channel</span><select name="channel" required>${PERMISSION_CHANNELS.map((channel) => option(channel, channel)).join('')}</select></label>
        <label class="lead360-field"><span>Purpose</span><input type="text" name="purpose" required maxlength="100" pattern="[a-z][a-z0-9_.-]{0,99}" autocomplete="off"></label>
        <label class="lead360-field"><span>Decision</span><select name="decision" required>${PERMISSION_DECISIONS.map(([value, label]) => option(value, label)).join('')}</select></label>
        <label class="lead360-field"><span>Lawful basis, for a grant only</span><select name="lawful_basis">${['', ...PERMISSION_LAWFUL_BASES].map((basis) => option(basis, basis === '' ? 'Not applicable' : basis)).join('')}</select></label>
        <label class="lead360-field"><span>Evidence source</span><select name="evidence_source" required>${PERMISSION_EVIDENCE_SOURCES.map(([value, label]) => option(value, label)).join('')}</select></label>
        <label class="lead360-field"><span>Policy version</span><input type="text" name="policy_version" maxlength="100" autocomplete="off"></label>
        <label class="lead360-field"><span>Policy text digest, sha256 hex</span><input type="text" name="policy_text_sha256" maxlength="64" pattern="[0-9a-f]{64}" autocomplete="off"></label>
        <label class="lead360-field"><span>Evidence reference</span><input type="text" name="source_event_id" maxlength="255" autocomplete="off"></label>
        <label class="lead360-field"><span>Effective time, UTC instant</span><input type="text" name="occurred_at" required maxlength="40" autocomplete="off"></label>
        <label class="lead360-permission-check"><input type="checkbox" name="confirm_permission" value="${CONTACT_PERMISSION_CONFIRM_VALUE}" required> I witnessed this decision from the contact and am recording it as evidence.</label>
        <button class="lead360-permission-button" type="submit">Record permission decision</button>
      </form>
      <p class="lead360-permission-note">Permission is never inferred from a login, account creation, CRM stage, opportunity, previous send or site activity.</p>
    </div>
  </section>`;
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
  .lead360-journeys>.lead360-journey:last-child{border-bottom:1px solid var(--case-line)}.lead360-journey[data-primary-route="true"]{box-shadow:inset 5px 0 var(--case-accent)}.lead360-journey-head{display:flex;align-items:flex-start;justify-content:space-between;gap:14px}.lead360-journey-head>div{display:grid;gap:5px}.lead360-journey-flags{display:flex!important;grid-auto-flow:column;align-items:center;gap:6px}.lead360-primary-route{border:1px solid var(--case-accent);padding:3px 7px;color:var(--case-accent);font:900 .53rem var(--mono,monospace);letter-spacing:.07em;text-transform:uppercase}.lead360-journey-time{color:#7f8886;font:600 .55rem var(--mono,monospace)}.lead360-journey-status{border:1px solid #46504d;padding:3px 7px;color:#b8bfbc;font:800 .53rem var(--mono,monospace);letter-spacing:.07em;text-transform:uppercase}.lead360-journey-status.state-active{border-color:#6c562b;color:#efc36a}.lead360-journey-status.state-completed{border-color:#315c47;color:#73c99d}.lead360-journey-status.state-withdrawn,.lead360-journey-status.state-disqualified{border-color:#693b38;color:#eb7c73}.lead360-journey-score{display:grid;grid-template-columns:auto minmax(180px,1fr) auto;align-items:center;gap:13px;margin-top:15px;padding:11px 12px;border:1px solid #303737;background:#0c0f0f}.lead360-journey-score>div:first-child{display:grid;grid-template-columns:auto auto;align-items:baseline;gap:7px}.lead360-journey-score>div:first-child strong{font:900 1.15rem var(--mono,monospace)}.lead360-journey-score>div:first-child span{color:var(--case-accent);font:800 .54rem var(--mono,monospace);text-transform:uppercase}.lead360-journey-score>p{margin:0;color:#adb4b1;font-size:.65rem;line-height:1.4}.lead360-journey-score>dl{display:grid;gap:4px;margin:0}.lead360-journey-score>dl>div{display:grid;grid-template-columns:auto auto;gap:5px}.lead360-journey-score dt{color:#747d7a;font:700 .49rem var(--mono,monospace);text-transform:uppercase}.lead360-journey-score dd{margin:0;color:#929b98;font:600 .5rem var(--mono,monospace)}.lead360-journey-score.is-unscored{grid-template-columns:auto 1fr}.lead360-journey-score.is-unscored>span{color:#7f8886;font-size:.61rem}
  .lead360-layout{display:grid;grid-template-columns:minmax(180px,.62fr) minmax(380px,1.45fr) minmax(260px,.88fr);align-items:start}.lead360-column{min-width:0;padding:24px}.lead360-column+.lead360-column{border-left:1px solid var(--case-line)}.lead360-centre{background:#0e1011}.lead360-section{padding-bottom:25px}.lead360-section+.lead360-section{padding-top:24px;border-top:1px solid var(--case-line)}.lead360-section-head{display:flex;align-items:baseline;justify-content:space-between;gap:10px;margin-bottom:16px}.lead360-section h2{font-size:.94rem;letter-spacing:-.01em;margin:5px 0 0}.lead360-section-head>span{color:var(--case-muted);font:600 .57rem var(--mono,monospace)}
  .lead360-timeline{list-style:none;padding:0;margin:0}.lead360-event{position:relative;display:grid;grid-template-columns:17px 1fr;gap:13px;padding-bottom:20px}.lead360-event:not(:last-child)::before{content:"";position:absolute;left:5px;top:12px;bottom:0;width:1px;background:#343a3a}.lead360-event-mark{position:relative;z-index:1;width:11px;height:11px;margin-top:5px;border:2px solid var(--case-accent);border-radius:50%;background:#111415}.lead360-event article{border:1px solid var(--case-line);border-radius:4px;background:var(--case-panel);padding:14px 15px}.lead360-event article header,.lead360-event article footer{display:flex;align-items:center;justify-content:space-between;gap:9px;flex-wrap:wrap}.lead360-evidence-type{color:var(--case-accent);font:850 .57rem var(--mono,monospace);letter-spacing:.11em;text-transform:uppercase}.lead360-progress{border:1px solid #4a4030;background:#211d16;color:#eec16f;padding:2px 6px;font:750 .53rem var(--mono,monospace);text-transform:uppercase}.lead360-event h3{font-size:.82rem;margin:8px 0 4px}.lead360-event p{color:#b6bcba;font-size:.71rem;line-height:1.5;margin:0 0 10px}.lead360-event footer{padding-top:9px;border-top:1px solid #282d2d;color:#7f8886;font:600 .55rem var(--mono,monospace)}.lead360-event footer span:last-child{overflow-wrap:anywhere}
  .lead360-next-move{position:relative;border:1px solid #544426;background:linear-gradient(145deg,#221d14,#171714);padding:17px 16px 15px}.lead360-move-flag{display:inline-block;margin-bottom:7px;color:#17150e;background:var(--case-accent);padding:3px 7px;font:900 .55rem var(--mono,monospace);letter-spacing:.09em;text-transform:uppercase}.lead360-move-route{margin:0 0 11px;color:#efc36a;font:800 .55rem var(--mono,monospace);letter-spacing:.04em}.lead360-next-move h3{font-size:.92rem;margin:0 0 7px}.lead360-next-move p{color:#c1b9a9;font-size:.71rem;line-height:1.55;margin:0 0 13px}.lead360-next-move>small{display:block;margin-top:12px;color:#8c8679;font-size:.58rem}.lead360-due{display:flex;align-items:center;justify-content:space-between;gap:8px;padding-top:10px;border-top:1px solid #3b3426;color:#c4b99e;font:650 .56rem var(--mono,monospace)}.lead360-due span{color:#8c8679;text-transform:uppercase}
  .lead360-offers,.lead360-consent,.lead360-crm-list{list-style:none;padding:0;margin:0}.lead360-offers{display:grid;gap:9px}.lead360-offers>li{border:1px solid var(--case-line);background:var(--case-panel);padding:13px}.lead360-offer-head{display:flex;align-items:flex-start;justify-content:space-between;gap:8px}.lead360-offer-head strong{font-size:.72rem}.lead360-offer-head>span,.lead360-consent>li>span:nth-child(2),.lead360-crm-list>li>span{border:1px solid #3c4442;padding:2px 5px;font:750 .5rem var(--mono,monospace);text-transform:uppercase;color:#abb1af}.lead360-offer-head .state-accepted,.lead360-consent .state-permitted,.lead360-crm-list .state-won,.lead360-crm-list .state-complete{border-color:#315c47;color:#73c99d}.lead360-offer-head .state-declined,.lead360-consent .state-withdrawn,.lead360-consent .state-suppressed,.lead360-crm-list .state-lost{border-color:#693b38;color:#eb7c73}.lead360-offer-value{color:var(--case-accent);font:800 .64rem var(--mono,monospace);margin-top:5px}.lead360-offers dl{display:grid;gap:5px;margin:10px 0 0}.lead360-offers dl>div{display:grid;grid-template-columns:58px 1fr;gap:7px}.lead360-offers dt{color:#7d8583;font:700 .52rem var(--mono,monospace);text-transform:uppercase}.lead360-offers dd{margin:0;color:#afb5b3;font:600 .54rem var(--mono,monospace)}.lead360-offers p{margin:10px 0 0;padding-top:9px;border-top:1px solid #2b3030;color:#b1b7b5;font-size:.67rem;line-height:1.5}
  .lead360-consent .state-denied,.lead360-crm-list .state-cancelled{border-color:#693b38;color:#eb7c73}.lead360-offer-head .state-requested_contact{border-color:#315c47;color:#73c99d}
  .lead360-suppression{margin-bottom:10px;border:1px solid #6a3935;background:#211413;padding:11px}.lead360-suppression strong{color:#f1847a;font:800 .59rem var(--mono,monospace);text-transform:uppercase}.lead360-suppression p{margin:4px 0 0;color:#c8a5a1;font-size:.66rem}.lead360-consent{display:grid;gap:7px}.lead360-consent li{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:4px 8px;padding:10px;border:1px solid var(--case-line);background:var(--case-panel)}.lead360-consent li>div{display:grid}.lead360-consent strong{font-size:.69rem}.lead360-consent small{color:#7e8785;font-size:.56rem}.lead360-consent time,.lead360-consent .lead360-time-missing{grid-column:1/-1;color:#737c7a;font:600 .52rem var(--mono,monospace)}
  .lead360-crm-block>h3{font:800 .59rem var(--mono,monospace);letter-spacing:.08em;text-transform:uppercase;color:#a7aeac;margin:0 0 8px}.lead360-crm-block>h3:not(:first-child){margin-top:18px}.lead360-crm-list{display:grid;gap:6px}.lead360-crm-list li{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:start;gap:9px;padding:10px 11px;border-left:2px solid #414846;background:#151819}.lead360-crm-list li>div{display:grid;gap:2px}.lead360-crm-list strong{font-size:.68rem}.lead360-crm-list li>div>span{color:#858e8b;font-size:.57rem}.lead360-crm-list time{font:600 .54rem var(--mono,monospace)}
  .lead360-notice{margin:0;padding:13px 32px;border-bottom:1px solid var(--case-line);background:#101414}.lead360-notice strong{display:block;font:800 .62rem var(--mono,monospace);letter-spacing:.08em;text-transform:uppercase}.lead360-notice p{margin:5px 0 0;color:#9aa3a1;font-size:.66rem;line-height:1.5}.lead360-notice.is-success strong{color:#7fd7a4}.lead360-notice.is-warning strong{color:#f1c66a}.lead360-notice.is-danger strong{color:#ff746a}
  .lead360-permission-detail{grid-column:1/-1;display:grid;gap:3px;margin:8px 0 0;padding:8px 0 0;border-top:1px solid #23292a}.lead360-permission-detail>div{display:grid;grid-template-columns:minmax(96px,34%) minmax(0,1fr);gap:8px}.lead360-permission-detail dt{color:#78817f;font:600 .53rem var(--mono,monospace);text-transform:uppercase;letter-spacing:.06em}.lead360-permission-detail dd{margin:0;color:#c7ccca;font-size:.6rem;line-height:1.45;overflow-wrap:anywhere}.lead360-suppression-state{color:#f1847a;text-transform:uppercase;font:800 .55rem var(--mono,monospace)}
  .lead360-permission-body{display:grid;gap:11px}.lead360-permission-body p{color:#8f9996;font-size:.64rem;line-height:1.5;margin:0}.lead360-permission-body form{display:grid;gap:9px}.lead360-field{display:block;color:var(--case-ink);font-size:.62rem;line-height:1.5}.lead360-field span{display:block;color:#78817f;margin:0 0 4px}.lead360-field input,.lead360-field select{display:block;width:100%;min-height:44px;box-sizing:border-box;padding:0 10px;background:var(--case-bg);border:1px solid var(--case-line);border-radius:8px;color:var(--case-ink);font:inherit}.lead360-permission-check{display:flex;align-items:flex-start;gap:9px;min-height:44px;color:#c7ccca;font-size:.62rem;line-height:1.45}.lead360-permission-check input{width:24px;height:24px;margin-top:2px;flex:none}.lead360-permission-button{min-height:44px;padding:0 16px;border:1px solid var(--case-accent);border-radius:8px;background:transparent;color:var(--case-accent);font:800 .64rem var(--mono,monospace);letter-spacing:.06em;text-transform:uppercase;cursor:pointer}.lead360-permission-button[disabled]{border-color:#3c4342;color:#6e7775;cursor:not-allowed}.lead360-permission-note{color:#78817f;font-size:.58rem;line-height:1.5;margin:0}.lead360 :is(a,button,input,select):focus-visible{outline:2px solid var(--case-accent);outline-offset:2px}
  .lead360-pilot-blockers{display:grid;gap:6px;margin:0;padding:0;list-style:none}.lead360-pilot-blockers li{display:grid;gap:2px;padding:8px;border:1px solid #6a3935;background:#211413}.lead360-pilot-blockers b{color:#f1847a;font:800 .55rem var(--mono,monospace);letter-spacing:.06em}.lead360-pilot-blockers span{color:#c8a5a1;font-size:.62rem;line-height:1.45}.lead360-pilot-clear{color:#7fd7a4;font-size:.64rem;line-height:1.5;margin:0}.lead360-pilot-subhead{margin:10px 0 6px;color:#78817f;font:600 .55rem var(--mono,monospace);text-transform:uppercase;letter-spacing:.06em}
  .lead360-pilot-body{margin:0 0 12px;padding:12px;border:1px solid var(--case-line);background:#0c0f0f;color:#c7ccca;font:400 .64rem/1.6 var(--mono,monospace);white-space:pre-wrap;overflow-wrap:anywhere;max-height:340px;overflow-y:auto}
  .lead360-pilot-warning{margin:0 0 10px;padding:10px;border:1px solid #6a5935;background:#1b1608;color:#e6cf95;font-size:.64rem;line-height:1.5}.lead360-pilot-warning b{color:#f3ca73}
  .lead360-pilot-step{display:inline-block;margin:0 6px 6px 0;padding:3px 7px;border:1px solid var(--case-line);color:#8b9491;font:700 .55rem var(--mono,monospace);letter-spacing:.05em;text-transform:uppercase}.lead360-pilot-step.is-done{border-color:#2f746c;color:#7fd7a4}
  .lead360-pilot-policy{display:grid;gap:8px;margin:0 0 12px;padding:0 0 0 18px}.lead360-pilot-policy li{color:#9aa3a1;font-size:.63rem;line-height:1.5}.lead360-pilot-policy b{display:block;color:#c7ccca;font-size:.66rem;margin-bottom:2px}
  .lead360-empty{border:1px dashed #3c4342;background:#111414;padding:18px;text-align:left}.lead360-empty strong{display:block;font-size:.7rem;color:#c7ccca}.lead360-empty p{color:#7f8886;font-size:.64rem;line-height:1.5;margin:5px 0 0}.lead360-time-missing{color:#78817f;font:600 .55rem var(--mono,monospace)}.lead360-as-of{padding:11px 32px;border-top:1px solid var(--case-line);background:#090b0c;color:#6e7775;font:600 .55rem var(--mono,monospace);text-align:right}
  @media(max-width:1120px){.lead360-layout{grid-template-columns:minmax(0,1.35fr) minmax(250px,.8fr)}.lead360-left{grid-column:1/-1;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:22px;border-bottom:1px solid var(--case-line)}.lead360-column+.lead360-column{border-left:0}.lead360-right{border-left:1px solid var(--case-line)!important}}
  @media(max-width:760px){.lead360-case-head{grid-template-columns:1fr;padding:25px 21px 21px}.lead360-score{justify-self:start}.lead360-journey{padding:17px 21px}.lead360-journey ol{display:grid;grid-template-columns:1fr;gap:8px}.lead360-journey li:not(:last-child)::after{left:14px;right:auto;top:29px;bottom:-9px;width:1px;height:auto}.lead360-journey-score{grid-template-columns:1fr}.lead360-layout{display:block}.lead360-left{display:block}.lead360-column{padding:21px}.lead360-column+.lead360-column,.lead360-right{border-left:0!important;border-top:1px solid var(--case-line)}.lead360-as-of{padding-inline:21px;text-align:left}}
  @media(forced-colors:active){.lead360,.lead360-event article,.lead360-next-move,.lead360-offers>li,.lead360-consent li{forced-color-adjust:auto}.lead360-event-mark,.lead360-stage-node{border:2px solid CanvasText}}
`;

export function renderLead360Body(
  view: Lead360View,
  options: Lead360RenderOptions = {},
): string {
  const band = lead360ScoreBand(view.score);
  const notice = options.notice
    ? `<div class="lead360-notice is-${escapeHtml(options.notice.tone)}" role="status" aria-live="polite"><strong>${escapeHtml(options.notice.title)}</strong><p>${escapeHtml(options.notice.message)}</p></div>`
    : '';
  const owner = view.identity.ownerName ? escapeHtml(view.identity.ownerName) : 'Unassigned';
  const primaryJourneyLabel = view.primaryJourneyLabel === undefined
    ? ((view.journeys?.find((journey) => journey.isPrimary) ?? view.journey).stages.length
      ? (view.journeys?.find((journey) => journey.isPrimary) ?? view.journey).label
      : null)
    : view.primaryJourneyLabel;
  const scoreContext = primaryJourneyLabel ? `Primary route · ${primaryJourneyLabel}` : 'No primary route';
  return `<style data-property-predator-lead-360>${LEAD_360_STYLE}</style><article class="lead360" aria-labelledby="lead360-title">${notice}
    <header class="lead360-case-head"><div><div class="lead360-kicker">Lead 360 · Evidence case file</div><h1 id="lead360-title">${escapeHtml(view.identity.displayName)}</h1><div class="lead360-contact-line">${contactLine(view.identity)}</div><span class="lead360-owner"><b>CRM owner ·</b> ${owner}</span></div>
      <div class="lead360-score is-${band}" aria-label="Primary journey score ${escapeHtml(finiteScore(view.score))}, ${escapeHtml(SCORE_LABELS[band])}. ${escapeHtml(scoreContext)}"><strong>${escapeHtml(finiteScore(view.score))}</strong><span><b>${escapeHtml(SCORE_LABELS[band])}</b><small>${escapeHtml(scoreContext)}</small></span></div>
    </header>
    ${journeyRails(view)}
    <div class="lead360-layout">
      <aside class="lead360-column lead360-left" aria-label="Lead context"><section class="lead360-section" aria-labelledby="lead360-score-reason"><div class="lead360-section-head"><div><div class="lead360-section-label">Scoring</div><h2 id="lead360-score-reason">Why this score?</h2></div></div>${view.scoreExplanation ? `<p class="lead360-case-note">${escapeHtml(view.scoreExplanation)}</p>` : emptyState('No score explanation', 'A score has not been justified by recorded evidence.')}</section><section class="lead360-section" aria-labelledby="lead360-crm"><div class="lead360-section-head"><div><div class="lead360-section-label">Saved records</div><h2 id="lead360-crm">CRM summary</h2></div></div>${crmSummary(view.crm)}</section></aside>
      <section class="lead360-column lead360-centre" aria-labelledby="lead360-evidence"><div class="lead360-section-head"><div><div class="lead360-section-label">Exact chronology</div><h2 id="lead360-evidence">Engagement evidence</h2></div><span>Newest first</span></div>${evidenceTimeline(view.evidence)}</section>
      <aside class="lead360-column lead360-right" aria-label="Decision rail"><section class="lead360-section" aria-labelledby="lead360-next"><div class="lead360-section-head"><div><div class="lead360-section-label">Human judgement</div><h2 id="lead360-next">Best next move</h2></div></div>${nextMove(view.nextMove, primaryJourneyLabel)}</section><section class="lead360-section" aria-labelledby="lead360-offers"><div class="lead360-section-head"><div><div class="lead360-section-label">Commercial evidence</div><h2 id="lead360-offers">Offer history</h2></div></div>${offerHistory(view.offers)}</section><section class="lead360-section" aria-labelledby="lead360-consent"><div class="lead360-section-head"><div><div class="lead360-section-label">Contact safety</div><h2 id="lead360-consent">Consent + suppression</h2></div></div>${consentStatus(view.consent, view.suppressionReason)}</section>${permissionCommands(view, options)}${endpointCommands(view, options)}${pilotReadinessPanel(options)}${pilotPreparationPanel(view, options)}${pilotAuthorisationPanel(view, options)}</aside>
    </div>
    <footer class="lead360-as-of">Case file viewed as of ${timestamp(view.asOf)}</footer>
  </article>`;
}
