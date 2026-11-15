/**
 * Which sender a business's marketing email uses this sweep, read fresh from the database every sweep.
 *
 *   'env'         ONLY while the business has never put its stored connection in charge: no connection row at all, or
 *                 a row whose mode is still 'off', that the founder never approved, with no hold of any kind (protection
 *                 ok, no owner pause, no sample begun). Then exactly today's environment-configured sender.
 *   'connection'  the stored connection is connected (both records verified by Postmark) and its mode is test or live,
 *                 with nothing holding it. Its unsealed server token, sender, reply-to and Broadcast stream are used,
 *                 every email carries the business's real name and postal address and the unsubscribe link, and every
 *                 send is reserved first against the caps and holds in the database.
 *   'hold'        everything else: once a business has put its own connection in charge (test or live mode, a founder
 *                 approval, or any hold), the environment sender never takes over again by itself. A connection that is
 *                 not connected right now ('not_connected'), paused, switched off, waiting for approval or a test, at its
 *                 cap, or switched off on this deployment holds. Nothing is claimed; held people wait (their retry
 *                 window is restarted while held: pp_followup_hold_wait) and go when the hold lifts.
 */
import type { EmailConnectionVault } from '../email-connections/vault.js';
import { normalizePpEmail } from '../pp-followup/config.js';
import type { EmailProtectionStore, ReserveOutcome, SendingConfig } from './store.js';

export type HoldReason = Exclude<ReserveOutcome, 'ok' | 'replayed' | 'daily_cap' | 'hourly_cap' | 'test_limit'> | 'cap' | 'needs_footer' | 'unreadable' | 'unavailable'
  | 'switched_off_here';

export interface ConnectionSending {
  readonly kind: 'connection';
  readonly workspaceId: string;
  readonly mode: 'test' | 'live';
  readonly token: string;
  readonly from: string;
  readonly fromName: string;
  readonly replyTo: string;
  readonly stream: string;
  /** Test mode: only these addresses (the default test address when none were entered). */
  readonly testRecipients: readonly string[] | null;
  readonly footer: { readonly businessName: string; readonly postalAddress: string };
  /** How many marketing emails may still go now (the smaller of the daily and hourly allowance). */
  readonly remaining: number;
}
export type SendingPlan = { readonly kind: 'env' } | { readonly kind: 'hold'; readonly reason: HoldReason; readonly workspaceId: string } | ConnectionSending;

/** At most this many test-mode emails a sweep (the database allows 20 an hour to the test list). */
const TEST_SWEEP = 20;

/** True while the business has never put its own connection in charge (the only time the environment sender may run). */
export function neverInCharge(config: SendingConfig): boolean {
  return config.mode === 'off' && !config.goLiveApprovedAt && config.protectionState === 'ok' && !config.ownerPaused && config.sampleState === 'none';
}

/**
 * The decision without opening the token (for pages): 'env', 'hold' with its reason, or 'connection' with the mode.
 * allowed=false: the deployment's switches (EMAIL_CONNECT not enabled, or bounce handling off) do not let a stored
 * connection send here: it holds.
 */
export function sendingDecision(config: SendingConfig | null, options: { allowed?: boolean } = {}):
  { readonly kind: 'env' } | { readonly kind: 'hold'; readonly reason: HoldReason } | { readonly kind: 'connection'; readonly mode: 'test' | 'live'; readonly remaining: number } {
  if (!config || neverInCharge(config)) return { kind: 'env' };
  if (config.protectionState === 'off') return { kind: 'hold', reason: 'off' };
  if (config.status !== 'verified') return { kind: 'hold', reason: 'not_connected' };
  if (options.allowed === false) return { kind: 'hold', reason: 'switched_off_here' };
  if (config.mode === 'off') return { kind: 'hold', reason: config.protectionState === 'paused' ? 'paused' : 'not_live' };
  if (config.ownerPaused) return { kind: 'hold', reason: 'owner_paused' };
  if (!config.businessName || !config.postalAddress) return { kind: 'hold', reason: 'needs_footer' };
  if (config.mode === 'live') {
    if (config.accountHeld) return { kind: 'hold', reason: 'account_held' };
    if (config.protectionState === 'paused') return { kind: 'hold', reason: 'paused' };
    if (!config.approvedCurrent) return { kind: 'hold', reason: 'not_approved' };
    if (!config.testCurrent) return { kind: 'hold', reason: 'needs_test' };
    if (config.sampleState === 'held') return { kind: 'hold', reason: 'sample_held' };
    if (config.sampleState === 'waiting') return { kind: 'hold', reason: 'sample_wait' };
  } else if (!config.testRecipients.some(address => normalizePpEmail(address))) return { kind: 'hold', reason: 'not_live' };
  const remaining = config.mode === 'live' ? Math.max(0, Math.min(config.dailyCap - config.liveDay, config.hourlyCap - config.liveHour)) : TEST_SWEEP;
  if (remaining === 0) return { kind: 'hold', reason: 'cap' };
  return { kind: 'connection', mode: config.mode, remaining };
}

export function sendingPlan(config: SendingConfig | null, vault: EmailConnectionVault | null, options: { allowed?: boolean } = {}): SendingPlan {
  const decision = sendingDecision(config, options);
  if (decision.kind === 'env') return decision;
  const ws = config!.workspaceId;
  if (decision.kind === 'hold') return { kind: 'hold', reason: decision.reason, workspaceId: ws };
  const c = config!;
  const from = normalizePpEmail(c.fromAddress ?? ''), replyTo = normalizePpEmail(c.replyTo ?? c.fromAddress ?? '');
  if (!from || !replyTo || !c.fromName || !c.sealedServerToken || !vault) return { kind: 'hold', reason: 'unreadable', workspaceId: ws };
  let token: string;
  try { token = vault.open(ws, 'server_token', c.sealedServerToken); } catch { return { kind: 'hold', reason: 'unreadable', workspaceId: ws }; }
  const tests = c.testRecipients.map(address => normalizePpEmail(address)).filter((address): address is string => Boolean(address));
  return Object.freeze({ kind: 'connection', workspaceId: ws, mode: decision.mode, token, from, fromName: c.fromName, replyTo, stream: c.stream,
    testRecipients: decision.mode === 'test' ? Object.freeze([...new Set(tests)].slice(0, 20)) : null,
    footer: Object.freeze({ businessName: c.businessName!, postalAddress: c.postalAddress! }), remaining: decision.remaining });
}

/** The plan for one workspace, read now. A database that cannot be read holds this sweep (never falls back to env). */
export async function resolveSendingPlan(store: Pick<EmailProtectionStore, 'sendingConfig'>, vault: EmailConnectionVault | null, workspaceId: string,
  options: { allowed?: boolean } = {}): Promise<SendingPlan> {
  let config: SendingConfig | null;
  try { config = await store.sendingConfig(workspaceId); }
  catch { return { kind: 'hold', reason: 'unavailable', workspaceId }; }
  return sendingPlan(config, vault, options);
}

/** One reservation per lease, under a key that carries no address. */
export const leaseSendKey = (leaseId: string, sendId: string): string => `lease:${sendId}:${leaseId}`;
