BEGIN;

-- Additive representation only: image bytes share the post's existing immutable
-- digest and approval. No new table, credentials, worker activation or approval.
GRANT CREATE ON SCHEMA app_private TO r72_owned_social_definer;
SET LOCAL ROLE r72_owned_social_definer;
CREATE FUNCTION app_private.company_content_social_image(p_content_body text)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE STRICT SET search_path = pg_catalog AS $function$
DECLARE decoded jsonb; image jsonb; raw bytea;
BEGIN
  BEGIN decoded := p_content_body::jsonb;
  EXCEPTION WHEN invalid_text_representation THEN RETURN NULL; END;
  IF jsonb_typeof(decoded) <> 'object'
     OR decoded->>'schema' IS DISTINCT FROM 'propertypredator.company-content/v1'
     OR NOT (decoded ? 'image') THEN RETURN NULL; END IF;
  image := decoded->'image';
  IF jsonb_typeof(image) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Social image shape denied' USING ERRCODE = '22023';
  END IF;
  IF NOT (image ?& ARRAY['mimeType','base64','sha256','width','height','alt'])
     OR EXISTS (SELECT 1 FROM jsonb_object_keys(image) AS key
       WHERE key <> ALL (ARRAY['mimeType','base64','sha256','width','height','alt']))
     OR image->>'mimeType' IS DISTINCT FROM 'image/jpeg'
     OR jsonb_typeof(image->'base64') IS DISTINCT FROM 'string'
     OR length(image->>'base64') NOT BETWEEN 20 AND 800000
     OR image->>'base64' !~ '^[A-Za-z0-9+/]+={0,2}$'
     OR image->>'sha256' !~ '^[0-9a-f]{64}$'
     OR jsonb_typeof(image->'sha256') IS DISTINCT FROM 'string'
     OR jsonb_typeof(image->'width') IS DISTINCT FROM 'number'
     OR jsonb_typeof(image->'height') IS DISTINCT FROM 'number'
     OR jsonb_typeof(image->'alt') IS DISTINCT FROM 'string'
     OR length(btrim(image->>'alt')) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'Social image representation denied' USING ERRCODE = '22023';
  END IF;
  IF image->>'width' !~ '^[0-9]+$' OR image->>'height' !~ '^[0-9]+$'
     OR (image->>'width')::numeric NOT BETWEEN 200 AND 2048
     OR (image->>'height')::numeric NOT BETWEEN 200 AND 2048 THEN
    RAISE EXCEPTION 'Social image dimensions denied' USING ERRCODE = '22023';
  END IF;
  raw := decode(image->>'base64', 'base64');
  IF octet_length(raw) NOT BETWEEN 20 AND 600000
     OR replace(encode(raw, 'base64'), E'\n', '') <> image->>'base64'
     OR encode(public.digest(raw, 'sha256'), 'hex') <> image->>'sha256'
     OR substring(raw FROM 1 FOR 2) <> decode('ffd8', 'hex')
     OR substring(raw FROM octet_length(raw)-1 FOR 2) <> decode('ffd9', 'hex') THEN
    RAISE EXCEPTION 'Social image bytes denied' USING ERRCODE = '22023';
  END IF;
  RETURN image;
END
$function$;
REVOKE ALL ON FUNCTION app_private.company_content_social_image(text) FROM PUBLIC;
RESET ROLE;
REVOKE CREATE ON SCHEMA app_private FROM r72_owned_social_definer;

-- Exact replacements preserve signatures, owners, grants and legacy jobs.
DO $migration$
DECLARE original text; updated text;
BEGIN
  SELECT pg_get_functiondef('app_private.company_content_social_publication_copy(text)'::regprocedure)
    INTO original;
  updated := replace(original, '''kind'',''platform'',''schema'',''title'',''type''',
    '''kind'',''platform'',''schema'',''title'',''type'',''image''');
  IF updated = original THEN RAISE EXCEPTION 'Publication image shape patch did not apply'; END IF;
  EXECUTE updated;

  SELECT pg_get_functiondef(proc.oid) INTO original
    FROM pg_proc proc JOIN pg_namespace ns ON ns.oid = proc.pronamespace
    WHERE ns.nspname = 'app_private' AND proc.proname = 'enqueue_zernio_calendar_job';
  updated := replace(original,
    'IF selected_media_count <> planned_media_count',
    'IF app_private.company_content_social_image(selected_version.content_body) IS NOT NULL THEN
       selected_media_count := selected_media_count + 1;
       planned_media_count := planned_media_count + 1;
     END IF;
     IF selected_media_count <> planned_media_count');
  IF updated = original THEN RAISE EXCEPTION 'Combined media count patch did not apply'; END IF;
  EXECUTE updated;

  SELECT pg_get_functiondef('app_private.load_zernio_calendar_job(uuid,uuid,bigint,bytea)'::regprocedure)
    INTO original;
  updated := replace(original, '), ''[]''::jsonb)',
    '), ''[]''::jsonb) || COALESCE((
      SELECT jsonb_build_array(jsonb_build_object(
        ''storageKey'', ''hq-social-image/'' || (image->>''sha256''),
        ''blobSha256'', image->>''sha256'', ''mimeType'', image->>''mimeType'',
        ''inlineImage'', image
      )) FROM app.company_content_versions AS version
      CROSS JOIN LATERAL (SELECT app_private.company_content_social_image(version.content_body) AS image) AS attachment
      WHERE version.workspace_id = job.workspace_id
        AND version.content_item_id = job.content_item_id
        AND version.id = job.content_version_id
        AND version.content_sha256 = job.content_sha256
        AND image IS NOT NULL
    ), ''[]''::jsonb)');
  IF updated = original THEN RAISE EXCEPTION 'Combined media load patch did not apply'; END IF;
  EXECUTE updated;
END
$migration$;
COMMIT;
