-- Two launch-critical gaps on the founder customer-email pilot, found by a live
-- acceptance walkthrough of the deployed workspace.
--
-- First, the founder's Lead 360 contact has no email endpoint at all, and the
-- permission panel correctly refuses to bind a decision to an endpoint that
-- does not exist. The only existing way to create one is "Create a lead", which
-- would duplicate the founder contact and its opportunity. This migration adds
-- a bounded command that attaches and verifies an email endpoint on an existing
-- contact and can create neither a contact nor an opportunity: the definer that
-- performs it holds no privilege on app.contacts or app.opportunities at all,
-- and audits below fail the apply if it ever does.
--
-- Second, the capped provider enqueue needs twenty-one exact evidence
-- identifiers. Preparing, approving and staging content does not produce them,
-- and nothing told the founder which ones were missing. This migration adds a
-- read-only readiness probe that resolves the same evidence the enqueue demands
-- and reports each missing piece as a stable blocker code, plus an exact
-- recipient and message preview so a founder can see precisely what would be
-- sent before authorising anything.
--
-- Neither function enqueues, dispatches, calls Mailgun or records consent. The
-- readiness probe is STABLE and writes nothing. Suppression is never touched:
-- neither definer holds any write privilege on the suppression ledger.

DO $roles$
DECLARE unsafe_parent text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'r72_crm_command'
  ) THEN
    RAISE EXCEPTION 'r72_crm_command must exist before the founder email pilot rail'
      USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'r72_contact_endpoint_definer'
  ) THEN
    CREATE ROLE r72_contact_endpoint_definer NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'r72_email_pilot_readiness_definer'
  ) THEN
    CREATE ROLE r72_email_pilot_readiness_definer NOLOGIN NOINHERIT;
  END IF;
  FOR unsafe_parent IN
    SELECT candidate FROM (VALUES
      ('r72_contact_endpoint_definer'), ('r72_email_pilot_readiness_definer')
    ) AS roles(candidate)
    WHERE NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_roles
      WHERE rolname = roles.candidate
        AND NOT rolcanlogin AND NOT rolinherit AND NOT rolsuper
        AND NOT rolcreatedb AND NOT rolcreaterole
        AND NOT rolreplication AND NOT rolbypassrls
    )
  LOOP
    RAISE EXCEPTION 'Unsafe founder email pilot definer attributes: %', unsafe_parent
      USING ERRCODE = '42501';
  END LOOP;
  REVOKE r72_owner, r72_security_definer, r72_operational_inbox_definer,
    r72_contact_permission_definer
    FROM r72_contact_endpoint_definer, r72_email_pilot_readiness_definer;
  REVOKE r72_contact_endpoint_definer, r72_email_pilot_readiness_definer
    FROM r72_web, r72_public, r72_worker, r72_webhook, r72_readonly, r72_crm_command;
  -- The two must not inherit each other: the readiness reader must never gain
  -- the endpoint writer's privileges.
  REVOKE r72_contact_endpoint_definer FROM r72_email_pilot_readiness_definer;
  REVOKE r72_email_pilot_readiness_definer FROM r72_contact_endpoint_definer;
  SELECT parent.rolname INTO unsafe_parent
  FROM pg_catalog.pg_auth_members AS membership
  JOIN pg_catalog.pg_roles AS member ON member.oid = membership.member
  JOIN pg_catalog.pg_roles AS parent ON parent.oid = membership.roleid
  WHERE member.rolname IN (
    'r72_contact_endpoint_definer', 'r72_email_pilot_readiness_definer'
  )
  LIMIT 1;
  IF unsafe_parent IS NOT NULL THEN
    RAISE EXCEPTION 'Unsafe founder email pilot definer parent: %', unsafe_parent
      USING ERRCODE = '42501';
  END IF;
  GRANT r72_contact_endpoint_definer, r72_email_pilot_readiness_definer TO r72_owner;
END
$roles$;

SET LOCAL ROLE r72_owner;

-- Append-only proof that a human witnessed the endpoint before it was trusted.
-- The command key makes a double submit a replay rather than a second act.
CREATE TABLE app.contact_endpoint_verification_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE RESTRICT,
  command_key_sha256 bytea NOT NULL CHECK (octet_length(command_key_sha256) = 32),
  request_sha256 bytea NOT NULL CHECK (octet_length(request_sha256) = 32),
  contact_id uuid NOT NULL,
  contact_point_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind = 'email'),
  endpoint_identity_sha256 bytea NOT NULL
    CHECK (octet_length(endpoint_identity_sha256) = 32),
  evidence_source text NOT NULL CHECK (
    evidence_source = lower(btrim(evidence_source))
    AND evidence_source ~ '^[a-z][a-z0-9_.:-]{0,99}$'
  ),
  evidence_reference text NOT NULL CHECK (
    evidence_reference = btrim(evidence_reference)
    AND length(evidence_reference) BETWEEN 1 AND 200
  ),
  verified_at timestamptz NOT NULL,
  actor_user_id uuid NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, command_key_sha256),
  FOREIGN KEY (workspace_id, contact_point_id, contact_id)
    REFERENCES app.contact_points (workspace_id, id, contact_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, actor_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id) ON DELETE RESTRICT
);

ALTER TABLE app.contact_endpoint_verification_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.contact_endpoint_verification_receipts FORCE ROW LEVEL SECURITY;

CREATE FUNCTION app_private.reject_contact_endpoint_receipt_mutation()
RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
BEGIN
  RAISE EXCEPTION 'Contact endpoint verification receipts are append-only'
    USING ERRCODE = '42501';
END
$function$;
REVOKE ALL ON FUNCTION app_private.reject_contact_endpoint_receipt_mutation() FROM PUBLIC;

CREATE TRIGGER contact_endpoint_receipts_immutable
  BEFORE UPDATE OR DELETE ON app.contact_endpoint_verification_receipts
  FOR EACH ROW EXECUTE FUNCTION app_private.reject_contact_endpoint_receipt_mutation();

GRANT SELECT, INSERT ON app.contact_endpoint_verification_receipts
  TO r72_contact_endpoint_definer;
GRANT SELECT ON app.contact_endpoint_verification_receipts TO r72_web;

CREATE POLICY contact_endpoint_receipts_definer_write
  ON app.contact_endpoint_verification_receipts FOR INSERT
  TO r72_contact_endpoint_definer
  WITH CHECK (workspace_id = app_private.current_workspace_id());
CREATE POLICY contact_endpoint_receipts_definer_read
  ON app.contact_endpoint_verification_receipts FOR SELECT
  TO r72_contact_endpoint_definer
  USING (workspace_id = app_private.current_workspace_id());
CREATE POLICY contact_endpoint_receipts_web_read
  ON app.contact_endpoint_verification_receipts FOR SELECT TO r72_web
  USING (workspace_id = app_private.current_workspace_id());

REVOKE ALL ON SCHEMA app, app_private
  FROM r72_contact_endpoint_definer, r72_email_pilot_readiness_definer;
GRANT USAGE ON SCHEMA app, app_private
  TO r72_contact_endpoint_definer, r72_email_pilot_readiness_definer;
GRANT EXECUTE ON FUNCTION app_private.current_workspace_id(),
  app_private.current_user_id(), app_private.current_actor_kind()
  TO r72_contact_endpoint_definer, r72_email_pilot_readiness_definer;

-- The endpoint writer touches exactly one table beyond its own receipt, and
-- only the columns an attach-and-verify needs.
GRANT SELECT (workspace_id, id, contact_id, kind, value, normalized_value,
  is_primary, is_verified, dedupe_state, deleted_at, row_version)
  ON app.contact_points TO r72_contact_endpoint_definer;
GRANT INSERT ON app.contact_points TO r72_contact_endpoint_definer;
GRANT UPDATE (is_verified, updated_at, row_version)
  ON app.contact_points TO r72_contact_endpoint_definer;
GRANT SELECT (workspace_id, user_id, role, status)
  ON app.workspace_memberships TO r72_contact_endpoint_definer;

CREATE POLICY contact_points_endpoint_definer_select
  ON app.contact_points FOR SELECT TO r72_contact_endpoint_definer
  USING (workspace_id = app_private.current_workspace_id());
CREATE POLICY contact_points_endpoint_definer_insert
  ON app.contact_points FOR INSERT TO r72_contact_endpoint_definer
  WITH CHECK (workspace_id = app_private.current_workspace_id() AND kind = 'email');
CREATE POLICY contact_points_endpoint_definer_update
  ON app.contact_points FOR UPDATE TO r72_contact_endpoint_definer
  USING (workspace_id = app_private.current_workspace_id() AND kind = 'email')
  WITH CHECK (workspace_id = app_private.current_workspace_id() AND kind = 'email');
CREATE POLICY memberships_endpoint_definer_select
  ON app.workspace_memberships FOR SELECT TO r72_contact_endpoint_definer
  USING (workspace_id = app_private.current_workspace_id());

GRANT CREATE ON SCHEMA app_private TO r72_contact_endpoint_definer;
SET LOCAL ROLE r72_contact_endpoint_definer;

/*
 * Attach and verify one email endpoint on an existing contact.
 *
 * It never creates a contact or an opportunity, and it structurally cannot:
 * this definer holds no privilege on either table. It never writes suppression
 * or consent either, so attaching an endpoint can neither grant permission nor
 * release an existing suppression.
 */
CREATE FUNCTION app_private.attach_verified_contact_email_endpoint(
  p_workspace_id uuid,
  p_contact_id uuid,
  p_email text,
  p_label text,
  p_evidence_source text,
  p_evidence_reference text,
  p_verified_at timestamptz,
  p_command_key_sha256 bytea
)
RETURNS TABLE (disposition text, contact_point_id uuid, receipt_id uuid)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
  selected_user_id uuid;
  selected_request_id text := current_setting('app.request_id', true);
  normalized text;
  existing_point_id uuid;
  existing_deleted timestamptz;
  selected_receipt app.contact_endpoint_verification_receipts%ROWTYPE;
  endpoint_identity bytea;
  computed_request_sha256 bytea;
  created_point_id uuid := gen_random_uuid();
  created_receipt_id uuid := gen_random_uuid();
BEGIN
  IF session_user <> 'r72_crm_command'
     OR p_workspace_id IS NULL OR p_contact_id IS NULL
     OR current_setting('app.workspace_id', true) IS DISTINCT FROM p_workspace_id::text
     OR current_setting('app.actor_kind', true) IS DISTINCT FROM 'user'
     OR coalesce(current_setting('app.user_id', true), '')
       !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR selected_request_id IS NULL
     OR selected_request_id <> btrim(selected_request_id)
     OR length(selected_request_id) NOT BETWEEN 1 AND 128
     OR p_email IS NULL OR p_email <> btrim(p_email)
     OR length(p_email) NOT BETWEEN 3 AND 320
     OR p_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
     OR (p_label IS NOT NULL AND length(btrim(p_label)) NOT BETWEEN 1 AND 50)
     OR p_evidence_source IS NULL
     OR p_evidence_source <> lower(btrim(p_evidence_source))
     OR p_evidence_source !~ '^[a-z][a-z0-9_.:-]{0,99}$'
     OR p_evidence_reference IS NULL
     OR p_evidence_reference <> btrim(p_evidence_reference)
     OR length(p_evidence_reference) NOT BETWEEN 1 AND 200
     OR p_verified_at IS NULL
     OR p_verified_at > statement_timestamp() + interval '5 minutes'
     OR p_command_key_sha256 IS NULL
     OR octet_length(p_command_key_sha256) <> 32 THEN
    RAISE EXCEPTION 'Contact email endpoint evidence is invalid' USING ERRCODE = '22023';
  END IF;
  selected_user_id := current_setting('app.user_id', true)::uuid;

  -- Founder rail: owner and admin only, matching the permission decision gate.
  IF NOT EXISTS (
    SELECT 1 FROM app.workspace_memberships AS membership
    WHERE membership.workspace_id = p_workspace_id
      AND membership.user_id = selected_user_id
      AND membership.status = 'active'
      AND membership.role IN ('owner', 'admin')
  ) THEN
    RAISE EXCEPTION 'Attaching a contact endpoint requires an active owner or admin'
      USING ERRCODE = '42501';
  END IF;

  normalized := lower(p_email);
  endpoint_identity := public.digest(
    'email' || pg_catalog.chr(31) || p_email || pg_catalog.chr(31) || normalized,
    'sha256'
  );
  computed_request_sha256 := public.digest(
    concat_ws(pg_catalog.chr(31),
      'propertypredator.contact-endpoint-attach/v1',
      p_workspace_id::text, p_contact_id::text, 'email', normalized,
      p_evidence_source, p_evidence_reference,
      pg_catalog.encode(endpoint_identity, 'hex'), selected_user_id::text),
    'sha256'
  );

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    format('pp-contact-endpoint:%s:%s', p_workspace_id, p_contact_id), 7200064
  ));

  SELECT receipt.* INTO selected_receipt
  FROM app.contact_endpoint_verification_receipts AS receipt
  WHERE receipt.workspace_id = p_workspace_id
    AND receipt.command_key_sha256 = p_command_key_sha256;
  IF FOUND THEN
    IF selected_receipt.request_sha256 IS DISTINCT FROM computed_request_sha256 THEN
      RAISE EXCEPTION 'Contact endpoint command key conflict' USING ERRCODE = '23505';
    END IF;
    RETURN QUERY SELECT 'replayed'::text,
      selected_receipt.contact_point_id, selected_receipt.id;
    RETURN;
  END IF;

  -- The contact must already exist. This command cannot create one: the
  -- definer has no privilege on app.contacts, so an unknown contact fails the
  -- endpoint insert's foreign key rather than quietly creating a duplicate.
  SELECT point.id, point.deleted_at INTO existing_point_id, existing_deleted
  FROM app.contact_points AS point
  WHERE point.workspace_id = p_workspace_id
    AND point.contact_id = p_contact_id
    AND point.kind = 'email'
    AND point.normalized_value = normalized
  ORDER BY point.created_at, point.id
  LIMIT 1;

  IF existing_point_id IS NOT NULL AND existing_deleted IS NOT NULL THEN
    -- A deleted endpoint is a deliberate act. Re-verifying it silently would
    -- undo that decision, so it is refused rather than resurrected here.
    RAISE EXCEPTION 'Contact email endpoint was deleted and cannot be re-verified here'
      USING ERRCODE = '42501';
  END IF;

  IF existing_point_id IS NULL THEN
    INSERT INTO app.contact_points (
      id, workspace_id, contact_id, kind, label, value, normalized_value,
      is_primary, is_verified, dedupe_state
    ) VALUES (
      created_point_id, p_workspace_id, p_contact_id, 'email',
      nullif(btrim(coalesce(p_label, '')), ''), p_email, normalized,
      false, true, 'normal'
    );
    existing_point_id := created_point_id;
  ELSE
    UPDATE app.contact_points AS point
    SET is_verified = true,
        updated_at = statement_timestamp(),
        row_version = point.row_version + 1
    WHERE point.workspace_id = p_workspace_id AND point.id = existing_point_id;
  END IF;

  INSERT INTO app.contact_endpoint_verification_receipts (
    id, workspace_id, command_key_sha256, request_sha256, contact_id,
    contact_point_id, kind, endpoint_identity_sha256, evidence_source,
    evidence_reference, verified_at, actor_user_id
  ) VALUES (
    created_receipt_id, p_workspace_id, p_command_key_sha256,
    computed_request_sha256, p_contact_id, existing_point_id, 'email',
    endpoint_identity, p_evidence_source, p_evidence_reference,
    p_verified_at, selected_user_id
  );

  RETURN QUERY SELECT 'applied'::text, existing_point_id, created_receipt_id;
END
$function$;

RESET ROLE;
SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private FROM r72_contact_endpoint_definer;

REVOKE ALL ON FUNCTION app_private.attach_verified_contact_email_endpoint(
  uuid, uuid, text, text, text, text, timestamptz, bytea
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.attach_verified_contact_email_endpoint(
  uuid, uuid, text, text, text, text, timestamptz, bytea
) TO r72_crm_command;

-- The readiness reader answers questions. It writes nothing anywhere.
GRANT SELECT ON app.contact_points, app.contacts, app.channel_endpoints,
  app.provider_connections, app.communication_consent_events,
  app.communication_suppression_events, app.messages, app.message_versions,
  app.message_approval_requests, app.message_approval_decisions,
  app.conversations, app.campaign_template_versions, app.campaign_template_steps,
  app.campaign_template_approval_requests, app.campaign_template_approval_decisions,
  app.property_predator_email_pilot_approved_content,
  app.property_predator_customer_email_jobs, app.workspace_memberships
  TO r72_email_pilot_readiness_definer;

GRANT CREATE ON SCHEMA app_private TO r72_email_pilot_readiness_definer;
SET LOCAL ROLE r72_email_pilot_readiness_definer;

/*
 * Resolve the evidence the capped enqueue demands and name what is missing.
 *
 * STABLE and read-only: it cannot enqueue, dispatch or reach Mailgun. It exists
 * so a founder is told which exact piece of evidence is absent instead of
 * meeting an opaque refusal from the enqueue itself.
 */
CREATE FUNCTION app_private.customer_email_pilot_readiness(
  p_workspace_id uuid,
  p_provider_connection_id uuid,
  p_contact_id uuid,
  p_contact_point_id uuid,
  p_purpose text
)
RETURNS TABLE (dimension text, ready boolean, blocker_code text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
  selected_user_id uuid;
  selected_point app.contact_points%ROWTYPE;
  endpoint_identity bytea;
  day_used integer;
  month_used integer;
BEGIN
  IF session_user <> 'r72_crm_command'
     OR p_workspace_id IS NULL
     OR current_setting('app.workspace_id', true) IS DISTINCT FROM p_workspace_id::text
     OR current_setting('app.actor_kind', true) IS DISTINCT FROM 'user'
     OR coalesce(current_setting('app.user_id', true), '')
       !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR p_purpose IS NULL OR p_purpose <> lower(btrim(p_purpose))
     OR p_purpose !~ '^[a-z][a-z0-9_.-]{0,99}$' THEN
    RAISE EXCEPTION 'Customer email pilot readiness denied' USING ERRCODE = '42501';
  END IF;
  selected_user_id := current_setting('app.user_id', true)::uuid;

  dimension := 'operator_authority';
  ready := EXISTS (
    SELECT 1 FROM app.workspace_memberships AS membership
    WHERE membership.workspace_id = p_workspace_id
      AND membership.user_id = selected_user_id
      AND membership.status = 'active'
      AND membership.role IN ('owner', 'admin')
  );
  blocker_code := CASE WHEN ready THEN NULL ELSE 'OPERATOR_NOT_AUTHORISED' END;
  RETURN NEXT;

  dimension := 'provider_connection';
  ready := EXISTS (
    SELECT 1 FROM app.provider_connections AS connection
    WHERE connection.workspace_id = p_workspace_id
      AND connection.id = p_provider_connection_id
      AND connection.provider_id = 'mailgun_eu'
      AND connection.provider_kind = 'email'
      AND connection.environment = 'live'
      AND connection.status = 'active'
  );
  blocker_code := CASE WHEN ready THEN NULL ELSE 'PROVIDER_NOT_CONFIGURED' END;
  RETURN NEXT;

  SELECT point.* INTO selected_point
  FROM app.contact_points AS point
  WHERE point.workspace_id = p_workspace_id
    AND point.id = p_contact_point_id
    AND point.contact_id = p_contact_id
    AND point.kind = 'email'
    AND point.deleted_at IS NULL;

  dimension := 'recipient_endpoint';
  ready := selected_point.id IS NOT NULL
    AND selected_point.is_verified
    AND selected_point.dedupe_state = 'normal';
  blocker_code := CASE WHEN ready THEN NULL ELSE 'RECIPIENT_ENDPOINT_MISSING' END;
  RETURN NEXT;

  endpoint_identity := CASE WHEN selected_point.id IS NULL THEN NULL ELSE public.digest(
    selected_point.kind || pg_catalog.chr(31) || selected_point.value
      || pg_catalog.chr(31) || selected_point.normalized_value,
    'sha256'
  ) END;

  dimension := 'sender_endpoint';
  ready := EXISTS (
    SELECT 1 FROM app.channel_endpoints AS endpoint
    WHERE endpoint.workspace_id = p_workspace_id
      AND endpoint.provider_connection_id = p_provider_connection_id
      AND endpoint.channel = 'email'
      AND endpoint.environment = 'live'
      AND endpoint.status = 'active'
  );
  blocker_code := CASE WHEN ready THEN NULL ELSE 'SENDER_ENDPOINT_MISSING' END;
  RETURN NEXT;

  dimension := 'current_consent';
  ready := endpoint_identity IS NOT NULL AND EXISTS (
    SELECT 1 FROM app.communication_consent_events AS consent
    WHERE consent.workspace_id = p_workspace_id
      AND consent.contact_id = p_contact_id
      AND consent.contact_point_id = p_contact_point_id
      AND consent.channel = 'email'
      AND consent.purpose = p_purpose
      AND consent.state = 'granted'
      AND consent.lawful_basis IS NOT NULL
      AND consent.endpoint_identity_sha256 = endpoint_identity
      AND consent.id = (
        SELECT latest.id FROM app.communication_consent_events AS latest
        WHERE latest.workspace_id = consent.workspace_id
          AND latest.contact_point_id = consent.contact_point_id
          AND latest.channel = 'email' AND latest.purpose = consent.purpose
        ORDER BY latest.occurred_at DESC, latest.recorded_at DESC, latest.id DESC
        LIMIT 1
      )
  );
  blocker_code := CASE WHEN ready THEN NULL ELSE 'CONSENT_NOT_GRANTED' END;
  RETURN NEXT;

  -- Latest-wins per scope, exactly as the enqueue evaluates it. A channel-wide
  -- suppression and a purpose-scoped one are separate timelines.
  dimension := 'suppression_clear';
  ready := NOT EXISTS (
    SELECT 1 FROM app.communication_suppression_events AS suppression
    WHERE suppression.workspace_id = p_workspace_id
      AND suppression.contact_point_id = p_contact_point_id
      AND suppression.channel = 'email'
      AND (suppression.purpose IS NULL OR suppression.purpose = p_purpose)
      AND suppression.state = 'suppressed'
      AND suppression.id = (
        SELECT latest.id FROM app.communication_suppression_events AS latest
        WHERE latest.workspace_id = suppression.workspace_id
          AND latest.contact_point_id = suppression.contact_point_id
          AND latest.channel = suppression.channel
          AND latest.purpose IS NOT DISTINCT FROM suppression.purpose
        ORDER BY latest.occurred_at DESC, latest.recorded_at DESC, latest.id DESC
        LIMIT 1
      )
  );
  blocker_code := CASE WHEN ready THEN NULL ELSE 'RECIPIENT_SUPPRESSED' END;
  RETURN NEXT;

  dimension := 'approved_campaign_version';
  ready := EXISTS (
    SELECT 1
    FROM app.campaign_template_approval_decisions AS decision
    JOIN app.campaign_template_approval_requests AS request
      ON request.workspace_id = decision.workspace_id
     AND request.id = decision.approval_request_id
    WHERE decision.workspace_id = p_workspace_id
      AND decision.decision = 'approved'
  );
  blocker_code := CASE WHEN ready THEN NULL ELSE 'CAMPAIGN_APPROVAL_REQUIRED' END;
  RETURN NEXT;

  dimension := 'approved_message_version';
  ready := EXISTS (
    SELECT 1
    FROM app.message_approval_decisions AS decision
    JOIN app.message_approval_requests AS request
      ON request.workspace_id = decision.workspace_id
     AND request.id = decision.approval_request_id
    JOIN app.messages AS message
      ON message.workspace_id = request.workspace_id
     AND message.id = request.message_id
    WHERE decision.workspace_id = p_workspace_id
      AND decision.decision = 'approved'
      AND message.channel = 'email'
      AND message.direction = 'outbound'
  );
  blocker_code := CASE WHEN ready THEN NULL ELSE 'MESSAGE_APPROVAL_REQUIRED' END;
  RETURN NEXT;

  dimension := 'approved_pilot_content';
  ready := EXISTS (
    SELECT 1 FROM app.property_predator_email_pilot_approved_content AS approved
    WHERE approved.workspace_id = p_workspace_id
  );
  blocker_code := CASE WHEN ready THEN NULL ELSE 'PILOT_CONTENT_NOT_APPROVED' END;
  RETURN NEXT;

  SELECT coalesce(count(*), 0)::integer INTO day_used
  FROM app.property_predator_customer_email_jobs AS job
  WHERE job.workspace_id = p_workspace_id
    AND job.provider_connection_id = p_provider_connection_id
    AND job.utc_day = (statement_timestamp() AT TIME ZONE 'UTC')::date
    AND job.state <> 'cancelled';
  SELECT coalesce(count(*), 0)::integer INTO month_used
  FROM app.property_predator_customer_email_jobs AS job
  WHERE job.workspace_id = p_workspace_id
    AND job.provider_connection_id = p_provider_connection_id
    AND job.utc_month = date_trunc('month', statement_timestamp() AT TIME ZONE 'UTC')::date
    AND job.state <> 'cancelled';

  dimension := 'cap_headroom';
  ready := day_used < 10 AND month_used < 50;
  blocker_code := CASE WHEN ready THEN NULL ELSE 'CAP_REACHED' END;
  RETURN NEXT;

  RETURN;
END
$function$;

RESET ROLE;
SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private FROM r72_email_pilot_readiness_definer;

REVOKE ALL ON FUNCTION app_private.customer_email_pilot_readiness(
  uuid, uuid, uuid, uuid, text
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.customer_email_pilot_readiness(
  uuid, uuid, uuid, uuid, text
) TO r72_crm_command;

-- Attaching an endpoint must never be able to create a contact, an opportunity,
-- or a permission. This is structural rather than a promise about the body.
DO $endpoint_isolation_audit$
DECLARE target text; privilege text;
BEGIN
  FOREACH target IN ARRAY ARRAY[
    'app.contacts', 'app.opportunities',
    'app.communication_suppression_events', 'app.communication_consent_events'
  ] LOOP
    FOREACH privilege IN ARRAY ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] LOOP
      IF pg_catalog.has_table_privilege('r72_contact_endpoint_definer', target, privilege) THEN
        RAISE EXCEPTION 'The contact endpoint definer must never hold % on %',
          privilege, target USING ERRCODE = '42501';
      END IF;
    END LOOP;
  END LOOP;
END
$endpoint_isolation_audit$;

-- The readiness reader answers questions and must never change anything.
DO $readiness_isolation_audit$
DECLARE target text; privilege text;
BEGIN
  FOREACH target IN ARRAY ARRAY[
    'app.contact_points', 'app.contacts', 'app.communication_consent_events',
    'app.communication_suppression_events',
    'app.property_predator_customer_email_jobs'
  ] LOOP
    FOREACH privilege IN ARRAY ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] LOOP
      IF pg_catalog.has_table_privilege(
           'r72_email_pilot_readiness_definer', target, privilege
         ) THEN
        RAISE EXCEPTION 'The email pilot readiness definer must never hold % on %',
          privilege, target USING ERRCODE = '42501';
      END IF;
    END LOOP;
  END LOOP;
END
$readiness_isolation_audit$;

-- The command identity may only call the two functions; it holds no direct
-- privilege on the endpoint receipt ledger.
DO $command_blindness_audit$
DECLARE privilege text;
BEGIN
  FOREACH privilege IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] LOOP
    IF pg_catalog.has_table_privilege(
         'r72_crm_command', 'app.contact_endpoint_verification_receipts', privilege
       ) THEN
      RAISE EXCEPTION 'r72_crm_command must not hold % on the endpoint receipt ledger',
        privilege USING ERRCODE = '42501';
    END IF;
  END LOOP;
  IF NOT pg_catalog.has_function_privilege(
       'r72_crm_command',
       'app_private.attach_verified_contact_email_endpoint(uuid, uuid, text, text,'
         || ' text, text, timestamptz, bytea)', 'EXECUTE')
     OR NOT pg_catalog.has_function_privilege(
       'r72_crm_command',
       'app_private.customer_email_pilot_readiness(uuid, uuid, uuid, uuid, text)',
       'EXECUTE') THEN
    RAISE EXCEPTION 'r72_crm_command must execute the founder email pilot functions'
      USING ERRCODE = '42501';
  END IF;
END
$command_blindness_audit$;
