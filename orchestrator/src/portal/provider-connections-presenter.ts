/**
 * Pure launch-readiness model for provider adapters.
 *
 * The contract deliberately contains no credential, token, endpoint URL or
 * provider response body. Real adapters can report their bounded status here
 * later without exposing connection material to the portal.
 */

export const PROVIDER_CONNECTIONS_ROUTE = '/portal/connections' as const;
export const PROVIDER_CONNECTIONS_MAX_ADAPTERS = 24;
export const PROVIDER_CONNECTIONS_MAX_CHECKS = 20;
export const PROVIDER_CONNECTIONS_MAX_TEXT = 160;

export type ProviderCategory =
  | 'email'
  | 'sms'
  | 'whatsapp'
  | 'social_publishing'
  | 'social_listening'
  | 'webinar'
  | 'payments'
  | 'ai';

export type ProviderEnvironment = 'test' | 'live';
export type ProviderConnectionState =
  | 'not_configured'
  | 'setup_required'
  | 'verification_pending'
  | 'ready'
  | 'degraded'
  | 'blocked';
export type ProviderAdapterHealthState = 'unknown' | 'healthy' | 'degraded' | 'unreachable';
export type ProviderProofState = 'verified' | 'missing' | 'pending' | 'expired' | 'not_applicable';
export type ProviderProofKind =
  | 'oauth'
  | 'webhook'
  | 'domain'
  | 'consent'
  | 'compliance'
  | 'sandbox_delivery'
  | 'data_processing'
  | 'billing_boundary'
  | 'model_policy';

export interface ProviderAdapterHealthStatus {
  readonly state: ProviderAdapterHealthState;
  /** ISO instant produced by the adapter health probe. */
  readonly checkedAt: string | null;
  /** Bounded diagnostic only; never a raw provider response. */
  readonly summary: string;
  readonly latencyMs?: number | null;
}

export interface ProviderReadinessProof {
  readonly proofId: string;
  readonly kind: ProviderProofKind;
  readonly label: string;
  readonly detail: string;
  readonly required: boolean;
  readonly state: ProviderProofState;
  readonly verifiedAt: string | null;
  readonly expiresAt: string | null;
  /** Opaque non-secret audit reference, not a URL or credential. */
  readonly evidenceRef: string | null;
}

/** Safe status payload a future provider adapter may return to the portal. */
export interface ProviderAdapterStatus {
  readonly adapterId: string;
  readonly category: ProviderCategory;
  readonly providerLabel: string;
  readonly environment: ProviderEnvironment;
  readonly requiredForLaunch: boolean;
  readonly connectionState: ProviderConnectionState;
  readonly statusDetail: string;
  readonly nextStep: string;
  readonly capabilities: readonly string[];
  readonly health: ProviderAdapterHealthStatus;
  readonly proofs: readonly ProviderReadinessProof[];
}

export interface ProviderConnectionsSnapshot {
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly targetEnvironment: ProviderEnvironment;
  readonly asOf: string;
  /** Illustrative fixtures can demonstrate the UI but can never satisfy a launch gate. */
  readonly dataset: 'evidence' | 'illustrative_fixture';
  /** Exact category set that must be represented before this launch can open. */
  readonly requiredCategories: readonly ProviderCategory[];
  readonly adapters: readonly ProviderAdapterStatus[];
}

export interface ProviderProofView extends ProviderReadinessProof {
  readonly stateLabel: string;
  readonly tone: 'pass' | 'wait' | 'fail' | 'muted';
  readonly gatePasses: boolean;
}

export interface ProviderAdapterView {
  readonly adapterId: string;
  readonly anchorId: string;
  readonly category: ProviderCategory;
  readonly categoryLabel: string;
  readonly categoryIndex: string;
  readonly providerLabel: string;
  readonly environment: ProviderEnvironment;
  readonly environmentLabel: string;
  readonly requiredForLaunch: boolean;
  readonly connectionState: ProviderConnectionState;
  readonly connectionLabel: string;
  readonly connectionTone: 'ready' | 'wait' | 'blocked';
  readonly statusDetail: string;
  readonly nextStep: string;
  readonly capabilities: readonly string[];
  readonly health: Readonly<{
    state: ProviderAdapterHealthState;
    label: string;
    tone: 'ready' | 'wait' | 'blocked';
    checkedAt: string | null;
    summary: string;
    latencyMs: number | null;
  }>;
  readonly proofs: readonly ProviderProofView[];
  readonly requiredProofCount: number;
  readonly verifiedProofCount: number;
  readonly blockers: readonly string[];
  readonly gatePasses: boolean;
}

export interface ProviderLaunchGateView {
  readonly open: boolean;
  readonly label: 'OPEN' | 'CLOSED';
  readonly headline: string;
  readonly detail: string;
  readonly requiredAdapterCount: number;
  readonly readyAdapterCount: number;
  readonly requiredProofCount: number;
  readonly verifiedProofCount: number;
  readonly blockerCount: number;
  readonly blockers: readonly Readonly<{
    adapterId: string;
    categoryLabel: string;
    providerLabel: string;
    reason: string;
  }>[];
}

export interface ProviderConnectionsView {
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly targetEnvironment: ProviderEnvironment;
  readonly targetEnvironmentLabel: string;
  readonly asOf: string;
  readonly dataset: ProviderConnectionsSnapshot['dataset'];
  readonly illustrative: boolean;
  readonly adapters: readonly ProviderAdapterView[];
  readonly adapterCount: number;
  readonly inputTruncated: boolean;
  readonly categoryCount: number;
  readonly healthyCount: number;
  readonly setupRequiredCount: number;
  readonly launchGate: ProviderLaunchGateView;
}

const CATEGORY_LABELS: Readonly<Record<ProviderCategory, string>> = Object.freeze({
  email: 'Email',
  sms: 'SMS',
  whatsapp: 'WhatsApp',
  social_publishing: 'Social publishing',
  social_listening: 'Social listening',
  webinar: 'Webinars',
  payments: 'Payments',
  ai: 'AI',
});

const CONNECTION_LABELS: Readonly<Record<ProviderConnectionState, string>> = Object.freeze({
  not_configured: 'Not configured',
  setup_required: 'Setup required',
  verification_pending: 'Proof pending',
  ready: 'Ready',
  degraded: 'Degraded',
  blocked: 'Blocked',
});

const HEALTH_LABELS: Readonly<Record<ProviderAdapterHealthState, string>> = Object.freeze({
  unknown: 'Not checked',
  healthy: 'Healthy',
  degraded: 'Degraded',
  unreachable: 'Unreachable',
});

const PROOF_LABELS: Readonly<Record<ProviderProofState, string>> = Object.freeze({
  verified: 'Verified',
  missing: 'Missing',
  pending: 'Pending',
  expired: 'Expired',
  not_applicable: 'Not required',
});

function bounded(value: unknown, fallback = ''): string {
  if (typeof value !== 'string') return fallback;
  return [...value.trim()].slice(0, PROVIDER_CONNECTIONS_MAX_TEXT).join('');
}

function boundedInstant(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function safeLatency(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.min(Math.round(value), 60_000)
    : null;
}

function slug(value: string, index: number): string {
  const safe = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);
  return `provider-${safe || `adapter-${index + 1}`}`;
}

function proofView(
  proof: ProviderReadinessProof,
  asOfMs: number,
  illustrative: boolean,
): ProviderProofView {
  const expiresAt = boundedInstant(proof.expiresAt);
  const verifiedAt = boundedInstant(proof.verifiedAt);
  const evidenceRef = proof.evidenceRef === null ? null : bounded(proof.evidenceRef);
  const suppliedState = proof.state;
  const state: ProviderProofState = suppliedState === 'verified'
    && expiresAt !== null
    && Date.parse(expiresAt) <= asOfMs
    ? 'expired'
    : suppliedState === 'verified'
      && (verifiedAt === null || Date.parse(verifiedAt) > asOfMs || !evidenceRef)
      ? 'pending'
    : suppliedState;
  const gatePasses = !proof.required || (state === 'verified' && !illustrative);
  const tone: ProviderProofView['tone'] = state === 'verified'
    ? 'pass'
    : state === 'pending'
      ? 'wait'
      : state === 'not_applicable'
        ? 'muted'
        : 'fail';
  return Object.freeze({
    proofId: bounded(proof.proofId, 'proof'),
    kind: proof.kind,
    label: bounded(proof.label, 'Readiness proof'),
    detail: bounded(proof.detail, 'No proof detail supplied.'),
    required: Boolean(proof.required),
    state,
    verifiedAt,
    expiresAt,
    evidenceRef,
    stateLabel: illustrative && state === 'verified'
      ? 'Simulated proof passed'
      : PROOF_LABELS[state],
    tone,
    gatePasses,
  });
}

function adapterView(
  adapter: ProviderAdapterStatus,
  index: number,
  targetEnvironment: ProviderEnvironment,
  asOfMs: number,
  illustrative: boolean,
): ProviderAdapterView {
  const adapterId = bounded(adapter.adapterId, `adapter-${index + 1}`);
  const proofs = Object.freeze(adapter.proofs
    .slice(0, PROVIDER_CONNECTIONS_MAX_CHECKS)
    .map((proof) => proofView(proof, asOfMs, illustrative)));
  const requiredProofs = proofs.filter((proof) => proof.required);
  const environmentPasses = adapter.environment === targetEnvironment;
  const connectionPasses = adapter.connectionState === 'ready';
  const healthPasses = adapter.health.state === 'healthy';
  const proofInputComplete = adapter.proofs.length <= PROVIDER_CONNECTIONS_MAX_CHECKS;
  const proofsPass = proofInputComplete
    && requiredProofs.length > 0
    && requiredProofs.every((proof) => proof.gatePasses);
  const blockers: string[] = [];
  if (!environmentPasses) blockers.push(`Configured for ${adapter.environment.toUpperCase()}, not ${targetEnvironment.toUpperCase()}`);
  if (!connectionPasses) blockers.push(`Connection is ${CONNECTION_LABELS[adapter.connectionState].toLowerCase()}`);
  if (!healthPasses) blockers.push(`Adapter health is ${HEALTH_LABELS[adapter.health.state].toLowerCase()}`);
  if (requiredProofs.length === 0) blockers.push('No required launch proofs are declared');
  if (!proofInputComplete) blockers.push('Proof input exceeded the safe evaluation bound');
  for (const proof of requiredProofs) {
    if (!proof.gatePasses) blockers.push(`${proof.label}: ${proof.stateLabel.toLowerCase()}`);
  }
  const connectionTone: ProviderAdapterView['connectionTone'] = adapter.connectionState === 'ready'
    ? 'ready'
    : adapter.connectionState === 'verification_pending' || adapter.connectionState === 'degraded'
      ? 'wait'
      : 'blocked';
  const healthTone: ProviderAdapterView['health']['tone'] = adapter.health.state === 'healthy'
    ? 'ready'
    : adapter.health.state === 'degraded'
      ? 'wait'
      : 'blocked';
  return Object.freeze({
    adapterId,
    anchorId: slug(adapterId, index),
    category: adapter.category,
    categoryLabel: CATEGORY_LABELS[adapter.category],
    categoryIndex: String(index + 1).padStart(2, '0'),
    providerLabel: bounded(adapter.providerLabel, 'Provider adapter'),
    environment: adapter.environment,
    environmentLabel: adapter.environment.toUpperCase(),
    requiredForLaunch: Boolean(adapter.requiredForLaunch),
    connectionState: adapter.connectionState,
    connectionLabel: CONNECTION_LABELS[adapter.connectionState],
    connectionTone,
    statusDetail: bounded(adapter.statusDetail, 'No connection has been configured.'),
    nextStep: bounded(adapter.nextStep, 'Complete the provider setup brief.'),
    capabilities: Object.freeze(adapter.capabilities.slice(0, 8).map((capability) => bounded(capability)).filter(Boolean)),
    health: Object.freeze({
      state: adapter.health.state,
      label: HEALTH_LABELS[adapter.health.state],
      tone: healthTone,
      checkedAt: boundedInstant(adapter.health.checkedAt),
      summary: bounded(adapter.health.summary, 'No health probe has run.'),
      latencyMs: safeLatency(adapter.health.latencyMs),
    }),
    proofs,
    requiredProofCount: requiredProofs.length,
    verifiedProofCount: requiredProofs.filter((proof) => proof.gatePasses).length,
    blockers: Object.freeze(blockers),
    gatePasses: environmentPasses && connectionPasses && healthPasses && proofsPass,
  });
}

export function presentProviderConnections(snapshot: ProviderConnectionsSnapshot): ProviderConnectionsView {
  const asOf = boundedInstant(snapshot.asOf) ?? new Date(0).toISOString();
  const asOfMs = Date.parse(asOf);
  const illustrative = snapshot.dataset === 'illustrative_fixture';
  const boundedAdapters = snapshot.adapters.slice(0, PROVIDER_CONNECTIONS_MAX_ADAPTERS);
  const adapters = Object.freeze(boundedAdapters.map((adapter, index) =>
    adapterView(adapter, index, snapshot.targetEnvironment, asOfMs, illustrative)));
  const requiredAdapters = adapters.filter((adapter) => adapter.requiredForLaunch);
  const readyAdapters = requiredAdapters.filter((adapter) => adapter.gatePasses);
  const requiredCategories = Object.freeze([...new Set(snapshot.requiredCategories)]);
  const missingCategories = requiredCategories.filter((category) =>
    !requiredAdapters.some((adapter) => adapter.category === category));
  const adapterBlockers = requiredAdapters.flatMap((adapter) =>
    adapter.blockers.map((reason) => Object.freeze({
      adapterId: adapter.adapterId,
      categoryLabel: adapter.categoryLabel,
      providerLabel: adapter.providerLabel,
      reason,
    })));
  const missingCategoryBlockers = missingCategories.map((category) => Object.freeze({
    adapterId: `missing:${category}`,
    categoryLabel: CATEGORY_LABELS[category],
    providerLabel: 'No required adapter declared',
    reason: 'Required provider category is absent from the readiness catalogue',
  }));
  const launchPolicyBlockers = requiredCategories.length === 0
    ? [Object.freeze({
        adapterId: 'launch-policy:missing',
        categoryLabel: 'Launch policy',
        providerLabel: 'No required categories declared',
        reason: 'A deterministic required category set must exist before launch',
      })]
    : [];
  const truncationBlockers = snapshot.adapters.length > boundedAdapters.length
    ? [Object.freeze({
        adapterId: 'catalogue:truncated',
        categoryLabel: 'Provider catalogue',
        providerLabel: 'Bounded readiness view',
        reason: 'Adapter input exceeded the safe evaluation bound',
      })]
    : [];
  const datasetBlockers = illustrative
    ? [Object.freeze({
        adapterId: 'dataset:illustrative-fixture',
        categoryLabel: 'Dataset boundary',
        providerLabel: 'TEST FIXTURE / ILLUSTRATIVE',
        reason: 'Illustrative statuses cannot satisfy a live launch gate',
      })]
    : [];
  const blockers = Object.freeze([
    ...adapterBlockers,
    ...missingCategoryBlockers,
    ...launchPolicyBlockers,
    ...truncationBlockers,
    ...datasetBlockers,
  ]);
  const requiredProofCount = requiredAdapters.reduce((total, adapter) => total + adapter.requiredProofCount, 0);
  const verifiedProofCount = requiredAdapters.reduce((total, adapter) => total + adapter.verifiedProofCount, 0);
  // Empty or partial catalogues always fail closed. Every required adapter and
  // every required proof must exist and pass for the target environment.
  const open = requiredCategories.length > 0
    && requiredAdapters.length > 0
    && missingCategories.length === 0
    && readyAdapters.length === requiredAdapters.length
    && blockers.length === 0;
  const launchGate: ProviderLaunchGateView = Object.freeze({
    open,
    label: open ? 'OPEN' : 'CLOSED',
    headline: open
      ? 'All provider proofs are ready.'
      : `${snapshot.targetEnvironment.toUpperCase()} launch is locked.`,
    detail: open
      ? `All ${requiredAdapters.length} required adapters are healthy in ${snapshot.targetEnvironment.toUpperCase()} with current evidence.`
      : `${blockers.length} blocking check${blockers.length === 1 ? '' : 's'} remain. Nothing here can connect, send, publish or charge.`,
    requiredAdapterCount: requiredAdapters.length,
    readyAdapterCount: readyAdapters.length,
    requiredProofCount,
    verifiedProofCount,
    blockerCount: blockers.length,
    blockers,
  });
  return Object.freeze({
    workspaceId: bounded(snapshot.workspaceId, 'workspace'),
    workspaceName: bounded(snapshot.workspaceName, 'Property Predator Growth HQ'),
    targetEnvironment: snapshot.targetEnvironment,
    targetEnvironmentLabel: snapshot.targetEnvironment.toUpperCase(),
    asOf,
    dataset: snapshot.dataset,
    illustrative,
    adapters,
    adapterCount: adapters.length,
    inputTruncated: snapshot.adapters.length > adapters.length,
    categoryCount: new Set(adapters.map((adapter) => adapter.category)).size,
    healthyCount: adapters.filter((adapter) => adapter.health.state === 'healthy').length,
    setupRequiredCount: adapters.filter((adapter) => !adapter.gatePasses).length,
    launchGate,
  });
}
