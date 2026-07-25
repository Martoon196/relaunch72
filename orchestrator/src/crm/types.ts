/**
 * Thin CRM core — the spine of our own platform (decision D-060: build our own
 * portal + thin CRM + atomic rails, no GHL). Deliberately *thin*: contacts, a
 * pipeline, and an activity timeline per tenant — not GHL's kitchen sink. The
 * store is swappable (memory / JSON now, a real DB later) so this starts at £0
 * and grows into the live portal without a rewrite.
 */

export type Channel = 'email' | 'sms' | 'whatsapp' | 'social' | 'ads' | 'system';

export type ActivityKind = 'contact_created' | 'stage_changed' | 'message_sent' | 'rail_run' | 'note';

export const PIPELINE_STAGES = ['lead', 'contacted', 'qualified', 'won', 'lost'] as const;
export type PipelineStage = (typeof PIPELINE_STAGES)[number];

export interface Tenant {
  id: string;
  name: string;
  /** The client's brand brain (intake → S2/S3 …) lives in this run dir. */
  runDir?: string;
  createdAt: string;
}

export interface Contact {
  id: string;
  tenantId: string;
  name: string;
  email?: string;
  phone?: string;
  stage: PipelineStage;
  createdAt: string;
}

export interface Activity {
  id: string;
  tenantId: string;
  at: string;
  kind: ActivityKind;
  channel: Channel;
  summary: string;
  contactId?: string;
}

export interface TenantView {
  tenant: Tenant;
  contacts: Contact[];
  /** Count of contacts in each pipeline stage. */
  pipeline: Record<PipelineStage, number>;
  /** Most-recent-first. */
  activity: Activity[];
}
