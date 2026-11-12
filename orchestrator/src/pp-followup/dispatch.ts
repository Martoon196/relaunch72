import type { PpMarketingConfig } from './config.js';
import { ppUnsubscribeUrl, renderPpFollowupEmail } from './content.js';
import type { PpFollowupSender } from './mail.js';
import type { PpFollowupQueue } from './repository.js';

export interface PpFollowupDispatchInput {
  readonly queue: PpFollowupQueue; readonly sender: PpFollowupSender; readonly unsubscribeSecret: string;
  readonly config: Pick<PpMarketingConfig, 'testRecipients' | 'link' | 'unsubscribeOrigin' | 'fromName'>;
  readonly stopped?: () => boolean; readonly now?: () => number;
}

/**
 * Same phases as the MHP sequence dispatcher. Before a dispatch proof exists a failure is only a missed
 * attempt (the lease expires and the step is claimed again). After the proof, any failure is an unknown
 * outcome: the run is held for an explicit owner decision and never retried silently or marked sent.
 */
export async function dispatchPpFollowupEmails(input: PpFollowupDispatchInput): Promise<{ sent: number; failed: number; unknown: number }> {
  let sent = 0, failed = 0, unknown = 0;
  for (let page = 0; page < 4 && !input.stopped?.(); page++) {
    const batch = await input.queue.claim(25, 120, input.config.testRecipients);
    for (const lease of batch) {
      if (input.stopped?.()) break;
      let proofIssued = false;
      try {
        const prepared = await input.queue.prepare(lease);
        if (!prepared) continue;
        proofIssued = true;
        if (Date.parse(prepared.leaseUntil) <= (input.now?.() ?? Date.now()) + 11_000) throw new Error('PP follow-up proof is expiring');
        const unsubscribe = ppUnsubscribeUrl(input.config.unsubscribeOrigin, input.unsubscribeSecret, prepared.contactPointId);
        const rendered = renderPpFollowupEmail({ canonicalContent: prepared.canonicalContent, contentSha256: prepared.contentSha256,
          displayName: prepared.displayName, label: input.config.fromName, link: input.config.link, unsubscribe,
          productName: input.config.fromName, unsubscribeOrigin: input.config.unsubscribeOrigin });
        const reference = await input.sender.sendRendered({ id: prepared.id, email: prepared.email, tag: 'pp_followup', rendered });
        await input.queue.settle(lease, true, reference); sent++;
      } catch {
        if (proofIssued) { unknown++; try { await input.queue.unknown(lease); } catch { /* the unresolved proof still fences a retry */ } }
        else failed++;
      }
    }
    if (batch.length < 25) break;
  }
  return { sent, failed, unknown };
}

/** One-minute sweeps on the web process, like MHP. Counts only reach the logs. */
export function startPpFollowupDispatcher(input: Omit<PpFollowupDispatchInput, 'stopped'>, options: { intervalMs?: number;
  onResult?: (result: { sent: number; failed: number; unknown: number }) => void; onError?: () => void } = {}): () => void {
  let stopped = false, running = false;
  const runOnce = async (): Promise<void> => {
    if (running || stopped) return;
    running = true;
    try {
      const result = await dispatchPpFollowupEmails({ ...input, stopped: () => stopped });
      if (result.sent || result.failed || result.unknown) { try { options.onResult?.(result); } catch { /* telemetry only */ } }
    } catch { try { options.onError?.(); } catch { /* telemetry only */ } }
    finally { running = false; }
  };
  void runOnce();
  const timer = setInterval(() => { void runOnce(); }, options.intervalMs ?? 60_000);
  timer.unref();
  return () => { stopped = true; clearInterval(timer); };
}
