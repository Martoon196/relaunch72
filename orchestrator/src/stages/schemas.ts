/**
 * JSON Schemas for stage outputs — field names and shapes are canonical per
 * Pipeline Spec v1.0 ("Out JSON" per stage). minLength values are validation
 * guardrails, not spec (decisions.md D-001).
 */

import type { AnySchema } from 'ajv';
import { S1_CATEGORIES, S6_HERO_ANGLES, S7_HOOK_CATEGORIES, S8_PILLARS, S8_PLATFORMS, S8_FORMATS, S9_TABLE_SOURCES } from '../qa/checks.js';
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
      maxItems: 4,
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
    pricing_moves: { type: 'array', minItems: 2, maxItems: 6, items: { type: 'string', minLength: 20 } },
    risk_reversal_options: { type: 'array', minItems: 2, maxItems: 2, items: { type: 'string', minLength: 30 } },
    category_note: { type: 'string', minLength: 60 },
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

// ─── S6 · Website copy pack ─────────────────────────────────────────────────
// Spec keys: {home, about, sales_page}; sections carry heads + body. `id`
// slugs let QA walk for required blocks; `cta` lets QA enforce the
// multiple-CTA and CTA-specificity rules.

const S6_SECTION = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'head', 'body'],
  properties: {
    id: { type: 'string', pattern: '^[a-z][a-z0-9-]*$', maxLength: 40 },
    head: { type: 'string', minLength: 5 },
    body: { type: 'string', minLength: 80 },
    cta: { type: 'string', minLength: 8 },
  },
} as const;

export const S6_SCHEMA: AnySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['home', 'about', 'sales_page'],
  properties: {
    home: {
      type: 'object',
      additionalProperties: false,
      required: ['hero_variants', 'sections'],
      properties: {
        hero_variants: {
          type: 'array',
          minItems: 2,
          maxItems: 2,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['angle', 'headline', 'subhead', 'cta'],
            properties: {
              angle: { type: 'string', enum: [...S6_HERO_ANGLES] },
              headline: { type: 'string', minLength: 10 },
              subhead: { type: 'string', minLength: 30 },
              cta: { type: 'string', minLength: 8 },
            },
          },
        },
        sections: { type: 'array', minItems: 4, maxItems: 8, items: S6_SECTION },
      },
    },
    about: {
      type: 'object',
      additionalProperties: false,
      required: ['head', 'body'],
      properties: {
        head: { type: 'string', minLength: 5 },
        body: { type: 'string', minLength: 300 },
      },
    },
    sales_page: {
      type: 'object',
      additionalProperties: false,
      required: ['head', 'subhead', 'sections', 'final_cta'],
      properties: {
        head: { type: 'string', minLength: 10 },
        subhead: { type: 'string', minLength: 20 },
        sections: { type: 'array', minItems: 5, maxItems: 10, items: S6_SECTION },
        final_cta: { type: 'string', minLength: 8 },
      },
    },
  },
};

// ─── S7 · Email pack ────────────────────────────────────────────────────────
// draft-07 definitions/$ref (not $defs) for ajv-strict compatibility. Merge
// tokens are fixed at {{first_name}} and {{link}} — QA enforces exactly one
// {{link}} per body ("one CTA per email", mechanically).

export const S7_SCHEMA: AnySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['welcome_seq', 'promo_seq', 'list_warmup_note'],
  definitions: {
    email: {
      type: 'object',
      additionalProperties: false,
      required: ['subject_variants', 'preview', 'body', 'cta'],
      properties: {
        subject_variants: {
          type: 'array',
          minItems: 3,
          maxItems: 3,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['subject', 'hook_category'],
            properties: {
              subject: { type: 'string', minLength: 8, maxLength: 90 },
              hook_category: { type: 'string', enum: [...S7_HOOK_CATEGORIES] },
            },
          },
        },
        preview: { type: 'string', minLength: 20, maxLength: 140 },
        body: { type: 'string', minLength: 300 },
        cta: { type: 'string', minLength: 8, maxLength: 120 },
      },
    },
  },
  properties: {
    welcome_seq: { type: 'array', minItems: 7, maxItems: 7, items: { $ref: '#/definitions/email' } },
    promo_seq: { type: 'array', minItems: 5, maxItems: 5, items: { $ref: '#/definitions/email' } },
    list_warmup_note: {
      type: 'object',
      additionalProperties: false,
      required: ['list_status', 'note', 'reintro_email'],
      properties: {
        list_status: { type: 'string', enum: ['cold', 'warm', 'none'] },
        note: { type: 'string', minLength: 40 },
        reintro_email: { anyOf: [{ type: 'null' }, { $ref: '#/definitions/email' }] },
      },
    },
  },
};

// ─── S8 · 30 days of social content ─────────────────────────────────────────
// Platform enum pins F5 option spelling; the flat format enum rejects unknown
// strings structurally — the per-platform pairing is a QA check.

export const S8_SCHEMA: AnySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['platform_a', 'platform_b', 'posts'],
  properties: {
    platform_a: { type: 'string', enum: [...S8_PLATFORMS] },
    platform_b: { type: 'string', enum: [...S8_PLATFORMS] },
    posts: {
      type: 'array',
      minItems: 30,
      maxItems: 30,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['day', 'platform', 'format', 'hook', 'body', 'cta', 'pillar'],
        properties: {
          day: { type: 'integer', minimum: 1, maximum: 30 },
          platform: { type: 'string', enum: [...S8_PLATFORMS] },
          format: { type: 'string', enum: [...S8_FORMATS] },
          hook: { type: 'string', minLength: 10 },
          body: { type: 'string', minLength: 40 },
          cta: { type: 'string', minLength: 5 },
          pillar: { type: 'string', enum: [...S8_PILLARS] },
        },
      },
    },
  },
};

// ─── S9 · One-page business plan ────────────────────────────────────────────
// numbers_table values are STRINGS so bands ("£3–10k") and formatted currency
// copy through; QA traces every figure back to the declared source.

export const S9_SCHEMA: AnySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['snapshot', 'market', 'offer', 'goals_90d', 'plan_summary', 'numbers_table'],
  properties: {
    snapshot: { type: 'string', minLength: 120, maxLength: 900 },
    market: { type: 'string', minLength: 120, maxLength: 900 },
    offer: { type: 'string', minLength: 100, maxLength: 900 },
    goals_90d: { type: 'string', minLength: 60, maxLength: 650 },
    plan_summary: { type: 'string', minLength: 120, maxLength: 1000 },
    numbers_table: {
      type: 'array',
      minItems: 4,
      maxItems: 12,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['label', 'value', 'source'],
        properties: {
          label: { type: 'string', minLength: 3, maxLength: 60 },
          value: { type: 'string', minLength: 1, maxLength: 40 },
          source: { type: 'string', enum: [...S9_TABLE_SOURCES] },
        },
      },
    },
  },
};

// ─── Content-cluster engine (CC) ─────────────────────────────────────────────
// A topical-authority cluster: one pillar + six supporting articles, all
// interlinked and each linking to one conversion ("money") page. Generated FROM
// a completed relaunch's S2 (dream-buyer) + S3 (message & voice), so the topics
// are chosen by strategy — not a keyword you hand a generic tool. Article briefs
// (outline + key points + a citation-ready snippet + FAQs + SEO metadata), not
// full drafts: the unit a human or a later stage expands, and the unit our
// no-invention QA can actually verify. Own IP — inspired-by-concepts only.

const CC_FAQ = {
  type: 'object',
  additionalProperties: false,
  required: ['q', 'a'],
  properties: {
    q: { type: 'string', minLength: 8, maxLength: 160 },
    a: { type: 'string', minLength: 20, maxLength: 600 },
  },
} as const;

function ccArticle(role: 'pillar' | 'supporting', outlineMin: number): AnySchema {
  return {
    type: 'object',
    additionalProperties: false,
    required: [
      'role', 'slug', 'working_title', 'target_query', 'search_intent', 'angle',
      'outline', 'key_points', 'snippet_answer', 'faqs', 'internal_links',
      'money_page_anchor', 'meta_title', 'meta_description',
    ],
    properties: {
      role: { type: 'string', enum: [role] },
      // kebab-case url slug; unique across the cluster (QA enforces uniqueness).
      slug: { type: 'string', pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$', minLength: 3, maxLength: 80 },
      working_title: { type: 'string', minLength: 10, maxLength: 120 },
      // The fan-out query this article owns — a real sub-question a buyer/AI asks.
      target_query: { type: 'string', minLength: 6, maxLength: 120 },
      search_intent: { type: 'string', enum: ['buy', 'compare', 'learn'] },
      // The take, grounded in an S3 message pillar / positioning (QA checks grounding).
      angle: { type: 'string', minLength: 20, maxLength: 400 },
      outline: { type: 'array', minItems: outlineMin, maxItems: 12, items: { type: 'string', minLength: 6, maxLength: 140 } },
      key_points: { type: 'array', minItems: 3, maxItems: 12, items: { type: 'string', minLength: 15, maxLength: 400 } },
      // Featured-snippet / AI-citation-ready answer block — kept concise (QA caps words).
      snippet_answer: { type: 'string', minLength: 40, maxLength: 500 },
      faqs: { type: 'array', minItems: 3, maxItems: 8, items: CC_FAQ },
      // Slugs of other articles in this cluster this one links to.
      internal_links: { type: 'array', minItems: 1, maxItems: 12, items: { type: 'string', pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$' } },
      // Anchor text for the contextual link to the one money page.
      money_page_anchor: { type: 'string', minLength: 3, maxLength: 80 },
      // SEO metadata — length bounds are the SERP display limits.
      meta_title: { type: 'string', minLength: 10, maxLength: 65 },
      meta_description: { type: 'string', minLength: 40, maxLength: 160 },
    },
  };
}

export const CONTENT_CLUSTER_SUPPORTING = 6; // v1 cluster size: 1 pillar + 6 supporting = 7 articles

export const CONTENT_CLUSTER_SCHEMA: AnySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['topic', 'money_page', 'pillar', 'supporting', 'provenance_note'],
  properties: {
    topic: { type: 'string', minLength: 3, maxLength: 120 },
    money_page: {
      type: 'object',
      additionalProperties: false,
      required: ['slug', 'purpose', 'default_anchor'],
      properties: {
        slug: { type: 'string', minLength: 1, maxLength: 80 },
        purpose: { type: 'string', minLength: 10, maxLength: 200 },
        default_anchor: { type: 'string', minLength: 3, maxLength: 80 },
      },
    },
    pillar: ccArticle('pillar', 5),
    supporting: {
      type: 'array',
      minItems: CONTENT_CLUSTER_SUPPORTING,
      maxItems: CONTENT_CLUSTER_SUPPORTING,
      items: ccArticle('supporting', 4),
    },
    provenance_note: { type: 'string', minLength: 20, maxLength: 600 },
  },
};
