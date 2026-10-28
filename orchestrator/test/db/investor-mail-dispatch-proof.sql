-- DATABASE-ONLY simulation. No SMTP, Google, Microsoft or Mailgun call occurs.
DO $g$ BEGIN IF current_database() NOT LIKE '%test%' THEN RAISE EXCEPTION 'Test database required';END IF;END $g$;
SET LOCAL ROLE r72_owner;
SELECT set_config('test.mail_point',(SELECT p.id::text FROM app.contact_points p JOIN app.investor_sites s USING(workspace_id) WHERE s.slug='northstar-proof' AND p.normalized_value='visitor@example.invalid'),true);
SELECT set_config('test.approved_message',(SELECT message_id::text FROM app.investor_email_messages WHERE command_key='71000000-0000-4000-8000-000000000041'),true);
SET LOCAL ROLE r72_identity_command;
DO $p$ DECLARE mid uuid;r jsonb;BEGIN
 BEGIN
  PERFORM app_private.claim_investor_email(decode(repeat('e3',32),'hex'),current_setting('test.approved_message')::uuid,3,public.digest('Synthetic reviewed body only.','sha256'),decode(repeat('b6',32),'hex'),'');
  RAISE EXCEPTION 'No send confirmation accepted';
 EXCEPTION WHEN insufficient_privilege THEN NULL;END;
 BEGIN
  PERFORM app_private.claim_investor_email(decode(repeat('e3',32),'hex'),current_setting('test.approved_message')::uuid,3,public.digest('Synthetic reviewed body only.','sha256'),decode(repeat('b6',32),'hex'),'send_approved_message');
  RAISE EXCEPTION 'Send without recipient permission accepted';
 EXCEPTION WHEN insufficient_privilege THEN NULL;END;
 mid:=app_private.draft_investor_email(decode(repeat('e3',32),'hex'),'71000000-0000-4000-8000-000000000042',current_setting('test.mail_point')::uuid,'Unapproved subject','Unapproved body.',NULL);
 PERFORM set_config('test.unapproved_message',mid::text,true);
 BEGIN
  PERFORM app_private.claim_investor_email(decode(repeat('e3',32),'hex'),mid,1,public.digest('Unapproved body.','sha256'),decode(repeat('b7',32),'hex'),'send_approved_message');
  RAISE EXCEPTION 'Dispatch approved its own draft';
 EXCEPTION WHEN serialization_failure THEN NULL;END;
 PERFORM app_private.record_investor_email_permission(decode(repeat('e3',32),'hex'),current_setting('test.mail_point')::uuid,'71000000-0000-4000-8000-000000000043',true,'Synthetic requested-email evidence, not a real person or consent claim.');
 r:=app_private.claim_investor_email(decode(repeat('e3',32),'hex'),current_setting('test.approved_message')::uuid,3,public.digest('Synthetic reviewed body only.','sha256'),decode(repeat('b6',32),'hex'),'send_approved_message');
 IF r->>'to'<>'visitor@example.invalid' OR r->>'text'<>'Synthetic reviewed body only.' THEN RAISE EXCEPTION 'Dispatch changed reviewed content';END IF;
 PERFORM set_config('test.email_operation',r->>'operationId',true);
 BEGIN
  PERFORM app_private.claim_investor_email(decode(repeat('e3',32),'hex'),current_setting('test.approved_message')::uuid,3,public.digest('Synthetic reviewed body only.','sha256'),decode(repeat('b6',32),'hex'),'send_approved_message');
  RAISE EXCEPTION 'Duplicate dispatch succeeded';
 EXCEPTION WHEN serialization_failure THEN NULL;END;
 BEGIN
  PERFORM app_private.settle_investor_email(decode(repeat('e3',32),'hex'),(r->>'operationId')::uuid,decode(repeat('b8',32),'hex'),true,'FAKE-TEST-ACCEPTANCE');
  RAISE EXCEPTION 'Wrong lease settled a send';
 EXCEPTION WHEN serialization_failure THEN NULL;END;
 PERFORM app_private.settle_investor_email(decode(repeat('e3',32),'hex'),(r->>'operationId')::uuid,decode(repeat('b6',32),'hex'),true,'FAKE-TEST-ACCEPTANCE-NO-EMAIL');
 END $p$;
SET LOCAL ROLE r72_owner;
DO $p$ BEGIN
 IF EXISTS(SELECT 1 FROM app.message_approval_decisions WHERE message_id=current_setting('test.unapproved_message')::uuid) THEN RAISE EXCEPTION 'Dispatch generated an approval';END IF;
 IF (SELECT count(*) FROM app.provider_operations WHERE id=current_setting('test.email_operation')::uuid)<>1 THEN RAISE EXCEPTION 'Dispatch operation cardinality wrong';END IF;
 IF NOT EXISTS(SELECT 1 FROM app.message_deliveries WHERE provider_operation_id=current_setting('test.email_operation')::uuid AND status='accepted' AND delivered_at IS NULL) THEN RAISE EXCEPTION 'Provider acceptance confused with delivery';END IF;
 IF has_table_privilege('r72_identity_command','app.message_deliveries','INSERT') THEN RAISE EXCEPTION 'Runtime gained direct delivery insertion';END IF;
 END $p$;
RESET ROLE;
SELECT 'separate approval/send, recipient permission, replay and lease proof passed; database-only simulated acceptance' AS result;
