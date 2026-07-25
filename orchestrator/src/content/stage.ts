/**
 * Content-cluster engine — a StageDef that runs through the same generic stage
 * runner as S1–S9 (schema-fail / QA-fail → one critique retry → park; never
 * ships a failed stage). It is NOT in the paid S1–S10 pipeline's STAGE_ORDER: it
 * runs standalone, over a completed relaunch's S2 + S3, so building it can never
 * destabilise the nine-deliverable pack. Absorbs the competitor content-cluster
 * tool as one stage, grounded in our strategy and our no-invention QA.
 */

import type { StageDef } from '../stages/defs.js';
import { CONTENT_CLUSTER_SCHEMA } from '../stages/schemas.js';
import { qaContentCluster, CC_INPUT_FIELDS } from '../qa/checks.js';

export const CONTENT_CLUSTER_STAGE: StageDef = {
  id: 'CC',
  name: 'Topical-authority content cluster',
  promptFile: 'content-cluster.md',
  inputFields: CC_INPUT_FIELDS,
  priorStages: ['S2', 'S3'],
  schema: CONTENT_CLUSTER_SCHEMA,
  qa: (output, intake, prior) => qaContentCluster(output, intake, prior),
  // Seven article briefs with outlines, FAQs and metadata is a large structured
  // document — like S6–S8, give the budget to output and keep thinking off so
  // the JSON is never truncated mid-cluster.
  maxTokens: 32000,
  thinking: false,
};
