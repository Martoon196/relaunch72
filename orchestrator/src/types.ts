/**
 * Shared pipeline types. Field IDs (A1–H4) and stage schemas are canonical in
 * the Notion Deep Intake / Pipeline specs — these types mirror them.
 */

/** A raw intake keyed by canonical field IDs (A1…H4), as delivered by the intake webhook. */
export type FieldValue = string | number | boolean | string[] | Record<string, unknown> | null;
export type Intake = Record<string, FieldValue>;

export interface QAIssue {
  /** Machine name of the check, e.g. "s2.verbatim_not_in_c2" */
  check: string;
  /** Human/critique-facing description of exactly what failed. */
  message: string;
  /**
   * No-invention violations (fabricated testimonials/stats/credentials) are
   * fatal: the run parks for the human queue IMMEDIATELY, with no retry
   * (Pipeline Spec, Global QA principle 2).
   */
  fatal?: boolean;
}

export interface S0FieldIssue {
  field: string;
  label: string;
  reason: string;
}

export interface S0Result {
  accepted: boolean;
  /** 'accept' starts the 72h clock (M3); 'nudge' triggers the one automated email listing thin fields. */
  action: 'accept' | 'nudge';
  issues: S0FieldIssue[];
  checked_at: string;
}

export interface StageAttempt {
  attempt: number;
  started_at: string;
  raw_output_file: string;
  tokens_in: number;
  tokens_out: number;
  duration_ms: number;
  stop_reason: string | null;
  schema_errors: string[];
  qa_issues: QAIssue[];
}

export type StageStatus = 'passed' | 'parked' | 'skipped';

export interface StageRecord {
  stage: string;
  status: StageStatus;
  prompt_file: string;
  prompt_version: string;
  prompt_sha256: string;
  model: string;
  attempts: StageAttempt[];
  cost_usd: number;
  output_file: string | null;
  /** Park reasons / warnings for the human queue. */
  flags: string[];
}

/** S10 assembly & strategist gate — global lint + package, no LLM call. */
export interface S10Result {
  /** Cross-doc lint findings — strategist-gate flags, never auto-retried. */
  issues: QAIssue[];
  package_file: string | null;
  review_file: string | null;
  status: 'awaiting_signoff';
  assembled_at: string;
}

export type SignoffDecision = 'approved' | 'sent_back';

/** The human QA gate's recorded verdict on an assembled pack (LS-19). */
export interface Signoff {
  decision: SignoffDecision;
  /** Who signed off (defaults to the founder). */
  by: string;
  at: string;
  run_id: string;
  /** On approval: every QA flag the founder saw and accepted (audit trail). */
  acknowledged_flags?: string[];
  /** On send-back: which stages to redo and the strategist note that drives the re-run. */
  send_back?: { stages: string[]; notes: string };
}

export interface RunManifest {
  run_id: string;
  /** Fixture name or input path this run was fed from. */
  source: string;
  mode: 'live' | 'mock';
  through: string;
  created_at: string;
  finished_at: string | null;
  status: 'running' | 'completed' | 'nudge_required' | 'parked' | 'error';
  s0: S0Result | null;
  stages: StageRecord[];
  /** Present only when the run reached S9 and assembly ran. */
  s10: S10Result | null;
  totals: { tokens_in: number; tokens_out: number; cost_usd: number };
  environment: { node: string; orchestrator_version: string };
}
