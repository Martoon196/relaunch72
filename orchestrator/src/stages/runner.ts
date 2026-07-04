/**
 * Generic stage executor implementing the Pipeline Spec retry policy:
 * schema-fail or QA-fail → ONE automatic retry with the failure critique
 * appended; second failure → stage parked for the human queue with flags.
 * Never silently ships a failed stage.
 */

import fs from 'node:fs';
import path from 'node:path';
import { Ajv } from 'ajv';
import type { Intake, QAIssue, StageAttempt, StageRecord } from '../types.js';
import type { LlmClient, LlmMessage } from '../llm/client.js';
import { extractJson } from '../llm/json.js';
import { estimateCostUsd, stageModel } from '../config.js';
import type { StageDef } from './defs.js';
import { loadPrompt } from './prompt.js';

const ajv = new Ajv({ allErrors: true, strict: false });

export interface StageRunOutcome {
  record: StageRecord;
  output: unknown | null;
}

function buildUserMessage(def: StageDef, intake: Intake, prior: Record<string, unknown>): string {
  const inputs: Record<string, unknown> = {};
  for (const id of def.inputFields) inputs[id] = intake[id] ?? null;

  const parts = [
    'INPUT — the customer\'s Deep Intake answers, keyed by field ID:',
    '```json',
    JSON.stringify(inputs, null, 2),
    '```',
  ];

  for (const stageId of def.priorStages) {
    parts.push(
      `PRIOR STAGE OUTPUT (${stageId}):`,
      '```json',
      JSON.stringify(prior[stageId] ?? null, null, 2),
      '```',
    );
  }

  parts.push(
    'OUTPUT REQUIREMENTS:',
    'Respond with a single JSON object and NOTHING else — no markdown fences, no commentary.',
    'It must validate against this JSON Schema:',
    '```json',
    JSON.stringify(def.schema, null, 2),
    '```',
  );
  return parts.join('\n');
}

function buildCritique(schemaErrors: string[], qaIssues: QAIssue[]): string {
  const lines = [
    'Your previous response failed validation. Fix ALL of the following and return the corrected, complete JSON object only (no commentary):',
  ];
  for (const e of schemaErrors) lines.push(`- [schema] ${e}`);
  for (const i of qaIssues) lines.push(`- [${i.check}] ${i.message}`);
  return lines.join('\n');
}

export async function runStage(
  def: StageDef,
  intake: Intake,
  prior: Record<string, unknown>,
  ctx: { runDir: string; client: LlmClient },
): Promise<StageRunOutcome> {
  const prompt = loadPrompt(def.promptFile);
  const model = ctx.client.mode === 'mock' ? 'mock' : stageModel(def.id, prompt.header.model);
  const validate = ajv.compile(def.schema);
  const userMessage = buildUserMessage(def, intake, prior);

  const record: StageRecord = {
    stage: def.id,
    status: 'parked',
    prompt_file: prompt.file,
    prompt_version: prompt.header.version,
    prompt_sha256: prompt.sha256,
    model,
    attempts: [],
    cost_usd: 0,
    output_file: null,
    flags: [],
  };

  const messages: LlmMessage[] = [{ role: 'user', content: userMessage }];
  let output: unknown | null = null;

  for (let attempt = 1; attempt <= 2; attempt++) {
    const started = Date.now();
    const resp = await ctx.client.complete({
      model,
      maxTokens: def.maxTokens,
      system: prompt.body,
      messages,
      meta: { stage: def.id, attempt },
    });

    const rawFile = `${def.id.toLowerCase()}-attempt-${attempt}.txt`;
    fs.writeFileSync(path.join(ctx.runDir, rawFile), resp.text, 'utf8');
    record.cost_usd += estimateCostUsd(model, resp.tokensIn, resp.tokensOut);

    const attemptRec: StageAttempt = {
      attempt,
      started_at: new Date(started).toISOString(),
      raw_output_file: rawFile,
      tokens_in: resp.tokensIn,
      tokens_out: resp.tokensOut,
      duration_ms: Date.now() - started,
      stop_reason: resp.stopReason,
      schema_errors: [],
      qa_issues: [],
    };
    record.attempts.push(attemptRec);

    // A safety refusal is a human-queue matter, not a prompt-fix matter (D-011).
    if (resp.stopReason === 'refusal') {
      record.flags.push('model_refusal — parked for human review, no retry');
      return { record, output: null };
    }
    if (resp.stopReason === 'max_tokens') {
      attemptRec.schema_errors.push('response truncated (hit max_tokens) — output must be complete JSON');
    }

    const parsed = extractJson(resp.text);
    if ('error' in parsed) {
      attemptRec.schema_errors.push(parsed.error);
    } else {
      const valid = validate(parsed.value);
      if (!valid) {
        for (const err of validate.errors ?? []) {
          attemptRec.schema_errors.push(`${err.instancePath || '(root)'} ${err.message ?? 'invalid'}`);
        }
      }
      // QA only runs on schema-valid output — its checks assume the shape.
      if (valid) {
        attemptRec.qa_issues = def.qa(parsed.value, intake, prior);
        if (attemptRec.qa_issues.length === 0) {
          output = parsed.value;
        }
        // No-invention violations never get a retry — a model that fabricates
        // proof doesn't get a second chance to fabricate more convincingly.
        const fatal = attemptRec.qa_issues.filter((i) => i.fatal);
        if (fatal.length > 0) {
          record.flags.push(
            `no_invention violation — parked immediately, NO retry (global QA rule 2): ${fatal.map((i) => i.check).join('; ')}`,
          );
          return { record, output: null };
        }
      }
    }

    if (output !== null) {
      record.status = 'passed';
      const outFile = `${def.id.toLowerCase()}.json`;
      fs.writeFileSync(path.join(ctx.runDir, outFile), JSON.stringify(output, null, 2), 'utf8');
      record.output_file = outFile;
      return { record, output };
    }

    if (attempt === 1) {
      messages.push({ role: 'assistant', content: resp.text });
      messages.push({ role: 'user', content: buildCritique(attemptRec.schema_errors, attemptRec.qa_issues) });
    }
  }

  const last = record.attempts[record.attempts.length - 1];
  record.flags.push(
    `failed schema/QA twice — parked for human queue: ${[
      ...(last?.schema_errors ?? []),
      ...(last?.qa_issues.map((i) => i.check) ?? []),
    ].join('; ')}`,
  );
  return { record, output: null };
}
