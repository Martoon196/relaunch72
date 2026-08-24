-- Opaque portal sessions and the deliberately narrow pre-context login role.
-- This migration does not activate the portal or import a customer. It only
-- creates the database contracts that an explicitly enabled runtime can use.

DO $roles$
DECLARE
  unexpected_parent text;
  unexpected_member text;
  privileged_parent text;
  privileged_member text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'r72_identity_command'
  ) THEN
    CREATE ROLE r72_identity_command LOGIN NOINHERIT;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_roles
    WHERE rolname = 'r72_identity_command'
      AND rolcanlogin
      AND NOT rolinherit
      AND NOT rolsuper
      AND NOT rolcreatedb
      AND NOT rolcreaterole
      AND NOT rolreplication
      AND NOT rolbypassrls
  ) THEN
    RAISE EXCEPTION 'Unsafe role attributes: r72_identity_command does not match the required capability shape';
  END IF;

  REVOKE r72_owner, r72_security_definer FROM r72_identity_command;
  REVOKE r72_identity_command
    FROM r72_web, r72_public, r72_worker, r72_webhook, r72_readonly, r72_crm_command;

  SELECT parent.rolname
    INTO unexpected_parent
  FROM pg_catalog.pg_auth_members AS membership
  JOIN pg_catalog.pg_roles AS member ON member.oid = membership.member
  JOIN pg_catalog.pg_roles AS parent ON parent.oid = membership.roleid
  WHERE member.rolname = 'r72_identity_command'
  LIMIT 1;

  IF unexpected_parent IS NOT NULL THEN
    RAISE EXCEPTION 'Unsafe identity role membership: r72_identity_command can SET ROLE %',
      unexpected_parent;
  END IF;

  SELECT member.rolname
    INTO unexpected_member
  FROM pg_catalog.pg_auth_members AS membership
  JOIN pg_catalog.pg_roles AS member ON member.oid = membership.member
  JOIN pg_catalog.pg_roles AS parent ON parent.oid = membership.roleid
  WHERE parent.rolname = 'r72_identity_command'
    AND member.rolname <> current_user
  LIMIT 1;

  IF unexpected_member IS NOT NULL THEN
    RAISE EXCEPTION 'Unsafe identity role grant: % can SET ROLE r72_identity_command',
      unexpected_member;
  END IF;

  -- 0004 expands the non-login function owner's table privileges, so re-audit
  -- both privileged membership directions before those grants are applied.
  -- r72_owner may assume only r72_security_definer; the definer has no parent.
  SELECT member.rolname, parent.rolname
    INTO privileged_member, privileged_parent
  FROM pg_catalog.pg_auth_members AS membership
  JOIN pg_catalog.pg_roles AS member ON member.oid = membership.member
  JOIN pg_catalog.pg_roles AS parent ON parent.oid = membership.roleid
  WHERE (member.rolname = 'r72_owner' AND parent.rolname <> 'r72_security_definer')
     OR member.rolname = 'r72_security_definer'
  LIMIT 1;

  IF privileged_member IS NOT NULL THEN
    RAISE EXCEPTION 'Unsafe privileged role membership: % can SET ROLE %',
      privileged_member, privileged_parent;
  END IF;

  -- The trusted migrator may assume both privileged roles; managed PostgreSQL
  -- can automatically grant a role creator membership in the role it creates.
  -- Apart from that migrator, only r72_owner may assume the security definer.
  -- Any arbitrary LOGIN member would bypass the function boundary.
  SELECT member.rolname, parent.rolname
    INTO privileged_member, privileged_parent
  FROM pg_catalog.pg_auth_members AS membership
  JOIN pg_catalog.pg_roles AS member ON member.oid = membership.member
  JOIN pg_catalog.pg_roles AS parent ON parent.oid = membership.roleid
  WHERE (parent.rolname = 'r72_owner' AND member.rolname <> current_user)
     OR (
       parent.rolname = 'r72_security_definer'
       AND member.rolname NOT IN ('r72_owner', current_user)
     )
  LIMIT 1;

  IF privileged_member IS NOT NULL THEN
    RAISE EXCEPTION 'Unsafe privileged role grant: % can SET ROLE %',
      privileged_member, privileged_parent;
  END IF;

  -- Test/migration identities may SET LOCAL ROLE for exact integration proofs.
  EXECUTE format('GRANT r72_identity_command TO %I', current_user);
END
$roles$;

SET LOCAL ROLE r72_owner;

-- Fail closed if this role existed with unrelated privileges. The application
-- identity can execute only the functions explicitly granted at the end.
REVOKE ALL ON SCHEMA app, app_private FROM r72_identity_command;
REVOKE ALL ON ALL TABLES IN SCHEMA app FROM r72_identity_command;
REVOKE ALL ON ALL TABLES IN SCHEMA app_private FROM r72_identity_command;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA app_private FROM r72_identity_command;
GRANT USAGE ON SCHEMA app_private TO r72_identity_command;

-- The non-login function owner receives only the table permissions needed by
-- these functions. FORCE RLS remains active, so matching policies are explicit.
GRANT SELECT ON app_private.schema_migrations TO r72_security_definer;
GRANT INSERT ON app.user_sessions TO r72_security_definer;
GRANT UPDATE (revoked_at, last_seen_at) ON app.user_sessions TO r72_security_definer;
GRANT UPDATE (password_hash, row_version, updated_at) ON app.users TO r72_security_definer;
-- PostgreSQL requires UPDATE privilege on at least one column of every table
-- named in a SELECT ... FOR SHARE clause. updated_at is deliberately the only
-- granted column here, and FORCE RLS still provides no UPDATE policy to this
-- role; the grant enables row locks, not direct status or membership changes.
GRANT UPDATE (updated_at) ON app.organizations, app.workspaces,
  app.organization_memberships, app.workspace_memberships
  TO r72_security_definer;

CREATE POLICY user_sessions_security_insert ON app.user_sessions
  FOR INSERT TO r72_security_definer WITH CHECK (true);
CREATE POLICY user_sessions_security_update ON app.user_sessions
  FOR UPDATE TO r72_security_definer USING (true) WITH CHECK (true);
CREATE POLICY users_security_password_update ON app.users
  FOR UPDATE TO r72_security_definer USING (true) WITH CHECK (true);
CREATE POLICY organizations_security_lock ON app.organizations
  FOR UPDATE TO r72_security_definer USING (true) WITH CHECK (true);
CREATE POLICY workspaces_security_lock ON app.workspaces
  FOR UPDATE TO r72_security_definer USING (true) WITH CHECK (true);
CREATE POLICY organization_memberships_security_lock ON app.organization_memberships
  FOR UPDATE TO r72_security_definer USING (true) WITH CHECK (true);
CREATE POLICY workspace_memberships_security_lock ON app.workspace_memberships
  FOR UPDATE TO r72_security_definer USING (true) WITH CHECK (true);

GRANT CREATE ON SCHEMA app_private TO r72_security_definer;

-- A runtime can compare this exact ledger with its bundled migration files
-- without receiving direct SELECT permission on the private migration table.
CREATE FUNCTION app_private.runtime_schema_migrations()
RETURNS TABLE (filename text, checksum text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT migration.filename, migration.checksum
  FROM app_private.schema_migrations AS migration
  ORDER BY migration.filename
$function$;

-- Password verification remains in Node because the imported credential format
-- is versioned scrypt. This function reveals one active credential and one
-- deterministic active workspace only to the isolated identity-command role.
CREATE FUNCTION app_private.portal_login_credential(p_email text)
RETURNS TABLE (
  user_id uuid,
  user_email text,
  password_hash text,
  selected_workspace_id uuid,
  legacy_tenant_key text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT person.id,
         person.email::text,
         person.password_hash,
         membership.workspace_id,
         membership.legacy_tenant_key
  FROM app.users AS person
  JOIN LATERAL (
    SELECT candidate.workspace_id,
           candidate.role,
           candidate.granted_at,
           candidate_workspace.legacy_tenant_key
    FROM app.workspace_memberships AS candidate
    JOIN app.workspaces AS candidate_workspace
      ON candidate_workspace.id = candidate.workspace_id
    WHERE candidate.user_id = person.id
      AND candidate.status = 'active'
      AND candidate_workspace.legacy_tenant_key IS NOT NULL
      AND length(candidate_workspace.legacy_tenant_key) BETWEEN 1 AND 256
      AND candidate_workspace.legacy_tenant_key = btrim(candidate_workspace.legacy_tenant_key)
      AND app_private.has_active_workspace_membership(person.id, candidate.workspace_id)
    ORDER BY CASE candidate.role
      WHEN 'owner' THEN 1
      WHEN 'admin' THEN 2
      WHEN 'marketer' THEN 3
      WHEN 'sales' THEN 4
      ELSE 5
    END,
    candidate.granted_at,
    candidate.workspace_id
    LIMIT 1
  ) AS membership ON true
  WHERE pg_catalog.lower(person.email::text) = pg_catalog.lower(pg_catalog.btrim(p_email))
    AND person.status = 'active'
    AND person.password_hash IS NOT NULL
$function$;

CREATE FUNCTION app_private.create_portal_session(
  p_user_id uuid,
  p_workspace_id uuid,
  p_expected_password_hash text,
  p_token_hash bytea,
  p_csrf_secret_hash bytea,
  p_ip_hash bytea DEFAULT NULL,
  p_user_agent_hash bytea DEFAULT NULL
)
RETURNS TABLE (
  session_id uuid,
  user_id uuid,
  user_email text,
  selected_workspace_id uuid,
  legacy_tenant_key text,
  expires_at timestamptz
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  created_session_id uuid;
  selected_user_email text;
  selected_legacy_tenant_key text;
  selected_source_organization_id uuid;
  selected_expires_at timestamptz := statement_timestamp() + interval '14 days';
BEGIN
  IF p_token_hash IS NULL OR octet_length(p_token_hash) <> 32
     OR p_csrf_secret_hash IS NULL OR octet_length(p_csrf_secret_hash) <> 32
     OR p_expected_password_hash IS NULL
     OR length(p_expected_password_hash) < 20
     OR length(p_expected_password_hash) > 1024
     OR (p_ip_hash IS NOT NULL AND octet_length(p_ip_hash) <> 32)
     OR (p_user_agent_hash IS NOT NULL AND octet_length(p_user_agent_hash) <> 32) THEN
    RAISE EXCEPTION 'invalid portal session hash length' USING ERRCODE = '22023';
  END IF;

  SELECT person.email::text,
         workspace.legacy_tenant_key,
         membership.source_organization_id
    INTO selected_user_email,
         selected_legacy_tenant_key,
         selected_source_organization_id
  FROM app.users AS person
  JOIN app.workspace_memberships AS membership
    ON membership.user_id = person.id
   AND membership.workspace_id = p_workspace_id
  JOIN app.workspaces AS workspace
    ON workspace.id = membership.workspace_id
   AND workspace.organization_id = membership.organization_id
  JOIN app.organizations AS organization
    ON organization.id = workspace.organization_id
  WHERE person.id = p_user_id
    AND person.status = 'active'
    AND person.password_hash = p_expected_password_hash
    AND membership.status = 'active'
    AND workspace.status = 'active'
    AND workspace.legacy_tenant_key IS NOT NULL
    AND length(workspace.legacy_tenant_key) BETWEEN 1 AND 256
    AND workspace.legacy_tenant_key = btrim(workspace.legacy_tenant_key)
    AND organization.status = 'active'
  -- Linearize issuance with password, direct-membership, workspace, and
  -- organization changes. These locks remain held through the session INSERT.
  FOR SHARE OF person, membership, workspace, organization;

  IF selected_legacy_tenant_key IS NULL THEN
    RAISE EXCEPTION 'portal identity is not active in a bridged workspace'
      USING ERRCODE = '42501';
  END IF;

  -- An agency-sourced workspace membership stays valid only while its source
  -- organization membership is active. Lock that row separately because it is
  -- optional and PostgreSQL cannot lock the nullable side of an outer join.
  IF selected_source_organization_id IS NOT NULL THEN
    PERFORM 1
    FROM app.organization_memberships AS source_membership
    WHERE source_membership.organization_id = selected_source_organization_id
      AND source_membership.user_id = p_user_id
      AND source_membership.status = 'active'
    FOR SHARE OF source_membership;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'portal identity source membership is not active'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  INSERT INTO app.user_sessions (
    token_hash,
    csrf_secret_hash,
    user_id,
    selected_workspace_id,
    expires_at,
    ip_hash,
    user_agent_hash
  ) VALUES (
    p_token_hash,
    p_csrf_secret_hash,
    p_user_id,
    p_workspace_id,
    selected_expires_at,
    p_ip_hash,
    p_user_agent_hash
  )
  RETURNING id INTO created_session_id;

  RETURN QUERY SELECT
    created_session_id,
    p_user_id,
    selected_user_email,
    p_workspace_id,
    selected_legacy_tenant_key,
    selected_expires_at;
END
$function$;

CREATE FUNCTION app_private.resolve_portal_session(p_token_hash bytea)
RETURNS TABLE (
  session_id uuid,
  user_id uuid,
  user_email text,
  selected_workspace_id uuid,
  legacy_tenant_key text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT resolved.session_id,
         resolved.user_id,
         person.email::text,
         resolved.selected_workspace_id,
         workspace.legacy_tenant_key
  FROM app_private.resolve_session(p_token_hash) AS resolved
  JOIN app.users AS person
    ON person.id = resolved.user_id
   AND person.status = 'active'
  JOIN app.workspaces AS workspace
    ON workspace.id = resolved.selected_workspace_id
   AND workspace.status = 'active'
   AND workspace.legacy_tenant_key IS NOT NULL
   AND length(workspace.legacy_tenant_key) BETWEEN 1 AND 256
   AND workspace.legacy_tenant_key = btrim(workspace.legacy_tenant_key)
$function$;

-- CRM reads and writes call this inside their own transaction. The row lock
-- gives revocation a deterministic order: either revoke wins and this returns
-- false, or the already-authorized transaction commits before revoke proceeds.
CREATE FUNCTION app_private.lock_active_portal_session(
  p_token_hash bytea,
  p_user_id uuid,
  p_workspace_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  locked_session_id uuid;
BEGIN
  IF p_token_hash IS NULL OR octet_length(p_token_hash) <> 32 THEN
    RETURN false;
  END IF;
  SELECT session.id
    INTO locked_session_id
  FROM app.user_sessions AS session
  JOIN app.users AS person ON person.id = session.user_id
  WHERE session.token_hash = p_token_hash
    AND session.user_id = p_user_id
    AND session.selected_workspace_id = p_workspace_id
    AND session.revoked_at IS NULL
    AND session.expires_at > statement_timestamp()
    AND person.status = 'active'
    AND app_private.has_active_workspace_membership(p_user_id, p_workspace_id)
  FOR SHARE OF session;
  RETURN locked_session_id IS NOT NULL;
END
$function$;

-- Repeatable-read page snapshots cannot take row locks in a READ ONLY
-- transaction. This predicate revalidates the same tuple in that transaction's
-- snapshot, which gives the read a clear before/after-revocation ordering.
CREATE FUNCTION app_private.active_portal_session(
  p_token_hash bytea,
  p_user_id uuid,
  p_workspace_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT p_token_hash IS NOT NULL
    AND octet_length(p_token_hash) = 32
    AND EXISTS (
      SELECT 1
      FROM app.user_sessions AS session
      JOIN app.users AS person ON person.id = session.user_id
      WHERE session.token_hash = p_token_hash
        AND session.user_id = p_user_id
        AND session.selected_workspace_id = p_workspace_id
        AND session.revoked_at IS NULL
        AND session.expires_at > statement_timestamp()
        AND person.status = 'active'
        AND app_private.has_active_workspace_membership(p_user_id, p_workspace_id)
    )
$function$;

CREATE FUNCTION app_private.revoke_portal_session(p_token_hash bytea)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  changed_count bigint;
BEGIN
  IF p_token_hash IS NULL OR octet_length(p_token_hash) <> 32 THEN
    RETURN false;
  END IF;
  UPDATE app.user_sessions AS session
     SET revoked_at = statement_timestamp()
   WHERE session.token_hash = p_token_hash
     AND session.revoked_at IS NULL;
  GET DIAGNOSTICS changed_count = ROW_COUNT;
  RETURN changed_count = 1;
END
$function$;

-- Successful verification of an imported legacy SHA-256 row may opportunistically
-- replace it with scrypt. The expected hash makes this a compare-and-swap.
CREATE FUNCTION app_private.upgrade_portal_password_hash(
  p_user_id uuid,
  p_expected_hash text,
  p_replacement_hash text
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  changed_count bigint;
BEGIN
  IF p_expected_hash IS NULL OR p_replacement_hash IS NULL
     OR length(p_expected_hash) < 20 OR length(p_expected_hash) > 1024
     OR length(p_replacement_hash) < 20 OR length(p_replacement_hash) > 1024 THEN
    RETURN false;
  END IF;
  UPDATE app.users AS person
     SET password_hash = p_replacement_hash,
         row_version = person.row_version + 1,
         updated_at = statement_timestamp()
   WHERE person.id = p_user_id
     AND person.status = 'active'
     AND person.password_hash = p_expected_hash;
  GET DIAGNOSTICS changed_count = ROW_COUNT;
  RETURN changed_count = 1;
END
$function$;

ALTER FUNCTION app_private.runtime_schema_migrations() OWNER TO r72_security_definer;
ALTER FUNCTION app_private.portal_login_credential(text) OWNER TO r72_security_definer;
ALTER FUNCTION app_private.create_portal_session(uuid, uuid, text, bytea, bytea, bytea, bytea)
  OWNER TO r72_security_definer;
ALTER FUNCTION app_private.resolve_portal_session(bytea) OWNER TO r72_security_definer;
ALTER FUNCTION app_private.lock_active_portal_session(bytea, uuid, uuid)
  OWNER TO r72_security_definer;
ALTER FUNCTION app_private.active_portal_session(bytea, uuid, uuid)
  OWNER TO r72_security_definer;
ALTER FUNCTION app_private.revoke_portal_session(bytea) OWNER TO r72_security_definer;
ALTER FUNCTION app_private.upgrade_portal_password_hash(uuid, text, text)
  OWNER TO r72_security_definer;

REVOKE CREATE ON SCHEMA app_private FROM r72_security_definer;

REVOKE ALL ON FUNCTION app_private.runtime_schema_migrations() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.portal_login_credential(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.create_portal_session(uuid, uuid, text, bytea, bytea, bytea, bytea)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.resolve_portal_session(bytea) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.lock_active_portal_session(bytea, uuid, uuid)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.active_portal_session(bytea, uuid, uuid)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.revoke_portal_session(bytea) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.upgrade_portal_password_hash(uuid, text, text)
  FROM PUBLIC;

GRANT EXECUTE ON FUNCTION app_private.runtime_schema_migrations() TO r72_web;
GRANT EXECUTE ON FUNCTION app_private.resolve_portal_session(bytea) TO r72_web;
GRANT EXECUTE ON FUNCTION app_private.lock_active_portal_session(bytea, uuid, uuid)
  TO r72_crm_command;
GRANT EXECUTE ON FUNCTION app_private.active_portal_session(bytea, uuid, uuid)
  TO r72_web;
GRANT EXECUTE ON FUNCTION app_private.portal_login_credential(text) TO r72_identity_command;
GRANT EXECUTE ON FUNCTION app_private.create_portal_session(uuid, uuid, text, bytea, bytea, bytea, bytea)
  TO r72_identity_command;
GRANT EXECUTE ON FUNCTION app_private.revoke_portal_session(bytea) TO r72_identity_command;
GRANT EXECUTE ON FUNCTION app_private.upgrade_portal_password_hash(uuid, text, text)
  TO r72_identity_command;
