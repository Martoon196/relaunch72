-- 0156: "Connect email" release 2 - sending through the stored connection, and sender protection.
--
-- Additive only, on the exact 0155. Nothing older than 0155 is altered. On app_private.email_connections (0155, this
-- feature's own table) nothing is altered either: the definer is GRANTED UPDATE on the groundwork columns 0155 left
-- unwritable (mode, test_recipients, protection_state/reason/since, daily_cap, hourly_cap, warmup_started_at,
-- go_live_approved_by/at). Five new private tables, all forced RLS, pinned like 0155 (workspace tables to the Property
-- Predator workspace), written only through definer functions with search_path=pg_catalog that refuse any session user
-- but r72_identity_command:
--   email_sending_controls   one row per business: footer details (real business name and postal address), the
--                            owner's own pause, the last test accepted for sending, the go-live request, the domain the
--                            founder approved, the warm-up step, the sample and the floor below which old events no
--                            longer count after a founder lift.
--   email_send_events        the durable counters: one row per send (keyed by our own lease/test key: reserved, then
--                            accepted or released) and per hard bounce, soft bounce, spam complaint and unsubscribe
--                            (keyed by one Postmark key per event, whatever the event's kind), so replays change
--                            nothing. Never an address. Rows that can no longer change any decision are pruned.
--   email_protection_alerts  the outbox for the plain emails to the business owner and the founder (one row per audience
--                            per protection step, written in the same transaction as the step).
--   email_account_protection and email_account_events   the account-wide trip-wire (one row) and its append-only log.
-- email_protection_events (0155) receives every protection step with the numbers at that moment.
--
-- Plus one function owned by 0152's r72_pp_followup_definer: pp_followup_hold_wait, which restarts the retry window of
-- Property Predator follow-up runs that are due but held by protection or a cap, so a held person waits instead of
-- failing as delivery_expired.
--
-- Enforcement in SQL, whatever the application decides: a system step can only move a business UP the ladder
-- (ok -> slowed -> paused -> off) or recover slowed -> ok, with caps that match the ramp; a SECOND own pause (or
-- switch-off) within 90 days becomes 'off' here; a sample passes only after its wait; only a session the founder check
-- accepts can approve a go-live, lift a pause, reinstate a business that was switched off, release a held sample or
-- lift the account hold; every send is reserved here against the stored caps, the mode, the approval for the domain in
-- use, a test since the last verification, the owner's pause, the protection state, the sample and the account hold
-- before anything is handed to Postmark.
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';

SET LOCAL ROLE r72_owner;

-- The founder: the signed-in person the SEO limits page already lets in (app_private.seo_limit_operators, 0145). The
-- session is resolved again here, whatever workspace it has selected. Returns the user, or NULL.
CREATE FUNCTION app_private.email_protection_founder(p_session bytea) RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE actor uuid;
BEGIN
 IF session_user<>'r72_identity_command' THEN RAISE EXCEPTION 'Email connection boundary required' USING ERRCODE='42501'; END IF;
 IF p_session IS NULL OR octet_length(p_session)<>32 THEN RETURN NULL; END IF;
 SELECT r.user_id INTO actor FROM app_private.resolve_session(p_session) r;
 IF actor IS NOT NULL AND EXISTS(SELECT 1 FROM app_private.seo_limit_operators o WHERE o.user_id=actor) THEN RETURN actor; END IF;
 RETURN NULL;
END $f$;
REVOKE ALL ON FUNCTION app_private.email_protection_founder(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.email_protection_founder(bytea) TO r72_email_connection_definer;

-- One person's sign-in address (the default test list is the address of the owner who agreed to the email rules), or NULL.
CREATE FUNCTION app_private.email_sending_user_email(p_user uuid) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
BEGIN
 IF session_user<>'r72_identity_command' THEN RAISE EXCEPTION 'Email connection boundary required' USING ERRCODE='42501'; END IF;
 RETURN (SELECT lower(u.email::text) FROM app.users u WHERE u.id=p_user AND u.status='active');
END $f$;
REVOKE ALL ON FUNCTION app_private.email_sending_user_email(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.email_sending_user_email(uuid) TO r72_email_connection_definer;

-- Where the business owner's alert emails go: the sign-in addresses of the active owners of the workspace's
-- organisation who can manage it (at most 5).
CREATE FUNCTION app_private.email_sending_owner_emails(p_workspace uuid) RETURNS text[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
BEGIN
 IF session_user<>'r72_identity_command' THEN RAISE EXCEPTION 'Email connection boundary required' USING ERRCODE='42501'; END IF;
 RETURN coalesce((SELECT array_agg(x.email ORDER BY x.email) FROM (SELECT DISTINCT lower(u.email::text) AS email FROM app.workspaces w
   JOIN app.organization_memberships m ON m.organization_id=w.organization_id AND m.role='owner' AND m.status='active' AND m.revoked_at IS NULL
   JOIN app.users u ON u.id=m.user_id AND u.status='active'
  WHERE w.id=p_workspace AND w.status='active' AND app_private.can_manage_workspace(u.id,p_workspace) ORDER BY 1 LIMIT 5) x),'{}'::text[]);
END $f$;
REVOKE ALL ON FUNCTION app_private.email_sending_owner_emails(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.email_sending_owner_emails(uuid) TO r72_email_connection_definer;

-- Per-business sending controls (one row per connection row).
CREATE TABLE app_private.email_sending_controls(
 workspace_id uuid PRIMARY KEY CHECK(workspace_id='d975ff66-336a-46c2-b36b-d7095a11af97'),
 business_name text CHECK(business_name IS NULL OR (length(business_name) BETWEEN 2 AND 120 AND business_name=btrim(business_name) AND business_name!~'[[:cntrl:]<>"\\@]')),
 postal_address text CHECK(postal_address IS NULL OR (length(postal_address) BETWEEN 10 AND 300 AND postal_address=btrim(postal_address) AND postal_address!~'[[:cntrl:]<>"\\@]')),
 test_passed_at timestamptz,
 owner_paused_at timestamptz,
 owner_paused_by uuid,
 go_live_requested_at timestamptz,
 go_live_requested_by uuid,
 go_live_requested_domain text CHECK(go_live_requested_domain IS NULL OR (length(go_live_requested_domain) BETWEEN 4 AND 253 AND go_live_requested_domain=lower(go_live_requested_domain))),
 approved_domain text CHECK(approved_domain IS NULL OR (length(approved_domain) BETWEEN 4 AND 253 AND approved_domain=lower(approved_domain))),
 warmup_step smallint NOT NULL DEFAULT 0 CHECK(warmup_step BETWEEN 0 AND 5),
 warmup_step_at timestamptz,
 counted_since timestamptz,
 sample_state text NOT NULL DEFAULT 'none' CHECK(sample_state IN('none','sending','waiting','passed','held')),
 sample_started_at timestamptz,
 sample_full_at timestamptz,
 row_version bigint NOT NULL DEFAULT 1 CHECK(row_version>0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK((owner_paused_at IS NULL)=(owner_paused_by IS NULL)),
 CHECK((go_live_requested_at IS NULL)=(go_live_requested_by IS NULL) AND (go_live_requested_at IS NULL)=(go_live_requested_domain IS NULL)),
 CHECK(sample_state='none' OR sample_started_at IS NOT NULL),
 CHECK(sample_state NOT IN('waiting') OR sample_full_at IS NOT NULL)
);
ALTER TABLE app_private.email_sending_controls ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.email_sending_controls FORCE ROW LEVEL SECURITY;
REVOKE ALL ON app_private.email_sending_controls FROM PUBLIC;
CREATE POLICY email_sending_controls_owner ON app_private.email_sending_controls TO r72_owner USING(true) WITH CHECK(true);
CREATE POLICY email_sending_controls_definer ON app_private.email_sending_controls TO r72_email_connection_definer
 USING(session_user='r72_identity_command' AND workspace_id='d975ff66-336a-46c2-b36b-d7095a11af97')
 WITH CHECK(session_user='r72_identity_command' AND workspace_id='d975ff66-336a-46c2-b36b-d7095a11af97');
INSERT INTO app_private.workspace_table_registry(schema_name,table_name,workspace_column) VALUES('app_private','email_sending_controls','workspace_id');
GRANT SELECT,INSERT ON app_private.email_sending_controls TO r72_email_connection_definer;
GRANT UPDATE(business_name,postal_address,test_passed_at,owner_paused_at,owner_paused_by,go_live_requested_at,go_live_requested_by,go_live_requested_domain,approved_domain,warmup_step,warmup_step_at,
 counted_since,sample_state,sample_started_at,sample_full_at,row_version,updated_at) ON app_private.email_sending_controls TO r72_email_connection_definer;

-- The durable counters. A send is reserved under our own key BEFORE it is handed to Postmark (so caps hold across
-- every instance), then accepted (Postmark took it) or released (it certainly did not go). An unknown outcome stays
-- reserved and counts. Bounces, complaints and unsubscribes carry one key per Postmark event (whatever kind it is read
-- as): a replayed webhook or the hourly read of the same bounce changes nothing.
CREATE TABLE app_private.email_send_events(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 workspace_id uuid NOT NULL CHECK(workspace_id='d975ff66-336a-46c2-b36b-d7095a11af97'),
 kind text NOT NULL CHECK(kind IN('send','hard_bounce','soft_bounce','blocked','complaint','unsubscribe')),
 event_key text NOT NULL CHECK(event_key~'^[!-~]{1,200}$' AND event_key!~'@'),
 purpose text CHECK(purpose IS NULL OR purpose IN('test','live')),
 state text NOT NULL CHECK(state IN('reserved','accepted','released','fact')),
 occurred_at timestamptz NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 settled_at timestamptz,
 UNIQUE(workspace_id,event_key),
 CHECK((kind='send')=(state<>'fact')),
 CHECK((kind='send')=(purpose IS NOT NULL)),
 CHECK((state IN('accepted','released'))=(settled_at IS NOT NULL))
);
-- The send path reads live sends in a time window, and bounces of a kind in a time window: both by index.
CREATE INDEX email_send_events_live ON app_private.email_send_events(workspace_id,occurred_at DESC) WHERE kind='send' AND purpose='live' AND state IN('reserved','accepted');
CREATE INDEX email_send_events_recent ON app_private.email_send_events(workspace_id,kind,occurred_at DESC);
CREATE INDEX email_send_events_time ON app_private.email_send_events(workspace_id,occurred_at);
ALTER TABLE app_private.email_send_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.email_send_events FORCE ROW LEVEL SECURITY;
REVOKE ALL ON app_private.email_send_events FROM PUBLIC;
CREATE POLICY email_send_events_owner ON app_private.email_send_events TO r72_owner USING(true) WITH CHECK(true);
CREATE POLICY email_send_events_definer ON app_private.email_send_events TO r72_email_connection_definer
 USING(session_user='r72_identity_command' AND workspace_id='d975ff66-336a-46c2-b36b-d7095a11af97')
 WITH CHECK(session_user='r72_identity_command' AND workspace_id='d975ff66-336a-46c2-b36b-d7095a11af97');
INSERT INTO app_private.workspace_table_registry(schema_name,table_name,workspace_column) VALUES('app_private','email_send_events','workspace_id');
-- A reserved send may be settled; nothing else in a counter row can change. Rows are removed only by
-- email_send_events_prune, and only once they can no longer change any decision.
GRANT SELECT,INSERT,DELETE ON app_private.email_send_events TO r72_email_connection_definer;
GRANT UPDATE(state,settled_at) ON app_private.email_send_events TO r72_email_connection_definer;

-- The alert outbox: what the business owner and the founder are emailed. kind and numbers only, never an address
-- (recipients are looked up when the email is sent). Claimed with a lease so several instances send each once.
CREATE TABLE app_private.email_protection_alerts(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 workspace_id uuid CHECK(workspace_id IS NULL OR workspace_id='d975ff66-336a-46c2-b36b-d7095a11af97'),
 audience text NOT NULL CHECK(audience IN('owner','founder')),
 kind text NOT NULL CHECK(kind~'^[a-z][a-z0-9_]{0,39}$'),
 numbers jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(numbers)='object' AND octet_length(numbers::text)<=4000 AND numbers::text!~'@'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 10),
 claimed_until timestamptz,
 sent_at timestamptz,
 given_up_at timestamptz,
 CHECK(audience='founder' OR workspace_id IS NOT NULL)
);
CREATE INDEX email_protection_alerts_pending ON app_private.email_protection_alerts(created_at) WHERE sent_at IS NULL AND given_up_at IS NULL;
ALTER TABLE app_private.email_protection_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.email_protection_alerts FORCE ROW LEVEL SECURITY;
REVOKE ALL ON app_private.email_protection_alerts FROM PUBLIC;
CREATE POLICY email_protection_alerts_owner ON app_private.email_protection_alerts TO r72_owner USING(true) WITH CHECK(true);
CREATE POLICY email_protection_alerts_definer ON app_private.email_protection_alerts TO r72_email_connection_definer
 USING(session_user='r72_identity_command' AND (workspace_id IS NULL OR workspace_id='d975ff66-336a-46c2-b36b-d7095a11af97'))
 WITH CHECK(session_user='r72_identity_command' AND (workspace_id IS NULL OR workspace_id='d975ff66-336a-46c2-b36b-d7095a11af97'));
GRANT SELECT,INSERT ON app_private.email_protection_alerts TO r72_email_connection_definer;
GRANT UPDATE(attempts,claimed_until,sent_at,given_up_at) ON app_private.email_protection_alerts TO r72_email_connection_definer;

-- The account-wide trip-wire: one row. 'held' stops every business's marketing until the founder lifts it.
CREATE TABLE app_private.email_account_protection(
 id boolean PRIMARY KEY DEFAULT true CHECK(id),
 state text NOT NULL DEFAULT 'ok' CHECK(state IN('ok','held')),
 reason text CHECK(reason IS NULL OR (length(reason) BETWEEN 1 AND 300 AND reason!~'[[:cntrl:]@]')),
 since timestamptz,
 counted_since timestamptz,
 row_version bigint NOT NULL DEFAULT 1 CHECK(row_version>0),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO app_private.email_account_protection(id) VALUES(true);
ALTER TABLE app_private.email_account_protection ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.email_account_protection FORCE ROW LEVEL SECURITY;
REVOKE ALL ON app_private.email_account_protection FROM PUBLIC;
CREATE POLICY email_account_protection_owner ON app_private.email_account_protection TO r72_owner USING(true) WITH CHECK(true);
CREATE POLICY email_account_protection_definer ON app_private.email_account_protection TO r72_email_connection_definer
 USING(session_user='r72_identity_command') WITH CHECK(session_user='r72_identity_command');
GRANT SELECT ON app_private.email_account_protection TO r72_email_connection_definer;
GRANT UPDATE(state,reason,since,counted_since,row_version,updated_at) ON app_private.email_account_protection TO r72_email_connection_definer;

CREATE TABLE app_private.email_account_events(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 kind text NOT NULL CHECK(kind~'^[a-z][a-z0-9_]{0,39}$'),
 numbers jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(numbers)='object' AND octet_length(numbers::text)<=4000 AND numbers::text!~'@'),
 actor_kind text NOT NULL CHECK(actor_kind IN('user','system')),
 actor_user_id uuid CHECK((actor_kind='user')=(actor_user_id IS NOT NULL)),
 occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX email_account_events_recent ON app_private.email_account_events(occurred_at DESC);
ALTER TABLE app_private.email_account_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.email_account_events FORCE ROW LEVEL SECURITY;
REVOKE ALL ON app_private.email_account_events FROM PUBLIC;
CREATE POLICY email_account_events_owner ON app_private.email_account_events TO r72_owner USING(true) WITH CHECK(true);
CREATE POLICY email_account_events_definer ON app_private.email_account_events TO r72_email_connection_definer
 USING(session_user='r72_identity_command') WITH CHECK(session_user='r72_identity_command');
GRANT SELECT,INSERT ON app_private.email_account_events TO r72_email_connection_definer;

-- The groundwork columns of 0155 become writable, by the definer functions below only.
GRANT UPDATE(mode,test_recipients,protection_state,protection_reason,protection_since,daily_cap,hourly_cap,warmup_started_at,go_live_approved_by,go_live_approved_at)
 ON app_private.email_connections TO r72_email_connection_definer;

GRANT CREATE ON SCHEMA app_private TO r72_email_connection_definer,r72_pp_followup_definer;
SET LOCAL ROLE r72_email_connection_definer;

-- The warm-up ramp: the daily cap of each step, and how many days each step lasts (the last step has none). The
-- application's rules.ts holds the same table; apply refuses any cap that does not match it.
CREATE FUNCTION app_private.email_protection_ramp(p_step integer) RETURNS integer
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $f$ SELECT (ARRAY[50,100,250,500,1000,2000])[least(greatest(coalesce(p_step,0),0),5)+1] $f$;
CREATE FUNCTION app_private.email_protection_step_days(p_step integer) RETURNS integer
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $f$ SELECT (ARRAY[3,4,7,7,7])[p_step+1] $f$;

-- Inner: the business's controls row, created on first use. Not granted to anyone.
CREATE FUNCTION app_private.email_sending_controls_row(p_workspace uuid) RETURNS app_private.email_sending_controls
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE s app_private.email_sending_controls%ROWTYPE;
BEGIN
 IF session_user<>'r72_identity_command' THEN RAISE EXCEPTION 'Email connection boundary required' USING ERRCODE='42501'; END IF;
 INSERT INTO app_private.email_sending_controls(workspace_id) VALUES(p_workspace) ON CONFLICT(workspace_id) DO NOTHING;
 SELECT * INTO s FROM app_private.email_sending_controls x WHERE x.workspace_id=p_workspace FOR UPDATE;
 RETURN s;
END $f$;

-- Inner: one protection step on the append-only log, and the alerts that go with it. Not granted to anyone.
CREATE FUNCTION app_private.email_protection_note(p_workspace uuid,p_kind text,p_numbers jsonb,p_actor uuid,p_owner boolean,p_founder boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
BEGIN
 IF session_user<>'r72_identity_command' THEN RAISE EXCEPTION 'Email connection boundary required' USING ERRCODE='42501'; END IF;
 INSERT INTO app_private.email_protection_events(workspace_id,kind,numbers,actor_kind,actor_user_id)
 VALUES(p_workspace,p_kind,coalesce(p_numbers,'{}'::jsonb),CASE WHEN p_actor IS NULL THEN 'system' ELSE 'user' END,p_actor);
 IF p_owner THEN INSERT INTO app_private.email_protection_alerts(workspace_id,audience,kind,numbers) VALUES(p_workspace,'owner',p_kind,coalesce(p_numbers,'{}'::jsonb)); END IF;
 IF p_founder THEN INSERT INTO app_private.email_protection_alerts(workspace_id,audience,kind,numbers) VALUES(p_workspace,'founder',p_kind,coalesce(p_numbers,'{}'::jsonb)); END IF;
END $f$;

-- Inner: the counts the ladder, the ramp and the sample are judged on, for one business, from the durable counters.
-- Denominators are LIVE sends only (reserved or accepted: an unknown outcome counts as sent); tests never dilute a
-- rate. Bounces are hard plus soft; 'blocked' (a mailbox provider refused it, or flagged it as spam) is counted on its
-- own and only ever slows a business down. After a founder lift (counted_since) nothing counts until the first live send
-- after it, so bounces for emails sent before the lift never trip the ladder again. Every query compares with one
-- moment taken here, so each one is an index range scan.
CREATE FUNCTION app_private.email_protection_counts(p_workspace uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE c app_private.email_connections%ROWTYPE; s app_private.email_sending_controls%ROWTYPE; v_now timestamptz:=clock_timestamp();
 v_floor timestamptz:='-infinity'; w7 timestamptz; w30 timestamptz; v_start50 timestamptz; v_last50 integer; v_sample_from timestamptz; v_step_from timestamptz;
 v_half integer; v_out jsonb;
BEGIN
 IF session_user<>'r72_identity_command' THEN RAISE EXCEPTION 'Email connection boundary required' USING ERRCODE='42501'; END IF;
 SELECT * INTO c FROM app_private.email_connections x WHERE x.workspace_id=p_workspace;
 IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT * INTO s FROM app_private.email_sending_controls x WHERE x.workspace_id=p_workspace;
 IF s.counted_since IS NOT NULL THEN
  SELECT min(e.occurred_at) INTO v_floor FROM app_private.email_send_events e WHERE e.workspace_id=p_workspace AND e.kind='send' AND e.purpose='live'
   AND e.state IN('reserved','accepted') AND e.occurred_at>=s.counted_since;
  v_floor:=coalesce(v_floor,'infinity'::timestamptz);
 END IF;
 w7:=greatest(v_now-interval '7 days',v_floor); w30:=greatest(v_now-interval '30 days',v_floor);
 -- The last 50 live sends (fewer when fewer were sent), and the oldest of them.
 SELECT count(*),min(x.occurred_at) INTO v_last50,v_start50 FROM (SELECT e.occurred_at FROM app_private.email_send_events e WHERE e.workspace_id=p_workspace
  AND e.kind='send' AND e.purpose='live' AND e.state IN('reserved','accepted') AND e.occurred_at>=v_floor ORDER BY e.occurred_at DESC LIMIT 50) x;
 IF s.sample_state IN('sending','waiting') THEN
  SELECT min(e.occurred_at) INTO v_sample_from FROM app_private.email_send_events e WHERE e.workspace_id=p_workspace AND e.kind='send' AND e.purpose='live'
   AND e.state IN('reserved','accepted') AND e.occurred_at>=s.sample_started_at;
 END IF;
 IF coalesce(s.warmup_step,0)<5 AND s.warmup_step_at IS NOT NULL THEN
  v_step_from:=greatest(s.warmup_step_at,v_now-interval '30 days'); v_half:=ceil(app_private.email_protection_ramp(s.warmup_step)/2.0);
 END IF;
 v_out:=jsonb_build_object(
  'sends7',(SELECT count(*) FROM app_private.email_send_events e WHERE e.workspace_id=p_workspace AND e.kind='send' AND e.purpose='live' AND e.state IN('reserved','accepted') AND e.occurred_at>=w7),
  'sends30',(SELECT count(*) FROM app_private.email_send_events e WHERE e.workspace_id=p_workspace AND e.kind='send' AND e.purpose='live' AND e.state IN('reserved','accepted') AND e.occurred_at>=w30),
  'hard7',(SELECT count(*) FROM app_private.email_send_events e WHERE e.workspace_id=p_workspace AND e.kind='hard_bounce' AND e.occurred_at>=w7),
  'soft7',(SELECT count(*) FROM app_private.email_send_events e WHERE e.workspace_id=p_workspace AND e.kind='soft_bounce' AND e.occurred_at>=w7),
  'blocked7',(SELECT count(*) FROM app_private.email_send_events e WHERE e.workspace_id=p_workspace AND e.kind='blocked' AND e.occurred_at>=w7),
  'complaints30',(SELECT count(*) FROM app_private.email_send_events e WHERE e.workspace_id=p_workspace AND e.kind='complaint' AND e.occurred_at>=w30),
  'unsubscribes30',(SELECT count(*) FROM app_private.email_send_events e WHERE e.workspace_id=p_workspace AND e.kind='unsubscribe' AND e.occurred_at>=w30),
  'last50Sends',v_last50,
  'sendsSinceRestart',CASE WHEN s.counted_since IS NULL THEN NULL ELSE (SELECT count(*) FROM app_private.email_send_events e WHERE e.workspace_id=p_workspace AND e.kind='send'
   AND e.purpose='live' AND e.state IN('reserved','accepted') AND e.occurred_at>=s.counted_since) END,
  'hardLast50',CASE WHEN v_last50=0 THEN 0 ELSE (SELECT count(*) FROM app_private.email_send_events e WHERE e.workspace_id=p_workspace AND e.kind='hard_bounce' AND e.occurred_at>=v_start50) END,
  'liveDay',(SELECT count(*) FROM app_private.email_send_events e WHERE e.workspace_id=p_workspace AND e.kind='send' AND e.purpose='live' AND e.state IN('reserved','accepted') AND e.occurred_at>v_now-interval '24 hours'),
  'liveHour',(SELECT count(*) FROM app_private.email_send_events e WHERE e.workspace_id=p_workspace AND e.kind='send' AND e.purpose='live' AND e.state IN('reserved','accepted') AND e.occurred_at>v_now-interval '60 minutes'),
  'sampleSends',CASE WHEN s.sample_state IN('sending','waiting') THEN (SELECT count(*) FROM app_private.email_send_events e WHERE e.workspace_id=p_workspace AND e.kind='send' AND e.purpose='live'
   AND e.state IN('reserved','accepted') AND e.occurred_at>=s.sample_started_at) ELSE 0 END,
  'sampleBounces',CASE WHEN v_sample_from IS NULL THEN 0 ELSE (SELECT count(*) FROM app_private.email_send_events e WHERE e.workspace_id=p_workspace AND e.kind IN('hard_bounce','soft_bounce') AND e.occurred_at>=v_sample_from) END,
  'sampleComplaints',CASE WHEN v_sample_from IS NULL THEN 0 ELSE (SELECT count(*) FROM app_private.email_send_events e WHERE e.workspace_id=p_workspace AND e.kind='complaint' AND e.occurred_at>=v_sample_from) END,
  'stepSends',CASE WHEN v_step_from IS NULL THEN 0 ELSE (SELECT count(*) FROM app_private.email_send_events e WHERE e.workspace_id=p_workspace AND e.kind='send' AND e.purpose='live'
   AND e.state IN('reserved','accepted') AND e.occurred_at>=v_step_from) END,
  'stepBounces',CASE WHEN v_step_from IS NULL THEN 0 ELSE (SELECT count(*) FROM app_private.email_send_events e WHERE e.workspace_id=p_workspace AND e.kind IN('hard_bounce','soft_bounce') AND e.occurred_at>=v_step_from) END,
  'stepComplaints',CASE WHEN v_step_from IS NULL THEN 0 ELSE (SELECT count(*) FROM app_private.email_send_events e WHERE e.workspace_id=p_workspace AND e.kind='complaint' AND e.occurred_at>=v_step_from) END,
  'stepBusyDays',CASE WHEN v_step_from IS NULL THEN 0 ELSE (SELECT count(*) FROM (SELECT 1 FROM app_private.email_send_events e WHERE e.workspace_id=p_workspace AND e.kind='send'
   AND e.purpose='live' AND e.state IN('reserved','accepted') AND e.occurred_at>=v_step_from GROUP BY (e.occurred_at AT TIME ZONE 'Europe/London')::date HAVING count(*)>=v_half) d) END);
 RETURN v_out||jsonb_build_object('workspaceId',c.workspace_id,'status',c.status,'mode',c.mode,'domain',c.domain,'state',c.protection_state,'reason',c.protection_reason,'since',c.protection_since,
  'dailyCap',c.daily_cap,'hourlyCap',c.hourly_cap,'warmupStartedAt',c.warmup_started_at,'goLiveApprovedAt',c.go_live_approved_at,
  'warmupStep',coalesce(s.warmup_step,0),'warmupStepAt',s.warmup_step_at,'countedSince',s.counted_since,'sampleState',coalesce(s.sample_state,'none'),
  'sampleStartedAt',s.sample_started_at,'sampleFullAt',s.sample_full_at,'ownerPausedAt',s.owner_paused_at,
  'ownPauses90',(SELECT count(*) FROM app_private.email_protection_events p WHERE p.workspace_id=p_workspace AND p.kind IN('paused','switched_off')
   AND p.numbers->>'cause'='own' AND p.occurred_at>v_now-interval '90 days'),
  'now',v_now);
END $f$;

-- What the owner's page shows beyond 0155's state: footer details, test list and its default, the owner's pause, the
-- go-live request and approval (for the domain in use), the counts, the last protection step's numbers and whether
-- its alert email went, and the last 7 UK days. Never a sealed value.
CREATE FUNCTION app_private.email_sending_state(p_session bytea,p_workspace uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE actor uuid; c app_private.email_connections%ROWTYPE; s app_private.email_sending_controls%ROWTYPE; a app_private.email_account_protection%ROWTYPE; v_last jsonb;
 v_alert text; v_now timestamptz:=clock_timestamp();
BEGIN
 IF session_user<>'r72_identity_command' THEN RAISE EXCEPTION 'Email connection boundary required' USING ERRCODE='42501'; END IF;
 actor:=app_private.email_connection_owner(p_session,p_workspace);
 SELECT * INTO c FROM app_private.email_connections x WHERE x.workspace_id=p_workspace;
 SELECT * INTO s FROM app_private.email_sending_controls x WHERE x.workspace_id=p_workspace;
 SELECT * INTO a FROM app_private.email_account_protection x WHERE x.id;
 SELECT p.numbers||jsonb_build_object('kind',p.kind,'at',p.occurred_at) INTO v_last FROM app_private.email_protection_events p WHERE p.workspace_id=p_workspace
  AND p.kind IN('slowed','paused','switched_off','sample_held','recovered','lifted','reinstated','sample_released','sample_passed') ORDER BY p.occurred_at DESC,p.id DESC LIMIT 1;
 SELECT CASE WHEN x.sent_at IS NOT NULL THEN 'sent' WHEN x.given_up_at IS NOT NULL THEN 'given_up' ELSE 'pending' END INTO v_alert
  FROM app_private.email_protection_alerts x WHERE x.workspace_id=p_workspace AND x.audience='owner' ORDER BY x.created_at DESC,x.id DESC LIMIT 1;
 RETURN jsonb_build_object('defaultTestEmail',app_private.email_sending_user_email(c.terms_accepted_by),'ownerEmailCount',cardinality(app_private.email_sending_owner_emails(p_workspace)),
  'businessName',s.business_name,'postalAddress',s.postal_address,
  'testRecipients',to_jsonb(coalesce(c.test_recipients,'{}'::text[])),'testPassedAt',s.test_passed_at,
  'testCurrent',s.test_passed_at IS NOT NULL AND c.verified_at IS NOT NULL AND s.test_passed_at>=c.verified_at,'ownerPausedAt',s.owner_paused_at,
  'goLiveRequestedAt',CASE WHEN s.go_live_requested_at>coalesce(c.go_live_approved_at,'-infinity'::timestamptz) AND s.go_live_requested_domain IS NOT DISTINCT FROM c.domain THEN s.go_live_requested_at END,
  'goLiveApprovedAt',c.go_live_approved_at,'approvedCurrent',c.go_live_approved_at IS NOT NULL AND s.approved_domain IS NOT DISTINCT FROM c.domain,
  'sampleState',coalesce(s.sample_state,'none'),'sampleStartedAt',s.sample_started_at,'sampleFullAt',s.sample_full_at,'warmupStep',coalesce(s.warmup_step,0),
  'accountHeld',coalesce(a.state,'ok')='held','lastStep',v_last,'lastOwnerAlert',v_alert,
  'counts',CASE WHEN c.workspace_id IS NULL THEN NULL ELSE app_private.email_protection_counts(p_workspace) END,
  'days',coalesce((SELECT jsonb_agg(jsonb_build_object('day',d.day,'sends',d.sends,'hardBounces',d.hard,'softBounces',d.soft,'blocked',d.blocked,'complaints',d.complaints,'unsubscribes',d.unsubs) ORDER BY d.day DESC)
   FROM (SELECT (e.occurred_at AT TIME ZONE 'Europe/London')::date AS day,
     count(*) FILTER (WHERE e.kind='send' AND e.purpose='live' AND e.state IN('reserved','accepted')) AS sends,count(*) FILTER (WHERE e.kind='hard_bounce') AS hard,
     count(*) FILTER (WHERE e.kind='soft_bounce') AS soft,count(*) FILTER (WHERE e.kind='blocked') AS blocked,count(*) FILTER (WHERE e.kind='complaint') AS complaints,count(*) FILTER (WHERE e.kind='unsubscribe') AS unsubs
    FROM app_private.email_send_events e WHERE e.workspace_id=p_workspace AND e.occurred_at>v_now-interval '7 days' GROUP BY 1) d),'[]'::jsonb));
END $f$;

-- The owner saves the footer details (the business's real name and postal address, printed in every marketing email)
-- and the test list (0 to 10 addresses; empty means the sign-in address of the owner who agreed to the email rules).
CREATE FUNCTION app_private.email_sending_details(p_session bytea,p_workspace uuid,p_business_name text,p_postal_address text,p_test_recipients text[]) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE actor uuid; c app_private.email_connections%ROWTYPE; s app_private.email_sending_controls%ROWTYPE; v_list text[];
BEGIN
 IF session_user<>'r72_identity_command' THEN RAISE EXCEPTION 'Email connection boundary required' USING ERRCODE='42501'; END IF;
 actor:=app_private.email_connection_owner(p_session,p_workspace);
 SELECT array_agg(DISTINCT lower(btrim(x))) INTO v_list FROM unnest(coalesce(p_test_recipients,'{}'::text[])) x WHERE btrim(x)<>'';
 v_list:=coalesce(v_list,'{}'::text[]);
 IF cardinality(v_list)>10 OR EXISTS(SELECT 1 FROM unnest(v_list) x WHERE length(x) NOT BETWEEN 3 AND 254 OR x!~'^[^[:space:]@<>",;:()\\]+@[a-z0-9-]+(\.[a-z0-9-]+)+$') THEN
  RAISE EXCEPTION 'Invalid test list' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('email-connection:'||p_workspace::text,155));
 SELECT * INTO c FROM app_private.email_connections x WHERE x.workspace_id=p_workspace FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Email connection is not set up' USING ERRCODE='55000'; END IF;
 s:=app_private.email_sending_controls_row(p_workspace);
 UPDATE app_private.email_sending_controls SET business_name=nullif(btrim(p_business_name),''),postal_address=nullif(btrim(p_postal_address),''),
  row_version=s.row_version+1,updated_at=clock_timestamp() WHERE workspace_id=p_workspace;
 UPDATE app_private.email_connections SET test_recipients=v_list,row_version=c.row_version+1,updated_at=clock_timestamp() WHERE workspace_id=p_workspace;
 PERFORM app_private.email_protection_note(p_workspace,'details_saved',jsonb_build_object('testRecipients',cardinality(v_list)),actor,false,false);
 RETURN 'saved';
END $f$;

-- One send, reserved BEFORE it is handed to Postmark, under the business's lock, against everything that can hold it.
-- p_purpose 'live': a marketing email; 'test': an email to the business's own test list (the test-mode follow-ups and
-- "Send a test to me"; allowed while paused by the owner or by protection, never while switched off, at most 20 an
-- hour). Answers 'ok' (reserved), 'replayed' (this key was reserved before: nothing new) or why it is held:
-- 'not_connected', 'off', 'owner_paused', 'account_held', 'paused', 'not_live', 'not_approved' (no founder approval
-- for the domain in use), 'needs_test' (no test since the last verification), 'sample_held', 'sample_wait',
-- 'daily_cap', 'hourly_cap', 'test_limit'. Nothing is written for a hold. A live send after a new verification
-- restarts a passed sample first (one still sending, waiting or held carries on as it is).
CREATE FUNCTION app_private.email_send_reserve(p_workspace uuid,p_key text,p_purpose text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE c app_private.email_connections%ROWTYPE; s app_private.email_sending_controls%ROWTYPE; a app_private.email_account_protection%ROWTYPE;
 v_now timestamptz; day_count integer; hour_count integer; sample_count integer;
BEGIN
 IF session_user<>'r72_identity_command' THEN RAISE EXCEPTION 'Email connection boundary required' USING ERRCODE='42501'; END IF;
 IF p_key IS NULL OR p_key!~'^[!-~]{1,200}$' OR p_key~'@' OR p_purpose IS NULL OR p_purpose NOT IN('live','test') THEN RAISE EXCEPTION 'Invalid email send' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('email-sending:'||p_workspace::text,156));
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

-- What happened to one reserved send: accepted by Postmark, or released (it certainly did not go). Settling twice, or
-- settling a send that was never reserved, changes nothing. Answers 'accepted', 'released' or 'unchanged'.
CREATE FUNCTION app_private.email_send_settle(p_workspace uuid,p_key text,p_accepted boolean) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE n integer;
BEGIN
 IF session_user<>'r72_identity_command' THEN RAISE EXCEPTION 'Email connection boundary required' USING ERRCODE='42501'; END IF;
 IF p_key IS NULL OR p_accepted IS NULL THEN RAISE EXCEPTION 'Invalid email send' USING ERRCODE='22023'; END IF;
 UPDATE app_private.email_send_events SET state=CASE WHEN p_accepted THEN 'accepted' ELSE 'released' END,settled_at=clock_timestamp()
 WHERE workspace_id=p_workspace AND kind='send' AND event_key=p_key AND state='reserved';
 GET DIAGNOSTICS n=ROW_COUNT;
 RETURN CASE WHEN n=0 THEN 'unchanged' WHEN p_accepted THEN 'accepted' ELSE 'released' END;
END $f$;

-- One bounce, spam complaint or unsubscribe for a business's own stream, under one key per Postmark event: 'recorded'
-- the first time, 'exists' on every replay (whatever kind the replay is read as). Only a business with a connection row
-- is counted ('ignored' otherwise).
CREATE FUNCTION app_private.email_counter_record(p_workspace uuid,p_kind text,p_key text,p_at timestamptz) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
BEGIN
 IF session_user<>'r72_identity_command' THEN RAISE EXCEPTION 'Email connection boundary required' USING ERRCODE='42501'; END IF;
 IF p_kind IS NULL OR p_kind NOT IN('hard_bounce','soft_bounce','blocked','complaint','unsubscribe') OR p_key IS NULL OR p_key!~'^[!-~]{1,200}$' OR p_key~'@'
  OR p_key ~ '^(lease|test):' OR p_at IS NULL OR p_at>statement_timestamp()+interval '1 day' THEN RAISE EXCEPTION 'Invalid email counter' USING ERRCODE='22023'; END IF;
 IF NOT EXISTS(SELECT 1 FROM app_private.email_connections x WHERE x.workspace_id=p_workspace) THEN RETURN 'ignored'; END IF;
 INSERT INTO app_private.email_send_events(workspace_id,kind,event_key,state,occurred_at) VALUES(p_workspace,p_kind,p_key,'fact',least(p_at,clock_timestamp()))
 ON CONFLICT(workspace_id,event_key) DO NOTHING;
 RETURN CASE WHEN FOUND THEN 'recorded' ELSE 'exists' END;
END $f$;

-- Removes counter rows that can no longer change any decision: older than 180 days AND older than the business's 50th
-- most recent live send. The longest window any line reads is 30 days (the step and the sample are bounded to it too),
-- and the "last 50" line reads back to the 50th live send, so nothing a line reads is ever removed. At most 10,000 rows a
-- call. Answers how many were removed.
CREATE FUNCTION app_private.email_send_events_prune(p_workspace uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE v_now timestamptz:=clock_timestamp(); v_keep timestamptz; n integer;
BEGIN
 IF session_user<>'r72_identity_command' THEN RAISE EXCEPTION 'Email connection boundary required' USING ERRCODE='42501'; END IF;
 SELECT e.occurred_at INTO v_keep FROM app_private.email_send_events e WHERE e.workspace_id=p_workspace AND e.kind='send' AND e.purpose='live'
  AND e.state IN('reserved','accepted') ORDER BY e.occurred_at DESC OFFSET 49 LIMIT 1;
 IF v_keep IS NULL THEN RETURN 0; END IF;
 DELETE FROM app_private.email_send_events WHERE id IN(SELECT e.id FROM app_private.email_send_events e WHERE e.workspace_id=p_workspace
  AND e.occurred_at<least(v_now-interval '180 days',v_keep) LIMIT 10000);
 GET DIAGNOSTICS n=ROW_COUNT;
 RETURN n;
END $f$;

-- What the sender reads at the start of every sweep (no portal session): the connection, its sealed server token
-- (opened in the application), the footer, the test list (or its default), whether the founder approved the domain in
-- use and a test was accepted since the last verification, and the holds.
CREATE FUNCTION app_private.email_sending_config(p_workspace uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE c app_private.email_connections%ROWTYPE; s app_private.email_sending_controls%ROWTYPE; a app_private.email_account_protection%ROWTYPE; v_now timestamptz:=clock_timestamp();
 v_day integer; v_hour integer;
BEGIN
 IF session_user<>'r72_identity_command' THEN RAISE EXCEPTION 'Email connection boundary required' USING ERRCODE='42501'; END IF;
 SELECT * INTO c FROM app_private.email_connections x WHERE x.workspace_id=p_workspace;
 IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT * INTO s FROM app_private.email_sending_controls x WHERE x.workspace_id=p_workspace;
 SELECT * INTO a FROM app_private.email_account_protection x WHERE x.id;
 SELECT count(*),count(*) FILTER (WHERE e.occurred_at>v_now-interval '60 minutes') INTO v_day,v_hour FROM app_private.email_send_events e
  WHERE e.workspace_id=p_workspace AND e.kind='send' AND e.purpose='live' AND e.state IN('reserved','accepted') AND e.occurred_at>v_now-interval '24 hours';
 RETURN jsonb_build_object('workspaceId',c.workspace_id,'status',c.status,'mode',c.mode,'serverId',c.postmark_server_id,'stream',coalesce(c.broadcast_stream,'broadcast'),
  'sealedServerToken',c.sealed_server_token,'fromName',c.from_name,'fromAddress',c.from_address,'replyTo',c.reply_to,
  'businessName',s.business_name,'postalAddress',s.postal_address,
  'testRecipients',to_jsonb(CASE WHEN cardinality(c.test_recipients)>0 THEN c.test_recipients
   ELSE array_remove(ARRAY[app_private.email_sending_user_email(c.terms_accepted_by)],NULL) END),
  'protectionState',c.protection_state,'protectionReason',c.protection_reason,'ownerPaused',s.owner_paused_at IS NOT NULL,'sampleState',coalesce(s.sample_state,'none'),
  'dailyCap',c.daily_cap,'hourlyCap',c.hourly_cap,'accountHeld',coalesce(a.state,'ok')='held',
  'goLiveRequestedAt',CASE WHEN s.go_live_requested_at>coalesce(c.go_live_approved_at,'-infinity'::timestamptz) AND s.go_live_requested_domain IS NOT DISTINCT FROM c.domain THEN s.go_live_requested_at END,
  'goLiveApprovedAt',c.go_live_approved_at,'approvedCurrent',c.go_live_approved_at IS NOT NULL AND s.approved_domain IS NOT DISTINCT FROM c.domain,
  'testCurrent',s.test_passed_at IS NOT NULL AND c.verified_at IS NOT NULL AND s.test_passed_at>=c.verified_at,
  'lastStep',(SELECT p.numbers||jsonb_build_object('kind',p.kind,'at',p.occurred_at) FROM app_private.email_protection_events p WHERE p.workspace_id=p_workspace
   AND p.kind IN('slowed','paused','switched_off','sample_held','recovered','lifted','reinstated','sample_released','sample_passed') ORDER BY p.occurred_at DESC,p.id DESC LIMIT 1),
  'liveDay',v_day,'liveHour',v_hour);
END $f$;

-- The counts of every business, and the account row with its live totals, for the evaluator and the trip-wire.
CREATE FUNCTION app_private.email_protection_numbers() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE a app_private.email_account_protection%ROWTYPE; v_now timestamptz:=clock_timestamp(); w7 timestamptz; w30 timestamptz;
BEGIN
 IF session_user<>'r72_identity_command' THEN RAISE EXCEPTION 'Email connection boundary required' USING ERRCODE='42501'; END IF;
 SELECT * INTO a FROM app_private.email_account_protection x WHERE x.id;
 w7:=greatest(v_now-interval '7 days',coalesce(a.counted_since,'-infinity')); w30:=greatest(v_now-interval '30 days',coalesce(a.counted_since,'-infinity'));
 RETURN jsonb_build_object('account',(SELECT jsonb_build_object('state',a.state,'reason',a.reason,'since',a.since,'countedSince',a.counted_since,'rowVersion',a.row_version,
   'sends7',coalesce(sum(t.sends7),0),'bounces7',coalesce(sum(t.bounces7),0),'sends30',coalesce(sum(t.sends30),0),'complaints30',coalesce(sum(t.complaints30),0))
   FROM app_private.email_connections c CROSS JOIN LATERAL (SELECT
    (SELECT count(*) FROM app_private.email_send_events e WHERE e.workspace_id=c.workspace_id AND e.kind='send' AND e.purpose='live' AND e.state IN('reserved','accepted') AND e.occurred_at>=w7) AS sends7,
    (SELECT count(*) FROM app_private.email_send_events e WHERE e.workspace_id=c.workspace_id AND e.kind IN('hard_bounce','soft_bounce') AND e.occurred_at>=w7) AS bounces7,
    (SELECT count(*) FROM app_private.email_send_events e WHERE e.workspace_id=c.workspace_id AND e.kind='send' AND e.purpose='live' AND e.state IN('reserved','accepted') AND e.occurred_at>=w30) AS sends30,
    (SELECT count(*) FROM app_private.email_send_events e WHERE e.workspace_id=c.workspace_id AND e.kind='complaint' AND e.occurred_at>=w30) AS complaints30) t),
  'businesses',coalesce((SELECT jsonb_agg(app_private.email_protection_counts(c.workspace_id)||jsonb_build_object('businessName',s.business_name) ORDER BY c.workspace_id)
   FROM app_private.email_connections c LEFT JOIN app_private.email_sending_controls s ON s.workspace_id=c.workspace_id),'[]'::jsonb));
END $f$;

-- One automatic protection step (the evaluator, on every relevant event and on a timer). Compare-and-set on the state
-- the evaluator read (p_from): another instance that got there first makes this 'stale'. A system step may only move
-- UP the ladder or recover slowed -> ok; p_cause 'own' (the business's own numbers) or 'account' (the trip-wire). A
-- second OWN pause (or switch-off) within 90 days becomes 'off' here, but only once at least 50 live emails went out
-- since the founder's last restart: with fewer it stays 'paused' (recorded as kind 'paused' with 'previousPauseAt' and
-- 'sendsSinceRestart', so the founder sees why it was not switched off). The caps must be the ramp's for the step and the
-- state; a step may only move up one, once its days are over; a sample passes only 2 hours after its 50th email.
-- Answers the state now in force, 'unchanged', 'stale' or 'refused'.
CREATE FUNCTION app_private.email_protection_apply(p_workspace uuid,p_from text,p_to text,p_kind text,p_cause text,p_reason text,p_numbers jsonb,
 p_daily integer,p_hourly integer,p_step integer,p_step_at timestamptz,p_sample text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE c app_private.email_connections%ROWTYPE; s app_private.email_sending_controls%ROWTYPE; v_to text:=p_to; v_kind text:=p_kind; v_prior timestamptz;
 v_since integer; v_numbers jsonb:=coalesce(p_numbers,'{}'::jsonb); v_now timestamptz; v_step integer; v_due boolean; v_daily integer; v_hourly integer;
BEGIN
 IF session_user<>'r72_identity_command' THEN RAISE EXCEPTION 'Email connection boundary required' USING ERRCODE='42501'; END IF;
 IF p_from IS NULL OR p_to IS NULL OR p_from NOT IN('ok','slowed','paused','off') OR p_to NOT IN('ok','slowed','paused','off')
  OR (p_cause IS NOT NULL AND p_cause NOT IN('own','account')) OR (p_kind IS NOT NULL AND p_kind!~'^[a-z][a-z0-9_]{0,39}$')
  OR p_daily IS NULL OR p_hourly IS NULL OR (p_step IS NOT NULL AND p_step NOT BETWEEN 0 AND 5) OR (p_sample IS NOT NULL AND p_sample NOT IN('passed','held'))
  OR jsonb_typeof(v_numbers)<>'object' THEN RAISE EXCEPTION 'Invalid protection step' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('email-sending:'||p_workspace::text,156));
 v_now:=clock_timestamp();
 SELECT * INTO c FROM app_private.email_connections x WHERE x.workspace_id=p_workspace FOR UPDATE;
 IF NOT FOUND THEN RETURN 'refused'; END IF;
 IF c.protection_state<>p_from THEN RETURN 'stale'; END IF;
 -- Up the ladder, or slowed back to ok. Never down from paused or off: only the founder does that.
 IF NOT (p_from=p_to OR (p_from='ok' AND p_to IN('slowed','paused','off')) OR (p_from='slowed' AND p_to IN('ok','paused','off'))) THEN RETURN 'refused'; END IF;
 s:=app_private.email_sending_controls_row(p_workspace);
 IF p_sample='held' AND s.sample_state NOT IN('sending','waiting') THEN RETURN 'stale'; END IF;
 IF p_sample='passed' AND s.sample_state<>'waiting' THEN RETURN 'stale'; END IF;
 IF p_sample='passed' AND (s.sample_full_at IS NULL OR s.sample_full_at>v_now-interval '2 hours') THEN RETURN 'refused'; END IF;
 -- The warm-up: the same step (restarted once its days are over), or one up once its days are over.
 v_due:=s.warmup_step_at IS NULL OR (s.warmup_step<5 AND s.warmup_step_at+make_interval(days=>app_private.email_protection_step_days(s.warmup_step))<=v_now);
 IF p_step IS NOT NULL AND NOT ((p_step=s.warmup_step OR p_step=s.warmup_step+1) AND v_due) THEN RETURN 'refused'; END IF;
 v_step:=coalesce(p_step,s.warmup_step);
 v_daily:=CASE WHEN v_to='slowed' THEN greatest(1,app_private.email_protection_ramp(v_step)/2) ELSE app_private.email_protection_ramp(v_step) END;
 v_hourly:=ceil(v_daily/4.0);
 IF v_to IN('ok','slowed') AND (p_daily<>v_daily OR p_hourly<>v_hourly) THEN RETURN 'refused'; END IF;
 IF v_to='paused' AND p_from<>'paused' AND coalesce(p_cause,'own')='own' THEN
  SELECT max(p.occurred_at) INTO v_prior FROM app_private.email_protection_events p WHERE p.workspace_id=p_workspace AND p.kind IN('paused','switched_off')
   AND p.numbers->>'cause'='own' AND p.occurred_at>v_now-interval '90 days';
  IF v_prior IS NOT NULL THEN
   SELECT count(*) INTO v_since FROM app_private.email_send_events e WHERE e.workspace_id=p_workspace AND e.kind='send' AND e.purpose='live'
    AND e.state IN('reserved','accepted') AND e.occurred_at>=coalesce(s.counted_since,'-infinity'::timestamptz);
   v_numbers:=v_numbers||jsonb_build_object('previousPauseAt',v_prior,'sendsSinceRestart',v_since);
   IF v_since>=50 THEN v_to:='off'; v_kind:='switched_off'; ELSE v_to:='paused'; v_kind:='paused'; END IF;
  END IF;
 END IF;
 UPDATE app_private.email_connections SET protection_state=v_to,
  protection_reason=CASE WHEN v_to=p_from THEN c.protection_reason WHEN v_to='ok' THEN NULL ELSE left(coalesce(nullif(p_reason,''),c.protection_reason),300) END,
  protection_since=CASE WHEN v_to=p_from THEN c.protection_since WHEN v_to='ok' THEN NULL ELSE v_now END,
  daily_cap=CASE WHEN v_to IN('paused','off') THEN 0 ELSE v_daily END,hourly_cap=CASE WHEN v_to IN('paused','off') THEN 0 ELSE v_hourly END,
  row_version=c.row_version+1,updated_at=v_now WHERE workspace_id=p_workspace;
 UPDATE app_private.email_sending_controls SET warmup_step=v_step,warmup_step_at=CASE WHEN p_step IS NOT NULL THEN v_now ELSE s.warmup_step_at END,
  sample_state=coalesce(p_sample,s.sample_state),row_version=s.row_version+1,updated_at=v_now WHERE workspace_id=p_workspace;
 IF v_kind IS NOT NULL THEN
  v_numbers:=v_numbers||jsonb_build_object('cause',coalesce(p_cause,'own'),'from',p_from,'to',v_to);
  PERFORM app_private.email_protection_note(p_workspace,v_kind,v_numbers,NULL,
   v_kind IN('slowed','paused','switched_off','sample_held'),v_kind IN('paused','switched_off','sample_held'));
 END IF;
 RETURN CASE WHEN v_to=p_from AND v_kind IS NULL THEN 'unchanged' ELSE v_to END;
END $f$;

-- The account trip-wire's own step (system): 'ok' -> 'held' only. The founder lifts it.
CREATE FUNCTION app_private.email_account_apply(p_from text,p_to text,p_reason text,p_numbers jsonb) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE a app_private.email_account_protection%ROWTYPE;
BEGIN
 IF session_user<>'r72_identity_command' THEN RAISE EXCEPTION 'Email connection boundary required' USING ERRCODE='42501'; END IF;
 IF p_from IS DISTINCT FROM 'ok' OR p_to IS DISTINCT FROM 'held' OR p_numbers IS NULL OR jsonb_typeof(p_numbers)<>'object' THEN RETURN 'refused'; END IF;
 SELECT * INTO a FROM app_private.email_account_protection x WHERE x.id FOR UPDATE;
 IF a.state<>p_from THEN RETURN 'stale'; END IF;
 UPDATE app_private.email_account_protection SET state='held',reason=left(p_reason,300),since=clock_timestamp(),row_version=a.row_version+1,updated_at=clock_timestamp() WHERE id;
 INSERT INTO app_private.email_account_events(kind,numbers,actor_kind) VALUES('account_held',p_numbers,'system');
 INSERT INTO app_private.email_protection_alerts(workspace_id,audience,kind,numbers) VALUES(NULL,'founder','account_held',p_numbers);
 RETURN 'held';
END $f$;

-- The owner's own commands. p_action: 'test' (start testing, or back to testing: only the test list gets emails; the
-- stored connection is then in charge of this business's follow-up email), 'live', 'pause' or 'resume' (the owner's own
-- pause, which never lifts a protection pause). 'live' needs a founder approval for the domain in use: the first time,
-- and again after a change of domain, every condition is checked and the founder is asked for that domain
-- ('requested', or 'already_requested'). A request only ever stands for the domain it was made for. Other answers say what is missing: 'not_connected', 'switched_off', 'paused', 'needs_webhook',
-- 'needs_terms', 'needs_footer', 'needs_test'. p_webhook_ok is the application's own fresh check with Postmark that the
-- bounce webhook is there and verified.
CREATE FUNCTION app_private.email_sending_command(p_session bytea,p_workspace uuid,p_action text,p_terms text,p_webhook_ok boolean) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE actor uuid; c app_private.email_connections%ROWTYPE; s app_private.email_sending_controls%ROWTYPE; v_approved boolean;
BEGIN
 IF session_user<>'r72_identity_command' THEN RAISE EXCEPTION 'Email connection boundary required' USING ERRCODE='42501'; END IF;
 actor:=app_private.email_connection_owner(p_session,p_workspace);
 IF p_action IS NULL OR p_action NOT IN('test','live','pause','resume') THEN RAISE EXCEPTION 'Invalid email sending command' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('email-sending:'||p_workspace::text,156));
 SELECT * INTO c FROM app_private.email_connections x WHERE x.workspace_id=p_workspace FOR UPDATE;
 IF NOT FOUND OR c.status<>'verified' THEN RETURN 'not_connected'; END IF;
 s:=app_private.email_sending_controls_row(p_workspace);
 IF p_action='pause' THEN
  IF s.owner_paused_at IS NOT NULL THEN RETURN 'unchanged'; END IF;
  UPDATE app_private.email_sending_controls SET owner_paused_at=clock_timestamp(),owner_paused_by=actor,row_version=s.row_version+1,updated_at=clock_timestamp() WHERE workspace_id=p_workspace;
  PERFORM app_private.email_protection_note(p_workspace,'owner_paused','{}'::jsonb,actor,false,false);
  RETURN 'paused';
 ELSIF p_action='resume' THEN
  IF s.owner_paused_at IS NULL THEN RETURN 'unchanged'; END IF;
  UPDATE app_private.email_sending_controls SET owner_paused_at=NULL,owner_paused_by=NULL,row_version=s.row_version+1,updated_at=clock_timestamp() WHERE workspace_id=p_workspace;
  PERFORM app_private.email_protection_note(p_workspace,'owner_resumed','{}'::jsonb,actor,false,false);
  RETURN 'resumed';
 END IF;
 IF c.protection_state='off' THEN RETURN 'switched_off'; END IF;
 IF p_action='test' THEN
  IF c.mode='test' THEN RETURN 'unchanged'; END IF;
  UPDATE app_private.email_connections SET mode='test',row_version=c.row_version+1,updated_at=clock_timestamp() WHERE workspace_id=p_workspace;
  PERFORM app_private.email_protection_note(p_workspace,'mode_test','{}'::jsonb,actor,false,false);
  RETURN 'test';
 END IF;
 v_approved:=c.go_live_approved_at IS NOT NULL AND s.approved_domain IS NOT DISTINCT FROM c.domain;
 IF c.mode='live' AND v_approved AND s.test_passed_at>=c.verified_at THEN RETURN 'unchanged'; END IF;
 IF c.protection_state='paused' THEN RETURN 'paused'; END IF;
 IF p_webhook_ok IS NOT TRUE OR c.webhook_id IS NULL THEN RETURN 'needs_webhook'; END IF;
 IF p_terms IS NULL OR c.terms_version IS DISTINCT FROM p_terms THEN RETURN 'needs_terms'; END IF;
 IF s.business_name IS NULL OR s.postal_address IS NULL THEN RETURN 'needs_footer'; END IF;
 IF s.test_passed_at IS NULL OR c.verified_at IS NULL OR s.test_passed_at<c.verified_at THEN RETURN 'needs_test'; END IF;
 IF NOT v_approved THEN
  IF s.go_live_requested_at>coalesce(c.go_live_approved_at,'-infinity'::timestamptz) AND s.go_live_requested_domain IS NOT DISTINCT FROM c.domain THEN
   RETURN 'already_requested'; END IF;
  -- A request made for another domain (the business changed domain since) is replaced by this one.
  UPDATE app_private.email_sending_controls SET go_live_requested_at=clock_timestamp(),go_live_requested_by=actor,go_live_requested_domain=c.domain,
   row_version=s.row_version+1,updated_at=clock_timestamp() WHERE workspace_id=p_workspace;
  PERFORM app_private.email_protection_note(p_workspace,'go_live_requested',jsonb_build_object('newDomain',c.go_live_approved_at IS NOT NULL,'domain',c.domain),actor,false,true);
  RETURN 'requested';
 END IF;
 UPDATE app_private.email_connections SET mode='live',row_version=c.row_version+1,updated_at=clock_timestamp() WHERE workspace_id=p_workspace;
 PERFORM app_private.email_protection_note(p_workspace,'mode_live','{}'::jsonb,actor,false,false);
 RETURN 'live';
END $f$;

-- "Send a test to me": reserves one test send (as email_send_reserve 'test' does) for the owner's session. A replay
-- says what happened to the first attempt: 'replayed' (it was accepted for sending), 'replayed_refused' (it certainly
-- did not go) or 'replayed_unknown' (no answer was recorded).
CREATE FUNCTION app_private.email_sending_test_reserve(p_session bytea,p_workspace uuid,p_key text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE v_out text; v_state text;
BEGIN
 IF session_user<>'r72_identity_command' THEN RAISE EXCEPTION 'Email connection boundary required' USING ERRCODE='42501'; END IF;
 PERFORM app_private.email_connection_owner(p_session,p_workspace);
 IF p_key IS NULL OR p_key!~'^test:' THEN RAISE EXCEPTION 'Invalid test' USING ERRCODE='22023'; END IF;
 v_out:=app_private.email_send_reserve(p_workspace,p_key,'test');
 IF v_out='replayed' THEN
  SELECT e.state INTO v_state FROM app_private.email_send_events e WHERE e.workspace_id=p_workspace AND e.event_key=p_key;
  RETURN CASE v_state WHEN 'accepted' THEN 'replayed' WHEN 'released' THEN 'replayed_refused' ELSE 'replayed_unknown' END;
 END IF;
 RETURN v_out;
END $f$;

-- The result of "Send a test to me": accepted by Postmark for sending (the test counts as passed), or released.
CREATE FUNCTION app_private.email_sending_test_result(p_session bytea,p_workspace uuid,p_key text,p_accepted boolean) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE actor uuid; s app_private.email_sending_controls%ROWTYPE; outcome text;
BEGIN
 IF session_user<>'r72_identity_command' THEN RAISE EXCEPTION 'Email connection boundary required' USING ERRCODE='42501'; END IF;
 actor:=app_private.email_connection_owner(p_session,p_workspace);
 IF p_key IS NULL OR p_accepted IS NULL OR NOT EXISTS(SELECT 1 FROM app_private.email_send_events e WHERE e.workspace_id=p_workspace AND e.kind='send'
   AND e.event_key=p_key AND e.purpose='test') THEN RAISE EXCEPTION 'Invalid test result' USING ERRCODE='22023'; END IF;
 outcome:=app_private.email_send_settle(p_workspace,p_key,p_accepted);
 IF outcome='accepted' THEN
  s:=app_private.email_sending_controls_row(p_workspace);
  UPDATE app_private.email_sending_controls SET test_passed_at=clock_timestamp(),row_version=s.row_version+1,updated_at=clock_timestamp() WHERE workspace_id=p_workspace;
  PERFORM app_private.email_protection_note(p_workspace,'test_sent','{}'::jsonb,actor,false,false);
 END IF;
 RETURN outcome;
END $f$;

-- The same picture without a session, for the signed Group HQ read (it authenticates the founder itself) and the
-- founder's page: every business with a connection, its state, the numbers of its last protection step, whether it
-- waits for approval, the account row, and the alert emails given up on in the last 30 days (so none is lost).
CREATE FUNCTION app_private.email_protection_status() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE a app_private.email_account_protection%ROWTYPE;
BEGIN
 IF session_user<>'r72_identity_command' THEN RAISE EXCEPTION 'Email connection boundary required' USING ERRCODE='42501'; END IF;
 SELECT * INTO a FROM app_private.email_account_protection x WHERE x.id;
 RETURN jsonb_build_object('account',jsonb_build_object('state',a.state,'reason',a.reason,'since',a.since,'rowVersion',a.row_version,
   'numbers',(SELECT e.numbers FROM app_private.email_account_events e WHERE e.kind='account_held' ORDER BY e.occurred_at DESC,e.id DESC LIMIT 1)),
  'undelivered',coalesce((SELECT jsonb_agg(jsonb_build_object('workspaceId',x.workspace_id,'audience',x.audience,'kind',x.kind,'at',x.created_at) ORDER BY x.created_at DESC)
   FROM (SELECT * FROM app_private.email_protection_alerts y WHERE y.given_up_at IS NOT NULL AND y.created_at>clock_timestamp()-interval '30 days' ORDER BY y.created_at DESC LIMIT 20) x),'[]'::jsonb),
  'businesses',coalesce((SELECT jsonb_agg(jsonb_build_object('workspaceId',c.workspace_id,'businessName',coalesce(s.business_name,c.from_name),'status',c.status,'mode',c.mode,
    'domain',c.domain,
    'state',c.protection_state,'reason',c.protection_reason,'since',c.protection_since,'rowVersion',c.row_version,
    'goLiveRequestedAt',CASE WHEN s.go_live_requested_at>coalesce(c.go_live_approved_at,'-infinity'::timestamptz) AND s.go_live_requested_domain IS NOT DISTINCT FROM c.domain THEN s.go_live_requested_at END,
    'goLiveApprovedAt',c.go_live_approved_at,'sampleState',coalesce(s.sample_state,'none'),
    'counts',app_private.email_protection_counts(c.workspace_id),
    'lastStep',(SELECT p.numbers||jsonb_build_object('kind',p.kind,'at',p.occurred_at) FROM app_private.email_protection_events p WHERE p.workspace_id=c.workspace_id
      AND p.kind IN('slowed','paused','switched_off','sample_held','recovered','lifted','reinstated','sample_released') ORDER BY p.occurred_at DESC,p.id DESC LIMIT 1))
    ORDER BY c.workspace_id)
   FROM app_private.email_connections c LEFT JOIN app_private.email_sending_controls s ON s.workspace_id=c.workspace_id),'[]'::jsonb));
END $f$;

-- The founder's read. Refuses anyone the founder check does not accept.
CREATE FUNCTION app_private.email_protection_founder_view(p_session bytea) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE actor uuid;
BEGIN
 IF session_user<>'r72_identity_command' THEN RAISE EXCEPTION 'Email connection boundary required' USING ERRCODE='42501'; END IF;
 actor:=app_private.email_protection_founder(p_session);
 IF actor IS NULL THEN RAISE EXCEPTION 'Founder required' USING ERRCODE='42501'; END IF;
 RETURN app_private.email_protection_status();
END $f$;

-- The founder's buttons, each recorded with who pressed it. p_action: 'approve' (a go-live the owner asked for, for the
-- domain in use: the connection must still be verified, not paused or off, with the footer and a test accepted since
-- the last verification; a new domain restarts the warm-up at its first step), 'lift' (a pause), 'reinstate' (a
-- business that was switched off), 'release_sample' (a held sample), 'lift_account' (the account hold; p_workspace
-- NULL). p_version is the row version the founder was shown (a stale page changes nothing). A lift or reinstate starts a
-- new sample and only counts what happens from now on; the business restarts slowed and recovers by itself. Answers
-- 'done', 'stale' or 'not_needed'.
CREATE FUNCTION app_private.email_protection_founder_act(p_session bytea,p_workspace uuid,p_action text,p_version bigint) RETURNS text
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

-- The alert outbox: up to p_limit unsent alerts, each claimed for 5 minutes, with the business's name and (for the
-- owner audience) the owners' sign-in addresses looked up now.
CREATE FUNCTION app_private.email_protection_alerts_claim(p_limit integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE v_out jsonb:='[]'::jsonb; r app_private.email_protection_alerts%ROWTYPE; v_name text;
BEGIN
 IF session_user<>'r72_identity_command' THEN RAISE EXCEPTION 'Email connection boundary required' USING ERRCODE='42501'; END IF;
 IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 50 THEN RAISE EXCEPTION 'Invalid alert claim' USING ERRCODE='22023'; END IF;
 FOR r IN SELECT * FROM app_private.email_protection_alerts x WHERE x.sent_at IS NULL AND x.given_up_at IS NULL AND (x.claimed_until IS NULL OR x.claimed_until<clock_timestamp())
  ORDER BY x.created_at,x.id LIMIT p_limit FOR UPDATE SKIP LOCKED LOOP
  UPDATE app_private.email_protection_alerts SET claimed_until=clock_timestamp()+interval '5 minutes',attempts=r.attempts+1 WHERE id=r.id;
  SELECT coalesce(s.business_name,c.from_name) INTO v_name FROM app_private.email_connections c LEFT JOIN app_private.email_sending_controls s ON s.workspace_id=c.workspace_id
   WHERE c.workspace_id=r.workspace_id;
  v_out:=v_out||jsonb_build_array(jsonb_build_object('id',r.id,'workspaceId',r.workspace_id,'audience',r.audience,'kind',r.kind,'numbers',r.numbers,'createdAt',r.created_at,
   'attempts',r.attempts+1,'businessName',v_name,
   'ownerEmails',CASE WHEN r.audience='owner' THEN to_jsonb(app_private.email_sending_owner_emails(r.workspace_id)) ELSE '[]'::jsonb END));
 END LOOP;
 RETURN v_out;
END $f$;

-- One alert's outcome: sent, or (after 5 tries, or with nobody to send it to) given up. Answers 'sent', 'given_up' or 'retry'.
CREATE FUNCTION app_private.email_protection_alert_done(p_id uuid,p_sent boolean) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE r app_private.email_protection_alerts%ROWTYPE;
BEGIN
 IF session_user<>'r72_identity_command' THEN RAISE EXCEPTION 'Email connection boundary required' USING ERRCODE='42501'; END IF;
 SELECT * INTO r FROM app_private.email_protection_alerts x WHERE x.id=p_id FOR UPDATE;
 IF NOT FOUND OR r.sent_at IS NOT NULL OR r.given_up_at IS NOT NULL THEN RETURN 'unchanged'; END IF;
 IF p_sent THEN UPDATE app_private.email_protection_alerts SET sent_at=clock_timestamp(),claimed_until=NULL WHERE id=p_id; RETURN 'sent'; END IF;
 IF r.attempts>=5 THEN UPDATE app_private.email_protection_alerts SET given_up_at=clock_timestamp(),claimed_until=NULL WHERE id=p_id; RETURN 'given_up'; END IF;
 UPDATE app_private.email_protection_alerts SET claimed_until=clock_timestamp()+make_interval(mins=>5*r.attempts) WHERE id=p_id;
 RETURN 'retry';
END $f$;

REVOKE ALL ON FUNCTION app_private.email_protection_ramp(integer),app_private.email_protection_step_days(integer),
 app_private.email_sending_controls_row(uuid),
 app_private.email_protection_note(uuid,text,jsonb,uuid,boolean,boolean),
 app_private.email_protection_counts(uuid),
 app_private.email_sending_state(bytea,uuid),
 app_private.email_sending_details(bytea,uuid,text,text,text[]),
 app_private.email_send_reserve(uuid,text,text),
 app_private.email_send_settle(uuid,text,boolean),
 app_private.email_counter_record(uuid,text,text,timestamptz),
 app_private.email_send_events_prune(uuid),
 app_private.email_sending_config(uuid),
 app_private.email_protection_numbers(),
 app_private.email_protection_apply(uuid,text,text,text,text,text,jsonb,integer,integer,integer,timestamptz,text),
 app_private.email_account_apply(text,text,text,jsonb),
 app_private.email_sending_command(bytea,uuid,text,text,boolean),
 app_private.email_sending_test_reserve(bytea,uuid,text),
 app_private.email_sending_test_result(bytea,uuid,text,boolean),
 app_private.email_protection_status(),
 app_private.email_protection_founder_view(bytea),
 app_private.email_protection_founder_act(bytea,uuid,text,bigint),
 app_private.email_protection_alerts_claim(integer),
 app_private.email_protection_alert_done(uuid,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.email_sending_state(bytea,uuid),
 app_private.email_sending_details(bytea,uuid,text,text,text[]),
 app_private.email_send_reserve(uuid,text,text),
 app_private.email_send_settle(uuid,text,boolean),
 app_private.email_counter_record(uuid,text,text,timestamptz),
 app_private.email_send_events_prune(uuid),
 app_private.email_sending_config(uuid),
 app_private.email_protection_numbers(),
 app_private.email_protection_apply(uuid,text,text,text,text,text,jsonb,integer,integer,integer,timestamptz,text),
 app_private.email_account_apply(text,text,text,jsonb),
 app_private.email_sending_command(bytea,uuid,text,text,boolean),
 app_private.email_sending_test_reserve(bytea,uuid,text),
 app_private.email_sending_test_result(bytea,uuid,text,boolean),
 app_private.email_protection_status(),
 app_private.email_protection_founder_view(bytea),
 app_private.email_protection_founder_act(bytea,uuid,text,bigint),
 app_private.email_protection_alerts_claim(integer),
 app_private.email_protection_alert_done(uuid,boolean) TO r72_identity_command;

RESET ROLE;
SET LOCAL ROLE r72_pp_followup_definer;

-- A Property Predator follow-up run that is due but held (a protection hold, the owner's pause, the sample's wait, an
-- account hold, a full cap or test mode) would fail as delivery_expired once its retry window ran out (0152's claim).
-- While the sender is held, the window of every due, active run that can wait is restarted, as 0152's 'resume' does,
-- but only once the oldest of THOSE runs has waited 20 minutes (the shortest window is 1 hour), so a run that cannot
-- wait never makes the others move on every call. They move in due order: when the hold lifts they go first-due first.
-- A run whose step was in flight when the others moved keeps its own due time and is placed by it the next time it can
-- wait, so it can then go ahead of runs that were moved before it. A step already claimed and handed back
-- ('deferred') moves its due and expiry times by the same amount. A run can wait when its step has not been handed off,
-- or its latest hand-off proof is resolved, or is the unknown outcome the owner acknowledged. A step in flight (lease
-- live), sent, failed, cancelled, held for recovery or with an unresolved hand-off is never touched. At most 5,000 runs
-- a call. Answers how many moved.
CREATE FUNCTION app_private.pp_followup_hold_wait() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE v_now timestamptz:=clock_timestamp(); n integer;
BEGIN
 IF session_user<>'r72_identity_command' THEN RAISE EXCEPTION 'PP follow-up boundary required' USING ERRCODE='42501'; END IF;
 IF NOT EXISTS(SELECT 1 FROM app_private.pp_followup_runs r WHERE r.state='active' AND r.due_at<v_now-interval '20 minutes') THEN RETURN 0; END IF;
 WITH due AS (
  SELECT r.id,r.due_at,r.current_send_id,row_number() OVER (ORDER BY r.due_at,r.id) AS rn,count(*) OVER () AS total,min(r.due_at) OVER () AS oldest
  FROM app_private.pp_followup_runs r WHERE r.state='active' AND r.due_at<=v_now
   AND (r.current_send_id IS NULL OR EXISTS(SELECT 1 FROM app_private.pp_followup_sends q WHERE q.id=r.current_send_id AND q.sent_at IS NULL AND q.failed_at IS NULL
    AND q.cancelled_at IS NULL AND q.held_at IS NULL AND (q.lease_id IS NULL OR q.lease_until<=v_now)
    AND NOT EXISTS(SELECT 1 FROM (SELECT p.id,p.accepted FROM app_private.pp_followup_dispatch_proofs p WHERE p.send_id=q.id ORDER BY p.checked_at DESC,p.id DESC LIMIT 1) p
     WHERE p.accepted IS NULL AND p.id IS DISTINCT FROM r.unknown_ack_proof_id)))
  ORDER BY r.due_at,r.id LIMIT 5000),
 moved AS (SELECT d.id,d.current_send_id,greatest(d.due_at,v_now-(d.total-d.rn)*interval '1 millisecond')-d.due_at AS shift FROM due d
  WHERE d.oldest<v_now-interval '20 minutes'),
 sends AS (UPDATE app_private.pp_followup_sends q SET due_at=q.due_at+m.shift,expires_at=q.expires_at+m.shift FROM moved m WHERE q.id=m.current_send_id AND m.shift>interval '0' RETURNING q.id)
 UPDATE app_private.pp_followup_runs r SET due_at=r.due_at+m.shift,updated_at=v_now FROM moved m WHERE r.id=m.id AND m.shift>interval '0';
 GET DIAGNOSTICS n=ROW_COUNT;
 RETURN n;
END $f$;
REVOKE ALL ON FUNCTION app_private.pp_followup_hold_wait() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.pp_followup_hold_wait() TO r72_identity_command;

RESET ROLE;
SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private FROM r72_email_connection_definer,r72_pp_followup_definer;
RESET ROLE;
