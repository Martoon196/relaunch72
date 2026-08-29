-- Read-only owned public-social activation readiness for one exact owned
-- Ayrshare/X account and one exact approved post.
--
-- 0052 collapses every refused publication into four opaque denials
-- ('Owned social profile binding denied', 'Owned social content/profile
-- evidence denied', 'Owned social X v1 text denied', 'Owned social hard
-- publish cap reached'). That is correct for a command boundary, but the
-- publishable-text rules are strict and easy to fail by accident: the approved
-- bytes must be ASCII-printable, at most 280 characters, and must contain no
-- URL, scheme, `www.` or bare domain of any kind. A founder should be able to
-- learn that before a first owned-account publication, not from a rejected
-- command.
--
-- This migration adds exactly one STABLE, read-only SECURITY DEFINER probe. It
-- writes nothing, creates no job, and cannot reach Ayrshare. It reduces the
-- supplied owned target to one row per readiness dimension carrying a boolean
-- and a non-sensitive blocker code. The owned account is supplied as a digest
-- and compared against the digest 0052 stored; no account reference, profile
-- key or post text is ever returned.
--
-- It re-proves the same predicates the command boundary enforces, including
-- the per-profile cap grain that the rail-level truth deliberately reports
-- more loosely, and the `environment`/`provider_kind` connection facts the
-- truth binding check does not currently re-assert.

SET LOCAL ROLE r72_owner;

-- 0057 landed after 0052, so the owned-social definer cannot yet read the
-- durable pause ledger it must honour.
GRANT SELECT ON app.property_predator_live_channel_pause_events
  TO r72_owned_social_definer;
CREATE POLICY live_channel_pause_owned_social_definer_select
  ON app.property_predator_live_channel_pause_events FOR SELECT
  TO r72_owned_social_definer
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

GRANT CREATE ON SCHEMA app_private TO r72_owned_social_definer;
SET LOCAL ROLE r72_owned_social_definer;

CREATE FUNCTION app_private.property_predator_owned_social_activation_readiness(
  p_workspace_id uuid,
  p_provider_connection_id uuid,
  p_profile_id uuid,
  p_content_item_id uuid,
  p_content_version_id uuid,
  p_approval_request_id uuid,
  p_approval_decision_id uuid,
  p_source_attestation_id uuid,
  p_expected_owned_account_sha256 bytea,
  p_scheduled_for timestamptz
) RETURNS TABLE (dimension text, ready boolean, blocker_code text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
  selected_user uuid;
  selected_connection_ok boolean := false;
  profile_ok boolean := false;
  profile_revoked boolean := false;
  selected_account_sha bytea;
  selected_link_evidence bytea;
  selected_permissions text;
  selected_linked_at timestamptz;
  selected_observed_at timestamptz;
  content_ok boolean := false;
  content_current boolean := false;
  attestation_ok boolean := false;
  selected_body text;
  selected_effect_at timestamptz;
  daily_used integer := 0;
  monthly_used integer := 0;
BEGIN
  IF session_user <> 'r72_owned_social_command'
     OR current_setting('app.workspace_id', true) IS DISTINCT FROM p_workspace_id::text
     OR current_setting('app.actor_kind', true) IS DISTINCT FROM 'user'
     OR current_setting('app.user_id', true) !~ '^[0-9a-f-]{36}$'
     OR coalesce(current_setting('app.request_id', true), '') = ''
     OR p_expected_owned_account_sha256 IS NULL
     OR octet_length(p_expected_owned_account_sha256) <> 32 THEN
    RAISE EXCEPTION 'Owned social activation readiness denied' USING ERRCODE = '42501';
  END IF;
  selected_user := current_setting('app.user_id')::uuid;
  selected_effect_at := greatest(
    statement_timestamp(), coalesce(p_scheduled_for, statement_timestamp())
  );

  dimension := 'operator_authority';
  ready := EXISTS (
    SELECT 1 FROM app.workspace_memberships AS membership
    WHERE membership.workspace_id = p_workspace_id
      AND membership.user_id = selected_user
      AND membership.status = 'active' AND membership.role IN ('owner', 'admin')
  );
  blocker_code := CASE WHEN ready THEN NULL ELSE 'OPERATOR_AUTHORITY_REQUIRED' END;
  RETURN NEXT;

  -- The full connection fact the command boundary requires, including the
  -- environment and provider_kind the rail-level truth does not re-assert.
  SELECT true INTO selected_connection_ok
  FROM app.provider_connections AS connection
  WHERE connection.workspace_id = p_workspace_id
    AND connection.id = p_provider_connection_id
    AND connection.provider_id = 'ayrshare'
    AND connection.provider_kind = 'social'
    AND connection.environment = 'live'
    AND connection.status = 'active';
  dimension := 'provider_connection';
  ready := coalesce(selected_connection_ok, false);
  blocker_code := CASE WHEN ready THEN NULL ELSE 'PROVIDER_NOT_CONFIGURED' END;
  RETURN NEXT;

  SELECT true, EXISTS (
      SELECT 1
      FROM app.property_predator_owned_social_profile_revocations AS revocation
      WHERE revocation.workspace_id = profile.workspace_id
        AND revocation.profile_id = profile.id
    ),
    profile.owned_account_ref_sha256, profile.x_oauth_link_evidence_sha256,
    profile.x_oauth_permissions, profile.linked_at, profile.evidence_observed_at
  INTO profile_ok, profile_revoked, selected_account_sha, selected_link_evidence,
    selected_permissions, selected_linked_at, selected_observed_at
  FROM app.property_predator_owned_social_profiles AS profile
  WHERE profile.workspace_id = p_workspace_id
    AND profile.id = p_profile_id
    AND profile.provider_connection_id = p_provider_connection_id
    AND profile.environment = 'live'
    AND profile.provider_id = 'ayrshare'
    AND profile.network = 'x';
  dimension := 'owned_profile';
  ready := coalesce(profile_ok, false) AND NOT coalesce(profile_revoked, false)
    AND coalesce(selected_connection_ok, false);
  blocker_code := CASE
    WHEN ready THEN NULL
    WHEN coalesce(profile_revoked, false) THEN 'IDENTITY_BINDING_REVOKED'
    ELSE 'IDENTITY_BINDING_REQUIRED' END;
  RETURN NEXT;

  -- Digest comparison only. The owned account reference never leaves here.
  dimension := 'owned_account_matches_supplied';
  ready := selected_account_sha IS NOT NULL
    AND selected_account_sha = p_expected_owned_account_sha256;
  blocker_code := CASE WHEN ready THEN NULL ELSE 'OWNED_ACCOUNT_EVIDENCE_MISMATCH' END;
  RETURN NEXT;

  dimension := 'ownership_link_evidence';
  ready := selected_link_evidence IS NOT NULL
    AND octet_length(selected_link_evidence) = 32
    AND selected_permissions = 'read_write'
    AND selected_linked_at IS NOT NULL
    AND selected_observed_at IS NOT NULL
    AND selected_linked_at <= selected_observed_at + interval '5 minutes';
  blocker_code := CASE WHEN ready THEN NULL ELSE 'OWNERSHIP_EVIDENCE_REQUIRED' END;
  RETURN NEXT;

  -- The exact approval chain 0052 re-proves: request and decision pinned to the
  -- same content digest, an approved decision, and bytes that still re-derive.
  SELECT true, NOT EXISTS (
      SELECT 1 FROM app.company_content_versions AS newer
      WHERE newer.workspace_id = version.workspace_id
        AND newer.content_item_id = version.content_item_id
        AND newer.version_number > version.version_number
    ), version.content_body
  INTO content_ok, content_current, selected_body
  FROM app.company_content_versions AS version
  JOIN app.company_content_approval_requests AS request
    ON request.workspace_id = version.workspace_id
   AND request.content_item_id = version.content_item_id
   AND request.content_version_id = version.id
   AND request.content_sha256 = version.content_sha256
   AND request.id = p_approval_request_id
  JOIN app.company_content_approval_decisions AS decision
    ON decision.workspace_id = request.workspace_id
   AND decision.approval_request_id = request.id
   AND decision.id = p_approval_decision_id
   AND decision.decision = 'approved'
  WHERE version.workspace_id = p_workspace_id
    AND version.content_item_id = p_content_item_id
    AND version.id = p_content_version_id
    AND version.content_kind = 'social_post'
    AND public.digest(version.content_body, 'sha256') = version.content_sha256;
  dimension := 'approved_content';
  ready := coalesce(content_ok, false);
  blocker_code := CASE WHEN ready THEN NULL ELSE 'APPROVED_CONTENT_REQUIRED' END;
  RETURN NEXT;

  dimension := 'content_version_current';
  ready := coalesce(content_ok, false) AND coalesce(content_current, false);
  blocker_code := CASE WHEN ready THEN NULL ELSE 'CONTENT_VERSION_SUPERSEDED' END;
  RETURN NEXT;

  -- The attestation must still be valid fifteen minutes past the effective
  -- publication moment, exactly as the command boundary requires.
  SELECT true INTO attestation_ok
  FROM app.company_content_source_attestations AS attestation
  JOIN app.company_content_versions AS version
    ON version.workspace_id = attestation.workspace_id
   AND version.content_item_id = attestation.content_item_id
   AND version.id = attestation.content_version_id
   AND version.content_sha256 = attestation.content_sha256
   AND version.blob_sha256 = attestation.blob_sha256
   AND version.brand_sha256 = attestation.brand_sha256
  WHERE attestation.workspace_id = p_workspace_id
    AND attestation.id = p_source_attestation_id
    AND attestation.content_item_id = p_content_item_id
    AND attestation.content_version_id = p_content_version_id
    AND attestation.checked_at <= statement_timestamp()
    AND attestation.expires_at > selected_effect_at + interval '15 minutes';
  dimension := 'source_attestation_valid';
  ready := coalesce(attestation_ok, false);
  blocker_code := CASE WHEN ready THEN NULL ELSE 'SOURCE_ATTESTATION_EXPIRED' END;
  RETURN NEXT;

  -- The X v1 shape the command boundary applies to the approved bytes: at most
  -- 280 characters, ASCII printable, and entirely link-free.
  dimension := 'publishable_text';
  ready := selected_body IS NOT NULL
    AND octet_length(selected_body) BETWEEN 1 AND 16384
    AND length(selected_body) BETWEEN 1 AND 280
    AND selected_body ~ '^[\r\n -~]+$'
    AND selected_body !~* '(//|(^|[^A-Za-z])[A-Za-z][A-Za-z0-9+.-]*:|www[.]|[A-Za-z0-9][A-Za-z0-9-]{0,62}[.][A-Za-z]{2,63})';
  blocker_code := CASE WHEN ready THEN NULL ELSE 'CONTENT_NOT_PUBLISHABLE' END;
  RETURN NEXT;

  -- 0052 counts both caps per owned profile. The rail-level truth counts per
  -- workspace, so this probe reports the stricter grain actually enforced.
  SELECT count(*)::integer INTO daily_used
  FROM app.property_predator_owned_social_jobs AS job
  WHERE job.workspace_id = p_workspace_id AND job.profile_id = p_profile_id
    AND job.utc_day = (selected_effect_at AT TIME ZONE 'UTC')::date
    AND job.state <> 'cancelled';
  SELECT count(*)::integer INTO monthly_used
  FROM app.property_predator_owned_social_jobs AS job
  WHERE job.workspace_id = p_workspace_id AND job.profile_id = p_profile_id
    AND job.utc_month = date_trunc('month', selected_effect_at AT TIME ZONE 'UTC')::date
    AND job.state <> 'cancelled';
  dimension := 'cap_headroom';
  ready := daily_used < 1 AND monthly_used < 3;
  blocker_code := CASE WHEN ready THEN NULL ELSE 'CAP_REACHED' END;
  RETURN NEXT;

  -- An unresolved ambiguous outcome must be reconciled before a new owned
  -- publication is authorised.
  dimension := 'receipt_path_clear';
  ready := NOT EXISTS (
    SELECT 1 FROM app.property_predator_owned_social_jobs AS job
    WHERE job.workspace_id = p_workspace_id
      AND job.profile_id = p_profile_id
      AND job.state IN ('needs_attention', 'reconciliation_pending')
  );
  blocker_code := CASE WHEN ready THEN NULL ELSE 'OUTCOME_UNKNOWN_QUARANTINED' END;
  RETURN NEXT;

  dimension := 'emergency_pause_clear';
  ready := NOT EXISTS (
    SELECT 1 FROM app.property_predator_live_channel_pause_events AS pause
    WHERE pause.workspace_id = p_workspace_id
      AND pause.scope IN ('all', 'owned_social')
  );
  blocker_code := CASE WHEN ready THEN NULL ELSE 'EMERGENCY_PAUSED' END;
  RETURN NEXT;
END
$function$;

RESET ROLE;
SET LOCAL ROLE r72_owner;

REVOKE CREATE ON SCHEMA app_private FROM r72_owned_social_definer;
REVOKE ALL ON FUNCTION app_private.property_predator_owned_social_activation_readiness(
  uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, bytea, timestamptz
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.property_predator_owned_social_activation_readiness(
  uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, bytea, timestamptz
) TO r72_owned_social_command;

-- Surface the missing owned-social activation fact through the existing typed
-- truth contract. The reads below are column-scoped on purpose: the truth
-- definer must be able to tell that an approved social post exists without
-- gaining the ability to read post bodies, titles, metadata or review notes.
GRANT SELECT (workspace_id, id, content_item_id, content_kind, version_number)
  ON app.company_content_versions TO r72_operational_inbox_definer;
GRANT SELECT (workspace_id, content_item_id, content_version_id, decision)
  ON app.company_content_approval_decisions TO r72_operational_inbox_definer;
CREATE POLICY operational_channel_truth_social_post_versions_select
  ON app.company_content_versions FOR SELECT
  TO r72_operational_inbox_definer
  USING (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND current_setting('app.actor_kind', true) = 'user'
    AND content_kind = 'social_post'
  );
CREATE POLICY operational_channel_truth_approved_decisions_select
  ON app.company_content_approval_decisions FOR SELECT
  TO r72_operational_inbox_definer
  USING (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND current_setting('app.actor_kind', true) = 'user'
    AND decision = 'approved'
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
        AND NOT ('TEMPLATE_REQUIRED' = ANY(paused.codes))
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
        THEN paused.codes || ARRAY['TEMPLATE_REQUIRED']
      WHEN truth.rail = 'owned_social'
        AND NOT ('APPROVED_CONTENT_REQUIRED' = ANY(paused.codes))
        AND NOT EXISTS (
          SELECT 1
          FROM app.company_content_versions AS version
          JOIN app.company_content_approval_decisions AS decision
            ON decision.workspace_id = version.workspace_id
           AND decision.content_item_id = version.content_item_id
           AND decision.content_version_id = version.id
           AND decision.decision = 'approved'
          WHERE version.workspace_id = truth.workspace_id
            AND version.content_kind = 'social_post'
            AND NOT EXISTS (
              SELECT 1 FROM app.company_content_versions AS newer
              WHERE newer.workspace_id = version.workspace_id
                AND newer.content_item_id = version.content_item_id
                AND newer.version_number > version.version_number
            )
        )
        THEN paused.codes || ARRAY['APPROVED_CONTENT_REQUIRED']
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

-- The owned-social command identity must stay completely table-blind: the
-- probe is read-only evidence, never a new read capability.
DO $capability_audit$
DECLARE checked_role text; unsafe_object text;
BEGIN
  FOREACH checked_role IN ARRAY ARRAY[
    'r72_owned_social_command', 'r72_owned_social_worker_command'
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
      RAISE EXCEPTION 'Unsafe owned-social activation readiness capability: % -> %',
        checked_role, unsafe_object;
    END IF;
  END LOOP;
END
$capability_audit$;

-- The truth definer gained two column-scoped content reads. Prove it cannot
-- reach the post bytes, titles, metadata or review notes behind them.
DO $content_column_audit$
DECLARE forbidden text;
BEGIN
  FOREACH forbidden IN ARRAY ARRAY[
    'content_body', 'title', 'metadata', 'blob_storage_key', 'brand_snapshot_ref'
  ] LOOP
    IF has_column_privilege(
      'r72_operational_inbox_definer', 'app.company_content_versions', forbidden, 'SELECT'
    ) THEN
      RAISE EXCEPTION 'Live channel truth must not read company content column %', forbidden;
    END IF;
  END LOOP;
  IF has_column_privilege(
    'r72_operational_inbox_definer', 'app.company_content_approval_decisions',
    'decision_note', 'SELECT'
  ) THEN
    RAISE EXCEPTION 'Live channel truth must not read approval decision notes';
  END IF;
END
$content_column_audit$;
