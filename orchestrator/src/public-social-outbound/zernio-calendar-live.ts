import { createHash } from 'node:crypto';
import {
  ZernioPostingError,
  type ZernioPostingClient,
  type ZernioPostingMediaItem,
  type ZernioPostingNetwork,
  type ZernioPostingSnapshot,
} from './zernio-posting-client.js';

export const ZERNIO_CALENDAR_LIVE_CONTRACT =
  'propertypredator.zernio-calendar-live/v1' as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const PROVIDER_ACCOUNT_ID = /^[a-f0-9]{24}$/u;
const OPERATION_TAG = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/u;

export interface ZernioCalendarAccountBinding {
  readonly network: ZernioPostingNetwork;
  readonly providerAccountId: string;
}

export interface ZernioCalendarRuntimeConfig {
  readonly executionMode: 'disabled' | 'zernio_live';
  readonly providerEffectsEnabled: boolean;
  readonly emergencyPaused: boolean;
  readonly networks: readonly ZernioPostingNetwork[];
  readonly maximumOperationsPerCycle: 1;
  readonly dailyPublishCap: 1;
  readonly monthlyPublishCap: 3;
}

export interface ZernioCalendarClaim {
  readonly workspaceId: string;
  readonly connectionId: string;
  readonly bindingId: string;
  readonly accountRecordId: string;
  readonly jobId: string;
  readonly leaseVersion: number;
  readonly attemptKind: 'publish' | 'reconcile';
  readonly network: ZernioPostingNetwork;
}

export interface ZernioCalendarJobMaterial extends ZernioCalendarClaim {
  readonly providerAccountIdSha256: string;
  readonly operationTag: string;
  readonly text: string;
  readonly textSha256: string;
  readonly scheduledFor: string;
  readonly providerPostId: string | null;
  readonly media: readonly Readonly<{
    storageKey: string;
    blobSha256: string;
    mimeType: string;
  }>[];
}

export type ZernioCalendarSettlement = Readonly<{
  state: 'accepted' | 'published' | 'failed' | 'outcome_unknown';
  providerPostId: string | null;
  receiptSha256: string;
  occurredAt: string;
  safeCode: string;
}>;

export interface ZernioCalendarRepository {
  claimOne(input: Readonly<{
    leaseToken: Buffer;
    leaseSeconds: number;
    networks: readonly ZernioPostingNetwork[];
  }>): Promise<ZernioCalendarClaim | null>;
  loadClaimed(input: ZernioCalendarClaim & Readonly<{
    leaseToken: Buffer;
  }>): Promise<ZernioCalendarJobMaterial>;
  markCalling(input: ZernioCalendarClaim & Readonly<{
    leaseToken: Buffer;
    providerEffectsEnabled: true;
    emergencyPaused: false;
  }>): Promise<boolean>;
  settle(input: ZernioCalendarClaim & Readonly<{
    leaseToken: Buffer;
    result: ZernioCalendarSettlement;
  }>): Promise<void>;
}

export interface ZernioCalendarMediaResolver {
  resolve(input: Readonly<{
    workspaceId: string;
    jobId: string;
    media: ZernioCalendarJobMaterial['media'];
  }>): Promise<readonly string[]>;
}

export class ZernioCalendarLiveError extends Error {
  constructor(readonly code: 'disabled' | 'invalid_configuration' | 'invalid_binding') {
    super(code);
    this.name = 'ZernioCalendarLiveError';
  }
}

function fail(code: ZernioCalendarLiveError['code']): never {
  throw new ZernioCalendarLiveError(code);
}

function exactNetworks(value: unknown): readonly ZernioPostingNetwork[] {
  const networks = value === 'instagram_linkedin'
    ? ['instagram', 'linkedin'] as const
    : value === 'instagram' || value === 'linkedin' ? [value] as const : null;
  if (!networks) fail('invalid_configuration');
  return Object.freeze([...networks]);
}

export function loadZernioCalendarRuntimeConfig(
  env: NodeJS.ProcessEnv,
): ZernioCalendarRuntimeConfig {
  const mode = env.PROPERTY_PREDATOR_PUBLIC_SOCIAL_LIVE_MODE ?? 'disabled';
  const effects = env.PROPERTY_PREDATOR_PROVIDER_EFFECTS_ENABLED === 'true';
  const paused = env.PROPERTY_PREDATOR_SOCIAL_EMERGENCY_PAUSED !== 'false';
  if (mode === 'disabled') {
    if (effects || !paused) fail('invalid_configuration');
    return Object.freeze({
      executionMode: 'disabled', providerEffectsEnabled: false,
      emergencyPaused: true,
      networks: Object.freeze<ZernioPostingNetwork[]>(['instagram', 'linkedin']),
      maximumOperationsPerCycle: 1, dailyPublishCap: 1, monthlyPublishCap: 3,
    });
  }
  if (mode !== 'zernio_live'
      || env.PROPERTY_PREDATOR_PUBLIC_SOCIAL_LIVE_PROVIDER_ID !== 'zernio'
      || !effects || paused) fail('invalid_configuration');
  return Object.freeze({
    executionMode: 'zernio_live', providerEffectsEnabled: true,
    emergencyPaused: false,
    networks: exactNetworks(env.PROPERTY_PREDATOR_PUBLIC_SOCIAL_LIVE_NETWORK),
    maximumOperationsPerCycle: 1, dailyPublishCap: 1, monthlyPublishCap: 3,
  });
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function validateBindings(
  bindings: readonly ZernioCalendarAccountBinding[],
  networks: readonly ZernioPostingNetwork[],
): ReadonlyMap<ZernioPostingNetwork, ZernioCalendarAccountBinding> {
  if (!Array.isArray(bindings) || bindings.length !== networks.length) {
    fail('invalid_configuration');
  }
  const result = new Map<ZernioPostingNetwork, ZernioCalendarAccountBinding>();
  for (const binding of bindings) {
    if (!binding || !networks.includes(binding.network)
        || !PROVIDER_ACCOUNT_ID.test(binding.providerAccountId)
        || result.has(binding.network)) fail('invalid_configuration');
    result.set(binding.network, Object.freeze({ ...binding }));
  }
  return result;
}

function validateClaim(claim: ZernioCalendarClaim): void {
  if (!UUID.test(claim.workspaceId) || !UUID.test(claim.connectionId)
      || !UUID.test(claim.bindingId) || !UUID.test(claim.accountRecordId)
      || !UUID.test(claim.jobId) || !Number.isSafeInteger(claim.leaseVersion)
      || claim.leaseVersion < 1
      || (claim.attemptKind !== 'publish' && claim.attemptKind !== 'reconcile')
      || (claim.network !== 'instagram' && claim.network !== 'linkedin')) {
    fail('invalid_binding');
  }
}

function validateMaterial(claim: ZernioCalendarClaim, material: ZernioCalendarJobMaterial): void {
  validateClaim(material);
  if (material.workspaceId !== claim.workspaceId
      || material.connectionId !== claim.connectionId
      || material.bindingId !== claim.bindingId
      || material.accountRecordId !== claim.accountRecordId
      || material.jobId !== claim.jobId
      || material.leaseVersion !== claim.leaseVersion
      || material.attemptKind !== claim.attemptKind
      || material.network !== claim.network
      || !SHA256.test(material.providerAccountIdSha256)
      || !OPERATION_TAG.test(material.operationTag)
      || typeof material.text !== 'string' || sha256(material.text) !== material.textSha256
      || !Number.isFinite(Date.parse(material.scheduledFor))
      || new Date(material.scheduledFor).toISOString() !== material.scheduledFor
      || !Array.isArray(material.media)
      || material.media.some((item) => !item || typeof item.storageKey !== 'string'
        || !SHA256.test(item.blobSha256) || typeof item.mimeType !== 'string')) {
    fail('invalid_binding');
  }
}

function mediaType(mimeType: string): ZernioPostingMediaItem['type'] {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  fail('invalid_binding');
}

function settlement(
  snapshot: ZernioPostingSnapshot,
  occurredAt: string,
): ZernioCalendarSettlement {
  const platform = snapshot.platforms[0];
  if (!platform || snapshot.platforms.length !== 1) fail('invalid_binding');
  if (snapshot.status === 'published' && platform.status === 'published') {
    return Object.freeze({
      state: 'published', providerPostId: snapshot.providerPostId,
      receiptSha256: snapshot.responseSha256, occurredAt, safeCode: 'zernio_published',
    });
  }
  if ((snapshot.status === 'scheduled' || snapshot.status === 'publishing')
      && (platform.status === 'pending' || platform.status === 'publishing')) {
    return Object.freeze({
      state: 'accepted', providerPostId: snapshot.providerPostId,
      receiptSha256: snapshot.responseSha256, occurredAt, safeCode: 'zernio_accepted',
    });
  }
  if (snapshot.status === 'partial' && platform.status !== 'failed') {
    return Object.freeze({
      state: 'outcome_unknown', providerPostId: snapshot.providerPostId,
      receiptSha256: snapshot.responseSha256, occurredAt, safeCode: 'zernio_partial',
    });
  }
  return Object.freeze({
    state: 'failed', providerPostId: snapshot.providerPostId,
    receiptSha256: snapshot.responseSha256, occurredAt,
    safeCode: snapshot.status === 'partial' ? 'zernio_partial_failed' : 'zernio_failed',
  });
}

function unknownSettlement(
  providerPostId: string | null,
  error: unknown,
  occurredAt: string,
): ZernioCalendarSettlement {
  const known = error instanceof ZernioPostingError ? error.code : 'outcome_unknown';
  const outcomeUnknown = known === 'outcome_unknown' || known === 'provider_unavailable'
    || known === 'rate_limited' || known === 'conflict';
  return Object.freeze({
    state: outcomeUnknown ? 'outcome_unknown' : 'failed', providerPostId,
    receiptSha256: sha256(`zernio:${known}`), occurredAt,
    safeCode: `zernio_${known}`,
  });
}

export async function runZernioCalendarLiveOnce(input: Readonly<{
  config: ZernioCalendarRuntimeConfig;
  accountBindings: readonly ZernioCalendarAccountBinding[];
  repository: ZernioCalendarRepository;
  posting: Pick<ZernioPostingClient, 'publishDue' | 'reconcile'>;
  leaseToken: Buffer;
  mediaResolver: ZernioCalendarMediaResolver;
  now?: () => Date;
}>): Promise<'idle' | 'published_or_pending' | 'failed_or_attention'> {
  if (input.config.executionMode !== 'zernio_live'
      || !input.config.providerEffectsEnabled || input.config.emergencyPaused
      || !Buffer.isBuffer(input.leaseToken) || input.leaseToken.length !== 32) fail('disabled');
  const configured = validateBindings(input.accountBindings, input.config.networks);
  const claim = await input.repository.claimOne({
    leaseToken: input.leaseToken, leaseSeconds: 60, networks: input.config.networks,
  });
  if (!claim) return 'idle';
  validateClaim(claim);
  const material = await input.repository.loadClaimed({ ...claim, leaseToken: input.leaseToken });
  validateMaterial(claim, material);
  const target = configured.get(material.network);
  if (!target || sha256(target.providerAccountId) !== material.providerAccountIdSha256) {
    fail('invalid_binding');
  }
  const urls = material.attemptKind === 'publish'
    ? await input.mediaResolver.resolve({
      workspaceId: material.workspaceId, jobId: material.jobId, media: material.media,
    }) : Object.freeze([]);
  if (urls.length !== material.media.length) fail('invalid_binding');
  const calling = await input.repository.markCalling({
    ...claim, leaseToken: input.leaseToken,
    providerEffectsEnabled: true, emergencyPaused: false,
  });
  if (!calling) return 'failed_or_attention';
  const occurredAt = (input.now ?? (() => new Date()))().toISOString();
  const postingTarget = Object.freeze({
    network: target.network,
    accountId: target.providerAccountId,
  });
  let result: ZernioCalendarSettlement;
  try {
    const snapshot = material.attemptKind === 'publish'
      ? await input.posting.publishDue({
        requestId: material.jobId,
        content: material.text,
        targets: [postingTarget],
        mediaItems: material.media.map((item, index) => ({
          type: mediaType(item.mimeType), url: urls[index]!,
        })),
      })
      : await input.posting.reconcile({
        providerPostId: material.providerPostId ?? '', expectedTargets: [postingTarget],
      });
    result = settlement(snapshot, occurredAt);
  } catch (error) {
    result = unknownSettlement(material.providerPostId, error, occurredAt);
  }
  await input.repository.settle({ ...claim, leaseToken: input.leaseToken, result });
  return result.state === 'accepted' || result.state === 'published'
    ? 'published_or_pending' : 'failed_or_attention';
}
