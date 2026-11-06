import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { sealMhpWhatsAppConnection, startMhpWhatsAppSealTool } from '../src/ops/mhp-whatsapp-seal.js';
import { MHP_WHATSAPP_TARGET, parseMhpWhatsAppConnectionPacket } from '../src/mhp/whatsapp-connection-packet.js';
import { decryptMetaWhatsAppDispatchCredentials } from '../src/whatsapp-live/foundation.js';
import { MhpEventWhatsAppOwner } from '../src/mhp/event-whatsapp-owner.js';
import { marketingWorkspacePage } from '../src/mhp/marketing-workspace-view.js';
import { identity } from './helpers/mhp-owner-email-fixture.js';

const key = Buffer.alloc(32, 9), token = 'synthetic-MHP-token-not-a-real-credential-12345';
const bindingId = '01410000-0000-4000-8000-000000000001', connectionId = '01410000-0000-4000-8000-000000000002';
const clock = Date.parse('2026-11-04T16:00:00Z');
const observed: { url: string; init?: RequestInit }[] = [];
const provider = (async (url: URL, init?: RequestInit) => { observed.push({ url: String(url), init }); return new Response(JSON.stringify({ data: [{
  id: MHP_WHATSAPP_TARGET.phoneNumberId, display_phone_number: MHP_WHATSAPP_TARGET.senderNumber }] }), { status: 200 }); }) as typeof fetch;
const seal = () => sealMhpWhatsAppConnection({ encryptionKey: key, keyVersion: 'mhp-worker-v1', bindingId, connectionId, accessToken: token, fetch: provider, now: () => clock });

test('off-web sealing reuses the exact fixed Meta ownership GET and existing worker envelope; packet has no plaintext credential', async () => {
  observed.length = 0;
  const packet = await seal();
  assert.equal(observed[0]!.url, 'https://graph.facebook.com/v24.0/1874194210608511/phone_numbers?fields=id%2Cdisplay_phone_number&limit=100');
  assert.equal(observed[0]!.init!.method, 'GET');
  assert.equal(observed[0]!.init!.redirect, 'error');
  assert.equal((observed[0]!.init!.headers as Record<string, string>).authorization, `Bearer ${token}`);
  assert.equal(decryptMetaWhatsAppDispatchCredentials({ binding: packet.binding, envelope: packet.envelope, encryptionKey: key, expectedKeyVersion: 'mhp-worker-v1' }).accessToken, token);
  assert.doesNotMatch(JSON.stringify(packet), /synthetic-MHP-token|accessToken|encryptionKey/u);
  assert.deepEqual(parseMhpWhatsAppConnectionPacket(JSON.stringify(packet), bindingId, clock), packet);
});

test('public import refuses raw credentials, wrong MHP tuple, wrong AAD, changed binding and stale ownership read', async () => {
  const packet = await seal();
  for (const value of [{ ...packet, accessToken: token }, { ...packet, binding: { ...packet.binding, wabaId: '1832855614922574' } },
    { ...packet, envelope: { ...packet.envelope, aadSha256: 'ff'.repeat(32) } },
    { ...packet, ownership: { ...packet.ownership, observedAt: new Date(clock - 900_001).toISOString() } },
    { ...packet, ownership: { ...packet.ownership, observedAt: new Date(clock + 60_001).toISOString() } }]) {
    assert.throws(() => parseMhpWhatsAppConnectionPacket(JSON.stringify(value), bindingId, clock), /Invalid or expired/u);
  }
  assert.throws(() => parseMhpWhatsAppConnectionPacket(JSON.stringify(packet), connectionId, clock), /Invalid or expired/u);
  assert.throws(() => parseMhpWhatsAppConnectionPacket(JSON.stringify({ token }), bindingId, clock), /Invalid or expired/u);
});

test('denied ownership returns a safe error without token or provider response reflection', async () => {
  await assert.rejects(() => sealMhpWhatsAppConnection({ encryptionKey: key, keyVersion: 'mhp-worker-v1', bindingId, connectionId,
    accessToken: token, fetch: (async () => new Response(JSON.stringify({ error: { message: token } }), { status: 403 })) as typeof fetch }),
  (error: Error) => error.message === 'WhatsApp ownership check: access_denied');
});

function ownerFixture(selected = true) {
  const calls: { sql: string; args?: unknown[] }[] = [];
  const owner = new MhpEventWhatsAppOwner({ bindingId, metaTemplateId: '1441099094827445', campaign: 'webinar-2026-11-04',
    marketingWorkspace: { snapshot: async () => ({ marketingSelected: selected, marketingWorkspaceId: MHP_WHATSAPP_TARGET.workspaceId, userId: identity.userId }) } as never,
    authorize: async (_identity, requestId) => ({ workspaceId: MHP_WHATSAPP_TARGET.workspaceId, userId: identity.userId, actorKind: 'user', requestId }),
    whatsappPool: { connect: async () => ({ query: async (sql: string, args?: unknown[]) => { calls.push({ sql, args });
      return { rows: sql.includes('mhp_whatsapp_connect') ? [{ value: { bindingId, connectionId, providerEffects: 'none', replayed: false } }] : [] }; }, release: () => undefined }) } as never,
    reader: {} as never, adapter: {} as never, approvals: {} as never, brand: async () => ({}) });
  return { owner, calls };
}
test('native owner import uses the real session and transaction context, accepts ciphertext only, and returns the durable connection receipt', async () => {
  const packet = await seal(), f = ownerFixture();
  assert.equal((await f.owner.connect(identity, 'mhp-connection-test', JSON.stringify(packet), true, clock)).bindingId, bindingId);
  const context = f.calls.find(c => c.sql.includes("set_config('app.user_id'"))!;
  assert.deepEqual(context.args, [identity.userId, MHP_WHATSAPP_TARGET.workspaceId, 'user', 'mhp-connection-test']);
  const command = f.calls.find(c => c.sql.includes('mhp_whatsapp_connect'))!;
  assert.deepEqual(command.args![0], createHash('sha256').update(identity.sessionToken).digest());
  assert.equal(command.args![1], packet.commandId); assert.equal(command.args![2], connectionId); assert.equal(command.args![3], bindingId);
  assert.deepEqual(command.args![10], Buffer.from(packet.envelope.ciphertextBase64, 'base64'));
  assert.ok(!command.args!.includes(token));
  assert.equal(f.calls.at(-1)!.sql, 'COMMIT');
});

test('unselected workspace, missing confirmation and plaintext file fail before acquiring a command connection', async () => {
  const packet = await seal();
  for (const [selected, raw, confirmed] of [[false, JSON.stringify(packet), true], [true, JSON.stringify(packet), false], [true, JSON.stringify({ token }), true]] as const) {
    const f = ownerFixture(selected);
    await assert.rejects(() => f.owner.connect(identity, 'mhp-connection-test', raw, confirmed, clock));
    assert.equal(f.calls.length, 0);
  }
});

test('one-use local setup rejects cross-site POST and downloads only the encrypted packet after explicit local token entry', async () => {
  let reads = 0;
  const tool = await startMhpWhatsAppSealTool({ encryptionKey: key, keyVersion: 'mhp-worker-v1', bindingId, connectionId,
    fetch: (async (...args: Parameters<typeof fetch>) => { reads++; return provider(...args); }) as typeof fetch, now: () => clock });
  try {
    const page = await fetch(tool.url), html = await page.text();
    // Real HTML form POSTs use Origin:null under no-referrer, unlike fetch().
    assert.equal(page.headers.get('referrer-policy'), 'same-origin');
    assert.match(html, /type="password"/u); assert.doesNotMatch(html, new RegExp(token, 'u'));
    const csrf = /name="csrf" value="([^"]+)"/u.exec(html)![1]!;
    const body = new URLSearchParams({ csrf, token });
    const foreign = await fetch(tool.url, { method: 'POST', body, headers: { origin: 'https://evil.example' } });
    assert.equal(foreign.status, 403); assert.equal(reads, 0);
    assert.equal(foreign.headers.get('referrer-policy'), 'no-referrer');
    const rejectedHeaders: Record<string, string>[] = [{ origin: 'null' }, { origin: new URL(tool.url).origin, 'sec-fetch-site': 'cross-site' }];
    for (const headers of rejectedHeaders) {
      const rejected = await fetch(tool.url, { method: 'POST', body, headers });
      assert.equal(rejected.status, 403); assert.equal(reads, 0);
    }
    const bad = await fetch(tool.url, { method: 'POST', body: new URLSearchParams({ csrf: 'wrong', token }), headers: { origin: new URL(tool.url).origin } });
    assert.equal(bad.status, 403); assert.equal(reads, 0);
    const response = await fetch(tool.url, { method: 'POST', body, headers: { origin: new URL(tool.url).origin } });
    assert.equal(response.status, 200); assert.equal(reads, 1);
    assert.match(response.headers.get('content-disposition')!, /mhp-whatsapp-connection.json/u);
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    const download = await response.text(); assert.doesNotMatch(download, new RegExp(token, 'u'));
    assert.equal(parseMhpWhatsAppConnectionPacket(download, bindingId, clock).bindingId, bindingId);
  } finally { tool.server.closeAllConnections(); await new Promise<void>(resolve => tool.server.close(() => resolve())); }
});


test('MHP WhatsApp control is visible only in the selected brand workspace when the real service is mounted', () => {
  const selected = { marketingSelected: true };
  assert.match(marketingWorkspacePage(selected as never, 'c', 'id', { enabled: false, whatsappEnabled: true }), /href="\/hq\/marketing\/webinar-whatsapp"/u);
  assert.doesNotMatch(marketingWorkspacePage(selected as never, 'c', 'id', { enabled: false, whatsappEnabled: false }), /href="\/hq\/marketing\/webinar-whatsapp"/u);
  assert.doesNotMatch(marketingWorkspacePage({ marketingSelected: false } as never, 'c', 'id', { enabled: false, whatsappEnabled: true }), /href="\/hq\/marketing\/webinar-whatsapp"/u);
});
