/**
 * Founder-only Lead 360 seam for the customer-email pilot.
 *
 * Two actions, both owner/admin-gated and both idempotent on a per-render
 * command key. Attaching an endpoint can create neither a contact nor an
 * opportunity. Reading readiness enqueues nothing and calls no provider.
 *
 * The router depends on this interface and never on the 0064 functions or on
 * the capped enqueue directly.
 */

import type {
  AttachContactEmailEndpointInput,
  FounderEmailPilotReadinessReport,
} from '../founder-email-pilot/foundation.js';
import type { PortalCrmRequestIdentity } from './crm-service.js';

export type FounderEmailPilotFailureKind =
  | 'unauthenticated'
  /** Signed in, but not an active owner or admin of this workspace. */
  | 'forbidden'
  | 'validation'
  /** The command key was reused for different content. */
  | 'conflict'
  /** The database did not prove every readiness dimension. */
  | 'blocked'
  | 'unavailable';

export interface FounderEmailPilotFailure {
  readonly ok: false;
  readonly kind: FounderEmailPilotFailureKind;
}

export interface AttachEndpointInput extends AttachContactEmailEndpointInput {
  /** Fresh per-render key, so a double submit replays instead of re-attaching. */
  readonly commandKey: string;
}

export interface AttachEndpointOutcome {
  readonly ok: true;
  readonly disposition: 'applied' | 'replayed';
  readonly contactPointId: string;
  readonly receiptId: string;
  /** Always none: attaching an endpoint is evidence, not permission. */
  readonly consentRecorded: 'none';
}

export type AttachEndpointResult = AttachEndpointOutcome | FounderEmailPilotFailure;

export interface PilotReadinessInput {
  readonly contactId: string;
  readonly contactPointId: string;
  readonly purpose: string;
}

export interface PilotReadinessOutcome {
  readonly ok: true;
  readonly report: FounderEmailPilotReadinessReport;
  /** Exactly what would be sent, shown before any authorisation. */
  readonly preview: FounderEmailPilotPreview | null;
}

export interface FounderEmailPilotPreview {
  readonly recipientEmail: string;
  readonly recipientVerified: boolean;
  readonly purpose: string;
  readonly dailyUsed: number;
  readonly dailyCap: number;
  readonly monthlyUsed: number;
  readonly monthlyCap: number;
}

export type PilotReadinessResult = PilotReadinessOutcome | FounderEmailPilotFailure;

export interface PortalFounderEmailPilotService {
  attachEndpoint(
    identity: PortalCrmRequestIdentity,
    input: AttachEndpointInput,
  ): Promise<AttachEndpointResult>;
  readiness(
    identity: PortalCrmRequestIdentity,
    input: PilotReadinessInput,
  ): Promise<PilotReadinessResult>;
}
