/**
 * Render CLI — branded docs from a completed run.
 *
 *   npm run render -- --run runs/<run-id>            # HTML only
 *   npm run render -- --run runs/<run-id> --pdf      # HTML + PDF
 *   npm run render -- --latest [--pdf]               # most recent run
 */

import fs from 'node:fs';
import path from 'node:path';
import { RUNS_DIR } from '../paths.js';
import { renderRun } from './render.js';

function latestRunDir(): string {
  const entries = fs
    .readdirSync(RUNS_DIR)
    .filter((d) => fs.existsSync(path.join(RUNS_DIR, d, 'manifest.json')))
    .sort();
  const last = entries[entries.length - 1];
  if (!last) throw new Error(`No runs found in ${RUNS_DIR}`);
  return path.join(RUNS_DIR, last);
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  let runDir: string | null = null;
  let pdf = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--run') runDir = path.resolve(argv[++i] ?? '');
    else if (a === '--latest') runDir = latestRunDir();
    else if (a === '--pdf') pdf = true;
    else if (a === '--help' || a === '-h') {
      console.log('Usage: npm run render -- (--run runs/<id> | --latest) [--pdf]');
      return 0;
    } else throw new Error(`Unknown argument: ${a}`);
  }
  if (!runDir) throw new Error('Provide --run <dir> or --latest');

  const result = await renderRun(runDir, { pdf });
  console.log(`Rendered ${result.html.length} HTML doc(s)${pdf ? ` + ${result.pdf.length} PDF(s)` : ''} → ${result.docsDir}`);
  for (const f of result.html) console.log(`  ${f}${result.pdf.includes(f.replace(/\.html$/, '.pdf')) ? ' (+pdf)' : ''}`);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`Error: ${(err as Error).message}`);
    process.exit(1);
  });
