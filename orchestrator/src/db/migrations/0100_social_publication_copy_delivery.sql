BEGIN;

-- Company-content social versions are immutable canonical JSON. Delivery must
-- use only the publication body; artwork instructions remain approval evidence
-- and must never be pasted into a provider post.
CREATE OR REPLACE FUNCTION app_private.company_content_social_publication_copy(
  p_content_body text
) RETURNS text
LANGUAGE plpgsql IMMUTABLE STRICT SET search_path = pg_catalog AS $function$
DECLARE
  decoded jsonb;
  publication_copy text;
BEGIN
  BEGIN
    decoded := p_content_body::jsonb;
  EXCEPTION WHEN invalid_text_representation THEN
    RETURN p_content_body;
  END;
  IF jsonb_typeof(decoded) <> 'object'
     OR decoded->>'schema' <> 'propertypredator.company-content/v1' THEN
    RETURN p_content_body;
  END IF;
  IF NOT (decoded ?& ARRAY['body','cta_url','kind','platform','schema','title','type'])
     OR EXISTS (
       SELECT 1 FROM jsonb_object_keys(decoded) AS key
       WHERE key <> ALL (ARRAY[
         'artwork_instructions','body','contextSha256','cta_url',
         'kind','platform','schema','title','type'
       ])
     ) THEN
    RAISE EXCEPTION 'Company social payload shape denied' USING ERRCODE = '22023';
  END IF;
  publication_copy := decoded->>'body';
  IF publication_copy IS NULL OR length(pg_catalog.btrim(publication_copy)) < 1 THEN
    RAISE EXCEPTION 'Company social publication copy denied' USING ERRCODE = '22023';
  END IF;
  RETURN publication_copy;
END
$function$;

REVOKE ALL ON FUNCTION app_private.company_content_social_publication_copy(text) FROM PUBLIC;

-- Patch both established SECURITY DEFINER commands without changing their
-- signatures, ownership, role grants or old job digests. Exact replacement
-- counts fail the migration closed if an earlier definition ever drifts.
DO $migration$
DECLARE
  function_definition text;
  replacement text;
BEGIN
  SELECT pg_get_functiondef(proc.oid) INTO function_definition
  FROM pg_proc AS proc
  JOIN pg_namespace AS namespace ON namespace.oid = proc.pronamespace
  WHERE namespace.nspname = 'app_private'
    AND proc.proname = 'enqueue_zernio_calendar_from_connected_account';
  IF function_definition IS NULL THEN
    RAISE EXCEPTION 'Zernio calendar outer command definition unavailable';
  END IF;
  replacement := pg_catalog.replace(
    function_definition,
    'public.digest(version.content_body, ''sha256'') AS body_sha256',
    'public.digest(app_private.company_content_social_publication_copy(version.content_body), ''sha256'') AS body_sha256'
  );
  IF replacement = function_definition THEN
    RAISE EXCEPTION 'Zernio calendar outer command publication-copy patch did not apply';
  END IF;
  EXECUTE replacement;

  SELECT pg_get_functiondef(proc.oid) INTO function_definition
  FROM pg_proc AS proc
  JOIN pg_namespace AS namespace ON namespace.oid = proc.pronamespace
  WHERE namespace.nspname = 'app_private'
    AND proc.proname = 'enqueue_zernio_calendar_job';
  IF function_definition IS NULL THEN
    RAISE EXCEPTION 'Zernio calendar inner command definition unavailable';
  END IF;
  replacement := pg_catalog.replace(
    function_definition,
    'SELECT version.content_body, version.content_sha256 INTO selected_version',
    'SELECT version.content_body, version.content_sha256, app_private.company_content_social_publication_copy(version.content_body) AS publication_copy INTO selected_version'
  );
  replacement := pg_catalog.replace(
    replacement,
    'length(selected_version.content_body)',
    'length(selected_version.publication_copy)'
  );
  replacement := pg_catalog.replace(
    replacement,
    'public.digest(selected_version.content_body, ''sha256'')',
    'public.digest(selected_version.publication_copy, ''sha256'')'
  );
  replacement := pg_catalog.replace(
    replacement,
    'selected_version.content_body, p_scheduled_for',
    'selected_version.publication_copy, p_scheduled_for'
  );
  IF replacement = function_definition
     OR pg_catalog.strpos(replacement, 'selected_version.publication_copy') = 0
     OR pg_catalog.strpos(
       replacement, 'public.digest(selected_version.content_body, ''sha256'')'
     ) > 0
     OR pg_catalog.strpos(
       replacement, 'selected_version.content_body, p_scheduled_for'
     ) > 0 THEN
    RAISE EXCEPTION 'Zernio calendar inner command publication-copy patch incomplete';
  END IF;
  EXECUTE replacement;
END
$migration$;

COMMIT;
