import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { composePropertyPredatorZernioAccountWebhook } from '../src/integrations/zernio-account-webhook/router.js';
import type { SeoBlogZernioWebhookBrands } from '../src/portal/seo-blog-social-pg.js';
import type { PortalZernioSocialConnectionService } from '../src/portal/zernio-social-connection-service.js';

const PP_WORKSPACE = '11111111-1111-4111-8111-111111111111';
const PP_CONNECTION = '22222222-2222-4222-8222-222222222222';
const BRAND_WORKSPACE = '44444444-4444-4444-8444-444444444444';
const BRAND_CONNECTION = '55555555-5555-4555-8555-555555555555';
const SECRET = `whsec_${'b'.repeat(64)}`;
const env = { PROPERTY_PREDATOR_PILOT_WORKSPACE_ID: PP_WORKSPACE, ZERNIO_WEBHOOK_SECRET: SECRET, ZERNIO_WEBHOOK_CREDENTIAL_VERSION: 'version-1' };

function fixture() {
  const recorded: { by: 'pp' | 'brand'; workspaceId: string; connectionId: string; profileSha: string }[] = [];
  const resolved: string[] = [];
  const pp = {
    providerConnectionId: PP_CONNECTION, providerProfileId: 'pp_profile', providerProfileIds: ['pp_profile'],
    async recordWebhook(input: { workspaceId: string; connectionId: string; providerProfileIdSha256: string }) { recorded.push({ by: 'pp', workspaceId: input.workspaceId, connectionId: input.connectionId, profileSha: input.providerProfileIdSha256 }); return { ok: true, disposition: 'recorded', providerEffects: 'none' }; },
  } as unknown as PortalZernioSocialConnectionService;
  const brands: SeoBlogZernioWebhookBrands = {
    async resolve(profileId) { resolved.push(profileId); return profileId === 'brand_profile' ? { workspaceId: BRAND_WORKSPACE, connectionId: BRAND_CONNECTION, providerProfileId: profileId } : null; },
    async record(input, binding) { recorded.push({ by: 'brand', workspaceId: input.workspaceId, connectionId: input.connectionId, profileSha: input.providerProfileIdSha256 }); assert.equal(binding.workspaceId, BRAND_WORKSPACE); return { ok: true, disposition: 'recorded', providerEffects: 'none' }; },
  };
  return { mount: composePropertyPredatorZernioAccountWebhook(env, pp, brands), legacy: composePropertyPredatorZernioAccountWebhook(env, pp), recorded, resolved };
}

async function post(mount: ReturnType<typeof composePropertyPredatorZernioAccountWebhook>, profileId: string, eventId = '33333333-3333-4333-8333-333333333333', secret = SECRET) {
  const body = Buffer.from(JSON.stringify({ id: eventId, event: 'account.connected', timestamp: '2026-11-01T10:00:00.000Z', account: { accountId: 'a'.repeat(24), profileId, platform: 'linkedin', username: 'brand' } }));
  const req = Object.assign(new EventEmitter(), { method: 'POST', headers: { 'content-type': 'application/json', 'x-zernio-signature': createHmac('sha256', secret).update(body).digest('hex'), 'x-zernio-event-id': eventId, 'content-length': String(body.length) }, resume() {} });
  setImmediate(() => { req.emit('data', body); req.emit('end'); });
  const res = { code: 0, body: '', writeHead(code: number) { this.code = code; return this; }, end(value = '') { this.body = value; } };
  await mount.handle!(req as never, res as never);
  return res;
}

test('PP profile events keep the exact PP path; brand profile events verify against that brand\'s own credential', async () => {
  const f = fixture();
  assert.equal(f.mount.ready, true);
  const pp = await post(f.mount, 'pp_profile');
  assert.equal(pp.code, 200);
  const brand = await post(f.mount, 'brand_profile');
  assert.equal(brand.code, 200);
  assert.deepEqual(f.recorded.map(r => [r.by, r.workspaceId, r.connectionId]), [['pp', PP_WORKSPACE, PP_CONNECTION], ['brand', BRAND_WORKSPACE, BRAND_CONNECTION]]);
  assert.deepEqual(f.resolved, ['brand_profile'], 'PP profiles are never looked up in the brand registry');
});

test('unregistered profiles, bad signatures and PP-reserved profiles never reach a brand receipt', async () => {
  const f = fixture();
  assert.equal((await post(f.mount, 'unknown_profile')).code, 401);
  assert.equal((await post(f.mount, 'brand_profile', '33333333-3333-4333-8333-333333333333', `whsec_${'c'.repeat(64)}`)).code, 401);
  assert.equal(f.recorded.length, 0);
  // Without the brand seam (the live PP composition today) behaviour is byte-for-byte the old one.
  assert.equal((await post(f.legacy, 'brand_profile')).code, 401);
  assert.equal((await post(f.legacy, 'pp_profile')).code, 200);
});
