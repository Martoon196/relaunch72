/**
 * Cadence → "is it due today?" — the calendar drives it, so a tick needs no
 * persisted last-run state and is fully deterministic given the date:
 *   daily   → every day
 *   weekly  → Mondays
 *   monthly → the 1st
 */

import type { Cadence, DueAction, Tenant } from './types.js';

const WEEK_START = 1; // Monday (getUTCDay: Sun=0 … Sat=6)

export function isCadenceDue(cadence: Cadence, dateISO: string): boolean {
  const d = new Date(dateISO);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid date: "${dateISO}" (expected YYYY-MM-DD)`);
  switch (cadence) {
    case 'daily':
      return true;
    case 'weekly':
      return d.getUTCDay() === WEEK_START;
    case 'monthly':
      return d.getUTCDate() === 1;
  }
}

/** Every (tenant, rule) whose cadence fires on the given date. */
export function dueActions(tenants: Tenant[], dateISO: string): DueAction[] {
  const out: DueAction[] = [];
  for (const t of tenants) {
    for (const rule of t.rules) {
      if (isCadenceDue(rule.cadence, dateISO)) {
        out.push({ tenantId: t.id, action: rule.action, cadence: rule.cadence, dueDate: dateISO });
      }
    }
  }
  return out;
}
