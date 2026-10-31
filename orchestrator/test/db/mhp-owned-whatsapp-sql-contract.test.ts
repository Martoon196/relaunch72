import assert from 'node:assert/strict';
import test from 'node:test';
import { readdir, readFile } from 'node:fs/promises';

const dir = new URL('../../src/db/migrations/', import.meta.url);
const raw = async (name: string): Promise<string> => (await readFile(new URL(name, dir), 'utf8')).replace(/\r\n/gu, '\n');
function fn(source: string, declaration: string): string {
  const start = source.indexOf(declaration); assert.ok(start >= 0, `${declaration} must exist`);
  const end = source.indexOf('\n$function$;', start); assert.ok(end > start);
  return source.slice(start, end + '\n$function$;'.length);
}
const M53 = '0053_property_predator_meta_whatsapp_live_foundation.sql', M132 = '0132_mhp_owned_whatsapp_pilot.sql';

test('0132 is the next contiguous migration', async () => {
  const files = (await readdir(dir)).filter(name => /^\d{4}_.*\.sql$/u.test(name)).sort();
  assert.equal(files.at(-1), M132); assert.equal(files.length, 132);
});

test('MHP132 template repair keeps every 0053 guard and changes only the impossible {0,511} name bound', async () => {
  const original = fn(await raw(M53), 'CREATE FUNCTION app_private.record_whatsapp_live_template(');
  const repaired = fn(await raw(M132), 'CREATE OR REPLACE FUNCTION app_private.record_whatsapp_live_template(');
  const before = "     OR p_template_name !~ '^[a-z][a-z0-9_]{0,511}$'";
  const after = "     OR p_template_name !~ '^[a-z][a-z0-9_]*$' OR char_length(p_template_name) > 512";
  assert.equal(original.split(before).length, 2); assert.equal(repaired.split(after).length, 2);
  assert.equal(repaired.replace('CREATE OR REPLACE FUNCTION', 'CREATE FUNCTION').replace(after, () => before), original);
  const sql = await raw(M132);
  assert.match(sql, /ADD CONSTRAINT property_predator_whatsapp_live_te_provider_template_name_check\n CHECK \(provider_template_name ~ '\^\[a-z\]\[a-z0-9_\]\*\$' AND char_length\(provider_template_name\) <= 512\);/u);
});

test('MHP132 claim repair keeps every 0053 guard, lease and recovery branch and only disambiguates three references', async () => {
  const original = fn(await raw(M53), 'CREATE FUNCTION app_private.claim_whatsapp_live_job(');
  const repaired = fn(await raw(M132), 'CREATE OR REPLACE FUNCTION app_private.claim_whatsapp_live_job(');
  const pairs: [string, string][] = [
    ['      ) ON CONFLICT (workspace_id, binding_id, external_event_id) DO NOTHING;',
      '      ) ON CONFLICT ON CONSTRAINT property_predator_whatsapp_li_workspace_id_binding_id_exter_key DO NOTHING;'],
    ['    DELETE FROM app.property_predator_whatsapp_live_job_leases\n    WHERE workspace_id = recovered.workspace_id AND job_id = recovered.id;',
      '    DELETE FROM app.property_predator_whatsapp_live_job_leases AS lease\n    WHERE lease.workspace_id = recovered.workspace_id AND lease.job_id = recovered.id;'],
    ['  ON CONFLICT (workspace_id, job_id) DO UPDATE SET', '  ON CONFLICT ON CONSTRAINT property_predator_whatsapp_live_job_leases_pkey DO UPDATE SET'],
  ];
  let restored = repaired.replace('CREATE OR REPLACE FUNCTION', 'CREATE FUNCTION');
  for (const [before, after] of pairs) {
    assert.equal(original.split(before).length, 2); assert.equal(restored.split(after).length, 2);
    restored = restored.replace(after, () => before);
  }
  assert.equal(restored, original);
});

test('0132 owner functions run only in the live owner session and never as a worker or the public', async () => {
  const sql = (await raw(M132)).replace(/\s+/gu, ' ');
  assert.match(sql, /CREATE FUNCTION app_private\.mhp_whatsapp_owner\(p_session bytea\)[^$]*\$f\$ DECLARE actor uuid;[^$]*actor:=app_private\.mhp_owner_email_authorize\(p_session\); IF session_user<>'r72_whatsapp_live_command'/u);
  for (const name of ['mhp_whatsapp_snapshot', 'mhp_whatsapp_connect', 'mhp_whatsapp_record_template', 'mhp_owned_whatsapp_send']) {
    const start = sql.indexOf(`CREATE FUNCTION app_private.${name}(`); assert.ok(start >= 0, name);
    const body = sql.slice(start, sql.indexOf('END $f$;', start));
    assert.match(body, /actor:=app_private\.mhp_whatsapp_owner\(p_session\)/u, `${name} uses the owner gate`);
    assert.doesNotMatch(body, /set_config/u);
  }
  assert.match(sql, /GRANT EXECUTE ON FUNCTION app_private\.mhp_whatsapp_snapshot\(bytea,uuid,text\), app_private\.mhp_whatsapp_connect\([^)]*\), app_private\.mhp_whatsapp_record_template\([^)]*\), app_private\.mhp_owned_whatsapp_send\([^)]*\) TO r72_whatsapp_live_command;/u);
  assert.doesNotMatch(sql, /TO r72_(?:identity_command|web|whatsapp_live_worker_command|whatsapp_live_webhook_command|sms_command)\b/u);
});

test('the owned send is the owner only: own proven number, own one-test permission, unchanged 0053 enqueue', async () => {
  const sql = (await raw(M132)).replace(/\s+/gu, ' ');
  const start = sql.indexOf('CREATE FUNCTION app_private.mhp_owned_whatsapp_send(');
  const body = sql.slice(start, sql.indexOf('END $f$;', start));
  assert.match(body, /JOIN app_private\.sms_phone_verification_receipts r ON [^;]*r\.verified_by_user_id=actor/u, 'possession is the owner\'s own SMS proof');
  assert.match(body, /'whatsapp','marketing','granted','consent','mhp\.owned-whatsapp\.self-test',review_version, public\.digest\(permission_text,'sha256'\),p_command::text,'user',actor/u);
  assert.match(body, /job:=app_private\.authorize_and_enqueue_whatsapp_live_job\(/u);
  assert.match(body, /expiry:=prepared\+interval '4 minutes'/u);
  assert.match(body, /IF p_lookup_only THEN RETURN jsonb_build_object\('not_started',true\)/u);
  assert.doesNotMatch(sql, /ALTER TABLE app\.(?:property_predator_whatsapp_live_(?:jobs|authorities|bindings)|messages|communication_)/u);
});
