-- INV-CRM-001: one human-reviewed recipient, canonical inbox and delivery records.
DO $r$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='r72_investor_email_definer') THEN CREATE ROLE r72_investor_email_definer NOLOGIN NOINHERIT; END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='r72_investor_email_definer' AND (rolcanlogin OR rolinherit OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)) THEN RAISE EXCEPTION 'Unsafe investor email role'; END IF;
 IF EXISTS(SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member WHERE r.rolname='r72_investor_email_definer') THEN RAISE EXCEPTION 'Investor email role inherits another role'; END IF;
 IF EXISTS(SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.roleid JOIN pg_roles c ON c.oid=m.member WHERE r.rolname='r72_investor_email_definer' AND c.rolname NOT IN('r72_owner',current_user)) THEN RAISE EXCEPTION 'Unexpected investor email role member'; END IF;
 GRANT r72_investor_email_definer TO r72_owner;
 EXECUTE format('GRANT r72_investor_email_definer TO %I',current_user);
END $r$;
SET LOCAL ROLE r72_owner;
GRANT USAGE ON SCHEMA app,app_private TO r72_investor_email_definer;
GRANT CREATE ON SCHEMA app_private TO r72_investor_email_definer;
GRANT EXECUTE ON FUNCTION app_private.investor_mail_workspace(bytea,boolean),app_private.resolve_session(bytea) TO r72_investor_email_definer;
GRANT SELECT ON app_private.investor_mail_accounts TO r72_investor_email_definer;
CREATE POLICY investor_email_account_read ON app_private.investor_mail_accounts FOR SELECT TO r72_investor_email_definer USING(true);
GRANT UPDATE(sync_cursor) ON app_private.investor_mail_accounts TO r72_investor_email_definer;
CREATE POLICY investor_email_account_cursor ON app_private.investor_mail_accounts FOR UPDATE TO r72_investor_email_definer USING(true) WITH CHECK(true);
GRANT SELECT ON app.contacts,app.contact_points,app.communication_consent_events,app.communication_suppression_events TO r72_investor_email_definer;
GRANT INSERT ON app.communication_consent_events,app.communication_suppression_events TO r72_investor_email_definer;
GRANT UPDATE(is_verified,row_version,updated_at) ON app.contact_points TO r72_investor_email_definer;
GRANT SELECT,INSERT ON app.provider_connections,app.channel_endpoints,app.inboxes,app.message_versions,app.message_approval_requests,app.message_approval_decisions,app.provider_operation_receipts TO r72_investor_email_definer;
GRANT SELECT,INSERT,UPDATE ON app.provider_operation_attempts TO r72_investor_email_definer;
GRANT SELECT,INSERT,UPDATE ON app.conversations,app.messages,app.provider_operations,app.message_deliveries TO r72_investor_email_definer;
DO $p$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['contacts','contact_points','communication_consent_events','communication_suppression_events','provider_connections','channel_endpoints','inboxes','conversations','messages','message_versions','message_approval_requests','message_approval_decisions','provider_operations','message_deliveries','provider_operation_receipts','provider_operation_attempts'] LOOP
  EXECUTE format('CREATE POLICY investor_email_definer ON app.%I TO r72_investor_email_definer USING(true) WITH CHECK(true)',t);
 END LOOP;
END $p$;

CREATE TABLE app.investor_email_messages (
 workspace_id uuid NOT NULL REFERENCES app.investor_businesses(workspace_id),
 message_id uuid NOT NULL,
 account_version bigint NOT NULL,
 mailbox_address text NOT NULL,
 internet_message_id text NOT NULL CHECK(length(internet_message_id) BETWEEN 3 AND 600),
 subject text NOT NULL CHECK(length(subject) BETWEEN 1 AND 500 AND subject !~ E'[\r\n]'),
 recipient text NOT NULL,
 in_reply_to text CHECK(length(in_reply_to)<=600),
 command_key uuid NOT NULL,
 request_hash bytea NOT NULL CHECK(octet_length(request_hash)=32),
 provider_inbound_id text CHECK(length(provider_inbound_id)<=500),
 PRIMARY KEY(workspace_id,message_id),
 UNIQUE(workspace_id,command_key),
 UNIQUE(workspace_id,mailbox_address,internet_message_id),
 UNIQUE(workspace_id,mailbox_address,provider_inbound_id),
 FOREIGN KEY(workspace_id,message_id) REFERENCES app.messages(workspace_id,id)
);
ALTER TABLE app.investor_email_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.investor_email_messages FORCE ROW LEVEL SECURITY;
CREATE POLICY investor_email_message_owner ON app.investor_email_messages TO r72_owner USING(true) WITH CHECK(true);
CREATE POLICY investor_email_message_definer ON app.investor_email_messages TO r72_investor_email_definer USING(true) WITH CHECK(true);
REVOKE ALL ON app.investor_email_messages FROM PUBLIC;
GRANT SELECT,INSERT ON app.investor_email_messages TO r72_investor_email_definer;
INSERT INTO app_private.workspace_table_registry(schema_name,table_name,workspace_column) VALUES('app','investor_email_messages','workspace_id');
SET LOCAL ROLE r72_investor_email_definer;

CREATE FUNCTION app_private.investor_email_permission(p_ws uuid,p_point uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE identity_hash bytea;consent uuid;consent_state text;
BEGIN
 SELECT public.digest(kind||chr(31)||value||chr(31)||normalized_value,'sha256') INTO identity_hash FROM app.contact_points
 WHERE workspace_id=p_ws AND id=p_point AND kind='email' AND is_verified AND deleted_at IS NULL AND dedupe_state='normal';
 IF identity_hash IS NULL THEN RAISE EXCEPTION 'Verify the investor email first' USING ERRCODE='42501'; END IF;
 IF EXISTS(SELECT 1 FROM (SELECT DISTINCT ON(COALESCE(purpose,'')) state FROM app.communication_suppression_events WHERE workspace_id=p_ws AND contact_point_id=p_point AND channel='email'
  AND (purpose IS NULL OR purpose='investor_relationships') AND endpoint_identity_sha256=identity_hash AND occurred_at<=statement_timestamp()+interval '5 minutes'
  ORDER BY COALESCE(purpose,''),occurred_at DESC,recorded_at DESC,id DESC) latest WHERE state='suppressed') THEN RAISE EXCEPTION 'Email is suppressed' USING ERRCODE='42501'; END IF;
 SELECT id,state INTO consent,consent_state FROM app.communication_consent_events WHERE workspace_id=p_ws AND contact_point_id=p_point AND channel='email' AND purpose='investor_relationships'
 AND endpoint_identity_sha256=identity_hash AND occurred_at<=statement_timestamp()+interval '5 minutes' ORDER BY occurred_at DESC,recorded_at DESC,id DESC LIMIT 1;
 IF consent_state IS DISTINCT FROM 'granted' THEN RAISE EXCEPTION 'Record the investor request before emailing' USING ERRCODE='42501'; END IF;
 RETURN jsonb_build_object('consentId',consent,'identityHash',encode(identity_hash,'hex'));
END $f$;

CREATE FUNCTION app_private.record_investor_email_permission(p_session bytea,p_point uuid,p_key uuid,p_granted boolean,p_evidence text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE ws uuid;actor uuid;cid uuid;prior record;
BEGIN
 ws:=app_private.investor_mail_workspace(p_session,true);SELECT user_id INTO actor FROM app_private.resolve_session(p_session);
 SELECT p.contact_id INTO cid FROM app.contact_points p JOIN app.contacts c ON c.workspace_id=p.workspace_id AND c.id=p.contact_id
 WHERE p.workspace_id=ws AND p.id=p_point AND p.kind='email' AND p.deleted_at IS NULL AND p.dedupe_state='normal' AND c.deleted_at IS NULL FOR UPDATE OF p;
 IF cid IS NULL OR p_key IS NULL OR p_evidence IS NULL OR length(btrim(p_evidence)) NOT BETWEEN 10 AND 2000 THEN RAISE EXCEPTION 'Permission evidence required' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(ws::text||p_key::text,111));
 SELECT contact_point_id,evidence,true AS granted INTO prior FROM app.communication_consent_events WHERE workspace_id=ws AND source='investor_manual' AND source_event_id=p_key::text
 UNION ALL SELECT contact_point_id,evidence,false FROM app.communication_suppression_events WHERE workspace_id=ws AND source='investor_manual' AND source_event_id=p_key::text;
 IF FOUND THEN
  IF prior.contact_point_id IS DISTINCT FROM p_point OR prior.granted IS DISTINCT FROM p_granted OR prior.evidence->>'recordedEvidence' IS DISTINCT FROM p_evidence THEN RAISE EXCEPTION 'Permission command changed' USING ERRCODE='40001';END IF;
  RETURN;
 END IF;
 IF p_granted THEN
  UPDATE app.contact_points SET is_verified=true,row_version=row_version+1,updated_at=clock_timestamp() WHERE workspace_id=ws AND id=p_point;
  INSERT INTO app.communication_consent_events(workspace_id,contact_id,contact_point_id,channel,purpose,state,lawful_basis,source,source_event_id,actor_kind,actor_user_id,evidence,occurred_at)
  VALUES(ws,cid,p_point,'email','investor_relationships','granted','consent','investor_manual',p_key::text,'user',actor,jsonb_build_object('recordedEvidence',p_evidence),statement_timestamp());
 ELSE
  INSERT INTO app.communication_suppression_events(workspace_id,contact_id,contact_point_id,channel,purpose,state,reason,source,source_event_id,actor_kind,actor_user_id,evidence,occurred_at)
  VALUES(ws,cid,p_point,'email',NULL,'suppressed','recipient_request','investor_manual',p_key::text,'user',actor,jsonb_build_object('recordedEvidence',p_evidence),statement_timestamp());
 END IF;
END $f$;

CREATE FUNCTION app_private.draft_investor_email(p_session bytea,p_key uuid,p_point uuid,p_subject text,p_body text,p_reply text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE ws uuid;actor uuid;cid uuid;recipient text;account record;conn uuid;endpoint uuid;inbox uuid;conversation uuid;mid uuid:=gen_random_uuid();vid uuid:=gen_random_uuid();digest bytea;existing record;
BEGIN
 ws:=app_private.investor_mail_workspace(p_session,true);SELECT user_id INTO actor FROM app_private.resolve_session(p_session);
 IF p_key IS NULL OR p_subject IS NULL OR length(btrim(p_subject)) NOT BETWEEN 1 AND 200 OR p_subject ~ E'[\r\n]' OR p_body IS NULL OR octet_length(p_body) NOT BETWEEN 1 AND 32768 THEN RAISE EXCEPTION 'Invalid email draft' USING ERRCODE='22023'; END IF;
 digest:=public.digest(jsonb_build_array(p_point,p_subject,p_body,p_reply)::text,'sha256');
 PERFORM pg_advisory_xact_lock(hashtextextended(ws::text||p_key::text,110));
 SELECT message_id,request_hash INTO existing FROM app.investor_email_messages WHERE workspace_id=ws AND command_key=p_key;
 IF FOUND THEN IF existing.request_hash<>digest THEN RAISE EXCEPTION 'Draft command changed' USING ERRCODE='40001'; END IF;RETURN existing.message_id;END IF;
 SELECT p.contact_id,p.normalized_value INTO cid,recipient FROM app.contact_points p JOIN app.contacts c ON c.workspace_id=p.workspace_id AND c.id=p.contact_id
 WHERE p.workspace_id=ws AND p.id=p_point AND p.kind='email' AND p.deleted_at IS NULL AND p.dedupe_state='normal' AND c.deleted_at IS NULL;
 IF cid IS NULL THEN RAISE EXCEPTION 'Investor email unavailable' USING ERRCODE='42501'; END IF;
 SELECT provider,address,row_version,settings INTO account FROM app_private.investor_mail_accounts WHERE workspace_id=ws AND status='verified' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Connect a mailbox first' USING ERRCODE='42501'; END IF;
 IF p_reply IS NOT NULL AND NOT EXISTS(SELECT 1 FROM app.investor_email_messages x JOIN app.messages m ON m.workspace_id=x.workspace_id AND m.id=x.message_id WHERE x.workspace_id=ws AND x.mailbox_address=account.address AND x.internet_message_id=p_reply AND m.contact_id=cid) THEN RAISE EXCEPTION 'Reply is outside this conversation' USING ERRCODE='42501'; END IF;
 SELECT id INTO conn FROM app.provider_connections WHERE workspace_id=ws AND provider_id='investor_'||account.provider AND environment='live' AND status='active';
 IF conn IS NULL THEN INSERT INTO app.provider_connections(workspace_id,provider_id,provider_kind,environment,status,display_name,capabilities,created_by_user_id) VALUES(ws,'investor_'||account.provider,'email','live','active','Investor mailbox','["email.send","email.receive"]',actor) RETURNING id INTO conn;END IF;
 SELECT id INTO endpoint FROM app.channel_endpoints WHERE workspace_id=ws AND provider_connection_id=conn AND normalized_address=account.address AND status='active';
 IF endpoint IS NULL THEN INSERT INTO app.channel_endpoints(workspace_id,provider_connection_id,channel,environment,direction,address,normalized_address,display_name,status) VALUES(ws,conn,'email','live','bidirectional',account.address,account.address,COALESCE(account.settings->>'displayName',account.address),'active') RETURNING id INTO endpoint;END IF;
 SELECT id INTO inbox FROM app.inboxes WHERE workspace_id=ws AND channel_endpoint_id=endpoint;
 IF inbox IS NULL THEN INSERT INTO app.inboxes(workspace_id,channel_endpoint_id,provider_connection_id,channel,environment,name,status) VALUES(ws,endpoint,conn,'email','live',left(account.address,120),'active') RETURNING id INTO inbox;END IF;
 IF p_reply IS NOT NULL THEN
  SELECT m.conversation_id INTO conversation FROM app.investor_email_messages x JOIN app.messages m ON m.workspace_id=x.workspace_id AND m.id=x.message_id WHERE x.workspace_id=ws AND x.mailbox_address=account.address AND x.internet_message_id=p_reply AND m.contact_id=cid;
 ELSE
  SELECT id INTO conversation FROM app.conversations WHERE workspace_id=ws AND inbox_id=inbox AND contact_id=cid AND state IN('open','snoozed') LIMIT 1;
 END IF;
 IF conversation IS NULL THEN INSERT INTO app.conversations(workspace_id,inbox_id,channel,environment,contact_id,subject) VALUES(ws,inbox,'email','live',cid,p_subject) RETURNING id INTO conversation;END IF;
 INSERT INTO app.messages(id,workspace_id,conversation_id,contact_id,contact_point_id,channel,environment,direction,lifecycle,source_kind,current_version_id,current_version_number,current_body_sha256,created_by_actor_kind,created_by_user_id,occurred_at)
 VALUES(mid,ws,conversation,cid,p_point,'email','live','outbound','draft','user',vid,1,public.digest(p_body,'sha256'),'user',actor,statement_timestamp());
 INSERT INTO app.message_versions(id,workspace_id,conversation_id,message_id,channel,environment,version_number,body_text,created_by_actor_kind,created_by_user_id,created_request_id)
 VALUES(vid,ws,conversation,mid,'email','live',1,p_body,'user',actor,p_key::text);
 INSERT INTO app.investor_email_messages(workspace_id,message_id,account_version,mailbox_address,internet_message_id,subject,recipient,in_reply_to,command_key,request_hash)
 VALUES(ws,mid,account.row_version,account.address,'<iv-'||mid::text||'@'||split_part(account.address,'@',2)||'>',p_subject,recipient,p_reply,p_key,digest);
 RETURN mid;
END $f$;

-- Called only by the explicit review form. It records approval; it cannot queue,
-- claim, dispatch, or call a provider. Sending is a separate later action.
CREATE FUNCTION app_private.approve_investor_email(p_session bytea,p_message uuid,p_version bigint,p_review_hash bytea,p_confirmation text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE ws uuid;actor uuid;m app.messages%ROWTYPE;approval uuid:=gen_random_uuid();decision uuid:=gen_random_uuid();request_key text:=gen_random_uuid()::text;
BEGIN
 ws:=app_private.investor_mail_workspace(p_session,true);SELECT user_id INTO actor FROM app_private.resolve_session(p_session);
 IF p_confirmation IS DISTINCT FROM 'approve_exact_message' THEN RAISE EXCEPTION 'Explicit message review required' USING ERRCODE='42501';END IF;
 SELECT * INTO m FROM app.messages WHERE workspace_id=ws AND id=p_message FOR UPDATE;
 IF NOT FOUND OR m.lifecycle<>'draft' OR m.row_version<>p_version OR NOT EXISTS(SELECT 1 FROM app.investor_email_messages x WHERE x.workspace_id=ws AND x.message_id=p_message AND x.request_hash=p_review_hash)
 THEN RAISE EXCEPTION 'Review the current draft' USING ERRCODE='40001'; END IF;
 INSERT INTO app.message_approval_requests(id,workspace_id,conversation_id,message_id,message_version_id,version_number,body_sha256,request_number,requested_by_user_id,requested_request_id)
 VALUES(approval,ws,m.conversation_id,m.id,m.current_version_id,m.current_version_number,m.current_body_sha256,1,actor,request_key);
 UPDATE app.messages SET lifecycle='approval_pending',row_version=row_version+1 WHERE workspace_id=ws AND id=m.id;
 INSERT INTO app.message_approval_decisions(id,workspace_id,conversation_id,message_id,message_version_id,approval_request_id,version_number,body_sha256,decision,decided_by_user_id,decided_request_id)
 VALUES(decision,ws,m.conversation_id,m.id,m.current_version_id,approval,m.current_version_number,m.current_body_sha256,'approved',actor,request_key);
 UPDATE app.messages SET lifecycle='approved',row_version=row_version+1 WHERE workspace_id=ws AND id=m.id;
END $f$;

CREATE FUNCTION app_private.investor_email_snapshot(p_session bytea,p_message uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE ws uuid;selected jsonb;eligible boolean:=false;
BEGIN
 ws:=app_private.investor_mail_workspace(p_session,true);
 SELECT jsonb_build_object('id',m.id,'version',m.row_version,'bodyHash',encode(m.current_body_sha256,'hex'),'reviewHash',encode(x.request_hash,'hex'),
 'subject',x.subject,'text',v.body_text,'to',x.recipient,'from',x.mailbox_address,'contactName',c.display_name,'contactPointId',m.contact_point_id,'lifecycle',m.lifecycle,'state',CASE WHEN d.status='sending' AND op.state='calling' AND op.lease_expires_at<statement_timestamp() THEN 'reconciliation_required' ELSE COALESCE(d.status,m.lifecycle) END,'direction',m.direction,'internetMessageId',x.internet_message_id)
 INTO selected FROM app.investor_email_messages x JOIN app.messages m ON m.workspace_id=x.workspace_id AND m.id=x.message_id
 JOIN app.message_versions v ON v.workspace_id=m.workspace_id AND v.id=m.current_version_id JOIN app.contacts c ON c.workspace_id=m.workspace_id AND c.id=m.contact_id
 LEFT JOIN app.message_deliveries d ON d.workspace_id=m.workspace_id AND d.message_id=m.id LEFT JOIN app.provider_operations op ON op.workspace_id=d.workspace_id AND op.id=d.provider_operation_id WHERE x.workspace_id=ws AND m.id=p_message;
 IF selected IS NOT NULL THEN
  BEGIN PERFORM app_private.investor_email_permission(ws,(selected->>'contactPointId')::uuid);eligible:=true;EXCEPTION WHEN insufficient_privilege THEN eligible:=false;END;
  selected:=selected||jsonb_build_object('permissionRecorded',eligible);
 END IF;
 RETURN jsonb_build_object('selected',selected,'contacts',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',p.id,'name',c.display_name,'address',p.normalized_value,'verified',p.is_verified) ORDER BY c.display_name)
 FROM app.contact_points p JOIN app.contacts c ON c.workspace_id=p.workspace_id AND c.id=p.contact_id WHERE p.workspace_id=ws AND p.kind='email' AND p.deleted_at IS NULL AND p.dedupe_state='normal' AND c.deleted_at IS NULL),'[]'::jsonb),
 'messages',COALESCE((SELECT jsonb_agg(item ORDER BY occurred_at DESC,id DESC) FROM (SELECT m.occurred_at,m.id,jsonb_build_object('id',m.id,'subject',x.subject,'contactName',c.display_name,'to',x.recipient,'direction',m.direction,'state',CASE WHEN d.status='sending' AND op.state='calling' AND op.lease_expires_at<statement_timestamp() THEN 'reconciliation_required' ELSE COALESCE(d.status,m.lifecycle) END,'createdAt',m.occurred_at,'preview',left(v.body_text,140)) item
 FROM app.investor_email_messages x JOIN app.messages m ON m.workspace_id=x.workspace_id AND m.id=x.message_id JOIN app.message_versions v ON v.workspace_id=m.workspace_id AND v.id=m.current_version_id
 JOIN app.contacts c ON c.workspace_id=m.workspace_id AND c.id=m.contact_id LEFT JOIN app.message_deliveries d ON d.workspace_id=m.workspace_id AND d.message_id=m.id LEFT JOIN app.provider_operations op ON op.workspace_id=d.workspace_id AND op.id=d.provider_operation_id WHERE x.workspace_id=ws ORDER BY m.occurred_at DESC,m.id DESC LIMIT 50) recent),'[]'::jsonb));
END $f$;

REVOKE ALL ON FUNCTION app_private.investor_email_snapshot(bytea,uuid),app_private.investor_email_permission(uuid,uuid),app_private.record_investor_email_permission(bytea,uuid,uuid,boolean,text),app_private.draft_investor_email(bytea,uuid,uuid,text,text,text),app_private.approve_investor_email(bytea,uuid,bigint,bytea,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.investor_email_snapshot(bytea,uuid) TO r72_web;
GRANT EXECUTE ON FUNCTION app_private.record_investor_email_permission(bytea,uuid,uuid,boolean,text),app_private.draft_investor_email(bytea,uuid,uuid,text,text,text),app_private.approve_investor_email(bytea,uuid,bigint,bytea,text) TO r72_identity_command;
RESET ROLE;
SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private FROM r72_investor_email_definer;
RESET ROLE;
