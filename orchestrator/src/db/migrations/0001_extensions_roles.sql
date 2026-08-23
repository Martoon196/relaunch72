-- Relaunch72 PostgreSQL foundation: extensions, capability roles, private
-- schemas, migration ledger, and the workspace-table RLS registry.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

DO $roles$
DECLARE
  role_name text;
  unexpected_member text;
  unexpected_parent text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY[
    'r72_owner',
    'r72_security_definer',
    'r72_web',
    'r72_public',
    'r72_worker',
    'r72_webhook',
    'r72_readonly'
  ]
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('CREATE ROLE %I', role_name);
    END IF;
  END LOOP;

  -- Passwords/login grants are deployment secrets, never migration content.
  ALTER ROLE r72_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  ALTER ROLE r72_security_definer NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  ALTER ROLE r72_web LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
  ALTER ROLE r72_public LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
  ALTER ROLE r72_worker LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
  ALTER ROLE r72_webhook LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
  ALTER ROLE r72_readonly LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;

  -- NOINHERIT still permits SET ROLE. Strip any known privileged memberships
  -- from runtime identities, then abort if a pre-provisioned role carries any
  -- other parent membership that this migration cannot safely classify.
  REVOKE r72_owner, r72_security_definer
    FROM r72_web, r72_public, r72_worker, r72_webhook, r72_readonly;

  SELECT member.rolname, parent.rolname
    INTO unexpected_member, unexpected_parent
  FROM pg_catalog.pg_auth_members AS membership
  JOIN pg_catalog.pg_roles AS member ON member.oid = membership.member
  JOIN pg_catalog.pg_roles AS parent ON parent.oid = membership.roleid
  WHERE member.rolname = ANY (ARRAY[
    'r72_security_definer',
    'r72_web',
    'r72_public',
    'r72_worker',
    'r72_webhook',
    'r72_readonly'
  ])
  LIMIT 1;

  IF unexpected_member IS NOT NULL THEN
    RAISE EXCEPTION 'Unsafe role membership: % can SET ROLE %', unexpected_member, unexpected_parent;
  END IF;

  -- The dedicated migration identity must be able to transfer object/function
  -- ownership. It is already the privileged identity used for this migration.
  EXECUTE format('GRANT r72_owner TO %I', current_user);
  GRANT r72_security_definer TO r72_owner;

  -- Supports SET LOCAL ROLE in isolated integration tests and operational role
  -- verification without ever giving a runtime identity migration ownership.
  EXECUTE format(
    'GRANT r72_web, r72_public, r72_worker, r72_webhook, r72_readonly TO %I',
    current_user
  );
END
$roles$;

SET LOCAL ROLE r72_owner;

CREATE SCHEMA IF NOT EXISTS app AUTHORIZATION r72_owner;
CREATE SCHEMA IF NOT EXISTS app_private AUTHORIZATION r72_owner;

REVOKE ALL ON SCHEMA app FROM PUBLIC;
REVOKE ALL ON SCHEMA app_private FROM PUBLIC;
GRANT USAGE ON SCHEMA app TO r72_web, r72_worker, r72_webhook;
GRANT USAGE ON SCHEMA app_private TO r72_web, r72_worker, r72_webhook;

CREATE TABLE app_private.schema_migrations (
  filename text PRIMARY KEY,
  checksum text NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
  applied_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  applied_by text NOT NULL DEFAULT session_user
);

CREATE TABLE app_private.workspace_table_registry (
  schema_name name NOT NULL DEFAULT 'app',
  table_name name NOT NULL,
  workspace_column name NOT NULL DEFAULT 'workspace_id',
  registered_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (schema_name, table_name)
);

REVOKE ALL ON ALL TABLES IN SCHEMA app_private FROM PUBLIC;
REVOKE ALL ON app_private.schema_migrations FROM r72_web, r72_public, r72_worker, r72_webhook, r72_readonly;
REVOKE ALL ON app_private.workspace_table_registry FROM r72_web, r72_public, r72_worker, r72_webhook, r72_readonly;

CREATE FUNCTION app_private.current_workspace_id()
RETURNS uuid
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $function$
  SELECT nullif(pg_catalog.current_setting('app.workspace_id', true), '')::uuid
$function$;

CREATE FUNCTION app_private.current_user_id()
RETURNS uuid
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $function$
  SELECT nullif(pg_catalog.current_setting('app.user_id', true), '')::uuid
$function$;

CREATE FUNCTION app_private.current_actor_kind()
RETURNS text
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $function$
  SELECT nullif(pg_catalog.current_setting('app.actor_kind', true), '')
$function$;

CREATE FUNCTION app_private.current_request_id()
RETURNS text
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $function$
  SELECT nullif(pg_catalog.current_setting('app.request_id', true), '')
$function$;

REVOKE ALL ON FUNCTION app_private.current_workspace_id() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.current_user_id() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.current_actor_kind() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.current_request_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.current_workspace_id() TO r72_web, r72_worker, r72_webhook;
GRANT EXECUTE ON FUNCTION app_private.current_user_id() TO r72_web, r72_worker, r72_webhook;
GRANT EXECUTE ON FUNCTION app_private.current_actor_kind() TO r72_web, r72_worker, r72_webhook;
GRANT EXECUTE ON FUNCTION app_private.current_request_id() TO r72_web, r72_worker, r72_webhook;

ALTER DEFAULT PRIVILEGES FOR ROLE r72_owner IN SCHEMA app REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE r72_owner IN SCHEMA app REVOKE ALL ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE r72_owner IN SCHEMA app_private REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE r72_owner IN SCHEMA app_private REVOKE ALL ON FUNCTIONS FROM PUBLIC;
