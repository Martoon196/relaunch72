/**
 * Recurring-subscription state — the layer that turns Relaunch72 from a one-off
 * pack into a marketing platform with monthly revenue. Structurally decoupled
 * from Stripe (maps `StripeEvent`s, never imports the SDK), so every path here
 * tests with plain objects and no key.
 *
 * The store journals subscription lifecycle by subscription id (last write per
 * id wins, like the order store) and indexes by email so the portal can gate a
 * login on "is this account's subscription active?".
 */

import fs from 'node:fs';
import path from 'node:path';
import type { StripeEvent } from './stripe.js';

/** Stripe's subscription statuses (the ones we act on) + our normalised set. */
export type SubscriptionStatus =
  | 'trialing' | 'active' | 'past_due' | 'canceled'
  | 'unpaid' | 'incomplete' | 'incomplete_expired' | 'paused';

const KNOWN_STATUSES: readonly SubscriptionStatus[] = [
  'trialing', 'active', 'past_due', 'canceled', 'unpaid', 'incomplete', 'incomplete_expired', 'paused',
];

/** Statuses that unlock the platform — an active or trialing subscription. */
const ACTIVE_STATUSES = new Set<SubscriptionStatus>(['active', 'trialing']);

export interface Subscription {
  subscription_id: string;
  customer_id: string | null;
  email: string | null;
  /** Internal plan key (e.g. 'platform_growth') if resolvable, else the price id. */
  plan: string | null;
  status: SubscriptionStatus;
  /** ISO timestamp the current paid period ends, if known. */
  current_period_end: string | null;
  updated_at: string;
}

/** True when the subscription entitles its owner to the platform right now. */
export function isActive(sub: Subscription | null | undefined): boolean {
  return !!sub && ACTIVE_STATUSES.has(sub.status);
}

export interface SubscriptionStore {
  /** Upsert-merge by subscription id; returns the stored (merged) record. */
  record(sub: Subscription): Subscription;
  find(subscriptionId: string): Subscription | null;
  /** Most-recently-updated subscription for an email (case-insensitive), if any. */
  findByEmail(email: string): Subscription | null;
  list(): Subscription[];
}

// ─── event → subscription mapping ────────────────────────────────────────────

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}
function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
function normStatus(s: string): SubscriptionStatus {
  return (KNOWN_STATUSES as readonly string[]).includes(s) ? (s as SubscriptionStatus) : 'incomplete';
}
function isoFromUnix(seconds: number | null): string | null {
  return seconds == null ? null : new Date(seconds * 1000).toISOString();
}

function fromSubscriptionObject(
  o: Record<string, unknown>,
  at: string,
  resolvePlan: (priceId: string) => string | null,
): Subscription | null {
  const id = str(o.id);
  if (!id) return null;
  const items = ((o.items as { data?: unknown })?.data ?? []) as Array<Record<string, unknown>>;
  const first = items[0] ?? {};
  const price = (first.price ?? {}) as Record<string, unknown>;
  const priceId = str(price.id);
  const meta = (o.metadata ?? {}) as Record<string, unknown>;
  // current_period_end sits on the subscription (older API) or on the item (newer).
  const periodEnd = num(o.current_period_end) ?? num(first.current_period_end);
  return {
    subscription_id: id,
    customer_id: str(o.customer) || null,
    email: (str(meta.email) || str(o.customer_email)).toLowerCase() || null,
    plan: priceId ? (resolvePlan(priceId) ?? priceId) : null,
    status: normStatus(str(o.status)),
    current_period_end: isoFromUnix(periodEnd),
    updated_at: at,
  };
}

function fromInvoiceObject(o: Record<string, unknown>, at: string, status: SubscriptionStatus): Subscription | null {
  // Invoice→subscription link: top-level (older API) or under parent (newer API).
  const parent = (o.parent as { subscription_details?: { subscription?: unknown } } | undefined);
  const subId = str(o.subscription) || str(parent?.subscription_details?.subscription);
  if (!subId) return null; // a one-off invoice, not a subscription renewal
  return {
    subscription_id: subId,
    customer_id: str(o.customer) || null,
    email: str(o.customer_email).toLowerCase() || null,
    plan: null,
    status,
    current_period_end: null,
    updated_at: at,
  };
}

/**
 * Map a Stripe subscription-lifecycle event to a Subscription patch, or null for
 * events we don't track. `resolvePlan` turns a Stripe price id into our internal
 * plan key (defaults to leaving the price id as the plan). The store merges the
 * result over any prior record, so the thinner invoice events don't clobber the
 * plan/period we learned from the richer subscription events.
 */
export function subscriptionFromEvent(
  event: StripeEvent,
  at: string,
  resolvePlan: (priceId: string) => string | null = () => null,
): Subscription | null {
  const obj = (event.data?.object ?? {}) as Record<string, unknown>;
  switch (event.type) {
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
      return fromSubscriptionObject(obj, at, resolvePlan);
    case 'invoice.paid':
    case 'invoice.payment_succeeded':
      return fromInvoiceObject(obj, at, 'active');
    case 'invoice.payment_failed':
      return fromInvoiceObject(obj, at, 'past_due');
    default:
      return null;
  }
}

/**
 * Build a price-id → plan-key resolver from the config's plan map, so webhook
 * events record the internal plan key rather than an opaque Stripe price id.
 */
export function planResolver(planIds: Record<string, string>): (priceId: string) => string | null {
  const reverse = new Map<string, string>();
  for (const [key, id] of Object.entries(planIds)) if (id) reverse.set(id, key);
  return (priceId: string) => reverse.get(priceId) ?? null;
}

// ─── merge + stores ──────────────────────────────────────────────────────────

/** Newer event wins on status/updated_at; known fields survive thinner events. */
function mergeSub(a: Subscription, b: Subscription): Subscription {
  return {
    subscription_id: b.subscription_id || a.subscription_id,
    customer_id: b.customer_id ?? a.customer_id,
    email: b.email ?? a.email,
    plan: b.plan ?? a.plan,
    status: b.status,
    current_period_end: b.current_period_end ?? a.current_period_end,
    updated_at: b.updated_at,
  };
}

function findByEmailIn(subs: Iterable<Subscription>, email: string): Subscription | null {
  const want = email.trim().toLowerCase();
  let best: Subscription | null = null;
  for (const s of subs) {
    if (s.email?.toLowerCase() !== want) continue;
    if (!best || s.updated_at >= best.updated_at) best = s;
  }
  return best;
}

/** In-memory store — the £0 default (portal runs without a billing file). */
export function memorySubscriptionStore(): SubscriptionStore & { data: Map<string, Subscription> } {
  const data = new Map<string, Subscription>();
  return {
    data,
    record(sub) {
      const cur = data.get(sub.subscription_id);
      const merged = cur ? mergeSub(cur, sub) : sub;
      data.set(sub.subscription_id, merged);
      return merged;
    },
    find: (id) => data.get(id) ?? null,
    findByEmail: (email) => findByEmailIn(data.values(), email),
    list: () => [...data.values()],
  };
}

/** File-backed store — a JSONL append log, last record per subscription id wins. */
export function fileSubscriptionStore(file: string): SubscriptionStore {
  function readAll(): Subscription[] {
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Subscription);
  }
  function latest(): Map<string, Subscription> {
    const m = new Map<string, Subscription>();
    for (const s of readAll()) m.set(s.subscription_id, s);
    return m;
  }
  return {
    record(sub) {
      const cur = latest().get(sub.subscription_id);
      const merged = cur ? mergeSub(cur, sub) : sub;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, JSON.stringify(merged) + '\n', 'utf8');
      return merged;
    },
    find: (id) => latest().get(id) ?? null,
    findByEmail: (email) => findByEmailIn(latest().values(), email),
    list: () => [...latest().values()],
  };
}
