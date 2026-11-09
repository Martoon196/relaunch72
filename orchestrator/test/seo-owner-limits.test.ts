import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { unlimited, monthlyCeiling, enforceManagedLimits, limitFromForm, COMPATIBLE_UNLIMITED } from '../src/seo-blog/limits.js';
import { DEFAULT_BRAND_SETTINGS, SeoBlogError } from '../src/seo-blog/types.js';
import { handleSeoBlog } from '../src/portal/seo-blog-router.js';
import { portalCsrfToken } from '../src/portal/session.js';
import type { PortalSeoBlogService } from '../src/portal/seo-blog-service.js';
import type { PortalSessionIdentity } from '../src/portal/auth-service.js';
import { harness, OWNER, STRANGER } from './seo-blog-fixtures.js';
import { CreativeGeneration } from '../src/creative-studio/generation-service.js';
import type { GenerationState } from '../src/creative-studio/generation-store.js';
import { fixtureBrand } from './rl72-method-fixtures.js';

const caps = { modelTokens: 100, searchCalls: 10, images: 3, studioImages: 2, configuredBy: OWNER.userId, configuredAt: '2026-11-09T00:00:00Z' };
test('managed limits permit lower workloads, reject escalation/forgery and distinguish Unlimited from zero', () => {
  const before = { ...DEFAULT_BRAND_SETTINGS, operatorLimits: caps, budgets: { modelTokensPerMonth: 100, searchCallsPerMonth: 10, imagesPerMonth: 3 } };
  enforceManagedLimits(before, { ...before, budgets: { ...before.budgets, imagesPerMonth: 1 } });
  assert.throws(() => enforceManagedLimits(before, { ...before, budgets: { ...before.budgets, imagesPerMonth: 4 } }), /exceeds your account/);
  assert.throws(() => enforceManagedLimits(before, { ...before, operatorLimits: undefined }), /Only the founder/);
  assert.throws(() => enforceManagedLimits(before, { ...before, operatorLimits: { ...caps, images: null } }), /Only the founder/);
  const own = { ...before, operatorLimits: { ...caps, images: null }, budgets: { ...before.budgets, imagesPerMonth: COMPATIBLE_UNLIMITED } };
  assert.equal(unlimited(own, 'images'), true); assert.equal(monthlyCeiling(own, 'images'), Infinity);
  assert.equal(unlimited(DEFAULT_BRAND_SETTINGS, 'images'), false); assert.equal(monthlyCeiling(DEFAULT_BRAND_SETTINGS, 'images'), 0);
  assert.equal(limitFromForm(new URLSearchParams({ imagesUnlimited: '1', images: '0' }), 'images'), null);
  assert.throws(() => limitFromForm(new URLSearchParams({ images: '-1' }), 'images'));
});

test('Unlimited images remove monthly preflight gates, retaining opt-in/provider gates and finite-user denials', () => {
  const f = fixtureBrand('home');
  const generation = new CreativeGeneration({ providerConfigured: true, store: {} as never, brands: {} as never, policy: async () => { throw Error('No call'); } });
  const state = { usage: { brandImagesThisMonth: 9, brandUnresolvedEarlier: 2, studioImagesCounted: 9, studioUnresolved: 2 } } as GenerationState;
  const brand = { ...f.brand, settings: { ...f.brand.settings, operatorLimits: { ...caps, images: null, studioImages: null },
    budgets: { ...f.brand.settings.budgets, imagesPerMonth: 0 }, studioImages: { enabled: true, perMonth: 0, authorizedBy: OWNER.userId, authorizedAt: caps.configuredAt } } };
  const policy = { version: 1, sha256: 'a'.repeat(64), enabled: true, model: 'gpt-image-2' as const, quality: 'medium' as const, maxConcurrency: 1, monthlyMicrousd: 0, monthlyUnlimited: true, perAttemptMicrousd: 250000, admissionEpoch: 0 };
  const brief = { title: 'House', text: 'A quiet red-brick house in daylight', size: '1024x1024' as const, references: [], useVisualGuidance: false };
  const estimate = generation.estimate(brand, state, policy, brief);
  assert.deepEqual(estimate.blockers, []); assert.equal(estimate.brandAllowance.unlimited, true);
  assert.equal(estimate.studioAllowance.unresolved, 2); assert.equal(estimate.studioAllowance.counted, 9);
  const finite = { ...brand, settings: { ...brand.settings, operatorLimits: caps, budgets: { ...brand.settings.budgets, imagesPerMonth: 3 }, studioImages: { ...brand.settings.studioImages, perMonth: 2 } } };
  assert.equal(generation.estimate(finite, state, policy, brief).blockers.length, 2);
  assert.match(generation.estimate({ ...brand, settings: { ...brand.settings, studioImages: { ...brand.settings.studioImages, enabled: false } } }, state, policy, brief).blockers.join(), /switched off/);
});

const SECRET = 's'.repeat(48), PATH = '/portal/seo-blog/limits';
const identity = (userId: string): PortalSessionIdentity => ({ userId, sessionToken: `token-${userId}`, workspaceId: '33333333-3333-4333-8333-333333333333', userEmail: 'owner@example.test' });
async function request(service: PortalSeoBlogService, who: PortalSessionIdentity | null, method: string, form?: Record<string, string>, origin = 'https://portal.example') {
  const body = new URLSearchParams(form).toString(), req = new PassThrough() as unknown as IncomingMessage & PassThrough;
  Object.assign(req, { method, url: PATH, headers: { host: 'portal.example', ...(form ? { origin, 'content-type': 'application/x-www-form-urlencoded' } : {}) } }); req.end(body);
  let status = 0, text = '', headers: Record<string, string> = {};
  const res = { writeHead(s: number, h: Record<string, string>) { status = s; headers = h; return res; }, end(v?: string) { text += v ?? ''; } } as unknown as ServerResponse;
  await handleSeoBlog(req, res, new URL(PATH, 'https://portal.example'), { service, identity: who, requestId: randomUUID(), sessionSecret: SECRET, vaultReady: true });
  return { status, text, headers };
}
test('founder limits routes protect read/write, CSRF, foreign users, stale versions, and make no provider/publishing call', async () => {
  const h = harness(), target = randomUUID(), saves: unknown[] = [], policies: unknown[] = [];
  let reads = 0;
  const service: PortalSeoBlogService = { generation: 'live', research: 'live', social: 'unavailable', engineFor: () => h.engine, socialCallback: async () => null,
    limitsFor: who => ({ allowed: async () => who.userId === OWNER.userId,
      list: async () => { reads++; return { brands: [{ id: target, name: 'Client <script>', owner: 'client@example.test', rowVersion: 7, managed: true, limits: { modelTokens: 100, searchCalls: 10, images: null, studioImages: null }, usage: { modelTokens: 12, searchCalls: 1, images: 2, studioImages: 2 } }], policy: { version: 1, enabled: false, maxConcurrency: 1, monthlyMicrousd: 0 } }; },
      save: async (id, version, limits) => { if (version !== 7) throw new SeoBlogError(409, 'Stale limits'); saves.push({ id, limits }); },
      policy: async (version, input) => { policies.push({ version, input }); } }) };
  const owner = identity(OWNER.userId), csrf = portalCsrfToken(SECRET, owner.sessionToken);
  assert.equal((await request(service, null, 'GET')).status, 303);
  assert.equal((await request(service, identity(STRANGER.userId), 'GET')).status, 403); assert.equal(reads, 0);
  const page = await request(service, owner, 'GET'); assert.equal(page.status, 200); assert.match(page.text, /Usage &amp; limits|Usage & limits/);
  assert.match(page.text, /Client &lt;script&gt;/); assert.match(page.text, /Unlimited/); assert.doesNotMatch(page.text, /9007199254740991/);
  const form = { _csrf: csrf, target, rowVersion: '7', modelTokens: '100', searchCalls: '10', images: '0', studioImages: '0', imagesUnlimited: '1', studioImagesUnlimited: '1' };
  assert.equal((await request(service, owner, 'POST', { ...form, _csrf: 'bad' })).status, 403);
  assert.equal((await request(service, owner, 'POST', form, 'https://evil.example')).status, 403);
  assert.equal((await request(service, identity(STRANGER.userId), 'POST', { ...form, _csrf: portalCsrfToken(SECRET, identity(STRANGER.userId).sessionToken) })).status, 403);
  assert.equal(saves.length, 0);
  assert.equal((await request(service, owner, 'POST', { ...form, rowVersion: '6' })).status, 409);
  assert.equal((await request(service, owner, 'POST', { ...form, modelTokens: '-1' })).status, 400);
  assert.equal((await request(service, owner, 'POST', form)).status, 303);
  assert.deepEqual(saves, [{ id: target, limits: { modelTokens: 100, searchCalls: 10, images: null, studioImages: null } }]);
  assert.equal((await request(service, owner, 'POST', { _csrf: csrf, action: 'policy', version: '1', enabled: '1', monthlyUnlimited: '1', concurrency: '1' })).status, 303);
  assert.deepEqual(policies, [{ version: 1, input: { enabled: true, concurrency: 1, monthlyMicrousd: null } }]);
  assert.equal(h.llm.calls.length, 0); assert.equal(h.site.posts, 0);
});
