-- 0156: additive, disabled-by-default affiliate product catalogue for the existing Creative Studio.
-- This is owner-editable source metadata, NOT merchant eligibility certification or publication.
-- It adds no outbound links, paid jobs, background workers or new public permissions.
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';

SET LOCAL ROLE r72_owner;

CREATE TABLE app.creative_media_products (
  workspace_id uuid NOT NULL REFERENCES app.seo_blog_brands(workspace_id),
  product_id uuid NOT NULL,
  revision integer NOT NULL CHECK(revision BETWEEN 1 AND 1000),
  network text NOT NULL CHECK(network IN ('amazon_associates','other')),
  merchant_name text NOT NULL CHECK(length(merchant_name) BETWEEN 1 AND 140 AND merchant_name=btrim(merchant_name)
    AND merchant_name!~'[[:cntrl:]<>]'),
  product_name text NOT NULL CHECK(length(product_name) BETWEEN 1 AND 200 AND product_name=btrim(product_name)
    AND product_name!~'[[:cntrl:]<>]'),
  product_url text NOT NULL CHECK(length(product_url) BETWEEN 12 AND 2048
    AND product_url~'^https://[^[:space:]<>]+$'),
  -- This is a user-provided link, NOT a verified Amazon Special Link. Never auto-publish it.
  proposed_affiliate_url text CHECK(proposed_affiliate_url IS NULL OR
    (length(proposed_affiliate_url) BETWEEN 12 AND 2048 AND proposed_affiliate_url~'^https://[^[:space:]<>]+$')),
  source_rights text NOT NULL CHECK(source_rights IN ('original','owned','licensed','none')),
  evidence_sha256 text CHECK(evidence_sha256 IS NULL OR evidence_sha256~'^[0-9a-f]{64}$'),
  -- Owner assertions are kept distinct from platform verification; no feature may treat them as merchant proof.
  owner_product_reviewed boolean NOT NULL DEFAULT false,
  owner_channel_eligible boolean NOT NULL DEFAULT false,
  owner_media_rights_confirmed boolean NOT NULL DEFAULT false,
  disclosure_version text NOT NULL CHECK(length(disclosure_version) BETWEEN 1 AND 60),
  created_by uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,product_id,revision),
  CHECK(source_rights<>'licensed' OR evidence_sha256 IS NOT NULL),
  CHECK(source_rights<>'none' OR owner_media_rights_confirmed=false)
);
CREATE INDEX creative_media_products_latest ON app.creative_media_products(workspace_id,product_id,revision DESC);
CREATE TABLE app.creative_media_product_commands (
  workspace_id uuid NOT NULL REFERENCES app.seo_blog_brands(workspace_id),
  command_id uuid NOT NULL,
  input_sha256 text NOT NULL CHECK(input_sha256~'^[0-9a-f]{64}$'),
  product_id uuid NOT NULL,
  revision integer NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,command_id),
  FOREIGN KEY(workspace_id,product_id,revision)
    REFERENCES app.creative_media_products(workspace_id,product_id,revision)
);

DO $tables$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['creative_media_products','creative_media_product_commands'] LOOP
    EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('REVOKE ALL ON app.%I FROM PUBLIC,r72_content_command,r72_web,r72_worker',t);
    EXECUTE format('CREATE POLICY %I ON app.%I FOR ALL TO r72_owner USING(true) WITH CHECK(true)',t||'_owner',t);
    EXECUTE format('CREATE POLICY %I ON app.%I FOR ALL TO r72_creative_studio_definer USING(workspace_id=app_private.current_workspace_id()) WITH CHECK(workspace_id=app_private.current_workspace_id())',t||'_scope',t);
    EXECUTE format('GRANT SELECT,INSERT ON app.%I TO r72_creative_studio_definer',t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON app.%I FOR EACH ROW EXECUTE FUNCTION app_private.seo_blog_append_only()',t||'_immutable',t);
    INSERT INTO app_private.workspace_table_registry(schema_name,table_name,workspace_column)
      VALUES('app',t,'workspace_id');
  END LOOP;
END $tables$;

GRANT CREATE ON SCHEMA app_private TO r72_creative_studio_definer;
SET LOCAL ROLE r72_creative_studio_definer;

-- Only the content-command connection can execute this and ONLY with a valid owner session
-- re-validated through seo_media_owner. The portal never reads these tables directly.
CREATE FUNCTION app_private.creative_media_product_command(
  p_workspace uuid,p_session bytea,p_action text,p_input jsonb
) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE actor uuid; pid uuid; cmd uuid; wanted integer; previous integer; rec jsonb;
  replay app.creative_media_product_commands; newrow app.creative_media_products; sha text;
BEGIN
  IF p_session IS NULL OR app_private.current_actor_kind()<>'user' THEN
    RAISE EXCEPTION 'A current signed-in owner is required' USING ERRCODE='42501';
  END IF;
  actor:=app_private.seo_media_owner(p_workspace,p_session);
  IF app_private.seo_blog_brand(p_workspace) IS NULL THEN
    RAISE EXCEPTION 'Brand unavailable' USING ERRCODE='42501';
  END IF;
  IF p_action='list' THEN
    RETURN coalesce((SELECT jsonb_agg(to_jsonb(q) ORDER BY q.created_at DESC)
      FROM (
        SELECT DISTINCT ON(product_id) product_id, revision, network, merchant_name,
          product_name, product_url, proposed_affiliate_url, source_rights,
          evidence_sha256, owner_product_reviewed, owner_channel_eligible,
          owner_media_rights_confirmed, disclosure_version, created_at
        FROM app.creative_media_products
        WHERE workspace_id=p_workspace ORDER BY product_id,revision DESC
      ) q),'[]'::jsonb);
  END IF;
  IF p_action NOT IN ('save','get') OR p_input IS NULL
     OR jsonb_typeof(p_input)<>'object' OR octet_length(p_input::text)>8192 THEN
    RAISE EXCEPTION 'Unsupported media product action' USING ERRCODE='22023';
  END IF;
  IF coalesce(p_input->>'productId','') !~
     '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'Invalid product id' USING ERRCODE='22023';
  END IF;
  pid:=(p_input->>'productId')::uuid;
  IF p_action='get' THEN
    RETURN (SELECT to_jsonb(q) FROM app.creative_media_products q
      WHERE q.workspace_id=p_workspace AND q.product_id=pid
      ORDER BY q.revision DESC LIMIT 1);
  END IF;
  IF coalesce(p_input->>'commandId','') !~
     '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    OR coalesce(p_input->>'inputSha','') !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'Valid command and request digest required' USING ERRCODE='22023';
  END IF;
  cmd:=(p_input->>'commandId')::uuid; sha:=p_input->>'inputSha'; rec:=p_input->'product';
  SELECT * INTO replay FROM app.creative_media_product_commands
    WHERE workspace_id=p_workspace AND command_id=cmd;
  IF replay.command_id IS NOT NULL THEN
    IF replay.input_sha256 IS DISTINCT FROM sha OR replay.product_id IS DISTINCT FROM pid THEN
      RAISE EXCEPTION 'Command replay changed input' USING ERRCODE='40001';
    END IF;
    RETURN jsonb_build_object('replayed',true,'productId',pid,'revision',replay.revision);
  END IF;
  IF rec IS NULL OR jsonb_typeof(rec)<>'object' OR rec->>'network' NOT IN ('amazon_associates','other')
    OR rec->>'sourceRights' NOT IN ('original','owned','licensed','none')
    OR coalesce(rec->>'productName','')='' OR coalesce(rec->>'merchantName','')=''
    OR coalesce(rec->>'disclosureVersion','')='' THEN
    RAISE EXCEPTION 'Valid product, merchant, rights, disclosure and network required' USING ERRCODE='22023';
  END IF;
  IF p_input->>'expectedRevision' IS NULL OR coalesce(p_input->>'expectedRevision','') !~ '^(0|[1-9][0-9]{0,3})$' THEN
    RAISE EXCEPTION 'Expected revision required' USING ERRCODE='22023';
  END IF;
  wanted:=(p_input->>'expectedRevision')::integer;
  -- Serialise catalogue writes to one workspace. The command id also makes retries safe.
  PERFORM pg_advisory_xact_lock(hashtextextended('r72-media-product:'||p_workspace::text,0));
  SELECT * INTO replay FROM app.creative_media_product_commands
    WHERE workspace_id=p_workspace AND command_id=cmd;
  IF replay.command_id IS NOT NULL THEN
    IF replay.input_sha256 IS DISTINCT FROM sha OR replay.product_id IS DISTINCT FROM pid THEN
      RAISE EXCEPTION 'Command replay changed input' USING ERRCODE='40001'; END IF;
    RETURN jsonb_build_object('replayed',true,'productId',pid,'revision',replay.revision);
  END IF;
  SELECT coalesce(max(revision),0) INTO previous FROM app.creative_media_products
    WHERE workspace_id=p_workspace AND product_id=pid;
  IF previous<>wanted OR wanted>=1000 THEN
    RAISE EXCEPTION 'Product changed; refresh its current revision' USING ERRCODE='40001';
  END IF;
  INSERT INTO app.creative_media_products(workspace_id,product_id,revision,network,merchant_name,
    product_name,product_url,proposed_affiliate_url,source_rights,evidence_sha256,
    owner_product_reviewed,owner_channel_eligible,owner_media_rights_confirmed,disclosure_version,created_by)
  VALUES(p_workspace,pid,previous+1,rec->>'network',rec->>'merchantName',rec->>'productName',
    rec->>'productUrl',NULLIF(rec->>'affiliateUrl',''),rec->>'sourceRights',
    NULLIF(rec->>'evidenceSha256',''),(rec->>'productReviewed')::boolean,
    (rec->>'channelEligible')::boolean,(rec->>'mediaRightsConfirmed')::boolean,
    rec->>'disclosureVersion',actor)
  RETURNING * INTO newrow;
  INSERT INTO app.creative_media_product_commands(workspace_id,command_id,input_sha256,product_id,revision,actor_user_id)
    VALUES(p_workspace,cmd,sha,pid,newrow.revision,actor);
  RETURN jsonb_build_object('replayed',false,'productId',pid,'revision',newrow.revision);
END $f$;
REVOKE ALL ON FUNCTION app_private.creative_media_product_command(uuid,bytea,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.creative_media_product_command(uuid,bytea,text,jsonb) TO r72_content_command;

RESET ROLE;
SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private FROM r72_creative_studio_definer;
