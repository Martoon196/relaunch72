import type { DatabaseRequestContext } from '../db/rls.js';
import type {
  MetaWhatsAppBinding,
  MetaWhatsAppCredentialEnvelope,
} from './foundation.js';

export type MetaWhatsAppLiveUserContext = DatabaseRequestContext & Readonly<{
  actorKind: 'user';
  userId: string;
  portalSessionTokenHash: Buffer;
}>;

export interface RecordMetaWhatsAppLiveBindingCommand {
  readonly binding: MetaWhatsAppBinding & Readonly<{ bindingId: string }>;
  readonly ownedPhoneSha256: string;
  readonly envelope: MetaWhatsAppCredentialEnvelope;
  readonly ownershipEvidenceSha256: string;
  readonly ownershipObservedAt: string;
  readonly predecessorBindingId: string | null;
}

export interface RecordMetaWhatsAppLiveTemplateCommand {
  readonly bindingId: string;
  readonly templateId: string;
  readonly contentItemId: string;
  readonly contentVersionId: string;
  readonly approvalRequestId: string;
  readonly approvalDecisionId: string;
  readonly templateName: string;
  readonly templateRefSha256: string;
  readonly languageCode: string;
  readonly category: 'utility' | 'marketing';
  readonly providerApprovalEvidenceSha256: string;
  readonly providerApprovedAt: string;
}

export interface EnqueueMetaWhatsAppLiveTemplateCommand {
  readonly bindingId: string;
  readonly templateId: string;
  readonly contactId: string;
  readonly contactPointId: string;
  readonly consentEventId: string;
  readonly complianceSubjectId: string;
  readonly policyPublicationEventId: string;
  readonly pecrSenderDecisionEventId: string;
  readonly pecrInstigatorDecisionEventId: string;
  readonly permissionUseReceiptId: string;
  readonly purpose: string;
  readonly authorityValidUntil: string;
  readonly operationId: string;
  readonly idempotencyKeySha256: string;
  readonly requestSha256: string;
}

/**
 * Exact founder-command seam for the future Live Channels control surface.
 * It accepts evidence identifiers and encrypted provider material only; it
 * cannot call Meta and never accepts a browser-supplied recipient address.
 */
export interface MetaWhatsAppLiveCommandService {
  readonly workspaceId: string;
  recordBinding(
    context: MetaWhatsAppLiveUserContext,
    command: RecordMetaWhatsAppLiveBindingCommand,
  ): Promise<string>;
  revokeBinding(
    context: MetaWhatsAppLiveUserContext,
    command: Readonly<{ bindingId: string; evidenceSha256: string }>,
  ): Promise<string>;
  recordTemplate(
    context: MetaWhatsAppLiveUserContext,
    command: RecordMetaWhatsAppLiveTemplateCommand,
  ): Promise<string>;
  authorizeAndEnqueue(
    context: MetaWhatsAppLiveUserContext,
    command: EnqueueMetaWhatsAppLiveTemplateCommand,
  ): Promise<string>;
}
