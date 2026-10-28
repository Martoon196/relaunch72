-- Isolated test branch only, after both investor programme proofs.
DO $g$ BEGIN IF current_database() NOT LIKE '%test%' THEN RAISE EXCEPTION 'Test database required'; END IF; END $g$;
SET LOCAL ROLE r72_identity_command;
SELECT app_private.save_investor_site(decode(repeat('e3',32),'hex'),0,'northstar-proof','Talk about your property plans','Synthetic site proof only.','Manchester','owner@example.invalid','','',false);
SET LOCAL ROLE r72_web;
DO $p$ BEGIN IF app_private.public_investor_site('northstar-proof') IS NOT NULL THEN RAISE EXCEPTION 'Private draft exposed'; END IF; END $p$;
SET LOCAL ROLE r72_identity_command;
SELECT app_private.save_investor_site(decode(repeat('e3',32),'hex'),1,'northstar-proof','Talk about your property plans','Synthetic site proof only.','Manchester','owner@example.invalid','https://example.invalid/privacy','',true);
SELECT app_private.capture_investor_site_enquiry('northstar-proof',decode(repeat('c5',32),'hex'),'Site visitor','visitor@example.invalid','Test enquiry one');
SELECT app_private.capture_investor_site_enquiry('northstar-proof',decode(repeat('c5',32),'hex'),'Site visitor','visitor@example.invalid','Test enquiry one');
SET LOCAL ROLE r72_web;
DO $p$ DECLARE s jsonb; BEGIN
 s:=app_private.public_investor_site('northstar-proof');
 IF s->>'slug'<>'northstar-proof' OR s?'workspace_id' OR s?'owner_email' THEN RAISE EXCEPTION 'Unsafe public site projection'; END IF;
 END $p$;
SET LOCAL ROLE r72_owner;
DO $p$ DECLARE ws uuid; BEGIN
 SELECT workspace_id INTO ws FROM app.investor_sites WHERE slug='northstar-proof';
 IF (SELECT count(*) FROM app.contact_points WHERE workspace_id=ws AND normalized_value='visitor@example.invalid')<>1 THEN RAISE EXCEPTION 'Contact missing or duplicated'; END IF;
 IF (SELECT count(*) FROM app.activities WHERE workspace_id=ws AND activity_type='investor.site.enquiry')<>1 THEN RAISE EXCEPTION 'Submission replay duplicated enquiry'; END IF;
 IF EXISTS(SELECT 1 FROM app.contact_points WHERE workspace_id=ws AND normalized_value='visitor@example.invalid' AND (is_verified OR consent_status<>'unknown')) THEN RAISE EXCEPTION 'Enquiry invented verification/consent'; END IF;
 END $p$;
SET LOCAL ROLE r72_identity_command;
DO $p$ BEGIN
 BEGIN
  PERFORM app_private.save_investor_site(decode(repeat('e3',32),'hex'),1,'northstar-proof','Stale','Stale edit','','owner@example.invalid','','',false);
  RAISE EXCEPTION 'Stale site edit succeeded';
 EXCEPTION WHEN serialization_failure THEN NULL; END;
 PERFORM app_private.save_investor_site(decode(repeat('e3',32),'hex'),2,'northstar-proof','Private again','Synthetic site proof only.','','owner@example.invalid','','',false);
 BEGIN
  PERFORM app_private.capture_investor_site_enquiry('northstar-proof',decode(repeat('c6',32),'hex'),'Visitor','visitor@example.invalid','Forbidden new enquiry');
  RAISE EXCEPTION 'Unpublished site accepted enquiry';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 END $p$;
RESET ROLE;
SELECT 'site draft, publication, capture and replay proof passed' AS result;
