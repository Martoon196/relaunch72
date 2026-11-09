-- Reuse the canonical 0025 approved-content capture instead of duplicating it.
--
-- Every approved live email decision already fires the 0025 capture trigger.
-- The founder preparation function then tried to insert a second row for the
-- same decision, which the unique boundary correctly rejected. This repair
-- removes that duplicate insert and resolves the trigger-created row instead.

SET LOCAL ROLE r72_owner;

GRANT CREATE ON SCHEMA app_private TO r72_founder_pilot_prep_definer;
SET LOCAL ROLE r72_founder_pilot_prep_definer;

DO $repair$
DECLARE
  original_definition text;
  repaired_definition text;
  duplicate_start text :=
    '  INSERT INTO app.property_predator_email_pilot_approved_content (';
  receipt_start text :=
    '  INSERT INTO app.founder_pilot_preparation_receipts (';
  duplicate_at integer;
  receipt_at integer;
  capture_sql text :=
    '  SELECT approved.id INTO created_approved_content_id' || chr(10)
    || '  FROM app.property_predator_email_pilot_approved_content AS approved' || chr(10)
    || '  WHERE approved.workspace_id = p_workspace_id' || chr(10)
    || '    AND approved.message_version_id = created_message_version_id' || chr(10)
    || '    AND approved.approval_request_id = created_message_request_id' || chr(10)
    || '    AND approved.approval_decision_id = created_message_decision_id' || chr(10)
    || '    AND approved.subject_sha256 = selected_subject_sha' || chr(10)
    || '    AND approved.body_sha256 = selected_body_sha;' || chr(10)
    || '  IF created_approved_content_id IS NULL THEN' || chr(10)
    || '    RAISE EXCEPTION ''Founder preparation lost canonical approved content''' || chr(10)
    || '      USING ERRCODE = ''40001'';' || chr(10)
    || '  END IF;' || chr(10) || chr(10);
BEGIN
  SELECT pg_get_functiondef(
    ('app_private.prepare_founder_email_pilot_content('
      || 'uuid,uuid,uuid,uuid,text,text,text,text,bytea,bytea)')::regprocedure
  ) INTO original_definition;

  duplicate_at := position(duplicate_start IN original_definition);
  receipt_at := position(receipt_start IN original_definition);
  IF duplicate_at = 0 OR receipt_at <= duplicate_at
     OR position('Founder preparation message did not enter approval pending'
       IN original_definition) = 0 THEN
    RAISE EXCEPTION 'Founder preparation function no longer matches the reviewed repair'
      USING ERRCODE = '55000';
  END IF;
  IF position('Founder preparation lost canonical approved content'
      IN original_definition) <> 0 THEN
    RAISE EXCEPTION 'Founder preparation capture repair already exists outside the ledger'
      USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger
    JOIN pg_catalog.pg_class AS relation ON relation.oid = trigger.tgrelid
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'app'
      AND relation.relname = 'message_approval_decisions'
      AND trigger.tgname = 'message_approval_decisions_capture_pilot_content'
      AND trigger.tgenabled <> 'D'
      AND NOT trigger.tgisinternal
  ) THEN
    RAISE EXCEPTION 'Canonical approved-content capture trigger is unavailable'
      USING ERRCODE = '55000';
  END IF;

  repaired_definition := overlay(
    original_definition PLACING capture_sql
    FROM duplicate_at FOR receipt_at - duplicate_at
  );

  IF repaired_definition = original_definition
     OR position(duplicate_start IN repaired_definition) <> 0
     OR position('Founder preparation lost canonical approved content'
       IN repaired_definition) = 0 THEN
    RAISE EXCEPTION 'Founder preparation trigger-capture repair was not applied'
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
  IF position('Founder preparation lost canonical approved content'
       IN definition) = 0
     OR position('INSERT INTO app.property_predator_email_pilot_approved_content'
       IN definition) <> 0 THEN
    RAISE EXCEPTION 'Founder preparation trigger-capture repair is absent'
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
