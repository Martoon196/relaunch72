-- GHQ-WEBINAR-003, ROOT EXECUTION ONLY on a fresh disposable production clone.
-- Requires exact0124 and an outer transaction that MUST ROLLBACK.
-- Founder rows are read from the isolated clone; only synthetic session hashes
-- are used. No credential is read/changed and no email/provider call is made.
DO $guard$ BEGIN
 IF current_setting('mhp.proof.enabled',true) IS DISTINCT FROM 'isolated'
 THEN RAISE EXCEPTION 'Isolated MHP proof not enabled'; END IF;
END $guard$;
SET LOCAL ROLE r72_owner;
DO $fixtures$
DECLARE actor uuid; personal uuid; normal uuid:='ed124000-0000-4000-8000-000000000001';
 org uuid:='ed124000-0000-4000-8000-000000000002'; ws uuid:='ed124000-0000-4000-8000-000000000003';
 pp uuid:='ed124000-0000-4000-8000-000000000004';
BEGIN
 IF EXISTS(SELECT 1 FROM app.workspaces WHERE id='2789228d-55a6-4688-b1e8-2f70abca990b'
  OR(organization_id='ba41b1a4-9752-4dbf-8312-d04a0f03d0b8' AND slug::text='mhp-brand-marketing'))
  OR EXISTS(SELECT 1 FROM app.users WHERE id=normal)
 THEN RAISE EXCEPTION 'Require a fresh isolated marketing proof transaction'; END IF;
 SELECT u.id,m.workspace_id INTO actor,personal FROM app.users u
 JOIN app_private.investor_programme_admins a ON a.user_id=u.id
 JOIN app.organization_memberships om ON om.user_id=u.id AND om.organization_id='ba41b1a4-9752-4dbf-8312-d04a0f03d0b8'
  AND om.role='owner' AND om.status='active' AND om.revoked_at IS NULL
 JOIN app_private.mhp_members m ON m.user_id=u.id
 JOIN app.workspace_memberships wm ON wm.workspace_id=m.workspace_id AND wm.user_id=u.id
  AND wm.role='owner' AND wm.status='active' AND wm.revoked_at IS NULL
 WHERE lower(u.email::text)='martin.howard1984@gmail.com' AND u.status='active' AND u.email_verified_at IS NOT NULL;
 IF actor IS NULL OR personal IS NULL THEN RAISE EXCEPTION 'Cloned verified founder and personal Desk are required'; END IF;
 PERFORM set_config('mhp.marketing.proof.actor',actor::text,true);
 PERFORM set_config('mhp.marketing.proof.personal',personal::text,true);
 PERFORM set_config('mhp.marketing.proof.members',(SELECT count(*)::text FROM app_private.mhp_members WHERE user_id=actor),true);
 PERFORM set_config('mhp.marketing.proof.businesses',(SELECT count(*)::text FROM app.investor_businesses WHERE owner_user_id=actor),true);
 INSERT INTO app.organizations(id,name,slug,kind) VALUES(org,'Synthetic marketing proof','synthetic-marketing-proof','direct_customer');
 INSERT INTO app.users(id,email,display_name,status,email_verified_at,password_hash)
 VALUES(normal,'mhp-marketing-member@example.invalid','Synthetic member','active',clock_timestamp(),'scrypt$v1$isolated-proof-hash-not-a-password');
 INSERT INTO app.workspaces(id,organization_id,name,slug) VALUES(ws,org,'Synthetic personal Desk','synthetic-personal'),(pp,org,'Synthetic PP','synthetic-pp');
 INSERT INTO app.organization_memberships(organization_id,user_id,role,status) VALUES(org,normal,'owner','active');
 INSERT INTO app.workspace_memberships(workspace_id,organization_id,user_id,role,status)
 VALUES(ws,org,normal,'owner','active'),(pp,org,normal,'owner','active');
 INSERT INTO app_private.mhp_members(workspace_id,user_id,owner_email,manual_tier,manual_reference,manual_active)
 VALUES(ws,normal,'mhp-marketing-member@example.invalid','course','synthetic-proof',true);
 INSERT INTO app.user_sessions(token_hash,csrf_secret_hash,user_id,selected_workspace_id,expires_at,product_audience)
 SELECT public.digest(label,'sha256'),public.digest(label||'-csrf','sha256'),actor,personal,clock_timestamp()+interval '1 hour','martin_howard_property'
 FROM(VALUES('marketing-proof-owner-a'),('marketing-proof-owner-b'),('marketing-proof-owner-c'),('marketing-proof-owner-d')) t(label);
 INSERT INTO app.user_sessions(token_hash,csrf_secret_hash,user_id,selected_workspace_id,expires_at,product_audience)
 VALUES(public.digest('marketing-proof-member','sha256'),public.digest('marketing-proof-member-csrf','sha256'),normal,ws,clock_timestamp()+interval '1 hour','martin_howard_property'),
 (public.digest('marketing-proof-pp','sha256'),public.digest('marketing-proof-pp-csrf','sha256'),normal,pp,clock_timestamp()+interval '1 hour','property_predator_growth');
END $fixtures$;

DO $acl$ BEGIN
 IF NOT has_function_privilege('r72_identity_command','app_private.select_mhp_marketing_workspace(bytea,text,bytea,bytea,uuid)','EXECUTE')
  OR has_function_privilege('r72_web','app_private.select_mhp_marketing_workspace(bytea,text,bytea,bytea,uuid)','EXECUTE')
  OR has_function_privilege('r72_identity_command','app_private.mhp_marketing_workspace_allowed(uuid,uuid)','EXECUTE')
  OR has_table_privilege('r72_identity_command','app_private.mhp_marketing_workspace_events','SELECT,INSERT,UPDATE,DELETE')
  OR has_table_privilege('r72_web','app_private.mhp_marketing_workspace_events','SELECT,INSERT,UPDATE,DELETE')
  OR has_schema_privilege('r72_mhp_member_definer','app_private','CREATE')
  OR has_schema_privilege('r72_mhp_auth_definer','app_private','CREATE')
 THEN RAISE EXCEPTION 'Marketing capability boundary is not exact'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='app_private' AND c.relname='mhp_marketing_workspace_events' AND c.relrowsecurity AND c.relforcerowsecurity)
 THEN RAISE EXCEPTION 'Marketing audit RLS is not forced'; END IF;
END $acl$;

SET LOCAL ROLE r72_identity_command;
DO $denied_inputs$
DECLARE label text; denied boolean;
BEGIN
 FOREACH label IN ARRAY ARRAY['marketing-proof-member','marketing-proof-pp','marketing-proof-absent'] LOOP
  denied:=false;
  BEGIN PERFORM app_private.select_mhp_marketing_workspace(public.digest(label,'sha256'),'open',public.digest(label||'-next','sha256'),public.digest(label||'-csrf2','sha256'),gen_random_uuid());
  EXCEPTION WHEN insufficient_privilege THEN denied:=true; END;
  IF NOT denied THEN RAISE EXCEPTION 'Non-owner/foreign/missing session admitted: %',label; END IF;
 END LOOP;
END $denied_inputs$;

SET LOCAL ROLE r72_owner;
DO $canonical_conflicts$
DECLARE which integer; denied boolean;
BEGIN
 FOR which IN 1..3 LOOP
  BEGIN
   INSERT INTO app.workspaces(id,organization_id,name,slug) VALUES(
    CASE WHEN which=3 THEN 'ed124000-0000-4000-8000-000000000099'::uuid ELSE '2789228d-55a6-4688-b1e8-2f70abca990b'::uuid END,
    CASE WHEN which=1 THEN 'ed124000-0000-4000-8000-000000000002'::uuid ELSE 'ba41b1a4-9752-4dbf-8312-d04a0f03d0b8'::uuid END,
    'Synthetic conflicting identity',CASE WHEN which=2 THEN 'wrong-marketing-slug' ELSE 'mhp-brand-marketing' END);
   SET LOCAL ROLE r72_identity_command;
   denied:=false;
   BEGIN PERFORM app_private.select_mhp_marketing_workspace(public.digest('marketing-proof-owner-a','sha256'),'open',public.digest('marketing-proof-conflict-next','sha256'),public.digest('marketing-proof-conflict-csrf','sha256'),gen_random_uuid());
   EXCEPTION WHEN insufficient_privilege THEN denied:=true; END;
   IF NOT denied THEN RAISE EXCEPTION 'Wrong canonical identity accepted: %',which; END IF;
   -- Roll back only this deliberate collision, including every attempted row.
   RAISE EXCEPTION 'rollback synthetic conflict' USING ERRCODE='P1240';
  EXCEPTION WHEN SQLSTATE 'P1240' THEN NULL; END;
 END LOOP;
 IF EXISTS(SELECT 1 FROM app.workspaces WHERE id='2789228d-55a6-4688-b1e8-2f70abca990b')
  OR EXISTS(SELECT 1 FROM app_private.mhp_marketing_workspace_events)
 THEN RAISE EXCEPTION 'Rejected provisioning left partial rows'; END IF;
END $canonical_conflicts$;

SET LOCAL ROLE r72_identity_command;
DO $open$
DECLARE actor uuid; ws uuid;
BEGIN
 SELECT user_id,selected_workspace_id INTO actor,ws FROM app_private.select_mhp_marketing_workspace(
  public.digest('marketing-proof-owner-a','sha256'),'open',public.digest('marketing-proof-brand-a','sha256'),public.digest('marketing-proof-brand-a-csrf','sha256'),'ed124000-0000-4000-8000-000000000010');
 IF actor IS DISTINCT FROM current_setting('mhp.marketing.proof.actor')::uuid
  OR ws IS DISTINCT FROM '2789228d-55a6-4688-b1e8-2f70abca990b'::uuid THEN RAISE EXCEPTION 'Owner brand entry failed'; END IF;
 -- A second independent existing owner session must reuse the same workspace.
 SELECT selected_workspace_id INTO ws FROM app_private.select_mhp_marketing_workspace(
  public.digest('marketing-proof-owner-b','sha256'),'open',public.digest('marketing-proof-brand-b','sha256'),public.digest('marketing-proof-brand-b-csrf','sha256'),'ed124000-0000-4000-8000-000000000011');
 IF ws IS DISTINCT FROM '2789228d-55a6-4688-b1e8-2f70abca990b'::uuid THEN RAISE EXCEPTION 'Owner workspace was not idempotent'; END IF;
 BEGIN
  PERFORM app_private.select_mhp_marketing_workspace(public.digest('marketing-proof-owner-a','sha256'),'open',public.digest('marketing-proof-fork','sha256'),public.digest('marketing-proof-fork-csrf','sha256'),gen_random_uuid());
  RAISE EXCEPTION 'Rotated input session forked';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN
  PERFORM app_private.switch_investor_workspace(public.digest('marketing-proof-owner-c','sha256'),'2789228d-55a6-4688-b1e8-2f70abca990b',public.digest('marketing-proof-selector','sha256'),public.digest('marketing-proof-selector-csrf','sha256'));
  RAISE EXCEPTION 'Legacy investor selector became a brand selector';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $open$;

SET LOCAL ROLE r72_web;
DO $native_brand$
DECLARE a jsonb; field text;
BEGIN
 IF (SELECT count(*) FROM app_private.resolve_mhp_session(public.digest('marketing-proof-owner-a','sha256')))<>0
  OR (SELECT count(*) FROM app_private.resolve_mhp_session(public.digest('marketing-proof-brand-a','sha256')))<>1
  OR (SELECT count(*) FROM app_private.resolve_portal_session(public.digest('marketing-proof-brand-a','sha256')))<>0
 THEN RAISE EXCEPTION 'Rotated/native/PP audience boundary failed'; END IF;
 a:=app_private.mhp_member_snapshot(public.digest('marketing-proof-brand-a','sha256'));
 IF NOT(a->>'crm')::boolean OR NOT(a->>'marketingWorkspace')::boolean OR (a->>'readOnly')::boolean
  OR NOT app_private.mhp_is_owner(public.digest('marketing-proof-brand-a','sha256'))
 THEN RAISE EXCEPTION 'Owner brand capability failed'; END IF;
 FOREACH field IN ARRAY ARRAY['enquirySite','emailWorkflow','emailWritable','leadrelay','calculators'] LOOP
  IF (a->>field)::boolean IS DISTINCT FROM false THEN RAISE EXCEPTION 'Brand gained excluded capability: %',field; END IF;
 END LOOP;
END $native_brand$;

SET LOCAL ROLE r72_owner;
DO $one_workspace$
BEGIN
 IF (SELECT count(*) FROM app.workspaces WHERE organization_id='ba41b1a4-9752-4dbf-8312-d04a0f03d0b8' AND slug::text='mhp-brand-marketing')<>1
  OR (SELECT count(*) FROM app.pipelines WHERE workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b')<>1
  OR (SELECT count(*) FROM app.pipeline_stages WHERE workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b')<>8
  OR EXISTS(SELECT 1 FROM app_private.mhp_members WHERE workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b')
  OR EXISTS(SELECT 1 FROM app.investor_businesses WHERE workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b')
  OR (SELECT count(*) FROM app_private.mhp_members WHERE user_id=current_setting('mhp.marketing.proof.actor')::uuid)<>current_setting('mhp.marketing.proof.members')::int
  OR (SELECT count(*) FROM app_private.mhp_marketing_workspace_events)<>2
 THEN RAISE EXCEPTION 'Canonical workspace/pipeline/member/audit invariant failed'; END IF;
END $one_workspace$;

-- A member with an artificial brand membership still fails native admin access,
-- and PP password/SSO must skip the brand even if it is their earliest owner row.
INSERT INTO app.workspace_memberships(workspace_id,organization_id,user_id,role,status,granted_at,updated_at)
VALUES('2789228d-55a6-4688-b1e8-2f70abca990b','ba41b1a4-9752-4dbf-8312-d04a0f03d0b8','ed124000-0000-4000-8000-000000000001','owner','active',clock_timestamp()-interval '1 day',clock_timestamp());
INSERT INTO app.user_sessions(token_hash,csrf_secret_hash,user_id,selected_workspace_id,expires_at,product_audience)
SELECT public.digest(label,'sha256'),public.digest(label||'-csrf','sha256'),'ed124000-0000-4000-8000-000000000001','2789228d-55a6-4688-b1e8-2f70abca990b',clock_timestamp()+interval '1 hour',audience
FROM(VALUES('marketing-proof-forged-mhp','martin_howard_property'),('marketing-proof-forged-pp','property_predator_growth')) v(label,audience);
SET LOCAL ROLE r72_web;
DO $forged_audience$ BEGIN
 IF EXISTS(SELECT 1 FROM app_private.resolve_mhp_session(public.digest('marketing-proof-forged-mhp','sha256')))
  OR EXISTS(SELECT 1 FROM app_private.resolve_portal_session(public.digest('marketing-proof-forged-pp','sha256')))
 THEN RAISE EXCEPTION 'Brand host accepted artificial audience/membership'; END IF;
END $forged_audience$;
SET LOCAL ROLE r72_identity_command;
DO $pp_default$
DECLARE ws uuid;
BEGIN
 SELECT selected_workspace_id INTO ws FROM app_private.portal_login_credential('mhp-marketing-member@example.invalid');
 IF ws IS DISTINCT FROM 'ed124000-0000-4000-8000-000000000004'::uuid THEN RAISE EXCEPTION 'PP password default selected MHP brand'; END IF;
 SELECT selected_workspace_id INTO ws FROM app_private.create_portal_external_identity_session(
  'https://propertypredator.com','ed124000-0000-4000-8000-000000000020','mhp-marketing-member@example.invalid',true,
  'ed124000-0000-4000-8000-000000000001',false,NULL,NULL,NULL,NULL,NULL,
  public.digest('marketing-proof-sso','sha256'),public.digest('marketing-proof-sso-csrf','sha256'),public.digest('marketing-proof-source','sha256'),NULL);
 IF ws IS DISTINCT FROM 'ed124000-0000-4000-8000-000000000004'::uuid THEN RAISE EXCEPTION 'PP SSO selected MHP brand'; END IF;
END $pp_default$;

SET LOCAL ROLE r72_owner;
DO $disabled_membership$
BEGIN
 BEGIN
  UPDATE app.workspace_memberships SET status='revoked',revoked_at=clock_timestamp(),updated_at=clock_timestamp()
   WHERE workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND user_id=current_setting('mhp.marketing.proof.actor')::uuid;
  SET LOCAL ROLE r72_identity_command;
  BEGIN
   PERFORM app_private.select_mhp_marketing_workspace(public.digest('marketing-proof-owner-c','sha256'),'open',public.digest('marketing-proof-disabled','sha256'),public.digest('marketing-proof-disabled-csrf','sha256'),gen_random_uuid());
   RAISE EXCEPTION 'Revoked brand membership was restored';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  SET LOCAL ROLE r72_web;
  IF EXISTS(SELECT 1 FROM app_private.resolve_mhp_session(public.digest('marketing-proof-brand-a','sha256')))
  THEN RAISE EXCEPTION 'Revoked brand session still resolved'; END IF;
  RAISE EXCEPTION 'rollback revoked fixture' USING ERRCODE='P1240';
 EXCEPTION WHEN SQLSTATE 'P1240' THEN NULL; END;
END $disabled_membership$;

-- Shared command role uses the actual selected session hash and the existing
-- write policy. No new CRM command or bypassing operator actor is introduced.
SET LOCAL ROLE r72_crm_command;
SELECT set_config('app.workspace_id','2789228d-55a6-4688-b1e8-2f70abca990b',true),
 set_config('app.user_id',current_setting('mhp.marketing.proof.actor'),true),
 set_config('app.actor_kind','user',true),set_config('app.request_id','isolated-mhp-marketing-crm-proof',true);
DO $crm_session$ BEGIN
 IF NOT app_private.lock_active_portal_session(public.digest('marketing-proof-brand-a','sha256'),current_setting('mhp.marketing.proof.actor')::uuid,'2789228d-55a6-4688-b1e8-2f70abca990b')
  OR app_private.lock_active_portal_session(public.digest('marketing-proof-brand-a','sha256'),current_setting('mhp.marketing.proof.actor')::uuid,current_setting('mhp.marketing.proof.personal')::uuid)
  OR app_private.lock_active_portal_session(public.digest('marketing-proof-owner-a','sha256'),current_setting('mhp.marketing.proof.actor')::uuid,current_setting('mhp.marketing.proof.personal')::uuid)
 THEN RAISE EXCEPTION 'Shared CRM selected-session fence failed'; END IF;
END $crm_session$;
INSERT INTO app.contacts(id,workspace_id,display_name,owner_user_id)
VALUES('ed124000-0000-4000-8000-000000000030','2789228d-55a6-4688-b1e8-2f70abca990b','Synthetic brand enquiry',current_setting('mhp.marketing.proof.actor')::uuid);
INSERT INTO app.tasks(id,workspace_id,contact_id,title,assignee_user_id)
VALUES('ed124000-0000-4000-8000-000000000031','2789228d-55a6-4688-b1e8-2f70abca990b','ed124000-0000-4000-8000-000000000030','Synthetic follow-up',current_setting('mhp.marketing.proof.actor')::uuid);
UPDATE app.tasks SET status='completed',completed_at=clock_timestamp(),completed_by_user_id=current_setting('mhp.marketing.proof.actor')::uuid,row_version=row_version+1,updated_at=clock_timestamp()
WHERE workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND id='ed124000-0000-4000-8000-000000000031';

SET LOCAL ROLE r72_identity_command;
DO $return$
DECLARE ws uuid;
BEGIN
 SELECT selected_workspace_id INTO ws FROM app_private.select_mhp_marketing_workspace(
  public.digest('marketing-proof-brand-a','sha256'),'return',public.digest('marketing-proof-returned','sha256'),public.digest('marketing-proof-returned-csrf','sha256'),'ed124000-0000-4000-8000-000000000012');
 IF ws IS DISTINCT FROM current_setting('mhp.marketing.proof.personal')::uuid THEN RAISE EXCEPTION 'Return did not select the actual personal Desk'; END IF;
END $return$;
SET LOCAL ROLE r72_web;
DO $return_resolution$ BEGIN
 IF EXISTS(SELECT 1 FROM app_private.resolve_mhp_session(public.digest('marketing-proof-brand-a','sha256')))
  OR (SELECT selected_workspace_id FROM app_private.resolve_mhp_session(public.digest('marketing-proof-returned','sha256'))) IS DISTINCT FROM current_setting('mhp.marketing.proof.personal')::uuid
  OR (SELECT count(*) FROM app_private.resolve_mhp_session(public.digest('marketing-proof-brand-b','sha256')))<>1
 THEN RAISE EXCEPTION 'Return failed or logged out an independent device'; END IF;
END $return_resolution$;

-- The compatible base123 application still mounts native logout before CRM.
-- Prove its unchanged revoke capability accepts a brand-selected cookie, then
-- use the unchanged normal issuance helper below to recover the personal Desk.
SET LOCAL ROLE r72_identity_command;
SELECT app_private.revoke_mhp_session(public.digest('marketing-proof-brand-b','sha256'));
SET LOCAL ROLE r72_web;
DO $recovery_logout$ BEGIN
 IF EXISTS(SELECT 1 FROM app_private.resolve_mhp_session(public.digest('marketing-proof-brand-b','sha256')))
  OR (SELECT count(*) FROM app_private.resolve_mhp_session(public.digest('marketing-proof-returned','sha256')))<>1
 THEN RAISE EXCEPTION 'Native brand logout failed or revoked an independent session'; END IF;
END $recovery_logout$;

-- Exercise the unchanged helper used by both normal native login flows. It
-- must choose the personal member row even after the brand membership exists.
SET LOCAL ROLE r72_mhp_auth_definer;
DO $ordinary_login$
DECLARE ws uuid;
BEGIN
 SELECT selected_workspace_id INTO ws FROM app_private.issue_mhp_session(current_setting('mhp.marketing.proof.actor')::uuid,
  public.digest('marketing-proof-normal-login','sha256'),public.digest('marketing-proof-normal-login-csrf','sha256'),public.digest('marketing-proof-source','sha256'),NULL);
 IF ws IS DISTINCT FROM current_setting('mhp.marketing.proof.personal')::uuid THEN RAISE EXCEPTION 'Normal owner login default changed'; END IF;
END $ordinary_login$;
SET LOCAL ROLE r72_owner;
DO $final$ BEGIN
 IF (SELECT count(*) FROM app_private.mhp_members WHERE user_id=current_setting('mhp.marketing.proof.actor')::uuid)<>current_setting('mhp.marketing.proof.members')::int
  OR (SELECT count(*) FROM app.investor_businesses WHERE owner_user_id=current_setting('mhp.marketing.proof.actor')::uuid)<>current_setting('mhp.marketing.proof.businesses')::int
  OR (SELECT count(*) FROM app_private.mhp_marketing_workspace_events)<>3
  OR NOT EXISTS(SELECT 1 FROM app.user_sessions WHERE token_hash=public.digest('marketing-proof-normal-login','sha256')
   AND selected_workspace_id=current_setting('mhp.marketing.proof.personal')::uuid AND revoked_at IS NULL)
  OR NOT EXISTS(SELECT 1 FROM app.tasks WHERE id='ed124000-0000-4000-8000-000000000031' AND status='completed')
 THEN RAISE EXCEPTION 'Final owner/member/CRM/audit invariant failed'; END IF;
 BEGIN UPDATE app_private.mhp_marketing_workspace_events SET action='return';
  RAISE EXCEPTION 'Marketing audit was mutable';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $final$;
-- Parent harness must deliberately ROLLBACK, never commit this fixture.
SELECT 'GHQ-WEBINAR-003 rollback-only SQL proof reached its final assertion' AS proof;
