-- MHP sequence safety release: disposable fixture. Synthetic rows only (example.invalid).
-- Run as r72_owner on a disposable database after current_setting('seq.token') is set to the
-- synthetic owner session token. Creates: the MHP owner, the brand workspace, eight webinar
-- registrations (two not eligible, one for another webinar), one approved owner email and
-- three approved sequences: A (audience saved as webinar sign-ups), B (no audience key at all,
-- as every version saved before this release) and C (audience saved as "none yet").
DO $seed$
DECLARE
 ws constant uuid:='2789228d-55a6-4688-b1e8-2f70abca990b'; org constant uuid:='ba41b1a4-9752-4dbf-8312-d04a0f03d0b8';
 owner_id constant uuid:='5afe4000-0000-4000-8000-000000000001'; campaign constant text:='webinar-2026-11-03';
 email_item constant uuid:='5afe4000-0000-4000-8000-000000000010'; email_version constant uuid:='5afe4000-0000-4000-8000-000000000011';
 brand jsonb; canonical text; sha bytea; manifest text; n integer; prospect uuid; seq record; d jsonb; local jsonb;
BEGIN
 IF EXISTS(SELECT 1 FROM app.workspaces WHERE id=ws) THEN RAISE EXCEPTION 'Fresh disposable MHP fixture required'; END IF;
 PERFORM set_config('app.workspace_id',ws::text,true); PERFORM set_config('app.user_id',owner_id::text,true);
 PERFORM set_config('app.actor_kind','user',true); PERFORM set_config('app.request_id','mhp-seq-safety-fixture',true);
 INSERT INTO app.organizations(id,name,slug,kind) VALUES(org,'Martin Howard Property','martin-howard-property-seq','direct_customer');
 INSERT INTO app.organization_branding(organization_id,product_name) VALUES(org,'Martin Howard Property');
 INSERT INTO app.workspaces(id,organization_id,name,slug) VALUES(ws,org,'MHP brand marketing','mhp-brand-marketing');
 INSERT INTO app.users(id,email,display_name,status,email_verified_at) VALUES(owner_id,'martin.howard1984@gmail.com','Synthetic MHP owner','active',clock_timestamp());
 INSERT INTO app_private.investor_programme_admins(user_id) VALUES(owner_id);
 INSERT INTO app.organization_memberships(organization_id,user_id,role,status) VALUES(org,owner_id,'owner','active');
 INSERT INTO app.workspace_memberships(workspace_id,organization_id,user_id,role,status) VALUES(ws,org,owner_id,'owner','active');
 INSERT INTO app.user_sessions(token_hash,csrf_secret_hash,user_id,selected_workspace_id,expires_at,product_audience)
 VALUES(public.digest(current_setting('seq.token'),'sha256'),public.digest('seq-safety-csrf','sha256'),owner_id,ws,clock_timestamp()+interval '2 hours','martin_howard_property');
 -- 1..6 eligible; 7 unsubscribed; 8 did not agree to emails; 9 registered for another webinar.
 FOR n IN 1..9 LOOP
  prospect:=('5afe5000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;
  INSERT INTO app_private.mhp_prospects(id,email,first_name,marketing_consent,consent_version,consent_at,unsubscribed_at)
  VALUES(prospect,'reader-'||n||'@example.invalid','Reader '||n,n<>8,'seq-safety-v1',clock_timestamp(),CASE WHEN n=7 THEN clock_timestamp() END);
  INSERT INTO app_private.mhp_prospect_signups(prospect_id,kind,label,link,consent_given,consent_version,created_at)
  VALUES(prospect,'webinar','Before You Buy live webinar','https://martinhowardproperty.co.uk/webinar/',n<>8,'seq-safety-v1',clock_timestamp()-interval '2 minutes');
  INSERT INTO app_private.mhp_marketing_sends(prospect_id,template_key,campaign_key,context,due_at,expires_at,created_at)
  VALUES(prospect,'webinar_confirm',CASE WHEN n=9 THEN 'webinar-2026-10-01' ELSE campaign END,'{}',clock_timestamp()-interval '1 minute',clock_timestamp()+interval '1 day',clock_timestamp()-interval '1 minute');
 END LOOP;
 brand:=app_private.mhp_owner_email_brand();
 -- One approved owner email.
 canonical:='{"bodyText":"Hello {{FIRSTNAME}}\n{{LINK}}","schema":"propertypredator.email-draft/v1","subject":"Your replay is ready"}'; sha:=public.digest(canonical,'sha256');
 manifest:=jsonb_build_object('schema','mhp.owner-email-source/v1','workspaceId',ws::text,'sourceSystem','mhp.owner-email','sourceItemId','owner-email:'||email_item,'sourceVersion','edit:'||email_version,
  'contentSha256',encode(sha,'hex'),'blobStorageKey','inline:mhp.owner-email:'||encode(sha,'hex'),'blobSha256',encode(sha,'hex'),'brandSnapshotRef',brand->>'ref','brandSha256',brand->>'sha256','audienceCampaign',campaign)::text;
 INSERT INTO app.company_content_items(id,workspace_id,source_system,source_item_id,created_by_user_id,created_request_id)
 VALUES(email_item,ws,'mhp.owner-email','owner-email:'||email_item,owner_id,'mhp-seq-safety-fixture');
 INSERT INTO app.company_content_versions(id,workspace_id,content_item_id,version_number,origin,content_kind,title,source_system,source_item_id,source_version,
  content_mime_type,content_body,blob_storage_key,blob_sha256,brand_snapshot_ref,brand_sha256,metadata,created_by_user_id,created_request_id)
 VALUES(email_version,ws,email_item,1,'imported','email','Replay email','mhp.owner-email','owner-email:'||email_item,'edit:'||email_version,'application/vnd.propertypredator.email-draft+json',
  canonical,'inline:mhp.owner-email:'||encode(sha,'hex'),sha,brand->>'ref',decode(brand->>'sha256','hex'),
  jsonb_build_object('mhpOwnerEmail',jsonb_build_object('schema','mhp.owner-email-local/v1','brandCanonical',brand->>'canonical','manifestCanonical',manifest,
   'manifestSha256',encode(public.digest(manifest,'sha256'),'hex'),'authoredBy','native-owner')),owner_id,'mhp-seq-safety-fixture');
 INSERT INTO app.company_content_source_attestations(workspace_id,content_item_id,content_version_id,source_system,source_item_id,source_version,
  content_sha256,blob_sha256,brand_sha256,source_catalog_sha256,checked_at,expires_at,attested_by_user_id,attested_request_id)
 VALUES(ws,email_item,email_version,'mhp.owner-email','owner-email:'||email_item,'edit:'||email_version,sha,sha,decode(brand->>'sha256','hex'),public.digest(manifest,'sha256'),
  clock_timestamp(),clock_timestamp()+interval '15 minutes',owner_id,'mhp-seq-safety-fixture');
 INSERT INTO app.company_content_approval_requests(id,workspace_id,content_item_id,content_version_id,content_sha256,request_number,requested_by_user_id,requested_request_id)
 VALUES('5afe4000-0000-4000-8000-000000000012',ws,email_item,email_version,sha,1,owner_id,'mhp-seq-safety-fixture');
 INSERT INTO app.company_content_approval_decisions(workspace_id,content_item_id,content_version_id,approval_request_id,content_sha256,decision,decided_by_user_id,decided_request_id)
 VALUES(ws,email_item,email_version,'5afe4000-0000-4000-8000-000000000012',sha,'approved',owner_id,'mhp-seq-safety-fixture');
 -- Three approved sequences.
 FOR seq IN SELECT * FROM (VALUES
   ('5afe4000-0000-4000-8000-0000000000a1'::uuid,'5afe4000-0000-4000-8000-0000000000a2'::uuid,'5afe4000-0000-4000-8000-0000000000a3'::uuid,'Webinar replay follow-up','webinar_signups'),
   ('5afe4000-0000-4000-8000-0000000000b1'::uuid,'5afe4000-0000-4000-8000-0000000000b2'::uuid,'5afe4000-0000-4000-8000-0000000000b3'::uuid,'Older webinar thank-you','legacy'),
   ('5afe4000-0000-4000-8000-0000000000c1'::uuid,'5afe4000-0000-4000-8000-0000000000c2'::uuid,'5afe4000-0000-4000-8000-0000000000c3'::uuid,'Before You Buy: chapter one','none_yet')) t(item,version,request,title,audience) LOOP
  d:=jsonb_build_object('schema','growthhq.followup-sequence/v2','entry',jsonb_build_object('mode','manual','source','manual_owner'),'brand','mhp','campaign',campaign,'title',seq.title,'expiryHours',24,
   'stopOn',jsonb_build_object('reply',false,'booked',false,'purchased',false),'steps',jsonb_build_array(
    jsonb_build_object('key','first','kind','email','contentItemId',email_item,'contentVersionId',email_version,'contentSha256',encode(sha,'hex')),
    jsonb_build_object('key','wait','kind','wait','minutes',2880),
    jsonb_build_object('key','second','kind','email','contentItemId',email_item,'contentVersionId',email_version,'contentSha256',encode(sha,'hex'))));
  canonical:=app_private.mhp_sequence_canonical(d);
  manifest:=app_private.mhp_sequence_canonical(jsonb_build_object('schema','mhp.followup-sequence-source/v1','workspaceId',ws::text,'sourceSystem','mhp.followup-sequence',
   'sourceItemId','sequence:'||seq.item,'sourceVersion','edit:'||seq.version,'contentSha256',encode(public.digest(canonical,'sha256'),'hex'),
   'blobStorageKey','inline:mhp.followup-sequence:'||encode(public.digest(canonical,'sha256'),'hex'),'blobSha256',encode(public.digest(canonical,'sha256'),'hex'),
   'brandSnapshotRef',brand->>'ref','brandSha256',brand->>'sha256','audienceCampaign',campaign));
  local:=jsonb_build_object('schema','mhp.followup-sequence-local/v1','brandCanonical',brand->>'canonical','manifestCanonical',manifest,
   'manifestSha256',encode(public.digest(manifest,'sha256'),'hex'),'authoredBy','native-owner');
  -- Exactly the key this release's save writes (src/followup-sequences/audience.ts); B has none.
  IF seq.audience<>'legacy' THEN local:=local||jsonb_build_object('audience',jsonb_build_object('schema','mhp.followup-sequence-audience/v1','kind',seq.audience,
   'campaign',CASE WHEN seq.audience='webinar_signups' THEN to_jsonb(campaign) ELSE 'null'::jsonb END)); END IF;
  INSERT INTO app.company_content_items(id,workspace_id,source_system,source_item_id,created_by_user_id,created_request_id)
  VALUES(seq.item,ws,'mhp.followup-sequence','sequence:'||seq.item,owner_id,'mhp-seq-safety-fixture');
  INSERT INTO app.company_content_versions(id,workspace_id,content_item_id,version_number,origin,content_kind,title,source_system,source_item_id,source_version,
   content_mime_type,content_body,blob_storage_key,blob_sha256,brand_snapshot_ref,brand_sha256,metadata,created_by_user_id,created_request_id)
  VALUES(seq.version,ws,seq.item,1,'imported','other',seq.title,'mhp.followup-sequence','sequence:'||seq.item,'edit:'||seq.version,'application/vnd.growthhq.followup-sequence+json',
   canonical,'inline:mhp.followup-sequence:'||encode(public.digest(canonical,'sha256'),'hex'),public.digest(canonical,'sha256'),brand->>'ref',decode(brand->>'sha256','hex'),
   jsonb_build_object('mhpSequence',local),owner_id,'mhp-seq-safety-fixture');
  INSERT INTO app.company_content_source_attestations(workspace_id,content_item_id,content_version_id,source_system,source_item_id,source_version,
   content_sha256,blob_sha256,brand_sha256,source_catalog_sha256,checked_at,expires_at,attested_by_user_id,attested_request_id)
  VALUES(ws,seq.item,seq.version,'mhp.followup-sequence','sequence:'||seq.item,'edit:'||seq.version,public.digest(canonical,'sha256'),public.digest(canonical,'sha256'),
   decode(brand->>'sha256','hex'),public.digest(manifest,'sha256'),clock_timestamp(),clock_timestamp()+interval '15 minutes',owner_id,'mhp-seq-safety-fixture');
  INSERT INTO app.company_content_approval_requests(id,workspace_id,content_item_id,content_version_id,content_sha256,request_number,requested_by_user_id,requested_request_id)
  VALUES(seq.request,ws,seq.item,seq.version,public.digest(canonical,'sha256'),1,owner_id,'mhp-seq-safety-fixture');
  INSERT INTO app.company_content_approval_decisions(workspace_id,content_item_id,content_version_id,approval_request_id,content_sha256,decision,decided_by_user_id,decided_request_id)
  VALUES(ws,seq.item,seq.version,seq.request,public.digest(canonical,'sha256'),'approved',owner_id,'mhp-seq-safety-fixture');
 END LOOP;
END $seed$;
