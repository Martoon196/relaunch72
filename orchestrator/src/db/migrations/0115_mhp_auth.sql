-- LOCAL SOURCE ONLY, MHP-DESK-001 / Root scope decision MHP-AUTH-BOUNDARY-01.
-- This migration is not executed by authoring it. Isolated rehearsal and release review precede production.
-- The two existing public PP functions keep signatures/grants and gain only the founder-required brand boundary.
DO $role$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='r72_mhp_auth_definer') THEN CREATE ROLE r72_mhp_auth_definer NOLOGIN NOINHERIT; END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='r72_mhp_auth_definer' AND (rolcanlogin OR rolinherit OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)) THEN RAISE EXCEPTION 'Unsafe MHP auth definer'; END IF;
 IF EXISTS(SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member WHERE r.rolname='r72_mhp_auth_definer') THEN RAISE EXCEPTION 'MHP auth definer must not inherit'; END IF;
 IF EXISTS(SELECT 1 FROM pg_auth_members m JOIN pg_roles p ON p.oid=m.roleid JOIN pg_roles c ON c.oid=m.member WHERE p.rolname='r72_mhp_auth_definer' AND c.rolname NOT IN ('r72_owner',current_user)) THEN RAISE EXCEPTION 'Unexpected MHP auth definer member'; END IF;
 GRANT r72_mhp_auth_definer TO r72_owner;
 EXECUTE format('GRANT r72_mhp_auth_definer TO %I',current_user);
END $role$;
SET LOCAL ROLE r72_owner;
ALTER TABLE app.user_sessions ADD COLUMN product_audience text NOT NULL DEFAULT 'property_predator_growth'
 CHECK(product_audience IN ('property_predator_growth','martin_howard_property'));

CREATE TABLE app_private.mhp_auth_tokens (
 token_hash bytea PRIMARY KEY CHECK(octet_length(token_hash)=32),
 email text NOT NULL CHECK(email=lower(btrim(email)) AND length(email) BETWEEN 3 AND 320 AND email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'),
 purpose text NOT NULL CHECK(purpose IN ('magic','reset')),
 requested_source_hash bytea NOT NULL CHECK(octet_length(requested_source_hash)=32),
 expires_at timestamptz NOT NULL,consumed_at timestamptz,revoked_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(expires_at>created_at),CHECK(consumed_at IS NULL OR revoked_at IS NULL)
);
CREATE INDEX mhp_auth_tokens_email_recent ON app_private.mhp_auth_tokens(email,created_at DESC);
ALTER TABLE app_private.mhp_auth_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.mhp_auth_tokens FORCE ROW LEVEL SECURITY;
CREATE POLICY mhp_auth_tokens_owner ON app_private.mhp_auth_tokens TO r72_owner USING(true) WITH CHECK(true);
CREATE POLICY mhp_auth_tokens_definer ON app_private.mhp_auth_tokens TO r72_mhp_auth_definer USING(true) WITH CHECK(true);
REVOKE ALL ON app_private.mhp_auth_tokens FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE ON app_private.mhp_auth_tokens TO r72_mhp_auth_definer;
GRANT USAGE ON SCHEMA app,app_private TO r72_mhp_auth_definer;
GRANT SELECT,INSERT ON app.users,app.user_sessions TO r72_mhp_auth_definer;
-- status is used ONLY for verified pending -> active inside consume_mhp_auth_token; suspended is refused.
GRANT UPDATE(password_hash,email_verified_at,status,row_version,updated_at) ON app.users TO r72_mhp_auth_definer;
GRANT UPDATE(revoked_at) ON app.user_sessions,app.identity_action_tokens TO r72_mhp_auth_definer;
GRANT SELECT ON app.identity_action_tokens,app_private.mhp_members TO r72_mhp_auth_definer;
CREATE POLICY mhp_auth_users ON app.users TO r72_mhp_auth_definer USING(true) WITH CHECK(true);
CREATE POLICY mhp_auth_sessions ON app.user_sessions TO r72_mhp_auth_definer USING(true) WITH CHECK(true);
CREATE POLICY mhp_auth_identity_tokens ON app.identity_action_tokens TO r72_mhp_auth_definer USING(true) WITH CHECK(true);
CREATE POLICY mhp_auth_member_read ON app_private.mhp_members FOR SELECT TO r72_mhp_auth_definer USING(true);
GRANT EXECUTE ON FUNCTION app_private.resolve_session(bytea),app_private.has_active_workspace_membership(uuid,uuid),app_private.mhp_has_purchase_email(text),app_private.mhp_bind_verified_purchases(uuid) TO r72_mhp_auth_definer;

-- Exactly the existing 0005 migration ownership pattern. No LOGIN role receives CREATE.
GRANT CREATE ON SCHEMA app_private TO r72_security_definer;
SET LOCAL ROLE r72_security_definer;
CREATE OR REPLACE FUNCTION app_private.portal_login_credential(p_email text)
RETURNS TABLE(user_id uuid,user_email text,password_hash text,selected_workspace_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
 SELECT person.id,person.email::text,person.password_hash,membership.workspace_id
 FROM app.users person JOIN LATERAL (
  SELECT candidate.workspace_id FROM app.workspace_memberships candidate
  WHERE candidate.user_id=person.id AND candidate.status='active'
   AND NOT EXISTS(SELECT 1 FROM app_private.mhp_members mhp WHERE mhp.workspace_id=candidate.workspace_id)
   AND app_private.has_active_workspace_membership(person.id,candidate.workspace_id)
  ORDER BY CASE candidate.role WHEN 'owner' THEN 1 WHEN 'admin' THEN 2 WHEN 'marketer' THEN 3 WHEN 'sales' THEN 4 ELSE 5 END,candidate.granted_at,candidate.workspace_id LIMIT 1
 ) membership ON true
 WHERE lower(person.email::text)=lower(btrim(p_email)) AND person.status='active' AND person.password_hash IS NOT NULL
$f$;
CREATE OR REPLACE FUNCTION app_private.resolve_portal_session(p_token_hash bytea)
RETURNS TABLE(session_id uuid,user_id uuid,user_email text,selected_workspace_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
 SELECT resolved.session_id,resolved.user_id,person.email::text,resolved.selected_workspace_id
 FROM app_private.resolve_session(p_token_hash) resolved
 JOIN app.user_sessions session ON session.id=resolved.session_id AND session.product_audience='property_predator_growth'
 JOIN app.users person ON person.id=resolved.user_id AND person.status='active'
 WHERE NOT EXISTS(SELECT 1 FROM app_private.mhp_members mhp WHERE mhp.workspace_id=resolved.selected_workspace_id)
$f$;
-- MHP-AUTH-BOUNDARY-02: exact 0029 SSO body with only the workspace exclusion added.
CREATE OR REPLACE FUNCTION app_private.create_portal_external_identity_session(
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
    AND NOT EXISTS (SELECT 1 FROM app_private.mhp_members mhp WHERE mhp.workspace_id = membership.workspace_id)
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

GRANT CREATE ON SCHEMA app_private TO r72_mhp_auth_definer;
SET LOCAL ROLE r72_mhp_auth_definer;
CREATE FUNCTION app_private.mhp_auth_eligible(p_email text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
 SELECT p_email IN ('office@propertypredator.com','martin.howard1984@gmail.com')
  OR app_private.mhp_has_purchase_email(p_email)
  OR EXISTS(SELECT 1 FROM app_private.mhp_members m
   WHERE lower(m.owner_email::text)=p_email AND (m.user_id IS NOT NULL OR m.manual_active))
$f$;
CREATE FUNCTION app_private.request_mhp_auth_token(p_email text,p_purpose text,p_hash bytea,p_source bytea)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE v_email text:=lower(btrim(p_email));
BEGIN
 IF v_email IS NULL OR length(v_email) NOT BETWEEN 3 AND 320 OR v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
  OR p_purpose IS NULL OR p_purpose NOT IN ('magic','reset') OR p_hash IS NULL OR octet_length(p_hash)<>32 OR p_source IS NULL OR octet_length(p_source)<>32 THEN RETURN false; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(v_email,115));
 IF NOT app_private.mhp_auth_eligible(v_email) OR EXISTS(SELECT 1 FROM app.users WHERE lower(email::text)=v_email AND status='suspended')
  OR (SELECT count(*) FROM app_private.mhp_auth_tokens WHERE email=v_email AND created_at>clock_timestamp()-interval '15 minutes')>=3 THEN RETURN false; END IF;
 INSERT INTO app_private.mhp_auth_tokens(token_hash,email,purpose,requested_source_hash,expires_at) VALUES(p_hash,v_email,p_purpose,p_source,clock_timestamp()+interval '15 minutes');
 RETURN true;
END $f$;
CREATE FUNCTION app_private.mhp_login_credential(p_email text)
RETURNS TABLE(user_id uuid,user_email text,password_hash text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
 SELECT id,email::text,password_hash FROM app.users WHERE lower(email::text)=lower(btrim(p_email))
  AND status='active' AND email_verified_at IS NOT NULL AND password_hash IS NOT NULL AND app_private.mhp_auth_eligible(lower(email::text))
$f$;
-- No runtime EXECUTE: this helper is reachable only after password verification or atomic email-token consumption.
-- 0116 supplies ensure_mhp_member_workspace before runtime becomes ready.
CREATE FUNCTION app_private.issue_mhp_session(p_user uuid,p_session bytea,p_csrf bytea,p_source bytea,p_ua bytea)
RETURNS TABLE(session_id uuid,user_id uuid,user_email text,selected_workspace_id uuid,expires_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE v_workspace uuid; v_id uuid; v_email text; v_expiry timestamptz:=clock_timestamp()+interval '24 hours';
BEGIN
 IF p_session IS NULL OR octet_length(p_session)<>32 OR p_csrf IS NULL OR octet_length(p_csrf)<>32 OR p_source IS NULL OR octet_length(p_source)<>32
  OR (p_ua IS NOT NULL AND octet_length(p_ua)<>32) THEN RAISE EXCEPTION 'Invalid MHP session evidence' USING ERRCODE='22023'; END IF;
 SELECT email::text INTO v_email FROM app.users WHERE id=p_user AND status='active' AND email_verified_at IS NOT NULL FOR UPDATE;
 IF v_email IS NULL THEN RAISE EXCEPTION 'Verified account required' USING ERRCODE='42501'; END IF;
 PERFORM app_private.mhp_bind_verified_purchases(p_user);
 v_workspace:=app_private.ensure_mhp_member_workspace(p_user);
 IF v_workspace IS NULL OR NOT app_private.has_active_workspace_membership(p_user,v_workspace) THEN RAISE EXCEPTION 'Member account unavailable' USING ERRCODE='42501'; END IF;
 INSERT INTO app.user_sessions(token_hash,csrf_secret_hash,user_id,selected_workspace_id,expires_at,ip_hash,user_agent_hash,product_audience)
 VALUES(p_session,p_csrf,p_user,v_workspace,v_expiry,p_source,p_ua,'martin_howard_property') RETURNING id INTO v_id;
 RETURN QUERY SELECT v_id,p_user,v_email,v_workspace,v_expiry;
END $f$;
CREATE FUNCTION app_private.create_mhp_password_session(p_user uuid,p_expected text,p_session bytea,p_csrf bytea,p_source bytea,p_ua bytea)
RETURNS TABLE(session_id uuid,user_id uuid,user_email text,selected_workspace_id uuid,expires_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE v_email text;
BEGIN
 SELECT email::text INTO v_email FROM app.users WHERE id=p_user AND status='active' AND email_verified_at IS NOT NULL AND password_hash=p_expected AND p_expected LIKE 'scrypt$v1$%' FOR UPDATE;
 IF v_email IS NULL OR NOT app_private.mhp_auth_eligible(lower(v_email)) THEN RETURN; END IF;
 RETURN QUERY SELECT * FROM app_private.issue_mhp_session(p_user,p_session,p_csrf,p_source,p_ua);
END $f$;
CREATE FUNCTION app_private.consume_mhp_auth_token(p_token bytea,p_purpose text,p_password text,p_session bytea,p_csrf bytea,p_source bytea,p_ua bytea)
RETURNS TABLE(session_id uuid,user_id uuid,user_email text,selected_workspace_id uuid,expires_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE t app_private.mhp_auth_tokens%ROWTYPE; v_email text; v_user uuid; v_status text;
BEGIN
 IF p_token IS NULL OR octet_length(p_token)<>32 OR p_purpose IS NULL OR p_purpose NOT IN ('magic','reset')
  OR (p_purpose='reset' AND (p_password IS NULL OR p_password NOT LIKE 'scrypt$v1$%' OR length(p_password)>1024))
  OR (p_purpose='magic' AND p_password IS NOT NULL) THEN RETURN; END IF;
 SELECT email INTO v_email FROM app_private.mhp_auth_tokens WHERE token_hash=p_token;
 IF v_email IS NULL THEN RETURN; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(v_email,115));
 SELECT * INTO t FROM app_private.mhp_auth_tokens WHERE token_hash=p_token FOR UPDATE;
 IF t.purpose<>p_purpose OR t.consumed_at IS NOT NULL OR t.revoked_at IS NOT NULL OR t.expires_at<=clock_timestamp() OR NOT app_private.mhp_auth_eligible(t.email) THEN RETURN; END IF;
 SELECT id,status INTO v_user,v_status FROM app.users WHERE lower(email::text)=t.email FOR UPDATE;
 IF v_status IS NOT NULL AND v_status NOT IN ('pending','active') THEN RETURN; END IF;
 IF v_user IS NULL THEN
  INSERT INTO app.users(email,status,email_verified_at,password_hash) VALUES(t.email,'active',clock_timestamp(),p_password)
   ON CONFLICT(email) DO NOTHING RETURNING id INTO v_user;
  IF v_user IS NULL THEN
   SELECT id,status INTO v_user,v_status FROM app.users WHERE lower(email::text)=t.email FOR UPDATE;
   IF v_status NOT IN ('pending','active') THEN RETURN; END IF;
  END IF;
 END IF;
 -- The token is consumed in the same transaction as the sole permitted pending -> active transition.
 UPDATE app_private.mhp_auth_tokens SET consumed_at=clock_timestamp() WHERE token_hash=p_token;
 UPDATE app.users SET status=CASE WHEN status='pending' THEN 'active' ELSE status END,
  email_verified_at=COALESCE(email_verified_at,clock_timestamp()),password_hash=CASE WHEN p_purpose='reset' THEN p_password ELSE password_hash END,
  row_version=row_version+1,updated_at=clock_timestamp() WHERE id=v_user AND status IN ('pending','active');
 IF p_purpose='reset' THEN
  UPDATE app.user_sessions s SET revoked_at=clock_timestamp() WHERE s.user_id=v_user AND s.revoked_at IS NULL;
  UPDATE app.identity_action_tokens a SET revoked_at=clock_timestamp() WHERE a.user_id=v_user AND a.consumed_at IS NULL AND a.revoked_at IS NULL;
  UPDATE app_private.mhp_auth_tokens SET revoked_at=clock_timestamp() WHERE email=t.email AND token_hash<>p_token AND consumed_at IS NULL AND revoked_at IS NULL;
 END IF;
 RETURN QUERY SELECT * FROM app_private.issue_mhp_session(v_user,p_session,p_csrf,p_source,p_ua);
END $f$;
CREATE FUNCTION app_private.resolve_mhp_session(p_token bytea)
RETURNS TABLE(session_id uuid,user_id uuid,user_email text,selected_workspace_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
 SELECT r.session_id,r.user_id,u.email::text,r.selected_workspace_id FROM app_private.resolve_session(p_token) r
 JOIN app.user_sessions s ON s.id=r.session_id AND s.product_audience='martin_howard_property'
 JOIN app.users u ON u.id=r.user_id AND u.status='active' AND u.email_verified_at IS NOT NULL
 JOIN app_private.mhp_members m ON m.workspace_id=r.selected_workspace_id
$f$;
CREATE FUNCTION app_private.revoke_mhp_session(p_token bytea)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $f$
 UPDATE app.user_sessions SET revoked_at=clock_timestamp() WHERE token_hash=p_token AND product_audience='martin_howard_property' AND revoked_at IS NULL
$f$;
SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private FROM r72_mhp_auth_definer;
REVOKE ALL ON FUNCTION app_private.mhp_auth_eligible(text),app_private.request_mhp_auth_token(text,text,bytea,bytea),app_private.mhp_login_credential(text),
 app_private.issue_mhp_session(uuid,bytea,bytea,bytea,bytea),app_private.create_mhp_password_session(uuid,text,bytea,bytea,bytea,bytea),
 app_private.consume_mhp_auth_token(bytea,text,text,bytea,bytea,bytea,bytea),app_private.resolve_mhp_session(bytea),app_private.revoke_mhp_session(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.request_mhp_auth_token(text,text,bytea,bytea),app_private.mhp_login_credential(text),
 app_private.create_mhp_password_session(uuid,text,bytea,bytea,bytea,bytea),app_private.consume_mhp_auth_token(bytea,text,text,bytea,bytea,bytea,bytea),app_private.revoke_mhp_session(bytea) TO r72_identity_command;
GRANT EXECUTE ON FUNCTION app_private.resolve_mhp_session(bytea) TO r72_web,r72_identity_command,r72_mhp_commerce_definer;
