-- Group HQ sign-in handoff: one definer function that mints an ordinary portal
-- session for an owner the founder's Group HQ app has already authenticated, plus
-- the worker's discovery of webinars whose registrants await the automatic CRM
-- handoff. Additive only. No table changes.
--
-- Authority model: the web service verifies a short-lived HMAC token issued by
-- Group HQ (shared secret, nonce, host and path bound) and maps the asserted
-- Group HQ login email to a canonical user id from its own server-owned
-- allowlist. Only then does it call this function, which still refuses unless
-- that user is an active owner or admin of the requested workspace (and, for the
-- MHP audience, the MHP marketing owner). The session is the same opaque
-- app.user_sessions row a password login creates, bounded to twelve hours.

SET LOCAL ROLE r72_mhp_member_definer;
-- The MHP marketing allow-check is owned by the MHP member definer; the session
-- definer below may call it (and nothing else of MHP's).
GRANT EXECUTE ON FUNCTION app_private.mhp_marketing_workspace_allowed(uuid, uuid) TO r72_security_definer;

SET LOCAL ROLE r72_owner;
GRANT CREATE ON SCHEMA app_private TO r72_security_definer;
SET LOCAL ROLE r72_security_definer;

CREATE FUNCTION app_private.create_group_hq_delegated_session(
  p_user_id uuid,
  p_workspace_id uuid,
  p_product_audience text,
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
  -- Delegated access is shorter than a password session: Group HQ re-issues it in one click.
  selected_expires_at timestamptz := statement_timestamp() + interval '12 hours';
BEGIN
  IF p_user_id IS NULL OR p_workspace_id IS NULL
     OR p_product_audience IS NULL
     OR p_product_audience NOT IN ('property_predator_growth', 'martin_howard_property')
     OR p_token_hash IS NULL OR octet_length(p_token_hash) <> 32
     OR p_csrf_secret_hash IS NULL OR octet_length(p_csrf_secret_hash) <> 32
     OR p_token_hash = p_csrf_secret_hash
     OR (p_ip_hash IS NOT NULL AND octet_length(p_ip_hash) <> 32)
     OR (p_user_agent_hash IS NOT NULL AND octet_length(p_user_agent_hash) <> 32) THEN
    RAISE EXCEPTION 'invalid delegated session input' USING ERRCODE = '22023';
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
    AND membership.status = 'active'
    AND membership.revoked_at IS NULL
    AND membership.role IN ('owner', 'admin')
    AND workspace.status = 'active'
    AND organization.status = 'active'
  FOR SHARE OF person, membership, workspace, organization;

  -- Refusals return no row: the caller shows one neutral message and never learns why.
  IF selected_user_email IS NULL THEN
    RETURN;
  END IF;
  IF NOT app_private.can_manage_workspace(p_user_id, p_workspace_id) THEN
    RETURN;
  END IF;
  IF selected_source_organization_id IS NOT NULL THEN
    PERFORM 1
    FROM app.organization_memberships AS source_membership
    WHERE source_membership.organization_id = selected_source_organization_id
      AND source_membership.user_id = p_user_id
      AND source_membership.status = 'active'
    FOR SHARE OF source_membership;
    IF NOT FOUND THEN
      RETURN;
    END IF;
  END IF;
  -- An MHP-host session may only land in the MHP brand marketing workspace, as its owner.
  IF p_product_audience = 'martin_howard_property'
     AND NOT app_private.mhp_marketing_workspace_allowed(p_user_id, p_workspace_id) THEN
    RETURN;
  END IF;

  INSERT INTO app.user_sessions (
    token_hash, csrf_secret_hash, user_id, selected_workspace_id, expires_at, ip_hash, user_agent_hash, product_audience
  ) VALUES (
    p_token_hash, p_csrf_secret_hash, p_user_id, p_workspace_id, selected_expires_at, p_ip_hash, p_user_agent_hash, p_product_audience
  )
  ON CONFLICT (token_hash) DO NOTHING
  RETURNING id INTO created_session_id;

  -- The same verified handoff derives the same token hash on every instance.
  -- Only the first insertion may establish a session, including across restarts.
  IF created_session_id IS NULL THEN RETURN; END IF;

  RETURN QUERY SELECT
    created_session_id,
    p_user_id,
    selected_user_email,
    p_workspace_id,
    selected_expires_at;
END
$function$;

SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private FROM r72_security_definer;

REVOKE ALL ON FUNCTION app_private.create_group_hq_delegated_session(uuid, uuid, text, bytea, bytea, bytea, bytea)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.create_group_hq_delegated_session(uuid, uuid, text, bytea, bytea, bytea, bytea)
  TO r72_identity_command;

-- Workspaces with published webinars that opted in to the automatic CRM handoff
-- and still have registrants without a CRM contact. The worker visits each one.
CREATE FUNCTION app_private.webinar_crm_handoff_workspaces()
RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $f$
  SELECT DISTINCT g.workspace_id
  FROM app.webinar_registrations AS g
  JOIN app.webinar_events AS e ON e.workspace_id = g.workspace_id AND e.id = g.event_id
  WHERE e.status = 'published'
    AND e.created_by_user_id IS NOT NULL
    AND e.settings -> 'crmAutoHandoff' = 'true'::jsonb
    AND g.status = 'registered'
    AND g.crm_contact_id IS NULL
  LIMIT 500
$f$;

REVOKE ALL ON FUNCTION app_private.webinar_crm_handoff_workspaces() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.webinar_crm_handoff_workspaces() TO r72_content_command;
