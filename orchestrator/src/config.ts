import path from 'node:path';
import dotenv from 'dotenv';
import { REPO_ROOT } from './paths.js';

// Secrets live in <repo root>/.env only (hard rule #4). Loaded once on import.
dotenv.config({ path: path.join(REPO_ROOT, '.env'), quiet: true });

export const DEFAULT_MODEL = process.env.RELAUNCH72_MODEL_DEFAULT?.trim() || 'claude-sonnet-4-6';

/**
 * Per-stage model resolution: env override > global default > prompt-header model.
 * Keeping this in config (not code) is what makes the S3/S4/S6 stronger-model
 * A/B a one-line change after test-run grading (Build HQ requirement).
 */
export function stageModel(stage: string, promptHeaderModel?: string): string {
  const override = process.env[`RELAUNCH72_MODEL_${stage.toUpperCase()}`]?.trim();
  return override || process.env.RELAUNCH72_MODEL_DEFAULT?.trim() || promptHeaderModel || DEFAULT_MODEL;
}

/** USD per million tokens. Source: Anthropic pricing, cached 2026-06. */
export const PRICING: Record<string, { inPerMTok: number; outPerMTok: number }> = {
  'claude-sonnet-4-6': { inPerMTok: 3, outPerMTok: 15 },
  'claude-sonnet-5': { inPerMTok: 3, outPerMTok: 15 },
  'claude-opus-4-8': { inPerMTok: 5, outPerMTok: 25 },
  'claude-opus-4-7': { inPerMTok: 5, outPerMTok: 25 },
  'claude-opus-4-6': { inPerMTok: 5, outPerMTok: 25 },
  'claude-haiku-4-5': { inPerMTok: 1, outPerMTok: 5 },
};

export function estimateCostUsd(model: string, tokensIn: number, tokensOut: number): number {
  const p = PRICING[model];
  if (!p) return 0; // unknown model — manifest still records raw token counts
  return (tokensIn * p.inPerMTok + tokensOut * p.outPerMTok) / 1_000_000;
}

export const ORCHESTRATOR_VERSION = '0.1.0';
