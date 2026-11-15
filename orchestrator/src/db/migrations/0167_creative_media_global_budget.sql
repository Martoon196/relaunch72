-- 0167: platform-wide financial admission across ALL workspaces, including
-- simultaneous tenant submissions. Entirely disabled with a zero cap by default.
-- An immutable reservation ledger is never turned into invented provider charges.
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
DO $role$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='r72_media_global_definer') THEN
  CREATE ROLE r72_media_global_definer NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='r72_media_global_definer'
  AND NOT rolcanlogin AND NOT rolinherit AND NOT rolsuper AND NOT rolcreatedb
  AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls)
  OR EXISTS(SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member WHERE r.rolname='r72_media_global_definer')
 THEN RAISE EXCEPTION 'Unsafe global media ledger definer role' USING ERRCODE='42501'; END IF;
 GRANT r72_media_global_definer TO r72_owner;
END $role$;
SET LOCAL ROLE r72_owner;
CREATE TABLE app_private.creative_media_global_policy(
 policy_id integer PRIMARY KEY CHECK(policy_id=1),
 enabled boolean NOT NULL DEFAULT false,
 monthly_microusd bigint NOT NULL DEFAULT 0 CHECK(monthly_microusd BETWEEN 0 AND 1000000000000),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(NOT enabled OR monthly_microusd>0)
);
CREATE TABLE app_private.creative_media_global_usage(
 period_month date PRIMARY KEY,
 reserved_microusd bigint NOT NULL CHECK(reserved_microusd BETWEEN 0 AND 1000000000000),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE app_private.creative_media_global_events(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 workspace_id uuid NOT NULL,job_id uuid NOT NULL,
 period_month date NOT NULL,
 delta_microusd bigint NOT NULL,
 kind text NOT NULL CHECK(kind IN ('reserved','failed','settled')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(workspace_id,job_id,kind)
);
INSERT INTO app_private.creative_media_global_policy(policy_id,enabled,monthly_microusd)
 VALUES(1,false,0);
DO $tables$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['creative_media_global_policy','creative_media_global_usage','creative_media_global_events'] LOOP
  EXECUTE format('ALTER TABLE app_private.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE app_private.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON app_private.%I FROM PUBLIC,r72_web,r72_worker,r72_content_command',t);
  EXECUTE format('CREATE POLICY %I ON app_private.%I FOR ALL TO r72_owner USING(true) WITH CHECK(true)',t||'_owner',t);
  EXECUTE format('CREATE POLICY %I ON app_private.%I FOR ALL TO r72_media_global_definer USING(true) WITH CHECK(true)',t||'_capability',t);
 END LOOP;
END $tables$;
CREATE TRIGGER creative_media_global_events_immutable
 BEFORE UPDATE OR DELETE ON app_private.creative_media_global_events
 FOR EACH ROW EXECUTE FUNCTION app_private.seo_blog_append_only();
GRANT SELECT ON app_private.creative_media_global_policy TO r72_media_global_definer;
GRANT SELECT,INSERT,UPDATE ON app_private.creative_media_global_usage TO r72_media_global_definer;
GRANT SELECT,INSERT ON app_private.creative_media_global_events TO r72_media_global_definer;
GRANT CREATE ON SCHEMA app_private TO r72_media_global_definer;
SET LOCAL ROLE r72_media_global_definer;
CREATE FUNCTION app_private.creative_media_global_budget_trigger()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE global_policy app_private.creative_media_global_policy;
  month_utc date;current_total bigint;charge bigint;delta bigint;
BEGIN
 IF app_private.current_workspace_id() IS DISTINCT FROM NEW.workspace_id THEN
  RAISE EXCEPTION 'Global media admission workspace mismatch' USING ERRCODE='42501'; END IF;
 month_utc:=date_trunc('month',NEW.created_at AT TIME ZONE 'UTC')::date;
 IF TG_OP='INSERT' THEN
  SELECT * INTO global_policy FROM app_private.creative_media_global_policy
   WHERE policy_id=1 FOR UPDATE;
  IF global_policy.policy_id IS NULL OR NOT global_policy.enabled
    OR NEW.reserved_microusd>global_policy.monthly_microusd THEN
   RAISE EXCEPTION 'Global provider spending disabled or above cap' USING ERRCODE='55000'; END IF;
  INSERT INTO app_private.creative_media_global_usage(period_month,reserved_microusd)
   VALUES(month_utc,0) ON CONFLICT DO NOTHING;
  SELECT reserved_microusd INTO current_total FROM app_private.creative_media_global_usage
   WHERE period_month=month_utc FOR UPDATE;
  IF current_total>global_policy.monthly_microusd-NEW.reserved_microusd THEN
   RAISE EXCEPTION 'Global monthly media spending cap reached' USING ERRCODE='55000'; END IF;
  UPDATE app_private.creative_media_global_usage
   SET reserved_microusd=reserved_microusd+NEW.reserved_microusd,updated_at=clock_timestamp()
   WHERE period_month=month_utc;
  INSERT INTO app_private.creative_media_global_events
   (workspace_id,job_id,period_month,delta_microusd,kind)
   VALUES(NEW.workspace_id,NEW.id,month_utc,NEW.reserved_microusd,'reserved');
  RETURN NEW;
 END IF;
 IF TG_OP<>'UPDATE' THEN RAISE EXCEPTION 'Unexpected global media ledger action' USING ERRCODE='42501'; END IF;
 IF NEW.id IS DISTINCT FROM OLD.id OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
   OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.reserved_microusd IS DISTINCT FROM OLD.reserved_microusd THEN
  RAISE EXCEPTION 'Immutable media reservation changed' USING ERRCODE='42501'; END IF;
 IF OLD.state IN('completed','failed','outcome_unknown') THEN
  IF NEW.state IS DISTINCT FROM OLD.state OR NEW.actual_microusd IS DISTINCT FROM OLD.actual_microusd THEN
   RAISE EXCEPTION 'Terminal media charge is immutable' USING ERRCODE='42501'; END IF;
  RETURN NEW;
 END IF;
 IF NEW.state='failed' THEN
  delta:=-OLD.reserved_microusd;
 ELSIF NEW.state='completed' THEN
  IF NEW.actual_microusd IS NULL OR NEW.actual_microusd<0
   OR NEW.actual_microusd>OLD.reserved_microusd THEN
    RAISE EXCEPTION 'Invalid global media settlement' USING ERRCODE='55000'; END IF;
  delta:=NEW.actual_microusd-OLD.reserved_microusd;
 ELSE RETURN NEW;
 END IF;
 UPDATE app_private.creative_media_global_usage
  SET reserved_microusd=reserved_microusd+delta,updated_at=clock_timestamp()
  WHERE period_month=month_utc AND reserved_microusd+delta>=0;
 IF NOT FOUND THEN RAISE EXCEPTION 'Missing global media reservation' USING ERRCODE='55000'; END IF;
 INSERT INTO app_private.creative_media_global_events(workspace_id,job_id,period_month,delta_microusd,kind)
 VALUES(NEW.workspace_id,NEW.id,month_utc,delta,
   CASE WHEN NEW.state='completed' THEN 'settled' ELSE 'failed' END);
 RETURN NEW;
END $f$;
REVOKE ALL ON FUNCTION app_private.creative_media_global_budget_trigger() FROM PUBLIC;
RESET ROLE;
SET LOCAL ROLE r72_owner;
CREATE TRIGGER creative_media_global_budget_on_insert
 BEFORE INSERT ON app.creative_media_video_jobs
 FOR EACH ROW EXECUTE FUNCTION app_private.creative_media_global_budget_trigger();
CREATE TRIGGER creative_media_global_budget_on_update
 BEFORE UPDATE ON app.creative_media_video_jobs
 FOR EACH ROW EXECUTE FUNCTION app_private.creative_media_global_budget_trigger();
REVOKE CREATE ON SCHEMA app_private FROM r72_media_global_definer;
