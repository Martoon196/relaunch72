-- GHQ006D1 Root-only disposable127+128 rollback proof; synthetic data only.
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

SET LOCAL ROLE r72_mhp_prospect_definer;
DO $sequence_bytes$
DECLARE d jsonb; body text; manifest text; brand jsonb:=app_private.mhp_owner_email_brand(); sha text;
BEGIN
 SELECT encode(content_sha256,'hex') INTO sha FROM app.company_content_versions WHERE id='ed126400-0000-4000-8000-000000000001';
 d:=jsonb_build_object('schema','growthhq.followup-sequence/v2','entry',jsonb_build_object('mode','webinar_signup','source','mhp.capture/v2'),'brand','mhp','campaign','webinar-ghq005-proof','title','Two messages café £','expiryHours',24,
  'stopOn',jsonb_build_object('reply',false,'booked',false,'purchased',false),'steps',jsonb_build_array(
   jsonb_build_object('key','first','kind','email','contentItemId','ed126300-0000-4000-8000-000000000001','contentVersionId','ed126400-0000-4000-8000-000000000001','contentSha256',sha),
   jsonb_build_object('key','wait','kind','wait','minutes',60),
   jsonb_build_object('key','second','kind','email','contentItemId','ed126300-0000-4000-8000-000000000001','contentVersionId','ed126400-0000-4000-8000-000000000001','contentSha256',sha)));
 body:=app_private.mhp_sequence_canonical(d);sha:=encode(public.digest(body,'sha256'),'hex');
 manifest:=app_private.mhp_sequence_canonical(jsonb_build_object('schema','mhp.followup-sequence-source/v1','workspaceId','2789228d-55a6-4688-b1e8-2f70abca990b',
  'sourceSystem','mhp.followup-sequence','sourceItemId','sequence:ed128300-0000-4000-8000-000000000001','sourceVersion','edit:ed128400-0000-4000-8000-000000000001',
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
 VALUES('ed128300-0000-4000-8000-000000000001','2789228d-55a6-4688-b1e8-2f70abca990b','mhp.followup-sequence','sequence:ed128300-0000-4000-8000-000000000001',actor,'isolated-ghq006-save');
 INSERT INTO app.company_content_versions(id,workspace_id,content_item_id,version_number,origin,content_kind,title,source_system,source_item_id,source_version,
  content_mime_type,content_body,blob_storage_key,blob_sha256,brand_snapshot_ref,brand_sha256,metadata,created_by_user_id,created_request_id)
 VALUES('ed128400-0000-4000-8000-000000000001','2789228d-55a6-4688-b1e8-2f70abca990b','ed128300-0000-4000-8000-000000000001',1,'imported','other','Two messages café £',
  'mhp.followup-sequence','sequence:ed128300-0000-4000-8000-000000000001','edit:ed128400-0000-4000-8000-000000000001','application/vnd.growthhq.followup-sequence+json',body,
  'inline:mhp.followup-sequence:'||encode(sha,'hex'),sha,brand->>'ref',decode(brand->>'sha256','hex'),
  jsonb_build_object('mhpSequence',jsonb_build_object('schema','mhp.followup-sequence-local/v1','brandCanonical',brand->>'canonical','manifestCanonical',manifest,
   'manifestSha256',encode(public.digest(manifest,'sha256'),'hex'),'authoredBy','native-owner')),actor,'isolated-ghq006-save');
 INSERT INTO app.company_content_source_attestations(workspace_id,content_item_id,content_version_id,source_system,source_item_id,source_version,
  content_sha256,blob_sha256,brand_sha256,source_catalog_sha256,checked_at,expires_at,attested_by_user_id,attested_request_id)
 VALUES('2789228d-55a6-4688-b1e8-2f70abca990b','ed128300-0000-4000-8000-000000000001','ed128400-0000-4000-8000-000000000001','mhp.followup-sequence',
  'sequence:ed128300-0000-4000-8000-000000000001','edit:ed128400-0000-4000-8000-000000000001',sha,sha,decode(brand->>'sha256','hex'),public.digest(manifest,'sha256'),checked,checked+interval '15 minutes',actor,'isolated-ghq006-save');
END $sequence_save$;
SET LOCAL ROLE r72_identity_command;
DO $sequence_unapproved$ BEGIN
 BEGIN PERFORM app_private.mhp_sequence_command(public.digest('editor-owner','sha256'),'enrol','ed128500-0000-4000-8000-000000000001','ed128400-0000-4000-8000-000000000001','webinar-ghq005-proof',NULL,NULL,'isolated-ghq006-unapproved');
 RAISE EXCEPTION 'Unpublished sequence enrolled';EXCEPTION WHEN check_violation THEN NULL;END;
END $sequence_unapproved$;
SET LOCAL ROLE r72_content_command;
DO $sequence_publish$ DECLARE actor uuid:=current_setting('mhp.editor.actor')::uuid;BEGIN
 INSERT INTO app.company_content_approval_requests(id,workspace_id,content_item_id,content_version_id,content_sha256,request_number,requested_by_user_id,requested_request_id)
 SELECT 'ed128600-0000-4000-8000-000000000001',workspace_id,content_item_id,id,content_sha256,1,actor,'isolated-ghq006-publish' FROM app.company_content_versions WHERE id='ed128400-0000-4000-8000-000000000001';
 INSERT INTO app.company_content_approval_decisions(id,workspace_id,content_item_id,content_version_id,approval_request_id,content_sha256,decision,decided_by_user_id,decided_request_id)
 SELECT 'ed128700-0000-4000-8000-000000000001',workspace_id,content_item_id,content_version_id,id,content_sha256,'approved',actor,'isolated-ghq006-publish' FROM app.company_content_approval_requests WHERE id='ed128600-0000-4000-8000-000000000001';
END $sequence_publish$;
SET LOCAL ROLE r72_owner;
DO $sequence_publish_no_effect$ BEGIN
 IF EXISTS(SELECT 1 FROM app_private.mhp_followup_runs) OR EXISTS(SELECT 1 FROM app_private.mhp_marketing_sends WHERE sequence_run_id IS NOT NULL)
 THEN RAISE EXCEPTION 'Save or publish created a run/delivery'; END IF;
END $sequence_publish_no_effect$;
SET LOCAL ROLE r72_owner;
DO $entry_grants$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['mhp_sequence_entry_rules','mhp_sequence_entry_receipts'] LOOP
  IF has_table_privilege('r72_web','app_private.'||t,'SELECT,INSERT,UPDATE,DELETE') OR has_table_privilege('r72_identity_command','app_private.'||t,'SELECT,INSERT,UPDATE,DELETE')
   OR NOT EXISTS(SELECT 1 FROM pg_class WHERE oid=('app_private.'||t)::regclass AND relrowsecurity AND relforcerowsecurity)
   OR NOT EXISTS(SELECT 1 FROM app_private.workspace_table_registry WHERE schema_name='app_private' AND table_name=t AND workspace_column='workspace_id') THEN RAISE EXCEPTION 'Entry table boundary failed %',t; END IF;
 END LOOP;
 IF has_function_privilege('r72_identity_command','app_private.mhp_sequence_prepare_0127(uuid,uuid)','EXECUTE')
  OR has_function_privilege('r72_identity_command','app_private.mhp_sequence_run_allowed(uuid)','EXECUTE')
  OR has_sequence_privilege('r72_identity_command','app_private.mhp_capture_event_sequence','USAGE')
  OR has_schema_privilege('r72_mhp_prospect_definer','app_private','CREATE') THEN RAISE EXCEPTION 'Entry private helper boundary failed'; END IF;
 IF EXISTS(SELECT 1 FROM pg_proc p,aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE p.pronamespace='app_private'::regnamespace
  AND (p.proname LIKE 'mhp_sequence_%' OR p.proname='mhp_capture_signup_v2') AND a.grantee=0 AND a.privilege_type='EXECUTE') THEN RAISE EXCEPTION 'PUBLIC entry capability'; END IF;
 PERFORM set_config('mhp.entry.expires',(clock_timestamp()+interval '2 hours')::text,true);
END $entry_grants$;
SET LOCAL ROLE r72_identity_command;
DO $before_activation$ DECLARE event jsonb; BEGIN
 event:=app_private.mhp_capture_signup_v2('entry-before@example.invalid','Before',NULL,true,'isolated-entry','webinar','Before activation',NULL,'https://martinhowardproperty.co.uk/webinar/',NULL,'[]','webinar-ghq005-proof');
 IF event->>'signupId' IS NULL OR (event->>'entryEventSequence')::bigint<=0 THEN RAISE EXCEPTION 'Actual signup identity missing'; END IF;
 PERFORM set_config('mhp.entry.before',event::text,true);
 BEGIN PERFORM app_private.mhp_sequence_entry_command(public.digest('editor-member','sha256'),'activate',gen_random_uuid(),'ed128400-0000-4000-8000-000000000001','webinar-ghq005-proof',NULL,current_setting('mhp.entry.expires')::timestamptz,'entry-bad-owner');
  RAISE EXCEPTION 'Ordinary member activated entry';EXCEPTION WHEN insufficient_privilege THEN NULL;END;
 BEGIN PERFORM app_private.mhp_sequence_entry_command(public.digest('editor-owner','sha256'),'activate',gen_random_uuid(),'ed128400-0000-4000-8000-000000000001','wrong-campaign',NULL,current_setting('mhp.entry.expires')::timestamptz,'entry-bad-campaign');
  RAISE EXCEPTION 'Wrong campaign activated';EXCEPTION WHEN check_violation THEN NULL;END;
 BEGIN PERFORM app_private.mhp_capture_signup_v2('entry-bad@example.invalid','Bad',NULL,true,'isolated-entry','webinar','Bad',NULL,NULL,NULL,'[{"template":"webinar_confirm","campaign":"other"}]','webinar-ghq005-proof');
  RAISE EXCEPTION 'Browser schedule retargeted campaign';EXCEPTION WHEN invalid_parameter_value THEN NULL;END;
END $before_activation$;
DO $activate$ DECLARE a jsonb;b jsonb; BEGIN
 a:=app_private.mhp_sequence_entry_command(public.digest('editor-owner','sha256'),'activate','ed128500-0000-4000-8000-000000000001','ed128400-0000-4000-8000-000000000001','webinar-ghq005-proof',NULL,current_setting('mhp.entry.expires')::timestamptz,'entry-enable');
 b:=app_private.mhp_sequence_entry_command(public.digest('editor-owner','sha256'),'activate','ed128500-0000-4000-8000-000000000001','ed128400-0000-4000-8000-000000000001','webinar-ghq005-proof',NULL,current_setting('mhp.entry.expires')::timestamptz,'entry-enable-replay');
 IF a->>'state'<>'active' OR NOT(b->>'replayed')::boolean OR a->>'ruleId'<>b->>'ruleId' OR a->>'watermark'<>current_setting('mhp.entry.before')::jsonb->>'entryEventSequence' THEN RAISE EXCEPTION 'Activation/replay/watermark failed'; END IF;
 PERFORM set_config('mhp.entry.rule',a->>'ruleId',true);
 IF(app_private.mhp_sequence_enrol_captures(100)->>'processed')::integer<>0 THEN RAISE EXCEPTION 'Activation backfilled history'; END IF;
END $activate$;
DO $captures$ DECLARE event jsonb; BEGIN
 event:=app_private.mhp_capture_signup_v2('entry-valid@example.invalid','Valid',NULL,true,'isolated-entry','webinar','Exact genuine webinar','', 'https://martinhowardproperty.co.uk/webinar/',NULL,'[]','webinar-ghq005-proof');
 PERFORM set_config('mhp.entry.valid',event::text,true);
 PERFORM app_private.mhp_capture_signup_v2('entry-valid@example.invalid','Valid',NULL,true,'isolated-entry','webinar','Duplicate capture',NULL,NULL,NULL,'[]','webinar-ghq005-proof');
 PERFORM app_private.mhp_capture_signup_v2('entry-noconsent@example.invalid','No consent',NULL,false,'isolated-entry','webinar','No consent',NULL,NULL,NULL,'[]','webinar-ghq005-proof');
 event:=app_private.mhp_capture_signup_v2('entry-unsub@example.invalid','Unsubscribe',NULL,true,'isolated-entry','webinar','Unsubscribe',NULL,NULL,NULL,'[]','webinar-ghq005-proof');
 PERFORM set_config('mhp.entry.unsub',event->>'prospectId',true);
 PERFORM app_private.mhp_capture_signup_v2('entry-other@example.invalid','Other',NULL,true,'isolated-entry','webinar','Other campaign',NULL,NULL,NULL,'[]','webinar-other-proof');
 PERFORM app_private.mhp_capture_signup('entry-old@example.invalid','Old producer',NULL,true,'isolated-entry','webinar','Old producer',NULL,NULL,NULL,'[]');
END $captures$;
SET LOCAL ROLE r72_owner;
UPDATE app_private.mhp_prospects SET unsubscribed_at=clock_timestamp() WHERE id=current_setting('mhp.entry.unsub')::uuid;
SET LOCAL ROLE r72_identity_command;
DO $consume$ DECLARE a jsonb;b jsonb; BEGIN
 a:=app_private.mhp_sequence_enrol_captures(100);b:=app_private.mhp_sequence_enrol_captures(100);
 IF (a->>'processed')::integer<>4 OR (a->>'enrolled')::integer<>1 OR (a->>'alreadyEnrolled')::integer<>1 OR (a->>'skipped')::integer<>1 OR (a->>'blocked')::integer<>1
  OR (b->>'processed')::integer<>0 THEN RAISE EXCEPTION 'Exact capture dedupe/consent/cursor failed: %',a; END IF;
END $consume$;
SET LOCAL ROLE r72_owner;
DO $receipt$ DECLARE r app_private.mhp_followup_runs%ROWTYPE; BEGIN
 SELECT * INTO r FROM app_private.mhp_followup_runs WHERE entry_rule_id=current_setting('mhp.entry.rule')::uuid;
 IF r.id IS NULL OR r.prospect_id<>(current_setting('mhp.entry.valid')::jsonb->>'prospectId')::uuid OR r.entry_signup_id<>(current_setting('mhp.entry.valid')::jsonb->>'signupId')::uuid
  OR EXISTS(SELECT 1 FROM app_private.mhp_marketing_sends WHERE prospect_id=r.prospect_id AND owner_content_version_id IS NULL)
  OR NOT app_private.mhp_sequence_run_allowed(r.id) THEN RAISE EXCEPTION 'Run not linked to genuine unanchored capture'; END IF;
 PERFORM set_config('mhp.entry.run',r.id::text,true);
 BEGIN UPDATE app_private.mhp_sequence_entry_receipts SET reason='current_permission' WHERE run_id=r.id;RAISE EXCEPTION 'Receipt mutated';EXCEPTION WHEN check_violation THEN NULL;END;
 BEGIN UPDATE app_private.mhp_prospect_signups SET consent_given=false WHERE id=r.entry_signup_id;RAISE EXCEPTION 'Accepted event mutated';EXCEPTION WHEN check_violation THEN NULL;END;
 BEGIN UPDATE app_private.mhp_followup_runs SET entry_signup_id=NULL WHERE id=r.id;RAISE EXCEPTION 'Partial run link accepted';EXCEPTION WHEN check_violation THEN NULL;END;
 PERFORM set_config('mhp.entry.run_digest',(SELECT md5(string_agg(row_to_json(x)::text,'' ORDER BY x.id)) FROM app_private.mhp_followup_runs x WHERE entry_rule_id IS NOT NULL),true);
END $receipt$;
SET LOCAL ROLE r72_identity_command;
DO $old_exclusion$ DECLARE old jsonb;lease jsonb; BEGIN
 old:=app_private.mhp_sequence_claim(25,120,ARRAY['entry-valid@example.invalid']);
 IF jsonb_array_length(old)<>0 THEN RAISE EXCEPTION 'Old claim consumed auto entry';END IF;
END $old_exclusion$;
SET LOCAL ROLE r72_owner;
DO $old_untouched$ BEGIN
 IF current_setting('mhp.entry.run_digest') IS DISTINCT FROM (SELECT md5(string_agg(row_to_json(x)::text,'' ORDER BY x.id)) FROM app_private.mhp_followup_runs x WHERE entry_rule_id IS NOT NULL) THEN RAISE EXCEPTION 'Old maintenance mutated automatic run';END IF;
END $old_untouched$;
SET LOCAL ROLE r72_identity_command;
DO $off_delivery$ DECLARE lease jsonb;proof jsonb;off_result jsonb; BEGIN
 lease:=app_private.mhp_sequence_claim_v2(25,120,ARRAY['entry-valid@example.invalid']);
 IF jsonb_array_length(lease)<>1 THEN RAISE EXCEPTION 'New claim failed unanchored entry'; END IF;
 PERFORM set_config('mhp.entry.lease',(lease->0)::text,true);
 off_result:=app_private.mhp_sequence_entry_command(public.digest('editor-owner','sha256'),'off','ed128500-0000-4000-8000-000000000002','ed128400-0000-4000-8000-000000000001','webinar-ghq005-proof',current_setting('mhp.entry.rule')::uuid,NULL,'entry-off');
 IF app_private.mhp_sequence_prepare((lease->0->>'id')::uuid,(lease->0->>'leaseId')::uuid) IS NOT NULL THEN RAISE EXCEPTION 'Old prepare consumed auto';END IF;
 proof:=app_private.mhp_sequence_prepare_v2((lease->0->>'id')::uuid,(lease->0->>'leaseId')::uuid);
 IF proof IS NULL OR proof->'context'->>'label'<>'Exact genuine webinar' OR proof->'exact'->>'canonicalContent'<>current_setting('mhp.editor.canonical') THEN RAISE EXCEPTION 'Rule off revoked accepted run or prepare audience was anchored'; END IF;
 PERFORM app_private.mhp_settle_owner_marketing_send((lease->0->>'id')::uuid,(lease->0->>'leaseId')::uuid,true,'synthetic-entry-acceptance-not-provider');
 PERFORM app_private.mhp_capture_signup_v2('entry-after-off@example.invalid','After off',NULL,true,'isolated-entry','webinar','After off',NULL,NULL,NULL,'[]','webinar-ghq005-proof');
 IF(app_private.mhp_sequence_enrol_captures(100)->>'processed')::integer<>0 THEN RAISE EXCEPTION 'Off rule still entered'; END IF;
END $off_delivery$;
SET LOCAL ROLE r72_owner;
DO $relative_wait$ DECLARE r app_private.mhp_followup_runs%ROWTYPE; BEGIN
 SELECT * INTO r FROM app_private.mhp_followup_runs WHERE id=current_setting('mhp.entry.run')::uuid;
 IF r.position<>2 OR r.state<>'active' OR r.due_at<r.last_accepted_at+interval '60 minutes' OR r.current_send_id IS NOT NULL THEN RAISE EXCEPTION 'Existing127 relative wait regressed'; END IF;
END $relative_wait$;
SET LOCAL ROLE r72_identity_command;
DO $manual_coexistence$ DECLARE result jsonb; BEGIN
 result:=app_private.mhp_sequence_command(public.digest('editor-owner','sha256'),'enrol','ed128500-0000-4000-8000-000000000003','ed128400-0000-4000-8000-000000000001','webinar-ghq005-proof',NULL,NULL,'entry-manual-coexist');
 IF(result->>'changed')::integer<>3 THEN RAISE EXCEPTION 'Manual audience changed or synthetic capture was imported';END IF;
 result:=app_private.mhp_sequence_entry_command(public.digest('editor-owner','sha256'),'activate','ed128500-0000-4000-8000-000000000004','ed128400-0000-4000-8000-000000000001','webinar-ghq005-proof',NULL,current_setting('mhp.entry.expires')::timestamptz,'entry-reenable');
 PERFORM set_config('mhp.entry.rule2',result->>'ruleId',true);
END $manual_coexistence$;
DO $backlog_capture$ DECLARE n integer; BEGIN
 FOR n IN 1..501 LOOP
  PERFORM app_private.mhp_capture_signup_v2('entry-blocked-'||n||'@example.invalid','Blocked prefix',NULL,false,'isolated-entry','webinar','Blocked',NULL,NULL,NULL,'[]','webinar-ghq005-proof');
 END LOOP;
 PERFORM app_private.mhp_capture_signup_v2('entry-backlog-target@example.invalid','After prefix',NULL,true,'isolated-entry','webinar','Target',NULL,NULL,NULL,'[]','webinar-ghq005-proof');
END $backlog_capture$;
DO $backlog_consume$ DECLARE n integer;r jsonb;total integer:=0;enrolled integer:=0;BEGIN
 FOR n IN 1..6 LOOP
  r:=app_private.mhp_sequence_enrol_captures(100);IF(r->>'processed')::integer>100 THEN RAISE EXCEPTION 'Unbounded entry sweep';END IF;
  total:=total+(r->>'processed')::integer;enrolled:=enrolled+(r->>'enrolled')::integer;
 END LOOP;
 IF total<>502 OR enrolled<>1 THEN RAISE EXCEPTION 'Blocked prefix starved cursor: %/%',total,enrolled;END IF;
END $backlog_consume$;
SET LOCAL ROLE r72_web;
DO $entry_snapshot$ DECLARE r jsonb;BEGIN
 r:=app_private.mhp_sequence_snapshot(public.digest('editor-owner','sha256'),'webinar-ghq005-proof');
 IF jsonb_array_length(r->'entryRules')<>2 OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(r->'entryRules') x WHERE (x->>'processed')::integer=502 AND (x->>'enrolled')::integer=1)
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(r->'runs') x WHERE x->>'definitionSchema' IS DISTINCT FROM 'growthhq.followup-sequence/v2') THEN RAISE EXCEPTION 'Honest rule/cursor/schema snapshot failed';END IF;
END $entry_snapshot$;
SET LOCAL ROLE r72_identity_command;
DO $recovery$ DECLARE r jsonb;BEGIN
 r:=app_private.mhp_hold_sequence_entry();
 IF(r->>'heldRules')::integer<1 OR(r->>'resumed')::integer<>0 OR(app_private.mhp_sequence_enrol_captures(100)->>'processed')::integer<>0 THEN RAISE EXCEPTION 'Recovery enabled or failed to hold entry';END IF;
END $recovery$;
-- Root appends the expected rollback sentinel. Never commit synthetic fixture data.
SET LOCAL ROLE r72_identity_command;
DO $entry_expiry_and_reenable$ DECLARE r jsonb; BEGIN
 BEGIN PERFORM app_private.mhp_sequence_entry_command(public.digest('editor-owner','sha256'),'activate',gen_random_uuid(),'ed128400-0000-4000-8000-000000000001','webinar-ghq005-proof',NULL,clock_timestamp()-interval '1 second','entry-expired-action');
  RAISE EXCEPTION 'Past expiry activated';EXCEPTION WHEN invalid_parameter_value THEN NULL;END;
 r:=app_private.mhp_sequence_entry_command(public.digest('editor-owner','sha256'),'activate','ed128500-0000-4000-8000-000000000005','ed128400-0000-4000-8000-000000000001','webinar-ghq005-proof',NULL,current_setting('mhp.entry.expires')::timestamptz,'entry-after-recovery');
 PERFORM set_config('mhp.entry.rule3',r->>'ruleId',true);
 -- Existing manual enrolment of this exact version must not be repeated by capture.
 PERFORM app_private.mhp_capture_signup_v2('editor-1@example.invalid','Manual already',NULL,true,'isolated-entry','webinar','Manual duplicate',NULL,NULL,NULL,'[]','webinar-ghq005-proof');
 PERFORM app_private.mhp_capture_signup_v2('entry-after-recovery@example.invalid','New exact run',NULL,true,'isolated-entry','webinar','Post recovery',NULL,NULL,NULL,'[]','webinar-ghq005-proof');
 r:=app_private.mhp_sequence_enrol_captures(100);
 IF(r->>'processed')::integer<>2 OR(r->>'alreadyEnrolled')::integer<>1 OR(r->>'enrolled')::integer<>1 THEN RAISE EXCEPTION 'Manual/auto duplicate or recovery cursor changed';END IF;
 r:=app_private.mhp_sequence_entry_command(public.digest('editor-owner','sha256'),'activate','ed128500-0000-4000-8000-000000000001','ed128400-0000-4000-8000-000000000001','webinar-ghq005-proof',NULL,current_setting('mhp.entry.expires')::timestamptz,'entry-historical-replay');
 IF NOT(r->>'replayed')::boolean OR r->>'ruleId'<>current_setting('mhp.entry.rule') THEN RAISE EXCEPTION 'Historical receipt replay changed';END IF;
END $entry_expiry_and_reenable$;
SET LOCAL ROLE r72_owner;
DO $entry_current_unsubscribe$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM app_private.mhp_sequence_entry_rules WHERE id=current_setting('mhp.entry.rule3')::uuid AND disabled_at IS NULL AND held_at IS NULL)
  OR EXISTS(SELECT 1 FROM app_private.mhp_sequence_entry_rules WHERE id=current_setting('mhp.entry.rule')::uuid AND disabled_at IS NULL) THEN RAISE EXCEPTION 'Historical replay reactivated old rule';END IF;
 UPDATE app_private.mhp_prospects SET unsubscribed_at=clock_timestamp() WHERE id=(current_setting('mhp.entry.valid')::jsonb->>'prospectId')::uuid;
 IF app_private.mhp_sequence_run_allowed(current_setting('mhp.entry.run')::uuid) THEN RAISE EXCEPTION 'Current unsubscribe ignored';END IF;
END $entry_current_unsubscribe$;
SET LOCAL ROLE r72_identity_command;
DO $entry_unsub_terminal$ BEGIN
 PERFORM app_private.mhp_sequence_claim_v2(25,120,ARRAY['entry-valid@example.invalid']);
END $entry_unsub_terminal$;
SET LOCAL ROLE r72_owner;
DO $entry_unsub_assert$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM app_private.mhp_followup_runs WHERE id=current_setting('mhp.entry.run')::uuid AND state='stopped' AND reason='unsubscribed') THEN RAISE EXCEPTION 'Automatic run not stopped on unsubscribe';END IF;
 -- Synthetic expired activation only, to prove the consumer's clock filter without sleeping.
 UPDATE app_private.mhp_sequence_entry_rules SET disabled_at=clock_timestamp() WHERE id=current_setting('mhp.entry.rule3')::uuid;
 INSERT INTO app_private.mhp_sequence_entry_rules(id,workspace_id,sequence_item_id,sequence_version_id,sequence_sha256,sequence_approval_id,owner_user_id,campaign,activated_at,expires_at,activation_sequence,cursor_sequence)
 SELECT 'ed128800-0000-4000-8000-000000000001',workspace_id,sequence_item_id,sequence_version_id,sequence_sha256,sequence_approval_id,owner_user_id,campaign,
  clock_timestamp()-interval '2 hours',clock_timestamp()-interval '1 hour',cursor_sequence,cursor_sequence FROM app_private.mhp_sequence_entry_rules WHERE id=current_setting('mhp.entry.rule3')::uuid;
END $entry_unsub_assert$;
SET LOCAL ROLE r72_identity_command;
DO $entry_expired_consumer$ DECLARE r jsonb;BEGIN
 PERFORM app_private.mhp_capture_signup_v2('entry-expired-rule@example.invalid','Expired',NULL,true,'isolated-entry','webinar','Expired rule',NULL,NULL,NULL,'[]','webinar-ghq005-proof');
 IF(app_private.mhp_sequence_enrol_captures(100)->>'processed')::integer<>0 THEN RAISE EXCEPTION 'Expired activation consumed new signup';END IF;
 PERFORM app_private.mhp_sequence_entry_command(public.digest('editor-owner','sha256'),'off',gen_random_uuid(),'ed128400-0000-4000-8000-000000000001','webinar-ghq005-proof','ed128800-0000-4000-8000-000000000001',NULL,'entry-expired-off');
 r:=app_private.mhp_sequence_entry_command(public.digest('editor-owner','sha256'),'activate','ed128500-0000-4000-8000-000000000006','ed128400-0000-4000-8000-000000000001','webinar-ghq005-proof',NULL,current_setting('mhp.entry.expires')::timestamptz,'entry-before-newdraft');
 PERFORM set_config('mhp.entry.rule4',r->>'ruleId',true);
END $entry_expired_consumer$;
SET LOCAL ROLE r72_mhp_prospect_definer;
DO $sequence_revision_bytes$
DECLARE d jsonb;body text;manifest text;sha text;old app.company_content_versions%ROWTYPE;
BEGIN
 SELECT * INTO old FROM app.company_content_versions WHERE id='ed128400-0000-4000-8000-000000000001';
 d:=jsonb_set(old.content_body::jsonb,'{title}','"New sequence version café £"'::jsonb);body:=app_private.mhp_sequence_canonical(d);sha:=encode(public.digest(body,'sha256'),'hex');
 manifest:=app_private.mhp_sequence_canonical((old.metadata->'mhpSequence'->>'manifestCanonical')::jsonb||jsonb_build_object('sourceVersion','edit:ed128400-0000-4000-8000-000000000002',
  'contentSha256',sha,'blobSha256',sha,'blobStorageKey','inline:mhp.followup-sequence:'||sha));
 PERFORM set_config('mhp.sequence.revision_body',body,true);PERFORM set_config('mhp.sequence.revision_manifest',manifest,true);
END $sequence_revision_bytes$;
SET LOCAL ROLE r72_content_adapter;
DO $sequence_revision_save$
DECLARE body text:=current_setting('mhp.sequence.revision_body');manifest text:=current_setting('mhp.sequence.revision_manifest');checked timestamptz:=clock_timestamp();
BEGIN
 INSERT INTO app.company_content_versions(id,workspace_id,content_item_id,version_number,previous_version_id,origin,content_kind,title,source_system,source_item_id,source_version,
  content_mime_type,content_body,blob_storage_key,blob_sha256,brand_snapshot_ref,brand_sha256,metadata,created_by_user_id,created_request_id)
 SELECT 'ed128400-0000-4000-8000-000000000002',workspace_id,content_item_id,2,id,'edited',content_kind,'New sequence version café £',source_system,source_item_id,'edit:ed128400-0000-4000-8000-000000000002',
  content_mime_type,body,'inline:mhp.followup-sequence:'||encode(public.digest(body,'sha256'),'hex'),public.digest(body,'sha256'),brand_snapshot_ref,brand_sha256,
  jsonb_build_object('mhpSequence',(metadata->'mhpSequence')||jsonb_build_object('manifestCanonical',manifest,'manifestSha256',encode(public.digest(manifest,'sha256'),'hex'))),created_by_user_id,'isolated-ghq006-revision'
 FROM app.company_content_versions WHERE id='ed128400-0000-4000-8000-000000000001';
 INSERT INTO app.company_content_source_attestations(workspace_id,content_item_id,content_version_id,source_system,source_item_id,source_version,
  content_sha256,blob_sha256,brand_sha256,source_catalog_sha256,checked_at,expires_at,attested_by_user_id,attested_request_id)
 SELECT workspace_id,content_item_id,id,source_system,source_item_id,source_version,content_sha256,blob_sha256,brand_sha256,public.digest(manifest,'sha256'),checked,checked+interval '15 minutes',created_by_user_id,'isolated-ghq006-revision'
 FROM app.company_content_versions WHERE id='ed128400-0000-4000-8000-000000000002';
END $sequence_revision_save$;

SET LOCAL ROLE r72_owner;
DO $entry_newdraft_hold$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM app_private.mhp_sequence_entry_rules WHERE id=current_setting('mhp.entry.rule4')::uuid AND held_at IS NOT NULL AND held_reason='newer_sequence' AND sequence_version_id='ed128400-0000-4000-8000-000000000001')
  OR EXISTS(SELECT 1 FROM app_private.mhp_followup_runs WHERE sequence_version_id='ed128400-0000-4000-8000-000000000002') THEN RAISE EXCEPTION 'New draft retargeted or failed to hold rule';END IF;
END $entry_newdraft_hold$;
SET LOCAL ROLE r72_identity_command;
DO $entry_newdraft_consumption$ BEGIN
 PERFORM app_private.mhp_capture_signup_v2('entry-after-newdraft@example.invalid','Newdraft held',NULL,true,'isolated-entry','webinar','Newdraft held',NULL,NULL,NULL,'[]','webinar-ghq005-proof');
 IF(app_private.mhp_sequence_enrol_captures(100)->>'processed')::integer<>0 THEN RAISE EXCEPTION 'New draft rule still consumed';END IF;
 BEGIN PERFORM app_private.mhp_sequence_entry_command(public.digest('editor-owner','sha256'),'activate',gen_random_uuid(),'ed128400-0000-4000-8000-000000000001','webinar-ghq005-proof',NULL,current_setting('mhp.entry.expires')::timestamptz,'entry-stale-activation');
  RAISE EXCEPTION 'Stale version activated';EXCEPTION WHEN check_violation THEN NULL;END;
END $entry_newdraft_consumption$;
