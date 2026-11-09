-- INV-CRM-001. Founder-managed investor businesses on the canonical CRM.
-- No checkout, billing claim, provider activation or outbound communication.
DO $role$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='r72_investor_programme_definer') THEN CREATE ROLE r72_investor_programme_definer NOLOGIN NOINHERIT; END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='r72_investor_programme_definer' AND (rolcanlogin OR rolinherit OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)) THEN RAISE EXCEPTION 'Unsafe investor definer role'; END IF;
 IF EXISTS(SELECT 1 FROM pg_auth_members m JOIN pg_roles child ON child.oid=m.member WHERE child.rolname='r72_investor_programme_definer') THEN RAISE EXCEPTION 'Investor definer must not inherit another role'; END IF;
 IF EXISTS(SELECT 1 FROM pg_auth_members m JOIN pg_roles parent ON parent.oid=m.roleid JOIN pg_roles child ON child.oid=m.member WHERE parent.rolname='r72_investor_programme_definer' AND child.rolname NOT IN ('r72_owner',current_user)) THEN RAISE EXCEPTION 'Unexpected investor definer member'; END IF;
 GRANT r72_investor_programme_definer TO r72_owner;
 EXECUTE format('GRANT r72_investor_programme_definer TO %I',current_user);
END $role$;
SET LOCAL ROLE r72_owner;
GRANT USAGE ON SCHEMA app,app_private TO r72_investor_programme_definer;
GRANT SELECT,INSERT ON app.organizations,app.users,app.workspaces,app.organization_memberships,app.workspace_memberships,app.user_sessions,app.identity_action_tokens,app.pipelines,app.pipeline_stages TO r72_investor_programme_definer;
GRANT UPDATE(revoked_at) ON app.user_sessions,app.identity_action_tokens TO r72_investor_programme_definer;
GRANT EXECUTE ON FUNCTION app_private.resolve_session(bytea),app_private.lock_active_portal_session(bytea,uuid,uuid),app_private.has_active_workspace_membership(uuid,uuid),app_private.can_manage_workspace(uuid,uuid) TO r72_investor_programme_definer;
DO $policies$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['organizations','users','workspaces','organization_memberships','workspace_memberships','user_sessions','identity_action_tokens','pipelines','pipeline_stages'] LOOP
  EXECUTE format('CREATE POLICY investor_programme_definer ON app.%I TO r72_investor_programme_definer USING (true) WITH CHECK (true)',t);
 END LOOP;
END $policies$;


CREATE TABLE app_private.investor_programme_admins (
  user_id uuid PRIMARY KEY REFERENCES app.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE app_private.investor_programme_admins ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.investor_programme_admins FORCE ROW LEVEL SECURITY;
CREATE POLICY investor_admin_owner ON app_private.investor_programme_admins TO r72_owner USING (true) WITH CHECK (true);
CREATE POLICY investor_admin_definer ON app_private.investor_programme_admins FOR SELECT TO r72_investor_programme_definer USING (true);
REVOKE ALL ON app_private.investor_programme_admins FROM PUBLIC;
GRANT SELECT ON app_private.investor_programme_admins TO r72_investor_programme_definer;
-- The founder explicitly requested programme administration. An empty/new
-- installation has no founder receipt and grants nobody automatic authority.
INSERT INTO app_private.investor_programme_admins(user_id)
SELECT owner_user_id FROM app_private.property_predator_founder_bootstrap_receipts;

CREATE TABLE app.investor_businesses (
  workspace_id uuid PRIMARY KEY REFERENCES app.workspaces(id) ON DELETE CASCADE,
  administrator_user_id uuid NOT NULL REFERENCES app.users(id),
  owner_user_id uuid REFERENCES app.users(id),
  owner_email text NOT NULL CHECK (length(owner_email) BETWEEN 3 AND 320 AND owner_email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'),
  owner_name text NOT NULL CHECK (length(btrim(owner_name)) BETWEEN 1 AND 200),
  brand_name text NOT NULL CHECK (length(btrim(brand_name)) BETWEEN 1 AND 100),
  accent_color text NOT NULL DEFAULT '#315bda' CHECK (accent_color ~ '^#[0-9A-Fa-f]{6}$'),
  email_signature text NOT NULL DEFAULT '' CHECK (length(email_signature) <= 1000),
  sender_email text NOT NULL DEFAULT '' CHECK (length(sender_email) <= 320),
  access_state text NOT NULL CHECK (access_state IN ('test','pending_payment','active','suspended')),
  payment_reference text CHECK (length(payment_reference) BETWEEN 1 AND 200),
  creation_key uuid NOT NULL,
  creation_hash bytea NOT NULL CHECK (octet_length(creation_hash)=32),
  row_version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (administrator_user_id, creation_key),
  CHECK (access_state <> 'active' OR payment_reference IS NOT NULL)
);
ALTER TABLE app.investor_businesses ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.investor_businesses FORCE ROW LEVEL SECURITY;
CREATE POLICY investor_business_owner ON app.investor_businesses TO r72_owner USING (true) WITH CHECK (true);
CREATE POLICY investor_business_definer ON app.investor_businesses TO r72_investor_programme_definer USING (true) WITH CHECK (true);
CREATE POLICY investor_business_read ON app.investor_businesses FOR SELECT TO r72_web USING (
 workspace_id=app_private.current_workspace_id() AND app_private.has_active_workspace_membership(app_private.current_user_id(),workspace_id));
GRANT SELECT, INSERT, UPDATE ON app.investor_businesses TO r72_investor_programme_definer;
GRANT SELECT ON app.investor_businesses TO r72_web;
REVOKE ALL ON app.investor_businesses FROM PUBLIC;
INSERT INTO app_private.workspace_table_registry(schema_name,table_name,workspace_column)
VALUES ('app','investor_businesses','workspace_id');

CREATE TABLE app.investor_requirements (
 workspace_id uuid NOT NULL,
 contact_id uuid NOT NULL,
 capital_notes text NOT NULL DEFAULT '' CHECK (length(capital_notes)<=500),
 locations text NOT NULL DEFAULT '' CHECK (length(locations)<=1000),
 interests text NOT NULL DEFAULT '' CHECK (length(interests)<=1000),
 timeframe text NOT NULL DEFAULT '' CHECK (length(timeframe)<=500),
 notes text NOT NULL DEFAULT '' CHECK (length(notes)<=4000),
 row_version bigint NOT NULL DEFAULT 1,
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY (workspace_id,contact_id),
 FOREIGN KEY (workspace_id,contact_id) REFERENCES app.contacts(workspace_id,id) ON DELETE CASCADE
);
ALTER TABLE app.investor_requirements ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.investor_requirements FORCE ROW LEVEL SECURITY;
CREATE POLICY investor_requirements_owner ON app.investor_requirements TO r72_owner USING (true) WITH CHECK (true);
CREATE POLICY investor_requirements_read ON app.investor_requirements FOR SELECT TO r72_web,r72_crm_command USING (
 workspace_id=app_private.current_workspace_id() AND app_private.has_active_workspace_membership(app_private.current_user_id(),workspace_id));
CREATE POLICY investor_requirements_write ON app.investor_requirements FOR ALL TO r72_crm_command USING (
 workspace_id=app_private.current_workspace_id() AND app_private.can_write_workspace(app_private.current_user_id(),workspace_id)) WITH CHECK (
 workspace_id=app_private.current_workspace_id() AND app_private.can_write_workspace(app_private.current_user_id(),workspace_id));
REVOKE ALL ON app.investor_requirements FROM PUBLIC;
GRANT SELECT ON app.investor_requirements TO r72_web;
GRANT SELECT,INSERT,UPDATE ON app.investor_requirements TO r72_crm_command;
INSERT INTO app_private.workspace_table_registry(schema_name,table_name,workspace_column)
VALUES ('app','investor_requirements','workspace_id');

-- Narrow identity functions perform cross-workspace administration. Ordinary
-- CRM commands retain their existing selected-workspace RLS context.
GRANT UPDATE (status,updated_at) ON app.workspace_memberships TO r72_investor_programme_definer;
GRANT CREATE ON SCHEMA app_private TO r72_investor_programme_definer;
SET LOCAL ROLE r72_investor_programme_definer;

CREATE FUNCTION app_private.investor_programme_snapshot(p_session bytea)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE actor uuid; selected uuid; admin boolean;
BEGIN
 SELECT user_id,selected_workspace_id INTO actor,selected FROM app_private.resolve_session(p_session);
 IF actor IS NULL THEN RAISE EXCEPTION 'Investor session unavailable' USING ERRCODE='42501'; END IF;
 admin := EXISTS(SELECT 1 FROM app_private.investor_programme_admins WHERE user_id=actor);
 RETURN jsonb_build_object('isAdmin',admin,'selectedWorkspaceId',selected,
 'workspaces',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',w.id,'name',w.name,'role',m.role) ORDER BY w.name)
  FROM app.workspace_memberships m JOIN app.workspaces w ON w.id=m.workspace_id
  WHERE m.user_id=actor AND app_private.has_active_workspace_membership(actor,w.id)),'[]'::jsonb),
 'businesses',COALESCE((SELECT jsonb_agg(jsonb_build_object(
  'workspaceId',b.workspace_id,'ownerName',b.owner_name,'ownerEmail',b.owner_email,'brandName',b.brand_name,
  'accentColor',b.accent_color,'signature',b.email_signature,'senderEmail',b.sender_email,
  'accessState',b.access_state,'version',b.row_version,'paymentReference',b.payment_reference) ORDER BY b.created_at)
  FROM app.investor_businesses b WHERE (admin AND b.administrator_user_id=actor)
   OR (b.workspace_id=selected AND app_private.has_active_workspace_membership(actor,b.workspace_id))),'[]'::jsonb));
END $f$;

CREATE FUNCTION app_private.create_investor_business(p_session bytea,p_key uuid,p_hash bytea,p_brand text,p_name text,p_email text,p_test boolean)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE actor uuid; selected uuid; org uuid; ws uuid; pipeline uuid; prior app.investor_businesses%ROWTYPE; actor_email text;
BEGIN
 SELECT user_id,selected_workspace_id INTO actor,selected FROM app_private.resolve_session(p_session);
 IF actor IS NULL OR NOT EXISTS(SELECT 1 FROM app_private.investor_programme_admins WHERE user_id=actor)
  OR NOT app_private.lock_active_portal_session(p_session,actor,selected) THEN
  RAISE EXCEPTION 'Investor administration required' USING ERRCODE='42501'; END IF;
 IF p_key IS NULL OR p_hash IS NULL OR octet_length(p_hash)<>32 OR p_brand IS NULL OR length(btrim(p_brand)) NOT BETWEEN 1 AND 100
  OR p_name IS NULL OR length(btrim(p_name)) NOT BETWEEN 1 AND 200 OR p_email IS NULL OR length(p_email)>320
  OR p_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' OR p_test IS NULL THEN
  RAISE EXCEPTION 'Invalid investor business' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(actor::text||p_key::text,107));
 SELECT * INTO prior FROM app.investor_businesses WHERE administrator_user_id=actor AND creation_key=p_key;
 IF FOUND THEN
  IF prior.creation_hash<>p_hash THEN RAISE EXCEPTION 'Creation conflict' USING ERRCODE='40001'; END IF;
  RETURN prior.workspace_id;
 END IF;
 SELECT email::text INTO actor_email FROM app.users WHERE id=actor;
 IF p_test AND lower(p_email)<>lower(actor_email) THEN RAISE EXCEPTION 'Test business must belong to administrator' USING ERRCODE='22023'; END IF;
 ws:=gen_random_uuid(); org:=gen_random_uuid();
 INSERT INTO app.organizations(id,name,slug,kind) VALUES(org,p_brand,'investor-'||org::text,'direct_customer');
 INSERT INTO app.workspaces(id,organization_id,name,slug) VALUES(ws,org,p_brand,'investor-'||ws::text);
 INSERT INTO app.organization_memberships(organization_id,user_id,role,status) VALUES(org,actor,'admin','active');
 INSERT INTO app.workspace_memberships(workspace_id,organization_id,user_id,role,status) VALUES(ws,org,actor,'admin','active');
 INSERT INTO app.investor_businesses(workspace_id,administrator_user_id,owner_user_id,owner_email,owner_name,brand_name,access_state,creation_key,creation_hash)
 VALUES(ws,actor,CASE WHEN p_test THEN actor ELSE NULL END,lower(p_email),p_name,p_brand,CASE WHEN p_test THEN 'test' ELSE 'pending_payment' END,p_key,p_hash);
 INSERT INTO app.pipelines(workspace_id,name,slug,is_default) VALUES(ws,'Investor relationships','investors',true) RETURNING id INTO pipeline;
 INSERT INTO app.pipeline_stages(workspace_id,pipeline_id,name,slug,position,stage_type,is_terminal)
 SELECT ws,pipeline,label,slug,position,kind,kind IN ('won','lost') FROM (VALUES
  ('New enquiry','new',10,'open'),('Contacted','contacted',20,'open'),('Call booked','call-booked',30,'open'),
  ('Qualified','qualified',40,'open'),('Opportunity shared','opportunity-shared',50,'open'),('Follow-up','follow-up',60,'open'),
  ('Completed','completed',70,'won'),('Not proceeding','not-proceeding',80,'lost')) AS stages(label,slug,position,kind);
 RETURN ws;
END $f$;

CREATE FUNCTION app_private.update_investor_business(p_session bytea,p_workspace uuid,p_version bigint,p_brand text,p_color text,p_signature text,p_sender text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE actor uuid; selected uuid; b app.investor_businesses%ROWTYPE;
BEGIN
 SELECT user_id,selected_workspace_id INTO actor,selected FROM app_private.resolve_session(p_session);
 IF actor IS NULL OR NOT app_private.lock_active_portal_session(p_session,actor,selected) THEN RAISE EXCEPTION 'Session unavailable' USING ERRCODE='42501'; END IF;
 SELECT * INTO b FROM app.investor_businesses WHERE workspace_id=p_workspace FOR UPDATE;
 IF NOT FOUND OR NOT ((b.administrator_user_id=actor AND EXISTS(SELECT 1 FROM app_private.investor_programme_admins WHERE user_id=actor))
  OR (selected=p_workspace AND app_private.can_manage_workspace(actor,p_workspace))) THEN RAISE EXCEPTION 'Business unavailable' USING ERRCODE='42501'; END IF;
 IF b.row_version<>p_version THEN RAISE EXCEPTION 'Business changed' USING ERRCODE='40001'; END IF;
 IF p_sender<>'' AND (p_sender !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' OR p_sender ~ '[\r\n]') THEN RAISE EXCEPTION 'Invalid sender' USING ERRCODE='22023'; END IF;
 UPDATE app.investor_businesses SET brand_name=p_brand,accent_color=p_color,email_signature=p_signature,sender_email=lower(p_sender),row_version=row_version+1 WHERE workspace_id=p_workspace;
END $f$;

CREATE FUNCTION app_private.set_investor_access(p_session bytea,p_workspace uuid,p_version bigint,p_state text,p_reference text,p_setup_hash bytea)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE actor uuid; selected uuid; b app.investor_businesses%ROWTYPE; org uuid; target uuid; existing_password text; setup_needed boolean:=false;
BEGIN
 SELECT user_id,selected_workspace_id INTO actor,selected FROM app_private.resolve_session(p_session);
 IF actor IS NULL OR NOT EXISTS(SELECT 1 FROM app_private.investor_programme_admins WHERE user_id=actor)
  OR NOT app_private.lock_active_portal_session(p_session,actor,selected) THEN RAISE EXCEPTION 'Administration required' USING ERRCODE='42501'; END IF;
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

CREATE FUNCTION app_private.switch_investor_workspace(p_session bytea,p_workspace uuid,p_new_session bytea,p_new_csrf bytea)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE s app.user_sessions%ROWTYPE;
BEGIN
 SELECT * INTO s FROM app.user_sessions WHERE token_hash=p_session AND revoked_at IS NULL AND expires_at>clock_timestamp() FOR UPDATE;
 IF NOT FOUND OR NOT app_private.has_active_workspace_membership(s.user_id,s.selected_workspace_id)
  OR NOT app_private.has_active_workspace_membership(s.user_id,p_workspace) THEN RAISE EXCEPTION 'Workspace unavailable' USING ERRCODE='42501'; END IF;
 IF p_new_session IS NULL OR octet_length(p_new_session)<>32 OR p_new_csrf IS NULL OR octet_length(p_new_csrf)<>32 THEN RAISE EXCEPTION 'Invalid session' USING ERRCODE='22023'; END IF;
 INSERT INTO app.user_sessions(token_hash,csrf_secret_hash,user_id,selected_workspace_id,expires_at,ip_hash,user_agent_hash)
 VALUES(p_new_session,p_new_csrf,s.user_id,p_workspace,s.expires_at,s.ip_hash,s.user_agent_hash);
 UPDATE app.user_sessions SET revoked_at=clock_timestamp() WHERE id=s.id;
END $f$;

REVOKE ALL ON FUNCTION app_private.investor_programme_snapshot(bytea),app_private.create_investor_business(bytea,uuid,bytea,text,text,text,boolean),app_private.update_investor_business(bytea,uuid,bigint,text,text,text,text),app_private.set_investor_access(bytea,uuid,bigint,text,text,bytea),app_private.switch_investor_workspace(bytea,uuid,bytea,bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.investor_programme_snapshot(bytea) TO r72_web;
GRANT EXECUTE ON FUNCTION app_private.create_investor_business(bytea,uuid,bytea,text,text,text,boolean),app_private.update_investor_business(bytea,uuid,bigint,text,text,text,text),app_private.set_investor_access(bytea,uuid,bigint,text,text,bytea),app_private.switch_investor_workspace(bytea,uuid,bytea,bytea) TO r72_identity_command;

RESET ROLE;
SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private FROM r72_investor_programme_definer;
RESET ROLE;
