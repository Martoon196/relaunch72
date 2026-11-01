import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { MHP_EVENT_WHATSAPP_CONSENT_TEXT, mhpEventJoinSha, mhpEventWhatsAppJoinSha } from '../src/mhp/event-phone-service.js';
import { mhpEventPhoneWhatsAppPage } from '../src/mhp/event-phone-view.js';
import { readMetaWhatsAppTemplate } from '../src/whatsapp-live-pg/event-repository.js';
import { PgMetaWhatsAppLiveWebhookCommandService } from '../src/whatsapp-live-pg/webhook-repository.js';

const sha = (v: string): string => createHash('sha256').update(v).digest('hex');
const binding = { workspaceId: '2789228d-55a6-4688-b1e8-2f70abca990b', connectionId: '0b132000-0000-4000-8000-000000000001',
  appId: '123456789012', wabaId: '223456789012', phoneNumberId: '323456789012', graphApiVersion: 'v24.0' as const };
const BODY = 'Thanks for registering for the Martin Howard Property webinar. The replay is now on your Desk.';

test('WhatsApp consent copy equals the 0132 SQL text and its JOIN digest is separate from SMS', async () => {
  const sql = await readFile(new URL('../src/db/migrations/0132_mhp_event_whatsapp_programme.sql', import.meta.url), 'utf8');
  assert.ok(sql.includes(`'${MHP_EVENT_WHATSAPP_CONSENT_TEXT}'`));
  assert.notDeepEqual(mhpEventWhatsAppJoinSha('abc'), mhpEventJoinSha('abc'), 'an SMS JOIN code can never verify WhatsApp');
});

test('Meta template read: exact GET with the worker credential; status, body and parameters hashed; unproven answers are null', async () => {
  let seen: { url: string; init?: RequestInit } | null = null;
  const template = { id: '1441099094827445', name: 'mhp_webinar_20261104_reminder_v1', language: 'en_GB', status: 'APPROVED', category: 'MARKETING',
    components: [{ type: 'BODY', text: BODY }] };
  const ok = await readMetaWhatsAppTemplate({ binding, credentials: { accessToken: 'synthetic-token-value-12345' }, metaTemplateId: '1441099094827445',
    fetch: (async (url: string, init?: RequestInit) => { seen = { url, init }; return new Response(JSON.stringify(template), { status: 200 }); }) as typeof fetch });
  assert.equal(seen!.url, 'https://graph.facebook.com/v24.0/1441099094827445?fields=id,name,language,status,category,components');
  assert.equal((seen!.init!.headers as Record<string, string>).Authorization, 'Bearer synthetic-token-value-12345');
  assert.equal(seen!.init!.method, 'GET');
  assert.deepEqual({ status: ok!.status, parameters: ok!.parameterCount, body: ok!.bodySha256 }, { status: 'APPROVED', parameters: 0, body: sha(BODY) });
  const paused = await readMetaWhatsAppTemplate({ binding, credentials: { accessToken: 'synthetic-token-value-12345' }, metaTemplateId: '1441099094827445',
    fetch: (async () => new Response(JSON.stringify({ ...template, status: 'PAUSED', components: [{ type: 'BODY', text: 'Hi {{1}}' }] }), { status: 200 })) as typeof fetch });
  assert.deepEqual([paused!.status, paused!.parameterCount], ['PAUSED', 1]);
  for (const response of [new Response('nope', { status: 500 }), new Response('{"id":"999999"}', { status: 200 }), new Response('not json', { status: 200 })]) {
    assert.equal(await readMetaWhatsAppTemplate({ binding, credentials: { accessToken: 'synthetic-token-value-12345' }, metaTemplateId: '1441099094827445',
      fetch: (async () => response) as typeof fetch }), null);
  }
  assert.equal(await readMetaWhatsAppTemplate({ binding, credentials: { accessToken: 'synthetic-token-value-12345' }, metaTemplateId: '1441099094827445',
    fetch: (async () => { throw new Error('network'); }) as typeof fetch }), null);
});

test('WhatsApp webhook routes MHP inbound through the wrapper only when enabled', async () => {
  const queries: string[] = [];
  const pool = { connect: async () => ({ query: async (sql: string) => { queries.push(sql);
    return { rows: sql.includes('mhp_record_event_whatsapp_inbound') ? [{ outcome: 'event_joined' }] : sql.includes('record_whatsapp_live_inbound_projection') ? [{ outcome: 'applied' }] : [] }; },
    release: () => undefined }) };
  const make = (enabled: boolean, workspaceId = binding.workspaceId) => new PgMetaWhatsAppLiveWebhookCommandService({ commandPool: pool as never,
    workspaceId, connectionId: binding.connectionId, bindingId: '0b132000-0000-4000-8000-000000000003', mhpEventWhatsApp: enabled });
  assert.equal(make(true).mhpEventWhatsApp, true);
  assert.equal(make(false).mhpEventWhatsApp, false);
  assert.equal(make(true, '11111111-1111-4111-8111-111111111111').mhpEventWhatsApp, false);
});

test('the registrant WhatsApp page shows a wa.me link with their own JOIN code and says SMS checks do not count', () => {
  const status = { ok: true as const, campaign: 'webinar-2026-11-04', open: true, consentText: MHP_EVENT_WHATSAPP_CONSENT_TEXT, whatsapp: null };
  const choose = mhpEventPhoneWhatsAppPage({ status, csrf: 'c', number: '+447861935832' });
  assert.ok(choose.includes(MHP_EVENT_WHATSAPP_CONSENT_TEXT)); assert.match(choose, /required>/u);
  const join = mhpEventPhoneWhatsAppPage({ status, csrf: 'c', number: '+447861935832', join: { nonce: 'abcdefghijklmnopqrstuvwxyz', joinExpiresAt: '2026-11-04T18:00:00Z' } });
  assert.match(join, /https:\/\/wa\.me\/447861935832\?text=JOIN%20ABCDEFGHIJKLMNOPQRSTUVWXYZ/u);
  assert.match(join, /A text-message check does not count for WhatsApp/u);
});
