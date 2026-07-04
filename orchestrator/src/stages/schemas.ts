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

export const S3_SCHEMA: AnySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['positioning_statement', 'message_pillars', 'differentiators', 'value_props', 'voice', 'elevator_pitch'],
  properties: {
    positioning_statement: { type: 'string', minLength: 40 },
    message_pillars: { type: 'array', minItems: 3, maxItems: 3, items: { type: 'string', minLength: 15 } },
    differentiators: { type: 'array', minItems: 2, items: { type: 'string', minLength: 20 } },
    value_props: { type: 'array', minItems: 3, items: { type: 'string', minLength: 15 } },
    voice: {
      type: 'object',
      additionalProperties: false,
      required: ['sliders', 'tone_rules', 'banned_words', 'must_words'],
      properties: {
        sliders: {
          type: 'object',
          additionalProperties: false,
          required: ['formal_casual', 'playful_straight', 'bold_understated'],
          properties: {
            formal_casual: { type: 'integer', minimum: 1, maximum: 5 },
            playful_straight: { type: 'integer', minimum: 1, maximum: 5 },
            bold_understated: { type: 'integer', minimum: 1, maximum: 5 },
          },
        },
        tone_rules: { type: 'array', minItems: 3, items: { type: 'string', minLength: 10 } },
        banned_words: { type: 'array', minItems: 8, items: { type: 'string' } },
        must_words: { type: 'array', items: { type: 'string' } },
      },
    },
    elevator_pitch: { type: 'string', minLength: 30 },
  },
};

export const S4_SCHEMA: AnySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['current_stack_read', 'recommended_stack', 'lead_offer', 'pricing_moves', 'risk_reversal_options', 'category_note'],
  properties: {
    current_stack_read: { type: 'string', minLength: 80 },
    recommended_stack: {
      type: 'array',
      minItems: 2,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'price', 'role', 'rationale'],
        properties: {
          name: { type: 'string', minLength: 3 },
          price: { type: 'number', exclusiveMinimum: 0 },
          role: { type: 'string', enum: ['entry', 'core', 'premium'] },
          rationale: { type: 'string', minLength: 40 },
        },
      },
    },
    lead_offer: { type: 'string', minLength: 30 },
    pricing_moves: { type: 'array', minItems: 1, items: { type: 'string', minLength: 20 } },
    risk_reversal_options: { type: 'array', minItems: 2, maxItems: 2, items: { type: 'string', minLength: 30 } },
    category_note: { type: 'string', minLength: 30 },
  },
};

export const S5_SCHEMA: AnySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['north_star', 'phases', 'channel_priorities', 'do_not_do', 'weekly_hours_total'],
  properties: {
    north_star: { type: 'string', minLength: 20 },
    phases: {
      type: 'array',
      minItems: 2,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['days', 'theme', 'actions'],
        properties: {
          days: { type: 'string', minLength: 3 },
          theme: { type: 'string', minLength: 10 },
          actions: {
            type: 'array',
            minItems: 2,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['action', 'hours', 'channel', 'depends_on'],
              properties: {
                action: { type: 'string', minLength: 15 },
                hours: { type: 'number', minimum: 0 },
                channel: { type: 'string', minLength: 2 },
                depends_on: { type: 'string' },
              },
            },
          },
        },
      },
    },
    channel_priorities: { type: 'array', minItems: 2, items: { type: 'string', minLength: 2 } },
    do_not_do: { type: 'array', minItems: 1, items: { type: 'string', minLength: 10 } },
    weekly_hours_total: { type: 'number', exclusiveMinimum: 0 },
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
