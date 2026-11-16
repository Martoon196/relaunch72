-- PRIVATE DRAFT: standalone signup reuses canonical pending users/workspaces,
-- password setup and encrypted setup-delivery outbox. No second auth system.
SET LOCAL ROLE r72_owner;
CREATE TABLE app_private.creative_media_signup_policy (
 id integer PRIMARY KEY CHECK(id=1),enabled boolean NOT NULL DEFAULT false,terms_version text NOT NULL,
 daily_cap integer NOT NULL DEFAULT 0 CHECK(daily_cap BETWEEN 0 AND 10000),source_hourly_cap integer NOT NULL DEFAULT 0 CHECK(source_hourly_cap BETWEEN 0 AND 100)
);
INSERT INTO app_private.creative_media_signup_policy VALUES(1,false,'rl72-media-v1',0,0);
CREATE TABLE app_private.creative_media_signups (
 command_id uuid PRIMARY KEY,email_sha256 bytea NOT NULL UNIQUE CHECK(octet_length(email_sha256)=32),source_hash bytea NOT NULL CHECK(octet_length(source_hash)=32),
 input_sha256 bytea NOT NULL CHECK(octet_length(input_sha256)=32),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 workspace_id uuid,terms_version text NOT NULL
);
DO $t$ DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['creative_media_signup_policy','creative_media_signups'] LOOP
  EXECUTE format('ALTER TABLE app_private.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE app_private.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON app_private.%I FROM PUBLIC,r72_public,r72_web,r72_worker,r72_provisioning_command',t);
  EXECUTE format('CREATE POLICY %I ON app_private.%I FOR ALL TO r72_owner USING(true) WITH CHECK(true)',t||'_owner',t);
  EXECUTE format('CREATE POLICY %I ON app_private.%I FOR ALL TO r72_security_definer USING(true) WITH CHECK(true)',t||'_capability',t);
 END LOOP;
END $t$;
GRANT SELECT,UPDATE ON app_private.creative_media_signup_policy TO r72_security_definer;
GRANT SELECT,INSERT ON app_private.creative_media_signups TO r72_security_definer;
GRANT INSERT ON app.seo_blog_brands TO r72_security_definer;
CREATE POLICY seo_blog_brands_media_signup_insert ON app.seo_blog_brands FOR INSERT TO r72_security_definer WITH CHECK(true);
GRANT CREATE ON SCHEMA app_private TO r72_security_definer;
SET LOCAL ROLE r72_security_definer;
CREATE FUNCTION app_private.creative_media_signup(p_command uuid,p_input jsonb,p_source bytea,p_setup_hash bytea,p_email_hash bytea,
 p_delivery uuid,p_payload_version smallint,p_key_id text,p_iv bytea,p_cipher bytea,p_tag bytea)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE policy app_private.creative_media_signup_policy;previous app_private.creative_media_signups;email text;hash bytea;provisioned record;slug text;settings jsonb;
BEGIN
 IF p_command IS NULL OR p_input IS NULL OR jsonb_typeof(p_input) IS DISTINCT FROM 'object' OR octet_length(p_input::text)>2500 OR p_source IS NULL OR octet_length(p_source)<>32
  OR p_input->>'acceptedTerms' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'Complete signup and terms consent required' USING ERRCODE='22023'; END IF;
 email:=lower(btrim(p_input->>'email'));hash:=public.digest(p_input::text,'sha256');
 IF email IS NULL OR length(email)>320 OR email!~'^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$' OR public.digest(email,'sha256') IS DISTINCT FROM p_email_hash
  OR length(coalesce(p_input->>'name','')) NOT BETWEEN 1 AND 160 OR p_input->>'name'~'[[:cntrl:]<>]'
  OR length(coalesce(p_input->>'workspaceName','')) NOT BETWEEN 1 AND 160 OR p_input->>'workspaceName'~'[[:cntrl:]<>]' THEN RAISE EXCEPTION 'Valid signup identity required' USING ERRCODE='22023'; END IF;
 SELECT * INTO policy FROM app_private.creative_media_signup_policy WHERE id=1 FOR UPDATE;
 IF NOT policy.enabled OR policy.daily_cap<1 OR policy.source_hourly_cap<1 OR policy.terms_version IS DISTINCT FROM p_input->>'termsVersion' THEN RAISE EXCEPTION 'Signup disabled or terms changed' USING ERRCODE='55000'; END IF;
 SELECT * INTO previous FROM app_private.creative_media_signups WHERE command_id=p_command;
 IF previous.command_id IS NOT NULL THEN
  IF previous.input_sha256<>hash THEN RAISE EXCEPTION 'Signup command changed identity' USING ERRCODE='40001'; END IF;RETURN true; END IF;
 IF EXISTS(SELECT 1 FROM app_private.creative_media_signups WHERE email_sha256=p_email_hash) THEN RETURN true; END IF;
 IF (SELECT count(*) FROM app_private.creative_media_signups WHERE created_at>=date_trunc('day',clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')>=policy.daily_cap
  OR (SELECT count(*) FROM app_private.creative_media_signups WHERE source_hash=p_source AND created_at>clock_timestamp()-interval '1 hour')>=policy.source_hourly_cap THEN RAISE EXCEPTION 'Signup rate limit' USING ERRCODE='54000'; END IF;
 slug:='media-'||replace(p_command::text,'-','');
 BEGIN
  SELECT * INTO provisioned FROM app_private.provision_customer_workspace_with_setup_delivery('media-signup:'||p_command::text,p_input->>'workspaceName',slug,p_input->>'workspaceName',slug,email,p_input->>'name',p_setup_hash,p_email_hash,'Europe/London','en-GB','GBP',p_delivery,p_payload_version,p_key_id,p_iv,p_cipher,p_tag);
 EXCEPTION WHEN unique_violation THEN
  -- Existing identities never gain a new membership or reset credential from signup.
  INSERT INTO app_private.creative_media_signups(command_id,email_sha256,source_hash,input_sha256,terms_version) VALUES(p_command,p_email_hash,p_source,hash,policy.terms_version);
  RETURN true;
 END;
 settings:='{"autoPublish":false,"pauseAll":false,"ongoingProduction":false,"autoAcceptPlans":false,"cadence":{"weekdays":[2,4],"localTime":"09:00","perWeek":2},"planningHorizonDays":30,"backlogCeiling":6,"lengthPreference":"standard","budgets":{"modelTokensPerMonth":0,"searchCallsPerMonth":0,"imagesPerMonth":0},"author":null}'::jsonb;
 INSERT INTO app.seo_blog_brands(workspace_id,organization_id,created_by_user_id,settings) VALUES(provisioned.workspace_id,provisioned.organization_id,provisioned.owner_user_id,settings) ON CONFLICT DO NOTHING;
 INSERT INTO app_private.creative_media_signups(command_id,email_sha256,source_hash,input_sha256,workspace_id,terms_version) VALUES(p_command,p_email_hash,p_source,hash,provisioned.workspace_id,policy.terms_version);
 RETURN true;
END $f$;
REVOKE ALL ON FUNCTION app_private.creative_media_signup(uuid,jsonb,bytea,bytea,bytea,uuid,smallint,text,bytea,bytea,bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.creative_media_signup(uuid,jsonb,bytea,bytea,bytea,uuid,smallint,text,bytea,bytea,bytea) TO r72_provisioning_command;
RESET ROLE;SET LOCAL ROLE r72_owner;REVOKE CREATE ON SCHEMA app_private FROM r72_security_definer;
