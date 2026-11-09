import { createHmac, timingSafeEqual } from 'node:crypto';
import type {
  JourneyManagerPublicationState,
  JourneyManagerReadSnapshot,
} from '../conversion-pg/journey-manager.js';
import type {
  JourneyDefinitionState,
  JourneyManagerNoticeView,
  JourneyManagerView,
} from './journey-manager-view.js';

export const JOURNEY_MANAGER_ROUTE = '/portal/journeys';
export const JOURNEY_MANAGER_INSTALL_ROUTE = '/portal/journeys/foundation';
export const JOURNEY_MANAGER_CONFIRMATION = 'INSTALL PREDATOR JOURNEYS';

export type JourneyManagerNoticeCode =
  | 'installed'
  | 'replayed'
  | 'forbidden'
  | 'conflict'
  | 'invalid'
  | 'unavailable';

const NOTICE_CODES = new Set<JourneyManagerNoticeCode>([
  'installed', 'replayed', 'forbidden', 'conflict', 'invalid', 'unavailable',
]);
const NOTICE_CONTEXT = 'relaunch72:journey-manager-notice:v1\0';

function noticeMac(secret: string, sessionToken: string, code: JourneyManagerNoticeCode): string {
  return createHmac('sha256', secret)
    .update(NOTICE_CONTEXT)
    .update(sessionToken)
    .update('\0')
    .update(code)
    .digest('base64url');
}

export function journeyManagerNoticeToken(
  secret: string,
  sessionToken: string,
  code: JourneyManagerNoticeCode,
): string {
  if (!secret || !sessionToken || !NOTICE_CODES.has(code)) return '';
  return `${code}.${noticeMac(secret, sessionToken, code)}`;
}

function noticeFor(code: JourneyManagerNoticeCode): JourneyManagerNoticeView {
  if (code === 'installed') return {
    kind: 'success',
    title: 'Journey foundation installed',
    message: 'Both reviewed routes and the shared score model are active. No message, post or provider action was triggered.',
  };
  if (code === 'replayed') return {
    kind: 'info',
    title: 'Foundation already current',
    message: 'The exact immutable definitions were already installed, so the safe replay changed nothing.',
  };
  if (code === 'forbidden') return {
    kind: 'error',
    title: 'Manager access required',
    message: 'Only an active workspace owner or admin can install the journey foundation.',
  };
  if (code === 'conflict') return {
    kind: 'error',
    title: 'Definition conflict protected',
    message: 'Stored definitions differ from the reviewed foundation. Nothing was overwritten and no outbound action ran.',
  };
  if (code === 'invalid') return {
    kind: 'error',
    title: 'Confirmation did not match',
    message: 'No change was made. Refresh the page and type the displayed confirmation exactly.',
  };
  return {
    kind: 'error',
    title: 'Journey setup unavailable',
    message: 'The foundation could not be installed safely. No lead, message, post or provider was touched.',
  };
}

export function journeyManagerNoticeFromQuery(
  query: URLSearchParams,
  secret: string,
  sessionToken: string,
): JourneyManagerNoticeView | undefined {
  const supplied = query.get('notice') ?? '';
  const separator = supplied.indexOf('.');
  if (separator <= 0 || supplied.indexOf('.', separator + 1) !== -1) return undefined;
  const code = supplied.slice(0, separator) as JourneyManagerNoticeCode;
  const mac = supplied.slice(separator + 1);
  if (!NOTICE_CODES.has(code) || !mac || mac.length > 128) return undefined;
  const expected = noticeMac(secret, sessionToken, code);
  const actualBytes = Buffer.from(mac);
  const expectedBytes = Buffer.from(expected);
  if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) return undefined;
  return noticeFor(code);
}

function definitionState(publication: JourneyManagerPublicationState, runtimeReady: boolean): JourneyDefinitionState {
  if (publication === 'published' && runtimeReady) return 'active';
  if (publication === 'missing' || publication === 'draft' || publication === 'outdated') return 'missing';
  return 'drifted';
}

function evidenceLabel(sourceKey: string): string {
  const labels: Readonly<Record<string, string>> = Object.freeze({
    'identity.account.created': 'Account created',
    'product.analysis.completed': 'Analysis completed',
    'offer.presented': 'Offer presented',
    'sales.appointment.booked': 'Appointment booked',
    'sales.presentation.completed': 'Presentation completed',
    payment_collected: 'Collected payment',
  });
  return labels[sourceKey] ?? sourceKey;
}

function enrollmentLabel(slug: string): string {
  return slug === 'property-predator-agency-laps'
    ? 'Appointment-led enrolment'
    : 'Account-led enrolment';
}

export interface JourneyManagerPresentationSecurity {
  readonly csrfToken: string;
  readonly commandKey: string;
}

export function presentJourneyManager(
  snapshot: JourneyManagerReadSnapshot,
  workspaceName: string,
  security: JourneyManagerPresentationSecurity,
  notice?: JourneyManagerNoticeView,
): JourneyManagerView {
  const hasConflict = snapshot.scoreModel.publication === 'conflict'
    || snapshot.routes.some((route) => route.publication === 'conflict');
  const state = snapshot.runtimeReady ? 'ready' : hasConflict ? 'degraded' : 'action_required';
  const setupState = snapshot.runtimeReady ? 'ready' : hasConflict ? 'blocked' : 'available';
  const allocatedByComponent = new Map<string, number>();
  for (const rule of snapshot.scoreModel.rules) {
    allocatedByComponent.set(
      rule.componentKey,
      (allocatedByComponent.get(rule.componentKey) ?? 0) + rule.points,
    );
  }

  return Object.freeze({
    workspaceName,
    asOf: snapshot.snapshotAt,
    state,
    readinessTitle: snapshot.runtimeReady
      ? 'Routes and scoring are active'
      : hasConflict
        ? 'Protected definition drift detected'
        : 'The reviewed foundation needs setup',
    readinessSummary: snapshot.runtimeReady
      ? 'Automatic enrolment, evidence-led advancement and explainable scoring are aligned to the exact published v2 definitions.'
      : hasConflict
        ? 'The stored bytes do not match the reviewed Property Predator contract. Setup is locked so nothing can be overwritten.'
        : 'A workspace manager can publish or exactly replay the two owned routes. This screen never sends or advances a lead itself.',
    routes: Object.freeze(snapshot.routes.map((route) => Object.freeze({
      slug: route.slug,
      label: route.name,
      description: route.description,
      version: route.version,
      state: definitionState(route.publication, route.runtimeReady),
      enrollmentLabel: enrollmentLabel(route.slug),
      milestones: Object.freeze(route.milestones.map((milestone) => Object.freeze({
        key: milestone.key,
        label: milestone.name,
        semantic: milestone.semantic,
        isCompletion: milestone.isCompletion,
      }))),
      triggers: Object.freeze(route.triggers.map((trigger) => Object.freeze({
        kind: trigger.kind,
        sourceKey: trigger.sourceKey,
        milestoneKey: trigger.milestoneKey,
        evidenceLabel: evidenceLabel(trigger.sourceKey),
      }))),
    }))),
    scoring: Object.freeze({
      label: snapshot.scoreModel.name,
      version: snapshot.scoreModel.version,
      state: definitionState(snapshot.scoreModel.publication, snapshot.runtimeReady),
      components: Object.freeze(snapshot.scoreModel.components.map((component) => Object.freeze({
        key: component.key,
        label: component.name,
        maxPoints: component.maxPoints,
        allocatedPoints: allocatedByComponent.get(component.key) ?? 0,
      }))),
      bands: Object.freeze(snapshot.scoreModel.bands.map((band) => Object.freeze({
        key: band.key,
        label: band.name,
        minScore: band.minScore,
        maxScore: band.maxScore,
      }))),
      ruleCount: snapshot.scoreModel.rules.length,
      excludedSignals: Object.freeze(['Consent status', 'CRM stage', 'Task completion', 'Email opens']),
    }),
    setup: Object.freeze({
      state: setupState,
      canManage: snapshot.canManage,
      postAction: JOURNEY_MANAGER_INSTALL_ROUTE,
      ...(setupState === 'available' && snapshot.canManage ? {
        csrfToken: security.csrfToken,
        commandKey: security.commandKey,
        confirmationToken: JOURNEY_MANAGER_CONFIRMATION,
      } : {}),
      ...(hasConflict ? {
        blocker: 'A different immutable definition already occupies this version. An operator must reconcile it; the portal will not guess.',
      } : {}),
    }),
    ...(notice ? { notice } : {}),
  });
}
