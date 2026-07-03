import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { RUNS_DIR } from '../paths.js';
import { ORCHESTRATOR_VERSION } from '../config.js';
import type { RunManifest } from '../types.js';

function timestamp(): string {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
}

export function createRun(source: string, mode: 'live' | 'mock', through: string): { runDir: string; manifest: RunManifest } {
  const runId = `${timestamp()}-${source}${mode === 'mock' ? '-mock' : ''}-${crypto.randomBytes(2).toString('hex')}`;
  const runDir = path.join(RUNS_DIR, runId);
  fs.mkdirSync(runDir, { recursive: true });

  const manifest: RunManifest = {
    run_id: runId,
    source,
    mode,
    through,
    created_at: new Date().toISOString(),
    finished_at: null,
    status: 'running',
    s0: null,
    stages: [],
    totals: { tokens_in: 0, tokens_out: 0, cost_usd: 0 },
    environment: { node: process.version, orchestrator_version: ORCHESTRATOR_VERSION },
  };
  return { runDir, manifest };
}

export function writeManifest(runDir: string, manifest: RunManifest): void {
  // Totals derived from attempts so they can never drift from the stage records.
  manifest.totals = manifest.stages.reduce(
    (t, s) => {
      for (const a of s.attempts) {
        t.tokens_in += a.tokens_in;
        t.tokens_out += a.tokens_out;
      }
      t.cost_usd += s.cost_usd;
      return t;
    },
    { tokens_in: 0, tokens_out: 0, cost_usd: 0 },
  );
  manifest.totals.cost_usd = Math.round(manifest.totals.cost_usd * 10000) / 10000;
  fs.writeFileSync(path.join(runDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
}
