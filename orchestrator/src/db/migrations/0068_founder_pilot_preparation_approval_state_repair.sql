-- Repair the live founder preparation approval-state transition.
--
-- The preparation function created an approval request and immediately tried
-- to record its decision while the message was still a draft. The 0022 guard
-- correctly requires the message to be approval_pending at that point. This
-- forward repair inserts that missing transition and restores the definer's
-- schema boundary before committing.

SET LOCAL ROLE r72_owner;

GRANT CREATE ON SCHEMA app_private TO r72_founder_pilot_prep_definer;
SET LOCAL ROLE r72_founder_pilot_prep_definer;

DO $repair$
DECLARE
  original_definition text;
  repaired_definition text;
  decision_needle text := '  INSERT INTO app.message_approval_decisions (';
  transition_sql text :=
    '  UPDATE app.messages SET lifecycle = ''approval_pending'',' || chr(10)
    || '    row_version = row_version + 1, updated_at = statement_timestamp()' || chr(10)
    || '  WHERE workspace_id = p_workspace_id AND id = created_message_id' || chr(10)
    || '    AND lifecycle = ''draft''' || chr(10)
    || '    AND current_version_id = created_message_version_id' || chr(10)
    || '    AND current_version_number = 1' || chr(10)
    || '    AND current_body_sha256 = selected_body_sha;' || chr(10)
    || '  IF NOT FOUND THEN' || chr(10)
    || '    RAISE EXCEPTION ''Founder preparation message did not enter approval pending''' || chr(10)
    || '      USING ERRCODE = ''40001'';' || chr(10)
    || '  END IF;' || chr(10) || chr(10);
BEGIN
  SELECT pg_get_functiondef(
    ('app_private.prepare_founder_email_pilot_content('
      || 'uuid,uuid,uuid,uuid,text,text,text,text,bytea,bytea)')::regprocedure
  ) INTO original_definition;

  IF position(decision_needle IN original_definition) = 0
     OR position('source_content_approval_ref' IN original_definition) = 0
     OR position('app.campaign_template_approval_decisions:' IN original_definition) = 0 THEN
    RAISE EXCEPTION 'Founder preparation function no longer matches the reviewed repair'
      USING ERRCODE = '55000';
  END IF;
  IF position('Founder preparation message did not enter approval pending'
      IN original_definition) <> 0 THEN
    RAISE EXCEPTION 'Founder preparation approval-state repair already exists outside the ledger'
      USING ERRCODE = '55000';
  END IF;

  repaired_definition := replace(
    original_definition,
    decision_needle,
    transition_sql || decision_needle
  );

  IF repaired_definition = original_definition
     OR position('Founder preparation message did not enter approval pending'
       IN repaired_definition) = 0 THEN
    RAISE EXCEPTION 'Founder preparation approval-state repair was not applied'
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
  IF position('Founder preparation message did not enter approval pending'
       IN definition) = 0
     OR position('lifecycle = ''approval_pending''' IN definition) = 0 THEN
    RAISE EXCEPTION 'Founder preparation approval-state repair is absent'
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
