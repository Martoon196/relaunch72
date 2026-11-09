-- GHQ-WEBINAR-004. ROOT ONLY, disposable exact production clone +0125.
-- Outer transaction must roll back. Synthetic rows/hashes only; no provider.
DO $guard$ BEGIN
 IF current_setting('mhp.proof.enabled',true) IS DISTINCT FROM 'isolated'
 THEN RAISE EXCEPTION 'Isolated MHP proof not enabled'; END IF;
END $guard$;
SET LOCAL ROLE r72_owner;
DO $seed$
DECLARE actor uuid; personal uuid; n integer; prospect uuid; signup uuid; delivery uuid;
 normal uuid:='ed125900-0000-4000-8000-000000000001';
BEGIN
 SELECT u.id,m.workspace_id INTO actor,personal FROM app.users u
 JOIN app_private.investor_programme_admins a ON a.user_id=u.id
 JOIN app.organization_memberships om ON om.user_id=u.id AND om.organization_id='ba41b1a4-9752-4dbf-8312-d04a0f03d0b8'
  AND om.role='owner' AND om.status='active' AND om.revoked_at IS NULL
 JOIN app_private.mhp_members m ON m.user_id=u.id
 JOIN app.workspace_memberships wm ON wm.user_id=u.id AND wm.workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b'
  AND wm.role='owner' AND wm.status='active' AND wm.revoked_at IS NULL
 WHERE lower(u.email::text)='martin.howard1984@gmail.com' AND u.status='active' AND u.email_verified_at IS NOT NULL;
 IF actor IS NULL OR personal IS NULL THEN RAISE EXCEPTION 'Cloned current owner and accepted brand workspace required'; END IF;
 IF EXISTS(SELECT 1 FROM app_private.mhp_prospects WHERE id='ed125000-0000-4000-8000-000000000001')
  OR EXISTS(SELECT 1 FROM app_private.mhp_marketing_sends WHERE campaign_key LIKE 'webinar-ghq004-%')
 THEN RAISE EXCEPTION 'Require fresh isolated reader fixtures'; END IF;
 PERFORM set_config('mhp.reader.actor',actor::text,true);
 PERFORM set_config('mhp.reader.personal',personal::text,true);
 FOR n IN 1..29 LOOP
  prospect:=('ed125000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;
  signup:=('ed125100-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;
  delivery:=('ed125200-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;
  INSERT INTO app_private.mhp_prospects(id,email,first_name,level,marketing_consent,consent_version,consent_at,unsubscribed_at)
  VALUES(prospect,'reader-'||n||'@example.invalid','Saved name '||n,'L1',n<>2,'synthetic-v1','2026-10-30T09:00:00Z',CASE WHEN n=2 THEN '2026-10-30T10:03:00Z'::timestamptz END);
  INSERT INTO app_private.mhp_prospect_signups(id,prospect_id,kind,label,link,consent_given,consent_version,created_at)
  VALUES(signup,prospect,CASE WHEN n=29 THEN 'waitlist' ELSE 'webinar' END,'Original webinar signup',
   'https://martinhowardproperty.co.uk/webinar',true,'synthetic-v1','2026-10-30T10:00:00Z');
  --28 has no campaign anchor (all scheduling steps expired);29 has no webinar signup.
  IF n<>28 THEN
   INSERT INTO app_private.mhp_marketing_sends(id,prospect_id,template_key,campaign_key,context,due_at,expires_at,created_at,sent_at,provider_reference,cancelled_at)
   VALUES(delivery,prospect,'webinar_confirm','webinar-ghq004-proof','{}','2026-10-30T10:01:00Z','2026-11-04T19:30:00Z','2026-10-30T10:01:00Z',
    CASE WHEN n=1 THEN '2026-10-30T10:02:00Z'::timestamptz END,CASE WHEN n=1 THEN 'synthetic-accepted-reference' END,
    CASE WHEN n=2 THEN '2026-10-30T10:03:00Z'::timestamptz END);
  END IF;
 END LOOP;
 --The same email signs up for another webinar, then repeats the first campaign.
 INSERT INTO app_private.mhp_prospect_signups(id,prospect_id,kind,label,link,consent_given,consent_version,created_at)
 VALUES('ed125100-0000-4000-8000-000000000100','ed125000-0000-4000-8000-000000000001','webinar','Second campaign signup','https://martinhowardproperty.co.uk/webinar',true,'synthetic-v1','2026-10-30T11:00:00Z'),
 ('ed125100-0000-4000-8000-000000000101','ed125000-0000-4000-8000-000000000001','webinar','Repeated first campaign signup','https://martinhowardproperty.co.uk/webinar',true,'synthetic-v1','2026-10-30T12:00:00Z');
 INSERT INTO app_private.mhp_marketing_sends(id,prospect_id,template_key,campaign_key,context,due_at,expires_at,created_at)
 VALUES('ed125200-0000-4000-8000-000000000100','ed125000-0000-4000-8000-000000000001','webinar_confirm','webinar-ghq004-other','{}','2026-10-30T11:01:00Z','2026-11-05T19:30:00Z','2026-10-30T11:01:00Z');
 UPDATE app_private.mhp_prospects SET first_name='Current changed name',level='L3',updated_at=clock_timestamp() WHERE id='ed125000-0000-4000-8000-000000000001';
 INSERT INTO app.users(id,email,display_name,status,email_verified_at) VALUES(normal,'reader-member@example.invalid','Synthetic ordinary member','active',clock_timestamp());
 INSERT INTO app.organization_memberships(organization_id,user_id,role,status) VALUES('ba41b1a4-9752-4dbf-8312-d04a0f03d0b8',normal,'billing','active');
 INSERT INTO app.workspace_memberships(workspace_id,organization_id,user_id,role,status)
 VALUES('2789228d-55a6-4688-b1e8-2f70abca990b','ba41b1a4-9752-4dbf-8312-d04a0f03d0b8',normal,'owner','active');
 INSERT INTO app.user_sessions(token_hash,csrf_secret_hash,user_id,selected_workspace_id,expires_at,product_audience,revoked_at,created_at)
 SELECT public.digest(label,'sha256'),public.digest(label||'-csrf','sha256'),
  CASE WHEN label='reader-member' THEN normal ELSE actor END,
  CASE WHEN label='reader-personal' THEN personal ELSE '2789228d-55a6-4688-b1e8-2f70abca990b'::uuid END,
  clock_timestamp()+CASE WHEN label='reader-expired' THEN interval '-1 minute' ELSE interval '1 hour' END,
  CASE WHEN label='reader-foreign' THEN 'property_predator_growth' ELSE 'martin_howard_property' END,
  CASE WHEN label='reader-revoked' THEN clock_timestamp() END,clock_timestamp()-interval '2 hours'
 FROM(VALUES('reader-owner'),('reader-personal'),('reader-member'),('reader-foreign'),('reader-expired'),('reader-revoked')) v(label);
 PERFORM set_config('mhp.reader.queue_hash',(SELECT md5(COALESCE(string_agg(row_to_json(s)::text,'' ORDER BY s.id),'')) FROM app_private.mhp_marketing_sends s),true);
 PERFORM set_config('mhp.reader.crm_count',(SELECT count(*)::text FROM app.opportunities),true);
END $seed$;

DO $grants$ BEGIN
 IF NOT has_function_privilege('r72_web','app_private.mhp_webinar_lead_candidates(bytea,text,uuid,integer)','EXECUTE')
  OR has_function_privilege('r72_identity_command','app_private.mhp_webinar_lead_candidates(bytea,text,uuid,integer)','EXECUTE')
  OR has_function_privilege('r72_crm_command','app_private.mhp_webinar_lead_candidates(bytea,text,uuid,integer)','EXECUTE')
  OR NOT has_function_privilege('r72_mhp_prospect_definer','app_private.mhp_marketing_workspace_allowed(uuid,uuid)','EXECUTE')
  OR has_table_privilege('r72_web','app_private.mhp_prospects','SELECT,INSERT,UPDATE,DELETE')
  OR has_table_privilege('r72_web','app_private.mhp_prospect_signups','SELECT,INSERT,UPDATE,DELETE')
  OR has_table_privilege('r72_web','app_private.mhp_marketing_sends','SELECT,INSERT,UPDATE,DELETE')
  OR has_schema_privilege('r72_mhp_prospect_definer','app_private','CREATE')
 THEN RAISE EXCEPTION 'Webinar reader grant boundary changed'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner
  WHERE p.oid='app_private.mhp_webinar_lead_candidates(bytea,text,uuid,integer)'::regprocedure
   AND p.prosecdef AND p.provolatile='s' AND r.rolname='r72_mhp_prospect_definer' AND NOT r.rolcanlogin)
 THEN RAISE EXCEPTION 'Reader definer/stability boundary failed'; END IF;
 IF (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='app_private' AND c.relname IN('mhp_prospects','mhp_prospect_signups','mhp_marketing_sends') AND c.relrowsecurity AND c.relforcerowsecurity)<>3
 THEN RAISE EXCEPTION 'Existing prospect RLS is not forced'; END IF;
END $grants$;

SET LOCAL ROLE r72_web;
DO $denied$
DECLARE label text;
BEGIN
 FOREACH label IN ARRAY ARRAY['reader-personal','reader-member','reader-foreign','reader-expired','reader-revoked','reader-absent'] LOOP
  BEGIN
   PERFORM app_private.mhp_webinar_lead_candidates(public.digest(label,'sha256'),'webinar-ghq004-proof',NULL,25);
   RAISE EXCEPTION 'Reader admitted rejected context: %',label;
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 END LOOP;
 BEGIN PERFORM app_private.mhp_webinar_lead_candidates(public.digest('reader-owner','sha256'),'webinar-ghq004-proof',NULL,26);
  RAISE EXCEPTION 'Reader accepted oversized page'; EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
 BEGIN PERFORM app_private.mhp_webinar_lead_candidates(public.digest('reader-owner','sha256'),'bad campaign',NULL,25);
  RAISE EXCEPTION 'Reader accepted invalid campaign'; EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
END $denied$;

DO $pages$
DECLARE first_page jsonb; tail jsonb; other jsonb; item jsonb;
BEGIN
 first_page:=app_private.mhp_webinar_lead_candidates(public.digest('reader-owner','sha256'),'webinar-ghq004-proof',NULL,25);
 IF jsonb_array_length(first_page->'candidates')<>25 OR NOT(first_page->>'hasMore')::boolean
  OR first_page->>'nextAfter'<>'ed125000-0000-4000-8000-000000000025'
 THEN RAISE EXCEPTION 'Reader cap/first cursor failed'; END IF;
 item:=first_page->'candidates'->0;
 IF item->>'signupId'<>'ed125100-0000-4000-8000-000000000001'
  OR item->>'firstName'<>'Current changed name' OR item->>'level'<>'L3'
 THEN RAISE EXCEPTION 'Repeat email/current identity/original campaign anchor failed'; END IF;
 item:=first_page->'candidates'->1;
 IF NOT(item->>'unsubscribed')::boolean OR (item->>'marketingConsent')::boolean
  OR NOT(item->>'signupConsentGiven')::boolean
 THEN RAISE EXCEPTION 'Cancelled/unsubscribed registration evidence was lost or consent invented'; END IF;
 IF first_page::text ~ 'provider_reference|lease_until|source_hash|synthetic-accepted-reference'
 THEN RAISE EXCEPTION 'Reader exposed queue/provider/private evidence'; END IF;
 tail:=app_private.mhp_webinar_lead_candidates(public.digest('reader-owner','sha256'),'webinar-ghq004-proof',(first_page->>'nextAfter')::uuid,25);
 IF jsonb_array_length(tail->'candidates')<>2 OR(tail->>'hasMore')::boolean OR tail->>'nextAfter' IS NOT NULL
  OR tail->'candidates'->1->>'prospectId'<>'ed125000-0000-4000-8000-000000000027'
 THEN RAISE EXCEPTION 'Tail duplicated/skipped records or fabricated an unanchored signup'; END IF;
 other:=app_private.mhp_webinar_lead_candidates(public.digest('reader-owner','sha256'),'webinar-ghq004-other',NULL,25);
 IF jsonb_array_length(other->'candidates')<>1 OR other->'candidates'->0->>'signupId'<>'ed125100-0000-4000-8000-000000000100'
 THEN RAISE EXCEPTION 'Distinct webinar campaign anchor failed'; END IF;
 IF jsonb_array_length(app_private.mhp_webinar_lead_candidates(public.digest('reader-owner','sha256'),'webinar-ghq004-missing',NULL,25)->'candidates')<>0
 THEN RAISE EXCEPTION 'Reader invented an unknown campaign'; END IF;
END $pages$;

SET LOCAL ROLE r72_owner;
DO $unchanged$ BEGIN
 IF (SELECT md5(COALESCE(string_agg(row_to_json(s)::text,'' ORDER BY s.id),'')) FROM app_private.mhp_marketing_sends s)
   IS DISTINCT FROM current_setting('mhp.reader.queue_hash')
  OR (SELECT count(*) FROM app.opportunities)<>current_setting('mhp.reader.crm_count')::bigint
 THEN RAISE EXCEPTION 'Reader changed the queue or CRM'; END IF;
END $unchanged$;
SELECT 'GHQ-WEBINAR-004 candidate reader proof reached its final assertion' AS proof;
-- Root harness deliberately raises its expected rollback sentinel after this.
