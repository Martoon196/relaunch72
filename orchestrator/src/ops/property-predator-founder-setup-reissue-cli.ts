#!/usr/bin/env node

import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import '../config.js';
import { loadDatabaseConfig } from '../db/config.js';
import { createDatabasePool } from '../db/pool.js';
import { assertRuntimeSchemaCurrent } from '../db/runtime-readiness.js';
import { loadSetupDeliveryRuntimeConfig } from '../portal/setup-delivery-config.js';
import {
  loadPropertyPredatorFounderSetupReissueConfig,
  reissuePropertyPredatorFounderSetup,
  type PropertyPredatorFounderSetupReissueHandoff,
} from './property-predator-founder-setup-reissue.js';

const HANDOFF_TTL_MS = 20 * 60 * 1_000;

function page(handoff: PropertyPredatorFounderSetupReissueHandoff): string {
  const setupUrl = JSON.stringify(handoff.setupUrl ?? '').replace(/</gu, '\\u003c');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta name="referrer" content="no-referrer"><title>Property Predator founder setup reissue</title><style>:root{color-scheme:dark;font-family:Inter,system-ui;background:#070a0b;color:#f5f7f7}body{margin:0;padding:32px;min-height:100vh;background:radial-gradient(circle at 80% 0,#0b3c38 0,transparent 34%),#070a0b}main{max-width:820px;margin:auto}.eyebrow{color:#00e5cc;font:800 12px ui-monospace;letter-spacing:.16em;text-transform:uppercase}h1{font-size:clamp(34px,7vw,62px);line-height:.96;margin:14px 0}p{color:#b8c3c2;line-height:1.6}.card{border:1px solid #243130;background:#0c1112;padding:20px;margin:20px 0;word-break:break-all}.value{font:650 14px ui-monospace}button{border:1px solid #00e5cc;background:#00e5cc;color:#04100f;padding:12px 16px;font-weight:900;cursor:pointer;margin-right:10px}.destroy{background:transparent;color:#ff8f85;border-color:#7c3e39}</style></head><body><main><div class="eyebrow">Property Predator · private one-use handoff</div><h1>Fresh founder setup link created.</h1><p>The link expires at ${handoff.setupExpiresAt}. No provider or customer message was sent.</p><div class="card"><div class="value" id="value"></div></div><button id="copy">Copy setup link</button><button class="destroy" id="destroy">Destroy this page</button><script>const value=${setupUrl};document.getElementById('value').textContent=value;document.getElementById('copy').onclick=async()=>{await navigator.clipboard.writeText(value);document.getElementById('copy').textContent='Copied'};document.getElementById('destroy').onclick=()=>{document.body.textContent='Private handoff destroyed. You can close this tab.';try{window.close()}catch{}};</script></main></body></html>`;
}

async function serveHandoff(handoff: PropertyPredatorFounderSetupReissueHandoff): Promise<{ server: Server; url: string }> {
  let available = true;
  const capability = randomBytes(32).toString('base64url');
  let expectedHost = '';
  const server = createServer((request, response) => {
    if (!available || request.method !== 'GET' || request.headers.host !== expectedHost
        || request.url !== `/${capability}`) {
      response.writeHead(available ? 404 : 410, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      response.end(available ? 'Not found' : 'Private handoff already consumed');
      return;
    }
    available = false;
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store, no-cache, must-revalidate, private, max-age=0',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'none'; img-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    });
    response.end(page(handoff), () => server.close());
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
      server.off('error', reject); resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Private handoff failed to bind loopback');
  expectedHost = `127.0.0.1:${address.port}`;
  const expiry = setTimeout(() => { available = false; server.close(); }, HANDOFF_TTL_MS);
  server.once('close', () => clearTimeout(expiry));
  return { server, url: `http://${expectedHost}/${capability}` };
}

async function main(): Promise<void> {
  if (process.argv.length > 2) {
    process.stderr.write('Usage: npm run founder:reissue-setup\n'); process.exitCode = 2; return;
  }
  let webPool: ReturnType<typeof createDatabasePool> | undefined;
  let reissuePool: ReturnType<typeof createDatabasePool> | undefined;
  try {
    const config = loadPropertyPredatorFounderSetupReissueConfig();
    const deliveryConfig = loadSetupDeliveryRuntimeConfig();
    webPool = createDatabasePool(loadDatabaseConfig('web'));
    await assertRuntimeSchemaCurrent(webPool);
    await webPool.end(); webPool = undefined;
    reissuePool = createDatabasePool(loadDatabaseConfig('setupReissueCommand'));
    await reissuePool.query('/* ops.property-predator.founder-setup-reissue-role-readiness */ SELECT 1');
    const handoff = await reissuePropertyPredatorFounderSetup({
      reissueCommandPool: reissuePool, keyring: deliveryConfig.keyring,
    }, config);
    await reissuePool.end(); reissuePool = undefined;
    if (!handoff.createdNow || !handoff.setupUrl) {
      process.stdout.write('Founder setup reissue already recorded for this change reference; no stale link was exposed. Use a fresh reviewed change reference.\n');
      return;
    }
    const oneTime = await serveHandoff(handoff);
    process.stdout.write(`HANDOFF_URL=${oneTime.url}\n`);
  } catch {
    await Promise.allSettled([webPool?.end(), reissuePool?.end()]);
    process.stderr.write('Founder setup reissue failed closed; no link or provider effect was exposed.\n');
    process.exitCode = 1;
  }
}

await main();
