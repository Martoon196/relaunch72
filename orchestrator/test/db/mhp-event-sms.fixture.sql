-- MHP009B disposable fixture. Synthetic rows only; phones are in Ofcom's
-- reserved drama range (07700 900xxx). Run as r72_owner on a disposable branch.
DO $seed$
DECLARE
 ws constant uuid:='2789228d-55a6-4688-b1e8-2f70abca990b'; org constant uuid:='ba41b1a4-9752-4dbf-8312-d04a0f03d0b8';
 owner_id constant uuid:='0b131000-0000-4000-8000-000000000001'; conn constant uuid:='0b131000-0000-4000-8000-000000000002';
 endpoint constant uuid:='0b131000-0000-4000-8000-000000000003'; item constant uuid:='0b131000-0000-4000-8000-000000000004';
 version constant uuid:='0b131000-0000-4000-8000-000000000005'; brand jsonb; body jsonb; canonical text; sha bytea; manifest text;
 source_item text:='owner-sms:0b131000-0000-4000-8000-000000000006'; source_version text:='edit:0b131000-0000-4000-8000-000000000007';
 request_id uuid:='0b131000-0000-4000-8000-000000000008'; n integer; prospect uuid; contact uuid;
BEGIN
 IF EXISTS(SELECT 1 FROM app.workspaces WHERE id=ws) THEN RAISE EXCEPTION 'Fresh disposable MHP fixture required'; END IF;
 PERFORM set_config('app.workspace_id',ws::text,true); PERFORM set_config('app.user_id',owner_id::text,true);
 PERFORM set_config('app.actor_kind','user',true); PERFORM set_config('app.request_id','mhp-009b-fixture',true);
 INSERT INTO app.organizations(id,name,slug,kind) VALUES(org,'Martin Howard Property','martin-howard-property-009b','direct_customer');
 INSERT INTO app.organization_branding(organization_id,product_name) VALUES(org,'Martin Howard Property');
 INSERT INTO app.workspaces(id,organization_id,name,slug) VALUES(ws,org,'MHP brand marketing','mhp-brand-marketing');
 INSERT INTO app.users(id,email,display_name,status,email_verified_at) VALUES(owner_id,'martin.howard1984@gmail.com','Synthetic MHP owner','active',clock_timestamp());
 INSERT INTO app_private.investor_programme_admins(user_id) VALUES(owner_id);
 INSERT INTO app.organization_memberships(organization_id,user_id,role,status) VALUES(org,owner_id,'owner','active');
 INSERT INTO app.workspace_memberships(workspace_id,organization_id,user_id,role,status) VALUES(ws,org,owner_id,'owner','active');
 INSERT INTO app.user_sessions(token_hash,csrf_secret_hash,user_id,selected_workspace_id,expires_at,product_audience)
 VALUES(public.digest('mhp-009b-owner-session','sha256'),public.digest('mhp-009b-owner-csrf','sha256'),owner_id,ws,clock_timestamp()+interval '2 hours','martin_howard_property');
 INSERT INTO app.provider_connections(id,workspace_id,provider_id,provider_kind,environment,display_name,created_by_user_id,status,capabilities)
 VALUES(conn,ws,'twilio_messaging','sms','live','MHP Twilio (disposable)',owner_id,'active','["sms.send"]');
 INSERT INTO app.channel_endpoints(id,workspace_id,provider_connection_id,channel,environment,direction,address,normalized_address,display_name,status)
 VALUES(endpoint,ws,conn,'sms','live','bidirectional','+447861935832','+447861935832','MHP sender (disposable)','active');
 INSERT INTO app.property_predator_sms_bindings(workspace_id,provider_connection_id,channel_endpoint_id,environment,provider_id,account_sid_sha256,
  messaging_service_sid_sha256,sender_number,owned_number_sha256,regulatory_evidence_sha256,ownership_evidence_sha256,evidence_observed_at,created_by_user_id,status)
 VALUES(ws,conn,endpoint,'live','twilio_messaging',public.digest('ac','sha256'),public.digest('mg','sha256'),'+447861935832',
  public.digest('+447861935832','sha256'),public.digest('reg','sha256'),public.digest('own','sha256'),clock_timestamp(),owner_id,'active');
 -- One approved, freshly observed native-owner SMS draft (the ratified 0129/0130 shape).
 brand:=app_private.mhp_owner_email_brand();
 body:=jsonb_build_object('schema','growthhq.sms-draft/v1','bodyText','Martin Howard Property: the webinar starts at 7:30pm tonight. Watch https://martinhowardproperty.co.uk/webinar/live/ Reply STOP to opt out.');
 canonical:=app_private.mhp_sequence_canonical(body); sha:=public.digest(canonical,'sha256');
 manifest:=app_private.mhp_sequence_canonical(jsonb_build_object('schema','mhp.channel-draft-source/v1','workspaceId',ws::text,'sourceSystem','mhp.owner-sms',
  'sourceItemId',source_item,'sourceVersion',source_version,'contentSha256',encode(sha,'hex'),'blobStorageKey','inline:mhp.owner-sms:'||encode(sha,'hex'),
  'blobSha256',encode(sha,'hex'),'brandSnapshotRef',brand->>'ref','brandSha256',brand->>'sha256','channel','sms'));
 INSERT INTO app.company_content_items(id,workspace_id,source_system,source_item_id,created_by_user_id,created_request_id)
 VALUES(item,ws,'mhp.owner-sms',source_item,owner_id,'mhp-009b-fixture');
 INSERT INTO app.company_content_versions(id,workspace_id,content_item_id,version_number,origin,content_kind,title,source_system,source_item_id,source_version,
  content_mime_type,content_body,blob_storage_key,blob_sha256,brand_snapshot_ref,brand_sha256,created_by_user_id,created_request_id,metadata)
 VALUES(version,ws,item,1,'edited','other','MHP webinar tonight','mhp.owner-sms',source_item,source_version,'application/vnd.growthhq.sms-draft+json',
  canonical,'inline:mhp.owner-sms:'||encode(sha,'hex'),sha,brand->>'ref',decode(brand->>'sha256','hex'),owner_id,'mhp-009b-fixture',
  jsonb_build_object('mhpChannelDraft',jsonb_build_object('schema','mhp.channel-draft-local/v1','authoredBy','native-owner','brandCanonical',brand->>'canonical',
   'manifestCanonical',manifest,'manifestSha256',encode(public.digest(manifest,'sha256'),'hex'))));
 INSERT INTO app.company_content_approval_requests(id,workspace_id,content_item_id,content_version_id,content_sha256,request_number,requested_by_user_id,requested_request_id)
 VALUES(request_id,ws,item,version,sha,1,owner_id,'mhp-009b-fixture');
 INSERT INTO app.company_content_approval_decisions(workspace_id,content_item_id,content_version_id,approval_request_id,content_sha256,decision,decided_by_user_id,decided_request_id)
 VALUES(ws,item,version,request_id,sha,'approved',owner_id,'mhp-009b-fixture');
 INSERT INTO app.company_content_source_attestations(workspace_id,content_item_id,content_version_id,source_system,source_item_id,source_version,content_sha256,blob_sha256,
  brand_sha256,source_catalog_sha256,checked_at,expires_at,attested_by_user_id,attested_request_id)
 VALUES(ws,item,version,'mhp.owner-sms',source_item,source_version,sha,sha,decode(brand->>'sha256','hex'),public.digest(manifest,'sha256'),
  clock_timestamp()-interval '1 second',clock_timestamp()+interval '14 minutes',owner_id,'mhp-009b-fixture');
 -- Six webinar registrants. 1-4 imported to the CRM; 5 not imported; 6 unsubscribed from email.
 FOR n IN 1..6 LOOP
  prospect:=('0b131100-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;
  INSERT INTO app_private.mhp_prospects(id,email,first_name,marketing_consent,consent_version,consent_at,unsubscribed_at)
  VALUES(prospect,'registrant-'||n||'@example.invalid','Registrant '||n,true,'disposable-v1',clock_timestamp(),CASE WHEN n=6 THEN clock_timestamp() END);
  INSERT INTO app_private.mhp_prospect_signups(prospect_id,kind,label,link,consent_given,consent_version,created_at)
  VALUES(prospect,'webinar','Webinar','https://martinhowardproperty.co.uk/webinar/',true,'disposable-v1',clock_timestamp()-interval '2 minutes');
  INSERT INTO app_private.mhp_marketing_sends(prospect_id,template_key,campaign_key,context,due_at,expires_at,created_at)
  VALUES(prospect,'webinar_confirm','webinar-2026-11-04','{}',clock_timestamp()-interval '1 minute',clock_timestamp()+interval '1 day',clock_timestamp()-interval '1 minute');
  IF n<=4 THEN
   contact:=('0b131200-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;
   INSERT INTO app.contacts(id,workspace_id,display_name) VALUES(contact,ws,'Registrant '||n);
   INSERT INTO app.contact_points(workspace_id,contact_id,kind,value,normalized_value,is_primary)
   VALUES(ws,contact,'email','registrant-'||n||'@example.invalid','registrant-'||n||'@example.invalid',true);
  END IF;
 END LOOP;
END $seed$;
