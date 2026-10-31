-- GHQ-WEBINAR-005A. ROOT ONLY: exact125 disposable clone +0126 in one rollback transaction.
-- Synthetic rows/hashes/provider references; this file never calls a provider.
DO $guard$ BEGIN
 IF current_setting('mhp.proof.enabled',true) IS DISTINCT FROM 'isolated' THEN RAISE EXCEPTION 'Isolated MHP proof not enabled'; END IF;
END $guard$;
SET LOCAL ROLE r72_owner;
DO $seed$
DECLARE actor uuid; personal uuid; n integer; prospect uuid; step text;
BEGIN
 SELECT u.id,m.workspace_id INTO actor,personal FROM app.users u
 JOIN app_private.investor_programme_admins a ON a.user_id=u.id
 JOIN app_private.mhp_members m ON m.user_id=u.id
 JOIN app.organization_memberships om ON om.user_id=u.id AND om.organization_id='ba41b1a4-9752-4dbf-8312-d04a0f03d0b8'
  AND om.role='owner' AND om.status='active' AND om.revoked_at IS NULL
 JOIN app.workspace_memberships wm ON wm.user_id=u.id AND wm.workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b'
  AND wm.role='owner' AND wm.status='active' AND wm.revoked_at IS NULL
 WHERE lower(u.email::text)='martin.howard1984@gmail.com' AND u.status='active' AND u.email_verified_at IS NOT NULL;
 IF actor IS NULL OR personal IS NULL THEN RAISE EXCEPTION 'Cloned accepted owner/brand required'; END IF;
 IF EXISTS(SELECT 1 FROM app.company_content_items WHERE id='ed126300-0000-4000-8000-000000000001')
  OR EXISTS(SELECT 1 FROM app_private.mhp_prospects WHERE id='ed126000-0000-4000-8000-000000000001')
 THEN RAISE EXCEPTION 'Fresh disposable editor fixtures required'; END IF;
 PERFORM set_config('mhp.editor.actor',actor::text,true);
 PERFORM set_config('app.user_id',actor::text,true);
 PERFORM set_config('app.workspace_id','2789228d-55a6-4688-b1e8-2f70abca990b',true);
 PERFORM set_config('app.actor_kind','user',true);PERFORM set_config('app.request_id','isolated-ghq005-editor',true);
 PERFORM set_config('mhp.editor.crm_count',(SELECT count(*)::text FROM app.opportunities),true);
 INSERT INTO app.users(id,email,display_name,status,email_verified_at)
 VALUES('ed126900-0000-4000-8000-000000000001','editor-member@example.invalid','Synthetic ordinary member','active',clock_timestamp());
 INSERT INTO app.organization_memberships(organization_id,user_id,role,status)
 VALUES('ba41b1a4-9752-4dbf-8312-d04a0f03d0b8','ed126900-0000-4000-8000-000000000001','billing','active');
 INSERT INTO app.workspace_memberships(workspace_id,organization_id,user_id,role,status)
 VALUES('2789228d-55a6-4688-b1e8-2f70abca990b','ba41b1a4-9752-4dbf-8312-d04a0f03d0b8','ed126900-0000-4000-8000-000000000001','owner','active');
 FOR n IN 1..7 LOOP
  prospect:=('ed126000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;
  INSERT INTO app_private.mhp_prospects(id,email,first_name,marketing_consent,consent_version,consent_at,unsubscribed_at)
  VALUES(prospect,'editor-'||n||'@example.invalid','Synthetic '||n,n<>3,'isolated-editor-v1',clock_timestamp(),CASE WHEN n=2 THEN clock_timestamp() END);
  INSERT INTO app_private.mhp_prospect_signups(prospect_id,kind,label,link,consent_given,consent_version,created_at)
  VALUES(prospect,'webinar','Synthetic owner webinar','https://martinhowardproperty.co.uk/webinar/',n<>4,'isolated-editor-v1',clock_timestamp()-interval '2 minutes');
  FOREACH step IN ARRAY CASE WHEN n=1 THEN ARRAY['webinar_confirm','webinar_24h','webinar_1h','webinar_replay','webinar_followup'] ELSE ARRAY['webinar_confirm'] END LOOP
   INSERT INTO app_private.mhp_marketing_sends(prospect_id,template_key,campaign_key,context,due_at,expires_at,created_at)
   VALUES(prospect,step,CASE WHEN n=5 THEN 'webinar-ghq005-other' ELSE 'webinar-ghq005-proof' END,'{}',clock_timestamp()-interval '1 minute',clock_timestamp()+interval '1 day',clock_timestamp()-interval '1 minute');
  END LOOP;
 END LOOP;
 INSERT INTO app.user_sessions(token_hash,csrf_secret_hash,user_id,selected_workspace_id,expires_at,product_audience,revoked_at,created_at)
 SELECT public.digest(label,'sha256'),public.digest(label||'-csrf','sha256'),CASE WHEN label='editor-member' THEN 'ed126900-0000-4000-8000-000000000001'::uuid ELSE actor END,
  CASE WHEN label='editor-personal' THEN personal ELSE '2789228d-55a6-4688-b1e8-2f70abca990b'::uuid END,
  clock_timestamp()+CASE WHEN label='editor-expired' THEN interval '-1 minute' ELSE interval '1 hour' END,
  CASE WHEN label='editor-foreign' THEN 'property_predator_growth' ELSE 'martin_howard_property' END,
  CASE WHEN label='editor-revoked' THEN clock_timestamp() END,clock_timestamp()-interval '2 hours'
 FROM(VALUES('editor-owner'),('editor-owner-b'),('editor-personal'),('editor-member'),('editor-foreign'),('editor-expired'),('editor-revoked')) t(label);
END $seed$;

DO $grants$ BEGIN
 IF has_table_privilege('r72_web','app_private.mhp_owner_email_dispatch_proofs','SELECT,INSERT,UPDATE,DELETE')
  OR has_table_privilege('r72_identity_command','app_private.mhp_marketing_sends','SELECT,INSERT,UPDATE,DELETE')
  OR has_table_privilege('r72_identity_command','app.company_content_versions','SELECT,INSERT,UPDATE,DELETE')
  OR has_function_privilege('r72_web','app_private.mhp_prepare_owner_marketing_send(uuid,uuid)','EXECUTE')
  OR has_function_privilege('r72_identity_command','app_private.mhp_owner_email_exact(uuid,boolean,boolean,boolean)','EXECUTE')
  OR NOT has_function_privilege('r72_identity_command','app_private.mhp_prepare_owner_marketing_send(uuid,uuid)','EXECUTE')
  OR NOT has_function_privilege('r72_mhp_prospect_definer','app_private.lock_active_portal_session(bytea,uuid,uuid)','EXECUTE')
  OR has_schema_privilege('r72_mhp_prospect_definer','app_private','CREATE')
 THEN RAISE EXCEPTION 'Owner email capability boundary failed'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='app_private' AND c.relname='mhp_owner_email_dispatch_proofs' AND c.relrowsecurity AND c.relforcerowsecurity)
  OR NOT EXISTS(SELECT 1 FROM app_private.workspace_table_registry WHERE schema_name='app_private' AND table_name='mhp_owner_email_dispatch_proofs' AND workspace_column='workspace_id')
 THEN RAISE EXCEPTION 'Proof forced RLS/registry missing'; END IF;
 IF EXISTS(SELECT 1 FROM pg_proc p,aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) acl
  WHERE p.pronamespace='app_private'::regnamespace AND (p.proname LIKE 'mhp_owner_email_%' OR p.proname LIKE 'mhp_%owner_marketing%')
   AND acl.grantee=0 AND acl.privilege_type='EXECUTE') THEN RAISE EXCEPTION 'PUBLIC owner email capability'; END IF;
END $grants$;

SET LOCAL ROLE r72_web;
DO $native$
DECLARE bad text; snapshot jsonb;
BEGIN
 FOREACH bad IN ARRAY ARRAY['editor-personal','editor-member','editor-foreign','editor-expired','editor-revoked','editor-missing'] LOOP
  BEGIN PERFORM app_private.mhp_owner_email_snapshot(public.digest(bad,'sha256'),'webinar-ghq005-proof');
   RAISE EXCEPTION 'Rejected context admitted: %',bad; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 END LOOP;
 snapshot:=app_private.mhp_owner_email_snapshot(public.digest('editor-owner','sha256'),'webinar-ghq005-proof');
 IF (snapshot->>'eligible')::integer<>3 THEN RAISE EXCEPTION 'Consent/unsubscribe/campaign audience failed: %',snapshot->>'eligible'; END IF;
 PERFORM set_config('mhp.editor.brand',(snapshot->'brand')::text,true);
END $native$;

SET LOCAL ROLE r72_content_adapter;
DO $draft$
DECLARE brand jsonb:=current_setting('mhp.editor.brand')::jsonb; canonical text; hashed bytea; manifest text; actor uuid:=current_setting('mhp.editor.actor')::uuid;
 checked_at timestamptz:=clock_timestamp();
BEGIN
 IF app_private.mhp_owner_email_authorize(public.digest('editor-owner','sha256'))<>actor THEN RAISE EXCEPTION 'Wrong adapter actor'; END IF;
 canonical:='{"bodyText":'||to_json('Hello {{FIRSTNAME}}'||chr(10)||'Quote " and Unicode café; symbol £. {{LINK}}')::text||',"schema":"propertypredator.email-draft/v1","subject":"Synthetic owner email"}';
 hashed:=public.digest(canonical,'sha256');
 manifest:=jsonb_build_object('schema','mhp.owner-email-source/v1','workspaceId','2789228d-55a6-4688-b1e8-2f70abca990b',
  'sourceSystem','mhp.owner-email','sourceItemId','owner-email:ed126300-0000-4000-8000-000000000001','sourceVersion','edit:ed126400-0000-4000-8000-000000000001',
  'contentSha256',encode(hashed,'hex'),'blobStorageKey','inline:mhp.owner-email:'||encode(hashed,'hex'),'blobSha256',encode(hashed,'hex'),
  'brandSnapshotRef',brand->>'ref','brandSha256',brand->>'sha256','audienceCampaign','webinar-ghq005-proof')::text;
 INSERT INTO app.company_content_items(id,workspace_id,source_system,source_item_id,created_by_user_id,created_request_id)
 VALUES('ed126300-0000-4000-8000-000000000001','2789228d-55a6-4688-b1e8-2f70abca990b','mhp.owner-email','owner-email:ed126300-0000-4000-8000-000000000001',actor,'isolated-ghq005-editor');
 INSERT INTO app.company_content_versions(id,workspace_id,content_item_id,version_number,origin,content_kind,title,source_system,source_item_id,source_version,
  content_mime_type,content_body,blob_storage_key,blob_sha256,brand_snapshot_ref,brand_sha256,metadata,created_by_user_id,created_request_id)
 VALUES('ed126400-0000-4000-8000-000000000001','2789228d-55a6-4688-b1e8-2f70abca990b','ed126300-0000-4000-8000-000000000001',1,'imported','email','Synthetic owner mail v1',
  'mhp.owner-email','owner-email:ed126300-0000-4000-8000-000000000001','edit:ed126400-0000-4000-8000-000000000001','application/vnd.propertypredator.email-draft+json',
  canonical,'inline:mhp.owner-email:'||encode(hashed,'hex'),hashed,brand->>'ref',decode(brand->>'sha256','hex'),
  jsonb_build_object('mhpOwnerEmail',jsonb_build_object('schema','mhp.owner-email-local/v1','brandCanonical',brand->>'canonical',
   'manifestCanonical',manifest,'manifestSha256',encode(public.digest(manifest,'sha256'),'hex'),'authoredBy','native-owner')),actor,'isolated-ghq005-editor');
 INSERT INTO app.company_content_source_attestations(workspace_id,content_item_id,content_version_id,source_system,source_item_id,source_version,
  content_sha256,blob_sha256,brand_sha256,source_catalog_sha256,checked_at,expires_at,attested_by_user_id,attested_request_id)
 VALUES('2789228d-55a6-4688-b1e8-2f70abca990b','ed126300-0000-4000-8000-000000000001','ed126400-0000-4000-8000-000000000001',
  'mhp.owner-email','owner-email:ed126300-0000-4000-8000-000000000001','edit:ed126400-0000-4000-8000-000000000001',hashed,hashed,decode(brand->>'sha256','hex'),public.digest(manifest,'sha256'),
  checked_at,checked_at+interval '15 minutes',actor,'isolated-ghq005-editor');
 PERFORM set_config('mhp.editor.canonical',canonical,true);
 -- Same valid lineage but deliberately wrong inline blob: trigger must roll back.
 BEGIN
  INSERT INTO app.company_content_versions(id,workspace_id,content_item_id,version_number,previous_version_id,origin,content_kind,title,source_system,source_item_id,source_version,
   content_mime_type,content_body,blob_storage_key,blob_sha256,brand_snapshot_ref,brand_sha256,metadata,created_by_user_id,created_request_id)
  SELECT 'ed126400-0000-4000-8000-000000000099',workspace_id,content_item_id,2,id,'edited',content_kind,title,source_system,source_item_id,'edit:ed126400-0000-4000-8000-000000000099',
   content_mime_type,content_body,'inline:wrong',blob_sha256,brand_snapshot_ref,brand_sha256,metadata,created_by_user_id,created_request_id
  FROM app.company_content_versions WHERE id='ed126400-0000-4000-8000-000000000001';
  RAISE EXCEPTION 'Wrong inline blob accepted';
 EXCEPTION WHEN check_violation THEN NULL; END;
END $draft$;

SET LOCAL ROLE r72_owner;
DO $save_no_queue$ BEGIN
 IF EXISTS(SELECT 1 FROM app_private.mhp_marketing_sends WHERE owner_content_item_id='ed126300-0000-4000-8000-000000000001')
 THEN RAISE EXCEPTION 'Saving queued mail'; END IF;
END $save_no_queue$;
SET LOCAL ROLE r72_identity_command;
DO $test_and_unapproved$
DECLARE first_test jsonb; repeat_test jsonb;
BEGIN
 first_test:=app_private.mhp_owner_email_test_begin(public.digest('editor-owner','sha256'),'ed126500-0000-4000-8000-000000000001',
  'ed126400-0000-4000-8000-000000000001',public.digest('configured-owner@example.invalid','sha256'),'isolated-ghq005-test');
 IF NOT(first_test->>'send')::boolean OR first_test->'exact'->>'canonicalContent'<>current_setting('mhp.editor.canonical')
  OR first_test->'exact'->>'blobSha256'<>encode(public.digest(current_setting('mhp.editor.canonical'),'sha256'),'hex')
 THEN RAISE EXCEPTION 'Exact canonical owner test failed'; END IF;
 -- Crash after reservation: identical command must not initiate another handoff.
 repeat_test:=app_private.mhp_owner_email_test_begin(public.digest('editor-owner','sha256'),'ed126500-0000-4000-8000-000000000001',
  'ed126400-0000-4000-8000-000000000001',public.digest('configured-owner@example.invalid','sha256'),'isolated-ghq005-test-retry');
 IF (repeat_test->>'send')::boolean OR repeat_test->>'status'<>'unknown' THEN RAISE EXCEPTION 'Unknown owner test retried'; END IF;
 BEGIN PERFORM app_private.mhp_owner_email_queue_command(public.digest('editor-owner','sha256'),'schedule','ed126500-0000-4000-8000-000000000002',
  'ed126400-0000-4000-8000-000000000001','webinar-ghq005-proof',clock_timestamp()+interval '1 hour',clock_timestamp()+interval '1 day','isolated-ghq005-unapproved');
  RAISE EXCEPTION 'Unapproved email scheduled'; EXCEPTION WHEN check_violation THEN NULL; END;
END $test_and_unapproved$;

SET LOCAL ROLE r72_content_command;
DO $publish$
DECLARE actor uuid:=current_setting('mhp.editor.actor')::uuid;
BEGIN
 IF app_private.mhp_owner_email_authorize(public.digest('editor-owner','sha256'))<>actor THEN RAISE EXCEPTION 'Wrong approval actor'; END IF;
 INSERT INTO app.company_content_approval_requests(id,workspace_id,content_item_id,content_version_id,content_sha256,request_number,requested_by_user_id,requested_request_id)
 SELECT 'ed126600-0000-4000-8000-000000000001',workspace_id,content_item_id,id,content_sha256,1,actor,'isolated-ghq005-publish'
 FROM app.company_content_versions WHERE id='ed126400-0000-4000-8000-000000000001';
 INSERT INTO app.company_content_approval_decisions(id,workspace_id,content_item_id,content_version_id,approval_request_id,content_sha256,decision,decided_by_user_id,decided_request_id)
 SELECT 'ed126700-0000-4000-8000-000000000001',workspace_id,content_item_id,content_version_id,id,content_sha256,'approved',actor,'isolated-ghq005-publish'
 FROM app.company_content_approval_requests WHERE id='ed126600-0000-4000-8000-000000000001';
END $publish$;
SET LOCAL ROLE r72_owner;
DO $publish_no_queue$ BEGIN
 IF EXISTS(SELECT 1 FROM app_private.mhp_marketing_sends WHERE owner_content_item_id='ed126300-0000-4000-8000-000000000001')
 THEN RAISE EXCEPTION 'Publishing queued mail'; END IF;
 PERFORM set_config('mhp.editor.due',(clock_timestamp()+interval '1 hour')::text,true);
 PERFORM set_config('mhp.editor.expires',(clock_timestamp()+interval '1 day')::text,true);
END $publish_no_queue$;
SET LOCAL ROLE r72_identity_command;
DO $schedule$
DECLARE first_call jsonb; replayed jsonb;
BEGIN
 first_call:=app_private.mhp_owner_email_queue_command(public.digest('editor-owner','sha256'),'schedule','ed126500-0000-4000-8000-000000000003',
  'ed126400-0000-4000-8000-000000000001','webinar-ghq005-proof',current_setting('mhp.editor.due')::timestamptz,current_setting('mhp.editor.expires')::timestamptz,'isolated-ghq005-schedule');
 replayed:=app_private.mhp_owner_email_queue_command(public.digest('editor-owner','sha256'),'schedule','ed126500-0000-4000-8000-000000000003',
  'ed126400-0000-4000-8000-000000000001','webinar-ghq005-proof',current_setting('mhp.editor.due')::timestamptz,current_setting('mhp.editor.expires')::timestamptz,'isolated-ghq005-schedule-retry');
 IF (first_call->>'changed')::integer<>3 OR NOT(replayed->>'replayed')::boolean OR (replayed->>'changed')::integer<>3
 THEN RAISE EXCEPTION 'Schedule consent or replay failed'; END IF;
END $schedule$;

SET LOCAL ROLE r72_owner;
DO $v1_setup$ BEGIN
 UPDATE app_private.mhp_marketing_sends SET due_at=clock_timestamp()-interval '2 hours',expires_at=clock_timestamp()-interval '1 hour'
 WHERE owner_content_item_id='ed126300-0000-4000-8000-000000000001' AND prospect_id='ed126000-0000-4000-8000-000000000001';
 UPDATE app_private.mhp_marketing_sends SET attempts=5 WHERE owner_content_item_id='ed126300-0000-4000-8000-000000000001' AND prospect_id='ed126000-0000-4000-8000-000000000006';
 UPDATE app_private.mhp_prospects SET unsubscribed_at=clock_timestamp() WHERE id='ed126000-0000-4000-8000-000000000007';
 PERFORM set_config('mhp.editor.owner_hash',(SELECT md5(string_agg(row_to_json(s)::text,'' ORDER BY s.id)) FROM app_private.mhp_marketing_sends s WHERE s.owner_content_item_id='ed126300-0000-4000-8000-000000000001'),true);
 PERFORM set_config('mhp.editor.send1',(SELECT id::text FROM app_private.mhp_marketing_sends WHERE owner_content_item_id='ed126300-0000-4000-8000-000000000001' AND prospect_id='ed126000-0000-4000-8000-000000000001'),true);
END $v1_setup$;
SET LOCAL ROLE r72_identity_command;
DO $v1$
DECLARE legacy jsonb;
BEGIN
 legacy:=app_private.mhp_claim_marketing_sends(25,120,ARRAY['editor-1@example.invalid']);
 IF jsonb_array_length(legacy)<>5 OR EXISTS(SELECT 1 FROM jsonb_array_elements(legacy) x WHERE x->>'template'='owner_followup')
 THEN RAISE EXCEPTION 'Automatic five/v1 selection changed'; END IF;
 PERFORM app_private.mhp_settle_marketing_send((legacy->0->>'id')::uuid,true,'synthetic-v1-accepted');
 PERFORM app_private.mhp_settle_marketing_send(current_setting('mhp.editor.send1')::uuid,true,'must-not-apply');
 PERFORM app_private.mhp_settle_marketing_send(current_setting('mhp.editor.send1')::uuid,false,NULL);
END $v1$;
SET LOCAL ROLE r72_owner;
DO $v1_untouched$ BEGIN
 IF (SELECT md5(string_agg(row_to_json(s)::text,'' ORDER BY s.id)) FROM app_private.mhp_marketing_sends s WHERE s.owner_content_item_id='ed126300-0000-4000-8000-000000000001')
  IS DISTINCT FROM current_setting('mhp.editor.owner_hash') THEN RAISE EXCEPTION 'v1 maintenance/settle touched owner work'; END IF;
 UPDATE app_private.mhp_marketing_sends SET due_at=clock_timestamp()-interval '1 minute',expires_at=clock_timestamp()+interval '1 day',attempts=0
 WHERE owner_content_item_id='ed126300-0000-4000-8000-000000000001';
 UPDATE app_private.mhp_prospects SET unsubscribed_at=NULL WHERE id='ed126000-0000-4000-8000-000000000007';
END $v1_untouched$;

SET LOCAL ROLE r72_identity_command;
DO $claim_and_proof$
DECLARE claimed jsonb; entry jsonb; first_proof jsonb; cancelled jsonb;
BEGIN
 claimed:=app_private.mhp_claim_owner_marketing_sends(3,120,ARRAY['editor-1@example.invalid','editor-6@example.invalid','editor-7@example.invalid']);
 IF jsonb_array_length(claimed)<>3 THEN RAISE EXCEPTION 'Owner v2 did not lease exact audience'; END IF;
 PERFORM set_config('mhp.editor.claimed',claimed::text,true);
 -- Active leases cannot be cancelled from the owner UI.
 cancelled:=app_private.mhp_owner_email_queue_command(public.digest('editor-owner','sha256'),'cancel','ed126500-0000-4000-8000-000000000004',
  'ed126400-0000-4000-8000-000000000001','webinar-ghq005-proof',NULL,NULL,'isolated-ghq005-cancel-leased');
 IF (cancelled->>'changed')::integer<>0 OR (cancelled->>'inFlight')::integer<>3 THEN RAISE EXCEPTION 'Cancel altered active lease'; END IF;
 SELECT x INTO entry FROM jsonb_array_elements(claimed) x WHERE x->>'id'=current_setting('mhp.editor.send1');
 first_proof:=app_private.mhp_prepare_owner_marketing_send((entry->>'id')::uuid,(entry->>'leaseId')::uuid);
 IF first_proof IS NULL OR first_proof->'exact'->>'canonicalContent'<>current_setting('mhp.editor.canonical')
  OR first_proof->'exact'->>'contentSha256'<>encode(public.digest(current_setting('mhp.editor.canonical'),'sha256'),'hex')
  OR first_proof->'exact'->'brand'->>'canonical'<>(current_setting('mhp.editor.brand')::jsonb)->>'canonical'
 THEN RAISE EXCEPTION 'Dispatch did not bind exact approved bytes/brand'; END IF;
 IF app_private.mhp_prepare_owner_marketing_send((entry->>'id')::uuid,(entry->>'leaseId')::uuid) IS NOT NULL
 THEN RAISE EXCEPTION 'Same lease issued a second proof'; END IF;
 PERFORM set_config('mhp.editor.first_proof',first_proof::text,true);
 BEGIN PERFORM app_private.mhp_settle_owner_marketing_send((entry->>'id')::uuid,gen_random_uuid(),true,'stale');
  RAISE EXCEPTION 'Stale lease settled'; EXCEPTION WHEN check_violation THEN NULL; END;
END $claim_and_proof$;

SET LOCAL ROLE r72_owner;
DO $brand_change$ BEGIN
 PERFORM set_config('mhp.editor.brand_revision',(SELECT updated_at::text FROM app.organization_branding WHERE organization_id='ba41b1a4-9752-4dbf-8312-d04a0f03d0b8'),true);
 UPDATE app.organization_branding SET updated_at=updated_at+interval '1 second' WHERE organization_id='ba41b1a4-9752-4dbf-8312-d04a0f03d0b8';
 PERFORM set_config('mhp.editor.send6',(SELECT id::text FROM app_private.mhp_marketing_sends WHERE owner_content_item_id='ed126300-0000-4000-8000-000000000001' AND prospect_id='ed126000-0000-4000-8000-000000000006'),true);
 PERFORM set_config('mhp.editor.send7',(SELECT id::text FROM app_private.mhp_marketing_sends WHERE owner_content_item_id='ed126300-0000-4000-8000-000000000001' AND prospect_id='ed126000-0000-4000-8000-000000000007'),true);
 BEGIN UPDATE app_private.mhp_owner_email_dispatch_proofs SET content_sha256=public.digest('wrong','sha256') WHERE id=(current_setting('mhp.editor.first_proof')::jsonb->>'proofId')::uuid;
  RAISE EXCEPTION 'Proof identity mutable'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $brand_change$;
SET LOCAL ROLE r72_identity_command;
DO $changed_brand_denied$
DECLARE entry jsonb;
BEGIN
 SELECT x INTO entry FROM jsonb_array_elements(current_setting('mhp.editor.claimed')::jsonb) x WHERE x->>'id'=current_setting('mhp.editor.send6');
 IF app_private.mhp_prepare_owner_marketing_send((entry->>'id')::uuid,(entry->>'leaseId')::uuid) IS NOT NULL
 THEN RAISE EXCEPTION 'Actual branding revision change did not block prepare'; END IF;
END $changed_brand_denied$;
SET LOCAL ROLE r72_owner;
UPDATE app.organization_branding SET updated_at=current_setting('mhp.editor.brand_revision')::timestamptz WHERE organization_id='ba41b1a4-9752-4dbf-8312-d04a0f03d0b8';
SET LOCAL ROLE r72_identity_command;
DO $optout_and_settle$
DECLARE entry jsonb;
BEGIN
 PERFORM app_private.mhp_unsubscribe_prospect('ed126000-0000-4000-8000-000000000007');
 SELECT x INTO entry FROM jsonb_array_elements(current_setting('mhp.editor.claimed')::jsonb) x WHERE x->>'id'=current_setting('mhp.editor.send7');
 IF app_private.mhp_prepare_owner_marketing_send((entry->>'id')::uuid,(entry->>'leaseId')::uuid) IS NOT NULL
 THEN RAISE EXCEPTION 'Unsubscribe after claim did not block prepare'; END IF;
 FOR entry IN SELECT x FROM jsonb_array_elements(current_setting('mhp.editor.claimed')::jsonb) x LOOP
  PERFORM app_private.mhp_settle_owner_marketing_send((entry->>'id')::uuid,(entry->>'leaseId')::uuid,
   entry->>'id'=current_setting('mhp.editor.send1'),CASE WHEN entry->>'id'=current_setting('mhp.editor.send1') THEN 'synthetic-owner-accepted' END);
 END LOOP;
END $optout_and_settle$;

-- A new draft holds the remaining unleased predecessor even during retry backoff.
SET LOCAL ROLE r72_content_adapter;
DO $revision$
DECLARE v app.company_content_versions%ROWTYPE; canonical text; hashed bytea; manifest jsonb; metadata jsonb;
 checked_at timestamptz:=clock_timestamp();
BEGIN
 SELECT * INTO v FROM app.company_content_versions WHERE id='ed126400-0000-4000-8000-000000000001';
 canonical:='{"bodyText":"New owner wording {{FIRSTNAME}}","schema":"propertypredator.email-draft/v1","subject":"Revised owner email"}';
 hashed:=public.digest(canonical,'sha256');manifest:=(v.metadata->'mhpOwnerEmail'->>'manifestCanonical')::jsonb;
 manifest:=manifest||jsonb_build_object('sourceVersion','edit:ed126400-0000-4000-8000-000000000002','contentSha256',encode(hashed,'hex'),'blobSha256',encode(hashed,'hex'),'blobStorageKey','inline:mhp.owner-email:'||encode(hashed,'hex'));
 metadata:=jsonb_build_object('mhpOwnerEmail',(v.metadata->'mhpOwnerEmail')||jsonb_build_object('manifestCanonical',manifest::text,'manifestSha256',encode(public.digest(manifest::text,'sha256'),'hex')));
 INSERT INTO app.company_content_versions(id,workspace_id,content_item_id,version_number,previous_version_id,origin,content_kind,title,source_system,source_item_id,source_version,
  content_mime_type,content_body,blob_storage_key,blob_sha256,brand_snapshot_ref,brand_sha256,metadata,created_by_user_id,created_request_id)
 VALUES('ed126400-0000-4000-8000-000000000002',v.workspace_id,v.content_item_id,2,v.id,'edited',v.content_kind,'Synthetic owner mail v2',v.source_system,v.source_item_id,
  'edit:ed126400-0000-4000-8000-000000000002',v.content_mime_type,canonical,'inline:mhp.owner-email:'||encode(hashed,'hex'),hashed,v.brand_snapshot_ref,v.brand_sha256,metadata,v.created_by_user_id,'isolated-ghq005-revision');
 INSERT INTO app.company_content_source_attestations(workspace_id,content_item_id,content_version_id,source_system,source_item_id,source_version,
  content_sha256,blob_sha256,brand_sha256,source_catalog_sha256,checked_at,expires_at,attested_by_user_id,attested_request_id)
 VALUES(v.workspace_id,v.content_item_id,'ed126400-0000-4000-8000-000000000002',v.source_system,v.source_item_id,'edit:ed126400-0000-4000-8000-000000000002',
  hashed,hashed,v.brand_sha256,public.digest(manifest::text,'sha256'),checked_at,checked_at+interval '15 minutes',v.created_by_user_id,'isolated-ghq005-revision');
END $revision$;
SET LOCAL ROLE r72_owner;
DO $held$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM app_private.mhp_marketing_sends WHERE id=current_setting('mhp.editor.send6')::uuid
  AND owner_hold_reason='newer_draft' AND owner_content_version_id='ed126400-0000-4000-8000-000000000001')
 THEN RAISE EXCEPTION 'New draft failed to hold predecessor without rebinding'; END IF;
 PERFORM set_config('mhp.editor.held_hash',(SELECT md5(string_agg(row_to_json(s)::text,'' ORDER BY s.id)) FROM app_private.mhp_marketing_sends s WHERE s.owner_content_item_id='ed126300-0000-4000-8000-000000000001'),true);
END $held$;
SET LOCAL ROLE r72_content_command;
DO $publish_revision$
DECLARE actor uuid:=current_setting('mhp.editor.actor')::uuid;
BEGIN
 INSERT INTO app.company_content_approval_requests(id,workspace_id,content_item_id,content_version_id,content_sha256,request_number,requested_by_user_id,requested_request_id)
 SELECT 'ed126600-0000-4000-8000-000000000002',workspace_id,content_item_id,id,content_sha256,1,actor,'isolated-ghq005-publish-v2'
 FROM app.company_content_versions WHERE id='ed126400-0000-4000-8000-000000000002';
 INSERT INTO app.company_content_approval_decisions(id,workspace_id,content_item_id,content_version_id,approval_request_id,content_sha256,decision,decided_by_user_id,decided_request_id)
 SELECT 'ed126700-0000-4000-8000-000000000002',workspace_id,content_item_id,content_version_id,id,content_sha256,'approved',actor,'isolated-ghq005-publish-v2'
 FROM app.company_content_approval_requests WHERE id='ed126600-0000-4000-8000-000000000002';
END $publish_revision$;
SET LOCAL ROLE r72_owner;
DO $publish_stays_held$ BEGIN
 IF (SELECT md5(string_agg(row_to_json(s)::text,'' ORDER BY s.id)) FROM app_private.mhp_marketing_sends s WHERE s.owner_content_item_id='ed126300-0000-4000-8000-000000000001')
  IS DISTINCT FROM current_setting('mhp.editor.held_hash') THEN RAISE EXCEPTION 'Publish resumed or altered queued mail'; END IF;
END $publish_stays_held$;
SET LOCAL ROLE r72_identity_command;
DO $explicit_replace$
DECLARE outcome jsonb;
BEGIN
 outcome:=app_private.mhp_owner_email_queue_command(public.digest('editor-owner','sha256'),'replace','ed126500-0000-4000-8000-000000000005',
  'ed126400-0000-4000-8000-000000000002','webinar-ghq005-proof',current_setting('mhp.editor.due')::timestamptz,current_setting('mhp.editor.expires')::timestamptz,'isolated-ghq005-replace');
 IF (outcome->>'changed')::integer<>1 THEN RAISE EXCEPTION 'Explicit replace altered sent/cancelled or missed held row'; END IF;
 outcome:=app_private.mhp_hold_owner_marketing_sends();
 IF (outcome->>'held')::integer<1 OR (outcome->>'resumed')::integer<>0 THEN RAISE EXCEPTION 'Recovery hold failed'; END IF;
 outcome:=app_private.mhp_owner_email_queue_command(public.digest('editor-owner','sha256'),'cancel','ed126500-0000-4000-8000-000000000006',
  'ed126400-0000-4000-8000-000000000002','webinar-ghq005-proof',NULL,NULL,'isolated-ghq005-cancel-held');
 IF (outcome->>'changed')::integer<>1 THEN RAISE EXCEPTION 'Explicit cancel missed held owner row'; END IF;
END $explicit_replace$;
SET LOCAL ROLE r72_owner;
DO $final$
BEGIN
 IF (SELECT count(*) FROM app_private.mhp_marketing_sends WHERE owner_content_item_id='ed126300-0000-4000-8000-000000000001')<>3
  OR NOT EXISTS(SELECT 1 FROM app_private.mhp_marketing_sends WHERE id=current_setting('mhp.editor.send1')::uuid AND sent_at IS NOT NULL AND owner_content_version_id='ed126400-0000-4000-8000-000000000001')
  OR NOT EXISTS(SELECT 1 FROM app_private.mhp_marketing_sends WHERE id=current_setting('mhp.editor.send7')::uuid AND cancelled_at IS NOT NULL)
  OR (SELECT count(*) FROM app.opportunities)<>current_setting('mhp.editor.crm_count')::bigint
 THEN RAISE EXCEPTION 'Owner editor final state/CRM boundary failed'; END IF;
 IF (SELECT count(*) FROM app_private.mhp_owner_email_dispatch_proofs WHERE send_id=current_setting('mhp.editor.send1')::uuid AND accepted=true)<>1
 THEN RAISE EXCEPTION 'Exact issued proof result missing'; END IF;
END $final$;
-- Regression GHQ005-R1: held/non-test work must not starve a configured target.
-- Exercise the public worker claim contract, not an implementation helper.
SET LOCAL ROLE r72_owner;
DO $claim_backlog_seed$
DECLARE n integer; prospect uuid; v app.company_content_versions%ROWTYPE; checked timestamptz:=clock_timestamp();
BEGIN
 SELECT * INTO v FROM app.company_content_versions WHERE id='ed126400-0000-4000-8000-000000000002';
 FOR n IN 1..1006 LOOP
  prospect:=('ed126800-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;
  INSERT INTO app_private.mhp_prospects(id,email,first_name,marketing_consent,consent_version,consent_at)
  VALUES(prospect,'editor-backlog-'||n||'@example.invalid','Synthetic claim backlog',n<>1006,'isolated-editor-v1',checked);
  INSERT INTO app_private.mhp_prospect_signups(prospect_id,kind,label,link,consent_given,consent_version,created_at)
  VALUES(prospect,'webinar','Synthetic owner webinar','https://martinhowardproperty.co.uk/webinar/',true,'isolated-editor-v1',checked-interval '2 days');
  INSERT INTO app_private.mhp_marketing_sends(prospect_id,template_key,campaign_key,context,due_at,expires_at,created_at)
  VALUES(prospect,'webinar_confirm','webinar-ghq005-proof','{}',checked-interval '1 day',checked+interval '1 day',checked-interval '1 day');
  INSERT INTO app_private.mhp_marketing_sends(prospect_id,template_key,campaign_key,context,due_at,expires_at,attempts,
   owner_workspace_id,owner_content_item_id,owner_content_version_id,owner_content_sha256,owner_approval_decision_id,
   owner_user_id,owner_audience_campaign,owner_held_at,owner_hold_reason)
  VALUES(prospect,'owner_followup','owner-'||v.content_item_id::text,'{}',
   CASE WHEN n=1004 THEN checked-interval '2 days' WHEN n>=1005 THEN checked+interval '1 hour'
    WHEN n<=501 THEN checked-interval '2 hours' WHEN n<=1002 THEN checked-interval '1 hour' ELSE checked-interval '1 minute' END,
   CASE WHEN n=1004 THEN checked-interval '1 day' ELSE checked+interval '1 day' END,CASE WHEN n=1005 THEN 5 ELSE 0 END,
   v.workspace_id,v.content_item_id,v.id,v.content_sha256,'ed126700-0000-4000-8000-000000000002',v.created_by_user_id,'webinar-ghq005-proof',
   CASE WHEN n<=501 OR n IN(1004,1006) THEN checked END,CASE WHEN n<=501 OR n IN(1004,1006) THEN 'recovery' END);
 END LOOP;
 PERFORM set_config('mhp.editor.backlog_legacy',(SELECT md5(string_agg(row_to_json(s)::text,'' ORDER BY s.id))
  FROM app_private.mhp_marketing_sends s WHERE s.owner_content_version_id IS NULL),true);
END $claim_backlog_seed$;
SET LOCAL ROLE r72_identity_command;
DO $claim_backlog_regression$
DECLARE claimed jsonb; candidate uuid;
BEGIN
 claimed:=app_private.mhp_claim_owner_marketing_sends(25,120,ARRAY['editor-backlog-1003@example.invalid']);
 IF jsonb_array_length(claimed)<>1 THEN
  RAISE EXCEPTION 'GHQ005_R1_STARVED_CONFIGURED_TARGET: expected one claim beyond 501 held and 501 other-recipient rows, got %',jsonb_array_length(claimed);
 END IF;
 PERFORM set_config('mhp.editor.backlog_claimed',claimed::text,true);
END $claim_backlog_regression$;
SET LOCAL ROLE r72_owner;
DO $claim_backlog_assert$
DECLARE claimed jsonb:=current_setting('mhp.editor.backlog_claimed')::jsonb;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM app_private.mhp_marketing_sends WHERE id=(claimed->0->>'id')::uuid
  AND prospect_id='ed126800-0000-4000-8000-000000001003' AND owner_lease_id=(claimed->0->>'leaseId')::uuid)
 THEN RAISE EXCEPTION 'Claim selected another recipient'; END IF;
 IF (SELECT count(*) FROM app_private.mhp_marketing_sends WHERE owner_content_version_id IS NOT NULL
  AND prospect_id BETWEEN 'ed126800-0000-4000-8000-000000000001'::uuid AND 'ed126800-0000-4000-8000-000000001002'::uuid
  AND owner_lease_id IS NULL AND attempts=0 AND cancelled_at IS NULL AND failed_at IS NULL)<>1002
 THEN RAISE EXCEPTION 'Claim modified held or non-test healthy backlog'; END IF;
 IF NOT EXISTS(SELECT 1 FROM app_private.mhp_marketing_sends WHERE owner_content_version_id IS NOT NULL
  AND prospect_id='ed126800-0000-4000-8000-000000001004' AND cancelled_at IS NOT NULL)
  OR NOT EXISTS(SELECT 1 FROM app_private.mhp_marketing_sends WHERE owner_content_version_id IS NOT NULL
  AND prospect_id='ed126800-0000-4000-8000-000000001005' AND failed_at IS NOT NULL)
  OR NOT EXISTS(SELECT 1 FROM app_private.mhp_marketing_sends WHERE owner_content_version_id IS NOT NULL
  AND prospect_id='ed126800-0000-4000-8000-000000001006' AND cancelled_at IS NOT NULL)
 THEN RAISE EXCEPTION 'Bounded owner maintenance missed expired/attempt-exhausted/no-consent held or future non-test rows'; END IF;
 IF (SELECT md5(string_agg(row_to_json(s)::text,'' ORDER BY s.id)) FROM app_private.mhp_marketing_sends s WHERE s.owner_content_version_id IS NULL)
  IS DISTINCT FROM current_setting('mhp.editor.backlog_legacy') THEN RAISE EXCEPTION 'Owner claim changed legacy mail'; END IF;
END $claim_backlog_assert$;
SELECT 'GHQ-WEBINAR-005A owner editor proof reached its final assertion' AS proof;
-- Root adds its expected rollback sentinel; never commit this fixture.
