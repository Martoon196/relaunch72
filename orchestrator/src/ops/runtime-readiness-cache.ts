export interface CachedRuntimeReadinessOptions {
  readonly probe: () => Promise<readonly string[]>;
  readonly timeoutMs?: number;
  readonly successTtlMs?: number;
  readonly failureTtlMs?: number;
  readonly now?: () => number;
}

function safeBlockers(value: readonly string[]): readonly string[] {
  if (!Array.isArray(value) || value.some((item) =>
    typeof item !== 'string' || item.length < 1 || item.length > 240
      || /[\r\n\u0000]/u.test(item))) {
    return Object.freeze(['Runtime readiness returned invalid evidence']);
  }
  return Object.freeze([...value]);
}

/**
 * Deduplicate health-check traffic and bound each live database probe. Failures
 * are reduced to a fixed safe label; provider/database messages never escape.
 */
export function createCachedRuntimeReadinessProbe(
  options: CachedRuntimeReadinessOptions,
): () => Promise<readonly string[]> {
  const timeoutMs = options.timeoutMs ?? 3_000;
  const successTtlMs = options.successTtlMs ?? 10_000;
  const failureTtlMs = options.failureTtlMs ?? 1_000;
  const now = options.now ?? Date.now;
  if (![timeoutMs, successTtlMs, failureTtlMs].every((value) =>
    Number.isSafeInteger(value) && value >= 1 && value <= 60_000)) {
    throw new Error('Runtime readiness cache bounds are invalid');
  }

  let cached: Readonly<{ blockers: readonly string[]; expiresAt: number }> | undefined;
  let inFlight: Promise<readonly string[]> | undefined;
  return async (): Promise<readonly string[]> => {
    const timestamp = now();
    if (cached && cached.expiresAt > timestamp) return cached.blockers;
    if (inFlight) return inFlight;
    inFlight = (async () => {
      let timer: NodeJS.Timeout | undefined;
      try {
        const timeout = new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error('runtime readiness timeout')),
            timeoutMs,
          );
          timer.unref?.();
        });
        const blockers = safeBlockers(await Promise.race([options.probe(), timeout]));
        cached = Object.freeze({
          blockers,
          expiresAt: now() + (blockers.length === 0 ? successTtlMs : failureTtlMs),
        });
        return blockers;
      } catch {
        const blockers = Object.freeze(['Protected runtime readiness probe failed']);
        cached = Object.freeze({ blockers, expiresAt: now() + failureTtlMs });
        return blockers;
      } finally {
        if (timer) clearTimeout(timer);
        inFlight = undefined;
      }
    })();
    return inFlight;
  };
}
