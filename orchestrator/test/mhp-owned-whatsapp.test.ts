import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createMhpMount } from '../src/mhp/mount.js';
import { portalCsrfToken } from '../src/portal/session.js';
import type { PostgresPortalDeps } from '../src/portal/router.js';
import { MARTIN_HOWARD_PROPERTY_PROFILE } from '../src/portal/product-profile.js';
import { requestDatabaseContext } from '../src/db/rls.js';
import { decryptMetaWhatsAppDispatchCredentials } from '../src/whatsapp-live/foundation.js';
import { MhpOwnedWhatsAppService, mhpOwnedWhatsAppConfig, parseMhpWhatsAppEnvelope, type MhpOwnedWhatsAppDependencies,
  type MhpOwnedWhatsAppDatabaseSnapshot } from '../src/mhp/owned-whatsapp-service.js';
import { MHP_WORKSPACE_ID, sealKeyFromEnvironment, sealMhpWhatsAppBinding } from '../src/ops/mhp-whatsapp-seal.js';
import { marketingWorkspacePage } from '../src/mhp/marketing-workspace-view.js';
import { ids, identity, review, token, now } from './helpers/mhp-owner-email-fixture.js';

const TOKEN = `EAA${'Z'.repeat(80)}`;
const KEY = randomBytes(32);
const ids3 = { appId: '1451249570430398', wabaId: '1874194210608511', phoneNumberId: '1412753418582729' };
const sealed = () => sealMhpWhatsAppBinding({ ...ids3, accessToken: TOKEN, encryptionKey: KEY, keyVersion: 'k1' });

test('the seal tool output carries no token and decrypts exactly as the worker would', () => {
  const envelope = sealed();
  assert.doesNotMatch(JSON.stringify(envelope), new RegExp(TOKEN, 'u'));
  assert.deepEqual(parseMhpWhatsAppEnvelope(JSON.stringify(envelope)), envelope);
  const credentials = decryptMetaWhatsAppDispatchCredentials({ binding: { workspaceId: MHP_WORKSPACE_ID, connectionId: envelope.connectionId, ...ids3, graphApiVersion: 'v24.0' },
    envelope: { algorithm: 'aes-256-gcm-v1', keyVersion: envelope.keyVersion, ivBase64: envelope.ivBase64, ciphertextBase64: envelope.ciphertextBase64,
      authTagBase64: envelope.authTagBase64, aadSha256: envelope.aadSha256, secretPayloadSha256: envelope.secretPayloadSha256 },
    encryptionKey: KEY, expectedKeyVersion: 'k1' });
  assert.equal(credentials.accessToken, TOKEN);
  assert.throws(() => sealMhpWhatsAppBinding({ ...ids3, appId: 'abc', accessToken: TOKEN, encryptionKey: KEY, keyVersion: 'k1' }));
  assert.throws(() => sealMhpWhatsAppBinding({ ...ids3, accessToken: 'short', encryptionKey: KEY, keyVersion: 'k1' }));
  assert.throws(() => parseMhpWhatsAppEnvelope(JSON.stringify({ ...envelope, accessToken: TOKEN })), { status: 400 });
  assert.throws(() => parseMhpWhatsAppEnvelope('not json'), { status: 400 });
});

test('the seal CLI reads the token from stdin, never echoes it, and refuses without the worker key', () => {
  const run = (env: NodeJS.ProcessEnv) => spawnSync(process.execPath, ['--import', 'tsx', 'src/ops/mhp-whatsapp-seal-cli.ts',
    '--app-id', ids3.appId, '--waba-id', ids3.wabaId, '--phone-number-id', ids3.phoneNumberId],
  { input: `${TOKEN}\n`, encoding: 'utf8', env: { PATH: process.env.PATH, ...env } });
  const ok = run({ PROPERTY_PREDATOR_WHATSAPP_CREDENTIAL_ENCRYPTION_KEY_BASE64: KEY.toString('base64'), PROPERTY_PREDATOR_WHATSAPP_CREDENTIAL_KEY_VERSION: 'k1' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.doesNotMatch(ok.stdout + ok.stderr, new RegExp(TOKEN, 'u'));
  assert.equal(parseMhpWhatsAppEnvelope(ok.stdout.trim()).wabaId, ids3.wabaId);
  const refused = run({});
  assert.equal(refused.status, 1);
  assert.doesNotMatch(refused.stdout + refused.stderr, new RegExp(TOKEN, 'u'));
  assert.throws(() => sealKeyFromEnvironment({ PROPERTY_PREDATOR_WHATSAPP_CREDENTIAL_ENCRYPTION_KEY_BASE64: 'c2hvcnQ=', PROPERTY_PREDATOR_WHATSAPP_CREDENTIAL_KEY_VERSION: 'k1' }));
});

test('the WhatsApp pilot is off by default and reuses the owner number from the SMS pilot settings', () => {
  assert.equal(mhpOwnedWhatsAppConfig({}).enabled, false);
  assert.equal(mhpOwnedWhatsAppConfig({ MHP_WHATSAPP_PILOT_ENABLED: 'true' }).config, null);
  const settings = { MHP_WHATSAPP_PILOT_ENABLED: 'true', MHP_SMS_PILOT_OWNER_USER_ID: ids.user, MHP_SMS_PILOT_CONTACT_ID: ids.prospect, MHP_SMS_PILOT_PHONE: '+447700900999' };
  const on = mhpOwnedWhatsAppConfig(settings);
  assert.deepEqual(on.config, { ownerUserId: ids.user, contactId: ids.prospect, phone: '+447700900999', workerLive: false });
  assert.match(on.blockers.join(' '), /worker is live/u);
  assert.deepEqual(mhpOwnedWhatsAppConfig({ ...settings, MHP_WHATSAPP_WORKER_LIVE_CONFIRMED: 'true' }).blockers, []);
});

function serviceFixture(options: { approved?: boolean; binding?: boolean; replay?: boolean; body?: string; workerLive?: boolean } = {}) {
  const calls: string[] = [];
  const database = (): MhpOwnedWhatsAppDatabaseSnapshot => ({ bindingId: options.binding === false ? null : ids.approval, connectionId: ids.send,
    senderNumber: '+447861935832', wabaId: ids3.wabaId, phoneNumberId: ids3.phoneNumberId, templates: [], possessionProven: true,
    whatsappPointId: null, whatsappPointVerified: false, suppressed: false, lastResult: null });
  const sha = createHash('sha256').update('draft').digest('hex');
  const dependencies: MhpOwnedWhatsAppDependencies = {
    config: { ownerUserId: ids.user, contactId: ids.prospect, phone: '+447700900999', workerLive: options.workerLive ?? true }, blockers: [],
    marketingWorkspace: { snapshot: async given => ({ userId: given.userId, selectedWorkspaceId: given.workspaceId, personalWorkspaceId: ids.prospect,
      marketingWorkspaceId: identity.workspaceId, marketingSelected: given.workspaceId === identity.workspaceId }) },
    authorize: async (given, requestId) => requestDatabaseContext({ userId: given.userId, workspaceId: given.workspaceId, requestId,
      portalSessionTokenHash: createHash('sha256').update(given.sessionToken).digest() }),
    repository: {
      snapshot: async () => { calls.push('snapshot'); return database(); },
      connect: async (_c, _i, input) => { calls.push('connect'); return { bindingId: input.envelope.bindingId, replayed: false }; },
      recordTemplate: async (_c, _i, input) => { calls.push(`template:${input.metaTemplateId}`); return { templateId: input.templateId, replayed: false }; },
      send: async (_c, _i, _input, _config, lookupOnly) => { calls.push(lookupOnly ? 'lookup' : 'send');
        if (lookupOnly) return options.replay ? { jobId: ids.lease, commandId: ids.command, templateId: ids.item, state: 'queued', replayed: true, authorityExpiresAt: 'x' } : null;
        return { jobId: ids.lease, commandId: ids.command, templateId: ids.item, state: 'queued', replayed: false, authorityExpiresAt: 'x' }; },
    },
    messages: {
      choices: async () => [],
      review: async () => { calls.push('review'); return { review: { ...review, contentSha256: sha, approvalStatus: options.approved === false ? 'pending' : 'approved', approvalStale: false },
        channel: 'whatsapp', payload: { schema: 'growthhq.whatsapp-template-draft/v1', templateName: 'mhp_webinar_20261104_reminder_v1', language: 'en_GB',
          bodyText: options.body ?? 'Webinar tonight at 7:30pm.' }, valid: true, local: null, manifestSha256: sha } as never; },
      publish: async () => { calls.push('publish'); },
    },
  };
  return { service: new MhpOwnedWhatsAppService(dependencies), calls, sha };
}

test('owner actions: connect parses the sealed text, the template step publishes only when needed, the send looks up history first', async () => {
  const f = serviceFixture();
  await f.service.connect(identity, ids.request, { commandId: ids.command, envelopeText: JSON.stringify(sealed()), senderNumber: '+447861935832',
    ownershipEvidence: 'Meta Business Manager WABA owned by MH196 Ltd', confirmed: true });
  await assert.rejects(f.service.connect(identity, ids.request, { commandId: ids.command, envelopeText: JSON.stringify(sealed()), senderNumber: '07861 935832',
    ownershipEvidence: 'Meta Business Manager WABA owned by MH196 Ltd', confirmed: true }), { status: 400 });
  const template = { commandId: ids.command, templateId: ids.item, itemId: ids.item, versionId: ids.version, sha256: f.sha, category: 'marketing',
    metaTemplateId: '1441099094827445', approvalReference: 'WhatsApp Manager shows Approved', confirmed: true, contentApproved: true };
  await assert.rejects(f.service.recordTemplate(identity, ids.request, { ...template, contentApproved: false }, now), { status: 400 },
    'pinning needs the owner to approve the exact text explicitly');
  await f.service.recordTemplate(identity, ids.request, template, now);
  assert.ok(f.calls.includes('template:1441099094827445') && !f.calls.includes('publish'));
  const unapproved = serviceFixture({ approved: false });
  await unapproved.service.recordTemplate(identity, ids.request, { ...template, sha256: unapproved.sha }, now);
  assert.ok(unapproved.calls.indexOf('publish') < unapproved.calls.indexOf('template:1441099094827445'));
  await assert.rejects(serviceFixture({ body: 'Hi {{1}}' }).service.recordTemplate(identity, ids.request, template, now), { status: 409 });
  await assert.rejects(serviceFixture({ binding: false }).service.recordTemplate(identity, ids.request, template, now), { status: 409 });
  const send = serviceFixture();
  assert.equal((await send.service.send(identity, ids.request, { commandId: ids.command, templateId: ids.item, agreed: true })).replayed, false);
  assert.deepEqual(send.calls, ['snapshot', 'lookup', 'send']);
  const replay = serviceFixture({ replay: true });
  assert.equal((await replay.service.send(identity, ids.request, { commandId: ids.command, templateId: ids.item, agreed: true })).replayed, true);
  assert.deepEqual(replay.calls, ['snapshot', 'lookup']);
  await assert.rejects(send.service.send(identity, ids.request, { commandId: ids.command, templateId: ids.item, agreed: false }), { status: 400 });
  const dark = serviceFixture({ workerLive: false });
  await assert.rejects(dark.service.send(identity, ids.request, { commandId: ids.command, templateId: ids.item, agreed: true }), { status: 409 },
    'no send while the worker is dark, so a monthly slot is never wasted');
  assert.ok(!dark.calls.includes('send'));
  await assert.rejects(send.service.send({ ...identity, userId: ids.proof }, ids.request, { commandId: ids.command, templateId: ids.item, agreed: true }), { status: 403 });
});

test('the owner WhatsApp page needs the owner session, CSRF and same origin, and never shows a token field', async () => {
  const HOST = 'app.martinhowardproperty.co.uk', ORIGIN = `https://${HOST}`, SECRET = 'synthetic-mhp-owned-whatsapp-router-secret-32+';
  const f = serviceFixture({ binding: false }); const posted: string[] = [];
  const whatsapp = { snapshot: f.service.snapshot.bind(f.service),
    connect: async () => { posted.push('connect'); return { bindingId: ids.approval, replayed: false }; },
    recordTemplate: async () => { posted.push('template'); return { templateId: ids.item, replayed: false }; },
    send: async () => { posted.push('send'); return { jobId: ids.lease, commandId: ids.command, templateId: ids.item, state: 'queued', replayed: false, authorityExpiresAt: 'x' }; } };
  let authenticated = true;
  const portal = { kind: 'postgres', secure: true, sessionSecret: SECRET, sessionCookieName: '__Host-mhp_session', productProfile: MARTIN_HOWARD_PROPERTY_PROFILE,
    portalBaseUrl: ORIGIN, now: () => now, crm: {} as PostgresPortalDeps['crm'],
    auth: { resolve: async (given: string) => authenticated && given === token ? identity : null, login: async () => null, revoke: async () => {} }, abuseHashSecret: SECRET,
    requestContext: () => ({ requestId: ids.request, requestHash: Buffer.alloc(32, 1), sourceHash: Buffer.alloc(32, 2) }),
    abuse: { admit: async () => ({ allowed: true, leaseHash: Buffer.alloc(32, 1), retryAfterSeconds: 0 }), complete: async () => {}, assertReady: async () => {}, close: async () => {} } } as PostgresPortalDeps;
  const mount = createMhpMount({ portal, ownedWhatsApp: whatsapp, authMount: { handle: async () => false }, readiness: async () => [],
    hq: { isOwner: async () => true, snapshot: async () => ({ people: [], products: [], grants: [] }), grant: async () => ids.command },
    commerce: { billingEnabled: false, snapshot: async () => { throw Error('excluded'); }, refund: async () => {}, billingPortal: async () => '', webhook: async () => {} } });
  async function request(method: string, path: string, body = '', headers: Record<string, string> = {}) {
    const result = { status: 0, body: '' };
    const req = Object.assign(Readable.from([Buffer.from(body)]), { method, url: path, headers: { host: HOST, cookie: `__Host-mhp_session=${token}`,
      'content-type': 'application/x-www-form-urlencoded', origin: ORIGIN, ...headers } }) as unknown as IncomingMessage;
    const res = { writeHead(status: number) { result.status = status; }, setHeader() {}, end(text = '') { result.body = text; } } as unknown as ServerResponse;
    await mount.handle(req, res); return result;
  }
  authenticated = false;
  assert.equal((await request('GET', '/hq/marketing/whatsapp')).status, 303);
  authenticated = true;
  const page = await request('GET', '/hq/marketing/whatsapp');
  assert.equal(page.status, 200);
  assert.match(page.body, /Sealed connection text/u);
  assert.doesNotMatch(page.body, /access token<input|name="accessToken"|name="token"/iu, 'the page never asks for the raw token');
  assert.match(page.body, /STOP are not yet recorded/u);
  const fields = (extra: Record<string, string>) => new URLSearchParams({ csrf: portalCsrfToken(SECRET, token), commandId: ids.command, ...extra }).toString();
  const connect = { envelope: JSON.stringify(sealed()), senderNumber: '+447861935832', ownershipEvidence: 'Meta Business Manager WABA owned by MH196 Ltd', confirmed: 'yes' };
  assert.equal((await request('POST', '/hq/marketing/whatsapp/connect', fields(connect), { origin: 'https://evil.example' })).status, 403);
  assert.equal((await request('POST', '/hq/marketing/whatsapp/connect', fields({ ...connect, csrf: 'forged' }).replace(/csrf=[^&]+/u, 'csrf=forged'))).status, 403);
  assert.equal((await request('POST', '/hq/marketing/whatsapp/connect', fields({ ...connect, extra: '1' }))).status, 400);
  assert.equal(posted.length, 0);
  assert.equal((await request('POST', '/hq/marketing/whatsapp/connect', fields(connect))).status, 200);
  assert.equal((await request('POST', '/hq/marketing/whatsapp/send', fields({ templateId: ids.item, agreed: 'yes' }))).status, 200);
  assert.deepEqual(posted, ['connect', 'send']);
});

test('the marketing workspace links the WhatsApp page only when it is mounted', () => {
  const snapshot = { userId: ids.user, selectedWorkspaceId: identity.workspaceId, personalWorkspaceId: ids.prospect, marketingWorkspaceId: identity.workspaceId, marketingSelected: true };
  assert.match(marketingWorkspacePage(snapshot as never, 'csrf', ids.command, { enabled: true, whatsappEnabled: true }), /\/hq\/marketing\/whatsapp/u);
  assert.doesNotMatch(marketingWorkspacePage(snapshot as never, 'csrf', ids.command, { enabled: true }), /marketing\/whatsapp/u);
});
