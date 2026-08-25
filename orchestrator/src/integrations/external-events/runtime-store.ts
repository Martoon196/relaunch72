import type { PropertyPredatorExternalEventShadowRecordInput } from './pg-service.js';
import { parsePropertyPredatorExternalEventBody } from './contracts.js';

export interface PropertyPredatorProjectedEventRecordResult {
  readonly disposition: 'projected';
  readonly replayed: boolean;
}

export interface PropertyPredatorRuntimeEventStoreDependencies {
  readonly receiptStore: {
    record(input: PropertyPredatorExternalEventShadowRecordInput): Promise<{
      readonly disposition: 'shadow';
      readonly replayed: boolean;
    }>;
  };
  readonly growthProjector: {
    project(eventId: string): Promise<{
      readonly disposition: 'projected';
      readonly replayed: boolean;
    }>;
  };
  readonly journeyRuntime: {
    project(eventId: string): Promise<{
      readonly disposition: 'projected';
      readonly replayed: boolean;
    }>;
  };
}

const GROWTH_EVIDENCE_EVENT_TYPES = new Set([
  'identity.account.created',
  'affiliate.referral.attributed',
  'content.consumption.progressed',
  'content.consumption.completed',
  'offer.presented',
  'offer.responded',
]);

/**
 * Exact-retry-safe bridge composition.
 *
 * The immutable receipt commits first. Each projector then owns its own
 * transactional idempotency fence, so a 503 followed by an exact signed retry
 * can complete a partially interrupted pipeline without duplicating facts.
 * Autonomous receipt draining is intentionally a separate worker concern.
 */
export class PropertyPredatorRuntimeEventStore {
  constructor(private readonly dependencies: PropertyPredatorRuntimeEventStoreDependencies) {
    if (!dependencies?.receiptStore || typeof dependencies.receiptStore.record !== 'function') {
      throw new TypeError('receiptStore must provide record()');
    }
    if (!dependencies.growthProjector || typeof dependencies.growthProjector.project !== 'function') {
      throw new TypeError('growthProjector must provide project()');
    }
    if (!dependencies.journeyRuntime || typeof dependencies.journeyRuntime.project !== 'function') {
      throw new TypeError('journeyRuntime must provide project()');
    }
  }

  async record(
    input: PropertyPredatorExternalEventShadowRecordInput,
  ): Promise<PropertyPredatorProjectedEventRecordResult> {
    const event = parsePropertyPredatorExternalEventBody(input.rawBody);
    const receipt = await this.dependencies.receiptStore.record(input);
    let growthReplayed = true;
    if (GROWTH_EVIDENCE_EVENT_TYPES.has(event.type)) {
      const growth = await this.dependencies.growthProjector.project(event.id);
      growthReplayed = growth.replayed;
    }
    const journey = await this.dependencies.journeyRuntime.project(event.id);
    return Object.freeze({
      disposition: 'projected',
      replayed: receipt.replayed && growthReplayed && journey.replayed,
    });
  }
}
