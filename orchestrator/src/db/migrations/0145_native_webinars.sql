-- Native multi-brand webinars (Cloudflare Stream video). Additive only.
--
-- One webinar belongs to exactly one canonical app.workspaces row (= one brand).
-- Records are workspace-scoped with FORCED RLS for the existing
-- r72_content_command identity, exactly like the SEO blog engine (0131):
--   * user actor:   workspace = app.workspace_id AND can_manage_workspace(user, workspace)
--   * worker actor: workspace = app.workspace_id
-- Attendees never get a database identity. Their actions go through narrow
-- SECURITY DEFINER functions keyed by the event's public key plus a registration
-- id and token version; the application verifies the HMAC access token before
-- calling them, and every function re-checks status, version and rate limits.
--
-- No provider effect happens in SQL. Provider calls are recorded as durable jobs
-- whose interrupted state is 'unknown' (never blindly retried), so an uncertain
-- Cloudflare call cannot create a duplicate live input or a duplicate email.

SET LOCAL ROLE r72_owner;

CREATE TABLE app.webinar_events (
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE RESTRICT,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  public_key text NOT NULL UNIQUE CHECK (public_key ~ '^[a-z0-9][a-z0-9-]{2,70}[a-z0-9]$'),
  kind text NOT NULL CHECK (kind IN ('live', 'on_demand', 'scheduled_recording')),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'cancelled', 'archived')),
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 2 AND 160 AND title !~ '[[:cntrl:]]'),
  summary text NOT NULL DEFAULT '' CHECK (length(summary) <= 4000),
  presenter_name text NOT NULL DEFAULT '' CHECK (length(presenter_name) <= 120 AND presenter_name !~ '[[:cntrl:]]'),
  presenter_title text NOT NULL DEFAULT '' CHECK (length(presenter_title) <= 160 AND presenter_title !~ '[[:cntrl:]]'),
  timezone text NOT NULL CHECK (length(timezone) BETWEEN 1 AND 64),
  starts_at timestamptz,
  duration_minutes integer NOT NULL CHECK (duration_minutes BETWEEN 5 AND 480),
  capacity integer CHECK (capacity IS NULL OR capacity BETWEEN 1 AND 100000),
  -- Registration questions, consent wording, CTA, replay window, reminder offsets,
  -- CRM mapping and presentation overrides. Shape is validated in the application.
  settings jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(settings) = 'object' AND octet_length(settings::text) <= 20000),
  -- Bumped on every reschedule so stale reminder jobs can never be sent.
  schedule_version integer NOT NULL DEFAULT 1 CHECK (schedule_version > 0),
  video_uid text CHECK (video_uid IS NULL OR video_uid ~ '^[0-9a-f]{32}$'),
  video_state text NOT NULL DEFAULT 'none' CHECK (video_state IN ('none', 'awaiting_upload', 'processing', 'ready', 'failed')),
  video_duration_seconds numeric(10, 3) CHECK (video_duration_seconds IS NULL OR video_duration_seconds >= 0),
  video_detail text CHECK (video_detail IS NULL OR length(video_detail) <= 300),
  live_input_uid text CHECK (live_input_uid IS NULL OR live_input_uid ~ '^[0-9a-f]{32}$'),
  live_state text NOT NULL DEFAULT 'not_provisioned' CHECK (live_state IN (
    'not_provisioned', 'provisioning', 'idle', 'connected', 'reconnecting', 'disconnected', 'unknown')),
  live_checked_at timestamptz,
  -- The host decides when attendees see the broadcast; a connected encoder alone is a rehearsal.
  session_state text NOT NULL DEFAULT 'scheduled' CHECK (session_state IN ('scheduled', 'live', 'ended')),
  session_started_at timestamptz,
  session_ended_at timestamptz,
  recording_uid text CHECK (recording_uid IS NULL OR recording_uid ~ '^[0-9a-f]{32}$'),
  recording_state text NOT NULL DEFAULT 'none' CHECK (recording_state IN ('none', 'processing', 'ready', 'failed', 'not_recorded')),
  recording_duration_seconds numeric(10, 3) CHECK (recording_duration_seconds IS NULL OR recording_duration_seconds >= 0),
  cta_revealed_at timestamptz,
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
  created_by_user_id uuid REFERENCES app.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, id),
  CHECK (status = 'draft' OR kind = 'on_demand' OR starts_at IS NOT NULL),
  CHECK (session_ended_at IS NULL OR session_started_at IS NULL OR session_ended_at >= session_started_at)
);
-- One provider resource binds to one webinar, so a webhook can never touch another brand.
CREATE UNIQUE INDEX webinar_events_video_uid_key ON app.webinar_events (video_uid) WHERE video_uid IS NOT NULL;
CREATE UNIQUE INDEX webinar_events_live_input_key ON app.webinar_events (live_input_uid) WHERE live_input_uid IS NOT NULL;
CREATE UNIQUE INDEX webinar_events_recording_uid_key ON app.webinar_events (recording_uid) WHERE recording_uid IS NOT NULL;
CREATE INDEX webinar_events_upcoming_idx ON app.webinar_events (workspace_id, starts_at) WHERE status = 'published';

CREATE TABLE app.webinar_registrations (
  workspace_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL,
  email text NOT NULL CHECK (email = lower(btrim(email)) AND length(email) BETWEEN 3 AND 320
    AND email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120 AND name !~ '[[:cntrl:]]'),
  answers jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(answers) = 'object' AND octet_length(answers::text) <= 8000),
  -- Registering requests event-service messages only. Marketing needs this explicit opt-in.
  marketing_consent boolean NOT NULL DEFAULT false,
  consent jsonb NOT NULL CHECK (jsonb_typeof(consent) = 'object' AND octet_length(consent::text) <= 4000),
  attribution jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(attribution) = 'object' AND octet_length(attribution::text) <= 4000),
  -- Access links are HMAC(registration id, version); bumping the version revokes old links.
  token_version integer NOT NULL DEFAULT 1 CHECK (token_version > 0),
  status text NOT NULL DEFAULT 'registered' CHECK (status IN ('registered', 'cancelled')),
  crm_contact_id uuid,
  crm_opportunity_id uuid,
  crm_linked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, event_id, email),
  FOREIGN KEY (workspace_id, event_id) REFERENCES app.webinar_events(workspace_id, id) ON DELETE RESTRICT
);
CREATE INDEX webinar_registrations_event_idx ON app.webinar_registrations (workspace_id, event_id, created_at);

-- Provenance-labelled viewing evidence. A page load is 'room_accessed', not attendance.
CREATE TABLE app.webinar_signals (
  workspace_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL,
  registration_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('room_accessed', 'player_started', 'watch_interval', 'cta_clicked', 'question_submitted')),
  mode text NOT NULL CHECK (mode IN ('waiting', 'live', 'scheduled_recording', 'replay', 'on_demand')),
  from_seconds numeric(10, 3),
  to_seconds numeric(10, 3),
  observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, registration_id) REFERENCES app.webinar_registrations(workspace_id, id) ON DELETE RESTRICT,
  CHECK ((kind = 'watch_interval') = (from_seconds IS NOT NULL AND to_seconds IS NOT NULL)),
  CHECK (kind <> 'watch_interval' OR (from_seconds >= 0 AND to_seconds > from_seconds AND to_seconds - from_seconds <= 120))
);
CREATE INDEX webinar_signals_event_idx ON app.webinar_signals (workspace_id, event_id, kind);
CREATE INDEX webinar_signals_registration_idx ON app.webinar_signals (workspace_id, registration_id, observed_at DESC);

CREATE TABLE app.webinar_questions (
  workspace_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL,
  registration_id uuid NOT NULL,
  body text NOT NULL CHECK (length(btrim(body)) BETWEEN 1 AND 500),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'answered', 'dismissed')),
  answer text CHECK (answer IS NULL OR length(answer) <= 2000),
  moderated_by_user_id uuid REFERENCES app.users(id) ON DELETE RESTRICT,
  moderated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, registration_id) REFERENCES app.webinar_registrations(workspace_id, id) ON DELETE RESTRICT
);
CREATE INDEX webinar_questions_event_idx ON app.webinar_questions (workspace_id, event_id, created_at);

-- Durable work: messages and provider operations. Unique dedupe keys make enqueue
-- idempotent; 'calling' interrupted by a crash becomes 'unknown' and is never resent.
CREATE TABLE app.webinar_jobs (
  workspace_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL,
  registration_id uuid,
  kind text NOT NULL CHECK (kind IN ('message', 'provision_live_input', 'reconcile_video', 'reconcile_live', 'reconcile_recording')),
  purpose text CHECK (purpose IS NULL OR purpose IN (
    'confirmation', 'reminder', 'reschedule', 'cancellation', 'replay_available', 'access_link')),
  dedupe_key text NOT NULL CHECK (length(dedupe_key) BETWEEN 3 AND 200),
  schedule_version integer,
  state text NOT NULL DEFAULT 'queued' CHECK (state IN (
    'queued', 'leased', 'calling', 'done', 'unknown', 'failed', 'cancelled', 'expired', 'blocked')),
  run_after timestamptz NOT NULL,
  expires_at timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 50),
  lease_token uuid,
  lease_until timestamptz,
  detail text CHECK (detail IS NULL OR length(detail) <= 500),
  result jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(result) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, dedupe_key),
  FOREIGN KEY (workspace_id, event_id) REFERENCES app.webinar_events(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, registration_id) REFERENCES app.webinar_registrations(workspace_id, id) ON DELETE RESTRICT,
  CHECK ((kind = 'message') = (purpose IS NOT NULL AND registration_id IS NOT NULL))
);
CREATE INDEX webinar_jobs_due_idx ON app.webinar_jobs (run_after) WHERE state IN ('queued', 'leased', 'calling');
CREATE INDEX webinar_jobs_event_idx ON app.webinar_jobs (workspace_id, event_id, kind, state);

-- Provider webhook replay protection (signed body hash). Not workspace data.
CREATE TABLE app.webinar_provider_receipts (
  provider text NOT NULL CHECK (provider = 'cloudflare_stream'),
  receipt_sha256 bytea NOT NULL CHECK (octet_length(receipt_sha256) = 32),
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (provider, receipt_sha256)
);

-- Row-level security.
DO $rls$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['webinar_events', 'webinar_registrations', 'webinar_signals', 'webinar_questions', 'webinar_jobs', 'webinar_provider_receipts']
  LOOP
    EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON app.%I FROM PUBLIC', t);
    EXECUTE format('CREATE POLICY %I ON app.%I FOR ALL TO r72_owner USING (true) WITH CHECK (true)', t || '_owner', t);
    IF t <> 'webinar_provider_receipts' THEN
      EXECUTE format($p$CREATE POLICY %I ON app.%I FOR ALL TO r72_content_command
        USING (workspace_id = app_private.current_workspace_id() AND (
          (app_private.current_actor_kind() = 'user' AND app_private.can_manage_workspace(app_private.current_user_id(), workspace_id))
          OR app_private.current_actor_kind() = 'worker'))
        WITH CHECK (workspace_id = app_private.current_workspace_id() AND (
          (app_private.current_actor_kind() = 'user' AND app_private.can_manage_workspace(app_private.current_user_id(), workspace_id))
          OR app_private.current_actor_kind() = 'worker'))$p$, t || '_content', t);
    END IF;
  END LOOP;
END $rls$;

GRANT SELECT, INSERT, UPDATE ON app.webinar_events, app.webinar_registrations, app.webinar_questions, app.webinar_jobs TO r72_content_command;
GRANT SELECT ON app.webinar_signals TO r72_content_command;

INSERT INTO app_private.workspace_table_registry (schema_name, table_name, workspace_column)
SELECT 'app', t, 'workspace_id' FROM unnest(ARRAY['webinar_events', 'webinar_registrations', 'webinar_signals',
  'webinar_questions', 'webinar_jobs']) AS t;

-- The selected workspace's own name, timezone and branding for the portal and worker.
-- r72_content_command has no direct read on app.workspaces; this exposes only the
-- current workspace, only to an active member (or the worker), plus the manage flag.
CREATE FUNCTION app_private.webinar_workspace_profile()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $f$
  SELECT jsonb_build_object('workspaceId', w.id, 'name', w.name, 'slug', w.slug::text, 'timezone', w.timezone, 'locale', w.locale,
    'canManage', app_private.current_actor_kind() = 'user' AND app_private.can_manage_workspace(app_private.current_user_id(), w.id),
    'productName', b.product_name, 'primaryColor', b.primary_color, 'accentColor', b.accent_color, 'supportEmail', b.support_email::text)
  FROM app.workspaces w
  LEFT JOIN app.organization_branding b ON b.organization_id = w.organization_id
  WHERE w.id = app_private.current_workspace_id() AND w.status = 'active'
    AND ((app_private.current_actor_kind() = 'user'
          AND app_private.has_active_workspace_membership(app_private.current_user_id(), w.id))
      OR app_private.current_actor_kind() = 'worker')
$f$;

-- ── Public (attendee) boundary ───────────────────────────────────────────────

-- Published or cancelled event by public key, with the owning brand's presentation.
CREATE FUNCTION app_private.webinar_public_event(p_public_key text)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $f$
  SELECT jsonb_build_object(
    'workspaceId', e.workspace_id, 'id', e.id, 'publicKey', e.public_key, 'kind', e.kind, 'status', e.status,
    'title', e.title, 'summary', e.summary, 'presenterName', e.presenter_name, 'presenterTitle', e.presenter_title,
    'timezone', e.timezone, 'startsAt', e.starts_at, 'durationMinutes', e.duration_minutes, 'capacity', e.capacity,
    'settings', e.settings, 'scheduleVersion', e.schedule_version,
    'videoUid', e.video_uid, 'videoState', e.video_state, 'videoDurationSeconds', e.video_duration_seconds,
    'liveInputUid', e.live_input_uid, 'liveState', e.live_state, 'liveCheckedAt', e.live_checked_at,
    'sessionState', e.session_state, 'sessionStartedAt', e.session_started_at, 'sessionEndedAt', e.session_ended_at,
    'recordingUid', e.recording_uid, 'recordingState', e.recording_state, 'recordingDurationSeconds', e.recording_duration_seconds,
    'ctaRevealedAt', e.cta_revealed_at,
    'registered', (SELECT count(*) FROM app.webinar_registrations r
                    WHERE r.workspace_id = e.workspace_id AND r.event_id = e.id AND r.status = 'registered'),
    'brand', jsonb_build_object('workspaceName', w.name, 'productName', b.product_name,
      'primaryColor', b.primary_color, 'accentColor', b.accent_color, 'supportEmail', b.support_email::text))
  FROM app.webinar_events e
  JOIN app.workspaces w ON w.id = e.workspace_id AND w.status = 'active'
  LEFT JOIN app.organization_branding b ON b.organization_id = w.organization_id
  WHERE e.public_key = p_public_key AND e.status IN ('published', 'cancelled')
$f$;

-- Enqueue service messages for one registration at the event's current schedule version.
-- Steps already in the past are skipped rather than sent late.
CREATE FUNCTION app_private.webinar_enqueue_registration_messages(p_workspace uuid, p_event uuid, p_registration uuid, p_now timestamptz, p_include_confirmation boolean)
RETURNS integer LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $f$
DECLARE
  e app.webinar_events%ROWTYPE;
  offset_minutes integer;
  due timestamptz;
  n integer := 0;
  inserted integer;
BEGIN
  SELECT * INTO e FROM app.webinar_events WHERE workspace_id = p_workspace AND id = p_event;
  IF NOT FOUND OR e.status <> 'published' THEN RETURN 0; END IF;
  IF p_include_confirmation THEN
    INSERT INTO app.webinar_jobs (workspace_id, event_id, registration_id, kind, purpose, dedupe_key, schedule_version, run_after, expires_at)
    VALUES (p_workspace, p_event, p_registration, 'message', 'confirmation',
      'msg:' || p_registration::text || ':confirmation', e.schedule_version, p_now,
      -- Someone registering for the replay after the event still gets their link.
      GREATEST(p_now + interval '2 days', coalesce(e.starts_at + make_interval(mins => e.duration_minutes), p_now)))
    ON CONFLICT (workspace_id, dedupe_key) DO NOTHING;
    GET DIAGNOSTICS inserted = ROW_COUNT; n := n + inserted;
  END IF;
  IF e.kind <> 'on_demand' AND e.starts_at IS NOT NULL THEN
    FOR offset_minutes IN
      SELECT DISTINCT (x)::integer FROM jsonb_array_elements_text(
        CASE WHEN jsonb_typeof(e.settings -> 'reminderOffsetsMinutes') = 'array'
             THEN e.settings -> 'reminderOffsetsMinutes' ELSE '[1440, 60]'::jsonb END) AS x
      WHERE x ~ '^[0-9]{1,5}$' AND (x)::integer BETWEEN 5 AND 10080
    LOOP
      due := e.starts_at - make_interval(mins => offset_minutes);
      CONTINUE WHEN due <= p_now;
      INSERT INTO app.webinar_jobs (workspace_id, event_id, registration_id, kind, purpose, dedupe_key, schedule_version, run_after, expires_at)
      VALUES (p_workspace, p_event, p_registration, 'message', 'reminder',
        'msg:' || p_registration::text || ':reminder:' || offset_minutes::text || ':v' || e.schedule_version::text,
        e.schedule_version, due, e.starts_at)
      ON CONFLICT (workspace_id, dedupe_key) DO NOTHING;
      GET DIAGNOSTICS inserted = ROW_COUNT; n := n + inserted;
    END LOOP;
  END IF;
  RETURN n;
END $f$;

-- Manager/worker path after a reschedule or a re-publish: re-enqueue messages for every
-- registration at the current schedule version. Context-checked; never cross-workspace.
CREATE FUNCTION app_private.webinar_requeue_event_messages(p_event uuid, p_now timestamptz)
RETURNS integer LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $f$
DECLARE
  ws uuid := app_private.current_workspace_id();
  r record;
  n integer := 0;
BEGIN
  IF ws IS NULL OR NOT (
       (app_private.current_actor_kind() = 'user' AND app_private.can_manage_workspace(app_private.current_user_id(), ws))
       OR app_private.current_actor_kind() = 'worker') THEN
    RAISE EXCEPTION 'Webinar unavailable' USING ERRCODE = '42501';
  END IF;
  FOR r IN SELECT id FROM app.webinar_registrations WHERE workspace_id = ws AND event_id = p_event AND status = 'registered' LOOP
    n := n + app_private.webinar_enqueue_registration_messages(ws, p_event, r.id, p_now, false);
  END LOOP;
  RETURN n;
END $f$;

-- Register (or find) one attendee. Idempotent per (event, email): a retry or repeat
-- never creates a second registration or a second confirmation.
CREATE FUNCTION app_private.webinar_register(p_public_key text, p_email text, p_name text, p_answers jsonb,
  p_marketing boolean, p_consent jsonb, p_attribution jsonb, p_now timestamptz)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $f$
DECLARE
  e app.webinar_events%ROWTYPE;
  existing app.webinar_registrations%ROWTYPE;
  reg uuid;
  taken integer;
  v_email text := lower(btrim(coalesce(p_email, '')));
BEGIN
  SELECT * INTO e FROM app.webinar_events WHERE public_key = p_public_key FOR UPDATE;
  IF NOT FOUND OR e.status <> 'published' THEN
    RETURN jsonb_build_object('outcome', 'unavailable');
  END IF;
  IF e.kind <> 'on_demand' AND e.starts_at + make_interval(mins => e.duration_minutes) <= p_now
     AND NOT coalesce((e.settings -> 'replay' ->> 'enabled')::boolean, false) THEN
    RETURN jsonb_build_object('outcome', 'closed');
  END IF;
  SELECT * INTO existing FROM app.webinar_registrations
   WHERE workspace_id = e.workspace_id AND event_id = e.id AND email = v_email;
  IF FOUND THEN
    RETURN jsonb_build_object('outcome', 'existing', 'workspaceId', e.workspace_id, 'eventId', e.id,
      'registrationId', existing.id, 'tokenVersion', existing.token_version, 'status', existing.status);
  END IF;
  IF e.capacity IS NOT NULL THEN
    SELECT count(*) INTO taken FROM app.webinar_registrations
     WHERE workspace_id = e.workspace_id AND event_id = e.id AND status = 'registered';
    IF taken >= e.capacity THEN RETURN jsonb_build_object('outcome', 'full'); END IF;
  END IF;
  INSERT INTO app.webinar_registrations (workspace_id, event_id, email, name, answers, marketing_consent, consent, attribution)
  VALUES (e.workspace_id, e.id, v_email, btrim(p_name), coalesce(p_answers, '{}'::jsonb), coalesce(p_marketing, false),
    p_consent, coalesce(p_attribution, '{}'::jsonb))
  RETURNING id INTO reg;
  PERFORM app_private.webinar_enqueue_registration_messages(e.workspace_id, e.id, reg, p_now, true);
  RETURN jsonb_build_object('outcome', 'created', 'workspaceId', e.workspace_id, 'eventId', e.id,
    'registrationId', reg, 'tokenVersion', 1, 'status', 'registered');
END $f$;

-- Re-send the access link to the registered address only (the link itself is deterministic,
-- so nothing is revoked and a stranger typing someone's email cannot lock them out).
-- At most one link per registration per ten minutes, so this cannot be used to spam.
CREATE FUNCTION app_private.webinar_request_access_link(p_public_key text, p_email text, p_now timestamptz)
RETURNS text LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $f$
DECLARE
  e app.webinar_events%ROWTYPE;
  r app.webinar_registrations%ROWTYPE;
BEGIN
  SELECT * INTO e FROM app.webinar_events WHERE public_key = p_public_key AND status = 'published';
  IF NOT FOUND THEN RETURN 'unavailable'; END IF;
  SELECT * INTO r FROM app.webinar_registrations
   WHERE workspace_id = e.workspace_id AND event_id = e.id AND email = lower(btrim(coalesce(p_email, ''))) AND status = 'registered'
   FOR UPDATE;
  -- Same answer whether or not the address is registered: no enumeration.
  IF NOT FOUND THEN RETURN 'accepted'; END IF;
  IF EXISTS (SELECT 1 FROM app.webinar_jobs j WHERE j.workspace_id = e.workspace_id AND j.registration_id = r.id
             AND j.purpose = 'access_link' AND j.created_at > p_now - interval '10 minutes') THEN
    RETURN 'accepted';
  END IF;
  INSERT INTO app.webinar_jobs (workspace_id, event_id, registration_id, kind, purpose, dedupe_key, schedule_version, run_after, expires_at)
  VALUES (e.workspace_id, e.id, r.id, 'message', 'access_link',
    'msg:' || r.id::text || ':access_link:' || floor(extract(epoch FROM p_now) / 600)::bigint::text, e.schedule_version, p_now, p_now + interval '1 day')
  ON CONFLICT (workspace_id, dedupe_key) DO NOTHING;
  RETURN 'accepted';
END $f$;

-- Attendee view: only for a live registration whose link version is current.
CREATE FUNCTION app_private.webinar_attendee(p_public_key text, p_registration uuid, p_token_version integer)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $f$
  SELECT jsonb_build_object('registrationId', r.id, 'name', r.name, 'email', r.email, 'status', r.status,
    'createdAt', r.created_at, 'event', app_private.webinar_public_event(p_public_key))
  FROM app.webinar_events e
  JOIN app.webinar_registrations r ON r.workspace_id = e.workspace_id AND r.event_id = e.id
  WHERE e.public_key = p_public_key AND e.status IN ('published', 'cancelled')
    AND r.id = p_registration AND r.token_version = p_token_version AND r.status = 'registered'
$f$;

-- Provenance signals. Bounded per registration so a script cannot inflate attendance.
CREATE FUNCTION app_private.webinar_record_signal(p_public_key text, p_registration uuid, p_token_version integer,
  p_kind text, p_mode text, p_from numeric, p_to numeric, p_now timestamptz)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $f$
DECLARE
  e app.webinar_events%ROWTYPE;
  recent integer;
BEGIN
  IF p_kind NOT IN ('room_accessed', 'player_started', 'watch_interval', 'cta_clicked')
     OR p_mode NOT IN ('waiting', 'live', 'scheduled_recording', 'replay', 'on_demand') THEN
    RETURN false;
  END IF;
  SELECT ev.* INTO e FROM app.webinar_events ev
   JOIN app.webinar_registrations r ON r.workspace_id = ev.workspace_id AND r.event_id = ev.id
   WHERE ev.public_key = p_public_key AND ev.status = 'published'
     AND r.id = p_registration AND r.token_version = p_token_version AND r.status = 'registered';
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('webinar-signal:' || p_registration::text, 144));
  IF p_kind = 'watch_interval' THEN
    IF p_from IS NULL OR p_to IS NULL OR p_from < 0 OR p_to <= p_from OR p_to - p_from > 120 THEN RETURN false; END IF;
    -- Real time is the ceiling: intervals may not arrive faster than they could be watched.
    SELECT count(*) INTO recent FROM app.webinar_signals s
     WHERE s.workspace_id = e.workspace_id AND s.registration_id = p_registration AND s.kind = 'watch_interval'
       AND s.observed_at > p_now - interval '20 seconds';
    IF recent > 0 THEN RETURN false; END IF;
  ELSE
    SELECT count(*) INTO recent FROM app.webinar_signals s
     WHERE s.workspace_id = e.workspace_id AND s.registration_id = p_registration AND s.kind = p_kind
       AND s.observed_at > p_now - CASE p_kind WHEN 'cta_clicked' THEN interval '10 seconds' ELSE interval '30 minutes' END;
    IF recent > 0 THEN RETURN false; END IF;
  END IF;
  INSERT INTO app.webinar_signals (workspace_id, event_id, registration_id, kind, mode, from_seconds, to_seconds, observed_at)
  VALUES (e.workspace_id, e.id, p_registration, p_kind, p_mode,
    CASE WHEN p_kind = 'watch_interval' THEN p_from END, CASE WHEN p_kind = 'watch_interval' THEN p_to END, p_now);
  RETURN true;
END $f$;

-- Questions: rate-limited per registration, pending until a host approves them
-- (unless the event is configured for unmoderated questions).
CREATE FUNCTION app_private.webinar_submit_question(p_public_key text, p_registration uuid, p_token_version integer, p_body text, p_now timestamptz)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $f$
DECLARE
  e app.webinar_events%ROWTYPE;
  recent integer;
  total integer;
  qid uuid;
  v_body text := btrim(coalesce(p_body, ''));
BEGIN
  IF length(v_body) NOT BETWEEN 1 AND 500 THEN RETURN jsonb_build_object('outcome', 'invalid'); END IF;
  SELECT ev.* INTO e FROM app.webinar_events ev
   JOIN app.webinar_registrations r ON r.workspace_id = ev.workspace_id AND r.event_id = ev.id
   WHERE ev.public_key = p_public_key AND ev.status = 'published'
     AND r.id = p_registration AND r.token_version = p_token_version AND r.status = 'registered';
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome', 'unavailable'); END IF;
  IF coalesce((e.settings ->> 'questionsEnabled')::boolean, true) IS NOT TRUE THEN
    RETURN jsonb_build_object('outcome', 'closed');
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('webinar-question:' || p_registration::text, 144));
  SELECT count(*) FILTER (WHERE q.created_at > p_now - interval '5 minutes'), count(*) INTO recent, total
    FROM app.webinar_questions q WHERE q.workspace_id = e.workspace_id AND q.registration_id = p_registration;
  IF recent >= 3 OR total >= 20 THEN RETURN jsonb_build_object('outcome', 'rate_limited'); END IF;
  INSERT INTO app.webinar_questions (workspace_id, event_id, registration_id, body, status, created_at)
  VALUES (e.workspace_id, e.id, p_registration, v_body,
    CASE WHEN coalesce((e.settings ->> 'questionsModerated')::boolean, true) THEN 'pending' ELSE 'approved' END, p_now)
  RETURNING id INTO qid;
  INSERT INTO app.webinar_signals (workspace_id, event_id, registration_id, kind, mode, observed_at)
  VALUES (e.workspace_id, e.id, p_registration, 'question_submitted',
    CASE WHEN e.kind = 'on_demand' THEN 'on_demand' WHEN e.session_state = 'live' THEN 'live' ELSE 'waiting' END, p_now);
  RETURN jsonb_build_object('outcome', 'accepted', 'questionId', qid);
END $f$;

-- What an attendee may see: approved/answered questions, plus their own (any state).
CREATE FUNCTION app_private.webinar_public_questions(p_public_key text, p_registration uuid, p_token_version integer)
RETURNS SETOF jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $f$
  SELECT jsonb_build_object('id', q.id, 'body', q.body, 'status', q.status, 'answer', q.answer,
    'mine', q.registration_id = p_registration, 'createdAt', q.created_at)
  FROM app.webinar_events e
  JOIN app.webinar_registrations me ON me.workspace_id = e.workspace_id AND me.event_id = e.id
   AND me.id = p_registration AND me.token_version = p_token_version AND me.status = 'registered'
  JOIN app.webinar_questions q ON q.workspace_id = e.workspace_id AND q.event_id = e.id
  WHERE e.public_key = p_public_key AND e.status = 'published'
    AND (q.status IN ('approved', 'answered') OR q.registration_id = p_registration)
    AND q.status <> 'dismissed'
  ORDER BY q.created_at DESC
  LIMIT 100
$f$;

-- ── Provider webhook boundary (Cloudflare Stream, signature verified in the application) ──

-- Applies one verified Stream video notification. The receipt hash makes replays no-ops.
-- Only a uid already bound to a webinar is updated; unknown uids are acknowledged and ignored.
CREATE FUNCTION app_private.webinar_stream_notification(p_receipt bytea, p_video_uid text, p_live_input_uid text,
  p_state text, p_ready boolean, p_duration numeric, p_detail text, p_now timestamptz)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $f$
DECLARE
  e app.webinar_events%ROWTYPE;
  inserted integer;
  next_state text;
  became_ready boolean := false;
  r record;
  n integer := 0;
BEGIN
  IF p_receipt IS NULL OR octet_length(p_receipt) <> 32 OR p_video_uid IS NULL OR p_video_uid !~ '^[0-9a-f]{32}$'
     OR (p_live_input_uid IS NOT NULL AND p_live_input_uid !~ '^[0-9a-f]{32}$') THEN
    RETURN jsonb_build_object('outcome', 'invalid');
  END IF;
  INSERT INTO app.webinar_provider_receipts (provider, receipt_sha256) VALUES ('cloudflare_stream', p_receipt)
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS inserted = ROW_COUNT;
  IF inserted = 0 THEN RETURN jsonb_build_object('outcome', 'replayed'); END IF;
  next_state := CASE WHEN p_ready THEN 'ready' WHEN p_state = 'error' THEN 'failed' ELSE 'processing' END;

  -- Uploaded video bound to a webinar.
  SELECT * INTO e FROM app.webinar_events WHERE video_uid = p_video_uid FOR UPDATE;
  IF FOUND THEN
    UPDATE app.webinar_events SET video_state = next_state,
      video_duration_seconds = CASE WHEN p_ready AND p_duration >= 0 THEN p_duration ELSE video_duration_seconds END,
      video_detail = CASE WHEN next_state = 'failed' THEN left(coalesce(p_detail, 'Cloudflare could not process this video'), 300) ELSE NULL END,
      row_version = row_version + 1, updated_at = clock_timestamp()
     WHERE workspace_id = e.workspace_id AND id = e.id;
    RETURN jsonb_build_object('outcome', 'applied', 'binding', 'video', 'workspaceId', e.workspace_id, 'eventId', e.id);
  END IF;

  -- Recording of a live input bound to a webinar. A recording only becomes the replay
  -- once the host has ended the session; a mid-session reconnect produces a partial file,
  -- so a longer ready recording for the same input always replaces a shorter one.
  IF p_live_input_uid IS NULL THEN RETURN jsonb_build_object('outcome', 'unbound'); END IF;
  SELECT * INTO e FROM app.webinar_events WHERE live_input_uid = p_live_input_uid FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome', 'unbound'); END IF;
  IF e.session_state <> 'ended' THEN
    RETURN jsonb_build_object('outcome', 'deferred', 'workspaceId', e.workspace_id, 'eventId', e.id);
  END IF;
  became_ready := p_ready AND e.recording_state <> 'ready';
  UPDATE app.webinar_events SET recording_uid = p_video_uid, recording_state = next_state,
    recording_duration_seconds = CASE WHEN p_ready AND p_duration >= 0 THEN p_duration ELSE recording_duration_seconds END,
    row_version = row_version + 1, updated_at = clock_timestamp()
   WHERE workspace_id = e.workspace_id AND id = e.id
     AND (recording_uid IS NULL OR recording_uid = p_video_uid OR recording_state <> 'ready'
          OR (p_ready AND p_duration > coalesce(recording_duration_seconds, 0)));
  IF became_ready AND e.status = 'published' AND coalesce((e.settings -> 'replay' ->> 'enabled')::boolean, false) THEN
    FOR r IN SELECT id FROM app.webinar_registrations WHERE workspace_id = e.workspace_id AND event_id = e.id AND status = 'registered' LOOP
      INSERT INTO app.webinar_jobs (workspace_id, event_id, registration_id, kind, purpose, dedupe_key, schedule_version, run_after, expires_at)
      VALUES (e.workspace_id, e.id, r.id, 'message', 'replay_available', 'msg:' || r.id::text || ':replay_available',
        e.schedule_version, p_now, p_now + interval '7 days')
      ON CONFLICT (workspace_id, dedupe_key) DO NOTHING;
      GET DIAGNOSTICS inserted = ROW_COUNT; n := n + inserted;
    END LOOP;
  END IF;
  RETURN jsonb_build_object('outcome', 'applied', 'binding', 'recording', 'workspaceId', e.workspace_id,
    'eventId', e.id, 'replayMessages', n);
END $f$;

-- Worker discovery across brands: only workspace ids with due work or a live window.
CREATE FUNCTION app_private.webinar_active_workspaces(p_now timestamptz)
RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $f$
  SELECT DISTINCT x.workspace_id FROM (
    SELECT j.workspace_id FROM app.webinar_jobs j
     WHERE (j.state = 'queued' AND j.run_after <= p_now) OR (j.state IN ('leased', 'calling') AND j.lease_until <= p_now)
    UNION
    SELECT e.workspace_id FROM app.webinar_events e
     WHERE e.status = 'published' AND e.live_input_uid IS NOT NULL
       AND (e.session_state = 'live'
         OR (e.session_state = 'ended' AND e.recording_state IN ('none', 'processing') AND e.session_ended_at > p_now - interval '2 days')
         OR (e.starts_at BETWEEN p_now - interval '6 hours' AND p_now + interval '2 hours'))
    UNION
    SELECT e.workspace_id FROM app.webinar_events e
     WHERE e.status IN ('draft', 'published') AND e.video_state IN ('awaiting_upload', 'processing')
       AND e.updated_at > p_now - interval '2 days'
  ) x
  LIMIT 500
$f$;

REVOKE ALL ON FUNCTION
  app_private.webinar_public_event(text),
  app_private.webinar_enqueue_registration_messages(uuid, uuid, uuid, timestamptz, boolean),
  app_private.webinar_requeue_event_messages(uuid, timestamptz),
  app_private.webinar_workspace_profile(),
  app_private.webinar_register(text, text, text, jsonb, boolean, jsonb, jsonb, timestamptz),
  app_private.webinar_request_access_link(text, text, timestamptz),
  app_private.webinar_attendee(text, uuid, integer),
  app_private.webinar_record_signal(text, uuid, integer, text, text, numeric, numeric, timestamptz),
  app_private.webinar_submit_question(text, uuid, integer, text, timestamptz),
  app_private.webinar_public_questions(text, uuid, integer),
  app_private.webinar_stream_notification(bytea, text, text, text, boolean, numeric, text, timestamptz),
  app_private.webinar_active_workspaces(timestamptz)
FROM PUBLIC;
-- webinar_enqueue_registration_messages stays internal: only the definer functions above call it.
GRANT EXECUTE ON FUNCTION
  app_private.webinar_public_event(text),
  app_private.webinar_requeue_event_messages(uuid, timestamptz),
  app_private.webinar_workspace_profile(),
  app_private.webinar_register(text, text, text, jsonb, boolean, jsonb, jsonb, timestamptz),
  app_private.webinar_request_access_link(text, text, timestamptz),
  app_private.webinar_attendee(text, uuid, integer),
  app_private.webinar_record_signal(text, uuid, integer, text, text, numeric, numeric, timestamptz),
  app_private.webinar_submit_question(text, uuid, integer, text, timestamptz),
  app_private.webinar_public_questions(text, uuid, integer),
  app_private.webinar_stream_notification(bytea, text, text, text, boolean, numeric, text, timestamptz),
  app_private.webinar_active_workspaces(timestamptz)
TO r72_content_command;
