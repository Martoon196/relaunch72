import type { AnySchema } from 'ajv';
import type { Intake, QAIssue } from '../types.js';
import {
  qaS1, qaS2, qaS3, qaS4, qaS5,
  S1_INPUT_FIELDS, S2_INPUT_FIELDS, S3_INPUT_FIELDS, S4_INPUT_FIELDS, S5_INPUT_FIELDS,
} from '../qa/checks.js';
import { S1_SCHEMA, S2_SCHEMA, S3_SCHEMA, S4_SCHEMA, S5_SCHEMA } from './schemas.js';

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
}

export const STAGE_ORDER = ['S1', 'S2', 'S3', 'S4', 'S5'] as const; // S6–S10 land next in M2

export const STAGES: Record<string, StageDef> = {
  S1: {
    id: 'S1',
    name: 'Marketing audit & scorecard',
    promptFile: 's1-audit.md',
    inputFields: S1_INPUT_FIELDS,
    priorStages: [],
    schema: S1_SCHEMA,
    qa: (output, intake) => qaS1(output, intake),
    maxTokens: 16000,
  },
  S2: {
    id: 'S2',
    name: 'Dream buyer profile (ICP)',
    promptFile: 's2-icp.md',
    inputFields: S2_INPUT_FIELDS,
    priorStages: [], // per spec, S2 consumes intake only — not S1 (decisions.md D-012)
    schema: S2_SCHEMA,
    qa: (output, intake) => qaS2(output, intake),
    maxTokens: 16000,
  },
  S3: {
    id: 'S3',
    name: 'Core message & voice guide',
    promptFile: 's3-message.md',
    inputFields: S3_INPUT_FIELDS,
    priorStages: ['S2'],
    schema: S3_SCHEMA,
    qa: (output, intake) => qaS3(output, intake),
    maxTokens: 16000,
  },
  S4: {
    id: 'S4',
    name: 'Offer architecture',
    promptFile: 's4-offer.md',
    inputFields: S4_INPUT_FIELDS,
    priorStages: ['S2', 'S3'],
    schema: S4_SCHEMA,
    qa: (output, intake) => qaS4(output, intake),
    maxTokens: 16000,
  },
  S5: {
    id: 'S5',
    name: '90-day growth plan',
    promptFile: 's5-roadmap.md',
    inputFields: S5_INPUT_FIELDS,
    priorStages: ['S1', 'S2', 'S3', 'S4'],
    schema: S5_SCHEMA,
    qa: (output, intake) => qaS5(output, intake),
    maxTokens: 16000,
  },
};
