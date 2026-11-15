/**
 * The one check of whether Postmark will tell us about bounces for a stored connection: its bounce webhook, by the id we
 * saved, is listed on its stream and verified. Shared by "Go live" (email-protection/owner.ts) and "Repair bounce
 * reporting" (service.ts). Reads only, except one POST /webhooks/{id}/verify for a listed webhook not shown as verified;
 * a webhook is never created, edited or deleted here.
 */
import { PostmarkAccountError, type PostmarkServerApi, type WebhookTriggerFailure } from './postmark-account-api.js';

/** Why the check did (or did not) confirm the bounce webhook. */
export type WebhookCheckReason = 'listed_verified' | 'verified_after_verify' | 'no_webhook_id' | 'no_token' | 'list_failed' | 'not_listed' | 'verify_failed' | 'verify_error';
export interface WebhookCheck {
  readonly confirmed: boolean;
  readonly reason: WebhookCheckReason;
  /** Whether the listed webhook carried a Status field (only when it was listed). */
  readonly statusPresent?: boolean;
  /** For list_failed / verify_error: the error's category and HTTP status (never Postmark's text). */
  readonly category?: string;
  readonly httpStatus?: number | null;
  /** For verify_failed: the failing triggers and the status codes Postmark reports for them. */
  readonly failing?: readonly WebhookTriggerFailure[];
}

const errorFields = (error: unknown): { category: string; httpStatus: number | null } => error instanceof PostmarkAccountError
  ? { category: error.category, httpStatus: error.status } : { category: 'unexpected', httpStatus: null };

/**
 * Listed with Status verified: confirmed. Listed but unverified, or with no Status field: one verify call, confirmed only
 * when it passes. No stored id, no token, a failed list or not listed: not confirmed. Never throws.
 */
export async function confirmBounceWebhook(input: { webhookId: number | null; stream: string; token: () => Promise<string | null>;
  api: (token: string) => PostmarkServerApi }): Promise<WebhookCheck> {
  if (!input.webhookId) return { confirmed: false, reason: 'no_webhook_id' };
  let token: string | null;
  try { token = await input.token(); } catch { token = null; }
  if (!token) return { confirmed: false, reason: 'no_token' };
  let hooks;
  try { hooks = await input.api(token).listWebhooks(input.stream); }
  catch (error) { return { confirmed: false, reason: 'list_failed', ...errorFields(error) }; }
  const hook = hooks.find(item => item.id === input.webhookId);
  if (!hook) return { confirmed: false, reason: 'not_listed' };
  const statusPresent = hook.statusPresent ?? hook.status !== null;
  if (hook.status === 'verified') return { confirmed: true, reason: 'listed_verified', statusPresent };
  try {
    const result = await input.api(token).verifyWebhook(hook.id);
    return result.verified ? { confirmed: true, reason: 'verified_after_verify', statusPresent }
      : { confirmed: false, reason: 'verify_failed', statusPresent, failing: result.failing };
  } catch (error) { return { confirmed: false, reason: 'verify_error', statusPresent, ...errorFields(error) }; }
}

/** One structured line: the workspace's short id, the reason and its numbers. No token, secret, URL or address. */
export function webhookCheckLine(event: string, workspaceId: string, check: WebhookCheck): string {
  return JSON.stringify({ event, level: check.confirmed ? 'info' : 'warn', workspace: workspaceId.slice(0, 8), confirmed: check.confirmed, reason: check.reason,
    ...(check.statusPresent === undefined ? {} : { statusPresent: check.statusPresent }),
    ...(check.category === undefined ? {} : { category: check.category, httpStatus: check.httpStatus ?? null }),
    ...(check.failing === undefined ? {} : { failing: check.failing.map(item => ({ trigger: item.trigger, status: item.status })) }) });
}
