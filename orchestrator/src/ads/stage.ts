/**
 * Ad-campaign generator — a StageDef run through the generic stage runner (same
 * as Soro's CC): schema-fail / QA-fail → critique retry → park. Grounds in S2
 * (buyer) + S3 (message/voice) + S4 (offer). NOT in the paid S1–S10 STAGE_ORDER;
 * it runs standalone over a completed relaunch. See decisions D-055.
 */

import type { StageDef } from '../stages/defs.js';
import { AD_CAMPAIGN_SCHEMA } from '../stages/schemas.js';
import { qaAdCampaign, AD_INPUT_FIELDS } from '../qa/checks.js';

export const AD_STAGE: StageDef = {
  id: 'AD',
  name: 'Paid-ads campaign',
  promptFile: 'ad-campaign.md',
  inputFields: AD_INPUT_FIELDS,
  priorStages: ['S2', 'S3', 'S4'],
  schema: AD_CAMPAIGN_SCHEMA,
  qa: (output, intake, prior) => qaAdCampaign(output, intake, prior),
  maxTokens: 16000,
  thinking: false,
};
