import { createHmac, timingSafeEqual } from 'node:crypto';

export const OWNED_SEED_PROOF_PREPARE_ROUTE = '/portal/content/owned-seed/prepare' as const;
export const OWNED_SEED_MESSAGE_CREATE_ROUTE = '/portal/content/owned-seed/message' as const;
export const OWNED_SEED_MESSAGE_APPROVAL_REQUEST_ROUTE = '/portal/content/owned-seed/message/approval-request' as const;
export const OWNED_SEED_MESSAGE_APPROVAL_DECISION_ROUTE = '/portal/content/owned-seed/message/approval-decision' as const;
export const OWNED_SEED_CAMPAIGN_STAGE_ROUTE = '/portal/content/owned-seed/stage' as const;

export type OwnedSeedWorkflowPhase =
  | 'drafted'
  | 'approval_pending'
  | 'approved'
  | 'staged'
  | 'blocked';

export interface OwnedSeedWorkflowState {
  readonly phase: OwnedSeedWorkflowPhase;
  readonly companyContentVersionId: string;
  readonly messageId: string;
  readonly messageVersionId: string;
  readonly approvalRequestId: string | null;
  readonly subjectSha256: string;
  readonly bodySha256: string;
  readonly sourceContentSha256: string;
}

const TOKEN_CONTEXT = 'relaunch72:property-predator-owned-seed-workflow:v1\0';
const TOKEN_TTL_MS = 30 * 60 * 1_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const PHASES = new Set<OwnedSeedWorkflowPhase>([
  'drafted', 'approval_pending', 'approved', 'staged', 'blocked',
]);

function canonical(state: OwnedSeedWorkflowState, expiresAt: number): string {
  return JSON.stringify({
    approvalRequestId: state.approvalRequestId,
    bodySha256: state.bodySha256,
    companyContentVersionId: state.companyContentVersionId,
    expiresAt,
    messageId: state.messageId,
    messageVersionId: state.messageVersionId,
    phase: state.phase,
    sourceContentSha256: state.sourceContentSha256,
    subjectSha256: state.subjectSha256,
  });
}

function mac(secret: string, sessionToken: string, payload: string): string {
  return createHmac('sha256', secret)
    .update(TOKEN_CONTEXT)
    .update(sessionToken)
    .update('\0')
    .update(payload)
    .digest('base64url');
}

function validState(state: OwnedSeedWorkflowState): boolean {
  return PHASES.has(state.phase)
    && UUID.test(state.companyContentVersionId)
    && UUID.test(state.messageId)
    && UUID.test(state.messageVersionId)
    && (state.approvalRequestId === null || UUID.test(state.approvalRequestId))
    && SHA256.test(state.subjectSha256)
    && SHA256.test(state.bodySha256)
    && SHA256.test(state.sourceContentSha256)
    && (state.phase === 'drafted'
      ? true
      : state.approvalRequestId !== null);
}

export function ownedSeedWorkflowToken(
  secret: string,
  sessionToken: string,
  state: OwnedSeedWorkflowState,
  now: number,
): string {
  if (!secret || !sessionToken || !validState(state) || !Number.isFinite(now)) return '';
  const payload = canonical(state, Math.floor(now + TOKEN_TTL_MS));
  return `${Buffer.from(payload, 'utf8').toString('base64url')}.${mac(secret, sessionToken, payload)}`;
}

export function verifyOwnedSeedWorkflowToken(
  secret: string,
  sessionToken: string,
  supplied: string | undefined,
  now: number,
): OwnedSeedWorkflowState | null {
  if (!secret || !sessionToken || !supplied || supplied.length > 2_048 || !Number.isFinite(now)) return null;
  const separator = supplied.indexOf('.');
  if (separator <= 0 || supplied.indexOf('.', separator + 1) !== -1) return null;
  const encoded = supplied.slice(0, separator);
  const actualMac = supplied.slice(separator + 1);
  let decoded: unknown;
  let payload: string;
  try {
    payload = Buffer.from(encoded, 'base64url').toString('utf8');
    decoded = JSON.parse(payload) as unknown;
  } catch { return null; }
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) return null;
  const value = decoded as Record<string, unknown>;
  if (Object.keys(value).sort().join(',') !== [
    'approvalRequestId', 'bodySha256', 'companyContentVersionId', 'expiresAt',
    'messageId', 'messageVersionId', 'phase', 'sourceContentSha256', 'subjectSha256',
  ].sort().join(',')) return null;
  const expiresAt = value.expiresAt;
  if (!Number.isSafeInteger(expiresAt) || (expiresAt as number) < now
      || (expiresAt as number) > now + TOKEN_TTL_MS) return null;
  const state = Object.freeze({
    phase: value.phase,
    companyContentVersionId: value.companyContentVersionId,
    messageId: value.messageId,
    messageVersionId: value.messageVersionId,
    approvalRequestId: value.approvalRequestId,
    subjectSha256: value.subjectSha256,
    bodySha256: value.bodySha256,
    sourceContentSha256: value.sourceContentSha256,
  }) as OwnedSeedWorkflowState;
  if (!validState(state) || canonical(state, expiresAt as number) !== payload) return null;
  const expectedMac = mac(secret, sessionToken, payload);
  const actual = Buffer.from(actualMac);
  const expected = Buffer.from(expectedMac);
  return actual.length === expected.length && timingSafeEqual(actual, expected) ? state : null;
}
