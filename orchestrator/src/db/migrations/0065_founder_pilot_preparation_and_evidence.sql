-- Two activation blockers that no amount of TypeScript could close.
--
-- First, the owned-seed preparation path is structurally locked to one address.
-- 0047 and 0048 do not merely default to office@propertypredator.com: they
-- compare against it, digest it and join on it, in the staging function, the
-- message creator and every approval step. Both are applied, so they are not
-- edited here. This migration adds a forward-only preparation boundary that
-- builds the same tuple against whichever verified email endpoint is named,
-- resolved from the contact record and never written down anywhere.
--
-- Second, the affiliate compliance foundation has the tables and the roles for
-- policy review, publication and PECR route decisions, but nothing composed
-- records them. The enqueue cannot be satisfied without them. This migration
-- adds the smallest owner/admin workflow that records exactly those facts.
--
-- It records; it does not decide. Every specialist reference, decision digest
-- and occurrence time is supplied by the founder and stored as their
-- attestation. Nothing here approves anything on a solicitor's behalf, and
-- nothing is seeded: an absent reference is a refusal, not a default.
--
-- Neither function calls a provider, creates a delivery intent, enqueues, or
-- writes consent or suppression. Audits below fail the apply if either definer
-- ever holds the privilege to.

DO $roles$
DECLARE unsafe_parent text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'r72_crm_command'
  ) THEN
    RAISE EXCEPTION 'r72_crm_command must exist before the founder pilot rail'
      USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'r72_founder_pilot_evidence_command'
  ) THEN
    CREATE ROLE r72_founder_pilot_evidence_command NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'r72_founder_pilot_prep_definer'
  ) THEN
    CREATE ROLE r72_founder_pilot_prep_definer NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'r72_founder_pilot_evidence_definer'
  ) THEN
    CREATE ROLE r72_founder_pilot_evidence_definer NOLOGIN NOINHERIT;
  END IF;
  FOR unsafe_parent IN
    SELECT candidate FROM (VALUES
      ('r72_founder_pilot_prep_definer'), ('r72_founder_pilot_evidence_definer')
    ) AS roles(candidate)
    WHERE NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_roles
      WHERE rolname = roles.candidate
        AND NOT rolcanlogin AND NOT rolinherit AND NOT rolsuper
        AND NOT rolcreatedb AND NOT rolcreaterole
        AND NOT rolreplication AND NOT rolbypassrls
    )
  LOOP
    RAISE EXCEPTION 'Unsafe founder pilot definer attributes: %', unsafe_parent
      USING ERRCODE = '42501';
  END LOOP;
  REVOKE r72_owner, r72_security_definer, r72_contact_endpoint_definer,
    r72_email_pilot_readiness_definer
    FROM r72_founder_pilot_prep_definer, r72_founder_pilot_evidence_definer;
  REVOKE r72_founder_pilot_prep_definer, r72_founder_pilot_evidence_definer
    FROM r72_web, r72_public, r72_worker, r72_webhook, r72_readonly,
      r72_crm_command, r72_customer_email_command, r72_affiliate_receipt_command,
      r72_founder_pilot_evidence_command;
  -- Preparing content and recording legal evidence are separate acts and stay
  -- separate privileges: neither definer may inherit the other.
  REVOKE r72_founder_pilot_prep_definer FROM r72_founder_pilot_evidence_definer;
  REVOKE r72_founder_pilot_evidence_definer FROM r72_founder_pilot_prep_definer;
  SELECT parent.rolname INTO unsafe_parent
  FROM pg_catalog.pg_auth_members AS membership
  JOIN pg_catalog.pg_roles AS member ON member.oid = membership.member
  JOIN pg_catalog.pg_roles AS parent ON parent.oid = membership.roleid
  WHERE member.rolname IN (
    'r72_founder_pilot_prep_definer', 'r72_founder_pilot_evidence_definer'
  )
  LIMIT 1;
  IF unsafe_parent IS NOT NULL THEN
    RAISE EXCEPTION 'Unsafe founder pilot definer parent: %', unsafe_parent
      USING ERRCODE = '42501';
  END IF;
  GRANT r72_founder_pilot_prep_definer, r72_founder_pilot_evidence_definer
    TO r72_owner;
END
$roles$;

SET LOCAL ROLE r72_owner;

-- Append-only proof of each founder preparation, keyed so a resubmission is a
-- replay and altered content under the same key is a conflict.
CREATE TABLE app.founder_pilot_preparation_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE RESTRICT,
  command_key_sha256 bytea NOT NULL CHECK (octet_length(command_key_sha256) = 32),
  request_sha256 bytea NOT NULL CHECK (octet_length(request_sha256) = 32),
  contact_id uuid NOT NULL,
  contact_point_id uuid NOT NULL,
  purpose text NOT NULL CHECK (purpose ~ '^[a-z][a-z0-9_.-]{0,99}$'),
  campaign_template_version_id uuid NOT NULL,
  campaign_template_step_id uuid NOT NULL,
  campaign_approval_request_id uuid NOT NULL,
  campaign_approval_decision_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  message_id uuid NOT NULL,
  message_version_id uuid NOT NULL,
  message_approval_request_id uuid NOT NULL,
  message_approval_decision_id uuid NOT NULL,
  approved_content_id uuid NOT NULL,
  subject_sha256 bytea NOT NULL CHECK (octet_length(subject_sha256) = 32),
  body_sha256 bytea NOT NULL CHECK (octet_length(body_sha256) = 32),
  -- Structural, not decorative: this boundary exists precisely because it must
  -- never stage, dispatch or reserve a send.
  provider_effects boolean NOT NULL DEFAULT false CHECK (provider_effects IS FALSE),
  delivery_intent_created boolean NOT NULL DEFAULT false
    CHECK (delivery_intent_created IS FALSE),
  actor_user_id uuid NOT NULL,
  recorded_request_id text NOT NULL CHECK (
    recorded_request_id = btrim(recorded_request_id)
    AND length(recorded_request_id) BETWEEN 1 AND 128
  ),
  recorded_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, command_key_sha256),
  FOREIGN KEY (workspace_id, actor_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id) ON DELETE RESTRICT
);

CREATE TABLE app.founder_pilot_evidence_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE RESTRICT,
  command_key_sha256 bytea NOT NULL CHECK (octet_length(command_key_sha256) = 32),
  request_sha256 bytea NOT NULL CHECK (octet_length(request_sha256) = 32),
  action_scope_sha256 bytea NOT NULL CHECK (octet_length(action_scope_sha256) = 32),
  compliance_subject_id uuid NOT NULL,
  policy_pack_id uuid NOT NULL,
  legal_review_event_id uuid NOT NULL,
  commercial_review_event_id uuid NOT NULL,
  policy_publication_event_id uuid NOT NULL,
  pecr_sender_decision_event_id uuid NOT NULL,
  pecr_instigator_decision_event_id uuid NOT NULL,
  provider_effects boolean NOT NULL DEFAULT false CHECK (provider_effects IS FALSE),
  actor_user_id uuid NOT NULL,
  recorded_request_id text NOT NULL CHECK (
    recorded_request_id = btrim(recorded_request_id)
    AND length(recorded_request_id) BETWEEN 1 AND 128
  ),
  recorded_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, command_key_sha256),
  FOREIGN KEY (workspace_id, actor_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id) ON DELETE RESTRICT
);

ALTER TABLE app.founder_pilot_preparation_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.founder_pilot_preparation_receipts FORCE ROW LEVEL SECURITY;
ALTER TABLE app.founder_pilot_evidence_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.founder_pilot_evidence_receipts FORCE ROW LEVEL SECURITY;

CREATE FUNCTION app_private.reject_founder_pilot_receipt_mutation()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog AS $function$
BEGIN
  RAISE EXCEPTION 'Founder pilot receipts are append-only' USING ERRCODE = '42501';
END
$function$;
REVOKE ALL ON FUNCTION app_private.reject_founder_pilot_receipt_mutation() FROM PUBLIC;

CREATE TRIGGER founder_pilot_preparation_receipts_immutable
BEFORE UPDATE OR DELETE ON app.founder_pilot_preparation_receipts
FOR EACH ROW EXECUTE FUNCTION app_private.reject_founder_pilot_receipt_mutation();
CREATE TRIGGER founder_pilot_evidence_receipts_immutable
BEFORE UPDATE OR DELETE ON app.founder_pilot_evidence_receipts
FOR EACH ROW EXECUTE FUNCTION app_private.reject_founder_pilot_receipt_mutation();

GRANT SELECT, INSERT ON app.founder_pilot_preparation_receipts
  TO r72_founder_pilot_prep_definer;
GRANT SELECT, INSERT ON app.founder_pilot_evidence_receipts
  TO r72_founder_pilot_evidence_definer;
GRANT SELECT ON app.founder_pilot_preparation_receipts,
  app.founder_pilot_evidence_receipts TO r72_web;

CREATE POLICY founder_pilot_prep_receipts_write
  ON app.founder_pilot_preparation_receipts FOR INSERT
  TO r72_founder_pilot_prep_definer
  WITH CHECK (workspace_id = app_private.current_workspace_id());
CREATE POLICY founder_pilot_prep_receipts_read
  ON app.founder_pilot_preparation_receipts FOR SELECT
  TO r72_founder_pilot_prep_definer
  USING (workspace_id = app_private.current_workspace_id());
CREATE POLICY founder_pilot_prep_receipts_web_read
  ON app.founder_pilot_preparation_receipts FOR SELECT TO r72_web
  USING (workspace_id = app_private.current_workspace_id());
CREATE POLICY founder_pilot_evidence_receipts_write
  ON app.founder_pilot_evidence_receipts FOR INSERT
  TO r72_founder_pilot_evidence_definer
  WITH CHECK (workspace_id = app_private.current_workspace_id());
CREATE POLICY founder_pilot_evidence_receipts_read
  ON app.founder_pilot_evidence_receipts FOR SELECT
  TO r72_founder_pilot_evidence_definer
  USING (workspace_id = app_private.current_workspace_id());
CREATE POLICY founder_pilot_evidence_receipts_web_read
  ON app.founder_pilot_evidence_receipts FOR SELECT TO r72_web
  USING (workspace_id = app_private.current_workspace_id());

REVOKE ALL ON SCHEMA app, app_private
  FROM r72_founder_pilot_prep_definer, r72_founder_pilot_evidence_definer;
GRANT USAGE ON SCHEMA app, app_private
  TO r72_founder_pilot_prep_definer, r72_founder_pilot_evidence_definer;
GRANT EXECUTE ON FUNCTION app_private.current_workspace_id(),
  app_private.current_user_id(), app_private.current_actor_kind()
  TO r72_founder_pilot_prep_definer, r72_founder_pilot_evidence_definer;

-- Preparation reads the contact record to resolve the endpoint, and writes only
-- the content chain. It holds nothing on the delivery, provider or job tables.
GRANT SELECT ON app.contact_points, app.contacts, app.workspace_memberships,
  app.inboxes, app.channel_endpoints, app.provider_connections,
  app.conversion_journey_versions, app.conversion_journey_milestones
  TO r72_founder_pilot_prep_definer;
GRANT SELECT, INSERT ON app.campaign_templates, app.campaign_template_versions,
  app.campaign_template_steps, app.campaign_template_approval_requests,
  app.campaign_template_approval_decisions, app.conversations, app.messages,
  app.message_versions, app.message_approval_requests,
  app.message_approval_decisions,
  app.property_predator_email_pilot_approved_content
  TO r72_founder_pilot_prep_definer;
GRANT UPDATE (lifecycle, row_version, updated_at) ON app.messages
  TO r72_founder_pilot_prep_definer;

DO $prep_policies$
DECLARE target text;
BEGIN
  FOREACH target IN ARRAY ARRAY[
    'contact_points', 'contacts', 'workspace_memberships', 'inboxes',
    'channel_endpoints', 'provider_connections', 'conversion_journey_versions',
    'conversion_journey_milestones'
  ] LOOP
    EXECUTE pg_catalog.format(
      'CREATE POLICY %I ON app.%I FOR SELECT TO r72_founder_pilot_prep_definer
       USING (workspace_id = app_private.current_workspace_id())',
      'founder_pilot_prep_' || target || '_select', target
    );
  END LOOP;
  FOREACH target IN ARRAY ARRAY[
    'campaign_templates', 'campaign_template_versions', 'campaign_template_steps',
    'campaign_template_approval_requests', 'campaign_template_approval_decisions',
    'conversations', 'messages', 'message_versions', 'message_approval_requests',
    'message_approval_decisions', 'property_predator_email_pilot_approved_content'
  ] LOOP
    EXECUTE pg_catalog.format(
      'CREATE POLICY %I ON app.%I FOR SELECT TO r72_founder_pilot_prep_definer
       USING (workspace_id = app_private.current_workspace_id())',
      'founder_pilot_prep_' || target || '_select', target
    );
    EXECUTE pg_catalog.format(
      'CREATE POLICY %I ON app.%I FOR INSERT TO r72_founder_pilot_prep_definer
       WITH CHECK (workspace_id = app_private.current_workspace_id())',
      'founder_pilot_prep_' || target || '_insert', target
    );
  END LOOP;
  EXECUTE 'CREATE POLICY founder_pilot_prep_messages_update ON app.messages
    FOR UPDATE TO r72_founder_pilot_prep_definer
    USING (workspace_id = app_private.current_workspace_id()
      AND channel = ''email'' AND environment = ''live''
      AND direction = ''outbound'')
    WITH CHECK (workspace_id = app_private.current_workspace_id()
      AND channel = ''email'' AND environment = ''live''
      AND direction = ''outbound'')';
END
$prep_policies$;

GRANT CREATE ON SCHEMA app_private TO r72_founder_pilot_prep_definer;
SET LOCAL ROLE r72_founder_pilot_prep_definer;

/*
 * Build the exact content tuple the capped enqueue re-validates, for whichever
 * verified email endpoint is named.
 *
 * The recipient is resolved from app.contact_points by identifier alone. No
 * address is compared, digested or stored here, which is the whole difference
 * between this and the 0047/0048 path it exists to replace.
 *
 * It creates no provider operation, no message delivery and no job. The receipt
 * it writes records that fact with two constraints that cannot be satisfied any
 * other way.
 */
CREATE FUNCTION app_private.prepare_founder_email_pilot_content(
  p_workspace_id uuid,
  p_provider_connection_id uuid,
  p_contact_id uuid,
  p_contact_point_id uuid,
  p_purpose text,
  p_subject text,
  p_body text,
  p_source_content_version_ref text,
  p_source_content_sha256 bytea,
  p_command_key_sha256 bytea
)
RETURNS TABLE (
  disposition text,
  campaign_template_version_id uuid, campaign_template_step_id uuid,
  campaign_approval_request_id uuid, campaign_approval_decision_id uuid,
  conversation_id uuid, message_id uuid, message_version_id uuid,
  message_approval_request_id uuid, message_approval_decision_id uuid,
  approved_content_id uuid
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
  selected_user_id uuid;
  selected_request_id text := current_setting('app.request_id', true);
  selected_point app.contact_points%ROWTYPE;
  selected_inbox_id uuid;
  selected_journey_version_id uuid;
  selected_entry_milestone_id uuid;
  selected_target_milestone_id uuid;
  selected_receipt app.founder_pilot_preparation_receipts%ROWTYPE;
  computed_request_sha256 bytea;
  selected_subject_sha bytea;
  selected_body_sha bytea;
  selected_step_content_sha bytea;
  selected_definition jsonb;
  selected_definition_sha bytea;
  created_template_id uuid;
  created_version_id uuid := gen_random_uuid();
  created_step_id uuid := gen_random_uuid();
  created_campaign_request_id uuid := gen_random_uuid();
  created_campaign_decision_id uuid := gen_random_uuid();
  created_conversation_id uuid := gen_random_uuid();
  created_message_id uuid := gen_random_uuid();
  created_message_version_id uuid := gen_random_uuid();
  created_message_request_id uuid := gen_random_uuid();
  created_message_decision_id uuid := gen_random_uuid();
  created_approved_content_id uuid := gen_random_uuid();
  next_version_no integer;
  next_request_no integer;
BEGIN
  IF session_user <> 'r72_crm_command'
     OR p_workspace_id IS NULL OR p_contact_id IS NULL OR p_contact_point_id IS NULL
     OR current_setting('app.workspace_id', true) IS DISTINCT FROM p_workspace_id::text
     OR current_setting('app.actor_kind', true) IS DISTINCT FROM 'user'
     OR coalesce(current_setting('app.user_id', true), '')
       !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR selected_request_id IS NULL
     OR selected_request_id <> btrim(selected_request_id)
     OR length(selected_request_id) NOT BETWEEN 1 AND 128
     OR p_purpose IS NULL OR p_purpose !~ '^[a-z][a-z0-9_.-]{0,99}$'
     OR p_subject IS NULL OR p_subject <> btrim(p_subject)
     OR length(p_subject) NOT BETWEEN 1 AND 240
     OR p_body IS NULL OR p_body <> btrim(p_body)
     OR length(p_body) NOT BETWEEN 1 AND 12000
     -- The approved copy must name no recipient. The campaign step column
     -- enforces this too; refusing here gives the founder the real reason.
     OR p_subject ~* '[A-Z0-9._%+-]+@[A-Z0-9.-]+[.][A-Z]{2,}'
     OR p_body ~* '[A-Z0-9._%+-]+@[A-Z0-9.-]+[.][A-Z]{2,}'
     OR p_command_key_sha256 IS NULL OR octet_length(p_command_key_sha256) <> 32
     OR (p_source_content_sha256 IS NOT NULL
       AND octet_length(p_source_content_sha256) <> 32) THEN
    RAISE EXCEPTION 'Founder pilot preparation evidence is invalid'
      USING ERRCODE = '22023';
  END IF;
  selected_user_id := current_setting('app.user_id', true)::uuid;
  IF NOT EXISTS (
    SELECT 1 FROM app.workspace_memberships AS membership
    WHERE membership.workspace_id = p_workspace_id
      AND membership.user_id = selected_user_id
      AND membership.status = 'active' AND membership.role IN ('owner', 'admin')
  ) THEN
    RAISE EXCEPTION 'Preparing founder pilot content requires an active owner or admin'
      USING ERRCODE = '42501';
  END IF;

  -- The endpoint is resolved by identifier and must already be verified. No
  -- address literal appears anywhere in this function.
  SELECT point.* INTO selected_point
  FROM app.contact_points AS point
  WHERE point.workspace_id = p_workspace_id
    AND point.id = p_contact_point_id
    AND point.contact_id = p_contact_id
    AND point.kind = 'email'
    AND point.deleted_at IS NULL
    AND point.is_verified
    AND point.dedupe_state = 'normal';
  IF selected_point.id IS NULL THEN
    RAISE EXCEPTION 'Founder pilot preparation requires a verified email endpoint'
      USING ERRCODE = '42501';
  END IF;

  selected_subject_sha := public.digest(p_subject, 'sha256');
  selected_body_sha := public.digest(p_body, 'sha256');
  -- The digest binds the endpoint, the exact copy and the operator. Changing
  -- any of them under the same command key is a conflict, not a second draft.
  computed_request_sha256 := public.digest(pg_catalog.concat_ws(pg_catalog.chr(31),
    'propertypredator.founder-pilot-preparation/v1', p_workspace_id::text,
    p_provider_connection_id::text, p_contact_id::text, p_contact_point_id::text,
    p_purpose, pg_catalog.encode(selected_subject_sha, 'hex'),
    pg_catalog.encode(selected_body_sha, 'hex'),
    coalesce(p_source_content_version_ref, ''),
    coalesce(pg_catalog.encode(p_source_content_sha256, 'hex'), ''),
    selected_user_id::text
  ), 'sha256');

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    format('pp-founder-pilot-prep:%s:%s', p_workspace_id, p_contact_point_id), 7200065
  ));
  SELECT receipt.* INTO selected_receipt
  FROM app.founder_pilot_preparation_receipts AS receipt
  WHERE receipt.workspace_id = p_workspace_id
    AND receipt.command_key_sha256 = p_command_key_sha256;
  IF FOUND THEN
    IF selected_receipt.request_sha256 IS DISTINCT FROM computed_request_sha256 THEN
      RAISE EXCEPTION 'Founder pilot preparation command key conflict'
        USING ERRCODE = '23505';
    END IF;
    RETURN QUERY SELECT 'replayed'::text,
      selected_receipt.campaign_template_version_id,
      selected_receipt.campaign_template_step_id,
      selected_receipt.campaign_approval_request_id,
      selected_receipt.campaign_approval_decision_id,
      selected_receipt.conversation_id, selected_receipt.message_id,
      selected_receipt.message_version_id,
      selected_receipt.message_approval_request_id,
      selected_receipt.message_approval_decision_id,
      selected_receipt.approved_content_id;
    RETURN;
  END IF;

  SELECT inbox.id INTO selected_inbox_id
  FROM app.inboxes AS inbox
  WHERE inbox.workspace_id = p_workspace_id
    AND inbox.provider_connection_id = p_provider_connection_id
    AND inbox.channel = 'email' AND inbox.environment = 'live'
    AND inbox.status = 'active'
  ORDER BY inbox.created_at, inbox.id LIMIT 1;
  IF selected_inbox_id IS NULL THEN
    RAISE EXCEPTION 'Founder pilot preparation requires an active live email inbox'
      USING ERRCODE = '42501';
  END IF;

  -- The journey the campaign hangs from already exists as ordinary product
  -- data. Preparation binds to it rather than inventing one.
  SELECT version.id INTO selected_journey_version_id
  FROM app.conversion_journey_versions AS version
  WHERE version.workspace_id = p_workspace_id
  ORDER BY version.created_at DESC, version.id DESC LIMIT 1;
  IF selected_journey_version_id IS NULL THEN
    RAISE EXCEPTION 'Founder pilot preparation requires a conversion journey version'
      USING ERRCODE = '42501';
  END IF;
  SELECT milestone.id INTO selected_entry_milestone_id
  FROM app.conversion_journey_milestones AS milestone
  WHERE milestone.workspace_id = p_workspace_id
    AND milestone.journey_version_id = selected_journey_version_id
  ORDER BY milestone.position, milestone.id LIMIT 1;
  SELECT milestone.id INTO selected_target_milestone_id
  FROM app.conversion_journey_milestones AS milestone
  WHERE milestone.workspace_id = p_workspace_id
    AND milestone.journey_version_id = selected_journey_version_id
    AND milestone.id <> selected_entry_milestone_id
  ORDER BY milestone.position DESC, milestone.id DESC LIMIT 1;
  IF selected_entry_milestone_id IS NULL OR selected_target_milestone_id IS NULL THEN
    RAISE EXCEPTION 'Founder pilot preparation requires two journey milestones'
      USING ERRCODE = '42501';
  END IF;

  SELECT template.id INTO created_template_id
  FROM app.campaign_templates AS template
  WHERE template.workspace_id = p_workspace_id
    AND template.template_key = 'founder-email-pilot';
  IF created_template_id IS NULL THEN
    created_template_id := gen_random_uuid();
    INSERT INTO app.campaign_templates (
      id, workspace_id, template_key, name, description,
      owner_specialist_id, created_by_user_id
    ) VALUES (
      created_template_id, p_workspace_id, 'founder-email-pilot',
      'Founder email pilot',
      'One capped, approval-bound email to a single verified founder endpoint. '
      || 'It exists to prove the live loop end to end and authorises no other send.',
      'propertypredator.founder-pilot', selected_user_id
    );
  END IF;

  SELECT coalesce(max(version.version_no), 0) + 1 INTO next_version_no
  FROM app.campaign_template_versions AS version
  WHERE version.workspace_id = p_workspace_id
    AND version.template_id = created_template_id;

  selected_definition := jsonb_build_object(
    'schema', 'propertypredator.founder-email-pilot/v1',
    'purposeKey', p_purpose,
    'subjectSha256', pg_catalog.encode(selected_subject_sha, 'hex'),
    'bodySha256', pg_catalog.encode(selected_body_sha, 'hex'),
    'versionNo', next_version_no,
    'providerEffects', false
  );
  selected_definition_sha := public.digest(selected_definition::text, 'sha256');

  INSERT INTO app.campaign_template_versions (
    id, workspace_id, template_id, version_no, definition, definition_sha256,
    brand_brain_source_release_id, brand_brain_manifest_sha256,
    canonical_brand_version, specialist_chain, licensed_method_ids, laps_track,
    journey_version_id, entry_milestone_id, target_milestone_id,
    purpose_key, provider_effects, created_by_user_id
  ) VALUES (
    created_version_id, p_workspace_id, created_template_id, next_version_no,
    selected_definition, selected_definition_sha,
    created_template_id, selected_definition_sha,
    'founder-pilot-v1',
    '["propertypredator.founder-pilot"]'::jsonb, '[]'::jsonb, 'agency',
    selected_journey_version_id, selected_entry_milestone_id,
    selected_target_milestone_id, p_purpose, false, selected_user_id
  );

  selected_step_content_sha := public.digest(
    pg_catalog.convert_to(
      p_subject || pg_catalog.chr(31) || '' || pg_catalog.chr(31)
      || p_body || pg_catalog.chr(31) || '',
      'UTF8'
    ),
    'sha256'
  );
  INSERT INTO app.campaign_template_steps (
    id, workspace_id, template_version_id, journey_version_id, position,
    step_key, step_kind, channel, delay_minutes, trigger_event_key,
    target_milestone_id, owned_specialist_id, subject_template, body_template,
    content_sha256, requires_human_approval, requires_current_permission,
    stop_condition_keys, reporting_step_key, provider_effects
  ) VALUES (
    created_step_id, p_workspace_id, created_version_id,
    selected_journey_version_id, 1, 'founder-proof', 'email', 'email', 0,
    'founder.pilot.authorised', selected_target_milestone_id,
    'propertypredator.founder-pilot', p_subject, p_body,
    selected_step_content_sha, true, true,
    '["consent_withdrawn", "suppressed", "reply_received"]'::jsonb,
    'founder.pilot.proof', false
  );

  SELECT coalesce(max(request.request_no), 0) + 1 INTO next_request_no
  FROM app.campaign_template_approval_requests AS request
  WHERE request.workspace_id = p_workspace_id
    AND request.template_version_id = created_version_id;
  INSERT INTO app.campaign_template_approval_requests (
    id, workspace_id, template_version_id, template_version_sha256,
    request_no, review_dimensions, requested_by_user_id
  ) VALUES (
    created_campaign_request_id, p_workspace_id, created_version_id,
    selected_definition_sha, next_request_no,
    '["brand","truth","laps","consent","channel"]'::jsonb, selected_user_id
  );
  INSERT INTO app.campaign_template_approval_decisions (
    id, workspace_id, approval_request_id, template_version_id,
    template_version_sha256, decision, decided_by_user_id
  ) VALUES (
    created_campaign_decision_id, p_workspace_id, created_campaign_request_id,
    created_version_id, selected_definition_sha, 'approved', selected_user_id
  );

  INSERT INTO app.conversations (
    id, workspace_id, inbox_id, channel, environment, contact_id, state, subject
  ) VALUES (
    created_conversation_id, p_workspace_id, selected_inbox_id, 'email', 'live',
    p_contact_id, 'open', p_subject
  );
  INSERT INTO app.messages (
    id, workspace_id, conversation_id, contact_id, contact_point_id,
    channel, environment, direction, lifecycle, source_kind,
    current_version_id, current_version_number, current_body_sha256,
    created_by_actor_kind, created_by_user_id, occurred_at
  ) VALUES (
    created_message_id, p_workspace_id, created_conversation_id,
    p_contact_id, p_contact_point_id, 'email', 'live', 'outbound', 'draft',
    'user', created_message_version_id, 1, selected_body_sha,
    'user', selected_user_id, statement_timestamp()
  );
  INSERT INTO app.message_versions (
    id, workspace_id, conversation_id, message_id, channel, environment,
    version_number, body_text, source_content_version_ref, source_content_sha256,
    created_by_actor_kind, created_by_user_id, created_request_id
  ) VALUES (
    created_message_version_id, p_workspace_id, created_conversation_id,
    created_message_id, 'email', 'live', 1, p_body,
    p_source_content_version_ref, p_source_content_sha256,
    'user', selected_user_id, selected_request_id
  );
  INSERT INTO app.message_approval_requests (
    id, workspace_id, conversation_id, message_id, message_version_id,
    version_number, body_sha256, request_number, requested_by_user_id,
    requested_request_id
  ) VALUES (
    created_message_request_id, p_workspace_id, created_conversation_id,
    created_message_id, created_message_version_id, 1, selected_body_sha, 1,
    selected_user_id, selected_request_id
  );
  INSERT INTO app.message_approval_decisions (
    id, workspace_id, conversation_id, message_id, message_version_id,
    approval_request_id, version_number, body_sha256, decision,
    decided_by_user_id, decided_request_id
  ) VALUES (
    created_message_decision_id, p_workspace_id, created_conversation_id,
    created_message_id, created_message_version_id, created_message_request_id,
    1, selected_body_sha, 'approved', selected_user_id, selected_request_id
  );
  UPDATE app.messages SET lifecycle = 'approved',
    row_version = row_version + 1, updated_at = statement_timestamp()
  WHERE workspace_id = p_workspace_id AND id = created_message_id;

  INSERT INTO app.property_predator_email_pilot_approved_content (
    id, workspace_id, message_version_id, approval_request_id,
    approval_decision_id, subject_sha256, body_sha256, approved_content_sha256
  ) VALUES (
    created_approved_content_id, p_workspace_id, created_message_version_id,
    created_message_request_id, created_message_decision_id,
    selected_subject_sha, selected_body_sha, selected_step_content_sha
  );

  INSERT INTO app.founder_pilot_preparation_receipts (
    workspace_id, command_key_sha256, request_sha256, contact_id,
    contact_point_id, purpose, campaign_template_version_id,
    campaign_template_step_id, campaign_approval_request_id,
    campaign_approval_decision_id, conversation_id, message_id,
    message_version_id, message_approval_request_id,
    message_approval_decision_id, approved_content_id, subject_sha256,
    body_sha256, provider_effects, delivery_intent_created, actor_user_id,
    recorded_request_id
  ) VALUES (
    p_workspace_id, p_command_key_sha256, computed_request_sha256, p_contact_id,
    p_contact_point_id, p_purpose, created_version_id, created_step_id,
    created_campaign_request_id, created_campaign_decision_id,
    created_conversation_id, created_message_id, created_message_version_id,
    created_message_request_id, created_message_decision_id,
    created_approved_content_id, selected_subject_sha, selected_body_sha,
    false, false, selected_user_id, selected_request_id
  );

  RETURN QUERY SELECT 'prepared'::text, created_version_id, created_step_id,
    created_campaign_request_id, created_campaign_decision_id,
    created_conversation_id, created_message_id, created_message_version_id,
    created_message_request_id, created_message_decision_id,
    created_approved_content_id;
END
$function$;

RESET ROLE;
SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private FROM r72_founder_pilot_prep_definer;

REVOKE ALL ON FUNCTION app_private.prepare_founder_email_pilot_content(
  uuid, uuid, uuid, uuid, text, text, text, text, bytea, bytea
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.prepare_founder_email_pilot_content(
  uuid, uuid, uuid, uuid, text, text, text, text, bytea, bytea
) TO r72_crm_command;

-- The evidence definer records what the founder attests. It reads the content
-- chain only to rebuild the exact action scope those decisions must bind.
GRANT SELECT ON app.contact_points, app.workspace_memberships,
  app.channel_endpoints, app.campaign_template_versions,
  app.campaign_template_steps, app.campaign_template_approval_decisions,
  app.messages, app.message_versions, app.message_approval_decisions,
  app.conversations, app.communication_consent_events,
  app.communication_suppression_events
  TO r72_founder_pilot_evidence_definer;
GRANT SELECT, INSERT ON
  app_private.affiliate_compliance_subjects,
  app_private.affiliate_compliance_policy_pack_versions,
  app_private.affiliate_compliance_policy_review_events,
  app_private.affiliate_compliance_policy_publication_events,
  app_private.affiliate_compliance_specialist_decision_events
  TO r72_founder_pilot_evidence_definer;

DO $evidence_policies$
DECLARE target text;
BEGIN
  FOREACH target IN ARRAY ARRAY[
    'contact_points', 'workspace_memberships', 'channel_endpoints',
    'campaign_template_versions', 'campaign_template_steps',
    'campaign_template_approval_decisions', 'messages', 'message_versions',
    'message_approval_decisions', 'conversations',
    'communication_consent_events', 'communication_suppression_events'
  ] LOOP
    EXECUTE pg_catalog.format(
      'CREATE POLICY %I ON app.%I FOR SELECT TO r72_founder_pilot_evidence_definer
       USING (workspace_id = app_private.current_workspace_id())',
      'founder_pilot_evidence_' || target || '_select', target
    );
  END LOOP;
  FOREACH target IN ARRAY ARRAY[
    'affiliate_compliance_subjects',
    'affiliate_compliance_policy_pack_versions',
    'affiliate_compliance_policy_review_events',
    'affiliate_compliance_policy_publication_events',
    'affiliate_compliance_specialist_decision_events'
  ] LOOP
    EXECUTE pg_catalog.format(
      'CREATE POLICY %I ON app_private.%I FOR SELECT
       TO r72_founder_pilot_evidence_definer
       USING (workspace_id = app_private.current_workspace_id())',
      'founder_pilot_evidence_' || target || '_select', target
    );
    EXECUTE pg_catalog.format(
      'CREATE POLICY %I ON app_private.%I FOR INSERT
       TO r72_founder_pilot_evidence_definer
       WITH CHECK (workspace_id = app_private.current_workspace_id())',
      'founder_pilot_evidence_' || target || '_insert', target
    );
  END LOOP;
END
$evidence_policies$;

GRANT CREATE ON SCHEMA app_private TO r72_founder_pilot_evidence_definer;
SET LOCAL ROLE r72_founder_pilot_evidence_definer;


/*
 * Record the founder-pilot compliance evidence the enqueue re-checks.
 *
 * This is a founder and operator compliance review of one individually
 * consented proof email. It is not legal advice and no solicitor approval is
 * claimed by it: every reference this function writes names the founder review
 * that produced it, so the ledger says who reviewed and on what authority.
 *
 * Nothing is accepted from a browser. The pack identity comes from the
 * immutable founder-proof policy asset, and every reference and digest below is
 * derived here from that asset, the approved subject and body, the current
 * consent event, the acting user, the request and the verified endpoint. There
 * is no parameter a caller could use to assert a fact it did not earn.
 *
 * The action scope is rebuilt from the resolved content chain with the same
 * expression 0054 compares, so both route decisions bind the exact send being
 * prepared and cannot be pointed at another.
 *
 * ownership_control_checked is written false. This workflow receives no
 * ownership or control evidence, and recording it as checked would be an
 * invented fact in a compliance ledger.
 */
CREATE FUNCTION app_private.record_founder_pilot_compliance_evidence(
  p_workspace_id uuid,
  p_provider_connection_id uuid,
  p_contact_id uuid,
  p_contact_point_id uuid,
  p_purpose text,
  p_policy_asset_key text,
  p_policy_asset_version text,
  p_policy_bundle_sha256 bytea,
  p_policy_document_refs jsonb,
  p_policy_source_commit text,
  p_authority_days integer,
  p_command_key_sha256 bytea
)
RETURNS TABLE (
  disposition text, compliance_subject_id uuid, policy_pack_id uuid,
  legal_review_event_id uuid, commercial_review_event_id uuid,
  policy_publication_event_id uuid, pecr_sender_decision_event_id uuid,
  pecr_instigator_decision_event_id uuid, action_scope_sha256 text,
  review_authority text, ownership_control_checked boolean
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
  selected_user_id uuid;
  selected_request_id text := current_setting('app.request_id', true);
  selected_campaign record;
  selected_message record;
  selected_receipt app.founder_pilot_evidence_receipts%ROWTYPE;
  expected_action_scope bytea;
  computed_request_sha256 bytea;
  -- Fixed facts of this pilot. They are constants because the pilot is one
  -- individually consented email that Property Predator both sends and
  -- instigates; a caller cannot widen any of them.
  fixed_review_authority constant text := 'founder-operator-review-not-legal-advice';
  fixed_reviewer constant text := 'propertypredator.founder-operator-review';
  fixed_route constant text := 'individual_consent';
  fixed_party constant text := 'propertypredator.sender.property-predator';
  fixed_responsibility constant text := 'propertypredator.instigator.property-predator';
  derived_subject_key text;
  derived_legal_identity bytea;
  derived_evidence_base text;
  derived_legal_reference text;
  derived_commercial_reference text;
  derived_publication_reference text;
  derived_legal_sha bytea;
  derived_commercial_sha bytea;
  derived_sender_sha bytea;
  derived_instigator_sha bytea;
  derived_valid_until timestamptz;
  created_subject_id uuid;
  created_pack_id uuid;
  created_legal_id uuid := gen_random_uuid();
  created_commercial_id uuid := gen_random_uuid();
  created_publication_id uuid := gen_random_uuid();
  created_sender_id uuid := gen_random_uuid();
  created_instigator_id uuid := gen_random_uuid();
BEGIN
  IF session_user <> 'r72_founder_pilot_evidence_command'
     OR p_workspace_id IS NULL
     OR current_setting('app.workspace_id', true) IS DISTINCT FROM p_workspace_id::text
     OR current_setting('app.actor_kind', true) IS DISTINCT FROM 'user'
     OR coalesce(current_setting('app.user_id', true), '')
       !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR selected_request_id IS NULL
     OR selected_request_id <> btrim(selected_request_id)
     OR length(selected_request_id) NOT BETWEEN 1 AND 128
     OR p_purpose IS NULL OR p_purpose !~ '^[a-z][a-z0-9_.-]{0,99}$'
     -- The policy asset is immutable and lives in the deployed build. Its
     -- identity is the only thing this function takes on trust, and it is
     -- pinned by a test against the asset it is supposed to describe.
     OR p_policy_asset_key IS NULL OR p_policy_asset_key !~ '^[a-z][a-z0-9_-]{0,99}$'
     OR p_policy_asset_version IS NULL
     OR p_policy_asset_version <> btrim(p_policy_asset_version)
     OR length(p_policy_asset_version) NOT BETWEEN 1 AND 100
     OR p_policy_bundle_sha256 IS NULL
     OR octet_length(p_policy_bundle_sha256) <> 32
     OR p_policy_document_refs IS NULL
     OR jsonb_typeof(p_policy_document_refs) <> 'array'
     OR jsonb_array_length(p_policy_document_refs) < 1
     OR p_policy_source_commit IS NULL OR p_policy_source_commit !~ '^[0-9a-f]{7,40}$'
     OR p_authority_days IS NULL OR p_authority_days NOT BETWEEN 1 AND 30
     OR p_command_key_sha256 IS NULL OR octet_length(p_command_key_sha256) <> 32 THEN
    RAISE EXCEPTION 'Founder pilot compliance evidence request is invalid'
      USING ERRCODE = '22023';
  END IF;
  selected_user_id := current_setting('app.user_id', true)::uuid;
  IF NOT EXISTS (
    SELECT 1 FROM app.workspace_memberships AS membership
    WHERE membership.workspace_id = p_workspace_id
      AND membership.user_id = selected_user_id
      AND membership.status = 'active' AND membership.role IN ('owner', 'admin')
  ) THEN
    RAISE EXCEPTION 'Recording founder pilot evidence requires an active owner or admin'
      USING ERRCODE = '42501';
  END IF;

  SELECT version.id AS version_id, version.purpose_key, step.id AS step_id,
         step.content_sha256, step.subject_template, step.body_template
    INTO selected_campaign
  FROM app.campaign_template_versions AS version
  JOIN app.campaign_template_steps AS step
    ON step.workspace_id = version.workspace_id
   AND step.template_version_id = version.id
   AND step.step_kind = 'email' AND step.channel = 'email'
  JOIN app.campaign_template_approval_decisions AS decision
    ON decision.workspace_id = version.workspace_id
   AND decision.template_version_id = version.id
   AND decision.decision = 'approved'
  WHERE version.workspace_id = p_workspace_id
    AND version.purpose_key = p_purpose
    AND NOT version.provider_effects
    AND NOT EXISTS (
      SELECT 1 FROM app.campaign_template_versions AS newer
      WHERE newer.workspace_id = version.workspace_id
        AND newer.template_id = version.template_id
        AND newer.version_no > version.version_no
    )
  ORDER BY version.version_no DESC, version.id DESC LIMIT 1;
  IF selected_campaign IS NULL THEN
    RAISE EXCEPTION 'Founder pilot evidence needs approved campaign content first'
      USING ERRCODE = '42501';
  END IF;

  SELECT message_version.id AS message_version_id, endpoint.normalized_address,
         consent.id AS consent_id, point.id AS contact_point_id,
         public.digest(point.kind || pg_catalog.chr(31) || point.value
           || pg_catalog.chr(31) || point.normalized_value, 'sha256') AS endpoint_sha
    INTO selected_message
  FROM app.message_versions AS message_version
  JOIN app.messages AS message
    ON message.workspace_id = message_version.workspace_id
   AND message.id = message_version.message_id
   AND message.current_version_id = message_version.id
   AND message.lifecycle = 'approved' AND message.direction = 'outbound'
   AND message.channel = 'email' AND message.environment = 'live'
   AND message.contact_id = p_contact_id
   AND message.contact_point_id = p_contact_point_id
  JOIN app.conversations AS conversation
    ON conversation.workspace_id = message.workspace_id
   AND conversation.id = message.conversation_id
   AND conversation.subject = selected_campaign.subject_template
  JOIN app.message_approval_decisions AS message_decision
    ON message_decision.workspace_id = message_version.workspace_id
   AND message_decision.message_version_id = message_version.id
   AND message_decision.decision = 'approved'
  JOIN app.channel_endpoints AS endpoint
    ON endpoint.workspace_id = message_version.workspace_id
   AND endpoint.provider_connection_id = p_provider_connection_id
   AND endpoint.channel = 'email' AND endpoint.environment = 'live'
   AND endpoint.status = 'active'
  JOIN app.contact_points AS point
    ON point.workspace_id = message.workspace_id
   AND point.id = message.contact_point_id
   AND point.contact_id = message.contact_id
   AND point.kind = 'email' AND point.deleted_at IS NULL AND point.is_verified
  JOIN app.communication_consent_events AS consent
    ON consent.workspace_id = message.workspace_id
   AND consent.contact_point_id = message.contact_point_id
   AND consent.channel = 'email' AND consent.purpose = selected_campaign.purpose_key
   AND consent.state = 'granted'
   -- Individually consented, which is the route this pilot claims and the only
   -- one it may claim. A legitimate-interests basis is refused here.
   AND consent.lawful_basis = 'consent'
  WHERE message_version.workspace_id = p_workspace_id
    AND message_version.channel = 'email'
    AND message_version.environment = 'live'
    AND message_version.body_text = selected_campaign.body_template
    AND consent.id = (
      SELECT latest.id FROM app.communication_consent_events AS latest
      WHERE latest.workspace_id = message.workspace_id
        AND latest.contact_point_id = message.contact_point_id
        AND latest.channel = 'email'
        AND latest.purpose = selected_campaign.purpose_key
      ORDER BY latest.occurred_at DESC, latest.recorded_at DESC, latest.id DESC LIMIT 1
    )
    AND NOT EXISTS (
      SELECT 1 FROM app.communication_suppression_events AS suppression
      WHERE suppression.workspace_id = message.workspace_id
        AND suppression.contact_point_id = message.contact_point_id
        AND suppression.channel = 'email'
        AND (suppression.purpose IS NULL
          OR suppression.purpose = selected_campaign.purpose_key)
        AND suppression.state = 'suppressed'
        AND suppression.id = (
          SELECT latest.id FROM app.communication_suppression_events AS latest
          WHERE latest.workspace_id = suppression.workspace_id
            AND latest.contact_point_id = suppression.contact_point_id
            AND latest.channel = suppression.channel
            AND latest.purpose IS NOT DISTINCT FROM suppression.purpose
          ORDER BY latest.occurred_at DESC, latest.recorded_at DESC, latest.id DESC LIMIT 1
        )
    )
  ORDER BY message_version.version_number DESC, message_version.id DESC LIMIT 1;
  IF selected_message IS NULL THEN
    RAISE EXCEPTION 'Founder pilot evidence needs the approved message and individual consent'
      USING ERRCODE = '42501';
  END IF;

  -- Byte for byte the scope 0054 rebuilds and every route decision must carry.
  expected_action_scope := public.digest(format(
    'email:%s:%s:%s:%s:%s:%s:%s:%s:%s:%s', p_workspace_id,
    p_provider_connection_id, selected_message.normalized_address,
    selected_campaign.version_id,
    selected_campaign.step_id,
    pg_catalog.encode(selected_campaign.content_sha256, 'hex'),
    selected_message.message_version_id,
    pg_catalog.encode(selected_message.endpoint_sha, 'hex'),
    selected_campaign.purpose_key, selected_message.consent_id
  ), 'sha256');

  -- Everything below is derived. The base binds the immutable policy asset, the
  -- exact approved copy, the endpoint, the current consent event, the operator
  -- and the request, so no two reviews of different things can collide and none
  -- of it can be asserted from outside.
  derived_evidence_base := pg_catalog.concat_ws(pg_catalog.chr(31),
    'propertypredator.founder-pilot-operator-review/v1',
    fixed_review_authority, p_workspace_id::text,
    p_policy_asset_key, p_policy_asset_version,
    pg_catalog.encode(p_policy_bundle_sha256, 'hex'),
    pg_catalog.encode(expected_action_scope, 'hex'),
    pg_catalog.encode(selected_campaign.content_sha256, 'hex'),
    pg_catalog.encode(selected_message.endpoint_sha, 'hex'),
    selected_message.consent_id::text, selected_user_id::text, selected_request_id
  );
  derived_subject_key := 'propertypredator.founder-pilot.'
    || pg_catalog.encode(public.digest(pg_catalog.concat_ws(pg_catalog.chr(31),
      'propertypredator.founder-pilot-subject/v1', p_workspace_id::text,
      pg_catalog.encode(selected_message.endpoint_sha, 'hex')
    ), 'sha256'), 'hex');
  derived_legal_identity := public.digest(derived_subject_key, 'sha256');
  derived_legal_sha := public.digest(
    derived_evidence_base || pg_catalog.chr(31) || 'review:legal', 'sha256');
  derived_commercial_sha := public.digest(
    derived_evidence_base || pg_catalog.chr(31) || 'review:commercial', 'sha256');
  derived_sender_sha := public.digest(
    derived_evidence_base || pg_catalog.chr(31) || 'pecr:sender', 'sha256');
  derived_instigator_sha := public.digest(
    derived_evidence_base || pg_catalog.chr(31) || 'pecr:instigator', 'sha256');
  -- The references name the review that produced them, in full, so nobody
  -- reading this ledger can mistake it for a solicitor's opinion.
  derived_legal_reference := 'founder-operator-review.not-legal-advice.legal.'
    || pg_catalog.encode(derived_legal_sha, 'hex');
  derived_commercial_reference := 'founder-operator-review.not-legal-advice.commercial.'
    || pg_catalog.encode(derived_commercial_sha, 'hex');
  derived_publication_reference := 'founder-operator-review.not-legal-advice.publication.'
    || pg_catalog.encode(public.digest(derived_evidence_base, 'sha256'), 'hex');
  derived_valid_until := statement_timestamp() + (p_authority_days || ' days')::interval;

  computed_request_sha256 := public.digest(derived_evidence_base, 'sha256');

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    format('pp-founder-pilot-evidence:%s', p_workspace_id), 7200065
  ));
  SELECT receipt.* INTO selected_receipt
  FROM app.founder_pilot_evidence_receipts AS receipt
  WHERE receipt.workspace_id = p_workspace_id
    AND receipt.command_key_sha256 = p_command_key_sha256;
  IF FOUND THEN
    IF selected_receipt.request_sha256 IS DISTINCT FROM computed_request_sha256
       OR selected_receipt.action_scope_sha256 IS DISTINCT FROM expected_action_scope THEN
      RAISE EXCEPTION 'Founder pilot evidence command key conflict'
        USING ERRCODE = '23505';
    END IF;
    RETURN QUERY SELECT 'replayed'::text, selected_receipt.compliance_subject_id,
      selected_receipt.policy_pack_id, selected_receipt.legal_review_event_id,
      selected_receipt.commercial_review_event_id,
      selected_receipt.policy_publication_event_id,
      selected_receipt.pecr_sender_decision_event_id,
      selected_receipt.pecr_instigator_decision_event_id,
      pg_catalog.encode(selected_receipt.action_scope_sha256, 'hex'),
      fixed_review_authority, false;
    RETURN;
  END IF;

  SELECT subject.id INTO created_subject_id
  FROM app_private.affiliate_compliance_subjects AS subject
  WHERE subject.workspace_id = p_workspace_id
    AND subject.source_system = 'property-predator-main'
    AND subject.source_subject_key = derived_subject_key;
  IF created_subject_id IS NULL THEN
    created_subject_id := gen_random_uuid();
    INSERT INTO app_private.affiliate_compliance_subjects (
      id, workspace_id, source_system, source_subject_key,
      legal_identity_sha256, recorded_by_user_id, recorded_request_id
    ) VALUES (
      created_subject_id, p_workspace_id, 'property-predator-main',
      derived_subject_key, derived_legal_identity, selected_user_id,
      selected_request_id
    );
  END IF;

  SELECT pack.id INTO created_pack_id
  FROM app_private.affiliate_compliance_policy_pack_versions AS pack
  WHERE pack.workspace_id = p_workspace_id
    AND pack.pack_key = p_policy_asset_key
    AND pack.pack_version = p_policy_asset_version;
  IF created_pack_id IS NULL THEN
    created_pack_id := gen_random_uuid();
    INSERT INTO app_private.affiliate_compliance_policy_pack_versions (
      id, workspace_id, pack_key, pack_version, bundle_sha256, document_refs,
      drafting_status, source_commit, source_commit_meaning,
      recorded_by_user_id, recorded_request_id
    ) VALUES (
      created_pack_id, p_workspace_id, p_policy_asset_key, p_policy_asset_version,
      p_policy_bundle_sha256, p_policy_document_refs, 'draft_complete',
      p_policy_source_commit, 'drafting-provenance-only', selected_user_id,
      selected_request_id
    );
  END IF;

  INSERT INTO app_private.affiliate_compliance_policy_review_events (
    id, workspace_id, policy_pack_id, bundle_sha256, review_dimension,
    decision, specialist_reference, decision_reference, decision_sha256,
    occurred_at, recorded_by_user_id, recorded_request_id
  ) VALUES (
    created_legal_id, p_workspace_id, created_pack_id, p_policy_bundle_sha256,
    'legal', 'approved', fixed_reviewer, derived_legal_reference,
    derived_legal_sha, statement_timestamp(), selected_user_id, selected_request_id
  ), (
    created_commercial_id, p_workspace_id, created_pack_id, p_policy_bundle_sha256,
    'commercial', 'approved', fixed_reviewer, derived_commercial_reference,
    derived_commercial_sha, statement_timestamp(), selected_user_id,
    selected_request_id
  );

  INSERT INTO app_private.affiliate_compliance_policy_publication_events (
    id, workspace_id, policy_pack_id, bundle_sha256, publication_state,
    legal_review_event_id, commercial_review_event_id, effective_at, expires_at,
    reacceptance_class, publication_reference, recorded_by_user_id,
    recorded_request_id
  ) VALUES (
    created_publication_id, p_workspace_id, created_pack_id,
    p_policy_bundle_sha256, 'published', created_legal_id, created_commercial_id,
    statement_timestamp(), derived_valid_until, 'affected_permissions',
    derived_publication_reference, selected_user_id, selected_request_id
  );

  INSERT INTO app_private.affiliate_compliance_specialist_decision_events (
    id, workspace_id, subject_id, decision_kind, decision_scope_ref,
    action_scope_sha256, decision_state, route_classification, party_reference,
    responsibility_reference, specialist_reference, decision_sha256,
    ownership_control_checked, valid_from, valid_until, recorded_by_user_id,
    recorded_request_id
  ) VALUES (
    created_sender_id, p_workspace_id, created_subject_id, 'pecr_sender_route',
    derived_publication_reference, expected_action_scope, 'approved',
    fixed_route, fixed_party, fixed_responsibility, fixed_reviewer,
    derived_sender_sha,
    -- No ownership or control evidence reaches this workflow, so it is not
    -- recorded as checked. Inventing it would corrupt the ledger it protects.
    false,
    statement_timestamp(), derived_valid_until, selected_user_id, selected_request_id
  ), (
    created_instigator_id, p_workspace_id, created_subject_id,
    'pecr_instigator_route', derived_publication_reference, expected_action_scope,
    'approved', fixed_route, fixed_party, fixed_responsibility, fixed_reviewer,
    derived_instigator_sha, false, statement_timestamp(), derived_valid_until,
    selected_user_id, selected_request_id
  );

  INSERT INTO app.founder_pilot_evidence_receipts (
    workspace_id, command_key_sha256, request_sha256, action_scope_sha256,
    compliance_subject_id, policy_pack_id, legal_review_event_id,
    commercial_review_event_id, policy_publication_event_id,
    pecr_sender_decision_event_id, pecr_instigator_decision_event_id,
    provider_effects, actor_user_id, recorded_request_id
  ) VALUES (
    p_workspace_id, p_command_key_sha256, computed_request_sha256,
    expected_action_scope, created_subject_id, created_pack_id, created_legal_id,
    created_commercial_id, created_publication_id, created_sender_id,
    created_instigator_id, false, selected_user_id, selected_request_id
  );

  RETURN QUERY SELECT 'recorded'::text, created_subject_id, created_pack_id,
    created_legal_id, created_commercial_id, created_publication_id,
    created_sender_id, created_instigator_id,
    pg_catalog.encode(expected_action_scope, 'hex'),
    fixed_review_authority, false;
END
$function$;
RESET ROLE;
SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private FROM r72_founder_pilot_evidence_definer;

REVOKE ALL ON FUNCTION app_private.record_founder_pilot_compliance_evidence(
  uuid, uuid, uuid, uuid, text, text, text, bytea, jsonb, text, integer, bytea
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.record_founder_pilot_compliance_evidence(
  uuid, uuid, uuid, uuid, text, text, text, bytea, jsonb, text, integer, bytea
) TO r72_founder_pilot_evidence_command;

-- Preparation exists to replace a rail that could stage a send. It must never
-- become one: no delivery, no provider operation, no job, no consent.
DO $preparation_isolation_audit$
DECLARE target text; privilege text;
BEGIN
  FOREACH target IN ARRAY ARRAY[
    'app.message_deliveries', 'app.provider_operations',
    'app.property_predator_customer_email_jobs',
    'app.property_predator_customer_email_authorities',
    'app.property_predator_mailgun_jobs',
    'app.communication_consent_events', 'app.communication_suppression_events',
    'app.contact_points', 'app.contacts'
  ] LOOP
    FOREACH privilege IN ARRAY ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] LOOP
      IF pg_catalog.has_table_privilege(
           'r72_founder_pilot_prep_definer', target, privilege
         ) THEN
        RAISE EXCEPTION 'The founder pilot preparation definer must never hold % on %',
          privilege, target USING ERRCODE = '42501';
      END IF;
    END LOOP;
  END LOOP;
END
$preparation_isolation_audit$;

-- Recording legal evidence must never become a way to send, to move a
-- permission the founder did not attest, or to change who consented.
DO $evidence_isolation_audit$
DECLARE target text; privilege text;
BEGIN
  FOREACH target IN ARRAY ARRAY[
    'app.message_deliveries', 'app.provider_operations',
    'app.property_predator_customer_email_jobs',
    'app.communication_consent_events', 'app.communication_suppression_events',
    'app.contact_points', 'app.messages', 'app.message_versions',
    'app_private.affiliate_compliance_permission_use_receipts',
    'app_private.affiliate_compliance_permission_fact_events'
  ] LOOP
    FOREACH privilege IN ARRAY ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] LOOP
      IF pg_catalog.has_table_privilege(
           'r72_founder_pilot_evidence_definer', target, privilege
         ) THEN
        RAISE EXCEPTION 'The founder pilot evidence definer must never hold % on %',
          privilege, target USING ERRCODE = '42501';
      END IF;
    END LOOP;
  END LOOP;
END
$evidence_isolation_audit$;

-- Neither calling identity may reach the enqueue, and the evidence identity is
-- separate from every other founder rail.
DO $founder_pilot_caller_audit$
BEGIN
  IF pg_catalog.has_function_privilege(
       'r72_founder_pilot_evidence_command',
       'app_private.authorize_and_enqueue_customer_email_live_job(uuid, uuid, uuid,'
         || ' uuid, bytea, uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid,'
         || ' uuid, uuid, uuid, timestamptz, uuid, uuid, uuid, bytea, bytea)',
       'EXECUTE')
     OR pg_catalog.has_function_privilege(
       'r72_founder_pilot_evidence_command',
       'app_private.prepare_founder_email_pilot_content('
         || 'uuid, uuid, uuid, uuid, text, text, text, text, bytea, bytea)',
       'EXECUTE') THEN
    RAISE EXCEPTION 'The founder pilot evidence identity must hold only its own recorder'
      USING ERRCODE = '42501';
  END IF;
  IF NOT pg_catalog.has_function_privilege(
       'r72_crm_command',
       'app_private.prepare_founder_email_pilot_content('
         || 'uuid, uuid, uuid, uuid, text, text, text, text, bytea, bytea)',
       'EXECUTE') THEN
    RAISE EXCEPTION 'r72_crm_command must execute the founder pilot preparation'
      USING ERRCODE = '42501';
  END IF;
END
$founder_pilot_caller_audit$;
