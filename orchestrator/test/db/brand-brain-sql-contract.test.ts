import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migrationUrl = new URL('../../src/db/migrations/0031_property_predator_brand_brain_foundation.sql', import.meta.url);
const repositoryUrl = new URL('../../src/brand-brain-pg/repository.ts', import.meta.url);
const serviceUrl = new URL('../../src/brand-brain-pg/service.ts', import.meta.url);
const plannerUrl = new URL('../../src/brand-brain-pg/effects-off-planner.ts', import.meta.url);
const inventoryUrl = new URL('../../src/company-content-adapter/property-predator-ai-inventory.ts', import.meta.url);
const evalFixtureUrl = new URL('../fixtures/property-predator-brand-brain-eval-v1.golden.json', import.meta.url);

const TABLES = [
  'brand_brain_source_releases',
  'brand_brain_source_version_refs',
  'brand_brain_specialist_profile_refs',
  'brand_brain_specialist_source_refs',
  'brand_brain_artwork_version_refs',
  'brand_brain_quarantines',
  'brand_brain_quarantine_source_refs',
  'brand_brain_source_attestations',
  'brand_brain_eval_results',
  'brand_brain_review_decisions',
  'brand_brain_activations',
] as const;

function normalise(value: string): string {
  return value.replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ').trim();
}

test('0031 stores only private immutable hash references with forced workspace isolation', async () => {
  const sql = normalise(await readFile(migrationUrl, 'utf8'));
  for (const table of TABLES) {
    assert.match(sql, new RegExp(`CREATE TABLE app_private\\.${table} \\(`));
    assert.match(sql, new RegExp(`'${table}'`));
  }
  assert.match(sql, /ALTER TABLE app_private\.%I ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /ALTER TABLE app_private\.%I FORCE ROW LEVEL SECURITY/);
  assert.match(sql, /workspace_id = app_private\.current_workspace_id\(\)/);
  assert.match(sql, /FOREIGN KEY \(workspace_id, source_release_id, specialist_profile_ref_id\)/);
  assert.match(sql, /FOREIGN KEY \(workspace_id, source_release_id, source_version_ref_id\)/);
  assert.equal(
    (sql.match(/UNIQUE \(workspace_id, source_release_id, id\)/g) ?? []).length,
    3,
    'every composite child reference must have an exact PostgreSQL parent key',
  );
  assert.match(sql, /FOREIGN KEY \(workspace_id, source_release_id, manifest_sha256\)/);
  assert.match(sql, /BEFORE UPDATE OR DELETE ON app_private\.%I/);
  assert.match(sql, /Brand Brain inventory, evidence and decisions are append-only/);
  assert.doesNotMatch(sql, /CREATE (?:USER|ROLE)/);
  assert.doesNotMatch(sql, /CREATE TABLE app\./);
  assert.doesNotMatch(sql, /TO r72_web/);
});

test('0031 pins the exact source package and the exact held-out offline evaluation suite', async () => {
  const sql = normalise(await readFile(migrationUrl, 'utf8'));
  assert.match(sql, /d55afac02ac995f6157749181cf230ea8acc23b7b129dd6f92f63bcd04b57300/);
  assert.match(sql, /d77b0306d110075571dedd716d012c8752a302eb39ea9198e71ecd43cc089abc/);
  assert.match(sql, /88ca474133d36bbc4345f180e9045feb31d9ddec6b2bb0a5eb810c894f22de51/);
  assert.match(sql, /runner_version = 'property-predator-brand-brain-offline-eval\/v1'/);
  assert.match(sql, /positive_case_count = 4/);
  assert.match(sql, /negative_case_count = 5/);
  assert.match(sql, /passed = \(passed_case_count = positive_case_count \+ negative_case_count\)/);
  assert.doesNotMatch(sql, /safe_summary|prompt|expected_text|raw_blob|embedding|vector_store/i);
});

test('0031 rejects semantic parser bypass and incomplete runtime relationships before activation', async () => {
  const sql = normalise(await readFile(migrationUrl, 'utf8'));
  assert.match(sql, /guard_brand_brain_source_insert/);
  assert.match(sql, /guard_brand_brain_specialist_insert/);
  assert.match(sql, /manifest_profile -> 'capabilities' IS DISTINCT FROM NEW\.capabilities/);
  assert.match(sql, /manifest_quarantine -> 'ruleIds' IS DISTINCT FROM NEW\.rule_ids/);
  assert.match(sql, /manifest_profile ->> 'roleSourceId' <> selected_source_id/);
  assert.match(sql, /manifest_profile -> 'instructionSourceIds' \? selected_source_id/);
  assert.match(sql, /manifest_quarantine -> 'sourceIds' \? selected_source_id/);
  assert.match(sql, /count\(\*\) FILTER \(WHERE reference\.reference_kind = 'role'\) <> 1/);
  assert.match(sql, /count\(\*\) FILTER \(WHERE reference\.reference_kind = 'policy'\) <> 1/);
  assert.match(sql, /count\(\*\) FILTER \(WHERE reference\.reference_kind = 'instruction'\) <> 1/);
  assert.match(sql, /count\(\*\) FILTER \(WHERE reference\.reference_kind = 'knowledge'\) <> 1/);
  assert.match(sql, /count\(reference\.id\) <> 2/);
  assert.match(sql, /requires all three independent approvals/);
  assert.match(sql, /requires a passing exact-manifest evaluation/);
  assert.match(sql, /requires a fresh source attestation/);
});

test('Brand Brain code has no model, network, vector, file-upload or provider execution path', async () => {
  const sources = await Promise.all([
    repositoryUrl, serviceUrl, plannerUrl, inventoryUrl,
  ].map((url) => readFile(url, 'utf8')));
  const joined = sources.join('\n');
  assert.doesNotMatch(joined,
    /@anthropic-ai|openai|fetch\s*\(|https?:\/\/|vector(?:store)?|embedding|file.?upload/i);
  assert.doesNotMatch(joined,
    /INSERT INTO app\.(?:provider_operations|outbox)|enqueue|sendMessage|publishPost/i);
  assert.match(joined, /providerEffects: false/);
  assert.match(joined, /callable: false/);

  const evalFixture = JSON.parse(await readFile(evalFixtureUrl, 'utf8')) as Record<string, unknown>;
  const serialized = JSON.stringify(evalFixture);
  assert.doesNotMatch(serialized, /"(?:prompt|content|expectedText|completion|model|provider)"\s*:/i);
});

test('0031 grants no provider effect capability to either Brand Brain role', async () => {
  const sql = normalise(await readFile(migrationUrl, 'utf8'));
  assert.match(sql, /provider_effects boolean NOT NULL DEFAULT false CHECK \(provider_effects IS FALSE\)/);
  assert.match(sql, /NEW\.provider_effects := false/);
  assert.match(sql, /has_table_privilege\('r72_content_adapter', 'app\.provider_operations', 'INSERT'\)/);
  assert.match(sql, /has_table_privilege\('r72_content_command', 'app\.provider_operations', 'INSERT'\)/);
  assert.match(sql, /pg_has_role\('r72_content_adapter', 'r72_worker', 'MEMBER'\)/);
  assert.match(sql, /pg_has_role\('r72_content_command', 'r72_worker', 'MEMBER'\)/);
  assert.doesNotMatch(sql, /GRANT INSERT ON app\.provider_operations/);
});
