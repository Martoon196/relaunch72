/** A small recovery loop on the existing process, not a new queue/service. */
export interface MhpScheduleReconciliationSource {
  readonly billingEnabled: boolean;
  reconcileScheduleBatch(cursor?: string): Promise<{ nextCursor: string | null; checked: number; failures?: number }>;
}
export interface MhpScheduleReconciliationResult { checked: number; completed: boolean; failures: number }
export interface MhpScheduleReconcilerOptions {
  /** Tests may shorten the interval; production defaults to hourly. */
  intervalMs?: number;
  timeBudgetMs?: number;
  now?: () => number;
  /** Counts only. Provider errors, identifiers and email addresses are never supplied. */
  onResult?: (result: MhpScheduleReconciliationResult) => void;
}
export function createMhpScheduleReconciler(commerce: MhpScheduleReconciliationSource, options: MhpScheduleReconcilerOptions = {}) {
  const now = options.now ?? Date.now;
  const timeBudgetMs = options.timeBudgetMs ?? 25_000;
  if (!Number.isSafeInteger(timeBudgetMs) || timeBudgetMs < 1 || timeBudgetMs > 60_000) throw new Error('Invalid reconciliation time budget');
  let cursor: string | undefined;
  let stopped = false;
  let running: Promise<MhpScheduleReconciliationResult> | null = null;
  const runOnce = (): Promise<MhpScheduleReconciliationResult> => {
    if (running) return running;
    if (stopped || !commerce.billingEnabled) return Promise.resolve({ checked: 0, completed: false, failures: 0 });
    running = (async () => {
      const deadline = now() + timeBudgetMs;
      let checked = 0, failures = 0, completed = false;
      try {
        for (let page = 0; page < 4 && !stopped && now() < deadline; page++) {
          const batch = await commerce.reconcileScheduleBatch(cursor);
          checked += batch.checked; failures += batch.failures ?? 0;
          cursor = batch.nextCursor ?? undefined;
          if (!batch.nextCursor) { completed = true; break; }
        }
      } catch {
        // Retain the cursor of the last completed page. Idempotent schedule
        // adoption/cancellation safely retries an interrupted page next hour.
        failures++;
      }
      const result = { checked, completed, failures };
      try { options.onResult?.(result); } catch { /* Telemetry cannot break the recovery loop. */ }
      return result;
    })().finally(() => { running = null; });
    return running;
  };
  return { runOnce, stop(): void { stopped = true; } };
}

/** Startup + hourly sweeps. Stop prevents additional pages; a bounded in-flight API call may finish. */
export function startMhpScheduleReconciler(commerce: MhpScheduleReconciliationSource, options: MhpScheduleReconcilerOptions = {}): () => void {
  if (!commerce.billingEnabled) return () => undefined;
  const intervalMs = options.intervalMs ?? 60 * 60_000;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1_000 || intervalMs > 24 * 60 * 60_000) throw new Error('Invalid reconciliation interval');
  const runner = createMhpScheduleReconciler(commerce, options);
  void runner.runOnce();
  const timer = setInterval(() => { void runner.runOnce(); }, intervalMs);
  timer.unref();
  return () => { clearInterval(timer); runner.stop(); };
}
