/**
 * Pure, bounded presentation model for the Growth HQ Operator Action Centre.
 *
 * This slice deliberately has no command service. It assembles operationally
 * shaped TEST facts into one prioritised queue, but it cannot complete, snooze,
 * assign, send, publish, connect or otherwise mutate anything.
 */

export const OPERATOR_ACTION_CENTRE_ROUTE = '/portal/actions' as const;
export const OPERATOR_ACTION_CENTRE_MAX_ACTIONS = 60;
export const OPERATOR_ACTION_CENTRE_MAX_TEXT = 320;
export const OPERATOR_ACTION_CENTRE_MAX_LINK = 260;

export type OperatorActionSource =
  | 'journey'
  | 'inbox'
  | 'content'
  | 'webinar'
  | 'automation'
  | 'provider'
  | 'crm';
export type OperatorActionPriority = 'p0' | 'p1' | 'p2' | 'p3';
export type OperatorActionStatus = 'open' | 'waiting' | 'blocked';
export type OperatorActionTruth = 'simulated' | 'measured' | 'unavailable';
export type OperatorActionSlaState = 'breached' | 'due_now' | 'due_today' | 'on_track' | 'no_target';

export interface OperatorActionEvidenceSnapshot {
  readonly label: string;
  readonly detail: string;
  readonly truth: OperatorActionTruth;
  readonly evidenceRef: string | null;
  readonly observedAt: string | null;
}

export interface OperatorActionSnapshot {
  readonly actionId: string;
  readonly source: OperatorActionSource;
  readonly priority: OperatorActionPriority;
  readonly status: OperatorActionStatus;
  readonly title: string;
  readonly detail: string;
  readonly ownerLabel: string | null;
  readonly ownerTeam: string;
  readonly relatedPersonLabel: string | null;
  readonly signalLabel: string;
  readonly createdAt: string;
  readonly dueAt: string | null;
  readonly blockedBy: string | null;
  readonly deepLink: string;
  readonly deepLinkLabel: string;
  readonly evidence: OperatorActionEvidenceSnapshot;
}

export interface OperatorActionCentreSnapshot {
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly asOf: string;
  readonly environment: 'test';
  readonly datasetKind: 'fictional_test_fixture';
  readonly actions: readonly OperatorActionSnapshot[];
}

export interface OperatorActionView {
  readonly actionId: string;
  readonly indexLabel: string;
  readonly source: OperatorActionSource;
  readonly sourceLabel: string;
  readonly sourceCode: string;
  readonly priority: OperatorActionPriority;
  readonly priorityLabel: string;
  readonly priorityRank: number;
  readonly status: OperatorActionStatus;
  readonly statusLabel: string;
  readonly title: string;
  readonly detail: string;
  readonly ownerLabel: string;
  readonly ownerTeam: string;
  readonly ownerInitials: string;
  readonly ownerAssigned: boolean;
  readonly relatedPersonLabel: string | null;
  readonly signalLabel: string;
  readonly createdAt: string;
  readonly ageLabel: string;
  readonly dueAt: string | null;
  readonly dueLabel: string;
  readonly slaState: OperatorActionSlaState;
  readonly slaLabel: string;
  readonly minutesToDue: number | null;
  readonly needsNow: boolean;
  readonly blockedBy: string | null;
  readonly deepLink: string;
  readonly deepLinkLabel: string;
  readonly deepLinkValid: boolean;
  readonly evidence: Readonly<{
    label: string;
    detail: string;
    truth: OperatorActionTruth;
    truthLabel: string;
    evidenceRef: string | null;
    observedAt: string | null;
    observedLabel: string;
    available: boolean;
  }>;
  readonly inputValid: boolean;
}

export interface OperatorActionSourceSummaryView {
  readonly source: OperatorActionSource;
  readonly label: string;
  readonly code: string;
  readonly total: number;
  readonly breached: number;
  readonly needsNow: number;
}

export interface OperatorActionOwnerSummaryView {
  readonly ownerLabel: string;
  readonly ownerInitials: string;
  readonly total: number;
  readonly needsNow: number;
  readonly breached: number;
}

export interface OperatorActionCentreView {
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly asOf: string;
  readonly asOfLabel: string;
  readonly environment: 'test';
  readonly datasetKind: 'fictional_test_fixture';
  readonly datasetBoundary: 'FICTIONAL TEST FIXTURE · no customer, provider or production records';
  readonly actions: readonly OperatorActionView[];
  readonly needsNow: readonly OperatorActionView[];
  readonly onDeck: readonly OperatorActionView[];
  readonly sources: readonly OperatorActionSourceSummaryView[];
  readonly owners: readonly OperatorActionOwnerSummaryView[];
  readonly headline: Readonly<{
    total: number;
    needsNow: number;
    breached: number;
    blocked: number;
    unassigned: number;
    evidenceUnavailable: number;
  }>;
  readonly integrity: Readonly<{
    coherent: boolean;
    label: 'QUEUE COHERENT' | 'REVIEW INPUT';
    detail: string;
    invalidActions: number;
    duplicateActions: number;
  }>;
  readonly inputTruncated: boolean;
  readonly commandBoundaryAvailable: false;
  readonly mutatingControlsEnabled: false;
  readonly providerEffects: 'none';
}

const SOURCE_META: Readonly<Record<OperatorActionSource, Readonly<{ label: string; code: string }>>> = Object.freeze({
  journey: Object.freeze({ label: 'Journey runtime', code: 'JR' }),
  inbox: Object.freeze({ label: 'Conversion inbox', code: 'IN' }),
  content: Object.freeze({ label: 'Content control', code: 'CO' }),
  webinar: Object.freeze({ label: 'Webinar studio', code: 'WB' }),
  automation: Object.freeze({ label: 'Automation gate', code: 'AU' }),
  provider: Object.freeze({ label: 'Provider readiness', code: 'CX' }),
  crm: Object.freeze({ label: 'CRM task', code: 'CRM' }),
});

const PRIORITY_META: Readonly<Record<OperatorActionPriority, Readonly<{ label: string; rank: number }>>> = Object.freeze({
  p0: Object.freeze({ label: 'P0 · Critical', rank: 0 }),
  p1: Object.freeze({ label: 'P1 · High', rank: 1 }),
  p2: Object.freeze({ label: 'P2 · Normal', rank: 2 }),
  p3: Object.freeze({ label: 'P3 · Low', rank: 3 }),
});

const STATUS_LABELS: Readonly<Record<OperatorActionStatus, string>> = Object.freeze({
  open: 'Open',
  waiting: 'Waiting',
  blocked: 'Blocked',
});

const SOURCE_ORDER: readonly OperatorActionSource[] = Object.freeze([
  'journey', 'inbox', 'content', 'webinar', 'automation', 'provider', 'crm',
]);

function boundedText(value: unknown, max = OPERATOR_ACTION_CENTRE_MAX_TEXT): string {
  return [...String(value ?? '')].slice(0, max).join('');
}

function validInstant(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatInstant(value: string | null): string {
  const instant = validInstant(value);
  if (instant === null) return 'Time unavailable';
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
    hour12: false, timeZone: 'UTC',
  }).format(instant).replace(',', ' ·');
}

function formatDuration(minutes: number): string {
  const safe = Math.max(0, Math.floor(Math.abs(minutes)));
  if (safe < 60) return `${safe}m`;
  const hours = Math.floor(safe / 60);
  const remainder = safe % 60;
  if (hours < 24) return remainder === 0 ? `${hours}h` : `${hours}h ${remainder}m`;
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return remainingHours === 0 ? `${days}d` : `${days}d ${remainingHours}h`;
}

function safePortalLink(value: string): Readonly<{ href: string; valid: boolean }> {
  const bounded = boundedText(value, OPERATOR_ACTION_CENTRE_MAX_LINK);
  if (!bounded.startsWith('/portal') || bounded.startsWith('//') || /[\u0000-\u001f\u007f]/.test(bounded)) {
    return Object.freeze({ href: OPERATOR_ACTION_CENTRE_ROUTE, valid: false });
  }
  try {
    const url = new URL(bounded, 'https://growth-hq.invalid');
    const valid = url.origin === 'https://growth-hq.invalid'
      && (url.pathname === '/portal' || url.pathname.startsWith('/portal/'));
    return Object.freeze({ href: valid ? `${url.pathname}${url.search}${url.hash}` : OPERATOR_ACTION_CENTRE_ROUTE, valid });
  } catch {
    return Object.freeze({ href: OPERATOR_ACTION_CENTRE_ROUTE, valid: false });
  }
}

function initials(value: string): string {
  const words = value.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '—';
  const first = words[0]?.[0] ?? '';
  const second = (words.length > 1 ? words.at(-1)?.[0] : words[0]?.[1]) ?? '';
  return `${first}${second}`.toLocaleUpperCase('en-GB').slice(0, 2) || '—';
}

function evidenceView(evidence: OperatorActionEvidenceSnapshot): OperatorActionView['evidence'] {
  const reference = evidence.evidenceRef === null ? null : boundedText(evidence.evidenceRef, 180);
  const observed = validInstant(evidence.observedAt);
  const available = evidence.truth !== 'unavailable' && reference !== null && reference.length > 0 && observed !== null;
  const truthLabel = evidence.truth === 'simulated'
    ? 'SIMULATED TEST'
    : evidence.truth === 'measured'
      ? 'MEASURED'
      : 'UNAVAILABLE';
  return Object.freeze({
    label: boundedText(evidence.label, 140),
    detail: boundedText(evidence.detail),
    truth: evidence.truth,
    truthLabel,
    evidenceRef: reference,
    observedAt: observed === null ? null : evidence.observedAt,
    observedLabel: observed === null ? 'Observation unavailable' : formatInstant(evidence.observedAt),
    available,
  });
}

function slaView(dueAt: string | null, asOf: number | null): Readonly<{
  state: OperatorActionSlaState;
  label: string;
  minutesToDue: number | null;
  dueLabel: string;
}> {
  const due = validInstant(dueAt);
  if (due === null || asOf === null) {
    return Object.freeze({ state: 'no_target', label: 'NO VALID SLA', minutesToDue: null, dueLabel: 'No valid target' });
  }
  const minutes = Math.floor((due - asOf) / 60_000);
  if (minutes < 0) {
    return Object.freeze({ state: 'breached', label: `BREACHED · ${formatDuration(minutes)}`, minutesToDue: minutes, dueLabel: formatInstant(dueAt) });
  }
  if (minutes <= 120) {
    return Object.freeze({ state: 'due_now', label: `DUE · ${formatDuration(minutes)}`, minutesToDue: minutes, dueLabel: formatInstant(dueAt) });
  }
  if (minutes <= 24 * 60) {
    return Object.freeze({ state: 'due_today', label: `DUE TODAY · ${formatDuration(minutes)}`, minutesToDue: minutes, dueLabel: formatInstant(dueAt) });
  }
  return Object.freeze({ state: 'on_track', label: `ON TRACK · ${formatDuration(minutes)}`, minutesToDue: minutes, dueLabel: formatInstant(dueAt) });
}

function actionView(action: OperatorActionSnapshot, asOf: number | null): OperatorActionView {
  const source = SOURCE_META[action.source];
  const priority = PRIORITY_META[action.priority];
  const sla = slaView(action.dueAt, asOf);
  const ownerLabel = action.ownerLabel === null || action.ownerLabel.trim().length === 0
    ? 'Unassigned'
    : boundedText(action.ownerLabel, 100);
  const ownerAssigned = ownerLabel !== 'Unassigned';
  const created = validInstant(action.createdAt);
  const ageMinutes = created === null || asOf === null ? null : Math.max(0, Math.floor((asOf - created) / 60_000));
  const link = safePortalLink(action.deepLink);
  const evidence = evidenceView(action.evidence);
  const textValid = [
    action.actionId, action.title, action.detail, action.ownerTeam, action.signalLabel,
    action.deepLinkLabel, action.evidence.label, action.evidence.detail,
  ].every((value) => [...String(value)].length <= OPERATOR_ACTION_CENTRE_MAX_TEXT);
  const chronologyValid = created !== null && asOf !== null && created <= asOf
    && (action.dueAt === null || validInstant(action.dueAt) !== null);
  const needsNow = sla.state === 'breached' || sla.state === 'due_now'
    || (action.priority === 'p0' && action.status === 'blocked');
  return Object.freeze({
    actionId: boundedText(action.actionId, 120),
    indexLabel: '',
    source: action.source,
    sourceLabel: source.label,
    sourceCode: source.code,
    priority: action.priority,
    priorityLabel: priority.label,
    priorityRank: priority.rank,
    status: action.status,
    statusLabel: STATUS_LABELS[action.status],
    title: boundedText(action.title, 180),
    detail: boundedText(action.detail),
    ownerLabel,
    ownerTeam: boundedText(action.ownerTeam, 100),
    ownerInitials: initials(ownerLabel),
    ownerAssigned,
    relatedPersonLabel: action.relatedPersonLabel === null ? null : boundedText(action.relatedPersonLabel, 120),
    signalLabel: boundedText(action.signalLabel, 140),
    createdAt: created === null ? action.createdAt : new Date(created).toISOString(),
    ageLabel: ageMinutes === null ? 'Age unavailable' : `${formatDuration(ageMinutes)} old`,
    dueAt: validInstant(action.dueAt) === null ? null : action.dueAt,
    dueLabel: sla.dueLabel,
    slaState: sla.state,
    slaLabel: sla.label,
    minutesToDue: sla.minutesToDue,
    needsNow,
    blockedBy: action.blockedBy === null ? null : boundedText(action.blockedBy, 180),
    deepLink: link.href,
    deepLinkLabel: boundedText(action.deepLinkLabel, 100),
    deepLinkValid: link.valid,
    evidence,
    inputValid: textValid && chronologyValid && link.valid && evidence.available,
  });
}

function slaSortRank(state: OperatorActionSlaState): number {
  return state === 'breached' ? 0 : state === 'due_now' ? 1 : state === 'due_today' ? 2 : state === 'on_track' ? 3 : 4;
}

function compareActions(left: OperatorActionView, right: OperatorActionView): number {
  const sla = slaSortRank(left.slaState) - slaSortRank(right.slaState);
  if (sla !== 0) return sla;
  const priority = left.priorityRank - right.priorityRank;
  if (priority !== 0) return priority;
  const dueLeft = left.minutesToDue ?? Number.MAX_SAFE_INTEGER;
  const dueRight = right.minutesToDue ?? Number.MAX_SAFE_INTEGER;
  if (dueLeft !== dueRight) return dueLeft - dueRight;
  return left.actionId.localeCompare(right.actionId, 'en-GB');
}

/** Assemble, validate and rank a bounded operational TEST queue. */
export function presentOperatorActionCentre(snapshot: OperatorActionCentreSnapshot): OperatorActionCentreView {
  const asOf = validInstant(snapshot.asOf);
  const boundedActions = snapshot.actions.slice(0, OPERATOR_ACTION_CENTRE_MAX_ACTIONS);
  const raw = boundedActions.map((action) => actionView(action, asOf)).sort(compareActions);
  const actions = Object.freeze(raw.map((action, index) => Object.freeze({
    ...action,
    indexLabel: String(index + 1).padStart(2, '0'),
  })));
  const ids = new Set<string>();
  let duplicates = 0;
  for (const action of actions) {
    if (ids.has(action.actionId)) duplicates += 1;
    ids.add(action.actionId);
  }
  const invalidActions = actions.filter((action) => !action.inputValid).length;
  const needsNow = Object.freeze(actions.filter((action) => action.needsNow));
  const onDeck = Object.freeze(actions.filter((action) => !action.needsNow));
  const sources = Object.freeze(SOURCE_ORDER.map((source) => {
    const rows = actions.filter((action) => action.source === source);
    return Object.freeze({
      source,
      label: SOURCE_META[source].label,
      code: SOURCE_META[source].code,
      total: rows.length,
      breached: rows.filter((action) => action.slaState === 'breached').length,
      needsNow: rows.filter((action) => action.needsNow).length,
    });
  }));
  const ownerMap = new Map<string, OperatorActionView[]>();
  for (const action of actions) {
    const owned = ownerMap.get(action.ownerLabel) ?? [];
    owned.push(action);
    ownerMap.set(action.ownerLabel, owned);
  }
  const owners = Object.freeze(
    [...ownerMap.entries()]
      .map(([ownerLabel, rows]) => Object.freeze({
        ownerLabel,
        ownerInitials: initials(ownerLabel),
        total: rows.length,
        needsNow: rows.filter((row) => row.needsNow).length,
        breached: rows.filter((row) => row.slaState === 'breached').length,
      }))
      .sort((left, right) => right.needsNow - left.needsNow
        || right.total - left.total
        || left.ownerLabel.localeCompare(right.ownerLabel, 'en-GB')),
  );
  const inputTruncated = snapshot.actions.length > OPERATOR_ACTION_CENTRE_MAX_ACTIONS;
  const coherent = asOf !== null && invalidActions === 0 && duplicates === 0 && !inputTruncated;
  return Object.freeze({
    workspaceId: boundedText(snapshot.workspaceId, 120),
    workspaceName: boundedText(snapshot.workspaceName, 160),
    asOf: asOf === null ? snapshot.asOf : new Date(asOf).toISOString(),
    asOfLabel: formatInstant(snapshot.asOf),
    environment: 'test',
    datasetKind: 'fictional_test_fixture',
    datasetBoundary: 'FICTIONAL TEST FIXTURE · no customer, provider or production records',
    actions,
    needsNow,
    onDeck,
    sources,
    owners,
    headline: Object.freeze({
      total: actions.length,
      needsNow: needsNow.length,
      breached: actions.filter((action) => action.slaState === 'breached').length,
      blocked: actions.filter((action) => action.status === 'blocked').length,
      unassigned: actions.filter((action) => !action.ownerAssigned).length,
      evidenceUnavailable: actions.filter((action) => !action.evidence.available).length,
    }),
    integrity: Object.freeze({
      coherent,
      label: coherent ? 'QUEUE COHERENT' : 'REVIEW INPUT',
      detail: coherent
        ? 'Every visible TEST action has a unique key, safe portal link, valid SLA chronology and source evidence.'
        : 'One or more actions lost a valid key, portal link, chronology or evidence proof; treat the affected row as advisory.',
      invalidActions,
      duplicateActions: duplicates,
    }),
    inputTruncated,
    commandBoundaryAvailable: false,
    mutatingControlsEnabled: false,
    providerEffects: 'none',
  });
}
