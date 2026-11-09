import {
  AYRSHARE_LIVE_TRANSPORT_SECURITY_CONTRACT,
  AYRSHARE_PUBLIC_SOCIAL_PROVIDER_ID,
  PUBLIC_SOCIAL_DURABLE_CALLING_FENCE_REQUIRED,
  PUBLIC_SOCIAL_OUTBOUND_CONTRACT_VERSION,
  type PublicSocialReadyNetwork,
} from '../public-social-outbound/contracts.js';

export const SOCIAL_ACCOUNT_CONTROL_ROUTE = '/portal/social/accounts' as const;
export const SOCIAL_ACCOUNT_CONTROL_MAX_ACCOUNTS = 12;
export const SOCIAL_ACCOUNT_CONTROL_MAX_PERMISSIONS = 12;
export const SOCIAL_ACCOUNT_CONTROL_MAX_TEXT = 180;

export type SocialAccountNetwork =
  | PublicSocialReadyNetwork
  | 'facebook'
  | 'instagram'
  | 'linkedin'
  | 'tiktok'
  | 'youtube';

export type SocialAccountConnectionState =
  | 'rehearsal_linked'
  | 'attention'
  | 'link_required'
  | 'revoked';
export type SocialAccountHealthState = 'healthy' | 'degraded' | 'unchecked' | 'revoked';
export type SocialPermissionState = 'granted' | 'missing' | 'not_requested';
export type SocialPublicationContractState = 'contract_ready' | 'contract_pending' | 'not_supported';

export interface SocialAccountPermission {
  readonly permissionId: string;
  readonly label: string;
  readonly purpose: string;
  readonly required: boolean;
  readonly state: SocialPermissionState;
}

export interface SocialAccountHealth {
  readonly state: SocialAccountHealthState;
  readonly checkedAt: string | null;
  readonly summary: string;
  readonly latencyMs: number | null;
}

export interface SocialAccountConnection {
  readonly accountId: string;
  readonly network: SocialAccountNetwork;
  readonly accountLabel: string;
  readonly accountHandle: string;
  readonly accountKind: string;
  readonly connectionState: SocialAccountConnectionState;
  readonly publicationContract: SocialPublicationContractState;
  readonly providerProfileRef: string | null;
  readonly linkedAt: string | null;
  readonly revokedAt: string | null;
  readonly health: SocialAccountHealth;
  readonly permissions: readonly SocialAccountPermission[];
}

export interface SocialAccountRuntimeBoundary {
  readonly mode: 'dark_rehearsal';
  readonly providerEffects: false;
  readonly accountLinkingEffects: false;
  readonly publishingEffects: false;
  readonly revocationEffects: false;
  readonly emergencyPause: 'engaged';
  readonly commandBoundary: 'absent';
}

export interface SocialAccountControlSnapshot {
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly asOf: string;
  readonly dataset: 'illustrative_fixture' | 'evidence';
  readonly provider: Readonly<{
    readonly providerId: typeof AYRSHARE_PUBLIC_SOCIAL_PROVIDER_ID;
    readonly providerLabel: string;
    readonly contractVersion: typeof PUBLIC_SOCIAL_OUTBOUND_CONTRACT_VERSION;
    readonly configurationState: 'contract_only' | 'configured';
  }>;
  readonly runtime: SocialAccountRuntimeBoundary;
  readonly accounts: readonly SocialAccountConnection[];
}

export interface SocialAccountPermissionView extends SocialAccountPermission {
  readonly stateLabel: string;
  readonly tone: 'ready' | 'wait' | 'muted';
  readonly passes: boolean;
}

export interface SocialAccountView {
  readonly accountId: string;
  readonly anchorId: string;
  readonly network: SocialAccountNetwork;
  readonly networkLabel: string;
  readonly networkMark: string;
  readonly accountLabel: string;
  readonly accountHandle: string;
  readonly accountKind: string;
  readonly connectionState: SocialAccountConnectionState;
  readonly connectionLabel: string;
  readonly connectionTone: 'ready' | 'wait' | 'blocked' | 'muted';
  readonly publicationContract: SocialPublicationContractState;
  readonly contractLabel: string;
  readonly contractTone: 'ready' | 'wait' | 'muted';
  readonly providerProfileRef: string | null;
  readonly linkedAt: string | null;
  readonly revokedAt: string | null;
  readonly health: Readonly<{
    readonly state: SocialAccountHealthState;
    readonly label: string;
    readonly tone: 'ready' | 'wait' | 'blocked' | 'muted';
    readonly checkedAt: string | null;
    readonly fresh: boolean;
    readonly summary: string;
    readonly latencyMs: number | null;
  }>;
  readonly permissions: readonly SocialAccountPermissionView[];
  readonly requiredPermissionCount: number;
  readonly grantedPermissionCount: number;
  readonly rehearsalReady: boolean;
  readonly blockers: readonly string[];
  readonly linkActionLabel: string;
  readonly disconnectActionLabel: string;
}

export interface SocialAccountControlView {
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly asOf: string;
  readonly dataset: SocialAccountControlSnapshot['dataset'];
  readonly illustrative: boolean;
  readonly runtimeLocked: boolean;
  readonly provider: Readonly<{
    readonly providerId: string;
    readonly providerLabel: string;
    readonly contractVersion: string;
    readonly configurationLabel: string;
    readonly contractOrigin: string;
    readonly redirectPolicy: string;
    readonly maximumResponseKilobytes: number;
    readonly durableCallerRequired: boolean;
    readonly xByoLinkEvidenceRequired: boolean;
    readonly liveClientAvailable: false;
    readonly readyNetworks: readonly PublicSocialReadyNetwork[];
  }>;
  readonly accounts: readonly SocialAccountView[];
  readonly inputTruncated: boolean;
  readonly metrics: Readonly<{
    readonly accounts: number;
    readonly rehearsalLinked: number;
    readonly healthy: number;
    readonly rehearsalReady: number;
    readonly blocked: number;
    readonly liveConnections: 0;
  }>;
}

const NETWORK_LABELS: Readonly<Record<SocialAccountNetwork, string>> = Object.freeze({
  x: 'X',
  facebook: 'Facebook',
  instagram: 'Instagram',
  linkedin: 'LinkedIn',
  tiktok: 'TikTok',
  youtube: 'YouTube',
});

const NETWORK_MARKS: Readonly<Record<SocialAccountNetwork, string>> = Object.freeze({
  x: 'X',
  facebook: 'f',
  instagram: 'IG',
  linkedin: 'in',
  tiktok: 'TT',
  youtube: 'YT',
});

const CONNECTION_LABELS: Readonly<Record<SocialAccountConnectionState, string>> = Object.freeze({
  rehearsal_linked: 'Rehearsal linked',
  attention: 'Permission attention',
  link_required: 'Link required',
  revoked: 'Revoked',
});

const HEALTH_LABELS: Readonly<Record<SocialAccountHealthState, string>> = Object.freeze({
  healthy: 'Healthy',
  degraded: 'Degraded',
  unchecked: 'Not checked',
  revoked: 'Unavailable',
});

const PERMISSION_LABELS: Readonly<Record<SocialPermissionState, string>> = Object.freeze({
  granted: 'Granted in rehearsal',
  missing: 'Missing',
  not_requested: 'Not requested',
});

const CONTRACT_LABELS: Readonly<Record<SocialPublicationContractState, string>> = Object.freeze({
  contract_ready: 'Dispatch contract ready',
  contract_pending: 'Contract pending',
  not_supported: 'Not in launch scope',
});

function bounded(value: unknown, fallback = ''): string {
  if (typeof value !== 'string') return fallback;
  return [...value.trim()].slice(0, SOCIAL_ACCOUNT_CONTROL_MAX_TEXT).join('');
}

function instant(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function latency(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.min(Math.round(value), 60_000)
    : null;
}

function anchor(value: string, index: number): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-|-$/gu, '').slice(0, 42);
  return `social-account-${slug || index + 1}`;
}

function permissionView(permission: SocialAccountPermission): SocialAccountPermissionView {
  const state = permission.state;
  return Object.freeze({
    permissionId: bounded(permission.permissionId, 'permission'),
    label: bounded(permission.label, 'Account permission'),
    purpose: bounded(permission.purpose, 'Required for the declared account operation.'),
    required: Boolean(permission.required),
    state,
    stateLabel: PERMISSION_LABELS[state],
    tone: state === 'granted' ? 'ready' : state === 'missing' ? 'wait' : 'muted',
    passes: !permission.required || state === 'granted',
  });
}

function accountView(
  account: SocialAccountConnection,
  index: number,
  asOfMs: number,
): SocialAccountView {
  const permissions = Object.freeze(account.permissions
    .slice(0, SOCIAL_ACCOUNT_CONTROL_MAX_PERMISSIONS)
    .map(permissionView));
  const permissionsComplete = account.permissions.length <= SOCIAL_ACCOUNT_CONTROL_MAX_PERMISSIONS;
  const requiredPermissions = permissions.filter((permission) => permission.required);
  const checkedAt = instant(account.health.checkedAt);
  const checkedAtMs = checkedAt === null ? Number.NaN : Date.parse(checkedAt);
  const fresh = Number.isFinite(checkedAtMs)
    && checkedAtMs <= asOfMs
    && checkedAtMs >= asOfMs - 24 * 60 * 60 * 1_000;
  const linked = account.connectionState === 'rehearsal_linked';
  const healthPasses = account.health.state === 'healthy' && fresh;
  const permissionPasses = permissionsComplete
    && requiredPermissions.length > 0
    && requiredPermissions.every((permission) => permission.passes);
  const contractPasses = account.publicationContract === 'contract_ready' && account.network === 'x';
  const boundedProviderProfileRef = bounded(account.providerProfileRef);
  const profileBound = Boolean(boundedProviderProfileRef);
  const blockers: string[] = [];
  if (!linked) blockers.push(`Connection is ${CONNECTION_LABELS[account.connectionState].toLowerCase()}`);
  if (!healthPasses) blockers.push(account.health.state === 'healthy' ? 'Health evidence is stale or future-dated' : `Health is ${HEALTH_LABELS[account.health.state].toLowerCase()}`);
  if (!profileBound) blockers.push('No fictional provider-profile binding is recorded');
  if (requiredPermissions.length === 0) blockers.push('No required permissions are declared');
  if (!permissionsComplete) blockers.push('Permission input exceeded the safe display bound');
  for (const permission of requiredPermissions) {
    if (!permission.passes) blockers.push(`${permission.label}: ${permission.stateLabel.toLowerCase()}`);
  }
  if (!contractPasses) blockers.push(account.publicationContract === 'contract_pending'
    ? `${NETWORK_LABELS[account.network]} dispatch contract is not implemented`
    : `${NETWORK_LABELS[account.network]} is outside the proven v1 dispatch contract`);
  const rehearsalReady = linked && healthPasses && profileBound && permissionPasses && contractPasses;
  const connectionTone: SocialAccountView['connectionTone'] = linked
    ? 'ready'
    : account.connectionState === 'attention'
      ? 'wait'
      : account.connectionState === 'revoked'
        ? 'muted'
        : 'blocked';
  const healthTone: SocialAccountView['health']['tone'] = account.health.state === 'healthy' && fresh
    ? 'ready'
    : account.health.state === 'degraded'
      ? 'wait'
      : account.health.state === 'revoked'
        ? 'muted'
        : 'blocked';
  const contractTone: SocialAccountView['contractTone'] = account.publicationContract === 'contract_ready'
    ? 'ready'
    : account.publicationContract === 'contract_pending'
      ? 'wait'
      : 'muted';
  return Object.freeze({
    accountId: bounded(account.accountId, `account-${index + 1}`),
    anchorId: anchor(account.accountId, index),
    network: account.network,
    networkLabel: NETWORK_LABELS[account.network],
    networkMark: NETWORK_MARKS[account.network],
    accountLabel: bounded(account.accountLabel, `${NETWORK_LABELS[account.network]} account`),
    accountHandle: bounded(account.accountHandle, 'No public handle'),
    accountKind: bounded(account.accountKind, 'Social account'),
    connectionState: account.connectionState,
    connectionLabel: CONNECTION_LABELS[account.connectionState],
    connectionTone,
    publicationContract: account.publicationContract,
    contractLabel: CONTRACT_LABELS[account.publicationContract],
    contractTone,
    providerProfileRef: boundedProviderProfileRef || null,
    linkedAt: instant(account.linkedAt),
    revokedAt: instant(account.revokedAt),
    health: Object.freeze({
      state: account.health.state,
      label: healthPasses ? HEALTH_LABELS[account.health.state] : account.health.state === 'healthy' ? 'Stale' : HEALTH_LABELS[account.health.state],
      tone: healthTone,
      checkedAt,
      fresh,
      summary: bounded(account.health.summary, 'No bounded health observation is available.'),
      latencyMs: latency(account.health.latencyMs),
    }),
    permissions,
    requiredPermissionCount: requiredPermissions.length,
    grantedPermissionCount: requiredPermissions.filter((permission) => permission.passes).length,
    rehearsalReady,
    blockers: Object.freeze(blockers),
    linkActionLabel: account.connectionState === 'revoked'
      ? `Re-link ${NETWORK_LABELS[account.network]}`
      : linked || account.connectionState === 'attention'
        ? `Refresh ${NETWORK_LABELS[account.network]} link`
        : `Link ${NETWORK_LABELS[account.network]} account`,
    disconnectActionLabel: account.connectionState === 'revoked'
      ? 'Already disconnected'
      : `Disconnect ${NETWORK_LABELS[account.network]}`,
  });
}

export function presentSocialAccountControl(snapshot: SocialAccountControlSnapshot): SocialAccountControlView {
  const asOf = instant(snapshot.asOf) ?? new Date(0).toISOString();
  const asOfMs = Date.parse(asOf);
  const boundedAccounts = snapshot.accounts.slice(0, SOCIAL_ACCOUNT_CONTROL_MAX_ACCOUNTS);
  const accounts = Object.freeze(boundedAccounts.map((account, index) => accountView(account, index, asOfMs)));
  const runtimeLocked = snapshot.runtime.mode === 'dark_rehearsal'
    && snapshot.runtime.providerEffects === false
    && snapshot.runtime.accountLinkingEffects === false
    && snapshot.runtime.publishingEffects === false
    && snapshot.runtime.revocationEffects === false
    && snapshot.runtime.emergencyPause === 'engaged'
    && snapshot.runtime.commandBoundary === 'absent';
  return Object.freeze({
    workspaceId: bounded(snapshot.workspaceId, 'workspace'),
    workspaceName: bounded(snapshot.workspaceName, 'Property Predator Growth HQ'),
    asOf,
    dataset: snapshot.dataset,
    illustrative: snapshot.dataset === 'illustrative_fixture',
    runtimeLocked,
    provider: Object.freeze({
      providerId: snapshot.provider.providerId,
      providerLabel: bounded(snapshot.provider.providerLabel, 'Ayrshare'),
      contractVersion: snapshot.provider.contractVersion,
      configurationLabel: snapshot.provider.configurationState === 'contract_only'
        ? 'Contract model only'
        : 'Configuration evidence present',
      contractOrigin: AYRSHARE_LIVE_TRANSPORT_SECURITY_CONTRACT.origin,
      redirectPolicy: AYRSHARE_LIVE_TRANSPORT_SECURITY_CONTRACT.redirectPolicy,
      maximumResponseKilobytes: AYRSHARE_LIVE_TRANSPORT_SECURITY_CONTRACT.maximumResponseBytes / 1024,
      durableCallerRequired: PUBLIC_SOCIAL_DURABLE_CALLING_FENCE_REQUIRED,
      xByoLinkEvidenceRequired: AYRSHARE_LIVE_TRANSPORT_SECURITY_CONTRACT.xByoLinkedAccountEvidenceRequired,
      liveClientAvailable: false as const,
      readyNetworks: Object.freeze(['x'] satisfies PublicSocialReadyNetwork[]),
    }),
    accounts,
    inputTruncated: snapshot.accounts.length > accounts.length,
    metrics: Object.freeze({
      accounts: accounts.length,
      rehearsalLinked: accounts.filter((account) => account.connectionState === 'rehearsal_linked' || account.connectionState === 'attention').length,
      healthy: accounts.filter((account) => account.health.state === 'healthy' && account.health.fresh).length,
      rehearsalReady: accounts.filter((account) => account.rehearsalReady).length,
      blocked: accounts.filter((account) => !account.rehearsalReady).length,
      liveConnections: 0 as const,
    }),
  });
}
