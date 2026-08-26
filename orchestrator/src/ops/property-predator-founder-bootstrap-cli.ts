#!/usr/bin/env node

import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import '../config.js';
import { loadDatabaseConfig } from '../db/config.js';
import { createDatabasePool } from '../db/pool.js';
import {
  bootstrapPropertyPredatorFounder,
  loadPropertyPredatorFounderBootstrapConfig,
  type PropertyPredatorFounderBootstrapHandoff,
} from './property-predator-founder-bootstrap.js';

const HANDOFF_TTL_MS = 20 * 60 * 1_000;

function handoffPage(handoff: PropertyPredatorFounderBootstrapHandoff): string {
  const payload = JSON.stringify(handoff).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<meta name="referrer" content="no-referrer"><title>Property Predator private bootstrap handoff</title>
<style>
:root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui;background:#070a0b;color:#f5f7f7}
body{margin:0;padding:32px;min-height:100vh;background:radial-gradient(circle at 80% 0,#0b3c38 0,transparent 34%),#070a0b}
main{max-width:880px;margin:auto}.eyebrow{color:#00e5cc;font:800 12px ui-monospace;letter-spacing:.16em;text-transform:uppercase}
h1{font-size:clamp(32px,7vw,64px);line-height:.94;margin:14px 0 16px}p{color:#aeb9b8;line-height:1.6}
.card{border:1px solid #243130;background:#0c1112;padding:18px;margin:14px 0}.row{display:grid;grid-template-columns:1fr auto;gap:12px;align-items:center}
.label{font:800 11px ui-monospace;color:#89a09e;text-transform:uppercase}.value{font:650 13px ui-monospace;word-break:break-all;margin-top:7px}
button{border:1px solid #00e5cc;background:#00e5cc;color:#04100f;padding:10px 14px;font-weight:900;cursor:pointer}button.destroy{background:transparent;color:#ff8f85;border-color:#7c3e39}
.warning{border-left:3px solid #ffc45d;padding-left:14px;color:#d9c7a7}.done{color:#00e5cc}
</style></head><body><main>
<div class="eyebrow">Property Predator · one-time private handoff</div><h1>Growth HQ is bootstrapped.</h1>
<p>No provider call was made. Email effects are OFF, delivery is OFF and the emergency pause is ON.</p>
<div id="content"></div><p class="warning">Copy these values now. This page came from memory only, cannot be reloaded, and the setup link is not recoverable from an idempotent replay.</p>
<button class="destroy" id="destroy">Destroy this page</button>
<script>
const h=${payload};const content=document.getElementById('content');
const rows=[
 ['PROPERTY_PREDATOR_PILOT_WORKSPACE_ID',h.render.PROPERTY_PREDATOR_PILOT_WORKSPACE_ID],
 ['PROPERTY_PREDATOR_MAILGUN_CONNECTION_ID',h.render.PROPERTY_PREDATOR_MAILGUN_CONNECTION_ID],
 ['PROPERTY_PREDATOR_DATABASE_INSTALLATION_ID',h.render.PROPERTY_PREDATOR_DATABASE_INSTALLATION_ID],
 ['PROPERTY_PREDATOR_EMAIL_INTERNAL_SEEDS',h.render.PROPERTY_PREDATOR_EMAIL_INTERNAL_SEEDS]
];
if(h.setup.url) rows.unshift(['FOUNDER SETUP LINK',h.setup.url]);
else rows.unshift(['FOUNDER SETUP LINK','Unavailable on replay — use the audited setup reissue path']);
for(const [label,value] of rows){const card=document.createElement('div');card.className='card';const row=document.createElement('div');row.className='row';const text=document.createElement('div');const l=document.createElement('div');l.className='label';l.textContent=label;const v=document.createElement('div');v.className='value';v.textContent=value;text.append(l,v);const b=document.createElement('button');b.textContent='Copy';b.onclick=async()=>{await navigator.clipboard.writeText(value);b.textContent='Copied';b.className='done'};row.append(text,b);card.append(row);content.append(card)}
document.getElementById('destroy').onclick=()=>{for(const node of document.querySelectorAll('.value'))node.textContent='destroyed';content.replaceChildren();document.body.textContent='Private handoff destroyed. You can close this tab.';try{window.close()}catch{}};
</script></main></body></html>`;
}

async function createOneTimeHandoff(
  initialHandoff: PropertyPredatorFounderBootstrapHandoff,
): Promise<{ server: Server; url: string }> {
  let handoff: PropertyPredatorFounderBootstrapHandoff | undefined = initialHandoff;
  let consumed = false;
  const capability = randomBytes(32).toString('base64url');
  let expectedHost = '';
  const server = createServer((request, response) => {
    const requestPath = request.url ?? '';
    if (request.method !== 'GET'
        || request.headers.host !== expectedHost
        || requestPath !== `/${capability}`) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end('Not found');
      return;
    }
    if (consumed || !handoff) {
      response.writeHead(410, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end('Private handoff already consumed');
      return;
    }
    consumed = true;
    const page = handoffPage(handoff);
    handoff = undefined;
    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate, private, max-age=0',
      Pragma: 'no-cache',
      Expires: '0',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'none'; img-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    });
    response.end(page, () => server.close());
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Private handoff did not bind a loopback port');
  }
  expectedHost = `127.0.0.1:${address.port}`;
  const expiry = setTimeout(() => {
    handoff = undefined;
    server.close();
  }, HANDOFF_TTL_MS);
  server.once('close', () => clearTimeout(expiry));
  return { server, url: `http://${expectedHost}/${capability}` };
}

async function main(): Promise<void> {
  if (process.argv.length > 2) {
    process.stderr.write('Usage: npm run founder:bootstrap\n');
    process.exitCode = 2;
    return;
  }
  const pool = createDatabasePool(loadDatabaseConfig('migrator'));
  try {
    const config = loadPropertyPredatorFounderBootstrapConfig();
    const handoff = await bootstrapPropertyPredatorFounder({ pool }, config);
    await pool.end();
    const oneTime = await createOneTimeHandoff(handoff);
    oneTime.server.once('close', () => {
      process.stdout.write('Private founder handoff closed.\n');
    });
    process.stdout.write(`HANDOFF_URL=${oneTime.url}\n`);
  } catch {
    await pool.end().catch(() => undefined);
    process.stderr.write('Founder bootstrap failed closed; no provider effect was enabled.\n');
    process.exitCode = 1;
  }
}

await main();
