import type { MhpWelcomeJob, PgMhpCommerceService } from './commerce-service.js';
import { MhpWelcomeDeliveryError, type MhpTransactionalMailer } from './transactional-mail.js';

type Queue = Pick<PgMhpCommerceService, 'billingEnabled' | 'claimPurchaseWelcome' | 'beginPurchaseWelcome' | 'settlePurchaseWelcome'>;
type Mailer = Pick<MhpTransactionalMailer, 'configured' | 'sendPurchaseWelcome'>;

/** Only explicit provider rejection is retryable. Lost acknowledgements stay held. */
export async function dispatchMhpPurchaseWelcome(queue: Queue, mail: Mailer): Promise<'idle' | 'sent' | 'rejected' | 'unknown'> {
  if (!queue.billingEnabled || !mail.configured || !mail.sendPurchaseWelcome) return 'idle';
  const job: MhpWelcomeJob | null = await queue.claimPurchaseWelcome();
  if (!job || !await queue.beginPurchaseWelcome(job)) return 'idle';
  let result: 'sent' | 'rejected' | 'unknown' = 'unknown';
  try {
    await mail.sendPurchaseWelcome(job.email, job.name.slice(0, 200), job.productName, job.kind);
    result = 'sent';
  } catch (error) {
    result = error instanceof MhpWelcomeDeliveryError ? error.outcome : 'unknown';
  }
  // If settlement fails, leave calling durable; expiry holds it as unknown.
  await queue.settlePurchaseWelcome(job, result);
  return result;
}

export function startMhpPurchaseWelcomes(queue: Queue, mail: Mailer, onError: () => void): () => void {
  let stopped = false, running = false;
  const run = async () => {
    if (stopped || running) return;
    running = true;
    try {
      for (let i = 0; i < 8 && !stopped; i++) {
        const result = await dispatchMhpPurchaseWelcome(queue, mail);
        if (result === 'idle') break;
        if (result !== 'sent') onError();
      }
    } catch { onError(); } finally { running = false; }
  };
  const timer = setInterval(() => { void run(); }, 15_000);
  timer.unref();
  void run();
  return () => { stopped = true; clearInterval(timer); };
}
