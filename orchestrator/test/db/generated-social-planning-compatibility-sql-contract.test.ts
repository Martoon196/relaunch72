import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migration = new URL('../../src/db/migrations/0101_generated_social_planning_compatibility.sql', import.meta.url);

test('0101 is additive, discriminates proofs, fences v1 and grants only public v2 capabilities', async () => {
  const sql = await readFile(migration, 'utf8');
  assert.doesNotMatch(sql, /DROP\s+(?:FUNCTION|TABLE|COLUMN)/iu);
  assert.doesNotMatch(sql, /\$function\$\s+AND\s+\(/u);
  assert.match(sql, /ADD COLUMN evidence_type text NOT NULL DEFAULT 'legacy'/u);
  assert.match(sql, /evidence_type = 'legacy'[\s\S]+evidence_type = 'generated'/u);
  assert.ok((sql.match(/generated_version\.source_system = 'property_predator_generation'/gu) ?? []).length >= 4);
  assert.match(sql, /V2 therefore owns[\s\S]+revalidation\.cancelled[\s\S]+revalidation\.window_expired[\s\S]+revalidation\.lease_expired/u);
  assert.match(sql, /terminalise malformed metadata\/lineage before candidate leasing[\s\S]+revalidation\.generated_lineage_invalid/u);
  assert.ok((sql.match(/nearest_generated AS MATERIALIZED/gu) ?? []).length >= 3);
  assert.match(sql, /sourceDraftId'[\s\S]+pg_catalog\.pg_input_is_valid[\s\S]+sourceItemVersion'[\s\S]+2147483647/u);
  assert.match(sql, /later_request\.request_number>request\.request_number/u);
  assert.match(sql, /supplied\.approved_at<=p_checked_at[\s\S]+newer\.version_number>v\.version_number[\s\S]+later_request\.request_number>req\.request_number/u);
  assert.doesNotMatch(sql, /AND \(ancestor\.metadata->'source'->>'sourceVersionId'\)::uuid/u);
  assert.match(sql, /GRANT CREATE ON SCHEMA app_private TO r72_public_social_definer[\s\S]+REVOKE CREATE ON SCHEMA app_private FROM r72_public_social_definer/u);
  for (const name of [
    'claim_due_test_social_revalidations_v2',
    'load_leased_test_social_source_versions_v2',
    'complete_test_social_revalidation_v2',
    'complete_and_materialize_test_social_revalidation_v2',
  ]) assert.match(sql, new RegExp(`CREATE FUNCTION app_private\\.${name}\\(`, 'u'));
  assert.match(sql, /REVOKE ALL ON FUNCTION app_private\.complete_test_social_revalidation_v2[\s\S]+FROM PUBLIC/u);
  assert.doesNotMatch(sql, /GRANT EXECUTE ON FUNCTION app_private\.complete_test_social_revalidation_v2/u);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION app_private\.claim_due_test_social_revalidations_v2[\s\S]+complete_and_materialize_test_social_revalidation_v2[\s\S]+TO r72_public_social_revalidator_command/u);
});
