-- GHQ006E Root-only SPLIT128+129 rollback proof; zero provider calls.
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
SET LOCAL ROLE r72_mhp_prospect_definer;
DO $sequence_bytes$
DECLARE d jsonb; body text; manifest text; brand jsonb:=app_private.mhp_owner_email_brand(); sha text;
BEGIN
 SELECT encode(content_sha256,'hex') INTO sha FROM app.company_content_versions WHERE id='ed126400-0000-4000-8000-000000000001';
 d:=jsonb_build_object('schema','growthhq.followup-sequence/v2','entry',jsonb_build_object('mode','webinar_signup','source','mhp.capture/v2'),'brand','mhp','campaign','webinar-ghq005-proof','title','Legacy planned SMS reference','expiryHours',24,
  'stopOn',jsonb_build_object('reply',false,'booked',false,'purchased',false),'steps',jsonb_build_array(
   jsonb_build_object('key','first','kind','sms','contentItemId','ed126300-0000-4000-8000-000000000001','contentVersionId','ed126400-0000-4000-8000-000000000001','contentSha256',sha),
   jsonb_build_object('key','wait','kind','wait','minutes',60),
   jsonb_build_object('key','second','kind','email','contentItemId','ed126300-0000-4000-8000-000000000001','contentVersionId','ed126400-0000-4000-8000-000000000001','contentSha256',sha)));
 body:=app_private.mhp_sequence_canonical(d);sha:=encode(public.digest(body,'sha256'),'hex');
 manifest:=app_private.mhp_sequence_canonical(jsonb_build_object('schema','mhp.followup-sequence-source/v1','workspaceId','2789228d-55a6-4688-b1e8-2f70abca990b',
  'sourceSystem','mhp.followup-sequence','sourceItemId','sequence:ed129300-0000-4000-8000-000000000099','sourceVersion','edit:ed129400-0000-4000-8000-000000000099',
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
 VALUES('ed129300-0000-4000-8000-000000000099','2789228d-55a6-4688-b1e8-2f70abca990b','mhp.followup-sequence','sequence:ed129300-0000-4000-8000-000000000099',actor,'isolated-ghq006-save');
 INSERT INTO app.company_content_versions(id,workspace_id,content_item_id,version_number,origin,content_kind,title,source_system,source_item_id,source_version,
  content_mime_type,content_body,blob_storage_key,blob_sha256,brand_snapshot_ref,brand_sha256,metadata,created_by_user_id,created_request_id)
 VALUES('ed129400-0000-4000-8000-000000000099','2789228d-55a6-4688-b1e8-2f70abca990b','ed129300-0000-4000-8000-000000000099',1,'imported','other','Legacy planned SMS reference',
  'mhp.followup-sequence','sequence:ed129300-0000-4000-8000-000000000099','edit:ed129400-0000-4000-8000-000000000099','application/vnd.growthhq.followup-sequence+json',body,
  'inline:mhp.followup-sequence:'||encode(sha,'hex'),sha,brand->>'ref',decode(brand->>'sha256','hex'),
  jsonb_build_object('mhpSequence',jsonb_build_object('schema','mhp.followup-sequence-local/v1','brandCanonical',brand->>'canonical','manifestCanonical',manifest,
   'manifestSha256',encode(public.digest(manifest,'sha256'),'hex'),'authoredBy','native-owner')),actor,'isolated-ghq006-save');
 INSERT INTO app.company_content_source_attestations(workspace_id,content_item_id,content_version_id,source_system,source_item_id,source_version,
  content_sha256,blob_sha256,brand_sha256,source_catalog_sha256,checked_at,expires_at,attested_by_user_id,attested_request_id)
 VALUES('2789228d-55a6-4688-b1e8-2f70abca990b','ed129300-0000-4000-8000-000000000099','ed129400-0000-4000-8000-000000000099','mhp.followup-sequence',
  'sequence:ed129300-0000-4000-8000-000000000099','edit:ed129400-0000-4000-8000-000000000099',sha,sha,decode(brand->>'sha256','hex'),public.digest(manifest,'sha256'),checked,checked+interval '15 minutes',actor,'isolated-ghq006-save');
END $sequence_save$;
SET LOCAL ROLE r72_identity_command;
DO $sequence_unapproved$ BEGIN
 BEGIN PERFORM app_private.mhp_sequence_command(public.digest('editor-owner','sha256'),'enrol','ed129500-0000-4000-8000-000000000099','ed129400-0000-4000-8000-000000000099','webinar-ghq005-proof',NULL,NULL,'isolated-ghq006-unapproved');
 RAISE EXCEPTION 'Unpublished sequence enrolled';EXCEPTION WHEN check_violation THEN NULL;END;
END $sequence_unapproved$;
SET LOCAL ROLE r72_content_command;
DO $sequence_publish$ DECLARE actor uuid:=current_setting('mhp.editor.actor')::uuid;BEGIN
 INSERT INTO app.company_content_approval_requests(id,workspace_id,content_item_id,content_version_id,content_sha256,request_number,requested_by_user_id,requested_request_id)
 SELECT 'ed129600-0000-4000-8000-000000000099',workspace_id,content_item_id,id,content_sha256,1,actor,'isolated-ghq006-publish' FROM app.company_content_versions WHERE id='ed129400-0000-4000-8000-000000000099';
 INSERT INTO app.company_content_approval_decisions(id,workspace_id,content_item_id,content_version_id,approval_request_id,content_sha256,decision,decided_by_user_id,decided_request_id)
 SELECT 'ed129700-0000-4000-8000-000000000099',workspace_id,content_item_id,content_version_id,id,content_sha256,'approved',actor,'isolated-ghq006-publish' FROM app.company_content_approval_requests WHERE id='ed129600-0000-4000-8000-000000000099';
END $sequence_publish$;
SET LOCAL ROLE r72_owner;
DO $sequence_publish_no_effect$ BEGIN
 IF EXISTS(SELECT 1 FROM app_private.mhp_followup_runs) OR EXISTS(SELECT 1 FROM app_private.mhp_marketing_sends WHERE sequence_run_id IS NOT NULL)
 THEN RAISE EXCEPTION 'Save or publish created a run/delivery'; END IF;
END $sequence_publish_no_effect$;

SET LOCAL ROLE r72_owner;
DO $legacy_before129$ BEGIN
 PERFORM set_config('flow.proof.legacy_hash',(SELECT encode(content_sha256,'hex') FROM app.company_content_versions WHERE id='ed129400-0000-4000-8000-000000000099'),true);
END $legacy_before129$;

-- GHQ006_APPLY_129_HERE
SET LOCAL ROLE r72_mhp_prospect_definer;
DO $channel_bytes$ DECLARE payload jsonb;body text;manifest text;brand jsonb:=app_private.mhp_owner_email_brand();channel text;n integer;items jsonb:='[]';item uuid;version uuid;BEGIN
 FOR n IN 1..2 LOOP
  channel:=CASE n WHEN 1 THEN 'sms' ELSE 'whatsapp' END;
  item:=('ed129300-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;version:=('ed129400-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;
  payload:=CASE n WHEN 1 THEN jsonb_build_object('schema','growthhq.sms-draft/v1','bodyText','Hi {{FIRSTNAME}}, sample café £47.')
   ELSE jsonb_build_object('schema','growthhq.whatsapp-template-draft/v1','templateName','sample_followup','language','en_GB','bodyText','Hi {{1}}, your sample {{2}}.') END;
  body:=app_private.mhp_sequence_canonical(payload);
  manifest:=app_private.mhp_sequence_canonical(jsonb_build_object('schema','mhp.channel-draft-source/v1','workspaceId','2789228d-55a6-4688-b1e8-2f70abca990b',
   'sourceSystem','mhp.owner-'||channel,'sourceItemId','owner-'||channel||':'||item::text,'sourceVersion','edit:'||version::text,'contentSha256',encode(public.digest(body,'sha256'),'hex'),
   'blobStorageKey','inline:mhp.owner-'||channel||':'||encode(public.digest(body,'sha256'),'hex'),'blobSha256',encode(public.digest(body,'sha256'),'hex'),
   'brandSnapshotRef',brand->>'ref','brandSha256',brand->>'sha256','channel',channel));
  items:=items||jsonb_build_array(jsonb_build_object('channel',channel,'item',item,'version',version,'body',body,'manifest',manifest));
 END LOOP;
 PERFORM set_config('flow.proof.messages',items::text,true);
END $channel_bytes$;
SET LOCAL ROLE r72_content_adapter;
DO $channel_save$ DECLARE m jsonb;brand jsonb:=current_setting('mhp.editor.brand')::jsonb;actor uuid:=current_setting('mhp.editor.actor')::uuid;checked timestamptz:=clock_timestamp();BEGIN
 FOR m IN SELECT value FROM jsonb_array_elements(current_setting('flow.proof.messages')::jsonb) LOOP
  INSERT INTO app.company_content_items(id,workspace_id,source_system,source_item_id,created_by_user_id,created_request_id)
  VALUES((m->>'item')::uuid,'2789228d-55a6-4688-b1e8-2f70abca990b','mhp.owner-'||(m->>'channel'),'owner-'||(m->>'channel')||':'||(m->>'item'),actor,'isolated006e-message');
  INSERT INTO app.company_content_versions(id,workspace_id,content_item_id,version_number,origin,content_kind,title,source_system,source_item_id,source_version,
   content_mime_type,content_body,blob_storage_key,blob_sha256,brand_snapshot_ref,brand_sha256,metadata,created_by_user_id,created_request_id)
  VALUES((m->>'version')::uuid,'2789228d-55a6-4688-b1e8-2f70abca990b',(m->>'item')::uuid,1,'imported','other','Synthetic local '||(m->>'channel'),
   'mhp.owner-'||(m->>'channel'),'owner-'||(m->>'channel')||':'||(m->>'item'),'edit:'||(m->>'version'),
   'application/vnd.growthhq.'||(CASE m->>'channel' WHEN 'sms' THEN 'sms-draft' ELSE 'whatsapp-template-draft' END)||'+json',m->>'body',
   'inline:mhp.owner-'||(m->>'channel')||':'||encode(public.digest(m->>'body','sha256'),'hex'),public.digest(m->>'body','sha256'),brand->>'ref',decode(brand->>'sha256','hex'),
   jsonb_build_object('mhpChannelDraft',jsonb_build_object('schema','mhp.channel-draft-local/v1','authoredBy','native-owner','brandCanonical',brand->>'canonical',
    'manifestCanonical',m->>'manifest','manifestSha256',encode(public.digest(m->>'manifest','sha256'),'hex'))),actor,'isolated006e-message');
  INSERT INTO app.company_content_source_attestations(workspace_id,content_item_id,content_version_id,source_system,source_item_id,source_version,
   content_sha256,blob_sha256,brand_sha256,source_catalog_sha256,checked_at,expires_at,attested_by_user_id,attested_request_id)
  VALUES('2789228d-55a6-4688-b1e8-2f70abca990b',(m->>'item')::uuid,(m->>'version')::uuid,'mhp.owner-'||(m->>'channel'),
   'owner-'||(m->>'channel')||':'||(m->>'item'),'edit:'||(m->>'version'),public.digest(m->>'body','sha256'),public.digest(m->>'body','sha256'),decode(brand->>'sha256','hex'),public.digest(m->>'manifest','sha256'),checked,checked+interval '15 minutes',actor,'isolated006e-message');
 END LOOP;
END $channel_save$;
SET LOCAL ROLE r72_mhp_prospect_definer;
DO $channel_exact$ DECLARE a jsonb;b jsonb;BEGIN
 a:=app_private.mhp_owner_channel_exact('ed129400-0000-4000-8000-000000000001',true);b:=app_private.mhp_owner_channel_exact('ed129400-0000-4000-8000-000000000002',true);
 IF a->>'channel'<>'sms' OR b->>'channel'<>'whatsapp' OR a->'payload'->>'bodyText'<>'Hi {{FIRSTNAME}}, sample café £47.' THEN RAISE EXCEPTION 'Proper local draft or unsupportedSMS text lost';END IF;
 BEGIN PERFORM app_private.mhp_owner_channel_exact('ed126400-0000-4000-8000-000000000001',true);RAISE EXCEPTION 'Email used as channel draft';EXCEPTION WHEN check_violation THEN NULL;END;
END $channel_exact$;
DO $mixed_bytes$ DECLARE old app.company_content_versions%ROWTYPE;d jsonb;body text;manifest text;brand jsonb:=app_private.mhp_owner_email_brand();BEGIN
 SELECT * INTO old FROM app.company_content_versions WHERE id='ed128400-0000-4000-8000-000000000001';
 d:=jsonb_set(old.content_body::jsonb,'{title}','"Mixed local channel blueprint"');
 d:=jsonb_set(d,'{steps}',jsonb_build_array(old.content_body::jsonb->'steps'->0,jsonb_build_object('key','wait','kind','wait','minutes',60),
  jsonb_build_object('key','text','kind','sms','contentItemId','ed129300-0000-4000-8000-000000000001','contentVersionId','ed129400-0000-4000-8000-000000000001',
   'contentSha256',encode(public.digest(current_setting('flow.proof.messages')::jsonb->0->>'body','sha256'),'hex')),
  jsonb_build_object('key','template','kind','whatsapp','contentItemId','ed129300-0000-4000-8000-000000000002','contentVersionId','ed129400-0000-4000-8000-000000000002',
   'contentSha256',encode(public.digest(current_setting('flow.proof.messages')::jsonb->1->>'body','sha256'),'hex'))));
 body:=app_private.mhp_sequence_canonical(d);
 manifest:=app_private.mhp_sequence_canonical(jsonb_build_object('schema','mhp.followup-sequence-source/v1','workspaceId','2789228d-55a6-4688-b1e8-2f70abca990b',
  'sourceSystem','mhp.followup-sequence','sourceItemId','sequence:ed129300-0000-4000-8000-000000000003','sourceVersion','edit:ed129400-0000-4000-8000-000000000003',
  'contentSha256',encode(public.digest(body,'sha256'),'hex'),'blobStorageKey','inline:mhp.followup-sequence:'||encode(public.digest(body,'sha256'),'hex'),'blobSha256',encode(public.digest(body,'sha256'),'hex'),
  'brandSnapshotRef',brand->>'ref','brandSha256',brand->>'sha256','audienceCampaign','webinar-ghq005-proof'));
 PERFORM set_config('flow.proof.mixed',jsonb_build_object('body',body,'manifest',manifest)::text,true);
END $mixed_bytes$;
SET LOCAL ROLE r72_content_adapter;
DO $mixed_save$ DECLARE m jsonb:=current_setting('flow.proof.mixed')::jsonb;brand jsonb:=current_setting('mhp.editor.brand')::jsonb;actor uuid:=current_setting('mhp.editor.actor')::uuid;checked timestamptz:=clock_timestamp();BEGIN
 INSERT INTO app.company_content_items(id,workspace_id,source_system,source_item_id,created_by_user_id,created_request_id)
 VALUES('ed129300-0000-4000-8000-000000000003','2789228d-55a6-4688-b1e8-2f70abca990b','mhp.followup-sequence','sequence:ed129300-0000-4000-8000-000000000003',actor,'isolated006e-mixed');
 INSERT INTO app.company_content_versions(id,workspace_id,content_item_id,version_number,origin,content_kind,title,source_system,source_item_id,source_version,
  content_mime_type,content_body,blob_storage_key,blob_sha256,brand_snapshot_ref,brand_sha256,metadata,created_by_user_id,created_request_id)
 VALUES('ed129400-0000-4000-8000-000000000003','2789228d-55a6-4688-b1e8-2f70abca990b','ed129300-0000-4000-8000-000000000003',1,'imported','other','Mixed local channel blueprint',
  'mhp.followup-sequence','sequence:ed129300-0000-4000-8000-000000000003','edit:ed129400-0000-4000-8000-000000000003','application/vnd.growthhq.followup-sequence+json',m->>'body',
  'inline:mhp.followup-sequence:'||encode(public.digest(m->>'body','sha256'),'hex'),public.digest(m->>'body','sha256'),brand->>'ref',decode(brand->>'sha256','hex'),
  jsonb_build_object('mhpSequence',jsonb_build_object('schema','mhp.followup-sequence-local/v1','authoredBy','native-owner','brandCanonical',brand->>'canonical','manifestCanonical',m->>'manifest','manifestSha256',encode(public.digest(m->>'manifest','sha256'),'hex'))),actor,'isolated006e-mixed');
 INSERT INTO app.company_content_source_attestations(workspace_id,content_item_id,content_version_id,source_system,source_item_id,source_version,
  content_sha256,blob_sha256,brand_sha256,source_catalog_sha256,checked_at,expires_at,attested_by_user_id,attested_request_id)
 VALUES('2789228d-55a6-4688-b1e8-2f70abca990b','ed129300-0000-4000-8000-000000000003','ed129400-0000-4000-8000-000000000003','mhp.followup-sequence',
  'sequence:ed129300-0000-4000-8000-000000000003','edit:ed129400-0000-4000-8000-000000000003',public.digest(m->>'body','sha256'),public.digest(m->>'body','sha256'),decode(brand->>'sha256','hex'),public.digest(m->>'manifest','sha256'),checked,checked+interval '15 minutes',actor,'isolated006e-mixed');
END $mixed_save$;
SET LOCAL ROLE r72_content_command;
DO $bundle_publish$ DECLARE n integer;version uuid;request_id uuid;BEGIN
 FOR n IN 1..3 LOOP
  version:=('ed129400-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;request_id:=('ed129600-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;
  INSERT INTO app.company_content_approval_requests(id,workspace_id,content_item_id,content_version_id,content_sha256,request_number,requested_by_user_id,requested_request_id)
  SELECT request_id,workspace_id,content_item_id,id,content_sha256,1,current_setting('mhp.editor.actor')::uuid,'isolated006e-publish' FROM app.company_content_versions WHERE id=version;
  INSERT INTO app.company_content_approval_decisions(id,workspace_id,content_item_id,content_version_id,approval_request_id,content_sha256,decision,decided_by_user_id,decided_request_id)
  SELECT ('ed129700-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,workspace_id,content_item_id,content_version_id,id,content_sha256,'approved',current_setting('mhp.editor.actor')::uuid,'isolated006e-publish'
   FROM app.company_content_approval_requests WHERE id=request_id;
 END LOOP;
END $bundle_publish$;
SET LOCAL ROLE r72_mhp_prospect_definer;
DO $intent_not_execution$ DECLARE exact jsonb;BEGIN
 exact:=app_private.mhp_sequence_exact('ed129400-0000-4000-8000-000000000003',false,true);
 IF exact->>'approvalDecisionId' IS NULL THEN RAISE EXCEPTION 'Mixed blueprint intent was not genuinely approved';END IF;
 BEGIN PERFORM app_private.mhp_sequence_exact('ed129400-0000-4000-8000-000000000003',true,true);RAISE EXCEPTION 'Blueprint became executable';
  EXCEPTION WHEN check_violation THEN IF SQLERRM NOT LIKE '%channel is not connected%' THEN RAISE;END IF;END;
 PERFORM app_private.mhp_sequence_exact('ed128400-0000-4000-8000-000000000001',true,true);
END $intent_not_execution$;
SET LOCAL ROLE r72_identity_command;
DO $crafted_activation$ BEGIN
 BEGIN PERFORM app_private.mhp_sequence_command(public.digest('editor-owner','sha256'),'enrol',gen_random_uuid(),'ed129400-0000-4000-8000-000000000003','webinar-ghq005-proof',NULL,NULL,'isolated006e-forged-start');RAISE EXCEPTION 'Mixed Start admitted';EXCEPTION WHEN check_violation THEN NULL;END;
 BEGIN PERFORM app_private.mhp_sequence_entry_command(public.digest('editor-owner','sha256'),'activate',gen_random_uuid(),'ed129400-0000-4000-8000-000000000003','webinar-ghq005-proof',NULL,clock_timestamp()+interval '1 day','isolated006e-forged-entry');RAISE EXCEPTION 'Mixed future entry admitted';EXCEPTION WHEN check_violation THEN NULL;END;
 IF jsonb_array_length(app_private.mhp_sequence_claim_v2(25,120,NULL))<>0 OR app_private.mhp_sequence_prepare_v2(gen_random_uuid(),gen_random_uuid()) IS NOT NULL THEN RAISE EXCEPTION 'Mixed claim/prepare created work';END IF;
END $crafted_activation$;
SET LOCAL ROLE r72_owner;
DO $no_effects_grants$ BEGIN
 IF EXISTS(SELECT 1 FROM app_private.mhp_followup_runs) OR EXISTS(SELECT 1 FROM app_private.mhp_marketing_sends WHERE sequence_run_id IS NOT NULL)
  OR EXISTS(SELECT 1 FROM app_private.mhp_owner_email_dispatch_proofs) OR EXISTS(SELECT 1 FROM app_private.mhp_sequence_entry_rules) THEN RAISE EXCEPTION 'Blueprint publication created runtime effects';END IF;
 IF has_function_privilege('r72_web','app_private.mhp_owner_channel_exact(uuid,boolean)','EXECUTE') OR has_function_privilege('r72_identity_command','app_private.mhp_owner_channel_exact(uuid,boolean)','EXECUTE')
  OR has_schema_privilege('r72_mhp_prospect_definer','app_private','CREATE') OR has_table_privilege('r72_identity_command','app.company_content_versions','SELECT,INSERT,UPDATE,DELETE') THEN RAISE EXCEPTION 'Draft helper exposed runtime tables/capability';END IF;
END $no_effects_grants$;
-- Root appends rollback sentinel; never commit synthetic state or call any provider.
SET LOCAL ROLE r72_web;
DO $legacy_reader_after129$ DECLARE local jsonb;BEGIN
 local:=app_private.mhp_sequence_local_version(public.digest('editor-owner','sha256'),'ed129400-0000-4000-8000-000000000099',NULL);
 IF local IS NULL OR (local->>'valid')::boolean OR local->>'canonicalContent' IS NULL OR local->>'contentSha256'<>current_setting('flow.proof.legacy_hash')
  OR local->>'title'<>'Legacy planned SMS reference' THEN RAISE EXCEPTION 'Old128mixed history was lost or silently treated as properchannel';END IF;
 BEGIN PERFORM app_private.mhp_owner_channel_exact('ed129400-0000-4000-8000-000000000001',true);RAISE EXCEPTION 'Web executed private payload helper';EXCEPTION WHEN insufficient_privilege THEN NULL;END;
END $legacy_reader_after129$;
SET LOCAL ROLE r72_mhp_prospect_definer;
DO $invalid_message_bytes$ DECLARE n integer;m jsonb;items jsonb:='[]';payload jsonb;body text;manifest text;brand jsonb:=app_private.mhp_owner_email_brand();channel text;item uuid;version uuid;BEGIN
 FOR n IN 100..108 LOOP
  channel:=CASE n WHEN 107 THEN 'whatsapp' ELSE 'sms' END;item:=('ed129300-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;version:=('ed129400-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;
  payload:=CASE n WHEN 101 THEN jsonb_build_object('schema','growthhq.sms-draft/v999','bodyText','Invalid schema')
   WHEN 102 THEN jsonb_build_object('schema','growthhq.sms-draft/v1','bodyText','Unknown {{PASSWORD}}')
   WHEN 107 THEN jsonb_build_object('schema','growthhq.whatsapp-template-draft/v1','templateName','sample_followup','language','en_GB','bodyText','Missing {{1}} before {{3}}')
   WHEN 108 THEN jsonb_build_object('schema','growthhq.sms-draft/v1','bodyText','Extra authority','recipient','+441234567890')
   ELSE jsonb_build_object('schema','growthhq.sms-draft/v1','bodyText','Synthetic negative fixture') END;
  body:=app_private.mhp_sequence_canonical(payload);
  manifest:=app_private.mhp_sequence_canonical(jsonb_build_object('schema','mhp.channel-draft-source/v1','workspaceId','2789228d-55a6-4688-b1e8-2f70abca990b',
   'sourceSystem',CASE n WHEN 105 THEN 'pp.owner-sms' ELSE 'mhp.owner-'||channel END,'sourceItemId','owner-'||channel||':'||item::text,'sourceVersion','edit:'||version::text,
   'contentSha256',encode(public.digest(body,'sha256'),'hex'),'blobStorageKey','inline:mhp.owner-'||channel||':'||encode(public.digest(body,'sha256'),'hex'),
   'blobSha256',encode(public.digest(body,'sha256'),'hex'),'brandSnapshotRef',brand->>'ref','brandSha256',brand->>'sha256','channel',channel));
  items:=items||jsonb_build_array(jsonb_build_object('n',n,'channel',channel,'item',item,'version',version,'body',body,'manifest',manifest));
 END LOOP;
 PERFORM set_config('flow.proof.invalid_messages',items::text,true);
END $invalid_message_bytes$;
SET LOCAL ROLE r72_content_adapter;
DO $invalid_message_rows$ DECLARE m jsonb;n integer;brand jsonb:=current_setting('mhp.editor.brand')::jsonb;actor uuid:=current_setting('mhp.editor.actor')::uuid;created_by uuid;BEGIN
 FOR m IN SELECT value FROM jsonb_array_elements(current_setting('flow.proof.invalid_messages')::jsonb) LOOP
  n:=(m->>'n')::integer;created_by:=CASE n WHEN 106 THEN 'ed126900-0000-4000-8000-000000000001'::uuid ELSE actor END;
  PERFORM set_config('app.user_id',created_by::text,true);
  IF n=106 AND NOT app_private.lock_active_portal_session(public.digest('editor-member','sha256'),created_by,'2789228d-55a6-4688-b1e8-2f70abca990b') THEN RAISE EXCEPTION 'Actual nonprogramme member session unavailable';END IF;
  IF n=106 THEN
   BEGIN
    INSERT INTO app.company_content_items(id,workspace_id,source_system,source_item_id,created_by_user_id,created_request_id)
    VALUES((m->>'item')::uuid,'2789228d-55a6-4688-b1e8-2f70abca990b','mhp.owner-sms','owner-sms:'||(m->>'item'),created_by,'isolated-ghq005-editor');
    RAISE EXCEPTION 'Nonprogramme member wrote protected MHP local content';
   EXCEPTION WHEN insufficient_privilege THEN PERFORM set_config('flow.proof.nonowner_denied','true',true);END;
   CONTINUE;
  END IF;
  INSERT INTO app.company_content_items(id,workspace_id,source_system,source_item_id,created_by_user_id,created_request_id)
  VALUES((m->>'item')::uuid,'2789228d-55a6-4688-b1e8-2f70abca990b','mhp.owner-'||(m->>'channel'),'owner-'||(m->>'channel')||':'||(m->>'item'),created_by,'isolated-ghq005-editor');
  INSERT INTO app.company_content_versions(id,workspace_id,content_item_id,version_number,origin,content_kind,title,source_system,source_item_id,source_version,
   content_mime_type,content_body,blob_storage_key,blob_sha256,brand_snapshot_ref,brand_sha256,metadata,created_by_user_id,created_request_id)
  VALUES((m->>'version')::uuid,'2789228d-55a6-4688-b1e8-2f70abca990b',(m->>'item')::uuid,1,'imported','other','Negative channel fixture',
   'mhp.owner-'||(m->>'channel'),'owner-'||(m->>'channel')||':'||(m->>'item'),'edit:'||(m->>'version'),
   CASE n WHEN 100 THEN 'application/vnd.growthhq.whatsapp-template-draft+json' ELSE 'application/vnd.growthhq.'||(CASE m->>'channel' WHEN 'sms' THEN 'sms-draft' ELSE 'whatsapp-template-draft' END)||'+json' END,
   m->>'body','inline:mhp.owner-'||(m->>'channel')||':'||encode(public.digest(m->>'body','sha256'),'hex'),
   CASE n WHEN 103 THEN decode(repeat('0',64),'hex') ELSE public.digest(m->>'body','sha256') END,
   brand->>'ref',CASE n WHEN 104 THEN decode(repeat('0',64),'hex') ELSE decode(brand->>'sha256','hex') END,
   jsonb_build_object('mhpChannelDraft',jsonb_build_object('schema','mhp.channel-draft-local/v1','authoredBy','native-owner','brandCanonical',brand->>'canonical',
    'manifestCanonical',m->>'manifest','manifestSha256',encode(public.digest(m->>'manifest','sha256'),'hex'))),created_by,'isolated-ghq005-editor');
 END LOOP;
 PERFORM set_config('app.user_id',actor::text,true);
END $invalid_message_rows$;
SET LOCAL ROLE r72_mhp_prospect_definer;
DO $invalid_message_rejected$ DECLARE n integer;version uuid;BEGIN
 IF current_setting('flow.proof.nonowner_denied',true) IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'MHP nonowner write boundary was not exercised';END IF;
 FOR n IN 100..108 LOOP
  version:=('ed129400-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;
  BEGIN PERFORM app_private.mhp_owner_channel_exact(version,true);RAISE EXCEPTION 'Invalid local draft admitted: %',n;
   EXCEPTION WHEN check_violation OR insufficient_privilege THEN NULL;END;
 END LOOP;
END $invalid_message_rejected$;
DO $new_sms_bytes$ DECLARE body text;manifest text;brand jsonb:=app_private.mhp_owner_email_brand();BEGIN
 body:=app_private.mhp_sequence_canonical(jsonb_build_object('schema','growthhq.sms-draft/v1','bodyText','New SMS wording for a new review.'));
 manifest:=app_private.mhp_sequence_canonical(jsonb_build_object('schema','mhp.channel-draft-source/v1','workspaceId','2789228d-55a6-4688-b1e8-2f70abca990b','sourceSystem','mhp.owner-sms',
  'sourceItemId','owner-sms:ed129300-0000-4000-8000-000000000001','sourceVersion','edit:ed129400-0000-4000-8000-000000000004','contentSha256',encode(public.digest(body,'sha256'),'hex'),
  'blobStorageKey','inline:mhp.owner-sms:'||encode(public.digest(body,'sha256'),'hex'),'blobSha256',encode(public.digest(body,'sha256'),'hex'),'brandSnapshotRef',brand->>'ref','brandSha256',brand->>'sha256','channel','sms'));
 PERFORM set_config('flow.proof.new_sms',jsonb_build_object('body',body,'manifest',manifest)::text,true);
END $new_sms_bytes$;
SET LOCAL ROLE r72_content_adapter;
DO $new_sms_save$ DECLARE m jsonb:=current_setting('flow.proof.new_sms')::jsonb;BEGIN
 INSERT INTO app.company_content_versions(id,workspace_id,content_item_id,version_number,previous_version_id,origin,content_kind,title,source_system,source_item_id,source_version,
  content_mime_type,content_body,blob_storage_key,blob_sha256,brand_snapshot_ref,brand_sha256,metadata,created_by_user_id,created_request_id)
 SELECT 'ed129400-0000-4000-8000-000000000004',workspace_id,content_item_id,2,id,'edited',content_kind,'New SMS draft',source_system,source_item_id,'edit:ed129400-0000-4000-8000-000000000004',
  content_mime_type,m->>'body','inline:mhp.owner-sms:'||encode(public.digest(m->>'body','sha256'),'hex'),public.digest(m->>'body','sha256'),brand_snapshot_ref,brand_sha256,
  jsonb_build_object('mhpChannelDraft',(metadata->'mhpChannelDraft')||jsonb_build_object('manifestCanonical',m->>'manifest','manifestSha256',encode(public.digest(m->>'manifest','sha256'),'hex'))),created_by_user_id,'isolated-ghq005-editor'
 FROM app.company_content_versions WHERE id='ed129400-0000-4000-8000-000000000001';
END $new_sms_save$;
SET LOCAL ROLE r72_web;
DO $stale_channel_flow$ DECLARE local jsonb;BEGIN
 local:=app_private.mhp_sequence_local_version(public.digest('editor-owner','sha256'),'ed129400-0000-4000-8000-000000000003',NULL);
 IF (local->>'valid')::boolean OR local->>'canonicalContent' IS DISTINCT FROM current_setting('flow.proof.mixed')::jsonb->>'body' THEN RAISE EXCEPTION 'Changed message silently retargeted or left flow current';END IF;
END $stale_channel_flow$;
SET LOCAL ROLE r72_mhp_prospect_definer;
DO $channel_history$ DECLARE old jsonb;BEGIN
 old:=app_private.mhp_owner_channel_exact('ed129400-0000-4000-8000-000000000001',false);
 IF old->'payload'->>'bodyText'<>'Hi {{FIRSTNAME}}, sample café £47.' THEN RAISE EXCEPTION 'Old message bytes changed';END IF;
 PERFORM app_private.mhp_owner_channel_exact('ed129400-0000-4000-8000-000000000004',true);
 BEGIN PERFORM app_private.mhp_sequence_exact('ed129400-0000-4000-8000-000000000003',false,true);RAISE EXCEPTION 'Stale message reference admitted';EXCEPTION WHEN check_violation THEN NULL;END;
 PERFORM app_private.mhp_sequence_exact('ed128400-0000-4000-8000-000000000001',true,true);
END $channel_history$;
SET LOCAL ROLE r72_owner;
DO $final_draft_no_effects$ BEGIN
 IF EXISTS(SELECT 1 FROM app_private.mhp_followup_runs) OR EXISTS(SELECT 1 FROM app_private.mhp_marketing_sends WHERE sequence_run_id IS NOT NULL) OR EXISTS(SELECT 1 FROM app_private.mhp_owner_email_dispatch_proofs)
  OR EXISTS(SELECT 1 FROM app_private.mhp_sequence_entry_rules) THEN RAISE EXCEPTION 'Draft validation/publication created runtime effects';END IF;
END $final_draft_no_effects$;
