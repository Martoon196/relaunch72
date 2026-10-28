-- Isolated 0113-0117 rehearsal only. The caller rolls the entire transaction back.
-- Synthetic people use example.invalid; existing founders use only real token
-- consumption or an already verified MHP session from the preceding proof.
SET LOCAL ROLE r72_owner;
DO $proof$
DECLARE owner_id uuid;owner_ws uuid;owner_token bytea;staff_id uuid;staff_ws uuid;grant_id uuid;again uuid;
 course uuid;mentoring uuid;kit uuid;kit_user uuid;kit_ws uuid;command uuid:=gen_random_uuid();expiry timestamptz:=clock_timestamp()+interval '2 days';
 staff_email text:='mhp-staff-'||gen_random_uuid()::text||'@example.invalid';
 kit_email text:='mhp-kit-staff-'||gen_random_uuid()::text||'@example.invalid';
 suspended_id uuid:=gen_random_uuid();suspended_email text:='mhp-suspended-'||gen_random_uuid()::text||'@example.invalid';
 staff_token bytea:=decode(repeat('1173',16),'hex');pp_token bytea:=decode(repeat('1174',16),'hex');
 auth_token bytea:=decode(repeat('1172',16),'hex');a jsonb;denied boolean;n integer;purchase_count bigint;payment_count bigint;
BEGIN
 SELECT count(*) INTO purchase_count FROM app.purchases;
 SELECT count(*) INTO payment_count FROM app_private.mhp_purchase_payments;
 IF (SELECT count(*) FROM app.users u JOIN app.organization_memberships m ON m.user_id=u.id
 WHERE lower(u.email::text) IN('martin.howard1984@gmail.com','office@propertypredator.com') AND m.organization_id='ba41b1a4-9752-4dbf-8312-d04a0f03d0b8' AND m.role='owner' AND m.status='active')<>2 THEN RAISE EXCEPTION 'MHP grants proof: owner identities or roles missing'; END IF;
 IF (SELECT count(*) FROM app_private.mhp_manual_grants g JOIN app.entitlements e ON e.id=g.entitlement_id
 WHERE g.grant_kind='owner_seed' AND e.source='manual' AND e.ends_at IS NULL AND e.purchase_id IS NULL)<>14 THEN RAISE EXCEPTION 'MHP grants proof: fourteen permanent owner product grants missing'; END IF;
 FOR owner_id IN SELECT id FROM app.users WHERE lower(email::text) IN('martin.howard1984@gmail.com','office@propertypredator.com') LOOP
  SET LOCAL ROLE r72_mhp_member_definer;
  a:=app_private.mhp_account_access(owner_id);
  IF NOT(a->>'crm')::boolean OR NOT(a->>'enquirySite')::boolean OR NOT(a->>'emailWritable')::boolean OR NOT(a->>'leadrelay')::boolean OR (a->>'readOnly')::boolean THEN RAISE EXCEPTION 'MHP grants proof: permanent owner Partnership flags missing'; END IF;
  SET LOCAL ROLE r72_owner;
 END LOOP;
 SELECT s.token_hash,s.user_id,s.selected_workspace_id INTO owner_token,owner_id,owner_ws
 FROM app.user_sessions s JOIN app.users u ON u.id=s.user_id
 WHERE lower(u.email::text)='office@propertypredator.com' AND u.status='active' AND u.email_verified_at IS NOT NULL
 AND s.product_audience='martin_howard_property' AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() LIMIT 1;
 IF owner_token IS NULL THEN
  owner_token:=decode(repeat('1171',16),'hex');
  SET LOCAL ROLE r72_identity_command;
  IF NOT app_private.request_mhp_auth_token('office@propertypredator.com','magic',owner_token,owner_token) THEN RAISE EXCEPTION 'MHP grants proof: owner mailbox proof unavailable'; END IF;
  SELECT result.user_id,result.selected_workspace_id INTO owner_id,owner_ws FROM app_private.consume_mhp_auth_token(owner_token,'magic',NULL,owner_token,owner_token,owner_token,NULL) result;
  SET LOCAL ROLE r72_owner;
 END IF;
 SELECT id INTO course FROM app.products WHERE sku='mhp_course';
 SELECT id INTO mentoring FROM app.products WHERE sku='mhp_mentoring';
 SELECT id INTO kit FROM app.products WHERE sku='mhp_kit';
 SET LOCAL ROLE r72_web;
 IF NOT app_private.mhp_is_owner(owner_token) OR jsonb_array_length(app_private.mhp_hq_snapshot(owner_token,NULL)->'products')<>7 THEN RAISE EXCEPTION 'MHP grants proof: owner HQ unavailable'; END IF;
 SET LOCAL ROLE r72_identity_command;
 grant_id:=app_private.mhp_grant_manual_access(owner_token,command,staff_email,'Synthetic staff',mentoring,expiry,'Staff access for the isolated proof');
 again:=app_private.mhp_grant_manual_access(owner_token,command,staff_email,'Synthetic staff',mentoring,expiry,'Staff access for the isolated proof');
 IF again<>grant_id THEN RAISE EXCEPTION 'MHP grants proof: replay created another entitlement'; END IF;
 denied:=false;
 BEGIN PERFORM app_private.mhp_grant_manual_access(owner_token,command,staff_email,'Synthetic staff',mentoring,expiry,'Changed reason'); EXCEPTION WHEN serialization_failure THEN denied:=true; END;
 IF NOT denied THEN RAISE EXCEPTION 'MHP grants proof: command payload changed'; END IF;
 SET LOCAL ROLE r72_owner;
 SELECT id INTO staff_id FROM app.users WHERE email=staff_email;
 IF NOT EXISTS(SELECT 1 FROM app.users WHERE id=staff_id AND status='pending' AND password_hash IS NULL AND email_verified_at IS NULL) THEN RAISE EXCEPTION 'MHP grants proof: manual grant forged login evidence'; END IF;
 IF NOT EXISTS(SELECT 1 FROM app_private.mhp_manual_grants WHERE entitlement_id=grant_id AND command_id=command AND account_id=staff_id AND granted_by_user_id=owner_id AND product_id=mentoring AND target_email=staff_email AND ends_at=expiry AND granted_at=starts_at AND note='Staff access for the isolated proof') THEN RAISE EXCEPTION 'MHP grants proof: immutable grant evidence incomplete'; END IF;
 SET LOCAL ROLE r72_web;
 a:=app_private.mhp_hq_snapshot(owner_token,staff_email);
 IF jsonb_array_length(a->'people')<>1 OR jsonb_array_length(a->'grants')<>1 THEN RAISE EXCEPTION 'MHP grants proof: exact-person search did not scope results'; END IF;
 SET LOCAL ROLE r72_identity_command;
 IF NOT app_private.request_mhp_auth_token(staff_email,'magic',auth_token,staff_token) THEN RAISE EXCEPTION 'MHP grants proof: unpaid staff ineligible for mailbox proof'; END IF;
 SELECT result.user_id,result.selected_workspace_id INTO staff_id,staff_ws FROM app_private.consume_mhp_auth_token(auth_token,'magic',NULL,staff_token,staff_token,staff_token,NULL) result;
 IF staff_id IS NULL OR staff_ws IS NULL THEN RAISE EXCEPTION 'MHP grants proof: unpaid staff first login failed'; END IF;
 SET LOCAL ROLE r72_owner;
 IF NOT EXISTS(SELECT 1 FROM app.users WHERE id=staff_id AND status='active' AND email_verified_at IS NOT NULL AND password_hash IS NULL)
 OR (SELECT count(*) FROM app.investor_businesses WHERE workspace_id=staff_ws)<>1 THEN RAISE EXCEPTION 'MHP grants proof: verified staff workspace not created once'; END IF;
 SET LOCAL ROLE r72_web;
 IF app_private.mhp_is_owner(staff_token) THEN RAISE EXCEPTION 'MHP grants proof: staff gained owner role'; END IF;
 denied:=false;
 BEGIN PERFORM app_private.mhp_hq_snapshot(staff_token,NULL); EXCEPTION WHEN insufficient_privilege THEN denied:=true; END;
 IF NOT denied THEN RAISE EXCEPTION 'MHP grants proof: ordinary member read owner HQ'; END IF;
 SET LOCAL ROLE r72_identity_command;
 denied:=false;
 BEGIN PERFORM app_private.mhp_grant_manual_access(staff_token,gen_random_uuid(),staff_email,'Synthetic staff',course,NULL,'Self upgrade'); EXCEPTION WHEN insufficient_privilege THEN denied:=true; END;
 IF NOT denied THEN RAISE EXCEPTION 'MHP grants proof: staff self-granted access'; END IF;
 SET LOCAL ROLE r72_owner;
 INSERT INTO app.user_sessions(token_hash,csrf_secret_hash,user_id,selected_workspace_id,expires_at,product_audience)
 VALUES(pp_token,pp_token,owner_id,owner_ws,clock_timestamp()+interval '1 hour','property_predator_growth');
 SET LOCAL ROLE r72_web;
 IF app_private.mhp_is_owner(pp_token) THEN RAISE EXCEPTION 'MHP grants proof: PP audience accepted by owner predicate'; END IF;
 SET LOCAL ROLE r72_identity_command;
 denied:=false;
 BEGIN PERFORM app_private.mhp_grant_manual_access(pp_token,gen_random_uuid(),staff_email,'Synthetic staff',course,NULL,'Wrong host audience'); EXCEPTION WHEN insufficient_privilege THEN denied:=true; END;
 IF NOT denied THEN RAISE EXCEPTION 'MHP grants proof: PP audience granted MHP access'; END IF;
 denied:=false;
 BEGIN PERFORM app_private.mhp_grant_manual_access(owner_token,gen_random_uuid(),staff_email,'Synthetic staff',course,clock_timestamp()-interval '1 second','Expired grant'); EXCEPTION WHEN invalid_parameter_value THEN denied:=true; END;
 IF NOT denied THEN RAISE EXCEPTION 'MHP grants proof: already expired grant accepted'; END IF;
 denied:=false;
 BEGIN PERFORM app_private.mhp_grant_manual_access(owner_token,gen_random_uuid(),staff_email,'Synthetic staff',gen_random_uuid(),NULL,'Unknown product'); EXCEPTION WHEN insufficient_privilege THEN denied:=true; END;
 IF NOT denied THEN RAISE EXCEPTION 'MHP grants proof: unknown product accepted'; END IF;
 again:=app_private.mhp_grant_manual_access(owner_token,gen_random_uuid(),staff_email,NULL,kit,NULL,'Existing person needs no repeated name');
 SET LOCAL ROLE r72_owner;
 IF NOT EXISTS(SELECT 1 FROM app.users u JOIN app_private.mhp_manual_grants g ON g.account_id=u.id WHERE g.entitlement_id=again AND u.display_name='Synthetic staff' AND g.target_name=u.display_name) THEN RAISE EXCEPTION 'MHP grants proof: optional name altered canonical person'; END IF;
 SET LOCAL ROLE r72_identity_command;
 again:=app_private.mhp_grant_manual_access(owner_token,gen_random_uuid(),kit_email,NULL,kit,NULL,'Kit-only staff account');
 IF NOT app_private.request_mhp_auth_token(kit_email,'magic',decode(repeat('1176',16),'hex'),staff_token) THEN RAISE EXCEPTION 'MHP grants proof: kit-only manual grantee cannot request login'; END IF;
 SELECT result.user_id,result.selected_workspace_id INTO kit_user,kit_ws FROM app_private.consume_mhp_auth_token(decode(repeat('1176',16),'hex'),'magic',NULL,decode(repeat('1177',16),'hex'),staff_token,staff_token,NULL) result;
 SET LOCAL ROLE r72_owner;
 IF kit_user IS NULL OR kit_ws IS NULL OR EXISTS(SELECT 1 FROM app.investor_businesses WHERE workspace_id=kit_ws) THEN RAISE EXCEPTION 'MHP grants proof: kit-only staff failed account login or gained Desk'; END IF;
 SET LOCAL ROLE r72_owner;
 INSERT INTO app.users(id,email,display_name,status) VALUES(suspended_id,suspended_email,'Suspended fixture','suspended');
 SET LOCAL ROLE r72_identity_command;
 denied:=false;
 BEGIN PERFORM app_private.mhp_grant_manual_access(owner_token,gen_random_uuid(),suspended_email,'Suspended fixture',course,NULL,'Do not reactivate'); EXCEPTION WHEN insufficient_privilege THEN denied:=true; END;
 IF NOT denied OR app_private.request_mhp_auth_token(suspended_email,'magic',decode(repeat('1175',16),'hex'),staff_token) THEN RAISE EXCEPTION 'MHP grants proof: suspended identity admitted'; END IF;
 SET LOCAL ROLE r72_owner;
 denied:=false;
 BEGIN UPDATE app_private.mhp_manual_grants SET note='Changed audit' WHERE entitlement_id=grant_id; EXCEPTION WHEN insufficient_privilege THEN denied:=true; END;
 IF NOT denied THEN RAISE EXCEPTION 'MHP grants proof: audit update accepted'; END IF;
 denied:=false;
 BEGIN DELETE FROM app_private.mhp_manual_grants WHERE entitlement_id=grant_id; EXCEPTION WHEN insufficient_privilege THEN denied:=true; END;
 IF NOT denied THEN RAISE EXCEPTION 'MHP grants proof: audit deletion accepted'; END IF;
 SET LOCAL ROLE r72_mhp_member_definer;
 PERFORM app_private.mhp_set_manual_access(staff_id,true,'course','Legacy programme compatibility');
 PERFORM app_private.mhp_set_manual_access(staff_id,false,'course',NULL);
 PERFORM app_private.mhp_set_manual_access(owner_id,false,'course',NULL);
 SET LOCAL ROLE r72_owner;
 IF NOT EXISTS(SELECT 1 FROM app.entitlements WHERE id=grant_id AND ends_at=expiry) THEN RAISE EXCEPTION 'MHP grants proof: programme command ended independent HQ grant'; END IF;
 IF (SELECT count(*) FROM app_private.mhp_manual_grants g JOIN app.entitlements e ON e.id=g.entitlement_id WHERE g.account_id=owner_id AND g.grant_kind='owner_seed' AND e.ends_at IS NULL)<>7 THEN RAISE EXCEPTION 'MHP grants proof: programme command ended owner grants'; END IF;
 -- Move only this synthetic entitlement's clock window to exercise expiry.
 UPDATE app.entitlements SET starts_at=clock_timestamp()-interval '2 days',ends_at=clock_timestamp()-interval '1 day' WHERE id=grant_id;
 SET LOCAL ROLE r72_web;
 a:=app_private.mhp_member_snapshot(staff_token);
 IF(a->>'crm')::boolean OR (a->>'emailWritable')::boolean OR (a->>'leadrelay')::boolean THEN RAISE EXCEPTION 'MHP grants proof: expired staff product still grants Desk'; END IF;
 denied:=false;
 BEGIN PERFORM 1 FROM app_private.mhp_manual_grants; EXCEPTION WHEN insufficient_privilege THEN denied:=true; END;
 IF NOT denied THEN RAISE EXCEPTION 'MHP grants proof: runtime role read audit table directly'; END IF;
 SET LOCAL ROLE r72_owner;
 IF (SELECT count(*) FROM app.purchases)<>purchase_count OR (SELECT count(*) FROM app_private.mhp_purchase_payments)<>payment_count
 OR EXISTS(SELECT 1 FROM app.entitlements e JOIN app_private.mhp_manual_grants g ON g.entitlement_id=e.id WHERE e.purchase_id IS NOT NULL OR e.source<>'manual') THEN RAISE EXCEPTION 'MHP grants proof: manual grants created paid revenue evidence'; END IF;
END $proof$;
SELECT 'MHP owner and staff manual grants proof' AS proof,31 AS passed,0 AS failed,0 AS skipped;
