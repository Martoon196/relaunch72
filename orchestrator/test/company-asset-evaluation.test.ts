import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  COMPANY_ASSET_EVAL_DIMENSIONS,
  COMPANY_ASSET_EVAL_RUNNER,
  CompanyAssetEvaluationContractError,
  evaluateCompanyAssetRegressionSuite,
} from '../src/company-asset-release/evaluation.js';

const SHA = {
  release: '11'.repeat(32), scope: '22'.repeat(32), brain: '33'.repeat(32),
  input: '44'.repeat(32), output: '55'.repeat(32), evidence: '66'.repeat(32),
} as const;

const reasons = {
  brand: { accept: 'brand_style_match', reject: 'brand_style_violation' },
  avatar: { accept: 'avatar_fit_match', reject: 'avatar_fit_violation' },
  claims: { accept: 'claims_supported', reject: 'claims_unsubstantiated' },
  disclosure: { accept: 'disclosure_present', reject: 'disclosure_missing' },
  visual_policy: { accept: 'visual_policy_match', reject: 'visual_policy_conflict' },
} as const;

function fixture() {
  const cases = COMPANY_ASSET_EVAL_DIMENSIONS.flatMap((dimension) => ([
    {
      caseId: `a-${dimension}-golden`, caseKind: 'golden', dimension,
      inputSha256: SHA.input, outputSha256: SHA.output, evidenceSha256: SHA.evidence,
      expectedDisposition: 'accept', observedDisposition: 'accept',
      reasonCode: reasons[dimension].accept,
    },
    {
      caseId: `b-${dimension}-rejected`, caseKind: 'rejected', dimension,
      inputSha256: SHA.input, outputSha256: SHA.output, evidenceSha256: SHA.evidence,
      expectedDisposition: 'reject', observedDisposition: 'reject',
      reasonCode: reasons[dimension].reject,
    },
  ])).sort((left, right) => left.caseId.localeCompare(right.caseId));
  return {
    brandBrainPackageSha256: SHA.brain,
    cases,
    runnerVersion: COMPANY_ASSET_EVAL_RUNNER,
    schemaVersion: 1,
    sourceReleaseSha256: SHA.release,
    sourceScopeSha256: SHA.scope,
    suiteId: 'property-predator-company-assets-test-v1',
  };
}

test('evaluates complete hash-only golden and rejected coverage deterministically', () => {
  const first = evaluateCompanyAssetRegressionSuite(fixture());
  const second = evaluateCompanyAssetRegressionSuite(fixture());
  assert.equal(first.caseCount, 10);
  assert.equal(first.goldenCaseCount, 5);
  assert.equal(first.rejectedCaseCount, 5);
  assert.equal(first.passedCaseCount, 10);
  assert.equal(first.passed, true);
  assert.equal(first.reportSha256, second.reportSha256);
  assert.equal(first.modelCalls, false);
  assert.equal(first.providerEffects, false);
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(first.cases));
  assert.ok(Object.isFrozen(first.cases[0]));
});

test('one observed regression makes the report fail without changing expected policy', () => {
  const input = fixture();
  const changedDisposition = input.cases[0]!.expectedDisposition === 'accept'
    ? 'reject' as const : 'accept' as const;
  input.cases[0]!.observedDisposition = changedDisposition;
  input.cases[0]!.reasonCode = changedDisposition === 'accept'
    ? reasons[input.cases[0]!.dimension].accept
    : reasons[input.cases[0]!.dimension].reject;
  const report = evaluateCompanyAssetRegressionSuite(input);
  assert.equal(report.passed, false);
  assert.equal(report.passedCaseCount, 9);
  assert.equal(report.cases[0]!.passed, false);
});

test('fails closed on missing coverage, duplicate identities, noncanonical order and forged policy', () => {
  const missing = fixture();
  missing.cases.pop();
  assert.throws(() => evaluateCompanyAssetRegressionSuite(missing), CompanyAssetEvaluationContractError);

  const duplicate = fixture();
  duplicate.cases[1]!.caseId = duplicate.cases[0]!.caseId;
  assert.throws(() => evaluateCompanyAssetRegressionSuite(duplicate), CompanyAssetEvaluationContractError);

  const unordered = fixture();
  unordered.cases.reverse();
  assert.throws(() => evaluateCompanyAssetRegressionSuite(unordered), CompanyAssetEvaluationContractError);

  const forged = fixture();
  forged.cases[0]!.reasonCode = 'claims_unsubstantiated';
  assert.throws(() => evaluateCompanyAssetRegressionSuite(forged), CompanyAssetEvaluationContractError);
});

test('rejects unknown fields, semantic bodies and unsupported runner/schema versions', () => {
  const unknown = fixture() as ReturnType<typeof fixture> & { prompt?: string };
  unknown.prompt = 'do not retain me';
  assert.throws(() => evaluateCompanyAssetRegressionSuite(unknown), CompanyAssetEvaluationContractError);

  const caseBody = fixture() as ReturnType<typeof fixture>;
  Object.assign(caseBody.cases[0]!, { outputBody: 'private semantic output' });
  assert.throws(() => evaluateCompanyAssetRegressionSuite(caseBody), CompanyAssetEvaluationContractError);

  const runner = fixture();
  runner.runnerVersion = 'some-model/v1' as typeof COMPANY_ASSET_EVAL_RUNNER;
  assert.throws(() => evaluateCompanyAssetRegressionSuite(runner), CompanyAssetEvaluationContractError);

  const schema = fixture();
  schema.schemaVersion = 2;
  assert.throws(() => evaluateCompanyAssetRegressionSuite(schema), CompanyAssetEvaluationContractError);
});

test('rejects Proxies, accessors, sparse arrays and exotic objects without executing getters', () => {
  let getterCalls = 0;
  const accessor = fixture();
  Object.defineProperty(accessor, 'suiteId', {
    enumerable: true,
    get() { getterCalls += 1; return 'unsafe'; },
  });
  assert.throws(() => evaluateCompanyAssetRegressionSuite(accessor), CompanyAssetEvaluationContractError);
  assert.equal(getterCalls, 0);

  let proxyTraps = 0;
  const proxy = new Proxy(fixture(), {
    get() { proxyTraps += 1; throw new Error('trap'); },
    ownKeys() { proxyTraps += 1; throw new Error('trap'); },
    getPrototypeOf() { proxyTraps += 1; throw new Error('trap'); },
    getOwnPropertyDescriptor() { proxyTraps += 1; throw new Error('trap'); },
  });
  assert.throws(() => evaluateCompanyAssetRegressionSuite(proxy), CompanyAssetEvaluationContractError);
  assert.equal(proxyTraps, 0);

  const sparse = fixture();
  delete sparse.cases[0];
  assert.throws(() => evaluateCompanyAssetRegressionSuite(sparse), CompanyAssetEvaluationContractError);

  const exotic = fixture() as unknown as { cases: unknown };
  exotic.cases = new Date();
  assert.throws(() => evaluateCompanyAssetRegressionSuite(exotic), CompanyAssetEvaluationContractError);
});

test('implementation has no model, network, database, prompt or provider operation path', async () => {
  const source = await readFile(new URL('../src/company-asset-release/evaluation.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /@anthropic-ai|openai|fetch\s*\(|https?:\/\/|node:net|node:http|\bpg\b/i);
  assert.doesNotMatch(source, /INSERT INTO|provider_operations|enqueue|publish|sendMessage|rawPrompt|knowledgeBody/i);
  assert.match(source, /providerEffects: false/);
  assert.match(source, /modelCalls: false/);
});
