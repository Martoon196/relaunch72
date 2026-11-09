/**
 * Founder-only contact permission seam for the Lead 360 case file.
 *
 * The router depends on this interface and never on the 0063 function or the
 * consent ledger directly. Nothing here can queue or send a message: the only
 * effect is one appended permission decision and its idempotency receipt.
 *
 * Recording a permission decision never touches suppression. A suppressed
 * endpoint stays suppressed whatever is recorded here, and the database
 * enforces that structurally rather than trusting this seam.
 */

import type { ContactPermissionDecisionInput } from '../contact-permission/foundation.js';
import type { PortalCrmRequestIdentity } from './crm-service.js';

export type PortalContactPermissionFailureKind =
  | 'unauthenticated'
  /** Signed in, but not an active owner or admin of this workspace. */
  | 'forbidden'
  | 'validation'
  /** The command key was reused for different content. */
  | 'conflict'
  | 'unavailable';

export interface PortalContactPermissionFailure {
  readonly ok: false;
  readonly kind: PortalContactPermissionFailureKind;
}

export interface PortalContactPermissionInput extends ContactPermissionDecisionInput {
  /** Fresh per-render key, so a double submit replays instead of re-deciding. */
  readonly commandKey: string;
}

export interface PortalContactPermissionOutcome {
  readonly ok: true;
  /** 'applied' on the first use of a command key, 'replayed' afterwards. */
  readonly disposition: 'applied' | 'replayed';
  readonly consentEventId: string;
  readonly receiptId: string;
  /** Always none. This workflow has no message path at all. */
  readonly messagesQueued: 'none';
}

export type PortalContactPermissionResult =
  | PortalContactPermissionOutcome
  | PortalContactPermissionFailure;

export interface PortalContactPermissionService {
  recordDecision(
    identity: PortalCrmRequestIdentity,
    input: PortalContactPermissionInput,
  ): Promise<PortalContactPermissionResult>;
}
