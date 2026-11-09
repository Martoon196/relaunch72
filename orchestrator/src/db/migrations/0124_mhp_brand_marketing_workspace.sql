-- GHQ-WEBINAR-003. Native owner selection of one canonical brand CRM workspace.
-- No customer purchase, member/business row, prospect import or provider effect.
SET LOCAL ROLE r72_owner;

CREATE TABLE app_private.mhp_marketing_workspace_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE RESTRICT
   CHECK(workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b'),
 actor_user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE RESTRICT,
 command_id uuid NOT NULL,
 action text NOT NULL CHECK(action IN('open','return')),
 source_workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE RESTRICT,
 target_workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE RESTRICT,
 -- Historical session IDs are recorded by the command; audit retention must
 -- not prevent the existing session-expiry cleanup from removing old sessions.
 source_session_id uuid NOT NULL,
 target_session_id uuid NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(actor_user_id,command_id), UNIQUE(source_session_id),
 CHECK(source_session_id<>target_session_id),
 CHECK((action='open' AND target_workspace_id=workspace_id)
   OR(action='return' AND source_workspace_id=workspace_id AND target_workspace_id<>workspace_id))
);
ALTER TABLE app_private.mhp_marketing_workspace_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.mhp_marketing_workspace_events FORCE ROW LEVEL SECURITY;
CREATE POLICY mhp_marketing_events_owner ON app_private.mhp_marketing_workspace_events
 TO r72_owner USING(true) WITH CHECK(true);
CREATE POLICY mhp_marketing_events_member ON app_private.mhp_marketing_workspace_events
 TO r72_mhp_member_definer USING(true) WITH CHECK(true);
REVOKE ALL ON app_private.mhp_marketing_workspace_events FROM PUBLIC;
GRANT SELECT,INSERT ON app_private.mhp_marketing_workspace_events TO r72_mhp_member_definer;
INSERT INTO app_private.workspace_table_registry(schema_name,table_name,workspace_column)
 VALUES('app_private','mhp_marketing_workspace_events','workspace_id');

GRANT CREATE ON SCHEMA app_private TO r72_mhp_member_definer,r72_mhp_auth_definer,
 r72_security_definer,r72_investor_programme_definer;
SET LOCAL ROLE r72_owner;

CREATE FUNCTION app_private.mhp_marketing_event_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $f$
BEGIN RAISE EXCEPTION 'Marketing workspace audit is immutable' USING ERRCODE='42501'; END $f$;
REVOKE ALL ON FUNCTION app_private.mhp_marketing_event_immutable() FROM PUBLIC;
RESET ROLE;
SET LOCAL ROLE r72_owner;
CREATE TRIGGER mhp_marketing_event_immutable BEFORE UPDATE OR DELETE
 ON app_private.mhp_marketing_workspace_events FOR EACH ROW
 EXECUTE FUNCTION app_private.mhp_marketing_event_immutable();
SET LOCAL ROLE r72_mhp_member_definer;

CREATE FUNCTION app_private.mhp_marketing_owner(p_user uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
 SELECT app_private.mhp_is_programme_admin(p_user) AND EXISTS(
  SELECT 1 FROM app.organization_memberships om JOIN app.organizations o ON o.id=om.organization_id
  WHERE om.organization_id='ba41b1a4-9752-4dbf-8312-d04a0f03d0b8' AND om.user_id=p_user
   AND om.role='owner' AND om.status='active' AND om.revoked_at IS NULL AND o.status='active')
$f$;

CREATE FUNCTION app_private.mhp_marketing_workspace_allowed(p_user uuid,p_workspace uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
 SELECT p_workspace='2789228d-55a6-4688-b1e8-2f70abca990b'
  AND app_private.mhp_marketing_owner(p_user)
  AND app_private.has_active_workspace_membership(p_user,p_workspace)
  AND EXISTS(SELECT 1 FROM app.workspaces w JOIN app.workspace_memberships wm ON wm.workspace_id=w.id
   WHERE w.id=p_workspace AND w.organization_id='ba41b1a4-9752-4dbf-8312-d04a0f03d0b8'
    AND w.slug::text='mhp-brand-marketing' AND w.status='active'
    AND wm.user_id=p_user AND wm.organization_id=w.organization_id
    AND wm.role='owner' AND wm.status='active' AND wm.revoked_at IS NULL)
$f$;
REVOKE ALL ON FUNCTION app_private.mhp_marketing_owner(uuid),
 app_private.mhp_marketing_workspace_allowed(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.mhp_marketing_workspace_allowed(uuid,uuid) TO r72_mhp_auth_definer;

CREATE FUNCTION app_private.mhp_marketing_workspace_snapshot(p_session bytea) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE actor uuid; selected uuid; personal uuid; brand uuid;
BEGIN
 SELECT r.user_id,r.selected_workspace_id INTO actor,selected FROM app_private.resolve_session(p_session) r
 JOIN app.user_sessions s ON s.id=r.session_id AND s.product_audience='martin_howard_property';
 IF actor IS NULL OR NOT app_private.mhp_marketing_owner(actor)
  OR (selected='2789228d-55a6-4688-b1e8-2f70abca990b'
    AND NOT app_private.mhp_marketing_workspace_allowed(actor,selected))
  OR (selected<>'2789228d-55a6-4688-b1e8-2f70abca990b'
    AND NOT EXISTS(SELECT 1 FROM app_private.mhp_members WHERE workspace_id=selected))
 THEN RAISE EXCEPTION 'MHP marketing owner session required' USING ERRCODE='42501'; END IF;
 SELECT m.workspace_id INTO personal FROM app_private.mhp_members m
 JOIN app.workspace_memberships wm ON wm.workspace_id=m.workspace_id AND wm.user_id=actor
 WHERE m.user_id=actor AND wm.role='owner' AND wm.status='active' AND wm.revoked_at IS NULL
  AND app_private.has_active_workspace_membership(actor,m.workspace_id);
 IF personal IS NULL OR personal='2789228d-55a6-4688-b1e8-2f70abca990b'
 THEN RAISE EXCEPTION 'Personal Desk unavailable' USING ERRCODE='42501'; END IF;
 SELECT w.id INTO brand FROM app.workspaces w
 WHERE w.id='2789228d-55a6-4688-b1e8-2f70abca990b'
  AND w.organization_id='ba41b1a4-9752-4dbf-8312-d04a0f03d0b8'
  AND w.slug::text='mhp-brand-marketing' AND w.status='active';
 RETURN jsonb_build_object('userId',actor,'selectedWorkspaceId',selected,
  'personalWorkspaceId',personal,'marketingWorkspaceId',brand,
  'marketingSelected',selected='2789228d-55a6-4688-b1e8-2f70abca990b');
END $f$;

CREATE FUNCTION app_private.select_mhp_marketing_workspace(
 p_session bytea,p_action text,p_new_session bytea,p_new_csrf bytea,p_command uuid
) RETURNS TABLE(user_id uuid,selected_workspace_id uuid,expires_at timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE s app.user_sessions%ROWTYPE; snapshot jsonb; destination uuid;
 brand CONSTANT uuid:='2789228d-55a6-4688-b1e8-2f70abca990b';
 org CONSTANT uuid:='ba41b1a4-9752-4dbf-8312-d04a0f03d0b8';
 pipeline uuid; new_id uuid; created_workspace boolean:=false;
BEGIN
 IF p_session IS NULL OR octet_length(p_session)<>32 OR p_new_session IS NULL
  OR octet_length(p_new_session)<>32 OR p_new_csrf IS NULL OR octet_length(p_new_csrf)<>32
  OR p_session=p_new_session OR p_command IS NULL OR p_action IS NULL OR p_action NOT IN('open','return')
 THEN RAISE EXCEPTION 'Invalid marketing workspace selection' USING ERRCODE='22023'; END IF;
 -- Serialize the singleton before any session locks so concurrent owner entries
 -- cannot create separate identities or deadlock while taking the same fences.
 PERFORM pg_advisory_xact_lock(hashtextextended('mhp-brand-marketing:ba41b1a4-9752-4dbf-8312-d04a0f03d0b8',124));
 SELECT us.* INTO s FROM app.user_sessions us WHERE us.token_hash=p_session
  AND us.product_audience='martin_howard_property' AND us.revoked_at IS NULL
  AND us.expires_at>clock_timestamp() FOR UPDATE;
 IF NOT FOUND OR NOT app_private.lock_active_portal_session(p_session,s.user_id,s.selected_workspace_id)
 THEN RAISE EXCEPTION 'MHP marketing session unavailable' USING ERRCODE='42501'; END IF;
 snapshot:=app_private.mhp_marketing_workspace_snapshot(p_session);
 IF (snapshot->>'userId')::uuid<>s.user_id OR (snapshot->>'selectedWorkspaceId')::uuid<>s.selected_workspace_id
 THEN RAISE EXCEPTION 'MHP marketing session changed' USING ERRCODE='42501'; END IF;
 IF p_action='open' THEN
  INSERT INTO app.workspaces(id,organization_id,name,slug)
   VALUES(brand,org,'Martin Howard Property · Marketing','mhp-brand-marketing')
   ON CONFLICT DO NOTHING;
  created_workspace:=FOUND;
  IF NOT EXISTS(SELECT 1 FROM app.workspaces WHERE id=brand AND organization_id=org
    AND slug::text='mhp-brand-marketing' AND status='active')
  THEN RAISE EXCEPTION 'Canonical marketing workspace conflict' USING ERRCODE='42501'; END IF;
  INSERT INTO app.workspace_memberships(workspace_id,organization_id,user_id,role,status,granted_by_user_id)
   VALUES(brand,org,s.user_id,'owner','active',s.user_id) ON CONFLICT DO NOTHING;
  IF NOT app_private.mhp_marketing_workspace_allowed(s.user_id,brand)
  THEN RAISE EXCEPTION 'Marketing workspace ownership unavailable' USING ERRCODE='42501'; END IF;
  IF created_workspace THEN
   INSERT INTO app.pipelines(workspace_id,name,slug,is_default)
    VALUES(brand,'Enquiries and follow-ups','enquiries',true) RETURNING id INTO pipeline;
   INSERT INTO app.pipeline_stages(workspace_id,pipeline_id,name,slug,position,stage_type,is_terminal)
    SELECT brand,pipeline,label,slug,position,kind,kind IN('won','lost') FROM(VALUES
     ('New enquiry','new',10,'open'),('Contacted','contacted',20,'open'),('Call booked','call-booked',30,'open'),
     ('Qualified','qualified',40,'open'),('Opportunity shared','opportunity-shared',50,'open'),
     ('Follow-up','follow-up',60,'open'),('Completed','completed',70,'won'),
     ('Not proceeding','not-proceeding',80,'lost')) stages(label,slug,position,kind);
  END IF;
  IF NOT EXISTS(SELECT 1 FROM app.pipelines WHERE workspace_id=brand AND slug::text='enquiries'
    AND status='active' AND is_default)
  THEN RAISE EXCEPTION 'Marketing pipeline unavailable' USING ERRCODE='42501'; END IF;
  destination:=brand;
 ELSE
  IF s.selected_workspace_id<>brand THEN RAISE EXCEPTION 'Marketing workspace is not selected' USING ERRCODE='42501'; END IF;
  destination:=(snapshot->>'personalWorkspaceId')::uuid;
 END IF;
 INSERT INTO app.user_sessions(token_hash,csrf_secret_hash,user_id,selected_workspace_id,expires_at,ip_hash,user_agent_hash,product_audience)
  VALUES(p_new_session,p_new_csrf,s.user_id,destination,s.expires_at,s.ip_hash,s.user_agent_hash,s.product_audience)
  RETURNING id INTO new_id;
 UPDATE app.user_sessions SET revoked_at=clock_timestamp() WHERE id=s.id;
 INSERT INTO app_private.mhp_marketing_workspace_events(workspace_id,actor_user_id,command_id,action,
   source_workspace_id,target_workspace_id,source_session_id,target_session_id)
  VALUES(brand,s.user_id,p_command,p_action,s.selected_workspace_id,destination,s.id,new_id);
 RETURN QUERY SELECT s.user_id,destination,s.expires_at;
END $f$;
REVOKE ALL ON FUNCTION app_private.mhp_marketing_workspace_snapshot(bytea),
 app_private.select_mhp_marketing_workspace(bytea,text,bytea,bytea,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.mhp_marketing_workspace_snapshot(bytea) TO r72_web;
GRANT EXECUTE ON FUNCTION app_private.select_mhp_marketing_workspace(bytea,text,bytea,bytea,uuid) TO r72_identity_command;

-- Native-resolution and exact existing-function deltas follow below. Their
-- signatures and normal member/default branches are preserved.

CREATE OR REPLACE FUNCTION app_private.mhp_workspace_access(p_user uuid,p_workspace uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE m app_private.mhp_members%ROWTYPE; a jsonb; b app.investor_businesses%ROWTYPE;
BEGIN
 IF p_workspace='2789228d-55a6-4688-b1e8-2f70abca990b' THEN
  RETURN jsonb_build_object('crm',app_private.mhp_marketing_workspace_allowed(p_user,p_workspace),
   'enquirySite',false,'emailWorkflow',false,'emailWritable',false,'leadrelay',false,'calculators',false,
   'dealFileLimit',0,'deskWriteEndsAt',NULL,'readOnly',NOT app_private.mhp_marketing_workspace_allowed(p_user,p_workspace),
   'endsAt',NULL,'marketingWorkspace',true);
 END IF;
 SELECT * INTO m FROM app_private.mhp_members WHERE workspace_id=p_workspace;
 IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT * INTO b FROM app.investor_businesses WHERE workspace_id=p_workspace;
 a:=jsonb_build_object('crm',false,'enquirySite',false,'emailWorkflow',false,'emailWritable',false,'leadrelay',false,'calculators',false,'dealFileLimit',3,'deskWriteEndsAt',NULL,'readOnly',false,'endsAt',NULL);
 IF b.access_state='suspended' THEN RETURN a; END IF;
 IF app_private.mhp_is_programme_admin(m.user_id) THEN
  RETURN jsonb_build_object('crm',true,'enquirySite',true,'emailWorkflow',true,'emailWritable',true,'leadrelay',true,'calculators',true,'dealFileLimit',NULL,'deskWriteEndsAt',NULL,'readOnly',false,'endsAt',NULL);
 END IF;
 IF m.user_id IS NOT NULL THEN a:=app_private.mhp_account_access(m.user_id); END IF;
 IF app_private.mhp_is_programme_admin(p_user) AND b.workspace_id IS NOT NULL AND (b.access_state='pending_payment' OR (m.user_id IS NULL AND m.manual_active AND b.access_state='active')) THEN
  a:=a||jsonb_build_object('crm',true,'enquirySite',false,'readOnly',false);
 END IF;
 RETURN a;
END $f$;

CREATE OR REPLACE FUNCTION app_private.mhp_member_snapshot(p_session bytea) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE actor uuid; ws uuid; a jsonb;
BEGIN
 SELECT s.user_id,s.selected_workspace_id INTO actor,ws FROM app_private.resolve_session(p_session) s
 JOIN app.user_sessions us ON us.id=s.session_id WHERE us.product_audience='martin_howard_property';
 IF actor IS NULL OR (NOT EXISTS(SELECT 1 FROM app_private.mhp_members WHERE workspace_id=ws)
  AND NOT app_private.mhp_marketing_workspace_allowed(actor,ws)) THEN RAISE EXCEPTION 'MHP session required' USING ERRCODE='42501'; END IF;
 a:=app_private.mhp_workspace_access(actor,ws);
 RETURN a||jsonb_build_object('userId',actor,'workspaceId',ws,'isAdmin',app_private.mhp_is_programme_admin(actor));
END $f$;

CREATE OR REPLACE FUNCTION app_private.mhp_is_owner(p_session bytea) RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
 SELECT EXISTS(SELECT 1 FROM app_private.resolve_session(p_session) r
 JOIN app.user_sessions s ON s.id=r.session_id AND s.product_audience='martin_howard_property'
 JOIN app.users u ON u.id=r.user_id AND u.status='active' AND u.email_verified_at IS NOT NULL
 JOIN app.organization_memberships om ON om.user_id=u.id AND om.organization_id='ba41b1a4-9752-4dbf-8312-d04a0f03d0b8' AND om.role='owner' AND om.status='active' AND om.revoked_at IS NULL
 LEFT JOIN app_private.mhp_members m ON m.workspace_id=r.selected_workspace_id
 WHERE m.workspace_id IS NOT NULL OR app_private.mhp_marketing_workspace_allowed(r.user_id,r.selected_workspace_id))
$f$;

SET LOCAL ROLE r72_mhp_auth_definer;

CREATE OR REPLACE FUNCTION app_private.resolve_mhp_session(p_token bytea)
RETURNS TABLE(session_id uuid,user_id uuid,user_email text,selected_workspace_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
 SELECT r.session_id,r.user_id,u.email::text,r.selected_workspace_id FROM app_private.resolve_session(p_token) r
 JOIN app.user_sessions s ON s.id=r.session_id AND s.product_audience='martin_howard_property'
 JOIN app.users u ON u.id=r.user_id AND u.status='active' AND u.email_verified_at IS NOT NULL
 LEFT JOIN app_private.mhp_members m ON m.workspace_id=r.selected_workspace_id
 WHERE m.workspace_id IS NOT NULL OR app_private.mhp_marketing_workspace_allowed(r.user_id,r.selected_workspace_id)
$f$;

SET LOCAL ROLE r72_security_definer;

CREATE OR REPLACE FUNCTION app_private.portal_login_credential(p_email text)
RETURNS TABLE(user_id uuid,user_email text,password_hash text,selected_workspace_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
 SELECT person.id,person.email::text,person.password_hash,membership.workspace_id
 FROM app.users person JOIN LATERAL (
  SELECT candidate.workspace_id FROM app.workspace_memberships candidate
  WHERE candidate.user_id=person.id AND candidate.status='active'
   AND candidate.workspace_id<>'2789228d-55a6-4688-b1e8-2f70abca990b'
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
 WHERE resolved.selected_workspace_id<>'2789228d-55a6-4688-b1e8-2f70abca990b'
 AND NOT EXISTS(SELECT 1 FROM app_private.mhp_members mhp WHERE mhp.workspace_id=resolved.selected_workspace_id)
$f$;

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
    AND membership.workspace_id <> '2789228d-55a6-4688-b1e8-2f70abca990b'
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

SET LOCAL ROLE r72_investor_programme_definer;

CREATE OR REPLACE FUNCTION app_private.switch_investor_workspace(p_session bytea,p_workspace uuid,p_new_session bytea,p_new_csrf bytea) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE s app.user_sessions%ROWTYPE; a jsonb;
BEGIN
 SELECT * INTO s FROM app.user_sessions WHERE token_hash=p_session AND revoked_at IS NULL AND expires_at>clock_timestamp() FOR UPDATE;
 IF NOT FOUND OR p_workspace='2789228d-55a6-4688-b1e8-2f70abca990b' OR s.selected_workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b'
 OR NOT app_private.has_active_workspace_membership(s.user_id,s.selected_workspace_id) OR NOT app_private.has_active_workspace_membership(s.user_id,p_workspace) THEN RAISE EXCEPTION 'Workspace unavailable' USING ERRCODE='42501'; END IF;
 a:=app_private.mhp_workspace_access(s.user_id,p_workspace);
 IF (s.product_audience='martin_howard_property')<>(a IS NOT NULL) THEN RAISE EXCEPTION 'Cross-brand workspace unavailable' USING ERRCODE='42501'; END IF;
 IF p_new_session IS NULL OR octet_length(p_new_session)<>32 OR p_new_csrf IS NULL OR octet_length(p_new_csrf)<>32 THEN RAISE EXCEPTION 'Invalid session' USING ERRCODE='22023'; END IF;
 INSERT INTO app.user_sessions(token_hash,csrf_secret_hash,user_id,selected_workspace_id,expires_at,ip_hash,user_agent_hash,product_audience)
 VALUES(p_new_session,p_new_csrf,s.user_id,p_workspace,s.expires_at,s.ip_hash,s.user_agent_hash,s.product_audience);
 UPDATE app.user_sessions SET revoked_at=clock_timestamp() WHERE id=s.id;
END $f$;

RESET ROLE;
SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private FROM r72_mhp_member_definer,r72_mhp_auth_definer,
 r72_security_definer,r72_investor_programme_definer;
