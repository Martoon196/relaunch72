-- INV-CRM-001: synthetic records only, execute on an isolated *_test database.
-- This proof does not reset schemas, send mail, or use production identities.
DO $guard$ BEGIN IF current_database() NOT LIKE '%test%' THEN RAISE EXCEPTION 'Disposable test database required'; END IF; END $guard$;
SET LOCAL ROLE r72_owner;
INSERT INTO app.users(id,email,display_name,status) VALUES
 ('71000000-0000-4000-8000-000000000001','investor-admin@example.invalid','Pilot administrator','active'),
 ('71000000-0000-4000-8000-000000000002','unassigned@example.invalid','Unassigned user','active');
INSERT INTO app.organizations(id,name,slug,kind) VALUES('71000000-0000-4000-8000-000000000010','Proof HQ','investor-proof-hq','agency');
INSERT INTO app.workspaces(id,organization_id,name,slug) VALUES('71000000-0000-4000-8000-000000000011','71000000-0000-4000-8000-000000000010','Proof HQ','proof-hq');
INSERT INTO app.organization_memberships(organization_id,user_id,role,status) VALUES
 ('71000000-0000-4000-8000-000000000010','71000000-0000-4000-8000-000000000001','owner','active');
INSERT INTO app.workspace_memberships(workspace_id,organization_id,user_id,role,status) VALUES
 ('71000000-0000-4000-8000-000000000011','71000000-0000-4000-8000-000000000010','71000000-0000-4000-8000-000000000001','owner','active'),
 ('71000000-0000-4000-8000-000000000011','71000000-0000-4000-8000-000000000010','71000000-0000-4000-8000-000000000002','viewer','active');
INSERT INTO app.user_sessions(token_hash,csrf_secret_hash,user_id,selected_workspace_id,expires_at) VALUES
 (decode(repeat('a1',32),'hex'),decode(repeat('b1',32),'hex'),'71000000-0000-4000-8000-000000000001','71000000-0000-4000-8000-000000000011',clock_timestamp()+interval '1 hour'),
 (decode(repeat('a2',32),'hex'),decode(repeat('b2',32),'hex'),'71000000-0000-4000-8000-000000000002','71000000-0000-4000-8000-000000000011',clock_timestamp()+interval '1 hour');
INSERT INTO app_private.investor_programme_admins(user_id) VALUES('71000000-0000-4000-8000-000000000001');
SET LOCAL ROLE r72_identity_command;
DO $proof$ DECLARE w uuid; replay uuid; BEGIN
 w:=app_private.create_investor_business(decode(repeat('a1',32),'hex'),'71000000-0000-4000-8000-000000000020',decode(repeat('c1',32),'hex'),'Northstar Test','Pilot administrator','investor-admin@example.invalid',true);
 replay:=app_private.create_investor_business(decode(repeat('a1',32),'hex'),'71000000-0000-4000-8000-000000000020',decode(repeat('c1',32),'hex'),'Northstar Test','Pilot administrator','investor-admin@example.invalid',true);
 IF w<>replay THEN RAISE EXCEPTION 'Creation replay duplicated workspace'; END IF;
 PERFORM set_config('test.investor_workspace',w::text,true);
 BEGIN
  PERFORM app_private.create_investor_business(decode(repeat('a2',32),'hex'),gen_random_uuid(),decode(repeat('c2',32),'hex'),'Forbidden','Unassigned','unassigned@example.invalid',true);
  RAISE EXCEPTION 'Unassigned user created business';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN
  PERFORM app_private.create_investor_business(decode(repeat('a1',32),'hex'),gen_random_uuid(),decode(repeat('c3',32),'hex'),'Wrong test owner','Other','other@example.invalid',true);
  RAISE EXCEPTION 'Test workspace allowed another owner';
 EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
 PERFORM app_private.update_investor_business(decode(repeat('a1',32),'hex'),w,1,'Northstar Partners','#125566','Northstar team','hello@northstar.example.invalid');
 BEGIN
  PERFORM app_private.update_investor_business(decode(repeat('a1',32),'hex'),w,1,'Stale','#125566','','');
  RAISE EXCEPTION 'Stale branding overwrote saved record';
 EXCEPTION WHEN serialization_failure THEN NULL; END;
 BEGIN
  PERFORM app_private.update_investor_business(decode(repeat('a2',32),'hex'),w,2,'Intruder','#125566','','');
  RAISE EXCEPTION 'Unassigned branding update succeeded';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 END $proof$;
SET LOCAL ROLE r72_web;
DO $proof$ DECLARE s jsonb; BEGIN
 s:=app_private.investor_programme_snapshot(decode(repeat('a2',32),'hex'));
 IF (s->>'isAdmin')::boolean OR jsonb_array_length(s->'businesses')<>0 THEN RAISE EXCEPTION 'Unassigned user saw private businesses'; END IF;
 s:=app_private.investor_programme_snapshot(decode(repeat('a1',32),'hex'));
 IF NOT (s->>'isAdmin')::boolean OR jsonb_array_length(s->'businesses')<>1 THEN RAISE EXCEPTION 'Administrator view incomplete'; END IF;
 END $proof$;
SET LOCAL ROLE r72_identity_command;
DO $proof$ DECLARE w uuid; r jsonb; BEGIN
 w:=app_private.create_investor_business(decode(repeat('a1',32),'hex'),'71000000-0000-4000-8000-000000000021',decode(repeat('c4',32),'hex'),'Mentee One','Mentee One','mentee-one@example.invalid',false);
 PERFORM set_config('test.mentee_workspace',w::text,true);
 BEGIN
  PERFORM app_private.set_investor_access(decode(repeat('a1',32),'hex'),w,1,'active','',decode(repeat('d1',32),'hex'));
  RAISE EXCEPTION 'Access activated without payment reference';
 EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
 r:=app_private.set_investor_access(decode(repeat('a1',32),'hex'),w,1,'active','TEST-PAYMENT-ONLY',decode(repeat('d1',32),'hex'));
 IF (r->>'setupNeeded')::boolean IS NOT TRUE THEN RAISE EXCEPTION 'New mentee setup missing'; END IF;
 PERFORM app_private.set_investor_access(decode(repeat('a1',32),'hex'),w,2,'suspended','',decode(repeat('d2',32),'hex'));
 BEGIN
  PERFORM app_private.switch_investor_workspace(decode(repeat('a2',32),'hex'),w,decode(repeat('e1',32),'hex'),decode(repeat('e2',32),'hex'));
  RAISE EXCEPTION 'Unassigned workspace switch succeeded';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 PERFORM app_private.switch_investor_workspace(decode(repeat('a1',32),'hex'),current_setting('test.investor_workspace')::uuid,decode(repeat('e3',32),'hex'),decode(repeat('e4',32),'hex'));
 END $proof$;
SET LOCAL ROLE r72_web;
DO $proof$ DECLARE s jsonb; BEGIN
 BEGIN
  PERFORM app_private.investor_programme_snapshot(decode(repeat('a1',32),'hex'));
  RAISE EXCEPTION 'Old workspace session remained usable';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 s:=app_private.investor_programme_snapshot(decode(repeat('e3',32),'hex'));
 IF s->>'selectedWorkspaceId'<>current_setting('test.investor_workspace') THEN RAISE EXCEPTION 'New session selected wrong workspace'; END IF;
 END $proof$;
RESET ROLE;
SELECT 'investor programme proof passed' AS result;
