-- Synthetic database proof only. No mailbox is contacted.
DO $g$ BEGIN IF current_database() NOT LIKE '%test%' THEN RAISE EXCEPTION 'Test database required';END IF;END $g$;
SET LOCAL ROLE r72_owner;
SELECT set_config('test.original_message',(SELECT message_id::text FROM app.investor_email_messages WHERE command_key='71000000-0000-4000-8000-000000000041'),true);
SELECT set_config('test.original_header',(SELECT internet_message_id FROM app.investor_email_messages WHERE message_id=current_setting('test.original_message')::uuid),true);
SELECT set_config('test.mail_point',(SELECT contact_point_id::text FROM app.messages WHERE id=current_setting('test.original_message')::uuid),true);
SET LOCAL ROLE r72_identity_command;
DO $p$ DECLARE batch jsonb;r jsonb;reply uuid;s jsonb;BEGIN
 batch:=jsonb_build_array(
  jsonb_build_object('providerId','test-reply-1','messageId','<test-reply-1@example.invalid>','inReplyTo',current_setting('test.original_header'),'references','[]'::jsonb,'from','visitor@example.invalid','to',jsonb_build_array('hello@northstar.example.invalid'),'subject','Re: Synthetic review','text','Synthetic reply. No person was emailed.','receivedAt',statement_timestamp()),
  jsonb_build_object('providerId','test-private-1','messageId','<test-private-1@example.invalid>','references','[]'::jsonb,'from','unrelated@example.invalid','to',jsonb_build_array('hello@northstar.example.invalid'),'subject','Private','text','Must not import','receivedAt',statement_timestamp()),
  jsonb_build_object('providerId','test-wrong-mailbox','messageId','<test-wrong-mailbox@example.invalid>','references','[]'::jsonb,'from','visitor@example.invalid','to',jsonb_build_array('other@example.invalid'),'subject','Wrong mailbox','text','Must not import','receivedAt',statement_timestamp()),
  jsonb_build_object('providerId','test-foreign-thread','messageId','<test-foreign-thread@example.invalid>','inReplyTo','<foreign-business@example.invalid>','references','[]'::jsonb,'from','visitor@example.invalid','to',jsonb_build_array('hello@northstar.example.invalid'),'subject','Foreign thread','text','Must not import','receivedAt',statement_timestamp()));
 r:=app_private.import_investor_email_page(decode(repeat('e3',32),'hex'),1,NULL,'test-cursor-1',batch);
 IF r<>jsonb_build_object('imported',1,'unmatched',3,'duplicates',0) THEN RAISE EXCEPTION 'Reply filtering failed: %',r;END IF;
 r:=app_private.import_investor_email_page(decode(repeat('e3',32),'hex'),1,'test-cursor-1','test-cursor-2',batch);
 IF r<>jsonb_build_object('imported',0,'unmatched',3,'duplicates',1) THEN RAISE EXCEPTION 'Reply dedupe failed: %',r;END IF;
 BEGIN
  PERFORM app_private.import_investor_email_page(decode(repeat('e3',32),'hex'),1,'test-cursor-1','bad-cursor','[]');
  RAISE EXCEPTION 'Stale cursor advanced';
 EXCEPTION WHEN serialization_failure THEN NULL;END;
 BEGIN
  PERFORM app_private.import_investor_email_page(decode(repeat('e3',32),'hex'),2,'test-cursor-2','bad-cursor','[]');
  RAISE EXCEPTION 'Stale mailbox version accepted';
 EXCEPTION WHEN serialization_failure THEN NULL;END;
 BEGIN
  PERFORM app_private.record_investor_email_permission(decode(repeat('e3',32),'hex'),current_setting('test.mail_point')::uuid,'71000000-0000-4000-8000-000000000043',false,'Changed synthetic evidence should conflict.');
  RAISE EXCEPTION 'Changed permission replay accepted';
 EXCEPTION WHEN serialization_failure THEN NULL;END;
 END $p$;
SET LOCAL ROLE r72_web;
DO $p$ DECLARE s jsonb;BEGIN
 s:=app_private.investor_email_snapshot(decode(repeat('e3',32),'hex'),current_setting('test.original_message')::uuid);
 IF s->'selected'->>'state'<>'accepted' THEN RAISE EXCEPTION 'Original acceptance changed during reply import';END IF;
 END $p$;
SET LOCAL ROLE r72_owner;
DO $p$ DECLARE reply record;original record;BEGIN
 SELECT m.* INTO reply FROM app.messages m JOIN app.investor_email_messages x ON x.workspace_id=m.workspace_id AND x.message_id=m.id WHERE x.provider_inbound_id='test-reply-1';
 SELECT * INTO original FROM app.messages WHERE id=current_setting('test.original_message')::uuid;
 IF reply.conversation_id IS DISTINCT FROM original.conversation_id OR reply.workspace_id IS DISTINCT FROM original.workspace_id OR reply.direction<>'inbound' THEN RAISE EXCEPTION 'Reply lost thread or workspace';END IF;
 IF EXISTS(SELECT 1 FROM app.investor_email_messages WHERE provider_inbound_id IN('test-private-1','test-wrong-mailbox','test-foreign-thread')) THEN RAISE EXCEPTION 'Unmatched mail persisted';END IF;
 IF has_table_privilege('r72_identity_command','app.investor_email_messages','INSERT') THEN RAISE EXCEPTION 'Direct runtime insert allowed';END IF;
 END $p$;
RESET ROLE;
SELECT 'reply correlation, mailbox filtering, duplicate import, cursor fencing and permission replay proof passed' AS result;
