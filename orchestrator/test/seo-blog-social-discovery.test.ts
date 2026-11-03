import assert from 'node:assert/strict';
import test from 'node:test';
import { createSocialProviderInventory } from '../src/seo-blog/social-discovery.js';

const BRAND = '11111111-1111-4111-8111-111111111111', OTHER = '22222222-2222-4222-8222-222222222222';
const id = (n: number) => String(n).padStart(24, '0');
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const request = { brandId: BRAND, registeredProfileId: id(1), reservedProfileIds: [id(4)], registeredBrandFor: async (profile: string) => profile === id(5) ? OTHER : profile === id(1) ? BRAND : null };

test('picker exposes only existing binding and exact externalId brand candidates, never global unclaimed/foreign/reserved profiles', async () => {
  const paths: string[] = [];
  const inventory = createSocialProviderInventory({ apiKey: 'inert-fixture-key', now: () => '2026-11-03T12:00:00.000Z', fetch: (async (url, options) => {
    const parsed = new URL(String(url)); paths.push(parsed.pathname + parsed.search);
    assert.equal(parsed.origin, 'https://zernio.com'); assert.equal(options!.method, 'GET'); assert.equal(options!.redirect, 'error');
    if (parsed.pathname.endsWith('/profiles')) return json({ profiles: [
      { id: id(1), name: 'Previously registered Harbour profile' }, { id: id(2), name: 'Harbour candidate', externalId: BRAND },
      { id: id(3), name: 'SECRET OTHER BRAND NAME', externalId: OTHER }, { id: id(4), name: 'RESERVED LEGACY NAME', externalId: BRAND },
      { id: id(5), name: 'BOUND OTHER BRAND NAME', externalId: BRAND }, { id: id(6), name: 'UNCLAIMED NAME' },
    ] });
    assert.equal(parsed.searchParams.get('profileId'), id(1));
    return json({ accounts: [{ id: id(11), profileId: { _id: id(1) }, platform: 'instagram', username: 'harbour', displayName: 'Harbour', isActive: true },
      { id: id(12), profileId: id(1), platform: 'facebook', username: 'harbour_fb', isActive: true }] });
  }) as typeof fetch });
  const found = await inventory.discover(request);
  assert.equal(found.state, 'available'); assert.deepEqual(found.profiles.map(p => p.id), [id(1), id(2)]);
  assert.equal(found.profiles[0]!.selectable, false); assert.equal(found.profiles[1]!.selectable, true);
  assert.equal(found.accounts[0]!.supported, true); assert.equal(found.accounts[1]!.supported, false);
  assert.doesNotMatch(JSON.stringify(found), /SECRET|RESERVED LEGACY|BOUND OTHER|UNCLAIMED/);
  assert.equal(paths.length, 2);
});

test('multiple exact brand matches remain explicit choices and no account IDs are exposed until a profile is registered', async () => {
  let calls = 0;
  const inventory = createSocialProviderInventory({ apiKey: 'inert', fetch: (async () => { calls++; return json({ profiles: [
    { id: id(1), name: 'Harbour one', externalId: BRAND }, { id: id(2), name: 'Harbour two', externalId: BRAND },
  ] }); }) as typeof fetch });
  const found = await inventory.discover({ ...request, registeredProfileId: null, registeredBrandFor: async () => null });
  assert.equal(found.profiles.length, 2); assert.ok(found.profiles.every(p => p.selectable)); assert.deepEqual(found.accounts, []); assert.equal(calls, 1);
});

test('wrong-profile account, missing bound profile and fetch failure are unknown/unavailable, never empty connected claims', async () => {
  const inventory = createSocialProviderInventory({ apiKey: 'inert', fetch: (async (url) => String(url).includes('/profiles')
    ? json({ profiles: [{ id: id(1), name: 'Harbour' }] }) : json({ accounts: [{ id: id(11), profileId: id(99), platform: 'linkedin', isActive: true }] })) as typeof fetch });
  assert.equal((await inventory.discover(request)).state, 'unavailable');
  const missing = createSocialProviderInventory({ apiKey: 'inert', fetch: (async () => json({ profiles: [] })) as typeof fetch });
  assert.equal((await missing.discover(request)).state, 'unavailable');
  const failed = createSocialProviderInventory({ apiKey: 'inert', fetch: (async () => { throw new Error('private provider body/token'); }) as typeof fetch });
  const result = await failed.discover(request); assert.equal(result.state, 'unavailable'); assert.doesNotMatch(JSON.stringify(result), /private provider|token/);
});

test('unconfigured key makes no request and non-JSON/over-limit inventory cannot create selectable profiles', async () => {
  let calls = 0;
  const off = createSocialProviderInventory({ apiKey: null, fetch: (async () => { calls++; throw new Error('must stay inert'); }) as typeof fetch });
  assert.equal((await off.discover(request)).state, 'unconfigured'); assert.equal(calls, 0);
  const html = createSocialProviderInventory({ apiKey: 'inert', fetch: (async () => new Response('<html>wrong route</html>', { headers: { 'content-type': 'text/html' } })) as typeof fetch });
  assert.equal((await html.discover(request)).state, 'unavailable');
  const over = createSocialProviderInventory({ apiKey: 'inert', fetch: (async () => json({ profiles: [{ id: id(1), name: 'Harbour', externalId: BRAND, isOverLimit: true }] })) as typeof fetch });
  const found = await over.discover({ ...request, registeredProfileId: null }); assert.equal(found.profiles[0]!.selectable, false); assert.match(found.profiles[0]!.hold!, /allowance/);
});
