/** Public server-side contract for stop-relay.mjs; runtime validates all bounds. */
export interface StopRelayInstallation {
  readonly hqWorkspaceId: string;
  readonly leadRelayWorkspaceId: string;
  readonly installationId: string;
  readonly origin: string;
  /** Dedicated LeadRelay hook key, loaded from secure server configuration. */
  readonly hookSecret: string;
  readonly purchaseProductKeys: readonly string[];
  /** Integer from 250 through 10000; defaults to 5000. */
  readonly timeoutMs?: number;
}

export interface StopRelayRequest {
  readonly hqWorkspaceId: string;
  readonly eventId: string;
}

export type StopSourceEventType =
  | 'commerce.purchase.completed'
  | 'sales.appointment.booked';

export interface StopLeadMappingQuery {
  readonly hqWorkspaceId: string;
  readonly installationId: string;
  readonly leadRelayWorkspaceId: string;
  readonly source: 'property_predator';
  readonly sourceSubjectId: string;
  readonly eventType: StopSourceEventType;
  readonly productKey: string | null;
}

/** Loader/mapping returns are unknown at the trust boundary and revalidated. */
export interface CanonicalStopSourceRecord {
  readonly hqWorkspaceId: string;
  readonly source: 'property_predator';
  readonly event: unknown;
}

export interface StopLeadBinding extends StopLeadMappingQuery {
  readonly leadId: string;
  readonly stopScope: 'all_sales_followup_for_lead';
}

export type StopRelayHoldReason =
  | 'source_binding_required'
  | 'source_unavailable'
  | 'verified_source_required'
  | 'unsupported_event'
  | 'product_not_mapped'
  | 'lead_mapping_unavailable'
  | 'lead_mapping_required'
  | 'clock_unavailable'
  | 'event_conflict'
  | 'stop_receipt_unconfirmed'
  | 'stop_outcome_unknown';

export type StopRelayResult = Readonly<{
  disposition: 'held';
  eventId: string | null;
  reason: StopRelayHoldReason;
}> | Readonly<{
  disposition: 'delivered';
  eventId: string;
  hookEventId: string;
  duplicate: boolean;
}>;

export interface StopRelayFetchInit {
  readonly method: 'POST';
  readonly redirect: 'error';
  readonly signal: AbortSignal;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface PropertyPredatorStopRelayOptions {
  readonly installation: StopRelayInstallation;
  /** Must read verified canonical evidence from the bound HQ workspace. */
  readonly loadCanonicalEvent: (query: Readonly<StopRelayRequest>) => unknown | Promise<unknown>;
  /** Must resolve an explicit persisted mapping; never infer one from email. */
  readonly resolveLeadBinding: (query: Readonly<StopLeadMappingQuery>) => unknown | Promise<unknown>;
  readonly fetchImpl?: (url: string, init: StopRelayFetchInit) => Response | Promise<Response>;
  readonly nowSeconds?: () => number;
}

export type PropertyPredatorStopRelay = (request: Readonly<StopRelayRequest>) => Promise<StopRelayResult>;

export function createPropertyPredatorStopRelay(options: PropertyPredatorStopRelayOptions): PropertyPredatorStopRelay;
