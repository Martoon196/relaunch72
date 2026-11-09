import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { canonicalCompanyContentSocialDraft } from '../src/company-content-pg/validation.js';
import { IMAGE_FIXTURE } from './social-image-fixture.js';

const connectionString = process.env.HQ_IMAGE_PROOF_URL ?? '';
const url = new URL(connectionString);
assert.equal(url.pathname, '/relaunch72_test_clone4');
assert.ok(!url.hostname.includes('-pooler'));
const client = new pg.Client({ connectionString });
await client.connect();
let passed = 0;
try {
  const baseline = await client.query('SELECT current_database() AS db, count(*)::int AS count, max(filename) AS latest FROM app_private.schema_migrations');
  assert.equal(baseline.rows[0].db, 'relaunch72_test_clone4');
  assert.equal(baseline.rows[0].latest, '0101_generated_social_planning_compatibility.sql');
  const source = (await readFile(new URL('../src/db/migrations/0102_combined_social_post_image.sql', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  // Rehearse exact function changes transactionally; retain the old test schema.
  await client.query('BEGIN');
  await client.query(source.replace(/^BEGIN;\s*/u, '').replace(/COMMIT;\s*$/u, ''));
  passed++;
  const body = canonicalCompanyContentSocialDraft({ type:'generated', kind:'post', platform:'LinkedIn',
    title:'Synthetic image proof', publicationCopy:'Only these words go into the caption.',
    artworkInstructions:'Image notes are not published.', image: IMAGE_FIXTURE });
  const result = await client.query(`SELECT app_private.company_content_social_publication_copy($1) AS text,
    app_private.company_content_social_image($1) AS image`, [body]);
  assert.equal(result.rows[0].text, 'Only these words go into the caption.');
  assert.deepEqual(result.rows[0].image, IMAGE_FIXTURE); passed++;
  for (const candidate of [ { ...IMAGE_FIXTURE, sha256:'a'.repeat(64) },
    { ...IMAGE_FIXTURE, mimeType:'image/svg+xml' }, { ...IMAGE_FIXTURE, width:1 },
    { ...IMAGE_FIXTURE, extra:'unbound' } ]) {
    await client.query('SAVEPOINT bad_image');
    await assert.rejects(client.query('SELECT app_private.company_content_social_image($1)',
      [JSON.stringify({ ...JSON.parse(body), image:candidate })]));
    await client.query('ROLLBACK TO SAVEPOINT bad_image'); passed++;
  }
  const legacy = await client.query(`SELECT app_private.company_content_social_image('Ordinary legacy text') AS image,
    app_private.company_content_social_publication_copy('Ordinary legacy text') AS text`);
  assert.equal(legacy.rows[0].image, null); assert.equal(legacy.rows[0].text, 'Ordinary legacy text'); passed++;
  const loaded = await client.query(`SELECT * FROM app_private.load_zernio_calendar_job(
    '00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002',1,decode(repeat('ab',32),'hex'))`);
  assert.equal(loaded.rowCount, 0); passed++;
  const definitions = await client.query(`SELECT proname, pg_get_functiondef(p.oid) AS definition,
    pg_get_userbyid(proowner) AS owner FROM pg_proc p JOIN pg_namespace n ON p.pronamespace=n.oid
    WHERE n.nspname='app_private' AND proname IN ('enqueue_zernio_calendar_job','load_zernio_calendar_job')`);
  assert.equal(definitions.rows.length, 2);
  for (const row of definitions.rows) {
    assert.equal(row.owner, 'r72_owned_social_definer');
    assert.match(row.definition, /company_content_social_image/);
  }
  const grants = await client.query(`SELECT has_function_privilege('r72_web',
    'app_private.company_content_social_image(text)','EXECUTE') AS web,
    has_function_privilege('r72_owned_social_worker_command',
    'app_private.company_content_social_image(text)','EXECUTE') AS worker,
    has_schema_privilege('r72_owned_social_definer','app_private','CREATE') AS schema_create`);
  assert.deepEqual(grants.rows[0], { web:false, worker:false, schema_create:false }); passed++;
  await client.query('ROLLBACK');
  console.log(JSON.stringify({ task:'HQ-IMAGE-008', passed, failed:0, skipped:0,
    database:'relaunch72_test_clone4', migration:'0102', applied:'transactionally; rolled back',
    productionEffects:false, providerEffects:false,
    limits:'No real queued-job fixture or provider call; valid delivery covered by focused worker tests.' }));
} catch(error) {
  await client.query('ROLLBACK').catch(() => undefined);
  console.error(JSON.stringify({ passed, failed:1, code:(error as any).code,
    message: error instanceof Error ? error.message : 'SQL proof failed' }));
  process.exitCode=1;
} finally { await client.end(); }
