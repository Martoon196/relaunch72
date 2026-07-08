/**
 * Admin read model — turns the on-disk run artifacts (manifest.json, intake.json,
 * bundle.json, s1..s9.json, signoff.json) and orders.jsonl into structured views
 * for the control room. Read-only; sign-off writes go through the signoff module.
 */

import fs from 'node:fs';
import path from 'node:path';

function readJson<T>(file: string): T | null {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T; } catch { return null; }
}

interface ManifestStage {
  stage: string;
  status: string;
  model?: string;
  prompt_version?: string;
  cost_usd?: number;
  output_file?: string | null;
  flags?: string[];
  attempts?: Array<{ qa_issues?: Array<{ check: string; message: string }> }>;
}
interface Manifest {
  run_id: string;
  source?: string;
  mode?: string;
  through?: string;
  created_at?: string;
  finished_at?: string;
  status?: string;
  stages?: ManifestStage[];
  totals?: { cost_usd?: number };
}
interface Bundle { business?: string; compliance_line?: string; deliverables?: Array<{ stage: string; name: string }> }
interface Signoff { decision: string; by: string; at: string; note?: string }
export interface Order {
  session_id: string; tier: string; bump?: boolean; email?: string | null;
  amount_total?: number | null; currency?: string | null; status: string; paid_at?: string; updated_at?: string; run_dir?: string;
}

export interface RunSummary {
  id: string;
  status: string;
  business: string;
  through: string;
  mode: string;
  createdAt: string;
  finishedAt: string;
  costUsd: number;
  parkedStage: string;
  parkReason: string;
  hasBundle: boolean;
  signoff: Signoff | null;
}

export interface StageView { stage: string; status: string; model: string; costUsd: number; issues: string[]; hasOutput: boolean }
export interface RunDetail {
  id: string;
  summary: RunSummary;
  manifest: Manifest;
  stages: StageView[];
  intakeBusiness: string;
  intakeEmail: string;
  complianceLine: string;
}

function runDirs(runsDir: string): string[] {
  if (!fs.existsSync(runsDir)) return [];
  return fs.readdirSync(runsDir).filter((d) => {
    try { return fs.statSync(path.join(runsDir, d)).isDirectory() && fs.existsSync(path.join(runsDir, d, 'manifest.json')); }
    catch { return false; }
  });
}

function summarize(runsDir: string, id: string): RunSummary | null {
  const dir = path.join(runsDir, id);
  const m = readJson<Manifest>(path.join(dir, 'manifest.json'));
  if (!m) return null;
  const bundle = readJson<Bundle>(path.join(dir, 'bundle.json'));
  const intake = readJson<Record<string, unknown>>(path.join(dir, 'intake.json'));
  const business = bundle?.business || (typeof intake?.A1 === 'string' ? intake.A1 : '') || '(unknown)';
  const parked = (m.stages ?? []).find((s) => s.status === 'parked');
  const signoff = readJson<Signoff>(path.join(dir, 'signoff.json'));
  return {
    id,
    status: m.status ?? 'unknown',
    business,
    through: m.through ?? '',
    mode: m.mode ?? 'live',
    createdAt: m.created_at ?? '',
    finishedAt: m.finished_at ?? '',
    costUsd: m.totals?.cost_usd ?? 0,
    parkedStage: parked?.stage ?? '',
    parkReason: parked?.flags?.[0] ?? '',
    hasBundle: Boolean(bundle),
    signoff,
  };
}

export function listRuns(runsDir: string): RunSummary[] {
  const runs = runDirs(runsDir).map((d) => summarize(runsDir, d)).filter((r): r is RunSummary => r !== null);
  runs.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  return runs;
}

export function getRunDetail(runsDir: string, id: string): RunDetail | null {
  const summary = summarize(runsDir, id);
  if (!summary) return null;
  const dir = path.join(runsDir, id);
  const m = readJson<Manifest>(path.join(dir, 'manifest.json'))!;
  const intake = readJson<Record<string, unknown>>(path.join(dir, 'intake.json'));
  const bundle = readJson<Bundle>(path.join(dir, 'bundle.json'));
  const stages: StageView[] = (m.stages ?? []).map((s) => ({
    stage: s.stage,
    status: s.status,
    model: s.model ?? '',
    costUsd: s.cost_usd ?? 0,
    issues: (s.attempts ?? []).flatMap((a) => (a.qa_issues ?? []).map((q) => `${q.check}: ${q.message}`)),
    hasOutput: Boolean(s.output_file),
  }));
  return {
    id,
    summary,
    manifest: m,
    stages,
    intakeBusiness: (typeof intake?.A1 === 'string' ? intake.A1 : '') || summary.business,
    intakeEmail: typeof intake?._customer_email === 'string' ? intake._customer_email : '',
    complianceLine: bundle?.compliance_line ?? '',
  };
}

/** Parsed deliverable JSON for one stage (for the in-browser pack view). */
export function readDeliverable(runsDir: string, id: string, stage: string): unknown | null {
  const s = stage.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!/^s[0-9]+$/.test(s)) return null; // guard against path traversal
  return readJson<unknown>(path.join(runsDir, id, `${s}.json`));
}

/** Read every order from the append-only orders.jsonl (newest first). */
export function listOrders(ordersFile: string): Order[] {
  if (!fs.existsSync(ordersFile)) return [];
  const orders: Order[] = [];
  for (const line of fs.readFileSync(ordersFile, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { orders.push(JSON.parse(line) as Order); } catch { /* skip malformed */ }
  }
  return orders.reverse();
}
