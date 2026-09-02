/**
 * Provider-facing contracts for optional product modules.
 *
 * These contracts deliberately normalise the small amount of state the
 * platform needs. Provider-specific payloads, credentials and webhook bodies
 * stay inside adapters; the CRM and portal never depend on them directly.
 */

/**
 * A single provider-connection row loaded for a workspace.
 *
 * The persistence adapter must obtain this row with a composite
 * `(workspace_id, id)` lookup under the active workspace's RLS context. This
 * TypeScript shape validates identifiers but cannot establish row ownership;
 * the database composite relationship and RLS policy remain the enforcing
 * security boundary.
 */
export interface WorkspaceOwnedProviderConnectionRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly providerId: string;
}

export interface ProviderOperationContext {
  /** Derived from the same database-loaded connection row as connectionId. */
  readonly workspaceId: string;
  /** Derived from a workspace-owned provider connection loaded by the worker. */
  readonly connectionId: string;
  readonly providerId: string;
  /** Our durable operation row, used for reconciliation and audit. */
  readonly operationId: string;
  /** Stable across retries so supported providers can deduplicate effects. */
  readonly idempotencyKey: string;
  readonly correlationId: string;
}

export type ProviderOperationStatus =
  | 'accepted'
  | 'pending'
  | 'succeeded'
  | 'failed'
  | 'needs_attention';

export interface ProviderOperationResult {
  readonly status: ProviderOperationStatus;
  readonly externalId: string | null;
  readonly occurredAt: string;
  readonly retryable: boolean;
  readonly errorCode: string | null;
  /** Safe, user-facing summary. Raw provider payloads belong in protected audit storage. */
  readonly summary: string;
}

export type SocialNetwork =
  | 'facebook'
  | 'instagram'
  | 'linkedin'
  | 'tiktok'
  | 'x'
  | 'youtube'
  | 'google_business_profile'
  | 'threads'
  | 'pinterest';

export interface SocialPublishRequest {
  readonly network: SocialNetwork;
  readonly text: string;
  readonly mediaArtifactIds: readonly string[];
  readonly publishAt: string | null;
  readonly approvalId: string;
}

export interface SocialPublishingProvider {
  publish(context: ProviderOperationContext, request: SocialPublishRequest): Promise<ProviderOperationResult>;
  reconcile(context: ProviderOperationContext, externalId: string): Promise<ProviderOperationResult>;
}

export interface SocialMention {
  readonly externalId: string;
  readonly network: SocialNetwork;
  readonly authorHandle: string | null;
  readonly text: string;
  readonly permalink: string | null;
  readonly occurredAt: string;
  readonly sentiment: 'positive' | 'neutral' | 'negative' | 'unknown';
}

export interface SocialListeningPage {
  readonly mentions: readonly SocialMention[];
  readonly nextCursor: string | null;
}

export interface SocialListeningProvider {
  pullMentions(
    context: ProviderOperationContext,
    input: Readonly<{ cursor: string | null; since: string }>,
  ): Promise<SocialListeningPage>;
}

export type ConversationChannel =
  | 'whatsapp'
  | 'sms'
  | 'email'
  | 'instagram'
  | 'facebook'
  | 'linkedin';
export type ConversationSendChannel = Exclude<ConversationChannel, 'linkedin'>;

export interface ConversationMessageRequest {
  /** LinkedIn is intentionally absent until a separately approved outbound rail exists. */
  readonly channel: ConversationSendChannel;
  /** CRM contact/channel address resolved inside the workspace. */
  readonly recipient: string;
  readonly text: string;
  readonly templateId: string | null;
  readonly consentRecordId: string;
}

export interface ConversationProvider {
  sendMessage(context: ProviderOperationContext, request: ConversationMessageRequest): Promise<ProviderOperationResult>;
  reconcile(context: ProviderOperationContext, externalId: string): Promise<ProviderOperationResult>;
}

export interface WebinarRequest {
  readonly title: string;
  readonly startsAt: string;
  readonly durationMinutes: number;
  readonly timezone: string;
  readonly registrationRequired: boolean;
}

export interface WebinarProvider {
  createWebinar(context: ProviderOperationContext, request: WebinarRequest): Promise<ProviderOperationResult>;
  cancelWebinar(context: ProviderOperationContext, externalId: string): Promise<ProviderOperationResult>;
}

function required(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} is required`);
  return trimmed;
}

function uuid(value: string, label: string): string {
  const trimmed = required(value, label).toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(trimmed)) {
    throw new Error(`${label} must be a UUID`);
  }
  return trimmed;
}

export interface CreateProviderOperationContextInput {
  /** One row returned by the workspace-qualified, RLS-protected DB lookup. */
  readonly connection: WorkspaceOwnedProviderConnectionRecord;
  readonly operationId: string;
  readonly idempotencyKey: string;
  readonly correlationId: string;
}

export function createProviderOperationContext(input: CreateProviderOperationContextInput): ProviderOperationContext {
  return Object.freeze({
    workspaceId: uuid(input.connection.workspaceId, 'connection.workspaceId'),
    connectionId: uuid(input.connection.id, 'connection.id'),
    providerId: required(input.connection.providerId, 'connection.providerId'),
    operationId: uuid(input.operationId, 'operationId'),
    idempotencyKey: required(input.idempotencyKey, 'idempotencyKey'),
    correlationId: uuid(input.correlationId, 'correlationId'),
  });
}
