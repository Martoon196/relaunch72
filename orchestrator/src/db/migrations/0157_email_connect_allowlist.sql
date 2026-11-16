-- 0157: "Connect email" for more than one business, stage 2: a database allow-list the platform founder controls,
-- replacing the built-in "Property Predator only" list. Applied to a database at 0156 with Property Predator's live
-- rows, nothing Property Predator does changes: it is seeded on the list under exactly the name the code uses today
-- ("Property Predator"), so its Postmark server name, bounce source key and webhook address stay byte-identical.
--
-- New, both forced RLS, written only through definer functions (search_path=pg_catalog, session user
-- r72_identity_command only):
--   app_private.email_connect_allowlist         one row per business: the name used for naming at Postmark, who allowed
--                                               it and when, who switched it off and when and why, a short note. A row
--                                               is never deleted: revoking keeps it (and allowing again records who and
--                                               when).
--   app_private.email_connect_allowlist_events  append-only: seeded, allowed, revoked, reallowed, with who and when.
--
-- Changed on 0155 and 0156 (every Property Predator pin, and nothing else):
--   * The six workspace CHECKs pinned to the Property Predator id (email_connections, email_connection_events,
--     email_protection_events, email_sending_controls, email_send_events, email_protection_alerts) are dropped and
--     replaced by one BEFORE INSERT (or UPDATE OF workspace_id) trigger per table: a new email_connections row needs a
--     business on the active allow-list at the time of the insert; a new row in the other five needs that, or the
--     business's existing connection row (so bounces, counters, protection steps and alerts of mail already sent are
--     still recorded after a revocation). Existing rows are never re-checked: a later revocation invalidates nothing.
--   * The six definer policies pinned to the Property Predator id keep only their session-user rule: every definer
--     function already reads and writes only the workspace it was asked about, and rows exist only for businesses that
--     were allowed when they were written.
--   * email_connection_actor (the owner rule) asks the active allow-list instead of comparing with the Property
--     Predator id; email_connection_owner tells a business that is not on it apart (42501, DETAIL
--     email_connect_not_allowed) from a person who is not its owner.
--   * email_send_reserve answers 'not_allowed' (before anything else, under the business's sending lock) for a business
--     with a connection row that is not on the active allow-list; the founder's 'approve' answers 'not_allowed' too.
--     Go-live requests and every other owner command are refused by the owner rule. Nothing is deleted on revocation.
-- New reads: the active allow-list for the application (ids and names), the founder's list with their own businesses
-- that are not allowed yet, the founder's allow / revoke / allow again, and whether ANOTHER business's connection row
-- holds a domain (yes or no only).
--
-- Not touched: 0152 (the PP follow-up engine) and 0153 (the durable email block ledger): later stages.
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';

-- The allow-list's own NOLOGIN function owner (the shape of 0155's r72_email_connection_definer). It holds the grants on
-- the two new tables only; r72_email_connection_definer gains no table grant.
DO $role$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='r72_email_allowlist_definer') THEN
    CREATE ROLE r72_email_allowlist_definer NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='r72_email_allowlist_definer' AND NOT rolcanlogin AND NOT rolinherit
      AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls)
    OR EXISTS(SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member WHERE r.rolname='r72_email_allowlist_definer') THEN
    RAISE EXCEPTION 'Unsafe email allow-list function-owner attributes' USING ERRCODE='42501';
  END IF;
  IF EXISTS(SELECT 1 FROM pg_auth_members m JOIN pg_roles p ON p.oid=m.roleid JOIN pg_roles c ON c.oid=m.member
    WHERE p.rolname='r72_email_allowlist_definer' AND c.rolname NOT IN ('r72_owner',current_user)) THEN
    RAISE EXCEPTION 'Runtime membership in email allow-list function owner denied' USING ERRCODE='42501';
  END IF;
  GRANT r72_email_allowlist_definer TO r72_owner;
END $role$;

SET LOCAL ROLE r72_owner;

CREATE TABLE app_private.email_connect_allowlist(
 workspace_id uuid PRIMARY KEY,
 -- The business's name in the Postmark server name ("Relaunch72 - <name> - <workspace id>"): plain ASCII.
 display_name text NOT NULL CHECK(length(display_name) BETWEEN 2 AND 60 AND display_name=btrim(display_name)
  AND display_name~'^[A-Za-z0-9][A-Za-z0-9 &.,()''+-]*$' AND display_name!~'  '),
 allowed_by uuid,
 allowed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 revoked_by uuid,
 revoked_at timestamptz,
 revoked_reason text CHECK(revoked_reason IS NULL OR (length(revoked_reason) BETWEEN 1 AND 300 AND revoked_reason=btrim(revoked_reason) AND revoked_reason!~'[[:cntrl:]]')),
 note text CHECK(note IS NULL OR (length(note) BETWEEN 1 AND 300 AND note=btrim(note) AND note!~'[[:cntrl:]]')),
 row_version bigint NOT NULL DEFAULT 1 CHECK(row_version>0),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK((revoked_at IS NULL)=(revoked_by IS NULL)),
 CHECK((revoked_at IS NULL)=(revoked_reason IS NULL))
);
ALTER TABLE app_private.email_connect_allowlist ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.email_connect_allowlist FORCE ROW LEVEL SECURITY;
REVOKE ALL ON app_private.email_connect_allowlist FROM PUBLIC;
CREATE POLICY email_connect_allowlist_owner ON app_private.email_connect_allowlist TO r72_owner USING(true) WITH CHECK(true);
CREATE POLICY email_connect_allowlist_definer ON app_private.email_connect_allowlist TO r72_email_allowlist_definer
 USING(session_user='r72_identity_command') WITH CHECK(session_user='r72_identity_command');
INSERT INTO app_private.workspace_table_registry(schema_name,table_name,workspace_column) VALUES('app_private','email_connect_allowlist','workspace_id');
GRANT SELECT,INSERT ON app_private.email_connect_allowlist TO r72_email_allowlist_definer;
GRANT UPDATE(allowed_by,allowed_at,revoked_by,revoked_at,revoked_reason,note,row_version,updated_at) ON app_private.email_connect_allowlist TO r72_email_allowlist_definer;

CREATE TABLE app_private.email_connect_allowlist_events(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 workspace_id uuid NOT NULL,
 action text NOT NULL CHECK(action IN('seeded','allowed','revoked','reallowed')),
 actor_user_id uuid CHECK((action='seeded')=(actor_user_id IS NULL)),
 note text CHECK(note IS NULL OR (length(note) BETWEEN 1 AND 300 AND note!~'[[:cntrl:]]')),
 occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX email_connect_allowlist_events_recent ON app_private.email_connect_allowlist_events(workspace_id,occurred_at DESC);
ALTER TABLE app_private.email_connect_allowlist_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.email_connect_allowlist_events FORCE ROW LEVEL SECURITY;
REVOKE ALL ON app_private.email_connect_allowlist_events FROM PUBLIC;
CREATE POLICY email_connect_allowlist_events_owner ON app_private.email_connect_allowlist_events TO r72_owner USING(true) WITH CHECK(true);
CREATE POLICY email_connect_allowlist_events_definer ON app_private.email_connect_allowlist_events TO r72_email_allowlist_definer
 USING(session_user='r72_identity_command') WITH CHECK(session_user='r72_identity_command');
INSERT INTO app_private.workspace_table_registry(schema_name,table_name,workspace_column) VALUES('app_private','email_connect_allowlist_events','workspace_id');
-- Append-only.
GRANT SELECT,INSERT ON app_private.email_connect_allowlist_events TO r72_email_allowlist_definer;

-- Property Predator: the one business allowed before the list existed, under exactly the name the code uses today.
INSERT INTO app_private.email_connect_allowlist(workspace_id,display_name,note)
VALUES('d975ff66-336a-46c2-b36b-d7095a11af97','Property Predator','Allowed before the allow-list existed (0157).');
INSERT INTO app_private.email_connect_allowlist_events(workspace_id,action,note)
VALUES('d975ff66-336a-46c2-b36b-d7095a11af97','seeded','Allowed before the allow-list existed (0157).');

-- Whether a business may use Connect email now: on the allow-list and not switched off. For the 0155 definer only.
CREATE FUNCTION app_private.email_connect_allowed(p_workspace uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
BEGIN
 IF session_user<>'r72_identity_command' THEN RAISE EXCEPTION 'Email connection boundary required' USING ERRCODE='42501'; END IF;
 RETURN p_workspace IS NOT NULL AND EXISTS(SELECT 1 FROM app_private.email_connect_allowlist a WHERE a.workspace_id=p_workspace AND a.revoked_at IS NULL);
END $f$;
REVOKE ALL ON FUNCTION app_private.email_connect_allowed(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.email_connect_allowed(uuid) TO r72_email_connection_definer;

-- A workspace's facts for the founder's allow: its name, and whether it and its organisation are active. NULL when
-- there is no such workspace. For the allow-list definer only.
CREATE FUNCTION app_private.email_connect_workspace(p_workspace uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
BEGIN
 IF session_user<>'r72_identity_command' THEN RAISE EXCEPTION 'Email connection boundary required' USING ERRCODE='42501'; END IF;
 RETURN (SELECT jsonb_build_object('name',w.name,'active',w.status='active' AND o.status='active') FROM app.workspaces w JOIN app.organizations o ON o.id=w.organization_id
  WHERE w.id=p_workspace);
END $f$;
REVOKE ALL ON FUNCTION app_private.email_connect_workspace(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.email_connect_workspace(uuid) TO r72_email_allowlist_definer;

-- The founder's own businesses, exactly as the Business picker lists them (app_private.seo_blog_list_brands): the
-- content businesses whose workspace is active and that this person can manage, by name. Never a global search.
CREATE FUNCTION app_private.email_connect_founder_businesses(p_actor uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
BEGIN
 IF session_user<>'r72_identity_command' THEN RAISE EXCEPTION 'Email connection boundary required' USING ERRCODE='42501'; END IF;
 IF p_actor IS NULL THEN RETURN '[]'::jsonb; END IF;
 RETURN coalesce((SELECT jsonb_agg(jsonb_build_object('workspaceId',b.workspace_id,'name',w.name) ORDER BY w.name,b.workspace_id)
  FROM app.seo_blog_brands b JOIN app.workspaces w ON w.id=b.workspace_id
  WHERE w.status='active' AND app_private.can_manage_workspace(p_actor,b.workspace_id)),'[]'::jsonb);
END $f$;
REVOKE ALL ON FUNCTION app_private.email_connect_founder_businesses(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.email_connect_founder_businesses(uuid) TO r72_email_allowlist_definer;

-- One business's connection, as the founder's list shows it (whether there is one, its status and sending mode), or
-- NULL. Never a sealed value. For the allow-list definer only.
CREATE FUNCTION app_private.email_connect_connection(p_workspace uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
BEGIN
 IF session_user<>'r72_identity_command' THEN RAISE EXCEPTION 'Email connection boundary required' USING ERRCODE='42501'; END IF;
 RETURN (SELECT jsonb_build_object('status',c.status,'mode',c.mode,'protectionState',c.protection_state) FROM app_private.email_connections c WHERE c.workspace_id=p_workspace);
END $f$;
REVOKE ALL ON FUNCTION app_private.email_connect_connection(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.email_connect_connection(uuid) TO r72_email_allowlist_definer;
-- The founder check (0156) and the person's name (0155), for the founder's allow-list page too.
GRANT EXECUTE ON FUNCTION app_private.email_protection_founder(bytea),app_private.email_connection_person(uuid) TO r72_email_allowlist_definer;

-- The rule that replaces the six workspace CHECKs: a new connection row needs a business on the active allow-list; a
-- new row of its own records (events, counters, controls, alerts) needs that or the business's connection row. NULL
-- (an alert for the founder about the whole account) is left to the table's own constraints. Runs for every role.
CREATE FUNCTION app_private.email_connect_insert_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
BEGIN
 IF NEW.workspace_id IS NULL THEN RETURN NEW; END IF;
 IF EXISTS(SELECT 1 FROM app_private.email_connect_allowlist a WHERE a.workspace_id=NEW.workspace_id AND a.revoked_at IS NULL) THEN RETURN NEW; END IF;
 IF TG_TABLE_NAME<>'email_connections' AND EXISTS(SELECT 1 FROM app_private.email_connections c WHERE c.workspace_id=NEW.workspace_id) THEN RETURN NEW; END IF;
 RAISE EXCEPTION 'Email is not switched on for this business' USING ERRCODE='23514', TABLE=TG_TABLE_NAME, COLUMN='workspace_id';
END $f$;
REVOKE ALL ON FUNCTION app_private.email_connect_insert_guard() FROM PUBLIC;

-- The owner rule (0155) on the allow-list: the business must be on it now, instead of being the Property Predator
-- workspace. Everything else is exactly 0155's rule.
CREATE OR REPLACE FUNCTION app_private.email_connection_actor(p_session bytea,p_workspace uuid) RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE actor uuid; selected uuid;
BEGIN
 IF session_user<>'r72_identity_command' THEN RAISE EXCEPTION 'Email connection boundary required' USING ERRCODE='42501'; END IF;
 IF p_session IS NULL OR octet_length(p_session)<>32 OR p_workspace IS NULL
  OR NOT EXISTS(SELECT 1 FROM app_private.email_connect_allowlist a WHERE a.workspace_id=p_workspace AND a.revoked_at IS NULL) THEN RETURN NULL; END IF;
 SELECT r.user_id,r.selected_workspace_id INTO actor,selected FROM app_private.resolve_session(p_session) r;
 IF actor IS NULL OR selected IS DISTINCT FROM p_workspace THEN RETURN NULL; END IF;
 IF EXISTS(SELECT 1 FROM app.workspaces w JOIN app.organizations o ON o.id=w.organization_id
    WHERE w.id=p_workspace AND w.status='active' AND o.status='active'
     AND EXISTS(SELECT 1 FROM app.organization_memberships m WHERE m.organization_id=w.organization_id AND m.user_id=actor
      AND m.role='owner' AND m.status='active' AND m.revoked_at IS NULL))
  AND app_private.can_manage_workspace(actor,p_workspace) THEN RETURN actor; END IF;
 RETURN NULL;
END $f$;

GRANT CREATE ON SCHEMA app_private TO r72_email_connection_definer;
SET LOCAL ROLE r72_email_connection_definer;

-- Inner (0155): the owner of this session, or refuse. A business that is not on the active allow-list is told apart
-- (DETAIL email_connect_not_allowed), so the page can say so plainly; anyone else is refused exactly as before.
CREATE OR REPLACE FUNCTION app_private.email_connection_owner(p_session bytea,p_workspace uuid) RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE actor uuid;
BEGIN
 IF session_user<>'r72_identity_command' THEN RAISE EXCEPTION 'Email connection boundary required' USING ERRCODE='42501'; END IF;
 actor:=app_private.email_connection_actor(p_session,p_workspace);
 IF actor IS NULL THEN
  IF NOT app_private.email_connect_allowed(p_workspace) THEN
   RAISE EXCEPTION 'Email is not switched on for this business' USING ERRCODE='42501', DETAIL='email_connect_not_allowed';
  END IF;
  RAISE EXCEPTION 'Business owner required' USING ERRCODE='42501';
 END IF;
 RETURN actor;
END $f$;

-- One send, reserved BEFORE it is handed to Postmark (0156), with one new hold first: 'not_allowed', a business with
-- a connection row that is not on the active allow-list (the founder switched its email off). Checked under the
-- business's sending lock, which the founder's revoke also takes: once a revoke is committed, no reservation after it
-- answers 'ok', a replay included. Everything else is exactly 0156's.
CREATE OR REPLACE FUNCTION app_private.email_send_reserve(p_workspace uuid,p_key text,p_purpose text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE c app_private.email_connections%ROWTYPE; s app_private.email_sending_controls%ROWTYPE; a app_private.email_account_protection%ROWTYPE;
 v_now timestamptz; day_count integer; hour_count integer; sample_count integer;
BEGIN
 IF session_user<>'r72_identity_command' THEN RAISE EXCEPTION 'Email connection boundary required' USING ERRCODE='42501'; END IF;
 IF p_key IS NULL OR p_key!~'^[!-~]{1,200}$' OR p_key~'@' OR p_purpose IS NULL OR p_purpose NOT IN('live','test') THEN RAISE EXCEPTION 'Invalid email send' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('email-sending:'||p_workspace::text,156));
 IF NOT app_private.email_connect_allowed(p_workspace) AND EXISTS(SELECT 1 FROM app_private.email_connections x WHERE x.workspace_id=p_workspace) THEN RETURN 'not_allowed'; END IF;
 v_now:=clock_timestamp();
 IF EXISTS(SELECT 1 FROM app_private.email_send_events e WHERE e.workspace_id=p_workspace AND e.event_key=p_key) THEN RETURN 'replayed'; END IF;
 SELECT * INTO c FROM app_private.email_connections x WHERE x.workspace_id=p_workspace;
 IF NOT FOUND OR c.status<>'verified' THEN RETURN 'not_connected'; END IF;
 s:=app_private.email_sending_controls_row(p_workspace);
 SELECT * INTO a FROM app_private.email_account_protection x WHERE x.id;
 IF c.protection_state='off' THEN RETURN 'off'; END IF;
 IF p_purpose='test' THEN
  SELECT count(*) INTO hour_count FROM app_private.email_send_events e WHERE e.workspace_id=p_workspace AND e.kind='send' AND e.purpose='test'
   AND e.state IN('reserved','accepted') AND e.occurred_at>v_now-interval '60 minutes';
  IF hour_count>=20 THEN RETURN 'test_limit'; END IF;
 ELSE
  IF s.owner_paused_at IS NOT NULL THEN RETURN 'owner_paused'; END IF;
  IF a.state='held' THEN RETURN 'account_held'; END IF;
  IF c.protection_state='paused' THEN RETURN 'paused'; END IF;
  IF c.mode<>'live' THEN RETURN 'not_live'; END IF;
  IF c.go_live_approved_at IS NULL OR s.approved_domain IS DISTINCT FROM c.domain THEN RETURN 'not_approved'; END IF;
  IF s.test_passed_at IS NULL OR c.verified_at IS NULL OR s.test_passed_at<c.verified_at THEN RETURN 'needs_test'; END IF;
  IF s.sample_state='held' THEN RETURN 'sample_held'; END IF;
  -- No sample yet, or verified again since a passed sample began (a reconnect): the first 50 go first again. A sample
  -- that is still sending, waiting its 2 hours or held is never restarted by a reconnect.
  IF s.sample_state IN('none','passed') AND (s.sample_started_at IS NULL OR s.sample_started_at<c.verified_at) THEN
   UPDATE app_private.email_sending_controls SET sample_state='sending',sample_started_at=v_now,sample_full_at=NULL,row_version=s.row_version+1,updated_at=v_now
   WHERE workspace_id=p_workspace RETURNING * INTO s;
  END IF;
  IF s.sample_state='waiting' THEN RETURN 'sample_wait'; END IF;
  SELECT count(*),count(*) FILTER (WHERE e.occurred_at>v_now-interval '60 minutes') INTO day_count,hour_count FROM app_private.email_send_events e
   WHERE e.workspace_id=p_workspace AND e.kind='send' AND e.purpose='live' AND e.state IN('reserved','accepted') AND e.occurred_at>v_now-interval '24 hours';
  IF day_count>=c.daily_cap THEN RETURN 'daily_cap'; END IF;
  IF hour_count>=c.hourly_cap THEN RETURN 'hourly_cap'; END IF;
 END IF;
 INSERT INTO app_private.email_send_events(workspace_id,kind,event_key,purpose,state,occurred_at) VALUES(p_workspace,'send',p_key,p_purpose,'reserved',v_now);
 -- The sample: once its 50th live email is reserved, the rest waits for the automatic verdict (two hours later).
 IF p_purpose='live' AND s.sample_state='sending' THEN
  SELECT count(*) INTO sample_count FROM app_private.email_send_events e WHERE e.workspace_id=p_workspace AND e.kind='send' AND e.purpose='live'
   AND e.state IN('reserved','accepted') AND e.occurred_at>=s.sample_started_at;
  IF sample_count>=50 THEN
   UPDATE app_private.email_sending_controls SET sample_state='waiting',sample_full_at=v_now,row_version=s.row_version+1,updated_at=v_now WHERE workspace_id=p_workspace;
  END IF;
 END IF;
 RETURN 'ok';
END $f$;

-- The founder's buttons (0156), with one new answer: 'approve' for a business that is not on the active allow-list
-- answers 'not_allowed' and changes nothing. Everything else is exactly 0156's.
CREATE OR REPLACE FUNCTION app_private.email_protection_founder_act(p_session bytea,p_workspace uuid,p_action text,p_version bigint) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE actor uuid; c app_private.email_connections%ROWTYPE; s app_private.email_sending_controls%ROWTYPE; a app_private.email_account_protection%ROWTYPE;
 counts jsonb; v_new boolean; v_now timestamptz:=clock_timestamp();
BEGIN
 IF session_user<>'r72_identity_command' THEN RAISE EXCEPTION 'Email connection boundary required' USING ERRCODE='42501'; END IF;
 actor:=app_private.email_protection_founder(p_session);
 IF actor IS NULL THEN RAISE EXCEPTION 'Founder required' USING ERRCODE='42501'; END IF;
 IF p_action IS NULL OR p_action NOT IN('approve','lift','reinstate','release_sample','lift_account') OR p_version IS NULL THEN
  RAISE EXCEPTION 'Invalid founder action' USING ERRCODE='22023'; END IF;
 IF p_action='lift_account' THEN
  SELECT * INTO a FROM app_private.email_account_protection x WHERE x.id FOR UPDATE;
  IF a.row_version<>p_version THEN RETURN 'stale'; END IF;
  IF a.state<>'held' THEN RETURN 'not_needed'; END IF;
  UPDATE app_private.email_account_protection SET state='ok',reason=NULL,since=NULL,counted_since=v_now,row_version=a.row_version+1,updated_at=v_now WHERE id;
  INSERT INTO app_private.email_account_events(kind,numbers,actor_kind,actor_user_id) VALUES('account_lifted','{}'::jsonb,'user',actor);
  RETURN 'done';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('email-sending:'||p_workspace::text,156));
 SELECT * INTO c FROM app_private.email_connections x WHERE x.workspace_id=p_workspace FOR UPDATE;
 IF NOT FOUND THEN RETURN 'not_needed'; END IF;
 IF p_action='approve' AND NOT app_private.email_connect_allowed(p_workspace) THEN RETURN 'not_allowed'; END IF;
 IF c.row_version<>p_version THEN RETURN 'stale'; END IF;
 s:=app_private.email_sending_controls_row(p_workspace);
 counts:=app_private.email_protection_counts(p_workspace);
 IF p_action='approve' THEN
  -- Only a request made for the domain in use now: one made before a change of domain can never approve the new one.
  IF s.go_live_requested_at IS NULL OR s.go_live_requested_at<=coalesce(c.go_live_approved_at,'-infinity'::timestamptz)
   OR s.go_live_requested_domain IS DISTINCT FROM c.domain THEN RETURN 'not_needed'; END IF;
  IF c.status<>'verified' OR c.protection_state IN('paused','off') OR s.business_name IS NULL OR s.postal_address IS NULL
   OR s.test_passed_at IS NULL OR c.verified_at IS NULL OR s.test_passed_at<c.verified_at THEN RETURN 'stale'; END IF;
  v_new:=s.approved_domain IS DISTINCT FROM c.domain;
  UPDATE app_private.email_connections SET go_live_approved_by=actor,go_live_approved_at=v_now,mode='live',
   warmup_started_at=CASE WHEN v_new THEN v_now ELSE coalesce(c.warmup_started_at,v_now) END,
   daily_cap=CASE WHEN v_new THEN 50 ELSE c.daily_cap END,hourly_cap=CASE WHEN v_new THEN 13 ELSE c.hourly_cap END,
   row_version=c.row_version+1,updated_at=v_now WHERE workspace_id=p_workspace;
  UPDATE app_private.email_sending_controls SET approved_domain=c.domain,warmup_step=CASE WHEN v_new THEN 0 ELSE s.warmup_step END,
   warmup_step_at=CASE WHEN v_new THEN v_now ELSE coalesce(s.warmup_step_at,v_now) END,
   sample_state=CASE WHEN s.sample_state='held' THEN 'held' ELSE 'sending' END,sample_started_at=v_now,sample_full_at=NULL,
   row_version=s.row_version+1,updated_at=v_now WHERE workspace_id=p_workspace;
  PERFORM app_private.email_protection_note(p_workspace,'go_live_approved',jsonb_build_object('newDomain',v_new,'domain',c.domain,'warmupStep',CASE WHEN v_new THEN 0 ELSE s.warmup_step END),actor,true,false);
  RETURN 'done';
 ELSIF p_action IN('lift','reinstate') THEN
  IF c.protection_state<>(CASE p_action WHEN 'lift' THEN 'paused' ELSE 'off' END) THEN RETURN 'not_needed'; END IF;
  UPDATE app_private.email_connections SET protection_state='slowed',protection_reason=CASE p_action WHEN 'lift' THEN 'Restarted after a pause.' ELSE 'Switched back on after a review.' END,
   protection_since=v_now,daily_cap=greatest(1,app_private.email_protection_ramp(s.warmup_step)/2),hourly_cap=ceil(greatest(1,app_private.email_protection_ramp(s.warmup_step)/2)/4.0),
   row_version=c.row_version+1,updated_at=v_now WHERE workspace_id=p_workspace;
  UPDATE app_private.email_sending_controls SET counted_since=v_now,warmup_step_at=v_now,sample_state='sending',sample_started_at=v_now,sample_full_at=NULL,
   row_version=s.row_version+1,updated_at=v_now WHERE workspace_id=p_workspace;
  PERFORM app_private.email_protection_note(p_workspace,CASE p_action WHEN 'lift' THEN 'lifted' ELSE 'reinstated' END,
   jsonb_build_object('previousState',c.protection_state,'sends7',counts->'sends7','hard7',counts->'hard7','soft7',counts->'soft7','complaints30',counts->'complaints30'),actor,true,false);
  RETURN 'done';
 ELSE
  IF s.sample_state<>'held' THEN RETURN 'not_needed'; END IF;
  UPDATE app_private.email_sending_controls SET sample_state='sending',sample_started_at=v_now,sample_full_at=NULL,row_version=s.row_version+1,updated_at=v_now
  WHERE workspace_id=p_workspace;
  UPDATE app_private.email_connections SET row_version=c.row_version+1,updated_at=v_now WHERE workspace_id=p_workspace;
  PERFORM app_private.email_protection_note(p_workspace,'sample_released','{}'::jsonb,actor,true,false);
  RETURN 'done';
 END IF;
END $f$;

-- "Does ANOTHER business hold this domain?" for an owner of an allowed business (the 0155 owner rule): true when a
-- connection row of any other workspace, connected or not (a disconnected row keeps its domain for re-adoption), has
-- this Postmark domain id or this domain name. Only yes or no: nothing else about the other business.
CREATE FUNCTION app_private.email_connection_domain_held(p_session bytea,p_workspace uuid,p_domain_id bigint,p_domain text) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE v_domain text:=lower(btrim(p_domain));
BEGIN
 IF session_user<>'r72_identity_command' THEN RAISE EXCEPTION 'Email connection boundary required' USING ERRCODE='42501'; END IF;
 PERFORM app_private.email_connection_owner(p_session,p_workspace);
 IF (p_domain_id IS NULL OR p_domain_id<=0) AND (v_domain IS NULL OR v_domain='') THEN RAISE EXCEPTION 'Invalid domain' USING ERRCODE='22023'; END IF;
 RETURN EXISTS(SELECT 1 FROM app_private.email_connections c WHERE c.workspace_id<>p_workspace
  AND ((p_domain_id IS NOT NULL AND c.postmark_domain_id=p_domain_id) OR (v_domain<>'' AND c.domain=v_domain)));
END $f$;

REVOKE ALL ON FUNCTION app_private.email_connection_domain_held(bytea,uuid,bigint,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.email_connection_domain_held(bytea,uuid,bigint,text) TO r72_identity_command;

RESET ROLE;
SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private FROM r72_email_connection_definer;
GRANT USAGE,CREATE ON SCHEMA app_private TO r72_email_allowlist_definer;
SET LOCAL ROLE r72_email_allowlist_definer;

-- The application's read (no session): the active allow-list, ids and names, by id. One small table, read about
-- every 60 seconds by each web process.
CREATE FUNCTION app_private.email_connect_allowlist_active() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
BEGIN
 IF session_user<>'r72_identity_command' THEN RAISE EXCEPTION 'Email connection boundary required' USING ERRCODE='42501'; END IF;
 RETURN coalesce((SELECT jsonb_agg(jsonb_build_object('workspaceId',a.workspace_id,'name',a.display_name) ORDER BY a.workspace_id)
  FROM app_private.email_connect_allowlist a WHERE a.revoked_at IS NULL),'[]'::jsonb);
END $f$;

-- The founder's page: every business on the list (active first, then switched off), each with its connection and
-- sending mode, and the founder's own businesses that are not on it yet. Refuses anyone the founder check does not
-- accept (0156's email_protection_founder).
CREATE FUNCTION app_private.email_connect_allowlist_view(p_session bytea) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE actor uuid;
BEGIN
 IF session_user<>'r72_identity_command' THEN RAISE EXCEPTION 'Email connection boundary required' USING ERRCODE='42501'; END IF;
 actor:=app_private.email_protection_founder(p_session);
 IF actor IS NULL THEN RAISE EXCEPTION 'Founder required' USING ERRCODE='42501'; END IF;
 RETURN jsonb_build_object(
  'businesses',coalesce((SELECT jsonb_agg(jsonb_build_object('workspaceId',a.workspace_id,'name',a.display_name,
    'businessName',app_private.email_connect_workspace(a.workspace_id)->>'name',
    'allowedAt',a.allowed_at,'allowedByName',CASE WHEN a.allowed_by IS NOT NULL THEN app_private.email_connection_person(a.allowed_by) END,
    'revokedAt',a.revoked_at,'revokedByName',CASE WHEN a.revoked_by IS NOT NULL THEN app_private.email_connection_person(a.revoked_by) END,
    'revokedReason',a.revoked_reason,'note',a.note,'rowVersion',a.row_version,
    'hasConnection',c.facts IS NOT NULL,'status',c.facts->>'status','mode',c.facts->>'mode','protectionState',c.facts->>'protectionState')
    ORDER BY a.revoked_at IS NOT NULL,lower(a.display_name),a.workspace_id)
   FROM app_private.email_connect_allowlist a CROSS JOIN LATERAL (SELECT app_private.email_connect_connection(a.workspace_id) AS facts) c),'[]'::jsonb),
  'candidates',coalesce((SELECT jsonb_agg(b.value ORDER BY b.ord) FROM jsonb_array_elements(app_private.email_connect_founder_businesses(actor)) WITH ORDINALITY b(value,ord)
   WHERE NOT EXISTS(SELECT 1 FROM app_private.email_connect_allowlist a WHERE a.workspace_id=(b.value->>'workspaceId')::uuid)),'[]'::jsonb));
END $f$;

-- Inner: the founder (or refuse) and a checked note. Not granted to anyone.
CREATE FUNCTION app_private.email_connect_founder_note(p_session bytea,p_note text) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE v_note text:=nullif(btrim(coalesce(p_note,'')),'');
BEGIN
 IF session_user<>'r72_identity_command' THEN RAISE EXCEPTION 'Email connection boundary required' USING ERRCODE='42501'; END IF;
 IF app_private.email_protection_founder(p_session) IS NULL THEN RAISE EXCEPTION 'Founder required' USING ERRCODE='42501'; END IF;
 IF v_note IS NOT NULL AND (length(v_note)>300 OR v_note~'[[:cntrl:]]') THEN RAISE EXCEPTION 'Invalid note' USING ERRCODE='22023'; END IF;
 RETURN v_note;
END $f$;

-- The founder allows a business. Answers 'allowed', 'already_allowed' (nothing changed), 'revoked' (it was switched
-- off: allowing it again is the separate "Allow again", email_connect_reallow) or 'no_workspace' (no such workspace,
-- or it or its organisation is not active). The name at Postmark is the workspace's name in plain ASCII.
CREATE FUNCTION app_private.email_connect_allow(p_session bytea,p_workspace uuid,p_note text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE actor uuid; v_note text; a app_private.email_connect_allowlist%ROWTYPE; w jsonb; v_name text;
BEGIN
 IF session_user<>'r72_identity_command' THEN RAISE EXCEPTION 'Email connection boundary required' USING ERRCODE='42501'; END IF;
 v_note:=app_private.email_connect_founder_note(p_session,p_note);
 actor:=app_private.email_protection_founder(p_session);
 IF p_workspace IS NULL THEN RAISE EXCEPTION 'Invalid business' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('email-connect-allowlist:'||p_workspace::text,157));
 SELECT * INTO a FROM app_private.email_connect_allowlist x WHERE x.workspace_id=p_workspace FOR UPDATE;
 IF FOUND THEN RETURN CASE WHEN a.revoked_at IS NULL THEN 'already_allowed' ELSE 'revoked' END; END IF;
 w:=app_private.email_connect_workspace(p_workspace);
 IF w IS NULL OR (w->>'active')::boolean IS NOT TRUE THEN RETURN 'no_workspace'; END IF;
 v_name:=btrim(regexp_replace(regexp_replace(coalesce(w->>'name',''),'[^A-Za-z0-9 &.,()''+-]+',' ','g'),' {2,}',' ','g'));
 v_name:=btrim(left(regexp_replace(v_name,'^[^A-Za-z0-9]+',''),60));
 IF length(v_name)<2 THEN v_name:='Business '||left(replace(p_workspace::text,'-',''),8); END IF;
 INSERT INTO app_private.email_connect_allowlist(workspace_id,display_name,allowed_by,allowed_at,note) VALUES(p_workspace,v_name,actor,clock_timestamp(),v_note);
 INSERT INTO app_private.email_connect_allowlist_events(workspace_id,action,actor_user_id,note) VALUES(p_workspace,'allowed',actor,v_note);
 RETURN 'allowed';
END $f$;

-- The founder allows a switched-off business again (a deliberate second action, recorded with who and when). Answers
-- 'reallowed', 'already_allowed', 'not_listed' (never allowed: use email_connect_allow) or 'no_workspace'. The name at
-- Postmark is kept, so the business finds its own server again.
CREATE FUNCTION app_private.email_connect_reallow(p_session bytea,p_workspace uuid,p_note text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE actor uuid; v_note text; a app_private.email_connect_allowlist%ROWTYPE; w jsonb; v_now timestamptz:=clock_timestamp();
BEGIN
 IF session_user<>'r72_identity_command' THEN RAISE EXCEPTION 'Email connection boundary required' USING ERRCODE='42501'; END IF;
 v_note:=app_private.email_connect_founder_note(p_session,p_note);
 actor:=app_private.email_protection_founder(p_session);
 IF p_workspace IS NULL THEN RAISE EXCEPTION 'Invalid business' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('email-connect-allowlist:'||p_workspace::text,157));
 SELECT * INTO a FROM app_private.email_connect_allowlist x WHERE x.workspace_id=p_workspace FOR UPDATE;
 IF NOT FOUND THEN RETURN 'not_listed'; END IF;
 IF a.revoked_at IS NULL THEN RETURN 'already_allowed'; END IF;
 w:=app_private.email_connect_workspace(p_workspace);
 IF w IS NULL OR (w->>'active')::boolean IS NOT TRUE THEN RETURN 'no_workspace'; END IF;
 UPDATE app_private.email_connect_allowlist SET allowed_by=actor,allowed_at=v_now,revoked_by=NULL,revoked_at=NULL,revoked_reason=NULL,
  note=coalesce(v_note,a.note),row_version=a.row_version+1,updated_at=v_now WHERE workspace_id=p_workspace;
 INSERT INTO app_private.email_connect_allowlist_events(workspace_id,action,actor_user_id,note) VALUES(p_workspace,'reallowed',actor,v_note);
 RETURN 'reallowed';
END $f$;

-- The founder switches a business's email off (Property Predator included: it is the founder's call). p_reason is
-- required. Answers 'revoked', 'already_revoked', 'not_listed' or 'reason_required'. Nothing is deleted: the
-- connection, its counters and its history stay, its bounces keep being recorded, and every send through it holds
-- with 'not_allowed' from the moment this commits (it takes the business's sending lock, as every reservation does).
CREATE FUNCTION app_private.email_connect_revoke(p_session bytea,p_workspace uuid,p_reason text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE actor uuid; v_reason text; a app_private.email_connect_allowlist%ROWTYPE; v_now timestamptz:=clock_timestamp();
BEGIN
 IF session_user<>'r72_identity_command' THEN RAISE EXCEPTION 'Email connection boundary required' USING ERRCODE='42501'; END IF;
 v_reason:=app_private.email_connect_founder_note(p_session,p_reason);
 actor:=app_private.email_protection_founder(p_session);
 IF p_workspace IS NULL THEN RAISE EXCEPTION 'Invalid business' USING ERRCODE='22023'; END IF;
 IF v_reason IS NULL THEN RETURN 'reason_required'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('email-connect-allowlist:'||p_workspace::text,157));
 PERFORM pg_advisory_xact_lock(hashtextextended('email-sending:'||p_workspace::text,156));
 SELECT * INTO a FROM app_private.email_connect_allowlist x WHERE x.workspace_id=p_workspace FOR UPDATE;
 IF NOT FOUND THEN RETURN 'not_listed'; END IF;
 IF a.revoked_at IS NOT NULL THEN RETURN 'already_revoked'; END IF;
 UPDATE app_private.email_connect_allowlist SET revoked_by=actor,revoked_at=v_now,revoked_reason=v_reason,row_version=a.row_version+1,updated_at=v_now
 WHERE workspace_id=p_workspace;
 INSERT INTO app_private.email_connect_allowlist_events(workspace_id,action,actor_user_id,note) VALUES(p_workspace,'revoked',actor,v_reason);
 RETURN 'revoked';
END $f$;

REVOKE ALL ON FUNCTION app_private.email_connect_allowlist_active(),
 app_private.email_connect_allowlist_view(bytea),
 app_private.email_connect_founder_note(bytea,text),
 app_private.email_connect_allow(bytea,uuid,text),
 app_private.email_connect_reallow(bytea,uuid,text),
 app_private.email_connect_revoke(bytea,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.email_connect_allowlist_active(),
 app_private.email_connect_allowlist_view(bytea),
 app_private.email_connect_allow(bytea,uuid,text),
 app_private.email_connect_reallow(bytea,uuid,text),
 app_private.email_connect_revoke(bytea,uuid,text) TO r72_identity_command;

RESET ROLE;
SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private FROM r72_email_allowlist_definer;

-- The pins. Every table lock this file takes is taken here, at once and in one order, on six small tables, and held
-- only until this transaction commits (no row is read or rewritten under it; lock_timeout bounds each wait at 5s).
LOCK TABLE app_private.email_connections,app_private.email_sending_controls,app_private.email_send_events,app_private.email_connection_events,
 app_private.email_protection_events,app_private.email_protection_alerts IN ACCESS EXCLUSIVE MODE;

ALTER TABLE app_private.email_connections DROP CONSTRAINT email_connections_workspace_id_check;
ALTER TABLE app_private.email_connection_events DROP CONSTRAINT email_connection_events_workspace_id_check;
ALTER TABLE app_private.email_protection_events DROP CONSTRAINT email_protection_events_workspace_id_check;
ALTER TABLE app_private.email_sending_controls DROP CONSTRAINT email_sending_controls_workspace_id_check;
ALTER TABLE app_private.email_send_events DROP CONSTRAINT email_send_events_workspace_id_check;
ALTER TABLE app_private.email_protection_alerts DROP CONSTRAINT email_protection_alerts_workspace_id_check;

ALTER POLICY email_connections_definer ON app_private.email_connections
 USING(session_user='r72_identity_command') WITH CHECK(session_user='r72_identity_command');
ALTER POLICY email_connection_events_definer ON app_private.email_connection_events
 USING(session_user='r72_identity_command') WITH CHECK(session_user='r72_identity_command');
ALTER POLICY email_protection_events_definer ON app_private.email_protection_events
 USING(session_user='r72_identity_command') WITH CHECK(session_user='r72_identity_command');
ALTER POLICY email_sending_controls_definer ON app_private.email_sending_controls
 USING(session_user='r72_identity_command') WITH CHECK(session_user='r72_identity_command');
ALTER POLICY email_send_events_definer ON app_private.email_send_events
 USING(session_user='r72_identity_command') WITH CHECK(session_user='r72_identity_command');
ALTER POLICY email_protection_alerts_definer ON app_private.email_protection_alerts
 USING(session_user='r72_identity_command') WITH CHECK(session_user='r72_identity_command');

CREATE TRIGGER email_connections_allowlist_guard BEFORE INSERT OR UPDATE OF workspace_id ON app_private.email_connections
 FOR EACH ROW EXECUTE FUNCTION app_private.email_connect_insert_guard();
CREATE TRIGGER email_connection_events_allowlist_guard BEFORE INSERT OR UPDATE OF workspace_id ON app_private.email_connection_events
 FOR EACH ROW EXECUTE FUNCTION app_private.email_connect_insert_guard();
CREATE TRIGGER email_protection_events_allowlist_guard BEFORE INSERT OR UPDATE OF workspace_id ON app_private.email_protection_events
 FOR EACH ROW EXECUTE FUNCTION app_private.email_connect_insert_guard();
CREATE TRIGGER email_sending_controls_allowlist_guard BEFORE INSERT OR UPDATE OF workspace_id ON app_private.email_sending_controls
 FOR EACH ROW EXECUTE FUNCTION app_private.email_connect_insert_guard();
CREATE TRIGGER email_send_events_allowlist_guard BEFORE INSERT OR UPDATE OF workspace_id ON app_private.email_send_events
 FOR EACH ROW EXECUTE FUNCTION app_private.email_connect_insert_guard();
CREATE TRIGGER email_protection_alerts_allowlist_guard BEFORE INSERT OR UPDATE OF workspace_id ON app_private.email_protection_alerts
 FOR EACH ROW EXECUTE FUNCTION app_private.email_connect_insert_guard();

-- Nothing of the Property Predator pin is left on the six tables, each has its guard, and Property Predator is allowed.
DO $audit$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_catalog.pg_constraint k WHERE k.conrelid IN('app_private.email_connections'::regclass,'app_private.email_connection_events'::regclass,
    'app_private.email_protection_events'::regclass,'app_private.email_sending_controls'::regclass,'app_private.email_send_events'::regclass,
    'app_private.email_protection_alerts'::regclass) AND pg_catalog.pg_get_constraintdef(k.oid)~'d975ff66-336a-46c2-b36b-d7095a11af97')
  OR EXISTS(SELECT 1 FROM pg_catalog.pg_policies p WHERE p.schemaname='app_private' AND p.tablename IN('email_connections','email_connection_events',
    'email_protection_events','email_sending_controls','email_send_events','email_protection_alerts')
    AND (coalesce(p.qual,'')||coalesce(p.with_check,''))~'d975ff66-336a-46c2-b36b-d7095a11af97')
  OR (SELECT count(*) FROM pg_catalog.pg_trigger t WHERE NOT t.tgisinternal AND t.tgname LIKE 'email\_%\_allowlist\_guard'
    AND t.tgfoid='app_private.email_connect_insert_guard()'::regprocedure)<>6
  OR NOT EXISTS(SELECT 1 FROM app_private.email_connect_allowlist a WHERE a.workspace_id='d975ff66-336a-46c2-b36b-d7095a11af97'
    AND a.display_name='Property Predator' AND a.revoked_at IS NULL) THEN
  RAISE EXCEPTION 'Email connect allow-list cut-over is incomplete';
 END IF;
END $audit$;
RESET ROLE;
