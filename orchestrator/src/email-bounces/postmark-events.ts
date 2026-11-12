/**
 * Pure reading of Postmark's bounce, spam-complaint and subscription-change
 * records, from a webhook or from its API. Nothing here does IO.
 */

import { normalizeBounceEmail, type EmailFactKind } from './policy.js';

/**
 * Postmark bounce IDs can be larger than a JavaScript number holds exactly, so
 * the ID is kept as text before the JSON is parsed: two different bounces must
 * never collapse into one idempotency key.
 */
export function parsePostmarkJson(text: string): unknown {
  return JSON.parse(text.replace(/("ID"\s*:\s*)(\d{1,30})(?=\s*[,}])/gu, '$1"$2"'));
}

const HARD = new Set(['HardBounce', 'BadEmailAddress']);
/**
 * Only failures that say something about the ADDRESS count towards the repeated-soft-bounce block.
 * 'Blocked' and 'SpamNotification' are a receiving provider refusing the sender or the content: one bad day at
 * a large mailbox provider would otherwise block every one of its (working) addresses for a month.
 */
const SOFT = new Set(['SoftBounce', 'DnsError', 'Unknown']);
const MANUAL = new Set(['ManuallyDeactivated', 'Unsubscribe']);

/** Maps a Postmark bounce Type to what it means for the address. Null means "nothing to act on". */
export function classifyPostmarkBounce(type: unknown, inactive: unknown): EmailFactKind | null {
  if (type === 'SpamComplaint') return 'spam_complaint';
  if (typeof type === 'string' && HARD.has(type)) return 'hard_bounce';
  if (typeof type === 'string' && MANUAL.has(type)) return 'unsubscribed';
  if (typeof type === 'string' && SOFT.has(type)) return 'soft_bounce';
  // Transient, AutoResponder, AddressChange, DMARCPolicy, template and API errors say
  // nothing about the address unless Postmark itself switched the address off.
  return inactive === true ? 'hard_bounce' : null;
}

export function classifyPostmarkSuppression(reason: unknown): Exclude<EmailFactKind, 'soft_bounce'> | null {
  if (reason === 'HardBounce') return 'hard_bounce';
  if (reason === 'SpamComplaint') return 'spam_complaint';
  if (reason === 'ManualSuppression') return 'unsubscribed';
  return null;
}

export interface PostmarkAddressEvent {
  /** Stable idempotency key within one Postmark server. */
  readonly eventId: string;
  readonly kind: EmailFactKind | 'resubscribed';
  readonly email: string;
  readonly stream: string;
  readonly serverId: string | null;
  readonly at: number;
  /** Only short string values we wrote ourselves when sending. */
  readonly metadata: Readonly<Record<string, string>>;
  /**
   * False for a subscription change: Postmark sends one alongside the bounce or complaint that caused
   * it, so it changes who is blocked but must not be counted as a second bounce.
   */
  readonly counts: boolean;
}
export type PostmarkWebhookReading =
  | { readonly outcome: 'event'; readonly event: PostmarkAddressEvent }
  | { readonly outcome: 'ignored'; readonly why: 'record_type' | 'bounce_type' | 'suppression_reason' }
  | { readonly outcome: 'invalid' };

const STREAM = /^[a-z0-9-]{1,60}$/u;
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function instant(value: unknown): number | null {
  if (typeof value !== 'string' || value.length > 64) return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : null;
}
function identifier(value: unknown): string | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  return typeof value === 'string' && /^[A-Za-z0-9-]{1,64}$/u.test(value) ? value : null;
}
function metadata(value: unknown): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  if (record(value)) {
    for (const [key, entry] of Object.entries(value).slice(0, 20)) {
      if (typeof entry === 'string' && /^[A-Za-z0-9_-]{1,40}$/u.test(key) && entry.length <= 200) out[key] = entry;
    }
  }
  return Object.freeze(out);
}

/** Reads one webhook body that has already been authenticated and parsed. */
export function readPostmarkWebhook(payload: unknown): PostmarkWebhookReading {
  if (!record(payload) || typeof payload.RecordType !== 'string') return { outcome: 'invalid' };
  const stream = typeof payload.MessageStream === 'string' && STREAM.test(payload.MessageStream) ? payload.MessageStream : null;
  const serverId = identifier(payload.ServerID);
  if (payload.RecordType === 'Bounce' || payload.RecordType === 'SpamComplaint') {
    const email = normalizeBounceEmail(payload.Email), id = identifier(payload.ID), at = instant(payload.BouncedAt);
    if (!stream || !email || !id || at === null) return { outcome: 'invalid' };
    let kind = payload.RecordType === 'SpamComplaint' ? 'spam_complaint' : classifyPostmarkBounce(payload.Type, payload.Inactive);
    if (!kind) return { outcome: 'ignored', why: 'bounce_type' };
    // Postmark says it did NOT switch the address off, so it will keep sending and its list will not show it.
    // Blocking every email and stopping the person for good on that would outlive Postmark's own view: count it instead.
    if (kind === 'hard_bounce' && payload.Inactive === false) kind = 'soft_bounce';
    return { outcome: 'event', event: Object.freeze({ eventId: `bounce:${id}`, kind, email, stream, serverId, at, metadata: metadata(payload.Metadata), counts: true }) };
  }
  if (payload.RecordType === 'SubscriptionChange') {
    const email = normalizeBounceEmail(payload.Recipient), at = instant(payload.ChangedAt);
    if (!stream || !email || at === null || typeof payload.SuppressSending !== 'boolean') return { outcome: 'invalid' };
    const kind = payload.SuppressSending ? classifyPostmarkSuppression(payload.SuppressionReason) : 'resubscribed';
    if (!kind) return { outcome: 'ignored', why: 'suppression_reason' };
    // Postmark gives a subscription change no ID of its own.
    return { outcome: 'event', event: Object.freeze({ eventId: `subscription:${stream}:${email}:${at}:${payload.SuppressSending ? kind : 'on'}`,
      kind, email, stream, serverId, at, metadata: metadata(payload.Metadata), counts: false }) };
  }
  // Delivery, open and click records carry nothing this handler acts on.
  return { outcome: 'ignored', why: 'record_type' };
}

export interface PostmarkBounceRow { readonly id: string; readonly kind: EmailFactKind; readonly email: string; readonly at: number }
/** One row of GET /bounces. Rows that say nothing about the address return null. */
export function readPostmarkBounceRow(row: unknown): PostmarkBounceRow | null {
  if (!record(row)) return null;
  const id = identifier(row.ID), email = normalizeBounceEmail(row.Email), at = instant(row.BouncedAt);
  const kind = classifyPostmarkBounce(row.Type, row.Inactive);
  return id && email && at !== null && kind ? Object.freeze({ id, kind, email, at }) : null;
}

export interface PostmarkSuppressionRow { readonly email: string; readonly kind: Exclude<EmailFactKind, 'soft_bounce'>; readonly at: number | null }
/** One row of the suppression dump for a message stream. */
export function readPostmarkSuppressionRow(row: unknown): PostmarkSuppressionRow | null {
  if (!record(row)) return null;
  const email = normalizeBounceEmail(row.EmailAddress), kind = classifyPostmarkSuppression(row.SuppressionReason);
  return email && kind ? Object.freeze({ email, kind, at: instant(row.CreatedAt) }) : null;
}
