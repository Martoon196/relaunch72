import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migrationUrl = new URL(
  '../../src/db/migrations/0017_property_predator_growth_projector.sql',
  import.meta.url,
);

function normalise(sql: string): string {
  return sql.replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ').trim();
}

async function migration(): Promise<string> {
  return normalise(await readFile(migrationUrl, 'utf8'));
}

test('0017 replaces direct webhook Growth writes with one narrow definer capability', async () => {
  const sql = await migration();

  assert.match(sql, /CREATE ROLE r72_growth_projector_definer NOLOGIN NOINHERIT/);
  assert.match(sql, /rolname = 'r72_growth_projector_definer' AND NOT rolcanlogin AND NOT rolinherit AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls/);
  assert.match(sql, /Unsafe Growth projector role membership/);
  assert.match(sql, /Unsafe Growth projector role grant/);

  for (const table of [
    'contact_source_identities',
    'content_consumption_facts',
    'offer_presentation_facts',
    'offer_response_facts',
    'contact_attribution_facts',
  ]) {
    assert.match(sql, new RegExp(`DROP POLICY IF EXISTS ${table}_webhook_select ON app\\.${table}`));
    assert.match(sql, new RegExp(`DROP POLICY IF EXISTS ${table}_webhook_insert ON app\\.${table}`));
  }
  assert.match(sql, /REVOKE ALL ON app\.contact_source_identities, app\.content_consumption_facts, app\.offer_presentation_facts, app\.offer_response_facts, app\.contact_attribution_facts FROM r72_webhook/);
  assert.match(sql, /REVOKE ALL ON app_private\.external_event_projection_receipts FROM r72_webhook/);
  assert.match(sql, /REVOKE ALL ON FUNCTION app_private\.project_property_predator_growth_event\(uuid\) FROM PUBLIC,[^;]+r72_external_event_command, r72_external_event_definer/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION app_private\.project_property_predator_growth_event\(uuid\) TO r72_webhook/);
  assert.doesNotMatch(sql, /GRANT (?:SELECT|INSERT|UPDATE|DELETE)[^;]+ TO r72_webhook/);
});

test('0017 accepts only an event ID and derives every fact from the private shadow payload', async () => {
  const sql = await migration();
  const signature = /CREATE FUNCTION app_private\.project_property_predator_growth_event\((.*?)\) RETURNS TABLE/.exec(sql)?.[1];
  assert.equal(signature, ' p_event_id uuid ');

  const body = /CREATE FUNCTION app_private\.project_property_predator_growth_event\(.*?AS \$function\$(.*?)\$function\$;/.exec(sql)?.[1];
  assert.ok(body);
  assert.match(sql, /CREATE FUNCTION app_private\.project_property_predator_growth_event\( p_event_id uuid \) RETURNS TABLE \( disposition text, replayed boolean \) LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog/);
  assert.match(body, /FROM app_private\.external_event_shadow_receipts AS receipt WHERE receipt\.workspace_id = trusted_workspace_id AND receipt\.source = 'property_predator' AND receipt\.event_id = p_event_id/);
  assert.match(body, /event_data := shadow_receipt\.event_payload->'data'/);
  assert.doesNotMatch(body, /p_(?:workspace|contact|subject|payload|label|progress|price|currency|response|offer|content)/);
  assert.doesNotMatch(body, /record_external_event_shadow_receipt/);

  for (const eventType of [
    'identity.account.created',
    'affiliate.referral.attributed',
    'content.consumption.progressed',
    'content.consumption.completed',
    'offer.presented',
    'offer.responded',
  ]) assert.ok(body.includes(`'${eventType}'`));
  for (const unsupported of [
    'privacy.consent.updated',
    'product.analysis.completed',
    'commerce.purchase.completed',
    'commerce.purchase.refunded',
    'commerce.subscription.cancelled',
  ]) assert.equal(body.includes(`'${unsupported}'`), false);

  assert.match(body, /INSERT INTO app_private\.external_event_projection_receipts \([^)]*\) VALUES \( trusted_workspace_id, shadow_receipt\.source, shadow_receipt\.event_id, shadow_receipt\.event_type, shadow_receipt\.subject_kind, shadow_receipt\.subject_id, shadow_receipt\.payload_sha256, trusted_request_id \) ON CONFLICT \(workspace_id, source, event_id\) DO NOTHING RETURNING id INTO projected_receipt_id/);
  assert.match(body, /projection_replayed := inserted_receipt_count = 0/);
  assert.match(body, /projection receipt conflicts with accepted shadow event/);
  assert.match(body, /RETURN QUERY SELECT 'projected'::text, projection_replayed/);
});

test('0017 safely creates or resolves the CRM identity before dependent evidence', async () => {
  const sql = await migration();

  assert.match(sql, /pg_advisory_xact_lock\( pg_catalog\.hashtextextended\( 'property-predator-event:'/);
  assert.match(sql, /pg_advisory_xact_lock\( pg_catalog\.hashtextextended\( 'property-predator-account:'/);
  assert.match(sql, /pg_advisory_xact_lock\( pg_catalog\.hashtextextended\( 'property-predator-email:'/);
  assert.match(sql, /FROM app\.contact_source_identities AS identity WHERE identity\.workspace_id = trusted_workspace_id AND identity\.source_system = 'property_predator' AND identity\.source_subject_kind = shadow_receipt\.subject_kind AND identity\.source_subject_id = shadow_receipt\.subject_id/);
  assert.match(sql, /count\(DISTINCT point\.contact_id\).*FROM app\.contact_points AS point WHERE point\.workspace_id = trusted_workspace_id AND point\.kind = 'email' AND point\.normalized_value = canonical_email AND point\.dedupe_state = 'normal' AND point\.deleted_at IS NULL/);
  assert.match(sql, /Property Predator email matches multiple CRM contacts/);
  assert.match(sql, /INSERT INTO app\.contacts \([^)]*\) VALUES \( trusted_workspace_id,[^;]+ 'property_predator', '\{\}'::jsonb \) RETURNING id INTO resolved_contact_id/);
  assert.match(sql, /INSERT INTO app\.contact_points \([^)]*\) VALUES \( trusted_workspace_id, resolved_contact_id, 'email', 'Property Predator account', canonical_email, canonical_email, true, false, 'normal', 'unknown' \)/);
  assert.match(sql, /INSERT INTO app\.contact_source_identities \([^)]*\)[^;]+shadow_receipt\.event_type, shadow_receipt\.payload_sha256, shadow_receipt\.occurred_at/);
  assert.match(sql, /Property Predator account identity is required before evidence/);
  assert.match(sql, /USING ERRCODE = '23503'/);
});

test('0017 maps content, offers, responses, and attribution exactly from canonical data', async () => {
  const sql = await migration();

  assert.match(sql, /expected_action := CASE shadow_receipt\.event_type WHEN 'content\.consumption\.progressed' THEN 'progressed' ELSE 'completed' END/);
  assert.match(sql, /event_data->>'progressBasisPoints'/);
  assert.match(sql, /event_data->>'consumedSeconds'/);
  assert.match(sql, /event_data->>'contentKey'/);
  assert.match(sql, /event_data->>'contentVersion'/);
  assert.match(sql, /event_data->>'title'/);
  assert.match(sql, /content\.consumption\.completed' AND event_data->>'progressBasisPoints' IS DISTINCT FROM '10000'/);

  assert.match(sql, /event_data->>'offerKey'/);
  assert.match(sql, /event_data->>'offerVersion'/);
  assert.match(sql, /event_data->>'productKey'/);
  assert.match(sql, /event_data->>'label'/);
  assert.match(sql, /event_data->'price'->>'amountMinor'/);
  assert.match(sql, /upper\(event_data->'price'->>'currency'\)/);
  assert.match(sql, /event_data->>'placement'/);

  assert.match(sql, /FROM app\.offer_presentation_facts AS fact WHERE fact\.workspace_id = trusted_workspace_id AND fact\.source_system = shadow_receipt\.source AND fact\.source_event_id = \(event_data->>'presentationEventId'\)::uuid AND fact\.contact_id = resolved_contact_id AND fact\.contact_source_identity_id = source_identity_id AND fact\.source_subject_id = shadow_receipt\.subject_id/);
  assert.match(sql, /matching offer presentation evidence is required before response/);
  assert.match(sql, /fact\.response = event_data->>'response'/);
  assert.match(sql, /'accepted', 'declined', 'deferred', 'requested_contact'/);
  assert.doesNotMatch(sql, /'presented', 'accepted'/);

  assert.match(sql, /'affiliate_referral', 'affiliate', event_data->>'model', \(event_data->>'affiliateId'\)::uuid, event_data->>'referralCode'/);
  assert.match(sql, /existing (?:content evidence|offer presentation|offer response|attribution evidence) conflicts with canonical payload/);
});

test('0017 keeps forced RLS active and audits both runtime roles table-blind', async () => {
  const sql = await migration();

  for (const table of ['contacts', 'contact_points']) {
    assert.match(sql, new RegExp(`CREATE POLICY ${table}_growth_projector_select ON app\\.${table}`));
    assert.match(sql, new RegExp(`CREATE POLICY ${table}_growth_projector_insert ON app\\.${table}`));
  }
  assert.match(sql, /table_name \|\| '_growth_projector_select'/);
  assert.match(sql, /table_name \|\| '_growth_projector_insert'/);
  assert.match(sql, /external_event_projection_receipts_growth_projector_select/);
  assert.match(sql, /external_event_projection_receipts_growth_projector_insert/);
  assert.match(sql, /workspace_id = app_private\.current_workspace_id\(\) AND app_private\.current_actor_kind\(\) = 'webhook'/);

  assert.match(sql, /owner_role\.rolname = 'r72_growth_projector_definer' AND procedure\.prosecdef AND procedure\.proconfig = ARRAY\['search_path=pg_catalog'\]::text\[\]/);
  assert.match(sql, /Webhook unexpectedly has direct Growth table privilege/);
  assert.match(sql, /External-event command unexpectedly has table privilege/);
  assert.match(sql, /External-event command unexpectedly has app schema access/);
  assert.match(sql, /Growth projector definer schema capabilities are unsafe/);
  assert.match(sql, /Growth projector definer unexpectedly can execute/);
  assert.match(sql, /Growth projector definer table capability map is unsafe/);
  for (const privilege of [
    'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER',
  ]) assert.ok(sql.includes(`relation.oid, '${privilege}'`));
  for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']) {
    assert.ok(sql.includes(`has_any_column_privilege( 'r72_webhook', relation.oid, '${privilege}' )`));
    assert.ok(sql.includes(`has_any_column_privilege( 'r72_external_event_command', relation.oid, '${privilege}' )`));
  }

  assert.doesNotMatch(sql, /GRANT (?:UPDATE|DELETE|TRUNCATE|REFERENCES|TRIGGER) ON/);
  assert.doesNotMatch(sql, /ALTER TABLE app\.(?:contact_source_identities|content_consumption_facts|offer_presentation_facts|offer_response_facts|contact_attribution_facts) DISABLE ROW LEVEL SECURITY/);
});
