-- 0158: durable, zero-default admission for future paid video workers.
-- No provider keys or outbound requests. Runtime roles cannot change policy.
-- Workers never start paid work without a scoped, owner-approved reservation.
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
DO $role$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='r72_media_job_definer') THEN
    CREATE ROLE r72_media_job_definer NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='r72_media_job_definer' AND NOT rolcanlogin AND NOT rolinherit
     AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls)
    OR EXISTS(SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member WHERE r.rolname='r72_media_job_definer') THEN
    RAISE EXCEPTION 'Unsafe media job function-owner role' USING ERRCODE='42501';
  END IF;
  GRANT r72_media_job_definer TO r72_owner;
END $role$;
SET LOCAL ROLE r72_owner;

CREATE TABLE app.creative_media_video_policy(
  workspace_id uuid PRIMARY KEY REFERENCES app.seo_blog_brands(workspace_id),
  enabled boolean NOT NULL DEFAULT false,
  monthly_microusd bigint NOT NULL DEFAULT 0 CHECK(monthly_microusd>=0),
  per_job_microusd bigint NOT NULL DEFAULT 0 CHECK(per_job_microusd>=0),
  max_pending integer NOT NULL DEFAULT 0 CHECK(max_pending BETWEEN 0 AND 100),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK(NOT enabled OR (monthly_microusd>0 AND per_job_microusd>0 AND max_pending>0))
);
CREATE TABLE app.creative_media_video_jobs(
  workspace_id uuid NOT NULL REFERENCES app.seo_blog_brands(workspace_id),
  id uuid NOT NULL,
  command_id uuid NOT NULL,
  kind text NOT NULL CHECK(kind IN('vizard_clip','shotstack_render')),
  exact_payload_sha256 text NOT NULL CHECK(exact_payload_sha256~'^[a-f0-9]{64}$'),
  reviewed_request_json text NOT NULL CHECK(octet_length(reviewed_request_json) BETWEEN 2 AND 12000),
  rights_evidence_sha256 text NOT NULL CHECK(rights_evidence_sha256~'^[a-f0-9]{64}$'),
  reserved_microusd bigint NOT NULL CHECK(reserved_microusd>0),
  actual_microusd bigint CHECK(actual_microusd IS NULL OR actual_microusd>=0),
  state text NOT NULL DEFAULT 'reserved'
    CHECK(state IN('reserved','claimed','submitted','completed','failed','outcome_unknown')),
  provider_job_id text CHECK(provider_job_id IS NULL OR (length(provider_job_id) BETWEEN 3 AND 160
    AND provider_job_id!~'[[:cntrl:]<>]')),
  claim_token uuid,
  claim_until timestamptz,
  created_by uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,id),
  UNIQUE(workspace_id,command_id),
  CHECK((claim_token IS NULL)=(claim_until IS NULL)),
  CHECK(state<>'completed' OR actual_microusd IS NOT NULL)
);
CREATE INDEX creative_media_video_pending ON app.creative_media_video_jobs(workspace_id,state,created_at DESC);
CREATE TABLE app.creative_media_video_events(
  workspace_id uuid NOT NULL REFERENCES app.seo_blog_brands(workspace_id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL,
  event text NOT NULL CHECK(event IN('reserved','claimed','submitted','completed','failed','outcome_unknown')),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,id),
  FOREIGN KEY(workspace_id,job_id) REFERENCES app.creative_media_video_jobs(workspace_id,id)
);
DO $tables$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['creative_media_video_policy','creative_media_video_jobs','creative_media_video_events'] LOOP
    EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('REVOKE ALL ON app.%I FROM PUBLIC,r72_content_command,r72_web,r72_worker',t);
    EXECUTE format('CREATE POLICY %I ON app.%I FOR ALL TO r72_owner USING(true) WITH CHECK(true)',t||'_owner',t);
    EXECUTE format('CREATE POLICY %I ON app.%I FOR ALL TO r72_media_job_definer USING(workspace_id=app_private.current_workspace_id()) WITH CHECK(workspace_id=app_private.current_workspace_id())',t||'_scope',t);
    INSERT INTO app_private.workspace_table_registry(schema_name,table_name,workspace_column) VALUES('app',t,'workspace_id');
  END LOOP;
END $tables$;
-- Row locking for atomic budget admission needs UPDATE privilege; only the
-- private SECURITY DEFINER has it, never the public/content runtime role.
GRANT SELECT,UPDATE ON app.creative_media_video_policy TO r72_media_job_definer;
GRANT SELECT,INSERT,UPDATE ON app.creative_media_video_jobs TO r72_media_job_definer;
GRANT SELECT,INSERT ON app.creative_media_video_events TO r72_media_job_definer;
CREATE TRIGGER creative_media_video_events_immutable BEFORE UPDATE OR DELETE ON app.creative_media_video_events
  FOR EACH ROW EXECUTE FUNCTION app_private.seo_blog_append_only();

GRANT USAGE ON SCHEMA app,app_private TO r72_media_job_definer;
GRANT EXECUTE ON FUNCTION app_private.seo_media_owner(uuid,bytea),
  app_private.current_workspace_id(),app_private.current_actor_kind() TO r72_media_job_definer;
GRANT CREATE ON SCHEMA app_private TO r72_media_job_definer;
SET LOCAL ROLE r72_media_job_definer;

CREATE FUNCTION app_private.creative_media_video_owner(
  p_workspace uuid,p_session bytea,p_action text,p_input jsonb
) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE actor uuid; pol app.creative_media_video_policy; existing app.creative_media_video_jobs;
  reserved bigint; pending integer; amount bigint; req uuid; cmd uuid; kind text; payload_sha text; rights_sha text;
  request_json text; rights_json text;
BEGIN
  IF p_session IS NULL OR app_private.current_actor_kind()<>'user' THEN
    RAISE EXCEPTION 'Owner session required' USING ERRCODE='42501'; END IF;
  actor:=app_private.seo_media_owner(p_workspace,p_session);
  IF p_action='list' THEN
    RETURN coalesce((SELECT jsonb_agg(jsonb_build_object('id',j.id,'kind',j.kind,'state',j.state,
      'reservedMicrousd',j.reserved_microusd,'actualMicrousd',j.actual_microusd,
      'createdAt',j.created_at) ORDER BY j.created_at DESC)
      FROM app.creative_media_video_jobs j WHERE j.workspace_id=p_workspace),'[]'::jsonb);
  END IF;
  IF p_action<>'reserve' OR p_input IS NULL OR jsonb_typeof(p_input)<>'object'
    OR octet_length(p_input::text)>4096 OR p_input->>'consent' IS DISTINCT FROM 'true'
    OR coalesce(p_input->>'jobId','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    OR coalesce(p_input->>'commandId','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    OR p_input->>'kind' NOT IN ('vizard_clip','shotstack_render')
    OR coalesce(p_input->>'payloadSha','') !~ '^[a-f0-9]{64}$'
    OR coalesce(p_input->>'rightsSha','') !~ '^[a-f0-9]{64}$'
    OR coalesce(p_input->>'estimatedMicrousd','') !~ '^[1-9][0-9]{0,12}$' THEN
    RAISE EXCEPTION 'Exact owner consent and valid media reservation required' USING ERRCODE='22023';
  END IF;
  req:=(p_input->>'jobId')::uuid;cmd:=(p_input->>'commandId')::uuid;
  kind:=p_input->>'kind'; payload_sha:=p_input->>'payloadSha';rights_sha:=p_input->>'rightsSha';
  amount:=(p_input->>'estimatedMicrousd')::bigint;
  request_json:=p_input->>'requestJson'; rights_json:=p_input->>'rightsJson';
  -- The actual reviewed request is mandatory, private and immutable. SQL verifies
  -- exact UTF-8 digests instead of accepting orphan owner-supplied hashes.
  IF request_json IS NULL OR rights_json IS NULL
    OR octet_length(request_json) NOT BETWEEN 2 AND 12000
    OR octet_length(rights_json) NOT BETWEEN 2 AND 2048
    OR jsonb_typeof(request_json::jsonb)<>'object'
    OR jsonb_typeof(rights_json::jsonb)<>'object'
    OR request_json::jsonb->>'workspaceId' IS DISTINCT FROM p_workspace::text
    OR request_json::jsonb->>'commandId' IS DISTINCT FROM cmd::text
    OR request_json::jsonb->'rights' IS DISTINCT FROM rights_json::jsonb
    OR encode(public.digest(request_json,'sha256'),'hex') IS DISTINCT FROM payload_sha
    OR encode(public.digest(rights_json,'sha256'),'hex') IS DISTINCT FROM rights_sha THEN
    RAISE EXCEPTION 'Immutable reviewed media request and rights digest required' USING ERRCODE='22023';
  END IF;
  -- Scope and serialise every admission to the same business policy row.
  SELECT * INTO pol FROM app.creative_media_video_policy WHERE workspace_id=p_workspace FOR UPDATE;
  IF pol.workspace_id IS NULL OR NOT pol.enabled OR amount>pol.per_job_microusd THEN
    RAISE EXCEPTION 'Paid video disabled or above approved per-job limit' USING ERRCODE='55000'; END IF;
  SELECT * INTO existing FROM app.creative_media_video_jobs WHERE workspace_id=p_workspace AND command_id=cmd;
  IF existing.id IS NOT NULL THEN
    IF existing.kind IS DISTINCT FROM kind OR existing.exact_payload_sha256 IS DISTINCT FROM payload_sha
      OR existing.rights_evidence_sha256 IS DISTINCT FROM rights_sha
      OR existing.reserved_microusd IS DISTINCT FROM amount OR existing.id IS DISTINCT FROM req
      OR existing.reviewed_request_json IS DISTINCT FROM request_json THEN
      RAISE EXCEPTION 'Paid job command replay changed inputs' USING ERRCODE='40001'; END IF;
    RETURN jsonb_build_object('replayed',true,'id',existing.id,'state',existing.state);
  END IF;
  SELECT coalesce(sum(CASE WHEN state='completed' THEN actual_microusd
    ELSE reserved_microusd END),0),count(*) FILTER (WHERE state IN ('reserved','claimed','submitted','outcome_unknown')) INTO reserved,pending
    FROM app.creative_media_video_jobs WHERE workspace_id=p_workspace
      AND (state IN('reserved','claimed','submitted','outcome_unknown','completed'))
      AND created_at>=date_trunc('month',clock_timestamp());
  IF pending>=pol.max_pending OR reserved+amount>pol.monthly_microusd THEN
    RAISE EXCEPTION 'Monthly budget or pending job cap reached' USING ERRCODE='55000'; END IF;
  INSERT INTO app.creative_media_video_jobs(workspace_id,id,command_id,kind,
    exact_payload_sha256,reviewed_request_json,rights_evidence_sha256,reserved_microusd,created_by)
  VALUES(p_workspace,req,cmd,kind,payload_sha,request_json,rights_sha,amount,actor);
  INSERT INTO app.creative_media_video_events(workspace_id,job_id,event)
  VALUES(p_workspace,req,'reserved');
  RETURN jsonb_build_object('replayed',false,'id',req,'state','reserved');
END $f$;

CREATE FUNCTION app_private.creative_media_video_worker(
  p_workspace uuid,p_action text,p_job uuid,p_claim uuid,p_provider_id text,p_cost bigint
) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE j app.creative_media_video_jobs; pol app.creative_media_video_policy; next_state text;
BEGIN
  IF app_private.current_actor_kind()<>'worker' OR app_private.current_workspace_id() IS DISTINCT FROM p_workspace THEN
    RAISE EXCEPTION 'Worker workspace claim required' USING ERRCODE='42501'; END IF;
  SELECT * INTO j FROM app.creative_media_video_jobs
    WHERE workspace_id=p_workspace AND id=p_job FOR UPDATE;
  IF j.id IS NULL THEN RAISE EXCEPTION 'Media job not found' USING ERRCODE='22023'; END IF;
  IF p_action='claim' THEN
    SELECT * INTO pol FROM app.creative_media_video_policy WHERE workspace_id=p_workspace;
    IF pol.workspace_id IS NULL OR NOT pol.enabled OR j.state<>'reserved'
      OR j.claim_token IS NOT NULL THEN
      RAISE EXCEPTION 'Media job not available for processing' USING ERRCODE='55000'; END IF;
    UPDATE app.creative_media_video_jobs SET state='claimed',claim_token=gen_random_uuid(),
      claim_until=clock_timestamp()+interval '10 minutes',updated_at=clock_timestamp()
      WHERE workspace_id=p_workspace AND id=p_job RETURNING * INTO j;
    INSERT INTO app.creative_media_video_events(workspace_id,job_id,event) VALUES(p_workspace,p_job,'claimed');
    RETURN jsonb_build_object('id',j.id,'claimToken',j.claim_token,'commandId',j.command_id,'kind',j.kind,
      'payloadSha',j.exact_payload_sha256,'rightsSha',j.rights_evidence_sha256,
      'reviewedRequestJson',j.reviewed_request_json,
      'reservedMicrousd',j.reserved_microusd,'approvedBy',j.created_by,
      'approvedAt',j.created_at,'validUntil',j.claim_until);
  END IF;
  IF p_claim IS NULL OR p_claim IS DISTINCT FROM j.claim_token OR j.claim_until<=clock_timestamp()
    OR j.state NOT IN ('claimed','submitted') THEN
    RAISE EXCEPTION 'Current claimed job lease required' USING ERRCODE='42501'; END IF;
  next_state:=CASE p_action WHEN 'submitted' THEN 'submitted'
    WHEN 'completed' THEN 'completed' WHEN 'failed' THEN 'failed'
    WHEN 'outcome_unknown' THEN 'outcome_unknown' ELSE NULL END;
  IF next_state IS NULL OR (next_state='submitted' AND (p_provider_id IS NULL OR length(p_provider_id) NOT BETWEEN 3 AND 160))
    OR (next_state='completed' AND (p_cost IS NULL OR p_cost<0))
    OR (p_cost IS NOT NULL AND p_cost>1000000000000)
    OR (next_state='submitted' AND j.state<>'claimed')
    OR (next_state='completed' AND (j.state<>'submitted' OR p_cost>j.reserved_microusd))
    OR (next_state='failed' AND j.state NOT IN ('claimed','submitted'))
    OR (next_state='outcome_unknown' AND j.state NOT IN ('claimed','submitted')) THEN
    RAISE EXCEPTION 'Invalid worker transition' USING ERRCODE='22023'; END IF;
  -- Unknown outcome does not refund or automatically repeat a potentially charged call.
  UPDATE app.creative_media_video_jobs SET state=next_state,
    provider_job_id=coalesce(NULLIF(p_provider_id,''),provider_job_id),
    actual_microusd=CASE WHEN next_state='completed' THEN p_cost ELSE actual_microusd END,
    updated_at=clock_timestamp() WHERE workspace_id=p_workspace AND id=p_job;
  INSERT INTO app.creative_media_video_events(workspace_id,job_id,event) VALUES(p_workspace,p_job,next_state);
  RETURN jsonb_build_object('id',p_job,'state',next_state);
END $f$;

REVOKE ALL ON FUNCTION app_private.creative_media_video_owner(uuid,bytea,text,jsonb),
  app_private.creative_media_video_worker(uuid,text,uuid,uuid,text,bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.creative_media_video_owner(uuid,bytea,text,jsonb) TO r72_content_command;
GRANT EXECUTE ON FUNCTION app_private.creative_media_video_worker(uuid,text,uuid,uuid,text,bigint) TO r72_worker;
RESET ROLE;
SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private FROM r72_media_job_definer;
