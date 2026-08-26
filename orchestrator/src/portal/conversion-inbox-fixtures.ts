import type { InboxConversationPage, InboxConversationSummary } from '../inbox-pg/types.js';
import type {
  ConversionInboxConsentSnapshot,
  ConversionInboxDraftSnapshot,
  ConversionInboxLeadSnapshot,
  ConversionInboxSnapshot,
  ConversionInboxThreadSnapshot,
  ConversionInboxTranscriptMessageSnapshot,
} from './conversion-inbox-presenter.js';

const AS_OF = '2026-08-26T08:42:00.000Z';

const PEOPLE = Object.freeze([
  Object.freeze({
    conversationId: '10000000-0000-4000-8000-000000000001',
    inboxId: '20000000-0000-4000-8000-000000000001',
    contactId: '30000000-0000-4000-8000-000000000001',
    channel: 'email' as const,
    name: 'Aisha Rahman',
    company: 'Rahman Property Partners',
    subject: 'Agency growth call',
    unread: 2,
    lastAt: '2026-08-26T08:37:00.000Z',
    latest: 'Thursday works. Could you show me how the portfolio campaign would be measured?',
    stage: 'Conversation', score: 88, source: 'Agency Growth Briefing', affiliate: 'North Star Network',
    nextMove: 'Answer the measurement question, then confirm Thursday.',
  }),
  Object.freeze({
    conversationId: '10000000-0000-4000-8000-000000000002',
    inboxId: '20000000-0000-4000-8000-000000000002',
    contactId: '30000000-0000-4000-8000-000000000002',
    channel: 'whatsapp' as const,
    name: 'Priya Nair',
    company: 'PN Estates',
    subject: 'Predator demo follow-up',
    unread: 1,
    lastAt: '2026-08-26T08:25:00.000Z',
    latest: 'I watched the valuation section twice. Does it cover mixed-use stock?',
    stage: 'Qualified', score: 81, source: 'Predator Masterclass', affiliate: null,
    nextMove: 'Share the mixed-use coverage answer and offer a demo slot.',
  }),
  Object.freeze({
    conversationId: '10000000-0000-4000-8000-000000000003',
    inboxId: '20000000-0000-4000-8000-000000000003',
    contactId: '30000000-0000-4000-8000-000000000003',
    channel: 'instagram' as const,
    name: 'Marcus Reed',
    company: 'Reed Homes',
    subject: 'Instagram reply',
    unread: 0,
    lastAt: '2026-08-26T07:48:00.000Z',
    latest: 'That deal analysis clip was useful — where can I see the full walkthrough?',
    stage: 'Engaged', score: 67, source: 'Instagram organic', affiliate: 'Deal Desk UK',
    nextMove: 'Route to the approved walkthrough page after consent review.',
  }),
  Object.freeze({
    conversationId: '10000000-0000-4000-8000-000000000004',
    inboxId: '20000000-0000-4000-8000-000000000004',
    contactId: '30000000-0000-4000-8000-000000000004',
    channel: 'sms' as const,
    name: 'Sophie Grant',
    company: null,
    subject: 'Appointment reminder reply',
    unread: 0,
    lastAt: '2026-08-25T17:06:00.000Z',
    latest: 'Yes, 10:30 is good for the test appointment.',
    stage: 'Appointment', score: 74, source: 'Direct signup', affiliate: null,
    nextMove: 'Leave the appointment in its test state until live activation is authorised.',
  }),
  Object.freeze({
    conversationId: '10000000-0000-4000-8000-000000000005',
    inboxId: '20000000-0000-4000-8000-000000000005',
    contactId: '30000000-0000-4000-8000-000000000005',
    channel: 'facebook' as const,
    name: 'Liam Carter',
    company: 'Carter Developments',
    subject: 'Facebook campaign question',
    unread: 3,
    lastAt: '2026-08-25T16:52:00.000Z',
    latest: 'Can the report compare two potential developments?',
    stage: 'New signal', score: 58, source: 'Facebook lead form', affiliate: 'Midlands Property Circle',
    nextMove: 'Triage the comparison request before drafting a response.',
  }),
]);

function summary(person: typeof PEOPLE[number], index: number): InboxConversationSummary {
  return Object.freeze({
    conversationId: person.conversationId,
    inboxId: person.inboxId,
    channel: person.channel,
    state: 'open',
    contactId: person.contactId,
    contactName: person.name,
    subject: person.subject,
    unreadCount: person.unread,
    requiresApproval: index === 0,
    lastMessageAt: person.lastAt,
    latestMessage: Object.freeze({
      messageId: `40000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      direction: 'inbound',
      lifecycle: 'received',
      body: person.latest,
      occurredAt: person.lastAt,
    }),
    rowVersion: 1,
  });
}

function lead(person: typeof PEOPLE[number]): ConversionInboxLeadSnapshot {
  return Object.freeze({
    contactId: person.contactId,
    displayName: person.name,
    companyName: person.company,
    stageLabel: person.stage,
    score: person.score,
    sourceLabel: person.source,
    affiliateLabel: person.affiliate,
    nextMove: person.nextMove,
  });
}

function consent(
  person: typeof PEOPLE[number],
): readonly ConversionInboxConsentSnapshot[] {
  const channel = person.channel === 'facebook' || person.channel === 'instagram'
    ? 'social' : person.channel;
  const state = person.channel === 'instagram' ? 'unknown' : 'permitted';
  return Object.freeze([Object.freeze({
    channel,
    state,
    basis: state === 'permitted' ? 'Test fixture consent event' : null,
    updatedAt: state === 'permitted' ? '2026-08-25T12:00:00.000Z' : null,
  })]);
}

function messages(
  person: typeof PEOPLE[number],
  index: number,
): readonly ConversionInboxTranscriptMessageSnapshot[] {
  const suffix = String(index + 1).padStart(12, '0');
  return Object.freeze([
    Object.freeze({
      messageId: `50000000-0000-4000-8000-${suffix}`,
      direction: 'outbound',
      lifecycle: 'committed',
      authorLabel: 'Growth HQ test operator',
      body: index === 0
        ? 'Thanks for watching the agency briefing. I have held a test appointment slot for Thursday.'
        : 'Thanks for getting in touch. This response exists inside the simulator only.',
      occurredAt: '2026-08-25T15:30:00.000Z',
      deliveryState: index === 0 ? 'delivered' : 'accepted',
    }),
    Object.freeze({
      messageId: `40000000-0000-4000-8000-${suffix}`,
      direction: 'inbound',
      lifecycle: 'received',
      authorLabel: person.name,
      body: person.latest,
      occurredAt: person.lastAt,
      deliveryState: null,
    }),
  ]);
}

function draft(index: number): ConversionInboxDraftSnapshot {
  const suffix = String(index + 1).padStart(12, '0');
  const approvalRequestId = `80000000-0000-4000-8000-${suffix}`;
  if (index === 2) {
    return Object.freeze({
      messageId: `60000000-0000-4000-8000-${suffix}`,
      body: 'The full walkthrough is ready, but this test draft remains blocked until social consent is established.',
      lifecycle: 'approved',
      versionNumber: 2,
      approvalState: 'approved',
      approvalNote: 'Exact test draft v2 approved.',
      deliveryState: 'not_queued',
      updatedAt: '2026-08-26T08:05:00.000Z',
      rowVersion: 3,
      approvalRequestId,
      purpose: 'property_predator_follow_up',
    });
  }
  if (index === 1) {
    return Object.freeze({
      messageId: `60000000-0000-4000-8000-${suffix}`,
      body: 'Yes — the test walkthrough includes mixed-use examples. Would Tuesday morning suit for a closer look?',
      lifecycle: 'approved',
      versionNumber: 3,
      approvalState: 'approved',
      approvalNote: 'Exact test draft v3 approved.',
      deliveryState: 'queued',
      updatedAt: '2026-08-26T08:31:00.000Z',
      rowVersion: 4,
      approvalRequestId,
      purpose: 'property_predator_follow_up',
    });
  }
  if (index === 3) {
    return Object.freeze({
      messageId: `60000000-0000-4000-8000-${suffix}`,
      body: 'Perfect. Your test appointment remains held for 10:30. This operation cannot reach a real phone.',
      lifecycle: 'approved',
      versionNumber: 2,
      approvalState: 'approved',
      approvalNote: 'Exact test appointment reply approved.',
      deliveryState: 'not_queued',
      updatedAt: '2026-08-26T08:18:00.000Z',
      rowVersion: 2,
      approvalRequestId,
      purpose: 'appointment_follow_up',
    });
  }
  if (index === 4) {
    return Object.freeze({
      messageId: `60000000-0000-4000-8000-${suffix}`,
      body: 'Yes. The comparison report can place two developments side by side, including risk, demand and projected returns.',
      lifecycle: 'draft',
      versionNumber: 1,
      approvalState: 'not_requested',
      approvalNote: null,
      deliveryState: 'not_queued',
      updatedAt: '2026-08-26T08:39:00.000Z',
      rowVersion: 1,
      approvalRequestId: null,
      purpose: 'property_predator_follow_up',
    });
  }
  return Object.freeze({
    messageId: `60000000-0000-4000-8000-${suffix}`,
    body: index === 0
      ? 'Absolutely. We track the journey from briefing engagement through qualified appointment and verified purchase, with the source evidence attached.'
      : 'A human-owned reply draft is waiting in this test workspace.',
    lifecycle: 'approval_pending',
    versionNumber: 1,
    approvalState: 'pending',
    approvalNote: 'Waiting for a test workspace reviewer.',
    deliveryState: 'not_queued',
    updatedAt: '2026-08-26T08:39:00.000Z',
    rowVersion: 2,
    approvalRequestId,
    purpose: 'property_predator_follow_up',
  });
}

function thread(person: typeof PEOPLE[number], index: number): ConversionInboxThreadSnapshot {
  return Object.freeze({
    conversationId: person.conversationId,
    contactPointId: `70000000-0000-4000-8001-${String(index + 1).padStart(12, '0')}`,
    messages: messages(person, index),
    lead: lead(person),
    consents: consent(person),
    draft: draft(index),
  });
}

/**
 * Deterministic, fictional, non-routable preview data. It never reads a customer
 * record or carries a real provider destination.
 */
export function createPropertyPredatorTestInboxSnapshot(): ConversionInboxSnapshot {
  const page: InboxConversationPage = Object.freeze({
    workspaceId: '70000000-0000-4000-8000-000000000001',
    canWrite: true,
    canManage: true,
    timezone: 'Europe/London',
    asOf: AS_OF,
    conversations: Object.freeze(PEOPLE.map(summary)),
    nextCursor: null,
  });
  return Object.freeze({
    page,
    threads: Object.freeze(PEOPLE.map(thread)),
  });
}
