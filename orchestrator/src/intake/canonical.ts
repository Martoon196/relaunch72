/** Keep only the published intake contract before data reaches a run or portal. */

import type { FieldValue, Intake } from '../types.js';
import { INTAKE_FIELDS } from './spec.js';

const CANONICAL_KEYS = [...INTAKE_FIELDS.map((field) => field.id), 'consent'] as const;

/**
 * Stripe session ids, claimed tiers and other transport metadata are deliberately
 * excluded. Product scope comes from the verified order, never from the intake.
 */
export function canonicalIntake(input: Record<string, unknown>): Intake {
  const output: Intake = {};
  for (const key of CANONICAL_KEYS) {
    if (Object.prototype.hasOwnProperty.call(input, key)) output[key] = input[key] as FieldValue;
  }
  return output;
}
