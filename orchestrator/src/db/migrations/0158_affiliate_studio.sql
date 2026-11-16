-- 0158: Affiliate Studio, slice 1, the data layer only. A business keeps its own list of products it links to through an
-- affiliate programme (Amazon UK only for now), its programme details (tracking ID, the website that carries the links and
-- two confirmations) and the earnings reports it uploads. Nothing here is read by any page, worker or publisher yet.
--
-- New, all four in schema app, forced RLS, append-only (a BEFORE UPDATE OR DELETE row trigger and a BEFORE TRUNCATE
-- statement trigger, both app_private.seo_blog_append_only()), read and written only through the three definer functions:
--   app.affiliate_products             one row per product revision: a change or "stop using" is a new revision.
--   app.affiliate_product_commands     the replay ledger of product commands (one row per command id).
--   app.affiliate_programme_settings   one row per settings revision per programme.
--   app.affiliate_report_imports       one row per uploaded earnings report (figures as the programme reported them).
-- New function owner: NOLOGIN NOINHERIT r72_affiliate_definer, with the attribute and membership guard of 0157.
-- New functions (SECURITY DEFINER, search_path=pg_catalog), executable by r72_content_command only:
--   app_private.affiliate_product_command(uuid,bytea,text,jsonb)    list, get, add, edit, retire
--   app_private.affiliate_programme_command(uuid,bytea,text,jsonb)  get, save
--   app_private.affiliate_report_command(uuid,bytea,text,jsonb)     list, get, save
-- Every call: the session user must be r72_content_command (or a member of it), and the caller must hold a current portal
-- session of a person who manages this workspace, checked by 0137's app_private.seo_media_owner exactly as every
-- content owner function checks it (request context user, actor kind 'user', request workspace = the workspace asked
-- about, the session locked and live, can_manage_workspace). The workspace must be a content business
-- (app_private.seo_blog_brand). Writes are idempotent by command id: a replay with the same input answers the first
-- result; the same id with different input is refused.
--
-- Existing objects touched, and nothing else: four rows inserted into app_private.workspace_table_registry; grants to
-- the new role only (USAGE on schemas app and app_private; EXECUTE on app_private.current_workspace_id(),
-- current_user_id(), current_actor_kind(), seo_blog_brand(uuid) and seo_media_owner(uuid,bytea); CREATE on schema
-- app_private, revoked again before the end); r72_affiliate_definer granted to r72_owner. No existing table is altered,
-- locked, referenced by a foreign key, or given a trigger or policy; no existing function is replaced.
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';

DO $role$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='r72_affiliate_definer') THEN
    CREATE ROLE r72_affiliate_definer NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='r72_affiliate_definer' AND NOT rolcanlogin AND NOT rolinherit
      AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls)
    OR EXISTS(SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member WHERE r.rolname='r72_affiliate_definer') THEN
    RAISE EXCEPTION 'Unsafe affiliate function-owner attributes' USING ERRCODE='42501';
  END IF;
  IF EXISTS(SELECT 1 FROM pg_auth_members m JOIN pg_roles p ON p.oid=m.roleid JOIN pg_roles c ON c.oid=m.member
    WHERE p.rolname='r72_affiliate_definer' AND c.rolname NOT IN ('r72_owner',current_user)) THEN
    RAISE EXCEPTION 'Runtime membership in affiliate function owner denied' USING ERRCODE='42501';
  END IF;
  GRANT r72_affiliate_definer TO r72_owner;
END $role$;

SET LOCAL ROLE r72_owner;

-- A programme is one line in each CHECK below that names 'amazon_uk' (the programme lists, and one rule line each for
-- the product link and the tracking ID).
CREATE TABLE app.affiliate_products(
  workspace_id uuid NOT NULL,
  product_id uuid NOT NULL,
  revision integer NOT NULL CHECK(revision BETWEEN 1 AND 1000),
  programme text NOT NULL CHECK(programme IN('amazon_uk')),
  merchant_name text NOT NULL CHECK(length(merchant_name) BETWEEN 1 AND 140 AND merchant_name=btrim(merchant_name) AND merchant_name!~'[[:cntrl:]<>]'),
  product_name text NOT NULL CHECK(length(product_name) BETWEEN 1 AND 200 AND product_name=btrim(product_name) AND product_name!~'[[:cntrl:]<>]'),
  -- The programme's own product code (for Amazon UK, the ASIN).
  merchant_product_id text NOT NULL CHECK(merchant_product_id~'^[A-Z0-9]{1,40}$'),
  product_url text NOT NULL CHECK(length(product_url) BETWEEN 12 AND 2048 AND product_url~'^https://[^[:space:][:cntrl:]<>"''`]+$' AND product_url!~'^https://[^/?#]*@'),
  affiliate_url text NOT NULL CHECK(length(affiliate_url) BETWEEN 12 AND 2048 AND affiliate_url~'^https://[^[:space:][:cntrl:]<>"''`]+$' AND affiliate_url!~'^https://[^/?#]*@'),
  -- The maker's own page about the product, optional.
  info_url text CHECK(info_url IS NULL OR (length(info_url) BETWEEN 12 AND 2048 AND info_url~'^https://[^[:space:][:cntrl:]<>"''`]+$' AND info_url!~'^https://[^/?#]*@')),
  notes text CHECK(notes IS NULL OR (length(notes) BETWEEN 1 AND 2000 AND notes=btrim(notes) AND translate(notes,E'\n',' ')!~'[[:cntrl:]]')),
  owner_used boolean NOT NULL,
  status text NOT NULL CHECK(status IN('active','retired')),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,product_id,revision),
  CHECK(programme<>'amazon_uk' OR (merchant_product_id~'^[A-Z0-9]{10}$' AND product_url='https://www.amazon.co.uk/dp/'||merchant_product_id
    AND affiliate_url~'^https://www\.amazon\.co\.uk/dp/[A-Z0-9]{10}\?tag=[A-Za-z0-9][A-Za-z0-9-]{0,60}-21$' AND left(affiliate_url,38)=product_url))
);
CREATE INDEX affiliate_products_latest ON app.affiliate_products(workspace_id,product_id,revision DESC);

CREATE TABLE app.affiliate_product_commands(
  workspace_id uuid NOT NULL,
  command_id uuid NOT NULL,
  action text NOT NULL CHECK(action IN('add','edit','retire')),
  input_sha256 text NOT NULL CHECK(input_sha256~'^[0-9a-f]{64}$'),
  product_id uuid NOT NULL,
  revision integer NOT NULL,
  actor_user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,command_id),
  FOREIGN KEY(workspace_id,product_id,revision) REFERENCES app.affiliate_products(workspace_id,product_id,revision)
);

CREATE TABLE app.affiliate_programme_settings(
  workspace_id uuid NOT NULL,
  programme text NOT NULL CHECK(programme IN('amazon_uk')),
  revision integer NOT NULL CHECK(revision BETWEEN 1 AND 1000),
  tracking_id text NOT NULL CHECK(length(tracking_id) BETWEEN 2 AND 64),
  -- The website that carries the links: an https origin, lower case, no path.
  registered_site text NOT NULL CHECK(length(registered_site)<=261
    AND registered_site~'^https://[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$'),
  -- "This website is listed in my programme account" and "this tracking ID is mine": both must be ticked.
  site_listed_confirmed boolean NOT NULL CHECK(site_listed_confirmed),
  account_confirmed boolean NOT NULL CHECK(account_confirmed),
  command_id uuid NOT NULL,
  input_sha256 text NOT NULL CHECK(input_sha256~'^[0-9a-f]{64}$'),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,programme,revision),
  UNIQUE(workspace_id,command_id),
  CHECK(programme<>'amazon_uk' OR tracking_id~'^[A-Za-z0-9][A-Za-z0-9-]{0,60}-21$')
);

CREATE TABLE app.affiliate_report_imports(
  workspace_id uuid NOT NULL,
  id uuid NOT NULL,
  programme text NOT NULL CHECK(programme IN('amazon_uk')),
  source text NOT NULL CHECK(source IN('user_uploaded_amazon_tracking_id_summary')),
  source_sha256 text NOT NULL CHECK(source_sha256~'^[0-9a-f]{64}$'),
  report_start date NOT NULL,
  report_end date NOT NULL,
  currency text NOT NULL CHECK(currency='GBP'),
  input_sha256 text NOT NULL CHECK(input_sha256~'^[0-9a-f]{64}$'),
  payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object' AND octet_length(payload::text)<=524288
    AND jsonb_typeof(payload->'rows')='array' AND jsonb_array_length(payload->'rows') BETWEEN 1 AND 2000),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,id),
  UNIQUE(workspace_id,source_sha256,report_start,report_end),
  CHECK(report_end>=report_start AND report_end<=report_start+366),
  CHECK(programme<>'amazon_uk' OR source='user_uploaded_amazon_tracking_id_summary')
);
CREATE INDEX affiliate_report_imports_latest ON app.affiliate_report_imports(workspace_id,created_at DESC);

DO $tables$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['affiliate_products','affiliate_product_commands','affiliate_programme_settings','affiliate_report_imports'] LOOP
    EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('REVOKE ALL ON app.%I FROM PUBLIC',t);
    EXECUTE format('CREATE POLICY %I ON app.%I FOR ALL TO r72_owner USING(true) WITH CHECK(true)',t||'_owner',t);
    EXECUTE format('CREATE POLICY %I ON app.%I FOR ALL TO r72_affiliate_definer USING(workspace_id=app_private.current_workspace_id()) WITH CHECK(workspace_id=app_private.current_workspace_id())',t||'_scope',t);
    EXECUTE format('GRANT SELECT,INSERT ON app.%I TO r72_affiliate_definer',t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON app.%I FOR EACH ROW EXECUTE FUNCTION app_private.seo_blog_append_only()',t||'_immutable',t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON app.%I FOR EACH STATEMENT EXECUTE FUNCTION app_private.seo_blog_append_only()',t||'_no_truncate',t);
    INSERT INTO app_private.workspace_table_registry(schema_name,table_name,workspace_column) VALUES('app',t,'workspace_id');
  END LOOP;
END $tables$;

GRANT USAGE ON SCHEMA app,app_private TO r72_affiliate_definer;
GRANT EXECUTE ON FUNCTION app_private.current_workspace_id(),app_private.current_user_id(),app_private.current_actor_kind(),
  app_private.seo_blog_brand(uuid),app_private.seo_media_owner(uuid,bytea) TO r72_affiliate_definer;

GRANT CREATE ON SCHEMA app_private TO r72_affiliate_definer;
SET LOCAL ROLE r72_affiliate_definer;

-- Inner: the person behind this call, or refuse (42501). Not granted to anyone.
CREATE FUNCTION app_private.affiliate_owner(p_workspace uuid,p_session bytea) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE actor uuid;
BEGIN
  IF NOT pg_has_role(session_user,'r72_content_command','MEMBER') THEN
    RAISE EXCEPTION 'Affiliate boundary required' USING ERRCODE='42501';
  END IF;
  IF p_workspace IS NULL OR p_session IS NULL OR octet_length(p_session)<>32 OR app_private.current_actor_kind() IS DISTINCT FROM 'user' THEN
    RAISE EXCEPTION 'A current signed-in owner is required' USING ERRCODE='42501';
  END IF;
  actor:=app_private.seo_media_owner(p_workspace,p_session);
  IF actor IS NULL OR app_private.seo_blog_brand(p_workspace) IS NULL THEN
    RAISE EXCEPTION 'Business unavailable' USING ERRCODE='42501';
  END IF;
  RETURN actor;
END $f$;

-- Inner: a valid uuid from a jsonb field, or refuse (22023).
CREATE FUNCTION app_private.affiliate_uuid(p_value jsonb,p_label text) RETURNS uuid
LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
BEGIN
  IF p_value IS NULL OR jsonb_typeof(p_value)<>'string'
    OR (p_value#>>'{}')!~'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'Invalid %',p_label USING ERRCODE='22023';
  END IF;
  RETURN (p_value#>>'{}')::uuid;
END $f$;

-- Inner: one product as the store reads it.
CREATE FUNCTION app_private.affiliate_product_json(p app.affiliate_products) RETURNS jsonb
LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
  SELECT jsonb_build_object('productId',p.product_id,'revision',p.revision,'programme',p.programme,'merchantName',p.merchant_name,
    'productName',p.product_name,'merchantProductId',p.merchant_product_id,'productUrl',p.product_url,'affiliateUrl',p.affiliate_url,
    'infoUrl',p.info_url,'notes',p.notes,'ownerUsed',p.owner_used,'status',p.status,'createdAt',p.created_at)
$f$;

-- Inner: the latest settings revision for one programme, or NULL.
CREATE FUNCTION app_private.affiliate_settings_json(p_workspace uuid,p_programme text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
  SELECT jsonb_build_object('programme',s.programme,'revision',s.revision,'trackingId',s.tracking_id,'registeredSite',s.registered_site,
    'siteListedConfirmed',s.site_listed_confirmed,'accountConfirmed',s.account_confirmed,'createdAt',s.created_at)
  FROM app.affiliate_programme_settings s WHERE s.workspace_id=p_workspace AND s.programme=p_programme
  ORDER BY s.revision DESC LIMIT 1
$f$;

-- Products. p_input by action:
--   list    {}                                                     every product, latest revision each, newest first
--   get     {productId}                                            the latest revision, or null
--   add     {commandId,productId,product}                          a new product (revision 1, active)
--   edit    {commandId,productId,expectedRevision,product}         a new revision of an active product
--   retire  {commandId,productId,expectedRevision}                 a new revision with status 'retired'
-- product: {programme,merchantName,productName,merchantProductId,productUrl,affiliateUrl,infoUrl,notes,ownerUsed}.
-- add and edit need the programme's settings, and the link's tracking ID must be the one saved there. At most 500
-- active products per business. Answers {replayed,productId,revision,status}.
CREATE FUNCTION app_private.affiliate_product_command(p_workspace uuid,p_session bytea,p_action text,p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE actor uuid; cmd uuid; pid uuid; sha text; rec jsonb; wanted integer; v_status text; active_count integer;
  replay app.affiliate_product_commands; latest app.affiliate_products; newrow app.affiliate_products; settings jsonb; v_programme text;
BEGIN
  actor:=app_private.affiliate_owner(p_workspace,p_session);
  IF p_input IS NULL OR jsonb_typeof(p_input)<>'object' OR octet_length(p_input::text)>16384 THEN
    RAISE EXCEPTION 'Invalid affiliate product request' USING ERRCODE='22023';
  END IF;
  IF p_action='list' THEN
    RETURN coalesce((SELECT jsonb_agg(app_private.affiliate_product_json(x) ORDER BY x.created_at DESC,x.product_id)
      FROM app.affiliate_products x WHERE x.workspace_id=p_workspace AND NOT EXISTS(SELECT 1 FROM app.affiliate_products y
        WHERE y.workspace_id=x.workspace_id AND y.product_id=x.product_id AND y.revision>x.revision)),'[]'::jsonb);
  END IF;
  IF p_action IS NULL OR p_action NOT IN('get','add','edit','retire') THEN
    RAISE EXCEPTION 'Unsupported affiliate product action' USING ERRCODE='22023';
  END IF;
  pid:=app_private.affiliate_uuid(p_input->'productId','product');
  IF p_action='get' THEN
    RETURN (SELECT app_private.affiliate_product_json(x) FROM app.affiliate_products x
      WHERE x.workspace_id=p_workspace AND x.product_id=pid ORDER BY x.revision DESC LIMIT 1);
  END IF;
  cmd:=app_private.affiliate_uuid(p_input->'commandId','command');
  -- The digest of everything asked except the command id itself (jsonb text is canonical).
  sha:=encode(sha256(convert_to((p_input-'commandId')::text,'UTF8')),'hex');
  -- One writer per business at a time: replays, revisions and the cap are decided under this lock.
  PERFORM pg_advisory_xact_lock(hashtextextended('affiliate-products:'||p_workspace::text,158));
  SELECT * INTO replay FROM app.affiliate_product_commands c WHERE c.workspace_id=p_workspace AND c.command_id=cmd;
  IF FOUND THEN
    IF replay.input_sha256<>sha OR replay.action<>p_action OR replay.product_id<>pid THEN
      RAISE EXCEPTION 'This command was already used for something else' USING ERRCODE='23505', DETAIL='affiliate_command_reused';
    END IF;
    RETURN jsonb_build_object('replayed',true,'productId',replay.product_id,'revision',replay.revision,
      'status',(SELECT x.status FROM app.affiliate_products x WHERE x.workspace_id=p_workspace AND x.product_id=replay.product_id AND x.revision=replay.revision));
  END IF;
  SELECT * INTO latest FROM app.affiliate_products x WHERE x.workspace_id=p_workspace AND x.product_id=pid ORDER BY x.revision DESC LIMIT 1;
  IF p_action='add' THEN
    IF latest.product_id IS NOT NULL THEN
      RAISE EXCEPTION 'This product already exists' USING ERRCODE='40001', DETAIL='affiliate_stale';
    END IF;
  ELSE
    IF jsonb_typeof(p_input->'expectedRevision') IS DISTINCT FROM 'number' OR (p_input->>'expectedRevision')!~'^[1-9][0-9]{0,3}$' THEN
      RAISE EXCEPTION 'Expected revision required' USING ERRCODE='22023';
    END IF;
    wanted:=(p_input->>'expectedRevision')::integer;
    IF latest.product_id IS NULL THEN
      RAISE EXCEPTION 'No such product' USING ERRCODE='22023', DETAIL='affiliate_not_found';
    END IF;
    IF latest.revision<>wanted OR latest.status<>'active' OR latest.revision>=1000 THEN
      RAISE EXCEPTION 'This product changed; read it again' USING ERRCODE='40001', DETAIL='affiliate_stale';
    END IF;
  END IF;
  IF p_action='retire' THEN
    INSERT INTO app.affiliate_products(workspace_id,product_id,revision,programme,merchant_name,product_name,merchant_product_id,product_url,
      affiliate_url,info_url,notes,owner_used,status,created_by)
    VALUES(p_workspace,pid,latest.revision+1,latest.programme,latest.merchant_name,latest.product_name,latest.merchant_product_id,latest.product_url,
      latest.affiliate_url,latest.info_url,latest.notes,latest.owner_used,'retired',actor)
    RETURNING * INTO newrow;
  ELSE
    rec:=p_input->'product';
    IF rec IS NULL OR jsonb_typeof(rec)<>'object' OR jsonb_typeof(rec->'programme') IS DISTINCT FROM 'string'
      OR jsonb_typeof(rec->'merchantName') IS DISTINCT FROM 'string' OR jsonb_typeof(rec->'productName') IS DISTINCT FROM 'string'
      OR jsonb_typeof(rec->'merchantProductId') IS DISTINCT FROM 'string' OR jsonb_typeof(rec->'productUrl') IS DISTINCT FROM 'string'
      OR jsonb_typeof(rec->'affiliateUrl') IS DISTINCT FROM 'string' OR jsonb_typeof(rec->'ownerUsed') IS DISTINCT FROM 'boolean'
      OR coalesce(jsonb_typeof(rec->'infoUrl'),'null') NOT IN('null','string') OR coalesce(jsonb_typeof(rec->'notes'),'null') NOT IN('null','string') THEN
      RAISE EXCEPTION 'Invalid affiliate product' USING ERRCODE='22023';
    END IF;
    v_programme:=rec->>'programme';
    IF p_action='edit' AND v_programme<>latest.programme THEN
      RAISE EXCEPTION 'A product keeps its programme' USING ERRCODE='22023';
    END IF;
    settings:=app_private.affiliate_settings_json(p_workspace,v_programme);
    IF settings IS NULL THEN
      RAISE EXCEPTION 'Programme details required first' USING ERRCODE='55000', DETAIL='affiliate_settings_required';
    END IF;
    IF v_programme='amazon_uk' AND (rec->>'affiliateUrl') IS DISTINCT FROM 'https://www.amazon.co.uk/dp/'||(rec->>'merchantProductId')||'?tag='||(settings->>'trackingId') THEN
      RAISE EXCEPTION 'The link must carry the saved tracking ID' USING ERRCODE='22023', DETAIL='affiliate_tag_mismatch';
    END IF;
    IF p_action='add' THEN
      SELECT count(*) INTO active_count FROM (SELECT DISTINCT ON(x.product_id) x.status FROM app.affiliate_products x
        WHERE x.workspace_id=p_workspace ORDER BY x.product_id,x.revision DESC) q WHERE q.status='active';
      IF active_count>=500 THEN
        RAISE EXCEPTION 'A business can use at most 500 products at once' USING ERRCODE='54000', DETAIL='affiliate_product_cap';
      END IF;
    END IF;
    INSERT INTO app.affiliate_products(workspace_id,product_id,revision,programme,merchant_name,product_name,merchant_product_id,product_url,
      affiliate_url,info_url,notes,owner_used,status,created_by)
    VALUES(p_workspace,pid,coalesce(latest.revision,0)+1,v_programme,rec->>'merchantName',rec->>'productName',rec->>'merchantProductId',
      rec->>'productUrl',rec->>'affiliateUrl',rec->>'infoUrl',rec->>'notes',(rec->>'ownerUsed')::boolean,'active',actor)
    RETURNING * INTO newrow;
  END IF;
  INSERT INTO app.affiliate_product_commands(workspace_id,command_id,action,input_sha256,product_id,revision,actor_user_id)
  VALUES(p_workspace,cmd,p_action,sha,pid,newrow.revision,actor);
  RETURN jsonb_build_object('replayed',false,'productId',pid,'revision',newrow.revision,'status',newrow.status);
END $f$;

-- Programme details. p_input by action:
--   get   {programme}                                     the latest revision, or null
--   save  {commandId,programme,expectedRevision,settings}  a new revision (expectedRevision 0 for the first)
-- settings: {trackingId,registeredSite,siteListedConfirmed,accountConfirmed} (both confirmations must be true).
-- Answers {replayed,programme,revision}.
CREATE FUNCTION app_private.affiliate_programme_command(p_workspace uuid,p_session bytea,p_action text,p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE actor uuid; cmd uuid; sha text; rec jsonb; wanted integer; previous integer; v_programme text;
  replay app.affiliate_programme_settings; newrow app.affiliate_programme_settings;
BEGIN
  actor:=app_private.affiliate_owner(p_workspace,p_session);
  IF p_input IS NULL OR jsonb_typeof(p_input)<>'object' OR octet_length(p_input::text)>4096
    OR p_action IS NULL OR p_action NOT IN('get','save') OR jsonb_typeof(p_input->'programme') IS DISTINCT FROM 'string'
    OR (p_input->>'programme') NOT IN('amazon_uk') THEN
    RAISE EXCEPTION 'Invalid affiliate programme request' USING ERRCODE='22023';
  END IF;
  v_programme:=p_input->>'programme';
  IF p_action='get' THEN RETURN app_private.affiliate_settings_json(p_workspace,v_programme); END IF;
  cmd:=app_private.affiliate_uuid(p_input->'commandId','command');
  sha:=encode(sha256(convert_to((p_input-'commandId')::text,'UTF8')),'hex');
  PERFORM pg_advisory_xact_lock(hashtextextended('affiliate-programme:'||p_workspace::text,158));
  SELECT * INTO replay FROM app.affiliate_programme_settings s WHERE s.workspace_id=p_workspace AND s.command_id=cmd;
  IF FOUND THEN
    IF replay.input_sha256<>sha OR replay.programme<>v_programme THEN
      RAISE EXCEPTION 'This command was already used for something else' USING ERRCODE='23505', DETAIL='affiliate_command_reused';
    END IF;
    RETURN jsonb_build_object('replayed',true,'programme',replay.programme,'revision',replay.revision);
  END IF;
  IF jsonb_typeof(p_input->'expectedRevision') IS DISTINCT FROM 'number' OR (p_input->>'expectedRevision')!~'^(0|[1-9][0-9]{0,3})$' THEN
    RAISE EXCEPTION 'Expected revision required' USING ERRCODE='22023';
  END IF;
  wanted:=(p_input->>'expectedRevision')::integer;
  rec:=p_input->'settings';
  IF rec IS NULL OR jsonb_typeof(rec)<>'object' OR jsonb_typeof(rec->'trackingId') IS DISTINCT FROM 'string'
    OR jsonb_typeof(rec->'registeredSite') IS DISTINCT FROM 'string'
    OR (rec->'siteListedConfirmed') IS DISTINCT FROM 'true'::jsonb OR (rec->'accountConfirmed') IS DISTINCT FROM 'true'::jsonb THEN
    RAISE EXCEPTION 'Invalid affiliate programme details' USING ERRCODE='22023';
  END IF;
  SELECT coalesce(max(s.revision),0) INTO previous FROM app.affiliate_programme_settings s WHERE s.workspace_id=p_workspace AND s.programme=v_programme;
  IF previous<>wanted OR previous>=1000 THEN
    RAISE EXCEPTION 'These details changed; read them again' USING ERRCODE='40001', DETAIL='affiliate_stale';
  END IF;
  INSERT INTO app.affiliate_programme_settings(workspace_id,programme,revision,tracking_id,registered_site,site_listed_confirmed,account_confirmed,
    command_id,input_sha256,created_by)
  VALUES(p_workspace,v_programme,previous+1,rec->>'trackingId',rec->>'registeredSite',true,true,cmd,sha,actor)
  RETURNING * INTO newrow;
  RETURN jsonb_build_object('replayed',false,'programme',newrow.programme,'revision',newrow.revision);
END $f$;

-- Earnings reports. p_input by action:
--   list  {}                                                       every import, newest first, without its rows
--   get   {id}                                                     one import with its rows, or null
--   save  {id,programme,source,sourceSha,reportStart,reportEnd,currency,payload}
-- The figures are what the programme reported in the file the owner uploaded; nothing is worked out or shared out here.
-- The same file for the same dates is saved once (a second upload answers the first id). At most 200 per business.
-- Answers {replayed,id}.
CREATE FUNCTION app_private.affiliate_report_command(p_workspace uuid,p_session bytea,p_action text,p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE actor uuid; rid uuid; sha text; incoming jsonb; v_start date; v_end date; found_row app.affiliate_report_imports;
BEGIN
  actor:=app_private.affiliate_owner(p_workspace,p_session);
  IF p_input IS NULL OR jsonb_typeof(p_input)<>'object' OR octet_length(p_input::text)>550000 THEN
    RAISE EXCEPTION 'Invalid affiliate report request' USING ERRCODE='22023';
  END IF;
  IF p_action='list' THEN
    RETURN coalesce((SELECT jsonb_agg(jsonb_build_object('id',r.id,'programme',r.programme,'source',r.source,'reportStart',r.report_start,
      'reportEnd',r.report_end,'currency',r.currency,'summary',r.payload-'rows','rowCount',jsonb_array_length(r.payload->'rows'),'createdAt',r.created_at)
      ORDER BY r.created_at DESC,r.id) FROM app.affiliate_report_imports r WHERE r.workspace_id=p_workspace),'[]'::jsonb);
  END IF;
  IF p_action IS NULL OR p_action NOT IN('get','save') THEN
    RAISE EXCEPTION 'Unsupported affiliate report action' USING ERRCODE='22023';
  END IF;
  rid:=app_private.affiliate_uuid(p_input->'id','report');
  IF p_action='get' THEN
    RETURN (SELECT jsonb_build_object('id',r.id,'programme',r.programme,'source',r.source,'reportStart',r.report_start,'reportEnd',r.report_end,
      'currency',r.currency,'payload',r.payload,'createdAt',r.created_at) FROM app.affiliate_report_imports r WHERE r.workspace_id=p_workspace AND r.id=rid);
  END IF;
  IF (p_input->>'programme') IS DISTINCT FROM 'amazon_uk' OR (p_input->>'source') IS DISTINCT FROM 'user_uploaded_amazon_tracking_id_summary'
    OR (p_input->>'currency') IS DISTINCT FROM 'GBP' OR coalesce(p_input->>'sourceSha','')!~'^[0-9a-f]{64}$'
    OR coalesce(p_input->>'reportStart','')!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}$' OR coalesce(p_input->>'reportEnd','')!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
    RAISE EXCEPTION 'Invalid report details' USING ERRCODE='22023';
  END IF;
  v_start:=(p_input->>'reportStart')::date; v_end:=(p_input->>'reportEnd')::date;
  IF v_end<v_start OR v_end>v_start+366 THEN RAISE EXCEPTION 'Invalid report dates' USING ERRCODE='22023'; END IF;
  incoming:=p_input->'payload';
  IF incoming IS NULL OR jsonb_typeof(incoming)<>'object' OR (incoming->>'source') IS DISTINCT FROM (p_input->>'source')
    OR (incoming->>'currency') IS DISTINCT FROM 'GBP' OR jsonb_typeof(incoming->'rows') IS DISTINCT FROM 'array'
    OR jsonb_array_length(incoming->'rows') NOT BETWEEN 1 AND 2000 OR octet_length(incoming::text)>524288
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(incoming->'rows') e WHERE jsonb_typeof(e.value)<>'object'
      OR jsonb_typeof(e.value->'trackingId') IS DISTINCT FROM 'string') THEN
    RAISE EXCEPTION 'Invalid report figures' USING ERRCODE='22023';
  END IF;
  sha:=encode(sha256(convert_to((p_input-'id')::text,'UTF8')),'hex');
  PERFORM pg_advisory_xact_lock(hashtextextended('affiliate-reports:'||p_workspace::text,158));
  SELECT * INTO found_row FROM app.affiliate_report_imports r WHERE r.workspace_id=p_workspace AND r.id=rid;
  IF FOUND THEN
    IF found_row.input_sha256<>sha THEN
      RAISE EXCEPTION 'This command was already used for something else' USING ERRCODE='23505', DETAIL='affiliate_command_reused';
    END IF;
    RETURN jsonb_build_object('replayed',true,'id',found_row.id);
  END IF;
  -- The same file for the same dates: the first upload stands, whatever id the second one carried.
  SELECT * INTO found_row FROM app.affiliate_report_imports r WHERE r.workspace_id=p_workspace AND r.source_sha256=p_input->>'sourceSha'
    AND r.report_start=v_start AND r.report_end=v_end;
  IF FOUND THEN
    IF found_row.input_sha256<>sha THEN
      RAISE EXCEPTION 'This report was already saved with different figures' USING ERRCODE='23505', DETAIL='affiliate_report_conflict';
    END IF;
    RETURN jsonb_build_object('replayed',true,'id',found_row.id);
  END IF;
  IF (SELECT count(*) FROM app.affiliate_report_imports r WHERE r.workspace_id=p_workspace)>=200 THEN
    RAISE EXCEPTION 'A business can keep at most 200 reports' USING ERRCODE='54000', DETAIL='affiliate_report_cap';
  END IF;
  INSERT INTO app.affiliate_report_imports(workspace_id,id,programme,source,source_sha256,report_start,report_end,currency,input_sha256,payload,created_by)
  VALUES(p_workspace,rid,p_input->>'programme',p_input->>'source',p_input->>'sourceSha',v_start,v_end,'GBP',sha,incoming,actor);
  RETURN jsonb_build_object('replayed',false,'id',rid);
END $f$;

REVOKE ALL ON FUNCTION app_private.affiliate_owner(uuid,bytea),
  app_private.affiliate_uuid(jsonb,text),
  app_private.affiliate_product_json(app.affiliate_products),
  app_private.affiliate_settings_json(uuid,text),
  app_private.affiliate_product_command(uuid,bytea,text,jsonb),
  app_private.affiliate_programme_command(uuid,bytea,text,jsonb),
  app_private.affiliate_report_command(uuid,bytea,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.affiliate_product_command(uuid,bytea,text,jsonb),
  app_private.affiliate_programme_command(uuid,bytea,text,jsonb),
  app_private.affiliate_report_command(uuid,bytea,text,jsonb) TO r72_content_command;

RESET ROLE;
SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private FROM r72_affiliate_definer;
RESET ROLE;
