/**
 * The one check of whether Postmark will tell us about bounces for a stored connection: its bounce webhook, by the id we
 * saved, is listed on its stream and verified. Shared by "Go live" (email-protection/owner.ts) and "Repair bounce
 * reporting" (service.ts). Reads only, except one POST /webhooks/{id}/verify for a listed webhook not shown as verified;
 * a webhook is never created, edited or deleted here.
 */
import { PostmarkAccountError, type PostmarkServerApi, type WebhookTriggerFailure } from './postmark-account-api.js';

/** Why the check did (or did not) confirm the bounce webhook. */
export type WebhookCheckReason = 'listed_verified' | 'verified_after_verify' | 'verified_after_relist' | 'no_webhook_id' | 'no_expected_url' | 'no_token' | 'list_failed'
  | 'not_listed' | 'other_address' | 'verify_failed' | 'verify_unrecognised' | 'verify_error';
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
  /** For an answer to verify that was neither a documented pass nor failure: its HTTP status and sorted top-level key names. */
  readonly answerStatus?: number;
  readonly answerKeys?: readonly string[];
}

const errorFields = (error: unknown): { category: string; httpStatus: number | null } => error instanceof PostmarkAccountError
  ? { category: error.category, httpStatus: error.status } : { category: 'unexpected', httpStatus: null };

/** Whether two webhook addresses are the same place: same scheme, host, port and path (a trailing slash, the host's
 * letter case and a spelled-out default port do not make a different address). Query, fragment or credentials on
 * either side never match. Anything unparseable matches only when the two strings are identical. */
export function sameWebhookAddress(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  try {
    const x = new URL(a), y = new URL(b);
    if (x.username || x.password || y.username || y.password || x.search || y.search || x.hash || y.hash) return false;
    const path = (u: URL) => u.pathname.replace(/\/+$/u, '');
    return x.protocol === y.protocol && x.host === y.host && path(x) === path(y);
  } catch { return false; }
}

/**
 * The stored webhook must be listed at OUR bounce address (expectedUrl). Listed there with Status verified: confirmed.
 * Listed there but unverified, or with no Status field: one verify call, confirmed only on a documented pass; an answer
 * that is neither a pass nor a documented failure is followed by ONE more list, confirmed only if the webhook is now
 * listed there with Status verified. No stored id, no expected address, no token, a failed list, not listed, or listed
 * at another address (no verify then): not confirmed. Never throws.
 */
export async function confirmBounceWebhook(input: { webhookId: number | null; stream: string; expectedUrl: string | null; token: () => Promise<string | null>;
  api: (token: string) => PostmarkServerApi }): Promise<WebhookCheck> {
  if (!input.webhookId) return { confirmed: false, reason: 'no_webhook_id' };
  if (!input.expectedUrl) return { confirmed: false, reason: 'no_expected_url' };
  let token: string | null;
  try { token = await input.token(); } catch { token = null; }
  if (!token) return { confirmed: false, reason: 'no_token' };
  let hooks;
  try { hooks = await input.api(token).listWebhooks(input.stream); }
  catch (error) { return { confirmed: false, reason: 'list_failed', ...errorFields(error) }; }
  const hook = hooks.find(item => item.id === input.webhookId);
  if (!hook) return { confirmed: false, reason: 'not_listed' };
  const statusPresent = hook.statusPresent ?? hook.status !== null;
  // Our id, but Postmark would post somewhere else: that tells us nothing, whatever its Status says.
  if (!sameWebhookAddress(hook.url, input.expectedUrl)) return { confirmed: false, reason: 'other_address', statusPresent };
  if (hook.status === 'verified') return { confirmed: true, reason: 'listed_verified', statusPresent };
  let result;
  try { result = await input.api(token).verifyWebhook(hook.id); }
  catch (error) { return { confirmed: false, reason: 'verify_error', statusPresent, ...errorFields(error) }; }
  if (result.verified) return { confirmed: true, reason: 'verified_after_verify', statusPresent };
  if (result.reason === 'failed') return { confirmed: false, reason: 'verify_failed', statusPresent, failing: result.failing };
  // Not a shape we know: never a pass by itself. Postmark's own list is asked once more.
  const unrecognised = { statusPresent, answerStatus: result.httpStatus, answerKeys: result.answerKeys };
  let again;
  try { again = (await input.api(token).listWebhooks(input.stream)).find(item => item.id === input.webhookId); }
  catch (error) { return { confirmed: false, reason: 'verify_unrecognised', ...unrecognised, ...errorFields(error) }; }
  return again && sameWebhookAddress(again.url, input.expectedUrl) && again.status === 'verified' ? { confirmed: true, reason: 'verified_after_relist', ...unrecognised }
    : { confirmed: false, reason: 'verify_unrecognised', ...unrecognised };
}

/** One structured line: the workspace's short id, the reason and its numbers. No token, secret, URL or address. */
export function webhookCheckLine(event: string, workspaceId: string, check: WebhookCheck): string {
  return JSON.stringify({ event, level: check.confirmed ? 'info' : 'warn', workspace: workspaceId.slice(0, 8), confirmed: check.confirmed, reason: check.reason,
    ...(check.statusPresent === undefined ? {} : { statusPresent: check.statusPresent }),
    ...(check.category === undefined ? {} : { category: check.category, httpStatus: check.httpStatus ?? null }),
    ...(check.failing === undefined ? {} : { failing: check.failing.map(item => ({ trigger: item.trigger, status: item.status })) }),
    ...(check.answerStatus === undefined ? {} : { answerStatus: check.answerStatus, answerKeys: check.answerKeys ?? [] }) });
}
