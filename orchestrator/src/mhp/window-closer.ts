/**
 * Closes the webinar price at the cut-over. New window checkouts already stop at
 * the window end (the server picks the price). Stripe expires checkouts created
 * more than 31 minutes before the end on its own; this expires the rest exactly
 * at the end, then re-checks every minute for 25 hours (the longest a checkout
 * created before the end can stay open).
 */
export interface MhpWindowCloserSource {
  readonly billingEnabled: boolean;
  readonly windowEndsAt: number | null;
  expireWindowCheckouts(): Promise<{ expired: number; stillOpen: number }>;
}
export interface MhpWindowCloserOptions {
  now?: () => number;
  intervalMs?: number;
  onResult?: (result: { expired: number; stillOpen: number; failed: boolean }) => void;
}
const CLOSING_PERIOD_MS = 25 * 60 * 60_000;

export function startMhpWindowCloser(commerce: MhpWindowCloserSource, options: MhpWindowCloserOptions = {}): () => void {
  const end = commerce.windowEndsAt;
  if (!commerce.billingEnabled || end === null) return () => undefined;
  const now = options.now ?? Date.now;
  const intervalMs = options.intervalMs ?? 60_000;
  if (now() > end + CLOSING_PERIOD_MS) return () => undefined;
  let stopped = false, running: Promise<void> | null = null;
  const run = (): Promise<void> => {
    if (running || stopped || now() < end) return running ?? Promise.resolve();
    running = commerce.expireWindowCheckouts()
      .then(result => { try { options.onResult?.({ ...result, failed: false }); } catch { /* telemetry only */ } })
      .catch(() => { try { options.onResult?.({ expired: 0, stillOpen: 0, failed: true }); } catch { /* telemetry only */ } })
      .finally(() => { running = null; });
    return running;
  };
  // setTimeout is capped at about 24.8 days; the interval below covers anything later.
  const delay = Math.max(0, end - now());
  const exact = delay < 2 ** 31 - 1 ? setTimeout(() => { void run(); }, delay) : null;
  exact?.unref();
  const timer = setInterval(() => {
    if (now() > end + CLOSING_PERIOD_MS) { clearInterval(timer); return; }
    void run();
  }, intervalMs);
  timer.unref();
  void run();
  return () => { stopped = true; if (exact) clearTimeout(exact); clearInterval(timer); };
}
