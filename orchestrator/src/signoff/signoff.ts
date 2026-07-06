/**
 * Founder sign-off — the human QA gate (LS-19). Pure decision logic, so the
 * IO-free part is fully testable. Every assembled pack (bundle.json, status
 * `awaiting_signoff`) must pass through here before delivery: the founder
 * either APPROVES (and every QA flag they saw is recorded as acknowledged) or
 * SENDS BACK named stages with a strategist note. Nothing ships un-signed.
 */

import type { Signoff, SignoffDecision } from '../types.js';

export interface BundleLike {
  run_id: string;
  business: string;
  mode: 'live' | 'mock';
  status: string;
  deliverables: Array<{ stage: string; name: string; file: string }>;
  qa: {
    stage_flags?: Record<string, string[]>;
    s10_issues?: Array<{ check: string; message: string }>;
  };
}

/** Every QA flag on the pack, flattened to one human-readable list. */
export function allFlags(bundle: BundleLike): string[] {
  const stage = Object.entries(bundle.qa?.stage_flags ?? {}).flatMap(([s, fs]) => fs.map((f) => `${s}: ${f}`));
  const s10 = (bundle.qa?.s10_issues ?? []).map((i) => `${i.check}: ${i.message}`);
  return [...stage, ...s10];
}

export function bundleStatusFor(decision: SignoffDecision): 'approved' | 'sent_back' {
  return decision === 'approved' ? 'approved' : 'sent_back';
}

export interface ApproveOpts { by: string; at: string; force?: boolean }
export interface SendBackOpts { by: string; at: string; stages: string[]; notes: string }

export class SignoffError extends Error {}

/**
 * Approve the pack. Blocks a mock run unless forced (mock output is synthetic —
 * never quality-reviewable, must never be recorded as shippable by accident).
 * Records every QA flag as acknowledged so an approval-over-flags is auditable.
 */
export function approve(bundle: BundleLike, opts: ApproveOpts): Signoff {
  if (bundle.mode === 'mock' && !opts.force) {
    throw new SignoffError('this is a MOCK run — synthetic output, not for real sign-off. Re-run --approve with --force only if you truly mean to.');
  }
  return {
    decision: 'approved',
    by: opts.by,
    at: opts.at,
    run_id: bundle.run_id,
    acknowledged_flags: allFlags(bundle),
  };
}

/**
 * Send the pack back for a targeted re-run. Requires a non-empty note (a gate
 * with no reason is not a gate) and, when stages are named, that each is a real
 * deliverable stage. An empty stage list means "the whole pack" — the note must
 * still say why.
 */
export function sendBack(bundle: BundleLike, opts: SendBackOpts): Signoff {
  if (!opts.notes.trim()) {
    throw new SignoffError('a send-back needs a note saying what to fix — that note drives the re-run.');
  }
  const known = new Set(bundle.deliverables.map((d) => d.stage.toUpperCase()));
  const stages = opts.stages.map((s) => s.toUpperCase());
  const unknown = stages.filter((s) => !known.has(s));
  if (unknown.length) {
    throw new SignoffError(`unknown stage(s): ${unknown.join(', ')} — this pack has ${[...known].join(', ')}.`);
  }
  return {
    decision: 'sent_back',
    by: opts.by,
    at: opts.at,
    run_id: bundle.run_id,
    send_back: { stages, notes: opts.notes.trim() },
  };
}

/** Terminal review summary the founder reads before deciding. */
export function summarize(bundle: BundleLike): string {
  const flags = allFlags(bundle);
  const lines = [
    `Pack: ${bundle.business}  (${bundle.run_id}, ${bundle.mode})`,
    `Status: ${bundle.status}`,
    '',
    `Deliverables (${bundle.deliverables.length}):`,
    ...bundle.deliverables.map((d) => `  ${d.stage}  ${d.name}  →  ${d.file}`),
    '',
    flags.length ? `QA flags to weigh (${flags.length}):` : 'QA flags: none — clean.',
    ...flags.map((f) => `  ⚑ ${f}`),
    '',
    'Decide:  --approve   |   --send-back "<what to fix>" [--stages S6,S7]',
  ];
  return lines.join('\n');
}
