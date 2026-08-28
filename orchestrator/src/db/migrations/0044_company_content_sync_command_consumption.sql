-- Durable, one-use source-sync command evidence. The web process proves the
-- active portal session first, then this function atomically consumes only
-- workspace-scoped SHA-256 evidence before any Property Predator source read.
-- No raw session token, command key, email address or source content is stored.

DO $preflight$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_roles
    WHERE rolname = 'r72_web'
      AND rolcanlogin AND NOT rolinherit AND NOT rolsuper
      AND NOT rolcreatedb AND NOT rolcreaterole
      AND NOT rolreplication AND NOT rolbypassrls
  ) THEN
    RAISE EXCEPTION 'Web role is missing or unsafe';
  END IF;
  IF pg_catalog.to_regprocedure(
       'app_private.lock_active_portal_session(bytea,uuid,uuid)'
     ) IS NULL
     OR pg_catalog.to_regprocedure(
       'app_private.can_manage_workspace(uuid,uuid)'
     ) IS NULL THEN
    RAISE EXCEPTION 'Portal session or workspace authorization boundary is unavailable';
  END IF;
END
$preflight$;

SET LOCAL ROLE r72_owner;

CREATE TABLE app.company_content_sync_command_consumptions (
  workspace_id uuid NOT NULL
    REFERENCES app.workspaces(id) ON DELETE RESTRICT,
  session_token_sha256 bytea NOT NULL
    CHECK (octet_length(session_token_sha256) = 32),
  command_key_sha256 bytea NOT NULL
    CHECK (octet_length(command_key_sha256) = 32),
  consumed_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, session_token_sha256, command_key_sha256),
  CHECK (expires_at > consumed_at),
  CHECK (expires_at <= consumed_at + interval '10 minutes 30 seconds')
);

CREATE INDEX company_content_sync_command_expiry_idx
  ON app.company_content_sync_command_consumptions (workspace_id, expires_at);

ALTER TABLE app.company_content_sync_command_consumptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.company_content_sync_command_consumptions FORCE ROW LEVEL SECURITY;

REVOKE ALL ON app.company_content_sync_command_consumptions FROM PUBLIC;
REVOKE ALL ON app.company_content_sync_command_consumptions
  FROM r72_web, r72_content_adapter, r72_content_command;

CREATE POLICY company_content_sync_command_security_select
  ON app.company_content_sync_command_consumptions
  FOR SELECT TO r72_security_definer USING (true);
CREATE POLICY company_content_sync_command_security_insert
  ON app.company_content_sync_command_consumptions
  FOR INSERT TO r72_security_definer WITH CHECK (true);
CREATE POLICY company_content_sync_command_security_delete
  ON app.company_content_sync_command_consumptions
  FOR DELETE TO r72_security_definer USING (true);

GRANT SELECT, INSERT, DELETE
  ON app.company_content_sync_command_consumptions TO r72_security_definer;

INSERT INTO app_private.workspace_table_registry
  (schema_name, table_name, workspace_column)
VALUES
  ('app', 'company_content_sync_command_consumptions', 'workspace_id')
ON CONFLICT (schema_name, table_name) DO UPDATE
  SET workspace_column = EXCLUDED.workspace_column
  WHERE app_private.workspace_table_registry.workspace_column
    IS DISTINCT FROM EXCLUDED.workspace_column;

RESET ROLE;
SET LOCAL ROLE r72_security_definer;

CREATE FUNCTION app_private.consume_company_content_sync_command(
  p_workspace_id uuid,
  p_session_token_sha256 bytea,
  p_command_key text
)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_now timestamptz := statement_timestamp();
  v_command_key_sha256 bytea;
  v_active_count integer;
BEGIN
  IF p_workspace_id IS NULL
     OR app_private.current_workspace_id() IS DISTINCT FROM p_workspace_id
     OR app_private.current_user_id() IS NULL
     OR p_session_token_sha256 IS NULL
     OR octet_length(p_session_token_sha256) <> 32
     OR p_command_key IS NULL
     OR p_command_key !~ '^[A-Za-z0-9_-]{16,128}$'
     OR NOT app_private.can_manage_workspace(
       app_private.current_user_id(), p_workspace_id
     )
     OR NOT app_private.lock_active_portal_session(
       p_session_token_sha256,
       app_private.current_user_id(),
       p_workspace_id
     ) THEN
    RAISE EXCEPTION 'Company-content sync command context is invalid'
      USING ERRCODE = '42501';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      'relaunch72:company-content-sync-command:' || p_workspace_id::text,
      0
    )
  );

  DELETE FROM app.company_content_sync_command_consumptions
  WHERE workspace_id = p_workspace_id
    AND expires_at <= v_now;

  v_command_key_sha256 := public.digest(
    convert_to(
      'relaunch72:company-content-sync-command:v1:' || p_command_key,
      'UTF8'
    ),
    'sha256'
  );

  IF EXISTS (
    SELECT 1
    FROM app.company_content_sync_command_consumptions
    WHERE workspace_id = p_workspace_id
      AND session_token_sha256 = p_session_token_sha256
      AND command_key_sha256 = v_command_key_sha256
      AND expires_at > v_now
  ) THEN
    RETURN 'replayed';
  END IF;

  SELECT count(*)::integer
  INTO v_active_count
  FROM app.company_content_sync_command_consumptions
  WHERE workspace_id = p_workspace_id
    AND expires_at > v_now;

  IF v_active_count >= 2048 THEN
    RETURN 'saturated';
  END IF;

  INSERT INTO app.company_content_sync_command_consumptions (
    workspace_id,
    session_token_sha256,
    command_key_sha256,
    consumed_at,
    expires_at
  ) VALUES (
    p_workspace_id,
    p_session_token_sha256,
    v_command_key_sha256,
    v_now,
    v_now + interval '10 minutes 30 seconds'
  );

  RETURN 'accepted';
END
$function$;

ALTER FUNCTION app_private.consume_company_content_sync_command(uuid, bytea, text)
  OWNER TO r72_security_definer;
REVOKE ALL ON FUNCTION app_private.consume_company_content_sync_command(uuid, bytea, text)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.consume_company_content_sync_command(uuid, bytea, text)
  TO r72_web;

RESET ROLE;

DO $capability_audit$
BEGIN
  IF NOT pg_catalog.has_function_privilege(
       'r72_web',
       'app_private.consume_company_content_sync_command(uuid,bytea,text)',
       'EXECUTE'
     )
     OR pg_catalog.has_table_privilege(
       'r72_web', 'app.company_content_sync_command_consumptions', 'SELECT'
     )
     OR pg_catalog.has_table_privilege(
       'r72_web', 'app.company_content_sync_command_consumptions', 'INSERT'
     )
     OR pg_catalog.has_table_privilege(
       'r72_web', 'app.company_content_sync_command_consumptions', 'UPDATE'
     )
     OR pg_catalog.has_table_privilege(
       'r72_web', 'app.company_content_sync_command_consumptions', 'DELETE'
     )
     OR pg_catalog.has_table_privilege(
       'r72_security_definer',
       'app.company_content_sync_command_consumptions',
       'UPDATE'
     )
     OR pg_catalog.has_function_privilege(
       'r72_content_adapter',
       'app_private.consume_company_content_sync_command(uuid,bytea,text)',
       'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'r72_content_command',
       'app_private.consume_company_content_sync_command(uuid,bytea,text)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'Company-content sync command capability is unsafe';
  END IF;
END
$capability_audit$;
