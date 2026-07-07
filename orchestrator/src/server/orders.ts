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
