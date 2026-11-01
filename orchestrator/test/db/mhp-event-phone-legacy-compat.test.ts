import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';

// 0131 replaces nine existing definitions. Each must equal its latest prior
// definition byte-for-byte except for the single named exclusion predicate.
const DIR = new URL('../../src/db/migrations/', import.meta.url);

async function definitions(name: string): Promise<{ file: string; text: string }[]> {
  const found: { file: string; text: string }[] = [];
  for (const file of (await readdir(DIR)).filter(f => f.endsWith('.sql')).sort()) {
    const source = (await readFile(new URL(file, DIR), 'utf8')).replace(/\r\n/gu, '\n');
    const pattern = new RegExp(`CREATE (?:OR REPLACE )?FUNCTION app_private\\.${name}\\(`, 'gu');
    for (const match of source.matchAll(pattern)) {
      const start = match.index!;
      const tag = /AS (\$[a-zA-Z_]*\$)/u.exec(source.slice(start))![1]!;
      const bodyStart = source.indexOf(tag, start) + tag.length;
      const end = source.indexOf(tag, bodyStart) + tag.length;
      found.push({ file, text: source.slice(start, source.indexOf(';', end) + 1).replace(/^CREATE FUNCTION/u, 'CREATE OR REPLACE FUNCTION') });
    }
  }
  return found;
}

const CASES: { name: string; edits: [string, string, number][] }[] = [
  { name: 'mhp_claim_marketing_sends', edits: [["WHERE s.owner_content_version_id IS NULL AND", "WHERE s.delivery_channel='email' AND s.owner_content_version_id IS NULL AND", 4]] },
  { name: 'mhp_settle_marketing_send', edits: [["AND owner_content_version_id IS NULL;", "AND owner_content_version_id IS NULL AND delivery_channel='email';", 2]] },
  { name: 'mhp_unsubscribe_prospect', edits: [[" WHERE prospect_id=p_prospect AND sent_at IS NULL", " WHERE prospect_id=p_prospect AND delivery_channel='email' AND sent_at IS NULL", 1]] },
  { name: 'mhp_growth_summary', edits: [["FROM app_private.mhp_marketing_sends WHERE ", "FROM app_private.mhp_marketing_sends WHERE delivery_channel='email' AND ", 3]] },
  { name: 'mhp_owner_email_snapshot', edits: [["FROM app_private.mhp_marketing_sends s WHERE s.owner_content_version_id IS NULL AND s.campaign_key=p_campaign",
    "FROM app_private.mhp_marketing_sends s WHERE s.delivery_channel='email' AND s.owner_content_version_id IS NULL AND s.campaign_key=p_campaign", 1]] },
  { name: 'claim_sms_live_job', edits: [
    ["      AND job.provider_connection_id = p_provider_connection_id\n      AND (", "      AND job.provider_connection_id = p_provider_connection_id\n      AND job.authority_kind = 'owner_action'\n      AND (", 1],
    ["   AND authority.recipient_sha256 = job.recipient_sha256\n  JOIN app.provider_connections", "   AND authority.recipient_sha256 = job.recipient_sha256\n   AND authority.authority_kind = 'owner_action'\n  JOIN app.provider_connections", 1],
    ["    AND job.state = 'queued' AND job.available_at <= statement_timestamp()\n", "    AND job.state = 'queued' AND job.available_at <= statement_timestamp()\n    AND job.authority_kind = 'owner_action'\n", 1]] },
  { name: 'load_sms_live_job', edits: [["    AND job.lease_expires_at > statement_timestamp()\n    AND authority.valid_until", "    AND job.lease_expires_at > statement_timestamp()\n    AND job.authority_kind = 'owner_action' AND authority.authority_kind = 'owner_action'\n    AND authority.valid_until", 1]] },
  { name: 'begin_sms_live_call', edits: [
    ["    AND job.lease_expires_at > statement_timestamp()\n  FOR UPDATE OF job;", "    AND job.lease_expires_at > statement_timestamp()\n    AND job.authority_kind = 'owner_action'\n  FOR UPDATE OF job;", 1],
    ["      AND authority.id = selected.authority_id\n      AND authority.provider_connection_id = selected.provider_connection_id\n      AND authority.message_delivery_id = selected.message_delivery_id\n      AND authority.recipient_sha256",
     "      AND authority.id = selected.authority_id\n      AND authority.authority_kind = 'owner_action'\n      AND authority.provider_connection_id = selected.provider_connection_id\n      AND authority.message_delivery_id = selected.message_delivery_id\n      AND authority.recipient_sha256", 1]] },
  { name: 'sms_live_job_identity_guard', edits: [["     OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id\n",
    "     OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id\n     OR NEW.authority_kind IS DISTINCT FROM OLD.authority_kind\n     OR NEW.event_calendar_id IS DISTINCT FROM OLD.event_calendar_id\n     OR NEW.created_by_actor_kind IS DISTINCT FROM OLD.created_by_actor_kind\n", 1]] },
];

for (const { name, edits } of CASES) {
  test(`0131 ${name} is the exact prior body plus only its exclusion predicate`, async () => {
    const all = await definitions(name);
    const replacement = all.at(-1)!, prior = all.at(-2)!;
    assert.equal(replacement.file, '0131_mhp_event_phone_programme.sql');
    assert.notEqual(prior.file, replacement.file);
    let expected = prior.text;
    for (const [from, to, count] of edits) {
      assert.equal(expected.split(from).length - 1, count, `${name}: expected ${count} anchor(s)`);
      expected = expected.split(from).join(to);
    }
    assert.equal(replacement.text, expected);
  });
}

test('0131 installs every SMS calendar exclusion the agreed inventory names', async () => {
  const source = await readFile(new URL('0131_mhp_event_phone_programme.sql', DIR), 'utf8');
  for (const name of CASES.map(c => c.name)) assert.match(source, new RegExp(`CREATE OR REPLACE FUNCTION app_private\\.${name}\\(`, 'u'));
  // Owner/sequence/capture paths are structurally fenced and must not be redefined here.
  for (const name of ['mhp_capture_signup', 'mhp_capture_signup_v2', 'mhp_claim_owner_marketing_sends', 'mhp_sequence_claim_v2',
    'settle_sms_live_call', 'authorize_and_enqueue_sms_live_job', 'record_sms_live_inbound_projection', 'record_sms_live_status_receipt']) {
    assert.doesNotMatch(source, new RegExp(`FUNCTION app_private\\.${name}\\(`, 'u'));
  }
});
