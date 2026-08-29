-- Founder/admin engage-only emergency pause for every composed live rail.
--
-- The pause is append-only and deliberately has no release function. Every
-- live worker's final job-state transition to `calling` is fenced inside the
-- database, so a stale process environment cannot bypass an engaged pause.

SET LOCAL ROLE r72_owner;

CREATE TABLE app.property_predator_live_channel_pause_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE RESTRICT,
  scope text NOT NULL CHECK (scope IN (
    'all', 'customer_email', 'owned_social', 'whatsapp', 'sms', 'social_dm'
  )),
  command_key uuid NOT NULL,
  actor_user_id uuid NOT NULL,
  request_id text NOT NULL CHECK (
    length(request_id) BETWEEN 1 AND 128
    AND request_id = btrim(request_id)
    AND request_id !~ '[^[:graph:]]'
  ),
  evidence_sha256 bytea NOT NULL CHECK (octet_length(evidence_sha256) = 32),
  engaged_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, command_key)
);

CREATE INDEX property_predator_live_channel_pause_scope_idx
  ON app.property_predator_live_channel_pause_events (workspace_id, scope, engaged_at DESC);

ALTER TABLE app.property_predator_live_channel_pause_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.property_predator_live_channel_pause_events FORCE ROW LEVEL SECURITY;

CREATE POLICY live_channel_pause_owner_all
  ON app.property_predator_live_channel_pause_events FOR ALL TO r72_owner
  USING (true) WITH CHECK (true);
CREATE POLICY live_channel_pause_operational_select
  ON app.property_predator_live_channel_pause_events FOR SELECT
  TO r72_operational_inbox_definer
  USING (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND current_setting('app.actor_kind', true) = 'user'
  );
CREATE POLICY live_channel_pause_operational_insert
  ON app.property_predator_live_channel_pause_events FOR INSERT
  TO r72_operational_inbox_definer
  WITH CHECK (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND actor_user_id = nullif(current_setting('app.user_id', true), '')::uuid
    AND request_id = current_setting('app.request_id', true)
  );

GRANT SELECT, INSERT ON app.property_predator_live_channel_pause_events
  TO r72_operational_inbox_definer;

CREATE FUNCTION app_private.reject_live_channel_pause_mutation()
RETURNS trigger
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog
AS $function$
BEGIN
  RAISE EXCEPTION 'Live channel pause evidence is append-only'
    USING ERRCODE = '55000';
END
$function$;
REVOKE ALL ON FUNCTION app_private.reject_live_channel_pause_mutation() FROM PUBLIC;
CREATE TRIGGER live_channel_pause_events_immutable BEFORE UPDATE OR DELETE
  ON app.property_predator_live_channel_pause_events FOR EACH ROW
  EXECUTE FUNCTION app_private.reject_live_channel_pause_mutation();

-- This trigger is attached only to the four composed live job tables. A
-- blocked transition rolls the worker's complete begin-call transaction back
-- before any provider transport can run.
CREATE FUNCTION app_private.guard_live_channel_job_calling_pause()
RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE selected_scope text;
BEGIN
  IF OLD.state IS NOT DISTINCT FROM 'calling' OR NEW.state IS DISTINCT FROM 'calling' THEN
    RETURN NEW;
  END IF;
  selected_scope := CASE TG_TABLE_NAME
    WHEN 'property_predator_customer_email_jobs' THEN 'customer_email'
    WHEN 'property_predator_owned_social_jobs' THEN 'owned_social'
    WHEN 'property_predator_whatsapp_live_jobs' THEN 'whatsapp'
    WHEN 'property_predator_sms_jobs' THEN 'sms'
    ELSE NULL
  END;
  IF selected_scope IS NULL THEN
    RAISE EXCEPTION 'Live channel pause fence attached outside its exact rail set'
      USING ERRCODE = '42501';
  END IF;
  IF EXISTS (
    SELECT 1 FROM app.property_predator_live_channel_pause_events AS pause
    WHERE pause.workspace_id = NEW.workspace_id
      AND pause.scope IN ('all', selected_scope)
  ) THEN
    RAISE EXCEPTION 'Live channel emergency pause is engaged'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$function$;
REVOKE ALL ON FUNCTION app_private.guard_live_channel_job_calling_pause() FROM PUBLIC;

CREATE TRIGGER customer_email_live_emergency_pause
  BEFORE UPDATE OF state ON app.property_predator_customer_email_jobs
  FOR EACH ROW EXECUTE FUNCTION app_private.guard_live_channel_job_calling_pause();
CREATE TRIGGER owned_social_live_emergency_pause
  BEFORE UPDATE OF state ON app.property_predator_owned_social_jobs
  FOR EACH ROW EXECUTE FUNCTION app_private.guard_live_channel_job_calling_pause();
CREATE TRIGGER whatsapp_live_emergency_pause
  BEFORE UPDATE OF state ON app.property_predator_whatsapp_live_jobs
  FOR EACH ROW EXECUTE FUNCTION app_private.guard_live_channel_job_calling_pause();
CREATE TRIGGER sms_live_emergency_pause
  BEFORE UPDATE OF state ON app.property_predator_sms_jobs
  FOR EACH ROW EXECUTE FUNCTION app_private.guard_live_channel_job_calling_pause();

GRANT CREATE ON SCHEMA app_private TO r72_operational_inbox_definer;
SET LOCAL ROLE r72_operational_inbox_definer;

CREATE FUNCTION app_private.engage_property_predator_live_channel_pause(
  p_workspace_id uuid,
  p_session_token_sha256 bytea,
  p_scope text,
  p_command_key uuid
)
RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
  selected_user_id uuid;
  selected_request_id text := current_setting('app.request_id', true);
  existing_scope text;
  selected_evidence bytea;
BEGIN
  IF p_scope NOT IN (
       'all', 'customer_email', 'owned_social', 'whatsapp', 'sms', 'social_dm'
     ) OR p_command_key IS NULL THEN
    RAISE EXCEPTION 'Live channel pause command is invalid' USING ERRCODE = '22023';
  END IF;
  selected_user_id := app_private.assert_operational_inbox_user_context(
    p_workspace_id, p_session_token_sha256
  );
  IF NOT app_private.can_manage_workspace(selected_user_id, p_workspace_id) THEN
    RAISE EXCEPTION 'Live channel pause command requires founder or admin authority'
      USING ERRCODE = '42501';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    format('property-predator-live-pause:%s:%s', p_workspace_id, p_command_key),
    7200057
  ));
  SELECT pause.scope INTO existing_scope
  FROM app.property_predator_live_channel_pause_events AS pause
  WHERE pause.workspace_id = p_workspace_id AND pause.command_key = p_command_key;
  IF FOUND THEN
    IF existing_scope IS DISTINCT FROM p_scope THEN
      RAISE EXCEPTION 'Live channel pause idempotency conflict'
        USING ERRCODE = '40001';
    END IF;
    RETURN 'replayed';
  END IF;
  selected_evidence := public.digest(pg_catalog.concat_ws(pg_catalog.chr(31),
    'propertypredator.live-channel-pause/v1', p_workspace_id::text, p_scope,
    p_command_key::text, selected_user_id::text, selected_request_id
  ), 'sha256');
  INSERT INTO app.property_predator_live_channel_pause_events (
    workspace_id, scope, command_key, actor_user_id, request_id, evidence_sha256
  ) VALUES (
    p_workspace_id, p_scope, p_command_key, selected_user_id,
    selected_request_id, selected_evidence
  );
  RETURN 'engaged';
END
$function$;

-- Preserve 0056's truth implementation as a closed base and add the durable
-- pause evidence without duplicating its provider/cap/receipt calculations.
ALTER FUNCTION app_private.property_predator_live_channel_truth()
  RENAME TO property_predator_live_channel_truth_unpaused;

CREATE FUNCTION app_private.property_predator_live_channel_truth()
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
    CASE WHEN truth.rail <> 'social_dm' AND EXISTS (
      SELECT 1 FROM app.property_predator_live_channel_pause_events AS pause
      WHERE pause.workspace_id = truth.workspace_id
        AND pause.scope IN ('all', truth.rail)
    ) THEN CASE WHEN 'EMERGENCY_PAUSED' = ANY(truth.blocker_codes)
      THEN truth.blocker_codes ELSE truth.blocker_codes || ARRAY['EMERGENCY_PAUSED'] END
    ELSE truth.blocker_codes END,
    truth.latest_receipt_id, truth.latest_receipt_outcome,
    truth.latest_receipt_at, truth.latest_receipt_evidence_sha256
  FROM app_private.property_predator_live_channel_truth_unpaused() AS truth
$function$;

RESET ROLE;
SET LOCAL ROLE r72_owner;

REVOKE CREATE ON SCHEMA app_private FROM r72_operational_inbox_definer;
REVOKE ALL ON FUNCTION app_private.engage_property_predator_live_channel_pause(
  uuid, bytea, text, uuid
) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.property_predator_live_channel_truth_unpaused()
  FROM PUBLIC, r72_web;
REVOKE ALL ON FUNCTION app_private.property_predator_live_channel_truth()
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.engage_property_predator_live_channel_pause(
  uuid, bytea, text, uuid
) TO r72_crm_command;
GRANT EXECUTE ON FUNCTION app_private.property_predator_live_channel_truth()
  TO r72_web;

INSERT INTO app_private.workspace_table_registry (schema_name, table_name, workspace_column)
VALUES ('app', 'property_predator_live_channel_pause_events', 'workspace_id');
