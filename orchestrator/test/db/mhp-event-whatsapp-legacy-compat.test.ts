import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';

// 0132 replaces four existing definitions; each equals its latest prior
// definition byte-for-byte except for the named repair or exclusion.
const DIR = new URL('../../src/db/migrations/', import.meta.url);
async function definitions(name: string): Promise<{ file: string; text: string }[]> {
  const found: { file: string; text: string }[] = [];
  for (const file of (await readdir(DIR)).filter(f => f.endsWith('.sql')).sort()) {
    const source = (await readFile(new URL(file, DIR), 'utf8')).replace(/\r\n/gu, '\n');
    for (const match of source.matchAll(new RegExp(`CREATE (?:OR REPLACE )?FUNCTION app_private\\.${name}\\(`, 'gu'))) {
      const start = match.index!, tag = /AS (\$[a-zA-Z_]*\$)/u.exec(source.slice(start))![1]!;
      const end = source.indexOf(tag, source.indexOf(tag, start) + tag.length) + tag.length;
      found.push({ file, text: source.slice(start, source.indexOf(';', end) + 1).replace(/^CREATE FUNCTION/u, 'CREATE OR REPLACE FUNCTION') });
    }
  }
  return found;
}
const CASES: { name: string; edits: [string, string][] }[] = [
  { name: 'record_whatsapp_live_template', edits: [["     OR p_template_name !~ '^[a-z][a-z0-9_]{0,511}$'", "     OR p_template_name !~ '^[a-z][a-z0-9_]*$' OR char_length(p_template_name) > 512"]] },
  { name: 'claim_whatsapp_live_job', edits: [
    ['      ) ON CONFLICT (workspace_id, binding_id, external_event_id) DO NOTHING;', '      ) ON CONFLICT ON CONSTRAINT property_predator_whatsapp_li_workspace_id_binding_id_exter_key DO NOTHING;'],
    ['    DELETE FROM app.property_predator_whatsapp_live_job_leases\n    WHERE workspace_id = recovered.workspace_id AND job_id = recovered.id;',
      '    DELETE FROM app.property_predator_whatsapp_live_job_leases AS lease\n    WHERE lease.workspace_id = recovered.workspace_id AND lease.job_id = recovered.id;'],
    ['  ON CONFLICT (workspace_id, job_id) DO UPDATE SET', '  ON CONFLICT ON CONSTRAINT property_predator_whatsapp_live_job_leases_pkey DO UPDATE SET'],
    ['    WHERE job.workspace_id = p_workspace_id AND job.provider_connection_id = p_provider_connection_id\n      AND ((job.state',
      "    WHERE job.workspace_id = p_workspace_id AND job.provider_connection_id = p_provider_connection_id\n      AND job.authority_kind = 'owner_action'\n      AND ((job.state"],
    ["    AND job.state = 'queued' AND job.available_at <= statement_timestamp()\n", "    AND job.state = 'queued' AND job.available_at <= statement_timestamp()\n    AND job.authority_kind = 'owner_action'\n"]] },
  { name: 'whatsapp_live_job_identity_guard', edits: [['     OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id\n',
    '     OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id\n     OR NEW.authority_kind IS DISTINCT FROM OLD.authority_kind\n     OR NEW.event_send_id IS DISTINCT FROM OLD.event_send_id\n     OR NEW.created_by_actor_kind IS DISTINCT FROM OLD.created_by_actor_kind\n']] },
  { name: 'mhp_event_phone_request_link', edits: [[' programme:=app_private.mhp_event_phone_current_programme();\n',
    ' programme:=coalesce(app_private.mhp_event_phone_current_programme(),app_private.mhp_event_whatsapp_current_programme());\n']] },
];
for (const { name, edits } of CASES) {
  test(`0132 ${name} is the exact prior body plus only its named change`, async () => {
    const all = await definitions(name), replacement = all.at(-1)!, prior = all.at(-2)!;
    assert.equal(replacement.file, '0132_mhp_event_whatsapp_programme.sql');
    let expected = prior.text;
    for (const [from, to] of edits) { assert.equal(expected.split(from).length - 1, 1, `${name}: one anchor`); expected = expected.split(from).join(to); }
    assert.equal(replacement.text, expected);
  });
}
test('0132 leaves the 0055 projection, 0053 load/begin/settle/enqueue and every 0131 SMS function untouched', async () => {
  const source = await readFile(new URL('0132_mhp_event_whatsapp_programme.sql', DIR), 'utf8');
  for (const name of ['record_whatsapp_live_inbound_projection', 'load_whatsapp_live_job', 'begin_whatsapp_live_call', 'settle_whatsapp_live_call',
    'authorize_and_enqueue_whatsapp_live_job', 'whatsapp_live_authority_is_current', 'mhp_record_event_sms_inbound', 'mhp_prepare_event_sms', 'begin_event_sms_call']) {
    assert.doesNotMatch(source, new RegExp(`FUNCTION app_private\\.${name}\\(`, 'u'), name);
  }
  assert.doesNotMatch(source, /sms_phone_verification_receipts/u, 'an SMS verification is never WhatsApp possession');
});
