-- GHQ-FOLLOWUP-006A. Root-only isolated126+127 rollback proof; no provider.
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

SET LOCAL ROLE r72_owner;
DO $sequence_grants$ BEGIN
 IF has_table_privilege('r72_web','app_private.mhp_followup_runs','SELECT,INSERT,UPDATE,DELETE')
  OR has_table_privilege('r72_identity_command','app_private.mhp_followup_runs','SELECT,INSERT,UPDATE,DELETE')
  OR has_function_privilege('r72_identity_command','app_private.mhp_prepare_owner_marketing_send_0126(uuid,uuid)','EXECUTE')
  OR has_function_privilege('r72_identity_command','app_private.mhp_settle_owner_marketing_send_0126(uuid,uuid,boolean,text)','EXECUTE')
  OR has_function_privilege('r72_web','app_private.mhp_sequence_claim(integer,integer,text[])','EXECUTE')
  OR NOT has_function_privilege('r72_identity_command','app_private.mhp_sequence_claim(integer,integer,text[])','EXECUTE')
 THEN RAISE EXCEPTION 'Sequence table-blind capability boundary failed'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_class WHERE oid='app_private.mhp_followup_runs'::regclass AND relrowsecurity AND relforcerowsecurity)
  OR NOT EXISTS(SELECT 1 FROM app_private.workspace_table_registry WHERE schema_name='app_private' AND table_name='mhp_followup_runs' AND workspace_column='workspace_id')
 THEN RAISE EXCEPTION 'Sequence forced RLS/registry missing'; END IF;
 IF EXISTS(SELECT 1 FROM pg_proc p,aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl
  WHERE p.pronamespace='app_private'::regnamespace AND p.proname LIKE 'mhp_sequence_%' AND acl.grantee=0 AND acl.privilege_type='EXECUTE')
 THEN RAISE EXCEPTION 'PUBLIC sequence capability'; END IF;
END $sequence_grants$;
DO $legacy_owner_shape$ BEGIN
 INSERT INTO app_private.mhp_marketing_sends(id,prospect_id,template_key,campaign_key,context,due_at,expires_at,
  owner_workspace_id,owner_content_item_id,owner_content_version_id,owner_content_sha256,owner_approval_decision_id,owner_user_id,owner_audience_campaign)
 SELECT 'ed127100-0000-4000-8000-000000000001','ed126000-0000-4000-8000-000000000001','owner_followup','owner-'||content_item_id::text,'{}',clock_timestamp()+interval '1 day',clock_timestamp()+interval '2 days',
  workspace_id,content_item_id,id,content_sha256,'ed126700-0000-4000-8000-000000000001',created_by_user_id,'webinar-ghq005-proof'
 FROM app.company_content_versions WHERE id='ed126400-0000-4000-8000-000000000001';
 BEGIN UPDATE app_private.mhp_marketing_sends SET owner_workspace_id=NULL WHERE id='ed127100-0000-4000-8000-000000000001';
  RAISE EXCEPTION 'Partial standalone owner identity accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
END $legacy_owner_shape$;
SET LOCAL ROLE r72_web;
DO $sequence_native$ DECLARE bad text; BEGIN
 FOREACH bad IN ARRAY ARRAY['editor-personal','editor-member','editor-foreign','editor-expired','editor-revoked','editor-missing'] LOOP
  BEGIN PERFORM app_private.mhp_sequence_snapshot(public.digest(bad,'sha256'),'webinar-ghq005-proof');
   RAISE EXCEPTION 'Invalid sequence owner accepted';EXCEPTION WHEN insufficient_privilege THEN NULL;END;
 END LOOP;
 IF(app_private.mhp_sequence_snapshot(public.digest('editor-owner','sha256'),'webinar-ghq005-proof')->>'eligible')::integer<>3 THEN RAISE EXCEPTION 'Sequence audience failed';END IF;
END $sequence_native$;
SET LOCAL ROLE r72_mhp_prospect_definer;
DO $sequence_bytes$
DECLARE d jsonb; body text; manifest text; brand jsonb:=app_private.mhp_owner_email_brand(); sha text;
BEGIN
 SELECT encode(content_sha256,'hex') INTO sha FROM app.company_content_versions WHERE id='ed126400-0000-4000-8000-000000000001';
 d:=jsonb_build_object('schema','growthhq.followup-sequence/v1','brand','mhp','campaign','webinar-ghq005-proof','title','Two messages café £','expiryHours',24,
  'stopOn',jsonb_build_object('reply',false,'booked',false,'purchased',false),'steps',jsonb_build_array(
   jsonb_build_object('key','first','kind','email','contentItemId','ed126300-0000-4000-8000-000000000001','contentVersionId','ed126400-0000-4000-8000-000000000001','contentSha256',sha),
   jsonb_build_object('key','wait','kind','wait','minutes',60),
   jsonb_build_object('key','second','kind','email','contentItemId','ed126300-0000-4000-8000-000000000001','contentVersionId','ed126400-0000-4000-8000-000000000001','contentSha256',sha)));
 body:=app_private.mhp_sequence_canonical(d);sha:=encode(public.digest(body,'sha256'),'hex');
 manifest:=app_private.mhp_sequence_canonical(jsonb_build_object('schema','mhp.followup-sequence-source/v1','workspaceId','2789228d-55a6-4688-b1e8-2f70abca990b',
  'sourceSystem','mhp.followup-sequence','sourceItemId','sequence:ed127300-0000-4000-8000-000000000001','sourceVersion','edit:ed127400-0000-4000-8000-000000000001',
  'contentSha256',sha,'blobStorageKey','inline:mhp.followup-sequence:'||sha,'blobSha256',sha,
  'brandSnapshotRef',brand->>'ref','brandSha256',brand->>'sha256','audienceCampaign','webinar-ghq005-proof'));
 PERFORM set_config('mhp.sequence.canonical',body,true);PERFORM set_config('mhp.sequence.manifest',manifest,true);
END $sequence_bytes$;
SET LOCAL ROLE r72_content_adapter;
DO $sequence_save$
DECLARE body text:=current_setting('mhp.sequence.canonical');manifest text:=current_setting('mhp.sequence.manifest');brand jsonb:=current_setting('mhp.editor.brand')::jsonb;
 actor uuid:=current_setting('mhp.editor.actor')::uuid;checked timestamptz:=clock_timestamp();sha bytea:=public.digest(body,'sha256');
BEGIN
 INSERT INTO app.company_content_items(id,workspace_id,source_system,source_item_id,created_by_user_id,created_request_id)
 VALUES('ed127300-0000-4000-8000-000000000001','2789228d-55a6-4688-b1e8-2f70abca990b','mhp.followup-sequence','sequence:ed127300-0000-4000-8000-000000000001',actor,'isolated-ghq006-save');
 INSERT INTO app.company_content_versions(id,workspace_id,content_item_id,version_number,origin,content_kind,title,source_system,source_item_id,source_version,
  content_mime_type,content_body,blob_storage_key,blob_sha256,brand_snapshot_ref,brand_sha256,metadata,created_by_user_id,created_request_id)
 VALUES('ed127400-0000-4000-8000-000000000001','2789228d-55a6-4688-b1e8-2f70abca990b','ed127300-0000-4000-8000-000000000001',1,'imported','other','Two messages café £',
  'mhp.followup-sequence','sequence:ed127300-0000-4000-8000-000000000001','edit:ed127400-0000-4000-8000-000000000001','application/vnd.growthhq.followup-sequence+json',body,
  'inline:mhp.followup-sequence:'||encode(sha,'hex'),sha,brand->>'ref',decode(brand->>'sha256','hex'),
  jsonb_build_object('mhpSequence',jsonb_build_object('schema','mhp.followup-sequence-local/v1','brandCanonical',brand->>'canonical','manifestCanonical',manifest,
   'manifestSha256',encode(public.digest(manifest,'sha256'),'hex'),'authoredBy','native-owner')),actor,'isolated-ghq006-save');
 INSERT INTO app.company_content_source_attestations(workspace_id,content_item_id,content_version_id,source_system,source_item_id,source_version,
  content_sha256,blob_sha256,brand_sha256,source_catalog_sha256,checked_at,expires_at,attested_by_user_id,attested_request_id)
 VALUES('2789228d-55a6-4688-b1e8-2f70abca990b','ed127300-0000-4000-8000-000000000001','ed127400-0000-4000-8000-000000000001','mhp.followup-sequence',
  'sequence:ed127300-0000-4000-8000-000000000001','edit:ed127400-0000-4000-8000-000000000001',sha,sha,decode(brand->>'sha256','hex'),public.digest(manifest,'sha256'),checked,checked+interval '15 minutes',actor,'isolated-ghq006-save');
END $sequence_save$;
SET LOCAL ROLE r72_identity_command;
DO $sequence_unapproved$ BEGIN
 BEGIN PERFORM app_private.mhp_sequence_command(public.digest('editor-owner','sha256'),'enrol','ed127500-0000-4000-8000-000000000001','ed127400-0000-4000-8000-000000000001','webinar-ghq005-proof',NULL,NULL,'isolated-ghq006-unapproved');
 RAISE EXCEPTION 'Unpublished sequence enrolled';EXCEPTION WHEN check_violation THEN NULL;END;
END $sequence_unapproved$;
SET LOCAL ROLE r72_content_command;
DO $sequence_publish$ DECLARE actor uuid:=current_setting('mhp.editor.actor')::uuid;BEGIN
 INSERT INTO app.company_content_approval_requests(id,workspace_id,content_item_id,content_version_id,content_sha256,request_number,requested_by_user_id,requested_request_id)
 SELECT 'ed127600-0000-4000-8000-000000000001',workspace_id,content_item_id,id,content_sha256,1,actor,'isolated-ghq006-publish' FROM app.company_content_versions WHERE id='ed127400-0000-4000-8000-000000000001';
 INSERT INTO app.company_content_approval_decisions(id,workspace_id,content_item_id,content_version_id,approval_request_id,content_sha256,decision,decided_by_user_id,decided_request_id)
 SELECT 'ed127700-0000-4000-8000-000000000001',workspace_id,content_item_id,content_version_id,id,content_sha256,'approved',actor,'isolated-ghq006-publish' FROM app.company_content_approval_requests WHERE id='ed127600-0000-4000-8000-000000000001';
END $sequence_publish$;
SET LOCAL ROLE r72_owner;
DO $sequence_publish_no_effect$ BEGIN
 IF EXISTS(SELECT 1 FROM app_private.mhp_followup_runs) OR EXISTS(SELECT 1 FROM app_private.mhp_marketing_sends WHERE sequence_run_id IS NOT NULL)
 THEN RAISE EXCEPTION 'Save or publish created a run/delivery'; END IF;
END $sequence_publish_no_effect$;
SET LOCAL ROLE r72_identity_command;
DO $sequence_enrol$ DECLARE first_call jsonb; again jsonb;BEGIN
 first_call:=app_private.mhp_sequence_command(public.digest('editor-owner','sha256'),'enrol','ed127500-0000-4000-8000-000000000002','ed127400-0000-4000-8000-000000000001','webinar-ghq005-proof',NULL,NULL,'isolated-ghq006-enrol');
 again:=app_private.mhp_sequence_command(public.digest('editor-owner','sha256'),'enrol','ed127500-0000-4000-8000-000000000002','ed127400-0000-4000-8000-000000000001','webinar-ghq005-proof',NULL,NULL,'isolated-ghq006-replay');
 IF(first_call->>'changed')::integer<>3 OR NOT(again->>'replayed')::boolean OR(first_call->>'remaining')::integer<>0 THEN RAISE EXCEPTION 'Enrolment consent/dedupe/replay failed';END IF;
 BEGIN PERFORM app_private.mhp_sequence_command(public.digest('editor-owner','sha256'),'pause','ed127500-0000-4000-8000-000000000002','ed127400-0000-4000-8000-000000000001','webinar-ghq005-other',NULL,NULL,'isolated-ghq006-changed');
  -- Different action has its own receipt; changed exact input on SAMEaction is rejected below.
 END;
 BEGIN PERFORM app_private.mhp_sequence_command(public.digest('editor-owner','sha256'),'enrol','ed127500-0000-4000-8000-000000000002','ed127400-0000-4000-8000-000000000001','changed-campaign',NULL,NULL,'isolated-ghq006-changed-enrol');
 RAISE EXCEPTION 'Changed command input accepted';EXCEPTION WHEN check_violation THEN NULL;END;
 PERFORM set_config('mhp.sequence.claim',(app_private.mhp_sequence_claim(25,120,ARRAY['editor-1@example.invalid']))::text,true);
END $sequence_enrol$;
SET LOCAL ROLE r72_owner;
DO $sequence_claim_assert$ DECLARE claim jsonb:=current_setting('mhp.sequence.claim')::jsonb;BEGIN
 IF jsonb_array_length(claim)<>1 THEN RAISE EXCEPTION 'Expected one sequence lease';END IF;
 PERFORM set_config('mhp.sequence.send',claim->0->>'id',true);PERFORM set_config('mhp.sequence.lease',claim->0->>'leaseId',true);
 PERFORM set_config('mhp.sequence.run',(SELECT sequence_run_id::text FROM app_private.mhp_marketing_sends WHERE id=(claim->0->>'id')::uuid),true);
 PERFORM set_config('mhp.sequence.queue_digest',(SELECT md5(string_agg(row_to_json(s)::text,'' ORDER BY id)) FROM app_private.mhp_marketing_sends s WHERE sequence_run_id IS NOT NULL),true);
END $sequence_claim_assert$;
SET LOCAL ROLE r72_identity_command;
DO $old_runtime_exclusion$ DECLARE old jsonb;BEGIN
 old:=app_private.mhp_claim_owner_marketing_sends(25,120,NULL);
 IF jsonb_array_length(old)<>0 THEN RAISE EXCEPTION 'Old owner claim consumed sequence';END IF;
 IF app_private.mhp_prepare_owner_marketing_send(current_setting('mhp.sequence.send')::uuid,current_setting('mhp.sequence.lease')::uuid) IS NOT NULL THEN RAISE EXCEPTION 'Old prepare consumed sequence';END IF;
 PERFORM app_private.mhp_owner_email_queue_command(public.digest('editor-owner','sha256'),'cancel','ed127500-0000-4000-8000-000000000003','ed126400-0000-4000-8000-000000000001','webinar-ghq005-proof',NULL,NULL,'isolated-ghq006-standalone-cancel');
END $old_runtime_exclusion$;
SET LOCAL ROLE r72_owner;
DO $old_runtime_untouched$ BEGIN
 IF(SELECT md5(string_agg(row_to_json(s)::text,'' ORDER BY id)) FROM app_private.mhp_marketing_sends s WHERE sequence_run_id IS NOT NULL) IS DISTINCT FROM current_setting('mhp.sequence.queue_digest') THEN RAISE EXCEPTION 'Old claim/cancel changed sequence work';END IF;
END $old_runtime_untouched$;
SET LOCAL ROLE r72_identity_command;
DO $pause_before_prepare$ DECLARE result jsonb;BEGIN
 result:=app_private.mhp_sequence_command(public.digest('editor-owner','sha256'),'pause','ed127500-0000-4000-8000-000000000004','ed127400-0000-4000-8000-000000000001','webinar-ghq005-proof',current_setting('mhp.sequence.run')::uuid,NULL,'isolated-ghq006-pause');
 IF(result->>'changed')::integer<>1 OR app_private.mhp_sequence_prepare(current_setting('mhp.sequence.send')::uuid,current_setting('mhp.sequence.lease')::uuid) IS NOT NULL THEN RAISE EXCEPTION 'Paused run handed off';END IF;
 PERFORM app_private.mhp_sequence_command(public.digest('editor-owner','sha256'),'resume','ed127500-0000-4000-8000-000000000005','ed127400-0000-4000-8000-000000000001','webinar-ghq005-proof',current_setting('mhp.sequence.run')::uuid,NULL,'isolated-ghq006-resume');
 result:=app_private.mhp_sequence_prepare(current_setting('mhp.sequence.send')::uuid,current_setting('mhp.sequence.lease')::uuid);
 IF result->'exact'->>'canonicalContent' IS DISTINCT FROM current_setting('mhp.editor.canonical') THEN RAISE EXCEPTION 'Sequence proof did not bind exact existing copy';END IF;
 PERFORM set_config('mhp.sequence.proof',result->>'proofId',true);
 PERFORM app_private.mhp_settle_owner_marketing_send(current_setting('mhp.sequence.send')::uuid,current_setting('mhp.sequence.lease')::uuid,true,'synthetic-sequence-accepted');
END $pause_before_prepare$;
SET LOCAL ROLE r72_owner;
DO $successful_progression$ DECLARE r app_private.mhp_followup_runs%ROWTYPE;BEGIN
 SELECT * INTO r FROM app_private.mhp_followup_runs WHERE id=current_setting('mhp.sequence.run')::uuid;
 IF r.position<>2 OR r.current_send_id IS NOT NULL OR r.state<>'active' OR r.due_at<r.last_accepted_at+interval '60 minutes' THEN RAISE EXCEPTION 'Accepted message did not start relative wait';END IF;
 IF EXISTS(SELECT 1 FROM app_private.mhp_marketing_sends WHERE sequence_run_id=r.id AND sequence_step=2) THEN RAISE EXCEPTION 'Future message was enqueued before wait';END IF;
 UPDATE app_private.mhp_followup_runs SET due_at=clock_timestamp()-interval '1 second' WHERE id=r.id;
END $successful_progression$;
SET LOCAL ROLE r72_identity_command;
DO $unknown_does_not_advance$ DECLARE claim jsonb; prepared jsonb;BEGIN
 claim:=app_private.mhp_sequence_claim(25,120,ARRAY['editor-1@example.invalid']);
 IF jsonb_array_length(claim)<>1 THEN RAISE EXCEPTION 'Second message could not use same content item';END IF;
 PERFORM set_config('mhp.sequence.second_send',claim->0->>'id',true);PERFORM set_config('mhp.sequence.second_lease',claim->0->>'leaseId',true);
 prepared:=app_private.mhp_sequence_prepare((claim->0->>'id')::uuid,(claim->0->>'leaseId')::uuid);
 PERFORM set_config('mhp.sequence.unknown_proof',prepared->>'proofId',true);
 PERFORM app_private.mhp_sequence_unknown((claim->0->>'id')::uuid,(claim->0->>'leaseId')::uuid);
END $unknown_does_not_advance$;
SET LOCAL ROLE r72_owner;
DO $unknown_hold$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM app_private.mhp_followup_runs WHERE id=current_setting('mhp.sequence.run')::uuid AND state='held' AND reason='outcome_unknown' AND position=2)
 THEN RAISE EXCEPTION 'Unknown send advanced or failed open';END IF;
 UPDATE app_private.mhp_marketing_sends SET lease_until=clock_timestamp()-interval '1 second' WHERE id=current_setting('mhp.sequence.second_send')::uuid;
END $unknown_hold$;
SET LOCAL ROLE r72_identity_command;
DO $unknown_ack$ DECLARE result jsonb; claim jsonb;prepared jsonb;BEGIN
 result:=app_private.mhp_sequence_command(public.digest('editor-owner','sha256'),'resume','ed127500-0000-4000-8000-000000000006','ed127400-0000-4000-8000-000000000001','webinar-ghq005-proof',current_setting('mhp.sequence.run')::uuid,NULL,'isolated-ghq006-no-ack');
 IF(result->>'changed')::integer<>0 OR(result->>'blocked')::integer<>1 THEN RAISE EXCEPTION 'Unknown attempt retried without acknowledgement';END IF;
 result:=app_private.mhp_sequence_command(public.digest('editor-owner','sha256'),'resume','ed127500-0000-4000-8000-000000000007','ed127400-0000-4000-8000-000000000001','webinar-ghq005-proof',current_setting('mhp.sequence.run')::uuid,current_setting('mhp.sequence.unknown_proof')::uuid,'isolated-ghq006-exact-ack');
 IF(result->>'changed')::integer<>1 THEN RAISE EXCEPTION 'Exact unknown attempt could not be acknowledged';END IF;
 claim:=app_private.mhp_sequence_claim(25,120,ARRAY['editor-1@example.invalid']);
 IF jsonb_array_length(claim)<>1 THEN RAISE EXCEPTION 'Acknowledged old proof permanently blocked new lease';END IF;
 prepared:=app_private.mhp_sequence_prepare((claim->0->>'id')::uuid,(claim->0->>'leaseId')::uuid);
 IF prepared->>'proofId'=current_setting('mhp.sequence.unknown_proof') THEN RAISE EXCEPTION 'Retry reused an old proof';END IF;
 PERFORM set_config('mhp.sequence.second_unknown_proof',prepared->>'proofId',true);
 PERFORM set_config('mhp.sequence.third_lease',claim->0->>'leaseId',true);
 PERFORM app_private.mhp_sequence_unknown((claim->0->>'id')::uuid,(claim->0->>'leaseId')::uuid);
END $unknown_ack$;
SET LOCAL ROLE r72_owner;
UPDATE app_private.mhp_marketing_sends SET lease_until=clock_timestamp()-interval '1 second' WHERE id=current_setting('mhp.sequence.second_send')::uuid;
SET LOCAL ROLE r72_identity_command;
DO $unknown_ack_is_exact$ DECLARE result jsonb;claim jsonb;prepared jsonb;BEGIN
 result:=app_private.mhp_sequence_command(public.digest('editor-owner','sha256'),'resume','ed127500-0000-4000-8000-000000000008','ed127400-0000-4000-8000-000000000001','webinar-ghq005-proof',current_setting('mhp.sequence.run')::uuid,current_setting('mhp.sequence.unknown_proof')::uuid,'isolated-ghq006-old-ack');
 IF(result->>'changed')::integer<>0 OR(result->>'blocked')::integer<>1 THEN RAISE EXCEPTION 'Old acknowledgement authorised a different unknown attempt';END IF;
 result:=app_private.mhp_sequence_command(public.digest('editor-owner','sha256'),'resume','ed127500-0000-4000-8000-000000000009','ed127400-0000-4000-8000-000000000001','webinar-ghq005-proof',current_setting('mhp.sequence.run')::uuid,current_setting('mhp.sequence.second_unknown_proof')::uuid,'isolated-ghq006-new-ack');
 IF(result->>'changed')::integer<>1 THEN RAISE EXCEPTION 'New exact acknowledgement rejected';END IF;
 claim:=app_private.mhp_sequence_claim(25,120,ARRAY['editor-1@example.invalid']);prepared:=app_private.mhp_sequence_prepare((claim->0->>'id')::uuid,(claim->0->>'leaseId')::uuid);
 IF prepared IS NULL THEN RAISE EXCEPTION 'Newly acknowledged attempt could not prepare';END IF;
 PERFORM app_private.mhp_settle_owner_marketing_send((claim->0->>'id')::uuid,(claim->0->>'leaseId')::uuid,true,'synthetic-sequence-second-accepted');
END $unknown_ack_is_exact$;
SET LOCAL ROLE r72_owner;
DO $sequence_final$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM app_private.mhp_followup_runs WHERE id=current_setting('mhp.sequence.run')::uuid AND state='completed')
  OR(SELECT count(*) FROM app_private.mhp_marketing_sends WHERE sequence_run_id=current_setting('mhp.sequence.run')::uuid AND sent_at IS NOT NULL)<>2
 THEN RAISE EXCEPTION 'Successful final step did not complete exactly once';END IF;
 IF(SELECT count(*) FROM app.opportunities)::text<>current_setting('mhp.editor.crm_count') THEN RAISE EXCEPTION 'Sequence created a hidden CRM contact/opportunity';END IF;
END $sequence_final$;
DO $unsubscribe_seed$ BEGIN
 UPDATE app_private.mhp_prospects SET unsubscribed_at=clock_timestamp() WHERE id='ed126000-0000-4000-8000-000000000006';
END $unsubscribe_seed$;
SET LOCAL ROLE r72_identity_command;
SELECT app_private.mhp_sequence_claim(25,120,ARRAY['editor-7@example.invalid']);
SET LOCAL ROLE r72_owner;
DO $unsubscribe_assert$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM app_private.mhp_followup_runs WHERE prospect_id='ed126000-0000-4000-8000-000000000006' AND state='stopped' AND reason='unsubscribed')
  OR EXISTS(SELECT 1 FROM app_private.mhp_marketing_sends WHERE sequence_run_id IN(SELECT id FROM app_private.mhp_followup_runs WHERE prospect_id='ed126000-0000-4000-8000-000000000006'))
 THEN RAISE EXCEPTION 'Unsubscribe after enrolment did not stop before first delivery';END IF;
END $unsubscribe_assert$;
DO $backlog_seed$
DECLARE n integer;prospect uuid;run_id uuid;checked timestamptz:=clock_timestamp();actor uuid:=current_setting('mhp.editor.actor')::uuid;
BEGIN
 FOR n IN 1..1003 LOOP
  prospect:=('ed127800-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;run_id:=('ed127a00-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;
  INSERT INTO app_private.mhp_prospects(id,email,first_name,marketing_consent,consent_version,consent_at)
  VALUES(prospect,'sequence-backlog-'||n||'@example.invalid','Synthetic backlog',true,'isolated-sequence-v1',checked);
  INSERT INTO app_private.mhp_prospect_signups(prospect_id,kind,label,link,consent_given,consent_version,created_at)
  VALUES(prospect,'webinar','Synthetic sequence','https://martinhowardproperty.co.uk/webinar/',true,'isolated-sequence-v1',checked-interval '2 minutes');
  INSERT INTO app_private.mhp_marketing_sends(prospect_id,template_key,campaign_key,context,due_at,expires_at,created_at)
  VALUES(prospect,'webinar_confirm','webinar-ghq005-proof','{}',checked+interval '2 days',checked+interval '3 days',checked-interval '1 minute');
  INSERT INTO app_private.mhp_followup_runs(id,workspace_id,sequence_item_id,sequence_version_id,sequence_sha256,sequence_approval_id,owner_user_id,prospect_id,campaign,enrolment_command_id,state,position,due_at)
  SELECT run_id,workspace_id,content_item_id,id,content_sha256,'ed127700-0000-4000-8000-000000000001',actor,prospect,'webinar-ghq005-proof','ed127500-0000-4000-8000-000000000002',CASE WHEN n<=501 THEN 'paused' ELSE 'active' END,0,checked-interval '1 minute'
  FROM app.company_content_versions WHERE id='ed127400-0000-4000-8000-000000000001';
 END LOOP;
END $backlog_seed$;
SET LOCAL ROLE r72_identity_command;
DO $backlog_claim$ DECLARE claim jsonb;BEGIN
 claim:=app_private.mhp_sequence_claim(25,120,ARRAY['sequence-backlog-1003@example.invalid']);
 IF jsonb_array_length(claim)<>1 THEN RAISE EXCEPTION 'Sequence target starved after501paused+501other-recipient rows';END IF;
 PERFORM set_config('mhp.sequence.backlog_claim',claim::text,true);
END $backlog_claim$;
SET LOCAL ROLE r72_owner;
DO $backlog_assert$ BEGIN
 IF(SELECT count(*) FROM app_private.mhp_followup_runs WHERE id BETWEEN 'ed127a00-0000-4000-8000-000000000001'::uuid AND 'ed127a00-0000-4000-8000-000000001002'::uuid AND current_send_id IS NULL)<>1002
 THEN RAISE EXCEPTION 'Paused/non-test prefix was enqueued';END IF;
 IF NOT EXISTS(SELECT 1 FROM app_private.mhp_marketing_sends WHERE id=(current_setting('mhp.sequence.backlog_claim')::jsonb->0->>'id')::uuid AND prospect_id='ed127800-0000-4000-8000-000000001003') THEN RAISE EXCEPTION 'Claim selected wrong backlog target';END IF;
END $backlog_assert$;
DO $later_prospects$ DECLARE n integer;prospect uuid;checked timestamptz:=clock_timestamp();BEGIN
 FOR n IN 8..9 LOOP
  prospect:=('ed126000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;
  INSERT INTO app_private.mhp_prospects(id,email,first_name,marketing_consent,consent_version,consent_at)
  VALUES(prospect,'editor-'||n||'@example.invalid','Synthetic later',true,'isolated-sequence-v1',checked);
  INSERT INTO app_private.mhp_prospect_signups(prospect_id,kind,label,link,consent_given,consent_version,created_at)
  VALUES(prospect,'webinar','Synthetic later','https://martinhowardproperty.co.uk/webinar/',true,'isolated-sequence-v1',checked-interval '2 minutes');
  INSERT INTO app_private.mhp_marketing_sends(prospect_id,template_key,campaign_key,context,due_at,expires_at,created_at)
  VALUES(prospect,'webinar_confirm','webinar-ghq005-proof','{}',checked+interval '2 days',checked+interval '3 days',checked-interval '1 minute');
 END LOOP;
END $later_prospects$;
SET LOCAL ROLE r72_identity_command;
DO $later_enrol$ DECLARE result jsonb;BEGIN
 result:=app_private.mhp_sequence_command(public.digest('editor-owner','sha256'),'enrol','ed127500-0000-4000-8000-000000000010','ed127400-0000-4000-8000-000000000001','webinar-ghq005-proof',NULL,NULL,'isolated-ghq006-later-enrol');
 IF(result->>'changed')::integer<>2 THEN RAISE EXCEPTION 'Later explicit enrolment did not add onlyneweligible prospects';END IF;
END $later_enrol$;
SET LOCAL ROLE r72_owner;
DO $later_run_ids$ BEGIN
 PERFORM set_config('mhp.sequence.run8',(SELECT id::text FROM app_private.mhp_followup_runs WHERE prospect_id='ed126000-0000-4000-8000-000000000008'),true);
 PERFORM set_config('mhp.sequence.run9',(SELECT id::text FROM app_private.mhp_followup_runs WHERE prospect_id='ed126000-0000-4000-8000-000000000009'),true);
END $later_run_ids$;
SET LOCAL ROLE r72_mhp_prospect_definer;
DO $sequence_revision_bytes$
DECLARE d jsonb;body text;manifest text;sha text;old app.company_content_versions%ROWTYPE;
BEGIN
 SELECT * INTO old FROM app.company_content_versions WHERE id='ed127400-0000-4000-8000-000000000001';
 d:=jsonb_set(old.content_body::jsonb,'{title}','"New sequence version café £"'::jsonb);body:=app_private.mhp_sequence_canonical(d);sha:=encode(public.digest(body,'sha256'),'hex');
 manifest:=app_private.mhp_sequence_canonical((old.metadata->'mhpSequence'->>'manifestCanonical')::jsonb||jsonb_build_object('sourceVersion','edit:ed127400-0000-4000-8000-000000000002',
  'contentSha256',sha,'blobSha256',sha,'blobStorageKey','inline:mhp.followup-sequence:'||sha));
 PERFORM set_config('mhp.sequence.revision_body',body,true);PERFORM set_config('mhp.sequence.revision_manifest',manifest,true);
END $sequence_revision_bytes$;
SET LOCAL ROLE r72_content_adapter;
DO $sequence_revision_save$
DECLARE body text:=current_setting('mhp.sequence.revision_body');manifest text:=current_setting('mhp.sequence.revision_manifest');checked timestamptz:=clock_timestamp();
BEGIN
 INSERT INTO app.company_content_versions(id,workspace_id,content_item_id,version_number,previous_version_id,origin,content_kind,title,source_system,source_item_id,source_version,
  content_mime_type,content_body,blob_storage_key,blob_sha256,brand_snapshot_ref,brand_sha256,metadata,created_by_user_id,created_request_id)
 SELECT 'ed127400-0000-4000-8000-000000000002',workspace_id,content_item_id,2,id,'edited',content_kind,'New sequence version café £',source_system,source_item_id,'edit:ed127400-0000-4000-8000-000000000002',
  content_mime_type,body,'inline:mhp.followup-sequence:'||encode(public.digest(body,'sha256'),'hex'),public.digest(body,'sha256'),brand_snapshot_ref,brand_sha256,
  jsonb_build_object('mhpSequence',(metadata->'mhpSequence')||jsonb_build_object('manifestCanonical',manifest,'manifestSha256',encode(public.digest(manifest,'sha256'),'hex'))),created_by_user_id,'isolated-ghq006-revision'
 FROM app.company_content_versions WHERE id='ed127400-0000-4000-8000-000000000001';
 INSERT INTO app.company_content_source_attestations(workspace_id,content_item_id,content_version_id,source_system,source_item_id,source_version,
  content_sha256,blob_sha256,brand_sha256,source_catalog_sha256,checked_at,expires_at,attested_by_user_id,attested_request_id)
 SELECT workspace_id,content_item_id,id,source_system,source_item_id,source_version,content_sha256,blob_sha256,brand_sha256,public.digest(manifest,'sha256'),checked,checked+interval '15 minutes',created_by_user_id,'isolated-ghq006-revision'
 FROM app.company_content_versions WHERE id='ed127400-0000-4000-8000-000000000002';
END $sequence_revision_save$;
SET LOCAL ROLE r72_owner;
DO $stale_sequence_hold$ BEGIN
 IF(SELECT count(*) FROM app_private.mhp_followup_runs WHERE id IN(current_setting('mhp.sequence.run8')::uuid,current_setting('mhp.sequence.run9')::uuid)
  AND sequence_version_id='ed127400-0000-4000-8000-000000000001' AND state='held' AND reason='newer_sequence')<>2 THEN RAISE EXCEPTION 'New sequence draft did not hold old runs without retargeting';END IF;
END $stale_sequence_hold$;
SET LOCAL ROLE r72_identity_command;
DO $stale_resume_and_cancel$ DECLARE result jsonb;BEGIN
 result:=app_private.mhp_sequence_command(public.digest('editor-owner','sha256'),'resume','ed127500-0000-4000-8000-000000000011','ed127400-0000-4000-8000-000000000001','webinar-ghq005-proof',current_setting('mhp.sequence.run8')::uuid,NULL,'isolated-ghq006-stale-resume');
 IF(result->>'changed')::integer<>0 OR(result->>'blocked')::integer<>1 THEN RAISE EXCEPTION 'Stale approved sequence resumed';END IF;
 result:=app_private.mhp_sequence_command(public.digest('editor-owner','sha256'),'cancel','ed127500-0000-4000-8000-000000000012','ed127400-0000-4000-8000-000000000001','webinar-ghq005-proof',current_setting('mhp.sequence.run8')::uuid,NULL,'isolated-ghq006-stale-cancel');
 IF(result->>'changed')::integer<>1 THEN RAISE EXCEPTION 'Stale run could not be cancelled';END IF;
END $stale_resume_and_cancel$;
SET LOCAL ROLE r72_content_command;
DO $sequence_revision_publish$ DECLARE actor uuid:=current_setting('mhp.editor.actor')::uuid;BEGIN
 INSERT INTO app.company_content_approval_requests(id,workspace_id,content_item_id,content_version_id,content_sha256,request_number,requested_by_user_id,requested_request_id)
 SELECT 'ed127600-0000-4000-8000-000000000002',workspace_id,content_item_id,id,content_sha256,1,actor,'isolated-ghq006-revision-publish' FROM app.company_content_versions WHERE id='ed127400-0000-4000-8000-000000000002';
 INSERT INTO app.company_content_approval_decisions(id,workspace_id,content_item_id,content_version_id,approval_request_id,content_sha256,decision,decided_by_user_id,decided_request_id)
 SELECT 'ed127700-0000-4000-8000-000000000002',workspace_id,content_item_id,content_version_id,id,content_sha256,'approved',actor,'isolated-ghq006-revision-publish' FROM app.company_content_approval_requests WHERE id='ed127600-0000-4000-8000-000000000002';
END $sequence_revision_publish$;
SET LOCAL ROLE r72_identity_command;
DO $fresh_start_explicit$ DECLARE result jsonb;BEGIN
 result:=app_private.mhp_sequence_command(public.digest('editor-owner','sha256'),'enrol','ed127500-0000-4000-8000-000000000013','ed127400-0000-4000-8000-000000000002','webinar-ghq005-proof',NULL,NULL,'isolated-ghq006-new-version-start');
 IF(result->>'changed')::integer<1 OR(result->>'blocked')::integer<1 THEN RAISE EXCEPTION 'New version fresh start did not respect old open runs';END IF;
END $fresh_start_explicit$;
SET LOCAL ROLE r72_owner;
DO $fresh_start_assert$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM app_private.mhp_followup_runs WHERE prospect_id='ed126000-0000-4000-8000-000000000008' AND sequence_version_id='ed127400-0000-4000-8000-000000000002' AND state='active' AND position=0)
  OR EXISTS(SELECT 1 FROM app_private.mhp_followup_runs WHERE prospect_id='ed126000-0000-4000-8000-000000000009' AND sequence_version_id='ed127400-0000-4000-8000-000000000002')
 THEN RAISE EXCEPTION 'Fresh start changed or overlapped a pinned old run';END IF;
END $fresh_start_assert$;
SET LOCAL ROLE r72_mhp_prospect_definer;
DO $mixed_channel_bytes$
DECLARE old app.company_content_versions%ROWTYPE;body text;manifest text;sha text;
BEGIN
 SELECT * INTO old FROM app.company_content_versions WHERE id='ed127400-0000-4000-8000-000000000002';
 body:=app_private.mhp_sequence_canonical(jsonb_set(old.content_body::jsonb,'{steps,0,kind}','"whatsapp"'::jsonb));sha:=encode(public.digest(body,'sha256'),'hex');
 manifest:=app_private.mhp_sequence_canonical((old.metadata->'mhpSequence'->>'manifestCanonical')::jsonb||jsonb_build_object('sourceVersion','edit:ed127400-0000-4000-8000-000000000003',
  'contentSha256',sha,'blobSha256',sha,'blobStorageKey','inline:mhp.followup-sequence:'||sha));
 PERFORM set_config('mhp.sequence.mixed_body',body,true);PERFORM set_config('mhp.sequence.mixed_manifest',manifest,true);
END $mixed_channel_bytes$;
SET LOCAL ROLE r72_content_adapter;
DO $mixed_channel_save$
DECLARE body text:=current_setting('mhp.sequence.mixed_body');manifest text:=current_setting('mhp.sequence.mixed_manifest');checked timestamptz:=clock_timestamp();
BEGIN
 INSERT INTO app.company_content_versions(id,workspace_id,content_item_id,version_number,previous_version_id,origin,content_kind,title,source_system,source_item_id,source_version,
  content_mime_type,content_body,blob_storage_key,blob_sha256,brand_snapshot_ref,brand_sha256,metadata,created_by_user_id,created_request_id)
 SELECT 'ed127400-0000-4000-8000-000000000003',workspace_id,content_item_id,3,id,'edited',content_kind,title,source_system,source_item_id,'edit:ed127400-0000-4000-8000-000000000003',
  content_mime_type,body,'inline:mhp.followup-sequence:'||encode(public.digest(body,'sha256'),'hex'),public.digest(body,'sha256'),brand_snapshot_ref,brand_sha256,
  jsonb_build_object('mhpSequence',(metadata->'mhpSequence')||jsonb_build_object('manifestCanonical',manifest,'manifestSha256',encode(public.digest(manifest,'sha256'),'hex'))),created_by_user_id,'isolated-ghq006-mixed'
 FROM app.company_content_versions WHERE id='ed127400-0000-4000-8000-000000000002';
 INSERT INTO app.company_content_source_attestations(workspace_id,content_item_id,content_version_id,source_system,source_item_id,source_version,
  content_sha256,blob_sha256,brand_sha256,source_catalog_sha256,checked_at,expires_at,attested_by_user_id,attested_request_id)
 SELECT workspace_id,content_item_id,id,source_system,source_item_id,source_version,content_sha256,blob_sha256,brand_sha256,public.digest(manifest,'sha256'),checked,checked+interval '15 minutes',created_by_user_id,'isolated-ghq006-mixed'
 FROM app.company_content_versions WHERE id='ed127400-0000-4000-8000-000000000003';
END $mixed_channel_save$;
SET LOCAL ROLE r72_content_command;
DO $mixed_channel_publish$ DECLARE actor uuid:=current_setting('mhp.editor.actor')::uuid;BEGIN
 INSERT INTO app.company_content_approval_requests(id,workspace_id,content_item_id,content_version_id,content_sha256,request_number,requested_by_user_id,requested_request_id)
 SELECT 'ed127600-0000-4000-8000-000000000003',workspace_id,content_item_id,id,content_sha256,1,actor,'isolated-ghq006-mixed-publish' FROM app.company_content_versions WHERE id='ed127400-0000-4000-8000-000000000003';
 INSERT INTO app.company_content_approval_decisions(id,workspace_id,content_item_id,content_version_id,approval_request_id,content_sha256,decision,decided_by_user_id,decided_request_id)
 SELECT 'ed127700-0000-4000-8000-000000000003',workspace_id,content_item_id,content_version_id,id,content_sha256,'approved',actor,'isolated-ghq006-mixed-publish' FROM app.company_content_approval_requests WHERE id='ed127600-0000-4000-8000-000000000003';
END $mixed_channel_publish$;
SET LOCAL ROLE r72_identity_command;
DO $mixed_channel_activation_blocked$ BEGIN
 BEGIN PERFORM app_private.mhp_sequence_command(public.digest('editor-owner','sha256'),'enrol','ed127500-0000-4000-8000-000000000014','ed127400-0000-4000-8000-000000000003','webinar-ghq005-proof',NULL,NULL,'isolated-ghq006-mixed-start');
  RAISE EXCEPTION 'Unready WhatsApp step was silently skipped or activated';
 EXCEPTION WHEN check_violation THEN IF SQLERRM NOT LIKE '%channel is not connected%' THEN RAISE; END IF;END;
END $mixed_channel_activation_blocked$;
SET LOCAL ROLE r72_owner;
DO $mixed_no_run$ BEGIN
 IF EXISTS(SELECT 1 FROM app_private.mhp_followup_runs WHERE sequence_version_id='ed127400-0000-4000-8000-000000000003') THEN RAISE EXCEPTION 'Mixed channel failure left enrolment effects';END IF;
END $mixed_no_run$;
SELECT 'GHQ-FOLLOWUP-006A sequence proof reached its final assertion' AS proof;
-- Root appends expected rollback sentinel; never commit fixture data.
