import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migrationUrl = new URL(
  '../../src/db/migrations/0084_founder_email_pilot_readiness_app_rls_repair.sql',
  import.meta.url,
);

const expectedTables = [
  'contact_points',
  'contacts',
  'channel_endpoints',
  'provider_connections',
  'communication_consent_events',
  'communication_suppression_events',
  'messages',
  'message_versions',
  'message_approval_requests',
  'message_approval_decisions',
  'conversations',
  'campaign_template_versions',
  'campaign_template_steps',
  'campaign_template_approval_requests',
  'campaign_template_approval_decisions',
  'property_predator_email_pilot_approved_content',
  'property_predator_customer_email_jobs',
] as const;

test('0084 exposes only 0064 read evidence through workspace-scoped RLS', async () => {
  const sql = await readFile(migrationUrl, 'utf8');

  for (const table of expectedTables) {
    assert.match(sql, new RegExp(`'${table}'`, 'u'));
  }
  assert.match(sql,
    /CREATE POLICY %I ON app\.%I FOR SELECT'[\s\S]*?TO r72_email_pilot_readiness_definer/u);
  assert.match(sql,
    /workspace_id = nullif\('[\s\S]*?current_setting\(''app\.workspace_id'', true\), ''''\)::uuid/u);
  assert.doesNotMatch(sql, /\bGRANT\s+(?:SELECT|INSERT|UPDATE|DELETE|TRUNCATE)\b/u);
  assert.match(sql,
    /ARRAY\[\s*'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'\s*\]/u);
  assert.match(sql,
    /r72_crm_command'[\s\S]*?property_predator_email_pilot_approved_content'[\s\S]*?r72_crm_command'[\s\S]*?property_predator_customer_email_jobs'/u);
});
