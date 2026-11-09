-- MHP-GROWTH-001. Public prospect capture, member stories, a leased marketing
-- send queue and course-lesson progress. Function-only access; no table grants
-- to any runtime login role.
DO $role$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='r72_mhp_prospect_definer') THEN CREATE ROLE r72_mhp_prospect_definer NOLOGIN NOINHERIT; END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='r72_mhp_prospect_definer' AND (rolcanlogin OR rolinherit OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)) THEN RAISE EXCEPTION 'Unsafe MHP prospect definer role'; END IF;
 IF EXISTS(SELECT 1 FROM pg_auth_members m JOIN pg_roles child ON child.oid=m.member WHERE child.rolname='r72_mhp_prospect_definer') THEN RAISE EXCEPTION 'MHP prospect definer must not inherit another role'; END IF;
 IF EXISTS(SELECT 1 FROM pg_auth_members m JOIN pg_roles parent ON parent.oid=m.roleid JOIN pg_roles child ON child.oid=m.member WHERE parent.rolname='r72_mhp_prospect_definer' AND child.rolname NOT IN ('r72_owner',current_user)) THEN RAISE EXCEPTION 'Unexpected MHP prospect definer member'; END IF;
 GRANT r72_mhp_prospect_definer TO r72_owner;
 EXECUTE format('GRANT r72_mhp_prospect_definer TO %I',current_user);
END $role$;
SET LOCAL ROLE r72_owner;
GRANT USAGE ON SCHEMA app,app_private TO r72_mhp_prospect_definer;

CREATE TABLE app_private.mhp_prospects (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 email citext NOT NULL UNIQUE CHECK(email::text=lower(btrim(email::text)) AND length(email::text) BETWEEN 3 AND 320 AND email::text ~ '^[^[:space:]@<>]+@[^[:space:]@<>]+\.[^[:space:]@<>]+$'),
 first_name text CHECK(first_name IS NULL OR length(btrim(first_name)) BETWEEN 1 AND 100),
 level text CHECK(level IN('L1','L2','L3')),
 marketing_consent boolean NOT NULL DEFAULT false,
 consent_version text CHECK(consent_version IS NULL OR length(consent_version) BETWEEN 1 AND 40),
 consent_at timestamptz,
 unsubscribed_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK((consent_at IS NULL)=(consent_version IS NULL))
);
CREATE UNIQUE INDEX mhp_prospects_email_text_idx ON app_private.mhp_prospects((email::text));
CREATE TABLE app_private.mhp_prospect_signups (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 prospect_id uuid NOT NULL REFERENCES app_private.mhp_prospects(id) ON DELETE CASCADE,
 kind text NOT NULL CHECK(kind IN('sheet','webinar','waitlist')),
 label text NOT NULL CHECK(length(label) BETWEEN 1 AND 200),
 module text CHECK(module IS NULL OR length(module) BETWEEN 1 AND 40),
 link text CHECK(link IS NULL OR (length(link)<=500 AND link ~ '^https://martinhowardproperty[.]co[.]uk/')),
 consent_given boolean NOT NULL,
 consent_version text NOT NULL CHECK(length(consent_version) BETWEEN 1 AND 40),
 source_hash bytea CHECK(source_hash IS NULL OR octet_length(source_hash)=32),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX mhp_prospect_signups_prospect_idx ON app_private.mhp_prospect_signups(prospect_id,created_at);
CREATE INDEX mhp_prospect_signups_kind_idx ON app_private.mhp_prospect_signups(kind,created_at);
CREATE TABLE app_private.mhp_marketing_sends (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 prospect_id uuid NOT NULL REFERENCES app_private.mhp_prospects(id) ON DELETE CASCADE,
 template_key text NOT NULL CHECK(template_key ~ '^[a-z0-9_]{1,40}$'),
 campaign_key text NOT NULL CHECK(campaign_key ~ '^[a-z0-9_-]{1,60}$'),
 context jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(context)='object' AND octet_length(context::text)<=4000),
 due_at timestamptz NOT NULL,
 expires_at timestamptz NOT NULL,
 lease_until timestamptz,
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 10),
 sent_at timestamptz,
 provider_reference text CHECK(provider_reference IS NULL OR length(provider_reference) BETWEEN 1 AND 200),
 cancelled_at timestamptz,
 failed_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(prospect_id,template_key,campaign_key),
 CHECK(sent_at IS NULL OR provider_reference IS NOT NULL),
 CHECK(expires_at>due_at)
);
CREATE INDEX mhp_marketing_sends_due_idx ON app_private.mhp_marketing_sends(due_at) WHERE sent_at IS NULL AND cancelled_at IS NULL AND failed_at IS NULL;
CREATE TABLE app_private.mhp_member_stories (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 120),
 town text NOT NULL CHECK(length(btrim(town)) BETWEEN 1 AND 120),
 email citext NOT NULL CHECK(email::text=lower(btrim(email::text)) AND length(email::text) BETWEEN 3 AND 320),
 door text NOT NULL CHECK(door IN('Refer','Source','Run','Own','Not sure yet')),
 what_you_did text NOT NULL CHECK(length(btrim(what_you_did)) BETWEEN 40 AND 4000),
 before_text text NOT NULL CHECK(length(btrim(before_text)) BETWEEN 1 AND 4000),
 what_changed text NOT NULL CHECK(length(btrim(what_changed)) BETWEEN 1 AND 4000),
 number_text text NOT NULL CHECK(length(btrim(number_text)) BETWEEN 1 AND 200 AND number_text !~ '£'),
 happened_month text NOT NULL CHECK(happened_month ~ '^20[0-9]{2}-(0[1-9]|1[0-2])$'),
 publish_name text NOT NULL CHECK(publish_name IN('Yes, first name and town','First name only','No, keep me anonymous')),
 publish_door text NOT NULL CHECK(publish_door IN('Yes','No')),
 do_not_say text CHECK(do_not_say IS NULL OR length(do_not_say)<=2000),
 consent_version text NOT NULL CHECK(length(consent_version) BETWEEN 1 AND 40),
 source_hash bytea CHECK(source_hash IS NULL OR octet_length(source_hash)=32),
 status text NOT NULL DEFAULT 'received' CHECK(status IN('received','drafted','approved','published','withdrawn')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE app_private.mhp_lesson_progress (
 user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
 lesson_key text NOT NULL CHECK(lesson_key ~ '^[0-9]{2}/[0-9]{2}$'),
 task_done_at timestamptz,
 completed_at timestamptz,
 notes text CHECK(notes IS NULL OR length(notes)<=10000),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(user_id,lesson_key),
 CHECK(completed_at IS NULL OR task_done_at IS NOT NULL)
);
-- Paid course text lives here, not in the public repository. Loaded by the
-- programme owner through /hq/course; released only by mhp_course_* functions.
CREATE TABLE app_private.mhp_course_modules (
 number text PRIMARY KEY CHECK(number ~ '^[0-9]{2}$'),
 slug text NOT NULL CHECK(slug ~ '^[a-z0-9-]{1,80}$'),
 title text NOT NULL CHECK(length(btrim(title)) BETWEEN 1 AND 200),
 promise text CHECK(promise IS NULL OR length(promise)<=2000),
 door text CHECK(door IS NULL OR length(door)<=40),
 level text CHECK(level IS NULL OR level IN('L1','L2','L3')),
 overview_md text NOT NULL DEFAULT '' CHECK(length(overview_md)<=200000),
 sources_md text NOT NULL DEFAULT '' CHECK(length(sources_md)<=200000),
 loaded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE app_private.mhp_course_lessons (
 lesson_key text PRIMARY KEY CHECK(lesson_key ~ '^[0-9]{2}/[0-9]{2}$'),
 module_number text NOT NULL REFERENCES app_private.mhp_course_modules(number) ON DELETE CASCADE,
 position integer NOT NULL CHECK(position BETWEEN 1 AND 99),
 slug text NOT NULL CHECK(slug ~ '^[a-z0-9-]{1,80}$'),
 title text NOT NULL CHECK(length(btrim(title)) BETWEEN 1 AND 200),
 minutes integer CHECK(minutes IS NULL OR minutes BETWEEN 1 AND 240),
 task text CHECK(task IS NULL OR length(task)<=2000),
 body_md text NOT NULL CHECK(length(body_md) BETWEEN 1 AND 300000),
 CHECK(left(lesson_key,2)=module_number AND right(lesson_key,2)=lpad(position::text,2,'0'))
);
DO $security$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['mhp_prospects','mhp_prospect_signups','mhp_marketing_sends','mhp_member_stories','mhp_lesson_progress','mhp_course_modules','mhp_course_lessons'] LOOP
  EXECUTE format('ALTER TABLE app_private.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE app_private.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY mhp_growth_owner ON app_private.%I TO r72_owner USING(true) WITH CHECK(true)',t);
  EXECUTE format('CREATE POLICY mhp_growth_definer ON app_private.%I TO r72_mhp_prospect_definer USING(true) WITH CHECK(true)',t);
  EXECUTE format('REVOKE ALL ON app_private.%I FROM PUBLIC',t);
  EXECUTE format('GRANT SELECT,INSERT,UPDATE ON app_private.%I TO r72_mhp_prospect_definer',t);
  IF t LIKE 'mhp_course_%' THEN EXECUTE format('GRANT DELETE ON app_private.%I TO r72_mhp_prospect_definer',t); END IF;
 END LOOP;
END $security$;
GRANT SELECT ON app.users,app.user_sessions,app.entitlements,app.products TO r72_mhp_prospect_definer;
CREATE POLICY mhp_growth_users ON app.users FOR SELECT TO r72_mhp_prospect_definer USING(true);
CREATE POLICY mhp_growth_sessions ON app.user_sessions FOR SELECT TO r72_mhp_prospect_definer USING(product_audience='martin_howard_property');
DO $policies$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='app' AND c.relname='entitlements' AND c.relrowsecurity) THEN
  CREATE POLICY mhp_growth_entitlements ON app.entitlements FOR SELECT TO r72_mhp_prospect_definer USING(true);
 END IF;
 IF EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='app' AND c.relname='products' AND c.relrowsecurity) THEN
  CREATE POLICY mhp_growth_products ON app.products FOR SELECT TO r72_mhp_prospect_definer USING(brand='martin_howard_property');
 END IF;
END $policies$;
GRANT EXECUTE ON FUNCTION app_private.resolve_session(bytea),app_private.mhp_is_programme_admin(uuid) TO r72_mhp_prospect_definer;
GRANT CREATE ON SCHEMA app_private TO r72_mhp_prospect_definer;
RESET ROLE;

SET LOCAL ROLE r72_mhp_prospect_definer;
-- Capture one public sign-up. Requested deliveries are queued idempotently;
-- an unsubscribed address is recorded but never re-queued without fresh consent.
CREATE FUNCTION app_private.mhp_capture_signup(p_email text,p_first_name text,p_level text,p_consent boolean,p_consent_version text,
 p_kind text,p_label text,p_module text,p_link text,p_source_hash bytea,p_schedule jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE prospect app_private.mhp_prospects%ROWTYPE; created boolean:=false; item jsonb; queued integer:=0;
BEGIN
 IF p_email IS NULL OR p_email<>lower(btrim(p_email)) OR length(p_email)>320 OR p_email!~'^[^[:space:]@<>]+@[^[:space:]@<>]+\.[^[:space:]@<>]+$'
  OR p_consent IS NULL OR p_consent_version IS NULL OR length(p_consent_version) NOT BETWEEN 1 AND 40
  OR p_kind IS NULL OR p_kind NOT IN('sheet','webinar','waitlist') OR p_label IS NULL OR length(btrim(p_label)) NOT BETWEEN 1 AND 200
  OR (p_level IS NOT NULL AND p_level NOT IN('L1','L2','L3'))
  OR p_schedule IS NULL OR jsonb_typeof(p_schedule)<>'array' OR jsonb_array_length(p_schedule)>8 THEN
  RAISE EXCEPTION 'Invalid sign-up' USING ERRCODE='22023';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_email,121));
 SELECT * INTO prospect FROM app_private.mhp_prospects WHERE email::text=p_email FOR UPDATE;
 IF NOT FOUND THEN
  INSERT INTO app_private.mhp_prospects(email,first_name,level,marketing_consent,consent_version,consent_at)
  VALUES(p_email,NULLIF(btrim(p_first_name),''),p_level,p_consent,CASE WHEN p_consent THEN p_consent_version END,CASE WHEN p_consent THEN clock_timestamp() END)
  RETURNING * INTO prospect;
  created:=true;
 ELSE
  UPDATE app_private.mhp_prospects SET
   first_name=COALESCE(NULLIF(btrim(p_first_name),''),first_name),
   level=COALESCE(p_level,level),
   marketing_consent=marketing_consent OR p_consent,
   consent_version=CASE WHEN p_consent THEN p_consent_version ELSE consent_version END,
   consent_at=CASE WHEN p_consent THEN clock_timestamp() ELSE consent_at END,
   unsubscribed_at=CASE WHEN p_consent THEN NULL ELSE unsubscribed_at END,
   updated_at=clock_timestamp()
  WHERE id=prospect.id RETURNING * INTO prospect;
 END IF;
 INSERT INTO app_private.mhp_prospect_signups(prospect_id,kind,label,module,link,consent_given,consent_version,source_hash)
 VALUES(prospect.id,p_kind,btrim(p_label),NULLIF(btrim(p_module),''),NULLIF(btrim(p_link),''),p_consent,p_consent_version,p_source_hash);
 IF prospect.unsubscribed_at IS NULL THEN
  FOR item IN SELECT value FROM jsonb_array_elements(p_schedule) LOOP
   IF jsonb_typeof(item)<>'object' OR (item->>'template') !~ '^[a-z0-9_]{1,40}$' OR (item->>'campaign') !~ '^[a-z0-9_-]{1,60}$'
    OR (item->>'dueAt') IS NULL OR (item->>'expiresAt') IS NULL THEN RAISE EXCEPTION 'Invalid schedule' USING ERRCODE='22023'; END IF;
   INSERT INTO app_private.mhp_marketing_sends(prospect_id,template_key,campaign_key,context,due_at,expires_at)
   VALUES(prospect.id,item->>'template',item->>'campaign',COALESCE(item->'context','{}'::jsonb),(item->>'dueAt')::timestamptz,(item->>'expiresAt')::timestamptz)
   ON CONFLICT(prospect_id,template_key,campaign_key) DO UPDATE SET
    -- A fresh sign-up after an unsubscribe revives emails that were cancelled, never ones already sent.
    cancelled_at=NULL,failed_at=NULL,attempts=0,lease_until=NULL,due_at=EXCLUDED.due_at,expires_at=EXCLUDED.expires_at,context=EXCLUDED.context
   WHERE app_private.mhp_marketing_sends.sent_at IS NULL AND app_private.mhp_marketing_sends.cancelled_at IS NOT NULL;
   IF FOUND THEN queued:=queued+1; END IF;
  END LOOP;
 END IF;
 RETURN jsonb_build_object('prospectId',prospect.id,'created',created,'queued',queued,'unsubscribed',prospect.unsubscribed_at IS NOT NULL);
END $f$;

CREATE FUNCTION app_private.mhp_record_story(p_name text,p_town text,p_email text,p_door text,p_did text,p_before text,p_changed text,
 p_number text,p_month text,p_publish_name text,p_publish_door text,p_do_not_say text,p_consent_version text,p_source_hash bytea) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE story uuid;
BEGIN
 INSERT INTO app_private.mhp_member_stories(name,town,email,door,what_you_did,before_text,what_changed,number_text,happened_month,
  publish_name,publish_door,do_not_say,consent_version,source_hash)
 VALUES(btrim(p_name),btrim(p_town),lower(btrim(p_email)),p_door,btrim(p_did),btrim(p_before),btrim(p_changed),btrim(p_number),p_month,
  p_publish_name,p_publish_door,NULLIF(btrim(p_do_not_say),''),p_consent_version,p_source_hash)
 RETURNING id INTO story;
 RETURN story;
END $f$;

-- Lease a bounded batch. A crash after provider acceptance can retry once the
-- lease expires: delivery is at-least-once, keyed by the send id.
-- p_only_emails limits delivery to named inboxes (test mode); NULL means everyone.
CREATE FUNCTION app_private.mhp_claim_marketing_sends(p_limit integer,p_lease_seconds integer,p_only_emails text[]) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE claimed jsonb;
BEGIN
 IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 50 OR p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 30 AND 900 THEN
  RAISE EXCEPTION 'Invalid claim' USING ERRCODE='22023'; END IF;
 IF p_only_emails IS NOT NULL AND (cardinality(p_only_emails) NOT BETWEEN 1 AND 20) THEN RAISE EXCEPTION 'Invalid claim' USING ERRCODE='22023'; END IF;
 -- A reminder that missed its moment is never sent late.
 UPDATE app_private.mhp_marketing_sends s SET cancelled_at=clock_timestamp()
 WHERE s.sent_at IS NULL AND s.cancelled_at IS NULL AND s.failed_at IS NULL AND s.expires_at<=clock_timestamp()
  AND (s.lease_until IS NULL OR s.lease_until<clock_timestamp());
 UPDATE app_private.mhp_marketing_sends s SET failed_at=clock_timestamp()
 WHERE s.sent_at IS NULL AND s.cancelled_at IS NULL AND s.failed_at IS NULL AND s.attempts>=5 AND (s.lease_until IS NULL OR s.lease_until<clock_timestamp());
 UPDATE app_private.mhp_marketing_sends s SET cancelled_at=clock_timestamp()
 FROM app_private.mhp_prospects p
 WHERE p.id=s.prospect_id AND p.unsubscribed_at IS NOT NULL AND s.sent_at IS NULL AND s.cancelled_at IS NULL AND s.failed_at IS NULL;
 WITH due AS(
  SELECT s.id FROM app_private.mhp_marketing_sends s JOIN app_private.mhp_prospects p ON p.id=s.prospect_id
  WHERE s.sent_at IS NULL AND s.cancelled_at IS NULL AND s.failed_at IS NULL AND s.due_at<=clock_timestamp()
   AND s.expires_at>clock_timestamp() AND (s.lease_until IS NULL OR s.lease_until<clock_timestamp())
   AND (p_only_emails IS NULL OR p.email::text=ANY(p_only_emails))
  ORDER BY s.due_at,s.id LIMIT p_limit FOR UPDATE OF s SKIP LOCKED
 ), leased AS(
  UPDATE app_private.mhp_marketing_sends s SET lease_until=clock_timestamp()+make_interval(secs=>p_lease_seconds),attempts=s.attempts+1
  FROM due WHERE s.id=due.id RETURNING s.*
 )
 SELECT COALESCE(jsonb_agg(jsonb_build_object('id',l.id,'prospectId',p.id,'template',l.template_key,'campaign',l.campaign_key,
  'context',l.context,'email',p.email::text,'firstName',p.first_name,'level',p.level,'attempts',l.attempts,'expiresAt',l.expires_at) ORDER BY l.due_at),'[]'::jsonb)
 INTO claimed FROM leased l JOIN app_private.mhp_prospects p ON p.id=l.prospect_id;
 RETURN claimed;
END $f$;

CREATE FUNCTION app_private.mhp_settle_marketing_send(p_send uuid,p_accepted boolean,p_reference text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
BEGIN
 IF p_send IS NULL OR p_accepted IS NULL OR (p_accepted AND (p_reference IS NULL OR length(p_reference) NOT BETWEEN 1 AND 200)) THEN
  RAISE EXCEPTION 'Invalid settlement' USING ERRCODE='22023'; END IF;
 IF p_accepted THEN
  UPDATE app_private.mhp_marketing_sends SET sent_at=clock_timestamp(),provider_reference=p_reference,lease_until=NULL
  WHERE id=p_send AND sent_at IS NULL;
 ELSE
  -- Release the lease with backoff; the claim loop fails the send after five attempts.
  UPDATE app_private.mhp_marketing_sends SET lease_until=clock_timestamp()+make_interval(mins=>5*attempts)
  WHERE id=p_send AND sent_at IS NULL;
 END IF;
END $f$;

CREATE FUNCTION app_private.mhp_unsubscribe_prospect(p_prospect uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
BEGIN
 UPDATE app_private.mhp_prospects SET unsubscribed_at=COALESCE(unsubscribed_at,clock_timestamp()),marketing_consent=false,updated_at=clock_timestamp()
 WHERE id=p_prospect;
 IF NOT FOUND THEN RETURN false; END IF;
 UPDATE app_private.mhp_marketing_sends SET cancelled_at=clock_timestamp()
 WHERE prospect_id=p_prospect AND sent_at IS NULL AND cancelled_at IS NULL AND failed_at IS NULL;
 RETURN true;
END $f$;

-- Aggregate counts only, for the owner dashboard. No addresses leave here.
CREATE FUNCTION app_private.mhp_growth_summary(p_session bytea) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE actor uuid;
BEGIN
 SELECT s.user_id INTO actor FROM app_private.resolve_session(p_session) s JOIN app.user_sessions us ON us.id=s.session_id
 WHERE us.product_audience='martin_howard_property';
 IF actor IS NULL OR NOT app_private.mhp_is_programme_admin(actor) THEN RAISE EXCEPTION 'MHP administration required' USING ERRCODE='42501'; END IF;
 RETURN jsonb_build_object(
  'prospects',(SELECT count(*) FROM app_private.mhp_prospects),
  'unsubscribed',(SELECT count(*) FROM app_private.mhp_prospects WHERE unsubscribed_at IS NOT NULL),
  'signupsToday',(SELECT count(*) FROM app_private.mhp_prospect_signups WHERE created_at>=date_trunc('day',clock_timestamp())),
  'byKind',COALESCE((SELECT jsonb_object_agg(kind,n) FROM(SELECT kind,count(DISTINCT prospect_id) n FROM app_private.mhp_prospect_signups GROUP BY kind) k),'{}'::jsonb),
  'byLabel',COALESCE((SELECT jsonb_agg(jsonb_build_object('label',label,'count',n) ORDER BY n DESC) FROM(SELECT label,count(DISTINCT prospect_id) n FROM app_private.mhp_prospect_signups GROUP BY label ORDER BY n DESC LIMIT 30) l),'[]'::jsonb),
  'byLevel',COALESCE((SELECT jsonb_object_agg(COALESCE(level,'unknown'),n) FROM(SELECT level,count(*) n FROM app_private.mhp_prospects GROUP BY level) v),'{}'::jsonb),
  'sends',jsonb_build_object(
    'sent',(SELECT count(*) FROM app_private.mhp_marketing_sends WHERE sent_at IS NOT NULL),
    'pending',(SELECT count(*) FROM app_private.mhp_marketing_sends WHERE sent_at IS NULL AND cancelled_at IS NULL AND failed_at IS NULL),
    'failed',(SELECT count(*) FROM app_private.mhp_marketing_sends WHERE failed_at IS NOT NULL)),
  'stories',(SELECT count(*) FROM app_private.mhp_member_stories),
  'storiesWaiting',(SELECT count(*) FROM app_private.mhp_member_stories WHERE status='received'),
  'course',jsonb_build_object('modules',(SELECT count(*) FROM app_private.mhp_course_modules),'lessons',(SELECT count(*) FROM app_private.mhp_course_lessons),
    'loadedAt',(SELECT max(loaded_at) FROM app_private.mhp_course_modules)),
  'learners',(SELECT count(DISTINCT user_id) FROM app_private.mhp_lesson_progress),
  'lessonsCompleted',(SELECT count(*) FROM app_private.mhp_lesson_progress WHERE completed_at IS NOT NULL));
END $f$;

-- Learning access: 'full' for course, cohort or partnership entitlements and the
-- programme administrators; 'desk' for Deal Desk or membership-only access.
CREATE FUNCTION app_private.mhp_learning_tier(p_user uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
 SELECT CASE
  WHEN app_private.mhp_is_programme_admin(p_user) THEN 'full'
  WHEN EXISTS(SELECT 1 FROM app.entitlements e JOIN app.products p ON p.id=e.product_id
   WHERE e.account_id=p_user AND p.brand='martin_howard_property' AND p.type IN('course','cohort','partnership')
   AND e.starts_at<=clock_timestamp() AND (e.ends_at IS NULL OR e.ends_at>clock_timestamp() OR e.read_only_until>clock_timestamp())) THEN 'full'
  WHEN EXISTS(SELECT 1 FROM app.entitlements e JOIN app.products p ON p.id=e.product_id
   WHERE e.account_id=p_user AND p.brand='martin_howard_property'
   AND e.starts_at<=clock_timestamp() AND (e.ends_at IS NULL OR e.ends_at>clock_timestamp() OR e.read_only_until>clock_timestamp())) THEN 'desk'
  ELSE 'none' END
$f$;

CREATE FUNCTION app_private.mhp_learning_snapshot(p_session bytea) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE actor uuid;
BEGIN
 SELECT s.user_id INTO actor FROM app_private.resolve_session(p_session) s JOIN app.user_sessions us ON us.id=s.session_id
 WHERE us.product_audience='martin_howard_property';
 IF actor IS NULL THEN RAISE EXCEPTION 'MHP session required' USING ERRCODE='42501'; END IF;
 RETURN jsonb_build_object('userId',actor,'tier',app_private.mhp_learning_tier(actor),'isAdmin',app_private.mhp_is_programme_admin(actor),
  'progress',COALESCE((SELECT jsonb_object_agg(lesson_key,jsonb_build_object('taskDone',task_done_at IS NOT NULL,'completed',completed_at IS NOT NULL,'notes',COALESCE(notes,'')))
   FROM app_private.mhp_lesson_progress WHERE user_id=actor),'{}'::jsonb));
END $f$;

CREATE FUNCTION app_private.mhp_save_lesson_progress(p_session bytea,p_lesson text,p_task_done boolean,p_complete boolean,p_notes text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE actor uuid; tier text; row_out app_private.mhp_lesson_progress%ROWTYPE;
BEGIN
 SELECT s.user_id INTO actor FROM app_private.resolve_session(p_session) s JOIN app.user_sessions us ON us.id=s.session_id
 WHERE us.product_audience='martin_howard_property';
 IF actor IS NULL THEN RAISE EXCEPTION 'MHP session required' USING ERRCODE='42501'; END IF;
 tier:=app_private.mhp_learning_tier(actor);
 IF tier='none' THEN RAISE EXCEPTION 'Course access required' USING ERRCODE='42501'; END IF;
 IF p_lesson IS NULL OR p_lesson!~'^[0-9]{2}/[0-9]{2}$' OR p_task_done IS NULL OR p_complete IS NULL
  OR (p_complete AND NOT p_task_done) OR (p_notes IS NOT NULL AND length(p_notes)>10000) THEN
  RAISE EXCEPTION 'Invalid progress' USING ERRCODE='22023'; END IF;
 -- 'desk' members may only progress Module 0 and Module 1; the router enforces the same list.
 IF tier='desk' AND left(p_lesson,2) NOT IN('00','01') THEN RAISE EXCEPTION 'Course access required' USING ERRCODE='42501'; END IF;
 IF NOT EXISTS(SELECT 1 FROM app_private.mhp_course_lessons WHERE lesson_key=p_lesson) THEN RAISE EXCEPTION 'Unknown lesson' USING ERRCODE='22023'; END IF;
 INSERT INTO app_private.mhp_lesson_progress(user_id,lesson_key,task_done_at,completed_at,notes)
 VALUES(actor,p_lesson,CASE WHEN p_task_done THEN clock_timestamp() END,CASE WHEN p_complete THEN clock_timestamp() END,NULLIF(p_notes,''))
 ON CONFLICT(user_id,lesson_key) DO UPDATE SET
  task_done_at=CASE WHEN p_task_done THEN COALESCE(app_private.mhp_lesson_progress.task_done_at,clock_timestamp()) END,
  completed_at=CASE WHEN p_complete THEN COALESCE(app_private.mhp_lesson_progress.completed_at,clock_timestamp()) END,
  notes=NULLIF(p_notes,''),updated_at=clock_timestamp()
 RETURNING * INTO row_out;
 RETURN jsonb_build_object('taskDone',row_out.task_done_at IS NOT NULL,'completed',row_out.completed_at IS NOT NULL);
END $f$;

-- Outline for any signed-in member: titles, timings and tasks, never bodies.
CREATE FUNCTION app_private.mhp_course_outline(p_session bytea) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE actor uuid; tier text;
BEGIN
 SELECT s.user_id INTO actor FROM app_private.resolve_session(p_session) s JOIN app.user_sessions us ON us.id=s.session_id
 WHERE us.product_audience='martin_howard_property';
 IF actor IS NULL THEN RAISE EXCEPTION 'MHP session required' USING ERRCODE='42501'; END IF;
 tier:=app_private.mhp_learning_tier(actor);
 RETURN jsonb_build_object('tier',tier,'isAdmin',app_private.mhp_is_programme_admin(actor),
  'modules',COALESCE((SELECT jsonb_agg(jsonb_build_object('number',m.number,'slug',m.slug,'title',m.title,'promise',m.promise,'door',m.door,'level',m.level,
    'open',(tier='full' OR (tier='desk' AND m.number IN('00','01'))),
    'lessons',COALESCE((SELECT jsonb_agg(jsonb_build_object('key',l.lesson_key,'position',l.position,'slug',l.slug,'title',l.title,'minutes',l.minutes,'task',l.task) ORDER BY l.position)
      FROM app_private.mhp_course_lessons l WHERE l.module_number=m.number),'[]'::jsonb)) ORDER BY m.number) FROM app_private.mhp_course_modules m),'[]'::jsonb),
  'progress',COALESCE((SELECT jsonb_object_agg(lesson_key,jsonb_build_object('taskDone',task_done_at IS NOT NULL,'completed',completed_at IS NOT NULL,'notes',COALESCE(notes,'')))
   FROM app_private.mhp_lesson_progress WHERE user_id=actor),'{}'::jsonb));
END $f$;

-- One module's overview and sources, or one lesson's body. Raises 42501 when the tier does not open it.
CREATE FUNCTION app_private.mhp_course_content(p_session bytea,p_key text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE actor uuid; tier text; result jsonb;
BEGIN
 SELECT s.user_id INTO actor FROM app_private.resolve_session(p_session) s JOIN app.user_sessions us ON us.id=s.session_id
 WHERE us.product_audience='martin_howard_property';
 IF actor IS NULL THEN RAISE EXCEPTION 'MHP session required' USING ERRCODE='42501'; END IF;
 IF p_key IS NULL OR p_key!~'^[0-9]{2}(/[0-9]{2})?$' THEN RAISE EXCEPTION 'Invalid content key' USING ERRCODE='22023'; END IF;
 tier:=app_private.mhp_learning_tier(actor);
 IF NOT (tier='full' OR (tier='desk' AND left(p_key,2) IN('00','01'))) THEN RAISE EXCEPTION 'Course access required' USING ERRCODE='42501'; END IF;
 IF length(p_key)=2 THEN
  SELECT jsonb_build_object('overview',overview_md,'sources',sources_md) INTO result FROM app_private.mhp_course_modules WHERE number=p_key;
 ELSE
  SELECT jsonb_build_object('body',body_md) INTO result FROM app_private.mhp_course_lessons WHERE lesson_key=p_key;
 END IF;
 RETURN result;
END $f$;

-- Owner-only full replacement of the catalogue. Progress rows are keyed by
-- lesson and survive a reload.
CREATE FUNCTION app_private.mhp_import_course(p_session bytea,p_bundle jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE actor uuid; m jsonb; l jsonb; module_count integer:=0; lesson_count integer:=0; num text;
BEGIN
 SELECT s.user_id INTO actor FROM app_private.resolve_session(p_session) s JOIN app.user_sessions us ON us.id=s.session_id
 WHERE us.product_audience='martin_howard_property';
 IF actor IS NULL OR NOT app_private.mhp_is_programme_admin(actor) THEN RAISE EXCEPTION 'MHP administration required' USING ERRCODE='42501'; END IF;
 IF p_bundle IS NULL OR jsonb_typeof(p_bundle->'modules')<>'array' OR jsonb_array_length(p_bundle->'modules') NOT BETWEEN 1 AND 60 THEN
  RAISE EXCEPTION 'Invalid course bundle' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('mhp_import_course',121));
 DELETE FROM app_private.mhp_course_lessons;
 DELETE FROM app_private.mhp_course_modules;
 FOR m IN SELECT value FROM jsonb_array_elements(p_bundle->'modules') LOOP
  IF jsonb_typeof(m)<>'object' OR jsonb_typeof(m->'lessons')<>'array' OR jsonb_typeof(m->'number')<>'number' THEN RAISE EXCEPTION 'Invalid course module' USING ERRCODE='22023'; END IF;
  num:=lpad((m->>'number')::integer::text,2,'0');
  INSERT INTO app_private.mhp_course_modules(number,slug,title,promise,door,level,overview_md,sources_md)
  VALUES(num,m->>'slug',m->>'title',m->>'promise',m->>'door',m->>'level',COALESCE(m->>'overview',''),COALESCE(m->>'sources',''));
  module_count:=module_count+1;
  FOR l IN SELECT value FROM jsonb_array_elements(m->'lessons') LOOP
   IF jsonb_typeof(l)<>'object' OR jsonb_typeof(l->'number')<>'number' THEN RAISE EXCEPTION 'Invalid course lesson' USING ERRCODE='22023'; END IF;
   INSERT INTO app_private.mhp_course_lessons(lesson_key,module_number,position,slug,title,minutes,task,body_md)
   VALUES(num||'/'||lpad((l->>'number')::integer::text,2,'0'),num,(l->>'number')::integer,l->>'slug',l->>'title',
    (l->>'minutes')::integer,l->>'task',l->>'body');
   lesson_count:=lesson_count+1;
  END LOOP;
 END LOOP;
 RETURN jsonb_build_object('modules',module_count,'lessons',lesson_count);
END $f$;
RESET ROLE;

SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private FROM r72_mhp_prospect_definer;
REVOKE ALL ON FUNCTION
 app_private.mhp_capture_signup(text,text,text,boolean,text,text,text,text,text,bytea,jsonb),
 app_private.mhp_record_story(text,text,text,text,text,text,text,text,text,text,text,text,text,bytea),
 app_private.mhp_claim_marketing_sends(integer,integer,text[]),
 app_private.mhp_settle_marketing_send(uuid,boolean,text),
 app_private.mhp_unsubscribe_prospect(uuid),
 app_private.mhp_growth_summary(bytea),
 app_private.mhp_learning_tier(uuid),
 app_private.mhp_learning_snapshot(bytea),
 app_private.mhp_save_lesson_progress(bytea,text,boolean,boolean,text),
 app_private.mhp_course_outline(bytea),
 app_private.mhp_course_content(bytea,text),
 app_private.mhp_import_course(bytea,jsonb)
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
 app_private.mhp_capture_signup(text,text,text,boolean,text,text,text,text,text,bytea,jsonb),
 app_private.mhp_record_story(text,text,text,text,text,text,text,text,text,text,text,text,text,bytea),
 app_private.mhp_claim_marketing_sends(integer,integer,text[]),
 app_private.mhp_settle_marketing_send(uuid,boolean,text),
 app_private.mhp_unsubscribe_prospect(uuid),
 app_private.mhp_save_lesson_progress(bytea,text,boolean,boolean,text),
 app_private.mhp_import_course(bytea,jsonb)
TO r72_identity_command;
GRANT EXECUTE ON FUNCTION app_private.mhp_growth_summary(bytea),app_private.mhp_learning_snapshot(bytea),
 app_private.mhp_course_outline(bytea),app_private.mhp_course_content(bytea,text) TO r72_web;
RESET ROLE;
