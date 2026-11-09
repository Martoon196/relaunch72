-- Exact mailbox cursor and reply import. Unmatched personal mail is not persisted.
SET LOCAL ROLE r72_owner;
GRANT CREATE ON SCHEMA app_private TO r72_investor_programme_definer,r72_investor_email_definer;
SET LOCAL ROLE r72_investor_programme_definer;
CREATE FUNCTION app_private.refresh_investor_mail_credentials(p_session bytea,p_version bigint,p_previous_hash bytea,p_sealed text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE ws uuid;
BEGIN
 ws:=app_private.investor_mail_workspace(p_session,true);
 IF p_sealed IS NULL OR length(p_sealed) NOT BETWEEN 1 AND 32000 THEN RAISE EXCEPTION 'Invalid credential envelope' USING ERRCODE='22023';END IF;
 UPDATE app_private.investor_mail_accounts SET sealed_credentials=p_sealed,updated_at=clock_timestamp()
 WHERE workspace_id=ws AND row_version=p_version AND provider IN('google','microsoft') AND status='verified' AND public.digest(sealed_credentials,'sha256')=p_previous_hash;
 IF NOT FOUND THEN RAISE EXCEPTION 'Mailbox authorisation changed; refresh before retrying' USING ERRCODE='40001';END IF;
END $f$;
REVOKE ALL ON FUNCTION app_private.refresh_investor_mail_credentials(bytea,bigint,bytea,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.refresh_investor_mail_credentials(bytea,bigint,bytea,text) TO r72_identity_command;
SET LOCAL ROLE r72_investor_email_definer;
CREATE FUNCTION app_private.import_investor_email_page(p_session bytea,p_version bigint,p_previous_cursor text,p_next_cursor text,p_messages jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE ws uuid;actor uuid;a record;item jsonb;point record;conversation uuid;conn uuid;endpoint uuid;inbox uuid;mid uuid;vid uuid;body text;subject text;internet_id text;source_id text;reply text;reference_ids text[];request_hash bytea;existing record;imported integer:=0;unmatched integer:=0;duplicates integer:=0;received timestamptz;
BEGIN
 ws:=app_private.investor_mail_workspace(p_session,true);SELECT user_id INTO actor FROM app_private.resolve_session(p_session);
 IF p_messages IS NULL OR jsonb_typeof(p_messages)<>'array' OR jsonb_array_length(p_messages)>50 OR octet_length(p_messages::text)>2000000 OR length(p_next_cursor)>12000 THEN RAISE EXCEPTION 'Invalid inbox page' USING ERRCODE='22023';END IF;
 SELECT provider,address,row_version,settings,sync_cursor INTO a FROM app_private.investor_mail_accounts WHERE workspace_id=ws AND status='verified' FOR UPDATE;
 IF NOT FOUND OR a.row_version<>p_version OR a.sync_cursor IS DISTINCT FROM p_previous_cursor THEN RAISE EXCEPTION 'Mailbox sync changed; refresh before retrying' USING ERRCODE='40001';END IF;
 SELECT id INTO conn FROM app.provider_connections WHERE workspace_id=ws AND provider_id='investor_'||a.provider AND environment='live' AND status='active';
 IF conn IS NULL THEN INSERT INTO app.provider_connections(workspace_id,provider_id,provider_kind,environment,status,display_name,capabilities,created_by_user_id) VALUES(ws,'investor_'||a.provider,'email','live','active','Investor mailbox','["email.send","email.receive"]',actor) RETURNING id INTO conn;END IF;
 SELECT id INTO endpoint FROM app.channel_endpoints WHERE workspace_id=ws AND provider_connection_id=conn AND normalized_address=a.address AND status='active';
 IF endpoint IS NULL THEN INSERT INTO app.channel_endpoints(workspace_id,provider_connection_id,channel,environment,direction,address,normalized_address,display_name,status) VALUES(ws,conn,'email','live','bidirectional',a.address,a.address,COALESCE(NULLIF(a.settings->>'displayName',''),left(a.address,120)),'active') RETURNING id INTO endpoint;END IF;
 SELECT id INTO inbox FROM app.inboxes WHERE workspace_id=ws AND channel_endpoint_id=endpoint;
 IF inbox IS NULL THEN INSERT INTO app.inboxes(workspace_id,channel_endpoint_id,provider_connection_id,channel,environment,name,status) VALUES(ws,endpoint,conn,'email','live',left(a.address,120),'active') RETURNING id INTO inbox;END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(p_messages) LOOP
  conversation:=NULL;reply:=NULL;
  IF jsonb_typeof(item->'to')<>'array' OR NOT (item->'to' ? a.address) THEN unmatched:=unmatched+1;CONTINUE;END IF;
  SELECT p.id,p.contact_id INTO point FROM app.contact_points p JOIN app.contacts c ON c.workspace_id=p.workspace_id AND c.id=p.contact_id
  WHERE p.workspace_id=ws AND p.kind='email' AND p.normalized_value=lower(item->>'from') AND p.deleted_at IS NULL AND p.dedupe_state='normal' AND c.deleted_at IS NULL;
  IF NOT FOUND THEN unmatched:=unmatched+1;CONTINUE;END IF;
  body:=item->>'text';subject:=COALESCE(NULLIF(item->>'subject',''),'(No subject)');internet_id:=item->>'messageId';source_id:=item->>'providerId';
  IF body IS NULL OR octet_length(body) NOT BETWEEN 1 AND 65536 OR internet_id IS NULL OR length(internet_id) NOT BETWEEN 3 AND 600 OR internet_id ~ E'[\r\n]' OR length(subject)>500 OR subject ~ E'[\r\n]' OR source_id IS NULL OR length(source_id) NOT BETWEEN 1 AND 500 THEN unmatched:=unmatched+1;CONTINUE;END IF;
  request_hash:=public.digest(item::text,'sha256');
  SELECT x.request_hash INTO existing FROM app.investor_email_messages x WHERE x.workspace_id=ws AND x.mailbox_address=a.address AND (x.internet_message_id=internet_id OR x.provider_inbound_id=source_id);
  IF FOUND THEN duplicates:=duplicates+1;CONTINUE;END IF;
  reference_ids:=ARRAY(SELECT value FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(item->'references')='array' THEN item->'references' ELSE '[]'::jsonb END));
  IF NULLIF(item->>'inReplyTo','') IS NOT NULL THEN reference_ids:=array_prepend(item->>'inReplyTo',reference_ids);END IF;
  IF cardinality(reference_ids)>0 THEN
   SELECT m.conversation_id,x.internet_message_id INTO conversation,reply FROM app.investor_email_messages x JOIN app.messages m ON m.workspace_id=x.workspace_id AND m.id=x.message_id
   WHERE x.workspace_id=ws AND x.mailbox_address=a.address AND x.internet_message_id=ANY(reference_ids) AND m.contact_id=point.contact_id ORDER BY m.occurred_at DESC LIMIT 1;
   IF conversation IS NULL THEN unmatched:=unmatched+1;CONTINUE;END IF;
  ELSE
   SELECT id INTO conversation FROM app.conversations WHERE workspace_id=ws AND inbox_id=inbox AND contact_id=point.contact_id AND state IN('open','snoozed') LIMIT 1;
   IF conversation IS NULL THEN INSERT INTO app.conversations(workspace_id,inbox_id,channel,environment,contact_id,subject) VALUES(ws,inbox,'email','live',point.contact_id,subject) RETURNING id INTO conversation;END IF;
  END IF;
  IF NULLIF(item->>'receivedAt','') IS NULL THEN RAISE EXCEPTION 'Message receive time missing' USING ERRCODE='22023';END IF;
  mid:=gen_random_uuid();vid:=gen_random_uuid();received:=LEAST((item->>'receivedAt')::timestamptz,statement_timestamp());
  INSERT INTO app.messages(id,workspace_id,conversation_id,contact_id,contact_point_id,channel,environment,direction,lifecycle,source_kind,current_version_id,current_version_number,current_body_sha256,created_by_actor_kind,occurred_at)
  VALUES(mid,ws,conversation,point.contact_id,point.id,'email','live','inbound','received','system',vid,1,public.digest(body,'sha256'),'system',received);
  INSERT INTO app.message_versions(id,workspace_id,conversation_id,message_id,channel,environment,version_number,body_text,created_by_actor_kind,created_request_id)
  VALUES(vid,ws,conversation,mid,'email','live',1,body,'system',mid::text);
  INSERT INTO app.investor_email_messages(workspace_id,message_id,account_version,mailbox_address,internet_message_id,subject,recipient,in_reply_to,command_key,request_hash,provider_inbound_id)
  VALUES(ws,mid,a.row_version,a.address,internet_id,subject,item->>'from',reply,gen_random_uuid(),request_hash,source_id);
  UPDATE app.conversations SET unread_count=unread_count+1,last_message_at=GREATEST(last_message_at,received),row_version=row_version+1 WHERE workspace_id=ws AND id=conversation;
  imported:=imported+1;
 END LOOP;
 UPDATE app_private.investor_mail_accounts SET sync_cursor=p_next_cursor WHERE workspace_id=ws;
 RETURN jsonb_build_object('imported',imported,'unmatched',unmatched,'duplicates',duplicates);
END $f$;
REVOKE ALL ON FUNCTION app_private.import_investor_email_page(bytea,bigint,text,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.import_investor_email_page(bytea,bigint,text,text,jsonb) TO r72_identity_command;
RESET ROLE;
SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private FROM r72_investor_programme_definer,r72_investor_email_definer;
RESET ROLE;
