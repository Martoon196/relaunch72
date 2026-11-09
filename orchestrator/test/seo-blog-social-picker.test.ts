import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { socialPage } from '../src/portal/seo-blog-view.js';
import { harness, OWNER } from './seo-blog-fixtures.js';
import type { SocialOverview } from '../src/seo-blog/social.js';
import type { SocialDiscovery } from '../src/seo-blog/social-discovery.js';

test('native profile picker offers only verified choices with no manual raw-ID input', async () => {
  const h = harness(), { brand } = await h.engine.createBrand(OWNER, { commandId: randomUUID(), name: 'Harbour', website: 'https://harbour.example' });
  const discovery: SocialDiscovery = { state: 'available', checkedAt: '2026-11-03T12:00:00.000Z', detail: 'Choose this brand profile.', accounts: [], profiles: [{ id: '100000000000000000000001', name: '<Harbour profile>', alreadyRegistered: false, selectable: true, hold: null }] };
  const html = socialPage({ brands: [brand], brand, tab: 'social', csrf: 'exact-csrf', applicationName: 'Relaunch72 Content' }, { overview: { profile: null, accounts: [], bindings: [] }, discovery, connectHere: true, connectHost: 'https://app.relaunch72.com', intentId: randomUUID() });
  assert.match(html, /select id="profile-choice" name="providerProfileId" required/);
  assert.match(html, /&lt;Harbour profile&gt;/); assert.doesNotMatch(html, /<Harbour profile>/);
  assert.doesNotMatch(html, /input[^>]+name="providerProfileId"[^>]+type="text"|paste its id/i);
  assert.match(html, /name="_csrf" value="exact-csrf"/);
});

test('account options require exact provider digest plus signed active brand ownership; independent channels and zero defaults remain', async () => {
  const h = harness(), { brand } = await h.engine.createBrand(OWNER, { commandId: randomUUID(), name: 'Harbour', website: 'https://harbour.example' });
  const profileId = '100000000000000000000001', accountId = '100000000000000000000002';
  const overview: SocialOverview = { profile: { providerConnectionId: randomUUID(), providerProfileId: profileId, registeredAt: '2026-11-03T12:00:00.000Z' }, bindings: [],
    accounts: [{ accountId: randomUUID(), providerAccountIdSha256: 'a'.repeat(64), network: 'linkedin', username: 'harbour', status: 'active', linkedAt: '2026-11-03T12:00:00.000Z', webhookReceiptCount: 1 }] };
  const discovery: SocialDiscovery = { state: 'available', checkedAt: '2026-11-03T12:00:00.000Z', detail: 'Verified provider inventory.', profiles: [{ id: profileId, name: 'Harbour', alreadyRegistered: true, selectable: false, hold: null }],
    accounts: [{ id: accountId, profileId, network: 'linkedin', username: 'harbour', displayName: 'Harbour team', active: true, supported: true, sha256: 'a'.repeat(64) },
      { id: '100000000000000000000003', profileId, network: 'instagram', username: 'pending_receipt', displayName: null, active: true, supported: true, sha256: 'b'.repeat(64) }] };
  const render = (o = overview) => socialPage({ brands: [brand], brand, tab: 'social', csrf: 'exact-csrf' }, { overview: o, discovery, connectHere: true, connectHost: 'https://app.relaunch72.com', intentId: randomUUID() });
  const html = render();
  assert.match(html, new RegExp(`option value="${accountId}"`));
  assert.doesNotMatch(html, /option value="100000000000000000000003"/);
  assert.match(html, /id="daily-linkedin"[^>]+value="0"/); assert.match(html, /id="monthly-linkedin"[^>]+value="0"/);
  assert.doesNotMatch(html, /input[^>]+name="providerAccountId"[^>]+type="text"/);
  assert.match(html, /Connect instagram|Connect Instagram/); assert.match(html, /Finding an account is not enough/i);
  const registeredHtml=render({...overview,bindings:[{id:randomUUID(),network:'linkedin',providerConnectionId:overview.profile!.providerConnectionId,providerAccountIdSha256:'a'.repeat(64),username:'harbour',dailyCap:5,monthlyCap:10,status:'active',registeredAt:'2026-11-03T12:00:00.000Z',revokedAt:null}]});
  assert.match(registeredHtml, /Advanced account details/);assert.match(html,/Review the blog when approval is required/);assert.match(html,/Eligible posting plans start automatically/);
  const withoutAdvanced=registeredHtml.replace(/<details\b[^>]*>[\s\S]*?<\/details>/giu,'');
  assert.doesNotMatch(withoutAdvanced,/aaaaaaaaaaaa…|canonical calendar|always approve the article/i);
  assert.doesNotMatch(render({ ...overview, accounts: [{ ...overview.accounts[0]!, webhookReceiptCount: 0 }] }), new RegExp(`option value="${accountId}"`));
});
