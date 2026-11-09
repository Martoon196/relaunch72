import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migrationUrl = new URL(
  '../../src/db/migrations/0018_property_predator_journey_runtime.sql',
  import.meta.url,
);

function normalise(sql: string): string {
  return sql.replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ').trim();
}

function projectorBody(sql: string): string {
  const body = /CREATE FUNCTION app_private\.project_property_predator_journey_event\(p_event_id uuid\)(.*?)\$function\$;/.exec(sql)?.[1];
  assert.ok(body, 'journey projector function is present');
  return body;
}

const eventTypes = [
  'identity.account.created',
  'privacy.consent.updated',
  'affiliate.referral.attributed',
  'product.analysis.completed',
  'content.consumption.progressed',
  'content.consumption.completed',
  'offer.presented',
  'offer.responded',
  'sales.appointment.booked',
  'sales.presentation.completed',
  'commerce.purchase.completed',
  'commerce.purchase.refunded',
  'commerce.subscription.cancelled',
] as const;

test('0018 forward-extends ingress and creates one immutable forced-RLS journey receipt', async () => {
  const sql = normalise(await readFile(migrationUrl, 'utf8'));
  const receipt = /CREATE TABLE app_private\.external_event_journey_projection_receipts \((.*?)\);/.exec(sql)?.[1];
  assert.ok(receipt);

  for (const eventType of eventTypes) {
    const escaped = eventType.replaceAll('.', '\\.');
    assert.match(sql, new RegExp(`'${escaped}'`));
    assert.match(receipt, new RegExp(`'${escaped}'`));
  }
  assert.match(sql, /ALTER TABLE app_private\.external_event_shadow_receipts DROP CONSTRAINT external_event_shadow_receipts_event_type_check/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION app_private\.record_external_event_shadow_receipt\(/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION app_private\.record_external_event_shadow_receipt\([^;]+\) TO r72_external_event_command/);
  assert.match(receipt, /UNIQUE \(workspace_id, source, event_id\)/);
  assert.match(receipt, /FOREIGN KEY \( workspace_id, source, event_id, event_type, subject_kind, subject_id, payload_sha256 \) REFERENCES app_private\.external_event_shadow_receipts \( workspace_id, source, event_id, event_type, subject_kind, subject_id, payload_sha256 \) ON DELETE RESTRICT/);
  assert.match(receipt, /enrollments_started BETWEEN 0 AND 16/);
  assert.match(receipt, /milestones_achieved BETWEEN 0 AND 32/);
  assert.match(receipt, /score_snapshots_written BETWEEN 0 AND 32/);
  assert.match(receipt, /consent_facts_written BETWEEN 0 AND 1/);
  assert.match(receipt, /commerce_facts_written BETWEEN 0 AND 1/);
  assert.match(sql, /ALTER TABLE app_private\.external_event_journey_projection_receipts ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /ALTER TABLE app_private\.external_event_journey_projection_receipts FORCE ROW LEVEL SECURITY/);
  assert.match(sql, /\('app_private', 'external_event_journey_projection_receipts', 'workspace_id'\)/);
  assert.doesNotMatch(sql, /GRANT (?:UPDATE|DELETE)[^;]*external_event_journey_projection_receipts/);
});

test('0018 exposes only an immutable-ID projector and serializes replay before deriving facts', async () => {
  const sql = normalise(await readFile(migrationUrl, 'utf8'));
  const body = projectorBody(sql);
  assert.match(sql, /CREATE FUNCTION app_private\.project_property_predator_journey_event\(p_event_id uuid\) RETURNS TABLE \( disposition text, replayed boolean, enrollments_started integer, milestones_achieved integer, score_snapshots_written integer, consent_facts_written integer, commerce_facts_written integer \) LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog/);
  assert.match(body, /trusted_workspace_id uuid := app_private\.current_workspace_id\(\)/);
  assert.match(body, /trusted_actor_kind IS DISTINCT FROM 'webhook'/);
  assert.match(body, /FROM app_private\.external_event_shadow_receipts AS receipt WHERE receipt\.workspace_id = trusted_workspace_id AND receipt\.source = 'property_predator' AND receipt\.event_id = p_event_id/);
  assert.match(body, /jsonb_typeof\(shadow_receipt\.event_payload\) IS DISTINCT FROM 'object'/);
  assert.match(body, /shadow_receipt\.event_payload->>'id' IS DISTINCT FROM shadow_receipt\.event_id::text/);
  assert.match(body, /shadow_receipt\.event_payload->>'type' IS DISTINCT FROM shadow_receipt\.event_type/);
  assert.match(body, /shadow_receipt\.event_payload->'subject'->>'id' IS DISTINCT FROM shadow_receipt\.subject_id::text/);

  const eventFence = body.indexOf("'property-predator-journey-event:'");
  const subjectFence = body.indexOf("'property-predator-journey-subject:'");
  const replayRead = body.indexOf('FROM app_private.external_event_journey_projection_receipts AS receipt', subjectFence);
  const readiness = body.indexOf('property_predator_journey_runtime_ready()', replayRead);
  const firstFactWrite = body.indexOf('INSERT INTO app.', readiness);
  assert.ok(eventFence >= 0 && eventFence < subjectFence);
  assert.ok(subjectFence >= 0 && subjectFence < replayRead);
  assert.ok(replayRead >= 0 && replayRead < readiness && readiness < firstFactWrite);
  assert.match(body, /RETURN QUERY SELECT 'projected'::text, true, prior_receipt\.enrollments_started, prior_receipt\.milestones_achieved, prior_receipt\.score_snapshots_written, prior_receipt\.consent_facts_written, prior_receipt\.commerce_facts_written/);

  const receiptWrite = body.lastIndexOf('INSERT INTO app_private.external_event_journey_projection_receipts');
  const lastOutboxWrite = body.lastIndexOf('append_property_predator_journey_outbox');
  assert.ok(receiptWrite > lastOutboxWrite, 'projection receipt is the transactional final write');
});

test('0018 rejects poisoned envelope and null-or-coerced payload scalars before projection', async () => {
  const sql = normalise(await readFile(migrationUrl, 'utf8'));
  const recorder = /CREATE OR REPLACE FUNCTION app_private\.record_external_event_shadow_receipt\((.*?)\$function\$;/.exec(sql)?.[1];
  const body = projectorBody(sql);
  assert.ok(recorder);
  assert.match(recorder, /jsonb_typeof\(p_event_payload->'version'\) IS DISTINCT FROM 'number'/);
  assert.match(recorder, /p_event_payload->>'occurredAt' !~ '\^\[0-9\]/);
  assert.match(recorder, /pg_catalog\.pg_input_is_valid\( p_event_payload->>'occurredAt', 'timestamp with time zone' \)/);
  assert.match(body, /pg_catalog\.pg_input_is_valid\( shadow_receipt\.event_payload->>'occurredAt', 'timestamp with time zone' \)/);
  for (const field of [
    'signupMethod', 'purpose', 'affiliateId', 'toolKey', 'contentKey',
    'offerKey', 'presentationEventId', 'appointmentId', 'presentationKey',
    'provider', 'checkoutSessionId', 'subscriptionId', 'effectiveAt',
  ]) {
    assert.match(
      body,
      new RegExp(`jsonb_typeof\\(event_data->'${field}'\\) IS DISTINCT FROM 'string'`),
    );
  }
  assert.match(body, /jsonb_typeof\(event_data->'amountMinor'\) IS DISTINCT FROM 'number'/);
  assert.match(body, /jsonb_typeof\(event_data->'durationSeconds'\) IS DISTINCT FROM 'number'/);
});

test('0018 readiness requires the exact two published v2 routes pinned to one published v2 score model', async () => {
  const sql = normalise(await readFile(migrationUrl, 'utf8'));
  const readiness = /CREATE FUNCTION app_private\.property_predator_journey_runtime_ready\(\)(.*?)\$function\$;/.exec(sql)?.[1];
  assert.ok(readiness);
  assert.match(readiness, /RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog/);
  assert.match(readiness, /trusted_actor_kind IS DISTINCT FROM 'webhook'/);
  assert.match(readiness, /journey\.slug IN \( 'property-predator-self-serve', 'property-predator-agency-laps' \)/);
  assert.match(readiness, /version_row\.version_no = 2 AND version_row\.published_at IS NOT NULL/);
  assert.match(readiness, /score_model\.slug = 'property-predator-lead-score' AND score_model\.status = 'active' AND score_model\.active_version_id = score_version\.id/);
  assert.match(readiness, /count\(\*\) = 2 AND count\(DISTINCT definition\.journey_slug\) = 2 AND count\(DISTINCT definition\.score_model_version_id\) = 1/);
  assert.match(readiness, /scoreModelDefinitionHash/);
  assert.match(readiness, /count\(\*\) = 8/);
  assert.match(readiness, /count\(\*\) = 7/);
  for (const source of [
    'identity.account.created', 'product.analysis.completed', 'offer.presented',
    'sales.appointment.booked', 'sales.presentation.completed', 'payment_collected',
  ]) {
    assert.match(readiness, new RegExp(`'${source.replaceAll('.', '\\.')}'`));
  }
});

test('0018 enrolls only reviewed non-commerce triggers and advances routes monotonically', async () => {
  const sql = normalise(await readFile(migrationUrl, 'utf8'));
  const body = projectorBody(sql);
  assert.match(body, /FOR trigger_row IN SELECT journey\.slug::text AS journey_slug/);
  assert.match(body, /trigger_definition\.trigger_kind = 'event' AND trigger_definition\.source_key = shadow_receipt\.event_type/);
  assert.match(body, /INSERT INTO app\.conversion_enrollments/);
  assert.match(body, /'property-predator:' \|\| shadow_receipt\.subject_id::text \|\| ':' \|\| trigger_row\.journey_version_id::text/);
  assert.match(body, /shadow_receipt\.event_type = 'sales\.appointment\.booked'/);
  assert.match(body, /'establishedBy', 'first_appointment'/);
  assert.match(body, /status IN \('completed', 'withdrawn', 'disqualified'\)[^;]+CONTINUE/);
  assert.doesNotMatch(body, /terminal_trigger_noop/);
  assert.match(body, /enrollment\.status = 'active'/);
  assert.match(body, /current_milestone_id = CASE WHEN target_current_position IS NULL OR trigger_row\.milestone_position > target_current_position THEN trigger_row\.milestone_id ELSE enrollment\.current_milestone_id END/);
  assert.match(body, /last_event_at = greatest\( coalesce\(enrollment\.last_event_at, shadow_receipt\.occurred_at\), shadow_receipt\.occurred_at \)/);

  const purchaseBranch = body.slice(
    body.lastIndexOf("IF shadow_receipt.event_type = 'commerce.purchase.completed'"),
    body.lastIndexOf("ELSIF shadow_receipt.event_type = 'commerce.purchase.refunded'"),
  );
  assert.doesNotMatch(purchaseBranch, /INSERT INTO app\.conversion_enrollments/);
  assert.match(purchaseBranch, /payment requires an existing active Property Predator enrollment/);
});

test('0018 enforces appointment/presentation causality and exact commerce attribution', async () => {
  const sql = normalise(await readFile(migrationUrl, 'utf8'));
  const body = projectorBody(sql);
  assert.match(body, /appointment_fact\.evidence->>'appointmentId' = event_data->>'appointmentId'/);
  assert.match(body, /shadow_receipt\.occurred_at < selected_prerequisite_occurred_at/);
  assert.match(body, /presentation predates its matching appointment/);

  const purchase = body.indexOf("IF shadow_receipt.event_type = 'commerce.purchase.completed'");
  const agency = body.indexOf("journey.slug = 'property-predator-agency-laps'", purchase);
  const selfServe = body.indexOf("journey.slug = 'property-predator-self-serve'", agency);
  assert.ok(purchase >= 0 && purchase < agency && agency < selfServe);
  assert.match(body, /reached\.milestone_semantic IN \('appointment', 'presentation'\)/);
  assert.match(body, /fact_type = 'payment_collected'/);
  assert.match(body, /'subscription_id', event_data->>'subscriptionId'/);
  assert.match(body, /\(\(event_data->>'billingKind' = 'subscription'\) IS DISTINCT FROM \(event_data \? 'subscriptionId'\)\)/);
  assert.match(body, /status = 'completed'[^;]+current_milestone_id = lead_milestone_id/);

  assert.match(body, /refund requires exactly one original canonical payment/);
  assert.match(body, /payment\.external_order_id = event_data->>'checkoutSessionId'/);
  assert.match(body, /refund predates its original canonical payment/);
  assert.match(body, /refund\.metadata->>'original_payment_fact_id' = selected_payment_fact_id::text/);
  assert.match(body, /refund\.source_event_id IS DISTINCT FROM shadow_receipt\.event_id::text/);
  assert.match(body, /cumulative refunds exceed the original canonical payment/);
  assert.match(body, /multiple qualified active agency enrollments conflict with sale attribution/);
  assert.match(body, /multiple active self-serve enrollments conflict with sale attribution/);
  assert.match(body, /cancellation requires its exact subscription payment/);
  assert.match(body, /payment\.metadata->>'subscription_id' = event_data->>'subscriptionId'/);
  assert.match(body, /cancellation predates its exact subscription payment/);
  assert.match(body, /'subscription_cancelled', event_data->>'subscriptionId', event_data->>'productKey', 0/);
  assert.doesNotMatch(body, /FROM app\.conversion_commerce_facts AS payment[\s\S]{0,700}FOR SHARE/);
});

test('0018 calculates explainable source-time-monotonic snapshots from generic score JSON', async () => {
  const sql = normalise(await readFile(migrationUrl, 'utf8'));
  const body = projectorBody(sql);
  assert.match(body, /score_definition \?& ARRAY\[ 'schemaVersion', 'slug', 'name', 'version', 'components', 'bands', 'rules' \]/);
  assert.match(body, /jsonb_array_elements\(score_definition->'components'\)/);
  assert.match(body, /jsonb_array_elements\(score_definition->'bands'\)/);
  assert.match(body, /jsonb_array_elements\(score_definition->'rules'\)/);
  assert.match(body, /item\.value->>'kind' = 'event' AND item\.value->>'sourceKey' IN \( 'identity\.account\.created', 'product\.analysis\.completed', 'content\.consumption\.completed', 'offer\.presented', 'sales\.appointment\.booked', 'sales\.presentation\.completed' \)/);
  assert.match(body, /item\.value->>'kind' = 'commerce' AND item\.value->>'sourceKey' = 'payment_collected'/);
  assert.match(body, /~ '\(consent\|permission\|suppression\|opt\[_\. -\]\?\(in\|out\)\)'/);
  assert.match(body, /sum\(\(rule\.value->>'points'\)::integer\)/);
  assert.match(body, /FROM app_private\.external_event_journey_projection_receipts AS projected/);
  assert.match(body, /FROM app\.conversion_commerce_facts AS commerce/);
  assert.match(body, /score_source_watermark timestamptz/);
  assert.match(body, /SELECT greatest\( shadow_receipt\.occurred_at, coalesce\(\( SELECT max\(prior_shadow\.occurred_at\)/);
  assert.match(body, /event_rule\.value->>'kind' = 'event' AND event_rule\.value->>'sourceKey' = prior_shadow\.event_type/);
  assert.match(body, /projected\.payload_sha256 = prior_shadow\.payload_sha256 AND projected\.disposition = 'projected'/);
  assert.match(body, /SELECT max\(commerce\.occurred_at\)[^;]+commerce_rule\.value->>'kind' = 'commerce' AND commerce_rule\.value->>'sourceKey' = commerce\.fact_type/);
  assert.match(body, /prior_shadow\.occurred_at <= score_source_watermark/);
  assert.doesNotMatch(body, /prior_shadow\.occurred_at <= shadow_receipt\.occurred_at/);
  assert.match(body, /shadow_receipt\.payload_sha256, 'webhook', NULL, score_source_watermark/);
  assert.match(body, /snapshot\.source_occurred_at = score_source_watermark/);
  assert.match(body, /component_scores, reasons, applied_rules/);
  assert.doesNotMatch(body, /score_total\s*:=\s*\d+/);
});

test('0018 emits one durable canonical outbox family and never emits on replay', async () => {
  const sql = normalise(await readFile(migrationUrl, 'utf8'));
  const helper = /CREATE FUNCTION app_private\.append_property_predator_journey_outbox\((.*?)\$function\$;/.exec(sql)?.[1];
  const body = projectorBody(sql);
  assert.ok(helper);
  for (const eventType of [
    'conversion.enrollment.started',
    'conversion.milestone.achieved',
    'conversion.score.updated',
    'conversion.commerce.fact_recorded',
    'communication.consent.recorded',
  ]) {
    assert.match(body, new RegExp(`'${eventType.replaceAll('.', '\\.')}'`));
  }
  assert.match(helper, /ON CONFLICT \(workspace_id, idempotency_key\) DO NOTHING/);
  assert.match(helper, /p_correlation_id::text, p_causation_id::text, p_occurred_at/);
  assert.match(helper, /greatest\(statement_timestamp\(\), p_occurred_at\), greatest\(statement_timestamp\(\), p_occurred_at\)/);
  assert.match(helper, /existing\.payload = p_payload/);
  assert.match(body, /'pp:' \|\| shadow_receipt\.event_id::text/);
  const replayReturn = body.indexOf("'projected'::text, true");
  const firstOutbox = body.indexOf('append_property_predator_journey_outbox');
  assert.ok(replayReturn >= 0 && replayReturn < firstOutbox);
});

test('0018 leaves webhook and ingress command table-blind behind two narrow definer functions', async () => {
  const sql = normalise(await readFile(migrationUrl, 'utf8'));
  assert.match(sql, /CREATE ROLE r72_journey_projector_definer NOLOGIN NOINHERIT/);
  assert.match(sql, /REVOKE ALL ON SCHEMA app, app_private FROM r72_journey_projector_definer/);
  assert.match(sql, /REVOKE ALL ON ALL TABLES IN SCHEMA app FROM r72_journey_projector_definer/);
  assert.match(sql, /REVOKE ALL ON ALL TABLES IN SCHEMA app_private FROM r72_journey_projector_definer/);
  assert.match(sql, /REVOKE ALL ON app_private\.external_event_shadow_receipts FROM r72_webhook/);
  for (const table of [
    'contacts', 'contact_points', 'contact_source_identities',
    'lead_score_models', 'lead_score_model_versions',
    'conversion_journeys', 'conversion_journey_versions',
    'conversion_journey_milestones', 'conversion_journey_triggers',
    'conversion_enrollments', 'communication_consent_events',
    'communication_suppression_events', 'conversion_commerce_facts',
    'conversion_milestone_facts', 'lead_score_snapshots', 'outbox_events',
  ]) {
    assert.match(sql, new RegExp(`app\\.${table.replaceAll('_', '\\_')}`));
  }
  assert.match(sql, /DROP POLICY IF EXISTS lead_score_models_service_select ON app\.lead_score_models/);
  assert.match(sql, /CREATE POLICY lead_score_models_service_select ON app\.lead_score_models FOR SELECT TO r72_worker/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION app_private\.property_predator_journey_runtime_ready\(\) TO r72_webhook/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION app_private\.project_property_predator_journey_event\(uuid\) TO r72_webhook/);
  assert.doesNotMatch(sql, /GRANT EXECUTE ON FUNCTION app_private\.append_property_predator_journey_outbox\([^;]+\) TO r72_webhook/);
  assert.match(sql, /has_table_privilege\('r72_webhook', relation\.oid, 'TRUNCATE'\)/);
  assert.match(sql, /has_any_column_privilege\('r72_webhook', relation\.oid, 'REFERENCES'\)/);
  assert.match(sql, /External-event command unexpectedly has table privilege/);
  assert.match(sql, /DO \$recorder_acl_hardening\$/);
  assert.match(sql, /External-event recorder has a stale direct EXECUTE grant/);
  assert.match(sql, /Journey projector definer unexpectedly has privilege/);
});
