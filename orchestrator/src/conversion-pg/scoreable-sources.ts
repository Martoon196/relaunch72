import type { ConversionTriggerKind } from './types.js';

/**
 * Audited V1 facts that may create lead-score points.
 *
 * This is intentionally a positive registry rather than a deny-list: adding a
 * new event catalogue entry does not make it scoreable until this registry is
 * reviewed and changed deliberately.
 */
export const CONVERSION_SCOREABLE_SOURCE_REGISTRY = Object.freeze({
  event: Object.freeze([
    'identity.account.created',
    'product.analysis.completed',
  ]),
  commerce: Object.freeze([
    'payment_collected',
  ]),
} satisfies Readonly<Record<ConversionTriggerKind, readonly string[]>>);

export function isConversionScoreableSource(kind: ConversionTriggerKind, sourceKey: string): boolean {
  return (CONVERSION_SCOREABLE_SOURCE_REGISTRY[kind] as readonly string[]).includes(sourceKey);
}
