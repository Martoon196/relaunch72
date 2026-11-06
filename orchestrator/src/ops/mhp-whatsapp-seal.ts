import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { pathToFileURL } from 'node:url';
import { encryptMetaWhatsAppDispatchCredentials } from '../whatsapp-live/foundation.js';
import { createWhatsAppOwnershipClient } from '../whatsapp-live/ownership-client.js';
import { MHP_WHATSAPP_TARGET, parseMhpWhatsAppConnectionPacket, type MhpWhatsAppConnectionPacket } from '../mhp/whatsapp-connection-packet.js';

export async function sealMhpWhatsAppConnection(input: { accessToken: string; encryptionKey: Buffer; keyVersion: string;
  bindingId: string; connectionId: string; commandId?: string; fetch?: typeof fetch; now?: () => number }): Promise<MhpWhatsAppConnectionPacket> {
  if (input.encryptionKey.length !== 32 || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(input.keyVersion)
      || ![input.bindingId, input.connectionId, ...(input.commandId ? [input.commandId] : [])].every(v => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(v))) throw new Error('MHP sealing configuration is invalid');
  const target = MHP_WHATSAPP_TARGET;
  const ownership = await createWhatsAppOwnershipClient({ target: { wabaId: target.wabaId, phoneNumberId: target.phoneNumberId,
    normalizedNumber: target.senderNumber.slice(1) }, fetch: input.fetch, now: input.now }).verify(input.accessToken);
  const binding = { workspaceId: target.workspaceId, connectionId: input.connectionId, appId: target.appId,
    wabaId: target.wabaId, phoneNumberId: target.phoneNumberId, graphApiVersion: 'v24.0' as const };
  const envelope = encryptMetaWhatsAppDispatchCredentials({ binding, credentials: { accessToken: input.accessToken },
    encryptionKey: input.encryptionKey, keyVersion: input.keyVersion });
  return parseMhpWhatsAppConnectionPacket(JSON.stringify({ schema: 'mhp.whatsapp.sealed-connection/v1', commandId: input.commandId ?? randomUUID(),
    bindingId: input.bindingId, binding, senderNumber: target.senderNumber, envelope, ownership }), input.bindingId, input.now?.() ?? Date.now());
}

/** Off-web, one-use local operator tool. No credential/key is sent to the public app. */
export async function startMhpWhatsAppSealTool(input: { encryptionKey: Buffer; keyVersion: string; bindingId: string; connectionId: string;
  fetch?: typeof fetch; port?: number; now?: () => number }): Promise<{ server: Server; url: string }> {
  if (input.encryptionKey.length !== 32 || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(input.keyVersion)) throw new Error('Sealing key is not configured');
  const secretPath = randomBytes(24).toString('base64url'), csrf = randomBytes(24).toString('base64url');
  let origin = '', busy = false, complete = false;
  const server = createServer(async (req, res) => {
    const reply = (status: number, body: string, type = 'text/plain; charset=utf-8') => {
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
        // HTML form POSTs need their real Origin; no-referrer makes it null.
        'referrer-policy': req.method === 'GET' && status === 200 ? 'same-origin' : 'no-referrer',
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'" }); res.end(body);
    };
    if (req.headers.host !== new URL(origin).host || req.url !== `/${secretPath}` || complete) { reply(404, 'Not found'); return; }
    if (req.method === 'GET') {
      reply(200, '<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect MHP WhatsApp</title>'
        + '<style>body{font:18px/1.6 system-ui;background:#f5f3ed;color:#142019;max-width:680px;margin:40px auto;padding:24px}label{display:block;margin:24px 0}input{box-sizing:border-box;width:100%;font:inherit;padding:12px}button{font:inherit;background:#e8a33d;border:0;border-radius:8px;padding:16px}</style></head><body>'
        + `<h1>Connect Martin Howard Property</h1><p>Number: ${MHP_WHATSAPP_TARGET.senderNumber}.</p><p>Paste your dedicated MHP token below. This local tool checks the number with Meta, then downloads an encrypted connection file for Growth HQ. It does not send a WhatsApp message.</p>`
        + `<form method="post" action="/${secretPath}"><input type="hidden" name="csrf" value="${csrf}"><label>MHP access token<input name="token" type="password" autocomplete="off" maxlength="2000" required></label><button>Check and download connection file</button></form></body></html>`, 'text/html; charset=utf-8'); return;
    }
    if (req.method !== 'POST') { reply(405, 'Use the connection form'); return; }
    if (req.headers.origin !== origin || (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin')
        || !/^application\/x-www-form-urlencoded(?:;|$)/iu.test(req.headers['content-type'] ?? '')) { reply(403, 'Use the local connection form'); return; }
    if (busy) { reply(409, 'The connection check is already running'); return; }
    busy = true;
    try {
      const chunks: Buffer[] = []; let size = 0;
      for await (const raw of req) { const part = Buffer.isBuffer(raw) ? raw : Buffer.from(raw); size += part.length;
        if (size > 8_192) { reply(413, 'The connection form is too large'); return; } chunks.push(part); }
      const fields = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
      const proof = fields.get('csrf') ?? '';
      if (Buffer.byteLength(proof) !== Buffer.byteLength(csrf) || !timingSafeEqual(Buffer.from(proof), Buffer.from(csrf)) || fields.getAll('csrf').length !== 1
          || fields.getAll('token').length !== 1 || [...fields.keys()].some(k => !['csrf', 'token'].includes(k))) { reply(403, 'Refresh the local connection form'); return; }
      const packet = await sealMhpWhatsAppConnection({ ...input, accessToken: fields.get('token') ?? '' });
      res.setHeader('content-disposition', 'attachment; filename="mhp-whatsapp-connection.json"');
      complete = true; reply(200, JSON.stringify(packet), 'application/json');
      server.close();
    } catch { reply(422, 'Meta could not confirm this MHP token and number. Check the MHP account access, then try again. No connection was saved.'); }
    finally { busy = false; }
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(input.port ?? 0, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Local connection tool could not start');
  origin = `http://127.0.0.1:${address.port}`;
  return { server, url: `${origin}/${secretPath}` };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const raw = process.env.PROPERTY_PREDATOR_WHATSAPP_CREDENTIAL_ENCRYPTION_KEY_BASE64 ?? '';
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32 || key.toString('base64') !== raw) throw new Error('Configure the existing worker sealing key in this operator process');
  const bindingId = process.env.MHP_EVENT_WHATSAPP_BINDING_ID?.trim() ?? '';
  const connectionId = process.env.MHP_WHATSAPP_CONNECTION_ID?.trim() ?? '';
  if (![bindingId, connectionId].every(v => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(v))) throw new Error('Configure the reviewed MHP connection and binding IDs');
  const tool = await startMhpWhatsAppSealTool({ encryptionKey: key, keyVersion: process.env.PROPERTY_PREDATOR_WHATSAPP_CREDENTIAL_ENCRYPTION_KEY_VERSION ?? '', bindingId, connectionId });
  console.info(`Open the one-use local MHP connection form: ${tool.url}`);
}
