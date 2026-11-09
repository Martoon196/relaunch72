/**
 * Manual end-to-end visual proof for typed-brief generation (not part of `npm test`). Runs the production portal
 * composition (createPortalSeoBlogService + handleSeoBlog) and the production worker composition
 * (createWorkerSeoBlogEngine) against an explicit DISPOSABLE PostgreSQL database, driving the real forms in Chromium.
 *
 * The provider is NOT called: only for this process, global fetch answers https://api.openai.com/v1/images/* with a
 * synthetic gradient JPEG and synthetic token usage. Every screenshot is captioned "SYNTHETIC PROVIDER RESPONSE".
 *
 *   RL72_METHODS_PG_TEST_URL=postgresql://…/relaunch72_test RELAUNCH72_DATABASE_INTEGRATION=explicit-disposable-run \
 *     node --import tsx test/manual-creative-generation-pg-demo.ts <out-dir>
 */
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { chromium } from 'playwright-core';
import { handleSeoBlog } from '../src/portal/seo-blog-router.js';
import { ENQUIRY_ROUTE, handleEnquiryPublic } from '../src/creative-studio/enquiry-capture.js';
import { createPortalSeoBlogService, createWorkerSeoBlogEngine } from '../src/portal/seo-blog-service.js';
import { PgSeoBlogMediaStore } from '../src/seo-blog/media-store.js';
import { PgSeoBlogStore } from '../src/seo-blog/pg-store.js';
import { findCreativeChromium } from '../src/creative-studio/renderer.js';
import { fixtureBrand } from './rl72-method-fixtures.js';
import { syntheticLandscapeJpeg, syntheticLogoPng } from './creative-studio-fixtures.js';

const raw = process.env.RL72_METHODS_PG_TEST_URL;
if (!raw || process.env.RELAUNCH72_DATABASE_INTEGRATION !== 'explicit-disposable-run') throw new Error('Explicit disposable database only.');
const target = new URL(raw); if (!['localhost', '127.0.0.1'].includes(target.hostname) || target.pathname !== '/relaunch72_test') throw new Error('Refusing a non-disposable target.');
const out = path.resolve(process.argv[2] ?? 'creative-generation-demo'); mkdirSync(out, { recursive: true });
const executable = findCreativeChromium(); if (!executable) throw new Error('Chromium not found');

// ---- synthetic provider (this process only) ----
const providerCalls: { url: string; size: string | null }[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (!url.startsWith('https://api.openai.com/v1/images/')) return realFetch(input, init);
  const body = init?.body; const size = typeof body === 'string' ? JSON.parse(body).size : body instanceof FormData ? String(body.get('size')) : null;
  providerCalls.push({ url, size });
  const [w, h] = String(size ?? '1536x1024').split('x').map(Number);
  return new Response(JSON.stringify({ data: [{ b64_json: syntheticLandscapeJpeg(w, h).toString('base64') }],
    usage: { input_tokens: 120, output_tokens: 1056, total_tokens: 1176, input_tokens_details: { text_tokens: 120, image_tokens: 0 }, output_tokens_details: { image_tokens: 1056 } } }),
  { status: 200, headers: { 'content-type': 'application/json', 'x-request-id': 'req_synthetic_' + randomUUID() } });
}) as typeof fetch;

const admin = new pg.Pool({ connectionString: raw, max: 2 });
const u = new URL(raw); u.username = 'r72_content_command'; u.password = 'local-methods-test-only';
const pool = new pg.Pool({ connectionString: u.toString(), max: 6 });
const env = { CREATIVE_STUDIO_ENABLED: 'true', SEO_BLOG_IMAGE_API_KEY: 'sk-synthetic-' + 'x'.repeat(40) } as NodeJS.ProcessEnv;

const f = fixtureBrand('home'), actor = f.profile.confirmedBy!, token = randomUUID() + randomUUID();
await admin.query("INSERT INTO app.organizations(id,name,slug,kind) VALUES($1,$2,$3,'direct_customer')", [f.brand.organizationId, f.brand.name, 'org-' + f.brand.organizationId]);
await admin.query("INSERT INTO app.users(id,email,status) VALUES($1,$2,'active')", [actor, actor + '@example.test']);
await admin.query("INSERT INTO app.organization_memberships(organization_id,user_id,role,status) VALUES($1,$2,'owner','active')", [f.brand.organizationId, actor]);
await admin.query('INSERT INTO app.workspaces(id,organization_id,name,slug) VALUES($1,$2,$3,$4)', [f.brand.id, f.brand.organizationId, f.brand.name, 'demo-' + f.brand.id]);
await admin.query("INSERT INTO app.workspace_memberships(workspace_id,organization_id,user_id,role,status,source_organization_id) VALUES($1,$2,$3,'owner','active',$2)", [f.brand.id, f.brand.organizationId, actor]);
await admin.query("INSERT INTO app.user_sessions(token_hash,csrf_secret_hash,user_id,selected_workspace_id,expires_at) VALUES($1,$2,$3,$4,now()+interval '1 hour')", [createHash('sha256').update(token).digest(), createHash('sha256').update('csrf' + token).digest(), actor, f.brand.id]);
await admin.query('INSERT INTO app.seo_blog_brands(workspace_id,organization_id,created_by_user_id,settings) VALUES($1,$2,$3,$4)', [f.brand.id, f.brand.organizationId, actor, JSON.stringify({ ...f.brand.settings, budgets: { ...f.brand.settings.budgets, imagesPerMonth: 5 } })]);
const principal = { kind: 'user' as const, userId: actor, requestId: 'demo', sessionToken: token, selectedWorkspaceId: f.brand.id };
await new PgSeoBlogStore(pool, principal, new PgSeoBlogMediaStore(pool, principal, { publicOrigin: 'https://app.relaunch72.com' })).saveProfile(f.profile);
// Operator step (r72_owner only in production): open the shared paid-image policy with artificial proof amounts.
await admin.query('UPDATE app_private.seo_image_operator_policy SET version=version+1,config=config||$1::jsonb', [JSON.stringify({ enabled: true, maxConcurrency: 2, monthlyMicrousd: 5_000_000, perAttemptMicrousd: 250_000 })]);

await admin.query("ALTER ROLE r72_crm_command PASSWORD 'local-crm-test-only'");
const c = new URL(raw); c.username = 'r72_crm_command'; c.password = 'local-crm-test-only';
const crmPool = new pg.Pool({ connectionString: c.toString(), max: 3 });
const service = createPortalSeoBlogService(pool, env, undefined, undefined, crmPool);
const worker = createWorkerSeoBlogEngine(pool, 'demo-worker', env);
const SECRET = 's'.repeat(48);
const identity = { sessionToken: token, userId: actor, workspaceId: f.brand.id, userEmail: 'owner@example.test' };
const server = createServer((req, res) => {
  if (req.url?.startsWith(ENQUIRY_ROUTE + '/')) { void handleEnquiryPublic(req, res, service.creativeEnquiries!, SECRET, 'demo-enquiry'); return; }
  void handleSeoBlog(req, res, new URL(req.url!, 'http://127.0.0.1'), { service, identity, requestId: 'demo-' + randomUUID(), sessionSecret: SECRET, vaultReady: true } as never); });
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const files = path.join(out, 'inputs'); mkdirSync(files, { recursive: true });
writeFileSync(path.join(files, 'logo.png'), syntheticLogoPng([255, 255, 255]));

const browser = await chromium.launch({ executablePath: executable });
const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 })).newPage();
const consoleErrors: string[] = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push(String(e)));
const label = () => page.evaluate(() => { const d = document.createElement('div'); d.textContent = 'PROOF RUN · SYNTHETIC PROVIDER RESPONSE · no paid request was made'; d.setAttribute('style', 'position:fixed;top:0;right:0;z-index:9999;background:#b91c1c;color:#fff;font:600 12px system-ui;padding:6px 10px'); document.body.appendChild(d); });
const shot = async (name: string) => { await label(); await page.screenshot({ path: path.join(out, `${name}.png`), fullPage: true }); };
const base = `${origin}/portal/seo-blog/b/${f.brand.id}/creative`;
const summary: Record<string, unknown> = {};
try {
  await page.goto(`${base}/generate`); await shot('01-generate-defaults-off');
  // Owner step: switch studio images on with a monthly allowance.
  await page.check('#generation-settings input[name=enabled]'); await page.fill('#gen-per-month', '3');
  await Promise.all([page.waitForLoadState('load'), page.click('#generation-settings button[type=submit]')]);
  await page.fill('#brief-title', 'Calm kitchen morning');
  await page.fill('#brief-text', 'A bright modern kitchen in soft morning light, a ceramic mug on a pale oak counter, plants by the window, calm empty space on the left.');
  await page.selectOption('#brief-size', '1536x1024');
  await Promise.all([page.waitForURL(/\/generate\/[0-9a-f-]{36}/u), page.click('form[action$="/generate/brief"] button[type=submit]')]);
  await shot('02-brief-cost-review');
  await page.check('input[name=confirm]');
  await Promise.all([page.waitForLoadState('load'), page.click('form[action$="/request"] button[type=submit]')]);
  await page.waitForSelector('[data-creative-job]');
  await shot('03-request-queued-polling');
  summary.callsBeforeWorker = providerCalls.length;
  // The background worker picks the durable job up (as the deployed worker loop would).
  summary.tick = await worker.tick('demo-worker');
  await page.waitForSelector('.gen-grid figure img', { timeout: 30_000 }); // the polling script reloads once the job finishes
  const src = await page.getAttribute('.gen-grid img', 'src');
  const preview = await page.request.get(origin + src!);
  summary.preview = { status: preview.status(), type: preview.headers()['content-type'], bytes: (await preview.body()).length };
  if (preview.status() !== 200) throw new Error('preview failed: ' + preview.status() + ' ' + (await preview.text()).slice(0, 300));
  await page.locator('.gen-grid img').first().scrollIntoViewIfNeeded();
  await page.waitForFunction(() => [...document.querySelectorAll<HTMLImageElement>('.gen-grid img')].every((i) => i.complete && i.naturalWidth > 0));
  await page.evaluate(() => window.scrollTo(0, 0));
  await shot('04-generated-image-private-candidate');
  // Brand kit, then artwork from the generated image.
  await page.goto(`${base}/kit`);
  for (const [k, v] of Object.entries({ primary: '#0f766e', accent: '#fbbf24', dark: '#0b2421', light: '#ffffff' })) await page.fill(`#kit-${k}`, v);
  await page.setInputFiles('#kit-logo', path.join(files, 'logo.png')); await page.fill('#kit-logo-label', 'Fixture logo (white)');
  await Promise.all([page.waitForURL(/\/creative\?/u), page.click('form.cs-form button[type=submit]')]);
  await page.goto(`${base}/generate`);
  await page.click('table a'); await page.click('a:text("Create artwork from this image")');
  await page.selectOption('#cs-dest', f.profile.conversionPages[0]!.url);
  summary.generatedBackgroundChecked = await page.isChecked('input[name=background][value=generated]').catch(() => null);
  await shot('05-artwork-form-with-generated-background');
  // Durable render: the request returns at once with a task page; the worker renders; the page opens the result.
  const t0 = Date.now();
  await Promise.all([page.waitForURL(/\/creative\/task\//u), page.click('form.cs-form button[type=submit]')]);
  summary.renderRequestMs = Date.now() - t0;
  await shot('05b-render-task-waiting');
  const settle = async () => { const r = await worker.tick('demo-worker'); await page.waitForURL(/\/creative\/s\//u, { timeout: 60_000 }); return r; };
  summary.renderTick = await settle();
  await page.waitForFunction(() => [...document.querySelectorAll<HTMLImageElement>('img')].every((i) => i.complete));
  await shot('06-artwork-variants-from-generated-image');
  // Storyboard and a recorded, playback-checked video, both as worker jobs.
  await Promise.all([page.waitForURL(/\/creative\/task\//u), page.locator('button:text("Draft a storyboard")').first().click()]);
  await settle();
  await Promise.all([page.waitForURL(/\/creative\/task\//u), page.locator('button:text("Render video")').first().click()]);
  await shot('07a-video-task-waiting');
  const v0 = Date.now(); summary.videoTick = await settle(); summary.videoWorkerMs = Date.now() - v0;
  const video = page.locator('video').first();
  await video.scrollIntoViewIfNeeded();
  summary.video = await video.evaluate(async (el: HTMLVideoElement) => {
    if (el.readyState < 1) await new Promise((r) => el.addEventListener('loadedmetadata', r, { once: true }));
    el.muted = true; await el.play().catch(() => undefined); await new Promise((r) => setTimeout(r, 1200));
    return { duration: el.duration, width: el.videoWidth, height: el.videoHeight, played: el.currentTime > 0, src: el.currentSrc.split('/').slice(-1)[0] };
  });
  summary.notice = await page.locator('[role=status], .notice, .flash').first().textContent().catch(() => null);
  await shot('07b-video-rendered-and-checked');
  // Enquiry form: owner switches it on; a visitor from a campaign link sends an enquiry into the CRM.
  await page.goto(`${base}/enquiries`); await shot('09a-enquiries-off');
  await page.fill('#enq-privacy', 'https://hearth.example/privacy'); await page.check('input[name=enabled]');
  await Promise.all([page.waitForLoadState('load'), page.click('form[action$="/enquiries"] button[type=submit]')]);
  await shot('09b-enquiries-on-with-embed');
  const hosted = await page.locator('a[href*="/enquire/"]').first().getAttribute('href');
  const visitor = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  await visitor.goto(hosted!.replace(/^https?:\/\/[^/]+/u, origin) + '?utm_source=instagram&utm_medium=social&utm_campaign=spring-plan-00000000&utm_content=concept-1-cs00000000');
  await visitor.fill('#q-name', 'Fictional Visitor'); await visitor.fill('#q-email', 'visitor@example.test'); await visitor.fill('#q-msg', 'Please call me about a boiler check.');
  await visitor.check('input[name=consent]'); await visitor.screenshot({ path: path.join(out, '09c-public-form-mobile.png'), fullPage: true });
  await Promise.all([visitor.waitForLoadState('load'), visitor.click('button[type=submit]')]);
  await visitor.screenshot({ path: path.join(out, '09d-public-form-sent.png'), fullPage: true });
  summary.enquiry = (await admin.query("SELECT (SELECT count(*)::int FROM app.contacts WHERE workspace_id=$1) contacts,(SELECT count(*)::int FROM app.opportunities WHERE workspace_id=$1) opportunities,(SELECT count(*)::int FROM app.creative_studio_lead_touches WHERE workspace_id=$1) touches", [f.brand.id])).rows[0];
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto(`${base}/generate`); await page.click('table a');
  for (const img of await page.locator('img').all()) await img.scrollIntoViewIfNeeded();
  await page.waitForFunction(() => [...document.images].every((i) => i.complete)); await page.evaluate(() => window.scrollTo(0, 0)); await shot('08-brief-mobile');
  summary.providerCalls = providerCalls; summary.consoleErrors = consoleErrors;
  summary.usage = (await admin.query("SELECT coalesce(sum(amount),0)::int n FROM app.seo_blog_usage WHERE workspace_id=$1 AND kind='images'", [f.brand.id])).rows[0].n;
  summary.generations = (await admin.query('SELECT width,height,candidate_sha256 FROM app.creative_studio_generations WHERE workspace_id=$1', [f.brand.id])).rows;
  summary.jobs = (await admin.query('SELECT state,data->>\'progress\' progress FROM app.seo_blog_jobs WHERE workspace_id=$1', [f.brand.id])).rows;
  writeFileSync(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
} finally { await browser.close(); server.close(); await pool.end(); await crmPool.end(); await admin.end(); }
