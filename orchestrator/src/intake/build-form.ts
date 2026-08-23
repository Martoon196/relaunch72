/**
 * Build the self-hosted Deep Intake form (LS-11) from the canonical field spec.
 *
 *   npm run intake:build                       # → site/intake/index.html (POSTs to the private test API)
 *   npm run intake:build -- --endpoint <url>   # override the submit endpoint
 *
 * The output is one self-contained HTML file (no build step, no external calls)
 * that produces the flat A1–H4 JSON the pipeline consumes via `--input`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderIntakeForm } from './form.js';

/** Where a submitted intake is POSTed by default — the private test service's /api/intake. */
const DEFAULT_ENDPOINT = 'https://relaunch72-payments.onrender.com/api/intake';

function parseEndpoint(argv: string[]): string | undefined {
  const i = argv.indexOf('--endpoint');
  return i >= 0 ? argv[i + 1] : undefined;
}

function main(): void {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(here, '../../..'); // orchestrator/src/intake → repo root
  const outDir = path.join(repoRoot, 'site', 'intake');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, 'index.html');
  const html = renderIntakeForm({ submitEndpoint: parseEndpoint(process.argv.slice(2)) ?? DEFAULT_ENDPOINT });
  fs.writeFileSync(outFile, html, 'utf8');
  const kb = (Buffer.byteLength(html, 'utf8') / 1024).toFixed(1);
  console.log(`Deep Intake form → ${path.relative(repoRoot, outFile)} (${kb} KB, self-contained)`);
}

main();
