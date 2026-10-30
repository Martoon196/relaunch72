-- MHP-GROWTH-002. One Lane Mentoring applications, cookieless funnel event
-- counts and the owner's application list. Same boundary as 0121: tables in
-- app_private with forced RLS, no table grants to any runtime login role, and
-- SECURITY DEFINER functions owned by r72_mhp_prospect_definer.
DO $role$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='r72_mhp_prospect_definer') THEN RAISE EXCEPTION 'MHP prospect definer is missing'; END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='r72_mhp_prospect_definer' AND (rolcanlogin OR rolinherit OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)) THEN RAISE EXCEPTION 'Unsafe MHP prospect definer role'; END IF;
 IF EXISTS(SELECT 1 FROM pg_auth_members m JOIN pg_roles child ON child.oid=m.member WHERE child.rolname='r72_mhp_prospect_definer') THEN RAISE EXCEPTION 'MHP prospect definer must not inherit another role'; END IF;
 IF EXISTS(SELECT 1 FROM pg_auth_members m JOIN pg_roles parent ON parent.oid=m.roleid JOIN pg_roles child ON child.oid=m.member WHERE parent.rolname='r72_mhp_prospect_definer' AND child.rolname NOT IN ('r72_owner',current_user)) THEN RAISE EXCEPTION 'Unexpected MHP prospect definer member'; END IF;
 GRANT r72_mhp_prospect_definer TO r72_owner;
 EXECUTE format('GRANT r72_mhp_prospect_definer TO %I',current_user);
END $role$;
SET LOCAL ROLE r72_owner;

ALTER TABLE app_private.mhp_prospect_signups DROP CONSTRAINT mhp_prospect_signups_kind_check;
ALTER TABLE app_private.mhp_prospect_signups ADD CONSTRAINT mhp_prospect_signups_kind_check CHECK(kind IN('sheet','webinar','waitlist','application','diagnostic'));

-- One row per application; a prospect may apply more than once. No savings or
-- bank balances are collected.
CREATE TABLE app_private.mhp_applications (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 prospect_id uuid NOT NULL REFERENCES app_private.mhp_prospects(id) ON DELETE CASCADE,
 name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 120 AND name !~ '[[:cntrl:]]'),
 phone text CHECK(phone IS NULL OR (length(phone) BETWEEN 1 AND 30 AND phone ~ '^[0-9 +()-]+$')),
 location text NOT NULL CHECK(length(btrim(location)) BETWEEN 1 AND 120 AND location !~ '[[:cntrl:]]'),
 experience text NOT NULL CHECK(experience IN('None yet','Some reading or courses','Done a deal or two','Active in property')),
 door text NOT NULL CHECK(door IN('Refer','Source','Run','Own','Not sure yet')),
 hours text NOT NULL CHECK(hours IN('Under 5','5 to 10','10 to 15','15 plus')),
 objective text NOT NULL CHECK(length(btrim(objective)) BETWEEN 1 AND 600),
 obstacle text NOT NULL CHECK(obstacle IN('Direction','Skills','Time','Capital','Accountability','Something else')),
 support text NOT NULL CHECK(support IN('Group mentoring','Self-study','Not sure yet')),
 price_understood boolean NOT NULL CHECK(price_understood),
 discuss boolean NOT NULL,
 privacy_consent boolean NOT NULL CHECK(privacy_consent),
 marketing_consent boolean NOT NULL,
 consent_version text NOT NULL CHECK(length(consent_version) BETWEEN 1 AND 40),
 status text NOT NULL DEFAULT 'received' CHECK(status IN('received','contacted','booked','accepted','declined','withdrawn')),
 source text NOT NULL DEFAULT 'site' CHECK(source IN('live','replay','site','email')),
 source_hash bytea CHECK(source_hash IS NULL OR octet_length(source_hash)=32),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX mhp_applications_created_idx ON app_private.mhp_applications(created_at DESC);
CREATE INDEX mhp_applications_prospect_idx ON app_private.mhp_applications(prospect_id,created_at);
-- Funnel counters: a day, an allow-listed event name and a site path. No
-- identifiers, addresses, cookies or source hashes are stored.
CREATE TABLE app_private.mhp_event_counts (
 day date NOT NULL,
 name text NOT NULL CHECK(name IN('webinar_page_viewed','live_page_opened','replay_page_opened','diagnostic_started','diagnostic_completed','offer_viewed','application_started')),
 path text NOT NULL CHECK(length(path) BETWEEN 1 AND 120 AND path ~ '^/[A-Za-z0-9/_.-]*$'),
 count integer NOT NULL DEFAULT 0 CHECK(count>=0),
 PRIMARY KEY(day,name,path)
);
DO $security$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['mhp_applications','mhp_event_counts'] LOOP
  EXECUTE format('ALTER TABLE app_private.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE app_private.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY mhp_growth_owner ON app_private.%I TO r72_owner USING(true) WITH CHECK(true)',t);
  EXECUTE format('CREATE POLICY mhp_growth_definer ON app_private.%I TO r72_mhp_prospect_definer USING(true) WITH CHECK(true)',t);
  EXECUTE format('REVOKE ALL ON app_private.%I FROM PUBLIC',t);
  EXECUTE format('GRANT SELECT,INSERT,UPDATE ON app_private.%I TO r72_mhp_prospect_definer',t);
 END LOOP;
END $security$;
GRANT CREATE ON SCHEMA app_private TO r72_mhp_prospect_definer;
RESET ROLE;

SET LOCAL ROLE r72_mhp_prospect_definer;
-- Record one application. Consent semantics match mhp_capture_signup: marketing
-- consent is only ever added, and OPT_IN clears an earlier unsubscribe. The
-- webinar sales emails still waiting for this prospect are cancelled, and two
-- transactional sends are queued now: the applicant's acknowledgement and the
-- owner's notification (sent to p_notify_to, never to the prospect).
CREATE FUNCTION app_private.mhp_record_application(p_email text,p_name text,p_phone text,p_location text,p_experience text,p_door text,
 p_hours text,p_objective text,p_obstacle text,p_support text,p_price_understood boolean,p_discuss boolean,p_opt_in boolean,
 p_consent_version text,p_source text,p_source_hash bytea,p_notify_to text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE prospect app_private.mhp_prospects%ROWTYPE; application uuid; first_word text;
BEGIN
 IF p_email IS NULL OR p_email<>lower(btrim(p_email)) OR length(p_email)>320 OR p_email!~'^[^[:space:]@<>]+@[^[:space:]@<>]+\.[^[:space:]@<>]+$'
  OR p_notify_to IS NULL OR p_notify_to<>lower(btrim(p_notify_to)) OR length(p_notify_to)>320 OR p_notify_to!~'^[^[:space:]@<>]+@[^[:space:]@<>]+\.[^[:space:]@<>]+$'
  OR p_opt_in IS NULL OR p_discuss IS NULL OR p_price_understood IS NOT TRUE
  OR p_consent_version IS NULL OR length(p_consent_version) NOT BETWEEN 1 AND 40 OR p_name IS NULL THEN
  RAISE EXCEPTION 'Invalid application' USING ERRCODE='22023';
 END IF;
 first_word:=NULLIF(left(split_part(btrim(p_name),' ',1),100),'');
 PERFORM pg_advisory_xact_lock(hashtextextended(p_email,121));
 SELECT * INTO prospect FROM app_private.mhp_prospects WHERE email::text=p_email FOR UPDATE;
 IF NOT FOUND THEN
  INSERT INTO app_private.mhp_prospects(email,first_name,marketing_consent,consent_version,consent_at)
  VALUES(p_email,first_word,p_opt_in,CASE WHEN p_opt_in THEN p_consent_version END,CASE WHEN p_opt_in THEN clock_timestamp() END)
  RETURNING * INTO prospect;
 ELSE
  UPDATE app_private.mhp_prospects SET
   first_name=COALESCE(first_name,first_word),
   marketing_consent=marketing_consent OR p_opt_in,
   consent_version=CASE WHEN p_opt_in THEN p_consent_version ELSE consent_version END,
   consent_at=CASE WHEN p_opt_in THEN clock_timestamp() ELSE consent_at END,
   unsubscribed_at=CASE WHEN p_opt_in THEN NULL ELSE unsubscribed_at END,
   updated_at=clock_timestamp()
  WHERE id=prospect.id RETURNING * INTO prospect;
 END IF;
 INSERT INTO app_private.mhp_prospect_signups(prospect_id,kind,label,module,link,consent_given,consent_version,source_hash)
 VALUES(prospect.id,'application','One Lane Mentoring application',NULL,NULL,p_opt_in,p_consent_version,p_source_hash);
 INSERT INTO app_private.mhp_applications(prospect_id,name,phone,location,experience,door,hours,objective,obstacle,support,
  price_understood,discuss,privacy_consent,marketing_consent,consent_version,source,source_hash)
 VALUES(prospect.id,btrim(p_name),NULLIF(btrim(p_phone),''),btrim(p_location),p_experience,p_door,p_hours,btrim(p_objective),p_obstacle,p_support,
  p_price_understood,p_discuss,true,p_opt_in,p_consent_version,COALESCE(p_source,'site'),p_source_hash)
 RETURNING id INTO application;
 -- They have applied: stop the webinar sales sequence for them.
 UPDATE app_private.mhp_marketing_sends SET cancelled_at=clock_timestamp()
 WHERE prospect_id=prospect.id AND sent_at IS NULL AND cancelled_at IS NULL AND failed_at IS NULL
  AND template_key IN('webinar_followup','webinar_90days','webinar_casestudy');
 INSERT INTO app_private.mhp_marketing_sends(prospect_id,template_key,campaign_key,context,due_at,expires_at)
 VALUES(prospect.id,'application_received','application-'||application::text,jsonb_build_object('applicationId',application),
   clock_timestamp(),clock_timestamp()+interval '7 days'),
  (prospect.id,'application_notify','application-'||application::text,jsonb_build_object('applicationId',application,'notifyTo',p_notify_to),
   clock_timestamp(),clock_timestamp()+interval '30 days');
 RETURN jsonb_build_object('applicationId',application,'prospectId',prospect.id);
END $f$;

-- Owner-only list of the latest 200 applications, newest first.
CREATE FUNCTION app_private.mhp_list_applications(p_session bytea) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE actor uuid;
BEGIN
 SELECT s.user_id INTO actor FROM app_private.resolve_session(p_session) s JOIN app.user_sessions us ON us.id=s.session_id
 WHERE us.product_audience='martin_howard_property';
 IF actor IS NULL OR NOT app_private.mhp_is_programme_admin(actor) THEN RAISE EXCEPTION 'MHP administration required' USING ERRCODE='42501'; END IF;
 RETURN COALESCE((SELECT jsonb_agg(jsonb_build_object('id',a.id,'name',a.name,'email',p.email::text,'phone',a.phone,'location',a.location,
   'experience',a.experience,'door',a.door,'hours',a.hours,'objective',a.objective,'obstacle',a.obstacle,'support',a.support,
   'discuss',a.discuss,'marketingConsent',a.marketing_consent,'source',a.source,'status',a.status,'createdAt',a.created_at) ORDER BY a.created_at DESC,a.id)
  FROM (SELECT * FROM app_private.mhp_applications ORDER BY created_at DESC,id LIMIT 200) a JOIN app_private.mhp_prospects p ON p.id=a.prospect_id),'[]'::jsonb);
END $f$;

-- One cookieless page event, counted per UTC day. Unknown names or paths are
-- ignored rather than raised: the public beacon always gets a 204.
CREATE FUNCTION app_private.mhp_record_event(p_name text,p_path text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
BEGIN
 IF p_name IS NULL OR p_name NOT IN('webinar_page_viewed','live_page_opened','replay_page_opened','diagnostic_started','diagnostic_completed','offer_viewed','application_started')
  OR p_path IS NULL OR length(p_path) NOT BETWEEN 1 AND 120 OR p_path!~'^/[A-Za-z0-9/_.-]*$' THEN RETURN false; END IF;
 INSERT INTO app_private.mhp_event_counts(day,name,path,count) VALUES((clock_timestamp() AT TIME ZONE 'UTC')::date,p_name,p_path,1)
 ON CONFLICT(day,name,path) DO UPDATE SET count=app_private.mhp_event_counts.count+1;
 RETURN true;
END $f$;

-- Same lease/settle queue as 0121. Changes: application sends are transactional
-- and are not cancelled by an earlier unsubscribe; in test mode the owner
-- notification is matched on the address it is actually sent to; and the
-- notification carries its application so the dispatcher can describe it.
CREATE OR REPLACE FUNCTION app_private.mhp_claim_marketing_sends(p_limit integer,p_lease_seconds integer,p_only_emails text[]) RETURNS jsonb
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
 WHERE p.id=s.prospect_id AND p.unsubscribed_at IS NOT NULL AND s.sent_at IS NULL AND s.cancelled_at IS NULL AND s.failed_at IS NULL
  AND s.template_key NOT IN('application_received','application_notify');
 WITH due AS(
  SELECT s.id FROM app_private.mhp_marketing_sends s JOIN app_private.mhp_prospects p ON p.id=s.prospect_id
  WHERE s.sent_at IS NULL AND s.cancelled_at IS NULL AND s.failed_at IS NULL AND s.due_at<=clock_timestamp()
   AND s.expires_at>clock_timestamp() AND (s.lease_until IS NULL OR s.lease_until<clock_timestamp())
   AND (p_only_emails IS NULL OR (CASE WHEN s.template_key='application_notify' THEN s.context->>'notifyTo' ELSE p.email::text END)=ANY(p_only_emails))
  ORDER BY s.due_at,s.id LIMIT p_limit FOR UPDATE OF s SKIP LOCKED
 ), leased AS(
  UPDATE app_private.mhp_marketing_sends s SET lease_until=clock_timestamp()+make_interval(secs=>p_lease_seconds),attempts=s.attempts+1
  FROM due WHERE s.id=due.id RETURNING s.*
 )
 SELECT COALESCE(jsonb_agg(jsonb_build_object('id',l.id,'prospectId',p.id,'template',l.template_key,'campaign',l.campaign_key,
  'context',l.context,'email',p.email::text,'firstName',p.first_name,'level',p.level,'attempts',l.attempts,'expiresAt',l.expires_at,
  'application',CASE WHEN a.id IS NULL THEN NULL ELSE jsonb_build_object('id',a.id,'name',a.name,'email',p.email::text,'phone',a.phone,
   'location',a.location,'experience',a.experience,'door',a.door,'hours',a.hours,'objective',a.objective,'obstacle',a.obstacle,
   'support',a.support,'discuss',a.discuss,'marketingConsent',a.marketing_consent,'source',a.source,'status',a.status,'createdAt',a.created_at) END)
  ORDER BY l.due_at),'[]'::jsonb)
 INTO claimed FROM leased l JOIN app_private.mhp_prospects p ON p.id=l.prospect_id
  LEFT JOIN app_private.mhp_applications a ON l.template_key='application_notify' AND a.id::text=l.context->>'applicationId';
 RETURN claimed;
END $f$;

-- 0121's summary plus applications and 30-day event totals. Counts only.
CREATE OR REPLACE FUNCTION app_private.mhp_growth_summary(p_session bytea) RETURNS jsonb
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
  'lessonsCompleted',(SELECT count(*) FROM app_private.mhp_lesson_progress WHERE completed_at IS NOT NULL),
  'applications',jsonb_build_object('total',(SELECT count(*) FROM app_private.mhp_applications),
    'today',(SELECT count(*) FROM app_private.mhp_applications WHERE created_at>=date_trunc('day',clock_timestamp()))),
  'applicationsByDoor',COALESCE((SELECT jsonb_object_agg(door,n) FROM(SELECT door,count(*) n FROM app_private.mhp_applications GROUP BY door) d),'{}'::jsonb),
  'events',COALESCE((SELECT jsonb_object_agg(name,n) FROM(SELECT name,sum(count) n FROM app_private.mhp_event_counts
    WHERE day>(clock_timestamp() AT TIME ZONE 'UTC')::date-30 GROUP BY name) e),'{}'::jsonb));
END $f$;
RESET ROLE;

SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private FROM r72_mhp_prospect_definer;
REVOKE ALL ON FUNCTION
 app_private.mhp_record_application(text,text,text,text,text,text,text,text,text,text,boolean,boolean,boolean,text,text,bytea,text),
 app_private.mhp_list_applications(bytea),
 app_private.mhp_record_event(text,text),
 app_private.mhp_claim_marketing_sends(integer,integer,text[]),
 app_private.mhp_growth_summary(bytea)
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
 app_private.mhp_record_application(text,text,text,text,text,text,text,text,text,text,boolean,boolean,boolean,text,text,bytea,text),
 app_private.mhp_record_event(text,text)
TO r72_identity_command;
GRANT EXECUTE ON FUNCTION app_private.mhp_list_applications(bytea) TO r72_web;
RESET ROLE;
