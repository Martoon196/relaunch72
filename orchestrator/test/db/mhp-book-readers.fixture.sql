-- Release B (0160) disposable fixture, applied after mhp-sequence-safety.fixture.sql. Synthetic rows only (example.invalid).
-- Adds: book sign-ups (one eligible, one without email consent, one unsubscribed, one bounce-blocked, one who bought,
-- and reader-1, a webinar registrant who also asked for the book), a product for the purchase, and sequence D saved for
-- book readers (published, two emails). Nothing here creates a run, a switch or a send.
DO $seed$
DECLARE
 ws constant uuid:='2789228d-55a6-4688-b1e8-2f70abca990b'; org constant uuid:='ba41b1a4-9752-4dbf-8312-d04a0f03d0b8';
 owner_id constant uuid:='5afe4000-0000-4000-8000-000000000001'; campaign constant text:='webinar-2026-11-03';
 email_item constant uuid:='5afe4000-0000-4000-8000-000000000010'; email_version constant uuid:='5afe4000-0000-4000-8000-000000000011';
 d_item constant uuid:='5afe4000-0000-4000-8000-0000000000d1'; d_version constant uuid:='5afe4000-0000-4000-8000-0000000000d2';
 at constant timestamptz:=clock_timestamp(); brand jsonb; sha bytea; canonical text; manifest text; d jsonb; n integer; prospect uuid; product uuid;
BEGIN
 PERFORM set_config('app.workspace_id',ws::text,true); PERFORM set_config('app.user_id',owner_id::text,true);
 PERFORM set_config('app.actor_kind','user',true); PERFORM set_config('app.request_id','mhp-book-readers-fixture',true);
 -- 21 eligible, 22 no email consent, 23 unsubscribed, 24 bounce-blocked, 25 bought.
 FOR n IN 21..25 LOOP
  prospect:=('5afe6000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;
  INSERT INTO app_private.mhp_prospects(id,email,first_name,marketing_consent,consent_version,consent_at,unsubscribed_at)
  VALUES(prospect,'book-'||n||'@example.invalid','Book '||n,n<>22,'book-v1',at,CASE WHEN n=23 THEN at END);
  INSERT INTO app_private.mhp_prospect_signups(prospect_id,kind,label,module,link,consent_given,consent_version,created_at)
  VALUES(prospect,'waitlist','Before You Buy — book interest','book-before-you-buy','https://martinhowardproperty.co.uk/book/',n<>22,'book-v1',at-interval '1 hour');
 END LOOP;
 -- reader-1 (a webinar registrant) also asked for the book.
 INSERT INTO app_private.mhp_prospect_signups(prospect_id,kind,label,module,link,consent_given,consent_version,created_at)
 VALUES('5afe5000-0000-4000-8000-000000000001','waitlist','Before You Buy — book interest','book-before-you-buy','https://martinhowardproperty.co.uk/book/',true,'book-v1',at-interval '1 hour');
 INSERT INTO app_private.email_address_blocks(workspace_id,source_key,email,reason,scope,provider,occurred_at)
 VALUES(ws,'postmark','book-24@example.invalid','hard_bounce','all','postmark',at);
 INSERT INTO app.products(organization_id,brand,sku,name,type,price_pence,refund_days,grants)
 VALUES(org,'martin_howard_property','mhp_kit_book_test','Property Investor Kit','kit',9700,30,'{}') RETURNING id INTO product;
 INSERT INTO app.purchases(organization_id,product_id,stripe_account_id,stripe_session_id,stripe_customer_id,buyer_email,livemode,status,first_paid_at,last_snapshot_at)
 VALUES(org,product,'acct_test1','cs_test_book25','cus_test25','book-25@example.invalid',false,'paid',at,at);
 -- Sequence D: saved for book readers, published.
 brand:=app_private.mhp_owner_email_brand();
 SELECT content_sha256 INTO sha FROM app.company_content_versions WHERE id=email_version;
 d:=jsonb_build_object('schema','growthhq.followup-sequence/v2','entry',jsonb_build_object('mode','manual','source','manual_owner'),'brand','mhp','campaign',campaign,
  'title','Before You Buy: chapter one','expiryHours',24,'stopOn',jsonb_build_object('reply',false,'booked',false,'purchased',false),'steps',jsonb_build_array(
   jsonb_build_object('key','first','kind','email','contentItemId',email_item,'contentVersionId',email_version,'contentSha256',encode(sha,'hex')),
   jsonb_build_object('key','wait','kind','wait','minutes',2880),
   jsonb_build_object('key','second','kind','email','contentItemId',email_item,'contentVersionId',email_version,'contentSha256',encode(sha,'hex'))));
 canonical:=app_private.mhp_sequence_canonical(d);
 manifest:=app_private.mhp_sequence_canonical(jsonb_build_object('schema','mhp.followup-sequence-source/v1','workspaceId',ws::text,'sourceSystem','mhp.followup-sequence',
  'sourceItemId','sequence:'||d_item,'sourceVersion','edit:'||d_version,'contentSha256',encode(public.digest(canonical,'sha256'),'hex'),
  'blobStorageKey','inline:mhp.followup-sequence:'||encode(public.digest(canonical,'sha256'),'hex'),'blobSha256',encode(public.digest(canonical,'sha256'),'hex'),
  'brandSnapshotRef',brand->>'ref','brandSha256',brand->>'sha256','audienceCampaign',campaign));
 INSERT INTO app.company_content_items(id,workspace_id,source_system,source_item_id,created_by_user_id,created_request_id)
 VALUES(d_item,ws,'mhp.followup-sequence','sequence:'||d_item,owner_id,'mhp-book-readers-fixture');
 INSERT INTO app.company_content_versions(id,workspace_id,content_item_id,version_number,origin,content_kind,title,source_system,source_item_id,source_version,
  content_mime_type,content_body,blob_storage_key,blob_sha256,brand_snapshot_ref,brand_sha256,metadata,created_by_user_id,created_request_id)
 VALUES(d_version,ws,d_item,1,'imported','other','Before You Buy: chapter one','mhp.followup-sequence','sequence:'||d_item,'edit:'||d_version,'application/vnd.growthhq.followup-sequence+json',
  canonical,'inline:mhp.followup-sequence:'||encode(public.digest(canonical,'sha256'),'hex'),public.digest(canonical,'sha256'),brand->>'ref',decode(brand->>'sha256','hex'),
  jsonb_build_object('mhpSequence',jsonb_build_object('schema','mhp.followup-sequence-local/v1','brandCanonical',brand->>'canonical','manifestCanonical',manifest,
   'manifestSha256',encode(public.digest(manifest,'sha256'),'hex'),'authoredBy','native-owner',
   'audience',jsonb_build_object('schema','mhp.followup-sequence-audience/v1','kind','book_readers','campaign',NULL))),owner_id,'mhp-book-readers-fixture');
 INSERT INTO app.company_content_source_attestations(workspace_id,content_item_id,content_version_id,source_system,source_item_id,source_version,
  content_sha256,blob_sha256,brand_sha256,source_catalog_sha256,checked_at,expires_at,attested_by_user_id,attested_request_id)
 VALUES(ws,d_item,d_version,'mhp.followup-sequence','sequence:'||d_item,'edit:'||d_version,public.digest(canonical,'sha256'),public.digest(canonical,'sha256'),
  decode(brand->>'sha256','hex'),public.digest(manifest,'sha256'),at,at+interval '15 minutes',owner_id,'mhp-book-readers-fixture');
 INSERT INTO app.company_content_approval_requests(id,workspace_id,content_item_id,content_version_id,content_sha256,request_number,requested_by_user_id,requested_request_id)
 VALUES('5afe4000-0000-4000-8000-0000000000d3',ws,d_item,d_version,public.digest(canonical,'sha256'),1,owner_id,'mhp-book-readers-fixture');
 INSERT INTO app.company_content_approval_decisions(workspace_id,content_item_id,content_version_id,approval_request_id,content_sha256,decision,decided_by_user_id,decided_request_id)
 VALUES(ws,d_item,d_version,'5afe4000-0000-4000-8000-0000000000d3',public.digest(canonical,'sha256'),'approved',owner_id,'mhp-book-readers-fixture');
END $seed$;
