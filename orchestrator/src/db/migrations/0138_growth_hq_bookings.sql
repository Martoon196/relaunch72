-- GHQ-BOOKING-001. Existing investor identity, vault and CRM; no marketing grant.
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
SET LOCAL ROLE r72_owner;
CREATE TABLE app.booking_calendars (
 workspace_id uuid PRIMARY KEY REFERENCES app.investor_businesses(workspace_id),
 host_user_id uuid NOT NULL REFERENCES app.users(id),
 settings jsonb NOT NULL CHECK(jsonb_typeof(settings)='object' AND octet_length(settings::text)<=64000),
 provider text CHECK(provider IN('google','microsoft')),
 address text CHECK(address=lower(address) AND length(address) BETWEEN 3 AND 254),
 sealed_credentials text CHECK(length(sealed_credentials) BETWEEN 1 AND 32000),
 enabled boolean NOT NULL DEFAULT false,
 row_version bigint NOT NULL DEFAULT 1,
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(NOT enabled OR(provider IS NOT NULL AND address IS NOT NULL AND sealed_credentials IS NOT NULL))
);
CREATE TABLE app.booking_meeting_types (
 id uuid PRIMARY KEY,
 workspace_id uuid NOT NULL REFERENCES app.booking_calendars(workspace_id),
 slug uuid NOT NULL UNIQUE,
 settings jsonb NOT NULL CHECK(jsonb_typeof(settings)='object' AND octet_length(settings::text)<=16000),
 published boolean NOT NULL DEFAULT false,
 archived boolean NOT NULL DEFAULT false,
 row_version bigint NOT NULL DEFAULT 1,
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(workspace_id,id)
);
CREATE TABLE app.booking_appointments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 workspace_id uuid NOT NULL,
 host_user_id uuid NOT NULL REFERENCES app.users(id),
 meeting_type_id uuid NOT NULL,
 command_key uuid NOT NULL,
 request_hash bytea NOT NULL CHECK(octet_length(request_hash)=32),
 manage_hash bytea CHECK(octet_length(manage_hash)=32),
 dispatch_hash bytea CHECK(octet_length(dispatch_hash)=32),
 starts_at timestamptz NOT NULL,
 ends_at timestamptz NOT NULL,
 busy_from timestamptz NOT NULL,
 busy_until timestamptz NOT NULL,
 pending_start timestamptz,
 pending_end timestamptz,
 pending_busy_from timestamptz,
 pending_busy_until timestamptz,
 state text NOT NULL CHECK(state IN('local','reserved','confirmed','unknown','cancelling','rescheduling','cancelled')),
 person jsonb NOT NULL CHECK(jsonb_typeof(person)='object' AND octet_length(person::text)<=16000),
 meeting_snapshot jsonb NOT NULL CHECK(jsonb_typeof(meeting_snapshot)='object'),
 provider_id text CHECK(length(provider_id) BETWEEN 1 AND 2000),
 contact_id uuid,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 row_version bigint NOT NULL DEFAULT 1,
 UNIQUE(workspace_id,command_key),
 FOREIGN KEY(workspace_id,meeting_type_id) REFERENCES app.booking_meeting_types(workspace_id,id),
 FOREIGN KEY(workspace_id,contact_id) REFERENCES app.contacts(workspace_id,id),
 CHECK(busy_from<=starts_at AND starts_at<ends_at AND ends_at<=busy_until),
 CHECK((state='rescheduling')=(pending_start IS NOT NULL AND pending_end IS NOT NULL AND pending_busy_from IS NOT NULL AND pending_busy_until IS NOT NULL)),
 CHECK(pending_start IS NULL OR (pending_busy_from<=pending_start AND pending_start<pending_end AND pending_end<=pending_busy_until)),
 CHECK(state<>'confirmed' OR provider_id IS NOT NULL)
);
CREATE INDEX booking_host_busy ON app.booking_appointments(host_user_id,busy_from,busy_until) WHERE state<>'cancelled';
CREATE INDEX booking_workspace_dates ON app.booking_appointments(workspace_id,starts_at,id);
DO $rls$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['booking_calendars','booking_meeting_types','booking_appointments'] LOOP
  EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY booking_owner ON app.%I TO r72_owner USING(true) WITH CHECK(true)',t);
  EXECUTE format('CREATE POLICY booking_definer ON app.%I TO r72_investor_programme_definer USING(true) WITH CHECK(true)',t);
  EXECUTE format('GRANT SELECT,INSERT,UPDATE ON app.%I TO r72_investor_programme_definer',t);
  EXECUTE format('REVOKE ALL ON app.%I FROM PUBLIC',t);
  INSERT INTO app_private.workspace_table_registry(schema_name,table_name,workspace_column) VALUES('app',t,'workspace_id');
 END LOOP;
END $rls$;
GRANT CREATE ON SCHEMA app_private TO r72_investor_programme_definer;
SET LOCAL ROLE r72_investor_programme_definer;

CREATE FUNCTION app_private.booking_workspace(p_session bytea) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE actor uuid;ws uuid;a jsonb;
BEGIN
 SELECT user_id,selected_workspace_id INTO actor,ws FROM app_private.resolve_session(p_session);
 IF actor IS NULL OR NOT app_private.lock_active_portal_session(p_session,actor,ws) OR NOT app_private.can_manage_workspace(actor,ws)
 OR NOT EXISTS(SELECT 1 FROM app.investor_businesses WHERE workspace_id=ws AND access_state IN('test','active')) THEN RAISE EXCEPTION 'Calendar access denied' USING ERRCODE='42501'; END IF;
 a:=app_private.mhp_workspace_access(actor,ws);
 IF a IS NOT NULL AND (NOT COALESCE((a->>'crm')::boolean,false) OR COALESCE((a->>'readOnly')::boolean,true)) THEN RAISE EXCEPTION 'Calendar access denied' USING ERRCODE='42501'; END IF;
 RETURN ws;
END $f$;

CREATE FUNCTION app_private.booking_validate_type(p jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $f$
DECLARE q jsonb;ids text[]:='{}';
BEGIN
 IF EXISTS(SELECT 1 FROM unnest(ARRAY['title','description','timeZone','location']) k WHERE jsonb_typeof(p->k) IS DISTINCT FROM 'string')
 OR EXISTS(SELECT 1 FROM unnest(ARRAY['durationMinutes','intervalMinutes','bufferBeforeMinutes','bufferAfterMinutes','noticeMinutes','horizonDays']) k WHERE jsonb_typeof(p->k) IS DISTINCT FROM 'number' OR p->>k !~ '^[0-9]+$') THEN RETURN false; END IF;
 IF p IS NULL OR jsonb_typeof(p)<>'object' OR p-ARRAY['title','description','durationMinutes','intervalMinutes','bufferBeforeMinutes','bufferAfterMinutes','noticeMinutes','horizonDays','timeZone','location','questions']<>'{}'::jsonb
 OR length(btrim(p->>'title')) NOT BETWEEN 1 AND 100 OR length(p->>'description')>2000 OR length(p->>'location')>500
 OR (p->>'durationMinutes')::integer NOT BETWEEN 5 AND 480 OR (p->>'intervalMinutes')::integer NOT BETWEEN 5 AND 120
 OR (p->>'bufferBeforeMinutes')::integer NOT BETWEEN 0 AND 240 OR (p->>'bufferAfterMinutes')::integer NOT BETWEEN 0 AND 240
 OR (p->>'noticeMinutes')::integer NOT BETWEEN 0 AND 43200 OR (p->>'horizonDays')::integer NOT BETWEEN 1 AND 365
 OR jsonb_typeof(p->'questions')<>'array' OR jsonb_array_length(p->'questions')>8
 OR NOT(p ?& ARRAY['title','description','durationMinutes','intervalMinutes','bufferBeforeMinutes','bufferAfterMinutes','noticeMinutes','horizonDays','timeZone','location','questions']) THEN RETURN false; END IF;
 FOR q IN SELECT value FROM jsonb_array_elements(p->'questions') LOOP
  IF jsonb_typeof(q) IS DISTINCT FROM 'object' OR EXISTS(SELECT 1 FROM unnest(ARRAY['id','label','kind']) k WHERE jsonb_typeof(q->k) IS DISTINCT FROM 'string') OR q-ARRAY['id','label','kind','required']<>'{}'::jsonb OR NOT(q ?& ARRAY['id','label','kind','required']) OR (q->>'id') !~ '^[a-z][a-z0-9_]{0,39}$'
  OR (q->>'id')=ANY(ids) OR length(btrim(q->>'label')) NOT BETWEEN 1 AND 200 OR q->>'kind' NOT IN('text','textarea') OR jsonb_typeof(q->'required')<>'boolean' THEN RETURN false; END IF;
  ids:=array_append(ids,q->>'id');
 END LOOP;
 RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $f$;

CREATE FUNCTION app_private.booking_save_calendar(p_session bytea,p_version bigint,p_settings jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE ws uuid;actor uuid;previous bigint;w jsonb;o jsonb;day integer;
BEGIN
 ws:=app_private.booking_workspace(p_session);SELECT user_id INTO actor FROM app_private.resolve_session(p_session);
 IF p_settings IS NULL OR jsonb_typeof(p_settings) IS DISTINCT FROM 'object' OR jsonb_typeof(p_settings->'timeZone') IS DISTINCT FROM 'string' OR p_settings-ARRAY['timeZone','windows','overrides']<>'{}'::jsonb OR NOT(p_settings ?& ARRAY['timeZone','windows','overrides'])
 OR NOT EXISTS(SELECT 1 FROM pg_timezone_names WHERE name=p_settings->>'timeZone') OR jsonb_typeof(p_settings->'windows') IS DISTINCT FROM 'array'
 OR jsonb_array_length(p_settings->'windows')>28 OR jsonb_typeof(p_settings->'overrides') IS DISTINCT FROM 'array' OR jsonb_array_length(p_settings->'overrides')>366 THEN RAISE EXCEPTION 'Invalid calendar settings' USING ERRCODE='22023'; END IF;
 FOR w IN SELECT value FROM jsonb_array_elements(p_settings->'windows') LOOP
  IF jsonb_typeof(w) IS DISTINCT FROM 'object' OR EXISTS(SELECT 1 FROM unnest(ARRAY['day','start','end']) k WHERE jsonb_typeof(w->k) IS DISTINCT FROM 'number' OR w->>k !~ '^[0-9]+$') OR NOT(w ?& ARRAY['day','start','end']) OR w-ARRAY['day','start','end']<>'{}'::jsonb OR (w->>'day')::integer NOT BETWEEN 0 AND 6
  OR (w->>'start')::integer NOT BETWEEN 0 AND 1439 OR (w->>'end')::integer NOT BETWEEN 1 AND 1440 OR (w->>'start')::integer>=(w->>'end')::integer THEN RAISE EXCEPTION 'Invalid working hours' USING ERRCODE='22023'; END IF;
 END LOOP;
 FOR o IN SELECT value FROM jsonb_array_elements(p_settings->'overrides') LOOP
  IF jsonb_typeof(o) IS DISTINCT FROM 'object' OR jsonb_typeof(o->'date') IS DISTINCT FROM 'string' OR NOT(o ?& ARRAY['date','windows']) OR o-ARRAY['date','windows']<>'{}'::jsonb OR o->>'date' !~ '^\d{4}-\d{2}-\d{2}$' OR to_char((o->>'date')::date,'YYYY-MM-DD')<>o->>'date'
  OR jsonb_typeof(o->'windows') IS DISTINCT FROM 'array' OR jsonb_array_length(o->'windows')>4 THEN RAISE EXCEPTION 'Invalid date override' USING ERRCODE='22023'; END IF;
  FOR w IN SELECT value FROM jsonb_array_elements(o->'windows') LOOP
   IF jsonb_typeof(w) IS DISTINCT FROM 'object' OR EXISTS(SELECT 1 FROM unnest(ARRAY['start','end']) k WHERE jsonb_typeof(w->k) IS DISTINCT FROM 'number' OR w->>k !~ '^[0-9]+$') OR NOT(w ?& ARRAY['start','end']) OR w-ARRAY['start','end']<>'{}'::jsonb OR (w->>'start')::integer NOT BETWEEN 0 AND 1439
   OR (w->>'end')::integer NOT BETWEEN 1 AND 1440 OR (w->>'start')::integer>=(w->>'end')::integer THEN RAISE EXCEPTION 'Invalid date hours' USING ERRCODE='22023'; END IF;
  END LOOP;
 END LOOP;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_settings->'windows') WITH ORDINALITY a(w,i),jsonb_array_elements(p_settings->'windows') WITH ORDINALITY b(w,i)
 WHERE a.i<b.i AND a.w->>'day'=b.w->>'day' AND(a.w->>'start')::integer<(b.w->>'end')::integer AND(b.w->>'start')::integer<(a.w->>'end')::integer)
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_settings->'overrides') ov(value) GROUP BY ov.value->>'date' HAVING count(*)>1)
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_settings->'overrides') ov(value),jsonb_array_elements(ov.value->'windows') WITH ORDINALITY a(w,i),jsonb_array_elements(ov.value->'windows') WITH ORDINALITY b(w,i)
 WHERE a.i<b.i AND(a.w->>'start')::integer<(b.w->>'end')::integer AND(b.w->>'start')::integer<(a.w->>'end')::integer) THEN RAISE EXCEPTION 'Calendar hours overlap' USING ERRCODE='22023'; END IF;
 PERFORM 1 FROM app.investor_businesses WHERE workspace_id=ws FOR UPDATE;
 SELECT row_version INTO previous FROM app.booking_calendars WHERE workspace_id=ws FOR UPDATE;
 IF p_version IS NULL OR COALESCE(previous,0)<>p_version THEN RAISE EXCEPTION 'Calendar changed' USING ERRCODE='40001'; END IF;
 UPDATE app.booking_meeting_types SET settings=jsonb_set(settings,'{timeZone}',p_settings->'timeZone'),row_version=row_version+1,updated_at=clock_timestamp()
 WHERE workspace_id=ws AND settings->>'timeZone'<>p_settings->>'timeZone';
 INSERT INTO app.booking_calendars(workspace_id,host_user_id,settings) VALUES(ws,actor,p_settings)
 ON CONFLICT(workspace_id) DO UPDATE SET settings=EXCLUDED.settings,row_version=app.booking_calendars.row_version+1,updated_at=clock_timestamp();
END $f$;

CREATE FUNCTION app_private.booking_save_type(p_session bytea,p_id uuid,p_slug uuid,p_version bigint,p_settings jsonb,p_publish boolean,p_archive boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE ws uuid;c app.booking_calendars%ROWTYPE;previous app.booking_meeting_types%ROWTYPE;
BEGIN
 ws:=app_private.booking_workspace(p_session);SELECT * INTO c FROM app.booking_calendars WHERE workspace_id=ws FOR UPDATE;
 IF NOT FOUND OR p_id IS NULL OR p_slug IS NULL OR p_publish IS NULL OR p_archive IS NULL OR NOT app_private.booking_validate_type(p_settings)
 OR p_settings->>'timeZone'<>c.settings->>'timeZone' THEN RAISE EXCEPTION 'Check calendar and meeting settings' USING ERRCODE='22023'; END IF;
 SELECT * INTO previous FROM app.booking_meeting_types WHERE id=p_id FOR UPDATE;
 IF p_version IS NULL OR (FOUND AND(previous.workspace_id<>ws OR previous.slug<>p_slug)) OR COALESCE(previous.row_version,0)<>p_version THEN RAISE EXCEPTION 'Meeting type changed' USING ERRCODE='40001'; END IF;
 IF p_publish AND(p_archive OR NOT c.enabled
 OR jsonb_array_length(c.settings->'windows')=0) THEN RAISE EXCEPTION 'Connect a calendar and set working hours before publishing' USING ERRCODE='42501'; END IF;
 INSERT INTO app.booking_meeting_types(id,workspace_id,slug,settings,published,archived) VALUES(p_id,ws,p_slug,p_settings,p_publish,p_archive)
 ON CONFLICT(id) DO UPDATE SET settings=EXCLUDED.settings,published=EXCLUDED.published,archived=EXCLUDED.archived,row_version=app.booking_meeting_types.row_version+1,updated_at=clock_timestamp();
END $f$;

CREATE FUNCTION app_private.booking_connect_calendar(p_session bytea,p_version bigint,p_provider text,p_address text,p_sealed text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE ws uuid;c app.booking_calendars%ROWTYPE;
BEGIN
 ws:=app_private.booking_workspace(p_session);
 IF p_version IS NULL OR p_provider IS NULL OR p_provider NOT IN('google','microsoft') OR p_address IS NULL OR p_address<>lower(p_address)
 OR length(p_address) NOT BETWEEN 3 AND 254 OR p_address !~ '^[^[:space:]<>@]+@[^[:space:]<>@]+\.[^[:space:]<>@]+$'
 OR p_sealed IS NULL OR length(p_sealed) NOT BETWEEN 1 AND 32000 THEN RAISE EXCEPTION 'Invalid calendar connection' USING ERRCODE='22023'; END IF;
 SELECT * INTO c FROM app.booking_calendars WHERE workspace_id=ws;
 PERFORM pg_advisory_xact_lock(hashtextextended('booking-host:'||c.host_user_id,138));
 SELECT * INTO c FROM app.booking_calendars WHERE workspace_id=ws FOR UPDATE;
 IF c.row_version IS DISTINCT FROM p_version THEN RAISE EXCEPTION 'Calendar changed; connect again' USING ERRCODE='40001'; END IF;
 IF c.enabled AND(c.provider<>p_provider OR c.address<>p_address) AND EXISTS(SELECT 1 FROM app.booking_appointments WHERE workspace_id=ws AND state NOT IN('local','cancelled')) THEN
  RAISE EXCEPTION 'Cancel existing calendar bookings before connecting a different account' USING ERRCODE='22023';
 END IF;
 UPDATE app.booking_calendars SET provider=p_provider,address=p_address,sealed_credentials=p_sealed,enabled=true,row_version=row_version+1,updated_at=clock_timestamp()
 WHERE workspace_id=ws AND row_version=p_version;
 IF NOT FOUND THEN RAISE EXCEPTION 'Calendar changed; connect again' USING ERRCODE='40001'; END IF;
END $f$;

CREATE FUNCTION app_private.booking_public_context(p_slug uuid,p_mhp boolean,p_private boolean DEFAULT false) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE result jsonb;
BEGIN
 SELECT jsonb_build_object('workspaceId',c.workspace_id,'hostId',c.host_user_id,'calendarVersion',c.row_version,'schedule',c.settings,
 'type',t.settings||jsonb_build_object('id',t.id,'slug',t.slug,'version',t.row_version,'published',t.published),
 'brandName',b.brand_name,'accentColor',b.accent_color,'connected',c.enabled)
 INTO result FROM app.booking_meeting_types t JOIN app.booking_calendars c USING(workspace_id) JOIN app.investor_businesses b USING(workspace_id)
 CROSS JOIN LATERAL(SELECT app_private.mhp_workspace_access(b.owner_user_id,b.workspace_id) access) m
 WHERE t.slug=p_slug AND(p_private OR(t.published AND NOT t.archived AND c.enabled)) AND b.access_state IN('test','active')
 AND p_mhp IS NOT NULL AND(m.access IS NOT NULL)=p_mhp AND(NOT p_mhp OR(COALESCE((m.access->>'crm')::boolean,false) AND NOT COALESCE((m.access->>'readOnly')::boolean,true)));
 RETURN result;
END $f$;
CREATE FUNCTION app_private.booking_public_page(p_slug uuid,p_mhp boolean,p_from timestamptz,p_until timestamptz) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE context jsonb;busy jsonb;
BEGIN
 IF p_from IS NULL OR p_until IS NULL OR p_until<=p_from OR p_until-p_from>interval '10 days' THEN RAISE EXCEPTION 'Invalid availability range' USING ERRCODE='22023'; END IF;
 context:=app_private.booking_public_context(p_slug,p_mhp);IF context IS NULL THEN RETURN NULL; END IF;
 SELECT COALESCE(jsonb_agg(jsonb_build_object('start',a.busy_from,'end',a.busy_until)),'[]'::jsonb) INTO busy FROM app.booking_appointments a
 WHERE a.host_user_id=(context->>'hostId')::uuid AND a.state<>'cancelled' AND a.busy_from<p_until AND a.busy_until>p_from;
 SELECT busy||COALESCE(jsonb_agg(jsonb_build_object('start',a.pending_busy_from,'end',a.pending_busy_until)),'[]'::jsonb) INTO busy FROM app.booking_appointments a
 WHERE a.host_user_id=(context->>'hostId')::uuid AND a.state='rescheduling' AND a.pending_busy_from<p_until AND a.pending_busy_until>p_from;
 RETURN(context-ARRAY['workspaceId','hostId'])||jsonb_build_object('busy',busy);
END $f$;

CREATE FUNCTION app_private.booking_calendar_secret(p_slug uuid,p_mhp boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE context jsonb;
BEGIN
 context:=app_private.booking_public_context(p_slug,p_mhp,true);
 IF context IS NULL OR NOT COALESCE((context->>'connected')::boolean,false) THEN RETURN NULL; END IF;
 RETURN(SELECT jsonb_build_object('workspaceId',c.workspace_id,'version',c.row_version,'sealed',c.sealed_credentials,'address',c.address)
 FROM app.booking_calendars c WHERE c.workspace_id=(context->>'workspaceId')::uuid AND c.enabled);
END $f$;
CREATE FUNCTION app_private.booking_refresh_calendar(p_slug uuid,p_mhp boolean,p_version bigint,p_old_hash bytea,p_sealed text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE context jsonb;
BEGIN
 context:=app_private.booking_public_context(p_slug,p_mhp,true);
 IF context IS NULL OR NOT COALESCE((context->>'connected')::boolean,false) OR length(p_sealed) NOT BETWEEN 1 AND 32000 THEN RETURN false; END IF;
 UPDATE app.booking_calendars SET sealed_credentials=p_sealed,updated_at=clock_timestamp()
 WHERE workspace_id=(context->>'workspaceId')::uuid AND row_version=p_version AND enabled
 AND sha256(convert_to(sealed_credentials,'UTF8'))=p_old_hash;
 RETURN FOUND;
END $f$;

CREATE FUNCTION app_private.booking_slot_allowed(p_type jsonb,p_schedule jsonb,p_start timestamptz) RETURNS boolean
LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $f$
DECLARE local_start timestamp;local_end timestamp;minute integer;windows jsonb;override jsonb;
BEGIN
 IF p_start IS NULL OR date_trunc('minute',p_start)<>p_start OR p_start<clock_timestamp()+make_interval(mins=>(p_type->>'noticeMinutes')::integer)
 OR p_start>clock_timestamp()+make_interval(days=>(p_type->>'horizonDays')::integer) THEN RETURN false; END IF;
 local_start:=p_start AT TIME ZONE(p_schedule->>'timeZone');local_end:=(p_start+make_interval(mins=>(p_type->>'durationMinutes')::integer)) AT TIME ZONE(p_schedule->>'timeZone');
 IF local_end-local_start<>make_interval(mins=>(p_type->>'durationMinutes')::integer) THEN RETURN false; END IF;
 minute:=extract(hour FROM local_start)::integer*60+extract(minute FROM local_start)::integer;
 SELECT value INTO override FROM jsonb_array_elements(p_schedule->'overrides') WHERE value->>'date'=to_char(local_start,'YYYY-MM-DD');
 IF override IS NOT NULL THEN windows:=override->'windows';
 ELSE SELECT COALESCE(jsonb_agg(value),'[]'::jsonb) INTO windows FROM jsonb_array_elements(p_schedule->'windows') WHERE(value->>'day')::integer=extract(dow FROM local_start)::integer; END IF;
 RETURN EXISTS(SELECT 1 FROM jsonb_array_elements(windows) w WHERE minute-(p_type->>'bufferBeforeMinutes')::integer>=(w->>'start')::integer
 AND minute+(p_type->>'durationMinutes')::integer+(p_type->>'bufferAfterMinutes')::integer<=(w->>'end')::integer
 AND mod(minute-(w->>'start')::integer,(p_type->>'intervalMinutes')::integer)=0);
END $f$;

CREATE FUNCTION app_private.booking_hold(p_slug uuid,p_mhp boolean,p_command uuid,p_start timestamptz,p_person jsonb,p_manage bytea,p_dispatch bytea,p_type_version bigint,p_calendar_version bigint,p_session bytea DEFAULT NULL,p_external boolean DEFAULT false) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE context jsonb;c app.booking_calendars%ROWTYPE;t app.booking_meeting_types%ROWTYPE;old app.booking_appointments%ROWTYPE;made app.booking_appointments%ROWTYPE;
 ws uuid;actor uuid;expected bytea;finish timestamptz;busy_start timestamptz;busy_end timestamptz;question jsonb;answer text;is_owner boolean:=p_session IS NOT NULL;is_local boolean:=p_session IS NOT NULL AND NOT p_external;
BEGIN
 context:=app_private.booking_public_context(p_slug,p_mhp,is_owner);IF context IS NULL THEN RAISE EXCEPTION 'Meeting unavailable' USING ERRCODE='42501'; END IF;
 ws:=(context->>'workspaceId')::uuid;
 IF is_owner AND app_private.booking_workspace(p_session)<>ws THEN RAISE EXCEPTION 'Calendar access denied' USING ERRCODE='42501'; END IF;
 IF p_command IS NULL OR p_person IS NULL OR jsonb_typeof(p_person) IS DISTINCT FROM 'object' OR EXISTS(SELECT 1 FROM unnest(ARRAY['name','email']) k WHERE jsonb_typeof(p_person->k) IS DISTINCT FROM 'string') OR p_person-ARRAY['name','email','answers']<>'{}'::jsonb OR NOT(p_person ?& ARRAY['name','email','answers'])
 OR length(btrim(p_person->>'name')) NOT BETWEEN 1 AND 200 OR length(p_person->>'email')>254 OR p_person->>'email' !~ '^[^[:space:]<>@]+@[^[:space:]<>@]+\.[^[:space:]<>@]+$'
 OR jsonb_typeof(p_person->'answers') IS DISTINCT FROM 'object' OR octet_length(p_person::text)>16000 OR(NOT is_owner AND(p_manage IS NULL OR octet_length(p_manage)<>32))
 OR p_dispatch IS NULL OR octet_length(p_dispatch)<>32 OR p_external IS NULL THEN RAISE EXCEPTION 'Invalid booking' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('booking-host:'||(context->>'hostId'),138));
 SELECT * INTO c FROM app.booking_calendars WHERE workspace_id=ws FOR UPDATE;
 SELECT * INTO t FROM app.booking_meeting_types WHERE slug=p_slug AND workspace_id=ws FOR UPDATE;
 IF p_type_version IS NULL OR p_calendar_version IS NULL OR t.row_version<>p_type_version OR c.row_version<>p_calendar_version THEN RAISE EXCEPTION 'Availability changed' USING ERRCODE='40001'; END IF;
 expected:=sha256(convert_to(jsonb_build_object('type',t.id,'start',extract(epoch FROM p_start),'person',p_person,'manage',encode(p_manage,'hex'),'local',is_local)::text,'UTF8'));
 SELECT * INTO old FROM app.booking_appointments WHERE workspace_id=ws AND command_key=p_command;
 IF FOUND THEN
  IF old.request_hash<>expected THEN RAISE EXCEPTION 'Booking replay conflict' USING ERRCODE='23505'; END IF;
  RETURN jsonb_build_object('created',false,'id',old.id,'state',old.state);
 END IF;
 IF NOT is_local AND(NOT c.enabled OR(NOT is_owner AND(NOT t.published OR t.archived)) ) THEN RAISE EXCEPTION 'Calendar unavailable' USING ERRCODE='42501'; END IF;
 IF(NOT is_owner AND NOT app_private.booking_slot_allowed(t.settings,c.settings,p_start)) OR p_start IS NULL OR date_trunc('minute',p_start)<>p_start OR NOT isfinite(p_start) THEN RAISE EXCEPTION 'Choose an available time' USING ERRCODE='22023'; END IF;
 FOR question IN SELECT value FROM jsonb_array_elements(t.settings->'questions') LOOP
  answer:=p_person->'answers'->>(question->>'id');
  IF length(answer)>2000 OR(COALESCE((question->>'required')::boolean,false) AND COALESCE(length(btrim(answer)),0)=0) THEN RAISE EXCEPTION 'Check booking answers' USING ERRCODE='22023'; END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM jsonb_each(p_person->'answers') WHERE jsonb_typeof(value)<>'string') THEN RAISE EXCEPTION 'Answers must be text' USING ERRCODE='22023'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_object_keys(p_person->'answers') k WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(t.settings->'questions') q WHERE q->>'id'=k)) THEN RAISE EXCEPTION 'Unknown question' USING ERRCODE='22023'; END IF;
 finish:=p_start+make_interval(mins=>(t.settings->>'durationMinutes')::integer);busy_start:=p_start-make_interval(mins=>(t.settings->>'bufferBeforeMinutes')::integer);busy_end:=finish+make_interval(mins=>(t.settings->>'bufferAfterMinutes')::integer);
 IF EXISTS(SELECT 1 FROM app.booking_appointments a WHERE a.host_user_id=c.host_user_id AND a.state<>'cancelled'
 AND((a.busy_from<busy_end AND busy_start<a.busy_until) OR(a.pending_busy_from<busy_end AND busy_start<a.pending_busy_until))) THEN RAISE EXCEPTION 'That time was just booked' USING ERRCODE='23P01'; END IF;
 IF NOT is_local AND(SELECT count(*) FROM app.booking_appointments WHERE workspace_id=ws AND created_at>clock_timestamp()-interval '1 hour')>=50 THEN RAISE EXCEPTION 'Booking request limit reached' USING ERRCODE='54000'; END IF;
 INSERT INTO app.booking_appointments(workspace_id,host_user_id,meeting_type_id,command_key,request_hash,manage_hash,dispatch_hash,starts_at,ends_at,busy_from,busy_until,person,meeting_snapshot,state)
 VALUES(ws,c.host_user_id,t.id,p_command,expected,p_manage,p_dispatch,p_start,finish,busy_start,busy_end,p_person,t.settings,CASE WHEN is_local THEN 'local' ELSE 'reserved' END) RETURNING * INTO made;
 IF is_local AND NOT EXISTS(SELECT 1 FROM app.investor_businesses WHERE workspace_id=ws AND lower(owner_email)=lower(p_person->>'email')) THEN PERFORM app_private.booking_record_contact(made.id); END IF;
 RETURN jsonb_build_object('created',true,'id',made.id,'state',made.state,'start',made.starts_at,'end',made.ends_at,'type',t.settings);
END $f$;

CREATE FUNCTION app_private.booking_record_contact(p_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE a app.booking_appointments%ROWTYPE;cid uuid;
BEGIN
 SELECT * INTO a FROM app.booking_appointments WHERE id=p_id FOR UPDATE;
 IF NOT FOUND OR a.state NOT IN('confirmed','local') OR a.contact_id IS NOT NULL THEN RETURN; END IF;
 SELECT contact_id INTO cid FROM app.contact_points WHERE workspace_id=a.workspace_id AND kind='email' AND normalized_value=lower(a.person->>'email') AND deleted_at IS NULL AND dedupe_state='normal';
 IF cid IS NULL THEN
  INSERT INTO app.contacts(workspace_id,display_name,source) VALUES(a.workspace_id,a.person->>'name','calendar_booking') RETURNING id INTO cid;
  INSERT INTO app.contact_points(workspace_id,contact_id,kind,value,normalized_value,is_primary) VALUES(a.workspace_id,cid,'email',lower(a.person->>'email'),lower(a.person->>'email'),true);
 END IF;
 INSERT INTO app.activities(workspace_id,contact_id,activity_type,channel,actor_kind,subject,body,metadata,request_id,occurred_at)
 VALUES(a.workspace_id,cid,'calendar.meeting.booked','crm','system',a.meeting_snapshot->>'title','Meeting requested via the booking calendar.',
 jsonb_build_object('appointmentId',a.id,'startsAt',a.starts_at,'endsAt',a.ends_at,'answers',a.person->'answers'),'calendar:'||a.id,clock_timestamp());
 UPDATE app.booking_appointments SET contact_id=cid WHERE id=a.id;
END $f$;

CREATE FUNCTION app_private.booking_settle(p_id uuid,p_dispatch bytea,p_provider text,p_accepted boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
BEGIN
 IF p_accepted IS NULL THEN RAISE EXCEPTION 'Missing provider outcome' USING ERRCODE='22023'; END IF;
 UPDATE app.booking_appointments SET state=CASE WHEN p_accepted THEN 'confirmed' ELSE 'unknown' END,provider_id=CASE WHEN p_accepted THEN p_provider ELSE NULL END,
 updated_at=clock_timestamp(),row_version=row_version+1 WHERE id=p_id AND state='reserved' AND dispatch_hash=p_dispatch;
 IF NOT FOUND THEN RAISE EXCEPTION 'Booking state changed' USING ERRCODE='40001'; END IF;
 IF p_accepted THEN PERFORM app_private.booking_record_contact(p_id); END IF;
END $f$;

CREATE FUNCTION app_private.booking_snapshot(p_session bytea,p_from timestamptz,p_until timestamptz) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE ws uuid;cal jsonb;types jsonb;meetings jsonb;
BEGIN
 ws:=app_private.booking_workspace(p_session);
 IF p_from IS NULL OR p_until IS NULL OR p_until<=p_from OR p_until-p_from>interval '62 days' THEN RAISE EXCEPTION 'Invalid calendar range' USING ERRCODE='22023'; END IF;
 SELECT jsonb_build_object('version',c.row_version,'schedule',c.settings,'connected',c.enabled,'hostId',c.host_user_id) INTO cal FROM app.booking_calendars c WHERE workspace_id=ws;
 SELECT COALESCE(jsonb_agg(t.settings||jsonb_build_object('id',t.id,'slug',t.slug,'version',t.row_version,'published',t.published,'archived',t.archived) ORDER BY t.updated_at DESC),'[]'::jsonb) INTO types FROM app.booking_meeting_types t WHERE workspace_id=ws;
 SELECT COALESCE(jsonb_agg(jsonb_build_object('id',a.id,'meetingTypeId',a.meeting_type_id,'start',a.starts_at,'end',a.ends_at,'state',a.state,'person',a.person,'type',a.meeting_snapshot,'contactId',a.contact_id,'version',a.row_version) ORDER BY a.starts_at,a.id),'[]'::jsonb) INTO meetings
 FROM(SELECT * FROM app.booking_appointments WHERE workspace_id=ws AND starts_at>=p_from AND starts_at<p_until ORDER BY starts_at,id LIMIT 500) a;
 RETURN jsonb_build_object('workspaceId',ws,'calendar',cal,'types',types,'meetings',meetings);
END $f$;

CREATE FUNCTION app_private.booking_receipt(p_slug uuid,p_mhp boolean,p_id uuid,p_manage bytea) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE context jsonb;
BEGIN
 context:=app_private.booking_public_context(p_slug,p_mhp,true);IF context IS NULL THEN RETURN NULL; END IF;
 RETURN(SELECT jsonb_build_object('id',id,'start',starts_at,'end',ends_at,'state',state,'person',person,'type',meeting_snapshot,'version',row_version,'brandName',context->>'brandName')
 FROM app.booking_appointments WHERE id=p_id AND workspace_id=(context->>'workspaceId')::uuid AND meeting_type_id=(context->'type'->>'id')::uuid AND manage_hash=p_manage AND p_manage IS NOT NULL);
END $f$;

CREATE FUNCTION app_private.booking_replay(p_slug uuid,p_mhp boolean,p_command uuid,p_start timestamptz,p_person jsonb,p_manage bytea,p_session bytea DEFAULT NULL,p_external boolean DEFAULT false) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE context jsonb;a app.booking_appointments%ROWTYPE;expected bytea;
BEGIN
 context:=app_private.booking_public_context(p_slug,p_mhp,true);IF context IS NULL OR p_external IS NULL THEN RETURN NULL; END IF;
 IF p_session IS NOT NULL THEN
  IF app_private.booking_workspace(p_session)<>(context->>'workspaceId')::uuid THEN RETURN NULL; END IF;
 ELSIF p_manage IS NULL OR octet_length(p_manage)<>32 THEN RETURN NULL; END IF;
 SELECT * INTO a FROM app.booking_appointments WHERE workspace_id=(context->>'workspaceId')::uuid AND command_key=p_command;
 IF NOT FOUND THEN RETURN NULL; END IF;
 expected:=sha256(convert_to(jsonb_build_object('type',a.meeting_type_id,'start',extract(epoch FROM p_start),'person',p_person,'manage',encode(p_manage,'hex'),'local',p_session IS NOT NULL AND NOT p_external)::text,'UTF8'));
 IF a.meeting_type_id<>(context->'type'->>'id')::uuid OR a.manage_hash IS DISTINCT FROM p_manage OR a.request_hash<>expected THEN RAISE EXCEPTION 'Booking replay conflict' USING ERRCODE='23505'; END IF;
 RETURN jsonb_build_object('id',a.id,'state',a.state);
END $f$;
CREATE FUNCTION app_private.booking_appointment_context(p_slug uuid,p_mhp boolean,p_id uuid,p_manage bytea,p_session bytea) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE context jsonb;
BEGIN
 context:=app_private.booking_public_context(p_slug,p_mhp,true);IF context IS NULL THEN RETURN NULL; END IF;
 IF p_session IS NOT NULL AND app_private.booking_workspace(p_session)<>(context->>'workspaceId')::uuid THEN RETURN NULL; END IF;
 RETURN(SELECT jsonb_build_object('id',id,'start',starts_at,'end',ends_at,'state',state,'type',meeting_snapshot,'person',person,'version',row_version)
 FROM app.booking_appointments WHERE id=p_id AND workspace_id=(context->>'workspaceId')::uuid AND meeting_type_id=(context->'type'->>'id')::uuid
 AND(p_session IS NOT NULL OR(p_manage IS NOT NULL AND manage_hash=p_manage)));
END $f$;

CREATE FUNCTION app_private.booking_change_begin(p_slug uuid,p_mhp boolean,p_id uuid,p_manage bytea,p_session bytea,p_action text,p_start timestamptz,p_version bigint,p_dispatch bytea) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE context jsonb;a app.booking_appointments%ROWTYPE;c app.booking_calendars%ROWTYPE;new_end timestamptz;new_from timestamptz;new_until timestamptz;
BEGIN
 context:=app_private.booking_public_context(p_slug,p_mhp,true);IF context IS NULL THEN RAISE EXCEPTION 'Meeting unavailable' USING ERRCODE='42501'; END IF;
 IF p_session IS NOT NULL THEN
  IF app_private.booking_workspace(p_session)<>(context->>'workspaceId')::uuid THEN RAISE EXCEPTION 'Meeting unavailable' USING ERRCODE='42501'; END IF;
 ELSIF p_manage IS NULL OR octet_length(p_manage)<>32 THEN RAISE EXCEPTION 'Meeting unavailable' USING ERRCODE='42501'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('booking-host:'||(context->>'hostId'),138));
 SELECT * INTO a FROM app.booking_appointments WHERE id=p_id AND workspace_id=(context->>'workspaceId')::uuid AND meeting_type_id=(context->'type'->>'id')::uuid
 AND(p_session IS NOT NULL OR manage_hash=p_manage) FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Meeting unavailable' USING ERRCODE='42501'; END IF;
 IF a.state='cancelled' AND p_action='cancel' THEN RETURN jsonb_build_object('state','cancelled','local',true); END IF;
 IF p_action IS NULL OR p_action NOT IN('cancel','move') OR(p_action='cancel' AND p_start IS NOT NULL) OR p_version IS NULL OR a.row_version<>p_version OR a.state NOT IN('local','confirmed')
 OR p_dispatch IS NULL OR octet_length(p_dispatch)<>32 THEN RAISE EXCEPTION 'Meeting changed; refresh before continuing' USING ERRCODE='40001'; END IF;
 SELECT * INTO c FROM app.booking_calendars WHERE workspace_id=a.workspace_id FOR UPDATE;
 IF p_action='move' THEN
  IF p_start IS NULL OR NOT isfinite(p_start) OR date_trunc('minute',p_start)<>p_start OR(p_session IS NULL AND NOT app_private.booking_slot_allowed(a.meeting_snapshot,c.settings,p_start)) THEN RAISE EXCEPTION 'Choose an available time' USING ERRCODE='22023'; END IF;
  new_end:=p_start+make_interval(mins=>(a.meeting_snapshot->>'durationMinutes')::integer);
  new_from:=p_start-make_interval(mins=>(a.meeting_snapshot->>'bufferBeforeMinutes')::integer);
  new_until:=new_end+make_interval(mins=>(a.meeting_snapshot->>'bufferAfterMinutes')::integer);
  IF EXISTS(SELECT 1 FROM app.booking_appointments b WHERE b.host_user_id=a.host_user_id AND b.id<>a.id AND b.state<>'cancelled'
   AND((b.busy_from<new_until AND new_from<b.busy_until) OR(b.pending_busy_from<new_until AND new_from<b.pending_busy_until))) THEN RAISE EXCEPTION 'That time was just booked' USING ERRCODE='23P01'; END IF;
 END IF;
 IF a.state='local' THEN
  UPDATE app.booking_appointments SET state=CASE WHEN p_action='cancel' THEN 'cancelled' ELSE 'local' END,
   starts_at=COALESCE(p_start,starts_at),ends_at=COALESCE(new_end,ends_at),busy_from=COALESCE(new_from,busy_from),busy_until=COALESCE(new_until,busy_until),row_version=row_version+1,updated_at=clock_timestamp() WHERE id=a.id;
 ELSE
  UPDATE app.booking_appointments SET state=CASE WHEN p_action='cancel' THEN 'cancelling' ELSE 'rescheduling' END,dispatch_hash=p_dispatch,
   pending_start=p_start,pending_end=new_end,pending_busy_from=new_from,pending_busy_until=new_until,row_version=row_version+1,updated_at=clock_timestamp() WHERE id=a.id;
 END IF;
 RETURN jsonb_build_object('local',a.state='local','state',CASE WHEN p_action='cancel' THEN 'cancelling' ELSE 'rescheduling' END,'providerId',a.provider_id,'person',a.person,'type',a.meeting_snapshot,'start',p_start,'end',new_end);
END $f$;
CREATE FUNCTION app_private.booking_change_settle(p_id uuid,p_dispatch bytea,p_accepted boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE a app.booking_appointments%ROWTYPE;
BEGIN
 SELECT * INTO a FROM app.booking_appointments WHERE id=p_id AND dispatch_hash=p_dispatch AND state IN('cancelling','rescheduling') FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Meeting operation changed' USING ERRCODE='40001'; END IF;
 IF p_accepted IS NOT TRUE THEN RETURN; END IF;
 UPDATE app.booking_appointments SET state=CASE WHEN a.state='cancelling' THEN 'cancelled' ELSE 'confirmed' END,
 starts_at=COALESCE(pending_start,starts_at),ends_at=COALESCE(pending_end,ends_at),busy_from=COALESCE(pending_busy_from,busy_from),busy_until=COALESCE(pending_busy_until,busy_until),
 pending_start=NULL,pending_end=NULL,pending_busy_from=NULL,pending_busy_until=NULL,row_version=row_version+1,updated_at=clock_timestamp() WHERE id=a.id;
 IF a.contact_id IS NOT NULL THEN
  INSERT INTO app.activities(workspace_id,contact_id,activity_type,channel,actor_kind,subject,body,metadata,request_id,occurred_at)
  VALUES(a.workspace_id,a.contact_id,CASE WHEN a.state='cancelling' THEN 'calendar.meeting.cancelled' ELSE 'calendar.meeting.rescheduled' END,'crm','system',a.meeting_snapshot->>'title',
   CASE WHEN a.state='cancelling' THEN 'Calendar cancellation confirmed.' ELSE 'Calendar rescheduling confirmed.' END,
   jsonb_build_object('appointmentId',a.id,'startsAt',COALESCE(a.pending_start,a.starts_at)),'calendar-change:'||a.id||':'||a.row_version,clock_timestamp());
 END IF;
END $f$;

-- Public reads reveal only published type/availability. Command connection alone
-- can open the already-authorised calendar vault; no browser sees a credential.
REVOKE ALL ON FUNCTION app_private.booking_workspace(bytea),app_private.booking_validate_type(jsonb),app_private.booking_save_calendar(bytea,bigint,jsonb),app_private.booking_save_type(bytea,uuid,uuid,bigint,jsonb,boolean,boolean),
 app_private.booking_connect_calendar(bytea,bigint,text,text,text),app_private.booking_public_context(uuid,boolean,boolean),app_private.booking_public_page(uuid,boolean,timestamptz,timestamptz),
 app_private.booking_calendar_secret(uuid,boolean),app_private.booking_refresh_calendar(uuid,boolean,bigint,bytea,text),app_private.booking_slot_allowed(jsonb,jsonb,timestamptz),
 app_private.booking_hold(uuid,boolean,uuid,timestamptz,jsonb,bytea,bytea,bigint,bigint,bytea,boolean),app_private.booking_record_contact(uuid),app_private.booking_settle(uuid,bytea,text,boolean),
 app_private.booking_snapshot(bytea,timestamptz,timestamptz),app_private.booking_receipt(uuid,boolean,uuid,bytea),
 app_private.booking_change_begin(uuid,boolean,uuid,bytea,bytea,text,timestamptz,bigint,bytea),app_private.booking_change_settle(uuid,bytea,boolean),
 app_private.booking_replay(uuid,boolean,uuid,timestamptz,jsonb,bytea,bytea,boolean),app_private.booking_appointment_context(uuid,boolean,uuid,bytea,bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.booking_public_page(uuid,boolean,timestamptz,timestamptz),app_private.booking_snapshot(bytea,timestamptz,timestamptz) TO r72_web;
GRANT EXECUTE ON FUNCTION app_private.booking_save_calendar(bytea,bigint,jsonb),app_private.booking_save_type(bytea,uuid,uuid,bigint,jsonb,boolean,boolean),app_private.booking_connect_calendar(bytea,bigint,text,text,text),
 app_private.booking_public_page(uuid,boolean,timestamptz,timestamptz),app_private.booking_calendar_secret(uuid,boolean),app_private.booking_refresh_calendar(uuid,boolean,bigint,bytea,text),
 app_private.booking_hold(uuid,boolean,uuid,timestamptz,jsonb,bytea,bytea,bigint,bigint,bytea,boolean),app_private.booking_settle(uuid,bytea,text,boolean),
 app_private.booking_receipt(uuid,boolean,uuid,bytea),app_private.booking_change_begin(uuid,boolean,uuid,bytea,bytea,text,timestamptz,bigint,bytea),app_private.booking_change_settle(uuid,bytea,boolean),
 app_private.booking_replay(uuid,boolean,uuid,timestamptz,jsonb,bytea,bytea,boolean),app_private.booking_appointment_context(uuid,boolean,uuid,bytea,bytea) TO r72_identity_command;
RESET ROLE;
