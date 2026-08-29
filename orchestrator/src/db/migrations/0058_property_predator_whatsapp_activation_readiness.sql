-- Read-only Meta WhatsApp activation readiness for one exact owned target.
--
-- 0053 deliberately collapses every enqueue failure into a single opaque
-- 'WhatsApp live consent/PECR authority denied'. That is correct for a command
-- boundary but leaves a founder unable to learn why a first owned-number
-- rehearsal is blocked without attempting a real send.
--
-- This migration adds exactly one STABLE, read-only SECURITY DEFINER probe. It
-- writes nothing, creates no authority or job, and cannot reach a provider. It
-- reduces a supplied owned target to one row per readiness dimension carrying
-- a boolean and a non-sensitive blocker code. The recipient is supplied as a
-- digest and is never returned, logged or echoed.
--
-- Durable evidence only. The PECR sender/instigator routes and the
-- permission-use receipt are bound to the exact request id of the command that
-- consumes them, so they cannot honestly be pre-proved here; they stay the
-- separately authorised responsibility of the command itself.

SET LOCAL ROLE r72_owner;

GRANT CREATE ON SCHEMA app_private TO r72_whatsapp_live_definer;
SET LOCAL ROLE r72_whatsapp_live_definer;

CREATE FUNCTION app_private.property_predator_whatsapp_activation_readiness(
  p_workspace_id uuid,
  p_binding_id uuid,
  p_template_id uuid,
  p_contact_id uuid,
  p_contact_point_id uuid,
  p_consent_event_id uuid,
  p_purpose text,
  p_expected_recipient_sha256 bytea
) RETURNS TABLE (dimension text, ready boolean, blocker_code text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
  selected_user uuid;
  selected_connection uuid;
  selected_endpoint_sha bytea;
  selected_recipient_sha bytea;
  binding_ok boolean := false;
  binding_revoked boolean := false;
  template_ok boolean := false;
  template_current boolean := false;
  daily_used integer := 0;
  monthly_used integer := 0;
BEGIN
  IF session_user <> 'r72_whatsapp_live_command'
     OR current_setting('app.workspace_id', true) IS DISTINCT FROM p_workspace_id::text
     OR current_setting('app.actor_kind', true) IS DISTINCT FROM 'user'
     OR current_setting('app.user_id', true) !~ '^[0-9a-f-]{36}$'
     OR coalesce(current_setting('app.request_id', true), '') = ''
     OR p_purpose !~ '^[a-z][a-z0-9_.-]{0,99}$'
     OR p_expected_recipient_sha256 IS NULL
     OR octet_length(p_expected_recipient_sha256) <> 32 THEN
    RAISE EXCEPTION 'WhatsApp activation readiness denied' USING ERRCODE = '42501';
  END IF;
  selected_user := current_setting('app.user_id')::uuid;

  dimension := 'operator_authority';
  ready := EXISTS (
    SELECT 1 FROM app.workspace_memberships AS membership
    WHERE membership.workspace_id = p_workspace_id
      AND membership.user_id = selected_user
      AND membership.status = 'active' AND membership.role IN ('owner', 'admin')
  );
  blocker_code := CASE WHEN ready THEN NULL ELSE 'OPERATOR_AUTHORITY_REQUIRED' END;
  RETURN NEXT;

  SELECT connection.id INTO selected_connection
  FROM app.provider_connections AS connection
  WHERE connection.workspace_id = p_workspace_id
    AND connection.provider_id = 'meta_whatsapp_cloud'
    AND connection.provider_kind = 'messaging'
    AND connection.environment = 'live' AND connection.status = 'active'
  ORDER BY connection.id
  LIMIT 1;
  dimension := 'provider_connection';
  ready := selected_connection IS NOT NULL;
  blocker_code := CASE WHEN ready THEN NULL ELSE 'PROVIDER_NOT_CONFIGURED' END;
  RETURN NEXT;

  SELECT true, EXISTS (
    SELECT 1 FROM app.property_predator_whatsapp_live_binding_revocations AS revocation
    WHERE revocation.workspace_id = binding.workspace_id
      AND revocation.binding_id = binding.id
  ) INTO binding_ok, binding_revoked
  FROM app.property_predator_whatsapp_live_bindings AS binding
  JOIN app.provider_connections AS connection
    ON connection.workspace_id = binding.workspace_id
   AND connection.id = binding.provider_connection_id
   AND connection.provider_id = 'meta_whatsapp_cloud'
   AND connection.provider_kind = 'messaging'
   AND connection.environment = 'live' AND connection.status = 'active'
  WHERE binding.workspace_id = p_workspace_id AND binding.id = p_binding_id
    AND binding.status = 'active';
  dimension := 'owned_binding';
  ready := coalesce(binding_ok, false) AND NOT coalesce(binding_revoked, false);
  blocker_code := CASE
    WHEN ready THEN NULL
    WHEN coalesce(binding_revoked, false) THEN 'BINDING_REVOKED'
    ELSE 'IDENTITY_BINDING_REQUIRED' END;
  RETURN NEXT;

  -- The template must still be the exact Meta-approved, parameter-free artefact
  -- whose company approval decision was 'approved' and whose stored content
  -- hash still re-derives from the approved company content bytes.
  SELECT true, NOT EXISTS (
    SELECT 1 FROM app.company_content_versions AS newer
    WHERE newer.workspace_id = version.workspace_id
      AND newer.content_item_id = version.content_item_id
      AND newer.version_number > version.version_number
  ) INTO template_ok, template_current
  FROM app.property_predator_whatsapp_live_templates AS template
  JOIN app.company_content_versions AS version
    ON version.workspace_id = template.workspace_id
   AND version.content_item_id = template.content_item_id
   AND version.id = template.content_version_id
   AND version.content_sha256 = template.content_sha256
   AND public.digest(version.content_body, 'sha256') = version.content_sha256
  JOIN app.company_content_approval_requests AS request
    ON request.workspace_id = template.workspace_id
   AND request.id = template.approval_request_id
   AND request.content_item_id = template.content_item_id
   AND request.content_version_id = template.content_version_id
   AND request.content_sha256 = template.content_sha256
  JOIN app.company_content_approval_decisions AS decision
    ON decision.workspace_id = template.workspace_id
   AND decision.id = template.approval_decision_id
   AND decision.approval_request_id = request.id
   AND decision.decision = 'approved'
  WHERE template.workspace_id = p_workspace_id
    AND template.id = p_template_id
    AND template.binding_id = p_binding_id
    AND template.provider_status = 'approved'
    AND template.parameter_count = 0;
  dimension := 'approved_template';
  ready := coalesce(template_ok, false);
  blocker_code := CASE WHEN ready THEN NULL ELSE 'TEMPLATE_NOT_APPROVED' END;
  RETURN NEXT;

  -- Advisory only. Meta approved exact bytes, so a newer internal draft must
  -- not silently change what would be sent; the founder is told instead.
  dimension := 'template_content_current';
  ready := coalesce(template_ok, false) AND coalesce(template_current, false);
  blocker_code := CASE WHEN ready THEN NULL ELSE 'TEMPLATE_CONTENT_SUPERSEDED' END;
  RETURN NEXT;

  SELECT public.digest(point.kind || pg_catalog.chr(31) || point.value
      || pg_catalog.chr(31) || point.normalized_value, 'sha256'),
    public.digest(regexp_replace(point.normalized_value, '^\+', ''), 'sha256')
  INTO selected_endpoint_sha, selected_recipient_sha
  FROM app.contact_points AS point
  WHERE point.workspace_id = p_workspace_id AND point.id = p_contact_point_id
    AND point.contact_id = p_contact_id AND point.kind = 'whatsapp'
    AND point.is_verified AND point.dedupe_state = 'normal'
    AND point.deleted_at IS NULL
    AND regexp_replace(point.normalized_value, '^\+', '') ~ '^[1-9][0-9]{6,14}$';
  dimension := 'recipient_endpoint';
  ready := selected_recipient_sha IS NOT NULL;
  blocker_code := CASE WHEN ready THEN NULL ELSE 'RECIPIENT_ENDPOINT_UNVERIFIED' END;
  RETURN NEXT;

  -- Proves the supplied owned recipient is the one the database would dial,
  -- by digest comparison only. The number itself never leaves this function.
  dimension := 'recipient_matches_supplied_owned_target';
  ready := selected_recipient_sha IS NOT NULL
    AND selected_recipient_sha = p_expected_recipient_sha256;
  blocker_code := CASE WHEN ready THEN NULL ELSE 'RECIPIENT_EVIDENCE_MISMATCH' END;
  RETURN NEXT;

  dimension := 'current_consent';
  ready := selected_endpoint_sha IS NOT NULL AND EXISTS (
    SELECT 1 FROM app.communication_consent_events AS consent
    WHERE consent.workspace_id = p_workspace_id AND consent.id = p_consent_event_id
      AND consent.contact_id = p_contact_id
      AND consent.contact_point_id = p_contact_point_id
      AND consent.channel = 'whatsapp' AND consent.purpose = p_purpose
      AND consent.state = 'granted'
      AND consent.endpoint_identity_sha256 = selected_endpoint_sha
      AND consent.id = (
        SELECT latest.id FROM app.communication_consent_events AS latest
        WHERE latest.workspace_id = p_workspace_id
          AND latest.contact_point_id = p_contact_point_id
          AND latest.channel = 'whatsapp' AND latest.purpose = p_purpose
        ORDER BY latest.occurred_at DESC, latest.recorded_at DESC, latest.id DESC
        LIMIT 1
      )
  );
  blocker_code := CASE WHEN ready THEN NULL ELSE 'CONSENT_NOT_CURRENT' END;
  RETURN NEXT;

  dimension := 'suppression_clear';
  ready := selected_endpoint_sha IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM app.communication_suppression_events AS suppression
    WHERE suppression.workspace_id = p_workspace_id
      AND suppression.contact_point_id = p_contact_point_id
      AND suppression.channel = 'whatsapp'
      AND (suppression.purpose IS NULL OR suppression.purpose = p_purpose)
      AND suppression.endpoint_identity_sha256 = selected_endpoint_sha
      AND suppression.state = 'suppressed'
      AND suppression.id = (
        SELECT latest.id FROM app.communication_suppression_events AS latest
        WHERE latest.workspace_id = p_workspace_id
          AND latest.contact_point_id = suppression.contact_point_id
          AND latest.channel = suppression.channel
          AND latest.purpose IS NOT DISTINCT FROM suppression.purpose
        ORDER BY latest.occurred_at DESC, latest.recorded_at DESC, latest.id DESC
        LIMIT 1
      )
  );
  blocker_code := CASE WHEN ready THEN NULL ELSE 'SUPPRESSION_ACTIVE' END;
  RETURN NEXT;

  -- Inbound ingress must already be composed or a verified reply has nowhere
  -- to land in Conversion Inbox.
  dimension := 'inbound_ingress';
  ready := selected_connection IS NOT NULL AND EXISTS (
    SELECT 1 FROM app.inboxes AS inbox
    WHERE inbox.workspace_id = p_workspace_id
      AND inbox.provider_connection_id = selected_connection
      AND inbox.channel = 'whatsapp' AND inbox.environment = 'live'
      AND inbox.status = 'active'
  );
  blocker_code := CASE WHEN ready THEN NULL ELSE 'INGRESS_NOT_READY' END;
  RETURN NEXT;

  -- 0053 counts both caps per binding. The founder-facing rail truth counts
  -- per workspace, so this probe reports the stricter per-binding figure that
  -- the command boundary will actually enforce.
  SELECT count(*)::integer INTO daily_used
  FROM app.property_predator_whatsapp_live_jobs AS job
  WHERE job.workspace_id = p_workspace_id AND job.binding_id = p_binding_id
    AND job.utc_day = (statement_timestamp() AT TIME ZONE 'UTC')::date
    AND job.state <> 'cancelled';
  SELECT count(*)::integer INTO monthly_used
  FROM app.property_predator_whatsapp_live_jobs AS job
  WHERE job.workspace_id = p_workspace_id AND job.binding_id = p_binding_id
    AND job.utc_month = date_trunc('month', statement_timestamp() AT TIME ZONE 'UTC')::date
    AND job.state <> 'cancelled';
  dimension := 'cap_headroom';
  ready := daily_used < 1 AND monthly_used < 3;
  blocker_code := CASE WHEN ready THEN NULL ELSE 'CAP_REACHED' END;
  RETURN NEXT;

  dimension := 'emergency_pause_clear';
  ready := NOT EXISTS (
    SELECT 1 FROM app.property_predator_live_channel_pause_events AS pause
    WHERE pause.workspace_id = p_workspace_id
      AND pause.scope IN ('all', 'whatsapp')
  );
  blocker_code := CASE WHEN ready THEN NULL ELSE 'EMERGENCY_PAUSED' END;
  RETURN NEXT;
END
$function$;

RESET ROLE;
SET LOCAL ROLE r72_owner;

REVOKE CREATE ON SCHEMA app_private FROM r72_whatsapp_live_definer;

-- The probe needs to read the pause ledger and the composed inbox set, which
-- 0053 did not grant to the WhatsApp definer.
GRANT SELECT ON app.property_predator_live_channel_pause_events,
  app.inboxes TO r72_whatsapp_live_definer;
CREATE POLICY live_channel_pause_whatsapp_live_definer_select
  ON app.property_predator_live_channel_pause_events FOR SELECT
  TO r72_whatsapp_live_definer
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
CREATE POLICY inboxes_whatsapp_live_definer_select
  ON app.inboxes FOR SELECT TO r72_whatsapp_live_definer
  USING (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND channel = 'whatsapp' AND environment = 'live'
  );

REVOKE ALL ON FUNCTION app_private.property_predator_whatsapp_activation_readiness(
  uuid, uuid, uuid, uuid, uuid, uuid, text, bytea
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.property_predator_whatsapp_activation_readiness(
  uuid, uuid, uuid, uuid, uuid, uuid, text, bytea
) TO r72_whatsapp_live_command;

-- Surface the one missing WhatsApp activation fact through the existing typed
-- truth contract. TEMPLATE_REQUIRED is already a member of the frozen portal
-- blocker union and already carries founder-facing copy, so no contract, view
-- or presenter change is required: the rail simply stops claiming it is merely
-- awaiting approval when it has no approved template to send at all.
GRANT SELECT ON app.property_predator_whatsapp_live_templates
  TO r72_operational_inbox_definer;
CREATE POLICY operational_channel_truth_whatsapp_templates_select
  ON app.property_predator_whatsapp_live_templates FOR SELECT
  TO r72_operational_inbox_definer
  USING (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND current_setting('app.actor_kind', true) = 'user'
  );

GRANT CREATE ON SCHEMA app_private TO r72_operational_inbox_definer;
SET LOCAL ROLE r72_operational_inbox_definer;

CREATE OR REPLACE FUNCTION app_private.property_predator_live_channel_truth()
RETURNS TABLE (
  workspace_id uuid,
  snapshot_at timestamptz,
  rail text,
  connection_state text,
  inbound_state text,
  outbound_or_reply_state text,
  receipt_state text,
  daily_used bigint,
  daily_limit bigint,
  monthly_used bigint,
  monthly_limit bigint,
  blocker_codes text[],
  latest_receipt_id uuid,
  latest_receipt_outcome text,
  latest_receipt_at timestamptz,
  latest_receipt_evidence_sha256 text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
  SELECT truth.workspace_id, truth.snapshot_at, truth.rail,
    truth.connection_state, truth.inbound_state, truth.outbound_or_reply_state,
    truth.receipt_state, truth.daily_used, truth.daily_limit,
    truth.monthly_used, truth.monthly_limit,
    CASE
      WHEN truth.rail = 'whatsapp'
        AND NOT EXISTS (
          SELECT 1
          FROM app.property_predator_whatsapp_live_templates AS template
          JOIN app.property_predator_whatsapp_live_bindings AS binding
            ON binding.workspace_id = template.workspace_id
           AND binding.id = template.binding_id
           AND binding.status = 'active'
          JOIN app.provider_connections AS connection
            ON connection.workspace_id = binding.workspace_id
           AND connection.id = binding.provider_connection_id
           AND connection.provider_id = 'meta_whatsapp_cloud'
           AND connection.provider_kind = 'messaging'
           AND connection.environment = 'live'
           AND connection.status = 'active'
          WHERE template.workspace_id = truth.workspace_id
            AND template.provider_status = 'approved'
            AND template.parameter_count = 0
            AND NOT EXISTS (
              SELECT 1
              FROM app.property_predator_whatsapp_live_binding_revocations AS revocation
              WHERE revocation.workspace_id = binding.workspace_id
                AND revocation.binding_id = binding.id
            )
        )
        AND NOT ('TEMPLATE_REQUIRED' = ANY(paused.codes))
        THEN paused.codes || ARRAY['TEMPLATE_REQUIRED']
      ELSE paused.codes
    END,
    truth.latest_receipt_id, truth.latest_receipt_outcome,
    truth.latest_receipt_at, truth.latest_receipt_evidence_sha256
  FROM app_private.property_predator_live_channel_truth_unpaused() AS truth
  CROSS JOIN LATERAL (
    SELECT CASE WHEN truth.rail <> 'social_dm' AND EXISTS (
      SELECT 1 FROM app.property_predator_live_channel_pause_events AS pause
      WHERE pause.workspace_id = truth.workspace_id
        AND pause.scope IN ('all', truth.rail)
    ) THEN CASE WHEN 'EMERGENCY_PAUSED' = ANY(truth.blocker_codes)
      THEN truth.blocker_codes ELSE truth.blocker_codes || ARRAY['EMERGENCY_PAUSED'] END
    ELSE truth.blocker_codes END AS codes
  ) AS paused
$function$;

RESET ROLE;
SET LOCAL ROLE r72_owner;

REVOKE CREATE ON SCHEMA app_private FROM r72_operational_inbox_definer;
REVOKE ALL ON FUNCTION app_private.property_predator_live_channel_truth()
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.property_predator_live_channel_truth()
  TO r72_web;

-- The command identity must remain completely table-blind: the probe is
-- read-only evidence, never a new read capability.
DO $capability_audit$
DECLARE checked_role text; unsafe_object text;
BEGIN
  FOREACH checked_role IN ARRAY ARRAY[
    'r72_whatsapp_live_command', 'r72_whatsapp_live_worker_command',
    'r72_whatsapp_live_webhook_command'
  ] LOOP
    SELECT format('%I.%I', namespace.nspname, relation.relname) INTO unsafe_object
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname IN ('app', 'app_private')
      AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
      AND (has_table_privilege(checked_role, relation.oid, 'SELECT')
        OR has_table_privilege(checked_role, relation.oid, 'INSERT')
        OR has_table_privilege(checked_role, relation.oid, 'UPDATE')
        OR has_table_privilege(checked_role, relation.oid, 'DELETE')
        OR has_table_privilege(checked_role, relation.oid, 'TRUNCATE'))
    LIMIT 1;
    IF unsafe_object IS NOT NULL THEN
      RAISE EXCEPTION 'Unsafe WhatsApp activation readiness capability: % -> %',
        checked_role, unsafe_object;
    END IF;
  END LOOP;
END
$capability_audit$;
