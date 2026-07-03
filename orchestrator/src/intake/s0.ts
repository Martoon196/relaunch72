/**
 * S0 · Intake QA gate (no LLM generation) — Pipeline Spec v1.0.
 * Validates required fields, min-word thresholds and placeholder-similarity
 * (answers that just echo our placeholder examples are rejected). Output is
 * either accepted (72h clock starts in M3) or a nudge listing thin fields.
 *
 * The spec permits one LLM classification per flagged field ("is this answer
 * substantive?") — stubbed off for M1 behind RELAUNCH72_S0_LLM_CHECK
 * (decisions.md D-004).
 */

import type { FieldValue, Intake, S0FieldIssue, S0Result } from '../types.js';
import { FIELD_BY_ID, INTAKE_FIELDS, type FieldSpec } from './spec.js';
import { isPlaceholderEcho, wordCount } from '../util/text.js';

function isEmpty(v: FieldValue | undefined): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === 'string') return v.trim().length === 0;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'object') return Object.keys(v).length === 0;
  return false;
}

function isRequired(spec: FieldSpec, intake: Intake): boolean {
  if (typeof spec.required === 'boolean') return spec.required;
  const gate = intake[spec.required.ifField];
  return Array.isArray(gate) && gate.includes(spec.required.includes);
}

function issue(spec: FieldSpec, reason: string): S0FieldIssue {
  return { field: spec.id, label: spec.label, reason };
}

function checkString(spec: FieldSpec, value: string, issues: S0FieldIssue[]): void {
  if (spec.minWords && wordCount(value) < spec.minWords) {
    issues.push(issue(spec, `needs at least ${spec.minWords} words (got ${wordCount(value)}) — specifics are what make the output good`));
  }
  if (spec.placeholder && isPlaceholderEcho(value, spec.placeholder)) {
    issues.push(issue(spec, 'answer looks like a copy of our example — tell us about YOUR business in your own words'));
  }
}

function checkSelect(spec: FieldSpec, value: FieldValue, issues: S0FieldIssue[]): void {
  if (typeof value !== 'string' || !value.trim()) {
    issues.push(issue(spec, 'expected one of the listed options'));
    return;
  }
  if (spec.options && !spec.options.includes(value) && !spec.allowOther) {
    issues.push(issue(spec, `"${value}" is not one of: ${spec.options.join(' / ')}`));
  }
}

function checkMultiSelect(spec: FieldSpec, value: FieldValue, issues: S0FieldIssue[]): void {
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    issues.push(issue(spec, 'expected a list of options'));
    return;
  }
  const values = value as string[];
  if (spec.minSelections && values.length < spec.minSelections) {
    issues.push(issue(spec, `pick at least ${spec.minSelections}`));
  }
  if (spec.maxSelections && values.length > spec.maxSelections) {
    issues.push(issue(spec, `pick at most ${spec.maxSelections} (got ${values.length})`));
  }
  if (spec.options && !spec.allowOther) {
    for (const v of values) {
      if (!spec.options.includes(v)) {
        issues.push(issue(spec, `"${v}" is not one of: ${spec.options.join(' / ')}`));
      }
    }
  }
}

function checkNumber(spec: FieldSpec, value: FieldValue, issues: S0FieldIssue[]): void {
  const n = typeof value === 'string' ? Number(value.replace(/[£$,\s]/g, '')) : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) {
    issues.push(issue(spec, 'expected a number'));
    return;
  }
  if (spec.id === 'B2' && n <= 0) {
    issues.push(issue(spec, 'average sale value must be greater than zero'));
  }
}

function checkSliders(spec: FieldSpec, value: FieldValue, issues: S0FieldIssue[]): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    issues.push(issue(spec, 'expected the three voice sliders'));
    return;
  }
  for (const key of spec.sliderKeys ?? []) {
    const v = (value as Record<string, unknown>)[key];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 5) {
      issues.push(issue(spec, `slider "${key}" must be a whole number 1–5`));
    }
  }
}

function checkUrlList(spec: FieldSpec, value: FieldValue, issues: S0FieldIssue[]): void {
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string' || !v.trim())) {
    issues.push(issue(spec, 'expected a list of links'));
  }
}

function checkTwoBox(spec: FieldSpec, value: FieldValue, issues: S0FieldIssue[]): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    issues.push(issue(spec, 'expected the two text boxes'));
    return;
  }
  for (const key of Object.keys(value)) {
    if (!(spec.boxKeys ?? []).includes(key)) {
      issues.push(issue(spec, `unexpected key "${key}" (allowed: ${(spec.boxKeys ?? []).join(', ')})`));
    }
  }
}

export function runS0(intake: Intake): S0Result {
  const issues: S0FieldIssue[] = [];

  // Unknown field IDs are a contract violation from the intake webhook side.
  for (const id of Object.keys(intake)) {
    if (id.startsWith('_')) continue; // metadata keys like _fixture_notice
    if (!FIELD_BY_ID.has(id)) {
      issues.push({ field: id, label: '(unknown)', reason: 'not a Deep Intake v1.0 field ID' });
    }
  }

  for (const spec of INTAKE_FIELDS) {
    const value: FieldValue = intake[spec.id] ?? null;
    const required = isRequired(spec, intake);

    if (isEmpty(value)) {
      if (required) issues.push(issue(spec, 'required — please answer this one'));
      continue;
    }

    switch (spec.kind) {
      case 'short_text':
      case 'text':
      case 'textarea':
        if (typeof value !== 'string') issues.push(issue(spec, 'expected text'));
        else checkString(spec, value, issues);
        break;
      case 'number':
        checkNumber(spec, value, issues);
        break;
      case 'select':
        checkSelect(spec, value, issues);
        break;
      case 'multi_select':
        checkMultiSelect(spec, value, issues);
        break;
      case 'url_list':
        checkUrlList(spec, value, issues);
        break;
      case 'sliders':
        checkSliders(spec, value, issues);
        break;
      case 'two_box':
        checkTwoBox(spec, value, issues);
        break;
    }
  }

  const accepted = issues.length === 0;
  return {
    accepted,
    action: accepted ? 'accept' : 'nudge',
    issues,
    checked_at: new Date().toISOString(),
  };
}
