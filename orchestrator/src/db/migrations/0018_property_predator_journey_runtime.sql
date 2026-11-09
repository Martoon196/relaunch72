-- Secure, payload-derived Property Predator journey projection. The webhook
-- caller may name one immutable accepted event ID; only this definer reopens
-- the signed shadow payload and writes conversion, consent and commerce facts.

DO $roles$
DECLARE
  unexpected_member text;
  unexpected_parent text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles
    WHERE rolname = 'r72_journey_projector_definer'
  ) THEN
    CREATE ROLE r72_journey_projector_definer NOLOGIN NOINHERIT;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_roles
    WHERE rolname = 'r72_journey_projector_definer'
      AND NOT rolcanlogin
      AND NOT rolinherit
      AND NOT rolsuper
      AND NOT rolcreatedb
      AND NOT rolcreaterole
      AND NOT rolreplication
      AND NOT rolbypassrls
  ) THEN
    RAISE EXCEPTION 'Unsafe role attributes: r72_journey_projector_definer';
  END IF;

  REVOKE r72_owner, r72_security_definer, r72_onboarding_definer,
    r72_setup_delivery_definer, r72_commerce_definer,
    r72_external_event_definer, r72_growth_projector_definer
    FROM r72_journey_projector_definer;
  REVOKE r72_journey_projector_definer
    FROM r72_web, r72_public, r72_worker, r72_webhook, r72_readonly,
      r72_crm_command, r72_identity_command, r72_provisioning_command,
      r72_setup_delivery_command, r72_setup_reissue_command,
      r72_external_event_command, r72_external_event_definer,
      r72_growth_projector_definer;

  SELECT member.rolname, parent.rolname
    INTO unexpected_member, unexpected_parent
  FROM pg_catalog.pg_auth_members AS membership
  JOIN pg_catalog.pg_roles AS member ON member.oid = membership.member
  JOIN pg_catalog.pg_roles AS parent ON parent.oid = membership.roleid
  WHERE member.rolname = 'r72_journey_projector_definer'
  LIMIT 1;
  IF unexpected_member IS NOT NULL THEN
    RAISE EXCEPTION 'Unsafe journey projector role membership: % can SET ROLE %',
      unexpected_member, unexpected_parent;
  END IF;

  SELECT member.rolname, parent.rolname
    INTO unexpected_member, unexpected_parent
  FROM pg_catalog.pg_auth_members AS membership
  JOIN pg_catalog.pg_roles AS member ON member.oid = membership.member
  JOIN pg_catalog.pg_roles AS parent ON parent.oid = membership.roleid
  WHERE parent.rolname = 'r72_journey_projector_definer'
    AND member.rolname NOT IN ('r72_owner', current_user)
  LIMIT 1;
  IF unexpected_member IS NOT NULL THEN
    RAISE EXCEPTION 'Unsafe journey projector role grant: % can SET ROLE %',
      unexpected_member, unexpected_parent;
  END IF;

  GRANT r72_journey_projector_definer TO r72_owner;
END
$roles$;

SET LOCAL ROLE r72_owner;

-- Forward-extend the two durable positive registries. Unsupported source keys
-- remain impossible to publish as conversion triggers or record at ingress.
ALTER TABLE app.conversion_journey_triggers
  DROP CONSTRAINT conversion_journey_triggers_check;
ALTER TABLE app.conversion_journey_triggers
  ADD CONSTRAINT conversion_journey_triggers_check CHECK (
    (trigger_kind = 'event' AND source_key IN (
      'identity.account.created',
      'product.analysis.completed',
      'offer.presented',
      'sales.appointment.booked',
      'sales.presentation.completed'
    ))
    OR (trigger_kind = 'commerce' AND source_key = 'payment_collected')
  );

-- The commerce wire key permits a leading digit. Preserve every previously
-- valid stored key while admitting that reviewed contract subset.
ALTER TABLE app.conversion_commerce_facts
  DROP CONSTRAINT conversion_commerce_facts_product_key_check;
ALTER TABLE app.conversion_commerce_facts
  ADD CONSTRAINT conversion_commerce_facts_product_key_check CHECK (
    product_key = lower(btrim(product_key))
    AND product_key ~ '^[a-z0-9][a-z0-9_.:-]{0,99}$'
  );

ALTER TABLE app_private.external_event_shadow_receipts
  DROP CONSTRAINT external_event_shadow_receipts_event_type_check;
ALTER TABLE app_private.external_event_shadow_receipts
  ADD CONSTRAINT external_event_shadow_receipts_event_type_check
  CHECK (event_type IN (
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
    'commerce.subscription.cancelled'
  ));

-- Retain the original receipt-only signature, owner and capability. Only its
-- reviewed event allow-list changes; the command role remains app/table blind.
GRANT CREATE ON SCHEMA app_private TO r72_external_event_definer;
SET LOCAL ROLE r72_external_event_definer;

CREATE OR REPLACE FUNCTION app_private.record_external_event_shadow_receipt(
  p_workspace_id uuid,
  p_source text,
  p_event_id uuid,
  p_event_type text,
  p_event_version smallint,
  p_occurred_at timestamptz,
  p_correlation_id uuid,
  p_subject_kind text,
  p_subject_id uuid,
  p_payload_sha256 bytea,
  p_event_payload jsonb,
  p_signature_key_id text,
  p_signature_timestamp timestamptz
)
RETURNS TABLE (disposition text, replayed boolean)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  trusted_workspace_id uuid := app_private.current_workspace_id();
  trusted_actor_kind text := app_private.current_actor_kind();
  trusted_request_id text := app_private.current_request_id();
  inserted_receipt_count integer;
  existing_payload_sha256 bytea;
BEGIN
  IF trusted_actor_kind IS DISTINCT FROM 'webhook'
     OR trusted_workspace_id IS NULL
     OR p_workspace_id IS DISTINCT FROM trusted_workspace_id THEN
    RAISE EXCEPTION 'external event receipt context denied'
      USING ERRCODE = '42501';
  END IF;

  IF trusted_request_id IS NULL
     OR length(trusted_request_id) NOT BETWEEN 1 AND 128
     OR trusted_request_id ~ '[^[:graph:]]'
     OR p_source IS DISTINCT FROM 'property_predator'
     OR p_event_id IS NULL
     OR p_event_type IS NULL
     OR p_event_type NOT IN (
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
       'commerce.subscription.cancelled'
     )
     OR p_event_version IS DISTINCT FROM 1
     OR p_occurred_at IS NULL
     OR p_correlation_id IS NULL
     OR p_subject_kind IS DISTINCT FROM 'account'
     OR p_subject_id IS NULL
     OR p_payload_sha256 IS NULL
     OR octet_length(p_payload_sha256) <> 32
     OR p_signature_key_id IS NULL
     OR length(p_signature_key_id) NOT BETWEEN 1 AND 64
     OR p_signature_key_id !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
     OR p_signature_timestamp IS NULL
     OR p_event_payload IS NULL
     OR jsonb_typeof(p_event_payload) IS DISTINCT FROM 'object'
     OR NOT (p_event_payload ?& ARRAY[
       'id', 'type', 'version', 'occurredAt', 'correlationId', 'subject', 'data'
     ])
     OR p_event_payload - ARRAY[
       'id', 'type', 'version', 'occurredAt', 'correlationId', 'subject', 'data'
     ] <> '{}'::jsonb
     OR p_event_payload->>'id' IS DISTINCT FROM p_event_id::text
     OR p_event_payload->>'type' IS DISTINCT FROM p_event_type
     OR jsonb_typeof(p_event_payload->'version') IS DISTINCT FROM 'number'
     OR p_event_payload->>'version' IS DISTINCT FROM p_event_version::text
     OR p_event_payload->>'occurredAt'
          !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
     OR NOT (CASE
       WHEN p_event_payload->>'occurredAt'
              ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
        AND pg_catalog.pg_input_is_valid(
              p_event_payload->>'occurredAt', 'timestamp with time zone'
            )
       THEN (p_event_payload->>'occurredAt')::timestamptz
              IS NOT DISTINCT FROM p_occurred_at
       ELSE false
     END)
     OR p_event_payload->>'correlationId' IS DISTINCT FROM p_correlation_id::text
     OR jsonb_typeof(p_event_payload->'subject') IS DISTINCT FROM 'object'
     OR NOT ((p_event_payload->'subject') ?& ARRAY['kind', 'id'])
     OR (p_event_payload->'subject') - ARRAY['kind', 'id'] <> '{}'::jsonb
     OR p_event_payload->'subject'->>'kind' IS DISTINCT FROM p_subject_kind
     OR p_event_payload->'subject'->>'id' IS DISTINCT FROM p_subject_id::text
     OR jsonb_typeof(p_event_payload->'data') IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'invalid external event shadow receipt input'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO app_private.external_event_shadow_receipts (
    workspace_id, source, event_id, event_type, event_version, occurred_at,
    correlation_id, subject_kind, subject_id, payload_sha256, event_payload,
    signature_key_id, signature_timestamp, disposition, actor_kind, request_id
  ) VALUES (
    trusted_workspace_id, p_source, p_event_id, p_event_type, p_event_version,
    p_occurred_at, p_correlation_id, p_subject_kind, p_subject_id,
    p_payload_sha256, p_event_payload, p_signature_key_id,
    p_signature_timestamp, 'shadow', 'webhook', trusted_request_id
  )
  ON CONFLICT (workspace_id, source, event_id) DO NOTHING;

  GET DIAGNOSTICS inserted_receipt_count = ROW_COUNT;
  IF inserted_receipt_count = 0 THEN
    SELECT receipt.payload_sha256
      INTO existing_payload_sha256
    FROM app_private.external_event_shadow_receipts AS receipt
    WHERE receipt.workspace_id = trusted_workspace_id
      AND receipt.source = p_source
      AND receipt.event_id = p_event_id;
    IF NOT FOUND OR existing_payload_sha256 IS DISTINCT FROM p_payload_sha256 THEN
      RAISE EXCEPTION 'external event id was replayed with different payload bytes'
        USING ERRCODE = '22000';
    END IF;
    RETURN QUERY SELECT 'shadow'::text, true;
    RETURN;
  END IF;

  RETURN QUERY SELECT 'shadow'::text, false;
END
$function$;

SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private FROM r72_external_event_definer;

-- CREATE OR REPLACE preserves ACLs. Remove any direct stale grantee that may
-- have existed before this forward migration, then add back the one command.
DO $recorder_acl_hardening$
DECLARE
  stale_grantee text;
BEGIN
  FOR stale_grantee IN
    SELECT role.rolname
    FROM pg_catalog.pg_proc AS procedure
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      coalesce(
        procedure.proacl,
        pg_catalog.acldefault('f', procedure.proowner)
      )
    ) AS privilege
    JOIN pg_catalog.pg_roles AS role ON role.oid = privilege.grantee
    WHERE procedure.oid = pg_catalog.to_regprocedure(
      'app_private.record_external_event_shadow_receipt(uuid,text,uuid,text,smallint,timestamptz,uuid,text,uuid,bytea,jsonb,text,timestamptz)'
    )
      AND privilege.privilege_type = 'EXECUTE'
      AND role.rolname NOT IN (
        'r72_external_event_definer', 'r72_external_event_command'
      )
  LOOP
    EXECUTE format(
      'REVOKE ALL ON FUNCTION app_private.record_external_event_shadow_receipt(uuid,text,uuid,text,smallint,timestamptz,uuid,text,uuid,bytea,jsonb,text,timestamptz) FROM %I',
      stale_grantee
    );
  END LOOP;
END
$recorder_acl_hardening$;

REVOKE ALL ON FUNCTION app_private.record_external_event_shadow_receipt(
  uuid, text, uuid, text, smallint, timestamptz, uuid, text, uuid, bytea,
  jsonb, text, timestamptz
) FROM PUBLIC, r72_web, r72_public, r72_worker, r72_webhook, r72_readonly,
  r72_crm_command, r72_identity_command, r72_provisioning_command,
  r72_setup_delivery_command, r72_setup_reissue_command,
  r72_external_event_command;
GRANT EXECUTE ON FUNCTION app_private.record_external_event_shadow_receipt(
  uuid, text, uuid, text, smallint, timestamptz, uuid, text, uuid, bytea,
  jsonb, text, timestamptz
) TO r72_external_event_command;

-- A journey receipt is separate from the Growth evidence receipt because one
-- source event can legitimately require both projections. Stored result counts
-- make retries bounded and stable without reopening public fact tables.
CREATE TABLE app_private.external_event_journey_projection_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE RESTRICT,
  source text NOT NULL CHECK (source = 'property_predator'),
  event_id uuid NOT NULL,
  event_type text NOT NULL CHECK (event_type IN (
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
    'commerce.subscription.cancelled'
  )),
  subject_kind text NOT NULL CHECK (subject_kind = 'account'),
  subject_id uuid NOT NULL,
  payload_sha256 bytea NOT NULL CHECK (octet_length(payload_sha256) = 32),
  request_id text NOT NULL CHECK (
    length(request_id) BETWEEN 1 AND 128 AND request_id !~ '[^[:graph:]]'
  ),
  disposition text NOT NULL DEFAULT 'projected' CHECK (disposition = 'projected'),
  enrollments_started integer NOT NULL CHECK (enrollments_started BETWEEN 0 AND 16),
  milestones_achieved integer NOT NULL CHECK (milestones_achieved BETWEEN 0 AND 32),
  score_snapshots_written integer NOT NULL CHECK (score_snapshots_written BETWEEN 0 AND 32),
  consent_facts_written integer NOT NULL CHECK (consent_facts_written BETWEEN 0 AND 1),
  commerce_facts_written integer NOT NULL CHECK (commerce_facts_written BETWEEN 0 AND 1),
  projected_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, source, event_id),
  FOREIGN KEY (
    workspace_id, source, event_id, event_type,
    subject_kind, subject_id, payload_sha256
  ) REFERENCES app_private.external_event_shadow_receipts (
    workspace_id, source, event_id, event_type,
    subject_kind, subject_id, payload_sha256
  ) ON DELETE RESTRICT
);

CREATE INDEX external_event_journey_projection_receipts_workspace_time_idx
  ON app_private.external_event_journey_projection_receipts
    (workspace_id, projected_at DESC, id DESC);

ALTER TABLE app_private.external_event_journey_projection_receipts
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.external_event_journey_projection_receipts
  FORCE ROW LEVEL SECURITY;
CREATE POLICY external_event_journey_projection_receipts_owner_all
  ON app_private.external_event_journey_projection_receipts
  FOR ALL TO r72_owner USING (true) WITH CHECK (true);

INSERT INTO app_private.workspace_table_registry
  (schema_name, table_name, workspace_column)
VALUES ('app_private', 'external_event_journey_projection_receipts', 'workspace_id');

REVOKE ALL ON app_private.external_event_journey_projection_receipts
FROM PUBLIC, r72_web, r72_public, r72_worker, r72_webhook, r72_readonly,
  r72_crm_command, r72_identity_command, r72_provisioning_command,
  r72_setup_delivery_command, r72_setup_reissue_command,
  r72_external_event_command, r72_external_event_definer,
  r72_growth_projector_definer;

-- Remove every direct webhook relation capability used by this projector,
-- including 0014's definition reads and temporary runtime write surface.
REVOKE ALL ON app_private.external_event_shadow_receipts FROM r72_webhook;
REVOKE ALL ON
  app.contacts,
  app.contact_points,
  app.contact_source_identities,
  app.lead_score_models,
  app.lead_score_model_versions,
  app.conversion_journeys,
  app.conversion_journey_versions,
  app.conversion_journey_milestones,
  app.conversion_journey_triggers,
  app.conversion_enrollments,
  app.communication_consent_events,
  app.communication_suppression_events,
  app.conversion_commerce_facts,
  app.conversion_milestone_facts,
  app.lead_score_snapshots,
  app.outbox_events
FROM r72_webhook;
REVOKE UPDATE (
  status, current_milestone_id, last_event_at, ended_at, row_version, updated_at
) ON app.conversion_enrollments FROM r72_webhook;

DROP POLICY IF EXISTS conversion_enrollments_service_select
  ON app.conversion_enrollments;
DROP POLICY IF EXISTS lead_score_models_service_select
  ON app.lead_score_models;
DROP POLICY IF EXISTS lead_score_model_versions_service_select
  ON app.lead_score_model_versions;
DROP POLICY IF EXISTS conversion_journeys_service_select
  ON app.conversion_journeys;
DROP POLICY IF EXISTS conversion_journey_versions_service_select
  ON app.conversion_journey_versions;
DROP POLICY IF EXISTS conversion_journey_milestones_service_select
  ON app.conversion_journey_milestones;
DROP POLICY IF EXISTS conversion_journey_triggers_service_select
  ON app.conversion_journey_triggers;
DROP POLICY IF EXISTS conversion_enrollments_webhook_insert
  ON app.conversion_enrollments;
DROP POLICY IF EXISTS conversion_enrollments_webhook_update
  ON app.conversion_enrollments;
DROP POLICY IF EXISTS communication_consent_events_service_select
  ON app.communication_consent_events;
DROP POLICY IF EXISTS communication_consent_events_webhook_insert
  ON app.communication_consent_events;
DROP POLICY IF EXISTS communication_suppression_events_service_select
  ON app.communication_suppression_events;
DROP POLICY IF EXISTS communication_suppression_events_webhook_insert
  ON app.communication_suppression_events;
DROP POLICY IF EXISTS conversion_commerce_facts_service_select
  ON app.conversion_commerce_facts;
DROP POLICY IF EXISTS conversion_commerce_facts_webhook_insert
  ON app.conversion_commerce_facts;
DROP POLICY IF EXISTS conversion_milestone_facts_service_select
  ON app.conversion_milestone_facts;
DROP POLICY IF EXISTS conversion_milestone_facts_webhook_insert
  ON app.conversion_milestone_facts;
DROP POLICY IF EXISTS lead_score_snapshots_service_select
  ON app.lead_score_snapshots;
DROP POLICY IF EXISTS lead_score_snapshots_webhook_insert
  ON app.lead_score_snapshots;
DROP POLICY IF EXISTS outbox_events_conversion_webhook_insert
  ON app.outbox_events;

-- Preserve the worker's prior workspace-scoped read access after removing the
-- combined worker/webhook policies.
CREATE POLICY lead_score_models_service_select
  ON app.lead_score_models FOR SELECT TO r72_worker
  USING (workspace_id = app_private.current_workspace_id());
CREATE POLICY lead_score_model_versions_service_select
  ON app.lead_score_model_versions FOR SELECT TO r72_worker
  USING (workspace_id = app_private.current_workspace_id());
CREATE POLICY conversion_journeys_service_select
  ON app.conversion_journeys FOR SELECT TO r72_worker
  USING (workspace_id = app_private.current_workspace_id());
CREATE POLICY conversion_journey_versions_service_select
  ON app.conversion_journey_versions FOR SELECT TO r72_worker
  USING (workspace_id = app_private.current_workspace_id());
CREATE POLICY conversion_journey_milestones_service_select
  ON app.conversion_journey_milestones FOR SELECT TO r72_worker
  USING (workspace_id = app_private.current_workspace_id());
CREATE POLICY conversion_journey_triggers_service_select
  ON app.conversion_journey_triggers FOR SELECT TO r72_worker
  USING (workspace_id = app_private.current_workspace_id());
CREATE POLICY conversion_enrollments_service_select
  ON app.conversion_enrollments FOR SELECT TO r72_worker
  USING (workspace_id = app_private.current_workspace_id());
CREATE POLICY communication_consent_events_service_select
  ON app.communication_consent_events FOR SELECT TO r72_worker
  USING (workspace_id = app_private.current_workspace_id());
CREATE POLICY communication_suppression_events_service_select
  ON app.communication_suppression_events FOR SELECT TO r72_worker
  USING (workspace_id = app_private.current_workspace_id());
CREATE POLICY conversion_commerce_facts_service_select
  ON app.conversion_commerce_facts FOR SELECT TO r72_worker
  USING (workspace_id = app_private.current_workspace_id());
CREATE POLICY conversion_milestone_facts_service_select
  ON app.conversion_milestone_facts FOR SELECT TO r72_worker
  USING (workspace_id = app_private.current_workspace_id());
CREATE POLICY lead_score_snapshots_service_select
  ON app.lead_score_snapshots FOR SELECT TO r72_worker
  USING (workspace_id = app_private.current_workspace_id());

-- Begin from an empty definer capability map, then add only the reads and
-- append/update columns required to derive the runtime projection.
REVOKE ALL ON SCHEMA app, app_private FROM r72_journey_projector_definer;
REVOKE ALL ON ALL TABLES IN SCHEMA app FROM r72_journey_projector_definer;
REVOKE ALL ON ALL TABLES IN SCHEMA app_private FROM r72_journey_projector_definer;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA app_private
  FROM r72_journey_projector_definer;
REVOKE CREATE ON SCHEMA public FROM r72_journey_projector_definer;

GRANT USAGE ON SCHEMA app, app_private TO r72_journey_projector_definer;
GRANT EXECUTE ON FUNCTION app_private.current_workspace_id(),
  app_private.current_actor_kind(), app_private.current_request_id()
TO r72_journey_projector_definer;

GRANT SELECT ON
  app_private.external_event_shadow_receipts,
  app_private.external_event_journey_projection_receipts,
  app.contacts,
  app.contact_points,
  app.contact_source_identities,
  app.lead_score_models,
  app.lead_score_model_versions,
  app.conversion_journeys,
  app.conversion_journey_versions,
  app.conversion_journey_milestones,
  app.conversion_journey_triggers,
  app.conversion_enrollments,
  app.communication_consent_events,
  app.conversion_commerce_facts,
  app.conversion_milestone_facts,
  app.lead_score_snapshots,
  app.outbox_events
TO r72_journey_projector_definer;

GRANT INSERT ON
  app_private.external_event_journey_projection_receipts,
  app.conversion_enrollments,
  app.communication_consent_events,
  app.conversion_commerce_facts,
  app.conversion_milestone_facts,
  app.lead_score_snapshots,
  app.outbox_events
TO r72_journey_projector_definer;
GRANT UPDATE (
  status, current_milestone_id, last_event_at, ended_at, row_version, updated_at
) ON app.conversion_enrollments TO r72_journey_projector_definer;

CREATE POLICY external_event_journey_projection_receipts_projector_select
  ON app_private.external_event_journey_projection_receipts
  FOR SELECT TO r72_journey_projector_definer USING (
    workspace_id = app_private.current_workspace_id()
    AND app_private.current_actor_kind() = 'webhook'
  );
CREATE POLICY external_event_journey_projection_receipts_projector_insert
  ON app_private.external_event_journey_projection_receipts
  FOR INSERT TO r72_journey_projector_definer WITH CHECK (
    workspace_id = app_private.current_workspace_id()
    AND app_private.current_actor_kind() = 'webhook'
    AND source = 'property_predator'
    AND request_id = app_private.current_request_id()
    AND disposition = 'projected'
  );

DO $journey_projector_select_policies$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'contacts', 'contact_points', 'contact_source_identities',
    'lead_score_models', 'lead_score_model_versions',
    'conversion_journeys', 'conversion_journey_versions',
    'conversion_journey_milestones', 'conversion_journey_triggers',
    'conversion_enrollments', 'communication_consent_events',
    'conversion_commerce_facts', 'conversion_milestone_facts',
    'lead_score_snapshots', 'outbox_events'
  ]
  LOOP
    EXECUTE format(
      'CREATE POLICY %I ON app.%I FOR SELECT TO r72_journey_projector_definer
       USING (
         workspace_id = app_private.current_workspace_id()
         AND app_private.current_actor_kind() = ''webhook''
       )',
      table_name || '_journey_projector_select', table_name
    );
  END LOOP;
END
$journey_projector_select_policies$;

CREATE POLICY conversion_enrollments_journey_projector_insert
  ON app.conversion_enrollments
  FOR INSERT TO r72_journey_projector_definer WITH CHECK (
    workspace_id = app_private.current_workspace_id()
    AND app_private.current_actor_kind() = 'webhook'
    AND source = 'property_predator'
    AND enrolled_by_kind = 'webhook'
    AND enrolled_by_user_id IS NULL
    AND status = 'active'
    AND current_milestone_id IS NULL
    AND ended_at IS NULL
  );
CREATE POLICY conversion_enrollments_journey_projector_update
  ON app.conversion_enrollments
  FOR UPDATE TO r72_journey_projector_definer USING (
    workspace_id = app_private.current_workspace_id()
    AND app_private.current_actor_kind() = 'webhook'
    AND source = 'property_predator'
    AND enrolled_by_kind = 'webhook'
    AND enrolled_by_user_id IS NULL
  ) WITH CHECK (
    workspace_id = app_private.current_workspace_id()
    AND app_private.current_actor_kind() = 'webhook'
    AND source = 'property_predator'
    AND enrolled_by_kind = 'webhook'
    AND enrolled_by_user_id IS NULL
    AND (
      status <> 'completed'
      OR EXISTS (
        SELECT 1
        FROM app.conversion_milestone_facts AS sale_fact
        WHERE sale_fact.workspace_id = conversion_enrollments.workspace_id
          AND sale_fact.enrollment_id = conversion_enrollments.id
          AND sale_fact.contact_id = conversion_enrollments.contact_id
          AND sale_fact.journey_version_id = conversion_enrollments.journey_version_id
          AND sale_fact.milestone_id = conversion_enrollments.current_milestone_id
          AND sale_fact.milestone_semantic = 'sale'
          AND sale_fact.source_kind = 'commerce'
      )
    )
  );

CREATE POLICY communication_consent_events_journey_projector_insert
  ON app.communication_consent_events
  FOR INSERT TO r72_journey_projector_definer WITH CHECK (
    workspace_id = app_private.current_workspace_id()
    AND app_private.current_actor_kind() = 'webhook'
    AND source = 'property_predator'
    AND actor_kind = 'webhook'
    AND actor_user_id IS NULL
  );
CREATE POLICY conversion_commerce_facts_journey_projector_insert
  ON app.conversion_commerce_facts
  FOR INSERT TO r72_journey_projector_definer WITH CHECK (
    workspace_id = app_private.current_workspace_id()
    AND app_private.current_actor_kind() = 'webhook'
    AND source_system = 'property_predator'
    AND actor_kind = 'webhook'
    AND actor_user_id IS NULL
  );
CREATE POLICY conversion_milestone_facts_journey_projector_insert
  ON app.conversion_milestone_facts
  FOR INSERT TO r72_journey_projector_definer WITH CHECK (
    workspace_id = app_private.current_workspace_id()
    AND app_private.current_actor_kind() = 'webhook'
    AND source_kind IN ('event', 'commerce')
    AND actor_kind = 'webhook'
    AND actor_user_id IS NULL
  );
CREATE POLICY lead_score_snapshots_journey_projector_insert
  ON app.lead_score_snapshots
  FOR INSERT TO r72_journey_projector_definer WITH CHECK (
    workspace_id = app_private.current_workspace_id()
    AND app_private.current_actor_kind() = 'webhook'
    AND source_system = 'property_predator'
    AND actor_kind = 'webhook'
    AND actor_user_id IS NULL
  );
CREATE POLICY outbox_events_journey_projector_insert
  ON app.outbox_events
  FOR INSERT TO r72_journey_projector_definer WITH CHECK (
    workspace_id = app_private.current_workspace_id()
    AND app_private.current_actor_kind() = 'webhook'
    AND event_type IN (
      'conversion.enrollment.started',
      'conversion.milestone.achieved',
      'conversion.score.updated',
      'conversion.commerce.fact_recorded',
      'communication.consent.recorded'
    )
    AND status = 'pending'
    AND attempt_count = 0
    AND published_at IS NULL
    AND last_error IS NULL
  );

GRANT CREATE ON SCHEMA app_private TO r72_journey_projector_definer;
SET LOCAL ROLE r72_journey_projector_definer;

-- Internal append helper. It is not granted to any login and therefore cannot
-- widen the immutable-event-only public projector boundary.
CREATE FUNCTION app_private.append_property_predator_journey_outbox(
  p_workspace_id uuid,
  p_aggregate_type text,
  p_aggregate_id uuid,
  p_event_type text,
  p_idempotency_key text,
  p_payload jsonb,
  p_request_id text,
  p_correlation_id uuid,
  p_causation_id uuid,
  p_occurred_at timestamptz
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog
AS $function$
DECLARE
  inserted_count integer;
BEGIN
  INSERT INTO app.outbox_events (
    workspace_id, aggregate_type, aggregate_id, event_type, event_version,
    idempotency_key, payload, request_id, correlation_id, causation_id,
    occurred_at, available_at, created_at
  ) VALUES (
    p_workspace_id, p_aggregate_type, p_aggregate_id, p_event_type, 1,
    p_idempotency_key, p_payload, p_request_id, p_correlation_id::text,
    p_causation_id::text, p_occurred_at,
    greatest(statement_timestamp(), p_occurred_at),
    greatest(statement_timestamp(), p_occurred_at)
  )
  ON CONFLICT (workspace_id, idempotency_key) DO NOTHING;
  GET DIAGNOSTICS inserted_count = ROW_COUNT;

  IF inserted_count = 0 AND NOT EXISTS (
    SELECT 1
    FROM app.outbox_events AS existing
    WHERE existing.workspace_id = p_workspace_id
      AND existing.aggregate_type = p_aggregate_type
      AND existing.aggregate_id = p_aggregate_id
      AND existing.event_type = p_event_type
      AND existing.event_version = 1
      AND existing.idempotency_key = p_idempotency_key
      AND existing.payload = p_payload
      AND existing.request_id = p_request_id
      AND existing.correlation_id = p_correlation_id::text
      AND existing.causation_id = p_causation_id::text
      AND existing.occurred_at = p_occurred_at
      AND existing.status = 'pending'
      AND existing.attempt_count = 0
      AND existing.published_at IS NULL
      AND existing.last_error IS NULL
  ) THEN
    RAISE EXCEPTION 'journey outbox idempotency key conflicts with canonical fact'
      USING ERRCODE = '22000';
  END IF;
END
$function$;

-- Startup may prove that the authenticated workspace has the exact published
-- v2 Property Predator route topology without receiving any definition rows.
CREATE FUNCTION app_private.property_predator_journey_runtime_ready()
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  trusted_workspace_id uuid := app_private.current_workspace_id();
  trusted_actor_kind text := app_private.current_actor_kind();
  is_ready boolean := false;
BEGIN
  IF trusted_workspace_id IS NULL
     OR trusted_actor_kind IS DISTINCT FROM 'webhook' THEN
    RETURN false;
  END IF;

  WITH active_definition AS (
    SELECT journey.slug::text AS journey_slug,
           version_row.id AS journey_version_id,
           version_row.settings,
           score_version.id AS score_model_version_id,
           score_version.definition_sha256
    FROM app.conversion_journeys AS journey
    JOIN app.conversion_journey_versions AS version_row
      ON version_row.workspace_id = journey.workspace_id
     AND version_row.journey_id = journey.id
     AND version_row.id = journey.active_version_id
     AND version_row.version_no = 2
     AND version_row.published_at IS NOT NULL
    JOIN app.lead_score_model_versions AS score_version
      ON score_version.workspace_id = version_row.workspace_id
     AND score_version.id = version_row.score_model_version_id
     AND score_version.version_no = 2
     AND score_version.published_at IS NOT NULL
    JOIN app.lead_score_models AS score_model
      ON score_model.workspace_id = score_version.workspace_id
     AND score_model.id = score_version.model_id
     AND score_model.slug = 'property-predator-lead-score'
     AND score_model.status = 'active'
     AND score_model.active_version_id = score_version.id
    WHERE journey.workspace_id = trusted_workspace_id
      AND journey.status = 'active'
      AND journey.slug IN (
        'property-predator-self-serve', 'property-predator-agency-laps'
      )
  )
  SELECT count(*) = 2
     AND count(DISTINCT definition.journey_slug) = 2
     AND count(DISTINCT definition.score_model_version_id) = 1
     AND bool_and(
       jsonb_typeof(definition.settings) = 'object'
       AND definition.settings ?& ARRAY[
         'schemaVersion', 'mappingMode', 'mappingFrequency',
         'scoreModelDefinitionHash'
       ]
       AND definition.settings - ARRAY[
         'schemaVersion', 'mappingMode', 'mappingFrequency',
         'scoreModelDefinitionHash'
       ] = '{}'::jsonb
       AND definition.settings->>'schemaVersion' = '1'
       AND definition.settings->>'mappingMode' = 'direct'
       AND definition.settings->>'mappingFrequency' = 'once_per_enrollment'
       AND definition.settings->>'scoreModelDefinitionHash'
             = encode(definition.definition_sha256, 'hex')
     )
     AND (
       SELECT count(*) = 8
       FROM app.conversion_journey_milestones AS milestone
       JOIN active_definition AS expected
         ON expected.journey_version_id = milestone.journey_version_id
       WHERE milestone.workspace_id = trusted_workspace_id
         AND (
           (expected.journey_slug = 'property-predator-self-serve' AND (
             (milestone.milestone_key = 'lead' AND milestone.position = 1
               AND milestone.semantic = 'lead' AND NOT milestone.is_completion)
             OR (milestone.milestone_key = 'activated' AND milestone.position = 2
               AND milestone.semantic = 'activation' AND NOT milestone.is_completion)
             OR (milestone.milestone_key = 'priced' AND milestone.position = 3
               AND milestone.semantic = 'offer' AND NOT milestone.is_completion)
             OR (milestone.milestone_key = 'sale' AND milestone.position = 4
               AND milestone.semantic = 'sale' AND milestone.is_completion)
           ))
           OR (expected.journey_slug = 'property-predator-agency-laps' AND (
             (milestone.milestone_key = 'lead' AND milestone.position = 1
               AND milestone.semantic = 'lead' AND NOT milestone.is_completion)
             OR (milestone.milestone_key = 'appointment' AND milestone.position = 2
               AND milestone.semantic = 'appointment' AND NOT milestone.is_completion)
             OR (milestone.milestone_key = 'presentation' AND milestone.position = 3
               AND milestone.semantic = 'presentation' AND NOT milestone.is_completion)
             OR (milestone.milestone_key = 'sale' AND milestone.position = 4
               AND milestone.semantic = 'sale' AND milestone.is_completion)
           ))
         )
     )
     AND (
       SELECT count(*) = 8
       FROM app.conversion_journey_milestones AS milestone
       JOIN active_definition AS expected
         ON expected.journey_version_id = milestone.journey_version_id
       WHERE milestone.workspace_id = trusted_workspace_id
     )
     AND (
       SELECT count(*) = 7
       FROM app.conversion_journey_triggers AS trigger_row
       JOIN app.conversion_journey_milestones AS milestone
         ON milestone.workspace_id = trigger_row.workspace_id
        AND milestone.journey_version_id = trigger_row.journey_version_id
        AND milestone.id = trigger_row.milestone_id
       JOIN active_definition AS expected
         ON expected.journey_version_id = trigger_row.journey_version_id
       WHERE trigger_row.workspace_id = trusted_workspace_id
         AND (
           (expected.journey_slug = 'property-predator-self-serve' AND (
             (trigger_row.trigger_kind = 'event'
               AND trigger_row.source_key = 'identity.account.created'
               AND milestone.milestone_key = 'lead')
             OR (trigger_row.trigger_kind = 'event'
               AND trigger_row.source_key = 'product.analysis.completed'
               AND milestone.milestone_key = 'activated')
             OR (trigger_row.trigger_kind = 'event'
               AND trigger_row.source_key = 'offer.presented'
               AND milestone.milestone_key = 'priced')
             OR (trigger_row.trigger_kind = 'commerce'
               AND trigger_row.source_key = 'payment_collected'
               AND milestone.milestone_key = 'sale')
           ))
           OR (expected.journey_slug = 'property-predator-agency-laps' AND (
             (trigger_row.trigger_kind = 'event'
               AND trigger_row.source_key = 'sales.appointment.booked'
               AND milestone.milestone_key = 'appointment')
             OR (trigger_row.trigger_kind = 'event'
               AND trigger_row.source_key = 'sales.presentation.completed'
               AND milestone.milestone_key = 'presentation')
             OR (trigger_row.trigger_kind = 'commerce'
               AND trigger_row.source_key = 'payment_collected'
               AND milestone.milestone_key = 'sale')
           ))
         )
     )
     AND (
       SELECT count(*) = 7
       FROM app.conversion_journey_triggers AS trigger_row
       JOIN active_definition AS expected
         ON expected.journey_version_id = trigger_row.journey_version_id
       WHERE trigger_row.workspace_id = trusted_workspace_id
     )
    INTO is_ready
  FROM active_definition AS definition;

  RETURN coalesce(is_ready, false);
END
$function$;

CREATE FUNCTION app_private.project_property_predator_journey_event(p_event_id uuid)
RETURNS TABLE (
  disposition text,
  replayed boolean,
  enrollments_started integer,
  milestones_achieved integer,
  score_snapshots_written integer,
  consent_facts_written integer,
  commerce_facts_written integer
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  trusted_workspace_id uuid := app_private.current_workspace_id();
  trusted_actor_kind text := app_private.current_actor_kind();
  trusted_request_id text := app_private.current_request_id();
  shadow_receipt app_private.external_event_shadow_receipts%ROWTYPE;
  prior_receipt app_private.external_event_journey_projection_receipts%ROWTYPE;
  event_data jsonb;
  shared_score_model_version_id uuid;
  score_definition jsonb;
  source_identity_id uuid;
  resolved_contact_id uuid;
  resolved_point_id uuid;
  candidate_count integer;
  trigger_count integer := 0;
  inserted_count integer;
  started_count integer := 0;
  milestone_count integer := 0;
  score_count integer := 0;
  consent_count integer := 0;
  commerce_count integer := 0;
  new_fact_id uuid;
  selected_enrollment_id uuid;
  selected_journey_version_id uuid;
  selected_score_model_version_id uuid;
  selected_enrolled_at timestamptz;
  selected_currency text;
  selected_payment_fact_id uuid;
  selected_payment_amount bigint;
  existing_refund_amount numeric := 0;
  selected_payment_occurred_at timestamptz;
  selected_prerequisite_occurred_at timestamptz;
  commerce_fact_id uuid;
  target_enrollment_id uuid;
  target_current_position integer;
  target_enrollment_status text;
  lead_milestone_id uuid;
  lead_fact_id uuid;
  enrollment_key_value text;
  milestone_evidence jsonb;
  score_total integer;
  score_band text;
  score_components jsonb;
  score_reasons jsonb;
  score_rules jsonb;
  scoreable_current_event boolean := false;
  score_source_watermark timestamptz;
  score_target_ids uuid[] := ARRAY[]::uuid[];
  trigger_row record;
  score_target record;
BEGIN
  IF trusted_workspace_id IS NULL
     OR trusted_actor_kind IS DISTINCT FROM 'webhook' THEN
    RAISE EXCEPTION 'Property Predator journey projector context denied'
      USING ERRCODE = '42501';
  END IF;
  IF p_event_id IS NULL
     OR trusted_request_id IS NULL
     OR length(trusted_request_id) NOT BETWEEN 1 AND 128
     OR trusted_request_id ~ '[^[:graph:]]' THEN
    RAISE EXCEPTION 'invalid Property Predator journey projector request'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'property-predator-journey-event:' || trusted_workspace_id::text
        || ':' || p_event_id::text,
      7200018
    )
  );

  SELECT receipt.*
    INTO shadow_receipt
  FROM app_private.external_event_shadow_receipts AS receipt
  WHERE receipt.workspace_id = trusted_workspace_id
    AND receipt.source = 'property_predator'
    AND receipt.event_id = p_event_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'accepted Property Predator shadow receipt not found'
      USING ERRCODE = '23503';
  END IF;

  IF shadow_receipt.event_version IS DISTINCT FROM 1
     OR shadow_receipt.subject_kind IS DISTINCT FROM 'account'
     OR shadow_receipt.event_type NOT IN (
       'identity.account.created', 'privacy.consent.updated',
       'affiliate.referral.attributed', 'product.analysis.completed',
       'content.consumption.progressed', 'content.consumption.completed',
       'offer.presented', 'offer.responded',
       'sales.appointment.booked', 'sales.presentation.completed',
       'commerce.purchase.completed', 'commerce.purchase.refunded',
       'commerce.subscription.cancelled'
     )
     OR jsonb_typeof(shadow_receipt.event_payload) IS DISTINCT FROM 'object'
     OR NOT (shadow_receipt.event_payload ?& ARRAY[
       'id', 'type', 'version', 'occurredAt', 'correlationId', 'subject', 'data'
     ])
     OR shadow_receipt.event_payload - ARRAY[
       'id', 'type', 'version', 'occurredAt', 'correlationId', 'subject', 'data'
     ] <> '{}'::jsonb
     OR shadow_receipt.event_payload->>'id' IS DISTINCT FROM shadow_receipt.event_id::text
     OR shadow_receipt.event_payload->>'type' IS DISTINCT FROM shadow_receipt.event_type
     OR jsonb_typeof(shadow_receipt.event_payload->'version') IS DISTINCT FROM 'number'
     OR shadow_receipt.event_payload->>'version' IS DISTINCT FROM '1'
     OR shadow_receipt.event_payload->>'occurredAt'
          !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
     OR NOT (CASE
       WHEN shadow_receipt.event_payload->>'occurredAt'
              ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
        AND pg_catalog.pg_input_is_valid(
              shadow_receipt.event_payload->>'occurredAt',
              'timestamp with time zone'
            )
       THEN (shadow_receipt.event_payload->>'occurredAt')::timestamptz
              IS NOT DISTINCT FROM shadow_receipt.occurred_at
       ELSE false
     END)
     OR shadow_receipt.event_payload->>'correlationId'
          IS DISTINCT FROM shadow_receipt.correlation_id::text
     OR jsonb_typeof(shadow_receipt.event_payload->'subject') IS DISTINCT FROM 'object'
     OR NOT ((shadow_receipt.event_payload->'subject') ?& ARRAY['kind', 'id'])
     OR (shadow_receipt.event_payload->'subject') - ARRAY['kind', 'id'] <> '{}'::jsonb
     OR shadow_receipt.event_payload->'subject'->>'kind' IS DISTINCT FROM 'account'
     OR shadow_receipt.event_payload->'subject'->>'id'
          IS DISTINCT FROM shadow_receipt.subject_id::text
     OR jsonb_typeof(shadow_receipt.event_payload->'data') IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'invalid canonical Property Predator journey envelope'
      USING ERRCODE = '22023';
  END IF;
  event_data := shadow_receipt.event_payload->'data';

  IF shadow_receipt.event_type = 'identity.account.created' THEN
    IF NOT (event_data ?& ARRAY['email', 'signupMethod'])
       OR event_data - ARRAY['email', 'signupMethod', 'displayName'] <> '{}'::jsonb
       OR jsonb_typeof(event_data->'email') IS DISTINCT FROM 'string'
       OR jsonb_typeof(event_data->'signupMethod') IS DISTINCT FROM 'string'
       OR length(event_data->>'email') NOT BETWEEN 1 AND 320
       OR event_data->>'email' IS DISTINCT FROM lower(btrim(event_data->>'email'))
       OR event_data->>'email' !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
       OR event_data->>'signupMethod' NOT IN ('password', 'google')
       OR (event_data ? 'displayName' AND (
         jsonb_typeof(event_data->'displayName') IS DISTINCT FROM 'string'
         OR length(event_data->>'displayName') NOT BETWEEN 1 AND 200
         OR event_data->>'displayName' IS DISTINCT FROM btrim(event_data->>'displayName')
         OR event_data->>'displayName' ~ '[[:cntrl:]]'
       )) THEN
      RAISE EXCEPTION 'invalid identity.account.created journey payload'
        USING ERRCODE = '22023';
    END IF;
  ELSIF shadow_receipt.event_type = 'privacy.consent.updated' THEN
    IF NOT (event_data ?& ARRAY['purpose', 'channel', 'state', 'source'])
       OR event_data - ARRAY[
         'purpose', 'channel', 'state', 'source', 'email',
         'policyVersion', 'policyTextSha256'
       ] <> '{}'::jsonb
       OR jsonb_typeof(event_data->'purpose') IS DISTINCT FROM 'string'
       OR jsonb_typeof(event_data->'channel') IS DISTINCT FROM 'string'
       OR jsonb_typeof(event_data->'state') IS DISTINCT FROM 'string'
       OR jsonb_typeof(event_data->'source') IS DISTINCT FROM 'string'
       OR event_data->>'purpose' NOT IN (
         'property_predator_marketing', 'partner_marketing'
       )
       OR event_data->>'channel' IS DISTINCT FROM 'email'
       OR event_data->>'state' NOT IN ('granted', 'denied', 'withdrawn')
       OR event_data->>'source' NOT IN (
         'registration', 'account_preferences', 'unsubscribe'
       )
       OR (event_data ? 'email' AND (
         jsonb_typeof(event_data->'email') IS DISTINCT FROM 'string'
         OR length(event_data->>'email') NOT BETWEEN 1 AND 320
         OR event_data->>'email' IS DISTINCT FROM lower(btrim(event_data->>'email'))
         OR event_data->>'email' !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
       ))
       OR (event_data ? 'policyVersion' AND (
         jsonb_typeof(event_data->'policyVersion') IS DISTINCT FROM 'string'
         OR length(event_data->>'policyVersion') NOT BETWEEN 1 AND 100
         OR event_data->>'policyVersion' IS DISTINCT FROM btrim(event_data->>'policyVersion')
         OR event_data->>'policyVersion' ~ '[[:cntrl:]]'
       ))
       OR (event_data ? 'policyTextSha256' AND (
         jsonb_typeof(event_data->'policyTextSha256') IS DISTINCT FROM 'string'
         OR event_data->>'policyTextSha256' !~ '^[0-9a-f]{64}$'
       )) THEN
      RAISE EXCEPTION 'invalid privacy.consent.updated journey payload'
        USING ERRCODE = '22023';
    END IF;
  ELSIF shadow_receipt.event_type = 'affiliate.referral.attributed' THEN
    IF NOT (event_data ?& ARRAY['affiliateId', 'referralCode', 'model'])
       OR event_data - ARRAY['affiliateId', 'referralCode', 'model'] <> '{}'::jsonb
       OR jsonb_typeof(event_data->'affiliateId') IS DISTINCT FROM 'string'
       OR jsonb_typeof(event_data->'referralCode') IS DISTINCT FROM 'string'
       OR jsonb_typeof(event_data->'model') IS DISTINCT FROM 'string'
       OR event_data->>'affiliateId'
            !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       OR event_data->>'referralCode' !~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$'
       OR event_data->>'model' IS DISTINCT FROM 'last_click' THEN
      RAISE EXCEPTION 'invalid affiliate.referral.attributed journey payload'
        USING ERRCODE = '22023';
    END IF;
  ELSIF shadow_receipt.event_type = 'product.analysis.completed' THEN
    IF NOT (event_data ?& ARRAY['toolKey', 'accessMode', 'unitsSpent'])
       OR event_data - ARRAY['toolKey', 'accessMode', 'unitsSpent'] <> '{}'::jsonb
       OR jsonb_typeof(event_data->'toolKey') IS DISTINCT FROM 'string'
       OR jsonb_typeof(event_data->'accessMode') IS DISTINCT FROM 'string'
       OR event_data->>'toolKey' !~ '^[a-z0-9][a-z0-9._-]{0,63}$'
       OR event_data->>'accessMode' NOT IN ('demo', 'free', 'paid')
       OR jsonb_typeof(event_data->'unitsSpent') IS DISTINCT FROM 'number'
       OR NOT (CASE WHEN event_data->>'unitsSpent' ~ '^(0|[1-9][0-9]{0,3})$'
         THEN (event_data->>'unitsSpent')::integer BETWEEN 0 AND 1000
         ELSE false END) THEN
      RAISE EXCEPTION 'invalid product.analysis.completed journey payload'
        USING ERRCODE = '22023';
    END IF;
  ELSIF shadow_receipt.event_type IN (
    'content.consumption.progressed', 'content.consumption.completed'
  ) THEN
    IF NOT (event_data ?& ARRAY[
         'contentKey', 'contentVersion', 'title', 'medium',
         'progressBasisPoints', 'consumedSeconds'
       ])
       OR event_data - ARRAY[
         'contentKey', 'contentVersion', 'title', 'medium',
         'progressBasisPoints', 'consumedSeconds'
       ] <> '{}'::jsonb
       OR jsonb_typeof(event_data->'contentKey') IS DISTINCT FROM 'string'
       OR jsonb_typeof(event_data->'contentVersion') IS DISTINCT FROM 'string'
       OR jsonb_typeof(event_data->'title') IS DISTINCT FROM 'string'
       OR jsonb_typeof(event_data->'medium') IS DISTINCT FROM 'string'
       OR event_data->>'contentKey' !~ '^[a-z0-9][a-z0-9_.:-]{0,149}$'
       OR length(event_data->>'contentVersion') NOT BETWEEN 1 AND 100
       OR event_data->>'contentVersion' IS DISTINCT FROM btrim(event_data->>'contentVersion')
       OR event_data->>'contentVersion' ~ '[[:cntrl:]]'
       OR length(event_data->>'title') NOT BETWEEN 1 AND 200
       OR event_data->>'title' IS DISTINCT FROM btrim(event_data->>'title')
       OR event_data->>'title' ~ '[[:cntrl:]]'
       OR event_data->>'medium' NOT IN ('video', 'audio', 'article', 'document', 'other')
       OR jsonb_typeof(event_data->'progressBasisPoints') IS DISTINCT FROM 'number'
       OR NOT (CASE WHEN event_data->>'progressBasisPoints' ~ '^(0|[1-9][0-9]{0,4})$'
         THEN (event_data->>'progressBasisPoints')::integer BETWEEN 0 AND 10000
         ELSE false END)
       OR jsonb_typeof(event_data->'consumedSeconds') IS DISTINCT FROM 'number'
       OR NOT (CASE WHEN event_data->>'consumedSeconds' ~ '^(0|[1-9][0-9]{0,9})$'
         THEN (event_data->>'consumedSeconds')::bigint BETWEEN 0 AND 2147483647
         ELSE false END)
       OR (shadow_receipt.event_type = 'content.consumption.completed'
         AND event_data->>'progressBasisPoints' IS DISTINCT FROM '10000') THEN
      RAISE EXCEPTION 'invalid content consumption journey payload'
        USING ERRCODE = '22023';
    END IF;
  ELSIF shadow_receipt.event_type = 'offer.presented' THEN
    IF NOT (event_data ?& ARRAY[
         'offerKey', 'offerVersion', 'productKey', 'label', 'price', 'placement'
       ])
       OR event_data - ARRAY[
         'offerKey', 'offerVersion', 'productKey', 'label', 'price', 'placement'
       ] <> '{}'::jsonb
       OR jsonb_typeof(event_data->'offerKey') IS DISTINCT FROM 'string'
       OR jsonb_typeof(event_data->'offerVersion') IS DISTINCT FROM 'string'
       OR jsonb_typeof(event_data->'productKey') IS DISTINCT FROM 'string'
       OR jsonb_typeof(event_data->'label') IS DISTINCT FROM 'string'
       OR jsonb_typeof(event_data->'placement') IS DISTINCT FROM 'string'
       OR event_data->>'offerKey' !~ '^[a-z0-9][a-z0-9_.:-]{0,149}$'
       OR length(event_data->>'offerVersion') NOT BETWEEN 1 AND 100
       OR event_data->>'offerVersion' IS DISTINCT FROM btrim(event_data->>'offerVersion')
       OR event_data->>'offerVersion' ~ '[[:cntrl:]]'
       OR event_data->>'productKey' !~ '^[a-z0-9][a-z0-9_.:-]{0,149}$'
       OR length(event_data->>'label') NOT BETWEEN 1 AND 200
       OR event_data->>'label' IS DISTINCT FROM btrim(event_data->>'label')
       OR event_data->>'label' ~ '[[:cntrl:]]'
       OR event_data->>'placement' !~ '^[a-z0-9][a-z0-9_.:-]{0,99}$'
       OR jsonb_typeof(event_data->'price') IS DISTINCT FROM 'object'
       OR NOT ((event_data->'price') ?& ARRAY['amountMinor', 'currency'])
       OR (event_data->'price') - ARRAY['amountMinor', 'currency'] <> '{}'::jsonb
       OR jsonb_typeof(event_data->'price'->'amountMinor') IS DISTINCT FROM 'number'
       OR jsonb_typeof(event_data->'price'->'currency') IS DISTINCT FROM 'string'
       OR NOT (CASE WHEN event_data->'price'->>'amountMinor' ~ '^(0|[1-9][0-9]{0,15})$'
         THEN (event_data->'price'->>'amountMinor')::numeric <= 9007199254740991
         ELSE false END)
       OR event_data->'price'->>'currency' !~ '^[a-z]{3}$' THEN
      RAISE EXCEPTION 'invalid offer.presented journey payload'
        USING ERRCODE = '22023';
    END IF;
  ELSIF shadow_receipt.event_type = 'offer.responded' THEN
    IF NOT (event_data ?& ARRAY['presentationEventId', 'response'])
       OR event_data - ARRAY['presentationEventId', 'response'] <> '{}'::jsonb
       OR jsonb_typeof(event_data->'presentationEventId') IS DISTINCT FROM 'string'
       OR jsonb_typeof(event_data->'response') IS DISTINCT FROM 'string'
       OR event_data->>'presentationEventId'
            !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       OR event_data->>'response' NOT IN (
         'accepted', 'declined', 'deferred', 'requested_contact'
       ) THEN
      RAISE EXCEPTION 'invalid offer.responded journey payload'
        USING ERRCODE = '22023';
    END IF;
  ELSIF shadow_receipt.event_type = 'sales.appointment.booked' THEN
    IF NOT (event_data ?& ARRAY[
         'appointmentId', 'startsAt', 'bookingSource', 'meetingKind'
       ])
       OR event_data - ARRAY[
         'appointmentId', 'startsAt', 'bookingSource', 'meetingKind'
       ] <> '{}'::jsonb
       OR jsonb_typeof(event_data->'appointmentId') IS DISTINCT FROM 'string'
       OR jsonb_typeof(event_data->'startsAt') IS DISTINCT FROM 'string'
       OR jsonb_typeof(event_data->'bookingSource') IS DISTINCT FROM 'string'
       OR jsonb_typeof(event_data->'meetingKind') IS DISTINCT FROM 'string'
       OR event_data->>'appointmentId' !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
       OR event_data->>'startsAt'
            !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
       OR NOT pg_catalog.pg_input_is_valid(
         event_data->>'startsAt', 'timestamp with time zone'
       )
       OR event_data->>'bookingSource' NOT IN (
         'self_serve_calendar', 'team', 'partner_referral'
       )
       OR event_data->>'meetingKind' NOT IN ('discovery', 'strategy', 'partner') THEN
      RAISE EXCEPTION 'invalid sales.appointment.booked journey payload'
        USING ERRCODE = '22023';
    END IF;
  ELSIF shadow_receipt.event_type = 'sales.presentation.completed' THEN
    IF NOT (event_data ?& ARRAY[
         'appointmentId', 'presentationKey', 'durationSeconds', 'outcome'
       ])
       OR event_data - ARRAY[
         'appointmentId', 'presentationKey', 'durationSeconds', 'outcome'
       ] <> '{}'::jsonb
       OR jsonb_typeof(event_data->'appointmentId') IS DISTINCT FROM 'string'
       OR jsonb_typeof(event_data->'presentationKey') IS DISTINCT FROM 'string'
       OR jsonb_typeof(event_data->'outcome') IS DISTINCT FROM 'string'
       OR event_data->>'appointmentId' !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
       OR event_data->>'presentationKey' !~ '^[a-z0-9][a-z0-9_.:-]{0,149}$'
       OR jsonb_typeof(event_data->'durationSeconds') IS DISTINCT FROM 'number'
       OR NOT (CASE WHEN event_data->>'durationSeconds' ~ '^[1-9][0-9]{0,9}$'
         THEN (event_data->>'durationSeconds')::bigint BETWEEN 1 AND 2147483647
         ELSE false END)
       OR event_data->>'outcome' NOT IN (
         'completed', 'follow_up_requested', 'proposal_requested'
       ) THEN
      RAISE EXCEPTION 'invalid sales.presentation.completed journey payload'
        USING ERRCODE = '22023';
    END IF;
  ELSIF shadow_receipt.event_type = 'commerce.purchase.completed' THEN
    IF NOT (event_data ?& ARRAY[
         'provider', 'providerEventId', 'checkoutSessionId', 'productKey',
         'billingKind', 'amountMinor', 'currency'
       ])
       OR event_data - ARRAY[
         'provider', 'providerEventId', 'checkoutSessionId', 'productKey',
         'billingKind', 'subscriptionId', 'amountMinor', 'currency'
       ] <> '{}'::jsonb
       OR jsonb_typeof(event_data->'provider') IS DISTINCT FROM 'string'
       OR jsonb_typeof(event_data->'providerEventId') IS DISTINCT FROM 'string'
       OR jsonb_typeof(event_data->'checkoutSessionId') IS DISTINCT FROM 'string'
       OR jsonb_typeof(event_data->'productKey') IS DISTINCT FROM 'string'
       OR jsonb_typeof(event_data->'billingKind') IS DISTINCT FROM 'string'
       OR jsonb_typeof(event_data->'currency') IS DISTINCT FROM 'string'
       OR event_data->>'provider' IS DISTINCT FROM 'stripe'
       OR event_data->>'providerEventId' !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$'
       OR event_data->>'checkoutSessionId' !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
       OR event_data->>'productKey' !~ '^[a-z0-9][a-z0-9._-]{0,63}$'
       OR event_data->>'billingKind' NOT IN ('one_off', 'subscription')
       OR ((event_data->>'billingKind' = 'subscription') IS DISTINCT FROM
           (event_data ? 'subscriptionId'))
       OR (event_data ? 'subscriptionId' AND
         (jsonb_typeof(event_data->'subscriptionId') IS DISTINCT FROM 'string'
          OR event_data->>'subscriptionId' !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$'))
       OR jsonb_typeof(event_data->'amountMinor') IS DISTINCT FROM 'number'
       OR NOT (CASE WHEN event_data->>'amountMinor' ~ '^[1-9][0-9]{0,15}$'
         THEN (event_data->>'amountMinor')::numeric <= 9007199254740991
         ELSE false END)
       OR event_data->>'currency' !~ '^[a-z]{3}$' THEN
      RAISE EXCEPTION 'invalid commerce.purchase.completed journey payload'
        USING ERRCODE = '22023';
    END IF;
  ELSIF shadow_receipt.event_type = 'commerce.purchase.refunded' THEN
    IF NOT (event_data ?& ARRAY[
         'provider', 'providerEventId', 'checkoutSessionId', 'productKey',
         'amountMinor', 'currency'
       ])
       OR event_data - ARRAY[
         'provider', 'providerEventId', 'checkoutSessionId', 'productKey',
         'amountMinor', 'currency', 'reasonCode'
       ] <> '{}'::jsonb
       OR jsonb_typeof(event_data->'provider') IS DISTINCT FROM 'string'
       OR jsonb_typeof(event_data->'providerEventId') IS DISTINCT FROM 'string'
       OR jsonb_typeof(event_data->'checkoutSessionId') IS DISTINCT FROM 'string'
       OR jsonb_typeof(event_data->'productKey') IS DISTINCT FROM 'string'
       OR jsonb_typeof(event_data->'currency') IS DISTINCT FROM 'string'
       OR event_data->>'provider' IS DISTINCT FROM 'stripe'
       OR event_data->>'providerEventId' !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$'
       OR event_data->>'checkoutSessionId' !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
       OR event_data->>'productKey' !~ '^[a-z0-9][a-z0-9._-]{0,63}$'
       OR jsonb_typeof(event_data->'amountMinor') IS DISTINCT FROM 'number'
       OR NOT (CASE WHEN event_data->>'amountMinor' ~ '^[1-9][0-9]{0,15}$'
         THEN (event_data->>'amountMinor')::numeric <= 9007199254740991
         ELSE false END)
       OR event_data->>'currency' !~ '^[a-z]{3}$'
       OR (event_data ? 'reasonCode' AND
         (jsonb_typeof(event_data->'reasonCode') IS DISTINCT FROM 'string'
          OR event_data->>'reasonCode' !~ '^[a-z0-9][a-z0-9._-]{0,63}$')) THEN
      RAISE EXCEPTION 'invalid commerce.purchase.refunded journey payload'
        USING ERRCODE = '22023';
    END IF;
  ELSIF shadow_receipt.event_type = 'commerce.subscription.cancelled' THEN
    IF NOT (event_data ?& ARRAY[
         'provider', 'providerEventId', 'subscriptionId', 'productKey', 'effectiveAt'
       ])
       OR event_data - ARRAY[
         'provider', 'providerEventId', 'subscriptionId', 'productKey', 'effectiveAt'
       ] <> '{}'::jsonb
       OR jsonb_typeof(event_data->'provider') IS DISTINCT FROM 'string'
       OR jsonb_typeof(event_data->'providerEventId') IS DISTINCT FROM 'string'
       OR jsonb_typeof(event_data->'subscriptionId') IS DISTINCT FROM 'string'
       OR jsonb_typeof(event_data->'productKey') IS DISTINCT FROM 'string'
       OR jsonb_typeof(event_data->'effectiveAt') IS DISTINCT FROM 'string'
       OR event_data->>'provider' IS DISTINCT FROM 'stripe'
       OR event_data->>'providerEventId' !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$'
       OR event_data->>'subscriptionId' !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$'
       OR event_data->>'productKey' !~ '^[a-z0-9][a-z0-9._-]{0,63}$'
       OR event_data->>'effectiveAt'
            !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
       OR NOT pg_catalog.pg_input_is_valid(
         event_data->>'effectiveAt', 'timestamp with time zone'
       ) THEN
      RAISE EXCEPTION 'invalid commerce.subscription.cancelled journey payload'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  -- Serialize the entire subject before observing the idempotency receipt.
  -- The event-specific fence above prevents duplicate work for this ID; this
  -- subject fence also orders different event IDs that affect the same route.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'property-predator-journey-subject:' || trusted_workspace_id::text
        || ':' || shadow_receipt.subject_id::text,
      7200018
    )
  );

  SELECT receipt.*
    INTO prior_receipt
  FROM app_private.external_event_journey_projection_receipts AS receipt
  WHERE receipt.workspace_id = trusted_workspace_id
    AND receipt.source = shadow_receipt.source
    AND receipt.event_id = shadow_receipt.event_id;
  IF FOUND THEN
    IF prior_receipt.event_type IS DISTINCT FROM shadow_receipt.event_type
       OR prior_receipt.subject_kind IS DISTINCT FROM shadow_receipt.subject_kind
       OR prior_receipt.subject_id IS DISTINCT FROM shadow_receipt.subject_id
       OR prior_receipt.payload_sha256 IS DISTINCT FROM shadow_receipt.payload_sha256
       OR prior_receipt.disposition IS DISTINCT FROM 'projected' THEN
      RAISE EXCEPTION 'journey projection receipt conflicts with canonical shadow event'
        USING ERRCODE = '22000';
    END IF;
    RETURN QUERY SELECT
      'projected'::text, true,
      prior_receipt.enrollments_started,
      prior_receipt.milestones_achieved,
      prior_receipt.score_snapshots_written,
      prior_receipt.consent_facts_written,
      prior_receipt.commerce_facts_written;
    RETURN;
  END IF;

  IF NOT app_private.property_predator_journey_runtime_ready() THEN
    RAISE EXCEPTION 'active published Property Predator v2 journey runtime is not installed'
      USING ERRCODE = '23503';
  END IF;

  SELECT identity.id, identity.contact_id
    INTO source_identity_id, resolved_contact_id
  FROM app.contact_source_identities AS identity
  JOIN app.contacts AS contact
    ON contact.workspace_id = identity.workspace_id
   AND contact.id = identity.contact_id
   AND contact.deleted_at IS NULL
  WHERE identity.workspace_id = trusted_workspace_id
    AND identity.source_system = 'property_predator'
    AND identity.source_subject_kind = 'account'
    AND identity.source_subject_id = shadow_receipt.subject_id
    AND (
      shadow_receipt.event_type <> 'identity.account.created'
      OR identity.source_event_id = shadow_receipt.event_id
    );
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Property Predator source identity must be projected first'
      USING ERRCODE = '23503';
  END IF;

  SELECT DISTINCT score_version.id, score_version.definition
    INTO shared_score_model_version_id, score_definition
  FROM app.conversion_journeys AS journey
  JOIN app.conversion_journey_versions AS journey_version
    ON journey_version.workspace_id = journey.workspace_id
   AND journey_version.journey_id = journey.id
   AND journey_version.id = journey.active_version_id
  JOIN app.lead_score_model_versions AS score_version
    ON score_version.workspace_id = journey_version.workspace_id
   AND score_version.id = journey_version.score_model_version_id
  WHERE journey.workspace_id = trusted_workspace_id
    AND journey.slug IN (
      'property-predator-self-serve', 'property-predator-agency-laps'
    )
    AND journey.status = 'active'
    AND journey_version.version_no = 2
    AND score_version.version_no = 2;

  -- Revalidate the generic, audited score document before any runtime write.
  IF shared_score_model_version_id IS NULL
     OR jsonb_typeof(score_definition) IS DISTINCT FROM 'object'
     OR NOT (score_definition ?& ARRAY[
       'schemaVersion', 'slug', 'name', 'version', 'components', 'bands', 'rules'
     ])
     OR score_definition - ARRAY[
       'schemaVersion', 'slug', 'name', 'version', 'components', 'bands', 'rules'
     ] <> '{}'::jsonb
     OR jsonb_typeof(score_definition->'schemaVersion') IS DISTINCT FROM 'number'
     OR score_definition->>'schemaVersion' IS DISTINCT FROM '1'
     OR score_definition->>'slug' IS DISTINCT FROM 'property-predator-lead-score'
     OR jsonb_typeof(score_definition->'name') IS DISTINCT FROM 'string'
     OR length(score_definition->>'name') NOT BETWEEN 1 AND 120
     OR score_definition->>'name' IS DISTINCT FROM btrim(score_definition->>'name')
     OR jsonb_typeof(score_definition->'version') IS DISTINCT FROM 'number'
     OR score_definition->>'version' IS DISTINCT FROM '2'
     OR jsonb_typeof(score_definition->'components') IS DISTINCT FROM 'array'
     OR jsonb_typeof(score_definition->'bands') IS DISTINCT FROM 'array'
     OR jsonb_typeof(score_definition->'rules') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'published Property Predator score definition is invalid'
      USING ERRCODE = '23514';
  END IF;

  IF jsonb_array_length(score_definition->'components') NOT BETWEEN 1 AND 12
     OR jsonb_array_length(score_definition->'bands') NOT BETWEEN 1 AND 12
     OR jsonb_array_length(score_definition->'rules') NOT BETWEEN 1 AND 64
     OR EXISTS (
       SELECT 1
       FROM jsonb_array_elements(score_definition->'components') AS item(value)
       WHERE jsonb_typeof(item.value) IS DISTINCT FROM 'object'
          OR NOT (item.value ?& ARRAY['key', 'name', 'maxPoints'])
          OR item.value - ARRAY['key', 'name', 'maxPoints'] <> '{}'::jsonb
          OR item.value->>'key' !~ '^[a-z][a-z0-9_.-]{0,62}$'
          OR length(item.value->>'name') NOT BETWEEN 1 AND 120
          OR item.value->>'name' IS DISTINCT FROM btrim(item.value->>'name')
          OR item.value->>'name' ~ '[[:cntrl:]]'
          OR jsonb_typeof(item.value->'maxPoints') IS DISTINCT FROM 'number'
          OR NOT (CASE WHEN item.value->>'maxPoints' ~ '^[1-9][0-9]{0,2}$'
            THEN (item.value->>'maxPoints')::integer BETWEEN 1 AND 100
            ELSE false END)
          OR lower((item.value->>'key') || ' ' || (item.value->>'name'))
               ~ '(consent|permission|suppression|opt[_. -]?(in|out))'
     )
     OR EXISTS (
       SELECT 1
       FROM jsonb_array_elements(score_definition->'bands') AS item(value)
       WHERE jsonb_typeof(item.value) IS DISTINCT FROM 'object'
          OR NOT (item.value ?& ARRAY['key', 'name', 'minScore', 'maxScore'])
          OR item.value - ARRAY['key', 'name', 'minScore', 'maxScore'] <> '{}'::jsonb
          OR item.value->>'key' !~ '^[a-z][a-z0-9_.-]{0,62}$'
          OR length(item.value->>'name') NOT BETWEEN 1 AND 120
          OR item.value->>'name' IS DISTINCT FROM btrim(item.value->>'name')
          OR jsonb_typeof(item.value->'minScore') IS DISTINCT FROM 'number'
          OR jsonb_typeof(item.value->'maxScore') IS DISTINCT FROM 'number'
          OR NOT (CASE
            WHEN item.value->>'minScore' ~ '^(0|[1-9][0-9]{0,2})$'
             AND item.value->>'maxScore' ~ '^(0|[1-9][0-9]{0,2})$'
            THEN (item.value->>'minScore')::integer BETWEEN 0 AND 100
             AND (item.value->>'maxScore')::integer BETWEEN
                   (item.value->>'minScore')::integer AND 100
            ELSE false END)
     )
     OR EXISTS (
       SELECT 1
       FROM jsonb_array_elements(score_definition->'rules') AS item(value)
       WHERE jsonb_typeof(item.value) IS DISTINCT FROM 'object'
          OR NOT (item.value ?& ARRAY[
            'key', 'componentKey', 'kind', 'sourceKey',
            'points', 'reason', 'mode', 'frequency'
          ])
          OR item.value - ARRAY[
            'key', 'componentKey', 'kind', 'sourceKey',
            'points', 'reason', 'mode', 'frequency'
          ] <> '{}'::jsonb
          OR item.value->>'key' !~ '^[a-z][a-z0-9_.-]{0,62}$'
          OR item.value->>'componentKey' !~ '^[a-z][a-z0-9_.-]{0,62}$'
          OR item.value->>'kind' NOT IN ('event', 'commerce')
          OR NOT (
            (item.value->>'kind' = 'event' AND item.value->>'sourceKey' IN (
              'identity.account.created', 'product.analysis.completed',
              'content.consumption.completed', 'offer.presented',
              'sales.appointment.booked', 'sales.presentation.completed'
            ))
            OR (item.value->>'kind' = 'commerce'
              AND item.value->>'sourceKey' = 'payment_collected')
          )
          OR jsonb_typeof(item.value->'points') IS DISTINCT FROM 'number'
          OR NOT (CASE WHEN item.value->>'points' ~ '^[1-9][0-9]{0,2}$'
            THEN (item.value->>'points')::integer BETWEEN 1 AND 100
            ELSE false END)
          OR length(item.value->>'reason') NOT BETWEEN 1 AND 500
          OR item.value->>'reason' IS DISTINCT FROM btrim(item.value->>'reason')
          OR item.value->>'reason' ~ '[[:cntrl:]]'
          OR item.value->>'mode' IS DISTINCT FROM 'direct'
          OR item.value->>'frequency' IS DISTINCT FROM 'once_per_enrollment'
          OR lower(
            (item.value->>'key') || ' ' || (item.value->>'componentKey') || ' '
              || (item.value->>'sourceKey') || ' ' || (item.value->>'reason')
          ) ~ '(consent|permission|suppression|opt[_. -]?(in|out))'
     ) THEN
    RAISE EXCEPTION 'published Property Predator score components are invalid'
      USING ERRCODE = '23514';
  END IF;

  IF (
       SELECT count(*) <> count(DISTINCT item.value->>'key')
           OR sum((item.value->>'maxPoints')::integer) <> 100
       FROM jsonb_array_elements(score_definition->'components') AS item(value)
     )
     OR (
       SELECT count(*) <> count(DISTINCT item.value->>'key')
       FROM jsonb_array_elements(score_definition->'bands') AS item(value)
     )
     OR (
       SELECT count(*) <> count(DISTINCT item.value->>'key')
           OR count(*) <> count(DISTINCT
             (item.value->>'kind') || ':' || (item.value->>'sourceKey')
           )
       FROM jsonb_array_elements(score_definition->'rules') AS item(value)
     )
     OR EXISTS (
       WITH band AS (
         SELECT ordinality,
                (value->>'minScore')::integer AS min_score,
                (value->>'maxScore')::integer AS max_score
         FROM jsonb_array_elements(score_definition->'bands')
              WITH ORDINALITY AS item(value, ordinality)
       ), ordered_band AS (
         SELECT band.*,
                lag(max_score) OVER (ORDER BY ordinality) AS prior_max,
                max(ordinality) OVER () AS last_ordinality
         FROM band
       )
       SELECT 1 FROM ordered_band
       WHERE min_score <> coalesce(prior_max + 1, 0)
          OR (ordinality = last_ordinality AND max_score <> 100)
     )
     OR EXISTS (
       SELECT 1
       FROM jsonb_array_elements(score_definition->'rules') AS rule(value)
       WHERE NOT EXISTS (
         SELECT 1
         FROM jsonb_array_elements(score_definition->'components') AS component(value)
         WHERE component.value->>'key' = rule.value->>'componentKey'
       )
     )
     OR EXISTS (
       SELECT 1
       FROM jsonb_array_elements(score_definition->'components') AS component(value)
       WHERE coalesce((
         SELECT sum((rule.value->>'points')::integer)
         FROM jsonb_array_elements(score_definition->'rules') AS rule(value)
         WHERE rule.value->>'componentKey' = component.value->>'key'
       ), 0) > (component.value->>'maxPoints')::integer
     ) THEN
    RAISE EXCEPTION 'published Property Predator score topology is invalid'
      USING ERRCODE = '23514';
  END IF;

  IF shadow_receipt.event_type = 'privacy.consent.updated' THEN
    SELECT count(*)::integer
      INTO candidate_count
    FROM app.contact_points AS point
    WHERE point.workspace_id = trusted_workspace_id
      AND point.contact_id = resolved_contact_id
      AND point.kind = 'email'
      AND point.dedupe_state = 'normal'
      AND point.deleted_at IS NULL
      AND (
        (event_data ? 'email' AND point.normalized_value = event_data->>'email')
        OR (NOT (event_data ? 'email') AND point.is_primary)
      );
    IF candidate_count <> 1 THEN
      RAISE EXCEPTION 'consent projection requires exactly one active normal email endpoint'
        USING ERRCODE = '23503';
    END IF;
    SELECT point.id
      INTO STRICT resolved_point_id
    FROM app.contact_points AS point
    WHERE point.workspace_id = trusted_workspace_id
      AND point.contact_id = resolved_contact_id
      AND point.kind = 'email'
      AND point.dedupe_state = 'normal'
      AND point.deleted_at IS NULL
      AND (
        (event_data ? 'email' AND point.normalized_value = event_data->>'email')
        OR (NOT (event_data ? 'email') AND point.is_primary)
      );

    new_fact_id := NULL;
    INSERT INTO app.communication_consent_events (
      workspace_id, contact_id, contact_point_id, channel, purpose, state,
      lawful_basis, source, policy_version, policy_text_sha256,
      source_event_id, actor_kind, actor_user_id, evidence, occurred_at
    ) VALUES (
      trusted_workspace_id, resolved_contact_id, resolved_point_id, 'email',
      event_data->>'purpose', event_data->>'state',
      CASE WHEN event_data->>'state' = 'granted' THEN 'consent' ELSE NULL END,
      'property_predator', event_data->>'policyVersion',
      CASE WHEN event_data ? 'policyTextSha256'
        THEN decode(event_data->>'policyTextSha256', 'hex') ELSE NULL END,
      shadow_receipt.event_id::text, 'webhook', NULL,
      jsonb_build_object('source', event_data->>'source'),
      shadow_receipt.occurred_at
    )
    ON CONFLICT (
      workspace_id, source, source_event_id, contact_point_id, channel, purpose
    ) WHERE source_event_id IS NOT NULL
    DO NOTHING
    RETURNING id INTO new_fact_id;

    IF new_fact_id IS NOT NULL THEN
      consent_count := consent_count + 1;
      PERFORM app_private.append_property_predator_journey_outbox(
        trusted_workspace_id, 'contact', resolved_contact_id,
        'communication.consent.recorded',
        'pp:' || shadow_receipt.event_id::text || ':consent:' || new_fact_id::text,
        jsonb_build_object(
          'consentFactId', new_fact_id,
          'contactId', resolved_contact_id,
          'contactPointId', resolved_point_id,
          'channel', 'email',
          'purpose', event_data->>'purpose',
          'state', event_data->>'state',
          'sourceEventId', shadow_receipt.event_id
        ),
        trusted_request_id, shadow_receipt.correlation_id,
        shadow_receipt.event_id, shadow_receipt.occurred_at
      );
    ELSIF NOT EXISTS (
      SELECT 1
      FROM app.communication_consent_events AS consent_fact
      WHERE consent_fact.workspace_id = trusted_workspace_id
        AND consent_fact.contact_id = resolved_contact_id
        AND consent_fact.contact_point_id = resolved_point_id
        AND consent_fact.channel = 'email'
        AND consent_fact.purpose = event_data->>'purpose'
        AND consent_fact.state = event_data->>'state'
        AND consent_fact.lawful_basis IS NOT DISTINCT FROM
            CASE WHEN event_data->>'state' = 'granted' THEN 'consent' ELSE NULL END
        AND consent_fact.source = 'property_predator'
        AND consent_fact.policy_version IS NOT DISTINCT FROM event_data->>'policyVersion'
        AND consent_fact.policy_text_sha256 IS NOT DISTINCT FROM
            CASE WHEN event_data ? 'policyTextSha256'
              THEN decode(event_data->>'policyTextSha256', 'hex') ELSE NULL END
        AND consent_fact.source_event_id = shadow_receipt.event_id::text
        AND consent_fact.actor_kind = 'webhook'
        AND consent_fact.actor_user_id IS NULL
        AND consent_fact.evidence = jsonb_build_object('source', event_data->>'source')
        AND consent_fact.occurred_at = shadow_receipt.occurred_at
    ) THEN
      RAISE EXCEPTION 'existing consent fact conflicts with canonical event'
        USING ERRCODE = '22000';
    END IF;
  END IF;

  -- Only reviewed non-commerce triggers may create an enrollment. Stable slug
  -- ordering plus the subject fence serializes all route and scoring changes.
  FOR trigger_row IN
    SELECT journey.slug::text AS journey_slug,
           journey.id AS journey_id,
           journey_version.id AS journey_version_id,
           journey_version.score_model_version_id,
           milestone.id AS milestone_id,
           milestone.position AS milestone_position,
           milestone.semantic AS milestone_semantic
    FROM app.conversion_journeys AS journey
    JOIN app.conversion_journey_versions AS journey_version
      ON journey_version.workspace_id = journey.workspace_id
     AND journey_version.journey_id = journey.id
     AND journey_version.id = journey.active_version_id
     AND journey_version.version_no = 2
     AND journey_version.published_at IS NOT NULL
    JOIN app.conversion_journey_triggers AS trigger_definition
      ON trigger_definition.workspace_id = journey_version.workspace_id
     AND trigger_definition.journey_version_id = journey_version.id
     AND trigger_definition.trigger_kind = 'event'
     AND trigger_definition.source_key = shadow_receipt.event_type
    JOIN app.conversion_journey_milestones AS milestone
      ON milestone.workspace_id = trigger_definition.workspace_id
     AND milestone.journey_version_id = trigger_definition.journey_version_id
     AND milestone.id = trigger_definition.milestone_id
    WHERE journey.workspace_id = trusted_workspace_id
      AND journey.status = 'active'
      AND journey.slug IN (
        'property-predator-self-serve', 'property-predator-agency-laps'
      )
    ORDER BY journey.slug::text, journey.id, journey_version.id
  LOOP
    trigger_count := trigger_count + 1;
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'property-predator-enrollment:' || trusted_workspace_id::text || ':'
          || resolved_contact_id::text || ':' || trigger_row.journey_version_id::text,
        7200018
      )
    );

    SELECT count(*)::integer
      INTO candidate_count
    FROM app.conversion_enrollments AS enrollment
    WHERE enrollment.workspace_id = trusted_workspace_id
      AND enrollment.journey_id = trigger_row.journey_id
      AND enrollment.journey_version_id = trigger_row.journey_version_id
      AND enrollment.contact_id = resolved_contact_id
      AND enrollment.status = 'active';
    IF candidate_count > 1 THEN
      RAISE EXCEPTION 'multiple active enrollments conflict with one Property Predator route'
        USING ERRCODE = '21000';
    END IF;

    -- V2 is a single conversion cycle. A later event for a terminal route is
    -- acknowledged as a deterministic zero-output projection, never a second
    -- enrollment and never a permanent retry failure.
    IF candidate_count = 0 AND EXISTS (
      SELECT 1
      FROM app.conversion_enrollments AS terminal_enrollment
      WHERE terminal_enrollment.workspace_id = trusted_workspace_id
        AND terminal_enrollment.journey_id = trigger_row.journey_id
        AND terminal_enrollment.journey_version_id = trigger_row.journey_version_id
        AND terminal_enrollment.contact_id = resolved_contact_id
        AND terminal_enrollment.status IN ('completed', 'withdrawn', 'disqualified')
    ) THEN
      CONTINUE;
    END IF;

    target_enrollment_id := NULL;
    target_current_position := NULL;
    IF candidate_count = 1 THEN
      SELECT enrollment.id, current_milestone.position
        INTO target_enrollment_id, target_current_position
      FROM app.conversion_enrollments AS enrollment
      LEFT JOIN app.conversion_journey_milestones AS current_milestone
        ON current_milestone.workspace_id = enrollment.workspace_id
       AND current_milestone.journey_version_id = enrollment.journey_version_id
       AND current_milestone.id = enrollment.current_milestone_id
      WHERE enrollment.workspace_id = trusted_workspace_id
        AND enrollment.journey_id = trigger_row.journey_id
        AND enrollment.journey_version_id = trigger_row.journey_version_id
        AND enrollment.contact_id = resolved_contact_id
        AND enrollment.status = 'active'
      FOR UPDATE OF enrollment;
    ELSE
      enrollment_key_value := 'property-predator:' || shadow_receipt.subject_id::text
        || ':' || trigger_row.journey_version_id::text;
      INSERT INTO app.conversion_enrollments (
        workspace_id, journey_id, journey_version_id, score_model_version_id,
        contact_id, opportunity_id, enrollment_key, status,
        current_milestone_id, source, metadata, enrolled_by_kind,
        enrolled_by_user_id, enrolled_at, last_event_at
      ) VALUES (
        trusted_workspace_id, trigger_row.journey_id,
        trigger_row.journey_version_id, trigger_row.score_model_version_id,
        resolved_contact_id, NULL, enrollment_key_value, 'active', NULL,
        'property_predator',
        jsonb_build_object(
          'sourceSubjectId', shadow_receipt.subject_id,
          'sourceIdentityId', source_identity_id
        ),
        'webhook', NULL, shadow_receipt.occurred_at, shadow_receipt.occurred_at
      )
      ON CONFLICT (workspace_id, journey_id, enrollment_key) DO NOTHING
      RETURNING id INTO target_enrollment_id;

      IF target_enrollment_id IS NULL THEN
        SELECT enrollment.id, current_milestone.position, enrollment.status
          INTO target_enrollment_id, target_current_position, target_enrollment_status
        FROM app.conversion_enrollments AS enrollment
        LEFT JOIN app.conversion_journey_milestones AS current_milestone
          ON current_milestone.workspace_id = enrollment.workspace_id
         AND current_milestone.journey_version_id = enrollment.journey_version_id
         AND current_milestone.id = enrollment.current_milestone_id
        WHERE enrollment.workspace_id = trusted_workspace_id
          AND enrollment.journey_id = trigger_row.journey_id
          AND enrollment.enrollment_key = enrollment_key_value
          AND enrollment.journey_version_id = trigger_row.journey_version_id
          AND enrollment.score_model_version_id = trigger_row.score_model_version_id
          AND enrollment.contact_id = resolved_contact_id
        FOR UPDATE OF enrollment;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'existing deterministic enrollment is not reusable'
            USING ERRCODE = '55000';
        ELSIF target_enrollment_status IN ('completed', 'withdrawn', 'disqualified') THEN
          CONTINUE;
        END IF;
      ELSE
        started_count := started_count + 1;
        PERFORM app_private.append_property_predator_journey_outbox(
          trusted_workspace_id, 'conversion_enrollment', target_enrollment_id,
          'conversion.enrollment.started',
          'pp:' || shadow_receipt.event_id::text || ':enrollment:'
            || target_enrollment_id::text,
          jsonb_build_object(
            'enrollmentId', target_enrollment_id,
            'contactId', resolved_contact_id,
            'journeyId', trigger_row.journey_id,
            'journeyVersionId', trigger_row.journey_version_id,
            'sourceEventId', shadow_receipt.event_id,
            'status', 'active'
          ),
          trusted_request_id, shadow_receipt.correlation_id,
          shadow_receipt.event_id, shadow_receipt.occurred_at
        );
      END IF;
    END IF;

    -- A presentation is authoritative only for the appointment already reached
    -- by this exact enrollment and provider appointment reference.
    IF shadow_receipt.event_type = 'sales.presentation.completed' THEN
      SELECT count(*)::integer, min(appointment_fact.occurred_at)
        INTO candidate_count, selected_prerequisite_occurred_at
      FROM app.conversion_milestone_facts AS appointment_fact
      JOIN app.conversion_journey_milestones AS appointment_milestone
        ON appointment_milestone.workspace_id = appointment_fact.workspace_id
       AND appointment_milestone.journey_version_id = appointment_fact.journey_version_id
       AND appointment_milestone.id = appointment_fact.milestone_id
      WHERE appointment_fact.workspace_id = trusted_workspace_id
        AND appointment_fact.enrollment_id = target_enrollment_id
        AND appointment_fact.contact_id = resolved_contact_id
        AND appointment_milestone.semantic = 'appointment'
        AND appointment_fact.evidence->>'appointmentId' = event_data->>'appointmentId';
      IF candidate_count <> 1 THEN
        RAISE EXCEPTION 'matching appointment milestone is required before presentation'
          USING ERRCODE = '23503';
      END IF;
      IF shadow_receipt.occurred_at < selected_prerequisite_occurred_at THEN
        RAISE EXCEPTION 'presentation predates its matching appointment'
          USING ERRCODE = '23514';
      END IF;
    END IF;

    -- Agency enrollment starts at Lead and Appointment from the same first
    -- appointment fact; it does not duplicate all account-created leads.
    IF trigger_row.journey_slug = 'property-predator-agency-laps'
       AND shadow_receipt.event_type = 'sales.appointment.booked' THEN
      SELECT milestone.id
        INTO lead_milestone_id
      FROM app.conversion_journey_milestones AS milestone
      WHERE milestone.workspace_id = trusted_workspace_id
        AND milestone.journey_version_id = trigger_row.journey_version_id
        AND milestone.milestone_key = 'lead'
        AND milestone.position = 1
        AND milestone.semantic = 'lead'
        AND NOT milestone.is_completion;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'agency Lead milestone is missing'
          USING ERRCODE = '23503';
      END IF;

      lead_fact_id := NULL;
      INSERT INTO app.conversion_milestone_facts (
        workspace_id, enrollment_id, contact_id, journey_version_id,
        milestone_id, milestone_semantic, source_kind, source_system,
        source_event_id, commerce_fact_id, commerce_fact_type,
        actor_kind, actor_user_id, evidence, occurred_at
      ) VALUES (
        trusted_workspace_id, target_enrollment_id, resolved_contact_id,
        trigger_row.journey_version_id, lead_milestone_id, 'lead',
        'event', 'property_predator', shadow_receipt.event_id::text,
        NULL, NULL, 'webhook', NULL,
        jsonb_build_object(
          'eventType', shadow_receipt.event_type,
          'appointmentId', event_data->>'appointmentId',
          'establishedBy', 'first_appointment'
        ),
        shadow_receipt.occurred_at
      )
      ON CONFLICT DO NOTHING
      RETURNING id INTO lead_fact_id;

      IF lead_fact_id IS NOT NULL THEN
        milestone_count := milestone_count + 1;
        PERFORM app_private.append_property_predator_journey_outbox(
          trusted_workspace_id, 'conversion_enrollment', target_enrollment_id,
          'conversion.milestone.achieved',
          'pp:' || shadow_receipt.event_id::text || ':milestone:' || lead_fact_id::text,
          jsonb_build_object(
            'milestoneFactId', lead_fact_id,
            'enrollmentId', target_enrollment_id,
            'contactId', resolved_contact_id,
            'journeyVersionId', trigger_row.journey_version_id,
            'milestoneId', lead_milestone_id,
            'milestoneSemantic', 'lead',
            'sourceEventId', shadow_receipt.event_id
          ),
          trusted_request_id, shadow_receipt.correlation_id,
          shadow_receipt.event_id, shadow_receipt.occurred_at
        );
      ELSIF NOT EXISTS (
        SELECT 1 FROM app.conversion_milestone_facts AS fact
        WHERE fact.workspace_id = trusted_workspace_id
          AND fact.enrollment_id = target_enrollment_id
          AND fact.contact_id = resolved_contact_id
          AND fact.journey_version_id = trigger_row.journey_version_id
          AND fact.milestone_id = lead_milestone_id
          AND fact.milestone_semantic = 'lead'
      ) THEN
        RAISE EXCEPTION 'agency Lead milestone conflicts with canonical event'
          USING ERRCODE = '22000';
      END IF;
    END IF;

    milestone_evidence := CASE shadow_receipt.event_type
      WHEN 'identity.account.created' THEN
        jsonb_build_object('eventType', shadow_receipt.event_type)
      WHEN 'product.analysis.completed' THEN
        jsonb_build_object(
          'eventType', shadow_receipt.event_type,
          'toolKey', event_data->>'toolKey',
          'accessMode', event_data->>'accessMode',
          'unitsSpent', (event_data->>'unitsSpent')::integer
        )
      WHEN 'offer.presented' THEN
        jsonb_build_object(
          'eventType', shadow_receipt.event_type,
          'offerKey', event_data->>'offerKey',
          'productKey', event_data->>'productKey',
          'placement', event_data->>'placement'
        )
      WHEN 'sales.appointment.booked' THEN
        jsonb_build_object(
          'eventType', shadow_receipt.event_type,
          'appointmentId', event_data->>'appointmentId',
          'startsAt', event_data->>'startsAt',
          'bookingSource', event_data->>'bookingSource',
          'meetingKind', event_data->>'meetingKind'
        )
      WHEN 'sales.presentation.completed' THEN
        jsonb_build_object(
          'eventType', shadow_receipt.event_type,
          'appointmentId', event_data->>'appointmentId',
          'presentationKey', event_data->>'presentationKey',
          'durationSeconds', (event_data->>'durationSeconds')::integer,
          'outcome', event_data->>'outcome'
        )
      ELSE jsonb_build_object('eventType', shadow_receipt.event_type)
    END;

    new_fact_id := NULL;
    INSERT INTO app.conversion_milestone_facts (
      workspace_id, enrollment_id, contact_id, journey_version_id,
      milestone_id, milestone_semantic, source_kind, source_system,
      source_event_id, commerce_fact_id, commerce_fact_type,
      actor_kind, actor_user_id, evidence, occurred_at
    ) VALUES (
      trusted_workspace_id, target_enrollment_id, resolved_contact_id,
      trigger_row.journey_version_id, trigger_row.milestone_id,
      trigger_row.milestone_semantic, 'event', 'property_predator',
      shadow_receipt.event_id::text, NULL, NULL, 'webhook', NULL,
      milestone_evidence, shadow_receipt.occurred_at
    )
    ON CONFLICT DO NOTHING
    RETURNING id INTO new_fact_id;

    IF new_fact_id IS NOT NULL THEN
      milestone_count := milestone_count + 1;
      PERFORM app_private.append_property_predator_journey_outbox(
        trusted_workspace_id, 'conversion_enrollment', target_enrollment_id,
        'conversion.milestone.achieved',
        'pp:' || shadow_receipt.event_id::text || ':milestone:' || new_fact_id::text,
        jsonb_build_object(
          'milestoneFactId', new_fact_id,
          'enrollmentId', target_enrollment_id,
          'contactId', resolved_contact_id,
          'journeyVersionId', trigger_row.journey_version_id,
          'milestoneId', trigger_row.milestone_id,
          'milestoneSemantic', trigger_row.milestone_semantic,
          'sourceEventId', shadow_receipt.event_id
        ),
        trusted_request_id, shadow_receipt.correlation_id,
        shadow_receipt.event_id, shadow_receipt.occurred_at
      );
    ELSIF NOT EXISTS (
      SELECT 1 FROM app.conversion_milestone_facts AS fact
      WHERE fact.workspace_id = trusted_workspace_id
        AND fact.enrollment_id = target_enrollment_id
        AND fact.contact_id = resolved_contact_id
        AND fact.journey_version_id = trigger_row.journey_version_id
        AND fact.milestone_id = trigger_row.milestone_id
        AND fact.milestone_semantic = trigger_row.milestone_semantic
    ) THEN
      RAISE EXCEPTION 'milestone source conflicts with canonical enrollment'
        USING ERRCODE = '22000';
    END IF;

    UPDATE app.conversion_enrollments AS enrollment
       SET current_milestone_id = CASE
             WHEN target_current_position IS NULL
               OR trigger_row.milestone_position > target_current_position
             THEN trigger_row.milestone_id
             ELSE enrollment.current_milestone_id
           END,
           last_event_at = greatest(
             coalesce(enrollment.last_event_at, shadow_receipt.occurred_at),
             shadow_receipt.occurred_at
           ),
           row_version = enrollment.row_version + 1,
           updated_at = statement_timestamp()
     WHERE enrollment.workspace_id = trusted_workspace_id
       AND enrollment.id = target_enrollment_id
       AND enrollment.contact_id = resolved_contact_id
       AND enrollment.status = 'active';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'active enrollment disappeared during projection'
        USING ERRCODE = '40001';
    END IF;
  END LOOP;

  IF shadow_receipt.event_type IN (
       'identity.account.created', 'product.analysis.completed',
       'offer.presented', 'sales.appointment.booked',
       'sales.presentation.completed'
     ) AND trigger_count <> 1 THEN
    RAISE EXCEPTION 'published Property Predator event trigger is missing or ambiguous'
      USING ERRCODE = '23514';
  END IF;

  IF shadow_receipt.event_type = 'commerce.purchase.completed' THEN
    -- Attribute one payment to one route. A qualified active agency LAPS route
    -- wins; otherwise one active self-serve route is selected. Commerce never
    -- creates an enrollment.
    SELECT count(*)::integer
      INTO candidate_count
    FROM app.conversion_enrollments AS enrollment
    JOIN app.conversion_journeys AS journey
      ON journey.workspace_id = enrollment.workspace_id
     AND journey.id = enrollment.journey_id
     AND journey.active_version_id = enrollment.journey_version_id
     AND journey.slug = 'property-predator-agency-laps'
     AND journey.status = 'active'
    WHERE enrollment.workspace_id = trusted_workspace_id
      AND enrollment.contact_id = resolved_contact_id
      AND enrollment.status = 'active'
      AND enrollment.score_model_version_id = shared_score_model_version_id
      AND EXISTS (
        SELECT 1
        FROM app.conversion_milestone_facts AS reached
        WHERE reached.workspace_id = enrollment.workspace_id
          AND reached.enrollment_id = enrollment.id
          AND reached.contact_id = enrollment.contact_id
          AND reached.journey_version_id = enrollment.journey_version_id
          AND reached.milestone_semantic IN ('appointment', 'presentation')
      );
    IF candidate_count > 1 THEN
      RAISE EXCEPTION 'multiple qualified active agency enrollments conflict with sale attribution'
        USING ERRCODE = '21000';
    END IF;

    SELECT enrollment.id, enrollment.journey_version_id,
           enrollment.score_model_version_id, enrollment.enrolled_at
      INTO selected_enrollment_id, selected_journey_version_id,
           selected_score_model_version_id, selected_enrolled_at
    FROM app.conversion_enrollments AS enrollment
    JOIN app.conversion_journeys AS journey
      ON journey.workspace_id = enrollment.workspace_id
     AND journey.id = enrollment.journey_id
     AND journey.active_version_id = enrollment.journey_version_id
     AND journey.slug = 'property-predator-agency-laps'
     AND journey.status = 'active'
    WHERE enrollment.workspace_id = trusted_workspace_id
      AND enrollment.contact_id = resolved_contact_id
      AND enrollment.status = 'active'
      AND enrollment.score_model_version_id = shared_score_model_version_id
      AND EXISTS (
        SELECT 1
        FROM app.conversion_milestone_facts AS reached
        WHERE reached.workspace_id = enrollment.workspace_id
          AND reached.enrollment_id = enrollment.id
          AND reached.contact_id = enrollment.contact_id
          AND reached.journey_version_id = enrollment.journey_version_id
          AND reached.milestone_semantic IN ('appointment', 'presentation')
      )
    ORDER BY
      (SELECT max(reached_milestone.position)
       FROM app.conversion_milestone_facts AS reached_fact
       JOIN app.conversion_journey_milestones AS reached_milestone
         ON reached_milestone.workspace_id = reached_fact.workspace_id
        AND reached_milestone.journey_version_id = reached_fact.journey_version_id
        AND reached_milestone.id = reached_fact.milestone_id
       WHERE reached_fact.workspace_id = enrollment.workspace_id
         AND reached_fact.enrollment_id = enrollment.id) DESC NULLS LAST,
      enrollment.enrolled_at,
      enrollment.id
    LIMIT 1
    FOR UPDATE OF enrollment;

    IF NOT FOUND THEN
      SELECT count(*)::integer
        INTO candidate_count
      FROM app.conversion_enrollments AS enrollment
      JOIN app.conversion_journeys AS journey
        ON journey.workspace_id = enrollment.workspace_id
       AND journey.id = enrollment.journey_id
       AND journey.active_version_id = enrollment.journey_version_id
       AND journey.slug = 'property-predator-self-serve'
       AND journey.status = 'active'
      WHERE enrollment.workspace_id = trusted_workspace_id
        AND enrollment.contact_id = resolved_contact_id
        AND enrollment.status = 'active'
        AND enrollment.score_model_version_id = shared_score_model_version_id;
      IF candidate_count > 1 THEN
        RAISE EXCEPTION 'multiple active self-serve enrollments conflict with sale attribution'
          USING ERRCODE = '21000';
      END IF;

      SELECT enrollment.id, enrollment.journey_version_id,
             enrollment.score_model_version_id, enrollment.enrolled_at
        INTO selected_enrollment_id, selected_journey_version_id,
             selected_score_model_version_id, selected_enrolled_at
      FROM app.conversion_enrollments AS enrollment
      JOIN app.conversion_journeys AS journey
        ON journey.workspace_id = enrollment.workspace_id
       AND journey.id = enrollment.journey_id
       AND journey.active_version_id = enrollment.journey_version_id
       AND journey.slug = 'property-predator-self-serve'
       AND journey.status = 'active'
      WHERE enrollment.workspace_id = trusted_workspace_id
        AND enrollment.contact_id = resolved_contact_id
        AND enrollment.status = 'active'
        AND enrollment.score_model_version_id = shared_score_model_version_id
      ORDER BY enrollment.enrolled_at, enrollment.id
      LIMIT 1
      FOR UPDATE OF enrollment;
    END IF;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'payment requires an existing active Property Predator enrollment'
        USING ERRCODE = '23503';
    END IF;
    IF shadow_receipt.occurred_at < selected_enrolled_at THEN
      RAISE EXCEPTION 'payment predates its selected active enrollment'
        USING ERRCODE = '23514';
    END IF;

    commerce_fact_id := NULL;
    INSERT INTO app.conversion_commerce_facts (
      workspace_id, enrollment_id, contact_id, source_system,
      source_event_id, source_payload_sha256, fact_type, external_order_id,
      product_key, amount_minor, currency, actor_kind, actor_user_id,
      metadata, occurred_at
    ) VALUES (
      trusted_workspace_id, selected_enrollment_id, resolved_contact_id,
      'property_predator', shadow_receipt.event_id::text,
      shadow_receipt.payload_sha256, 'payment_collected',
      event_data->>'checkoutSessionId', event_data->>'productKey',
      (event_data->>'amountMinor')::bigint, upper(event_data->>'currency'),
      'webhook', NULL,
      jsonb_strip_nulls(jsonb_build_object(
        'provider', 'stripe',
        'provider_event_id', event_data->>'providerEventId',
        'billing_kind', event_data->>'billingKind',
        'subscription_id', event_data->>'subscriptionId'
      )),
      shadow_receipt.occurred_at
    )
    ON CONFLICT (workspace_id, source_system, source_event_id) DO NOTHING
    RETURNING id INTO commerce_fact_id;

    IF commerce_fact_id IS NOT NULL THEN
      commerce_count := commerce_count + 1;
      PERFORM app_private.append_property_predator_journey_outbox(
        trusted_workspace_id, 'conversion_enrollment', selected_enrollment_id,
        'conversion.commerce.fact_recorded',
        'pp:' || shadow_receipt.event_id::text || ':commerce:'
          || commerce_fact_id::text,
        jsonb_build_object(
          'commerceFactId', commerce_fact_id,
          'enrollmentId', selected_enrollment_id,
          'contactId', resolved_contact_id,
          'factType', 'payment_collected',
          'externalOrderId', event_data->>'checkoutSessionId',
          'productKey', event_data->>'productKey',
          'amountMinor', (event_data->>'amountMinor')::bigint,
          'currency', upper(event_data->>'currency'),
          'sourceEventId', shadow_receipt.event_id
        ),
        trusted_request_id, shadow_receipt.correlation_id,
        shadow_receipt.event_id, shadow_receipt.occurred_at
      );
    ELSE
      SELECT fact.id
        INTO commerce_fact_id
      FROM app.conversion_commerce_facts AS fact
      WHERE fact.workspace_id = trusted_workspace_id
        AND fact.enrollment_id = selected_enrollment_id
        AND fact.contact_id = resolved_contact_id
        AND fact.source_system = 'property_predator'
        AND fact.source_event_id = shadow_receipt.event_id::text
        AND fact.source_payload_sha256 = shadow_receipt.payload_sha256
        AND fact.fact_type = 'payment_collected'
        AND fact.external_order_id = event_data->>'checkoutSessionId'
        AND fact.product_key = event_data->>'productKey'
        AND fact.amount_minor = (event_data->>'amountMinor')::bigint
        AND fact.currency = upper(event_data->>'currency')
        AND fact.actor_kind = 'webhook'
        AND fact.actor_user_id IS NULL
        AND fact.metadata = jsonb_strip_nulls(jsonb_build_object(
          'provider', 'stripe',
          'provider_event_id', event_data->>'providerEventId',
          'billing_kind', event_data->>'billingKind',
          'subscription_id', event_data->>'subscriptionId'
        ))
        AND fact.occurred_at = shadow_receipt.occurred_at;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'existing payment fact conflicts with canonical event'
          USING ERRCODE = '22000';
      END IF;
    END IF;

    SELECT milestone.id
      INTO new_fact_id
    FROM app.conversion_journey_triggers AS trigger_definition
    JOIN app.conversion_journey_milestones AS milestone
      ON milestone.workspace_id = trigger_definition.workspace_id
     AND milestone.journey_version_id = trigger_definition.journey_version_id
     AND milestone.id = trigger_definition.milestone_id
    WHERE trigger_definition.workspace_id = trusted_workspace_id
      AND trigger_definition.journey_version_id = selected_journey_version_id
      AND trigger_definition.trigger_kind = 'commerce'
      AND trigger_definition.source_key = 'payment_collected'
      AND milestone.semantic = 'sale'
      AND milestone.is_completion;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'selected journey Sale trigger is missing'
        USING ERRCODE = '23503';
    END IF;

    lead_milestone_id := new_fact_id;
    new_fact_id := NULL;
    INSERT INTO app.conversion_milestone_facts (
      workspace_id, enrollment_id, contact_id, journey_version_id,
      milestone_id, milestone_semantic, source_kind, source_system,
      source_event_id, commerce_fact_id, commerce_fact_type,
      actor_kind, actor_user_id, evidence, occurred_at
    ) VALUES (
      trusted_workspace_id, selected_enrollment_id, resolved_contact_id,
      selected_journey_version_id, lead_milestone_id, 'sale',
      'commerce', NULL, NULL, commerce_fact_id, 'payment_collected',
      'webhook', NULL,
      jsonb_build_object(
        'eventType', shadow_receipt.event_type,
        'productKey', event_data->>'productKey',
        'externalOrderId', event_data->>'checkoutSessionId'
      ),
      shadow_receipt.occurred_at
    )
    ON CONFLICT DO NOTHING
    RETURNING id INTO new_fact_id;
    IF new_fact_id IS NOT NULL THEN
      milestone_count := milestone_count + 1;
      PERFORM app_private.append_property_predator_journey_outbox(
        trusted_workspace_id, 'conversion_enrollment', selected_enrollment_id,
        'conversion.milestone.achieved',
        'pp:' || shadow_receipt.event_id::text || ':milestone:' || new_fact_id::text,
        jsonb_build_object(
          'milestoneFactId', new_fact_id,
          'enrollmentId', selected_enrollment_id,
          'contactId', resolved_contact_id,
          'journeyVersionId', selected_journey_version_id,
          'milestoneId', lead_milestone_id,
          'milestoneSemantic', 'sale',
          'sourceEventId', shadow_receipt.event_id
        ),
        trusted_request_id, shadow_receipt.correlation_id,
        shadow_receipt.event_id, shadow_receipt.occurred_at
      );
    ELSIF NOT EXISTS (
      SELECT 1 FROM app.conversion_milestone_facts AS fact
      WHERE fact.workspace_id = trusted_workspace_id
        AND fact.enrollment_id = selected_enrollment_id
        AND fact.contact_id = resolved_contact_id
        AND fact.journey_version_id = selected_journey_version_id
        AND fact.milestone_id = lead_milestone_id
        AND fact.milestone_semantic = 'sale'
        AND fact.source_kind = 'commerce'
        AND fact.commerce_fact_id = commerce_fact_id
        AND fact.commerce_fact_type = 'payment_collected'
    ) THEN
      RAISE EXCEPTION 'existing Sale milestone conflicts with selected payment'
        USING ERRCODE = '22000';
    END IF;

    UPDATE app.conversion_enrollments AS enrollment
       SET status = 'completed',
           current_milestone_id = lead_milestone_id,
           last_event_at = greatest(
             coalesce(enrollment.last_event_at, shadow_receipt.occurred_at),
             shadow_receipt.occurred_at
           ),
           ended_at = shadow_receipt.occurred_at,
           row_version = enrollment.row_version + 1,
           updated_at = statement_timestamp()
     WHERE enrollment.workspace_id = trusted_workspace_id
       AND enrollment.id = selected_enrollment_id
       AND enrollment.contact_id = resolved_contact_id
       AND enrollment.status = 'active';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'selected payment enrollment is no longer active'
        USING ERRCODE = '40001';
    END IF;
    score_target_ids := ARRAY[selected_enrollment_id];

  ELSIF shadow_receipt.event_type = 'commerce.purchase.refunded' THEN
    SELECT count(*)::integer
      INTO candidate_count
    FROM app.conversion_commerce_facts AS payment
    WHERE payment.workspace_id = trusted_workspace_id
      AND payment.contact_id = resolved_contact_id
      AND payment.source_system = 'property_predator'
      AND payment.fact_type = 'payment_collected'
      AND payment.external_order_id = event_data->>'checkoutSessionId'
      AND payment.product_key = event_data->>'productKey'
      AND payment.currency = upper(event_data->>'currency');
    IF candidate_count <> 1 THEN
      RAISE EXCEPTION 'refund requires exactly one original canonical payment'
        USING ERRCODE = '23503';
    END IF;
    SELECT payment.id, payment.enrollment_id, payment.currency,
           payment.amount_minor, payment.occurred_at
      INTO selected_payment_fact_id, selected_enrollment_id,
           selected_currency, selected_payment_amount,
           selected_payment_occurred_at
    FROM app.conversion_commerce_facts AS payment
    WHERE payment.workspace_id = trusted_workspace_id
      AND payment.contact_id = resolved_contact_id
      AND payment.source_system = 'property_predator'
      AND payment.fact_type = 'payment_collected'
      AND payment.external_order_id = event_data->>'checkoutSessionId'
      AND payment.product_key = event_data->>'productKey'
      AND payment.currency = upper(event_data->>'currency');
    -- The account-scoped advisory fence above serializes every payment,
    -- refund and cancellation for this subject. A row-locking SELECT would
    -- additionally require UPDATE privilege on this append-only fact table.
    IF (event_data->>'amountMinor')::bigint > selected_payment_amount THEN
      RAISE EXCEPTION 'refund amount exceeds the original canonical payment'
        USING ERRCODE = '23514';
    END IF;
    IF shadow_receipt.occurred_at < selected_payment_occurred_at THEN
      RAISE EXCEPTION 'refund predates its original canonical payment'
        USING ERRCODE = '23514';
    END IF;
    -- The subject fence serializes this contact; the shared row lock pins the
    -- immutable original while cumulative refund evidence is evaluated.
    SELECT coalesce(sum(refund.amount_minor), 0)
      INTO existing_refund_amount
    FROM app.conversion_commerce_facts AS refund
    WHERE refund.workspace_id = trusted_workspace_id
      AND refund.enrollment_id = selected_enrollment_id
      AND refund.contact_id = resolved_contact_id
      AND refund.fact_type = 'refund_issued'
      AND refund.metadata->>'original_payment_fact_id'
            = selected_payment_fact_id::text
      AND refund.source_event_id IS DISTINCT FROM shadow_receipt.event_id::text;
    IF existing_refund_amount + (event_data->>'amountMinor')::bigint
         > selected_payment_amount THEN
      RAISE EXCEPTION 'cumulative refunds exceed the original canonical payment'
        USING ERRCODE = '23514';
    END IF;

    commerce_fact_id := NULL;
    INSERT INTO app.conversion_commerce_facts (
      workspace_id, enrollment_id, contact_id, source_system,
      source_event_id, source_payload_sha256, fact_type, external_order_id,
      product_key, amount_minor, currency, actor_kind, actor_user_id,
      metadata, occurred_at
    ) VALUES (
      trusted_workspace_id, selected_enrollment_id, resolved_contact_id,
      'property_predator', shadow_receipt.event_id::text,
      shadow_receipt.payload_sha256, 'refund_issued',
      event_data->>'checkoutSessionId', event_data->>'productKey',
      (event_data->>'amountMinor')::bigint, selected_currency,
      'webhook', NULL,
      jsonb_strip_nulls(jsonb_build_object(
        'provider', 'stripe',
        'provider_event_id', event_data->>'providerEventId',
        'original_payment_fact_id', selected_payment_fact_id,
        'reason_code', event_data->>'reasonCode'
      )),
      shadow_receipt.occurred_at
    )
    ON CONFLICT (workspace_id, source_system, source_event_id) DO NOTHING
    RETURNING id INTO commerce_fact_id;

    IF commerce_fact_id IS NOT NULL THEN
      commerce_count := commerce_count + 1;
      PERFORM app_private.append_property_predator_journey_outbox(
        trusted_workspace_id, 'conversion_enrollment', selected_enrollment_id,
        'conversion.commerce.fact_recorded',
        'pp:' || shadow_receipt.event_id::text || ':commerce:' || commerce_fact_id::text,
        jsonb_build_object(
          'commerceFactId', commerce_fact_id,
          'enrollmentId', selected_enrollment_id,
          'contactId', resolved_contact_id,
          'factType', 'refund_issued',
          'externalOrderId', event_data->>'checkoutSessionId',
          'productKey', event_data->>'productKey',
          'amountMinor', (event_data->>'amountMinor')::bigint,
          'currency', selected_currency,
          'sourceEventId', shadow_receipt.event_id
        ),
        trusted_request_id, shadow_receipt.correlation_id,
        shadow_receipt.event_id, shadow_receipt.occurred_at
      );
    ELSIF NOT EXISTS (
      SELECT 1 FROM app.conversion_commerce_facts AS fact
      WHERE fact.workspace_id = trusted_workspace_id
        AND fact.enrollment_id = selected_enrollment_id
        AND fact.contact_id = resolved_contact_id
        AND fact.source_system = 'property_predator'
        AND fact.source_event_id = shadow_receipt.event_id::text
        AND fact.source_payload_sha256 = shadow_receipt.payload_sha256
        AND fact.fact_type = 'refund_issued'
        AND fact.external_order_id = event_data->>'checkoutSessionId'
        AND fact.product_key = event_data->>'productKey'
        AND fact.amount_minor = (event_data->>'amountMinor')::bigint
        AND fact.currency = selected_currency
        AND fact.metadata = jsonb_strip_nulls(jsonb_build_object(
          'provider', 'stripe',
          'provider_event_id', event_data->>'providerEventId',
          'original_payment_fact_id', selected_payment_fact_id,
          'reason_code', event_data->>'reasonCode'
        ))
        AND fact.occurred_at = shadow_receipt.occurred_at
    ) THEN
      RAISE EXCEPTION 'existing refund fact conflicts with canonical event'
        USING ERRCODE = '22000';
    END IF;
    IF commerce_fact_id IS NOT NULL THEN
      UPDATE app.conversion_enrollments AS enrollment
         SET last_event_at = greatest(
               coalesce(enrollment.last_event_at, shadow_receipt.occurred_at),
               shadow_receipt.occurred_at
             ),
             row_version = enrollment.row_version + 1,
             updated_at = statement_timestamp()
       WHERE enrollment.workspace_id = trusted_workspace_id
         AND enrollment.id = selected_enrollment_id
         AND enrollment.contact_id = resolved_contact_id
         AND enrollment.status = 'completed';
      IF NOT FOUND THEN
        RAISE EXCEPTION 'refund payment enrollment is not completed'
          USING ERRCODE = '23503';
      END IF;
    END IF;

  ELSIF shadow_receipt.event_type = 'commerce.subscription.cancelled' THEN
    SELECT count(*)::integer
      INTO candidate_count
    FROM app.conversion_commerce_facts AS payment
    WHERE payment.workspace_id = trusted_workspace_id
      AND payment.contact_id = resolved_contact_id
      AND payment.source_system = 'property_predator'
      AND payment.fact_type = 'payment_collected'
      AND payment.product_key = event_data->>'productKey'
      AND payment.metadata->>'subscription_id' = event_data->>'subscriptionId';
    IF candidate_count <> 1 THEN
      RAISE EXCEPTION 'cancellation requires its exact subscription payment'
        USING ERRCODE = '23503';
    END IF;
    SELECT payment.id, payment.enrollment_id, payment.currency, payment.occurred_at
      INTO selected_payment_fact_id, selected_enrollment_id, selected_currency,
           selected_payment_occurred_at
    FROM app.conversion_commerce_facts AS payment
    WHERE payment.workspace_id = trusted_workspace_id
      AND payment.contact_id = resolved_contact_id
      AND payment.source_system = 'property_predator'
      AND payment.fact_type = 'payment_collected'
      AND payment.product_key = event_data->>'productKey'
      AND payment.metadata->>'subscription_id' = event_data->>'subscriptionId';
    -- The account-scoped advisory fence is the concurrency boundary; commerce
    -- facts remain append-only to the projector owner.
    IF (event_data->>'effectiveAt')::timestamptz < selected_payment_occurred_at THEN
      RAISE EXCEPTION 'cancellation predates its exact subscription payment'
        USING ERRCODE = '23514';
    END IF;

    commerce_fact_id := NULL;
    INSERT INTO app.conversion_commerce_facts (
      workspace_id, enrollment_id, contact_id, source_system,
      source_event_id, source_payload_sha256, fact_type, external_order_id,
      product_key, amount_minor, currency, actor_kind, actor_user_id,
      metadata, occurred_at
    ) VALUES (
      trusted_workspace_id, selected_enrollment_id, resolved_contact_id,
      'property_predator', shadow_receipt.event_id::text,
      shadow_receipt.payload_sha256, 'subscription_cancelled',
      event_data->>'subscriptionId', event_data->>'productKey', 0,
      selected_currency, 'webhook', NULL,
      jsonb_build_object(
        'provider', 'stripe',
        'provider_event_id', event_data->>'providerEventId',
        'original_payment_fact_id', selected_payment_fact_id,
        'subscription_id', event_data->>'subscriptionId',
        'effective_at', event_data->>'effectiveAt'
      ),
      (event_data->>'effectiveAt')::timestamptz
    )
    ON CONFLICT (workspace_id, source_system, source_event_id) DO NOTHING
    RETURNING id INTO commerce_fact_id;

    IF commerce_fact_id IS NOT NULL THEN
      commerce_count := commerce_count + 1;
      PERFORM app_private.append_property_predator_journey_outbox(
        trusted_workspace_id, 'conversion_enrollment', selected_enrollment_id,
        'conversion.commerce.fact_recorded',
        'pp:' || shadow_receipt.event_id::text || ':commerce:' || commerce_fact_id::text,
        jsonb_build_object(
          'commerceFactId', commerce_fact_id,
          'enrollmentId', selected_enrollment_id,
          'contactId', resolved_contact_id,
          'factType', 'subscription_cancelled',
          'externalOrderId', event_data->>'subscriptionId',
          'productKey', event_data->>'productKey',
          'amountMinor', 0,
          'currency', selected_currency,
          'sourceEventId', shadow_receipt.event_id
        ),
        trusted_request_id, shadow_receipt.correlation_id,
        shadow_receipt.event_id, shadow_receipt.occurred_at
      );
    ELSIF NOT EXISTS (
      SELECT 1 FROM app.conversion_commerce_facts AS fact
      WHERE fact.workspace_id = trusted_workspace_id
        AND fact.enrollment_id = selected_enrollment_id
        AND fact.contact_id = resolved_contact_id
        AND fact.source_system = 'property_predator'
        AND fact.source_event_id = shadow_receipt.event_id::text
        AND fact.source_payload_sha256 = shadow_receipt.payload_sha256
        AND fact.fact_type = 'subscription_cancelled'
        AND fact.external_order_id = event_data->>'subscriptionId'
        AND fact.product_key = event_data->>'productKey'
        AND fact.amount_minor = 0
        AND fact.currency = selected_currency
        AND fact.metadata = jsonb_build_object(
          'provider', 'stripe',
          'provider_event_id', event_data->>'providerEventId',
          'original_payment_fact_id', selected_payment_fact_id,
          'subscription_id', event_data->>'subscriptionId',
          'effective_at', event_data->>'effectiveAt'
        )
        AND fact.occurred_at = (event_data->>'effectiveAt')::timestamptz
    ) THEN
      RAISE EXCEPTION 'existing cancellation fact conflicts with canonical event'
        USING ERRCODE = '22000';
    END IF;
    IF commerce_fact_id IS NOT NULL THEN
      UPDATE app.conversion_enrollments AS enrollment
         SET last_event_at = greatest(
               coalesce(enrollment.last_event_at, shadow_receipt.occurred_at),
               shadow_receipt.occurred_at
             ),
             row_version = enrollment.row_version + 1,
             updated_at = statement_timestamp()
       WHERE enrollment.workspace_id = trusted_workspace_id
         AND enrollment.id = selected_enrollment_id
         AND enrollment.contact_id = resolved_contact_id
         AND enrollment.status = 'completed';
      IF NOT FOUND THEN
        RAISE EXCEPTION 'cancellation payment enrollment is not completed'
          USING ERRCODE = '23503';
      END IF;
    END IF;
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM jsonb_array_elements(score_definition->'rules') AS rule(value)
    WHERE (
      shadow_receipt.event_type <> 'commerce.purchase.completed'
      AND rule.value->>'kind' = 'event'
      AND rule.value->>'sourceKey' = shadow_receipt.event_type
    ) OR (
      shadow_receipt.event_type = 'commerce.purchase.completed'
      AND rule.value->>'kind' = 'commerce'
      AND rule.value->>'sourceKey' = 'payment_collected'
    )
  ) INTO scoreable_current_event;

  -- Event evidence is contact-scoped and updates every active current v2 route.
  -- Payment evidence is deliberately enrollment-scoped to its one sale route.
  IF scoreable_current_event AND cardinality(score_target_ids) = 0 THEN
    SELECT coalesce(array_agg(enrollment.id ORDER BY journey.slug::text, enrollment.id),
                    ARRAY[]::uuid[])
      INTO score_target_ids
    FROM app.conversion_enrollments AS enrollment
    JOIN app.conversion_journeys AS journey
      ON journey.workspace_id = enrollment.workspace_id
     AND journey.id = enrollment.journey_id
     AND journey.active_version_id = enrollment.journey_version_id
     AND journey.status = 'active'
     AND journey.slug IN (
       'property-predator-self-serve', 'property-predator-agency-laps'
     )
    WHERE enrollment.workspace_id = trusted_workspace_id
      AND enrollment.contact_id = resolved_contact_id
      AND enrollment.score_model_version_id = shared_score_model_version_id
      AND enrollment.status = 'active';
  END IF;

  FOREACH target_enrollment_id IN ARRAY score_target_ids
  LOOP
    SELECT enrollment.id, enrollment.journey_version_id,
           enrollment.score_model_version_id
      INTO score_target
    FROM app.conversion_enrollments AS enrollment
    WHERE enrollment.workspace_id = trusted_workspace_id
      AND enrollment.id = target_enrollment_id
      AND enrollment.contact_id = resolved_contact_id
      AND enrollment.score_model_version_id = shared_score_model_version_id
      AND enrollment.status IN ('active', 'completed')
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'score target enrollment is not pinned to the active v2 model'
        USING ERRCODE = '23503';
    END IF;

    -- Delivery order must never move the newest score backwards in source
    -- time. Contact-scoped event evidence and enrollment-scoped commerce
    -- evidence already projected at a later occurrence establish the current
    -- watermark; a late event is evaluated through that time and stamped with
    -- it, while the immutable current event remains the snapshot causation.
    SELECT greatest(
             shadow_receipt.occurred_at,
             coalesce((
               SELECT max(prior_shadow.occurred_at)
               FROM app_private.external_event_shadow_receipts AS prior_shadow
               WHERE prior_shadow.workspace_id = trusted_workspace_id
                 AND prior_shadow.source = 'property_predator'
                 AND prior_shadow.subject_kind = 'account'
                 AND prior_shadow.subject_id = shadow_receipt.subject_id
                 AND prior_shadow.event_version = 1
                 AND EXISTS (
                   SELECT 1
                   FROM jsonb_array_elements(score_definition->'rules')
                        AS event_rule(value)
                   WHERE event_rule.value->>'kind' = 'event'
                     AND event_rule.value->>'sourceKey' = prior_shadow.event_type
                 )
                 AND EXISTS (
                   SELECT 1
                   FROM app_private.external_event_journey_projection_receipts
                        AS projected
                   WHERE projected.workspace_id = prior_shadow.workspace_id
                     AND projected.source = prior_shadow.source
                     AND projected.event_id = prior_shadow.event_id
                     AND projected.event_type = prior_shadow.event_type
                     AND projected.subject_kind = prior_shadow.subject_kind
                     AND projected.subject_id = prior_shadow.subject_id
                     AND projected.payload_sha256 = prior_shadow.payload_sha256
                     AND projected.disposition = 'projected'
                 )
             ), shadow_receipt.occurred_at),
             coalesce((
               SELECT max(commerce.occurred_at)
               FROM app.conversion_commerce_facts AS commerce
               WHERE commerce.workspace_id = trusted_workspace_id
                 AND commerce.enrollment_id = target_enrollment_id
                 AND commerce.contact_id = resolved_contact_id
                 AND EXISTS (
                   SELECT 1
                   FROM jsonb_array_elements(score_definition->'rules')
                        AS commerce_rule(value)
                   WHERE commerce_rule.value->>'kind' = 'commerce'
                     AND commerce_rule.value->>'sourceKey' = commerce.fact_type
                 )
             ), shadow_receipt.occurred_at)
           )
      INTO score_source_watermark;

    WITH component AS (
      SELECT item.value,
             item.value->>'key' AS component_key,
             item.ordinality
      FROM jsonb_array_elements(score_definition->'components')
           WITH ORDINALITY AS item(value, ordinality)
    ), rule AS (
      SELECT item.value,
             item.value->>'key' AS rule_key,
             item.value->>'componentKey' AS component_key,
             item.value->>'kind' AS rule_kind,
             item.value->>'sourceKey' AS source_key,
             (item.value->>'points')::integer AS points,
             item.value->>'reason' AS reason,
             item.ordinality
      FROM jsonb_array_elements(score_definition->'rules')
           WITH ORDINALITY AS item(value, ordinality)
    ), applied AS (
      SELECT rule.*
      FROM rule
      WHERE (
        rule.rule_kind = 'event'
        AND EXISTS (
          SELECT 1
          FROM app_private.external_event_shadow_receipts AS prior_shadow
          WHERE prior_shadow.workspace_id = trusted_workspace_id
            AND prior_shadow.source = 'property_predator'
            AND prior_shadow.subject_kind = 'account'
            AND prior_shadow.subject_id = shadow_receipt.subject_id
            AND prior_shadow.event_version = 1
            AND prior_shadow.event_type = rule.source_key
            AND prior_shadow.occurred_at <= score_source_watermark
            AND (
              prior_shadow.event_id = shadow_receipt.event_id
              OR EXISTS (
                SELECT 1
                FROM app_private.external_event_journey_projection_receipts AS projected
                WHERE projected.workspace_id = prior_shadow.workspace_id
                  AND projected.source = prior_shadow.source
                  AND projected.event_id = prior_shadow.event_id
                  AND projected.event_type = prior_shadow.event_type
                  AND projected.subject_kind = prior_shadow.subject_kind
                  AND projected.subject_id = prior_shadow.subject_id
                  AND projected.payload_sha256 = prior_shadow.payload_sha256
                  AND projected.disposition = 'projected'
              )
            )
        )
      ) OR (
        rule.rule_kind = 'commerce'
        AND EXISTS (
          SELECT 1
          FROM app.conversion_commerce_facts AS commerce
          WHERE commerce.workspace_id = trusted_workspace_id
            AND commerce.enrollment_id = target_enrollment_id
            AND commerce.contact_id = resolved_contact_id
            AND commerce.fact_type = rule.source_key
        )
      )
    ), component_score AS (
      SELECT component.component_key,
             component.ordinality,
             coalesce(sum(applied.points), 0)::integer AS points
      FROM component
      LEFT JOIN applied ON applied.component_key = component.component_key
      GROUP BY component.component_key, component.ordinality
    )
    SELECT coalesce(jsonb_object_agg(
             component_score.component_key,
             component_score.points
             ORDER BY component_score.ordinality
           ), '{}'::jsonb),
           coalesce(sum(component_score.points), 0)::integer,
           coalesce((
             SELECT jsonb_agg(applied.reason ORDER BY applied.ordinality)
             FROM applied
           ), '[]'::jsonb),
           coalesce((
             SELECT jsonb_agg(applied.rule_key ORDER BY applied.ordinality)
             FROM applied
           ), '[]'::jsonb)
      INTO score_components, score_total, score_reasons, score_rules
    FROM component_score;

    SELECT count(*)::integer, min(band.value->>'key')
      INTO candidate_count, score_band
    FROM jsonb_array_elements(score_definition->'bands') AS band(value)
    WHERE score_total BETWEEN
          (band.value->>'minScore')::integer AND (band.value->>'maxScore')::integer;
    IF candidate_count <> 1 OR score_total NOT BETWEEN 0 AND 100 THEN
      RAISE EXCEPTION 'score result does not resolve to exactly one published band'
        USING ERRCODE = '23514';
    END IF;

    new_fact_id := NULL;
    INSERT INTO app.lead_score_snapshots (
      workspace_id, enrollment_id, contact_id, score_model_version_id,
      total_score, band_key, component_scores, reasons, applied_rules,
      source_system, source_event_id, source_payload_sha256,
      actor_kind, actor_user_id, source_occurred_at
    ) VALUES (
      trusted_workspace_id, target_enrollment_id, resolved_contact_id,
      shared_score_model_version_id, score_total, score_band,
      score_components, score_reasons, score_rules,
      'property_predator', shadow_receipt.event_id::text,
      shadow_receipt.payload_sha256, 'webhook', NULL,
      score_source_watermark
    )
    ON CONFLICT (
      workspace_id, enrollment_id, score_model_version_id,
      source_system, source_event_id
    ) DO NOTHING
    RETURNING id INTO new_fact_id;

    IF new_fact_id IS NOT NULL THEN
      score_count := score_count + 1;
      PERFORM app_private.append_property_predator_journey_outbox(
        trusted_workspace_id, 'conversion_enrollment', target_enrollment_id,
        'conversion.score.updated',
        'pp:' || shadow_receipt.event_id::text || ':score:' || new_fact_id::text,
        jsonb_build_object(
          'scoreSnapshotId', new_fact_id,
          'enrollmentId', target_enrollment_id,
          'contactId', resolved_contact_id,
          'scoreModelVersionId', shared_score_model_version_id,
          'totalScore', score_total,
          'bandKey', score_band,
          'sourceEventId', shadow_receipt.event_id
        ),
        trusted_request_id, shadow_receipt.correlation_id,
        shadow_receipt.event_id, shadow_receipt.occurred_at
      );
    ELSIF NOT EXISTS (
      SELECT 1
      FROM app.lead_score_snapshots AS snapshot
      WHERE snapshot.workspace_id = trusted_workspace_id
        AND snapshot.enrollment_id = target_enrollment_id
        AND snapshot.contact_id = resolved_contact_id
        AND snapshot.score_model_version_id = shared_score_model_version_id
        AND snapshot.total_score = score_total
        AND snapshot.band_key = score_band
        AND snapshot.component_scores = score_components
        AND snapshot.reasons = score_reasons
        AND snapshot.applied_rules = score_rules
        AND snapshot.source_system = 'property_predator'
        AND snapshot.source_event_id = shadow_receipt.event_id::text
        AND snapshot.source_payload_sha256 = shadow_receipt.payload_sha256
        AND snapshot.actor_kind = 'webhook'
        AND snapshot.actor_user_id IS NULL
        AND snapshot.source_occurred_at = score_source_watermark
    ) THEN
      RAISE EXCEPTION 'existing score snapshot conflicts with canonical facts'
        USING ERRCODE = '22000';
    END IF;
  END LOOP;

  INSERT INTO app_private.external_event_journey_projection_receipts (
    workspace_id, source, event_id, event_type, subject_kind, subject_id,
    payload_sha256, request_id, disposition, enrollments_started,
    milestones_achieved, score_snapshots_written, consent_facts_written,
    commerce_facts_written
  ) VALUES (
    trusted_workspace_id, shadow_receipt.source, shadow_receipt.event_id,
    shadow_receipt.event_type, shadow_receipt.subject_kind,
    shadow_receipt.subject_id, shadow_receipt.payload_sha256,
    trusted_request_id, 'projected', started_count, milestone_count,
    score_count, consent_count, commerce_count
  )
  ON CONFLICT (workspace_id, source, event_id) DO NOTHING;
  GET DIAGNOSTICS inserted_count = ROW_COUNT;
  IF inserted_count <> 1 THEN
    SELECT receipt.*
      INTO prior_receipt
    FROM app_private.external_event_journey_projection_receipts AS receipt
    WHERE receipt.workspace_id = trusted_workspace_id
      AND receipt.source = shadow_receipt.source
      AND receipt.event_id = shadow_receipt.event_id;
    IF NOT FOUND
       OR prior_receipt.event_type IS DISTINCT FROM shadow_receipt.event_type
       OR prior_receipt.subject_id IS DISTINCT FROM shadow_receipt.subject_id
       OR prior_receipt.payload_sha256 IS DISTINCT FROM shadow_receipt.payload_sha256
       OR prior_receipt.enrollments_started IS DISTINCT FROM started_count
       OR prior_receipt.milestones_achieved IS DISTINCT FROM milestone_count
       OR prior_receipt.score_snapshots_written IS DISTINCT FROM score_count
       OR prior_receipt.consent_facts_written IS DISTINCT FROM consent_count
       OR prior_receipt.commerce_facts_written IS DISTINCT FROM commerce_count THEN
      RAISE EXCEPTION 'journey projection receipt conflicts with completed facts'
        USING ERRCODE = '22000';
    END IF;
    RETURN QUERY SELECT
      'projected'::text, true, started_count, milestone_count,
      score_count, consent_count, commerce_count;
    RETURN;
  END IF;

  RETURN QUERY SELECT
    'projected'::text, false, started_count, milestone_count,
    score_count, consent_count, commerce_count;
END
$function$;

SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private FROM r72_journey_projector_definer;

REVOKE ALL ON FUNCTION app_private.append_property_predator_journey_outbox(
  uuid, text, uuid, text, text, jsonb, text, uuid, uuid, timestamptz
) FROM PUBLIC, r72_web, r72_public, r72_worker, r72_webhook, r72_readonly,
  r72_crm_command, r72_identity_command, r72_provisioning_command,
  r72_setup_delivery_command, r72_setup_reissue_command,
  r72_external_event_command, r72_external_event_definer,
  r72_growth_projector_definer;
REVOKE ALL ON FUNCTION app_private.property_predator_journey_runtime_ready()
FROM PUBLIC, r72_web, r72_public, r72_worker, r72_webhook, r72_readonly,
  r72_crm_command, r72_identity_command, r72_provisioning_command,
  r72_setup_delivery_command, r72_setup_reissue_command,
  r72_external_event_command, r72_external_event_definer,
  r72_growth_projector_definer;
REVOKE ALL ON FUNCTION app_private.project_property_predator_journey_event(uuid)
FROM PUBLIC, r72_web, r72_public, r72_worker, r72_webhook, r72_readonly,
  r72_crm_command, r72_identity_command, r72_provisioning_command,
  r72_setup_delivery_command, r72_setup_reissue_command,
  r72_external_event_command, r72_external_event_definer,
  r72_growth_projector_definer;

GRANT EXECUTE ON FUNCTION app_private.property_predator_journey_runtime_ready()
  TO r72_webhook;
GRANT EXECUTE ON FUNCTION app_private.project_property_predator_journey_event(uuid)
  TO r72_webhook;

-- Deployment-time proof of ownership, fixed search paths, table blindness and
-- the definer's exact relation whitelist. This also preserves 0015's command
-- role as receipt-only across every table introduced since that migration.
DO $journey_projector_capability_audit$
DECLARE
  projector_oid oid := pg_catalog.to_regprocedure(
    'app_private.project_property_predator_journey_event(uuid)'
  );
  readiness_oid oid := pg_catalog.to_regprocedure(
    'app_private.property_predator_journey_runtime_ready()'
  );
  helper_oid oid := pg_catalog.to_regprocedure(
    'app_private.append_property_predator_journey_outbox(uuid,text,uuid,text,text,jsonb,text,uuid,uuid,timestamptz)'
  );
  recorder_oid oid := pg_catalog.to_regprocedure(
    'app_private.record_external_event_shadow_receipt(uuid,text,uuid,text,smallint,timestamptz,uuid,text,uuid,bytea,jsonb,text,timestamptz)'
  );
  unexpected_object text;
BEGIN
  IF projector_oid IS NULL OR readiness_oid IS NULL OR helper_oid IS NULL
     OR recorder_oid IS NULL THEN
    RAISE EXCEPTION 'Property Predator journey runtime functions are missing';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS procedure
    JOIN pg_catalog.pg_roles AS owner_role ON owner_role.oid = procedure.proowner
    WHERE procedure.oid IN (projector_oid, readiness_oid)
      AND (
        owner_role.rolname <> 'r72_journey_projector_definer'
        OR NOT procedure.prosecdef
        OR procedure.proconfig IS DISTINCT FROM
             ARRAY['search_path=pg_catalog']::text[]
      )
  ) OR (
    SELECT count(*) FROM pg_catalog.pg_proc AS procedure
    WHERE procedure.oid IN (projector_oid, readiness_oid)
  ) <> 2 THEN
    RAISE EXCEPTION 'Journey projector ownership or SECURITY DEFINER settings are unsafe';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS procedure
    JOIN pg_catalog.pg_roles AS owner_role ON owner_role.oid = procedure.proowner
    WHERE procedure.oid = helper_oid
      AND owner_role.rolname = 'r72_journey_projector_definer'
      AND NOT procedure.prosecdef
      AND procedure.proconfig = ARRAY['search_path=pg_catalog']::text[]
  ) THEN
    RAISE EXCEPTION 'Journey outbox helper ownership is unsafe';
  END IF;

  IF NOT pg_catalog.has_function_privilege('r72_webhook', projector_oid, 'EXECUTE')
     OR NOT pg_catalog.has_function_privilege('r72_webhook', readiness_oid, 'EXECUTE')
     OR pg_catalog.has_function_privilege('r72_webhook', helper_oid, 'EXECUTE')
     OR pg_catalog.has_function_privilege('r72_webhook', recorder_oid, 'EXECUTE')
     OR NOT pg_catalog.has_function_privilege(
          'r72_external_event_command', recorder_oid, 'EXECUTE'
        )
     OR pg_catalog.has_function_privilege(
          'r72_external_event_command', projector_oid, 'EXECUTE'
        )
     OR pg_catalog.has_function_privilege(
          'r72_external_event_command', readiness_oid, 'EXECUTE'
        ) THEN
    RAISE EXCEPTION 'Journey runtime function grants are unsafe';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS procedure
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      coalesce(
        procedure.proacl,
        pg_catalog.acldefault('f', procedure.proowner)
      )
    ) AS privilege
    LEFT JOIN pg_catalog.pg_roles AS grantee_role
      ON grantee_role.oid = privilege.grantee
    WHERE procedure.oid = recorder_oid
      AND privilege.privilege_type = 'EXECUTE'
      AND (
        privilege.grantee = 0
        OR grantee_role.rolname NOT IN (
          'r72_external_event_definer', 'r72_external_event_command'
        )
      )
  ) THEN
    RAISE EXCEPTION 'External-event recorder has a stale direct EXECUTE grant';
  END IF;

  SELECT format('%I.%I', namespace.nspname, relation.relname)
    INTO unexpected_object
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
  WHERE (namespace.nspname, relation.relname) IN (
      ('app', 'contacts'),
      ('app', 'contact_points'),
      ('app', 'lead_score_models'),
      ('app', 'lead_score_model_versions'),
      ('app', 'conversion_journeys'),
      ('app', 'conversion_journey_versions'),
      ('app', 'conversion_journey_milestones'),
      ('app', 'conversion_journey_triggers'),
      ('app', 'conversion_enrollments'),
      ('app', 'communication_consent_events'),
      ('app', 'communication_suppression_events'),
      ('app', 'conversion_commerce_facts'),
      ('app', 'conversion_milestone_facts'),
      ('app', 'lead_score_snapshots'),
      ('app', 'contact_source_identities'),
      ('app', 'outbox_events'),
      ('app_private', 'external_event_shadow_receipts'),
      ('app_private', 'external_event_journey_projection_receipts')
    )
    AND (
      pg_catalog.has_table_privilege('r72_webhook', relation.oid, 'SELECT')
      OR pg_catalog.has_table_privilege('r72_webhook', relation.oid, 'INSERT')
      OR pg_catalog.has_table_privilege('r72_webhook', relation.oid, 'UPDATE')
      OR pg_catalog.has_table_privilege('r72_webhook', relation.oid, 'DELETE')
      OR pg_catalog.has_table_privilege('r72_webhook', relation.oid, 'TRUNCATE')
      OR pg_catalog.has_table_privilege('r72_webhook', relation.oid, 'REFERENCES')
      OR pg_catalog.has_table_privilege('r72_webhook', relation.oid, 'TRIGGER')
      OR pg_catalog.has_any_column_privilege('r72_webhook', relation.oid, 'SELECT')
      OR pg_catalog.has_any_column_privilege('r72_webhook', relation.oid, 'INSERT')
      OR pg_catalog.has_any_column_privilege('r72_webhook', relation.oid, 'UPDATE')
      OR pg_catalog.has_any_column_privilege('r72_webhook', relation.oid, 'REFERENCES')
    )
  LIMIT 1;
  IF unexpected_object IS NOT NULL THEN
    RAISE EXCEPTION 'Webhook unexpectedly has direct journey runtime privilege on %',
      unexpected_object;
  END IF;

  SELECT format('%I.%I', namespace.nspname, relation.relname)
    INTO unexpected_object
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
  WHERE namespace.nspname IN ('app', 'app_private')
    AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
    AND (
      pg_catalog.has_table_privilege(
        'r72_external_event_command', relation.oid, 'SELECT'
      )
      OR pg_catalog.has_table_privilege(
        'r72_external_event_command', relation.oid, 'INSERT'
      )
      OR pg_catalog.has_table_privilege(
        'r72_external_event_command', relation.oid, 'UPDATE'
      )
      OR pg_catalog.has_table_privilege(
        'r72_external_event_command', relation.oid, 'DELETE'
      )
      OR pg_catalog.has_any_column_privilege(
        'r72_external_event_command', relation.oid, 'SELECT'
      )
      OR pg_catalog.has_any_column_privilege(
        'r72_external_event_command', relation.oid, 'INSERT'
      )
      OR pg_catalog.has_any_column_privilege(
        'r72_external_event_command', relation.oid, 'UPDATE'
      )
    )
  LIMIT 1;
  IF unexpected_object IS NOT NULL THEN
    RAISE EXCEPTION 'External-event command unexpectedly has table privilege on %',
      unexpected_object;
  END IF;

  IF NOT pg_catalog.has_schema_privilege(
       'r72_journey_projector_definer', 'app', 'USAGE'
     )
     OR NOT pg_catalog.has_schema_privilege(
       'r72_journey_projector_definer', 'app_private', 'USAGE'
     )
     OR pg_catalog.has_schema_privilege(
       'r72_journey_projector_definer', 'app', 'CREATE'
     )
     OR pg_catalog.has_schema_privilege(
       'r72_journey_projector_definer', 'app_private', 'CREATE'
     ) THEN
    RAISE EXCEPTION 'Journey projector schema capabilities are unsafe';
  END IF;

  SELECT format('%I.%I', namespace.nspname, relation.relname)
    INTO unexpected_object
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
  WHERE namespace.nspname IN ('app', 'app_private')
    AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
    AND relation.oid NOT IN (
      'app_private.external_event_shadow_receipts'::regclass,
      'app_private.external_event_journey_projection_receipts'::regclass,
      'app.contacts'::regclass,
      'app.contact_points'::regclass,
      'app.contact_source_identities'::regclass,
      'app.lead_score_models'::regclass,
      'app.lead_score_model_versions'::regclass,
      'app.conversion_journeys'::regclass,
      'app.conversion_journey_versions'::regclass,
      'app.conversion_journey_milestones'::regclass,
      'app.conversion_journey_triggers'::regclass,
      'app.conversion_enrollments'::regclass,
      'app.communication_consent_events'::regclass,
      'app.conversion_commerce_facts'::regclass,
      'app.conversion_milestone_facts'::regclass,
      'app.lead_score_snapshots'::regclass,
      'app.outbox_events'::regclass
    )
    AND (
      pg_catalog.has_table_privilege(
        'r72_journey_projector_definer', relation.oid, 'SELECT'
      )
      OR pg_catalog.has_table_privilege(
        'r72_journey_projector_definer', relation.oid, 'INSERT'
      )
      OR pg_catalog.has_table_privilege(
        'r72_journey_projector_definer', relation.oid, 'UPDATE'
      )
      OR pg_catalog.has_table_privilege(
        'r72_journey_projector_definer', relation.oid, 'DELETE'
      )
      OR pg_catalog.has_any_column_privilege(
        'r72_journey_projector_definer', relation.oid, 'UPDATE'
      )
    )
  LIMIT 1;
  IF unexpected_object IS NOT NULL THEN
    RAISE EXCEPTION 'Journey projector definer unexpectedly has privilege on %',
      unexpected_object;
  END IF;

  IF pg_catalog.has_table_privilege(
       'r72_journey_projector_definer',
       'app_private.external_event_shadow_receipts', 'INSERT'
     )
     OR pg_catalog.has_table_privilege(
       'r72_journey_projector_definer',
       'app_private.external_event_shadow_receipts', 'UPDATE'
     )
     OR pg_catalog.has_table_privilege(
       'r72_journey_projector_definer',
       'app_private.external_event_shadow_receipts', 'DELETE'
     )
     OR pg_catalog.has_table_privilege(
       'r72_journey_projector_definer',
       'app_private.external_event_journey_projection_receipts', 'UPDATE'
     )
     OR pg_catalog.has_table_privilege(
       'r72_journey_projector_definer',
       'app_private.external_event_journey_projection_receipts', 'DELETE'
     )
     OR NOT pg_catalog.has_column_privilege(
       'r72_journey_projector_definer', 'app.conversion_enrollments',
       'current_milestone_id', 'UPDATE'
     )
     OR pg_catalog.has_column_privilege(
       'r72_journey_projector_definer', 'app.conversion_enrollments',
       'contact_id', 'UPDATE'
     ) THEN
    RAISE EXCEPTION 'Journey projector table capability map is unsafe';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM app_private.workspace_table_registry AS registry
    WHERE registry.schema_name = 'app_private'
      AND registry.table_name = 'external_event_journey_projection_receipts'
      AND registry.workspace_column = 'workspace_id'
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid =
          'app_private.external_event_journey_projection_receipts'::regclass
      AND relation.relrowsecurity
      AND relation.relforcerowsecurity
  ) THEN
    RAISE EXCEPTION 'Journey receipt registry or forced RLS is incomplete';
  END IF;
END
$journey_projector_capability_audit$;
