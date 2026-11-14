/**
 * Which sender a business's marketing email uses this sweep, read fresh from the database every sweep.
 *
 *   'connection'  the stored connection (0155/0156) is in charge: connected (both records verified by Postmark) and
 *                 its mode is test or live. Its unsealed server token, sender, reply-to and Broadcast stream are used,
 *                 every email carries the business's real name and postal address and the unsubscribe link, and every
 *                 send is reserved first against the caps and holds in the database.
 *   'hold'        the stored connection is in charge (or protection has paused or switched it off) but nothing may go
 *                 this sweep; the reason is said plainly. Nothing is claimed, so no attempt is spent and nobody is stopped.
 *   'env'         no usable stored connection (none, not verified, mode off, or the database ends at 0155): exactly
 *                 today's environment-configured sender. A paused or switched-off connection is never bypassed this way.
 */
import type { EmailConnectionVault } from '../email-connections/vault.js';
import { normalizePpEmail } from '../pp-followup/config.js';
import type { EmailProtectionStore, ReserveOutcome, SendingConfig } from './store.js';

export type HoldReason = Exclude<ReserveOutcome, 'ok' | 'daily_cap' | 'hourly_cap' | 'test_limit'> | 'cap' | 'needs_footer' | 'unreadable' | 'unavailable';

export interface ConnectionSending {
  readonly kind: 'connection';
  readonly workspaceId: string;
  readonly mode: 'test' | 'live';
  readonly token: string;
  readonly from: string;
  readonly fromName: string;
  readonly replyTo: string;
  readonly stream: string;
  /** Test mode: only these addresses (the owner's own sign-in address when none were entered). */
  readonly testRecipients: readonly string[] | null;
  readonly footer: { readonly businessName: string; readonly postalAddress: string };
  /** How many marketing emails may still go now (the smaller of the daily and hourly allowance). */
  readonly remaining: number;
}
export type SendingPlan = { readonly kind: 'env' } | { readonly kind: 'hold'; readonly reason: HoldReason; readonly workspaceId: string } | ConnectionSending;

/** At most this many test-mode emails a sweep (the database allows 20 an hour to the test list). */
const TEST_SWEEP = 20;

export function sendingPlan(config: SendingConfig | null, vault: EmailConnectionVault | null): SendingPlan {
  if (!config) return { kind: 'env' };
  const ws = config.workspaceId;
  const inCharge = config.status === 'verified' && (config.mode === 'test' || config.mode === 'live');
  if (!inCharge) return config.protectionState === 'paused' || config.protectionState === 'off' ? { kind: 'hold', reason: config.protectionState, workspaceId: ws } : { kind: 'env' };
  if (config.protectionState === 'off') return { kind: 'hold', reason: 'off', workspaceId: ws };
  if (config.ownerPaused) return { kind: 'hold', reason: 'owner_paused', workspaceId: ws };
  if (!config.businessName || !config.postalAddress) return { kind: 'hold', reason: 'needs_footer', workspaceId: ws };
  if (config.mode === 'live') {
    if (config.accountHeld) return { kind: 'hold', reason: 'account_held', workspaceId: ws };
    if (config.protectionState === 'paused') return { kind: 'hold', reason: 'paused', workspaceId: ws };
    if (config.sampleState === 'held') return { kind: 'hold', reason: 'sample_held', workspaceId: ws };
    if (config.sampleState === 'waiting') return { kind: 'hold', reason: 'sample_wait', workspaceId: ws };
  }
  const from = normalizePpEmail(config.fromAddress ?? ''), replyTo = normalizePpEmail(config.replyTo ?? config.fromAddress ?? '');
  if (!from || !replyTo || !config.fromName || !config.sealedServerToken || !vault) return { kind: 'hold', reason: 'unreadable', workspaceId: ws };
  let token: string;
  try { token = vault.open(ws, 'server_token', config.sealedServerToken); } catch { return { kind: 'hold', reason: 'unreadable', workspaceId: ws }; }
  const tests = config.testRecipients.map(address => normalizePpEmail(address)).filter((address): address is string => Boolean(address));
  if (config.mode === 'test' && tests.length === 0) return { kind: 'hold', reason: 'not_live', workspaceId: ws };
  const remaining = config.mode === 'live' ? Math.max(0, Math.min(config.dailyCap - config.liveDay, config.hourlyCap - config.liveHour)) : TEST_SWEEP;
  if (remaining === 0) return { kind: 'hold', reason: 'cap', workspaceId: ws };
  return Object.freeze({ kind: 'connection', workspaceId: ws, mode: config.mode, token, from, fromName: config.fromName, replyTo, stream: config.stream,
    testRecipients: config.mode === 'test' ? Object.freeze([...new Set(tests)].slice(0, 20)) : null,
    footer: Object.freeze({ businessName: config.businessName, postalAddress: config.postalAddress }), remaining });
}

/** The plan for one workspace, read now. A database that cannot be read holds this sweep (never falls back to env). */
export async function resolveSendingPlan(store: Pick<EmailProtectionStore, 'sendingConfig'>, vault: EmailConnectionVault | null, workspaceId: string): Promise<SendingPlan> {
  let config: SendingConfig | null;
  try { config = await store.sendingConfig(workspaceId); }
  catch { return { kind: 'hold', reason: 'unavailable', workspaceId }; }
  return sendingPlan(config, vault);
}

/** One reservation per lease, under a key that carries no address. */
export const leaseSendKey = (leaseId: string, sendId: string): string => `lease:${sendId}:${leaseId}`;
