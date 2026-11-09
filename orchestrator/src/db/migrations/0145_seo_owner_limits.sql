-- Narrow founder controls for usage ceilings. No platform_admin grant, content read, publication or provider effect.
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
DO $role$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='r72_seo_limits_definer') THEN
    CREATE ROLE r72_seo_limits_definer NOLOGIN NOINHERIT NOBYPASSRLS;
  END IF;
END $role$;
GRANT r72_seo_limits_definer TO r72_owner;
SET LOCAL ROLE r72_owner;
CREATE TABLE app_private.seo_limit_operators(user_id uuid PRIMARY KEY REFERENCES app.users(id) ON DELETE CASCADE);
REVOKE ALL ON app_private.seo_limit_operators FROM PUBLIC;
INSERT INTO app_private.seo_limit_operators(user_id)
 SELECT id FROM app.users WHERE id='82a1705e-0cd7-4414-a5f0-2cd8975c2322';
GRANT USAGE ON SCHEMA app,app_private TO r72_seo_limits_definer;
GRANT SELECT ON app_private.seo_limit_operators TO r72_seo_limits_definer;
GRANT EXECUTE ON FUNCTION app_private.seo_media_owner(uuid,bytea) TO r72_seo_limits_definer;
GRANT SELECT ON app.seo_blog_brands,app.seo_blog_usage,app.creative_studio_generations,app.seo_blog_image_attempts TO r72_seo_limits_definer;
GRANT SELECT(id,name) ON app.workspaces TO r72_seo_limits_definer;
GRANT SELECT(id,email) ON app.users TO r72_seo_limits_definer;
GRANT UPDATE(settings,row_version,updated_at) ON app.seo_blog_brands TO r72_seo_limits_definer;
GRANT INSERT ON app.seo_blog_activity TO r72_seo_limits_definer;
GRANT USAGE ON SEQUENCE app.seo_blog_activity_id_seq TO r72_seo_limits_definer;
CREATE POLICY seo_limits_brands_read ON app.seo_blog_brands FOR SELECT TO r72_seo_limits_definer USING(true);
CREATE POLICY seo_limits_brands_write ON app.seo_blog_brands FOR UPDATE TO r72_seo_limits_definer USING(true) WITH CHECK(true);
CREATE POLICY seo_limits_usage_read ON app.seo_blog_usage FOR SELECT TO r72_seo_limits_definer USING(true);
CREATE POLICY seo_limits_generations_read ON app.creative_studio_generations FOR SELECT TO r72_seo_limits_definer USING(true);
CREATE POLICY seo_limits_attempts_read ON app.seo_blog_image_attempts FOR SELECT TO r72_seo_limits_definer USING(true);
CREATE POLICY seo_limits_workspaces_read ON app.workspaces FOR SELECT TO r72_seo_limits_definer USING(true);
CREATE POLICY seo_limits_users_read ON app.users FOR SELECT TO r72_seo_limits_definer USING(true);
CREATE POLICY seo_limits_activity_append ON app.seo_blog_activity FOR INSERT TO r72_seo_limits_definer WITH CHECK(true);
GRANT SELECT,UPDATE(version,config) ON app_private.seo_image_operator_policy TO r72_seo_limits_definer;
CREATE POLICY seo_limits_policy_read ON app_private.seo_image_operator_policy FOR SELECT TO r72_seo_limits_definer USING(true);
CREATE POLICY seo_limits_policy_write ON app_private.seo_image_operator_policy FOR UPDATE TO r72_seo_limits_definer USING(true) WITH CHECK(true);
GRANT CREATE ON SCHEMA app_private TO r72_seo_limits_definer;
SET LOCAL ROLE r72_seo_limits_definer;
CREATE FUNCTION app_private.seo_limits_command(p_workspace uuid,p_session bytea,p_action text,p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE actor uuid; target uuid; b app.seo_blog_brands; limits jsonb; next_settings jsonb; k text;
  policy app_private.seo_image_operator_policy; next_policy jsonb; audit_workspace uuid; this_month timestamptz;
BEGIN
  actor:=app_private.seo_media_owner(p_workspace,p_session);
  IF NOT EXISTS(SELECT 1 FROM app_private.seo_limit_operators WHERE user_id=actor) THEN
    IF p_action='allowed' THEN RETURN 'false'::jsonb; END IF;
    RAISE EXCEPTION 'Limits operator required' USING ERRCODE='42501';
  END IF;
  IF p_action='allowed' THEN RETURN 'true'::jsonb; END IF;
  IF jsonb_typeof(p_input) IS DISTINCT FROM 'object' OR octet_length(p_input::text)>8000 THEN
    RAISE EXCEPTION 'Invalid limit command' USING ERRCODE='22023'; END IF;
  this_month:=date_trunc('month',clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
  IF p_action='list' THEN
    RETURN jsonb_build_object('brands',coalesce((SELECT jsonb_agg(v ORDER BY v->>'owner',v->>'name') FROM (
      SELECT jsonb_build_object('id',x.workspace_id,'name',w.name,'owner',u.email,'rowVersion',x.row_version,
        'managed',x.settings?'operatorLimits','limits',jsonb_build_object(
          'modelTokens',CASE WHEN x.settings?'operatorLimits' THEN x.settings#>'{operatorLimits,modelTokens}' ELSE x.settings#>'{budgets,modelTokensPerMonth}' END,
          'searchCalls',CASE WHEN x.settings?'operatorLimits' THEN x.settings#>'{operatorLimits,searchCalls}' ELSE x.settings#>'{budgets,searchCallsPerMonth}' END,
          'images',CASE WHEN x.settings?'operatorLimits' THEN x.settings#>'{operatorLimits,images}' ELSE x.settings#>'{budgets,imagesPerMonth}' END,
          'studioImages',CASE WHEN x.settings?'operatorLimits' THEN x.settings#>'{operatorLimits,studioImages}' ELSE coalesce(x.settings#>'{studioImages,perMonth}','0'::jsonb) END),
        'usage',jsonb_build_object(
          'modelTokens',coalesce((SELECT sum(amount) FROM app.seo_blog_usage WHERE workspace_id=x.workspace_id AND kind='model_tokens' AND at>=this_month),0),
          'searchCalls',coalesce((SELECT sum(amount) FROM app.seo_blog_usage WHERE workspace_id=x.workspace_id AND kind='search_calls' AND at>=this_month),0),
          'images',coalesce((SELECT sum(amount) FROM app.seo_blog_usage WHERE workspace_id=x.workspace_id AND kind='images' AND at>=this_month),0),
          'studioImages',(SELECT count(*) FROM app.seo_blog_image_attempts a WHERE a.workspace_id=x.workspace_id AND a.source_snapshot->>'recipe'='creative-brief-source-v1'
             AND (a.allowance_period=this_month::date OR a.outcome IN ('started','outcome_unknown'))))) AS v
      FROM app.seo_blog_brands x JOIN app.workspaces w ON w.id=x.workspace_id JOIN app.users u ON u.id=x.created_by_user_id
    ) rows),'[]'::jsonb),'policy',(SELECT config||jsonb_build_object('version',version) FROM app_private.seo_image_operator_policy WHERE singleton));
  ELSIF p_action='set' THEN
    target:=(p_input->>'target')::uuid;
    SELECT * INTO b FROM app.seo_blog_brands WHERE workspace_id=target FOR UPDATE;
    IF b.workspace_id IS NULL THEN RAISE EXCEPTION 'Unknown brand' USING ERRCODE='22023'; END IF;
    IF b.row_version IS DISTINCT FROM (p_input->>'rowVersion')::bigint THEN RAISE EXCEPTION 'Limits changed' USING ERRCODE='40001'; END IF;
    limits:=p_input->'limits';
    IF jsonb_typeof(limits) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(limits))<>4
      OR NOT limits ?& ARRAY['modelTokens','searchCalls','images','studioImages'] THEN RAISE EXCEPTION 'Incomplete limits' USING ERRCODE='22023'; END IF;
    FOREACH k IN ARRAY ARRAY['modelTokens','searchCalls','images','studioImages'] LOOP
      IF limits->k<>'null'::jsonb AND (jsonb_typeof(limits->k)<>'number' OR limits->>k !~ '^[0-9]+$' OR (limits->>k)::numeric>1000000000) THEN
        RAISE EXCEPTION 'Use a finite whole-number limit or explicit Unlimited' USING ERRCODE='22023'; END IF;
    END LOOP;
    limits:=limits||jsonb_build_object('configuredBy',actor,'configuredAt',clock_timestamp());
    next_settings:=b.settings||jsonb_build_object('operatorLimits',limits,
      'budgets',jsonb_build_object('modelTokensPerMonth',coalesce((limits->>'modelTokens')::bigint,9007199254740991),
        'searchCallsPerMonth',coalesce((limits->>'searchCalls')::bigint,9007199254740991),'imagesPerMonth',coalesce((limits->>'images')::bigint,9007199254740991)),
      'studioImages',coalesce(b.settings->'studioImages','{}'::jsonb)||jsonb_build_object('enabled',limits->'studioImages'='null'::jsonb OR (limits->>'studioImages')::bigint>0,
        'perMonth',coalesce((limits->>'studioImages')::bigint,9007199254740991),'authorizedBy',actor,'authorizedAt',clock_timestamp()));
    UPDATE app.seo_blog_brands SET settings=next_settings,row_version=row_version+1,updated_at=clock_timestamp() WHERE workspace_id=target;
    INSERT INTO app.seo_blog_activity(workspace_id,at,actor,kind,message,subject_id) VALUES(target,clock_timestamp(),actor::text,'operator_limits_changed',
      left(jsonb_build_object('before',coalesce(b.settings->'operatorLimits',b.settings->'budgets'),'after',limits)::text,2000),target::text);
    RETURN 'true'::jsonb;
  ELSIF p_action='policy' THEN
    SELECT * INTO policy FROM app_private.seo_image_operator_policy WHERE singleton FOR UPDATE;
    IF policy.version IS DISTINCT FROM (p_input->>'version')::bigint THEN RAISE EXCEPTION 'Policy changed' USING ERRCODE='40001'; END IF;
    IF jsonb_typeof(p_input->'enabled') IS DISTINCT FROM 'boolean' OR jsonb_typeof(p_input->'concurrency') IS DISTINCT FROM 'number'
      OR (p_input->>'concurrency') !~ '^[0-9]+$' OR (p_input->>'concurrency')::integer NOT BETWEEN 1 AND 10
      OR NOT p_input?'monthlyMicrousd' OR (p_input->'monthlyMicrousd'<>'null'::jsonb AND
         (jsonb_typeof(p_input->'monthlyMicrousd')<>'number' OR p_input->>'monthlyMicrousd' !~ '^[0-9]+$' OR (p_input->>'monthlyMicrousd')::numeric>1000000000000)) THEN
      RAISE EXCEPTION 'Invalid platform limits' USING ERRCODE='22023'; END IF;
    next_policy:=policy.config||jsonb_build_object('enabled',(p_input->>'enabled')::boolean,'maxConcurrency',(p_input->>'concurrency')::integer,
      'monthlyUnlimited',p_input->'monthlyMicrousd'='null'::jsonb,'monthlyMicrousd',coalesce((p_input->>'monthlyMicrousd')::bigint,0),
      'perAttemptMicrousd',CASE WHEN (policy.config->>'perAttemptMicrousd')::bigint>0 THEN (policy.config->>'perAttemptMicrousd')::bigint ELSE 250000 END);
    IF next_policy IS DISTINCT FROM policy.config THEN
      UPDATE app_private.seo_image_operator_policy SET config=next_policy,version=version+1 WHERE singleton;
      SELECT workspace_id INTO audit_workspace FROM app.seo_blog_brands WHERE created_by_user_id=actor ORDER BY created_at,workspace_id LIMIT 1;
      IF audit_workspace IS NULL THEN RAISE EXCEPTION 'Operator needs an owned brand for the activity record' USING ERRCODE='42501'; END IF;
      INSERT INTO app.seo_blog_activity(workspace_id,at,actor,kind,message) VALUES(audit_workspace,clock_timestamp(),actor::text,'operator_image_policy_changed',
        left(jsonb_build_object('before',policy.config,'after',next_policy)::text,2000));
    END IF;
    RETURN 'true'::jsonb;
  END IF;
  RAISE EXCEPTION 'Unknown limits command' USING ERRCODE='22023';
END $f$;
REVOKE ALL ON FUNCTION app_private.seo_limits_command(uuid,bytea,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.seo_limits_command(uuid,bytea,text,jsonb) TO r72_content_command;
RESET ROLE;
SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private FROM r72_seo_limits_definer;

-- Existing boundary functions follow below, preserved except explicit Unlimited and operator-ceiling guards.

-- GENERATED BOUNDARIES: exact preceding functions with the bounded guards above.

CREATE OR REPLACE FUNCTION app_private.seo_blog_update_brand(p_workspace uuid, p_row_version bigint, p_website text, p_locale text, p_timezone text, p_settings jsonb)
RETURNS bigint LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $f$
DECLARE next_version bigint; old_settings jsonb; cap jsonb; actual numeric; k text; path text[];
BEGIN
  IF p_workspace IS DISTINCT FROM app_private.current_workspace_id() OR NOT (
       (app_private.current_actor_kind() = 'user' AND app_private.can_manage_workspace(app_private.current_user_id(), p_workspace))
       OR app_private.current_actor_kind() = 'worker') THEN
    RAISE EXCEPTION 'Brand unavailable' USING ERRCODE = '42501';
  END IF;
  IF (p_website IS NOT NULL AND (p_website !~ '^https?://[^/?#[:space:]]+$' OR length(p_website) > 300))
     OR p_locale !~ '^[a-z]{2,3}(-[A-Z]{2})?$' OR length(p_timezone) NOT BETWEEN 1 AND 100 OR jsonb_typeof(p_settings) <> 'object' THEN
    RAISE EXCEPTION 'Invalid brand settings' USING ERRCODE = '22023';
  END IF;
  SELECT settings INTO old_settings FROM app.seo_blog_brands WHERE workspace_id=p_workspace FOR UPDATE;
  IF p_settings->'operatorLimits' IS DISTINCT FROM old_settings->'operatorLimits' THEN
    RAISE EXCEPTION 'Only the limits operator can change managed ceilings' USING ERRCODE='42501'; END IF;
  IF old_settings?'operatorLimits' THEN
    FOREACH k IN ARRAY ARRAY['modelTokens','searchCalls','images','studioImages'] LOOP
      cap:=old_settings#>ARRAY['operatorLimits',k];
      path:=CASE k WHEN 'modelTokens' THEN ARRAY['budgets','modelTokensPerMonth'] WHEN 'searchCalls' THEN ARRAY['budgets','searchCallsPerMonth']
        WHEN 'images' THEN ARRAY['budgets','imagesPerMonth'] ELSE ARRAY['studioImages','perMonth'] END;
      actual:=(p_settings#>>path)::numeric;
      IF cap IS NOT NULL AND cap<>'null'::jsonb AND (actual<0 OR actual>(cap#>>'{}')::numeric) THEN
        RAISE EXCEPTION 'This allowance exceeds its operator ceiling' USING ERRCODE='42501'; END IF;
    END LOOP;
  END IF;
  UPDATE app.seo_blog_brands SET website = p_website, settings = p_settings, row_version = row_version + 1, updated_at = clock_timestamp()
   WHERE workspace_id = p_workspace AND row_version = p_row_version RETURNING row_version INTO next_version;
  IF next_version IS NULL THEN RETURN NULL; END IF;
  UPDATE app.workspaces SET locale = p_locale, timezone = p_timezone, row_version = row_version + 1, updated_at = clock_timestamp()
   WHERE id = p_workspace AND (locale IS DISTINCT FROM p_locale OR timezone IS DISTINCT FROM p_timezone);
  RETURN next_version;
END $f$;
GRANT CREATE ON SCHEMA app_private TO r72_seo_media_definer;
SET LOCAL ROLE r72_seo_media_definer;
CREATE OR REPLACE FUNCTION app_private.seo_image_reserve(p_workspace uuid,p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE job app.seo_blog_jobs%ROWTYPE; image jsonb; source jsonb; existing app.seo_blog_image_attempts%ROWTYPE;
  policy app_private.seo_image_operator_policy%ROWTYPE; reason text; sponsor uuid; attempt_id uuid:=gen_random_uuid();
  nonce uuid:=(p_input->>'nonce')::uuid; this_period date:=(date_trunc('month',clock_timestamp() AT TIME ZONE 'UTC'))::date;
  active_count bigint; reserved numeric; brand_volume bigint; image_limit bigint; policy_result jsonb;
  creative boolean; studio_volume bigint; studio_limit bigint;
BEGIN
  IF app_private.seo_media_private_actor(p_workspace,NULL) IS NOT NULL OR app_private.current_actor_kind()<>'worker'
    OR nonce IS NULL THEN RAISE EXCEPTION 'Actual content worker required for image start' USING ERRCODE='42501'; END IF;
  PERFORM app_private.seo_media_lock_brand(p_workspace);
  SELECT * INTO job FROM app.seo_blog_jobs WHERE workspace_id=p_workspace AND id=(p_input->>'jobId')::uuid;
  SELECT * INTO existing FROM app.seo_blog_image_attempts WHERE workspace_id=p_workspace AND job_id=job.id;
  IF existing.id IS NOT NULL THEN
    IF existing.intent_id IS DISTINCT FROM (p_input->>'intentId')::uuid
      OR encode(existing.request_sha256,'hex') IS DISTINCT FROM p_input->>'requestSha256'
      OR encode(existing.intent_sha256,'hex') IS DISTINCT FROM p_input->>'intentSha256' THEN
      RAISE EXCEPTION 'Image start identity conflicts with durable attempt' USING ERRCODE='23505';
    END IF;
    IF existing.outcome='operator_resolved' THEN RETURN jsonb_build_object('kind','held','reason','attempt_resolved'); END IF;
    IF jsonb_array_length(existing.receipts)>0 THEN
      reason:=app_private.seo_image_apply_hold(p_workspace,existing.id,existing.start_nonce,p_input->>'leaseOwner',(p_input->>'leaseAttempt')::integer);
      RETURN jsonb_build_object('kind','existing_receipt','attemptId',existing.id,'nonce',existing.start_nonce,
        'receipt',existing.receipts->-1->'receipt','candidate',app_private.seo_media_asset_json(p_workspace,existing.candidate_asset_id),
        'applyEligible',reason IS NULL,'hold',reason);
    END IF;
    RETURN jsonb_build_object('kind','existing_started','attemptId',existing.id,'nonce',existing.start_nonce,'reason','outcome_unknown');
  END IF;
  IF EXISTS(SELECT 1 FROM app.seo_blog_image_attempts a WHERE a.start_nonce=nonce) THEN
    RAISE EXCEPTION 'Image start nonce already used' USING ERRCODE='23505';
  END IF;
  image:=job.data#>'{payload,image}';
  -- 0144: a Creative Studio typed brief is a second, explicitly validated source kind. Everything after the
  -- source check (operator policy, global lock, concurrency, cost and brand allowance) is shared and unchanged.
  creative:=image->>'schema'='relaunch72.creative-image-intent/v1';
  IF creative THEN
    IF job.id IS NULL OR job.kind<>'write' OR job.data#>>'{payload,stage}' IS DISTINCT FROM 'image'
      OR image->>'sourceSnapshotVersion' IS DISTINCT FROM 'creative-brief-source-v1'
      OR job.state<>'running' OR job.lease_expires_at<=clock_timestamp() OR job.lease_expires_at IS NULL
      OR job.data->>'leaseOwner' IS DISTINCT FROM p_input->>'leaseOwner'
      OR job.data->>'attempts' IS DISTINCT FROM p_input->>'leaseAttempt'
      OR image->>'intentId' IS DISTINCT FROM p_input->>'intentId'
      OR image->>'intentSha256' IS DISTINCT FROM p_input->>'intentSha256'
      OR image->>'requestSha256' IS DISTINCT FROM p_input->>'requestSha256'
      OR image->>'sourceSha256' IS DISTINCT FROM p_input->>'sourceSha256' OR image->>'profileSha256' IS DISTINCT FROM p_input->>'profileSha256'
      OR image->>'visualSha256' IS DISTINCT FROM p_input->>'visualSha256'
      OR image->>'briefId' IS DISTINCT FROM p_input->>'briefId' OR image->>'briefVersion' IS DISTINCT FROM p_input->>'briefVersion'
      OR image->>'sponsorUserId' IS DISTINCT FROM p_input->>'sponsorUserId'
      OR image->>'sourceSnapshotVersion' IS DISTINCT FROM p_input->>'sourceSnapshotVersion' THEN
      RETURN jsonb_build_object('kind','held','reason','claim_or_intent_changed');
    END IF;
    source:=app_private.creative_studio_brief_source(p_workspace,(image->>'briefId')::uuid,(image->>'briefVersion')::integer);
    IF source IS DISTINCT FROM image->'source' OR source->'snapshot' IS DISTINCT FROM image->'sourceSnapshot'
      OR source->>'sourceSha256' IS DISTINCT FROM image->>'sourceSha256' OR source->>'profileSha256' IS DISTINCT FROM image->>'profileSha256'
      OR source->>'visualSha256' IS DISTINCT FROM image->>'visualSha256' THEN
      RETURN jsonb_build_object('kind','held','reason','source_changed');
    END IF;
    sponsor:=(image->>'sponsorUserId')::uuid;
    reason:=app_private.creative_studio_image_hold(p_workspace,source,sponsor);
    IF reason IS NOT NULL THEN RETURN jsonb_build_object('kind','held','reason',reason); END IF;
  ELSE
  IF job.id IS NULL OR job.kind<>'write' OR job.data#>>'{payload,stage}' IS DISTINCT FROM 'image'
    OR image->>'schema' IS DISTINCT FROM 'relaunch72.seo-image-intent/v1'
    OR image->>'sourceSnapshotVersion' IS DISTINCT FROM 'seo-image-source-v1'
    OR job.state<>'running' OR job.lease_expires_at<=clock_timestamp() OR job.lease_expires_at IS NULL
    OR job.data->>'leaseOwner' IS DISTINCT FROM p_input->>'leaseOwner'
    OR job.data->>'attempts' IS DISTINCT FROM p_input->>'leaseAttempt'
    OR image->>'intentId' IS DISTINCT FROM p_input->>'intentId'
    OR image->>'intentSha256' IS DISTINCT FROM p_input->>'intentSha256'
    OR image->>'requestSha256' IS DISTINCT FROM p_input->>'requestSha256'
    OR image->>'sourceSha256' IS DISTINCT FROM p_input->>'sourceSha256' OR image->>'profileSha256' IS DISTINCT FROM p_input->>'profileSha256'
    OR image->>'visualSha256' IS DISTINCT FROM p_input->>'visualSha256' OR image->>'articleId' IS DISTINCT FROM p_input->>'articleId'
    OR image->>'articleVersionId' IS DISTINCT FROM p_input->>'articleVersionId'
    OR image->>'articleContentSha256' IS DISTINCT FROM p_input->>'articleContentSha256'
    OR image->>'sponsorUserId' IS DISTINCT FROM p_input->>'sponsorUserId'
    OR image->>'sourceSnapshotVersion' IS DISTINCT FROM p_input->>'sourceSnapshotVersion' THEN
    RETURN jsonb_build_object('kind','held','reason','claim_or_intent_changed');
  END IF;
  -- Some existing article updates lock only their article row. Pin this own source before the global gate wait.
  PERFORM 1 FROM app.seo_blog_articles WHERE workspace_id=p_workspace AND id=(image->>'articleId')::uuid FOR SHARE;
  source:=app_private.seo_image_source(p_workspace,(image#>>'{source,articleId}')::uuid);
  IF source IS DISTINCT FROM image->'source' OR source->'snapshot' IS DISTINCT FROM image->'sourceSnapshot'
    OR source->>'sourceSha256' IS DISTINCT FROM image->>'sourceSha256' OR source->>'profileSha256' IS DISTINCT FROM image->>'profileSha256'
    OR source->>'visualSha256' IS DISTINCT FROM image->>'visualSha256' OR source->>'articleId' IS DISTINCT FROM image->>'articleId'
    OR source->>'articleVersionId' IS DISTINCT FROM image->>'articleVersionId'
    OR source->>'articleContentSha256' IS DISTINCT FROM image->>'articleContentSha256' THEN
    RETURN jsonb_build_object('kind','held','reason','source_changed');
  END IF;
  sponsor:=(image->>'sponsorUserId')::uuid;
  reason:=app_private.seo_image_source_hold(p_workspace,source,sponsor,coalesce((image->>'automatic')::boolean,true));
  IF reason IS NOT NULL THEN RETURN jsonb_build_object('kind','held','reason',reason); END IF;
  END IF;
  IF NOT coalesce((p_input->>'providerConfigured')::boolean,false) THEN RETURN jsonb_build_object('kind','held','reason','provider_unconfigured'); END IF;
  -- The caller already owns its job row; aggregate other brands without row-locking them.
  -- A real row UPDATE gives SERIALIZABLE snapshots a conflict even if the visible aggregate is stale.
  UPDATE app_private.seo_image_operator_policy SET admission_epoch=admission_epoch+1 WHERE singleton RETURNING * INTO policy;
  reason:=CASE WHEN creative THEN app_private.creative_studio_image_hold(p_workspace,source,sponsor)
    ELSE app_private.seo_image_source_hold(p_workspace,source,sponsor,coalesce((image->>'automatic')::boolean,true)) END;
  IF reason IS NOT NULL THEN RETURN jsonb_build_object('kind','held','reason',reason); END IF;
  this_period:=date_trunc('month',clock_timestamp() AT TIME ZONE 'UTC')::date;
  IF policy.version IS DISTINCT FROM (p_input->>'expectedPolicyVersion')::bigint
    OR encode(policy.sha256,'hex') IS DISTINCT FROM p_input->>'expectedPolicySha256'
    OR image->>'expectedPolicyVersion' IS DISTINCT FROM p_input->>'expectedPolicyVersion'
    OR image->>'expectedPolicySha256' IS DISTINCT FROM p_input->>'expectedPolicySha256' THEN
    RETURN jsonb_build_object('kind','held','reason','operator_policy_changed');
  END IF;
  IF NOT coalesce((policy.config->>'enabled')::boolean,false)
    OR coalesce((policy.config->>'maxConcurrency')::bigint,0)<=0
    OR coalesce((policy.config->>'perAttemptMicrousd')::bigint,0)<=0
    OR (NOT coalesce((policy.config->>'monthlyUnlimited')::boolean,false) AND coalesce((policy.config->>'monthlyMicrousd')::bigint,0)<=0) THEN
    RETURN jsonb_build_object('kind','held','reason','operator_policy_disabled');
  END IF;
  IF image->>'model' IS DISTINCT FROM policy.config->>'model' OR image->>'quality' IS DISTINCT FROM policy.config->>'quality' THEN
    RETURN jsonb_build_object('kind','held','reason','operator_model_mismatch');
  END IF;
  SELECT count(*) FILTER(WHERE a.outcome IN ('started','outcome_unknown')),
    coalesce(sum(a.reserved_microusd) FILTER(WHERE a.allowance_period=this_period OR a.outcome IN ('started','outcome_unknown')),0)
    INTO active_count,reserved FROM app.seo_blog_image_attempts a;
  IF active_count>=(policy.config->>'maxConcurrency')::bigint THEN RETURN jsonb_build_object('kind','held','reason','global_concurrency'); END IF;
  IF NOT coalesce((policy.config->>'monthlyUnlimited')::boolean,false) AND reserved+(policy.config->>'perAttemptMicrousd')::numeric>(policy.config->>'monthlyMicrousd')::numeric THEN
    RETURN jsonb_build_object('kind','held','reason','global_cost_reservation');
  END IF;
  SELECT coalesce((settings#>>'{budgets,imagesPerMonth}')::bigint,0) INTO image_limit FROM app.seo_blog_brands WHERE workspace_id=p_workspace;
  SELECT coalesce(sum(u.amount),0)+(SELECT count(*) FROM app.seo_blog_image_attempts a WHERE a.workspace_id=p_workspace
    AND a.allowance_period<this_period AND a.outcome IN ('started','outcome_unknown')) INTO brand_volume
    FROM app.seo_blog_usage u WHERE u.workspace_id=p_workspace AND u.kind='images'
      AND date_trunc('month',u.at AT TIME ZONE 'UTC')::date=this_period;
  IF (image_limit<=0 OR brand_volume>=image_limit) AND NOT EXISTS(SELECT 1 FROM app.seo_blog_brands WHERE workspace_id=p_workspace AND settings#>'{operatorLimits,images}'='null'::jsonb) THEN RETURN jsonb_build_object('kind','held','reason','brand_image_allowance'); END IF;
  -- Studio briefs also need their own owner-set studio allowance (default zero); the brand image allowance above stays shared.
  IF creative THEN
    SELECT CASE WHEN settings#>'{studioImages,enabled}'='true'::jsonb AND jsonb_typeof(settings#>'{studioImages,perMonth}')='number'
      THEN (settings#>>'{studioImages,perMonth}')::bigint ELSE 0 END INTO studio_limit FROM app.seo_blog_brands WHERE workspace_id=p_workspace;
    SELECT count(*) INTO studio_volume FROM app.seo_blog_image_attempts a WHERE a.workspace_id=p_workspace
      AND a.source_snapshot->>'recipe'='creative-brief-source-v1'
      AND (a.allowance_period=this_period OR a.outcome IN ('started','outcome_unknown'));
    IF (studio_limit<=0 OR studio_volume>=studio_limit) AND NOT EXISTS(SELECT 1 FROM app.seo_blog_brands WHERE workspace_id=p_workspace AND settings#>'{operatorLimits,studioImages}'='null'::jsonb) THEN RETURN jsonb_build_object('kind','held','reason','studio_image_allowance'); END IF;
  END IF;
  INSERT INTO app.seo_blog_image_attempts(id,workspace_id,job_id,intent_id,start_nonce,lease_owner,lease_attempt,intent_sha256,request_sha256,
    source_sha256,visual_sha256,profile_sha256,source_snapshot,sponsor_user_id,model,quality,allowance_period,reserved_microusd,
    policy_version,policy_sha256,policy_snapshot) VALUES(attempt_id,p_workspace,job.id,(image->>'intentId')::uuid,nonce,p_input->>'leaseOwner',
      (p_input->>'leaseAttempt')::integer,decode(image->>'intentSha256','hex'),decode(image->>'requestSha256','hex'),
      decode(source->>'sourceSha256','hex'),decode(source->>'visualSha256','hex'),decode(source->>'profileSha256','hex'),source,sponsor,
      image->>'model',image->>'quality',this_period,(policy.config->>'perAttemptMicrousd')::bigint,policy.version,policy.sha256,policy.config);
  policy_result:=policy.config||jsonb_build_object('version',policy.version,'sha256',encode(policy.sha256,'hex'),'admissionEpoch',policy.admission_epoch);
  RETURN jsonb_build_object('kind','admitted','attemptId',attempt_id,'nonce',nonce,'policy',policy_result);
END $f$;
CREATE OR REPLACE FUNCTION app_private.seo_image_policy_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE k text;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Stable operator admission row cannot be deleted' USING ERRCODE='55000'; END IF;
  IF NEW.singleton IS DISTINCT FROM true OR NEW.config->>'model' IS DISTINCT FROM 'gpt-image-2'
    OR NEW.config->>'quality' IS DISTINCT FROM 'medium' OR jsonb_typeof(NEW.config->'enabled') IS DISTINCT FROM 'boolean'
    OR EXISTS(SELECT 1 FROM jsonb_object_keys(NEW.config) key WHERE key<>ALL(ARRAY['enabled','model','quality','maxConcurrency','monthlyMicrousd','perAttemptMicrousd','monthlyUnlimited'])) THEN
    RAISE EXCEPTION 'Invalid trusted operator image policy' USING ERRCODE='22023';
  END IF;
  IF NEW.config?'monthlyUnlimited' AND jsonb_typeof(NEW.config->'monthlyUnlimited')<>'boolean' THEN RAISE EXCEPTION 'Unlimited must be explicit' USING ERRCODE='22023'; END IF;
  FOREACH k IN ARRAY ARRAY['maxConcurrency','monthlyMicrousd','perAttemptMicrousd'] LOOP
    IF jsonb_typeof(NEW.config->k) IS DISTINCT FROM 'number' OR NEW.config->>k !~ '^[0-9]+$'
      OR (NEW.config->>k)::numeric>9007199254740991 THEN RAISE EXCEPTION 'Policy limits must be safe nonnegative integers' USING ERRCODE='22023'; END IF;
  END LOOP;
  IF NEW.config IS DISTINCT FROM OLD.config THEN
    IF NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'Changed operator policy requires next version' USING ERRCODE='55000'; END IF;
  ELSIF NEW.version<>OLD.version THEN RAISE EXCEPTION 'Policy version change requires changed configuration' USING ERRCODE='55000'; END IF;
  IF NEW.admission_epoch<OLD.admission_epoch THEN RAISE EXCEPTION 'Admission epoch is monotonic' USING ERRCODE='55000'; END IF;
  NEW.sha256:=public.digest(NEW.version::text||':'||NEW.config::text,'sha256');
  RETURN NEW;
END $f$;
RESET ROLE;
SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private FROM r72_seo_media_definer;

-- Existing workspaces retain their configured ceilings; new workspaces start with no spend authority.
UPDATE app.seo_blog_brands SET settings=settings||jsonb_build_object('operatorLimits',jsonb_build_object(
 'modelTokens',settings#>'{budgets,modelTokensPerMonth}','searchCalls',settings#>'{budgets,searchCallsPerMonth}',
 'images',settings#>'{budgets,imagesPerMonth}','studioImages',coalesce(settings#>'{studioImages,perMonth}','0'::jsonb),
 'configuredBy','migration-0145','configuredAt',clock_timestamp())),row_version=row_version+1,updated_at=clock_timestamp()
 WHERE NOT settings?'operatorLimits';
CREATE FUNCTION app_private.seo_limits_new_brand()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
BEGIN
 NEW.settings:=NEW.settings||jsonb_build_object('operatorLimits',jsonb_build_object('modelTokens',0,'searchCalls',0,'images',0,'studioImages',0,
   'configuredBy','system','configuredAt',clock_timestamp()),'budgets',jsonb_build_object('modelTokensPerMonth',0,'searchCallsPerMonth',0,'imagesPerMonth',0));
 IF NEW.settings?'studioImages' THEN NEW.settings:=jsonb_set(NEW.settings,'{studioImages}',NEW.settings->'studioImages'||jsonb_build_object('enabled',false,'perMonth',0)); END IF;
 RETURN NEW;
END $f$;
REVOKE ALL ON FUNCTION app_private.seo_limits_new_brand() FROM PUBLIC;
CREATE TRIGGER seo_limits_brand_defaults BEFORE INSERT ON app.seo_blog_brands FOR EACH ROW EXECUTE FUNCTION app_private.seo_limits_new_brand();
