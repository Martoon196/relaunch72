import type {
  AutomationAuditEventSnapshot,
  AutomationEdgeSnapshot,
  AutomationNodeSnapshot,
  AutomationReadinessProofSnapshot,
  AutomationSimulationStepSnapshot,
  AutomationStudioSnapshot,
} from './automation-studio-presenter.js';

export const PROPERTY_PREDATOR_AUTOMATION_STUDIO_AS_OF = '2026-08-26T10:30:00.000Z';

function node(input: AutomationNodeSnapshot): AutomationNodeSnapshot {
  return Object.freeze({
    ...input,
    configuration: Object.freeze(input.configuration.map((entry) => Object.freeze({ ...entry }))),
  });
}

function edge(input: AutomationEdgeSnapshot): AutomationEdgeSnapshot {
  return Object.freeze({ ...input });
}

function proof(input: AutomationReadinessProofSnapshot): AutomationReadinessProofSnapshot {
  return Object.freeze({ ...input });
}

function simulationStep(input: AutomationSimulationStepSnapshot): AutomationSimulationStepSnapshot {
  return Object.freeze({ ...input });
}

function auditEvent(input: AutomationAuditEventSnapshot): AutomationAuditEventSnapshot {
  return Object.freeze({ ...input });
}

/**
 * Fictional TEST-only flow. It represents an evidence-first lead follow-up,
 * creates a WhatsApp draft but never sends it, and writes only simulated
 * workspace events. No provider or real contact is referenced.
 */
export function createPropertyPredatorAutomationStudioFixture(): AutomationStudioSnapshot {
  const nodes: readonly AutomationNodeSnapshot[] = Object.freeze([
    node({
      nodeId: 'trigger-autopsy-form',
      kind: 'trigger',
      title: 'Opportunity Autopsy form submitted',
      detail: 'Starts when a synthetic TEST lead completes the evidence-first opportunity form.',
      column: 2,
      row: 1,
      configured: true,
      effect: 'none',
      guardKind: null,
      providerMode: 'none',
      configuration: [
        { key: 'source', label: 'Source', value: 'TEST form · Opportunity Autopsy' },
        { key: 'event', label: 'Event', value: 'form.submitted.v1' },
      ],
    }),
    node({
      nodeId: 'condition-intent-score',
      kind: 'condition',
      title: 'Intent score is 45 or higher',
      detail: 'Routes evidence-ready leads into guarded follow-up; everybody else stays in education.',
      column: 2,
      row: 2,
      configured: true,
      effect: 'none',
      guardKind: null,
      providerMode: 'none',
      configuration: [
        { key: 'field', label: 'Signal', value: 'Lead intent score' },
        { key: 'operator', label: 'Rule', value: 'Greater than or equal to 45' },
      ],
    }),
    node({
      nodeId: 'guard-whatsapp-consent',
      kind: 'guard',
      title: 'WhatsApp consent is current',
      detail: 'Requires an allowed purpose, active contact-point consent and no suppression before a draft path continues.',
      column: 3,
      row: 3,
      configured: true,
      effect: 'none',
      guardKind: 'consent',
      providerMode: 'none',
      configuration: [
        { key: 'channel', label: 'Channel', value: 'WhatsApp' },
        { key: 'purpose', label: 'Purpose', value: 'Property Predator enquiry follow-up' },
        { key: 'failure_path', label: 'If blocked', value: 'Continue education only' },
      ],
    }),
    node({
      nodeId: 'guard-human-approval',
      kind: 'guard',
      title: 'Human approval is recorded',
      detail: 'A manager must approve the exact immutable message version before draft preparation can proceed.',
      column: 3,
      row: 4,
      configured: true,
      effect: 'none',
      guardKind: 'approval',
      providerMode: 'none',
      configuration: [
        { key: 'approval_policy', label: 'Policy', value: 'Exact content version · manager decision' },
        { key: 'stale_rule', label: 'After an edit', value: 'Approval becomes stale immediately' },
      ],
    }),
    node({
      nodeId: 'wait-twenty-minutes',
      kind: 'wait',
      title: 'Wait 20 minutes',
      detail: 'Models a respectful pause in simulation time; it does not schedule a production job.',
      column: 3,
      row: 5,
      configured: true,
      effect: 'none',
      guardKind: null,
      providerMode: 'simulated',
      configuration: [
        { key: 'duration', label: 'Delay', value: '20 minutes · simulated clock' },
        { key: 'quiet_hours', label: 'Quiet hours', value: 'Honour recipient timezone in a future live rail' },
      ],
    }),
    node({
      nodeId: 'action-create-whatsapp-draft',
      kind: 'action',
      title: 'Prepare WhatsApp reply draft',
      detail: 'Creates a simulated draft from the exact approved Property Predator content version. Nothing is sent.',
      column: 3,
      row: 6,
      configured: true,
      effect: 'draft_only',
      guardKind: null,
      providerMode: 'simulated',
      configuration: [
        { key: 'template', label: 'Content', value: 'Opportunity Autopsy follow-up · version 3' },
        { key: 'lineage', label: 'Lineage proof', value: 'Affiliate Stash · immutable approved source' },
        { key: 'delivery', label: 'Delivery', value: 'TEST draft store only' },
      ],
    }),
    node({
      nodeId: 'action-enrol-education',
      kind: 'action',
      title: 'Record education journey enrolment',
      detail: 'Adds a TEST-only journey event whether the guarded reply path passes or safely falls back.',
      column: 2,
      row: 7,
      configured: true,
      effect: 'internal_test',
      guardKind: null,
      providerMode: 'simulated',
      configuration: [
        { key: 'journey', label: 'Journey', value: 'Evidence to Enquiry · TEST' },
        { key: 'milestone', label: 'Milestone', value: 'Opportunity Autopsy consumed' },
      ],
    }),
  ]);

  const edges: readonly AutomationEdgeSnapshot[] = Object.freeze([
    edge({ edgeId: 'edge-trigger-score', fromNodeId: 'trigger-autopsy-form', toNodeId: 'condition-intent-score', label: 'Evaluate intent', path: 'always' }),
    edge({ edgeId: 'edge-score-yes', fromNodeId: 'condition-intent-score', toNodeId: 'guard-whatsapp-consent', label: '45 or higher', path: 'yes' }),
    edge({ edgeId: 'edge-score-no', fromNodeId: 'condition-intent-score', toNodeId: 'action-enrol-education', label: 'Below 45', path: 'no' }),
    edge({ edgeId: 'edge-consent-yes', fromNodeId: 'guard-whatsapp-consent', toNodeId: 'guard-human-approval', label: 'Consent passes', path: 'yes' }),
    edge({ edgeId: 'edge-consent-no', fromNodeId: 'guard-whatsapp-consent', toNodeId: 'action-enrol-education', label: 'Consent blocked', path: 'no' }),
    edge({ edgeId: 'edge-approval-yes', fromNodeId: 'guard-human-approval', toNodeId: 'wait-twenty-minutes', label: 'Exact version approved', path: 'yes' }),
    edge({ edgeId: 'edge-approval-no', fromNodeId: 'guard-human-approval', toNodeId: 'action-enrol-education', label: 'No approval', path: 'no' }),
    edge({ edgeId: 'edge-wait-draft', fromNodeId: 'wait-twenty-minutes', toNodeId: 'action-create-whatsapp-draft', label: 'Simulated wait complete', path: 'always' }),
    edge({ edgeId: 'edge-draft-enrol', fromNodeId: 'action-create-whatsapp-draft', toNodeId: 'action-enrol-education', label: 'Draft recorded', path: 'always' }),
  ]);

  const readinessProofs: readonly AutomationReadinessProofSnapshot[] = Object.freeze([
    proof({
      proofId: 'proof-consent-policy-v4',
      label: 'Consent policy coverage',
      detail: 'WhatsApp purpose, suppression and contact-point checks are represented before the draft action.',
      required: true,
      state: 'verified',
      verifiedAt: '2026-08-26T09:40:00.000Z',
      expiresAt: '2026-09-26T09:40:00.000Z',
      evidenceRef: 'automation-proof:consent:v4',
    }),
    proof({
      proofId: 'proof-approval-lineage-v3',
      label: 'Approval and source lineage',
      detail: 'The exact Affiliate Stash content version and approval staleness rule are bound into the draft path.',
      required: true,
      state: 'verified',
      verifiedAt: '2026-08-26T09:44:00.000Z',
      expiresAt: '2026-09-26T09:44:00.000Z',
      evidenceRef: 'automation-proof:lineage:v3',
    }),
    proof({
      proofId: 'proof-test-isolation-v2',
      label: 'TEST provider isolation',
      detail: 'Provider-capable steps resolve only to deterministic simulation adapters with no network route.',
      required: true,
      state: 'verified',
      verifiedAt: '2026-08-26T09:48:00.000Z',
      expiresAt: '2026-09-26T09:48:00.000Z',
      evidenceRef: 'automation-proof:isolation:v2',
    }),
  ]);

  const simulationSteps: readonly AutomationSimulationStepSnapshot[] = Object.freeze([
    simulationStep({ sequence: 1, nodeId: 'trigger-autopsy-form', outcome: 'matched', detail: 'Synthetic lead pp_test_104 matched the form event.', durationMs: 3 }),
    simulationStep({ sequence: 2, nodeId: 'condition-intent-score', outcome: 'passed', detail: 'Synthetic intent score 68 followed the guarded path.', durationMs: 1 }),
    simulationStep({ sequence: 3, nodeId: 'guard-whatsapp-consent', outcome: 'passed', detail: 'Fixture consent was current for the declared TEST purpose.', durationMs: 2 }),
    simulationStep({ sequence: 4, nodeId: 'guard-human-approval', outcome: 'passed', detail: 'Immutable content version 3 matched its fixture approval.', durationMs: 2 }),
    simulationStep({ sequence: 5, nodeId: 'wait-twenty-minutes', outcome: 'waited', detail: 'The deterministic clock advanced; no background job was scheduled.', durationMs: 4 }),
    simulationStep({ sequence: 6, nodeId: 'action-create-whatsapp-draft', outcome: 'drafted', detail: 'One TEST draft was recorded in memory. Provider effects remained zero.', durationMs: 5 }),
    simulationStep({ sequence: 7, nodeId: 'action-enrol-education', outcome: 'test_mutation', detail: 'One synthetic journey event was recorded in the TEST transcript.', durationMs: 2 }),
  ]);

  const audit: readonly AutomationAuditEventSnapshot[] = Object.freeze([
    auditEvent({
      eventId: 'audit-flow-created',
      eventType: 'created',
      actorLabel: 'Property Predator product team · TEST',
      occurredAt: '2026-08-26T09:12:00.000Z',
      detail: 'Created the evidence-to-enquiry automation in a paused TEST state.',
      evidenceRef: 'audit:automation:created:v1',
    }),
    auditEvent({
      eventId: 'audit-version-three',
      eventType: 'version_saved',
      actorLabel: 'Property Predator product team · TEST',
      occurredAt: '2026-08-26T09:35:00.000Z',
      detail: 'Saved immutable flow version 3 with explicit consent and approval gates.',
      evidenceRef: 'audit:automation:version:3',
    }),
    auditEvent({
      eventId: 'audit-safety-reviewed',
      eventType: 'reviewed',
      actorLabel: 'Growth HQ safety review · TEST',
      occurredAt: '2026-08-26T09:50:00.000Z',
      detail: 'Confirmed simulation-only providers and draft-only outbound behaviour.',
      evidenceRef: 'audit:automation:review:3',
    }),
    auditEvent({
      eventId: 'audit-simulation-complete',
      eventType: 'simulation_completed',
      actorLabel: 'Deterministic automation simulator',
      occurredAt: '2026-08-26T10:02:08.000Z',
      detail: 'Seven flow steps passed with zero provider effects and zero contact effects.',
      evidenceRef: 'audit:automation:simulation:run-pp-104',
    }),
    auditEvent({
      eventId: 'audit-flow-paused',
      eventType: 'paused',
      actorLabel: 'Growth HQ safety control',
      occurredAt: '2026-08-26T10:03:00.000Z',
      detail: 'Flow remains paused pending an authenticated TEST command boundary.',
      evidenceRef: 'audit:automation:paused:3',
    }),
  ]);

  return Object.freeze({
    flowId: 'automation-evidence-to-enquiry-v3',
    workspaceId: 'workspace-property-predator-test',
    workspaceName: 'Property Predator Growth HQ',
    name: 'Evidence to Enquiry · guarded follow-up',
    summary: 'Qualify an Opportunity Autopsy lead, prove consent and approval, prepare a WhatsApp draft and keep the lead moving — entirely inside TEST.',
    version: 3,
    environment: 'test',
    runtimeState: 'paused',
    asOf: PROPERTY_PREDATOR_AUTOMATION_STUDIO_AS_OF,
    nodes,
    edges,
    readinessProofs,
    simulation: Object.freeze({
      runId: 'simulation-run-pp-104',
      state: 'passed',
      triggerLabel: 'Synthetic Opportunity Autopsy submission · pp_test_104',
      startedAt: '2026-08-26T10:02:00.000Z',
      completedAt: '2026-08-26T10:02:08.000Z',
      providerEffects: false,
      contactEffects: false,
      steps: simulationSteps,
    }),
    audit,
  });
}
