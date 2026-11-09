-- MHP-DESK-001: reuse Investor Desk with verified membership and live entitlement checks.
SET LOCAL ROLE r72_owner;
GRANT CREATE ON SCHEMA app_private TO r72_mhp_member_definer,r72_security_definer,r72_investor_programme_definer,r72_investor_email_definer;
GRANT EXECUTE ON FUNCTION app_private.resolve_session(bytea),app_private.lock_active_portal_session(bytea,uuid,uuid),app_private.has_active_workspace_membership(uuid,uuid),app_private.mhp_account_access(uuid),app_private.mhp_has_purchase_email(text),app_private.mhp_set_manual_access(uuid,boolean,text,text),app_private.create_investor_business(bytea,uuid,bytea,text,text,text,boolean) TO r72_mhp_member_definer;
GRANT UPDATE(revoked_at) ON app.workspace_memberships TO r72_mhp_member_definer;
SET LOCAL ROLE r72_mhp_member_definer;

CREATE FUNCTION app_private.mhp_domain_ready() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
 SELECT EXISTS(SELECT 1 FROM app.organization_domains WHERE organization_id='ba41b1a4-9752-4dbf-8312-d04a0f03d0b8'
 AND hostname::text='app.martinhowardproperty.co.uk' AND purpose='portal' AND status='verified' AND verified_at IS NOT NULL)
$f$;

CREATE FUNCTION app_private.mhp_is_programme_admin(p_user uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
 SELECT EXISTS(SELECT 1 FROM app.users u JOIN app_private.investor_programme_admins a ON a.user_id=u.id
 WHERE u.id=p_user AND u.status='active' AND u.email_verified_at IS NOT NULL
 AND lower(u.email::text) IN('office@propertypredator.com','martin.howard1984@gmail.com'))
$f$;

CREATE FUNCTION app_private.mhp_workspace_access(p_user uuid,p_workspace uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE m app_private.mhp_members%ROWTYPE; a jsonb; b app.investor_businesses%ROWTYPE;
BEGIN
 SELECT * INTO m FROM app_private.mhp_members WHERE workspace_id=p_workspace;
 IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT * INTO b FROM app.investor_businesses WHERE workspace_id=p_workspace;
 a:=jsonb_build_object('crm',false,'enquirySite',false,'emailWorkflow',false,'emailWritable',false,'leadrelay',false,'readOnly',false,'endsAt',NULL);
 IF b.access_state='suspended' THEN RETURN a; END IF;
 IF app_private.mhp_is_programme_admin(m.user_id) THEN
  RETURN jsonb_build_object('crm',true,'enquirySite',true,'emailWorkflow',true,'emailWritable',true,'leadrelay',true,'readOnly',false,'endsAt',NULL);
 END IF;
 IF m.user_id IS NOT NULL THEN a:=app_private.mhp_account_access(m.user_id); END IF;
 -- Pending businesses are visible to the verified programme administrator for
 -- setup, but a pending owner gets no Desk and no mail or automation.
 IF app_private.mhp_is_programme_admin(p_user) AND b.workspace_id IS NOT NULL AND (b.access_state='pending_payment' OR (m.user_id IS NULL AND m.manual_active AND b.access_state='active')) THEN
  a:=a||jsonb_build_object('crm',true,'enquirySite',false,'readOnly',false);
 END IF;
 RETURN a;
END $f$;

CREATE FUNCTION app_private.mhp_workspace_write_allowed(p_user uuid,p_workspace uuid) RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
 SELECT a IS NULL OR (COALESCE((a->>'crm')::boolean,false) AND NOT COALESCE((a->>'readOnly')::boolean,true))
 FROM(SELECT app_private.mhp_workspace_access(p_user,p_workspace) AS a) q
$f$;

CREATE FUNCTION app_private.mhp_add_business(p_workspace uuid,p_admin uuid,p_owner uuid,p_email text,p_name text,p_brand text,p_state text,p_key uuid,p_hash bytea,p_reference text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE pipeline uuid;
BEGIN
 INSERT INTO app.investor_businesses(workspace_id,administrator_user_id,owner_user_id,owner_email,owner_name,brand_name,accent_color,access_state,payment_reference,creation_key,creation_hash)
 VALUES(p_workspace,p_admin,p_owner,p_email,p_name,p_brand,'#E8A33D',p_state,p_reference,p_key,p_hash);
 INSERT INTO app.pipelines(workspace_id,name,slug,is_default) VALUES(p_workspace,'Investor relationships','investors',true) RETURNING id INTO pipeline;
 INSERT INTO app.pipeline_stages(workspace_id,pipeline_id,name,slug,position,stage_type,is_terminal)
 SELECT p_workspace,pipeline,label,slug,position,kind,kind IN('won','lost') FROM(VALUES
 ('New enquiry','new',10,'open'),('Contacted','contacted',20,'open'),('Call booked','call-booked',30,'open'),
 ('Qualified','qualified',40,'open'),('Opportunity shared','opportunity-shared',50,'open'),('Follow-up','follow-up',60,'open'),
 ('Completed','completed',70,'won'),('Not proceeding','not-proceeding',80,'lost')) stages(label,slug,position,kind);
END $f$;

CREATE FUNCTION app_private.ensure_mhp_member_workspace(p_user uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE person app.users%ROWTYPE; m app_private.mhp_members%ROWTYPE; ws uuid; org uuid; founder boolean; a jsonb; admin_id uuid; label text;
BEGIN
 SELECT * INTO person FROM app.users WHERE id=p_user AND status='active' AND email_verified_at IS NOT NULL;
 IF NOT FOUND THEN RAISE EXCEPTION 'Verified MHP identity required' USING ERRCODE='42501'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(lower(person.email::text),113));
 founder:=lower(person.email::text) IN('office@propertypredator.com','martin.howard1984@gmail.com');
 IF founder THEN INSERT INTO app_private.investor_programme_admins(user_id) VALUES(p_user) ON CONFLICT DO NOTHING; END IF;
 SELECT * INTO m FROM app_private.mhp_members WHERE owner_email=person.email FOR UPDATE;
 IF m.user_id IS NOT NULL AND m.user_id<>p_user THEN RAISE EXCEPTION 'MHP identity binding conflict' USING ERRCODE='42501'; END IF;
 IF NOT founder AND NOT app_private.mhp_has_purchase_email(lower(person.email::text)) AND NOT COALESCE(m.manual_active,false) THEN
  RAISE EXCEPTION 'MHP membership unavailable' USING ERRCODE='42501'; END IF;
 IF m.workspace_id IS NULL THEN
  org:=gen_random_uuid(); ws:=gen_random_uuid(); label:=left(COALESCE(NULLIF(person.display_name,''),split_part(person.email::text,'@',1))||' · Your Desk',100);
  INSERT INTO app.organizations(id,name,slug,kind) VALUES(org,label,'mhp-'||org::text,'direct_customer');
  INSERT INTO app.workspaces(id,organization_id,name,slug) VALUES(ws,org,label,'mhp-'||ws::text);
  INSERT INTO app_private.mhp_members(workspace_id,user_id,owner_email) VALUES(ws,p_user,lower(person.email::text));
 ELSE
  ws:=m.workspace_id;
  SELECT organization_id INTO org FROM app.workspaces WHERE id=ws;
  UPDATE app_private.mhp_members SET user_id=p_user WHERE workspace_id=ws;
 END IF;
 INSERT INTO app.organization_memberships(organization_id,user_id,role,status) VALUES(org,p_user,'owner','active') ON CONFLICT DO NOTHING;
 INSERT INTO app.workspace_memberships(workspace_id,organization_id,user_id,role,status) VALUES(ws,org,p_user,'owner','active') ON CONFLICT DO NOTHING;
 -- Both verified founder identities get oversight of MHP workspaces only.
 INSERT INTO app.organization_memberships(organization_id,user_id,role,status)
 SELECT org,u.id,'admin','active' FROM app.users u WHERE app_private.mhp_is_programme_admin(u.id) ON CONFLICT DO NOTHING;
 INSERT INTO app.workspace_memberships(workspace_id,organization_id,user_id,role,status)
 SELECT ws,org,u.id,'admin','active' FROM app.users u WHERE app_private.mhp_is_programme_admin(u.id) ON CONFLICT DO NOTHING;
 IF founder THEN
  INSERT INTO app.organization_memberships(organization_id,user_id,role,status)
  SELECT w.organization_id,p_user,'admin','active' FROM app_private.mhp_members mm JOIN app.workspaces w ON w.id=mm.workspace_id ON CONFLICT DO NOTHING;
  INSERT INTO app.workspace_memberships(workspace_id,organization_id,user_id,role,status)
  SELECT w.id,w.organization_id,p_user,'admin','active' FROM app_private.mhp_members mm JOIN app.workspaces w ON w.id=mm.workspace_id ON CONFLICT DO NOTHING;
 END IF;
 IF m.manual_active THEN PERFORM app_private.mhp_set_manual_access(p_user,true,m.manual_tier,m.manual_reference); END IF;
 UPDATE app.investor_businesses SET owner_user_id=p_user,row_version=row_version+1 WHERE workspace_id=ws AND owner_user_id IS DISTINCT FROM p_user;
 a:=app_private.mhp_account_access(p_user);
 IF (founder OR COALESCE((a->>'crm')::boolean,false)) AND NOT EXISTS(SELECT 1 FROM app.investor_businesses WHERE workspace_id=ws) THEN
  SELECT u.id INTO admin_id FROM app.users u WHERE app_private.mhp_is_programme_admin(u.id) ORDER BY CASE WHEN lower(u.email::text)='martin.howard1984@gmail.com' THEN 0 ELSE 1 END,u.id LIMIT 1;
  -- Ownership remains the verified member even before the mentor first signs in.
  admin_id:=COALESCE(admin_id,p_user);
  SELECT name INTO label FROM app.workspaces WHERE id=ws;
  PERFORM app_private.mhp_add_business(ws,admin_id,p_user,lower(person.email::text),COALESCE(person.display_name,split_part(person.email::text,'@',1)),label,
    CASE WHEN founder THEN 'test' ELSE 'active' END,gen_random_uuid(),decode(repeat('00',32),'hex'),CASE WHEN founder THEN NULL ELSE 'mhp-entitlement' END);
 END IF;
 RETURN ws;
END $f$;

CREATE FUNCTION app_private.mhp_member_snapshot(p_session bytea) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE actor uuid; ws uuid; a jsonb;
BEGIN
 SELECT s.user_id,s.selected_workspace_id INTO actor,ws FROM app_private.resolve_session(p_session) s
 JOIN app.user_sessions us ON us.id=s.session_id WHERE us.product_audience='martin_howard_property';
 IF actor IS NULL OR NOT EXISTS(SELECT 1 FROM app_private.mhp_members WHERE workspace_id=ws) THEN RAISE EXCEPTION 'MHP session required' USING ERRCODE='42501'; END IF;
 a:=app_private.mhp_workspace_access(actor,ws);
 RETURN a||jsonb_build_object('userId',actor,'workspaceId',ws,'isAdmin',app_private.mhp_is_programme_admin(actor));
END $f$;

CREATE FUNCTION app_private.mhp_programme_snapshot(p_session bytea) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE a jsonb; actor uuid; selected uuid; admin boolean;
BEGIN
 a:=app_private.mhp_member_snapshot(p_session); actor:=(a->>'userId')::uuid; selected:=(a->>'workspaceId')::uuid; admin:=(a->>'isAdmin')::boolean;
 RETURN jsonb_build_object('isAdmin',admin,'selectedWorkspaceId',selected,
 'workspaces',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',w.id,'name',w.name,'role',wm.role) ORDER BY w.name)
 FROM app.workspace_memberships wm JOIN app.workspaces w ON w.id=wm.workspace_id JOIN app_private.mhp_members mm ON mm.workspace_id=w.id
 WHERE wm.user_id=actor AND app_private.has_active_workspace_membership(actor,w.id)),'[]'::jsonb),
 'businesses',COALESCE((SELECT jsonb_agg(jsonb_build_object('workspaceId',b.workspace_id,'ownerName',b.owner_name,'ownerEmail',b.owner_email,'brandName',b.brand_name,
 'accentColor',b.accent_color,'signature',b.email_signature,'senderEmail',b.sender_email,'accessState',b.access_state,'version',b.row_version,'paymentReference',b.payment_reference,
 'productProfileId','martin_howard_property','features',app_private.mhp_workspace_access(actor,b.workspace_id)) ORDER BY b.created_at)
 FROM app.investor_businesses b JOIN app_private.mhp_members mm ON mm.workspace_id=b.workspace_id WHERE (admin OR b.workspace_id=selected)
 AND app_private.has_active_workspace_membership(actor,b.workspace_id)),'[]'::jsonb));
END $f$;

CREATE FUNCTION app_private.create_mhp_investor_business(p_session bytea,p_key uuid,p_hash bytea,p_brand text,p_name text,p_email text,p_test boolean) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE a jsonb; actor uuid; ws uuid; m app_private.mhp_members%ROWTYPE;
BEGIN
 a:=app_private.mhp_member_snapshot(p_session); actor:=(a->>'userId')::uuid;
 IF NOT(a->>'isAdmin')::boolean OR NOT app_private.lock_active_portal_session(p_session,actor,(a->>'workspaceId')::uuid) THEN RAISE EXCEPTION 'MHP administration required' USING ERRCODE='42501'; END IF;
 IF p_email IS NULL OR p_email<>lower(btrim(p_email)) OR p_email!~'^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' OR length(p_email)>320
 OR p_key IS NULL OR p_hash IS NULL OR octet_length(p_hash)<>32 OR p_brand IS NULL OR length(btrim(p_brand)) NOT BETWEEN 1 AND 100
 OR p_name IS NULL OR length(btrim(p_name)) NOT BETWEEN 1 AND 200 OR p_test IS NULL THEN RAISE EXCEPTION 'Invalid business' USING ERRCODE='22023'; END IF;
 IF p_test AND NOT EXISTS(SELECT 1 FROM app.users WHERE id=actor AND lower(email::text)=p_email) THEN RAISE EXCEPTION 'Test business must belong to you' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_email,113));
 SELECT * INTO m FROM app_private.mhp_members WHERE owner_email::text=p_email FOR UPDATE;
 IF m.workspace_id IS NOT NULL THEN
  IF NOT EXISTS(SELECT 1 FROM app.investor_businesses WHERE workspace_id=m.workspace_id) THEN
   PERFORM app_private.mhp_add_business(m.workspace_id,actor,m.user_id,p_email,p_name,p_brand,'pending_payment',p_key,p_hash,NULL);
  END IF;
  RETURN m.workspace_id;
 END IF;
 ws:=app_private.create_investor_business(p_session,p_key,p_hash,p_brand,p_name,p_email,p_test);
 INSERT INTO app_private.mhp_members(workspace_id,user_id,owner_email) VALUES(ws,CASE WHEN p_test THEN actor ELSE NULL END,p_email);
 RETURN ws;
END $f$;

CREATE FUNCTION app_private.set_mhp_investor_access(p_session bytea,p_workspace uuid,p_version bigint,p_state text,p_reference text,p_tier text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE a jsonb; actor uuid; m app_private.mhp_members%ROWTYPE; b app.investor_businesses%ROWTYPE;
BEGIN
 a:=app_private.mhp_member_snapshot(p_session); actor:=(a->>'userId')::uuid;
 IF NOT(a->>'isAdmin')::boolean OR NOT app_private.lock_active_portal_session(p_session,actor,(a->>'workspaceId')::uuid) THEN RAISE EXCEPTION 'MHP administration required' USING ERRCODE='42501'; END IF;
 SELECT * INTO m FROM app_private.mhp_members WHERE workspace_id=p_workspace FOR UPDATE;
 SELECT * INTO b FROM app.investor_businesses WHERE workspace_id=p_workspace FOR UPDATE;
 IF m.workspace_id IS NULL OR b.workspace_id IS NULL OR b.access_state='test' THEN RAISE EXCEPTION 'Business unavailable' USING ERRCODE='42501'; END IF;
 IF b.row_version<>p_version THEN RAISE EXCEPTION 'Business changed' USING ERRCODE='40001'; END IF;
 IF p_state IS NULL OR p_state NOT IN('active','suspended') OR p_tier IS NULL OR p_tier NOT IN('course','mentoring','partnership')
 OR (p_state='active' AND (p_reference IS NULL OR length(btrim(p_reference)) NOT BETWEEN 1 AND 200)) THEN RAISE EXCEPTION 'Access confirmation required' USING ERRCODE='22023'; END IF;
 UPDATE app_private.mhp_members SET manual_active=p_state='active',manual_tier=p_tier,manual_reference=CASE WHEN p_state='active' THEN p_reference ELSE manual_reference END WHERE workspace_id=p_workspace;
 IF m.user_id IS NOT NULL THEN PERFORM app_private.mhp_set_manual_access(m.user_id,p_state='active',p_tier,COALESCE(NULLIF(p_reference,''),m.manual_reference)); END IF;
 UPDATE app.investor_businesses SET access_state=p_state,payment_reference=COALESCE(NULLIF(p_reference,''),payment_reference),row_version=row_version+1 WHERE workspace_id=p_workspace;
 -- The account remains usable for billing/refunds. Every Desk entry and write
 -- consults live access; no generic account-setup/reset token is minted here.
END $f$;

REVOKE ALL ON FUNCTION app_private.mhp_domain_ready(),app_private.mhp_is_programme_admin(uuid),app_private.mhp_workspace_access(uuid,uuid),app_private.mhp_workspace_write_allowed(uuid,uuid),app_private.mhp_add_business(uuid,uuid,uuid,text,text,text,text,uuid,bytea,text),app_private.ensure_mhp_member_workspace(uuid),app_private.mhp_member_snapshot(bytea),app_private.mhp_programme_snapshot(bytea),app_private.create_mhp_investor_business(bytea,uuid,bytea,text,text,text,boolean),app_private.set_mhp_investor_access(bytea,uuid,bigint,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.ensure_mhp_member_workspace(uuid) TO r72_mhp_auth_definer;
GRANT EXECUTE ON FUNCTION app_private.mhp_domain_ready(),app_private.mhp_member_snapshot(bytea),app_private.mhp_programme_snapshot(bytea) TO r72_web;
GRANT EXECUTE ON FUNCTION app_private.mhp_member_snapshot(bytea) TO r72_investor_email_definer;
GRANT EXECUTE ON FUNCTION app_private.mhp_member_snapshot(bytea) TO r72_investor_programme_definer;
GRANT EXECUTE ON FUNCTION app_private.create_mhp_investor_business(bytea,uuid,bytea,text,text,text,boolean),app_private.set_mhp_investor_access(bytea,uuid,bigint,text,text,text) TO r72_identity_command;
GRANT EXECUTE ON FUNCTION app_private.mhp_workspace_write_allowed(uuid,uuid) TO r72_security_definer;
GRANT EXECUTE ON FUNCTION app_private.mhp_workspace_access(uuid,uuid) TO r72_investor_programme_definer;
RESET ROLE;

-- Preserve the canonical role checks and add a narrowly scoped, live MHP
-- entitlement check. Existing non-MHP workspaces follow the original result.
SET LOCAL ROLE r72_security_definer;
CREATE OR REPLACE FUNCTION app_private.can_write_workspace(p_user_id uuid,p_workspace_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
 SELECT app_private.has_active_workspace_membership(p_user_id,p_workspace_id)
 AND EXISTS(SELECT 1 FROM app.workspace_memberships WHERE user_id=p_user_id AND workspace_id=p_workspace_id AND role IN('owner','admin','marketer','sales'))
 AND app_private.mhp_workspace_write_allowed(p_user_id,p_workspace_id)
$f$;
CREATE OR REPLACE FUNCTION app_private.can_manage_workspace(p_user_id uuid,p_workspace_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
 SELECT app_private.has_active_workspace_membership(p_user_id,p_workspace_id)
 AND EXISTS(SELECT 1 FROM app.workspace_memberships WHERE user_id=p_user_id AND workspace_id=p_workspace_id AND role IN('owner','admin'))
 AND app_private.mhp_workspace_write_allowed(p_user_id,p_workspace_id)
$f$;
RESET ROLE;
SET LOCAL ROLE r72_investor_programme_definer;
CREATE OR REPLACE FUNCTION app_private.investor_programme_snapshot(p_session bytea) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE actor uuid; selected uuid; admin boolean;
BEGIN
 SELECT user_id,selected_workspace_id INTO actor,selected FROM app_private.resolve_session(p_session);
 IF actor IS NULL OR EXISTS(SELECT 1 FROM app.user_sessions WHERE token_hash=p_session AND product_audience='martin_howard_property') THEN RAISE EXCEPTION 'Investor session unavailable' USING ERRCODE='42501'; END IF;
 admin:=EXISTS(SELECT 1 FROM app_private.investor_programme_admins WHERE user_id=actor);
 RETURN jsonb_build_object('isAdmin',admin,'selectedWorkspaceId',selected,
 'workspaces',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',w.id,'name',w.name,'role',m.role) ORDER BY w.name)
 FROM app.workspace_memberships m JOIN app.workspaces w ON w.id=m.workspace_id WHERE m.user_id=actor AND app_private.has_active_workspace_membership(actor,w.id)
 AND app_private.mhp_workspace_access(actor,w.id) IS NULL),'[]'::jsonb),
 'businesses',COALESCE((SELECT jsonb_agg(jsonb_build_object('workspaceId',b.workspace_id,'ownerName',b.owner_name,'ownerEmail',b.owner_email,'brandName',b.brand_name,
 'accentColor',b.accent_color,'signature',b.email_signature,'senderEmail',b.sender_email,'accessState',b.access_state,'version',b.row_version,'paymentReference',b.payment_reference) ORDER BY b.created_at)
 FROM app.investor_businesses b WHERE ((admin AND b.administrator_user_id=actor) OR(b.workspace_id=selected AND app_private.has_active_workspace_membership(actor,b.workspace_id)))
 AND app_private.mhp_workspace_access(actor,b.workspace_id) IS NULL),'[]'::jsonb));
END $f$;

CREATE OR REPLACE FUNCTION app_private.update_investor_business(p_session bytea,p_workspace uuid,p_version bigint,p_brand text,p_color text,p_signature text,p_sender text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE actor uuid; selected uuid; b app.investor_businesses%ROWTYPE; a jsonb; mhp_admin boolean:=false;
BEGIN
 SELECT user_id,selected_workspace_id INTO actor,selected FROM app_private.resolve_session(p_session);
 IF actor IS NULL OR NOT app_private.lock_active_portal_session(p_session,actor,selected) THEN RAISE EXCEPTION 'Session unavailable' USING ERRCODE='42501'; END IF;
 IF EXISTS(SELECT 1 FROM app.user_sessions WHERE token_hash=p_session AND product_audience='martin_howard_property') THEN
  a:=app_private.mhp_member_snapshot(p_session); mhp_admin:=COALESCE((a->>'isAdmin')::boolean,false);
 END IF;
 SELECT * INTO b FROM app.investor_businesses WHERE workspace_id=p_workspace FOR UPDATE;
 IF NOT FOUND OR NOT ((b.administrator_user_id=actor AND EXISTS(SELECT 1 FROM app_private.investor_programme_admins WHERE user_id=actor))
 OR (selected=p_workspace AND app_private.can_manage_workspace(actor,p_workspace))
 OR (mhp_admin AND app_private.has_active_workspace_membership(actor,p_workspace) AND app_private.mhp_workspace_access(actor,p_workspace) IS NOT NULL)) THEN RAISE EXCEPTION 'Business unavailable' USING ERRCODE='42501'; END IF;
 a:=app_private.mhp_workspace_access(actor,p_workspace);
 IF EXISTS(SELECT 1 FROM app.user_sessions WHERE token_hash=p_session AND (product_audience='martin_howard_property')<>(a IS NOT NULL)) THEN RAISE EXCEPTION 'Cross-brand business unavailable' USING ERRCODE='42501'; END IF;
 IF a IS NOT NULL AND (NOT COALESCE((a->>'crm')::boolean,false) OR COALESCE((a->>'readOnly')::boolean,true)) THEN RAISE EXCEPTION 'Business is read-only' USING ERRCODE='42501'; END IF;
 IF b.row_version<>p_version THEN RAISE EXCEPTION 'Business changed' USING ERRCODE='40001'; END IF;
 IF p_sender<>'' AND (p_sender!~'^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' OR p_sender~'[\r\n]') THEN RAISE EXCEPTION 'Invalid sender' USING ERRCODE='22023'; END IF;
 UPDATE app.investor_businesses SET brand_name=p_brand,accent_color=p_color,email_signature=p_signature,sender_email=lower(p_sender),row_version=row_version+1 WHERE workspace_id=p_workspace;
END $f$;

CREATE OR REPLACE FUNCTION app_private.set_investor_access(p_session bytea,p_workspace uuid,p_version bigint,p_state text,p_reference text,p_setup_hash bytea)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE actor uuid; selected uuid; b app.investor_businesses%ROWTYPE; org uuid; target uuid; existing_password text; setup_needed boolean:=false;
BEGIN
 SELECT user_id,selected_workspace_id INTO actor,selected FROM app_private.resolve_session(p_session);
 IF actor IS NULL OR NOT EXISTS(SELECT 1 FROM app_private.investor_programme_admins WHERE user_id=actor)
  OR NOT app_private.lock_active_portal_session(p_session,actor,selected) THEN RAISE EXCEPTION 'Administration required' USING ERRCODE='42501'; END IF;
 IF app_private.mhp_workspace_access(actor,p_workspace) IS NOT NULL THEN RAISE EXCEPTION 'Use MHP membership administration' USING ERRCODE='42501'; END IF;
 SELECT * INTO b FROM app.investor_businesses WHERE workspace_id=p_workspace AND administrator_user_id=actor FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Business unavailable' USING ERRCODE='42501'; END IF;
 IF b.row_version<>p_version THEN RAISE EXCEPTION 'Business changed' USING ERRCODE='40001'; END IF;
 IF b.access_state='test' OR p_state IS NULL OR p_state NOT IN ('active','suspended') THEN RAISE EXCEPTION 'Invalid access change' USING ERRCODE='22023'; END IF;
 SELECT organization_id INTO org FROM app.workspaces WHERE id=p_workspace;
 IF p_state='active' THEN
  IF p_reference IS NULL OR length(btrim(p_reference)) NOT BETWEEN 1 AND 200 OR p_setup_hash IS NULL OR octet_length(p_setup_hash)<>32 THEN
   RAISE EXCEPTION 'Payment confirmation required' USING ERRCODE='22023'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(lower(b.owner_email),107));
  SELECT id,password_hash INTO target,existing_password FROM app.users WHERE email::text=lower(b.owner_email);
  IF target=actor THEN RAISE EXCEPTION 'Use your test business for self access' USING ERRCODE='22023'; END IF;
  IF target IS NULL THEN INSERT INTO app.users(email,display_name) VALUES(b.owner_email,b.owner_name) RETURNING id INTO target; END IF;
  INSERT INTO app.organization_memberships(organization_id,user_id,role,status) VALUES(org,target,'owner','active') ON CONFLICT DO NOTHING;
  INSERT INTO app.workspace_memberships(workspace_id,organization_id,user_id,role,status) VALUES(p_workspace,org,target,'owner','active')
   ON CONFLICT(workspace_id,user_id) DO UPDATE SET status='active',updated_at=clock_timestamp();
  -- Existing accounts keep their password and sign in normally. A setup link is
  -- minted only for a passwordless account, never as an account-reset mechanism.
  IF existing_password IS NULL THEN
   UPDATE app.identity_action_tokens SET revoked_at=clock_timestamp() WHERE user_id=target AND workspace_id=p_workspace AND purpose='account_setup' AND consumed_at IS NULL AND revoked_at IS NULL;
   INSERT INTO app.identity_action_tokens(user_id,workspace_id,purpose,token_hash,expires_at,request_id)
   VALUES(target,p_workspace,'account_setup',p_setup_hash,clock_timestamp()+interval '24 hours','investor-onboarding');
   setup_needed:=true;
  END IF;
 ELSE
  target:=b.owner_user_id;
  UPDATE app.workspace_memberships SET status='suspended',updated_at=clock_timestamp() WHERE workspace_id=p_workspace AND user_id=target AND user_id<>actor;
  UPDATE app.user_sessions SET revoked_at=clock_timestamp() WHERE selected_workspace_id=p_workspace AND user_id=target AND user_id<>actor AND revoked_at IS NULL;
 END IF;
 UPDATE app.investor_businesses SET owner_user_id=target,access_state=p_state,payment_reference=COALESCE(NULLIF(btrim(p_reference),''),payment_reference),row_version=row_version+1 WHERE workspace_id=p_workspace;
 RETURN jsonb_build_object('setupNeeded',setup_needed);
END $f$;

CREATE FUNCTION app_private.public_investor_site_scoped(p_slug text,p_mhp boolean) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
 SELECT jsonb_build_object('slug',s.slug,'headline',s.headline,'introduction',s.introduction,'locations',s.locations,'contactEmail',s.contact_email,
 'privacyUrl',s.privacy_url,'brandName',b.brand_name,'accentColor',b.accent_color)
 FROM app.investor_sites s JOIN app.investor_businesses b USING(workspace_id)
 CROSS JOIN LATERAL(SELECT app_private.mhp_workspace_access(b.owner_user_id,b.workspace_id) AS access) m
 WHERE s.slug=p_slug AND s.published AND b.access_state IN('test','active') AND (m.access IS NOT NULL)=p_mhp
 AND (NOT p_mhp OR (COALESCE((m.access->>'enquirySite')::boolean,false) AND NOT COALESCE((m.access->>'readOnly')::boolean,true)))
$f$;
CREATE OR REPLACE FUNCTION app_private.public_investor_site(p_slug text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
 SELECT app_private.public_investor_site_scoped(p_slug,false)
$f$;
CREATE FUNCTION app_private.public_mhp_investor_site(p_slug text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
 SELECT app_private.public_investor_site_scoped(p_slug,true)
$f$;

CREATE FUNCTION app_private.capture_investor_site_enquiry_scoped(p_slug text,p_nonce bytea,p_name text,p_email text,p_message text,p_mhp boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE ws uuid; cid uuid;
BEGIN
 IF p_nonce IS NULL OR octet_length(p_nonce)<>32 OR p_name IS NULL OR length(btrim(p_name)) NOT BETWEEN 1 AND 200 OR p_email IS NULL OR length(p_email)>254 OR p_email!~'^[^[:space:]<>@]+@[^[:space:]<>@]+\.[^[:space:]<>@]+$'
 OR p_message IS NULL OR length(btrim(p_message)) NOT BETWEEN 1 AND 4000 OR p_mhp IS NULL THEN RAISE EXCEPTION 'Invalid enquiry' USING ERRCODE='22023'; END IF;
 SELECT s.workspace_id INTO ws FROM app.investor_sites s JOIN app.investor_businesses b USING(workspace_id)
 CROSS JOIN LATERAL(SELECT app_private.mhp_workspace_access(b.owner_user_id,b.workspace_id) AS access) m
 WHERE s.slug=p_slug AND s.published AND b.access_state IN('test','active') AND (m.access IS NOT NULL)=p_mhp
 AND (NOT p_mhp OR (COALESCE((m.access->>'enquirySite')::boolean,false) AND NOT COALESCE((m.access->>'readOnly')::boolean,true))) FOR UPDATE OF s;
 IF ws IS NULL THEN RAISE EXCEPTION 'Site unavailable' USING ERRCODE='42501'; END IF;
 IF EXISTS(SELECT 1 FROM app_private.investor_site_submissions WHERE workspace_id=ws AND nonce_hash=p_nonce) THEN RETURN; END IF;
 IF(SELECT count(*) FROM app_private.investor_site_submissions WHERE workspace_id=ws AND submitted_at>clock_timestamp()-interval '1 hour')>=50 THEN RAISE EXCEPTION 'Enquiry limit reached' USING ERRCODE='54000'; END IF;
 INSERT INTO app_private.investor_site_submissions(workspace_id,nonce_hash) VALUES(ws,p_nonce);
 SELECT contact_id INTO cid FROM app.contact_points WHERE workspace_id=ws AND kind='email' AND normalized_value=lower(p_email) AND deleted_at IS NULL AND dedupe_state='normal';
 IF cid IS NULL THEN
  INSERT INTO app.contacts(workspace_id,display_name,source) VALUES(ws,p_name,'investor_site') RETURNING id INTO cid;
  INSERT INTO app.contact_points(workspace_id,contact_id,kind,value,normalized_value,is_primary) VALUES(ws,cid,'email',lower(p_email),lower(p_email),true);
 END IF;
 INSERT INTO app.activities(workspace_id,contact_id,activity_type,channel,actor_kind,subject,body,metadata,request_id,occurred_at)
 VALUES(ws,cid,'investor.site.enquiry','crm','system','New investor website enquiry',p_message,jsonb_build_object('site',p_slug,'nameAsSubmitted',p_name),'investor-site:'||encode(p_nonce,'hex'),statement_timestamp());
END $f$;
CREATE OR REPLACE FUNCTION app_private.capture_investor_site_enquiry(p_slug text,p_nonce bytea,p_name text,p_email text,p_message text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $f$
 SELECT app_private.capture_investor_site_enquiry_scoped(p_slug,p_nonce,p_name,p_email,p_message,false)
$f$;
CREATE FUNCTION app_private.capture_mhp_investor_site_enquiry(p_slug text,p_nonce bytea,p_name text,p_email text,p_message text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $f$
 SELECT app_private.capture_investor_site_enquiry_scoped(p_slug,p_nonce,p_name,p_email,p_message,true)
$f$;
REVOKE ALL ON FUNCTION app_private.public_investor_site_scoped(text,boolean),app_private.public_mhp_investor_site(text),app_private.capture_investor_site_enquiry_scoped(text,bytea,text,text,text,boolean),app_private.capture_mhp_investor_site_enquiry(text,bytea,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.public_mhp_investor_site(text) TO r72_web;
GRANT EXECUTE ON FUNCTION app_private.capture_mhp_investor_site_enquiry(text,bytea,text,text,text) TO r72_identity_command;

CREATE OR REPLACE FUNCTION app_private.investor_mail_workspace(p_session bytea,p_manage boolean) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE actor uuid; ws uuid; a jsonb;
BEGIN
 SELECT user_id,selected_workspace_id INTO actor,ws FROM app_private.resolve_session(p_session);
 IF actor IS NULL OR NOT app_private.lock_active_portal_session(p_session,actor,ws) OR (p_manage AND NOT app_private.can_manage_workspace(actor,ws))
 OR NOT EXISTS(SELECT 1 FROM app.investor_businesses WHERE workspace_id=ws AND access_state IN('test','active')) THEN RAISE EXCEPTION 'Mailbox access denied' USING ERRCODE='42501'; END IF;
 a:=app_private.mhp_workspace_access(actor,ws);
 IF a IS NOT NULL AND (NOT COALESCE((a->>'emailWorkflow')::boolean,false) OR (p_manage AND (NOT COALESCE((a->>'emailWritable')::boolean,false) OR COALESCE((a->>'readOnly')::boolean,true)))) THEN RAISE EXCEPTION 'Email membership required' USING ERRCODE='42501'; END IF;
 RETURN ws;
END $f$;
CREATE OR REPLACE FUNCTION app_private.switch_investor_workspace(p_session bytea,p_workspace uuid,p_new_session bytea,p_new_csrf bytea) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE s app.user_sessions%ROWTYPE; a jsonb;
BEGIN
 SELECT * INTO s FROM app.user_sessions WHERE token_hash=p_session AND revoked_at IS NULL AND expires_at>clock_timestamp() FOR UPDATE;
 IF NOT FOUND OR NOT app_private.has_active_workspace_membership(s.user_id,s.selected_workspace_id) OR NOT app_private.has_active_workspace_membership(s.user_id,p_workspace) THEN RAISE EXCEPTION 'Workspace unavailable' USING ERRCODE='42501'; END IF;
 a:=app_private.mhp_workspace_access(s.user_id,p_workspace);
 IF (s.product_audience='martin_howard_property')<>(a IS NOT NULL) THEN RAISE EXCEPTION 'Cross-brand workspace unavailable' USING ERRCODE='42501'; END IF;
 IF p_new_session IS NULL OR octet_length(p_new_session)<>32 OR p_new_csrf IS NULL OR octet_length(p_new_csrf)<>32 THEN RAISE EXCEPTION 'Invalid session' USING ERRCODE='22023'; END IF;
 INSERT INTO app.user_sessions(token_hash,csrf_secret_hash,user_id,selected_workspace_id,expires_at,ip_hash,user_agent_hash,product_audience)
 VALUES(p_new_session,p_new_csrf,s.user_id,p_workspace,s.expires_at,s.ip_hash,s.user_agent_hash,s.product_audience);
 UPDATE app.user_sessions SET revoked_at=clock_timestamp() WHERE id=s.id;
END $f$;
RESET ROLE;
SET LOCAL ROLE r72_investor_email_definer;
CREATE OR REPLACE FUNCTION app_private.investor_email_snapshot(p_session bytea,p_message uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE ws uuid;selected jsonb;eligible boolean:=false; mhp_access jsonb;
BEGIN
 BEGIN mhp_access:=app_private.mhp_member_snapshot(p_session); EXCEPTION WHEN insufficient_privilege THEN mhp_access:=NULL; END;
 ws:=app_private.investor_mail_workspace(p_session,NOT COALESCE((mhp_access->>'crm')::boolean AND (mhp_access->>'emailWorkflow')::boolean AND NOT (mhp_access->>'emailWritable')::boolean,false));
 SELECT jsonb_build_object('id',m.id,'version',m.row_version,'bodyHash',encode(m.current_body_sha256,'hex'),'reviewHash',encode(x.request_hash,'hex'),
 'subject',x.subject,'text',v.body_text,'to',x.recipient,'from',x.mailbox_address,'contactName',c.display_name,'contactPointId',m.contact_point_id,'lifecycle',m.lifecycle,'state',CASE WHEN d.status='sending' AND op.state='calling' AND op.lease_expires_at<statement_timestamp() THEN 'reconciliation_required' ELSE COALESCE(d.status,m.lifecycle) END,'direction',m.direction,'internetMessageId',x.internet_message_id)
 INTO selected FROM app.investor_email_messages x JOIN app.messages m ON m.workspace_id=x.workspace_id AND m.id=x.message_id
 JOIN app.message_versions v ON v.workspace_id=m.workspace_id AND v.id=m.current_version_id JOIN app.contacts c ON c.workspace_id=m.workspace_id AND c.id=m.contact_id
 LEFT JOIN app.message_deliveries d ON d.workspace_id=m.workspace_id AND d.message_id=m.id LEFT JOIN app.provider_operations op ON op.workspace_id=d.workspace_id AND op.id=d.provider_operation_id WHERE x.workspace_id=ws AND m.id=p_message;
 IF selected IS NOT NULL THEN
  BEGIN PERFORM app_private.investor_email_permission(ws,(selected->>'contactPointId')::uuid);eligible:=true;EXCEPTION WHEN insufficient_privilege THEN eligible:=false;END;
  selected:=selected||jsonb_build_object('permissionRecorded',eligible);
 END IF;
 RETURN jsonb_build_object('selected',selected,'contacts',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',p.id,'name',c.display_name,'address',p.normalized_value,'verified',p.is_verified) ORDER BY c.display_name)
 FROM app.contact_points p JOIN app.contacts c ON c.workspace_id=p.workspace_id AND c.id=p.contact_id WHERE p.workspace_id=ws AND p.kind='email' AND p.deleted_at IS NULL AND p.dedupe_state='normal' AND c.deleted_at IS NULL),'[]'::jsonb),
 'messages',COALESCE((SELECT jsonb_agg(item ORDER BY occurred_at DESC,id DESC) FROM (SELECT m.occurred_at,m.id,jsonb_build_object('id',m.id,'subject',x.subject,'contactName',c.display_name,'to',x.recipient,'direction',m.direction,'state',CASE WHEN d.status='sending' AND op.state='calling' AND op.lease_expires_at<statement_timestamp() THEN 'reconciliation_required' ELSE COALESCE(d.status,m.lifecycle) END,'createdAt',m.occurred_at,'preview',left(v.body_text,140)) item
 FROM app.investor_email_messages x JOIN app.messages m ON m.workspace_id=x.workspace_id AND m.id=x.message_id JOIN app.message_versions v ON v.workspace_id=m.workspace_id AND v.id=m.current_version_id
 JOIN app.contacts c ON c.workspace_id=m.workspace_id AND c.id=m.contact_id LEFT JOIN app.message_deliveries d ON d.workspace_id=m.workspace_id AND d.message_id=m.id LEFT JOIN app.provider_operations op ON op.workspace_id=d.workspace_id AND op.id=d.provider_operation_id WHERE x.workspace_id=ws ORDER BY m.occurred_at DESC,m.id DESC LIMIT 50) recent),'[]'::jsonb));
END $f$;

RESET ROLE;
SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private FROM r72_mhp_member_definer,r72_security_definer,r72_investor_programme_definer,r72_investor_email_definer;
RESET ROLE;
