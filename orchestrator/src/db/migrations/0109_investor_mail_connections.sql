-- INV-CRM-001: encrypted, workspace-bound mailbox connections. No send capability.
SET LOCAL ROLE r72_owner;
GRANT CREATE ON SCHEMA app_private TO r72_investor_programme_definer;
CREATE TABLE app_private.investor_mail_accounts (
 workspace_id uuid PRIMARY KEY REFERENCES app.investor_businesses(workspace_id),
 provider text NOT NULL CHECK(provider IN('google','microsoft','smtp')),
 address text NOT NULL CHECK(address=lower(address) AND length(address)<=254),
 settings jsonb NOT NULL CHECK(jsonb_typeof(settings)='object'),
 sealed_credentials text NOT NULL CHECK(length(sealed_credentials) BETWEEN 1 AND 32000),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN('pending','verified','paused')),
 row_version bigint NOT NULL DEFAULT 1,
 verified_at timestamptz,
 sync_cursor text,
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK((status='verified')=(verified_at IS NOT NULL))
);
CREATE UNIQUE INDEX investor_verified_mailbox_identity ON app_private.investor_mail_accounts(address) WHERE status='verified';
ALTER TABLE app_private.investor_mail_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.investor_mail_accounts FORCE ROW LEVEL SECURITY;
CREATE POLICY investor_mail_owner ON app_private.investor_mail_accounts TO r72_owner USING(true) WITH CHECK(true);
CREATE POLICY investor_mail_commands ON app_private.investor_mail_accounts TO r72_investor_programme_definer USING(true) WITH CHECK(true);
REVOKE ALL ON app_private.investor_mail_accounts FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE ON app_private.investor_mail_accounts TO r72_investor_programme_definer;

CREATE TABLE app_private.investor_oauth_attempts (
 state_hash bytea PRIMARY KEY CHECK(octet_length(state_hash)=32),
 session_hash bytea NOT NULL CHECK(octet_length(session_hash)=32),
 workspace_id uuid NOT NULL REFERENCES app.investor_businesses(workspace_id),
 provider text NOT NULL CHECK(provider IN('google','microsoft')),
 verifier_sealed text NOT NULL CHECK(length(verifier_sealed) BETWEEN 1 AND 2000),
 account_version bigint NOT NULL,
 expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '10 minutes',
 consumed_at timestamptz
);
ALTER TABLE app_private.investor_oauth_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.investor_oauth_attempts FORCE ROW LEVEL SECURITY;
CREATE POLICY investor_oauth_owner ON app_private.investor_oauth_attempts TO r72_owner USING(true) WITH CHECK(true);
CREATE POLICY investor_oauth_commands ON app_private.investor_oauth_attempts TO r72_investor_programme_definer USING(true) WITH CHECK(true);
REVOKE ALL ON app_private.investor_oauth_attempts FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE ON app_private.investor_oauth_attempts TO r72_investor_programme_definer;
SET LOCAL ROLE r72_investor_programme_definer;

CREATE FUNCTION app_private.investor_mail_workspace(p_session bytea,p_manage boolean)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE actor uuid;ws uuid;
BEGIN
 SELECT user_id,selected_workspace_id INTO actor,ws FROM app_private.resolve_session(p_session);
 IF actor IS NULL OR NOT app_private.lock_active_portal_session(p_session,actor,ws) OR (p_manage AND NOT app_private.can_manage_workspace(actor,ws))
  OR NOT EXISTS(SELECT 1 FROM app.investor_businesses WHERE workspace_id=ws AND access_state IN('test','active')) THEN RAISE EXCEPTION 'Mailbox access denied' USING ERRCODE='42501'; END IF;
 RETURN ws;
END $f$;

CREATE FUNCTION app_private.investor_mail_snapshot(p_session bytea)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE ws uuid;actor uuid;
BEGIN
 SELECT user_id,selected_workspace_id INTO actor,ws FROM app_private.resolve_session(p_session);
 IF actor IS NULL THEN RAISE EXCEPTION 'Mailbox access denied' USING ERRCODE='42501'; END IF;
 RETURN (SELECT jsonb_build_object('provider',provider,'address',address,'settings',settings,'status',status,'version',row_version,'verifiedAt',verified_at) FROM app_private.investor_mail_accounts WHERE workspace_id=ws);
END $f$;

CREATE FUNCTION app_private.save_investor_mail_connection(p_session bytea,p_version bigint,p_provider text,p_address text,p_settings jsonb,p_sealed text)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE ws uuid;previous bigint;result bigint;
BEGIN
 ws:=app_private.investor_mail_workspace(p_session,true);
 PERFORM 1 FROM app.investor_businesses WHERE workspace_id=ws FOR UPDATE;
 SELECT row_version INTO previous FROM app_private.investor_mail_accounts WHERE workspace_id=ws FOR UPDATE;
 IF COALESCE(previous,0)<>p_version THEN RAISE EXCEPTION 'Email connection changed' USING ERRCODE='40001'; END IF;
 IF p_provider IS NULL OR p_provider NOT IN('google','microsoft','smtp') OR p_address IS NULL OR p_address !~ '^[^[:space:]<>@]+@[^[:space:]<>@]+\.[^[:space:]<>@]+$'
  OR p_settings IS NULL OR jsonb_typeof(p_settings)<>'object' OR octet_length(p_settings::text)>2000 OR p_settings - ARRAY['displayName','smtpHost','smtpPort','imapHost','imapPort'] <> '{}'::jsonb THEN RAISE EXCEPTION 'Invalid email settings' USING ERRCODE='22023'; END IF;
 INSERT INTO app_private.investor_mail_accounts(workspace_id,provider,address,settings,sealed_credentials) VALUES(ws,p_provider,lower(p_address),p_settings,p_sealed)
 ON CONFLICT(workspace_id) DO UPDATE SET provider=EXCLUDED.provider,address=EXCLUDED.address,settings=EXCLUDED.settings,sealed_credentials=EXCLUDED.sealed_credentials,
 status='pending',verified_at=NULL,row_version=app_private.investor_mail_accounts.row_version+1,sync_cursor=NULL,updated_at=clock_timestamp() RETURNING row_version INTO result;
 RETURN result;
END $f$;

CREATE FUNCTION app_private.investor_mail_secret(p_session bytea)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE ws uuid;
BEGIN
 ws:=app_private.investor_mail_workspace(p_session,true);
 RETURN (SELECT jsonb_build_object('workspaceId',ws,'provider',provider,'address',address,'version',row_version,'sealed',sealed_credentials,'status',status,'cursor',sync_cursor) FROM app_private.investor_mail_accounts WHERE workspace_id=ws AND status<>'paused');
END $f$;

CREATE FUNCTION app_private.verify_investor_mail_connection(p_session bytea,p_version bigint,p_address text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE ws uuid;
BEGIN
 ws:=app_private.investor_mail_workspace(p_session,true);
 UPDATE app_private.investor_mail_accounts SET status='verified',verified_at=clock_timestamp(),updated_at=clock_timestamp() WHERE workspace_id=ws AND row_version=p_version AND address=p_address AND status<>'paused';
 IF NOT FOUND THEN RAISE EXCEPTION 'Email connection changed' USING ERRCODE='40001'; END IF;
END $f$;

CREATE FUNCTION app_private.disconnect_investor_mail(p_session bytea,p_version bigint)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE ws uuid;
BEGIN
 ws:=app_private.investor_mail_workspace(p_session,true);
 UPDATE app_private.investor_mail_accounts SET status='paused',verified_at=NULL,sealed_credentials='disconnected',row_version=row_version+1,updated_at=clock_timestamp() WHERE workspace_id=ws AND row_version=p_version;
 IF NOT FOUND THEN RAISE EXCEPTION 'Email connection changed' USING ERRCODE='40001'; END IF;
END $f$;

CREATE FUNCTION app_private.begin_investor_oauth(p_session bytea,p_state bytea,p_provider text,p_verifier text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE ws uuid;
BEGIN
 ws:=app_private.investor_mail_workspace(p_session,true);
 INSERT INTO app_private.investor_oauth_attempts(state_hash,session_hash,workspace_id,provider,verifier_sealed,account_version)
 VALUES(p_state,p_session,ws,p_provider,p_verifier,COALESCE((SELECT row_version FROM app_private.investor_mail_accounts WHERE workspace_id=ws),0));
END $f$;

CREATE FUNCTION app_private.consume_investor_oauth(p_session bytea,p_state bytea)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE ws uuid; result jsonb;
BEGIN
 ws:=app_private.investor_mail_workspace(p_session,true);
 UPDATE app_private.investor_oauth_attempts SET consumed_at=clock_timestamp() WHERE state_hash=p_state AND session_hash=p_session AND workspace_id=ws AND consumed_at IS NULL AND expires_at>clock_timestamp()
 RETURNING jsonb_build_object('provider',provider,'sealed',verifier_sealed,'version',account_version) INTO result;
 IF result IS NULL THEN RAISE EXCEPTION 'Email authorisation expired' USING ERRCODE='42501'; END IF;
 RETURN result;
END $f$;
REVOKE ALL ON FUNCTION app_private.investor_mail_workspace(bytea,boolean),app_private.investor_mail_snapshot(bytea),app_private.save_investor_mail_connection(bytea,bigint,text,text,jsonb,text),app_private.investor_mail_secret(bytea),app_private.verify_investor_mail_connection(bytea,bigint,text),app_private.disconnect_investor_mail(bytea,bigint),app_private.begin_investor_oauth(bytea,bytea,text,text),app_private.consume_investor_oauth(bytea,bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.investor_mail_snapshot(bytea) TO r72_web;
GRANT EXECUTE ON FUNCTION app_private.save_investor_mail_connection(bytea,bigint,text,text,jsonb,text),app_private.investor_mail_secret(bytea),app_private.verify_investor_mail_connection(bytea,bigint,text),app_private.disconnect_investor_mail(bytea,bigint),app_private.begin_investor_oauth(bytea,bytea,text,text),app_private.consume_investor_oauth(bytea,bytea) TO r72_identity_command;
RESET ROLE;
SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private FROM r72_investor_programme_definer;
RESET ROLE;
