-- Run AFTER investor-programme-proof.sql on the same isolated *_test database.
-- Synthetic setup tokens/users only. No customer records or external effects.
DO $g$ BEGIN IF current_database() NOT LIKE '%test%' THEN RAISE EXCEPTION 'Test database required'; END IF; END $g$;
SET LOCAL ROLE r72_owner;
SELECT set_config('test.one',(SELECT workspace_id::text FROM app.investor_businesses WHERE owner_email='mentee-one@example.invalid'),true);
SET LOCAL ROLE r72_identity_command;
DO $p$ DECLARE w uuid; n integer; BEGIN
 PERFORM app_private.set_investor_access(decode(repeat('e3',32),'hex'),current_setting('test.one')::uuid,3,'active','TEST-RESTORE',decode(repeat('f1',32),'hex'));
 SELECT count(*) INTO n FROM app_private.reserve_native_account_setup(decode(repeat('f1',32),'hex'),decode(repeat('f2',32),'hex'),decode(repeat('f3',32),'hex'));
 IF n<>1 THEN RAISE EXCEPTION 'Mentee setup reservation failed'; END IF;
 SELECT count(*) INTO n FROM app_private.complete_native_account_setup(decode(repeat('f1',32),'hex'),decode(repeat('f2',32),'hex'),decode(repeat('f3',32),'hex'),
  'scrypt$v1$16384,8,1$'||repeat('A',22)||'$'||repeat('B',43),decode(repeat('f4',32),'hex'),decode(repeat('f5',32),'hex'));
 IF n<>1 THEN RAISE EXCEPTION 'Mentee native account setup failed'; END IF;
 SELECT count(*) INTO n FROM app_private.reserve_native_account_setup(decode(repeat('f1',32),'hex'),decode(repeat('f6',32),'hex'),decode(repeat('f7',32),'hex'));
 IF n<>0 THEN RAISE EXCEPTION 'Consumed setup token replayed'; END IF;
 w:=app_private.create_investor_business(decode(repeat('e3',32),'hex'),'71000000-0000-4000-8000-000000000022',decode(repeat('a3',32),'hex'),'Harbour Partners','Mentee Two','mentee-two@example.invalid',false);
 PERFORM set_config('test.two',w::text,true);
 PERFORM app_private.set_investor_access(decode(repeat('e3',32),'hex'),w,1,'active','TEST-PAYMENT-TWO',decode(repeat('a4',32),'hex'));
 SELECT count(*) INTO n FROM app_private.reserve_native_account_setup(decode(repeat('a4',32),'hex'),decode(repeat('a5',32),'hex'),decode(repeat('a6',32),'hex'));
 IF n<>1 THEN RAISE EXCEPTION 'Second setup reservation failed'; END IF;
 SELECT count(*) INTO n FROM app_private.complete_native_account_setup(decode(repeat('a4',32),'hex'),decode(repeat('a5',32),'hex'),decode(repeat('a6',32),'hex'),
  'scrypt$v1$16384,8,1$'||repeat('C',22)||'$'||repeat('D',43),decode(repeat('a7',32),'hex'),decode(repeat('a8',32),'hex'));
 IF n<>1 THEN RAISE EXCEPTION 'Second native setup failed'; END IF;
 END $p$;
SET LOCAL ROLE r72_owner;
INSERT INTO app.contacts(id,workspace_id,display_name) VALUES
 ('71000000-0000-4000-8000-000000000031',current_setting('test.one')::uuid,'Same investor · business one'),
 ('71000000-0000-4000-8000-000000000032',current_setting('test.two')::uuid,'Same investor · business two');
INSERT INTO app.contact_points(workspace_id,contact_id,kind,value,normalized_value) VALUES
 (current_setting('test.one')::uuid,'71000000-0000-4000-8000-000000000031','email','same-investor@example.invalid','same-investor@example.invalid'),
 (current_setting('test.two')::uuid,'71000000-0000-4000-8000-000000000032','email','same-investor@example.invalid','same-investor@example.invalid');
INSERT INTO app.investor_requirements(workspace_id,contact_id,notes) VALUES
 (current_setting('test.one')::uuid,'71000000-0000-4000-8000-000000000031','Private to business one'),
 (current_setting('test.two')::uuid,'71000000-0000-4000-8000-000000000032','Private to business two');
SELECT set_config('test.one_user',(SELECT owner_user_id::text FROM app.investor_businesses WHERE workspace_id=current_setting('test.one')::uuid),true);
SET LOCAL ROLE r72_web;
DO $p$ DECLARE s jsonb; BEGIN
 s:=app_private.investor_programme_snapshot(decode(repeat('f4',32),'hex'));
 IF (s->>'isAdmin')::boolean OR jsonb_array_length(s->'businesses')<>1 OR s->'businesses'->0->>'workspaceId'<>current_setting('test.one') THEN RAISE EXCEPTION 'First mentee programme isolation failed'; END IF;
 s:=app_private.investor_programme_snapshot(decode(repeat('a7',32),'hex'));
 IF jsonb_array_length(s->'businesses')<>1 OR s->'businesses'->0->>'workspaceId'<>current_setting('test.two') THEN RAISE EXCEPTION 'Second mentee programme isolation failed'; END IF;
 END $p$;
SELECT set_config('app.user_id',current_setting('test.one_user'),true),set_config('app.workspace_id',current_setting('test.one'),true),set_config('app.actor_kind','user',true),set_config('app.request_id','investor-isolation-proof',true);
DO $p$ BEGIN
 IF (SELECT count(*) FROM app.contact_points WHERE normalized_value='same-investor@example.invalid')<>1 THEN RAISE EXCEPTION 'Contact email crossed workspace'; END IF;
 IF (SELECT count(*) FROM app.investor_requirements)<>1 OR EXISTS(SELECT 1 FROM app.investor_requirements WHERE notes='Private to business two') THEN RAISE EXCEPTION 'Requirements leaked'; END IF;
 END $p$;
SET LOCAL ROLE r72_crm_command;
DO $p$ BEGIN
 UPDATE app.investor_requirements SET notes='Own edit',row_version=row_version+1 WHERE contact_id='71000000-0000-4000-8000-000000000031';
 IF NOT FOUND THEN RAISE EXCEPTION 'Own requirements not writable'; END IF;
 UPDATE app.investor_requirements SET notes='Forbidden edit' WHERE contact_id='71000000-0000-4000-8000-000000000032';
 IF FOUND THEN RAISE EXCEPTION 'Cross-business edit succeeded'; END IF;
 BEGIN
  INSERT INTO app.investor_requirements(workspace_id,contact_id,notes) VALUES(current_setting('test.one')::uuid,'71000000-0000-4000-8000-000000000032','Wrong contact');
  RAISE EXCEPTION 'Cross-business contact relationship succeeded';
 EXCEPTION WHEN foreign_key_violation THEN NULL; END;
 END $p$;
SET LOCAL ROLE r72_identity_command;
DO $p$ BEGIN
 BEGIN
  PERFORM app_private.switch_investor_workspace(decode(repeat('f4',32),'hex'),current_setting('test.two')::uuid,decode(repeat('b3',32),'hex'),decode(repeat('b4',32),'hex'));
  RAISE EXCEPTION 'Mentee switched to another business';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 PERFORM app_private.set_investor_access(decode(repeat('e3',32),'hex'),current_setting('test.one')::uuid,4,'suspended','',decode(repeat('b5',32),'hex'));
 END $p$;
SET LOCAL ROLE r72_web;
DO $p$ BEGIN
 IF app_private.active_portal_session(decode(repeat('f4',32),'hex'),current_setting('test.one_user')::uuid,current_setting('test.one')::uuid) THEN RAISE EXCEPTION 'Suspended session remained active'; END IF;
 IF EXISTS(SELECT 1 FROM app.investor_requirements) THEN RAISE EXCEPTION 'Suspended member retained read access'; END IF;
 IF jsonb_array_length(app_private.investor_programme_snapshot(decode(repeat('e3',32),'hex'))->'businesses')<>3 THEN RAISE EXCEPTION 'Programme admin lost oversight'; END IF;
 END $p$;
RESET ROLE;
SELECT 'two-business setup, isolation and suspension proof passed' AS result;
