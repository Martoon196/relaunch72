import type {
  DarkEffectsSwitchScope,
  ProviderActivationGate,
  ProviderActivationRail,
  ProviderActivationReadinessReport,
  ProviderEvidenceStatus,
  SpendAndVolumeCaps,
} from '../provider-activation-readiness/domain.js';
import type { PortalCrmRequestIdentity } from './crm-service.js';

export interface PortalProviderReadinessEvidenceSummary {
  readonly gate: ProviderActivationGate;
  readonly status: ProviderEvidenceStatus;
  readonly verifiedAt: string | null;
  readonly expiresAt: string | null;
}

export type PortalProviderTelemetrySource = 'fictional_simulation' | 'observed_runtime';
export type PortalProviderExecutionMode =
  | 'simulation_only'
  | 'real_adapter_dark'
  | 'not_composed';
export type PortalProviderWorkerState = 'paused' | 'not_composed';
export type PortalProviderSafeErrorClass =
  | 'Error'
  | 'AggregateError'
  | 'TypeError'
  | 'RangeError'
  | 'DatabaseError'
  | 'ConnectionError';

export interface PortalProviderOperationalBlocker {
  readonly code: string;
  readonly message: string;
}

/**
 * Bounded operational evidence only. Counts and timestamps may be sourced
 * from an effects-free worker projection, but raw queue rows, payloads,
 * recipients, provider responses and credentials never cross this boundary.
 */
export interface PortalProviderWorkerTelemetry {
  readonly source: PortalProviderTelemetrySource;
  readonly executionMode: PortalProviderExecutionMode;
  readonly workerState: PortalProviderWorkerState;
  readonly emergencyPaused: true;
  readonly observedAt: string;
  readonly queuedCount: number;
  readonly activeLeaseCount: number;
  readonly activeLeaseExpiresAt: string | null;
  readonly retryWaitCount: number;
  readonly nextRetryAt: string | null;
  readonly reconciliationRequiredCount: number;
  readonly oldestReconciliationAt: string | null;
  readonly errorCount: number;
  readonly lastErrorClass: PortalProviderSafeErrorClass | null;
  readonly blockers: readonly PortalProviderOperationalBlocker[];
}

export interface PortalProviderReadinessRailSnapshot {
  readonly rail: ProviderActivationRail;
  /** Human label only. It does not assert that a provider is registered or connected. */
  readonly providerLabel: string;
  readonly candidateOnly: boolean;
  readonly report: ProviderActivationReadinessReport;
  readonly caps: SpendAndVolumeCaps;
  readonly switches: DarkEffectsSwitchScope;
  readonly evidence: readonly PortalProviderReadinessEvidenceSummary[];
  readonly telemetry: PortalProviderWorkerTelemetry;
}

export interface PortalProviderReadinessSnapshot {
  readonly workspace: Readonly<{
    workspaceId: string;
    workspaceName: string;
    snapshotAt: string;
  }>;
  readonly dataset: 'evidence' | 'illustrative_fixture';
  readonly externalEffects: false;
  readonly rails: readonly PortalProviderReadinessRailSnapshot[];
}

export type PortalProviderReadinessSnapshotOutcome =
  | { readonly ok: true; readonly snapshot: PortalProviderReadinessSnapshot }
  | {
      readonly ok: false;
      readonly kind: 'unauthenticated' | 'forbidden' | 'not_found' | 'invalid_snapshot' | 'unavailable';
      readonly message: string;
    };

/**
 * Read-only portal boundary. Implementations may return readiness evidence but
 * cannot create an adapter operation, load a credential, flip a switch or
 * authorise an effect.
 */
export interface PortalProviderReadinessService {
  snapshot(
    identity: PortalCrmRequestIdentity,
  ): Promise<PortalProviderReadinessSnapshotOutcome>;
}
