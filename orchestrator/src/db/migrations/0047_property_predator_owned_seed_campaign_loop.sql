-- Table-blind staging boundary for the first owned-seed campaign loop.
--
-- The caller chooses an already-created message version and an idempotency
-- command key. Every delivery-critical value (provider, current approval,
-- exact office mailbox, consent, suppression, owned-seed attestation and
-- operator caps) is resolved again inside PostgreSQL. This migration stages
-- only the existing 0043 hash-only Mailgun job; it cannot perform a network
-- call and it creates no second delivery/operation model.

DO $roles$
DECLARE
  unsafe_membership text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles
    WHERE rolname = 'r72_owned_seed_campaign_command'
  ) THEN
    CREATE ROLE r72_owned_seed_campaign_command LOGIN NOINHERIT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles
    WHERE rolname = 'r72_owned_seed_campaign_command'
      AND rolcanlogin AND NOT rolinherit AND NOT rolsuper
      AND NOT rolcreatedb AND NOT rolcreaterole
      AND NOT rolreplication AND NOT rolbypassrls
  ) THEN
    RAISE EXCEPTION 'Unsafe owned-seed campaign command role attributes';
  END IF;

  REVOKE r72_owner, r72_security_definer, r72_onboarding_definer,
    r72_setup_delivery_definer, r72_commerce_definer,
    r72_external_event_definer, r72_provider_operation_definer,
    r72_mailgun_webhook_definer, r72_mailgun_worker_definer
  FROM r72_owned_seed_campaign_command;

  SELECT parent.rolname INTO unsafe_membership
  FROM pg_catalog.pg_auth_members AS membership
  JOIN pg_catalog.pg_roles AS parent ON parent.oid = membership.roleid
  JOIN pg_catalog.pg_roles AS member ON member.oid = membership.member
  WHERE member.rolname = 'r72_owned_seed_campaign_command'
  LIMIT 1;
  IF unsafe_membership IS NOT NULL THEN
    RAISE EXCEPTION 'Unsafe owned-seed campaign membership: %', unsafe_membership;
  END IF;
END
$roles$;

SET LOCAL ROLE r72_owner;

REVOKE ALL ON SCHEMA app, app_private
  FROM r72_owned_seed_campaign_command;
REVOKE ALL ON ALL TABLES IN SCHEMA app
  FROM r72_owned_seed_campaign_command;
REVOKE ALL ON ALL TABLES IN SCHEMA app_private
  FROM r72_owned_seed_campaign_command;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA app_private
  FROM r72_owned_seed_campaign_command;
REVOKE CREATE ON SCHEMA public
  FROM r72_owned_seed_campaign_command;

-- The existing Mailgun definer may see only the authenticated membership row
-- used to authorize this staging command. Its worker calls run with no user id
-- and therefore gain no membership visibility.
DROP POLICY IF EXISTS workspace_memberships_owned_seed_campaign_select
  ON app.workspace_memberships;
CREATE POLICY workspace_memberships_owned_seed_campaign_select
  ON app.workspace_memberships FOR SELECT TO r72_mailgun_worker_definer
  USING (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND user_id = nullif(current_setting('app.user_id', true), '')::uuid
    AND status = 'active' AND role IN ('owner', 'admin')
  );
GRANT SELECT ON app.workspace_memberships TO r72_mailgun_worker_definer;

-- Final staging independently revalidates the immutable company-content
-- source and its short-lived proof. These policies expose only the active
-- owner/admin workspace already authenticated by the command.
CREATE POLICY company_content_versions_owned_seed_campaign_select
  ON app.company_content_versions FOR SELECT TO r72_mailgun_worker_definer
  USING (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM app.workspace_memberships AS membership
      WHERE membership.workspace_id
          = nullif(current_setting('app.workspace_id', true), '')::uuid
        AND membership.user_id = nullif(current_setting('app.user_id', true), '')::uuid
        AND membership.status = 'active' AND membership.role IN ('owner', 'admin')
    )
  );
CREATE POLICY company_content_source_attestations_owned_seed_campaign_select
  ON app.company_content_source_attestations FOR SELECT TO r72_mailgun_worker_definer
  USING (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM app.workspace_memberships AS membership
      WHERE membership.workspace_id
          = nullif(current_setting('app.workspace_id', true), '')::uuid
        AND membership.user_id = nullif(current_setting('app.user_id', true), '')::uuid
        AND membership.status = 'active' AND membership.role IN ('owner', 'admin')
    )
  );
CREATE POLICY company_content_approval_requests_owned_seed_campaign_select
  ON app.company_content_approval_requests FOR SELECT TO r72_mailgun_worker_definer
  USING (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM app.workspace_memberships AS membership
      WHERE membership.workspace_id
          = nullif(current_setting('app.workspace_id', true), '')::uuid
        AND membership.user_id = nullif(current_setting('app.user_id', true), '')::uuid
        AND membership.status = 'active' AND membership.role IN ('owner', 'admin')
    )
  );
CREATE POLICY company_content_approval_decisions_owned_seed_campaign_select
  ON app.company_content_approval_decisions FOR SELECT TO r72_mailgun_worker_definer
  USING (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM app.workspace_memberships AS membership
      WHERE membership.workspace_id
          = nullif(current_setting('app.workspace_id', true), '')::uuid
        AND membership.user_id = nullif(current_setting('app.user_id', true), '')::uuid
        AND membership.status = 'active' AND membership.role IN ('owner', 'admin')
    )
  );
GRANT SELECT ON app.company_content_versions,
  app.company_content_source_attestations,
  app.company_content_approval_requests,
  app.company_content_approval_decisions
  TO r72_mailgun_worker_definer;

GRANT CREATE ON SCHEMA app_private TO r72_mailgun_worker_definer;
SET LOCAL ROLE r72_mailgun_worker_definer;

CREATE FUNCTION app_private.stage_property_predator_owned_seed_campaign(
  p_workspace_id uuid,
  p_message_version_id uuid,
  p_run_id uuid,
  p_command_key text
) RETURNS TABLE (
  disposition text,
  reason text,
  job_id uuid,
  provider_connection_id uuid,
  message_version_id uuid,
  request_sha256 bytea,
  estimated_spend_usd_micros bigint,
  delivery_state text
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
  selected_connection_id uuid;
  selected_cost bigint;
  selected_run_spend_cap bigint;
  selected_month_spend_cap bigint;
  selected_message_id uuid;
  selected_approval_request_id uuid;
  selected_approval_decision_id uuid;
  selected_approved_content_sha256 bytea;
  selected_source_content_item_id uuid;
  selected_source_content_version_id uuid;
  selected_source_content_sha256 bytea;
  selected_source_attestation_id uuid;
  selected_contact_id uuid;
  selected_contact_point_id uuid;
  selected_endpoint_identity_sha256 bytea;
  selected_consent_event_id uuid;
  selected_email_sha256 bytea := public.digest(
    'office@propertypredator.com', 'sha256'
  );
  selected_idempotency_sha256 bytea;
  selected_request_sha256 bytea;
  existing_job app.property_predator_mailgun_jobs%ROWTYPE;
  selected_job_id uuid;
  run_reserved_messages integer := 0;
  run_reserved_spend bigint := 0;
  month_reserved_messages integer := 0;
  month_reserved_spend bigint := 0;
  run_staged_messages integer := 0;
  run_staged_spend bigint := 0;
  month_staged_messages integer := 0;
  month_staged_spend bigint := 0;
BEGIN
  IF session_user <> 'r72_owned_seed_campaign_command'
     OR current_setting('app.workspace_id', true)
       IS DISTINCT FROM p_workspace_id::text
     OR current_setting('app.actor_kind', true) IS DISTINCT FROM 'user'
     OR coalesce(current_setting('app.user_id', true), '')
       !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR coalesce(current_setting('app.request_id', true), '') = '' THEN
    RAISE EXCEPTION 'Owned-seed campaign command context denied'
      USING ERRCODE = '42501';
  END IF;
  IF p_workspace_id IS NULL OR p_message_version_id IS NULL OR p_run_id IS NULL
     OR p_command_key IS NULL OR p_command_key <> btrim(p_command_key)
     OR length(p_command_key) NOT BETWEEN 1 AND 128
     OR p_command_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' THEN
    RAISE EXCEPTION 'Owned-seed campaign command input is invalid'
      USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM app.workspace_memberships AS membership
    WHERE membership.workspace_id = p_workspace_id
      AND membership.user_id = current_setting('app.user_id')::uuid
      AND membership.status = 'active'
      AND membership.role IN ('owner', 'admin')
  ) THEN
    RAISE EXCEPTION 'Owned-seed campaign command requires an active owner or admin'
      USING ERRCODE = '42501';
  END IF;

  -- One workspace lock serializes wrapper-level idempotency and ensures a
  -- current-evidence read cannot race another staging command in this seam.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      p_workspace_id::text || ':property-predator-owned-seed-campaign', 0
    )
  );
  selected_idempotency_sha256 := public.digest(
    pg_catalog.convert_to(
      'property-predator-owned-seed-campaign:v1:' || p_command_key,
      'UTF8'
    ),
    'sha256'
  );

  -- An already-staged immutable intent is authoritative replay truth. Resolve
  -- it before mutable provider, source, consent or suppression gates so a lost
  -- response cannot be rewritten as "blocked" after those gates later change.
  SELECT job.* INTO existing_job
  FROM app.property_predator_mailgun_jobs AS job
  WHERE job.workspace_id = p_workspace_id
    AND job.idempotency_key_sha256 = selected_idempotency_sha256;
  IF FOUND THEN
    IF existing_job.message_version_id IS DISTINCT FROM p_message_version_id
       OR existing_job.run_id IS DISTINCT FROM p_run_id
       OR existing_job.email_sha256 IS DISTINCT FROM selected_email_sha256 THEN
      RETURN QUERY SELECT 'blocked', 'idempotency_conflict', existing_job.id,
        existing_job.provider_connection_id, existing_job.message_version_id,
        existing_job.request_sha256,
        existing_job.estimated_spend_usd_micros, existing_job.state;
    ELSE
      RETURN QUERY SELECT 'replayed', NULL::text, existing_job.id,
        existing_job.provider_connection_id, existing_job.message_version_id,
        existing_job.request_sha256,
        existing_job.estimated_spend_usd_micros, existing_job.state;
    END IF;
    RETURN;
  END IF;

  -- A different command key must not stage the same exact owned-seed message
  -- twice. The original job remains the bounded truth even across a new run.
  SELECT job.* INTO existing_job
  FROM app.property_predator_mailgun_jobs AS job
  WHERE job.workspace_id = p_workspace_id
    AND job.message_version_id = p_message_version_id
    AND job.email_sha256 = selected_email_sha256
  ORDER BY job.created_at, job.id
  LIMIT 1;
  IF FOUND THEN
    RETURN QUERY SELECT 'replayed', NULL::text, existing_job.id,
      existing_job.provider_connection_id, existing_job.message_version_id,
      existing_job.request_sha256, existing_job.estimated_spend_usd_micros,
      existing_job.state;
    RETURN;
  END IF;

  -- A live Mailgun connection and the deliberately tiny 1/run, 3/month
  -- operator policy must both be current before a job can even be staged.
  SELECT connection.id, control.estimated_recipient_cost_usd_micros::bigint,
         control.run_spend_cap_usd_micros,
         control.monthly_spend_cap_usd_micros
    INTO selected_connection_id, selected_cost,
         selected_run_spend_cap, selected_month_spend_cap
  FROM app.provider_connections AS connection
  JOIN app.property_predator_email_pilot_control_events AS control
    ON control.workspace_id = connection.workspace_id
   AND control.provider_connection_id = connection.id
   AND control.id = (
     SELECT current_control.id
     FROM app.property_predator_email_pilot_control_events AS current_control
     WHERE current_control.workspace_id = connection.workspace_id
       AND current_control.provider_connection_id = connection.id
     ORDER BY current_control.occurred_at DESC,
       current_control.recorded_at DESC, current_control.id DESC
     LIMIT 1
   )
  WHERE connection.workspace_id = p_workspace_id
    AND connection.provider_id = 'mailgun_eu'
    AND connection.provider_kind = 'email'
    AND connection.environment = 'live'
    AND connection.status = 'active'
    AND control.provider_effects_enabled
    AND control.email_delivery_enabled
    AND NOT control.emergency_paused
    AND control.max_recipients = 1
    AND control.run_message_cap = 1
    AND control.monthly_message_cap = 3
    AND control.estimated_recipient_cost_usd_micros > 0
    AND control.run_spend_cap_usd_micros
      >= control.estimated_recipient_cost_usd_micros
    AND control.monthly_spend_cap_usd_micros
      >= control.estimated_recipient_cost_usd_micros::bigint * 3;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'blocked', 'provider_policy_not_ready', NULL::uuid,
      NULL::uuid, p_message_version_id, NULL::bytea, NULL::bigint,
      'blocked'::text;
    RETURN;
  END IF;

  -- Resolve the source item first, then serialize with the 0021 company-content
  -- lock. The second query rechecks the entire chain after the lock, so a new
  -- version, approval or refreshed/expired attestation cannot race staging.
  SELECT source_version.content_item_id INTO selected_source_content_item_id
  FROM app.message_versions AS version
  JOIN app.company_content_versions AS source_version
    ON source_version.workspace_id = version.workspace_id
   AND version.source_content_version_ref
     = 'app.company_content_versions:' || source_version.id::text
   AND version.source_content_sha256 = source_version.content_sha256
  WHERE version.workspace_id = p_workspace_id
    AND version.id = p_message_version_id;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'blocked', 'source_evidence_not_current', NULL::uuid,
      selected_connection_id, p_message_version_id, NULL::bytea, selected_cost,
      'blocked'::text;
    RETURN;
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'company-content:' || p_workspace_id::text || ':'
      || selected_source_content_item_id::text,
    7200021
  ));

  SELECT source_version.id, source_version.content_sha256,
         source_attestation.id
    INTO selected_source_content_version_id,
         selected_source_content_sha256, selected_source_attestation_id
  FROM app.message_versions AS version
  JOIN app.messages AS message
    ON message.workspace_id = version.workspace_id
   AND message.id = version.message_id
   AND message.current_version_id = version.id
   AND message.current_body_sha256 = version.body_sha256
  JOIN app.conversations AS conversation
    ON conversation.workspace_id = message.workspace_id
   AND conversation.id = message.conversation_id
   AND conversation.subject IS NOT NULL
  JOIN app.company_content_versions AS source_version
    ON source_version.workspace_id = version.workspace_id
   AND version.source_content_version_ref
     = 'app.company_content_versions:' || source_version.id::text
   AND version.source_content_sha256 = source_version.content_sha256
   AND source_version.content_kind = 'email'
   AND source_version.content_mime_type
     = 'application/vnd.propertypredator.email-draft+json'
   AND source_version.content_sha256 = public.digest(
     pg_catalog.convert_to(source_version.content_body, 'UTF8'), 'sha256'
   )
   AND source_version.content_body = '{"bodyText":'
     || pg_catalog.to_json(version.body_text)::text
     || ',"schema":"propertypredator.email-draft/v1","subject":'
     || pg_catalog.to_json(conversation.subject)::text || '}'
  JOIN app.company_content_approval_requests AS source_request
    ON source_request.workspace_id = source_version.workspace_id
   AND source_request.content_item_id = source_version.content_item_id
   AND source_request.content_version_id = source_version.id
   AND source_request.content_sha256 = source_version.content_sha256
   AND source_request.id = (
     SELECT latest.id
     FROM app.company_content_approval_requests AS latest
     WHERE latest.workspace_id = source_version.workspace_id
       AND latest.content_item_id = source_version.content_item_id
       AND latest.content_version_id = source_version.id
     ORDER BY latest.request_number DESC, latest.id DESC LIMIT 1
   )
  JOIN app.company_content_approval_decisions AS source_decision
    ON source_decision.workspace_id = source_request.workspace_id
   AND source_decision.approval_request_id = source_request.id
   AND source_decision.content_version_id = source_version.id
   AND source_decision.content_sha256 = source_version.content_sha256
   AND source_decision.decision = 'approved'
   AND version.source_content_approval_ref
     = 'app.company_content_approval_decisions:' || source_decision.id::text
  JOIN app.company_content_source_attestations AS source_attestation
    ON source_attestation.workspace_id = source_version.workspace_id
   AND source_attestation.content_item_id = source_version.content_item_id
   AND source_attestation.content_version_id = source_version.id
   AND source_attestation.source_system = source_version.source_system
   AND source_attestation.source_item_id = source_version.source_item_id
   AND source_attestation.source_version = source_version.source_version
   AND source_attestation.content_sha256 = source_version.content_sha256
   AND source_attestation.blob_sha256 = source_version.blob_sha256
   AND source_attestation.brand_sha256 = source_version.brand_sha256
   AND source_attestation.id = (
     SELECT latest.id
     FROM app.company_content_source_attestations AS latest
     WHERE latest.workspace_id = source_version.workspace_id
       AND latest.content_item_id = source_version.content_item_id
       AND latest.content_version_id = source_version.id
     ORDER BY latest.checked_at DESC, latest.id DESC LIMIT 1
   )
   AND source_attestation.checked_at <= statement_timestamp()
   AND source_attestation.expires_at > statement_timestamp()
  WHERE version.workspace_id = p_workspace_id
    AND version.id = p_message_version_id
    AND version.channel = 'email' AND version.environment = 'live'
    AND NOT EXISTS (
      SELECT 1 FROM app.company_content_versions AS newer
      WHERE newer.workspace_id = source_version.workspace_id
        AND newer.content_item_id = source_version.content_item_id
        AND newer.version_number > source_version.version_number
    );
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'blocked', 'source_evidence_not_current', NULL::uuid,
      selected_connection_id, p_message_version_id, NULL::bytea, selected_cost,
      'blocked'::text;
    RETURN;
  END IF;

  -- The caller supplies no approval, contact, consent, recipient, provider or
  -- cap identifiers. They are all resolved from current server-side evidence.
  SELECT message.id, request.id, decision.id,
         pilot_approval.approved_content_sha256,
         message.contact_id, point.id,
         public.digest(
           point.kind || pg_catalog.chr(31) || point.value
             || pg_catalog.chr(31) || point.normalized_value,
           'sha256'
         )
    INTO selected_message_id, selected_approval_request_id,
         selected_approval_decision_id, selected_approved_content_sha256,
         selected_contact_id, selected_contact_point_id,
         selected_endpoint_identity_sha256
  FROM app.message_versions AS version
  JOIN app.messages AS message
    ON message.workspace_id = version.workspace_id
   AND message.id = version.message_id
   AND message.current_version_id = version.id
   AND message.current_body_sha256 = version.body_sha256
   AND message.lifecycle = 'approved'
   AND message.direction = 'outbound'
  JOIN app.conversations AS conversation
    ON conversation.workspace_id = message.workspace_id
   AND conversation.id = message.conversation_id
   AND conversation.contact_id = message.contact_id
   AND conversation.channel = 'email'
   AND conversation.environment = 'live'
   AND conversation.subject IS NOT NULL
  JOIN app.inboxes AS inbox
    ON inbox.workspace_id = conversation.workspace_id
   AND inbox.id = conversation.inbox_id
   AND inbox.provider_connection_id = selected_connection_id
   AND inbox.channel = 'email'
   AND inbox.environment = 'live'
   AND inbox.status = 'active'
  JOIN app.contact_points AS point
    ON point.workspace_id = message.workspace_id
   AND point.id = message.contact_point_id
   AND point.contact_id = message.contact_id
   AND point.kind = 'email'
   AND point.deleted_at IS NULL
   AND point.is_verified
   AND point.dedupe_state = 'normal'
   AND pg_catalog.lower(point.normalized_value)
     = 'office@propertypredator.com'
   AND public.digest(pg_catalog.lower(point.normalized_value), 'sha256')
     = selected_email_sha256
  JOIN app.message_approval_decisions AS decision
    ON decision.workspace_id = version.workspace_id
   AND decision.message_id = version.message_id
   AND decision.message_version_id = version.id
   AND decision.body_sha256 = version.body_sha256
   AND decision.decision = 'approved'
   AND decision.id = (
     SELECT current_decision.id
     FROM app.message_approval_decisions AS current_decision
     WHERE current_decision.workspace_id = version.workspace_id
       AND current_decision.message_id = version.message_id
       AND current_decision.message_version_id = version.id
     ORDER BY current_decision.decided_at DESC, current_decision.id DESC
     LIMIT 1
   )
  JOIN app.message_approval_requests AS request
    ON request.workspace_id = decision.workspace_id
   AND request.id = decision.approval_request_id
   AND request.message_id = decision.message_id
   AND request.message_version_id = decision.message_version_id
   AND request.body_sha256 = decision.body_sha256
  JOIN app.property_predator_email_pilot_approved_content AS pilot_approval
    ON pilot_approval.workspace_id = decision.workspace_id
   AND pilot_approval.message_version_id = decision.message_version_id
   AND pilot_approval.approval_request_id = decision.approval_request_id
   AND pilot_approval.approval_decision_id = decision.id
   AND pilot_approval.body_sha256 = decision.body_sha256
   AND pilot_approval.subject_sha256
     = public.digest(conversation.subject, 'sha256')
  WHERE version.workspace_id = p_workspace_id
    AND version.id = p_message_version_id
    AND version.channel = 'email'
    AND version.environment = 'live';
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'blocked', 'approval_or_recipient_not_current',
      NULL::uuid, selected_connection_id, p_message_version_id,
      NULL::bytea, selected_cost, 'blocked'::text;
    RETURN;
  END IF;

  SELECT consent.id INTO selected_consent_event_id
  FROM app.communication_consent_events AS consent
  WHERE consent.workspace_id = p_workspace_id
    AND consent.contact_id = selected_contact_id
    AND consent.contact_point_id = selected_contact_point_id
    AND consent.channel = 'email'
    AND consent.purpose = 'marketing'
    AND consent.state = 'granted'
    AND consent.endpoint_identity_sha256 = selected_endpoint_identity_sha256
    AND consent.id = (
      SELECT current_consent.id
      FROM app.communication_consent_events AS current_consent
      WHERE current_consent.workspace_id = consent.workspace_id
        AND current_consent.contact_id = consent.contact_id
        AND current_consent.contact_point_id = consent.contact_point_id
        AND current_consent.channel = 'email'
        AND current_consent.purpose = 'marketing'
      ORDER BY current_consent.occurred_at DESC,
        current_consent.recorded_at DESC, current_consent.id DESC
      LIMIT 1
    )
    AND EXISTS (
      SELECT 1 FROM app.property_predator_email_pilot_seed_events AS seed
      WHERE seed.workspace_id = consent.workspace_id
        AND seed.email_sha256 = selected_email_sha256
        AND seed.state = 'owned'
        AND seed.id = (
          SELECT current_seed.id
          FROM app.property_predator_email_pilot_seed_events AS current_seed
          WHERE current_seed.workspace_id = seed.workspace_id
            AND current_seed.email_sha256 = seed.email_sha256
          ORDER BY current_seed.occurred_at DESC,
            current_seed.recorded_at DESC, current_seed.id DESC
          LIMIT 1
        )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM app.communication_suppression_events AS suppression
      WHERE suppression.workspace_id = consent.workspace_id
        AND suppression.contact_id = consent.contact_id
        AND suppression.contact_point_id = consent.contact_point_id
        AND suppression.channel = 'email'
        AND (suppression.purpose IS NULL OR suppression.purpose = 'marketing')
        AND suppression.endpoint_identity_sha256
          = consent.endpoint_identity_sha256
        AND suppression.state = 'suppressed'
        AND suppression.id = (
          SELECT current_suppression.id
          FROM app.communication_suppression_events AS current_suppression
          WHERE current_suppression.workspace_id = suppression.workspace_id
            AND current_suppression.contact_id = suppression.contact_id
            AND current_suppression.contact_point_id
              = suppression.contact_point_id
            AND current_suppression.channel = suppression.channel
            AND current_suppression.purpose
              IS NOT DISTINCT FROM suppression.purpose
          ORDER BY current_suppression.occurred_at DESC,
            current_suppression.recorded_at DESC, current_suppression.id DESC
          LIMIT 1
        )
    );
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'blocked', 'recipient_evidence_not_current',
      NULL::uuid, selected_connection_id, p_message_version_id,
      NULL::bytea, selected_cost, 'blocked'::text;
    RETURN;
  END IF;

  selected_request_sha256 := public.digest(
    pg_catalog.convert_to(
      pg_catalog.concat_ws(
        pg_catalog.chr(31),
        'property-predator-owned-seed-campaign-request:v1',
        p_workspace_id::text, selected_connection_id::text,
        p_message_version_id::text, selected_approval_request_id::text,
        selected_approval_decision_id::text,
        pg_catalog.encode(selected_approved_content_sha256, 'hex'),
        selected_source_content_version_id::text,
        pg_catalog.encode(selected_source_content_sha256, 'hex'),
        selected_source_attestation_id::text,
        selected_contact_point_id::text, selected_consent_event_id::text,
        pg_catalog.encode(selected_email_sha256, 'hex'),
        p_run_id::text, selected_cost::text
      ),
      'UTF8'
    ),
    'sha256'
  );

  -- Capacity is checked now as well as at 0043 begin-call. Reserved usage is
  -- the authoritative effect-side ledger; queued/leased hash-only jobs are
  -- added so a burst of staging commands cannot overfill the tiny pilot queue.
  SELECT usage.reserved_messages, usage.reserved_spend_usd_micros
    INTO run_reserved_messages, run_reserved_spend
  FROM app.property_predator_email_pilot_run_usage AS usage
  WHERE usage.workspace_id = p_workspace_id AND usage.run_id = p_run_id;
  IF NOT FOUND THEN
    run_reserved_messages := 0;
    run_reserved_spend := 0;
  END IF;
  SELECT usage.reserved_messages, usage.reserved_spend_usd_micros
    INTO month_reserved_messages, month_reserved_spend
  FROM app.property_predator_email_pilot_month_usage AS usage
  WHERE usage.workspace_id = p_workspace_id
    AND usage.utc_month = date_trunc(
      'month', statement_timestamp() AT TIME ZONE 'UTC'
    )::date;
  IF NOT FOUND THEN
    month_reserved_messages := 0;
    month_reserved_spend := 0;
  END IF;
  SELECT count(*)::integer,
         coalesce(sum(job.estimated_spend_usd_micros), 0)::bigint
    INTO run_staged_messages, run_staged_spend
  FROM app.property_predator_mailgun_jobs AS job
  WHERE job.workspace_id = p_workspace_id
    AND job.run_id = p_run_id
    AND job.state IN ('queued', 'leased');
  SELECT count(*)::integer,
         coalesce(sum(job.estimated_spend_usd_micros), 0)::bigint
    INTO month_staged_messages, month_staged_spend
  FROM app.property_predator_mailgun_jobs AS job
  WHERE job.workspace_id = p_workspace_id
    AND job.utc_month = date_trunc(
      'month', statement_timestamp() AT TIME ZONE 'UTC'
    )::date
    AND job.state IN ('queued', 'leased');
  IF run_reserved_messages + run_staged_messages + 1 > 1
     OR run_reserved_spend + run_staged_spend + selected_cost
       > selected_run_spend_cap
     OR month_reserved_messages + month_staged_messages + 1 > 3
     OR month_reserved_spend + month_staged_spend + selected_cost
       > selected_month_spend_cap THEN
    RETURN QUERY SELECT 'blocked', 'pilot_capacity_unavailable', NULL::uuid,
      selected_connection_id, p_message_version_id,
      selected_request_sha256, selected_cost, 'blocked'::text;
    RETURN;
  END IF;

  selected_job_id := app_private.stage_property_predator_mailgun_job(
    p_workspace_id, selected_connection_id, gen_random_uuid(),
    gen_random_uuid(), selected_idempotency_sha256,
    selected_request_sha256, p_run_id, p_message_version_id,
    selected_approval_request_id, selected_approval_decision_id,
    selected_approved_content_sha256, selected_contact_point_id,
    selected_consent_event_id, selected_email_sha256, selected_cost
  );
  RETURN QUERY SELECT 'staged', NULL::text, selected_job_id,
    selected_connection_id, p_message_version_id,
    selected_request_sha256, selected_cost, 'queued'::text;
END
$function$;

CREATE FUNCTION app_private.property_predator_owned_seed_campaign_boundary_ready()
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
  stage_oid oid := pg_catalog.to_regprocedure(
    'app_private.stage_property_predator_owned_seed_campaign(uuid,uuid,uuid,text)'
  );
  ready_oid oid := pg_catalog.to_regprocedure(
    'app_private.property_predator_owned_seed_campaign_boundary_ready()'
  );
  ledger_oid oid := pg_catalog.to_regprocedure(
    'app_private.runtime_schema_migrations()'
  );
  installation_oid oid := pg_catalog.to_regprocedure(
    'app_private.runtime_database_installation_id()'
  );
  session_lock_oid oid := pg_catalog.to_regprocedure(
    'app_private.lock_active_portal_session(bytea,uuid,uuid)'
  );
  session_role_oid oid := pg_catalog.to_regrole(session_user);
BEGIN
  IF session_user <> 'r72_owned_seed_campaign_command'
     OR stage_oid IS NULL OR ready_oid IS NULL
     OR ledger_oid IS NULL OR installation_oid IS NULL
     OR session_lock_oid IS NULL
     OR session_role_oid IS NULL
     OR pg_catalog.to_regclass('app.property_predator_mailgun_jobs') IS NULL THEN
    RETURN false;
  END IF;
  RETURN EXISTS (
      SELECT 1 FROM pg_catalog.pg_roles AS role
      WHERE role.oid = session_role_oid
        AND role.rolcanlogin AND NOT role.rolinherit AND NOT role.rolsuper
        AND NOT role.rolcreatedb AND NOT role.rolcreaterole
        AND NOT role.rolreplication AND NOT role.rolbypassrls
    )
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_auth_members AS membership
      WHERE membership.member = session_role_oid
    )
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_auth_members AS membership
      WHERE membership.roleid = session_role_oid
        AND (membership.inherit_option OR membership.set_option)
    )
    AND pg_catalog.has_schema_privilege(session_user, 'app_private', 'USAGE')
    AND NOT pg_catalog.has_schema_privilege(session_user, 'app_private', 'CREATE')
    AND NOT pg_catalog.has_schema_privilege(session_user, 'app', 'USAGE')
    AND NOT pg_catalog.has_schema_privilege(session_user, 'public', 'CREATE')
    AND pg_catalog.has_function_privilege(session_user, stage_oid, 'EXECUTE')
    AND pg_catalog.has_function_privilege(session_user, ready_oid, 'EXECUTE')
    AND pg_catalog.has_function_privilege(session_user, ledger_oid, 'EXECUTE')
    AND pg_catalog.has_function_privilege(
      session_user, installation_oid, 'EXECUTE'
    )
    AND pg_catalog.has_function_privilege(
      session_user, session_lock_oid, 'EXECUTE'
    )
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_class AS relation
      JOIN pg_catalog.pg_namespace AS namespace
        ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname IN ('app', 'app_private')
        AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
        AND (
          pg_catalog.has_table_privilege(session_user, relation.oid, 'SELECT')
          OR pg_catalog.has_table_privilege(session_user, relation.oid, 'INSERT')
          OR pg_catalog.has_table_privilege(session_user, relation.oid, 'UPDATE')
          OR pg_catalog.has_table_privilege(session_user, relation.oid, 'DELETE')
          OR pg_catalog.has_table_privilege(session_user, relation.oid, 'TRUNCATE')
        )
    )
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_proc AS procedure
      JOIN pg_catalog.pg_namespace AS namespace
        ON namespace.oid = procedure.pronamespace
      WHERE namespace.nspname = 'app_private'
        AND procedure.oid NOT IN (
          stage_oid, ready_oid, ledger_oid, installation_oid, session_lock_oid
        )
        AND pg_catalog.has_function_privilege(
          session_user, procedure.oid, 'EXECUTE'
        )
    )
    AND EXISTS (
      SELECT 1 FROM pg_catalog.pg_proc AS procedure
      JOIN pg_catalog.pg_roles AS owner_role ON owner_role.oid = procedure.proowner
      WHERE procedure.oid IN (stage_oid, ready_oid)
      GROUP BY owner_role.rolname
      HAVING owner_role.rolname = 'r72_mailgun_worker_definer'
        AND pg_catalog.bool_and(procedure.prosecdef)
        AND pg_catalog.bool_and(
          procedure.proconfig = ARRAY['search_path=pg_catalog']::text[]
        )
        AND pg_catalog.count(*) = 2
    )
    AND EXISTS (
      SELECT 1 FROM pg_catalog.pg_proc AS procedure
      JOIN pg_catalog.pg_roles AS owner_role ON owner_role.oid = procedure.proowner
      WHERE procedure.oid = session_lock_oid
        AND owner_role.rolname = 'r72_security_definer'
        AND procedure.prosecdef
        AND procedure.proconfig = ARRAY['search_path=pg_catalog']::text[]
    );
END
$function$;

SET LOCAL ROLE r72_owner;

REVOKE ALL ON FUNCTION app_private.stage_property_predator_owned_seed_campaign(
  uuid, uuid, uuid, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION
  app_private.property_predator_owned_seed_campaign_boundary_ready()
  FROM PUBLIC;
GRANT USAGE ON SCHEMA app_private TO r72_owned_seed_campaign_command;
GRANT EXECUTE ON FUNCTION
  app_private.stage_property_predator_owned_seed_campaign(uuid, uuid, uuid, text)
  TO r72_owned_seed_campaign_command;
GRANT EXECUTE ON FUNCTION
  app_private.property_predator_owned_seed_campaign_boundary_ready()
  TO r72_owned_seed_campaign_command;
GRANT EXECUTE ON FUNCTION app_private.runtime_schema_migrations()
  TO r72_owned_seed_campaign_command;
GRANT EXECUTE ON FUNCTION app_private.runtime_database_installation_id()
  TO r72_owned_seed_campaign_command;
GRANT EXECUTE ON FUNCTION app_private.lock_active_portal_session(bytea, uuid, uuid)
  TO r72_owned_seed_campaign_command;
REVOKE CREATE ON SCHEMA app_private FROM r72_mailgun_worker_definer;

DO $capability_audit$
DECLARE unsafe_object text;
BEGIN
  SELECT pg_catalog.format('%I.%I', namespace.nspname, relation.relname)
    INTO unsafe_object
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
  WHERE namespace.nspname IN ('app', 'app_private')
    AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
    AND (
      pg_catalog.has_table_privilege(
        'r72_owned_seed_campaign_command', relation.oid, 'SELECT'
      )
      OR pg_catalog.has_table_privilege(
        'r72_owned_seed_campaign_command', relation.oid, 'INSERT'
      )
      OR pg_catalog.has_table_privilege(
        'r72_owned_seed_campaign_command', relation.oid, 'UPDATE'
      )
      OR pg_catalog.has_table_privilege(
        'r72_owned_seed_campaign_command', relation.oid, 'DELETE'
      )
      OR pg_catalog.has_table_privilege(
        'r72_owned_seed_campaign_command', relation.oid, 'TRUNCATE'
      )
    )
  LIMIT 1;
  IF unsafe_object IS NOT NULL THEN
    RAISE EXCEPTION 'Owned-seed campaign command has unsafe table access: %',
      unsafe_object;
  END IF;
END
$capability_audit$;

RESET ROLE;
