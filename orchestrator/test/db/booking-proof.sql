-- GHQ-BOOKING-001. Run inside the exact isolated branch transaction; synthetic identities only.
SET LOCAL ROLE r72_owner;
INSERT INTO app.users(id,email,display_name,status) VALUES
 ('b1380000-0000-4000-8000-000000000001','booking-host@example.invalid','Booking host','active'),
 ('b1380000-0000-4000-8000-000000000002','booking-stranger@example.invalid','Other host','active');
INSERT INTO app.organizations(id,name,slug,kind) VALUES('b1380000-0000-4000-8000-000000000010','Booking proof','booking-proof-0138','agency');
INSERT INTO app.workspaces(id,organization_id,name,slug) VALUES
 ('b1380000-0000-4000-8000-000000000011','b1380000-0000-4000-8000-000000000010','Booking one','booking-proof-one'),
 ('b1380000-0000-4000-8000-000000000012','b1380000-0000-4000-8000-000000000010','Booking two','booking-proof-two');
INSERT INTO app.organization_memberships(organization_id,user_id,role,status) VALUES
 ('b1380000-0000-4000-8000-000000000010','b1380000-0000-4000-8000-000000000001','owner','active'),
 ('b1380000-0000-4000-8000-000000000010','b1380000-0000-4000-8000-000000000002','admin','active');
INSERT INTO app.workspace_memberships(workspace_id,organization_id,user_id,role,status) VALUES
 ('b1380000-0000-4000-8000-000000000011','b1380000-0000-4000-8000-000000000010','b1380000-0000-4000-8000-000000000001','owner','active'),
 ('b1380000-0000-4000-8000-000000000012','b1380000-0000-4000-8000-000000000010','b1380000-0000-4000-8000-000000000002','owner','active');
INSERT INTO app.investor_businesses(workspace_id,administrator_user_id,owner_user_id,owner_email,owner_name,brand_name,access_state,creation_key,creation_hash) VALUES
 ('b1380000-0000-4000-8000-000000000011','b1380000-0000-4000-8000-000000000001','b1380000-0000-4000-8000-000000000001','booking-host@example.invalid','Host','Booking proof','test','b1380000-0000-4000-8000-000000000021',decode(repeat('01',32),'hex')),
 ('b1380000-0000-4000-8000-000000000012','b1380000-0000-4000-8000-000000000002','b1380000-0000-4000-8000-000000000002','booking-stranger@example.invalid','Other','Other booking','test','b1380000-0000-4000-8000-000000000022',decode(repeat('02',32),'hex'));
INSERT INTO app.user_sessions(token_hash,csrf_secret_hash,user_id,selected_workspace_id,expires_at) VALUES
 (decode(repeat('b1',32),'hex'),decode(repeat('b2',32),'hex'),'b1380000-0000-4000-8000-000000000001','b1380000-0000-4000-8000-000000000011',clock_timestamp()+interval '1 hour'),
 (decode(repeat('c1',32),'hex'),decode(repeat('c2',32),'hex'),'b1380000-0000-4000-8000-000000000002','b1380000-0000-4000-8000-000000000012',clock_timestamp()+interval '1 hour');
SELECT set_config('test.booking_type','{"title":"Income Path Call","description":"Synthetic only","durationMinutes":20,"intervalMinutes":20,"bufferBeforeMinutes":0,"bufferAfterMinutes":0,"noticeMinutes":0,"horizonDays":60,"timeZone":"Europe/London","location":"","questions":[{"id":"goal","label":"Goal","kind":"textarea","required":false}]}',true);
SET LOCAL ROLE r72_identity_command;
SELECT app_private.booking_save_calendar(decode(repeat('b1',32),'hex'),0,'{"timeZone":"Europe/London","windows":[{"day":1,"start":600,"end":960},{"day":2,"start":600,"end":1260},{"day":3,"start":600,"end":960},{"day":4,"start":600,"end":1260},{"day":5,"start":600,"end":960}],"overrides":[]}');
SELECT app_private.booking_save_type(decode(repeat('b1',32),'hex'),'b1380000-0000-4000-8000-000000000031','b1380000-0000-4000-8000-000000000032',0,current_setting('test.booking_type')::jsonb,false,false);
DO $proof$ BEGIN
 BEGIN PERFORM app_private.booking_save_type(decode(repeat('c1',32),'hex'),'b1380000-0000-4000-8000-000000000031','b1380000-0000-4000-8000-000000000032',1,current_setting('test.booking_type')::jsonb,false,false);RAISE EXCEPTION 'Cross-workspace type update succeeded';EXCEPTION WHEN invalid_parameter_value OR serialization_failure THEN NULL;END;
 BEGIN PERFORM app_private.booking_save_type(decode(repeat('b1',32),'hex'),'b1380000-0000-4000-8000-000000000031','b1380000-0000-4000-8000-000000000032',1,current_setting('test.booking_type')::jsonb,true,false);RAISE EXCEPTION 'Published without calendar';EXCEPTION WHEN insufficient_privilege THEN NULL;END;
 BEGIN PERFORM app_private.booking_save_calendar(decode(repeat('b1',32),'hex'),1,'{"timeZone":"Europe/London","windows":[{"day":null,"start":600,"end":960}],"overrides":[]}');RAISE EXCEPTION 'Nullable working day accepted';EXCEPTION WHEN invalid_parameter_value THEN NULL;END;
 BEGIN PERFORM app_private.booking_save_calendar(decode(repeat('b1',32),'hex'),1,'{"timeZone":"Europe/London","windows":[{"day":2,"start":600,"end":960},{"day":2,"start":800,"end":1260}],"overrides":[]}');RAISE EXCEPTION 'Overlapping hours accepted';EXCEPTION WHEN invalid_parameter_value THEN NULL;END;
END $proof$;
SET LOCAL ROLE r72_web;
DO $proof$ DECLARE s jsonb;BEGIN
 s:=app_private.booking_snapshot(decode(repeat('b1',32),'hex'),clock_timestamp(),clock_timestamp()+interval '7 days');
 IF jsonb_array_length(s->'types')<>1 OR(s->'calendar'->>'connected')::boolean THEN RAISE EXCEPTION 'Owner snapshot wrong';END IF;
 IF app_private.booking_public_page('b1380000-0000-4000-8000-000000000032',false,clock_timestamp(),clock_timestamp()+interval '2 days') IS NOT NULL THEN RAISE EXCEPTION 'Draft exposed publicly';END IF;
 BEGIN PERFORM * FROM app.booking_appointments;RAISE EXCEPTION 'Web reads raw appointments';EXCEPTION WHEN insufficient_privilege THEN NULL;END;
 BEGIN PERFORM app_private.booking_calendar_secret('b1380000-0000-4000-8000-000000000032',false);RAISE EXCEPTION 'Web opens vault';EXCEPTION WHEN insufficient_privilege THEN NULL;END;
END $proof$;
SET LOCAL ROLE r72_owner;
INSERT INTO app_private.investor_mail_accounts(workspace_id,provider,address,settings,sealed_credentials,status,verified_at) VALUES('b1380000-0000-4000-8000-000000000011','smtp','booking-host@example.invalid','{}','synthetic-unused-vault','verified',clock_timestamp());
SET LOCAL ROLE r72_identity_command;
SELECT app_private.booking_connect_calendar(decode(repeat('b1',32),'hex'),1,'google','calendar-host@example.invalid','synthetic-calendar-vault');
SELECT app_private.booking_save_type(decode(repeat('b1',32),'hex'),'b1380000-0000-4000-8000-000000000031','b1380000-0000-4000-8000-000000000032',1,current_setting('test.booking_type')::jsonb,true,false);
SELECT app_private.booking_save_type(decode(repeat('b1',32),'hex'),'b1380000-0000-4000-8000-000000000033','b1380000-0000-4000-8000-000000000034',0,current_setting('test.booking_type')::jsonb,true,false);
DO $proof$ DECLARE a jsonb;b jsonb;start timestamptz;person jsonb:='{"name":"Guest","email":"booking-guest@example.invalid","answers":{}}';BEGIN
 start:=date_trunc('day',clock_timestamp() AT TIME ZONE 'Europe/London') AT TIME ZONE 'Europe/London'+interval '2 days 10 hours';
 WHILE extract(isodow FROM start AT TIME ZONE 'Europe/London')>5 LOOP start:=start+interval '1 day';END LOOP;
 PERFORM set_config('test.booking_start',start::text,true);
 a:=app_private.booking_hold('b1380000-0000-4000-8000-000000000032',false,'b1380000-0000-4000-8000-000000000041',start,person,decode(repeat('d1',32),'hex'),decode(repeat('d2',32),'hex'),2,2);
 b:=app_private.booking_hold('b1380000-0000-4000-8000-000000000032',false,'b1380000-0000-4000-8000-000000000041',start,person,decode(repeat('d1',32),'hex'),decode(repeat('d3',32),'hex'),2,2);
 IF a->>'id'<>b->>'id' OR(b->>'created')::boolean THEN RAISE EXCEPTION 'Replay duplicated reservation';END IF;
 PERFORM set_config('test.booking_id',a->>'id',true);
 BEGIN PERFORM app_private.booking_replay('b1380000-0000-4000-8000-000000000032',false,'b1380000-0000-4000-8000-000000000041',start,person||'{"name":"Changed"}',decode(repeat('d1',32),'hex'));RAISE EXCEPTION 'Changed replay accepted';EXCEPTION WHEN unique_violation THEN NULL;END;
 BEGIN PERFORM app_private.booking_replay('b1380000-0000-4000-8000-000000000034',false,'b1380000-0000-4000-8000-000000000041',start,person,decode(repeat('d1',32),'hex'));RAISE EXCEPTION 'Replay changed meeting type';EXCEPTION WHEN unique_violation THEN NULL;END;
 BEGIN PERFORM app_private.booking_hold('b1380000-0000-4000-8000-000000000032',false,'b1380000-0000-4000-8000-000000000042',start,person,decode(repeat('e1',32),'hex'),decode(repeat('e2',32),'hex'),2,2);RAISE EXCEPTION 'Double booked held slot';EXCEPTION WHEN exclusion_violation THEN NULL;END;
 PERFORM app_private.booking_settle((a->>'id')::uuid,decode(repeat('d2',32),'hex'),'synthetic-provider-id',true);
 IF app_private.booking_receipt('b1380000-0000-4000-8000-000000000032',false,(a->>'id')::uuid,decode(repeat('00',32),'hex')) IS NOT NULL THEN RAISE EXCEPTION 'Wrong capability reads receipt';END IF;
 IF app_private.booking_receipt('b1380000-0000-4000-8000-000000000034',false,(a->>'id')::uuid,decode(repeat('d1',32),'hex')) IS NOT NULL THEN RAISE EXCEPTION 'Capability crossed meeting type';END IF;
 IF app_private.booking_appointment_context('b1380000-0000-4000-8000-000000000032',false,(a->>'id')::uuid,NULL,decode(repeat('c1',32),'hex')) IS NOT NULL THEN RAISE EXCEPTION 'Other workspace reads appointment';END IF;
 b:=app_private.booking_receipt('b1380000-0000-4000-8000-000000000032',false,(a->>'id')::uuid,decode(repeat('d1',32),'hex'));
 IF b->>'state'<>'confirmed' THEN RAISE EXCEPTION 'Confirmed receipt missing';END IF;
 BEGIN PERFORM app_private.booking_connect_calendar(decode(repeat('b1',32),'hex'),2,'microsoft','different-calendar@example.invalid','different-sealed');RAISE EXCEPTION 'Changed account with existing booking';EXCEPTION WHEN invalid_parameter_value THEN NULL;END;
 IF app_private.booking_public_page('b1380000-0000-4000-8000-000000000032',false,start,start+interval '1 day')::text LIKE '%calendar-host@example.invalid%' THEN RAISE EXCEPTION 'Public availability exposed calendar address';END IF;
END $proof$;
SET LOCAL ROLE r72_owner;
DO $proof$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM app_private.investor_mail_accounts WHERE workspace_id='b1380000-0000-4000-8000-000000000011' AND provider='smtp' AND row_version=1 AND sealed_credentials='synthetic-unused-vault') THEN RAISE EXCEPTION 'Calendar replaced existing mailbox';END IF;
 IF(SELECT count(*) FROM app.activities WHERE metadata->>'appointmentId'=current_setting('test.booking_id') AND activity_type='calendar.meeting.booked')<>1 THEN RAISE EXCEPTION 'CRM activity duplicated/missing';END IF;
 IF EXISTS(SELECT 1 FROM app.contact_points WHERE normalized_value='booking-guest@example.invalid' AND (is_verified OR consent_status<>'unknown')) THEN RAISE EXCEPTION 'Booking verified email or granted marketing consent';END IF;
END $proof$;
SET LOCAL ROLE r72_identity_command;
DO $proof$ DECLARE r jsonb;BEGIN
 r:=app_private.booking_change_begin('b1380000-0000-4000-8000-000000000032',false,current_setting('test.booking_id')::uuid,decode(repeat('d1',32),'hex'),NULL,'move',current_setting('test.booking_start')::timestamptz+interval '1 hour',2,decode(repeat('f0',32),'hex'));
 BEGIN PERFORM app_private.booking_hold('b1380000-0000-4000-8000-000000000032',false,gen_random_uuid(),current_setting('test.booking_start')::timestamptz,'{"name":"Other","email":"other@example.invalid","answers":{}}',decode(repeat('aa',32),'hex'),decode(repeat('bb',32),'hex'),2,2);RAISE EXCEPTION 'Move released original time early';EXCEPTION WHEN exclusion_violation THEN NULL;END;
 BEGIN PERFORM app_private.booking_hold('b1380000-0000-4000-8000-000000000032',false,gen_random_uuid(),current_setting('test.booking_start')::timestamptz+interval '1 hour','{"name":"Other","email":"other@example.invalid","answers":{}}',decode(repeat('aa',32),'hex'),decode(repeat('bb',32),'hex'),2,2);RAISE EXCEPTION 'Move failed to reserve new time';EXCEPTION WHEN exclusion_violation THEN NULL;END;
 PERFORM app_private.booking_change_settle(current_setting('test.booking_id')::uuid,decode(repeat('f0',32),'hex'),true);
 r:=app_private.booking_change_begin('b1380000-0000-4000-8000-000000000032',false,current_setting('test.booking_id')::uuid,decode(repeat('d1',32),'hex'),NULL,'cancel',NULL,4,decode(repeat('f1',32),'hex'));
 IF r->>'state'<>'cancelling' THEN RAISE EXCEPTION 'Cancellation released slot before provider';END IF;
 PERFORM app_private.booking_change_settle(current_setting('test.booking_id')::uuid,decode(repeat('f1',32),'hex'),true);
 r:=app_private.booking_hold('b1380000-0000-4000-8000-000000000032',false,'b1380000-0000-4000-8000-000000000043',current_setting('test.booking_start')::timestamptz,'{"name":"Private","email":"booking-host@example.invalid","answers":{}}',NULL,decode(repeat('f2',32),'hex'),2,2,decode(repeat('b1',32),'hex'),false);
 IF r->>'state'<>'local' THEN RAISE EXCEPTION 'Local meeting requires provider';END IF;
 IF app_private.booking_replay('b1380000-0000-4000-8000-000000000032',false,'b1380000-0000-4000-8000-000000000043',current_setting('test.booking_start')::timestamptz,'{"name":"Private","email":"booking-host@example.invalid","answers":{}}',NULL,decode(repeat('b1',32),'hex'),false)->>'id'<>r->>'id' THEN RAISE EXCEPTION 'Local replay lost receipt';END IF;
END $proof$;
RESET ROLE;
SELECT 'booking real-role proof: workspace isolation, draft gate, nullable/overlap validation, public privacy, secret ACL, replay/conflict, held-slot collision, CRM, capability, cancellation, local meeting' AS passed;
