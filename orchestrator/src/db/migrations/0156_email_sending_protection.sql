-- 0156: "Connect email" release 2 - sending through the stored connection, and sender protection.
--
-- Additive only, on the exact 0155. Nothing older than 0155 is touched. On app_private.email_connections (0155, this
-- feature's own table) nothing is altered: the definer is GRANTED UPDATE on the groundwork columns 0155 left unwritable
-- (mode, test_recipients, protection_state/reason/since, daily_cap, hourly_cap, warmup_started_at,
-- go_live_approved_by/at). Six new private tables, all forced RLS, pinned like 0155 (workspace tables to the Property
-- Predator workspace), written only through r72_email_connection_definer functions with search_path=pg_catalog that
-- refuse any session user but r72_identity_command:
--   email_sending_controls   one row per business: footer details (real business name and postal address), the
--                            owner's own pause, the last successful test, the go-live request, the warm-up step, the
--                            new-list sample and the floor below which old events no longer count after a founder lift.
--   email_send_events        the durable counters: one row per send (keyed by our own lease/test key: reserved, then
--                            accepted or released) and per hard bounce, soft bounce, spam complaint and unsubscribe
--                            (keyed by Postmark's event id), so replays change nothing. Never an address.
--   email_protection_alerts  the outbox for the plain emails to the business owner and the founder (one row per audience
--                            per protection step, written in the same transaction as the step).
--   email_account_protection and email_account_events   the account-wide trip-wire (one row) and its append-only log.
-- email_protection_events (0155) receives every protection step with the numbers at that moment.
--
-- Enforcement in SQL, whatever the application decides: a system step can only move a business UP the ladder
-- (ok -> slowed -> paused -> off) or recover slowed -> ok; a SECOND own pause within 90 days becomes 'off' here; only a
-- session the founder check accepts can approve a first go-live, lift a pause, reinstate a business that was switched
-- off, release a held sample or lift the account hold; every send is reserved here against the stored caps, the mode,
-- the owner's pause, the protection state, the sample and the account hold before anything is handed to Postmark.
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

-- One person's sign-in address (the default test list is the owner's own), or NULL.
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
 CHECK((go_live_requested_at IS NULL)=(go_live_requested_by IS NULL)),
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
GRANT UPDATE(business_name,postal_address,test_passed_at,owner_paused_at,owner_paused_by,go_live_requested_at,go_live_requested_by,warmup_step,warmup_step_at,
 counted_since,sample_state,sample_started_at,sample_full_at,row_version,updated_at) ON app_private.email_sending_controls TO r72_email_connection_definer;

-- The durable counters. A send is reserved under our own key BEFORE it is handed to Postmark (so caps hold across
-- every instance), then accepted (Postmark took it) or released (it certainly did not go). An unknown outcome stays
-- reserved and counts. Bounces, complaints and unsubscribes are keyed by Postmark's own event id: a replayed webhook
-- or a second hourly read of the same bounce changes nothing.
CREATE TABLE app_private.email_send_events(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 workspace_id uuid NOT NULL CHECK(workspace_id='d975ff66-336a-46c2-b36b-d7095a11af97'),
 kind text NOT NULL CHECK(kind IN('send','hard_bounce','soft_bounce','complaint','unsubscribe')),
 event_key text NOT NULL CHECK(event_key~'^[!-~]{1,200}$' AND event_key!~'@'),
 purpose text CHECK(purpose IS NULL OR purpose IN('test','live')),
 state text NOT NULL CHECK(state IN('reserved','accepted','released','fact')),
 occurred_at timestamptz NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 settled_at timestamptz,
 UNIQUE(workspace_id,kind,event_key),
 CHECK((kind='send')=(state<>'fact')),
 CHECK((kind='send')=(purpose IS NOT NULL)),
 CHECK((state IN('accepted','released'))=(settled_at IS NOT NULL))
);
CREATE INDEX email_send_events_recent ON app_private.email_send_events(workspace_id,kind,occurred_at DESC);
ALTER TABLE app_private.email_send_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.email_send_events FORCE ROW LEVEL SECURITY;
REVOKE ALL ON app_private.email_send_events FROM PUBLIC;
CREATE POLICY email_send_events_owner ON app_private.email_send_events TO r72_owner USING(true) WITH CHECK(true);
CREATE POLICY email_send_events_definer ON app_private.email_send_events TO r72_email_connection_definer
 USING(session_user='r72_identity_command' AND workspace_id='d975ff66-336a-46c2-b36b-d7095a11af97')
 WITH CHECK(session_user='r72_identity_command' AND workspace_id='d975ff66-336a-46c2-b36b-d7095a11af97');
INSERT INTO app_private.workspace_table_registry(schema_name,table_name,workspace_column) VALUES('app_private','email_send_events','workspace_id');
-- Only a reserved send may be settled; nothing else in a counter row can change and nothing is ever deleted.
GRANT SELECT,INSERT ON app_private.email_send_events TO r72_email_connection_definer;
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

GRANT CREATE ON SCHEMA app_private TO r72_email_connection_definer;
SET LOCAL ROLE r72_email_connection_definer;

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
-- Every window starts no earlier than counted_since (set when the founder lifts a pause or reinstates a business), so
-- old bounces that were already acted on never trip the ladder again. Sends are reserved or accepted (an unknown
-- outcome counts as sent); bounces are hard plus soft, the way Postmark counts them.
CREATE FUNCTION app_private.email_protection_counts(p_workspace uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE c app_private.email_connections%ROWTYPE; s app_private.email_sending_controls%ROWTYPE; floor_at timestamptz; now_at timestamptz:=clock_timestamp();
 w7 timestamptz; w30 timestamptz; last50 timestamptz; v_out jsonb;
BEGIN
 IF session_user<>'r72_identity_command' THEN RAISE EXCEPTION 'Email connection boundary required' USING ERRCODE='42501'; END IF;
 SELECT * INTO c FROM app_private.email_connections x WHERE x.workspace_id=p_workspace;
 IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT * INTO s FROM app_private.email_sending_controls x WHERE x.workspace_id=p_workspace;
 floor_at:=coalesce(s.counted_since,'-infinity'::timestamptz);
 w7:=greatest(now_at-interval '7 days',floor_at); w30:=greatest(now_at-interval '30 days',floor_at);
 SELECT e.occurred_at INTO last50 FROM app_private.email_send_events e WHERE e.workspace_id=p_workspace AND e.kind='send' AND e.state IN('reserved','accepted')
  AND e.occurred_at>=floor_at ORDER BY e.occurred_at DESC,e.id DESC OFFSET 49 LIMIT 1;
 SELECT jsonb_build_object(
  'sends7',count(*) FILTER (WHERE e.kind='send' AND e.state IN('reserved','accepted') AND e.occurred_at>=w7),
  'hard7',count(*) FILTER (WHERE e.kind='hard_bounce' AND e.occurred_at>=w7),
  'soft7',count(*) FILTER (WHERE e.kind='soft_bounce' AND e.occurred_at>=w7),
  'sends30',count(*) FILTER (WHERE e.kind='send' AND e.state IN('reserved','accepted') AND e.occurred_at>=w30),
  'complaints30',count(*) FILTER (WHERE e.kind='complaint' AND e.occurred_at>=w30),
  'unsubscribes30',count(*) FILTER (WHERE e.kind='unsubscribe' AND e.occurred_at>=w30),
  'last50Sends',least(50,count(*) FILTER (WHERE e.kind='send' AND e.state IN('reserved','accepted') AND e.occurred_at>=floor_at)),
  'hardLast50',count(*) FILTER (WHERE e.kind='hard_bounce' AND e.occurred_at>=coalesce(last50,floor_at)),
  'liveDay',count(*) FILTER (WHERE e.kind='send' AND e.purpose='live' AND e.state IN('reserved','accepted') AND e.occurred_at>now_at-interval '24 hours'),
  'liveHour',count(*) FILTER (WHERE e.kind='send' AND e.purpose='live' AND e.state IN('reserved','accepted') AND e.occurred_at>now_at-interval '60 minutes'),
  'sampleSends',count(*) FILTER (WHERE s.sample_started_at IS NOT NULL AND e.kind='send' AND e.purpose='live' AND e.state IN('reserved','accepted') AND e.occurred_at>=s.sample_started_at),
  'sampleBounces',count(*) FILTER (WHERE s.sample_started_at IS NOT NULL AND e.kind IN('hard_bounce','soft_bounce') AND e.occurred_at>=s.sample_started_at),
  'sampleComplaints',count(*) FILTER (WHERE s.sample_started_at IS NOT NULL AND e.kind='complaint' AND e.occurred_at>=s.sample_started_at),
  'stepSends',count(*) FILTER (WHERE s.warmup_step_at IS NOT NULL AND e.kind='send' AND e.state IN('reserved','accepted') AND e.occurred_at>=s.warmup_step_at),
  'stepBounces',count(*) FILTER (WHERE s.warmup_step_at IS NOT NULL AND e.kind IN('hard_bounce','soft_bounce') AND e.occurred_at>=s.warmup_step_at),
  'stepComplaints',count(*) FILTER (WHERE s.warmup_step_at IS NOT NULL AND e.kind='complaint' AND e.occurred_at>=s.warmup_step_at))
 INTO v_out FROM app_private.email_send_events e WHERE e.workspace_id=p_workspace AND e.occurred_at>=least(now_at-interval '30 days',coalesce(s.sample_started_at,now_at),coalesce(s.warmup_step_at,now_at),coalesce(last50,now_at));
 RETURN v_out||jsonb_build_object('workspaceId',c.workspace_id,'status',c.status,'mode',c.mode,'state',c.protection_state,'reason',c.protection_reason,'since',c.protection_since,
  'dailyCap',c.daily_cap,'hourlyCap',c.hourly_cap,'warmupStartedAt',c.warmup_started_at,'goLiveApprovedAt',c.go_live_approved_at,
  'warmupStep',coalesce(s.warmup_step,0),'warmupStepAt',s.warmup_step_at,'countedSince',s.counted_since,'sampleState',coalesce(s.sample_state,'none'),
  'sampleStartedAt',s.sample_started_at,'sampleFullAt',s.sample_full_at,'ownerPausedAt',s.owner_paused_at,
  'ownPauses90',(SELECT count(*) FROM app_private.email_protection_events p WHERE p.workspace_id=p_workspace AND p.kind='paused'
   AND p.numbers->>'cause'='own' AND p.occurred_at>now_at-interval '90 days'),
  'now',now_at);
END $f$;

-- What the owner's page shows beyond 0155's state: footer details, test list, the owner's pause, the go-live request,
-- the counts and the last protection step's numbers, and the last 7 UK days. Never a sealed value, never an address
-- other than the test list and the owner's own sign-in address.
CREATE FUNCTION app_private.email_sending_state(p_session bytea,p_workspace uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE actor uuid; c app_private.email_connections%ROWTYPE; s app_private.email_sending_controls%ROWTYPE; a app_private.email_account_protection%ROWTYPE; v_last jsonb;
BEGIN
 IF session_user<>'r72_identity_command' THEN RAISE EXCEPTION 'Email connection boundary required' USING ERRCODE='42501'; END IF;
 actor:=app_private.email_connection_owner(p_session,p_workspace);
 SELECT * INTO c FROM app_private.email_connections x WHERE x.workspace_id=p_workspace;
 SELECT * INTO s FROM app_private.email_sending_controls x WHERE x.workspace_id=p_workspace;
 SELECT * INTO a FROM app_private.email_account_protection x WHERE x.id;
 SELECT p.numbers||jsonb_build_object('kind',p.kind,'at',p.occurred_at) INTO v_last FROM app_private.email_protection_events p WHERE p.workspace_id=p_workspace
  AND p.kind IN('slowed','paused','switched_off','sample_held','recovered','lifted','reinstated','sample_released','sample_passed') ORDER BY p.occurred_at DESC,p.id DESC LIMIT 1;
 RETURN jsonb_build_object('ownEmail',app_private.email_sending_user_email(actor),'businessName',s.business_name,'postalAddress',s.postal_address,
  'testRecipients',to_jsonb(coalesce(c.test_recipients,'{}'::text[])),'testPassedAt',s.test_passed_at,'ownerPausedAt',s.owner_paused_at,
  'goLiveRequestedAt',s.go_live_requested_at,'goLiveApprovedAt',c.go_live_approved_at,'sampleState',coalesce(s.sample_state,'none'),
  'sampleStartedAt',s.sample_started_at,'sampleFullAt',s.sample_full_at,'warmupStep',coalesce(s.warmup_step,0),'accountHeld',coalesce(a.state,'ok')='held',
  'lastStep',v_last,'counts',CASE WHEN c.workspace_id IS NULL THEN NULL ELSE app_private.email_protection_counts(p_workspace) END,
  'days',coalesce((SELECT jsonb_agg(jsonb_build_object('day',d.day,'sends',d.sends,'hardBounces',d.hard,'softBounces',d.soft,'complaints',d.complaints,'unsubscribes',d.unsubs) ORDER BY d.day DESC)
   FROM (SELECT (e.occurred_at AT TIME ZONE 'Europe/London')::date AS day,
     count(*) FILTER (WHERE e.kind='send' AND e.state IN('reserved','accepted')) AS sends,count(*) FILTER (WHERE e.kind='hard_bounce') AS hard,
     count(*) FILTER (WHERE e.kind='soft_bounce') AS soft,count(*) FILTER (WHERE e.kind='complaint') AS complaints,count(*) FILTER (WHERE e.kind='unsubscribe') AS unsubs
    FROM app_private.email_send_events e WHERE e.workspace_id=p_workspace AND e.occurred_at>clock_timestamp()-interval '7 days' GROUP BY 1) d),'[]'::jsonb));
END $f$;

-- The owner saves the footer details (the business's real name and postal address, printed in every marketing email)
-- and the test list (0 to 10 addresses; empty means the owner's own sign-in address).
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
-- "Send a test to me"). Answers 'ok' (reserved; also for a replay of the same key) or why it is held: 'account_held',
-- 'off', 'paused', 'owner_paused', 'not_live', 'not_connected', 'sample_wait', 'sample_held', 'daily_cap', 'hourly_cap',
-- 'test_limit'. Nothing is written for a hold.
CREATE FUNCTION app_private.email_send_reserve(p_workspace uuid,p_key text,p_purpose text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE c app_private.email_connections%ROWTYPE; s app_private.email_sending_controls%ROWTYPE; a app_private.email_account_protection%ROWTYPE;
 day_count integer; hour_count integer; sample_count integer;
BEGIN
 IF session_user<>'r72_identity_command' THEN RAISE EXCEPTION 'Email connection boundary required' USING ERRCODE='42501'; END IF;
 IF p_key IS NULL OR p_key!~'^[!-~]{1,200}$' OR p_key~'@' OR p_purpose IS NULL OR p_purpose NOT IN('live','test') THEN RAISE EXCEPTION 'Invalid email send' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('email-sending:'||p_workspace::text,156));
 IF EXISTS(SELECT 1 FROM app_private.email_send_events e WHERE e.workspace_id=p_workspace AND e.kind='send' AND e.event_key=p_key) THEN RETURN 'ok'; END IF;
 SELECT * INTO c FROM app_private.email_connections x WHERE x.workspace_id=p_workspace;
 IF NOT FOUND OR c.status<>'verified' THEN RETURN 'not_connected'; END IF;
 s:=app_private.email_sending_controls_row(p_workspace);
 SELECT * INTO a FROM app_private.email_account_protection x WHERE x.id;
 IF c.protection_state='off' THEN RETURN 'off'; END IF;
 IF s.owner_paused_at IS NOT NULL THEN RETURN 'owner_paused'; END IF;
 IF p_purpose='test' THEN
  -- At most 20 emails an hour to the business's own test list, whatever the mode; never while switched off.
  SELECT count(*) INTO hour_count FROM app_private.email_send_events e WHERE e.workspace_id=p_workspace AND e.kind='send' AND e.purpose='test'
   AND e.state IN('reserved','accepted') AND e.occurred_at>clock_timestamp()-interval '60 minutes';
  IF hour_count>=20 THEN RETURN 'test_limit'; END IF;
 ELSE
  IF a.state='held' THEN RETURN 'account_held'; END IF;
  IF c.protection_state='paused' THEN RETURN 'paused'; END IF;
  IF c.mode<>'live' THEN RETURN 'not_live'; END IF;
  IF s.sample_state='held' THEN RETURN 'sample_held'; END IF;
  IF s.sample_state='waiting' THEN RETURN 'sample_wait'; END IF;
  SELECT count(*) FILTER (WHERE e.occurred_at>clock_timestamp()-interval '24 hours'),count(*) FILTER (WHERE e.occurred_at>clock_timestamp()-interval '60 minutes')
   INTO day_count,hour_count FROM app_private.email_send_events e WHERE e.workspace_id=p_workspace AND e.kind='send' AND e.purpose='live'
   AND e.state IN('reserved','accepted') AND e.occurred_at>clock_timestamp()-interval '24 hours';
  IF day_count>=c.daily_cap THEN RETURN 'daily_cap'; END IF;
  IF hour_count>=c.hourly_cap THEN RETURN 'hourly_cap'; END IF;
 END IF;
 INSERT INTO app_private.email_send_events(workspace_id,kind,event_key,purpose,state,occurred_at) VALUES(p_workspace,'send',p_key,p_purpose,'reserved',clock_timestamp());
 -- The sample: once its 50th live email is reserved, the rest waits for the automatic verdict (two hours later).
 IF p_purpose='live' AND s.sample_state='sending' THEN
  SELECT count(*) INTO sample_count FROM app_private.email_send_events e WHERE e.workspace_id=p_workspace AND e.kind='send' AND e.purpose='live'
   AND e.state IN('reserved','accepted') AND e.occurred_at>=s.sample_started_at;
  IF sample_count>=50 THEN
   UPDATE app_private.email_sending_controls SET sample_state='waiting',sample_full_at=clock_timestamp(),row_version=s.row_version+1,updated_at=clock_timestamp()
   WHERE workspace_id=p_workspace;
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

-- One bounce, spam complaint or unsubscribe for a business's own stream, keyed by Postmark's event id: 'recorded' the
-- first time, 'exists' on every replay. Only a business with a connection row is counted.
CREATE FUNCTION app_private.email_counter_record(p_workspace uuid,p_kind text,p_key text,p_at timestamptz) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
BEGIN
 IF session_user<>'r72_identity_command' THEN RAISE EXCEPTION 'Email connection boundary required' USING ERRCODE='42501'; END IF;
 IF p_kind IS NULL OR p_kind NOT IN('hard_bounce','soft_bounce','complaint','unsubscribe') OR p_key IS NULL OR p_key!~'^[!-~]{1,200}$' OR p_key~'@'
  OR p_at IS NULL OR p_at>statement_timestamp()+interval '1 day' THEN RAISE EXCEPTION 'Invalid email counter' USING ERRCODE='22023'; END IF;
 IF NOT EXISTS(SELECT 1 FROM app_private.email_connections x WHERE x.workspace_id=p_workspace) THEN RETURN 'ignored'; END IF;
 INSERT INTO app_private.email_send_events(workspace_id,kind,event_key,state,occurred_at) VALUES(p_workspace,p_kind,p_key,'fact',least(p_at,clock_timestamp()))
 ON CONFLICT(workspace_id,kind,event_key) DO NOTHING;
 RETURN CASE WHEN FOUND THEN 'recorded' ELSE 'exists' END;
END $f$;

-- What the sender reads at the start of every sweep (no portal session): the connection in charge of this business's
-- marketing email, its sealed server token (opened in the application), the footer, the test list and the holds.
CREATE FUNCTION app_private.email_sending_config(p_workspace uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE c app_private.email_connections%ROWTYPE; s app_private.email_sending_controls%ROWTYPE; a app_private.email_account_protection%ROWTYPE;
BEGIN
 IF session_user<>'r72_identity_command' THEN RAISE EXCEPTION 'Email connection boundary required' USING ERRCODE='42501'; END IF;
 SELECT * INTO c FROM app_private.email_connections x WHERE x.workspace_id=p_workspace;
 IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT * INTO s FROM app_private.email_sending_controls x WHERE x.workspace_id=p_workspace;
 SELECT * INTO a FROM app_private.email_account_protection x WHERE x.id;
 RETURN jsonb_build_object('workspaceId',c.workspace_id,'status',c.status,'mode',c.mode,'serverId',c.postmark_server_id,'stream',coalesce(c.broadcast_stream,'broadcast'),
  'sealedServerToken',c.sealed_server_token,'fromName',c.from_name,'fromAddress',c.from_address,'replyTo',c.reply_to,
  'businessName',s.business_name,'postalAddress',s.postal_address,
  'testRecipients',to_jsonb(CASE WHEN cardinality(c.test_recipients)>0 THEN c.test_recipients
   ELSE array_remove(ARRAY[app_private.email_sending_user_email(c.terms_accepted_by)],NULL) END),
  'protectionState',c.protection_state,'ownerPaused',s.owner_paused_at IS NOT NULL,'sampleState',coalesce(s.sample_state,'none'),
  'dailyCap',c.daily_cap,'hourlyCap',c.hourly_cap,'accountHeld',coalesce(a.state,'ok')='held',
  'goLiveRequestedAt',s.go_live_requested_at,'goLiveApprovedAt',c.go_live_approved_at,
  'lastStep',(SELECT p.numbers||jsonb_build_object('kind',p.kind,'at',p.occurred_at) FROM app_private.email_protection_events p WHERE p.workspace_id=p_workspace
   AND p.kind IN('slowed','paused','switched_off','sample_held','recovered','lifted','reinstated','sample_released','sample_passed') ORDER BY p.occurred_at DESC,p.id DESC LIMIT 1),
  'liveDay',(SELECT count(*) FROM app_private.email_send_events e WHERE e.workspace_id=p_workspace AND e.kind='send' AND e.purpose='live'
   AND e.state IN('reserved','accepted') AND e.occurred_at>clock_timestamp()-interval '24 hours'),
  'liveHour',(SELECT count(*) FROM app_private.email_send_events e WHERE e.workspace_id=p_workspace AND e.kind='send' AND e.purpose='live'
   AND e.state IN('reserved','accepted') AND e.occurred_at>clock_timestamp()-interval '60 minutes'));
END $f$;

-- The counts of every business, and the account row, for the evaluator and the account trip-wire.
CREATE FUNCTION app_private.email_protection_numbers() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE a app_private.email_account_protection%ROWTYPE;
BEGIN
 IF session_user<>'r72_identity_command' THEN RAISE EXCEPTION 'Email connection boundary required' USING ERRCODE='42501'; END IF;
 SELECT * INTO a FROM app_private.email_account_protection x WHERE x.id;
 RETURN jsonb_build_object('account',jsonb_build_object('state',a.state,'reason',a.reason,'since',a.since,'countedSince',a.counted_since,'rowVersion',a.row_version,
   'sends7',(SELECT count(*) FROM app_private.email_send_events e WHERE e.kind='send' AND e.state IN('reserved','accepted')
     AND e.occurred_at>=greatest(clock_timestamp()-interval '7 days',coalesce(a.counted_since,'-infinity'))),
   'bounces7',(SELECT count(*) FROM app_private.email_send_events e WHERE e.kind IN('hard_bounce','soft_bounce')
     AND e.occurred_at>=greatest(clock_timestamp()-interval '7 days',coalesce(a.counted_since,'-infinity'))),
   'sends30',(SELECT count(*) FROM app_private.email_send_events e WHERE e.kind='send' AND e.state IN('reserved','accepted')
     AND e.occurred_at>=greatest(clock_timestamp()-interval '30 days',coalesce(a.counted_since,'-infinity'))),
   'complaints30',(SELECT count(*) FROM app_private.email_send_events e WHERE e.kind='complaint'
     AND e.occurred_at>=greatest(clock_timestamp()-interval '30 days',coalesce(a.counted_since,'-infinity')))),
  'businesses',coalesce((SELECT jsonb_agg(app_private.email_protection_counts(c.workspace_id)||jsonb_build_object('businessName',s.business_name) ORDER BY c.workspace_id)
   FROM app_private.email_connections c LEFT JOIN app_private.email_sending_controls s ON s.workspace_id=c.workspace_id),'[]'::jsonb));
END $f$;

-- One automatic protection step (the evaluator, on every relevant event and on a timer). Compare-and-set on the state
-- the evaluator read (p_from): another instance that got there first makes this 'stale'. A system step may only move
-- UP the ladder or recover slowed -> ok; p_cause 'own' (the business's own numbers) or 'account' (the trip-wire). A
-- second OWN pause within 90 days becomes 'off' here. Also stores the caps, the warm-up step and the sample verdict.
-- Answers the state now in force, 'unchanged', 'stale' or 'refused'.
CREATE FUNCTION app_private.email_protection_apply(p_workspace uuid,p_from text,p_to text,p_kind text,p_cause text,p_reason text,p_numbers jsonb,
 p_daily integer,p_hourly integer,p_step integer,p_step_at timestamptz,p_sample text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE c app_private.email_connections%ROWTYPE; s app_private.email_sending_controls%ROWTYPE; v_to text:=p_to; v_kind text:=p_kind; v_prior timestamptz;
 v_numbers jsonb:=coalesce(p_numbers,'{}'::jsonb);
BEGIN
 IF session_user<>'r72_identity_command' THEN RAISE EXCEPTION 'Email connection boundary required' USING ERRCODE='42501'; END IF;
 IF p_from IS NULL OR p_to IS NULL OR p_from NOT IN('ok','slowed','paused','off') OR p_to NOT IN('ok','slowed','paused','off')
  OR (p_cause IS NOT NULL AND p_cause NOT IN('own','account')) OR (p_kind IS NOT NULL AND p_kind!~'^[a-z][a-z0-9_]{0,39}$')
  OR p_daily IS NULL OR p_hourly IS NULL OR p_daily<0 OR p_hourly<0 OR p_daily>100000 OR p_hourly>p_daily+1
  OR (p_step IS NOT NULL AND p_step NOT BETWEEN 0 AND 5) OR (p_sample IS NOT NULL AND p_sample NOT IN('passed','held'))
  OR jsonb_typeof(v_numbers)<>'object' THEN RAISE EXCEPTION 'Invalid protection step' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('email-sending:'||p_workspace::text,156));
 SELECT * INTO c FROM app_private.email_connections x WHERE x.workspace_id=p_workspace FOR UPDATE;
 IF NOT FOUND THEN RETURN 'refused'; END IF;
 IF c.protection_state<>p_from THEN RETURN 'stale'; END IF;
 -- Up the ladder, or slowed back to ok. Never down from paused or off: only the founder does that.
 IF NOT (p_from=p_to OR (p_from='ok' AND p_to IN('slowed','paused','off')) OR (p_from='slowed' AND p_to IN('ok','paused','off'))) THEN RETURN 'refused'; END IF;
 s:=app_private.email_sending_controls_row(p_workspace);
 IF p_sample='held' AND s.sample_state NOT IN('sending','waiting') THEN RETURN 'stale'; END IF;
 IF p_sample='passed' AND s.sample_state<>'waiting' THEN RETURN 'stale'; END IF;
 IF v_to='paused' AND p_from<>'paused' AND coalesce(p_cause,'own')='own' THEN
  SELECT max(p.occurred_at) INTO v_prior FROM app_private.email_protection_events p WHERE p.workspace_id=p_workspace AND p.kind='paused'
   AND p.numbers->>'cause'='own' AND p.occurred_at>clock_timestamp()-interval '90 days';
  IF v_prior IS NOT NULL THEN v_to:='off'; v_kind:='switched_off'; v_numbers:=v_numbers||jsonb_build_object('previousPauseAt',v_prior); END IF;
 END IF;
 UPDATE app_private.email_connections SET protection_state=v_to,
  protection_reason=CASE WHEN v_to=p_from THEN c.protection_reason WHEN v_to='ok' THEN NULL ELSE left(coalesce(nullif(p_reason,''),c.protection_reason),300) END,
  protection_since=CASE WHEN v_to=p_from THEN c.protection_since WHEN v_to='ok' THEN NULL ELSE clock_timestamp() END,
  daily_cap=CASE WHEN v_to IN('paused','off') THEN 0 ELSE p_daily END,hourly_cap=CASE WHEN v_to IN('paused','off') THEN 0 ELSE p_hourly END,
  row_version=c.row_version+1,updated_at=clock_timestamp() WHERE workspace_id=p_workspace;
 UPDATE app_private.email_sending_controls SET warmup_step=coalesce(p_step,s.warmup_step),warmup_step_at=coalesce(p_step_at,s.warmup_step_at),
  sample_state=coalesce(p_sample,s.sample_state),row_version=s.row_version+1,updated_at=clock_timestamp() WHERE workspace_id=p_workspace;
 IF v_kind IS NOT NULL THEN
  v_numbers:=v_numbers||jsonb_build_object('cause',coalesce(p_cause,'own'),'from',p_from,'to',v_to);
  PERFORM app_private.email_protection_note(p_workspace,v_kind,v_numbers,NULL,
   v_kind IN('slowed','paused','switched_off','sample_held'),v_kind IN('paused','switched_off'));
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

-- The owner's own commands. p_action: 'test' or 'live' (the mode), 'pause' or 'resume' (the owner's own pause, which
-- never lifts a protection pause). For 'live' the first time, every condition is checked and the founder is asked:
-- answers 'requested' (or 'already_requested'); once the founder has approved, 'live'. Other answers say what is
-- missing: 'not_connected', 'switched_off', 'paused', 'needs_webhook', 'needs_terms', 'needs_footer', 'needs_test'.
-- p_webhook_ok is the application's own fresh check with Postmark that the bounce webhook is there and verified.
CREATE FUNCTION app_private.email_sending_command(p_session bytea,p_workspace uuid,p_action text,p_terms text,p_webhook_ok boolean) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE actor uuid; c app_private.email_connections%ROWTYPE; s app_private.email_sending_controls%ROWTYPE;
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
 IF c.mode='live' THEN RETURN 'unchanged'; END IF;
 IF c.protection_state='paused' THEN RETURN 'paused'; END IF;
 IF p_webhook_ok IS NOT TRUE OR c.webhook_id IS NULL THEN RETURN 'needs_webhook'; END IF;
 IF p_terms IS NULL OR c.terms_version IS DISTINCT FROM p_terms THEN RETURN 'needs_terms'; END IF;
 IF s.business_name IS NULL OR s.postal_address IS NULL THEN RETURN 'needs_footer'; END IF;
 IF s.test_passed_at IS NULL OR s.test_passed_at<c.verified_at THEN RETURN 'needs_test'; END IF;
 IF c.go_live_approved_at IS NULL THEN
  IF s.go_live_requested_at IS NOT NULL THEN RETURN 'already_requested'; END IF;
  UPDATE app_private.email_sending_controls SET go_live_requested_at=clock_timestamp(),go_live_requested_by=actor,row_version=s.row_version+1,updated_at=clock_timestamp()
  WHERE workspace_id=p_workspace;
  PERFORM app_private.email_protection_note(p_workspace,'go_live_requested','{}'::jsonb,actor,false,true);
  RETURN 'requested';
 END IF;
 UPDATE app_private.email_connections SET mode='live',row_version=c.row_version+1,updated_at=clock_timestamp() WHERE workspace_id=p_workspace;
 PERFORM app_private.email_protection_note(p_workspace,'mode_live','{}'::jsonb,actor,false,false);
 RETURN 'live';
END $f$;

-- "Send a test to me": reserves one test send (as email_send_reserve 'test' does) for the owner's session.
CREATE FUNCTION app_private.email_sending_test_reserve(p_session bytea,p_workspace uuid,p_key text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
BEGIN
 IF session_user<>'r72_identity_command' THEN RAISE EXCEPTION 'Email connection boundary required' USING ERRCODE='42501'; END IF;
 PERFORM app_private.email_connection_owner(p_session,p_workspace);
 RETURN app_private.email_send_reserve(p_workspace,p_key,'test');
END $f$;

-- The result of "Send a test to me": accepted by Postmark (the test counts as passed), or released.
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

-- The founder's read: every business that has a connection, with its state, the numbers of its last protection step
-- and whether it waits for approval, and the account row. Refuses anyone the founder check does not accept.
CREATE FUNCTION app_private.email_protection_founder_view(p_session bytea) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE actor uuid;
BEGIN
 IF session_user<>'r72_identity_command' THEN RAISE EXCEPTION 'Email connection boundary required' USING ERRCODE='42501'; END IF;
 actor:=app_private.email_protection_founder(p_session);
 IF actor IS NULL THEN RAISE EXCEPTION 'Founder required' USING ERRCODE='42501'; END IF;
 RETURN app_private.email_protection_status();
END $f$;

-- The same picture without a session, for the signed Group HQ read (it authenticates the founder itself).
CREATE FUNCTION app_private.email_protection_status() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE a app_private.email_account_protection%ROWTYPE;
BEGIN
 IF session_user<>'r72_identity_command' THEN RAISE EXCEPTION 'Email connection boundary required' USING ERRCODE='42501'; END IF;
 SELECT * INTO a FROM app_private.email_account_protection x WHERE x.id;
 RETURN jsonb_build_object('account',jsonb_build_object('state',a.state,'reason',a.reason,'since',a.since,'rowVersion',a.row_version,
   'numbers',(SELECT e.numbers FROM app_private.email_account_events e WHERE e.kind='account_held' ORDER BY e.occurred_at DESC,e.id DESC LIMIT 1)),
  'businesses',coalesce((SELECT jsonb_agg(jsonb_build_object('workspaceId',c.workspace_id,'businessName',coalesce(s.business_name,c.from_name),'status',c.status,'mode',c.mode,
    'state',c.protection_state,'reason',c.protection_reason,'since',c.protection_since,'rowVersion',c.row_version,
    'goLiveRequestedAt',s.go_live_requested_at,'goLiveApprovedAt',c.go_live_approved_at,'sampleState',coalesce(s.sample_state,'none'),
    'counts',app_private.email_protection_counts(c.workspace_id),
    'lastStep',(SELECT p.numbers||jsonb_build_object('kind',p.kind,'at',p.occurred_at) FROM app_private.email_protection_events p WHERE p.workspace_id=c.workspace_id
      AND p.kind IN('slowed','paused','switched_off','sample_held','recovered','lifted','reinstated','sample_released') ORDER BY p.occurred_at DESC,p.id DESC LIMIT 1))
    ORDER BY c.workspace_id)
   FROM app_private.email_connections c LEFT JOIN app_private.email_sending_controls s ON s.workspace_id=c.workspace_id),'[]'::jsonb));
END $f$;

-- The founder's buttons, each recorded with who pressed it. p_action: 'approve' (a first go-live the owner asked for:
-- every condition was checked when it was asked; the connection must still be verified and not paused or off),
-- 'lift' (a pause), 'reinstate' (a business that was switched off), 'release_sample' (a held sample), 'lift_account'
-- (the account hold; p_workspace NULL). p_version is the row version the founder was shown (a stale page changes
-- nothing). A lift or reinstate starts a new sample and only counts what happens from now on; the business restarts
-- slowed and recovers by itself. Answers 'done', 'stale' or 'not_needed'.
CREATE FUNCTION app_private.email_protection_founder_act(p_session bytea,p_workspace uuid,p_action text,p_version bigint) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE actor uuid; c app_private.email_connections%ROWTYPE; s app_private.email_sending_controls%ROWTYPE; a app_private.email_account_protection%ROWTYPE;
 counts jsonb;
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
  UPDATE app_private.email_account_protection SET state='ok',reason=NULL,since=NULL,counted_since=clock_timestamp(),row_version=a.row_version+1,updated_at=clock_timestamp() WHERE id;
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
  IF c.go_live_approved_at IS NOT NULL OR s.go_live_requested_at IS NULL THEN RETURN 'not_needed'; END IF;
  IF c.status<>'verified' OR c.protection_state IN('paused','off') THEN RETURN 'stale'; END IF;
  UPDATE app_private.email_connections SET go_live_approved_by=actor,go_live_approved_at=clock_timestamp(),mode='live',
   warmup_started_at=coalesce(c.warmup_started_at,clock_timestamp()),daily_cap=50,hourly_cap=13,row_version=c.row_version+1,updated_at=clock_timestamp() WHERE workspace_id=p_workspace;
  UPDATE app_private.email_sending_controls SET warmup_step=0,warmup_step_at=clock_timestamp(),sample_state='sending',sample_started_at=clock_timestamp(),sample_full_at=NULL,
   row_version=s.row_version+1,updated_at=clock_timestamp() WHERE workspace_id=p_workspace;
  PERFORM app_private.email_protection_note(p_workspace,'go_live_approved',jsonb_build_object('dailyCap',50,'hourlyCap',13),actor,true,false);
  RETURN 'done';
 ELSIF p_action IN('lift','reinstate') THEN
  IF c.protection_state<>(CASE p_action WHEN 'lift' THEN 'paused' ELSE 'off' END) THEN RETURN 'not_needed'; END IF;
  UPDATE app_private.email_connections SET protection_state='slowed',protection_reason=CASE p_action WHEN 'lift' THEN 'Restarted after a pause.' ELSE 'Switched back on after a review.' END,
   protection_since=clock_timestamp(),row_version=c.row_version+1,updated_at=clock_timestamp() WHERE workspace_id=p_workspace;
  UPDATE app_private.email_sending_controls SET counted_since=clock_timestamp(),warmup_step_at=clock_timestamp(),sample_state='sending',sample_started_at=clock_timestamp(),sample_full_at=NULL,
   row_version=s.row_version+1,updated_at=clock_timestamp() WHERE workspace_id=p_workspace;
  PERFORM app_private.email_protection_note(p_workspace,CASE p_action WHEN 'lift' THEN 'lifted' ELSE 'reinstated' END,
   coalesce(counts,'{}'::jsonb)-'workspaceId'-'status'-'mode'-'reason'-'now'-'since'-'countedSince'-'warmupStartedAt'-'goLiveApprovedAt'-'warmupStepAt'-'sampleStartedAt'-'sampleFullAt'-'ownerPausedAt'
    ||jsonb_build_object('previousState',c.protection_state),actor,true,false);
  RETURN 'done';
 ELSE
  IF s.sample_state<>'held' THEN RETURN 'not_needed'; END IF;
  UPDATE app_private.email_sending_controls SET sample_state='sending',sample_started_at=clock_timestamp(),sample_full_at=NULL,row_version=s.row_version+1,updated_at=clock_timestamp()
  WHERE workspace_id=p_workspace;
  UPDATE app_private.email_connections SET row_version=c.row_version+1,updated_at=clock_timestamp() WHERE workspace_id=p_workspace;
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

REVOKE ALL ON FUNCTION app_private.email_sending_controls_row(uuid),
 app_private.email_protection_note(uuid,text,jsonb,uuid,boolean,boolean),
 app_private.email_protection_counts(uuid),
 app_private.email_sending_state(bytea,uuid),
 app_private.email_sending_details(bytea,uuid,text,text,text[]),
 app_private.email_send_reserve(uuid,text,text),
 app_private.email_send_settle(uuid,text,boolean),
 app_private.email_counter_record(uuid,text,text,timestamptz),
 app_private.email_sending_config(uuid),
 app_private.email_protection_numbers(),
 app_private.email_protection_apply(uuid,text,text,text,text,text,jsonb,integer,integer,integer,timestamptz,text),
 app_private.email_account_apply(text,text,text,jsonb),
 app_private.email_sending_command(bytea,uuid,text,text,boolean),
 app_private.email_sending_test_reserve(bytea,uuid,text),
 app_private.email_sending_test_result(bytea,uuid,text,boolean),
 app_private.email_protection_founder_view(bytea),
 app_private.email_protection_status(),
 app_private.email_protection_founder_act(bytea,uuid,text,bigint),
 app_private.email_protection_alerts_claim(integer),
 app_private.email_protection_alert_done(uuid,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.email_sending_state(bytea,uuid),
 app_private.email_sending_details(bytea,uuid,text,text,text[]),
 app_private.email_send_reserve(uuid,text,text),
 app_private.email_send_settle(uuid,text,boolean),
 app_private.email_counter_record(uuid,text,text,timestamptz),
 app_private.email_sending_config(uuid),
 app_private.email_protection_numbers(),
 app_private.email_protection_apply(uuid,text,text,text,text,text,jsonb,integer,integer,integer,timestamptz,text),
 app_private.email_account_apply(text,text,text,jsonb),
 app_private.email_sending_command(bytea,uuid,text,text,boolean),
 app_private.email_sending_test_reserve(bytea,uuid,text),
 app_private.email_sending_test_result(bytea,uuid,text,boolean),
 app_private.email_protection_founder_view(bytea),
 app_private.email_protection_status(),
 app_private.email_protection_founder_act(bytea,uuid,text,bigint),
 app_private.email_protection_alerts_claim(integer),
 app_private.email_protection_alert_done(uuid,boolean) TO r72_identity_command;

RESET ROLE;
SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private FROM r72_email_connection_definer;
RESET ROLE;
