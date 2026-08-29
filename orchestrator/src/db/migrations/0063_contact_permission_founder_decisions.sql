-- Founder-operated contact permission decisions for the Lead 360 case file.
--
-- Live testing showed Lead 360 reporting "No channel evidence" with no
-- authorised way to record, deny or withdraw contact permission. The storage
-- for that evidence already exists and is not rebuilt here: consent decisions
-- keep living in app.communication_consent_events, and suppression keeps living
-- in app.communication_suppression_events.
--
-- What the existing boundary cannot do safely is the command itself.
--
-- First, the 0014 insert policy admits r72_crm_command whenever
-- app_private.can_write_workspace passes, and that helper admits owner, admin,
-- marketer and sales. A permission decision is a legal record, so this rail is
-- narrowed to owner and admin only.
--
-- Second, nothing in the existing boundary makes the command idempotent. The
-- consent table is keyed only on (workspace_id, id), so a double submit or a
-- retried request would append a second decision that looks exactly like a
-- second human act. This migration adds a receipt keyed on the operator's
-- command key, so a replay returns the original decision and a reused key with
-- different content is refused as a conflict.
--
-- Third, and most important, a raw INSERT grant cannot promise that granting
-- permission never clears a suppression. Here that promise is structural: the
-- definer that performs the decision is never granted INSERT, UPDATE or DELETE
-- on app.communication_suppression_events, and an audit below fails the apply
-- if it ever is. The command therefore cannot release a suppression even if a
-- future edit asked it to.
--
-- This migration records no decision, queues no job, sends no message and
-- performs no provider call.

DO $roles$
DECLARE unsafe_parent text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'r72_contact_permission_definer'
  ) THEN
    CREATE ROLE r72_contact_permission_definer NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'r72_crm_command'
  ) THEN
    RAISE EXCEPTION 'r72_crm_command must exist before the contact permission rail'
      USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles
    WHERE rolname = 'r72_contact_permission_definer'
      AND NOT rolcanlogin AND NOT rolinherit AND NOT rolsuper
      AND NOT rolcreatedb AND NOT rolcreaterole
      AND NOT rolreplication AND NOT rolbypassrls
  ) THEN
    RAISE EXCEPTION 'Unsafe contact permission definer role attributes'
      USING ERRCODE = '42501';
  END IF;
  REVOKE r72_owner, r72_security_definer, r72_operational_inbox_definer
    FROM r72_contact_permission_definer;
  REVOKE r72_contact_permission_definer
    FROM r72_web, r72_public, r72_worker, r72_webhook, r72_readonly,
      r72_crm_command;
  SELECT parent.rolname INTO unsafe_parent
  FROM pg_catalog.pg_auth_members AS membership
  JOIN pg_catalog.pg_roles AS member ON member.oid = membership.member
  JOIN pg_catalog.pg_roles AS parent ON parent.oid = membership.roleid
  WHERE member.rolname = 'r72_contact_permission_definer'
  LIMIT 1;
  IF unsafe_parent IS NOT NULL THEN
    RAISE EXCEPTION 'Unsafe contact permission definer parent: %', unsafe_parent
      USING ERRCODE = '42501';
  END IF;
  GRANT r72_contact_permission_definer TO r72_owner;
END
$roles$;

SET LOCAL ROLE r72_owner;

REVOKE ALL ON SCHEMA app, app_private FROM r72_contact_permission_definer;
REVOKE ALL ON ALL TABLES IN SCHEMA app FROM r72_contact_permission_definer;
REVOKE ALL ON ALL TABLES IN SCHEMA app_private FROM r72_contact_permission_definer;
REVOKE CREATE ON SCHEMA public FROM r72_contact_permission_definer;
GRANT USAGE ON SCHEMA app, app_private TO r72_contact_permission_definer;
GRANT EXECUTE ON FUNCTION app_private.current_workspace_id(),
  app_private.current_user_id(), app_private.current_actor_kind()
  TO r72_contact_permission_definer;

-- One receipt per operator command key. This is the whole idempotency and
-- replay/conflict story: the key is chosen by the founder-facing form, and the
-- request digest binds the exact contact, endpoint, purpose and decision that
-- key was first used for.
CREATE TABLE app.contact_permission_command_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE RESTRICT,
  command_key_sha256 bytea NOT NULL CHECK (octet_length(command_key_sha256) = 32),
  request_sha256 bytea NOT NULL CHECK (octet_length(request_sha256) = 32),
  contact_id uuid NOT NULL,
  contact_point_id uuid NOT NULL,
  channel text NOT NULL CHECK (channel IN ('email', 'sms', 'whatsapp')),
  purpose text NOT NULL CHECK (
    purpose = lower(btrim(purpose)) AND purpose ~ '^[a-z][a-z0-9_.-]{0,99}$'
  ),
  decision text NOT NULL CHECK (decision IN ('granted', 'denied', 'withdrawn')),
  consent_event_id uuid NOT NULL,
  actor_user_id uuid NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, command_key_sha256),
  UNIQUE (workspace_id, consent_event_id),
  FOREIGN KEY (workspace_id, contact_point_id, contact_id)
    REFERENCES app.contact_points (workspace_id, id, contact_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, consent_event_id)
    REFERENCES app.communication_consent_events (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, actor_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id) ON DELETE RESTRICT
);

ALTER TABLE app.contact_permission_command_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.contact_permission_command_receipts FORCE ROW LEVEL SECURITY;

-- Receipts are evidence, so they are append-only like the decisions they index.
CREATE FUNCTION app_private.reject_contact_permission_receipt_mutation()
RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
BEGIN
  RAISE EXCEPTION 'Contact permission receipts are append-only'
    USING ERRCODE = '42501';
END
$function$;
REVOKE ALL ON FUNCTION app_private.reject_contact_permission_receipt_mutation() FROM PUBLIC;

CREATE TRIGGER contact_permission_receipts_immutable
  BEFORE UPDATE OR DELETE ON app.contact_permission_command_receipts
  FOR EACH ROW EXECUTE FUNCTION app_private.reject_contact_permission_receipt_mutation();

GRANT SELECT, INSERT ON app.contact_permission_command_receipts
  TO r72_contact_permission_definer;
GRANT SELECT ON app.contact_permission_command_receipts TO r72_web;

CREATE POLICY contact_permission_receipts_definer_write
  ON app.contact_permission_command_receipts FOR INSERT
  TO r72_contact_permission_definer
  WITH CHECK (workspace_id = app_private.current_workspace_id());
CREATE POLICY contact_permission_receipts_definer_read
  ON app.contact_permission_command_receipts FOR SELECT
  TO r72_contact_permission_definer
  USING (workspace_id = app_private.current_workspace_id());
CREATE POLICY contact_permission_receipts_web_read
  ON app.contact_permission_command_receipts FOR SELECT TO r72_web
  USING (workspace_id = app_private.current_workspace_id());

-- Exactly what the decision needs to read, and the one table it may append to.
-- Suppression is deliberately absent from every grant below.
GRANT SELECT (
  workspace_id, id, contact_id, kind, value, normalized_value, deleted_at
) ON app.contact_points TO r72_contact_permission_definer;
GRANT SELECT (
  workspace_id, user_id, role, status
) ON app.workspace_memberships TO r72_contact_permission_definer;
GRANT INSERT (
  id, workspace_id, contact_id, contact_point_id, channel, purpose,
  state, lawful_basis, source, policy_version, policy_text_sha256,
  source_event_id, actor_kind, actor_user_id, evidence,
  endpoint_identity_sha256, occurred_at
) ON app.communication_consent_events TO r72_contact_permission_definer;

CREATE POLICY contact_permission_points_definer_select
  ON app.contact_points FOR SELECT TO r72_contact_permission_definer
  USING (
    workspace_id = app_private.current_workspace_id()
    AND app_private.current_actor_kind() = 'user'
  );
CREATE POLICY contact_permission_memberships_definer_select
  ON app.workspace_memberships FOR SELECT TO r72_contact_permission_definer
  USING (
    workspace_id = app_private.current_workspace_id()
    AND app_private.current_actor_kind() = 'user'
  );

CREATE POLICY communication_consent_events_permission_definer_insert
  ON app.communication_consent_events FOR INSERT
  TO r72_contact_permission_definer
  WITH CHECK (
    workspace_id = app_private.current_workspace_id()
    AND actor_kind = 'user'
    AND actor_user_id = app_private.current_user_id()
  );
CREATE POLICY communication_consent_events_permission_definer_select
  ON app.communication_consent_events FOR SELECT
  TO r72_contact_permission_definer
  USING (workspace_id = app_private.current_workspace_id());

GRANT CREATE ON SCHEMA app_private TO r72_contact_permission_definer;
SET LOCAL ROLE r72_contact_permission_definer;

/*
 * Record one founder permission decision for one exact endpoint and purpose.
 *
 * The endpoint identity digest is derived here from the stored contact point,
 * never accepted from the caller, so a decision cannot be bound to an endpoint
 * the operator did not actually see.
 */
CREATE FUNCTION app_private.record_contact_permission_decision(
  p_workspace_id uuid,
  p_contact_id uuid,
  p_contact_point_id uuid,
  p_channel text,
  p_purpose text,
  p_decision text,
  p_lawful_basis text,
  p_evidence_source text,
  p_policy_version text,
  p_policy_text_sha256 bytea,
  p_source_event_id text,
  p_command_key_sha256 bytea,
  p_occurred_at timestamptz
)
RETURNS TABLE (disposition text, consent_event_id uuid, receipt_id uuid)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
  selected_user_id uuid;
  selected_request_id text := current_setting('app.request_id', true);
  selected_point_kind text;
  selected_point_value text;
  selected_point_normalized_value text;
  selected_receipt app.contact_permission_command_receipts%ROWTYPE;
  expected_kind text;
  endpoint_identity bytea;
  computed_request_sha256 bytea;
  created_consent_id uuid := gen_random_uuid();
  created_receipt_id uuid := gen_random_uuid();
BEGIN
  IF session_user <> 'r72_crm_command'
     OR p_workspace_id IS NULL
     OR current_setting('app.workspace_id', true) IS DISTINCT FROM p_workspace_id::text
     OR current_setting('app.actor_kind', true) IS DISTINCT FROM 'user'
     OR coalesce(current_setting('app.user_id', true), '')
       !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR selected_request_id IS NULL
     OR selected_request_id <> btrim(selected_request_id)
     OR length(selected_request_id) NOT BETWEEN 1 AND 128
     OR selected_request_id ~ '[^[:graph:]]'
     OR p_contact_id IS NULL OR p_contact_point_id IS NULL
     OR p_channel IS NULL OR p_channel NOT IN ('email', 'sms', 'whatsapp')
     OR p_purpose IS NULL OR p_purpose <> lower(btrim(p_purpose))
     OR p_purpose !~ '^[a-z][a-z0-9_.-]{0,99}$'
     OR p_decision IS NULL OR p_decision NOT IN ('granted', 'denied', 'withdrawn')
     OR p_evidence_source IS NULL OR p_evidence_source <> lower(btrim(p_evidence_source))
     OR p_evidence_source !~ '^[a-z][a-z0-9_.:-]{0,99}$'
     OR p_command_key_sha256 IS NULL OR octet_length(p_command_key_sha256) <> 32
     OR (p_policy_text_sha256 IS NOT NULL AND octet_length(p_policy_text_sha256) <> 32)
     OR (p_policy_version IS NOT NULL
       AND length(btrim(p_policy_version)) NOT BETWEEN 1 AND 100)
     OR (p_source_event_id IS NOT NULL AND (
       p_source_event_id <> btrim(p_source_event_id)
       OR length(p_source_event_id) NOT BETWEEN 1 AND 255))
     OR p_occurred_at IS NULL
     OR p_occurred_at > statement_timestamp() + interval '5 minutes' THEN
    RAISE EXCEPTION 'Contact permission decision evidence is invalid'
      USING ERRCODE = '22023';
  END IF;
  -- A granted decision must carry its lawful basis; a denial or withdrawal
  -- must not pretend to have one.
  IF (p_decision = 'granted') <> (p_lawful_basis IS NOT NULL)
     OR (p_lawful_basis IS NOT NULL AND p_lawful_basis NOT IN (
       'consent', 'legitimate_interests', 'contract',
       'legal_obligation', 'vital_interests', 'public_task')) THEN
    RAISE EXCEPTION 'Contact permission lawful basis is invalid'
      USING ERRCODE = '22023';
  END IF;
  selected_user_id := current_setting('app.user_id', true)::uuid;

  -- Founder rail: owner and admin only. can_write_workspace also admits
  -- marketer and sales, which is too wide for a legal permission record.
  IF NOT EXISTS (
    SELECT 1 FROM app.workspace_memberships AS membership
    WHERE membership.workspace_id = p_workspace_id
      AND membership.user_id = selected_user_id
      AND membership.status = 'active'
      AND membership.role IN ('owner', 'admin')
  ) THEN
    RAISE EXCEPTION 'Contact permission decisions require an active owner or admin'
      USING ERRCODE = '42501';
  END IF;

  SELECT point.kind, point.value, point.normalized_value
    INTO selected_point_kind, selected_point_value,
      selected_point_normalized_value
  FROM app.contact_points AS point
  WHERE point.workspace_id = p_workspace_id
    AND point.id = p_contact_point_id
    AND point.contact_id = p_contact_id
    AND point.deleted_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Contact permission endpoint is not bound to this contact'
      USING ERRCODE = '42501';
  END IF;
  expected_kind := CASE p_channel
    WHEN 'email' THEN 'email' WHEN 'sms' THEN 'phone' ELSE 'whatsapp' END;
  IF selected_point_kind IS DISTINCT FROM expected_kind THEN
    RAISE EXCEPTION 'Contact permission channel does not match the endpoint kind'
      USING ERRCODE = '22023';
  END IF;

  -- Derived from the stored endpoint, never supplied by the caller.
  endpoint_identity := public.digest(
    selected_point_kind || pg_catalog.chr(31) || selected_point_value
      || pg_catalog.chr(31) || selected_point_normalized_value,
    'sha256'
  );
  computed_request_sha256 := public.digest(
    concat_ws(pg_catalog.chr(31),
      'propertypredator.contact-permission/v1',
      p_workspace_id::text, p_contact_id::text, p_contact_point_id::text,
      p_channel, p_purpose, p_decision, coalesce(p_lawful_basis, ''),
      p_evidence_source, coalesce(p_policy_version, ''),
      coalesce(pg_catalog.encode(p_policy_text_sha256, 'hex'), ''),
      coalesce(p_source_event_id, ''),
      pg_catalog.encode(endpoint_identity, 'hex'),
      selected_user_id::text
    ),
    'sha256'
  );

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    format('pp-contact-permission:%s', p_workspace_id), 7200063
  ));

  SELECT receipt.* INTO selected_receipt
  FROM app.contact_permission_command_receipts AS receipt
  WHERE receipt.workspace_id = p_workspace_id
    AND receipt.command_key_sha256 = p_command_key_sha256;
  IF FOUND THEN
    -- Same key and same content is a replay of one human act. Same key with
    -- different content is a conflict, never a second silent decision.
    IF selected_receipt.request_sha256 IS DISTINCT FROM computed_request_sha256 THEN
      RAISE EXCEPTION 'Contact permission command key conflict'
        USING ERRCODE = '23505';
    END IF;
    RETURN QUERY SELECT 'replayed'::text,
      selected_receipt.consent_event_id, selected_receipt.id;
    RETURN;
  END IF;

  INSERT INTO app.communication_consent_events (
    id, workspace_id, contact_id, contact_point_id, channel, purpose,
    state, lawful_basis, source, policy_version, policy_text_sha256,
    source_event_id, actor_kind, actor_user_id, evidence,
    endpoint_identity_sha256, occurred_at
  ) VALUES (
    created_consent_id, p_workspace_id, p_contact_id, p_contact_point_id,
    p_channel, p_purpose, p_decision, p_lawful_basis, p_evidence_source,
    p_policy_version, p_policy_text_sha256, p_source_event_id,
    'user', selected_user_id,
    jsonb_build_object('recorded_by', 'founder_contact_permission'),
    endpoint_identity, p_occurred_at
  );

  INSERT INTO app.contact_permission_command_receipts (
    id, workspace_id, command_key_sha256, request_sha256, contact_id,
    contact_point_id, channel, purpose, decision, consent_event_id, actor_user_id
  ) VALUES (
    created_receipt_id, p_workspace_id, p_command_key_sha256,
    computed_request_sha256, p_contact_id, p_contact_point_id, p_channel,
    p_purpose, p_decision, created_consent_id, selected_user_id
  );

  RETURN QUERY SELECT 'applied'::text, created_consent_id, created_receipt_id;
END
$function$;

RESET ROLE;
SET LOCAL ROLE r72_owner;

REVOKE CREATE ON SCHEMA app_private FROM r72_contact_permission_definer;
REVOKE ALL ON FUNCTION app_private.record_contact_permission_decision(
  uuid, uuid, uuid, text, text, text, text, text, text, bytea, text, bytea, timestamptz
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.record_contact_permission_decision(
  uuid, uuid, uuid, text, text, text, text, text, text, bytea, text, bytea, timestamptz
) TO r72_crm_command;

-- The promise that a grant can never clear a suppression is structural, not a
-- matter of reading the function body: the definer holds no write privilege on
-- the suppression ledger at all.
DO $suppression_isolation_audit$
DECLARE
  privilege text;
BEGIN
  FOREACH privilege IN ARRAY ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] LOOP
    IF pg_catalog.has_table_privilege(
         'r72_contact_permission_definer',
         'app.communication_suppression_events', privilege
       ) THEN
      RAISE EXCEPTION
        'The contact permission definer must never hold % on the suppression ledger',
        privilege
        USING ERRCODE = '42501';
    END IF;
  END LOOP;
END
$suppression_isolation_audit$;

-- Permission decisions are append-only: the definer may add evidence and never
-- rewrite or remove it.
DO $append_only_audit$
DECLARE
  target text;
  privilege text;
BEGIN
  FOREACH target IN ARRAY ARRAY[
    'app.communication_consent_events',
    'app.contact_permission_command_receipts'
  ] LOOP
    FOREACH privilege IN ARRAY ARRAY['UPDATE', 'DELETE', 'TRUNCATE'] LOOP
      IF pg_catalog.has_table_privilege(
           'r72_contact_permission_definer', target, privilege
         ) THEN
        RAISE EXCEPTION 'The contact permission definer must never hold % on %',
          privilege, target
          USING ERRCODE = '42501';
      END IF;
    END LOOP;
  END LOOP;
END
$append_only_audit$;

-- The command identity stays table-blind on the ledgers: it may only call the
-- function, so it cannot append a decision that skipped the membership,
-- binding, idempotency or suppression-isolation rules.
DO $command_blindness_audit$
DECLARE
  target text;
  privilege text;
BEGIN
  FOREACH target IN ARRAY ARRAY['app.contact_permission_command_receipts'] LOOP
    FOREACH privilege IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] LOOP
      IF pg_catalog.has_table_privilege('r72_crm_command', target, privilege) THEN
        RAISE EXCEPTION 'r72_crm_command must not hold % on %', privilege, target
          USING ERRCODE = '42501';
      END IF;
    END LOOP;
  END LOOP;
  IF NOT pg_catalog.has_function_privilege(
       'r72_crm_command',
       'app_private.record_contact_permission_decision(uuid, uuid, uuid, text, text,'
         || ' text, text, text, text, bytea, text, bytea, timestamptz)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'r72_crm_command must execute the contact permission decision'
      USING ERRCODE = '42501';
  END IF;
END
$command_blindness_audit$;
