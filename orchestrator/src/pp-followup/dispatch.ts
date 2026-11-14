import { normalizePpEmail, type PpMarketingConfig } from './config.js';
import { ppUnsubscribeUrl, renderPpFollowupEmail } from './content.js';
import { PpNotSentError, type PpFollowupSender, type PpRecipientGuard } from './mail.js';
import { decideRecipient, type EmailSendDecision } from '../email-bounces/policy.js';
import type { PpFollowupOutcome, PpFollowupQueue } from './repository.js';

export interface PpFollowupDispatchInput {
  readonly queue: PpFollowupQueue; readonly sender: PpFollowupSender; readonly unsubscribeSecret: string;
  readonly config: Pick<PpMarketingConfig, 'testRecipients' | 'link' | 'unsubscribeOrigin' | 'fromName'>;
  readonly stopped?: () => boolean; readonly now?: () => number;
  /** Called once per sweep when Postmark refused the sender itself (bad token, unconfirmed sender, rate limit). */
  readonly onSenderRefused?: () => void;
  /** Addresses that bounced, complained or unsubscribed at Postmark are refused before a dispatch proof is written. */
  readonly recipients?: PpRecipientGuard;
}
export interface PpFollowupDispatchResult { readonly sent: number; readonly failed: number; readonly unknown: number }

/** A lease this close to its end is not handed to the provider: there would be no time left to record the answer. */
const LEASE_MARGIN_MS = 11_000;

/**
 * Same phases as the MHP sequence dispatcher, with definite non-sends told apart from uncertain ones:
 *  - Before a dispatch proof exists nothing is spent. A lease that is about to expire is skipped and an address
 *    that can never be sent to fails its run, both without a proof.
 *  - After the proof, anything that certainly did not reach Postmark (rendering failed, Postmark answered 4xx, the
 *    lease ran short) is settled as a plain failure and retried or failed by the database rules.
 *  - Only a genuinely uncertain result (timeout, network error, 5xx, a lost settlement after acceptance) is an
 *    unknown outcome: the run is held for an explicit owner decision and never retried silently or marked sent.
 * `failed` counts definite non-sends; `unknown` counts held runs.
 */
export async function dispatchPpFollowupEmails(input: PpFollowupDispatchInput): Promise<PpFollowupDispatchResult> {
  let sent = 0, failed = 0, unknown = 0, senderRefused = false;
  const now = () => input.now?.() ?? Date.now();
  const expiring = (leaseUntil: string) => Date.parse(leaseUntil) <= now() + LEASE_MARGIN_MS;
  // Waited for before anything is claimed, so it never eats into a lease. After the first read of Postmark's lists it returns at once.
  await input.recipients?.guard.whenReady();
  for (let page = 0; page < 4 && !input.stopped?.() && !senderRefused; page++) {
    const batch = await input.queue.claim(25, 120, input.config.testRecipients);
    for (const lease of batch) {
      if (input.stopped?.() || senderRefused) break;
      // Checked before any proof: an unspent lease simply runs out and the step is claimed again.
      if (expiring(lease.leaseUntil)) { failed++; continue; }
      const to = normalizePpEmail(lease.email);
      if (!to) { failed++; try { await input.queue.settle(lease, 'undeliverable', null); } catch { /* the lease runs out and the step is looked at again */ } continue; }
      if (input.config.testRecipients && !input.config.testRecipients.includes(to)) { failed++; continue; }
      // Bounced, complained or unsubscribed at Postmark: a definite non-send with no proof spent, the same outcome
      // Postmark's own "inactive recipient" answer would give. The run fails; it is never held as unknown.
      // The durable block list could not be read: nothing is spent, the lease runs out and the step is claimed again later.
      let decision: EmailSendDecision = { blocked: false };
      if (input.recipients) {
        try { decision = await decideRecipient(input.recipients.guard, input.recipients.workspaceId, to, 'marketing'); }
        catch { failed++; continue; }
      }
      if (decision.blocked) {
        failed++; try { await input.queue.settle(lease, 'undeliverable', null); } catch { /* the lease runs out and the step is refused again */ } continue;
      }
      let proofIssued = false, handedOff = false, accepted = false;
      try {
        const prepared = await input.queue.prepare(lease);
        if (!prepared) continue;
        proofIssued = true;
        if (normalizePpEmail(prepared.email) !== to || expiring(prepared.leaseUntil)) throw new PpNotSentError('sender');
        const unsubscribe = ppUnsubscribeUrl(input.config.unsubscribeOrigin, input.unsubscribeSecret, prepared.contactPointId);
        const rendered = renderPpFollowupEmail({ canonicalContent: prepared.canonicalContent, contentSha256: prepared.contentSha256,
          displayName: prepared.displayName, label: input.config.fromName, link: input.config.link, unsubscribe,
          productName: input.config.fromName, unsubscribeOrigin: input.config.unsubscribeOrigin });
        handedOff = true;
        const reference = await input.sender.sendRendered({ id: prepared.id, email: to, tag: 'pp_followup', rendered, contactPointId: prepared.contactPointId });
        accepted = true;
        await input.queue.settle(lease, 'accepted', reference); sent++;
      } catch (error) {
        if (!proofIssued) { failed++; continue; }
        // Certain that nothing went out: Postmark said no, or the failure happened before the provider call.
        const definite: PpFollowupOutcome | null = accepted ? null
          : error instanceof PpNotSentError ? ({ sender: 'deferred', message: 'rejected', recipient: 'undeliverable' } as const)[error.scope]
          : !handedOff ? 'rejected' : null;
        if (definite) {
          try {
            await input.queue.settle(lease, definite, null); failed++;
            if (definite === 'deferred' && handedOff) senderRefused = true;
            continue;
          } catch { /* the result could not be recorded: fall through to the unknown hold */ }
        }
        unknown++;
        try { await input.queue.unknown(lease); } catch { /* the unresolved proof still fences a retry */ }
      }
    }
    if (batch.length < 25) break;
  }
  if (senderRefused) { try { input.onSenderRefused?.(); } catch { /* telemetry only */ } }
  return { sent, failed, unknown };
}

/** One-minute sweeps on the web process, like MHP. Counts only reach the logs. */
export function startPpFollowupDispatcher(input: Omit<PpFollowupDispatchInput, 'stopped'>, options: { intervalMs?: number;
  onResult?: (result: PpFollowupDispatchResult) => void; onError?: () => void } = {}): () => void {
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
