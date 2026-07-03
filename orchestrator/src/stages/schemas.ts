/**
 * JSON Schemas for stage outputs — field names and shapes are canonical per
 * Pipeline Spec v1.0 ("Out JSON" per stage). minLength values are validation
 * guardrails, not spec (decisions.md D-001).
 */

import type { AnySchema } from 'ajv';
import { S1_CATEGORIES } from '../qa/checks.js';
import { SCHWARTZ_AWARENESS_STAGES } from '../intake/spec.js';

export const S1_SCHEMA: AnySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['scores', 'top_3_leaks', 'quick_wins', 'narrative_summary'],
  properties: {
    scores: {
      type: 'array',
      minItems: 6,
      maxItems: 6,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['category', 'grade_1to10', 'evidence', 'leak_cost_estimate'],
        properties: {
          category: { type: 'string', enum: [...S1_CATEGORIES] },
          grade_1to10: { type: 'integer', minimum: 1, maximum: 10 },
          evidence: { type: 'string', minLength: 30 },
          leak_cost_estimate: { type: 'string', minLength: 5 },
        },
      },
    },
    top_3_leaks: { type: 'array', minItems: 3, maxItems: 3, items: { type: 'string', minLength: 20 } },
    quick_wins: { type: 'array', minItems: 3, maxItems: 3, items: { type: 'string', minLength: 15 } },
    narrative_summary: { type: 'string', minLength: 150 },
  },
};

export const S2_SCHEMA: AnySchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'profile_narrative',
    'demographics',
    'situation',
    'trigger_events',
    'objections',
    'desires_surface',
    'desires_deep',
    'verbatims',
    'exclusions',
    'awareness_stage',
    'channels',
  ],
  properties: {
    profile_narrative: { type: 'string', minLength: 400 },
    demographics: { type: 'string', minLength: 20 },
    situation: { type: 'string', minLength: 40 },
    trigger_events: { type: 'array', minItems: 1, items: { type: 'string', minLength: 10 } },
    objections: { type: 'array', minItems: 1, items: { type: 'string', minLength: 5 } },
    desires_surface: { type: 'string', minLength: 20 },
    desires_deep: { type: 'string', minLength: 20 },
    verbatims: { type: 'array', minItems: 1, items: { type: 'string' } },
    exclusions: { type: 'array', items: { type: 'string' } },
    awareness_stage: { type: 'string', enum: [...SCHWARTZ_AWARENESS_STAGES] },
    channels: { type: 'array', minItems: 1, items: { type: 'string' } },
  },
};
