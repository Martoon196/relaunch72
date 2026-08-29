import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migrationUrl = new URL(
  '../../src/db/migrations/0051_property_predator_campaign_machine.sql',
  import.meta.url,
);

async function migration(): Promise<string> {
  return (await readFile(migrationUrl, 'utf8')).replace(/\r\n?/gu, '\n');
}

test('0051 models template versions, steps, recipes, review and reporting as separate evidence', async () => {
  const sql = await migration();
  for (const table of [
    'campaign_templates',
    'campaign_template_versions',
    'campaign_template_steps',
    'campaign_automation_recipe_versions',
    'campaign_reporting_identities',
    'campaign_template_approval_requests',
    'campaign_template_approval_decisions',
  ]) {
    assert.match(sql, new RegExp(`CREATE TABLE app\\.${table} \\(`));
  }
  assert.match(sql, /FOREIGN KEY \(workspace_id, journey_version_id, entry_milestone_id\)/);
  assert.match(sql, /FOREIGN KEY \(workspace_id, journey_version_id, target_milestone_id\)/);
  assert.match(sql, /template_version_sha256 bytea NOT NULL/);
  assert.match(sql, /reporting_key citext NOT NULL/);
});

test('0051 makes history append-only and approval exact/latest', async () => {
  const sql = await migration();
  assert.match(sql, /campaign versions, steps, recipes, reporting and review evidence are append-only/);
  assert.match(sql, /BEFORE UPDATE OR DELETE ON app\.%I/);
  assert.match(sql, /campaign approval requires the latest immutable template version/);
  assert.match(sql, /campaign template version already has a pending approval request/);
  assert.match(sql, /campaign approval decision does not bind the latest exact request/);
  assert.match(sql, /UNIQUE \(workspace_id, approval_request_id\)/);
});

test('0051 stores no recipient identity and grants no provider mutation capability', async () => {
  const sql = await migration();
  assert.match(sql, /provider_effects boolean NOT NULL DEFAULT false CHECK \(NOT provider_effects\)/);
  assert.match(sql, /No queue|creates no queue|no queue/iu);
  assert.match(sql, /provider-capable role % can mutate campaign machine table %/);
  assert.match(sql, /GRANT SELECT ON app\.campaign_templates/);
  assert.doesNotMatch(sql, /GRANT (?:INSERT|UPDATE|DELETE).*r72_(?:provider|mailgun|public_social)/iu);
  assert.doesNotMatch(sql, /\b(?:contact_id|contact_point_id|recipient_id|email_sha256|provider_connection_id)\s+(?:uuid|bytea|text)\b/iu);
});

test('0051 hashes exact copy and rejects raw email addresses in reusable templates', async () => {
  const sql = await migration();
  assert.match(sql, /content_sha256 = public\.digest/);
  assert.match(sql, /coalesce\(subject_template, ''\).*pg_catalog\.chr\(31\)/s);
  assert.match(sql, /subject_template !~\* '\[A-Z0-9\._%\+\-\]\+@/);
  assert.match(sql, /body_template !~\* '\[A-Z0-9\._%\+\-\]\+@/);
});
