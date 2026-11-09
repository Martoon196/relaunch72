import type {
  ProviderAdapterStatus,
  ProviderCategory,
  ProviderConnectionsSnapshot,
  ProviderEnvironment,
  ProviderProofKind,
  ProviderProofState,
  ProviderReadinessProof,
} from './provider-connections-presenter.js';

const AS_OF = '2026-08-26T09:30:00.000Z';

function proof(input: Readonly<{
  adapter: string;
  kind: ProviderProofKind;
  label: string;
  detail: string;
  state: ProviderProofState;
  required?: boolean;
  index: number;
}>): ProviderReadinessProof {
  return Object.freeze({
    proofId: `${input.adapter}.${input.kind}.${input.index}`,
    kind: input.kind,
    label: input.label,
    detail: input.detail,
    required: input.required ?? true,
    state: input.state,
    verifiedAt: input.state === 'verified' ? '2026-08-26T09:12:00.000Z' : null,
    expiresAt: input.state === 'verified' ? '2026-09-02T09:12:00.000Z' : null,
    evidenceRef: input.state === 'verified' ? `test-proof:${input.adapter}:${input.index}` : null,
  });
}

function adapter(input: Readonly<{
  adapterId: string;
  category: ProviderCategory;
  providerLabel: string;
  environment: ProviderEnvironment;
  state: ProviderAdapterStatus['connectionState'];
  statusDetail: string;
  nextStep: string;
  capabilities: readonly string[];
  health: ProviderAdapterStatus['health'];
  proofs: readonly ProviderReadinessProof[];
}>): ProviderAdapterStatus {
  return Object.freeze({
    adapterId: input.adapterId,
    category: input.category,
    providerLabel: input.providerLabel,
    environment: input.environment,
    requiredForLaunch: true,
    connectionState: input.state,
    statusDetail: input.statusDetail,
    nextStep: input.nextStep,
    capabilities: Object.freeze([...input.capabilities]),
    health: Object.freeze(input.health),
    proofs: Object.freeze([...input.proofs]),
  });
}

/**
 * Fictional provider readiness data. It contains proof-shaped metadata only:
 * no credentials, account identifiers, endpoints or real provider calls.
 */
export function createPropertyPredatorProviderConnectionsFixture(): ProviderConnectionsSnapshot {
  const adapters: readonly ProviderAdapterStatus[] = [
    adapter({
      adapterId: 'email-delivery',
      category: 'email',
      providerLabel: 'Email delivery rail',
      environment: 'test',
      state: 'ready',
      statusDetail: 'The simulated adapter is healthy. No live sending account is attached.',
      nextStep: 'Choose the live provider, verify the sending domain and complete a signed webhook test.',
      capabilities: ['Campaign delivery', 'Transactional email', 'Bounce events'],
      health: { state: 'healthy', checkedAt: AS_OF, summary: 'Simulated send and event loop passed.', latencyMs: 42 },
      proofs: [
        proof({ adapter: 'email', index: 1, kind: 'domain', label: 'Sending domain', detail: 'SPF, DKIM and return-path proof for the exact live domain.', state: 'verified' }),
        proof({ adapter: 'email', index: 2, kind: 'webhook', label: 'Signed delivery webhook', detail: 'Signature rejection and replay protection must pass.', state: 'verified' }),
        proof({ adapter: 'email', index: 3, kind: 'consent', label: 'Email consent policy', detail: 'Purpose and lawful-basis checks are enforced before queueing.', state: 'verified' }),
        proof({ adapter: 'email', index: 4, kind: 'compliance', label: 'Unsubscribe compliance', detail: 'Suppression, unsubscribe and complaint handling are evidenced.', state: 'verified' }),
      ],
    }),
    adapter({
      adapterId: 'sms-delivery',
      category: 'sms',
      providerLabel: 'SMS delivery rail',
      environment: 'live',
      state: 'setup_required',
      statusDetail: 'No live SMS provider account or sending identity has been configured.',
      nextStep: 'Select the provider and document the sender identity, STOP handling and signed status callback.',
      capabilities: ['Two-way SMS', 'Delivery receipts', 'Keyword opt-out'],
      health: { state: 'unknown', checkedAt: null, summary: 'A health check cannot run before provider setup.', latencyMs: null },
      proofs: [
        proof({ adapter: 'sms', index: 1, kind: 'webhook', label: 'Signed status callback', detail: 'Inbound and delivery events need authenticated replay-safe handling.', state: 'missing' }),
        proof({ adapter: 'sms', index: 2, kind: 'consent', label: 'SMS consent proof', detail: 'Exact purpose and destination consent must exist at dispatch.', state: 'verified' }),
        proof({ adapter: 'sms', index: 3, kind: 'compliance', label: 'STOP and suppression flow', detail: 'Inbound opt-outs must immediately suppress future sends.', state: 'pending' }),
        proof({ adapter: 'sms', index: 4, kind: 'sandbox_delivery', label: 'Test delivery evidence', detail: 'A non-customer test number must complete the lifecycle.', state: 'missing' }),
      ],
    }),
    adapter({
      adapterId: 'whatsapp-business',
      category: 'whatsapp',
      providerLabel: 'WhatsApp Business rail',
      environment: 'live',
      state: 'verification_pending',
      statusDetail: 'The launch design is ready; business, number and template proof are not yet recorded.',
      nextStep: 'Complete business verification and record approved templates without exposing access tokens here.',
      capabilities: ['Template messages', 'Two-way conversations', 'Read events'],
      health: { state: 'unknown', checkedAt: null, summary: 'No live adapter probe is authorised.', latencyMs: null },
      proofs: [
        proof({ adapter: 'whatsapp', index: 1, kind: 'oauth', label: 'Business authorisation', detail: 'A scoped business authorisation must be evidenced outside this view.', state: 'pending' }),
        proof({ adapter: 'whatsapp', index: 2, kind: 'webhook', label: 'Signed message webhook', detail: 'Challenge, signature and replay controls must pass.', state: 'missing' }),
        proof({ adapter: 'whatsapp', index: 3, kind: 'consent', label: 'WhatsApp opt-in', detail: 'Channel-specific opt-in and purpose must be current.', state: 'verified' }),
        proof({ adapter: 'whatsapp', index: 4, kind: 'compliance', label: 'Template and window policy', detail: 'Approved templates and 24-hour conversation-window rules are enforced.', state: 'pending' }),
      ],
    }),
    adapter({
      adapterId: 'social-publishing',
      category: 'social_publishing',
      providerLabel: 'Social publishing rail',
      environment: 'test',
      state: 'ready',
      statusDetail: 'Draft, approval and simulated publish states are working with test identities only.',
      nextStep: 'Select the live adapter and complete platform-by-platform OAuth and revocation proofs.',
      capabilities: ['Cross-network drafts', 'Approval queue', 'Publish receipts'],
      health: { state: 'healthy', checkedAt: AS_OF, summary: 'Simulated publish receipt reconciled.', latencyMs: 65 },
      proofs: [
        proof({ adapter: 'publishing', index: 1, kind: 'oauth', label: 'Scoped social OAuth', detail: 'Every connected page/profile needs least-privilege scopes and revocation handling.', state: 'verified' }),
        proof({ adapter: 'publishing', index: 2, kind: 'webhook', label: 'Publish-status webhook', detail: 'Signed callbacks must reconcile the exact immutable content version.', state: 'verified' }),
        proof({ adapter: 'publishing', index: 3, kind: 'compliance', label: 'Platform policy review', detail: 'Platform terms, deletion and data-retention rules are documented.', state: 'verified' }),
      ],
    }),
    adapter({
      adapterId: 'social-listening',
      category: 'social_listening',
      providerLabel: 'Social listening rail',
      environment: 'live',
      state: 'not_configured',
      statusDetail: 'Listening is parked behind a provider and data-usage decision.',
      nextStep: 'Define the permitted sources, retention boundary and escalation rules before choosing a provider.',
      capabilities: ['Brand mentions', 'Intent signals', 'Escalation queue'],
      health: { state: 'unknown', checkedAt: null, summary: 'No listening adapter exists yet.', latencyMs: null },
      proofs: [
        proof({ adapter: 'listening', index: 1, kind: 'oauth', label: 'Source authorisation', detail: 'Private-source access must be explicitly scoped and revocable.', state: 'missing' }),
        proof({ adapter: 'listening', index: 2, kind: 'data_processing', label: 'Listening data boundary', detail: 'Collection purpose, retention and deletion controls must be approved.', state: 'missing' }),
        proof({ adapter: 'listening', index: 3, kind: 'compliance', label: 'Human escalation policy', detail: 'Sensitive signals cannot trigger autonomous outreach.', state: 'pending' }),
      ],
    }),
    adapter({
      adapterId: 'webinar-delivery',
      category: 'webinar',
      providerLabel: 'Webinar rail',
      environment: 'live',
      state: 'setup_required',
      statusDetail: 'Registration and attendance contracts exist; no webinar provider is connected.',
      nextStep: 'Choose the embedded webinar provider and prove registration, attendance and replay webhooks.',
      capabilities: ['Registration', 'Attendance milestones', 'Replay follow-up'],
      health: { state: 'unknown', checkedAt: null, summary: 'Provider setup is required before probing.', latencyMs: null },
      proofs: [
        proof({ adapter: 'webinar', index: 1, kind: 'oauth', label: 'Host authorisation', detail: 'The webinar host account must grant only the required scopes.', state: 'missing' }),
        proof({ adapter: 'webinar', index: 2, kind: 'webhook', label: 'Attendance webhook', detail: 'Signed events must map to exact registration and attendance milestones.', state: 'missing' }),
        proof({ adapter: 'webinar', index: 3, kind: 'consent', label: 'Registration consent', detail: 'Event registration and marketing follow-up purposes stay separate.', state: 'verified' }),
      ],
    }),
    adapter({
      adapterId: 'payments',
      category: 'payments',
      providerLabel: 'Payments rail',
      environment: 'live',
      state: 'blocked',
      statusDetail: 'Live charging remains deliberately blocked pending a separate production authorisation.',
      nextStep: 'Approve the commercial boundary, merchant ownership and signed event reconciliation plan.',
      capabilities: ['Hosted checkout', 'Subscription events', 'Refund state'],
      health: { state: 'unknown', checkedAt: null, summary: 'No live payment probe or charge has been attempted.', latencyMs: null },
      proofs: [
        proof({ adapter: 'payments', index: 1, kind: 'webhook', label: 'Signed payment webhook', detail: 'Events must be signature-checked, deduplicated and reconciled.', state: 'missing' }),
        proof({ adapter: 'payments', index: 2, kind: 'billing_boundary', label: 'Merchant and billing boundary', detail: 'Merchant of record, refunds and customer support ownership must be explicit.', state: 'pending' }),
        proof({ adapter: 'payments', index: 3, kind: 'compliance', label: 'Payment compliance review', detail: 'Hosted payment fields keep card data outside Growth HQ.', state: 'pending' }),
      ],
    }),
    adapter({
      adapterId: 'ai-orchestration',
      category: 'ai',
      providerLabel: 'AI orchestration rail',
      environment: 'test',
      state: 'ready',
      statusDetail: 'Test generation can draft content, but every external action remains approval-gated.',
      nextStep: 'Complete the live data-processing and model-policy review before enabling production inference.',
      capabilities: ['Draft assistance', 'Lead summaries', 'Suggested next move'],
      health: { state: 'healthy', checkedAt: AS_OF, summary: 'Bounded test prompt and redaction checks passed.', latencyMs: 181 },
      proofs: [
        proof({ adapter: 'ai', index: 1, kind: 'data_processing', label: 'AI data-processing boundary', detail: 'Allowed fields, retention and training exclusions must be proven.', state: 'verified' }),
        proof({ adapter: 'ai', index: 2, kind: 'model_policy', label: 'Human approval policy', detail: 'The model may draft and recommend but cannot autonomously contact a person.', state: 'verified' }),
        proof({ adapter: 'ai', index: 3, kind: 'compliance', label: 'Sensitive-data review', detail: 'Prompt inputs and outputs are redacted, bounded and audited.', state: 'verified' }),
      ],
    }),
  ];

  return Object.freeze({
    workspaceId: '72000000-0000-4000-8000-000000000001',
    workspaceName: 'Property Predator Growth HQ',
    targetEnvironment: 'live',
    asOf: AS_OF,
    dataset: 'illustrative_fixture',
    requiredCategories: Object.freeze([
      'email',
      'sms',
      'whatsapp',
      'social_publishing',
      'social_listening',
      'webinar',
      'payments',
      'ai',
    ] satisfies ProviderCategory[]),
    adapters: Object.freeze(adapters),
  });
}
