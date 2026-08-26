-- Property Predator SSO identity link and opaque Growth HQ session issuance.
--
-- This migration does not create a user, organization, workspace or membership.
-- A first link requires one explicit, server-owned bootstrap user UUID and a
-- verified assertion accepted by the web process. Later sign-ins resolve only
-- the immutable issuer + subject pair. Provider tokens are never stored.

SET LOCAL ROLE r72_owner;

CREATE TABLE app.user_external_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE RESTRICT,
  issuer text NOT NULL CHECK (
    issuer = btrim(issuer)
    AND length(issuer) BETWEEN 12 AND 500
    AND issuer ~ '^https://[^[:space:]/?#]+$'
  ),
  subject uuid NOT NULL,
  asserted_email citext NOT NULL CHECK (
    asserted_email::text = lower(btrim(asserted_email::text))
    AND length(asserted_email::text) BETWEEN 3 AND 320
    AND asserted_email::text ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
  ),
  affiliate_member boolean NOT NULL DEFAULT false,
  affiliate_id uuid,
  affiliate_code text CHECK (
    affiliate_code IS NULL
    OR affiliate_code ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$'
  ),
  affiliate_code_status text CHECK (
    affiliate_code_status IS NULL
    OR (
      affiliate_code_status = lower(btrim(affiliate_code_status))
      AND affiliate_code_status ~ '^[a-z][a-z0-9_-]{0,31}$'
    )
  ),
  referrer_affiliate_id uuid,
  source_attached_at timestamptz,
  linked_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  last_authenticated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (issuer, subject),
  UNIQUE (issuer, user_id),
  CHECK (
    (
      affiliate_member
      AND affiliate_id IS NOT NULL
      AND affiliate_code IS NOT NULL
      AND affiliate_code_status IS NOT NULL
    )
    OR (
      NOT affiliate_member
      AND affiliate_id IS NULL
      AND affiliate_code IS NULL
      AND affiliate_code_status IS NULL
    )
  ),
  CHECK (last_authenticated_at >= linked_at)
);

ALTER TABLE app.user_external_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.user_external_identities FORCE ROW LEVEL SECURITY;

-- Federated sessions remain ordinary opaque HQ sessions, but retain their
-- minimal local provenance so one compromised external link can later be
-- audited/revoked without disturbing password sessions.
ALTER TABLE app.user_sessions
  ADD COLUMN external_identity_id uuid
    REFERENCES app.user_external_identities(id) ON DELETE RESTRICT;
CREATE INDEX user_sessions_external_identity_idx
  ON app.user_sessions (external_identity_id, created_at DESC)
  WHERE external_identity_id IS NOT NULL;

CREATE POLICY user_external_identities_owner_all
  ON app.user_external_identities FOR ALL TO r72_owner
  USING (true) WITH CHECK (true);
CREATE POLICY user_external_identities_security_select
  ON app.user_external_identities FOR SELECT TO r72_security_definer
  USING (true);
CREATE POLICY user_external_identities_security_insert
  ON app.user_external_identities FOR INSERT TO r72_security_definer
  WITH CHECK (true);
CREATE POLICY user_external_identities_security_update
  ON app.user_external_identities FOR UPDATE TO r72_security_definer
  USING (true) WITH CHECK (true);

REVOKE ALL ON app.user_external_identities FROM PUBLIC;
REVOKE ALL ON app.user_external_identities FROM
  r72_web, r72_public, r72_worker, r72_webhook, r72_readonly,
  r72_crm_command, r72_identity_command, r72_provisioning_command,
  r72_setup_delivery_command, r72_setup_reissue_command,
  r72_external_event_command, r72_import_command,
  r72_content_command, r72_content_adapter,
  r72_mailgun_webhook_command, r72_mailgun_worker_command;

GRANT SELECT, INSERT ON app.user_external_identities TO r72_security_definer;
GRANT UPDATE (
  asserted_email,
  affiliate_member,
  affiliate_id,
  affiliate_code,
  affiliate_code_status,
  referrer_affiliate_id,
  source_attached_at,
  last_authenticated_at
) ON app.user_external_identities TO r72_security_definer;

GRANT CREATE ON SCHEMA app_private TO r72_security_definer;
SET LOCAL ROLE r72_security_definer;

CREATE FUNCTION app_private.create_portal_external_identity_session(
  p_issuer text,
  p_subject uuid,
  p_asserted_email text,
  p_email_verified boolean,
  p_bootstrap_user_id uuid,
  p_affiliate_member boolean,
  p_affiliate_id uuid,
  p_affiliate_code text,
  p_affiliate_code_status text,
  p_referrer_affiliate_id uuid,
  p_source_attached_at timestamptz,
  p_session_token_hash bytea,
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
  normalized_issuer text := pg_catalog.btrim(p_issuer);
  normalized_asserted_email text := pg_catalog.lower(pg_catalog.btrim(p_asserted_email));
  normalized_affiliate_code text := nullif(pg_catalog.btrim(p_affiliate_code), '');
  normalized_affiliate_code_status text := nullif(pg_catalog.lower(pg_catalog.btrim(p_affiliate_code_status)), '');
  selected_identity_id uuid;
  selected_user_id uuid;
  selected_user_email text;
  selected_user_status text;
  selected_source_organization_id uuid;
  resolved_workspace_id uuid;
  created_session_id uuid;
  -- Until issuer lifecycle revocation is wired, bound federated access to a
  -- 24-hour pilot session. Password sessions retain their existing lifetime.
  selected_expires_at timestamptz := statement_timestamp() + interval '24 hours';
BEGIN
  IF p_issuer IS NULL
     OR normalized_issuer IS DISTINCT FROM p_issuer
     OR normalized_issuer <> 'https://propertypredator.com'
     OR length(normalized_issuer) NOT BETWEEN 12 AND 500
     OR normalized_issuer !~ '^https://[^[:space:]/?#]+$'
     OR p_subject IS NULL
     OR p_asserted_email IS NULL
     OR normalized_asserted_email IS DISTINCT FROM p_asserted_email
     OR length(normalized_asserted_email) NOT BETWEEN 3 AND 320
     OR normalized_asserted_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
     OR p_email_verified IS DISTINCT FROM true
     OR p_affiliate_member IS NULL
     OR (
       p_affiliate_member IS true
       AND (
         p_affiliate_id IS NULL
         OR normalized_affiliate_code IS NULL
         OR normalized_affiliate_code_status IS NULL
       )
     )
     OR (
       p_affiliate_member IS false
       AND (
         p_affiliate_id IS NOT NULL
         OR normalized_affiliate_code IS NOT NULL
         OR normalized_affiliate_code_status IS NOT NULL
       )
     )
     OR (
       normalized_affiliate_code IS NOT NULL
       AND normalized_affiliate_code !~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$'
     )
     OR (
       normalized_affiliate_code_status IS NOT NULL
       AND normalized_affiliate_code_status !~ '^[a-z][a-z0-9_-]{0,31}$'
     )
     OR (
       p_source_attached_at IS NOT NULL
       AND p_source_attached_at > statement_timestamp() + interval '5 minutes'
     )
     OR p_session_token_hash IS NULL
     OR octet_length(p_session_token_hash) <> 32
     OR p_csrf_secret_hash IS NULL
     OR octet_length(p_csrf_secret_hash) <> 32
     OR p_session_token_hash = p_csrf_secret_hash
     OR (p_ip_hash IS NOT NULL AND octet_length(p_ip_hash) <> 32)
     OR (p_user_agent_hash IS NOT NULL AND octet_length(p_user_agent_hash) <> 32) THEN
    RAISE EXCEPTION 'invalid external portal identity input'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'portal-external-identity:' || normalized_issuer || ':' || p_subject::text,
      7200029
    )
  );

  SELECT identity.id, identity.user_id
    INTO selected_identity_id, selected_user_id
  FROM app.user_external_identities AS identity
  WHERE identity.issuer = normalized_issuer
    AND identity.subject = p_subject
  FOR UPDATE OF identity;

  IF selected_identity_id IS NULL THEN
    -- First-link authority never comes from the browser assertion alone. The
    -- web service passes a UUID only after a verified email matched its exact,
    -- server-owned bootstrap allowlist.
    IF p_bootstrap_user_id IS NULL THEN
      RETURN;
    END IF;
    selected_user_id := p_bootstrap_user_id;
  ELSIF p_bootstrap_user_id IS NOT NULL
        AND p_bootstrap_user_id IS DISTINCT FROM selected_user_id THEN
    RAISE EXCEPTION 'external identity is already bound to another user'
      USING ERRCODE = '42501';
  END IF;

  SELECT person.email::text, person.status
    INTO selected_user_email, selected_user_status
  FROM app.users AS person
  WHERE person.id = selected_user_id
    AND person.status IN ('pending', 'active')
  FOR UPDATE OF person;

  IF selected_user_email IS NULL THEN
    RETURN;
  END IF;

  -- A different subject cannot race the same explicit bootstrap user into a
  -- second issuer link. The user row lock above serializes this recheck.
  IF selected_identity_id IS NULL THEN
    PERFORM 1
    FROM app.user_external_identities AS existing_user_identity
    WHERE existing_user_identity.issuer = normalized_issuer
      AND existing_user_identity.user_id = selected_user_id
    FOR UPDATE OF existing_user_identity;
    IF FOUND THEN
      RAISE EXCEPTION 'external identity user is already bound to another subject'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  SELECT membership.workspace_id, membership.source_organization_id
    INTO resolved_workspace_id, selected_source_organization_id
  FROM app.workspace_memberships AS membership
  JOIN app.workspaces AS workspace
    ON workspace.id = membership.workspace_id
   AND workspace.organization_id = membership.organization_id
  JOIN app.organizations AS organization
    ON organization.id = workspace.organization_id
  WHERE membership.user_id = selected_user_id
    AND membership.status = 'active'
    AND workspace.status = 'active'
    AND organization.status = 'active'
  ORDER BY CASE membership.role
    WHEN 'owner' THEN 1
    WHEN 'admin' THEN 2
    WHEN 'marketer' THEN 3
    WHEN 'sales' THEN 4
    ELSE 5
  END,
  membership.granted_at,
  membership.workspace_id
  LIMIT 1
  FOR SHARE OF membership, workspace, organization;

  IF resolved_workspace_id IS NULL THEN
    RETURN;
  END IF;

  IF selected_source_organization_id IS NOT NULL THEN
    PERFORM 1
    FROM app.organization_memberships AS source_membership
    WHERE source_membership.organization_id = selected_source_organization_id
      AND source_membership.user_id = selected_user_id
      AND source_membership.status = 'active'
    FOR SHARE OF source_membership;
    IF NOT FOUND THEN
      RETURN;
    END IF;
  END IF;

  IF selected_user_status = 'pending' THEN
    UPDATE app.users AS person
       SET status = 'active',
           email_verified_at = CASE
             WHEN pg_catalog.lower(person.email::text) = normalized_asserted_email
               THEN coalesce(person.email_verified_at, statement_timestamp())
             ELSE person.email_verified_at
           END,
           row_version = person.row_version + 1,
           updated_at = statement_timestamp()
     WHERE person.id = selected_user_id;
  END IF;

  IF selected_identity_id IS NULL THEN
    INSERT INTO app.user_external_identities (
      user_id,
      issuer,
      subject,
      asserted_email,
      affiliate_member,
      affiliate_id,
      affiliate_code,
      affiliate_code_status,
      referrer_affiliate_id,
      source_attached_at
    ) VALUES (
      selected_user_id,
      normalized_issuer,
      p_subject,
      normalized_asserted_email,
      p_affiliate_member,
      p_affiliate_id,
      normalized_affiliate_code,
      normalized_affiliate_code_status,
      p_referrer_affiliate_id,
      p_source_attached_at
    )
    RETURNING id INTO selected_identity_id;
  ELSE
    UPDATE app.user_external_identities AS identity
       SET asserted_email = normalized_asserted_email,
           affiliate_member = p_affiliate_member,
           affiliate_id = p_affiliate_id,
           affiliate_code = normalized_affiliate_code,
           affiliate_code_status = normalized_affiliate_code_status,
           referrer_affiliate_id = p_referrer_affiliate_id,
           source_attached_at = p_source_attached_at,
           last_authenticated_at = statement_timestamp()
     WHERE identity.id = selected_identity_id
       AND identity.user_id = selected_user_id;
  END IF;

  -- SSO activation retires every outstanding password-setup capability. The
  -- existing 0008 trigger immediately supersedes and erases any live encrypted
  -- setup delivery without sending it.
  UPDATE app.identity_action_tokens AS action_token
     SET revoked_at = statement_timestamp()
   WHERE action_token.user_id = selected_user_id
     AND action_token.purpose = 'account_setup'
     AND action_token.consumed_at IS NULL
     AND action_token.revoked_at IS NULL;

  INSERT INTO app.user_sessions (
    token_hash,
    csrf_secret_hash,
    user_id,
    selected_workspace_id,
    external_identity_id,
    expires_at,
    ip_hash,
    user_agent_hash
  ) VALUES (
    p_session_token_hash,
    p_csrf_secret_hash,
    selected_user_id,
    resolved_workspace_id,
    selected_identity_id,
    selected_expires_at,
    p_ip_hash,
    p_user_agent_hash
  )
  RETURNING id INTO created_session_id;

  RETURN QUERY SELECT
    created_session_id,
    selected_user_id,
    selected_user_email,
    resolved_workspace_id,
    selected_expires_at;
END
$function$;

SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private FROM r72_security_definer;

REVOKE ALL ON FUNCTION app_private.create_portal_external_identity_session(
  text, uuid, text, boolean, uuid, boolean, uuid, text, text, uuid,
  timestamptz, bytea, bytea, bytea, bytea
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.create_portal_external_identity_session(
  text, uuid, text, boolean, uuid, boolean, uuid, text, text, uuid,
  timestamptz, bytea, bytea, bytea, bytea
) TO r72_identity_command;
