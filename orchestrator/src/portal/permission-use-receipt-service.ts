/**
 * The operator's own permission-use receipt, consumed at the moment of
 * authorising a live customer email.
 *
 * 0054 binds the receipt to the acting user AND to the exact request id that
 * authorises the send, so a receipt from any earlier request can never satisfy
 * it. That is deliberate: the receipt records that this person consumed this
 * permission for this exact send, not that they once held it.
 *
 * The rail, the table and the row-level policy all already exist in 0032. This
 * seam composes them; it does not reimplement compliance. Its identity is
 * append-only into that ledger and can do nothing else: no enqueue, no
 * provider, no credential, no consent, no suppression.
 */

import type { PortalCrmRequestIdentity } from './crm-service.js';

export type PermissionUseFailureKind =
  | 'unauthenticated'
  /** Signed in, but not an active owner or admin of this workspace. */
  | 'forbidden'
  | 'validation'
  /** A receipt already exists for this command key, bound to other evidence. */
  | 'conflict'
  /** The scope this receipt would have to be bound to did not resolve. */
  | 'blocked'
  | 'unavailable';

export interface PermissionUseFailure {
  readonly ok: false;
  readonly kind: PermissionUseFailureKind;
}

export interface ConsumePermissionUseInput {
  readonly contactId: string;
  readonly contactPointId: string;
  readonly purpose: string;
  /** The same key the enqueue uses, so a retry reuses one receipt. */
  readonly commandKey: string;
  /** Not after evaluation plus five minutes, which the ledger enforces. */
  readonly authorityValidUntil: string;
}

export interface ConsumePermissionUseOutcome {
  readonly ok: true;
  /** `consumed` on the first authorisation, `replayed` on an identical retry. */
  readonly disposition: 'consumed' | 'replayed';
  readonly permissionUseReceiptId: string;
  readonly complianceSubjectId: string;
  readonly actionScopeSha256: string;
  readonly evidenceSnapshotSha256: string;
  /**
   * Always false, and the ledger's own CHECK constraint enforces it. A receipt
   * written before an enqueue refusal records only that a permission was
   * consumed; it never claims a provider was called.
   */
  readonly providerEffects: false;
}

export type ConsumePermissionUseResult =
  | ConsumePermissionUseOutcome
  | PermissionUseFailure;

export interface PortalPermissionUseReceiptService {
  /** The one workspace this receipt identity is bound to. */
  readonly workspaceId: string;
  consume(
    identity: PortalCrmRequestIdentity,
    input: ConsumePermissionUseInput,
  ): Promise<ConsumePermissionUseResult>;
}
