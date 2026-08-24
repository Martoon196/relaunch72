-- Remove the temporary JSON-tenant compatibility key from PostgreSQL portal
-- authority. Fresh database users and workspaces are now the only identity
-- source; the nullable legacy column remains dormant for local demo cleanup.

SET LOCAL ROLE r72_owner;

-- The existing functions are owned by the non-login security-definer role.
-- Grant CREATE only for this migration transaction, recreate the functions
-- under that exact owner, then revoke schema mutation again.
GRANT CREATE ON SCHEMA app_private TO r72_security_definer;
SET LOCAL ROLE r72_security_definer;

DROP FUNCTION app_private.portal_login_credential(text);
DROP FUNCTION app_private.create_portal_session(uuid, uuid, text, bytea, bytea, bytea, bytea);
DROP FUNCTION app_private.resolve_portal_session(bytea);
DROP FUNCTION app_private.upgrade_portal_password_hash(uuid, text, text);

-- Password verification stays in Node. This function returns one active
-- credential and one deterministic active workspace to the isolated identity
-- command role. Email and UUIDs are context; only the opaque session becomes
-- browser authority.
CREATE FUNCTION app_private.portal_login_credential(p_email text)
RETURNS TABLE (
  user_id uuid,
  user_email text,
  password_hash text,
  selected_workspace_id uuid
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT person.id,
         person.email::text,
         person.password_hash,
         membership.workspace_id
  FROM app.users AS person
  JOIN LATERAL (
    SELECT candidate.workspace_id,
           candidate.role,
           candidate.granted_at
    FROM app.workspace_memberships AS candidate
    WHERE candidate.user_id = person.id
      AND candidate.status = 'active'
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
    RAISE EXCEPTION 'invalid portal session input' USING ERRCODE = '22023';
  END IF;

  SELECT person.email::text,
         membership.source_organization_id
    INTO selected_user_email,
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
    AND organization.status = 'active'
  FOR SHARE OF person, membership, workspace, organization;

  IF selected_user_email IS NULL THEN
    RAISE EXCEPTION 'portal identity is not active in the selected workspace'
      USING ERRCODE = '42501';
  END IF;

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
    selected_expires_at;
END
$function$;

CREATE FUNCTION app_private.resolve_portal_session(p_token_hash bytea)
RETURNS TABLE (
  session_id uuid,
  user_id uuid,
  user_email text,
  selected_workspace_id uuid
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT resolved.session_id,
         resolved.user_id,
         person.email::text,
         resolved.selected_workspace_id
  FROM app_private.resolve_session(p_token_hash) AS resolved
  JOIN app.users AS person
    ON person.id = resolved.user_id
   AND person.status = 'active'
$function$;

SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private FROM r72_security_definer;

REVOKE ALL ON FUNCTION app_private.portal_login_credential(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.create_portal_session(uuid, uuid, text, bytea, bytea, bytea, bytea)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.resolve_portal_session(bytea) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION app_private.portal_login_credential(text)
  TO r72_identity_command;
GRANT EXECUTE ON FUNCTION app_private.create_portal_session(uuid, uuid, text, bytea, bytea, bytea, bytea)
  TO r72_identity_command;
GRANT EXECUTE ON FUNCTION app_private.resolve_portal_session(bytea)
  TO r72_web;
