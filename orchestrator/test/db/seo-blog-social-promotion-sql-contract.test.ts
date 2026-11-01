/**
 * Text contract for migration 0132 (SEO blog social promotion). It locks the
 * narrow additive seams this run was allowed to open and proves the earlier
 * migrations it builds on were not edited.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const url132 = new URL('../../src/db/migrations/0132_seo_blog_social_promotion.sql', import.meta.url);
const url131 = new URL('../../src/db/migrations/0131_seo_blog_engine.sql', import.meta.url);
const url097 = new URL('../../src/db/migrations/0097_property_predator_zernio_calendar_safe_cutover.sql', import.meta.url);
const url085 = new URL('../../src/db/migrations/0085_property_predator_zernio_calendar_publishing.sql', import.meta.url);
const url101 = new URL('../../src/db/migrations/0101_generated_social_planning_compatibility.sql', import.meta.url);

async function sql(target: URL): Promise<string> {
  return (await readFile(target, 'utf8')).replace(/\r\n?/g, '\n');
}
function checksum(source: string): string {
  return createHash('sha256').update(source, 'utf8').digest('hex');
}
function source097Sibling(source: string, start: string): string {
  const from = source.indexOf(start);
  assert.notEqual(from, -1, `missing ${start}`);
  const to = source.indexOf('$function$;', from);
  return source.slice(from, to + '$function$;'.length);
}
function between(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  assert.notEqual(from, -1, `missing ${start}`);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(to, -1, `missing ${end} after ${start}`);
  return source.slice(from, to);
}

test('0131 and the two named PP seams are untouched; 0132 is purely additive on top of them', async () => {
  assert.equal(checksum(await sql(url131)), '904c4651c51da6507370ca7eb2f271ca0347a27d76c60b0f24a19aba01695784');
  const source097 = await sql(url097);
  assert.equal((source097.match(/'daily=1;monthly=3'/g) ?? []).length, 3, 'SQL0097 literal caps stay literal for PP');
  const source101 = await sql(url101);
  assert.match(source101, /version\.source_system = 'propertypredator\.company-content'/u);
  assert.match(source101, /version\.source_system = 'property_predator_generation'/u);
  assert.doesNotMatch(source101, /relaunch72\.seo-blog/u, 'SQL0101 still admits only the two PP source systems');
  const source = await sql(url132);
  assert.doesNotMatch(source, /ALTER TABLE app\.seo_blog_(brands|articles|article_versions|records|jobs|publications)\b/u);
  assert.doesNotMatch(source, /DROP (TABLE|FUNCTION|POLICY)/u);
  assert.doesNotMatch(source, /CREATE OR REPLACE FUNCTION app_private\.(enqueue_zernio_calendar_job|enqueue_zernio_calendar_from_connected_account|create_test_social_planning_intent|settle_zernio_calendar_call|load_zernio_calendar_job|owned_social_job_effect_ready_v2)\b/u);
  assert.deepEqual([...source.matchAll(/CREATE OR REPLACE FUNCTION app_private\.([a-z_]+)/g)].map(m => m[1]), ['zernio_calendar_job_effect_ready', 'begin_zernio_calendar_call', 'claim_zernio_calendar_job'],
    'exactly the three named 0085/0097 functions are re-created; every other function is new');
  // The claim re-creation is the 0085 body byte-for-byte plus the one PL/pgSQL directive that makes
  // `ON CONFLICT (workspace_id, job_id)` resolvable while the function also returns a job_id column.
  const claim085 = source097Sibling(await sql(url085), 'CREATE FUNCTION app_private.claim_zernio_calendar_job(');
  const claim132 = source097Sibling(source, 'CREATE OR REPLACE FUNCTION app_private.claim_zernio_calendar_job(');
  assert.equal(claim132, claim085.replace('CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION').replace('AS $function$\n', 'AS $function$\n#variable_conflict use_column\n'));
});

test('0132 keeps the PP legacy cap and hash paths exact and adds the registry branch beside them', async () => {
  const source = await sql(url132);
  const effectReady = between(source, 'CREATE OR REPLACE FUNCTION app_private.zernio_calendar_job_effect_ready(', 'CREATE OR REPLACE FUNCTION app_private.begin_zernio_calendar_call(');
  assert.equal((effectReady.match(/'daily=1;monthly=3'/g) ?? []).length, 1, 'legacy effect-ready expression is the exact 0097 body');
  assert.match(effectReady, /\) OR app_private\.seo_blog_zernio_job_effect_ready\(p_workspace_id, p_job_id\);/u);
  const capOk = between(source, 'CREATE FUNCTION app_private.zernio_calendar_job_cap_ok(', 'CREATE FUNCTION app_private.seo_blog_zernio_job_effect_ready(');
  assert.match(capOk, /WHEN NOT EXISTS \(\s*SELECT 1 FROM app\.seo_blog_social_job_caps/u);
  assert.match(capOk, /AND capped_day\.state <> 'cancelled'\) <= 1/u);
  assert.match(capOk, /AND capped_month\.state <> 'cancelled'\) <= 3/u);
  assert.match(capOk, /<= least\(caps\.daily_cap, binding\.daily_cap\)/u);
  assert.match(capOk, /<= least\(caps\.monthly_cap, binding\.monthly_cap\)/u);
  assert.match(capOk, /binding\.daily_cap > 0 AND binding\.monthly_cap > 0/u);
  const begin = between(source, 'CREATE OR REPLACE FUNCTION app_private.begin_zernio_calendar_call(', 'CREATE FUNCTION app_private.seo_blog_enqueue_zernio_calendar(');
  assert.match(begin, /AND app_private\.zernio_calendar_job_cap_ok\(job\.workspace_id, job\.id\)/u);
  assert.doesNotMatch(begin, /<= 1\b|<= 3\b/u, 'begin-call delegates both caps to the single cap predicate');
  const enqueue = between(source, 'CREATE FUNCTION app_private.seo_blog_enqueue_zernio_calendar(', 'RESET ROLE;');
  assert.match(enqueue, /selected_caps_label := 'daily=' \|\| selected_binding\.daily_cap::text \|\| ';monthly=' \|\| selected_binding\.monthly_cap::text;/u);
  assert.match(enqueue, /'relaunch72\.seo-blog-zernio-calendar-command\/v1'/u);
  assert.match(enqueue, /'relaunch72\.seo-blog-zernio-calendar-job\/v1'/u);
  assert.match(enqueue, /RAISE EXCEPTION 'Instagram promotion requires a real approved image' USING ERRCODE = '55000'/u);
  assert.match(enqueue, /RAISE EXCEPTION 'SEO social publishing is switched off for this brand' USING ERRCODE = '55000'/u);
  assert.match(enqueue, /app_private\.seo_blog_assert_article_promotion\(/u);
  assert.match(enqueue, /current_setting\('transaction_isolation'\) IS DISTINCT FROM 'serializable'/u);
  const readiness = between(source, 'CREATE FUNCTION app_private.seo_blog_zernio_job_effect_ready(', 'CREATE OR REPLACE FUNCTION app_private.zernio_calendar_job_effect_ready(');
  assert.match(readiness, /app_private\.owned_social_job_effect_ready_v2\(p_workspace_id, p_job_id\)/u);
  assert.match(readiness, /app_private\.zernio_calendar_binding_ready\(/u);
  assert.match(readiness, /'relaunch72\.seo-blog-zernio-calendar-command\/v1'/u);
  assert.match(readiness, /source_system = 'relaunch72\.seo-blog'/u);
});

test('0132 attestation is short-lived, exact-source and worker-only; planning admits only verified-public SEO parents', async () => {
  const source = await sql(url132);
  const attest = between(source, 'CREATE FUNCTION app_private.seo_blog_attest_due_promotions(', 'CREATE FUNCTION app_private.seo_blog_social_attestation_workspaces(');
  assert.match(attest, /session_user <> 'r72_content_command'/u);
  assert.match(attest, /current_setting\('app\.actor_kind', true\) IS DISTINCT FROM 'worker'/u);
  assert.match(attest, /statement_timestamp\(\) \+ interval '15 minutes'/u);
  assert.match(attest, /interval '10 minutes' THEN\s*CONTINUE;/u);
  assert.match(attest, /last_error_code = 'seo\.parent_changed'/u);
  assert.match(attest, /last_error_code = 'seo\.window_expired'/u);
  assert.match(attest, /'relaunch72\.seo-blog-promotion-proof\/v1'/u);
  assert.match(attest, /app_private\.seo_blog_assert_article_promotion\([\s\S]*?, true\)/u);
  const planning = between(source, 'CREATE FUNCTION app_private.seo_blog_create_promotion_planning_intent(', 'CREATE FUNCTION app_private.seo_blog_attest_due_promotions(');
  assert.match(planning, /source_system = 'relaunch72\.seo-blog'|source_system <> 'relaunch72\.seo-blog'/u);
  assert.match(planning, /app_private\.seo_blog_assert_article_promotion\([\s\S]*?, true\)/u);
  assert.match(planning, /GREATEST\(p_desired_for - interval '10 minutes', statement_timestamp\(\)\)/u);
  const guard = between(source, 'CREATE FUNCTION app_private.seo_blog_assert_article_promotion(', 'CREATE FUNCTION app_private.seo_blog_register_zernio_profile(');
  assert.match(guard, /article\.data->>'currentVersionId' = p_article_version_id::text/u);
  assert.match(guard, /version\.data->'promotionPack'->>'canonicalUrl' = p_canonical_url/u);
  assert.match(guard, /article\.data->>'publishedUrl' = p_canonical_url/u);
});

test('0132 role boundaries: definer-owned functions, table-blind login roles, exact grants per identity', async () => {
  const source = await sql(url132);
  for (const [fn, roles] of [
    ['seo_blog_assert_article_promotion(uuid, uuid, uuid, text, text, boolean)', 'r72_content_command, r72_content_adapter, r72_zernio_social_command, r72_owned_social_worker_command, r72_public_social_definer'],
    ['seo_blog_social_dispatch_targets()', 'r72_owned_social_worker_command'],
    ['begin_zernio_calendar_call(uuid, uuid, bigint, bytea, boolean, boolean)', 'r72_owned_social_worker_command'],
  ] as const) {
    assert.match(source, new RegExp(`GRANT EXECUTE ON FUNCTION app_private\\.${fn.replace(/[()]/g, '\\$&')}\\s+TO ${roles};`, 'u'), fn);
  }
  assert.match(source, /GRANT EXECUTE ON FUNCTION\s+app_private\.seo_blog_register_zernio_profile\(uuid, text, text\),\s+app_private\.seo_blog_zernio_profile_workspace\(bytea\),\s+app_private\.seo_blog_register_social_binding\(uuid, uuid, text, text, integer, integer\),\s+app_private\.seo_blog_revoke_social_binding\(uuid, uuid\),\s+app_private\.seo_blog_enqueue_zernio_calendar\(uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, text, timestamptz\)\s+TO r72_zernio_social_command;/u);
  assert.match(source, /GRANT EXECUTE ON FUNCTION app_private\.seo_blog_create_promotion_planning_intent\(uuid, uuid, uuid, timestamptz, uuid\[\]\)\s+TO r72_zernio_social_command;/u);
  assert.match(source, /GRANT EXECUTE ON FUNCTION app_private\.seo_blog_attest_due_promotions\(uuid\), app_private\.seo_blog_social_attestation_workspaces\(\)\s+TO r72_content_command;/u);
  assert.doesNotMatch(source, /GRANT [^\n]* TO PUBLIC/u);
  assert.doesNotMatch(source, /GRANT (SELECT|INSERT|UPDATE|DELETE)[^\n]*ON app\.seo_blog_(social_bindings|social_binding_events|social_job_caps|zernio_profiles)[^\n]*TO r72_(zernio_social_command|content_command|owned_social_worker_command|web)/u);
  for (const fn of source.matchAll(/CREATE (?:OR REPLACE )?FUNCTION app_private\.([a-z_]+)\([^)]*\)\s*RETURNS[\s\S]*?LANGUAGE (sql|plpgsql) (STABLE|VOLATILE)([^\n]*)/g)) {
    if (fn[1] === 'seo_blog_social_immutable') continue;
    assert.match(fn[4] ?? '', /SECURITY DEFINER SET search_path = pg_catalog/u, fn[1]);
  }
  assert.match(source, /RAISE EXCEPTION 'SEO social login role is not table-blind: %'/u);
  assert.match(source, /RAISE EXCEPTION 'SEO social function grants crossed a role boundary'/u);
  assert.match(source, /relation\.relname LIKE 'seo_blog_social_%' OR relation\.relname = 'seo_blog_zernio_profiles'/u);
  // Brand registration never reads PP's environment accounts: profiles are unique and verified per brand.
  assert.match(source, /provider_profile_id_sha256 bytea NOT NULL UNIQUE/u);
  assert.match(source, /RAISE EXCEPTION 'SEO social account is not a verified account of this brand' USING ERRCODE = '42501'/u);
});
