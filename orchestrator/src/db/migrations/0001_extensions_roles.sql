-- Relaunch72 PostgreSQL foundation: extensions, capability roles, private
-- schemas, migration ledger, and the workspace-table RLS registry.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

DO $roles$
DECLARE
  role_name text;
  expected_login boolean;
  expected_inherit boolean;
  unexpected_member text;
  unexpected_parent text;
BEGIN
  FOR role_name, expected_login, expected_inherit IN
    SELECT required_role.role_name, required_role.expected_login,
      required_role.expected_inherit
    FROM (VALUES
      ('r72_owner', false, true),
      ('r72_security_definer', false, true),
      ('r72_web', true, false),
      ('r72_public', true, false),
      ('r72_worker', true, false),
      ('r72_webhook', true, false),
      ('r72_readonly', true, false)
    ) AS required_role(role_name, expected_login, expected_inherit)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = role_name) THEN
      -- CREATE ROLE's protected-attribute defaults are deliberately safe:
      -- NOSUPERUSER, NOCREATEDB, NOCREATEROLE, NOREPLICATION and
      -- NOBYPASSRLS. Do not restate those defaults in ALTER ROLE: managed
      -- Postgres administrators such as Neon are not PostgreSQL superusers.
      EXECUTE format(
        'CREATE ROLE %I %s %s',
        role_name,
        CASE WHEN expected_login THEN 'LOGIN' ELSE 'NOLOGIN' END,
        CASE WHEN expected_inherit THEN 'INHERIT' ELSE 'NOINHERIT' END
      );
    END IF;

    -- Existing roles are accepted only when their complete capability shape
    -- already matches this migration. Unsafe attributes fail closed; changing
    -- protected role attributes requires a real PostgreSQL superuser and is
    -- intentionally outside application migration authority.
    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_roles
      WHERE rolname = role_name
        AND rolcanlogin = expected_login
        AND rolinherit = expected_inherit
        AND NOT rolsuper
        AND NOT rolcreatedb
        AND NOT rolcreaterole
        AND NOT rolreplication
        AND NOT rolbypassrls
    ) THEN
      RAISE EXCEPTION 'Unsafe role attributes: % does not match the required capability shape',
        role_name;
    END IF;
  END LOOP;

  -- Passwords are deployment secrets, never migration content.

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

-- Creating a schema requires CREATE on the database. Managed Postgres grants
-- that capability to the database owner session, not to a newly-created
-- no-login application owner. Create the empty schemas as the migrator while
-- assigning their ownership explicitly, then drop into the least-privilege
-- object owner for every object inside them.
CREATE SCHEMA IF NOT EXISTS app AUTHORIZATION r72_owner;
CREATE SCHEMA IF NOT EXISTS app_private AUTHORIZATION r72_owner;

SET LOCAL ROLE r72_owner;

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
