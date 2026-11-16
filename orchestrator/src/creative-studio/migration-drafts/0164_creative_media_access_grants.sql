-- 0164: one subscription/entitlement boundary for RL72 agency and affiliate studio.
-- Credits are capability limits, NOT invented payments or a Stripe receipt.
-- Billing may create grants only through a future verified provisioning receipt.
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
SET LOCAL ROLE r72_owner;
CREATE TABLE app.creative_media_access_grants(
 workspace_id uuid NOT NULL REFERENCES app.seo_blog_brands(workspace_id),
 id uuid NOT NULL DEFAULT gen_random_uuid(),
 tier text NOT NULL CHECK(tier IN('agency_client','affiliate_creator','affiliate_business')),
 source text NOT NULL CHECK(source IN('operator_trial','billing_verified')),
 receipt_id text CHECK(receipt_id IS NULL OR (length(receipt_id) BETWEEN 8 AND 160 AND receipt_id!~'[[:cntrl:]<>]')),
 valid_from timestamptz NOT NULL,
 valid_until timestamptz NOT NULL,
 max_job_microusd bigint NOT NULL CHECK(max_job_microusd BETWEEN 0 AND 1000000000000),
 monthly_video_microusd bigint NOT NULL CHECK(monthly_video_microusd BETWEEN 0 AND 1000000000000),
 operator_note text CHECK(operator_note IS NULL OR (length(operator_note)<=120 AND operator_note!~'[[:cntrl:]<>]')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(workspace_id,id),
 CHECK(valid_until>valid_from AND valid_until<=valid_from+interval '2 years'),
 CHECK(source<>'billing_verified' OR receipt_id IS NOT NULL),
 CHECK(max_job_microusd<=monthly_video_microusd)
);
CREATE INDEX creative_media_access_latest ON app.creative_media_access_grants(workspace_id,created_at DESC);
ALTER TABLE app.creative_media_access_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.creative_media_access_grants FORCE ROW LEVEL SECURITY;
REVOKE ALL ON app.creative_media_access_grants FROM PUBLIC,r72_web,r72_worker,r72_content_command;
CREATE POLICY creative_media_access_owner ON app.creative_media_access_grants
 FOR ALL TO r72_owner USING(true) WITH CHECK(true);
CREATE POLICY creative_media_access_studio_read ON app.creative_media_access_grants
 FOR SELECT TO r72_creative_studio_definer
 USING(workspace_id=app_private.current_workspace_id());
CREATE POLICY creative_media_access_video_read ON app.creative_media_access_grants
 FOR SELECT TO r72_media_job_definer
 USING(workspace_id=app_private.current_workspace_id());
GRANT SELECT ON app.creative_media_access_grants TO r72_creative_studio_definer,r72_media_job_definer;
CREATE TRIGGER creative_media_access_grants_immutable
 BEFORE UPDATE OR DELETE ON app.creative_media_access_grants
 FOR EACH ROW EXECUTE FUNCTION app_private.seo_blog_append_only();
INSERT INTO app_private.workspace_table_registry(schema_name,table_name,workspace_column)
 VALUES('app','creative_media_access_grants','workspace_id');
GRANT CREATE ON SCHEMA app_private TO r72_media_job_definer;
SET LOCAL ROLE r72_media_job_definer;
CREATE FUNCTION app_private.creative_media_require_grant()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE grant_rec app.creative_media_access_grants;now_at timestamptz:=clock_timestamp(); used bigint;
BEGIN
 IF app_private.current_workspace_id() IS DISTINCT FROM NEW.workspace_id THEN
  RAISE EXCEPTION 'Cross-workspace video charge denied' USING ERRCODE='42501'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('media-entitlement:'||NEW.workspace_id::text,0));
 SELECT * INTO grant_rec FROM app.creative_media_access_grants g
 WHERE g.workspace_id=NEW.workspace_id AND g.valid_from<=now_at AND g.valid_until>now_at
 ORDER BY g.created_at DESC,g.id DESC LIMIT 1;
 IF grant_rec.id IS NULL OR grant_rec.max_job_microusd=0
   OR NEW.reserved_microusd>grant_rec.max_job_microusd THEN
  RAISE EXCEPTION 'Video entitlement unavailable or over assigned limit' USING ERRCODE='55000'; END IF;
 SELECT coalesce(sum(CASE WHEN j.state='failed' THEN 0 WHEN j.state='completed' THEN coalesce(j.actual_microusd,j.reserved_microusd) ELSE j.reserved_microusd END),0) INTO used
 FROM app.creative_media_video_jobs j WHERE j.workspace_id=NEW.workspace_id
  AND j.created_at>=date_trunc('month',now_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
 IF used>grant_rec.monthly_video_microusd-NEW.reserved_microusd THEN
  RAISE EXCEPTION 'Media subscription monthly entitlement exceeded' USING ERRCODE='55000'; END IF;
 RETURN NEW;
END $f$;
REVOKE ALL ON FUNCTION app_private.creative_media_require_grant() FROM PUBLIC;
RESET ROLE;
SET LOCAL ROLE r72_owner;
CREATE TRIGGER creative_media_job_access_guard
 BEFORE INSERT ON app.creative_media_video_jobs
 FOR EACH ROW EXECUTE FUNCTION app_private.creative_media_require_grant();
REVOKE CREATE ON SCHEMA app_private FROM r72_media_job_definer;
GRANT CREATE ON SCHEMA app_private TO r72_creative_studio_definer;
SET LOCAL ROLE r72_creative_studio_definer;
CREATE FUNCTION app_private.creative_media_access_owner(p_workspace uuid,p_session bytea)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE grant_rec app.creative_media_access_grants;
BEGIN
 IF p_session IS NULL OR app_private.current_actor_kind()<>'user' THEN
   RAISE EXCEPTION 'Owner session required' USING ERRCODE='42501'; END IF;
 PERFORM app_private.seo_media_owner(p_workspace,p_session);
 SELECT * INTO grant_rec FROM app.creative_media_access_grants g
  WHERE g.workspace_id=p_workspace AND g.valid_from<=clock_timestamp()
   AND g.valid_until>clock_timestamp()
  ORDER BY g.created_at DESC,g.id DESC LIMIT 1;
 IF grant_rec.id IS NULL THEN
  RETURN jsonb_build_object('active',false,'tier',NULL,'source',NULL,
    'monthlyVideoMicrousd',0,'maxJobMicrousd',0,'validUntil',NULL);
 END IF;
 RETURN jsonb_build_object('active',grant_rec.max_job_microusd>0 AND grant_rec.monthly_video_microusd>0,'tier',grant_rec.tier,'source',grant_rec.source,
  'monthlyVideoMicrousd',grant_rec.monthly_video_microusd,
  'maxJobMicrousd',grant_rec.max_job_microusd,
  'validUntil',grant_rec.valid_until);
END $f$;
REVOKE ALL ON FUNCTION app_private.creative_media_access_owner(uuid,bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.creative_media_access_owner(uuid,bytea) TO r72_content_command;
RESET ROLE;
SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private FROM r72_creative_studio_definer;
