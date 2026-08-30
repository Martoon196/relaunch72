-- Repair the two least-privilege edges proven by the production founder pilot.
--
-- The command LOGIN could execute the evidence function but could not resolve
-- it through app_private. Once that was repaired, the SECURITY DEFINER reached
-- current_request_id() through an RLS policy without EXECUTE on the helper.
-- Neither grant adds table access, enqueue access or provider effects.

SET LOCAL ROLE r72_owner;

GRANT USAGE ON SCHEMA app_private
  TO r72_founder_pilot_evidence_command;
GRANT EXECUTE ON FUNCTION app_private.current_request_id()
  TO r72_founder_pilot_evidence_definer;

DO $repair_audit$
BEGIN
  IF NOT pg_catalog.has_schema_privilege(
       'r72_founder_pilot_evidence_command', 'app_private', 'USAGE'
     ) THEN
    RAISE EXCEPTION 'Founder pilot evidence command cannot resolve its boundary'
      USING ERRCODE = '42501';
  END IF;
  IF NOT pg_catalog.has_function_privilege(
       'r72_founder_pilot_evidence_definer',
       'app_private.current_request_id()', 'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'Founder pilot evidence definer cannot read request identity'
      USING ERRCODE = '42501';
  END IF;
END
$repair_audit$;
