-- MHP-DESK-001 isolated proof fixture. ROOT EXECUTION ONLY.
-- Requires migrations 0113..0116 and an outer transaction which MUST ROLLBACK.
-- Set SET LOCAL mhp.proof.enabled='isolated' before embedding this fixture.
-- No real users, outbound email or provider calls. Every fixture uses example.invalid.
DO $guard$ BEGIN
 IF current_setting('mhp.proof.enabled',true) IS DISTINCT FROM 'isolated' THEN RAISE EXCEPTION 'Isolated MHP proof not enabled'; END IF;
END $guard$;
SET LOCAL ROLE r72_owner;
DO $guard$ BEGIN
 IF EXISTS(SELECT 1 FROM app.users WHERE email::text IN ('mhp-auth-fresh@example.invalid','mhp-auth-pending@example.invalid','mhp-auth-suspended@example.invalid'))
 THEN RAISE EXCEPTION 'Synthetic MHP auth proof fixtures already exist; require a fresh rollback transaction'; END IF;
END $guard$;
INSERT INTO app.users(id,email,status,password_hash)
VALUES ('ed115000-0000-4000-8000-000000000001','mhp-auth-pending@example.invalid','pending','scrypt$v1$isolated-proof-hash-not-a-real-password'),
 ('ed115000-0000-4000-8000-000000000002','mhp-auth-suspended@example.invalid','suspended',NULL);
INSERT INTO app.purchases(organization_id,product_id,stripe_account_id,stripe_session_id,stripe_customer_id,buyer_email,livemode,status,first_paid_at,last_snapshot_at)
SELECT p.organization_id,p.id,'acct_MhpAuthProof','cs_test_mhp_auth_'||v.label,'cus_MhpAuth'||v.label,v.email,false,'paid',clock_timestamp(),clock_timestamp()
FROM app.products p CROSS JOIN (VALUES
 ('Fresh','mhp-auth-fresh@example.invalid'),('Pending','mhp-auth-pending@example.invalid'),('Suspended','mhp-auth-suspended@example.invalid')) v(label,email)
WHERE p.sku='mhp_course';
DO $privileges$ BEGIN
 IF has_function_privilege('r72_identity_command','app_private.issue_mhp_session(uuid,bytea,bytea,bytea,bytea)','EXECUTE')
  OR has_table_privilege('r72_identity_command','app_private.mhp_auth_tokens','SELECT,INSERT,UPDATE,DELETE')
  OR has_table_privilege('r72_identity_command','app.users','INSERT,UPDATE,DELETE') THEN RAISE EXCEPTION 'MHP auth runtime privilege widened'; END IF;
 IF has_schema_privilege('r72_mhp_auth_definer','app_private','CREATE')
  OR has_schema_privilege('r72_security_definer','app_private','CREATE') THEN RAISE EXCEPTION 'Temporary schema CREATE was not revoked'; END IF;
 IF EXISTS(SELECT 1 FROM app.users WHERE email::text='mhp-auth-fresh@example.invalid') THEN RAISE EXCEPTION 'Purchase alone created an identity'; END IF;
END $privileges$;

SET LOCAL ROLE r72_identity_command;
DO $first_login$
DECLARE u uuid; w uuid;
BEGIN
 IF NOT app_private.request_mhp_auth_token('mhp-auth-fresh@example.invalid','magic',decode(repeat('11',32),'hex'),decode(repeat('01',32),'hex'))
 THEN RAISE EXCEPTION 'Eligible member did not receive a proof token'; END IF;
 IF (SELECT count(*) FROM app_private.consume_mhp_auth_token(decode(repeat('11',32),'hex'),'reset','scrypt$v1$isolated-proof-hash-not-a-real-password',decode(repeat('21',32),'hex'),decode(repeat('31',32),'hex'),decode(repeat('01',32),'hex'),NULL))<>0
 THEN RAISE EXCEPTION 'Wrong-purpose token accepted'; END IF;
 SELECT user_id,selected_workspace_id INTO u,w FROM app_private.consume_mhp_auth_token(decode(repeat('11',32),'hex'),'magic',NULL,decode(repeat('21',32),'hex'),decode(repeat('31',32),'hex'),decode(repeat('01',32),'hex'),NULL);
 IF u IS NULL OR w IS NULL THEN RAISE EXCEPTION 'Verified first login did not produce an account session'; END IF;
 PERFORM set_config('mhp.proof.user_id',u::text,true); PERFORM set_config('mhp.proof.workspace_id',w::text,true);
 IF (SELECT count(*) FROM app_private.consume_mhp_auth_token(decode(repeat('11',32),'hex'),'magic',NULL,decode(repeat('22',32),'hex'),decode(repeat('32',32),'hex'),decode(repeat('01',32),'hex'),NULL))<>0
 THEN RAISE EXCEPTION 'Consumed token replay accepted'; END IF;
 IF app_private.request_mhp_auth_token('mhp-auth-unknown@example.invalid','magic',decode(repeat('12',32),'hex'),decode(repeat('01',32),'hex'))
 THEN RAISE EXCEPTION 'Unknown email became eligible'; END IF;
 IF app_private.request_mhp_auth_token('mhp-auth-suspended@example.invalid','magic',decode(repeat('13',32),'hex'),decode(repeat('01',32),'hex'))
 THEN RAISE EXCEPTION 'Suspended user received an auth token'; END IF;
END $first_login$;
SET LOCAL ROLE r72_web;
DO $audience$ BEGIN
 IF (SELECT count(*) FROM app_private.resolve_mhp_session(decode(repeat('21',32),'hex')))<>1 THEN RAISE EXCEPTION 'MHP session failed MHP resolution'; END IF;
 IF (SELECT count(*) FROM app_private.resolve_portal_session(decode(repeat('21',32),'hex')))<>0 THEN RAISE EXCEPTION 'Copied MHP token authenticated on PP'; END IF;
END $audience$;

SET LOCAL ROLE r72_owner;
DO $bound_identity$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM app.users WHERE id=current_setting('mhp.proof.user_id')::uuid AND status='active' AND email_verified_at IS NOT NULL)
 THEN RAISE EXCEPTION 'Email proof did not establish verified canonical identity'; END IF;
 IF NOT EXISTS(SELECT 1 FROM app.purchases WHERE buyer_email='mhp-auth-fresh@example.invalid' AND account_id=current_setting('mhp.proof.user_id')::uuid)
 THEN RAISE EXCEPTION 'Verified purchase was not bound'; END IF;
END $bound_identity$;
INSERT INTO app.organizations(id,name,slug,kind) VALUES('ed115000-0000-4000-8000-000000000010','Isolated PP auth proof','isolated-pp-auth-proof','direct_customer');
INSERT INTO app.workspaces(id,organization_id,name,slug) VALUES('ed115000-0000-4000-8000-000000000011','ed115000-0000-4000-8000-000000000010','Isolated PP workspace','isolated-pp-workspace');
INSERT INTO app.organization_memberships(organization_id,user_id,role,status) VALUES('ed115000-0000-4000-8000-000000000010',current_setting('mhp.proof.user_id')::uuid,'owner','active');
INSERT INTO app.workspace_memberships(workspace_id,organization_id,user_id,role,status) VALUES('ed115000-0000-4000-8000-000000000011','ed115000-0000-4000-8000-000000000010',current_setting('mhp.proof.user_id')::uuid,'owner','active');
INSERT INTO app.user_sessions(token_hash,csrf_secret_hash,user_id,selected_workspace_id,expires_at)
VALUES(decode(repeat('41',32),'hex'),decode(repeat('42',32),'hex'),current_setting('mhp.proof.user_id')::uuid,'ed115000-0000-4000-8000-000000000011',clock_timestamp()+interval '1 day');
-- A legacy/default-PP audience must not make an MHP workspace a PP session.
INSERT INTO app.user_sessions(token_hash,csrf_secret_hash,user_id,selected_workspace_id,expires_at)
VALUES(decode(repeat('a3',32),'hex'),decode(repeat('a4',32),'hex'),current_setting('mhp.proof.user_id')::uuid,current_setting('mhp.proof.workspace_id')::uuid,clock_timestamp()+interval '1 day');
SET LOCAL ROLE r72_identity_command;
DO $shared_user_sso$
DECLARE w uuid;
BEGIN
 SELECT selected_workspace_id INTO w FROM app_private.create_portal_external_identity_session(
  'https://propertypredator.com','ed115000-0000-4000-8000-000000000020','mhp-auth-fresh@example.invalid',true,
  current_setting('mhp.proof.user_id')::uuid,false,NULL,NULL,NULL,NULL,NULL,
  decode(repeat('a1',32),'hex'),decode(repeat('a2',32),'hex'),decode(repeat('01',32),'hex'),NULL);
 IF w IS DISTINCT FROM 'ed115000-0000-4000-8000-000000000011'::uuid THEN RAISE EXCEPTION 'PP SSO selected an MHP workspace'; END IF;
END $shared_user_sso$;
SET LOCAL ROLE r72_web;
DO $existing_pp$ BEGIN
 IF (SELECT count(*) FROM app_private.resolve_portal_session(decode(repeat('41',32),'hex')))<>1 THEN RAISE EXCEPTION 'Existing default PP session regressed'; END IF;
 IF (SELECT count(*) FROM app_private.resolve_mhp_session(decode(repeat('41',32),'hex')))<>0 THEN RAISE EXCEPTION 'Copied PP token authenticated on MHP'; END IF;
 IF (SELECT count(*) FROM app_private.resolve_portal_session(decode(repeat('a3',32),'hex')))<>0 THEN RAISE EXCEPTION 'PP audience admitted an MHP-mapped workspace'; END IF;
END $existing_pp$;

SET LOCAL ROLE r72_identity_command;
DO $reset$ BEGIN
 IF NOT app_private.request_mhp_auth_token('mhp-auth-fresh@example.invalid','reset',decode(repeat('51',32),'hex'),decode(repeat('01',32),'hex')) THEN RAISE EXCEPTION 'Reset token was not issued'; END IF;
 IF (SELECT count(*) FROM app_private.consume_mhp_auth_token(decode(repeat('51',32),'hex'),'reset','scrypt$v1$isolated-proof-hash-not-a-real-password',decode(repeat('61',32),'hex'),decode(repeat('62',32),'hex'),decode(repeat('01',32),'hex'),NULL))<>1 THEN RAISE EXCEPTION 'Reset did not complete'; END IF;
 IF NOT app_private.request_mhp_auth_token('mhp-auth-fresh@example.invalid','magic',decode(repeat('71',32),'hex'),decode(repeat('01',32),'hex')) THEN RAISE EXCEPTION 'Expiry proof token was not issued'; END IF;
 IF app_private.request_mhp_auth_token('mhp-auth-fresh@example.invalid','magic',decode(repeat('72',32),'hex'),decode(repeat('01',32),'hex')) THEN RAISE EXCEPTION 'Per-email token issue cap not enforced'; END IF;
END $reset$;
SET LOCAL ROLE r72_web;
DO $revocation$ BEGIN
 IF (SELECT count(*) FROM app_private.resolve_mhp_session(decode(repeat('21',32),'hex')))<>0 THEN RAISE EXCEPTION 'Reset retained old MHP session'; END IF;
 IF (SELECT count(*) FROM app_private.resolve_portal_session(decode(repeat('41',32),'hex')))<>0 THEN RAISE EXCEPTION 'Reset retained old PP session'; END IF;
 IF (SELECT count(*) FROM app_private.resolve_mhp_session(decode(repeat('61',32),'hex')))<>1 THEN RAISE EXCEPTION 'Reset did not issue a fresh MHP session'; END IF;
END $revocation$;
SET LOCAL ROLE r72_owner;
UPDATE app_private.mhp_auth_tokens SET created_at=clock_timestamp()-interval '1 hour',expires_at=clock_timestamp()-interval '30 minutes' WHERE token_hash=decode(repeat('71',32),'hex');
INSERT INTO app_private.mhp_auth_tokens(token_hash,email,purpose,requested_source_hash,expires_at)
VALUES(decode(repeat('81',32),'hex'),'mhp-auth-suspended@example.invalid','magic',decode(repeat('01',32),'hex'),clock_timestamp()+interval '15 minutes');
SET LOCAL ROLE r72_identity_command;
DO $expired_and_pending$ BEGIN
 IF (SELECT count(*) FROM app_private.consume_mhp_auth_token(decode(repeat('71',32),'hex'),'magic',NULL,decode(repeat('73',32),'hex'),decode(repeat('74',32),'hex'),decode(repeat('01',32),'hex'),NULL))<>0 THEN RAISE EXCEPTION 'Expired token accepted'; END IF;
 IF (SELECT count(*) FROM app_private.consume_mhp_auth_token(decode(repeat('81',32),'hex'),'magic',NULL,decode(repeat('82',32),'hex'),decode(repeat('83',32),'hex'),decode(repeat('01',32),'hex'),NULL))<>0 THEN RAISE EXCEPTION 'Suspended user reactivated'; END IF;
 IF NOT app_private.request_mhp_auth_token('mhp-auth-pending@example.invalid','magic',decode(repeat('91',32),'hex'),decode(repeat('01',32),'hex')) THEN RAISE EXCEPTION 'Pending eligible member could not request ownership proof'; END IF;
 IF (SELECT count(*) FROM app_private.consume_mhp_auth_token(decode(repeat('91',32),'hex'),'magic',NULL,decode(repeat('92',32),'hex'),decode(repeat('93',32),'hex'),decode(repeat('01',32),'hex'),NULL))<>1 THEN RAISE EXCEPTION 'Verified pending member did not activate'; END IF;
 IF (SELECT count(*) FROM app_private.portal_login_credential('mhp-auth-pending@example.invalid'))<>0 THEN RAISE EXCEPTION 'PP password login selected an MHP-only workspace'; END IF;
END $expired_and_pending$;
SET LOCAL ROLE r72_owner;
DO $final_state$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM app.users WHERE id='ed115000-0000-4000-8000-000000000001' AND status='active' AND email_verified_at IS NOT NULL) THEN RAISE EXCEPTION 'Pending transition missing'; END IF;
 IF NOT EXISTS(SELECT 1 FROM app.users WHERE id='ed115000-0000-4000-8000-000000000002' AND status='suspended' AND email_verified_at IS NULL) THEN RAISE EXCEPTION 'Suspension mutated'; END IF;
END $final_state$;
SELECT 'mhp-auth-isolated-proof-complete; caller must rollback' AS proof_result;
