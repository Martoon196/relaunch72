-- Isolated *_test branch only. Fake encrypted credentials; no transport is called.
DO $g$ BEGIN IF current_database() NOT LIKE '%test%' THEN RAISE EXCEPTION 'Test database required';END IF;END $g$;
SET LOCAL ROLE r72_identity_command;
SELECT app_private.save_investor_mail_connection(decode(repeat('e3',32),'hex'),0,'smtp','hello@northstar.example.invalid','{"displayName":"Northstar","smtpHost":"smtp.example.invalid","smtpPort":465,"imapHost":"imap.example.invalid","imapPort":993}','FAKE-TEST-CIPHERTEXT-NOT-USABLE');
DO $p$ BEGIN
 BEGIN
  PERFORM app_private.verify_investor_mail_connection(decode(repeat('e3',32),'hex'),1,'wrong@example.invalid');
  RAISE EXCEPTION 'Wrong mailbox identity verified';
 EXCEPTION WHEN serialization_failure THEN NULL;END;
 PERFORM app_private.verify_investor_mail_connection(decode(repeat('e3',32),'hex'),1,'hello@northstar.example.invalid');
 PERFORM app_private.begin_investor_oauth(decode(repeat('e3',32),'hex'),decode(repeat('d3',32),'hex'),'google','FAKE-TEST-VERIFIER');
 BEGIN
  PERFORM app_private.consume_investor_oauth(decode(repeat('a7',32),'hex'),decode(repeat('d3',32),'hex'));
  RAISE EXCEPTION 'Other workspace consumed OAuth state';
 EXCEPTION WHEN insufficient_privilege THEN NULL;END;
 PERFORM app_private.consume_investor_oauth(decode(repeat('e3',32),'hex'),decode(repeat('d3',32),'hex'));
 BEGIN
  PERFORM app_private.consume_investor_oauth(decode(repeat('e3',32),'hex'),decode(repeat('d3',32),'hex'));
  RAISE EXCEPTION 'OAuth state replayed';
 EXCEPTION WHEN insufficient_privilege THEN NULL;END;
 END $p$;
SET LOCAL ROLE r72_web;
DO $p$ DECLARE s jsonb;BEGIN
 s:=app_private.investor_mail_snapshot(decode(repeat('e3',32),'hex'));
 IF s?'sealed' OR s?'sealed_credentials' OR s->>'status'<>'verified' THEN RAISE EXCEPTION 'Public mailbox metadata unsafe';END IF;
 IF app_private.investor_mail_snapshot(decode(repeat('a7',32),'hex')) IS NOT NULL THEN RAISE EXCEPTION 'Other workspace saw mailbox';END IF;
 END $p$;
SET LOCAL ROLE r72_owner;
SELECT set_config('test.mail_point',(SELECT p.id::text FROM app.contact_points p JOIN app.investor_sites s USING(workspace_id) WHERE s.slug='northstar-proof' AND p.normalized_value='visitor@example.invalid'),true);
SET LOCAL ROLE r72_identity_command;
SELECT set_config('test.mail_message',app_private.draft_investor_email(decode(repeat('e3',32),'hex'),'71000000-0000-4000-8000-000000000041',current_setting('test.mail_point')::uuid,'Test review subject','Synthetic reviewed body only.',NULL)::text,true);
DO $p$ BEGIN
 IF app_private.draft_investor_email(decode(repeat('e3',32),'hex'),'71000000-0000-4000-8000-000000000041',current_setting('test.mail_point')::uuid,'Test review subject','Synthetic reviewed body only.',NULL)::text<>current_setting('test.mail_message') THEN RAISE EXCEPTION 'Draft duplicated';END IF;
 BEGIN
  PERFORM app_private.approve_investor_email(decode(repeat('e3',32),'hex'),current_setting('test.mail_message')::uuid,1,decode(repeat('a1',32),'hex'),'');
  RAISE EXCEPTION 'Missing review confirmation accepted';
 EXCEPTION WHEN insufficient_privilege THEN NULL;END;
 BEGIN
  PERFORM app_private.approve_investor_email(decode(repeat('e3',32),'hex'),current_setting('test.mail_message')::uuid,1,decode(repeat('a1',32),'hex'),'approve_exact_message');
  RAISE EXCEPTION 'Wrong reviewed content accepted';
 EXCEPTION WHEN serialization_failure THEN NULL;END;
 END $p$;
SET LOCAL ROLE r72_web;
DO $p$ DECLARE s jsonb;BEGIN
 s:=app_private.investor_email_snapshot(decode(repeat('e3',32),'hex'),current_setting('test.mail_message')::uuid);
 IF s->'selected'->>'lifecycle'<>'draft' OR (s->'selected'->>'permissionRecorded')::boolean THEN RAISE EXCEPTION 'Draft or permission truth wrong';END IF;
 PERFORM set_config('test.review_hash',s->'selected'->>'reviewHash',true);
 END $p$;
SET LOCAL ROLE r72_identity_command;
SELECT app_private.approve_investor_email(decode(repeat('e3',32),'hex'),current_setting('test.mail_message')::uuid,1,decode(current_setting('test.review_hash'),'hex'),'approve_exact_message');
SET LOCAL ROLE r72_owner;
DO $p$ DECLARE ws uuid;BEGIN
 SELECT workspace_id INTO ws FROM app.investor_email_messages WHERE message_id=current_setting('test.mail_message')::uuid;
 IF (SELECT lifecycle FROM app.messages WHERE workspace_id=ws AND id=current_setting('test.mail_message')::uuid)<>'approved' THEN RAISE EXCEPTION 'Explicit review did not record approval';END IF;
 IF EXISTS(SELECT 1 FROM app.provider_operations WHERE workspace_id=ws) OR EXISTS(SELECT 1 FROM app.message_deliveries WHERE workspace_id=ws) THEN RAISE EXCEPTION 'Approval dispatched or queued email';END IF;
 IF has_function_privilege('r72_web','app_private.approve_investor_email(bytea,uuid,bigint,bytea,text)','EXECUTE') THEN RAISE EXCEPTION 'Web read role gained approval';END IF;
 END $p$;
RESET ROLE;
SELECT 'mail connection, OAuth fencing and separate human-review proof passed; zero delivery operations' AS result;
