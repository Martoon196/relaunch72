-- MHP009C disposable fixture, applied after mhp-event-sms.fixture.sql. Synthetic
-- rows only; the owner number is in Ofcom's reserved drama range.
DO $seed$
DECLARE
 ws constant uuid:='2789228d-55a6-4688-b1e8-2f70abca990b'; owner_id constant uuid:='0b131000-0000-4000-8000-000000000001';
 contact constant uuid:='0b132000-0000-4000-8000-000000000001'; point uuid; challenge uuid;
 item constant uuid:='0b132000-0000-4000-8000-000000000002'; version constant uuid:='0b132000-0000-4000-8000-000000000003';
 request_id constant uuid:='0b132000-0000-4000-8000-000000000004'; brand jsonb; body jsonb; canonical text; sha bytea; manifest text;
 source_item text:='owner-whatsapp:0b132000-0000-4000-8000-000000000005'; source_version text:='edit:0b132000-0000-4000-8000-000000000006';
BEGIN
 PERFORM set_config('app.workspace_id',ws::text,true); PERFORM set_config('app.user_id',owner_id::text,true);
 PERFORM set_config('app.actor_kind','user',true); PERFORM set_config('app.request_id','mhp-009c-fixture',true);
 -- The owner's own contact and number, already proved by an SMS code (0122).
 INSERT INTO app.contacts(id,workspace_id,display_name) VALUES(contact,ws,'Synthetic MHP owner');
 INSERT INTO app.contact_points(workspace_id,contact_id,kind,value,normalized_value,is_primary,is_verified)
 VALUES(ws,contact,'phone','+447700900999','+447700900999',true,true) RETURNING id INTO point;
 INSERT INTO app_private.sms_phone_challenges(workspace_id,contact_id,contact_point_id,requested_by_user_id,request_key_sha256,phone_e164,state,
  code_hash,provider_message_sid,sent_at,verified_at)
 VALUES(ws,contact,point,owner_id,public.digest('mhp-009c-challenge','sha256'),'+447700900999','verified','x','SM'||repeat('c',32),clock_timestamp(),clock_timestamp())
 RETURNING id INTO challenge;
 INSERT INTO app_private.sms_phone_verification_receipts(workspace_id,challenge_id,contact_point_id,phone_identity_sha256,provider_message_sid,verified_by_user_id)
 VALUES(ws,challenge,point,public.digest('+447700900999','sha256'),'SM'||repeat('c',32),owner_id);
 -- One approved, parameter-free native-owner WhatsApp template draft (0129 shape).
 brand:=app_private.mhp_owner_email_brand();
 body:=jsonb_build_object('schema','growthhq.whatsapp-template-draft/v1','templateName','mhp_webinar_20261104_reminder_v1','language','en_GB',
  'bodyText','The Martin Howard Property webinar starts at 7:30pm UK time tonight. Watch live at martinhowardproperty.co.uk/webinar/live');
 canonical:=app_private.mhp_sequence_canonical(body); sha:=public.digest(canonical,'sha256');
 manifest:=app_private.mhp_sequence_canonical(jsonb_build_object('schema','mhp.channel-draft-source/v1','workspaceId',ws::text,'sourceSystem','mhp.owner-whatsapp',
  'sourceItemId',source_item,'sourceVersion',source_version,'contentSha256',encode(sha,'hex'),'blobStorageKey','inline:mhp.owner-whatsapp:'||encode(sha,'hex'),
  'blobSha256',encode(sha,'hex'),'brandSnapshotRef',brand->>'ref','brandSha256',brand->>'sha256','channel','whatsapp'));
 INSERT INTO app.company_content_items(id,workspace_id,source_system,source_item_id,created_by_user_id,created_request_id)
 VALUES(item,ws,'mhp.owner-whatsapp',source_item,owner_id,'mhp-009c-fixture');
 INSERT INTO app.company_content_versions(id,workspace_id,content_item_id,version_number,origin,content_kind,title,source_system,source_item_id,source_version,
  content_mime_type,content_body,blob_storage_key,blob_sha256,brand_snapshot_ref,brand_sha256,created_by_user_id,created_request_id,metadata)
 VALUES(version,ws,item,1,'edited','other','MHP webinar reminder','mhp.owner-whatsapp',source_item,source_version,'application/vnd.growthhq.whatsapp-template-draft+json',
  canonical,'inline:mhp.owner-whatsapp:'||encode(sha,'hex'),sha,brand->>'ref',decode(brand->>'sha256','hex'),owner_id,'mhp-009c-fixture',
  jsonb_build_object('mhpChannelDraft',jsonb_build_object('schema','mhp.channel-draft-local/v1','authoredBy','native-owner','brandCanonical',brand->>'canonical',
   'manifestCanonical',manifest,'manifestSha256',encode(public.digest(manifest,'sha256'),'hex'))));
 INSERT INTO app.company_content_approval_requests(id,workspace_id,content_item_id,content_version_id,content_sha256,request_number,requested_by_user_id,requested_request_id)
 VALUES(request_id,ws,item,version,sha,1,owner_id,'mhp-009c-fixture');
 INSERT INTO app.company_content_approval_decisions(workspace_id,content_item_id,content_version_id,approval_request_id,content_sha256,decision,decided_by_user_id,decided_request_id)
 VALUES(ws,item,version,request_id,sha,'approved',owner_id,'mhp-009c-fixture');
END $seed$;
