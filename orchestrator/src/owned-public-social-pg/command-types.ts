import type { Pool } from 'pg';
import type { DatabaseRequestContext } from '../db/rls.js';
import type {
  OwnedProfileKeyEnvelope,
  OwnedPublicSocialNetwork,
} from '../public-social-outbound/owned-live-foundation.js';

export const OWNED_PUBLIC_SOCIAL_COMMAND_DATABASE_ROLE =
  'r72_owned_social_command' as const;
export const OWNED_PUBLIC_SOCIAL_DAILY_PUBLISH_CAP = 1 as const;
export const OWNED_PUBLIC_SOCIAL_MONTHLY_PUBLISH_CAP = 3 as const;

export type OwnedPublicSocialLiveUserContext = DatabaseRequestContext & Readonly<{
  actorKind: 'user';
  userId: string;
  portalSessionTokenHash: Buffer;
}>;

/**
 * Encrypted profile material and immutable ownership evidence only. The
 * founder command boundary never accepts an Ayrshare API key or plaintext
 * profile key.
 */
export interface RecordOwnedPublicSocialProfileCommand {
  readonly network?: OwnedPublicSocialNetwork;
  readonly profileId: string;
  readonly displayName: string;
  readonly providerProfileRefSha256: string;
  readonly ownedAccountRefSha256: string;
  readonly envelope: OwnedProfileKeyEnvelope;
  readonly providerLinkEvidenceSha256?: string;
  /** Legacy alias accepted only while old X fixtures are retired. */
  readonly xOAuthLinkEvidenceSha256?: string;
  readonly linkedAt: string;
  readonly evidenceObservedAt: string;
}

export interface RevokeOwnedPublicSocialProfileCommand {
  readonly profileId: string;
  readonly revocationEvidenceSha256: string;
  readonly reasonCode: string;
}

export interface EnqueueOwnedPublicSocialJobCommand {
  readonly network?: OwnedPublicSocialNetwork;
  readonly planningIntentId?: string;
  readonly profileId: string;
  readonly contentItemId: string;
  readonly contentVersionId: string;
  readonly approvalRequestId: string;
  readonly approvalDecisionId: string;
  readonly sourceAttestationId: string;
  readonly operationTag: string;
  readonly idempotencyKeySha256: string;
  readonly requestSha256: string;
  readonly scheduledFor: string | null;
}

export interface RecordOwnedPublicSocialProfileResult {
  readonly profileId: string;
  readonly providerEffects: 'none';
}

export interface RevokeOwnedPublicSocialProfileResult {
  readonly revocationId: string;
  readonly providerEffects: 'none';
}

export interface EnqueueOwnedPublicSocialJobResult {
  readonly jobId: string;
  readonly providerEffects: 'none';
  readonly caps: Readonly<{
    daily: typeof OWNED_PUBLIC_SOCIAL_DAILY_PUBLISH_CAP;
    monthly: typeof OWNED_PUBLIC_SOCIAL_MONTHLY_PUBLISH_CAP;
  }>;
}

export interface OwnedPublicSocialLiveCommandService {
  readonly workspaceId: string;
  readonly providerConnectionId: string;
  recordProfile(
    context: OwnedPublicSocialLiveUserContext,
    command: RecordOwnedPublicSocialProfileCommand,
  ): Promise<RecordOwnedPublicSocialProfileResult>;
  revokeProfile(
    context: OwnedPublicSocialLiveUserContext,
    command: RevokeOwnedPublicSocialProfileCommand,
  ): Promise<RevokeOwnedPublicSocialProfileResult>;
  enqueue(
    context: OwnedPublicSocialLiveUserContext,
    command: EnqueueOwnedPublicSocialJobCommand,
  ): Promise<EnqueueOwnedPublicSocialJobResult>;
}

export interface OwnedPublicSocialLiveCommandServiceDependencies {
  readonly commandPool: Pick<Pool, 'connect'>;
  readonly workspaceId: string;
  readonly providerConnectionId: string;
}

export class OwnedPublicSocialLiveCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OwnedPublicSocialLiveCommandError';
  }
}
