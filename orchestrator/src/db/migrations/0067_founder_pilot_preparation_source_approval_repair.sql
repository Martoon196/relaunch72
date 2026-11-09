-- Repair the first live founder preparation discovered by the founder pilot.
--
-- 0065 writes a non-null source content version and digest into message_versions,
-- but omitted the matching approval reference required by the 0022 all-or-none
-- provenance constraint. The complete transaction therefore rolled back before
-- it could create any preparation record. This forward repair adds the campaign
-- approval decision already created in the same function as that reference.

SET LOCAL ROLE r72_owner;

GRANT CREATE ON SCHEMA app_private TO r72_founder_pilot_prep_definer;
SET LOCAL ROLE r72_founder_pilot_prep_definer;

DO $repair$
DECLARE
  original_definition text;
  repaired_definition text;
  column_needle text := 'version_number, body_text, source_content_version_ref, source_content_sha256,'
    || chr(10) || '    created_by_actor_kind';
  value_needle text := 'p_source_content_version_ref, p_source_content_sha256,'
    || chr(10) || '    ''user'', selected_user_id, selected_request_id';
BEGIN
  SELECT pg_get_functiondef(
    ('app_private.prepare_founder_email_pilot_content('
      || 'uuid,uuid,uuid,uuid,text,text,text,text,bytea,bytea)')::regprocedure
  ) INTO original_definition;

  IF position(column_needle IN original_definition) = 0
     OR position(value_needle IN original_definition) = 0 THEN
    RAISE EXCEPTION 'Founder preparation function no longer matches the reviewed repair'
      USING ERRCODE = '55000';
  END IF;

  repaired_definition := replace(
    original_definition,
    column_needle,
    'version_number, body_text, source_content_version_ref, source_content_sha256,'
      || chr(10) || '    source_content_approval_ref, created_by_actor_kind'
  );
  repaired_definition := replace(
    repaired_definition,
    value_needle,
    'p_source_content_version_ref, p_source_content_sha256,' || chr(10)
      || '    ''app.campaign_template_approval_decisions:'''
      || ' || created_campaign_decision_id::text,' || chr(10)
      || '    ''user'', selected_user_id, selected_request_id'
  );

  IF repaired_definition = original_definition
     OR position('source_content_approval_ref' IN repaired_definition) = 0
     OR position('app.campaign_template_approval_decisions:' IN repaired_definition) = 0 THEN
    RAISE EXCEPTION 'Founder preparation provenance repair was not applied'
      USING ERRCODE = '55000';
  END IF;

  EXECUTE repaired_definition;
END
$repair$;

RESET ROLE;
SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private FROM r72_founder_pilot_prep_definer;

DO $repair_audit$
DECLARE definition text;
BEGIN
  SELECT pg_get_functiondef(
    ('app_private.prepare_founder_email_pilot_content('
      || 'uuid,uuid,uuid,uuid,text,text,text,text,bytea,bytea)')::regprocedure
  ) INTO definition;
  IF position('source_content_approval_ref' IN definition) = 0
     OR position('app.campaign_template_approval_decisions:' IN definition) = 0 THEN
    RAISE EXCEPTION 'Founder preparation source approval repair is absent'
      USING ERRCODE = '55000';
  END IF;
  IF pg_catalog.has_schema_privilege(
       'r72_founder_pilot_prep_definer', 'app_private', 'CREATE'
     ) THEN
    RAISE EXCEPTION 'Founder preparation definer retained schema CREATE'
      USING ERRCODE = '42501';
  END IF;
END
$repair_audit$;
