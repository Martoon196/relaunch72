import type { AnySchema } from 'ajv';
import type { Intake, QAIssue } from '../types.js';
import {
  qaS1, qaS2, qaS3, qaS4, qaS5, qaS6, qaS7, qaS8, qaS9,
  S1_INPUT_FIELDS, S2_INPUT_FIELDS, S3_INPUT_FIELDS, S4_INPUT_FIELDS, S5_INPUT_FIELDS,
  S6_INPUT_FIELDS, S7_INPUT_FIELDS, S8_INPUT_FIELDS, S9_INPUT_FIELDS,
} from '../qa/checks.js';
import {
  S1_SCHEMA, S2_SCHEMA, S3_SCHEMA, S4_SCHEMA, S5_SCHEMA,
  S6_SCHEMA, S7_SCHEMA, S8_SCHEMA, S9_SCHEMA,
} from './schemas.js';

export interface StageDef {
  id: string;
  name: string;
  promptFile: string;
  /**
   * Exactly the intake fields this stage consumes (Pipeline Spec "In:" list).
   * No stage reads intake it doesn't need — "No mega-prompt".
   */
  inputFields: string[];
  /** Prior stage outputs injected into context (Pipeline Spec "In:" list). */
  priorStages: string[];
  schema: AnySchema;
  qa: (output: unknown, intake: Intake, prior: Record<string, unknown>) => QAIssue[];
  maxTokens: number;
  /**
   * Adaptive thinking (default on). The large copy stages (S6/S7/S8) turn it
   * OFF: they render already-decided strategy (S1–S5) into a big structured
   * document, and adaptive thinking on 12 emails / 30 posts consumes the whole
   * token budget on reasoning and truncates the JSON before it's emitted. The
   * hard reasoning is upstream; these stages just need output room.
   */
  thinking?: boolean;
}

export const STAGE_ORDER = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9'] as const; // S10 assembly runs after, over the full set

export const STAGES: Record<string, StageDef> = {
  S1: {
    id: 'S1',
    name: 'Marketing audit & scorecard',
    promptFile: 's1-audit.md',
    inputFields: S1_INPUT_FIELDS,
    priorStages: [],
    schema: S1_SCHEMA,
    qa: (output, intake) => qaS1(output, intake),
    maxTokens: 32000, // adaptive thinking shares this budget — headroom prevents attempt-1 truncation (M2 gate lesson)
  },
  S2: {
    id: 'S2',
    name: 'Dream buyer profile (ICP)',
    promptFile: 's2-icp.md',
    inputFields: S2_INPUT_FIELDS,
    priorStages: [], // per spec, S2 consumes intake only — not S1 (decisions.md D-012)
    schema: S2_SCHEMA,
    qa: (output, intake) => qaS2(output, intake),
    maxTokens: 32000, // adaptive thinking shares this budget — headroom prevents attempt-1 truncation (M2 gate lesson)
  },
  S3: {
    id: 'S3',
    name: 'Core message & voice guide',
    promptFile: 's3-message.md',
    inputFields: S3_INPUT_FIELDS,
    priorStages: ['S2'],
    schema: S3_SCHEMA,
    qa: (output, intake, prior) => qaS3(output, intake, prior),
    maxTokens: 32000, // adaptive thinking shares this budget — headroom prevents attempt-1 truncation (M2 gate lesson)
  },
  S4: {
    id: 'S4',
    name: 'Offer architecture',
    promptFile: 's4-offer.md',
    inputFields: S4_INPUT_FIELDS,
    priorStages: ['S2', 'S3'],
    schema: S4_SCHEMA,
    qa: (output, intake, prior) => qaS4(output, intake, prior),
    maxTokens: 32000, // adaptive thinking shares this budget — headroom prevents attempt-1 truncation (M2 gate lesson)
  },
  S5: {
    id: 'S5',
    name: '90-day growth plan',
    promptFile: 's5-roadmap.md',
    inputFields: S5_INPUT_FIELDS,
    priorStages: ['S1', 'S2', 'S3', 'S4'],
    schema: S5_SCHEMA,
    qa: (output, intake, prior) => qaS5(output, intake, prior),
    maxTokens: 32000, // adaptive thinking shares this budget — headroom prevents attempt-1 truncation (M2 gate lesson)
  },
  // S6–S9 are the first stages whose QA reads prior-stage outputs — the
  // cross-stage no-invention haystacks trace quotes and figures back to what
  // earlier stages actually said.
  S6: {
    id: 'S6',
    name: 'Website copy pack',
    promptFile: 's6-website.md',
    inputFields: S6_INPUT_FIELDS,
    priorStages: ['S2', 'S3', 'S4'],
    schema: S6_SCHEMA,
    qa: (output, intake, prior) => qaS6(output, intake, prior),
    maxTokens: 32000, // three pages of copy; thinking off so all budget is output
    thinking: false,
  },
  S7: {
    id: 'S7',
    name: 'Email pack',
    promptFile: 's7-emails.md',
    inputFields: S7_INPUT_FIELDS,
    priorStages: ['S2', 'S3', 'S4'],
    schema: S7_SCHEMA,
    qa: (output, intake, prior) => qaS7(output, intake, prior),
    maxTokens: 32000, // 12–13 full emails; thinking off so all budget is output
    thinking: false,
  },
  S8: {
    id: 'S8',
    name: '30 days of social content',
    promptFile: 's8-social.md',
    inputFields: S8_INPUT_FIELDS,
    priorStages: ['S2', 'S3', 'S5'],
    schema: S8_SCHEMA,
    qa: (output, intake, prior) => qaS8(output, intake, prior),
    maxTokens: 32000, // 30 posts; thinking off so all budget is output
    thinking: false,
  },
  S9: {
    id: 'S9',
    name: 'One-page business plan',
    promptFile: 's9-oneplan.md',
    inputFields: S9_INPUT_FIELDS,
    priorStages: ['S1', 'S2', 'S3', 'S4', 'S5'],
    schema: S9_SCHEMA,
    qa: (output, intake, prior) => qaS9(output, intake, prior),
    maxTokens: 32000, // adaptive thinking shares this budget — headroom prevents attempt-1 truncation (M2 gate lesson)
  },
};
