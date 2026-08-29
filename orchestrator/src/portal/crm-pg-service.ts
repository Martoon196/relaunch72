import { createHash, randomUUID } from 'node:crypto';
import type { Pool, QueryResultRow } from 'pg';
import {
  CrmCommandError,
  CrmCommandService,
  CrmReadService,
  createPgCrmReadService,
  createPgCrmTransactionRunner,
  type CrmContactReadCursor,
  type CrmOpportunityReadCursor,
  type CrmTaskReadCursor,
  type CrmWorkspaceReadRequest,
  type CrmWorkspaceReadSnapshot,
} from '../crm-pg/index.js';
import {
  createPgGrowthIntelligenceReadService,
  createPgJourneyBoardReadService,
  createPgLead360ReadService,
  type GrowthIntelligenceReadService,
  type GrowthIntelligenceReadSnapshot,
  type GrowthJourneySlug,
  type JourneyBoardCardRead,
  type JourneyBoardReadService,
  type JourneyBoardReadSnapshot,
  type Lead360CaseFileRead,
  type Lead360ReadService,
  type Lead360ScoreRead,
} from '../conversion-pg/index.js';
import { requestDatabaseContext, type DatabaseRequestContext } from '../db/rls.js';
import { InactivePortalSessionError } from '../db/transaction.js';
import type {
  CrmTimelineItemView,
  CrmWorkspaceSnapshot,
  CrmWorkspaceView,
  CreateLeadField,
} from './crm-views.js';
import type {
  PortalCompleteTaskInput,
  PortalCreateLeadInput,
  PortalCrmMutationOutcome,
  PortalCrmRequestIdentity,
  PortalCrmService,
  PortalCrmSnapshotRequest,
  PortalCrmWorkspaceShell,
  PortalJourneyBoardFilters,
  PortalJourneyBoardSnapshot,
  PortalMoveOpportunityInput,
} from './crm-service.js';
import { PortalCrmPageCursorError } from './crm-service.js';
import {
  CRM_PAGE_SIZE,
  crmPageCursorToken,
  verifyCrmPageCursor,
  type CrmPageCursor,
  type CrmPageKind,
  type CrmTaskPageFilter,
} from './crm-pagination.js';
import {
  emptyGrowthIntelligence,
  type GrowthEvidenceKind,
  type GrowthFunnelStageView,
  type GrowthFunnelView,
  type GrowthIntelligenceView,
  type GrowthScoreBand,
  type GrowthTrack,
} from './growth-intelligence.js';
import type {
  Lead360ConsentState,
  Lead360JourneyView,
  Lead360NextMoveView,
  Lead360OfferState,
  Lead360View,
} from './lead-360-view.js';
import type {
  JourneyBoardCardView,
  JourneyBoardDueState,
  JourneyBoardLaneView,
  JourneyBoardOfferState,
} from './journey-board-view.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COMMAND_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const LOCAL_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

export interface PortalCrmPrincipal {
  readonly userId: string;
  readonly workspaceId: string;
}

export interface PortalCrmPrincipalResolver {
  resolve(sessionToken: string): Promise<PortalCrmPrincipal | null>;
}

interface SessionRow extends QueryResultRow {
  user_id: string;
  selected_workspace_id: string;
}

function canonicalUuid(value: unknown): string | null {
  return typeof value === 'string' && UUID_PATTERN.test(value) ? value.toLowerCase() : null;
}

/** Resolve only the hash of an opaque DB session; raw browser tokens never enter a table. */
export function createPgPortalCrmPrincipalResolver(pool: Pick<Pool, 'query'>): PortalCrmPrincipalResolver {
  return {
    async resolve(sessionToken: string): Promise<PortalCrmPrincipal | null> {
      if (!sessionToken || sessionToken.length > 4_096) return null;
      const hash = createHash('sha256').update(sessionToken).digest();
      const result = await pool.query<SessionRow>(
        `/* portal.crm.resolve-session */
         SELECT user_id, selected_workspace_id
         FROM app_private.resolve_session($1)`,
        [hash],
      );
      if (result.rows.length === 0) return null;
      if (result.rows.length !== 1) throw new Error('Portal CRM session resolved more than once');
      const userId = canonicalUuid(result.rows[0]?.user_id);
      const workspaceId = canonicalUuid(result.rows[0]?.selected_workspace_id);
      if (!userId || !workspaceId) throw new Error('Portal CRM session returned invalid identity data');
      return Object.freeze({ userId, workspaceId });
    },
  };
}

function timelineKind(activityType: string): CrmTimelineItemView['kind'] {
  if (activityType === 'crm.lead.created' || activityType === 'crm.contact.created') return 'lead_created';
  if (activityType === 'crm.opportunity.stage_changed') return 'stage_moved';
  if (activityType === 'crm.task.completed') return 'task_completed';
  if (activityType === 'crm.task.created') return 'task_created';
  if (activityType === 'crm.note.created') return 'note';
  return 'other';
}

function mapWorkspace(read: CrmWorkspaceReadSnapshot['workspace']): CrmWorkspaceView {
  return Object.freeze({
    id: read.id,
    name: read.name,
    timezone: read.timezone,
    snapshotAt: read.snapshotAt,
    canWrite: read.canWrite,
  });
}

interface MappedCrmCollectionPage {
  readonly section: 'contacts' | 'pipeline' | 'tasks';
  readonly continuation: boolean;
  readonly hasNextPage: boolean;
  readonly nextCursor: string | null;
}

function mapSnapshot(
  read: CrmWorkspaceReadSnapshot,
  nextKey: () => string,
  page?: MappedCrmCollectionPage,
): CrmWorkspaceSnapshot {
  const pagination = page
    ? Object.freeze({
        [page.section]: Object.freeze({
          continuation: page.continuation,
          hasNextPage: page.hasNextPage,
          nextCursor: page.nextCursor,
          pageSize: CRM_PAGE_SIZE,
        }),
      })
    : undefined;
  return Object.freeze({
    workspace: mapWorkspace(read.workspace),
    contacts: Object.freeze(read.contacts.map((contact) => Object.freeze({
      id: contact.id,
      displayName: contact.displayName,
      companyName: contact.companyName,
      primaryEmail: contact.primaryEmail,
      primaryPhone: contact.primaryPhone,
      lifecycle: contact.lifecycle,
      openOpportunityCount: contact.openOpportunityCount,
      nextTaskAt: contact.nextTask?.dueAt ?? null,
      lastActivityAt: contact.lastActivityAt,
      createdAt: contact.createdAt,
    }))),
    stages: Object.freeze(read.stages.map((stage) => Object.freeze({
      id: stage.id,
      name: stage.name,
      position: stage.position,
      isClosed: stage.stageType !== 'open',
    }))),
    opportunities: Object.freeze(read.opportunities.map((opportunity) => Object.freeze({
      id: opportunity.id,
      contactId: opportunity.contactId,
      contactName: opportunity.contactName,
      companyName: opportunity.companyName,
      title: opportunity.title,
      stageId: opportunity.stageId,
      valueMinor: opportunity.valueMinor,
      currency: opportunity.currency,
      ownerName: opportunity.ownerUserId ? 'Assigned workspace member' : null,
      expectedCloseDate: opportunity.expectedCloseDate,
      nextTaskAt: opportunity.nextTask?.dueAt ?? null,
      updatedAt: opportunity.updatedAt,
      rowVersion: opportunity.rowVersion,
      moveCommandKey: nextKey(),
    }))),
    tasks: Object.freeze(read.tasks.map((task) => Object.freeze({
      id: task.id,
      title: task.title,
      status: task.status,
      contactName: task.contactName,
      opportunityTitle: task.opportunityTitle,
      assigneeName: task.assigneeUserId ? 'Assigned workspace member' : null,
      dueAt: task.dueAt,
      completedAt: task.completedAt,
      rowVersion: task.rowVersion,
      completeCommandKey: nextKey(),
    }))),
    timeline: Object.freeze(read.timeline.map((activity) => Object.freeze({
      id: activity.id,
      kind: timelineKind(activity.activityType),
      summary: activity.subject,
      actorName: null,
      occurredAt: activity.occurredAt,
    }))),
    ...(pagination ? { pagination } : {}),
  });
}

function verifiedReadRequest(
  request: PortalCrmSnapshotRequest | undefined,
  context: DatabaseRequestContext,
  cursorSecret: string,
  sessionToken: string,
): { readonly readRequest: CrmWorkspaceReadRequest | undefined; readonly continuation: boolean } {
  if (!request) return Object.freeze({ readRequest: undefined, continuation: false });
  if (request.section === 'overview') {
    return Object.freeze({ readRequest: { section: 'overview' as const }, continuation: false });
  }

  const expected = request.section === 'tasks'
    ? { workspaceId: context.workspaceId, kind: 'tasks' as const, taskFilter: request.filter as CrmTaskPageFilter }
    : { workspaceId: context.workspaceId, kind: request.section as CrmPageKind };
  const cursor = request.cursor === undefined
    ? null
    : verifyCrmPageCursor(cursorSecret, sessionToken, request.cursor, expected);
  if (request.cursor !== undefined && !cursor) throw new PortalCrmPageCursorError();

  if (request.section === 'contacts') {
    if (cursor && cursor.kind !== 'contacts') throw new PortalCrmPageCursorError();
    return Object.freeze({
      readRequest: {
        section: 'contacts' as const,
        ...(cursor ? { after: { updatedAt: cursor.updatedAt, id: cursor.id } } : {}),
      },
      continuation: Boolean(cursor),
    });
  }
  if (request.section === 'pipeline') {
    if (cursor && cursor.kind !== 'pipeline') throw new PortalCrmPageCursorError();
    return Object.freeze({
      readRequest: {
        section: 'pipeline' as const,
        ...(cursor ? { after: { updatedAt: cursor.updatedAt, id: cursor.id } } : {}),
      },
      continuation: Boolean(cursor),
    });
  }
  if (request.filter !== 'open' && request.filter !== 'completed' && request.filter !== 'all') {
    throw new PortalCrmPageCursorError();
  }
  if (cursor && cursor.kind !== 'tasks') throw new PortalCrmPageCursorError();
  return Object.freeze({
    readRequest: {
      section: 'tasks' as const,
      filter: request.filter,
      ...(cursor
        ? {
            after: {
              statusRank: cursor.statusRank,
              dueAt: cursor.dueAt,
              updatedAt: cursor.updatedAt,
              id: cursor.id,
            },
          }
        : {}),
    },
    continuation: Boolean(cursor),
  });
}

function collectionPage(
  read: CrmWorkspaceReadSnapshot,
  request: PortalCrmSnapshotRequest | undefined,
  cursorSecret: string,
  sessionToken: string,
  continuation: boolean,
): MappedCrmCollectionPage | undefined {
  if (!request || request.section === 'overview') return undefined;
  const pageInfo = request.section === 'contacts'
    ? read.pagination?.contacts
    : request.section === 'pipeline'
      ? read.pagination?.opportunities
      : read.pagination?.tasks;
  if (!pageInfo) throw new Error('CRM collection read did not return bounded page information');

  let cursor: CrmPageCursor | null = null;
  if (pageInfo.hasNextPage) {
    if (!pageInfo.endCursor) throw new Error('CRM collection page omitted its continuation tuple');
    const base = {
      version: 1 as const,
      workspaceId: read.workspace.id,
    };
    cursor = request.section === 'contacts'
      ? {
          ...base,
          kind: 'contacts',
          ...(pageInfo.endCursor as CrmContactReadCursor),
        }
      : request.section === 'pipeline'
        ? {
            ...base,
            kind: 'pipeline',
            ...(pageInfo.endCursor as CrmOpportunityReadCursor),
          }
        : {
            ...base,
            kind: 'tasks',
            filter: request.filter,
            ...(pageInfo.endCursor as CrmTaskReadCursor),
          };
  }
  const nextCursor = cursor ? crmPageCursorToken(cursorSecret, sessionToken, cursor) : null;
  if (cursor && !nextCursor) throw new Error('CRM collection cursor could not be issued');
  return Object.freeze({
    section: request.section,
    continuation,
    hasNextPage: pageInfo.hasNextPage,
    nextCursor,
  });
}

const TRACK_BY_JOURNEY: Readonly<Record<GrowthJourneySlug, GrowthTrack>> = Object.freeze({
  'property-predator-self-serve': 'self_serve',
  'property-predator-agency-laps': 'agency',
});

function scoreBand(score: number | null): GrowthScoreBand {
  if (score === null) return 'unscored';
  if (score >= 70) return 'burning';
  if (score >= 45) return 'hot';
  if (score >= 22) return 'warm';
  return 'quiet';
}

function nextMove(score: number | null, stage: string | null): string {
  const band = scoreBand(score);
  if (band === 'burning') return 'Contact personally within 24 hours after checking channel permission, using the latest recorded signal.';
  if (stage && /priced|presentation/i.test(stage)) return 'Review the exact offer and record the human follow-up.';
  if (band === 'hot') return 'Invite them to the next live Predator Briefing after checking channel permission.';
  return 'Review the evidence and add a human CRM task.';
}

function funnelStages(
  read: GrowthIntelligenceReadSnapshot,
  journeySlug: GrowthJourneySlug,
  defaults: GrowthFunnelView,
): readonly GrowthFunnelStageView[] {
  const rows = read.funnels
    .filter((row) => row.journeySlug === journeySlug)
    .sort((left, right) => left.position - right.position);
  if (!rows.length) return defaults.stages;
  return Object.freeze(rows.map((row) => {
    return Object.freeze({
      key: row.milestoneKey,
      label: row.milestoneName,
      count: row.count,
      // These are independent distinct-contact reach totals, not a cohort.
      // A truthful transition percentage needs enrollment-level transition data.
      stepConversionPercent: null,
      movedInWindow: row.movedInWindow,
    });
  }));
}

function mapGrowthSnapshot(read: GrowthIntelligenceReadSnapshot): GrowthIntelligenceView {
  const empty = emptyGrowthIntelligence(read.asOf);
  const funnels = Object.freeze(empty.funnels.map((defaults) => {
    const slug: GrowthJourneySlug = defaults.track === 'self_serve'
      ? 'property-predator-self-serve'
      : 'property-predator-agency-laps';
    const first = read.funnels.find((row) => row.journeySlug === slug);
    return Object.freeze({
      ...defaults,
      label: first?.journeyName ?? defaults.label,
      description: first?.journeyDescription ?? defaults.description,
      stages: funnelStages(read, slug, defaults),
    });
  }));
  const evidenceTotals = Object.freeze({ ...read.evidenceTotals });
  const hasEvidence = Object.values(evidenceTotals).some((value) => value > 0);
  const hasFunnelMovement = funnels.some((funnel) => funnel.stages.some((stage) => stage.count > 0));
  return Object.freeze({
    dataState: hasEvidence || hasFunnelMovement || read.hotLeads.length > 0 ? 'live' : 'empty',
    asOf: read.asOf,
    windowLabel: read.windowLabel,
    funnels,
    hotLeads: Object.freeze(read.hotLeads.map((lead) => Object.freeze({
      contactId: lead.contactId,
      displayName: lead.displayName,
      companyName: lead.companyName,
      track: TRACK_BY_JOURNEY[lead.journeySlug],
      stage: lead.currentStage ?? 'No stage recorded',
      score: lead.score,
      band: scoreBand(lead.score),
      lastEvidence: lead.evidenceKind && lead.evidenceLabel && lead.evidenceDetail && lead.evidenceAt
        ? Object.freeze({
          kind: lead.evidenceKind as GrowthEvidenceKind,
          label: lead.evidenceLabel,
          detail: lead.evidenceDetail,
          occurredAt: lead.evidenceAt,
        })
        : null,
      contentSummary: lead.contentSummary,
      offerSummary: lead.offerSummary,
      nextMove: nextMove(lead.score, lead.currentStage),
    }))),
    evidenceTotals,
  });
}

function titleCaseKey(value: string): string {
  return value.replace(/[_-]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function moneyLabel(amountMinor: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-GB', {
      style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 2,
    }).format(amountMinor / 100);
  } catch {
    return `${currency} ${(amountMinor / 100).toFixed(2)}`;
  }
}

function lead360ScoreExplanation(score: Lead360ScoreRead | null | undefined): string | null {
  if (!score) return null;
  const components = Object.entries(score.componentScores)
    .map(([key, value]) => `${titleCaseKey(key)} ${value}`);
  const explanation = [...score.reasons, ...components];
  return explanation.length ? explanation.join(' · ') : null;
}

function mapLead360Journey(
  journey: NonNullable<Lead360CaseFileRead['journey']>,
  fallbackScore: Lead360ScoreRead | null,
  isPrimary: boolean,
): Lead360JourneyView {
  const score = journey.score
    ?? (fallbackScore?.enrollmentId === journey.enrollmentId ? fallbackScore : null);
  return Object.freeze({
    label: journey.name,
    isPrimary,
    status: journey.status,
    enrolledAt: journey.enrolledAt,
    lastEventAt: journey.lastEventAt,
    endedAt: journey.endedAt,
    score: score ? Object.freeze({
      total: score.total,
      explanation: lead360ScoreExplanation(score),
      sourceOccurredAt: score.sourceOccurredAt,
      evaluatedAt: score.evaluatedAt,
    }) : null,
    stages: Object.freeze(journey.stages.map((stage) => Object.freeze({
      key: stage.key,
      label: stage.name,
      state: stage.isCurrent ? 'current' as const : stage.reachedAt ? 'complete' as const : 'upcoming' as const,
      reachedAt: stage.reachedAt,
    }))),
  });
}

function lead360NextMove(read: Lead360CaseFileRead): Lead360NextMoveView | null {
  const suppression = read.consent.find((item) => item.state === 'suppressed');
  if (suppression) {
    return Object.freeze({
      label: 'Review the contact block before any outreach',
      reason: suppression.suppressionReason ?? 'A recorded suppression is active on a saved contact channel.',
      dueAt: null,
    });
  }
  const blockedConsent = read.consent.find((item) => item.state === 'denied' || item.state === 'withdrawn');
  if (blockedConsent) {
    return Object.freeze({
      label: 'Review channel permission before any outreach',
      reason: `${titleCaseKey(blockedConsent.channel)} permission is recorded as ${blockedConsent.state}.`,
      dueAt: null,
    });
  }
  const openTask = read.crm.tasks.find((task) => task.status === 'open');
  if (openTask) {
    return Object.freeze({
      label: openTask.title,
      reason: 'This is the next saved human CRM task. Completing it does not send anything automatically.',
      dueAt: openTask.dueAt,
    });
  }
  const latest = read.evidence[0];
  if (!read.score || read.score.total < 22) return null;
  const reason = latest
    ? `Latest recorded signal: ${latest.title}.`
    : `The latest evidence score is ${read.score.total}.`;
  return Object.freeze({
    label: read.score.total >= 70
      ? 'Review this lead personally today'
      : read.score.total >= 45
        ? 'Prepare the next human follow-up'
        : 'Review the latest signal',
    reason,
    dueAt: null,
  });
}

function consentState(state: Lead360CaseFileRead['consent'][number]['state']): Lead360ConsentState {
  return state;
}

function offerState(read: Lead360CaseFileRead['offers'][number]): Lead360OfferState {
  return read.latestResponse?.response ?? 'no_response';
}

function mapLead360(read: Lead360CaseFileRead): Lead360View {
  const journeyReads = read.journeys ?? (read.journey ? [read.journey] : []);
  const primaryEnrollmentId = read.journey?.enrollmentId ?? null;
  const journeys = Object.freeze(journeyReads.map((journey) => mapLead360Journey(
    journey,
    read.score,
    journey.enrollmentId === primaryEnrollmentId,
  )));
  const journey = journeys.find((candidate) => candidate.isPrimary) ?? journeys[0] ?? Object.freeze({
    label: 'No conversion journey',
    stages: Object.freeze([]),
  });
  const suppressionReason = read.consent.find((item) => item.state === 'suppressed')?.suppressionReason ?? null;
  return Object.freeze({
    identity: Object.freeze({
      contactId: read.identity.contactId,
      displayName: read.identity.displayName,
      companyName: read.identity.companyName,
      primaryEmail: read.identity.primaryEmail,
      primaryPhone: read.identity.primaryPhone,
      ownerName: read.identity.ownerUserId ? 'Assigned workspace member' : null,
    }),
    score: read.score?.total ?? null,
    scoreExplanation: lead360ScoreExplanation(read.score),
    primaryJourneyLabel: read.journey?.name ?? null,
    journeys,
    journey,
    evidence: Object.freeze(read.evidence.map((item) => Object.freeze({
      id: item.id,
      kind: item.kind,
      title: item.title,
      detail: item.detail,
      percentage: item.progressBasisPoints === null ? null : item.progressBasisPoints / 100,
      occurredAt: item.occurredAt,
      sourceLabel: item.sourceLabel,
    }))),
    nextMove: lead360NextMove(read),
    offers: Object.freeze(read.offers.map((item) => Object.freeze({
      id: item.id,
      title: item.label,
      valueLabel: moneyLabel(item.priceMinor, item.currency),
      state: offerState(item),
      presentedAt: item.presentedAt,
      responseAt: item.latestResponse?.respondedAt ?? null,
      responseDetail: item.latestResponse ? titleCaseKey(item.latestResponse.response) : null,
    }))),
    consent: Object.freeze(read.consent.map((item) => Object.freeze({
      channelLabel: `${titleCaseKey(item.channel)} · ${item.contactPointLabel ?? item.contactPointValue}`,
      state: consentState(item.state),
      basis: [
        item.purpose ? titleCaseKey(item.purpose) : null,
        item.lawfulBasis ? titleCaseKey(item.lawfulBasis) : null,
        item.isVerified ? 'Verified endpoint' : 'Endpoint not verified',
        item.dedupeState === 'normal' ? null : titleCaseKey(item.dedupeState),
      ].filter((value): value is string => Boolean(value)).join(' · '),
      updatedAt: item.updatedAt,
      endpoint: item.contactPointValue,
      contactPointId: item.contactPointId,
      channel: item.channel,
      purpose: item.purpose,
      evidenceSource: item.consentSource,
      policyVersion: item.policyVersion,
      policyTextSha256: item.policyTextSha256,
      effectiveAt: item.updatedAt,
      recordedAt: item.recordedAt,
      // The ledger stores the operator as an id and the case file has never
      // joined app.users, so the operator is named the same way the record
      // owner is: by identifier, without widening any read privilege.
      recordedBy: item.recordedByActorKind === null
        ? null
        : item.recordedByUserId ?? titleCaseKey(item.recordedByActorKind),
      suppressionState: item.suppressionState,
      suppressionReason: item.suppressionReason,
    }))),
    suppressionReason,
    crm: Object.freeze({
      opportunities: Object.freeze(read.crm.opportunities.map((item) => Object.freeze({
        id: item.id,
        title: item.title,
        stageLabel: item.stageName,
        state: item.status,
        valueLabel: moneyLabel(item.valueMinor, item.currency),
      }))),
      tasks: Object.freeze(read.crm.tasks.map((item) => Object.freeze({
        id: item.id,
        title: item.title,
        state: item.status === 'completed' ? 'complete' as const : item.status,
        dueAt: item.dueAt,
      }))),
    }),
    asOf: read.asOf,
  });
}

const BOARD_BANDS = ['burning', 'hot', 'warm', 'quiet', 'unscored'] as const;

function boardFilter(value: string | undefined, maximum: number): string {
  return (value ?? '').trim().slice(0, maximum);
}

function boardAffiliateLabel(card: JourneyBoardCardRead): string | null {
  const attribution = card.attribution;
  if (!attribution) return null;
  return attribution.affiliateName
    ?? attribution.affiliateCode
    ?? attribution.referralCode
    ?? (attribution.affiliateId || attribution.affiliateSourceId ? 'Affiliate attributed' : null);
}

function boardSourceLabel(card: JourneyBoardCardRead): string {
  const attribution = card.attribution;
  return attribution?.utmSource
    ?? attribution?.channel
    ?? attribution?.sourceSystem
    ?? card.contactSource
    ?? 'Unattributed';
}

function boardOffer(summary: string | null): JourneyBoardCardView['offer'] {
  if (!summary) return null;
  const separator = summary.lastIndexOf(' · ');
  const label = separator > 0 ? summary.slice(0, separator) : summary;
  const rawState = separator > 0 ? summary.slice(separator + 3) : 'shown';
  const state: JourneyBoardOfferState = rawState === 'shown'
    ? 'presented'
    : ['accepted', 'declined', 'deferred', 'requested_contact'].includes(rawState)
      ? rawState as JourneyBoardOfferState
      : 'no_response';
  return Object.freeze({ label, state, valueLabel: null });
}

function boardDueState(dueAt: string | null, asOf: string): JourneyBoardDueState {
  if (!dueAt) return 'none';
  return dueAt < asOf ? 'overdue' : 'due';
}

function mapJourneyBoardCard(
  card: JourneyBoardCardRead,
  read: JourneyBoardReadSnapshot,
  nextCommandKey: () => string,
): JourneyBoardCardView {
  const journey = card.primaryJourney;
  const milestone = journey?.currentMilestone ?? null;
  const score = journey?.score?.total ?? null;
  const task = card.nextTask;
  return Object.freeze({
    id: card.opportunityId,
    contactId: card.contactId,
    laneId: card.stageId,
    displayName: card.contactName,
    companyName: card.companyName,
    ownerName: card.ownerUserId ? 'Assigned workspace member' : null,
    score,
    scoreBand: scoreBand(score),
    sourceLabel: boardSourceLabel(card),
    affiliateLabel: boardAffiliateLabel(card),
    journey: Object.freeze({
      routeKey: journey?.slug ?? 'not-enrolled',
      routeLabel: journey?.name ?? 'Not enrolled',
      stageKey: milestone?.key ?? 'awaiting-enrolment',
      stageLabel: milestone?.name ?? 'Awaiting automatic enrolment',
      stageSemantic: milestone?.semantic ?? 'lead',
      lastAdvancedAt: milestone?.reachedAt ?? null,
      stageAutomatic: milestone?.automatic ?? false,
      otherJourneyCount: journey?.otherEnrollmentCount ?? 0,
      paymentVerifiedSale: milestone?.semantic === 'sale' && milestone.paymentVerified,
    }),
    latestSignal: card.latestEvidence ? Object.freeze({
      kind: card.latestEvidence.kind,
      label: card.latestEvidence.title,
      detail: card.latestEvidence.detail,
      occurredAt: card.latestEvidence.occurredAt,
      progressPercent: card.latestEvidence.progressBasisPoints === null
        ? null
        : card.latestEvidence.progressBasisPoints / 100,
      automatic: card.latestEvidence.automatic,
    }) : null,
    offer: boardOffer(card.offerSummary),
    nextMove: task ? Object.freeze({
      label: task.title,
      dueAt: task.dueAt,
      dueState: boardDueState(task.dueAt, read.asOf),
    }) : score !== null && score >= 22 ? Object.freeze({
      label: nextMove(score, milestone?.name ?? null),
      dueAt: null,
      dueState: 'none' as const,
    }) : null,
    move: read.workspace.canWrite ? Object.freeze({
      commandKey: nextCommandKey(),
      expectedVersion: card.rowVersion,
      allowedLaneIds: Object.freeze(read.stages.map((stage) => stage.id)),
    }) : null,
  });
}

function mapJourneyBoard(
  read: JourneyBoardReadSnapshot,
  filters: PortalJourneyBoardFilters | undefined,
  nextCommandKey: () => string,
): PortalJourneyBoardSnapshot {
  const query = boardFilter(filters?.query, 120);
  const requestedRoute = boardFilter(filters?.route, 100);
  const requestedBand = boardFilter(filters?.band, 20);
  const band = BOARD_BANDS.includes(requestedBand as typeof BOARD_BANDS[number]) ? requestedBand : '';
  const mapped = read.cards.map((card) => mapJourneyBoardCard(card, read, nextCommandKey));
  const routeOptions = new Map<string, string>();
  for (const card of mapped) routeOptions.set(card.journey.routeKey, card.journey.routeLabel);
  const route = routeOptions.has(requestedRoute) ? requestedRoute : '';
  const queryLower = query.toLocaleLowerCase('en-GB');
  const cards = Object.freeze(mapped.filter((card) => {
    if (route && card.journey.routeKey !== route) return false;
    if (band && card.scoreBand !== band) return false;
    if (!queryLower) return true;
    return [card.displayName, card.companyName, card.sourceLabel, card.affiliateLabel]
      .some((value) => value?.toLocaleLowerCase('en-GB').includes(queryLower));
  }));
  const laneCoverageByStage = new Map(read.laneCoverage.map((lane) => [lane.stageId, lane]));
  const lanes: readonly JourneyBoardLaneView[] = Object.freeze(read.stages.map((stage) => {
    const laneCards = cards.filter((card) => card.laneId === stage.id);
    const coverage = laneCoverageByStage.get(stage.id);
    if (!coverage) throw new Error('Journey Board lane coverage is incomplete');
    return Object.freeze({
      id: stage.id,
      label: stage.name,
      description: stage.stageType === 'won'
        ? 'Closed CRM outcome · automatic Sale still requires collected payment.'
        : stage.stageType === 'lost'
          ? 'Closed CRM outcome · journey evidence remains preserved.'
          : 'Team workflow queue · move cards without changing journey evidence.',
      position: stage.position,
      cardCount: laneCards.length,
      totalCardCount: coverage.totalCardCount,
      attentionCount: laneCards.filter((card) => card.nextMove?.dueState === 'overdue'
        || card.scoreBand === 'burning').length,
      isClosed: stage.stageType !== 'open',
      isPartial: coverage.truncated,
    });
  }));
  return Object.freeze({
    workspace: Object.freeze({
      name: read.workspace.name,
      asOf: read.asOf,
      timezone: read.workspace.timezone,
      canWrite: read.workspace.canWrite,
    }),
    filters: Object.freeze({
      query,
      route,
      band,
      routes: Object.freeze([...routeOptions].map(([value, label]) => Object.freeze({ value, label }))),
      bands: Object.freeze(BOARD_BANDS.map((value) => Object.freeze({
        value,
        label: value === 'unscored' ? 'Unscored' : titleCaseKey(value),
      }))),
    }),
    lanes,
    cards,
    coverage: Object.freeze({
      loadedCardCount: read.loadedCardCount,
      totalCardCount: read.totalCardCount,
      perLaneCardLimit: read.perLaneCardLimit,
      partial: read.truncated,
    }),
  });
}

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

function localParts(timestamp: number, timezone: string): LocalParts {
  const formatter = new Intl.DateTimeFormat('en-GB-u-nu-latn', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  const values = new Map(formatter.formatToParts(new Date(timestamp))
    .filter((part) => part.type !== 'literal')
    .map((part) => [part.type, Number(part.value)]));
  return {
    year: values.get('year')!, month: values.get('month')!, day: values.get('day')!,
    hour: values.get('hour')!, minute: values.get('minute')!,
  };
}

function sameLocal(left: LocalParts, right: LocalParts): boolean {
  return left.year === right.year && left.month === right.month && left.day === right.day
    && left.hour === right.hour && left.minute === right.minute;
}

/** Strictly resolve browser wall time, rejecting DST gaps and ambiguous folds. */
export function workspaceLocalDateTime(value: string, timezone: string): string {
  const match = LOCAL_DATE_TIME.exec(value);
  if (!match) throw new Error('Use a complete date and time');
  const wanted: LocalParts = {
    year: Number(match[1]), month: Number(match[2]), day: Number(match[3]),
    hour: Number(match[4]), minute: Number(match[5]),
  };
  const naive = Date.UTC(wanted.year, wanted.month - 1, wanted.day, wanted.hour, wanted.minute);
  const check = new Date(naive);
  if (check.getUTCFullYear() !== wanted.year || check.getUTCMonth() !== wanted.month - 1
      || check.getUTCDate() !== wanted.day || wanted.hour > 23 || wanted.minute > 59) {
    throw new Error('Use a real calendar date and time');
  }

  // Offset samples around the requested day cover DST and all IANA civil zones.
  const offsets = new Set<number>();
  for (const sample of [naive - 86_400_000, naive, naive + 86_400_000]) {
    const shown = localParts(sample, timezone);
    offsets.add(Date.UTC(shown.year, shown.month - 1, shown.day, shown.hour, shown.minute) - sample);
  }
  const matches = [...offsets]
    .map((offset) => naive - offset)
    .filter((candidate, index, all) => all.indexOf(candidate) === index)
    .filter((candidate) => sameLocal(localParts(candidate, timezone), wanted));
  if (matches.length === 0) throw new Error('That local time does not exist because the clocks change');
  if (matches.length > 1) throw new Error('That local time is ambiguous because the clocks change');
  return new Date(matches[0]!).toISOString();
}

function positiveVersion(value: string): number | null {
  return /^(?:[1-9]\d*)$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null;
}

function commandOutcome(error: unknown): PortalCrmMutationOutcome {
  if (error instanceof InactivePortalSessionError) {
    return { ok: false, kind: 'forbidden', message: 'This portal session is no longer active.' };
  }
  if (!(error instanceof CrmCommandError)) {
    return { ok: false, kind: 'unavailable', message: 'The CRM could not safely save that change. No external action was triggered.' };
  }
  if (error.code === 'not_found') return { ok: false, kind: 'not_found', message: 'That CRM record is no longer available in this workspace.' };
  if (error.code === 'optimistic_conflict' || error.code === 'idempotency_key_reused' || error.code === 'command_in_progress') {
    return { ok: false, kind: 'conflict', message: 'The record or command changed after the page loaded. Refresh before trying again.' };
  }
  if (error.code === 'invalid_state') return { ok: false, kind: 'conflict', message: error.message };
  return { ok: false, kind: 'validation', message: 'Check the submitted CRM values and try again.' };
}

export interface PgPortalCrmDependencies {
  /** Server-only key source. Browser session material alone must never forge cursors. */
  cursorSecret: string;
  principalResolver: PortalCrmPrincipalResolver;
  readService: Pick<CrmReadService, 'loadWorkspaceSnapshot'>
    & Partial<Pick<CrmReadService, 'loadWorkspaceCommandContext'>>;
  commandService: Pick<CrmCommandService, 'createLead' | 'moveOpportunityStage' | 'completeTask'>;
  growthReadService?: Pick<GrowthIntelligenceReadService, 'load'>;
  lead360ReadService?: Pick<Lead360ReadService, 'load'>;
  journeyBoardReadService?: Pick<JourneyBoardReadService, 'load'>;
  nextCommandKey?: () => string;
}

export class PgPortalCrmService implements PortalCrmService {
  private readonly nextCommandKey: () => string;

  constructor(private readonly dependencies: PgPortalCrmDependencies) {
    if (dependencies.cursorSecret.length < 32 || dependencies.cursorSecret.length > 4_096) {
      throw new Error('Portal CRM cursor key source must be a server-only value of at least 32 characters');
    }
    this.nextCommandKey = dependencies.nextCommandKey ?? randomUUID;
  }

  private async context(identity: PortalCrmRequestIdentity): Promise<DatabaseRequestContext | null> {
    const principal = await this.dependencies.principalResolver.resolve(identity.sessionToken);
    return principal ? requestDatabaseContext({
      ...principal,
      requestId: identity.requestId,
      portalSessionTokenHash: createHash('sha256').update(identity.sessionToken).digest(),
    }) : null;
  }

  private async commandWorkspace(context: DatabaseRequestContext): Promise<CrmWorkspaceReadSnapshot['workspace']> {
    if (this.dependencies.readService.loadWorkspaceCommandContext) {
      return this.dependencies.readService.loadWorkspaceCommandContext(context);
    }
    // Compatibility for narrow test/custom adapters. The production PostgreSQL
    // service always supplies the one-query command context method above.
    return (await this.dependencies.readService.loadWorkspaceSnapshot(context)).workspace;
  }

  async snapshot(
    identity: PortalCrmRequestIdentity,
    request?: PortalCrmSnapshotRequest,
  ): Promise<CrmWorkspaceSnapshot | null> {
    const context = await this.context(identity);
    if (!context) return null;
    try {
      const verified = verifiedReadRequest(
        request,
        context,
        this.dependencies.cursorSecret,
        identity.sessionToken,
      );
      const read = await this.dependencies.readService.loadWorkspaceSnapshot(context, verified.readRequest);
      return mapSnapshot(
        read,
        this.nextCommandKey,
        collectionPage(
          read,
          request,
          this.dependencies.cursorSecret,
          identity.sessionToken,
          verified.continuation,
        ),
      );
    } catch (error) {
      if (error instanceof InactivePortalSessionError) return null;
      throw error;
    }
  }

  async workspaceShell(identity: PortalCrmRequestIdentity): Promise<PortalCrmWorkspaceShell | null> {
    const context = await this.context(identity);
    if (!context) return null;
    try {
      return Object.freeze({ workspace: mapWorkspace(await this.commandWorkspace(context)) });
    } catch (error) {
      if (error instanceof InactivePortalSessionError) return null;
      throw error;
    }
  }

  async growth(identity: PortalCrmRequestIdentity): Promise<GrowthIntelligenceView | null> {
    const context = await this.context(identity);
    if (!context) return null;
    if (!this.dependencies.growthReadService) return emptyGrowthIntelligence(new Date().toISOString());
    try {
      return mapGrowthSnapshot(await this.dependencies.growthReadService.load(context));
    } catch (error) {
      if (error instanceof InactivePortalSessionError) return null;
      throw error;
    }
  }

  async lead360(identity: PortalCrmRequestIdentity, contactId: string): Promise<Lead360View | null> {
    const canonicalContactId = canonicalUuid(contactId);
    if (!canonicalContactId) return null;
    const context = await this.context(identity);
    if (!context || !this.dependencies.lead360ReadService) return null;
    try {
      const read = await this.dependencies.lead360ReadService.load(context, canonicalContactId);
      return read ? mapLead360(read) : null;
    } catch (error) {
      if (error instanceof InactivePortalSessionError) return null;
      throw error;
    }
  }

  async journeyBoard(
    identity: PortalCrmRequestIdentity,
    filters?: PortalJourneyBoardFilters,
  ): Promise<PortalJourneyBoardSnapshot | null> {
    const context = await this.context(identity);
    if (!context || !this.dependencies.journeyBoardReadService) return null;
    try {
      return mapJourneyBoard(
        await this.dependencies.journeyBoardReadService.load(context),
        filters,
        this.nextCommandKey,
      );
    } catch (error) {
      if (error instanceof InactivePortalSessionError) return null;
      throw error;
    }
  }

  async createLead(identity: PortalCrmRequestIdentity, input: PortalCreateLeadInput): Promise<PortalCrmMutationOutcome> {
    const context = await this.context(identity);
    if (!context) return { ok: false, kind: 'forbidden', message: 'This portal session is no longer active.' };
    const workspace = await this.commandWorkspace(context);
    if (!workspace.canWrite) return { ok: false, kind: 'forbidden', message: 'Your workspace role has read-only CRM access.' };

    const errors: Partial<Record<CreateLeadField, readonly string[]>> = {};
    const displayName = input.displayName.trim();
    const companyName = input.companyName.trim();
    const email = input.email.trim();
    const phone = input.phone.trim();
    const opportunityTitle = input.opportunityTitle.trim();
    const taskTitle = input.taskTitle.trim();
    if (!displayName || displayName.length > 160) errors.display_name = ['Use a contact name between 1 and 160 characters.'];
    if (companyName.length > 160) errors.company_name = ['Keep the company name to 160 characters or fewer.'];
    if (email && (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) errors.email = ['Enter a valid email address.'];
    const normalizedPhone = phone.replace(/[\s().-]/g, '').replace(/^00/, '+');
    if (phone && !/^\+?\d{7,15}$/.test(normalizedPhone)) errors.phone = ['Enter a valid phone number with 7 to 15 digits.'];
    if (!email && !phone) {
      errors.email = ['Add an email address or phone number.'];
      errors.phone = ['Add a phone number or email address.'];
    }
    if (!opportunityTitle || opportunityTitle.length > 180) errors.opportunity_title = ['Use an opportunity name between 1 and 180 characters.'];
    if (!UUID_PATTERN.test(input.stageId)) errors.stage_id = ['Choose a saved open pipeline stage.'];
    if (taskTitle.length > 180) errors.task_title = ['Keep the first task to 180 characters or fewer.'];
    if (input.taskDueAt && !taskTitle) errors.task_title = ['Add a task name when setting a due date.'];
    const invalidCommandKey = !COMMAND_KEY_PATTERN.test(input.commandKey);

    let taskDueAt: string | null = null;
    if (input.taskDueAt) {
      try { taskDueAt = workspaceLocalDateTime(input.taskDueAt, workspace.timezone); }
      catch (error) { errors.task_due_at = [error instanceof Error ? error.message : 'Use a valid due date and time.']; }
    }
    if (Object.keys(errors).length > 0 || invalidCommandKey) {
      return {
        ok: false,
        kind: 'validation',
        message: invalidCommandKey ? 'Refresh the secure form before saving this lead.' : 'Check the highlighted lead details.',
        fieldErrors: errors,
      };
    }
    if (!workspace.defaultPipelineId) {
      return { ok: false, kind: 'unavailable', message: 'This workspace does not have a default CRM pipeline yet.' };
    }

    try {
      const result = await this.dependencies.commandService.createLead(context, {
        commandKey: input.commandKey,
        displayName,
        companyName: companyName || null,
        source: 'portal',
        ownerUserId: context.userId!,
        contactPoints: [
          ...(email ? [{ kind: 'email' as const, value: email, isPrimary: true }] : []),
          ...(phone ? [{ kind: 'phone' as const, value: phone, isPrimary: true }] : []),
        ],
        pipelineId: workspace.defaultPipelineId,
        stageId: input.stageId,
        opportunityName: opportunityTitle,
        currency: workspace.currency,
        task: taskTitle ? { title: taskTitle, assigneeUserId: context.userId!, dueAt: taskDueAt } : null,
      });
      return { ok: true, disposition: result.disposition };
    } catch (error) {
      return commandOutcome(error);
    }
  }

  async moveOpportunity(identity: PortalCrmRequestIdentity, input: PortalMoveOpportunityInput): Promise<PortalCrmMutationOutcome> {
    const context = await this.context(identity);
    if (!context) return { ok: false, kind: 'forbidden', message: 'This portal session is no longer active.' };
    const workspace = await this.commandWorkspace(context);
    if (!workspace.canWrite) return { ok: false, kind: 'forbidden', message: 'Your workspace role has read-only CRM access.' };
    const expectedRowVersion = positiveVersion(input.expectedRowVersion);
    if (!COMMAND_KEY_PATTERN.test(input.commandKey) || !UUID_PATTERN.test(input.opportunityId)
        || !UUID_PATTERN.test(input.targetStageId) || expectedRowVersion === null) {
      return { ok: false, kind: 'validation', message: 'Refresh the pipeline and choose a valid destination stage.' };
    }
    try {
      const result = await this.dependencies.commandService.moveOpportunityStage(context, {
        commandKey: input.commandKey,
        opportunityId: input.opportunityId,
        targetStageId: input.targetStageId,
        expectedRowVersion,
      });
      return { ok: true, disposition: result.disposition };
    } catch (error) {
      return commandOutcome(error);
    }
  }

  async completeTask(identity: PortalCrmRequestIdentity, input: PortalCompleteTaskInput): Promise<PortalCrmMutationOutcome> {
    const context = await this.context(identity);
    if (!context) return { ok: false, kind: 'forbidden', message: 'This portal session is no longer active.' };
    const workspace = await this.commandWorkspace(context);
    if (!workspace.canWrite) return { ok: false, kind: 'forbidden', message: 'Your workspace role has read-only CRM access.' };
    const expectedRowVersion = positiveVersion(input.expectedRowVersion);
    if (!COMMAND_KEY_PATTERN.test(input.commandKey) || !UUID_PATTERN.test(input.taskId) || expectedRowVersion === null) {
      return { ok: false, kind: 'validation', message: 'Refresh the task list before trying again.' };
    }
    try {
      const result = await this.dependencies.commandService.completeTask(context, {
        commandKey: input.commandKey,
        taskId: input.taskId,
        expectedRowVersion,
      });
      return { ok: true, disposition: result.disposition };
    } catch (error) {
      return commandOutcome(error);
    }
  }
}

export function createPgPortalCrmService(input: {
  webPool: Pool;
  commandPool: Pool;
  cursorSecret: string;
}): PgPortalCrmService {
  return new PgPortalCrmService({
    cursorSecret: input.cursorSecret,
    principalResolver: createPgPortalCrmPrincipalResolver(input.webPool),
    readService: createPgCrmReadService(input.webPool),
    growthReadService: createPgGrowthIntelligenceReadService(input.webPool),
    lead360ReadService: createPgLead360ReadService(input.webPool),
    journeyBoardReadService: createPgJourneyBoardReadService(input.webPool),
    commandService: new CrmCommandService({ transactionRunner: createPgCrmTransactionRunner(input.commandPool) }),
  });
}
