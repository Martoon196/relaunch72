/**
 * Property Predator follow-up email: one sweep a minute, choosing the sender afresh every sweep.
 *
 * With a stored email connection in charge (connected, and its mode test or live: see email-protection/sending.ts)
 * the business's own Postmark server token, sender, reply-to and Broadcast stream are used, its real name and postal
 * address are printed in every email, and every send is reserved in the database first (caps, warm-up, sample,
 * pauses, the account hold). A hold claims nothing. Without one, the environment-configured sender runs exactly as it
 * did before this release, and with no environment sender nothing is sent.
 */
import { createPpPostmarkSender, type PpFollowupSender, type PpRecipientGuard } from './mail.js';
import { dispatchPpFollowupEmails, type PpFollowupDispatchResult } from './dispatch.js';
import type { PpMarketingConfig } from './config.js';
import type { PpFollowupQueue } from './repository.js';
import { leaseSendKey, type SendingPlan } from '../email-protection/sending.js';
import type { EmailProtectionStore } from '../email-protection/store.js';

export interface PpFollowupDeliveryInput {
  readonly queue: PpFollowupQueue;
  readonly unsubscribeSecret: string;
  /** Today's environment-configured sender (PP_MARKETING_MODE test or live and complete), when there is one. */
  readonly env?: { readonly sender: PpFollowupSender; readonly config: PpMarketingConfig; readonly recipients?: PpRecipientGuard; readonly onSenderRefused?: () => void };
  /** The stored connection (0156), read every sweep. Absent: the environment sender only. */
  readonly connection?: {
    readonly plan: () => Promise<SendingPlan>;
    readonly store: Pick<EmailProtectionStore, 'reserve' | 'settle'> & Partial<Pick<EmailProtectionStore, 'holdWait'>>;
    readonly link: string;
    readonly unsubscribeOrigin: string;
    readonly recipients?: PpRecipientGuard;
    readonly fetcher?: typeof fetch;
    readonly onHold?: (reason: string) => void;
    /** Told after a sweep that sent live email (the sample may now be full). */
    readonly afterSend?: (workspaceId: string) => void;
  };
  readonly now?: () => number;
}

export type PpDeliveryOutcome = PpFollowupDispatchResult & { readonly sender: 'env' | 'connection' | 'hold' | 'none'; readonly hold?: string };

export async function runPpFollowupDelivery(input: PpFollowupDeliveryInput, stopped: () => boolean = () => false): Promise<PpDeliveryOutcome> {
  const none = { sent: 0, failed: 0, unknown: 0 };
  const plan: SendingPlan = input.connection ? await input.connection.plan() : { kind: 'env' };
  if (plan.kind === 'env') {
    if (!input.env) return { ...none, sender: 'none' };
    const env = input.env;
    const result = await dispatchPpFollowupEmails({ queue: input.queue, sender: env.sender, unsubscribeSecret: input.unsubscribeSecret, config: env.config, stopped,
      ...(env.recipients ? { recipients: env.recipients } : {}), ...(env.onSenderRefused ? { onSenderRefused: env.onSenderRefused } : {}), ...(input.now ? { now: input.now } : {}) });
    return { ...result, sender: 'env' };
  }
  // A hold claims nothing; held people wait: their retry window is restarted so none fails while held.
  const wait = async () => { try { await input.connection?.store.holdWait?.(); } catch { /* tried again next sweep */ } };
  if (plan.kind === 'hold') { await wait(); return { ...none, sender: 'hold', hold: plan.reason }; }
  const connection = input.connection!;
  const config: PpMarketingConfig = Object.freeze({ mode: plan.mode, token: plan.token, from: plan.from, fromName: plan.fromName, replyTo: plan.replyTo, stream: plan.stream,
    testRecipients: plan.testRecipients, link: connection.link, unsubscribeOrigin: connection.unsubscribeOrigin });
  const sender = createPpPostmarkSender(config, connection.fetcher ?? fetch, connection.recipients, { quotedName: true });
  const purpose = plan.mode === 'live' ? 'live' : 'test';
  let refused: string | null = null;
  const result = await dispatchPpFollowupEmails({ queue: input.queue, sender, unsubscribeSecret: input.unsubscribeSecret, config, stopped, footer: plan.footer,
    ...(connection.recipients ? { recipients: connection.recipients } : {}), ...(input.now ? { now: input.now } : {}),
    allowance: { limit: plan.remaining,
      // A replay of this lease's own reservation is the same reservation.
      reserve: async lease => { const outcome = await connection.store.reserve(plan.workspaceId, leaseSendKey(lease.leaseId, lease.id), purpose); return outcome === 'replayed' ? 'ok' : outcome; },
      settle: (lease, accepted) => connection.store.settle(plan.workspaceId, leaseSendKey(lease.leaseId, lease.id), accepted),
      onHold: reason => { refused = reason; try { connection.onHold?.(reason); } catch { /* telemetry only */ } } } });
  if (refused) await wait();
  if (result.sent > 0) { try { connection.afterSend?.(plan.workspaceId); } catch { /* telemetry only */ } }
  return { ...result, sender: 'connection', ...(refused ? { hold: refused } : {}) };
}

/** One-minute sweeps on the web process. Counts and holds only reach the logs. */
export function startPpFollowupDelivery(input: PpFollowupDeliveryInput, options: { intervalMs?: number; onResult?: (result: PpDeliveryOutcome) => void; onError?: () => void } = {}): () => void {
  let stopped = false, running = false;
  const runOnce = async (): Promise<void> => {
    if (running || stopped) return;
    running = true;
    try {
      const result = await runPpFollowupDelivery(input, () => stopped);
      try { options.onResult?.(result); } catch { /* telemetry only */ }
    } catch { try { options.onError?.(); } catch { /* telemetry only */ } }
    finally { running = false; }
  };
  void runOnce();
  const timer = setInterval(() => { void runOnce(); }, options.intervalMs ?? 60_000);
  timer.unref();
  return () => { stopped = true; clearInterval(timer); };
}
