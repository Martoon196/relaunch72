BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- Only the existing private planner may compose these pure validators.
-- No web/command/worker login receives new execution or table privileges.
GRANT EXECUTE ON FUNCTION app_private.company_content_social_publication_copy(text)
  TO r72_public_social_definer;
GRANT EXECUTE ON FUNCTION app_private.company_content_social_image(text)
  TO r72_public_social_definer;

-- Preserve ownership, ACL and the old plain-text limit. The image keeps its
-- separate byte/digest/type/dimension checks and remains in the approved hash.
CREATE OR REPLACE FUNCTION app_private.public_social_body_supported(p_body text)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE decoded jsonb; checked_text text := p_body; publication_copy text;
BEGIN
  IF p_body IS NULL OR octet_length(p_body) NOT BETWEEN 1 AND 900000
     OR NOT app_private.public_social_display_text_supported(p_body) THEN
    RETURN false;
  END IF;
  BEGIN decoded := p_body::jsonb;
  EXCEPTION WHEN invalid_text_representation THEN decoded := NULL; END;
  IF jsonb_typeof(decoded) = 'object'
     AND decoded->>'schema' = 'propertypredator.company-content/v1'
     AND decoded ? 'image' THEN
    publication_copy := app_private.company_content_social_publication_copy(p_body);
    IF app_private.company_content_social_image(p_body) IS NULL
       OR octet_length(publication_copy) NOT BETWEEN 1 AND 16384
       OR NOT app_private.public_social_display_text_supported(publication_copy) THEN
      RETURN false;
    END IF;
    checked_text := (decoded - 'image')::text;
  END IF;
  RETURN octet_length(checked_text) BETWEEN 1 AND 16384
    AND app_private.public_social_display_text_supported(checked_text);
EXCEPTION WHEN data_exception THEN RETURN false;
END
$function$;
COMMIT;
