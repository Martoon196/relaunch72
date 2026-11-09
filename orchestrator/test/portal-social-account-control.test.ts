import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AYRSHARE_LIVE_TRANSPORT_SECURITY_CONTRACT,
  AYRSHARE_PUBLIC_SOCIAL_PROVIDER_ID,
  PUBLIC_SOCIAL_OUTBOUND_CONTRACT_VERSION,
} from '../src/public-social-outbound/contracts.js';
import {
  createPropertyPredatorSocialAccountControlFixture,
  PROPERTY_PREDATOR_SOCIAL_ACCOUNTS_AS_OF,
} from '../src/portal/social-account-control-fixtures.js';
import {
  presentSocialAccountControl,
  SOCIAL_ACCOUNT_CONTROL_MAX_ACCOUNTS,
  SOCIAL_ACCOUNT_CONTROL_MAX_PERMISSIONS,
  SOCIAL_ACCOUNT_CONTROL_ROUTE,
  type SocialAccountControlSnapshot,
} from '../src/portal/social-account-control-presenter.js';
import { renderSocialAccountControlBody } from '../src/portal/social-account-control-view.js';

function present(snapshot = createPropertyPredatorSocialAccountControlFixture()) {
  return presentSocialAccountControl(snapshot);
}

test('social-account control room reuses the exact dark Ayrshare contract', () => {
  const view = present();
  assert.equal(SOCIAL_ACCOUNT_CONTROL_ROUTE, '/portal/social/accounts');
  assert.equal(view.provider.providerId, AYRSHARE_PUBLIC_SOCIAL_PROVIDER_ID);
  assert.equal(view.provider.contractVersion, PUBLIC_SOCIAL_OUTBOUND_CONTRACT_VERSION);
  assert.equal(view.provider.contractOrigin, AYRSHARE_LIVE_TRANSPORT_SECURITY_CONTRACT.origin);
  assert.equal(view.provider.redirectPolicy, 'error');
  assert.equal(view.provider.maximumResponseKilobytes, 64);
  assert.equal(view.provider.durableCallerRequired, true);
  assert.equal(view.provider.xByoLinkEvidenceRequired, true);
  assert.equal(view.provider.liveClientAvailable, false);
  assert.deepEqual(view.provider.readyNetworks, ['x']);
});

test('fictional roster exposes linking, health, permissions and revocation states honestly', () => {
  const view = present();
  assert.equal(view.illustrative, true);
  assert.equal(view.runtimeLocked, true);
  assert.deepEqual(view.metrics, {
    accounts: 5,
    rehearsalLinked: 3,
    healthy: 2,
    rehearsalReady: 1,
    blocked: 4,
    liveConnections: 0,
  });

  const x = view.accounts.find((account) => account.network === 'x');
  const facebook = view.accounts.find((account) => account.network === 'facebook');
  const instagram = view.accounts.find((account) => account.network === 'instagram');
  const linkedin = view.accounts.find((account) => account.network === 'linkedin');
  const tiktok = view.accounts.find((account) => account.network === 'tiktok');
  assert.ok(x && facebook && instagram && linkedin && tiktok);
  assert.equal(x.rehearsalReady, true);
  assert.equal(x.publicationContract, 'contract_ready');
  assert.equal(x.grantedPermissionCount, 3);
  assert.equal(facebook.rehearsalReady, false);
  assert.match(facebook.blockers.join(' '), /Facebook dispatch contract is not implemented/);
  assert.equal(instagram.connectionLabel, 'Permission attention');
  assert.match(instagram.blockers.join(' '), /Publish content: missing/);
  assert.equal(linkedin.providerProfileRef, null);
  assert.match(linkedin.blockers.join(' '), /No fictional provider-profile binding/);
  assert.equal(tiktok.connectionState, 'revoked');
  assert.equal(tiktok.health.label, 'Unavailable');
  assert.equal(tiktok.disconnectActionLabel, 'Already disconnected');
});

test('stale or future-dated health evidence fails a rehearsal-ready account closed', () => {
  const fixture = createPropertyPredatorSocialAccountControlFixture();
  const first = fixture.accounts[0];
  assert.ok(first);
  for (const checkedAt of ['2026-08-25T10:24:00.000Z', '2026-08-28T11:24:00.000Z']) {
    const snapshot: SocialAccountControlSnapshot = {
      ...fixture,
      accounts: [{ ...first, health: { ...first.health, checkedAt } }, ...fixture.accounts.slice(1)],
    };
    const view = present(snapshot);
    const x = view.accounts[0];
    assert.ok(x);
    assert.equal(x.health.label, 'Stale');
    assert.equal(x.rehearsalReady, false);
    assert.match(x.blockers.join(' '), /Health evidence is stale or future-dated/);
  }
});

test('social-account control renders premium, touch-ready controls with all effects dark', () => {
  const html = renderSocialAccountControlBody(present());
  assert.match(html, /<article class="sac" aria-labelledby="sac-title" data-provider-effects="off" data-account-linking-effects="off" data-publishing-effects="off" data-revocation-effects="off" data-command-boundary="absent">/);
  assert.match(html, /Plug in the audience\.<br><em>Keep the power off\.<\/em>/);
  assert.match(html, /A Hootsuite-class account control room/);
  assert.match(html, /FICTIONAL ACCOUNT REHEARSAL/);
  assert.match(html, /Nothing was read from an external social provider or network/);
  assert.match(html, /Emergency pause engaged/);
  assert.match(html, /4 effects switches OFF/);
  assert.match(html, /Ayrshare public-social bridge/);
  assert.match(html, /r72-public-social-v1/);
  assert.match(html, /X BYO link evidence<\/span><strong>REQUIRED/);
  assert.match(html, /X-only v1 seam/);
  assert.match(html, /Permission ledger/);
  assert.match(html, /Why blocked/);
  assert.match(html, /Disconnect &amp; revoke controls/);
  assert.match(html, /Disconnect X · effects off/);
  assert.match(html, /Link LinkedIn account · unavailable/);
  assert.match(html, /min-height:46px/);
  assert.match(html, /min-height:48px/);
  assert.match(html, /:focus-visible/);
  assert.match(html, /@media\(max-width:840px\)/);
  assert.match(html, /@media\(max-width:620px\)/);
  assert.match(html, /@media\(forced-colors:active\)/);
  assert.match(html, /@media\(prefers-reduced-motion:reduce\)/);
  const buttons = html.match(/<button\b[^>]*>/gu) ?? [];
  assert.equal(buttons.length, 15);
  assert.ok(buttons.every((button) => /disabled aria-disabled="true"/u.test(button)));
  assert.equal((html.match(/<details class="sac-disconnect">/gu) ?? []).length, 5);
  assert.doesNotMatch(html, /<form\b|method="post"|<script\b|fetch\s*\(|window\.open|oauth\/authorize/iu);
  assert.doesNotMatch(html, /apiKey|profileKey|accessToken|refreshToken|clientSecret/iu);
});

test('social-account control escapes hostile account, permission and workspace copy', () => {
  const fixture = createPropertyPredatorSocialAccountControlFixture();
  const first = fixture.accounts[0];
  const firstPermission = first?.permissions[0];
  assert.ok(first && firstPermission);
  const hostile: SocialAccountControlSnapshot = {
    ...fixture,
    workspaceName: '<script>alert(1)</script> Growth & Co',
    provider: { ...fixture.provider, providerLabel: '<img src=x onerror=alert(2)>' },
    accounts: [{
      ...first,
      accountLabel: '</h3><script>alert(3)</script>',
      accountHandle: '" onmouseover="alert(4)',
      health: { ...first.health, summary: '<svg onload=alert(5)>' },
      permissions: [{
        ...firstPermission,
        label: '</strong><script>alert(6)</script>',
        purpose: '<img src=x onerror=alert(7)>',
      }],
    }],
  };
  const html = renderSocialAccountControlBody(present(hostile));
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt; Growth &amp; Co/);
  assert.match(html, /&lt;img src=x onerror=alert\(2\)&gt;/);
  assert.match(html, /&lt;\/h3&gt;&lt;script&gt;alert\(3\)&lt;\/script&gt;/);
  assert.match(html, /&lt;svg onload=alert\(5\)&gt;/);
  assert.doesNotMatch(html, /<(?:script|img|svg)\b/iu);
});

test('social-account and permission collections are bounded and fail closed', () => {
  const fixture = createPropertyPredatorSocialAccountControlFixture();
  const first = fixture.accounts[0];
  const firstPermission = first?.permissions[0];
  assert.ok(first && firstPermission);
  const snapshot: SocialAccountControlSnapshot = {
    ...fixture,
    accounts: Array.from({ length: SOCIAL_ACCOUNT_CONTROL_MAX_ACCOUNTS + 3 }, (_, index) => ({
      ...first,
      accountId: `bounded-account-${index}`,
      permissions: Array.from({ length: SOCIAL_ACCOUNT_CONTROL_MAX_PERMISSIONS + 2 }, (__, permissionIndex) => ({
        ...firstPermission,
        permissionId: `permission-${permissionIndex}`,
      })),
    })),
  };
  const view = present(snapshot);
  assert.equal(view.accounts.length, SOCIAL_ACCOUNT_CONTROL_MAX_ACCOUNTS);
  assert.equal(view.inputTruncated, true);
  assert.ok(view.accounts.every((account) => account.permissions.length === SOCIAL_ACCOUNT_CONTROL_MAX_PERMISSIONS));
  assert.ok(view.accounts.every((account) => !account.rehearsalReady));
  assert.ok(view.accounts.every((account) => account.blockers.includes('Permission input exceeded the safe display bound')));
  assert.match(renderSocialAccountControlBody(view), /account catalogue exceeded its safe display bound/);
});

test('fixture timestamps and live-count claims remain deterministic after restarts', () => {
  const first = present();
  const second = present();
  assert.equal(first.asOf, PROPERTY_PREDATOR_SOCIAL_ACCOUNTS_AS_OF);
  assert.deepEqual(first, second);
  assert.equal(first.metrics.liveConnections, 0);
});
