import { createHash } from 'node:crypto';
import { types as nodeUtilTypes } from 'node:util';

export const COMPANY_ASSET_EVAL_SCHEMA_VERSION = 1 as const;
export const COMPANY_ASSET_EVAL_RUNNER =
  'property-predator-company-asset-offline-eval/v1' as const;

const SHA256 = /^[0-9a-f]{64}$/u;
const SAFE_ID = /^[a-z0-9][a-z0-9._:-]{0,127}$/u;
const MAX_CASES = 100;
const MAX_DEPTH = 8;
const MAX_NODES = 2_000;
const MAX_KEYS = 4_000;
const MAX_STRING_CHARS = 256;
const MAX_TOTAL_STRING_CHARS = 64 * 1024;

export const COMPANY_ASSET_EVAL_DIMENSIONS = Object.freeze([
  'brand',
  'avatar',
  'claims',
  'disclosure',
  'visual_policy',
] as const);

export type CompanyAssetEvalDimension = typeof COMPANY_ASSET_EVAL_DIMENSIONS[number];
export type CompanyAssetEvalCaseKind = 'golden' | 'rejected';
export type CompanyAssetEvalDisposition = 'accept' | 'reject';

const REASON_CODES = Object.freeze({
  brand: Object.freeze({ accept: 'brand_style_match', reject: 'brand_style_violation' }),
  avatar: Object.freeze({ accept: 'avatar_fit_match', reject: 'avatar_fit_violation' }),
  claims: Object.freeze({ accept: 'claims_supported', reject: 'claims_unsubstantiated' }),
  disclosure: Object.freeze({ accept: 'disclosure_present', reject: 'disclosure_missing' }),
  visual_policy: Object.freeze({ accept: 'visual_policy_match', reject: 'visual_policy_conflict' }),
} as const);

const SUITE_KEYS = Object.freeze([
  'brandBrainPackageSha256',
  'cases',
  'runnerVersion',
  'schemaVersion',
  'sourceReleaseSha256',
  'sourceScopeSha256',
  'suiteId',
]);
const CASE_KEYS = Object.freeze([
  'caseId',
  'caseKind',
  'dimension',
  'evidenceSha256',
  'expectedDisposition',
  'inputSha256',
  'observedDisposition',
  'outputSha256',
  'reasonCode',
]);

export interface CompanyAssetEvalCaseResult {
  readonly caseId: string;
  readonly caseKind: CompanyAssetEvalCaseKind;
  readonly dimension: CompanyAssetEvalDimension;
  readonly inputSha256: string;
  readonly outputSha256: string;
  readonly evidenceSha256: string;
  readonly expectedDisposition: CompanyAssetEvalDisposition;
  readonly observedDisposition: CompanyAssetEvalDisposition;
  readonly reasonCode: string;
  readonly passed: boolean;
}

export interface CompanyAssetEvalReport {
  readonly schemaVersion: 1;
  readonly suiteId: string;
  readonly runnerVersion: typeof COMPANY_ASSET_EVAL_RUNNER;
  readonly sourceReleaseSha256: string;
  readonly sourceScopeSha256: string;
  readonly brandBrainPackageSha256: string;
  readonly caseCount: number;
  readonly goldenCaseCount: number;
  readonly rejectedCaseCount: number;
  readonly passedCaseCount: number;
  readonly passed: boolean;
  readonly cases: readonly CompanyAssetEvalCaseResult[];
  readonly reportSha256: string;
  readonly providerEffects: false;
  readonly modelCalls: false;
}

export class CompanyAssetEvaluationContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CompanyAssetEvaluationContractError';
  }
}

type JsonPrimitive = null | boolean | number | string;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

interface SnapshotBudget {
  nodes: number;
  keys: number;
  stringChars: number;
}

function contractError(detail: string): never {
  throw new CompanyAssetEvaluationContractError(`company asset evaluation ${detail}`);
}

function deepFreeze<T>(value: T, seen = new Set<object>()): Readonly<T> {
  if (value && typeof value === 'object' && !seen.has(value)) {
    seen.add(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child, seen);
    Object.freeze(value);
  }
  return value;
}

function snapshot(value: unknown, path: string, depth: number, budget: SnapshotBudget): JsonValue {
  budget.nodes += 1;
  if (budget.nodes > MAX_NODES) contractError('exceeds the node bound');
  if (depth > MAX_DEPTH) contractError('exceeds the depth bound');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) contractError(`${path} contains a non-finite number`);
    return value;
  }
  if (typeof value === 'string') {
    if (value.length > MAX_STRING_CHARS) contractError(`${path} contains an oversized string`);
    budget.stringChars += value.length;
    if (budget.stringChars > MAX_TOTAL_STRING_CHARS) contractError('exceeds the string bound');
    return value;
  }
  if (typeof value !== 'object') contractError(`${path} is not plain JSON data`);
  if (nodeUtilTypes.isProxy(value)) contractError(`${path} must not be a Proxy`);

  let prototype: object | null;
  let descriptors: PropertyDescriptorMap;
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    contractError(`${path} cannot be inspected as plain data`);
  }

  if (Array.isArray(value)) {
    if (prototype !== Array.prototype) contractError(`${path} has a surprising array prototype`);
    const lengthDescriptor = descriptors.length;
    const length = lengthDescriptor && 'value' in lengthDescriptor ? lengthDescriptor.value : -1;
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_CASES) {
      contractError(`${path} exceeds the array bound`);
    }
    const keys = Reflect.ownKeys(descriptors).filter((key) => key !== 'length');
    if (keys.some((key) => typeof key !== 'string') || keys.length !== length) {
      contractError(`${path} must be a dense array without extra properties`);
    }
    budget.keys += keys.length;
    if (budget.keys > MAX_KEYS) contractError('exceeds the key bound');
    const output: JsonValue[] = new Array(length);
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
        contractError(`${path}[${index}] is not an enumerable data property`);
      }
      output[index] = snapshot(descriptor.value, `${path}[${index}]`, depth + 1, budget);
    }
    return output;
  }

  if (prototype !== Object.prototype && prototype !== null) {
    contractError(`${path} has a surprising object prototype`);
  }
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== 'string')) contractError(`${path} contains a symbol key`);
  budget.keys += keys.length;
  if (budget.keys > MAX_KEYS) contractError('exceeds the key bound');
  const output = Object.create(null) as { [key: string]: JsonValue };
  for (const rawKey of keys) {
    const key = rawKey as string;
    if (!/^[A-Za-z][A-Za-z0-9]*$/u.test(key)) contractError(`${path} contains an unsafe key`);
    const descriptor = descriptors[key];
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
      contractError(`${path}.${key} is not an enumerable data property`);
    }
    output[key] = snapshot(descriptor.value, `${path}.${key}`, depth + 1, budget);
  }
  return output;
}

function plainRecord(input: unknown): Record<string, JsonValue> {
  const value = snapshot(input, 'suite', 0, { nodes: 0, keys: 0, stringChars: 0 });
  if (!value || typeof value !== 'object' || Array.isArray(value)) contractError('suite must be an object');
  return value;
}

function exactKeys(value: Record<string, JsonValue>, expected: readonly string[], path: string): void {
  const keys = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (keys.length !== wanted.length || keys.some((key, index) => key !== wanted[index])) {
    contractError(`${path} does not match the exact schema`);
  }
}

function asRecord(value: JsonValue | undefined, path: string): Record<string, JsonValue> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) contractError(`${path} must be an object`);
  return value;
}

function exactString(value: JsonValue | undefined, path: string): string {
  if (typeof value !== 'string') contractError(`${path} must be a string`);
  return value;
}

function safeId(value: JsonValue | undefined, path: string): string {
  const text = exactString(value, path);
  if (!SAFE_ID.test(text)) contractError(`${path} is invalid`);
  return text;
}

function sha256(value: JsonValue | undefined, path: string): string {
  const text = exactString(value, path);
  if (!SHA256.test(text)) contractError(`${path} is invalid`);
  return text;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`);
  return `{${entries.join(',')}}`;
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function oneOf<T extends string>(value: JsonValue | undefined, allowed: readonly T[], path: string): T {
  const text = exactString(value, path);
  if (!allowed.includes(text as T)) contractError(`${path} is unsupported`);
  return text as T;
}

/**
 * Evaluates hash-addressed, pre-reviewed observations only. It deliberately has
 * no prompt, output-body, model, file, network, database or provider surface.
 */
export function evaluateCompanyAssetRegressionSuite(input: unknown): CompanyAssetEvalReport {
  const suite = plainRecord(input);
  exactKeys(suite, SUITE_KEYS, 'suite');
  if (suite.schemaVersion !== COMPANY_ASSET_EVAL_SCHEMA_VERSION) {
    contractError('suite.schemaVersion is unsupported');
  }
  if (suite.runnerVersion !== COMPANY_ASSET_EVAL_RUNNER) {
    contractError('suite.runnerVersion is unsupported');
  }
  const suiteId = safeId(suite.suiteId, 'suite.suiteId');
  const sourceReleaseSha256 = sha256(suite.sourceReleaseSha256, 'suite.sourceReleaseSha256');
  const sourceScopeSha256 = sha256(suite.sourceScopeSha256, 'suite.sourceScopeSha256');
  const brandBrainPackageSha256 = sha256(
    suite.brandBrainPackageSha256,
    'suite.brandBrainPackageSha256',
  );
  if (!Array.isArray(suite.cases) || suite.cases.length < COMPANY_ASSET_EVAL_DIMENSIONS.length * 2) {
    contractError('suite.cases must cover golden and rejected outcomes for every dimension');
  }

  const identities = new Set<string>();
  const coverage = new Set<string>();
  let previousCaseId: string | null = null;
  const cases = suite.cases.map((rawCase, index): CompanyAssetEvalCaseResult => {
    const candidate = asRecord(rawCase, `suite.cases[${index}]`);
    exactKeys(candidate, CASE_KEYS, `suite.cases[${index}]`);
    const caseId = safeId(candidate.caseId, `suite.cases[${index}].caseId`);
    if (identities.has(caseId)) contractError('suite.cases repeats a caseId');
    if (previousCaseId !== null && caseId <= previousCaseId) {
      contractError('suite.cases must use canonical caseId order');
    }
    identities.add(caseId);
    previousCaseId = caseId;
    const caseKind = oneOf(candidate.caseKind, ['golden', 'rejected'] as const, `suite.cases[${index}].caseKind`);
    const dimension = oneOf(candidate.dimension, COMPANY_ASSET_EVAL_DIMENSIONS, `suite.cases[${index}].dimension`);
    const expectedDisposition = oneOf(
      candidate.expectedDisposition,
      ['accept', 'reject'] as const,
      `suite.cases[${index}].expectedDisposition`,
    );
    const observedDisposition = oneOf(
      candidate.observedDisposition,
      ['accept', 'reject'] as const,
      `suite.cases[${index}].observedDisposition`,
    );
    if ((caseKind === 'golden') !== (expectedDisposition === 'accept')) {
      contractError(`suite.cases[${index}] kind and expected disposition disagree`);
    }
    const expectedReason = REASON_CODES[dimension][observedDisposition];
    const reasonCode = exactString(candidate.reasonCode, `suite.cases[${index}].reasonCode`);
    if (reasonCode !== expectedReason) contractError(`suite.cases[${index}].reasonCode is unsupported`);
    coverage.add(`${dimension}:${caseKind}`);
    return deepFreeze({
      caseId,
      caseKind,
      dimension,
      inputSha256: sha256(candidate.inputSha256, `suite.cases[${index}].inputSha256`),
      outputSha256: sha256(candidate.outputSha256, `suite.cases[${index}].outputSha256`),
      evidenceSha256: sha256(candidate.evidenceSha256, `suite.cases[${index}].evidenceSha256`),
      expectedDisposition,
      observedDisposition,
      reasonCode,
      passed: expectedDisposition === observedDisposition,
    });
  });

  for (const dimension of COMPANY_ASSET_EVAL_DIMENSIONS) {
    for (const caseKind of ['golden', 'rejected'] as const) {
      if (!coverage.has(`${dimension}:${caseKind}`)) {
        contractError(`suite.cases does not cover ${dimension}:${caseKind}`);
      }
    }
  }
  const goldenCaseCount = cases.filter((entry) => entry.caseKind === 'golden').length;
  const rejectedCaseCount = cases.length - goldenCaseCount;
  const passedCaseCount = cases.filter((entry) => entry.passed).length;
  const reportBody = {
    schemaVersion: 1 as const,
    suiteId,
    runnerVersion: COMPANY_ASSET_EVAL_RUNNER,
    sourceReleaseSha256,
    sourceScopeSha256,
    brandBrainPackageSha256,
    caseCount: cases.length,
    goldenCaseCount,
    rejectedCaseCount,
    passedCaseCount,
    passed: passedCaseCount === cases.length,
    cases: Object.freeze(cases),
    providerEffects: false as const,
    modelCalls: false as const,
  };
  return deepFreeze({ ...reportBody, reportSha256: digest(reportBody) });
}
