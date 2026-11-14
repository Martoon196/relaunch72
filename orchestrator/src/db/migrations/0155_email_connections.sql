-- 0155: "Connect email". A business connects its own email from the portal: the portal creates the Postmark server,
-- the Broadcast stream, the bounce webhook and the sending domain with the account token, and the owner only adds two
-- DNS records. Additive only: two new private tables, a NOLOGIN r72_email_connection_definer and its definer functions,
-- and one r72_owner helper. No table is altered, no row rewritten, no trigger added.
--
-- app_private.email_connections: one row per workspace, CHECK-pinned to the Property Predator workspace for now. It
-- holds the connection's progress (status and the step last started, written BEFORE the step runs so a half-finished
-- run is adopted on Continue), the sender details, the Postmark ids, the two DNS records with their verified flags,
-- and two SEALED values (the server token and the webhook secret; AES-256-GCM in the application, the key never
-- reaches the database). mode is 'off' and nothing in this release changes it (release 2 adds test and live).
--
-- app_private.email_connection_events: append-only (who, which step, outcome code, when, and the domain). No token,
-- secret, address or provider text is ever written there.
--
-- Every entry point is SECURITY DEFINER with search_path=pg_catalog, executable by r72_identity_command only, and
-- refuses any other session user. The owner commands re-resolve the portal session in SQL (sha-256 of the session
-- token) and require an active owner of the workspace's organisation who can manage that workspace (the rule the SEO
-- blog's brand functions use), with that workspace selected. email_connection_state never returns a sealed value;
-- only email_connection_sealed (the owner's own session) and email_connection_sources (the bounce handler, which must
-- authenticate the webhook) do.
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';

DO $role$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='r72_email_connection_definer') THEN
    CREATE ROLE r72_email_connection_definer NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='r72_email_connection_definer' AND NOT rolcanlogin AND NOT rolinherit
      AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls)
    OR EXISTS(SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member WHERE r.rolname='r72_email_connection_definer') THEN
    RAISE EXCEPTION 'Unsafe email connection function-owner attributes' USING ERRCODE='42501';
  END IF;
  IF EXISTS(SELECT 1 FROM pg_auth_members m JOIN pg_roles p ON p.oid=m.roleid JOIN pg_roles c ON c.oid=m.member
    WHERE p.rolname='r72_email_connection_definer' AND c.rolname NOT IN ('r72_owner',current_user)) THEN
    RAISE EXCEPTION 'Runtime membership in email connection function owner denied' USING ERRCODE='42501';
  END IF;
  GRANT r72_email_connection_definer TO r72_owner;
END $role$;

SET LOCAL ROLE r72_owner;

CREATE TABLE app_private.email_connections(
 workspace_id uuid PRIMARY KEY CHECK(workspace_id='d975ff66-336a-46c2-b36b-d7095a11af97'),
 status text NOT NULL CHECK(status IN('not_connected','creating','dns_pending','verified','needs_attention','disconnected')),
 step text CHECK(step IS NULL OR step IN('server','stream','secret','webhook','domain')),
 domain text CHECK(domain IS NULL OR (length(domain) BETWEEN 4 AND 253 AND domain=lower(domain)
  AND domain~'^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$')),
 from_name text CHECK(from_name IS NULL OR (length(from_name) BETWEEN 1 AND 100 AND from_name=btrim(from_name) AND from_name!~'[[:cntrl:]<>"\\]')),
 from_address text CHECK(from_address IS NULL OR (length(from_address) BETWEEN 3 AND 254 AND from_address=lower(from_address)
  AND from_address~'^[^[:space:]@<>",]+@[^[:space:]@<>",]+$' AND split_part(from_address,'@',2)=domain)),
 reply_to text CHECK(reply_to IS NULL OR (length(reply_to) BETWEEN 3 AND 254 AND reply_to=lower(reply_to)
  AND reply_to~'^[^[:space:]@<>",]+@[^[:space:]@<>",]+\.[^[:space:]@<>",]+$')),
 postmark_server_id bigint CHECK(postmark_server_id IS NULL OR postmark_server_id>0),
 postmark_domain_id bigint CHECK(postmark_domain_id IS NULL OR postmark_domain_id>0),
 broadcast_stream text CHECK(broadcast_stream IS NULL OR broadcast_stream='broadcast'),
 webhook_id bigint CHECK(webhook_id IS NULL OR webhook_id>0),
 sealed_server_token text CHECK(sealed_server_token IS NULL OR (length(sealed_server_token) BETWEEN 40 AND 2700 AND sealed_server_token~'^[A-Za-z0-9+/]+={0,2}$')),
 sealed_webhook_secret text CHECK(sealed_webhook_secret IS NULL OR (length(sealed_webhook_secret) BETWEEN 40 AND 2700 AND sealed_webhook_secret~'^[A-Za-z0-9+/]+={0,2}$')),
 mode text NOT NULL DEFAULT 'off' CHECK(mode IN('off','test','live')),
 test_recipients text[] NOT NULL DEFAULT '{}' CHECK(cardinality(test_recipients)<=10),
 dns jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(dns)='object' AND octet_length(dns::text)<=8000),
 dkim_verified_at timestamptz,
 return_path_verified_at timestamptz,
 verified_at timestamptz,
 -- Groundwork for protecting the shared Postmark account (nothing in this release reads or enforces these).
 protection_state text NOT NULL DEFAULT 'ok' CHECK(protection_state IN('ok','slowed','paused','off')),
 protection_reason text CHECK(protection_reason IS NULL OR (length(protection_reason) BETWEEN 1 AND 300 AND protection_reason!~'[[:cntrl:]]')),
 protection_since timestamptz,
 daily_cap integer NOT NULL DEFAULT 50 CHECK(daily_cap>=0),
 hourly_cap integer NOT NULL DEFAULT 13 CHECK(hourly_cap>=0),
 warmup_started_at timestamptz,
 -- The email rules the owner agreed to before anything was created at Postmark.
 terms_version text CHECK(terms_version IS NULL OR terms_version~'^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
 terms_accepted_by uuid,
 terms_accepted_at timestamptz,
 go_live_approved_by uuid,
 go_live_approved_at timestamptz,
 row_version bigint NOT NULL DEFAULT 1 CHECK(row_version>0),
 created_by_user_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 -- A row exists before the details only to hold the accepted email rules.
 CHECK(status='not_connected' OR (domain IS NOT NULL AND from_name IS NOT NULL AND from_address IS NOT NULL)),
 CHECK((terms_version IS NULL)=(terms_accepted_by IS NULL) AND (terms_version IS NULL)=(terms_accepted_at IS NULL)),
 CHECK((go_live_approved_by IS NULL)=(go_live_approved_at IS NULL)),
 -- Connected means Postmark has verified both records, and the bounce webhook and the domain exist.
 CHECK(status<>'verified' OR (verified_at IS NOT NULL AND webhook_id IS NOT NULL AND postmark_domain_id IS NOT NULL)),
 CHECK(status<>'dns_pending' OR (webhook_id IS NOT NULL AND postmark_domain_id IS NOT NULL)),
 -- A disconnected row keeps the server and domain ids for re-adoption, but no secret and no webhook.
 CHECK(status<>'disconnected' OR (webhook_id IS NULL AND sealed_server_token IS NULL AND sealed_webhook_secret IS NULL))
);
-- One domain belongs to one business at a time.
CREATE UNIQUE INDEX email_connections_domain ON app_private.email_connections(domain) WHERE status<>'disconnected';
ALTER TABLE app_private.email_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.email_connections FORCE ROW LEVEL SECURITY;
REVOKE ALL ON app_private.email_connections FROM PUBLIC;
CREATE POLICY email_connections_owner ON app_private.email_connections TO r72_owner USING(true) WITH CHECK(true);
CREATE POLICY email_connections_definer ON app_private.email_connections TO r72_email_connection_definer
 USING(session_user='r72_identity_command' AND workspace_id='d975ff66-336a-46c2-b36b-d7095a11af97')
 WITH CHECK(session_user='r72_identity_command' AND workspace_id='d975ff66-336a-46c2-b36b-d7095a11af97');
INSERT INTO app_private.workspace_table_registry(schema_name,table_name,workspace_column) VALUES('app_private','email_connections','workspace_id');
GRANT SELECT,INSERT ON app_private.email_connections TO r72_email_connection_definer;
GRANT UPDATE(status,step,domain,from_name,from_address,reply_to,postmark_server_id,postmark_domain_id,broadcast_stream,webhook_id,
 sealed_server_token,sealed_webhook_secret,dns,dkim_verified_at,return_path_verified_at,verified_at,terms_version,terms_accepted_by,terms_accepted_at,
 row_version,updated_at)
 ON app_private.email_connections TO r72_email_connection_definer;

CREATE TABLE app_private.email_connection_events(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 workspace_id uuid NOT NULL CHECK(workspace_id='d975ff66-336a-46c2-b36b-d7095a11af97'),
 actor_user_id uuid NOT NULL,
 step text NOT NULL CHECK(step IN('terms','begin','server','stream','secret','webhook','domain','check','disconnect')),
 outcome text NOT NULL CHECK(outcome~'^[a-z][a-z0-9_]{0,39}$'),
 domain text CHECK(domain IS NULL OR (length(domain)<=253 AND domain~'^[a-z0-9.-]+$')),
 occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX email_connection_events_recent ON app_private.email_connection_events(workspace_id,occurred_at DESC);
ALTER TABLE app_private.email_connection_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.email_connection_events FORCE ROW LEVEL SECURITY;
REVOKE ALL ON app_private.email_connection_events FROM PUBLIC;
CREATE POLICY email_connection_events_owner ON app_private.email_connection_events TO r72_owner USING(true) WITH CHECK(true);
CREATE POLICY email_connection_events_definer ON app_private.email_connection_events TO r72_email_connection_definer
 USING(session_user='r72_identity_command' AND workspace_id='d975ff66-336a-46c2-b36b-d7095a11af97')
 WITH CHECK(session_user='r72_identity_command' AND workspace_id='d975ff66-336a-46c2-b36b-d7095a11af97');
INSERT INTO app_private.workspace_table_registry(schema_name,table_name,workspace_column) VALUES('app_private','email_connection_events','workspace_id');
-- Append-only: the definer may add and read events, never change or remove one.
GRANT SELECT,INSERT ON app_private.email_connection_events TO r72_email_connection_definer;

-- What protected the shared Postmark account, and when: append-only, the same shape as the events above. kind says
-- what happened, numbers holds the figures at that moment (caps, counts, rates; never an address), actor is a user
-- or NULL for the system.
CREATE TABLE app_private.email_protection_events(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 workspace_id uuid NOT NULL CHECK(workspace_id='d975ff66-336a-46c2-b36b-d7095a11af97'),
 kind text NOT NULL CHECK(kind~'^[a-z][a-z0-9_]{0,39}$'),
 numbers jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(numbers)='object' AND octet_length(numbers::text)<=4000 AND numbers::text!~'@'),
 actor_kind text NOT NULL CHECK(actor_kind IN('user','system')),
 actor_user_id uuid CHECK((actor_kind='user')=(actor_user_id IS NOT NULL)),
 occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX email_protection_events_recent ON app_private.email_protection_events(workspace_id,occurred_at DESC);
ALTER TABLE app_private.email_protection_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.email_protection_events FORCE ROW LEVEL SECURITY;
REVOKE ALL ON app_private.email_protection_events FROM PUBLIC;
CREATE POLICY email_protection_events_owner ON app_private.email_protection_events TO r72_owner USING(true) WITH CHECK(true);
CREATE POLICY email_protection_events_definer ON app_private.email_protection_events TO r72_email_connection_definer
 USING(session_user='r72_identity_command' AND workspace_id='d975ff66-336a-46c2-b36b-d7095a11af97')
 WITH CHECK(session_user='r72_identity_command' AND workspace_id='d975ff66-336a-46c2-b36b-d7095a11af97');
INSERT INTO app_private.workspace_table_registry(schema_name,table_name,workspace_column) VALUES('app_private','email_protection_events','workspace_id');
GRANT SELECT,INSERT ON app_private.email_protection_events TO r72_email_connection_definer;

-- Who may connect email: the signed-in portal user with this workspace selected, an active owner of the workspace's
-- organisation who can manage the workspace (the rule seo_blog_create_brand and seo_blog_list_brands use). Owned by
-- r72_owner like those functions; only the email connection definer may call it. Returns the user, or NULL.
CREATE FUNCTION app_private.email_connection_actor(p_session bytea,p_workspace uuid) RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE actor uuid; selected uuid;
BEGIN
 IF session_user<>'r72_identity_command' THEN RAISE EXCEPTION 'Email connection boundary required' USING ERRCODE='42501'; END IF;
 IF p_session IS NULL OR octet_length(p_session)<>32 OR p_workspace IS DISTINCT FROM 'd975ff66-336a-46c2-b36b-d7095a11af97'::uuid THEN RETURN NULL; END IF;
 SELECT r.user_id,r.selected_workspace_id INTO actor,selected FROM app_private.resolve_session(p_session) r;
 IF actor IS NULL OR selected IS DISTINCT FROM p_workspace THEN RETURN NULL; END IF;
 IF EXISTS(SELECT 1 FROM app.workspaces w JOIN app.organizations o ON o.id=w.organization_id
    WHERE w.id=p_workspace AND w.status='active' AND o.status='active'
     AND EXISTS(SELECT 1 FROM app.organization_memberships m WHERE m.organization_id=w.organization_id AND m.user_id=actor
      AND m.role='owner' AND m.status='active' AND m.revoked_at IS NULL))
  AND app_private.can_manage_workspace(actor,p_workspace) THEN RETURN actor; END IF;
 RETURN NULL;
END $f$;
REVOKE ALL ON FUNCTION app_private.email_connection_actor(bytea,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.email_connection_actor(bytea,uuid) TO r72_email_connection_definer;

-- The name shown under the connected card ("Agreed by <name> on <date>."): the user's display name, or NULL.
CREATE FUNCTION app_private.email_connection_person(p_user uuid) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
BEGIN
 IF session_user<>'r72_identity_command' THEN RAISE EXCEPTION 'Email connection boundary required' USING ERRCODE='42501'; END IF;
 RETURN (SELECT nullif(btrim(u.display_name),'') FROM app.users u WHERE u.id=p_user);
END $f$;
REVOKE ALL ON FUNCTION app_private.email_connection_person(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.email_connection_person(uuid) TO r72_email_connection_definer;

GRANT USAGE ON SCHEMA app_private TO r72_email_connection_definer;
GRANT CREATE ON SCHEMA app_private TO r72_email_connection_definer;
SET LOCAL ROLE r72_email_connection_definer;

-- Inner: the owner of this session, or refuse. Not granted to anyone.
CREATE FUNCTION app_private.email_connection_owner(p_session bytea,p_workspace uuid) RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE actor uuid;
BEGIN
 IF session_user<>'r72_identity_command' THEN RAISE EXCEPTION 'Email connection boundary required' USING ERRCODE='42501'; END IF;
 actor:=app_private.email_connection_actor(p_session,p_workspace);
 IF actor IS NULL THEN RAISE EXCEPTION 'Business owner required' USING ERRCODE='42501'; END IF;
 RETURN actor;
END $f$;

-- Inner: one append-only event. Not granted to anyone.
CREATE FUNCTION app_private.email_connection_event(p_workspace uuid,p_actor uuid,p_step text,p_outcome text,p_domain text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
BEGIN
 IF session_user<>'r72_identity_command' THEN RAISE EXCEPTION 'Email connection boundary required' USING ERRCODE='42501'; END IF;
 INSERT INTO app_private.email_connection_events(workspace_id,actor_user_id,step,outcome,domain) VALUES(p_workspace,p_actor,p_step,p_outcome,p_domain);
END $f$;

-- What the owner's page shows. Never a sealed value: only whether each one is saved.
CREATE FUNCTION app_private.email_connection_state(p_session bytea,p_workspace uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE c app_private.email_connections%ROWTYPE;
BEGIN
 IF session_user<>'r72_identity_command' THEN RAISE EXCEPTION 'Email connection boundary required' USING ERRCODE='42501'; END IF;
 PERFORM app_private.email_connection_owner(p_session,p_workspace);
 SELECT * INTO c FROM app_private.email_connections x WHERE x.workspace_id=p_workspace;
 IF NOT FOUND THEN RETURN jsonb_build_object('status','not_connected','rowVersion',0,'mode','off','protectionState','ok','dailyCap',50,'hourlyCap',13,
  'domainAttempted',false); END IF;
 RETURN jsonb_build_object('status',c.status,'step',c.step,'domain',c.domain,'fromName',c.from_name,'fromAddress',c.from_address,'replyTo',c.reply_to,
  'serverId',c.postmark_server_id,'domainId',c.postmark_domain_id,'stream',c.broadcast_stream,'webhookId',c.webhook_id,
  'hasServerToken',c.sealed_server_token IS NOT NULL,'hasWebhookSecret',c.sealed_webhook_secret IS NOT NULL,'mode',c.mode,'dns',c.dns,
  'dkimVerifiedAt',c.dkim_verified_at,'returnPathVerifiedAt',c.return_path_verified_at,'verifiedAt',c.verified_at,'rowVersion',c.row_version,'updatedAt',c.updated_at)
  ||jsonb_build_object('protectionState',c.protection_state,'protectionReason',c.protection_reason,'protectionSince',c.protection_since,
  'dailyCap',c.daily_cap,'hourlyCap',c.hourly_cap,'warmupStartedAt',c.warmup_started_at,
  'termsVersion',c.terms_version,'termsAcceptedAt',c.terms_accepted_at,'termsAcceptedByName',
  CASE WHEN c.terms_accepted_by IS NOT NULL THEN app_private.email_connection_person(c.terms_accepted_by) END,
  'goLiveApprovedAt',c.go_live_approved_at,
  -- Whether a run of this business started creating this domain at Postmark and was not then told it belongs to
  -- someone else (so a domain found after an interrupted run is our own to adopt, never another business's).
  'domainAttempted',c.domain IS NOT NULL AND EXISTS(SELECT 1 FROM app_private.email_connection_events e WHERE e.workspace_id=p_workspace
   AND e.step='domain' AND e.outcome='started' AND e.domain=c.domain
   AND NOT EXISTS(SELECT 1 FROM app_private.email_connection_events t WHERE t.workspace_id=p_workspace AND t.step='domain'
    AND t.outcome='domain_taken' AND t.domain=c.domain AND t.occurred_at>=e.occurred_at)));
END $f$;

-- The owner agrees to the email rules of p_version. Idempotent: the same version again changes nothing and keeps
-- the first who and when ('already'); a new version records the new agreement ('accepted'). Creates the row (with no
-- details yet, status 'not_connected') when the business has none.
CREATE FUNCTION app_private.email_connection_accept_terms(p_session bytea,p_workspace uuid,p_version text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE actor uuid; c app_private.email_connections%ROWTYPE;
BEGIN
 IF session_user<>'r72_identity_command' THEN RAISE EXCEPTION 'Email connection boundary required' USING ERRCODE='42501'; END IF;
 actor:=app_private.email_connection_owner(p_session,p_workspace);
 IF p_version IS NULL OR p_version!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN RAISE EXCEPTION 'Invalid email rules version' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('email-connection:'||p_workspace::text,155));
 SELECT * INTO c FROM app_private.email_connections x WHERE x.workspace_id=p_workspace FOR UPDATE;
 IF FOUND AND c.terms_version=p_version THEN RETURN 'already'; END IF;
 IF NOT FOUND THEN
  INSERT INTO app_private.email_connections(workspace_id,status,created_by_user_id,terms_version,terms_accepted_by,terms_accepted_at)
  VALUES(p_workspace,'not_connected',actor,p_version,actor,clock_timestamp());
 ELSE
  UPDATE app_private.email_connections SET terms_version=p_version,terms_accepted_by=actor,terms_accepted_at=clock_timestamp(),
   row_version=c.row_version+1,updated_at=clock_timestamp() WHERE workspace_id=p_workspace;
 END IF;
 PERFORM app_private.email_connection_event(p_workspace,actor,'terms','accepted',c.domain);
 INSERT INTO app_private.email_protection_events(workspace_id,kind,numbers,actor_kind,actor_user_id)
 SELECT p_workspace,'terms_accepted',jsonb_build_object('dailyCap',x.daily_cap,'hourlyCap',x.hourly_cap),'user',actor
 FROM app_private.email_connections x WHERE x.workspace_id=p_workspace;
 RETURN 'accepted';
END $f$;

-- Connect (or change the details before the domain is added). Writes the intent: status 'creating'. Answers
-- 'started', 'terms_required' (the owner has not agreed to the email rules of p_terms), 'already_connected' (records
-- are being checked or are verified: disconnect first) or 'domain_taken'.
-- A changed domain forgets the old domain id and records; the server, stream and webhook are kept (they belong to the
-- business, not the domain).
CREATE FUNCTION app_private.email_connection_begin(p_session bytea,p_workspace uuid,p_domain text,p_from_name text,p_from_address text,p_reply_to text,p_terms text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE actor uuid; c app_private.email_connections%ROWTYPE; v_domain text:=lower(btrim(p_domain)); existing boolean; violated text;
BEGIN
 IF session_user<>'r72_identity_command' THEN RAISE EXCEPTION 'Email connection boundary required' USING ERRCODE='42501'; END IF;
 actor:=app_private.email_connection_owner(p_session,p_workspace);
 IF p_from_address IS NULL OR v_domain IS NULL OR split_part(lower(btrim(p_from_address)),'@',2)<>v_domain THEN
  RAISE EXCEPTION 'Invalid email connection' USING ERRCODE='22023'; END IF;
 -- Two first presses at once: the second waits here, then finds the row the first wrote.
 PERFORM pg_advisory_xact_lock(hashtextextended('email-connection:'||p_workspace::text,155));
 SELECT * INTO c FROM app_private.email_connections x WHERE x.workspace_id=p_workspace FOR UPDATE;
 existing:=FOUND;
 -- Nothing is created at Postmark before the owner has agreed to the current email rules.
 IF NOT existing OR p_terms IS NULL OR c.terms_version IS DISTINCT FROM p_terms THEN RETURN 'terms_required'; END IF;
 IF c.status IN('dns_pending','verified') THEN
  PERFORM app_private.email_connection_event(p_workspace,actor,'begin','already_connected',c.domain);
  RETURN 'already_connected';
 END IF;
 BEGIN
  UPDATE app_private.email_connections SET status='creating',step=NULL,domain=v_domain,from_name=btrim(p_from_name),
   from_address=lower(btrim(p_from_address)),reply_to=lower(nullif(btrim(p_reply_to),'')),
   postmark_domain_id=CASE WHEN c.domain=v_domain THEN c.postmark_domain_id END,
   dns=CASE WHEN c.domain=v_domain THEN c.dns ELSE '{}'::jsonb END,
   dkim_verified_at=CASE WHEN c.domain=v_domain THEN c.dkim_verified_at END,
   return_path_verified_at=CASE WHEN c.domain=v_domain THEN c.return_path_verified_at END,
   verified_at=NULL,row_version=c.row_version+1,updated_at=clock_timestamp()
  WHERE workspace_id=p_workspace;
 EXCEPTION WHEN unique_violation THEN
  GET STACKED DIAGNOSTICS violated=CONSTRAINT_NAME;
  IF violated IS DISTINCT FROM 'email_connections_domain' THEN RAISE; END IF;
  PERFORM app_private.email_connection_event(p_workspace,actor,'begin','domain_taken',v_domain);
  RETURN 'domain_taken';
 END;
 PERFORM app_private.email_connection_event(p_workspace,actor,'begin','started',v_domain);
 RETURN 'started';
END $f$;

-- Intent first: the step about to run is written (and logged) before Postmark is called.
CREATE FUNCTION app_private.email_connection_intend(p_session bytea,p_workspace uuid,p_step text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE actor uuid; c app_private.email_connections%ROWTYPE;
BEGIN
 IF session_user<>'r72_identity_command' THEN RAISE EXCEPTION 'Email connection boundary required' USING ERRCODE='42501'; END IF;
 actor:=app_private.email_connection_owner(p_session,p_workspace);
 IF p_step IS NULL OR p_step NOT IN('server','stream','secret','webhook','domain') THEN RAISE EXCEPTION 'Invalid email connection step' USING ERRCODE='22023'; END IF;
 SELECT * INTO c FROM app_private.email_connections x WHERE x.workspace_id=p_workspace FOR UPDATE;
 IF NOT FOUND OR c.status NOT IN('creating','needs_attention') THEN RAISE EXCEPTION 'Email connection is not being set up' USING ERRCODE='55000'; END IF;
 UPDATE app_private.email_connections SET status='creating',step=p_step,row_version=c.row_version+1,updated_at=clock_timestamp() WHERE workspace_id=p_workspace;
 PERFORM app_private.email_connection_event(p_workspace,actor,p_step,'started',c.domain);
END $f$;

-- The result of one step. 'created' or 'adopted' saves what the step made (p_values: serverId, stream, webhookId,
-- or domainId and dns); the domain step moves the connection to 'dns_pending'. Any other outcome is a failure code
-- and leaves it 'needs_attention' until Continue is pressed.
CREATE FUNCTION app_private.email_connection_record(p_session bytea,p_workspace uuid,p_step text,p_outcome text,p_values jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE actor uuid; c app_private.email_connections%ROWTYPE; ok boolean:=p_outcome IN('created','adopted');
BEGIN
 IF session_user<>'r72_identity_command' THEN RAISE EXCEPTION 'Email connection boundary required' USING ERRCODE='42501'; END IF;
 actor:=app_private.email_connection_owner(p_session,p_workspace);
 IF p_step IS NULL OR p_step NOT IN('server','stream','secret','webhook','domain') OR p_outcome IS NULL OR p_outcome!~'^[a-z][a-z0-9_]{0,39}$'
  OR p_values IS NULL OR jsonb_typeof(p_values)<>'object' THEN RAISE EXCEPTION 'Invalid email connection step' USING ERRCODE='22023'; END IF;
 SELECT * INTO c FROM app_private.email_connections x WHERE x.workspace_id=p_workspace FOR UPDATE;
 IF NOT FOUND OR c.status NOT IN('creating','needs_attention') THEN RAISE EXCEPTION 'Email connection is not being set up' USING ERRCODE='55000'; END IF;
 IF NOT ok THEN
  UPDATE app_private.email_connections SET status='needs_attention',row_version=c.row_version+1,updated_at=clock_timestamp() WHERE workspace_id=p_workspace;
 ELSIF p_step='server' THEN
  UPDATE app_private.email_connections SET postmark_server_id=(p_values->>'serverId')::bigint,row_version=c.row_version+1,updated_at=clock_timestamp() WHERE workspace_id=p_workspace;
 ELSIF p_step='stream' THEN
  UPDATE app_private.email_connections SET broadcast_stream=p_values->>'stream',row_version=c.row_version+1,updated_at=clock_timestamp() WHERE workspace_id=p_workspace;
 ELSIF p_step='webhook' THEN
  UPDATE app_private.email_connections SET webhook_id=(p_values->>'webhookId')::bigint,row_version=c.row_version+1,updated_at=clock_timestamp() WHERE workspace_id=p_workspace;
 ELSIF p_step='domain' THEN
  IF jsonb_typeof(p_values->'dns')<>'object' THEN RAISE EXCEPTION 'Invalid email connection step' USING ERRCODE='22023'; END IF;
  UPDATE app_private.email_connections SET postmark_domain_id=(p_values->>'domainId')::bigint,dns=p_values->'dns',status='dns_pending',step=NULL,
   row_version=c.row_version+1,updated_at=clock_timestamp() WHERE workspace_id=p_workspace;
 END IF;
 PERFORM app_private.email_connection_event(p_workspace,actor,p_step,p_outcome,c.domain);
END $f$;

-- Saves one sealed value (sealed in the application; the database never sees the plain value).
CREATE FUNCTION app_private.email_connection_save_sealed(p_session bytea,p_workspace uuid,p_field text,p_sealed text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE actor uuid; c app_private.email_connections%ROWTYPE;
BEGIN
 IF session_user<>'r72_identity_command' THEN RAISE EXCEPTION 'Email connection boundary required' USING ERRCODE='42501'; END IF;
 actor:=app_private.email_connection_owner(p_session,p_workspace);
 IF p_field IS NULL OR p_field NOT IN('server_token','webhook_secret') OR p_sealed IS NULL THEN RAISE EXCEPTION 'Invalid email connection secret' USING ERRCODE='22023'; END IF;
 SELECT * INTO c FROM app_private.email_connections x WHERE x.workspace_id=p_workspace FOR UPDATE;
 IF NOT FOUND OR c.status NOT IN('creating','needs_attention') THEN RAISE EXCEPTION 'Email connection is not being set up' USING ERRCODE='55000'; END IF;
 IF p_field='server_token' THEN
  UPDATE app_private.email_connections SET sealed_server_token=p_sealed,row_version=c.row_version+1,updated_at=clock_timestamp() WHERE workspace_id=p_workspace;
  PERFORM app_private.email_connection_event(p_workspace,actor,'server','token_saved',c.domain);
 ELSE
  UPDATE app_private.email_connections SET sealed_webhook_secret=p_sealed,row_version=c.row_version+1,updated_at=clock_timestamp() WHERE workspace_id=p_workspace;
  PERFORM app_private.email_connection_event(p_workspace,actor,'secret','saved',c.domain);
 END IF;
END $f$;

-- The two sealed values, for the owner's own run (the server token is needed for the stream, webhook and disconnect).
CREATE FUNCTION app_private.email_connection_sealed(p_session bytea,p_workspace uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE c app_private.email_connections%ROWTYPE;
BEGIN
 IF session_user<>'r72_identity_command' THEN RAISE EXCEPTION 'Email connection boundary required' USING ERRCODE='42501'; END IF;
 PERFORM app_private.email_connection_owner(p_session,p_workspace);
 SELECT * INTO c FROM app_private.email_connections x WHERE x.workspace_id=p_workspace;
 IF NOT FOUND THEN RETURN jsonb_build_object('serverToken',NULL,'webhookSecret',NULL); END IF;
 RETURN jsonb_build_object('serverToken',c.sealed_server_token,'webhookSecret',c.sealed_webhook_secret);
END $f$;

-- The result of "Check": Postmark's own verified flags (never our DNS look-up) and the records as Postmark now gives
-- them. Both verified: 'verified'. Otherwise 'dns_pending' (also when a verified record has since gone).
CREATE FUNCTION app_private.email_connection_checked(p_session bytea,p_workspace uuid,p_dns jsonb,p_dkim boolean,p_return_path boolean) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE actor uuid; c app_private.email_connections%ROWTYPE; outcome text;
BEGIN
 IF session_user<>'r72_identity_command' THEN RAISE EXCEPTION 'Email connection boundary required' USING ERRCODE='42501'; END IF;
 actor:=app_private.email_connection_owner(p_session,p_workspace);
 IF p_dns IS NULL OR jsonb_typeof(p_dns)<>'object' OR p_dkim IS NULL OR p_return_path IS NULL THEN RAISE EXCEPTION 'Invalid email connection check' USING ERRCODE='22023'; END IF;
 SELECT * INTO c FROM app_private.email_connections x WHERE x.workspace_id=p_workspace FOR UPDATE;
 IF NOT FOUND OR c.status NOT IN('dns_pending','verified') THEN RAISE EXCEPTION 'Email connection has no records to check' USING ERRCODE='55000'; END IF;
 outcome:=CASE WHEN p_dkim AND p_return_path THEN 'verified' WHEN p_dkim OR p_return_path THEN 'partial' ELSE 'pending' END;
 UPDATE app_private.email_connections SET dns=p_dns,
  dkim_verified_at=CASE WHEN p_dkim THEN coalesce(c.dkim_verified_at,clock_timestamp()) END,
  return_path_verified_at=CASE WHEN p_return_path THEN coalesce(c.return_path_verified_at,clock_timestamp()) END,
  verified_at=CASE WHEN outcome='verified' THEN coalesce(c.verified_at,clock_timestamp()) END,
  status=CASE WHEN outcome='verified' THEN 'verified' ELSE 'dns_pending' END,
  row_version=c.row_version+1,updated_at=clock_timestamp() WHERE workspace_id=p_workspace;
 PERFORM app_private.email_connection_event(p_workspace,actor,'check',outcome,c.domain);
 RETURN outcome;
END $f$;

-- Disconnect: the webhook is gone (deleted at Postmark first), both secrets are forgotten; the server and domain ids
-- and the records are kept so a later Connect adopts the same Postmark server and domain.
CREATE FUNCTION app_private.email_connection_disconnect(p_session bytea,p_workspace uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE actor uuid; c app_private.email_connections%ROWTYPE;
BEGIN
 IF session_user<>'r72_identity_command' THEN RAISE EXCEPTION 'Email connection boundary required' USING ERRCODE='42501'; END IF;
 actor:=app_private.email_connection_owner(p_session,p_workspace);
 SELECT * INTO c FROM app_private.email_connections x WHERE x.workspace_id=p_workspace FOR UPDATE;
 IF NOT FOUND OR c.status='disconnected' THEN RETURN; END IF;
 UPDATE app_private.email_connections SET status='disconnected',step=NULL,webhook_id=NULL,sealed_server_token=NULL,sealed_webhook_secret=NULL,
  verified_at=NULL,row_version=c.row_version+1,updated_at=clock_timestamp() WHERE workspace_id=p_workspace;
 PERFORM app_private.email_connection_event(p_workspace,actor,'disconnect','done',c.domain);
END $f$;

-- The bounce handler's read (no portal session): every connection that has a server, its sealed token and its
-- sealed webhook secret and is not disconnected, so the webhook can authenticate Postmark (also while the webhook is
-- being created and Postmark checks the address) and the catch-up sweep can read the stream.
CREATE FUNCTION app_private.email_connection_sources() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
BEGIN
 IF session_user<>'r72_identity_command' THEN RAISE EXCEPTION 'Email connection boundary required' USING ERRCODE='42501'; END IF;
 RETURN coalesce((SELECT jsonb_agg(jsonb_build_object('workspaceId',c.workspace_id,'serverId',c.postmark_server_id,'stream',coalesce(c.broadcast_stream,'broadcast'),
   'sealedServerToken',c.sealed_server_token,'sealedWebhookSecret',c.sealed_webhook_secret) ORDER BY c.workspace_id)
  FROM app_private.email_connections c WHERE c.status<>'disconnected' AND c.postmark_server_id IS NOT NULL
   AND c.sealed_server_token IS NOT NULL AND c.sealed_webhook_secret IS NOT NULL),'[]'::jsonb);
END $f$;

REVOKE ALL ON FUNCTION app_private.email_connection_owner(bytea,uuid),
 app_private.email_connection_event(uuid,uuid,text,text,text),
 app_private.email_connection_state(bytea,uuid),
 app_private.email_connection_accept_terms(bytea,uuid,text),
 app_private.email_connection_begin(bytea,uuid,text,text,text,text,text),
 app_private.email_connection_intend(bytea,uuid,text),
 app_private.email_connection_record(bytea,uuid,text,text,jsonb),
 app_private.email_connection_save_sealed(bytea,uuid,text,text),
 app_private.email_connection_sealed(bytea,uuid),
 app_private.email_connection_checked(bytea,uuid,jsonb,boolean,boolean),
 app_private.email_connection_disconnect(bytea,uuid),
 app_private.email_connection_sources() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.email_connection_state(bytea,uuid),
 app_private.email_connection_accept_terms(bytea,uuid,text),
 app_private.email_connection_begin(bytea,uuid,text,text,text,text,text),
 app_private.email_connection_intend(bytea,uuid,text),
 app_private.email_connection_record(bytea,uuid,text,text,jsonb),
 app_private.email_connection_save_sealed(bytea,uuid,text,text),
 app_private.email_connection_sealed(bytea,uuid),
 app_private.email_connection_checked(bytea,uuid,jsonb,boolean,boolean),
 app_private.email_connection_disconnect(bytea,uuid),
 app_private.email_connection_sources() TO r72_identity_command;

RESET ROLE;
SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private FROM r72_email_connection_definer;
RESET ROLE;
