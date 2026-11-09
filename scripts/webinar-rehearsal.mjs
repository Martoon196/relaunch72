// Disposable Render rehearsal only. Application source is the reviewed 086ab8b release.
import assert from 'node:assert/strict';
import { createHash, createHmac, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { runMigrations, discoverMigrations } from '../orchestrator/src/db/migrate.ts';
import { hashPassword } from '../orchestrator/src/portal/accounts.ts';
import { WEBINARS_MIGRATION, WEBINARS_CHECKSUM } from '../orchestrator/src/db/webinar-schema.ts';
import { spawn } from 'node:child_process';
import { redactIngest } from '../orchestrator/src/webinars/studio.ts';

const DB_NAME = 'rl72_webinar_rehearsal_db_20261109';
const DB_HOST = 'dpg-dbp2tpon74is73eqn260-a';
const MARKER = 'rl72-private-webinar-rehearsal-20261109';
const OWNER = '6e722026-1109-4000-8000-000000000001';
const BRANDS = [
  { org: '6e722026-1109-4000-8000-000000000010', ws: '6e722026-1109-4000-8000-000000000011', name: 'Relaunch72 Rehearsal', slug: 'rl72-rehearsal', color: '#b76d00' },
  { org: '6e722026-1109-4000-8000-000000000020', ws: '6e722026-1109-4000-8000-000000000021', name: 'Second Brand Rehearsal', slug: 'second-brand-rehearsal', color: '#0b7a75' },
];

export function guardedTarget(env) {
  assert.equal(env.REHEARSAL_DISPOSABLE_DATABASE, MARKER, 'Rehearsal marker missing');
  assert.equal(env.NODE_ENV, 'production', 'Use hardened application configuration');
  const url = new URL(env.REHEARSAL_DATABASE_URL ?? '');
  assert(['postgres:', 'postgresql:'].includes(url.protocol));
  assert.equal(url.pathname, '/' + DB_NAME, 'Wrong rehearsal database');
  assert([DB_HOST, DB_HOST + '.internal'].includes(url.hostname), 'Wrong rehearsal host');
  assert.equal(decodeURIComponent(url.username), DB_NAME + '_user', 'Wrong bootstrap identity');
  for (const key of ['SESSION_SECRET', 'PORTAL_ABUSE_HASH_SECRET', 'REHEARSAL_ROLE_SECRET', 'REHEARSAL_OWNER_PASSWORD', 'WEBINAR_ACCESS_SECRET']) {
    assert((env[key] ?? '').length >= 32, 'Missing dedicated rehearsal secret: ' + key);
  }
  assert.equal(new Set(['SESSION_SECRET', 'PORTAL_ABUSE_HASH_SECRET', 'REHEARSAL_ROLE_SECRET', 'REHEARSAL_OWNER_PASSWORD', 'WEBINAR_ACCESS_SECRET'].map(k => env[k])).size, 5);
  for (const key of ['STRIPE_SECRET_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'APOLLO_API_KEY', 'BREVO_API_KEY', 'POSTMARK_SERVER_TOKEN', 'MAILGUN_API_KEY']) {
    assert(!env[key]?.trim(), 'Unrelated provider credential forbidden: ' + key);
  }
  assert.equal(env.APOLLO_ENABLED, 'false');
  assert.equal(env.WEBINAR_EMAIL_MODE, 'off');
  url.searchParams.delete('sslmode');
  return url;
}

export function seal(value, secret) {
  const key = createHash('sha256').update('rl72-rehearsal-signing-key-v1\0').update(secret).digest();
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
  const bytes = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), bytes]).toString('base64');
}
export function unseal(value, secret) {
  const key = createHash('sha256').update('rl72-rehearsal-signing-key-v1\0').update(secret).digest();
  const bytes = Buffer.from(value, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
  decipher.setAuthTag(bytes.subarray(12, 28));
  return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8'));
}

let stage = 'target guard';
// One bounded synthetic provider probe, only on this guarded disposable DB.
// Reuses an existing test input; never exposes its credentials or starts a webinar.
async function probeExistingTestInput(client, env) {
  const marker = 'synthetic-ingest-probe-20261109-v1';
  if ((await client.query('SELECT 1 FROM rehearsal_private.state WHERE key=$1', [marker])).rowCount) return;
  await client.query('BEGIN');
  await client.query('SET LOCAL ROLE r72_owner');
  const row = (await client.query('SELECT live_input_uid FROM app.webinar_events WHERE id=$1 AND workspace_id=$2', ['9ba971ab-25a6-4375-b866-9bdda6b23845', BRANDS[0].ws])).rows[0];
  await client.query('COMMIT');
  if (!/^[0-9a-f]{32}$/.test(row?.live_input_uid ?? '')) return;
  await client.query('INSERT INTO rehearsal_private.state(key,value) VALUES($1,$2)', [marker, 'started']);
  const report = { rehearsalSyntheticIngest: true, seconds: 18, observations: [] };
  const api = async (suffix='') => {
    const r = await fetch('https://api.cloudflare.com/client/v4/accounts/' + env.CLOUDFLARE_ACCOUNT_ID + '/stream/live_inputs/' + row.live_input_uid + suffix,
      { headers: { authorization: 'Bearer ' + env.CLOUDFLARE_STREAM_API_TOKEN }, signal: AbortSignal.timeout(8000) });
    assert(r.ok, 'Stream read status ' + r.status); return (await r.json()).result;
  };
  let child, timer, stderr='', target='', key='';
  try {
    const input = await api();
    assert.equal(input.rtmps?.url, 'rtmps://live.cloudflare.com:443/live/');
    key = input.rtmps.streamKey; assert(typeof key === 'string' && key.length > 10);
    target = input.rtmps.url + key;
    child = spawn('ffmpeg', ['-hide_banner','-loglevel','error','-re','-f','lavfi','-i','color=c=0x336699:size=320x240:rate=15',
      '-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','18','-c:v','libx264','-preset','ultrafast','-tune','zerolatency',
      '-g','30','-pix_fmt','yuv420p','-c:a','aac','-b:a','32k','-ar','48000','-f','flv',target]);
    child.stdin.end(); child.stderr.on('data', d=>{stderr=(stderr+d.toString()).slice(-1800);});
    let ended=false;
    const done=new Promise(resolve=>{child.once('close',code=>{ended=true;report.exitCode=code;resolve();});child.once('error',()=>{ended=true;report.spawnFailed=true;resolve();});});
    timer=setTimeout(()=>child.kill('SIGKILL'),30000);
    for(let i=0;i<4;i++) {
      await new Promise(resolve=>setTimeout(resolve,4000));
      const state=await api(); const raw=state.status;
      const text=v=>typeof v==='string'?v.slice(0,64):null;
      report.observations.push({atSeconds:(i+1)*4,statusType:typeof raw,status:text(raw),state:text(raw?.state),currentState:text(raw?.current?.state)});
      if(ended)break;
    }
    await done;
    const videos=await api('/videos');
    report.videoCount=Array.isArray(videos)?videos.length:null;
    report.videoStates=Array.isArray(videos)?videos.map(v=>String(v.status?.state??'unknown').slice(0,40)):[];
  } catch(error) { report.failure=redactIngest(String(error?.message??'probe failed'),[key,target,env.CLOUDFLARE_STREAM_API_TOKEN]).slice(0,200); }
  finally {
    if(timer)clearTimeout(timer); if(child && child.exitCode===null)child.kill('SIGKILL');
    report.stderr=redactIngest(stderr,[key,target,env.CLOUDFLARE_STREAM_API_TOKEN]).slice(-600);
    await client.query('UPDATE rehearsal_private.state SET value=$2 WHERE key=$1',[marker,JSON.stringify(report)]);
    console.log(JSON.stringify(report));
  }
}
export async function bootstrap(env = process.env) {
  const url = guardedTarget(env);
  stage = 'isolated database connection';
  const pool = new pg.Pool({ connectionString: url.toString(), max: 2, ssl: { rejectUnauthorized: false } });
  const client = await pool.connect();
  try {
    stage = 'bootstrap role capability';
    const capability = (await client.query('SELECT rolcreaterole OR rolsuper AS allowed FROM pg_roles WHERE rolname=current_user')).rows[0]?.allowed;
    assert(capability, 'Database bootstrap requires role creation');
    stage = 'database marker';
    await client.query('SELECT pg_advisory_lock(1382302770,7200145)');
    const state = await client.query("SELECT to_regclass('app_private.schema_migrations') AS ledger, to_regclass('rehearsal_private.state') AS marker");
    if (state.rows[0].ledger && !state.rows[0].marker) throw new Error('Refuse an existing unmarked installation');
    await client.query('CREATE SCHEMA IF NOT EXISTS rehearsal_private; REVOKE ALL ON SCHEMA rehearsal_private FROM PUBLIC');
    await client.query('CREATE TABLE IF NOT EXISTS rehearsal_private.state (key text PRIMARY KEY, value text NOT NULL)');
    await client.query('INSERT INTO rehearsal_private.state(key,value) VALUES($1,$2) ON CONFLICT DO NOTHING', ['identity', MARKER]);
    assert.equal((await client.query("SELECT value FROM rehearsal_private.state WHERE key='identity'")).rows[0]?.value, MARKER);
    stage = 'migrations';
    const bundle = await discoverMigrations();
    assert.equal(bundle.length, 145);
    assert.equal(bundle.at(-1).filename, WEBINARS_MIGRATION);
    assert.equal(bundle.at(-1).checksum, WEBINARS_CHECKSUM);
    const migrated = await runMigrations(pool);
    console.log(JSON.stringify({ rehearsal: true, migrationsApplied: migrated.applied.length, ledger: 145 }));

    stage = 'runtime identities';
    for (const [role, key] of [['r72_web', 'DATABASE_WEB_URL'], ['r72_identity_command', 'DATABASE_IDENTITY_COMMAND_URL'], ['r72_abuse_command', 'DATABASE_ABUSE_COMMAND_URL'], ['r72_crm_command', 'DATABASE_CRM_COMMAND_URL'], ['r72_content_command', 'DATABASE_CONTENT_COMMAND_URL']]) {
      const password = createHmac('sha256', env.REHEARSAL_ROLE_SECRET).update(role).digest('base64url');
      const sql = await client.query('SELECT format(\'ALTER ROLE %I PASSWORD %L\',$1::text,$2::text) AS sql', [role, password]);
      await client.query(sql.rows[0].sql);
      const runtime = new URL(url); runtime.username = role; runtime.password = password;
      env[key] = runtime.toString();
    }

    stage = 'synthetic owner and brands';
    const passwordHash = await hashPassword(env.REHEARSAL_OWNER_PASSWORD);
    await client.query('BEGIN');
    try {
      await client.query('SET LOCAL ROLE r72_owner');
      await client.query("INSERT INTO app.users(id,email,display_name,password_hash,email_verified_at,status) VALUES($1,'owner@webinar-rehearsal.example.test','Private rehearsal owner',$2,clock_timestamp(),'active') ON CONFLICT(id) DO UPDATE SET password_hash=EXCLUDED.password_hash", [OWNER, passwordHash]);
      for (const b of BRANDS) {
        await client.query("INSERT INTO app.organizations(id,name,slug,kind) VALUES($1,$2,$3,'direct_customer') ON CONFLICT(id) DO NOTHING", [b.org, b.name, b.slug]);
        await client.query("INSERT INTO app.organization_memberships(organization_id,user_id,role,status) VALUES($1,$2,'owner','active') ON CONFLICT DO NOTHING", [b.org, OWNER]);
        await client.query("INSERT INTO app.workspaces(id,organization_id,name,slug,timezone) VALUES($1,$2,$3,$4,'Europe/London') ON CONFLICT(id) DO NOTHING", [b.ws, b.org, b.name, b.slug]);
        await client.query("INSERT INTO app.workspace_memberships(workspace_id,organization_id,user_id,role,status,source_organization_id) VALUES($1,$2,$3,'owner','active',$2) ON CONFLICT DO NOTHING", [b.ws, b.org, OWNER]);
        await client.query("INSERT INTO app.organization_branding(organization_id,product_name,accent_color,support_email) VALUES($1,$2,$3,'owner@webinar-rehearsal.example.test') ON CONFLICT(organization_id) DO NOTHING", [b.org, b.name, b.color]);
      }
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }

    stage = 'private playback signing';
    // The approved API token remains only in Render environment settings. A
    // separate playback signing key is encrypted in this disposable DB so a
    // restart doesn't create another key. No credential is printed.
    if (env.CLOUDFLARE_STREAM_API_TOKEN && env.CLOUDFLARE_STREAM_CUSTOMER_CODE) {
      assert.equal(env.CLOUDFLARE_ACCOUNT_ID, '6a6ff0ccb07da5dd5c3ced7bfd9dc4c8');
      let cached = (await client.query("SELECT value FROM rehearsal_private.state WHERE key='playback-signing'")).rows[0]?.value;
      if (!cached) {
        const response = await fetch('https://api.cloudflare.com/client/v4/accounts/' + env.CLOUDFLARE_ACCOUNT_ID + '/stream/keys', {
          method: 'POST', headers: { authorization: 'Bearer ' + env.CLOUDFLARE_STREAM_API_TOKEN }, signal: AbortSignal.timeout(20_000),
        });
        assert(response.ok, 'Signing key request refused');
        const result = (await response.json()).result;
        assert(typeof result?.id === 'string' && typeof result?.jwk === 'string', 'Signing key response incomplete');
        cached = seal({ id: result.id, jwk: result.jwk }, env.SESSION_SECRET);
        await client.query("INSERT INTO rehearsal_private.state(key,value) VALUES('playback-signing',$1)", [cached]);
      }
      const key = unseal(cached, env.SESSION_SECRET);
      env.CLOUDFLARE_STREAM_SIGNING_KEY_ID = key.id;
      env.CLOUDFLARE_STREAM_SIGNING_JWK = key.jwk;
    }
    stage = 'one-time synthetic ingest probe';
    await probeExistingTestInput(client, env);
    console.log('Private rehearsal bootstrap completed; provider credentials are not log fields.');
  } finally { client.release(); await pool.end(); }
  delete env.REHEARSAL_DATABASE_URL;
  delete env.REHEARSAL_ROLE_SECRET;
  delete env.REHEARSAL_OWNER_PASSWORD;
  env.DATABASE_SSL_MODE = 'require';
  const origin = new URL(env.RENDER_EXTERNAL_URL);
  assert.equal(origin.protocol, 'https:');
  env.PUBLIC_BASE_URL = env.PORTAL_BASE_URL = env.WEBINAR_PUBLIC_ORIGIN = origin.origin;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    await bootstrap();
    stage = 'reviewed application startup';
    await import('../orchestrator/src/server/index.ts');
  } catch (error) {
    console.error(JSON.stringify({ rehearsal: true, failedStage: stage, sqlState: /^[0-9A-Z]{5}$/.test(error?.code ?? '') ? error.code : undefined }));
    process.exit(1);
  }
}
