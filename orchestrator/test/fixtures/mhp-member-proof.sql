-- Run only inside the isolated 0113-0116 rehearsal transaction; caller ROLLBACKs.
-- Members/contacts are synthetic. Founder identities exercise the real token
-- consume boundary only in this rolled-back branch; no email is sent.
SET LOCAL ROLE r72_owner;
DO $proof$
DECLARE
 org uuid:=gen_random_uuid(); ua uuid:=gen_random_uuid(); ub uuid:=gen_random_uuid(); unverified uuid:=gen_random_uuid();
 wa uuid:=gen_random_uuid(); wb uuid:=gen_random_uuid(); ppws uuid:=gen_random_uuid(); again uuid; overlap_course uuid:=gen_random_uuid();
 admin uuid; adminws uuid; coadmin uuid; coadminws uuid; a jsonb; denied boolean; n integer; v bigint;
 ta bytea:=decode(repeat('a101',16),'hex'); tb bytea:=decode(repeat('b202',16),'hex');
 tp bytea:=decode(repeat('c303',16),'hex'); tm bytea:=decode(repeat('d404',16),'hex'); rotated bytea:=decode(repeat('e505',16),'hex'); tc bytea:=decode(repeat('f606',16),'hex');
 emaila text:='mhp-member-a-'||gen_random_uuid()::text||'@example.invalid';
 emailb text:='mhp-member-b-'||gen_random_uuid()::text||'@example.invalid';
 mhpslug text:='mhp-proof-'||left(replace(gen_random_uuid()::text,'-',''),20);
 ppslug text:='pp-proof-'||left(replace(gen_random_uuid()::text,'-',''),20);
BEGIN
 INSERT INTO app.organizations(id,name,slug,kind) VALUES(org,'MHP member proof','mhp-proof-'||org::text,'direct_customer');
 INSERT INTO app.users(id,email,display_name,status,email_verified_at) VALUES(ua,emaila,'Synthetic A','active',clock_timestamp()),(ub,emailb,'Synthetic B','active',clock_timestamp()),(unverified,'unverified-'||unverified::text||'@example.invalid','Unverified','active',NULL);
 INSERT INTO app.workspaces(id,organization_id,name,slug) VALUES(wa,org,'Synthetic A','a-'||wa::text),(wb,org,'Synthetic B','b-'||wb::text),(ppws,org,'Synthetic PP','pp-'||ppws::text);
 INSERT INTO app_private.mhp_members(workspace_id,user_id,owner_email,manual_tier,manual_reference,manual_active)
 VALUES(wa,ua,emaila,'course','synthetic-course-a',true),(wb,ub,emailb,'course','synthetic-course-b',true);

 SET LOCAL ROLE r72_mhp_auth_definer;
 again:=app_private.ensure_mhp_member_workspace(ua);
 IF again<>wa OR app_private.ensure_mhp_member_workspace(ua)<>wa THEN RAISE EXCEPTION 'MHP proof: first-login workspace is not idempotent'; END IF;
 PERFORM app_private.ensure_mhp_member_workspace(ub);
 denied:=false;
 BEGIN PERFORM app_private.ensure_mhp_member_workspace(unverified); EXCEPTION WHEN insufficient_privilege THEN denied:=true; END;
 IF NOT denied THEN RAISE EXCEPTION 'MHP proof: unverified identity gained membership'; END IF;
 SET LOCAL ROLE r72_owner;
 SELECT count(*) INTO n FROM app.investor_businesses WHERE workspace_id=wa;
 IF n<>1 OR (SELECT count(*) FROM app.pipelines WHERE workspace_id=wa)<>1 THEN RAISE EXCEPTION 'MHP proof: duplicate business or pipeline'; END IF;
 INSERT INTO app.workspace_memberships(workspace_id,organization_id,user_id,role,status) VALUES(ppws,org,ua,'owner','active');
 INSERT INTO app.user_sessions(token_hash,csrf_secret_hash,user_id,selected_workspace_id,expires_at,product_audience)
 VALUES(ta,ta,ua,wa,clock_timestamp()+interval '1 hour','martin_howard_property'),(tb,tb,ub,wb,clock_timestamp()+interval '1 hour','martin_howard_property'),(tp,tp,ua,ppws,clock_timestamp()+interval '1 hour','property_predator_growth');

 SET LOCAL ROLE r72_web;
 a:=app_private.mhp_member_snapshot(ta);
 IF NOT(a->>'crm')::boolean OR (a->>'emailWorkflow')::boolean OR (a->>'leadrelay')::boolean THEN RAISE EXCEPTION 'MHP proof: course access mapping failed'; END IF;
 IF app_private.has_active_workspace_membership(ua,wb) THEN RAISE EXCEPTION 'MHP proof: foreign member access'; END IF;
 SET LOCAL ROLE r72_identity_command;
 denied:=false;
 BEGIN PERFORM app_private.switch_investor_workspace(ta,wb,rotated,rotated); EXCEPTION WHEN insufficient_privilege THEN denied:=true; END;
 IF NOT denied THEN RAISE EXCEPTION 'MHP proof: cross-member switch succeeded'; END IF;
 denied:=false;
 BEGIN PERFORM app_private.switch_investor_workspace(ta,ppws,rotated,rotated); EXCEPTION WHEN insufficient_privilege THEN denied:=true; END;
 IF NOT denied THEN RAISE EXCEPTION 'MHP proof: cross-brand switch succeeded'; END IF;
 SET LOCAL ROLE r72_owner;

 -- A previously unverified active PP founder must confirm mailbox ownership
 -- through the MHP magic-link boundary, never an ad-hoc account update.
 SET LOCAL ROLE r72_identity_command;
 IF NOT app_private.request_mhp_auth_token('office@propertypredator.com','magic',decode(repeat('d405',16),'hex'),tm) THEN RAISE EXCEPTION 'MHP proof: founder magic token unavailable'; END IF;
 SELECT result.user_id,result.selected_workspace_id INTO admin,adminws FROM app_private.consume_mhp_auth_token(decode(repeat('d405',16),'hex'),'magic',NULL,tm,tm,tm,NULL) result;
 IF admin IS NULL OR adminws IS NULL THEN RAISE EXCEPTION 'MHP proof: verified founder fixture unavailable'; END IF;
 SET LOCAL ROLE r72_owner;
 SELECT row_version INTO v FROM app.investor_businesses WHERE workspace_id=wa;
 SET LOCAL ROLE r72_identity_command;
 denied:=false;
 BEGIN PERFORM app_private.set_mhp_investor_access(tb,wa,v,'active','forged-admin','mentoring'); EXCEPTION WHEN insufficient_privilege THEN denied:=true; END;
 IF NOT denied THEN RAISE EXCEPTION 'MHP proof: ordinary member granted paid access'; END IF;
 PERFORM app_private.set_mhp_investor_access(tm,wa,v,'active','synthetic-mentoring','mentoring');
 SET LOCAL ROLE r72_web;
 a:=app_private.mhp_member_snapshot(ta);
 IF NOT(a->>'emailWorkflow')::boolean OR NOT(a->>'leadrelay')::boolean THEN RAISE EXCEPTION 'MHP proof: manual mentoring access missing'; END IF;
 SET LOCAL ROLE r72_owner;
 SET LOCAL ROLE r72_identity_command;
 IF NOT app_private.request_mhp_auth_token('martin.howard1984@gmail.com','magic',decode(repeat('f607',16),'hex'),tc) THEN RAISE EXCEPTION 'MHP proof: second founder magic token unavailable'; END IF;
 SELECT result.user_id,result.selected_workspace_id INTO coadmin,coadminws FROM app_private.consume_mhp_auth_token(decode(repeat('f607',16),'hex'),'magic',NULL,tc,tc,tc,NULL) result;
 IF coadmin IS NULL OR coadmin=admin OR coadminws IS NULL THEN RAISE EXCEPTION 'MHP proof: second verified founder fixture unavailable'; END IF;
 SET LOCAL ROLE r72_owner;
 UPDATE app.investor_businesses SET administrator_user_id=admin WHERE workspace_id=wa;
 SELECT row_version INTO v FROM app.investor_businesses WHERE workspace_id=wa;
 SET LOCAL ROLE r72_identity_command;
 PERFORM app_private.update_investor_business(tc,wa,v,'Co-admin edit','#E8A33D','','');
 SET LOCAL ROLE r72_owner;
 IF NOT EXISTS(SELECT 1 FROM app.investor_businesses WHERE workspace_id=wa AND brand_name='Co-admin edit' AND administrator_user_id=admin) THEN RAISE EXCEPTION 'MHP proof: co-admin programme branding failed'; END IF;
 INSERT INTO app.investor_sites(workspace_id,slug,headline,introduction,contact_email,privacy_url,published)
 VALUES(wa,mhpslug,'Synthetic MHP','Synthetic member site',emaila,'https://example.invalid/privacy',true);
 INSERT INTO app.investor_businesses(workspace_id,administrator_user_id,owner_user_id,owner_email,owner_name,brand_name,access_state,creation_key,creation_hash)
 VALUES(ppws,ua,ua,emaila,'Synthetic PP','Synthetic PP','test',gen_random_uuid(),ta);
 INSERT INTO app.investor_sites(workspace_id,slug,headline,introduction,contact_email,privacy_url,published)
 VALUES(ppws,ppslug,'Synthetic PP','Synthetic PP site',emaila,'https://example.invalid/privacy',true);
 SET LOCAL ROLE r72_web;
 IF app_private.public_mhp_investor_site(mhpslug) IS NULL OR app_private.public_investor_site(mhpslug) IS NOT NULL
 OR app_private.public_investor_site(ppslug) IS NULL OR app_private.public_mhp_investor_site(ppslug) IS NOT NULL THEN RAISE EXCEPTION 'MHP proof: public site brand boundary'; END IF;
 SET LOCAL ROLE r72_identity_command;
 denied:=false;
 BEGIN PERFORM app_private.capture_investor_site_enquiry(mhpslug,rotated,'Test','test@example.invalid','Test enquiry'); EXCEPTION WHEN insufficient_privilege THEN denied:=true; END;
 IF NOT denied THEN RAISE EXCEPTION 'MHP proof: PP endpoint captured MHP enquiry'; END IF;
 PERFORM app_private.capture_mhp_investor_site_enquiry(mhpslug,rotated,'Test','test@example.invalid','Test enquiry');
 SET LOCAL ROLE r72_owner;
 SELECT count(*) INTO n FROM app.contacts WHERE workspace_id=wa AND source='investor_site';
 IF n<>1 THEN RAISE EXCEPTION 'MHP proof: own-brand enquiry not captured once'; END IF;

 -- A refunded entitlement remains readable and blocks every canonical write.
 UPDATE app.entitlements SET starts_at=clock_timestamp()-interval '2 days',ends_at=clock_timestamp()-interval '1 hour',read_only_until=clock_timestamp()+interval '7 days'
 WHERE account_id=ua AND source='manual';
 SET LOCAL ROLE r72_web;
 a:=app_private.mhp_member_snapshot(ta);
 IF NOT(a->>'crm')::boolean OR NOT(a->>'readOnly')::boolean OR app_private.can_write_workspace(ua,wa) OR app_private.can_manage_workspace(ua,wa) THEN RAISE EXCEPTION 'MHP proof: read-only grace not enforced'; END IF;
 IF app_private.investor_email_snapshot(ta,NULL) IS NULL THEN RAISE EXCEPTION 'MHP proof: saved email unavailable during read-only grace'; END IF;
 IF app_private.public_mhp_investor_site(mhpslug) IS NOT NULL THEN RAISE EXCEPTION 'MHP proof: refunded public site still open'; END IF;
 SET LOCAL ROLE r72_identity_command;
 denied:=false;
 BEGIN PERFORM app_private.capture_mhp_investor_site_enquiry(mhpslug,ta,'Test','test@example.invalid','Test after refund'); EXCEPTION WHEN insufficient_privilege THEN denied:=true; END;
 IF NOT denied THEN RAISE EXCEPTION 'MHP proof: refunded site captured enquiry'; END IF;
 denied:=false;
 BEGIN PERFORM app_private.investor_mail_secret(ta); EXCEPTION WHEN insufficient_privilege THEN denied:=true; END;
 IF NOT denied THEN RAISE EXCEPTION 'MHP proof: read-only member retrieved mailbox credentials'; END IF;
 denied:=false;
 BEGIN PERFORM app_private.claim_investor_email(ta,gen_random_uuid(),1,ta,ta,'send_approved_message'); EXCEPTION WHEN insufficient_privilege THEN denied:=true; END;
 IF NOT denied THEN RAISE EXCEPTION 'MHP proof: read-only member claimed email dispatch'; END IF;
 SET LOCAL ROLE r72_owner;
 -- A separately active course restores CRM writes, never refunded mentoring email writes.
 INSERT INTO app.entitlements(id,account_id,product_id,grants,starts_at,source,source_reference)
 SELECT overlap_course,ua,id,grants,clock_timestamp()-interval '1 hour','bonus','synthetic-overlap-course'
 FROM app.products WHERE brand='martin_howard_property' AND sku='mhp_course';
 SET LOCAL ROLE r72_web;
 a:=app_private.mhp_member_snapshot(ta);
 IF NOT(a->>'crm')::boolean OR (a->>'readOnly')::boolean OR NOT(a->>'emailWorkflow')::boolean OR (a->>'emailWritable')::boolean
 OR NOT app_private.can_write_workspace(ua,wa) OR NOT app_private.can_manage_workspace(ua,wa) THEN RAISE EXCEPTION 'MHP proof: overlapping course and refunded mentoring authority incorrect'; END IF;
 IF app_private.investor_email_snapshot(ta,NULL) IS NULL THEN RAISE EXCEPTION 'MHP proof: overlapping email grace hid saved conversations'; END IF;
 PERFORM app_private.investor_mail_snapshot(ta);
 SET LOCAL ROLE r72_identity_command;
 denied:=false;
 BEGIN PERFORM app_private.save_investor_mail_connection(ta,0,'smtp',emaila,'{}'::jsonb,'synthetic-sealed'); EXCEPTION WHEN insufficient_privilege THEN denied:=true; END;
 IF NOT denied THEN RAISE EXCEPTION 'MHP proof: active course permitted refunded mentoring mailbox changes'; END IF;
 denied:=false;
 BEGIN PERFORM app_private.claim_investor_email(ta,gen_random_uuid(),1,ta,ta,'send_approved_message'); EXCEPTION WHEN insufficient_privilege THEN denied:=true; END;
 IF NOT denied THEN RAISE EXCEPTION 'MHP proof: active course permitted refunded mentoring dispatch'; END IF;
 SET LOCAL ROLE r72_owner;
 DELETE FROM app.entitlements WHERE id=overlap_course;
 UPDATE app.entitlements SET read_only_until=clock_timestamp()-interval '1 minute' WHERE account_id=ua AND source='manual';
 SET LOCAL ROLE r72_web;
 a:=app_private.mhp_member_snapshot(ta);
 IF(a->>'crm')::boolean THEN RAISE EXCEPTION 'MHP proof: expired grace retained Desk access'; END IF;
 IF NOT app_private.can_write_workspace(ua,ppws) THEN RAISE EXCEPTION 'MHP proof: unrelated PP workspace disabled'; END IF;
 SET LOCAL ROLE r72_identity_command;
 PERFORM app_private.switch_investor_workspace(tm,wb,rotated,rotated);
 SET LOCAL ROLE r72_owner;
 IF NOT EXISTS(SELECT 1 FROM app.user_sessions WHERE token_hash=rotated AND product_audience='martin_howard_property' AND selected_workspace_id=wb AND user_id=admin) THEN RAISE EXCEPTION 'MHP proof: MHP switch lost its audience'; END IF;
END $proof$;
SELECT 'MHP member proof' AS proof,30 AS passed,0 AS failed,0 AS skipped;
