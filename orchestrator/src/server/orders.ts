/**
 * Minimal order store — a JSONL append log (one order per line). Plenty for
 * beta volume; swap for a DB later behind the same interface. Tracks a paid
 * Stripe session from payment → intake accepted → build kicked.
 */

import fs from 'node:fs';
import path from 'node:path';

export type OrderStatus = 'paid_awaiting_intake' | 'building' | 'nudge_returned';

export interface Order {
  session_id: string;
  tier: string;
  bump: boolean;
  email: string | null;
  amount_total: number | null;
  currency: string | null;
  status: OrderStatus;
  paid_at: string;
  run_dir?: string;
  updated_at?: string;
}

export interface OrderStore {
  record(order: Order): void;
  find(sessionId: string): Order | null;
  update(sessionId: string, patch: Partial<Order>): Order | null;
}

/** A durable acknowledgement that a verified Stripe event was processed. */
export interface WebhookReceipt {
  event_id: string;
  type: string;
  processed_at: string;
}

/**
 * Stripe retries webhook deliveries until they receive a success response.
 * Keeping the event id outside the order/subscription stores prevents those
 * retries from repeating any of the event's side effects.
 */
export interface WebhookReceiptStore {
  has(eventId: string): boolean;
  /** Returns false when this event id was already recorded. */
  record(receipt: WebhookReceipt): boolean;
}

/** File-backed store. Reads scan the log and take the LAST record per session. */
export function fileOrderStore(ordersFile: string): OrderStore {
  function readAll(): Order[] {
    if (!fs.existsSync(ordersFile)) return [];
    return fs.readFileSync(ordersFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Order);
  }
  function latest(): Map<string, Order> {
    const m = new Map<string, Order>();
    for (const o of readAll()) m.set(o.session_id, o);
    return m;
  }
  return {
    record(order) {
      fs.mkdirSync(path.dirname(ordersFile), { recursive: true });
      fs.appendFileSync(ordersFile, JSON.stringify(order) + '\n', 'utf8');
    },
    find(sessionId) {
      return latest().get(sessionId) ?? null;
    },
    update(sessionId, patch) {
      const cur = latest().get(sessionId);
      if (!cur) return null;
      const next = { ...cur, ...patch, updated_at: patch.updated_at ?? cur.updated_at };
      fs.appendFileSync(ordersFile, JSON.stringify(next) + '\n', 'utf8');
      return next;
    },
  };
}

/** In-memory receipt store for tests and ephemeral development. */
export function memoryWebhookReceiptStore(): WebhookReceiptStore & { data: Map<string, WebhookReceipt> } {
  const data = new Map<string, WebhookReceipt>();
  return {
    data,
    has: (eventId) => data.has(eventId),
    record(receipt) {
      if (data.has(receipt.event_id)) return false;
      data.set(receipt.event_id, receipt);
      return true;
    },
  };
}

/**
 * File-backed Stripe-event receipt journal. Reads take the last receipt per
 * event id, matching the append-only order/subscription stores above.
 */
export function fileWebhookReceiptStore(receiptsFile: string): WebhookReceiptStore {
  function latest(): Map<string, WebhookReceipt> {
    const receipts = new Map<string, WebhookReceipt>();
    if (!fs.existsSync(receiptsFile)) return receipts;
    for (const line of fs.readFileSync(receiptsFile, 'utf8').split('\n').filter(Boolean)) {
      const receipt = JSON.parse(line) as WebhookReceipt;
      receipts.set(receipt.event_id, receipt);
    }
    return receipts;
  }

  return {
    has: (eventId) => latest().has(eventId),
    record(receipt) {
      if (latest().has(receipt.event_id)) return false;
      fs.mkdirSync(path.dirname(receiptsFile), { recursive: true });
      fs.appendFileSync(receiptsFile, JSON.stringify(receipt) + '\n', 'utf8');
      return true;
    },
  };
}
