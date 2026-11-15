-- 0157: private, append-only Amazon Associates Tracking ID Summary uploads.
-- Records MERCHANT-REPORTED, USER-UPLOADED figures, not independently verified
-- API sales. Never imputes suppressed values, never allocates Others to products.
-- No merchant API, publisher, paid provider, public link or background worker.
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
SET LOCAL ROLE r72_owner;

CREATE TABLE app.creative_media_report_imports (
  workspace_id uuid NOT NULL REFERENCES app.seo_blog_brands(workspace_id),
  id uuid NOT NULL,
  source text NOT NULL CHECK(source='user_uploaded_amazon_tracking_id_summary'),
  source_sha256 text NOT NULL CHECK(source_sha256~'^[a-f0-9]{64}$'),
  report_start date NOT NULL,
  report_end date NOT NULL,
  currency text NOT NULL CHECK(currency='GBP'),
  input_sha256 text NOT NULL CHECK(input_sha256~'^[a-f0-9]{64}$'),
  payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'
    AND octet_length(payload::text)<=524288
    AND jsonb_typeof(payload->'rows')='array'
    AND jsonb_array_length(payload->'rows') BETWEEN 1 AND 2000),
  created_by uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,id),
  UNIQUE(workspace_id,source_sha256,report_start,report_end),
  CHECK(report_end>=report_start AND report_end<=report_start+366)
);
CREATE INDEX creative_media_reports_latest ON app.creative_media_report_imports(workspace_id,created_at DESC);
ALTER TABLE app.creative_media_report_imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.creative_media_report_imports FORCE ROW LEVEL SECURITY;
REVOKE ALL ON app.creative_media_report_imports FROM PUBLIC,r72_content_command,r72_web,r72_worker;
CREATE POLICY creative_media_reports_owner ON app.creative_media_report_imports TO r72_owner USING(true) WITH CHECK(true);
CREATE POLICY creative_media_reports_scope ON app.creative_media_report_imports TO r72_creative_studio_definer
  USING(workspace_id=app_private.current_workspace_id()) WITH CHECK(workspace_id=app_private.current_workspace_id());
GRANT SELECT,INSERT ON app.creative_media_report_imports TO r72_creative_studio_definer;
CREATE TRIGGER creative_media_reports_immutable BEFORE UPDATE OR DELETE ON app.creative_media_report_imports
  FOR EACH ROW EXECUTE FUNCTION app_private.seo_blog_append_only();
INSERT INTO app_private.workspace_table_registry(schema_name,table_name,workspace_column)
  VALUES('app','creative_media_report_imports','workspace_id');

GRANT CREATE ON SCHEMA app_private TO r72_creative_studio_definer;
SET LOCAL ROLE r72_creative_studio_definer;

CREATE FUNCTION app_private.creative_media_report_command(
  p_workspace uuid,p_session bytea,p_action text,p_input jsonb
) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE actor uuid; found app.creative_media_report_imports; incoming jsonb;
BEGIN
  IF p_session IS NULL OR app_private.current_actor_kind()<>'user' THEN
    RAISE EXCEPTION 'Owner portal session required' USING ERRCODE='42501';
  END IF;
  actor:=app_private.seo_media_owner(p_workspace,p_session);
  IF app_private.seo_blog_brand(p_workspace) IS NULL THEN
    RAISE EXCEPTION 'Brand unavailable' USING ERRCODE='42501';
  END IF;
  IF p_action='list' THEN
    RETURN coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'id',id,'source',source,'reportStart',report_start,
        'reportEnd',report_end,'currency',currency,
        'summary',payload-'rows','createdAt',created_at
      ) ORDER BY created_at DESC)
      FROM app.creative_media_report_imports WHERE workspace_id=p_workspace
    ),'[]'::jsonb);
  END IF;
  IF p_action NOT IN('save','get') OR p_input IS NULL OR jsonb_typeof(p_input)<>'object'
    OR octet_length(p_input::text)>550000 THEN
    RAISE EXCEPTION 'Invalid report action' USING ERRCODE='22023';
  END IF;
  IF coalesce(p_input->>'id','') !~
    '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'Invalid report ID' USING ERRCODE='22023';
  END IF;
  IF p_action='get' THEN
    RETURN (SELECT payload FROM app.creative_media_report_imports
      WHERE workspace_id=p_workspace AND id=(p_input->>'id')::uuid);
  END IF;
  IF coalesce(p_input->>'inputSha','') !~ '^[a-f0-9]{64}$'
    OR coalesce(p_input->>'sourceSha','') !~ '^[a-f0-9]{64}$'
    OR p_input->>'source' IS DISTINCT FROM 'user_uploaded_amazon_tracking_id_summary'
    OR p_input->>'currency' IS DISTINCT FROM 'GBP'
    OR coalesce(p_input->>'reportStart','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
    OR coalesce(p_input->>'reportEnd','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
    RAISE EXCEPTION 'Invalid report provenance and date range' USING ERRCODE='22023';
  END IF;
  incoming:=p_input->'payload';
  IF incoming IS NULL OR jsonb_typeof(incoming)<>'object' OR
    incoming->>'source' IS DISTINCT FROM 'user_uploaded_amazon_tracking_id_summary'
    OR incoming->>'currency' IS DISTINCT FROM 'GBP'
    OR jsonb_typeof(incoming->'rows') IS DISTINCT FROM 'array'
    OR jsonb_array_length(incoming->'rows') NOT BETWEEN 1 AND 2000
    OR octet_length(incoming::text)>524288 THEN
    RAISE EXCEPTION 'Invalid merchant-reported summary' USING ERRCODE='22023';
  END IF;
  -- Idempotent per imported file+date range, even if the owner resubmits another form.
  SELECT * INTO found FROM app.creative_media_report_imports
    WHERE workspace_id=p_workspace AND source_sha256=p_input->>'sourceSha'
      AND report_start=(p_input->>'reportStart')::date
      AND report_end=(p_input->>'reportEnd')::date;
  IF found.id IS NOT NULL THEN
    IF found.input_sha256 IS DISTINCT FROM p_input->>'inputSha' THEN
      RAISE EXCEPTION 'Report already saved with different content' USING ERRCODE='40001'; END IF;
    RETURN jsonb_build_object('replayed',true,'id',found.id);
  END IF;
  IF (SELECT count(*) FROM app.creative_media_report_imports WHERE workspace_id=p_workspace)>=200 THEN
    RAISE EXCEPTION 'Workspace report import limit reached' USING ERRCODE='55000';
  END IF;
  INSERT INTO app.creative_media_report_imports(workspace_id,id,source,source_sha256,
    report_start,report_end,currency,input_sha256,payload,created_by)
  VALUES(p_workspace,(p_input->>'id')::uuid,p_input->>'source',p_input->>'sourceSha',
    (p_input->>'reportStart')::date,(p_input->>'reportEnd')::date,
    p_input->>'currency',p_input->>'inputSha',incoming,actor);
  RETURN jsonb_build_object('replayed',false,'id',p_input->>'id');
END $f$;
REVOKE ALL ON FUNCTION app_private.creative_media_report_command(uuid,bytea,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.creative_media_report_command(uuid,bytea,text,jsonb) TO r72_content_command;
RESET ROLE;
SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private FROM r72_creative_studio_definer;
