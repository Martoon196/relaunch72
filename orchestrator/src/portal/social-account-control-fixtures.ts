import {
  AYRSHARE_PUBLIC_SOCIAL_PROVIDER_ID,
  PUBLIC_SOCIAL_OUTBOUND_CONTRACT_VERSION,
} from '../public-social-outbound/contracts.js';
import type {
  SocialAccountConnection,
  SocialAccountControlSnapshot,
  SocialAccountHealthState,
  SocialAccountNetwork,
  SocialAccountPermission,
  SocialPermissionState,
  SocialPublicationContractState,
} from './social-account-control-presenter.js';

export const PROPERTY_PREDATOR_SOCIAL_ACCOUNTS_AS_OF = '2026-08-28T10:30:00.000Z';

function permission(
  permissionId: string,
  label: string,
  purpose: string,
  state: SocialPermissionState,
  required = true,
): SocialAccountPermission {
  return Object.freeze({ permissionId, label, purpose, state, required });
}

function account(input: Readonly<{
  accountId: string;
  network: SocialAccountNetwork;
  accountLabel: string;
  accountHandle: string;
  accountKind: string;
  connectionState: SocialAccountConnection['connectionState'];
  publicationContract: SocialPublicationContractState;
  providerProfileRef: string | null;
  linkedAt: string | null;
  revokedAt?: string | null;
  healthState: SocialAccountHealthState;
  healthSummary: string;
  healthCheckedAt: string | null;
  latencyMs: number | null;
  permissions: readonly SocialAccountPermission[];
}>): SocialAccountConnection {
  return Object.freeze({
    accountId: input.accountId,
    network: input.network,
    accountLabel: input.accountLabel,
    accountHandle: input.accountHandle,
    accountKind: input.accountKind,
    connectionState: input.connectionState,
    publicationContract: input.publicationContract,
    providerProfileRef: input.providerProfileRef,
    linkedAt: input.linkedAt,
    revokedAt: input.revokedAt ?? null,
    health: Object.freeze({
      state: input.healthState,
      checkedAt: input.healthCheckedAt,
      summary: input.healthSummary,
      latencyMs: input.latencyMs,
    }),
    permissions: Object.freeze([...input.permissions]),
  });
}

/**
 * Fictional social-account control data. Handles, bindings, observations and
 * permission states are invented; there are no provider credentials or calls.
 */
export function createPropertyPredatorSocialAccountControlFixture(): SocialAccountControlSnapshot {
  return Object.freeze({
    workspaceId: '72000000-0000-4000-8000-000000000001',
    workspaceName: 'Property Predator Growth HQ',
    asOf: PROPERTY_PREDATOR_SOCIAL_ACCOUNTS_AS_OF,
    dataset: 'illustrative_fixture',
    provider: Object.freeze({
      providerId: AYRSHARE_PUBLIC_SOCIAL_PROVIDER_ID,
      providerLabel: 'Ayrshare public-social bridge',
      contractVersion: PUBLIC_SOCIAL_OUTBOUND_CONTRACT_VERSION,
      configurationState: 'contract_only',
    }),
    runtime: Object.freeze({
      mode: 'dark_rehearsal',
      providerEffects: false,
      accountLinkingEffects: false,
      publishingEffects: false,
      revocationEffects: false,
      emergencyPause: 'engaged',
      commandBoundary: 'absent',
    }),
    accounts: Object.freeze([
      account({
        accountId: 'fictional-x-primary',
        network: 'x',
        accountLabel: 'Property Predator UK',
        accountHandle: '@PredatorHQ_TEST',
        accountKind: 'Organisation profile · fictional',
        connectionState: 'rehearsal_linked',
        publicationContract: 'contract_ready',
        providerProfileRef: 'fixture-profile:x-primary',
        linkedAt: '2026-08-28T08:14:00.000Z',
        healthState: 'healthy',
        healthSummary: 'Fictional profile binding, read/write scope and reconciliation proof agree.',
        healthCheckedAt: '2026-08-28T10:24:00.000Z',
        latencyMs: 71,
        permissions: [
          permission('x.read', 'Read profile and posts', 'Confirm the linked identity and reconcile exact post history.', 'granted'),
          permission('x.write', 'Create and manage posts', 'Publish the separately approved immutable X post.', 'granted'),
          permission('x.offline', 'Maintain authorised access', 'Refresh the bounded account link without collecting a password.', 'granted'),
        ],
      }),
      account({
        accountId: 'fictional-facebook-page',
        network: 'facebook',
        accountLabel: 'Property Predator',
        accountHandle: 'PropertyPredatorDemo',
        accountKind: 'Business page · fictional',
        connectionState: 'rehearsal_linked',
        publicationContract: 'contract_pending',
        providerProfileRef: 'fixture-profile:facebook-page',
        linkedAt: '2026-08-28T08:18:00.000Z',
        healthState: 'healthy',
        healthSummary: 'Fictional page ownership and requested permission set remain observable.',
        healthCheckedAt: '2026-08-28T10:22:00.000Z',
        latencyMs: 89,
        permissions: [
          permission('facebook.pages_show_list', 'View managed pages', 'Select the intended business page without broad account access.', 'granted'),
          permission('facebook.pages_read_engagement', 'Read page engagement', 'Reconcile page-post status and engagement evidence.', 'granted'),
          permission('facebook.pages_manage_posts', 'Manage page posts', 'Create only separately approved page posts.', 'granted'),
        ],
      }),
      account({
        accountId: 'fictional-instagram-business',
        network: 'instagram',
        accountLabel: 'Property Predator Projects',
        accountHandle: '@propertypredator_demo',
        accountKind: 'Business profile · fictional',
        connectionState: 'attention',
        publicationContract: 'contract_pending',
        providerProfileRef: 'fixture-profile:instagram-business',
        linkedAt: '2026-08-28T08:21:00.000Z',
        healthState: 'degraded',
        healthSummary: 'Fictional identity is visible, but publishing permission evidence is absent.',
        healthCheckedAt: '2026-08-28T10:19:00.000Z',
        latencyMs: 143,
        permissions: [
          permission('instagram.basic', 'Read business profile', 'Confirm the selected business profile.', 'granted'),
          permission('instagram.content_publish', 'Publish content', 'Create only separately approved media placements.', 'missing'),
          permission('instagram.manage_comments', 'Read comment threads', 'Support future supervised inbox reconciliation.', 'not_requested', false),
        ],
      }),
      account({
        accountId: 'fictional-linkedin-company',
        network: 'linkedin',
        accountLabel: 'Property Predator UK',
        accountHandle: 'company/property-predator-demo',
        accountKind: 'Organisation page · fictional',
        connectionState: 'link_required',
        publicationContract: 'contract_pending',
        providerProfileRef: null,
        linkedAt: null,
        healthState: 'unchecked',
        healthSummary: 'No fictional organisation-authorisation ceremony has been completed.',
        healthCheckedAt: null,
        latencyMs: null,
        permissions: [
          permission('linkedin.organisation.read', 'Read organisation identity', 'Confirm administrator access to the intended page.', 'not_requested'),
          permission('linkedin.organisation.write', 'Publish for organisation', 'Create only separately approved organisation posts.', 'not_requested'),
        ],
      }),
      account({
        accountId: 'fictional-tiktok-revoked',
        network: 'tiktok',
        accountLabel: 'Property Predator Clips',
        accountHandle: '@predatorclips_test',
        accountKind: 'Business profile · fictional',
        connectionState: 'revoked',
        publicationContract: 'not_supported',
        providerProfileRef: null,
        linkedAt: '2026-08-27T15:00:00.000Z',
        revokedAt: '2026-08-28T09:02:00.000Z',
        healthState: 'revoked',
        healthSummary: 'The fictional link is revoked and cannot be selected for planning or dispatch.',
        healthCheckedAt: '2026-08-28T09:02:00.000Z',
        latencyMs: null,
        permissions: [
          permission('tiktok.profile.read', 'Read profile', 'Confirm the intended publishing identity.', 'not_requested'),
          permission('tiktok.video.publish', 'Publish video', 'Create only separately approved video placements.', 'not_requested'),
        ],
      }),
    ]),
  });
}
