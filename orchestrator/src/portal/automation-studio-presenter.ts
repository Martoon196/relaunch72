/**
 * Pure, bounded Automation Studio presentation model.
 *
 * This slice intentionally has no command boundary. It can explain whether a
 * TEST automation is structurally safe to activate and show prior simulation
 * evidence, but it cannot mutate a workflow or execute a provider operation.
 */

export const AUTOMATION_STUDIO_ROUTE = '/portal/automations' as const;
export const AUTOMATION_STUDIO_MAX_NODES = 24;
export const AUTOMATION_STUDIO_MAX_EDGES = 48;
export const AUTOMATION_STUDIO_MAX_PROOFS = 20;
export const AUTOMATION_STUDIO_MAX_AUDIT_EVENTS = 30;
export const AUTOMATION_STUDIO_MAX_SIMULATION_STEPS = 40;
export const AUTOMATION_STUDIO_MAX_CONFIG = 12;
export const AUTOMATION_STUDIO_MAX_TEXT = 320;

export type AutomationEnvironment = 'test' | 'live';
export type AutomationRuntimeState = 'draft' | 'paused' | 'active_test';
export type AutomationNodeKind = 'trigger' | 'condition' | 'guard' | 'wait' | 'action';
export type AutomationGuardKind = 'consent' | 'approval' | null;
export type AutomationEffect = 'none' | 'internal_test' | 'draft_only';
export type AutomationProviderMode = 'none' | 'simulated';
export type AutomationEdgePath = 'always' | 'yes' | 'no' | 'fallback';
export type AutomationProofState = 'verified' | 'pending' | 'missing' | 'expired';
export type AutomationSimulationState = 'passed' | 'failed' | 'not_run';
export type AutomationSimulationOutcome = 'matched' | 'passed' | 'skipped' | 'waited' | 'test_mutation' | 'drafted';

export interface AutomationNodeConfigurationSnapshot {
  readonly key: string;
  readonly label: string;
  readonly value: string;
}

export interface AutomationNodeSnapshot {
  readonly nodeId: string;
  readonly kind: AutomationNodeKind;
  readonly title: string;
  readonly detail: string;
  readonly column: number;
  readonly row: number;
  readonly configured: boolean;
  readonly effect: AutomationEffect;
  readonly guardKind: AutomationGuardKind;
  readonly providerMode: AutomationProviderMode;
  readonly configuration: readonly AutomationNodeConfigurationSnapshot[];
}

export interface AutomationEdgeSnapshot {
  readonly edgeId: string;
  readonly fromNodeId: string;
  readonly toNodeId: string;
  readonly label: string;
  readonly path: AutomationEdgePath;
}

export interface AutomationReadinessProofSnapshot {
  readonly proofId: string;
  readonly label: string;
  readonly detail: string;
  readonly required: boolean;
  readonly state: AutomationProofState;
  readonly verifiedAt: string | null;
  readonly expiresAt: string | null;
  /** Opaque audit reference only. Never a URL, token or credential. */
  readonly evidenceRef: string | null;
}

export interface AutomationSimulationStepSnapshot {
  readonly sequence: number;
  readonly nodeId: string;
  readonly outcome: AutomationSimulationOutcome;
  readonly detail: string;
  readonly durationMs: number;
}

export interface AutomationSimulationSnapshot {
  readonly runId: string;
  readonly state: AutomationSimulationState;
  readonly triggerLabel: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly providerEffects: boolean;
  readonly contactEffects: boolean;
  readonly steps: readonly AutomationSimulationStepSnapshot[];
}

export interface AutomationAuditEventSnapshot {
  readonly eventId: string;
  readonly eventType: 'created' | 'version_saved' | 'reviewed' | 'simulation_completed' | 'paused' | 'test_activated';
  readonly actorLabel: string;
  readonly occurredAt: string;
  readonly detail: string;
  readonly evidenceRef: string;
}

export interface AutomationStudioSnapshot {
  readonly flowId: string;
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly name: string;
  readonly summary: string;
  readonly version: number;
  readonly environment: AutomationEnvironment;
  readonly runtimeState: AutomationRuntimeState;
  readonly asOf: string;
  readonly nodes: readonly AutomationNodeSnapshot[];
  readonly edges: readonly AutomationEdgeSnapshot[];
  readonly readinessProofs: readonly AutomationReadinessProofSnapshot[];
  readonly simulation: AutomationSimulationSnapshot;
  readonly audit: readonly AutomationAuditEventSnapshot[];
}

export interface AutomationStudioFilterInput {
  readonly node?: unknown;
}

export interface AutomationConfigurationView {
  readonly key: string;
  readonly label: string;
  readonly value: string;
}

export interface AutomationNodeView {
  readonly nodeId: string;
  readonly anchorId: string;
  readonly sequence: number;
  readonly kind: AutomationNodeKind;
  readonly kindLabel: string;
  readonly title: string;
  readonly detail: string;
  readonly column: number;
  readonly row: number;
  readonly configured: boolean;
  readonly effect: AutomationEffect;
  readonly effectLabel: string;
  readonly guardKind: AutomationGuardKind;
  readonly providerMode: AutomationProviderMode;
  readonly configuration: readonly AutomationConfigurationView[];
  readonly rejectedConfigurationCount: number;
  readonly incoming: readonly Readonly<{ label: string; nodeTitle: string; path: AutomationEdgePath }>[];
  readonly outgoing: readonly Readonly<{ label: string; nodeTitle: string; path: AutomationEdgePath }>[];
  readonly selected: boolean;
  readonly nodeReady: boolean;
}

export interface AutomationReadinessCheckView {
  readonly key: string;
  readonly label: string;
  readonly detail: string;
  readonly passed: boolean;
  readonly category: 'structure' | 'safety' | 'evidence';
}

export interface AutomationReadinessProofView {
  readonly proofId: string;
  readonly label: string;
  readonly detail: string;
  readonly required: boolean;
  readonly state: AutomationProofState;
  readonly stateLabel: string;
  readonly verifiedAt: string | null;
  readonly expiresAt: string | null;
  readonly evidenceRef: string | null;
  readonly passes: boolean;
}

export interface AutomationSimulationStepView {
  readonly sequence: number;
  readonly nodeId: string;
  readonly nodeTitle: string;
  readonly outcome: AutomationSimulationOutcome;
  readonly outcomeLabel: string;
  readonly detail: string;
  readonly durationMs: number;
}

export interface AutomationStudioView {
  readonly flowId: string;
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly name: string;
  readonly summary: string;
  readonly version: number;
  readonly environment: AutomationEnvironment;
  readonly environmentLabel: string;
  readonly runtimeState: AutomationRuntimeState;
  readonly runtimeLabel: string;
  readonly asOf: string;
  readonly nodes: readonly AutomationNodeView[];
  readonly selectedNode: AutomationNodeView;
  readonly readinessChecks: readonly AutomationReadinessCheckView[];
  readonly readinessProofs: readonly AutomationReadinessProofView[];
  readonly simulation: Readonly<{
    runId: string;
    state: AutomationSimulationState;
    stateLabel: string;
    triggerLabel: string;
    startedAt: string | null;
    completedAt: string | null;
    providerEffects: false;
    contactEffects: false;
    steps: readonly AutomationSimulationStepView[];
  }>;
  readonly audit: readonly Readonly<{
    eventId: string;
    eventType: AutomationAuditEventSnapshot['eventType'];
    eventLabel: string;
    actorLabel: string;
    occurredAt: string | null;
    detail: string;
    evidenceRef: string;
  }>[];
  readonly testActivationGate: Readonly<{
    open: boolean;
    label: 'OPEN' | 'CLOSED';
    headline: string;
    detail: string;
    blockerCount: number;
    blockers: readonly string[];
    canRequestActivation: boolean;
    canRequestPause: boolean;
  }>;
  readonly liveActivationGate: Readonly<{
    open: false;
    label: 'CLOSED';
    headline: string;
    detail: string;
  }>;
  readonly metrics: Readonly<{
    nodes: number;
    actions: number;
    checksPassed: number;
    checksTotal: number;
    proofPassed: number;
    proofTotal: number;
    simulatedSteps: number;
  }>;
  readonly inputTruncated: boolean;
  readonly commandBoundaryAvailable: false;
}

const NODE_KIND_LABELS: Readonly<Record<AutomationNodeKind, string>> = Object.freeze({
  trigger: 'Trigger',
  condition: 'Condition',
  guard: 'Safety gate',
  wait: 'Wait',
  action: 'Action',
});

const EFFECT_LABELS: Readonly<Record<AutomationEffect, string>> = Object.freeze({
  none: 'No effect',
  internal_test: 'TEST workspace only',
  draft_only: 'Draft only · never sent',
});

const PROOF_LABELS: Readonly<Record<AutomationProofState, string>> = Object.freeze({
  verified: 'Verified',
  pending: 'Pending',
  missing: 'Missing',
  expired: 'Expired',
});

const SIMULATION_LABELS: Readonly<Record<AutomationSimulationState, string>> = Object.freeze({
  passed: 'Passed safely',
  failed: 'Failed closed',
  not_run: 'Not run',
});

const OUTCOME_LABELS: Readonly<Record<AutomationSimulationOutcome, string>> = Object.freeze({
  matched: 'Trigger matched',
  passed: 'Gate passed',
  skipped: 'Path skipped',
  waited: 'Time simulated',
  test_mutation: 'TEST change recorded',
  drafted: 'Draft created',
});

const AUDIT_LABELS: Readonly<Record<AutomationAuditEventSnapshot['eventType'], string>> = Object.freeze({
  created: 'Flow created',
  version_saved: 'Version saved',
  reviewed: 'Safety reviewed',
  simulation_completed: 'Simulation completed',
  paused: 'Flow paused',
  test_activated: 'TEST activated',
});

const SENSITIVE_KEY = /(?:api.?key|access.?token|refresh.?token|secret|password|credential|oauth.?code|private.?key)/i;

function bounded(value: unknown, fallback = '', max = AUTOMATION_STUDIO_MAX_TEXT): string {
  if (typeof value !== 'string') return fallback;
  return [...value.trim()].slice(0, max).join('');
}

function boundedInstant(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function safeInteger(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isInteger(value)
    ? Math.min(Math.max(value, min), max)
    : fallback;
}

function anchorFor(nodeId: string, index: number): string {
  const slug = nodeId.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);
  return `automation-node-${slug || 'step'}-${index + 1}`;
}

function safeConfiguration(node: AutomationNodeSnapshot): Readonly<{
  entries: readonly AutomationConfigurationView[];
  rejected: number;
}> {
  let rejected = Math.max(0, node.configuration.length - AUTOMATION_STUDIO_MAX_CONFIG);
  const entries: AutomationConfigurationView[] = [];
  for (const raw of node.configuration.slice(0, AUTOMATION_STUDIO_MAX_CONFIG)) {
    const key = bounded(raw.key, 'setting', 80);
    if (SENSITIVE_KEY.test(key) || SENSITIVE_KEY.test(raw.label)) {
      rejected += 1;
      continue;
    }
    entries.push(Object.freeze({
      key,
      label: bounded(raw.label, 'Setting', 120),
      value: bounded(raw.value, 'Not set', 220),
    }));
  }
  return Object.freeze({ entries: Object.freeze(entries), rejected });
}

function graphHasCycle(nodeIds: readonly string[], edges: readonly AutomationEdgeSnapshot[]): boolean {
  const adjacency = new Map(nodeIds.map((id) => [id, [] as string[]]));
  for (const edge of edges) adjacency.get(edge.fromNodeId)?.push(edge.toNodeId);
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (nodeId: string): boolean => {
    if (visiting.has(nodeId)) return true;
    if (visited.has(nodeId)) return false;
    visiting.add(nodeId);
    for (const next of adjacency.get(nodeId) ?? []) {
      if (visit(next)) return true;
    }
    visiting.delete(nodeId);
    visited.add(nodeId);
    return false;
  };
  return nodeIds.some((nodeId) => visit(nodeId));
}

function reachableFrom(start: string | undefined, nodeIds: readonly string[], edges: readonly AutomationEdgeSnapshot[]): Set<string> {
  if (!start) return new Set();
  const known = new Set(nodeIds);
  const adjacency = new Map(nodeIds.map((id) => [id, [] as string[]]));
  for (const edge of edges) {
    if (known.has(edge.fromNodeId) && known.has(edge.toNodeId)) adjacency.get(edge.fromNodeId)?.push(edge.toNodeId);
  }
  const reached = new Set<string>();
  const pending = [start];
  while (pending.length > 0) {
    const current = pending.shift();
    if (!current || reached.has(current)) continue;
    reached.add(current);
    pending.push(...(adjacency.get(current) ?? []));
  }
  return reached;
}

function hasGuardAncestor(
  target: string,
  guardKind: Exclude<AutomationGuardKind, null>,
  nodes: readonly AutomationNodeSnapshot[],
  edges: readonly AutomationEdgeSnapshot[],
): boolean {
  const guardIds = new Set(nodes.filter((node) => node.guardKind === guardKind).map((node) => node.nodeId));
  const reverse = new Map(nodes.map((node) => [node.nodeId, [] as string[]]));
  for (const edge of edges) reverse.get(edge.toNodeId)?.push(edge.fromNodeId);
  const visited = new Set<string>();
  const pending = [...(reverse.get(target) ?? [])];
  while (pending.length > 0) {
    const current = pending.shift();
    if (!current || visited.has(current)) continue;
    if (guardIds.has(current)) return true;
    visited.add(current);
    pending.push(...(reverse.get(current) ?? []));
  }
  return false;
}

function readinessProofView(proof: AutomationReadinessProofSnapshot, asOfMs: number): AutomationReadinessProofView {
  const verifiedAt = boundedInstant(proof.verifiedAt);
  const expiresAt = boundedInstant(proof.expiresAt);
  const evidenceRef = proof.evidenceRef === null ? null : bounded(proof.evidenceRef, '', 160);
  let state = proof.state;
  if (state === 'verified' && expiresAt !== null && Date.parse(expiresAt) <= asOfMs) state = 'expired';
  if (state === 'verified' && (verifiedAt === null || Date.parse(verifiedAt) > asOfMs || !evidenceRef)) state = 'pending';
  return Object.freeze({
    proofId: bounded(proof.proofId, 'proof', 100),
    label: bounded(proof.label, 'Readiness proof', 160),
    detail: bounded(proof.detail, 'No proof detail supplied.'),
    required: Boolean(proof.required),
    state,
    stateLabel: PROOF_LABELS[state],
    verifiedAt,
    expiresAt,
    evidenceRef,
    passes: !proof.required || state === 'verified',
  });
}

export function presentAutomationStudio(
  snapshot: AutomationStudioSnapshot,
  filters: AutomationStudioFilterInput = {},
): AutomationStudioView {
  const asOf = boundedInstant(snapshot.asOf) ?? new Date(0).toISOString();
  const asOfMs = Date.parse(asOf);
  const boundedNodes = snapshot.nodes.slice(0, AUTOMATION_STUDIO_MAX_NODES);
  const boundedEdges = snapshot.edges.slice(0, AUTOMATION_STUDIO_MAX_EDGES);
  const nodeIds = boundedNodes.map((node) => bounded(node.nodeId, 'node', 100));
  const duplicateNodeIds = nodeIds.length !== new Set(nodeIds).size;
  const nodeById = new Map(boundedNodes.map((node, index) => [nodeIds[index] ?? `node-${index + 1}`, node]));
  const edges = boundedEdges.map((edge) => Object.freeze({
    ...edge,
    edgeId: bounded(edge.edgeId, 'edge', 100),
    fromNodeId: bounded(edge.fromNodeId, 'unknown', 100),
    toNodeId: bounded(edge.toNodeId, 'unknown', 100),
    label: bounded(edge.label, 'Next', 100),
  }));
  const unknownEdgeEndpoints = edges.some((edge) => !nodeById.has(edge.fromNodeId) || !nodeById.has(edge.toNodeId));
  const triggers = boundedNodes.filter((node) => node.kind === 'trigger');
  const triggerId = triggers.length === 1 ? bounded(triggers[0]?.nodeId, '', 100) : undefined;
  const reachable = reachableFrom(triggerId, nodeIds, edges);
  const acyclic = !unknownEdgeEndpoints && !duplicateNodeIds && !graphHasCycle(nodeIds, edges);

  const requestedNode = typeof filters.node === 'string' ? bounded(filters.node, '', 100) : '';
  const selectedId = nodeById.has(requestedNode) ? requestedNode : nodeIds[0];
  const nodeViews = boundedNodes.map((node, index): AutomationNodeView => {
    const nodeId = nodeIds[index] ?? `node-${index + 1}`;
    const configuration = safeConfiguration(node);
    const incoming = edges
      .filter((edge) => edge.toNodeId === nodeId)
      .map((edge) => Object.freeze({
        label: edge.label,
        nodeTitle: bounded(nodeById.get(edge.fromNodeId)?.title, 'Unknown node', 160),
        path: edge.path,
      }));
    const outgoing = edges
      .filter((edge) => edge.fromNodeId === nodeId)
      .map((edge) => Object.freeze({
        label: edge.label,
        nodeTitle: bounded(nodeById.get(edge.toNodeId)?.title, 'Unknown node', 160),
        path: edge.path,
      }));
    const providerSafe = node.providerMode === 'none' || node.providerMode === 'simulated';
    const guardValid = node.kind === 'guard' ? node.guardKind !== null : node.guardKind === null;
    return Object.freeze({
      nodeId,
      anchorId: anchorFor(nodeId, index),
      sequence: index + 1,
      kind: node.kind,
      kindLabel: NODE_KIND_LABELS[node.kind],
      title: bounded(node.title, `Untitled ${NODE_KIND_LABELS[node.kind].toLowerCase()}`, 180),
      detail: bounded(node.detail, 'No step description supplied.'),
      column: safeInteger(node.column, 1, 1, 4),
      row: safeInteger(node.row, index + 1, 1, AUTOMATION_STUDIO_MAX_NODES),
      configured: Boolean(node.configured),
      effect: node.effect,
      effectLabel: EFFECT_LABELS[node.effect],
      guardKind: node.guardKind,
      providerMode: node.providerMode,
      configuration: configuration.entries,
      rejectedConfigurationCount: configuration.rejected,
      incoming: Object.freeze(incoming),
      outgoing: Object.freeze(outgoing),
      selected: nodeId === selectedId,
      nodeReady: Boolean(node.configured) && providerSafe && guardValid && configuration.rejected === 0,
    });
  });
  const selectedNode = nodeViews.find((node) => node.selected) ?? nodeViews[0];
  if (!selectedNode) throw new Error('Automation Studio requires at least one bounded flow node');

  const outboundNodes = boundedNodes.filter((node) => node.effect === 'draft_only');
  const consentGuarded = outboundNodes.length === 0 || outboundNodes.every((node) =>
    hasGuardAncestor(bounded(node.nodeId, '', 100), 'consent', boundedNodes, edges));
  const approvalGuarded = outboundNodes.length === 0 || outboundNodes.every((node) =>
    hasGuardAncestor(bounded(node.nodeId, '', 100), 'approval', boundedNodes, edges));
  const configurationSafe = nodeViews.every((node) => node.nodeReady);
  const providerSafe = boundedNodes.every((node) => node.providerMode === 'none' || node.providerMode === 'simulated');
  const simulationInputComplete = snapshot.simulation.steps.length <= AUTOMATION_STUDIO_MAX_SIMULATION_STEPS;
  const simulationInstantsValid = boundedInstant(snapshot.simulation.startedAt) !== null
    && boundedInstant(snapshot.simulation.completedAt) !== null
    && Date.parse(boundedInstant(snapshot.simulation.startedAt) ?? '') <= Date.parse(boundedInstant(snapshot.simulation.completedAt) ?? '');
  const simulationSafe = snapshot.simulation.state === 'passed'
    && !snapshot.simulation.providerEffects
    && !snapshot.simulation.contactEffects
    && simulationInputComplete
    && simulationInstantsValid;

  const proofs = Object.freeze(snapshot.readinessProofs
    .slice(0, AUTOMATION_STUDIO_MAX_PROOFS)
    .map((proof) => readinessProofView(proof, asOfMs)));
  const requiredProofs = proofs.filter((proof) => proof.required);
  const proofInputComplete = snapshot.readinessProofs.length <= AUTOMATION_STUDIO_MAX_PROOFS;
  const proofsPass = proofInputComplete && requiredProofs.length > 0 && requiredProofs.every((proof) => proof.passes);
  const inputTruncated = snapshot.nodes.length > AUTOMATION_STUDIO_MAX_NODES
    || snapshot.edges.length > AUTOMATION_STUDIO_MAX_EDGES
    || snapshot.readinessProofs.length > AUTOMATION_STUDIO_MAX_PROOFS
    || snapshot.audit.length > AUTOMATION_STUDIO_MAX_AUDIT_EVENTS
    || snapshot.simulation.steps.length > AUTOMATION_STUDIO_MAX_SIMULATION_STEPS;
  const reachedAll = !duplicateNodeIds && reachable.size === nodeIds.length;
  const readinessChecks: readonly AutomationReadinessCheckView[] = Object.freeze([
    Object.freeze({
      key: 'bounded-graph',
      label: 'Bounded flow graph',
      detail: inputTruncated ? 'Input exceeded one or more safe presentation bounds.' : `${nodeIds.length} nodes and ${edges.length} connections fit the safe evaluation window.`,
      passed: !inputTruncated,
      category: 'structure' as const,
    }),
    Object.freeze({
      key: 'one-trigger',
      label: 'One deterministic trigger',
      detail: triggers.length === 1 ? `Starts from “${bounded(triggers[0]?.title, 'Trigger', 120)}”.` : `${triggers.length} trigger nodes found; exactly one is required.`,
      passed: triggers.length === 1,
      category: 'structure' as const,
    }),
    Object.freeze({
      key: 'connected-acyclic',
      label: 'Connected, cycle-free paths',
      detail: acyclic && reachedAll ? 'Every node is reachable and no loop can run forever.' : 'Duplicate IDs, broken connections, unreachable steps or a cycle were detected.',
      passed: acyclic && reachedAll && !unknownEdgeEndpoints,
      category: 'structure' as const,
    }),
    Object.freeze({
      key: 'configured-nodes',
      label: 'Every step configured',
      detail: configurationSafe ? 'All visible settings are complete and contain no credential-shaped fields.' : 'One or more steps are incomplete or supplied a rejected sensitive setting.',
      passed: configurationSafe,
      category: 'structure' as const,
    }),
    Object.freeze({
      key: 'action-present',
      label: 'Useful outcome present',
      detail: boundedNodes.some((node) => node.kind === 'action') ? 'At least one bounded TEST action exists.' : 'Add at least one action before activation.',
      passed: boundedNodes.some((node) => node.kind === 'action'),
      category: 'structure' as const,
    }),
    Object.freeze({
      key: 'test-environment',
      label: 'TEST environment only',
      detail: snapshot.environment === 'test' ? 'This version is explicitly pinned to TEST.' : 'LIVE input is rejected by this non-operational slice.',
      passed: snapshot.environment === 'test',
      category: 'safety' as const,
    }),
    Object.freeze({
      key: 'simulated-providers',
      label: 'Provider isolation',
      detail: providerSafe ? 'All provider-capable steps resolve to NONE or SIMULATED.' : 'An unsupported provider mode was supplied.',
      passed: providerSafe,
      category: 'safety' as const,
    }),
    Object.freeze({
      key: 'consent-ancestor',
      label: 'Consent before outbound draft',
      detail: consentGuarded ? 'Every draft-only action has a consent gate upstream.' : 'A draft-only action can be reached without a consent gate.',
      passed: consentGuarded,
      category: 'safety' as const,
    }),
    Object.freeze({
      key: 'approval-ancestor',
      label: 'Approval before outbound draft',
      detail: approvalGuarded ? 'Every draft-only action has a human-approval gate upstream.' : 'A draft-only action can be reached without a human-approval gate.',
      passed: approvalGuarded,
      category: 'safety' as const,
    }),
    Object.freeze({
      key: 'zero-effect-simulation',
      label: 'Zero-effect simulation passed',
      detail: simulationSafe ? 'The latest complete run passed with zero provider and contact effects.' : 'A current, complete and side-effect-free simulation is required.',
      passed: simulationSafe,
      category: 'evidence' as const,
    }),
    Object.freeze({
      key: 'readiness-proofs',
      label: 'Current readiness evidence',
      detail: proofsPass ? `${requiredProofs.length} required proofs are current.` : 'Required proof is missing, stale, pending or outside the safe evaluation window.',
      passed: proofsPass,
      category: 'evidence' as const,
    }),
  ]);
  const blockers = readinessChecks.filter((check) => !check.passed).map((check) => `${check.label}: ${check.detail}`);
  const testGateOpen = blockers.length === 0;

  const simulationSteps = Object.freeze(snapshot.simulation.steps
    .slice(0, AUTOMATION_STUDIO_MAX_SIMULATION_STEPS)
    .map((step, index): AutomationSimulationStepView => {
      const nodeId = bounded(step.nodeId, 'unknown', 100);
      return Object.freeze({
        sequence: safeInteger(step.sequence, index + 1, 1, AUTOMATION_STUDIO_MAX_SIMULATION_STEPS),
        nodeId,
        nodeTitle: bounded(nodeById.get(nodeId)?.title, 'Unknown flow node', 180),
        outcome: step.outcome,
        outcomeLabel: OUTCOME_LABELS[step.outcome],
        detail: bounded(step.detail, 'No simulation detail supplied.'),
        durationMs: safeInteger(step.durationMs, 0, 0, 60_000),
      });
    }));
  const audit = Object.freeze(snapshot.audit
    .slice(0, AUTOMATION_STUDIO_MAX_AUDIT_EVENTS)
    .map((event) => Object.freeze({
      eventId: bounded(event.eventId, 'audit-event', 100),
      eventType: event.eventType,
      eventLabel: AUDIT_LABELS[event.eventType],
      actorLabel: bounded(event.actorLabel, 'System actor', 160),
      occurredAt: boundedInstant(event.occurredAt),
      detail: bounded(event.detail, 'No event detail supplied.'),
      evidenceRef: bounded(event.evidenceRef, 'evidence:unavailable', 160),
    })));

  return Object.freeze({
    flowId: bounded(snapshot.flowId, 'flow', 100),
    workspaceId: bounded(snapshot.workspaceId, 'workspace', 100),
    workspaceName: bounded(snapshot.workspaceName, 'Property Predator Growth HQ', 180),
    name: bounded(snapshot.name, 'Untitled automation', 180),
    summary: bounded(snapshot.summary, 'No automation summary supplied.'),
    version: safeInteger(snapshot.version, 1, 1, 1_000_000),
    environment: snapshot.environment,
    environmentLabel: snapshot.environment.toUpperCase(),
    runtimeState: snapshot.runtimeState,
    runtimeLabel: snapshot.runtimeState === 'active_test' ? 'Active in TEST' : snapshot.runtimeState === 'paused' ? 'Paused' : 'Draft',
    asOf,
    nodes: Object.freeze(nodeViews),
    selectedNode,
    readinessChecks,
    readinessProofs: proofs,
    simulation: Object.freeze({
      runId: bounded(snapshot.simulation.runId, 'simulation', 100),
      state: snapshot.simulation.state,
      stateLabel: SIMULATION_LABELS[snapshot.simulation.state],
      triggerLabel: bounded(snapshot.simulation.triggerLabel, 'Synthetic TEST trigger', 180),
      startedAt: boundedInstant(snapshot.simulation.startedAt),
      completedAt: boundedInstant(snapshot.simulation.completedAt),
      providerEffects: false,
      contactEffects: false,
      steps: simulationSteps,
    }),
    audit,
    testActivationGate: Object.freeze({
      open: testGateOpen,
      label: testGateOpen ? 'OPEN' : 'CLOSED',
      headline: testGateOpen ? 'Safe to request TEST activation.' : 'TEST activation is locked.',
      detail: testGateOpen
        ? 'Every structural, consent, approval, simulation and evidence check passes. An authenticated command boundary is still required to change state.'
        : `${blockers.length} blocking check${blockers.length === 1 ? '' : 's'} remain. No state change can occur.`,
      blockerCount: blockers.length,
      blockers: Object.freeze(blockers),
      canRequestActivation: testGateOpen && snapshot.runtimeState !== 'active_test',
      canRequestPause: snapshot.runtimeState === 'active_test',
    }),
    liveActivationGate: Object.freeze({
      open: false,
      label: 'CLOSED',
      headline: 'LIVE execution is deliberately unavailable.',
      detail: 'Production activation requires a separately authorised command boundary, connected provider readiness, live consent proof and deployment approval. None exists in this slice.',
    }),
    metrics: Object.freeze({
      nodes: nodeViews.length,
      actions: nodeViews.filter((node) => node.kind === 'action').length,
      checksPassed: readinessChecks.filter((check) => check.passed).length,
      checksTotal: readinessChecks.length,
      proofPassed: requiredProofs.filter((proof) => proof.passes).length,
      proofTotal: requiredProofs.length,
      simulatedSteps: simulationSteps.length,
    }),
    inputTruncated,
    commandBoundaryAvailable: false,
  });
}
