import { createHash } from 'node:crypto';
import type { ProviderOperationContext } from '../providers/contracts.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_TEXT = /^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]*$/u;
const TEST_ADDRESS = /^test-dm:(facebook|instagram|linkedin|tiktok|x):[a-z0-9_.-]{1,64}$/u;
const THREAD_REF = /^test-dm-thread_[a-f0-9]{32}$/u;
const MESSAGE_REF = /^test-dm-message_[a-f0-9]{32}$/u;

export const SOCIAL_DM_DARK_PROVIDER_ID = 'social_dm_dark_simulator';
export type SocialDmNetwork = 'facebook' | 'instagram' | 'linkedin' | 'tiktok' | 'x';

export interface SocialDmDarkCapability {
  readonly network: SocialDmNetwork;
  readonly liveProviderCapability: 'unverified';
  readonly liveProviderConnected: false;
  readonly simulatedInboundText: true;
  readonly simulatedOutboundText: true;
  readonly simulatedThreadReplies: true;
  readonly simulatedAttachments: false;
  readonly maxSimulatedTextBytes: 16_384;
}

const DM_NETWORKS: readonly SocialDmNetwork[] = Object.freeze([
  'facebook', 'instagram', 'linkedin', 'tiktok', 'x',
]);

export const SOCIAL_DM_DARK_CAPABILITY_MATRIX: readonly SocialDmDarkCapability[] = Object.freeze(
  DM_NETWORKS.map((network) => Object.freeze({
    network,
    liveProviderCapability: 'unverified' as const,
    liveProviderConnected: false as const,
    simulatedInboundText: true as const,
    simulatedOutboundText: true as const,
    simulatedThreadReplies: true as const,
    simulatedAttachments: false as const,
    maxSimulatedTextBytes: 16_384 as const,
  })),
);

export interface SocialDmDarkEvidenceInput {
  readonly workspaceId: string;
  readonly connectionId: string;
  readonly network: SocialDmNetwork;
  readonly recipientSha256: string;
  readonly approvalId: string;
  readonly approvalDecision: 'approved_for_test_simulation';
  readonly consentEvidenceId: string;
  readonly consentDecision: 'eligible_for_test_simulation';
  readonly pecrSenderDecisionId: string;
  readonly pecrSenderDecision: 'eligible_for_test_simulation';
  readonly operatorInstigatorDecisionId: string;
  readonly operatorInstigatorDecision: 'eligible_for_test_simulation';
  readonly purpose: 'own_inbox_test';
}

export interface SocialDmDarkEvidence extends SocialDmDarkEvidenceInput {
  readonly evidenceSha256: string;
}

export interface SocialDmDarkRequest {
  readonly network: SocialDmNetwork;
  readonly recipient: string;
  readonly text: string;
  readonly threadRef: string | null;
  readonly replyToMessageRef: string | null;
  readonly evidence: SocialDmDarkEvidence;
}

export interface SocialDmDarkResult {
  readonly mode: 'simulated_test_only';
  readonly status: 'simulated';
  readonly network: SocialDmNetwork;
  readonly testThreadRef: string;
  readonly testMessageRef: string;
  readonly occurredAt: string;
  readonly providerOperationsCreated: 0;
  readonly externalMessageAttempted: false;
}

export interface SocialDmDarkAdapter {
  readonly providerId: typeof SOCIAL_DM_DARK_PROVIDER_ID;
  readonly mode: 'simulated_test_only';
  simulateMessage(context: ProviderOperationContext, request: SocialDmDarkRequest): Promise<SocialDmDarkResult>;
  reconcileSimulation(
    context: ProviderOperationContext,
    testMessageRef: string,
  ): Promise<SocialDmDarkResult>;
}

export class SocialDmDarkContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SocialDmDarkContractError';
  }
}

function fail(message: string): never {
  throw new SocialDmDarkContractError(message);
}

export function socialDmDarkUuid(value: unknown, label: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) fail(`${label} must be a canonical UUID`);
  return value;
}

export function socialDmDarkNetwork(value: unknown, label: string): SocialDmNetwork {
  if (typeof value !== 'string' || !DM_NETWORKS.includes(value as SocialDmNetwork)) {
    fail(`${label} is invalid`);
  }
  return value as SocialDmNetwork;
}

export function socialDmDarkTestAddress(value: unknown, network: SocialDmNetwork, label: string): string {
  const match = typeof value === 'string' ? TEST_ADDRESS.exec(value) : null;
  if (!match || match[1] !== network) fail(`${label} must be a network-bound test DM address`);
  return value as string;
}

export function socialDmDarkAddressSha256(address: string): string {
  return createHash('sha256').update(address, 'utf8').digest('hex');
}

export function assertSocialDmDarkContext(context: ProviderOperationContext): ProviderOperationContext {
  const exact = Object.freeze({
    workspaceId: context.workspaceId,
    connectionId: context.connectionId,
    providerId: context.providerId,
    operationId: context.operationId,
    idempotencyKey: context.idempotencyKey,
    correlationId: context.correlationId,
  });
  if (exact.providerId !== SOCIAL_DM_DARK_PROVIDER_ID) fail('provider context is not the social DM simulator');
  socialDmDarkUuid(exact.workspaceId, 'context.workspaceId');
  socialDmDarkUuid(exact.connectionId, 'context.connectionId');
  socialDmDarkUuid(exact.operationId, 'context.operationId');
  socialDmDarkUuid(exact.correlationId, 'context.correlationId');
  if (typeof exact.idempotencyKey !== 'string' || exact.idempotencyKey.length < 1
      || exact.idempotencyKey.length > 200 || !SAFE_TEXT.test(exact.idempotencyKey)) {
    fail('context.idempotencyKey is invalid');
  }
  return exact;
}

export function createSocialDmDarkEvidence(input: SocialDmDarkEvidenceInput): SocialDmDarkEvidence {
  const exact = {
    workspaceId: socialDmDarkUuid(input.workspaceId, 'evidence.workspaceId'),
    connectionId: socialDmDarkUuid(input.connectionId, 'evidence.connectionId'),
    network: socialDmDarkNetwork(input.network, 'evidence.network'),
    recipientSha256: input.recipientSha256,
    approvalId: socialDmDarkUuid(input.approvalId, 'evidence.approvalId'),
    approvalDecision: input.approvalDecision,
    consentEvidenceId: socialDmDarkUuid(input.consentEvidenceId, 'evidence.consentEvidenceId'),
    consentDecision: input.consentDecision,
    pecrSenderDecisionId: socialDmDarkUuid(input.pecrSenderDecisionId, 'evidence.pecrSenderDecisionId'),
    pecrSenderDecision: input.pecrSenderDecision,
    operatorInstigatorDecisionId: socialDmDarkUuid(
      input.operatorInstigatorDecisionId, 'evidence.operatorInstigatorDecisionId',
    ),
    operatorInstigatorDecision: input.operatorInstigatorDecision,
    purpose: input.purpose,
  } as const;
  if (typeof exact.recipientSha256 !== 'string' || !SHA256.test(exact.recipientSha256)
      || exact.approvalDecision !== 'approved_for_test_simulation'
      || exact.consentDecision !== 'eligible_for_test_simulation'
      || exact.pecrSenderDecision !== 'eligible_for_test_simulation'
      || exact.operatorInstigatorDecision !== 'eligible_for_test_simulation'
      || exact.purpose !== 'own_inbox_test') fail('social DM evidence is invalid');
  return Object.freeze({
    ...exact,
    evidenceSha256: createHash('sha256').update(JSON.stringify(exact), 'utf8').digest('hex'),
  });
}

export function validateSocialDmDarkRequest(
  context: ProviderOperationContext,
  request: SocialDmDarkRequest,
): Readonly<{
  context: ProviderOperationContext;
  network: SocialDmNetwork;
  recipient: string;
  text: string;
  bodySha256: string;
  threadRef: string | null;
  replyToMessageRef: string | null;
  evidence: SocialDmDarkEvidence;
}> {
  const exactContext = assertSocialDmDarkContext(context);
  const rawNetwork = request.network;
  const rawRecipient = request.recipient;
  const rawText = request.text;
  const rawThreadRef = request.threadRef;
  const rawReplyRef = request.replyToMessageRef;
  const evidenceSnapshot = { ...request.evidence };
  const network = socialDmDarkNetwork(rawNetwork, 'request.network');
  const recipient = socialDmDarkTestAddress(rawRecipient, network, 'request.recipient');
  if (typeof rawText !== 'string' || rawText.length < 1 || !SAFE_TEXT.test(rawText)
      || Buffer.byteLength(rawText, 'utf8') > 16_384) fail('request.text is invalid');
  if (rawThreadRef !== null && (typeof rawThreadRef !== 'string' || !THREAD_REF.test(rawThreadRef))) {
    fail('request.threadRef is invalid');
  }
  if (rawReplyRef !== null && (typeof rawReplyRef !== 'string' || !MESSAGE_REF.test(rawReplyRef))) {
    fail('request.replyToMessageRef is invalid');
  }
  if (rawReplyRef !== null && rawThreadRef === null) fail('a reply requires its test thread');
  const evidence = createSocialDmDarkEvidence(evidenceSnapshot);
  if (evidenceSnapshot.evidenceSha256 !== evidence.evidenceSha256
      || evidence.workspaceId !== exactContext.workspaceId || evidence.connectionId !== exactContext.connectionId
      || evidence.network !== network || evidence.recipientSha256 !== socialDmDarkAddressSha256(recipient)) {
    fail('social DM evidence is not bound to this test operation');
  }
  return Object.freeze({
    context: exactContext,
    network,
    recipient,
    text: rawText,
    bodySha256: createHash('sha256').update(rawText, 'utf8').digest('hex'),
    threadRef: rawThreadRef,
    replyToMessageRef: rawReplyRef,
    evidence,
  });
}
