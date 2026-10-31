import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';

const migrationsUrl = new URL('../../src/db/migrations/', import.meta.url);
const migrationUrl = new URL('0131_mhp_event_sms_programme.sql', migrationsUrl);
const normalise = (sql: string): string => sql.replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ').trim();
const sql = async (): Promise<string> => normalise(await readFile(migrationUrl, 'utf8'));

function bodyOf(text: string, signature: string): string {
  const start = text.indexOf(signature);
  assert.notEqual(start, -1, `${signature} must be present`);
  const end = text.indexOf('$f$;', start);
  assert.notEqual(end, -1, `${signature} must be terminated`);
  return text.slice(start, end);
}

test('0131 changes no existing message, approval, delivery, job, authority or compliance table', async () => {
  const text = await sql();
  for (const table of ['messages', 'message_versions', 'message_approval_requests', 'message_approval_decisions', 'message_deliveries',
    'provider_operations', 'property_predator_sms_jobs', 'property_predator_sms_authorities', 'communication_consent_events',
    'communication_suppression_events', 'contact_points']) {
    assert.doesNotMatch(text, new RegExp(`ALTER TABLE app\\.${table}\\b`, 'u'), `${table} must not be altered`);
  }
  assert.doesNotMatch(text, /ALTER TABLE app_private\.affiliate_compliance_/u);
  assert.doesNotMatch(text, /CREATE OR REPLACE FUNCTION/u, '0131 replaces no existing function');
  assert.doesNotMatch(text, /DROP (?:TABLE|FUNCTION|POLICY|TRIGGER)/u);
});

test('0131 is the next contiguous migration', async () => {
  const files = (await readdir(migrationsUrl)).filter(name => /^\d{4}_.*\.sql$/u.test(name)).sort();
  assert.equal(files.at(-1), '0131_mhp_event_sms_programme.sql');
  assert.equal(files.length, 131);
});

test('public functions run only as the existing public capture role and never create CRM or owner state', async () => {
  const text = await sql();
  const request = bodyOf(text, 'CREATE FUNCTION app_private.mhp_event_sms_optin_request(');
  const confirm = bodyOf(text, 'CREATE FUNCTION app_private.mhp_event_sms_optin_confirm(');
  for (const body of [request, confirm]) {
    assert.match(body, /session_user<>'r72_identity_command'/u);
    assert.doesNotMatch(body, /INSERT INTO app\./u, 'no CRM, message or consent write from a public function');
    assert.doesNotMatch(body, /set_config/u, 'no owner context is ever created');
    assert.doesNotMatch(body, /app\.user_id/u);
  }
  assert.match(request, /p_consent_text_sha256 IS DISTINCT FROM public\.digest\(consent_text,'sha256'\)/u, 'the exact shown wording is required');
  assert.match(request, /RETURN jsonb_build_object\('optinId',gen_random_uuid\(\)\)/u, 'unknown emails get an unstored decoy');
  assert.match(request, /p_phone!~'\^\\\+447\[0-9\]\{9\}\$'/u, 'UK mobiles only');
  assert.match(confirm, /o\.attempts>=5/u);
  assert.match(text, /GRANT EXECUTE ON FUNCTION app_private\.mhp_event_sms_optin_request\(text,text,text,text,bytea,bytea,text\), ?app_private\.mhp_event_sms_optin_confirm\(uuid,text\) TO r72_identity_command;/u);
});

test('verification codes are worker-only, capped per day and per phone, and fail closed when stale', async () => {
  const text = await sql();
  const claim = bodyOf(text, 'CREATE FUNCTION app_private.mhp_event_sms_code_claim(');
  assert.match(claim, /session_user<>'r72_sms_worker_command'/u);
  assert.match(claim, /current_setting\('app\.actor_kind',true\) IS DISTINCT FROM 'worker'/u);
  assert.match(claim, /coalesce\(current_setting\('app\.user_id',true\),''\)<>''/u, 'a worker claim carries no user identity');
  assert.match(claim, /WHERE o\.claimed_at>=day_start\)>=20 THEN RETURN/u, '20 codes per UTC day');
  assert.match(claim, /s\.claimed_at>=day_start\)<3/u, '3 codes per phone per day');
  assert.match(claim, /SET state='failed' WHERE o\.state='claimed'/u);
  assert.match(claim, /SET state='needs_attention' WHERE o\.state='armed'/u, 'an unsettled send is never retried');
  assert.match(text, /GRANT EXECUTE ON FUNCTION app_private\.mhp_event_sms_code_claim\(uuid,uuid\), ?app_private\.mhp_event_sms_code_arm\(uuid,uuid,text\), ?app_private\.mhp_event_sms_code_settle\(uuid,uuid,text,text\) TO r72_sms_worker_command;/u);
});

test('the owner batch send is the only send, runs in the live owner session and binds the exact reviewed batch', async () => {
  const text = await sql();
  const send = bodyOf(text, 'CREATE FUNCTION app_private.mhp_event_sms_batch_send(');
  assert.match(send, /actor:=app_private\.mhp_owner_email_authorize\(p_session\)/u);
  assert.match(send, /session_user<>'r72_sms_command'/u);
  assert.match(send, /current_setting\('app\.user_id',true\) IS DISTINCT FROM actor::text/u);
  assert.match(send, /p_confirmed IS DISTINCT FROM true/u);
  assert.match(send, /mhp_event_sms_batch_digest\(p_campaign,p_content_version,p_content_sha256\) IS DISTINCT FROM p_batch_sha256 THEN RAISE EXCEPTION 'The reviewed batch changed' USING ERRCODE='40001'/u);
  assert.match(send, /exact:=app_private\.mhp_owned_sms_content\(p_content_version,p_content_sha256\)/u, 'the ratified 0130 content gate');
  assert.match(send, /position\('STOP' IN body\)=0/u);
  assert.match(send, /recipients\*segments>10 OR day_used\+recipients\*segments>10 OR month_used\+recipients\*segments>50/u);
  assert.match(send, /app_private\.authorize_and_enqueue_sms_live_job\(/u, 'the unchanged 0056 enqueue');
  assert.match(send, /expiry:=prepared\+interval '4 minutes'/u);
  assert.match(send, /IF p_lookup_only THEN RETURN jsonb_build_object\('not_started',true\)/u, 'lookup before any mutation');
  // The registrant's consent is theirs, recorded by the system, never as the owner.
  assert.match(send, /'mhp\.event-sms\.public-optin','mhp\.event-sms\/v1', r\.consent_text_sha256,'optin:'\|\|r\.optin_id::text,'system',NULL/u);
  assert.match(text, /GRANT EXECUTE ON FUNCTION app_private\.mhp_event_sms_batch_snapshot\(bytea,text,uuid,bytea\), ?app_private\.mhp_event_sms_batch_send\(bytea,uuid,text,uuid,bytea,bytea,boolean,boolean\) TO r72_sms_command;/u);
});

test('only ready candidates can be sent and every exclusion is explicit', async () => {
  const text = await sql();
  const candidates = bodyOf(text, 'CREATE FUNCTION app_private.mhp_event_sms_batch_candidates(');
  for (const status of ['email_unsubscribed', 'phone_shared', 'needs_import', 'contact_ambiguous', 'opted_out', 'consent_changed', 'already_sent', 'ready']) {
    assert.match(candidates, new RegExp(`'${status}'`, 'u'));
  }
  const send = bodyOf(text, 'CREATE FUNCTION app_private.mhp_event_sms_batch_send(');
  assert.match(send, /FOR r IN SELECT \* FROM app_private\.mhp_event_sms_batch_candidates\(p_campaign,p_content_version\) c WHERE c\.status='ready'/u);
  assert.match(text, /UNIQUE\(optin_id,content_version_id\)/u, 'one text version per registrant, ever');
  assert.match(text, /CREATE FUNCTION app_private\.mhp_event_sms_verified_optins[^$]*\$f\$[^$]*session_user='r72_sms_command'/u);
  assert.match(text, /GRANT EXECUTE ON FUNCTION app_private\.mhp_event_sms_verified_optins\(text\) TO r72_sms_definer;/u);
});

test('new tables are forced-RLS, closed to PUBLIC and batch evidence is append-only', async () => {
  const text = await sql();
  assert.match(text, /FOREACH t IN ARRAY ARRAY\['mhp_event_sms_optins','mhp_event_sms_batches','mhp_event_sms_batch_recipients'\]/u);
  assert.match(text, /ENABLE ROW LEVEL SECURITY/u);
  assert.match(text, /FORCE ROW LEVEL SECURITY/u);
  assert.match(text, /REVOKE ALL ON app_private\.%I FROM PUBLIC/u);
  assert.match(text, /CREATE TRIGGER mhp_event_sms_batches_immutable BEFORE UPDATE OR DELETE/u);
  assert.match(text, /CREATE TRIGGER mhp_event_sms_batch_recipients_immutable BEFORE UPDATE/u);
  assert.match(text, /REVOKE CREATE ON SCHEMA app_private FROM r72_sms_definer,r72_mhp_prospect_definer;$/u);
  assert.doesNotMatch(text, /GRANT [A-Z, ()a-z_]+ ON app_private\.mhp_event_sms_\w+ TO r72_(?:web|identity_command|sms_command|sms_worker_command)\b/u,
    'no runtime login role gets table access');
});
