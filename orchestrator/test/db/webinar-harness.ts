/**
 * Shared fixtures for native-webinar proofs on a disposable PostgreSQL.
 *
 * Everything here is synthetic: two seeded brands, a recording fake of the
 * Cloudflare Stream API at the HTTP boundary, and a recording fake mailer. The
 * HTTP harness mounts the real portal and attendee routers (the same handlers
 * the server composes) behind a preview-only sign-in switch. It is never
 * imported by application code.
 */
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import pg from 'pg';
import { assertDisposableTestDatabase } from './database-helper.js';
import { CrmCommandService, createPgCrmTransactionRunner } from '../../src/crm-pg/index.js';
import type { PortalSessionIdentity } from '../../src/portal/auth-service.js';
import { PROPERTY_PREDATOR_GROWTH_PROFILE, RELAUNCH72_PRODUCT_PROFILE, type PortalProductProfile } from '../../src/portal/product-profile.js';
import { appShell } from '../../src/portal/ui.js';
import { handleWebinars } from '../../src/portal/webinar-router.js';
import type { PlatformCapability } from '../../src/platform/capabilities.js';
import { loadWebinarConfig, type WebinarConfig } from '../../src/webinars/config.js';
import { handleStreamWebhook, STREAM_WEBHOOK_ROUTE } from '../../src/webinars/http.js';
import type { WebinarMailer } from '../../src/webinars/messages.js';
import { handleWebinarPublic } from '../../src/webinars/public-router.js';
import { PgWebinarService } from '../../src/webinars/service.js';
import { CloudflareStreamClient } from '../../src/webinars/stream.js';
import { WebinarWorker } from '../../src/webinars/worker.js';
import { StudioRelay, type StudioProbe } from '../../src/webinars/studio.js';

export const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export async function loginRole(admin: pg.Pool, role: 'r72_content_command' | 'r72_crm_command' | 'r72_identity_command'): Promise<pg.Pool> {
  assertDisposableTestDatabase(process.env.TEST_DATABASE_URL ?? '');
  const password = randomUUID() + randomUUID();
  const statement = await admin.query<{ sql: string }>("SELECT format('ALTER ROLE %I PASSWORD %L', $1::text, $2::text) AS sql", [role, password]);
  await admin.query(statement.rows[0]!.sql);
  const url = new URL(process.env.TEST_DATABASE_URL!);
  url.username = role;
  url.password = password;
  return new pg.Pool({ connectionString: url.toString(), max: 6, application_name: 'relaunch72-disposable-webinars' });
}

export interface SeededBrand {
  readonly ws: string;
  readonly owner: PortalSessionIdentity;
  readonly viewer: PortalSessionIdentity;
}

export async function seedBrand(admin: pg.Pool, label: string, accent = '#0b7a75'): Promise<SeededBrand> {
  const org = randomUUID(), owner = randomUUID(), viewer = randomUUID(), ws = randomUUID();
  const ownerToken = randomUUID() + randomUUID(), viewerToken = randomUUID() + randomUUID();
  await admin.query("INSERT INTO app.organizations(id,name,slug,kind) VALUES($1,$2,$3,'direct_customer')", [org, `${label} org`, `wb-${org}`]);
  await admin.query("INSERT INTO app.users(id,email,status) VALUES($1,$2,'active'),($3,$4,'active')", [owner, `owner-${owner}@example.test`, viewer, `viewer-${viewer}@example.test`]);
  await admin.query("INSERT INTO app.organization_memberships(organization_id,user_id,role,status) VALUES($1,$2,'owner','active')", [org, owner]);
  await admin.query("INSERT INTO app.workspaces(id,organization_id,name,slug,timezone) VALUES($1,$2,$3,$4,'Europe/London')", [ws, org, label, `wb-${ws.slice(0, 12)}`]);
  await admin.query("INSERT INTO app.organization_branding(organization_id,product_name,accent_color,support_email) VALUES($1,$2,$3,$4)", [org, `${label} Brand`, accent, `hello@${label.toLowerCase().replace(/[^a-z0-9]/g, '')}.example.test`]);
  await admin.query(`INSERT INTO app.workspace_memberships(workspace_id,organization_id,user_id,role,status,source_organization_id)
    VALUES($1,$2,$3,'owner','active',$2),($1,$2,$4,'viewer','active',NULL)`, [ws, org, owner, viewer]);
  for (const [user, token] of [[owner, ownerToken], [viewer, viewerToken]] as const) {
    await admin.query("INSERT INTO app.user_sessions(token_hash,csrf_secret_hash,user_id,selected_workspace_id,expires_at) VALUES($1,$2,$3,$4,now()+interval '12 hours')",
      [Buffer.from(sha(token), 'hex'), Buffer.from(sha(`csrf${token}`), 'hex'), user, ws]);
  }
  const pipeline = randomUUID();
  await admin.query("INSERT INTO app.pipelines(id,workspace_id,name,slug,status,is_default) VALUES($1,$2,'Enquiries','enquiries','active',true)", [pipeline, ws]);
  await admin.query("INSERT INTO app.pipeline_stages(workspace_id,pipeline_id,name,slug,position,stage_type) VALUES($1,$2,'New','new',1,'open')", [ws, pipeline]);
  return {
    ws,
    owner: { sessionToken: ownerToken, userId: owner, workspaceId: ws, userEmail: `owner-${owner}@example.test` },
    viewer: { sessionToken: viewerToken, userId: viewer, workspaceId: ws, userEmail: `viewer-${viewer}@example.test` },
  };
}

export interface FakeCloudflare {
  fetch: typeof fetch;
  readonly calls: { method: string; path: string; body: unknown }[];
  createFails: 'none' | 'timeout';
  /** RTMPS base returned for new live inputs (the studio test points it at a local receiver). */
  ingestUrl: string;
  videos: Map<string, Record<string, unknown>>;
  liveInputs: Map<string, Record<string, unknown>>;
}

/** A recording stand-in for the Cloudflare Stream REST API (shapes per the cloudflare SDK typings). */
export function fakeCloudflare(): FakeCloudflare {
  const state: FakeCloudflare = { calls: [], createFails: 'none', ingestUrl: 'rtmps://live.cloudflare.com:443/live/', videos: new Map(), liveInputs: new Map(), fetch: undefined as unknown as typeof fetch };
  const ok = (result: unknown, init: ResponseInit = {}) => new Response(JSON.stringify({ success: true, result }), { status: 200, ...init });
  state.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
    const path = url.pathname.replace(/^\/client\/v4\/accounts\/[0-9a-f]{32}\/stream/, '');
    state.calls.push({ method, path: path + url.search, body });
    if (method === 'POST' && path === '/live_inputs') {
      if (state.createFails === 'timeout') {
        // Cloudflare created the input, but the answer never arrived.
        const uid = randomUUID().replace(/-/g, '');
        state.liveInputs.set(uid, { uid, meta: body.meta, status: null });
        throw new Error('timeout');
      }
      const uid = randomUUID().replace(/-/g, '');
      const li = { uid, meta: body.meta, status: null, rtmps: { url: state.ingestUrl, streamKey: `key-${uid}` }, srt: { url: 'srt://live.cloudflare.com:778', streamId: uid, passphrase: 'pp' } };
      state.liveInputs.set(uid, li);
      return ok(li);
    }
    if (method === 'GET' && path === '/live_inputs') return ok([...state.liveInputs.values()]);
    const li = /^\/live_inputs\/([0-9a-f]{32})$/.exec(path);
    if (method === 'GET' && li) return state.liveInputs.has(li[1]!) ? ok(state.liveInputs.get(li[1]!)) : new Response('{}', { status: 404 });
    const recordings = /^\/live_inputs\/([0-9a-f]{32})\/videos$/.exec(path);
    if (method === 'GET' && recordings) return ok([...state.videos.values()].filter(v => v.liveInput === recordings[1]));
    if (method === 'POST' && path === '' && url.searchParams.get('direct_user') === 'true') {
      const uid = randomUUID().replace(/-/g, '');
      state.videos.set(uid, { uid, readyToStream: false, status: { state: 'pendingupload' }, duration: -1 });
      return new Response(null, { status: 201, headers: { location: `https://upload.cloudflarestream.com/tus/${uid}?tusv2=true`, 'stream-media-id': uid } });
    }
    const vid = /^\/([0-9a-f]{32})$/.exec(path);
    if (vid && method === 'GET') return state.videos.has(vid[1]!) ? ok(state.videos.get(vid[1]!)) : new Response(JSON.stringify({ success: false }), { status: 404 });
    if (vid && method === 'POST') return ok({ uid: vid[1] });
    return new Response(JSON.stringify({ success: false, errors: [{ message: `unexpected ${method} ${path}` }] }), { status: 400 });
  }) as typeof fetch;
  return state;
}

export interface SentMail { readonly to: string; readonly subject: string; readonly from: string; readonly text: string }

export function recordingMailer(): WebinarMailer & { readonly sent: SentMail[] } {
  const sent: SentMail[] = [];
  return {
    sent,
    send: async (sender, to, message) => {
      sent.push({ to, subject: message.subject, from: sender.from, text: message.text });
      return { outcome: 'sent', messageId: randomUUID() };
    },
  };
}

export const WEBHOOK_SECRET = 'synthetic-webhook-secret';

export function syntheticConfig(alphaWs: string, bravoWs: string | null, publicOrigin: string, extra: Record<string, string> = {}): WebinarConfig {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const senders = [{ workspaceId: alphaWs, from: 'Alpha Brand <events@alpha.example.test>', tokenEnv: 'ALPHA_POSTMARK_TOKEN' }];
  if (bravoWs) senders.push({ workspaceId: bravoWs, from: 'Bravo Brand <events@bravo.example.test>', tokenEnv: 'BRAVO_POSTMARK_TOKEN' });
  return loadWebinarConfig({
    CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), CLOUDFLARE_STREAM_API_TOKEN: 'synthetic-api-token', CLOUDFLARE_STREAM_CUSTOMER_CODE: 'synthetic01',
    CLOUDFLARE_STREAM_SIGNING_KEY_ID: 'kid-synthetic', CLOUDFLARE_STREAM_SIGNING_JWK: Buffer.from(JSON.stringify(privateKey.export({ format: 'jwk' }))).toString('base64'),
    CLOUDFLARE_STREAM_WEBHOOK_SECRET: WEBHOOK_SECRET, WEBINAR_ACCESS_SECRET: 's'.repeat(40),
    WEBINAR_EMAIL_MODE: 'test', WEBINAR_EMAIL_TEST_RECIPIENTS: 'allowed@example.test',
    WEBINAR_EMAIL_SENDERS: JSON.stringify(senders),
    ALPHA_POSTMARK_TOKEN: 'synthetic-postmark-alpha', BRAVO_POSTMARK_TOKEN: 'synthetic-postmark-bravo', WEBINAR_PUBLIC_ORIGIN: publicOrigin,
    ...extra,
  });
}

export interface HarnessUser {
  readonly identity: PortalSessionIdentity;
  readonly profile: PortalProductProfile;
}

export interface WebinarHttpHarness {
  readonly origin: string;
  readonly service: PgWebinarService;
  readonly worker: WebinarWorker;
  readonly cf: FakeCloudflare;
  readonly mailer: ReturnType<typeof recordingMailer>;
  readonly sessionSecret: string;
  close(): Promise<void>;
}

/**
 * Starts the real webinar routers on 127.0.0.1. `GET /preview/sign-in?as=<name>`
 * sets a preview cookie selecting one of `users` (a stand-in for the portal login,
 * which this harness does not mount). Unknown or absent cookie = signed out.
 */
export async function startWebinarHttpHarness(input: {
  readonly contentPool: pg.Pool;
  readonly crmPool: pg.Pool;
  readonly users: Readonly<Record<string, HarnessUser>>;
  readonly configFor: (origin: string) => WebinarConfig;
  readonly now?: () => number;
  readonly port?: number;
  /** Enables the browser studio relay with this ffmpeg; live inputs then ingest at studioIngestUrl (local RTMP allowed). */
  readonly studio?: { readonly ffmpegPath: string; readonly ingestUrl: string };
}): Promise<WebinarHttpHarness> {
  const cf = fakeCloudflare();
  let studio: StudioRelay | undefined;
  let studioProbe: StudioProbe | null = null;
  if (input.studio) {
    cf.ingestUrl = input.studio.ingestUrl;
    studio = new StudioRelay({ ffmpegPath: input.studio.ffmpegPath, maxSessions: 2, maxMinutes: 30, allowLocalIngest: true }, { log: () => undefined });
    studioProbe = await studio.probe();
  }
  const mailer = recordingMailer();
  const sessionSecret = 'preview-session-secret-'.padEnd(48, 'x');
  let service!: PgWebinarService;
  let worker!: WebinarWorker;
  const server: Server = createServer((req, res) => { void route(req, res); });
  server.on('upgrade', (req, socket, head) => { if (!studio?.handleUpgrade(req, socket, head)) socket.destroy(); });
  await new Promise<void>((resolve) => server.listen(input.port ?? 0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const config = input.configFor(origin);
  const stream = config.stream ? new CloudflareStreamClient(config.stream, cf.fetch) : null;
  service = new PgWebinarService({ pool: input.contentPool, config, stream, now: input.now,
    crm: { commands: new CrmCommandService({ transactionRunner: createPgCrmTransactionRunner(input.crmPool) }), pool: input.crmPool } });
  worker = new WebinarWorker({ pool: input.contentPool, config, stream, mailer, now: input.now });

  function userFor(req: IncomingMessage): HarnessUser | null {
    const m = /(?:^|;\s*)preview_as=([a-z0-9-]+)/.exec(String(req.headers.cookie ?? ''));
    return m ? input.users[m[1]!] ?? null : null;
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', origin);
    try {
      if (url.pathname === '/preview/sign-in') {
        const who = url.searchParams.get('as') ?? '';
        res.writeHead(303, { location: url.searchParams.get('next') ?? '/portal/webinars',
          'set-cookie': input.users[who] ? `preview_as=${who}; Path=/; HttpOnly; SameSite=Lax` : 'preview_as=; Path=/; Max-Age=0' });
        res.end();
        return;
      }
      if (url.pathname === '/portal/login') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<!doctype html><title>Sign in</title><p>Preview harness: use /preview/sign-in?as=…</p>');
        return;
      }
      if (url.pathname === STREAM_WEBHOOK_ROUTE) { await handleStreamWebhook(req, res, service); return; }
      if (url.pathname.startsWith('/w/')) {
        if (await handleWebinarPublic(req, res, url, { service, secureCookies: false })) return;
      }
      const user = userFor(req);
      if (url.pathname.startsWith('/portal/webinars')) {
        const shell = (title: string, workspaceName: string, body: string, csrfToken: string): string => appShell({
          title: `${user?.profile.productName ?? 'Relaunch72'} ${title} — ${workspaceName}`,
          tenantName: workspaceName, active: 'webinars', productProfile: user?.profile, body, csrfToken,
          capabilities: new Set<PlatformCapability>(['workspace.overview.read', 'crm.contacts.read', 'crm.pipeline.read', 'crm.tasks.read', 'webinars.manage']),
          billingAvailable: false, crmAvailable: true, mode: 'crm',
        });
        if (await handleWebinars(req, res, url, {
          service, setup: { database: true, databaseDetail: '', config, crmAvailable: true, studio: studioProbe }, studio,
          identity: user?.identity ?? null, authenticated: user !== null, requestId: randomUUID(), sessionSecret, shell,
        })) return;
      }
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    } catch (error) {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(error instanceof Error ? error.message : 'error');
    }
  }

  return {
    origin, service, worker, cf, mailer, sessionSecret,
    close: () => new Promise<void>((resolve) => { studio?.stopAll(); server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

export const PROFILES = { relaunch72: RELAUNCH72_PRODUCT_PROFILE, propertyPredator: PROPERTY_PREDATOR_GROWTH_PROFILE } as const;
