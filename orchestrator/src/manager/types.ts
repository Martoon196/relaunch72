/**
 * AI marketing manager — the per-tenant orchestrator (the "manager that never
 * sleeps"). Given the client roster and a date, it decides which capability
 * rails run for whom today, then dispatches them. Platform-independent: it sits
 * above the rails regardless of whether the portal is our own or GHL-backed
 * (decisions D-056/D-057). Built mock-first — runs at £0 until real keys.
 */

export type RailAction = 'content_cluster' | 'social_batch' | 'keyword_refresh' | 'ads_refresh';

export type Cadence = 'daily' | 'weekly' | 'monthly';

export interface CadenceRule {
  action: RailAction;
  cadence: Cadence;
}

export interface Tenant {
  /** Stable client id. */
  id: string;
  name: string;
  /** The client's run dir (their brand brain: intake → S2/S3 → …). Optional in mock. */
  runDir?: string;
  rules: CadenceRule[];
}

export interface DueAction {
  tenantId: string;
  action: RailAction;
  cadence: Cadence;
  dueDate: string; // ISO date the tick ran for
}

export interface ActivityEntry {
  tenantId: string;
  action: RailAction;
  at: string;
  status: 'ok' | 'skipped' | 'failed';
  note?: string;
}
