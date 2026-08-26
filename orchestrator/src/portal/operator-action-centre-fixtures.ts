import type {
  OperatorActionCentreSnapshot,
  OperatorActionEvidenceSnapshot,
  OperatorActionSnapshot,
  OperatorActionSource,
  OperatorActionPriority,
  OperatorActionStatus,
} from './operator-action-centre-presenter.js';

export const PROPERTY_PREDATOR_ACTION_CENTRE_AS_OF = '2026-08-26T12:00:00.000Z';
const OBSERVED_AT = '2026-08-26T11:54:00.000Z';

function evidence(source: OperatorActionSource, id: string, label: string, detail: string): OperatorActionEvidenceSnapshot {
  return Object.freeze({
    label,
    detail,
    truth: 'simulated',
    evidenceRef: `test-ledger:${source}:${id}`,
    observedAt: OBSERVED_AT,
  });
}

function action(input: Readonly<{
  id: string;
  source: OperatorActionSource;
  priority: OperatorActionPriority;
  status: OperatorActionStatus;
  title: string;
  detail: string;
  owner: string | null;
  team: string;
  person?: string | null;
  signal: string;
  createdAt: string;
  dueAt: string | null;
  blockedBy?: string | null;
  deepLink: string;
  deepLinkLabel: string;
  evidenceLabel: string;
  evidenceDetail: string;
}>): OperatorActionSnapshot {
  return Object.freeze({
    actionId: input.id,
    source: input.source,
    priority: input.priority,
    status: input.status,
    title: input.title,
    detail: input.detail,
    ownerLabel: input.owner,
    ownerTeam: input.team,
    relatedPersonLabel: input.person ?? null,
    signalLabel: input.signal,
    createdAt: input.createdAt,
    dueAt: input.dueAt,
    blockedBy: input.blockedBy ?? null,
    deepLink: input.deepLink,
    deepLinkLabel: input.deepLinkLabel,
    evidence: evidence(input.source, input.id, input.evidenceLabel, input.evidenceDetail),
  });
}

/**
 * Operationally shaped but fictional TEST work. No row represents a real
 * customer, provider connection, approval, delivery or production task.
 */
export function createPropertyPredatorOperatorActionCentreFixture(): OperatorActionCentreSnapshot {
  return Object.freeze({
    workspaceId: 'workspace-property-predator-test',
    workspaceName: 'Property Predator Growth HQ',
    asOf: PROPERTY_PREDATOR_ACTION_CENTRE_AS_OF,
    environment: 'test',
    datasetKind: 'fictional_test_fixture',
    actions: Object.freeze([
      action({
        id: 'journey-laila-stall', source: 'journey', priority: 'p0', status: 'blocked',
        title: 'Rescue a completed-briefing stall',
        detail: 'Laila completed the Predator Briefing but the overdue review has not moved into the next evidence-led decision.',
        owner: 'Martin O’Connell', team: 'Conversion desk', person: 'Laila Morgan · TEST lead',
        signal: '100% briefing consumed · next move overdue', createdAt: '2026-08-24T14:00:00.000Z', dueAt: '2026-08-26T08:00:00.000Z',
        blockedBy: 'No approved next-best-action selected',
        deepLink: '/portal/journeys/board?q=Laila+Morgan&route=property-predator-self-serve&band=warm', deepLinkLabel: 'Filter journey board to Laila',
        evidenceLabel: 'Journey milestone ledger', evidenceDetail: 'Completed briefing, current route, score band and overdue next move are from the fictional TEST runtime.',
      }),
      action({
        id: 'inbox-email-approval', source: 'inbox', priority: 'p1', status: 'waiting',
        title: 'Decide the email reply approval',
        detail: 'Aisha’s exact reply is versioned in TEST, but remains held until a manager records a decision.',
        owner: 'Martin O’Connell', team: 'Conversion desk', person: 'Aisha Rahman · TEST lead',
        signal: 'Approval waiting · 1 immutable version', createdAt: '2026-08-26T08:10:00.000Z', dueAt: '2026-08-26T11:20:00.000Z',
        deepLink: '/portal/inbox?channel=email&queue=approval&conversation=10000000-0000-4000-8000-000000000001', deepLinkLabel: 'Open Aisha’s approval thread',
        evidenceLabel: 'Inbox approval ledger', evidenceDetail: 'The exact draft hash and approval request exist only in the TEST provider boundary.',
      }),
      action({
        id: 'automation-consent-expiry', source: 'automation', priority: 'p0', status: 'blocked',
        title: 'Repair the expired consent branch',
        detail: 'The follow-up automation cannot enter its TEST queue because the WhatsApp consent proof expired before execution.',
        owner: 'Automation desk', team: 'Automation', person: 'Marcus Flynn · TEST lead',
        signal: 'Gate 04 failed · consent proof expired', createdAt: '2026-08-26T09:12:00.000Z', dueAt: '2026-08-26T12:40:00.000Z',
        blockedBy: 'Fresh consent evidence required',
        deepLink: '/portal/automations?node=guard-whatsapp-consent', deepLinkLabel: 'Inspect the consent guard',
        evidenceLabel: 'Automation execution rehearsal', evidenceDetail: 'A simulated execution stopped before queue creation; zero provider effects occurred.',
      }),
      action({
        id: 'content-rejection-revision', source: 'content', priority: 'p1', status: 'open',
        title: 'Apply the requested comparables changes',
        detail: 'The “Why comparables need context” article needs its recorded review changes before a new immutable version can be requested.',
        owner: 'Content desk', team: 'Content',
        signal: 'Changes requested · version 5 preserved', createdAt: '2026-08-26T09:35:00.000Z', dueAt: '2026-08-26T13:30:00.000Z',
        blockedBy: 'Requested changes unresolved',
        deepLink: '/portal/content?q=Why+comparables+need+context&channel=library&format=article', deepLinkLabel: 'Filter Content Control to the article',
        evidenceLabel: 'Content approval history', evidenceDetail: 'Change request, exact version hash and reviewer decision are retained in the TEST ledger.',
      }),
      action({
        id: 'webinar-replay-approval', source: 'webinar', priority: 'p0', status: 'blocked',
        title: 'Approve the replay follow-up rail',
        detail: 'Tomorrow’s rehearsal is structurally ready except for the exact approved hashes on two replay follow-up messages.',
        owner: 'Martin O’Connell', team: 'Webinar room',
        signal: '2 of 4 replay steps missing exact approval', createdAt: '2026-08-26T07:20:00.000Z', dueAt: '2026-08-26T16:00:00.000Z',
        blockedBy: 'Two immutable approval hashes missing',
        deepLink: '/portal/webinars#wbs-replay-title', deepLinkLabel: 'Open replay readiness section',
        evidenceLabel: 'Webinar rehearsal ledger', evidenceDetail: 'The run-of-show and replay sequence are simulated; no provider event exists.',
      }),
      action({
        id: 'crm-call-sophie', source: 'crm', priority: 'p1', status: 'open',
        title: 'Prepare the Opportunity Autopsy call',
        detail: 'Review Sophie’s source, watched assets and objection history before the TEST appointment window.',
        owner: 'Martin O’Connell', team: 'Sales', person: 'Sophie Bennett · TEST lead',
        signal: 'Appointment in 7h · 5 evidenced touches', createdAt: '2026-08-25T16:40:00.000Z', dueAt: '2026-08-26T18:30:00.000Z',
        deepLink: '/portal/crm/tasks?status=open', deepLinkLabel: 'Open the CRM task queue',
        evidenceLabel: 'CRM task and Lead 360', evidenceDetail: 'Task target and engagement summary resolve to the same fictional TEST person.',
      }),
      action({
        id: 'provider-meta-oauth', source: 'provider', priority: 'p1', status: 'blocked',
        title: 'Prove the Meta sandbox connection',
        detail: 'Social publishing remains launch-locked until OAuth, webhook and sandbox delivery proofs are represented together.',
        owner: 'Platform desk', team: 'Connections',
        signal: '3 required proofs · 1 missing', createdAt: '2026-08-25T10:00:00.000Z', dueAt: '2026-08-27T10:00:00.000Z',
        blockedBy: 'Sandbox delivery proof missing',
        deepLink: '/portal/connections#provider-social-publishing', deepLinkLabel: 'Open social publishing readiness',
        evidenceLabel: 'Provider readiness matrix', evidenceDetail: 'Configuration shape is TEST-only; no live OAuth account or token is connected.',
      }),
      action({
        id: 'journey-priya-enrolment', source: 'journey', priority: 'p2', status: 'open',
        title: 'Review Priya’s automatic enrolment',
        detail: 'The identified direct lead is still awaiting automatic enrolment and has no scored journey route yet.',
        owner: 'Conversion desk', team: 'Conversion desk', person: 'Priya Shah · TEST lead',
        signal: 'Awaiting automatic enrolment · unscored', createdAt: '2026-08-26T10:10:00.000Z', dueAt: '2026-08-27T18:00:00.000Z',
        deepLink: '/portal/journeys/board?q=Priya+Shah&band=unscored', deepLinkLabel: 'Filter journey board to Priya',
        evidenceLabel: 'Journey decision trace', evidenceDetail: 'The fictional TEST board records Priya as identified, unscored and awaiting enrolment.',
      }),
      action({
        id: 'inbox-facebook-draft', source: 'inbox', priority: 'p2', status: 'open',
        title: 'Complete the Facebook comparison reply',
        detail: 'Liam’s draft answers the two-development comparison question and still needs review before approval can be requested.',
        owner: 'Conversion desk', team: 'Conversion desk', person: 'Liam Carter · TEST lead',
        signal: 'Draft v1 · approval not requested', createdAt: '2026-08-26T10:42:00.000Z', dueAt: '2026-08-28T09:00:00.000Z',
        deepLink: '/portal/inbox?channel=facebook&queue=open&conversation=10000000-0000-4000-8000-000000000005', deepLinkLabel: 'Open Liam’s draft thread',
        evidenceLabel: 'Inbox version ledger', evidenceDetail: 'The immutable TEST draft resolves to Liam’s canonical fictional conversation ID.',
      }),
      action({
        id: 'content-mixed-use-approval', source: 'content', priority: 'p2', status: 'waiting',
        title: 'Review the mixed-use follow-up email',
        detail: 'Growth HQ is holding the exact mixed-use intelligence follow-up version for a manager decision.',
        owner: 'Martin O’Connell', team: 'Content',
        signal: 'Approval requested · hash verified', createdAt: '2026-08-26T10:55:00.000Z', dueAt: '2026-08-28T12:00:00.000Z',
        deepLink: '/portal/content?q=Predator+Briefing%3A+mixed-use+intelligence+follow-up&channel=email&format=email', deepLinkLabel: 'Filter Content Control to the email',
        evidenceLabel: 'Company content provenance', evidenceDetail: 'Source lineage, adapter version, output hash and approval request are linked in TEST.',
      }),
      action({
        id: 'automation-score-threshold', source: 'automation', priority: 'p2', status: 'waiting',
        title: 'Verify the sales-ready score threshold',
        detail: 'The new score rule changed one fixture cohort; review the evidence delta before enabling another TEST rehearsal.',
        owner: 'Automation desk', team: 'Automation',
        signal: '12 fixture leads changed branch', createdAt: '2026-08-25T14:30:00.000Z', dueAt: '2026-08-29T11:00:00.000Z',
        deepLink: '/portal/automations?node=condition-intent-score', deepLinkLabel: 'Inspect the intent-score node',
        evidenceLabel: 'Rule simulation diff', evidenceDetail: 'Before-and-after fixture paths are reproducible and contain no customer records.',
      }),
      action({
        id: 'webinar-speaker-cue', source: 'webinar', priority: 'p3', status: 'open',
        title: 'Tighten the offer transition cue',
        detail: 'The rehearsal timeline is valid, but the operator cue can make the shift from proof to offer more explicit.',
        owner: 'Content desk', team: 'Webinar room',
        signal: 'Segment 06 · minute 42', createdAt: '2026-08-26T08:45:00.000Z', dueAt: '2026-08-30T10:00:00.000Z',
        deepLink: '/portal/webinars#wbs-run-title', deepLinkLabel: 'Open run-of-show section',
        evidenceLabel: 'Run-of-show revision', evidenceDetail: 'The immutable TEST event revision links segment duration, cue and speaker.',
      }),
      action({
        id: 'provider-listening-scope', source: 'provider', priority: 'p3', status: 'open',
        title: 'Define the social-listening launch scope',
        detail: 'Decide which owned brands, keywords and escalation classes must be proven before a future adapter is selected.',
        owner: null, team: 'Connections',
        signal: 'Discovery scope · no provider selected', createdAt: '2026-08-25T09:00:00.000Z', dueAt: null,
        deepLink: '/portal/connections#provider-social-listening', deepLinkLabel: 'Open social-listening readiness',
        evidenceLabel: 'Provider capability gap', evidenceDetail: 'The TEST readiness matrix records the missing capability without inventing a connection.',
      }),
      action({
        id: 'crm-source-cleanup', source: 'crm', priority: 'p3', status: 'open',
        title: 'Resolve one ambiguous affiliate source',
        detail: 'One fictional TEST lead has a referral click and landing event but no stable affiliate identity match.',
        owner: 'Growth ops', team: 'CRM operations', person: 'Elliot Taylor · TEST lead',
        signal: 'Identity confidence · low', createdAt: '2026-08-25T13:15:00.000Z', dueAt: '2026-09-01T12:00:00.000Z',
        deepLink: '/portal/crm/tasks?status=open', deepLinkLabel: 'Open the CRM operations queue',
        evidenceLabel: 'Affiliate provenance ledger', evidenceDetail: 'Both competing TEST source references remain visible; neither is promoted to fact.',
      }),
    ]),
  });
}
