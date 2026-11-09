-- Keep the global company-content source proof window at 15 minutes. Permit
-- one 24-hour exception only for the deterministic Property Predator proof
-- bytes which can feed only the fixed owned-office campaign rail.

SET LOCAL ROLE r72_owner;

DO $replace_freshness_constraint$
DECLARE
  matching_constraints text[];
BEGIN
  SELECT pg_catalog.array_agg(constraint_record.conname ORDER BY constraint_record.conname)
    INTO matching_constraints
  FROM pg_catalog.pg_constraint AS constraint_record
  WHERE constraint_record.conrelid = 'app.company_content_source_attestations'::regclass
    AND constraint_record.contype = 'c'
    AND pg_catalog.strpos(
      pg_catalog.pg_get_constraintdef(constraint_record.oid), 'expires_at'
    ) > 0
    AND pg_catalog.strpos(
      pg_catalog.pg_get_constraintdef(constraint_record.oid), 'checked_at'
    ) > 0
    AND pg_catalog.strpos(
      pg_catalog.pg_get_constraintdef(constraint_record.oid), '<='
    ) > 0;

  IF coalesce(pg_catalog.cardinality(matching_constraints), 0) <> 1 THEN
    RAISE EXCEPTION
      'Expected exactly one legacy company-content attestation freshness constraint';
  END IF;

  EXECUTE pg_catalog.format(
    'ALTER TABLE app.company_content_source_attestations DROP CONSTRAINT %I',
    matching_constraints[1]
  );
END
$replace_freshness_constraint$;

ALTER TABLE app.company_content_source_attestations
  ADD CONSTRAINT company_content_source_attestations_freshness_window
  CHECK (
    expires_at <= checked_at + interval '15 minutes'
    OR (
      source_system = 'propertypredator.company-content'
      AND source_item_id = 'growth-hq-owned-seed-delivery-proof'
      AND (
        source_version = 'operational-proof-v1'
        OR source_version ~ '^operational-proof-[0-9]{17}-[0-9a-f]{16}$'
      )
      AND content_sha256 = pg_catalog.decode(
        '6dd76f99e782b91b6db96ed15d1867bdab9f70d9594719e75b33e6cafcb19148',
        'hex'
      )
      AND blob_sha256 = content_sha256
      AND expires_at <= checked_at + interval '24 hours'
    )
  );

CREATE FUNCTION app_private.guard_property_predator_owned_seed_attestation_window()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
BEGIN
  IF NEW.expires_at > NEW.checked_at + interval '15 minutes'
     AND NOT EXISTS (
       SELECT 1
       FROM app.company_content_versions AS version
       WHERE version.workspace_id = NEW.workspace_id
         AND version.content_item_id = NEW.content_item_id
         AND version.id = NEW.content_version_id
         AND version.source_system = NEW.source_system
         AND version.source_item_id = NEW.source_item_id
         AND version.source_version = NEW.source_version
         AND version.content_sha256 = NEW.content_sha256
         AND version.blob_sha256 = NEW.blob_sha256
         AND version.brand_sha256 = NEW.brand_sha256
         AND version.content_kind = 'email'
         AND version.content_mime_type
           = 'application/vnd.propertypredator.email-draft+json'
         AND version.metadata ->> 'purpose' = 'owned_seed_delivery_proof'
         AND version.metadata ->> 'recipientBoundary' = 'fixed_owned_office'
         AND version.metadata -> 'providerEffects' = 'false'::jsonb
     ) THEN
    RAISE EXCEPTION
      'Extended source attestation is not the deterministic owned-seed proof'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$function$;

REVOKE ALL ON FUNCTION
  app_private.guard_property_predator_owned_seed_attestation_window()
  FROM PUBLIC;

CREATE TRIGGER company_content_source_attestations_owned_seed_window_guard
BEFORE INSERT ON app.company_content_source_attestations
FOR EACH ROW EXECUTE FUNCTION
  app_private.guard_property_predator_owned_seed_attestation_window();

RESET ROLE;
