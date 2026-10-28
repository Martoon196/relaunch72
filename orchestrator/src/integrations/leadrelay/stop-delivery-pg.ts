/** Explicit, inert stop-delivery controller. No import from startup or worker. */
import type { Pool } from 'pg';
import { withTransaction, type DbTransaction } from '../../db/transaction.js';
import {
  createPropertyPredatorStopRelay,
  type StopRelayInstallation, type StopRelayFetchInit, type StopRelayResult,
} from './stop-relay.mjs';

interface ClaimRow {
  source_event_id: string;
  canonical_payload: unknown;
  frozen_binding: unknown;
  claim_token: string;
}
export interface StopDeliveryOutcome {
  readonly eventId: string;
  readonly disposition: 'delivered' | 'held';
  readonly reason: string | null;
}
export interface StopDeliveryDependencies {
  readonly pool: Pick<Pool, 'connect'>;
  readonly installation: StopRelayInstallation;
  /** Explicit deployment opt-in; omission/false performs no SQL or HTTP. */
  readonly enabled?: boolean;
  readonly fetchImpl?: (url: string, init: StopRelayFetchInit) => Response | Promise<Response>;
  readonly nowSeconds?: () => number;
}

/** The caller must obtain a separately approved function-only DB capability.
 * It cannot use an existing portal/session pool or an owner DATABASE_URL.
 * Configuration and explicit account/product/lead mappings are owner-managed;
 * no request body, email address or event payload can select the destination.
 */
export class PgLeadRelayStopDelivery {
  readonly #dependencies: StopDeliveryDependencies;
  constructor(dependencies: StopDeliveryDependencies) {
    // Validate all relay runtime bounds now, even though disabled by default.
    createPropertyPredatorStopRelay({installation: dependencies.installation,
      loadCanonicalEvent: () => null, resolveLeadBinding: () => null});
    this.#dependencies = {...dependencies, installation: structuredClone(dependencies.installation)};
  }
  async #transaction<T>(action: (client: DbTransaction) => Promise<T>): Promise<T> {
    return withTransaction(this.#dependencies.pool, {
      actorKind: 'worker', workspaceId: this.#dependencies.installation.hqWorkspaceId,
      requestId: 'leadrelay-stop-delivery',
    }, async client=>{
      const role=(await client.query<{role:string}>('SELECT current_user::text AS role')).rows[0]?.role;
      if(role!=='r72_leadrelay_stop_runtime')throw new Error('Dedicated stop-delivery database capability required');
      return action(client);
    });
  }
  /** Select exactly one canonical event. No historical source/outbox scan. */
  async prepare(eventId: string): Promise<string> {
    if (this.#dependencies.enabled !== true) return 'disabled';
    const {installation} = this.#dependencies;
    return this.#transaction(async client => {
      const result = await client.query<{disposition: string}>(
        'SELECT app_private.prepare_leadrelay_stop($1,$2,$3) AS disposition',
        [installation.hqWorkspaceId, installation.installationId, eventId]);
      if (result.rows.length !== 1 || typeof result.rows[0]?.disposition !== 'string') {
        throw new Error('Invalid canonical stop preparation result');
      }
      return result.rows[0].disposition;
    });
  }
  /** Drain only explicitly prepared stops for this configured target. This is
   * not a scheduler: no timer, retry loop, startup composition or enrolment. */
  async deliverPrepared(limit = 20): Promise<readonly StopDeliveryOutcome[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new TypeError('Invalid stop batch limit');
    if (this.#dependencies.enabled !== true) return [];
    const {installation} = this.#dependencies;
    const outcomes: StopDeliveryOutcome[] = [];
    for (let count=0;count<limit;count++) {
      // Claim only one immediately before dispatch. A large batch must not sit
      // processing while earlier bounded requests consume its claim lifetime.
      const claims=await this.#transaction(async client=>(await client.query<ClaimRow>(
        'SELECT * FROM app_private.claim_leadrelay_stops($1,$2,1)',
        [installation.hqWorkspaceId,installation.installationId])).rows);
      const claim=claims[0]; if(!claim) break;
      // SQL copied these fields from verified canonical evidence and immutable
      // mappings in prepare(); never reload/remap mutable application input.
      const relay = createPropertyPredatorStopRelay({installation,
        loadCanonicalEvent: () => ({hqWorkspaceId: installation.hqWorkspaceId,
          source: 'property_predator', event: structuredClone(claim.canonical_payload)}),
        resolveLeadBinding: () => structuredClone(claim.frozen_binding),
        ...(this.#dependencies.fetchImpl ? {fetchImpl: this.#dependencies.fetchImpl} : {}),
        ...(this.#dependencies.nowSeconds ? {nowSeconds: this.#dependencies.nowSeconds} : {}),
      });
      const outcome=await this.#transaction(async client=>{
        const authorized=(await client.query<{authorized:boolean}>(
          'SELECT app_private.authorize_leadrelay_stop($1,$2,$3,$4) AS authorized',
          [installation.hqWorkspaceId,installation.installationId,claim.source_event_id,claim.claim_token])).rows[0]?.authorized;
        // The function holds target/binding/claim locks until this transaction
        // commits. A prior revocation holds; a later one waits for settlement.
        const result:StopRelayResult=authorized===true
          ? await relay({hqWorkspaceId:installation.hqWorkspaceId,eventId:claim.source_event_id})
          : {disposition:'held',eventId:claim.source_event_id,reason:'lead_mapping_required'};
        const delivered=result.disposition==='delivered';
        // Transport/body/timeout ambiguities hold. Only a pre-HTTP clock failure
        // is eligible for bounded per-target retry; no ambiguous resubmission.
        const disposition=delivered?'delivered':result.reason==='event_conflict'
          ?'conflict':result.reason==='clock_unavailable'?'deferred':'held';
        const settled=(await client.query<{settled:boolean}>(
          'SELECT app_private.settle_leadrelay_stop($1,$2,$3,$4,$5,$6,$7) AS settled',
          [installation.hqWorkspaceId,installation.installationId,claim.source_event_id,claim.claim_token,
            disposition,delivered?result.duplicate:null,delivered?null:result.reason])).rows[0]?.settled;
        if(settled!==true)throw new Error('Stop receipt requires claim reconciliation');
        return Object.freeze({eventId:claim.source_event_id,
          disposition:delivered?'delivered' as const:'held' as const,reason:delivered?null:result.reason});
      });
      outcomes.push(outcome);
    }
    return Object.freeze(outcomes);
  }
}
